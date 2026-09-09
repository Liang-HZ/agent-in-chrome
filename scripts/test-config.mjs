#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as cfg from "../mcp/config.mjs";
import { TOOL_TIER, TIER_RANK, PARAM_REQUIRES_FULL, REVEAL_REQUIRES_FULL, FREE_JS_PARAM_NAMES } from "../mcp/tool-tiers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "mcp", "server.mjs");

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

console.log("\n\x1b[1m配置校验\x1b[0m");
{
  const d = cfg.normalize({});
  check("空对象补出完整默认值", d.value.tools.profile === "full" && Array.isArray(d.value.tools.disable));
  check("默认档是 full（升级上来的老用户行为不变）", cfg.DEFAULTS.tools.profile === "full");

  check("顶层不是对象 → value 为 null（交给调用方失败关闭）", cfg.normalize([1, 2]).value === null);
  check("顶层是 null 也一样", cfg.normalize(null).value === null);

  const bad = cfg.normalize({ tools: { profile: "superuser" } });
  check("不认识的档位 = 致命，value 为 null（绝不静默回落成更宽松的 full）", bad.value === null, JSON.stringify(bad.value));
  check("并且说清楚了哪里不对", bad.problems.some((p) => p.includes("profile")));
  const caseTypo = cfg.normalize({ tools: { profile: "Observe" } });
  check("大小写写错也是致命（不是「差不多就按 full 来」）", caseTypo.value === null, JSON.stringify(caseTypo.value));

  const dup = cfg.normalize({ tools: { disable: ["browser_eval", "browser_eval", "browser_cdp"] } });
  check("disable 去重", JSON.stringify(dup.value.tools.disable) === '["browser_eval","browser_cdp"]');

  const mixed = cfg.normalize({ tools: { disable: ["browser_eval", 42, null] } });
  check("disable 里的非字符串被剔掉", JSON.stringify(mixed.value.tools.disable) === '["browser_eval"]');
  check("并且报出来", mixed.problems.some((p) => p.includes("非字符串")));

  const future = cfg.normalize({ tools: { profile: "observe" }, somethingNew: true });
  check("不认识的字段被忽略而不是整份作废（老 server 读新配置）", future.value.tools.profile === "observe");
  check("但会指出来", future.problems.some((p) => p.includes("somethingNew")));

  const ro = cfg.normalize({ tools: { profile: "readonly" } });
  check("旧档位 readonly 迁移到 observe", ro.value.tools.profile === "observe", JSON.stringify(ro.value.tools));
  const std = cfg.normalize({ tools: { profile: "standard" } });
  check("旧档位 standard 迁移到 full（放宽方向，不是 observe）", std.value.tools.profile === "full", JSON.stringify(std.value.tools));
  check("迁移不算 problem（老 popup 发旧值仍能存盘）", ro.problems.length === 0 && std.problems.length === 0, JSON.stringify(ro.problems));
  check("但有 note 说明改名（server 会打进 stderr）", ro.notes.some((n) => /旧档位/.test(n)) && std.notes.some((n) => /旧档位/.test(n)), JSON.stringify(ro.notes));

  const ghost = cfg.normalize({ tools: { disable: ["browser_not_a_real_tool"] } });
  check("不存在的工具名不让配置作废", ghost.value !== null && ghost.value.tools.disable.length === 1);
}

