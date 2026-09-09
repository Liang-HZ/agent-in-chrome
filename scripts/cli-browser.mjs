#!/usr/bin/env node
// CLI/headless 模式的浏览器：起 / 收 / 查 / 自检。
//
// 两种装法各有各的敲法：git 检出跑 `node scripts/cli-browser.mjs …`；npm / npx 装出来的
// 运行时是扁平布局、没有 `scripts/` 目录，走 bin 的子命令
// `npx @liang-hz/agent-in-chrome cli-browser …`（旗标一模一样）。
//
//   （无旗标）  起（已在跑就复用）并自检一遍
//   --headed   有头，想亲眼看它在干什么时用
//   --status   查
//   --stop     收
//
// 平时不用手动跑：MCP server 带 AGENT_IN_CHROME_LAUNCH=1 起来时会自己保证浏览器在。
// 这个脚本的用处是 ① 先把浏览器烘热，省掉每个会话的冷启动 ② 排查连不上
// ③ 跑 e2e——浏览器要在几轮测试之间一直活着。
//
// 起 / 收 / 查都只作用于 `AGENT_IN_CHROME_PROFILE` 指的那一个 profile（默认
// ~/.agent-in-chrome/agent-in-chrome/cli-profile）：记录是按 profile 分开放的，所以 --stop
// 收不到、也绝不会误收别的会话给别的 profile 起的浏览器。

import http from "node:http";

process.env.AGENT_IN_CHROME_KEEP ??= "1";

const {
  ensureBrowser,
  stopBrowserGracefully,
  markAdoptable,
  browserStatus,
  findBrowser,
  HEADLESS,
  PROFILE_DIR,
  USE_PIPE,
} = await import("../mcp/cdp/browser-launch.mjs");
const { Browser } = await import("../mcp/cdp/client.mjs");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has("--status")) {
  const st = browserStatus();
  console.log(JSON.stringify(st, null, 2));
  process.exit(st.running ? 0 : 1);
}

if (has("--stop")) {
  const r = await stopBrowserGracefully();
  const how =
    r.how === "graceful"
      ? "优雅退出"
      : r.how === "signal"
        ? r.expected
          ? "信号收掉（管道传输本来就只能这样收）"
          : "信号收掉（没走成优雅退出）"
        : "";
  console.log(`${r.stopped ? `已收掉（${how}）` : r.how === "none" ? "没有在跑的浏览器" : `没收掉（${how}）`}：${PROFILE_DIR}`);
  if (r.fallbackReason) console.log(`  ${r.expected ? "为什么不走优雅退出" : "优雅退出这条路没走通"}：${r.fallbackReason}`);
  if (!r.stopped && r.how !== "none") {
    console.log(`  pid=${r.pid} 还活着，SIGTERM/SIGKILL 都没收掉它。它占着 ${PROFILE_DIR}，`);
    console.log("  在它退出之前这个 profile 起不了新浏览器——手动确认那个进程是什么再收。");
    process.exit(1);
  }
  process.exit(0);
}

const headless = has("--headed") ? false : HEADLESS;

const { bin, kind, stable } = findBrowser();
console.log(`浏览器  ${kind}${stable ? "" : "（不是正式版，指纹会差一截）"}\n        ${bin}`);

const info = await ensureBrowser({ headless });
console.log(`进程    pid=${info.pid}（${info.adopted ? "复用" : "新起"}）headless=${info.headless}`);
console.log(`版本    ${info.version}`);
console.log(`端点    ${info.wsUrl || `管道（fd3/fd4，pid=${info.pid} 一退它就退）`}`);
console.log(`profile ${info.profileDir}`);
if (USE_PIPE)
  console.log(
    "注意    这次是管道传输（AGENT_IN_CHROME_CDP_TRANSPORT=pipe 压过了默认值）：\n" +
      "        浏览器绑在本进程上，脚本一退它就退——烘热不会留下任何东西，e2e 也接不上。"
  );

const br = await Browser.connect(info.pipe ? { pipe: info.pipe } : info.wsUrl);
const t0 = Date.now();
const { targetId } = await br.client.send("Target.createTarget", { url: "about:blank" });
for (let i = 0; i < 40 && !br.targets.get(targetId)?.sessionId; i++)
  await new Promise((r) => setTimeout(r, 50));
const rec = br.targets.get(targetId);
if (!rec) {
  console.log("\n❌ 新开的标签页没出现在 target 表里（autoAttach 没生效？）");
  process.exit(1);
}

const srv = http.createServer((_q, s) => {
  s.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  s.end("<title>aic-selfcheck</title><h1 id=h>hello</h1>");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const html = `http://127.0.0.1:${srv.address().port}/`;
await br.send(rec, "Page.enable");
await br.send(rec, "Page.navigate", { url: html });
let title = "";
for (let i = 0; i < 60; i++) {
  const r = await br.send(rec, "Runtime.evaluate", {
    expression: "document.title + '|' + (document.getElementById('h')?.textContent || '')",
    returnByValue: true,
  });
  title = r.result?.value || "";
  if (title.startsWith("aic-selfcheck|hello")) break;
  await new Promise((r) => setTimeout(r, 50));
}
const fp = (
  await br.send(rec, "Runtime.evaluate", {
    expression: `(async () => JSON.stringify({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      brands: navigator.userAgentData?.brands,
      fullVersionList: (await navigator.userAgentData?.getHighEntropyValues(["fullVersionList"]))?.fullVersionList,
      languages: navigator.languages,
    }))()`,
    awaitPromise: true,
    returnByValue: true,
  })
).result?.value;
await br.client.send("Target.closeTarget", { targetId });
br.client.close();
srv.close();

const o = JSON.parse(fp);
console.log("\n站点看到的指纹：");
console.log(`  UA         ${o.ua}`);
console.log(`  webdriver  ${o.webdriver}${o.webdriver ? "  ← 必须是 false，见 browser-launch.mjs 里那条 flag" : ""}`);
console.log(`  brands     ${JSON.stringify(o.brands)}`);
console.log(`  版本清单   ${JSON.stringify(o.fullVersionList)}`);
console.log(`  languages  ${JSON.stringify(o.languages)}`);
if (String(o.ua).includes("Headless"))
  console.log(
    "  ↑ UA 里带 Headless —— 真实站点看得见。正常路径上它在**起进程时**就被抹掉了" +
      "（browser-launch.mjs 的 --user-agent），这里还带着说明那道没生效：多半是取有头 UA 的" +
      " `--version` 那次调用失败了。走 MCP 时 shim 会在 attach 时补一层兜底。"
  );

if (title.startsWith("aic-selfcheck|hello")) {
  markAdoptable();
  console.log(`\n✅ 自检通过（${((Date.now() - t0) / 1000).toFixed(1)}s）：开标签页 → 导航 → 读到了页面里的真实内容`);
  process.exit(0);
}
console.log(`\n❌ 自检失败：页面里读回来的是 ${JSON.stringify(title)}`);
process.exit(1);
