#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runAgents, buildAgents } from "./agents.mjs";
import * as install from "./install.mjs";
import { pickMulti } from "./pick.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(ROOT, "mcp", "server.mjs");

{
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-noclaude-"));
  try {
    fs.symlinkSync(process.execPath, path.join(linkDir, "node"));
  } catch {}
  process.env.PATH = [linkDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
}

const REAL_HOME = os.homedir();
const GUARDED = [
  path.join(REAL_HOME, ".claude.json"),
  path.join(REAL_HOME, ".codex", "config.toml"),
  path.join(REAL_HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  path.join(REAL_HOME, ".config", "Claude", "claude_desktop_config.json"),
  path.join(REAL_HOME, ".kimi", "mcp.json"),
  path.join(REAL_HOME, ".config", "opencode", "opencode.json"),
  path.join(REAL_HOME, ".gemini", "settings.json"),
  path.join(REAL_HOME, ".gemini", "config", "mcp_config.json"),
  path.join(REAL_HOME, ".workbuddy", "mcp.json"),
  path.join(REAL_HOME, ".qoder", "settings.json"),
  path.join(REAL_HOME, ".qoder-cn", "settings.json"),
];
const readOr = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const entrySnapshot = (text) => {
  if (text == null) return null;
  try {
    const e = JSON.parse(text)?.mcpServers?.["agent-in-chrome"];
    return e === undefined ? null : JSON.stringify(e);
  } catch {
    return text.includes("[mcp_servers.agent-in-chrome]") ? "toml" : null;
  }
};
const LIVE_WRITTEN = path.join(REAL_HOME, ".claude.json");
const REAL_SNAPSHOT = Object.fromEntries(GUARDED.map((f) => [f, readOr(f)]));
const REAL_ENTRY_BEFORE = Object.fromEntries(GUARDED.map((f) => [f, entrySnapshot(readOr(f))]));
const SANDBOX_HOMES = [];

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

async function quiet(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real;
  }
}

function makeHome(fixtures) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-agents-"));
  SANDBOX_HOMES.push(home);
  for (const [rel, text] of fixtures) {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return home;
}

function readAll(home, rels) {
  return Object.fromEntries(rels.map((r) => [r, fs.readFileSync(path.join(home, r), "utf8")]));
}
function backupsOf(home, rel) {
  const dir = path.join(home, path.dirname(rel));
  const base = path.basename(rel);
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`));
}

const opts = (home) => ({
  home,
  platform: "linux",
  serverPath: SERVER_PATH,
  mcpLauncher: path.join(ROOT, "bin", "agent-in-chrome.mjs"),
  yes: true,
});

const canonicalJson = (o) => JSON.stringify(o, null, 2) + "\n";

console.log("\n\x1b[1m卸载：只摘我们的键\x1b[0m");
{
  const rels = [".kimi/mcp.json", ".gemini/settings.json"];
  const before = {
    [rels[0]]: canonicalJson({
      mcpServers: {
        "some-other-server": { command: "node", args: ["/opt/other.js"] },
      },
      someUnrelatedSetting: { deep: { nested: true } },
    }),
    [rels[1]]: canonicalJson({
      theme: "dark",
      mcpServers: { filesystem: { command: "npx", args: ["-y", "@x/fs"] } },
    }),
  };
  const home = makeHome(Object.entries(before));

  const ins = await quiet(() => runAgents("install", opts(home)));
  const afterInstall = readAll(home, rels);
  check(
    "install 把条目写进了每一家",
    rels.every((r) => afterInstall[r].includes("agent-in-chrome")),
    JSON.stringify(ins.value)
  );

  await quiet(() => runAgents("uninstall", opts(home)));
  const afterUninstall = readAll(home, rels);
  for (const r of rels) {
    check(`${r}：我们的键摘干净了，其余内容一个字没动`, afterUninstall[r] === before[r], diffHint(before[r], afterUninstall[r]));
    check(`${r}：改动前留了备份`, backupsOf(home, r).length >= 1);
  }
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const rel = ".kimi/mcp.json";
  const home = makeHome([[rel, canonicalJson({ mcpServers: { other: { command: "old" } } })]]);
  await quiet(() => runAgents("install", opts(home)));

  const f = path.join(home, rel);
  const mid = JSON.parse(fs.readFileSync(f, "utf8"));
  mid.mcpServers.other.command = "用户后来改的";
  mid.mcpServers.addedLater = { command: "用户后来加的" };
  mid.theme = "dark";
  fs.writeFileSync(f, canonicalJson(mid));

  await quiet(() => runAgents("uninstall", opts(home)));
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  check("卸载后我们的键没了", !("agent-in-chrome" in after.mcpServers));
  check("用户中途改的条目保持改后的值（不是还原成装之前）", after.mcpServers.other?.command === "用户后来改的");
  check("用户中途新加的条目还在", after.mcpServers.addedLater?.command === "用户后来加的");
  check("用户中途新加的顶层设置还在", after.theme === "dark");
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const rel = ".kimi/mcp.json";
  const home = makeHome([
    [rel, canonicalJson({ mcpServers: { "agent-in-chrome": { command: "node", args: ["/手写的/path.mjs"] }, keep: { command: "keep" } } })],
  ]);
  await quiet(() => runAgents("uninstall", opts(home)));
  const after = JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));
  check("没经我们装、本来就在的条目照样摘掉", !("agent-in-chrome" in after.mcpServers));
  check("同一份文件里别人的条目不受影响", after.mcpServers.keep?.command === "keep");
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const rel = ".kimi/mcp.json";
  const before = canonicalJson({ mcpServers: { other: { command: "x" } } });
  const home = makeHome([[rel, before]]);
  await quiet(() => runAgents("install", opts(home)));
  await quiet(() => runAgents("uninstall", opts(home)));
  const n1 = backupsOf(home, rel).length;
  const text1 = fs.readFileSync(path.join(home, rel), "utf8");
  await quiet(() => runAgents("uninstall", opts(home)));
  check("再卸一次：文件没被碰", fs.readFileSync(path.join(home, rel), "utf8") === text1);
  check("再卸一次：不再产生新备份", backupsOf(home, rel).length === n1);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const rel = ".kimi/mcp.json";
  const home = makeHome([
    [
      rel,
      canonicalJson({
        mcpServers: {
          "zcode-in-chrome": { command: "node", args: ["/gone/old-runtime.mjs"] },
          keep: { command: "keep-me" },
        },
      }),
    ],
  ]);
  await quiet(() => runAgents("uninstall", opts(home)));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));
  check("卸载连改名前的 zcode-in-chrome 一起摘", !("zcode-in-chrome" in cfg.mcpServers));
  check("别人的条目一根汗毛没动", cfg.mcpServers.keep?.command === "keep-me");
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const rel = ".kimi/mcp.json";
  const before = canonicalJson({
    mcpServers: {
      "agent-in-chrome-2": { command: "someone-elses" },
      "my-agent-in-chrome": { command: "also-not-ours" },
    },
  });
  const home = makeHome([[rel, before]]);
  await quiet(() => runAgents("uninstall", opts(home)));
  check("agent-in-chrome-2 / my-agent-in-chrome 不是我们的，没动", fs.readFileSync(path.join(home, rel), "utf8") === before);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m卸载：Codex TOML 文本手术\x1b[0m");
{
  const rel = ".codex/config.toml";
  const before = `model = "o3"

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@x/fs"]

[tui]
theme = "dark"
`;
  const home = makeHome([[rel, before]]);
  await quiet(() => runAgents("install", opts(home)));
  const mid = fs.readFileSync(path.join(home, rel), "utf8");
  check("Codex：写进去了", mid.includes("[mcp_servers.agent-in-chrome]"));
  check("Codex：别人的表还在", mid.includes("[mcp_servers.filesystem]") && mid.includes("[tui]"));

  await quiet(() => runAgents("uninstall", opts(home)));
  const after = fs.readFileSync(path.join(home, rel), "utf8");
  check("Codex：我们的表摘干净了，其余内容一个字没动", after === before, diffHint(before, after));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m非规范格式的 JSON（记录已知行为）\x1b[0m");
{
  const rel = ".kimi/mcp.json";
  const before = JSON.stringify({ mcpServers: { other: { command: "x" } }, tail: [1, 2] }, null, 4) + "\n";
  const home = makeHome([[rel, before]]);
  await quiet(() => runAgents("install", opts(home)));
  await quiet(() => runAgents("uninstall", opts(home)));
  const after = fs.readFileSync(path.join(home, rel), "utf8");
  check("非规范格式：其余内容语义完全相同", JSON.stringify(JSON.parse(after)) === JSON.stringify(JSON.parse(before)));
  check("非规范格式：缩进被规范化成 2 空格（已知，非回归）", after.includes('\n  "mcpServers"'));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m非交互默认\x1b[0m");
{
  const home = makeHome([
    [".kimi/mcp.json", canonicalJson({ mcpServers: {} })],
    [".gemini/settings.json", canonicalJson({ mcpServers: {} })],
  ]);
  const noTty = new PassThrough();
  const r = await quiet(() => runAgents("install", { ...opts(home), yes: false, input: noTty }));
  check("非 TTY 时不弹清单、直接全装", r.value.installed.length >= 2, JSON.stringify(r.value));
  check("非 TTY 时不报「取消」", r.value.cancelled === false);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m单家失败的隔离\x1b[0m");
{
  const rel = ".kimi/mcp.json";
  const home = makeHome([[rel, canonicalJson({ mcpServers: {} })]]);
  const binDir = path.join(home, "fakebin");
  fs.mkdirSync(binDir, { recursive: true });
  const qoderBin = path.join(binDir, "qodercli");
  fs.writeFileSync(qoderBin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(qoderBin, 0o755);

  const realPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  let r;
  try {
    r = await quiet(() => runAgents("install", opts(home)));
  } finally {
    process.env.PATH = realPath;
  }

  const said = r.lines.join("\n");
  check("配置目录不存在时不崩（qoder-cli：探测看 PATH、写入看 ~/.qoder/）", !!r, said.slice(-300));
  check("已探测到的客户端：建父目录并注册成功", fs.existsSync(path.join(home, ".qoder", "settings.json")));
  check("这不算失败（不进 failed）", !r.value.failed.includes("qoder-cli"), JSON.stringify(r.value));
  check("同一轮里别家照样装上", r.value.installed.includes("kimi"), JSON.stringify(r.value));
  check("kimi 的配置真的写进去了", fs.readFileSync(path.join(home, rel), "utf8").includes("agent-in-chrome"));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m技能资产：references/ 要跟着装\x1b[0m");
{
  const skill = (install.ASSETS || []).find((a) => a.label === "skill");
  check("安装器登记了 skill 资产", !!skill);
  check(
    "skill 资产指的是整个技能目录，不是单个 SKILL.md",
    !!skill && fs.existsSync(skill.from) && fs.statSync(skill.from).isDirectory(),
    String(skill?.from)
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-skill-"));
  const to = path.join(dir, "agent-in-chrome");
  let copied = true;
  try {
    install.copyAsset(skill.from, to);
  } catch (e) {
    copied = false;
    check("拷贝资产不报错", false, String(e && e.message).slice(0, 120));
  }
  if (copied) {
    check("装完 SKILL.md 在", fs.existsSync(path.join(to, "SKILL.md")));
    const skillText = fs.existsSync(path.join(to, "SKILL.md")) ? fs.readFileSync(path.join(to, "SKILL.md"), "utf8") : "";
    const linked = [...skillText.matchAll(/\(references\/([\w.-]+\.md)\)/g)].map((m) => m[1]);
    check("SKILL.md 里确实有 references/ 索引（没有的话这组测试就白守了）", linked.length >= 3, String(linked.length));
    const missing = linked.filter((f) => !fs.existsSync(path.join(to, "references", f)));
    check("索引里的每一份 reference 都装到位了（链接不是死的）", missing.length === 0, missing.join("、"));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mClaude Desktop：user scope 在，就不写第二条同名的\x1b[0m");

async function withoutClaudeCli(fn) {
  const real = process.env.PATH;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aic-nopath-"));
  process.env.PATH = empty;
  try {
    return await fn();
  } finally {
    process.env.PATH = real;
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

const DESK_REL = ".config/Claude/claude_desktop_config.json";
const deskCfg = (home) => JSON.parse(fs.readFileSync(path.join(home, DESK_REL), "utf8"));

{
  const home = makeHome([
    [DESK_REL, canonicalJson({ globalShortcut: "Alt+C", mcpServers: { keepme: { command: "keep" } } })],
    [".claude.json", canonicalJson({ numStartups: 7, mcpServers: {} })],
  ]);
  const r = await withoutClaudeCli(() => quiet(() => runAgents("install", opts(home))));
  const cc = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  check("user scope 注册上了", !!cc.mcpServers?.["agent-in-chrome"], JSON.stringify(cc.mcpServers));
  check("同一轮里桌面端连接器不写", !deskCfg(home).mcpServers["agent-in-chrome"], JSON.stringify(deskCfg(home)));
  check("桌面端配置里别人的键一个没动", deskCfg(home).mcpServers.keepme?.command === "keep" && deskCfg(home).globalShortcut === "Alt+C");
  check("不写也就不留备份（没改过文件）", backupsOf(home, DESK_REL).length === 0);
  check("说清楚了为什么不写", r.lines.join("\n").includes("工具命名空间"), r.lines.join("\n").slice(-300));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = makeHome([
    [
      DESK_REL,
      canonicalJson({
        globalShortcut: "Alt+C",
        mcpServers: { keepme: { command: "keep" }, "agent-in-chrome": { command: "/老的/mcp-launcher.sh", args: [] } },
      }),
    ],
    [".claude.json", canonicalJson({ mcpServers: {} })],
  ]);
  await withoutClaudeCli(() => quiet(() => runAgents("install", opts(home))));
  check("已有的桌面端连接器被主动摘掉", !deskCfg(home).mcpServers["agent-in-chrome"], JSON.stringify(deskCfg(home)));
  check("摘的时候只摘我们的键", deskCfg(home).mcpServers.keepme?.command === "keep" && deskCfg(home).globalShortcut === "Alt+C");
  check("摘之前留了备份", backupsOf(home, DESK_REL).length >= 1);
  const c = await withoutClaudeCli(() => quiet(() => runAgents("check", opts(home))));
  check("check：有意不注册时不报成「未注册」的错", !/Claude Desktop: 未注册/.test(c.lines.join("\n")), c.lines.join("\n").slice(-300));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = makeHome([
    [DESK_REL, canonicalJson({ mcpServers: {} })],
    [".claude.json", "{ 这不是 JSON"],
  ]);
  const r = await withoutClaudeCli(() => quiet(() => runAgents("install", opts(home))));
  check("user scope 写不成时，桌面端连接器照写", deskCfg(home).mcpServers["agent-in-chrome"]?.command === opts(home).mcpLauncher, JSON.stringify(deskCfg(home)));
  check("坏掉的 ~/.claude.json 没被我们改坏", fs.readFileSync(path.join(home, ".claude.json"), "utf8") === "{ 这不是 JSON", r.lines.join("\n").slice(-200));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = makeHome([
    [DESK_REL, canonicalJson({ mcpServers: { "agent-in-chrome": { command: "/x/mcp-launcher.sh" }, keepme: { command: "keep" } } })],
    [".claude.json", canonicalJson({ mcpServers: { "agent-in-chrome": { command: "node" }, existing: { command: "x" } } })],
  ]);
  await withoutClaudeCli(() => quiet(() => runAgents("uninstall", opts(home))));
  check("uninstall：桌面端那条照旧摘掉", !deskCfg(home).mcpServers["agent-in-chrome"] && deskCfg(home).mcpServers.keepme?.command === "keep");
  const cc = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  check("uninstall：user scope 那条也摘掉", !cc.mcpServers["agent-in-chrome"] && cc.mcpServers.existing?.command === "x");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1mDeepSeek Harness：cordis.patch.yml 的整块手术\x1b[0m");
{
  const MARKER = "# 由 agent-in-chrome 安装器管理（卸载：npx @liang-hz/agent-in-chrome uninstall）";
  const REL = ".dsh/profiles/web/cordis.patch.yml";
  const PROFILE_PKG = [".dsh/profiles/web/package.json", JSON.stringify({ name: "dsh-profile-web", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } })];
  const LAUNCHER = path.join(ROOT, "bin", "agent-in-chrome.mjs");
  const ourBlock = [
    MARKER,
    "- insert:",
    "    - id: mcp-agent-in-chrome",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: agent-in-chrome",
    "        transport: stdio",
    `        command: '${LAUNCHER}'`,
    "        args: []",
  ].join("\n");
  const othersItem = ["- insert:", "    - id: some-other-plugin", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: github", "        transport: stdio", "        command: npx", "        args: ['-y', 'gh-mcp']"].join("\n");
  const dshOnly = { ...opts(""), agents: ["deepseek-harness"] };
  const run = (home, mode) => quiet(() => runAgents(mode, { ...dshOnly, home }));

  {
    const before = othersItem + "\n";
    const home = makeHome([PROFILE_PKG, [REL, before]]);
    await run(home, "install");
    const after = fs.readFileSync(path.join(home, REL), "utf8");
    check("装：别人的条目一字不动，我们的块带管理注释追加在后", after === `${othersItem}\n\n${ourBlock}\n`, diffHint(`${othersItem}\n\n${ourBlock}\n`, after));
    const { lines } = await run(home, "install");
    check("重装幂等：内容没变就不写", fs.readFileSync(path.join(home, REL), "utf8") === after && lines.some((l) => l.includes("已是最新")));
    check("幂等的那次不再备份", backupsOf(home, REL).length === 1);
    await run(home, "uninstall");
    check("卸载后逐字回到装之前", fs.readFileSync(path.join(home, REL), "utf8") === before, diffHint(before, fs.readFileSync(path.join(home, REL), "utf8")));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const hand = ["- insert:", "    - id: mcp-agent-in-chrome", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: agent-in-chrome", "        transport: stdio", "        command: /Users/u/old/mcp-launcher.sh", "        args: []", "        reconnect:", "          enabled: true"].join("\n");
    const home = makeHome([PROFILE_PKG, [REL, `${othersItem}\n\n${hand}\n`]]);
    await run(home, "install");
    const after = fs.readFileSync(path.join(home, REL), "utf8");
    check("手写的旧条目被受管条目替换，不留双份", after === `${othersItem}\n\n${ourBlock}\n`, diffHint(`${othersItem}\n\n${ourBlock}\n`, after));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const mixed = ["- insert:", "    - id: mcp-agent-in-chrome", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: agent-in-chrome", "    - id: other", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: other"].join("\n");
    const home = makeHome([PROFILE_PKG, [REL, mixed + "\n"]]);
    await run(home, "install");
    check("混写的项不动（装）", fs.readFileSync(path.join(home, REL), "utf8") === mixed + "\n");
    await run(home, "uninstall");
    check("混写的项不动（卸）", fs.readFileSync(path.join(home, REL), "utf8") === mixed + "\n");
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeHome([PROFILE_PKG, [REL, "[]\n"]]);
    await run(home, "install");
    check("`[]` 换成我们的块", fs.readFileSync(path.join(home, REL), "utf8") === ourBlock + "\n");
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeHome([PROFILE_PKG, [REL, "foo: bar\n"]]);
    const { lines } = await run(home, "install");
    check("认不出的形状不动手，只给手动片段", fs.readFileSync(path.join(home, REL), "utf8") === "foo: bar\n" && lines.some((l) => l.includes("没动它")));
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeHome([PROFILE_PKG]);
    await run(home, "install");
    check("没有 patch 文件时新建", fs.readFileSync(path.join(home, REL), "utf8") === ourBlock + "\n");
    fs.rmSync(home, { recursive: true, force: true });
  }

  {
    const home = makeHome([[".dsh/settings.yaml", "locale:\n  preference: zh\n"]]);
    const { lines } = await run(home, "install");
    check("没有 profile 就是未检测到", lines.some((l) => l.includes("未检测到")) && !fs.existsSync(path.join(home, ".dsh", "profiles")));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1mAntigravity：空配置文件 + 和 Gemini CLI 共用 ~/.gemini\x1b[0m");
{
  const REL = ".gemini/config/mcp_config.json";
  const home = makeHome([
    [REL, ""],
    [".gemini/config/.migrated", ""],
    [".gemini/settings.json", canonicalJson({ theme: "dark", mcpServers: {} })],
  ]);

  const ins = await quiet(() => runAgents("install", { ...opts(home), agents: ["antigravity"] }));
  const written = JSON.parse(fs.readFileSync(path.join(home, REL), "utf8"));
  check("0 字节的配置文件按 {} 算，照样注册得上", !!written.mcpServers?.["agent-in-chrome"], JSON.stringify(written));
  check(
    "GUI 应用走 launcher（拿不到终端 PATH），同 Claude Desktop / Trae",
    written.mcpServers["agent-in-chrome"].command === path.join(ROOT, "bin", "agent-in-chrome.mjs"),
    JSON.stringify(written.mcpServers["agent-in-chrome"])
  );
  check("装的是 antigravity 这一家", ins.value.installed.includes("antigravity"), JSON.stringify(ins.value));
  check("改动前留了备份", backupsOf(home, REL).length >= 1);
  check("Gemini CLI 的 settings.json 没被顺手改（--agents 只圈了 antigravity）", fs.readFileSync(path.join(home, ".gemini/settings.json"), "utf8").includes('"theme": "dark"') && !fs.readFileSync(path.join(home, ".gemini/settings.json"), "utf8").includes("agent-in-chrome"));

  const chk = await quiet(() => runAgents("check", { ...opts(home), agents: ["antigravity"] }));
  check("check 认得出已注册", chk.lines.some((l) => /Antigravity: 已注册/.test(l)), chk.lines.join("\n"));

  await quiet(() => runAgents("uninstall", { ...opts(home), agents: ["antigravity"] }));
  const after = JSON.parse(fs.readFileSync(path.join(home, REL), "utf8"));
  check("卸载把我们那一个键摘干净（它自己 read-merge-write 这份文件，别的键不能动）", !after.mcpServers?.["agent-in-chrome"], JSON.stringify(after));
  const chk2 = await quiet(() => runAgents("check", { ...opts(home), agents: ["antigravity"] }));
  check("卸载后 check 报未注册", chk2.lines.some((l) => /Antigravity: 未注册/.test(l)), chk2.lines.join("\n"));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const onlyGemini = makeHome([[".gemini/settings.json", canonicalJson({ mcpServers: {} })], [".gemini/oauth_creds.json", "{}"]]);
  const ids = (home) => buildAgents({ ...opts(home) }).filter((a) => a.detected).map((a) => a.id);
  check("只装了 Gemini CLI 的机器不会被误判成装了 Antigravity", !ids(onlyGemini).includes("antigravity") && ids(onlyGemini).includes("gemini"), ids(onlyGemini).join(","));
  fs.rmSync(onlyGemini, { recursive: true, force: true });

  const withAg = makeHome([[".gemini/config/mcp_config.json", ""]]);
  check("有 ~/.gemini/config 目录就认", buildAgents({ ...opts(withAg) }).find((a) => a.id === "antigravity")?.detected === true);
  fs.rmSync(withAg, { recursive: true, force: true });
}
{
  const home = makeHome([[".gemini/config/mcp_config.json", "  \n\t "], [".kimi/mcp.json", "{ 这不是 JSON"]]);
  const r = await quiet(() => runAgents("install", { ...opts(home), agents: ["antigravity", "kimi"] }));
  check("纯空白的配置文件也按 {} 算", !!JSON.parse(fs.readFileSync(path.join(home, ".gemini/config/mcp_config.json"), "utf8")).mcpServers?.["agent-in-chrome"]);
  check("坏 JSON 照旧拒写、原样留着", fs.readFileSync(path.join(home, ".kimi/mcp.json"), "utf8") === "{ 这不是 JSON");
  check("坏 JSON 那家算失败，不拖累别家", r.value.failed.includes("kimi") && r.value.installed.includes("antigravity"), JSON.stringify(r.value));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const listed = (install.FLAGS_USAGE.match(/--agents=a,b[\s\S]*?--no-agents/) || [""])[0]
    .split(/[\s、，,]+/)
    .filter((w) => /^[a-z][a-z-]+$/.test(w));
  const all = buildAgents({ home: "/nonexistent-home", platform: "linux", serverPath: SERVER_PATH, mcpLauncher: SERVER_PATH }).map((a) => a.id);
  const missing = all.filter((id) => !listed.includes(id));
  check("--agents 的帮助文本列全了每一家（漏了就没法单独装它）", missing.length === 0, `漏：${missing.join(",")}`);
}

console.log("\n\x1b[1m--check 的 socket 权限体检：按 defaultSockName 的规则枚举\x1b[0m");
{
  const { listSocks } = await import("./install.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-socks-"));
  for (const n of [
    "agent-in-chrome.sock",
    "agent-in-chrome-cli.sock",
    "agent-in-chrome-cli-1a2b3c4d.sock",
    "token",
    "agent-in-chrome.log",
  ])
    fs.writeFileSync(path.join(dir, n), "");
  const found = listSocks(dir).map(([, p]) => path.basename(p));
  check(
    "派生名的 sock 也在体检范围里",
    found.includes("agent-in-chrome-cli-1a2b3c4d.sock"),
    JSON.stringify(found)
  );
  check("三条 sock 都枚举到了", found.length === 3, JSON.stringify(found));
  check("同目录的非 sock 文件不进来", !found.some((n) => n === "token" || n.endsWith(".log")), JSON.stringify(found));
  check("桌面那条的标签仍然是「桌面」", listSocks(dir).find(([, p]) => p.endsWith("/agent-in-chrome.sock"))?.[0] === "桌面");
  check("目录不存在时返回空数组，不抛", JSON.stringify(listSocks(path.join(dir, "没有这个目录"))) === "[]");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mQoder IDE：SharedClientCache 的位置按平台分\x1b[0m");
{
  const home = makeHome([["AppData/Roaming/Qoder/SharedClientCache/mcp.json", "{}\n"], [".qoder/mcp.json", "{}\n"]]);
  const { lines } = await quiet(() =>
    runAgents("install", { ...opts(home), platform: "win32", agents: ["qoder-ide"] })
  );
  const b = path.join(home, "AppData", "Roaming", "Qoder", "SharedClientCache", "mcp.json");
  check(
    "win32 上 B 存在就写 B（不是退回 A）",
    !!JSON.parse(fs.readFileSync(b, "utf8"))?.mcpServers?.["agent-in-chrome"],
    fs.readFileSync(b, "utf8")
  );
  check(
    "A 那份不动（它只是首启迁移源）",
    !JSON.parse(fs.readFileSync(path.join(home, ".qoder", "mcp.json"), "utf8"))?.mcpServers,
    lines.join("\n").slice(0, 200)
  );
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m终端多选清单\x1b[0m");

function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}
const sink = () => ({ write: () => {} });
const items = [{ label: "A" }, { label: "B" }, { label: "C" }];

async function drive(keys) {
  const input = fakeTty();
  const p = pickMulti(items, { input, output: sink(), platform: "linux" });
  await new Promise((r) => setImmediate(r));
  for (const k of keys) {
    input.emit("keypress", k.str ?? "", k);
    await new Promise((r) => setImmediate(r));
  }
  return p;
}

check("默认全选，回车直接确认", JSON.stringify(await drive([{ name: "return" }])) === "[0,1,2]");
check(
  "空格取消当前项",
  JSON.stringify(await drive([{ name: "space", str: " " }, { name: "return" }])) === "[1,2]"
);
check(
  "下移再取消，去掉的是第二项",
  JSON.stringify(await drive([{ name: "down" }, { name: "space", str: " " }, { name: "return" }])) === "[0,2]"
);
check("a 键全不选（默认是全选，按一次翻面）", JSON.stringify(await drive([{ name: "a" }, { name: "return" }])) === "[]");
check("a 键按两次回到全选", JSON.stringify(await drive([{ name: "a" }, { name: "a" }, { name: "return" }])) === "[0,1,2]");
check("上移在头部回绕到末项", JSON.stringify(await drive([{ name: "up" }, { name: "space", str: " " }, { name: "return" }])) === "[0,1]");
check("Ctrl-C 返回 null（取消，不是全不选）", (await drive([{ name: "c", ctrl: true }])) === null);
check("Esc 返回 null", (await drive([{ name: "escape" }])) === null);
check("无关按键不影响结果", JSON.stringify(await drive([{ name: "x" }, { name: "f5" }, { name: "return" }])) === "[0,1,2]");

{
  const notTty = new PassThrough();
  const r = await pickMulti(items, { input: notTty, output: sink() });
  check("非 TTY：不进交互，直接返回默认全选", JSON.stringify(r) === "[0,1,2]");
}
{
  const notTty = new PassThrough();
  const r = await pickMulti(items, { input: notTty, output: sink(), selected: [true, false, true] });
  check("非 TTY：尊重传入的默认勾选", JSON.stringify(r) === "[0,2]");
}
check("空清单直接返回空", JSON.stringify(await pickMulti([], { input: fakeTty(), output: sink() })) === "[]");

console.log("\n\x1b[1m运行时同步：原子替换 + 镜像语义\x1b[0m");

function runInstaller(args, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), ...args], {
      env,
      encoding: "utf8",
      timeout: 180000,
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

function fakeBrowserDir(home) {
  const d =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Google", "Chrome")
      : path.join(home, ".config", "google-chrome");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function nextJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      stream.off("data", onData);
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (e) {
        reject(new Error(`不是 JSON：${buf.slice(0, 200)}`));
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("close", () => reject(new Error(`子进程没吐出结果就退了：${buf.slice(0, 200)}`)));
  });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-runtime-"));
  SANDBOX_HOMES.push(home);
  fakeBrowserDir(home);
  const RT = path.join(home, ".agent-in-chrome", "agent-in-chrome");
  const serverRt = path.join(RT, "server.mjs");

  const first = runInstaller(["--yes", "--no-agents"], home);
  check("受控 HOME 里装得起来（退出码 0）", first.status === 0, first.out.slice(-400));
  check("运行时里有 server.mjs", fs.existsSync(serverRt));

  const SENTINEL = "// 上一版（哨兵）\n";
  fs.writeFileSync(serverRt, SENTINEL);
  const oldIno = String(fs.statSync(serverRt).ino);

  const holderSrc = path.join(home, "holder.mjs");
  fs.writeFileSync(
    holderSrc,
    `import fs from "node:fs";
import { pathToFileURL } from "node:url";
const target = process.argv[2];
const liveModule = process.argv[3];
await import(pathToFileURL(liveModule).href); // 真的在跑运行时里的代码
const fd = fs.openSync(target, "r");
const st0 = fs.fstatSync(fd);
let enoent = 0, samples = 0;
const inos = new Set();
const timer = setInterval(() => {
  samples++;
  try { inos.add(String(fs.statSync(target).ino)); }
  catch (e) { if (e.code === "ENOENT") enoent++; }
}, 1);
process.stdout.write(JSON.stringify({ ready: true, ino: String(st0.ino) }) + "\\n");
process.stdin.on("data", () => {
  clearInterval(timer);
  const st = fs.fstatSync(fd);
  const buf = Buffer.alloc(st.size);
  fs.readSync(fd, buf, 0, st.size, 0);
  process.stdout.write(JSON.stringify({ heldIno: String(st.ino), held: buf.toString("utf8"), enoent, samples, inos: [...inos] }) + "\\n");
  process.exit(0);
});
`
  );
  const holder = spawn(process.execPath, [holderSrc, serverRt, path.join(RT, "session-id.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const ready = await nextJsonLine(holder.stdout);
  check("替换前：子进程握住的就是那个 inode", ready.ino === oldIno, `${ready.ino} vs ${oldIno}`);

  const second = runInstaller(["--yes", "--no-agents"], home);
  check("有进程正握着运行时文件时，重装照样成功", second.status === 0, second.out.slice(-400));

  holder.stdin.write("go\n");
  const held = await nextJsonLine(holder.stdout);
  const srcText = fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8");
  const newIno = String(fs.statSync(serverRt).ino);

  check("替换后：旧进程读到的仍是旧 inode", held.heldIno === oldIno, `${held.heldIno} vs ${oldIno}`);
  check("旧 inode 的内容一个字没被动过（不是原地截断重写）", held.held === SENTINEL, JSON.stringify(held.held.slice(0, 80)));
  check("新文件是另一个 inode", newIno !== oldIno, `${newIno} vs ${oldIno}`);
  check("新文件的内容就是仓库里的源码", fs.readFileSync(serverRt, "utf8") === srcText);
  check(
    `替换过程没有缺失窗口（${held.samples} 次 stat 全部命中）`,
    held.enoent === 0 && held.samples > 20,
    `ENOENT ${held.enoent} 次 / 共 ${held.samples} 次`
  );
  check(
    "采样窗口确实跨过了那次替换（旧新 inode 都采到了）",
    held.inos.includes(oldIno) && held.inos.includes(newIno),
    `采到 ${JSON.stringify(held.inos)}，旧 ${oldIno} 新 ${newIno}`
  );
  check("替换用的临时文件没留下", fs.readdirSync(RT).filter((f) => f.includes(".incoming-")).length === 0, fs.readdirSync(RT).join(","));

  const stale = [
    ["zombie.mjs", path.join(RT, "zombie.mjs")],
    ["cdp/zombie.mjs", path.join(RT, "cdp", "zombie.mjs")],
    ["extension/stale.js", path.join(RT, "extension", "stale.js")],
  ];
  for (const [, f] of stale) fs.writeFileSync(f, "// 上一版留下的\n");
  const keepProfile = path.join(RT, "cli-profile", "Default", "Cookies");
  fs.mkdirSync(path.dirname(keepProfile), { recursive: true });
  fs.writeFileSync(keepProfile, "用户的登录态");
  const keepProfileMjs = path.join(RT, "cli-profile", "手工.mjs");
  fs.writeFileSync(keepProfileMjs, "// profile 里的，照样不许碰");
  const keepLauncher = path.join(RT, "mcp-launcher-headless.sh");
  fs.writeFileSync(keepLauncher, "#!/bin/sh\n# 人手工建的\n");

  const third = runInstaller(["--yes", "--no-agents"], home);
  check("再装一次仍是 0", third.status === 0, third.out.slice(-400));
  for (const [label, f] of stale) check(`陈旧文件被清掉：${label}`, !fs.existsSync(f));
  check("清掉的文件在输出里点了名", /清掉运行时里已不在清单中的旧文件/.test(third.out), third.out.slice(-300));
  check("cli-profile 里的用户数据没被碰", fs.existsSync(keepProfile) && fs.existsSync(keepProfileMjs));
  check("手工建的启动器没被碰", fs.existsSync(keepLauncher));
  const manifestOk = ["host.mjs", "server.mjs", "token.mjs", "session-id.mjs", path.join("cdp", "bridge.mjs"), path.join("extension", "sw.js"), path.join("extension", "manifest.json")].filter(
    (r) => !fs.existsSync(path.join(RT, r))
  );
  check("清单内的文件都还在", manifestOk.length === 0, manifestOk.join("、"));

  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n\x1b[1m退出码：--check 报了红就得非零退出\x1b[0m");
{
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "aic-exit-"));
  SANDBOX_HOMES.push(fresh);
  const red = runInstaller(["--check"], fresh);
  check("必红的自检退出码是 1", red.status === 1, `status=${red.status}\n${red.out.slice(-300)}`);
  check("红的条数也说了出来", /项没过/.test(red.out), red.out.slice(-300));
  fakeBrowserDir(fresh);
  const green = runInstaller(["--yes", "--no-agents"], fresh);
  check("全绿的安装退出码是 0", green.status === 0, `status=${green.status}\n${green.out.slice(-400)}`);
  check("全绿时不打「项没过」", !/项没过/.test(green.out), green.out.slice(-200));

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "aic-bare-"));
  SANDBOX_HOMES.push(bare);
  const pos = runInstaller(["check"], bare);
  check("裸位置参数被拒", pos.status === 2 && /不认识的旗标/.test(pos.out), `status=${pos.status}\n${pos.out.slice(0, 200)}`);
  check("被拒的那次没有落盘副作用", !fs.existsSync(path.join(bare, ".agent-in-chrome")), fs.readdirSync(bare).join(","));
  const spaced = runInstaller(["--agents", "kimi"], bare);
  check("`--agents kimi`（该用等号）也被拒，不会静默变成注册全部", spaced.status === 2 && /kimi/.test(spaced.out), `status=${spaced.status}\n${spaced.out.slice(0, 200)}`);

  check("parseFlags：裸参数进 unknown", JSON.stringify(install.parseFlags(["check"]).unknown) === '["check"]');
  check("parseFlags：认得的旗标不进 unknown", install.parseFlags(["--check", "--yes", "--agents=kimi"]).unknown.length === 0);
  check("parseFlags：--agents= 仍解析得出", JSON.stringify(install.parseFlags(["--agents=a,b"]).agents) === '["a","b"]');

  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
}

console.log("\n\x1b[1mWindows 的 GUI 条目形状：cmd /c\x1b[0m");
{
  const WIN_LAUNCHER = "C:\\Users\\me\\.agent-in-chrome\\agent-in-chrome\\mcp-launcher.bat";
  const winAgents = buildAgents({ home: "/nonexistent-home", platform: "win32", serverPath: "C:\\rt\\server.mjs", mcpLauncher: WIN_LAUNCHER });
  const darwinAgents = buildAgents({ home: "/nonexistent-home", platform: "darwin", serverPath: "/rt/server.mjs", mcpLauncher: "/rt/mcp-launcher.sh" });
  const entryOf = (list, id) => {
    const p = list.find((a) => a.id === id)?.preview;
    return JSON.stringify((typeof p === "function" ? p() : p) || []);
  };
  for (const id of ["claude-desktop", "workbuddy", "zcode", "antigravity", "qoder-ide", "trae", "qoder-ide-cn", "trae-cn"]) {
    const p = entryOf(winAgents, id);
    check(`${id}：win32 上是 cmd /c 包一层`, p.includes('\\"command\\": \\"cmd\\"') && p.includes("/c") && p.includes("mcp-launcher.bat"), p.slice(0, 200));
  }
  check(
    "dsh 也跟着包（它同样是拿不到终端 PATH 的常驻进程）",
    entryOf(winAgents, "deepseek-harness").includes("command: 'cmd'") &&
      entryOf(winAgents, "deepseek-harness").includes("args: ['/c'"),
    entryOf(winAgents, "deepseek-harness")
  );
  check("CLI 客户端不受影响（还是 node + server.mjs）", entryOf(winAgents, "kimi").includes('\\"command\\": \\"node\\"'), entryOf(winAgents, "kimi"));
  for (const id of ["claude-desktop", "workbuddy", "zcode", "trae"]) {
    const p = entryOf(darwinAgents, id);
    check(`${id}：darwin 形状不变（command 就是启动器本身）`, p.includes("/rt/mcp-launcher.sh") && !p.includes("cmd"), p.slice(0, 200));
  }
}

{
  const home = makeHome([]);
  const launcher = path.join(home, "mcp-launcher.bat");
  fs.writeFileSync(launcher, "@echo off\r\n");
  fs.chmodSync(launcher, 0o755);
  const cfgRel = path.join("AppData", "Roaming", "Claude", "claude_desktop_config.json");
  const cfg = path.join(home, cfgRel);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, canonicalJson({ mcpServers: { "agent-in-chrome": { command: "cmd", args: ["/c", launcher] } } }));
  const winOpts = { home, platform: "win32", serverPath: SERVER_PATH, mcpLauncher: launcher, yes: true, agents: ["claude-desktop"] };
  const r = await quiet(() => runAgents("check", winOpts));
  const said = r.lines.join("\n");
  check("win32 的 check 认得出「已注册」", /Claude Desktop: 已注册/.test(said), said.slice(-300));
  check("check 不再去找一个叫 /c 的文件", !/\/c 不存在/.test(said), said.slice(-300));

  fs.writeFileSync(cfg, canonicalJson({ mcpServers: { keepme: { command: "keep" }, "agent-in-chrome": { command: launcher, args: [] } } }));
  await quiet(() => runAgents("install", winOpts));
  const after = JSON.parse(fs.readFileSync(cfg, "utf8"));
  check("旧形状被更新成 cmd /c", after.mcpServers["agent-in-chrome"].command === "cmd" && after.mcpServers["agent-in-chrome"].args[0] === "/c" && after.mcpServers["agent-in-chrome"].args[1] === launcher, JSON.stringify(after));
  check("更新时别人的键没动", after.mcpServers.keepme?.command === "keep", JSON.stringify(after));
  check("更新前留了备份", backupsOf(home, cfgRel).length >= 1, backupsOf(home, cfgRel).join(","));
  const n = backupsOf(home, cfgRel).length;
  const again = await quiet(() => runAgents("install", winOpts));
  check("已是新形状时不写也不备份", backupsOf(home, cfgRel).length === n && again.lines.join("\n").includes("已是最新"), again.lines.join("\n").slice(-200));
}

console.log("\n\x1b[1mclaude mcp add：子进程继承调用方的 HOME\x1b[0m");
{
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-fakeclaude-"));
  const fake = path.join(binDir, "claude");
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$HOME" "$@" >> "$HOME/claude-cli.log"\n`);
  fs.chmodSync(fake, 0o755);
  const home = makeHome([]);
  const realPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  try {
    await quiet(() => runAgents("install", { ...opts(home), agents: ["claude-code"] }));
  } finally {
    process.env.PATH = realPath;
  }
  const log = readOr(path.join(home, "claude-cli.log")) || "";
  check("claude 子进程看到的 HOME 是我们给的那个假 home", log.split("\n")[0] === home, JSON.stringify(log.slice(0, 200)));
  check("真的把 mcp add 发出去了", log.includes("mcp") && log.includes("add") && log.includes(SERVER_PATH), JSON.stringify(log.slice(0, 300)));
  check("真实 HOME 下没有被写出日志（没走穿）", !fs.existsSync(path.join(REAL_HOME, "claude-cli.log")));
  fs.rmSync(binDir, { recursive: true, force: true });
}