console.log("\n\x1b[1m读写\x1b[0m");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfg-"));
  const file = path.join(dir, "config.json");

  const miss = cfg.loadSync(file);
  check("文件不存在 → source=default，给默认值", miss.source === "default" && miss.value.tools.profile === "full");

  cfg.saveSync({ tools: { profile: "observe", disable: ["browser_batch"] } }, file);
  const got = cfg.loadSync(file);
  check("写完读回来一致", got.source === "file" && got.value.tools.profile === "observe");
  check("disable 也存住了", JSON.stringify(got.value.tools.disable) === '["browser_batch"]');
  check("落盘的是规范化之后的完整结构", JSON.parse(fs.readFileSync(file, "utf8")).version === 1);

  fs.writeFileSync(file, '{"tools": {"prof');
  const broken = cfg.loadSync(file);
  check("半截 JSON → source=error 且 value 为 null", broken.source === "error" && broken.value === null);
  check("坏 JSON 绝不悄悄变成默认值", broken.value !== null ? false : true);

  fs.writeFileSync(file, "[1,2,3]");
  check("顶层是数组 → 同样 error", cfg.loadSync(file).source === "error");

  let threw = false;
  try {
    cfg.saveSync([1, 2], file);
  } catch {
    threw = true;
  }
  check("拒绝写入无效配置", threw);
  check("拒绝之后不留临时文件", fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1m热更新（watch）\x1b[0m");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfg-"));
  const file = path.join(dir, "config.json");
  const seen = [];
  const w = cfg.watch((loaded) => seen.push(loaded), { file, debounceMs: 30 });
  check("watch 起得来", w.ok);

  cfg.saveSync({ tools: { profile: "observe" } }, file);
  await new Promise((r) => setTimeout(r, 250));
  check("文件从无到有能被监听到", seen.length >= 1 && seen.at(-1)?.value?.tools.profile === "observe");

  cfg.saveSync({ tools: { profile: "observe", disable: ["browser_find"] } }, file);
  await new Promise((r) => setTimeout(r, 250));
  check("原子写（rename 换 inode）也能被监听到", seen.at(-1)?.value?.tools.disable?.includes("browser_find"));

  const n = seen.length;
  fs.writeFileSync(file, "{ 坏掉的");
  await new Promise((r) => setTimeout(r, 250));
  check("坏配置也会回调（调用方据此失败关闭）", seen.length > n);
  check("坏配置的 value 是 null，不是默认值", seen.at(-1)?.value === null);

  w.stop();
  const after = seen.length;
  cfg.saveSync({ tools: { profile: "full" } }, file);
  await new Promise((r) => setTimeout(r, 250));
  check("stop() 之后不再回调", seen.length === after);

  fs.rmSync(dir, { recursive: true, force: true });
}

function startServer(dir) {
  const p = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, AGENT_IN_CHROME_SOCK: path.join(dir, "agent-in-chrome.sock"), AGENT_IN_CHROME_TRACE: "0" },
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  p.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method) {
        notifications.push(m.method);
        for (const w of waiters.splice(0)) w(m.method);
      }
    }
  });
  return {
    raw(method, params) {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async rpc(method, params) {
      return (await this.raw(method, params)).result;
    },
    waitNotification(method, ms) {
      if (notifications.includes(method)) {
        notifications.length = 0;
        return Promise.resolve(true);
      }
      return new Promise((res) => {
        const t = setTimeout(() => res(false), ms);
        waiters.push((got) => {
          if (got === method) {
            clearTimeout(t);
            notifications.length = 0;
            res(true);
          }
        });
      });
    },
    kill: () => p.kill(),
  };
}

