// Agent in Chrome — CLI / headless 模式：自己起一个浏览器，用直连 CDP 驱动。
//
// 桌面模式（用户自己开的 Chrome + 装好的扩展）完全不经过这个文件。
// CLI / headless 模式面向的是没有桌面前提的场合：终端里的 agent、cron、CI、远程机器。
//
// 本模块管的是浏览器的一生：找二进制（findBrowser）、拼命令行（browserArgs）、
// 冷启动或认领已在跑的实例（ensureBrowser）、收孤儿（sweepOrphans）、
// 收场（stopBrowser / stopBrowserGracefully）。用的是**用户机器上那个正式版 Chrome**，
// 不是 Chrome for Testing——指纹差别站点看得见。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { scriptCmd } from "../cli-invocation.mjs";

// 提示里那条「去收掉占用者」的命令，按用户的装法拼（git 检出敲脚本，npm 装的敲子命令）。
const CLI_BROWSER = scriptCmd("cli-browser");

const HOME = os.homedir();

export const RUNTIME_DIR = path.join(HOME, ".agent-in-chrome", "agent-in-chrome");
/*
 * CLI 模式专用 profile，可用 AGENT_IN_CHROME_PROFILE 指到别处，恒为绝对路径。
 * **不能是用户日常那个 profile**：新版 Chrome 会直接拒绝对默认 profile 开
 * `--remote-debugging-port`。代价是这个 profile 第一次跑没有任何登录态，需要的站点得
 * 在里面登一次（登完就持久留着）。
 */
export const PROFILE_DIR = path.resolve(process.env.AGENT_IN_CHROME_PROFILE || path.join(RUNTIME_DIR, "cli-profile"));
const PID_BASENAME = "aic-cli-browser.json";
const PID_FILE = path.join(PROFILE_DIR, PID_BASENAME);
const LEGACY_PID_FILE = path.join(RUNTIME_DIR, "cli-browser.json");
const LOG_FILE = path.join(HOME, ".agent-in-chrome", "agent-in-chrome-cli.log");
const BROWSER_LOG = path.join(PROFILE_DIR, "aic-cli-browser.log");

export const LAUNCH_MODE = ["1", "true", "yes", "on"].includes(
  String(process.env.AGENT_IN_CHROME_LAUNCH || "").toLowerCase()
);
export const HEADLESS = !["0", "false", "no", "off"].includes(
  String(process.env.AGENT_IN_CHROME_HEADLESS ?? "1").toLowerCase()
);
/* 退出时不收浏览器，留给下一次调用热启动（AGENT_IN_CHROME_KEEP=1） */
export const KEEP_BROWSER = ["1", "true", "yes", "on"].includes(
  String(process.env.AGENT_IN_CHROME_KEEP || "").toLowerCase()
);

/*
 * CDP 走管道还是走 TCP 端口。**默认管道。**
 *
 * · 管道（`--remote-debugging-pipe`，走子进程的 fd 3/4）：不开任何 TCP 端口、
 *   也不写 DevToolsActivePort，只有父进程用得上；代价是浏览器绑在本进程上，
 *   活不过它，也没法被别的进程收养。
 * · 端口（`--remote-debugging-port`）：可被收养（KEEP 热复用、主退出后从会话接管
 *   都靠它），代价是那个端口**没有任何访问控制**——本机任何进程连上就能全权驱动。
 *
 * 所以开关挂在 KEEP 上（它的含义本就是「这个浏览器要活过本进程」）：默认走管道，
 * `AGENT_IN_CHROME_KEEP=1` 走端口。显式压过：`AGENT_IN_CHROME_CDP_TRANSPORT=pipe|port`。
 */
const TRANSPORT_ENV = String(process.env.AGENT_IN_CHROME_CDP_TRANSPORT || "").toLowerCase();
export const USE_PIPE = TRANSPORT_ENV === "pipe" ? true : TRANSPORT_ENV === "port" ? false : !KEEP_BROWSER;

/* sweepOrphans 先 SIGTERM 等这么久，还赖着再 SIGKILL 等那么久；两段之和就是它的预算 */
const SWEEP_TERM_MS = 2_000;
const SWEEP_KILL_MS = 500;
const SWEEP_BUDGET_MS = SWEEP_TERM_MS + SWEEP_KILL_MS;
/* 管道传输拿端点的上限（在 fd3 上问一句 Browser.getVersion） */
const PIPE_ENDPOINT_MS = 20_000;
/* 端口传输拿端点的上限（等 DevToolsActivePort 出现并验明正身） */
const PORT_ENDPOINT_MS = 30_000;

/* 「保证有一个浏览器可用」最长可能花多久 —— 各段预算之和，不是拍出来的数 */
export const STARTUP_BUDGET_MS = SWEEP_BUDGET_MS + (USE_PIPE ? PIPE_ENDPOINT_MS : PORT_ENDPOINT_MS);

/*
 * 调用方等桥接就绪的宽限。留一半余量：预算是各段**理论上限**之和，真实路径还要
 * 加上进程 spawn、ps 快照、磁盘这些没法计入预算的开销。
 * 上限由 MCP 的 60s 调用超时兜着——超过它再等也没意义，桥接那边会先一步被杀掉。
 */
export const BRIDGE_GRACE_MS = Math.min(Math.round(STARTUP_BUDGET_MS * 1.5), 50_000);

const LOG_MAX_BYTES = 2_000_000;

