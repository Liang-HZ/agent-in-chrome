// 这一组标签页背后是「谁、在哪、在做哪一段对话」——四段身份（品牌 / 形态 / 工作区 /
// 会话名）的本机取证。MCP 握手里的 clientInfo 不够用：name 常常是**发协议帧的那层
// 中间件**在自报，而且它答不出形态、工作区和这一段对话叫什么。证据全在本机——父进程链、
// 自己的 cwd、客户端写在磁盘上的会话记录。**一条映射表都不写**：没有「进程名 → 品牌」
// 的白名单，那些是猜；这一整块东西唯一的用处就是认出是谁，**显示错了比不显示更坏**，
// 所以每一段都有「没证据就是 null」这条出口——宁可少显示一段，不许编。

import fsMod from "node:fs";
import osMod from "node:os";
import path from "node:path";
import zlibMod from "node:zlib";
import { execFileSync } from "node:child_process";

import { clientPid } from "./session-id.mjs";
import { isWinRoot, isWinTerminal, winProc } from "./proc-win.mjs";

/* 字段一律截断后再往外发：这些值都来自别人（客户端字符串、目录名、会话标题） */
export function clip(v, max) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function procSource(exec = execFileSync, { platform = process.platform } = {}) {
  if (platform === "win32") return winProc(exec);
  const memo = new Map();
  return {
    get(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return null;
      if (memo.has(pid)) return memo.get(pid);
      let v = null;
      try {
        const out = exec("/bin/ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
        });
        const m = /^\s*(\d+)\s+(\S+)\s+([\s\S]*)$/.exec(String(out || "").trim());
        if (m) v = { ppid: Number(m[1]), tty: m[2], command: m[3].trim() };
      } catch {
      }
      memo.set(pid, v);
      return v;
    },
  };
}

export function hasTty(tty) {
  return !!tty && tty !== "??" && tty !== "?" && tty !== "-";
}

/*
 * 从命令行里认出 macOS 的 .app 包名：`/Applications/Qoder CN.app/Contents/MacOS/Electron`
 * → `Qoder CN`。认包名而不是可执行文件名，因为后者常常是 `Electron` / `claude` 这种
 * 答不出品牌的东西。
 */
export function bundleName(command) {
  return bundleMatch(command)?.name || null;
}

export function bundleMatch(command) {
  const s = String(command || "");
  const marker = ".app/Contents/MacOS/";
  const i = s.indexOf(marker);
  if (i < 0) return null;
  const head = s.slice(0, i);
  if (!head.startsWith("/") || / -/.test(head)) return null;
  const outerHead = s.slice(0, s.indexOf(".app/"));
  const name = clip(outerHead.slice(outerHead.lastIndexOf("/") + 1), 40);
  return name ? { name, appDir: `${outerHead}.app` } : null;
}

const bundleVersionMemo = new Map();
export function readBundleVersion(appDir, { exec = execFileSync } = {}) {
  if (!appDir || typeof appDir !== "string") return null;
  if (bundleVersionMemo.has(appDir)) return bundleVersionMemo.get(appDir);
  let v = null;
  try {
    const out = /\.exe$/i.test(appDir)
      ? exec(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:AIC_EXE).VersionInfo.ProductVersion"],
          {
            encoding: "utf8",
            timeout: 4000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, AIC_EXE: appDir },
          }
        )
      : exec(
          "/usr/bin/plutil",
          ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(appDir, "Contents", "Info.plist")],
          { encoding: "utf8", timeout: 2000 }
        );
    v = clip(String(out || "").trim(), 20);
  } catch {
  }
  bundleVersionMemo.set(appDir, v);
  return v;
}

const NOT_A_BRAND = new Set([
  "node", "node.js", "deno", "bun", "python", "python3", "java", "ruby", "perl",
  "electron", "sh", "bash", "zsh", "fish", "dash", "login", "tmux", "screen",
  "ssh", "sshd", "code", "cli", "main", "app", "helper", "launchd",
]);

export function binShimName(command) {
  const m = /[\\/]node_modules[\\/]\.bin[\\/]([\w.\-+]{2,40})(?:[\s]|$)/.exec(String(command || ""));
  if (!m) return null;
  const base = m[1].replace(/\.(cmd|exe|bat|ps1)$/i, "");
  if (!base || NOT_A_BRAND.has(base.toLowerCase())) return null;
  return clip(base, 40);
}

export function plainName(command) {
  const s = String(command || "").trim();
  if (!s || s.startsWith("-")) return null;
  const m = /^"([^"]+)"/.exec(s);
  const argv0 = m ? m[1] : s.split(/\s/)[0];
  const cut = Math.max(argv0.lastIndexOf("/"), argv0.lastIndexOf("\\"));
  const base = argv0.slice(cut + 1).replace(/\.(exe|cmd|bat|com)$/i, "");
  if (!base || NOT_A_BRAND.has(base.toLowerCase())) return null;
  if (!/^[\w.\-+]{2,40}$/.test(base)) return null;
  return clip(base, 40);
}

export function exePathOf(command) {
  const s = String(command || "").trim();
  const m = /^"([^"]+)"/.exec(s);
  const argv0 = m ? m[1] : s.split(/\s/)[0];
  return /\.exe$/i.test(argv0) && /[\\/]/.test(argv0) ? argv0 : null;
}

