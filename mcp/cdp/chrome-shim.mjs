// 用直连 CDP 实现 sw.js 需要的那部分 chrome.* API。
// 目的只有一个：**让 extension/sw.js 那 7000 行工具层一行都不用改**，就能跑在
// 没有扩展的浏览器上——同一份工具层，两个传输层，绝不分叉成两份实现。
// 入口是 createChromeShim(browser, opts)，返回 {chrome, sendToSw, setOnFromSw, rebind, stats}。
// ---------------------------------------------------------------------------
// 三处必须对准的地方，动这个文件先读完
//
// ① frameId 有两套，不能混。
//    chrome.scripting 给的是**整数**（主框架 0），ref 里的 `ref_3@f7` 就是它，
//    inFrame() 也按整数收。而 CDP 给的是**十六进制串**（DOM.describeNode、
//    DOM.getFrameOwner、Page.getFrameTree）。sw.js 两套都在用、各走各的路径。
//    所以 shim 必须把整数那套仿出来：frameNum() 双向映射，主框架恒为 0。
//    混了不会报错，只会静默定位到错的帧上。
//
// ② 隔离世界必须跨调用存活。
//    pageAgent 把 ref 表（idx -> 元素）存在世界的全局里。扩展的 executeScript
//    每次都落在**同一个**内容脚本世界，状态自然留着。如果 shim 每次调用都
//    Page.createIsolatedWorld，ref 会在下一次调用里全部失效——症状是
//    「read_page 拿到的 ref 一个都点不动」。所以按帧缓存 contextId，
//    只在导航/上下文销毁时作废（照 Puppeteer 的做法，靠 Runtime 的事件）。
//
// ③ OOPIF 要在它自己的会话里注入。
//    跨进程 iframe 自成 target，父会话对它报 "No frame for given id found"
//    （sw.js 里那条注释说的就是这个）。所以 executeScript 的 allFrames 要
//    遍历「本会话的帧树 + 每个已 attach 的子会话的帧树」。
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { log } from "./browser-launch.mjs";

const WORLD_NAME = "aic_isolated";

/* chrome.* 的 API 既支持回调也支持 Promise，两种都要接。错误按真 Chrome 的规矩放进 lastError，不往调用点扔 */
function dual(fn) {
  return function (...args) {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    let p;
    try {
      p = Promise.resolve(fn(...args));
    } catch (e) {
      p = Promise.reject(e);
    }
    if (!cb) return p;
    const safe = (fn2) => {
      try {
        fn2();
      } catch (e) {
        console.error("[shim] chrome.* 回调抛了:", e?.stack || e?.message || e);
      }
    };
    p.then(
      (v) => {
        lastError.value = undefined;
        safe(() => cb(v));
      },
      (e) => {
        lastError.value = { message: String(e?.message || e) };
        safe(() => cb(undefined));
        lastError.value = undefined;
      }
    );
    return undefined;
  };
}

const lastError = { value: undefined };

function evt() {
  const set = new Set();
  return {
    addListener: (fn) => set.add(fn),
    removeListener: (fn) => set.delete(fn),
    hasListener: (fn) => set.has(fn),
    emit(...args) {
      for (const fn of [...set]) {
        try {
          fn(...args);
        } catch (e) {
          console.error("[shim] 监听器抛了:", e?.message || e);
        }
      }
    },
  };
}

/*
 * 文件落盘的 storage 区。多个 MCP 进程共享同一个浏览器时，状态也要共享。
 *
 * 反过来说：**不共享同一个浏览器的就不许共享这个文件**，所以 file 得按 profile 分——
 * 这里只管读写，分不分由调用方决定，别在这层想办法补救。
 */
function storageArea(file, { stamp = null, notify = null } = {}) {
  const stampNow = () => (typeof stamp === "function" ? stamp() : stamp);
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const st = stampNow();
      if (st && raw.stamp !== st) return {};
      return raw.data || {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ stamp: stampNow(), data }));
    fs.renameSync(tmp, file);
  };
  return {
    get: dual(async (keys) => {
      const all = read();
      if (keys == null) return all;
      if (typeof keys === "string") return keys in all ? { [keys]: all[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in all) out[k] = all[k];
        return out;
      }
      const out = { ...keys };
      for (const k of Object.keys(keys)) if (k in all) out[k] = all[k];
      return out;
    }),
    set: dual(async (obj) => {
      const before = read();
      write({ ...before, ...obj });
      if (!notify) return;
      const changes = {};
      for (const k of Object.keys(obj)) {
        if (k in before && JSON.stringify(before[k]) === JSON.stringify(obj[k])) continue;
        changes[k] = { newValue: obj[k], ...(k in before ? { oldValue: before[k] } : {}) };
      }
      if (Object.keys(changes).length) notify(changes);
    }),
    remove: dual(async (keys) => {
      const all = read();
      const changes = {};
      for (const k of [].concat(keys)) {
        if (k in all) changes[k] = { oldValue: all[k] };
        delete all[k];
      }
      write(all);
      if (notify && Object.keys(changes).length) notify(changes);
    }),
  };
}

/*
 * 造一套 chrome.*，装到 globalThis 上。
 *
 * @param browser  cdp/client.mjs 的 Browser
 * @param opts.manifest        extension/manifest.json 的内容（getManifest 用）
 * @param opts.stateDir        storage 落盘目录，**必须是按 profile 分的**（理由见下面
 *                             chromeShim.storage 那段；bridge.mjs 的 shimStateDir 负责给）
 * @param opts.instanceStamp   这一个浏览器实例的印，session 区靠它认「是不是上一个
 *                             浏览器留下的」。见下面 instanceStamp 那段
 * @param opts.stripHeadlessUA attach 时把 UA 里的 Headless 抹掉
 * @returns {{chrome, port, sendToSw, onFromSw}}
 */