async function withConfig(config, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfg-"));
  if (Object.keys(config).length) cfg.saveSync(config, path.join(dir, "config.json"));
  const srv = startServer(dir);
  try {
    await srv.rpc("initialize", { protocolVersion: "2024-11-05" });
    return await fn(srv);
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const listTools = (config) => withConfig(config, async (s) => (await s.rpc("tools/list")).tools);
const callTool = (config, name, args) => withConfig(config, (s) => s.raw("tools/call", { name, arguments: args }));

console.log("\n\x1b[1m档位表\x1b[0m");
const allTools = await listTools({});
{
  const missing = allTools.map((t) => t.name).filter((n) => !TOOL_TIER[n]);
  check(
    "每个工具都在档位表里登记了（漏登记会让它从 observe 用户眼前消失）",
    missing.length === 0,
    `漏了：${missing.join("、")}`
  );
  const ghosts = Object.keys(TOOL_TIER).filter((n) => !allTools.some((t) => t.name === n) && n !== "browser_reload_extension");
  check("档位表里没有已经不存在的工具", ghosts.length === 0, `多余：${ghosts.join("、")}`);
  check("档位只有两档（三档已砍，见 tool-tiers.mjs 头注释）", new Set(Object.values(TOOL_TIER)).size <= 2);
  check("每个档位名都认识", Object.values(TOOL_TIER).every((t) => t in TIER_RANK));

  {
    const popup = fs.readFileSync(path.join(ROOT, "extension", "popup.html"), "utf8");
    const hints = [...popup.matchAll(/class="thint">([^<]*)</g)].map((m) => m[1]);
    check("popup 档位文案里没有「绝不/绝对/永远不」式承诺", hints.every((h) => !/绝不|绝对不|永远不/.test(h)), JSON.stringify(hints));
    check("观察档文案如实写了导航会发 GET", hints.some((h) => /GET/.test(h)), JSON.stringify(hints));
  }
}

console.log("\n\x1b[1mserver 按配置裁剪工具表\x1b[0m");
{
  const full = allTools.length;
  const ob = await listTools({ tools: { profile: "observe" } });

  check("observe ⊂ full", ob.length < full, `${ob.length}/${full}`);
  const names = (l) => new Set(l.map((t) => t.name));

  check("observe 里没有 click/type（不点、不填）", !names(ob).has("browser_click") && !names(ob).has("browser_type"));
  check("observe 里有 read_page/screenshot/navigate", ["browser_read_page", "browser_screenshot", "browser_navigate"].every((n) => names(ob).has(n)));
  check("observe 里没有 eval/cdp/cookies_export（凭据面）", ["browser_eval", "browser_cdp", "browser_cookies_export"].every((n) => !names(ob).has(n)));
  check("observe 里没有 tab_use/close_tab（碰用户的标签页）", !names(ob).has("browser_tab_use") && !names(ob).has("browser_close_tab"));
  check("full 里有 eval/cdp", names(allTools).has("browser_eval") && names(allTools).has("browser_cdp"));

  const legacyRo = await listTools({ tools: { profile: "readonly" } });
  const legacyStd = await listTools({ tools: { profile: "standard" } });
  check("老配置 readonly 等价于 observe", legacyRo.length === ob.length, `${legacyRo.length} vs ${ob.length}`);
  check("老配置 standard 迁移到 full（放宽方向）", legacyStd.length === full, `${legacyStd.length} vs ${full}`);

  const noBatch = await listTools({ tools: { disable: ["browser_batch"] } });
  check("单独 disable 一个工具，它就真的不出现在 tools/list", !names(noBatch).has("browser_batch"));
  check("disable 只影响点名的那个", noBatch.length === full - 1);

  const conflict = await listTools({ tools: { profile: "observe", enable: ["browser_eval"], disable: ["browser_eval"] } });
  check("同时 enable 和 disable 时，disable 赢", !names(conflict).has("browser_eval"));

  const lifted = await listTools({ tools: { profile: "observe", enable: ["browser_click"] } });
  check("enable 能把档位之外的工具单独放进来", names(lifted).has("browser_click"));

  const bytes = (l) => Buffer.byteLength(JSON.stringify(l));
  console.log(`  \x1b[90m·\x1b[0m tools/list 载荷：full ${bytes(allTools)}B → observe ${bytes(ob)}B`);
}

console.log("\n\x1b[1mtools/list 字节预算\x1b[0m");
{
  const B = (o) => Buffer.byteLength(JSON.stringify(o));
  const PROSE_BUDGET = 32 * 1024;
  const ANNO_BUDGET = 4 * 1024;
  const prose = B(allTools.map(({ annotations: _drop, ...rest }) => rest));
  const anno = B(allTools) - prose;
  check(
    `full 档 tools/list 文案 ≤ ${PROSE_BUDGET}B（常驻开销，每个 agent 每次请求都带着）`,
    prose <= PROSE_BUDGET,
    `当前 ${prose}B，超了 ${prose - PROSE_BUDGET}B`
  );
  check(
    `annotations 单独 ≤ ${ANNO_BUDGET}B（四个布尔量而已，超了说明塞了别的东西）`,
    anno <= ANNO_BUDGET,
    `当前 ${anno}B`
  );
  const total = B(allTools);

  const rank = allTools
    .map((t) => ({
      name: t.name,
      total: B(t),
      desc: Buffer.byteLength(t.description || ""),
      schema: B(t.inputSchema || {}),
    }))
    .sort((a, b) => b.total - a.total);
  const width = Math.max(...rank.map((r) => r.name.length));
  console.log(`  \x1b[90m·\x1b[0m 合计 ${total}B / ${allTools.length} 个工具（文案 ${prose}B / 预算 ${PROSE_BUDGET}B，annotations ${anno}B），最肥的 10 个：`);
  for (const r of rank.slice(0, 10)) {
    console.log(
      `    \x1b[90m${String(r.total).padStart(5)}B  ${r.name.padEnd(width)}  ` +
        `说明 ${String(r.desc).padStart(4)}B  参数 ${String(r.schema).padStart(4)}B\x1b[0m`
    );
  }
}

console.log("\n\x1b[1mschema 要暴露 sw.js 真收的参数\x1b[0m");
{
  const sw = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const swParams = (tool) => {
    const re = new RegExp(`async ${tool}\\(\\s*\\{([^}]*)\\}`, "m");
    const m = re.exec(sw);
    if (!m) return null;
    return m[1]
      .split(",")
      .map((s) => s.trim().split(/[:=]/)[0].trim())
      .filter(Boolean)
      .map((s) => (s === "tabId" ? "tabId" : s));
  };
  for (const [name, tool, param] of [
    ["browser_find", "find", "container"],
    ["browser_eval", "eval_js", "awaitPromise"],
    ["browser_network_wait", "network_wait", "pollMs"],
  ]) {
    const ps = swParams(tool);
    check(`sw.js 的 ${tool} 确实收 ${param}（判据没跑偏）`, !!ps && ps.includes(param), JSON.stringify(ps));
    const props = byName.get(name)?.inputSchema?.properties || {};
    check(`${name} 的 schema 暴露了 ${param}`, param in props, Object.keys(props).join("、"));
  }
  const desc = (n, p) => String(byName.get(n)?.inputSchema?.properties?.[p]?.description || "");
  check("awaitPromise 的默认值和 sw.js 一致（true）", /default true/i.test(desc("browser_eval", "awaitPromise")), desc("browser_eval", "awaitPromise"));
  check("pollMs 的默认值和 sw.js 一致（150）", /150/.test(desc("browser_network_wait", "pollMs")), desc("browser_network_wait", "pollMs"));
  check(
    "find 的 container 说明和 read_page/refresh_refs 是同一句（CONTAINER_DESC）",
    desc("browser_find", "container") === desc("browser_read_page", "container"),
    desc("browser_find", "container")
  );
}

console.log("\n\x1b[1m工具说明要和实现对得上\x1b[0m");
{
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const sw = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  const click = byName.get("browser_click")?.description || "";
  check("sw.js 的 verified 确实有 navigated 这个取值（判据没跑偏）", sw.includes('verified: "navigated"'));
  check("click 说明不再把 unknown 说成「页面导航了」", !/unknown'?\s*=\s*the page navigated/i.test(click), click.slice(0, 200));
  check("click 说明点出了 navigated 这个取值", /navigated/.test(click), click.slice(0, 200));
  check("click 说明说清了 unknown 是「验不出来」而不是「点空了」", /could not be verified|not proof it missed/i.test(click), click.slice(0, 200));

  const typeRef = String(byName.get("browser_type")?.inputSchema?.properties?.ref?.description || "");
  check("type 的 ref 说明收 find 给的 ref_b（parseNodeRef 一直都收）", /ref_b/.test(typeRef), typeRef);

  const traceStep = String(byName.get("browser_trace")?.inputSchema?.properties?.step?.description || "");
  check("trace 的 step 说明交代了和 session 同给时的行为", /session/.test(traceStep), traceStep);

  const steps = String(byName.get("browser_batch")?.inputSchema?.properties?.steps?.description || "");
  check("batch 的 steps 说明点明了步骤形状 {tool, args}", /\btool\b/.test(steps) && /\bargs\b/.test(steps), steps);
  check("batch 的 steps 说明交代了 params/arguments 也收（和 KNOWN_STEP_KEYS 一致）", /params/.test(steps) && /arguments/.test(steps), steps);
  check("batch 的 steps 说明交代了别的键名会被整批拒掉", /reject|refus/i.test(steps), steps);

  const rp = byName.get("browser_read_page")?.description || "";
  const rr = byName.get("browser_refresh_refs")?.description || "";
  const clk = byName.get("browser_click")?.description || "";
  check("read_page 保着 activeDialog 的完整说明（container + OOPIF）", /activeDialog/.test(rp) && /container/.test(rp) && /OOPIF/.test(rp), rp.slice(-160));
  check("refresh_refs / click 仍然告诉模型 activeDialog 要先处理", /activeDialog/.test(rr) && /activeDialog/.test(clk));
  check("那一整段不再重复贴进 refresh_refs / click", !/OOPIF overlays get refs/.test(rr) && !/OOPIF overlays get refs/.test(clk), (rr.match(/OOPIF[^.]*/) || [""])[0]);
  check("refresh_refs / click 给出了去哪看细节", /see browser_read_page/.test(rr) && /see browser_read_page/.test(clk));

  const evalWarnings = ["browser_find", "browser_hover", "browser_set"].filter((n) => /\beval\b/.test(byName.get(n)?.description || ""));
  check("「别用 eval 绕过工具」只留一处，且留在 set 上", evalWarnings.length === 1 && evalWarnings[0] === "browser_set", evalWarnings.join("、"));
}

console.log("\n\x1b[1m关掉的工具被调用时\x1b[0m");
{
  const err = await callTool({ tools: { profile: "observe" } }, "browser_click", { ref: "ref_1" });
  check("报的是错误而不是假装成功", err.result?.isError === true, JSON.stringify(err).slice(0, 200));
  check("走的是 isError 的内容，不是协议错误（模型才读得到）", !err.error && !!err.result?.content?.[0]?.text);
  const msg = err.result.content[0].text;
  check("说的是「关掉了」，不是「未知工具」", /关掉了/.test(msg) && !/未知工具/.test(msg));
  check("告诉它重试没用", /重试不会回来/.test(msg));
  check("一次给出当前可用的全集", msg.includes("当前可用的工具") && ["browser_read_page","browser_find","browser_navigate"].every((n)=>msg.includes(n)));
  check("被关掉的不在可用名单里", !msg.split("当前可用的工具")[1].includes("browser_type"));
  check("不掺内部机制解释（档位/disable 是我们的概念，模型不需要懂）", !/档|disable|config\.json/.test(msg));

  const unknown = await callTool({}, "browser_no_such_thing", {});
  check("真不存在的工具仍然报「未知工具」（两者要分得开）", /未知工具/.test(unknown.error.message));

  const again = await callTool({ tools: { profile: "observe" } }, "browser_click", { ref: "ref_1" });
  check("同样的配置给同样的文本（工具顺序稳定）", again.result?.content?.[0]?.text === msg);

  const batch = await callTool({ tools: { disable: ["browser_click"] } }, "browser_batch", {
    steps: [{ tool: "browser_navigate", args: { url: "https://example.com" } }, { tool: "browser_click", args: { ref: "ref_1" } }],
  });
  const text = JSON.stringify(batch);
  check("batch 里用到被关掉的工具会被拦下", /设置里关掉了/.test(text));
  check("而且是整批不执行（前面几步也没跑）", /这一批什么都没做/.test(text));
}

console.log("\n\x1b[1mrevealSecrets 档位闸\x1b[0m");
{
  const denied = await callTool({ tools: { profile: "observe" } }, "browser_as_curl", { requestId: "r1", revealSecrets: true });
  const dt = JSON.stringify(denied);
  check("观察档下 as_curl + revealSecrets 被拒", /revealSecrets/.test(dt) && /完全/.test(dt), dt.slice(0, 220));
  check("拒绝时指了两条出路（去掉参数 / 切完全档）", /去掉 revealSecrets/.test(dt) && /扩展设置/.test(dt), dt.slice(0, 220));

  const denied2 = await callTool({ tools: { profile: "observe" } }, "browser_request_detail", { requestId: "r1", revealSecrets: true });
  check("request_detail 同样被拒", /revealSecrets/.test(JSON.stringify(denied2)));

  const b = await callTool({ tools: { profile: "observe" } }, "browser_batch", {
    steps: [
      { tool: "browser_navigate", args: { url: "https://example.com" } },
      { tool: "browser_as_curl", args: { requestId: "r1", revealSecrets: true } },
    ],
  });
  const bt = JSON.stringify(b);
  check("batch 里藏 revealSecrets 也被拦", /revealSecrets/.test(bt), bt.slice(0, 220));
  check("而且整批没跑", /这一批什么都没做/.test(bt));

  for (const v of ["yes", "true", 1, {}]) {
    for (const profile of ["observe", "full"]) {
      const r = await callTool({ tools: { profile } }, "browser_as_curl", { requestId: "r1", revealSecrets: v });
      const rt = JSON.stringify(r);
      check(
        `${profile} 档下 revealSecrets:${JSON.stringify(v)} 被当场拒绝（不是静默放行）`,
        r.result?.isError === true && /只认布尔 true/.test(rt) && /什么都没做/.test(rt),
        rt.slice(0, 240)
      );
    }
  }
  const okFalse = await callTool({ tools: { profile: "observe" } }, "browser_as_curl", { requestId: "r1", revealSecrets: false });
  check("revealSecrets:false 照旧不被闸拦（打码版在观察档要能用）", !/完全/.test(JSON.stringify(okFalse)), JSON.stringify(okFalse).slice(0, 200));
  const okAbsent = await callTool({ tools: { profile: "observe" } }, "browser_as_curl", { requestId: "r1" });
  check("不带 revealSecrets 照旧不被闸拦", !/完全/.test(JSON.stringify(okAbsent)), JSON.stringify(okAbsent).slice(0, 200));
}

console.log("\n\x1b[1m自由 JS 参数：观察档不得留执行口（结构性）\x1b[0m");
{
  const observeTools = allTools.filter((t) => TOOL_TIER[t.name] === "observe");
  check("观察档里确实有工具（判据没跑空）", observeTools.length > 10, String(observeTools.length));
  const holes = [];
  for (const t of observeTools) {
    const props = Object.keys(t.inputSchema?.properties || {});
    const registered = PARAM_REQUIRES_FULL[t.name] || [];
    const free = props.filter((k) => FREE_JS_PARAM_NAMES.includes(k) && !registered.includes(k));
    if (free.length) holes.push(`${t.name}.${free.join("/")}`);
  }
  check(
    "观察档工具的自由 JS 字段都登记在 PARAM_REQUIRES_FULL 里（漏登记 = 观察档整个失效）",
    holes.length === 0,
    `没登记的执行口：${holes.join("、")}`
  );
  const stale = [];
  for (const [n, params] of Object.entries(PARAM_REQUIRES_FULL)) {
    const t = allTools.find((x) => x.name === n);
    if (!t) {
      stale.push(n);
      continue;
    }
    const props = Object.keys(t.inputSchema?.properties || {});
    for (const pn of params) if (!props.includes(pn)) stale.push(`${n}.${pn}`);
  }
  check("PARAM_REQUIRES_FULL 里没有过期条目", stale.length === 0, `过期：${stale.join("、")}`);
  check("wait_for 的 js 确实被登记了（判据没跑偏）", (PARAM_REQUIRES_FULL.browser_wait_for || []).includes("js"));
  check(
    "REVEAL_REQUIRES_FULL 与 PARAM_REQUIRES_FULL 是两张表",
    [...REVEAL_REQUIRES_FULL].every((n) => !PARAM_REQUIRES_FULL[n])
  );
}

console.log("\n\x1b[1mjs 参数的档位闸（revealDenied 的参数提档分支）\x1b[0m");
{
  const GATE = /任意 JS 执行口/;
  const d = await callTool({ tools: { profile: "observe" } }, "browser_wait_for", { js: "document.cookie" });
  const dt = JSON.stringify(d);
  check("观察档下 wait_for 带 js 被拒", d.result?.isError === true && GATE.test(dt), dt.slice(0, 260));
  check("拒绝时指路 selector / urlContains / textContains", /selector/.test(dt) && /urlContains/.test(dt) && /textContains/.test(dt), dt.slice(0, 300));
  check("拒绝时指出「切完全档」这条出路", /完全/.test(dt) && /扩展设置/.test(dt), dt.slice(0, 300));

  const ok = await callTool({ tools: { profile: "observe" } }, "browser_wait_for", { selector: "#done" });
  check("观察档下不带 js 的 wait_for 不被这道闸拦", !GATE.test(JSON.stringify(ok)), JSON.stringify(ok).slice(0, 200));
  const empty = await callTool({ tools: { profile: "observe" } }, "browser_wait_for", { selector: "#done", js: "" });
  check("js 是空串（扩展侧压根不内联）时不误拦", !GATE.test(JSON.stringify(empty)), JSON.stringify(empty).slice(0, 200));

  const full = await callTool({ tools: { profile: "full" } }, "browser_wait_for", { js: "document.cookie" });
  check("完全档下 wait_for 带 js 不被拦", !GATE.test(JSON.stringify(full)), JSON.stringify(full).slice(0, 200));

  const b = await callTool({ tools: { profile: "observe" } }, "browser_batch", {
    steps: [
      { tool: "browser_navigate", args: { url: "https://example.com" } },
      { tool: "browser_wait_for", args: { js: "document.getElementById('submitBtn').click()" } },
    ],
  });
  const bt = JSON.stringify(b);
  check("batch 里藏 wait_for+js 也被拦", GATE.test(bt), bt.slice(0, 260));
  check("而且整批没跑（第 1 步的导航也没发出去）", /这一批什么都没做/.test(bt), bt.slice(0, 260));
}

console.log("\n\x1b[1m启动时配置坏掉：按最严档起，不回落 full\x1b[0m");
{
  const observeCount = (await listTools({ tools: { profile: "observe" } })).length;
  const startWithRaw = async (text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfg-"));
    fs.writeFileSync(path.join(dir, "config.json"), text);
    const srv = startServer(dir);
    try {
      await srv.rpc("initialize", { protocolVersion: "2024-11-05" });
      return (await srv.rpc("tools/list")).tools;
    } finally {
      srv.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const [why, text] of [
    ["半截 JSON（写到一半 / 磁盘满）", '{"version":1,"tools":{"prof'],
    ["顶层是数组", "[]"],
    ["档位名打错一个字母", '{"version":1,"tools":{"profile":"observ"}}'],
  ]) {
    const tools = await startWithRaw(text);
    check(`启动时${why} → 按最严档（观察）起，不是 full`, tools.length === observeCount, `${tools.length} 个（观察档 ${observeCount}，完全档 ${allTools.length}）`);
    check(`启动时${why} → 工具表里没有 eval/cdp/cookies_export`, ["browser_eval", "browser_cdp", "browser_cookies_export"].every((n) => !tools.some((t) => t.name === n)));
  }
  const good = await listTools({});
  check("配置正常时照旧按用户的设置起（默认 full）", good.length === allTools.length, `${good.length}/${allTools.length}`);
}

console.log("\n\x1b[1m热更新（server 端到端）\x1b[0m");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfg-"));
  const file = path.join(dir, "config.json");
  const srv = startServer(dir);

  const caps = await srv.rpc("initialize", { protocolVersion: "2024-11-05" });
  check("capabilities 声明了 listChanged（不声明客户端根本不会听）", caps.capabilities?.tools?.listChanged === true);

  const before = (await srv.rpc("tools/list")).tools.length;
  cfg.saveSync({ tools: { profile: "observe" } }, file);
  const notified = await srv.waitNotification("notifications/tools/list_changed", 4000);
  check("改配置后发了 tools/list_changed", notified);
  const after = (await srv.rpc("tools/list")).tools.length;
  check("重拉工具表拿到的是新的（不用重启进程）", after < before, `${before} → ${after}`);

  fs.writeFileSync(file, '{"tools": {"prof');
  await new Promise((r) => setTimeout(r, 400));
  const afterBroken = (await srv.rpc("tools/list")).tools.length;
  check("配置写坏之后，保住上一份好的（不回落成全开）", afterBroken === after, `${after} → ${afterBroken}`);

  cfg.saveSync({ tools: { profile: "observe" }, version: 1 }, file);
  const spurious = await srv.waitNotification("notifications/tools/list_changed", 600);
  check("工具集合没变就不发通知", !spurious);

  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mhost 的配置读写通道\x1b[0m");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-host-"));
  const file = path.join(dir, "config.json");
  const HOST = path.join(ROOT, "native-host", "host.mjs");

  const frame = (o) => {
    const body = Buffer.from(JSON.stringify(o), "utf8");
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  };
  const child = spawn(process.execPath, [HOST], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, AGENT_IN_CHROME_SOCK: path.join(dir, "s.sock") },
  });
  const replies = [];
  let hbuf = Buffer.alloc(0);
  child.stdout.on("data", (d) => {
    hbuf = Buffer.concat([hbuf, d]);
    for (;;) {
      if (hbuf.length < 4) return;
      const len = hbuf.readUInt32LE(0);
      if (hbuf.length < 4 + len) return;
      replies.push(JSON.parse(hbuf.subarray(4, 4 + len).toString("utf8")));
      hbuf = hbuf.subarray(4 + len);
    }
  });
  const waitReply = (id, ms = 4000) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        const hit = replies.find((r) => r.type === "config-result" && r.id === id);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(poll, 30);
      };
      poll();
    });

  child.stdin.write(frame({ type: "config-get", id: "g1" }));
  const g1 = await waitReply("g1");
  check("config-get：文件不存在时给默认值", g1?.ok === true && g1.value.tools.profile === "full" && g1.source === "default");

  child.stdin.write(frame({ type: "config-set", id: "s1", patch: { tools: { profile: "readonly" } } }));
  const s1 = await waitReply("s1");
  check("config-set：旧档位名写入成功并按新名回读", s1?.ok === true && s1.value.tools.profile === "observe", JSON.stringify(s1));
  check("落盘的就是配置真源（已迁移成 observe）", JSON.parse(fs.readFileSync(file, "utf8")).tools.profile === "observe");

  cfg.saveSync({ tools: { profile: "observe", disable: ["browser_batch"] } }, file);
  child.stdin.write(frame({ type: "config-set", id: "s2", patch: { tools: { profile: "standard" } } }));
  const s2 = await waitReply("s2");
  check("改档位不抹掉已有的 disable 列表", s2?.ok === true && JSON.stringify(s2.value.tools.disable) === '["browser_batch"]');

  fs.writeFileSync(file, "{ 坏的");
  child.stdin.write(frame({ type: "config-get", id: "g2" }));
  const g2 = await waitReply("g2");
  check("config-get：坏文件如实报 ok:false（弹窗置灰而不是显示假状态）", g2?.ok === false);
  child.stdin.write(frame({ type: "config-set", id: "s3", patch: { tools: { profile: "full" } } }));
  const s3 = await waitReply("s3");
  check("config-set：坏文件以默认值重建并标明 rebuilt", s3?.ok === true && s3.rebuilt === true && s3.value.tools.profile === "full");

  child.stdin.write(frame({ type: "config-set", id: "s4", patch: { tools: { profile: "上帝模式" } } }));
  const s4 = await waitReply("s4");
  check("config-set：无效档位被拒", s4?.ok === false);
  check("拒绝之后文件没被碰", JSON.parse(fs.readFileSync(file, "utf8")).tools.profile === "full");

  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} 通过，${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);
