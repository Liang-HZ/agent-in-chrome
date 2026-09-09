#!/usr/bin/env node

import {
  parseArgs,
  UsageError,
  normalizeDomain,
  normalizeDomains,
  cookieKey,
  isSessionCookie,
  ledgerRowIsSession,
  pinSessionCookies,
  diffImported,
  whyDropped,
  pruneLedger,
  selectBatches,
  domainMatches,
  emptyLedger,
  formatBorrowReport,
  STORAGE_CAVEAT,
  LEDGER_MAX_BATCHES,
  LEDGER_MAX_ENTRIES,
} from "./borrow-login.mjs";

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${String(extra).slice(0, 200)}` : ""}`);
    failed++;
  }
};
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

section("域名规范化");
check("前导点去掉（cookie 域天然带点）", normalizeDomain(".github.com") === "github.com");
check("大小写归一", normalizeDomain("GitHub.COM") === "github.com");
check("整条 URL 粘进来也认", normalizeDomain("https://github.com/foo/bar?x=1#y") === "github.com");
check("端口去掉", normalizeDomain("localhost:8080") === "localhost");
check("尾点（FQDN 写法）去掉", normalizeDomain("github.com.") === "github.com");
check("两边空白去掉", normalizeDomain("  github.com  ") === "github.com");
check("单标签域名（localhost）放行", normalizeDomain("localhost") === "localhost");
check("中文域名转成 punycode", normalizeDomain("中文.com") === "xn--fiq228c.com");
check("空串不是域名", normalizeDomain("") === null);
check("只有点不是域名", normalizeDomain("...") === null);
check("带空格的不是域名", normalizeDomain("a b.com") === null);
check("通配符不是域名", normalizeDomain("*.github.com") === null);
{
  const r = normalizeDomains([".GitHub.com", "github.com", "https://news.ycombinator.com/", "呵呵 呵"]);
  check("一批：去重 + 保序", JSON.stringify(r.domains) === JSON.stringify(["github.com", "news.ycombinator.com"]), JSON.stringify(r.domains));
  check("一批：不合法的被点名挑出来", r.invalid.length === 1 && r.invalid[0] === "呵呵 呵");
}

section("参数解析");
{
  const a = parseArgs(["--domains", "github.com,.Example.COM"]);
  check("--domains 逗号分隔 + 规范化", JSON.stringify(a.domains) === JSON.stringify(["github.com", "example.com"]));
  check("默认是借用模式", a.mode === "borrow");
  check("默认不留文件", a.keepFile === false);
  check("默认不 pin 会话 cookie", a.pinSessionHours === null);
}
check("--domains=a,b 等号写法", JSON.stringify(parseArgs(["--domains=a.com,b.com"]).domains) === JSON.stringify(["a.com", "b.com"]));
check("--domains 可以给多次", parseArgs(["--domains", "a.com", "--domains", "b.com"]).domains.length === 2);
check("--status 进查看模式", parseArgs(["--status"]).mode === "status");
check("--release 进归还模式", parseArgs(["--release"]).mode === "release");
check("--release --all", parseArgs(["--release", "--all"]).all === true);
check("--profile 收下路径", parseArgs(["--status", "--profile", "/tmp/p"]).profile === "/tmp/p");
check("--pin-session 收下小时数", parseArgs(["--domains", "a.com", "--pin-session", "12"]).pinSessionHours === 12);
check("-h", parseArgs(["-h"]).help === true);

{
  const e = throws(() => parseArgs([]));
  check("不给 --domains 直接报错", e instanceof UsageError, e?.message);
  check("报错说清下一步（举了个例子）", /--domains github\.com/.test(e?.message || ""), e?.message);
  check("报错说清什么都没做", /什么都没做/.test(e?.message || ""));
}
check("不认识的参数报错并点名", /--nope/.test(throws(() => parseArgs(["--nope"]))?.message || ""));
check("--domains 后面没值报错", throws(() => parseArgs(["--domains"])) instanceof UsageError);
check("--pin-session 要正数", throws(() => parseArgs(["--domains", "a.com", "--pin-session", "0"])) instanceof UsageError);
check("--pin-session 不收非数字", throws(() => parseArgs(["--domains", "a.com", "--pin-session", "很久"])) instanceof UsageError);
check("--status 不接受 --domains", throws(() => parseArgs(["--status", "--domains", "a.com"])) instanceof UsageError);
check("--all 不能脱离 --release", throws(() => parseArgs(["--domains", "a.com", "--all"])) instanceof UsageError);
check("--wipe 单独给：拒", throws(() => parseArgs(["--release", "--wipe"])) instanceof UsageError);
check("--wipe 必须配 --release --all", parseArgs(["--release", "--all", "--wipe"]).wipe === true);
check(
  "--wipe 的报错讲清它会清掉用户自己登的站",
  /你自己手动登录的站点/.test(throws(() => parseArgs(["--release", "--wipe"]))?.message || "")
);
check("不合法域名在解析阶段就拦下并点名", /呵呵/.test(throws(() => parseArgs(["--domains", "呵呵 呵"]))?.message || ""));

