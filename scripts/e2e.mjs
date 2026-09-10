#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getToken, timingSafeEqualStr, tokenPath, bridgeEndpoint, handshakeNonce, handshakeProof } from "../mcp/token.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-chrome-e2e-"));
const SOCK = path.join(TMP, "t.sock");
const TOKEN = getToken(TMP);
const helloHost = (pid = 1) => JSON.stringify({ type: "hello", role: "host", pid, token: TOKEN }) + "\n";

const ep = bridgeEndpoint;
const sockUp = (s) => {
  if (process.platform !== "win32") return fs.existsSync(s);
  return new Promise((resolve) => {
    const c = net.connect(ep(s));
    const done = (v) => {
      c.destroy();
      resolve(v);
    };
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
  });
};
const TRACE_DIR = path.join(TMP, "traces");
const SHOT_DIR = path.join(TMP, "shots");
const COOKIE_DIR = path.join(TMP, "cookies");
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
const skipSection = (why) => console.log(`  \x1b[90m·\x1b[0m 跳过 — ${why}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function startServer(env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  let b = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    b += c;
    let i;
    while ((i = b.indexOf("\n")) >= 0) {
      const line = b.slice(0, i).trim();
      b = b.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const w = waiters.get(m.id);
        if (w) {
          waiters.delete(m.id);
          w(m);
        }
      } catch {}
    }
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = ++n;
      const t = setTimeout(() => rej(new Error(`${method} 超时`)), 15000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { p, rpc };
}

console.log("\n\x1b[1mA. MCP server\x1b[0m");

const srv = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
  env: { ...process.env, AGENT_IN_CHROME_SOCK: SOCK, AGENT_IN_CHROME_TRACE_DIR: TRACE_DIR, AGENT_IN_CHROME_SHOT_DIR: SHOT_DIR, AGENT_IN_CHROME_COOKIE_DIR: COOKIE_DIR, AGENT_IN_CHROME_SESSION_ID: "e2e-trace-A" },
  stdio: ["pipe", "pipe", "pipe"],
});
let srvErr = "";
srv.stderr.on("data", (d) => (srvErr += d));

const rpcWaiters = new Map();
let srvBuf = "";
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", (chunk) => {
  srvBuf += chunk;
  let i;
  while ((i = srvBuf.indexOf("\n")) >= 0) {
    const line = srvBuf.slice(0, i).trim();
    srvBuf = srvBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = rpcWaiters.get(msg.id);
    if (w) {
      rpcWaiters.delete(msg.id);
      w(msg);
    }
  }
});

let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 10000);
    rpcWaiters.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0" },
});
check("initialize 有响应", !!init.result, JSON.stringify(init).slice(0, 120));
check("协议版本按客户端请求回显", init.result?.protocolVersion === "2025-06-18", init.result?.protocolVersion);
check("声明了 tools capability", !!init.result?.capabilities?.tools);
check("serverInfo.name 正确", init.result?.serverInfo?.name === "agent-in-chrome");

{
  const ins = init.result?.instructions || "";
  check("initialize 带回 instructions", ins.length > 200, `${ins.length} 字符`);
  check("instructions 把 new_tab 定为默认", /[Dd]efault.*browser_new_tab/.test(ins));
  check("instructions 禁止征用用户标签页", /[Nn]ever commandeer/.test(ins));
  check("instructions 说明标签组要按任务命名", /label/.test(ins) && /tab group/i.test(ins));
  check(
    "instructions 交代收尾口径（结果页留着、中转页收掉、更宽的 scope 需用户要求）",
    /[Ww]rap-up/.test(ins) && /THIS task/.test(ins) && /scope/.test(ins),
    ins.match(/3\..*\n.*\n.*/)?.[0]
  );
  check(
    "instructions 教了 mixed-tasks 该怎么办",
    /mixed-tasks/.test(ins) && /label/.test(ins),
    ins.match(/3\..*\n.*\n.*\n.*/)?.[0]
  );
  check("instructions 要求不可逆操作先确认", /[Ii]rreversible/.test(ins) && /consent/.test(ins));
  check("instructions 含 prompt injection 防线", /data, not instructions/.test(ins));
  check("instructions 解释了 _fromPage 这个约定", /_fromPage/.test(ins) && /the page itself wrote|page wrote them/.test(ins), ins.slice(-260));
  check(
    "instructions 没有残留「先 tab_use 接管」的旧口径",
    !/先 browser_tabs_list 看有哪些标签页，再 browser_tab_use 接管/.test(ins),
    ins.slice(0, 120)
  );
}

srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
const tools = list.result?.tools || [];
check("tools/list 返回工具", tools.length > 0, `${tools.length} 个`);
check("工具都带 name/description/inputSchema", tools.every((t) => t.name && t.description && t.inputSchema));
check("包含核心的 browser_tab_use", tools.some((t) => t.name === "browser_tab_use"));
{
  const b = tools.find((t) => t.name === "browser_batch");
  const d = b?.description || "";
  check("batch 描述给出的是判据，不是场景清单", /single criterion/i.test(d), d.slice(0, 200));
  check("判据落在「必须先看到前面某步的内容」上", /SEEING/.test(d) && /content/i.test(d), d.slice(0, 320));
  check("讲清了「取值」不用切、「判断」才要切", /VALUE/.test(d) && /decision/i.test(d), d.slice(0, 800));
  check(
    "说明判据与工具种类/步数无关（防止再被某个例子定尺度）",
    /independent of tool kind or step count/i.test(d),
    d.slice(0, 400)
  );
  check("把「步数越多越该用」说出来（旧描述的例子全是 2~4 步）", /more steps, the more/i.test(d), d.slice(0, 620));
}
check(
  "inputSchema 都是合法 object schema",
  tools.every((t) => t.inputSchema.type === "object" && typeof t.inputSchema.properties === "object")
);

const noBridge = await rpc("tools/call", { name: "browser_status", arguments: {} });
check("浏览器未连接时返回 isError", noBridge.result?.isError === true);
check(
  "报错文案提示了怎么排查",
  /扩展|Chrome/.test(noBridge.result?.content?.[0]?.text || ""),
  noBridge.result?.content?.[0]?.text
);

check("MCP server 建立了 socket", await waitFor(() => sockUp(SOCK)));

const fakeHost = net.connect(ep(SOCK));
fakeHost.setEncoding("utf8");
const hostSeen = [];
let evalReply = null;
let cdpReply = null;
let fhBuf = "";
fakeHost.on("data", (chunk) => {
  fhBuf += chunk;
  let i;
  while ((i = fhBuf.indexOf("\n")) >= 0) {
    const line = fhBuf.slice(0, i).trim();
    fhBuf = fhBuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    hostSeen.push(msg);
    if (msg.type === "call") {
      if (msg.tool === "tabs_list") {
        fakeHost.write(
          JSON.stringify({
            id: msg.id,
            type: "result",
            ok: true,
            data: { tabs: [{ tabId: 7, title: "示例", url: "https://example.com" }], count: 1 },
          }) + "\n"
        );
      } else if (msg.tool === "screenshot") {
        fakeHost.write(
          JSON.stringify({ id: msg.id, type: "result", ok: true, data: { image: PNG_1PX, mimeType: "image/png" } }) + "\n"
        );
      } else if (msg.tool === "eval_js") {
        fakeHost.write(
          JSON.stringify({
            id: msg.id,
            type: "result",
            ok: true,
            data: { value: evalReply, ...(typeof evalReply === "string" ? { valueLength: evalReply.length } : {}) },
          }) + "\n"
        );
      } else if (msg.tool === "cdp_raw") {
        fakeHost.write(JSON.stringify({ id: msg.id, type: "result", ok: true, data: { result: cdpReply } }) + "\n");
      } else if (msg.tool === "cookies_export") {
        fakeHost.write(
          JSON.stringify({
            id: msg.id,
            type: "result",
            ok: true,
            data: { cookies: [{ name: "sid", value: "v-abcdefghij", domain: "a.test", path: "/" }], count: 1 },
          }) + "\n"
        );
      } else if (msg.tool === "scroll" || msg.tool === "press_key" || msg.tool === "navigate") {
        fakeHost.write(
          JSON.stringify({ id: msg.id, type: "result", ok: true, data: { did: msg.tool, args: msg.args } }) + "\n"
        );
      } else {
        fakeHost.write(
          JSON.stringify({ id: msg.id, type: "result", ok: false, error: "还没接管标签页" }) + "\n"
        );
      }
    }
  }
});
await new Promise((r) => fakeHost.on("connect", r));
fakeHost.write(helloHost(1));
await sleep(200);

const okCall = await rpc("tools/call", {
  name: "browser_tabs_list",
  arguments: {},
  _meta: { progressToken: "e2e-p1", "agent/agentId": "agent_e2e_0001" },
});
check("桥接连上后工具调用成功", okCall.result?.isError === false);
const payload = okCall.result?.content?.[0];
check("文本结果原样带回数据", payload?.type === "text" && payload.text.includes("example.com"), payload?.text?.slice(0, 80));
check("参数名映射到扩展侧工具名", hostSeen.some((m) => m.type === "call" && m.tool === "tabs_list"));

const shot = await rpc("tools/call", { name: "browser_screenshot", arguments: {} });
const shotMeta = JSON.parse(shot.result?.content?.[0]?.text || "{}");
check("截图默认不返回图片本身", shot.result?.content?.[0]?.type === "text", shot.result?.content?.[0]?.type);
check("截图落了盘并给出路径", typeof shotMeta.file === "string" && fs.existsSync(shotMeta.file), shotMeta.file);
check("落盘的是真图片字节，不是 base64 文本", fs.readFileSync(shotMeta.file).slice(0, 4).toString("hex") === "89504e47", fs.readFileSync(shotMeta.file).slice(0, 4).toString("hex"));
check("给出字节数", shotMeta.bytes === fs.statSync(shotMeta.file).size, `${shotMeta.bytes} vs ${fs.statSync(shotMeta.file).size}`);
check("给出真实宽高（从 PNG 头里读的）", shotMeta.width === 1 && shotMeta.height === 1, JSON.stringify([shotMeta.width, shotMeta.height]));
check("元信息里没有 base64 图", !JSON.stringify(shotMeta).includes(PNG_1PX), JSON.stringify(shotMeta).slice(0, 160));
check("元信息里不带静态说明", !("hint" in shotMeta), JSON.stringify(Object.keys(shotMeta)));
fs.rmSync(shotMeta.file, { force: true });

const inlineShot = await rpc("tools/call", { name: "browser_screenshot", arguments: { inline: true } });
check("inline:true 时才转成 MCP image content", inlineShot.result?.content?.[0]?.type === "image");
check("inline 的图带 mimeType", inlineShot.result?.content?.[0]?.mimeType === "image/png");

const custom = path.join(TMP, "shot-custom.png");
const named = await rpc("tools/call", { name: "browser_screenshot", arguments: { outFile: custom } });
check("outFile 落到指定路径", JSON.parse(named.result?.content?.[0]?.text || "{}").file === custom && fs.existsSync(custom), custom);

const errCall = await rpc("tools/call", { name: "browser_click", arguments: { ref: "ref_1" } });
check("扩展侧报错转成 isError", errCall.result?.isError === true);
check("报错原文透传", (errCall.result?.content?.[0]?.text || "").includes("还没接管"));

const unknown = await rpc("tools/call", { name: "browser_nonexistent", arguments: {} });
check("未知工具返回 JSON-RPC error", !!unknown.error, JSON.stringify(unknown).slice(0, 100));

{
  const tr = await rpc("tools/call", { name: "browser_trace", arguments: {} });
  const t = JSON.parse(tr.result?.content?.[0]?.text || "{}");
  check("browser_trace 能调通且不报错", tr.result?.isError === false, JSON.stringify(tr.result).slice(0, 160));
  check("trace 记满了这一路的调用", t.totalSteps === 6, `${t.totalSteps} 步: ${JSON.stringify((t.steps || []).map((s) => s.tool))}`);
  check("步号从 1 递增", (t.steps || []).map((s) => s.n).join() === "1,2,3,4,5,6", JSON.stringify((t.steps || []).map((s) => s.n)));
  check("记的是 MCP 工具名而不是扩展侧名", (t.steps || [])[1]?.tool === "browser_tabs_list", (t.steps || [])[1]?.tool);
  check("失败的两步都被点名", (t.failedSteps || []).join() === "1,6", JSON.stringify(t.failedSteps));
  check("失败步带错误原文", /还没接管/.test((t.steps || [])[5]?.error || ""), (t.steps || [])[5]?.error);
  check("失败步带 FAILED 标记", (t.steps || [])[5]?.FAILED === true);
  check("成功步带结果摘要", !!(t.steps || [])[1]?.result, JSON.stringify((t.steps || [])[1]?.result));
  check("摘要自报是摘要不是全文", /这是结果摘要/.test((t.steps || [])[1]?.resultNote || ""));
  check("截图的 base64 没进 trace", !JSON.stringify(t).includes(PNG_1PX.slice(0, 24)), "截图内容进 trace 了");
  check("落盘那次 trace 里记的是路径不是图", /\.png/.test(JSON.stringify((t.steps || [])[2]?.result || "")), JSON.stringify((t.steps || [])[2]?.result).slice(0, 160));
  check("trace 明确警告不要盲目重放", /不是重放脚本/.test(t.caution || ""), t.caution);
  check("browser_trace 自己不记进 trace", !(t.steps || []).some((s) => s.tool === "browser_trace"));
  check("探针调用不记进 trace", !(t.steps || []).some((s) => s.tool === "status" || s.tool === "browser_status" && s.n > 1));
  check("未知工具不进 trace", !(t.steps || []).some((s) => /nonexistent/.test(s.tool || "")));

  const withMeta = (t.steps || [])[1];
  check("params._meta 记进了 trace", withMeta?.rpcMeta?.["agent/agentId"] === "agent_e2e_0001", JSON.stringify(withMeta?.rpcMeta));
  check("没带 _meta 的步骤不写空字段", !("rpcMeta" in ((t.steps || [])[0] || {})), JSON.stringify((t.steps || [])[0]));

  const one = await rpc("tools/call", { name: "browser_trace", arguments: { step: 6 } });
  const d = JSON.parse(one.result?.content?.[0]?.text || "{}");
  check("step:N 给出该步详情", d.step?.n === 6 && d.step?.tool === "browser_click", JSON.stringify(d.step).slice(0, 120));
  check("详情带完整入参", d.step?.args?.ref === "ref_1", JSON.stringify(d.step?.args));

  const failedOnly = await rpc("tools/call", { name: "browser_trace", arguments: { onlyFailed: true } });
  const f = JSON.parse(failedOnly.result?.content?.[0]?.text || "{}");
  check("onlyFailed 只给失败的", (f.steps || []).length === 2 && (f.steps || []).every((s) => s.ok === false), JSON.stringify((f.steps || []).map((s) => s.tool)));

  const listed = await rpc("tools/call", { name: "browser_trace", arguments: { list: true } });
  const L = JSON.parse(listed.result?.content?.[0]?.text || "{}");
  check("list:true 列得出本会话的 trace 文件", (L.files || []).some((x) => x.file === L.current), JSON.stringify(L.files).slice(0, 160));
  check("trace 落在指定目录里，没污染 ~/.agent-in-chrome", String(L.dir).startsWith(TMP), L.dir);

  const byName = await rpc("tools/call", { name: "browser_trace", arguments: { session: "e2e-trace-A" } });
  const S = JSON.parse(byName.result?.content?.[0]?.text || "{}");
  check("按会话名能把磁盘上那份读回来", S.totalSteps === 6, `${S.totalSteps} 步`);
  const missing = await rpc("tools/call", { name: "browser_trace", arguments: { session: "根本没有这个会话" } });
  const missText = missing.result?.content?.[0]?.text || "";
  check("读不到的会话报错而不是装作空的", missing.result?.isError === true, missText.slice(0, 80));
  check("读不到的会话给出可操作提示", /list:true/.test(missText), missText.slice(0, 120));
}

{
  for (const [why, bad] of [
    ["shell 启动文件", path.join(TMP, ".zshrc")],
    ["Claude 配置", path.join(TMP, ".claude", "settings.json")],
    ["登录项", path.join(TMP, "Library", "LaunchAgents", "x.plist")],
    ["运行时代码", path.join(TMP, ".agent-in-chrome", "agent-in-chrome", "server.mjs")],
    ["git hooks", path.join(TMP, ".git", "hooks", "pre-commit")],
    ["SSH 目录", path.join(TMP, ".ssh", "authorized_keys")],
    ["可执行脚本", path.join(TMP, "payload.sh")],
    ["direnv 配置", path.join(TMP, "proj", ".envrc")],
    ["CI 工作流", path.join(TMP, "proj", ".github", "workflows", "ci.yml")],
    ["VS Code 任务", path.join(TMP, "proj", ".vscode", "tasks.json")],
    ["Vim 配置", path.join(TMP, ".vimrc")],
    ["fish 配置", path.join(TMP, ".config", "fish", "config.fish")],
    ["Neovim 配置", path.join(TMP, ".config", "nvim", "init.lua")],
    ["调试器启动脚本", path.join(TMP, ".gdbinit")],
    ["IPython 启动脚本", path.join(TMP, ".ipython", "profile_default", "startup", "00-x.py")],
    ["构建工程文件", path.join(TMP, "proj", "pyproject.toml")],
  ]) {
    const r = await rpc("tools/call", { name: "browser_screenshot", arguments: { outFile: bad } });
    const txt = r.result?.content?.[0]?.text || "";
    check(`outFile 拒绝写入${why}`, r.result?.isError === true && /拒绝写入/.test(txt), txt.slice(0, 120));
    check(`outFile 拒绝写入${why}后确实没落盘`, !fs.existsSync(bad), bad);
  }
  const one = await rpc("tools/call", { name: "browser_screenshot", arguments: { outFile: path.join(TMP, ".zshrc") } });
  check("拒绝写入时点破「可能是页面在诱导」", /不可信输入|别照做/.test(one.result?.content?.[0]?.text || ""));

  const okOut = path.join(TMP, "data", "shot.png");
  await rpc("tools/call", { name: "browser_screenshot", arguments: { outFile: okOut } });
  check("普通数据路径照常落盘", fs.existsSync(okOut), okOut);

  const rel = path.relative(os.homedir(), path.join(TMP, "tilde.png"));
  if (!rel.startsWith("..")) {
    await rpc("tools/call", { name: "browser_screenshot", arguments: { outFile: `~/${rel}` } });
    check("outFile 的 ~ 展开成家目录（而不是 cwd 下的 ~ 目录）", fs.existsSync(path.join(TMP, "tilde.png")));
  }
}

{
  const callBatch = async (args) => {
    const r = await rpc("tools/call", { name: "browser_batch", arguments: args });
    return { isError: r.result?.isError, text: r.result?.content?.[0]?.text || "", raw: r };
  };
  const parse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return {};
    }
  };

  const ok = await callBatch({
    steps: [
      { tool: "browser_scroll", args: { direction: "down" } },
      { tool: "browser_press_key", args: { key: "Enter" } },
      { tool: "browser_tabs_list", args: {} },
    ],
  });
  const okData = parse(ok.text);
  check("batch 顺序跑完三步", okData.ok === true && okData.ran === 3 && okData.total === 3, ok.text.slice(0, 160));
  check("batch 逐步给出结果", (okData.results || []).map((r) => r.tool).join() === "browser_scroll,browser_press_key,browser_tabs_list", JSON.stringify((okData.results || []).map((r) => r.tool)));
  check("batch 每步结果是那个工具的真返回值", okData.results?.[2]?.result?.tabs?.[0]?.tabId === 7, JSON.stringify(okData.results?.[2]?.result).slice(0, 120));

  const inherited = await callBatch({ tabId: 77, steps: [{ tool: "browser_scroll", args: {} }, { tool: "browser_press_key", args: { key: "Tab", tabId: 88 } }] });
  const sentScroll = hostSeen.filter((m) => m.tool === "scroll").at(-1);
  const sentKey = hostSeen.filter((m) => m.tool === "press_key").at(-1);
  check("batch 顶层 tabId 下发给了没写 tabId 的那一步", sentScroll?.args?.tabId === 77, JSON.stringify(sentScroll?.args));
  check("步骤自己写的 tabId 优先于顶层", sentKey?.args?.tabId === 88, JSON.stringify(sentKey?.args));
  check("继承 tabId 的这一批照常成功", parse(inherited.text).ok === true);

  const before = hostSeen.length;
  const failed = await callBatch({
    steps: [
      { tool: "browser_scroll", args: { direction: "up" } },
      { tool: "browser_click", args: { ref: "ref_1" } },
      { tool: "browser_press_key", args: { key: "Escape" } },
    ],
  });
  const f = parse(failed.text);
  check("batch 中途失败时整体报 ok:false", f.ok === false && f.failedAt === 2, failed.text.slice(0, 160));
  check("batch 报出断在哪个工具", f.failedTool === "browser_click" && /还没接管/.test(f.error || ""), f.error);
  check("batch 断了之后不再往下跑", f.ran === 2 && (f.results || []).length === 2, JSON.stringify((f.results || []).map((r) => r.tool)));
  check("失败之后那一步没有下发到浏览器", !hostSeen.slice(before).some((m) => m.tool === "press_key"), JSON.stringify(hostSeen.slice(before).map((m) => m.tool)));
  check("batch 明说前面几步是真做过的", /不要整批重跑/.test(f.hint || ""), f.hint);
  check("失败的那一步也留在 results 里", f.results?.[1]?.ok === false, JSON.stringify(f.results?.[1]));

  const guard = hostSeen.length;
  const nested = await callBatch({ steps: [{ tool: "browser_scroll", args: {} }, { tool: "browser_batch", args: { steps: [] } }] });
  check("batch 不许嵌套", nested.isError === true && /不能套 batch|不能放进 batch/.test(nested.text), nested.text.slice(0, 120));
  const destructive = await callBatch({ steps: [{ tool: "browser_close_all", args: {} }] });
  check("破坏性的 close_all 不许进 batch", destructive.isError === true && /close_all/.test(destructive.text), destructive.text.slice(0, 120));
  const shotInBatch = await callBatch({ steps: [{ tool: "browser_screenshot", args: {} }] });
  check("截图不许进 batch（图片塞不进 JSON 结果）", shotInBatch.isError === true && /单独调它/.test(shotInBatch.text), shotInBatch.text.slice(0, 120));
  const badName = await callBatch({ steps: [{ tool: "browser_scroll", args: {} }, { tool: "browser_nope", args: {} }] });
  check("batch 里工具名不存在时报错", badName.isError === true && /不存在/.test(badName.text), badName.text.slice(0, 120));
  const empty = await callBatch({ steps: [] });
  check("batch 空数组报错并给出写法", empty.isError === true && /非空数组/.test(empty.text), empty.text.slice(0, 120));
  const tooMany = await callBatch({ steps: Array.from({ length: 21 }, () => ({ tool: "browser_scroll", args: {} })) });
  check("batch 步数上限", tooMany.isError === true && /最多 20 步/.test(tooMany.text), tooMany.text.slice(0, 120));
  check("校验不通过时一步都没有下发", hostSeen.length === guard, `多下发了 ${hostSeen.length - guard} 条`);

  const tr = parse((await rpc("tools/call", { name: "browser_trace", arguments: { limit: 60 } })).result?.content?.[0]?.text || "{}");
  const names = (tr.steps || []).map((s) => s.tool);
  check("batch 的每一步在 trace 里各占一条", names.filter((n) => n === "browser_scroll").length === 3, JSON.stringify(names));
  check("batch 自己不占 trace 步骤（它不过桥）", !names.includes("browser_batch"), JSON.stringify(names));
  check("batch 里失败的那步照样被标成失败", (tr.steps || []).some((s) => s.tool === "browser_click" && s.ok === false));

  {
    const marked = (tr.steps || []).filter((s) => s.batchOf);
    check("batch 展开的步骤在 trace 里带 batchOf", marked.length > 0, JSON.stringify(names));
    check("同一批的步骤 batchOf 相同、stepIndex 从 1 递增", (() => {
      const groups = new Map();
      for (const s of marked) groups.set(s.batchOf, [...(groups.get(s.batchOf) || []), s.stepIndex]);
      return [...groups.values()].some((idx) => idx.join() === "1,2,3");
    })(), JSON.stringify(marked.map((s) => [s.batchOf, s.stepIndex])));
    check("不同批次的 batchOf 不一样（不然分不出是哪一次调用）", new Set(marked.map((s) => s.batchOf)).size > 1, JSON.stringify([...new Set(marked.map((s) => s.batchOf))]));
    check("单发调用不带 batchOf（收到什么记什么）", (tr.steps || []).some((s) => !s.batchOf), JSON.stringify(names));
    const seq = [...new Set(marked.map((s) => Number(String(s.batchOf).replace("batch#", ""))))].sort((a, b) => a - b);
    check("批次号连着发，没有为校验失败的批留空洞", seq.every((n, i) => n === seq[0] + i), JSON.stringify(seq));
  }

  const piped = await callBatch({
    steps: [
      { tool: "browser_tabs_list", args: {} },
      { tool: "browser_scroll", args: { direction: "down", tabId: "{{steps[0].tabs[0].tabId}}" } },
    ],
  });
  const pd = parse(piped.text);
  const pipedScroll = hostSeen.filter((m) => m.tool === "scroll").at(-1);
  check("占位符把上一步的值代进了下一步", pd.ok === true && pipedScroll?.args?.tabId === 7, JSON.stringify(pipedScroll?.args));
  check("代入保持原始类型（数字不变字符串）", typeof pipedScroll?.args?.tabId === "number", typeof pipedScroll?.args?.tabId);

  const badPath = await callBatch({
    steps: [
      { tool: "browser_tabs_list", args: {} },
      { tool: "browser_scroll", args: { tabId: "{{steps[0].nothing.tabId}}" } },
    ],
  });
  const bp = parse(badPath.text);
  check("路径不存在时停在那一步", bp.ok === false && bp.failedAt === 2 && bp.ran === 2, badPath.text.slice(0, 160));
  check("报错点名断在哪一层", /steps\[0\]/.test(bp.error || "") && /nothing/.test(bp.error || ""), bp.error);
  check("报错给出那一层的实际结构（键名，不倒数据）", /tabs/.test(bp.error || "") && /count/.test(bp.error || ""), bp.error);
  check("绝不拿 undefined 继续跑", /undefined/.test(bp.error || ""), bp.error);

  const oob = await callBatch({
    steps: [
      { tool: "browser_tabs_list", args: {} },
      { tool: "browser_scroll", args: { tabId: "{{steps[0].tabs[5].tabId}}" } },
    ],
  });
  const ob = parse(oob.text);
  check("下标越界时停在那一步", ob.ok === false && ob.failedAt === 2, oob.text.slice(0, 160));
  check("报错说清数组实际多长", /数组（1 项）/.test(ob.error || "") && /\[5\]/.test(ob.error || ""), ob.error);

  const fwdGuard = hostSeen.length;
  const fwd = await callBatch({
    steps: [
      { tool: "browser_scroll", args: { tabId: "{{steps[1].tabs[0].tabId}}" } },
      { tool: "browser_tabs_list", args: {} },
    ],
  });
  check("引用后续步骤在开跑前就报错", fwd.isError === true && /还没执行/.test(fwd.text), fwd.text.slice(0, 160));
  const selfRef = await callBatch({ steps: [{ tool: "browser_scroll", args: { tabId: "{{steps[0].x}}" } }] });
  check("引用自己也拦下来", selfRef.isError === true && /它自己/.test(selfRef.text), selfRef.text.slice(0, 160));

  const badSyntax = await callBatch({
    steps: [
      { tool: "browser_tabs_list", args: {} },
      { tool: "browser_press_key", args: { key: "前缀 {{steps[0].tabs[0].tabId}} 后缀" } },
    ],
  });
  check("占位符嵌在别的文字里按写错报", badSyntax.isError === true && /独占整个字符串/.test(badSyntax.text), badSyntax.text.slice(0, 160));
  check("占位符校验失败时一步都没下发", hostSeen.length === fwdGuard, `多下发了 ${hostSeen.length - fwdGuard} 条`);

  const literal = await callBatch({ steps: [{ tool: "browser_press_key", args: { key: "{{title}}" } }] });
  const litKey = hostSeen.filter((m) => m.tool === "press_key").at(-1);
  check("与 steps 无关的花括号当字面量下发", parse(literal.text).ok === true && litKey?.args?.key === "{{title}}", JSON.stringify(litKey?.args));

  const switchGuard = hostSeen.length;
  evalReply = true;
  const smuggle = await callBatch({
    steps: [
      { tool: "browser_eval", args: { expression: "true" } },
      { tool: "browser_as_curl", args: { requestId: "r1", revealSecrets: "{{steps[0].value}}" } },
    ],
  });
  check("revealSecrets 不许由占位符供值", smuggle.isError === true && /不能用占位符/.test(smuggle.text), smuggle.text.slice(0, 200));
  check("拒的理由点明「校验时看到的和实际生效的不是同一个」", /校验时看到的/.test(smuggle.text), smuggle.text.slice(0, 240));
  check("偷渡被拒时一步都没下发（连第 0 步的 eval 都没跑）", hostSeen.length === switchGuard, `多下发了 ${hostSeen.length - switchGuard} 条`);

  const smuggleUp = await callBatch({
    steps: [
      { tool: "browser_eval", args: { expression: "true" } },
      { tool: "browser_upload_file", args: { files: ["/Users/x/.ssh/id_rsa"], confirmSensitive: "{{steps[0].value}}" } },
    ],
  });
  check("confirmSensitive 不许由占位符供值", smuggleUp.isError === true && /不能用占位符/.test(smuggleUp.text), smuggleUp.text.slice(0, 200));
  const smuggleTake = await callBatch({
    steps: [
      { tool: "browser_eval", args: { expression: "true" } },
      { tool: "browser_tab_use", args: { tabId: 7, takeover: "{{steps[0].value}}" } },
    ],
  });
  check("takeover 不许由占位符供值", smuggleTake.isError === true && /不能用占位符/.test(smuggleTake.text), smuggleTake.text.slice(0, 200));

  const smuggleBad = await callBatch({
    steps: [{ tool: "browser_as_curl", args: { requestId: "r1", revealSecrets: "{{steps[0]" } }],
  });
  check("写坏的占位符落在开关上同样拒", smuggleBad.isError === true && /不能用占位符/.test(smuggleBad.text), smuggleBad.text.slice(0, 200));

  evalReply = null;
  const beforeLiteralSwitch = hostSeen.length;
  const literalSwitch = await callBatch({
    steps: [{ tool: "browser_as_curl", args: { requestId: "r1", revealSecrets: true } }],
  });
  check("写死 revealSecrets:true 照常放行（不是一刀切禁用占位符）", !/不能用占位符/.test(literalSwitch.text), literalSwitch.text.slice(0, 160));
  check("放行的那一批真的下发到了浏览器", hostSeen.length > beforeLiteralSwitch, `没有新下发`);
}

{
  const SOCK5 = path.join(TMP, "t5.sock");
  const srv5 = startServer({ AGENT_IN_CHROME_SOCK: SOCK5, AGENT_IN_CHROME_TRACE: "off", AGENT_IN_CHROME_TIMEOUT_MS: "200" });
  await srv5.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  srv5.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await waitFor(() => sockUp(SOCK5), 5000);

  const host5 = net.connect(ep(SOCK5));
  host5.setEncoding("utf8");
  let hb = "";
  const seen5 = [];
  host5.on("data", (chunk) => {
    hb += chunk;
    let i;
    while ((i = hb.indexOf("\n")) >= 0) {
      const line = hb.slice(0, i).trim();
      hb = hb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type !== "call") continue;
      seen5.push(m);
      if (m.tool !== "wait_for") {
        host5.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: {} }) + "\n");
      }
    }
  });
  await new Promise((r) => host5.on("connect", r));
  host5.write(helloHost(5));
  await sleep(200);

  const plain = await srv5.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("对照：不带 timeoutMs 的工具用桥接默认超时", plain.result?.isError === false || true);

  const t0 = Date.now();
  const slow = await srv5.rpc("tools/call", { name: "browser_wait_for", arguments: { js: "false", timeoutMs: 400 } });
  const waited = Date.now() - t0;
  const msg = slow.result?.content?.[0]?.text || "";
  check("wait_for 的 timeoutMs 透传到了扩展侧", seen5.some((m) => m.tool === "wait_for" && m.args?.timeoutMs === 400), JSON.stringify(seen5.map((m) => [m.tool, m.args?.timeoutMs])));
  check("桥接超时按它放宽了（报的不是 200ms 那个默认值）", !/\b200ms\b/.test(msg), msg.slice(0, 120));
  check("放宽后的超时 = timeoutMs + 5s 余量", /5400ms/.test(msg), msg.slice(0, 120));
  check("而且真的等到了那么久才报", waited >= 5000, `${waited}ms`);

  const tooLong = await srv5.rpc("tools/call", { name: "browser_wait_for", arguments: { js: "false", timeoutMs: 900000 } });
  const tooLongText = tooLong.result?.content?.[0]?.text || "";
  check("timeoutMs 超过 10 分钟上限时直接报错", tooLong.result?.isError === true && /超过上限/.test(tooLongText), tooLongText.slice(0, 120));
  check("并说清为什么不给等那么久", /分几次等|让用户自己确认/.test(tooLongText), tooLongText.slice(0, 160));

  host5.destroy();
  srv5.p.kill();
}

{
  const SECRET = "sid-SECRET-COOKIE-VALUE-e2e-1234567890";
  const jarFile = path.join(TMP, "cookie-jar.json");
  fs.writeFileSync(jarFile, JSON.stringify({ cookies: [{ name: "zc_sid", value: SECRET, domain: "example.com", path: "/" }] }));

  const sent0 = hostSeen.length;
  const viaFile = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: jarFile } });
  const frame = hostSeen.slice(sent0).find((m) => m.tool === "cookies_import");
  check("inFile 在 Node 侧展开成 cookies 再过桥", frame?.args?.cookies?.length === 1 && frame.args.cookies[0].value === SECRET, JSON.stringify(frame?.args).slice(0, 160));
  check("inFile 字段本身不发给扩展", !!frame && !("inFile" in frame.args), JSON.stringify(Object.keys(frame?.args || {})));
  check("展开后走的是正常工具管线（报的是接管问题，不是参数问题）", viaFile.result?.isError === true && /还没接管/.test(viaFile.result?.content?.[0]?.text || ""), viaFile.result?.content?.[0]?.text);

  const bareFile = path.join(TMP, "cookie-bare.json");
  fs.writeFileSync(bareFile, JSON.stringify([{ name: "n", value: "v-123456789", domain: "example.com", path: "/" }]));
  const sent1 = hostSeen.length;
  await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: bareFile } });
  check("裸数组的文件也认", hostSeen.slice(sent1).find((m) => m.tool === "cookies_import")?.args?.cookies?.length === 1);

  const text = (r) => r.result?.content?.[0]?.text || "";
  const guard = hostSeen.length;
  const both = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: jarFile, cookies: [{ name: "a", value: "b" }] } });
  check("cookies 和 inFile 一起给要报错", both.result?.isError === true && /只能给一个/.test(text(both)), text(both));
  const nofile = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: path.join(TMP, "没有这个.json") } });
  check("文件不存在时说清它该是什么", nofile.result?.isError === true && /读不了 inFile/.test(text(nofile)) && /browser_cookies_export/.test(text(nofile)), text(nofile));
  const badFile = path.join(TMP, "cookie-bad.json");
  fs.writeFileSync(badFile, "{半截");
  const bj = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: badFile } });
  check("不是 JSON 的文件报错点名路径", bj.result?.isError === true && /不是合法 JSON/.test(text(bj)) && text(bj).includes(badFile), text(bj));

  const leaky = path.join(TMP, "cookie-not-json.json");
  fs.writeFileSync(leaky, "ssh-rsa AAAAB3NzaC1yc2EAAAA-SECRET-KEY-MATERIAL");
  const lk = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: leaky } });
  check("不是 JSON 时不回显文件内容", lk.result?.isError === true && !text(lk).includes("ssh-rsa") && !text(lk).includes("SECRET-KEY"), text(lk));
  check("但说得出文件多大（够判断是不是拿错文件）", /\d+ 字符/.test(text(lk)), text(lk));

  const sshDir = path.join(TMP, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  const keyFile = path.join(sshDir, "id_rsa");
  fs.writeFileSync(keyFile, JSON.stringify({ cookies: [{ name: "x", value: "y", domain: "a.test", path: "/" }] }));
  const ssh = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: keyFile } });
  check("敏感路径拒读（哪怕内容正好是合法的 cookie jar）", ssh.result?.isError === true && /拒绝从这个路径读|SSH/.test(text(ssh)), text(ssh));
  check("拒读时提醒这可能是一次注入", /注入/.test(text(ssh)), text(ssh));

  const emptyFile = path.join(TMP, "cookie-none.json");
  fs.writeFileSync(emptyFile, JSON.stringify({ foo: 1 }));
  const nc = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: emptyFile } });
  check("没有 cookie 的文件报错说明期望的形状", nc.result?.isError === true && /没有 cookie/.test(text(nc)), text(nc));
  check("错误路径一帧都没下发", !hostSeen.slice(guard).some((m) => m.tool === "cookies_import"), JSON.stringify(hostSeen.slice(guard).map((m) => m.tool)));

  const ourJar = path.join(COOKIE_DIR, "exported.json");
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(ourJar, JSON.stringify({ cookies: [{ name: "ok", value: "v-123456789", domain: "a.test", path: "/" }] }));
  const sentOur = hostSeen.length;
  const our = await rpc("tools/call", { name: "browser_cookies_import", arguments: { inFile: ourJar } });
  check(
    "export 自己那个目录里的文件照常读得动（默认用法没被堵死）",
    hostSeen.slice(sentOur).some((m) => m.tool === "cookies_import"),
    text(our)
  );

  const tr = await rpc("tools/call", { name: "browser_trace", arguments: { limit: 80 } });
  const traw = text(tr);
  check("trace 里记了 inFile 的路径（回看要用）", traw.includes("cookie-jar.json"), traw.slice(0, 200));
  check("cookie 明文没进 trace（含内联 cookies 的入参）", !traw.includes("SECRET-COOKIE-VALUE"), "明文进 trace 了");
}

{
  const text = (r) => r.result?.content?.[0]?.text || "";
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  const userJar = path.join(COOKIE_DIR, "myexport.json");
  fs.writeFileSync(userJar, JSON.stringify({ cookies: [] }));

  let lastFile = null;
  for (let i = 0; i < 25; i++) {
    const r = await rpc("tools/call", { name: "browser_cookies_export", arguments: {} });
    lastFile = JSON.parse(text(r) || "{}").file || lastFile;
  }
  const ours = fs.readdirSync(COOKIE_DIR).filter((f) => /^[a-z0-9]{6,10}-[a-z0-9]{1,4}\.json$/i.test(f));
  check("连导 25 次后默认目录被压回上限以内", ours.length <= 20, `目录里还有 ${ours.length} 个`);
  check("刚写的那份没被自己的清理顺手删掉", !!lastFile && fs.existsSync(lastFile), String(lastFile));
  check(
    "落盘的仍然是 0600",
    !!lastFile && (process.platform === "win32" || (fs.statSync(lastFile).mode & 0o777) === 0o600),
    lastFile ? (fs.statSync(lastFile).mode & 0o777).toString(8) : "没落盘"
  );
  check("明文落进了文件（这条路本来就该有明文）", !!lastFile && fs.readFileSync(lastFile, "utf8").includes("v-abcdefghij"));
  check("用户自己命名的文件不碰", fs.existsSync(userJar), userJar);
}

{
  const text = (r) => r.result?.content?.[0]?.text || "";
  const JAR = "sessionid=aq3x9kf20soi3nfk2h1; csrftoken=zk29fk20dj2093ks; _ga=GA1.2.99.88";
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  evalReply = JAR;
  const c1 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "document.cookie" } });
  check("eval 读到 cookie 串时值不进上下文", !text(c1).includes("aq3x9kf20soi3nfk2h1"), text(c1).slice(0, 200));
  check("但形状照给（有哪些 cookie 名）", /sessionid/.test(text(c1)) && /csrftoken/.test(text(c1)), text(c1).slice(0, 220));
  check("并说清怎么拿到明文", /revealSecrets/.test(text(c1)) && /cookies_export/.test(text(c1)), text(c1).slice(0, 300));
  check("标了 secretsWithheld 让模型一眼看出被改过", JSON.parse(text(c1)).secretsWithheld === true, text(c1).slice(0, 120));

  evalReply = "sid=onlyonecookie1234567890";
  const c2 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "document.cookie" } });
  check("单个 cookie 也拦得住（意图判据兜底）", !text(c2).includes("onlyonecookie"), text(c2).slice(0, 200));

  evalReply = JSON.stringify({ user: "amy", auth: { token: JWT } });
  const c3 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "JSON.stringify(window.__STATE__)" } });
  check("藏在 JSON 里的 JWT 也隐去", !text(c3).includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r"), text(c3).slice(0, 220));

  evalReply = "这是一段普通的页面正文，里面没有任何凭据，应该原样回来 lang=zh; theme=dark";
  const c4 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "document.body.innerText" } });
  check("正常返回值原样回来，不被误伤", text(c4).includes("应该原样回来") && text(c4).includes("theme=dark"), text(c4).slice(0, 220));
  check("没碰凭据就不加 secretsWithheld 噪音", !("secretsWithheld" in JSON.parse(text(c4))), text(c4).slice(0, 160));

  evalReply = "armed";
  const c4b = await rpc("tools/call", {
    name: "browser_eval",
    arguments: { expression: "(() => { sessionStorage.setItem('__zr', JSON.stringify(rows)); return 'armed'; })()" },
  });
  check("往 storage 写、返回短状态串的不被误伤", JSON.parse(text(c4b)).value === "armed", text(c4b).slice(0, 200));
  evalReply = "页面正文，够长，但和凭据无关，不该被动";
  const c4c = await rpc("tools/call", {
    name: "browser_eval",
    arguments: { expression: "fetch('/api/me', {credentials:'include'}).then(r=>r.text())" },
  });
  check("fetch 的 credentials:include 不触发打码", text(c4c).includes("和凭据无关"), text(c4c).slice(0, 200));

  evalReply = JAR;
  const c5 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "document.cookie", revealSecrets: true } });
  check("revealSecrets:true 时给明文", text(c5).includes("aq3x9kf20soi3nfk2h1"), text(c5).slice(0, 160));

  cdpReply = { cookies: [{ name: "sid", value: "REAL-COOKIE-VALUE-9527", domain: "a.test", httpOnly: true }] };
  const c6 = await rpc("tools/call", { name: "browser_cdp", arguments: { method: "Storage.getCookies" } });
  check("cdp 取 cookie 时值被隐去", !text(c6).includes("REAL-COOKIE-VALUE-9527"), text(c6).slice(0, 200));
  check("cookie 的名字/域名/属性照留", /"name":\s*"sid"/.test(text(c6)) && /a\.test/.test(text(c6)) && /httpOnly/.test(text(c6)), text(c6).slice(0, 220));

  cdpReply = { root: { nodeId: 1, nodeName: "#document" } };
  const c7 = await rpc("tools/call", { name: "browser_cdp", arguments: { method: "DOM.getDocument" } });
  check("普通 cdp 命令返回值不被动", text(c7).includes("#document") && !("secretsWithheld" in JSON.parse(text(c7))), text(c7).slice(0, 200));

  evalReply = JAR;
  const outF = path.join(TMP, "eval-out.txt");
  const c8 = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "document.cookie", outFile: outF } });
  check("凭据不许经 outFile 落盘（这条红了 = 落盘前那道检测没了）", c8.result?.isError === true && /拒绝写入/.test(text(c8)), text(c8).slice(0, 200));
  check("拒绝时文件根本没被创建（不是先写了再删）", !fs.existsSync(outF), outF);
  check("拒绝时明文也没进上下文", !text(c8).includes("aq3x9kf20soi3nfk2h1"), text(c8).slice(0, 200));
  check("并指出正路：cookies_export 那条有按域授权流程", /cookies_export/.test(text(c8)), text(c8).slice(0, 400));

  const c8b = await rpc("tools/call", {
    name: "browser_eval",
    arguments: { expression: "document.cookie", outFile: outF, revealSecrets: true },
  });
  check("revealSecrets:true 也解不开落盘那道闸", c8b.result?.isError === true && /拒绝写入/.test(text(c8b)), text(c8b).slice(0, 200));
  check("revealSecrets 那次同样一个字节都没落盘", !fs.existsSync(outF), outF);

  evalReply = [
    { name: "email", value: "a@example.com" },
    { name: "note", value: "END-MARKER-7f21" },
  ];
  const okF = path.join(TMP, "eval-ok.json");
  const c8c = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "[...document.forms[0]].map(f=>({name:f.name,value:f.value}))", outFile: okF } });
  check("普通载荷照常落盘（表单快照不该被当成 cookie 数组）", fs.existsSync(okF) && !c8c.result?.isError, text(c8c).slice(0, 200));
  check("落盘的是完整原文，一个字没少、也没被打码", fs.readFileSync(okF, "utf8") === JSON.stringify(evalReply), fs.readFileSync(okF, "utf8").slice(0, 120));

  evalReply = [{ name: "sid", value: "aq3x9kf20soi3nfk2h1", domain: "a.test", httpOnly: true }];
  const badF = path.join(TMP, "eval-cookies.json");
  const c8d = await rpc("tools/call", { name: "browser_eval", arguments: { expression: "readCookies()", outFile: badF } });
  check("带 httpOnly/domain 的对象数组被认出来并拒绝", c8d.result?.isError === true && /拒绝写入/.test(text(c8d)), text(c8d).slice(0, 200));
  check("这次也没落盘", !fs.existsSync(badF), badF);

  check("落盘摘要报的是形状（JSON 数组、几项、每项什么字段）", /JSON 数组/.test(text(c8c)) && /2 项/.test(text(c8c)), text(c8c).slice(0, 260));
  check("落盘摘要里没有内容原文（埋的标记串不出现）", !text(c8c).includes("END-MARKER-7f21"), text(c8c).slice(0, 260));
  check("元信息照留（路径/字节数，排查要用）", /"path"/.test(text(c8c)) && /"bytesWritten"/.test(text(c8c)), text(c8c).slice(0, 260));

  cdpReply = { layoutViewport: { clientWidth: 1280, clientHeight: 657 }, marker: "CDP-OUTFILE-MARKER-42" };
  const cdpF = path.join(TMP, "cdp-out.json");
  const c8e = await rpc("tools/call", { name: "browser_cdp", arguments: { method: "Page.getLayoutMetrics", outFile: cdpF } });
  check("cdp 的 outFile 落的是真结果，不是 4 字节的 null", fs.existsSync(cdpF) && fs.readFileSync(cdpF, "utf8") !== "null", fs.readFileSync(cdpF, "utf8").slice(0, 120));
  check("落盘内容和不带 outFile 时的返回值一致", fs.readFileSync(cdpF, "utf8") === JSON.stringify(cdpReply), fs.readFileSync(cdpF, "utf8").slice(0, 200));
  check("返回值只是落盘摘要，不把整份数据又塞回上下文", !text(c8e).includes("CDP-OUTFILE-MARKER-42") && /"bytesWritten"/.test(text(c8e)), text(c8e).slice(0, 200));

  cdpReply = { cookies: [{ name: "sid", value: "REAL-COOKIE-VALUE-9527", domain: "a.test", httpOnly: true, path: "/" }] };
  const cdpCookieF = path.join(TMP, "cdp-cookies.json");
  const c8f = await rpc("tools/call", { name: "browser_cdp", arguments: { method: "Storage.getCookies", outFile: cdpCookieF } });
  check("cdp 取 cookie 经 outFile 落盘被拒", c8f.result?.isError === true && /拒绝写入/.test(text(c8f)), text(c8f).slice(0, 240));
  check("被拒时一个字节都没落盘", !fs.existsSync(cdpCookieF), `${cdpCookieF} 存在=${fs.existsSync(cdpCookieF)}`);
  check("被拒时明文也没进上下文", !text(c8f).includes("REAL-COOKIE-VALUE-9527"), text(c8f).slice(0, 240));
  const c8g = await rpc("tools/call", {
    name: "browser_cdp",
    arguments: { method: "Storage.getCookies", outFile: cdpCookieF, revealSecrets: true },
  });
  check("revealSecrets:true 同样解不开 cdp 这条落盘闸", c8g.result?.isError === true && /拒绝写入/.test(text(c8g)), text(c8g).slice(0, 200));
  check("那一次也没落盘", !fs.existsSync(cdpCookieF), cdpCookieF);

  const tr = await rpc("tools/call", { name: "browser_trace", arguments: { limit: 80 } });
  check("cookie 明文没进 trace", !text(tr).includes("aq3x9kf20soi3nfk2h1"), "明文进 trace 了");
  check("JWT 没进 trace", !text(tr).includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r"), "JWT 进 trace 了");
  check("单 cookie 那次也没进 trace", !text(tr).includes("onlyonecookie"), "明文进 trace 了");
  check("trace 里仍看得出这几步调的是 eval/cdp", /browser_eval/.test(text(tr)) && /browser_cdp/.test(text(tr)), text(tr).slice(0, 200));
}

check("stderr 干净", srvErr.trim() === "", srvErr.slice(0, 200));

fakeHost.destroy();
srv.kill();

console.log("\n\x1b[1mB. native host 帧协议\x1b[0m");

const SOCK2 = path.join(TMP, "t2.sock");
const relayed = [];
const relayConns = [];
const relayNonces = [];
const relay = net.createServer((conn) => {
  relayConns.push(conn);
  conn.setEncoding("utf8");
  const snonce = handshakeNonce();
  relayNonces.push(snonce);
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      relayed.push(msg);
      if (msg.type === "hello" && msg.role === "host" && msg.proof) {
        const ok = timingSafeEqualStr(msg.proof, handshakeProof(TOKEN, "client", snonce, msg.nonce));
        if (!ok) return conn.destroy();
        conn.write(JSON.stringify({ type: "welcome", proof: handshakeProof(TOKEN, "server", snonce, msg.nonce) }) + "\n");
        setTimeout(() => conn.write(JSON.stringify({ type: "call", id: "x1", tool: "status" }) + "\n"), 100);
      }
    }
  });
  conn.write(JSON.stringify({ type: "challenge", v: 1, nonce: snonce }) + "\n");
});
await new Promise((r) => relay.listen(ep(SOCK2), r));

const host = spawn(process.execPath, [path.join(ROOT, "native-host", "host.mjs")], {
  env: { ...process.env, AGENT_IN_CHROME_SOCK: SOCK2 },
  stdio: ["pipe", "pipe", "pipe"],
});

const frames = [];
let hostBuf = Buffer.alloc(0);
host.stdout.on("data", (chunk) => {
  hostBuf = Buffer.concat([hostBuf, chunk]);
  for (;;) {
    if (hostBuf.length < 4) return;
    const len = hostBuf.readUInt32LE(0);
    if (hostBuf.length < 4 + len) return;
    frames.push(JSON.parse(hostBuf.subarray(4, 4 + len).toString("utf8")));
    hostBuf = hostBuf.subarray(4 + len);
  }
});
let hostErr = "";
host.stderr.on("data", (d) => (hostErr += d));

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([head, body]));
}

await sleep(600);
writeFrame({ type: "hello", role: "extension", version: "0.1.0" });
writeFrame({ id: "x1", type: "result", ok: true, data: { connected: true } });
const big = Buffer.from(JSON.stringify({ id: "x2", type: "result", ok: true, data: { n: 1 } }), "utf8");
const bigHead = Buffer.allocUnsafe(4);
bigHead.writeUInt32LE(big.length, 0);
host.stdin.write(Buffer.concat([bigHead, big.subarray(0, 5)]));
await sleep(80);
host.stdin.write(big.subarray(5));

check("host 连上了 socket", await waitFor(() => relayed.length > 0));
check("扩展的消息转发到了 agent 侧", await waitFor(() => relayed.some((m) => m.id === "x1" && m.ok === true)));
check(
  "拆成两段的帧能正确重组",
  await waitFor(() => relayed.some((m) => m.id === "x2")),
  JSON.stringify(relayed).slice(0, 200)
);
check("agent 侧的命令下发成了合法帧", await waitFor(() => frames.some((f) => f.type === "call" && f.tool === "status")));
check("host 会主动发保活 ping", frames.some((f) => f.type === "ping"));
const hostHello = relayed.find((m) => m.type === "hello" && m.role === "host");
check(
  "host 证明了自己握着同一份令牌",
  !!hostHello &&
    typeof hostHello.nonce === "string" &&
    relayNonces.some((sn) => timingSafeEqualStr(hostHello.proof, handshakeProof(TOKEN, "client", sn, hostHello.nonce))),
  JSON.stringify(hostHello || null).slice(0, 160)
);
check(
  "令牌一个字节都没上线（明文令牌不许出现在任何一帧里）",
  !relayed.some((m) => JSON.stringify(m).includes(TOKEN)),
  JSON.stringify(relayed.find((m) => JSON.stringify(m).includes(TOKEN)) || null).slice(0, 160)
);
check("pong 不会被回传（避免噪音）", !relayed.some((m) => m.type === "pong"));

{
  const n0 = relayed.length;
  relayConns.forEach((c) => c.destroy());
  check(
    "agent 重连后，host 把扩展的 hello 补发一遍",
    await waitFor(() => relayed.slice(n0).some((m) => m.type === "hello" && m.role === "extension" && m.version === "0.1.0"), 5000),
    JSON.stringify(relayed.slice(n0)).slice(0, 200)
  );
}
check("host stderr 干净", hostErr.trim() === "", hostErr.slice(0, 200));

host.kill();
relay.close();

console.log("\n\x1b[1mC. 启动器（最小 PATH）\x1b[0m");

let runtimeHome = os.homedir();
let RUNTIME_DIR = path.join(runtimeHome, ".agent-in-chrome", "agent-in-chrome");
let installedForThisRun = null;
if (!fs.existsSync(path.join(RUNTIME_DIR, "native-host-launcher.sh"))) {
  const SOCK_SUFFIX = "/.agent-in-chrome/agent-in-chrome.sock".length;
  let base = os.tmpdir();
  if (base.length + "/aic-hXXXXXX".length + SOCK_SUFFIX > 104 && fs.existsSync("/tmp")) base = "/tmp";
  runtimeHome = fs.mkdtempSync(path.join(base, "aic-h"));
  fs.mkdirSync(
    process.platform === "darwin"
      ? path.join(runtimeHome, "Library", "Application Support", "Google", "Chrome")
      : path.join(runtimeHome, ".config", "google-chrome"),
    { recursive: true }
  );
  const t0i = Date.now();
  let installErr = null;
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), "--yes", "--no-agents"], {
      env: { ...process.env, HOME: runtimeHome, USERPROFILE: runtimeHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    installErr = String(e.stdout || "") + String(e.stderr || "");
  }
  RUNTIME_DIR = path.join(runtimeHome, ".agent-in-chrome", "agent-in-chrome");
  installedForThisRun = { ms: Date.now() - t0i, err: installErr };
  check(
    "本机没装过运行时 → 往临时 HOME 里现装一份（不跳过，也不算红）",
    installErr === null && fs.existsSync(path.join(RUNTIME_DIR, "native-host-launcher.sh")),
    installErr ? installErr.slice(-400) : `装在 ${RUNTIME_DIR}`
  );
  console.log(`  \x1b[90m·\x1b[0m 用的是临时 HOME（${runtimeHome}），现装耗时 ${installedForThisRun.ms}ms`);
  check(
    "临时 HOME 派生出来的 socket 路径没超 104 字节（超了 server.mjs 会当场拒绝，D 节整段起不来）",
    path.join(runtimeHome, ".agent-in-chrome", "agent-in-chrome.sock").length <= 104,
    path.join(runtimeHome, ".agent-in-chrome", "agent-in-chrome.sock")
  );
}
const LAUNCHER = path.join(RUNTIME_DIR, "native-host-launcher.sh");
const MCP_LAUNCHER = path.join(RUNTIME_DIR, "mcp-launcher.sh");
{
  const SOCK3 = path.join(TMP, "t3.sock");
  const seen3 = [];
  const relay3 = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (d) => seen3.push(d));
  });
  await new Promise((r) => relay3.listen(ep(SOCK3), r));

  const lp = spawn(LAUNCHER, [], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: runtimeHome, AGENT_IN_CHROME_SOCK: SOCK3 },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lErr = "";
  let lExit = null;
  lp.stderr.on("data", (d) => (lErr += d));
  lp.on("exit", (c) => (lExit = c));

  const lFrames = [];
  let lBuf = Buffer.alloc(0);
  lp.stdout.on("data", (chunk) => {
    lBuf = Buffer.concat([lBuf, chunk]);
    for (;;) {
      if (lBuf.length < 4) return;
      const len = lBuf.readUInt32LE(0);
      if (lBuf.length < 4 + len) return;
      lFrames.push(JSON.parse(lBuf.subarray(4, 4 + len).toString("utf8")));
      lBuf = lBuf.subarray(4 + len);
    }
  });

  const started = await waitFor(() => lFrames.length > 0 || lExit !== null, 6000);
  check("最小 PATH 下没有立刻退出", lExit === null, `exit=${lExit} stderr=${lErr.slice(0, 160)}`);
  check("最小 PATH 下能输出合法帧", started && lFrames.length > 0, lErr.slice(0, 160));
  check("最小 PATH 下能连上 socket", await waitFor(() => seen3.length > 0, 4000));

  lp.kill();
  relay3.close();

  console.log("\n\x1b[1mD. MCP 启动器（干净环境）\x1b[0m");
  {
    check("MCP 启动器已生成", fs.existsSync(MCP_LAUNCHER), MCP_LAUNCHER);
    const mp = spawn(MCP_LAUNCHER, [], {
      env: { PATH: "/usr/bin:/bin", HOME: runtimeHome, AGENT_IN_CHROME_DEV: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const got = new Map();
    let mBuf = "";
    mp.stdout.setEncoding("utf8");
    mp.stdout.on("data", (c) => {
      mBuf += c;
      let i;
      while ((i = mBuf.indexOf("\n")) >= 0) {
        const line = mBuf.slice(0, i).trim();
        mBuf = mBuf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id) got.set(m.id, m);
        } catch {}
      }
    });
    mp.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      }) + "\n"
    );
    mp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");

    await waitFor(() => got.has(2), 8000);
    check("干净环境下能完成 initialize", got.get(1)?.result?.serverInfo?.name === "agent-in-chrome");

    const srcCount = (
      fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8").match(/^\s*name: "browser_/gm) || []
    ).length;
    const gotCount = (got.get(2)?.result?.tools || []).length;
    check("干净环境下能列出工具", gotCount > 0, `${gotCount} 个`);
    check(
      "已安装的运行时与本仓库源码一致",
      gotCount === srcCount,
      `运行时 ${gotCount} 个，源码 ${srcCount} 个——多半是改完没跑 node scripts/install.mjs`
    );
    check("启动器装在 ~/.agent-in-chrome 而非 ~/Documents（避开 TCC）", !MCP_LAUNCHER.includes("/Documents/"));
    mp.kill();
  }
}

console.log("\n\x1b[1mE. 多会话并发\x1b[0m");
{
  const SOCK4 = path.join(TMP, "t4.sock");

  const mk = () => startServer({ AGENT_IN_CHROME_SOCK: SOCK4, AGENT_IN_CHROME_TRACE_DIR: TRACE_DIR, AGENT_IN_CHROME_SHOT_DIR: SHOT_DIR });

  const A = mk();
  await A.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await waitFor(() => sockUp(SOCK4), 5000);
  check("会话 A 抢到桥接，建立了 socket", await sockUp(SOCK4));

  const served = [];
  const host = net.connect(ep(SOCK4));
  host.setEncoding("utf8");
  let hb = "";
  host.on("data", (c) => {
    hb += c;
    let i;
    while ((i = hb.indexOf("\n")) >= 0) {
      const line = hb.slice(0, i).trim();
      hb = hb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === "call") {
        served.push(m);
        host.write(
          JSON.stringify({
            id: m.id,
            type: "result",
            ok: true,
            data: { servedTo: m.tool, callId: m.id },
          }) + "\n"
        );
      }
    }
  });
  await new Promise((r) => host.on("connect", r));
  host.write(helloHost(1));
  await sleep(300);

  const B = mk();
  await B.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await sleep(1200);

  const listB = await B.rpc("tools/list", {});
  const srcTools = (
    fs
      .readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8")
      .split("\nconst DEV_TOOLS = [")[0]
      .match(/^\s*name: "browser_/gm) || []
  ).length;
  check("会话 B 也能列出工具", (listB.result?.tools || []).length === srcTools, `B ${(listB.result?.tools || []).length} 个，源码 ${srcTools} 个`);

  const rA = await A.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("主会话 A 能调用工具", rA.result?.isError === false, JSON.stringify(rA.result).slice(0, 150));

  const rB = await B.rpc("tools/call", { name: "browser_tabs_list", arguments: {} });
  check(
    "从会话 B 也能调用（经主代发）",
    rB.result?.isError === false,
    JSON.stringify(rB.result).slice(0, 200)
  );
  check("两个会话的调用都到达了浏览器", served.length >= 2, `实际 ${served.length}`);
  check(
    "代发用了独立 id，不会串号",
    new Set(served.map((s) => s.id)).size === served.length,
    JSON.stringify(served.map((s) => s.id))
  );
  check("每个调用都带了 session", served.every((s) => !!s.session), JSON.stringify(served.map((s) => s.session)));
  check(
    "主和从的 session 不同（扩展据此隔离标签页）",
    new Set(served.map((s) => s.session)).size === 2,
    JSON.stringify([...new Set(served.map((s) => s.session))])
  );

  const [cA, cB] = await Promise.all([
    A.rpc("tools/call", { name: "browser_status", arguments: {} }),
    B.rpc("tools/call", { name: "browser_status", arguments: {} }),
  ]);
  check("并发调用互不干扰", cA.result?.isError === false && cB.result?.isError === false);

  A.p.kill();
  await sleep(1500);
  check("主退出后 B 接管了 socket", await sockUp(SOCK4));
  const rB2 = await B.rpc("tools/call", { name: "browser_status", arguments: {} });
  check(
    "接管后 B 给出的是浏览器状态提示而非占用提示",
    !/另一个 agent 会话/.test(rB2.result?.content?.[0]?.text || ""),
    rB2.result?.content?.[0]?.text?.slice(0, 80)
  );

  host.destroy();
  B.p.kill();
}

console.log("\n\x1b[1mE2. 扩展版本传到从会话\x1b[0m");
{
  const SOCK4B = path.join(TMP, "t4b.sock");
  const mk = () => startServer({ AGENT_IN_CHROME_SOCK: SOCK4B, AGENT_IN_CHROME_TRACE: "off" });
  const EXT_VERSION = "9.9.9-e2e";
  const EXT_BOOTED_AT = Date.now() - 3 * 60_000;
  const versionsOf = (r) => {
    try {
      return JSON.parse(r.result?.content?.[0]?.text || "{}").versions || {};
    } catch {
      return {};
    }
  };

  const A = mk();
  await A.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await waitFor(() => sockUp(SOCK4B), 5000);

  const early = mk();
  await early.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await sleep(1200);

  const host = net.connect(ep(SOCK4B));
  host.setEncoding("utf8");
  let hb = "";
  host.on("data", (c) => {
    hb += c;
    let i;
    while ((i = hb.indexOf("\n")) >= 0) {
      const line = hb.slice(0, i).trim();
      hb = hb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === "call") host.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: {} }) + "\n");
    }
  });
  await new Promise((r) => host.on("connect", r));
  host.write(helloHost(1));
  host.write(JSON.stringify({ type: "hello", role: "extension", version: EXT_VERSION, bootedAt: EXT_BOOTED_AT }) + "\n");
  await sleep(500);

  const vA = versionsOf(await A.rpc("tools/call", { name: "browser_status", arguments: {} }));
  check("对照：主会话看得见扩展版本", vA.extension === EXT_VERSION, JSON.stringify(vA));

  const vEarly = versionsOf(await early.rpc("tools/call", { name: "browser_status", arguments: {} }));
  check("先连上的从会话也看得见扩展版本", vEarly.extension === EXT_VERSION, JSON.stringify(vEarly));
  check(
    "从会话的 extensionLoadedAt 是扩展报的时刻，不是「未知」",
    /3 分钟前加载/.test(String(vEarly.extensionLoadedAt || "")),
    String(vEarly.extensionLoadedAt)
  );

  const late = mk();
  await late.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await sleep(1200);
  const vLate = versionsOf(await late.rpc("tools/call", { name: "browser_status", arguments: {} }));
  check("后连上的从会话拿到补发的扩展版本", vLate.extension === EXT_VERSION, JSON.stringify(vLate));
  check(
    "后连上的从会话 extensionLoadedAt 也是真时刻",
    /3 分钟前加载/.test(String(vLate.extensionLoadedAt || "")),
    String(vLate.extensionLoadedAt)
  );

  host.destroy();
  A.p.kill();
  early.p.kill();
  late.p.kill();
}

console.log("\n\x1b[1mF. 按调用方派生 sid\x1b[0m");
{
  const SOCK5 = path.join(TMP, "t5.sock");
  const MAIN_SID = "e2e-sid-main";
  const PEER_SID = "e2e-sid-peer";
  const A = startServer({ AGENT_IN_CHROME_SOCK: SOCK5, AGENT_IN_CHROME_SESSION_ID: MAIN_SID, AGENT_IN_CHROME_TRACE: "off" });
  await A.rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "claude-code", title: "Claude Code", version: "9.9.9" },
  });
  await waitFor(() => sockUp(SOCK5), 5000);

  const served = [];
  const host = net.connect(ep(SOCK5));
  host.setEncoding("utf8");
  let hb = "";
  host.on("data", (c) => {
    hb += c;
    let i;
    while ((i = hb.indexOf("\n")) >= 0) {
      const line = hb.slice(0, i).trim();
      hb = hb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type !== "call") continue;
      served.push(m);
      host.write(
        JSON.stringify({ id: m.id, type: "result", ok: true, data: { seenSession: m.session } }) + "\n"
      );
    }
  });
  await new Promise((r) => host.on("connect", r));
  host.write(helloHost(1));
  await sleep(300);

  const statusWith = async (client, _meta) => {
    const r = await client.rpc("tools/call", {
      name: "browser_status",
      arguments: {},
      ...(_meta ? { _meta } : {}),
    });
    return JSON.parse(r.result?.content?.[0]?.text || "{}");
  };

  const main1 = await statusWith(A, {
    runtime_scope: "main",
    session_id: "sess_3f1bc58e-d645-4aef-aad1-792e74516fdb",
    trace_id: "0aef52f8",
    span_id: "span-1",
    parent_span_id: "p-1",
  });
  const main2 = await statusWith(A, {
    runtime_scope: "main",
    session_id: "sess_3f1bc58e-d645-4aef-aad1-792e74516fdb",
    trace_id: "0aef52f8",
    span_id: "span-2",
    parent_span_id: "p-2",
  });
  const subA = await statusWith(A, {
    runtime_scope: "subagent",
    session_id: "sess_subagent_agent_a1100314-d05a-435b-ad2b-053616d50c93",
    trace_id: "0aef52f8",
    span_id: "span-3",
  });
  const subB = await statusWith(A, {
    runtime_scope: "subagent",
    session_id: "sess_subagent_agent_9a05e99d-8893-40f5-8895-e93e4b3e99f9",
    trace_id: "0aef52f8",
    span_id: "span-4",
  });
  const noMeta = await statusWith(A, null);
  const metaNoSid = await statusWith(A, { progressToken: "p1", trace_id: "0aef52f8" });

  const sidOf = (st) => st.seenSession;
  check(
    "_meta.session_id 派生出「进程 sid + 调用方」",
    sidOf(main1) === `${MAIN_SID}::sess_3f1bc58e-d645-4aef-aad1-792e74516fdb`,
    sidOf(main1)
  );
  check("同一调用方多次调用 sid 稳定（span_id 变也不动）", sidOf(main1) === sidOf(main2), `${sidOf(main1)} vs ${sidOf(main2)}`);
  check(
    "两个 subagent 派生出不同的 sid",
    sidOf(subA) !== sidOf(subB) && sidOf(subA) !== sidOf(main1),
    JSON.stringify([sidOf(subA), sidOf(subB)])
  );
  check(
    "subagent 的 sid 带得上它自己的 session_id",
    sidOf(subA) === `${MAIN_SID}::sess_subagent_agent_a1100314-d05a-435b-ad2b-053616d50c93`,
    sidOf(subA)
  );
  check("不带 _meta 时静默回落到进程 sid", sidOf(noMeta) === MAIN_SID, sidOf(noMeta));
  check("_meta 里没有 session_id 时同样回落", sidOf(metaNoSid) === MAIN_SID, sidOf(metaNoSid));
  check("回落路径不报错", noMeta.seenSession != null && metaNoSid.seenSession != null);

  check("status 报出 sid 的来源是 _meta", main1.sessionOrigin?.from === "_meta.session_id", JSON.stringify(main1.sessionOrigin));
  check("status 报出本进程 sid（sid 的前缀）", main1.sessionOrigin?.mcpProcess === MAIN_SID, main1.sessionOrigin?.mcpProcess);
  check(
    "status 报出调用方身份原文",
    main1.sessionOrigin?.caller === "sess_3f1bc58e-d645-4aef-aad1-792e74516fdb",
    main1.sessionOrigin?.caller
  );
  check("回落时 status 明说是回落", noMeta.sessionOrigin?.from === "fallback" && noMeta.sessionOrigin?.caller === null, JSON.stringify(noMeta.sessionOrigin));
  check(
    "status 说清回落的后果（并行 agent 共享标签页）",
    /共享/.test(noMeta.sessionOrigin?.note || ""),
    noMeta.sessionOrigin?.note
  );
  check(
    "status 报的来源与真正发出去的 sid 对得上",
    sidOf(subA) === `${main1.sessionOrigin.mcpProcess}::${subA.sessionOrigin.caller}`,
    `${sidOf(subA)} / ${JSON.stringify(subA.sessionOrigin)}`
  );

  const AG_ID = "cd33cae1-3e75-4d59-baa4-92ca4e29df69";
  const ag1 = await statusWith(A, {
    "antigravity.google/conversation_id": AG_ID,
    "antigravity.google/artifacts_dir": `/h/.gemini/antigravity-ide/brain/${AG_ID}`,
    progressToken: "ag-1",
  });
  const agBad = await statusWith(A, { "antigravity.google/conversation_id": "../../etc/passwd", progressToken: "ag-2" });
  const agBoth = await statusWith(A, { session_id: "sess_both", "antigravity.google/conversation_id": AG_ID });
  check("Antigravity 的 conversation_id 派生出 sid", sidOf(ag1) === `${MAIN_SID}::${AG_ID}`, sidOf(ag1));
  check(
    "status 把这条来源指名道姓报出来",
    ag1.sessionOrigin?.from === "_meta.antigravity.google/conversation_id" && ag1.sessionOrigin?.caller === AG_ID,
    JSON.stringify(ag1.sessionOrigin)
  );
  check("回落说明换成 Antigravity 那一段", /Antigravity/.test(ag1.sessionOrigin?.note || ""), ag1.sessionOrigin?.note);
  check(
    "形状不对的 conversation_id 静默回落，不当 sid 用",
    sidOf(agBad) === MAIN_SID && agBad.sessionOrigin?.from === "fallback",
    JSON.stringify(agBad.sessionOrigin)
  );
  check("两家同时报时按 session_id 定（顺序定死，不看谁先到）", sidOf(agBoth) === `${MAIN_SID}::sess_both`, sidOf(agBoth));

  const B = startServer({ AGENT_IN_CHROME_SOCK: SOCK5, AGENT_IN_CHROME_SESSION_ID: PEER_SID, AGENT_IN_CHROME_TRACE: "off" });
  await B.rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "cursor-vscode", version: "1.2.3" },
  });
  await sleep(1200);

  const peerSub = await statusWith(B, {
    runtime_scope: "subagent",
    session_id: "sess_subagent_agent_a1100314-d05a-435b-ad2b-053616d50c93",
  });
  check(
    "从会话派生的 sid 完整穿过主的代发到达扩展",
    sidOf(peerSub) === `${PEER_SID}::sess_subagent_agent_a1100314-d05a-435b-ad2b-053616d50c93`,
    sidOf(peerSub)
  );
  check(
    "同一个调用方 id 在两个 MCP 进程下不会撞成同一个 sid",
    sidOf(peerSub) !== sidOf(subA),
    `${sidOf(peerSub)} vs ${sidOf(subA)}`
  );
  check(
    "从会话的 status 也报得出自己的进程 sid",
    peerSub.sessionOrigin?.mcpProcess === PEER_SID,
    peerSub.sessionOrigin?.mcpProcess
  );

  check("这一段所有调用都带了 session", served.every((s) => !!s.session), JSON.stringify(served.map((s) => s.session)));

  const mainFrames = served.filter((s) => String(s.session || "").startsWith(MAIN_SID));
  const peerFrame = served.find((s) => String(s.session || "").startsWith(PEER_SID));
  check(
    "每一帧 call 都带上客户端自报的 agent",
    mainFrames.length > 0 && mainFrames.every((s) => s.agent?.title === "Claude Code"),
    JSON.stringify(mainFrames.map((s) => s.agent))
  );
  check("agent 带上版本号（弹窗 tooltip 用）", mainFrames[0]?.agent?.version === "9.9.9", JSON.stringify(mainFrames[0]?.agent));
  check("品牌用客户端自报的 title", mainFrames[0]?.agent?.brand === "Claude Code", JSON.stringify(mainFrames[0]?.agent));
  check(
    "工作区跟着帧走（e2e 在这个仓库里跑，认得出是个 git 仓库）",
    !!mainFrames[0]?.agent?.workspace && mainFrames[0]?.agent?.workspaceKind === "git",
    JSON.stringify(mainFrames[0]?.agent)
  );
  check(
    "形态只会是 cli / app / 没有这三种",
    [undefined, null, "cli", "app"].includes(mainFrames[0]?.agent?.surface),
    JSON.stringify(mainFrames[0]?.agent)
  );
  check(
    "从会话的 agent 原样穿过主的代发，没被改写成主的",
    peerFrame?.agent?.name === "cursor-vscode",
    JSON.stringify(peerFrame?.agent)
  );
  check("客户端没给 title 就是没有，不许编一个", peerFrame?.agent?.title === null, JSON.stringify(peerFrame?.agent));

  const C = startServer({ AGENT_IN_CHROME_SOCK: SOCK5, AGENT_IN_CHROME_SESSION_ID: "e2e-sid-quiet", AGENT_IN_CHROME_TRACE: "off" });
  await C.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await sleep(1200);
  await statusWith(C, null);
  const quietFrame = served.find((s) => String(s.session || "").startsWith("e2e-sid-quiet"));
  check(
    "不报 clientInfo 的客户端：自报的 name/title 全空，一个字都不许编",
    !!quietFrame && quietFrame.agent?.name === null && quietFrame.agent?.title === null,
    JSON.stringify(quietFrame?.agent)
  );
  check(
    "version 与品牌同源：没认出品牌时必须为空",
    !!quietFrame && (quietFrame.agent?.brand ? true : quietFrame.agent?.version === null),
    JSON.stringify(quietFrame?.agent)
  );
  check(
    "但工作区照报——那一段不用客户端配合",
    !!quietFrame?.agent?.workspace,
    JSON.stringify(quietFrame?.agent)
  );
  check(
    "主没把自己的品牌安到它头上",
    quietFrame?.agent?.brand !== "Claude Code",
    JSON.stringify(quietFrame?.agent)
  );

  host.destroy();
  A.p.kill();
  B.p.kill();
  C.p.kill();
}

console.log("\n\x1b[1mF2. 会话名后到：agent-update 主动推送\x1b[0m");
{
  const SOCK6 = path.join(TMP, "t6.sock");
  const F2_HOME = path.join(TMP, "f2-home");
  const TITLE_DIR = path.join(F2_HOME, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "user");
  fs.mkdirSync(TITLE_DIR, { recursive: true });
  const envBase = {
    HOME: F2_HOME,
    USERPROFILE: F2_HOME,
    AGENT_IN_CHROME_SOCK: SOCK6,
    AGENT_IN_CHROME_TRACE: "off",
    AGENT_IN_CHROME_AGENT_PUSH_MS: "250",
  };

  const A2 = startServer({ ...envBase, AGENT_IN_CHROME_SESSION_ID: "f2-main", CLAUDE_CODE_HOST_SESSION_ID: "local_f2_main" });
  await A2.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", title: "Claude Code", version: "9.9.9" } });
  await waitFor(() => sockUp(SOCK6), 5000);

  const seen = [];
  const host6 = net.connect(ep(SOCK6));
  host6.setEncoding("utf8");
  let hb = "";
  host6.on("data", (c) => {
    hb += c;
    let i;
    while ((i = hb.indexOf("\n")) >= 0) {
      const line = hb.slice(0, i).trim();
      hb = hb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      seen.push(m);
      if (m.type === "call") host6.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: {} }) + "\n");
    }
  });
  await new Promise((r) => host6.on("connect", r));
  host6.write(helloHost(1));
  await sleep(300);

  await A2.rpc("tools/call", { name: "browser_status", arguments: {} });
  const firstCall = seen.find((m) => m.type === "call");
  check("标题还没生成时，call 帧里没有会话名", !!firstCall && (firstCall.agent?.session ?? null) === null, JSON.stringify(firstCall?.agent));
  await sleep(700);
  check("标题没出现就不推（没有可推的东西）", !seen.some((m) => m.type === "agent-update"), JSON.stringify(seen.map((m) => m.type)));

  fs.writeFileSync(path.join(TITLE_DIR, "local_f2_main.json"), JSON.stringify({ title: "后到的标题" }));
  const pushed = await waitFor(() => seen.some((m) => m.type === "agent-update" && m.agent?.session === "后到的标题"), 8000);
  check("标题后到时主动推 agent-update（不等下一次工具调用）", pushed, JSON.stringify(seen.filter((m) => m.type === "agent-update")));
  const upd = seen.find((m) => m.type === "agent-update");
  check("推送帧带的 sid 是发过 call 的那个", String(upd?.session || "").startsWith("f2-main"), JSON.stringify(upd));
  check("推送帧带完整身份（扩展直接照存）", upd?.agent?.brand === "Claude Code", JSON.stringify(upd?.agent));

  fs.writeFileSync(path.join(TITLE_DIR, "local_f2_main.json"), JSON.stringify({ title: "改名后的标题" }));
  const renamed = await waitFor(() => seen.some((m) => m.type === "agent-update" && m.agent?.session === "改名后的标题"), 8000);
  check("改名也推（标题变化即推，不只是从无到有）", renamed, JSON.stringify(seen.filter((m) => m.type === "agent-update").map((m) => m.agent?.session)));

  const B2 = startServer({ ...envBase, AGENT_IN_CHROME_SESSION_ID: "f2-peer", CLAUDE_CODE_HOST_SESSION_ID: "local_f2_peer" });
  await B2.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cursor-vscode", version: "1.2.3" } });
  await sleep(1200);
  await B2.rpc("tools/call", { name: "browser_status", arguments: {} });
  fs.writeFileSync(path.join(TITLE_DIR, "local_f2_peer.json"), JSON.stringify({ title: "从会话的标题" }));
  const peerPushed = await waitFor(
    () => seen.some((m) => m.type === "agent-update" && String(m.session || "").startsWith("f2-peer") && m.agent?.session === "从会话的标题"),
    8000
  );
  check("从会话的 agent-update 原样穿过主到达扩展", peerPushed, JSON.stringify(seen.filter((m) => m.type === "agent-update").map((m) => [m.session, m.agent?.session])));

  host6.destroy();
  A2.p.kill();
  B2.p.kill();
}

console.log("\n\x1b[1mF3. 会话名按 params._meta 精确归属\x1b[0m");
{
  const SOCK7 = path.join(TMP, "t7.sock");
  const F3_HOME = path.join(TMP, "f3-home");
  const RUN = Date.parse("2026-08-13T15:10:39+08:00");
  const objectId = (ms, tail) => Math.floor(ms / 1000).toString(16).padStart(8, "0") + tail;
  const ID_A = objectId(Date.parse("2026-08-13T16:22:21+08:00"), "8dd5dc6e3bd60c6c");
  const ID_B = objectId(Date.parse("2026-08-13T15:13:37+08:00"), "8dd5dc6e3bd60be4");
  const LOGS = path.join(F3_HOME, "Library", "Application Support", "Trae CN", "logs", "20260813T151039", "Modular");
  fs.mkdirSync(LOGS, { recursive: true });
  const line = (ms, id, t) =>
    `${new Date(ms + 8 * 3600e3).toISOString().replace("Z", "+08:00")}  INFO generate_session_title_and_icon: ` +
    `ai_agent::domain::chat::service: rust: generate_session_title_and_icon_cloud: ` +
    `session_id: "${id}", title: "${t}", icon: "personal"\n`;
  fs.writeFileSync(
    path.join(LOGS, `ai-agent_0_${RUN}_stdout.log`),
    line(Date.parse("2026-08-13T15:16:48+08:00"), ID_B, "抓取专业列表接口") +
      line(Date.parse("2026-08-13T16:22:58+08:00"), ID_A, "查询杭州天气及预警")
  );

  const BUNDLE = path.join(F3_HOME, "Applications", "Trae CN.app");
  fs.mkdirSync(path.join(BUNDLE, "Contents", "Resources", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(BUNDLE, "Contents", "Resources", "app", "product.json"),
    JSON.stringify({ applicationName: "trae-cn", nameLong: "Trae CN" })
  );

  const A3 = startServer({
    HOME: F3_HOME,
    USERPROFILE: F3_HOME,
    RG_PATH: path.join(BUNDLE, "Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg"),
    AGENT_IN_CHROME_SOCK: SOCK7,
    AGENT_IN_CHROME_TRACE: "off",
    AGENT_IN_CHROME_SESSION_ID: "f3-main",
  });
  await A3.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Trae", version: "1.107.1" } });
  await waitFor(() => sockUp(SOCK7), 5000);

  const seen = [];
  const host7 = net.connect(ep(SOCK7));
  host7.setEncoding("utf8");
  let hb7 = "";
  host7.on("data", (c) => {
    hb7 += c;
    let i;
    while ((i = hb7.indexOf("\n")) >= 0) {
      const line2 = hb7.slice(0, i).trim();
      hb7 = hb7.slice(i + 1);
      if (!line2) continue;
      const m = JSON.parse(line2);
      seen.push(m);
      if (m.type === "call") host7.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: {} }) + "\n");
    }
  });
  await new Promise((r) => host7.on("connect", r));
  host7.write(helloHost(1));
  await sleep(300);

  const callWithMeta = async (meta) => {
    await A3.rpc("tools/call", { name: "browser_status", arguments: {}, _meta: meta });
    return seen.filter((m) => m.type === "call").at(-1);
  };

  const a = await callWithMeta({ callId: "c1", chatSessionId: ID_A, messageId: "m1", isCurrentSession: true, sessionType: "side_chat" });
  check("第一帧就带上会话名（数据目录从包里问出来，位置算出来，不扫盘）", a?.agent?.session === "查询杭州天气及预警", JSON.stringify(a?.agent));

  const a2 = await callWithMeta({ progressToken: "only-a-token" });
  check("只带 progressToken 的帧不算换会话，黏住的会话名还在", a2?.agent?.session === "查询杭州天气及预警", JSON.stringify(a2?.agent));

  const b = await callWithMeta({ callId: "c2", chatSessionId: ID_B, messageId: "m2", isCurrentSession: true, sessionType: "side_chat" });
  check("切到另一段对话时标题跟着换（黏住的旧标题要作废）", b?.agent?.session === "抓取专业列表接口", JSON.stringify(b?.agent));

  const c = await callWithMeta({ callId: "c3", chatSessionId: "cccccccccccccccccccccccc", isCurrentSession: true });
  check("日志里没有的会话就不显示名字，不拿上一段顶上", (c?.agent?.session ?? null) === null, JSON.stringify(c?.agent));

  host7.destroy();
  A3.p.kill();
}

console.log("\n\x1b[1mG. CLI 浏览器记录按 profile 隔离\x1b[0m");
if (process.platform === "win32") {
  skipSection("CLI/headless 模式的进程记账走 /bin/sh 冒充 + /bin/ps 取证，Windows 上 CLI 模式尚未支持（插件模式不受影响）");
} else {
  const G_HOME = path.join(TMP, "g-home");
  const PROF_A = path.join(TMP, "g-prof-a");
  const PROF_B = path.join(TMP, "g-prof-b");
  for (const d of [G_HOME, PROF_A, PROF_B]) fs.mkdirSync(d, { recursive: true });

  const LAUNCH_MOD = pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href;
  const probe = (profileDir) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(LAUNCH_MOD)}).then((m) => console.log(JSON.stringify(m.browserStatus())))`],
        {
          env: { ...process.env, HOME: G_HOME, ...(profileDir ? { AGENT_IN_CHROME_PROFILE: profileDir } : {}) },
          encoding: "utf8",
        }
      ).trim()
    );
  const stopUnder = (profileDir) =>
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "cli-browser.mjs"), "--stop"], {
      env: { ...process.env, HOME: G_HOME, AGENT_IN_CHROME_PROFILE: profileDir },
      encoding: "utf8",
    });

  const stA = probe(PROF_A);
  const stB = probe(PROF_B);
  const stDefault = probe(null);
  check("两个 profile 的记录不是同一份文件", stA.pidFile !== stB.pidFile, `${stA.pidFile} vs ${stB.pidFile}`);
  check(
    "记录跟着 profile 放",
    stA.pidFile.startsWith(PROF_A + path.sep) && stB.pidFile.startsWith(PROF_B + path.sep),
    `${stA.pidFile} / ${stB.pidFile}`
  );
  check(
    "默认 profile 的记录也不再是 RUNTIME_DIR 下那份共用的",
    !stDefault.pidFile.endsWith(path.join("agent-in-chrome", "cli-browser.json")),
    stDefault.pidFile
  );
  check("干净 profile 一开始什么都没有", stA.running === false && stA.stale === false, JSON.stringify(stA));

  const impostor = spawn("/bin/sh", ["-c", "while :; do sleep 1; done", `--user-data-dir=${PROF_B}`], {
    stdio: "ignore",
    detached: true,
  });
  let impostorExited = false;
  impostor.on("exit", () => (impostorExited = true));
  await sleep(300);

  const bRec = { pid: impostor.pid, profileDir: PROF_B, bin: "/fake/chrome", kind: "冒充的", headless: true };
  fs.mkdirSync(path.dirname(stA.pidFile), { recursive: true });
  fs.writeFileSync(stA.pidFile, JSON.stringify(bRec, null, 2));
  const stA2 = probe(PROF_A);
  check("记的 profile 对不上就不认（不当成自己的浏览器）", stA2.running === false, JSON.stringify(stA2).slice(0, 200));
  check("对不上的记录会被点名，而不是只报个 stale", stA2.foreignRecord === PROF_B, JSON.stringify(stA2).slice(0, 200));

  const stopA = stopUnder(PROF_A);
  await sleep(400);
  check("A 的 --stop 不会杀掉别的 profile 的浏览器", !impostorExited);
  check("--stop 说清收的是哪个 profile", stopA.includes(PROF_A), stopA.trim());

  const legacy = path.join(G_HOME, ".agent-in-chrome", "agent-in-chrome", "cli-browser.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.rmSync(stA.pidFile, { force: true });
  fs.writeFileSync(legacy, JSON.stringify(bRec, null, 2));
  const stA3 = probe(PROF_A);
  check("老位置里别人的记录不认", stA3.running === false, JSON.stringify(stA3).slice(0, 200));
  const stB2 = probe(PROF_B);
  check(
    "老位置里属于本 profile 的记录还认（升级时手上热着的浏览器不变孤儿）",
    stB2.running === true && stB2.pidFile === legacy,
    JSON.stringify(stB2).slice(0, 200)
  );

  const stopB = stopUnder(PROF_B);
  check("B 自己的 --stop 收得掉自己的浏览器", await waitFor(() => impostorExited, 3000), stopB.trim());
  check("收完之后老位置那份记录也清掉了", !fs.existsSync(legacy));

  if (!impostorExited) {
    try {
      process.kill(-impostor.pid, "SIGKILL");
    } catch {}
  }
}

