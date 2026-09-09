// 本 MCP 进程的会话身份（sid 的前缀 / 回落值）怎么来。
// 身份 = (客户端进程, 它的启动时刻) + 一次**认领**。客户端 = 父进程链上第一个不只是
// 「为拉起我们而存在」的进程；认领文件被一个**活着的**实例占着时，后来者顺延到下一个
// 槽位。于是两种情形都对：**先后**重启拿回同一个身份（前任已死，认领成功），**并发**
// 运行各自独立。客户端本身换了一茬时，靠认领文件里那份与 pid 无关的身份指纹继承旧 key。

import fsMod from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultDataDir } from "./token.mjs";
import { winProc } from "./proc-win.mjs";

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/*
 * 读父进程的启动时刻，返回可用于拼 id 的短字符串；读不到返回 null。
 *
 * 用 ps 的 lstart（绝对时间）而不是 etime（相对时长）：etime 每秒都在变，
 * 拿它拼 id 等于每次重启都换一个新 id，白改。
 */
export function parentStartToken(ppid, exec = execFileSync, { platform = process.platform } = {}) {
  if (!Number.isInteger(ppid) || ppid <= 1) return null;
  if (platform === "win32") {
    const t = winProc(exec).get(ppid)?.start;
    try {
      return t ? BigInt(t).toString(36) : null;
    } catch {
      return null;
    }
  }
  try {
    const out = exec("/bin/ps", ["-o", "lstart=", "-p", String(ppid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    const s = String(out || "").trim();
    if (!s) return null;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t.toString(36);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  } catch {
    return null;
  }
}

const MAX_SLOTS = 8;

const INHERIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/*
 * 身份指纹：认领文件里用来判断「这是不是同一个客户端、同一段工作」的那几个字段。
 *
 * 只取**与 pid 无关**的本机取证结果——它们在同一个客户端、同一个目录下重启前后
 * 必须逐字相同，否则继承就成了瞎认。会话标题不进指纹：它是对话开始后才生成的，
 * 启动这一刻取不到，进了指纹反而每次都对不上。
 */
export function fingerprintOf(local) {
  if (!local || typeof local !== "object") return null;
  return { w: local.workspace ?? null, b: local.brandFallback ?? null, s: local.surface ?? null };
}

function sameFingerprint(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return (a.w ?? null) === (b.w ?? null) && (a.b ?? null) === (b.b ?? null) && (a.s ?? null) === (b.s ?? null);
}

/*
 * 造一个「继承旧 key」的函数。**继承成功返回那个 key**（没得继承返回 false）。
 *
 * 只在自己的 key 还没有认领文件时才找——那正是「客户端换了一茬」的形状。key 已经
 * 在了说明同一个客户端还在原地（只是 server 被回收重启），走原来的认领路就对了，
 * 这时候去翻别的槽位只会把两个都是自己的槽位调换过来。
 */
export function makeInheritor({
  dir = defaultDataDir(),
  fs = fsMod,
  isAlive = pidAlive,
  now = Date.now,
  maxAgeMs = INHERIT_MAX_AGE_MS,
} = {}) {
  return function inherit(key, fingerprint, pid) {
    if (!key || !fingerprint) return false;
    if (fs.existsSync(path.join(dir, `session-${key}.json`))) return false;
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith("session-") && n.endsWith(".json"));
    } catch {
      return false;
    }
    let best = null;
    for (const n of names) {
      let d = null;
      try {
        d = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      } catch {
        continue;
      }
      if (!d || typeof d !== "object") continue;
      if (!d.id) continue;
      if (isAlive(d.pid)) continue;
      const at = Number(d.at || 0);
      if (!(now() - at < maxAgeMs)) continue;
      if (!sameFingerprint(d.id, fingerprint)) continue;
      if (!best || at > best.at) best = { at, name: n };
    }
    if (!best) return false;
    const got = best.name.slice("session-".length, -".json".length);
    try {
      fs.writeFileSync(path.join(dir, best.name), JSON.stringify({ pid, at: now(), id: fingerprint }), { mode: 0o600 });
    } catch {
      return false;
    }
    return got;
  };
}

/*
 * 造一个「认领某个会话身份」的函数。**认领成功返回真正拿到的 key**（失败返回 false）。
 *
 * 用独占创建（flag "wx"）抢，抢不到再看占用者死没死——顺序反过来的话，
 * 两个同时启动的实例会双双读到「没人占」，然后一起写，一起以为自己拿到了。
 *
 * **槽位**：同一个客户端可以同时开好几轮对话，每轮一个 server。第一个拿 `key`，
 * 后来的依次拿 `key-2`、`key-3`……返回的就是实际拿到的那个；槽位用完则失败，
 * 由调用方退回进程级唯一的身份。
 */
export function makeClaimer({ dir = defaultDataDir(), fs = fsMod, isAlive = pidAlive, maxSlots = MAX_SLOTS } = {}) {
  return function claim(key, pid, fingerprint = null) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
    for (let slot = 1; slot <= maxSlots; slot++) {
      const slotKey = slot === 1 ? key : `${key}-${slot}`;
      const file = path.join(dir, `session-${slotKey}.json`);
      const payload = JSON.stringify(fingerprint ? { pid, at: Date.now(), id: fingerprint } : { pid, at: Date.now() });
      try {
        fs.writeFileSync(file, payload, { flag: "wx", mode: 0o600 });
        return slotKey;
      } catch (e) {
        if (e?.code !== "EEXIST") return false;
      }
      let cur = null;
      try {
        cur = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      if (cur && cur.pid !== pid && isAlive(cur.pid)) continue;
      try {
        fs.writeFileSync(file, payload, { mode: 0o600 });
        return slotKey;
      } catch {
        return false;
      }
    }
    return false;
  };
}

export function pruneClaims({ dir = defaultDataDir(), fs = fsMod, isAlive = pidAlive, now = Date.now } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith("session-") && n.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (isAlive(d?.pid)) continue;
      if (now() - Number(d?.at || 0) < STALE_MS) continue;
      fs.unlinkSync(f);
      removed++;
    } catch {
    }
  }
  return removed;
}

