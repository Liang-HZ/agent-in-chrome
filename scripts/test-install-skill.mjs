#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as install from "./install.mjs";
import { buildAgents } from "./agents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "scripts", "install.mjs");
const BIN = path.join(ROOT, "bin", "agent-in-chrome.mjs");
const SKILL_DIR = path.join(ROOT, "skills", "install-agent-in-chrome");
const SKILL = path.join(SKILL_DIR, "SKILL.md");
const COMMAND = path.join(ROOT, "commands", "install-agent-in-chrome.md");
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aic-skill-home-"));
fs.mkdirSync(
  process.platform === "darwin"
    ? path.join(FAKE_HOME, "Library", "Application Support", "Google", "Chrome")
    : process.platform === "win32"
      ? path.join(FAKE_HOME, "AppData", "Local", "Google", "Chrome", "User Data")
      : path.join(FAKE_HOME, ".config", "google-chrome"),
  { recursive: true },
);
process.on("exit", () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));

const RUNTIME_DIR = path.join(FAKE_HOME, ".agent-in-chrome", "agent-in-chrome");

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

const runInstaller = (args) =>
  spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
  });

const skillText = fs.readFileSync(SKILL, "utf8");
const commandText = fs.readFileSync(COMMAND, "utf8");

console.log("\n\x1b[1m--print-config：三种格式都得是能直接用的东西\x1b[0m");

const jsonRun = runInstaller(["--check", "--print-config"]);
check("json：退出码 0", jsonRun.status === 0, `status=${jsonRun.status} stderr=${(jsonRun.stderr || "").slice(0, 200)}`);