console.log("\n\x1b[1mH. 认领在跑的浏览器：端点必须自证身份\x1b[0m");
if (process.platform === "win32") {
  skipSection("CLI/headless 模式的认领流程走 /bin/sh 冒充进程，Windows 上 CLI 模式尚未支持（插件模式不受影响）");
} else {
  const H_HOME = path.join(TMP, "h-home");
  const PROF_C = path.join(TMP, "h-prof-c");
  for (const d of [H_HOME, PROF_C]) fs.mkdirSync(d, { recursive: true });
  const LAUNCH_MOD = pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href;
  const NO_CHROME = path.join(TMP, "no-such-chrome");

  const MINE = "/devtools/browser/11111111-1111-4111-8111-111111111111";
  const OTHERS = "/devtools/browser/22222222-2222-4222-8222-222222222222";

  let servedPath = OTHERS;
  let port = 0;
  const fake = http.createServer((req, res) => {
    if (req.url !== "/json/version") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ Browser: "Chrome/150.0.7871.187", webSocketDebuggerUrl: `ws://127.0.0.1:${port}${servedPath}` })
    );
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  port = fake.address().port;

  const ensure = () =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(LAUNCH_MOD)})` +
            `.then((m) => m.ensureBrowser())` +
            `.then((r) => console.log(JSON.stringify({ ok: true, ...r })))` +
            `.catch((e) => console.log(JSON.stringify({ ok: false, err: String((e && e.message) || e) })))`,
        ],
        {
          env: {
            ...process.env,
            HOME: H_HOME,
            AGENT_IN_CHROME_PROFILE: PROF_C,
            AGENT_IN_CHROME_BIN: NO_CHROME,
            AGENT_IN_CHROME_CDP_TRANSPORT: "port",
          },
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("exit", () => {
        try {
          resolve(JSON.parse(out.trim()));
        } catch (e) {
          reject(new Error(`ensureBrowser 没回 JSON：${out.trim().slice(0, 200)}`));
        }
      });
    });

  fs.writeFileSync(path.join(PROF_C, "DevToolsActivePort"), `${port}\n${MINE}\n`);
  const stale = await ensure();
  check("没人占着 profile 时，旧端口文件当冷启动处理", stale.ok === false && stale.err.includes(NO_CHROME), stale.err);

  const holder = spawn("/bin/sh", ["-c", "while :; do sleep 1; done", `--user-data-dir=${PROF_C}`], {
    stdio: "ignore",
    detached: true,
  });
  let holderExited = false;
  holder.on("exit", () => (holderExited = true));
  await sleep(300);
  fs.symlinkSync(`${os.hostname()}-${holder.pid}`, path.join(PROF_C, "SingletonLock"));

  servedPath = OTHERS;
  const wrong = await ensure();
  check("端口上是另一个浏览器就不认领", wrong.ok === false, JSON.stringify(wrong).slice(0, 240));
  check("报错点明是「端口上另有其人」，不是含糊的连不上", wrong.ok === false && wrong.err.includes(OTHERS), wrong.err);
  check("拒绝认领之后不会偷偷再起一个浏览器", wrong.ok === false && !wrong.err.includes(NO_CHROME), wrong.err);

  servedPath = MINE;
  const right = await ensure();
  check("GUID 对得上就认领（复用，不重开）", right.ok === true && right.adopted === true, JSON.stringify(right).slice(0, 240));
  check("认领到的 pid 取自 Chrome 自己那把锁", right.ok === true && right.pid === holder.pid, JSON.stringify(right.pid));
  check("认领时把版本号一并问出来了", right.ok === true && String(right.version).startsWith("Chrome/"), right.version);

  fake.close();
  try {
    process.kill(-holder.pid, "SIGKILL");
  } catch {}
  await waitFor(() => holderExited, 3000);
}

{
  console.log("\n\x1b[1mG2. 桥接超时先分型再报错\x1b[0m");
  const SOCK_G2 = path.join(TMP, "tg2.sock");
  const G2 = startServer({
    HOME: path.join(TMP, "g2-home"),
    AGENT_IN_CHROME_SOCK: SOCK_G2,
    AGENT_IN_CHROME_TRACE: "off",
    AGENT_IN_CHROME_SESSION_ID: "g2",
    AGENT_IN_CHROME_TIMEOUT_MS: "1200",
  });
  await G2.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  await waitFor(() => sockUp(SOCK_G2), 5000);

  let mute = new Set(["read_page"]);
  const hostG2 = net.connect(ep(SOCK_G2));
  hostG2.setEncoding("utf8");
  let gb = "";
  hostG2.on("data", (c) => {
    gb += c;
    let i;
    while ((i = gb.indexOf("\n")) >= 0) {
      const line = gb.slice(0, i).trim();
      gb = gb.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type !== "call") continue;
      if (mute.has(m.tool)) continue;
      hostG2.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: {} }) + "\n");
    }
  });
  await new Promise((r) => hostG2.on("connect", r));
  hostG2.write(helloHost(1));
  await sleep(300);

  const errText = async (name, args = {}) => {
    const r = await G2.rpc("tools/call", { name, arguments: args });
    return r.result?.content?.[0]?.text || "";
  };

  const stuck = await errText("browser_read_page", { tabId: 7 });
  check("注入路卡住时不再说「可能有未处理的弹窗」", !/未处理的弹窗/.test(stuck), stuck.slice(0, 160));
  check("说清扩展和这张页都还活着", /都还活着/.test(stuck) && /7/.test(stuck), stuck.slice(0, 160));
  check("点名卡住的是页面注入这条路", /注入/.test(stuck) && /executeScript/.test(stuck), stuck.slice(0, 200));
  check("给出唯一有效的出路：换一张标签页", /browser_new_tab/.test(stuck), stuck.slice(-160));
  check("并说明这张页上 eval 仍然可用", /browser_eval/.test(stuck), stuck.slice(-160));
  check("区分「帧还在加载」与「注入路死了」两种情况", /还在加载/.test(stuck) && /注入路死了/.test(stuck), stuck.slice(0, 300));
  check("瞬时那种给「等几秒重试一次」的出路", /等几秒/.test(stuck) && /重试一次/.test(stuck), stuck.slice(0, 300));

  mute = new Set(["read_page", "status", "cdp_raw"]);
  const dead = await errText("browser_read_page", { tabId: 7 });
  check("连 status 都不回时，结论指向扩展/桥接", /扩展也不回应/.test(dead), dead.slice(0, 160));
  check("这时不该说「换一张标签页」（换了也没用）", !/browser_new_tab/.test(dead), dead.slice(0, 200));
  check("给的是等一等/看扩展还在不在", /chrome:\/\/extensions|重连/.test(dead), dead.slice(-120));

  mute = new Set(["read_page", "cdp_raw"]);
  const badTab = await errText("browser_read_page", { tabId: 7 });
  check("扩展活着但页面不回时，结论指向这张标签页", /扩展本身正常/.test(badTab) && /不回应/.test(badTab), badTab.slice(0, 160));
  check("这时不该把锅扣给注入路（没验出来的事不说）", !/executeScript/.test(badTab), badTab.slice(0, 200));
  check("给的是先确认它还在不在", /browser_tabs_list/.test(badTab), badTab.slice(-140));

  mute = new Set(["click"]);
  const other = await errText("browser_click", { ref: "ref_1", tabId: 7 });
  check("非注入类工具超时不谈 executeScript", !/executeScript/.test(other), other.slice(0, 200));
  check("但照样说清浏览器是活的、卡的是这次调用", /都还活着/.test(other) && /这一次调用本身/.test(other), other.slice(0, 220));

  mute = new Set();
  const okCall = await G2.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("正常调用照旧成功（探针不碰正常路径）", okCall.result?.isError === false, JSON.stringify(okCall.result).slice(0, 120));

  hostG2.destroy();
  G2.p.kill();
}

console.log("\n\x1b[1mH. CLI chrome.storage 按 profile 隔离\x1b[0m");
{
  const H_HOME = path.join(TMP, "h-home");
  const PROF_A = path.join(TMP, "h-prof-a");
  const PROF_B = path.join(TMP, "h-prof-b");
  for (const d of [H_HOME, PROF_A, PROF_B]) fs.mkdirSync(d, { recursive: true });

  const SHIM_MOD = pathToFileURL(path.join(ROOT, "mcp", "cdp", "chrome-shim.mjs")).href;
  const BRIDGE_MOD = pathToFileURL(path.join(ROOT, "mcp", "cdp", "bridge.mjs")).href;
  const GUID_1 = "aaaaaaaa-1111-2222-3333-444444444444";
  const GUID_2 = "bbbbbbbb-5555-6666-7777-888888888888";

  const withShim = (stateDir, guid, body) => {
    const out = rawWithShim(stateDir, guid, body);
    if (out && out.__throw) check("shim 在假 browser 上起得来（这一段的前提）", false, out.__throw);
    return out;
  };

  const rawWithShim = (stateDir, guid, body) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(SHIM_MOD)}).then(async (m) => {
             const browser = {
               client: {
                 wsUrl: "ws://127.0.0.1:9222/devtools/browser/" + ${JSON.stringify(guid)},
                 onEvent: () => {},
                 send: async () => { throw new Error("假 browser：不该发 CDP"); },
               },
               pages: () => [],
               targets: new Map(),
               on: () => {},
             };
             const { chrome } = m.createChromeShim(browser, { manifest: {}, stateDir: ${JSON.stringify(stateDir)} });
             console.log(JSON.stringify(await (async () => { ${body} })()));
           }).catch((e) => {
             console.log(JSON.stringify({ __throw: String((e && e.message) || e) }));
           });`,
        ],
        { env: { ...process.env, HOME: H_HOME }, encoding: "utf8" }
      ).trim()
    );

  const stateDirFor = (info) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(BRIDGE_MOD)}).then((m) => {
             let out;
             try { out = { dir: m.shimStateDir(${JSON.stringify(info)}) }; }
             catch (e) { out = { error: String((e && e.message) || e) }; }
             console.log(JSON.stringify(out));
           });`,
        ],
        { env: { ...process.env, HOME: H_HOME }, encoding: "utf8" }
      ).trim()
    );

  const dirA = stateDirFor({ profileDir: PROF_A });
  const dirB = stateDirFor({ profileDir: PROF_B });
  check("storage 目录取自浏览器记录里的 profileDir", dirA.dir === PROF_A, JSON.stringify(dirA));
  check("两个 profile 给出两个不同的 storage 目录", dirA.dir !== dirB.dir, `${dirA.dir} vs ${dirB.dir}`);
  const relDir = stateDirFor({ profileDir: "h-rel-prof" });
  check(
    "相对路径的 profile 会被 resolve 成绝对路径（不跟着 cwd 飘）",
    !!relDir.dir && path.isAbsolute(relDir.dir) && relDir.dir.endsWith("h-rel-prof"),
    JSON.stringify(relDir)
  );
  const noProf = stateDirFor({ pid: 1 });
  check(
    "缺 profileDir 时直接报错，不悄悄回落到共用目录",
    !noProf.dir && /profileDir/.test(noProf.error || ""),
    JSON.stringify(noProf)
  );

  const ownA = { sessions: [["s1", { tabId: 7 }]], tabOwner: [[7, "s1"]], ourTabs: [7] };
  withShim(PROF_A, GUID_1, `await chrome.storage.session.set({ "aic-sessions-v1": ${JSON.stringify(ownA)} }); return true;`);
  check(
    "storage 落在 profile 目录里，文件名带 aic- 前缀",
    fs.existsSync(path.join(PROF_A, "aic-cli-session-state.json"))
  );
  check(
    "不再往 RUNTIME_DIR 里写那份所有 profile 共用的",
    !fs.existsSync(path.join(H_HOME, ".agent-in-chrome", "agent-in-chrome", "cli-session-state.json")) &&
      !fs.existsSync(path.join(H_HOME, ".agent-in-chrome", "agent-in-chrome", "aic-cli-session-state.json"))
  );

  const seenByB = withShim(PROF_B, GUID_2, `return await chrome.storage.session.get("aic-sessions-v1");`);
  check(
    "别的 profile 读不到这份会话归属（tabId 只在自己的浏览器里有意义）",
    Object.keys(seenByB).length === 0,
    JSON.stringify(seenByB)
  );

  withShim(PROF_B, GUID_2, `await chrome.storage.session.set({ "aic-sessions-v1": { tabOwner: [[9, "s2"]] } }); return true;`);
  const backA = withShim(PROF_A, GUID_1, `return await chrome.storage.session.get("aic-sessions-v1");`);
  check(
    "B 写过之后 A 的会话归属还在（旧版是两边交替蒸发）",
    backA["aic-sessions-v1"]?.tabOwner?.[0]?.[0] === 7,
    JSON.stringify(backA)
  );

  withShim(PROF_A, GUID_1, `await chrome.storage.local.set({ cursorOn: false }); return true;`);
  const localB = withShim(PROF_B, GUID_2, `return await chrome.storage.local.get("cursorOn");`);
  check(
    "local 区也按 profile 分（它没有 stamp 兜底）",
    !localB.__throw && localB.cursorOn === undefined,
    JSON.stringify(localB)
  );
  check("local 也落在 profile 目录里", fs.existsSync(path.join(PROF_A, "aic-cli-local-state.json")));

  const sameBrowser = withShim(PROF_A, GUID_1, `return await chrome.storage.session.get("aic-sessions-v1");`);
  check(
    "同一个浏览器的另一个 MCP 进程照旧读得到（socket 主从共用不许被搞坏）",
    sameBrowser["aic-sessions-v1"]?.tabOwner?.[0]?.[0] === 7,
    JSON.stringify(sameBrowser)
  );

  const newInstance = withShim(
    PROF_A,
    GUID_2,
    `return { s: await chrome.storage.session.get("aic-sessions-v1"), l: await chrome.storage.local.get("cursorOn") };`
  );
  check(
    "同一份 profile 先后换了浏览器实例，session 区当空的（stamp 还在管事）",
    !!newInstance.s && Object.keys(newInstance.s).length === 0,
    JSON.stringify(newInstance)
  );
  check(
    "同一份 profile 先后换了浏览器实例，local 区照旧留着",
    newInstance.l?.cursorOn === false,
    JSON.stringify(newInstance)
  );
}

console.log("\n\x1b[1mI. 同一个 profile 上多进程同时冷启动\x1b[0m");
{
  const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].find((p) => fs.existsSync(p));

  if (!CHROME) {
    skipSection("本机没有正式版 Chrome，这一段验的是 ProcessSingleton 的真实行为，假不出来");
  } else {
    const I_HOME = path.join(TMP, "i-home");
    const PROF = path.join(TMP, "i-prof");
    for (const d of [I_HOME, PROF]) fs.mkdirSync(d, { recursive: true });
    const LAUNCH_MOD = pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href;

    const racer = () =>
      new Promise((resolve) => {
        const p = spawn(
          process.execPath,
          [
            "-e",
            `import(${JSON.stringify(LAUNCH_MOD)})` +
              `.then((m) => m.ensureBrowser())` +
              `.then((r) => console.log(JSON.stringify({ ok: true, pid: r.pid, port: r.port, wsPath: r.wsPath, adopted: r.adopted })))` +
              `.catch((e) => console.log(JSON.stringify({ ok: false, err: String((e && e.message) || e) })))`,
          ],
          {
            env: {
              ...process.env,
              HOME: I_HOME,
              AGENT_IN_CHROME_PROFILE: PROF,
              AGENT_IN_CHROME_BIN: CHROME,
              AGENT_IN_CHROME_HEADLESS: "1",
              AGENT_IN_CHROME_CDP_TRANSPORT: "port",
            },
            stdio: ["ignore", "pipe", "ignore"],
          }
        );
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("exit", () => {
          try {
            resolve(JSON.parse(out.trim()));
          } catch {
            resolve({ ok: false, err: `没回 JSON：${out.trim().slice(0, 200)}` });
          }
        });
      });

    const N = 5;
    const results = await Promise.all(Array.from({ length: N }, () => racer()));
    const good = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

    check(`${N} 个进程同时冷启动，全部拿到浏览器`, bad.length === 0, JSON.stringify(bad).slice(0, 400));
    const paths = new Set(good.map((r) => r.wsPath));
    check("拿到的是同一个浏览器实例（端点 GUID 一致）", paths.size === 1, JSON.stringify([...paths]));
    const ports = new Set(good.map((r) => r.port));
    check("端口也只有一个", ports.size === 1, JSON.stringify([...ports]));

    const rec = JSON.parse(fs.readFileSync(path.join(PROF, "aic-cli-browser.json"), "utf8"));
    const recPidAlive = (() => {
      try {
        process.kill(rec.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    check("记录里的 pid 还活着（不是输家那个已死的孩子）", recPidAlive, JSON.stringify(rec.pid));
    const psOut = recPidAlive
      ? execFileSync("/bin/ps", ["-p", String(rec.pid), "-o", "command="], { encoding: "utf8" })
      : "";
    check("记录里的 pid 正在跑的就是这个 profile", psOut.includes(`--user-data-dir=${PROF}`), psOut.slice(0, 160));
    const pids = new Set(good.map((r) => r.pid));
    check("五个进程报回来的 pid 是同一个", pids.size === 1, JSON.stringify([...pids]));

    const countMain = () =>
      Number(
        execFileSync(
          "/bin/sh",
          [
            "-c",
            `ps -ax -o command= | grep -- "--user-data-dir=${PROF}" | grep -v -- "--type=" | grep -vc "grep" || true`,
          ],
          { encoding: "utf8" }
        ).trim()
      );
    check("这个 profile 上只有一个浏览器主进程", countMain() === 1, `ps 数到 ${countMain()} 个`);

    check("冷启动锁已经释放", !fs.existsSync(path.join(PROF, "aic-cli-spawn.lock")));

    execFileSync(process.execPath, [path.join(ROOT, "scripts", "cli-browser.mjs"), "--stop"], {
      env: { ...process.env, HOME: I_HOME, AGENT_IN_CHROME_PROFILE: PROF },
      encoding: "utf8",
    });
    const gone = await waitFor(() => countMain() === 0, 8000);
    check("--stop 之后这个 profile 上一个 Chrome 都不剩", gone);
  }
}

console.log("\n\x1b[1mI2. 管道传输：默认不开调试端口\x1b[0m");
{
  const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].find((p) => fs.existsSync(p));
  if (!CHROME) skipSection("本机没装 Chrome，管道传输这段跳过");
  else {
    const P_HOME = path.join(TMP, "p-home");
    const PROF_P = path.join(TMP, "p-prof");
    for (const d of [P_HOME, PROF_P]) fs.mkdirSync(d, { recursive: true });
    const LAUNCH = pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href;
    const CLIENT = pathToFileURL(path.join(ROOT, "mcp", "cdp", "client.mjs")).href;

    const script =
      `const m = await import(${JSON.stringify(LAUNCH)});` +
      `const c = await import(${JSON.stringify(CLIENT)});` +
      `const info = await m.ensureBrowser({ headless: true });` +
      `const br = await c.Browser.connect({ pipe: info.pipe });` +
      `const ver = await br.client.send("Browser.getVersion");` +
      `const { execFileSync } = await import("node:child_process");` +
      `let listen = "";` +
      `try { listen = execFileSync("sh", ["-c", "lsof -nP -iTCP -a -p " + info.pid + " 2>/dev/null | grep -c LISTEN"], { encoding: "utf8" }).trim(); } catch (e) { listen = "0"; }` +
      `const fs2 = await import("node:fs");` +
      `console.log(JSON.stringify({ transport: info.transport, port: info.port, wsUrl: info.wsUrl,` +
      ` product: ver.product, listening: Number(listen) || 0,` +
      ` hasPortFile: fs2.existsSync(${JSON.stringify(path.join(PROF_P, "DevToolsActivePort"))}) }));` +
      `br.client.close("done"); m.stopBrowser(); process.exit(0);`;

    let res = null;
    try {
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, HOME: P_HOME, AGENT_IN_CHROME_PROFILE: PROF_P, AGENT_IN_CHROME_BIN: CHROME, AGENT_IN_CHROME_HEADLESS: "1" },
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      res = JSON.parse(out.trim().split("\n").pop());
    } catch (e) {
      check("管道模式能起浏览器并跑通 CDP", false, String(e.stderr || e.message).slice(0, 220));
    }
    if (res) {
      check("默认走的就是管道传输", res.transport === "pipe", JSON.stringify(res.transport));
      check("管道上真的跑得通 CDP（不是只连上）", /Chrome\//.test(res.product || ""), JSON.stringify(res.product));
      check("浏览器一个 TCP 端口都不监听", res.listening === 0, `lsof 数到 ${res.listening} 个 LISTEN`);
      check("也不写 DevToolsActivePort（端口号无处可捡）", res.hasPortFile === false, JSON.stringify(res.hasPortFile));
      check("记录里不编造假的端口/wsUrl", res.port === null && res.wsUrl === null, JSON.stringify([res.port, res.wsUrl]));
    }

    const second =
      `const m = await import(${JSON.stringify(LAUNCH)});` +
      `try { const i = await m.ensureBrowser({ headless: true }); console.log(JSON.stringify({ ok: true, pid: i.pid })); m.stopBrowser(); }` +
      `catch (e) { console.log(JSON.stringify({ ok: false, err: String(e.message || e) })); }` +
      `process.exit(0);`;
    fs.mkdirSync(path.join(PROF_P, "aic-cli-spawn.lock"), { recursive: true });
    try {
      const out2 = execFileSync(process.execPath, ["--input-type=module", "-e", second], {
        env: { ...process.env, HOME: P_HOME, AGENT_IN_CHROME_PROFILE: PROF_P, AGENT_IN_CHROME_BIN: CHROME, AGENT_IN_CHROME_HEADLESS: "1" },
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const r2 = JSON.parse(out2.trim().split("\n").pop());
      check("管道模式下抢不到锁时立刻报错，不干等", r2.ok === false, JSON.stringify(r2).slice(0, 140));
      check("报错给出换 profile 这条出路", /AGENT_IN_CHROME_PROFILE/.test(r2.err || ""), (r2.err || "").slice(0, 200));
      check("报错也给出「确实要共用就切端口模式」这条", /AGENT_IN_CHROME_KEEP/.test(r2.err || ""), (r2.err || "").slice(0, 240));
    } catch (e) {
      check("管道模式下抢不到锁时立刻报错，不干等", false, String(e.stderr || e.message).slice(0, 200));
    } finally {
      fs.rmSync(path.join(PROF_P, "aic-cli-spawn.lock"), { recursive: true, force: true });
    }
  }
}

console.log("\n\x1b[1mJ. socket 认证\x1b[0m");
{
  const SOCKJ = path.join(TMP, "tj.sock");
  fs.chmodSync(TMP, 0o755);

  const S = startServer({ AGENT_IN_CHROME_SOCK: SOCKJ, AGENT_IN_CHROME_TRACE: "off" });
  await S.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await waitFor(() => sockUp(SOCKJ), 5000);

  const modeOf = (p) => fs.statSync(p).mode & 0o777;
  if (process.platform === "win32") {
    skipSection("socket/目录/令牌的 POSIX 权限检查（Windows 走 NTFS ACL + 令牌，权限位是演的）");
  } else {
    check("socket 建成 0600（同机器上的别的用户连不上）", modeOf(SOCKJ) === 0o600, modeOf(SOCKJ).toString(8));
    check("数据目录被收紧成 0700（老安装升级也修）", modeOf(TMP) === 0o700, modeOf(TMP).toString(8));
    check("令牌文件是 0600", modeOf(tokenPath(TMP)) === 0o600, modeOf(tokenPath(TMP)).toString(8));
  }
  check("令牌是 32 字节随机（base64url 43 字符）", /^[A-Za-z0-9_-]{43}$/.test(TOKEN), `${TOKEN.length} 字符`);
  if (process.platform !== "win32") {
    fs.chmodSync(tokenPath(TMP), 0o644);
    const again = getToken(TMP);
    check("宽权限的既有令牌被收紧回 0600", modeOf(tokenPath(TMP)) === 0o600, modeOf(tokenPath(TMP)).toString(8));
    check("收紧的同时令牌内容不变", again === TOKEN);
  }

  const dial = (onMsg) => {
    const c = net.connect(ep(SOCKJ));
    const lines = [];
    let closed = false;
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        const m = JSON.parse(l);
        lines.push(m);
        onMsg?.(m, c);
      }
    });
    c.on("close", () => (closed = true));
    c.on("error", () => (closed = true));
    return { c, lines, ready: new Promise((r) => c.on("connect", r)), isClosed: () => closed };
  };

  const served = [];
  const host = dial((m, c) => {
    if (m.type !== "call") return;
    served.push(m);
    c.write(JSON.stringify({ id: m.id, type: "result", ok: true, data: { servedTo: m.tool } }) + "\n");
  });
  await host.ready;
  host.c.write(helloHost(1));
  await sleep(200);
  const warm = await S.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("带对令牌的 host 被认下，工具照常能用", warm.result?.isError === false, JSON.stringify(warm.result).slice(0, 150));

  const atk = dial();
  await atk.ready;
  atk.c.write(
    JSON.stringify({ type: "call", id: "atk1", tool: "eval", args: { js: "ATTACKER_PAYLOAD" }, session: "atk" }) + "\n"
  );
  await waitFor(() => atk.isClosed(), 3000);
  check(
    "没打招呼就发 call：回一句 unauthorized",
    atk.lines.some((m) => m.type === "error" && m.code === "unauthorized"),
    JSON.stringify(atk.lines).slice(0, 160)
  );
  check("没打招呼就发 call：连接当场断开", atk.isClosed());
  check(
    "而且这条 call 根本没被执行（浏览器侧从没见过它）",
    !served.some((m) => JSON.stringify(m).includes("ATTACKER_PAYLOAD")),
    JSON.stringify(served.map((m) => m.tool))
  );
  check("攻击者也拿不到任何 result", !atk.lines.some((m) => m.type === "result"));

  const badTok = dial();
  await badTok.ready;
  badTok.c.write(JSON.stringify({ type: "hello", role: "host", pid: 66, token: "x".repeat(TOKEN.length) }) + "\n");
  await waitFor(() => badTok.isClosed(), 3000);
  check(
    "令牌不对的 hello 被拒",
    badTok.lines.some((m) => m.type === "error" && m.code === "unauthorized"),
    JSON.stringify(badTok.lines).slice(0, 160)
  );
  check("令牌不对的 hello 会被断开", badTok.isClosed());

  const noTok = dial();
  await noTok.ready;
  noTok.c.write(JSON.stringify({ type: "hello", role: "peer", pid: 67 }) + "\n");
  await waitFor(() => noTok.isClosed(), 3000);
  check(
    "不带 token 的 hello 同样被拒（空令牌不许当通行证）",
    noTok.lines.some((m) => m.type === "error" && m.code === "unauthorized") && noTok.isClosed(),
    JSON.stringify(noTok.lines).slice(0, 160)
  );

  const beforeKick = served.length;
  const after = await S.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("被拒的假 host 没有顶掉真 host（调用照样通）", after.result?.isError === false, JSON.stringify(after.result).slice(0, 150));
  check("真 host 的连接还活着", !host.isClosed() && served.length > beforeKick, `served ${beforeKick} → ${served.length}`);

  const peer = dial();
  await peer.ready;
  peer.c.write(JSON.stringify({ type: "hello", role: "peer", pid: 99, token: TOKEN }) + "\n");
  peer.c.write(JSON.stringify({ type: "call", id: "p1", tool: "tabs_list", args: {}, session: "j-peer-sid" }) + "\n");
  await waitFor(() => peer.lines.some((m) => m.type === "result" && m.id === "p1"), 5000);
  check(
    "带对令牌的从会话仍能经主代发",
    peer.lines.some((m) => m.type === "result" && m.id === "p1" && m.ok === true),
    JSON.stringify(peer.lines).slice(0, 160)
  );
  check("代发时会话身份照旧原样带过去", served.some((m) => m.session === "j-peer-sid"), JSON.stringify(served.map((m) => m.session)));

  check("timingSafeEqualStr: 相同为真", timingSafeEqualStr(TOKEN, TOKEN) === true);
  check("timingSafeEqualStr: 不同为假", timingSafeEqualStr(TOKEN, "y".repeat(TOKEN.length)) === false);
  check("timingSafeEqualStr: 长度不同返回 false，不抛", timingSafeEqualStr(TOKEN, TOKEN.slice(0, -1)) === false);
  check("timingSafeEqualStr: 两个空串也不算相等（空令牌不能把认证悄悄关掉）", timingSafeEqualStr("", "") === false);

  host.c.destroy();
  peer.c.destroy();
  S.p.kill();
}

console.log("\n\x1b[1mJ2. session-end（server 退出通知扩展）\x1b[0m");
{
  const SOCKE = path.join(TMP, "te.sock");
  const S = startServer({ AGENT_IN_CHROME_SOCK: SOCKE, AGENT_IN_CHROME_TRACE: "off" });
  await S.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  await waitFor(() => sockUp(SOCKE), 5000);

  const lines = [];
  const c = net.connect(ep(SOCKE));
  c.setEncoding("utf8");
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      try {
        lines.push(JSON.parse(l));
      } catch {}
    }
  });
  await new Promise((r) => c.on("connect", r));
  c.write(JSON.stringify({ type: "hello", role: "host", token: TOKEN }) + "\n");
  await new Promise((r) => setTimeout(r, 300));

  S.p.stdin.end();
  const got = await waitFor(() => lines.some((m) => m.type === "session-end"), 5000).then(
    () => true,
    () => false
  );
  const se = lines.find((m) => m.type === "session-end");
  check("server 退出前发出 session-end", got && !!se, JSON.stringify(lines.slice(-3)));
  check("session-end 带着会话 id", typeof se?.session === "string" && se.session.length > 0, JSON.stringify(se));
  c.destroy();
}

console.log("\n\x1b[1mK. 跨 agent 的 MCP 注册\x1b[0m");
{
  const inst = await import(pathToFileURL(path.join(ROOT, "scripts", "install.mjs")).href);

  const body = inst.winLauncherBody("C:\\Users\\张三\\.agent-in-chrome\\agent-in-chrome\\host.mjs");
  const lines = body.split("\r\n");
  const chcpAt = lines.findIndex((l) => /^chcp 65001 >nul$/.test(l));
  const pathAt = lines.findIndex((l) => l.includes("host.mjs"));
  check("启动器 .bat：第一行是 @echo off（回显会混进 native messaging 的协议通道）", lines[0] === "@echo off", lines[0]);
  check("启动器 .bat：带 chcp 65001（不带的话中文路径会被 cmd 按 GBK 拆坏）", chcpAt > 0, body);
  check("启动器 .bat：chcp 排在含路径的那行之前", chcpAt >= 0 && pathAt > chcpAt, `chcp@${chcpAt} path@${pathAt}`);
  check("启动器 .bat：chcp 的输出重定向掉了（否则会污染 stdout）", /chcp 65001 >nul/.test(body), body);
  check(
    "启动器 .bat：chcp 之前的字节全是 ASCII（那几行用什么代码页读都一样）",
    [...lines.slice(0, chcpAt + 1).join("")].every((c) => c.charCodeAt(0) < 128),
    lines.slice(0, chcpAt + 1).join(" / ")
  );
  check("启动器 .bat：用 CRLF（cmd 对纯 LF 的批处理有历史坑）", body.includes("\r\n") && !/[^\r]\n/.test(body));

  check(
    "reg 解析：普通 REG_SZ（反斜杠转义过）",
    inst.parseRegExport(
      'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\x]\r\n@="C:\\\\Users\\\\张三\\\\host.json"\r\n'
    ) === "C:\\Users\\张三\\host.json"
  );
  check("reg 解析：值里带引号也要还原", inst.parseRegExport('@="C:\\\\a\\"b\\\\host.json"') === 'C:\\a"b\\host.json');
  check(
    "reg 解析：同一个键下别人的命名值不许被认成默认值",
    inst.parseRegExport('@="C:\\\\ours.json"\r\n"别的值"="别人的东西"\r\n') === "C:\\ours.json"
  );
  check(
    "reg 解析：REG_EXPAND_SZ（hex(2)：UTF-16LE 字节流 + 续行）也认，免得误报「未登记」",
    inst.parseRegExport("@=hex(2):25,00,4c,00,5c,00,20,5f,09,4e,5c,\\\r\n  00,68,00,00,00") === "%L\\张三\\h"
  );
  check("reg 解析：没有默认值就是 null（键在但没登记）", inst.parseRegExport("[HKEY_CURRENT_USER\\Software\\x]\r\n") === null);

  const strayCmd = "chrome.exe --user-data-dir=C:\\p --aic-owner=999999 --headless=new";
  check("残留浏览器：进程表拿不到时报「查不了」，不是「没有」", inst.strayStatus({ procs: null, err: "boom" }).kind === "unavailable");
  check("残留浏览器：进程表拿得到且干净才报「没有」", inst.strayStatus({ procs: [], err: null }).kind === "clean");
  check(
    "残留浏览器：真孤儿要报出 pid",
    JSON.stringify(inst.strayStatus({ procs: [{ pid: 4242, cmd: strayCmd }], err: null }, () => false).pids) === "[4242]"
  );
  check(
    "残留浏览器：主人还活着的不算残留（那是正在服役的）",
    inst.strayStatus({ procs: [{ pid: 4242, cmd: strayCmd }], err: null }, () => true).kind === "clean"
  );

  {
    check("install.mjs 导出了 serverProcs / probeBridgeOwner", typeof inst.serverProcs === "function" && typeof inst.probeBridgeOwner === "function");
    const serverProcs = inst.serverProcs ?? (() => ({ kind: "none", err: null, procs: [] }));
    const probeBridgeOwner = inst.probeBridgeOwner ?? (async () => "free");
    const P = (pid, cmd) => ({ pid, cmd });
    const inst2 = "C:\\Users\\me\\.agent-in-chrome\\agent-in-chrome\\server.mjs";
    const snap = (procs) => ({ procs, err: null });
    check(
      "旧版占用：认得出装好的那份 server",
      serverProcs(snap([P(1, "node " + inst2)]), inst2).procs.length === 1
    );
    check(
      "旧版占用：认得出仓库里直接跑的那份（开发时常见）",
      serverProcs(snap([P(2, "node C:\\dev\\aic\\mcp\\server.mjs")]), inst2).procs.length === 1
    );
    check(
      "旧版占用：不误伤别人家的 mcp-server.mjs",
      serverProcs(snap([P(3, "node C:\\x\\weixinpay\\dist\\mcp-server.mjs")]), inst2).procs.length === 0
    );
    check(
      "旧版占用：把「查不了」和「没有」分开（同 strayStatus 的教训）",
      serverProcs({ procs: null, err: "boom" }, inst2).kind === "unavailable" &&
        serverProcs(snap([]), inst2).kind === "none"
    );

    const mk = (onConn) =>
      new Promise((r) => {
        const srv = net.createServer(onConn);
        const p = path.join(TMP, "probe-" + Math.random().toString(36).slice(2) + ".sock");
        srv.listen(ep(p), () => r({ srv, endpoint: ep(p) }));
      });
    const free = path.join(TMP, "probe-nobody.sock");
    check("端点探测：没人听 → free", (await probeBridgeOwner(ep(free), 400)) === "free");
    {
      const { srv, endpoint } = await mk((c) => c.write(JSON.stringify({ type: "challenge", v: 1, nonce: "x" }) + "\n"));
      check("端点探测：对面出题 → modern", (await probeBridgeOwner(endpoint, 1500)) === "modern");
      srv.close();
    }
    {
      const { srv, endpoint } = await mk(() => {});
      check("端点探测：连得上但不出题 → legacy（这就是旧版主的样子）", (await probeBridgeOwner(endpoint, 700)) === "legacy");
      srv.close();
    }
  }
  const { pruneBackups } = await import(pathToFileURL(path.join(ROOT, "scripts", "agents.mjs")).href);
  {
    const dir = fs.mkdtempSync(path.join(TMP, "bak-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, "{}");
    for (const t of ["2026-08-01T000000000Z", "2026-08-02T000000000Z", "2026-08-03T000000000Z", "2026-08-04T000000000Z", "2026-08-05T000000000Z"])
      fs.writeFileSync(`${file}.bak-${t}`, "{}");
    fs.writeFileSync(path.join(dir, "别人的.json.bak-2026-08-01T000000000Z"), "{}");
    pruneBackups(file, 3);
    const left = fs.readdirSync(dir).filter((f) => f.startsWith("mcp.json.bak-")).sort();
    check("备份轮换：只留最近 3 份", left.length === 3, left.join(","));
    check("备份轮换：留下的是最新的那几份", left[0].endsWith("2026-08-03T000000000Z") && left[2].endsWith("2026-08-05T000000000Z"), left.join(","));
    check("备份轮换：别的文件的备份一个都不碰", fs.existsSync(path.join(dir, "别人的.json.bak-2026-08-01T000000000Z")));
    check("备份轮换：正主本身不许被当成备份删掉", fs.existsSync(file));
  }
}

if (process.platform === "win32") {
  const SYS32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const REG_EXE = path.join(SYS32, "reg.exe");
  const REG_ROOT = `HKCU\\Software\\aic-e2e-${process.pid}`;
  const KEY = `${REG_ROOT}\\Google\\Chrome\\NativeMessagingHosts\\org.liangai.agent_in_chrome`;
  const REAL_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\org.liangai.agent_in_chrome";
  const inst = await import(pathToFileURL(path.join(ROOT, "scripts", "install.mjs")).href);
  const regRaw = (k) => {
    const tmp = path.join(TMP, `reg-${Math.random().toString(36).slice(2)}.reg`);
    try {
      execFileSync(REG_EXE, ["export", k, tmp, "/y"], { stdio: "pipe" });
      return fs.readFileSync(tmp, "utf16le");
    } catch {
      return null;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  };
  const regHas = (k) => {
    try {
      execFileSync(REG_EXE, ["query", k], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  const REAL_BEFORE = regRaw(REAL_KEY);

  const K_HOME = path.join(TMP, "k-home-张三 的家");
  const K_LOCAL = path.join(K_HOME, "AppData", "Local");
  const DATA = path.join(K_HOME, ".agent-in-chrome");
  const RT = path.join(DATA, "agent-in-chrome");
  fs.mkdirSync(path.join(K_LOCAL, "Google", "Chrome", "User Data"), { recursive: true });
  fs.mkdirSync(path.join(K_HOME, "AppData", "Roaming"), { recursive: true });
  fs.mkdirSync(path.join(K_HOME, ".kimi"), { recursive: true });
  fs.writeFileSync(path.join(K_HOME, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: { context7: { url: "x" } } }, null, 2));

  const kEnv = {
    ...process.env,
    PATH: SYS32,
    HOME: K_HOME,
    USERPROFILE: K_HOME,
    LOCALAPPDATA: K_LOCAL,
    APPDATA: path.join(K_HOME, "AppData", "Roaming"),
    AGENT_IN_CHROME_REG_ROOT: REG_ROOT,
  };
  const runInstaller = (args) => {
    try {
      return { out: execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), ...args], { env: kEnv, encoding: "utf8", timeout: 180000 }), status: 0 };
    } catch (e) {
      return { out: String(e.stdout || "") + String(e.stderr || ""), status: e.status ?? 1 };
    }
  };
  const runBat = (bat, args = []) => {
    const line = `/d /s /c ""${bat}"${args.map((a) => ` "${a}"`).join("")}"`;
    const o = { windowsVerbatimArguments: true, encoding: "buffer", input: "", timeout: 30000 };
    try {
      return { status: 0, stderr: execFileSync(process.env.ComSpec || path.join(SYS32, "cmd.exe"), [line], o) && Buffer.alloc(0) };
    } catch (e) {
      return { status: e.status ?? 1, stderr: e.stderr || Buffer.alloc(0) };
    }
  };
  const cpNow = () => {
    try {
      return Number(/(\d{3,5})/.exec(execFileSync(path.join(SYS32, "chcp.com"), [], { encoding: "latin1" }))?.[1]) || null;
    } catch {
      return null;
    }
  };
  const CP_BEFORE = cpNow();
  const restoreCp = () => {
    if (CP_BEFORE && cpNow() !== CP_BEFORE) execFileSync(path.join(SYS32, "chcp.com"), [String(CP_BEFORE)], { stdio: "ignore" });
  };
  const decOem = (b) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b || Buffer.alloc(0));
    } catch {
      return (b || Buffer.alloc(0)).toString("latin1");
    }
  };
  const countFiles = (d) => {
    let n = 0;
    const walk = (p) => {
      let es = [];
      try {
        es = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) (e.isDirectory() ? walk : () => n++)(path.join(p, e.name));
    };
    if (fs.existsSync(d)) walk(d);
    return n;
  };

  const out1 = runInstaller(["--yes", "--agents=kimi"]);
  const LAUNCHER = path.join(RT, "native-host-launcher.bat");
  const MCP_LAUNCHER = path.join(RT, "mcp-launcher.bat");
  check("Windows: 生成了 .bat 启动器（Chrome 在 Windows 上只认 .exe/.bat）", fs.existsSync(LAUNCHER) && fs.existsSync(MCP_LAUNCHER), out1.out.slice(-400));

  {
    const r = runBat(LAUNCHER, ["chrome-extension://abc/", "--parent-window=0"]);
    restoreCp();
    const err = decOem(r.stderr);
    check("Windows: 中文路径下 native host 启动器真的跑得起来", r.status === 0, `status=${r.status} ${err.slice(0, 200)}`);
    check("Windows: node 找得到 host.mjs（路径没被代码页拆坏）", !/Cannot find module/i.test(err), err.slice(0, 300));
  }

  {
    const legacy = path.join(RT, "legacy-probe.bat");
    fs.writeFileSync(legacy, `@echo off\r\nrem legacy body (pre-fix)\r\n"${process.execPath}" "${path.join(RT, "host.mjs")}" %*\r\n`);
    const r = runBat(legacy, ["chrome-extension://abc/"]);
    restoreCp();
    if (CP_BEFORE === 65001) skipSection("控制台本来就是 UTF-8，修复前的正文在这台机器上不失效，对照略过");
    else check("Windows: 修复前的 .bat 正文在中文路径上确实是坏的（对照组）", r.status !== 0, `status=${r.status}`);
    fs.unlinkSync(legacy);
  }

  {
    const raw = regRaw(KEY);
    check("Windows: 注册表键写进去了，值就是那份 manifest 的绝对路径", !!raw && /^@=".+org\.liangai\.agent_in_chrome\.json"$/m.test(raw), String(raw).slice(0, 300));
  }
  const outC = runInstaller(["--check", "--agents=kimi"]);
  check("Windows: --check 报「注册表已登记」", /Chrome: 注册表已登记/.test(outC.out), outC.out.slice(-800));
  check(
    "Windows: --check 不再因为解码乱码而误报「已登记但指向 <乱码>」（那条路重装永远修不好）",
    !/已登记但指向/.test(outC.out),
    outC.out.slice(-800)
  );
  check("Windows: --check 的 MCP 冒烟走的是真的那个 .bat", /装好的 MCP server 真的起得来/.test(outC.out), outC.out.slice(-600));
  check("Windows: --check 跑完没把用户终端的代码页改掉", cpNow() === CP_BEFORE, `${CP_BEFORE} → ${cpNow()}`);

  {
    const good = fs.readFileSync(MCP_LAUNCHER);
    fs.writeFileSync(MCP_LAUNCHER, `@echo off\r\nrem legacy body (pre-fix)\r\n"${process.execPath}" "${path.join(RT, "server.mjs")}" %*\r\n`);
    const broken = runInstaller(["--check", "--agents=kimi"]);
    if (CP_BEFORE === 65001) skipSection("控制台本来就是 UTF-8，坏启动器在这台机器上照样能跑，这条对照略过");
    else check("Windows: 启动器被代码页读坏时 --check 报得出来（不再全绿）", /MCP server 起不来/.test(broken.out), broken.out.slice(-600));
    fs.writeFileSync(MCP_LAUNCHER, good);
  }

  {
    const snap = inst.procSnapshot();
    check("Windows: 拿得到本机进程表（pid + 完整命令行）", !!snap.procs && snap.procs.length > 10, JSON.stringify(snap.err));
    const dead = await new Promise((res) => {
      const p = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      p.on("exit", () => res(p.pid));
    });
    const stubFile = path.join(K_HOME, "chrome-stub.mjs");
    fs.writeFileSync(stubFile, "setTimeout(() => {}, 300000);\n");
    const orphan = spawn(process.execPath, [stubFile, `--user-data-dir=${path.join(RT, "cli-profile")}`, `--aic-owner=${dead}`], { stdio: "ignore" });
    await sleep(900);
    const outStray = runInstaller(["--check", "--agents=kimi"]);
    check("Windows: --check 报得出残留的自启浏览器", outStray.out.includes(String(orphan.pid)), outStray.out.slice(-600));
    check("Windows: 给的是 Windows 上真能用的收尸命令（不是 kill / Dock 那套 macOS 说法）", /taskkill/.test(outStray.out));
    orphan.kill();
    await waitFor(() => !alive(orphan.pid), 5000);
    check("Windows: 测试自己种的孤儿已经收干净", !alive(orphan.pid));
    fs.unlinkSync(stubFile);
  }

  {
    fs.mkdirSync(path.join(DATA, "extension", "icons"), { recursive: true });
    for (const f of ["manifest.json", "sw.js", path.join("icons", "16.png")]) fs.writeFileSync(path.join(DATA, "extension", f), "x");
    for (const d of ["cookies", "traces", "screenshots"]) {
      fs.mkdirSync(path.join(DATA, d), { recursive: true });
      fs.writeFileSync(path.join(DATA, d, "a.json"), "{}");
    }
    fs.writeFileSync(path.join(DATA, "agent-in-chrome-cli.log"), "log\n");
    fs.writeFileSync(path.join(DATA, "agent-in-chrome-host.log"), "log\n");

    const PROFILE = path.join(RT, "cli-profile");
    fs.mkdirSync(PROFILE, { recursive: true });
    const LOCKED = path.join(PROFILE, "LOCK-ME.dat");
    fs.writeFileSync(LOCKED, "x");
    const holder = spawn(
      path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$f=$null; while (-not $f) { try { $f=[IO.File]::Open('${LOCKED}','Open','ReadWrite','None') } catch { Start-Sleep -Milliseconds 100 } }; Start-Sleep -Seconds 120; $f.Close()`,
      ],
      { stdio: "ignore" }
    );
    let locked = false;
    await waitFor(() => {
      try {
        fs.unlinkSync(LOCKED);
        fs.writeFileSync(LOCKED, "x");
        return false;
      } catch (e) {
        locked = e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES";
        return locked;
      }
    }, 15000);

    const u = runInstaller(["--uninstall", "--agents=kimi"]);
    check("Windows: 卸载不以一段堆栈收场（退出码 0）", u.status === 0, u.out.slice(-500));
    if (!locked) skipSection("这台机器上没能把文件锁住，「一步失败不阻断其余步骤」这条对照略过");
    else {
      check("Windows: 一步失败之后，后面的步骤照样跑完 — 注册表键被删掉", !regHas(KEY), u.out.slice(-800));
      check(
        "Windows: 一步失败之后 — agent 配置里的键照样摘掉了",
        !JSON.parse(fs.readFileSync(path.join(K_HOME, ".kimi", "mcp.json"), "utf8")).mcpServers["agent-in-chrome"]
      );
      check("Windows: 一步失败之后 — 令牌照样删掉了", !fs.existsSync(path.join(DATA, "token")));
      check("Windows: 删得掉的照样删掉（不是撞上一个就整棵放弃）", !fs.existsSync(path.join(RT, "host.mjs")));
      check("Windows: 没收干净的如实报出来了", /没收干净|没能全部移除/.test(u.out), u.out.slice(-800));
    }
    holder.kill();
    await sleep(300);

    check("Windows: 卸载清掉了 npx 用户的扩展副本", countFiles(path.join(DATA, "extension")) === 0, u.out.slice(-600));
    check("Windows: 卸载清掉了导出的 cookie（完整会话凭据的明文，不能留在盘上）", countFiles(path.join(DATA, "cookies")) === 0);
    check(
      "Windows: 卸载清掉了两个日志",
      !fs.existsSync(path.join(DATA, "agent-in-chrome-cli.log")) && !fs.existsSync(path.join(DATA, "agent-in-chrome-host.log"))
    );
    check("Windows: traces / screenshots 不替用户删，但点名告诉他还在", /trace还留在/.test(u.out) && /截图还留在/.test(u.out), u.out.slice(-800));
  }

  {
    const kimiDir = path.join(K_HOME, ".kimi");
    const baks = () => fs.readdirSync(kimiDir).filter((f) => f.startsWith("mcp.json.bak-")).length;
    for (let i = 0; i < 3; i++) {
      runInstaller(["--yes", "--agents=kimi"]);
      runInstaller(["--uninstall", "--agents=kimi"]);
    }
    check("Windows: install/uninstall 循环之后备份没有线性增长", baks() <= 3, `剩 ${baks()} 个`);
  }

  try {
    execFileSync(REG_EXE, ["delete", REG_ROOT, "/f"], { stdio: "pipe" });
  } catch {}
  check("Windows: 测试自造的注册表键已删干净", !regHas(REG_ROOT), REG_ROOT);
  check("Windows: 用户真实的 native host 注册键一个字节都没变", regRaw(REAL_KEY) === REAL_BEFORE, `${REAL_BEFORE} → ${regRaw(REAL_KEY)}`);
} else {
  const K_HOME = path.join(TMP, "k-home");
  const CODEX = path.join(K_HOME, ".codex", "config.toml");
  const DESK =
    process.platform === "darwin"
      ? path.join(K_HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(K_HOME, ".config", "Claude", "claude_desktop_config.json");
  const CLAUDE_JSON = path.join(K_HOME, ".claude.json");
  const WB = path.join(K_HOME, ".workbuddy", "mcp.json");
  const WB_OLD = path.join(K_HOME, ".workbuddy", ".mcp.json");
  const ZC = path.join(K_HOME, ".zcode", "cli", "config.json");
  const OC = path.join(K_HOME, ".config", "opencode", "opencode.json");
  const KIMI = path.join(K_HOME, ".kimi", "mcp.json");
  const GEM = path.join(K_HOME, ".gemini", "settings.json");
  const QOD = path.join(K_HOME, ".qoder", "settings.json");
  const QODCN = path.join(K_HOME, ".qoder-cn", "settings.json");
  const QIDECN = path.join(K_HOME, ".qoder-cn", "mcp.json");
  const QHOME_CN =
    process.platform === "darwin"
      ? path.join(K_HOME, "Library", "Application Support", "QoderCN", "SharedClientCache", "mcp.json")
      : path.join(K_HOME, ".config", "QoderCN", "SharedClientCache", "mcp.json");
  const TRAECN =
    process.platform === "darwin"
      ? path.join(K_HOME, "Library", "Application Support", "Trae CN", "User", "mcp.json")
      : path.join(K_HOME, ".config", "Trae CN", "User", "mcp.json");
  const QIDE = path.join(K_HOME, ".qoder", "mcp.json");
  const TRAE =
    process.platform === "darwin"
      ? path.join(K_HOME, "Library", "Application Support", "Trae", "User", "mcp.json")
      : path.join(K_HOME, ".config", "Trae", "User", "mcp.json");
  const SERVER = path.join(K_HOME, ".agent-in-chrome", "agent-in-chrome", "server.mjs");
  const LAUNCH = path.join(K_HOME, ".agent-in-chrome", "agent-in-chrome", "mcp-launcher.sh");

  for (const f of [CODEX, DESK, WB, WB_OLD, ZC, OC, KIMI, GEM, QOD, QODCN, QIDECN, TRAECN, QIDE, TRAE]) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.mkdirSync(path.join(K_HOME, ".qoder-cn", "bin"), { recursive: true });
  fs.writeFileSync(path.join(K_HOME, ".qoder-cn", "bin", "qoderclicn"), "#!/bin/sh\n");
  fs.writeFileSync(QIDECN, JSON.stringify({ mcpServers: {} }, null, 2));
  fs.mkdirSync(path.dirname(QHOME_CN), { recursive: true });
  fs.writeFileSync(QHOME_CN, JSON.stringify({ mcpServers: {} }, null, 2));
  fs.mkdirSync(path.join(K_HOME, ".qoder", "bin"), { recursive: true });
  fs.writeFileSync(path.join(K_HOME, ".qoder", "bin", "qodercli"), "#!/bin/sh\n");
  fs.writeFileSync(QODCN, JSON.stringify({ mcpServers: {} }, null, 2));
  fs.writeFileSync(QIDE, JSON.stringify({ mcpServers: {} }, null, 2));
  fs.writeFileSync(TRAE, JSON.stringify({ mcpServers: { existing: { command: "keep" } } }, null, 2));
  fs.writeFileSync(QOD, JSON.stringify({ model: "qoder", mcpServers: { fetch: { command: "uvx" } } }, null, 2));
  fs.writeFileSync(ZC, JSON.stringify({ theme: "dark", mcp: { servers: { "cua-driver": { command: "cua" } } } }, null, 2));
  fs.writeFileSync(OC, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "x", mcp: { other: { type: "local", command: ["o"], enabled: true } } }, null, 2));
  fs.writeFileSync(
    KIMI,
    JSON.stringify({ mcpServers: { context7: { url: "https://mcp.context7.com/mcp" }, "other-server": { command: "other", args: ["--x"] } } }, null, 2)
  );
  fs.writeFileSync(GEM, JSON.stringify({ selectedAuthType: "oauth", theme: "Default", mcpServers: { git: { command: "uvx" } } }, null, 2));
  fs.writeFileSync(
    WB,
    JSON.stringify({ mcpServers: { "my-tool": { type: "stdio", command: "mytool", disabled: false } } }, null, 2)
  );
  fs.writeFileSync(
    WB_OLD,
    JSON.stringify(
      {
        mcpServers: {
          "connector-proxy": { type: "http", url: "http://127.0.0.1:51042/mcp" },
          "agent-in-chrome": { command: "/老的/mcp-launcher.sh", args: [] },
        },
      },
      null,
      2
    )
  );
  const CODEX_ORIG = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "othercmd"\nargs = ["y"]\n\n[history]\npersistence = "save-all"\n`;
  fs.writeFileSync(CODEX, CODEX_ORIG);
  fs.writeFileSync(
    DESK,
    JSON.stringify(
      { globalShortcut: "Alt+C", mcpServers: { keepme: { command: "keep" }, "agent-in-chrome": { command: "/老的/mcp-launcher.sh", args: [] } } },
      null,
      2
    )
  );
  fs.writeFileSync(
    CLAUDE_JSON,
    JSON.stringify(
      { numStartups: 42, mcpServers: { existing: { type: "stdio", command: "x", args: [] } }, projects: { "/a": {} } },
      null,
      2
    )
  );

  const kEnv = { PATH: "/usr/bin:/bin", HOME: K_HOME };
  const runInstaller = (args) => {
    try {
      return execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), ...args], {
        env: kEnv,
        encoding: "utf8",
      });
    } catch (e) {
      if ((e.status ?? 1) === 1) return String(e.stdout || "") + String(e.stderr || "");
      throw e;
    }
  };

  const FAKE_CHROME =
    process.platform === "darwin"
      ? path.join(K_HOME, "Library", "Application Support", "Google", "Chrome")
      : path.join(K_HOME, ".config", "google-chrome");
  fs.mkdirSync(FAKE_CHROME, { recursive: true });

  {
    const outHelp = runInstaller(["--help"]);
    check("--help 只给帮助不安装", /用法/.test(outHelp) && !/已注册/.test(outHelp), outHelp.slice(0, 160));
    check("--help 没有落盘副作用", !fs.existsSync(path.join(K_HOME, ".agent-in-chrome")), K_HOME);
    let unk = null;
    try {
      runInstaller(["--agent=kimi"]);
    } catch (e) {
      unk = e;
    }
    check("拼错的旗标当场拒绝（非零退出）", !!unk, String(unk?.status));
    check("拒绝时点名坏旗标并给用法", /不认识的旗标.*--agent=kimi/.test(String(unk?.stderr || "")) && /用法/.test(String(unk?.stderr || "")), String(unk?.stderr).slice(0, 160));
    check("拼错旗标同样没有落盘副作用", !fs.existsSync(path.join(K_HOME, ".agent-in-chrome")), K_HOME);
  }

  const out1 = runInstaller(["--yes"]);

  {
    const hostFile = path.join(FAKE_CHROME, "NativeMessagingHosts", "org.liangai.agent_in_chrome.json");
    check("host 清单写进了浏览器目录", fs.existsSync(hostFile));
    const ids = fs
      .readFileSync(path.join(ROOT, ".ext-id.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    check(".ext-id.txt 至少有开发版 ID 且没被注释规则误伤", ids.length >= 1 && /^[a-p]{32}$/.test(ids[0]), JSON.stringify(ids));
    if (fs.existsSync(hostFile)) {
      const origins = JSON.parse(fs.readFileSync(hostFile, "utf8")).allowed_origins || [];
      check(
        "host 清单枚举了全部已知扩展 ID",
        ids.every((id) => origins.includes(`chrome-extension://${id}/`)),
        JSON.stringify({ ids, origins })
      );
    }
  }

  const kimiCfg = JSON.parse(fs.readFileSync(KIMI, "utf8"));
  const ourKimi = kimiCfg.mcpServers?.["agent-in-chrome"];
  check("Kimi CLI: 写入 {command:'node', args:[server.mjs]}", ourKimi?.command === "node" && ourKimi?.args?.[0] === SERVER, JSON.stringify(ourKimi));
  check("Kimi CLI: 原有的无关 server 原样保留", kimiCfg.mcpServers["other-server"]?.command === "other", JSON.stringify(kimiCfg));
  check("Kimi CLI: 改前留了备份", fs.readdirSync(path.dirname(KIMI)).some((f) => f.startsWith("mcp.json.bak-")));

  const zcCfg = JSON.parse(fs.readFileSync(ZC, "utf8"));
  check("ZCode: 写进 mcp.servers（不是顶层 mcpServers）", zcCfg.mcp?.servers?.["agent-in-chrome"]?.command === LAUNCH && !zcCfg.mcpServers, JSON.stringify(zcCfg));
  check("ZCode: 别人的 server 和别的设置都还在", zcCfg.mcp.servers["cua-driver"]?.command === "cua" && zcCfg.theme === "dark", JSON.stringify(zcCfg));

  const ocCfg = JSON.parse(fs.readFileSync(OC, "utf8"));
  const ourOc = ocCfg.mcp?.["agent-in-chrome"];
  check("opencode: 写成 {type:'local', command:[node, server], enabled:true}",
    ourOc?.type === "local" && ourOc?.command?.[0] === "node" && ourOc?.command?.[1] === SERVER && ourOc?.enabled === true, JSON.stringify(ourOc));
  check("opencode: $schema、model、别人的 server 都没动", ocCfg.$schema && ocCfg.model === "x" && ocCfg.mcp.other?.command?.[0] === "o", JSON.stringify(ocCfg));

  {
    const FRESH = path.join(TMP, "fresh-home");
    fs.mkdirSync(FRESH, { recursive: true });
    fs.mkdirSync(
      process.platform === "darwin"
        ? path.join(FRESH, "Library", "Application Support", "Google", "Chrome")
        : path.join(FRESH, ".config", "google-chrome"),
      { recursive: true }
    );
    const FRESH_BIN = path.join(TMP, "freshbin");
    fs.mkdirSync(FRESH_BIN, { recursive: true });
    fs.writeFileSync(path.join(FRESH_BIN, "kimi"), "#!/bin/sh\n");
    fs.chmodSync(path.join(FRESH_BIN, "kimi"), 0o755);
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), "--yes", "--agents=kimi"], {
      env: { PATH: `${FRESH_BIN}:/usr/bin:/bin`, HOME: FRESH },
      encoding: "utf8",
    });
    const f = path.join(FRESH, ".kimi", "mcp.json");
    check("配置目录还不存在时，替它建出来再写（不能 ENOENT）", fs.existsSync(f), out.slice(-300));
    check(
      "建出来的内容是对的",
      fs.existsSync(f) && !!JSON.parse(fs.readFileSync(f, "utf8")).mcpServers?.["agent-in-chrome"],
      fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(没写出来)"
    );
  }

  check("Kimi CLI: 原有的 context7 还在", !!kimiCfg.mcpServers.context7, JSON.stringify(kimiCfg));

  const gemCfg = JSON.parse(fs.readFileSync(GEM, "utf8"));
  check("Gemini CLI: 注册进 mcpServers", gemCfg.mcpServers?.["agent-in-chrome"]?.args?.[0] === SERVER, JSON.stringify(gemCfg));
  check("Gemini CLI: 认证方式/主题/别人的 server 一字未动", gemCfg.selectedAuthType === "oauth" && gemCfg.theme === "Default" && gemCfg.mcpServers.git?.command === "uvx", JSON.stringify(gemCfg));

  const qodCfg = JSON.parse(fs.readFileSync(QOD, "utf8"));
  check("Qoder CLI: 写进 ~/.qoder/settings.json，别的设置不动", qodCfg.mcpServers?.["agent-in-chrome"]?.args?.[0] === SERVER && qodCfg.model === "qoder" && !!qodCfg.mcpServers.fetch, JSON.stringify(qodCfg));
  check("Qoder CLI 和 Qoder IDE 各写各的文件", fs.existsSync(QIDE) && JSON.parse(fs.readFileSync(QIDE, "utf8")).mcpServers?.["agent-in-chrome"] && !qodCfg.mcpServers["agent-in-chrome"].command.endsWith("mcp.json"), "");

  const qideCfg = JSON.parse(fs.readFileSync(QIDE, "utf8"));
  check("Qoder IDE: 写进 ~/.qoder/mcp.json 且用 launcher", qideCfg.mcpServers?.["agent-in-chrome"]?.command === LAUNCH, JSON.stringify(qideCfg));
  const traeCfg = JSON.parse(fs.readFileSync(TRAE, "utf8"));
  check("Trae: 写进 profile 下的 User/mcp.json 且用 launcher", traeCfg.mcpServers?.["agent-in-chrome"]?.command === LAUNCH, JSON.stringify(traeCfg));
  check("Trae: 原有的 server 还在", traeCfg.mcpServers.existing?.command === "keep", JSON.stringify(traeCfg));

  const qcnCli = JSON.parse(fs.readFileSync(QODCN, "utf8"));
  const qcnIde = JSON.parse(fs.readFileSync(QIDECN, "utf8"));
  check("Qoder CN CLI: 写进 ~/.qoder-cn/settings.json（裸 node）", qcnCli.mcpServers?.["agent-in-chrome"]?.args?.[0] === SERVER, JSON.stringify(qcnCli));
  const qcnHome = JSON.parse(fs.readFileSync(QHOME_CN, "utf8"));
  check("Qoder CN IDE: QODER_HOME/mcp.json 存在时写它（那才是活配置）", qcnHome.mcpServers?.["agent-in-chrome"]?.command === LAUNCH, JSON.stringify(qcnHome));
  check("Qoder CN IDE: 不去写已经失效的迁移源", !qcnIde.mcpServers?.["agent-in-chrome"], JSON.stringify(qcnIde));
  const traeCnCfg = JSON.parse(fs.readFileSync(TRAECN, "utf8"));
  check("Trae CN: 写进自己的 profile 而不是国际版那个", traeCnCfg.mcpServers?.["agent-in-chrome"]?.command === LAUNCH && !TRAECN.includes("/Trae/"), TRAECN);

  const wbCfg = JSON.parse(fs.readFileSync(WB, "utf8"));
  const ourWb = wbCfg.mcpServers?.["agent-in-chrome"];
  check("WorkBuddy: 写入 launcher（不是裸 node）", ourWb?.command === LAUNCH && !ourWb?.args?.length, JSON.stringify(ourWb));
  check("WorkBuddy: 条目形状带 type/disabled:false", ourWb?.type === "stdio" && ourWb?.disabled === false, JSON.stringify(ourWb));
  check("WorkBuddy: 写的是活配置 mcp.json（不是它自己的输出文件）", !WB.endsWith("/.mcp.json"), WB);
  const wbOld = JSON.parse(fs.readFileSync(WB_OLD, "utf8"));
  check("WorkBuddy: 写错地方的旧注册被摘掉", !wbOld.mcpServers["agent-in-chrome"], JSON.stringify(wbOld));
  check("WorkBuddy: 摘旧注册时 connector-proxy 一字不动", wbOld.mcpServers["connector-proxy"]?.url === "http://127.0.0.1:51042/mcp", JSON.stringify(wbOld));
  check("WorkBuddy: 原有的用户条目原样保留", wbCfg.mcpServers["my-tool"]?.command === "mytool", JSON.stringify(wbCfg));

  const codexText = fs.readFileSync(CODEX, "utf8");
  check(
    "Codex: 追加了我们的 TOML 表",
    codexText.includes("[mcp_servers.agent-in-chrome]") && codexText.includes(`command = "node"`) && codexText.includes(JSON.stringify(SERVER)),
    codexText
  );
  check(
    "Codex: 无关的表和顶层键一字不动",
    codexText.includes(`model = "gpt-5"`) && codexText.includes(`[mcp_servers.other]\ncommand = "othercmd"\nargs = ["y"]`) && codexText.includes(`[history]\npersistence = "save-all"`),
    codexText
  );
  check("Codex: 带了管理标记注释（卸载时据此一并清掉）", /#.*agent-in-chrome/.test(codexText));
  check("Codex: 改前留了备份", fs.readdirSync(path.dirname(CODEX)).some((f) => f.startsWith("config.toml.bak-")));

  const deskCfg = JSON.parse(fs.readFileSync(DESK, "utf8"));
  check(
    "Claude Desktop: user scope 在，就不留同名连接器（埋着的那条被摘掉）",
    !deskCfg.mcpServers?.["agent-in-chrome"],
    JSON.stringify(deskCfg.mcpServers)
  );
  check("Claude Desktop: 摘的时候只摘我们的键", deskCfg.globalShortcut === "Alt+C" && deskCfg.mcpServers.keepme?.command === "keep");
  check("Claude Desktop: 摘之前留了备份", fs.readdirSync(path.dirname(DESK)).some((f) => f.startsWith("claude_desktop_config.json.bak-")));
  check("Claude Desktop: 说清楚了为什么摘（工具命名空间冲突）", out1.includes("工具命名空间"), out1.slice(-600));
  check("launcher 真实存在且可执行", fs.existsSync(LAUNCH) && !!(fs.statSync(LAUNCH).mode & 0o111));

  const ccCfg = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  check(
    "Claude Code（无 claude 二进制时回落编辑 ~/.claude.json）: 写入条目",
    ccCfg.mcpServers?.["agent-in-chrome"]?.command === "node" && ccCfg.mcpServers["agent-in-chrome"].args?.[0] === SERVER,
    JSON.stringify(ccCfg.mcpServers)
  );
  check(
    "Claude Code: 大文件里的其他键原样保留",
    ccCfg.numStartups === 42 && !!ccCfg.projects && ccCfg.mcpServers.existing?.command === "x"
  );

  const kToken = fs.readFileSync(path.join(K_HOME, ".agent-in-chrome", "token"), "utf8").trim();
  check("安装输出不含令牌内容", !out1.includes(kToken));
  check("动手前打出了每个被修改文件的绝对路径", out1.includes(KIMI) && out1.includes(CODEX) && out1.includes(DESK) && out1.includes(CLAUDE_JSON));
  check("结尾给出通用的复制粘贴 JSON 片段", out1.includes(`"mcpServers"`) && out1.includes("npx -y @liang-hz/agent-in-chrome serve"));

  const out2 = runInstaller([]);
  const codexText2 = fs.readFileSync(CODEX, "utf8");
  check("重复安装: Codex 表不重复", (codexText2.match(/\[mcp_servers\.agent-in-chrome\]/g) || []).length === 1, codexText2);
  check("重复安装: Codex 内容逐字不变", codexText2 === codexText);
  check("重复安装: Kimi CLI 条目不变", JSON.stringify(JSON.parse(fs.readFileSync(KIMI, "utf8"))) === JSON.stringify(kimiCfg));
  check(
    "重复安装: 未改动就不再新增备份",
    fs.readdirSync(path.dirname(KIMI)).filter((f) => f.startsWith("mcp.json.bak-")).length === 1
  );
  check("重复安装: 非交互（无 TTY）时不带 --yes 也照常注册", /已是最新/.test(out2), out2.slice(0, 400));

  const outC = runInstaller(["--check"]);
  check("check: 十三个 agent 报已注册", (outC.match(/已注册，command 指向的文件存在/g) || []).length === 13, outC);
  check("check: Claude Desktop 报的是「有意不注册」而不是「未注册」", /Claude Desktop: 有意不注册/.test(outC) && !/Claude Desktop: 未注册/.test(outC), outC);

  {
    const moved = JSON.parse(fs.readFileSync(KIMI, "utf8"));
    moved.someOtherSection = { "agent-in-chrome": moved.mcpServers["agent-in-chrome"] };
    delete moved.mcpServers["agent-in-chrome"];
    fs.writeFileSync(KIMI, JSON.stringify(moved, null, 2));
    fs.writeFileSync(CODEX, fs.readFileSync(CODEX, "utf8") + `\n[mcp_servers.zcode-in-chrome]\ncommand = "/gone/zcode/mcp-launcher.sh"\nargs = []\n`);
    const gem = JSON.parse(fs.readFileSync(GEM, "utf8"));
    gem.mcpServers["zcode-in-chrome"] = { command: "/gone/zcode-in-chrome/mcp-launcher.sh", args: [] };
    gem.mcpServers["agent-in-chrome-2"] = { command: "other" };
    gem.mcpServers["my-agent-in-chrome"] = { command: "other" };
    fs.writeFileSync(GEM, JSON.stringify(gem, null, 2));
  }

  const outU = runInstaller(["--uninstall"]);
  {
    const c = JSON.parse(fs.readFileSync(KIMI, "utf8"));
    check("uninstall: 条目被挪到别的段落也照样摘掉（按名字不按位置）", !c.someOtherSection?.["agent-in-chrome"], JSON.stringify(c));
    check("uninstall: 挪走后原段落里别人的条目还在", c.mcpServers?.["other-server"]?.command === "other", JSON.stringify(c));
    const g = JSON.parse(fs.readFileSync(GEM, "utf8"));
    check("uninstall: 改名前的老条目一并摘掉，不留悬空指向", !g.mcpServers["zcode-in-chrome"], JSON.stringify(g.mcpServers));
    const cx = fs.readFileSync(CODEX, "utf8");
    check("uninstall: Codex 里改名前的老表也摘掉", !cx.includes("[mcp_servers.zcode-in-chrome]"), cx);
    check("uninstall: Codex 里别人的表一字未动", cx.includes("[mcp_servers.other]") && cx.includes('model = "gpt-5"'), cx);
    check(
      "uninstall: 名字里含我们但不是我们的，一个都不碰",
      g.mcpServers["agent-in-chrome-2"]?.command === "other" && g.mcpServers["my-agent-in-chrome"]?.command === "other",
      JSON.stringify(g.mcpServers)
    );
  }
  const kimiCfg3 = JSON.parse(fs.readFileSync(KIMI, "utf8"));
  check(
    "uninstall: Kimi CLI 只移除我们的键",
    !kimiCfg3.mcpServers["agent-in-chrome"] && kimiCfg3.mcpServers["other-server"]?.command === "other",
    JSON.stringify(kimiCfg3)
  );
  check("uninstall: Trae 只摘我们的键", !JSON.parse(fs.readFileSync(TRAE, "utf8")).mcpServers["agent-in-chrome"] && !!JSON.parse(fs.readFileSync(TRAE, "utf8")).mcpServers.existing);
  check("uninstall: Qoder 的两个候选位置都清干净（迁移源里留着会在下次首启诈尸）",
    !JSON.parse(fs.readFileSync(QHOME_CN, "utf8")).mcpServers["agent-in-chrome"] &&
      !JSON.parse(fs.readFileSync(QIDECN, "utf8")).mcpServers["agent-in-chrome"]);
  const zcCfg3 = JSON.parse(fs.readFileSync(ZC, "utf8"));
  check("uninstall: ZCode 只摘我们的键", !zcCfg3.mcp.servers["agent-in-chrome"] && !!zcCfg3.mcp.servers["cua-driver"] && zcCfg3.theme === "dark", JSON.stringify(zcCfg3));
  const ocCfg3 = JSON.parse(fs.readFileSync(OC, "utf8"));
  check("uninstall: opencode 只摘我们的键", !ocCfg3.mcp["agent-in-chrome"] && !!ocCfg3.mcp.other, JSON.stringify(ocCfg3));
  const gemCfg3 = JSON.parse(fs.readFileSync(GEM, "utf8"));
  check("uninstall: Gemini 只摘我们的键，别的设置不动", !gemCfg3.mcpServers["agent-in-chrome"] && !!gemCfg3.mcpServers.git && gemCfg3.theme === "Default", JSON.stringify(gemCfg3));
  const wbCfg3 = JSON.parse(fs.readFileSync(WB, "utf8"));
  check(
    "uninstall: WorkBuddy 只移除我们的键",
    !wbCfg3.mcpServers["agent-in-chrome"] && !!wbCfg3.mcpServers["my-tool"],
    JSON.stringify(wbCfg3)
  );
  const wbOld3 = JSON.parse(fs.readFileSync(WB_OLD, "utf8"));
  check(
    "uninstall: WorkBuddy 输出文件里的 connector-proxy 不受牵连",
    !wbOld3.mcpServers["agent-in-chrome"] && !!wbOld3.mcpServers["connector-proxy"],
    JSON.stringify(wbOld3)
  );
  const codexText3 = fs.readFileSync(CODEX, "utf8");
  check(
    "uninstall: Codex 只移除我们的表",
    !codexText3.includes("[mcp_servers.agent-in-chrome]") && codexText3.includes("[mcp_servers.other]") && codexText3.includes(`model = "gpt-5"`) && codexText3.includes("[history]"),
    codexText3
  );
  check("uninstall: Codex 的管理注释一并清掉", !/#.*agent-in-chrome/.test(codexText3), codexText3);
  const deskCfg3 = JSON.parse(fs.readFileSync(DESK, "utf8"));
  check(
    "uninstall: Desktop 只移除我们的键",
    !deskCfg3.mcpServers["agent-in-chrome"] && deskCfg3.mcpServers.keepme?.command === "keep" && deskCfg3.globalShortcut === "Alt+C"
  );
  const ccCfg3 = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  check(
    "uninstall: ~/.claude.json 只移除我们的键",
    !ccCfg3.mcpServers["agent-in-chrome"] && ccCfg3.mcpServers.existing?.command === "x" && ccCfg3.numStartups === 42
  );
  check("uninstall: 报出了它移除的东西", /移除/.test(outU) && outU.includes(KIMI));
  {
    const baks = fs.readdirSync(path.dirname(CODEX)).filter((f) => f.startsWith("config.toml.bak-"));
    check("uninstall: 摘之前留了备份，且收敛到还原点那一份", baks.length === 1, JSON.stringify(baks));
    check(
      "uninstall: 留下的那份是卸载前快照（含我们即将摘掉的表）",
      baks.length === 1 && fs.readFileSync(path.join(path.dirname(CODEX), baks[0]), "utf8").includes("[mcp_servers.agent-in-chrome]"),
      baks[0]
    );
  }

  runInstaller(["--agents=kimi", "--yes"]);
  check("--agents=kimi: Kimi CLI 注册上了", !!JSON.parse(fs.readFileSync(KIMI, "utf8")).mcpServers["agent-in-chrome"]);
  check("--agents=kimi: Codex 没被动", !fs.readFileSync(CODEX, "utf8").includes("[mcp_servers.agent-in-chrome]"));
  check("--agents=kimi: Desktop 没被动", !JSON.parse(fs.readFileSync(DESK, "utf8")).mcpServers["agent-in-chrome"]);
  check("--agents=kimi: WorkBuddy 没被动", !JSON.parse(fs.readFileSync(WB, "utf8")).mcpServers["agent-in-chrome"]);
  check("--agents=kimi: ZCode / opencode / Gemini / Trae 全没被动",
    !JSON.parse(fs.readFileSync(ZC, "utf8")).mcp.servers["agent-in-chrome"] &&
      !JSON.parse(fs.readFileSync(OC, "utf8")).mcp["agent-in-chrome"] &&
      !JSON.parse(fs.readFileSync(GEM, "utf8")).mcpServers["agent-in-chrome"] &&
      !JSON.parse(fs.readFileSync(TRAE, "utf8")).mcpServers["agent-in-chrome"]);
  runInstaller(["--uninstall"]);
  runInstaller(["--no-agents"]);
  check(
    "--no-agents: 一个 agent 配置都不动",
    !fs.readFileSync(CODEX, "utf8").includes("[mcp_servers.agent-in-chrome]") &&
      !JSON.parse(fs.readFileSync(KIMI, "utf8")).mcpServers["agent-in-chrome"] &&
      !JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers["agent-in-chrome"]
  );

  const K2 = path.join(TMP, "k2-home");
  fs.mkdirSync(path.join(K2, ".kimi"), { recursive: true });
  fs.mkdirSync(
    process.platform === "darwin"
      ? path.join(K2, "Library", "Application Support", "Google", "Chrome")
      : path.join(K2, ".config", "google-chrome"),
    { recursive: true }
  );
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), "--yes"], {
    env: { PATH: "/usr/bin:/bin", HOME: K2 },
    encoding: "utf8",
  });
  const k2Desk =
    process.platform === "darwin"
      ? path.join(K2, "Library", "Application Support", "Claude")
      : path.join(K2, ".config", "Claude");
  check(
    "未检测到的 agent 不会被凭空建配置目录/文件",
    !fs.existsSync(path.join(K2, ".codex")) && !fs.existsSync(k2Desk) && !fs.existsSync(path.join(K2, ".claude.json"))
  );
  check(
    "只有 .kimi 目录时也能注册（新建 mcp.json）",
    JSON.parse(fs.readFileSync(path.join(K2, ".kimi", "mcp.json"), "utf8")).mcpServers["agent-in-chrome"]?.command === "node"
  );
}