/* 每次落盘先看一眼要不要轮转：超过 maxBytes 就把当前这份挪成 `.1`（只留一代）。所有日志共用这一条 */
export function rotateIfBig(file, maxBytes = LOG_MAX_BYTES) {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

const LOG_CHECK_EVERY_BYTES = 64 * 1024;
let logSinceCheck = Infinity;

/*
 * 写一行日志：stderr 一份，`~/.agent-in-chrome/agent-in-chrome-cli.log` 一份（会轮转）。
 * **绝不能写 stdout**——那是 MCP 的 JSON-RPC 协议通道，往上写一个字节就把协议流毁了。
 */
export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  try {
    process.stderr.write(line + "\n");
  } catch {}
  try {
    logSinceCheck += line.length + 1;
    if (logSinceCheck >= LOG_CHECK_EVERY_BYTES) {
      logSinceCheck = 0;
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      rotateIfBig(LOG_FILE);
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {}
  }
}

function firstExisting(cands) {
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

/*
 * 找浏览器。优先级就是「越像用户日常那台越好」：
 * 正式版 Chrome → Beta/Canary → Chromium / Chrome for Testing（指纹会差，最后才用）。
 */
export function findBrowser() {
  const explicit = process.env.AGENT_IN_CHROME_BIN;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`AGENT_IN_CHROME_BIN 指的文件不存在：${explicit}`);
    return { bin: explicit, kind: "指定", stable: true };
  }

  const mac = process.platform === "darwin";
  const stableCands = mac
    ? [
        ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "正式版 Chrome"],
        [path.join(HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "正式版 Chrome"],
        ["/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", "Chrome Beta"],
        ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "Chrome Canary"],
      ]
    : [
        ["/usr/bin/google-chrome", "正式版 Chrome"],
        ["/usr/bin/google-chrome-stable", "正式版 Chrome"],
        ["/opt/google/chrome/chrome", "正式版 Chrome"],
      ];
  for (const [bin, kind] of stableCands) if (fs.existsSync(bin)) return { bin, kind, stable: true };

  const fallback = mac
    ? [
        ["/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"],
        [
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "Chrome for Testing",
        ],
      ]
    : [
        ["/usr/bin/chromium", "Chromium"],
        ["/usr/bin/chromium-browser", "Chromium"],
      ];
  for (const [bin, kind] of fallback) if (fs.existsSync(bin)) return { bin, kind, stable: false };

  throw new Error(
    "找不到浏览器。CLI/headless 模式要用本机的 Chrome（指纹就该是它本来的样子）：\n" +
      (mac
        ? "  macOS：装 Google Chrome 到 /Applications 即可\n"
        : "  Linux：apt install google-chrome-stable，或用 AGENT_IN_CHROME_BIN 指路径\n") +
      "也可以用 AGENT_IN_CHROME_BIN 指定任意 Chromium 系二进制。"
  );
}

const versionCache = new Map();
function browserMajorVersion(bin) {
  let key = bin;
  try {
    key = `${bin}@${fs.statSync(bin).mtimeMs}`;
  } catch {}
  if (versionCache.has(key)) return versionCache.get(key);
  let major = "";
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8" });
    major = (out.match(/(\d+)\.\d+\.\d+\.\d+/) || [])[1] || "";
  } catch {}
  versionCache.set(key, major);
  return major;
}

