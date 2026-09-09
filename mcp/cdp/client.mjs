// 零依赖 CDP 客户端。CLI/headless 模式的传输层底座。
//
// 桌面模式里这一层是 Chrome 自己：扩展调它的调试器 API，浏览器内部
// 就把命令递给了目标标签页。CLI 模式没有扩展，我们自己连浏览器的 WebSocket 端点，
// 把同样的命令发出去——所以上层（sw.js 那 7000 行）可以完全不动。
//
// 只用 flatten 模式（attachToTarget({flatten:true})）：所有 target 的消息都走
// **同一条** WebSocket，靠 sessionId 分流。老式的嵌套 Target.sendMessageToTarget
// 已经废弃，而且每个 target 一条连接在 OOPIF 多的页面上会开出十几条。

import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

/*
 * 从 CDP 的 targetId 推出一个稳定的整数 tabId（31 位正整数，恒 >= 1）。
 * targetId 在标签页的整个生命周期里不变，所以由它推导出来的 tabId 天然跨进程一致
 * ——不能按进程自增：会话归属是跨进程持久化的，编号重排就会指到别的标签页上。
 */
export function tabIdForTarget(targetId) {
  const h = crypto.createHash("sha1").update(String(targetId)).digest();
  return (h.readUInt32BE(0) & 0x7fffffff) || 1;
}

export class CdpError extends Error {
  constructor(msg, { method, params, sessionId } = {}) {
    super(msg);
    this.name = "CdpError";
    this.method = method;
    this.params = params;
    this.sessionId = sessionId;
  }
}

/*
 * 传输层。CDP 有两条物理通道，帧格式（JSON-RPC）完全一样，只有「怎么送出去」不同：
 *
 *   · WebSocket —— `--remote-debugging-port` 开出来的 `ws://127.0.0.1:<port>`。
 *     **任何本机进程都连得上**，Chrome 不认令牌，端口号还写在 DevToolsActivePort 里。
 *     换来的是浏览器能被**别的进程收养**（KEEP 热复用、换主接管全靠它）。
 *   · 管道 —— `--remote-debugging-pipe`，走子进程的 fd 3（我们写）/ fd 4（我们读），
 *     帧之间用 `\0` 分隔。**天然只有父进程用得上**，Chrome 不监听任何 TCP 端口、
 *     也不写 DevToolsActivePort。代价是浏览器绑在本进程上：关掉 fd3/fd4 它自己退出。
 *
 * 选哪条在 browser-launch.mjs 里定（见那边的 USE_PIPE）。这里只管把两种通道
 * 抹平成同一个接口，上面 CdpClient 的逻辑一行都不用分叉。
 * 两个实现都提供 open({onMessage,onClose}) / write(frame) / close() 三个方法。
 */
class WsTransport {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
  }
  open({ onMessage, onClose }) {
    if (typeof WebSocket === "undefined") {
      return Promise.reject(
        new CdpError(
          `这条 CDP 通道要 Node 的全局 WebSocket，${process.version} 没有（Node 22+ 才有；` +
            `本机装的 Node 太老）。两条出路：升级到 Node 22+，或去掉 AGENT_IN_CHROME_KEEP=1 / ` +
            `AGENT_IN_CHROME_CDP_TRANSPORT=port —— 默认的管道通道在老 Node 上照常能跑，` +
            `代价只是每次会话都要冷启一次浏览器。`
        )
      );
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new CdpError(`连不上浏览器的 CDP 端点：${this.wsUrl}`));
      ws.onclose = () => onClose();
      ws.onmessage = (ev) => onMessage(ev.data);
    });
  }
  write(frame) {
    this.ws.send(JSON.stringify(frame));
  }
  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

class PipeTransport {
  /* @param read fd4 的可读流（Chrome → 我们） @param write fd3 的可写流（我们 → Chrome） */
  constructor(read, write) {
    this.read = read;
    this.write_ = write;
  }
  open({ onMessage, onClose }) {
    let parts = [];
    let partsLen = 0;
    this.read.on("data", (chunk) => {
      let start = 0;
      let i;
      while ((i = chunk.indexOf(0, start)) >= 0) {
        const piece = chunk.subarray(start, i);
        let raw;
        if (parts.length) {
          parts.push(piece);
          raw = Buffer.concat(parts, partsLen + piece.length).toString("utf8");
          parts = [];
          partsLen = 0;
        } else {
          raw = piece.toString("utf8");
        }
        start = i + 1;
        if (raw) onMessage(raw);
      }
      if (start < chunk.length) {
        const tail = chunk.subarray(start);
        parts.push(tail);
        partsLen += tail.length;
      }
    });
    const done = () => onClose();
    this.read.on("close", done);
    this.read.on("end", done);
    this.write_.on("close", done);
    this.write_.on("error", done);
    return Promise.resolve();
  }
  write(frame) {
    this.write_.write(JSON.stringify(frame) + "\0");
  }
  close() {
    try {
      this.read?.destroy();
    } catch {}
    try {
      this.write_?.destroy();
    } catch {}
  }
}