section("cookie 判据");
check("键 = name+domain+path 的 JSON 元组", cookieKey({ name: "a", domain: ".x.com", path: "/" }) === '["a",".x.com","/"]');
check("键不会被分隔符撞混", cookieKey({ name: "a", domain: "x", path: '","' }) !== cookieKey({ name: "a", domain: 'x","', path: "" }));
check("expires:-1 是会话 cookie", isSessionCookie({ name: "a", expires: -1 }) === true);
check("session:true 是会话 cookie", isSessionCookie({ name: "a", session: true, expires: 123 }) === true);
check("没有 expires 字段也算会话 cookie", isSessionCookie({ name: "a" }) === true);
check("带未来 expires 是持久 cookie", isSessionCookie({ name: "a", expires: Date.now() / 1000 + 999 }) === false);
check("账本行的持久 cookie 不会被误判成会话", ledgerRowIsSession({ name: "p", session: false }) === false);
check("账本行的会话 cookie 认得出", ledgerRowIsSession({ name: "s", session: true }) === true);
check("同一条账本行用 isSessionCookie 会误判（所以才要分开）", isSessionCookie({ name: "p", session: false }) === true);

check("没种上的理由：SameSite=None 缺 secure", /SameSite=None/.test(whyDropped({ sameSite: "None", secure: false })));
check("没种上的理由：已过期", /过期/.test(whyDropped({ expires: 1 })));
check("没种上的理由：兜底说到条数上限", /上限/.test(whyDropped({ name: "x" })));

section("--pin-session：把会话 cookie 改写成持久 cookie");
{
  const now = 1_700_000_000_000;
  const src = [
    { name: "s", domain: ".x.com", path: "/", value: "1", expires: -1, session: true },
    { name: "p", domain: ".x.com", path: "/", value: "2", expires: 1_800_000_000 },
  ];
  const r = pinSessionCookies(src, 2, now);
  check("会话那条拿到 expires", r.cookies[0].expires === Math.floor(now / 1000) + 7200);
  check("会话那条的 session 标记被摘掉（否则 CDP 那边语义打架）", r.cookies[0].session === undefined);
  check("持久那条一个字没动", JSON.stringify(r.cookies[1]) === JSON.stringify(src[1]));
  check("改了哪几条要点名（报告要用）", r.pinned.length === 1 && r.pinned[0].name === "s");
  check("不给小时数就什么都不改", pinSessionCookies(src, null).pinned.length === 0);
}

