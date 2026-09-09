#!/usr/bin/env node
// 安装 / 卸载 / 自检
//
//   node scripts/install.mjs            装（npx @liang-hz/agent-in-chrome install 等价）
//   node scripts/install.mjs --check    只检查，不改任何东西
//   node scripts/install.mjs --uninstall 卸
//
// 会动的东西只有三处，全部可逆：
//   1. 各 Chromium 浏览器的 NativeMessagingHosts/org.liangai.agent_in_chrome.json  （新增文件）
//   2. 本机各 agent（Claude Code / Claude Desktop / WorkBuddy / ZCode / opencode / Kimi /
//      Gemini / Antigravity / Trae / Qoder / Codex）的 MCP 配置里
//      mcpServers["agent-in-chrome"] 这一个键（改前自动备份，详见 scripts/agents.mjs）
//   3. ~/.agent-in-chrome/skills/{agent-in-chrome,install-agent-in-chrome}/ 与
//      ~/.agent-in-chrome/commands/{agent-in-chrome,install-agent-in-chrome}.md（新增文件）
//
// 本文件同时被 bin/agent-in-chrome.mjs（npx 入口）import：主流程包在 run(mode, opts)
// 里导出，直接 node 跑本文件时走文件末尾的主守卫，两个入口行为一致。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getToken, tokenPath, ensureDataDir, permStatus, bridgeEndpoint } from "../mcp/token.mjs";
import { runAgents, buildAgents, agentProblemCount } from "./agents.mjs";
import { orphansFrom, pidAlive, readProfileRecord, stopBrowser } from "../mcp/cdp/browser-launch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const HOST_NAME = "org.liangai.agent_in_chrome";
const MCP_NAME = "agent-in-chrome";
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;

let MODE = "install";

// 默认走「加载已解压」——改完代码点一下刷新就生效，不用重新打包。
// --with-crx 才会把签名 CRX 写进 Chrome 的 External Extensions 目录自动装载；
// 「往浏览器里自动装扩展」是恶意软件的典型手法，所以做成显式选项而不是默认。
let WITH_CRX = false;

const EXT_IDS = fs
  .readFileSync(path.join(ROOT, ".ext-id.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const EXT_ID = EXT_IDS[0];
const DATA_DIR = path.join(HOME, ".agent-in-chrome");

const RUNTIME_DIR = path.join(DATA_DIR, "agent-in-chrome");
const HOST_SRC = path.join(ROOT, "native-host", "host.mjs");
const FG_SWIFT_SRC = path.join(ROOT, "native-host", "mac-foreground", "aic-fg.swift");
const SERVER_SRC = path.join(ROOT, "mcp", "server.mjs");
const HOST_PATH = path.join(RUNTIME_DIR, "host.mjs");
const SERVER_PATH = path.join(RUNTIME_DIR, "server.mjs");
const MCP_DIR = path.join(ROOT, "mcp");
function scanDeps(entryAbs, out = new Set()) {
  let src;
  try {
    src = fs.readFileSync(entryAbs, "utf8");
  } catch {
    return out;
  }
  const specs = [
    ...src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    const abs = path.resolve(path.dirname(entryAbs), spec);
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(MCP_DIR, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (out.has(rel)) continue;
    out.add(rel);
    scanDeps(abs, out);
  }
  return out;
}
const SERVER_DEPS = [...scanDeps(SERVER_SRC, scanDeps(HOST_SRC))].sort();
const EXT_FILES = ["sw.js", "manifest.json"];
const EXT_STABLE_DIR = path.join(DATA_DIR, "extension");
const IS_GIT_CHECKOUT = fs.existsSync(path.join(ROOT, ".git"));
const REINSTALL_CMD = IS_GIT_CHECKOUT ? "node scripts/install.mjs" : `npx ${PKG_NAME}@latest install`;
const WIN = process.platform === "win32";
const LAUNCHER = path.join(RUNTIME_DIR, WIN ? "native-host-launcher.bat" : "native-host-launcher.sh");
const MCP_LAUNCHER = path.join(RUNTIME_DIR, WIN ? "mcp-launcher.bat" : "mcp-launcher.sh");
const WIN_HOST_MANIFEST = path.join(RUNTIME_DIR, `${HOST_NAME}.json`);

const RUNTIME_KEEP_DIRS = new Set(["cli-profile"]);

function smokeTestRuntime() {
  const srcVersion = /const VERSION = "([^"]+)"/.exec(fs.readFileSync(SERVER_SRC, "utf8"))?.[1];
  const req =
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
    "\n";
  const smokeSock = path.join(os.tmpdir(), `aic-check-${process.pid}.sock`);
  let out;
  const opts = {
    input: req,
    encoding: "utf8",
    timeout: 20000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_IN_CHROME_SOCK: smokeSock },
  };
  try {
    out = WIN ? runBat(MCP_LAUNCHER, [], opts) : execFileSync(MCP_LAUNCHER, [], opts);
  } catch (e) {
    const why = String(e.stderr || e.message || "").trim().split("\n").slice(0, 3).join(" ").slice(0, 240);
    return bad(
      `装好的 MCP server 起不来：${why}\n    → 跑 ${REINSTALL_CMD} 重装；agent 那边看到的会是一句 Connection closed` +
        (WIN ? `\n    （这条是连着启动器一起验的：${path.basename(MCP_LAUNCHER)} 本身被 cmd 读坏时也会报在这里）` : "")
    );
  }
  const msgs = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  try {
    fs.unlinkSync(smokeSock);
  } catch {}
  const init = msgs.find((m) => m.id === 1)?.result;
  const tools = msgs.find((m) => m.id === 2)?.result?.tools;
  if (!init) return bad("装好的 MCP server 没能完成 initialize 握手，重装试试");
  if (!tools?.length) return bad("装好的 MCP server 一个工具都没列出来，重装试试");
  if (srcVersion && init.serverInfo?.version !== srcVersion) {
    return warn(
      `装的是 v${init.serverInfo?.version}，${IS_GIT_CHECKOUT ? "仓库里" : "这个包"}是 v${srcVersion} —— 没重装，agent 用的还是旧代码。跑 ${REINSTALL_CMD}`
    );
  }
  ok(`装好的 MCP server 真的起得来（v${init.serverInfo?.version}，${tools.length} 个工具）`);
}

