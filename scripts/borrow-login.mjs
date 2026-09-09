#!/usr/bin/env node
// 把指定域的登录态从**用户自己那个 Chrome**借给**隔离实例**，一条命令走完。
//
// 两种装法各有各的敲法，两条都是一等入口：
//   git 检出：  node scripts/borrow-login.mjs --domains github.com
//   npm / npx： npx @liang-hz/agent-in-chrome borrow-login --domains github.com
// （npm 装出来的运行时是扁平布局，没有 `scripts/` 这个目录可敲；bin 的子命令在包内
//  解析路径，`scripts/` 与 `mcp/` 的相对位置在包里和在仓库里是一样的。）
//
//   … --domains github.com,news.ycombinator.com
//   … --domains github.com --profile /path/to/profile
//   … --status
//   … --release              # 还掉最近借的那一批
//   … --release --all        # 还掉账本上全部
//   … --release --domains github.com
//
// 边界与承诺（动手前先读这几条）：
// · 只搬 cookie。把 token 放在 localStorage / IndexedDB 的站点（Firebase Auth、MSAL、
//   Supabase 这类）搬不动，症状是「导入成功但仍然未登录」。
// · 会话 cookie（没有 expires）只活在隔离实例这一次运行里，这是 Web 规范的语义；
//   `--pin-session <小时数>` 才把它改写成持久 cookie，那等于替站点延长凭据寿命，默认关着。
// · 账本 `<profile>/aic-borrowed-cookies.json`（0600）只记 name/domain/path + 借用时刻，
//   **不含任何 cookie 值**；`--release` 只碰账本上记过账的那些，别的一律不动。
// · 落盘的 cookie 明文文件用完即删（正常路径、异常路径、进程退出三处），`--keep-file` 才留。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scriptCmd, checkCmd, reinstallCmd } from "../mcp/cli-invocation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 报告和提示里回指自己 / 回指 cli-browser 的那两条命令，按用户的装法拼出真能敲的形态。
const SELF = scriptCmd("borrow-login");
const CLI_BROWSER = scriptCmd("cli-browser");

export const LEDGER_BASENAME = "aic-borrowed-cookies.json";

export const LEDGER_MAX_BATCHES = 50;
export const LEDGER_MAX_ENTRIES = 500;

export const STORAGE_CAVEAT =
  "只搬 cookie **覆盖不了**把 token 放 localStorage / IndexedDB 的站点" +
  "（Firebase Auth、MSAL、Supabase 这类），那种站点的症状是「导入成功但仍然未登录」。";

/*
 * 域名规范化：去掉前导点、转小写，顺带容忍「整条 URL 粘进来」和端口。
 * IDN 会转成 punycode（Chrome 的 cookie 库里存的就是 punycode）。
 *
 * @returns 规范化后的域名；不像域名就返回 null（由调用方点名报出来）
 */
export function normalizeDomain(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return null;
  let host;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  if (!host || host.startsWith("[")) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  return host;
}