section("导入后的逐字比对（cookies_import 自带那道只看在不在，不看值）");
{
  const sent = [
    { name: "sess", domain: ".x.com", path: "/", value: "AAA", httpOnly: true, secure: true },
    { name: "pref", domain: ".x.com", path: "/", value: "BBB" },
    { name: "bad", domain: ".x.com", path: "/", value: "CCC", sameSite: "None", secure: false },
  ];
  const got = [
    { name: "sess", domain: ".x.com", path: "/", value: "AAA", httpOnly: true, secure: true, expires: -1 },
    { name: "pref", domain: ".x.com", path: "/", value: "BBB", expires: -1 },
  ];
  const d = diffImported(sent, got);
  check("值一致的算种上了", d.matched.length === 2);
  check("httpOnly 属性保住了才算数", d.matched.some((c) => c.name === "sess"));
  check("没种上的点名 + 给理由", d.missing.length === 1 && /SameSite=None/.test(d.missing[0].why));
  check("没有假的值不一致", d.mismatched.length === 0);
}
{
  const sent = [{ name: "sess", domain: ".x.com", path: "/", value: "AAAA", httpOnly: true }];
  const got = [{ name: "sess", domain: ".x.com", path: "/", value: "AAAB", httpOnly: true }];
  const d = diffImported(sent, got);
  check("值差一个字节 → 报 mismatched，不报成功", d.mismatched.length === 1 && d.matched.length === 0);
  check("mismatched 点名是哪个字段", d.mismatched[0].fields.includes("value"));
}
{
  const sent = [{ name: "s", domain: ".x.com", path: "/", value: "A", httpOnly: true }];
  const got = [{ name: "s", domain: ".x.com", path: "/", value: "A", httpOnly: false }];
  check("httpOnly 掉了也算不一致", diffImported(sent, got).mismatched[0].fields.includes("httpOnly"));
}
{
  const sent = [
    { name: "a", domain: ".x.com", path: "/", value: "1" },
    { name: "a", domain: ".x.com", path: "/admin", value: "2" },
  ];
  const got = [{ name: "a", domain: ".x.com", path: "/", value: "1" }];
  const d = diffImported(sent, got);
  check("同名不同 path 分得清", d.matched.length === 1 && d.missing.length === 1 && d.missing[0].path === "/admin");
}

section("借用账本：只增不减是不允许的");
const mkBatch = (id, atMs, domains, names) => ({
  id,
  atMs,
  at: new Date(atMs).toISOString(),
  domains,
  cookies: names.map((n) => ({ name: n, domain: `.${domains[0]}`, path: "/" })),
});
{
  const led = { version: 1, batches: [mkBatch("b1", 1000, ["x.com"], ["a", "b"]), mkBatch("b2", 2000, ["y.com"], ["c"])] };
  const live = new Set([
    cookieKey({ name: "a", domain: ".x.com", path: "/" }),
    cookieKey({ name: "c", domain: ".y.com", path: "/" }),
  ]);
  const r = pruneLedger(led, live);
  check("浏览器里没了的条目被销掉", r.droppedEntries.length === 1 && r.droppedEntries[0].name === "b");
  check("还在的条目留着", r.ledger.batches.reduce((n, b) => n + b.cookies.length, 0) === 2);
}
{
  const led = { version: 1, batches: [mkBatch("b1", 1000, ["x.com"], ["a"])] };
  const r = pruneLedger(led, new Set());
  check("整批都没了就把批次也销掉", r.ledger.batches.length === 0 && r.emptiedBatches.includes("b1"));
}
{
  const led = { version: 1, batches: [mkBatch("b1", 1000, ["x.com"], ["a"])] };
  const r = pruneLedger(led, null);
  check("liveKeys 给 null 时一条都不动", r.ledger.batches.length === 1 && r.droppedEntries.length === 0);
}
{
  const batches = [];
  for (let i = 0; i < LEDGER_MAX_BATCHES + 3; i++) batches.push(mkBatch(`b${i}`, 1000 + i, ["x.com"], [`c${i}`]));
  const r = pruneLedger({ version: 1, batches }, null);
  check("批次数超上限：丢最老的", r.ledger.batches.length === LEDGER_MAX_BATCHES && r.cappedBatches.length === 3);
  check("丢掉的最老那批被报出来（不许静默）", r.cappedBatches[0].id === "b0");
  check("留下的是最新那批", r.ledger.batches[r.ledger.batches.length - 1].id === `b${LEDGER_MAX_BATCHES + 2}`);
}
{
  const big = (id, at, n) => mkBatch(id, at, ["x.com"], Array.from({ length: n }, (_, i) => `c${id}-${i}`));
  const r = pruneLedger({ version: 1, batches: [big("b1", 1000, LEDGER_MAX_ENTRIES), big("b2", 2000, 10)] }, null);
  check("条目数超上限也会砍最老的批次", r.cappedBatches.some((b) => b.id === "b1"));
  check("砍完在上限之内", r.ledger.batches.reduce((n, b) => n + b.cookies.length, 0) <= LEDGER_MAX_ENTRIES);
}
check("空账本不炸", pruneLedger(emptyLedger(), new Set()).ledger.batches.length === 0);
check("坏形状（batches 不是数组）当空账本处理", pruneLedger({ batches: "呵呵" }, new Set()).ledger.batches.length === 0);