export function procSnapshot() {
  if (WIN) {
    const tmp = path.join(os.tmpdir(), `aic-ps-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const script = `
$ProgressPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Property ProcessId,CommandLine | ForEach-Object {
  if ($_.CommandLine) { $_.ProcessId.ToString() + "\`t" + ($_.CommandLine -replace "[\`r\`n]", " ") }
} | Out-File -FilePath ${JSON.stringify(tmp)} -Encoding utf8`;
    try {
      execFileSync(
        path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }
      );
      const procs = fs
        .readFileSync(tmp, "utf8")
        .replace(/^﻿/, "")
        .split("\n")
        .map((l) => /^(\d+)\t(.*)$/.exec(l.trim()))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
      return { procs, err: null };
    } catch (e) {
      return { procs: null, err: String(e?.message || e).split("\n")[0].slice(0, 120) };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  try {
    const out = execFileSync("/bin/ps", ["-eo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 << 20 });
    return {
      procs: out
        .split("\n")
        .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), cmd: m[2] })),
      err: null,
    };
  } catch (e) {
    return { procs: null, err: String(e?.message || e).split("\n")[0].slice(0, 120) };
  }
}

export function strayStatus({ procs, err }, isAlive = pidAlive) {
  if (!procs) return { kind: "unavailable", err, pids: [] };
  const readRecord = (dir) => readProfileRecord(String(dir).replace(/^"|"$/g, ""));
  const pids = orphansFrom(procs, isAlive, { readRecord });
  return { kind: pids.length ? "stray" : "clean", err: null, pids };
}

export function probeBridgeOwner(endpoint, ms = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const c = net.connect(endpoint);
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        c.destroy();
      } catch {}
      resolve(v);
    };
    const t = setTimeout(() => finish("legacy"), ms);
    t.unref?.();
    c.setEncoding("utf8");
    c.on("data", (d) => {
      clearTimeout(t);
      finish(/"type"\s*:\s*"challenge"/.test(d) ? "modern" : "legacy");
    });
    c.on("error", () => {
      clearTimeout(t);
      finish("free");
    });
    c.on("close", () => {
      clearTimeout(t);
      finish("free");
    });
  });
}

export function serverProcs({ procs, err }, serverPath = SERVER_PATH) {
  if (!procs) return { kind: "unavailable", err, procs: [] };
  const norm = (x) => String(x || "").toLowerCase().split("/").join("\\");
  const needles = [norm(serverPath), "\\mcp\\server.mjs", "\\agent-in-chrome\\server.mjs"];
  const hit = procs.filter((p) => {
    const c = norm(p.cmd);
    return needles.some((n) => c.includes(n));
  });
  return { kind: hit.length ? "found" : "none", err: null, procs: hit };
}

async function bridgeState() {
  const endpoint = bridgeEndpoint(path.join(DATA_DIR, "agent-in-chrome.sock"));
  const owner = await probeBridgeOwner(endpoint);
  return { endpoint, owner, stale: owner === "legacy" ? serverProcs(procSnapshot()) : null };
}

function reportBridge({ owner, stale }) {
  if (owner === "free") return skip("未建立 —— agent 没在跑，或 MCP server 没起来");
  if (owner === "modern") return ok("已建立，且对面走的是本版握手（agent 侧的 MCP server 在跑）");

  const hasPids = !!stale && stale.kind === "found" && stale.procs.length > 0;
  const who =
    !stale || stale.kind === "unavailable"
      ? "\n    （进程表查不了，请自己在任务管理器里找 node.exe）"
      : hasPids
        ? "\n    本机在跑的我们的 server：" +
          stale.procs.map((p) => "pid " + p.pid).join("、") +
          "（占着端点的是其中之一——零依赖下拿不到管道属主的 pid，只能把在跑的都列出来）"
        : "\n    进程表里没认出我们自己的 server —— 可能它是从别处跑起来的，也可能是别的程序占着这个端点名";
  const why = WIN
    ? "这条桥现在是**不通**的：本版拨号方在管道上等不到出题就一个字节都不发（fail-closed，令牌不会泄露，但也连不上）。"
    : "unix socket 上本版会退回老握手，所以还能用；但两边版本不一致，建议一并升上来。";
  (WIN ? bad : warn)(
    "端点有人占着，但对面不出题 —— 多半是升级前就在跑的旧版 MCP server。\n    " +
      why +
      who +
      "\n    修：先把还开着的 agent 客户端里的 MCP 重连一次（Claude Code / WorkBuddy 跑 /mcp）；" +
      (hasPids
        ? "\n    重连仍不通，再从上面那些进程里挑着结束 —— 客户端下次用到时会自己重起新版。"
        : "\n    仍不通的话，在任务管理器里找占着这个端点的 node.exe 结束掉。")
  );
}

function checkStrayBrowsers() {
  const st = strayStatus(procSnapshot());
  if (st.kind === "unavailable")
    return warn(`查不了本机进程表（${st.err}），这条没法判：残留的自启浏览器要靠你自己看`);
  if (st.kind === "clean") return ok("没有残留的自启浏览器");
  warn(
    `发现 ${st.pids.length} 个残留的浏览器进程（pid ${st.pids.join(", ")}）：它们是本工具起的，` +
      `主人已经退出但没收干净。\n    它们用的是你自己那个浏览器——` +
      (WIN
        ? `你可能会看到「Chrome 已在运行」、点图标没反应。\n    收掉：taskkill /PID ${st.pids.join(" /PID ")} /F`
        : `macOS 只认 app bundle，会因此认为「Chrome 已在运行」，你点 Dock 图标可能什么都不会发生。\n    收掉：kill ${st.pids.join(" ")}`)
  );
}

/*
 * 原子替换：拷到**同目录**的临时名，再 rename 盖上去。三件事都靠它——
 *   不存在「文件缺失」的窗口：正在并发拉起 host/server 的 Chrome 或 agent 客户端
 *   不会撞见 ENOENT（升级恰好发生在拉起的那一刻，是最常见也最难复现的失败）；
 *   正在跑的旧进程继续用旧 inode，内核层面互不干扰——它们的 import 缓存和文件
 *   映射都指向被替换掉的那个 inode，不会读到半截新文件；
 *   也从不「原地截断重写」一个可能正被读取或执行的文件。
 * 同目录是硬要求：跨设备的 rename 会 EXDEV，而 os.tmpdir() 在很多机器上是另一个卷。
 */
function replaceAtomically(from, to, mode = 0o644) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.incoming-${process.pid}`;
  fs.copyFileSync(from, tmp);
  if (!WIN) fs.chmodSync(tmp, mode);
  try {
    fs.renameSync(tmp, to);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function runtimeManifest() {
  return [
    ["host.mjs", HOST_SRC, 0o755],
    ["server.mjs", SERVER_SRC, 0o755],
    ...SERVER_DEPS.map((d) => [d, path.join(ROOT, "mcp", d), 0o644]),
    ...EXT_FILES.map((f) => [path.join("extension", f), path.join(ROOT, "extension", f), 0o644]),
    ...(process.platform === "darwin" ? [[path.join("mac-foreground", "aic-fg.swift"), FG_SWIFT_SRC, 0o644]] : []),
  ];
}

function sweepRuntime(keep) {
  const removed = [];
  const owned = (rel, name) =>
    name.endsWith(".mjs") ||
    /\.incoming-\d+$/.test(name) ||
    rel.split(path.sep)[0] === "extension";
  const walk = (dir, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const child = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (RUNTIME_KEEP_DIRS.has(childRel)) continue;
        walk(child, childRel);
        continue;
      }
      if (!e.isFile() || !owned(childRel, e.name)) continue;
      if (keep.has(childRel)) continue;
      try {
        fs.unlinkSync(child);
        removed.push(childRel);
      } catch {}
    }
  };
  walk(RUNTIME_DIR, "");
  return removed;
}

function syncRuntime() {
  ensureDataDir(DATA_DIR);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const manifest = runtimeManifest();
  for (const [rel, src, mode] of manifest) replaceAtomically(src, path.join(RUNTIME_DIR, rel), mode);
  if (!IS_GIT_CHECKOUT) {
    fs.rmSync(EXT_STABLE_DIR, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "extension"), EXT_STABLE_DIR, { recursive: true });
  }
  return sweepRuntime(new Set(manifest.map(([rel]) => rel)));
}

// Chrome 和 agent 桌面端都是 GUI 应用，PATH 里没有 nvm / homebrew 的 node——
// `#!/usr/bin/env node` 在它们手里必然 ENOENT。所以到处都必须写绝对路径。
// 用跑安装脚本的这个 node（process.execPath 是绝对路径），不依赖调用方的 PATH。
function resolveRuntime() {
  return { command: process.execPath, env: {}, label: `系统 node (${process.execPath})` };
}
const RUNTIME = resolveRuntime();

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[90m·\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
let problems = 0;
const bad = (s) => {
  problems++;
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
};

const LEFTOVERS = [];

function step(what, fn) {
  try {
    return fn();
  } catch (e) {
    stepFailed(what, e);
    return undefined;
  }
}

async function stepAsync(what, fn) {
  try {
    return await fn();
  } catch (e) {
    stepFailed(what, e);
    return undefined;
  }
}

function stepFailed(what, e) {
  const why = String(e?.code || e?.message || e).slice(0, 160);
  bad(`${what} 失败：${why}（其余步骤照常继续）`);
  LEFTOVERS.push({ what, why });
}

function removeTree(target) {
  const failed = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch (e) {
        failed.push([p, e.code || e.message]);
        return;
      }
      for (const e of entries) walk(path.join(p, e));
    }
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {
      failed.push([p, e.code || e.message]);
    }
  };
  walk(target);
  return failed;
}

