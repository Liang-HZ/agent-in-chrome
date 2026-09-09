// 本机侧「因果归还前台」：agent 引出的新页会让 Chrome 把**整个 app** 抢到前台（那一下写死
// 在浏览器进程里，扩展层拦不住），这一层只做一件事——**我们抢走的，当场还回去**。
// 两条缺一不可：`callBrowser()` 下发时 `arm()` 记下此刻的前台 app；扩展凭因果认领新页时
// 回一帧 `foreground-restore` → `confirm()`；两条同时成立才 activate 回去。判据全是因果，
// 这里一个字都不认「Chrome」。失败方向是宁可不还、也不硬拽：非 macOS / helper 起不来 /
// 采样工具都没有 → 整个特性静默不生效，不报错、不影响任何工具调用。

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * 武装的有效期。
 *
 * 要罩住扩展那侧的 `SPAWN_ACTION_WINDOW_MS`（5s：「点了按钮 → 发一次请求拿到跳转
 * 地址 → 再 window.open」这种慢接口形态）。放长不危险——真正把闸打开的是 confirm，
 * 而 confirm 本身就是因果信号；武装只负责「记下用户当时在哪」。
 */
export const ARM_TTL_MS = 5500;

const SAMPLE_FRESH_MS = 2000;
const SAMPLE_THROTTLE_MS = 250;

export function helperCandidates(base = HERE) {
  return [
    process.env.AGENT_IN_CHROME_FG_HELPER,
    path.join(base, "mac-foreground", "aic-fg"),
    path.join(base, "..", "native-host", "mac-foreground", "aic-fg"),
  ].filter(Boolean);
}

function findHelper(base, exists) {
  for (const c of helperCandidates(base)) {
    try {
      if (exists(c)) return c;
    } catch {}
  }
  return null;
}

const defaultExists = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/*
 * 建一个守护。**惰性**：不 `arm()` 就一个子进程都不起（Chrome 开着但没 agent 干活
 * 是一天里的大多数时间，那段时间这里应当零成本）。
 *
 * 依赖全部可注入，测试用假 helper 子进程 / 假 spawn 跑完整条路，不碰真的窗口系统。
 */