export function createChromeShim(browser, opts = {}) {
  const { manifest = {}, stateDir, stripHeadlessUA = true } = opts;
  let client = browser.client;

  let instanceStamp =
    opts.instanceStamp ||
    (client.wsUrl ? String(client.wsUrl).split("/").pop() : null) ||
    `p${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  const frameMaps = new Map();
  function fmap(tabId) {
    let m = frameMaps.get(tabId);
    if (!m) {
      m = { toNum: new Map(), toId: new Map(), next: 1 };
      frameMaps.set(tabId, m);
    }
    return m;
  }
  function frameNum(tabId, cdpFrameId, { isMain = false } = {}) {
    const m = fmap(tabId);
    if (m.toNum.has(cdpFrameId)) return m.toNum.get(cdpFrameId);
    const n = isMain ? 0 : m.next++;
    m.toNum.set(cdpFrameId, n);
    m.toId.set(n, cdpFrameId);
    return n;
  }
  function frameIdOf(tabId, num) {
    return fmap(tabId).toId.get(Number(num)) || null;
  }
  /*
   * 帧退休：把已经不存在的帧从编号表里摘掉。
   * **`next` 不回退、号码永不复用**——回退了的话，模型手上那个「第 7 帧」在导航之后
   * 会指到一个不同的帧上，工具照样报成功。不复用则旧号码只会查不到，如实报错。
   * 两个退休时机都要：`Page.frameDetached`（单个 iframe 被移除）和主框架导航
   *（旧文档连同它所有子帧一起作废，逐帧事件不会补齐），各自只覆盖一半。
   */
  function retireFrame(tabId, cdpFrameId) {
    const m = frameMaps.get(tabId);
    if (!m) return;
    const num = m.toNum.get(cdpFrameId);
    if (num === undefined) return;
    m.toNum.delete(cdpFrameId);
    m.toId.delete(num);
    worldByFrame.delete(cdpFrameId);
  }
  function retireSubframes(tabId, mainFrameId) {
    const m = frameMaps.get(tabId);
    if (!m) return;
    for (const fid of [...m.toNum.keys()]) if (fid !== mainFrameId) retireFrame(tabId, fid);
  }

  const sessionTab = new Map();
  const childSessions = new Map();
  const sessionParent = new Map();
  const sessionInfo = new Map();
  const attachedTabs = new Set();
  const loadState = new Map();
  /*
   * 工具层花掉的两种「往返」的**确定性记账**（只增不减，从 stats() 里读）：
   * cdpCommands = 工具层下发的 `chrome.debugger.sendCommand` 次数；
   * injections  = 工具层调 `chrome.scripting.executeScript` 的次数。
   * 记的是**次数**这种与负载无关的整数，好让「哪条路更省往返」可以被确定地断言。
   */
  const counters = { cdpCommands: 0, injections: 0 };
  const worldByFrame = new Map();

  function tabOfSession(sessionId) {
    if (!sessionId) return null;
    return sessionTab.get(sessionId) ?? null;
  }

  /*
   * 一个 CDP 会话没了：**四张按 sessionId 存的表要一起清**（sessionTab / childSessions /
   * sessionParent / sessionInfo），连着孙会话一起收——Chrome 不为孙会话补送
   * detachedFromTarget，靠等事件是等不到的。
   * worldByFrame 那一笔要留神：**它是按 frameId 存的，不是按 sessionId**，
   * 这里按值里的 sessionId 反查着删。
   */
  function forgetSession(sid) {
    if (!sid) return;
    const stack = [sid];
    while (stack.length) {
      const s = stack.pop();
      for (const [child, parent] of sessionParent) if (parent === s) stack.push(child);
      const t = sessionTab.get(s);
      if (t != null) childSessions.get(t)?.delete(s);
      sessionTab.delete(s);
      sessionParent.delete(s);
      sessionInfo.delete(s);
      for (const [k, v] of worldByFrame) if (v.sessionId === s) worldByFrame.delete(k);
    }
  }

  function pageOfTab(tabId) {
    if (tabId == null) return null;
    if (typeof browser.tryByTabId === "function") return browser.tryByTabId(tabId);
    return [...browser.targets.values()].find((t) => t.tabId === tabId && t.type === "page") || null;
  }

  function isMainFrameEvent(tabId, frameId, sessionId) {
    const rec = pageOfTab(tabId);
    if (!rec) return false;
    if (frameId != null) return frameId === rec.targetId;
    return !sessionId || sessionId === rec.sessionId;
  }

  function bindPage(rec) {
    if (rec.sessionId) sessionTab.set(rec.sessionId, rec.tabId);
    frameNum(rec.tabId, rec.targetId, { isMain: true });
  }
  function onTargetCreated(rec) {
    if (rec.type !== "page") return;
    bindPage(rec);
    const opener = rec.openerId ? browser.targets.get(rec.openerId) : null;
    if (opener?.tabId) {
      const g = [...groups.values()].find((x) => x.tabIds.has(opener.tabId));
      if (g) g.tabIds.add(rec.tabId);
    }
    tabsOnCreated.emit({
      id: rec.tabId,
      windowId: rec.windowId,
      url: rec.url,
      title: rec.title,
      ...(opener?.tabId ? { openerTabId: opener.tabId } : {}),
    });
  }

  const tabsOnCreated = evt();
  const tabsOnUpdated = evt();
  const tabsOnRemoved = evt();
  const tabsOnActivated = evt();
  const windowsOnFocusChanged = evt();
  const setActiveTarget = (targetId, tabId) => {
    if (browser.activeTargetId === targetId) return;
    browser.activeTargetId = targetId;
    if (tabId != null) tabsOnActivated.emit({ tabId, windowId: 1 });
  };
  const dbgOnEvent = evt();
  const dbgOnDetach = evt();

  function onCdpEvent(method, params, sessionId) {
    const tabId = tabOfSession(sessionId);

    if (method === "Target.attachedToTarget") {
      const parentTab = tabId ?? null;
      if (parentTab != null) {
        sessionTab.set(params.sessionId, parentTab);
        if (!childSessions.has(parentTab)) childSessions.set(parentTab, new Set());
        childSessions.get(parentTab).add(params.sessionId);
        sessionParent.set(params.sessionId, sessionId || null);
        sessionInfo.set(params.sessionId, params.targetInfo);
        client
          .send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            params.sessionId
          )
          .catch(() => {});
        client
          .send("Emulation.setFocusEmulationEnabled", { enabled: true }, params.sessionId)
          .catch(() => {});
      }
    } else if (method === "Target.detachedFromTarget") {
      forgetSession(params.sessionId);
    } else if (method === "Page.frameStartedLoading" || method === "Page.frameStartedNavigating") {
      if (tabId != null && isMainFrameEvent(tabId, params.frameId, sessionId)) {
        loadState.set(tabId, "loading");
        tabsOnUpdated.emit(tabId, { status: "loading" }, tabInfoSync(tabId));
      }
    } else if (method === "Page.loadEventFired" || method === "Page.frameStoppedLoading") {
      if (tabId != null && isMainFrameEvent(tabId, params.frameId, sessionId)) {
        loadState.set(tabId, "complete");
        tabsOnUpdated.emit(tabId, { status: "complete" }, tabInfoSync(tabId));
      }
    } else if (method === "Page.frameDetached") {
      if (tabId != null && params.frameId) retireFrame(tabId, params.frameId);
    } else if (method === "Page.frameNavigated") {
      const fid = params.frame?.id;
      if (fid) worldByFrame.delete(fid);
      if (tabId != null && params.frame && !params.frame.parentId) {
        const rec = pageOfTab(tabId);
        if (rec) rec.url = params.frame.url;
        if (rec && rec.targetId === fid) retireSubframes(tabId, fid);
        tabsOnUpdated.emit(tabId, { url: params.frame.url }, tabInfoSync(tabId));
      }
    } else if (method === "Runtime.executionContextsCleared") {
      if (sessionId) for (const [k, v] of worldByFrame) if (v.sessionId === sessionId) worldByFrame.delete(k);
    } else if (method === "Runtime.executionContextDestroyed") {
      for (const [k, v] of worldByFrame) if (v.contextId === params.executionContextId) worldByFrame.delete(k);
    }

    if (tabId != null && !method.startsWith("Target.")) {
      const source = { tabId };
      const rootRec = pageOfTab(tabId);
      if (rootRec && sessionId && sessionId !== rootRec.sessionId) source.sessionId = sessionId;
      dbgOnEvent.emit(source, method, params);
    } else if (tabId != null && (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget")) {
      dbgOnEvent.emit({ tabId }, method, params);
    }
  }

  function onTargetDestroyed(rec) {
    if (rec.type !== "page") return;
    frameMaps.delete(rec.tabId);
    loadState.delete(rec.tabId);
    attachedTabs.delete(rec.tabId);
    for (const sid of childSessions.get(rec.tabId) || []) forgetSession(sid);
    childSessions.delete(rec.tabId);
    if (rec.sessionId) forgetSession(rec.sessionId);
    dropFromGroups(rec.tabId);
    tabsOnRemoved.emit(rec.tabId, { windowId: rec.windowId, isWindowClosing: false });
  }

  /*
   * 把三个监听器挂到**当前**的 browser/client 上，并把它已有的页登记进帧号表。
   * 换绑时先 unwire 再 wire，旧浏览器的事件一条都不许再流进来——它报的 tabId
   * 在新浏览器里指的是别的页（或查无此页），流进来就是静默做错对象。
   */
  let unwire = () => {};
  function wire() {
    for (const rec of browser.pages()) bindPage(rec);
    const offEvent = client.onEvent(onCdpEvent);
    const offCreated = browser.on("created", onTargetCreated);
    const offDestroyed = browser.on("destroyed", onTargetDestroyed);
    unwire = () => {
      for (const off of [offEvent, offCreated, offDestroyed]) {
        try {
          off?.();
        } catch {}
      }
      unwire = () => {};
    };
  }
  wire();

  // CDP 没有标签组这个能力——它是 Chrome 的 UI 概念，只对扩展开放。
  // CLI/headless 模式下没人看标签条，所以这里只做账面记录，让 sw.js 的
  // 「会话专属标签组」那套逻辑照常走完。
  const groups = new Map();
  let nextGroupId = 1;
  const groupInfo = (g) => ({
    id: g.id,
    title: g.title,
    color: g.color,
    windowId: 1,
    collapsed: !!g.collapsed,
  });
  const tabGroupsOnRemoved = evt();

  function dropFromGroups(tabId, except = null) {
    for (const g of [...groups.values()]) {
      if (g === except) continue;
      if (!g.tabIds.delete(Number(tabId))) continue;
      if (g.tabIds.size) continue;
      groups.delete(g.id);
      tabGroupsOnRemoved.emit(groupInfo(g));
    }
  }

  async function refreshTarget(tabId) {
    const rec = pageOfTab(tabId);
    if (!rec) return;
    try {
      const { targetInfo } = await client.send("Target.getTargetInfo", { targetId: rec.targetId });
      if (targetInfo) {
        rec.url = targetInfo.url ?? rec.url;
        rec.title = targetInfo.title ?? rec.title;
      }
    } catch {
    }
  }

  async function refreshAllTargets() {
    let infos;
    try {
      ({ targetInfos: infos } = await client.send("Target.getTargets"));
    } catch {
      return;
    }
    if (!Array.isArray(infos)) return;
    for (const info of infos) {
      const rec = browser.targets.get(info.targetId);
      if (!rec) continue;
      rec.url = info.url ?? rec.url;
      rec.title = info.title ?? rec.title;
    }
  }

  function tabInfoSync(tabId) {
    const rec = pageOfTab(tabId);
    if (!rec) return null;
    let groupId = -1;
    for (const g of groups.values()) if (g.tabIds.has(tabId)) groupId = g.id;
    return {
      id: rec.tabId,
      url: rec.url || "",
      title: rec.title || "",
      active: browser.activeTargetId === rec.targetId,
      windowId: rec.windowId,
      groupId,
      status: loadState.get(tabId) || "complete",
      index: browser.pages().findIndex((p) => p.tabId === tabId),
      incognito: false,
      pinned: false,
    };
  }

  const WORLD_BOOTSTRAP = `(() => {
    const g = globalThis;
    g.__aic_cr = g.__aic_cr || new WeakMap();
    g.__aic_cr_miss = g.__aic_cr_miss || [];
    g.chrome = g.chrome || {};
    g.chrome.dom = g.chrome.dom || {
      openOrClosedShadowRoot(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.shadowRoot) return el.shadowRoot;            // open：原生就给
        const hit = g.__aic_cr.get(el);
        if (hit) return hit;                                 // closed：上一轮补进来的
        if (g.__aic_cr_miss.length < 64 && !g.__aic_cr_miss.includes(el)) g.__aic_cr_miss.push(el);
        return null;
      },
    };
    // bootstrap 的返回值 = 「这个文档里有没有可能挂着 closed shadow root 的候选」。
    // 真站点上挂 closed 的几乎只有自定义元素（带连字符的标签名），所以按它探。
    // 探不到就跳过整量 DOM.getDocument(pierce) 的 seed——探测在这句 bootstrap 里
    // 顺带完成，零额外往返。探漏（原生标签挂 closed、或自定义元素藏在 open shadow
    // 里没被这趟光 DOM 扫描看到）的后果**不是漏看**：第一次注入会把落空记进 miss 表，
    // fillClosedRoots 随即整树补种，那一片下一次调用可见——和 miss 表本来的语义一致。
    for (const el of document.getElementsByTagName("*")) if (el.tagName.includes("-")) return 1;
    return 0;
  })()`;

  const worldInFlight = new Map();

  async function worldFor(sessionId, cdpFrameId) {
    const hit = worldByFrame.get(cdpFrameId);
    if (hit) return hit.contextId;
    const flying = worldInFlight.get(cdpFrameId);
    if (flying) return flying;
    const p = createWorld(sessionId, cdpFrameId).finally(() => {
      if (worldInFlight.get(cdpFrameId) === p) worldInFlight.delete(cdpFrameId);
    });
    worldInFlight.set(cdpFrameId, p);
    return p;
  }

  async function createWorld(sessionId, cdpFrameId) {
    const { executionContextId } = await client.send(
      "Page.createIsolatedWorld",
      { frameId: cdpFrameId, worldName: WORLD_NAME, grantUniveralAccess: true },
      sessionId
    );
    const boot = await client.send(
      "Runtime.evaluate",
      { expression: WORLD_BOOTSTRAP, contextId: executionContextId, returnByValue: true },
      sessionId
    );
    worldByFrame.set(cdpFrameId, { contextId: executionContextId, sessionId });
    if (boot?.result?.value) await seedClosedRoots(sessionId, cdpFrameId, executionContextId).catch(() => 0);
    return executionContextId;
  }

  const pierceDocCache = new Map();
  function pierceDoc(sessionId) {
    const now = Date.now();
    for (const [k, v] of pierceDocCache) if (now - v.t > 1000) pierceDocCache.delete(k);
    const hit = pierceDocCache.get(sessionId);
    if (hit && now - hit.t < 150) return hit.p;
    const p = client.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId).catch(() => null);
    pierceDocCache.set(sessionId, { t: now, p });
    return p;
  }

  function collectClosedPairs(root, cdpFrameId) {
    const pairs = [];
    const walk = (node, frameId) => {
      const fid = node.frameId || frameId;
      for (const r of node.shadowRoots || []) {
        if (r.shadowRootType === "closed" && fid === cdpFrameId)
          pairs.push({ host: node.backendNodeId, root: r.backendNodeId });
        walk(r, fid);
      }
      if (node.contentDocument) walk(node.contentDocument, node.contentDocument.frameId || fid);
      for (const c of node.children || []) walk(c, fid);
    };
    walk(root, root.frameId);
    return pairs;
  }

  async function seedPairs(pairs, sessionId, contextId) {
    const results = await Promise.all(
      pairs.map(async (p) => {
        try {
          const [h, r] = await Promise.all([
            client.send("DOM.resolveNode", { backendNodeId: p.host, executionContextId: contextId }, sessionId),
            client.send("DOM.resolveNode", { backendNodeId: p.root, executionContextId: contextId }, sessionId),
          ]);
          if (!h?.object?.objectId || !r?.object?.objectId) return 0;
          await client.send(
            "Runtime.callFunctionOn",
            {
              objectId: h.object.objectId,
              functionDeclaration:
                "function (root) { const g = globalThis; (g.__aic_cr = g.__aic_cr || new WeakMap()).set(this, root); }",
              arguments: [{ objectId: r.object.objectId }],
            },
            sessionId
          );
          return 1;
        } catch {
          return 0;
        }
      })
    );
    return results.reduce((a, b) => a + b, 0);
  }

  /*
   * 世界一建好就把这个帧里所有 closed shadow root 投进去，返回投了几个。
   * 一趟 `DOM.getDocument{pierce:true}` 就能拿到全部 closed root（CDP 不对调试器隐藏它们）。
   * 必须在**首次注入前**做完：注入的那些函数是有副作用的（resolve 会 scrollIntoView、
   * click 会真的点），发现落空再补然后重跑，等于把副作用做两遍。
   * 只在建世界时做一次，也就是每个文档一次；导航后世界作废，自然会重来。
   */
  async function seedClosedRoots(sessionId, cdpFrameId, contextId) {
    const doc = await pierceDoc(sessionId);
    if (!doc?.root) return 0;
    const pairs = collectClosedPairs(doc.root, cdpFrameId);
    if (!pairs.length) return 0;
    return await seedPairs(pairs, sessionId, contextId);
  }

  /*
   * 兜底：页面在加载完之后又动态挂了 closed shadow root 时，注入会把落空的宿主记进
   * miss 表。这里把整帧的 closed root 重新找齐补上，**但不重跑注入**（重跑的害处见
   * seedClosedRoots），所以那一片要到下一次调用才看得见。
   * 取的是整树差集而不是逐个确认，重复投喂已 seed 过的 root 是幂等的。
   */
  async function fillClosedRoots(sessionId, cdpFrameId, contextId) {
    const doc = await pierceDoc(sessionId);
    if (!doc?.root) return 0;
    const pairs = collectClosedPairs(doc.root, cdpFrameId);
    if (!pairs.length) return 0;
    return await seedPairs(pairs, sessionId, contextId);
  }

  /* 列出一个标签页里所有可注入的帧：本会话帧树 + 每个 OOPIF 子会话的帧树 */
  async function allFramesOf(tabId) {
    const rec = browser.byTabId(tabId);
    const rootSession = await browser.session(rec);
    const out = [];
    const walk = (node, sessionId) => {
      out.push({ sessionId, cdpFrameId: node.frame.id, isMain: !node.frame.parentId && sessionId === rootSession });
      for (const c of node.childFrames || []) walk(c, sessionId);
    };
    const kids = [...(childSessions.get(tabId) || [])];
    const [tree, ...kidTrees] = await Promise.all([
      client.send("Page.getFrameTree", {}, rootSession).catch(() => null),
      ...kids.map((sid) => client.send("Page.getFrameTree", {}, sid).catch(() => null)),
    ]);
    if (tree) walk(tree.frameTree, rootSession);
    kidTrees.forEach((t, i) => {
      if (t) walk(t.frameTree, kids[i]);
    });
    return out;
  }

  async function runInFrame(tabId, { sessionId, cdpFrameId, isMain }, func, args) {
    const contextId = await worldFor(sessionId, cdpFrameId);
    const expr =
      `Promise.resolve((${func.toString()}).apply(null, ${JSON.stringify(args ?? [])}))` +
      `.then((v) => ({ __aic_v: v, __aic_m: (globalThis.__aic_cr_miss || []).length }))`;
    const run = async () => {
      const r = await client.send(
        "Runtime.evaluate",
        { expression: expr, contextId, awaitPromise: true, returnByValue: true, userGesture: true },
        sessionId
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(d.exception?.description || d.text || "注入的脚本抛了异常");
      }
      return r;
    };

    const r = await run();
    const wrapped = r.result?.value;
    if (wrapped && Number(wrapped.__aic_m) > 0) {
      await fillClosedRoots(sessionId, cdpFrameId, contextId).catch(() => {});
    }

    return {
      frameId: frameNum(tabId, cdpFrameId, { isMain }),
      result: wrapped ? wrapped.__aic_v : undefined,
      documentId: cdpFrameId,
    };
  }

  let uaFix = null;
  async function ensureUaFix() {
    if (uaFix !== null) return uaFix;
    const v = await client.send("Browser.getVersion").catch(() => null);
    const ua = v?.userAgent || "";
    uaFix = ua.includes("HeadlessChrome") ? ua.replace("HeadlessChrome", "Chrome") : "";
    return uaFix;
  }

  const alarmsOnAlarm = evt();
  const alarmTimers = new Map();

  function clearAlarmTimer(name) {
    const rec = alarmTimers.get(name);
    if (!rec) return false;
    clearTimeout(rec.timer);
    clearInterval(rec.timer);
    alarmTimers.delete(name);
    return true;
  }

  function createAlarm(name, info = {}) {
    clearAlarmTimer(name);
    const period = Number(info.periodInMinutes) > 0 ? Number(info.periodInMinutes) : null;
    const periodMs = period != null ? period * 60_000 : null;
    let firstMs;
    if (info.when != null) firstMs = Number(info.when) - Date.now();
    else if (info.delayInMinutes != null) firstMs = Number(info.delayInMinutes) * 60_000;
    else if (periodMs != null) firstMs = periodMs;
    else firstMs = 0;
    firstMs = Math.max(0, Number.isFinite(firstMs) ? firstMs : 0);

    const alarm = { name, scheduledTime: Date.now() + firstMs, periodInMinutes: period ?? undefined };
    const fire = () => {
      const cur = alarmTimers.get(name);
      if (!cur || cur.alarm !== alarm) return;
      if (periodMs == null) {
        alarmTimers.delete(name);
      } else {
        alarm.scheduledTime = Date.now() + periodMs;
      }
      alarmsOnAlarm.emit({ ...alarm });
    };

    let timer;
    if (periodMs != null && firstMs === periodMs) {
      timer = setInterval(fire, periodMs);
    } else {
      timer = setTimeout(() => {
        if (periodMs != null) {
          const next = setInterval(fire, periodMs);
          next.unref?.();
          const cur = alarmTimers.get(name);
          if (cur && cur.alarm === alarm) cur.timer = next;
          else clearInterval(next);
        }
        fire();
      }, firstMs);
    }
    timer.unref?.();
    alarmTimers.set(name, { timer, alarm });
  }

  const alarmsShim = {
    create: (name, info) => {
      if (typeof name === "object" && name !== null) return createAlarm("", name);
      return createAlarm(String(name ?? ""), info || {});
    },
    clear: dual(async (name) => clearAlarmTimer(String(name ?? ""))),
    clearAll: dual(async () => {
      const had = alarmTimers.size > 0;
      for (const n of [...alarmTimers.keys()]) clearAlarmTimer(n);
      return had;
    }),
    onAlarm: alarmsOnAlarm,
  };

  const storageOnChanged = evt();
  const storageLocal = storageArea(path.join(stateDir, "aic-cli-local-state.json"), {
    notify: (changes) => storageOnChanged.emit(changes, "local"),
  });
  const storageShim = {
    session: storageArea(path.join(stateDir, "aic-cli-session-state.json"), {
      stamp: () => instanceStamp,
      notify: (changes) => storageOnChanged.emit(changes, "session"),
    }),
    local: storageLocal,
    sync: storageLocal,
    onChanged: storageOnChanged,
  };

  // 装到 globalThis.chrome 上的那套 API，**sw.js 用到多少就补多少，不多不少**：
  // runtime、storage（local + session）、alarms、action（空实现）、windows、tabs、
  // tabGroups（纯账面）、scripting，以及调试器那一套。没有对应物的一律**如实说没有**、
  // 不假装成功（windows.create 返回 null，工具层见 null 会降级回普通标签页）；
  // 成员则一个都不能少——sw.js 在模块顶层就 addListener，缺一个是同步 TypeError。
  const chromeShim = {
    runtime: {
      get lastError() {
        return lastError.value;
      },
      getManifest: () => manifest,
      getURL: (p) => `chrome-extension://aic-cli/${String(p).replace(/^\//, "")}`,
      id: "aic-cli",
      reload: () => {
        log("[shim] 收到 chrome.runtime.reload()：CLI 模式没有扩展可重载，忽略（要换代码请重启 MCP server）");
      },
      onStartup: evt(),
      onInstalled: evt(),
      onMessage: evt(),
      connectNative: () => nativePort,
    },

    // storage 落在**这个浏览器自己的 profile 目录**里（stateDir 由 bridge.mjs 按浏览器
    // 实际在用的 profile 给）。session 区靠浏览器实例的印认「这份是不是上一个浏览器
    // 留下的」，印不对就当空的。
    storage: storageShim,

    alarms: alarmsShim,

    action: {
      setTitle: dual(async () => {}),
      setBadgeText: dual(async () => {}),
      setBadgeBackgroundColor: dual(async () => {}),
      setIcon: dual(async () => {}),
    },

    windows: {
      update: dual(async (windowId, info) => {
        if (info?.focused) {
          const rec = browser.pages().find((p) => p.targetId === browser.activeTargetId) || browser.pages()[0];
          if (rec) await client.send("Target.activateTarget", { targetId: rec.targetId }).catch(() => {});
        }
        return { id: windowId, focused: !!info?.focused };
      }),
      get: dual(async (windowId) => ({ id: windowId, focused: true, type: "normal" })),
      getAll: dual(async (getInfo = {}) => {
        const w = { id: 1, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false };
        if (getInfo?.populate) w.tabs = browser.pages().map((p) => tabInfoSync(p.tabId)).filter(Boolean);
        return [w];
      }),
      onFocusChanged: windowsOnFocusChanged,
      WINDOW_ID_NONE: -1,
      getLastFocused: dual(async (getInfo = {}) => {
        const w = { id: 1, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false };
        if (getInfo?.populate) w.tabs = browser.pages().map((p) => tabInfoSync(p.tabId)).filter(Boolean);
        return w;
      }),
      create: dual(async () => {
        log("[shim] chrome.windows.create()：CLI/headless 没有窗口这个概念，降级为普通标签页");
        return null;
      }),
    },

    tabs: {
      get: dual(async (tabId) => {
        await refreshTarget(Number(tabId));
        const info = tabInfoSync(Number(tabId));
        if (!info) throw new Error(`No tab with id: ${tabId}.`);
        return info;
      }),
      query: dual(async (q = {}) => {
        await refreshAllTargets();
        let list = browser.pages().map((p) => tabInfoSync(p.tabId)).filter(Boolean);
        if (q.active != null) list = list.filter((t) => t.active === q.active);
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.url) {
          const pats = [].concat(q.url).map((u) => new RegExp("^" + u.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
          list = list.filter((t) => pats.some((re) => re.test(t.url)));
        }
        return list;
      }),
      create: dual(async ({ url = "about:blank", active = false } = {}) => {
        let wanted = null;
        let settle = null;
        const appeared = new Promise((r) => (settle = r));
        const offCreated =
          browser.on("created", (rec) => {
            if (wanted && rec.targetId === wanted) settle();
          }) || (() => {});
        let timer = null;
        try {
          ({ targetId: wanted } = await client.send("Target.createTarget", { url, background: !active }));
          if (!browser.targets.get(wanted))
            await Promise.race([
              appeared,
              new Promise((r) => {
                timer = setTimeout(r, 2000);
                timer.unref?.();
              }),
            ]);
        } finally {
          try {
            offCreated();
          } catch {}
          if (timer) clearTimeout(timer);
        }
        const rec = browser.targets.get(wanted);
        if (!rec) throw new Error("新标签页没能在 2s 内出现在 target 表里");
        if (active) setActiveTarget(wanted, rec.tabId);
        loadState.set(rec.tabId, "loading");
        return tabInfoSync(rec.tabId);
      }),
      update: dual(async (tabId, props = {}) => {
        const rec = browser.byTabId(tabId);
        if (props.active) {
          await client.send("Target.activateTarget", { targetId: rec.targetId }).catch(() => {});
          setActiveTarget(rec.targetId, rec.tabId);
        }
        if (props.url) {
          loadState.set(rec.tabId, "loading");
          await browser.send(rec, "Page.navigate", { url: props.url });
        }
        return tabInfoSync(rec.tabId);
      }),
      remove: dual(async (tabIds) => {
        const closed = [];
        for (const id of [].concat(tabIds)) {
          const rec = browser.byTabId(id);
          closed.push(rec.targetId);
          await client.send("Target.closeTarget", { targetId: rec.targetId }).catch(() => {});
        }
        for (let i = 0; i < 100 && closed.some((t) => browser.targets.has(t)); i++)
          await new Promise((r) => setTimeout(r, 20));
      }),
      reload: dual(async (tabId, props = {}) => {
        const rec = browser.byTabId(tabId);
        loadState.set(rec.tabId, "loading");
        await browser.send(rec, "Page.reload", { ignoreCache: !!props.bypassCache });
      }),
      goBack: dual(async (tabId) => history(tabId, -1)),
      goForward: dual(async (tabId) => history(tabId, +1)),
      captureVisibleTab: dual(async (_windowId, options = {}) => {
        const rec = browser.pages().find((p) => p.targetId === browser.activeTargetId) || browser.pages()[0];
        if (!rec) throw new Error("没有可截的标签页");
        const fmt = options.format === "jpeg" ? "jpeg" : "png";
        const r = await browser.send(rec, "Page.captureScreenshot", {
          format: fmt,
          ...(fmt === "jpeg" && options.quality ? { quality: options.quality } : {}),
        });
        return `data:image/${fmt};base64,${r.data}`;
      }),
      group: dual(async ({ tabIds, groupId } = {}) => {
        let g = null;
        if (groupId != null) {
          g = groups.get(Number(groupId));
          if (!g) throw new Error(`No group with id: ${groupId}.`);
        } else {
          g = { id: nextGroupId++, title: "", color: "grey", collapsed: false, tabIds: new Set() };
          groups.set(g.id, g);
        }
        for (const id of [].concat(tabIds)) {
          dropFromGroups(Number(id), g);
          g.tabIds.add(Number(id));
        }
        return g.id;
      }),
      ungroup: dual(async (tabIds) => {
        for (const id of [].concat(tabIds)) dropFromGroups(Number(id));
      }),
      onCreated: tabsOnCreated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      onActivated: tabsOnActivated,
    },

    tabGroups: {
      get: dual(async (groupId) => {
        const g = groups.get(Number(groupId));
        if (!g) throw new Error(`No group with id: ${groupId}.`);
        return groupInfo(g);
      }),
      query: dual(async () => [...groups.values()].map(groupInfo)),
      update: dual(async (groupId, props = {}) => {
        const g = groups.get(Number(groupId));
        if (!g) throw new Error(`No group with id: ${groupId}.`);
        Object.assign(g, props);
        return groupInfo(g);
      }),
      move: dual(async (groupId, _props = {}) => {
        const g = groups.get(Number(groupId));
        if (!g) throw new Error(`No group with id: ${groupId}.`);
        return groupInfo(g);
      }),
      onRemoved: tabGroupsOnRemoved,
    },

    scripting: {
      executeScript: dual(async ({ target, func, args } = {}) => {
        counters.injections++;
        const tabId = Number(target.tabId);
        const frames = await allFramesOf(tabId);
        let picked;
        if (target.allFrames) picked = frames;
        else if (target.frameIds?.length) {
          const want = new Set(target.frameIds.map((n) => frameIdOf(tabId, n)).filter(Boolean));
          picked = frames.filter((f) => want.has(f.cdpFrameId));
          if (!picked.length)
            throw new Error(
              `frameId ${target.frameIds.join(",")} 在这个标签页里已经不存在了（帧可能导航或被移除）。` +
                "重新 browser_read_page 拿新的 ref。"
            );
        } else picked = frames.filter((f) => f.isMain);

        await Promise.all(picked.map((f) => worldFor(f.sessionId, f.cdpFrameId).catch(() => null)));

        const order = picked.map((_, i) => i).sort((a, b) => (picked[a].isMain ? 1 : 0) - (picked[b].isMain ? 1 : 0));
        const settled = new Array(picked.length);
        await Promise.all(
          order.map((i) =>
            runInFrame(tabId, picked[i], func, args).then(
              (v) => (settled[i] = { ok: true, v }),
              (e) => (settled[i] = { ok: false, e })
            )
          )
        );
        const out = [];
        for (const s of settled) {
          if (s.ok) out.push(s.v);
          else if (!target.allFrames) throw s.e;
        }
        return out;
      }),
    },

    debugger: {
      attach: dual(async ({ tabId }) => {
        const rec = browser.byTabId(tabId);
        await browser.session(rec);
        if (rec.sessionId) sessionTab.set(rec.sessionId, rec.tabId);
        attachedTabs.add(Number(tabId));
        await browser.send(rec, "Page.enable").catch(() => {});
        await browser.send(rec, "Runtime.enable").catch(() => {});
        await browser.send(rec, "DOM.enable").catch(() => {});
        await browser
          .send(rec, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
          .catch(() => {});
        const fix = await ensureUaFix();
        if (stripHeadlessUA && fix) {
          await browser.send(rec, "Emulation.setUserAgentOverride", { userAgent: fix }).catch(() => {});
        }
      }),
      detach: dual(async ({ tabId }) => {
        attachedTabs.delete(Number(tabId));
        const rec = browser.byTabId(tabId);
        for (const m of ["Network.disable", "Log.disable"]) await browser.send(rec, m).catch(() => {});
      }),
      sendCommand: dual(async ({ tabId, sessionId }, method, params = {}) => {
        counters.cdpCommands++;
        const rec = browser.byTabId(tabId);
        const sid = sessionId || (await browser.session(rec));

        if (method === "Target.setAutoAttach") {
          if (params?.autoAttach) {
            const kids = [...(childSessions.get(Number(tabId)) || [])].filter(
              (k) => (sessionParent.get(k) || null) === sid
            );
            setTimeout(() => {
              for (const k of kids)
                dbgOnEvent.emit({ tabId: Number(tabId) }, "Target.attachedToTarget", {
                  sessionId: k,
                  targetInfo: sessionInfo.get(k) || { targetId: k, type: "iframe", url: "" },
                  waitingForDebugger: false,
                });
            }, 0);
          }
          return {};
        }

        return await client.send(method, params, sid);
      }),
      getTargets: dual(async () =>
        browser.pages().map((p) => ({ id: String(p.targetId), type: "page", tabId: p.tabId, url: p.url, attached: attachedTabs.has(p.tabId) }))
      ),
      onEvent: dbgOnEvent,
      onDetach: dbgOnDetach,
    },

  };

  async function history(tabId, delta) {
    const rec = browser.byTabId(tabId);
    const h = await browser.send(rec, "Page.getNavigationHistory");
    const idx = h.currentIndex + delta;
    if (idx < 0 || idx >= h.entries.length) return;
    loadState.set(Number(tabId), "loading");
    await browser.send(rec, "Page.navigateToHistoryEntry", { entryId: h.entries[idx].id });
  }

  // sw.js 用 chrome.runtime.connectNative 拿一条通往「上层」的管子，
  // 桌面模式里那头是 native host + unix socket。CLI 模式没有那两级：MCP server 就在
  // 同一个进程里，所以给它一根内存里的管子——派发路径（帧格式、id、错误包装）一行不用改。
  const swListeners = evt();
  const disconnectListeners = evt();
  let onFromSw = null;
  const nativePort = {
    name: "org.liangai.agent_in_chrome",
    onMessage: swListeners,
    onDisconnect: disconnectListeners,
    postMessage: (msg) => onFromSw?.(msg),
    disconnect: () => disconnectListeners.emit(nativePort),
  };

  // rebind(nextBrowser, {instanceStamp})：浏览器中途没了之后原地换一个新的。
  // 换绑先照 Chrome 的真实语义把旧浏览器的账替 sw.js 销掉（每张被调试的页发 onDetach、
  // 每张页发 tabs.onRemoved、每个标签组发 tabGroups.onRemoved），再清空绑在旧实例上的表。
  async function rebind(nextBrowser, { instanceStamp: nextStamp } = {}) {
    if (!nextBrowser || nextBrowser === browser) return;

    const deadTabs = browser.pages().map((rec) => ({ tabId: rec.tabId, windowId: rec.windowId }));
    for (const tabId of [...attachedTabs]) dbgOnDetach.emit({ tabId }, "target_closed");
    for (const { tabId, windowId } of deadTabs)
      tabsOnRemoved.emit(tabId, { windowId: windowId ?? 1, isWindowClosing: true });
    for (const g of [...groups.values()]) tabGroupsOnRemoved.emit(groupInfo(g));
    await new Promise((r) => setTimeout(r, 0));

    unwire();
    frameMaps.clear();
    sessionTab.clear();
    childSessions.clear();
    sessionParent.clear();
    sessionInfo.clear();
    attachedTabs.clear();
    loadState.clear();
    worldByFrame.clear();
    worldInFlight.clear();
    pierceDocCache.clear();
    groups.clear();

    browser = nextBrowser;
    client = nextBrowser.client;
    if (nextStamp) instanceStamp = nextStamp;
    wire();
  }

  return {
    chrome: chromeShim,
    /* 往 sw.js 里塞一帧（{type:"call", id, tool, args, session}） */
    sendToSw: (msg) => swListeners.emit(msg),
    /* sw.js 发出来的帧（结果/事件）都会给这个回调 */
    setOnFromSw: (fn) => (onFromSw = fn),
    frameNum,
    /* 浏览器死了之后原地换一个新的（见上面 rebind 的注释） */
    rebind,
    /*
     * 各张内部表的条目数，外加 counters 里那两个只增不减的往返计数。
     * 这些表都是「只在某个事件到达时才删」的形状，漏一处就是无声的内存泄漏，
     * 所以把条目数摆出来，好断言「跑完一轮回到起点」。只给诊断和测试用。
     */
    stats: () => ({
      counters: { ...counters },
      targets: browser.targets.size,
      sessionTab: sessionTab.size,
      childSessions: childSessions.size,
      sessionParent: sessionParent.size,
      sessionInfo: sessionInfo.size,
      worldByFrame: worldByFrame.size,
      loadState: loadState.size,
      attachedTabs: attachedTabs.size,
      frameMaps: frameMaps.size,
      frameIds: [...frameMaps.values()].reduce((n, m) => n + m.toNum.size, 0),
      groups: groups.size,
      alarms: alarmTimers.size,
    }),
  };
}