function removeAndReport(label, target, hint = "") {
  if (!fs.existsSync(target)) return skip(`${label}: 本来就没有`);
  const failed = removeTree(target);
  if (!failed.length) return ok(`${label}已移除 ${target}`);
  const [first, code] = failed[0];
  bad(
    `${label}没能全部移除（${failed.length} 项没删掉，第一个：${first} — ${code}）` +
      (hint ? `\n    ${hint}` : "")
  );
  LEFTOVERS.push({ what: label, why: `${failed.length} 项残留于 ${target}`, hint });
}

function browserCandidates() {
  const mac = path.join(HOME, "Library", "Application Support");
  const lin = path.join(HOME, ".config");
  const candidates =
    process.platform === "darwin"
      ? [
          ["Chrome", path.join(mac, "Google/Chrome")],
          ["Chrome Beta", path.join(mac, "Google/Chrome Beta")],
          ["Chrome Canary", path.join(mac, "Google/Chrome Canary")],
          ["Chromium", path.join(mac, "Chromium")],
          ["Edge", path.join(mac, "Microsoft Edge")],
          ["Brave", path.join(mac, "BraveSoftware/Brave-Browser")],
          ["Vivaldi", path.join(mac, "Vivaldi")],
          ["Opera", path.join(mac, "com.operasoftware.Opera")],
          ["Arc", path.join(mac, "Arc/User Data")],
        ]
      : [
          ["Chrome", path.join(lin, "google-chrome")],
          ["Chromium", path.join(lin, "chromium")],
          ["Edge", path.join(lin, "microsoft-edge")],
          ["Brave", path.join(lin, "BraveSoftware/Brave-Browser")],
          ["Vivaldi", path.join(lin, "vivaldi")],
        ];
  return candidates;
}

function browserDirs() {
  return browserCandidates()
    .filter(([, base]) => fs.existsSync(base))
    .map(([name, base]) => [name, path.join(base, "NativeMessagingHosts")]);
}

function hostManifest() {
  return {
    name: HOST_NAME,
    description: "Agent in Chrome native host",
    path: LAUNCHER,
    type: "stdio",
    allowed_origins: EXT_IDS.map((id) => `chrome-extension://${id}/`),
  };
}

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const REG_ROOT = (() => {
  const v = process.env.AGENT_IN_CHROME_REG_ROOT;
  if (!v) return "HKCU\\Software";
  if (!/^HKCU\\Software\\[A-Za-z0-9_-]{1,64}$/.test(v))
    throw new Error(
      `AGENT_IN_CHROME_REG_ROOT=${JSON.stringify(v)} 不合法（只接受 HKCU\\Software\\<单层名>）。` +
        `拒绝继续：回落到真实注册表根会改掉你当前生效的安装。`
    );
  return v;
})();
function winBrowserKeys() {
  const candidates = [
    ["Chrome", `${REG_ROOT}\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, path.join(LOCALAPPDATA, "Google", "Chrome", "User Data")],
    ["Edge", `${REG_ROOT}\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`, path.join(LOCALAPPDATA, "Microsoft", "Edge", "User Data")],
    ["Brave", `${REG_ROOT}\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`, path.join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data")],
    ["Vivaldi", `${REG_ROOT}\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`, path.join(LOCALAPPDATA, "Vivaldi", "User Data")],
    ["Chromium", `${REG_ROOT}\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`, path.join(LOCALAPPDATA, "Chromium", "User Data")],
  ];
  return candidates.filter(([, , userData]) => fs.existsSync(userData)).map(([name, key]) => [name, key]);
}

const REG_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");

export function parseRegExport(text) {
  const sz = /^@="((?:[^"\\]|\\.)*)"/m.exec(text || "");
  if (sz) return sz[1].replace(/\\(.)/g, "$1");
  const hex = /^@=hex\((?:1|2)\):((?:[0-9a-fA-F,\s\\])+)/m.exec(text || "");
  if (hex) {
    const bytes = hex[1]
      .replace(/[\s\\]/g, "")
      .split(",")
      .filter((b) => b)
      .map((b) => parseInt(b, 16));
    return Buffer.from(bytes).toString("utf16le").replace(/\0+$/, "");
  }
  return null;
}

function regQueryDefault(key) {
  const tmp = path.join(os.tmpdir(), `aic-reg-${process.pid}-${Math.random().toString(36).slice(2)}.reg`);
  try {
    execFileSync(REG_EXE, ["export", key, tmp, "/y"], { stdio: "pipe" });
    return parseRegExport(fs.readFileSync(tmp, "utf16le"));
  } catch {
    try {
      const out = execFileSync(REG_EXE, ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const m = /REG_SZ\s+(.+)$/m.exec(out);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function regSetDefault(key, value) {
  execFileSync(REG_EXE, ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "pipe" });
}

function regDeleteKey(key) {
  try {
    execFileSync(REG_EXE, ["delete", key, "/f"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function doHostsWin() {
  const body = JSON.stringify(hostManifest(), null, 2) + "\n";
  if (MODE === "install") fs.writeFileSync(WIN_HOST_MANIFEST, body);
  else if (MODE === "check") {
    if (!fs.existsSync(WIN_HOST_MANIFEST)) bad(`host manifest 不存在（${WIN_HOST_MANIFEST}），请重新安装`);
    else {
      const cur = JSON.parse(fs.readFileSync(WIN_HOST_MANIFEST, "utf8"));
      if (cur.path !== LAUNCHER) warn(`host manifest 指向 ${cur.path}，应为 ${LAUNCHER}，重装可修`);
      else if (!EXT_IDS.every((id) => cur.allowed_origins?.includes(`chrome-extension://${id}/`)))
        warn("host manifest 的扩展 ID 清单不全，重新安装可修");
      else ok(`host manifest: ${WIN_HOST_MANIFEST}`);
    }
  }

  const keys = winBrowserKeys();
  if (keys.length === 0) {
    bad("没找到任何 Chromium 系浏览器的用户数据目录");
    return;
  }
  for (const [name, key] of keys) {
    if (MODE === "check") {
      const cur = regQueryDefault(key);
      if (cur === null) bad(`${name}: 注册表未登记`);
      else if (cur !== WIN_HOST_MANIFEST) warn(`${name}: 已登记但指向 ${cur}，重装可修`);
      else ok(`${name}: 注册表已登记`);
      continue;
    }
    if (MODE === "uninstall") {
      regDeleteKey(key) ? ok(`${name}: 注册表键已删除`) : skip(`${name}: 本来就没有`);
      continue;
    }
    regSetDefault(key, WIN_HOST_MANIFEST);
    ok(`${name}: ${key} → ${WIN_HOST_MANIFEST}`);
  }
}