/* 读某个进程的命令行（含参数）；读不到返回空串 */
export function processInfo(pid, exec = execFileSync, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return { ppid: null, command: "" };
  if (platform === "win32") {
    const p = winProc(exec).get(pid);
    return p ? { ppid: p.ppid, command: p.command } : { ppid: null, command: "" };
  }
  try {
    const out = exec("/bin/ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const s = String(out || "").trim();
    const m = /^(\d+)\s+([\s\S]*)$/.exec(s);
    if (!m) return { ppid: null, command: "" };
    return { ppid: Number(m[1]), command: m[2] };
  } catch {
    return { ppid: null, command: "" };
  }
}

/*
 * 这个进程是不是「只为拉起我们而存在」的一次性启动器？
 *
 * 判据是它的命令行里点名了**我们自己的**文件——启动脚本，或这次跑的这份 server。
 * 不用时间差、不用进程名白名单：那些都是猜，而猜错的代价是把身份绑到一个错的进程上。
 *
 * 一条例外：命令行里含 `--mcp-config` 的，是**把配置递给我们的客户端**（我们的路径出现
 * 在它 argv 里的那份 JSON 里），不是启动器。
 */
export function isLauncherFor(command, self) {
  if (!command) return false;
  if (/mcp-launcher\.(sh|bat|cmd)\b/i.test(command)) return true;
  if (command.includes("--mcp-config")) return false;
  return !!(self && command.includes(self));
}

/*
 * 沿父进程链往上找**真正的客户端**：跳过一次性启动器那几层（见 isLauncherFor）。
 * 返回 { pid, hops }；一步都不用走时 hops 为 0。
 *
 * 全项目只此一份走链实现：agent-identity.mjs 的 resolveClientPid 换个 info 取数口调它。
 * 两处认到的必须是同一个进程，所以循环不许再抄一遍。
 */
export function clientPid({ ppid = process.ppid, self = process.argv[1], info = processInfo, maxHops = 3 } = {}) {
  let cur = ppid;
  for (let hops = 0; hops < maxHops; hops++) {
    const { ppid: up, command } = info(cur);
    if (!isLauncherFor(command, self)) return { pid: cur, hops };
    if (!Number.isInteger(up) || up <= 1) return { pid: cur, hops };
    cur = up;
  }
  return { pid: cur, hops: maxHops };
}

/*
 * 推导本进程的 SESSION_ID。
 *
 * 优先级：显式环境变量 > 继承同身份的旧 key > 认领到的客户端身份 > 回落到进程级
 * 唯一（老行为）。最后那一档在两种情况下走：拿不到客户端进程信息（ps 不可用），
 * 或所有槽位都被活着的实例占着。两种都不比改动前更差。
 *
 * `identity` 是 agent-identity.mjs 的 probeLocal() 结果，只用来算指纹。不传就退回
 * 改动前的行为：不继承，也不往认领文件里写指纹。
 */
export function deriveSessionId({
  env = process.env,
  ppid = process.ppid,
  pid = process.pid,
  now = Date.now,
  startToken = parentStartToken,
  claim = null,
  anchor = null,
  identity = null,
  inherit = null,
} = {}) {
  const explicit = env.AGENT_IN_CHROME_SESSION_ID;
  if (explicit) return explicit;
  const anchorPid = (anchor || clientPid)({ ppid }).pid;
  const tok = startToken(anchorPid);
  if (tok) {
    const key = `${anchorPid}-${tok}`;
    const fp = fingerprintOf(identity);
    if (fp) {
      const old = (inherit || makeInheritor())(key, fp, pid);
      if (old) return `s${old}`;
    }
    const doClaim = claim || makeClaimer();
    const got = doClaim(key, pid, fp);
    if (got) return `s${got}`;
  }
  return `s${pid}-${now().toString(36)}`;
}