export class CdpClient {
  #tx = null;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;
  #closeReason = null;
  #closeHandlers = new Set();
  #closeNotified = false;

  /*
   * @param target `ws://…` 字符串，或 `{pipe:{read,write}}`（子进程的 fd4/fd3）
   */
  constructor(target, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof target === "string") {
      this.wsUrl = target;
      this.#tx = new WsTransport(target);
      this.kind = "ws";
    } else if (target?.pipe?.read && target?.pipe?.write) {
      this.wsUrl = null;
      this.#tx = new PipeTransport(target.pipe.read, target.pipe.write);
      this.kind = "pipe";
    } else {
      throw new CdpError("CdpClient 要一个 ws:// 地址或 {pipe:{read,write}}");
    }
    this.timeoutMs = timeoutMs;
  }

  async connect() {
    await this.#tx.open({
      onMessage: (data) => this.#onMessage(data),
      onClose: () => this.#settleAllPending(),
    });
    return this;
  }

  #settleAllPending() {
    if (this.#closed && !this.#pending.size) return;
    this.#closed = true;
    const why = this.#closeReason || "浏览器的 CDP 连接断开了（浏览器可能退出了）";
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(why, { method: p.method }));
    }
    this.#pending.clear();
    if (!this.#closeNotified) {
      this.#closeNotified = true;
      for (const fn of [...this.#closeHandlers]) {
        try {
          fn(why);
        } catch {}
      }
    }
  }

  /* 连接断掉时叫一声（只叫一次）。返回退订函数。 */
  onClose(fn) {
    this.#closeHandlers.add(fn);
    if (this.#closeNotified) {
      try {
        fn(this.#closeReason);
      } catch {}
    }
    return () => this.#closeHandlers.delete(fn);
  }

  get closed() {
    return this.#closed;
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new CdpError(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`, {
            method: p.method,
            sessionId: p.sessionId,
          })
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const fn of this.#listeners) {
        try {
          fn(msg.method, msg.params, msg.sessionId);
        } catch {
        }
      }
    }
  }

  /* 收 CDP 事件。返回退订函数。 */
  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /*
   * 发一条 CDP 命令，resolve 出 result；带 sessionId 就发给那个 target 的会话。
   * 连接已关闭直接 reject；超时（默认 30s）也 reject，两种都是 CdpError。
   */
  send(method, params = {}, sessionId = undefined, { timeoutMs = this.timeoutMs } = {}) {
    if (this.#closed || !this.#tx)
      return Promise.reject(
        new CdpError(
          "CDP 连接已关闭：浏览器退出了（用户关掉、崩了，或者别人 cli-browser.mjs --stop 收了它）。" +
            "server 会在下一次工具调用时自己重新拉起一个（约 1~2s），直接重试即可；" +
            "旧浏览器里的标签页跟着没了，用 browser_new_tab 重新开。",
          { method }
        )
      );
    const id = this.#nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CdpError(
            `${method} ${timeoutMs}ms 没有回执。` +
              "如果是鼠标类命令或截图，先确认这个标签页开了 Emulation.setFocusEmulationEnabled——" +
              "后台标签页不产合成帧时，Chrome 内部会等到 5s 硬超时。",
            { method, params, sessionId }
          )
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method, sessionId });
      try {
        this.#tx.write(frame);
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(`${method} 发不出去：${e.message}`, { method }));
      }
    });
  }

  close(reason) {
    this.#closeReason = reason;
    try {
      this.#tx?.close();
    } catch {}
    this.#settleAllPending();
  }
}

/*
 * 连上浏览器，并把 target 表维护起来：CDP 认 32 位十六进制 targetId，
 * chrome.tabs.* 那套 API 认整数 tabId，这一层在两者之间翻译，
 * 并把 target 的增删改抛成 created / destroyed / changed 三种事件（见 on()）。
 */
export class Browser {
  targets = new Map();
  #byTab = new Map();
  activeTargetId = null;
  #handlers = { created: new Set(), destroyed: new Set(), changed: new Set() };

  constructor(client) {
    this.client = client;
  }

  /* @param target `ws://…` 或 `{pipe:{read,write}}`，见 CdpClient 的构造函数 */
  static async connect(target, opts) {
    const client = await new CdpClient(target, opts).connect();
    const br = new Browser(client);
    await br.#init();
    return br;
  }

  async #init() {
    this.client.onEvent((method, params, sessionId) => this.#onEvent(method, params, sessionId));
    await this.client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: false }],
    });
    await this.client.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.client.send("Target.getTargets");
    for (const info of targetInfos) this.#upsert(info);
    const firstPage = [...this.targets.values()].find((t) => t.type === "page");
    this.activeTargetId = firstPage?.targetId || null;
  }

  #upsert(info, sessionId, { onlyUpdate = false } = {}) {
    if (info.type !== "page" && info.type !== "iframe") return null;
    let rec = this.targets.get(info.targetId);
    if (!rec && onlyUpdate) return null;
    const fresh = !rec;
    if (!rec) {
      rec = {
        targetId: info.targetId,
        type: info.type,
        url: info.url,
        title: info.title,
        sessionId: sessionId || null,
        tabId: info.type === "page" ? tabIdForTarget(info.targetId) : null,
        openerId: info.openerId || null,
        windowId: 1,
      };
      this.targets.set(info.targetId, rec);
      if (rec.tabId) this.#byTab.set(rec.tabId, info.targetId);
    } else {
      rec.url = info.url ?? rec.url;
      rec.title = info.title ?? rec.title;
      if (sessionId) rec.sessionId = sessionId;
    }
    rec.__fresh = fresh;
    return rec;
  }

  #onEvent(method, params, sessionId) {
    if (method === "Target.attachedToTarget") {
      this.client.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
      const rec = this.#upsert(params.targetInfo, params.sessionId);
      if (rec && rec.__fresh) for (const fn of this.#handlers.created) fn(rec);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      for (const [id, rec] of this.targets) {
        if (rec.sessionId !== params.sessionId) continue;
        if (rec.type === "iframe") this.targets.delete(id);
        else rec.sessionId = null;
      }
      return;
    }
    const discovery = (info) => this.#upsert(info, undefined, { onlyUpdate: info?.type === "iframe" });
    if (method === "Target.targetCreated") {
      discovery(params.targetInfo);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const rec = discovery(params.targetInfo);
      if (rec) for (const fn of this.#handlers.changed) fn(rec);
      return;
    }
    if (method === "Target.targetDestroyed") {
      const rec = this.targets.get(params.targetId);
      if (rec) {
        this.targets.delete(params.targetId);
        if (rec.tabId) this.#byTab.delete(rec.tabId);
        if (this.activeTargetId === rec.targetId) this.activeTargetId = null;
        for (const fn of this.#handlers.destroyed) fn(rec);
      }
      return;
    }
  }

  on(kind, fn) {
    this.#handlers[kind].add(fn);
    return () => this.#handlers[kind].delete(fn);
  }

  /*
   * tabId -> 记录，找不到给 null（不抛）。热路径专用，走 #byTab 索引，O(1)。
   */
  tryByTabId(tabId) {
    const targetId = this.#byTab.get(Number(tabId));
    return (targetId ? this.targets.get(targetId) : null) || null;
  }

  /* tabId -> 记录。找不到就抛，错误文案照产品口径写清楚下一步。 */
  byTabId(tabId) {
    const targetId = this.#byTab.get(Number(tabId));
    const rec = targetId ? this.targets.get(targetId) : null;
    if (!rec)
      throw new CdpError(
        `标签页 ${tabId} 不在了（可能已被关闭）。用 browser_tabs_list 看现在有哪些，或 browser_new_tab 重新开一张。`
      );
    return rec;
  }

  /* 现存的标签页记录（只有 type === "page"，不含 OOPIF） */
  pages() {
    return [...this.targets.values()].filter((t) => t.type === "page");
  }

  /* 保证这个 target 已经 attach，返回 sessionId */
  async session(rec) {
    if (rec.sessionId) return rec.sessionId;
    const { sessionId } = await this.client.send("Target.attachToTarget", {
      targetId: rec.targetId,
      flatten: true,
    });
    rec.sessionId = sessionId;
    return sessionId;
  }

  /* 往某个标签页发 CDP 命令 */
  async send(rec, method, params, opts) {
    const sessionId = await this.session(rec);
    return this.client.send(method, params, sessionId, opts);
  }
}