export function normalizeDomains(list) {
  const domains = [];
  const invalid = [];
  for (const raw of list || []) {
    const d = normalizeDomain(raw);
    if (!d) invalid.push(String(raw));
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}

export class UsageError extends Error {}

/*
 * 参数解析。三种模式互斥：借（默认）、`--status`、`--release`。
 *
 * 报错要说清下一步做什么——这些文字是使用者（和 agent）的唯一线索。
 */
export function parseArgs(argv) {
  const out = {
    mode: "borrow",
    domainsRaw: [],
    profile: null,
    fromProfile: null,
    keepFile: false,
    all: false,
    wipe: false,
    pinSessionHours: null,
    headed: false,
    help: false,
  };
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} 后面要跟一个值，什么都没做。`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inlineVal = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2) {
      inlineVal = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--status":
        out.mode = "status";
        break;
      case "--release":
        out.mode = "release";
        break;
      case "--all":
        out.all = true;
        break;
      case "--wipe":
        out.wipe = true;
        break;
      case "--keep-file":
        out.keepFile = true;
        break;
      case "--headed":
        out.headed = true;
        break;
      case "--domains":
        out.domainsRaw.push(...String(inlineVal ?? take(i++, "--domains")).split(","));
        break;
      case "--profile":
        out.profile = String(inlineVal ?? take(i++, "--profile"));
        break;
      case "--from-profile":
        out.fromProfile = String(inlineVal ?? take(i++, "--from-profile"));
        break;
      case "--pin-session": {
        const v = String(inlineVal ?? take(i++, "--pin-session"));
        const h = Number(v);
        if (!Number.isFinite(h) || h <= 0)
          throw new UsageError(`--pin-session 要一个正数（小时），收到 ${JSON.stringify(v)}，什么都没做。`);
        out.pinSessionHours = h;
        break;
      }
      default:
        throw new UsageError(`不认识的参数 ${a}。跑 --help 看用法，什么都没做。`);
    }
  }
  if (out.help) return out;

  if (out.mode === "status" && out.domainsRaw.length)
    throw new UsageError("--status 只是查看，不接受 --domains，什么都没做。");
  if (out.fromProfile && out.mode !== "borrow")
    throw new UsageError("--from-profile 只在借用时有意义（它说的是「从哪儿借」），什么都没做。");
  if (out.fromProfile && out.profile && path.resolve(out.fromProfile) === path.resolve(out.profile))
    throw new UsageError("--from-profile 和 --profile 是同一个目录，那就是自己借给自己，什么都没做。");
  if (out.mode !== "release" && out.all)
    throw new UsageError("--all 只跟 --release 一起用（表示还掉账本上全部），什么都没做。");
  if (out.wipe && !(out.mode === "release" && out.all))
    throw new UsageError(
      "--wipe 只能和 --release --all 一起用。它走的是 Storage.clearCookies，" +
        "会把这个隔离 profile 里**你自己手动登录的站点**也一起清掉，所以必须显式说全，什么都没做。"
    );
  if (out.mode === "borrow" && !out.domainsRaw.length)
    throw new UsageError(
      "要借哪些域的登录态？给 --domains，比如 --domains github.com,news.ycombinator.com。" +
        "（查看现状用 --status，归还用 --release。）什么都没做。"
    );
  const { domains, invalid } = normalizeDomains(out.domainsRaw);
  if (invalid.length)
    throw new UsageError(`这些不像域名：${invalid.join("、")}。域名形如 github.com（前导点、大小写、端口、整条 URL 都会自动处理）。什么都没做。`);
  out.domains = domains;
  return out;
}

export const cookieKey = (c) => JSON.stringify([c?.name ?? "", c?.domain ?? "", c?.path ?? ""]);

export const isSessionCookie = (c) => c?.session === true || c?.expires === undefined || Number(c?.expires) === -1;

export const ledgerRowIsSession = (c) => c?.session === true;

/*
 * 把会话 cookie 改写成持久 cookie（`--pin-session <小时>`）。
 *
 * **默认不做。** 它把凭据的寿命延长到了站点本来不打算给的长度——站点把它发成会话
 * cookie，意思就是「关掉浏览器就该失效」。所以这是个显式开关，而且报告里会点名说
 * 改了哪几条。
 */
export function pinSessionCookies(cookies, hours, nowMs = Date.now()) {
  if (!(hours > 0)) return { cookies, pinned: [] };
  const expires = Math.floor(nowMs / 1000) + Math.round(hours * 3600);
  const pinned = [];
  const out = (cookies || []).map((c) => {
    if (!isSessionCookie(c)) return c;
    pinned.push({ name: c.name, domain: c.domain, path: c.path });
    const { session: _drop, ...rest } = c;
    return { ...rest, expires };
  });
  return { cookies: out, pinned };
}

/*
 * 导入之后的逐字比对。
 *
 * `cookies_import` 自己那道读回校验只按 **name+domain+path+分区** 认「在不在」，
 * **不看 value**。而对 cookie 来说值错一个字节 = 静默地没登录上——正是这个项目最忌
 * 讳的那种「报告成功、实际没做成」。所以这里再比一次值和 httpOnly。
 *
 * @param sent 送过去的那批（导出文件里的原样）
 * @param got  隔离实例里读回来的那批
 */
export function diffImported(sent, got) {
  const byKey = new Map((got || []).map((c) => [cookieKey(c), c]));
  const matched = [];
  const missing = [];
  const mismatched = [];
  for (const c of sent || []) {
    const g = byKey.get(cookieKey(c));
    if (!g) {
      missing.push({ name: c.name, domain: c.domain, path: c.path, why: whyDropped(c) });
      continue;
    }
    const bad = [];
    if (String(g.value ?? "") !== String(c.value ?? "")) bad.push("value");
    if (!!g.httpOnly !== !!c.httpOnly) bad.push("httpOnly");
    if (!!g.secure !== !!c.secure) bad.push("secure");
    if (bad.length) mismatched.push({ name: c.name, domain: c.domain, path: c.path, fields: bad });
    else matched.push({ name: c.name, domain: c.domain, path: c.path, session: isSessionCookie(g) });
  }
  return { matched, missing, mismatched };
}

// 给一条没种上的 cookie 算一句解释：SameSite=None 缺 secure / 已经过期 /
// 同一注册域 cookie 条数超上限。判据自己算，浏览器不给理由。
export function whyDropped(c) {
  if (c?.sameSite === "None" && !c?.secure) return "SameSite=None 但没有 secure，浏览器直接丢弃";
  if (c?.expires !== undefined && Number(c.expires) !== -1 && Number(c.expires) * 1000 < Date.now())
    return "expires 已经过期";
  return "没落地，最可能是同一个注册域 cookie 数超了上限（Chrome 到 180 条就淘汰到 150 条，丢最老的）";
}

export const emptyLedger = () => ({ version: 1, batches: [] });

/*
 * 账本清理。三层，缺一层都会让它只增不减：
 *
 *  ① `liveKeys` 给了就按存在性清：账本上那条 cookie 浏览器里已经没了（会话 cookie
 *     随重启消失、站点自己覆盖掉、用户手动清过），条目就该销。这和 sw.js 的
 *     `pruneLedgers()` 是同一条规矩——判据只用**记过的账**核对**当下的事实**，
 *     不用会过期的猜测。**浏览器连不上时不许猜**：liveKeys 传 null，这一层跳过。
 *  ② 空批次销掉。
 *  ③ 硬上限兜底。丢最老的，并且**把丢掉的报出来**——它们从此没法用 --release
 *     自动还了，这件事不能静默。
 */
export function pruneLedger(ledger, liveKeys, { maxBatches = LEDGER_MAX_BATCHES, maxEntries = LEDGER_MAX_ENTRIES } = {}) {
  const src = ledger && Array.isArray(ledger.batches) ? ledger : emptyLedger();
  const droppedEntries = [];
  let batches = src.batches.map((b) => {
    if (!liveKeys) return b;
    const keep = [];
    for (const c of b.cookies || []) {
      if (liveKeys.has(cookieKey(c))) keep.push(c);
      else droppedEntries.push({ ...c, batchId: b.id });
    }
    return { ...b, cookies: keep };
  });
  const emptied = batches.filter((b) => !(b.cookies || []).length).map((b) => b.id);
  batches = batches.filter((b) => (b.cookies || []).length);

  batches.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  const capped = [];
  while (batches.length > maxBatches) capped.push(batches.shift());
  const total = () => batches.reduce((n, b) => n + (b.cookies || []).length, 0);
  while (total() > maxEntries && batches.length > 1) capped.push(batches.shift());

  return { ledger: { version: 1, batches }, droppedEntries, emptiedBatches: emptied, cappedBatches: capped };
}

/* `--release` 要还哪几批：默认最近一批，`--all` 全部，给了 `--domains` 就按域挑 */
export function selectBatches(ledger, { all = false, domains = [] } = {}) {
  const batches = [...((ledger && ledger.batches) || [])].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  if (all) return { picked: batches, rest: [] };
  if (domains && domains.length) {
    const want = new Set(domains);
    const picked = [];
    const rest = [];
    for (const b of batches) {
      const hit = (b.cookies || []).filter((c) => domainMatches(c.domain, want));
      const miss = (b.cookies || []).filter((c) => !domainMatches(c.domain, want));
      if (hit.length) picked.push({ ...b, cookies: hit });
      if (miss.length) rest.push({ ...b, cookies: miss });
    }
    return { picked, rest };
  }
  const last = batches[batches.length - 1];
  return { picked: last ? [last] : [], rest: last ? batches.slice(0, -1) : [] };
}

export function domainMatches(cookieDomain, wantSet) {
  const d = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
  for (const w of wantSet) if (d === w || d.endsWith("." + w)) return true;
  return false;
}

export function formatBorrowReport({ domains, sent, diff, importReported, pinned, profileDir, browser, ledgerNote, source = "你的 Chrome" }) {
  const L = [];
  const sessionCount = (diff.matched || []).filter((c) => c.session).length;
  const persistCount = (diff.matched || []).length - sessionCount;
  L.push(`从${source} 导出 ${domains.join("、")} 的 ${sent.length} 条 cookie → ${profileDir}`);
  L.push(
    `种上并逐字校验通过：${diff.matched.length} 条` +
      `（工具自己报的是 ${importReported?.imported ?? "?"}/${importReported?.requested ?? "?"}；` +
      `这里的数字是把值和 httpOnly 也读回来比过的，不是照抄它）`
  );
  if (diff.mismatched.length) {
    L.push(`⚠️ 值对不上：${diff.mismatched.length} 条 —— 这是严重问题，别拿它当能用的登录态：`);
    for (const c of diff.mismatched) L.push(`   · ${c.name} @ ${c.domain}${c.path}：${c.fields.join(" / ")} 和源头不一致`);
  }
  if (diff.missing.length) {
    L.push(`没种上：${diff.missing.length} 条`);
    for (const c of diff.missing) L.push(`   · ${c.name} @ ${c.domain}${c.path} —— ${c.why}`);
  }
  L.push("");
  L.push(`有效期（只算真的种上了的那 ${diff.matched.length} 条）：${sessionCount} 条是**会话 cookie**，${persistCount} 条是持久 cookie。`);
  if (pinned?.length)
    L.push(`   本次按 --pin-session 把 ${pinned.length} 条会话 cookie 改写成了持久 cookie —— 这等于替站点延长了凭据寿命，心里有数。`);
  if (sessionCount)
    L.push(
      `   会话 cookie 只活在这个浏览器进程的内存里，隔离实例一重启就没了，要重借。` +
        `（想让它们活过重启：--pin-session <小时数>，默认关着，因为那等于替站点延长了凭据寿命。）`
    );
  if (persistCount)
    L.push(
      `   持久 cookie 会写进 <profile>/Default/Cookies，能活过重启 —— **前提是浏览器优雅退出**。` +
        `收隔离实例请用 ${CLI_BROWSER} --stop（它走 Browser.close）；整组 SIGTERM 会把刷盘打断。`
    );
  L.push("");
  L.push(STORAGE_CAVEAT);
  if (ledgerNote) L.push(ledgerNote);
  if (browser)
    L.push(
      `\n隔离实例还开着：pid=${browser.pid} ${browser.version || ""}（特意留着，会话 cookie 在它内存里）。` +
        `\n  用它：AGENT_IN_CHROME_LAUNCH=1 AGENT_IN_CHROME_PROFILE=${profileDir} 起 MCP server，会自动认领这个浏览器` +
        `\n  还回去：${SELF} --release --profile ${profileDir}` +
        `\n  收掉它：AGENT_IN_CHROME_PROFILE=${profileDir} ${CLI_BROWSER} --stop`
    );
  return L;
}

// 帮助文本里的示例命令**跟着用户的装法拼**（见 mcp/cli-invocation.mjs）：git 检出
// 给 `node scripts/borrow-login.mjs …`，npm / npx 装的给 `npx …borrow-login …`。
const HELP = `把指定域的登录态从你自己那个 Chrome 借给隔离实例。

  ${SELF} --domains github.com,news.ycombinator.com
  ${SELF} --domains github.com --profile /path/to/profile
  ${SELF} --status
  ${SELF} --release              还掉最近借的那一批
  ${SELF} --release --all        还掉账本上全部
  ${SELF} --release --domains github.com
  ${SELF} --release --all --wipe 清空隔离 profile 的全部 cookie（含你自己登的，慎用）

参数
  --domains a.com,b.com   要借（或要还）的域，含子域。前导点/大小写/端口/整条 URL 都会自动处理
  --profile <目录>        隔离实例的 profile，默认 $AGENT_IN_CHROME_PROFILE 或
                          ~/.agent-in-chrome/agent-in-chrome/cli-profile
  --from-profile <目录>   从**另一个隔离 profile**借，而不是从你自己那个 Chrome 借。
                          用途：把一个长期登录着的隔离 profile 借给一次性的任务 profile
  --keep-file             留下落盘的 cookie 文件（排查用）。默认用完即删——那份文件是
                          可直接冒用的完整会话凭据，留在磁盘上就是一处新的攻击面
  --pin-session <小时>    把会话 cookie 改写成持久 cookie，让它活过隔离实例重启。
                          **默认关**：这等于替站点延长了凭据寿命
  --headed                隔离实例开有头窗口（默认 headless）
  -h, --help              这份说明

前提：你的 Chrome 开着、Agent in Chrome 扩展已启用（${checkCmd()}）。
`;

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bridgeServerCmd() {
  const override = process.env.AGENT_IN_CHROME_BORROW_SERVER;
  if (override) return override.endsWith(".mjs") ? [process.execPath, [override]] : [override, []];
  const installed = path.join(os.homedir(), ".agent-in-chrome", "agent-in-chrome", "mcp-launcher.sh");
  if (fs.existsSync(installed)) return [installed, []];
  return [process.execPath, [path.join(ROOT, "mcp", "server.mjs")]];
}

function mcpClient(cmd, args, env, label) {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
  let errText = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (c) => {
    errText += c;
    if (errText.length > 20000) errText = errText.slice(-20000);
  });
  let buf = "";
  const waiting = new Map();
  let n = 0;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const f = waiting.get(m.id);
        if (f) {
          waiting.delete(m.id);
          f(m);
        }
      } catch {}
    }
  });
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = ++n;
      const t = setTimeout(() => rej(new Error(`${label}：${method} 超时（90s）`)), 90_000);
      waiting.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    proc: p,
    label,
    get stderr() {
      return errText;
    },
    async init() {
      const r = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "borrow-login", version: "0" },
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r.result?.serverInfo || {};
    },
    async tools() {
      const r = await rpc("tools/list", {});
      return (r.result?.tools || []).map((t) => t.name);
    },
    async call(name, params = {}) {
      const r = await rpc("tools/call", { name, arguments: params });
      const text = r.result?.content?.[0]?.text ?? "";
      if (r.result?.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    kill() {
      try {
        p.kill();
      } catch {}
    },
  };
}

const scratchFiles = new Set();
let keepScratch = false;
function dropScratch() {
  if (keepScratch) return;
  for (const f of scratchFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
  scratchFiles.clear();
}
process.on("exit", dropScratch);

function ledgerPath(profileDir) {
  return path.join(profileDir, LEDGER_BASENAME);
}
function readLedger(profileDir) {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(profileDir), "utf8"));
    return j && Array.isArray(j.batches) ? j : emptyLedger();
  } catch {
    return emptyLedger();
  }
}
function writeLedger(profileDir, ledger) {
  const abs = ledgerPath(profileDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, abs);
}

async function liveCookieKeys(cli, tabId) {
  const r = await cli.call("browser_cdp", {
    method: "Storage.getCookies",
    params: {},
    maxChars: 4_000_000,
    tabId,
  });
  if (r?.truncated)
    throw new Error(
      `隔离实例的 cookie 列表被截断了（${r.chars} 字符），没法可靠核对账本，什么都没改。` +
        "这说明这个 profile 里 cookie 极多；可以先 --release --all 清一遍再借。"
    );
  const cookies = r?.result?.cookies || [];
  return { keys: new Set(cookies.map(cookieKey)), count: cookies.length };
}

async function openIsolated(launch, { headless, label }) {
  const info = await launch.ensureBrowser({ headless });
  const cli = mcpClient(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
    ...process.env,
    AGENT_IN_CHROME_LAUNCH: "1",
    AGENT_IN_CHROME_KEEP: "1",
    AGENT_IN_CHROME_PROFILE: launch.PROFILE_DIR,
    AGENT_IN_CHROME_HEADLESS: headless ? "1" : "0",
    AGENT_IN_CHROME_SESSION_ID: `borrow-login-cdp-${process.pid}`,
  }, "隔离实例");
  const server = await cli.init();
  const names = await cli.tools();
  for (const need of ["browser_cookies_import", "browser_cdp", "browser_new_tab"])
    if (!names.includes(need)) {
      cli.kill();
      throw new Error(
        `隔离实例这一侧的 ${need} 没有注册（server ${server.version || "?"}）。` +
          "多半是工具档位被切到了「观察」档——搬运登录态属于凭据面，需要「完全」档。"
      );
    }
  let tab;
  try {
    tab = await cli.call("browser_new_tab", { label });
  } catch (e) {
    cli.kill();
    throw new Error(`隔离实例开不出标签页：${e.message}\nserver stderr：\n${cli.stderr.slice(-1200)}`);
  }
  return { info, cli, tabId: tab.tabId };
}

async function closeIso(iso) {
  if (!iso) return;
  try {
    await iso.cli.call("browser_close_all", {});
  } catch {}
  iso.cli.kill();
}

async function exportFrom(domains, outFile, fromProfile) {
  const cdpSource = !!fromProfile;
  const [cmd, args] = cdpSource ? [process.execPath, [path.join(ROOT, "mcp", "server.mjs")]] : bridgeServerCmd();
  step(`① 从${cdpSource ? `隔离 profile ${fromProfile}` : "你自己那个 Chrome"} 导出（${domains.join("、")}）`);
  console.log(`  用的 server：${cmd}${args.length ? " " + args.join(" ") : ""}`);
  const env = { ...process.env, AGENT_IN_CHROME_SESSION_ID: `borrow-login-src-${process.pid}` };
  if (cdpSource) {
    env.AGENT_IN_CHROME_LAUNCH = "1";
    env.AGENT_IN_CHROME_KEEP = "1";
    env.AGENT_IN_CHROME_PROFILE = path.resolve(fromProfile);
    env.AGENT_IN_CHROME_HEADLESS = env.AGENT_IN_CHROME_HEADLESS ?? "1";
  } else {
    delete env.AGENT_IN_CHROME_LAUNCH;
    delete env.AGENT_IN_CHROME_PROFILE;
    delete env.AGENT_IN_CHROME_KEEP;
  }
  const cli = mcpClient(cmd, args, env, cdpSource ? "源隔离实例" : "真 Chrome");
  try {
    const server = await cli.init();
    const names = await cli.tools();
    if (!names.includes("browser_cookies_export"))
      throw new Error(
        `browser_cookies_export 没有注册（server ${server.version || "?"}）。` +
          "多半是工具档位被切到了「观察」档——导出 cookie 属于凭据面，需要在扩展设置里切到「完全」档。"
      );

    let status = null;
    let lastErr = "";
    const deadline = Date.now() + 45_000;
    process.stdout.write(cdpSource ? "  等源隔离实例就绪" : "  等 Chrome 扩展接入");
    while (Date.now() < deadline) {
      try {
        status = await cli.call("browser_status");
        break;
      } catch (e) {
        lastErr = String(e.message || e);
        process.stdout.write(".");
        await sleep(1500);
      }
    }
    console.log("");
    if (!status) {
      if (cdpSource) throw new Error(`源隔离实例起不来（最后一次报的是：${lastErr}）\n\nserver stderr 末尾：\n${cli.stderr.slice(-1200)}`);
      throw bridgeDownError(lastErr, cli.stderr);
    }
    ok(cdpSource ? `源隔离实例就绪（工具层 ${status.version}）` : `扩展已接入（扩展 ${status.version}）`);

    const tab = await cli.call("browser_new_tab", { label: "借登录态" });
    try {
      const res = await cli.call("browser_cookies_export", { domains, outFile, tabId: tab.tabId });
      if (!res?.file) throw new Error(`导出没有落盘（返回：${JSON.stringify(res).slice(0, 300)}）`);
      scratchFiles.add(res.file);
      ok(`导出 ${res.count} 条（${Object.keys(res.domains || {}).join("、") || "无"}）→ ${res.file}（0600）`);
      return res;
    } catch (e) {
      throw new Error(
        `导出被拒了。扩展那边原样说：\n\n${e.message}\n\n` +
          "如果这是按域授权闸：去点扩展图标，在弹窗里给这些域授权，然后把这条命令重跑一遍。"
      );
    } finally {
      try {
        await cli.call("browser_close_all", {});
      } catch {}
    }
  } finally {
    cli.kill();
  }
}

function bridgeDownError(lastErr, stderr) {
  const tail = (stderr || "").trim().split("\n").slice(-6).join("\n");
  let hint =
    "排查顺序：\n" +
    "  1. Chrome 在跑吗，chrome://extensions 里 Agent in Chrome 是否已启用\n" +
    "  2. 点扩展图标看弹窗里的断开原因，点一下「重新连接」\n" +
    `  3. ${checkCmd()}`;
  if (/桥接认证|认证失败|handshake/i.test(stderr || ""))
    hint =
      "stderr 里是**桥接认证失败**：这条 socket 已经被另一个版本的 server 当主占着，\n" +
      "两边的握手协议对不上（0.48 把它换成了质询-应答，0.47 的主认不出）。\n" +
      `  · 把运行时同步到当前版本：${reinstallCmd()}，然后重启所有 agent 会话\n` +
      "  · 或者用和主同版本的 server：AGENT_IN_CHROME_BORROW_SERVER=<那份 server.mjs 或 launcher>";
  return new Error(`连不上你的 Chrome（最后一次报的是：${lastErr}）。\n\n${hint}\n\nserver stderr 末尾：\n${tail}`);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`\n${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  keepScratch = args.keepFile;

  if (args.profile) process.env.AGENT_IN_CHROME_PROFILE = path.resolve(args.profile);
  process.env.AGENT_IN_CHROME_KEEP = "1";
  const launch = await import("../mcp/cdp/browser-launch.mjs");
  const PROFILE = launch.PROFILE_DIR;
  const headless = !args.headed;

  if (args.mode === "status") return await doStatus(launch, PROFILE);
  if (args.mode === "release") return await doRelease(launch, PROFILE, args, headless);
  return await doBorrow(launch, PROFILE, args, headless);
}

async function doStatus(launch, PROFILE) {
  console.log(`\n\x1b[1m隔离实例\x1b[0m ${PROFILE}`);
  const st = launch.browserStatus();
  if (st.running) console.log(`  在跑：pid=${st.pid} ${st.version || ""} ${st.endpoint?.wsUrl || ""}`);
  else console.log(`  没在跑${st.stale ? "（账上有条陈旧记录，进程已经不在了）" : ""}`);

  let ledger = readLedger(PROFILE);
  const before = ledger.batches.reduce((n, b) => n + (b.cookies || []).length, 0);
  console.log(`\n\x1b[1m借用账本\x1b[0m ${ledgerPath(PROFILE)}`);
  if (!before) {
    console.log("  空的——现在没借着任何东西。");
    return 0;
  }

  if (st.running) {
    let iso = null;
    try {
      iso = await openIsolated(launch, { headless: true, label: "查借用账本" });
      const live = await liveCookieKeys(iso.cli, iso.tabId);
      const pruned = pruneLedger(ledger, live.keys);
      if (pruned.droppedEntries.length || pruned.emptiedBatches.length) writeLedger(PROFILE, pruned.ledger);
      ledger = pruned.ledger;
      if (pruned.droppedEntries.length)
        console.log(`  （核对后清掉 ${pruned.droppedEntries.length} 条已经不在浏览器里的旧账）`);
    } catch (e) {
      warn(`没核对成账本：${e.message}`);
    } finally {
      await closeIso(iso);
      if (iso && !iso.info.adopted) {
        const r = await launch.stopBrowserGracefully();
        warn(`查看时浏览器已不在，冷启动了一个又收掉了（${r.how}，stopped=${r.stopped}）`);
      } else {
        try {
          launch.markAdoptable();
        } catch {}
      }
    }
  } else {
    warn("隔离实例没在跑，账本没跟浏览器核对过——里面的会话 cookie 其实早就随进程没了。");
  }

  for (const b of ledger.batches.sort((a, b2) => (a.atMs || 0) - (b2.atMs || 0))) {
    const s = (b.cookies || []).filter(ledgerRowIsSession).length;
    console.log(
      `  · ${new Date(b.atMs).toLocaleString()}  ${(b.domains || []).join("、")}  ` +
        `${(b.cookies || []).length} 条（会话 ${s} / 持久 ${(b.cookies || []).length - s}）${b.pinnedHours ? `  已 pin ${b.pinnedHours}h` : ""}`
    );
  }
  console.log(`\n还回去：${SELF} --release --all --profile ${PROFILE}`);
  return 0;
}

async function doBorrow(launch, PROFILE, args, headless) {
  const cookieOut = path.join(
    process.env.AGENT_IN_CHROME_COOKIE_DIR || path.join(os.homedir(), ".agent-in-chrome", "cookies"),
    `borrow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`
  );
  const exported = await exportFrom(args.domains, cookieOut, args.fromProfile);
  if (!exported.count)
    throw new Error(
      `这几个域一条 cookie 都没有：${args.domains.join("、")}。三种可能：\n` +
        "  · 你在那个 Chrome 里本来就没登录这些站\n" +
        "  · 域名写错了（cookie 常挂在 .example.com 上，写 example.com 就行；但 www 前缀有时是另一条）\n" +
        "  · 那个站的登录态根本不在 cookie 里（见结尾那条边界）\n" +
        "什么都没往隔离实例里写。"
    );

  let sent = JSON.parse(fs.readFileSync(exported.file, "utf8")).cookies || [];
  let pinned = [];
  if (args.pinSessionHours) {
    const r = pinSessionCookies(sent, args.pinSessionHours);
    sent = r.cookies;
    pinned = r.pinned;
    const fd = fs.openSync(exported.file, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ cookies: sent }, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    ok(`--pin-session ${args.pinSessionHours}h：把 ${pinned.length} 条会话 cookie 改写成持久 cookie`);
  }

  step(`② 起隔离实例并导入 → ${PROFILE}`);
  const iso = await openIsolated(launch, { headless, label: "借登录态" });
  let succeeded = false;
  const coldStarted = !iso.info.adopted;
  process.on("exit", () => {
    if (succeeded || iso.info.adopted) {
      try {
        launch.markAdoptable();
      } catch {}
    }
  });
  try {
    console.log(`  浏览器 pid=${iso.info.pid}（${iso.info.adopted ? "复用" : "新起"}）${iso.info.version || ""}`);
    const importReported = await iso.cli.call("browser_cookies_import", { inFile: exported.file, tabId: iso.tabId });

    const verifyFile = `${exported.file}.verify`;
    scratchFiles.add(verifyFile);
    await iso.cli.call("browser_cookies_export", { domains: args.domains, outFile: verifyFile, tabId: iso.tabId });
    const got = JSON.parse(fs.readFileSync(verifyFile, "utf8")).cookies || [];
    const diff = diffImported(sent, got);

    const ledgerNote = appendBatch(PROFILE, {
      domains: args.domains,
      cookies: diff.matched.map((c) => ({ name: c.name, domain: c.domain, path: c.path, session: c.session })),
      pinnedHours: args.pinSessionHours || null,
      liveKeys: (await liveCookieKeys(iso.cli, iso.tabId)).keys,
    });

    succeeded = diff.matched.length > 0 && diff.mismatched.length === 0;
    step("③ 结果");
    for (const line of formatBorrowReport({
      domains: args.domains,
      sent,
      diff,
      importReported,
      pinned,
      profileDir: PROFILE,
      browser: { pid: iso.info.pid, version: iso.info.version },
      ledgerNote,
      source: args.fromProfile ? `隔离 profile ${path.resolve(args.fromProfile)}` : "你的 Chrome",
    }))
      console.log(line);

    if (args.keepFile) warn(`\n--keep-file：留下了 ${exported.file} 和 ${verifyFile} —— 里面是可直接冒用的完整会话凭据，用完自己删。`);
    return diff.mismatched.length ? 1 : 0;
  } finally {
    await closeIso(iso);
    if (!succeeded && coldStarted) {
      const r = await launch.stopBrowserGracefully();
      warn(`借用没成功，本次起的隔离实例已收掉（${r.how}，stopped=${r.stopped}）`);
    }
    dropScratch();
  }
}

function appendBatch(PROFILE, { domains, cookies, pinnedHours, liveKeys }) {
  const ledger = readLedger(PROFILE);
  ledger.batches.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    atMs: Date.now(),
    at: new Date().toISOString(),
    domains,
    pinnedHours,
    cookies,
  });
  const pruned = pruneLedger(ledger, liveKeys);
  writeLedger(PROFILE, pruned.ledger);
  const notes = [];
  if (pruned.droppedEntries.length)
    notes.push(`账本顺带清掉 ${pruned.droppedEntries.length} 条已经不在浏览器里的旧账（会话 cookie 随重启消失是最常见的原因）。`);
  if (pruned.cappedBatches.length)
    notes.push(
      `⚠️ 账本超出上限（${LEDGER_MAX_BATCHES} 批 / ${LEDGER_MAX_ENTRIES} 条），丢掉了最老的 ${pruned.cappedBatches.length} 批：` +
        pruned.cappedBatches.map((b) => `${new Date(b.atMs).toLocaleString()} ${(b.domains || []).join("、")}`).join("；") +
        "。这些从此没法用 --release 自动还了，要清只能 --release --all --wipe。"
    );
  return notes.length ? "\n" + notes.join("\n") : null;
}

