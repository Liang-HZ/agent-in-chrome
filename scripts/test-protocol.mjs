#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToken, bridgeEndpoint } from "../mcp/token.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-chrome-proto-"));
const ep = bridgeEndpoint;

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

const modernMeta = (version = "2026-07-28", extra = {}) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "proto-test", version: "1.0.0" },
  ...extra,
});

function startServer(name, env = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, "t.sock");
  const token = getToken(dir);
  const p = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
    env: {
      ...process.env,
      AGENT_IN_CHROME_SOCK: sock,
      AGENT_IN_CHROME_TRACE_DIR: path.join(dir, "traces"),
      AGENT_IN_CHROME_SHOT_DIR: path.join(dir, "shots"),
      AGENT_IN_CHROME_COOKIE_DIR: path.join(dir, "cookies"),
      AGENT_IN_CHROME_SESSION_ID: `proto-${name}`,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  const junk = [];
  let stderr = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => (stderr += d));
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        junk.push(line);
      }
    }
  });
  let n = 0;
  const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
  const rpc = (method, params, { timeout = 15000 } = {}) => {
    const id = ++n;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const hit = frames.find((f) => f.id === id);
        if (hit) {
          clearInterval(tick);
          res(hit);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(tick);
          rej(new Error(`${method} 超时`));
        }
      }, 10);
    });
  };
  return { p, sock, token, frames, junk, send, rpc, nextId: () => ++n, stderrText: () => stderr };
}

function fakeHost(sock, token, replies = {}, { delayMs = 0 } = {}) {
  const c = net.connect(ep(sock));
  c.setEncoding("utf8");
  const seen = [];
  let b = "";
  c.on("data", (chunk) => {
    b += chunk;
    let i;
    while ((i = b.indexOf("\n")) >= 0) {
      const line = b.slice(0, i).trim();
      b = b.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      seen.push(m);
      if (m.type === "call" && replies[m.tool]) {
        const reply = () => c.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: replies[m.tool](m) }) + "\n");
        if (delayMs > 0) setTimeout(reply, delayMs);
        else reply();
      }
    }
  });
  c.write(JSON.stringify({ type: "hello", role: "host", pid: 1, token }) + "\n");
  c.write(JSON.stringify({ type: "hello", role: "extension", version: "0.54.0" }) + "\n");
  return { c, seen };
}

const sockUp = (s) =>
  new Promise((resolve) => {
    const c = net.connect(ep(s));
    const done = (v) => {
      c.destroy();
      resolve(v);
    };
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
  });

console.log("\n\x1b[1m1. 版本协商矩阵（legacy initialize）\x1b[0m");
{
  const s = startServer("negotiate");
  const cases = [
    ["2025-11-25", "2025-11-25"],
    ["2025-06-18", "2025-06-18"],
    ["2025-03-26", "2025-03-26"],
    ["2024-11-05", "2024-11-05"],
    ["1900-01-01", "2025-11-25"],
    ["2099-01-01", "2025-11-25"],
    [undefined, "2025-11-25"],
  ];
  for (const [asked, want] of cases) {
    const r = await s.rpc("initialize", {
      protocolVersion: asked,
      capabilities: {},
      clientInfo: { name: "proto-test", version: "0" },
    });
    check(
      `initialize 报 ${asked === undefined ? "(缺省)" : asked} → 回 ${want}`,
      r.result?.protocolVersion === want,
      r.result?.protocolVersion
    );
  }
  const r2026 = await s.rpc("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "proto-test", version: "0" },
  });
  check(
    "客户端在 initialize 里报 2026-07-28，回的仍是 2025-11-25（legacy 永不回 modern 版本）",
    r2026.result?.protocolVersion === "2025-11-25",
    r2026.result?.protocolVersion
  );
  check("initialize 声明了 tools.listChanged", r2026.result?.capabilities?.tools?.listChanged === true);
  check("serverInfo 带上了 name/version", r2026.result?.serverInfo?.name === "agent-in-chrome" && !!r2026.result?.serverInfo?.version);
  check(
    "serverInfo 带 description / websiteUrl（Implementation 的可选字段）",
    typeof r2026.result?.serverInfo?.description === "string" &&
      /^https:\/\//.test(r2026.result?.serverInfo?.websiteUrl || ""),
    JSON.stringify(r2026.result?.serverInfo)
  );
  check("legacy initialize 的 result 里没有 resultType（那是 modern 才有的）", !("resultType" in (r2026.result || {})));
  s.p.kill();
}

