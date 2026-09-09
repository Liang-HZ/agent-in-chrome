#!/usr/bin/env node
// Agent in Chrome — native messaging host
//
// 这个进程由 Chrome 拉起，生命周期跟着扩展的 service worker 走（SW 一死就收到 EOF）。
// 所以它不持有任何业务状态，只做两件事：
//   1. stdio 长度前缀协议  <->  unix socket 上的换行分隔 JSON
//   2. 每 20s 往扩展发一个 ping，把 MV3 的 30s 空闲计时器顶回去
//
// 铁律：stdout 是协议通道，除了帧什么都不能写。日志一律进文件。

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOCK = process.env.AGENT_IN_CHROME_SOCK || path.join(os.homedir(), ".agent-in-chrome", "agent-in-chrome.sock");
const LOG = path.join(os.homedir(), ".agent-in-chrome", "agent-in-chrome-host.log");
const PING_MS = 20_000;
const RECONNECT_MS = 1_000;
const RECONNECT_MAX_MS = 3_000;

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const SOCK_LINE_MAX = 8 * 1024 * 1024;

const LOG_MAX_BYTES = 2_000_000;

const LOG_CHECK_EVERY_BYTES = 64 * 1024;
let logSinceCheck = Infinity;

function log(...parts) {
  try {
    logSinceCheck += parts.join(" ").length + 32;
    if (logSinceCheck >= LOG_CHECK_EVERY_BYTES) {
      logSinceCheck = 0;
      try {
        if (fs.statSync(LOG).size >= LOG_MAX_BYTES) fs.renameSync(LOG, `${LOG}.1`);
      } catch {}
    }
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(" ")}\n`, { mode: 0o600 });
  } catch {}
}

function toChrome(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let stdinChunks = [];
let stdinBuffered = 0;

/* 把队首合并到至少 n 字节（只动队首，后面的块一概不碰）。调用方保证 stdinBuffered >= n */
function coalesceHead(n) {
  while (stdinChunks[0].length < n) stdinChunks.splice(0, 2, Buffer.concat([stdinChunks[0], stdinChunks[1]]));
}

function takeHead(n) {
  const out = Buffer.allocUnsafe(n);
  let off = 0;
  while (off < n) {
    const c = stdinChunks[0];
    const want = n - off;
    if (c.length <= want) {
      c.copy(out, off);
      off += c.length;
      stdinChunks.shift();
    } else {
      c.copy(out, off, 0, want);
      stdinChunks[0] = c.subarray(want);
      off += want;
    }
  }
  stdinBuffered -= n;
  return out;
}

process.stdin.on("data", (chunk) => {
  stdinChunks.push(chunk);
  stdinBuffered += chunk.length;
  for (;;) {
    if (stdinBuffered < 4) return;
    coalesceHead(4);
    const len = stdinChunks[0].readUInt32LE(0);
    if (len > MAX_FRAME_BYTES) {
      log(`扩展发来的帧长度不合理（${len} 字节 > 上限 ${MAX_FRAME_BYTES}），流已错位，退出让 Chrome 重新拉起`);
      process.exit(1);
    }
    if (stdinBuffered < 4 + len) return;
    takeHead(4);
    const body = takeHead(len);
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      log("扩展发来的帧解析失败:", e.message);
      continue;
    }
    onFromExtension(msg);
  }
});
process.stdin.on("end", () => {
  log("扩展断开（SW 可能被回收），退出");
  process.exit(0);
});
process.stdin.on("error", (e) => {
  log("stdin 错误:", e.message);
  process.exit(0);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { getToken, bridgeEndpoint, dataDirFor, handshakeNonce, handshakeProof, timingSafeEqualStr } = await import(
  fs.existsSync(path.join(HERE, "token.mjs")) ? "./token.mjs" : "../mcp/token.mjs"
);
const ENDPOINT = bridgeEndpoint(SOCK);
const ENDPOINT_IS_PIPE = ENDPOINT !== SOCK || process.platform === "win32";
const LEGACY_TOKEN_HELLO_OK = !ENDPOINT_IS_PIPE;
const LEGACY_HELLO_WAIT_MS = 800;
/* 握手整体的死线：超了就断开重连，令牌一个字节都不发 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const cfgMod = await import(fs.existsSync(path.join(HERE, "config.mjs")) ? "./config.mjs" : "../mcp/config.mjs");

let tokenCache = null;
function authToken() {
  if (tokenCache === null) {
    try {
      tokenCache = getToken(dataDirFor(SOCK));
    } catch (e) {
      log("读不到桥接令牌:", e.message);
      tokenCache = "";
    }
  }
  return tokenCache;
}

let sock = null;
let sockBuf = "";
let reconnectTimer = null;
let lastExtHello = null;
let authWarned = false;

let agentLinkUp = null;
function notifyAgentLink(up) {
  if (agentLinkUp === up) return;
  agentLinkUp = up;
  toChrome({ type: "agent-link", up });
}

function toAgent(obj) {
  if (!sock || sock.destroyed) return false;
  try {
    sock.write(JSON.stringify(obj) + "\n");
    return true;
  } catch (e) {
    log("写 socket 失败:", e.message);
    return false;
  }
}

let lastDropWhy = null;
let dropRepeats = 0;
function flushDropRepeats() {
  if (dropRepeats > 0) log(`（上一条「${lastDropWhy}」又重复了 ${dropRepeats} 次）`);
  dropRepeats = 0;
}
function noteDrop(why) {
  if (why === lastDropWhy) {
    dropRepeats++;
    return;
  }
  flushDropRepeats();
  lastDropWhy = why;
  log("与 agent 断开:", why);
}

function connectSocket() {
  if (sock && !sock.destroyed) return;
  if (ENDPOINT === SOCK && !fs.existsSync(SOCK)) {
    scheduleReconnect();
    return;
  }
  const s = net.connect(ENDPOINT);
  s.setEncoding("utf8");

  const cnonce = handshakeNonce();
  let greeted = false;
  let provedWith = null;
  let verified = false;

  const greet = (snonce) => {
    if (greeted || s.destroyed) return;
    greeted = true;
    provedWith = snonce || null;
    const frame = { type: "hello", role: "host", pid: process.pid };
    if (snonce) {
      frame.nonce = cnonce;
      frame.proof = handshakeProof(authToken(), "client", snonce, cnonce);
    } else {
      frame.token = authToken();
    }
    if (sock !== s) return;
    if (!toAgent(frame)) return;
    if (lastExtHello) toAgent(lastExtHello);
  };
  let dropWarned = false;

  const shook = () => greeted && (verified || LEGACY_TOKEN_HELLO_OK);
  const hsTimer = setTimeout(() => {
    if (shook()) return;
    drop(
      ENDPOINT_IS_PIPE
        ? "握手超时：对面没出题、也没证明它握着同一份令牌（令牌没有发出去）"
        : "握手超时"
    );
  }, HANDSHAKE_TIMEOUT_MS);
  hsTimer.unref?.();

  s.on("connect", () => {
    sock = s;
    sockBuf = "";
    flushDropRepeats();
    lastDropWhy = null;
    reconnectDelay = RECONNECT_MS;
    log("已连上 agent:", SOCK);
    notifyAgentLink(true);
    if (LEGACY_TOKEN_HELLO_OK) {
      const t = setTimeout(() => greet(null), LEGACY_HELLO_WAIT_MS);
      t.unref?.();
    }
    toChrome({ type: "ping" });
  });

  s.on("data", (chunk) => {
    sockBuf += chunk;
    let idx;
    while ((idx = sockBuf.indexOf("\n")) >= 0) {
      const line = sockBuf.slice(0, idx).trim();
      sockBuf = sockBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        log("agent 发来的行解析失败:", e.message);
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      // ---- 握手：这两帧只属于 host 与主之间，绝不往扩展转发
      if (msg.type === "challenge") {
        if (typeof msg.nonce === "string" && msg.nonce) greet(msg.nonce);
        continue;
      }
      if (msg.type === "welcome") {
        if (!provedWith) continue;
        verified =
          typeof msg.proof === "string" &&
          timingSafeEqualStr(msg.proof, handshakeProof(authToken(), "server", provedWith, cnonce));
        if (!verified) {
          impostor = true;
          drop("对面拿不出反向证明：占着这个端点的不是主（令牌没有发出去）");
        }
        continue;
      }
      if (msg.type === "error" && msg.code === "unauthorized") {
        if (!authWarned) {
          authWarned = true;
          log("agent 拒绝了我们的令牌:", msg.message || "unauthorized");
        }
        continue;
      }
      if (ENDPOINT_IS_PIPE && !verified) {
        if (!dropWarned) {
          dropWarned = true;
          log("丢弃未验明正身的对端发来的帧（之后同类不再记）:", msg.type || "无 type");
        }
        continue;
      }
      toChrome(msg);
    }
    if (sockBuf.length > SOCK_LINE_MAX) {
      sockBuf = "";
      drop(`agent 侧单行超过 ${SOCK_LINE_MAX} 字节还没有换行，丢弃并重连`);
    }
  });

  let dropped = false;
  let impostor = false;
  const drop = (why) => {
    if (dropped) return;
    dropped = true;
    clearTimeout(hsTimer);
    if (sock === s) sock = null;
    s.destroy();
    noteDrop(why);
    notifyAgentLink(false);
    if (impostor) {
      log(
        `桥接端点被一个拿不出令牌的进程占着，退出让 Chrome 重新拉起（令牌没有发出去）。` +
          `请检查是否有别的进程抢先建了这个管道名，或对面是旧版本；确认干净后重启浏览器扩展或所有会话。`
      );
      process.exit(1);
    }
    scheduleReconnect();
  };
  s.on("error", (e) => drop(e.message));
  s.on("close", () => drop("closed"));
}

let reconnectDelay = RECONNECT_MS;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function onFromExtension(msg) {
  if (msg.type === "pong") return;
  if (msg.type === "hello" && msg.role === "extension") lastExtHello = msg;
  if (msg.type === "config-get") {
    const r = cfgMod.loadSync();
    toChrome({ type: "config-result", id: msg.id, ok: r.value !== null, value: r.value, source: r.source, problems: r.problems });
    return;
  }
  if (msg.type === "config-set") {
    try {
      const patch = msg.patch && typeof msg.patch === "object" ? msg.patch : {};
      const probe = cfgMod.normalize({ tools: patch.tools || {} });
      if (probe.value === null || probe.problems.length) {
        toChrome({ type: "config-result", id: msg.id, ok: false, error: `无效设置：${probe.problems.join("；")}` });
        return;
      }
      const cur = cfgMod.loadSync();
      const base = cur.value ?? cfgMod.defaults();
      if (patch.tools && typeof patch.tools === "object") base.tools = { ...base.tools, ...patch.tools };
      const clean = cfgMod.saveSync(base);
      toChrome({ type: "config-result", id: msg.id, ok: true, value: clean, rebuilt: cur.source === "error" });
    } catch (e) {
      toChrome({ type: "config-result", id: msg.id, ok: false, error: String(e?.message || e) });
    }
    return;
  }
  if (!toAgent(msg)) {
    log("丢弃（agent 未连接）:", msg.type, msg.id || "");
  }
}

// 入站消息会重置 SW 的 30s 空闲计时器 —— 这是让连接活下去的关键
setInterval(() => toChrome({ type: "ping" }), PING_MS).unref?.();

log(`host 启动 pid=${process.pid} sock=${SOCK}`);
connectSocket();
