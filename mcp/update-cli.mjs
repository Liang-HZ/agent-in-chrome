/*
 * `agent-in-chrome check` 的版本行 与 `agent-in-chrome update` 子命令。
 *
 * 取版本（fetcher）和起子进程（exec）两件事都做成可注入的参数，整条路因此能零浏览器、
 * 零网络地跑测试；bin/agent-in-chrome.mjs 只负责解析 argv 和把真实实现塞进来。
 *
 * `update` 内部一律用**精确版本号**下发，不是 `@latest`：日志和报错里能直接看到「装的
 * 到底是哪一版」，且「查到的版本」和「装下去的版本」保证是同一个值，中间不会错位。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import { BIN, PKG, cleanVersion, fetchLatest, isNewer } from "./update-notice.mjs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/*
 * check / update 查 registry 的超时。比后台提示那条路宽得多：这两条路上**是人在终端里
 * 等结果**，等 2s 拿一句「未能联网」比等 8s 拿到答案糟得多；而后台那条路的硬约束是
 * 「绝不让工具调用等」，两者预算本来就不该一样。10s 是给公司代理 / 弱网留的余量。
 */
const CLI_TIMEOUT_MS = 10_000;

/*
 * 查一次最新版，失败重试一次；查不出来返回 null。
 * 重试守的是弱网 / 公司代理 / registry 限流这类瞬时故障——对人在等的这条路，一次重试
 * 就能把抖动吃掉；后台提示那条路不重试（多等一轮不值得，反正下次进程还会再查）。
 */
async function fetchWithRetry(fetcher) {
  for (let i = 0; i < 2; i++) {
    try {
      const v = cleanVersion(await fetcher());
      if (v) return v;
    } catch {
    }
  }
  return null;
}

/*
 * 起子进程的默认实现。**不走 shell**：版本号虽然已经被 cleanVersion 洗成三段数字，
 * 但 --agents= 的值是用户给的，走 shell 就多一个注入面，没必要。
 *
 * cwd 一律用系统临时目录：`npm exec` 会先看当前目录的 node_modules，在
 * agent-in-chrome 的 git 检出里跑 update 会解析到**本地那一份**，于是「升级」变成
 * 「又跑了一遍手头这版的安装器」，还不报错。放到临时目录就只剩 --package 那一条路。
 */
async function defaultExec({ cmd, args, capture = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: os.tmpdir(),
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e?.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr?.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e?.message || e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/*
 * 拼 `npm exec` 的参数。抽出来是为了让测试能逐字断言「下发的到底是不是精确版本号」。
 * @param {string} version 已经 cleanVersion 过的 x.y.z
 * @param {string[]} passthrough 透传给安装器的旗标
 */
export function execArgs(version, passthrough = []) {
  return ["exec", "--yes", `--package=${PKG}@${version}`, "--", BIN, "install", ...passthrough];
}

/* 只把认识的旗标透传给新版安装器；其余（含 --version 这类）不带过去 */
export function passthroughFlags(argv = []) {
  const out = [];
  for (const a of argv) {
    if (a === "--yes" || a === "-y" || a === "--no-agents") out.push(a);
    else if (a.startsWith("--agents=")) out.push(a);
  }
  return out;
}

/*
 * `check` 末尾那一行：本机 vX · npm 最新 vY · 有/无新版。
 *
 * 离线**不算失败**：check 的退出码是「本机装好没有」，跟「能不能连上 npm」无关。
 * 断网的机器上自检照样该给 0，所以这里最坏也只是打一句「未能联网检查」。
 */
export async function printVersionLine({ current, fetcher = () => fetchLatest({ timeoutMs: CLI_TIMEOUT_MS }), log = console.log } = {}) {
  const latest = await fetchWithRetry(fetcher);
  if (!latest) {
    log(`版本：本机 v${current} · npm 最新 未能联网检查`);
    return { current, latest: null, hasUpdate: false };
  }
  const hasUpdate = isNewer(latest, current);
  log(
    `版本：本机 v${current} · npm 最新 v${latest} · ` +
      (hasUpdate ? `有新版，升级跑 npx ${PKG}@latest update` : "已是最新")
  );
  return { current, latest, hasUpdate };
}

/*
 * `update` 子命令。返回退出码。
 *
 * @param {object} opts
 * @param {string} opts.current 本机版本
 * @param {string[]} [opts.argv] update 后面跟的旗标（--yes / --agents= / --no-agents）
 * @param {()=>Promise<string|null>} [opts.fetcher] 取最新版（测试注入点）
 * @param {(o:object)=>Promise<{code:number,stdout:string,stderr:string}>} [opts.exec] 起子进程（测试注入点）
 * @param {(s:string)=>void} [opts.log] stdout
 * @param {(s:string)=>void} [opts.errLog] stderr
 */
export async function runUpdate({
  current,
  argv = [],
  fetcher = () => fetchLatest({ timeoutMs: CLI_TIMEOUT_MS }),
  exec = defaultExec,
  log = console.log,
  errLog = console.error,
} = {}) {
  const latest = await fetchWithRetry(fetcher);

  if (!latest) {
    log(`未能联网查询 npm 最新版本（本机 v${current}）。`);
    log(`网络恢复后再跑一次；也可以直接指定版本：npx ${PKG}@<版本号> install`);
    return 0;
  }

  if (!isNewer(latest, current)) {
    log(`已是最新：本机 v${current}，npm 最新 v${latest}。`);
    return 0;
  }

  const passthrough = passthroughFlags(argv);
  log(`发现新版 v${latest}（本机 v${current}），开始升级……`);
  log(`  ${NPM} ${execArgs(latest, passthrough).join(" ")}`);

  const r = await exec({ cmd: NPM, args: execArgs(latest, passthrough) });
  if (r.code !== 0) {
    errLog(`升级失败：安装器退出码 ${r.code}。`);
    if (r.stderr) errLog(String(r.stderr).trimEnd());
    errLog(`可以手动重试：${NPM} ${execArgs(latest, passthrough).join(" ")}`);
    return r.code || 1;
  }

  const v = await exec({ cmd: NPM, args: ["exec", "--yes", `--package=${PKG}@${latest}`, "--", BIN, "--version"], capture: true });
  const got = cleanVersion(String(v.stdout || "").trim().split("\n").pop());
  if (v.code !== 0 || got !== latest) {
    errLog(`升级已执行，但核对版本没对上：期望 v${latest}，实际拿到 ${got ? "v" + got : "（读不出来）"}。`);
    errLog(`跑 npx ${PKG}@latest check 看一眼实际状态。`);
    return 1;
  }

  log(`已升级到 v${latest}。`);
  log("扩展侧：商店安装的会自动更新；手动「加载已解压」的，去 chrome://extensions 点一下刷新（路径见上面安装器的输出）。");
  return 0;
}