console.log("\n\x1b[1m2. server/discover（2026-07-28 规定服务端 MUST 实现）\x1b[0m");
{
  const s = startServer("discover");
  const d = await s.rpc("server/discover", { _meta: modernMeta() });
  const R = d.result || {};
  check("回的是 result 不是 error（= 我们是 modern 服务端）", !!d.result, JSON.stringify(d).slice(0, 200));
  check("resultType 是 complete（Result 必带）", R.resultType === "complete", R.resultType);
  check("supportedVersions 含 2026-07-28", Array.isArray(R.supportedVersions) && R.supportedVersions.includes("2026-07-28"), JSON.stringify(R.supportedVersions));
  check(
    "supportedVersions 同时列出 legacy 版本（客户端才挑得到能用的那个）",
    (R.supportedVersions || []).includes("2025-11-25"),
    JSON.stringify(R.supportedVersions)
  );
  check("capabilities 报了 tools", !!R.capabilities?.tools, JSON.stringify(R.capabilities));
  check("_meta 带 serverInfo（规范：Servers SHOULD include this field）", R._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "agent-in-chrome", JSON.stringify(R._meta));
  check("ttlMs 是正数（CacheableResult 必填）", typeof R.ttlMs === "number" && R.ttlMs > 0, String(R.ttlMs));
  check("cacheScope 是 private（工具表因本机配置 / 客户端而异，标 public 是假的）", R.cacheScope === "private", R.cacheScope);
  const init = await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  check("discover 的 instructions 与 initialize 的逐字节相同", R.instructions === init.result?.instructions, `${(R.instructions || "").length} vs ${(init.result?.instructions || "").length}`);

  const bare = await s.rpc("server/discover", {});
  check("不带 _meta 的 discover 回 -32602（缺必填字段 = malformed）", bare.error?.code === -32602, JSON.stringify(bare).slice(0, 200));
  const noCaps = await s.rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  check("只带 protocolVersion、缺 clientCapabilities 也回 -32602", noCaps.error?.code === -32602, JSON.stringify(noCaps).slice(0, 200));
  s.p.kill();
}

console.log("\n\x1b[1m3. modern 分流与 UnsupportedProtocolVersionError\x1b[0m");
{
  const s = startServer("dispatch");
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const legacyList = await s.rpc("tools/list", {});
  const modernList = await s.rpc("tools/list", { _meta: modernMeta() });

  check(
    "legacy tools/list 的 result 只有 tools 这一个键（没有 resultType/ttlMs/cacheScope/_meta）",
    JSON.stringify(Object.keys(legacyList.result || {})) === JSON.stringify(["tools"]),
    JSON.stringify(Object.keys(legacyList.result || {}))
  );
  const legacyTools = legacyList.result.tools;
  const badKeys = legacyTools
    .map((t) => Object.keys(t).sort().join(","))
    .filter((k) => k !== "annotations,description,inputSchema,name");
  check("每个工具的键正好是 name/description/inputSchema/annotations", badKeys.length === 0, badKeys[0]);

  check("modern tools/list 带 resultType:complete", modernList.result?.resultType === "complete");
  check("modern tools/list 带 ttlMs / cacheScope（ListToolsResult extends CacheableResult）", typeof modernList.result?.ttlMs === "number" && modernList.result?.cacheScope === "private");
  check("modern tools/list 带 _meta.serverInfo", modernList.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "agent-in-chrome");
  check(
    "两个时代的 tools 数组逐字节相同（年代差别只在外面那层壳上）",
    JSON.stringify(modernList.result.tools) === JSON.stringify(legacyTools)
  );

  const bad = await s.rpc("tools/list", { _meta: modernMeta("1900-01-01") });
  check("modern 帧报未知版本 → -32022", bad.error?.code === -32022, JSON.stringify(bad).slice(0, 220));
  check("message 是 Unsupported protocol version", bad.error?.message === "Unsupported protocol version", bad.error?.message);
  check("data.requested 原样回显", bad.error?.data?.requested === "1900-01-01", JSON.stringify(bad.error?.data));
  check("data.supported 含 2026-07-28", (bad.error?.data?.supported || []).includes("2026-07-28"), JSON.stringify(bad.error?.data?.supported));
  check(
    "data.supported 与 discover 的 supportedVersions 是同一份（否则客户端会按你给的版本重发、你又拒了）",
    JSON.stringify(bad.error.data.supported) === JSON.stringify((await s.rpc("server/discover", { _meta: modernMeta() })).result.supportedVersions)
  );
  const noCaps = await s.rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  check("modern 帧缺 clientCapabilities → -32602（规范原文的 MUST）", noCaps.error?.code === -32602, JSON.stringify(noCaps).slice(0, 200));

  const mcall = await s.rpc("tools/call", { name: "browser_status", arguments: {}, _meta: modernMeta() });
  check("带 modern _meta 的 tools/call 走 modern 语义（result 带 resultType）", mcall.result?.resultType === "complete", JSON.stringify(mcall.result).slice(0, 160));
  const lcall = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("不带 _meta 的 tools/call 仍是老形状（没有 resultType）", !!lcall.result && !("resultType" in lcall.result));

  const un = await s.rpc("resources/list", {});
  check("没声明的 capability 对应的方法回 -32601", un.error?.code === -32601, JSON.stringify(un).slice(0, 160));
  const before = s.frames.length;
  s.send({ jsonrpc: "2.0", method: "notifications/whatever", params: {} });
  await sleep(200);
  check("未知 notifications 静默丢弃，不回任何东西", s.frames.length === before, `多出 ${s.frames.length - before} 帧`);
  s.p.kill();
}

