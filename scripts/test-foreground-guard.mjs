#!/usr/bin/env node

import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createForegroundGuard, helperCandidates } from "../mcp/foreground-guard.mjs";
import { compareInstalledMcp, listMjs, provenanceReport, versionOf } from "./launcher-provenance.mjs";

const SELF = fileURLToPath(import.meta.url);

if (process.argv.includes("--fake-helper")) {
  process.stdout.write(JSON.stringify({ t: "ready", ms: Date.now(), front: "com.fake.Editor" }) + "\n");
  let armedUntil = 0;
  let stealAt = 0;
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const [cmd, arg] = line.split(" ");
      const now = Date.now();
      if (cmd === "arm") {
        armedUntil = now + Number(arg || 0);
        stealAt = process.env.FAKE_STEAL === "0" ? 0 : now;
        process.stdout.write(JSON.stringify({ t: "armed", ms: now, base: "com.fake.Editor" }) + "\n");
      } else if (cmd === "confirm") {
        if (now > armedUntil) process.stdout.write(JSON.stringify({ t: "skip", ms: now, why: "not-armed" }) + "\n");
        else if (!stealAt) process.stdout.write(JSON.stringify({ t: "skip", ms: now, why: "no-steal" }) + "\n");
        else if (now - stealAt > Number(process.env.FAKE_WINDOW_MS || 600))
          process.stdout.write(JSON.stringify({ t: "skip", ms: now, why: "late" }) + "\n");
        else
          process.stdout.write(
            JSON.stringify({ t: "restore", ms: now, to: "com.fake.Editor", ok: true, exposureMs: now - stealAt }) + "\n"
          );
      } else if (cmd === "disarm") {
        armedUntil = 0;
        stealAt = 0;
        process.stdout.write(JSON.stringify({ t: "disarmed", ms: now }) + "\n");
      } else if (cmd === "quit") process.exit(0);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else {
  queueMicrotask(() => main());
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${String(extra).slice(0, 300)}` : ""}`);
    failures.push(name);
    fail++;
  }
}
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(15);
  }
}

function helperGuard(extraEnv = {}) {
  return createForegroundGuard({
    platform: "darwin",
    base: "/nonexistent",
    exists: () => true,
    spawn: (cmd, args, opts) =>
      realSpawn(process.execPath, [SELF, "--fake-helper"], { ...opts, env: { ...process.env, ...extraEnv } }),
    armTtlMs: 400,
  });
}

