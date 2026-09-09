// Agent in Chrome — 把 MCP server 注册进本机装着的各个 agent
//
// 规矩，一条都不省：
//   - 探测 = 配置目录/文件真实存在（Claude Code 另认 PATH 上的 claude 二进制）。
//     没装的 agent 不注册、更不凭空建它的配置目录。
//   - 交互模式（TTY）下一屏列全、默认全选、回车确认（见 pick.mjs）；勾中的那些在
//     真正落盘前逐个把「哪个文件、写什么」原样打出来。
//     非交互（无 TTY，即 agent 代跑 / CI）或 --yes 时全部注册——那些场景没人在键盘前，
//     挂着等按键就是永远不返回。--agents=a,b 限定范围，--no-agents 全跳过。
//   - 改前备份成 <文件>.bak-<时间戳>；已是期望内容就不写也不备份（重跑不膨胀）。
//   - **同一家客户端不注册两遍**：Claude Desktop 的连接器和 Claude Code 的 user scope
//     注册同名，两条都在时桌面端里的 Claude Code 会话会被连接器抢走工具命名空间。
//     所以桌面端那条只在 user scope 注册不到位时才写，已经写过的会被主动摘掉。
//   - 只动 mcpServers["agent-in-chrome"]（Codex 是 [mcp_servers.agent-in-chrome] 表）
//     这一个键，文件里其他内容一个字不碰。卸载同理，只摘我们自己的键。
//   - 令牌内容任何时候不打印（这个模块根本不 import token.mjs，想打也打不了）。
//
// 零依赖：Codex 的 TOML 不引解析器，按「表头到下一个表头」做保守的整块替换/删除，
// 不重排、不重新格式化文件的其余部分。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickMulti } from "./pick.mjs";

