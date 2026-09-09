#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import zlib from "node:zlib";

import {
  bundleName,
  bundleMatch,
  plainName,
  binShimName,
  isDshClient,
  decodeZstdFrames,
  readDshSession,
  antigravityDataDir,
  antigravityConversationId,
  readAntigravityWorkspace,
  readSessionIdentity,
  hasTty,
  walkSurface,
  resolveClientPid,
  readWorkspace,
  readClientSessionFile,
  readHostSessionTitle,
  readWorkbuddySessionTitle,
  informativeName,
  composeAgent,
  probeLocal,
  readSessionTitle,
  readZcodeSessionTitle,
  zcodeDataDir,
  traeDataDir,
  userDataDirFrom,
  readTraeSessionTitle,
  resetTitleMemo,
  readClaudeSubagent,
  resetSubagentMemo,
  procSource,
  exePathOf,
} from "../mcp/agent-identity.mjs";
import { isLauncherFor } from "../mcp/session-id.mjs";
import { makeWinProcSource } from "../mcp/proc-win.mjs";

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

const CHAINS = {
  claudeDesktop: new Map([
    [900, { ppid: 901, tty: "??", command: "/Users/u/.nvm/versions/node/v24.11.1/bin/node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [901, { ppid: 902, tty: "??", command: "/Applications/Claude.app/Contents/Helpers/disclaimer /Users/u/.agent-in-chrome/agent-in-chrome/mcp-launcher.sh" }],
    [902, { ppid: 1, tty: "??", command: "/Applications/Claude.app/Contents/MacOS/Claude" }],
  ]),
  claudeCodeDesktop: new Map([
    [910, { ppid: 911, tty: "??", command: "node /Users/u/OpenSource/agent-in-chrome/mcp/server.mjs" }],
    [911, { ppid: 912, tty: "??", command: `/Users/u/Library/Application Support/Claude/claude-code/2.1.227/claude.app/Contents/MacOS/claude --output-format stream-json --mcp-config {"mcpServers":{"agent-in-chrome":{"command":"node","args":["/Users/u/.agent-in-chrome/agent-in-chrome/server.mjs"]}}}` }],
    [912, { ppid: 1, tty: "??", command: "/Applications/Claude.app/Contents/MacOS/Claude" }],
  ]),
  cli: new Map([
    [920, { ppid: 921, tty: "??", command: "node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [921, { ppid: 922, tty: "ttys001", command: "/Users/u/.local/bin/claude" }],
    [922, { ppid: 923, tty: "ttys001", command: "-/bin/zsh" }],
    [923, { ppid: 1, tty: "??", command: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
  ]),
  zcode: new Map([
    [930, { ppid: 931, tty: "??", command: "/Users/u/.nvm/versions/node/v24.11.1/bin/node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [931, { ppid: 932, tty: "??", command: "zcode-cli" }],
    [932, { ppid: 933, tty: "??", command: "zcode-host-local-1" }],
    [933, { ppid: 1, tty: "??", command: "ZCode" }],
  ]),
  qoder: new Map([
    [940, { ppid: 941, tty: "??", command: "/Users/u/.nvm/versions/node/v24.11.1/bin/node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [941, { ppid: 942, tty: "??", command: "/Applications/Qoder CN.app/Contents/Resources/app/resources/bin/aarch64_darwin/QoderCN start --workDir /Users/u/Library" }],
    [942, { ppid: 1, tty: "??", command: "/Applications/Qoder CN.app/Contents/MacOS/Electron" }],
  ]),
  trae: new Map([
    [960, { ppid: 961, tty: "??", command: "/Users/u/.nvm/versions/node/v24.11.1/bin/node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [961, { ppid: 962, tty: "??", command: "/Applications/Trae CN.app/Contents/Frameworks/Trae CN Helper (Plugin).app/Contents/MacOS/Trae CN Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService" }],
    [962, { ppid: 1, tty: "??", command: "/Applications/Trae CN.app/Contents/MacOS/Electron" }],
  ]),
  workbuddy: new Map([
    [970, { ppid: 971, tty: "??", command: "/Users/u/.nvm/versions/node/v24.11.1/bin/node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [971, { ppid: 1, tty: "??", command: "/Applications/WorkBuddy.app/Contents/MacOS/Electron /Applications/WorkBuddy.app/Contents/Resources/app.asar/main/daemon-app-server-entry.js --stdio" }],
  ]),
};

const SELF = "/Users/u/.agent-in-chrome/agent-in-chrome/server.mjs";

console.log("\n\x1b[1m形态与品牌：认父进程链上的证据\x1b[0m");
{
  const walk = (chain, serverPid) => {
    const snap = CHAINS[chain];
    return walkSurface(resolveClientPid(snap.get(serverPid).ppid, snap, SELF), snap, {});
  };

  const d = walk("claudeDesktop", 900);
  check("Claude 桌面端：跳过一次性启动器，认到 Claude.app", d.surface === "app" && d.brand === "Claude", JSON.stringify(d));

  const cc = walk("claudeCodeDesktop", 910);
  check("桌面端里的 Claude Code：是桌面端形态", cc.surface === "app", JSON.stringify(cc));
  check(
    "引擎 argv 里嵌着我们的路径也不算启动器：锚点停在引擎上",
    resolveClientPid(911, CHAINS.claudeCodeDesktop, SELF) === 911,
    String(resolveClientPid(911, CHAINS.claudeCodeDesktop, SELF))
  );
  check(
    "旧连接器的 disclaimer 层照旧跳过",
    resolveClientPid(901, CHAINS.claudeDesktop, SELF) === 902,
    String(resolveClientPid(901, CHAINS.claudeDesktop, SELF))
  );

  const c = walk("cli", 920);
  check("终端里的 CLI：撞见 tty 就判 CLI，不再往上走到 iTerm.app", c.surface === "cli", JSON.stringify(c));

  const z = walk("zcode", 930);
  check("ZCode：一路到 launchd 都没终端 = 桌面端，argv0 当品牌", z.surface === "app" && z.brand === "ZCode", JSON.stringify(z));

  const q = walk("qoder", 940);
  check("Qoder：认 .app 包名而不是可执行文件名 Electron", q.surface === "app" && q.brand === "Qoder CN", JSON.stringify(q));
  check("认出 .app 包时连包路径一起给（版本号要从它的 Info.plist 读）", q.appDir === "/Applications/Qoder CN.app", JSON.stringify(q));

  const t = walk("trae", 960);
  check("Trae（VS Code 系）：extensionHost 往上认到 Trae CN.app", t.surface === "app" && t.brand === "Trae CN", JSON.stringify(t));

  const w = walk("workbuddy", 970);
  check("WorkBuddy：Electron 主进程直接 spawn，认包名", w.surface === "app" && w.brand === "WorkBuddy", JSON.stringify(w));

  const none = walkSurface(950, new Map(), {});
  check("查不到进程就报没有形态，不猜", none.surface === null && none.brand === null, JSON.stringify(none));
}

console.log("\n\x1b[1m包名与裸名字\x1b[0m");
{
  check("包名带空格也认得出", bundleName("/Applications/Qoder CN.app/Contents/MacOS/Electron") === "Qoder CN");
  check("参数里出现的包路径不算数", bundleName("/usr/bin/open -a /Applications/Claude.app/Contents/MacOS/Claude") === null);
  check("相对路径不算数（认不出是不是本进程自己）", bundleName("Claude.app/Contents/MacOS/Claude") === null);
  check("运行时的名字不当品牌", plainName("node /x/y.mjs") === null && plainName("/usr/bin/python3 -m x") === null);
  check("改过 argv0 的 GUI 进程当品牌", plainName("ZCode") === "ZCode");
  check("ps 的 ?? 不算终端", !hasTty("??") && !hasTty("") && hasTty("ttys001"));
}

console.log("\n\x1b[1m工作区：先 git 仓库名，再目录名\x1b[0m");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-ident-"));
  const repo = path.join(tmp, "my-repo");
  fs.mkdirSync(path.join(repo, "mcp"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  const plain = path.join(tmp, "just-a-dir");
  fs.mkdirSync(plain);

  check("仓库里的子目录报的是仓库名", JSON.stringify(readWorkspace(path.join(repo, "mcp"), { tmp: "/nope" })) === JSON.stringify({ name: "my-repo", kind: "git" }));
  check("没有 git 就报目录名", JSON.stringify(readWorkspace(plain, { tmp: "/nope" })) === JSON.stringify({ name: "just-a-dir", kind: "dir" }));
  check("cwd 是 / 的（桌面端就这么拉起 server）没有工作区", readWorkspace("/", { tmp: "/nope" }) === null);
  check("cwd 就是家目录也不算工作区", readWorkspace(tmp, { home: tmp, tmp: "/nope" }) === null);

  const wt = path.join(tmp, "wt-branch");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt-branch\n");
  check("worktree 的 .git 是文件，照样认得出", readWorkspace(wt, { tmp: "/nope" })?.kind === "git" && readWorkspace(wt, { tmp: "/nope" })?.name === "wt-branch");

  const hiddenWt = path.join(repo, ".claude", "worktrees", "agent-a2edbaa72");
  fs.mkdirSync(hiddenWt, { recursive: true });
  fs.writeFileSync(path.join(hiddenWt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "agent-a2edbaa72")}\n`);
  check(
    "隐藏目录下的 worktree 照样认得出（.claude/worktrees 就是这形状）",
    JSON.stringify(readWorkspace(hiddenWt, { tmp: "/nope" })) === JSON.stringify({ name: "agent-a2edbaa72", kind: "git" })
  );

  const sub = path.join(repo, "vendor", "libfoo");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/libfoo\n");
  check(
    "子模块检出报的是子模块自己的目录名，不是超级仓库",
    JSON.stringify(readWorkspace(sub, { tmp: "/nope" })) === JSON.stringify({ name: "libfoo", kind: "git" })
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n\x1b[1m会话标题：客户端写在磁盘上的那份\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-home-"));
  const sessions = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "7001.json"),
    JSON.stringify({ pid: 7001, sessionId: "abc", cwd: "/tmp/x", entrypoint: "cli", name: "agent-in-chrome-07", nameSource: "derived" })
  );
  fs.writeFileSync(path.join(sessions, "7002.json"), JSON.stringify({ pid: 9999, cwd: "/tmp/y", entrypoint: "cli" }));

  check("读得到客户端的会话记录", readClientSessionFile(7001, { home })?.entrypoint === "cli");
  check("pid 对不上的残留文件当没有", readClientSessionFile(7002, { home }) === null);
  check("凑出来的会话名（derived）不当标题——它跟工作区那段重复", readSessionTitle({ clientPid: 7001, hostSessionId: null }, { home }) === null);

  fs.writeFileSync(
    path.join(sessions, "7003.json"),
    JSON.stringify({ pid: 7003, cwd: "/tmp/z", entrypoint: "cli", name: "查竞品定价", nameSource: "auto" })
  );
  check("不是凑出来的会话名就当标题", readSessionTitle({ clientPid: 7003, hostSessionId: null }, { home }) === "查竞品定价");

  const hostDir = path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "org1", "user1");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, "local_abc-123.json"), JSON.stringify({ title: "修 sid 漂移与组认领", titleSource: "auto" }));
  check("宿主管的标题读得到（逐级列目录找到那两层）", readHostSessionTitle("local_abc-123", { home }) === "修 sid 漂移与组认领");
  check("没有这个会话 id 就是没有", readHostSessionTitle("local_nope", { home }) === null);
  check("会话 id 里有路径分隔符一律不认（别人给的字符串，不许拼进路径）", readHostSessionTitle("../../etc/passwd", { home }) === null);
  check("宿主的标题优先于客户端记的会话名", readSessionTitle({ clientPid: 7003, hostSessionId: "local_abc-123" }, { home }) === "修 sid 漂移与组认领");

  const late = path.join(hostDir, "local_late.json");
  check("标题还没生成时就是没有", readSessionTitle({ clientPid: 0, hostSessionId: "local_late" }, { home }) === null);
  fs.writeFileSync(late, JSON.stringify({ title: "后来才有的标题" }));
  check("标题后来出现了要能读到（所以不能只在握手时读一次）", readSessionTitle({ clientPid: 0, hostSessionId: "local_late" }, { home }) === "后来才有的标题");

  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1mWorkBuddy 的会话标题：活着的对话恰好一个才归属\x1b[0m");
{
  const wb = fs.mkdtempSync(path.join(os.tmpdir(), "aic-wb-"));
  fs.mkdirSync(path.join(wb, "sessions"));
  const put = (pid, extra) => fs.writeFileSync(path.join(wb, "sessions", `${pid}.json`), JSON.stringify({ pid, ...extra }));
  put(7100, { kind: "interactive", sessionId: "649aa100-f37d-4bff-b8db-7518eef9a95d" });
  put(7101, { kind: "interactive", sessionId: "interactive-7101" });
  put(7102, { kind: "prewarm", sessionId: "0f179b98-cf6a-4c42-a9e5-02766f6d131f" });
  put(7103, { kind: "interactive", sessionId: "0f179b98-cf6a-4c42-a9e5-02766f6d131f" });

  const env = { WORKBUDDY_CONFIG_DIR: wb };
  let asked = null;
  const fakeExec = (bin, args) => {
    asked = { bin, sql: args[args.length - 1] };
    return "查竞品定价\n";
  };

  const one = readWorkbuddySessionTitle({ env, exec: fakeExec, alive: (p) => p === 7100 });
  check("恰好一个活着的对话：读它的标题", one === "查竞品定价", JSON.stringify(one));
  check("查库带的是那段对话的 uuid（先验过形状才拼 SQL）", /649aa100-f37d-4bff-b8db-7518eef9a95d/.test(asked?.sql || ""), asked?.sql);
  check("CLI host / prewarm 的假会话不算对话", one === "查竞品定价");
  check("两段对话都活着：分不出是谁，不猜", readWorkbuddySessionTitle({ env, exec: fakeExec, alive: () => true }) === null);
  check("对话都结束了就是没有", readWorkbuddySessionTitle({ env, exec: fakeExec, alive: () => false }) === null);
  check("没有 WORKBUDDY_CONFIG_DIR（别家客户端）一律 null", readWorkbuddySessionTitle({ env: {}, exec: fakeExec }) === null);
  check("库读不动就不显示，不许编", readWorkbuddySessionTitle({ env, exec: () => { throw new Error("no db"); }, alive: (p) => p === 7100 }) === null);
  {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), "aic-wb-evil-"));
    fs.mkdirSync(path.join(evil, "sessions"));
    fs.writeFileSync(path.join(evil, "sessions", "8000.json"),
      JSON.stringify({ pid: 8000, kind: "interactive", sessionId: "1' or '1'='1" }));
    check("带引号的 sessionId 不进 SQL（正则先挡）",
      readWorkbuddySessionTitle({ env: { WORKBUDDY_CONFIG_DIR: evil }, exec: () => { throw new Error("绝不该拿注入载荷查库"); }, alive: () => true }) === null);
    fs.rmSync(evil, { recursive: true, force: true });
  }

  const t = readSessionTitle({ clientPid: 0, hostSessionId: null }, { home: wb, env, exec: fakeExec, alive: (p) => p === 7100 });
  check("readSessionTitle 兜到 WorkBuddy 这条来源", t === "查竞品定价", JSON.stringify(t));

  fs.rmSync(wb, { recursive: true, force: true });
}

console.log("\n\x1b[1m拼出显示用的那个对象\x1b[0m");
{
  const local = { brandFallback: "Claude", surface: "app", workspace: "agent-in-chrome", workspaceKind: "git" };

  const a = composeAgent({ name: "claude-code", title: "Claude Code", version: "2.1.227" }, local, "修 sid 漂移");
  check("有 title 就用 title 当品牌", a.brand === "Claude Code", JSON.stringify(a));
  check("四段齐了", a.surface === "app" && a.workspace === "agent-in-chrome" && a.session === "修 sid 漂移", JSON.stringify(a));
  check("客户端自报的原文照旧带上（tooltip 要用）", a.name === "claude-code" && a.version === "2.1.227", JSON.stringify(a));

  const b = composeAgent({ name: "local-agent-mode-agent-in-chrome", title: null, version: "1.0.0" }, local, null);
  check("local-agent-mode-* 不当品牌，退回父进程链认到的", b.brand === "Claude", JSON.stringify(b));
  check("但原文还在，tooltip 里说得清为什么", b.name === "local-agent-mode-agent-in-chrome", JSON.stringify(b));
  check("认不出品牌就不显示品牌（不猜）", informativeName("local-agent-mode-x") === null && informativeName("cursor-vscode") === "cursor-vscode");

  const c = composeAgent(null, { surface: "cli", workspace: "myapp", workspaceKind: "dir" }, null);
  check("客户端不报家门时，本机取证的那几段照样有", c.surface === "cli" && c.workspace === "myapp", JSON.stringify(c));
  check("不报家门就不许编品牌名", c.brand === null && c.name === null && c.title === null, JSON.stringify(c));

  check("一段证据都没有就返回 null（帧里连 agent 键都不加）", composeAgent(null, null, null) === null);
  check("过长的字段一律截断", composeAgent({ name: "x".repeat(80) }, null, "y".repeat(200)).session.length === 60);
}

console.log("\n\x1b[1m品牌优先级与版本同源（Qoder/Trae/WorkBuddy 的真机实样）\x1b[0m");
{
  const fakeExec = (bin, args) => {
    const known = { "/Applications/Qoder CN.app/Contents/Info.plist": "1.23.0\n", "/Applications/Trae CN.app/Contents/Info.plist": "3.3.83\n" };
    const out = known[String(args[args.length - 1]).split(path.sep).join("/")];
    if (!out) throw new Error("no plist");
    return out;
  };

  const qoderLocal = { brandFallback: "Qoder CN", brandAppDir: "/Applications/Qoder CN.app", surface: "app" };
  const q = composeAgent({ name: "mcphost", title: null, version: "0.1.0" }, qoderLocal, null, { exec: fakeExec });
  check("没报 title 时，父进程链认到的包名压过中间件的 name", q.brand === "Qoder CN", JSON.stringify(q));
  check("品牌来自 .app 包时，版本读包的 Info.plist，不拿中间件的 0.1.0", q.version === "1.23.0", JSON.stringify(q));
  check("中间件自报的原文照旧带上（tooltip 排查用）", q.name === "mcphost", JSON.stringify(q));

  const traeLocal = { brandFallback: "Trae CN", brandAppDir: "/Applications/Trae CN.app", surface: "app" };
  const t = composeAgent({ name: "Trae", title: null, version: "1.107.1" }, traeLocal, null, { exec: fakeExec });
  check("Trae：品牌与版本都来自主包（3.3.83，不是 VS Code 的 1.107.1）", t.brand === "Trae CN" && t.version === "3.3.83", JSON.stringify(t));

  const wbLocal = { brandFallback: "WorkBuddy", brandAppDir: "/Applications/WorkBuddy.app", surface: "app" };
  const w = composeAgent({ name: "connector:custom-mcp:agent-in-chrome", title: null, version: "1.0.0" }, wbLocal, null, { exec: fakeExec });
  check("WorkBuddy：品牌是包名；包版本读不到就不显示，不许拿代理的 1.0.0 顶上", w.brand === "WorkBuddy" && w.version === null, JSON.stringify(w));
  check("带冒号的命名空间串判为不含身份", informativeName("connector:custom-mcp:x") === null);

  const cli = composeAgent({ name: "mcphost", title: null, version: "0.1.0" }, { brandFallback: null, surface: "cli" }, null, { exec: fakeExec });
  check("裸 CLI 场景 name 照常显示，版本同源", cli.brand === "mcphost" && cli.version === "0.1.0", JSON.stringify(cli));

  const z = composeAgent({ name: "zc-mw", title: null, version: "9.9.9" }, { brandFallback: "ZCode", brandAppDir: null, surface: "app" }, null, { exec: fakeExec });
  check("品牌来自裸进程名时不显示版本（不许拿中间件的错配）", z.brand === "ZCode" && z.version === null, JSON.stringify(z));

  const cc = composeAgent({ name: "claude-code", title: "Claude Code", version: "2.1.227" }, { brandFallback: "claude", brandAppDir: "/x/claude.app", surface: "app" }, null, { exec: fakeExec });
  check("有 title 时照旧 title + clientInfo.version", cc.brand === "Claude Code" && cc.version === "2.1.227", JSON.stringify(cc));

  check("嵌套包认最外层：Helper (Plugin) 不是品牌", JSON.stringify(bundleMatch("/Applications/Trae CN.app/Contents/Frameworks/Trae CN Helper (Plugin).app/Contents/MacOS/Trae CN Helper (Plugin)")) === JSON.stringify({ name: "Trae CN", appDir: "/Applications/Trae CN.app" }));
}

console.log("\n\x1b[1m工作区的噪音过滤：客户端的管道工程不是项目\x1b[0m");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-noise-"));
  const home = path.join(tmp, "home");
  const plumbing = path.join(home, ".workbuddy", "logs", "mcp-runtime", "custom-mcp_agent-in-chrome-0b59ed7c");
  fs.mkdirSync(plumbing, { recursive: true });
  check("隐藏目录下的 cwd 不算工作区", readWorkspace(plumbing, { home, tmp: "/nope" }) === null);
  const proj = path.join(home, "work", "shop-api");
  fs.mkdirSync(proj, { recursive: true });
  check("正常目录不受影响", readWorkspace(proj, { home, tmp: "/nope" })?.name === "shop-api");
  check("临时目录下的 cwd 不算工作区", readWorkspace(path.join(tmp, "spawn-here"), { home, tmp }) === null);

  const realRepo = path.join(home, "work", "shop-web");
  fs.mkdirSync(path.join(realRepo, ".git"), { recursive: true });
  const deep = path.join(realRepo, ".venv", "lib", "python3.11", "site-packages");
  fs.mkdirSync(deep, { recursive: true });
  check(
    "cwd 埋在仓库的点目录里时报的是仓库，不是 null",
    JSON.stringify(readWorkspace(deep, { home, tmp: "/nope" })) === JSON.stringify({ name: "shop-web", kind: "git" })
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n\x1b[1m整条取证路：注进假进程表跑一遍\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-home2-"));
  const repo = path.join(home, "work", "shop-api");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const sessions = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "911.json"),
    JSON.stringify({ pid: 911, cwd: repo, entrypoint: "claude-desktop", name: "shop-api-3f", nameSource: "derived" })
  );

  const local = probeLocal({
    env: { CLAUDE_CODE_HOST_SESSION_ID: "local_zzz" },
    cwd: "/",
    ppid: 911,
    self: SELF,
    snap: CHAINS.claudeCodeDesktop,
    home,
    tmp: "/nope",
  });
  check("工作区来自客户端记的 cwd，不是它 spawn 我们时给的那个", local.workspace === "shop-api" && local.workspaceKind === "git", JSON.stringify(local));
  check("形态认出来是桌面端", local.surface === "app", JSON.stringify(local));

  fs.writeFileSync(path.join(sessions, "911.json"), JSON.stringify({ pid: 911, cwd: repo, entrypoint: "cli" }));
  const local2 = probeLocal({ env: {}, cwd: "/", ppid: 911, self: SELF, snap: CHAINS.claudeCodeDesktop, home, tmp: "/nope" });
  check("客户端自报 entrypoint=cli 时按 CLI 算", local2.surface === "cli", JSON.stringify(local2));

  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1mZCode 的会话标题：_meta.session_id 精确归属\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-zc-"));
  fs.mkdirSync(path.join(home, ".zcode", "cli", "db"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "cli", "db", "db.sqlite"), "");
  const SID = "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4";
  let asked = null;
  const fakeExec = (bin, args) => {
    asked = { bin, sql: args[args.length - 1] };
    return "接管浏览器标签组并打开谷歌搜索\n";
  };
  const at = (meta, exec = fakeExec) => {
    resetTitleMemo();
    return readZcodeSessionTitle(meta, { home, exec, env: {} });
  };

  check("主会话：按 _meta.session_id 读它自己的标题", at({ session_id: SID, runtime_scope: "main" }) === "接管浏览器标签组并打开谷歌搜索");
  check("查的是 session 表、只认 generated/custom", /from session where id='sess_0a33b40d/.test(asked?.sql || "") && /title_source in \('generated','custom'\)/.test(asked?.sql || ""), asked?.sql);
  check("走的是系统自带 sqlite3 的只读模式", asked?.bin === "/usr/bin/sqlite3");
  check("没给 runtime_scope 也认（老版本客户端）", at({ session_id: SID }) === "接管浏览器标签组并打开谷歌搜索");
  const SUB = "sess_subagent_agent_a1100314-0000-4000-8000-000000000000";
  check("subagent 的调用报的是主会话的名字", at({ session_id: SUB, runtime_scope: "subagent" }) === "接管浏览器标签组并打开谷歌搜索");
  check(
    "subagent 走的是 parent_id 那一跳，不读它自己那行的 first_input",
    /where id=\(select parent_id from session where id='sess_subagent_agent_a1100314/.test(asked?.sql || "") &&
      /title_source in \('generated','custom'\)/.test(asked?.sql || ""),
    asked?.sql
  );
  check(
    "subagent 的 id 形状也要卡死（它同样直接拼进 SQL）",
    readZcodeSessionTitle(
      { session_id: "sess_subagent_agent_a1100314-0000-4000-8000-000000000000' or '1'='1" },
      { home, env: {}, exec: () => { throw new Error("绝不该拿注入载荷去查库"); } }
    ) === null
  );
  check("形状不对的 id 一律不拼进 SQL", at({ session_id: "sess_'; drop table session; --" }) === null);
  for (const bad of [
    "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4'",
    "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4' or '1'='1",
    "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4'--",
    "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4 union select 1",
    "sess_0a33b40d%2d8caa",
  ]) {
    check(`注入载荷被正则拦下，绝不起 sqlite3：${bad.slice(30) || bad}`,
      readZcodeSessionTitle({ session_id: bad }, { home, env: {}, exec: () => { throw new Error("绝不该拿注入载荷去查库"); } }) === null);
  }
  check("别家客户端的 _meta（没有 session_id）不认", at({ progressToken: 1 }) === null);
  check("没有 _meta 也不能抛", at(null) === null && at(undefined) === null);
  check("库读不动就不显示，不许编", at({ session_id: SID }, () => { throw new Error("locked"); }) === null);
  check("标题还没生成（查出来是空）就是没有", at({ session_id: SID }, () => "\n") === null);

  resetTitleMemo();
  let calls = 0;
  const counting = () => { calls++; return "标题\n"; };
  readZcodeSessionTitle({ session_id: SID }, { home, env: {}, exec: counting });
  readZcodeSessionTitle({ session_id: SID }, { home, env: {}, exec: counting });
  readZcodeSessionTitle({ session_id: SID }, { home, env: {}, exec: counting });
  check("查到过的标题记住，不再重复起 sqlite3", calls === 1, `起了 ${calls} 次`);

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "aic-zc0-"));
  check("本机没装 ZCode 就直接不查", readZcodeSessionTitle({ session_id: SID }, { home: bare, env: {}, exec: () => { throw new Error("不该被调用"); } }) === null);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
}

console.log("\n\x1b[1m数据目录：先问客户端自己（--user-data-dir），再退到包里的 product.json\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-dd-"));
  const apps = path.join(home, "Applications");
  const mkApp = (bundleName, product, dataName) => {
    const b = path.join(apps, `${bundleName}.app`);
    fs.mkdirSync(path.join(b, "Contents", "Resources", "app"), { recursive: true });
    fs.writeFileSync(path.join(b, "Contents", "Resources", "app", "product.json"), JSON.stringify(product));
    if (dataName) fs.mkdirSync(path.join(home, "Library", "Application Support", dataName, "logs"), { recursive: true });
    return b;
  };
  const cn = mkApp("Trae CN", { applicationName: "trae-cn", nameLong: "Trae CN" }, "Trae CN");
  const intl = mkApp("Trae", { applicationName: "trae", nameLong: "Trae" }, "Trae");
  const qoder = mkApp("Qoder CN", { applicationName: "qoder-cn", nameLong: "Qoder CN" }, "Qoder CN");
  const fresh = mkApp("Trae Fresh", { applicationName: "trae", nameLong: "Trae Fresh" }, null);
  const renamed = mkApp("我的Trae", { applicationName: "trae-cn", nameLong: "Trae CN" }, "Trae CN");

  const at = (o) => traeDataDir({ home, env: {}, ...o });

  {
    const DATA = path.join(home, "Library", "Application Support", "Trae CN");
    const snapOf = (m) => ({ get: (pid) => m[pid] || null });
    const helper = `/Applications/Trae CN.app/Contents/Frameworks/Trae CN Helper (Plugin).app/Contents/MacOS/Trae CN Helper (Plugin) --type=utility --user-data-dir=${DATA} --standard-schemes=vscode-webview --enable-sandbox`;
    const snap = snapOf({
      100: { ppid: 101, tty: "??", command: "node /x/server.mjs" },
      101: { ppid: 102, tty: "??", command: helper },
      102: { ppid: 1, tty: "??", command: "/Applications/Trae CN.app/Contents/MacOS/Electron" },
    });
    check("从进程链上取到 --user-data-dir（路径里有空格也要完整）", userDataDirFrom(100, snap, { fs }) === DATA);
    check("它就是数据目录，不用再去 /Applications 推", at({ userDataDir: userDataDirFrom(100, snap, { fs }) }) === DATA);
    const tail = snapOf({ 100: { ppid: 1, tty: "??", command: `/x/Electron --type=utility --user-data-dir=${DATA}` } });
    check("--user-data-dir 在行尾也切得对", userDataDirFrom(100, tail, { fs }) === DATA);
    const bad = snapOf({ 100: { ppid: 1, tty: "??", command: "/x/Electron --user-data-dir=/tmp/根本没有这个目录 --foo" } });
    check("写了开关但值对不上真实目录 → null（不半路猜）", userDataDirFrom(100, bad, { fs }) === null);
    const rel = snapOf({ 100: { ppid: 1, tty: "??", command: "/x/Electron --user-data-dir=relative/path --foo" } });
    check("非绝对路径不认", userDataDirFrom(100, rel, { fs }) === null);
    check("链上没这个开关就是 null", userDataDirFrom(100, snapOf({ 100: { ppid: 1, tty: "??", command: "/x/zcode-cli" } }), { fs }) === null);
    check("ps 不可用（snap 全空）不抛", userDataDirFrom(100, snapOf({}), { fs }) === null);
    check(
      "有 --user-data-dir 时优先于按包推（包指向另一家也不受影响）",
      traeDataDir({ home, env: {}, userDataDir: DATA, appDir: qoder }) === DATA
    );
  }
  check("按包里的 product.json 算出数据目录", at({ appDir: cn }) === path.join(home, "Library", "Application Support", "Trae CN"));
  check("国际版算到国际版那个目录", at({ appDir: intl }) === path.join(home, "Library", "Application Support", "Trae"));
  check("别家的 VS Code 分支（有 product.json）不许当成 Trae", at({ appDir: qoder }) === null);
  check("包名被用户改过也认得（认 product.json，不认文件名）", at({ appDir: renamed }) === path.join(home, "Library", "Application Support", "Trae CN"));
  check("算出来的目录不存在就是没有（不许退回去猜别的）", at({ appDir: fresh }) === null);
  check("不是 .app、或者根本没有包 → null", at({ appDir: "/tmp/x" }) === null && at({}) === null);
  check("没有 product.json 的包（不是 VS Code 系）→ null", at({ appDir: path.join(apps, "无此.app") }) === null);
  check(
    "ps 不可用时退回我们自己 env 里的 RG_PATH（Trae spawn 时带的）",
    at({ env: { RG_PATH: path.join(cn, "Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg") } }) ===
      path.join(home, "Library", "Application Support", "Trae CN")
  );
  check("RG_PATH 指向别家的包也不认", at({ env: { RG_PATH: path.join(qoder, "Contents/Resources/app/x/rg") } }) === null);
  check(
    "进程链认到的是别家的包时，不就此放弃，还有 env 里的 RG_PATH 这条独立证据",
    at({ appDir: qoder, env: { RG_PATH: path.join(cn, "Contents/Resources/app/x/rg") } }) ===
      path.join(home, "Library", "Application Support", "Trae CN")
  );
  check("两条证据都不指向 Trae 就是 null", at({ appDir: qoder, env: { RG_PATH: path.join(qoder, "x/rg") } }) === null);
  check("nameLong 里带路径分隔符不许拼进路径", at({ appDir: mkApp("坏", { applicationName: "trae", nameLong: "../../../etc" }, null) }) === null);

  check("ZCode 默认是 $HOME/.zcode", zcodeDataDir({ env: {}, home }) === path.join(home, ".zcode"));
  check("ZCode 认 ZCODE_DATA_BASE_DIR 覆盖（写死路径会读到另一个安装的库）", zcodeDataDir({ env: { ZCODE_DATA_BASE_DIR: "/tmp/zz" }, home }) === path.join("/tmp/zz", ".zcode"));
  check("ZCODE_DATA_BASE_DIR 是空白串时按没设算", zcodeDataDir({ env: { ZCODE_DATA_BASE_DIR: "   " }, home }) === path.join(home, ".zcode"));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1mTrae 的会话标题：chatSessionId 自己说了该去哪个文件的哪一段找\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-trae-"));
  const AT = (iso) => Date.parse(iso);
  const objectId = (ms, tail) => Math.floor(ms / 1000).toString(16).padStart(8, "0") + tail;
  const RUN1 = AT("2026-08-13T15:10:39+08:00");
  const RUN2 = AT("2026-08-13T16:56:56+08:00");
  const A_AT = AT("2026-08-13T17:00:00+08:00");
  const B_AT = AT("2026-08-13T15:13:37+08:00");
  const ID_A = objectId(A_AT, "8dd5dc6e3bd60c6c");
  const ID_B = objectId(B_AT, "8dd5dc6e3bd60be4");

  const stamp = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const at = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace("Z", "+08:00");
  const noise = (ms, n, step = 10) => Array.from({ length: n }, (_, i) => `${at(ms + i * step)}  INFO 无关的日志行 ${"x".repeat(200)}`).join("\n") + "\n";
  const titleLine = (ms, id, t) =>
    `${at(ms)}  INFO generate_session_title_and_icon: ai_agent::domain::chat::service: ` +
    `rust: generate_session_title_and_icon_cloud: session_id: "${id}", title: "${t}", icon: "personal"\n`;
  const DATA = path.join(home, "Library", "Application Support", "Trae CN");
  const OTHER = path.join(home, "Library", "Application Support", "Trae");
  const mk = (dataDir, runMs, body) => {
    const d = path.join(dataDir, "logs", stamp(runMs), "Modular");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `ai-agent_0_${runMs}_stdout.log`), body);
  };
  mk(DATA, RUN1, noise(RUN1, 8000, Math.floor((B_AT - RUN1) / 8000)) + titleLine(B_AT + 5000, ID_B, "第一次生成的") + titleLine(B_AT + 9000, ID_B, "查询杭州天气") + noise(B_AT + 10000, 4000));
  mk(DATA, RUN2, noise(RUN2, 500) + titleLine(A_AT + 37000, ID_A, "查询杭州天气及预警") + noise(A_AT + 40000, 200));
  mk(OTHER, AT("2026-08-13T16:00:00+08:00"), titleLine(A_AT + 37000, ID_A, "串到国际版去了"));

  const read = (meta, dataDir = DATA) => {
    resetTitleMemo();
    return readTraeSessionTitle(meta, { dataDir });
  };

  check("按 chatSessionId 读到标题", read({ chatSessionId: ID_A, isCurrentSession: true }) === "查询杭州天气及预警");
  check("同一会话被生成多次时取最后一条", read({ chatSessionId: ID_B }) === "查询杭州天气");
  check("会话落在哪次运行是算出来的：B 在 run1，不去 run2 找", read({ chatSessionId: ID_B }) === "查询杭州天气");
  check("只读给定的那个数据目录，串不到另一家去", read({ chatSessionId: ID_A }) === "查询杭州天气及预警");
  check("给的是另一家的目录就读另一家的（说明真的按目录走）", read({ chatSessionId: ID_A }, OTHER) === "串到国际版去了");
  check("拿不到数据目录时一个字节都不读", read({ chatSessionId: ID_A }, null) === null);

  {
    resetTitleMemo();
    let bytes = 0;
    const counting = { ...fs, readSync: (...a) => { const n = fs.readSync(...a); bytes += n; return n; } };
    const f = path.join(DATA, "logs", stamp(RUN1), "Modular", `ai-agent_0_${RUN1}_stdout.log`);
    const total = fs.statSync(f).size;
    readTraeSessionTitle({ chatSessionId: ID_B }, { dataDir: DATA, fs: counting });
    check(`二分到创建时刻再往后扫，不是整文件翻一遍（读了 ${bytes} / ${total} 字节）`, bytes < total * 0.5, `${bytes}/${total}`);
  }

  check("日志里没有这段会话就是没有（不许拿最近一条顶上）", read({ chatSessionId: objectId(A_AT, "ffffffffffffffff") }) === null);
  check("比现存日志都早的会话找不回来，也不许乱认", read({ chatSessionId: objectId(AT("2020-01-01T00:00:00+08:00"), "aaaaaaaaaaaaaaaa") }) === null);
  check("侧边栏那种非当前会话不许盖掉主会话的名字", read({ chatSessionId: ID_A, isCurrentSession: false }) === null);
  check("形状不对的 id 一律不查", read({ chatSessionId: "../../etc/passwd" }) === null && read({ chatSessionId: "6a7d7ebd" }) === null);
  check("别家客户端的 _meta（没有 chatSessionId）不认", read({ session_id: "sess_x" }) === null);
  check("没有 _meta 也不能抛", read(null) === null && read(undefined) === null);
  check("查到过就不再读盘（这函数在每帧的刷新路径上）", (() => {
    resetTitleMemo();
    let opens = 0;
    const counting = { ...fs, openSync: (...a) => { opens++; return fs.openSync(...a); } };
    for (let i = 0; i < 3; i++) readTraeSessionTitle({ chatSessionId: ID_A }, { dataDir: DATA, fs: counting });
    return opens === 1;
  })());
  check("记忆化按数据目录分开记（同一个 id 在两家目录下是两回事）", (() => {
    resetTitleMemo();
    return readTraeSessionTitle({ chatSessionId: ID_A }, { dataDir: DATA }) === "查询杭州天气及预警" &&
      readTraeSessionTitle({ chatSessionId: ID_A }, { dataDir: OTHER }) === "串到国际版去了";
  })());
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m标题的取用顺序：先协议级（_meta），后本机取证\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-ord-"));
  fs.mkdirSync(path.join(home, ".zcode", "cli", "db"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "cli", "db", "db.sqlite"), "");
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "sessions", "7003.json"),
    JSON.stringify({ pid: 7003, sessionId: "s", name: "本机取证认到的名字", nameSource: "generated" })
  );
  const local = { clientPid: 7003, hostSessionId: null, sessionName: null };
  const exec = () => "协议级认到的名字\n";
  resetTitleMemo();
  check(
    "_meta 报了会话身份时，用它，不用本机取证那条",
    readSessionTitle(local, { home, exec, meta: { session_id: "sess_0a33b40d-8caa-431f-8d42-ca951e3366f4" } }) === "协议级认到的名字"
  );
  resetTitleMemo();
  check("没有 _meta 的客户端行为一字不变", readSessionTitle(local, { home, exec: () => { throw new Error("不该查库"); } }) === "本机取证认到的名字");
  resetTitleMemo();
  check(
    "Qoder 那种一个 _meta 字段都不发的，走回原来的路（不猜）",
    readSessionTitle(local, { home, exec: () => { throw new Error("不该查库"); }, meta: { progressToken: 1 } }) === "本机取证认到的名字"
  );
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1mbin shim：node …/node_modules/.bin/<名> 的 CLI 认得出品牌\x1b[0m");
{
  check("dsh 的 npx 启动串认出「dsh」", binShimName("node /Users/u/.npm/_npx/1e7f/node_modules/.bin/dsh web") === "dsh");
  check("Windows 的 .cmd shim 去掉扩展名", binShimName("node C:\\u\\node_modules\\.bin\\dsh.cmd web") === "dsh");
  check("shim 名撞上运行时名单（node）不算品牌", binShimName("node /a/node_modules/.bin/node x") === null);
  check("不在 node_modules/.bin 下的脚本不认（内部管道不是品牌）", binShimName("node /a/daemon-app-server-entry.js --stdio") === null);
  check("裸 bin 目录（~/.nvm/…/bin/claude）不走这条", binShimName("/Users/u/.nvm/versions/node/v24.11.1/bin/claude") === null);

  const snap = new Map([
    [800, { ppid: 801, tty: "??", command: "node /Users/u/.agent-in-chrome/agent-in-chrome/server.mjs" }],
    [801, { ppid: 802, tty: "ttys002", command: "node /Users/u/.npm/_npx/1e7f/node_modules/.bin/dsh web" }],
  ]);
  const walked = walkSurface(801, snap);
  check("dsh 链：形态是 CLI，品牌从 shim 认出「dsh」", walked.surface === "cli" && walked.brand === "dsh", JSON.stringify(walked));
  const agent = composeAgent(
    { name: "dsh-mcp-client", title: null, version: "0.0.1" },
    { brandFallback: walked.brand, brandAppDir: null, surface: walked.surface, workspace: null, workspaceKind: null },
    null
  );
  check("品牌是链上的「dsh」，不是中间件自报的 dsh-mcp-client", agent.brand === "dsh", JSON.stringify(agent));
  check("版本不许拿中间件的 0.0.1 顶上（品牌与版本必须同源）", agent.version === null, JSON.stringify(agent));
}

console.log("\n\x1b[1mDeepSeek Harness：会话归属与标题/工作区\x1b[0m");
if (typeof zlib.zstdCompressSync !== "function") {
  console.log("  \x1b[90m·\x1b[0m 这个 Node 没有 zstd（<22.15），跳过 dsh 会话用例；decodeZstdFrames 应答 null 而不是抛");
  check("没有 zstd 时 decodeZstdFrames 返回 null", decodeZstdFrames(Buffer.from("x")) === null);
} else {
  const DSH_CMD = "node /Users/u/.npm/_npx/1e7f/node_modules/.bin/dsh web";
  const localFor = (cmd = DSH_CMD) => ({ clientCommand: cmd, clientPid: 1, hostSessionId: null, sessionName: null });
  const frames = (lines) => Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + "\n"))));
  const ev = (o) => JSON.stringify(o);

  const makeDshHome = (sessions) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-dsh-"));
    for (const s of sessions) {
      const dir = path.join(home, ".dsh", "sessions", "--proj--", s.id);
      fs.mkdirSync(dir, { recursive: true });
      const lines = [ev({ type: "session", version: 0, id: s.id, createdAt: 1, cwd: s.cwd, delegationDepth: 0 })];
      let seq = 10;
      for (const [kind, title] of s.titles || []) lines.push(ev({ type: "session/title", seq: seq++, data: { title, source: { kind } } }));
      const f = path.join(dir, "session.jsonl.zstd");
      fs.writeFileSync(f, frames(lines));
      if (s.ageMs) {
        const t = new Date(Date.now() - s.ageMs);
        fs.utimesSync(f, t, t);
      }
    }
    return home;
  };

  check("isDshClient 认 npx/pnpm 的 bin shim", isDshClient(DSH_CMD));
  check("isDshClient 认包路径（全局装的形态）", isDshClient("node /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web"));
  check("别家的 node 进程不算 dsh", !isDshClient("node /Users/u/.workbuddy/daemon-app-server-entry.js"));

  {
    const parts = frames(['{"a":1}', '{"b":2}', '{"c":3}']);
    const out = decodeZstdFrames(parts);
    check("多帧拼接的 zstd 逐帧全解开（dsh 的日志就是这个形状）", out === '{"a":1}\n{"b":2}\n{"c":3}\n', JSON.stringify(out));
  }

  {
    const home = makeDshHome([
      { id: "session-11111111-1111-1111-1111-111111111111", cwd: "/Users/u/proj-a", titles: [["fallback", "你好"], ["provider", "调研杭州天气"]] },
    ]);
    resetTitleMemo();
    const s = readDshSession(localFor(), { home });
    check("一个活跃会话：归属成立，标题是 LLM 生成的那条", s?.title === "调研杭州天气", JSON.stringify(s));
    check("cwd 来自会话日志的 header", s?.cwd === "/Users/u/proj-a", JSON.stringify(s));
    resetTitleMemo();
    check("拉起我们的不是 dsh 时一个字都不读", readDshSession(localFor("node /a/other.js"), { home }) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeDshHome([
      { id: "session-22222222-2222-2222-2222-222222222222", cwd: "/Users/u/proj-b", titles: [["fallback", "帮我看看这个"]] },
    ]);
    resetTitleMemo();
    const s = readDshSession(localFor(), { home });
    check("fallback 标题不显示（同 ZCode 拒 first_input 的理由）", s !== null && s.title === null, JSON.stringify(s));
    check("标题缺席不拖累 cwd", s?.cwd === "/Users/u/proj-b", JSON.stringify(s));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeDshHome([
      { id: "session-33333333-3333-3333-3333-333333333333", cwd: "/x", titles: [["provider", "自动名"], ["user", "我改的名"]] },
    ]);
    resetTitleMemo();
    check("用户改名后取最后一条", readDshSession(localFor(), { home })?.title === "我改的名");
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeDshHome([
      { id: "session-44444444-4444-4444-4444-444444444444", cwd: "/x", titles: [["provider", "甲"]] },
      { id: "session-55555555-5555-5555-5555-555555555555", cwd: "/y", titles: [["provider", "乙"]] },
    ]);
    resetTitleMemo();
    check("两个活跃会话：null，不猜", readDshSession(localFor(), { home }) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeDshHome([
      { id: "session-66666666-6666-6666-6666-666666666666", cwd: "/x", titles: [["provider", "活的"]] },
      { id: "session-77777777-7777-7777-7777-777777777777", cwd: "/y", titles: [["provider", "冷的"]], ageMs: 20 * 60_000 },
    ]);
    resetTitleMemo();
    check("超出活跃窗口的旧会话不算，归属落在活的那个", readDshSession(localFor(), { home })?.title === "活的");
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeDshHome([]);
    const proj = path.join(home, "repos", "my-cool-repo");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    const dir = path.join(home, ".dsh", "sessions", "--proj--", "session-88888888-8888-8888-8888-888888888888");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.jsonl.zstd"),
      frames([ev({ type: "session", version: 0, id: "s", createdAt: 1, cwd: proj, delegationDepth: 0 }), ev({ type: "session/title", seq: 10, data: { title: "改注册器", source: { kind: "provider" } } })])
    );
    resetTitleMemo();
    const idn = readSessionIdentity(localFor(), { home, tmp: path.join(home, "unused-tmp") });
    check("标题与工作区同源于同一段会话", idn.title === "改注册器" && idn.workspace === "my-cool-repo" && idn.workspaceKind === "git", JSON.stringify(idn));
    resetTitleMemo();
    const other = readSessionIdentity({ clientCommand: "node /a/b.js", clientPid: 1, hostSessionId: null, sessionName: null }, { home });
    check("非 dsh 客户端走 readSessionIdentity 行为不变（工作区不盖）", other.title === null && other.workspace === null, JSON.stringify(other));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1mAntigravity：数据目录自报 + 会话库里的工作区\x1b[0m");
{
  const ID = "cd33cae1-3e75-4d59-baa4-92ca4e29df69";
  const AG_CMD =
    "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --app_data_dir antigravity-ide --enable_lsp";
  const localFor = (cmd = AG_CMD) => ({ clientCommand: cmd, clientPid: 1, hostSessionId: null, sessionName: null });
  const metaFor = (id = ID) => ({ "antigravity.google/conversation_id": id, progressToken: "p1" });
  const geminiDir = (name) => path.join("/h", ".gemini", name);

  check("--app_data_dir 自报的名字算数（同 --user-data-dir 那条证据链）", antigravityDataDir(AG_CMD, { home: "/h" }) === geminiDir("antigravity-ide"));
  check("等号写法一样认", antigravityDataDir("x --app_data_dir=ag-next", { home: "/h" }) === geminiDir("ag-next"));
  check("没报就退到真机见过的那个名字", antigravityDataDir("node /a/b.js", { home: "/h" }) === geminiDir("antigravity-ide"));
  check("--app_data_dir .. 跳不出 ~/.gemini", antigravityDataDir("x --app_data_dir ..", { home: "/h" }) === geminiDir("antigravity-ide"));
  check("--app_data_dir . 也不认", antigravityDataDir("x --app_data_dir .", { home: "/h" }) === geminiDir("antigravity-ide"));
  check("名字里夹着 .. 一样不认", antigravityDataDir("x --app_data_dir a..b", { home: "/h" }) === geminiDir("antigravity-ide"));

  check("会话 id 只认 UUID 形状", antigravityConversationId({ "antigravity.google/conversation_id": ID }) === ID);
  check("会话 id 两头的空白不算差异（sid 那一路和这一路要给同一个答案）", antigravityConversationId({ "antigravity.google/conversation_id": ` ${ID}\n` }) === ID);
  check("带路径分隔的 id 一概不收", antigravityConversationId({ "antigravity.google/conversation_id": "../../etc/passwd" }) === null);

  const agHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-ag-"));
    fs.mkdirSync(path.join(home, ".gemini", "antigravity-ide", "conversations"), { recursive: true });
    return home;
  };
  const pbVarint = (n) => {
    const out = [];
    do {
      const b = n & 0x7f;
      n = Math.floor(n / 128);
      out.push(n ? b | 0x80 : b);
    } while (n);
    return Buffer.from(out);
  };
  const pbStr = (field, s) => Buffer.concat([pbVarint((field << 3) | 2), pbVarint(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
  const agBytes = (id, uri, { tail = Buffer.from([0x7a, 0xa8, 0x03]), decoys = true } = {}) =>
    Buffer.concat([
      Buffer.from([0x1a, 0x24]),
      Buffer.from("b24f57a3-74f6-489c-abb5-f150d1d66ea1"),
      decoys ? Buffer.concat([pbStr(6, id), pbStr(26, "\u0012")]) : Buffer.alloc(0),
      pbStr(6, id),
      pbStr(7, `file://${uri}`),
      tail,
    ]);
  const writeRaw = (home, name, buf) => fs.writeFileSync(path.join(home, ".gemini", "antigravity-ide", "conversations", name), buf);
  const homeWith = (uri, { name = `${ID}.db`, ...opts } = {}) => {
    const home = agHome();
    writeRaw(home, name, agBytes(ID, uri, opts));
    return home;
  };
  const wsOf = (home, meta = metaFor()) => {
    resetTitleMemo();
    return readAntigravityWorkspace(meta, localFor(), { home });
  };

  {
    const proj = "/Users/u/PycharmProjects/onework-demo-self";
    const home = homeWith(proj);
    const dir = wsOf(home);
    check("按长度前缀精确取：路径不必存在也认得出", dir === proj, String(dir));
    check("id 出现多次时只认后面跟着 file:// 的那一处", !String(dir).includes("\u0012"), String(dir));
    check("别的会话 id 不认（锚定 id 才躲得开库里提示词文本中的 file://）", wsOf(home, metaFor("11111111-2222-3333-4444-555555555555")) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = agHome();
    const proj = "/Users/u/repos/wal-only";
    writeRaw(home, `${ID}.db`, Buffer.from("别的内容，没有那个字段"));
    writeRaw(home, `${ID}.db-wal`, agBytes(ID, proj));
    check("主库里没有就接着扫 -wal", wsOf(home) === proj);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const proj = "/Users/u/repos/ag-tail";
    const home = homeWith(proj, { tail: Buffer.from("zabcdefghij", "latin1") });
    check("尾巴接 11 个都在 URI 字符集里的字节，取出来仍然精确", wsOf(home) === proj, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const proj = "/Users/u/" + "a".repeat(200);
    const home = homeWith(proj);
    check("多字节 varint 长度（>127）读得对", wsOf(home) === proj);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const proj = "/Users/u/项目/我的仓库";
    const home = homeWith(proj);
    check("中文目录名不糊（按 utf8 解）", wsOf(home) === proj, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const proj = "/Users/u/repos/my proj (v2),a'b";
    const home = homeWith(proj.replace(/ /g, "%20"));
    check("空格转义与 ' , ( ) 原文都还原得回来", wsOf(home) === proj, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const raw = "/Users/u/repos/decode-fail%zz";
    const home = homeWith(raw);
    check("decodeURIComponent 抛了就用原文，不吞掉整条路", wsOf(home) === raw, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    for (const [label, uri, want] of [
      ["file:///C:/…", "/C:/Users/u/repo", "C:/Users/u/repo"],
      ["file:///c%3A/…", "/c%3A/Users/u/repo", "c:/Users/u/repo"],
    ]) {
      const home = homeWith(uri);
      const d = wsOf(home);
      check(`${label}：盘符归一，绝不会变成 /C`, d !== "/C" && d === (process.platform === "win32" ? want : null), String(d));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  {
    const home = homeWith("not/absolute/half");
    check("相对路径直接拒收，不交给 readWorkspace", wsOf(home) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = agHome();
    writeRaw(
      home,
      `${ID}.db`,
      Buffer.concat([
        pbVarint((6 << 3) | 2),
        pbVarint(ID.length),
        Buffer.from(ID),
        pbVarint((7 << 3) | 2),
        Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]),
        Buffer.from("file:///Users/u/repos/varint-broken"),
        Buffer.from([0x7a]),
      ])
    );
    check("长度 varint 坏掉：null，不猜", wsOf(home) === null, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = agHome();
    writeRaw(
      home,
      `${ID}.db`,
      Buffer.concat([
        pbVarint((6 << 3) | 2),
        pbVarint(ID.length),
        Buffer.from(ID),
        pbVarint((7 << 3) | 2),
        pbVarint(4000),
        Buffer.from("file:///Users/u/repos/len-overflow"),
      ])
    );
    check("长度越界：null，不按剩下的字节凑一条", wsOf(home) === null, String(wsOf(home)));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = homeWith("/Users/u/" + "b".repeat(5000));
    check("URI 超 4096 不收", wsOf(home) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    let reads = 0;
    const bigFs = {
      statSync: () => ({ size: 300 * 1024 * 1024 }),
      readFileSync: () => {
        reads++;
        throw new Error("不该读：这份库超上限了");
      },
      existsSync: () => false,
    };
    resetTitleMemo();
    check("超 256MB 的会话库跳过，而且没整份读进内存", readAntigravityWorkspace(metaFor(), localFor(), { fs: bigFs, home: "/h" }) === null && reads === 0);
  }

  {
    const noFs = {
      statSync: () => {
        throw new Error("不该 stat");
      },
      readFileSync: () => {
        throw new Error("不该读盘");
      },
    };
    resetTitleMemo();
    check("非 UUID 的 id 直接 null，一个字节都不读", readAntigravityWorkspace({ "antigravity.google/conversation_id": "../../etc/passwd" }, localFor(), { fs: noFs, home: "/h" }) === null);
    check("不是它家的帧（压根没那个键）也是 null", readAntigravityWorkspace({ session_id: "sess_x" }, localFor(), { fs: noFs, home: "/h" }) === null);
    check("_meta 缺席不抛", readAntigravityWorkspace(null, localFor(), { fs: noFs, home: "/h" }) === null);
  }

  {
    const home = agHome();
    const proj = "/Users/u/repos/late-db";
    resetTitleMemo();
    check("库还没落盘：null", readAntigravityWorkspace(metaFor(), localFor(), { home }) === null);
    writeRaw(home, `${ID}.db`, agBytes(ID, proj));
    check("重试窗内不重扫（否则每帧都要扫一遍大库）", readAntigravityWorkspace(metaFor(), localFor(), { home }) === null);
    resetTitleMemo();
    check("重试窗过后扫到了", readAntigravityWorkspace(metaFor(), localFor(), { home }) === proj);
    fs.rmSync(path.join(home, ".gemini"), { recursive: true, force: true });
    check("扫到过就记住，库读不到了也不改口", readAntigravityWorkspace(metaFor(), localFor(), { home }) === proj);
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = agHome();
    const proj = path.join(home, "repos", "ag-wired");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    writeRaw(home, `${ID}.db`, agBytes(ID, proj));
    resetTitleMemo();
    const idn = readSessionIdentity(localFor(), { home, meta: metaFor(), tmp: path.join(home, "unused-tmp") });
    check("readSessionIdentity 接上了：工作区来自会话库", idn.workspace === "ag-wired" && idn.workspaceKind === "git", JSON.stringify(idn));
    check("会话标题本地没有证据：返回 null，不猜", idn.title === null, JSON.stringify(idn));
    resetTitleMemo();
    const bare = readSessionIdentity(localFor(), { home, meta: { progressToken: "p1" }, tmp: path.join(home, "unused-tmp") });
    check("同一个客户端、帧里没有会话 id 时不盖工作区", bare.workspace === null, JSON.stringify(bare));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1mWindows：同样四段身份，换一套证据\x1b[0m");
{
  const WSELF = "C:\\Users\\u\\.agent-in-chrome\\agent-in-chrome\\server.mjs";
  const winDesktop = new Map([
    [800, { ppid: 801, tty: null, name: "node.exe", command: `"C:\\Program Files\\nodejs\\node.exe" "${WSELF}"` }],
    [801, { ppid: 802, tty: null, name: "cmd.exe", command: 'C:\\Windows\\system32\\cmd.exe /d /s /c "C:\\Users\\u\\.agent-in-chrome\\agent-in-chrome\\mcp-launcher.bat"' }],
    [802, { ppid: 803, tty: null, name: "claude.exe", command: "C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.237\\claude.exe --output-format stream-json" }],
    [803, { ppid: 804, tty: null, name: "Claude.exe", command: '"C:\\Program Files\\WindowsApps\\Claude_1.34493.1.0_x64__p\\app\\Claude.exe"' }],
    [804, { ppid: 5, tty: null, name: "explorer.exe", command: "C:\\Windows\\Explorer.EXE" }],
  ]);
  const winCli = new Map([
    [810, { ppid: 811, tty: null, name: "node.exe", command: `node ${WSELF}` }],
    [811, { ppid: 812, tty: null, name: "claude.exe", command: "C:\\Users\\u\\AppData\\Local\\claude\\claude.exe" }],
    [812, { ppid: 813, tty: null, name: "WindowsTerminal.exe", command: "C:\\Program Files\\WindowsTerminal\\WindowsTerminal.exe" }],
  ]);

  const cp = resolveClientPid(801, winDesktop, WSELF);
  check("Windows：跳过 cmd /c mcp-launcher.bat，锚到 claude.exe", cp === 802, String(cp));

  const wd = walkSurface(cp, winDesktop, { platform: "win32" });
  check("Windows 桌面端：撞见 explorer.exe 就取它下面那一跳当品牌", wd.surface === "app" && wd.brand === "Claude", JSON.stringify(wd));
  check("Windows 品牌那一跳连 exe 路径一起给（版本号要从它的版本资源读）", /Claude\.exe$/.test(wd.appDir || ""), JSON.stringify(wd));

  const wc = walkSurface(resolveClientPid(811, winCli, WSELF), winCli, { platform: "win32" });
  check("Windows CLI：撞见终端宿主进程 = 从命令行起来的", wc.surface === "cli", JSON.stringify(wc));

  const broken = new Map([[820, { ppid: 821, tty: null, name: "node.exe", command: `node ${WSELF}` }], [821, { ppid: 822, tty: null, name: "ZCode.exe", command: "C:\\x\\ZCode.exe" }]]);
  const wb = walkSurface(821, broken, { platform: "win32" });
  check("Windows：链断在半路，按最后见到的那一跳算桌面端", wb.surface === "app" && wb.brand === "ZCode", JSON.stringify(wb));
  const mb = walkSurface(821, broken, { platform: "darwin" });
  check("同一条链在 macOS 上仍然「不猜」：断了就是没有证据", mb.surface === null && mb.brand === null, JSON.stringify(mb));

  check("Windows 路径 + 引号 + .exe 后缀都认得出裸名字", plainName('"C:\\Program Files\\nodejs\\node.exe" x') === null && plainName("C:\\x\\y\\Claude.exe --a") === "Claude");
  check("Windows 上 exe 路径就是「品牌所在的那个东西」", exePathOf('"C:\\a b\\Claude.exe" -x') === "C:\\a b\\Claude.exe" && exePathOf("node x.mjs") === null);
  check("Windows 的启动器后缀也要认（不认就锚在 cmd.exe 上）", isLauncherFor('cmd /d /s /c "C:\\x\\mcp-launcher.bat"', WSELF) && isLauncherFor("/x/mcp-launcher.sh", WSELF));

  {
    let calls = 0;
    const fakeExec = () => {
      calls++;
      return JSON.stringify([
        { pid: 800, ppid: 801, name: "node.exe", cmd: "node server.mjs", start: "134327533025719003" },
        { pid: 801, ppid: 802, name: "cmd.exe", cmd: "cmd /c x.bat", start: "134327533025719111" },
      ]);
    };
    const src = makeWinProcSource(fakeExec);
    const a = src.get(800);
    const b = src.get(801);
    check("Windows 快照：一次查询把整条链都填进来", a?.ppid === 801 && b?.name === "cmd.exe" && calls === 1, `calls=${calls} ${JSON.stringify([a, b])}`);
    check("Windows 快照：tty 留 null，不拿进程名冒充终端证据", a.tty === null);
    src.get(999);
    src.get(998);
    src.get(997);
    check("Windows 快照：查不到的 pid 不会无限起子进程", calls <= 3, `calls=${calls}`);

    const dead = makeWinProcSource(() => {
      throw new Error("PowerShell 被策略挡下了");
    });
    check("PowerShell 不可用时退回 null，不抛", dead.get(800) === null);
  }

  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-win-"));
    const appdata = path.join(home, "AppData", "Roaming");
    const dir = path.join(appdata, "Claude", "claude-code-sessions", "org", "acct");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "local_abc-1.json"), JSON.stringify({ title: "Windows/Mac 功能对齐" }));
    check(
      "Windows：会话标题从 %APPDATA%\\Claude\\claude-code-sessions 读得到",
      readHostSessionTitle("local_abc-1", { home, env: { APPDATA: appdata } }) === "Windows/Mac 功能对齐"
    );
    check("没有 APPDATA 时按 home\\AppData\\Roaming 兜底", readHostSessionTitle("local_abc-1", { home, env: {} }) === "Windows/Mac 功能对齐");
    check("对不上的会话 id 照旧返回 null", readHostSessionTitle("local_nope", { home, env: { APPDATA: appdata } }) === null);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1m这一帧是主会话发的，还是哪个 subagent 发的\x1b[0m");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-sub-"));
  const PID = 30982;
  const SID = "987a526a-b5b3-44fd-b79d-707f94409cc4";
  const cwd = "/Users/u/OpenSource/agent-in-chrome";
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "sessions", `${PID}.json`),
    JSON.stringify({ pid: PID, sessionId: SID, cwd, kind: "interactive", name: "agent-in-chrome-58", nameSource: "derived" })
  );
  const subs = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), SID, "subagents");
  fs.mkdirSync(subs, { recursive: true });
  const write = (id, toolUseIds, meta) => {
    fs.writeFileSync(
      path.join(subs, `agent-${id}.jsonl`),
      toolUseIds.map((t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: t }] } })).join("\n") + "\n"
    );
    if (meta) fs.writeFileSync(path.join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
  };
  write("a73ac2b489179315f", ["toolu_01HffyAX2CFDpPnabnxt6Dr6"], { agentType: "general-purpose", description: "插件卡片会话名取证" });
  write("b0000000000000001", ["toolu_01ZZZZZZZZZZZZZZZZZZZZZZ"], { agentType: "Explore", description: "另一路并行子任务" });
  const local = { clientPid: PID };
  const at = (id, opts = {}) => {
    resetSubagentMemo();
    return readClaudeSubagent({ "claudecode/toolUseId": id }, local, { home, ...opts });
  };

  const hit = at("toolu_01HffyAX2CFDpPnabnxt6Dr6");
  check("按 toolUseId 认出是哪个子任务发的", hit?.label === "插件卡片会话名取证", JSON.stringify(hit));
  check("子任务类型也带上（进 tooltip）", hit?.type === "general-purpose");
  check("并行子任务各认各的，不串", at("toolu_01ZZZZZZZZZZZZZZZZZZZZZZ")?.label === "另一路并行子任务");
  check("主会话自己发的那一帧：没有任何子任务认领它 → null", at("toolu_01MainMainMainMainMainMa") === null);
  check("id 形状不对一律不查（它要被拼进文件比对）", at("../../etc/passwd") === null && at("") === null);
  check("没有 _meta / 没有本机取证时不抛", readClaudeSubagent(null, local, { home }) === null && readClaudeSubagent({}, null, { home }) === null);

  const moved = path.join(home, ".claude", "projects", "some-other-encoding", SID, "subagents");
  fs.mkdirSync(moved, { recursive: true });
  fs.writeFileSync(path.join(moved, "agent-c1.jsonl"), JSON.stringify({ id: "toolu_01Moved0000000000000000" }) + "\n");
  fs.writeFileSync(path.join(moved, "agent-c1.meta.json"), JSON.stringify({ agentType: "Plan", description: "换了目录名也认得出" }));
  fs.rmSync(path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });
  check("cwd 转写拼不中时，在 projects 底下按会话 id 找得到", at("toolu_01Moved0000000000000000")?.label === "换了目录名也认得出");
  fs.rmSync(moved, { recursive: true, force: true });

  const bare = path.join(home, ".claude", "projects", "x", SID, "subagents");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "agent-d1.jsonl"), JSON.stringify({ id: "toolu_01NoMeta00000000000000" }) + "\n");
  check("只有记录没有 meta：不显示，不编", at("toolu_01NoMeta00000000000000") === null);

  fs.writeFileSync(path.join(bare, "agent-e1.jsonl"), JSON.stringify({ id: "toolu_01Stale000000000000000" }) + "\n");
  fs.writeFileSync(path.join(bare, "agent-e1.meta.json"), JSON.stringify({ agentType: "x", description: "一小时前那个" }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(bare, "agent-e1.jsonl"), old, old);
  check("陈旧的子任务记录不再读", at("toolu_01Stale000000000000000") === null);

  fs.rmSync(bare, { recursive: true, force: true });
  const subs2 = path.join(home, ".claude", "projects", "y", SID, "subagents");
  fs.mkdirSync(subs2, { recursive: true });
  fs.writeFileSync(path.join(subs2, "agent-f1.jsonl"), JSON.stringify({ id: "toolu_01Memo00000000000000000" }) + "\n");
  fs.writeFileSync(path.join(subs2, "agent-f1.meta.json"), JSON.stringify({ agentType: "x", description: "记住我" }));
  resetSubagentMemo();
  const first = readClaudeSubagent({ "claudecode/toolUseId": "toolu_01Memo00000000000000000" }, local, { home });
  fs.rmSync(subs2, { recursive: true, force: true });
  const again = readClaudeSubagent({ "claudecode/toolUseId": "toolu_01Memo00000000000000000" }, local, { home });
  check("查到过就记住，盘上没了也照旧答得出", first?.label === "记住我" && again?.label === "记住我");

  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m真机上跑一遍：不许抛，也不许卡住\x1b[0m");
{
  const t0 = Date.now();
  let local = null;
  let threw = null;
  try {
    local = probeLocal({ snap: procSource() });
  } catch (e) {
    threw = e;
  }
  const ms = Date.now() - t0;
  check("在这台机器上取证不抛异常", !threw, String(threw));
  check(`取证够快（实测 ${ms}ms，握手之后才做，但也不能拖住第一次调用）`, ms < 1500, `${ms}ms`);
  check("形态只会是这三种取值之一", local && (local.surface === null || local.surface === "cli" || local.surface === "app"), JSON.stringify(local));
}

console.log(failed ? `\n\x1b[31m${passed} 通过, ${failed} 失败\x1b[0m` : `\n\x1b[32m${passed} 通过, 0 失败\x1b[0m`);
process.exit(failed ? 1 : 0);