console.log("\n\x1b[1m4. stdout 纯净（规范：MUST NOT write anything to stdout that is not a valid MCP message）\x1b[0m");
{
  const s = startServer("stdout");
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await s.rpc("tools/list", {});
  await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  await s.rpc("tools/call", { name: "browser_trace", arguments: { list: true } });
  await s.rpc("server/discover", { _meta: modernMeta() });
  check("跑完一串调用，stdout 上每一行都是合法 JSON", s.junk.length === 0, JSON.stringify(s.junk.slice(0, 2)));
  s.p.kill();

  const dir = path.join(TMP, "mutate");
  fs.mkdirSync(dir, { recursive: true });
  const probe = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import ${JSON.stringify(new URL("../mcp/server.mjs", import.meta.url).href)};` +
        `console.log("MUTANT-LOG");console.info("MUTANT-INFO");console.debug("MUTANT-DEBUG");` +
        `setTimeout(() => process.exit(0), 300);`,
    ],
    {
      env: {
        ...process.env,
        AGENT_IN_CHROME_SOCK: path.join(dir, "t.sock"),
        AGENT_IN_CHROME_TRACE_DIR: path.join(dir, "traces"),
        AGENT_IN_CHROME_SESSION_ID: "proto-mutate",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let mo = "";
  let me = "";
  probe.stdout.on("data", (d) => (mo += d));
  probe.stderr.on("data", (d) => (me += d));
  await new Promise((r) => probe.on("exit", r));
  check("console.log 不落 stdout", !/MUTANT-LOG/.test(mo), mo.slice(0, 200));
  check("console.info 不落 stdout", !/MUTANT-INFO/.test(mo));
  check("console.debug 不落 stdout", !/MUTANT-DEBUG/.test(mo));
  check("三条都落到了 stderr（是钉过去了，不是被吃掉了）", /MUTANT-LOG/.test(me) && /MUTANT-INFO/.test(me) && /MUTANT-DEBUG/.test(me), me.slice(0, 200));

  const swSrc = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  const offenders = [...swSrc.matchAll(/console\.(log|info|debug|dir|table|trace)\s*\(/g)].map((m) => m[0]);
  check(
    "extension/sw.js 里没有任何 console.log/info/debug（CLI 模式下它们写的是 JSON-RPC 通道）",
    offenders.length === 0,
    offenders.join("、")
  );
}

console.log("\n\x1b[1m5. 被关掉的工具走 isError 的内容（SEP-1303）\x1b[0m");
{
  const dir = path.join(TMP, "disabled");
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ tools: { profile: "observe" } }));
  const s = startServer("disabled", { AGENT_IN_CHROME_CONFIG: cfg });
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  const r = await s.rpc("tools/call", { name: "browser_click", arguments: { ref: "ref_1" } });
  check("不是协议错误", !r.error, JSON.stringify(r).slice(0, 200));
  check("是 isError:true 的内容（模型读得到，才可能自我纠正）", r.result?.isError === true && typeof r.result?.content?.[0]?.text === "string");
  check("文案说的是「关掉了」而不是「未知工具」", /关掉了/.test(r.result?.content?.[0]?.text || ""));
  const un = await s.rpc("tools/call", { name: "browser_nope", arguments: {} });
  check("真不存在的工具仍回 -32602（Unknown tool 是规范点名的 Protocol Error）", un.error?.code === -32602, JSON.stringify(un).slice(0, 160));
  const m = await s.rpc("tools/call", { name: "browser_click", arguments: { ref: "ref_1" }, _meta: modernMeta() });
  check("modern 帧里同样是 isError 的内容，且带 resultType", m.result?.isError === true && m.result?.resultType === "complete");
  s.p.kill();
}

console.log("\n\x1b[1m6. _meta 前缀零冲突：四家客户端实样过 sidFor 的结果\x1b[0m");
{
  const s = startServer("sid");
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  const h = fakeHost(s.sock, s.token, { status: () => ({ version: "0.54.0", connected: true, session: "x", tabs: [] }) });
  check("假 host 连上了", await until(() => h.seen.length >= 0 && sockUp(s.sock)));
  await until(() => s.frames.length >= 0, 100);

  const samples = [
    ["Claude Code", { "claudecode/toolUseId": "toolu_01ABCDEF", progressToken: 2 }, "proto-sid"],
    ["ZCode", { session_id: "zc-sess-123" }, "proto-sid::zc-sess-123"],
    ["Trae", { chatSessionId: "trae-chat-9" }, "proto-sid"],
    ["Antigravity", { "antigravity.google/conversation_id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }, "proto-sid::3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
  ];
  for (const [who, meta, wantSid] of samples) {
    const before = h.seen.length;
    await s.rpc("tools/call", { name: "browser_status", arguments: {}, _meta: meta });
    const frame = h.seen.slice(before).find((f) => f.type === "call" && f.tool === "status");
    check(`${who} 的 _meta → 过桥那一帧的 session = ${wantSid}`, frame?.session === wantSid, frame?.session);
  }
  check("chatSessionId 不参与 sid 派生（回落成进程级 sid）", true);

  const src = fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8");
  const written = [...src.matchAll(/_meta:\s*\{\s*\[?([A-Za-z_.\/"']+)/g)].map((m) => m[1]);
  check(
    "server.mjs 里往 _meta 写的键只有 META_SERVER_INFO 这一个",
    written.length > 0 && written.every((k) => k === "META_SERVER_INFO"),
    written.join("、")
  );
  h.c.destroy();
  s.p.kill();
}

console.log("\n\x1b[1m7. 工具 annotations（每个工具都要有，且不许自相矛盾）\x1b[0m");
{
  const s = startServer("anno", { AGENT_IN_CHROME_DEV: "1" });
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  const tools = (await s.rpc("tools/list", {})).result.tools;
  const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
  check(`每个工具都有 annotations（${tools.length} 个）`, missing.length === 0, missing.join("、"));
  const KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const incomplete = tools.filter((t) => KEYS.some((k) => typeof t.annotations?.[k] !== "boolean")).map((t) => t.name);
  check("四个 hint 都显式给了布尔值（不靠规范默认值猜）", incomplete.length === 0, incomplete.join("、"));
  const contradict = tools.filter((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint).map((t) => t.name);
  check("只读工具不许同时标 destructiveHint", contradict.length === 0, contradict.join("、"));
  const ro = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
  check(`确实按工具逐个定的（只读 ${ro.length} 个 / 共 ${tools.length} 个，不是一刀切）`, ro.length > 3 && ro.length < tools.length - 3, ro.join("、"));
  const by = new Map(tools.map((t) => [t.name, t.annotations]));
  check("browser_status / tabs_list / read_page / find 是只读", ["browser_status", "browser_tabs_list", "browser_read_page", "browser_find"].every((n) => by.get(n)?.readOnlyHint === true));
  check(
    "browser_navigate 不是只读（以用户身份发 GET，退订/注销/删除都可能是 GET）",
    by.get("browser_navigate")?.readOnlyHint === false && by.get("browser_navigate")?.destructiveHint === true
  );
  check("browser_new_tab 同一口径（带 url 就是同一次 GET）", by.get("browser_new_tab")?.readOnlyHint === false && by.get("browser_new_tab")?.destructiveHint === true);
  check("browser_eval / cdp / close_all / close_tab 标了破坏性", ["browser_eval", "browser_cdp", "browser_close_all", "browser_close_tab"].every((n) => by.get(n)?.destructiveHint === true));
  check(
    "browser_wait_for 不是只读（js 参数在页面主世界里求值，和 browser_eval 同一个世界）",
    by.get("browser_wait_for")?.readOnlyHint === false
  );
  check("browser_trace 是封闭域（只读本机文件，不碰网络）", by.get("browser_trace")?.openWorldHint === false && by.get("browser_trace")?.readOnlyHint === true);
  check("DEV_MODE 下的 browser_reload_extension 也有 annotations", !!by.get("browser_reload_extension"));
  s.p.kill();
}

console.log("\n\x1b[1m8. 进度通知（慢工具 + progressToken）\x1b[0m");
{
  const s = startServer("progress");
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  const h = fakeHost(s.sock, s.token, { status: () => ({ connected: true, tabs: [] }) });
  await until(() => sockUp(s.sock));
  const callId = s.nextId();
  s.send({
    jsonrpc: "2.0",
    id: callId,
    method: "tools/call",
    params: { name: "browser_navigate", arguments: { url: "https://example.com" }, _meta: { progressToken: "pt-1" } },
  });
  const prog = () => s.frames.filter((f) => f.method === "notifications/progress" && f.params?.progressToken === "pt-1");
  check("发出后立刻有一条「已发出」", await until(() => prog().length >= 1, 3000), JSON.stringify(prog()));
  check("等待期间有心跳（≥3 条）", await until(() => prog().length >= 3, 9000), `${prog().length} 条`);
  const ps = prog();
  check("progress 单调递增（规范：MUST increase with each notification）", ps.every((f, i) => i === 0 || f.params.progress > ps[i - 1].params.progress), ps.map((f) => f.params.progress).join(","));
  check("每条都带 message，且没有编造出来的百分比", ps.every((f) => typeof f.params.message === "string" && f.params.message.length > 0) && ps.every((f) => f.params.total === undefined), JSON.stringify(ps[0]?.params));
  check("第一条说的是「已发出」", /已发出/.test(ps[0]?.params?.message || ""), ps[0]?.params?.message);
  check("心跳报的是实测已等时长", /已 \d+ms/.test(ps[1]?.params?.message || ""), ps[1]?.params?.message);
  const navFrame = h.seen.find((f) => f.type === "call" && f.tool === "navigate");
  check("navigate 确实过了桥（这一节测的是真的在等，不是当场失败）", !!navFrame, JSON.stringify(h.seen.slice(-2)));
  h.c.write(JSON.stringify({ id: navFrame.id, type: "result", ok: true, data: { ok: true } }) + "\n");
  check("调用本身正常返回", await until(() => s.frames.some((f) => f.id === callId && f.result?.isError === false), 5000), JSON.stringify(s.frames.find((f) => f.id === callId)));
  check("调用结束后补一条「完成」", await until(() => /完成/.test(prog().slice(-1)[0]?.params?.message || ""), 5000), prog().slice(-1)[0]?.params?.message);
  const after = prog().length;
  await sleep(3500);
  check("完成之后不再发（规范：Progress notifications MUST stop after completion）", prog().length === after, `又多了 ${prog().length - after} 条`);

  const before2 = s.frames.filter((f) => f.method === "notifications/progress").length;
  await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("不带 progressToken 就一条都不发", s.frames.filter((f) => f.method === "notifications/progress").length === before2);
  await s.rpc("tools/call", { name: "browser_status", arguments: {}, _meta: { progressToken: "pt-2" } });
  check("快工具带了 token 也不发（协议允许「选择不发」）", s.frames.filter((f) => f.params?.progressToken === "pt-2").length === 0);
  h.c.destroy();
  s.p.kill();
}

console.log("\n\x1b[1m9. 取消真的把活停掉（不是收下就丢）\x1b[0m");
{
  const s = startServer("cancel");
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  const h = fakeHost(s.sock, s.token, {});
  await until(() => sockUp(s.sock));
  const callId = s.nextId();
  s.send({
    jsonrpc: "2.0",
    id: callId,
    method: "tools/call",
    params: { name: "browser_wait_for", arguments: { selector: "#never", timeoutMs: 60000 } },
  });
  check("调用已经下发到桥接", await until(() => h.seen.some((f) => f.type === "call" && f.tool === "wait_for"), 5000), JSON.stringify(h.seen.slice(-1)));
  const bridgeId = h.seen.find((f) => f.type === "call" && f.tool === "wait_for").id;
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: callId, reason: "user pressed Ctrl-C" } });
  check(
    "往桥接发了 cancel 帧（工具层据此停下轮询）",
    await until(() => h.seen.some((f) => f.type === "cancel" && f.id === bridgeId), 3000),
    JSON.stringify(h.seen.filter((f) => f.type === "cancel"))
  );
  await sleep(1500);
  check("被取消的调用不回任何 response（规范的 SHOULD NOT send a response）", !s.frames.some((f) => f.id === callId), JSON.stringify(s.frames.find((f) => f.id === callId)));
  const beforeSecond = s.frames.length;
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: callId } });
  await sleep(300);
  check("重复取消同一个 id：静默忽略，不回任何东西（规范 Error Handling）", s.frames.length === beforeSecond);
  const beforeUnknown = s.frames.length;
  s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "no-such-id" } });
  await sleep(300);
  check("取消一个不认识的 id：同样静默忽略", s.frames.length === beforeUnknown);

  const ok = await s.rpc("tools/call", { name: "browser_trace", arguments: { list: true } });
  check("取消之后 server 照常服务下一次调用", ok.result?.isError === false, JSON.stringify(ok).slice(0, 160));
  h.c.destroy();
  s.p.kill();
}

{
  console.log("\n\x1b[1m10. 前台归还：foreground-restore 过桥\x1b[0m");
  const dir = fs.mkdtempSync(path.join(TMP, "fg-"));
  const log = path.join(dir, "helper-stdin.log");
  const helper = path.join(dir, "fake-helper.sh");
  fs.writeFileSync(
    helper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'const fs=require("fs");process.stdin.on("data",d=>fs.appendFileSync(${JSON.stringify(log)},d));process.stdin.on("end",()=>process.exit(0));setInterval(()=>{},1e9)'\n`
  );
  fs.chmodSync(helper, 0o755);
  const lines = () => {
    try {
      return fs.readFileSync(log, "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };

  const s = startServer("fgguard", { AGENT_IN_CHROME_FG_HELPER: helper });
  await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p", version: "1" } });
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const h = fakeHost(s.sock, s.token, { status: () => ({ connected: true, tabs: [] }) });
  await sleep(300);

  const r1 = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("前置：工具调用真的过了桥", h.seen.some((m) => m.type === "call" && m.tool === "status"), JSON.stringify(h.seen).slice(0, 200));
  for (let i = 0; i < 60 && lines().length === 0; i++) await sleep(50);
  if (process.platform !== "darwin") {
    check("非 macOS：一次都没起 helper（整套空实现）", lines().length === 0, JSON.stringify(lines()));
    check("非 macOS：foreground-restore 帧也不该让 server 出事", true);
    h.c.write(JSON.stringify({ type: "foreground-restore", tabId: 1, sid: "x" }) + "\n");
    await sleep(300);
    const r2 = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
    check("非 macOS：收下那一帧之后 server 照常服务", r2.result?.isError === false, JSON.stringify(r2).slice(0, 160));
  } else {
    check("每一次工具下发都武装了一次", lines().filter((l) => l.startsWith("arm ")).length >= 1, JSON.stringify(lines()));
    check("这时还一次 confirm 都没有（结果因还没来）", lines().filter((l) => l === "confirm").length === 0, JSON.stringify(lines()));

    h.c.write(JSON.stringify({ type: "foreground-restore", tabId: 42, sid: "proto-fgguard", restored: { activeRestored: null, focusRestored: null } }) + "\n");
    await sleep(500);
    check("结果因过了桥：helper 的 stdin 上多出一行 confirm", lines().filter((l) => l === "confirm").length === 1, JSON.stringify(lines()));

    const r2 = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
    check("收下那一帧之后桥接照常（没被当成 result、也没断线）", r2.result?.isError === false, JSON.stringify(r2).slice(0, 160));

    const s2 = startServer("fgoff", { AGENT_IN_CHROME_FG_HELPER: helper, AGENT_IN_CHROME_NO_FG_GUARD: "1" });
    const log0 = lines().length;
    await s2.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p", version: "1" } });
    s2.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const h2 = fakeHost(s2.sock, s2.token, { status: () => ({ connected: true, tabs: [] }) });
    await sleep(300);
    await s2.rpc("tools/call", { name: "browser_status", arguments: {} });
    h2.c.write(JSON.stringify({ type: "foreground-restore", tabId: 7, sid: "proto-fgoff" }) + "\n");
    await sleep(500);
    check("AGENT_IN_CHROME_NO_FG_GUARD=1：一个字都不往 helper 写", lines().length === log0, JSON.stringify(lines().slice(log0)));
    h2.c.destroy();
    s2.p.kill();
  }
  h.c.destroy();
  s.p.kill();
}

const initClient = async (s) => {
  await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p", version: "1" } });
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
};
const forwardedCalls = (h) => h.seen.filter((m) => m.type === "call" && /^f\d+$/.test(String(m.id)));
const ownCalls = (h) => h.seen.filter((m) => m.type === "call" && /^c\d+$/.test(String(m.id)));

console.log("\n\x1b[1m10. browser_status.update（手动查更新的口）\x1b[0m");
{
  const s = startServer("update-field", { AGENT_IN_CHROME_NO_UPDATE_NOTIFIER: "1" });
  await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "proto-test", version: "0" } });
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const h = fakeHost(s.sock, s.token, { status: () => ({ connected: true, tabs: [] }) });
  await sleep(300);

  const r = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  let data = {};
  try {
    data = JSON.parse(r.result?.content?.[0]?.text || "{}");
  } catch {}
  const u = data.update;
  check("browser_status 带 update 字段", !!u && typeof u === "object", JSON.stringify(data).slice(0, 300));
  check("update.current 就是本机 server 版本", u?.current === data.versions?.server && typeof u?.current === "string", JSON.stringify(u));
  check("update 三个键齐全（少一个客户端就得靠 undefined 猜）", u && "current" in u && "latest" in u && "hasUpdate" in u, JSON.stringify(u));
  check("查询关掉时 latest 是 null，不是 undefined 也不是瞎猜的版本号", u?.latest === null, JSON.stringify(u));
  check("latest 不知道时 hasUpdate 必须是 false（宁可漏报不误报）", u?.hasUpdate === false, JSON.stringify(u));

  const r2 = await s.rpc("tools/call", { name: "browser_status", arguments: {} });
  let u2 = {};
  try {
    u2 = JSON.parse(r2.result?.content?.[0]?.text || "{}").update;
  } catch {}
  check("连问两次拿到同一份（这是快照不是一次性消息）", JSON.stringify(u2) === JSON.stringify(u), `${JSON.stringify(u)} vs ${JSON.stringify(u2)}`);
  check("这一节跑下来 stdout 没脏（更新查询不许往协议流里写字）", s.junk.length === 0, JSON.stringify(s.junk.slice(0, 2)));

  h.c.destroy();
  s.p.kill();
}