export function winLauncherBody(script) {
  const envLines = Object.entries(RUNTIME.env)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join("\r\n");
  return (
    `@echo off\r\n` +
    `chcp 65001 >nul\r\n` +
    `rem Generated by scripts/install.mjs. Do not edit (reinstall overwrites).\r\n` +
    `rem chcp 65001 is required: cmd reads this file in the OEM code page,\r\n` +
    `rem and a non-ASCII path (e.g. a Chinese user name) would be mangled.\r\n` +
    (envLines ? envLines + "\r\n" : "") +
    `"${RUNTIME.command}" "${script}" %*\r\n`
  );
}

const SYSTEM32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const CMD_EXE = process.env.ComSpec || path.join(SYSTEM32, "cmd.exe");

function consoleCp() {
  try {
    const out = execFileSync(path.join(SYSTEM32, "chcp.com"), [], { encoding: "latin1", stdio: ["ignore", "pipe", "pipe"] });
    const n = Number(/(\d{3,5})/.exec(out)?.[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function runBat(bat, args = [], opts = {}) {
  const line = `/d /s /c ""${bat}"${args.map((a) => ` "${a}"`).join("")}"`;
  const cp = consoleCp();
  try {
    return execFileSync(CMD_EXE, [line], { windowsVerbatimArguments: true, ...opts });
  } finally {
    if (cp && cp !== consoleCp()) {
      try {
        execFileSync(path.join(SYSTEM32, "chcp.com"), [String(cp)], { stdio: "ignore" });
      } catch {}
    }
  }
}

function writeLauncher(dest, script, note) {
  if (WIN) {
    fs.writeFileSync(dest, winLauncherBody(script));
    return;
  }
  const envLines = Object.entries(RUNTIME.env)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n");
  const body = `#!/bin/sh
# 由 scripts/install.mjs 生成，请勿手改（重装会覆盖）。
# ${note}
${envLines}
exec ${shq(RUNTIME.command)} ${shq(script)} "$@"
`;
  fs.writeFileSync(dest, body);
  fs.chmodSync(dest, 0o755);
}

async function doForegroundHelper() {
  const outDir = path.join(RUNTIME_DIR, "mac-foreground");
  const bin = path.join(outDir, "aic-fg");
  if (process.platform !== "darwin") return skip("前台归还 helper：只在 macOS 上有意义");
  if (MODE === "uninstall") {
    if (fs.existsSync(outDir)) removeAndReport("前台归还 helper", outDir);
    else skip("前台归还 helper：本来就没有");
    return;
  }
  if (MODE === "check") {
    if (fs.existsSync(bin)) ok(`前台归还 helper: ${bin}`);
    else warn("前台归还 helper 没编出来（没装 Xcode CLT？）——自开新页抢前台时走 open -b 兜底，慢一点但能用");
    return;
  }
  const { buildForegroundHelper } = await import(
    pathToFileURL(path.join(ROOT, "native-host", "mac-foreground", "build.mjs")).href
  );
  const r = buildForegroundHelper(outDir);
  if (r.ok) ok(`前台归还 helper 已编译: ${r.out}`);
  else warn(`前台归还 helper 未编译（${r.why}）——自开新页抢前台时走 open -b 兜底`);
}

function doHosts() {
  if (MODE === "install") {
    const swept = syncRuntime();
    ok(`运行时已同步到 ${RUNTIME_DIR}（避开 ~/Documents 的 TCC 限制）`);
    if (swept.length) ok(`清掉运行时里已不在清单中的旧文件：${swept.join("、")}`);
    writeLauncher(
      LAUNCHER,
      HOST_PATH,
      "Chrome 以 GUI 应用身份拉起 native host，PATH 里没有 nvm/homebrew，必须写绝对路径。"
    );
    ok(`启动器: ${LAUNCHER} → ${RUNTIME.label}`);
  } else if (MODE === "check") {
    if (!fs.existsSync(LAUNCHER)) bad(`启动器 ${path.basename(LAUNCHER)} 不存在，请重新安装`);
    else if (!WIN && !(fs.statSync(LAUNCHER).mode & 0o111)) bad("启动器没有可执行位");
    else {
      ok(`启动器: ${LAUNCHER}`);
      if (WIN && fs.readFileSync(LAUNCHER, "utf8") !== winLauncherBody(HOST_PATH))
        warn(`启动器是旧版本生成的（内容和现在会生成的不一致），跑一次 ${REINSTALL_CMD} 覆盖掉它`);
    }
  } else if (MODE === "uninstall") {
    step("收掉自启的浏览器", () => {
      if (stopBrowser({ force: true })) ok("已收掉本工具自启的浏览器（好让它的 profile 能删）");
    });
    removeAndReport(
      "运行时目录",
      RUNTIME_DIR,
      "多半是浏览器还开着锁住了 cli-profile：关掉它再跑一次卸载，或手动删这个目录。"
    );
  }

  if (WIN) return doHostsWin();

  const dirs = browserDirs();
  if (dirs.length === 0) {
    bad(
      `没找到任何 Chromium 系浏览器的配置目录（找过：${browserCandidates().map(([n]) => n).join("、")}）\n` +
        `    → 装了 Chrome 但从没打开过？先启动一次让它建出 profile，再重跑一遍安装器。\n` +
        `    → 机器上确实没有桌面浏览器：插件模式用不上，改走 CLI 模式（AGENT_IN_CHROME_LAUNCH=1，见 docs/CLI.md）。`
    );
    return;
  }
  const body = JSON.stringify(hostManifest(), null, 2) + "\n";
  for (const [name, dir] of dirs) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    if (MODE === "check") {
      if (!fs.existsSync(file)) {
        bad(`${name}: 未安装`);
      } else {
        const cur = JSON.parse(fs.readFileSync(file, "utf8"));
        if (cur.path !== LAUNCHER) warn(`${name}: 已安装但指向 ${cur.path}`);
        else if (!EXT_IDS.every((id) => cur.allowed_origins?.includes(`chrome-extension://${id}/`)))
          warn(`${name}: 已安装但扩展 ID 清单不全，重新安装可修`);
        else ok(`${name}: 已安装`);
      }
      continue;
    }
    if (MODE === "uninstall") {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        ok(`${name}: 已移除`);
      } else skip(`${name}: 本来就没有`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    ok(`${name}: ${file}`);
  }
}

const CHROME_BASE =
  process.platform === "darwin"
    ? path.join(HOME, "Library", "Application Support", "Google", "Chrome")
    : WIN
      ? path.join(LOCALAPPDATA, "Google", "Chrome", "User Data")
      : path.join(HOME, ".config", "google-chrome");
const EXT_EXT_DIR = path.join(CHROME_BASE, "External Extensions");
const CRX_SRC = path.join(ROOT, "dist", "agent-in-chrome.crx");
const CRX_DST = path.join(EXT_EXT_DIR, "agent-in-chrome.crx");
const CRX_JSON = path.join(EXT_EXT_DIR, `${EXT_ID}.json`);

function extVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;
}

function extensionLoadedIn() {
  if (!fs.existsSync(CHROME_BASE)) return null;
  for (const p of fs.readdirSync(CHROME_BASE)) {
    const dir = path.join(CHROME_BASE, p);
    if (!fs.existsSync(path.join(dir, "Preferences")) && !fs.existsSync(path.join(dir, "Secure Preferences")))
      continue;
    for (const id of EXT_IDS) {
      if (fs.existsSync(path.join(dir, "Extensions", id))) return { profile: p, how: "打包安装" };
    }
    for (const f of ["Secure Preferences", "Preferences"]) {
      const file = path.join(dir, f);
      if (!fs.existsSync(file)) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(file, "utf8"))?.extensions?.settings;
        for (const id of EXT_IDS) {
          const s = settings?.[id];
          if (s) return { profile: p, how: s.location === 4 ? "加载已解压" : `location=${s.location}` };
        }
      } catch {}
    }
  }
  return null;
}

function doCrx() {
  if (!fs.existsSync(CHROME_BASE)) {
    skip("没找到 Chrome，跳过扩展自动安装");
    return;
  }

  if (MODE === "check") {
    if (!fs.existsSync(CRX_JSON)) return bad("External Extensions 清单未安装");
    if (!fs.existsSync(CRX_DST)) return bad("CRX 文件不在位");
    const cur = JSON.parse(fs.readFileSync(CRX_JSON, "utf8"));
    if (cur.external_version !== extVersion())
      return warn(`已安装 v${cur.external_version}，但源码是 v${extVersion()}，重装以更新`);
    const hit = extensionLoadedIn();
    if (hit) ok(`扩展已被 Chrome 装载（${hit.profile}，${hit.how}）`);
    else warn("清单就位但 Chrome 尚未装载 —— 自动装载走的是 External Extensions 目录，Chrome 只在启动时扫它，得重开一次 Chrome");
    return;
  }

  if (MODE === "uninstall") {
    for (const f of [CRX_JSON, CRX_DST]) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        ok(`已移除 ${path.basename(f)}`);
      }
    }
    return;
  }

  if (!fs.existsSync(CRX_SRC)) {
    bad(`还没打包 CRX，先跑 node scripts/pack-crx.mjs`);
    return;
  }
  fs.mkdirSync(EXT_EXT_DIR, { recursive: true });
  replaceAtomically(CRX_SRC, CRX_DST, 0o644);
  fs.writeFileSync(
    CRX_JSON,
    JSON.stringify({ external_crx: CRX_DST, external_version: extVersion() }, null, 2) + "\n"
  );
  ok(`CRX: ${CRX_DST}`);
  ok(`清单: ${CRX_JSON} (v${extVersion()})`);
}