/*
 * 沿父进程链找形态与品牌的证据，先撞见哪个算哪个：
 *
 *   撞见有终端的进程          → CLI（从命令行起来的）
 *   撞见 .app 包             → 桌面端，顺带拿到包名当品牌候选
 *   一路走到 launchd 都没终端 → 桌面端（GUI 进程的典型形状，如 ZCode）
 *
 * Windows 上三条证据各有对应物，判据不同、结论一模一样：
 *
 *   撞见终端宿主进程                    → CLI（那边没有 tty 这一列，认进程名，
 *                                        见 proc-win.mjs 的 TERMINALS）
 *   撞见 explorer.exe 这类桌面根        → 桌面端，**上一跳**就是那个 GUI 进程
 *                                        （对应 macOS 的「launchd 直属」）
 *   链在半路断了（父进程已退出，很常见） → 同上，按最后见到的那一跳算桌面端
 *
 * 最后两条要拿 `prev` 兜：Windows 的桌面根（explorer.exe）自己也是个普通进程，
 * 不像 launchd 那样能靠 `ppid <= 1` 认出来，撞见时当前这一跳已经不是客户端了。
 *
 * 走不到任何一条（ps / PowerShell 不可用、链断在第一跳）就返回 null——不显示形态，也不猜。
 */
export function walkSurface(startPid, snap, { maxHops = 6, platform = process.platform } = {}) {
  const win = platform === "win32";
  const none = { surface: null, brand: null, appDir: null, why: "无证据" };
  let pid = Number(startPid);
  let prev = null;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    const p = snap.get(pid);
    if (!p) return win && prev ? guiSurface(prev, `父进程已退出@${pid}`) : none;
    if (hasTty(p.tty)) return { surface: "cli", brand: binShimName(p.command), appDir: null, why: `${p.tty}@${pid}` };
    if (win && isWinTerminal(p.name)) return { surface: "cli", brand: binShimName(p.command), appDir: null, why: `${p.name}@${pid}` };
    if (win && isWinRoot(p.name)) return prev ? guiSurface(prev, `${p.name} 直属@${pid}`) : none;
    const b = bundleMatch(p.command);
    if (b) return { surface: "app", brand: b.name, appDir: b.appDir, why: `${b.name}.app@${pid}` };
    if (!Number.isInteger(p.ppid) || p.ppid <= 1) {
      return { surface: "app", brand: plainName(p.command) || binShimName(p.command), appDir: null, why: `launchd 直属、无终端@${pid}` };
    }
    prev = { ...p, pid };
    pid = p.ppid;
  }
  return none;
}

function guiSurface(p, why) {
  return {
    surface: "app",
    brand: plainName(p.command) || binShimName(p.command),
    appDir: exePathOf(p.command),
    why: `${why}，取 ${p.pid}`,
  };
}

export function userDataDirFrom(startPid, snap, { fs = fsMod, maxHops = 6 } = {}) {
  let pid = Number(startPid);
  for (let hop = 0; hop < maxHops; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    const p = snap.get(pid);
    if (!p) break;
    const i = String(p.command || "").indexOf("--user-data-dir=");
    if (i >= 0) {
      const rest = p.command.slice(i + "--user-data-dir=".length);
      const cut = rest.search(/ --[A-Za-z]/);
      for (const cand of [cut >= 0 ? rest.slice(0, cut) : rest, rest]) {
        const v = cand.trim();
        if (!path.isAbsolute(v)) continue;
        try {
          if (fs.statSync(v).isDirectory()) return v;
        } catch {}
      }
      return null;
    }
    pid = p.ppid;
  }
  return null;
}

/*
 * 真正的客户端进程：跳过那些「只为拉起我们而存在」的一次性启动器。
 *
 * 走链这件事**只有一份实现**（session-id.mjs 的 clientPid）——sid 那边和身份这边必须
 * 认到同一个进程，否则会话归属和卡片上的身份会对不上。这里只负责换个取数口：ps 快照
 * 已经在手上了（同一张，一跳都不额外花进程），快照里没有的进程按「读不到」处理。
 */
export function resolveClientPid(ppid, snap, self, { maxHops = 3 } = {}) {
  return clientPid({
    ppid: Number(ppid),
    self,
    maxHops,
    info: (pid) => snap.get(pid) || { ppid: null, command: "" },
  }).pid;
}

/*
 * 这一段对话开在哪。cwd 往上找 `.git`（worktree 里它是个文件，一样算），找到就报
 * 仓库/工作树的目录名；没有 git 就报 cwd 的目录名。
 *
 * 四种情况报 null：cwd 是 `/`（桌面端 chat 模式就是这样拉起 server 的，它本来就没有
 * 工作区）；cwd 就是家目录（那不是「哪个项目」，报出来是噪音）；cwd 在临时目录里；
 * cwd 路径上有隐藏目录段、且一路上没找到 git。后两条是同一类：客户端把我们 spawn 在
 * 它自己的内部目录里，那是它的管道工程，不是用户开着的项目。
 *
 * 隐藏目录那条只否得掉目录名兜底，否不掉已经找到的 git 检出——`.claude/worktrees/<名>`
 * 底下的 worktree、`~/.config/nvim` 这类点目录里的真项目都要认出来。
 */