let facts = null;
try {
  facts = JSON.parse(jsonRun.stdout);
} catch (e) {
  check("json：stdout 整份都能 JSON.parse（不许掺一个字的杂音）", false, String(e.message).slice(0, 160));
}
if (facts) {
  check("json：stdout 整份都能 JSON.parse（不许掺一个字的杂音）", true);
  check("默认格式就是 json（不带 =xxx 时）", typeof facts === "object" && !!facts.mcp);
  check("有版本号，且和 package.json 一致", facts.version === JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, facts.version);
  check("runtimeDir / serverPath 都是绝对路径", path.isAbsolute(facts.runtimeDir || "") && path.isAbsolute(facts.serverPath || ""), `${facts.runtimeDir} / ${facts.serverPath}`);
  check("server 名字就是 agent-in-chrome（配置里那个键）", facts.mcp.name === "agent-in-chrome", facts.mcp.name);

  for (const [k, e] of Object.entries({ launcher: facts.mcp.launcher, npx: facts.mcp.npx })) {
    check(
      `mcp.${k} 是 {command,args,env} 三件套且 command 非空`,
      !!e && typeof e.command === "string" && e.command.length > 0 && Array.isArray(e.args) && !!e.env && typeof e.env === "object",
      JSON.stringify(e)
    );
  }
  check(
    "mcp.npx 用的是 package.json 的包名（带 scope），不是配置里那个键",
    `${facts.mcp.npx.command} ${facts.mcp.npx.args.join(" ")}` === `npx -y ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name} serve`,
    JSON.stringify(facts.mcp.npx)
  );

  check("extension.dir 是绝对路径", path.isAbsolute(facts.extension?.dir || ""), facts.extension?.dir);
  check("extension.id 是 32 位扩展 ID", /^[a-p]{32}$/.test(facts.extension?.id || ""), facts.extension?.id);
  check("extension.ids 至少含开发版那个（host 清单按它逐个枚举）", Array.isArray(facts.extension?.ids) && facts.extension.ids[0] === facts.extension.id);
  check("storeUrl 要么是 null 要么是商店链接（不许是空串这种半吊子）", facts.extension?.storeUrl === null || /^https:\/\//.test(facts.extension?.storeUrl || ""), String(facts.extension?.storeUrl));

  check("nativeHost.name 是 host 清单里那个名字", facts.nativeHost?.name === "org.liangai.agent_in_chrome", facts.nativeHost?.name);
  const manifestPaths = Object.values(facts.nativeHost?.manifestPaths || {});
  check("nativeHost.manifestPaths 至少一个浏览器，且都是绝对路径", manifestPaths.length > 0 && manifestPaths.every((p) => path.isAbsolute(p)), JSON.stringify(facts.nativeHost?.manifestPaths));

  check("agents 是数组且不为空", Array.isArray(facts.agents) && facts.agents.length > 0, String(facts.agents?.length));
  const badAgent = (facts.agents || []).find(
    (a) => typeof a.id !== "string" || typeof a.name !== "string" || typeof a.detected !== "boolean" || typeof a.configPath !== "string" || typeof a.registered !== "boolean"
  );
  check("agents 每一项都是 {id,name,detected,configPath,registered}", !badAgent, JSON.stringify(badAgent));
  const realIds = buildAgents({ serverPath: facts.serverPath, mcpLauncher: facts.mcp.launcher.command }).map((a) => a.id);
  check(
    "agents 的 id 清单和 buildAgents 完全一致（不是另编的一份）",
    JSON.stringify(facts.agents.map((a) => a.id)) === JSON.stringify(realIds),
    JSON.stringify(facts.agents.map((a) => a.id))
  );
}

const tomlRun = runInstaller(["--check", "--print-config=toml"]);
check("toml：退出码 0", tomlRun.status === 0, `status=${tomlRun.status}`);
{
  const lines = tomlRun.stdout.split("\n");
  const live = lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
  check("toml：有 [mcp_servers.agent-in-chrome] 这张表", live.some((l) => l.trim() === "[mcp_servers.agent-in-chrome]"), JSON.stringify(live.slice(0, 3)));
  check("toml：有一行 command =", live.some((l) => /^command\s*=\s*".+"$/.test(l.trim())), JSON.stringify(live));
  check("toml：有一行 args =", live.some((l) => /^args\s*=\s*\[/.test(l.trim())));
  check("toml：只有一张活着的同名表（另一种启动方式是注释）", live.filter((l) => l.trim().startsWith("[mcp_servers.")).length === 1);
  check("toml：注释里给了 npx 那条启动方式", tomlRun.stdout.includes("# command = \"npx\""), tomlRun.stdout.slice(-200));
  check("toml：没有非注释的杂音行（每一行不是注释就得是配置）", live.every((l) => /^\[|^\w+\s*=/.test(l.trim())), JSON.stringify(live));
}

const cliRun = runInstaller(["--check", "--print-config=claude-cli"]);
check("claude-cli：退出码 0", cliRun.status === 0, `status=${cliRun.status}`);
check("claude-cli：stdout 第一行就是 claude mcp add", cliRun.stdout.startsWith("claude mcp add"), JSON.stringify(cliRun.stdout.split("\n")[0]));
check("claude-cli：命令里带 server 名", cliRun.stdout.split("\n")[0].includes("agent-in-chrome"));
check("claude-cli：命令里带 --scope user（不写就落进项目级，换个目录就没了）", cliRun.stdout.split("\n")[0].includes("--scope user"));
check(
  "claude-cli：除了那条命令，其余行要么空要么是 # 注释",
  cliRun.stdout.split("\n").slice(1).every((l) => !l.trim() || l.trim().startsWith("#")),
  JSON.stringify(cliRun.stdout.split("\n").slice(1))
);

console.log("\n\x1b[1mstdout 归配置，别的都走 stderr\x1b[0m");
for (const [fmt, r] of [["json", jsonRun], ["toml", tomlRun], ["claude-cli", cliRun]]) {
  check(`${fmt}：提示确实打在 stderr 上（不是没打）`, (r.stderr || "").includes("--print-config"), JSON.stringify((r.stderr || "").slice(0, 120)));
  check(`${fmt}：stdout 里没有安装器那套 ✓/✗/· 输出`, !/[✓✗·!]\s/.test(r.stdout), JSON.stringify(r.stdout.slice(0, 160)));
  check(`${fmt}：stdout 里没有 ANSI 颜色码（管道里那是垃圾字符）`, !r.stdout.includes("\x1b["));
}

console.log("\n\x1b[1m--print-config 不写任何文件\x1b[0m");
{
  const snapshot = (dir) => {
    const out = [];
    const walk = (p, rel) => {
      let ents;
      try {
        ents = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (childRel === "cli-profile") continue;
        const child = path.join(p, e.name);
        if (e.isDirectory()) {
          walk(child, childRel);
          continue;
        }
        let st;
        try {
          st = fs.statSync(child);
        } catch {
          continue;
        }
        out.push(`${childRel}\t${st.size}\t${st.mtimeMs}`);
      }
    };
    walk(dir, "");
    return out.join("\n");
  };

  const exists = fs.existsSync(RUNTIME_DIR);
  const before = exists ? snapshot(RUNTIME_DIR) : "";
  runInstaller(["--check", "--print-config"]);
  runInstaller(["--check", "--print-config=toml"]);
  const misuse = runInstaller(["--print-config"]);
  const after = exists ? snapshot(RUNTIME_DIR) : "";
  check("运行时目录里的文件、大小、mtime 全都没变", before === after, `目录=${RUNTIME_DIR}`);
  check(
    "运行时目录本来就不存在时也没被凭空建出来",
    exists || !fs.existsSync(RUNTIME_DIR),
    "这台机器上没装过，而 --print-config 把目录建出来了"
  );
  check("误用成 install 时也只是打印（退出码 0）", misuse.status === 0, `status=${misuse.status}`);
  let misuseJson = null;
  try {
    misuseJson = JSON.parse(misuse.stdout);
  } catch {}
  check("误用成 install 时 stdout 仍是干净的 JSON", !!misuseJson && misuseJson.mcp?.name === "agent-in-chrome");
  check("并且在 stderr 上说清楚了「什么都没装」", (misuse.stderr || "").includes("什么都没装"), JSON.stringify((misuse.stderr || "").slice(0, 200)));
}

console.log("\n\x1b[1m旗标解析\x1b[0m");
{
  check("--print-config 不带值 = json", install.parseFlags(["--check", "--print-config"]).printConfig === "json");
  check("--print-config=toml 认得", install.parseFlags(["--print-config=toml"]).printConfig === "toml");
  check("不带这个旗标时是 null（不能恒真）", install.parseFlags(["--check"]).printConfig === null);
  check("--print-config 不会被当成「不认识的旗标」", install.parseFlags(["--check", "--print-config=json"]).unknown.length === 0, JSON.stringify(install.parseFlags(["--check", "--print-config=json"]).unknown));
  check("走的是 check 那条路（mode 仍按旗标算）", install.parseFlags(["--check", "--print-config"]).mode === "check");

  const badFmt = runInstaller(["--check", "--print-config=yaml"]);
  check("认不出的格式：退出码 2（和「不认识的旗标」同级）", badFmt.status === 2, `status=${badFmt.status}`);
  check("认不出的格式：stdout 一个字都不出（别让管道拿到半份配置）", badFmt.stdout === "", JSON.stringify(badFmt.stdout));
  check("认不出的格式：stderr 说清楚认哪几种", /json/.test(badFmt.stderr) && /toml/.test(badFmt.stderr) && /claude-cli/.test(badFmt.stderr), JSON.stringify(badFmt.stderr.slice(0, 160)));
  check("PRINT_FORMATS 就是这三种", JSON.stringify(install.PRINT_FORMATS) === JSON.stringify(["json", "toml", "claude-cli"]));
}

console.log("\n\x1b[1mlauncher 条目的形状：print-config 与 agents.mjs 是同一份\x1b[0m");
{
  const trae = buildAgents({ serverPath: facts.serverPath, mcpLauncher: facts.mcp.launcher.command }).find((a) => a.id === "trae");
  const entry = JSON.parse(trae.preview.join("\n")).mcpServers["agent-in-chrome"];
  check(
    "print-config 的 mcp.launcher 和 agents.mjs 写给 GUI 客户端的条目一致",
    entry.command === facts.mcp.launcher.command && JSON.stringify(entry.args || []) === JSON.stringify(facts.mcp.launcher.args),
    `agents.mjs=${JSON.stringify(entry)} print-config=${JSON.stringify(facts.mcp.launcher)}`
  );
  check(
    "launcher 指的就是运行时目录里那个启动器",
    facts.mcp.launcher.command === path.join(facts.runtimeDir, process.platform === "win32" ? "mcp-launcher.bat" : "mcp-launcher.sh") ||
      (process.platform === "win32" && facts.mcp.launcher.args.includes(path.join(facts.runtimeDir, "mcp-launcher.bat"))),
    JSON.stringify(facts.mcp.launcher)
  );
}

console.log("\n\x1b[1m文档漂移：skill 里的每条命令都得存在\x1b[0m");
{
  const binSrc = fs.readFileSync(BIN, "utf8");
  const installerSrc = fs.readFileSync(INSTALLER, "utf8");

  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
  const PKG_RE = PKG.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const commandsIn = (text) => {
    const out = [];
    for (const m of text.matchAll(new RegExp(`npx ${PKG_RE}(?:@latest)?([^\\n\`|]*)`, "g"))) {
      const toks = m[1].split(/\s+/).filter(Boolean);
      const sub = toks.find((t) => !t.startsWith("-")) || null;
      const flags = toks.filter((t) => t.startsWith("--")).map((t) => (t.includes("=") ? t.slice(0, t.indexOf("=") + 1) : t));
      out.push({ sub, flags, raw: `npx ${PKG}${m[1]}`.trim() });
    }
    return out;
  };

  const calls = [...commandsIn(skillText), ...commandsIn(commandText)];
  check("skill 里确实写了 npx 命令（没有的话这组测试就白守了）", calls.length >= 4, String(calls.length));

  const badSub = calls.filter((c) => c.sub && !binSrc.includes(`"${c.sub}"`));
  check("每条命令的子命令 bin/agent-in-chrome.mjs 里都认得", badSub.length === 0, badSub.map((c) => c.raw).join(" / "));

  const allFlags = [...new Set(calls.flatMap((c) => c.flags))];
  const badFlags = allFlags.filter((f) => !installerSrc.includes(f));
  check(`每个旗标 scripts/install.mjs 里都认得（${allFlags.join(" ")}）`, badFlags.length === 0, badFlags.join(" "));

  check("上面那条判据不是恒真（编一个不存在的旗标必须落空）", !installerSrc.includes("--totally-not-a-flag="));

  const idsInSkill = [...skillText.matchAll(/--agents=([a-z0-9,-]+)/g)].flatMap((m) => m[1].split(","));
  const knownIds = new Set(buildAgents({ serverPath: facts.serverPath, mcpLauncher: facts.mcp.launcher.command }).map((a) => a.id));
  const badIds = idsInSkill.filter((id) => !knownIds.has(id));
  check("skill 里举例用的 agent id 都是真的", badIds.length === 0, badIds.join("、"));
}

console.log("\n\x1b[1m文档漂移：README / docs 里的 npx 子命令都得存在\x1b[0m");
{
  const binSrc = fs.readFileSync(BIN, "utf8");
  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
  const PKG_RE = PKG.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const DOCS = ["README.md", "README.en.md", "docs/CLI.md"];
  const subs = new Set();
  for (const rel of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(new RegExp(`npx ${PKG_RE}(?:@latest)?([^\\n\`|]*)`, "g"))) {
      const sub = m[1].split(/\s+/).filter(Boolean).find((t) => !t.startsWith("-"));
      if (sub) subs.add(sub);
    }
  }
  check(`文档里确实写了 npx 子命令（收到 ${[...subs].join(" ")}）`, subs.size >= 3, [...subs].join(" "));
  const bad = [...subs].filter((sub) => !binSrc.includes(`"${sub}"`));
  check("每个子命令 bin/agent-in-chrome.mjs 里都认得", bad.length === 0, bad.join(" / "));
  check("上面那条判据不是恒真（编一个不存在的子命令必须落空）", !binSrc.includes(`"frobnicate"`));

  const cli = fs.readFileSync(path.join(ROOT, "docs", "CLI.md"), "utf8");
  for (const sub of ["borrow-login", "cli-browser"]) {
    check(`docs/CLI.md 给了 ${sub} 的 npx 敲法`, cli.includes(`npx ${PKG} ${sub}`));
    check(`docs/CLI.md 也留着 ${sub} 的 git 检出敲法`, cli.includes(`node scripts/${sub}.mjs`));
    check(`bin 认得 ${sub} 子命令`, binSrc.includes(`cmd === "${sub}"`));
  }
}

console.log("\n\x1b[1mskill 与 command 的形状\x1b[0m");
{
  const frontmatter = (text) => {
    const lines = text.split("\n");
    if (lines[0].trim() !== "---") return null;
    const end = lines.indexOf("---", 1);
    if (end === -1) return null;
    const fm = {};
    for (const l of lines.slice(1, end)) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
      if (m) fm[m[1]] = m[2].trim();
    }
    return fm;
  };

  const sfm = frontmatter(skillText);
  check("SKILL.md 有合法的 frontmatter", !!sfm);
  check("skill 的 name 和目录名一致（不一致时客户端按目录名找，name 就成了摆设）", sfm?.name === path.basename(SKILL_DIR), sfm?.name);
  check("skill 有 description", (sfm?.description || "").length > 40, String(sfm?.description?.length));
  for (const kw of ["安装", "装不上", "配置", "自检", "install", "connect"])
    check(`description 里有触发词「${kw}」`, (sfm?.description || "").includes(kw));
  check("description 中英文都写了（英文触发词那半在）", /[a-z]{4,}/.test(sfm?.description || "") && /[一-龥]/.test(sfm?.description || ""));

  const cfm = frontmatter(commandText);
  check("command 有合法的 frontmatter", !!cfm);
  check("command 有 description", (cfm?.description || "").length > 5, String(cfm?.description));
  check("command 指向这个 skill", commandText.includes("install-agent-in-chrome"));

  const PRIVATE_DOCS = ["docs/" + "DESIGN" + ".md", "docs/" + "RUNBOOK" + ".md", "docs/" + "internal/"];
  for (const doc of PRIVATE_DOCS) check(`skill 里没有引用不公开的 ${doc}`, !skillText.includes(doc));
  const SCAN_RE = new RegExp("docs\\/internal|(?<![\\w-])(DE" + "SIGN|RUN" + "BOOK)\\.md");
  check("拼出来的就是隐私扫描认的那三个名字", PRIVATE_DOCS.length === 3 && PRIVATE_DOCS.every((d) => SCAN_RE.test(d)), PRIVATE_DOCS.join(" "));
  check("上面那条判据不是恒真（换个无关名字必须落空）", !SCAN_RE.test("docs/CLI.md"));

  const links = [...skillText.matchAll(/\]\((\.\.\/[^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  const deadLinks = links.filter((l) => !fs.existsSync(path.resolve(SKILL_DIR, l)));
  check(`skill 里的相对链接都指得到（${links.length} 条）`, deadLinks.length === 0, deadLinks.join("、"));
}

console.log("\n\x1b[1m安装器登记了这份 skill\x1b[0m");
{
  const assets = install.ASSETS || [];
  const skillAsset = assets.find((a) => a.from === SKILL_DIR);
  const cmdAsset = assets.find((a) => a.from === COMMAND);
  check("ASSETS 里有安装 skill", !!skillAsset, JSON.stringify(assets.map((a) => a.label)));
  check("ASSETS 里有 /install-agent-in-chrome 命令", !!cmdAsset);
  check("skill 资产指的是整个目录", !!skillAsset && fs.statSync(skillAsset.from).isDirectory());
  check("卸载时它有对应的移除路径（不然会留在用户盘上）", !!skillAsset?.removeWith);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-install-skill-"));
  try {
    install.copyAsset(skillAsset.from, path.join(tmp, "install-agent-in-chrome"));
    install.copyAsset(cmdAsset.from, path.join(tmp, "commands", "install-agent-in-chrome.md"));
    check("装完 SKILL.md 在", fs.existsSync(path.join(tmp, "install-agent-in-chrome", "SKILL.md")));
    check("装完命令文件在", fs.existsSync(path.join(tmp, "commands", "install-agent-in-chrome.md")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1mregistered 字段真的在读文件\x1b[0m");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-reg-"));
  const jsonFile = path.join(tmp, "mcp.json");
  fs.writeFileSync(jsonFile, JSON.stringify({ mcpServers: { "agent-in-chrome": { command: "node" } } }));
  check("JSON 配置里有我们的键 → true", install.configHasOurEntry(jsonFile) === true);

  fs.writeFileSync(jsonFile, JSON.stringify({ mcpServers: { "some-other": { command: "node" } } }));
  check("换成别人的键 → false（不是恒真）", install.configHasOurEntry(jsonFile) === false);

  fs.writeFileSync(jsonFile, JSON.stringify({ mcpServers: { "my-agent-in-chrome-2": { command: "node" } } }));
  check("JSON 里含而不等的键名不算我们的", install.configHasOurEntry(jsonFile) === false);

  const tomlFile = path.join(tmp, "config.toml");
  fs.writeFileSync(tomlFile, `[mcp_servers.agent-in-chrome]\ncommand = "node"\n`);
  check("TOML（没有零依赖解析器）走全文匹配 → true", install.configHasOurEntry(tomlFile) === true);
  fs.writeFileSync(tomlFile, `[mcp_servers.other]\ncommand = "node"\n`);
  check("TOML 里没有我们 → false", install.configHasOurEntry(tomlFile) === false);

  check("文件不存在 → false（不抛）", install.configHasOurEntry(path.join(tmp, "nope.json")) === false);

  check(
    "configPathsOf 拆得开多 profile",
    JSON.stringify(install.configPathsOf("/a/x.yml、/b/y.yml")) === JSON.stringify(["/a/x.yml", "/b/y.yml"])
  );
  check(
    "configPathsOf 剥得掉「（经 claude mcp add，scope: user）」这类说明",
    JSON.stringify(install.configPathsOf("/u/.claude.json（经 claude mcp add，scope: user）")) === JSON.stringify(["/u/.claude.json"])
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} 通过，${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);
