// Agent in Chrome — 配置真源：~/.agent-in-chrome/config.json。三个读者（扩展 sw.js、
// MCP server 本进程、安装器 / CLI）互相读不到对方的内存，权威因此放在一个三方都能直接读、
// 且不依赖谁在线的文件里；内存里的都是缓存，文件说了算。两条铁律：
//   1. **坏配置一律失败关闭**——保住上一份好的，绝不回落成默认值：默认值比用户的设置
//      宽松，静默回落等于替他把关掉的工具打开。2. **写必须原子**——临时文件 + rename。

import fs from "node:fs";
import path from "node:path";
import { defaultDataDir } from "./token.mjs";

export const CONFIG_DIR = defaultDataDir();
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/* 工具档位。名字是对外契约（配置文件里写的就是这个词），别改。 */
export const PROFILES = ["observe", "full"];
/*
 * 旧档位名到现档位的迁移表。迁移方向必须是**放宽**：standard → full（更宽松的一侧），
 * 绝不映射到 observe——静默削减用户已有的能力比多给一点危险更糟。
 * readonly → observe 是同能力换名（外加 revealSecrets 提档）。
 */
export const LEGACY_PROFILES = { readonly: "observe", standard: "full" };

/*
 * 缺省 = 现在的行为。这一条很重要：老用户升上来时没有配置文件，
 * 读到的必须和他升级前用的一模一样，不能因为「有了配置系统」就换了默认行为。
 */
export const DEFAULTS = Object.freeze({
  version: 1,
  tools: Object.freeze({
    profile: "full",
    disable: Object.freeze([]),
    enable: Object.freeze([]),
  }),
});

const clone = (o) => JSON.parse(JSON.stringify(o));

/*
 * 校验 + 补默认值。返回 { value, problems }。
 *
 * problems 非空不代表 value 不能用——不认识的字段会被指出来但跳过，
 * 这样老版本 server 碰上新版本写的配置不会整个罢工。真正致命的（比如
 * 顶层不是对象）会让 value 为 null，交给调用方决定失败关闭。
 */
export function normalize(raw) {
  const problems = [];
  const notes = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, problems: ["顶层不是一个 JSON 对象"], notes };
  }
  const out = clone(DEFAULTS);

  if (raw.version !== undefined) {
    if (!Number.isInteger(raw.version) || raw.version < 1) problems.push(`version 得是 >=1 的整数，收到 ${JSON.stringify(raw.version)}`);
    else out.version = raw.version;
  }

  const t = raw.tools;
  if (t !== undefined) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      problems.push("tools 得是对象");
    } else {
      if (t.profile !== undefined) {
        if (PROFILES.includes(t.profile)) {
          out.tools.profile = t.profile;
        } else if (t.profile in LEGACY_PROFILES) {
          out.tools.profile = LEGACY_PROFILES[t.profile];
          notes.push(
            `tools.profile 的 ${JSON.stringify(t.profile)} 是旧档位名，已按 ${JSON.stringify(LEGACY_PROFILES[t.profile])} 生效（0.40 起档位只剩 observe/full）`
          );
        } else {
          return { value: null, problems: [`tools.profile 只能是 ${PROFILES.join(" / ")}，收到 ${JSON.stringify(t.profile)}`], notes };
        }
      }
      for (const key of ["disable", "enable"]) {
        if (t[key] === undefined) continue;
        if (!Array.isArray(t[key])) {
          problems.push(`tools.${key} 得是字符串数组`);
          continue;
        }
        const bad = t[key].filter((x) => typeof x !== "string" || !x);
        if (bad.length) problems.push(`tools.${key} 里有非字符串项：${JSON.stringify(bad)}`);
        out.tools[key] = [...new Set(t[key].filter((x) => typeof x === "string" && x))];
      }
    }
  }

  for (const k of Object.keys(raw)) if (!["version", "tools"].includes(k)) problems.push(`不认识的字段 ${k}（已忽略）`);

  return { value: out, problems, notes };
}

export function defaults() {
  return clone(DEFAULTS);
}

/*
 * 同步读一次。
 *
 * 返回 { value, problems, source }：
 *   source = "default"（文件不存在）/ "file"（读到了）/ "error"（存在但读不了）
 * source === "error" 时 value 为 null —— 调用方必须失败关闭（保住上一份好的），
 * 不能把它当成 "default"。
 */
export function loadSync(file = CONFIG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { value: defaults(), problems: [], notes: [], source: "default" };
    return { value: null, problems: [`读不了 ${file}：${e.message}`], notes: [], source: "error" };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { value: null, problems: [`${file} 不是合法 JSON：${e.message}`], notes: [], source: "error" };
  }
  const { value, problems, notes } = normalize(raw);
  if (value === null) return { value: null, problems, notes, source: "error" };
  return { value, problems, notes, source: "file" };
}

/*
 * 原子写：同目录临时文件 + rename。
 *
 * 必须同目录——跨文件系统 rename 会退化成拷贝，就不原子了。
 * 只有本进程/扩展改设置时才调它；读者从不写。
 */
export function saveSync(value, file = CONFIG_FILE) {
  const { value: clean, problems } = normalize(value);
  if (clean === null) throw new Error(`拒绝写入无效配置：${problems.join("；")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  return clean;
}

/*
 * 盯着配置文件，变了就回调。返回 stop()。
 *
 * 盯的是**目录**不是文件：
 *   · 原子写是 rename，被 watch 的那个 inode 根本没被改过，watch 文件收不到事件；
 *   · 文件一开始不存在时 watch 文件直接抛 ENOENT，而「第一次创建配置」正是要监听的时刻；
 *   · 编辑器保存多半也是 rename-replace，同理。
 *
 * 防抖：一次保存常常连着来好几个事件（rename 前后、元数据），不合并的话
 * 一次改动会发好几条 listChanged，客户端跟着重拉好几次工具表。
 *
 * 另外还带一段**有界引导轮询**：`fs.watch` 在 macOS 上要过一小会儿才真的开始监听，
 * 这段窗口里的写入原生事件一条都不会有，靠比对文件指纹补上。收到第一个原生事件
 * （证明流活了）或超过上限就自动停，之后一律走原生事件。
 */
const BOOTSTRAP_POLL_MS = 200;
const BOOTSTRAP_MAX_MS = 10_000;

export function watch(onChange, { file = CONFIG_FILE, debounceMs = 80, _watchImpl = fs.watch } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  const fingerprint = () => {
    try {
      const s = fs.statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "absent";
    }
  };

  let timer = null;
  let stopped = false;
  let poll = null;
  let fp = fingerprint();
  let w;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange(loadSync(file));
    }, debounceMs);
  };
  const stopPoll = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };

  try {
    w = _watchImpl(dir, { persistent: false }, (_type, name) => {
      stopPoll();
      if (name && name !== base) return;
      fp = fingerprint();
      schedule();
    });
  } catch (e) {
    return { ok: false, error: e, stop() {} };
  }
  w.unref?.();

  const bootedAt = Date.now();
  poll = setInterval(() => {
    if (stopped) return stopPoll();
    const now = fingerprint();
    if (now !== fp) {
      fp = now;
      schedule();
    }
    if (Date.now() - bootedAt >= BOOTSTRAP_MAX_MS) stopPoll();
  }, BOOTSTRAP_POLL_MS);
  poll.unref?.();

  return {
    ok: true,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopPoll();
      try {
        w.close();
      } catch {}
    },
  };
}