{
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-fakecmd-"));
  const spaced = path.join(binDir, "bin dir (x86)");
  fs.mkdirSync(spaced, { recursive: true });
  const fake = path.join(spaced, "claude.cmd");
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$HOME" "$@" >> "$HOME/claude-cli.log"\n`);
  fs.chmodSync(fake, 0o755);
  const home = makeHome([]);
  const srvDir = path.join(binDir, "srv dir");
  fs.mkdirSync(srvDir, { recursive: true });
  const serverPath = path.join(srvDir, "server.mjs");
  fs.writeFileSync(serverPath, "");
  const realPath = process.env.PATH;
  process.env.PATH = `${spaced}${path.delimiter}${realPath}`;
  let said = "";
  try {
    const r = await quiet(() =>
      runAgents("install", { home, platform: "win32", serverPath, mcpLauncher: path.join(home, "mcp-launcher.bat"), yes: true, agents: ["claude-code"] })
    );
    said = r.lines.join("\n");
  } finally {
    process.env.PATH = realPath;
  }
  const lines = (readOr(path.join(home, "claude-cli.log")) || "").split("\n");
  check("win32 的 .cmd shim 这条路真的跑起来了（不是退回直接编辑）", /claude mcp add 完成/.test(said), said.slice(-300));
  check(".cmd 子进程看到的也是我们给的 HOME", lines[0] === home, JSON.stringify(lines.slice(0, 3)));
  check("带空格和括号的路径原样到达（引号是自己加的）", lines.includes(serverPath), JSON.stringify(lines));
  check("stderr 上没有 DEP0190 弃用警告（整条命令拼成字符串走的）", !/DEP0190/.test(said), said.slice(-200));
  fs.rmSync(binDir, { recursive: true, force: true });
}

