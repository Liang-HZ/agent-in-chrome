#!/usr/bin/env node

import { ownerPidOf, liveRegisteredSessions, pickStraySessions, runSweep } from "./e2e-sweep.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const alive = (set) => (pid) => set.includes(pid);
const sess = (session, tabIds = [1]) => ({ session, tabIds, tabId: tabIds[0] ?? null, label: "x" });
const pick = (otherSessions, registry, live) =>
  pickStraySessions({ otherSessions, registry, isAlive: alive(live) }).map((s) => s.session);

section("1. ownerPidOf：主人 pid 就写在 sid 尾巴上");

check("带跑次后缀的解得出", ownerPidOf("e2e-A-61578-msfi8af4") === 61578, String(ownerPidOf("e2e-A-61578-msfi8af4")));
check("名字里带横线的也解得出", ownerPidOf("e2e-cdp-shadow-1234-abc0") === 1234, String(ownerPidOf("e2e-cdp-shadow-1234-abc0")));
check("裸名解不出（旧版遗留）", ownerPidOf("e2e-A") === null);
check("裸名带横线也解不出", ownerPidOf("e2e-cdp-shadow") === null);
check("只认结尾，中间的数字段不算", ownerPidOf("e2e-h2-frames") === null, String(ownerPidOf("e2e-h2-frames")));
check("pid 为 0 不算", ownerPidOf("e2e-A-0-abc") === null);
check("空值不炸", ownerPidOf(null) === null && ownerPidOf(undefined) === null && ownerPidOf("") === null);

section("2. liveRegisteredSessions：只护主人还活着的行");

const reg = [
  { pid: 100, runId: "r1", sessions: ["e2e-A-100-x", "e2e-shot-100-x"] },
  { pid: 200, runId: "r2", sessions: ["e2e-A-200-y"] },
];
const protectedNow = liveRegisteredSessions(reg, alive([100]));
check("活着那行的会话都在", protectedNow.has("e2e-A-100-x") && protectedNow.has("e2e-shot-100-x"));
check("死了那行的不在（留给回收）", !protectedNow.has("e2e-A-200-y"));
check("表是坏的也不炸", liveRegisteredSessions(null, alive([100])).size === 0);
check("行缺字段也不炸", liveRegisteredSessions([{}, { pid: "x" }, { pid: 100 }], alive([100])).size === 0);

section("3. 该收的：主人已经没了");

check(
  "旧版裸名残留——正是 2026-08-05 真机上那七个",
  JSON.stringify(
    pick(
      [sess("e2e-A"), sess("e2e-frames"), sess("e2e-shot"), sess("e2e-verify"), sess("e2e-cursor"), sess("e2e-ergo"), sess("e2e-adopt")],
      [],
      [999]
    )
  ) === JSON.stringify(["e2e-A", "e2e-frames", "e2e-shot", "e2e-verify", "e2e-cursor", "e2e-ergo", "e2e-adopt"])
);
check("带后缀但主人已退出的（登记表漏了它）", JSON.stringify(pick([sess("e2e-A-777-abc")], [], [999])) === JSON.stringify(["e2e-A-777-abc"]));
check(
  "登记表里有这一行、但主人已死 → 照收（sweepDeadRuns 收不干净时接手）",
  JSON.stringify(pick([sess("e2e-A-777-abc")], [{ pid: 777, runId: "r", sessions: ["e2e-A-777-abc"] }], [999])) ===
    JSON.stringify(["e2e-A-777-abc"])
);
check("收的时候把标签页一起报出来，日志才有用", (() => {
  const [s] = pickStraySessions({ otherSessions: [sess("e2e-A", [7, 8])], registry: [], isAlive: alive([]) });
  return s.tabIds.join(",") === "7,8" && /裸名/.test(s.why);
})());
check("带后缀的 why 里写明是哪个 pid 没了", (() => {
  const [s] = pickStraySessions({ otherSessions: [sess("e2e-A-777-abc")], registry: [], isAlive: alive([]) });
  return /777/.test(s.why);
})());

section("4. 不该收的：误收的代价远大于漏收");

