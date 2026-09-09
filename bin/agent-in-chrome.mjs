#!/usr/bin/env node
// npx @liang-hz/agent-in-chrome <子命令> —— npm 安装路径的统一入口。
// 子命令：install / check / update / uninstall / serve / help / --version。
// 裸跑（不带参数）打印帮助，不启动 MCP server；要 server 用 serve 子命令。
// git 克隆的用户可以直接 node scripts/install.mjs（--check/--uninstall），
// 两个入口走同一个 run()，行为一致。
// 包名（带 scope）和 bin 名（不带）是两回事：这个文件叫 agent-in-chrome.mjs、
// package.json 的 bin 键是 agent-in-chrome，而 npm 上的包名带 scope。
// 帮助文本里出现的是**包名**，所以从 package.json 的 name 现读，不写死第二份。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0];

const PKG_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PKG = PKG_JSON.name;

const USAGE = `agent-in-chrome — 让 AI agent 操作你已经登录的那个 Chrome

用法：npx ${PKG} <子命令>

子命令：
  install     安装：同步运行时到 ~/.agent-in-chrome、写各浏览器的 native host 清单、
              注册到本机检测到的 agent（Claude Code / Claude Desktop / Codex / Trae /
              Qoder / ZCode / opencode / Kimi / Gemini / WorkBuddy / DeepSeek Harness）。
              旗标：--yes 跳过逐个确认；--agents=claude-code,codex 只注册这些
                    （id 清单以 check 的输出为准）；
                    --no-agents 跳过 agent 注册；
                    --with-crx 自动装载扩展（仅对克隆了仓库的开发者可用，需要签名私钥）
  check       自检：逐项检查装好没有，不改任何东西。末尾多打一行
              「本机 vX · npm 最新 vY · 有/无新版」（查不到就说未能联网检查，不影响退出码）
              旗标：--print-config[=json|toml|claude-cli] 只输出机器可读的 MCP 配置，
                    供还没被自动收录的客户端手工（或让 agent 代劳）配进去
  update      升级本机组件：查 npm 上的最新版，已是最新就什么都不做；有新版就用精确版本号
              拉取并运行新版的安装器。透传 --yes / --agents=… / --no-agents。
              扩展不归它管：商店版自动更新，手动加载的去 chrome://extensions 点刷新
  uninstall   卸载：移除安装写入的一切（agent 配置只摘我们自己的键，改前有备份）
  borrow-login  把指定域的登录态从你自己那个 Chrome 借给 CLI 模式的隔离实例，
                用完还回去。borrow-login --help 看全部旗标
  cli-browser   CLI 模式那个浏览器的起 / 收 / 查：裸跑是「起并自检」，
                另有 --headed / --status / --stop
  serve       以 stdio 方式启动 MCP server（agent 配置里可用 "npx -y ${PKG} serve"
              当命令，不依赖固定安装路径）
  help        显示本帮助
  --version   显示版本

装完还差一步手动的（安装器会打印精确路径）：到 chrome://extensions 加载扩展。不用重启 Chrome。
`;

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(PKG_JSON.version);
} else if (cmd === "update") {
  const { runUpdate } = await import("../mcp/update-cli.mjs");
  const current = PKG_JSON.version;
  process.exitCode = await runUpdate({ current, argv: argv.slice(1) });
} else if (cmd === "install" || cmd === "check" || cmd === "uninstall") {
  const { run, parseFlags } = await import("../scripts/install.mjs");
  const flags = parseFlags(argv.slice(1));
  if (flags.help) {
    console.log(USAGE);
  } else if (flags.unknown.length) {
    console.error(`不认识的旗标：${flags.unknown.join(" ")}\n`);
    console.error(USAGE);
    // 用法错误（旗标/子命令不认识）统一退出码 2，与 scripts/install.mjs 一致；1 留给「跑了但有项没过」
    process.exit(2);
  } else {
    process.exitCode = await run(cmd, flags);
    if (cmd === "check" && !flags.printConfig) {
      const { printVersionLine } = await import("../mcp/update-cli.mjs");
      await printVersionLine({ current: PKG_JSON.version });
    }
  }
} else if (cmd === "borrow-login") {
  // `scripts/` 不在运行时里（安装器只把 mcp/ 下的模块摊到 ~/.agent-in-chrome/…，是扁平布局），
  // 所以 npm / npx 装的用户没有 `node scripts/borrow-login.mjs` 可敲——这个子命令就是他们的入口。
  // 包里 `scripts/` 与 `mcp/` 的相对位置和仓库里一样，脚本对 `../mcp/cdp/browser-launch.mjs`
  // 的 import 在这里照常解析得到。
  const { runBorrowLogin } = await import("../scripts/borrow-login.mjs");
  process.exitCode = await runBorrowLogin(argv.slice(1));
} else if (cmd === "cli-browser") {
  // 同上，CLI 模式那个浏览器的起 / 收 / 查也给一条 npm 用户敲得动的命令。
  process.argv = [process.argv[0], path.join(ROOT, "scripts", "cli-browser.mjs"), ...argv.slice(1)];
  await import("../scripts/cli-browser.mjs");
} else if (cmd === "serve") {
  // server.mjs 在 import 时就开始服务（读 stdin、起桥接），import 即启动
  await import("../mcp/server.mjs");
} else if (cmd === undefined || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(USAGE);
} else {
  console.error(`不认识的子命令：${cmd}\n`);
  console.error(USAGE);
  process.exit(2);
}