async function main() {
  section("1. 平台与开关：非 macOS / 显式关掉 → 一个子进程都不起");
  {
    let spawned = 0;
    const g = createForegroundGuard({
      platform: "linux",
      spawn: () => {
        spawned++;
        throw new Error("不该走到这儿");
      },
    });
    check("非 macOS：arm() 返回 false", g.arm() === false);
    check("非 macOS：confirm() 返回 false", g.confirm() === false);
    check("非 macOS：一次 spawn 都没有", spawned === 0);
    check("非 macOS：mode 停在 off", g.stats().mode === "off", JSON.stringify(g.stats()));

    const g2 = createForegroundGuard({
      platform: "darwin",
      enabled: false,
      spawn: () => {
        spawned++;
        throw new Error("不该走到这儿");
      },
    });
    g2.arm();
    g2.confirm();
    check("AGENT_IN_CHROME_NO_FG_GUARD 关掉后同样零 spawn", spawned === 0);
  }

  section("2. 惰性：没 arm 过就不起 helper");
  {
    let spawned = 0;
    const g = createForegroundGuard({
      platform: "darwin",
      exists: () => true,
      spawn: (...a) => {
        spawned++;
        return realSpawn(process.execPath, [SELF, "--fake-helper"], { stdio: ["pipe", "pipe", "ignore"] });
      },
    });
    check("建出来时还没有子进程", spawned === 0);
    check("没武装过的 confirm 不作数、也不起进程", g.confirm() === false && spawned === 0);
    g.arm();
    check("第一次 arm 才起 helper", spawned === 1);
    g.arm();
    g.arm();
    check("后续 arm 复用同一个 helper", spawned === 1);
    g.stop();
  }

  section("3. helper 路径：武装 + 确认 → 真的还前台");
  {
    const g = helperGuard();
    g.arm();
    check("armed 事件回来了", !!(await until(() => g.events().find((e) => e.t === "armed"))), JSON.stringify(g.events()));
    g.confirm();
    const ev = await until(() => g.events().find((e) => e.t === "restore"));
    check("发出了 restore", !!ev, JSON.stringify(g.events()));
    check("restore 报了还给谁", ev?.to === "com.fake.Editor", JSON.stringify(ev));
    check("stats 记了一次 restore、零 skip", g.stats().restores === 1 && g.stats().skips === 0, JSON.stringify(g.stats()));
    g.stop();
  }

  section("4. 只武装不确认 → 不还（用户自己切过去的不许被拽走）");
  {
    const g = helperGuard();
    g.arm();
    await until(() => g.events().find((e) => e.t === "armed"));
    await sleep(250);
    check("没有任何 restore", !g.events().some((e) => e.t === "restore"), JSON.stringify(g.events()));
    check("stats.restores 仍是 0", g.stats().restores === 0);
    g.stop();
  }

  section("5. 动作没开出新页（只武装、结果因不成立）→ 不还");
  {
    const g = helperGuard({ FAKE_STEAL: "0" });
    g.arm();
    await until(() => g.events().find((e) => e.t === "armed"));
    g.confirm();
    const sk = await until(() => g.events().find((e) => e.t === "skip"));
    check("被判成 no-steal 并跳过", sk?.why === "no-steal", JSON.stringify(g.events()));
    check("一次 restore 都没有", !g.events().some((e) => e.t === "restore"));
    g.stop();
  }

  section("6. 确认迟到 → 不还");
  {
    const g = helperGuard({ FAKE_WINDOW_MS: "50" });
    g.arm();
    await until(() => g.events().find((e) => e.t === "armed"));
    await sleep(160);
    g.confirm();
    const sk = await until(() => g.events().find((e) => e.t === "skip"));
    check("被判成 late 并跳过", sk?.why === "late", JSON.stringify(g.events()));
    g.stop();
  }

  section("7. 武装过期 → 不还");
  {
    const g = helperGuard();
    g.arm();
    await until(() => g.events().find((e) => e.t === "armed"));
    await sleep(520);
    g.confirm();
    const sk = await until(() => g.events().find((e) => e.t === "skip"));
    check("被判成 not-armed 并跳过", sk?.why === "not-armed", JSON.stringify(g.events()));
    g.stop();
  }

  section("8. disarm / stop：解除之后确认不算数，helper 收得掉");
  {
    const g = helperGuard();
    g.arm();
    await until(() => g.events().find((e) => e.t === "armed"));
    g.disarm();
    await until(() => g.events().find((e) => e.t === "disarmed"));
    g.confirm();
    const sk = await until(() => g.events().find((e) => e.t === "skip"));
    check("disarm 之后的 confirm 被跳过", !!sk && sk.why === "not-armed", JSON.stringify(g.events()));
    g.stop();
    check("stop 之后 stats 还读得到（幂等，不抛）", typeof g.stats().arms === "number");
    g.stop();
  }

  section("9. helper 找不到 → 退到 open -b 兜底路径");
  {
    const calls = [];
    const fake = (cmd, args) => {
      calls.push({ cmd, args });
      const n = calls.filter((c) => c.cmd === "/usr/bin/lsappinfo").length;
      const bid = n <= 1 ? "com.fake.Editor" : "com.fake.Browser";
      const body = `1) "x" ASN:0x0-1: (in front) \n    bundleID="${bid}"\n`;
      return realSpawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(body)})`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    };
    const g = createForegroundGuard({
      platform: "darwin",
      exists: () => false,
      spawn: fake,
      armTtlMs: 3000,
    });
    g.arm();
    check("mode 落到 fallback", g.stats().mode === "fallback", JSON.stringify(g.stats()));
    await until(() => calls.some((c) => c.cmd === "/usr/bin/lsappinfo"));
    await sleep(120);
    g.confirm();
    const open = await until(() => calls.find((c) => c.cmd === "/usr/bin/open"));
    check("兜底路径真的调了 open -b", !!open, JSON.stringify(calls));
    check("还给的是武装那一刻的 app", open?.args?.[1] === "com.fake.Editor", JSON.stringify(open));
    check("记了一次 restore", g.stats().restores === 1, JSON.stringify(g.stats()));
    g.stop();
  }

  section("10. 兜底路径：前台压根没换人 → 不 open");
  {
    const calls = [];
    const g = createForegroundGuard({
      platform: "darwin",
      exists: () => false,
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        const body = `1) "x" ASN:0x0-1: (in front) \n    bundleID="com.fake.Editor"\n`;
        return realSpawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(body)})`], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      },
      armTtlMs: 3000,
    });
    g.arm();
    await until(() => calls.some((c) => c.cmd === "/usr/bin/lsappinfo"));
    await sleep(120);
    g.confirm();
    await sleep(300);
    check("没有 open -b", !calls.some((c) => c.cmd === "/usr/bin/open"), JSON.stringify(calls));
    check("被记成 no-steal", g.stats().lastSkip === "no-steal", JSON.stringify(g.stats()));
    g.stop();
  }

  section("11. 兜底路径：武装已过期 → 不 open");
  {
    const calls = [];
    const g = createForegroundGuard({
      platform: "darwin",
      exists: () => false,
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        const n = calls.filter((c) => c.cmd === "/usr/bin/lsappinfo").length;
        const body = `1) "x" ASN:0x0-1: (in front) \n    bundleID="${n <= 1 ? "com.fake.Editor" : "com.fake.Browser"}"\n`;
        return realSpawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(body)})`], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      },
      armTtlMs: 100,
    });
    g.arm();
    await until(() => calls.some((c) => c.cmd === "/usr/bin/lsappinfo"));
    await sleep(200);
    g.confirm();
    await sleep(250);
    check("过期之后不 open", !calls.some((c) => c.cmd === "/usr/bin/open"), JSON.stringify(calls));
    g.stop();
  }

  section("12. 并发两个守护各记各的，互不串");
  {
    const a = helperGuard();
    const b = helperGuard({ FAKE_STEAL: "0" });
    a.arm();
    b.arm();
    await until(() => a.events().find((e) => e.t === "armed") && b.events().find((e) => e.t === "armed"));
    a.confirm();
    b.confirm();
    await until(() => a.events().find((e) => e.t === "restore"));
    await until(() => b.events().find((e) => e.t === "skip"));
    check("A 还了", a.stats().restores === 1 && a.stats().skips === 0, JSON.stringify(a.stats()));
    check("B 没还", b.stats().restores === 0 && b.stats().skips === 1, JSON.stringify(b.stats()));
    a.stop();
    b.stop();
  }

  section("13. helper 候选路径：装完那份和仓库那份都在名单里");
  {
    const c = helperCandidates("/opt/rt");
    check("含运行时目录那份", c.includes(path.join("/opt/rt", "mac-foreground", "aic-fg")), JSON.stringify(c));
    check(
      "含仓库检出那份",
      c.includes(path.join("/opt/rt", "..", "native-host", "mac-foreground", "aic-fg")),
      JSON.stringify(c)
    );
  }

  section("14. 真 helper（macOS 上编出来了才跑）：ready 帧说得出话");
  {
    const repoBin = path.join(path.dirname(SELF), "..", "native-host", "mac-foreground", "aic-fg");
    if (process.platform !== "darwin" || !fs.existsSync(repoBin)) {
      console.log(`  \x1b[90m·\x1b[0m 本机没有编好的 aic-fg（${process.platform}），这一节不适用——兜底路径已由第 9~11 节覆盖`);
    } else {
      const g = createForegroundGuard({ platform: "darwin", base: path.join(path.dirname(SELF), "..", "mcp") });
      g.arm();
      const ready = await until(() => g.events().find((e) => e.t === "ready"));
      check("真 helper 起来了并报了 ready", !!ready, JSON.stringify(g.events()));
      check("走的是 helper 模式", g.stats().mode === "helper", JSON.stringify(g.stats()));
      const armed = await until(() => g.events().find((e) => e.t === "armed"));
      check("真 helper 认 arm", !!armed, JSON.stringify(g.events()));
      g.confirm();
      const sk = await until(() => g.events().find((e) => e.t === "skip"));
      check("没有被抢时真 helper 不动手", sk?.why === "no-steal", JSON.stringify(g.events()));
      g.stop();
    }
  }

  section("15. e2e 启动器来源比对（scripts/launcher-provenance.mjs）");
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-prov-"));
    const ws = path.join(tmp, "mcp");
    const rt = path.join(tmp, "rt");
    fs.mkdirSync(path.join(ws, "cdp"), { recursive: true });
    fs.mkdirSync(path.join(rt, "cdp"), { recursive: true });
    fs.writeFileSync(path.join(ws, "server.mjs"), 'const VERSION = "9.9.9";\n');
    fs.writeFileSync(path.join(ws, "cdp", "client.mjs"), "export const a = 1;\n");
    fs.writeFileSync(path.join(rt, "server.mjs"), 'const VERSION = "9.9.9";\n');
    fs.writeFileSync(path.join(rt, "cdp", "client.mjs"), "export const a = 1;\n");

    check("列出的是相对路径且带子目录", JSON.stringify(listMjs(ws)) === '["cdp/client.mjs","server.mjs"]', JSON.stringify(listMjs(ws)));
    check("一致时 ok", compareInstalledMcp(ws, rt).ok === true);
    check("版本号读得出", versionOf(path.join(rt, "server.mjs")) === "9.9.9");

    let r = provenanceReport({ launcher: "L", custom: false, workspaceMcpDir: ws, runtimeDir: rt });
    check("一致时不致命", r.fatal === null, JSON.stringify(r));
    check("首行报了来源路径与版本", r.line.includes(path.join(rt, "server.mjs")) && r.line.includes("9.9.9"), r.line);

    fs.writeFileSync(path.join(ws, "cdp", "client.mjs"), "export const a = 2;\n");
    r = provenanceReport({ launcher: "L", custom: false, workspaceMcpDir: ws, runtimeDir: rt });
    check("内容不同 → 致命", !!r.fatal && r.fatal.includes("cdp/client.mjs（内容不同）"), JSON.stringify(r));
    check("致命文案里写了怎么办", r.fatal.includes("scripts/install.mjs") && r.fatal.includes("AGENT_IN_CHROME_E2E_LAUNCHER"), r.fatal);

    fs.writeFileSync(path.join(ws, "cdp", "client.mjs"), "export const a = 1;\n");
    fs.writeFileSync(path.join(ws, "brand-new.mjs"), "export const b = 1;\n");
    r = provenanceReport({ launcher: "L", custom: false, workspaceMcpDir: ws, runtimeDir: rt });
    check("新模块没装过去 → 也致命", !!r.fatal && r.fatal.includes("brand-new.mjs（没装过去）"), JSON.stringify(r));

    const rc = provenanceReport({ launcher: "/my/launcher", custom: true, workspaceMcpDir: ws, runtimeDir: rt });
    check("自定义启动器不比对、不致命", rc.fatal === null && rc.line.includes("/my/launcher"), JSON.stringify(rc));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} 通过, ${fail} 失败\x1b[0m`);
  if (fail) console.log("失败项：\n  - " + failures.join("\n  - "));
  console.log("");
  process.exit(fail === 0 ? 0 : 1);
}