check("非 e2e- 前缀一概不看——用户自己的会话", JSON.stringify(pick([sess("s61578-msfi8af4"), sess("去哪儿酒店比价")], [], [])) === "[]");
check("前缀得从头匹配，不是 includes", JSON.stringify(pick([sess("mine-e2e-A")], [], [])) === "[]");
check("主人还活着的跑次不碰（并发跑的另一轮 e2e）", JSON.stringify(pick([sess("e2e-A-555-abc")], [], [555])) === "[]");
check(
  "本轮自己的更不能碰——RUN_ID 开头就是本进程 pid",
  JSON.stringify(pick([sess(`e2e-shot-${process.pid}-msfi8af4`)], [], [process.pid])) === "[]"
);
check(
  "登记表护住的不碰，哪怕 sid 形状认不出主人",
  JSON.stringify(pick([sess("e2e-手动起的名字")], [{ pid: 100, runId: "r", sessions: ["e2e-手动起的名字"] }], [100])) === "[]"
);
check("手上没有标签页的不值得起进程去收", JSON.stringify(pick([sess("e2e-A", [])], [], [])) === "[]");
check("otherSessions 是坏的也不炸", JSON.stringify(pick(null, [], [])) === "[]" && JSON.stringify(pick([null, {}, 1], [], [])) === "[]");

section("5. 混在一起：真机上就是这个样子");

check(
  "只挑走游离的 e2e，用户会话和活着的跑次原样留下",
  JSON.stringify(
    pick(
      [
        sess("s57432-msemm674", [1]),
        sess("e2e-A"),
        sess("e2e-cursor"),
        sess("e2e-A-555-abc"),
        sess("e2e-hard-777-abc"),
        sess("s84989-msesviuo", [2]),
      ],
      [{ pid: 555, runId: "r", sessions: ["e2e-A-555-abc"] }],
      [555]
    )
  ) === JSON.stringify(["e2e-A", "e2e-cursor", "e2e-hard-777-abc"])
);

section("6. runSweep：真的去收，而且只收该收的");

function fakeClientFactory({ otherSessions, closedCount = 2, stuck = [], released = 0 }) {
  const seen = [];
  const factory = (sessionId) => {
    const rec = { sessionId, calls: [] };
    seen.push(rec);
    return {
      async init() {},
      async call(tool, args) {
        rec.calls.push({ tool, args });
        if (tool === "browser_status") return { otherSessions };
        if (tool === "browser_close_all") {
          if (stuck.includes(sessionId)) throw new Error("attach 卡住了");
          return { closedCount, releasedCount: released };
        }
        return {};
      },
      kill() { rec.killed = true; },
    };
  };
  factory.seen = seen;
  return factory;
}

const others = [
  { session: "s61578-msfi8af4", tabIds: [1, 2] },
  { session: "e2e-A", tabIds: [3] },
  { session: "e2e-hard-777-abc", tabIds: [4, 5] },
  { session: "e2e-live-555-abc", tabIds: [6] },
];
const liveIs = (pid) => pid === 555;

{
  const f = fakeClientFactory({ otherSessions: others, closedCount: 1, released: 1 });
  const lines = [];
  const r = await runSweep({ makeClient: f, registry: [], isAlive: liveIs, log: (m) => lines.push(m) });
  check("只解组没关的页也如实计数", r.released === 2, String(r.released));
  check("汇总里点出来了，而不是含糊报成收干净", lines.some((l) => /只解了组、没有关/.test(l)), JSON.stringify(lines.slice(-2)));
}

{
  const f = fakeClientFactory({ otherSessions: others });
  const lines = [];
  const r = await runSweep({ makeClient: f, registry: [], isAlive: liveIs, log: (m) => lines.push(m) });
  const closedFor = f.seen.filter((c) => c.calls.some((x) => x.tool === "browser_close_all")).map((c) => c.sessionId);
  check("挑出来的正是那两个游离会话", JSON.stringify(r.stray.map((s) => s.session)) === JSON.stringify(["e2e-A", "e2e-hard-777-abc"]));
  check("冒充的 sid 一个不多一个不少", JSON.stringify(closedFor) === JSON.stringify(["e2e-A", "e2e-hard-777-abc"]), JSON.stringify(closedFor));
  check("用户的会话从头到尾没被冒充过", !f.seen.some((c) => c.sessionId === "s61578-msfi8af4"));
  check("活着那轮的会话也没被碰", !closedFor.includes("e2e-live-555-abc"));
  check(
    "close_all 一律 scope:\"session\"，绝不 \"all\"",
    f.seen.every((c) => c.calls.every((x) => x.tool !== "browser_close_all" || x.args?.scope === "session"))
  );
  check("收掉的标签页数如实汇总", r.closed === 4, String(r.closed));
  check("每个起过的 client 都被收掉（不留进程）", f.seen.every((c) => c.killed));
  check("探路会话不带 e2e- 前缀（否则下次清扫会把自己当残留）", !f.seen[0].sessionId.startsWith("e2e-"));
}