console.log("\n\x1b[1m11. isNewerVersion（纯函数）\x1b[0m");
{
  const cases = [
    ["0.9.0:0.10.0", "not-newer"],
    ["0.10.0:0.9.0", "newer"],
    ["0.55.0:0.55.0", "not-newer"],
    ["0.55.1:0.55.0", "newer"],
    ["0.54.9:0.55.0", "not-newer"],
    ["1.0.0:0.99.99", "newer"],
    ["0.55:0.55.0", "not-newer"],
    ["0.55.0.1:0.55.0", "newer"],
    ["0.56.0-beta.1:0.55.0", "newer"],
    ["0.55.0-beta.1:0.55.0", "not-newer"],
    ["abc:0.55.0", "not-newer"],
    ["0.55.0:abc", "not-newer"],
  ];
  const out = execFileSync(process.execPath, [path.join(ROOT, "mcp", "server.mjs"), "--compare-versions", ...cases.map(([p]) => p)], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  check("--compare-versions 每对回一行", out.length === cases.length, out.join(" | "));
  for (let i = 0; i < cases.length; i++) {
    const [pair, want] = cases[i];
    check(`isNewerVersion(${pair.replace(":", ", ")}) → ${want}`, out[i] === `${pair} ${want}`, out[i]);
  }
}

console.log("\n\x1b[1m11b. 同版本 / 更旧 / 不报版本的从：一律不让位\x1b[0m");
{
  const A = startServer("noyield-a", { AGENT_IN_CHROME_FAKE_VERSION: "0.55.0" });
  await initClient(A);
  check("主起来了，端点在 listen", await until(() => sockUp(A.sock)));
  const h = fakeHost(A.sock, A.token, { status: () => ({ connected: true, tabs: [] }) });
  await sleep(300);

  const B = startServer("noyield-b", { AGENT_IN_CHROME_SOCK: A.sock, AGENT_IN_CHROME_FAKE_VERSION: "0.55.0" });
  await initClient(B);
  const rb = await B.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("同版本的从：调用照样通", rb.result?.isError === false, JSON.stringify(rb).slice(0, 160));
  check("同版本的从是**被代发**的（f* id）＝ 它没当上主", forwardedCalls(h).length >= 1, JSON.stringify(h.seen).slice(0, 200));
  check("同版本不让位：主一个字的让位日志都没有", !/桥接让位/.test(A.stderrText()), A.stderrText().slice(-300));

  const C = startServer("noyield-c", { AGENT_IN_CHROME_SOCK: A.sock, AGENT_IN_CHROME_FAKE_VERSION: "0.54.0" });
  await initClient(C);
  const rc = await C.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("更旧的从：调用照样通", rc.result?.isError === false, JSON.stringify(rc).slice(0, 160));
  check("更旧的从不让位", !/桥接让位/.test(A.stderrText()), A.stderrText().slice(-300));

  const raw = net.connect(ep(A.sock));
  raw.on("error", () => {});
  raw.write(JSON.stringify({ type: "hello", role: "peer", pid: 99999, token: A.token }) + "\n");
  await sleep(600);
  check("不报版本的从（升级前的老会话）不让位", !/桥接让位/.test(A.stderrText()), A.stderrText().slice(-300));

  const before = forwardedCalls(h).length;
  const rb2 = await B.rpc("tools/call", { name: "browser_status", arguments: {} });
  check(
    "三种从都连上之后，主还是那个主（同一条 host 连接上又代发了一次）",
    rb2.result?.isError === false && forwardedCalls(h).length > before,
    `before=${before} after=${forwardedCalls(h).length} ${JSON.stringify(rb2).slice(0, 160)}`
  );

  raw.destroy();
  h.c.destroy();
  A.p.kill();
  B.p.kill();
  C.p.kill();
}

console.log("\n\x1b[1m11c. 更新版本的从连上来：老主让位，在飞的调用不丢\x1b[0m");
{
  const O = startServer("yield-old", { AGENT_IN_CHROME_FAKE_VERSION: "0.55.0" });
  await initClient(O);
  check("老主起来了，端点在 listen", await until(() => sockUp(O.sock)));
  const h1 = fakeHost(O.sock, O.token, { status: () => ({ connected: true, tabs: [] }) }, { delayMs: 1200 });
  await sleep(300);
  const inflight = O.rpc("tools/call", { name: "browser_status", arguments: {} });
  await sleep(250);
  check("让位发起前，老主手上确实有一条在飞的调用", ownCalls(h1).length === 1 && !O.frames.some((f) => f.id === 2));

  const P = startServer("yield-bystander", { AGENT_IN_CHROME_SOCK: O.sock, AGENT_IN_CHROME_FAKE_VERSION: "0.55.0" });
  await initClient(P);
  const N = startServer("yield-new", { AGENT_IN_CHROME_SOCK: O.sock, AGENT_IN_CHROME_FAKE_VERSION: "0.56.0" });
  await initClient(N);
  check("老主认出对面更新，开始让位", await until(() => /桥接让位/.test(O.stderrText()), 5000), O.stderrText().slice(-400));

  const r1 = await inflight;
  check("让位期间在飞的那条调用照常拿到结果（排空跑完才交端点）", r1.result?.isError === false, JSON.stringify(r1).slice(0, 200));
  check("排空没有超时（日志里没有那句超时）", !/让位排空超时/.test(O.stderrText()), O.stderrText().slice(-400));

  check("新版本的从收到 yield 帧并接管", await until(() => /正在接管/.test(N.stderrText()), 6000), N.stderrText().slice(-400));
  check("端点重新 listen 上了（新主 bind 成功）", await until(() => sockUp(O.sock), 6000));

  const h2 = fakeHost(O.sock, O.token, { status: () => ({ connected: true, tabs: [] }) });
  const rn = await N.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("新主能干活：它的调用直达 host（c* id，不是代发）", rn.result?.isError === false && ownCalls(h2).length >= 1, JSON.stringify(h2.seen).slice(0, 200));

  check(
    "老主让位后没变成孤儿：它的调用现在走新主代发（f* id）",
    await until(async () => {
      const r = await O.rpc("tools/call", { name: "browser_status", arguments: {} }).catch(() => null);
      return r?.result?.isError === false && forwardedCalls(h2).length >= 1;
    }, 12000, 500),
    `${O.stderrText().slice(-400)} | ${JSON.stringify(h2.seen).slice(0, 200)}`
  );

  check(
    "旁观的第三个会话自己重连到了新主（复用 gone() 那条自愈路）",
    await until(async () => {
      const r = await P.rpc("tools/call", { name: "browser_status", arguments: {} }).catch(() => null);
      return r?.result?.isError === false;
    }, 12000, 500),
    P.stderrText().slice(-400)
  );

  h2.c.destroy();
  h1.c.destroy();
  O.p.kill();
  N.p.kill();
  P.p.kill();
}

console.log(failed ? `\n\x1b[31m${passed} 通过, ${failed} 失败\x1b[0m` : `\n\x1b[32m${passed} 通过, ${failed} 失败\x1b[0m`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(failed ? 1 : 0);