export function readWorkspace(cwd, { fs = fsMod, home = osMod.homedir(), tmp } = {}) {
  const start = typeof cwd === "string" && cwd ? path.resolve(cwd) : null;
  if (!start || start === "/" || start === path.parse(start).root) return null;
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const sameAs = (a, b) => fold(a) === fold(b);
  const under = (p, base) => fold(p).startsWith(fold(base) + path.sep);
  const tmps = tmp !== undefined ? [tmp] : [osMod.tmpdir(), "/tmp", "/private/tmp"];
  for (const t of tmps) {
    const r = t && path.resolve(t);
    if (r && (sameAs(start, r) || under(start, r))) return null;
  }
  const hiddenSeg = start.split(path.sep).some((seg) => seg.length > 1 && seg.startsWith("."));
  const homeAbs = home ? path.resolve(home) : null;
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (homeAbs && sameAs(dir, homeAbs)) break;
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return { name: clip(path.basename(dir), 40), kind: "git" };
    } catch {}
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  if (hiddenSeg) return null;
  if (homeAbs && sameAs(start, homeAbs)) return null;
  return { name: clip(path.basename(start), 40), kind: "dir" };
}

export function readClientSessionFile(pid, { fs = fsMod, home = osMod.homedir() } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || !home) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, ".claude", "sessions", `${pid}.json`), "utf8"));
    if (!d || typeof d !== "object" || Number(d.pid) !== pid) return null;
    return d;
  } catch {
    return null;
  }
}

export function readHostSessionTitle(hostSessionId, { fs = fsMod, home = osMod.homedir(), env = process.env } = {}) {
  const id = clip(hostSessionId, 100);
  if (!id || !/^[\w.-]+$/.test(id) || !home) return null;
  const roaming = path.join(home, "AppData", "Roaming");
  const appdata = env?.APPDATA && (env.APPDATA === roaming || env.APPDATA.startsWith(home + path.sep)) ? env.APPDATA : roaming;
  const roots = [
    path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    path.join(appdata, "Claude", "claude-code-sessions"),
  ];
  const dirs = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const a of dirs(root)) {
      for (const b of dirs(path.join(root, a))) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(root, a, b, `${id}.json`), "utf8"));
          const t = clip(d?.title, 60);
          if (t) return t;
        } catch {}
      }
    }
  }
  return null;
}

/*
 * 这一次调用是主会话发的，还是它派出去的某个 subagent 发的——以及那个子任务叫什么。
 *
 * 归属证据在客户端自己写的记录里，一条都不用猜：`~/.claude/sessions/<客户端 pid>.json`
 * 给出会话 id，`~/.claude/projects/<cwd 转写>/<会话 id>/subagents/agent-<id>.meta.json`
 * 给出这个子任务的 `description`（派它出去时写的那句任务名），`agent-<id>.jsonl` 里
 * 是它自己发起的每一次工具调用。
 *
 * 「这一帧是谁发的」靠 toolUseId **精确匹配**，不靠时间窗口猜；抢在落盘前（毫秒级竞态）
 * 就返回 null，下一帧补上。**绝不退而猜「最近活跃的那个子任务」**：并行子任务下猜错，
 * 就是把 A 开的页记到 B 名下，那比不显示坏得多。
 */
const SUBAGENT_MEMO_MAX = 200;
const SUBAGENT_FRESH_MS = 15 * 60_000;
const SUBAGENT_DIR_MISS_MS = 30_000;
const subagentMemo = new Map();
const subagentDirMemo = new Map();
let lastSubagentFile = null;

export function resetSubagentMemo() {
  subagentMemo.clear();
  subagentDirMemo.clear();
  lastSubagentFile = null;
}

function subagentDir(local, { fs = fsMod, home = osMod.homedir() } = {}) {
  const file = readClientSessionFile(local?.clientPid, { fs, home });
  const id = clip(file?.sessionId, 100);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !home) return null;
  const memo = subagentDirMemo.get(id);
  if (memo && (memo.dir || Date.now() - memo.at < SUBAGENT_DIR_MISS_MS)) return memo.dir;
  const root = path.join(home, ".claude", "projects");
  const cands = [];
  if (typeof file.cwd === "string" && file.cwd) cands.push(file.cwd.replace(/[^A-Za-z0-9]/g, "-"));
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !cands.includes(e.name)) cands.push(e.name);
    }
  } catch {}
  let dir = null;
  for (const c of cands) {
    const d = path.join(root, c, id, "subagents");
    try {
      if (fs.existsSync(d)) {
        dir = d;
        break;
      }
    } catch {}
  }
  if (subagentDirMemo.size >= SUBAGENT_MEMO_MAX) subagentDirMemo.clear();
  subagentDirMemo.set(id, { dir, at: Date.now() });
  return dir;
}