section("归还挑哪些批次");
{
  const led = {
    version: 1,
    batches: [mkBatch("b1", 1000, ["x.com"], ["a"]), mkBatch("b2", 2000, ["y.com"], ["b"]), mkBatch("b3", 3000, ["z.com"], ["c"])],
  };
  check("默认只还最近一批", selectBatches(led).picked.map((b) => b.id).join() === "b3");
  check("默认剩下的原样留着", selectBatches(led).rest.map((b) => b.id).join() === "b1,b2");
  check("--all 全还", selectBatches(led, { all: true }).picked.length === 3);
  const byDomain = selectBatches(led, { domains: ["y.com"] });
  check("按域挑：只挑中那一批", byDomain.picked.length === 1 && byDomain.picked[0].id === "b2");
  check("按域挑：其余留在 rest 里", byDomain.rest.length === 2);
}
{
  const led = { version: 1, batches: [{ id: "b", atMs: 1, domains: ["x.com"], cookies: [
    { name: "a", domain: "api.x.com", path: "/" },
    { name: "b", domain: ".other.com", path: "/" },
  ] }] };
  const r = selectBatches(led, { domains: ["x.com"] });
  check("子域的 cookie 也挑得中", r.picked[0].cookies.length === 1 && r.picked[0].cookies[0].domain === "api.x.com");
  check("同一批里不匹配的留在 rest（不会被顺手删掉）", r.rest[0].cookies[0].name === "b");
}
check("域匹配认子域", domainMatches("api.x.com", new Set(["x.com"])) === true);
check("域匹配认前导点", domainMatches(".x.com", new Set(["x.com"])) === true);
check("域匹配不认后缀碰瓷（notx.com）", domainMatches("notx.com", new Set(["x.com"])) === false);

section("报告：该说的必须说到");
{
  const sent = [
    { name: "s", domain: ".x.com", path: "/", value: "A", expires: -1 },
    { name: "p", domain: ".x.com", path: "/", value: "B", expires: 9_999_999_999 },
    { name: "bad", domain: ".x.com", path: "/", value: "C", sameSite: "None", secure: false },
  ];
  const got = [
    { name: "s", domain: ".x.com", path: "/", value: "A", expires: -1 },
    { name: "p", domain: ".x.com", path: "/", value: "B", expires: 9_999_999_999 },
  ];
  const text = formatBorrowReport({
    domains: ["x.com"],
    sent,
    diff: diffImported(sent, got),
    importReported: { requested: 3, imported: 2 },
    pinned: [],
    profileDir: "/tmp/prof",
    browser: { pid: 123, version: "Chrome/151" },
    ledgerNote: null,
  }).join("\n");
  check("报出种上几条", /种上并逐字校验通过：2 条/.test(text), text);
  check("没种上的点名 + 理由", /bad @ \.x\.com\/ —— SameSite=None/.test(text), text);
  check("说清数字是自己读回来的，不是照抄工具返回值", /不是照抄它/.test(text));
  check("会话 / 持久各几条：只算真的种上的", /只算真的种上了的那 2 条）：1 条是\*\*会话 cookie\*\*，1 条是持久 cookie/.test(text), text);
  check("点明会话 cookie 活不过重启", /一重启就没了|重启就没了/.test(text), text);
  check("点明持久 cookie 要靠优雅退出", /优雅退出/.test(text));
  check("给出 --pin-session 这条出路（并说明代价）", /--pin-session/.test(text) && /延长了凭据寿命/.test(text));
  check("localStorage / IndexedDB 那条边界必须在", text.includes(STORAGE_CAVEAT));
  check("告诉用户浏览器还开着 + 怎么用 / 怎么还 / 怎么收", /pid=123/.test(text) && /--release/.test(text) && /--stop/.test(text));
}
{
  const sent = [{ name: "s", domain: ".x.com", path: "/", value: "A" }];
  const got = [{ name: "s", domain: ".x.com", path: "/", value: "B" }];
  const text = formatBorrowReport({
    domains: ["x.com"],
    sent,
    diff: diffImported(sent, got),
    importReported: { requested: 1, imported: 1 },
    pinned: [],
    profileDir: "/tmp/prof",
    browser: null,
    ledgerNote: null,
  }).join("\n");
  check("值对不上时报警，且不说成功", /值对不上：1 条/.test(text) && /别拿它当能用的登录态/.test(text), text);
}

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} 通过，${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);