{
  const f = fakeClientFactory({ otherSessions: others });
  const r = await runSweep({ makeClient: f, registry: [], isAlive: liveIs, log: () => {}, dryRun: true });
  check("--dry-run 报得出该收哪些", r.stray.length === 2);
  check("--dry-run 一个 close_all 都没发", !f.seen.some((c) => c.calls.some((x) => x.tool === "browser_close_all")));
  check("--dry-run 汇总的关闭数是 0", r.closed === 0);
}

{
  const f = fakeClientFactory({ otherSessions: others, stuck: ["e2e-A"] });
  const lines = [];
  const r = await runSweep({ makeClient: f, registry: [], isAlive: liveIs, log: (m) => lines.push(m) });
  const closedFor = f.seen.filter((c) => c.calls.some((x) => x.tool === "browser_close_all")).map((c) => c.sessionId);
  check("一个会话收不动，后面的照收", closedFor.includes("e2e-hard-777-abc") && r.closed === 2, String(r.closed));
  check("收不动的那个在日志里说清了，而且没当成收干净了", lines.some((l) => /e2e-A.*没收成/.test(l)));
}

{
  const f = fakeClientFactory({ otherSessions: [{ session: "s1-x", tabIds: [1] }] });
  const lines = [];
  const r = await runSweep({ makeClient: f, registry: [], isAlive: liveIs, log: (m) => lines.push(m) });
  check("没有残留时干脆地说一声就走", r.stray.length === 0 && r.closed === 0 && lines.some((l) => /干净/.test(l)));
}

{
  const f = fakeClientFactory({ otherSessions: [{ session: "e2e-手动起的名字", tabIds: [9] }] });
  await runSweep({
    makeClient: f,
    registry: [{ pid: 555, runId: "r", sessions: ["e2e-手动起的名字"] }],
    isAlive: liveIs,
    log: () => {},
  });
  check("登记表护住的不收", !f.seen.some((c) => c.sessionId === "e2e-手动起的名字"));
}

section("7. CLI 入口：`node scripts/e2e-sweep.mjs` 真的能跑起来");

{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-sweep-cli-"));
  const stub = path.join(tmp, "stub-server.mjs");
  fs.writeFileSync(
    stub,
    `let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } } }) + "\\n");
    } else if (m.method === "tools/call") {
      const body = m.params.name === "browser_status"
        ? { otherSessions: [{ session: "e2e-stray-424242-zz", tabIds: [11, 12] }, { session: "\\u7528\\u6237\\u7684\\u4f1a\\u8bdd", tabIds: [13] }] }
        : { closedCount: 2 };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } }) + "\\n");
    }
  }
});
`
  );
  const launcher = path.join(tmp, "launcher.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${stub} "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  const env = { ...process.env, AGENT_IN_CHROME_E2E_LAUNCHER: launcher, AGENT_IN_CHROME_SOCK: path.join(tmp, "s.sock") };
  const dry = spawnSync(process.execPath, [path.join(HERE, "e2e-sweep.mjs"), "--dry-run"], { encoding: "utf8", env, timeout: 30000 });
  check("`--dry-run` 退出码 0", dry.status === 0, String(dry.status) + (dry.stderr || ""));
  check("`--dry-run` 报出了那个游离会话", /e2e-stray-424242-zz/.test(dry.stdout || ""), dry.stdout);
  check("`--dry-run` 明说一个都没收", /一个都没收/.test(dry.stdout || ""), dry.stdout);
  const run = spawnSync(process.execPath, [path.join(HERE, "e2e-sweep.mjs")], { encoding: "utf8", env, timeout: 30000 });
  check("不带参数时真的去收，退出码 0", run.status === 0, String(run.status) + (run.stderr || ""));
  check("汇总里报了收掉的标签页数", /共收掉 2 个标签页/.test(run.stdout || ""), run.stdout);
  check("用户的会话没出现在要收的名单里", !/用户的会话（/.test(run.stdout || ""), run.stdout);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} 通过，${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);
