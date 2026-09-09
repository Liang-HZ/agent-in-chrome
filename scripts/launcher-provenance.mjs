import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export function listMjs(dir, { readdir = fs.readdirSync } = {}) {
  const out = [];
  const walk = (d, rel) => {
    let ents;
    try {
      ents = readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), childRel);
      else if (e.isFile() && e.name.endsWith(".mjs")) out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

export function hashFile(p, { read = fs.readFileSync } = {}) {
  try {
    return crypto.createHash("sha256").update(read(p)).digest("hex");
  } catch {
    return null;
  }
}

export function compareInstalledMcp(workspaceMcpDir, runtimeDir, io = {}) {
  const files = listMjs(workspaceMcpDir, io);
  const differ = [];
  const missing = [];
  for (const rel of files) {
    const a = hashFile(path.join(workspaceMcpDir, rel), io);
    const b = hashFile(path.join(runtimeDir, rel), io);
    if (b === null) missing.push(rel);
    else if (a !== b) differ.push(rel);
  }
  return { ok: differ.length === 0 && missing.length === 0, differ, missing, checked: files.length };
}

export function versionOf(serverFile, { read = fs.readFileSync } = {}) {
  try {
    const m = /VERSION\s*=\s*["']([^"']+)["']/.exec(String(read(serverFile, "utf8")).slice(0, 20000));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function provenanceReport({ launcher, custom, workspaceMcpDir, runtimeDir, io = {} }) {
  const serverFile = custom ? null : path.join(runtimeDir, "server.mjs");
  const ver = versionOf(serverFile || path.join(workspaceMcpDir, "server.mjs"), io);
  if (custom) {
    return {
      line: `server 来源 ${launcher}（自定义启动器，不比对；版本以它实际拉起的那份为准）`,
      fatal: null,
    };
  }
  const cmp = compareInstalledMcp(workspaceMcpDir, runtimeDir, io);
  const line = `server 来源 ${serverFile}（已安装副本 ${ver || "版本未知"}，mcp/ 比对 ${cmp.checked} 个模块）`;
  if (cmp.ok) return { line, fatal: null };
  const bad = [...cmp.differ.map((f) => `${f}（内容不同）`), ...cmp.missing.map((f) => `${f}（没装过去）`)];
  return {
    line,
    fatal:
      `已安装的 server 与工作区不一致，这一轮测的不是你改的代码：\n` +
      bad.map((b) => `    - ${b}`).join("\n") +
      `\n  先 \`node scripts/install.mjs\` 把改动装上，或者用 AGENT_IN_CHROME_E2E_LAUNCHER 指一个跑工作区代码的启动器。`,
  };
}