export function createForegroundGuard({
  platform = process.platform,
  spawn = nodeSpawn,
  base = HERE,
  exists = defaultExists,
  now = Date.now,
  armTtlMs = ARM_TTL_MS,
  log = () => {},
  enabled = process.env.AGENT_IN_CHROME_NO_FG_GUARD !== "1",
} = {}) {
  const stats = {
    mode: "off",
    spawns: 0,
    arms: 0,
    confirms: 0,
    restores: 0,
    skips: 0,
    lastEvent: null,
    lastSkip: null,
  };
  const inert = platform !== "darwin" || !enabled;

  let child = null;
  let started = false;
  let helperPath = null;
  let stdoutBuf = "";
  const events = [];

  let sample = null;
  let sampling = false;
  let lastSampleAt = 0;
  let armedUntil = 0;
  let armBase = null;

  function sampleFront(cb) {
    if (sampling) return;
    const t = now();
    if (t - lastSampleAt < SAMPLE_THROTTLE_MS && sample) return cb?.(sample);
    sampling = true;
    lastSampleAt = t;
    let out = "";
    let p;
    try {
      p = spawn("/usr/bin/lsappinfo", ["list"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      sampling = false;
      return;
    }
    p.stdout?.on("data", (d) => {
      out += d;
    });
    p.on("error", () => {
      sampling = false;
    });
    p.on("close", () => {
      sampling = false;
      const i = out.indexOf("(in front)");
      if (i < 0) return;
      const m = /bundleID="([^"]+)"/.exec(out.slice(i, i + 400));
      if (!m) return;
      sample = { bundleId: m[1], at: now() };
      cb?.(sample);
    });
  }

  function fallbackConfirm() {
    const t = now();
    const b = armBase;
    if (t > armedUntil) return note("skip", { why: "not-armed" });
    if (!b || t - b.at > SAMPLE_FRESH_MS) return note("skip", { why: "no-base" });
    sampling = false;
    lastSampleAt = 0;
    sampleFront((s) => {
      if (!s || s.bundleId === b.bundleId) return note("skip", { why: "no-steal" });
      if (now() > armedUntil) return note("skip", { why: "not-armed" });
      try {
        const p = spawn("/usr/bin/open", ["-b", b.bundleId], { stdio: "ignore" });
        p.on("error", () => {});
      } catch {
        return note("skip", { why: "open-failed" });
      }
      note("restore", { to: b.bundleId, via: "open -b", exposureMs: null });
    });
  }

  function note(t, extra) {
    const ev = { t, ms: now(), ...extra };
    stats.lastEvent = ev;
    if (t === "restore") stats.restores++;
    if (t === "skip") {
      stats.skips++;
      stats.lastSkip = ev.why || null;
    }
    events.push(ev);
    if (events.length > 64) events.shift();
    log(ev);
    return ev;
  }

  function ensureChild() {
    if (started) return;
    started = true;
    helperPath = findHelper(base, exists);
    if (!helperPath) {
      stats.mode = "fallback";
      log({ t: "mode", mode: "fallback", why: "没找到 aic-fg helper" });
      return;
    }
    try {
      child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      child = null;
      stats.mode = "fallback";
      log({ t: "mode", mode: "fallback", why: `helper 起不来：${e?.message || e}` });
      return;
    }
    stats.spawns++;
    stats.mode = "helper";
    child.unref?.();
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      stdoutBuf += d;
      let i;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        note(ev.t, ev);
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      stats.mode = "fallback";
    });
  }

  function toHelper(line) {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      return child.stdin.write(line + "\n");
    } catch {
      return false;
    }
  }

  return {
    stats: () => ({ ...stats }),
    events: () => events.slice(),
    helperPath: () => helperPath,

    /*
     * 一次工具下发。记下「此刻用户在哪」。绝不阻塞调用方。
     * @returns {boolean} 有没有真的武装（非 macOS / 关掉了 → false）
     */
    arm() {
      if (inert) return false;
      ensureChild();
      stats.arms++;
      log({ t: "arm", mode: stats.mode, ttlMs: armTtlMs });
      if (child) return toHelper(`arm ${armTtlMs}`);
      armedUntil = now() + armTtlMs;
      armBase = null;
      sampleFront((s) => {
        if (now() <= armedUntil) armBase = s;
      });
      return true;
    },

    /* 结果因到了：扩展凭因果认领了这一动作引出的新页 */
    confirm(info = {}) {
      if (inert) return false;
      if (!started) return false;
      stats.confirms++;
      log({ t: "confirm", mode: stats.mode, tabId: info?.tabId, sid: info?.sid });
      if (child) return toHelper("confirm");
      fallbackConfirm();
      return true;
    },

    disarm() {
      if (inert) return false;
      log({ t: "disarm", mode: stats.mode });
      armedUntil = 0;
      armBase = null;
      if (child) return toHelper("disarm");
      return true;
    },

    stop() {
      armedUntil = 0;
      armBase = null;
      const c = child;
      child = null;
      if (!c) return;
      try {
        c.stdin?.write("quit\n");
      } catch {}
      try {
        c.kill();
      } catch {}
    },
  };
}

/* 可开关的取证日志：`AGENT_IN_CHROME_FG_TRACE=<文件>` 一开，每一次 arm / confirm / disarm
 * 和 helper 回上来的每一条事件（armed / steal / restore / skip）都按 JSONL 追加，带 pid 和
 * 毫秒时刻。默认关闭，写不出文件就当没有，绝不影响调用。 */
function traceLogger() {
  const f = process.env.AGENT_IN_CHROME_FG_TRACE;
  if (!f) return () => {};
  return (ev) => {
    try {
      fs.appendFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), ...ev }) + "\n");
    } catch {}
  };
}

/* 进程级单例。server.mjs 只用这一个 */
let singleton = null;
export function foregroundGuard() {
  if (!singleton) singleton = createForegroundGuard({ log: traceLogger() });
  return singleton;
}
export function resetForegroundGuard() {
  try {
    singleton?.stop();
  } catch {}
  singleton = null;
}