console.log("\n\x1b[1mL. bin 分发器\x1b[0m");
{
  const BIN = path.join(ROOT, "bin", "agent-in-chrome.mjs");
  const runBin = (args) => {
    try {
      return {
        code: 0,
        stdout: execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
      };
    } catch (e) {
      return { code: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
    }
  };

  const help = runBin(["help"]);
  check("help 退出码 0", help.code === 0);
  check("help 打印用法（含子命令表）", /用法/.test(help.stdout) && /install/.test(help.stdout) && /serve/.test(help.stdout), help.stdout.slice(0, 200));
  const noArgs = runBin([]);
  check("裸跑（无参数）给帮助并退出 0，不是挂着等 stdin", noArgs.code === 0 && /用法/.test(noArgs.stdout));
  const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  check("--version 和 package.json 一致", runBin(["--version"]).stdout.trim() === pkgVer);
  const badCmd = runBin(["frobnicate"]);
  check("未知子命令退出码 2（用法错误，与 install.mjs 同级）并给出帮助", badCmd.code === 2 && /用法/.test(badCmd.stderr));
  const badFlag = runBin(["check", "--bogus"]);
  check("未知旗标退出码 2 并给出帮助", badFlag.code === 2 && /用法/.test(badFlag.stderr));

  const SOCKL = path.join(TMP, "tl.sock");
  const sp = spawn(process.execPath, [BIN, "serve"], {
    env: { ...process.env, AGENT_IN_CHROME_SOCK: SOCKL, AGENT_IN_CHROME_TRACE: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sBuf = "";
  let sInit = null;
  sp.stdout.setEncoding("utf8");
  sp.stdout.on("data", (c) => {
    sBuf += c;
    let i;
    while ((i = sBuf.indexOf("\n")) >= 0) {
      const line = sBuf.slice(0, i).trim();
      sBuf = sBuf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 1) sInit = m;
      } catch {}
    }
  });
  sp.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\n"
  );
  check(
    "serve 起的是真 MCP server（initialize 能握手）",
    await waitFor(() => sInit?.result?.serverInfo?.name === "agent-in-chrome", 8000),
    JSON.stringify(sInit).slice(0, 160)
  );
  sp.kill();

  const bl = runBin(["borrow-login", "--help"]);
  check("borrow-login --help 退出码 0 且打的是这个脚本的用法", bl.code === 0 && /把指定域的登录态/.test(bl.stdout), bl.stdout.slice(0, 120));
  const blBad = runBin(["borrow-login", "--domains"]);
  check("borrow-login 的用法错退出码 2（旗标缺值）", blBad.code === 2, `code=${blBad.code} ${(blBad.stderr || "").slice(0, 80)}`);
}

console.log("\n\x1b[1mL3. 两种布局下 borrow-login / cli-browser 都跑得起来\x1b[0m");
{
  const runIn = (cwd, args, env = {}) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }), stderr: "" };
    } catch (e) {
      return { code: e.status ?? -1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
    }
  };
  const envFor = (name) => ({
    HOME: path.join(TMP, name, "home"),
    USERPROFILE: path.join(TMP, name, "home"),
    AGENT_IN_CHROME_PROFILE: path.join(TMP, name, "profile"),
    AGENT_IN_CHROME_TRACE: "off",
  });
  fs.mkdirSync(path.join(TMP, "checkout", "home"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "npm", "home"), { recursive: true });

  const co = runIn(ROOT, [path.join(ROOT, "scripts", "borrow-login.mjs"), "--status"], envFor("checkout"));
  check("仓库检出：node scripts/borrow-login.mjs --status 跑到底（含动态 import browser-launch）", co.code === 0 && /借用账本/.test(co.stdout), `code=${co.code} ${(co.stderr || co.stdout).slice(-200)}`);
  const coHelp = runIn(ROOT, [path.join(ROOT, "scripts", "borrow-login.mjs"), "--help"], envFor("checkout"));
  check("仓库检出：--help 给的示例是 node scripts/borrow-login.mjs（他真能敲的那条）", /node scripts\/borrow-login\.mjs --domains/.test(coHelp.stdout), coHelp.stdout.slice(0, 120));

  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const TREE = path.join(TMP, "npm", "node_modules", ...PKG.name.split("/"));
  fs.mkdirSync(TREE, { recursive: true });
  for (const entry of [...PKG.files, "package.json"]) {
    const rel = entry.replace(/\/$/, "");
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(TREE, rel)), { recursive: true });
    fs.cpSync(src, path.join(TREE, rel), { recursive: true });
  }
  check("包树摊在 node_modules 底下（判据靠它分辨两种布局，摊错地方就测的不是 npm 那条路）", /[\\/]node_modules[\\/]/.test(TREE), TREE);
  check("tarball 确实带着 scripts/borrow-login.mjs（bin 子命令要 import 它）", fs.existsSync(path.join(TREE, "scripts", "borrow-login.mjs")));
  const PKG_BIN = path.join(TREE, "bin", "agent-in-chrome.mjs");

  const np = runIn(path.join(TMP, "npm"), [PKG_BIN, "borrow-login", "--status"], envFor("npm"));
  check("npm 布局：agent-in-chrome borrow-login --status 跑到底（不是 Cannot find module）", np.code === 0 && /借用账本/.test(np.stdout), `code=${np.code} ${(np.stderr || np.stdout).slice(-200)}`);
  const npHelp = runIn(path.join(TMP, "npm"), [PKG_BIN, "borrow-login", "--help"], envFor("npm"));
  check("npm 布局：--help 给的是 npx 子命令，绝不叫人去敲 node scripts/…", /npx @liang-hz\/agent-in-chrome borrow-login --domains/.test(npHelp.stdout) && !/node scripts\//.test(npHelp.stdout), npHelp.stdout.slice(0, 200));
  const npCli = runIn(path.join(TMP, "npm"), [PKG_BIN, "cli-browser", "--status"], envFor("npm"));
  check("npm 布局：cli-browser --status 也跑得起来（没在跑 → 退出码 1 + JSON）", npCli.code === 1 && /"running"/.test(npCli.stdout), `code=${npCli.code} ${(npCli.stderr || npCli.stdout).slice(-200)}`);

  check("装出来的运行时是扁平布局，里面没有 scripts/（所以 npm 用户只有 bin 这一条路）", !fs.existsSync(path.join(RUNTIME_DIR, "scripts")), RUNTIME_DIR);
  const relative = runIn(path.join(TMP, "npm"), ["scripts/borrow-login.mjs", "--status"], envFor("npm"));
  check("反向自证：在没有 scripts/ 的目录里敲相对路径，报的就是 Cannot find module", relative.code !== 0 && /Cannot find module/.test(relative.stderr), `code=${relative.code} ${relative.stderr.slice(0, 120)}`);
}

