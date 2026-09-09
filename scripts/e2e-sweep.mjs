import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const E2E_PREFIX = "e2e-";

export function ownerPidOf(sid) {
  const m = /-(\d+)-[0-9a-z]+$/.exec(String(sid || ""));
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function liveRegisteredSessions(registry, isAlive) {
  const out = new Set();
  for (const row of Array.isArray(registry) ? registry : []) {
    if (!Number.isInteger(row?.pid) || !isAlive(row.pid)) continue;
    for (const sid of Array.isArray(row.sessions) ? row.sessions : []) out.add(sid);
  }
  return out;
}

export function pickStraySessions({ otherSessions, registry = [], isAlive }) {
  const protectedSids = liveRegisteredSessions(registry, isAlive);
  const out = [];
  for (const o of Array.isArray(otherSessions) ? otherSessions : []) {
    const sid = o?.session;
    if (typeof sid !== "string" || !sid.startsWith(E2E_PREFIX)) continue;
    const tabIds = Array.isArray(o.tabIds) ? o.tabIds : [];
    if (!tabIds.length) continue;
    if (protectedSids.has(sid)) continue;
    const pid = ownerPidOf(sid);
    if (pid !== null && isAlive(pid)) continue;
    out.push({
      session: sid,
      tabIds,
      why: pid === null ? "旧版裸名会话，主人无从追溯" : `主人进程 ${pid} 已退出`,
    });
  }
  return out;
}

function registryPath() {
  const base = process.env.AGENT_IN_CHROME_SOCK
    ? path.dirname(path.resolve(process.env.AGENT_IN_CHROME_SOCK))
    : path.join(os.homedir(), ".agent-in-chrome");
  return path.join(base, "e2e-runs.json");
}

function readRegistryFile() {
  try {
    const v = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function sweepClient(sessionId) {
  const launcher =
    process.env.AGENT_IN_CHROME_E2E_LAUNCHER ||
    path.join(os.homedir(), ".agent-in-chrome", "agent-in-chrome", "mcp-launcher.sh");
  const p = spawn(launcher, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_IN_CHROME_SESSION_ID: sessionId },
  });
  let buf = "";
  const waiters = new Map();
  let n = 0;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const f = waiters.get(m.id);
        if (f) { waiters.delete(m.id); f(m); }
      } catch {}
    }
  });
  let errTail = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (c) => { errTail = (errTail + c).slice(-4000); });
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = ++n;
      const t = setTimeout(() => rej(new Error(`${method} 超时`)), 30000);
      waiters.set(id, (m) => { clearTimeout(t); res(m); });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    get errTail() { return errTail; },
    async init() {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-sweep", version: "0" },
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(tool, args = {}) {
      const r = await rpc("tools/call", { name: tool, arguments: args });
      const text = r.result?.content?.[0]?.text ?? "";
      if (r.result?.isError) throw new Error(text);
      try { return JSON.parse(text); } catch { return text; }
    },
    kill() { try { p.kill(); } catch {} },
  };
}

export async function runSweep({ dryRun = false, log = console.log, makeClient = sweepClient, registry = null, isAlive = pidAlive } = {}) {
  const probe = makeClient(`sweep-${process.pid}-${Date.now().toString(36)}`);
  let stray = [];
  try {
    await probe.init();
    const st = await probe.call("browser_status");
    stray = pickStraySessions({
      otherSessions: st?.otherSessions,
      registry: registry ?? readRegistryFile(),
      isAlive,
    });
  } finally {
    probe.kill();
  }

  if (!stray.length) {
    log("没有游离的 e2e 会话——干净。");
    return { stray: [], closed: 0 };
  }

  log(`发现 ${stray.length} 个游离的 e2e 会话：`);
  for (const s of stray) log(`  · ${s.session}（${s.why}）占着 ${s.tabIds.length} 个标签页`);
  if (dryRun) {
    log("\n--dry-run：一个都没收。去掉这个参数才真的关。");
    return { stray, closed: 0 };
  }

  let closed = 0;
  let released = 0;
  for (const s of stray) {
    const c = makeClient(s.session);
    try {
      await c.init();
      const r = await c.call("browser_close_all", { scope: "session" });
      const n = r?.closedCount || 0;
      const rel = r?.releasedCount || 0;
      closed += n;
      released += rel;
      log(`  \x1b[32m✓\x1b[0m ${s.session}：收掉 ${n} 个标签页${rel ? `，另有 ${rel} 张只解了组没关（见下）` : ""}`);
    } catch (e) {
      log(`  \x1b[33m·\x1b[0m ${s.session}：这次没收成（${String(e.message).slice(0, 120)}）——下次再跑还会看见它`);
    } finally {
      c.kill();
    }
  }
  log(`\n共收掉 ${closed} 个标签页。用户自己的页一张没动。`);
  if (released) {
    log(
      `另有 ${released} 张页只解了组、没有关：close_all 只关「确实是 agent 自己开的」那些，` +
        `而这几张在扩展账本上只有归属、没有「我开的」这一笔（e2e 被强杀时刚建出来、还没落盘就会这样）。` +
        `它们此后不再属于任何会话，本命令也就再看不见它们——请自己确认一下要不要关掉。`
    );
  }
  return { stray, closed, released };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
  try {
    await runSweep({ dryRun });
    process.exit(0);
  } catch (e) {
    console.error(`清扫没跑成：${e.message}`);
    console.error("桥接没连上多半是 Chrome 没开、或扩展被停用。先 `node scripts/install.mjs --check`。");
    process.exit(1);
  }
}