function doMcp() {
  if (MODE === "install") {
    writeLauncher(
      MCP_LAUNCHER,
      SERVER_PATH,
      "agent 桌面端不一定把 env 传给 MCP 进程；node 路径和环境都固化在这个 wrapper 里，跟调用方无关。"
    );
    ok(`启动器: ${MCP_LAUNCHER}`);
  } else if (MODE === "check") {
    if (!fs.existsSync(MCP_LAUNCHER)) bad("MCP 启动器不存在，请重新安装");
    else if (!WIN && !(fs.statSync(MCP_LAUNCHER).mode & 0o111)) bad("MCP 启动器没有可执行位");
    else ok(`启动器: ${MCP_LAUNCHER}`);
    const missing = SERVER_DEPS.filter((d) => !fs.existsSync(path.join(RUNTIME_DIR, d)));
    if (missing.length) bad(`运行时缺少 server.mjs 依赖的模块：${missing.join(", ")}，跑 ${REINSTALL_CMD} 重装`);
    else ok(`server 依赖模块齐全（${SERVER_DEPS.join(", ")}）`);
    smokeTestRuntime();
    checkStrayBrowsers();
    const extMissing = EXT_FILES.filter((f) => !fs.existsSync(path.join(RUNTIME_DIR, "extension", f)));
    if (extMissing.length)
      warn(`运行时没有 extension/${extMissing.join("、")}：CLI/headless 模式（AGENT_IN_CHROME_LAUNCH=1）起不来，重装即可（桌面模式不受影响）`);
    else {
      const a = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;
      const b = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, "extension", "manifest.json"), "utf8")).version;
      if (a !== b) warn(`运行时里的工具层是 v${b}，源码是 v${a} —— CLI 模式跑的是旧代码，重装以更新`);
      else ok(`CLI 模式的工具层就位（extension v${b}）`);
    }
  }
}

export const ASSETS = [
  {
    label: "skill",
    from: path.join(ROOT, "skills", "agent-in-chrome"),
    to: path.join(DATA_DIR, "skills", "agent-in-chrome"),
    removeWith: path.join(DATA_DIR, "skills", "agent-in-chrome"),
  },
  {
    label: "command",
    from: path.join(ROOT, "commands", "agent-in-chrome.md"),
    to: path.join(DATA_DIR, "commands", "agent-in-chrome.md"),
  },
  {
    label: "install skill",
    from: path.join(ROOT, "skills", "install-agent-in-chrome"),
    to: path.join(DATA_DIR, "skills", "install-agent-in-chrome"),
    removeWith: path.join(DATA_DIR, "skills", "install-agent-in-chrome"),
  },
  {
    label: "install command",
    from: path.join(ROOT, "commands", "install-agent-in-chrome.md"),
    to: path.join(DATA_DIR, "commands", "install-agent-in-chrome.md"),
  },
];

/*
 * 拷一份资产过去：文件就是文件，目录连子目录一起。
 *
 * 覆盖式（force）而不是先删后拷：升级时目录里可能有用户或别的工具放的东西，
 * 整个删掉是越界；同名文件覆盖到最新即可。
 */
export function copyAsset(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true, force: true });
  else fs.copyFileSync(from, to);
}

function doAssets() {
  for (const a of ASSETS) {
    if (MODE === "check") {
      fs.existsSync(a.to) ? ok(`${a.label}: ${a.to}`) : bad(`${a.label}: 未安装`);
      continue;
    }
    if (MODE === "uninstall") {
      if (fs.existsSync(a.to)) removeAndReport(a.label, a.removeWith || a.to);
      else skip(`${a.label}: 本来就没有`);
      continue;
    }
    copyAsset(a.from, a.to);
    ok(`${a.label}: ${a.to}`);
  }
}