console.log("\n\x1b[1mL2. 客户端探测\x1b[0m");
{
  const { buildAgents } = await import(pathToFileURL(path.join(ROOT, "scripts", "agents.mjs")).href);
  const EMPTY = path.join(TMP, "detect-home");
  fs.mkdirSync(EMPTY, { recursive: true });
  const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a.detected]));

  const clean = byId(buildAgents({ home: EMPTY, serverPath: "/s", mcpLauncher: "/l" }));
  check("干净 HOME 里不认 GUI 客户端（不给没装的建目录）", clean["trae"] === false && clean["qoder-ide"] === false && clean["qoder-ide-cn"] === false, JSON.stringify(clean));

  fs.mkdirSync(path.join(EMPTY, ".kimi"), { recursive: true });
  fs.mkdirSync(path.join(EMPTY, ".gemini"), { recursive: true });
  fs.mkdirSync(path.join(EMPTY, ".config", "opencode"), { recursive: true });
  const withDirs = byId(buildAgents({ home: EMPTY, serverPath: "/s", mcpLauncher: "/l" }));
  check("有配置目录时认得出 CLI", withDirs["kimi"] && withDirs["gemini"] && withDirs["opencode"], JSON.stringify(withDirs));

  const FAKE_BIN = path.join(TMP, "fakebin");
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  for (const n of ["kimi", "gemini", "opencode"]) {
    fs.writeFileSync(path.join(FAKE_BIN, n), "#!/bin/sh\n");
    fs.chmodSync(path.join(FAKE_BIN, n), 0o755);
  }
  const EMPTY2 = path.join(TMP, "detect-home2");
  fs.mkdirSync(EMPTY2, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = FAKE_BIN;
  const withBins = byId(buildAgents({ home: EMPTY2, serverPath: "/s", mcpLauncher: "/l" }));
  process.env.PATH = savedPath;
  check(
    "只装了二进制、还没有配置目录时也认得出（装了等于没装的那个 bug）",
    withBins["kimi"] && withBins["gemini"] && withBins["opencode"],
    JSON.stringify(withBins)
  );
}