function tailIncludes(file, needle, fs) {
  const MAX = 512 * 1024;
  try {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    if (size > MAX && fs.openSync && fs.readSync) {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(MAX);
        const n = fs.readSync(fd, buf, 0, MAX, size - MAX);
        return buf.toString("utf8", 0, n).includes(needle);
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    return fs.readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

export function readClaudeSubagent(meta, local, { fs = fsMod, home = osMod.homedir() } = {}) {
  const id = meta && typeof meta === "object" ? String(meta["claudecode/toolUseId"] || "") : "";
  if (!/^toolu_[A-Za-z0-9_-]{1,64}$/.test(id) || !local) return null;
  const hit = subagentMemo.get(id);
  if (hit) return hit;
  const dir = subagentDir(local, { fs, home });
  if (!dir) return null;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
  } catch {
    return null;
  }
  const now = Date.now();
  const fresh = [];
  for (const f of names) {
    const p = path.join(dir, f);
    let mt = 0;
    try {
      mt = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (now - mt > SUBAGENT_FRESH_MS) continue;
    fresh.push({ p, mt });
  }
  fresh.sort((a, b) => b.mt - a.mt);
  const i = lastSubagentFile ? fresh.findIndex((x) => x.p === lastSubagentFile) : -1;
  if (i > 0) fresh.unshift(...fresh.splice(i, 1));
  for (const { p } of fresh.slice(0, 8)) {
    if (!tailIncludes(p, id, fs)) continue;
    lastSubagentFile = p;
    let info = null;
    try {
      const d = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, ".meta.json"), "utf8"));
      const label = clip(d?.description, 60);
      const type = clip(d?.agentType, 40);
      if (label || type) info = { label: label || null, type: type || null };
    } catch {}
    if (!info) return null;
    if (subagentMemo.size >= SUBAGENT_MEMO_MAX) subagentMemo.clear();
    subagentMemo.set(id, info);
    return info;
  }
  return null;
}

export function readWorkbuddySessionTitle({ env = process.env, fs = fsMod, exec = execFileSync, alive = pidAlive } = {}) {
  const dir = typeof env.WORKBUDDY_CONFIG_DIR === "string" ? env.WORKBUDDY_CONFIG_DIR : "";
  if (!path.isAbsolute(dir)) return null;
  const live = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, "sessions")).slice(0, 100)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, "sessions", f), "utf8"));
        if (d?.kind !== "interactive") continue;
        const sid = String(d.sessionId || "");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) continue;
        if (!Number.isInteger(d.pid) || d.pid <= 1 || !alive(d.pid)) continue;
        live.push(sid);
      } catch {}
    }
  } catch {
    return null;
  }
  if (live.length !== 1) return null;
  try {
    const out = exec(
      process.platform === "win32" ? "sqlite3" : "/usr/bin/sqlite3",
      ["-readonly", path.join(dir, "workbuddy.db"), `select coalesce(custom_title, title) from sessions where id='${live[0]}' and deleted_at is null`],
      { encoding: "utf8", timeout: 2000 }
    );
    return clip(String(out || "").trim(), 60);
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function informativeName(name) {
  const s = clip(name, 40);
  if (!s) return null;
  if (/^local-agent-mode-/i.test(s)) return null;
  if (s.includes(":")) return null;
  return s;
}

/*
 * 本机取证的那几段（品牌兜底、形态、工作区、会话记录位置）。跟 clientInfo 无关的
 * 部分在一个进程里是不变的，所以调用方算一次就够；会话标题另算（见上）。
 */
export function probeLocal({
  env = process.env,
  cwd = process.cwd(),
  ppid = process.ppid,
  self = process.argv[1],
  snap = null,
  fs = fsMod,
  home = osMod.homedir(),
  tmp,
  exec = execFileSync,
  platform = process.platform,
} = {}) {
  const s = snap || procSource(exec, { platform });
  const clientPid = resolveClientPid(ppid, s, self);
  const walked = walkSurface(clientPid, s, { platform });
  const clientCommand = s.get(clientPid)?.command || null;
  const file = readClientSessionFile(clientPid, { fs, home });

  const entrypoint = clip(file?.entrypoint || env.CLAUDE_CODE_ENTRYPOINT, 30);
  const surface = entrypoint === "cli" ? "cli" : walked.surface;

  const ws = readWorkspace(file?.cwd || cwd, tmp !== undefined ? { fs, home, tmp } : { fs, home });

  return {
    brandFallback: walked.brand,
    brandAppDir: walked.appDir || null,
    surface,
    workspace: ws?.name || null,
    workspaceKind: ws?.kind || null,
    userDataDir: userDataDirFrom(ppid, s, { fs }),
    hostSessionId: clip(env.CLAUDE_CODE_HOST_SESSION_ID, 100),
    clientPid,
    clientCommand,
    sessionName: file && file.nameSource !== "derived" ? clip(file.name, 60) : null,
    why: walked.why,
  };
}

const titleMemo = new Map();
const TITLE_MISS_BACKOFF_MS = 20_000;
const TITLE_MISS_BACKOFF_MAX_MS = 300_000;
const TITLE_MEMO_MAX = 200;
function missBackoff(misses) {
  return Math.min(TITLE_MISS_BACKOFF_MS * 2 ** Math.max(0, misses - 1), TITLE_MISS_BACKOFF_MAX_MS);
}
function memoTitle(key, lookup, now = Date.now()) {
  const hit = titleMemo.get(key);
  if (hit && (hit.title || now < hit.nextTryAt)) return hit.title;
  let title = null;
  try {
    title = lookup();
  } catch {
    title = null;
  }
  if (titleMemo.size >= TITLE_MEMO_MAX) titleMemo.clear();
  const misses = title ? 0 : (hit?.misses || 0) + 1;
  titleMemo.set(key, { title, misses, nextTryAt: now + missBackoff(misses) });
  return title;
}

export function resetTitleMemo() {
  titleMemo.clear();
  dshCwdMemo.clear();
  agWsMemo.clear();
}

export function zcodeDataDir({ env = process.env, home = osMod.homedir() } = {}) {
  const base = typeof env.ZCODE_DATA_BASE_DIR === "string" ? env.ZCODE_DATA_BASE_DIR.trim() : "";
  return path.join(base || home, ".zcode");
}

export function readZcodeSessionTitle(meta, { env = process.env, home = osMod.homedir(), fs = fsMod, exec = execFileSync } = {}) {
  const id = meta && typeof meta === "object" ? String(meta.session_id || "") : "";
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const isMain = new RegExp(`^sess_${UUID}$`, "i").test(id);
  const isSub = new RegExp(`^sess_subagent_agent_${UUID}$`, "i").test(id);
  if (!isMain && !isSub) return null;
  const db = path.join(zcodeDataDir({ env, home }), "cli", "db", "db.sqlite");
  if (!fs.existsSync(db)) return null;
  const sql = isSub
    ? `select title from session where id=(select parent_id from session where id='${id}') and title_source in ('generated','custom')`
    : `select title from session where id='${id}' and title_source in ('generated','custom')`;
  return memoTitle(`zcode:${db}:${id}`, () => {
    const out = exec("/usr/bin/sqlite3", ["-readonly", db, sql], { encoding: "utf8", timeout: 2000 });
    return clip(String(out || "").trim(), 60);
  });
}

const TRAE_WINDOW_MS = 15 * 60_000;
const TRAE_MAX_SCAN = 64 << 20;
const LINE_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2})/;