export function listSocks(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^agent-in-chrome.*\.sock$/.test(n))
    .sort()
    .map((n) => [n === "agent-in-chrome.sock" ? "桌面" : `CLI（${n}）`, path.join(dir, n)]);
}

function doToken() {
  const file = tokenPath(DATA_DIR);

  if (MODE === "uninstall") {
    if (fs.existsSync(file)) step("删除桥接令牌", () => (fs.unlinkSync(file), ok(`桥接令牌已删除 ${file}`)));
    else skip("桥接令牌: 本来就没有");
    return;
  }

  if (MODE === "install") {
    getToken(DATA_DIR);
    const st = permStatus(DATA_DIR);
    ok(`桥接令牌: ${file}（权限 ${(st.tokenMode ?? 0).toString(8).padStart(4, "0")}，内容不打印也不上传）`);
    ok(`数据目录已收到 0700: ${DATA_DIR}`);
    return;
  }

  const before = permStatus(DATA_DIR);
  if (!before.tokenExists) bad(`没有桥接令牌 ${file}，跑 ${REINSTALL_CMD} 生成`);
  else if (WIN) ok(`桥接令牌就位（隔离交给 NTFS ACL，%USERPROFILE% 默认仅本人可读）`);
  else if (before.tokenMode !== 0o600)
    warn(`桥接令牌权限是 ${before.tokenMode.toString(8)}，应为 600：chmod 600 ${file}`);
  else ok(`桥接令牌就位（600）`);

  if (WIN) return;

  if (before.dirMode === null) {
    skip(`数据目录还不存在 ${DATA_DIR}（装一次就有了）`);
  } else if (before.dirMode !== 0o700) {
    ensureDataDir(DATA_DIR);
    warn(`数据目录原本是 ${before.dirMode.toString(8)}（别的用户能进来），已收紧为 700`);
  } else if (before.dirMode === 0o700) ok("数据目录 700");

  for (const [label, sock] of listSocks(DATA_DIR)) {
    if (!fs.existsSync(sock)) continue;
    const m = fs.statSync(sock).mode & 0o777;
    if (m !== 0o600) warn(`${label} socket 权限是 ${m.toString(8)}（应为 600），重启 MCP server 即可修正`);
    else ok(`${label} socket 600`);
  }
}

const COOKIE_DIR = path.resolve(process.env.AGENT_IN_CHROME_COOKIE_DIR || path.join(DATA_DIR, "cookies"));
const TRACE_DIR = path.resolve(process.env.AGENT_IN_CHROME_TRACE_DIR || path.join(DATA_DIR, "traces"));
const SHOT_DIR = path.resolve(process.env.AGENT_IN_CHROME_SHOT_DIR || path.join(DATA_DIR, "screenshots"));
const LOG_FILES = [
  path.join(DATA_DIR, "agent-in-chrome-cli.log"),
  path.join(DATA_DIR, "agent-in-chrome-host.log"),
];

function countFiles(dir) {
  let n = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) (e.isDirectory() ? walk : () => n++)(path.join(p, e.name));
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

const insideDataDir = (p) => {
  const rel = path.relative(DATA_DIR, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

function doLeftovers() {
  if (MODE !== "uninstall") return;

  if (fs.existsSync(EXT_STABLE_DIR))
    removeAndReport(`扩展副本（${countFiles(EXT_STABLE_DIR)} 个文件）`, EXT_STABLE_DIR);
  else skip("扩展副本: 本来就没有（git 检出的用户直接从仓库加载）");

  for (const f of LOG_FILES) {
    if (!fs.existsSync(f)) continue;
    step(`删除日志 ${path.basename(f)}`, () => (fs.unlinkSync(f), ok(`日志已删除 ${f}`)));
  }

  const cookies = countFiles(COOKIE_DIR);
  if (cookies && insideDataDir(COOKIE_DIR))
    removeAndReport(`导出的 cookie（${cookies} 个文件，完整会话凭据的明文，不能留在盘上）`, COOKIE_DIR);
  else if (cookies)
    warn(`导出的 cookie 还在 ${COOKIE_DIR}（${cookies} 个文件，**完整会话凭据的明文**）：\n    这个位置是你自己用 AGENT_IN_CHROME_COOKIE_DIR 指定的，不替你删，请自己处理。`);

  for (const [label, dir, env] of [
    ["操作留痕 trace", TRACE_DIR, "AGENT_IN_CHROME_TRACE_DIR"],
    ["截图", SHOT_DIR, "AGENT_IN_CHROME_SHOT_DIR"],
  ]) {
    const n = countFiles(dir);
    if (n) warn(`${label}还留在 ${dir}（${n} 个文件）：那是你让工具产出的东西，卸载不替你删。不要了自己删掉即可。`);
  }

  step("移除空的数据目录", () => {
    if (fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR).length === 0) {
      fs.rmdirSync(DATA_DIR);
      ok(`数据目录已移除 ${DATA_DIR}`);
    }
  });
}

const STORE_URL = EXT_IDS[1] ? `https://chromewebstore.google.com/detail/${EXT_IDS[1]}` : null;

export function configPathsOf(target) {
  return String(target || "")
    .split("、")
    .map((s) => s.replace(/（.*$/, "").trim())
    .filter(Boolean);
}

function hasKeyDeep(node, name) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  for (const [k, v] of Object.entries(node)) {
    if (k === name) return true;
    if (hasKeyDeep(v, name)) return true;
  }
  return false;
}

export function configHasOurEntry(file, name = MCP_NAME) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  try {
    return hasKeyDeep(JSON.parse(text), name);
  } catch {}
  return text.includes(name);
}

function launcherEntry() {
  return WIN ? { command: "cmd", args: ["/c", MCP_LAUNCHER], env: {} } : { command: MCP_LAUNCHER, args: [], env: {} };
}
function npxEntry() {
  return { command: "npx", args: ["-y", PKG_NAME, "serve"], env: {} };
}

const browserKey = (n) => n.toLowerCase().replace(/\s+/g, "-");

/* 机器可读的安装事实。纯读，不改任何东西。 */
export function configFacts() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const nativeHost = { name: HOST_NAME, manifestPaths: {} };
  if (WIN) {
    nativeHost.registryKeys = {};
    for (const [name, key] of winBrowserKeys()) {
      nativeHost.manifestPaths[browserKey(name)] = WIN_HOST_MANIFEST;
      nativeHost.registryKeys[browserKey(name)] = key;
    }
  } else {
    for (const [name, dir] of browserDirs()) nativeHost.manifestPaths[browserKey(name)] = path.join(dir, `${HOST_NAME}.json`);
  }
  return {
    version,
    runtimeDir: RUNTIME_DIR,
    serverPath: SERVER_PATH,
    installed: fs.existsSync(MCP_LAUNCHER),
    mcp: { name: MCP_NAME, launcher: launcherEntry(), npx: npxEntry() },
    extension: {
      dir: IS_GIT_CHECKOUT ? path.join(ROOT, "extension") : EXT_STABLE_DIR,
      id: EXT_ID,
      ids: EXT_IDS,
      storeUrl: STORE_URL,
    },
    nativeHost,
    agents: buildAgents({ serverPath: SERVER_PATH, mcpLauncher: MCP_LAUNCHER }).map((a) => ({
      id: a.id,
      name: a.name,
      detected: !!a.detected,
      configPath: a.target,
      registered: configPathsOf(a.target).some((f) => configHasOurEntry(f)),
    })),
  };
}

