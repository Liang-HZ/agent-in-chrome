// 操作留痕（action trace）——**记录，不重放**。把每次工具调用的输入 / 成败 / 耗时 /
// 结果摘要 / 当时的页面按序号记下来，让人和模型能回看断在哪、断掉的那一步前面干了什么。落点是
// MCP server 进程内存（权威）+ ~/.agent-in-chrome/traces/<session>.jsonl（副本），
// 每会话一个文件（一个文件只有一个进程写）。**它明确不做自动恢复**：浏览器状态基本
// 不可重放——ref 一定失效、页面可能已经导航走、点过的「提交」再点一次就是重复下单，
// 所以判断权留给模型，不交给自动化。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { looksLikeSecret, describe } from "./secret-shape.mjs";

// 凡是被上限砍掉的，都要在数据里留下痕迹（见 clip / summarize），
// 绝不能让人以为看到的就是全部。

const MAX_STEPS = 200;
const MAX_STR = 200;
const MAX_SUMMARY_JSON = 900;
const MAX_ERR = 1200;
const MAX_ARG_STR = 300;
const MAX_FILE_BYTES = 1_000_000;
const KEEP_FILES = 40;
const KEEP_DAYS = 7;

/*
 * 凭据字段名。**与 extension/sw.js 的 SECRET_HEADER 保持一致**，
 * 那边给请求头打码，这边给入参打码，用户看到的规则得是同一套。
 * 改这条时两边一起改。
 */
const SECRET_KEY = /^(cookie|set-cookie|authorization|proxy-authorization)$|token|secret|api[-_]?key|password/i;

const NOT_SECRET_KEY = new Set(["progresstoken"]);