export function traeDataDir({ userDataDir = null, appDir = null, env = process.env, fs = fsMod, home = osMod.homedir() } = {}) {
  if (typeof userDataDir === "string" && path.isAbsolute(userDataDir) && fs.existsSync(path.join(userDataDir, "logs"))) {
    return userDataDir;
  }
  const rg = /^((?:\/|[A-Za-z]:[\\/]).+?\.app)[\\/]/.exec(String(env.RG_PATH || ""));
  const bundles = [typeof appDir === "string" && appDir.endsWith(".app") ? appDir : null, rg ? rg[1] : null];
  for (const bundle of bundles) {
    if (!bundle) continue;
    let product;
    try {
      product = JSON.parse(fs.readFileSync(path.join(bundle, "Contents", "Resources", "app", "product.json"), "utf8"));
    } catch {
      continue;
    }
    if (!/^trae(-|$)/.test(String(product?.applicationName || ""))) continue;
    const name = clip(product?.nameLong, 40);
    if (!name || name.includes("/")) continue;
    const dir = path.join(home, "Library", "Application Support", name);
    if (fs.existsSync(path.join(dir, "logs"))) return dir;
  }
  return null;
}

function traeLogFiles(dataDir, fs) {
  const out = [];
  const root = path.join(dataDir, "logs");
  let dirs;
  try {
    dirs = fs.readdirSync(root).filter((d) => /^\d{8}T\d{6}$/.test(d));
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(root, d, "Modular");
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      const m = /^ai-agent_\d+_(\d{10,16})_stdout\.log$/.exec(f);
      if (m) out.push({ file: path.join(dir, f), at: Number(m[1]) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function lineTimeAt(fs, fd, off, size) {
  const len = Math.min(4096, size - off);
  if (len <= 0) return null;
  const b = Buffer.allocUnsafe(len);
  fs.readSync(fd, b, 0, len, off);
  const s = b.toString("utf8");
  const nl = off === 0 ? -1 : s.indexOf("\n");
  const m = LINE_TS.exec(s.slice(nl + 1));
  return m ? { t: Date.parse(m[1]), at: off + nl + 1 } : null;
}

function seekToTime(fs, fd, size, target) {
  let lo = 0;
  let hi = size;
  let best = 0;
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = (lo + hi) >> 1;
    const p = lineTimeAt(fs, fd, mid, size);
    if (!p) {
      hi = mid;
      continue;
    }
    if (p.t < target) {
      best = p.at;
      lo = p.at + 1;
    } else hi = mid;
  }
  return best;
}

function traeScanFile(fs, file, id, fromMs, budget) {
  const needle = `session_id: "${id}", title: "`;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { title: null, read: 0 };
  }
  try {
    const size = fs.fstatSync(fd).size;
    let off = fromMs === null ? 0 : seekToTime(fs, fd, size, fromMs);
    const buf = Buffer.allocUnsafe(1 << 22);
    let carry = "";
    let read = 0;
    let title = null;
    while (off < size && read < budget) {
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) break;
      off += n;
      read += n;
      const chunk = carry + buf.toString("utf8", 0, n);
      const nl = chunk.lastIndexOf("\n");
      carry = nl < 0 ? chunk : chunk.slice(nl + 1);
      const body = nl < 0 ? "" : chunk.slice(0, nl);
      let i = -1;
      while ((i = body.indexOf(needle, i + 1)) >= 0) {
        const e = body.indexOf('"', i + needle.length);
        if (e > 0) title = body.slice(i + needle.length, e);
      }
      if (title) break;
      if (fromMs !== null) {
        const last = body.slice(body.lastIndexOf("\n") + 1);
        const m = LINE_TS.exec(last);
        if (m && Date.parse(m[1]) > fromMs + TRAE_WINDOW_MS) break;
      }
    }
    return { title: clip(title, 60), read };
  } catch {
    return { title: null, read: 0 };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

export function readTraeSessionTitle(meta, { dataDir = null, fs = fsMod } = {}) {
  const id = meta && typeof meta === "object" ? String(meta.chatSessionId || "") : "";
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  if (meta.isCurrentSession === false) return null;
  if (!dataDir) return null;
  const createdMs = parseInt(id.slice(0, 8), 16) * 1000;
  if (!Number.isFinite(createdMs) || createdMs <= 0) return null;

  return memoTitle(`trae:${dataDir}:${id}`, () => {
    const files = traeLogFiles(dataDir, fs);
    let i = -1;
    for (let k = 0; k < files.length; k++) if (files[k].at <= createdMs) i = k;
    if (i < 0) return null;
    let budget = TRAE_MAX_SCAN;
    for (const c of [files[i], files[i + 1]]) {
      if (!c || budget <= 0) break;
      const r = traeScanFile(fs, c.file, id, c === files[i] ? createdMs : null, budget);
      if (r.title) return r.title;
      budget -= r.read;
    }
    return null;
  });
}

const DSH_LIVE_WINDOW_MS = 10 * 60_000;
const DSH_MAX_LOG_BYTES = 32 << 20;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function dshHome({ env = process.env, home = osMod.homedir() } = {}) {
  const d = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return path.isAbsolute(d) ? d : path.join(home, ".dsh");
}

export function isDshClient(clientCommand) {
  const s = String(clientCommand || "");
  return /@deepseek-ai[\\/]dsh[\\/]/.test(s) || /[\\/]\.bin[\\/]dsh(\.cmd|\.exe|\.bat)?(\s|$)/.test(s);
}

export function decodeZstdFrames(buf, { zlib = zlibMod } = {}) {
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  if (!Buffer.isBuffer(buf) || buf.length > DSH_MAX_LOG_BYTES) return null;
  const parts = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i >= 0) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(i)));
    } catch {
    }
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  return parts.length ? Buffer.concat(parts).toString("utf8") : null;
}