const tomlStr = (s) => JSON.stringify(String(s));

export const PRINT_FORMATS = ["json", "toml", "claude-cli"];

/* 把事实渲染成一种格式。返回的字符串就是 stdout 的全部内容。 */
export function renderConfig(fmt, facts = configFacts()) {
  if (fmt === "json") return JSON.stringify(facts, null, 2) + "\n";
  const { launcher, npx } = facts.mcp;
  if (fmt === "toml") {
    return (
      `# agent-in-chrome v${facts.version} — Codex 风格的 MCP 配置\n` +
      `# 本机 launcher 版：路径在安装后稳定，且固化了 node 绝对路径（GUI 客户端没有终端 PATH）\n` +
      `[mcp_servers.${MCP_NAME}]\n` +
      `command = ${tomlStr(launcher.command)}\n` +
      `args = [${launcher.args.map(tomlStr).join(", ")}]\n` +
      `\n# 不依赖安装路径的版本（和上面二选一，同名表不能同时存在）：\n` +
      `# [mcp_servers.${MCP_NAME}]\n` +
      `# command = ${tomlStr(npx.command)}\n` +
      `# args = [${npx.args.map(tomlStr).join(", ")}]\n`
    );
  }
  if (fmt === "claude-cli") {
    return (
      `claude mcp add --scope user ${MCP_NAME} -- node ${facts.serverPath}\n` +
      `\n# 不依赖安装路径的版本（和上面二选一）：\n` +
      `# claude mcp add --scope user ${MCP_NAME} -- ${npx.command} ${npx.args.join(" ")}\n`
    );
  }
  throw new Error(`未知格式 ${fmt}`);
}

function doPrintConfig(fmt, mode) {
  if (!PRINT_FORMATS.includes(fmt)) {
    console.error(`--print-config 的格式只认 ${PRINT_FORMATS.join(" / ")}，收到的是 ${JSON.stringify(fmt)}`);
    return 2;
  }
  let text;
  try {
    text = renderConfig(fmt);
  } catch (e) {
    console.error(`生成配置失败：${String(e?.message || e)}`);
    return 1;
  }
  console.error(`# agent-in-chrome --print-config=${fmt}（只读：没有检查、也没有改动任何文件）`);
  if (mode !== "check") console.error(`# 注意：--print-config 忽略了 ${mode} 这个动作，什么都没装/没卸。`);
  process.stdout.write(text);
  return 0;
}

function chmod() {
  if (MODE !== "install") return;
  ok(`运行时: ${RUNTIME.label}`);
}

/*
 * 主流程。mode: "install" | "check" | "uninstall"。
 * opts: { withCrx, yes, agents（agent id 数组或 null）, noAgents }
 *
 * bin/agent-in-chrome.mjs 和文件末尾的主守卫都走这里，git 克隆用户和 npx 用户
 * 拿到的是同一套行为。
 *
 * **返回退出码**（0 = 一条 ✗ 都没有，1 = 有）。两个入口都 process.exit 它：
 * `npm run check` 和 CI 里的 `&&` 才有可能看出失败。同一个进程里连着跑两次的
 * （测试就是这么用的）也对：计数每次进来清零。
 */
export async function run(mode, opts = {}) {
  MODE = mode;
  problems = 0;
  if (opts.printConfig) return doPrintConfig(opts.printConfig, mode);
  WITH_CRX = !!opts.withCrx;
  if (WITH_CRX && !IS_GIT_CHECKOUT) {
    console.log("\n  \x1b[33m!\x1b[0m --with-crx 只对克隆了仓库的开发者可用（需要 ext-key.pem 私钥，npm 包里不含）。");
    console.log("    已改走默认的手动加载模式（效果一样，只是要你自己在 chrome://extensions 加载一次）。");
    WITH_CRX = false;
  }
  if (WITH_CRX && WIN) {
    console.log("\n  \x1b[33m!\x1b[0m Windows 上 Chrome 不接受商店外的本地 CRX 自动装载，--with-crx 无效。");
    console.log("    已改走手动加载模式（chrome://extensions 加载已解压）。");
    WITH_CRX = false;
  }

  const TITLE = { install: "安装", uninstall: "卸载", check: "自检" }[MODE];
  console.log(`\n\x1b[1mAgent in Chrome — ${TITLE}\x1b[0m`);
  console.log(`  插件目录  ${ROOT}`);
  console.log(`  扩展 ID   ${EXT_IDS.join("、")}\n`);

  console.log("\x1b[1m1. 浏览器 native host\x1b[0m");
  step("浏览器 native host", doHosts);
  await stepAsync("前台归还 helper", doForegroundHelper);
  console.log("\n\x1b[1m2. Chrome 扩展\x1b[0m");
  if (!WITH_CRX && MODE === "install") {
    skip("手动加载模式（加 --with-crx 可改为自动装载）");
  } else if (!WITH_CRX && MODE === "check") {
    const hit = extensionLoadedIn();
    hit
      ? ok(`Chrome 已装载（${hit.profile}，${hit.how}）`)
      : bad("Chrome 尚未装载扩展（去 chrome://extensions 加载已解压）");
  } else {
    if (MODE === "install") {
      try {
        execFileSync(process.execPath, [path.join(ROOT, "scripts", "pack-crx.mjs")], { stdio: "pipe" });
        ok(`CRX 已打包 (v${extVersion()})`);
      } catch (e) {
        bad(`打包 CRX 失败: ${String(e.stderr || e.message).slice(0, 200)}`);
      }
    }
    step("Chrome 扩展", doCrx);
  }
  console.log("\n\x1b[1m3. agent MCP 注册\x1b[0m");
  step("MCP 启动器", doMcp);
  const agentResult =
    (await stepAsync("agent 注册", () =>
      runAgents(MODE, {
        serverPath: SERVER_PATH,
        mcpLauncher: MCP_LAUNCHER,
        yes: !!opts.yes,
        agents: opts.agents || null,
        noAgents: !!opts.noAgents,
      })
    )) || null;
  problems += agentProblemCount();
  console.log("\n\x1b[1m4. skill / command\x1b[0m");
  step("skill / command", doAssets);
  console.log("\n\x1b[1m5. 桥接令牌与权限\x1b[0m");
  step("桥接令牌", doToken);
  if (MODE === "uninstall") {
    console.log("\n\x1b[1m6. 其余产物\x1b[0m");
    doLeftovers();
  }
  if (MODE === "check") {
    console.log("\n\x1b[1m6. 桥接通道\x1b[0m");
    reportBridge(await bridgeState());
  }
  if (MODE === "install") {
    const st = await bridgeState();
    if (st.owner === "legacy") {
      console.log("\n\x1b[1m桥接通道\x1b[0m");
      reportBridge(st);
    }
  }
  if (MODE === "install") {
    console.log("");
    chmod();
  }

  printOutro(agentResult);
  if (problems) console.log(`\x1b[31m${problems} 项没过\x1b[0m（往上翻看 ✗ 那几行），退出码 1\n`);
  return problems ? 1 : 0;
}