async function doRelease(launch, PROFILE, args, headless) {
  const ledger = readLedger(PROFILE);
  const total = ledger.batches.reduce((n, b) => n + (b.cookies || []).length, 0);
  if (!total && !args.wipe) {
    console.log(`\n账本是空的，没有借来的东西要还：${ledgerPath(PROFILE)}`);
    return 0;
  }
  const { picked, rest } = selectBatches(ledger, { all: args.all, domains: args.domains });
  const targets = [];
  const seen = new Set();
  for (const b of picked)
    for (const c of b.cookies || []) {
      if (seen.has(cookieKey(c))) continue;
      seen.add(cookieKey(c));
      targets.push(c);
    }
  if (!targets.length && !args.wipe) {
    console.log(`\n账本上没有匹配的条目${args.domains?.length ? `（--domains ${args.domains.join("、")}）` : ""}，什么都没做。`);
    return 0;
  }

  const wasRunning = launch.browserStatus().running;
  step(`归还 ${args.wipe ? "（--wipe：清空全部 cookie）" : `${targets.length} 条`} → ${PROFILE}`);
  if (!wasRunning) console.log("  隔离实例没在跑，先起一个：持久 cookie 在磁盘上，不起浏览器删不掉。");
  const iso = await openIsolated(launch, { headless, label: "还登录态" });
  try {
    if (args.wipe) {
      warn("--wipe：走 Storage.clearCookies，这个 profile 里**你自己手动登录的站点也会被清掉**。");
      await iso.cli.call("browser_cdp", { method: "Storage.clearCookies", params: {}, tabId: iso.tabId });
    } else {
      for (const c of targets)
        await iso.cli.call("browser_cdp", {
          method: "Network.deleteCookies",
          params: { name: c.name, domain: c.domain, path: c.path },
          tabId: iso.tabId,
        });
    }

    const live = await liveCookieKeys(iso.cli, iso.tabId);
    const stillThere = targets.filter((c) => live.keys.has(cookieKey(c)));
    const gone = targets.filter((c) => !live.keys.has(cookieKey(c)));
    ok(`确认删掉 ${gone.length} 条（读回校验过，不是照抄返回值）`);
    if (stillThere.length) {
      warn(`还有 ${stillThere.length} 条没删掉，账本上给它们留着，下次 --release 还会再试：`);
      for (const c of stillThere) console.log(`   · ${c.name} @ ${c.domain}${c.path}`);
    }

    const keptKeys = new Set(stillThere.map(cookieKey));
    const remaining = {
      version: 1,
      batches: [...rest, ...picked.map((b) => ({ ...b, cookies: (b.cookies || []).filter((c) => keptKeys.has(cookieKey(c))) }))],
    };
    const pruned = pruneLedger(remaining, args.wipe ? new Set() : live.keys);
    writeLedger(PROFILE, pruned.ledger);
    const left = pruned.ledger.batches.reduce((n, b) => n + (b.cookies || []).length, 0);
    console.log(`\n账本上还剩 ${left} 条借来的 cookie。`);
    return stillThere.length ? 1 : 0;
  } finally {
    await closeIso(iso);
    if (!wasRunning) {
      const r = await launch.stopBrowserGracefully();
      console.log(`  为归还起的隔离实例已收掉（${r.how}，stopped=${r.stopped}）${r.fallbackReason ? ` —— ${r.fallbackReason}` : ""}`);
    } else {
      try {
        launch.markAdoptable();
      } catch {}
    }
  }
}

/*
 * 命令行入口。两个调用方共用它，收尾（删落盘的 cookie 明文）也就只有这一处：
 *   · `node scripts/borrow-login.mjs …`——git 检出直接跑这个文件
 *   · `npx @liang-hz/agent-in-chrome borrow-login …`——bin 的子命令 import 进来调它
 *
 * @param {string[]} argv 旗标，不含 node 和脚本名
 * @returns 退出码
 */
export async function runBorrowLogin(argv) {
  try {
    return (await main(argv)) || 0;
  } catch (e) {
    console.error(`\n\x1b[31m✗\x1b[0m ${e?.message || e}\n`);
    return 1;
  } finally {
    dropScratch();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runBorrowLogin(process.argv.slice(2));
}