const MCP_NAME = "agent-in-chrome";
const PKG_NAME = JSON.parse(
  fs.readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "package.json"), "utf8")
).name;
const MARKER = `# 由 agent-in-chrome 安装器管理（卸载：npx ${PKG_NAME} uninstall）`;

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[90m·\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
let agentProblems = 0;
/* agents.mjs 这一节数出来的 ✗ 条数（install.mjs 汇总用） */
export const agentProblemCount = () => agentProblems;
const bad = (s) => {
  agentProblems++;
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
};

const BACKUP_KEEP = 3;
const BACKUP_KEEP_UNINSTALL = 1;

function backupFile(file, keep = BACKUP_KEEP) {
  const b = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`;
  fs.copyFileSync(file, b);
  pruneBackups(file, keep);
  return b;
}

export function pruneBackups(file, keep = BACKUP_KEEP) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  let olds;
  try {
    olds = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  } catch {
    return [];
  }
  const doomed = olds.slice(0, Math.max(0, olds.length - keep));
  for (const f of doomed) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {}
  }
  return doomed;
}

function findOnPath(bin, platform = process.platform) {
  const names = platform === "win32" ? [bin, `${bin}.cmd`, `${bin}.exe`, `${bin}.bat`] : [bin];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

/*
 * 各家把 MCP server 放在配置里的**哪一段**，形状还都不一样，所以段落写成一条键路径：
 *
 *   Claude / Kimi / Gemini / WorkBuddy                     → ["mcpServers"]
 *   ZCode                                                  → ["mcp","servers"]
 *   opencode                                               → ["mcp"]（且条目形状也不同）
 */
const DEFAULT_SECTION = ["mcpServers"];

function getIn(obj, keyPath) {
  let cur = obj;
  for (const k of keyPath) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}
function setIn(obj, keyPath, value) {
  let cur = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keyPath[keyPath.length - 1]] = value;
}
function delIn(obj, keyPath) {
  const parent = getIn(obj, keyPath.slice(0, -1));
  if (parent && typeof parent === "object") delete parent[keyPath[keyPath.length - 1]];
}

const OUR_NAMES = [MCP_NAME, "zcode-in-chrome"];

/*
 * 按**名字**在整份配置里找出我们的条目，返回它们的路径（不按位置找：位置会变）。
 *
 * 只认**完全相等**的键名：`agent-in-chrome-2`、`my-agent-in-chrome` 这种含而不等的
 * 是别人的东西，一根汗毛都不能动。
 */
function findOurEntries(cfg, names = OUR_NAMES) {
  const found = [];
  const walk = (node, keyPath) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (names.includes(k)) found.push({ path: [...keyPath, k], name: k });
      else walk(v, [...keyPath, k]);
    }
  };
  walk(cfg, []);
  return found;
}

const previewJson = (entry, section = DEFAULT_SECTION) => {
  const shell = {};
  setIn(shell, [...section, MCP_NAME], entry);
  return JSON.stringify(shell, null, 2).split("\n");
};

function parseJsonOrEmpty(text) {
  const t = String(text ?? "").trim();
  return t ? JSON.parse(t) : {};
}

/* 写入/更新 mcpServers["agent-in-chrome"]，其余键原样保留。 */
function installJsonEntry(name, file, entry, { section = DEFAULT_SECTION } = {}) {
  const existed = fs.existsSync(file);
  let cfg = {};
  if (existed) {
    try {
      cfg = parseJsonOrEmpty(fs.readFileSync(file, "utf8"));
    } catch (e) {
      bad(`${name}: ${file} 不是合法 JSON（${e.message}），先修好再来，这次没动它`);
      return false;
    }
  }
  const cur = getIn(cfg, [...section, MCP_NAME]);
  if (cur && JSON.stringify(cur) === JSON.stringify(entry)) {
    ok(`${name}: 已是最新，未改动 ${file}`);
    return;
  }
  const backup = existed ? backupFile(file) : null;
  const stale = findOurEntries(cfg).filter((h) => h.path.join(".") !== [...section, MCP_NAME].join("."));
  for (const h of stale) delIn(cfg, h.path);
  setIn(cfg, [...section, MCP_NAME], entry);
  const out = JSON.stringify(cfg, null, 2) + "\n";
  JSON.parse(out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  ok(
    `${name}: 已写入 ${file} 的 ${section.join(".")}["${MCP_NAME}"]` +
      (stale.length ? `，顺带清掉 ${stale.length} 条旧的（${stale.map((h) => h.path.join(".")).join("、")}）` : "") +
      (backup ? `（备份 ${path.basename(backup)}）` : "（新建文件）")
  );
}

function checkJsonEntry(name, file, expected, { execCheck = false, section = DEFAULT_SECTION, target: targetOverride = null } = {}) {
  if (!fs.existsSync(file)) return bad(`${name}: 未注册（${file} 不存在）`);
  let cfg;
  try {
    cfg = parseJsonOrEmpty(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return bad(`${name}: ${file} 不是合法 JSON（${e.message}）`);
  }
  const cur = getIn(cfg, [...section, MCP_NAME]);
  if (!cur) return bad(`${name}: 未注册（${file} 里没有 ${section.join(".")}["${MCP_NAME}"]）`);
  const curCmd = Array.isArray(cur.command) ? cur.command[0] : cur.command;
  const expCmd = Array.isArray(expected.command) ? expected.command[0] : expected.command;
  const curArg1 = Array.isArray(cur.command) ? cur.command[1] : cur.args?.[0];
  const expArg1 = Array.isArray(expected.command) ? expected.command[1] : expected.args?.[0];
  const wrongCmd = curCmd !== expCmd;
  const wrongArgs = (expArg1 || null) !== (curArg1 ?? null);
  if (wrongCmd || wrongArgs)
    return warn(
      `${name}: 已注册但指向 ${curCmd} ${curArg1 || ""}（期望 ${expCmd} ${expArg1 || ""}），重装可修`
    );
  const target = targetOverride || expArg1 || expCmd;
  if (!fs.existsSync(target)) return warn(`${name}: 已注册但 ${target} 不存在，跑一次 install 即可`);
  if (execCheck && process.platform !== "win32" && !(fs.statSync(target).mode & 0o111)) return warn(`${name}: ${target} 没有可执行位`);
  ok(`${name}: 已注册，command 指向的文件存在${execCheck ? "且可执行" : ""}`);
}

function uninstallJsonEntry(name, file, { section = DEFAULT_SECTION } = {}) {
  if (!fs.existsSync(file)) return skip(`${name}: 配置文件不存在，本来就没注册`);
  let cfg;
  try {
    cfg = parseJsonOrEmpty(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return warn(`${name}: ${file} 不是合法 JSON（${e.message}），没动它`);
  }
  const hits = findOurEntries(cfg);
  if (!hits.length) return skip(`${name}: 本来就没注册`);
  const backup = backupFile(file, BACKUP_KEEP_UNINSTALL);
  for (const h of hits) delIn(cfg, h.path);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  const where = hits.map((h) => h.path.join(".")).join("、");
  ok(`${name}: 已从 ${file} 移除 ${where}（备份 ${path.basename(backup)}，其余内容未动）`);
}

const CODEX_HEADER_RE = new RegExp(
  `^\\s*\\[mcp_servers\\.(?:"(?:${OUR_NAMES.join("|")})"|(?:${OUR_NAMES.join("|")}))\\]\\s*$`
);

function codexBlock(serverPath) {
  return [MARKER, `[mcp_servers.${MCP_NAME}]`, `command = "node"`, `args = [${JSON.stringify(serverPath)}]`];
}

function codexFindBlock(lines) {
  const at = lines.findIndex((l) => CODEX_HEADER_RE.test(l));
  if (at === -1) return null;
  let start = at;
  while (start > 0 && lines[start - 1].trim().startsWith("#") && lines[start - 1].includes(MCP_NAME)) start--;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, headerAt: at };
}

/* 没有就追加，有就整块替换（表头到下一个表头），文件其余部分原样。 */
function codexUpsert(text, serverPath) {
  const block = codexBlock(serverPath);
  const lines = text.split("\n");
  const found = codexFindBlock(lines);
  if (!found) {
    const base = text.replace(/\n*$/, "");
    return (base ? base + "\n\n" : "") + block.join("\n") + "\n";
  }
  let end = found.end;
  const tail = [];
  while (end > found.headerAt + 1 && lines[end - 1].trim() === "") {
    tail.unshift(lines[end - 1]);
    end--;
  }
  return [...lines.slice(0, found.start), ...block, ...tail, ...lines.slice(found.end)].join("\n");
}

/* 只摘我们的表（含管理注释），返回 null 表示本来就没有。 */
function codexRemove(text) {
  let out = text.split("\n");
  let found = codexFindBlock(out);
  if (!found) return null;
  const seams = [];
  while (found) {
    out = [...out.slice(0, found.start), ...out.slice(found.end)];
    seams.push(found.start);
    found = codexFindBlock(out);
  }
  for (const at of seams.sort((a, b) => b - a)) {
    while (at > 0 && out[at - 1] === "" && out[at] === "") out.splice(at, 1);
  }
  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") out.pop();
  return out.join("\n");
}

function codexInstall(name, file, serverPath) {
  const existed = fs.existsSync(file);
  if (!existed) fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  const next = codexUpsert(text, serverPath);
  if (next === text) {
    ok(`${name}: 已是最新，未改动 ${file}`);
    return;
  }
  const backup = existed ? backupFile(file) : null;
  fs.writeFileSync(file, next);
  ok(
    `${name}: 已写入 ${file} 的 [mcp_servers.${MCP_NAME}] 表` +
      (backup ? `（备份 ${path.basename(backup)}，其余表未动）` : "（新建文件）")
  );
}

function codexCheck(name, file, serverPath) {
  if (!fs.existsSync(file)) return bad(`${name}: 未注册（${file} 不存在）`);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const found = codexFindBlock(lines);
  if (!found) return bad(`${name}: 未注册（${file} 里没有 [mcp_servers.${MCP_NAME}] 表）`);
  const block = lines.slice(found.start, found.end).join("\n");
  if (!/command\s*=\s*"node"/.test(block) || !block.includes(JSON.stringify(serverPath)))
    return warn(`${name}: 已注册但 command/args 不是期望值，重装可修`);
  if (!fs.existsSync(serverPath)) return warn(`${name}: 已注册但 ${serverPath} 不存在，跑一次 install 即可`);
  ok(`${name}: 已注册，command 指向的文件存在`);
}

function codexUninstall(name, file) {
  if (!fs.existsSync(file)) return skip(`${name}: 配置文件不存在，本来就没注册`);
  const text = fs.readFileSync(file, "utf8");
  const next = codexRemove(text);
  if (next === null) return skip(`${name}: 本来就没注册`);
  const backup = backupFile(file, BACKUP_KEEP_UNINSTALL);
  fs.writeFileSync(file, next);
  ok(`${name}: 已从 ${file} 移除 [mcp_servers.${MCP_NAME}] 表（备份 ${path.basename(backup)}，其余表未动）`);
}

// 和 Codex 的 TOML 一样零依赖：不引 YAML 解析器（它的方言还带 !!js 标签，通用解析器
// 本来也啃不动），按「顶层列表项」做保守的整块替换/删除。只认三种文件形状：
// 不存在 / 空或 `[]` / 顶层全是 `- ` 列表项与注释——其余形状一律不动手，把手动片段
// 打出来让用户自己贴。宁可少装一家，不许把用户的 profile 写坏。

const DSH_ENTRY_ID = "mcp-agent-in-chrome";

const yamlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function dshBlock(mcpLauncher, entry = { command: mcpLauncher, args: [] }) {
  return [
    MARKER,
    "- insert:",
    `    - id: ${DSH_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${MCP_NAME}`,
    "        transport: stdio",
    `        command: ${yamlStr(entry.command)}`,
    `        args: [${(entry.args || []).map(yamlStr).join(", ")}]`,
  ];
}

function dshItemRanges(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^- /.test(lines[i]) || /^-$/.test(lines[i])) heads.push(i);
  return heads.map((h, k) => {
    let start = h;
    while (start > 0 && lines[start - 1].trim().startsWith("#") && lines[start - 1].includes(MCP_NAME)) start--;
    let end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    while (end > h + 1 && lines[end - 1].trim() === "") end--;
    return { start, end, head: h };
  });
}

function dshItemIsOurs(text) {
  const names = OUR_NAMES.join("|");
  return (
    new RegExp(`serverName:\\s*['"]?(${names})['"]?\\s*$`, "m").test(text) ||
    new RegExp(`-\\s+id:\\s*['"]?mcp-(${names})['"]?\\s*$`, "m").test(text)
  );
}

/*
 * 从 patch 文件里摘掉我们的条目。返回 { lines, removed, mixed }：
 * mixed 是「含我们的 server 但同一项里还有别的条目」的项——那种整项删会连别人的
 * 一起删掉，只警告不动手。
 */
function dshStrip(lines) {
  const ranges = dshItemRanges(lines);
  const doomed = [];
  const mixed = [];
  for (const r of ranges) {
    const text = lines.slice(r.start, r.end).join("\n");
    if (!dshItemIsOurs(text)) continue;
    const entries = text.match(/^\s+- id:/gm) || [];
    if (entries.length <= 1) doomed.push(r);
    else mixed.push(r);
  }
  let out = lines;
  for (const r of [...doomed].sort((a, b) => b.start - a.start)) {
    out = [...out.slice(0, r.start), ...out.slice(r.end)];
  }
  const clean = [];
  for (const l of out) {
    if (l.trim() === "" && clean.length && clean[clean.length - 1].trim() === "") continue;
    clean.push(l);
  }
  return { lines: clean, removed: doomed.length, mixed: mixed.length };
}

function dshShapeKnown(lines) {
  return lines.every((l) => l.trim() === "" || /^[\s#-]/.test(l));
}

function dshUpsert(text, mcpLauncher, entry) {
  const trimmed = String(text || "").trim();
  const block = dshBlock(mcpLauncher, entry);
  if (!trimmed || trimmed === "[]") return { next: block.join("\n") + "\n" };
  const lines = text.split("\n");
  if (!dshShapeKnown(lines)) return { error: "不是顶层列表形状的 YAML" };
  const { lines: stripped, mixed } = dshStrip(lines);
  if (mixed) return { error: `有 ${mixed} 项把我们的 server 和别的条目写在一起` };
  const base = stripped.join("\n").replace(/\n*$/, "");
  return { next: (base ? base + "\n\n" : "") + block.join("\n") + "\n" };
}

function dshInstallProfile(name, file, mcpLauncher, entry) {
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  const r = dshUpsert(text, mcpLauncher, entry);
  if (r.error) {
    warn(`${name}: ${file} ${r.error}，没动它。手动加这一段（HMR 会热加载）：`);
    for (const l of dshBlock(mcpLauncher, entry)) console.log(`      ${l}`);
    return;
  }
  if (r.next === text) {
    ok(`${name}: 已是最新，未改动 ${file}`);
    return;
  }
  const backup = existed ? backupFile(file) : null;
  if (!existed) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.next);
  ok(
    `${name}: 已写入 ${file}（dsh 会热加载，无需重启）` +
      (backup ? `（备份 ${path.basename(backup)}）` : "（新建文件）")
  );
}

function dshCheckProfile(name, file, mcpLauncher) {
  if (!fs.existsSync(file)) return bad(`${name}: 未注册（${file} 不存在）`);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const ours = dshItemRanges(lines)
    .map((r) => lines.slice(r.start, r.end).join("\n"))
    .filter((t) => dshItemIsOurs(t));
  if (!ours.length) return bad(`${name}: 未注册（${file} 里没有 serverName: ${MCP_NAME} 的条目）`);
  if (!ours.some((t) => t.includes(yamlStr(mcpLauncher)) || t.includes(`command: ${mcpLauncher}`)))
    return warn(`${name}: 已注册但 command 不是期望的 ${mcpLauncher}，重装可修`);
  if (!fs.existsSync(mcpLauncher)) return warn(`${name}: 已注册但 ${mcpLauncher} 不存在，跑一次 install 即可`);
  if (process.platform !== "win32" && !(fs.statSync(mcpLauncher).mode & 0o111))
    return warn(`${name}: ${mcpLauncher} 没有可执行位`);
  ok(`${name}: 已注册，command 指向的文件存在且可执行`);
}

function dshUninstallProfile(name, file) {
  if (!fs.existsSync(file)) return skip(`${name}: 配置文件不存在，本来就没注册`);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const { lines: stripped, removed, mixed } = dshStrip(lines);
  if (mixed) warn(`${name}: ${file} 里有 ${mixed} 项把我们的 server 和别的条目写在一起，请手动摘（其余照常处理）`);
  if (!removed) return mixed ? undefined : skip(`${name}: 本来就没注册`);
  const backup = backupFile(file, BACKUP_KEEP_UNINSTALL);
  fs.writeFileSync(file, stripped.join("\n"));
  ok(`${name}: 已从 ${file} 移除我们的条目（备份 ${path.basename(backup)}，其余内容未动）`);
}

function dshProfiles(home) {
  const root = path.join(home, ".dsh", "profiles");
  const out = [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules") continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, n, "package.json"), "utf8"));
      if (pkg?.dsh?.profile) out.push({ name: n, patchFile: path.join(root, n, "cordis.patch.yml") });
    } catch {}
  }
  return out;
}

/*
 * 本机认得的 agent：返回一张清单，每项带 id / name / detected / target /
 * preview / install / check / uninstall。
 *
 * detected 的判据分两类，别混：
 *   · **命令行工具**（Claude Code / opencode / Kimi / Gemini / Qoder CLI）认
 *     **PATH 上的二进制**，配置目录只是补充——刚装完还没跑过的 CLI 没有配置目录。
 *   · **GUI 应用**（各家 IDE/桌面端）认配置目录：它们没有能在 PATH 上找到的入口。
 *
 * 两类都**不给没装的 agent 建目录**——凭空建目录会让别的工具误以为用户装了它。
 */
export function buildAgents({ home = os.homedir(), platform = process.platform, serverPath, mcpLauncher }) {
  const childEnv =
    home === os.homedir() ? process.env : { ...process.env, HOME: home, USERPROFILE: home };
  const claudeBin = findOnPath("claude", platform);
  const claudeJson = path.join(home, ".claude.json");
  const claudeNeedsShell = platform === "win32" && /\.(cmd|bat)$/i.test(claudeBin || "");
  const cmdq = (s) => (/[\s&|<>^"()]/.test(String(s)) ? `"${String(s).replace(/"/g, `""`)}"` : String(s));
  const runClaude = (args) =>
    claudeNeedsShell
      ? execFileSync([claudeBin, ...args].map(cmdq).join(" "), {
          stdio: "pipe",
          env: childEnv,
          shell: true,
          windowsHide: true,
        })
      : execFileSync(claudeBin, args, { stdio: "pipe", env: childEnv });
  const appData =
    process.env.APPDATA && home === os.homedir() ? process.env.APPDATA : path.join(home, "AppData", "Roaming");
  const desktopConfig =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : platform === "win32"
        ? path.join(appData, "Claude", "claude_desktop_config.json")
        : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const workbuddyConfig = path.join(home, ".workbuddy", "mcp.json");
  const workbuddyLegacyConfig = path.join(home, ".workbuddy", ".mcp.json");
  const zcodeConfig = path.join(home, ".zcode", "cli", "config.json");
  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
  const kimiConfig = path.join(home, ".kimi", "mcp.json");
  const geminiConfig = path.join(home, ".gemini", "settings.json");
  const antigravityConfig = path.join(home, ".gemini", "config", "mcp_config.json");
  const qoderCliConfig = path.join(home, ".qoder", "settings.json");
  const qoderCliBin = findOnPath("qodercli", platform) || (fs.existsSync(path.join(home, ".qoder", "bin", "qodercli")) ? path.join(home, ".qoder", "bin", "qodercli") : null);
  const qoderLive = (dataFolder, appDataName) => {
    const b =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support", appDataName, "SharedClientCache", "mcp.json")
        : platform === "win32"
          ? path.join(appData, appDataName, "SharedClientCache", "mcp.json")
          : path.join(home, ".config", appDataName, "SharedClientCache", "mcp.json");
    const a = path.join(home, dataFolder, "mcp.json");
    return { live: fs.existsSync(b) ? b : a, all: [a, b] };
  };
  const qoderIde = qoderLive(".qoder", "Qoder");
  const qoderIdeConfig = qoderIde.live;
  const qoderCnCliConfig = path.join(home, ".qoder-cn", "settings.json");
  const qoderCnCliBin = findOnPath("qoderclicn", platform) || (fs.existsSync(path.join(home, ".qoder-cn", "bin", "qoderclicn")) ? path.join(home, ".qoder-cn", "bin", "qoderclicn") : null);
  const qoderCnIde = qoderLive(".qoder-cn", "QoderCN");
  const qoderCnIdeConfig = qoderCnIde.live;
  const traeCnConfig =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Trae CN", "User", "mcp.json")
      : platform === "win32"
        ? path.join(appData, "Trae CN", "User", "mcp.json")
        : path.join(home, ".config", "Trae CN", "User", "mcp.json");
  const traeConfig =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Trae", "User", "mcp.json")
      : platform === "win32"
        ? path.join(appData, "Trae", "User", "mcp.json")
        : path.join(home, ".config", "Trae", "User", "mcp.json");
  const codexConfig = path.join(home, ".codex", "config.toml");

  const userScopeRegistered = () => {
    try {
      return !!JSON.parse(fs.readFileSync(claudeJson, "utf8"))?.mcpServers?.[MCP_NAME];
    } catch {
      return false;
    }
  };
  const desktopHasOurs = () => {
    try {
      return !!JSON.parse(fs.readFileSync(desktopConfig, "utf8"))?.mcpServers?.[MCP_NAME];
    } catch {
      return false;
    }
  };
  const DESKTOP_WHY =
    `同名连接器会抢走桌面端里 Claude Code 会话的工具命名空间（那个会话自己拉起了 server 却用不上，` +
    `四段身份全断、多轮对话共用一个 sid）；而桌面端的本地 agent 模式跑的就是 Claude Code 引擎、` +
    `带 --setting-sources=user,project,local，user scope 那条它自己就读得到`;

  const nodeEntry = { command: "node", args: [serverPath] };
  const ZCODE_SECTION = ["mcp", "servers"];
  const OPENCODE_SECTION = ["mcp"];
  const guiEntry = () =>
    platform === "win32"
      ? { command: "cmd", args: ["/c", mcpLauncher] }
      : { command: mcpLauncher, args: [] };
  const zcodeDesktopEntry = { type: "stdio", ...guiEntry(), timeoutMs: 60000 };
  const opencodeEntry = { type: "local", command: ["node", serverPath], enabled: true };
  const claudeEntry = { type: "stdio", command: "node", args: [serverPath], env: {} };
  const desktopEntry = guiEntry();
  const workbuddyEntry = { type: "stdio", ...guiEntry(), disabled: false };
  const guiCheck = { execCheck: true, target: mcpLauncher };

  return [
    {
      id: "claude-code",
      name: "Claude Code",
      binOnPath: !!claudeBin,
      detected: !!claudeBin || fs.existsSync(claudeJson),
      target: claudeBin ? `${claudeJson}（经 claude mcp add，scope: user）` : claudeJson,
      preview: claudeBin
        ? [`$ claude mcp remove --scope user ${MCP_NAME}   # 已注册时先清掉，失败忽略`, `$ claude mcp add --scope user ${MCP_NAME} -- node ${serverPath}`]
        : previewJson(claudeEntry),
      install() {
        if (claudeBin) {
          try {
            runClaude(["mcp", "remove", "--scope", "user", MCP_NAME]);
          } catch {}
          try {
            runClaude(["mcp", "add", "--scope", "user", MCP_NAME, "--", "node", serverPath]);
            ok(`Claude Code: claude mcp add 完成（scope: user，落在 ${claudeJson}）`);
            return;
          } catch (e) {
            warn(`Claude Code: claude mcp add 失败（${String(e.stderr || e.message).trim().slice(0, 160)}），退回直接编辑 ${claudeJson}`);
          }
        }
        installJsonEntry("Claude Code", claudeJson, claudeEntry);
      },
      check() {
        checkJsonEntry("Claude Code", claudeJson, claudeEntry);
      },
      uninstall() {
        if (claudeBin) {
          try {
            runClaude(["mcp", "remove", "--scope", "user", MCP_NAME]);
            ok(`Claude Code: claude mcp remove 完成（scope: user）`);
          } catch {}
        }
        let still = false;
        try {
          still = !!JSON.parse(fs.readFileSync(claudeJson, "utf8"))?.mcpServers?.[MCP_NAME];
        } catch {}
        if (still) uninstallJsonEntry("Claude Code", claudeJson);
        else if (!claudeBin) skip("Claude Code: 本来就没注册");
      },
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      detected: fs.existsSync(path.dirname(desktopConfig)),
      target: desktopConfig,
      get preview() {
        if (!userScopeRegistered()) return previewJson(desktopEntry);
        return desktopHasOurs()
          ? [`# 摘掉 mcpServers["${MCP_NAME}"]：${DESKTOP_WHY}`]
          : [`# 不写：Claude Code 已在 user scope 注册（${claudeJson}），${DESKTOP_WHY}`];
      },
      install() {
        if (!userScopeRegistered()) return installJsonEntry("Claude Desktop", desktopConfig, desktopEntry);
        if (desktopHasOurs()) {
          uninstallJsonEntry("Claude Desktop", desktopConfig);
          return warn(`Claude Desktop: 上面这条是**主动摘掉**的 —— ${DESKTOP_WHY}`);
        }
        skip(`Claude Desktop: 不注册（Claude Code 已在 user scope 注册）—— ${DESKTOP_WHY}`);
      },
      check() {
        if (!userScopeRegistered()) return checkJsonEntry("Claude Desktop", desktopConfig, desktopEntry, guiCheck);
        if (desktopHasOurs()) return warn(`Claude Desktop: 有一条和 Claude Code user scope 同名的连接器，重跑 install 会摘掉它 —— ${DESKTOP_WHY}`);
        skip(`Claude Desktop: 有意不注册（走 Claude Code 的 user scope）`);
      },
      uninstall: () => uninstallJsonEntry("Claude Desktop", desktopConfig),
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      detected: fs.existsSync(path.join(home, ".workbuddy")),
      target: workbuddyConfig,
      preview: previewJson(workbuddyEntry),
      install() {
        uninstallJsonEntry("WorkBuddy", workbuddyLegacyConfig);
        installJsonEntry("WorkBuddy", workbuddyConfig, workbuddyEntry);
      },
      check() {
        try {
          if (JSON.parse(fs.readFileSync(workbuddyLegacyConfig, "utf8"))?.mcpServers?.[MCP_NAME])
            warn(`WorkBuddy: ${workbuddyLegacyConfig} 里有一条没人读的注册（那是 WorkBuddy 自己的输出文件），重跑 install 会摘掉它`);
        } catch {}
        checkJsonEntry("WorkBuddy", workbuddyConfig, workbuddyEntry, guiCheck);
      },
      uninstall() {
        uninstallJsonEntry("WorkBuddy", workbuddyConfig);
        uninstallJsonEntry("WorkBuddy", workbuddyLegacyConfig);
      },
    },
    {
      id: "zcode",
      name: "ZCode",
      detected: fs.existsSync(path.join(home, ".zcode")),
      target: zcodeConfig,
      preview: previewJson(zcodeDesktopEntry, ZCODE_SECTION),
      install: () => installJsonEntry("ZCode", zcodeConfig, zcodeDesktopEntry, { section: ZCODE_SECTION }),
      check: () => checkJsonEntry("ZCode", zcodeConfig, zcodeDesktopEntry, { ...guiCheck, section: ZCODE_SECTION }),
      uninstall: () => uninstallJsonEntry("ZCode", zcodeConfig, { section: ZCODE_SECTION }),
    },
    {
      id: "opencode",
      name: "opencode",
      binOnPath: !!findOnPath("opencode", platform),
      detected: !!findOnPath("opencode", platform) || fs.existsSync(path.join(home, ".config", "opencode")),
      target: opencodeConfig,
      preview: previewJson(opencodeEntry, OPENCODE_SECTION),
      install: () => installJsonEntry("opencode", opencodeConfig, opencodeEntry, { section: OPENCODE_SECTION }),
      check: () => checkJsonEntry("opencode", opencodeConfig, opencodeEntry, { section: OPENCODE_SECTION }),
      uninstall: () => uninstallJsonEntry("opencode", opencodeConfig, { section: OPENCODE_SECTION }),
    },
    {
      id: "kimi",
      name: "Kimi CLI",
      binOnPath: !!findOnPath("kimi", platform),
      detected: !!findOnPath("kimi", platform) || fs.existsSync(path.join(home, ".kimi")),
      target: kimiConfig,
      preview: previewJson(nodeEntry),
      install: () => installJsonEntry("Kimi CLI", kimiConfig, nodeEntry),
      check: () => checkJsonEntry("Kimi CLI", kimiConfig, nodeEntry),
      uninstall: () => uninstallJsonEntry("Kimi CLI", kimiConfig),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      binOnPath: !!findOnPath("gemini", platform),
      detected: !!findOnPath("gemini", platform) || fs.existsSync(path.join(home, ".gemini")),
      target: geminiConfig,
      preview: previewJson(nodeEntry),
      install: () => installJsonEntry("Gemini CLI", geminiConfig, nodeEntry),
      check: () => checkJsonEntry("Gemini CLI", geminiConfig, nodeEntry),
      uninstall: () => uninstallJsonEntry("Gemini CLI", geminiConfig),
    },
    {
      id: "antigravity",
      name: "Antigravity",
      detected: fs.existsSync(path.join(home, ".gemini", "config")),
      target: antigravityConfig,
      preview: previewJson(desktopEntry),
      install: () => installJsonEntry("Antigravity", antigravityConfig, desktopEntry),
      check: () => checkJsonEntry("Antigravity", antigravityConfig, desktopEntry, guiCheck),
      uninstall: () => uninstallJsonEntry("Antigravity", antigravityConfig),
    },
    {
      id: "qoder-cli",
      name: "Qoder CLI",
      binOnPath: !!qoderCliBin,
      detected: !!qoderCliBin,
      target: qoderCliConfig,
      preview: previewJson(nodeEntry),
      install: () => installJsonEntry("Qoder CLI", qoderCliConfig, nodeEntry),
      check: () => checkJsonEntry("Qoder CLI", qoderCliConfig, nodeEntry),
      uninstall: () => uninstallJsonEntry("Qoder CLI", qoderCliConfig),
    },
    {
      id: "qoder-cli-cn",
      name: "Qoder CN CLI",
      binOnPath: !!qoderCnCliBin,
      detected: !!qoderCnCliBin,
      target: qoderCnCliConfig,
      preview: previewJson(nodeEntry),
      install: () => installJsonEntry("Qoder CN CLI", qoderCnCliConfig, nodeEntry),
      check: () => checkJsonEntry("Qoder CN CLI", qoderCnCliConfig, nodeEntry),
      uninstall: () => uninstallJsonEntry("Qoder CN CLI", qoderCnCliConfig),
    },
    {
      id: "qoder-ide-cn",
      name: "Qoder CN IDE",
      detected: fs.existsSync(path.join(home, ".qoder-cn")),
      target: qoderCnIdeConfig,
      preview: previewJson(desktopEntry),
      install: () => installJsonEntry("Qoder CN IDE", qoderCnIdeConfig, desktopEntry),
      check: () => checkJsonEntry("Qoder CN IDE", qoderCnIdeConfig, desktopEntry, guiCheck),
      uninstall: () => qoderCnIde.all.filter((f) => fs.existsSync(f)).forEach((f) => uninstallJsonEntry("Qoder CN IDE", f)),
    },
    {
      id: "trae-cn",
      name: "Trae CN",
      detected: fs.existsSync(path.dirname(traeCnConfig)),
      target: traeCnConfig,
      preview: previewJson(desktopEntry),
      install: () => installJsonEntry("Trae CN", traeCnConfig, desktopEntry),
      check: () => checkJsonEntry("Trae CN", traeCnConfig, desktopEntry, guiCheck),
      uninstall: () => uninstallJsonEntry("Trae CN", traeCnConfig),
    },
    {
      id: "qoder-ide",
      name: "Qoder IDE",
      detected: fs.existsSync(path.join(home, ".qoder")),
      target: qoderIdeConfig,
      preview: previewJson(desktopEntry),
      install: () => installJsonEntry("Qoder IDE", qoderIdeConfig, desktopEntry),
      check: () => checkJsonEntry("Qoder IDE", qoderIdeConfig, desktopEntry, guiCheck),
      uninstall: () => qoderIde.all.filter((f) => fs.existsSync(f)).forEach((f) => uninstallJsonEntry("Qoder IDE", f)),
    },
    {
      id: "trae",
      name: "Trae",
      detected: fs.existsSync(path.dirname(traeConfig)),
      target: traeConfig,
      preview: previewJson(desktopEntry),
      install: () => installJsonEntry("Trae", traeConfig, desktopEntry),
      check: () => checkJsonEntry("Trae", traeConfig, desktopEntry, guiCheck),
      uninstall: () => uninstallJsonEntry("Trae", traeConfig),
    },
    {
      id: "deepseek-harness",
      name: "DeepSeek Harness",
      detected: dshProfiles(home).length > 0,
      target: dshProfiles(home).map((p) => p.patchFile).join("、") || path.join(home, ".dsh", "profiles"),
      preview: dshBlock(mcpLauncher, guiEntry()),
      install() {
        for (const p of dshProfiles(home)) dshInstallProfile(`DeepSeek Harness (${p.name})`, p.patchFile, mcpLauncher, guiEntry());
      },
      check() {
        for (const p of dshProfiles(home)) dshCheckProfile(`DeepSeek Harness (${p.name})`, p.patchFile, mcpLauncher);
      },
      uninstall() {
        for (const p of dshProfiles(home)) dshUninstallProfile(`DeepSeek Harness (${p.name})`, p.patchFile);
      },
    },
    {
      id: "codex",
      name: "Codex CLI",
      detected: fs.existsSync(path.join(home, ".codex")),
      target: codexConfig,
      preview: codexBlock(serverPath),
      install: () => codexInstall("Codex CLI", codexConfig, serverPath),
      check: () => codexCheck("Codex CLI", codexConfig, serverPath),
      uninstall: () => codexUninstall("Codex CLI", codexConfig),
    },
  ];
}

/*
 * mode: "install" | "check" | "uninstall"
 * opts: { serverPath, mcpLauncher, yes, agents（id 数组或 null）, noAgents, home, platform }
 *
 * 返回 { installed, skipped, cancelled }（id 数组 / 布尔）——装完那一屏要能说出
 * 「注册了哪几家、怎么单独摘掉」。默认全装的正当性全靠这句话，不能只在日志里一闪而过。
 */
export async function runAgents(mode, opts = {}) {
  const empty = { installed: [], skipped: [], failed: [], cancelled: false };
  if (opts.noAgents) {
    skip("按 --no-agents 跳过 agent 注册");
    if (mode === "install") printGenericSnippet(opts.serverPath);
    return empty;
  }
  const agents = buildAgents(opts);
  const known = new Set(agents.map((a) => a.id));
  const only = opts.agents ? new Set(opts.agents) : null;
  if (only) {
    for (const id of only)
      if (!known.has(id)) warn(`--agents 里的 "${id}" 不认识（可选：${[...known].join(", ")}）`);
  }

  const targets = [];
  for (const a of agents) {
    if (only && !only.has(a.id)) {
      skip(`${a.name}: 按 --agents 跳过`);
      continue;
    }
    if (!a.detected) {
      skip(`${a.name}: 未检测到`);
      continue;
    }
    if (mode === "check") {
      a.check();
      continue;
    }
    if (mode === "uninstall") {
      a.uninstall();
      continue;
    }
    targets.push(a);
  }

  if (mode !== "install") return empty;
  if (!targets.length) {
    skip("没有探测到任何已安装的 agent 客户端");
    printGenericSnippet(opts.serverPath);
    return empty;
  }

  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const interactive = !opts.yes && !!input.isTTY;
  let chosen = targets.map((_, i) => i);
  if (interactive) {
    const picked = await pickMulti(
      targets.map((a) => ({ label: a.name, note: a.target })),
      {
        title: `\n  探测到 ${targets.length} 个客户端，默认\x1b[1m全部注册\x1b[0m。不想装哪个就取消勾选：`,
        input,
        output,
        platform: opts.platform,
      }
    );
    if (picked === null) {
      warn("已取消，没有改动任何配置文件");
      return { installed: [], skipped: targets.map((a) => a.id), failed: [], cancelled: true };
    }
    chosen = picked;
  }

  const pickedSet = new Set(chosen);
  const installed = [];
  const skipped = [];
  const failedIds = [];
  for (let i = 0; i < targets.length; i++) {
    const a = targets[i];
    if (!pickedSet.has(i)) {
      skip(`${a.name}: 按你的选择跳过`);
      skipped.push(a.id);
      continue;
    }
    console.log(`  \x1b[1m${a.name}\x1b[0m — 将修改 ${a.target}`);
    for (const line of a.preview) console.log(`      ${line}`);
    try {
      if (a.install() === false) failedIds.push(a.id);
      else installed.push(a.id);
    } catch (e) {
      bad(`${a.name}: 写入失败（${e.message}），跳过它继续装别的`);
      failedIds.push(a.id);
    }
  }

  printGenericSnippet(opts.serverPath);
  return { installed, skipped, failed: failedIds, cancelled: false };
}

function printGenericSnippet(serverPath) {
  console.log(`
  其他 MCP 客户端手动登记用这段（stdio）：
    { "mcpServers": { "${MCP_NAME}": { "command": "node", "args": [${JSON.stringify(serverPath)}] } } }
  不想固定安装路径的话，command 也可以用：npx -y ${PKG_NAME} serve`);
}