const dshCwdMemo = new Map();

/*
 * 恰好一个活跃会话时返回 { id, title, cwd }；分不出（0 个或多个活跃）就 null。
 * title 可能暂缺（LLM 标题是首轮之后才生成的）——cwd 先到先用，两者不互相拖累。
 */
export function readDshSession(local, { env = process.env, home = osMod.homedir(), fs = fsMod, now = Date.now() } = {}) {
  if (!local || !isDshClient(local.clientCommand)) return null;
  const root = path.join(dshHome({ env, home }), "sessions");
  const live = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs.slice(0, 500)) {
    let subs;
    try {
      subs = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const s of subs) {
      if (!s.startsWith("session-")) continue;
      const file = path.join(root, d, s, "session.jsonl.zstd");
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs <= DSH_LIVE_WINDOW_MS) live.push({ id: s, file });
      } catch {}
      if (live.length > 1) return null;
    }
  }
  if (live.length !== 1) return null;
  const { id, file } = live[0];

  let cwd = dshCwdMemo.get(id);
  const title = memoTitle(`dsh:${file}`, () => {
    let text;
    try {
      text = decodeZstdFrames(fs.readFileSync(file));
    } catch {
      return null;
    }
    if (!text) return null;
    let found = null;
    for (const line of text.split("\n")) {
      if (cwd === undefined && line.includes('"type":"session"')) {
        try {
          const h = JSON.parse(line);
          if (h?.type === "session" && typeof h.cwd === "string") {
            cwd = h.cwd;
            if (dshCwdMemo.size >= TITLE_MEMO_MAX) dshCwdMemo.clear();
            dshCwdMemo.set(id, cwd);
          }
        } catch {}
      }
      if (!line.includes('"session/title"')) continue;
      try {
        const ev = JSON.parse(line);
        const kind = ev?.data?.source?.kind;
        if (ev?.type === "session/title" && (kind === "provider" || kind === "user")) {
          const t = clip(ev.data.title, 60);
          if (t) found = t;
        }
      } catch {}
    }
    return found;
  });
  if (cwd === undefined) {
    try {
      const first = zlibMod.zstdDecompressSync ? zlibMod.zstdDecompressSync(fs.readFileSync(file)) : null;
      const h = first ? JSON.parse(first.toString("utf8").split("\n")[0]) : null;
      cwd = h?.type === "session" && typeof h.cwd === "string" ? h.cwd : null;
    } catch {
      cwd = null;
    }
    if (dshCwdMemo.size >= TITLE_MEMO_MAX) dshCwdMemo.clear();
    dshCwdMemo.set(id, cwd);
  }
  return { id, title: title || null, cwd: cwd || null };
}

/* 会话 id 进路径与提取流程前的锚（安全边界，勿放宽）：只放行 UUID 形状，`..`、`/`、
 * 引号一概进不来——id 来自 MCP 调用方给的 _meta，是外部输入 */
const AG_CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function antigravityDataDir(clientCommand, { home = osMod.homedir() } = {}) {
  const m = /--app_data_dir[ =]([\w.-]+)/.exec(String(clientCommand || ""));
  const name = m && m[1] !== "." && !m[1].includes("..") ? m[1] : "antigravity-ide";
  return path.join(home, ".gemini", name);
}