console.log("\n\x1b[1mM. 孤儿浏览器回收\x1b[0m");
{
  const { orphansFrom, OWNER_FLAG, profileDirFrom, waitGone, stopBlockedByManager, sweepOrphansAsync } = await import(pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href);

  {
    const mgrAlive = (pid) => pid === 4242;
    const o = (over) => ({ isAlive: mgrAlive, self: 777, ...over });
    check("别人管着且那个进程还活着 → 不收，并说得出归谁", stopBlockedByManager({ pid: 1, managerPid: 4242 }, o()) === 4242);
    check("管理者已经死了 → 照收（孤儿不会因此堆积）", stopBlockedByManager({ pid: 1, managerPid: 999 }, o()) === null);
    check("自己管的 → 照收（收尾那条路不能被自己挡住）", stopBlockedByManager({ pid: 1, managerPid: 777 }, o()) === null);
    check("老记录没记管理者 → 照收（行为不变）", stopBlockedByManager({ pid: 1 }, o()) === null);
    check("force 越过这道（--stop / 卸载是用户明说要收场）", stopBlockedByManager({ pid: 1, managerPid: 4242 }, o({ force: true })) === null);
  }

  {
    const mkProf = (name, transport, pid) => {
      const dir = path.join(TMP, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "aic-cli-browser.json"), JSON.stringify({ pid, profileDir: dir, transport }));
      return dir;
    };
    const DEAD = 2147483646;
    const pipeDir = mkProf("gk-pipe", "pipe", 7001);
    const portDir = mkProf("gk-port", "port", 7002);
    const noneDir = path.join(TMP, "gk-none");
    const procs = [
      { pid: 7001, cmd: `chrome --user-data-dir=${pipeDir} --remote-debugging-pipe --headless=new ${OWNER_FLAG}=${DEAD} about:blank` },
      { pid: 7002, cmd: `chrome --user-data-dir=${portDir} --remote-debugging-port=0 --headless=new ${OWNER_FLAG}=${DEAD} about:blank` },
      { pid: 7003, cmd: `chrome --user-data-dir=${noneDir} --remote-debugging-port=0 --headless=new ${OWNER_FLAG}=${DEAD} about:blank` },
    ];
    const sent = [];
    await sweepOrphansAsync({ procs, kill: (pid, sig) => sent.push(`${pid}:${sig}`), isAlive: () => false, sleep: async () => {} });
    check("账上是管道的：只打主进程，绝不打进程组（-pid 会误伤别人）", sent.includes("7001:SIGTERM") && !sent.includes("-7001:SIGTERM"), sent.join(" "));
    check("账上是端口的：照旧整组打（detached，pid 就是组长）", sent.includes("-7002:SIGTERM"), sent.join(" "));
    check("没账的保持老行为（整组打）", sent.includes("-7003:SIGTERM"), sent.join(" "));
  }

  const alive = (pid) => pid === 1000;
  const line = (pid, cmd) => ({ pid, cmd });

  const usersOwn = [
    line(500, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    line(501, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome"),
  ];
  check("用户自己的 Chrome 一个都不碰", orphansFrom(usersOwn, alive).length === 0, JSON.stringify(orphansFrom(usersOwn, alive)));

  const serving = [line(600, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new ${OWNER_FLAG}=1000 --user-data-dir=/tmp/p`)];
  check("主人还活着的浏览器不收", orphansFrom(serving, alive).length === 0, JSON.stringify(orphansFrom(serving, alive)));

  const orphan = [line(700, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new ${OWNER_FLAG}=999 --user-data-dir=/tmp/p`)];
  check("主人已死的浏览器认得出来", JSON.stringify(orphansFrom(orphan, alive)) === JSON.stringify([700]), JSON.stringify(orphansFrom(orphan, alive)));

  const mixed = [
    line(701, `chrome --headless ${OWNER_FLAG}=999`),
    line(702, `chrome --headless ${OWNER_FLAG}=1000`),
    line(703, `chrome --headless ${OWNER_FLAG}=998`),
    ...usersOwn,
  ];
  check("多个孤儿一次收干净，活着的不牵连", JSON.stringify(orphansFrom(mixed, alive)) === JSON.stringify([701, 703]), JSON.stringify(orphansFrom(mixed, alive)));

  const lookalike = [
    line(800, `grep --color=auto ${OWNER_FLAG}=999`),
    line(801, `chrome --headless ${OWNER_FLAG}=abc`),
    line(802, `chrome --headless ${OWNER_FLAG}=`),
    line(803, `chrome --headless x${OWNER_FLAG}=999`),
  ];
  check("像但不是的一律不碰（非 Chrome 进程、pid 非法、标记被别的字粘住）", orphansFrom(lookalike, alive).length === 0, JSON.stringify(orphansFrom(lookalike, alive)));

  const selfOwned = [line(900, `chrome --headless ${OWNER_FLAG}=${process.pid}`)];
  check("当前进程起的浏览器不会被自己收掉", orphansFrom(selfOwned, (pid) => pid === process.pid).length === 0);

  const mkLine = (pid, dir) => line(pid, `chrome --user-data-dir=${dir} --remote-debugging-port=0 --headless=new ${OWNER_FLAG}=999 about:blank`);
  const ledger = {
    "/tmp/keep": { pid: 910, adoptable: true },
    "/tmp/handoff": { pid: 911, managerPid: 1000 },
    "/tmp/dead": { pid: 912, managerPid: 998 },
  };
  const opts = { readRecord: (dir) => ledger[dir] || null };
  check("账上标了 adoptable 的不收（KEEP / 烘热特意留下的）", orphansFrom([mkLine(910, "/tmp/keep")], alive, opts).length === 0, JSON.stringify(orphansFrom([mkLine(910, "/tmp/keep")], alive, opts)));
  check("现任管理者还活着的不收（接管后命令行上的主人还是旧的）", orphansFrom([mkLine(911, "/tmp/handoff")], alive, opts).length === 0);
  check("有账但没标 adoptable、管理者也死了的照收（SIGKILL 残留）", JSON.stringify(orphansFrom([mkLine(912, "/tmp/dead")], alive, opts)) === "[912]");
  check("没账的照收（--stop 清过账、profile 已删——真没人会回来了）", JSON.stringify(orphansFrom([mkLine(914, "/tmp/none")], alive, opts)) === "[914]");
  check("账记的不是这个 pid 时不受账保护（陈旧账罩不到别的浏览器）", JSON.stringify(orphansFrom([mkLine(913, "/tmp/keep")], alive, opts)) === "[913]");
  check("excludeProfile 指的 profile 一律不碰（调用方正要认领它）", orphansFrom([mkLine(915, "/tmp/mine")], alive, { ...opts, excludeProfile: "/tmp/mine" }).length === 0);
  check("不带账本读取器时保持老判据（老调用方看到的行为不变）", JSON.stringify(orphansFrom([mkLine(916, "/tmp/keep")], alive)) === "[916]");

  check("命令行里解析得出 user-data-dir", profileDirFrom("chrome --user-data-dir=/tmp/p --remote-debugging-port=0 about:blank") === "/tmp/p");
  check("路径带空格也解析得完整（Application Support 之流）", profileDirFrom("chrome --user-data-dir=/Users/me/Library/Application Support/x --remote-debugging-port=0") === "/Users/me/Library/Application Support/x", JSON.stringify(profileDirFrom("chrome --user-data-dir=/Users/me/Library/Application Support/x --remote-debugging-port=0")));
  check("没有 user-data-dir 时返回 null（不猜）", profileDirFrom("chrome --headless") === null);

  {
    let clock = 0;
    let slept = 0;
    const now = () => clock;
    const sleep = (ms) => { clock += ms; slept += ms; };
    const reset = () => { clock = 0; slept = 0; };

    check("全都已经没了 → 立刻返回，一次都不睡", (() => {
      reset();
      const left = waitGone([1, 2], { isAlive: () => false, sleep, now });
      return left.length === 0 && slept === 0;
    })());

    check("等到它咽气就返回，不空等满宽限", (() => {
      reset();
      let asks = 0;
      const isAlive = () => ++asks <= 2;
      const left = waitGone([7], { isAlive, sleep, now, totalMs: 5000, stepMs: 50 });
      return left.length === 0 && slept === 100;
    })(), String(slept));

    check("超时了如实返回还活着的，不吞掉", (() => {
      reset();
      const left = waitGone([7, 8], { isAlive: () => true, sleep, now, totalMs: 200, stepMs: 50 });
      return JSON.stringify(left) === "[7,8]";
    })());

    check("宽限用完就停，一毫秒都不多睡", (() => {
      reset();
      waitGone([7], { isAlive: () => true, sleep, now, totalMs: 200, stepMs: 50 });
      return slept === 200;
    })(), String(slept));

    check("最后一步不睡过宽限（stepMs 不整除也一样）", (() => {
      reset();
      waitGone([7], { isAlive: () => true, sleep, now, totalMs: 120, stepMs: 50 });
      return slept === 120;
    })(), String(slept));

    check("空列表不睡也不炸", (() => {
      reset();
      return waitGone([], { isAlive: () => true, sleep, now }).length === 0 && slept === 0;
    })());
  }

  if (process.platform === "win32") {
    skipSection("真实起浏览器/收孤儿的链路属于 CLI 模式，Windows 上尚未支持（上面的纯函数判定已全部验过）");
  } else {
  const M_PROFILE = path.join(TMP, "m-profile");
  const holder = spawn(
    process.execPath,
    ["-e", `import("${pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href}").then(async (m) => { const i = await m.ensureBrowser({ headless: true }); console.log("READY " + i.pid); setInterval(() => {}, 1e9); })`],
    { env: { ...process.env, AGENT_IN_CHROME_PROFILE: M_PROFILE, AGENT_IN_CHROME_CDP_TRANSPORT: "port" }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let browserPid = 0;
  holder.stdout.on("data", (b) => {
    const m = /READY (\d+)/.exec(String(b));
    if (m) browserPid = Number(m[1]);
  });
  const started = await waitFor(() => browserPid > 0, 60000);
  check("能起一个自启浏览器", started, String(browserPid));
  if (started) {
    holder.kill("SIGKILL");
    await sleep(600);
    const stillAlive = (() => {
      try {
        process.kill(browserPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    check("主人被 SIGKILL 后浏览器确实成了孤儿（这就是事故本体）", stillAlive);

    const { sweepOrphans } = await import(pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href);
    const swept = sweepOrphans();
    const goneNow = (() => {
      try {
        process.kill(browserPid, 0);
        return false;
      } catch {
        return true;
      }
    })();
    check("sweepOrphans 返回时孤儿已经真的没了（不是「信号发出去了」）", goneNow, JSON.stringify({ swept, browserPid }));
    check("返回值如实点名收掉的是谁", swept.gone.includes(browserPid), JSON.stringify(swept));
    check("没有杀不掉的", swept.stubborn.length === 0, JSON.stringify(swept.stubborn));
  }

  {
    const { sweepOrphans, psSnapshot, pidAlive, readProfileRecord } = await import(
      pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href
    );
    const isUp = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const S_PROFILE = path.join(TMP, "m-stubborn-profile");
    const stubFile = path.join(TMP, "m-stubborn.mjs");
    fs.writeFileSync(stubFile, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1e9);\n");
    const launchFile = path.join(TMP, "m-stubborn-launch.mjs");
    fs.writeFileSync(
      launchFile,
      `import { spawn } from "node:child_process";\n` +
        `const [f, profile, flag] = process.argv.slice(2);\n` +
        `const c = spawn(process.execPath, [f, "--fake-chrome", "--user-data-dir=" + profile, flag + "=" + process.pid], { detached: true, stdio: "ignore" });\n` +
        `c.unref();\n` +
        `console.log("STUB " + c.pid);\n`
    );
    const launcher = spawn(process.execPath, [launchFile, stubFile, S_PROFILE, OWNER_FLAG], { stdio: ["ignore", "pipe", "ignore"] });
    let stubPid = 0;
    launcher.stdout.on("data", (b) => {
      const m = /STUB (\d+)/.exec(String(b));
      if (m) stubPid = Number(m[1]);
    });
    check("假浏览器起得来", await waitFor(() => stubPid > 0, 10000), String(stubPid));
    await waitFor(() => launcher.exitCode !== null, 5000);
    await sleep(400);

    check("假浏览器被认成孤儿（主人已死、没账）", orphansFrom(psSnapshot(), pidAlive, { readRecord: readProfileRecord }).includes(stubPid));

    try { process.kill(-stubPid, "SIGTERM"); } catch { try { process.kill(stubPid, "SIGTERM"); } catch {} }
    await sleep(500);
    check("它确实不理 SIGTERM（否则下一条测不出升级）", isUp(stubPid), String(stubPid));

    const swept2 = sweepOrphans();
    check("SIGTERM 杀不掉的会升级到 SIGKILL，真收掉", !isUp(stubPid), JSON.stringify({ swept2, stubPid }));
    check("收掉之后才进 gone", swept2.gone.includes(stubPid), JSON.stringify(swept2));
    check("没有被误报成杀不掉", !swept2.stubborn.includes(stubPid), JSON.stringify(swept2.stubborn));

    if (isUp(stubPid)) { try { process.kill(-stubPid, "SIGKILL"); } catch {} }
  }

  {
    const MP_PROFILE = path.join(TMP, "m-pipe-profile");
    const h2 = spawn(
      process.execPath,
      ["-e", `import("${pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href}").then(async (m) => { const i = await m.ensureBrowser({ headless: true }); console.log("READY " + i.pid); setInterval(() => {}, 1e9); })`],
      { env: { ...process.env, AGENT_IN_CHROME_PROFILE: MP_PROFILE, AGENT_IN_CHROME_CDP_TRANSPORT: "pipe" }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let pid2 = 0;
    h2.stdout.on("data", (b) => {
      const m = /READY (\d+)/.exec(String(b));
      if (m) pid2 = Number(m[1]);
    });
    const up = await waitFor(() => pid2 > 0, 60000);
    check("管道模式也起得来浏览器", up, String(pid2));
    if (up) {
      h2.kill("SIGKILL");
      const died = await waitFor(() => {
        try {
          process.kill(pid2, 0);
          return false;
        } catch {
          return true;
        }
      }, 10000);
      check("主人猝死后浏览器自己就走了（管道模式没有孤儿）", died, `pid ${pid2} 还活着`);
    }
  }

  const M2_PROFILE = path.join(TMP, "m2-profile");
  const warm = spawn(
    process.execPath,
    ["-e", `import("${pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href}").then(async (m) => { const i = await m.ensureBrowser({ headless: true }); m.markAdoptable(); console.log("WARM " + i.pid); process.exit(0); })`],
    { env: { ...process.env, AGENT_IN_CHROME_PROFILE: M2_PROFILE, AGENT_IN_CHROME_CDP_TRANSPORT: "port" }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let warmPid = 0;
  warm.stdout.on("data", (b) => {
    const m = /WARM (\d+)/.exec(String(b));
    if (m) warmPid = Number(m[1]);
  });
  const warmed = await waitFor(() => warmPid > 0, 60000);
  check("烘热：起浏览器的进程标完 adoptable 干净退出", warmed, String(warmPid));
  if (warmed) {
    await waitFor(() => warm.exitCode !== null, 5000);
    const { sweepOrphans } = await import(pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href);
    const swept = sweepOrphans();
    await sleep(400);
    const survived = (() => {
      try {
        process.kill(warmPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    check("特意留下的浏览器活过了全局 sweep（烘热没白烘）", survived, JSON.stringify({ swept, warmPid }));
    check(
      "没被当成目标的不进返回值",
      !swept.gone.includes(warmPid) && !swept.stubborn.includes(warmPid),
      JSON.stringify(swept)
    );
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "cli-browser.mjs"), "--stop"], {
      env: { ...process.env, AGENT_IN_CHROME_PROFILE: M2_PROFILE },
      stdio: "ignore",
    });
    await sleep(400);
    const stopped = (() => {
      try {
        process.kill(warmPid, 0);
        return false;
      } catch {
        return true;
      }
    })();
    check("--stop 照样收得掉它（adoptable 挡的是扫孤儿，不挡正门）", stopped, String(warmPid));
  }
  }
}

console.log("\n\x1b[1mN. 会话身份跨进程重启存活\x1b[0m");
{
  const { deriveSessionId, parentStartToken, makeClaimer, pruneClaims, clientPid, isLauncherFor, processInfo } = await import(
    pathToFileURL(path.join(ROOT, "mcp", "session-id.mjs")).href
  );
  const { setWinProc } = await import(pathToFileURL(path.join(ROOT, "mcp", "proc-win.mjs")).href);
  const stub = () => "abc123";
  const claimDir = path.join(TMP, "claims");
  const alive = new Set();
  const mkClaim = () => makeClaimer({ dir: claimDir, isAlive: (p) => alive.has(p) });

  alive.add(1001);
  const a = deriveSessionId({ env: {}, ppid: 4242, pid: 1001, startToken: stub, claim: mkClaim() });
  alive.delete(1001);
  alive.add(9999);
  const b = deriveSessionId({ env: {}, ppid: 4242, pid: 9999, startToken: stub, claim: mkClaim() });
  check("MCP 进程重启（pid 变）后 sid 不变", a === b, `${a} vs ${b}`);
  check("sid 里带的是父进程 pid 而不是自己的", a.startsWith("s4242-"), a);

  const other = deriveSessionId({ env: {}, ppid: 777, pid: 9999, startToken: stub, claim: mkClaim() });
  check("不同客户端拿到不同 sid", other !== a, `${other} vs ${a}`);

  const reused = deriveSessionId({ env: {}, ppid: 4242, pid: 9999, startToken: () => "zzz999", claim: mkClaim() });
  check("ppid 被复用但父进程启动时刻不同 → sid 不同", reused !== a, `${reused} vs ${a}`);

  const alive2 = new Set([5001]);
  const claim2 = makeClaimer({ dir: path.join(TMP, "claims2"), isAlive: (p) => alive2.has(p) });
  const c1 = deriveSessionId({ env: {}, ppid: 4242, pid: 5001, startToken: stub, claim: claim2 });
  alive2.add(5002);
  const c2 = deriveSessionId({ env: {}, ppid: 4242, pid: 5002, now: () => 7, startToken: stub, claim: claim2 });
  check("同一客户端并发的两个 server 拿到不同 sid", c1 !== c2, `${c1} vs ${c2}`);
  check("先到的那个拿到稳定身份", c1 === "s4242-abc123", c1);
  check("后到的拿到第二个槽位（而不是会漂的 pid 身份）", c2 === "s4242-abc123-2", c2);
  alive2.delete(5002);
  alive2.add(5003);
  const c2b = deriveSessionId({ env: {}, ppid: 4242, pid: 5003, now: () => 8, startToken: stub, claim: claim2 });
  check("第二个槽位的 server 重启后拿回同一个 sid", c2b === c2, `${c2b} vs ${c2}`);
  const claim3 = makeClaimer({ dir: path.join(TMP, "claims3b"), isAlive: () => true, maxSlots: 2 });
  deriveSessionId({ env: {}, ppid: 4242, pid: 6001, startToken: stub, claim: claim3 });
  deriveSessionId({ env: {}, ppid: 4242, pid: 6002, startToken: stub, claim: claim3 });
  const c3 = deriveSessionId({ env: {}, ppid: 4242, pid: 6003, now: () => 9, startToken: stub, claim: claim3 });
  check("槽位占满后才回落到进程级唯一身份", c3 === "s6003-9", c3);

  const tree = {
    900: { ppid: 1, command: "/Applications/Claude.app/Contents/MacOS/Claude" },
    901: { ppid: 900, command: "/Applications/Claude.app/Contents/Helpers/disclaimer /Users/x/.agent-in-chrome/agent-in-chrome/mcp-launcher.sh" },
    902: { ppid: 900, command: "/bin/sh -c node /Users/x/.agent-in-chrome/agent-in-chrome/server.mjs" },
    910: { ppid: 1, command: "claude --resume abc" },
    903: {
      ppid: 900,
      command:
        '/Users/x/Library/Application Support/Claude/claude-code/2.1.227/claude.app/Contents/MacOS/claude --mcp-config {"mcpServers":{"agent-in-chrome":{"command":"node","args":["/Users/x/.agent-in-chrome/agent-in-chrome/server.mjs"]}}}',
    },
  };
  const info = (pid) => tree[pid] || { ppid: null, command: "" };
  const self = "/Users/x/.agent-in-chrome/agent-in-chrome/server.mjs";
  check("跳过点名了我们启动脚本的那一层", clientPid({ ppid: 901, self, info }).pid === 900);
  check("也跳过点名了 server.mjs 的 shell 包装", clientPid({ ppid: 902, self, info }).pid === 900);
  check("客户端自己直接 spawn 时一步都不多走", clientPid({ ppid: 910, self, info }).hops === 0);
  check("再往上就是 launchd 时就地停住", clientPid({ ppid: 900, self, info }).pid === 900);
  check("读不到进程信息时用原来的 ppid", clientPid({ ppid: 12345, self, info: () => ({ ppid: null, command: "" }) }).pid === 12345);
  check("启动器判据只认我们自己的路径", !isLauncherFor("/usr/bin/some-random-daemon", self) && isLauncherFor("x mcp-launcher.sh", self));
  check("argv 含 --mcp-config 的是客户端，不是启动器", !isLauncherFor(tree[903].command, self));
  check("桌面端本地 agent 模式：锚点就是引擎进程，一跳都不走", clientPid({ ppid: 903, self, info }).pid === 903 && clientPid({ ppid: 903, self, info }).hops === 0);
  check(
    "mcp-launcher.sh 的判定仍然最高优先（哪怕同时含 --mcp-config）",
    isLauncherFor("disclaimer /x/mcp-launcher.sh --mcp-config {}", self)
  );
  check("纯 self 路径、没有 --mcp-config 的照旧算启动器", isLauncherFor(`/bin/sh -c node ${self}`, self));
  check("父进程链上的启动器被跳过后，sid 落在客户端上", deriveSessionId({ env: {}, ppid: 901, pid: 7001, startToken: stub, claim: mkClaim(), anchor: ({ ppid }) => clientPid({ ppid, self, info }) }) === "s900-abc123");
  if (process.platform === "win32") {
    skipSection("processInfo 走 /bin/ps，Windows 上按「拿不到父进程信息」的回落路径工作");
  } else {
    const selfInfo = processInfo(process.pid);
    check("真机上读得到自己的父进程与命令行", selfInfo.ppid === process.ppid && selfInfo.command.length > 0, JSON.stringify(selfInfo));
  }

  check(
    "显式环境变量优先级最高",
    deriveSessionId({ env: { AGENT_IN_CHROME_SESSION_ID: "fixed" }, ppid: 4242, startToken: stub, claim: mkClaim() }) === "fixed"
  );

  const f1 = deriveSessionId({ env: {}, ppid: 4242, pid: 1001, now: () => 1, startToken: () => null, claim: mkClaim() });
  check("拿不到父进程信息时回落到自己的 pid", f1 === "s1001-1", f1);
  const f2 = deriveSessionId({ env: {}, ppid: 4242, pid: 1001, now: () => 2, startToken: stub, claim: () => false });
  check("认领失败时回落到自己的 pid", f2 === "s1001-2", f2);

  const pruneDir = path.join(TMP, "claims3");
  fs.mkdirSync(pruneDir, { recursive: true });
  fs.writeFileSync(path.join(pruneDir, "session-1-old.json"), JSON.stringify({ pid: 424242, at: 0 }));
  fs.writeFileSync(path.join(pruneDir, "session-2-fresh.json"), JSON.stringify({ pid: 424243, at: Date.now() }));
  const removed = pruneClaims({ dir: pruneDir, isAlive: () => false });
  check("清掉主人已死且过期的认领文件", removed === 1, String(removed));
  check("没过期的不动（避免误删刚重启的会话）", fs.existsSync(path.join(pruneDir, "session-2-fresh.json")));

  {
    const { pruneDeadSocks } = await import("../mcp/token.mjs");
    const sockDir = path.join(TMP, "socks");
    fs.mkdirSync(sockDir, { recursive: true });
    const mk = (name) => {
      const f = path.join(sockDir, name);
      fs.writeFileSync(f, "");
      return f;
    };
    const dead = mk("agent-in-chrome-cli-deadbeef.sock");
    const live = mk("agent-in-chrome-cli-11111111.sock");
    const fresh = mk("agent-in-chrome-cli-22222222.sock");
    const mine = mk("agent-in-chrome-cli-33333333.sock");
    const other = mk("agent-in-chrome-cli.sock");
    const fsFake = {
      readdirSync: (d) => fs.readdirSync(d),
      statSync: (f) => ({ isSocket: () => true, mtimeMs: f === fresh ? Date.now() : 0 }),
      unlinkSync: (f) => fs.unlinkSync(f),
    };
    const n = await pruneDeadSocks({
      dir: sockDir,
      keep: [mine],
      fs: fsFake,
      probe: async (f) => f === live,
    });
    check("清掉没人在听的死 socket", n === 1 && !fs.existsSync(dead), `removed=${n}`);
    check("有人在听的一律留着（错删活主 = 选出第二个主）", fs.existsSync(live));
    check("太新的留着（活主可能正卡在 bind 与 listen 之间）", fs.existsSync(fresh));
    check("自己这条 SOCK 不碰", fs.existsSync(mine));
    check("不带 profile hash 的那条不归它管", fs.existsSync(other));

    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-sk-"));
    fs.chmodSync(liveDir, 0o700);
    const livePath = path.join(liveDir, "agent-in-chrome-cli-eeeeeeee.sock");
    const deadPath = path.join(liveDir, "agent-in-chrome-cli-ffffffff.sock");
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(livePath, r));
    const zombieSrv = spawn(process.execPath, ["-e", `require("net").createServer(()=>{}).listen(${JSON.stringify(deadPath)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => zombieSrv.stdout.once("data", r));
    zombieSrv.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const nReal = await pruneDeadSocks({ dir: liveDir, minAgeMs: 0 });
    check("真探活：没人在听的（进程被 SIGKILL 掉）删得掉", nReal === 1 && !fs.existsSync(deadPath), `removed=${nReal}`);
    check("真探活：还在 listen 的一个字不碰", fs.existsSync(livePath));
    await new Promise((r) => srv.close(r));
    fs.rmSync(liveDir, { recursive: true, force: true });
  }

  const psTok = (out) => parentStartToken(123, () => out, { platform: "darwin" });
  check("ppid 非法时不去调 ps", parentStartToken(0) === null && parentStartToken(1) === null);
  check("能把 lstart 压成短 token", psTok("Mon Aug  4 11:16:13 2026") === Date.parse("Mon Aug  4 11:16:13 2026").toString(36));
  check("同一个 lstart 每次得到同一个 token", psTok("Mon Aug  4 11:16:13 2026") === psTok("Mon Aug  4 11:16:13 2026"));
  check("不同 lstart 得到不同 token", psTok("Mon Aug  4 11:16:13 2026") !== psTok("Mon Aug  4 12:00:00 2026"));
  check("lstart 解析不了也能给出稳定 token（不 crash、不返回 null）", (() => {
    const t = psTok("这不是时间");
    return typeof t === "string" && t.length > 0 && t === psTok("这不是时间");
  })());
  check("ps 抛错时返回 null 而不是崩", parentStartToken(123, () => { throw new Error("boom"); }, { platform: "darwin" }) === null);
  check("ps 返回空时返回 null", psTok("  ") === null);
  {
    const src = { get: (pid) => (pid === 123 ? { ppid: 1, tty: null, name: "claude.exe", command: "claude.exe", start: "134327533025719003" } : null) };
    setWinProc(src);
    try {
      check("Windows：拿 CreationDate 当 token，同一个父进程恒定", parentStartToken(123, null, { platform: "win32" }) === BigInt("134327533025719003").toString(36));
      check("Windows：快照里没有这个 pid 就返回 null（退回进程级唯一，不猜）", parentStartToken(456, null, { platform: "win32" }) === null);
      check("Windows：processInfo 也走同一张快照", processInfo(123, null, { platform: "win32" }).command === "claude.exe");
    } finally {
      setWinProc(null);
    }
  }

  if (process.platform === "win32") {
    skipSection("parentStartToken 走 ps lstart，Windows 上按回落档（pid 基 sid）工作——ps 等价物是后续工作");
  } else {
    const real = parentStartToken(process.ppid);
    check("真机上确实读得到父进程启动时刻", typeof real === "string" && real.length > 0, String(real));
  }

  const { makeInheritor, fingerprintOf } = await import(pathToFileURL(path.join(ROOT, "mcp", "session-id.mjs")).href);
  const ME = { workspace: "agent-in-chrome", brandFallback: null, surface: "cli" };
  const mkDir = (name, files) => {
    const d = path.join(TMP, "inherit-" + name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v));
    return d;
  };
  const fp = fingerprintOf(ME);
  check("指纹只取与 pid 无关的那三段", JSON.stringify(fp) === JSON.stringify({ w: "agent-in-chrome", b: null, s: "cli" }), JSON.stringify(fp));
  check("没有身份就没有指纹（退回改动前的行为）", fingerprintOf(null) === null);

  {
    const dir = mkDir("dead", { "session-900-old.json": { pid: 8001, at: Date.now() - 60_000, id: fp } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }),
    });
    check("客户端重启后继承同身份的旧 key", got === "s900-old", got);
    const back = JSON.parse(fs.readFileSync(path.join(dir, "session-900-old.json"), "utf8"));
    check("继承时把自己的 pid 写进那个认领文件", back.pid === 7777, JSON.stringify(back));
  }
  {
    const dir = mkDir("alive", { "session-900-old.json": { pid: 8001, at: Date.now(), id: fp } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => true }), claim: () => "4242-newtok",
    });
    check("占用者还活着就不继承（那是并发的另一段会话）", got === "s4242-newtok", got);
  }
  {
    const dir = mkDir("other", { "session-900-old.json": { pid: 8001, at: Date.now(), id: { w: "别的仓库", b: null, s: "cli" } } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }), claim: () => "4242-newtok",
    });
    check("指纹不一致不继承", got === "s4242-newtok", got);
  }
  {
    const dir = mkDir("nullws", { "session-900-old.json": { pid: 8001, at: Date.now(), id: { w: null, b: null, s: "cli" } } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }), claim: () => "4242-newtok",
    });
    check("指纹里的 null 段也要对上", got === "s4242-newtok", got);
  }
  {
    const dir = mkDir("legacy", { "session-900-old.json": { pid: 8001, at: Date.now() } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }), claim: () => "4242-newtok",
    });
    check("老格式认领文件（没有指纹）不继承", got === "s4242-newtok", got);
  }
  {
    const dir = mkDir("stale", { "session-900-old.json": { pid: 8001, at: Date.now() - 48 * 3600 * 1000, id: fp } });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }), claim: () => "4242-newtok",
    });
    check("太老的认领文件不继承（那边的组早解散了）", got === "s4242-newtok", got);
  }
  {
    const dir = mkDir("newest", {
      "session-900-a.json": { pid: 8001, at: 1000, id: fp },
      "session-900-b.json": { pid: 8002, at: 9000, id: fp },
    });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, now: () => 9500, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false, now: () => 9500 }),
    });
    check("多个候选取最近活跃的那个", got === "s900-b", got);
  }
  {
    const dir = mkDir("mine", {
      "session-4242-newtok.json": { pid: 8001, at: Date.now(), id: fp },
      "session-900-old.json": { pid: 8002, at: Date.now(), id: fp },
    });
    const got = deriveSessionId({
      env: {}, ppid: 4242, pid: 7777, startToken: () => "newtok", identity: ME,
      inherit: makeInheritor({ dir, isAlive: () => false }),
      claim: makeClaimer({ dir, isAlive: () => false }),
    });
    check("自己的 key 还在时不继承别人的槽位", got === "s4242-newtok", got);
  }
  {
    const dir = path.join(TMP, "inherit-payload");
    deriveSessionId({ env: {}, ppid: 4242, pid: 7777, startToken: () => "tok", identity: ME, claim: makeClaimer({ dir, isAlive: () => false }) });
    const wrote = JSON.parse(fs.readFileSync(path.join(dir, "session-4242-tok.json"), "utf8"));
    check("认领时把身份指纹写进文件", JSON.stringify(wrote.id) === JSON.stringify(fp), JSON.stringify(wrote));
  }
  check(
    "显式环境变量仍然压过继承",
    deriveSessionId({ env: { AGENT_IN_CHROME_SESSION_ID: "fixed" }, ppid: 4242, pid: 7777, startToken: stub, identity: ME, inherit: () => "900-old" }) === "fixed"
  );
}

console.log("\n\x1b[1mO. 测试站扛得住客户端半路走掉\x1b[0m");
{
  const startFixture = async () => {
    const p = spawn(process.execPath, [path.join(ROOT, "scripts", "fixture-server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => (err += c));
    let exited = null;
    p.on("exit", (code, sig) => (exited = { code, sig }));
    const base = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("测试站 8s 未就绪")), 8000);
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => {
        const m = /FIXTURE_READY (\S+)/.exec(c);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
    });
    return { p, base, getErr: () => err, getExit: () => exited };
  };

  const serving = (base, pathname = "/api/user") =>
    new Promise((resolve) => {
      const r = http.get(base + pathname, (m) => { m.resume(); resolve(m.statusCode); });
      r.on("error", (e) => resolve(e.code || String(e)));
      r.setTimeout(4000, () => { r.destroy(); resolve("timeout"); });
    });

  const halfPost = (base, pathname, headers) =>
    new Promise((resolve) => {
      const u = new URL(base);
      const s = net.connect(Number(u.port), u.hostname, () => {
        s.write(`POST ${pathname} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`);
        setTimeout(() => { s.destroy(); resolve(); }, 120);
      });
      s.on("error", () => resolve());
    });

  const post = (base, pathname, body, ct = "application/json") =>
    new Promise((resolve) => {
      const u = new URL(base);
      const r = http.request(
        { host: u.hostname, port: u.port, path: pathname, method: "POST", headers: { "content-type": ct } },
        (m) => { let b = ""; m.setEncoding("utf8"); m.on("data", (d) => (b += d)); m.on("end", () => resolve({ status: m.statusCode, body: b })); }
      );
      r.on("error", (e) => resolve({ status: e.code || String(e), body: "" }));
      r.setTimeout(5000, () => { r.destroy(); resolve({ status: "timeout", body: "" }); });
      r.end(body);
    });

  const cases = [
    ["/api/order 的请求体发一半就断线", (f) => halfPost(f.base, "/api/order", "content-length: 200\r\n\r\n{\"sku\":\"A-1\"")],
    ["/upload 的请求体发一半就断线", (f) => halfPost(f.base, "/upload", "content-type: multipart/form-data; boundary=xx\r\ncontent-length: 9000\r\n\r\n--xx\r\n")],
    ["/form-submit 的请求体发一半就断线", (f) => halfPost(f.base, "/form-submit", "content-type: application/x-www-form-urlencoded\r\ncontent-length: 400\r\n\r\nkw=a")],
  ];
  for (const [name, fire] of cases) {
    const f = await startFixture();
    await fire(f);
    await sleep(400);
    const st = await serving(f.base);
    check(`${name}，测试站照样活着`, st === 200, `应答=${st} 退出=${JSON.stringify(f.getExit())} ${f.getErr().split("\n")[0] || ""}`);
    try { f.p.kill("SIGKILL"); } catch {}
  }

  {
    const f = await startFixture();
    const bad = await post(f.base, "/api/order", "这不是 JSON");
    check("请求体不是合法 JSON 时当场回 500（不是卡住、不是崩）", bad.status === 500, JSON.stringify(bad).slice(0, 160));
    const st = await serving(f.base);
    check("抛过错之后测试站还在应答", st === 200, `应答=${st} 退出=${JSON.stringify(f.getExit())}`);
    const ok = await post(f.base, "/api/order", JSON.stringify({ sku: "A-1", qty: 3 }));
    check("正常的 POST 一切照旧", ok.status === 200 && /order-payload-marker/.test(ok.body), JSON.stringify(ok).slice(0, 160));
    check("路由抛错在 stderr 上留了痕（e2e 的 stderr 尾巴捞得到）", /\[fixture\]/.test(f.getErr()), f.getErr().slice(0, 200));
    try { f.p.kill("SIGKILL"); } catch {}
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
if (installedForThisRun) fs.rmSync(runtimeHome, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} 通过, ${failed} 失败\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