console.log("\n\x1b[1m探测：没有证据就不算装着\x1b[0m");
{
  const empty = path.join(os.tmpdir(), `aic-empty-${process.pid}-${Date.now()}`);
  const detected = buildAgents({ home: empty, platform: "linux", serverPath: SERVER_PATH, mcpLauncher: SERVER_PATH }).filter((a) => a.detected);
  const noEvidence = detected.filter((a) => !a.binOnPath);
  check("没有任何证据时不会认出客户端", noEvidence.length === 0, noEvidence.map((a) => a.id).join(",") || "none");
  check("探测本身不给不存在的客户端建目录", !fs.existsSync(empty), fs.existsSync(empty) ? fs.readdirSync(empty).join(",") : "什么都没建");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "aic-onpath-"));
  fs.writeFileSync(path.join(fakeBin, "kimi"), "#!/bin/sh\n");
  fs.chmodSync(path.join(fakeBin, "kimi"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${realPath}`;
  const withBin = buildAgents({ home: empty, platform: "linux", serverPath: SERVER_PATH, mcpLauncher: SERVER_PATH }).find((a) => a.id === "kimi");
  process.env.PATH = realPath;
  const withoutBin = buildAgents({ home: empty, platform: "linux", serverPath: SERVER_PATH, mcpLauncher: SERVER_PATH }).find((a) => a.id === "kimi");
  check("PATH 上有二进制时 binOnPath 为真", withBin.binOnPath === true && withBin.detected === true);
  check("撤掉之后就为假（这个字段不是恒真的摆设）", withoutBin.binOnPath === false, `本机 PATH 上是不是真装着 kimi：${withoutBin.binOnPath}`);
  fs.rmSync(fakeBin, { recursive: true, force: true });
}

function diffHint(a, b) {
  if (a === b) return "";
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `第 ${i} 个字符起不同：期望 ${JSON.stringify(a.slice(i, i + 40))}，实际 ${JSON.stringify(b.slice(i, i + 40))}`;
  return "";
}

{
  const leaked = GUARDED.filter((f) => {
    const now = readOr(f);
    if (f === LIVE_WRITTEN)
      return entrySnapshot(now) !== REAL_ENTRY_BEFORE[f] || SANDBOX_HOMES.some((h) => (now || "").includes(h));
    return now !== REAL_SNAPSHOT[f];
  });
  check(
    "SAFETY: 跑完这一轮，真实客户端配置一个字没动",
    leaked.length === 0,
    leaked.length ? `${leaked.join("、")} —— 发版前先查清楚` : "clean"
  );
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} 通过，${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);