function headedUserAgent(bin) {
  const major = browserMajorVersion(bin);
  if (!major) return null;
  const plat =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/*
 * 自启浏览器的认领标记，写在浏览器进程自己的命令行上（不依赖任何文件）。
 * 值是**起它的那个进程的 pid**，扫孤儿靠它认「这个浏览器是不是我们起的、还有没有人要」。
 */
export const OWNER_FLAG = "--aic-owner";

/*
 * 从浏览器进程的命令行里读出它的 `--user-data-dir`，读不到给 null。
 *
 * 值一直取到下一个 ` --` 开头的旗标为止：路径里带空格（macOS 的
 * `Application Support` 之流）不能把它截成半截。我们自己 spawn 的命令行里
 * user-data-dir 后面永远还有别的旗标（--remote-debugging-port 紧跟其后），
 * 所以这个边界总是存在。
 */
export function profileDirFrom(cmd) {
  const m = /--user-data-dir=(.+?)(?=\s--|$)/.exec(String(cmd || ""));
  return m ? m[1] : null;
}

/*
 * 从进程列表里挑出「我们起的、而且**没人要了**」的浏览器，返回它们的 pid。
 *
 * 纯函数。判据严格到偏执，失败方向是**宁可漏杀，也绝不误杀用户自己的 Chrome**：
 * 必须带我们的标记（OWNER_FLAG，且前面是空白）、标记值是纯数字 pid、命令行里确实是
 * 浏览器、主人已经不在了；主人不在之后还要再问 profile 里的账——账上 adoptable=true
 * 或 managerPid 还活着，都表示「有人还要它」，不碰。
 *
 * @param procs [{pid, cmd}]
 * @param isAlive (pid) => boolean —— 判断主人 / 现任管理者是否还在
 * @param opts.readRecord (profileDir) => 该 profile 的浏览器记录，不给就回到只看主人的老判据
 * @param opts.excludeProfile 这个 profile 的浏览器一律不碰
 */
export function orphansFrom(procs, isAlive, { readRecord = null, excludeProfile = null } = {}) {
  const re = new RegExp(`(?:^|\\s)${OWNER_FLAG.replace(/[-]/g, "\\-")}=(\\d+)(?:\\s|$)`);
  const out = [];
  for (const p of procs || []) {
    const cmd = String(p?.cmd || "");
    if (!/chrome|chromium/i.test(cmd)) continue;
    const m = re.exec(cmd);
    if (!m) continue;
    const owner = Number(m[1]);
    if (!Number.isInteger(owner) || owner <= 0) continue;
    if (isAlive(owner)) continue;
    const profile = profileDirFrom(cmd);
    if (excludeProfile && profile === excludeProfile) continue;
    if (readRecord && profile) {
      const rec = readRecord(profile);
      if (rec && Number(rec.pid) === Number(p.pid)) {
        if (rec.adoptable === true) continue;
        if (rec.managerPid && isAlive(Number(rec.managerPid))) continue;
      }
    }
    out.push(Number(p.pid));
  }
  return out;
}

/* 本机进程快照，只取 pid + 完整命令行 */
export function psSnapshot() {
  try {
    const out = execFileSync("/bin/ps", ["-eo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 << 20 });
    return out
      .split("\n")
      .map((l) => {
        const m = /^\s*(\d+)\s+(.*)$/.exec(l);
        return m ? { pid: Number(m[1]), cmd: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

function pidIsZombie(pid) {
  if (process.platform === "win32") return false;
  try {
    const st = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    return /^\s*Z/.test(String(st));
  } catch {
    return false;
  }
}

/* 给 orphansFrom 的账本读取器：<profile>/aic-cli-browser.json，读不到就是没账 */
export function readProfileRecord(profileDir) {
  return readJson(path.join(profileDir, PID_BASENAME));
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/*
 * 盯着这批 pid 直到它们消失或超时，返回**还活着**的那些。
 *
 * 单独抽出来是为了能被注入着测：真进程的死亡时机不由我们说了算，
 * 拿真进程去测「等待逻辑对不对」只会测出一个偶发的测试。
 */
export function waitGone(pids, { isAlive = pidAlive, totalMs = 2000, stepMs = 50, sleep = sleepSync, now = Date.now } = {}) {
  let left = pids.filter(isAlive);
  const deadline = now() + totalMs;
  while (left.length) {
    const remain = deadline - now();
    if (remain <= 0) break;
    sleep(Math.min(stepMs, remain));
    left = left.filter(isAlive);
  }
  return left;
}

/*
 * 收掉本机上「我们起的、没人要了」的浏览器（同步版）。
 * 先 SIGTERM 整组、等，还赖着再 SIGKILL、再等，**验完再报**：
 * 返回 {gone, stubborn}——确认没了的进 gone，杀不掉的进 stubborn，绝不谎报成功。
 * 没有孤儿时一次都不等。
 *
 * @param excludeProfile 这个 profile 的浏览器不碰（调用方自己正要认领它）
 */
export function sweepOrphans({
  excludeProfile = null,
  isAlive = pidAlive,
  kill = (pid, sig) => process.kill(pid, sig),
  sleep = sleepSync,
  procs = null,
  termGraceMs = SWEEP_TERM_MS,
  killGraceMs = SWEEP_KILL_MS,
} = {}) {
  const plan = sweepPlan({ excludeProfile, kill, procs });
  if (!plan) return { gone: [], stubborn: [] };
  const { targets, signal, signalled } = plan;
  let left = signalled.length ? waitGone(signalled, { isAlive, totalMs: termGraceMs, sleep }) : [];
  if (left.length) {
    for (const pid of left) signal(pid, "SIGKILL");
    left = waitGone(left, { isAlive, totalMs: killGraceMs, sleep });
  }
  return sweepFinish(targets, signalled, left, isAlive);
}

/*
 * sweepOrphans 的异步版，参数与返回值完全相同。
 * **走得到 await 的调用方必须用这个**：同步那版用 Atomics.wait 把整条线程停住，
 * 最长 2.5s，那段时间事件循环完全冻结，MCP 的请求一律无人应答。
 * 同步版也不能删——`process.on("exit")` 里的兜底只跑得动同步代码。
 */
export async function sweepOrphansAsync({
  excludeProfile = null,
  isAlive = pidAlive,
  kill = (pid, sig) => process.kill(pid, sig),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  procs = null,
  termGraceMs = SWEEP_TERM_MS,
  killGraceMs = SWEEP_KILL_MS,
} = {}) {
  const plan = sweepPlan({ excludeProfile, kill, procs });
  if (!plan) return { gone: [], stubborn: [] };
  const { targets, signal, signalled } = plan;
  let left = signalled.length ? await waitGoneAsync(signalled, { isAlive, totalMs: termGraceMs, sleep }) : [];
  if (left.length) {
    for (const pid of left) signal(pid, "SIGKILL");
    left = await waitGoneAsync(left, { isAlive, totalMs: killGraceMs, sleep });
  }
  return sweepFinish(targets, signalled, left, isAlive);
}

function canGroupKill(pid, procs) {
  const cmd = (procs || []).find((p) => Number(p?.pid) === Number(pid))?.cmd;
  const profile = cmd ? profileDirFrom(String(cmd)) : null;
  if (!profile) return true;
  const rec = readProfileRecord(profile);
  return !rec || rec.transport !== "pipe";
}

function sweepPlan({ excludeProfile, kill, procs }) {
  const snap = procs || psSnapshot();
  const targets = orphansFrom(snap, pidAlive, { readRecord: readProfileRecord, excludeProfile });
  if (!targets.length) return null;
  const signal = (pid, sig) => {
    if (canGroupKill(pid, snap)) {
      try {
        kill(-pid, sig);
        return true;
      } catch {}
    }
    try {
      kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const signalled = targets.filter((pid) => signal(pid, "SIGTERM"));
  return { targets, signal, signalled };
}

function sweepFinish(targets, signalled, left, isAlive) {
  const stubborn = new Set(left);
  for (const pid of targets) if (!signalled.includes(pid) && isAlive(pid)) stubborn.add(pid);
  const gone = targets.filter((pid) => !stubborn.has(pid));

  if (gone.length) log(`收掉 ${gone.length} 个孤儿浏览器: ${gone.join(", ")}`);
  if (stubborn.size) log(`有 ${stubborn.size} 个孤儿浏览器杀不掉（SIGKILL 之后仍在）: ${[...stubborn].join(", ")}`);
  return { gone, stubborn: [...stubborn] };
}

/* waitGone 的异步版：等法一样，只是把线程还给事件循环 */
export async function waitGoneAsync(pids, { isAlive = pidAlive, totalMs = 2000, stepMs = 50, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  let left = pids.filter(isAlive);
  const deadline = now() + totalMs;
  while (left.length) {
    const remain = deadline - now();
    if (remain <= 0) break;
    await sleep(Math.min(stepMs, remain));
    left = left.filter(isAlive);
  }
  return left;
}

/*
 * 拼浏览器命令行。固定带上本 profile 的 `--user-data-dir`、认领标记（OWNER_FLAG）、
 * 以及一串把「自动化痕迹」抹平的开关（navigator.webdriver、UA / UA-CH 等）。
 * pipe=true 走 `--remote-debugging-pipe`，否则 `--remote-debugging-port=<port>`（0 = 内核分配）。
 */
export function browserArgs({ headless = HEADLESS, port = 0, bin = null, pipe = USE_PIPE } = {}) {
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    pipe ? "--remote-debugging-pipe" : `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--hide-crash-restore-bubble",
    "--use-mock-keychain",
    "--password-store=basic",
    `--window-size=${process.env.AGENT_IN_CHROME_WINDOW || "1280,800"}`,
    "--disable-blink-features=AutomationControlled",
    "--disable-component-update",
    "--disable-features=OptimizationHints",
    "--disable-gpu-shader-disk-cache",
    `--disk-cache-size=${Number(process.env.AGENT_IN_CHROME_DISK_CACHE || 134_217_728)}`,
    `${OWNER_FLAG}=${process.pid}`,
  ];
  if (process.platform === "linux") args.push("--disable-dev-shm-usage");
  if (headless) {
    args.unshift("--headless=new");
    const ua = bin ? headedUserAgent(bin) : null;
    if (ua) args.push(`--user-agent=${ua}`);
  }
  if (process.env.AGENT_IN_CHROME_ARGS) args.push(...process.env.AGENT_IN_CHROME_ARGS.split(" ").filter(Boolean));
  args.push("about:blank");
  return args;
}

const ACTIVE_PORT_FILE = () => path.join(PROFILE_DIR, "DevToolsActivePort");

/*
 * 读 DevToolsActivePort：第一行是端口，第二行是 browser 端点的路径。
 *
 * 第二行长这样：`/devtools/browser/0b6916d7-bd5a-4f78-94b1-e14fb8e377a6`。
 * 那个 GUID 是**每次启动新生成的、一个浏览器实例一个**，它是本文件里最值钱的一样
 * 东西——见 verifyEndpoint。
 */
function readEndpoint() {
  try {
    const [port, wsPath] = fs.readFileSync(ACTIVE_PORT_FILE(), "utf8").split("\n");
    if (!port || !wsPath) return null;
    return {
      port: Number(port.trim()),
      wsPath: wsPath.trim(),
      wsUrl: `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`,
    };
  } catch {
    return null;
  }
}

/*
 * 让端口本人确认：你就是**这个 profile** 的端口文件记的那个浏览器。
 * 核对用 Chrome 自己给的东西——`/json/version` 回的 `webSocketDebuggerUrl` 里带着
 * 那个一实例一个的 GUID，和端口文件第二行逐字相同才认。对不上就抛。
 * 只探活是不够的：端口号会被复用，旧端口文件 + 别人的浏览器一样 200 照回。
 */
async function verifyEndpoint(ep) {
  const r = await fetch(`http://127.0.0.1:${ep.port}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`调试端口 ${ep.port} 回了 HTTP ${r.status}`);
  const info = await r.json();
  const got = (() => {
    try {
      return new URL(info.webSocketDebuggerUrl).pathname;
    } catch {
      return null;
    }
  })();
  if (got !== ep.wsPath)
    throw new Error(
      `调试端口 ${ep.port} 上是**另一个**浏览器：它自报 ${got}，而本 profile 的端口文件记的是 ` +
        `${ep.wsPath}。端口号被复用了、端口文件是旧的——不是我们要找的那个浏览器。`
    );
  return { ...ep, version: info.Browser };
}

async function waitForEndpoint(timeoutMs = PORT_ENDPOINT_MS) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const ep = readEndpoint();
    if (ep) {
      try {
        return await verifyEndpoint(ep);
      } catch (e) {
        last = e;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `${timeoutMs}ms 内没等到浏览器的调试端点（${ACTIVE_PORT_FILE()}）。` +
      `看浏览器日志 ${BROWSER_LOG}${last ? `；最后一次探测报的是 ${last.message}` : ""}`
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function locatePid() {
  const rec = readJson(PID_FILE);
  if (rec?.pid) return [PID_FILE, rec];
  const legacy = readJson(LEGACY_PID_FILE);
  if (legacy?.pid && legacy.profileDir === PROFILE_DIR) return [LEGACY_PID_FILE, legacy];
  return [PID_FILE, null];
}

function readPid() {
  return locatePid()[1];
}

function writePid(rec) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  const tmp = `${PID_FILE}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  try {
    fs.renameSync(tmp, PID_FILE);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  dropLegacyIfOurs();
}

/*
 * 在账上记一笔「这个浏览器是特意留下等认领的」。
 *
 * 谁来调：所有**故意不收浏览器就走人**的路——bridge.close 的 KEEP / peersLeft>0
 * 两种，以及 cli-browser.mjs 烘热完退出时。少了这一笔，留下的浏览器在 sweepOrphans
 * 眼里就是「主人死了又没人要」的孤儿，下一个进程启动时就把它收了——KEEP 省下的
 * 冷启动、接管要保住的标签页，全在那一下没的。
 *
 * 必须同步：主调用方在 process.on("exit") 里，事件循环已经不转了。
 */
export function markAdoptable() {
  const rec = aliveBrowser();
  if (!rec) return false;
  writePid({ ...rec, adoptable: true });
  return true;
}

function dropLegacyIfOurs() {
  if (readJson(LEGACY_PID_FILE)?.profileDir !== PROFILE_DIR) return;
  try {
    fs.unlinkSync(LEGACY_PID_FILE);
  } catch {}
}

function clearPid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  dropLegacyIfOurs();
}

/*
 * 这个 pid 此刻是不是一个正跑着**本 profile** 的浏览器。
 *
 * 两道都必要：pid 会被系统复用（`kill(pid,0)` 只说明「有个进程」，不说明是哪个），
 * 而认 `--user-data-dir=<本 profile>` 才说明是「跑我们这个 profile 的」。
 * 这是所有「要不要把信号发给它」的最后一道闸——别的 profile 的浏览器命令行里写的是
 * 别的目录，过不了这一道，所以一份写错/别人的记录也带不动我们去杀它。
 */
function pidRunsThisProfile(pid, procs = null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (procs) {
    const hit = procs.find((x) => x.pid === Number(pid));
    return !!hit && hit.cmd.includes(`--user-data-dir=${PROFILE_DIR}`);
  }
  try {
    const cmd = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes(`--user-data-dir=${PROFILE_DIR}`);
  } catch {
    return false;
  }
}

/*
 * **我们给这个 profile 起的**那个浏览器还活着吗；活着就返回它的记录（pid 已核对过）。
 *
 * 用在收浏览器和报状态上，认领不走这条（认领只问 profile 目录，见 adoptRunning）。
 * 「是我们起的」这半个问题只有我们自己的记录答得出来——Chrome 不记谁把它拉起来的，
 * 所以这里仍要读记录；但**记录说的 pid 不算数**，得过下面那两道核对。
 */
export function aliveBrowser() {
  const rec = readPid();
  if (!rec?.pid) return null;
  if (rec.profileDir !== PROFILE_DIR) return null;

  const owner = profileOwnerPid();
  const pid = owner && pidRunsThisProfile(owner) ? owner : pidRunsThisProfile(rec.pid) ? rec.pid : null;
  if (!pid) return null;
  return { ...rec, pid };
}

/*
 * 谁正占着这个 profile（返回它的 pid，没人占返回 null）。
 * **Chrome 自己按 profile 记的，不是我们记的**：读 `<profile>/SingletonLock` 这个
 * 指向「主机名-pid」的符号链接。Chrome 一个 `--user-data-dir` 只准一个实例，
 * 第二个起来会输掉 ProcessSingleton 当场自杀。
 * 这里只探活，**不核对是不是我们起的**——它要回答的是「被谁占着」，答案得包括
 * 用户自己开的那种。拿它当发信号的目标时，核对由调用方补。
 */
function profileOwnerPid() {
  let target = null;
  try {
    target = fs.readlinkSync(path.join(PROFILE_DIR, "SingletonLock"));
  } catch {
    return null;
  }
  const m = /-(\d+)$/.exec(String(target));
  if (!m) return null;
  const pid = Number(m[1]);
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return pid;
}

/*
 * 认领一个已经在**这个 profile** 上跑着的浏览器。没有就返回 null（该冷启动了）。
 *
 * 输入全部来自 `<PROFILE_DIR>`：端点读 `DevToolsActivePort`、占用者 pid 读
 * `SingletonLock`（两样都是 Chrome 自己按 profile 写的），再由 verifyEndpoint 让端口
 * 本人用 GUID 确认身份。**于是「认领到别的 profile 的浏览器」从结构上不成立**。
 */
async function adoptRunning({ headless, procs = null }) {
  const owner = profileOwnerPid();
  const ep0 = readEndpoint();
  if (!owner && !ep0) return null;

  let why = null;
  const ep = ep0 ? await verifyEndpoint(ep0).catch((e) => ((why = e), null)) : null;

  if (!ep) {
    if (!owner) return null;
    if (spawnInProgress()) return null;
    throw new Error(
      `这个 profile 已经被另一个浏览器实例占着（pid=${owner}），但拿不到它的调试端点：${PROFILE_DIR}\n` +
        (why
          ? `端点这边报的是：${why.message}\n`
          : `没有 ${ACTIVE_PORT_FILE()}——它大概是没开 --remote-debugging-port 起来的。\n`) +
        "Chrome 一个 profile 只准一个实例同时跑（换 --profile-directory 也绕不过去），\n" +
        "所以现在既认领不了它、也不能另起一个。两条路：\n" +
        "  ① 给这个实例换一份自己的 profile：AGENT_IN_CHROME_PROFILE=<另一个目录>\n" +
        `  ② 先收掉占用者：${CLI_BROWSER} --stop（带上同一个 AGENT_IN_CHROME_PROFILE）。\n` +
        `     它要是说「没有在跑的浏览器」，说明 pid=${owner} 不是我们起的（比如你自己开的\n` +
        "     Chrome 指到了同一个目录），得你自己去收。\n" +
        "（多个 MCP 会话共用一个浏览器不需要这么做——它们靠 socket 主从共用同一个实例。）"
    );
  }

  const rec = readPid();
  const pid = owner || (rec?.pid && pidRunsThisProfile(rec.pid, procs) ? rec.pid : null);
  const meta = rec && rec.pid === pid ? rec : null;
  const { adopted: _drop, ...persist } = {
    ...(meta || {}),
    kind: meta?.kind || "在跑的浏览器",
    headless: meta?.headless ?? headless,
    pid,
    profileDir: PROFILE_DIR,
    managerPid: process.pid,
    adoptable: KEEP_BROWSER,
    ...ep,
  };
  writePid(persist);
  log(`复用已在跑的浏览器 pid=${pid} ${ep.version}`);
  return { ...persist, adopted: true };
}

const SPAWN_LOCK_DIR = () => path.join(PROFILE_DIR, "aic-cli-spawn.lock");
const SPAWN_LOCK_STALE_MS = 60_000;
const SPAWN_WAIT_MS = Number(process.env.AGENT_IN_CHROME_SPAWN_WAIT_MS || 45_000);

function acquireSpawnLock() {
  const dir = SPAWN_LOCK_DIR();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try {
        holder = Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim()) || null;
      } catch {}
      const holderAlive = (() => {
        if (!holder) return false;
        try {
          process.kill(holder, 0);
          return true;
        } catch {
          return false;
        }
      })();
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      const stale = (holder && !holderAlive) || ageMs > SPAWN_LOCK_STALE_MS;
      if (!stale) return false;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  return false;
}

function releaseSpawnLock() {
  try {
    fs.rmSync(SPAWN_LOCK_DIR(), { recursive: true, force: true });
  } catch {}
}

function spawnInProgress() {
  const dir = SPAWN_LOCK_DIR();
  let holder = null;
  try {
    holder = Number(fs.readFileSync(path.join(dir, "pid"), "utf8").trim()) || null;
  } catch {}
  if (holder) {
    try {
      process.kill(holder, 0);
    } catch {
      return false;
    }
  } else if (!fs.existsSync(dir)) {
    return false;
  }
  try {
    return Date.now() - fs.statSync(dir).mtimeMs <= SPAWN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/*
 * 保证有一个浏览器在跑，返回它的记录（pid / profileDir / transport / 端点或管道流）。
 * 已经在跑就复用（热启动，同时保住登录态和已打开的页面），不重开；冷启动约 1~2s。
 * 顺序是：收孤儿 → 认领已在跑的 → 抢冷启动锁 → 起新的。
 * 管道传输下没有可认领的东西（浏览器只有父进程用得上），直接冷启动。
 */
export async function ensureBrowser({ headless = HEADLESS } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const procs0 = psSnapshot();
  await sweepOrphansAsync({ excludeProfile: PROFILE_DIR, procs: procs0 });
  if (USE_PIPE) {
    if (!acquireSpawnLock()) {
      throw new Error(
        `这个 profile 上另一个进程正在起浏览器，而管道模式下它的浏览器只有它自己用得了。\n` +
          `同一个 profile 不能同时跑两个实例（Chrome 的 ProcessSingleton 不允许）。两条路：\n` +
          `  ① 给这个实例换一个 profile：AGENT_IN_CHROME_PROFILE=…\n` +
          `  ② 确实要多个进程共用一个浏览器：AGENT_IN_CHROME_KEEP=1（改走可被收养的端口模式，\n` +
          `     代价是那个端口没有访问控制，见 docs/CLI.md）`
      );
    }
    try {
      const holder = profileOwnerPid();
      if (holder && pidRunsThisProfile(holder))
        throw new Error(
          `这个 profile 已经被另一个浏览器实例占着（pid=${holder}）：${PROFILE_DIR}\n` +
            `而当前是管道传输，它的 CDP 只有起它的那个进程用得上——认领不了，也不能另起一个\n` +
            `（Chrome 一个 user-data-dir 只准一个实例，换 --profile-directory 也绕不过去）。三条路：\n` +
            `  ① 先收掉占用者：${CLI_BROWSER} --stop（带上同一个 AGENT_IN_CHROME_PROFILE）\n` +
            `  ② 给这个实例换一份自己的 profile：AGENT_IN_CHROME_PROFILE=<另一个目录>\n` +
            `  ③ 确实要多个进程共用一个浏览器：AGENT_IN_CHROME_KEEP=1（改走可被收养的端口模式，\n` +
            `     代价是那个端口没有访问控制，见 docs/CLI.md）`
        );
      return await coldStart({ headless });
    } finally {
      releaseSpawnLock();
    }
  }
  const t0 = Date.now();
  for (;;) {
    const existing = await adoptRunning({ headless, procs: Date.now() - t0 < 500 ? procs0 : null });
    if (existing) return existing;

    if (acquireSpawnLock()) {
      try {
        const again = await adoptRunning({ headless });
        if (again) return again;
        return await coldStart({ headless });
      } finally {
        releaseSpawnLock();
      }
    }

    if (Date.now() - t0 > SPAWN_WAIT_MS)
      throw new Error(
        `等了 ${Math.round((Date.now() - t0) / 1000)}s，另一个进程还在给这个 profile 起浏览器没起完` +
          `（锁：${SPAWN_LOCK_DIR()}）。它多半卡住了。两条路：\n` +
          `  ① 看它的日志：${BROWSER_LOG}\n` +
          `  ② 确认那个进程已经不在了的话，删掉锁目录再来一次。`
      );
    await new Promise((r) => setTimeout(r, 200));
  }
}

/*
 * 冷启动前把 profile 里的 variations（field trial）种子清掉，返回删掉的文件名。
 * 只动 profile 根目录下 Variations / VariationsSeedV2 / VariationsSafeSeedV2 三个文件，
 * Default/（cookie、登录态、存储）一概不碰。种子只在启动时应用一次，所以每次冷启动
 * 前删掉即可；删掉后浏览器就是「全新安装还没拉到种子」的形态，站点可见的指纹不变。
 */
export function scrubVariationsSeed(profileDir) {
  const removed = [];
  for (const f of ["Variations", "VariationsSeedV2", "VariationsSafeSeedV2"]) {
    try {
      fs.unlinkSync(path.join(profileDir, f));
      removed.push(f);
    } catch {}
  }
  if (removed.length) log(`清掉 variations 种子（field trial 会拖慢 CDP，见 scrubVariationsSeed 注释）: ${removed.join(", ")}`);
  return removed;
}

/*
 * 管道模式的「起来了没」。
 *
 * 端口模式靠 `<profile>/DevToolsActivePort` 出现来判断；管道模式没有那个文件，
 * 所以判据换成**它答不答得上话**——在 fd3 上问一句 `Browser.getVersion`。
 * 这比等文件更实在：文件只说明端口开了，回答说明 CDP 真的能用了。
 *
 * 返回的形状和 `waitForEndpoint()` 对齐（`version` 那几样），另外把两条流交出去，
 * 好让上层直接拿去建 CdpClient——管道**不能重连**，握手用的就得是同一对 fd。
 */
async function pipeEndpoint(child, { timeoutMs = PIPE_ENDPOINT_MS } = {}) {
  const wr = child.stdio[3];
  const rd = child.stdio[4];
  if (!wr?.writable || !rd?.readable)
    throw new Error("--remote-debugging-pipe 起来了但拿不到 fd3/fd4——spawn 的 stdio 配置不对（代码问题，不是环境问题）");

  const version = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) >= 0) {
        const raw = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        if (!raw) continue;
        try {
          const m = JSON.parse(raw);
          if (m.id === 1) {
            cleanup();
            return m.error ? reject(new Error(`Browser.getVersion 报错：${m.error.message}`)) : resolve(m.result || {});
          }
        } catch {}
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`浏览器在握手前就退出了，看 ${BROWSER_LOG}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等了 ${timeoutMs}ms，管道上的 Browser.getVersion 没有回音。看 ${BROWSER_LOG}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      rd.off("data", onData);
      child.off("exit", onExit);
    }
    rd.on("data", onData);
    child.on("exit", onExit);
    wr.write(JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }) + "\0");
  });

  return {
    port: null,
    wsUrl: null,
    browserGuid: null,
    version: version.product || "",
    transport: "pipe",
    pipe: { read: rd, write: wr },
  };
}

async function coldStart({ headless }) {
  const { bin, kind, stable } = findBrowser();
  try {
    fs.unlinkSync(ACTIVE_PORT_FILE());
  } catch {}
  scrubVariationsSeed(PROFILE_DIR);

  fs.mkdirSync(path.dirname(BROWSER_LOG), { recursive: true });
  rotateIfBig(BROWSER_LOG);
  const out = fs.openSync(BROWSER_LOG, "a");
  const child = USE_PIPE
    ? spawn(bin, browserArgs({ headless, bin }), { stdio: ["ignore", out, out, "pipe", "pipe"] })
    : spawn(bin, browserArgs({ headless, bin }), { stdio: ["ignore", out, out], detached: true });
  if (!USE_PIPE) child.unref();
  try {
    fs.closeSync(out);
  } catch {}

  const ep = USE_PIPE ? await pipeEndpoint(child) : await waitForEndpoint();
  if (!pidRunsThisProfile(child.pid)) {
    log(`冷启动的孩子 pid=${child.pid} 已不在（输掉了 ProcessSingleton），转认领真正的占用者`);
    const winner = await adoptRunning({ headless });
    if (winner) return winner;
    throw new Error(
      `起的浏览器 pid=${child.pid} 没活下来，而这个 profile 的调试端点却在——` +
        `多半是另一个进程抢先占了 ${PROFILE_DIR} 又立刻退了。重试一次，还不行看 ${BROWSER_LOG}。`
    );
  }
  const rec = {
    pid: child.pid,
    bin,
    kind,
    stable,
    profileDir: PROFILE_DIR,
    headless,
    startedAt: new Date().toISOString(),
    managerPid: process.pid,
    adoptable: KEEP_BROWSER,
    ...ep,
  };
  writePid(rec);
  log(`起浏览器 ${kind} pid=${child.pid} headless=${headless} ${ep.version} port=${ep.port}`);
  if (!stable)
    log(
      `注意：用的是 ${kind}，不是正式版 Chrome —— 指纹和真实用户有可见差距` +
        "（版本、userAgentData.brands）。要紧的话装个 Chrome 或用 AGENT_IN_CHROME_BIN 指过去。"
    );
  return { ...rec, adopted: false };
}

/*
 * 「这个浏览器归别人管着，我不该收」——是的话返回那个管理者的 pid，否则 null。
 *
 * 单独抽成纯函数是为了能被注入着测：真进程的生死不由测试说了算，拿真浏览器去测
 * 「该不该收」只会测出一个偶发的测试（同 waitGone 抽出来的理由）。
 */
export function stopBlockedByManager(rec, { force = false, self = process.pid, isAlive = pidAlive } = {}) {
  if (force) return null;
  const mgr = Number(rec?.managerPid);
  if (!Number.isInteger(mgr) || mgr <= 0) return null;
  if (mgr === self) return null;
  return isAlive(mgr) ? mgr : null;
}

/*
 * 收掉我们给**这个 profile** 起的浏览器（同步、发信号），返回是否真的收了一个。
 * 只认本 profile 的记录，别的会话给别的 profile 起的浏览器绝不碰；
 * **别人正管着的也不收**（记录里的 managerPid 还活着），`force` 才越过这道。
 * 端口传输整组打（渲染进程一起走），管道传输只打主进程——那条路的浏览器不是组长。
 */
export function stopBrowser({ force = false } = {}) {
  const rec = aliveBrowser();
  if (!rec) {
    clearPid();
    return false;
  }
  const mgr = stopBlockedByManager(rec, { force });
  if (mgr !== null) {
    log(`不收浏览器 pid=${rec.pid}：它归 pid=${mgr} 管，那个进程还活着`);
    return false;
  }
  const groupKill = rec.transport !== "pipe";
  try {
    if (groupKill) process.kill(-rec.pid, "SIGTERM");
    else process.kill(rec.pid, "SIGTERM");
  } catch {
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {}
  }
  clearPid();
  log(`收掉浏览器 pid=${rec.pid}`);
  return true;
}

/*
 * 优雅地收掉本 profile 的浏览器：先请它自己退（CDP `Browser.close`），
 * 不成再退回上面那个同步的信号版。走这条路刚落地的持久 cookie 才刷得下去。
 *
 * 判据是**进程真的没了**，不是命令发出去了：`Browser.close` 的回执不保证回得来
 *（浏览器开始退出时连接先断），所以 stopped 一律由「pid 真的消失了」断。
 * 连接前必须 verifyEndpoint，否则可能悄悄关掉别人的浏览器。
 *
 * @returns {{stopped:boolean, how:"graceful"|"signal"|"none", pid:number|null,
 *            fallbackReason:string|null, expected?:boolean}}
 *          expected=true 表示「这次本来就走不成优雅退出」（管道传输没有端点），不是出了错。
 */
export async function stopBrowserGracefully({ timeoutMs = 10_000, force = true } = {}) {
  const rec = aliveBrowser();
  if (!rec) {
    clearPid();
    return { stopped: false, how: "none", pid: null, fallbackReason: null, expected: false };
  }
  const pid = rec.pid;
  let fallbackReason = null;

  let expected = false;
  const ep0 = readEndpoint();
  if (rec.transport === "pipe" || !ep0?.wsUrl) {
    expected = rec.transport === "pipe" || rec.transport === undefined;
    fallbackReason = expected
      ? `这个浏览器是管道传输起的（绑在起它的进程上，不开调试端口），没有别的进程连得上的端点，` +
        `只能用信号收——不是出了错。要让 --stop 走 CDP Browser.close（刚落地的持久 cookie 才刷得下去），` +
        `用 AGENT_IN_CHROME_KEEP=1 起（改走端口模式，见 docs/CLI.md）。`
      : `记录说它是 ${rec.transport} 传输，却读不到 ${ACTIVE_PORT_FILE()}——端口文件多半被删了或 profile 被搬过。` +
        `只能退回信号收，刚落地的持久 cookie 可能没刷下去。`;
  } else {
    try {
      const ep = await verifyEndpoint(ep0);
      const { CdpClient } = await import("./client.mjs");
      const client = await new CdpClient(ep.wsUrl, { timeoutMs: Math.min(timeoutMs, 5_000) }).connect();
      try {
        await client.send("Browser.close").catch(() => {});
      } finally {
        try {
          client.close();
        } catch {}
      }
      if (!(await waitPidGoneAsync(pid, timeoutMs))) {
        clearPid();
        log(`优雅收掉浏览器 pid=${pid}（Browser.close）`);
        return { stopped: true, how: "graceful", pid, fallbackReason: null, expected: false };
      }
      fallbackReason = `发了 Browser.close，但 ${timeoutMs}ms 后 pid=${pid} 还活着`;
    } catch (e) {
      fallbackReason = String(e?.message || e);
    }
  }

  stopBrowser({ force });
  let stillAlive = await waitPidGoneAsync(pid, SWEEP_TERM_MS + SWEEP_KILL_MS);
  if (stillAlive) {
    log(`pid=${pid} 没理 SIGTERM，升级到 SIGKILL`);
    try {
      if (rec.transport !== "pipe") process.kill(-pid, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    stillAlive = await waitPidGoneAsync(pid, SWEEP_KILL_MS + 1_000);
  }
  return { stopped: !stillAlive, how: "signal", pid, fallbackReason, expected };
}

async function waitPidGoneAsync(pid, totalMs, stepMs = 50) {
  const deadline = Date.now() + totalMs;
  let ticks = 0;
  while (pidAlive(pid)) {
    if (++ticks % 10 === 0 && pidIsZombie(pid)) return false;
    if (Date.now() >= deadline) return pidIsZombie(pid) ? false : true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/*
 * 本 profile 的浏览器现状，给 --status 和诊断用：running / pid / 端点 / 记录文件位置，
 * 外加 stale（有记录但人已经不在）和 foreignRecord（记录记的是别的 profile）两个提示位。
 */
export function browserStatus() {
  const [pidFile, rec] = locatePid();
  const alive = aliveBrowser();
  return {
    running: !!alive,
    ...(rec || {}),
    endpoint: readEndpoint(),
    pidFile,
    profileDir: PROFILE_DIR,
    stale: !!rec && !alive,
    ...(rec && rec.profileDir !== PROFILE_DIR ? { foreignRecord: rec.profileDir } : {}),
  };
}