const agWsMemo = new Map();
const AG_WS_MISS_MS = 30_000;
const AG_DB_MAX = 256 << 20;

export function antigravityConversationId(meta) {
  const id = meta && typeof meta === "object" ? String(meta["antigravity.google/conversation_id"] || "").trim() : "";
  return AG_CONV_RE.test(id) ? id : null;
}

function readVarint(buf, i) {
  let value = 0;
  for (let n = 0; n < 5; n++, i++) {
    if (i >= buf.length) return null;
    const b = buf[i];
    value += (b & 0x7f) * 2 ** (7 * n);
    if (b < 0x80) return { value, next: i + 1 };
  }
  return null;
}

const AG_URI_MAX = 4096;

function agUriByLength(buf, idBuf) {
  const idLen = idBuf.length;
  for (let at = buf.indexOf(idBuf); at >= 0; at = buf.indexOf(idBuf, at + 1)) {
    if (at < 1 || buf[at - 1] !== idLen) continue;
    const tag = readVarint(buf, at + idLen);
    if (!tag || (tag.value & 7) !== 2) continue;
    const len = readVarint(buf, tag.next);
    if (!len) continue;
    if (len.value < 8 || len.value > AG_URI_MAX || len.next + len.value > buf.length) continue;
    const val = buf.toString("utf8", len.next, len.next + len.value);
    if (!val.startsWith("file://")) continue;
    return val.slice("file://".length);
  }
  return null;
}

function agUriToPath(raw) {
  let p;
  try {
    p = decodeURIComponent(raw);
  } catch {
    p = raw;
  }
  return p.replace(/^\/([A-Za-z]:)/, "$1");
}

export function readAntigravityWorkspace(meta, local, { fs = fsMod, home = osMod.homedir() } = {}) {
  const id = antigravityConversationId(meta);
  if (!id) return null;
  const hit = agWsMemo.get(id);
  if (hit && (hit.dir || Date.now() - hit.at < AG_WS_MISS_MS)) return hit.dir;
  let dir = null;
  const db = path.join(antigravityDataDir(local?.clientCommand, { home }), "conversations", `${id}.db`);
  const idBuf = Buffer.from(id);
  for (const file of [db, `${db}-wal`]) {
    let buf;
    try {
      if (fs.statSync(file).size > AG_DB_MAX) continue;
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (!buf.length || buf.length > AG_DB_MAX) continue;
    const uri = agUriByLength(buf, idBuf);
    if (uri === null) continue;
    const p = agUriToPath(uri);
    if (!path.isAbsolute(p)) continue;
    dir = p;
    break;
  }
  if (agWsMemo.size >= TITLE_MEMO_MAX) agWsMemo.clear();
  agWsMemo.set(id, { dir, at: Date.now() });
  return dir;
}

const AG_META_STEP = 23;
const AG_META_FIELD = 30;
const AG_TITLE_FIELD = 4;
const AG_GOAL_FIELD = 19;
const AG_TMP_PREFIX = "ag-title-";
const AG_STEP_MAX = 64 << 10;
const AG_STEP_ROWS = 16;
const AG_OUT_MAX = 8 << 20;

function agLenField(buf, field) {
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) return null;
    const num = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (num === 0) return null;
    i = tag.next;
    if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len || len.next + len.value > buf.length) return null;
      if (num === field) return buf.subarray(len.next, len.next + len.value);
      i = len.next + len.value;
    } else if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v.next;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return null;
    }
  }
  return null;
}

function agTitleFromRows(rows) {
  let fallback = null;
  for (const row of rows) {
    const metaMsg = agLenField(row, AG_META_FIELD);
    if (!metaMsg) continue;
    const t = agLenField(metaMsg, AG_TITLE_FIELD);
    if (t) {
      const s = clip(t.toString("utf8"), 60);
      if (s) return s;
    }
    if (fallback === null) {
      const g = agLenField(metaMsg, AG_GOAL_FIELD);
      if (g) fallback = clip(g.toString("utf8"), 60);
    }
  }
  return fallback;
}