function clip(s, max) {
  s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…<已截断，原 ${s.length} 字符>`;
}

function mask(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return `<已打码 ${s.length} 字符>`;
}

function redactValue(v, depth) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string") return clip(v, MAX_ARG_STR);
  if (t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) {
    if (depth >= 2) return `<${v.length} 项，已省略>`;
    return v.slice(0, 20).map((x) => redactValue(x, depth + 1)).concat(
      v.length > 20 ? [`<其余 ${v.length - 20} 项已省略>`] : []
    );
  }
  if (t === "object") {
    if (depth >= 3) return "<对象已省略>";
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = secretish(k, val) ? mask(val) : redactValue(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

function secretish(key, val) {
  if (NOT_SECRET_KEY.has(String(key).toLowerCase())) return false;
  if (!SECRET_KEY.test(key)) return false;
  return typeof val !== "boolean";
}

/*
 * 入参打码。除了按字段名认凭据，还有两条硬规则：
 *
 * **browser_type 的 text 一律只记长度。** 用户往页面里敲的东西——密码、验证码、
 * 银行卡号——全从这个字段进去，而 trace 是要落盘的。留个「在哪个输入框敲了几个字」
 * 足够回答「跑到哪一步了」，不值得为了看清关键词把密码写进磁盘。
 *
 * **browser_cookies_import 的 cookies[].value 一律只记长度。** 每一项都是可直接
 * 冒用的完整会话凭据（httpOnly 的明文也在），但字段名偏偏就叫 value，按字段名的
 * 那套认不出来——不点名处理就是整份 cookie jar 明文落盘。name/domain 留着：
 * 回看「导入了哪些站的哪几个 cookie」正需要它们，值则谁都不需要。
 */
export function redactArgs(toolName, args) {
  const out = redactValue(args && typeof args === "object" ? args : {}, 0) || {};
  if (toolName === "browser_type" && args && typeof args.text === "string") {
    out.text = mask(args.text);
  }
  if (toolName === "browser_cookies_import" && Array.isArray(args?.cookies) && Array.isArray(out.cookies)) {
    out.cookies = out.cookies.map((c, i) =>
      c && typeof c === "object" && typeof args.cookies[i]?.value === "string" ? { ...c, value: mask(args.cookies[i].value) } : c
    );
  }
  return out;
}

/*
 * JSON-RPC 请求里 `params._meta` 的打码版本。没有内容就返回 null（调用方据此不写字段）。
 * 走的是和入参完全相同的那套打码：字段名像凭据的（token / secret / api_key …）只留长度，
 * 长字符串截断留痕，深层结构省略——`_meta` 是调用方自由填的，里面出现 token 完全可能，
 * 而 trace 是要落盘的。
 */
export function redactMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (!Object.keys(meta).length) return null;
  return redactValue(meta, 0);
}

/*
 * 把入参里打了码的那些**原值**收集起来，好在结果摘要里也把它们抹掉。
 * 规则是「凡是决定要藏的值，从哪条路回来都得藏」——入参打了码不等于这个值不会绕道回来，
 * 个别工具的返回值会把刚输入的内容原样回显。
 */
export function collectSecrets(toolName, args) {
  const found = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 3) return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && secretish(k, val)) found.add(val);
      else if (val && typeof val === "object") walk(val, depth + 1);
    }
  };
  walk(args, 0);
  const out = [...found].filter((s) => s.length >= 8);
  if (toolName === "browser_type" && typeof args?.text === "string" && args.text) out.push(args.text);
  if (toolName === "browser_cookies_import" && Array.isArray(args?.cookies)) {
    for (const c of args.cookies) if (typeof c?.value === "string" && c.value.length >= 8) out.push(c.value);
  }
  return out;
}

/*
 * 已知会把用户输入原样回显的返回字段。这条是精确规则，不看长度，
 * 所以短密码、6 位验证码也盖得住。以后哪个工具也开始回显输入，加到这里。
 */
const SECRET_RESULT_FIELDS = { browser_type: ["typed"] };

function scrubSecrets(node, secrets, depth = 0) {
  if (!secrets.length || node == null || depth > 6) return node;
  if (typeof node === "string") {
    let s = node;
    for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join(mask(sec));
    return s;
  }
  if (Array.isArray(node)) return node.map((x) => scrubSecrets(x, secrets, depth + 1));
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = scrubSecrets(v, secrets, depth + 1);
    return out;
  }
  return node;
}

function shapeValue(v, depth, strMax) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string") return looksLikeSecret(v) ? describe(v) : clip(v, strMax);
  if (t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) {
    if (!v.length) return [];
    if (depth >= 2) return `<${v.length} 项，已省略>`;
    const o = { count: v.length, first: shapeValue(v[0], depth + 1, strMax) };
    if (v.length > 1) o.omitted = `其余 ${v.length - 1} 项未记入摘要`;
    return o;
  }
  if (t === "object") {
    if (depth >= 3) return "<对象已省略>";
    const keys = Object.keys(v);
    const out = {};
    for (const k of keys.slice(0, 14)) {
      out[k] = secretish(k, v[k]) ? mask(v[k]) : shapeValue(v[k], depth + 1, strMax);
    }
    if (keys.length > 14) out._omitted = `其余 ${keys.length - 14} 个字段未记入摘要`;
    return out;
  }
  return String(v);
}

function jsonLen(v) {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export function summarize(data) {
  if (data && typeof data === "object" && data.image && data.mimeType) {
    return { image: `<${data.mimeType}，base64 ${String(data.image).length} 字符，内容未记录>` };
  }
  let s = shapeValue(data, 0, MAX_STR);
  if (jsonLen(s) > MAX_SUMMARY_JSON) s = shapeValue(data, 0, 60);
  if (jsonLen(s) > MAX_SUMMARY_JSON) {
    let raw = "";
    try {
      raw = JSON.stringify(s);
    } catch {
      raw = String(s);
    }
    s = { clipped: clip(raw, MAX_SUMMARY_JSON), note: "结果摘要仍然超长，已按字符硬截断——这不是完整结果" };
  }
  return s;
}

export function fileNameFor(sessionId) {
  const raw = String(sessionId || "default");
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  const suffix = safe === raw ? "" : "-" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 6);
  return `${safe || "session"}${suffix}.jsonl`;
}

export function defaultTraceDir() {
  return process.env.AGENT_IN_CHROME_TRACE_DIR || path.join(os.homedir(), ".agent-in-chrome", "traces");
}

/*
 * 把调用方给的 session 参数解析成「确实落在 trace 目录里」的那个文件路径，
 * 命不中就返回 null——**绝不返回目录外的路径**。
 *
 * browser_trace 是显式暴露给模型的工具，它的 session 参数可能来自被注入的页面正文，
 * 而 path.join 会把 `../../x` 归一化到目录外。所以三条候选一律 resolve 之后再做目录
 * 前缀校验：末尾补分隔符，免得 `/x/traces-evil` 被 `/x/traces` 前缀蒙混过去。
 */
export function resolveTraceFile(dir, want) {
  const base = path.resolve(dir);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  const candidates = [path.join(base, fileNameFor(want)), path.join(base, want), path.join(base, want + ".jsonl")];
  for (const p of candidates) {
    const abs = path.resolve(p);
    if (!abs.startsWith(prefix)) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {}
  }
  return null;
}

export function createTrace({ sessionId, dir = defaultTraceDir(), enabled = true, version = "" } = {}) {
  const steps = [];
  const failedNums = [];
  let total = 0;
  let dropped = 0;
  let bytes = 0;
  let file = null;
  let diskError = null;

  let fileTried = false;
  function ensureFile() {
    if (fileTried || !enabled) return;
    fileTried = true;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      file = path.join(dir, fileNameFor(sessionId));
      fs.writeFileSync(
        file,
        JSON.stringify({ _meta: { session: sessionId, pid: process.pid, startedAt: new Date().toISOString(), version } }) + "\n",
        { mode: 0o600 }
      );
      bytes = fs.statSync(file).size;
    } catch (e) {
      file = null;
      diskError = String(e?.message || e);
    }
  }

  function writeLine(obj) {
    ensureFile();
    if (!file) return;
    try {
      const line = JSON.stringify(obj) + "\n";
      if (bytes + line.length > MAX_FILE_BYTES) {
        const head =
          JSON.stringify({
            _meta: { session: sessionId, pid: process.pid, compactedAt: new Date().toISOString(), version, dropped },
          }) + "\n";
        const body = steps.map((s) => JSON.stringify(s) + "\n").join("");
        fs.writeFileSync(file, head + body, { mode: 0o600 });
        bytes = Buffer.byteLength(head + body);
        return;
      }
      fs.appendFileSync(file, line);
      bytes += Buffer.byteLength(line);
    } catch (e) {
      diskError = String(e?.message || e);
      file = null;
    }
  }

  function begin(toolName, args, rpcMeta, batch) {
    total += 1;
    const step = {
      n: total,
      at: new Date().toISOString(),
      tool: toolName,
      args: redactArgs(toolName, args),
      reveal: args?.revealSecrets === true,
      secrets: collectSecrets(toolName, args).concat(rpcMeta ? collectSecrets("", rpcMeta) : []),
      t0: Date.now(),
    };
    if (batch && batch.of) {
      step.batchOf = batch.of;
      step.stepIndex = batch.index;
    }
    const m = redactMeta(rpcMeta);
    if (m) step.rpcMeta = m;
    return step;
  }

  function end(step, { ok, data, error, page } = {}) {
    if (!step) return null;
    const rec = {
      n: step.n,
      at: step.at,
      tool: step.tool,
      args: step.args,
      ...(step.rpcMeta ? { rpcMeta: step.rpcMeta } : {}),
      ...(step.batchOf ? { batchOf: step.batchOf, stepIndex: step.stepIndex } : {}),
      ok: !!ok,
      ms: Date.now() - step.t0,
      page: page || null,
    };
    if (!page) rec.pageNote = "这一步没取到页面状态（可能还没接管标签页，或桥接已断）";
    if (ok) {
      if (step.reveal) {
        rec.result = null;
        rec.resultNote = "该调用带了 revealSecrets:true，返回值含凭据原文，未记入 trace";
      } else {
        let sum = summarize(data);
        for (const f of SECRET_RESULT_FIELDS[step.tool] || []) {
          if (sum && typeof sum === "object" && typeof sum[f] === "string") sum[f] = mask(sum[f]);
        }
        rec.result = scrubSecrets(sum, step.secrets || []);
        rec.resultNote = "这是结果摘要，不是完整返回值";
      }
    } else {
      rec.error = scrubSecrets(clip(String(error?.message || error || "未知错误"), MAX_ERR), step.secrets || []);
    }

    steps.push(rec);
    if (!rec.ok) {
      failedNums.push(rec.n);
      while (failedNums.length > 100) failedNums.shift();
    }
    while (steps.length > MAX_STEPS) {
      steps.shift();
      dropped += 1;
    }
    writeLine(rec);
    return rec;
  }

  function meta() {
    const m = {
      session: sessionId,
      totalSteps: total,
      kept: steps.length,
      failedSteps: [...failedNums],
      lastFailedStep: failedNums.length ? failedNums[failedNums.length - 1] : null,
      file: file || null,
    };
    const gone = failedNums.filter((n) => !steps.some((s) => s.n === n));
    if (gone.length)
      m.failedOutOfMemory = `第 ${gone.join("、")} 步的失败详情已滚出内存缓冲，用 browser_trace {step:N} 从磁盘文件读回`;
    if (dropped) m.dropped = `最早的 ${dropped} 步已被环形缓冲挤掉，看到的不是全部`;
    if (diskError) m.diskNote = `trace 落盘失败（${diskError}），本会话的记录只在内存里，进程退出即丢`;
    return m;
  }

  return {
    get enabled() {
      return enabled;
    },
    get file() {
      return file;
    },
    begin,
    end,
    meta,
    list({ limit = 20, onlyFailed = false } = {}) {
      const ordered = [...steps].sort((a, b) => a.n - b.n);
      let rows = onlyFailed ? ordered.filter((s) => !s.ok) : ordered;
      const n = Math.max(1, Math.min(Number(limit) || 20, MAX_STEPS));
      const shown = rows.slice(-n);
      return {
        ...meta(),
        shown: shown.length,
        omittedOlder: rows.length > shown.length ? `另有 ${rows.length - shown.length} 步更早的未显示，调大 limit 或指定 step 查看` : undefined,
        steps: shown.map((s) => ({
          n: s.n,
          at: s.at,
          tool: s.tool,
          args: s.args,
          ...(s.rpcMeta ? { rpcMeta: s.rpcMeta } : {}),
          ...(s.batchOf ? { batchOf: s.batchOf, stepIndex: s.stepIndex } : {}),
          ok: s.ok,
          ms: s.ms,
          url: s.page?.url ?? null,
          title: s.page?.title ?? null,
          ...(s.ok ? { result: s.result, resultNote: s.resultNote } : { FAILED: true, error: s.error }),
        })),
      };
    },
    detail(n) {
      const want = Number(n);
      let s = steps.find((x) => x.n === want);
      let from = "内存";
      if (!s && file) {
        try {
          for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            if (!line) continue;
            const o = JSON.parse(line);
            if (o && o.n === want) {
              s = o;
              from = "磁盘文件";
              break;
            }
          }
        } catch {}
      }
      if (!s) {
        return {
          ...meta(),
          error: `第 ${want} 步既不在内存也不在磁盘文件里。` +
            (steps.length
              ? `内存当前保留 ${Math.min(...steps.map((x) => x.n))}–${Math.max(...steps.map((x) => x.n))} 步；更早的可能已被压实清掉。`
              : "本会话还没有任何记录。"),
        };
      }
      if (from === "磁盘文件") return { ...meta(), readFrom: from, step: s, prev: null, next: null };
      const ordered = [...steps].sort((a, b) => a.n - b.n);
      const idx = ordered.indexOf(s);
      const brief = (x) => (x ? { n: x.n, tool: x.tool, ok: x.ok, url: x.page?.url ?? null } : null);
      return { ...meta(), step: s, prev: brief(ordered[idx - 1]), next: brief(ordered[idx + 1]) };
    },
  };
}

export function listTraceFiles(dir = defaultTraceDir()) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      out.push({ name, file: full, sizeBytes: st.size, modified: new Date(st.mtimeMs).toISOString() });
    } catch {}
  }
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

/*
 * 读一个磁盘上的 trace 文件。坏行跳过并计数——不能因为一行坏了就说整份没有。
 * 给了 step 就只取那一步的完整记录（同 detail(n)，只是数据来自这个文件）。
 */
export function readTraceFile(full, { limit = 20, onlyFailed = false, step = null } = {}) {
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n").filter(Boolean);
  let meta = null;
  const rows = [];
  let bad = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o._meta) meta = o._meta;
      else rows.push(o);
    } catch {
      bad += 1;
    }
  }
  if (step != null) {
    const want = Number(step);
    const one = rows.find((r) => r && r.n === want);
    return {
      file: full,
      meta,
      totalSteps: rows.length,
      failedSteps: rows.filter((r) => !r.ok).map((r) => r.n),
      badLines: bad || undefined,
      readFrom: "磁盘文件",
      ...(one
        ? { step: one }
        : {
            error:
              `这份 trace 里没有第 ${want} 步` +
              (rows.length ? `（有 ${rows[0].n}–${rows[rows.length - 1].n} 步）。` : "（这份文件一步都没有）。"),
          }),
    };
  }
  const list = onlyFailed ? rows.filter((r) => !r.ok) : rows;
  const n = Math.max(1, Math.min(Number(limit) || 20, MAX_STEPS));
  return {
    file: full,
    meta,
    totalSteps: rows.length,
    failedSteps: rows.filter((r) => !r.ok).map((r) => r.n),
    badLines: bad || undefined,
    shown: Math.min(list.length, n),
    steps: list.slice(-n),
  };
}

/*
 * 清掉太老 / 太多的 trace 文件。
 * 不能无限长：每个会话一个文件，用久了目录里会有上千个。
 */
export function pruneTraceDir(dir = defaultTraceDir(), { keep = KEEP_FILES, days = KEEP_DAYS, keepFile = null } = {}) {
  const files = listTraceFiles(dir);
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  files.forEach((f, i) => {
    if (keepFile && f.file === keepFile) return;
    const old = new Date(f.modified).getTime() < cutoff;
    if (i >= keep || old) {
      try {
        fs.unlinkSync(f.file);
        removed += 1;
      } catch {}
    }
  });
  return removed;
}