function printRegistered(res) {
  if (MODE !== "install" || !res) return;
  const { installed = [], skipped = [] } = res;
  if (!installed.length) return;
  console.log(`
\x1b[1m已注册进这 ${installed.length} 个客户端：\x1b[0m ${installed.join("、")}${
    skipped.length ? `\n（跳过：${skipped.join("、")}）` : ""
  }
  不想要其中某一家：\x1b[36mnpx ${PKG_NAME} uninstall --agents=${installed[0]}\x1b[0m
  全部摘掉：        \x1b[36mnpx ${PKG_NAME} uninstall\x1b[0m
  只会删掉配置里 "${MCP_NAME}" 这一个键，改前自动备份，文件其余内容不动。`);
}

function printOutro(agentResult) {
  printRegistered(agentResult);
  if (MODE === "install") {
    const steps = WITH_CRX
      ? `  \x1b[33m完全退出 Chrome 再重开\x1b[0m（⌘Q，不是关窗口）——只有\x1b[1m自动装扩展\x1b[0m
  这条路要重启（Chrome 只在启动时扫 External Extensions 目录）。
  Chrome 可能弹一个「已添加新扩展程序」的气泡，点启用即可。`
      : `  chrome://extensions → 右上角开「开发者模式」→「加载已解压的扩展程序」→ 选：
       ${IS_GIT_CHECKOUT ? path.join(ROOT, "extension") : EXT_STABLE_DIR}${
         IS_GIT_CHECKOUT
           ? ""
           : `
       （这是安装器复制出来的稳定副本。npx 的缓存目录会被清理，不能从那里加载；
        以后升级重跑一次 npx ${PKG_NAME}@latest install，这份副本会跟着更新。）`
       }
       macOS 的文件选择器默认不显示 . 开头的目录：按 ⌘⇧G 粘上面这条路径，或 ⌘⇧. 显示隐藏文件。
       装上后核对卡片上的扩展 ID = ${EXT_ID}，对不上就是选错目录了。

  \x1b[1m把扩展钉到工具栏\x1b[0m：地址栏右边的拼图图标 🧩 → Agent in Chrome → 点图钉。
  下面每一句「点扩展图标」都是指它，不钉住就得每次翻拼图菜单。

  \x1b[1m不用重启 Chrome。\x1b[0m扩展每 30 秒会自己重连一次，装完等一下就通了；
  等不及就点一下扩展图标 →「重连」，立即生效。
  （Chrome 是在每次 connectNative 时现读 native host 配置的，不是只在启动时读——
   这一条 0.31.0 实测推翻了旧说法。）`;

    console.log(`
\x1b[1m还差这些：\x1b[0m

${steps}

  然后在 agent 里让 MCP 生效——\x1b[1m同样不用重启\x1b[0m：
  Claude Code / WorkBuddy 跑 \x1b[36m/mcp\x1b[0m 重连即可；别的客户端在 Settings → MCP 里
  重连一下 "${MCP_NAME}"。只有完全没有重连入口的客户端才需要重开。

\x1b[1m然后直接在 agent 里验：\x1b[0m说「列一下我打开的标签页」，或跑 /agent-in-chrome。
能列出你真实的标签页，就说明整条链路通了。

要是不通，\x1b[33m先退出 agent\x1b[0m，再跑这条逐项自检看卡在哪：
  npx ${PKG_NAME}@latest check

（桥接 socket 是单主的：agent 开着的时候它占着通道，自检插不进去。
 所以自检要在 agent 关闭时跑。装不上、连不通的完整排查步骤在 /install-agent-in-chrome 里。）
`);
  } else if (MODE === "check") {
    console.log("\n上面有 ✗ 的项就是没装好的地方。全绿仍连不上：点扩展图标看弹窗里的断开原因，或点「重连」（不用重启 Chrome）。\n");
  } else {
    if (LEFTOVERS.length) {
      console.log(`\n\x1b[33m卸载没能全部完成\x1b[0m，这 ${LEFTOVERS.length} 项没收干净：`);
      for (const l of LEFTOVERS) console.log(`  · ${l.what}：${l.why}${l.hint ? `\n    ${l.hint}` : ""}`);
      console.log(`  其余步骤都已经跑完了。把上面挡路的东西（多半是还开着的浏览器）处理掉，再跑一次卸载即可。`);
    }
    console.log(`
卸载${LEFTOVERS.length ? "（部分）" : ""}完成。还剩两件事需要你手动做：
  1. 到 chrome://extensions 里移除「Agent in Chrome」扩展
  2. 在 agent 里刷新 MCP 列表（Claude Code / WorkBuddy 跑 /mcp），不用重启
`);
  }
}

/* bin/agent-in-chrome.mjs 也用它解析旗标，两个入口认同一套写法 */
export function parseFlags(argv) {
  const agentsArg = argv.find((a) => a.startsWith("--agents="));
  const printArg = argv.find((a) => a === "--print-config" || a.startsWith("--print-config="));
  const KNOWN = new Set(["--uninstall", "--check", "--with-crx", "--yes", "-y", "--no-agents", "--help", "-h", "--print-config"]);
  return {
    printConfig: printArg ? printArg.slice("--print-config=".length) || "json" : null,
    mode: argv.includes("--uninstall") ? "uninstall" : argv.includes("--check") ? "check" : "install",
    help: argv.includes("--help") || argv.includes("-h"),
    withCrx: argv.includes("--with-crx"),
    yes: argv.includes("--yes") || argv.includes("-y"),
    noAgents: argv.includes("--no-agents"),
    agents: agentsArg
      ? agentsArg
          .slice("--agents=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    unknown: argv.filter((a) => !KNOWN.has(a) && !a.startsWith("--agents=") && !a.startsWith("--print-config=")),
  };
}

export const FLAGS_USAGE = `用法：node scripts/install.mjs [--check | --uninstall] [旗标]

不带模式旗标就是安装。旗标：
  --check          自检：逐项检查装好没有，不改任何东西
  --uninstall      卸载：移除安装写入的一切（agent 配置只摘我们自己的键，改前有备份）
  --yes / -y       跳过逐个确认
  --agents=a,b     只注册这些 agent。可用 id 见 --check 的输出，当前是：
                   claude-code、claude-desktop、workbuddy、zcode、opencode、kimi、
                   gemini、antigravity、qoder-cli、qoder-cli-cn、qoder-ide-cn、
                   trae-cn、qoder-ide、trae、deepseek-harness、codex
  --no-agents      跳过 agent 注册
  --print-config[=json|toml|claude-cli]
                   只把安装事实（路径、启动方式、扩展目录、各 agent 状态）打到 stdout，
                   一个字节都不写盘。其余提示走 stderr，便于管道接 jq。
                   给安装器没收录的客户端手动登记时用这个，不要凭记忆猜路径。
  --with-crx       自动装载扩展（仅克隆仓库的开发者，需要签名私钥）
  --help / -h      显示本帮助`;

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(FLAGS_USAGE);
  } else if (flags.unknown.length) {
    console.error(`不认识的旗标：${flags.unknown.join(" ")}\n\n${FLAGS_USAGE}`);
    process.exit(2);
  } else {
    process.exitCode = await run(flags.mode, flags);
  }
}