export function readAntigravitySessionTitle(meta, local, { fs = fsMod, home = osMod.homedir(), exec = execFileSync, tmpdir = osMod.tmpdir } = {}) {
  const id = antigravityConversationId(meta);
  if (!id) return null;
  const db = path.join(antigravityDataDir(local?.clientCommand, { home }), "conversations", `${id}.db`);
  return memoTitle(`ag:${id}`, () => {
    if (fs.statSync(db).size > AG_DB_MAX) return null;
    const dir = fs.mkdtempSync(path.join(tmpdir(), AG_TMP_PREFIX));
    try {
      const copy = path.join(dir, "conversation.db");
      fs.copyFileSync(db, copy);
      try {
        if (fs.statSync(`${db}-wal`).size <= AG_DB_MAX) fs.copyFileSync(`${db}-wal`, `${copy}-wal`);
      } catch {}
      const out = exec(
        process.platform === "win32" ? "sqlite3" : "/usr/bin/sqlite3",
        [copy, `select hex(step_payload) from steps where step_type = ${AG_META_STEP} and length(step_payload) <= ${AG_STEP_MAX} order by idx limit ${AG_STEP_ROWS}`],
        { encoding: "utf8", timeout: 2000, maxBuffer: AG_OUT_MAX }
      );
      const rows = [];
      for (const line of String(out || "").split("\n")) {
        const hex = line.trim();
        if (hex && /^(?:[0-9a-f]{2})+$/i.test(hex)) rows.push(Buffer.from(hex, "hex"));
      }
      return agTitleFromRows(rows);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
}

/*
 * 现在这一刻的会话标题。
 *
 * 顺序是**先协议级、后本机取证**，这一条不能反：`params._meta` 里带过来的会话 id 是
 * 调用方自己说的「这一次调用属于哪段对话」，是唯一不含推断成分的证据；本机取证那几条
 * （宿主文件、会话记录、活会话计数）多少都带假设。没有 meta 的客户端走本机取证那几条。
 *
 * 分不出是哪段对话时（整个 app 共用一个 MCP 进程、帧里又没有会话身份）一律返回 null，
 * 不拿时间窗口去猜。
 */
export function readSessionTitle(local, { fs = fsMod, home = osMod.homedir(), env = process.env, exec = execFileSync, alive = pidAlive, meta = null, dsh } = {}) {
  if (!local) return null;
  const zc = readZcodeSessionTitle(meta, { env, home, fs, exec });
  if (zc) return zc;
  const tr = readTraeSessionTitle(meta, { fs, dataDir: traeDataDir({ userDataDir: local.userDataDir, appDir: local.brandAppDir, env, fs, home }) });
  if (tr) return tr;
  const ag = readAntigravitySessionTitle(meta, local, { fs, home, exec });
  if (ag) return ag;
  const ds = dsh !== undefined ? dsh : readDshSession(local, { env, home, fs });
  if (ds?.title) return ds.title;
  const t = readHostSessionTitle(local.hostSessionId, { fs, home, env });
  if (t) return t;
  const file = readClientSessionFile(local.clientPid, { fs, home });
  if (file && file.nameSource !== "derived") return clip(file.name, 60);
  const wb = readWorkbuddySessionTitle({ env, fs, exec, alive });
  if (wb) return wb;
  return local.sessionName || null;
}

/*
 * 标题 + 会话级工作区，一次归属两样都拿。
 *
 * 工作区也要有会话级的一条：常驻进程型的客户端 spawn 我们时给的 cwd 是它自己启动时所在
 * 的目录，跟「这段对话开在哪个项目」无关，真正的项目写在会话自己的记录里。probeLocal
 * 那份工作区是进程级的、算一次就定死，所以这里另给一条会话级的出口；没有会话级证据的
 * 客户端返回 null，调用方照用进程级的那份。
 */
export function readSessionIdentity(local, { fs = fsMod, home = osMod.homedir(), env = process.env, exec = execFileSync, alive = pidAlive, meta = null, tmp } = {}) {
  if (!local) return { title: null, workspace: null, workspaceKind: null };
  const ds = readDshSession(local, { env, home, fs });
  const title = readSessionTitle(local, { fs, home, env, exec, alive, meta, dsh: ds });
  const agDir = readAntigravityWorkspace(meta, local, { fs, home });
  const wsDir = ds?.cwd || agDir;
  const ws = wsDir ? readWorkspace(wsDir, tmp !== undefined ? { fs, home, tmp } : { fs, home }) : null;
  return { title, workspace: ws?.name || null, workspaceKind: ws?.kind || null };
}

/*
 * 拼出发给扩展的那个 agent 对象。`name/title` 是客户端自报的原文（照旧原样带上），
 * `brand/version/surface/workspace/session` 是给人看的那几段。一段证据都没有就返回
 * null——帧里连 agent 键都不加。
 *
 * 品牌的优先级是 **title > 父进程链 > name**：title 是协议里专门留给「人看的名字」的
 * 字段，客户端报了它就是郑重报过家门；没报 title 的，父进程链认到的 .app 包名 / 裸进程名
 * 比 name 可信——name 常常是发协议帧的那层中间件在自报，显示出来就是冒名顶替；链上一点
 * 证据都没有（ps 不可用、真的是裸 CLI）才轮到 name。
 *
 * 版本号必须跟品牌**同源**：品牌来自 clientInfo 就用 clientInfo.version，来自 .app 包就读
 * 包的 Info.plist，来自裸进程名就没有版本。两头各取一段拼出来的版本比不显示还糟。
 */
export function composeAgent(clientInfo, local, sessionTitle, { exec = execFileSync } = {}) {
  const name = clip(clientInfo?.name, 40);
  const title = clip(clientInfo?.title, 40);
  const chainBrand = local?.brandFallback || null;
  const brand = title || chainBrand || informativeName(name) || null;
  let version = null;
  if (brand) {
    if (brand === title || !chainBrand) version = clip(clientInfo?.version, 20);
    else version = local?.brandAppDir ? readBundleVersion(local.brandAppDir, { exec }) : null;
  }
  const a = {
    name,
    title,
    version,
    brand,
    surface: local?.surface || null,
    workspace: local?.workspace || null,
    workspaceKind: local?.workspaceKind || null,
    session: clip(sessionTitle, 60),
  };
  if (!a.brand && !a.name && !a.title && !a.workspace && !a.session) return null;
  return a;
}
