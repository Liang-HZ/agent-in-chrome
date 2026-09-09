#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
async function throws(fn, re) {
  try {
    await fn();
    return { threw: false, msg: "(没抛)" };
  } catch (e) {
    return { threw: true, msg: String(e.message), match: re.test(e.message) };
  }
}

function matchOne(el, part) {
  part = String(part).trim();
  if (!part) return false;
  if (part === "*") return true;
  let neg = null;
  const notM = /:not\(([^)]*)\)\s*$/.exec(part);
  if (notM) {
    neg = notM[1];
    part = part.slice(0, notM.index);
  }
  const m = /^([a-zA-Z]*)((?:[#.][\w-]+|\[[^\]]*\])*)$/.exec(part.trim());
  if (!m) return false;
  if (m[1] && String(el.tagName || "").toLowerCase() !== m[1].toLowerCase()) return false;
  for (const idSel of m[2].match(/#[\w-]+/g) || []) {
    const want = idSel.slice(1);
    if (el.id !== want && el._id !== want) return false;
  }
  for (const clsSel of m[2].match(/\.[\w-]+/g) || []) {
    const cls = String(el.className || el.getAttribute?.("class") || "");
    if (!cls.split(/\s+/).includes(clsSel.slice(1))) return false;
  }
  for (const a of m[2].match(/\[[^\]]*\]/g) || []) {
    const am = /^\[([^~^=\]]+)([~^])?(?:="?([^"\]]*)"?)?\]$/.exec(a);
    if (!am) return false;
    const v = el.getAttribute(am[1]);
    if (v === null || v === undefined) return false;
    if (am[3] !== undefined) {
      if (am[2] === "~") {
        if (!String(v).split(/\s+/).includes(am[3])) return false;
      } else if (am[2] === "^") {
        if (!String(v).startsWith(am[3])) return false;
      } else if (String(v) !== am[3]) return false;
    }
  }
  if (neg && matchOne(el, neg)) return false;
  return true;
}
const matchesSel = (el, sel) => String(sel).split(",").some((p) => matchOne(el, p));

function looksLikeSelector(sel) {
  const s = String(sel == null ? "" : sel).trim();
  if (!s) return false;
  if (/^[>+~,]|[>+~,]$/.test(s)) return false;
  const count = (re) => (s.match(re) || []).length;
  return count(/\[/g) === count(/\]/g) && count(/\(/g) === count(/\)/g);
}

function assertSelector(sel) {
  const s = String(sel);
  const unbalanced = (a, b) => s.split(a).length !== s.split(b).length;
  if (!s.trim() || unbalanced("[", "]") || unbalanced("(", ")")) {
    const e = new Error(`Failed to execute 'querySelectorAll' on 'Document': '${s}' is not a valid selector.`);
    e.name = "SyntaxError";
    throw e;
  }
}

const styleOfMock = (e) => e._style || {};
const rectOf = (e) => e.getBoundingClientRect();
const clippedAt = (e, x, y) => {
  let p = e.parentNode;
  while (p && p.nodeType === 1) {
    const s = styleOfMock(p);
    const ov = [s.overflow, s.overflowX, s.overflowY].filter(Boolean).join(" ");
    if (/hidden|clip|auto|scroll/.test(ov)) {
      const r = rectOf(p);
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return true;
    }
    p = p.parentNode;
  }
  return false;
};

const hitTest = (list, x, y) => {
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const s = styleOfMock(e);
    if (s.display === "none" || s.visibility === "hidden" || String(s.opacity) === "0") continue;
    if (s.pointerEvents === "none") continue;
    const r = rectOf(e);
    if (r.width < 1 || r.height < 1) continue;
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      if (clippedAt(e, x, y)) continue;
      return e;
    }
  }
  return null;
};

const deepHitMock = (page, x, y) => {
  let node = hitTest(page.all, x, y);
  let guard = 0;
  while (node && guard++ < 32) {
    const sr = node.shadowRoot;
    if (!sr || !sr.elementFromPoint) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === node) break;
    node = inner;
  }
  return node;
};

const fireAt = (page, type, target) => {
  if (!target) return;
  const path = [];
  let n = target;
  let guard = 0;
  while (n && guard++ < 200) {
    path.push(n);
    n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode;
  }
  for (const e of path) {
    for (const l of (e._listeners || []).slice()) {
      if (l.type === type) {
        try {
          l.fn({ type, target });
        } catch {}
      }
    }
  }
  page.win.__fire(type, target);
};

function el(tag, props = {}) {
  const b = props.box || [10, 20, 100, 30];
  const attrs = { ...(props.attrs || {}) };
  if (props.role) attrs.role = props.role;
  const o = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: props.id,
    isConnected: props.isConnected !== false,
    innerText: props.innerText ?? props.text ?? "",
    textContent: props.innerText ?? props.text ?? "",
    type: props.type,
    value: props.value,
    disabled: props.disabled,
    checked: props.checked,
    placeholder: props.placeholder,
    alt: props.alt,
    labels: props.labels,
    href: props.href,
    src: props.src,
    clientLeft: props.clientLeft || 0,
    clientTop: props.clientTop || 0,
    parentNode: null,
    shadowRoot: null,
    _children: props.children || [],
    _shadow: props.shadow || null,
    _style: { visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto", ...(props.style || {}) },
    name: props.name ?? "",
    multiple: props.multiple,
    accept: props.accept,
    files: props.files || [],
    _attrs: attrs,
    _listeners: [],
    _dispatched: [],
    setAttribute: (n, v) => {
      attrs[n] = v;
    },
    removeAttribute: (n) => {
      delete attrs[n];
    },
    hasAttribute: (n) => n in attrs,
    addEventListener(type, fn) {
      o._listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      o._listeners = o._listeners.filter((l) => !(l.type === type && l.fn === fn));
    },
    dispatchEvent(ev) {
      o._dispatched.push(ev && ev.type);
      for (const l of o._listeners) if (l.type === (ev && ev.type)) l.fn(ev);
      return true;
    },
    getAttribute: (n) => {
      if (n === "href") return props.href ?? null;
      if (n === "disabled") return props.disabled ? "" : (attrs[n] ?? null);
      return attrs[n] ?? null;
    },
    getBoundingClientRect: () => ({
      x: b[0],
      y: b[1],
      left: b[0],
      top: b[1],
      width: b[2],
      height: b[3],
      bottom: b[1] + b[3],
      right: b[0] + b[2],
    }),
    scrollIntoView(opts) {
      o._scrolledIntoView = (o._scrolledIntoView || 0) + 1;
      if (props.onScrollIntoView) props.onScrollIntoView(o, opts);
    },
    matches: (sel) => matchesSel(o, sel),
    closest(sel) {
      let n = o;
      while (n) {
        if (n.nodeType === 1 && matchesSel(n, sel)) return n;
        n = n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode;
      }
      return null;
    },
    contains(other) {
      let n = other;
      while (n) {
        if (n === o) return true;
        n = n.parentNode;
      }
      return false;
    },
    getRootNode() {
      let n = o;
      while (n.parentNode) n = n.parentNode;
      return n;
    },
    querySelectorAll(sel) {
      const out = [];
      const root = o.getRootNode();
      const list = (root && (root._all || root.__all)) || [];
      for (const e of list) if (e !== o && o.contains(e) && matchesSel(e, sel)) out.push(e);
      return out;
    },
    querySelector(sel) {
      return o.querySelectorAll(sel)[0] || null;
    },
  };
  Object.defineProperty(o, "parentElement", {
    get: () => (o.parentNode && o.parentNode.nodeType === 1 ? o.parentNode : null),
  });
  if (props._id) o._id = props._id;
  return o;
}

function wire(roots, parent, sink) {
  for (const e of roots) {
    e.parentNode = parent;
    sink.push(e);
    if (e._shadow) {
      const list = [];
      const sr = {
        nodeType: 11,
        host: e,
        _all: list,
        querySelectorAll: (sel) => (sel === "*" ? list.slice() : list.filter((x) => matchesSel(x, sel))),
        getElementById: (id) => list.find((x) => x.id === id) || null,
        elementFromPoint: (x, y) => hitTest(list, x, y),
        ownerDocument: null,
      };
      e.shadowRoot = sr;
      wire(e._shadow, sr, list);
    }
    if (e._children && e._children.length) wire(e._children, e, sink);
  }
}

function makePage(elements, opts = {}) {
  const all = [];
  wire(elements, null, all);
  const doc = {
    nodeType: 9,
    title: opts.title || "测试页",
    body: {
      nodeType: 1,
      nodeName: "BODY",
      tagName: "BODY",
      innerText: opts.bodyText || "页面正文内容",
      _style: opts.bodyStyle || {},
      children: [],
      insertBefore(el, next) {
        const i = next ? this.children.indexOf(next) : -1;
        if (i >= 0) this.children.splice(i, 0, el);
        else this.children.push(el);
        return el;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (list) => {
          for (const c of list || []) {
            if (matchesSel(c, sel)) out.push(c);
            if (typeof c.querySelectorAll === "function") out.push(...c.querySelectorAll(sel));
            else walk(c.children);
          }
        };
        walk(this.children);
        return out;
      },
    },
    documentElement: {
      nodeType: 1,
      nodeName: "HTML",
      tagName: "HTML",
      scrollHeight: opts.pageHeight ?? 2400,
      _style: opts.htmlStyle || {},
      children: [],
    },
    _all: all,
    querySelectorAll: (sel) => {
      assertSelector(sel);
      return sel === "*" ? all.slice() : all.filter((e) => matchesSel(e, sel));
    },
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: (sel) => {
      if (!looksLikeSelector(sel)) {
        throw new Error(`Failed to execute 'querySelector': '${sel}' is not a valid selector.`);
      }
      return opts.selectorHit === sel ? all[0] || null : all.find((e) => matchesSel(e, sel)) || null;
    },
    elementFromPoint: (x, y) => hitTest(all, x, y),
    createTreeWalker: (root, _what, filter) => {
      const list =
        root === doc ? all : root._all || all.filter((e) => e !== root && root.contains && root.contains(e));
      let i = 0;
      const rejected = new Set();
      return {
        nextNode() {
          while (i < list.length) {
            const el = list[i++];
            let p = el.parentNode;
            let skip = false;
            while (p) {
              if (rejected.has(p)) { skip = true; break; }
              p = p.parentNode;
            }
            if (skip) continue;
            const verdict = filter && filter.acceptNode ? filter.acceptNode(el) : 1;
            if (verdict === 2) { rejected.add(el); continue; }
            return el;
          }
          return null;
        },
      };
    },
  };
  doc.documentElement.children = [
    { nodeType: 1, nodeName: "HEAD", tagName: "HEAD", id: "", attributes: [], children: [], getAttribute: () => null },
    doc.body,
  ];
  doc.body.getAttribute = doc.body.getAttribute || (() => null);

  const win = {
    document: doc,
    location: { href: opts.url || "https://example.com/page" },
    getComputedStyle: styleOfMock,
    scrollX: 0,
    scrollY: opts.scrollY ?? 0,
    innerWidth: opts.innerWidth ?? 1200,
    innerHeight: opts.innerHeight ?? 800,
    frameElement: null,
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
      }
    },
  };
  win.__timers = [];
  let timerSeq = 1;
  win.setTimeout = (fn, ms) => {
    const id = timerSeq++;
    win.__timers.push({ id, fn, ms });
    return id;
  };
  win.clearTimeout = (id) => {
    const i = win.__timers.findIndex((t) => t.id === id);
    if (i >= 0) win.__timers.splice(i, 1);
  };
  win.__runTimer = (ms) => {
    const t = win.__timers.find((x) => x.ms === ms);
    if (!t) return false;
    win.clearTimeout(t.id);
    t.fn();
    return true;
  };
  win.__msgListeners = [];
  win.__msgQueue = [];
  const flushMsgs = () => {
    const q = win.__msgQueue.splice(0);
    for (const [data, source] of q) {
      for (const fn of win.__msgListeners.slice()) {
        try {
          fn({ data, source });
        } catch {}
      }
    }
  };
  win.__listeners = {};
  win.addEventListener = (type, fn) => {
    if (type === "message") win.__msgListeners.push(fn);
    (win.__listeners[type] = win.__listeners[type] || []).push(fn);
  };
  win.removeEventListener = () => {};
  win.__fire = (type, target) => {
    for (const fn of (win.__listeners[type] || []).slice()) {
      try {
        fn({ type, target });
      } catch {}
    }
  };
  win.postMessage = (data, _origin, source) => {
    win.__msgQueue.push([data, source !== undefined ? source : win.parent]);
    setTimeout(flushMsgs, 0);
  };
  const observers = [];
  win.MutationObserver = class {
    constructor(cb) {
      this._cb = cb;
      this.connected = false;
      this.target = null;
      this.options = {};
      observers.push(this);
    }
    observe(target, options = {}) {
      this.target = target;
      this.options = { ...options };
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  };
  const mutate = (type = "childList", target = null) => {
    let fired = 0;
    for (const o of observers.slice()) {
      if (!o.connected || !o.options[type]) continue;
      fired++;
      o._cb([{ type, target, addedNodes: [], removedNodes: [] }], o);
    }
    return fired;
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  win.top = win;
  doc.defaultView = win;
  for (const e of all) {
    e.ownerDocument = doc;
    if (e.shadowRoot) e.shadowRoot.ownerDocument = doc;
  }
  return { win, ctx: win, doc, all, elements, observers, __mutate: mutate };
}

function nestFrame(parentPage, iframeEl, childPage, { sameOrigin = true } = {}) {
  childPage.win.top = parentPage.win.top;
  iframeEl.contentWindow = childPage.win;
  childPage.win.parent = parentPage.win;
  const r = iframeEl.getBoundingClientRect ? iframeEl.getBoundingClientRect() : null;
  if (r && !childPage.keepViewport) {
    childPage.win.innerWidth = r.width;
    childPage.win.innerHeight = r.height;
  }
  if (sameOrigin) {
    childPage.win.frameElement = iframeEl;
  } else {
    Object.defineProperty(childPage.win, "frameElement", {
      get() {
        throw new Error("SecurityError: Blocked a frame with origin ... from accessing a cross-origin frame.");
      },
      configurable: true,
    });
  }
  return childPage;
}

function makeChrome(state) {
  const listeners = () => {
    const fns = [];
    return { addListener: (f) => fns.push(f), removeListener: () => {}, _fire: (...a) => fns.forEach((f) => f(...a)) };
  };

  const withWin = (g) =>
    g.windowId != null ? g : { ...g, windowId: state.tabs.find((t) => t.groupId === g.id)?.windowId };

  const activateTab = (t) => {
    if (!t) return;
    if (t.active && !state.tabs.some((x) => x.windowId === t.windowId && x.id !== t.id && x.active)) return;
    for (const x of state.tabs) if (x.windowId === t.windowId) x.active = x.id === t.id;
    chromeRef.tabs.onActivated._fire({ tabId: t.id, windowId: t.windowId });
  };

  const dropEmptyGroups = () => {
    const gone = state.groups.filter((g) => !state.tabs.some((t) => t.groupId === g.id));
    if (!gone.length) return;
    state.groups = state.groups.filter((g) => state.tabs.some((t) => t.groupId === g.id));
    for (const g of gone) chromeRef.tabGroups.onRemoved._fire(g);
  };

  const chromeRef = {
    runtime: {
      lastError: undefined,
      connectNative: () => {
        const p = {
          postMessage: (m) => state.sent.push(m),
          disconnect: () => {},
          onMessage: listeners(),
          onDisconnect: listeners(),
        };
        state.hostPort = p;
        return p;
      },
      onMessage: listeners(),
      onStartup: listeners(),
      onInstalled: listeners(),
      reload: () => state.runtimeReloads.push(Date.now()),
      getPlatformInfo: async () => ({ os: state.platformOs || "mac" }),
      getURL: (p) => `chrome-extension://aic-test/${String(p).replace(/^\//, "")}`,
    },
    alarms: {
      create: (name, info) => (state.alarms = state.alarms || []).push({ name, info }),
      clear: (name) => {
        (state.alarmClears = state.alarmClears || []).push(name);
      },
      onAlarm: listeners(),
    },
    debugger: {
      attach: (t, v, cb) => {
        if (typeof state.attachHang === "function" && state.attachHang(t.tabId)) {
          state.attachTries = (state.attachTries || 0) + 1;
          return;
        }
        const why = typeof state.attachFail === "function" ? state.attachFail(t.tabId) : null;
        if (why) {
          state.attachTries = (state.attachTries || 0) + 1;
          chromeRef.runtime.lastError = { message: why };
          cb();
          chromeRef.runtime.lastError = undefined;
          return;
        }
        state.attachTries = (state.attachTries || 0) + 1;
        state.attached.push(t.tabId);
        state.cdpVersion = v;
        cb();
      },
      getTargets: (cb) => cb(state.dbgTargets || []),
      detach: (t, cb) => {
        if (typeof state.detachFail === "function" && state.detachFail(t.tabId)) {
          chromeRef.runtime.lastError = { message: "Cannot access a chrome-extension:// URL of different extension" };
          cb();
          chromeRef.runtime.lastError = undefined;
          return;
        }
        state.detached.push(t.tabId);
        cb();
      },
      sendCommand: (t, method, params, cb) => {
        state.cdp.push({ tabId: t.tabId, sessionId: t.sessionId, method, params });
        if (typeof state.cdpHang === "function" && state.cdpHang(method)) return;

        if (method === "Page.setWebLifecycleState") {
          (state.lifecycle = state.lifecycle || []).push({ tabId: t.tabId, state: params?.state });
          if (params?.state === "active" && state.frozen) state.frozen.delete(t.tabId);
          return cb({});
        }
        if (method === "Runtime.addBinding") {
          (state.bindings = state.bindings || []).push(params?.name);
          return cb({});
        }
        if (method === "Page.navigate") {
          const t2 = state.tabs.find((x) => x.id === t.tabId);
          state.tabUpdates.push({ id: t.tabId, props: { url: params.url }, viaCdp: true });
          if (typeof state.navigateFails === "function") {
            const err = state.navigateFails(params.url);
            if (err) return cb({ frameId: "f0", errorText: err });
          }
          if (t2 && params.url !== "about:blank") {
            t2.url = params.url;
            t2.title = "导航后的标题";
          }
          return cb({ frameId: "f0", loaderId: "l1" });
        }
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          state.initScripts = state.initScripts || [];
          const id = "script-" + (state.initScripts.length + 1);
          state.initScripts.push({ identifier: id, source: String(params?.source || "") });
          if (params?.runImmediately && /__aicCursor/.test(params.source || "")) state.cursorDefined = true;
          return cb({ identifier: id });
        }
        if (method === "Page.removeScriptToEvaluateOnNewDocument") {
          state.initScripts = (state.initScripts || []).filter((s) => s.identifier !== params?.identifier);
          return cb({});
        }
        if (method === "Runtime.evaluate" && /__aicCursor/.test(String(params?.expression || ""))) {
          const expr = String(params.expression);
          if (/window\.__aicCursor = /.test(expr)) {
            state.cursorDefined = true;
            state.overlayGone = false;
          }
          if (!state.cursorDefined) return cb({ result: { value: false } });
          if (state.overlayGone && /"lease"/.test(expr)) return cb({ result: { value: { ok: false } } });
          const re2 = /__aicCursor\("(\w+)",(\{.*?\})\)/g;
          state.cursorCalls = state.cursorCalls || [];
          for (let m2; (m2 = re2.exec(expr)); ) {
            let arg = {};
            try { arg = JSON.parse(m2[2]); } catch {}
            state.cursorCalls.push({ op: m2[1], arg, exprLength: expr.length });
          }
          return cb({ result: { value: { ok: true } } });
        }
        if (method === "Runtime.evaluate") {
          const expr = String(params?.expression || "");
          const m = /data-aic-hit="([^"]+)"/.exec(expr);
          if (m && /removeAttribute/.test(expr)) {
            for (const e of state.page?.all || []) {
              if (e._attrs && e._attrs["data-aic-hit"] === m[1]) delete e._attrs["data-aic-hit"];
            }
            return cb({ result: { type: "undefined" } });
          }
          const ptInfo = /const X = (-?\d+), Y = (-?\d+);/.exec(expr);
          if (ptInfo && /__AIC_POINT__/.test(expr)) {
            const X = Number(ptInfo[1]), Y = Number(ptInfo[2]);
            const vw = state.viewport?.w ?? state.page?.win?.innerWidth ?? 1200;
            const vh = state.viewport?.h ?? state.page?.win?.innerHeight ?? 900;
            if (!(X >= 0 && Y >= 0 && X < vw && Y < vh)) return cb({ result: { value: { outside: true, vw, vh } } });
            const hit = deepHitMock(state.page, X, Y);
            if (!hit) return cb({ result: { value: { ok: true, hit: "(空)", vw, vh } } });
            const attrs = [];
            for (const k of ["id", "class", "role", "aria-label"]) {
              const v = (k === "id" ? hit.id : undefined) ?? (hit.getAttribute && hit.getAttribute(k));
              if (v) attrs.push(`${k}="${String(v).slice(0, 40)}"`);
            }
            const t = String(hit.innerText || "").trim().slice(0, 40);
            return cb({
              result: {
                value: {
                  ok: true,
                  hit: `<${String(hit.tagName || "?").toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>${t ? " " + t : ""}`,
                  vw, vh,
                },
              },
            });
          }
          const pt = /const X = (-?\d+), Y = (-?\d+);/.exec(expr);
          if (pt && /elementFromPoint/.test(expr)) {
            const hit = deepHitMock(state.page, Number(pt[1]), Number(pt[2]));
            if (!hit) return cb({ result: { value: { none: true } } });
            let owner = hit;
            while (owner && !(owner._attrs && owner._attrs["data-aic-hit"])) owner = owner.parentNode;
            const attrs = [];
            for (const k of ["id", "class", "role", "aria-label"]) {
              const v = (k === "id" ? hit.id : undefined) ?? (hit.getAttribute && hit.getAttribute(k));
              if (v) attrs.push(`${k}="${String(v).slice(0, 40)}"`);
            }
            return cb({
              result: {
                value: {
                  mark: owner ? owner._attrs["data-aic-hit"] : null,
                  desc: `<${String(hit.tagName || "?").toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`,
                },
              },
            });
          }
          if (/fonts\.ready/.test(expr)) {
            const stabilize = /const STABILIZE = true/.test(expr);
            const cursor = !!state.cursorPresent;
            if (!stabilize) return cb({ result: { value: { fonts: true, cursor, skipped: true } } });
            return cb({ result: { value: { fonts: !state.slowFonts, cursor } } });
          }
          if (/innerWidth/.test(expr) && !/__AIC_EMULATE__/.test(expr)) {
            return cb({
              result: {
                value: {
                  w: state.viewport?.w ?? state.page?.win?.innerWidth ?? 1200,
                  h: state.viewport?.h ?? state.page?.win?.innerHeight ?? 900,
                },
              },
            });
          }
        }
        if (method === "Runtime.callFunctionOn" && String(params?.objectId || "").startsWith("obj:")) {
          const TEXT = 500000;
          const pageOf = (oid) => {
            const at = String(oid).indexOf("@");
            if (at < 0) return state.page;
            const sid = String(oid).slice(at + 1);
            const f = (state.subFrames || []).find((x) => "sess-" + x.frameId === sid);
            return f ? f.page : state.page;
          };
          const pick = (oid) => {
            if (!oid) return null;
            const all = pageOf(oid)?.all || [];
            const at = String(oid).indexOf("@");
            const n = Number(String(oid).slice(4, at < 0 ? undefined : at));
            if (n >= TEXT) { const owner = all[n - TEXT]; return owner ? { nodeType: 3, __owner: owner } : null; }
            return all[n - 1000] || null;
          };
          const all = pageOf(params.objectId)?.all || [];
          const a = pick(params.objectId);
          const b = pick(params.arguments?.[0]?.objectId);
          const fn = String(params.functionDeclaration || "");
          if (/this\.setAttribute\(a/.test(fn)) {
            const attr = params.arguments?.[0]?.value;
            if (a && attr) { a._attrs = a._attrs || {}; a._attrs[attr] = ""; }
            return cb({ result: { type: "undefined" } });
          }
          if (/data-aic-hit/.test(fn) && /setAttribute/.test(fn)) {
            if (a) { a._attrs = a._attrs || {}; a._attrs["data-aic-hit"] = params.arguments?.[0]?.value; }
            return cb({ result: { value: !!a } });
          }
          const scrollRoot = () =>
            (state.scrollRoot ||= { tagName: "HTML", id: "", scrollTop: 0, scrollLeft: 0, scrollHeight: 3000, clientHeight: 800, scrollWidth: 800, clientWidth: 800 });
          if (/const el = this;/.test(fn) && /scrollBy\(dx, dy\)/.test(fn)) {
            const dx = Number(params.arguments?.[0]?.value) || 0;
            const dy = Number(params.arguments?.[1]?.value) || 0;
            const intoView = !!params.arguments?.[2]?.value;
            const box = a?._scrollBox || null;
            const t = box || scrollRoot();
            const before = { top: t.scrollTop, left: t.scrollLeft };
            const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)));
            if (intoView) t.scrollTop = clamp(a?._intoViewTop ?? t.scrollTop, t.scrollHeight - t.clientHeight);
            else {
              t.scrollTop = clamp(t.scrollTop + dy, t.scrollHeight - t.clientHeight);
              t.scrollLeft = clamp(t.scrollLeft + dx, t.scrollWidth - t.clientWidth);
            }
            return cb({
              result: {
                value: {
                  container: "<" + String(t.tagName).toLowerCase() + (t.id ? ` id="${t.id}"` : "") + ">",
                  pageRoot: !box,
                  before,
                },
              },
            });
          }
          if (/const el = this;/.test(fn) && /maxTop/.test(fn)) {
            const t = a?._scrollBox || scrollRoot();
            return cb({
              result: {
                value: {
                  top: t.scrollTop, left: t.scrollLeft,
                  maxTop: t.scrollHeight - t.clientHeight,
                  maxLeft: t.scrollWidth - t.clientWidth,
                },
              },
            });
          }
          if (/scrollIntoView/.test(fn)) {
            if (a && a.scrollIntoView) a.scrollIntoView({ block: "center" });
            return cb({ result: { type: "undefined" } });
          }
          if (/const tag = this.tagName/.test(fn)) {
            const tag = String(a?.tagName || "").toLowerCase();
            const type = String(a?.type || "").toLowerCase();
            const ac = String((a?.getAttribute && a.getAttribute("autocomplete")) || "").toLowerCase();
            let kind = "text";
            if (tag === "select") kind = "select";
            else if (tag === "textarea") kind = "text";
            else if (tag === "input") {
              if (type === "checkbox") kind = "checkbox";
              else if (type === "radio") kind = "radio";
              else if (type === "file") kind = "file";
              else if (["date", "time", "datetime-local", "month", "week", "color", "range"].includes(type)) kind = "special";
              else kind = "text";
            } else {
              const ce = a?.getAttribute && a.getAttribute("contenteditable");
              if (a?.contentEditable === "true" || (ce !== null && ce !== undefined && ce !== "false"))
                kind = "contenteditable";
              else kind = "other";
            }
            const role = String((a?.getAttribute && a.getAttribute("role")) || "").toLowerCase();
            const ariaChecked = a?.getAttribute ? a.getAttribute("aria-checked") : null;
            const ariaPressed = a?.getAttribute ? a.getAttribute("aria-pressed") : null;
            const CHECK_ROLES = ["switch", "checkbox", "radio", "menuitemcheckbox", "menuitemradio", "option", "treeitem"];
            const toggleAttr = ariaChecked !== null && ariaChecked !== undefined ? "aria-checked"
              : CHECK_ROLES.includes(role) ? "aria-checked" : "aria-pressed";
            if (kind === "other" && (CHECK_ROLES.includes(role) || (ariaPressed !== null && ariaPressed !== undefined)))
              kind = "aria-toggle";
            const hasValueProp =
              a?._hasValueProp !== undefined
                ? !!a._hasValueProp
                : ["input", "select", "textarea", "option", "button", "progress", "meter", "output", "param", "li", "data"].includes(tag);
            return cb({
              result: {
                value: {
                  tag, type, kind,
                  secret: type === "password" || /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac),
                  value: typeof a?.value === "string" ? a.value : "",
                  checked: !!a?.checked,
                  disabled: !!a?.disabled,
                  readOnly: !!a?.readOnly,
                  role,
                  ariaChecked: ariaChecked ?? null,
                  ariaPressed: ariaPressed ?? null,
                  toggleAttr,
                  toggleState: (toggleAttr === "aria-checked" ? ariaChecked : ariaPressed) ?? null,
                  toggleRadio: role === "radio" || role === "menuitemradio",
                  hasValueProp,
                  controlHint: a?._controlHint || "",
                  multiple: tag === "select" ? !!a?.multiple : undefined,
                  options: tag === "select" ? (a._options || []) : undefined,
                },
              },
            });
          }
          if (/const opts = Array.from\(this.options\)/.test(fn) || /desc.set.call/.test(fn)) {
            const v = params.arguments?.[0]?.value;
            const kind = params.arguments?.[1]?.value;
            if (!a) return cb({ result: { value: { error: "节点没了" } } });
            if (a.disabled) return cb({ result: { value: { error: "这个控件是 disabled 的，设不进去（页面上也点不了）。" } } });
            if (a.readOnly) return cb({ result: { value: { error: "这个控件是 readonly 的，设不进去。" } } });
            if (kind === "select") {
              const opts = a._options || [];
              const wants = Array.isArray(v) ? v : [v];
              if (!a.multiple && wants.length > 1)
                return cb({ result: { value: { error: `这是单选 <select>（没有 multiple），一次只能给一个值，收到 ${wants.length} 个。` } } });
              const idx = [];
              for (const w of wants) {
                let i = opts.findIndex((o) => o.value === w);
                if (i < 0) i = opts.findIndex((o) => o.label === w);
                if (i < 0) return cb({ result: { value: { error: `选项里没有 ${JSON.stringify(w)}。现有选项：${JSON.stringify(opts)}` } } });
                if (opts[i].disabled) return cb({ result: { value: { error: `选项 ${JSON.stringify(w)} 是 disabled 的，选不了。` } } });
                idx.push(i);
              }
              if (a.multiple) {
                opts.forEach((o) => { o.selected = false; });
                idx.forEach((i) => { opts[i].selected = true; });
                const sel = opts.filter((o) => o.selected);
                return cb({ result: { value: {
                  ok: sel.length === idx.length,
                  multiple: true,
                  values: sel.map((o) => o.value),
                  labels: sel.map((o) => o.label),
                  indexes: idx,
                } } });
              }
              a.value = opts[idx[0]].value;
              return cb({ result: { value: { ok: true, value: a.value, label: opts[idx[0]].label, index: idx[0] } } });
            }
            if (a._rejectValue && a._rejectValue(v)) {
              return cb({ result: { value: { error: `设成 ${JSON.stringify(v)} 之后回读到的是 ${JSON.stringify(a.value)}——这个控件不接受这个值。` } } });
            }
            a.value = v;
            return cb({ result: { value: { ok: true, value: v } } });
          }
          if (/parentElement/.test(fn)) {
            const el = a && (a.nodeType === 1 ? a : a.__owner);
            return cb(el ? { result: { objectId: "obj:" + (all.indexOf(el) + 1000) } } : { result: { type: "undefined" } });
          }
          const related = !!(a && b && (a === b || (a.contains && a.contains(b)) || (b.contains && b.contains(a))));
          return cb({ result: { type: "boolean", value: related } });
        }

        if (method === "Runtime.evaluate" && /a===document\.body/.test(String(params?.expression || ""))) {
          return cb({ result: { value: state.focusStuckOnBody || state.focusReadsBody ? "body" : "ok" } });
        }
        if (method === "Runtime.evaluate" && /__aicShieldAte/.test(String(params?.expression || ""))) {
          return cb({
            result: {
              value: state.shieldAte
                ? JSON.stringify({ n: 1, type: "pointerdown", lateMs: 1370, wall: Date.now() })
                : "",
            },
          });
        }
        if (typeof state.cdpFail === "function") {
          const msg = state.cdpFail(method, params, t);
          if (msg) {
            chromeRef.runtime.lastError = { message: msg };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
        }

        {
          const sessFrame = (state.subFrames || []).find((f) => "sess-" + f.frameId === t.sessionId);
          const r = cdpDomMock(state, method, params, sessFrame ? sessFrame.page : state.page, t.sessionId || "");
          if (r !== undefined) {
            if (r && r.__cdpError) {
              chromeRef.runtime.lastError = { message: r.__cdpError };
              cb(undefined);
              chromeRef.runtime.lastError = undefined;
            } else cb(r);
            return;
          }
        }

        if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel" && !state.wheelDead) {
          const ch = (state.layoutMetrics?.cssContentSize || { height: 600, width: 800 }).height;
          const cw = (state.layoutMetrics?.cssContentSize || { height: 600, width: 800 }).width;
          const vh = (state.layoutMetrics?.cssVisualViewport || { clientHeight: 600, clientWidth: 800 }).clientHeight;
          const vw = (state.layoutMetrics?.cssVisualViewport || { clientHeight: 600, clientWidth: 800 }).clientWidth;
          state.scrollY = Math.max(0, Math.min((state.scrollY ?? 0) + (params.deltaY || 0), Math.max(0, ch - vh)));
          state.scrollX = Math.max(0, Math.min((state.scrollX ?? 0) + (params.deltaX || 0), Math.max(0, cw - vw)));
          if (state.layoutMetrics?.cssVisualViewport) {
            state.layoutMetrics.cssVisualViewport.pageY = state.scrollY;
            state.layoutMetrics.cssVisualViewport.pageX = state.scrollX;
          }
        }
        if (method === "Input.dispatchMouseEvent" && state.focusStuckOnBody) return cb({});
        if (method === "Input.dispatchMouseEvent" && state.page && state.page.win.__fire) {
          const seq = { mousePressed: ["pointerdown", "mousedown"], mouseReleased: ["pointerup", "mouseup"] }[params.type];
          if (seq) {
            const hit = state.dispatchHit ? state.dispatchHit() : deepHitMock(state.page, params.x, params.y);
            for (const ty of seq) fireAt(state.page, ty, hit);
            if (hit && !state.noHitBinding) {
              let owner = hit;
              while (owner && !(owner._attrs && owner._attrs["data-aic-hit"])) owner = owner.parentNode;
              if (owner) {
                for (const ty of seq) {
                  chromeRef.debugger.onEvent._fire({ tabId: t.tabId }, "Runtime.bindingCalled", {
                    name: "__aicHit",
                    payload: JSON.stringify({ mark: owner._attrs["data-aic-hit"], type: ty }),
                  });
                }
              }
            }
            if (params.type === "mouseReleased" && !state.noClickSynthesis && !state.noHitBinding) {
              let owner = hit;
              while (owner && !(owner._attrs && owner._attrs["data-aic-hit"])) owner = owner.parentNode;
              if (owner) {
                chromeRef.debugger.onEvent._fire({ tabId: t.tabId }, "Runtime.bindingCalled", {
                  name: "__aicHit",
                  payload: JSON.stringify({ mark: owner._attrs["data-aic-hit"], type: "click" }),
                });
              }
            }
            if (params.type === "mouseReleased" && !state.noClickSynthesis) {
              if (hit && hit.tagName === "INPUT" && (hit.type === "checkbox" || hit.type === "radio")) {
                if (hit.type === "radio") {
                  for (const o of state.page.all || []) {
                    if (o.tagName === "INPUT" && o.type === "radio" && o.name === hit.name) o.checked = false;
                  }
                  hit.checked = true;
                } else hit.checked = !hit.checked;
              }
              fireAt(state.page, "click", hit);
            }
          }
        }

        const subs = () => state.subFrames || [];
        const sidOf = (f) => "sess-" + f.frameId;
        const ownerSid = (f) => (f.under !== undefined ? sidOf(subs().find((x) => x.frameId === f.under) || {}) : undefined);
        const here = t.sessionId;
        const hostFrame = here ? subs().find((f) => sidOf(f) === here) : null;
        const pageOfSession = () => (hostFrame ? hostFrame.page : state.page);
        const treeFrames = () => subs().filter((f) => !f.oopif && ownerSid(f) === here);

        if (here && state.deadSessions && state.deadSessions.has(here)) {
          chromeRef.runtime.lastError = { message: '{"code":-32001,"message":"Session with given id not found."}' };
          cb(undefined);
          chromeRef.runtime.lastError = undefined;
          return;
        }
        if (method === "Page.getFrameTree") {
          const main = { id: hostFrame ? "F" + hostFrame.frameId : "F0", url: hostFrame ? hostFrame.url || "" : "http://main/" };
          return cb({
            frameTree: {
              frame: main,
              childFrames: treeFrames().map((f) => ({ frame: { id: "F" + f.frameId, url: f.url || "" } })),
            },
          });
        }
        if (method === "Page.createIsolatedWorld") {
          const id = String(params?.frameId || "");
          const f = subs().find((x) => "F" + x.frameId === id);
          if (!f && id !== "F0") {
            chromeRef.runtime.lastError = { message: "No frame for given id found" };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
          const ctx = 1000 + (f ? f.frameId : 0);
          (state.ctxMap = state.ctxMap || {})[ctx] = f ? f.page : state.page;
          return cb({ executionContextId: ctx });
        }
        if (method === "Target.setAutoAttach") {
          state.deadSessions = state.deadSessions || new Set();
          if (!params?.autoAttach) {
            for (const f of subs()) if (f.oopif && ownerSid(f) === here) state.deadSessions.add(sidOf(f));
            return cb({});
          }
          for (const f of subs()) {
            if (!f.oopif) continue;
            if (ownerSid(f) !== here) continue;
            state.deadSessions.delete(sidOf(f));
            chromeRef.debugger.onEvent._fire({ tabId: t.tabId, ...(here ? { sessionId: here } : {}) }, "Target.attachedToTarget", {
              sessionId: sidOf(f),
              targetInfo: { targetId: "F" + f.frameId, url: f.url || "", type: "iframe" },
            });
          }
          return cb({});
        }

        if (method === "Storage.getCookies") return cb({ cookies: (state.cookieJar || []).map((c) => ({ ...c })) });
        if (method === "Storage.clearCookies") {
          state.cookieJar = [];
          return cb({});
        }
        if (method === "Network.deleteCookies") {
          const norm = (d) => String(d || "").replace(/^\./, "").toLowerCase();
          state.cookieJar = (state.cookieJar || []).filter(
            (c) =>
              !(
                c.name === params.name &&
                norm(c.domain) === norm(params.domain) &&
                (params.path === undefined || c.path === params.path)
              )
          );
          return cb({});
        }
        if (method === "Storage.setCookies") {
          state.cookieJar = state.cookieJar || [];
          for (const c of params.cookies || []) {
            if (c.sameSite === "None" && !c.secure) continue;
            if (c.expires !== undefined && c.expires !== -1 && c.expires * 1000 < Date.now()) continue;
            const key = (x) => [x.name, x.domain, x.path, x.partitionKey ? JSON.stringify(x.partitionKey) : ""].join(" ");
            const i = state.cookieJar.findIndex((x) => key(x) === key(c));
            if (i >= 0) state.cookieJar[i] = { ...c };
            else state.cookieJar.push({ ...c });
          }
          const reg = (d) => String(d || "").replace(/^\./, "").split(".").slice(-2).join(".");
          const byReg = new Map();
          for (const c of state.cookieJar) byReg.set(reg(c.domain), (byReg.get(reg(c.domain)) || 0) + 1);
          for (const [r, n] of byReg) {
            if (n <= 180) continue;
            let drop = n - 150;
            state.cookieJar = state.cookieJar.filter((c) => !(reg(c.domain) === r && drop-- > 0));
          }
          return cb({});
        }
        if (method === "Page.captureScreenshot")
          return cb({ data: typeof state.screenshotData === "function" ? state.screenshotData(params) : "BASE64PNG" });
        if (method === "Page.getLayoutMetrics")
          return cb(
            state.layoutMetrics || {
              cssContentSize: { width: 800, height: 600 },
              cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: state.scrollX ?? 0, pageY: state.scrollY ?? 0 },
              cssLayoutViewport: {
                clientWidth: pageOfSession()?.win?.innerWidth ?? 800,
                clientHeight: pageOfSession()?.win?.innerHeight ?? 600,
                pageX: state.scrollX ?? 0,
                pageY: state.scrollY ?? 0,
              },
            }
          );
        if (method === "Network.getResponseBody") {
          const b = state.bodies?.[params.requestId];
          if (b === undefined) {
            chromeRef.runtime.lastError = { message: "No resource with given identifier found" };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
          return cb({ body: b, base64Encoded: false });
        }
        if (method === "Network.getRequestPostData") {
          const b = state.postDatas?.[params.requestId];
          if (b === undefined) {
            chromeRef.runtime.lastError = { message: "No resource with given identifier found" };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
          return cb({ postData: b });
        }
        if (method === "Emulation.setFocusEmulationEnabled" && state.noFocusEmulation) {
          chromeRef.runtime.lastError = { message: "'Emulation.setFocusEmulationEnabled' wasn't found" };
          cb(undefined);
          chromeRef.runtime.lastError = undefined;
          return;
        }
        if (method === "Emulation.setDeviceMetricsOverride") {
          state.metrics = { ...params };
          return cb({});
        }
        if (method === "Emulation.clearDeviceMetricsOverride") {
          state.metrics = null;
          return cb({});
        }
        if (method === "Emulation.setGeolocationOverride") {
          state.geo = { ...params };
          return cb({});
        }
        if (method === "Emulation.clearGeolocationOverride") {
          state.geo = null;
          return cb({});
        }
        if (method === "Emulation.setEmulatedMedia") {
          state.emulatedMedia = params?.features?.length ? params.features : null;
          return cb({});
        }
        if (method === "Network.emulateNetworkConditions") {
          state.netConditions = { ...params };
          return cb({});
        }
        if (method === "Browser.grantPermissions") {
          state.perms = state.perms || {};
          for (const n of params?.permissions || []) state.perms[`${params.origin}|${n}`] = "granted";
          return cb({});
        }
        if (method === "Browser.setPermission") {
          state.perms = state.perms || {};
          const key = `${params.origin}|${params?.permission?.name}`;
          if (params?.setting === "prompt") delete state.perms[key];
          else state.perms[key] = params.setting === "denied" ? "denied" : "granted";
          return cb({});
        }
        if (method === "Runtime.evaluate" && /__AIC_EMULATE__/.test(String(params?.expression || ""))) {
          const m = state.metrics;
          const meta = state.viewportMeta ?? null;
          if (!m) return cb({ result: { value: { __AIC_EMULATE__: 1, innerWidth: 1200, innerHeight: 900, dpr: 1, viewportMeta: meta } } });
          const fallback = m.mobile && !meta;
          return cb({
            result: {
              value: {
                __AIC_EMULATE__: 1,
                innerWidth: fallback ? 980 : m.width,
                innerHeight: fallback ? Math.round((m.height * 980) / m.width) : m.height,
                dpr: m.deviceScaleFactor ?? 1,
                viewportMeta: meta,
              },
            },
          });
        }
        if (method === "Runtime.evaluate" && /__AIC_PERM__/.test(String(params?.expression || ""))) {
          if (state.permQueryBroken) return cb({ result: { value: "__AIC_PERM__error" } });
          const name = /name:"([a-zA-Z]+)"/.exec(String(params.expression))?.[1] || "geolocation";
          const tab = state.tabs.find((x) => x.id === t.tabId);
          let origin = null;
          try {
            origin = new URL(tab?.url || "").origin;
          } catch {}
          return cb({ result: { value: "__AIC_PERM__" + ((state.perms || {})[`${origin}|${name}`] || "prompt") } });
        }
        if (method === "Runtime.evaluate") {
          if (params?.expression === "document.visibilityState") {
            return cb({ result: { value: state.visibility ?? "visible" } });
          }
          if (state.evalHangs && String(params?.expression || "") === state.evalHangs) return;
          if (/__aicRafSeen=0/.test(String(params?.expression || ""))) {
            return cb({
              result: { value: JSON.stringify({ vis: state.visibility ?? "visible", focus: state.hasFocus !== false }) },
            });
          }
          if (/__aicRafSeen===1/.test(String(params?.expression || ""))) {
            return cb({ result: { value: state.rafRuns !== false } });
          }
          const qs = /^document\.querySelector\((".*")\)$/.exec(String(params?.expression || "").trim());
          if (qs) {
            let sel = null;
            try { sel = JSON.parse(qs[1]); } catch {}
            const all = state.page?.all || [];
            const hit = sel && sel.startsWith("#") ? all.find((e) => e.id === sel.slice(1)) : null;
            return cb(hit ? { result: { objectId: "obj:" + (all.indexOf(hit) + 1000) } } : { result: {} });
          }
          const mark = /\[(data-aic-upload-[a-z0-9]+)\]/.exec(params?.expression || "");
          if (mark) {
            const target =
              (params?.contextId !== undefined && (state.ctxMap || {})[params.contextId]) || pageOfSession();
            const found = (target?.elements || []).some((e) => e._attrs && mark[1] in e._attrs);
            state.uploadToken = mark[1];
            if (found) state.uploadPage = target;
            return cb(
              found && !state.uploadFindsNothing
                ? { result: { objectId: "obj-" + mark[1] + "-" + (target === state.page ? 0 : subs().find((f) => f.page === target)?.frameId) } }
                : { result: {} }
            );
          }
          const wexpr = String(params?.expression || "");
          if (/__AIC_WAIT__/.test(wexpr)) {
            try {
              new vm.Script(wexpr);
            } catch (e) {
              return cb({ exceptionDetails: { exception: { description: "SyntaxError: " + e.message } } });
            }
            const lit = (name) => {
              const m = new RegExp("const " + name + " = (.*?);").exec(wexpr);
              try {
                return m ? JSON.parse(m[1]) : null;
              } catch {
                return null;
              }
            };
            const SEL = lit("SEL"), TXT = lit("TXT"), URLC = lit("URLC");
            const hasJs = /__AIC_WAIT_JS__/.test(wexpr);
            const poll = Number((/POLL = (\d+)/.exec(wexpr) || [])[1]) || 50;
            const budget = Number((/BUDGET = (\d+)/.exec(wexpr) || [])[1]) || 0;
            const t0 = Date.now();
            let evals = 0, sawValue = false, everSucceeded = false, lastValue, lastError = null;
            const tick = () => {
              const doc = state.page?.doc;
              const url = String(state.page?.win?.location?.href || "https://example.com/page");
              let ok = true;
              try {
                if (SEL && !doc?.querySelector(SEL)) ok = false;
              } catch {
                ok = false;
              }
              if (TXT && !String(doc?.body?.innerText || "").includes(TXT)) ok = false;
              if (URLC && !url.includes(URLC)) ok = false;
              if (hasJs) {
                evals++;
                let r;
                if (typeof state.evalHook === "function") {
                  state.evalCalls = (state.evalCalls || 0) + 1;
                  r = state.evalHook(wexpr, state.evalCalls);
                }
                if (r === undefined) r = state.evalResult || { result: { value: state.evalValue ?? 42 } };
                if (r.exceptionDetails) {
                  lastError = String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "求值抛异常").slice(0, 300);
                  ok = false;
                } else {
                  everSucceeded = true;
                  sawValue = true;
                  lastValue = r.result?.value ?? null;
                  if (!lastValue) ok = false;
                }
              }
              if (ok || Date.now() - t0 >= budget) {
                return cb({
                  result: {
                    value: { matched: ok, url, evals, sawValue, everSucceeded, lastError, jsValue: lastValue === undefined ? null : lastValue },
                  },
                });
              }
              setTimeout(tick, poll);
            };
            return tick();
          }
          if (typeof state.evalHook === "function") {
            state.evalCalls = (state.evalCalls || 0) + 1;
            const hooked = state.evalHook(params?.expression, state.evalCalls);
            if (hooked !== undefined) return cb(hooked);
          }
          if (state.evalSerializeFails) {
            chromeRef.runtime.lastError = { message: "Object reference chain is too long" };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
          if (state.evalThrows) {
            return cb({ exceptionDetails: { exception: { description: "ReferenceError: x is not defined" } } });
          }
          if (state.evalResult) return cb(state.evalResult);
          return cb({ result: { value: state.evalValue ?? 42 } });
        }
        if (method === "DOM.setFileInputFiles") {
          state.setFileInputFilesParams = params;
          if (state.setFileInputFilesFails) {
            chromeRef.runtime.lastError = { message: "Node is not a file input element" };
            cb(undefined);
            chromeRef.runtime.lastError = undefined;
            return;
          }
          const scope = state.uploadPage || state.page;
          const target = (scope.elements || []).find(
            (e) => e._attrs && state.uploadToken && state.uploadToken in e._attrs
          );
          if (target) {
            target.files = (params.files || []).map((p) => {
              const name = String(p).split("/").pop();
              return { name, size: state.fileSizes?.[p] ?? 0, type: "text/plain" };
            });
            if (!state.noNativeChange) {
              for (const l of target._listeners) if (l.type === "change") l.fn({ type: "change" });
            }
          }
          return cb({});
        }
        cb({});
      },
      onEvent: listeners(),
      onDetach: listeners(),
    },
    tabs: {
      captureVisibleTab: async (windowId, opts) =>
        `data:image/${opts?.format || "png"};base64,BASE64VISIBLE`,
      query: async ({ windowId, url, active } = {}) =>
        state.tabs.filter(
          (t) =>
            (windowId == null || t.windowId === windowId) &&
            (url == null || t.url === url) &&
            (active == null || !!t.active === !!active)
        ),
      get: (id, cb) => {
        const t = state.tabs.find((x) => x.id === id);
        if (cb) {
          chromeRef.runtime.lastError = t ? undefined : { message: "No tab with id" };
          cb(t);
          return;
        }
        return t ? Promise.resolve(t) : Promise.reject(new Error("No tab with id"));
      },
      update: async (id, props) => {
        state.tabUpdates.push({ id, props });
        const t = state.tabs.find((x) => x.id === id);
        if (t && props.active) activateTab(t);
        if (t && props.url) {
          t.url = props.url;
          t.title = "导航后的标题";
        }
        if (t && props.pinned != null) t.pinned = !!props.pinned;
        return t;
      },
      reload: async (id, opts) => state.tabUpdates.push({ id, reload: true, ...(opts || {}) }),
      goBack: async (id) => state.tabUpdates.push({ id, back: true }),
      goForward: async (id) => state.tabUpdates.push({ id, forward: true }),
      create: async ({ url, active, windowId }) => {
        const t = {
          id: ++state.nextTabId,
          windowId: windowId || 10,
          title: "新标签页",
          url: url || "about:blank",
          active: !!active,
          status: "complete",
        };
        state.tabs.push(t);
        state.created.push(t);
        if (t.active) activateTab(t);
        chromeRef.tabs.onCreated._fire({ ...t });
        return t;
      },
      remove: async (idOrIds) => {
        const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
        state.removed.push(...ids);
        state.tabs = state.tabs.filter((t) => !ids.includes(t.id));
        dropEmptyGroups();
        for (const id of ids) chromeRef.tabs.onRemoved._fire(id, { windowId: 10, isWindowClosing: false });
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const gid = groupId ?? ++state.nextGroupId;
        state.grouped.push({ tabIds, groupId: gid, createProperties: createProperties || null });
        const t = state.tabs.find((x) => x.id === tabIds);
        const existing = state.groups.find((x) => x.id === gid);
        const winId = existing ? existing.windowId : createProperties?.windowId ?? t?.windowId ?? 10;
        if (t) {
          t.groupId = gid;
          t.windowId = winId;
        }
        if (existing) existing.windowId = winId;
        else state.groups.push({ id: gid, windowId: winId });
        return gid;
      },
      ungroup: async (tabIds) => {
        state.ungrouped.push(tabIds);
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const t = state.tabs.find((x) => x.id === id);
          if (t) t.groupId = -1;
        }
        dropEmptyGroups();
      },
      onCreated: listeners(),
      onUpdated: listeners(),
      onRemoved: listeners(),
      onActivated: listeners(),
    },
    tabGroups: {
      query: async ({ title } = {}) =>
        (title === undefined ? state.groups : state.groups.filter((g) => g.title === title)).map(withWin),
      get: async (id) => {
        const g = state.groups.find((x) => x.id === id);
        if (!g) throw new Error("No group with id");
        return withWin(g);
      },
      update: async (id, props) => {
        const existing = state.groups.find((x) => x.id === id);
        if (!existing && !state.tabs.some((t) => t.groupId === id)) throw new Error("No group with id: " + id);
        if (existing) Object.assign(existing, props);
        else state.groups.push({ id, ...props });
        state.groupUpdates.push({ id, props });
        return { id, ...props };
      },
      move: async (id, props) => {
        const g = state.groups.find((x) => x.id === id);
        if (!g) throw new Error("No group with id");
        state.groupMoves.push({ id, props });
        return g;
      },
      onRemoved: listeners(),
    },
    action: {
      setIcon: async (o) => { state.action.icon = o.path?.[16] || null; },
      setBadgeText: async (o) => { state.action.badge = o.text; },
      setBadgeBackgroundColor: async (o) => { state.action.badgeColor = o.color; },
      setTitle: async (o) => { state.action.title = o.title; },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      update: async (id, p) => {
        state.windowUpdates.push({ id, p });
        const w = (state.windows || []).find((x) => x.id === id);
        if (w && p?.state) w.state = p.state;
        if (p?.focused === true && state.focusedWindowId !== id) {
          state.focusedWindowId = id;
          chromeRef.windows.onFocusChanged._fire(id);
        }
      },
      get: async (id) => {
        const rec = (state.windows || []).find((w) => w.id === id);
        if (id !== 10 && !rec) throw new Error("No window with id");
        return {
          id,
          focused: state.focusedWindowId != null ? state.focusedWindowId === id : state.windowFocused !== false,
          state: rec?.state || state.userWindow.state,
          type: rec?.type || state.userWindow.type || "normal",
        };
      },
      getAll: async () =>
        [state.userWindow, ...(state.windows || [])].map((w) => ({
          type: "normal",
          ...w,
          focused: state.focusedWindowId != null ? state.focusedWindowId === w.id : false,
        })),
      getLastFocused: async () =>
        [state.userWindow, ...(state.windows || [])].find((w) => w.id === state.lastFocusedId) || state.userWindow,
      onFocusChanged: listeners(),
      create: async ({ url, focused, left, top, width, height } = {}) => {
        const w = { id: (state.nextWindowId = (state.nextWindowId || 100) + 1), state: "normal" };
        (state.windows = state.windows || []).push(w);
        state.lastFocusedId = w.id;
        (state.windowCreates = state.windowCreates || []).push({
          id: w.id,
          focused: !!focused,
          bounds: left == null ? null : { left, top, width, height },
        });
        const t = {
          id: ++state.nextTabId,
          windowId: w.id,
          title: "新标签页",
          url: url || "about:blank",
          active: false,
          status: "complete",
        };
        state.tabs.push(t);
        state.created.push(t);
        return { id: w.id, tabs: [t] };
      },
    },
    storage: {
      session: {
        get: async (key) => (key in state.storage ? { [key]: state.storage[key] } : {}),
        set: async (obj) => Object.assign(state.storage, obj),
      },
      local: {
        get: async (key) =>
          key == null ? { ...state.localStorage } : key in state.localStorage ? { [key]: state.localStorage[key] } : {},
        set: async (obj) => Object.assign(state.localStorage, obj),
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete state.localStorage[k];
        },
      },
      sync: {
        get: async (key) =>
          key == null ? { ...state.syncStorage } : key in (state.syncStorage = state.syncStorage || {}) ? { [key]: state.syncStorage[key] } : {},
        set: async (obj) => Object.assign((state.syncStorage = state.syncStorage || {}), obj),
      },
      onChanged: listeners(),
    },
    scripting: {
      executeScript: async (opts) => {
        const { target, func, args, injectImmediately } = opts;
        (state.executed = state.executed || []).push({
          tabId: target?.tabId,
          allFrames: !!target?.allFrames,
          immediate: !!injectImmediately,
          fn: (func && func.name) || null,
        });
        if (typeof state.execHang === "function" && state.execHang(target?.tabId, opts)) await new Promise(() => {});
        if (typeof state.beforeInject === "function") state.beforeInject();
        const run = (page) => {
          const ctx = vm.createContext(page.win);
          const fn = vm.runInContext(`(${func.toString()})`, ctx);
          return fn(...(args || []));
        };
        const frames = [{ frameId: 0, page: state.page }, ...(state.subFrames || [])];
        let picked;
        if (target && target.allFrames) picked = frames;
        else if (target && target.frameIds) picked = frames.filter((f) => target.frameIds.includes(f.frameId));
        else picked = frames.slice(0, 1);
        if (!picked.length) throw new Error("Frame with ID " + JSON.stringify(target.frameIds) + " not found");
        const out = [];
        for (const f of picked) {
          out.push({ frameId: f.frameId, documentId: "doc" + f.frameId, result: await run(f.page) });
        }
        if (typeof state.execHangAfterRun === "function" && state.execHangAfterRun(target?.tabId, opts))
          await new Promise(() => {});
        return out;
      },
    },
  };
  state.chrome = chromeRef;
  return chromeRef;
}

function loadSw(state, chromeOver, patchSrc) {
  let src = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  if (patchSrc) src = patchSrc(src);
  const sandbox = {
    chrome: chromeOver || makeChrome(state),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Promise,
    JSON,
    Error,
    Object,
    Array,
    Number,
    String,
    Math,
    RegExp,
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
      }
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    src +
      "\n;globalThis.__TOOLS = TOOLS;" +
      "\n;globalThis.__pickOverlay = pickOverlayCandidates;" +
      "\n;globalThis.__explain = explainDisconnect;" +
      "\n;globalThis.__persist = persist;" +
      "\n;globalThis.__restore = ensureRestored;" +
      "\n;globalThis.__detachAll = detachAll;" +
      "\n;globalThis.__attach = attach;" +
      "\n;globalThis.__cdpSession = cdpSession;" +
      "\n;globalThis.__detach = detach;" +
      "\n;globalThis.__setAttachWatchdog = (ms) => { ATTACH_WATCHDOG_MS = ms; };" +
      "\n;globalThis.__setRecoverExec = (ms) => { RECOVER_EXEC_MS = ms; };" +
      "\n;globalThis.__setInjectIdle = (ms) => { IDLE_INJECT_MS = ms; };" +
      "\n;globalThis.__setInjectImmediate = (ms) => { IMMEDIATE_INJECT_MS = ms; };" +
      "\n;globalThis.__sessions = sessions;" +
      "\n;globalThis.__bodyBytesUsed = bodyBytesUsed;" +
      "\n;globalThis.__BODY_BUDGET = BODY_BUDGET;" +
      "\n;globalThis.__perTabTables = () => ({" +
      "  ourTabs, tabOwner, attached, focusEmulated, emulated, tabDirty, dialogSeen, oopifHold, oopifSessions," +
      "  consoleRing, networkRing, wsRing, netMark, bodyBytes, ringBreaks, netEnabled, netEnableWhy, pendingDialogs, dialogPolicy," +
      "  pendingReloads, cdpRecoveredAt, cursorScripts, cursorInstalling, inFlightInteractive, hitReports, lastNav });" +
      "\n;globalThis.__agentBySid = agentBySid;" +
      "\n;globalThis.__sweepDormant = sweepDormant;" +
      "\n;globalThis.__redactBody = redactBody;" +
      "\n;globalThis.__attachFrameSessions = attachFrameSessions;" +
      "\n;globalThis.__waitForLoad = waitForLoad;" +
      "\n;globalThis.__holdOopifSessions = holdOopifSessions;" +
      "\n;globalThis.__releaseOopifSessions = releaseOopifSessions;" +
      "\n;globalThis.__composeOffsets = composeOffsets;" +
      "\n;globalThis.__installCursorScript = installCursorScript;" +
      "\n;globalThis.__chainOf = chainOf;" +
      "\n;globalThis.__pruneCookieGate = pruneCookieGate;" +
      "\n;globalThis.__cookieGateStore = cookieGateStore;" +
      "\n;globalThis.__isSensitiveCookieDomain = isSensitiveCookieDomain;" +
      "\n;globalThis.__inputGate = inputGate;" +
      "\n;globalThis.__ledgerRead = ledgerRead;" +
      "\n;globalThis.__pruneLedgers = pruneLedgers;" +
      "\n;globalThis.__reclaimForSid = reclaimForSid;" +
      "\n;globalThis.__networkRing = networkRing;" +
      "\n;globalThis.__onHostMessage = onHostMessage;" +
      "\n;globalThis.__setPort = (p) => { port = p; };" +
      "\n;globalThis.__cancelledCalls = cancelledCalls;",
    ctx,
    { filename: "sw.js" }
  );
  state.sandbox = sandbox;
  const raw = sandbox.__TOOLS;
  const tools = {};
  for (const [name, fn] of Object.entries(raw))
    tools[name] = (args, sid, ctx) => fn(args, sid === undefined ? "default" : sid, ctx);
  return tools;
}

const BODY_ID = 999;
const cssName = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const AX_IMPLICIT = { dialog: "dialog", iframe: "Iframe", button: "button", a: "link", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading" };
const AX_NAME_FROM_CONTENT = new Set(["button", "link", "heading"]);
function flatEls(page) {
  const out = (page.all || []).slice();
  const dive = (list) => {
    for (const e of list) {
      const sr = e && e.shadowRoot;
      if (!sr || !sr._all) continue;
      for (const x of sr._all) out.push(x);
      dive(sr._all);
    }
  };
  dive(page.all || []);
  return out;
}

function cdpDomMock(state, method, params = {}, page = state.page, sessTag = "") {
  if (!page || (!method.startsWith("DOM.") && !method.startsWith("Accessibility.") && !method.startsWith("CSS."))) {
    return undefined;
  }
  const all = page.all || [];
  const flat = flatEls(page);
  const BASE = 1000;
  const TEXT = 500000;
  const idOf = (el) => (el && el.__text ? TEXT + all.indexOf(el.__text) : BASE + flat.indexOf(el));
  const elOf = (id) => (id >= TEXT ? null : flat[id - BASE] || null);
  const textOf = (id) => (id >= TEXT ? all[id - TEXT] || null : null);
  state.cdpSearches = state.cdpSearches || new Map();

  switch (method) {
    case "DOM.enable":
    case "DOM.scrollIntoViewIfNeeded":
    case "DOM.discardSearchResults":
    case "Accessibility.enable":
    case "CSS.enable":
      return {};
    case "DOM.getDocument":
      return { root: { nodeId: 1, backendNodeId: 1, nodeName: "#document", nodeType: 9, documentURL: page.url } };
    case "DOM.querySelector": {
      const root = params.nodeId === 1 || params.nodeId == null ? null : elOf(params.nodeId);
      const pool = root ? all.filter((e) => e !== root && root.contains && root.contains(e)) : all;
      let hit = null;
      try {
        hit = pool.find((e) => matchesSel(e, params.selector)) || null;
      } catch {
        return { __cdpError: "DOMException: Failed to execute 'querySelector'" };
      }
      if (!hit && String(params.selector).trim() === "body") return { nodeId: BODY_ID };
      return { nodeId: hit ? idOf(hit) : 0 };
    }
    case "CSS.getComputedStyleForNode": {
      const el = params.nodeId === BODY_ID ? page.doc.body : elOf(params.nodeId);
      if (!el) return { __cdpError: "Could not find node with given id" };
      const st = styleOfMock(el);
      return { computedStyle: Object.entries(st).map(([k, v]) => ({ name: cssName(k), value: String(v) })) };
    }
    case "DOM.getTopLayerElements": {
      return { nodeIds: flat.filter((e) => e.__topLayer).map(idOf) };
    }
    case "DOM.getFrameOwner": {
      const f = (state.subFrames || []).find((x) => "F" + x.frameId === String(params.frameId));
      const host = f && f.hostEl;
      if (!host || flat.indexOf(host) < 0) return { __cdpError: "No frame owner for given id found" };
      return { backendNodeId: idOf(host), nodeId: idOf(host) };
    }
    case "Accessibility.getFullAXTree": {
      if (params.frameId) return { nodes: [] };
      const list = flat;
      const nodes = list.map((el, i) => {
        const st = styleOfMock(el);
        const tag = String(el.tagName || "").toLowerCase();
        const explicit = (el.getAttribute && el.getAttribute("role")) || "";
        const role = explicit || AX_IMPLICIT[tag] || "generic";
        const n = {
          nodeId: String(i + 1),
          ignored: st.display === "none" || st.visibility === "hidden",
          role: { value: role },
          name: { value: String((el.getAttribute && el.getAttribute("aria-label")) || (AX_NAME_FROM_CONTENT.has(role) ? el.innerText || "" : "")).trim() },
          backendDOMNodeId: idOf(el),
          childIds: (el._children || []).map((c) => String(list.indexOf(c) + 1)).filter((x) => x !== "0"),
        };
        if (role === "dialog" || role === "alertdialog") {
          const am = String((el.getAttribute && el.getAttribute("aria-modal")) || "").toLowerCase();
          const modal = el.__topLayer === true || am === "true";
          n.properties = [{ name: "modal", value: { type: "boolean", value: modal } }];
        }
        return n;
      });
      return { nodes };
    }
    case "DOM.performSearch": {
      const q = String(params.query || "");
      let hits = [];
      try {
        hits = flat.filter((e) => matchesSel(e, q));
      } catch {
        hits = [];
      }
      const byText = new Set();
      if (!hits.length) {
        const needle = q.toLowerCase();
        hits = all.filter((e) => {
          const bag = [e.innerText, e.value, e.placeholder, e.id, e.href, e.getAttribute && e.getAttribute("aria-label")]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const ok = needle && bag.includes(needle);
          if (ok && String(e.innerText || "").toLowerCase().includes(needle)) byText.add(e);
          return ok;
        });
      }
      const searchId = "s" + state.cdpSearches.size;
      state.cdpSearches.set(searchId, hits.map((e) => (byText.has(e) ? { __text: e } : e)));
      return { searchId, resultCount: hits.length };
    }
    case "DOM.getSearchResults": {
      const hits = state.cdpSearches.get(params.searchId) || [];
      return { nodeIds: hits.slice(params.fromIndex || 0, params.toIndex).map(idOf) };
    }
    case "DOM.describeNode": {
      const id =
        params.backendNodeId != null
          ? params.backendNodeId
          : params.nodeId != null
            ? params.nodeId
            : Number(String(params.objectId || "").slice(4));
      const owner = textOf(id);
      if (owner) return { node: { nodeId: id, backendNodeId: id, nodeName: "#text", nodeType: 3, nodeValue: owner.innerText } };
      const el = elOf(id);
      if (!el) return { __cdpError: "Could not find node with given id" };
      const attrs = [];
      for (const [k, v] of Object.entries(el._attrs || {})) attrs.push(k, String(v));
      for (const k of ["id", "type", "href", "placeholder", "role", "value", "name"]) {
        const v = el[k];
        if (v !== undefined && v !== null && v !== "" && !(k in (el._attrs || {}))) attrs.push(k, String(v));
      }
      if (el.disabled) attrs.push("disabled", "");
      const node = { nodeId: idOf(el), backendNodeId: idOf(el), nodeName: el.tagName, nodeType: 1, attributes: attrs };
      if (params.depth === -1 || Number(params.depth) > 1 || params.pierce) {
        node.children = flat
          .filter((x) => x !== el && el.contains && el.contains(x))
          .map((x) => ({ nodeId: idOf(x), backendNodeId: idOf(x), nodeName: x.tagName, nodeType: 1 }));
      }
      return { node };
    }
    case "DOM.getContentQuads": {
      if (state.quadsFail) return { __cdpError: String(state.quadsFail) };
      const el = elOf(params.backendNodeId) || textOf(params.backendNodeId);
      if (!el) return { __cdpError: "Could not find node with given id" };
      const st = styleOfMock(el);
      const r = rectOf(el);
      if (st.display === "none" || st.visibility === "hidden" || r.width < 1 || r.height < 1) return { quads: [] };
      return { quads: [[r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom]] };
    }
    case "DOM.getNodeForLocation": {
      const el = deepHitMock(page, params.x, params.y);
      if (!el) return { __cdpError: "No node found at given location" };
      return { backendNodeId: idOf(el), nodeId: idOf(el) };
    }
    case "DOM.resolveNode": {
      const el = elOf(params.backendNodeId) || textOf(params.backendNodeId);
      if (!el) return { __cdpError: "Could not find node with given id" };
      return { object: { objectId: "obj:" + params.backendNodeId + (sessTag ? "@" + sessTag : "") } };
    }
    case "DOM.requestNode": {
      const id = Number(String(params.objectId || "").replace(/@.*$/, "").slice(4));
      return elOf(id) || textOf(id) ? { nodeId: id } : { __cdpError: "No node with given id found" };
    }
    case "Accessibility.getPartialAXTree": {
      const el = elOf(params.backendNodeId);
      if (!el) return { __cdpError: "Could not find node with given id" };
      const tag = String(el.tagName || "").toLowerCase();
      const role =
        (el.getAttribute && el.getAttribute("role")) ||
        { dialog: "dialog", button: "button", a: "link", input: el.type === "checkbox" ? "checkbox" : "textbox", textarea: "textbox", select: "combobox" }[tag] ||
        "generic";
      const st = styleOfMock(el);
      const node = {
        nodeId: String(params.backendNodeId),
        childIds: (el._children || []).map((c) => String(idOf(c))),
        backendDOMNodeId: params.backendNodeId,
        ignored:
          st.display === "none" ||
          st.visibility === "hidden" ||
          String((el.getAttribute && el.getAttribute("aria-hidden")) || "").toLowerCase() === "true",
        role: { value: role },
        name: {
          value: String(
            role === "dialog" || role === "alertdialog"
              ? (el.getAttribute && el.getAttribute("aria-label")) || ""
              : (el.getAttribute && el.getAttribute("aria-label")) || el.innerText || el.placeholder || el.alt || ""
          ).trim(),
        },
      };
      if (role === "dialog" || role === "alertdialog") {
        const am = String((el.getAttribute && el.getAttribute("aria-modal")) || "").toLowerCase();
        node.properties = [{ name: "modal", value: { type: "boolean", value: el.__topLayer === true || am === "true" } }];
      }
      return { nodes: [node] };
    }
    case "Accessibility.getChildAXNodes": {
      const parent = elOf(Number(params.id));
      if (!parent) return { __cdpError: "Could not find node with given id" };
      const mk = (e) => {
        const st2 = styleOfMock(e);
        const tag2 = String(e.tagName || "").toLowerCase();
        const role2 = (e.getAttribute && e.getAttribute("role")) || AX_IMPLICIT[tag2] || "generic";
        return {
          nodeId: String(idOf(e)),
          backendDOMNodeId: idOf(e),
          ignored: st2.display === "none" || st2.visibility === "hidden",
          role: { value: role2 },
          name: { value: String((e.getAttribute && e.getAttribute("aria-label")) || (AX_NAME_FROM_CONTENT.has(role2) ? e.innerText || "" : "")).trim() },
          childIds: (e._children || []).map((c) => String(idOf(c))),
        };
      };
      return { nodes: (parent._children || []).map(mk) };
    }
    case "Accessibility.queryAXTree": {
      const rootEl = elOf(params.backendNodeId);
      if (!rootEl) return { __cdpError: "Could not find node with given id" };
      if (params.role !== "heading") return { nodes: [] };
      const hits = flat.filter((e) => {
        if (e === rootEl || !(rootEl.contains && rootEl.contains(e))) return false;
        const st = styleOfMock(e);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const tag = String(e.tagName || "").toLowerCase();
        return /^h[1-6]$/.test(tag) || (e.getAttribute && e.getAttribute("role")) === "heading";
      });
      return {
        nodes: hits.map((e) => ({
          backendDOMNodeId: idOf(e),
          role: { value: "heading" },
          name: { value: String((e.getAttribute && e.getAttribute("aria-label")) || e.innerText || "").trim() },
        })),
      };
    }
    default:
      return undefined;
  }
}

const clearSession = (st) => {
  st.storage = {};
};

function freshState(over = {}) {
  return {
    sent: [],
    attached: [],
    detached: [],
    cdp: [],
    tabUpdates: [],
    windowUpdates: [],
    userWindow: { id: 10, state: "normal", left: 0, top: 0, width: 1440, height: 900 },
    lastFocusedId: 10,
    created: [],
    removed: [],
    grouped: [],
    groups: [],
    groupUpdates: [],
    groupMoves: [],
    action: { icon: null, badge: null, badgeColor: null, title: null },
    ungrouped: [],
    runtimeReloads: [],
    nextTabId: 100,
    nextGroupId: 500,
    storage: {},
    localStorage: {},
    bodies: {},
    postDatas: {},
    tabs: [
      { id: 1, windowId: 10, title: "GitHub", url: "https://github.com/foo", active: true, status: "complete" },
      { id: 2, windowId: 10, title: "内部后台", url: "https://admin.corp.local/orders", active: false, status: "complete" },
      { id: 3, windowId: 11, title: "扩展管理", url: "chrome://extensions", active: false, status: "complete" },
      { id: 4, windowId: 11, title: "GitHub Issues", url: "https://github.com/bar/issues", active: false, status: "complete" },
    ],
    page: makePage([]),
    ...over,
  };
}

console.log("\n\x1b[1m扩展处理器（真实执行 sw.js）\x1b[0m");

{
  const st = freshState();
  loadSw(st);
  check("加载即向 native host 打招呼", st.sent.some((m) => m.type === "hello" && m.role === "extension"));
  {
    const hello = st.sent.find((m) => m.type === "hello" && m.role === "extension");
    check("hello 里带上这个 SW 实例的启动时刻", typeof hello?.bootedAt === "number" && Math.abs(Date.now() - hello.bootedAt) < 60000, JSON.stringify(hello));
  }
}

{
  const st = freshState();
  const T = loadSw(st);
  const all = await T.tabs_list({});
  check("tabs_list 列出全部标签页", all.count === 4);
  check("tabs_list 带回 tabId 和 URL", all.tabs[0].tabId === 1 && all.tabs[0].url.includes("github"));
  const hit = await T.tabs_list({ match: "admin.corp" });
  check("tabs_list 支持子串过滤", hit.count === 1 && hit.tabs[0].tabId === 2);
}

{
  const st = freshState();
  const T = loadSw(st);
  const r = await throws(() => T.click({ x: 1, y: 1 }), /本会话还没有目标标签页/);
  check("未接管时点击被拒绝", r.threw && r.match, r.msg);
  const r2 = await throws(() => T.read_page({}), /本会话还没有目标标签页/);
  check("未接管时读页面被拒绝", r2.threw && r2.match, r2.msg);
  check("报错顺带指出 navigate 会自己开页", /browser_navigate/.test(r2.msg), r2.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const r = await T.navigate({ url: "https://auto.example.com/x" }, "s1");
  check("零标签页时 navigate 自动开页", r.autoOpened === true && typeof r.tabId === "number", JSON.stringify(r).slice(0, 140));
  check("自动开的页进了本会话标签组", r.grouped === true);
  check("自动开页会说清发生了什么", /已经替你开了一页/.test(r.note || ""), r.note);
  check("自动开页确实导航到了目标地址", st.tabUpdates.some((u) => u.props?.url === "https://auto.example.com/x"));

  const st2 = freshState();
  const T2 = loadSw(st2);
  const back = await throws(() => T2.navigate({ action: "back" }, "s1"), /本会话还没有目标标签页/);
  check("零标签页时 action=back 照旧报错", back.threw && back.match, back.msg);

  const st3 = freshState();
  const T3 = loadSw(st3);
  await T3.new_tab({ url: "https://a.example.com" }, "s1");
  await T3.new_tab({ url: "https://b.example.com" }, "s1");
  const amb = await throws(() => T3.navigate({ url: "https://c.example.com" }, "s1"), /没说要操作哪一个/);
  check("持有多个标签页时 navigate 不自动开、照旧报错", amb.threw && amb.match, amb.msg);
}

{
  const st = freshState();
  const T = loadSw(st);

  const used = await T.tab_use({ takeover: true, tabId: 2 });
  check("tab_use 按 tabId 接管", used.tabId === 2 && used.url.includes("admin.corp"));
  check("tab_use 标注 title 来自页面", (used._fromPage || []).includes("title"), JSON.stringify(used._fromPage));
  check("我方写的 via / note 不在名单里", Array.isArray(used._fromPage) && !used._fromPage.includes("via") && !used._fromPage.includes("note"), JSON.stringify(used._fromPage));
  check("tab_use 会 attach 调试器", st.attached.includes(2));
  check("attach 用的是 CDP 1.3", st.cdpVersion === "1.3");
  check(
    "接管后开启了 Page/Runtime/Log/Network",
    ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].every((m) =>
      st.cdp.some((c) => c.method === m)
    )
  );

  const r1 = await throws(() => T.tab_use({ takeover: true, tabId: 3 }), /无法被调试器接管/);
  check("拒绝接管 chrome:// 页面", r1.threw && r1.match, r1.msg);

  const r2 = await throws(() => T.tab_use({ takeover: true, tabId: 999 }), /不存在/);
  check("接管不存在的标签页报错", r2.threw && r2.match, r2.msg);

  const r3 = await throws(() => T.tab_use({ takeover: true, match: "GitHub" }), /匹配到 2 个/);
  check("match 命中多个时拒绝并列出候选", r3.threw && r3.match, r3.msg);

  const one = await T.tab_use({ takeover: true, match: "admin.corp" });
  check("match 唯一命中时接管成功", one.tabId === 2);

  const r4 = await throws(() => T.tab_use({ takeover: true, tabId: 1, expectUrl: "gitlab.com" }), /与预期.*不符/);
  check("expectUrl 不符时拒绝（防 tabId 复用认错页）", r4.threw && r4.match, r4.msg);

  const r5 = await throws(() => T.tab_use({ takeover: true }), /需要 tabId 或 match/);
  check("既无 tabId 也无 match 时报错", r5.threw && r5.match, r5.msg);

}

{
  for (const v of ["false", "no", "yes", 1, {}]) {
    const st = freshState();
    const T = loadSw(st);
    const t = await throws(() => T.tab_use({ takeover: v, tabId: 2 }), /不要静默征用/);
    check(`takeover:${JSON.stringify(v)} 不算点头，照旧拦下`, t.threw && t.match, t.msg);
    check(`takeover:${JSON.stringify(v)} 时那张页没被 attach`, !st.attached.includes(2), JSON.stringify(st.attached));
  }
  const st = freshState();
  const T = loadSw(st);
  check("takeover:true 照常接管", (await T.tab_use({ takeover: true, tabId: 2 })).tabId === 2);
}

{
  const st = freshState();
  const T = loadSw(st);

  const BAD = /不打开本机文件|白名单|浏览器内部页面/;
  for (const [scheme, url] of [
    ["file", "file:///etc/passwd"],
    ["data", "data:text/html,<script>1</script>"],
    ["view-source", "view-source:https://example.com"],
    ["blob", "blob:https://example.com/abc"],
    ["filesystem", "filesystem:https://example.com/temporary/x"],
    ["javascript", "javascript:alert(1)"],
    ["chrome", "chrome://settings"],
    ["chrome-extension", "chrome-extension://abc/page.html"],
    ["about:config", "about:config"],
  ]) {
    const a = await throws(() => T.new_tab({ url }, "sNew"), BAD);
    check(`new_tab 拒绝 ${scheme}`, a.threw && a.match, a.msg);

    const stN = freshState();
    const TN = loadSw(stN);
    const held = await TN.new_tab({ url: "https://start.example.com" }, "sNav");
    const b = await throws(() => TN.navigate({ url, tabId: held.tabId }, "sNav"), BAD);
    check(`navigate 拒绝 ${scheme}`, b.threw && b.match, b.msg);
    check(
      `navigate 拒绝 ${scheme} 时没有真的导航过去`,
      !stN.tabUpdates.some((u) => String(u.props?.url || "").toLowerCase().includes(url.slice(0, 12).toLowerCase()))
    );
  }

  const f = await throws(() => T.new_tab({ url: "file:///etc/hosts" }, "s1"), /localhost/);
  check("file: 报错给出可照做的替代（本地服务）", f.threw && f.match, f.msg);

  for (const url of ["FILE:///etc/passwd", "  file:///etc/passwd  ", "FiLe:///etc/passwd"]) {
    const r = await throws(() => T.new_tab({ url }, "s1"), /不打开本机文件/);
    check(`new_tab 拒绝变形写法 ${JSON.stringify(url)}`, r.threw && r.match, r.msg);
  }

  for (const url of [
    "fi\tle:///etc/passwd",
    "fi\nle:///etc/passwd",
    "fi\rle:///etc/passwd",
    "file:/\t/\t/etc/passwd",
    "fil\u0000e:///etc/passwd",
    "java\tscript:alert(1)",
  ]) {
    const r = await throws(() => T.new_tab({ url }, "s1"), BAD);
    check(`new_tab 拒绝控制字符变体 ${JSON.stringify(url)}`, r.threw && r.match, r.msg);
  }

  const stAuto = freshState();
  const TAuto = loadSw(stAuto);
  const auto = await throws(() => TAuto.navigate({ url: "file:///etc/passwd" }, "sAuto"), /不打开本机文件/);
  check("零标签页时 navigate 自动开页也拒绝 file:", auto.threw && auto.match, auto.msg);
  check("被拒时没有留下半开的标签页", stAuto.tabs.every((t) => !String(t.url || "").startsWith("file:")));

  const ok1 = await T.new_tab({ url: "https://ok.example.com" }, "sOK");
  check("https 照常放行", typeof ok1.tabId === "number");
  const ok2 = await T.new_tab({ url: "http://localhost:3000/x" }, "sOK2");
  check("http://localhost 照常放行（本地开发要用）", typeof ok2.tabId === "number");
  const ok3 = await T.new_tab({}, "sOK3");
  check("不给 url 时开 about:blank 照常", typeof ok3.tabId === "number");
  const ok4 = await T.new_tab({ url: "about:blank" }, "sOK4");
  check("显式 about:blank 照常放行", typeof ok4.tabId === "number");
  const ok5 = await T.new_tab({ url: "example.com/path" }, "sOK5");
  check("没写协议的地址照常交给浏览器解析", typeof ok5.tabId === "number");
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.tab_use({ takeover: true, tabId: 2 });
  check("再接管一个不会 detach 掉上一个", !st.detached.includes(1), JSON.stringify(st.detached));
  check("两个标签页都还 attach 着", st.attached.includes(1) && st.attached.includes(2));

  const rel = await T.tab_release({ tabId: 1 });
  check("tab_release 能点名放开某一个", rel.released === true && rel.tabId === 1 && st.detached.includes(1));
  check("放开一个不影响另一个", !st.detached.includes(2) && rel.remaining === 1);

  const rel2 = await T.tab_release();
  check("只剩一个时 tab_release 不用点名", rel2.released === true && st.detached.includes(2));
  const r = await throws(() => T.read_page({}), /本会话还没有目标标签页/);
  check("release 之后操作重新被拒绝", r.threw && r.match, r.msg);
}

{
  const st = freshState();
  st.page = makePage(
    [
      el("button", { innerText: "提交订单" }),
      el("a", { innerText: "帮助", href: "https://example.com/help", box: [0, 50, 60, 20] }),
      el("input", { type: "text", value: "张三", placeholder: "姓名", box: [0, 80, 200, 30] }),
      el("input", { type: "password", value: "hunter2", placeholder: "密码", box: [0, 120, 200, 30] }),
      el("input", { type: "checkbox", checked: true, box: [0, 160, 20, 20] }),
      el("button", { innerText: "看不见的", style: { visibility: "hidden" } }),
      el("span", { innerText: "普通文字" }),
    ],
    { url: "https://shop.example.com/checkout", title: "结算", bodyText: "结算页正文" }
  );
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});

  check("read_page 返回 URL 和标题", snap.url.includes("checkout") && snap.title === "结算");
  check("read_page 返回正文", snap.text === "结算页正文");
  check("read_page 标注 text/title/elements 来自页面", Array.isArray(snap._fromPage) && ["text", "title", "elements"].every((k) => snap._fromPage.includes(k)), JSON.stringify(snap._fromPage));
  check("我方的 textHint 不在页面来源名单里", !snap._fromPage.includes("textHint") && !snap._fromPage.includes("url"), JSON.stringify(snap._fromPage));
  const names = snap.elements.map((e) => e.name);
  check("按钮的可访问名取自文本", names.includes("提交订单"));
  check("输入框的可访问名回退到 placeholder", names.includes("姓名"));
  check("跳过了不可见元素", !names.includes("看不见的"));
  check("跳过了 role=generic 的元素", !names.includes("普通文字"));
  check("链接带上了 href", snap.elements.some((e) => e.role === "link" && e.href?.includes("/help")));
  check("checkbox 带上了 checked", snap.elements.some((e) => e.role === "checkbox" && e.checked === true));
  check(
    "密码框的值不会外泄",
    !JSON.stringify(snap).includes("hunter2"),
    JSON.stringify(snap.elements.filter((e) => e.value))
  );
  check(
    "密码框仍报出「已填写」，不是当成空的",
    snap.elements.some((e) => e.name === "密码" && /已填写/.test(e.valueRedacted || "")),
    JSON.stringify(snap.elements.find((e) => e.name === "密码"))
  );
  check("元素带连续的 ref 句柄", snap.elements[0].ref === "ref_1" && snap.elements[1].ref === "ref_2");
  check("元素带视口坐标", Array.isArray(snap.elements[0].box) && snap.elements[0].box.length === 4);
}

{
  const st = freshState();
  st.page = makePage([
    el("input", { type: "text", value: "4111111111111111", placeholder: "卡号", attrs: { autocomplete: "cc-number" } }),
    el("input", { type: "text", value: "123", placeholder: "安全码", attrs: { autocomplete: "cc-csc" }, box: [0, 40, 60, 30] }),
    el("input", { type: "text", value: "888666", placeholder: "验证码", attrs: { autocomplete: "one-time-code" }, box: [0, 80, 80, 30] }),
    el("input", { type: "text", value: "北京市朝阳区", placeholder: "地址", attrs: { autocomplete: "street-address" }, box: [0, 120, 200, 30] }),
    el("input", { type: "hidden", value: "csrf-abc123", box: [0, 160, 1, 1] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const dump = JSON.stringify(snap);
  check("卡号不外泄", !dump.includes("4111111111111111"), dump.slice(0, 200));
  check("CVV 不外泄", !dump.includes("\"123\""), dump.slice(0, 200));
  check("短信验证码不外泄", !dump.includes("888666"), dump.slice(0, 200));
  check("普通地址照常给出来（别挡过头）", dump.includes("北京市朝阳区"), dump.slice(0, 200));
  check(
    "挡掉的字段仍看得出「填过了、多少字符」",
    /16 字符/.test(snap.elements.find((e) => e.name === "卡号")?.valueRedacted || ""),
    JSON.stringify(snap.elements.find((e) => e.name === "卡号"))
  );
}

console.log("\n\x1b[1m模态浮层识别\x1b[0m");

{
  const st = freshState();
  const modal = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "请选择你的偏好\n这一段是浮层正文，长得能证明标题不是拿前几十字凑的\n本地学生",
    box: [0, 0, 1200, 800],
    children: [
      el("h2", { innerText: "请选择你的偏好", box: [10, 10, 300, 30] }),
      el("button", { innerText: "本地学生", box: [10, 50, 100, 30] }),
    ],
  });
  st.page = makePage([el("button", { innerText: "页面上的普通按钮", box: [0, 900, 100, 30] }), modal], {
    bodyStyle: { overflow: "hidden", position: "fixed" },
  });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const d = snap.activeDialog;
  check("read_page 顶层给出 activeDialog", !!d, JSON.stringify(Object.keys(snap)));
  check("activeDialog 给的是 ref_b 句柄", /^ref_b\d+$/.test(d?.ref || ""), JSON.stringify(d?.ref));
  const clickDlg = await T.click({ ref: d.ref, force: true });
  check("拿这个 ref 真点得到那个浮层", clickDlg.at?.[0] === 600 && clickDlg.at?.[1] === 400 && /<div>/.test(clickDlg.clicked || ""), JSON.stringify([clickDlg.at, clickDlg.clicked]));
  check("标题取自浮层里的标题元素，不是整段正文", d?.title === "请选择你的偏好", JSON.stringify(d?.title));
  check("浮层标题标明来自页面", Array.isArray(d?._fromPage) && d._fromPage.includes("title"), JSON.stringify(d?._fromPage));
  check("我们自己写的 hint 不在页面来源名单里", !d._fromPage.includes("hint") && !!d.hint, JSON.stringify(d?._fromPage));
  check("判定依据一起报出来，而且是浏览器给的那条（AX modal）",
    d?.signals?.includes("role=dialog") && d?.signals?.some((s) => /AX modal=true/.test(s)) &&
    d.signals.some((s) => /盖住视口 100%/.test(s)), JSON.stringify(d?.signals));
  check("整页滚动被锁住也算一条依据", d?.signals?.some((s) => /整页滚动被锁住/.test(s)), JSON.stringify(d?.signals));
  check("aria-modal=true + 满屏 → 置信度高", d?.confidence === "高", d?.confidence);
  check("container 是能直接拿去 read_page 的那个值",
    d?.container === '[role="dialog"][aria-modal="true"]', JSON.stringify(d?.container));
  check("hint 里直接写出该怎么重读", /browser_read_page\(\{container:/.test(d?.hint || ""), d?.hint);
  const inside = await T.read_page({ container: d.container });
  check("照 activeDialog.container 重读真的只读到浮层子树",
    inside.elements.length === 2 && inside.elements.some((e) => e.name === "本地学生") &&
    !inside.elements.some((e) => e.name === "页面上的普通按钮"), JSON.stringify(inside.elements.map((e) => e.name)));
  check("container 模式下 activeDialog 照样在（正读着浮层不等于不用知道自己在模态里）",
    !!inside.activeDialog, JSON.stringify(Object.keys(inside)));
  const lite = await T.refresh_refs({});
  check("refresh_refs 也带 activeDialog", lite.activeDialog?.title === "请选择你的偏好", JSON.stringify(Object.keys(lite)));
  check("refresh_refs 仍然不带正文", !("text" in lite), JSON.stringify(Object.keys(lite)));
}

{
  const st = freshState();
  const banner = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "false", "aria-label": "Cookie 偏好" },
    innerText: "我们使用 Cookie",
    box: [0, 760, 1200, 40],
    children: [el("button", { innerText: "同意", box: [10, 765, 60, 30] })],
  });
  const st1 = st;
  st1.page = makePage([banner]);
  const T1 = loadSw(st1);
  await T1.tab_use({ takeover: true, tabId: 1 });
  const only = await T1.read_page({});
  check("光有 cookie 横幅时也报（宁可误报，不许漏报）", !!only.activeDialog, JSON.stringify(only.activeDialog));
  check("aria-modal=\"false\" 不算模态信号",
    !only.activeDialog?.signals?.includes("aria-modal=true"), JSON.stringify(only.activeDialog?.signals));
  check("只有 role=dialog + 占一小条 → 置信度低", only.activeDialog?.confidence === "低", only.activeDialog?.confidence);
  check("低置信度时提示改口风，点明可能只是横幅/客服浮窗",
    /cookie 横幅|订阅提示|客服浮窗/.test(only.activeDialog?.hint || ""), only.activeDialog?.hint);

  const st2 = freshState();
  st2.page = makePage([
    el("div", {
      role: "dialog",
      attrs: { "aria-modal": "false", "aria-label": "Cookie 偏好" },
      innerText: "我们使用 Cookie",
      box: [0, 760, 1200, 40],
    }),
    el("div", {
      role: "dialog",
      attrs: { "aria-modal": "true" },
      innerText: "登录",
      box: [0, 0, 1200, 800],
      children: [el("h2", { innerText: "登录", box: [10, 10, 100, 30] })],
    }),
  ], { bodyStyle: { overflow: "hidden", position: "fixed" } });
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const both = await T2.read_page({});
  check("真弹窗和横幅同时在时，拦路的那个赢", both.activeDialog?.title === "登录", JSON.stringify(both.activeDialog));
  check("落选的横幅不丢掉，进 others 供自行排除",
    both.activeDialog?.others?.some((o) => o.title === "Cookie 偏好"), JSON.stringify(both.activeDialog?.others));
  check("整页滚动锁只给第一名加权，不抬落选横幅的置信度",
    both.activeDialog?.others?.find((o) => o.title === "Cookie 偏好")?.confidence === "低",
    JSON.stringify(both.activeDialog?.others));
}

{
  const st = freshState();
  st.page = makePage([
    el("button", { innerText: "唯一的按钮", box: [0, 0, 100, 30] }),
    el("div", { role: "dialog", attrs: { "aria-modal": "true" }, innerText: "预渲染的登录框", box: [0, 0, 1200, 800], style: { display: "none" } }),
    el("div", { role: "alertdialog", innerText: "0 宽高的壳子", box: [0, 0, 0, 0] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("display:none 的浮层不报", !snap.activeDialog, JSON.stringify(snap.activeDialog));
}

{
  const st = freshState();
  const shown = el("dialog", {
    id: "shown-dlg",
    attrs: { open: "" },
    innerText: "提示",
    box: [400, 300, 400, 200],
    children: [el("h3", { innerText: "提示", box: [410, 310, 100, 20] })],
  });
  st.page = makePage([
    el("dialog", { id: "closed-dlg", innerText: "没开的对话框", box: [0, 0, 400, 200], style: { display: "none" } }),
    shown,
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d1 = (await T.read_page({})).activeDialog;
  check("<dialog> 的隐式角色也认得出（AX 给的是计算后的 role）", d1?.role === "dialog", JSON.stringify(d1));
  check("show() 开的不是模态，浏览器说 modal=false", !d1?.signals?.some((s) => /modal=true/.test(s)), JSON.stringify(d1?.signals));
  check("非模态 dialog 置信度不虚高", d1?.confidence === "低", d1?.confidence);
  check("没 open 属性的 <dialog> 不报（规范保证它 display:none）", d1?.title === "提示", JSON.stringify(d1));
  check("有 id 就优先用 id 当 container（比类名稳）", d1?.container === "#shown-dlg", d1?.container);

  shown.__topLayer = true;
  const d2 = (await T.read_page({})).activeDialog;
  check("showModal() 开的报「在顶层图层里」", d2?.signals?.some((s) => /顶层图层/.test(s)), JSON.stringify(d2?.signals));
  check("showModal() 开的浏览器判定为模态", d2?.signals?.some((s) => /AX modal=true/.test(s)), JSON.stringify(d2?.signals));
  check("于是置信度从低升到高", d2?.confidence === "高", d2?.confidence);
}

{
  const st = freshState();
  const inner = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "小盒子",
    box: [400, 300, 400, 200],
    children: [el("h2", { innerText: "小盒子", box: [410, 310, 80, 20] })],
  });
  st.page = makePage([
    el("div", { id: "wrap", innerText: "", box: [0, 0, 1200, 800], style: { position: "fixed" }, children: [inner] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d = (await T.read_page({})).activeDialog;
  check("只盖住 8% 视口也照样是高置信度（浏览器说它是模态）", d?.confidence === "高", JSON.stringify(d?.signals));
  check("覆盖面积如实报自己那个矩形，不替页面圆场",
    d?.signals?.some((s) => /盖住视口 8%/.test(s)), JSON.stringify(d?.signals));
}

{
  const st = freshState();
  st.page = makePage([
    el("div", { role: "dialog", innerText: "隐藏的同款", box: [0, 0, 1200, 800], style: { display: "none" } }),
    el("div", { role: "dialog", innerText: "真正开着的", box: [0, 0, 1200, 800], children: [el("h2", { innerText: "真正开着的", box: [10, 10, 100, 20] })] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d = (await T.read_page({})).activeDialog;
  check("认出的是可见那个", d?.title === "真正开着的", JSON.stringify(d));
  check("选择器会指到另一个浮层时干脆不给 container", d?.container === undefined, JSON.stringify(d?.container));
  check("没有 container 时提示改说别的路（find / 元素表里的 ref）",
    /browser_find/.test(d?.hint || "") && !/container:/.test(d?.hint || ""), d?.hint);
}

{
  const st = freshState();
  st.page = makePage([
    el("div", {
      id: "host",
      box: [0, 0, 10, 10],
      shadow: [
        el("div", {
          role: "dialog",
          attrs: { "aria-modal": "true" },
          innerText: "影子里的浮层",
          box: [0, 0, 1200, 800],
          children: [el("button", { innerText: "影子里的确认", box: [10, 10, 100, 30] })],
        }),
      ],
    }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d = (await T.read_page({})).activeDialog;
  check("shadow DOM 里的浮层也认得出（AX 树穿影子）", !!d, JSON.stringify(d));
  check("影子里的也拿得到浏览器的模态判定", d?.signals?.some((s) => /AX modal=true/.test(s)), JSON.stringify(d?.signals));
  check("影子里的浮层不给 container（document.querySelector 穿不进去）", d?.container === undefined, JSON.stringify(d?.container));
  check("提示说清 container 够不着、该用什么替代", /shadow DOM/.test(d?.hint || "") && /browser_find/.test(d?.hint || ""), d?.hint);
  check("提示里给出浮层自己的 ref 当退路", new RegExp(d.ref).test(d?.hint || ""), d?.hint);
}

{
  const st = freshState();
  const many = [];
  for (let i = 0; i < 260; i++) many.push(el("button", { innerText: "背景按钮 " + i, box: [0, i * 2, 60, 20] }));
  st.page = makePage([
    ...many,
    el("div", {
      id: "the-modal",
      role: "dialog",
      attrs: { "aria-modal": "true" },
      innerText: "结算确认",
      box: [0, 0, 1200, 800],
      children: [el("button", { innerText: "确认支付", box: [10, 10, 100, 30] })],
    }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("前提：浮层里的按钮真的被挤出了元素表",
    snap.elementsTruncated && !snap.elements.some((e) => e.name === "确认支付"), String(snap.elementsTotal));
  check("截断提示里直接给出这一页现成的 container",
    /container:"#the-modal"/.test(snap.truncatedHint || ""), snap.truncatedHint);
  check("浮层照样有句柄（元素表上限碰不到 ref_b）", /^ref_b\d+$/.test(snap.activeDialog?.ref || ""), JSON.stringify(snap.activeDialog?.ref));
  const hitModal = await T.click({ ref: snap.activeDialog.ref, force: true });
  check("而且真点得到它", hitModal.at?.[0] === 600 && hitModal.at?.[1] === 400 && /<div>/.test(hitModal.clicked || ""), JSON.stringify([hitModal.at, hitModal.clicked]));
}

{
  const st = freshState();
  const modal = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "订阅提醒",
    box: [0, 0, 1200, 800],
    style: { display: "none" },
    children: [el("h2", { innerText: "订阅提醒", box: [10, 10, 100, 20] })],
  });
  const opener = el("button", { innerText: "打开浮层", box: [0, 100, 100, 30] });
  st.page = makePage([opener, modal]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("点之前没有 activeDialog（基线）", !snap.activeDialog, JSON.stringify(snap.activeDialog));
  opener.addEventListener("click", () => {
    modal._style.display = "block";
  });
  const c = await T.click({ ref: "ref_1" });
  check("click 返回里标出「刚冒出来一个弹窗」", c.dialogAppeared === true, JSON.stringify(c));
  check("click 返回里一并给出 activeDialog（ref/标题/container 都在）",
    c.activeDialog?.title === "订阅提醒" && !!c.activeDialog?.container, JSON.stringify(c.activeDialog));

  const c2 = await T.click({ ref: c.activeDialog.ref });
  check("已经开着的弹窗不再报 dialogAppeared", c2.dialogAppeared === undefined, JSON.stringify(c2));
  check("但 activeDialog 照常给（它确实还挡着）", !!c2.activeDialog, JSON.stringify(c2.activeDialog));

  modal.addEventListener("click", () => {
    modal._style.display = "none";
  });
  const c3 = await T.click({ ref: c.activeDialog.ref });
  check("把弹窗关掉的那一下报 dialogDismissed", /关掉/.test(c3.dialogDismissed || ""), JSON.stringify(c3));
  check("关掉之后不再报 activeDialog", !c3.activeDialog, JSON.stringify(c3.activeDialog));

  check("click 标注 clicked 来自页面", (c._fromPage || []).includes("clicked"), JSON.stringify(c._fromPage));
  check("有浮层时 activeDialog 也进清单", (c._fromPage || []).includes("activeDialog"), JSON.stringify(c._fromPage));
  check("没浮层时不列 activeDialog（清单只列真有的字段）", Array.isArray(c3._fromPage) && !c3._fromPage.includes("activeDialog"), JSON.stringify(c3._fromPage));
  check("我方写的 at / dialogDismissed 不在页面来源名单里", !(c3._fromPage || []).includes("at") && !(c3._fromPage || []).includes("dialogDismissed"), JSON.stringify(c3._fromPage));
}

{
  const st = freshState();
  const decoy = el("button", { innerText: "主页面上同号的诱饵按钮", box: [0, 0, 100, 30] });
  const host = el("iframe", { attrs: { id: "consent" }, box: [0, 0, 600, 400] });
  st.page = makePage([decoy, host]);
  const frameDlg = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "跨进程的同意浮层",
    box: [0, 0, 1200, 800],
    children: [el("h2", { innerText: "跨进程的同意浮层", box: [10, 10, 300, 30] })],
  });
  st.subFrames = [
    { frameId: 7, page: makePage([frameDlg]), oopif: true, url: "https://consent.example.com/banner", hostEl: host },
  ];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const d = snap.activeDialog;
  check("跨进程 iframe 里的浮层扫得到（以前这一整类是漏报）", !!d, JSON.stringify(Object.keys(snap)));
  check("ref 带着帧标识（ref_b…@t…），不是裸 backendNodeId", /^ref_b\d+@tF7$/.test(d?.ref || ""), JSON.stringify(d?.ref));
  check("标题取自帧内那个 <h2>", d?.title === "跨进程的同意浮层", JSON.stringify(d?.title));
  check("signals 点明它在跨进程 iframe 里",
    (d?.signals || []).some((s) => /跨进程 iframe（OOPIF）里/.test(s)), JSON.stringify(d?.signals));
  check("不给 container（给了就会指错）", d?.container === undefined, JSON.stringify(d?.container));
  check("hint 指元素表，并明说 browser_find 够不着",
    /元素表/.test(d?.hint || "") && /browser_find 都够不着/.test(d?.hint || ""), d?.hint);

  st.cdp.length = 0;
  const hit = await T.click({ ref: d.ref, force: true });
  const dlgMouse = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent");
  check("拿这个 ref 点到的是帧里那个浮层，不是主页面上同号的诱饵",
    dlgMouse.length > 0 && dlgMouse.every((c) => c.sessionId === "sess-7") && /@tF7/.test(hit.clicked || ""),
    JSON.stringify([dlgMouse.map((c) => c.sessionId), hit.clicked]));
  check("返回里说明坐标是帧内坐标（别被当成顶层坐标）", /OOPIF/.test(hit.coordSpace || ""), JSON.stringify(hit.coordSpace));

  check("覆盖面积按宿主 iframe 在顶层视口里的矩形算（25%，不是帧内那个 100%）",
    (d?.signals || []).some((s) => /盖住视口 25%/.test(s)), JSON.stringify(d?.signals));

  const gone = await throws(() => T.click({ ref: "ref_b1000@tF999" }), /跨进程 iframe/);
  check("帧标识对不上时报错，不退回标签页会话解析", gone.threw && gone.match, gone.msg);
  check("报错说清下一步（重新读页面拿新句柄）", /read_page/.test(gone.msg), gone.msg);
}

{
  const st = freshState();
  const decoyInput = el("input", { attrs: { id: "decoy" }, value: "主页面的诱饵输入框", box: [0, 40, 200, 30] });
  const host = el("iframe", { attrs: { id: "pay" }, box: [0, 0, 600, 400] });
  st.page = makePage([el("h1", { innerText: "结账", box: [0, 0, 100, 30] }), decoyInput, host]);
  const frameInput = el("input", { attrs: { id: "card" }, value: "", box: [10, 40, 200, 30] });
  st.subFrames = [
    {
      frameId: 7,
      page: makePage([el("h2", { innerText: "跨进程支付框", box: [0, 0, 200, 30] }), frameInput]),
      oopif: true,
      url: "https://pay.example.com/",
      hostEl: host,
    },
  ];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  const r = await T.set_value({ ref: "ref_b1001@tF7", value: "4111111111111111", force: true });
  check("browser_set 认带 @t 的句柄（认成文本控件）", r.kind === "text", JSON.stringify(r));
  const onSess = (m) => st.cdp.filter((c) => c.method === m && c.sessionId === "sess-7").length;
  const onTab = (m) => st.cdp.filter((c) => c.method === m && !c.sessionId).length;
  check("insertText 发到了那一帧的会话上", onSess("Input.insertText") === 1, JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText").map((c) => c.sessionId)));
  check("insertText 一次都没发到标签页会话（发错就是往主页面同号控件里打字）",
    onTab("Input.insertText") === 0, JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText").map((c) => c.sessionId)));
  check("全选那两下按键也发在同一条会话上", onSess("Input.dispatchKeyEvent") >= 2 && onTab("Input.dispatchKeyEvent") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.sessionId)));
  check("点进输入框那一下也发在同一条会话上", onSess("Input.dispatchMouseEvent") >= 1 && onTab("Input.dispatchMouseEvent") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.sessionId)));
  check("回读读的是帧里那个控件（不是主页面同号的诱饵）",
    r.readBack !== "主页面的诱饵输入框", JSON.stringify(r.readBack));
  check("诱饵输入框一个字都没动", decoyInput.value === "主页面的诱饵输入框", JSON.stringify(decoyInput.value));

  st.cdp.length = 0;
  const t = await T.type_text({ ref: "ref_b1001@tF7", text: "追加", clear: true, force: true });
  check("browser_type 也认带 @t 的句柄", /追加/.test(t.typed || ""), JSON.stringify(t));
  check("browser_type 的 insertText 同样发在那一帧的会话上",
    onSess("Input.insertText") === 1 && onTab("Input.insertText") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText").map((c) => c.sessionId)));
  check("browser_type 的 clear（全选）也发在那一帧的会话上",
    onSess("Input.dispatchKeyEvent") >= 2 && onTab("Input.dispatchKeyEvent") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.sessionId)));

  st.cdp.length = 0;
  const pk = await T.press_key({ key: "Enter", ref: "ref_b1001@tF7", force: true });
  check("browser_press_key 也认带 @t 的句柄，并说出聚焦到了谁", /^ref_b1001@tF7 </.test(pk.focused || ""), JSON.stringify(pk));
  check("按键发在那一帧的会话上（不是标签页会话）",
    onSess("Input.dispatchKeyEvent") === 2 && onTab("Input.dispatchKeyEvent") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.sessionId)));
  check("聚焦那一下也发在同一条会话上", onSess("Input.dispatchMouseEvent") >= 1 && onTab("Input.dispatchMouseEvent") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.sessionId)));
}

{
  const st = freshState();
  const bigHost = el("iframe", { attrs: { id: "consent" }, box: [0, 0, 1200, 800] });
  const smallHost = el("iframe", { attrs: { id: "widget" }, box: [1000, 700, 200, 100] });
  st.page = makePage([bigHost, smallHost]);
  const mk = (title) =>
    makePage([
      el("div", {
        role: "dialog",
        attrs: { "aria-modal": "true" },
        innerText: title,
        box: [0, 0, 1200, 800],
        children: [el("h2", { innerText: title, box: [10, 10, 300, 30] })],
      }),
    ]);
  st.subFrames = [
    { frameId: 7, page: mk("跨进程的同意浮层"), oopif: true, url: "https://consent.example.com/", hostEl: bigHost },
    { frameId: 8, page: mk("跨进程的客服浮窗"), oopif: true, url: "https://chat.example.com/", hostEl: smallHost },
  ];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d = (await T.read_page({})).activeDialog;
  check("铺满视口的那个当选 active", d?.title === "跨进程的同意浮层", JSON.stringify(d?.title));
  check("角落里那个小浮窗落到 others", (d?.others || []).some((o) => o.title === "跨进程的客服浮窗"),
    JSON.stringify((d?.others || []).map((o) => o.title)));
  check("others 里那个也带着自己的帧标识", /@tF8$/.test((d?.others || [])[0]?.ref || ""),
    JSON.stringify((d?.others || [])[0]?.ref));
}

{
  const st = freshState();
  const outerHost = el("iframe", { attrs: { id: "outer" }, box: [0, 0, 600, 400] });
  st.page = makePage([el("h1", { innerText: "顶层", box: [0, 0, 100, 30] }), outerHost]);
  const innerHost = el("iframe", { attrs: { id: "inner" }, box: [0, 0, 300, 200] });
  const deepDlg = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "套两层的浮层",
    box: [0, 0, 300, 200],
    children: [el("h2", { innerText: "套两层的浮层", box: [5, 5, 200, 30] })],
  });
  st.subFrames = [
    { frameId: 7, page: makePage([innerHost]), oopif: true, url: "https://outer.example.com/", hostEl: outerHost },
    { frameId: 8, page: makePage([deepDlg]), oopif: true, under: 7, url: "https://inner.example.com/", hostEl: innerHost },
  ];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const d = (await T.read_page({})).activeDialog;
  check("套两层的跨进程帧里的浮层照样报得出来（不许静默丢掉）", d?.title === "套两层的浮层", JSON.stringify(d?.title));
  check("它的句柄指的是最里面那一层的会话", /@tF8$/.test(d?.ref || ""), JSON.stringify(d?.ref));
  check("量不出宿主矩形时就不报面积，而不是判成不可见",
    !(d?.signals || []).some((s) => /盖住视口/.test(s)), JSON.stringify(d?.signals));
  check("照样报得出浏览器的模态判定", (d?.signals || []).some((s) => /AX modal=true/.test(s)), JSON.stringify(d?.signals));
}

{
  const st = freshState();
  st.page = makePage([
    el("div", {
      role: "dialog",
      attrs: { "aria-modal": "true" },
      innerText: "主文档里的浮层",
      box: [0, 0, 1200, 800],
      children: [el("h2", { innerText: "主文档里的浮层", box: [10, 10, 200, 30] })],
    }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  const d = (await T.read_page({})).activeDialog;
  check("主文档的浮层照常扫到", d?.title === "主文档里的浮层", JSON.stringify(d?.title));
  check("页面上没有 iframe 时不发 Target.setAutoAttach（省掉整趟 OOPIF 探测）",
    !st.cdp.some((c) => c.method === "Target.setAutoAttach"),
    JSON.stringify(st.cdp.map((c) => c.method).filter((m) => /Target\./.test(m))));
}

{
  const st = freshState();
  const host = el("iframe", { attrs: { id: "f" }, box: [0, 0, 400, 300] });
  st.page = makePage([host]);
  st.subFrames = [{ frameId: 7, page: makePage([el("button", { innerText: "帧里没有浮层", box: [0, 0, 80, 20] })]), oopif: true, url: "https://x.example.com/", hostEl: host }];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  const snap = await T.read_page({});
  check("页面上有 iframe 时会去探 OOPIF（发了 Target.setAutoAttach）",
    st.cdp.some((c) => c.method === "Target.setAutoAttach" && c.params?.autoAttach === true),
    JSON.stringify(st.cdp.map((c) => c.method).filter((m) => /Target\./.test(m))));
  check("探过之后又关掉，不把子会话一直挂着",
    st.cdp.some((c) => c.method === "Target.setAutoAttach" && c.params?.autoAttach === false),
    JSON.stringify(st.cdp.filter((c) => c.method === "Target.setAutoAttach").map((c) => c.params?.autoAttach)));
  check("帧里没有浮层时不硬报一个（能力补上了也不能变成误报机）",
    !("activeDialog" in snap), JSON.stringify(snap.activeDialog));
}

{
  const st = freshState();
  const modal = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "一直开着的浮层",
    box: [0, 0, 1200, 800],
    children: [el("h2", { innerText: "一直开着的浮层", box: [10, 10, 200, 30] })],
  });
  const btn = el("button", { innerText: "普通按钮", box: [0, 700, 100, 30] });
  st.page = makePage([modal, btn]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  await st.sandbox.__persist();
  const key = Object.keys(st.storage).find((k) => st.storage[k] && st.storage[k].dialogSeen);
  const rec = st.storage[key];
  check("前提：基线真的落盘了", Array.isArray(rec.dialogSeen) && rec.dialogSeen.length === 1, JSON.stringify(rec.dialogSeen));
  rec.dialogSeen = rec.dialogSeen.map(([tab, v]) => [tab, { ...v, ids: v.ids.map((s) => Number(String(s).replace(/^ref_b/, ""))) }]);
  const T2 = loadSw(st);
  await st.sandbox.__restore();
  const c = await T2.click({ ref: "ref_2" });
  check("读到 0.26.x 的裸数字基线时不误报 dialogAppeared", c.dialogAppeared === undefined, JSON.stringify(c));
  check("浮层确实还在，activeDialog 照常给", !!c.activeDialog, JSON.stringify(c.activeDialog?.title));
}

{
  const st = freshState();
  const modal = el("div", {
    role: "dialog",
    attrs: { "aria-modal": "true" },
    innerText: "已经开着的浮层",
    box: [0, 0, 1200, 800],
    children: [el("h2", { innerText: "已经开着的浮层", box: [10, 10, 200, 30] })],
  });
  st.page = makePage([el("button", { innerText: "随便点", box: [0, 810, 100, 30] }), modal]);
  const T1 = loadSw(st);
  await T1.tab_use({ takeover: true, tabId: 1 });
  const first = await T1.read_page({});
  check("前提：起手就看得见这个浮层", !!first.activeDialog, JSON.stringify(first.activeDialog));
  await st.sandbox.__persist();

  const T2 = loadSw(st);
  await st.sandbox.__restore();
  const after = await T2.click({ ref: first.activeDialog.ref, force: true });
  check("SW 回收之后不把早就开着的浮层报成「刚冒出来」", after.dialogAppeared === undefined, JSON.stringify(after));
  check("但照样报 activeDialog（它确实还挡着）", !!after.activeDialog, JSON.stringify(after.activeDialog));
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "普通按钮", box: [0, 0, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("没浮层时 read_page 不出现 activeDialog 字段", !("activeDialog" in snap), JSON.stringify(Object.keys(snap)));
  const c = await T.click({ ref: "ref_1" });
  check("没浮层时 click 不出现任何浮层字段",
    !("activeDialog" in c) && !("dialogAppeared" in c) && !("dialogDismissed" in c), JSON.stringify(Object.keys(c)));
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "更多", box: [100, 200, 80, 40] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;

  const h = await T.hover({ ref: "ref_1", settleMs: 0 });
  const moves = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent");
  check("hover 移到了元素中心", h.at[0] === 140 && h.at[1] === 220, JSON.stringify(h.at));
  check("hover 只发 mouseMoved，不按下", moves.length > 0 && moves.every((m) => m.params.type === "mouseMoved"), JSON.stringify(moves.map((m) => m.params.type)));
  check("hover 先从别处移过来（mouseenter 要有位置变化）", moves.length === 2 && moves[0].params.x === 0, JSON.stringify(moves.map((m) => [m.params.x, m.params.y])));
  check("hover 说清悬停在什么上面", /更多/.test(h.hovered || ""), h.hovered);
  check("hover 正常时不返回任何静态说明（那些归工具描述）", !("hint" in h), JSON.stringify(Object.keys(h)));

  const both = await throws(() => T.hover({ ref: "ref_1", x: 1, y: 2 }), /只能给一个/);
  check("hover 同样拒绝多种寻址方式并给", both.threw && both.match, both.msg);
  check("hover 的报错文案说的是「悬停」", /什么都没悬停/.test(both.msg), both.msg);
  const none = await throws(() => T.hover({}), /需要 ref 或 x\/y 或 selector/);
  check("hover 什么都不给时报错", none.threw && none.match, none.msg);
}

{
  const st = freshState();
  st.page = makePage(
    [
      el("button", { innerText: "提交订单" }),
      el("button", { innerText: "提交订单并继续购物", box: [0, 40, 200, 30] }),
      el("button", { innerText: "取消", box: [0, 80, 60, 30] }),
      el("a", { innerText: "帮助中心", href: "https://example.com/submit-help", box: [0, 120, 80, 20] }),
      el("input", { type: "text", placeholder: "搜索商品", box: [0, 160, 200, 30] }),
      el("button", { innerText: "已停用", disabled: true, box: [0, 200, 80, 30] }),
    ],
    { url: "https://shop.example.com/cart", title: "购物车" }
  );
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const r = await T.find({ query: "提交订单" });
  check("find 找得到目标", r.matches.length >= 2 && r.matched >= 2, JSON.stringify(r.matches.map((m) => m.name)));
  check("完全相同的排在包含它的前面", r.matches[0].name === "提交订单", JSON.stringify(r.matches.map((m) => m.name)));
  check("命中的元素带 CDP 句柄，可以直接拿去点", /^ref_b\d+$/.test(r.matches[0].ref || ""), r.matches[0].ref);
  check("find 说清是按什么匹配上的", /名字完全相同/.test(r.matches[0].matchedBy || ""), r.matches[0].matchedBy);
  check("不相干的元素不进结果", !r.matches.some((m) => m.name === "取消"), JSON.stringify(r.matches.map((m) => m.name)));
  const cl = await T.click({ ref: r.matches[0].ref });
  check("find 给的 ref 真的点得动", /提交订单/.test(cl.clicked || ""), cl.clicked);

  const byRole = await T.find({ role: "textbox" });
  check("只给 role 也能找", byRole.matches.length === 1 && byRole.matches[0].name === "搜索商品", JSON.stringify(byRole.matches));
  const roleFiltered = await T.find({ query: "提交", role: "link" });
  check("role 能把同名的别的东西滤掉", roleFiltered.matches.every((m) => m.role === "link"), JSON.stringify(roleFiltered.matches.map((m) => m.role)));
  check("按 href 命中的也找得到", roleFiltered.matches.some((m) => (m.href || "").includes("submit-help")), JSON.stringify(roleFiltered.matches));

  const miss = await T.find({ query: "页面底部那个蓝色的结算按钮" });
  check("匹配不上时不回空数组了事", miss.matched === 0 && !!miss.note, JSON.stringify(miss).slice(0, 160));
  check("匹配不上时说清它是文字匹配不是自然语言", /文字匹配|真实出现的字样/.test(miss.note || ""), miss.note);

  const noArg = await throws(() => T.find({}), /query.*或.*role/);
  check("query 和 role 都不给时报错", noArg.threw && noArg.match, noArg.msg);

  const many = freshState();
  const rows = [];
  for (let i = 0; i < 260; i++) rows.push(el("button", { innerText: `行 ${i}`, box: [0, i * 10, 50, 8] }));
  rows.push(el("button", { innerText: "应用筛选", box: [0, 3000, 80, 30] }));
  many.page = makePage(rows, { url: "https://long.example.com" });
  const T2 = loadSw(many);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const snap = await T2.read_page({});
  check("前提：目标确实超出了 read_page 的默认上限", snap.elementsTruncated && !snap.elements.some((e) => e.name === "应用筛选"));
  const deep = await T2.find({ query: "应用筛选" });
  check("find 够得到 read_page 上限之外的元素", deep.matches[0]?.name === "应用筛选", JSON.stringify(deep.matches.slice(0, 2)));
  check("find 报出全页搜到几处", deep.searchHits >= 1, String(deep.searchHits));
  check("find 不再受 read_page 的元素表上限约束", !("scanTruncated" in deep), JSON.stringify(Object.keys(deep)));

  many.quadsFail = "Could not find object with given id";
  let quadErr = null;
  try {
    await T2.find({ query: "应用筛选" });
  } catch (e) {
    quadErr = String(e?.message || e);
  }
  many.quadsFail = null;
  check("候选全因为量矩形报错被丢掉时：报错，不说「一个都没匹配上」", !!quadErr && !/一个都没匹配上/.test(quadErr), String(quadErr));
  check("报错点名了原因（别的扩展 / 调试器断过）和出路", /别的扩展|调试器/.test(quadErr || "") && /重试/.test(quadErr || ""), String(quadErr));
  check("报错明说不是查询词的问题", /不是查询词的问题/.test(quadErr || ""), String(quadErr));
  const back = await T2.find({ query: "应用筛选" });
  check("开关关掉之后 find 照常干活", back.matches?.[0]?.name === "应用筛选", JSON.stringify(back.matches?.slice(0, 2)));
}

{
  const st = freshState();
  st.page = makePage(
    [
      el("textarea", { role: "combobox", attrs: { "aria-label": "Search" }, box: [0, 0, 300, 40] }),
      el("button", { innerText: "Search 设置", box: [0, 50, 100, 30] }),
      el("div", { innerText: "Search 的说明文字一大段", box: [0, 90, 300, 20] }),
    ],
    { url: "https://google.example.com/" }
  );
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const r = await T.find({ query: "Search", role: "textbox" });
  check("role 对不上但功能等价的元素不再被抹掉", r.matched >= 1 && r.matches[0]?.tag === "textarea", JSON.stringify(r.matches));
  check("降级带显式标记，不静默", r.roleFallback === true, JSON.stringify(r));
  check("roleHint 报出实际 role 让调用方能改筛", /combobox/.test(r.roleHint || ""), r.roleHint);
  check("条目上标注实际 role 和要的 role", /combobox/.test(r.matches[0]?.matchedBy || "") && /textbox/.test(r.matches[0]?.matchedBy || ""), r.matches[0]?.matchedBy);
  check("功能等价命中时，role 无关的文字命中不跟进来凑数", !r.matches.some((m) => m.tag === "div" || m.tag === "button"), JSON.stringify(r.matches.map((m) => m.tag)));

  const ro = await T.find({ role: "textbox" });
  check("role-only 也走功能等价降级", ro.matched === 1 && ro.matches[0].tag === "textarea" && ro.roleFallback === true, JSON.stringify(ro));
  check("role-only 降级说清功能归类和实际 role", /textbox/.test(ro.matches[0].matchedBy || "") && /combobox/.test(ro.matches[0].matchedBy || ""), ro.matches[0].matchedBy);

  const st2 = freshState();
  st2.page = makePage(
    [
      el("textarea", { role: "combobox", attrs: { "aria-label": "站内 Search" }, box: [0, 0, 300, 40] }),
      el("input", { type: "text", attrs: { "aria-label": "Search 关键词" }, box: [0, 50, 200, 30] }),
    ],
    { url: "https://exact.example.com/" }
  );
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const ex = await T2.find({ query: "Search", role: "textbox" });
  check("有精确命中时不带降级标记", !ex.roleFallback && !ex.roleHint, JSON.stringify(ex));
  check("精确命中的排在功能等价的前面", ex.matches[0]?.tag === "input", JSON.stringify(ex.matches.map((m) => m.tag)));
  check("功能等价的仍然保留在后面（精确的可能不是目标）", ex.matches.some((m) => m.tag === "textarea"), JSON.stringify(ex.matches.map((m) => m.tag)));

  const st3 = freshState();
  st3.page = makePage(
    [
      el("a", { innerText: "导出报表", href: "https://x.example.com/export", box: [0, 0, 100, 20] }),
      el("div", { innerText: "报表说明", box: [0, 30, 200, 20] }),
    ],
    { url: "https://links.example.com/" }
  );
  const T3 = loadSw(st3);
  await T3.tab_use({ takeover: true, tabId: 1 });
  const fb = await T3.find({ query: "导出报表", role: "button" });
  check("role 猜错但名字强命中时兜底返回", fb.matched === 1 && fb.matches[0].tag === "a", JSON.stringify(fb.matches));
  check("兜底带降级标记和实际 role", fb.roleFallback === true && /link/.test(fb.roleHint || ""), JSON.stringify({ f: fb.roleFallback, h: fb.roleHint }));

  const miss = await T3.find({ query: "export", role: "button" });
  check("弱命中不进兜底，role 保住过滤价值", miss.matched === 0, JSON.stringify(miss.matches));
  check("空结果的 note 报出查询命中者的实际 role", /link/.test(miss.note || ""), miss.note);

  const none = await T3.find({ query: "根本不存在的字样", role: "button" });
  check("完全无候选时不带降级标记", none.matched === 0 && !none.roleFallback, JSON.stringify(none));
}

{
  const st = freshState();
  st.page = makePage([
    el("button", { id: "ok", innerText: "可以点的", box: [10, 10, 100, 30] }),
    el("button", { id: "hid", innerText: "隐藏的", box: [10, 60, 100, 30], style: { display: "none" } }),
    el("button", { id: "under", innerText: "被压住的", box: [10, 110, 100, 30] }),
    el("div", { id: "cover", innerText: "遮罩", box: [0, 100, 400, 60], role: "presentation" }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const ok = await T.find({ query: "可以点的" });
  check("文本命中要换成承载它的元素，不能把 #text 交出去", ok.matches[0].tag === "button", JSON.stringify(ok.matches[0]));
  const ref = ok.matches[0].ref;
  check("find 用 CDP 全页搜索拿到候选", /^ref_b\d+$/.test(ref), JSON.stringify(ok.matches));
  check("find 结果带真实 role 和可访问名", ok.matches[0].role === "button" && ok.matches[0].name === "可以点的", JSON.stringify(ok.matches[0]));
  check("find 结果带顶层视口坐标", JSON.stringify(ok.matches[0].box) === JSON.stringify([10, 10, 100, 30]), JSON.stringify(ok.matches[0].box));

  st.cdp.length = 0;
  const c = await T.click({ ref });
  check("ref_b 点击落在元素中心", c.at[0] === 60 && c.at[1] === 25, JSON.stringify(c.at));
  check("ref_b 点击走的是 CDP 路", c.via === "cdp", JSON.stringify(c));
  check("ref_b 点击也验了命中", c.verified === "hit", JSON.stringify(c));
  check("ref_b 点击说清点了什么", /可以点的/.test(c.clicked || ""), c.clicked);
  const mouse = st.cdp.filter((x) => x.method === "Input.dispatchMouseEvent").map((x) => x.params.type);
  check("下发的仍是完整的可信事件序列", JSON.stringify(mouse) === JSON.stringify(["mouseMoved", "mousePressed", "mouseReleased"]), JSON.stringify(mouse));
  check("全程没有 chrome.scripting 注入", (st.executed || []).length === 0, JSON.stringify((st.executed || []).length));

  const curEv = st.cdp.filter((x) => x.method === "Runtime.evaluate" && /__aicCursor/.test(x.params?.expression || ""));
  const shown = (st.cursorCalls || []).filter((c) => c.op === "show");
  check("点击顺带把操作光标画到了点击坐标上", shown.some((c) => c.arg.x === 60 && c.arg.y === 25), JSON.stringify(shown));
  check("光标也走 CDP，不新增 chrome.scripting 注入", (st.executed || []).length === 0);
  check("光标的求值按值取回（不留 RemoteObject 句柄）", curEv.every((x) => x.params.returnByValue === true), JSON.stringify(curEv.map((x) => x.params.returnByValue)));
  const firstMouse = st.cdp.findIndex((x) => x.method === "Input.dispatchMouseEvent");
  const firstCursor = st.cdp.findIndex((x) => /__aicCursor/.test(x.params?.expression || ""));
  check("光标先画、再下发点击", firstCursor >= 0 && firstCursor < firstMouse, `cursor@${firstCursor} mouse@${firstMouse}`);
  check(
    "动作时只发短调用，不重发整份实现",
    curEv.every((x) => x.params.expression.length < 300),
    JSON.stringify(curEv.map((x) => x.params.expression.length))
  );

  const hidFind = await T.find({ query: "隐藏的" });
  check("不可见的元素不进 find 结果", !hidFind.matches.some((m) => m.name === "隐藏的"), JSON.stringify(hidFind.matches));
  const hidClick = await throws(() => T.click({ ref: "ref_b" + (st.page.all.indexOf(st.page.all.find((e) => e.id === "hid")) + 1000) }), /不可操作（invisible）/);
  check("硬点不可见元素时报 invisible 并说清原因", hidClick.threw && hidClick.match, hidClick.msg);

  const underId = st.page.all.indexOf(st.page.all.find((e) => e.id === "under")) + 1000;
  const occ = await throws(() => T.click({ ref: "ref_b" + underId }), /不可操作（occluded）/);
  check("被压住时报 occluded", occ.threw && occ.match, occ.msg);
  check("报错点名了遮挡者是谁", /id="cover"/.test(occ.msg), occ.msg);
  const forced = await T.click({ ref: "ref_b" + underId, force: true });
  check("force 能强行下发", forced.at.length === 2 && forced.forced === true, JSON.stringify(forced));
}

{
  const st = freshState();
  const span = el("span", { innerText: "文字", box: [20, 20, 60, 10] });
  st.page = makePage([el("button", { id: "wrap", innerText: "外层按钮", box: [10, 10, 100, 30], children: [span] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "外层按钮" });
  const btn = f.matches.find((m) => m.tag === "button");
  const r = await T.click({ ref: btn.ref });
  check("命中后代不算被挡，照常点得下去", r.verified === "hit", JSON.stringify(r));
}

{
  const st = freshState();
  const sel = el("select", { id: "city", box: [10, 10, 120, 30] });
  sel._options = [
    { i: 0, value: "", label: "请选择" },
    { i: 1, value: "bj", label: "北京" },
    { i: 2, value: "sh", label: "上海" },
    { i: 3, value: "gz", label: "广州", disabled: true },
  ];
  const date = el("input", { id: "d", type: "date", box: [10, 50, 120, 30] });
  date._rejectValue = (v) => !/^\d{4}-\d{2}-\d{2}$/.test(v);
  st.page = makePage([
    sel,
    date,
    el("input", { id: "chk", type: "checkbox", box: [10, 90, 16, 16] }),
    el("input", { id: "on", type: "checkbox", checked: true, box: [10, 120, 16, 16] }),
    el("input", { id: "r1", type: "radio", box: [10, 150, 16, 16] }),
    el("input", { id: "ro", type: "text", value: "改不动", box: [10, 180, 120, 30], attrs: {} }),
    el("input", { id: "dis", type: "text", disabled: true, box: [10, 210, 120, 30] }),
  ]);
  st.page.all.find((e) => e.id === "ro").readOnly = true;
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const refOf = async (q) => (await T.find({ query: q })).matches[0].ref;

  const byValue = await T.set_value({ ref: await refOf("#city"), value: "sh" });
  check("下拉按 value 选中", byValue.ok === true && byValue.value === "sh", JSON.stringify(byValue));
  const byLabel = await T.set_value({ ref: await refOf("#city"), value: "北京" });
  check("下拉按显示文本选中", byLabel.ok === true && byLabel.value === "bj", JSON.stringify(byLabel));
  const noOpt = await throws(async () => T.set_value({ ref: await refOf("#city"), value: "火星" }), /没有/);
  check("下拉给不存在的选项时报错并列出可选值", noOpt.threw && /北京/.test(noOpt.msg), noOpt.msg);
  const disOpt = await throws(async () => T.set_value({ ref: await refOf("#city"), value: "gz" }), /disabled/);
  check("下拉不让选 disabled 的选项", disOpt.threw && disOpt.match, disOpt.msg);

  const okDate = await T.set_value({ ref: await refOf("#d"), value: "2026-03-15" });
  check("日期控件设得进去", okDate.ok === true && okDate.value === "2026-03-15", JSON.stringify(okDate));
  const badDate = await throws(async () => T.set_value({ ref: await refOf("#d"), value: "2026年3月15日" }), /不接受这个值/);
  check("日期格式不对时报错（原生控件只会静悄悄不接受）", badDate.threw && badDate.match, badDate.msg);

  const chk = await T.set_value({ ref: await refOf("#chk"), value: "true" });
  check("勾选框走真点击", chk.changed === true && chk.value === true, JSON.stringify(chk));
  check("勾选框也验了命中", chk.verified === "hit", JSON.stringify(chk));
  const noop = await T.set_value({ ref: await refOf("#on"), value: "true" });
  check("本来就勾着就不再点（再点一次会取消掉）", noop.changed === false, JSON.stringify(noop));
  const radioOff = await throws(async () => T.set_value({ ref: await refOf("#r1"), value: "false" }), /不能.*取消选中/);
  check("单选框不能取消选中，报错说清怎么做", radioOff.threw && radioOff.match, radioOff.msg);

  const ro = await throws(async () => T.set_value({ ref: await refOf("#ro"), value: "x" }), /readonly/);
  check("readonly 报错而不是假装填了", ro.threw && ro.match, ro.msg);
  const dis = await throws(async () => T.set_value({ ref: await refOf("#dis"), value: "x" }), /disabled/);
  check("disabled 报错而不是假装填了", dis.threw && dis.match, dis.msg);

  const badRef = await throws(() => T.set_value({ ref: "btn-3", value: "x" }), /ref_b123/);
  check("非法 ref 报错列出两种形状", badRef.threw && badRef.match && /ref_3@f7/.test(badRef.msg) && /browser_read_page/.test(badRef.msg) && /browser_find/.test(badRef.msg), badRef.msg);
  const noValue = await throws(async () => T.set_value({ ref: await refOf("#city") }), /需要 value/);
  check("不给 value 时报错", noValue.threw && noValue.match, noValue.msg);
  check("不给 value 的报错里说清多选怎么填", /values/.test(noValue.msg), noValue.msg);
}

{
  const st = freshState();
  const tags = el("select", { id: "tags", multiple: true, box: [10, 10, 120, 60] });
  tags._options = [
    { i: 0, value: "a", label: "甲" },
    { i: 1, value: "b", label: "乙" },
    { i: 2, value: "c", label: "丙" },
  ];
  const one = el("select", { id: "city", box: [10, 90, 120, 30] });
  one._options = [
    { i: 0, value: "bj", label: "北京" },
    { i: 1, value: "sh", label: "上海" },
  ];
  st.page = makePage([tags, one]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const refOf = async (q) => (await T.find({ query: q })).matches[0].ref;
  const selected = () => tags._options.filter((o) => o.selected).map((o) => o.value);

  const multi = await T.set_value({ ref: await refOf("#tags"), values: ["甲", "丙"] });
  check("多选下拉一次收一组值", multi.ok === true && String(multi.values) === "a,c", JSON.stringify(multi));
  check("多选真的两个都选中了（断页面状态，不是返回值）", String(selected()) === "a,c", JSON.stringify(selected()));
  check("多选回读把标签也带回来", String(multi.labels) === "甲,丙", JSON.stringify(multi));

  const viaValue = await T.set_value({ ref: await refOf("#tags"), value: ["b"] });
  check("数组塞在 value 里也认", viaValue.ok === true && String(selected()) === "b", JSON.stringify(viaValue));
  check("新的一组会替换掉上一次的选中集，而不是追加", String(selected()) === "b", JSON.stringify(selected()));
  const cleared = await T.set_value({ ref: await refOf("#tags"), values: [] });
  check("空数组清空选中集", cleared.ok === true && selected().length === 0, JSON.stringify(cleared));

  const single = await throws(async () => T.set_value({ ref: await refOf("#city"), values: ["北京", "上海"] }), /单选/);
  check("单选下拉收到一组值时报错，不偷偷只填一个", single.threw && single.match, single.msg);
}

{
  const st = freshState();
  const sw = el("span", { id: "sw", role: "switch", innerText: "开关", box: [10, 10, 80, 24], attrs: { "aria-checked": "false" } });
  sw.addEventListener("mouseup", () => {
    sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
  });
  const dead = el("span", { id: "dead", role: "switch", innerText: "坏开关", box: [10, 50, 80, 24], attrs: { "aria-checked": "false" } });
  const lab = el("label", { id: "lab", innerText: "姓名", box: [10, 90, 80, 24] });
  lab._controlHint = '<input type=text id="name">';
  const div = el("div", { id: "plain", innerText: "一块 div", box: [10, 130, 80, 24] });
  const custom = el("my-input", { id: "mi", innerText: "", box: [10, 170, 80, 24] });
  custom._hasValueProp = true;
  custom.value = "";
  st.page = makePage([sw, dead, lab, div, custom]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const refOf = async (q) => (await T.find({ query: q })).matches[0].ref;

  const on = await T.set_value({ ref: await refOf("#sw"), value: "true" });
  check("role=switch 认成 aria-toggle 而不是兜底设值", on.kind === "aria-toggle" && on.role === "switch", JSON.stringify(on));
  check("role=switch 真的被点开了（断的是页面上的 aria-checked）", sw.getAttribute("aria-checked") === "true", sw.getAttribute("aria-checked"));
  check("aria 开关走的是真点击，验了命中", on.verified === "hit" && on.changed === true, JSON.stringify(on));
  const again = await T.set_value({ ref: await refOf("#sw"), value: "true" });
  check("已经是这个状态就不再点（再点一次会关掉）", again.changed === false, JSON.stringify(again));
  const off = await T.set_value({ ref: await refOf("#sw"), value: "false" });
  check("aria 开关也关得掉", off.changed === true && sw.getAttribute("aria-checked") === "false", JSON.stringify(off));

  const noEffect = await throws(async () => T.set_value({ ref: await refOf("#dead"), value: "true" }), /没变成/);
  check("点了但 aria-checked 没变时报错，绝不报成功", noEffect.threw && noEffect.match, noEffect.msg);
  check("点了没生效的报错说清「没有生效」", /没有生效/.test(noEffect.msg), noEffect.msg);

  const onLabel = await throws(async () => T.set_value({ ref: await refOf("#lab"), value: "张三" }), /不是表单控件/);
  check("往 <label> 上设值报错，不再假成功", onLabel.threw && onLabel.match, onLabel.msg);
  check("<label> 的报错点名了真正的控件", /id="name"/.test(onLabel.msg), onLabel.msg);
  const onDiv = await throws(async () => T.set_value({ ref: await refOf("#plain"), value: "x" }), /不是表单控件/);
  check("往裸 <div> 上设值报错（以前会在它身上挂个没人读的属性并报成功）", onDiv.threw && onDiv.match, onDiv.msg);

  const ce = await T.set_value({ ref: await refOf("#mi"), value: "x" });
  check("原型链上真有 value 的自定义元素照旧设得进去", ce.ok === true && custom.value === "x", JSON.stringify(ce));
}

console.log("\n\x1b[1mbrowser_set 收 read_page 的 ref_N\x1b[0m");
{
  const mk = () => {
    const sel = el("select", { id: "city", box: [10, 10, 120, 30], attrs: { "aria-label": "城市" } });
    sel._options = [
      { i: 0, value: "", label: "请选择" },
      { i: 1, value: "bj", label: "北京" },
      { i: 2, value: "sh", label: "上海" },
    ];
    const date = el("input", { id: "d", type: "date", box: [10, 50, 120, 30], attrs: { "aria-label": "日期" } });
    date._rejectValue = (v) => !/^\d{4}-\d{2}-\d{2}$/.test(v);
    return {
      sel,
      date,
      range: el("input", { id: "lv", type: "range", value: "50", box: [10, 90, 120, 20], attrs: { "aria-label": "折扣" } }),
      text: el("input", { id: "n", type: "text", box: [10, 130, 120, 30], attrs: { "aria-label": "姓名" } }),
      chk: el("input", { id: "c", type: "checkbox", box: [10, 170, 16, 16], attrs: { "aria-label": "阅读" } }),
      rad: el("input", { id: "r", type: "radio", box: [10, 200, 16, 16], attrs: { "aria-label": "满意" } }),
      note: el("div", { id: "note", box: [10, 230, 300, 40], attrs: { contenteditable: "", "data-placeholder": "备注" } }),
      dis: el("input", { id: "x", type: "text", disabled: true, box: [10, 280, 120, 30], attrs: { "aria-label": "禁用框" } }),
    };
  };
  const els = mk();
  const st = freshState();
  st.page = makePage(Object.values(els));
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://form.example.com" });
  const page = await T.read_page({ tabId: tab.tabId });
  const refOf = (name) => (page.elements.find((e) => e.name === name) || {}).ref;
  const leftover = () =>
    st.page.all.filter((e) => Object.keys(e._attrs || {}).some((k) => k.startsWith("data-aic-ref-"))).map((e) => e.id);

  check("read_page 给的就是 ref_N", /^ref_\d+$/.test(refOf("姓名") || ""), JSON.stringify(refOf("姓名")));

  const rText = await T.set_value({ ref: refOf("姓名"), value: "张三" });
  check("ref_N：文本框", rText.kind === "text", JSON.stringify(rText));
  check("ref_N：返回值里的 ref 原样回显，不换成 ref_b", rText.ref === refOf("姓名"), JSON.stringify(rText.ref));
  check("ref_N：成功路上把临时属性摘干净了", leftover().length === 0, JSON.stringify(leftover()));

  const rSel = await T.set_value({ ref: refOf("城市"), value: "上海" });
  check("ref_N：下拉按显示文本选中", rSel.ok === true && rSel.value === "sh", JSON.stringify(rSel));
  const rChk = await T.set_value({ ref: refOf("阅读"), value: true });
  check("ref_N：勾选框走真点击", rChk.changed === true && rChk.value === true, JSON.stringify(rChk));
  const rRad = await T.set_value({ ref: refOf("满意"), value: true });
  check("ref_N：单选框", rRad.changed === true, JSON.stringify(rRad));
  const rDate = await T.set_value({ ref: refOf("日期"), value: "2026-03-15" });
  check("ref_N：日期控件", rDate.ok === true && rDate.value === "2026-03-15", JSON.stringify(rDate));
  const rRange = await T.set_value({ ref: refOf("折扣"), value: "7" });
  check("ref_N：滑块", rRange.ok === true && rRange.value === "7", JSON.stringify(rRange));

  st.cdp.length = 0;
  const rCe = await T.set_value({ ref: refOf("备注"), value: "帮我留个门" });
  check("ref_N：可编辑区认成 contenteditable", rCe.kind === "contenteditable", JSON.stringify(rCe));
  check("ref_N：可编辑区走的是可信输入", st.cdp.some((c) => c.method === "Input.insertText"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("ref_N：七种控件跑完页面上一个记号都没留", leftover().length === 0, JSON.stringify(leftover()));

  const disErr = await throws(() => T.set_value({ ref: refOf("禁用框"), value: "x" }), /disabled/);
  check("ref_N：disabled 照常报错", disErr.threw && disErr.match, disErr.msg);
  check("ref_N：抛错路上也把临时属性摘干净了", leftover().length === 0, JSON.stringify(leftover()));

  const stale = await throws(() => T.set_value({ ref: "ref_99", value: "x" }), /不存在或已失效/);
  check("ref_N：失效的号报错指向重新读页面", stale.threw && stale.match && /browser_read_page/.test(stale.msg), stale.msg);
  els.text.isConnected = false;
  const gone = await throws(() => T.set_value({ ref: refOf("姓名"), value: "x" }), /失效|移出 DOM/);
  check("ref_N：元素被移出 DOM 后报失效而不是填到别处", gone.threw && gone.match, gone.msg);
}

{
  const st = freshState();
  const decoy = el("input", { attrs: { id: "decoy", "aria-label": "主页面诱饵" }, value: "主页面的诱饵输入框", box: [0, 40, 200, 30] });
  const host = el("iframe", { attrs: { id: "pay" }, box: [0, 0, 600, 400] });
  st.page = makePage([el("h1", { innerText: "结账", box: [0, 0, 100, 30] }), decoy, host]);
  const frameInput = el("input", { attrs: { id: "card", "aria-label": "卡号" }, value: "", box: [10, 40, 200, 30] });
  st.subFrames = [
    {
      frameId: 7,
      page: makePage([el("h2", { innerText: "跨进程支付框", box: [0, 0, 200, 30] }), frameInput]),
      oopif: true,
      url: "https://pay.example.com/",
      hostEl: host,
    },
  ];
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://shop.example.com" });
  const page = await T.read_page({ tabId: tab.tabId });
  const cardRef = (page.elements.find((e) => e.name === "卡号") || {}).ref;
  check("OOPIF 里的元素在 read_page 里带帧号", /^ref_\d+@f7$/.test(cardRef || ""), JSON.stringify(cardRef));
  st.cdp.length = 0;
  const r = await T.set_value({ ref: cardRef, value: "4111111111111111", force: true });
  const onSess = (m) => st.cdp.filter((c) => c.method === m && c.sessionId === "sess-7").length;
  const onTab = (m) => st.cdp.filter((c) => c.method === m && !c.sessionId).length;
  check("OOPIF 的 ref_N 也能用 browser_set", r.kind === "text", JSON.stringify(r));
  check("OOPIF：insertText 发在那一帧的会话上", onSess("Input.insertText") === 1 && onTab("Input.insertText") === 0,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText").map((c) => c.sessionId)));
  check("OOPIF：诱饵输入框一个字都没动", decoy.value === "主页面的诱饵输入框", JSON.stringify(decoy.value));
  const leftover = [...st.page.all, ...st.subFrames[0].page.all]
    .filter((e) => Object.keys(e._attrs || {}).some((k) => k.startsWith("data-aic-ref-")))
    .map((e) => e.id || e.tagName);
  check("OOPIF：帧里的临时属性也摘掉了", leftover.length === 0, JSON.stringify(leftover));
}

console.log("\n\x1b[1mcontenteditable 进元素表\x1b[0m");
{
  const child = el("p", { innerText: "第一段", box: [12, 12, 200, 20] });
  const bare = el("div", { id: "bare", box: [10, 10, 300, 40], attrs: { contenteditable: "", "data-placeholder": "备注，必填" }, children: [child] });
  const st = freshState();
  st.page = makePage([
    bare,
    el("div", { id: "yes", innerText: "已经填了的内容", box: [10, 60, 300, 40], attrs: { contenteditable: "true" } }),
    el("div", { id: "plain", innerText: "只收纯文本", box: [10, 110, 300, 40], attrs: { contenteditable: "plaintext-only" } }),
    el("div", { id: "no", innerText: "这块不可编辑", box: [10, 160, 300, 40], attrs: { contenteditable: "false" } }),
    el("div", { id: "just-a-div", innerText: "普通段落", box: [10, 210, 300, 40] }),
  ]);
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://editor.example.com" });
  const page = await T.read_page({ tabId: tab.tabId });
  const names = page.elements.map((e) => e.name);
  const roles = page.elements.map((e) => e.role);
  check("裸 contenteditable 进表并且是 textbox", page.elements.length === 3 && roles.every((r) => r === "textbox"), JSON.stringify(page.elements));
  check("空编辑区的名字退回 data-placeholder", names.includes("备注，必填"), JSON.stringify(names));
  check('contenteditable="true" 进表', names.includes("已经填了的内容"), JSON.stringify(names));
  check('contenteditable="plaintext-only" 进表', names.includes("只收纯文本"), JSON.stringify(names));
  check('contenteditable="false" 不进表', !names.includes("这块不可编辑"), JSON.stringify(names));
  check("普通 div 不进表", !names.includes("普通段落"), JSON.stringify(names));
  check("编辑区里没有该属性的子元素不进表（否则富文本编辑器每个 <p> 都占一条）",
    !names.includes("第一段"), JSON.stringify(names));
  const filled = page.elements.find((e) => e.name === "已经填了的内容");
  check("contenteditable 的 value 取 textContent（它没有 value 属性）", filled.value === "已经填了的内容", JSON.stringify(filled));
  const tb = await T.find({ role: "textbox", tabId: tab.tabId });
  check("find role:textbox 找得到裸 contenteditable", tb.matches.some((m) => m.name === "备注，必填" || m.tag === "div"), JSON.stringify(tb.matches));
}

{
  const secret = "Recovery-Phrase-9f2c";
  const st = freshState();
  st.page = makePage([
    el("div", { id: "ce", innerText: secret, box: [8, 20, 300, 40], attrs: { contenteditable: "true", autocomplete: "current-password" } }),
  ]);
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://wallet.example.com" });
  const page = await T.read_page({ tabId: tab.tabId });
  check("可编辑凭据区的原文不进元素表（value 和名字两条口都堵住）", !JSON.stringify(page.elements).includes(secret), JSON.stringify(page.elements));
  check("但它仍然列出来了（看得见有这么个控件，只是值隐去）",
    page.elements.length === 1 && /已填写/.test(JSON.stringify(page.elements[0])), JSON.stringify(page.elements));
}

console.log("\n\x1b[1mcdp_raw 的 Input.* 也要先开焦点模拟\x1b[0m");
{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "确认", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://x.example.com" });
  st.cdp.length = 0;
  await T.cdp_raw({ method: "DOM.getDocument", params: {}, tabId: tab.tabId });
  check("非 Input 命令不开焦点模拟", !st.cdp.some((c) => c.method === "Emulation.setFocusEmulationEnabled"), JSON.stringify(st.cdp.map((c) => c.method)));

  st.cdp.length = 0;
  await T.cdp_raw({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 50, y: 25, button: "left", clickCount: 1 }, tabId: tab.tabId });
  const focusCalls = st.cdp.filter((c) => c.method === "Emulation.setFocusEmulationEnabled");
  check("Input.* 之前先开了焦点模拟", focusCalls.length === 1 && focusCalls[0].params?.enabled === true, JSON.stringify(st.cdp.map((c) => c.method)));
  const order = st.cdp.map((c) => c.method);
  check("焦点模拟排在事件下发之前", order.indexOf("Emulation.setFocusEmulationEnabled") < order.indexOf("Input.dispatchMouseEvent"), JSON.stringify(order));
  const rafAt = st.cdp.findIndex((c) => c.method === "Runtime.evaluate" && /requestAnimationFrame/.test(c.params?.expression || ""));
  check("开完焦点模拟先等一帧再下发第一条输入", rafAt >= 0 && rafAt > order.indexOf("Emulation.setFocusEmulationEnabled") && rafAt < order.indexOf("Input.dispatchMouseEvent"), JSON.stringify(order));

  st.cdp.length = 0;
  await T.cdp_raw({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 50, y: 25, button: "left", clickCount: 1 }, tabId: tab.tabId });
  check("同一张页上不重复开（账本记着）", !st.cdp.some((c) => c.method === "Emulation.setFocusEmulationEnabled"), JSON.stringify(st.cdp.map((c) => c.method)));

  await T.cdp_raw({ method: "Emulation.setFocusEmulationEnabled", params: { enabled: false }, tabId: tab.tabId });
  st.cdp.length = 0;
  await T.cdp_raw({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a" }, tabId: tab.tabId });
  check("raw 关掉之后账本同步，下一次 Input 会重新开",
    st.cdp.some((c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params?.enabled === true),
    JSON.stringify(st.cdp.map((c) => c.method)));
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "确认", box: [100, 200, 80, 40] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;

  const r = await T.click({ ref: "ref_1" });
  const mouse = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent");
  check("点击落在元素中心", r.at[0] === 140 && r.at[1] === 220, JSON.stringify(r.at));
  check("点击下发了 move/press/release 三步", mouse.length === 3);
  check(
    "事件序列正确",
    mouse[0].params.type === "mouseMoved" &&
      mouse[1].params.type === "mousePressed" &&
      mouse[2].params.type === "mouseReleased"
  );
  check("按下事件带 clickCount", mouse[1].params.clickCount === 1);

  const bad = await throws(() => T.click({ ref: "ref_99" }), /不存在或已失效|重新 read_page/);
  check("失效的 ref 给出可操作的报错", bad.threw && bad.match, bad.msg);

  const noArg = await throws(() => T.click({}), /需要 ref 或 x\/y/);
  check("既无 ref 也无坐标时报错", noArg.threw && noArg.match, noArg.msg);
}

{
  const st = freshState();
  const gone = el("button", { innerText: "旧按钮" });
  st.page = makePage([gone]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  gone.isConnected = false;
  const r = await throws(() => T.click({ ref: "ref_1" }), /已从 DOM 移除/);
  check("元素被移除后 ref 报明确错误", r.threw && r.match, r.msg);
}

console.log("\n\x1b[1m可操作性检查\x1b[0m");

function coveredPage(overlayBox = [90, 190, 100, 60]) {
  return makePage([
    el("button", { id: "target", innerText: "被遮住的按钮", box: [100, 200, 80, 40] }),
    el("div", { id: "overlay", innerText: "", box: overlayBox, attrs: { role: undefined } }),
  ]);
}

{
  const st = freshState();
  st.page = coveredPage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;

  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（occluded）/);
  check("点被遮挡的元素会抛错而不是假装成功", r.threw && r.match, r.msg);
  check("报错点名了遮挡物", /<div id="overlay">/.test(r.msg), r.msg);
  check("报错给了下一步（关掉遮挡物）", /先把它关掉|滚动让它离开/.test(r.msg), r.msg);
  check(
    "被拦下时一个鼠标事件都没有下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  st.page = coveredPage([90, 190, 60, 60]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await T.click({ ref: "ref_1" });
  check("只被遮住一半时改点没被遮的位置", r.at[0] > 150 && r.at[0] < 180, JSON.stringify(r.at));
  check("落点确实命中目标本身", /<button id="target">/.test(r.hit || ""), r.hit);
}

{
  const st = freshState();
  st.page = coveredPage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await T.click({ ref: "ref_1", force: true });
  check("force:true 跳过检查照样下发", r.at[0] === 140 && r.at[1] === 220 && r.forced === true, JSON.stringify(r));
}

{
  const st = freshState();
  st.page = makePage([
    el("button", { id: "d1", innerText: "禁用", disabled: true, box: [0, 0, 80, 30] }),
    el("button", { id: "d2", innerText: "aria 禁用", attrs: { "aria-disabled": "true" }, box: [0, 40, 80, 30] }),
    el("button", { id: "d3", innerText: "穿透", style: { pointerEvents: "none" }, box: [0, 80, 80, 30] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("read_page 把禁用状态标出来", snap.elements[0].disabled === true && snap.elements[1].disabled === true, JSON.stringify(snap.elements));

  const r1 = await throws(() => T.click({ ref: "ref_1" }), /不可操作（disabled）/);
  check("点 disabled 按钮抛错", r1.threw && r1.match, r1.msg);
  check("disabled 报错说明了点了也不会触发", /不会触发任何处理函数/.test(r1.msg), r1.msg);

  const r2 = await throws(() => T.click({ ref: "ref_2" }), /不可操作（disabled）/);
  check('aria-disabled="true" 同样拦下', r2.threw && r2.match, r2.msg);

  const r3 = await throws(() => T.click({ ref: "ref_3" }), /pointer-events/);
  check("pointer-events:none 拦下并说明会穿透", r3.threw && r3.match && /穿透到下层/.test(r3.msg), r3.msg);
}

{
  const st = freshState();
  const btn = el("button", { id: "gone", innerText: "会被藏起来", box: [0, 0, 80, 30] });
  st.page = makePage([btn]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  btn._style.display = "none";
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（hidden）/);
  check("read_page 之后才变隐藏也能拦下", r.threw && r.match, r.msg);
}

{
  const st = freshState();
  const far = el("button", { id: "far", innerText: "很远", box: [0, 2000, 80, 30] });
  st.page = makePage([far]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（offscreen）/);
  check("滚不动的视口外元素报 offscreen", r.threw && r.match, r.msg);
  check("报错前确实尝试过 scrollIntoView", far._scrolledIntoView > 0, String(far._scrolledIntoView));
  check("offscreen 报错建议滚动后重读", /browser_scroll/.test(r.msg), r.msg);
}
{
  const st = freshState();
  const bx = [0, 2000, 80, 30];
  const far = el("button", {
    id: "far2",
    innerText: "滚一下就看得见",
    box: bx,
    onScrollIntoView: () => {
      bx[1] = 400;
    },
  });
  st.page = makePage([far]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await T.click({ ref: "ref_1" });
  check("滚动后进入视口就正常点击", r.at[1] === 415 && r.scrolled === true, JSON.stringify(r));
}

{
  const st = freshState();
  const opts = [];
  const bx = [0, 2000, 80, 30];
  const far = el("button", {
    id: "far3",
    innerText: "很远",
    box: bx,
    onScrollIntoView: (_o, op) => {
      opts.push(op);
      bx[1] = 300;
    },
  });
  st.page = makePage([far]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  await T.click({ ref: "ref_1" });
  check("自动滚动传了 behavior:instant", opts[0] && opts[0].behavior === "instant", JSON.stringify(opts));
  check("自动滚动同时居中", opts[0] && opts[0].block === "center", JSON.stringify(opts));
}

{
  const st = freshState();
  st.layoutMetrics = { cssContentSize: { width: 800, height: 3000 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
  st.page = makePage([el("div", { id: "x", innerText: "内容", box: [0, 0, 800, 3000] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.scroll({ direction: "down", amount: 400 });
  check("滚得动时报出真实位移", r.movedBy?.y === 400, JSON.stringify(r));
  check("滚成功了不啰嗦（不加 note）", !r.note, JSON.stringify(r));
  check("atEnd 只在到底时才有", !("atEnd" in r), JSON.stringify(r));
}
{
  const st = freshState();
  st.layoutMetrics = { cssContentSize: { width: 800, height: 1000 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 400 } };
  st.scrollY = 400;
  st.page = makePage([el("div", { id: "x", innerText: "内容", box: [0, 0, 800, 1000] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.scroll({ direction: "down", amount: 400 });
  check("到底了：位移为 0", r.movedBy?.y === 0, JSON.stringify(r));
  check("到底了：标 atEnd", r.atEnd === true, JSON.stringify(r));
  check("到底了：说明继续滚不会有变化", /到底|不会有变化/.test(r.note || ""), r.note);
  check("到底了不该建议换落点（那是另一种成因）", !/换个 x\/y/.test(r.note || ""), r.note);
}
{
  const st = freshState();
  st.wheelDead = true;
  st.layoutMetrics = { cssContentSize: { width: 800, height: 3000 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
  st.page = makePage([el("div", { id: "x", innerText: "内容", box: [0, 0, 800, 3000] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.scroll({ direction: "down", amount: 400 });
  check("滚不动：位移为 0", r.movedBy?.y === 0, JSON.stringify(r));
  check("滚不动：不冒充 atEnd", !r.atEnd, JSON.stringify(r));
  check("滚不动：点明可能是内层容器滚了", /内层容器/.test(r.note || ""), r.note);
  check("滚不动：给了换落点的出路", /x\/y|scrollIntoView/.test(r.note || ""), r.note);
  check("滚不动时不再假装成功", r.movedBy != null, JSON.stringify(r));
}
{
  const st = freshState();
  st.layoutMetrics = { cssContentSize: { width: 800, height: 3000 } };
  st.page = makePage([el("div", { id: "x", innerText: "内容", box: [0, 0, 800, 3000] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.scroll({ direction: "down", amount: 400 });
  check("拿不到基线时不编造校验结论", !("movedBy" in r), JSON.stringify(r));
  check("但滚动本身照常成功", r.scrolled === "down" && r.amount === 400, JSON.stringify(r));
}

{
  const st = freshState();
  const cage = { tagName: "DIV", id: "cage", scrollTop: 0, scrollLeft: 0, scrollHeight: 900, clientHeight: 300, scrollWidth: 260, clientWidth: 260 };
  const item = el("div", { id: "row", innerText: "列表里的一行", box: [10, 10, 200, 20] });
  item._scrollBox = cage;
  item._intoViewTop = 400;
  const loose = el("div", { id: "loose", innerText: "没有可滚容器的东西", box: [10, 40, 200, 20] });
  st.page = makePage([item, loose]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const bySel = await T.scroll({ selector: "#row", direction: "down", amount: 150 });
  check("selector 滚的是那个元素所在的容器，不是整页", bySel.container === '<div id="cage">' && bySel.scrolledPage === false, JSON.stringify(bySel));
  check("回读容器的 scrollTop 变化作为结果", bySel.scrollTop === 150 && bySel.movedBy.y === 150, JSON.stringify(bySel));
  check("整页视口没被动过（滚的确实是容器）", (st.scrollY ?? 0) === 0, String(st.scrollY));

  const ref = (await T.find({ query: "#row" })).matches[0].ref;
  const byRef = await T.scroll({ ref, direction: "down", amount: 1000 });
  check("ref 那条路等价", byRef.container === '<div id="cage">' && byRef.scrollTop === 600, JSON.stringify(byRef));
  const end = await T.scroll({ ref, direction: "down", amount: 400 });
  check("容器到底了报 atEnd，而不是一次次假装滚了", end.atEnd === true && end.movedBy.y === 0, JSON.stringify(end));
  check("atEnd 的话说清「别再往这个方向滚了」", /已经到底/.test(end.note || ""), JSON.stringify(end));
  const back = await T.scroll({ ref, direction: "up", amount: 200 });
  check("往回滚也认", back.scrollTop === 400 && back.movedBy.y === -200, JSON.stringify(back));

  await T.scroll({ ref, direction: "up", amount: 5000 });
  const into = await T.scroll({ ref, amount: 0 });
  check("amount:0 走 scrollIntoView", into.scrolled === "intoView" && into.scrollTop === 400, JSON.stringify(into));
  check("intoView 不报方向（那一趟本来就没有方向）", !("amount" in into), JSON.stringify(into));

  const none = await T.scroll({ selector: "#loose", direction: "down", amount: 100 });
  check("没有可滚容器时落到整页，并如实标出滚的是整页", none.scrolledPage === true && none.container === "<html>", JSON.stringify(none));
  await T.scroll({ selector: "#loose", direction: "down", amount: 9999 });
  const stuck = await T.scroll({ selector: "#loose", direction: "up", amount: 0.4 });
  check(
    "整页也动不了时点明「这个元素上面没有可滚的容器，多半该换个目标」",
    stuck.movedBy.y === 0 && /没有可滚的容器/.test(stuck.note || ""),
    JSON.stringify(stuck)
  );

  const miss = await throws(() => T.scroll({ selector: "#nope", direction: "down" }), /没匹配到元素/);
  check("选择器匹配不到时报错，不静默去滚整页", miss.threw && miss.match, miss.msg);
  const both = await throws(() => T.scroll({ selector: "#row", ref: "ref_b1", direction: "down" }), /只能给一个/);
  check("ref 和 selector 同时给时报错（滚错对象比报错糟）", both.threw && both.match, both.msg);
}

{
  const st = freshState();
  const deep = el("button", { id: "deep", innerText: "容器外的按钮", box: [0, 2000, 80, 30] });
  const cage = el("div", { id: "cage", style: { overflow: "clip" }, box: [0, 0, 200, 50], children: [deep] });
  st.page = makePage([cage]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（offscreen）/);
  check("offscreen 点名了裁掉它的容器", /cage/.test(r.msg), r.msg);
  check("并说明那个容器滚不动、要换入口", /滚不动|换个入口/.test(r.msg), r.msg);
}
{
  const st = freshState();
  const deep = el("button", { id: "deep2", innerText: "容器里的按钮", box: [0, 2000, 80, 30] });
  const cage = el("div", { id: "scroller", style: { overflow: "auto" }, box: [0, 0, 200, 50], children: [deep] });
  cage.scrollHeight = 900;
  cage.clientHeight = 50;
  st.page = makePage([cage]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（offscreen）/);
  check("容器还能滚时建议去滚那个容器", /内部滚动容器/.test(r.msg) && /scroller/.test(r.msg), r.msg);
}
{
  const st = freshState();
  const drawer = el("button", {
    id: "drawer",
    innerText: "抽屉里的按钮",
    box: [-500, 100, 80, 30],
    style: { position: "fixed" },
  });
  st.page = makePage([drawer]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（offscreen）/);
  check("fixed 元素报错说清滚动没用", /position:fixed/.test(r.msg) && /滚多少都没用/.test(r.msg), r.msg);
}

{
  const st = freshState();
  const deep = el("button", { id: "hidden-in-box", innerText: "被裁掉的按钮", box: [0, 200, 80, 30] });
  const cage = el("div", { id: "clipbox", style: { overflow: "hidden" }, box: [0, 0, 200, 50], children: [deep] });
  st.page = makePage([cage]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（clipped）/);
  check("被容器裁掉时报 clipped 而不是 occluded", r.threw && r.match, r.msg);
  check("clipped 点名了那个容器", /clipbox/.test(r.msg), r.msg);
  check("clipped 时确实没有点下去", !st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), JSON.stringify(st.cdp.map((c) => c.method)));
}

function keepMoving(st, bx, stopAfter = Infinity) {
  let n = 0;
  st.beforeInject = () => {
    if (n < stopAfter) {
      n++;
      bx[1] += 20;
    }
  };
}
{
  const st = freshState();
  const bx = [0, 100, 80, 30];
  st.page = makePage([el("button", { id: "mover", innerText: "动个不停", box: bx })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  keepMoving(st, bx);
  st.cdp.length = 0;
  const r = await throws(() => T.click({ ref: "ref_1" }), /不可操作（moving）/);
  check("目标一直在动时拒绝下发", r.threw && r.match, r.msg);
  check("moving 时确实没有点下去", !st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("moving 报错给了下一步（等条件成立）", /browser_wait_for/.test(r.msg), r.msg);
  check("moving 报错带上前后两个位置", /→/.test(r.msg), r.msg);

  st.cdp.length = 0;
  const f = await T.click({ ref: "ref_1", force: true });
  check("force:true 跳过稳定性等待照样下发", f.forced === true && st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), JSON.stringify(f));
}
{
  const st = freshState();
  const bx = [0, 100, 80, 30];
  st.page = makePage([el("button", { id: "settling", innerText: "会停下来", box: bx })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  keepMoving(st, bx, 3);
  const r = await T.click({ ref: "ref_1" });
  check("会停下来的目标：等停稳后按最终位置点", r.at[1] === 100 + 3 * 20 + 15, `${JSON.stringify(r.at)} 最终 box ${JSON.stringify(bx)}`);
  st.beforeInject = null;
}

{
  const st = freshState();
  const bx = [0, 100, 80, 30];
  st.page = makePage([el("button", { id: "framey", innerText: "一帧挪一次", box: bx })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const t0 = Date.now();
  let lastFrame = -1;
  const STOP_MS = 120;
  st.beforeInject = () => {
    const dt = Date.now() - t0;
    if (dt > STOP_MS) return;
    const f = Math.floor(dt / 16);
    if (f !== lastFrame) {
      lastFrame = f;
      bx[1] += 30;
    }
  };
  const r = await T.click({ ref: "ref_1" });
  st.beforeInject = null;
  check(
    "一帧只动一次的页面：采样跨过一帧才看得见它在动，最终按停稳后的位置点",
    r.at[1] === bx[1] + 15,
    `点在 ${JSON.stringify(r.at)}，最终 box ${JSON.stringify(bx)}`
  );
}

{
  const st = freshState();
  const target = el("button", { id: "want", innerText: "想点的", box: [0, 100, 80, 30] });
  const other = el("div", { id: "banner", innerText: "半路杀出来的", box: [0, 300, 300, 60] });
  st.page = makePage([target, other]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});

  const ok = await T.click({ ref: "ref_1" });
  check("正常点击：校验确认打中了目标", ok.verified === "hit", JSON.stringify(ok));

  st.dispatchHit = () => other;
  st.cdp.length = 0;
  const bad = await throws(() => T.click({ ref: "ref_1" }), /点击没有落在目标上/);
  check("下发时打歪了：抛错而不是报成功", bad.threw && bad.match, bad.msg);
  check("报错点名了实际打中的元素", /banner/.test(bad.msg), bad.msg);
  check("报错说清页面没有被操作", /没有\*\*按你的意图\*\*|没有.{0,4}按你的意图/.test(bad.msg), bad.msg);

  const forced = await T.click({ ref: "ref_1", force: true });
  check("force:true 跳过下发校验", forced.forced === true && forced.verified === undefined, JSON.stringify(forced));
  st.dispatchHit = null;

  st.noClickSynthesis = true;
  const noClick = await throws(() => T.click({ ref: "ref_1" }), /没有合成 click 事件/);
  check("click 没被合成时也抛错", noClick.threw && noClick.match, noClick.msg);
  st.noClickSynthesis = false;
}
{
  const st = freshState();
  st.page = makePage([el("button", { id: "quiet", innerText: "安静按钮", box: [0, 100, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.dispatchHit = () => null;
  const r = await T.click({ ref: "ref_1" });
  check("观测不到事件时如实标 unknown，不误报失败", r.verified === "unknown" && /捕获阶段|校验不了/.test(r.why || ""), JSON.stringify(r));
  st.dispatchHit = null;
}
{
  const st = freshState();
  const input = el("input", { id: "kw", type: "text", box: [0, 100, 200, 30] });
  const other = el("input", { id: "other", type: "text", box: [0, 300, 200, 30] });
  st.page = makePage([input, other]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.dispatchHit = () => other;
  st.cdp.length = 0;
  const bad = await throws(() => T.type_text({ ref: "ref_1", text: "机密" }), /点击没有落在目标上/);
  check("browser_type 点歪时也抛错", bad.threw && bad.match, bad.msg);
  check(
    "点歪时绝不把文字打出去（否则就写进别人的输入框了）",
    !st.cdp.some((c) => c.method === "Input.insertText"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
  st.dispatchHit = null;
}

{
  const st = freshState();
  const a = el("button", { id: "a", innerText: "甲", box: [0, 0, 80, 30] });
  const b = el("button", { id: "b", innerText: "乙", box: [0, 40, 80, 30] });
  st.page = makePage([a, b]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const s1 = await T.read_page({});
  check("首次读页 ref 从 1 开始排", s1.elements.map((e) => e.ref).join(",") === "ref_1,ref_2", JSON.stringify(s1.elements.map((e) => e.ref)));

  const x = el("button", { id: "x", innerText: "插队的", box: [0, 120, 80, 30] });
  x.ownerDocument = st.page.doc;
  st.page.all.unshift(x);
  const s2 = await T.read_page({});
  const map2 = Object.fromEntries(s2.elements.map((e) => [e.ref, e.name]));
  check("重读之后旧 ref 仍指原来那个元素", map2.ref_1 === "甲" && map2.ref_2 === "乙", JSON.stringify(map2));
  check("新元素拿新号，不占用老号", map2.ref_3 === "插队的", JSON.stringify(map2));
  const r = await T.click({ ref: "ref_1" });
  check("旧 ref 点到的还是原来那个元素", /甲/.test(r.clicked), r.clicked);

  st.page.all.splice(st.page.all.indexOf(a), 1);
  a.isConnected = false;
  const s3 = await T.read_page({});
  const map3 = Object.fromEntries(s3.elements.map((e) => [e.ref, e.name]));
  check("元素消失后其余 ref 不位移", map3.ref_2 === "乙" && map3.ref_3 === "插队的", JSON.stringify(map3));
  const gone = await throws(() => T.click({ ref: "ref_1" }), /不存在或已失效|已从 DOM 移除/);
  check("消失元素的 ref 明确报失效", gone.threw && gone.match, gone.msg);
  check("失效报错点明「滚动和点击不会让 ref 失效」", /滚动|refresh_refs/.test(gone.msg), gone.msg);
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "only", innerText: "唯一按钮" })]);
  st.page.win.__aicRefs = new Array(20001).fill(null);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("槽位超过上限后整体重置，编号从 1 重新开始", snap.elements[0].ref === "ref_1", snap.elements[0].ref);
  const r = await T.click({ ref: "ref_1" });
  check("重置之后新号照样能用", /唯一按钮/.test(r.clicked), r.clicked);
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "a", innerText: "甲" })]);
  st.page.win.WeakMap = undefined;
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const s1 = await T.read_page({});
  const s2 = await T.read_page({});
  check("没有 WeakMap 时 read_page 仍然正常返回", s1.elements.length === 1 && s2.elements.length === 1, JSON.stringify(s2.elements));
  const r = await T.click({ ref: s2.elements[0].ref });
  check("没有 WeakMap 时最新一次的 ref 仍然点得到", /甲/.test(r.clicked), r.clicked);
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "按钮" })], { bodyText: "很长很长的正文" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const full = await T.read_page({});
  check("默认会返回正文", full.text === "很长很长的正文", full.text);
  const lite = await T.read_page({ maxText: 0 });
  check("maxText:0 真的不返回正文（以前被 || 吃成默认值）", lite.text === "", JSON.stringify(lite.text));
  check("maxText:0 仍然给出元素表", (lite.elements || []).length === 1, JSON.stringify(lite.elements));
  check("自己说不要正文，就不是「被截断」", lite.textTruncated === false, String(lite.textTruncated));
  check("但要说清这一页确实有多少正文", /7 字符/.test(lite.textHint || ""), lite.textHint);
  check("不给「续读把 textOffset 设成 0」这种死循环提示", !/textOffset/.test(lite.textHint || ""), lite.textHint);
  const rr = await T.refresh_refs({});
  check("refresh_refs 只给元素表", (rr.elements || []).length === 1 && rr.text === undefined, JSON.stringify(rr));
  check("refresh_refs 的 ref 与 read_page 同号", rr.elements[0].ref === full.elements[0].ref, `${rr.elements[0].ref} vs ${full.elements[0].ref}`);
  check("refresh_refs 的 _fromPage 不再列已删掉的 text", !(rr._fromPage || []).includes("text"), JSON.stringify(rr._fromPage));
  check("剩下的 elements 仍然标着", (rr._fromPage || []).includes("elements"), JSON.stringify(rr._fromPage));
  check("清单里每一项都是真实存在的字段", (rr._fromPage || []).every((k) => k in rr), JSON.stringify(rr._fromPage));
}

{
  const st = freshState();
  const many = [];
  for (let i = 1; i <= 12; i++) many.push(el("button", { innerText: `按钮${i}`, box: [0, i * 20, 60, 18] }));
  st.page = makePage(many);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const cut = await T.read_page({ maxElements: 5 });
  check("超上限时只返回上限内的元素", cut.elements.length === 5, JSON.stringify(cut.elements.length));
  check("超上限时标为截断", cut.elementsTruncated === true);
  check("超上限时报出整页实际总数", cut.elementsTotal === 12, String(cut.elementsTotal));
  const hint = cut.truncatedHint || "";
  check("提示里有总数和已返回数", /12/.test(hint) && /5/.test(hint), hint);
  check("提示里给了两条出路：调 maxElements 或用 container", /maxElements/.test(hint) && /container/.test(hint), hint);

  const fit = await T.read_page({ maxElements: 12 });
  check("正好装得下就不算截断（老逻辑 >= 会误报）", fit.elementsTruncated === false, JSON.stringify(fit.elementsTruncated));
  check("没截断时不给提示", fit.truncatedHint === undefined, String(fit.truncatedHint));
  check("没截断时也报总数", fit.elementsTotal === 12, String(fit.elementsTotal));
  check("被截掉的元素不占 ref 号（后来读到时接着编）", fit.elements[11].ref === "ref_12", fit.elements[11].ref);
}

{
  const st = freshState();
  const many = [];
  for (let i = 1; i <= 210; i++) many.push(el("button", { innerText: `按钮${i}`, box: [0, i * 20, 60, 18] }));
  st.page = makePage(many);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const rp = await T.read_page();
  const rr = await T.refresh_refs();
  check("read_page 默认给 200 个", rp.elements.length === 200, String(rp.elements.length));
  check("refresh_refs 默认也给 200 个", rr.elements.length === 200, String(rr.elements.length));
  check("同一页两个工具的默认元素数一致", rp.elements.length === rr.elements.length, `${rp.elements.length} vs ${rr.elements.length}`);
  check("refresh_refs 不返回正文相关字段", rr.text === undefined && rr.textTotal === undefined && rr.textHint === undefined, JSON.stringify({ t: rr.text, tt: rr.textTotal, th: rr.textHint }));
}

{
  const st = freshState();
  const BODY = "abcdefghij".split("").map((c) => c.repeat(10)).join("");
  st.page = makePage([el("button", { innerText: "按钮", box: [0, 0, 60, 18] })], { bodyText: BODY });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const p1 = await T.read_page({ maxText: 40 });
  check("正文按上限截断", p1.text.length === 40, String(p1.text.length));
  check("正文截断时报出总字符数", p1.textTotal === 100, String(p1.textTotal));
  check("正文截断时标为截断", p1.textTruncated === true);
  check("正文提示里给了下一趟的 textOffset", /textOffset/.test(p1.textHint || "") && /40/.test(p1.textHint || ""), p1.textHint);
  check("第一趟不回报 textOffset（默认 0 不噪声）", p1.textOffset === undefined, String(p1.textOffset));

  const p2 = await T.read_page({ maxText: 40, textOffset: 40 });
  check("续读拿到的是第 41～80 字符", p2.text === BODY.slice(40, 80), p2.text);
  check("续读回报 textOffset", p2.textOffset === 40, String(p2.textOffset));
  check("还没读完仍标截断", p2.textTruncated === true);

  const p3 = await T.read_page({ maxText: 40, textOffset: 80 });
  check("最后一趟取回剩下的 20 字符", p3.text === BODY.slice(80), p3.text);
  check("读到底就不再标截断", p3.textTruncated === false, String(p3.textTruncated));
  check("三趟拼起来等于原文", p1.text + p2.text + p3.text === BODY);
}

{
  const st = freshState();
  const TOP = "abcdefghij".split("").map((c) => c.repeat(10)).join("");
  const IN = "klmnopqrst".split("").map((c) => c.repeat(10)).join("");
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([el("button", { id: "outer", innerText: "外层按钮", box: [0, 0, 80, 30] }), iframeEl], {
    bodyText: TOP,
  });
  const child = makePage([el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
    bodyText: IN,
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const q1 = await T.read_page({ maxText: 60 });
  check("额度不够时顶层正文照常给满", q1.text === TOP.slice(0, 60), q1.text);
  check("装不下的 iframe 段一个字都不给（不再半截混进来）", !q1.text.includes("kkk"), q1.text);
  check("返回的正文长度不超过 maxText（以前最后那一刀切完没人报）", q1.text.length <= 60, String(q1.text.length));
  check("textTotal 是顶层帧的总长（textOffset 索引的就是它）", q1.textTotal === 100, String(q1.textTotal));
  check("多帧下仍如实标截断", q1.textTruncated === true);
  check("提示里的续读起点等于这次实发的字符数", /textOffset 设成 60/.test(q1.textHint || ""), q1.textHint);
  check("提示点名了这次一个字都没给的帧", /f7/.test(q1.textHint || ""), q1.textHint);
  check("并给出 iframe 正文的取法（不是靠 textOffset 续读）", /container|browser_new_tab/.test(q1.textHint || ""), q1.textHint);

  const q2 = await T.read_page({ maxText: 60, textOffset: 60 });
  check("续读拿到顶层剩下的 40 字符", q2.text === TOP.slice(60), q2.text);
  check("q1+q2 覆盖了整段顶层正文，没有跳过", q1.text + q2.text === TOP);

  const q2b = await T.read_page({ maxText: 400, textOffset: 60 });
  check("续读时 iframe 正文从它自己的开头给，不是从 textOffset 切", q2b.text.includes(IN), q2b.text);

  const q3 = await T.read_page({ maxText: 20000 });
  check("额度够时 iframe 段照常附在后面（行为不变）", q3.text.includes(TOP) && q3.text.includes(IN), q3.text.length);
  check("全都给全了就不标截断", q3.textTruncated === false, JSON.stringify({ t: q3.textTruncated, h: q3.textHint }));
}

{
  const st = freshState();
  const many = [];
  for (let i = 1; i <= 12; i++) many.push(el("button", { innerText: `按钮${i}`, box: [0, i * 20, 60, 18] }));
  st.page = makePage(many, { bodyText: "这一页的正文" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const only = await T.read_page({ maxElements: 0 });
  check("maxElements:0 不返回任何元素（以前被 || 吃成默认值 200）", (only.elements || []).length === 0, JSON.stringify(only.elements));
  check("maxElements:0 仍然返回正文", only.text === "这一页的正文", only.text);
  check("maxElements:0 照常报出整页元素总数", only.elementsTotal === 12, String(only.elementsTotal));
  check("自己说不要，就不是「被截断」", only.elementsTruncated === false, String(only.elementsTruncated));
  check("但要说清这些元素这次没有 ref、点不了", /ref|点不了/.test(only.truncatedHint || ""), only.truncatedHint);

  const rr = await T.refresh_refs({ maxElements: 0 });
  check("refresh_refs 的产出全靠元素表，0 在那边不生效", (rr.elements || []).length === 12, String((rr.elements || []).length));
}

{
  const st = freshState();
  const LONG = "长".repeat(300);
  const labelSrc = el("span", { id: "lbl", innerText: LONG, box: [0, 0, 10, 10] });
  st.page = makePage([
    el("button", { id: "a", attrs: { "aria-label": LONG }, box: [0, 0, 60, 18] }),
    el("button", { id: "b", attrs: { "aria-labelledby": "lbl" }, box: [0, 30, 60, 18] }),
    labelSrc,
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({ maxText: 0 });
  const names = snap.elements.map((e) => e.name);
  check("aria-label 截到 120", names.some((n) => n.length === 120), JSON.stringify(names.map((n) => n.length)));
  check("aria-labelledby 拼出来的名字也截到 120", names.filter((n) => n.length === 120).length === 2, JSON.stringify(names.map((n) => n.length)));
}

{
  const st = freshState();
  const panel = el("div", {
    id: "panel",
    role: "dialog",
    innerText: "浮层正文",
    box: [200, 100, 400, 300],
    children: [
      el("input", { id: "chk", type: "checkbox", checked: false, box: [210, 140, 20, 20] }),
      el("button", { id: "apply", innerText: "应用筛选", box: [210, 200, 90, 30] }),
      el("div", {
        id: "host",
        box: [210, 240, 90, 30],
        shadow: [el("button", { id: "deep", innerText: "影子确认", box: [210, 240, 90, 30] })],
      }),
    ],
  });
  st.page = makePage(
    [
      el("button", { id: "card1", innerText: "学科卡片1", box: [0, 0, 80, 30] }),
      el("button", { id: "card2", innerText: "学科卡片2", box: [0, 40, 80, 30] }),
      panel,
    ],
    { bodyText: "整页正文" }
  );
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const full = await T.read_page({});
  check("不给 container 还是读整页（向后兼容）", full.elements.length === 6, JSON.stringify(full.elements.map((e) => e.name)));
  check("不给 container 时不回报 container 字段", full.container === undefined, String(full.container));

  const sub = await T.read_page({ container: "#panel" });
  const names = sub.elements.map((e) => e.name);
  check("container 只返回子树里的元素", names.includes("应用筛选") && !names.includes("学科卡片1"), JSON.stringify(names));
  check("容器自身是可交互元素时也算进去", sub.elements.some((e) => e.role === "dialog"), JSON.stringify(names));
  check("container 命中时回报读的是哪棵子树", sub.container === "#panel", String(sub.container));
  check("container 把正文也限定在子树里", sub.text === "浮层正文", JSON.stringify(sub.text));
  check("子树内部的 shadow DOM 照样穿得进去", names.includes("影子确认"), JSON.stringify(names));
  check(
    "container 下的 ref 与整页读到的同号（槽位不受影响）",
    sub.elements.find((e) => e.name === "应用筛选").ref === full.elements.find((e) => e.name === "应用筛选").ref,
    `${sub.elements.find((e) => e.name === "应用筛选").ref} vs ${full.elements.find((e) => e.name === "应用筛选").ref}`
  );
  const clicked = await T.click({ ref: sub.elements.find((e) => e.name === "应用筛选").ref });
  check("container 拿到的 ref 真的点得到", /id="apply"/.test(clicked.hit || ""), clicked.hit);

  const cut = await T.read_page({ maxElements: 3 });
  check("上限卡死时浮层里的按钮拿不到 ref", !cut.elements.some((e) => e.name === "应用筛选"), JSON.stringify(cut.elements.map((e) => e.name)));
  const rescued = await T.read_page({ maxElements: 3, container: "#panel" });
  check("同样的上限下，container 就够到浮层里的按钮了", rescued.elements.some((e) => e.name === "应用筛选"), JSON.stringify(rescued.elements.map((e) => e.name)));

  const rr = await T.refresh_refs({ container: "#panel" });
  check("refresh_refs 也认 container", rr.elements.map((e) => e.name).includes("应用筛选") && rr.text === undefined, JSON.stringify(rr.elements.map((e) => e.name)));

  const miss = await throws(() => T.read_page({ container: "#nope" }), /没匹配到/);
  check("匹配不到就报错，绝不静默回落到整页", miss.threw && miss.match, miss.msg);
  check("报错里点明了「没有回落到整页」", /没有回落到整页/.test(miss.msg), miss.msg);
  const badSel = await throws(() => T.read_page({ container: "[[[" }), /不是合法的 CSS 选择器/);
  check("选择器语法错单独报错（和「页面上没有」分开）", badSel.threw && badSel.match, badSel.msg);
  const blank = await T.read_page({ container: "   " });
  check("container 传空白等于没传，照常读整页", blank.elements.length === 6 && blank.container === undefined, JSON.stringify(blank.elements.length));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([el("button", { id: "outer", innerText: "外层按钮", box: [0, 0, 80, 30] }), iframeEl]);
  const child = makePage(
    [
      el("div", {
        id: "panel",
        role: "dialog",
        innerText: "帧内浮层",
        box: [0, 0, 200, 100],
        children: [el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })],
      }),
    ],
    { url: "https://example.com/frame", bodyText: "帧内正文" }
  );
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const sub = await T.read_page({ container: "#panel" });
  const inner = sub.elements.find((e) => e.name === "帧内按钮");
  check("container 只在子帧里命中时照样读得到", !!inner, JSON.stringify(sub.elements.map((e) => e.name)));
  check("顶层帧没命中不算失败（不报错）", !sub.elements.some((e) => e.name === "外层按钮"), JSON.stringify(sub.elements.map((e) => e.name)));
  check("子帧里的 ref 仍然带帧号", inner.ref.endsWith("@f7"), inner.ref);
  check("子帧里的坐标照样换算到顶层视口", inner.box[0] === 60 && inner.box[1] === 120, JSON.stringify(inner.box));
  const miss = await throws(() => T.read_page({ container: "#nowhere" }), /任何一帧里都没匹配到/);
  check("所有帧都不命中才报错", miss.threw && miss.match, miss.msg);

  const whole = await T.read_page({});
  check("elementsTotal 把各帧的数量加在一起", whole.elementsTotal === 3, String(whole.elementsTotal));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([
    el("div", {
      id: "panel",
      role: "dialog",
      innerText: "浮层",
      box: [0, 0, 120, 60],
      children: [el("button", { id: "go", innerText: "浮层按钮", box: [10, 10, 80, 30] })],
    }),
    iframeEl,
  ]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const sub = await T.read_page({ container: "#panel" });
  check("container 只读顶层子树时元素也只有子树里的", sub.elements.every((e) => !e.frame), JSON.stringify(sub.elements.map((e) => e.name)));
  check(
    "子树外的跨源 iframe 照样握上手、坐标算得出",
    (sub.frames || []).some((f) => f.frame === "f9" && /跨源/.test(f.coords)),
    JSON.stringify(sub.frames)
  );
}

console.log("\n\x1b[1msettleMs（DOM 沉降）\x1b[0m");

function settlePage() {
  return makePage(
    [
      el("button", { id: "go", innerText: "加载更多", box: [0, 0, 80, 30] }),
      el("div", {
        id: "panel",
        role: "dialog",
        innerText: "面板正文",
        box: [200, 100, 400, 300],
        children: [el("button", { id: "apply", innerText: "面板里的按钮", box: [210, 200, 90, 30] })],
      }),
    ],
    { bodyText: "整页正文" }
  );
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  st.beforeInject = () => st.page.__mutate();
  const t0 = Date.now();
  const snap = await T.read_page({});
  const spent = Date.now() - t0;
  st.beforeInject = null;

  check("不传 settleMs 时不等待（立刻返回）", spent < 200, `${spent}ms`);
  check("不传 settleMs 时不装观察器（一次多余的注入都没有）", st.page.observers.length === 0, String(st.page.observers.length));
  check(
    "不传 settleMs 时返回值里没有任何 settle 字段",
    !Object.keys(snap).some((k) => k.startsWith("settle")),
    JSON.stringify(Object.keys(snap).filter((k) => k.startsWith("settle")))
  );
  check("不传 settleMs 时元素表和正文照常", snap.elements.length === 3 && snap.text === "整页正文", JSON.stringify(snap.text));

  for (const bad of [0, -500, "abc", null]) {
    const r = await T.read_page({ settleMs: bad });
    check(`settleMs=${JSON.stringify(bad)} 当作不等`, r.settleWaitedMs === undefined && st.page.observers.length === 0, JSON.stringify(r.settleWaitedMs));
  }
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const t0 = Date.now();
  const snap = await T.read_page({ settleMs: 120 });
  const spent = Date.now() - t0;

  check("静止的页面：等稳了才返回", snap.settleTimedOut === false, JSON.stringify(snap.settleTimedOut));
  check("如实报出等了多久，且不短于要求的 settleMs", snap.settleWaitedMs >= 120, `${snap.settleWaitedMs}ms`);
  check("回声 settleMs，方便对账", snap.settleMs === 120, String(snap.settleMs));
  check("等稳了就不该有超时提示和噪声帧", snap.settleHint === undefined && snap.settleNoisyFrames === undefined, JSON.stringify(snap.settleHint));
  check("静止的页面不会白等到预算（1000ms）见底", spent < 700, `${spent}ms`);
  check("等待期间照常出元素表和正文", snap.elements.length === 3 && snap.text === "整页正文", JSON.stringify(snap.elements.length));

  const obs = st.page.observers[0];
  check("观察的是整个 document", !!obs && obs.target === st.page.doc, String(obs && obs.target && obs.target.nodeType));
  check(
    "childList / subtree / attributes / characterData 都观察",
    obs.options.childList && obs.options.subtree && obs.options.attributes && obs.options.characterData,
    JSON.stringify(obs.options)
  );
  check("快照顺手把观察器拆了，不留在用户页面上", st.page.observers.every((o) => !o.connected), JSON.stringify(st.page.observers.map((o) => o.connected)));
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  st.beforeInject = () => st.page.__mutate();
  const t0 = Date.now();
  const snap = await T.read_page({ settleMs: 100 });
  const spent = Date.now() - t0;
  st.beforeInject = null;

  check("一直在变的页面：如实标 settleTimedOut", snap.settleTimedOut === true, JSON.stringify(snap.settleTimedOut));
  check("耗到总预算上限才放弃（settleMs×6，下限 1000ms）", spent >= 950 && spent < 2000, `${spent}ms`);
  check("总预算真的封顶，不会无限等下去", snap.settleWaitedMs < 2000, `${snap.settleWaitedMs}ms`);
  check("点名到最后还在变的是哪一帧", JSON.stringify(snap.settleNoisyFrames) === '["top"]', JSON.stringify(snap.settleNoisyFrames));
  check("超时也照常给出快照，而不是报错", snap.elements.length === 3 && snap.text === "整页正文", JSON.stringify(snap.elements.length));
  check("超时提示指路 browser_wait_for", /browser_wait_for/.test(snap.settleHint || ""), snap.settleHint);
  check("超时提示说清这份快照可能是旧的", /还没稳定/.test(snap.settleHint || ""), snap.settleHint);
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.beforeInject = () => st.page.__mutate("characterData");
  const snap = await T.read_page({ settleMs: 100 });
  st.beforeInject = null;
  check("characterData 变动照样重置计时（倒计时/流式文字不会被当成稳定）", snap.settleTimedOut === true, JSON.stringify(snap.settleTimedOut));
}

{
  const st = freshState();
  st.page = settlePage();
  st.page.win.MutationObserver = class {
    constructor() {
      throw new Error("MutationObserver is not available");
    }
  };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({ settleMs: 100 });
  check("观察器装不上时不谎报稳定", snap.settleTimedOut === true, JSON.stringify(snap.settleTimedOut));
  check("如实说明是这一帧观察不了", /无法观察/.test(JSON.stringify(snap.settleNoisyFrames)), JSON.stringify(snap.settleNoisyFrames));
  check("装不上也照常出快照，不把 read_page 搞崩", snap.elements.length === 3 && snap.text === "整页正文", JSON.stringify(snap.elements.length));
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const sub = await T.read_page({ container: "#panel", settleMs: 80 });
  const names = sub.elements.map((e) => e.name);
  check("settleMs + container：子树限定照常生效", names.includes("面板里的按钮") && !names.includes("加载更多"), JSON.stringify(names));
  check("settleMs + container：正文也还是子树的", sub.text === "面板正文", JSON.stringify(sub.text));
  check("settleMs + container：等待结果照常报出来", sub.settleTimedOut === false && sub.settleWaitedMs >= 80, JSON.stringify(sub.settleWaitedMs));
  check("settleMs + container：观察的仍是整个 document，不是那个容器", st.page.observers[0].target === st.page.doc, String(st.page.observers[0].target.nodeType));

  const rr = await T.refresh_refs({ container: "#panel", settleMs: 60 });
  check("refresh_refs 也认 settleMs", rr.settleTimedOut === false && rr.settleWaitedMs >= 60, JSON.stringify(rr.settleWaitedMs));
  check("refresh_refs 照旧不带正文", rr.text === undefined && rr.elements.length === 2, JSON.stringify(rr.elements.map((e) => e.name)));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([el("button", { id: "outer", innerText: "外层按钮", box: [0, 0, 80, 30] }), iframeEl]);
  const child = makePage([el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
    bodyText: "帧内正文",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  st.beforeInject = () => child.__mutate();
  const snap = await T.read_page({ settleMs: 100 });
  st.beforeInject = null;

  check("顶层稳了但 iframe 还在变，不算稳", snap.settleTimedOut === true, JSON.stringify(snap.settleTimedOut));
  check("点名是 f7 在变，顶层不背锅", JSON.stringify(snap.settleNoisyFrames) === '["f7"]', JSON.stringify(snap.settleNoisyFrames));
  check("两个帧各自装了观察器", st.page.observers.length === 1 && child.observers.length === 1, `${st.page.observers.length}/${child.observers.length}`);
  check("超时也照常读到 iframe 里的元素", snap.elements.some((e) => e.ref === "ref_1@f7"), JSON.stringify(snap.elements.map((e) => e.ref)));

  const ok = await T.read_page({ settleMs: 80 });
  check("两个帧都安静时判为稳定", ok.settleTimedOut === false, JSON.stringify(ok.settleTimedOut));
  check("拆观察器时两个帧都拆了", [...st.page.observers, ...child.observers].every((o) => !o.connected), "");
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "按钮", box: [100, 100, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.click({ x: 140, y: 115 });
  check("坐标点击会报出打在什么元素上", /<button id="b">/.test(r.hit || ""), r.hit);
  const bad = await throws(() => T.click({ x: 5000, y: 10 }), /视口之外/);
  check("视口外的坐标被拦下", bad.threw && bad.match, bad.msg);
  check("并建议改用 ref", /browser_read_page/.test(bad.msg), bad.msg);
}

{
  const st = freshState();
  st.page = makePage([el("input", { id: "i", type: "text", disabled: true, box: [0, 0, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;
  const r = await throws(() => T.type_text({ ref: "ref_1", text: "x" }), /不可操作（disabled）/);
  check("往禁用输入框打字被拦下", r.threw && r.match, r.msg);
  check("被拦下时没有下发 insertText", !st.cdp.some((c) => c.method === "Input.insertText"), JSON.stringify(st.cdp.map((c) => c.method)));
}

console.log("\n\x1b[1m沉降观察器：谁来收摊、什么不算变动\x1b[0m");

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.find({ query: "加载更多", settleMs: 60 });

  const obs = st.page.observers;
  check("find({settleMs}) 确实装了观察器", obs.length === 1, String(obs.length));
  const naps = st.page.win.__timers.filter((t) => t.ms >= 30000);
  check("安静的页面上也排了自拆定时器（不然它永远拆不掉）", naps.length === 1, JSON.stringify(st.page.win.__timers.map((t) => t.ms)));
  st.page.win.__runTimer(30000);
  check("定时器到点就把观察器拆了", obs.every((o) => !o.connected), JSON.stringify(obs.map((o) => o.connected)));
  check("拆完页面上的沉降状态也清空", !st.page.win.__aicSettle, JSON.stringify(!!st.page.win.__aicSettle));
}

{
  const st = freshState();
  st.page = settlePage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({ settleMs: 60 });
  check("read_page 之后观察器已经拆了（快照顺手拆，不多花往返）", st.page.observers.every((o) => !o.connected), "");
  check("拆的时候把自拆定时器一并撤掉，不留悬空定时器", st.page.win.__timers.filter((t) => t.ms >= 30000).length === 0, JSON.stringify(st.page.win.__timers.map((t) => t.ms)));
}

{
  const st = freshState();
  const cursor = el("div", { id: "__aic_cursor__", box: [0, 0, 12, 12] });
  st.page = makePage([el("button", { id: "go", innerText: "加载更多", box: [0, 0, 80, 30] }), cursor]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.beforeInject = () => st.page.__mutate("childList", cursor);
  const snap = await T.read_page({ settleMs: 100 });
  st.beforeInject = null;
  check("光标覆盖层自己的变动不推迟沉降", snap.settleTimedOut === false, JSON.stringify([snap.settleTimedOut, snap.settleNoisyFrames]));

  const st2 = freshState();
  const cursor2 = el("div", { id: "__aic_cursor__", box: [0, 0, 12, 12] });
  const btn2 = el("button", { id: "go", innerText: "加载更多", box: [0, 0, 80, 30] });
  st2.page = makePage([btn2, cursor2]);
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  st2.beforeInject = () => st2.page.__mutate("childList", btn2);
  const snap2 = await T2.read_page({ settleMs: 100 });
  st2.beforeInject = null;
  check("误报闸：页面自己在变时照旧判为没稳", snap2.settleTimedOut === true, JSON.stringify(snap2.settleTimedOut));
}

console.log("\n\x1b[1m元素表的名额：名字截断与非交互角色\x1b[0m");

{
  const long = "很长的说明文字".repeat(40);
  const st = freshState();
  st.page = makePage([
    el("input", { id: "a", type: "text", box: [0, 0, 200, 30], labels: [{ textContent: long }] }),
    el("input", { id: "b", type: "text", placeholder: long, box: [0, 40, 200, 30] }),
    el("input", { id: "c", type: "submit", value: long, box: [0, 80, 200, 30] }),
    el("img", { id: "d", alt: long, box: [0, 120, 60, 60], attrs: { role: "button" } }),
    el("button", { id: "e", innerText: long, box: [0, 200, 200, 30] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const names = snap.elements.map((e) => e.name || "");
  check("label / placeholder / value / alt 这几条路也截到 120", names.every((n) => n.length <= 120), JSON.stringify(names.map((n) => n.length)));
  check("截断不等于丢掉：名字前半段还在", names.some((n) => n.startsWith("很长的说明文字")), JSON.stringify(names.map((n) => n.slice(0, 12))));
}

{
  const st = freshState();
  st.page = makePage([
    el("div", { id: "l", innerText: "一个列表", box: [0, 0, 300, 20], attrs: { role: "list" } }),
    el("div", { id: "li", innerText: "列表项", box: [0, 20, 300, 20], attrs: { role: "listitem" } }),
    el("div", { id: "p", innerText: "装饰", box: [0, 40, 300, 20], attrs: { role: "presentation" } }),
    el("div", { id: "g", innerText: "一组", box: [0, 60, 300, 20], attrs: { role: "group" } }),
    el("button", { id: "ok", innerText: "真按钮", box: [0, 80, 100, 30] }),
    el("div", { id: "t", innerText: "标签页", box: [0, 120, 100, 30], attrs: { role: "tab" } }),
    el("a", { id: "weird", innerText: "带 href 的列表项", href: "https://x.example.com/", box: [0, 160, 100, 30], attrs: { role: "listitem" } }),
    el("div", { id: "clicky", innerText: "自己挂了 onclick", box: [0, 200, 100, 30], attrs: { role: "group", onclick: "1" } }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const ids = snap.elements.map((e) => e.name);
  check("role=list / listitem / presentation / group 不占名额", !ids.includes("一个列表") && !ids.includes("列表项") && !ids.includes("装饰") && !ids.includes("一组"), JSON.stringify(ids));
  check("真正能点的照收", ids.includes("真按钮"), JSON.stringify(ids));
  check("拿不准的角色（tab）不动它，照收", ids.includes("标签页"), JSON.stringify(ids));
  check("误伤闸：<a href> 写了 role=listitem 也照收", ids.includes("带 href 的列表项"), JSON.stringify(ids));
  check("误伤闸：挂了 onclick 的 role=group 也照收", ids.includes("自己挂了 onclick"), JSON.stringify(ids));
  check("elementsTotal 也不把它们算进去（调用方据它调 maxElements）", snap.elementsTotal === snap.elements.length, `${snap.elementsTotal}/${snap.elements.length}`);
}

{
  const st = freshState();
  const iframeEl = el("iframe", {
    id: "x",
    src: "https://other.example/x",
    box: [200, 300, 420, 200],
    clientLeft: 20,
    clientTop: 0,
    style: { borderLeftWidth: "20px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" },
  });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
    innerWidth: 400,
    innerHeight: 200,
  });
  child.keepViewport = true;
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const inner = snap.elements.find((e) => e.name === "跨源帧内按钮");
  check("四条边不等宽的 iframe 不再被误判成缩放过", !!inner, JSON.stringify(snap.frames));
  const r = await T.click({ ref: "ref_1@f9" }).catch((e) => ({ threw: String(e.message) }));
  check("帧内按钮点得到，坐标从内容盒原点算（200+20, 300+0）", r.at && r.at[0] === 280 && r.at[1] === 330, JSON.stringify(r).slice(0, 160));
}

console.log("\n\x1b[1mShadow DOM 与 iframe 穿透\x1b[0m");

{
  const st = freshState();
  const deepBtn = el("button", { id: "deep", innerText: "深层影子按钮", box: [10, 300, 90, 30] });
  const midHost = el("div", { id: "mid", box: [10, 300, 90, 30], shadow: [deepBtn] });
  st.page = makePage([
    el("button", { id: "plain", innerText: "普通按钮", box: [0, 0, 80, 30] }),
    el("div", {
      id: "host",
      box: [10, 100, 90, 30],
      shadow: [el("button", { id: "shadow-btn", innerText: "影子按钮", box: [10, 100, 90, 30] })],
    }),
    el("div", { id: "host2", box: [10, 300, 90, 30], shadow: [midHost] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const names = snap.elements.map((e) => e.name);
  check("read_page 看得见 Shadow DOM 里的按钮", names.includes("影子按钮"), JSON.stringify(names));
  check("嵌套 shadow root 也穿得到底", names.includes("深层影子按钮"), JSON.stringify(names));
  check("shadow 内元素被标了 inShadow", snap.elements.filter((e) => e.inShadow).length === 2, JSON.stringify(snap.elements));

  const shadowRef = snap.elements.find((e) => e.name === "影子按钮").ref;
  const r = await T.click({ ref: shadowRef });
  check("能点中 Shadow DOM 里的按钮", r.at[0] === 55 && r.at[1] === 115, JSON.stringify(r.at));
  check("命中测试穿透了 shadow 边界（命中的是影子按钮本身）", /id="shadow-btn"/.test(r.hit || ""), r.hit);

  const deepRef = snap.elements.find((e) => e.name === "深层影子按钮").ref;
  const r2 = await T.click({ ref: deepRef });
  check("能点中嵌套 shadow 里的按钮", /id="deep"/.test(r2.hit || ""), r2.hit);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([el("button", { id: "outer", innerText: "外层按钮", box: [0, 0, 80, 30] }), iframeEl]);
  const child = makePage([el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
    bodyText: "帧内正文 marker-in-frame",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const inner = snap.elements.find((e) => e.name === "帧内按钮");
  check("read_page 看得见 iframe 里的按钮", !!inner, JSON.stringify(snap.elements));
  check("iframe 内的 ref 带帧号", inner.ref === "ref_1@f7", inner.ref);
  check("iframe 内元素的坐标换算到了顶层视口", JSON.stringify(inner.box) === JSON.stringify([60, 120, 80, 30]), JSON.stringify(inner.box));
  check("正文包含 iframe 里的文字", (snap.text || "").includes("marker-in-frame"), snap.text);
  check("frames 里如实列出子帧", (snap.frames || []).some((f) => f.frame === "f7" && f.coords === "精确"), JSON.stringify(snap.frames));

  const r = await T.click({ ref: "ref_1@f7" });
  check("点 iframe 内的按钮：坐标 = 帧内坐标 + iframe 偏移", r.at[0] === 100 && r.at[1] === 135, JSON.stringify(r.at));
  check("返回值标出了它在哪个帧", r.frame === "f7", JSON.stringify(r));

  const bad = await throws(() => T.click({ ref: "ref_1@f99" }), /注入失败|没有返回结果/);
  check("指向不存在的帧时报错而不是打在别处", bad.threw && bad.match, bad.msg);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([
    iframeEl,
    el("div", { id: "cookie-banner", innerText: "我们使用 Cookie", box: [0, 0, 800, 600] }),
  ]);
  const child = makePage([el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1@f7" }), /不可操作（occluded）/);
  check("外层遮罩盖住 iframe 时也拦得下（帧内看不见这个遮罩）", r.threw && r.match, r.msg);
  check("点名了外层那个遮挡物", /cookie-banner/.test(r.msg), r.msg);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([
    iframeEl,
    el("div", { id: "cookie-banner", innerText: "我们使用 Cookie", box: [0, 0, 800, 600] }),
  ]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];
  st.cdpFail = (m) => (m === "DOM.getNodeForLocation" ? "No node found at given location" : null);

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "ref_1@f9" }), /不可操作（occluded）/);
  check("深检查用不了时，跨源帧被外层遮罩盖住照样拦得下", r.threw && r.match, r.msg);
  check("拦下时点名了遮挡物，而不是含糊带过", /cookie-banner/.test(r.msg), r.msg);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];
  st.cdpFail = (m) => (m === "DOM.getNodeForLocation" ? "No node found at given location" : null);

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await T.click({ ref: "ref_1@f9" });
  check("没有遮罩时，深检查用不了也照常点得下去", r.at[0] === 260 && r.at[1] === 330, JSON.stringify(r).slice(0, 160));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  const inner = snap.elements.find((e) => e.name === "跨源帧内按钮");
  check("跨源 iframe 里的元素也能被看见", !!inner && inner.ref === "ref_1@f9", JSON.stringify(snap.elements));
  check("跨源帧坐标标注为由父帧推算", (snap.frames || []).some((f) => f.frame === "f9" && /跨源/.test(f.coords)), JSON.stringify(snap.frames));
  const r = await T.click({ ref: "ref_1@f9" });
  check("跨源 iframe 内的按钮点得到（坐标由父帧推算）", r.at[0] === 260 && r.at[1] === 330, JSON.stringify(r.at));
  check("如实标注坐标是推算来的", r.coordsViaParent === true, JSON.stringify(r));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/first", box: [200, 300, 400, 150] });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/after-redirect",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check(
    "src 与当前地址对不上也能定位（身份靠握手，不靠 URL）",
    (snap.frames || []).some((f) => f.frame === "f9" && /跨源/.test(f.coords)),
    JSON.stringify(snap.frames)
  );
  const r = await T.click({ ref: "ref_1@f9" });
  check("自己跳转过的跨源帧照样点得到", r.at[0] === 260 && r.at[1] === 330, JSON.stringify(r.at));
}

{
  const st = freshState();
  const a = el("iframe", { id: "a", src: "https://other.example/same", box: [0, 0, 200, 100] });
  const b = el("iframe", { id: "b", src: "https://other.example/same", box: [400, 0, 200, 100] });
  st.page = makePage([a, b]);
  const ca = makePage([el("button", { id: "ba", innerText: "A 帧按钮", box: [10, 10, 80, 30] })], { url: "https://other.example/same" });
  const cb = makePage([el("button", { id: "bb", innerText: "B 帧按钮", box: [10, 10, 80, 30] })], { url: "https://other.example/same" });
  nestFrame(st.page, a, ca, { sameOrigin: false });
  nestFrame(st.page, b, cb, { sameOrigin: false });
  st.subFrames = [
    { frameId: 21, page: ca },
    { frameId: 22, page: cb },
  ];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const ra = await T.click({ ref: "ref_1@f21" });
  const rb = await T.click({ ref: "ref_1@f22" });
  check("同 src 的两个跨源帧各算各的坐标", ra.at[0] === 50 && rb.at[0] === 450, `${JSON.stringify(ra.at)} ${JSON.stringify(rb.at)}`);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], { url: "https://other.example/x" });
  const evil = makePage([el("button", { id: "evil", innerText: "冒名帧按钮", box: [0, 0, 50, 20] })], { url: "https://evil.example/" });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  evil.win.top = st.page.win.top;
  Object.defineProperty(evil.win, "frameElement", {
    get() {
      throw new Error("SecurityError");
    },
    configurable: true,
  });
  const real = iframeEl.contentWindow;
  iframeEl.contentWindow = {
    postMessage: (d) => {
      real.postMessage(d);
      evil.win.postMessage(d);
    },
  };
  st.subFrames = [
    { frameId: 9, page: child },
    { frameId: 10, page: evil },
  ];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check(
    "同一个 token 被多个帧报上来时判为不可信",
    (snap.frames || []).filter((f) => f.coords === "未知").length === 2,
    JSON.stringify(snap.frames)
  );
  const r = await throws(() => T.click({ ref: "ref_1@f9" }), /算不出它在顶层页面里的坐标/);
  check("身份存疑时点击直接报错，绝不猜坐标", r.threw && r.match, r.msg);
  check("报错给了绕路方案（直接开那个地址）", /browser_new_tab/.test(r.msg), r.msg);
}

{
  const st = freshState();
  const iframeEl = el("iframe", {
    id: "x",
    src: "https://other.example/x",
    box: [200, 300, 400, 150],
    style: { transform: "matrix(1, 0.35, 0, 1, 0, 0)" },
  });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], { url: "https://other.example/x" });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("被旋转/斜切的 iframe 标成坐标未知", (snap.frames || []).some((f) => f.frame === "f9" && f.coords === "未知"), JSON.stringify(snap.frames));
  check("并说清楚是变换导致的", /旋转|斜切/.test((snap.frames || []).find((f) => f.frame === "f9")?.note || ""), JSON.stringify(snap.frames));
  const r = await throws(() => T.click({ ref: "ref_1@f9" }), /旋转|斜切/);
  check("变换过的帧里的元素点击直接报错", r.threw && r.match, r.msg);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 200, 75] });
  st.page = makePage([iframeEl]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], { url: "https://other.example/x" });
  child.keepViewport = true;
  child.win.innerWidth = 400;
  child.win.innerHeight = 150;
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("被缩放的 iframe 标成坐标未知", (snap.frames || []).some((f) => f.frame === "f9" && f.coords === "未知"), JSON.stringify(snap.frames));
  check("并报出外面量到多少、帧内自报多少", /缩放/.test((snap.frames || []).find((f) => f.frame === "f9")?.note || ""), JSON.stringify(snap.frames));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "hidden-f", src: "https://example.com/ad", box: [0, 0, 0, 0], style: { display: "none" } });
  st.page = makePage([el("button", { id: "real", innerText: "真按钮", box: [0, 0, 80, 30] }), iframeEl]);
  const child = makePage([el("button", { id: "ad", innerText: "广告按钮", box: [0, 0, 200, 60] })], {
    url: "https://example.com/ad",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 11, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({});
  check("隐藏 iframe 里的元素不混进元素表", !snap.elements.some((e) => e.name === "广告按钮"), JSON.stringify(snap.elements.map((e) => e.name)));
  check("但会在 frames 里说明被跳过了", (snap.frames || []).some((f) => f.frame === "f11" && /不可见/.test(f.skipped || "")), JSON.stringify(snap.frames));
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "x", box: [0, 0, 50, 20] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  const r = await throws(() => T.click({ ref: "元素3" }), /ref 格式不对/);
  check("乱七八糟的 ref 给出格式说明", r.threw && r.match && /ref_3@f7/.test(r.msg), r.msg);
}

console.log("\n\x1b[1mselector 寻址\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("button", { id: "apply", innerText: "应用筛选", box: [100, 200, 80, 40] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  const r = await T.click({ selector: "#apply" });
  const mouse = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent");
  check("没先 read_page 也能按 selector 点", /应用筛选/.test(r.clicked), r.clicked);
  check("落点和按 ref 算出来的一样（元素中心）", r.at[0] === 140 && r.at[1] === 220, JSON.stringify(r.at));
  check("selector 下发的还是 move/press/release 三步可信事件", mouse.length === 3, JSON.stringify(mouse.map((m) => m.params.type)));
  check("selector 也走点后验命中", r.verified === "hit", JSON.stringify(r));
  check("返回里带上解析出来的 ref", r.ref === "ref_1", JSON.stringify(r));
  check("返回里带上 matchCount", r.matchCount === 1, JSON.stringify(r));
  check("clicked 里说清了是按 selector 点的", /selector/.test(r.clicked), r.clicked);

  const snap = await T.read_page({});
  check("selector 登记的号和 read_page 给的是同一个（共用一张 ref 表）", snap.elements[0].ref === "ref_1", JSON.stringify(snap.elements));
  const again = await T.click({ ref: r.ref });
  check("selector 报出来的 ref 后续能直接拿去点", /应用筛选/.test(again.clicked), again.clicked);
}

{
  const st = freshState();
  st.page = makePage([
    el("button", { id: "a", innerText: "一", box: [0, 0, 50, 20] }),
    el("button", { id: "b", innerText: "二", box: [0, 30, 50, 20] }),
    el("button", { id: "apply", innerText: "应用筛选", box: [0, 60, 50, 20] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const snap = await T.read_page({ maxElements: 2 });
  check(
    "超出上限的元素在 read_page 里根本没有 ref（海德堡那 593 个元素的处境）",
    snap.elements.length === 2 && !snap.elements.some((e) => e.name === "应用筛选"),
    JSON.stringify(snap.elements.map((e) => e.name))
  );
  const r = await T.click({ selector: "#apply" });
  check("拿不到 ref 的元素，selector 照样点得到并验中", /应用筛选/.test(r.clicked) && r.verified === "hit", JSON.stringify(r));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "apply", innerText: "应用筛选", box: [0, 0, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  const r = await throws(() => T.click({ selector: "#nope" }), /一个元素都没匹配到/);
  check("选择器没匹配到时明确报错", r.threw && r.match, r.msg);
  check("报错说清页面没有被动过", /没有点任何东西|没有任何变化/.test(r.msg), r.msg);
  check("报错说清找过哪些地方（主文档/shadow/iframe）", /主文档/.test(r.msg) && /iframe/.test(r.msg), r.msg);
  check("报错给了下一步（怎么确认选择器）", /browser_eval|browser_read_page/.test(r.msg), r.msg);
  check(
    "没匹配到时一个鼠标事件都没下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  st.page = makePage([
    el("button", { attrs: { class: "apply" }, innerText: "隐藏的副本", box: [0, 0, 80, 30], style: { display: "none" } }),
    el("button", { attrs: { class: "apply" }, innerText: "真正要点的", box: [100, 200, 80, 40] }),
    el("button", { attrs: { class: "apply" }, innerText: "再后面一个", box: [0, 300, 80, 30] }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const r = await T.click({ selector: ".apply" });
  check("匹配到多个时点的是第一个**可见**的", /真正要点的/.test(r.clicked), r.clicked);
  check("落点是那个可见元素的中心", r.at[0] === 140 && r.at[1] === 220, JSON.stringify(r.at));
  check("matchCount 如实报出一共匹配到几个（提示选择器不够精确）", r.matchCount === 3, JSON.stringify(r));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "apply", innerText: "应用筛选", box: [0, 0, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  const r = await throws(() => T.click({ selector: "button[" }), /不是合法的 CSS 选择器/);
  check("语法不对的选择器单独报错，不混同于「没匹配到」", r.threw && r.match, r.msg);
  check("并说清该写成什么形式", /document\.querySelector/.test(r.msg), r.msg);
  check(
    "语法错时也一个鼠标事件都没下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "apply", innerText: "应用筛选", box: [0, 0, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;

  const both = await throws(() => T.click({ ref: "ref_1", selector: "#apply" }), /只能给一个/);
  check("ref 和 selector 同时给会被拦下", both.threw && both.match, both.msg);
  check("报错点名了收到的是哪两个", /ref/.test(both.msg) && /selector/.test(both.msg), both.msg);
  check("报错说清各自该在什么时候用", /超出.*上限|拿不到 ref/.test(both.msg), both.msg);

  const withXY = await throws(() => T.click({ selector: "#apply", x: 10, y: 10 }), /只能给一个/);
  check("selector 和 x/y 同时给也被拦下", withXY.threw && withXY.match, withXY.msg);

  check(
    "互斥被拦下时一个鼠标事件都没下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );

  const none = await throws(() => T.click({}), /需要 ref 或 x\/y/);
  check("三个都不给时的报错也提到 selector 这条路", none.threw && /selector/.test(none.msg), none.msg);

  const halfXY = await throws(() => T.click({ ref: "ref_1", x: 5 }), /只能给一个/);
  check("ref 加半个坐标也算给了两种寻址", halfXY.threw && halfXY.match, halfXY.msg);
  const lonelyX = await throws(() => T.click({ x: 5 }), /成对/);
  check("只给 x 不给 y 时说清坐标要成对", lonelyX.threw && lonelyX.match, lonelyX.msg);
}

{
  const st = freshState();
  st.page = coveredPage();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  const r = await throws(() => T.click({ selector: "#target" }), /不可操作（occluded）/);
  check("selector 寻址照样过遮挡检查（不是降级路径）", r.threw && r.match, r.msg);
  check("报错点名了遮挡物", /overlay/.test(r.msg), r.msg);
  check("报错里称呼的是 selector 而不是凭空冒出来的号", /selector "#target"/.test(r.msg), r.msg);
  check("同时给出对应的 ref，方便接着排查", /ref_1/.test(r.msg), r.msg);
  check(
    "被拦下时一个鼠标事件都没下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "apply", innerText: "应用筛选", box: [0, 0, 80, 30], disabled: true })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await throws(() => T.click({ selector: "#apply" }), /不可操作（disabled）/);
  check("selector 指到禁用元素时照样拦下", r.threw && r.match, r.msg);
  check("报错说清点了也不会触发任何处理函数", /不会触发任何处理函数/.test(r.msg), r.msg);
}

{
  const st = freshState();
  st.page = makePage([
    el("div", {
      id: "host",
      box: [10, 100, 90, 30],
      shadow: [el("button", { id: "shadow-apply", innerText: "影子里的按钮", box: [10, 100, 90, 30] })],
    }),
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.click({ selector: "#shadow-apply" });
  check("querySelectorAll 穿不透 shadow，实现会补一趟深度遍历", /影子里的按钮/.test(r.clicked), r.clicked);
  check("影子里的元素落点正确", r.at[0] === 55 && r.at[1] === 115, JSON.stringify(r.at));
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 100, 300, 200] });
  st.page = makePage([el("button", { id: "outer", innerText: "外层按钮", box: [0, 0, 80, 30] }), iframeEl]);
  const child = makePage([el("button", { id: "inner", innerText: "帧内按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.click({ selector: "#inner" });
  check("主文档里没有就去 iframe 里找", /帧内按钮/.test(r.clicked), r.clicked);
  check("解析出来的 ref 带帧号", r.ref === "ref_1@f7", JSON.stringify(r));
  check("坐标 = 帧内坐标 + iframe 偏移", r.at[0] === 100 && r.at[1] === 135, JSON.stringify(r.at));
  check("返回值标出了它在哪个帧", r.frame === "f7", JSON.stringify(r));
}

{
  const st = freshState();
  const f1 = el("iframe", { id: "f1", src: "https://a.example/one", box: [0, 0, 300, 200] });
  const f2 = el("iframe", { id: "f2", src: "https://b.example/two", box: [0, 220, 300, 200] });
  st.page = makePage([f1, f2]);
  const c1 = makePage([el("button", { id: "go", innerText: "帧一的按钮", box: [10, 10, 80, 30] })], {
    url: "https://a.example/one",
  });
  const c2 = makePage([el("button", { id: "go", innerText: "帧二的按钮", box: [10, 10, 80, 30] })], {
    url: "https://b.example/two",
  });
  nestFrame(st.page, f1, c1);
  nestFrame(st.page, f2, c2);
  st.subFrames = [
    { frameId: 7, page: c1 },
    { frameId: 9, page: c2 },
  ];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  const r = await throws(() => T.click({ selector: "#go" }), /在 2 个 iframe 里都匹配到了/);
  check("多个 iframe 同时匹配时拦下，不随便挑一个", r.threw && r.match, r.msg);
  check("报错列出候选帧和现成可用的 ref", /ref_1@f7/.test(r.msg) && /ref_1@f9/.test(r.msg), r.msg);
  check("报错点名了各自的地址", /a\.example/.test(r.msg) && /b\.example/.test(r.msg), r.msg);
  check(
    "被拦下时一个鼠标事件都没下发",
    st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "f", src: "https://example.com/frame", box: [50, 300, 300, 200] });
  st.page = makePage([el("button", { id: "go", innerText: "主文档的按钮", box: [100, 200, 80, 40] }), iframeEl]);
  const child = makePage([el("button", { id: "go", innerText: "帧内的按钮", box: [10, 20, 80, 30] })], {
    url: "https://example.com/frame",
  });
  nestFrame(st.page, iframeEl, child);
  st.subFrames = [{ frameId: 7, page: child }];

  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.click({ selector: "#go" });
  check("主文档和 iframe 都匹配时用主文档那个", /主文档的按钮/.test(r.clicked), r.clicked);
  check("如实报出别的帧里也有匹配", (r.otherRefs || []).includes("ref_1@f7"), JSON.stringify(r));
  check("matchCount 是跨帧的总数", r.matchCount === 2, JSON.stringify(r));
}

console.log("");

{
  const st = freshState();
  st.page = makePage([el("input", { type: "text", box: [0, 0, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});
  st.cdp.length = 0;

  await T.type_text({ ref: "ref_1", text: "hello", clear: true, pressEnter: true });
  const kinds = st.cdp.map((c) => c.method);
  check("输入前先点进输入框", kinds.includes("Input.dispatchMouseEvent"));
  check("clear 触发了全选", st.cdp.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "a" && c.params.modifiers === 4));
  check("文本用 insertText 下发", st.cdp.some((c) => c.method === "Input.insertText" && c.params.text === "hello"));
  check("pressEnter 补了回车", st.cdp.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Enter"));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;

  await T.press_key({ key: "Tab" });
  const ev = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("按键下发 keyDown + keyUp", ev.length === 2 && ev[1].params.type === "keyUp");
  check("按键带 windowsVirtualKeyCode", ev[0].params.windowsVirtualKeyCode === 9);

  st.cdp.length = 0;
  await T.press_key({ key: "ArrowDown", modifiers: ["shift", "meta"] });
  const keyEv = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("修饰键合成正确的位掩码", keyEv[0]?.params.modifiers === 12, String(keyEv[0]?.params.modifiers));

  const bad = await throws(() => T.press_key({ key: "F13" }), /不支持的按键/);
  check("不支持的按键列出可用值", bad.threw && bad.match && /Enter/.test(bad.msg), bad.msg);

  st.cdp.length = 0;
  await T.press_key({ key: "/" });
  let ke = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("「/」发得出来（聚焦搜索的头号快捷键）", ke.length === 2 && ke[0].params.code === "Slash" && ke[0].params.windowsVirtualKeyCode === 191, JSON.stringify(ke[0]?.params));

  st.cdp.length = 0;
  await T.press_key({ key: "k", modifiers: ["meta"] });
  ke = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("Cmd+K 命令面板发得出来", ke[0].params.code === "KeyK" && ke[0].params.modifiers === 4, JSON.stringify(ke[0]?.params));

  st.cdp.length = 0;
  await T.press_key({ key: "A" });
  ke = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("大写字母隐含 Shift", ke[0].params.modifiers === 8 && ke[0].params.code === "KeyA", JSON.stringify(ke[0]?.params));

  st.cdp.length = 0;
  await T.press_key({ key: "F5" });
  ke = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("F 键发得出来", ke[0].params.code === "F5" && ke[0].params.windowsVirtualKeyCode === 116, JSON.stringify(ke[0]?.params));
}

{
  const st = freshState();
  st.page = makePage([el("input", { type: "text", box: [0, 0, 200, 30], attrs: { "aria-label": "搜索框" } })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});

  st.cdp.length = 0;
  const r = await T.press_key({ key: "Enter", ref: "ref_1" });
  const io = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent" || c.method === "Input.dispatchKeyEvent");
  check("带 ref 时先聚焦目标（走 click 那条完整管线）再发键",
    io[0]?.method === "Input.dispatchMouseEvent" && io.some((c) => c.method === "Input.dispatchKeyEvent"),
    JSON.stringify(io.map((c) => c.method)));
  check("键确实发出去了（keyDown + keyUp）",
    st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").length === 2,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params.type)));
  check("返回值说清焦点落到了谁身上", /^ref_1 <input>/.test(r.focused || ""), JSON.stringify(r));
  check("focused 里的可访问名是页面写的，进 _fromPage 清单", (r._fromPage || []).includes("focused"), JSON.stringify(r._fromPage));

  st.cdp.length = 0;
  const bare = await T.press_key({ key: "Escape" });
  check("不给 ref 时一次都不点（不抢焦点）",
    !st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"),
    JSON.stringify(st.cdp.map((c) => c.method)));
  check("不给 ref 时返回值里没有 focused（没聚焦就不许说聚焦了）",
    !("focused" in bare) && !("_fromPage" in bare), JSON.stringify(bare));
  check("不给 ref 时照旧 keyDown + keyUp", st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").length === 2);

  const a = await throws(() => T.press_key({ key: "Enter", ref: "ref_zzz" }), /ref 格式不对/);
  const b = await throws(() => T.type_text({ ref: "ref_zzz", text: "x" }), /ref 格式不对/);
  check("press_key 的 ref 无效时报错与 browser_type 同口径", a.threw && a.msg === b.msg, `${a.msg}\n${b.msg}`);
  const gone = await throws(() => T.press_key({ key: "Enter", ref: "ref_99" }), /read_page/);
  check("ref 指不到元素时报错，不是默默打给 body", gone.threw && gone.match, gone.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  await T.click({ x: 10, y: 10, force: true });
  const me = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent");
  const press = me.find((m) => m.params.type === "mousePressed");
  const rel = me.find((m) => m.params.type === "mouseReleased");
  check("mousePressed 带 buttons=1", press?.params.buttons === 1, JSON.stringify(press?.params));
  check("mouseReleased 时 buttons 归 0", rel?.params.buttons === 0, JSON.stringify(rel?.params));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  await T.screenshot({});
  const seq = st.cdp.map((c) => c.method);
  check("截图收尾补 Animation.disable", seq.includes("Animation.disable"), JSON.stringify(seq.filter((m) => /Animation/.test(m))));
  const restoreIdx = st.cdp.findIndex((c) => c.method === "Animation.setPlaybackRate" && c.params.playbackRate === 1);
  check(
    "顺序：先恢复 playbackRate 再 disable（文档没说 disable 会不会重置 rate）",
    restoreIdx >= 0 && seq.lastIndexOf("Animation.disable") > restoreIdx,
    JSON.stringify(seq.filter((m) => /Animation/.test(m)))
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  st.cdp.length = 0;
  await T.type_text({ text: "ab" });
  check(
    "默认仍走 insertText（快，且是可信输入）",
    st.cdp.some((c) => c.method === "Input.insertText") && !st.cdp.some((c) => c.method === "Input.dispatchKeyEvent"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );

  st.cdp.length = 0;
  await T.type_text({ text: "a1", perKey: true });
  const keys = st.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  check("perKey 逐字符发 keyDown+keyUp", keys.length === 4, JSON.stringify(keys.map((k) => k.params.type)));
  check("keyDown 带 text（否则字符进不了输入框）", keys[0].params.type === "keyDown" && keys[0].params.text === "a", JSON.stringify(keys[0].params));
  check("键位规格对（code/keyCode 三元组）", keys[2].params.code === "Digit1" && keys[2].params.windowsVirtualKeyCode === 49, JSON.stringify(keys[2].params));

  st.cdp.length = 0;
  await T.type_text({ text: "中a", perKey: true });
  check(
    "键位表外的字符（CJK）退回 insertText 单发，不硬造键位",
    st.cdp.some((c) => c.method === "Input.insertText" && c.params.text === "中") &&
      st.cdp.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.text === "a"),
    JSON.stringify(st.cdp.map((c) => [c.method, c.params.text]))
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  await T.scroll({ direction: "down", amount: 500 });
  const w = st.cdp.find((c) => c.method === "Input.dispatchMouseEvent");
  check("滚动用 mouseWheel", w.params.type === "mouseWheel" && w.params.deltaY === 500);
  const bad = await throws(() => T.scroll({ direction: "sideways" }), /只能是 up\/down/);
  check("非法方向被拒绝", bad.threw && bad.match, bad.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const shot = await T.screenshot({});
  check("截图返回 base64 和 mimeType", shot.image === "BASE64PNG" && shot.mimeType === "image/png");
  const jpg = await T.screenshot({ format: "jpeg", quality: 70 });
  const lastShot = () => st.cdp.filter((c) => c.method === "Page.captureScreenshot").at(-1).params;
  check("jpeg 透传 quality", jpg.mimeType === "image/jpeg" && lastShot().quality === 70);

  const zoom = await T.screenshot({ region: { x: 10, y: 20, width: 40, height: 30 } });
  const clip = lastShot().clip;
  check("region 变成 CDP 的 clip", clip && clip.x === 10 && clip.y === 20 && clip.width === 40 && clip.height === 30, JSON.stringify(clip));
  check("region 默认放大 2 倍", clip.scale === 2 && zoom.clip.scale === 2);
  await T.screenshot({ region: [1, 2, 3, 4], scale: 4 });
  check("region 也收数组写法", lastShot().clip.width === 3 && lastShot().clip.scale === 4);
  const badRegion = await throws(() => T.screenshot({ region: { x: 1, y: 2 } }), /width\/height/);
  check("region 缺宽高时报错而不是截了个空", badRegion.threw && badRegion.match, badRegion.msg);
  const loneScale = await throws(() => T.screenshot({ scale: 3 }), /只在给了 region/);
  check("不给取景参数只给 scale 时报错", loneScale.threw && loneScale.match, loneScale.msg);

  st.layoutMetrics = { cssContentSize: { width: 1200, height: 5000 }, cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
  const full = await T.screenshot({ fullPage: true });
  const fclip = lastShot();
  check("fullPage 用 getLayoutMetrics 量出整页尺寸", fclip.clip.width === 1200 && fclip.clip.height === 5000, JSON.stringify(fclip.clip));
  check("fullPage 打开 captureBeyondViewport", fclip.captureBeyondViewport === true, JSON.stringify(fclip.captureBeyondViewport));
  check("fullPage 不放大（整页再放大就爆了）", fclip.clip.scale === 1, String(fclip.clip.scale));
  check("返回里标明是整页", full.fullPage === true);

  const tall = await T.screenshot({ fullPage: true, maxHeight: 1000 });
  check("整页超高时按上限截并说清楚", lastShot().clip.height === 1000 && /超过上限/.test(tall.note || ""), tall.note);

  const conflict = await throws(() => T.screenshot({ fullPage: true, region: [0, 0, 10, 10] }), /只能给一个/);
  check("取景参数互斥", conflict.threw && conflict.match, conflict.msg);
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "确认", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const shot = await T.screenshot({});
  const evals = st.cdp.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params.expression));
  const rates = st.cdp.filter((c) => c.method === "Animation.setPlaybackRate").map((c) => c.params.playbackRate);
  check("截图前把动画按住（问浏览器，不注 CSS）", rates[0] === 0, JSON.stringify(rates));
  check("截完把动画放回去（不然页面上的动画永久停死）", rates.at(-1) === 1, JSON.stringify(rates));
  check("平滑滚动仍靠那半条 CSS 按住", evals.some((e) => /scroll-behavior:auto/.test(e)), JSON.stringify(evals.slice(0, 2)).slice(0, 160));
  check("截图前把文本光标藏掉", evals.some((e) => /caret-color:transparent/.test(e)));
  check("截图前等字体加载完", evals.some((e) => /fonts\.ready/.test(e)));
  check("截完把那张样式表摘掉（不留在用户页面上）", evals.some((e) => /remove\(\)/.test(e)), JSON.stringify(evals.at(-1)).slice(0, 120));
  check("按住了就什么都不说（正常路径不占位置）", !("stabilizeWarning" in shot), JSON.stringify(Object.keys(shot)));
  st.slowFonts = true;
  const slow = await T.screenshot({});
  check("字体没加载完时才出来说一句", /后备字体/.test(slow.stabilizeWarning || ""), slow.stabilizeWarning);
  st.slowFonts = false;

  st.cdp.length = 0;
  st.cursorPresent = true;
  await T.screenshot({});
  const cs = st.cdp.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params.expression));
  check("截图前把操作光标藏起来", cs.some((e) => /__aic_cursor__.*display *= *"none"/s.test(e)), JSON.stringify(cs).slice(0, 200));
  check("截完把操作光标放回来", /__aic_cursor__/.test(cs.at(-1) || "") && /display=""/.test(cs.at(-1) || ""), String(cs.at(-1)).slice(0, 160));

  st.cdp.length = 0;
  const raw = await T.screenshot({ stabilize: false });
  const evals2 = st.cdp.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params.expression));
  check("stabilize:false 时不按住页面", evals2.some((e) => /const STABILIZE = false/.test(e)), JSON.stringify(evals2).slice(0, 160));
  check("stabilize:false 也照样藏光标（这跟稳定化无关）", evals2.some((e) => /__aic_cursor__/.test(e)), JSON.stringify(evals2).slice(0, 160));
  check("stabilize:false 截完只还原光标，不去摘不存在的样式表", !/getElementById\("zs/.test(evals2.at(-1) || ""), String(evals2.at(-1)).slice(0, 160));
  check("stabilize:false 不谎称按住了", !raw.stabilizeWarning, JSON.stringify(raw));
  st.cursorPresent = false;

  const st2 = freshState({ layoutMetrics: { cssContentSize: { width: 1200, height: 9000 }, cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } } });
  st2.page = makePage([el("div", { innerText: "长页面", box: [0, 0, 1200, 9000] })]);
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  st2.screenshotData = (p) => {
    const c = p.clip || { width: 1200, height: 800, scale: 1 };
    const px = c.width * c.height * (c.scale || 1) ** 2;
    const perPx = p.format === "jpeg" ? 0.12 : 0.35;
    return "X".repeat(Math.max(100, Math.round(px * perPx)));
  };
  const capped = await T2.screenshot({ fullPage: true, maxBytes: 500_000 });
  check("超出体积上限时重截一张更小的", capped.image.length < 3_000_000, String(capped.image.length));
  check("重截会转成 jpeg 并缩小", capped.mimeType === "image/jpeg" && capped.clip.scale < 1, JSON.stringify(capped.clip));
  check("并说清楚发生了什么、怎么要回原清晰度", /超过上限/.test(capped.note || "") && /maxBytes/.test(capped.note || ""), capped.note);

  const st3 = freshState();
  st3.page = makePage([el("button", { innerText: "x", box: [0, 0, 10, 10] })]);
  const T3 = loadSw(st3);
  await T3.tab_use({ takeover: true, tabId: 1 });
  st3.cdpFail = (m) => (m === "Page.captureScreenshot" ? "Detached while handling command." : null);
  st3.tabs[0].active = true;
  const viaTabs = await T3.screenshot({});
  check("反复掉线时改走 captureVisibleTab", viaTabs.image === "BASE64VISIBLE", JSON.stringify(viaTabs).slice(0, 120));
  check("并说明这一张是怎么来的", /captureVisibleTab/.test(viaTabs.via || ""), viaTabs.via);
  st3.tabs[0].active = false;
  const cantFallback = await throws(() => T3.screenshot({}), /只拍\*\*正在显示\*\*的那张|正在显示/);
  check(
    "后台标签页用不了那条退路时说清替代做法（且不提任何抢前台的路子）",
    cantFallback.threw &&
      /browser_read_page/.test(cantFallback.msg) &&
      /browser_set_task_state/.test(cantFallback.msg) &&
      !/切到前台再截|tab_focus/.test(cantFallback.msg),
    cantFallback.msg
  );
}

{
  const st = freshState();
  st.page = makePage([el("input", { id: "u", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdpFail = (m) => (m === "Input.insertText" ? "Detached while handling command." : null);
  const r = await throws(() => T.type_text({ text: "abc" }), /Detached while handling command/);
  check("原话保留（排查时要认得出是哪条 CDP 错误）", r.threw && r.match, r.msg);
  check("明说这一步没做成，别当成做过了", /没有做成|不要当成做过/.test(r.msg), r.msg);
  check("点破最常见的成因是别的扩展塞进来的框架", /别的扩展|密码管理器/.test(r.msg), r.msg);
  check("告诉模型重试是对的（两种成因都会自愈）", /重试/.test(r.msg), r.msg);
  check("绝不自动重放输入（同一段文字不许打两遍）", st.cdp.filter((c) => c.method === "Input.insertText").length === 1, JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText")));
}

{
  const st = freshState({ viewport: { w: 800, h: 400 } });
  const deep = el("button", { innerText: "折线以下", box: [10, 1200, 80, 30] });
  deep.scrollIntoView = () => { deep._box = [10, 200, 80, 30]; };
  Object.defineProperty(deep, "_boxNow", { get: () => deep._box || [10, 1200, 80, 30] });
  st.page = makePage([deep]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "折线以下" });
  await T.click({ ref: f.matches[0].ref }).catch(() => {});
  const calls = st.cdp.filter((c) => c.method === "Runtime.callFunctionOn").map((c) => String(c.params.functionDeclaration));
  check(
    "落点还在视口外时会再用页面自己的 scrollIntoView 试一把",
    calls.some((c) => /scrollIntoView\(\{block:'center'/.test(c)),
    JSON.stringify(calls.map((c) => c.slice(0, 40)))
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "确认下单", box: [200, 300, 120, 40] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "确认下单" });
  const shot = await T.screenshot({ ref: f.matches[0].ref });
  const clip = st.cdp.filter((c) => c.method === "Page.captureScreenshot").at(-1).params.clip;
  check("ref 截图框住了元素本身（含一点边）", clip.x === 196 && clip.y === 296 && clip.width === 128 && clip.height === 48, JSON.stringify(clip));
  check("ref 截图默认放大 2 倍", clip.scale === 2 && shot.clip.scale === 2);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  let first = true;
  st.cdpFail = (method) => {
    if (method === "Page.captureScreenshot" && first) {
      first = false;
      return "Detached while handling command.";
    }
    return null;
  };
  const shot = await T.screenshot({});
  check("掉线后自动重连并重截成功", shot.image === "BASE64PNG", JSON.stringify(shot));
  check("重截之前真的重新 attach 过", st.attached.filter((a) => a === 1).length >= 2, JSON.stringify(st.attached));

  st.cdpFail = (method) => (method === "Page.captureScreenshot" ? "Some other failure" : null);
  const other = await throws(() => T.screenshot({}), /Some other failure/);
  check("非掉线的截图错误照常抛出", other.threw && other.match, other.msg);
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.eval_js({ expression: "window.x" });
  check("eval 取回值", JSON.stringify(r.value) === JSON.stringify({ rows: 3 }));
  check("eval_js 标注 value 来自页面", Array.isArray(r._fromPage) && r._fromPage.includes("value"), JSON.stringify(r._fromPage));
  const call = st.cdp.find((c) => c.method === "Runtime.evaluate" && !/__aicCursor/.test(c.params?.expression || ""));
  check("eval 用 returnByValue", call.params.returnByValue === true && call.params.awaitPromise === true);

  const st2 = freshState({ evalThrows: true });
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const bad = await throws(() => T2.eval_js({ expression: "boom" }), /ReferenceError/);
  check("页面异常被转成工具错误", bad.threw && bad.match, bad.msg);

  const noExpr = await throws(() => T.eval_js({}), /需要 expression/);
  check("缺 expression 时报错", noExpr.threw && noExpr.match, noExpr.msg);
}

{
  const st = freshState({ evalValue: "x".repeat(5000) });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const full = await T.eval_js({ expression: "s" });
  check("字符串结果原样返回且附带真实长度", full.value.length === 5000 && full.valueLength === 5000, `len=${full.value.length} valueLength=${full.valueLength}`);
  const part = await T.eval_js({ expression: "s", offset: 4990, length: 100 });
  check("offset+length 能取最后一块", part.value.length === 10 && part.offset === 4990 && part.hasMore === false, JSON.stringify({ n: part.value.length, o: part.offset, m: part.hasMore }));
  const head = await T.eval_js({ expression: "s", length: 10 });
  check("只给 length 时从头取，并标出还有更多", head.value.length === 10 && head.hasMore === true && head.valueLength === 5000, JSON.stringify({ n: head.value.length, m: head.hasMore }));
}
{
  const st = freshState({ evalResult: { result: { type: "object", value: {} } } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.eval_js({ expression: "document.body" });
  check("返回值变成空对象时点破原因", /空对象/.test(r.hint || "") && /DOM 节点/.test(r.hint || ""), r.hint);
}
{
  const st = freshState({ evalResult: { result: { type: "undefined" } } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.eval_js({ expression: "const a = 1" });
  check("返回 undefined 时点破原因", /undefined/.test(r.hint || ""), r.hint);
}
{
  const st = freshState({ evalSerializeFails: true });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await throws(() => T.eval_js({ expression: "window" }), /没法序列化/);
  check("序列化不了时给出可照做的替代写法", r.threw && r.match && /map/.test(r.msg), r.msg);
}

{
  for (const [name, opts] of [
    ["null", { evalResult: { result: { value: null } } }],
    ["空字符串", { evalValue: "" }],
    ["空数组的 JSON", { evalValue: "[]" }],
  ]) {
    const st = freshState(opts);
    st.tabs[0].url = "https://after-nav.example.com/new";
    const T = loadSw(st);
    await T.tab_use({ takeover: true, tabId: 1 });
    const r = await T.eval_js({ expression: "document.querySelector('#x')" });
    check(`空结果（${name}）带上当前 url`, r.url === "https://after-nav.example.com/new", JSON.stringify(r));
    check(`空结果（${name}）说清「先确认读的是不是那一页」`, /那一页/.test(r.emptyHint || ""), JSON.stringify(r));
  }
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const ok = await T.eval_js({ expression: "x" });
  check("非空结果不塞 url / emptyHint（这是热路径）", !("url" in ok) && !("emptyHint" in ok), JSON.stringify(ok));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const r = await T.cdp_raw({ method: "Page.captureScreenshot", params: { format: "png" } });
  check("cdp_raw 原样返回 CDP 结果", r.result?.data === "BASE64PNG", JSON.stringify(r));

  st.cdpFail = (method) =>
    method === "Browser.getVersion" ? 'Browser.getVersion: {"code":-32000,"message":"Cannot not access browser-level commands"}' : null;
  const browserLevel = await throws(
    () => T.cdp_raw({ method: "Browser.getVersion", params: {} }),
    /浏览器级命令/
  );
  check("浏览器级 CDP 命令报错说清走不通", browserLevel.threw && browserLevel.match, browserLevel.msg);
  check("并给出真的能用的替代路子", /browser_eval|request_detail/.test(browserLevel.msg), browserLevel.msg);
  st.cdpFail = null;

  const cdpFile = await throws(
    () => T.cdp_raw({ method: "Page.navigate", params: { url: "file:///Users/x/.ssh/id_rsa" } }),
    /不打开本机文件/
  );
  check("cdp_raw 的 Page.navigate 到 file:// 被闸挡下", cdpFile.threw && cdpFile.match, cdpFile.msg);
  check("file:// 被挡时根本没下发给 CDP", !st.cdp.some((c) => c.method === "Page.navigate"), JSON.stringify(st.cdp.map((c) => c.method)));
  const cdpTabFile = await throws(
    () => T.cdp_raw({ method: "Page.navigate", params: { url: "fi\tle:///etc/passwd" } }),
    /不打开本机文件/
  );
  check("cdp_raw 的 Page.navigate 里 TAB 变体也被挡下", cdpTabFile.threw && cdpTabFile.match, cdpTabFile.msg);
  const okNav = await T.cdp_raw({ method: "Page.navigate", params: { url: "https://example.com/ok" } });
  check("cdp_raw 的 Page.navigate 到 https 照常放行", okNav.result !== undefined || okNav.truncated, JSON.stringify(okNav).slice(0, 80));
  check("放行的导航确实下发到了 CDP", st.cdp.some((c) => c.method === "Page.navigate" && c.params?.url === "https://example.com/ok"));
  const dlBlock = await throws(
    () => T.cdp_raw({ method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/tmp/x" } }),
    /任意本机路径|绕开所有闸门/
  );
  check("cdp_raw 拒绝 Page.setDownloadBehavior（任意路径落盘）", dlBlock.threw && dlBlock.match, dlBlock.msg);
  const dlBlock2 = await throws(
    () => T.cdp_raw({ method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/tmp/x" } }),
    /任意本机路径|绕开所有闸门/
  );
  check("cdp_raw 同样拒绝 Browser.setDownloadBehavior", dlBlock2.threw && dlBlock2.match, dlBlock2.msg);
  check("落盘命令被拒时也没下发给 CDP", !st.cdp.some((c) => /setDownloadBehavior$/.test(c.method)), JSON.stringify(st.cdp.map((c) => c.method)));
  const upBlock = await throws(
    () => T.cdp_raw({ method: "DOM.setFileInputFiles", params: { nodeId: 3, files: ["/Users/x/.ssh/id_rsa"] } }),
    /敏感路径|browser_upload_file/
  );
  check("cdp_raw 拒绝 DOM.setFileInputFiles（任意本机文件交给网页）", upBlock.threw && upBlock.match, upBlock.msg);
  check(
    "被拒时 setFileInputFiles 一个字节都没下发给 CDP",
    !st.cdp.some((c) => c.method === "DOM.setFileInputFiles"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
  const call = st.cdp.find((c) => c.method === "Page.captureScreenshot");
  check("cdp_raw 把 params 透传下去", call?.params?.format === "png", JSON.stringify(call?.params));
  check("cdp_raw 打在本会话接管的标签页上", call?.tabId === 1, String(call?.tabId));

  const noParams = await T.cdp_raw({ method: "DOM.getDocument" });
  check("params 可省略", noParams.result !== undefined, JSON.stringify(noParams));

  const stBig = freshState({ evalValue: "x".repeat(5000) });
  const TBig = loadSw(stBig);
  await TBig.tab_use({ takeover: true, tabId: 1 });
  const big = await TBig.cdp_raw({ method: "Runtime.evaluate", params: { expression: "1" }, maxChars: 100 });
  check("超限结果被截断", big.truncated === true && big.json.length <= 101, JSON.stringify(big).slice(0, 120));
  check("截断时报告原始大小", big.chars > 100, String(big.chars));

  const noMethod = await throws(() => T.cdp_raw({}), /需要 method/);
  check("缺 method 时报错", noMethod.threw && noMethod.match, noMethod.msg);

  const badMethod = await throws(() => T.cdp_raw({ method: "getDocument" }), /Domain\.command/);
  check("method 形状不对时报错", badMethod.threw && badMethod.match, badMethod.msg);

  const badParams = await throws(() => T.cdp_raw({ method: "DOM.getDocument", params: "nope" }), /params 得是对象/);
  check("params 不是对象时报错", badParams.threw && badParams.match, badParams.msg);
}

console.log("\n\x1b[1memulate：仿真下发 + 回读校验 + 显式还原\x1b[0m");
{
  const st = freshState({ viewportMeta: "width=device-width, initial-scale=1" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const r = await T.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } });
  const set = st.cdp.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").pop();
  check(
    "viewport 原样下发给 setDeviceMetricsOverride",
    set?.params?.width === 390 && set?.params?.height === 844 && set?.params?.deviceScaleFactor === 3 && set?.params?.mobile === true,
    JSON.stringify(set?.params)
  );
  check(
    "回读到的是页面实际的视口",
    r.applied.viewport.effective?.innerWidth === 390 && r.applied.viewport.effective?.innerHeight === 844,
    JSON.stringify(r.applied.viewport)
  );
  check("对得上时不发警告", !r.warnings, JSON.stringify(r.warnings));

  await T.emulate({ viewport: { width: 1280, height: 800 } });
  const set2 = st.cdp.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").pop();
  check("deviceScaleFactor / mobile 有默认值", set2?.params?.deviceScaleFactor === 1 && set2?.params?.mobile === false, JSON.stringify(set2?.params));
}
{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.emulate({ viewport: { width: 390, height: 844, mobile: true } });
  check("mobile 静默不生效时回读到 980", r.applied.viewport.effective?.innerWidth === 980, JSON.stringify(r.applied.viewport));
  check(
    "而且明说了原因和下一步（不是静默成功）",
    (r.warnings || []).some((w) => /980/.test(w) && /viewport/.test(w) && /mobile/.test(w)),
    JSON.stringify(r.warnings)
  );
}
{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  await T.emulate({ colorScheme: "dark" });
  const media = st.cdp.filter((c) => c.method === "Emulation.setEmulatedMedia").pop();
  check(
    "colorScheme 走 prefers-color-scheme",
    media?.params?.features?.[0]?.name === "prefers-color-scheme" && media?.params?.features?.[0]?.value === "dark",
    JSON.stringify(media?.params)
  );
  const badCs = await throws(() => T.emulate({ colorScheme: "sepia" }), /只能是/);
  check("认不出的 colorScheme 报错并指出 reset", badCs.threw && badCs.match && /reset/.test(badCs.msg), badCs.msg);

  const rn = await T.emulate({ network: "slow-4g" });
  const net = st.cdp.filter((c) => c.method === "Network.emulateNetworkConditions").pop();
  check("网络档位换算成 CDP 的字节/秒", net?.params?.latency === 563 && net?.params?.downloadThroughput === 180000, JSON.stringify(net?.params));
  check("档位名如实回报", rn.applied.network.preset === "slow-4g", JSON.stringify(rn.applied.network));
  await T.emulate({ network: "fast-3g" });
  const net2 = st.cdp.filter((c) => c.method === "Network.emulateNetworkConditions").pop();
  check("旧名字 fast-3g 认成 slow-4g", net2?.params?.latency === 563, JSON.stringify(net2?.params));
  await T.emulate({ network: { latencyMs: 100, downloadKbps: 800, uploadKbps: 400 } });
  const net3 = st.cdp.filter((c) => c.method === "Network.emulateNetworkConditions").pop();
  check("自定义 Kbps 换算成字节/秒", net3?.params?.downloadThroughput === 100000 && net3?.params?.uploadThroughput === 50000, JSON.stringify(net3?.params));
  const badNet = await throws(() => T.emulate({ network: "5g" }), /不认识的网络档位/);
  check("认不出的档位把可用值列出来", badNet.threw && badNet.match && /slow-4g/.test(badNet.msg), badNet.msg);

  const nothing = await throws(() => T.emulate({}), /什么都没做/);
  check("一样都不给时报错而不是空跑", nothing.threw && nothing.match, nothing.msg);
}
{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.emulate({ geolocation: { latitude: 43.79, longitude: 84.35 } });
  const geo = st.cdp.filter((c) => c.method === "Emulation.setGeolocationOverride").pop();
  check("坐标下发给 setGeolocationOverride（accuracy 有默认值）", geo?.params?.latitude === 43.79 && geo?.params?.accuracy === 100, JSON.stringify(geo?.params));
  const grant = st.cdp.filter((c) => c.method === "Browser.grantPermissions").pop();
  check(
    "顺手授予了这一页 origin 的定位权限",
    grant?.params?.origin === "https://github.com" && grant?.params?.permissions?.[0] === "geolocation",
    JSON.stringify(grant?.params)
  );
  check("回读页面侧权限状态确认是 granted", r.applied.geolocation.permission === "granted", JSON.stringify(r.applied.geolocation));
  const badGeo = await throws(() => T.emulate({ geolocation: { latitude: 200, longitude: 0 } }), /-90~90/);
  check("离谱的纬度被拒", badGeo.threw && badGeo.match, badGeo.msg);
}
{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdpFail = (m) =>
    m.startsWith("Browser.") ? 'Browser.grantPermissions: {"code":-32000,"message":"Cannot not access browser-level commands"}' : null;

  const e1 = await throws(() => T.emulate({ geolocation: { latitude: 1, longitude: 2 } }), /不支持权限授予/);
  check("扩展模式下定位授权失败会报错，不静默成功", e1.threw && e1.match, e1.msg);
  check("报错里给了页面级绕法和另一条人工路", e1.threw && /browser_eval/.test(e1.msg) && /站点设置/.test(e1.msg), e1.msg);
  check("并且说清坐标覆盖本身已经下发了", e1.threw && /坐标覆盖已经下发/.test(e1.msg), e1.msg);
  check("坐标那一条确实发出去了", st.cdp.some((c) => c.method === "Emulation.setGeolocationOverride"), "没发");

  const e2 = await throws(() => T.emulate({ permissions: { grant: ["notifications"] } }), /不支持权限授予/);
  check("显式授权同样报错并点名 CLI 模式可行", e2.threw && e2.match && /CLI/.test(e2.msg), e2.msg);
  const e3 = await throws(() => T.emulate({ colorScheme: "dark", permissions: { grant: ["geolocation"] } }), /colorScheme/);
  check("报错里列出本次已经生效的部分", e3.threw && e3.match, e3.msg);
}
{
  const st = freshState({ viewportMeta: "width=device-width" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.emulate({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    network: "slow-3g",
    geolocation: { latitude: 1, longitude: 2 },
    permissions: { grant: ["notifications"] },
  });
  st.cdp.length = 0;
  const r = await T.emulate({ reset: true });
  const m = (name) => st.cdp.filter((c) => c.method === name);
  check("清了视口", m("Emulation.clearDeviceMetricsOverride").length === 1);
  const clearAt = st.cdp.findIndex((c) => c.method === "Emulation.clearDeviceMetricsOverride");
  const shotAt = st.cdp.findIndex((c) => c.method === "Page.captureScreenshot");
  check("清完视口逼一帧出来（否则页面还停在仿真尺寸上）", shotAt > clearAt && clearAt >= 0, JSON.stringify(st.cdp.map((c) => c.method)));
  check("逼帧不许顺手开焦点模拟", !st.cdp.some((c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params?.enabled === true), JSON.stringify(st.cdp.map((c) => c.method)));
  check("清了配色（features 传空）", m("Emulation.setEmulatedMedia").some((c) => (c.params?.features || []).length === 0));
  check("网络恢复成不限速", m("Network.emulateNetworkConditions").some((c) => c.params?.downloadThroughput === -1 && c.params?.offline === false));
  check("清了定位", m("Emulation.clearGeolocationOverride").length === 1);
  check(
    "权限逐条还原成 prompt（不是 resetPermissions 大扫除）",
    m("Browser.setPermission").length > 0 &&
      m("Browser.setPermission").every((c) => c.params?.setting === "prompt") &&
      m("Browser.setPermission").some((c) => c.params?.permission?.name === "notifications") &&
      m("Browser.setPermission").some((c) => c.params?.permission?.name === "geolocation") &&
      !st.cdp.some((c) => c.method === "Browser.resetPermissions"),
    JSON.stringify(m("Browser.setPermission").map((c) => c.params))
  );
  check("账本清空了", st.sandbox.__perTabTables().emulated.size === 0, String(st.sandbox.__perTabTables().emulated.size));
  check("reset 如实报告清了哪几项", (r.reset || []).length >= 5, JSON.stringify(r.reset));

  st.cdp.length = 0;
  await T.emulate({ reset: true });
  check(
    "空账本上的 reset 一条命令都不发",
    st.cdp.filter((c) => /^(Emulation|Network|Browser)\./.test(c.method)).length === 0,
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}
{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.emulate({ colorScheme: "dark" });
  st.cdp.length = 0;
  await T.emulate({ reset: true });
  check(
    "没设过的项一条命令都不发",
    !st.cdp.some((c) => c.method === "Emulation.clearDeviceMetricsOverride"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}
{
  const st = freshState({ viewportMeta: "width=device-width" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.emulate({ viewport: { width: 390, height: 844 }, network: "slow-3g" });
  st.cdp.length = 0;
  await T.tab_release({ tabId: 1 });
  check(
    "tab_release 自动清掉视口覆盖",
    st.cdp.some((c) => c.method === "Emulation.clearDeviceMetricsOverride"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
  check("tab_release 自动恢复网络", st.cdp.some((c) => c.method === "Network.emulateNetworkConditions" && c.params?.downloadThroughput === -1));
  check("放开之后账本上不留东西", st.sandbox.__perTabTables().emulated.size === 0, String(st.sandbox.__perTabTables().emulated.size));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.navigate({ url: "https://example.com/next" });
  check("navigate 更新了标签页 URL", st.tabUpdates.some((u) => u.props?.url === "https://example.com/next"));
  check("navigate 回报新的 URL/标题", r.url.includes("/next") && r.load === "complete");

  await T.navigate({ action: "reload" });
  check("action=reload 走 tabs.reload", st.tabUpdates.some((u) => u.reload));
  await T.navigate({ action: "back" });
  check("action=back 走 tabs.goBack", st.tabUpdates.some((u) => u.back));
  const bad = await throws(() => T.navigate({ action: "teleport" }), /未知 action/);
  check("未知 action 被拒绝", bad.threw && bad.match, bad.msg);
  const none = await throws(() => T.navigate({}), /需要 url 或 action/);
  check("既无 url 也无 action 时报错", none.threw && none.match, none.msg);

  const enc = "https://s.example.com/search?q=%E4%BE%9D%E4%BA%91%E5%96%B7%E9%9B%BE+30ml";
  const rEnc = await T.navigate({ url: enc });
  check("已编码的 url 原样下发给浏览器", st.tabUpdates.some((u) => u.props?.url === enc), JSON.stringify(st.tabUpdates.slice(-1)));
  check("已编码的 url 原样回报，不再编一次", rEnc.url === enc, rEnc.url);
  const tEnc = await T.new_tab({ url: enc }, "sEnc");
  check("new_tab 也原样下发已编码的 url", st.tabs.some((t) => t.url === enc), JSON.stringify(st.tabs.map((t) => t.url)));
  check("new_tab 也原样回报", tEnc.url === enc, tEnc.url);
}

{
  const st = freshState();
  st.page = makePage([el("div", { innerText: "x" })], { selectorHit: ".ready", bodyText: "已完成" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const hit = await T.wait_for({ selector: ".ready", timeoutMs: 1000 });
  check("wait_for 命中 selector", hit.matched === true);
  const txt = await T.wait_for({ textContains: "已完成", timeoutMs: 1000 });
  check("wait_for 命中页面文本", txt.matched === true);
  const miss = await throws(() => T.wait_for({ selector: ".nope", timeoutMs: 400 }), /等待超时/);
  check("wait_for 超时抛出且带条件", miss.threw && miss.match, miss.msg);
  const none = await throws(() => T.wait_for({}), /至少要给一个条件/);
  check("一个条件都不给时报错，而不是立刻假装成功", none.threw && none.match, none.msg);
}

{
  const st = freshState();
  st.page = makePage([el("div", { innerText: "x" })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  let cancelled = false;
  const ctx = { id: "c1", cancelled: () => cancelled };
  const t0 = Date.now();
  setTimeout(() => (cancelled = true), 150);
  const w = await throws(() => T.wait_for({ selector: ".never", timeoutMs: 20000 }, "default", ctx), /已被客户端取消/);
  const dt = Date.now() - t0;
  check("wait_for 被取消时当场抛出（不是等到 timeoutMs）", w.threw && w.match, w.msg);
  check(`wait_for 取消后 3s 内就停了（实测 ${dt}ms，timeoutMs 是 20000）`, dt < 6000, `${dt}ms`);

  let c2 = false;
  const t1 = Date.now();
  setTimeout(() => (c2 = true), 120);
  const nw = await throws(
    () => T.network_wait({ urlContains: "/never", type: "all", timeoutMs: 20000, lookbackMs: 0 }, "default", { id: "c2", cancelled: () => c2 }),
    /已被客户端取消/
  );
  const dt2 = Date.now() - t1;
  check("network_wait 被取消时当场抛出", nw.threw && nw.match, nw.msg);
  check(`network_wait 取消后 1s 内就停了（实测 ${dt2}ms，timeoutMs 是 20000）`, dt2 < 2000, `${dt2}ms`);

  const sent = [];
  st.sandbox.__setPort({ postMessage: (m) => sent.push(m) });
  const running = st.sandbox.__onHostMessage({
    type: "call",
    id: "call-1",
    tool: "wait_for",
    session: "default",
    args: { selector: ".never", timeoutMs: 20000 },
  });
  await new Promise((r) => setTimeout(r, 150));
  check("取消之前还没有任何结果帧发出去", sent.filter((m) => m.type === "result").length === 0, JSON.stringify(sent));
  const t2 = Date.now();
  await st.sandbox.__onHostMessage({ type: "cancel", id: "call-1" });
  await running;
  const dt3 = Date.now() - t2;
  check(`收到 cancel 帧后循环真的停了（实测 ${dt3}ms）`, dt3 < 6000, `${dt3}ms`);
  check(
    "被取消的调用不回结果帧（规范：MUST NOT send any further messages for it）",
    sent.filter((m) => m.id === "call-1").length === 0,
    JSON.stringify(sent)
  );
  check("消费掉之后账本清空，不会无界增长", st.sandbox.__cancelledCalls.size === 0, [...st.sandbox.__cancelledCalls.keys()].join("、"));

  await st.sandbox.__onHostMessage({ type: "cancel", id: "call-已经跑完了" });
  check("迟到的取消被收下但不影响别人", st.sandbox.__cancelledCalls.has("call-已经跑完了"));
  const after = await throws(
    () => T.wait_for({ selector: ".never", timeoutMs: 400 }, "default", { id: "call-2", cancelled: () => st.sandbox.__cancelledCalls.has("call-2") }),
    /等待超时/
  );
  check("另一个 id 的调用照常跑（超时是超时，不会被别人的取消误伤）", after.threw && after.match, after.msg);
}

{
  const st = freshState();
  st.page = makePage([el("div", { innerText: "x" })]);
  st.visibility = "hidden";
  st.hasFocus = false;
  st.rafRuns = false;
  st.evalHangs = "new Promise(() => {})";
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const to = await throws(() => T.eval_js({ expression: "new Promise(() => {})", timeoutMs: 60 }), /没有返回/);
  check("eval 有自己的预算，不再一路挂到桥接超时", to.threw && to.match, to.msg);
  check("eval 超时说清是在等 promise 兑现", /awaitPromise 开着/.test(to.msg), to.msg);
  check("eval 超时带上 visibilityState 和 hasFocus", /visibilityState=hidden/.test(to.msg) && /hasFocus\(\)=false/.test(to.msg), to.msg);
  check("eval 超时点名 rAF 没在跑", /requestAnimationFrame \*\*没在跑\*\*/.test(to.msg), to.msg);
  check("eval 超时点名根因是页面在后台", /这张页在后台/.test(to.msg), to.msg);
  check("eval 超时给了下一步（换不依赖渲染的判定）", /browser_scroll/.test(to.msg) && /Emulation\.setDeviceMetricsOverride/.test(to.msg), to.msg);

  const sync = await throws(() => T.eval_js({ expression: "new Promise(() => {})", awaitPromise: false, timeoutMs: 60 }), /没有返回/);
  check("同步求值超时的分类不同（说的是主线程被占死，不是在等 promise）", /主线程被占死/.test(sync.msg) && !/awaitPromise 开着/.test(sync.msg), sync.msg);

  const w = await throws(() => T.wait_for({ selector: ".nope", timeoutMs: 300 }), /等待超时/);
  check("wait_for 超时也带上后台页这条根因", /这张页在后台/.test(w.msg), w.msg);
}

{
  const st = freshState();
  st.page = makePage([el("div", { innerText: "x" })]);
  st.visibility = "visible";
  st.hasFocus = true;
  st.rafRuns = true;
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const w = await throws(() => T.wait_for({ selector: ".nope", timeoutMs: 300 }), /等待超时/);
  check("页面在前台且 rAF 在跑时，报错只陈述状态、不扣后台的帽子", !/这张页在后台/.test(w.msg), w.msg);
  check("状态本身照样报出来（省得下一步还要再探一次）", /visibilityState=visible/.test(w.msg) && /requestAnimationFrame 在跑/.test(w.msg), w.msg);
}

{
  let n = 0;
  const st = freshState({
    evalHook: () => {
      n++;
      if (n < 3) return { exceptionDetails: { exception: { description: "TypeError: Cannot read properties of null" } } };
      return { result: { value: 777 } };
    },
  });
  st.page = makePage([el("div", { innerText: "x" })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.wait_for({ js: "document.querySelector('#x').textContent.length", timeoutMs: 4000, pollMs: 10 });
  check("js 条件成立后返回，并带上求得的值", r.matched === true && r.jsValue === 777, JSON.stringify(r));
  check("求值抛异常算「还没满足」，继续轮询而不是直接失败", r.evals === 3, String(r.evals));
  check("wait_for 标注 jsValue 来自页面", (r._fromPage || []).includes("jsValue"), JSON.stringify(r._fromPage));
  check("我方写的 matched / waitedMs 不在名单里", Array.isArray(r._fromPage) && !r._fromPage.includes("matched") && !r._fromPage.includes("waitedMs"), JSON.stringify(r._fromPage));
}
{
  const st = freshState({ evalHook: () => ({ result: { value: 0 } }) });
  st.page = makePage([el("div", { innerText: "x" })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const miss = await throws(() => T.wait_for({ js: "n", timeoutMs: 300, pollMs: 20 }), /等待超时/);
  check("超时报错带上最后一次求值的实际返回值", /最后一次返回：0/.test(miss.msg), miss.msg);
}
{
  const st = freshState({
    evalHook: () => ({ exceptionDetails: { exception: { description: "ReferenceError: foo is not defined" } } }),
  });
  st.page = makePage([el("div", { innerText: "x" })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const miss = await throws(() => T.wait_for({ js: "foo()", timeoutMs: 300, pollMs: 20 }), /等待超时/);
  check(
    "一路抛异常到超时：报错带上异常原文，好区分「没成立」和「写错了」",
    /每一次都抛异常/.test(miss.msg) && /ReferenceError: foo/.test(miss.msg),
    miss.msg
  );
}
{
  const st = freshState({ evalHook: () => ({ result: { value: true } }) });
  st.page = makePage([el("div", { innerText: "x" })], { selectorHit: ".ready", bodyText: "还没好" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const miss = await throws(() => T.wait_for({ js: "true", textContains: "已完成", timeoutMs: 300, pollMs: 20 }), /等待超时/);
  check("js 成立但文本条件不成立时不算满足", miss.threw && miss.match, miss.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const s0 = await T.status();
  check("status 在未接管时 target 为空", s0.target === null && s0.openTabCount === 4);
  await T.tab_use({ takeover: true, tabId: 2 });
  const s1 = await T.status();
  check("status 反映当前接管的标签页", s1.target.tabId === 2 && s1.attachedTabs.includes(2));
  check("status 带上任务状态，默认 running", s1.state === "running", JSON.stringify(s1.state));
  check("没有任何工具能把标签页切到前台", T.tab_focus === undefined, Object.keys(T).join(","));
}

{
  const st = freshState();
  const T = loadSw(st);
  const colorOf = (gid) => st.groups.find((g) => g.id === gid)?.color;
  const nt = await T.new_tab({ url: "https://x.example.com", label: "查域名" }, "s1");
  const sessionColor = colorOf(nt.groupId);
  const r = await T.set_task_state({ state: "attention" }, "s1");
  check("set_task_state 改状态后组名仍是纯任务名", r.state === "attention" && r.groupTitle === "查域名", JSON.stringify(r));
  check("需要你介入 → 组变琥珀色", colorOf(nt.groupId) === "yellow", JSON.stringify(st.groups));
  await T.set_task_state({ state: "failed" }, "s1");
  check("失败 → 组变红", colorOf(nt.groupId) === "red", JSON.stringify(st.groups));
  const back = await T.set_task_state({ state: "running" }, "s1");
  check("改回 running → 组色还原成这个会话自己的颜色", back.groupTitle === "查域名" && colorOf(nt.groupId) === sessionColor, JSON.stringify(st.groups));
  check("组名里一个状态 emoji 都不该出现", !/[🟢🙋⚠️💤⏳]/.test(st.groups.map((g) => g.title).join("")), JSON.stringify(st.groups));
  const bad = await throws(() => T.set_task_state({ state: "工作中" }, "s1"), /running \| attention \| failed/);
  check("不认识的状态直接报错，不静默降级", bad.threw && bad.match, bad.msg);
  const none = await throws(() => T.set_task_state({}, "s1"), /需要 state/);
  check("不给 state 报错", none.threw && none.match, none.msg);

  const st2 = freshState();
  const T2 = loadSw(st2);
  const early = await T2.set_task_state({ state: "failed" }, "s9");
  check("还没有标签组时改状态不报错", early.state === "failed", JSON.stringify(early));
  await T2.new_tab({ url: "https://z.example.com", label: "后建组" }, "s9");
  check(
    "之后建的组直接带上当时的状态（红色）",
    st2.groupUpdates.some((g) => g.props.title === "后建组" && g.props.color === "red"),
    JSON.stringify(st2.groupUpdates.map((g) => g.props))
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const A = "sessA";
  const B = "sessB";

  await T.tab_use({ takeover: true, tabId: 1 }, A);
  await T.tab_use({ takeover: true, tabId: 2 }, B);

  const sa = await T.status({}, A);
  const sb = await T.status({}, B);
  check("会话 A 的目标是它自己接管的", sa.target?.tabId === 1);
  check("会话 B 接管后没有踢掉 A", sb.target?.tabId === 2 && sa.target?.tabId === 1);
  check("两个标签页同时保持 attach", st.attached.includes(1) && st.attached.includes(2));
  check("A 没有被 detach", !st.detached.includes(1), JSON.stringify(st.detached));
  check("status 能看到对方会话", sa.otherSessions.some((o) => o.session === B && o.tabId === 2));

  await T.status({}, "sessC-空手的subagent");
  const sa1 = await T.status({}, A);
  check(
    "没持有标签页的会话不进 otherSessions",
    !sa1.otherSessions.some((o) => o.session === "sessC-空手的subagent"),
    JSON.stringify(sa1.otherSessions)
  );
  check("有标签页的会话照样列出来", sa1.otherSessions.some((o) => o.session === B), JSON.stringify(sa1.otherSessions));

  const grab = await throws(() => T.tab_use({ takeover: true, tabId: 2 }, A), /正被另一个 agent 会话使用/);
  check("不能抢别的会话正在用的标签页", grab.threw && grab.match, grab.msg);

  const steal = await throws(() => T.close_tab({ tabId: 1 }, B), /归另一个会话管/);
  check("不能替别的会话关标签页", steal.threw && steal.match, steal.msg);

  await T.tab_release({}, A);
  const sa2 = await T.status({}, A);
  const sb2 = await T.status({}, B);
  check("A 释放后自己清空", sa2.target === null);
  check("A 释放不影响 B", sb2.target?.tabId === 2 && st.attached.includes(2));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com", label: "站点 A" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const c = await T.new_tab({ url: "https://c.example.com" }, "s1");

  check("new_tab 不再释放前一个标签页", st.detached.length === 0, JSON.stringify(st.detached));
  check("三个标签页同时 attach 着", [a, b, c].every((t) => st.attached.includes(t.tabId)));
  check("new_tab 把 tabId 放在返回值最前面", Object.keys(a)[0] === "tabId", JSON.stringify(Object.keys(a)));
  check("new_tab 明确要求后续操作带上这个 tabId", new RegExp(`tabId: ${a.tabId}`).test(a.useTabId || ""), a.useTabId);
  check("new_tab 说清并行任务里为什么必须带", /并行/.test(a.useTabId || ""), a.useTabId);
  check("new_tab 报出本会话现在持有几个", c.sessionTabCount === 3, String(c.sessionTabCount));

  const s = await T.status({}, "s1");
  check(
    "status 列出本会话持有的全部标签页",
    s.tabCount === 3 && s.tabs.map((t) => t.tabId).join() === [a, b, c].map((t) => t.tabId).join(),
    JSON.stringify(s.tabs)
  );
  check("status 列出的每个标签页都带 url 和标题", s.tabs.every((t) => t.url && t.title !== undefined), JSON.stringify(s.tabs));
  check("多标签页下 status.target 是 null（不猜哪个算「当前」）", s.target === null, JSON.stringify(s.target));
  check("status 提示所有操作必须带 tabId", /必须带 tabId/.test(s.note || ""), s.note);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const c = await T.new_tab({ url: "https://c.example.com" }, "s1");

  const r = await throws(() => T.read_page({}, "s1"), /有 3 个标签页/);
  check("持有多个时不带 tabId 直接报错", r.threw && r.match, r.msg);
  check(
    "报错列出了每个候选的 tabId",
    [a, b, c].every((t) => new RegExp(`tabId ${t.tabId}`).test(r.msg)),
    r.msg
  );
  check("报错带上候选的 url", /a\.example\.com/.test(r.msg) && /c\.example\.com/.test(r.msg), r.msg);
  check("报错说清 tabId 从哪来", /browser_new_tab/.test(r.msg), r.msg);
  check("报错明说不会替调用方挑一个", /不会替你挑/.test(r.msg), r.msg);

  for (const [name, call] of [
    ["click", () => T.click({ x: 5, y: 5 }, "s1")],
    ["type_text", () => T.type_text({ text: "x" }, "s1")],
    ["scroll", () => T.scroll({ direction: "down" }, "s1")],
    ["eval_js", () => T.eval_js({ expression: "1" }, "s1")],
    ["screenshot", () => T.screenshot({}, "s1")],
    ["navigate", () => T.navigate({ url: "https://x.example.com" }, "s1")],
    ["console_log", () => T.console_log({}, "s1")],
    ["network_log", () => T.network_log({}, "s1")],
  ]) {
    const e = await throws(call, /有 3 个标签页/);
    check(`${name} 不带 tabId 时同样被拦下`, e.threw && e.match, e.msg);
  }
  check("被拦下的调用一个 CDP 都没下发", !st.cdp.some((x) => x.method === "Input.dispatchMouseEvent"));
  check("被拦下的调用没有导航任何页面", !st.tabUpdates.some((u) => u.props?.url === "https://x.example.com"));
  check("被拦下后三个标签页原样还在", (await T.status({}, "s1")).tabCount === 3);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const c = await T.new_tab({ url: "https://c.example.com" }, "s1");

  st.cdp.length = 0;
  await T.scroll({ direction: "down", tabId: b.tabId }, "s1");
  const wheel = st.cdp.filter((x) => x.method === "Input.dispatchMouseEvent");
  check(
    "带 tabId 时 CDP 打在指定的那个标签页上",
    wheel.length === 1 && wheel[0].tabId === b.tabId,
    JSON.stringify(wheel.map((w) => w.tabId))
  );

  st.tabUpdates.length = 0;
  const nav = await T.navigate({ url: "https://c2.example.com", tabId: c.tabId }, "s1");
  check(
    "navigate 带 tabId 时只动那一个",
    st.tabUpdates.length === 1 && st.tabUpdates[0].id === c.tabId,
    JSON.stringify(st.tabUpdates)
  );
  check("navigate 如实报回这次落在哪个标签页", nav.tabId === c.tabId);
  check("另外两个标签页的地址没被改", st.tabs.find((t) => t.id === a.tabId).url === "https://a.example.com");

  const snap = await T.read_page({ tabId: a.tabId }, "s1");
  check("read_page 如实报回这次读的是哪个标签页", snap.tabId === a.tabId);

  const rel = await T.tab_release({ tabId: b.tabId }, "s1");
  check("tab_release 能点名放开指定的 tabId", rel.released === true && rel.tabId === b.tabId && st.detached.includes(b.tabId));
  check("点名放开不牵连别的标签页", !st.detached.includes(a.tabId) && !st.detached.includes(c.tabId), JSON.stringify(st.detached));
  const s = await T.status({}, "s1");
  check("放开后持有列表少了那一个", s.tabCount === 2 && !s.tabs.some((t) => t.tabId === b.tabId), JSON.stringify(s.tabs));
  const gone = await throws(() => T.read_page({ tabId: b.tabId }, "s1"), /不在本会话持有的标签页里/);
  check("已放开的 tabId 再用会报错", gone.threw && gone.match, gone.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const other = await T.new_tab({ url: "https://b.example.com" }, "s2");

  const cross = await throws(() => T.read_page({ tabId: other.tabId }, "s1"), /归另一个 agent 会话/);
  check("不能拿 tabId 去操作别的会话的标签页", cross.threw && cross.match, cross.msg);

  const unknown = await throws(() => T.click({ x: 1, y: 1, tabId: 999999 }, "s1"), /不在本会话持有的标签页里/);
  check("陌生 tabId 被拒绝", unknown.threw && unknown.match, unknown.msg);
  check("并列出本会话确实持有的", new RegExp(`tabId ${a.tabId}`).test(unknown.msg), unknown.msg);

  const bad = await throws(() => T.read_page({ tabId: "第二个" }, "s1"), /tabId 得是数字/);
  check("tabId 不是数字时报错而不是当没给", bad.threw && bad.match, bad.msg);
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "确认", box: [10, 20, 80, 40] })], {
    url: "https://only.example.com",
    title: "独苗",
    bodyText: "正文",
  });
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://only.example.com" }, "s1");

  const snap = await T.read_page({}, "s1");
  check("只有一个标签页时不带 tabId 照样能读", snap.title === "独苗" && snap.elements.length === 1);
  check("read_page 顺带报出落在哪个标签页", snap.tabId === a.tabId);

  st.cdp.length = 0;
  await T.click({ ref: "ref_1" }, "s1");
  check(
    "只有一个标签页时不带 tabId 照样能点",
    st.cdp.some((x) => x.method === "Input.dispatchMouseEvent" && x.tabId === a.tabId)
  );

  const s = await T.status({}, "s1");
  check("单标签页时 status.target 保持老形状", s.target?.tabId === a.tabId && s.tabCount === 1);

  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const amb = await throws(() => T.read_page({}, "s1"), /有 2 个标签页/);
  check("变成两个之后隐式调用立刻被拦", amb.threw && amb.match);
  st.tabs = st.tabs.filter((t) => t.id !== b.tabId);
  const back = await T.read_page({}, "s1");
  check("其中一个被关掉、只剩一个后隐式行为自动恢复", back.tabId === a.tabId);
  check("关掉的那个从持有列表里剔掉了", (await T.status({}, "s1")).tabCount === 1);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");

  const r = await throws(() => T.tab_release({}, "s1"), /没说要放开哪一个/);
  check("持有多个时不点名不给放开", r.threw && r.match, r.msg);
  check(
    "放开的报错也列出候选",
    new RegExp(`tabId ${a.tabId}`).test(r.msg) && new RegExp(`tabId ${b.tabId}`).test(r.msg),
    r.msg
  );
  check("被拦下时一个都没 detach", st.detached.length === 0, JSON.stringify(st.detached));

  const all = await T.tab_release({ all: true }, "s1");
  check(
    "all:true 一次放开全部",
    all.count === 2 && all.remaining === 0 && st.detached.includes(a.tabId) && st.detached.includes(b.tabId),
    JSON.stringify(all)
  );
  check("全放开后本会话不再持有标签页", (await T.status({}, "s1")).tabCount === 0);
}

{
  const st = freshState();
  const T = loadSw(st);
  const SID = "shared-session";
  const mine = [];
  for (let i = 0; i < 12; i++) mine.push(await T.new_tab({ url: `https://site${i}.example.com` }, SID));

  check("12 个标签页同时归同一个会话持有", (await T.status({}, SID)).tabCount === 12);
  check("开新页的过程中一个都没被顺手 detach", st.detached.length === 0, JSON.stringify(st.detached));
  check("12 个标签页仍全部 attach 着", mine.every((t) => st.attached.includes(t.tabId)));
  check("12 个 tabId 互不相同", new Set(mine.map((t) => t.tabId)).size === 12);

  st.cdp.length = 0;
  for (const t of mine) await T.scroll({ direction: "down", tabId: t.tabId }, SID);
  const hit = st.cdp.filter((x) => x.method === "Input.dispatchMouseEvent").map((x) => x.tabId);
  check(
    "每次操作都精确落在自己那个标签页上",
    hit.join() === mine.map((t) => t.tabId).join(),
    JSON.stringify(hit)
  );

  const r = await throws(() => T.scroll({ direction: "down" }, SID), /有 12 个标签页/);
  check("忘了带 tabId 的那个调用只让自己报错", r.threw && r.match);
  check("它的报错没有牵连任何标签页", (await T.status({}, SID)).tabCount === 12);
}

{
  const st = freshState();
  const T1 = loadSw(st);
  const a = await T1.new_tab({ url: "https://a.example.com", label: "多页任务" }, "s1");
  const b = await T1.new_tab({ url: "https://b.example.com" }, "s1");
  await st.sandbox.__persist();

  const T2 = loadSw(st);
  await st.sandbox.__restore();

  const s = await T2.status({}, "s1");
  check(
    "SW 回收后两个标签页都还在持有列表里",
    s.tabCount === 2 && s.tabs.map((t) => t.tabId).sort().join() === [a.tabId, b.tabId].sort().join(),
    JSON.stringify(s.tabs)
  );
  check("SW 回收后依然拒绝不带 tabId 的隐式调用", (await throws(() => T2.read_page({}, "s1"), /有 2 个标签页/)).match);
  check("SW 回收后带 tabId 依然能精确命中", (await T2.read_page({ tabId: b.tabId }, "s1")).tabId === b.tabId);
}

{
  const st = freshState();
  st.storage["aic-sessions-v1"] = {
    sessions: [["s1", { target: { tabId: 2, url: "https://admin.corp.local/orders", title: "内部后台" }, groupId: 7, label: "老任务" }]],
    tabOwner: [[2, "s1"]],
    ourTabs: [],
    colorCursor: 1,
  };
  const T = loadSw(st);
  await st.sandbox.__restore();
  const s = await T.status({}, "s1");
  check("旧的单槽 target 被读成一个标签页的持有列表", s.tabCount === 1 && s.tabs[0].tabId === 2, JSON.stringify(s.tabs));
  check("旧状态里的标签组和任务名也还在", s.groupId === 7 && s.label === "老任务");
  check("升级后旧会话照样能不带 tabId 操作（只有一个）", (await T.read_page({}, "s1")).tabId === 2);
}

{
  const st = freshState();
  const T = loadSw(st);

  await T.new_tab({ url: "https://dash.cloudflare.com", label: "Cloudflare 域名检查" }, "sA");
  await T.new_tab({ url: "https://news.google.com", label: "今天的 AI 新闻" }, "sB");

  const titles = st.groupUpdates.map((g) => g.props.title);
  check("两个会话建了两个组", st.groupUpdates.length === 2, JSON.stringify(titles));
  check("组名就是任务名，长名截断", titles.includes("Cloudflare…") && titles.includes("今天的 AI 新闻"), JSON.stringify(titles));
  check("两个组的 id 不同", st.grouped[0].groupId !== st.grouped[1].groupId);
  check("两个组配色不同", st.groupUpdates[0].props.color !== st.groupUpdates[1].props.color, JSON.stringify(st.groupUpdates.map((g) => g.props.color)));

  st.groupUpdates.length = 0;
  await T.new_tab({ url: "https://dash.cloudflare.com/2" }, "sA");
  check("同会话第二页复用自己的组", st.grouped[2].groupId === st.grouped[0].groupId, JSON.stringify(st.grouped));
  check("复用时不重复建组", st.groupUpdates.length === 0);

  const r = await T.set_label({ label: "改个名" }, "sA");
  check("set_label 能改组名", r.label === "改个名" && st.groupUpdates.some((g) => g.props.title === "改个名"));
}

{
  const st = freshState();
  const T1 = loadSw(st);
  await T1.new_tab({ url: "https://example.com/task", label: "查 Cloudflare 域名" }, "s1");
  await T1.tab_use({ takeover: true, tabId: 2 }, "s2");
  await st.sandbox.__persist();
  const before = await T1.status({}, "s1");

  const T2 = loadSw(st);
  await st.sandbox.__restore();

  const after1 = await T2.status({}, "s1");
  const after2 = await T2.status({}, "s2");
  check("SW 回收后 s1 的目标标签页还在", after1.target?.tabId === before.target?.tabId, JSON.stringify(after1.target));
  check("SW 回收后标签组归属还在", after1.groupId === before.groupId && after1.label === "查 Cloudflare 域名");
  check("SW 回收后 s2 的目标也还在", after2.target?.tabId === 2, JSON.stringify(after2.target));
  check("SW 回收后两个会话仍是分开的", after1.target?.tabId !== after2.target?.tabId);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 2 }, "s1");
  st.detached.length = 0;

  st.sandbox.__detachAll();
  await new Promise((r) => setTimeout(r, 30));

  check("host 掉线会断开调试器（黄条消失）", st.detached.includes(2));
  const s = await T.status({}, "s1");
  check("但会话的目标标签页不能被清掉", s.target?.tabId === 2, JSON.stringify(s.target));

  st.attached.length = 0;
  await T.read_page({}, "s1");
  check("下次调用自动重新 attach", st.attached.includes(2), JSON.stringify(st.attached));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 2 }, "s1");
  st.tabs = st.tabs.filter((t) => t.id !== 2);
  const r = await throws(() => T.read_page({}, "s1"), /已经关掉了/);
  check("目标被关掉后报错并指出下一步", r.threw && r.match && /new_tab/.test(r.msg), r.msg);
  const s = await T.status({}, "s1");
  check("并且清掉失效的目标", s.target === null);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const tab = st.tabs.find((t) => t.id === 1);
  tab.url = "https://www.google.com/search?q=AI";
  tab.title = "AI - Google 搜索";
  await T.read_page({}, "s1");
  const s = await T.status({}, "s1");
  check("页面自行导航后 target.url 会刷新", s.target?.url.includes("google.com"), JSON.stringify(s.target));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  await T.tab_use({ takeover: true, tabId: 2 }, "s2");

  let got = null;
  let threw = null;
  try {
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (r) => (got = r));
  } catch (e) {
    threw = e;
  }
  await new Promise((r) => setTimeout(r, 30));

  check("popup 查状态不抛异常", !threw, String(threw && threw.message));
  check("popup 拿到了状态", !!got, JSON.stringify(got));
  check("popup 列出了所有会话在用的标签页", (got?.sessions || []).length === 2, JSON.stringify(got?.sessions));
  check("popup 显示任务名", (got?.sessions || []).some((x) => x.label === "任务甲"), JSON.stringify(got?.sessions));
  check("popup 带上扩展版本", !!got?.version);
  check("popup 每条会话带 session key", (got?.sessions || []).every((x) => typeof x.session === "string"), JSON.stringify(got?.sessions));
  check("popup 每条会话带标签组颜色", (got?.sessions || []).every((x) => typeof x.color === "string" && x.color), JSON.stringify(got?.sessions));

  let released = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-release" }, {}, (r) => (released = r));
  await new Promise((r) => setTimeout(r, 30));
  check("popup 全部放开有回执", released?.ok === true);
  const after = await T.status({}, "s1");
  check("全部放开后会话被清空", after.target === null);
}

{
  const st = freshState();
  const T = loadSw(st);
  const nt = await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  await T.tab_use({ takeover: true, tabId: 1 }, "s2");

  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [1] }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 30));
  check("勾选接管有回执", r?.ok === true && r?.count === 1, JSON.stringify(r));
  check("接管的那页摘掉了调试器", st.detached.includes(1), JSON.stringify(st.detached));
  check("接管不把页移出标签组", !st.ungrouped.flat().includes(1), JSON.stringify(st.ungrouped));
  check("接管的那页没有被关闭", !st.removedTabs?.includes?.(1) && !!st.tabs.find((t) => t.id === 1));

  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));
  const rows = got?.sessions || [];
  check("接管的页仍在弹窗清单里且标了 held", rows.some((x) => x.tabId === 1 && x.held === true), JSON.stringify(rows));
  check("没勾的会话不受牵连", rows.some((x) => x.tabId === nt.tabId && x.held === false), JSON.stringify(rows));

  let r2 = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [1, 9999] }, {}, (x) => (r2 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("已接管或不存在的 id 跳过不报错", r2?.ok === true && r2?.count === 0, JSON.stringify(r2));
}

{
  const st = freshState();
  const T = loadSw(st);
  const nt = await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");

  st.chrome.debugger.onDetach._fire({ tabId: nt.tabId }, "canceled_by_user");
  await new Promise((res) => setTimeout(res, 30));

  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));
  check("外力 detach 后弹窗仍列出该页", (got?.sessions || []).some((x) => x.tabId === nt.tabId), JSON.stringify(got?.sessions));
  check("外力 detach 后调试器状态如实清掉", !(got?.attached || []).includes(nt.tabId), JSON.stringify(got?.attached));
  st.chrome.tabs.onRemoved._fire(nt.tabId, { windowId: 10, isWindowClosing: false });
  await new Promise((res) => setTimeout(res, 30));
  let got2 = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got2 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("页面真关掉后账本才清", !(got2?.sessions || []).some((x) => x.tabId === nt.tabId), JSON.stringify(got2?.sessions));
}

{
  const st = freshState();
  st.groups.push({ id: 77, title: "⏳ 旧任务", color: "blue" });
  st.tabs.push({ id: 41, windowId: 10, groupId: 77, title: "遗留页 A", url: "https://a.example.com/x", status: "complete" });
  st.tabs.push({ id: 42, windowId: 10, groupId: 77, title: "遗留页 B", url: "https://b.example.com/y", status: "complete" });
  loadSw(st);

  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));

  check("遗留组被自动解散（组没了）", !st.groups.some((g) => g.id === 77), JSON.stringify(st.groups));
  check("解散不动页面：两张都还在", st.tabs.some((t) => t.id === 41) && st.tabs.some((t) => t.id === 42), JSON.stringify(st.removed));
  check("两张页都移出了组", [41, 42].every((id) => st.tabs.find((t) => t.id === id)?.groupId === -1), JSON.stringify(st.tabs.map((t) => [t.id, t.groupId])));
  check("解散过的组不会再在弹窗里列成待处置", (got?.orphans || []).length === 0, JSON.stringify(got?.orphans));
}
{
  const st = freshState();
  st.groups.push({ id: 88, title: "⚠️ 失败的任务", color: "red" });
  st.tabs.push({ id: 51, windowId: 10, groupId: 88, title: "遗留页", url: "https://a.example.com/x", status: "complete" });
  const chrome0 = makeChrome(st);
  let allowUngroup = false;
  const realUngroup = chrome0.tabs.ungroup;
  chrome0.tabs.ungroup = async (ids) => {
    if (!allowUngroup) throw new Error("ungroup failed");
    return realUngroup(ids);
  };
  loadSw(st, chrome0);

  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));
  check("自动解散失败的组仍列进弹窗", (got?.orphans || []).length === 1 && got.orphans[0].groupId === 88, JSON.stringify(got?.orphans));
  check("孤儿组带完整标签页清单", got?.orphans?.[0]?.tabs?.length === 1, JSON.stringify(got?.orphans));

  allowUngroup = true;
  let r1 = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-ungroup-group", groupId: 88 }, {}, (x) => (r1 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("手动解散分组有回执", r1?.ok === true && r1?.count === 1, JSON.stringify(r1));
  check("手动解散不关页面", st.tabs.some((t) => t.id === 51), JSON.stringify(st.removed));
}
{
  const st = freshState();
  st.groups.push({ id: 89, title: "⚠️ 失败的任务", color: "red" });
  st.tabs.push({ id: 52, windowId: 10, groupId: 89, title: "遗留页", url: "https://a.example.com/x", status: "complete" });
  const chrome0 = makeChrome(st);
  chrome0.tabs.ungroup = async () => {
    throw new Error("ungroup failed");
  };
  loadSw(st, chrome0);
  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-close-group", groupId: 89 }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 30));
  check("关闭这组确实关掉了页面", st.removed.includes(52), JSON.stringify(st.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com", label: "活任务" }, "s1");
  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));
  check("活会话的组不算孤儿", (got?.orphans || []).length === 0, JSON.stringify(got?.orphans));
}

{
  const st = freshState();
  loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const status = async () => {
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await tick();
    return Object.fromEntries((got?.sessions || []).map((x) => [x.session, x]));
  };

  st.hostPort.onMessage._fire({
    id: "g1",
    type: "call",
    tool: "new_tab",
    args: { url: "https://a.example.com", label: "查域名" },
    session: "sA",
    agent: {
      name: "claude-code",
      title: "Claude Code",
      version: "2.1.226",
      brand: "Claude Code",
      surface: "cli",
      workspace: "agent-in-chrome",
      workspaceKind: "git",
      session: "修 sid 漂移与组认领",
    },
  });
  await tick();
  st.hostPort.onMessage._fire({
    id: "g2",
    type: "call",
    tool: "new_tab",
    args: { url: "https://b.example.com", label: "查订单" },
    session: "sB",
    agent: { name: "cursor-vscode", version: "1.2.3", brand: "cursor-vscode", surface: "app" },
  });
  await tick();

  let by = await status();
  check("建会话那一帧就把 agent 记上了", by.sA?.agent === "Claude Code", JSON.stringify(by.sA));
  check("没给 title 的客户端退回 name（不猜中文名）", by.sB?.agent === "cursor-vscode", JSON.stringify(by.sB));
  check("两个会话各记各的 agent，不串", by.sA?.agent !== by.sB?.agent, JSON.stringify([by.sA?.agent, by.sB?.agent]));
  check("版本号一并带上（弹窗放进 tooltip）", by.sA?.agentVersion === "2.1.226", JSON.stringify(by.sA));
  check("形态跟着走", by.sA?.agentSurface === "cli" && by.sB?.agentSurface === "app", JSON.stringify([by.sA?.agentSurface, by.sB?.agentSurface]));
  check(
    "工作区跟着走（连 git / 目录之分一起）",
    by.sA?.agentWorkspace === "agent-in-chrome" && by.sA?.agentWorkspaceKind === "git",
    JSON.stringify(by.sA)
  );
  check("会话标题跟着走", by.sA?.agentSession === "修 sid 漂移与组认领", JSON.stringify(by.sA));
  check("没有的那几段就是 null，不许编", by.sB?.agentWorkspace === null && by.sB?.agentSession === null, JSON.stringify(by.sB));
  check("客户端自报的原文单独留一份（popup-status 里回答「怎么显示成这样」，不再进悬浮层）", by.sA?.agentReported === "Claude Code", JSON.stringify(by.sA));

  st.hostPort.onMessage._fire({
    id: "g4",
    type: "call",
    tool: "new_tab",
    args: { url: "https://c.example.com", label: "查机票" },
    session: "sC",
    agent: { name: "local-agent-mode-agent-in-chrome", title: null, version: "1.0.0", brand: "Claude", surface: "app" },
  });
  await tick();
  by = await status();
  check("报机器串的客户端显示的是取证来的品牌", by.sC?.agent === "Claude", JSON.stringify(by.sC));
  check("机器串本身只留在 popup-status 的原文字段里", by.sC?.agentReported === "local-agent-mode-agent-in-chrome", JSON.stringify(by.sC));

  st.hostPort.onMessage._fire({
    id: "g5",
    type: "call",
    tool: "new_tab",
    args: { url: "https://d.example.com", label: "查快递" },
    session: "sD",
    agent: { name: null, title: null, version: null, brand: null, surface: "cli", workspace: "myapp", workspaceKind: "dir" },
  });
  await tick();
  by = await status();
  check("认不出品牌但认得出工作区的，那两段照样显示", by.sD?.agentWorkspace === "myapp" && by.sD?.agentSurface === "cli", JSON.stringify(by.sD));
  check("认不出品牌就是没有品牌", by.sD?.agent === null, JSON.stringify(by.sD));

  st.hostPort.onMessage._fire({ id: "g3", type: "call", tool: "tabs_list", args: {}, session: "sA" });
  await tick();
  by = await status();
  check("后续帧没带 agent 时不抹掉已经记下的", by.sA?.agent === "Claude Code", JSON.stringify(by.sA));

  st.hostPort.onMessage._fire({
    type: "agent-update",
    session: "sB",
    agent: { name: "cursor-vscode", version: "1.2.3", brand: "cursor-vscode", surface: "app", session: "后来生成的标题" },
  });
  await tick();
  by = await status();
  check("agent-update 帧把后到的会话名补上", by.sB?.agentSession === "后来生成的标题", JSON.stringify(by.sB));
  check("agent-update 不动会话的其余状态", by.sB?.agent === "cursor-vscode" && by.sB?.label === "查订单", JSON.stringify(by.sB));

  st.hostPort.onMessage._fire({
    id: "g6",
    type: "call",
    tool: "tabs_list",
    args: {},
    session: "sA",
    agent: { name: "claude-code", title: "Claude Code", version: "2.1.226", brand: "Claude Code", surface: "cli", session: null },
  });
  await tick();
  by = await status();
  check("后续帧的会话名为空时保留已有的（只进不退）", by.sA?.agentSession === "修 sid 漂移与组认领", JSON.stringify(by.sA));

  st.hostPort.onMessage._fire({ type: "agent-update", session: "sA", agent: { brand: "Claude Code", session: "改名后的标题" } });
  await tick();
  by = await status();
  check("非空的新会话名照常覆盖（改名）", by.sA?.agentSession === "改名后的标题", JSON.stringify(by.sA));

  await st.sandbox.__persist();
  loadSw(st);
  await st.sandbox.__restore();
  by = await status();
  check("SW 回收后 agent 身份还在（跟着会话落盘）", by.sA?.agent === "Claude Code", JSON.stringify(by.sA));
}

{
  const st = freshState();
  loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const status = async () => {
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await tick();
    return got?.sessions || [];
  };
  const base = { brand: "Claude Code", surface: "app", workspace: "agent-in-chrome", workspaceKind: "git", session: "修会话名显示" };
  const call = (id, tool, args, agent) => {
    st.hostPort.onMessage._fire({ id, type: "call", tool, args, session: "sX", agent });
    return tick();
  };

  await call("t1", "new_tab", { url: "https://a.example.com", label: "核查身份" }, { ...base, task: "子任务甲", taskType: "general-purpose" });
  let rows = await status();
  check("卡头写的是「主会话名 + 此刻动手的子任务」", rows[0]?.agentSession === "修会话名显示" && rows[0]?.agentTask === "子任务甲", JSON.stringify(rows[0]));
  check("子任务类型也带上（进 tooltip）", rows[0]?.agentTaskType === "general-purpose", JSON.stringify(rows[0]));
  check("开页那一帧就把「谁开的」记在页上", rows[0]?.openedBy === "子任务甲", JSON.stringify(rows[0]));

  await call("t2", "new_tab", { url: "https://b.example.com", label: "核查身份" }, { ...base, task: "子任务乙", taskType: "Explore" });
  rows = await status();
  const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
  check(
    "并行子任务各记各的页，不互相盖",
    byUrl["https://a.example.com"]?.openedBy === "子任务甲" && byUrl["https://b.example.com"]?.openedBy === "子任务乙",
    JSON.stringify(rows.map((r) => [r.url, r.openedBy]))
  );

  await call("t3", "click", { tabId: 1001, ref: 1 }, { ...base, task: "子任务乙" });
  rows = await status();
  check("后来谁碰过这页都不改写「当初是谁开的」", Object.fromEntries(rows.map((r) => [r.url, r]))["https://a.example.com"]?.openedBy === "子任务甲", JSON.stringify(rows));

  await call("t4", "tabs_list", {}, { ...base, task: null, taskType: null });
  rows = await status();
  check("主会话接手时卡头上的子任务名要撤掉", rows[0]?.agentTask === null, JSON.stringify(rows[0]));
  check("撤掉的只是卡头那一段，页上记的开页人不动", rows[0]?.openedBy === "子任务甲", JSON.stringify(rows[0]));

  await call("t5", "tabs_list", {}, { ...base, task: "子任务丙" });
  st.hostPort.onMessage._fire({ type: "agent-update", session: "sX", agent: { ...base, session: "改名后的标题" } });
  await tick();
  rows = await status();
  check("缺 task 键的帧保留上一次的值（不当成「没有子任务」）", rows[0]?.agentTask === "子任务丙", JSON.stringify(rows[0]));
  check("agent-update 该改的还是照改", rows[0]?.agentSession === "改名后的标题", JSON.stringify(rows[0]));

  await call("t6", "new_tab", { url: "https://c.example.com", label: "核查身份" }, { ...base, task: null });
  rows = await status();
  const c0 = Object.fromEntries(rows.map((r) => [r.url, r]))["https://c.example.com"];
  check("开页时还认不出子任务：先空着，不猜", c0?.openedBy === null || c0?.openedBy === undefined, JSON.stringify(c0));
  await call("t7", "click", { tabId: c0?.tabId, ref: 1 }, { ...base, task: "子任务丁" });
  rows = await status();
  check("下一帧认出来了就补上（空了才填）", Object.fromEntries(rows.map((r) => [r.url, r]))["https://c.example.com"]?.openedBy === "子任务丁", JSON.stringify(rows));
}

{
  const st = freshState();
  st.groups.push({ id: 91, title: "查域名", color: "blue" });
  st.tabs.push({ id: 61, windowId: 10, groupId: 91, title: "遗留页", url: "https://a.example.com/x", status: "complete" });
  st.groups.push({ id: 92, title: "老任务", color: "green" });
  st.tabs.push({ id: 62, windowId: 10, groupId: 92, title: "老遗留页", url: "https://b.example.com/y", status: "complete" });
  st.localStorage["aic-our-group-91"] = { a: "Claude Code" };
  st.localStorage["aic-our-group-92"] = 1;
  const chrome0 = makeChrome(st);
  chrome0.tabs.ungroup = async () => {
    throw new Error("ungroup failed");
  };
  loadSw(st, chrome0);

  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
  await new Promise((res) => setTimeout(res, 30));
  const byGid = Object.fromEntries((got?.orphans || []).map((o) => [o.groupId, o]));
  check("孤儿组报出当初是谁开的", byGid[91]?.agent === "Claude Code", JSON.stringify(got?.orphans));
  check("旧版本记的裸账本条目照常认领", !!byGid[92], JSON.stringify(got?.orphans));
  check("认不出名字就是 null，不编一个", byGid[92]?.agent === null, JSON.stringify(byGid[92]));
  check("没记 sid 的孤儿组不算待认领", byGid[91]?.reclaimable === false && byGid[92]?.reclaimable === false, JSON.stringify(got?.orphans));
}

{
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const reload = (st) => {
    st.storage = {};
    loadSw(st);
    return tick();
  };
  const statusOf = async (st) => {
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await tick();
    return got;
  };
  const call = (st, id, tool, args, session) => st.hostPort.onMessage._fire({ id, type: "call", tool, args, session, agent: { name: "claude-code", title: "Claude Code" } });

  {
    const st = freshState();
    loadSw(st);
    call(st, "r1", "new_tab", { url: "https://a.example.com", label: "查竞品定价" }, "sK");
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    const tabId = st.tabs[st.tabs.length - 1].id;
    check("建组时把 sid 和任务名一并记进组账本", st.localStorage[`aic-our-group-${gid}`]?.s === "sK" && st.localStorage[`aic-our-group-${gid}`]?.l === "查竞品定价", JSON.stringify(st.localStorage[`aic-our-group-${gid}`]));

    await reload(st);
    check("重载后的冷启动家务没把还能被认回的组解散掉", st.tabs.find((t) => t.id === tabId)?.groupId === gid, JSON.stringify(st.ungrouped));

    call(st, "r2", "tabs_list", {}, "sK");
    await tick();
    const got = await statusOf(st);
    const mine = (got?.sessions || []).filter((x) => x.session === "sK");
    check("原主的下一次调用把组认了回来", mine.length === 1 && mine[0].tabId === tabId, JSON.stringify(got?.sessions));
    check("任务名从账本回填（组标题是会被缩短的，不能拿它回填）", mine[0]?.label === "查竞品定价", JSON.stringify(mine[0]));
    check("认回来之后它不再是遗留组", (got?.orphans || []).length === 0, JSON.stringify(got?.orphans));

    call(st, "r3", "new_tab", { url: "https://b.example.com" }, "sK");
    await tick();
    check("后续开的页进的还是原来那个组", st.tabs[st.tabs.length - 1].groupId === gid, JSON.stringify(st.tabs.slice(-1)));
  }

  {
    const st = freshState();
    loadSw(st);
    call(st, "x1", "new_tab", { url: "https://a.example.com", label: "甲的任务" }, "sA");
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    await reload(st);
    call(st, "x2", "new_tab", { url: "https://b.example.com", label: "乙的任务" }, "sB");
    await tick();
    check("sid 对不上就不认，另起一个组", st.tabs[st.tabs.length - 1].groupId !== gid, JSON.stringify(st.tabs.slice(-1)));
  }

  {
    const st = freshState();
    loadSw(st);
    call(st, "y1", "new_tab", { url: "https://a.example.com", label: "早就没人管了" }, "sOld");
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    const tabId = st.tabs[st.tabs.length - 1].id;
    st.localStorage[`aic-our-group-${gid}`].t = Date.now() - 60 * 60 * 1000;
    await reload(st);
    check("过了认回窗口期的组照旧被自动解散", st.tabs.find((t) => t.id === tabId)?.groupId !== gid, JSON.stringify(st.ungrouped));
  }

  {
    const st = freshState();
    loadSw(st);
    call(st, "t1", "new_tab", { url: "https://a.example.com", label: "长任务" }, "sT");
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    const tabId = st.tabs[st.tabs.length - 1].id;
    const led = () => st.localStorage[`aic-our-group-${gid}`];
    led().t = Date.now() - 30 * 60 * 1000;
    loadSw(st);
    await tick();
    call(st, "t2", "tabs_list", {}, "sT");
    await tick();
    check("干活时把认回窗口往后推", Date.now() - Number(led().t) < 60 * 1000, JSON.stringify(led()));

    await reload(st);
    check("续过期的长任务组在重载后没被解散", st.tabs.find((t) => t.id === tabId)?.groupId === gid, JSON.stringify(st.ungrouped));

    call(st, "t3", "tabs_list", {}, "sT");
    await tick();
    const marked = 1000;
    led().t = marked;
    call(st, "t4", "tabs_list", {}, "sT");
    await tick();
    check("续期有节流，不是每帧都写", Number(led().t) === marked, JSON.stringify(led()));
  }

  {
    const st = freshState();
    loadSw(st);
    call(st, "u1", "new_tab", { url: "https://a.example.com" }, "sU");
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    const key = `aic-our-group-${gid}`;
    st.localStorage[key] = { ...st.localStorage[key], s: "别的会话", t: 1000 };
    loadSw(st);
    await tick();
    call(st, "u2", "tabs_list", {}, "sU");
    await tick();
    check("账本上不是这个会话的组不给续期", Number(st.localStorage[key].t) === 1000, JSON.stringify(st.localStorage[key]));
  }

  {
    const st = freshState();
    loadSw(st);
    st.hostPort.onMessage._fire({
      id: "g1", type: "call", tool: "new_tab", args: { url: "https://a.example.com", label: "查定价" }, session: "sG",
      agent: { name: "claude-code", title: "Claude Code", surface: "cli", workspace: "agent-in-chrome", workspaceKind: "git", session: "修组账本" },
    });
    await tick();
    const gid = st.groups[st.groups.length - 1].id;
    const ag = st.localStorage[`aic-our-group-${gid}`]?.ag;
    check("建组时把四段身份一并记进组账本", ag?.brand === "Claude Code" && ag?.surface === "cli" && ag?.workspace === "agent-in-chrome" && ag?.workspaceKind === "git" && ag?.session === "修组账本", JSON.stringify(ag));
    check("那一行显示名照旧单独记着（老条目只有它）", st.localStorage[`aic-our-group-${gid}`]?.a === "Claude Code");

    st.storage = {};
    st.localStorage[`aic-our-group-${gid}`].t = Date.now() - 60 * 60 * 1000;
    const chrome0 = makeChrome(st);
    chrome0.tabs.ungroup = async () => {
      throw new Error("ungroup failed");
    };
    loadSw(st, chrome0);
    await tick();
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await tick();
    const o = (got?.orphans || [])[0];
    check("遗留卡带上工作区和会话名", o?.agentWorkspace === "agent-in-chrome" && o?.agentSession === "修组账本" && o?.agentSurface === "cli", JSON.stringify(o));
  }

  {
    const st = freshState();
    loadSw(st);
    st.hostPort.onMessage._fire({
      id: "h1", type: "call", tool: "new_tab", args: { url: "https://a.example.com", label: "查定价" }, session: "sH",
      agent: { name: "claude-code", title: "Claude Code", surface: "cli", workspace: "agent-in-chrome", workspaceKind: "git", session: "修组账本" },
    });
    await tick();
    await reload(st);
    st.hostPort.onMessage._fire({ id: "h2", type: "call", tool: "tabs_list", args: {}, session: "sH" });
    await tick();
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await tick();
    const mine = (got?.sessions || []).find((x) => x.session === "sH");
    check("认回组时身份从账本恢复", mine?.agent === "Claude Code" && mine?.agentWorkspace === "agent-in-chrome" && mine?.agentSession === "修组账本", JSON.stringify(mine));
  }
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com", label: "这是一个特别特别长的任务名称超过十个字" }, "s1");
  const upd = st.groupUpdates.find((u) => u.props && u.props.title);
  check("胶囊标题被截短", !!upd && upd.props.title.length <= "🟢 ".length + 11, JSON.stringify(upd));
  check("胶囊标题就是任务名本身，没有前缀", !!upd && upd.props.title.startsWith("这是一个"), JSON.stringify(upd));
}

{
  const st = freshState();
  const T = loadSw(st);
  const titleOf = (gid) => st.groups.find((g) => g.id === gid)?.title;
  const gidOf = (r) => r.groupId;

  const a = await T.new_tab({ url: "https://a.example.com", label: "查一个很长的任务名字啊" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com", label: "短名" }, "s2");
  check("两个组时给全称档（10 字）", titleOf(gidOf(a)) === "查一个很长的任务名字…" && titleOf(gidOf(b)) === "短名", JSON.stringify(st.groups));

  const c = await T.new_tab({ url: "https://c.example.com", label: "第三个任务" }, "s3");
  check(
    "第三个组一出现，所有组降到 4 字档",
    titleOf(gidOf(a)) === "查一个很…" && titleOf(gidOf(b)) === "短名" && titleOf(gidOf(c)) === "第三个任…",
    JSON.stringify(st.groups)
  );

  const more = [];
  for (let i = 0; i < 3; i++) more.push(await T.new_tab({ url: `https://x${i}.example.com`, label: `任务${i}` }, `sx${i}`));
  check(
    "第六个组一出现，胶囊只剩任务名首字",
    titleOf(gidOf(a)) === "查" && titleOf(gidOf(b)) === "短" && titleOf(gidOf(c)) === "第",
    JSON.stringify(st.groups)
  );
  check("首字档不加省略号（加了等于宽度翻倍，正是这一档要省的）", st.groups.every((g) => !g.title.includes("…")), JSON.stringify(st.groups));

  for (const r of [c, ...more]) await st.chrome.tabs.remove(r.tabId);
  await new Promise((res) => setTimeout(res, 30));
  check(
    "组关掉后剩下的胶囊升档放长",
    titleOf(gidOf(a)) === "查一个很长的任务名字…" && titleOf(gidOf(b)) === "短名",
    JSON.stringify(st.groups)
  );
}

{
  const st = freshState();
  st.groups.push({ id: 80, title: "查域名", color: "blue" });
  st.tabs.push({ id: 81, windowId: 10, groupId: 80, url: "https://agent.example.com/a", title: "agent 的", status: "complete" });
  st.groups.push({ id: 90, title: "查域名", color: "blue" });
  st.tabs.push({ id: 91, windowId: 10, groupId: 90, url: "https://user.example.com/x", title: "用户的", status: "complete" });
  st.localStorage["aic-our-81"] = 1;
  const T = loadSw(st);
  await new Promise((res) => setTimeout(res, 30));

  check("没有标记的 agent 组照样被认出来（被自动解散了）", !st.groups.some((g) => g.id === 80), JSON.stringify(st.groups));
  check("同名同色的用户组不算我们的（一动不动）", st.groups.some((g) => g.id === 90) && st.tabs.find((t) => t.id === 91)?.groupId === 90, JSON.stringify(st.groups));

  const r = await T.close_all({ scope: "all" }, "s1");
  check("close_all 也按账本认领，关掉的是 agent 那张", st.removed.includes(81), JSON.stringify(st.removed));
  check("用户那张一根汗毛没动", !st.removed.includes(91) && st.tabs.some((t) => t.id === 91), JSON.stringify(r));

  const st2 = freshState();
  st2.groups.push({ id: 95, title: "🟢 旧版本的组", color: "green" });
  st2.tabs.push({ id: 96, windowId: 10, groupId: 95, url: "https://legacy.example.com/", title: "旧的", status: "complete" });
  const T2 = loadSw(st2);
  await new Promise((res) => setTimeout(res, 30));
  check("旧版本带 emoji 前缀的组仍然认得出来（只认不写）", !st2.groups.some((g) => g.id === 95), JSON.stringify(st2.groups));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://one.example.com/", label: "防复活" }, "s1");
  await T.close_all({}, "s1");
  check("close_all 关空组前先解散了组", st.ungrouped.flat().includes(a.tabId), JSON.stringify(st.ungrouped));
  check("解散不代替关闭，页照旧被关掉", st.removed.includes(a.tabId), JSON.stringify(st.removed));

  const st2 = freshState();
  const T2 = loadSw(st2);
  const b = await T2.new_tab({ url: "https://two.example.com/", label: "防复活2" }, "s1");
  await T2.close_tab({ tabId: b.tabId }, "s1");
  check("close_tab 关空组前也先解散", st2.ungrouped.flat().includes(b.tabId), JSON.stringify(st2.ungrouped));
  check("close_tab 的页照旧被关掉", st2.removed.includes(b.tabId), JSON.stringify(st2.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://mine.example.com/", label: "带搭车客" }, "s1");
  const gid = st.tabs.find((t) => t.id === a.tabId)?.groupId;
  st.tabs.push({ id: 777, windowId: 10, groupId: gid, url: "https://rider.example.com/", title: "搭车的", status: "complete" });
  const r = await T.close_all({}, "s1");
  check("搭车的页没被关", !st.removed.includes(777) && st.tabs.some((t) => t.id === 777), JSON.stringify(st.removed));
  check("搭车的页被移出组还给用户", st.tabs.find((t) => t.id === 777)?.groupId === -1, JSON.stringify(st.tabs.find((t) => t.id === 777)));
  check("agent 自己的页照关", st.removed.includes(a.tabId), JSON.stringify(r));
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const past = () => tick(320);
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
  const gid = st.tabs.find((t) => t.id === a.tabId)?.groupId;

  st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", {
    url: "https://mine.example.com/detail",
    windowName: "_blank",
    userGesture: true,
    windowFeatures: ["menubar", "toolbar", "status", "scrollbars", "resizable", "noopener"],
  });
  await tick();
  const popup = { id: 901, windowId: 10, groupId: gid, openerTabId: 555, url: "", title: "", status: "complete" };
  st.tabs.push(popup);
  st.chrome.tabs.onCreated._fire({ ...popup });
  await tick();
  check("弹出的页记进角标（组里几张就报几张）", st.action.badge === "2", JSON.stringify(st.action));
  check("弹出的页记进页账本（任务名跟开窗的那张页走）", st.localStorage["aic-our-901"]?.l === "任务甲", JSON.stringify(st.localStorage["aic-our-901"]));
  check(
    "认领的页进了本会话的持有清单（tabId 可直接用）",
    (await T.status({}, "s1")).tabs.some((t) => t.tabId === 901),
    JSON.stringify((await T.status({}, "s1")).tabs)
  );
  check("认领当场就挂上调试器", st.attached.includes(901), JSON.stringify(st.attached));
  check(
    "接管遮蔽（光晕/护盾）当场就装进去了",
    st.cdp.some((c) => c.tabId === 901 && c.method === "Page.addScriptToEvaluateOnNewDocument" && /__aicCursor/.test(c.params?.source || "")),
    JSON.stringify(st.cdp.filter((c) => c.tabId === 901).map((c) => c.method))
  );

  st.tabs.push({ id: 902, windowId: 10, groupId: gid, url: "https://restored.example.com/", title: "用户恢复的", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 902, windowId: 10, groupId: gid, url: "https://restored.example.com/" });
  st.tabs.push({ id: 903, windowId: 10, groupId: -1, openerTabId: 555, url: "https://other.example.com/", title: "别处开的", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 903, windowId: 10, groupId: -1, openerTabId: 555, url: "https://other.example.com/" });
  st.tabs.push({ id: 905, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", pendingUrl: "chrome://newtab/", title: "New Tab", status: "loading" });
  st.chrome.tabs.onCreated._fire({ id: 905, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", pendingUrl: "chrome://newtab/" });
  await past();
  check(
    "没有 windowOpen 就不认领（用户恢复的 / 别处开的 / 用户手势开的 chrome://newtab）",
    st.action.badge === "2" && !st.localStorage["aic-our-902"] && !st.localStorage["aic-our-903"] && !st.localStorage["aic-our-905"],
    JSON.stringify(st.action)
  );

  st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/blank-born", windowName: "_blank" });
  await tick();
  st.tabs.push({ id: 906, windowId: 10, groupId: gid, openerTabId: a.tabId, url: "", title: "", status: "loading" });
  st.chrome.tabs.onCreated._fire({ id: 906, windowId: 10, groupId: gid, openerTabId: a.tabId, url: "" });
  await tick();
  check("出生 URL 空着照样认领（真机常态）", st.localStorage["aic-our-906"]?.l === "任务甲", JSON.stringify(st.localStorage["aic-our-906"]));

  st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", {
    url: "https://mine.example.com/oauth",
    windowFeatures: ["width=400", "height=300", "resizable"],
  });
  await tick();
  st.tabs.push({ id: 904, windowId: 77, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 904, windowId: 77, groupId: -1, openerTabId: a.tabId, url: "" });
  await tick();
  check("独立小窗的弹窗也认领", st.localStorage["aic-our-904"]?.l === "任务甲", JSON.stringify(st.localStorage["aic-our-904"]));
  check("独立小窗一样挂上调试器（遮蔽不因为它在别的窗口就没有）", st.attached.includes(904), JSON.stringify(st.attached));

  await T.new_tab({ url: "https://b.example.com/", label: "任务乙" }, "s1");
  const r = await T.close_all({ label: "任务甲" }, "s1");
  check("close_all 点名任务时连同它弹出的页一起关", st.removed.includes(a.tabId) && st.removed.includes(901), JSON.stringify({ removed: st.removed, r }));
  check("组外的独立小窗也一起关（组不是唯一的抓手）", st.removed.includes(904), JSON.stringify(st.removed));
  check("别的任务的页和用户的页都没被连坐", !st.removed.includes(902) && st.tabs.some((t) => t.url === "https://b.example.com/"), JSON.stringify(st.removed));
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
  const gid = st.tabs.find((t) => t.id === a.tabId)?.groupId;
  const fgFrames = () => st.sent.filter((m) => m.type === "foreground-restore");
  check("平时不发 foreground-restore", fgFrames().length === 0, JSON.stringify(fgFrames()));

  st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/detail" });
  await tick();
  st.tabs.push({ id: 921, windowId: 10, groupId: gid, openerTabId: a.tabId, url: "", title: "", status: "loading" });
  st.chrome.tabs.onCreated._fire({ id: 921, windowId: 10, groupId: gid, openerTabId: a.tabId, url: "" });
  await tick();
  const f = fgFrames();
  check("认领新页时发了一帧 foreground-restore", f.length === 1, JSON.stringify(st.sent.map((m) => m.type)));
  check("帧上带着 tabId 和 sid（本机侧只用来记账，不做判据）", f[0]?.tabId === 921 && f[0]?.sid === "s1", JSON.stringify(f[0]));
  check("帧上带着扩展这一侧还了什么（便于排查两套是不是重叠了）", "restored" in (f[0] || {}), JSON.stringify(f[0]));

  st.tabs.push({ id: 922, windowId: 10, groupId: -1, openerTabId: 555, url: "https://other.example.com/", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 922, windowId: 10, groupId: -1, openerTabId: 555, url: "https://other.example.com/" });
  await tick(320);
  check("没认领的页不发 foreground-restore", fgFrames().length === 1, JSON.stringify(fgFrames()));
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const st = freshState();
  st.page = makePage([el("a", { innerText: "开新页", href: "https://mine.example.com/mid", box: [0, 0, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const snap = await T.read_page({}, "s1");
  const ref = snap.elements?.[0]?.ref || "ref_1";

  await T.click({ ref, button: "middle" }, "s1");
  st.tabs.push({ id: 931, windowId: 10, groupId: -1, url: "https://mine.example.com/mid", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 931, windowId: 10, groupId: -1, url: "https://mine.example.com/mid" });
  await tick();
  check("中键点出来的新页被认领（没有 openerTabId 也认）", !!st.localStorage["aic-our-931"], JSON.stringify(st.localStorage["aic-our-931"]));
  check("中键那张页也挂上了调试器", st.attached.includes(931), JSON.stringify(st.attached));

  await T.click({ ref, modifiers: ["cmd"], tabId: 1 }, "s1");
  st.tabs.push({ id: 932, windowId: 10, groupId: -1, url: "https://mine.example.com/cmd", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 932, windowId: 10, groupId: -1, url: "https://mine.example.com/cmd" });
  await tick();
  check("Cmd+左键点出来的新页也被认领", !!st.localStorage["aic-our-932"], JSON.stringify(st.localStorage["aic-our-932"]));

  await T.click({ ref, tabId: 1 }, "s1");
  st.tabs.push({ id: 933, windowId: 10, groupId: -1, url: "https://user.example.com/own", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 933, windowId: 10, groupId: -1, url: "https://user.example.com/own" });
  await tick(320);
  check("普通左键之后冒出来的无主新页不认领", !st.localStorage["aic-our-933"], JSON.stringify(st.localStorage["aic-our-933"]));

  await T.click({ ref, button: "middle", tabId: 1 }, "s1");
  await tick(600);
  st.tabs.push({ id: 934, windowId: 10, groupId: -1, url: "https://user.example.com/late", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 934, windowId: 10, groupId: -1, url: "https://user.example.com/late" });
  await tick(320);
  check("点击意图过期后不再收编（500ms 之外的页是用户的）", !st.localStorage["aic-our-934"], JSON.stringify(st.localStorage["aic-our-934"]));

  const r = await T.close_all({ scope: "session" }, "s1");
  check("close_all 关掉了中键/Cmd 开出的那两张（不是解组还人）",
    st.removed.includes(931) && st.removed.includes(932), JSON.stringify({ removed: st.removed, r }));
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const past = () => tick(320);

  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
  st.tabs.push({ id: 810, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", status: "complete" });
  st.chrome.debugger.onEvent._fire({ tabId: 810 }, "Page.windowOpen", { url: "https://user.example.com/popup" });
  await tick();
  st.tabs.push({ id: 811, windowId: 10, groupId: -1, openerTabId: 810, url: "", title: "", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 811, windowId: 10, groupId: -1, openerTabId: 810, url: "" });
  await past();
  check("用户页开的窗不认领", !st.localStorage["aic-our-811"] && !st.attached.includes(811), JSON.stringify(st.localStorage["aic-our-811"]));

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000;
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/user-clicked" });
    await tick();
  } finally {
    Date.now = realNow;
  }
  st.tabs.push({ id: 812, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
  st.chrome.tabs.onCreated._fire({ id: 812, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "" });
  await past();
  check("窗外的开页不认领（用户自己在 agent 页上点的链接）", !st.localStorage["aic-our-812"] && !st.attached.includes(812), JSON.stringify(st.localStorage["aic-our-812"]));

  st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/stale" });
  await tick(60);
  const realNow2 = Date.now;
  try {
    Date.now = () => realNow2() + 10_000;
    st.tabs.push({ id: 813, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
    st.chrome.tabs.onCreated._fire({ id: 813, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "" });
    await past();
  } finally {
    Date.now = realNow2;
  }
  check("过期的开窗意图不许被别的页领走", !st.localStorage["aic-our-813"], JSON.stringify(st.localStorage["aic-our-813"]));
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const bornInForeground = async (st, tab) => {
    for (const x of st.tabs) if (x.windowId === tab.windowId) x.active = false;
    tab.active = true;
    st.tabs.push(tab);
    st.chrome.tabs.onActivated._fire({ tabId: tab.id, windowId: tab.windowId });
    st.chrome.tabs.onCreated._fire({ ...tab });
    await tick();
  };

  {
    const st = freshState();
    const T = loadSw(st);
    st.tabs.push({ id: 850, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", status: "complete" });
    for (const x of st.tabs) x.active = x.id === 850;
    const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    check("基线：agent 自己开的页不激活（active:false）", st.tabs.find((t) => t.id === a.tabId)?.active === false, JSON.stringify(st.tabs.find((t) => t.id === a.tabId)));
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/detail" });
    await tick();
    await bornInForeground(st, { id: 851, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
    check("认领了这张页（前提没变）", !!st.localStorage["aic-our-851"], JSON.stringify(Object.keys(st.localStorage)));
    check(
      "抢走的前台当场还回去：用户原来那张页又是活动页",
      st.tabs.find((t) => t.id === 850)?.active === true,
      JSON.stringify(st.tabs.map((t) => [t.id, t.active]))
    );
    check("被认领的新页退回后台", st.tabs.find((t) => t.id === 851)?.active === false, JSON.stringify(st.tabs.find((t) => t.id === 851)));
    check(
      "还回去的是用户那张，不是 agent 自己的页",
      st.tabUpdates.some((u) => u.id === 850 && u.props?.active) && !st.tabUpdates.some((u) => u.id === a.tabId && u.props?.active),
      JSON.stringify(st.tabUpdates.filter((u) => u.props?.active))
    );
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.tabs.push({ id: 860, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", status: "complete" });
    for (const x of st.tabs) x.active = x.id === 860;
    st.tabs.push({ id: 861, windowId: 10, groupId: -1, url: "https://user.example.com/2", title: "用户的另一张", status: "complete" });
    const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/detail" });
    await tick();
    const born = { id: 862, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" };
    for (const x of st.tabs) if (x.windowId === 10) x.active = false;
    born.active = true;
    st.tabs.push(born);
    st.chrome.tabs.onActivated._fire({ tabId: 862, windowId: 10 });
    born.active = false;
    st.tabs.find((t) => t.id === 861).active = true;
    st.chrome.tabs.onActivated._fire({ tabId: 861, windowId: 10 });
    st.chrome.tabs.onCreated._fire({ ...born, active: false });
    await tick();
    check("认领照旧（换不换前台是两码事）", !!st.localStorage["aic-our-862"], JSON.stringify(Object.keys(st.localStorage)));
    check(
      "用户已经自己切走了就不再动他的活动页",
      st.tabs.find((t) => t.id === 861)?.active === true && !st.tabUpdates.some((u) => u.props?.active),
      JSON.stringify(st.tabUpdates.filter((u) => u.props?.active))
    );
  }

  const focusCase = async (prevWin, label, expectRestore) => {
    const st = freshState();
    st.focusedWindowId = 10;
    const T = loadSw(st);
    (st.windows = st.windows || []).push(prevWin);
    st.focusedWindowId = prevWin.id;
    const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/popup" });
    await tick();
    const win = { id: 77, state: "normal", type: "popup" };
    st.windows.push(win);
    st.focusedWindowId = 77;
    st.chrome.windows.onFocusChanged._fire(77);
    await bornInForeground(st, { id: 871, windowId: 77, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
    const gaveBack = st.windowUpdates.some((u) => u.id === prevWin.id && u.p?.focused === true);
    check(
      `焦点归还：${label}`,
      gaveBack === expectRestore,
      JSON.stringify(st.windowUpdates)
    );
  };
  await focusCase({ id: 60, state: "normal", type: "normal" }, "普通非全屏窗口 → 还", true);
  {
    const st = freshState();
    const T = loadSw(st);
    st.tabs.push({ id: 900, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", status: "complete" });
    for (const x of st.tabs) x.active = x.id === 900;
    (st.windows = st.windows || []).push({ id: 63, state: "normal", type: "normal" });
    st.focusedWindowId = 63;
    st.chrome.windows.onFocusChanged._fire(63);
    const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    st.focusedWindowId = 10;
    st.chrome.windows.onFocusChanged._fire(10);
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/detail" });
    await tick();
    await bornInForeground(st, { id: 901, windowId: 10, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
    check(
      "焦点归还：焦点不是我们抢的（用户自己切的窗口）→ 一动不动",
      !st.windowUpdates.some((u) => u.p?.focused != null),
      JSON.stringify(st.windowUpdates)
    );
    check("但同窗口的活动页照样还回去", st.tabs.find((t) => t.id === 900)?.active === true, JSON.stringify(st.tabs.map((t) => [t.id, t.active])));
  }
  await focusCase({ id: 61, state: "normal", type: "popup" }, "window.open 的小窗 → 不还（实测还了会被抢回去）", false);
  await focusCase({ id: 62, state: "fullscreen", type: "normal" }, "原生全屏窗口 → 不还（跨 Space）", false);

  {
    const st = freshState();
    const T = loadSw(st);
    const a = await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    st.focusedWindowId = -1;
    st.chrome.windows.onFocusChanged._fire(-1);
    st.chrome.debugger.onEvent._fire({ tabId: a.tabId }, "Page.windowOpen", { url: "https://mine.example.com/popup" });
    await tick();
    (st.windows = st.windows || []).push({ id: 78, state: "normal", type: "popup" });
    st.focusedWindowId = 78;
    st.chrome.windows.onFocusChanged._fire(78);
    await bornInForeground(st, { id: 881, windowId: 78, groupId: -1, openerTabId: a.tabId, url: "", title: "", status: "complete" });
    check(
      "用户在别的 app：一次 windows.update 都不发（还不回去就别装）",
      !st.windowUpdates.some((u) => u.p?.focused != null),
      JSON.stringify(st.windowUpdates)
    );
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.tabs.push({ id: 890, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", status: "complete" });
    for (const x of st.tabs) x.active = x.id === 890;
    await T.new_tab({ url: "https://mine.example.com/", label: "任务甲" }, "s1");
    await tick();
    await bornInForeground(st, { id: 891, windowId: 10, groupId: -1, url: "", title: "", status: "complete" });
    await tick(320);
    check(
      "用户自己开的新页抢了前台也不动它（没有开窗意图 = 不是我们引起的）",
      st.tabs.find((t) => t.id === 891)?.active === true && !st.tabUpdates.some((u) => u.props?.active),
      JSON.stringify(st.tabUpdates.filter((u) => u.props?.active))
    );
  }
}

{
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const st = freshState();
  st.localStorage["aic-agent-window"] = 10;
  st.localStorage["aic-our-950"] = { l: "任务甲" };
  st.syncStorage = { sepWin: true };
  st.tabs.push({ id: 950, windowId: 10, groupId: -1, url: "https://mine.example.com/", title: "agent 的页", status: "complete" });
  st.tabs.push({ id: 951, windowId: 10, groupId: -1, url: "https://user.example.com/", title: "用户的页", active: true, status: "complete" });
  const T = loadSw(st);
  await tick();
  const a = await T.new_tab({ url: "https://mine.example.com/2", label: "任务甲" }, "s1");
  await tick();
  const born = st.tabs.find((t) => t.id === a.tabId);
  check(
    "用户窗口里有 agent 的页也不认成 agent 窗口（新页没开进 10 号窗口）",
    born?.windowId !== 10,
    JSON.stringify({ windowId: born?.windowId, creates: st.windowCreates })
  );
  check("而是另建了一个专属窗口", (st.windowCreates || []).length === 1, JSON.stringify(st.windowCreates));
  check("建窗时不抢焦点", (st.windowCreates || [])[0]?.focused === false, JSON.stringify(st.windowCreates));
}

{
  const st = freshState();
  loadSw(st);
  await new Promise((res) => setTimeout(res, 30));
  check("周期孤儿清扫的 alarm 已排上", (st.alarms || []).some((x) => x.name === "aic-orphan-sweep"), JSON.stringify(st.alarms));

  st.groups.push({ id: 70, title: "复活的组", color: "blue" });
  st.tabs.push({ id: 71, windowId: 10, groupId: 70, url: "https://ghost.example.com/", title: "复活的", status: "complete" });
  st.localStorage["aic-our-71"] = 1;
  st.chrome.alarms.onAlarm._fire({ name: "aic-orphan-sweep" });
  await new Promise((res) => setTimeout(res, 30));
  check("到点把它解散", !st.groups.some((g) => g.id === 70), JSON.stringify(st.groups));
  check("解散只摘胶囊，页一张不动", st.tabs.find((t) => t.id === 71)?.groupId !== 70 && !st.removed.includes(71), JSON.stringify(st.tabs.find((t) => t.id === 71)));
}

{
  const st = freshState();
  st.localStorage["aic-our-777"] = { url: "https://mail.example.com/inbox" };
  st.groups.push({ id: 300, title: "我的邮件", color: "purple" });
  st.tabs.push({ id: 301, windowId: 10, groupId: 300, url: "https://mail.example.com/inbox", title: "收件箱", status: "complete" });
  loadSw(st);
  await new Promise((res) => setTimeout(res, 30));

  check("URL 撞上不算我们的组：用户的组还在", st.groups.some((g) => g.id === 300), JSON.stringify(st.groups));
  check("URL 撞上不算我们的组：页也没被移出组", st.tabs.find((t) => t.id === 301)?.groupId === 300, JSON.stringify(st.tabs.find((t) => t.id === 301)));
  check("死掉的账本条目被清掉（否则那条猜测永不过期）", !("aic-our-777" in st.localStorage), JSON.stringify(Object.keys(st.localStorage)));
}

{
  const st = freshState();
  st.localStorage["aic-our-group-310"] = 1;
  st.groups.push({ id: 310, title: "查资料", color: "cyan" });
  st.tabs.push({ id: 311, windowId: 10, groupId: 310, url: "https://x.example.com/", title: "页", status: "complete" });
  loadSw(st);
  await new Promise((res) => setTimeout(res, 30));
  check("组账本上的组认得出来（页全换过也认得）", !st.groups.some((g) => g.id === 310), JSON.stringify(st.groups));
  check("解散后组账本上那笔也销了", !("aic-our-group-310" in st.localStorage), JSON.stringify(Object.keys(st.localStorage)));
}

{
  const st = freshState();
  const anchor = "chrome-extension://aic-test/agent-window.html";
  st.localStorage["aic-agent-window"] = 20;
  st.tabs.push({ id: 320, windowId: 20, url: anchor, title: "锚点", pinned: true, status: "complete" });
  st.groups.push({ id: 321, title: "重启前的任务", color: "orange" });
  st.tabs.push({ id: 322, windowId: 20, groupId: 321, url: "https://y.example.com/", title: "恢复出来的页", status: "complete" });
  st.groups.push({ id: 331, title: "重启前的任务", color: "orange" });
  st.tabs.push({ id: 332, windowId: 10, groupId: 331, url: "https://y.example.com/", title: "用户的", status: "complete" });
  loadSw(st);
  await new Promise((res) => setTimeout(res, 30));
  check("重启后 agent 窗口里的遗留组仍被解散", !st.groups.some((g) => g.id === 321), JSON.stringify(st.groups));
  check("用户窗口里同名同色的组不受牵连", st.groups.some((g) => g.id === 331), JSON.stringify(st.groups));
}

{
  const st = freshState();
  st.localStorage.sepWin = true;
  st.localStorage["aic-agent-window"] = 10;
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.tabs.find((t) => t.id === a.tabId)?.windowId;
  check("没把用户窗口当成 agent 窗口认领走", wid !== 10, JSON.stringify({ wid, creates: st.windowCreates?.length }));
  check("认不回来就另建一个专属窗口", (st.windowCreates || []).length === 1, JSON.stringify(st.windowCreates));
}

{
  const st = freshState();
  const T = loadSw(st);
  const nt = await T.new_tab({ url: "https://a.example.com" }, "s1");
  check("自己开的页记进了认领账本", `aic-our-${nt.tabId}` in st.localStorage, JSON.stringify(Object.keys(st.localStorage)));
  await T.tab_release({ tabId: nt.tabId }, "s1");
  check("放开后账本上立刻摘掉", !(`aic-our-${nt.tabId}` in st.localStorage), JSON.stringify(Object.keys(st.localStorage)));
}

{
  const st = freshState();
  const T = loadSw(st);

  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  check("开关默认关：页开在当前窗口", st.tabs.find((t) => t.id === a.tabId)?.windowId === 10, JSON.stringify(st.tabs.find((t) => t.id === a.tabId)));

  st.localStorage.sepWin = true;
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const wb = st.tabs.find((t) => t.id === b.tabId)?.windowId;
  check("开关开着：新页去专属窗口", wb !== 10 && (st.windowCreates || []).length === 1, JSON.stringify({ wb, creates: st.windowCreates }));
  check("专属窗口不抢焦点", st.windowCreates[0].focused === false, JSON.stringify(st.windowCreates));

  const c = await T.new_tab({ url: "https://c.example.com" }, "s2");
  check("别的会话也复用同一个专属窗口", st.tabs.find((t) => t.id === c.tabId)?.windowId === wb && st.windowCreates.length === 1, JSON.stringify(st.windowCreates));

  st.tabs = st.tabs.filter((t) => !st.windows.some((w) => w.id === t.windowId));
  st.windows.length = 0;
  const d = await T.new_tab({ url: "https://d.example.com" }, "s1");
  const wd = st.tabs.find((t) => t.id === d.tabId)?.windowId;
  check("专属窗口被用户关掉后重建", st.windowCreates.length === 2 && wd !== wb && wd !== 10, JSON.stringify(st.windowCreates));

  let r1 = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-sepwin", on: false }, {}, (x) => (r1 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("弹窗能关掉独立窗口偏好", r1?.on === false && st.localStorage.sepWin === false, JSON.stringify(r1));
  const e = await T.new_tab({ url: "https://e.example.com" }, "s1");
  check("关掉后回到当前窗口开页", st.tabs.find((t) => t.id === e.tabId)?.windowId === 10, JSON.stringify(st.tabs.find((t) => t.id === e.tabId)));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.tabs.find((t) => t.id === a.tabId)?.windowId;

  const anchor = st.tabs.find((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || ""));
  check("专属窗口里有一张锚点页", !!anchor, JSON.stringify(st.tabs.filter((t) => t.windowId === wid)));
  check("锚点页被钉住（钉住的页不进标签条的可关区）", anchor?.pinned === true, JSON.stringify(anchor));
  check("agent 的页是另开的一张，没有拿锚点页顶替", a.tabId !== anchor?.id, JSON.stringify({ tab: a.tabId, anchor: anchor?.id }));

  const listed = await T.tabs_list({}, "s1");
  check("tabs_list 里没有锚点页", !listed.tabs.some((t) => /agent-window\.html$/.test(t.url)), JSON.stringify(listed.tabs.map((t) => t.url)));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.userWindow = { id: 10, state: "normal", left: 1920, top: 0, width: 1512, height: 982 };
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const b = st.windowCreates[0]?.bounds;
  check("建窗带了显式 bounds", !!b, JSON.stringify(st.windowCreates));
  check("bounds 落在最后聚焦那块屏上", b && b.left >= 1920 && b.left < 1920 + 1512, JSON.stringify(b));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.tabs.find((t) => t.id === a.tabId)?.windowId;
  check("建窗时不带 state（带了会被 Chromium 拒）", !("state" in (st.windowCreates[0] || {})), JSON.stringify(st.windowCreates));
  const ups = st.windowUpdates.filter((u) => u.id === wid);
  check("建窗后把窗口最大化", ups.length === 1 && ups[0].p?.state === "maximized", JSON.stringify(st.windowUpdates));
  check("**绝不**用 state:\"fullscreen\"（那会新建 Space 并把用户拽过去）", !st.windowUpdates.some((u) => u.p?.state === "fullscreen"), JSON.stringify(st.windowUpdates));
  check("窗口照常收 agent 的页", st.tabs.find((t) => t.id === a.tabId)?.windowId === wid, JSON.stringify({ wid }));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.windowCreates[0].id;
  st.windowUpdates.length = 0;

  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-open-agent-window" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 50));
  check("给焦点", r?.ok === true && st.windowUpdates.some((u) => u.id === wid && u.p?.focused === true), JSON.stringify({ r, u: st.windowUpdates }));
  check("只给焦点，不碰 state（原生全屏会新建 Space 把用户拽走）", !st.windowUpdates.some((u) => u.p?.state), JSON.stringify(st.windowUpdates));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  await T.new_tab({ url: "https://b.example.com" }, "s2");
  st.chrome.windows.onFocusChanged._fire(10);
  await new Promise((r) => setTimeout(r, 40));
  const notMax = st.windowUpdates.filter((u) => !(Object.keys(u.p || {}).length === 1 && u.p.state === "maximized"));
  check("自动路径上除了建窗那次最大化，没有任何别的 windows.update", notMax.length === 0, JSON.stringify(notMax));

  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-open-agent-window" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 40));
  check("用户点了才 focus，而且不动 state（动了会把它拽出自己那个空间）",
    r?.ok === true && st.windowUpdates.some((u) => u.p?.focused === true && !("state" in u.p)),
    JSON.stringify({ r, updates: st.windowUpdates }));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.windowCreates[0].id;

  clearSession(st);
  st.tabs = st.tabs.filter((t) => !/agent-window\.html$/.test(t.url || ""));
  const T2 = loadSw(st);
  const b = await T2.new_tab({ url: "https://b.example.com" }, "s9");
  check("重载后认回原窗口，不再建第二个", st.windowCreates.length === 1, JSON.stringify(st.windowCreates));
  check("认回来的页确实开进了那个窗口", st.tabs.find((t) => t.id === b.tabId)?.windowId === wid, JSON.stringify({ wid }));
  const anchor = st.tabs.find((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || ""));
  check("认回来之后把丢掉的锚点页补回来了", !!anchor && anchor.pinned === true, JSON.stringify(st.tabs.filter((t) => t.windowId === wid)));
}

{
  const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  const ANCHOR = /agent-window\.html$/;
  const simulateReload = (st) => {
    clearSession(st);
    for (const t of st.tabs) {
      if (ANCHOR.test(t.url || "")) {
        t.url = "chrome://newtab/";
        t.title = "New Tab";
        t.pinned = false;
      }
    }
  };

  {
    const st = freshState();
    const T = loadSw(st);
    st.localStorage.sepWin = true;
    await T.new_tab({ url: "https://a.example.com" }, "s1");
    const wid = st.windowCreates[0].id;
    const corpseId = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || "")).id;
    simulateReload(st);
    st.windowUpdates.length = 0;
    loadSw(st);
    await tick();
    const anchor = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || ""));
    check("重载后 SW 一起来就补回了锚点页（没等 new_tab）", !!anchor && anchor.pinned === true, JSON.stringify(st.tabs.filter((t) => t.windowId === wid)));
    check("Chrome 顶上来的那张 chrome://newtab 被收掉了", !st.tabs.some((t) => t.id === corpseId), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("agent 自己的页一张没动", st.tabs.some((t) => t.windowId === wid && t.url === "https://a.example.com"));
    check("整个过程没有一次 windows.update", st.windowUpdates.length === 0, JSON.stringify(st.windowUpdates));
    check("也没有把任何页激活", !st.tabs.some((t) => t.windowId === wid && t.active === true), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.active])));
    check("没有另建第二个专属窗口", st.windowCreates.length === 1, JSON.stringify(st.windowCreates));
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.localStorage.sepWin = true;
    const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
    const wid = st.windowCreates[0].id;
    const corpseId = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || "")).id;
    await T.close_all({}, "s1");
    simulateReload(st);
    st.windowUpdates.length = 0;
    loadSw(st);
    await tick();
    const anchor = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || ""));
    check("空窗也认得回来：锚点补上了", !!anchor && anchor.pinned === true, JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("空窗里那张 newtab 也收掉了", !st.tabs.some((t) => t.id === corpseId), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("没有另建第二个专属窗口（正是这个 bug 攒出空窗的方式）", st.windowCreates.length === 1, JSON.stringify(st.windowCreates));
    check("空窗修好后一次 windows.update 都没有", st.windowUpdates.length === 0, JSON.stringify(st.windowUpdates));
    void a;
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.localStorage.sepWin = true;
    await T.new_tab({ url: "https://a.example.com" }, "s1");
    const wid = st.windowCreates[0].id;
    const corpseId = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || "")).id;
    simulateReload(st);
    st.localStorage.sepWin = false;
    loadSw(st);
    await tick();
    check("开关关着：那张 newtab 原封不动", st.tabs.some((t) => t.id === corpseId), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("开关关着：也不去补锚点", !st.tabs.some((t) => t.windowId === wid && ANCHOR.test(t.url || "")));
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.localStorage.sepWin = true;
    await T.new_tab({ url: "https://a.example.com" }, "s1");
    const wid = st.windowCreates[0].id;
    const corpseId = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || "")).id;
    clearSession(st);
    loadSw(st);
    await tick();
    check("前提：这一趟冷启动时锚点还在，没被误当成尸体收掉", st.tabs.some((t) => t.id === corpseId && ANCHOR.test(t.url || "")), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    const corpse = st.tabs.find((t) => t.id === corpseId);
    corpse.url = "chrome://newtab/";
    corpse.title = "New Tab";
    corpse.pinned = false;
    st.windowUpdates.length = 0;
    st.chrome.tabs.onUpdated._fire(corpseId, { url: "chrome://newtab/" }, corpse);
    await tick(80);
    const anchorNow = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || ""));
    check("锚点被换掉的那一刻就补回来了（不用等下一次冷启动）", !!anchorNow && anchorNow.pinned === true, JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("换上来的那张 chrome://newtab 当场收掉", !st.tabs.some((t) => t.id === corpseId), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("这条路上也没有 windows.update", st.windowUpdates.length === 0, JSON.stringify(st.windowUpdates));
    check("也没有另建窗口", st.windowCreates.length === 1, JSON.stringify(st.windowCreates));
  }

  {
    const st = freshState();
    const T = loadSw(st);
    st.localStorage.sepWin = true;
    await T.new_tab({ url: "https://a.example.com" }, "s1");
    const wid = st.windowCreates[0].id;
    const mine = st.tabs.find((t) => t.windowId === wid && ANCHOR.test(t.url || "")).id;
    const hisId = ++st.nextTabId;
    st.tabs.push({ id: hisId, windowId: wid, groupId: -1, url: "chrome://newtab/", title: "New Tab", status: "complete" });
    clearSession(st);
    loadSw(st);
    await tick();
    check("用户拖进来的空白新标签页一根汗毛都不碰", st.tabs.some((t) => t.id === hisId), JSON.stringify(st.tabs.filter((t) => t.windowId === wid).map((t) => [t.id, t.url])));
    check("锚点本来就在，没被当成多余的空白页关掉", st.tabs.some((t) => t.id === mine));
  }
}

{
  const ANCHOR2 = /agent-window\.html$/;
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.windowCreates[0].id;
  check("前提：第一张页进了专属窗口", st.tabs.find((t) => t.id === a.tabId)?.windowId === wid, JSON.stringify({ wid }));

  clearSession(st);
  const corpse = st.tabs.find((t) => t.windowId === wid && ANCHOR2.test(t.url || ""));
  st.tabs = st.tabs.filter((t) => t !== corpse);
  st.localStorage["aic-agent-anchor"] = undefined;
  delete st.localStorage["aic-agent-anchor"];
  const hisId = ++st.nextTabId;
  st.tabs.push({ id: hisId, windowId: wid, groupId: -1, url: "https://user.example.com/mail", title: "用户自己的页", status: "complete" });

  const T2 = loadSw(st);
  const b = await T2.new_tab({ url: "https://b.example.com" }, "s9");
  const wb = st.tabs.find((t) => t.id === b.tabId)?.windowId;
  check("窗口里有外人的页 = 证不出独占，下一次 new_tab 不落进那个窗口", wb !== wid, JSON.stringify({ wid, wb }));
  check("而是另建一个真正独占的专属窗口", st.windowCreates.length === 2 && wb === st.windowCreates[1].id, JSON.stringify(st.windowCreates.map((w) => w.id)));
  check("用户拖进来的那张页一根汗毛都没碰", st.tabs.some((t) => t.id === hisId && t.url === "https://user.example.com/mail"));

  const st2 = freshState();
  const T3 = loadSw(st2);
  st2.localStorage.sepWin = true;
  await T3.new_tab({ url: "https://a.example.com" }, "s1");
  const wid2 = st2.windowCreates[0].id;
  clearSession(st2);
  st2.tabs = st2.tabs.filter((t) => !ANCHOR2.test(t.url || ""));
  const T4 = loadSw(st2);
  const c = await T4.new_tab({ url: "https://c.example.com" }, "s9");
  check("对照：窗口里全是账本上的页时，重载后照旧认得回来", st2.tabs.find((t) => t.id === c.tabId)?.windowId === wid2 && st2.windowCreates.length === 1, JSON.stringify(st2.windowCreates.map((w) => w.id)));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.windowCreates[0].id;
  const anchorUrl = st.tabs.find((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || "")).url;
  st.tabs.push({ id: ++st.nextTabId, windowId: wid, url: anchorUrl, title: "锚点", pinned: true, status: "complete" });
  st.tabs.push({ id: ++st.nextTabId, windowId: wid, url: anchorUrl, title: "锚点", pinned: true, status: "complete" });

  clearSession(st);
  const T2 = loadSw(st);
  await T2.new_tab({ url: "https://b.example.com" }, "s9");
  const left = st.tabs.filter((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || ""));
  check("重复的锚点页被清到只剩一张", left.length === 1, `剩 ${left.length} 张`);
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.windowCreates[0].id;
  const anchor = st.tabs.find((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || "")).url;
  const origin = anchor.slice(0, anchor.lastIndexOf("/") + 1);
  const popupId = ++st.nextTabId;
  st.tabs.push({ id: popupId, windowId: wid, url: origin + "popup.html", title: "Agent in Chrome", status: "complete" });

  await T.new_tab({ url: "https://b.example.com" }, "s1");
  check("扩展自己的其它页不会被当成重复锚点关掉", st.tabs.some((t) => t.id === popupId), JSON.stringify(st.removed));
  check("锚点本身仍然只有一张", st.tabs.filter((t) => t.windowId === wid && /agent-window\.html$/.test(t.url || "")).length === 1);
}

{
  const st = freshState();
  const T = loadSw(st);
  st.chrome.tabs.query = async () => st.tabs;
  st.localStorage.sepWin = true;
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  check("过滤器不生效时也没把用户窗口认领走", st.tabs.find((t) => t.id === a.tabId)?.windowId !== 10, JSON.stringify(st.windowCreates));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const wid = st.tabs.find((t) => t.id === a.tabId)?.windowId;
  st.windows = st.windows.filter((w) => w.id !== wid);
  st.tabs = st.tabs.filter((t) => t.windowId !== wid);
  const b = await T.new_tab({ url: "https://b.example.com" }, "s1");
  const wb = st.tabs.find((t) => t.id === b.tabId)?.windowId;
  check("窗口被关掉后重建一个新的", st.windowCreates.length === 2 && wb !== wid && wb !== 10, JSON.stringify(st.windowCreates));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.localStorage.sepWin = true;
  const [a, b] = await Promise.all([
    T.new_tab({ url: "https://a.example.com" }, "s1"),
    T.new_tab({ url: "https://b.example.com" }, "s2"),
  ]);
  check("并发建窗只建出一个", (st.windowCreates || []).length === 1, JSON.stringify(st.windowCreates));
  const wa = st.tabs.find((t) => t.id === a.tabId)?.windowId;
  const wb = st.tabs.find((t) => t.id === b.tabId)?.windowId;
  check("两个会话的页都落在同一个专属窗口里", wa === wb && wa !== 10, JSON.stringify({ wa, wb }));
}

{
  const st = freshState();
  loadSw(st);
  st.chrome.runtime.onMessage._fire({ type: "popup-sepwin", on: true }, {}, () => {});
  await new Promise((res) => setTimeout(res, 50));
  check("打开开关就把专属窗口建出来，不等第一次开页", (st.windowCreates || []).length === 1, JSON.stringify(st.windowCreates));

  st.chrome.runtime.onMessage._fire({ type: "popup-sepwin", on: true }, {}, () => {});
  await new Promise((res) => setTimeout(res, 50));
  check("再按一次不会又建一个", st.windowCreates.length === 1, JSON.stringify(st.windowCreates));
}

{
  const st = freshState();
  loadSw(st);
  st.chrome.runtime.onMessage._fire({ type: "popup-sepwin", on: true }, {}, () => {});
  await new Promise((res) => setTimeout(res, 30));
  check("偏好写进 sync（跨设备漫游）", st.syncStorage?.sepWin === true, JSON.stringify(st.syncStorage));
  check("同时双写 local（兜底位）", st.localStorage?.sepWin === true, JSON.stringify(st.localStorage));

  const st2 = freshState();
  st2.syncStorage = { sepWin: true };
  loadSw(st2);
  let r2 = null;
  st2.chrome.runtime.onMessage._fire({ type: "popup-sepwin" }, {}, (x) => (r2 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("另一台设备漫游来的偏好直接生效（sync 优先）", r2?.on === true, JSON.stringify(r2));

  const st3 = freshState();
  st3.localStorage = { sepWin: true };
  loadSw(st3);
  let r3 = null;
  st3.chrome.runtime.onMessage._fire({ type: "popup-sepwin" }, {}, (x) => (r3 = x));
  await new Promise((res) => setTimeout(res, 30));
  check("老版本只在 local 的偏好照样读到（升级迁移）", r3?.on === true, JSON.stringify(r3));

  const st4 = freshState();
  st4.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T4 = loadSw(st4);
  await T4.tab_use({ takeover: true, tabId: 1 });
  st4.cdp.length = 0;
  st4.chrome.storage.onChanged._fire({ cursorOn: { newValue: false } }, "sync");
  await new Promise((res) => setTimeout(res, 30));
  check(
    "漫游来的「关」立刻擦掉已挂页面的覆盖层",
    st4.cdp.some((c) => /__aic_cursor__.*remove/.test(c.params?.expression || "")),
    JSON.stringify(st4.cdp.map((c) => c.method))
  );
  check(
    "并把装机注册一起摘掉（导航后不复活）",
    st4.cdp.some((c) => c.method === "Page.removeScriptToEvaluateOnNewDocument"),
    JSON.stringify(st4.cdp.map((c) => c.method))
  );
  st4.cdp.length = 0;
  st4.chrome.storage.onChanged._fire({ cursorOn: { newValue: true } }, "local");
  await new Promise((res) => setTimeout(res, 30));
  check("local 区域的变更不触发（避免双写双触发）", !st4.cdp.some((c) => c.method === "Page.addScriptToEvaluateOnNewDocument"), JSON.stringify(st4.cdp.map((c) => c.method)));
}

{
  const st = freshState();
  const T = loadSw(st);
  const realAttach = st.chrome.debugger.attach;
  st.chrome.debugger.attach = (t, v, cb) => setTimeout(() => realAttach(t, v, cb), 30);

  await Promise.all([
    T.tab_use({ takeover: true, tabId: 1 }, "s1"),
    T.read_page({}, "s1").catch(() => {}),
    T.status({}, "s1"),
  ]);
  const attaches = st.attached.filter((x) => x === 1).length;
  check("并发调用只 attach 一次", attaches === 1, `实际 ${attaches} 次: ${JSON.stringify(st.attached)}`);

  st.detached.length = 0;
  await Promise.all([T.tab_release({}, "s1"), T.tab_release({}, "s1")]);
  const detaches = st.detached.filter((x) => x === 1).length;
  check("并发释放只 detach 一次", detaches === 1, `实际 ${detaches} 次`);
}

{
  const st = freshState();
  st.attachHang = (id) => id === 1;
  const T = loadSw(st);
  st.sandbox.__setAttachWatchdog(300);

  const wedged = st.sandbox.__attach(1);
  wedged.catch(() => {});
  await new Promise((r) => setTimeout(r, 20));

  const t0 = Date.now();
  const done = await Promise.race([
    st.sandbox.__detach(1).then(() => "返回了"),
    new Promise((r) => setTimeout(() => r("卡住"), 4000)),
  ]);
  check("在途 attach 永不回执时 detach 仍然返回", done === "返回了", `${done}（${Date.now() - t0}ms）`);

  const err = await Promise.race([
    wedged.then(() => null, (e) => String(e?.message || e)),
    new Promise((r) => setTimeout(() => r("一直挂着，没有以任何方式收场"), 4000)),
  ]);
  check("卡住的 attach 自己以报错收场，而不是一直挂着", !!err && /没有回音/.test(err), String(err));

  st.attachHang = null;
  const tries0 = st.attachTries;
  const again = await Promise.race([
    st.sandbox.__attach(1).then(() => "挂上了"),
    new Promise((r) => setTimeout(() => r("还在等那条死 Promise"), 4000)),
  ]);
  check("卡过一次之后还能重新 attach（不必重启 Chrome）", again === "挂上了", String(again));
  check("重试是真的又下发了一次 attach，不是复用旧记录", st.attachTries > tries0, `${tries0} → ${st.attachTries}`);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com", label: "甲" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com", label: "乙" }, "s1");
  const c = await T.new_tab({ url: "https://c.example.com", label: "丙" }, "s1");
  st.sandbox.__setAttachWatchdog(300);

  st.chrome.debugger.onDetach._fire({ tabId: b.tabId }, "target_closed");
  await new Promise((r) => setTimeout(r, 20));
  st.attachHang = (id) => id === b.tabId;
  st.sandbox.__attach(b.tabId).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));

  st.removed.length = 0;
  const t0 = Date.now();
  const r = await Promise.race([
    T.close_all({ scope: "session" }, "s1"),
    new Promise((res) => setTimeout(() => res("卡住"), 4000)),
  ]);
  check("一张页卡住时 close_all 仍然返回", r !== "卡住", `${Date.now() - t0}ms`);
  const gone = st.removed.flat();
  check("其余标签页照常关掉", gone.includes(a.tabId) && gone.includes(c.tabId), JSON.stringify(gone));
  check("卡住的那张自己也关掉了", gone.includes(b.tabId), JSON.stringify(gone));
}

const FOREIGN_REFUSAL = "Cannot access a chrome-extension:// URL of different extension";
const focusedInput = (st) => ({
  nodeType: 1,
  tagName: "INPUT",
  blur: () => (st.blurred = (st.blurred || 0) + 1),
});

function overlayHost(st, nodeName, opts = {}) {
  const body = st.page.doc.body;
  const el = {
    nodeType: 1,
    nodeName,
    tagName: nodeName,
    id: "",
    attributes: [],
    children: [],
    shadowRoot: null,
    parentNode: body,
    nextSibling: null,
    remove() {
      const i = body.children.indexOf(el);
      if (i >= 0) body.children.splice(i, 1);
      (st.removedOverlays = st.removedOverlays || []).push(nodeName);
    },
  };
  if (opts.openShadowFrame) {
    const frame = { nodeType: 1, nodeName: "IFRAME", tagName: "IFRAME", src: opts.openShadowFrame };
    el.children.push(frame);
    el.shadowRoot = {
      nodeType: 11,
      host: el,
      querySelectorAll: (sel) => (sel === "*" || /iframe/i.test(sel) ? [frame] : []),
    };
    el.children.length = 0;
  }
  body.children.push(el);
  return el;
}

function foreignFrame(st, url) {
  const el = { nodeType: 1, nodeName: "IFRAME", tagName: "IFRAME", src: url, id: "", attributes: [], children: [] };
  st.page.doc._all.push(el);
  return el;
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);

  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("浮层挡住时不是当场失败，而是等它收回再重挂", ok.tabId === 1 && st.attached.includes(1), JSON.stringify(st.attached));
  check("重挂之前先撤掉页面焦点（最轻的一级仍然排第一）", st.blurred >= 1, `blur ${st.blurred || 0} 次`);
  check("撤焦点是所有帧一起撤（浮层可能挂在子帧上）", (st.executed || []).some((e) => e.tabId === 1 && e.allFrames), JSON.stringify((st.executed || []).slice(0, 3)));
  check("重试次数有上限，不会一直磨", st.attachTries <= 5, `试了 ${st.attachTries} 次`);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const bar = overlayHost(st, "PB-UPLCJFVNSM");
  st.attachFail = () => (st.page.doc.body.children.includes(bar) ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  const t0 = Date.now();
  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  const ms = Date.now() - t0;
  check("撤焦点没用时立刻改摘宿主，不再一路等下去", ok.tabId === 1 && (st.removedOverlays || []).length === 1, JSON.stringify(st.removedOverlays));
  check("整条恢复在一秒以内收场（旧阶梯这里要 1.6s）", ms < 1000, `${ms}ms`);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  foreignFrame(st, "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html");
  foreignFrame(st, "chrome-extension://" + "eknmigackgheebnojadpjepdoebpfnil" + "/about.html");
  st.dbgTargets = [{ id: "t3", type: "iframe", tabId: 1, url: "chrome-extension://someotherextensionidhere/x.html" }];
  const T = loadSw(st);
  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;

  const r = await throws(() => T.read_page({}, "s1"), /挂不上调试器/);
  check("救不回来时如实报错，不装作能用", r.threw && r.match, r.msg);
  check("报错点名是哪个扩展的框架（页面侧扫出来的）", /nngceckbapebfimnlniiiahkandclblb/.test(r.msg), r.msg);
  check("不再采信 getTargets（真机上它这一刻什么都不返回）", !/someotherextensionidhere/.test(r.msg), r.msg);
  check("报错说清是哪个标签页、什么地址", /标签页 1/.test(r.msg) && /github\.com\/foo/.test(r.msg), r.msg);
  check("给出用户能执行的下一步", /关闭按钮|空白处/.test(r.msg) && /停用/.test(r.msg), r.msg);
  check("把标签组标成「需要你介入」（组变琥珀色）——用户唯一看得见的通道", st.groupUpdates.some((u) => u.props?.color === "yellow"), JSON.stringify(st.groupUpdates.map((u) => u.props)));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "TRANSLATE-PANEL", {
    openShadowFrame: "chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh/side-panel.html",
  });
  st.attachFail = () => (st.page.doc.body.children.includes(host) ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("open shadow root 里藏着外来扩展帧的宿主也摘得掉", ok.tabId === 1 && (st.removedOverlays || []).includes("TRANSLATE-PANEL"), JSON.stringify(st.removedOverlays));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const bar = overlayHost(st, "BIT-NOTIFICATION-BAR-ROOT");
  st.attachFail = () => (st.page.doc.body.children.includes(bar) ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);

  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("撤焦点不管用时，摘掉浮层宿主把标签页救回来", ok.tabId === 1 && st.attached.includes(1), JSON.stringify(st.attached));
  check("摘掉的正是那条提示条", (st.removedOverlays || []).includes("BIT-NOTIFICATION-BAR-ROOT"), JSON.stringify(st.removedOverlays));
  check("动别人的界面之前先试过撤焦点（这一级什么都不动）", st.blurred >= 1, `blur ${st.blurred || 0} 次`);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const mine = overlayHost(st, "APP-ROOT");
  st.attachFail = () => FOREIGN_REFUSAL;
  const T = loadSw(st);

  const r = await throws(() => T.tab_use({ tabId: 1, takeover: true }, "s1"), /挂不上调试器/);
  check("怎么都救不回来时如实报错", r.threw && r.match, r.msg);
  check("摘错了的原位放回（页面没被我们拆坏）", st.page.doc.body.children.includes(mine), JSON.stringify(st.page.doc.body.children.map((e) => e.nodeName)));
  check("报错里说明两级都试过了", /撤掉页面焦点/.test(r.msg) && /宿主元素/.test(r.msg), r.msg);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  st.dbgTargets = [
    { id: "t1", type: "page", tabId: 1, url: "https://example.com/login" },
    { id: "t2", type: "iframe", tabId: 1, url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html" },
  ];
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(4000);
  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = (id) => id === 1;

  const t0 = Date.now();
  const r = await throws(() => T.read_page({}, "s1"), /挂不上调试器/);
  const ms = Date.now() - t0;
  check("注入永不回执时，attach 仍然会 settle（不是被看门狗掐掉）", r.threw && r.match, r.msg);
  check("给的是那条准确的报错，不是「没有回音，可以直接重试」", !/没有回音/.test(r.msg), r.msg);
  check("点不出是谁的时候就不说，绝不编一个出来", !/chrome-extension:\/\//.test(r.msg), r.msg);
  check("点不出是谁也不影响这条报错可操作", /关闭按钮|空白处/.test(r.msg) && /停用/.test(r.msg), r.msg);
  check("照样把标签组标成「需要你介入」", st.groupUpdates.some((u) => u.props?.color === "yellow"), JSON.stringify(st.groupUpdates.map((u) => u.props)));
  check("在看门狗开火之前就收场了", ms < 4000, `${ms}ms < 4000ms 看门狗`);
  check("借来的页不许为了自救而重新加载", !st.tabUpdates.some((u) => u.reload), JSON.stringify(st.tabUpdates));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  st.dbgTargets = [
    { id: "t1", type: "page", tabId: 1, url: "https://example.com/login" },
    { id: "t2", type: "iframe", tabId: 1, url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html" },
  ];
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/login", label: "登录" }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = () => !!st.attachFail;
  const realReload = st.sandbox.chrome.tabs.reload;
  st.sandbox.chrome.tabs.reload = async (id, opts) => {
    const r = await realReload(id, opts);
    st.attachFail = null;
    return r;
  };

  let page = null;
  let boom = null;
  try {
    page = await T.read_page({}, "s1");
  } catch (e) {
    boom = String(e.message).slice(0, 100);
  }
  check("自己开的页：重新加载之后真的接管上了", !!page && !page.error, boom || JSON.stringify(page).slice(0, 90));
  page = page || {};
  check("确实调了 tabs.reload", st.tabUpdates.some((u) => u.reload), JSON.stringify(st.tabUpdates));

  const tick = () => new Promise((r) => setTimeout(r, 20));
  st.hostPort.onMessage._fire({ id: "rl1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick();
  const note = st.sent.find((m) => m.type === "result" && m.id === "rl1")?.data?.pageReloadedToRecover;
  check("下一个工具返回值里如实报了这一页被重新加载过", !!note, JSON.stringify(Object.keys(st.sent.find((m) => m.id === "rl1")?.data || {})));
  check("说清了「没提交的内容已经没了」", /没提交的内容/.test(note?.why || ""), note?.why);
  check("点得出是哪一页", note?.tabId === tab.tabId, JSON.stringify(note));
  st.hostPort.onMessage._fire({ id: "rl2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick();
  const res2 = st.sent.find((m) => m.type === "result" && m.id === "rl2");
  check("这条通知只报一次，不会每次调用都跟着", !(res2?.data && "pageReloadedToRecover" in res2.data));
}

const tick20 = () => new Promise((r) => setTimeout(r, 20));
const passwordBox = (st) => ({
  nodeType: 1,
  tagName: "INPUT",
  id: "login-password",
  name: "password",
  type: "password",
  getAttribute: (k) => (k === "aria-label" ? "密码" : null),
  blur: () => (st.blurred = (st.blurred || 0) + 1),
});

{
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);

  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("前提：确实撤了焦点", st.blurred >= 1, `blur ${st.blurred || 0} 次`);

  st.hostPort.onMessage._fire({ id: "fl1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const note = st.sent.find((m) => m.type === "result" && m.id === "fl1")?.data?.focusLostToRecovery;
  check("下一个工具返回值里如实报了「焦点被我们撤掉过」", !!note,
    JSON.stringify(Object.keys(st.sent.find((m) => m.id === "fl1")?.data || {})));
  check("说得出被撤的是哪个元素（够辨认就行）",
    note?.element?.tag === "input" && note.element.type === "password" &&
      note.element.id === "login-password" && note.element.label === "密码",
    JSON.stringify(note?.element));
  check("点得出是哪一页", note?.tabId === 1, JSON.stringify(note?.tabId));
  check("说明白了「没有自动聚焦回去」以及为什么", /没有自动聚焦回去/.test(note?.why || "") && /再招来/.test(note?.why || ""), note?.why);
  check("给出出路：靠环境焦点的操作要先重新指目标", /browser_press_key 可以带 ref/.test(note?.why || ""), note?.why);
  check("element 里的名字是页面写的，进 _fromPage 清单", (note?._fromPage || []).includes("element"), JSON.stringify(note?._fromPage));

  st.hostPort.onMessage._fire({ id: "fl2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const again = st.sent.find((m) => m.type === "result" && m.id === "fl2");
  check("这条通知只报一次，不会每次调用都跟着", !(again?.data && "focusLostToRecovery" in again.data));
}

const isBlurProbe = (o) => /globalThis\.__aicBlurred\s*=/.test(String(o?.func || ""));
{
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  st.execHangAfterRun = (id, o) => isBlurProbe(o);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);

  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("前提：页面确实被撤了焦点，只是回执没回来", st.blurred >= 1, `blur ${st.blurred || 0} 次`);

  st.hostPort.onMessage._fire({ id: "lb1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const note = st.sent.find((m) => m.type === "result" && m.id === "lb1")?.data?.focusLostToRecovery;
  check("回执超时也照样报得出来（回读页面那侧寄存的那条）", !!note,
    JSON.stringify(Object.keys(st.sent.find((m) => m.id === "lb1")?.data || {})));
  check("回读上来的元素和当场拿到的是同一份", note?.element?.id === "login-password" && note.element.type === "password",
    JSON.stringify(note?.element));
}

{
  const st = freshState();
  st.page.win.__aicBlurred = { tok: 0, el: { tag: "input", id: "陈年旧账" } };
  st.page.doc.body.blur = () => (st.blurred = (st.blurred || 0) + 1);
  st.page.doc.activeElement = st.page.doc.body;
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  st.execHangAfterRun = (id, o) => isBlurProbe(o);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);

  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  st.hostPort.onMessage._fire({ id: "lb2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const d = st.sent.find((m) => m.type === "result" && m.id === "lb2")?.data || {};
  check("流水号对不上的旧寄存不许当成这一次的战果", !("focusLostToRecovery" in d), JSON.stringify(d.focusLostToRecovery));
}

for (const [what, active] of [
  ["焦点本来就在 body 上", null],
  ["压根没有 activeElement", undefined],
]) {
  const st = freshState();
  if (active === null) {
    st.page.doc.body.blur = () => (st.blurred = (st.blurred || 0) + 1);
    st.page.doc.activeElement = st.page.doc.body;
  } else st.page.doc.activeElement = undefined;
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  st.hostPort.onMessage._fire({ id: "fb", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const d = st.sent.find((m) => m.type === "result" && m.id === "fb")?.data || {};
  check(`${what}：不报 focusLostToRecovery`, !("focusLostToRecovery" in d), JSON.stringify(Object.keys(d)));
}

{
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  st.dbgTargets = [
    { id: "t1", type: "page", tabId: 1, url: "https://example.com/login" },
    { id: "t2", type: "iframe", tabId: 1, url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html" },
  ];
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/login", label: "登录" }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  const realReload = st.sandbox.chrome.tabs.reload;
  st.sandbox.chrome.tabs.reload = async (id, opts) => {
    const r = await realReload(id, opts);
    st.attachFail = null;
    return r;
  };
  let boom = null;
  try {
    await T.read_page({}, "s1");
  } catch (e) {
    boom = String(e.message).slice(0, 100);
  }
  check("前提：撤过焦点，而且最后确实靠 reload 才接管上",
    st.blurred >= 1 && st.tabUpdates.some((u) => u.reload) && !boom, boom || `blur ${st.blurred || 0} 次`);

  st.hostPort.onMessage._fire({ id: "both", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const d = st.sent.find((m) => m.type === "result" && m.id === "both")?.data || {};
  check("撤焦点和重新加载同时发生时，两个字段都在",
    !!d.focusLostToRecovery && !!d.pageReloadedToRecover, JSON.stringify(Object.keys(d)));
  check("两条各说各的损失，不是同一句话",
    /没提交的内容/.test(d.pageReloadedToRecover?.why || "") && /没有自动聚焦回去/.test(d.focusLostToRecovery?.why || ""),
    JSON.stringify([d.pageReloadedToRecover?.why?.slice(0, 20), d.focusLostToRecovery?.why?.slice(0, 20)]));
}

const waitResult = async (st, id, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = st.sent.find((x) => x.type === "result" && x.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};

for (const [what, hangProbe] of [
  ["探针当场有回执", false],
  ["探针回执超时、靠回读", true],
]) {
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/login", label: "登录" }, "s1");
  await T.type_text({ text: "hunter2" }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  if (hangProbe) st.execHangAfterRun = (id, o) => isBlurProbe(o);

  st.hostPort.onMessage._fire({ id: "err1", type: "call", tool: "read_page", args: {}, session: "s1" });
  const res = await waitResult(st, "err1");
  check(`${what}：三级全败照旧如实报错`, res?.ok === false && /挂不上调试器/.test(res?.error || ""),
    JSON.stringify(res).slice(0, 160));
  check(`${what}：前提——确实撤了焦点`, st.blurred >= 1, `blur ${st.blurred || 0} 次`);
  check(`${what}：报错文本里点得出被撤的是谁`,
    /login-password/.test(res?.error || "") && /type=password/.test(res?.error || ""),
    String(res?.error || "").slice(-280));
  check(`${what}：并说清没有自动聚焦回去、出路是带 ref`,
    /没有自动聚焦回去/.test(res?.error || "") && /带 ref/.test(res?.error || ""),
    String(res?.error || "").slice(-280));

  st.hostPort.onMessage._fire({ id: "err2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  const res2 = await waitResult(st, "err2");
  check(`${what}：报过一次就不重复唠叨`,
    !(res2?.data && "focusLostToRecovery" in res2.data) && !/没有自动聚焦回去/.test(res2?.error || ""),
    JSON.stringify(res2).slice(0, 200));
}

{
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/login", label: "登录" }, "s1");
  await T.type_text({ text: "hunter2" }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  const r = await throws(() => T.press_key({ key: "Escape" }, "s1"), /挂不上调试器/);
  check("前提：撞墙的那次调用照旧报错，而焦点已经被撤掉", r.threw && r.match && st.blurred >= 1, r.msg);
  const realUpdate = st.sandbox.chrome.tabs.update;
  st.sandbox.chrome.tabs.update = async (id, props) => {
    const x = await realUpdate(id, props);
    if (props?.url) st.attachFail = null;
    return x;
  };
  let nav = null;
  let navErr = null;
  try {
    nav = await T.navigate({ url: "https://example.com/login" }, "s1");
  } catch (e) {
    navErr = String(e.message).slice(0, 120);
  }
  check("救援导航本身照旧走得通", !!nav && nav.clearedForeignExtFrame === true, navErr || JSON.stringify(nav).slice(0, 160));
  nav = nav || {};
  check("救援导航的返回值把那条焦点损失一起报出来",
    nav.focusLostToRecovery?.element?.id === "login-password" && nav.focusLostToRecovery?.tabId === tab.tabId,
    JSON.stringify(nav.focusLostToRecovery));
  check("字段名和常规出口一样，why 也是同一套口径",
    /没有自动聚焦回去/.test(nav.focusLostToRecovery?.why || "") &&
      (nav.focusLostToRecovery?._fromPage || []).includes("element"),
    JSON.stringify(nav.focusLostToRecovery?._fromPage));
  st.hostPort.onMessage._fire({ id: "nv2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const d = st.sent.find((m) => m.type === "result" && m.id === "nv2")?.data || {};
  check("救援导航报过之后，下一次调用不再跟着这条", !("focusLostToRecovery" in d), JSON.stringify(Object.keys(d)));
}

{
  const st = freshState();
  st.page.doc.activeElement = passwordBox(st);
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("前提：确实撤了焦点", st.blurred >= 1, `blur ${st.blurred || 0} 次`);
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "canceled_by_user");
  await tick20();
  st.hostPort.onMessage._fire({ id: "dt1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const note = st.sent.find((m) => m.type === "result" && m.id === "dt1")?.data?.focusLostToRecovery;
  check("调试器掉线不该把「焦点被撤过」这条一起抹掉", !!note,
    JSON.stringify(Object.keys(st.sent.find((m) => m.id === "dt1")?.data || {})));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  st.dbgTargets = [
    { id: "t1", type: "page", tabId: 1, url: "https://example.com/forms" },
    { id: "t2", type: "iframe", tabId: 1, url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html" },
  ];
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/forms", label: "表单" }, "s1");
  await T.type_text({ text: "张三" }, "s1");
  st.tabUpdates.length = 0;
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = () => !!st.attachFail;

  const r = await throws(() => T.read_page({}, "s1"), /挂不上调试器/);
  check("填过东西的页：不重新加载，改为如实报错", r.threw && r.match, r.msg);
  check("确实一次 reload 都没调", !st.tabUpdates.some((u) => u.reload), JSON.stringify(st.tabUpdates));
  check("报错里点明「重新加载会把填的冲掉」", /会全部冲掉/.test(r.msg || ""), r.msg);
  check("并给出调用方自己能走的那条路", /browser_navigate/.test(r.msg || ""), r.msg);

  st.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/forms?2" } });
  const realReload = st.sandbox.chrome.tabs.reload;
  st.sandbox.chrome.tabs.reload = async (id, opts) => { const x = await realReload(id, opts); st.attachFail = null; return x; };
  let page2 = null;
  try { page2 = await T.read_page({}, "s1"); } catch (e) { page2 = { err: String(e.message).slice(0, 80) }; }
  check("导航之后脏标记作废，自救重新可用", !!page2 && !page2.err, JSON.stringify(page2).slice(0, 80));
  check("这一次确实调了 reload", st.tabUpdates.some((u) => u.reload), JSON.stringify(st.tabUpdates));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/forms", label: "表单" }, "s1");
  await T.type_text({ text: "张三" }, "s1");
  st.tabUpdates.length = 0;
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = () => !!st.attachFail;
  const realUpdate = st.sandbox.chrome.tabs.update;
  st.sandbox.chrome.tabs.update = async (id, props) => {
    const r = await realUpdate(id, props);
    if (props?.url) st.attachFail = null;
    return r;
  };

  let nav = null;
  let navErr = null;
  try {
    nav = await T.navigate({ url: "https://example.com/forms" }, "s1");
  } catch (e) {
    navErr = String(e.message).slice(0, 120);
  }
  check("照着报错去 navigate，这次真的走得通（不再是死循环）", !!nav && nav.tabId === tab.tabId, navErr || JSON.stringify(nav).slice(0, 140));
  nav = nav || {};
  check("走的是浏览器进程侧的 tabs.update（调试器这时挂不上，CDP 那条发不出去）",
    st.tabUpdates.some((u) => u.props?.url === "https://example.com/forms"), JSON.stringify(st.tabUpdates));
  check("返回值里明说外来帧是被这次导航清掉的", nav.clearedForeignExtFrame === true, JSON.stringify(nav).slice(0, 200));
  check("并说清页面上原有的内容也一起没了", /重填|一起没了/.test(nav.note || ""), nav.note);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const borrowed = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  st.tabUpdates.length = 0;
  st.chrome.debugger.onDetach._fire({ tabId: borrowed.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = () => !!st.attachFail;

  const r = await throws(() => T.navigate({ url: "https://example.com/other" }, "s1"), /挂不上调试器/);
  check("借来的页：navigate 照旧如实报错，不替用户冲掉页面", r.threw && r.match, r.msg);
  check("确实一次 tabs.update / reload 都没调", !st.tabUpdates.some((u) => u.props?.url || u.reload), JSON.stringify(st.tabUpdates));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  const tab = await T.new_tab({ url: "https://example.com/a", label: "任务" }, "s1");
  await T.type_text({ text: "张三" }, "s1");
  st.tabUpdates.length = 0;
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  st.attachFail = () => FOREIGN_REFUSAL;
  st.execHang = () => !!st.attachFail;

  const r = await throws(() => T.navigate({ action: "back" }, "s1"), /挂不上调试器/);
  check("action:back 不走救援，照旧如实报错", r.threw && r.match, r.msg);
  check("也确实没动页面", !st.tabUpdates.some((u) => u.back || u.props?.url), JSON.stringify(st.tabUpdates));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const body = st.page.doc.body;
  const frame = {
    nodeType: 1, nodeName: "IFRAME", tagName: "IFRAME", id: "", attributes: [], children: [],
    src: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/notification/bar.html",
    getAttribute: (k) => (k === "src" ? frame.src : null),
    parentNode: null, nextSibling: null,
  };
  const holder = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", id: "holder", attributes: [], shadowRoot: null,
    children: [frame], parentNode: body, nextSibling: null,
    getAttribute: (k) => (k === "id" ? "holder" : null),
    querySelectorAll: (sel) => (/iframe/i.test(sel) ? [frame] : []),
    remove() {
      const i = body.children.indexOf(holder);
      if (i >= 0) body.children.splice(i, 1);
      (st.removedOverlays = st.removedOverlays || []).push("DIV#holder");
    },
  };
  frame.parentNode = holder;
  body.children.push(holder);
  st.attachFail = () => (body.children.includes(holder) ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);

  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("外来帧在页面自己的 div 里时照样救得回来", ok.tabId === 1 && st.attached.includes(1), JSON.stringify(st.attached));
  check("摘掉的是装着帧的那个 div", JSON.stringify(st.removedOverlays) === JSON.stringify(["DIV#holder"]), JSON.stringify(st.removedOverlays));
  check(
    "<body> 还在（真机上它就是被摘走的那个，页面当场变空白）",
    st.page.doc.documentElement.children.includes(st.page.doc.body),
    JSON.stringify(st.page.doc.documentElement.children.map((e) => e.nodeName))
  );
  check("<head> 也没被动", st.page.doc.documentElement.children.some((e) => e.nodeName === "HEAD"), JSON.stringify(st.page.doc.documentElement.children.map((e) => e.nodeName)));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const body = st.page.doc.body;
  const mk = (nodeName, id, children) => {
    const o = {
      nodeType: 1, nodeName, tagName: nodeName, id, attributes: [], shadowRoot: null,
      children, parentNode: null, nextSibling: null,
      getAttribute: (k) => (k === "id" ? id : k === "src" ? o.src || null : null),
      querySelectorAll(sel) {
        const out = [];
        const walk = (list) => {
          for (const c of list || []) {
            if (matchesSel(c, sel)) out.push(c);
            walk(c.children);
          }
        };
        walk(o.children);
        return out;
      },
      remove() {
        const p = o.parentNode;
        const i = p ? p.children.indexOf(o) : -1;
        if (i >= 0) p.children.splice(i, 1);
        (st.removedOverlays = st.removedOverlays || []).push(nodeName + "#" + id);
      },
    };
    for (const c of children) c.parentNode = o;
    return o;
  };
  const frame = mk("IFRAME", "ext", []);
  frame.src = "chrome-extension://nngceckbapebfimnlniiiahkandclblb/notification/bar.html";
  const wrapper = mk("DIV", "wrapper", [frame]);
  const content = mk("DIV", "content", []);
  const root = mk("DIV", "root", [content, wrapper]);
  root.parentNode = body;
  body.children.push(root);
  st.attachFail = () => (root.children.includes(wrapper) ? FOREIGN_REFUSAL : null);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);

  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1");
  check("嵌在页面自己容器里的外来帧照样救得回来", ok.tabId === 1 && st.attached.includes(1), JSON.stringify(st.attached));
  check("摘的是包着帧的那层空壳，不是页面的 #root", JSON.stringify(st.removedOverlays) === JSON.stringify(["DIV#wrapper"]), JSON.stringify(st.removedOverlays));
  check("页面自己的 #root 和它的内容一点没动", body.children.includes(root) && root.children.includes(content), JSON.stringify(body.children.map((e) => e.nodeName + "#" + e.id)));
}

{
  const focusEmu = (x) => x.cdp.filter((c) => c.method === "Emulation.setFocusEmulationEnabled");
  const st = freshState();
  st.page = makePage([el("button", { id: "go", text: "GO", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");

  let seenEmu = false;
  let cleared = false;
  st.cdpFail = (m) => {
    if (m === "Emulation.setFocusEmulationEnabled") seenEmu = true;
    else if (seenEmu && !cleared && !String(m).startsWith("Input.")) {
      cleared = true;
      st.sandbox.__perTabTables().focusEmulated.delete(1);
    }
    return null;
  };
  st.cdp.length = 0;
  await T.click({ selector: "#go" }, "s1");
  check("前提：这一轮里账本确实被中途清掉了", cleared, "没触发");
  const ons = focusEmu(st).filter((c) => c.params?.enabled === true);
  check("下发输入前发现焦点模拟没了就自己补回来（不再静默丢事件）", ons.length >= 2, JSON.stringify(focusEmu(st).map((c) => c.params)));
  const lastEmu = st.cdp.map((c) => c.method).lastIndexOf("Emulation.setFocusEmulationEnabled");
  const firstInput = st.cdp.findIndex((c) => String(c.method).startsWith("Input."));
  check("而且补在第一条 Input.* 之前", lastEmu >= 0 && firstInput >= 0 && lastEmu < firstInput, `${lastEmu} vs ${firstInput}`);
  check("三条鼠标事件共用一次补开，不是各补一次", ons.length === 2, JSON.stringify(ons.map((c) => c.params)));

  st.cdpFail = null;
  st.cdp.length = 0;
  await T.click({ selector: "#go" }, "s1");
  check("焦点模拟还在时一次往返都不多花", focusEmu(st).length === 0, JSON.stringify(focusEmu(st)));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "go", text: "GO", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");

  st.focusStuckOnBody = true;
  st.shieldAte = true;
  const r = await throws(() => T.click({ selector: "#go" }, "s1"), /护盾/);
  check("按 selector/ref 点：被自家护盾吃掉时报错，不再含糊成 unknown", r.threw && r.match, r.msg);
  check("说清这一步没做成", /不要当成做过了/.test(r.msg), r.msg);
  check("说清迟到了多久、被拦的是哪个事件", /1370ms/.test(r.msg) && /pointerdown/.test(r.msg), r.msg);
  check("给出下一步（重试 / 切前台 / browser_set）", /重试/.test(r.msg) && /browser_set/.test(r.msg), r.msg);

  const f = await T.find({ query: "GO" }, "s1");
  const r2 = await throws(() => T.click({ ref: f.matches[0].ref }, "s1"), /护盾/);
  check("ref_b 那条路同样报错（旧代码这里靠几何复核报 hit，完全静默）", r2.threw && r2.match, r2.msg);

  st.shieldAte = false;
  const ok = await T.click({ selector: "#go" }, "s1");
  check("护盾没吃时不报错（探针不许变成新的失败源）", !!ok.clicked, JSON.stringify(ok));
  st.focusStuckOnBody = false;
}

{
  const st = freshState();
  st.page = makePage([el("li", { id: "row", text: "第一行", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.focusReadsBody = true;
  const f = await T.find({ query: "第一行" }, "s1");
  const r = await T.press_key({ key: "j", ref: f.matches[0].ref }, "s1").catch((e) => ({ err: String(e.message || e) }));
  check("点中了但目标不可聚焦时照常按键，不再误报「什么都没按」", !r.err, r.err || JSON.stringify(r));
}

{
  const st = freshState();
  st.page = makePage([el("input", { id: "u", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");

  const f = await T.find({ query: "u" }, "s1").catch(() => null);
  const okTyped = await T.type_text({ selector: "#u", text: "abc" }, "s1");
  check("焦点正常落上时照常打字", okTyped.typed === "abc", JSON.stringify(okTyped));
  check("type 收 selector（不再静默忽略）", st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), "一次点击都没有");
  void f;

  st.focusStuckOnBody = true;
  const before = st.cdp.filter((c) => c.method === "Input.insertText").length;
  const r = await throws(() => T.type_text({ selector: "#u", text: "xyz" }, "s1"), /什么都没输入/);
  check("焦点没落上就报错，不再报成功", r.threw && r.match, r.msg);
  check("说清这一步没做成、别当成做过了", /不要当成做过了/.test(r.msg), r.msg);
  check("给出下一步（重试 / 切前台 / 改用 browser_set）", /browser_set/.test(r.msg) && /重试/.test(r.msg), r.msg);
  check(
    "而且一个字符都没往下发（不许先打了再报错）",
    st.cdp.filter((c) => c.method === "Input.insertText").length === before,
    String(st.cdp.filter((c) => c.method === "Input.insertText").length - before)
  );
  st.focusStuckOnBody = false;
}

console.log("\n\x1b[1m命令级断连自愈：恢复从 attach 时刻扩到每一条 CDP 命令\x1b[0m");

const NOT_ATTACHED = "Debugger is not attached to the tab with id: 1";

{
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;

  const step1 = await T.eval_js({ expression: "window.step1" }, "s1");
  let boom = true;
  st.cdpFail = (m, p) => {
    if (m === "Runtime.evaluate" && String(p?.expression || "").includes("window.step2") && boom) {
      boom = false;
      return NOT_ATTACHED;
    }
    return null;
  };
  const step2 = await T.eval_js({ expression: "window.step2" }, "s1");
  const step3 = await T.eval_js({ expression: "window.step3" }, "s1");

  check("第 1 步正常", JSON.stringify(step1.value) === JSON.stringify({ rows: 3 }), JSON.stringify(step1));
  check(
    "第 2 步撞「Debugger is not attached」后自动恢复并重发成功（不再原样抛给模型）",
    JSON.stringify(step2.value) === JSON.stringify({ rows: 3 }),
    JSON.stringify(step2)
  );
  check("第 3 步照常", JSON.stringify(step3.value) === JSON.stringify({ rows: 3 }), JSON.stringify(step3));
  check(
    "恢复过的痕迹看得见：这一轮确实又挂了一次调试器",
    st.attached.filter((a) => a === 1).length === attachesBefore + 1,
    `attach 次数 ${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`
  );
  check("重挂之前先主动断一次，不管 Chrome 说没说自己挂着", st.detached.includes(1), JSON.stringify(st.detached));
  check(
    "重发的是同一条命令（window.step2 发了两次，不是换了一条）",
    st.cdp.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression || "").includes("window.step2")).length === 2,
    JSON.stringify(st.cdp.filter((c) => String(c.params?.expression || "").includes("window.step2")).map((c) => c.method))
  );
}

{
  const st = freshState();
  st.page = makePage([el("input", { id: "u", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;
  let boom = true;
  st.cdpFail = (m) => {
    if (m === "Input.insertText" && boom) {
      boom = false;
      return NOT_ATTACHED;
    }
    return null;
  };
  const r = await throws(() => T.type_text({ text: "abc" }, "s1"), /没有做成/);
  check("输入步骤不吞错：这一步失败就是失败", r.threw && r.match, r.msg);
  check("原话保留（排查时要认得出是哪条 CDP 错误）", /Debugger is not attached/.test(r.msg), r.msg);
  check("明说已经恢复并重新挂上了", /重新挂上/.test(r.msg), r.msg);
  check("明说不自动重放输入，并给出下一步：重发这一步", /不自动重放/.test(r.msg) && /重试这一步/.test(r.msg), r.msg);
  check(
    "绝不自动重放输入（同一段文字只发过一次）",
    st.cdp.filter((c) => c.method === "Input.insertText").length === 1,
    JSON.stringify(st.cdp.filter((c) => c.method === "Input.insertText"))
  );
  check(
    "但恢复确实做了：下一步用得上的连接已经重新挂好",
    st.attached.filter((a) => a === 1).length === attachesBefore + 1,
    `attach 次数 ${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`
  );
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const overlayGone = () => !st.page.doc.body.children.includes(host);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const detachedBefore = st.detached.filter((d) => d === 1).length;
  st.cdpFail = (m, p) =>
    m === "Runtime.evaluate" && String(p?.expression || "").includes("window.b") && !overlayGone() ? FOREIGN_REFUSAL : null;
  st.attachFail = () => (overlayGone() ? null : FOREIGN_REFUSAL);

  const r = await T.eval_js({ expression: "window.b" }, "s1");
  check("外来帧挡住命令时不再原样抛出，而是恢复后重发成功", JSON.stringify(r.value) === JSON.stringify({ rows: 3 }), JSON.stringify(r));
  check(
    "先主动把那条死会话收掉（不收的话下一次 attach 撞 Another debugger is already attached）",
    st.detached.filter((d) => d === 1).length === detachedBefore + 1,
    `detach 次数 ${detachedBefore} → ${st.detached.filter((d) => d === 1).length}`
  );
  check("两级恢复原封不动地复用：第 ① 级撤了页面焦点", (st.blurred || 0) >= 1, `blur ${st.blurred || 0} 次`);
  check("第 ② 级把浮层宿主摘掉了", (st.removedOverlays || []).length === 1, JSON.stringify(st.removedOverlays));
  st.hostPort.onMessage._fire({ id: "cr1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick20();
  const lost = st.sent.find((m) => m.type === "result" && m.id === "cr1")?.data?.focusLostToRecovery;
  check("撤过的焦点如实报出（不许静默做错事）", !!lost && lost.tabId === 1, JSON.stringify(lost));
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const stuck = () => st.page.doc.body.children.includes(host);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;
  st.detachFail = () => stuck();
  st.attachFail = () => (stuck() ? "Another debugger is already attached to the tab with id: 1" : null);
  st.cdpFail = (m, p) =>
    m === "Runtime.evaluate" && String(p?.expression || "").includes("window.c3") && stuck() ? FOREIGN_REFUSAL : null;

  const r = await T.eval_js({ expression: "window.c3" }, "s1");
  check("「断不掉 + 挂不上」时照样救得回来", JSON.stringify(r.value) === JSON.stringify({ rows: 3 }), JSON.stringify(r));
  check("靠的是先摘浮层（走 chrome.scripting，不经过调试器）", (st.removedOverlays || []).length >= 1, JSON.stringify(st.removedOverlays));
  check("摘完之后真的重新挂上了", st.attached.filter((a) => a === 1).length > attachesBefore, `${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`);
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  await tick20();
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const attaching = st.sandbox.__attach(1);
  await tick20();

  let firstJ1 = true;
  st.cdpFail = (m, p) => {
    if (String(p?.expression || "").includes("window.j1") && firstJ1) {
      firstJ1 = false;
      return FOREIGN_REFUSAL;
    }
    return null;
  };
  const j1 = st.sandbox.__cdpSession(1, null, "Runtime.evaluate", { expression: "window.j1", returnByValue: true });
  const got = await j1;
  await attaching;
  check("恢复在途时并发失败的命令：等它跑完再重发，重发成功", JSON.stringify(got?.result?.value) === JSON.stringify({ rows: 3 }), JSON.stringify(got));
  check(
    "那条命令确实发了两次（原发 + 重发）",
    st.cdp.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression || "").includes("window.j1")).length === 2,
    String(st.cdp.filter((c) => String(c.params?.expression || "").includes("window.j1")).length)
  );
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  await tick20();
  let refuse = 2;
  st.attachFail = () => (refuse-- > 0 ? FOREIGN_REFUSAL : null);
  const attaching = st.sandbox.__attach(1);
  await tick20();

  let firstJ2 = true;
  st.cdpFail = (m, p) => {
    if (String(p?.expression || "").includes("window.j2") && firstJ2) {
      firstJ2 = false;
      return NOT_ATTACHED;
    }
    return null;
  };
  const got = await st.sandbox.__cdpSession(1, null, "Runtime.evaluate", { expression: "window.j2", returnByValue: true });
  await attaching;
  check("重挂窗口里撞上「没挂调试器」的命令：等重挂跑完再重发，重发成功", JSON.stringify(got?.result?.value) === JSON.stringify({ rows: 3 }), JSON.stringify(got));
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  foreignFrame(st, "chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html");
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.cdpFail = (m, p) => (m === "Runtime.evaluate" && String(p?.expression || "").includes("window.c") ? FOREIGN_REFUSAL : null);
  st.attachFail = () => FOREIGN_REFUSAL;

  const r = await throws(() => T.eval_js({ expression: "window.c" }, "s1"), /挂不上调试器/);
  check("救不回来时报的是 attachError 那条准确报错", r.threw && r.match, r.msg);
  check("点名是别的扩展的帧（连是谁都说出来）", /别的扩展/.test(r.msg) && /nngceckbapebfimnlniiiahkandclblb/.test(r.msg), r.msg);
  check("并给出用户能做的下一步", /把那个浮层关掉|停用那个扩展/.test(r.msg), r.msg);
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  foreignFrame(st, "chrome-extension://nngceckbapebfimnlniiiahkandclblb/notification/bar.html");
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const replant = () => {
    if (!st.page.doc.body.children.includes(host)) st.page.doc.body.children.push(host);
  };
  st.cdpFail = (m, p) => {
    replant();
    return m === "Runtime.evaluate" && String(p?.expression || "").includes("window.e2") ? FOREIGN_REFUSAL : null;
  };
  st.attachFail = () => (st.page.doc.body.children.includes(host) ? FOREIGN_REFUSAL : null);

  const r = await throws(() => T.eval_js({ expression: "window.e2" }, "s1"), /挂不上调试器/);
  check("浮层立刻回来时报的仍是 attachError 那条准确报错，不是干巴巴的 CDP 原话", r.threw && r.match, r.msg);
  check("说得出是哪个标签页", /标签页 1/.test(r.msg), r.msg);
  check("点名是谁的帧", /nngceckbapebfimnlniiiahkandclblb/.test(r.msg), r.msg);
  check("给出用户能做的下一步", /把那个浮层关掉|停用那个扩展/.test(r.msg), r.msg);
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const gone = () => !st.page.doc.body.children.includes(host);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  await tick20();
  check("前提：账本上这一页已经不连着了", !st.sandbox.__perTabTables().attached.has(1), JSON.stringify([...st.sandbox.__perTabTables().attached]));
  st.cdpFail = (m, p) =>
    m === "Runtime.evaluate" && String(p?.expression || "").includes("window.b3") && !gone() ? FOREIGN_REFUSAL : null;
  st.attachFail = () => (gone() ? null : FOREIGN_REFUSAL);

  const r = { value: (await st.sandbox.__cdpSession(1, null, "Runtime.evaluate", { expression: "window.b3", returnByValue: true }))?.result?.value };
  check("onDetach 抢先清空账本之后，外来帧那一类照样恢复并重发成功", JSON.stringify(r.value) === JSON.stringify({ rows: 3 }), JSON.stringify(r));
  check("恢复确实跑了（浮层被摘掉）", (st.removedOverlays || []).length >= 1, JSON.stringify(st.removedOverlays));
  check("并且重新挂上了调试器", st.attached.filter((a) => a === 1).length > attachesBefore, `${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`);
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;
  st.cdpFail = (m, p) => (m === "Runtime.evaluate" && String(p?.expression || "").includes("window.d") ? NOT_ATTACHED : null);

  const r = await throws(() => T.eval_js({ expression: "window.d" }, "s1"), /Debugger is not attached/);
  check("重发之后仍然失败就如实抛出原话", r.threw && r.match, r.msg);
  check(
    "只恢复一次，不会在死循环里反复重挂",
    st.attached.filter((a) => a === 1).length === attachesBefore + 1,
    `attach 次数 ${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`
  );
  check(
    "那条命令一共只发了两次（原发一次 + 重发一次）",
    st.cdp.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression || "").includes("window.d")).length === 2,
    String(st.cdp.filter((c) => String(c.params?.expression || "").includes("window.d")).length)
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const attachesBefore = st.attached.filter((a) => a === 1).length;
  st.cdpFail = (m, p, t) => (t?.sessionId === "sess-oopif" ? NOT_ATTACHED : null);

  const r = await throws(
    () => st.sandbox.__cdpSession(1, "sess-oopif", "Runtime.evaluate", { expression: "1" }),
    /会话/
  );
  check("OOPIF 会话上的命令同样触发恢复，但报错不含糊", r.threw && r.match, r.msg);
  check("说清会话 id 已经随重挂作废、不能原样重发", /作废|失效/.test(r.msg), r.msg);
  check("给出下一步：重新拿 ref", /browser_read_page|browser_find/.test(r.msg), r.msg);
  check(
    "确实没重发（那条 sessionId 的命令只发过一次）",
    st.cdp.filter((c) => c.sessionId === "sess-oopif").length === 1,
    String(st.cdp.filter((c) => c.sessionId === "sess-oopif").length)
  );
  check(
    "恢复本身照做了：连接已经重新挂上",
    st.attached.filter((a) => a === 1).length === attachesBefore + 1,
    `attach 次数 ${attachesBefore} → ${st.attached.filter((a) => a === 1).length}`
  );
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  st.cdpFail = (m) => (m === "Page.enable" ? NOT_ATTACHED : null);
  const t0 = Date.now();
  const ok = await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const ms = Date.now() - t0;
  check("attach 内部的开域命令失败不拖死 attach（不自我死锁）", ok.tabId === 1 && ms < 2000, `${ms}ms`);
  check(
    "也不会为它多挂一次调试器",
    st.attached.filter((a) => a === 1).length === 1,
    JSON.stringify(st.attached)
  );
}

{
  const st = freshState({ evalValue: { rows: 3 } });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  let boom = true;
  st.cdpFail = (m, p) => {
    if (m === "Runtime.evaluate" && String(p?.expression || "").includes("window.e") && boom) {
      boom = false;
      return NOT_ATTACHED;
    }
    return null;
  };
  await T.eval_js({ expression: "window.e" }, "s1");
  const attachesAfterRecover = st.attached.filter((a) => a === 1).length;
  st.chrome.debugger.onDetach._fire({ tabId: 1 }, "target_closed");
  await new Promise((r) => setTimeout(r, 20));
  const again = await T.eval_js({ expression: "window.f" }, "s1");
  check("迟到的 onDetach 不再清掉刚挂好的那条连接", JSON.stringify(again.value) === JSON.stringify({ rows: 3 }), JSON.stringify(again));
  check(
    "所以也没有多余的一次重挂",
    st.attached.filter((a) => a === 1).length === attachesAfterRecover,
    `attach 次数 ${attachesAfterRecover} → ${st.attached.filter((a) => a === 1).length}`
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  st.sandbox.__setInjectIdle(30);
  st.sandbox.__setInjectImmediate(500);
  const tab = await T.new_tab({ url: "https://example.com/", label: "降级注入" }, "s1");
  st.execHang = (id, o) => id === tab.tabId && !o?.injectImmediately;

  const t0 = Date.now();
  const r = await T.read_page({}, "s1");
  const ms = Date.now() - t0;
  check("有帧挂在加载上：read_page 降级后照样返回", !!r && Array.isArray(r.elements), JSON.stringify(r).slice(0, 80));
  check("确实走了一趟立即注入", st.executed.some((e) => e.allFrames && e.immediate), JSON.stringify(st.executed.slice(-4)));
  check("降级不是静默的：返回值里说清快照可能有帧没渲染完", /没进入就绪状态/.test(r.injectDegraded || ""), r.injectDegraded);
  check("并给出下一步（等加载完重读）", /再读一次/.test(r.injectDegraded || ""), r.injectDegraded);
  check("在桥接超时之前早早收场", ms < 2000, `${ms}ms`);

  const rr = await T.refresh_refs({}, "s1");
  check("refresh_refs 同样带上降级说明", /没进入就绪状态/.test(rr.injectDegraded || ""), rr.injectDegraded);

  const ref = r.elements[0]?.ref;
  const tc0 = Date.now();
  let clicked = null;
  try {
    clicked = await T.click({ ref }, "s1");
  } catch (e) {
    clicked = { err: String(e.message).slice(0, 120) };
  }
  const clickMs = Date.now() - tc0;
  check("降级页上的 click 不许挂死（单帧注入同样两段式）", clickMs < 2000, `${clickMs}ms ${JSON.stringify(clicked).slice(0, 80)}`);

  st.execHang = null;
  st.executed.length = 0;
  const r2 = await T.read_page({}, "s1");
  check("帧就绪后走回主路，不再降级", !("injectDegraded" in r2), r2.injectDegraded);
  check("主路一趟立即注入都不发", !st.executed.some((e) => e.immediate), JSON.stringify(st.executed));
}

{
  const st = freshState();
  const T = loadSw(st);
  st.sandbox.__setInjectIdle(30);
  st.sandbox.__setInjectImmediate(30);
  const tab = await T.new_tab({ url: "https://example.com/", label: "注入路死亡" }, "s1");
  st.execHang = (id) => id === tab.tabId;

  const t0 = Date.now();
  const r = await throws(() => T.read_page({}, "s1"), /注入路卡死/);
  const ms = Date.now() - t0;
  check("两条路都不回时如实报错，不挂死", r.threw && r.match, r.msg);
  check("报错给出能走的路（换标签页 / eval 仍可用）", /browser_new_tab/.test(r.msg) && /browser_eval/.test(r.msg), r.msg);
  check("远在桥接超时之前就报出来", ms < 2000, `${ms}ms`);
}

{
  const st = freshState();
  const T = loadSw(st);
  st.sandbox.__setInjectIdle(30);
  st.sandbox.__setInjectImmediate(500);
  const tab = await T.new_tab({ url: "https://example.com/", label: "中途冻结" }, "s1");
  st.frozen = new Set();
  st.execHang = (id, o) => {
    if (id !== tab.tabId) return false;
    if (!o?.injectImmediately) {
      st.frozen.add(id);
      return true;
    }
    return st.frozen.has(id);
  };
  const r = await T.read_page({}, "s1");
  check("中途冻结：唤醒后降级注入拿到结果，不再报「注入路卡死」", !!r && Array.isArray(r.elements), JSON.stringify(r).slice(0, 80));
  check("确实是降级那趟救回来的", st.executed.some((e) => e.immediate), JSON.stringify(st.executed.slice(-4)));
  check("唤醒之后页不再是冻的", !st.frozen.has(tab.tabId), JSON.stringify([...st.frozen]));
}
{
  const st = freshState();
  const T = loadSw(st);
  st.sandbox.__setInjectIdle(30);
  st.sandbox.__setInjectImmediate(30);
  const tab = await T.new_tab({ url: "https://example.com/", label: "唤不醒" }, "s1");
  st.cdpHang = (m) => m === "Page.setWebLifecycleState";
  st.execHang = (id) => id === tab.tabId;

  const t0 = Date.now();
  const r = await throws(() => T.read_page({}, "s1"), /注入路卡死/);
  const ms = Date.now() - t0;
  check("唤不醒时照样尽快、如实报错", r.threw && r.match, r.msg);
  check("唤醒的等待有上限，不把调用拖死", ms < 4000, `${ms}ms`);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  st.attachFail = () => "Cannot attach to the target with id: 1";
  const T = loadSw(st);

  const r = await throws(() => T.tab_use({ tabId: 1, takeover: true }, "s1"), /attach 失败/);
  check("其它 attach 失败照原样报，并带上标签页和地址", r.threw && r.match && /标签页 1/.test(r.msg) && /github\.com\/foo/.test(r.msg), r.msg);
  check("其它 attach 失败不重试（等 1.6 秒也不会好）", st.attachTries === 1, `试了 ${st.attachTries} 次`);
  check("其它 attach 失败不去动用户页面的焦点", !st.blurred, `blur ${st.blurred || 0} 次`);
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const stuck = () => st.page.doc.body.children.includes(host);
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(8000);
  st.detachFail = () => stuck();
  st.attachFail = () => (stuck() ? "Another debugger is already attached to the tab with id: 1" : null);

  const ok = await T.tab_use({ tabId: 1, takeover: true }, "s1").catch((e) => ({ err: String(e.message || e) }));
  check("attach 撞「Another debugger」时不再把标签页留成永久死的", ok.tabId === 1, JSON.stringify(ok));
  check("靠的是先摘浮层（那条路不经过调试器）", (st.removedOverlays || []).length >= 1, JSON.stringify(st.removedOverlays));
  check("摘完之后真的挂上了", st.attached.includes(1), JSON.stringify(st.attached));
}

{
  const st = freshState();
  st.page.doc.activeElement = focusedInput(st);
  const host = overlayHost(st, "PB-UPLCJFVNSM");
  const T = loadSw(st);
  st.sandbox.__setRecoverExec(20);
  st.sandbox.__setAttachWatchdog(4000);
  st.detachFail = () => true;
  st.attachFail = () => "Another debugger is already attached to the tab with id: 1";
  const r = await throws(() => T.tab_use({ tabId: 1, takeover: true }, "s1"), /attach 失败|挂不上/);
  check("救不回来时如实报错", r.threw && r.match, r.msg);
  check("摘掉的浮层原位放回了（判据可以不完美，但不许留下被我们拆过的页面）",
    st.page.doc.body.children.includes(host), JSON.stringify(st.removedOverlays));
}

{
  const st = freshState();
  const T = loadSw(st);

  const r = await throws(() => T.tab_use({ tabId: 2 }, "s1"), /不要静默征用/);
  check("默认拒绝接管用户的标签页", r.threw && r.match, r.msg);
  check("拒绝时给出 new_tab 的替代方案和该页 URL", /new_tab/.test(r.msg) && /admin\.corp/.test(r.msg), r.msg);
  check("拒绝时说明 takeover 的正当场景", /takeover: true/.test(r.msg), r.msg);
  check("被拒后没有 attach 任何东西", !st.attached.includes(2), JSON.stringify(st.attached));

  const ok = await T.tab_use({ tabId: 2, takeover: true }, "s1");
  check("显式 takeover 能接管", ok.tabId === 2 && ok.via === "显式 takeover");
  check("接管后被收进标签组（用户看得见）", ok.grouped === true && st.grouped.some((g) => g.tabIds === 2));

  await T.tab_release({}, "s1");
  check("借来的页 release 时移出标签组", st.ungrouped.includes(2), JSON.stringify(st.ungrouped));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com", label: "任务" }, "s1");
  const gid = st.grouped[0].groupId;
  st.tabs.find((t) => t.id === 2).groupId = gid;

  const listed = await T.tabs_list({}, "s1");
  check("tabs_list 标出用户拖进来的页", listed.tabs.find((t) => t.tabId === 2)?.inMyGroup === true);

  const ok = await T.tab_use({ takeover: true, tabId: 2 }, "s1");
  check("拖进组的页不需要 takeover 即可接管", ok.tabId === 2 && ok.via === "用户拖入标签组");
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://x.example.com" }, "s1");
  await T.tab_release({}, "s1");
  check("自己开的页不移出标签组", !st.ungrouped.includes(t.tabId), JSON.stringify(st.ungrouped));

  const st2 = freshState();
  const A = loadSw(st2);
  const t2 = await A.new_tab({ url: "https://z.example.com" }, "s1");
  await st2.sandbox.__persist();
  const B = loadSw(st2);
  await st2.sandbox.__restore();
  await B.tab_release({}, "s1");
  check("SW 回收后仍认得自己开的页", !st2.ungrouped.includes(t2.tabId), JSON.stringify(st2.ungrouped));
}

{
  const st = freshState();
  const T = loadSw(st);
  check("没任务时不显示角标", st.action.badge === null || st.action.badge === "", JSON.stringify(st.action));

  await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  check("开一张页：角标 1、图标是干活中", st.action.badge === "1" && /icon-running-16/.test(st.action.icon || ""), JSON.stringify(st.action));
  await T.new_tab({ url: "https://b.example.com" }, "s1");
  check("再开一张：角标变 2", st.action.badge === "2", JSON.stringify(st.action));

  await T.set_task_state({ state: "attention" }, "s1");
  check("标成需要介入：图标和角标颜色都跟着变", /icon-attention-16/.test(st.action.icon || "") && st.action.badgeColor === "#D97706", JSON.stringify(st.action));
  check("鼠标悬停能看懂发生了什么", /需要你介入/.test(st.action.title || ""), st.action.title);

  await T.new_tab({ url: "https://c.example.com" }, "s2");
  await T.set_task_state({ state: "failed" }, "s2");
  check("多会话时取最严重的状态", /icon-failed-16/.test(st.action.icon || ""), JSON.stringify(st.action));
  check("角标是所有会话的标签页总数", st.action.badge === "3", JSON.stringify(st.action));

  await T.status({}, "s3");
  check("空会话不计入角标", st.action.badge === "3", JSON.stringify(st.action));

  await T.close_all({ scope: "all" }, "s1");
  check("收工后角标清空、图标回到闲置", (st.action.badge === "" || st.action.badge === null) && /icon-idle-16/.test(st.action.icon || ""), JSON.stringify(st.action));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://y.example.com", label: "任务乙" }, "s1");
  check("标签组创建时就是折叠的", st.groupUpdates[0].props.collapsed === true, JSON.stringify(st.groupUpdates[0].props));
  check("并且钉到标签条最右", st.groupMoves.length === 1 && st.groupMoves[0].props.index === -1, JSON.stringify(st.groupMoves));

  st.groupUpdates.length = 0;
  st.groupMoves.length = 0;
  await T.new_tab({ url: "https://y2.example.com" }, "s1");
  check(
    "往已有的组里加页时不碰 collapsed，也不再挪位置",
    !st.groupUpdates.some((g) => "collapsed" in g.props) && st.groupMoves.length === 0,
    JSON.stringify({ u: st.groupUpdates, m: st.groupMoves })
  );

  const st2 = freshState();
  st2.groups.push({ id: 999, title: "别人的组" });
  const T2 = loadSw(st2);
  const savedMove = st2.sandbox.chrome.tabGroups.move;
  st2.sandbox.chrome.tabGroups.move = async () => {
    throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
  };
  const r = await T2.new_tab({ url: "https://y3.example.com", label: "挪不动" }, "s2");
  st2.sandbox.chrome.tabGroups.move = savedMove;
  check("挪到最右失败时，标签页照样开出来", r.tabId > 0 && r.grouped === true, JSON.stringify(r));
}

{
  const st = freshState();
  const T = loadSw(st);

  const a1 = await T.new_tab({ url: "https://a1.example.com", label: "任务甲" }, "sA");
  const a2 = await T.new_tab({ url: "https://a2.example.com" }, "sA");
  const b1 = await T.new_tab({ url: "https://b1.example.com", label: "任务乙" }, "sB");
  const gidA = st.grouped[0].groupId;
  st.tabs.find((t) => t.id === 2).groupId = gidA;
  await T.tab_use({ tabId: 2 }, "sA");

  const r = await T.close_all({ scope: "all" }, "sA");

  check("scope=all 关掉了 agent 自己开的全部页", r.closedCount === 3, JSON.stringify(r.closed.map((c) => c.tabId)));
  check("scope=all 跨会话一起清（B 的页也关了）", r.closed.some((c) => c.tabId === b1.tabId));
  check("用户拖进来的没被关", !r.closed.some((c) => c.tabId === 2), JSON.stringify(r.closed));
  check("用户拖进来的被还回去（移出标签组）", r.releasedCount === 1 && st.ungrouped.includes(2));
  check("真的调用了 tabs.remove", [a1, a2, b1].every((t) => st.removed.includes(t.tabId)), JSON.stringify(st.removed));
  check("清理后所有会话的 target 都空了", (await T.status({}, "sA")).target === null && (await T.status({}, "sB")).target === null);

  const again = await T.close_all({}, "sA");
  check("没有可清理的时给出说明而不是报错", again.closedCount === 0 || /没有/.test(again.note || ""), JSON.stringify(again));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "sA");
  const b = await T.new_tab({ url: "https://b.example.com" }, "sB");
  const r = await T.close_all({}, "sA");
  check("默认只关本会话的", r.closedCount === 1 && r.closed[0].tabId === a.tabId, JSON.stringify(r.closed));
  check("另一个会话的页面不受影响", !st.removed.includes(b.tabId));
  check("另一个会话的 target 还在", (await T.status({}, "sB")).target?.tabId === b.tabId);
}

{
  const st = freshState();
  const T = loadSw(st);
  const a1 = await T.new_tab({ url: "https://a1.example.com", label: "抓竞品定价" }, "s1");
  const a2 = await T.new_tab({ url: "https://a2.example.com", label: "抓竞品定价" }, "s1");
  const b1 = await T.new_tab({ url: "https://b1.example.com", label: "查新疆路况" }, "s1");

  const blocked = await T.close_all({}, "s1");
  check("混着两轮对话时，一张都不关", blocked.closedCount === 0 && st.removed.length === 0, JSON.stringify(blocked));
  check("说得出是被什么挡下的", blocked.blocked === "mixed-tasks", JSON.stringify(blocked));
  check(
    "把清单按任务名分好交回去（让调用方点名）",
    blocked.tasks?.length === 2 && blocked.tasks.every((t) => t.tabCount >= 1 && t.tabIds.length === t.tabCount),
    JSON.stringify(blocked.tasks)
  );

  const mine = await T.close_all({ label: "抓竞品定价" }, "s1");
  check("点名后只关自己那个任务的页", mine.closedCount === 2, JSON.stringify(mine.closed));
  check("关的正是自己那两张", [a1, a2].every((t) => st.removed.includes(t.tabId)), JSON.stringify(st.removed));
  check("别轮对话的页一张没动", !st.removed.includes(b1.tabId), JSON.stringify(st.removed));
  check("返回里说清楚还剩几张没动", mine.keptOtherTasks === 1, JSON.stringify(mine));
  check(
    "没关的那些按任务名列出 tabId（不能只给个数字）",
    mine.kept?.length === 1 && mine.kept[0].label === "查新疆路况" && mine.kept[0].tabIds?.includes(b1.tabId),
    JSON.stringify(mine.kept)
  );
  check("并且说清楚「中途改过名」是怎么造成这局面的", /tab_group|改过任务名/.test(mine.note || ""), mine.note);
  const left = await T.status({}, "s1");
  check("剩下那张还在会话清单里（没被抹成孤儿）", left.tabs?.length === 1 && left.tabs[0].tabId === b1.tabId, JSON.stringify(left.tabs));

  const c1 = await T.new_tab({ url: "https://c1.example.com", label: "第三个任务" }, "s1");
  const wrong = await T.close_all({ label: "根本没有这个任务" }, "s1");
  check("label 带错时一张都不关", wrong.closedCount === 0 && !st.removed.includes(c1.tabId), JSON.stringify(wrong));
  check("并且说清楚这个名字在清单里没有对应的页", /没有对应的页/.test(wrong.note || ""), wrong.note);
}

{
  const st = freshState();
  let T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com", label: "任务乙" }, "s1");
  check("页账本上记下了开它时的任务名", st.localStorage["aic-our-" + a.tabId]?.l === "任务甲", JSON.stringify(st.localStorage["aic-our-" + a.tabId]));

  T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const results = new Map();
  st.hostPort.postMessage._calls = st.hostPort.postMessage._calls || [];
  const fire = async (id, tool, args) => {
    st.hostPort.onMessage._fire({ id, type: "call", tool, args, session: "s1" });
    await tick();
    await tick();
    return results.get(id);
  };
  const origPost = st.hostPort.postMessage;
  st.hostPort.postMessage = (m) => {
    if (m?.type === "result") results.set(m.id, m.data ?? m);
    return origPost(m);
  };

  const r = await fire("x1", "close_all", {});
  check("重载后仍认得出混着两个任务，一张都不关", r?.closedCount === 0 && r?.blocked === "mixed-tasks", JSON.stringify(r));
  const mine = await fire("x2", "close_all", { label: "任务甲" });
  check("重载后点名照样只清自己那份", mine?.closedCount === 1 && st.removed.includes(a.tabId), JSON.stringify(mine));
  check("别人的那张还开着", !st.removed.includes(b.tabId), JSON.stringify(st.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  const b = await T.new_tab({ url: "https://b.example.com", label: "任务乙" }, "s1");
  const r = await T.close_all({ scope: "session" }, "s1");
  check("显式 scope:session 时不再问，整份清单一起清", r.closedCount === 2, JSON.stringify(r.closed));
  check("两张都真的关了", [a, b].every((t) => st.removed.includes(t.tabId)), JSON.stringify(st.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1");
  await T.new_tab({ url: "https://b.example.com", label: "任务乙" }, "s1");
  const a2 = await T.new_tab({ url: "https://a2.example.com", label: "任务甲" }, "s1");
  const r = await T.close_all({ label: "任务甲" }, "s1");
  check(
    "开页时的任务名钉在页上，不受后来者改写 s.label 影响",
    r.closedCount === 2 && [a, a2].every((t) => st.removed.includes(t.tabId)),
    JSON.stringify(r.closed)
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 30));

  const main = await T.new_tab({ url: "https://m.example.com", label: "主任务" }, "sMain");
  const sub = await T.new_tab({ url: "https://sub.example.com" }, "sMain::sess_subagent_1");
  const other = await T.new_tab({ url: "https://other.example.com" }, "sOther");
  const tabsBefore = st.tabs.length;

  st.hostPort.onMessage._fire({ type: "session-end", session: "sMain" });
  await tick();

  const S = st.sandbox.__sessions;
  check("session-end 后主会话被标休眠", !!S.get("sMain").dormantAt);
  check("subagent 派生会话（sid 前缀匹配）一并休眠", !!S.get("sMain::sess_subagent_1").dormantAt);
  check("别的 SESSION_ID 的会话不受影响", !S.get("sOther").dormantAt);
  check(
    "组褪成灰（休眠色）",
    st.groupUpdates.some((u) => u.props?.color === "grey"),
    JSON.stringify(st.groupUpdates.slice(-3))
  );
  check(
    "【变异守卫】休眠只改组的样子，标签页一张都没动",
    st.tabs.length === tabsBefore && st.removed.length === 0,
    `tabs=${st.tabs.length} removed=${JSON.stringify(st.removed)}`
  );
  check("排了一次性回收 alarm", (st.alarms || []).some((a) => a.name === "aic-dormant-sweep"), JSON.stringify(st.alarms));

  st.hostPort.onMessage._fire({ id: "w1", type: "call", tool: "status", args: {}, session: "sMain" });
  await tick();
  check("休眠会话再有调用进来即唤醒", !S.get("sMain").dormantAt);
  check(
    "唤醒后组色从灰还原成会话色",
    st.groupUpdates.slice(-2).some((u) => u.props?.color && u.props.color !== "grey"),
    JSON.stringify(st.groupUpdates.slice(-2))
  );
  check("没被调用的 subagent 会话仍在休眠（各回收各的）", !!S.get("sMain::sess_subagent_1").dormantAt);

  st.chrome.alarms.onAlarm._fire({ name: "aic-dormant-sweep" });
  await tick();
  check("宽限期没到时 alarm 触发不关任何页", st.removed.length === 0, JSON.stringify(st.removed));

  S.get("sMain::sess_subagent_1").dormantAt = Date.now() - 16 * 60 * 1000;
  st.chrome.alarms.onAlarm._fire({ name: "aic-dormant-sweep" });
  await tick();
  check("宽限期过后自己开的页被关", st.removed.includes(sub.tabId), JSON.stringify(st.removed));
  check("到期的会话从账本上删掉", !S.has("sMain::sess_subagent_1"));
  check("唤醒过的主会话没被回收", S.has("sMain") && !st.removed.includes(main.tabId));
  check("别的会话没被回收", !st.removed.includes(other.tabId));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 30));

  const a = await T.new_tab({ url: "https://a.example.com", label: "任务" }, "sA");
  const gid = st.grouped[0].groupId;
  st.tabs.find((t) => t.id === 2).groupId = gid;
  await T.tab_use({ tabId: 2 }, "sA");
  const watched = await T.new_tab({ url: "https://w.example.com" }, "sA");

  st.hostPort.onMessage._fire({ type: "session-end", session: "sA" });
  await tick();
  const S = st.sandbox.__sessions;
  S.get("sA").dormantAt = Date.now() - 16 * 60 * 1000;
  st.tabs.find((t) => t.id === watched.tabId).lastAccessed = Date.now();
  st.chrome.alarms.onAlarm._fire({ name: "aic-dormant-sweep" });
  await tick();

  check("自己开的页被关", st.removed.includes(a.tabId), JSON.stringify(st.removed));
  check(
    "借来的页没被关，只是移出标签组还给用户",
    !st.removed.includes(2) && st.ungrouped.includes(2),
    JSON.stringify({ removed: st.removed, ungrouped: st.ungrouped })
  );
  check("用户看过的页（lastAccessed 晚于 dormantAt）没被关", !st.removed.includes(watched.tabId), JSON.stringify(st.removed));
  check("用户看过的页被移出标签组交还", st.ungrouped.includes(watched.tabId), JSON.stringify(st.ungrouped));
  check("会话账本清掉", !S.has("sA"));
}

{
  const st = freshState();
  loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  const period = () =>
    (st.alarms || [])
      .filter((a) => a.name === "aic-keepalive")
      .map((a) => a.info?.periodInMinutes)
      .pop();
  check("启动按 30s 拨号", period() === 0.5, JSON.stringify(st.alarms));

  st.hostPort.onDisconnect._fire();
  await tick();
  check("一次空拨后退避到 60s", period() === 1, String(period()));
  st.chrome.alarms.onAlarm._fire({ name: "aic-keepalive" });
  st.hostPort.onDisconnect._fire();
  await tick();
  check("两次空拨后退避到 120s", period() === 2, String(period()));
  st.chrome.alarms.onAlarm._fire({ name: "aic-keepalive" });
  st.hostPort.onDisconnect._fire();
  await tick();
  check("120s 封顶不再加（首装用户等太久会以为坏了）", period() === 2, String(period()));
  check("退避档位存进 storage.session（SW 回收后还在）", st.storage["aic-dial-tier"] === 2, JSON.stringify(st.storage["aic-dial-tier"]));

  st.chrome.alarms.onAlarm._fire({ name: "aic-keepalive" });
  st.hostPort.onMessage._fire({ id: "c1", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick();
  check("call 进来退避立刻复位到 30s", period() === 0.5, String(period()));
  check("复位也落盘", st.storage["aic-dial-tier"] === 0, JSON.stringify(st.storage["aic-dial-tier"]));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const tab = await T.new_tab({ url: "https://x.example.com" }, "s1");
  check("前置：调试器已挂上", st.attached.includes(tab.tabId));

  st.hostPort.onDisconnect._fire();
  await tick();
  check("host 断开不再立即 detach", st.detached.length === 0, JSON.stringify(st.detached));
  check("排了延迟 detach 的 alarm", (st.alarms || []).some((a) => a.name === "aic-late-detach"));

  st.hostPort.onMessage._fire({ id: "c2", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await tick();
  check("call 进来时清掉了延迟 detach", (st.alarmClears || []).includes("aic-late-detach"), JSON.stringify(st.alarmClears));
  st.chrome.alarms.onAlarm._fire({ name: "aic-late-detach" });
  await tick();
  check("有 call 之后即使 alarm 打进来也不 detach", st.detached.length === 0, JSON.stringify(st.detached));
}
{
  const st = freshState();
  const T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const tab = await T.new_tab({ url: "https://x.example.com" }, "s1");
  st.hostPort.onDisconnect._fire();
  await tick();
  st.chrome.alarms.onAlarm._fire({ name: "aic-late-detach" });
  await tick();
  check("宽限期内没有任何 call → 到点 detach，黄条还给用户", st.detached.includes(tab.tabId), JSON.stringify(st.detached));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://app.example.com" }, "s1");
  st.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.requestWillBeSent", {
    requestId: "rb-1",
    type: "XHR",
    timestamp: 1,
    request: { method: "GET", url: "https://api.example.com/a", headers: {} },
  });
  await st.sandbox.__detachAll();
  await new Promise((r) => setTimeout(r, 20));
  const r = await T.network_log({}, "s1");
  check("detach 之后网络记录还在", r.totalCaptured >= 1, JSON.stringify(r));
  check(
    "返回里如实报出缓冲断点",
    Array.isArray(r.bufferBreaks) && r.bufferBreaks.length === 1 && /断开/.test(r.breakNote || ""),
    JSON.stringify({ b: r.bufferBreaks, n: r.breakNote })
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://ring.example.com" }, "s1");
  st.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.requestWillBeSent", {
    requestId: "keep-1",
    type: "XHR",
    timestamp: 1,
    request: { method: "POST", url: "https://ring.example.com/form-submit", headers: {} },
  });
  st.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.responseReceived", {
    requestId: "keep-1",
    timestamp: 2,
    type: "XHR",
    response: { status: 200, url: "https://ring.example.com/form-submit", headers: {}, mimeType: "application/json" },
  });
  await new Promise((r) => setTimeout(r, 20));
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "canceled_by_user");
  await new Promise((r) => setTimeout(r, 20));
  const r = await T.network_log({ includeSeen: true }, "s1");
  check("onDetach 之后网络记录仍在（不是空表冒充「没有请求」）", r.totalCaptured >= 1, JSON.stringify(r));
  check("而且如实报出缓冲断过", Array.isArray(r.bufferBreaks) && r.bufferBreaks.length >= 1, JSON.stringify(r.bufferBreaks));
  const w = await T.network_wait({ urlContains: "/form-submit", method: "POST", type: "all", timeoutMs: 200 }, "s1");
  check("network_wait 回看窗口照样命中那条 POST", w.matched === true && w.requestId === "keep-1", JSON.stringify(w));

  st.chrome.tabs.onRemoved._fire(tab.tabId, { windowId: 10, isWindowClosing: false });
  await new Promise((r) => setTimeout(r, 20));
  const tbl = st.sandbox.__perTabTables();
  check(
    "标签页关掉之后缓冲才真的清掉（按标签页的表不许只增不减）",
    !tbl.networkRing.has(tab.tabId) && !tbl.ringBreaks.has(tab.tabId) && !tbl.netMark.has(tab.tabId) && !tbl.consoleRing.has(tab.tabId) && !tbl.wsRing.has(tab.tabId),
    JSON.stringify({ net: tbl.networkRing.has(tab.tabId), br: tbl.ringBreaks.has(tab.tabId), mark: tbl.netMark.has(tab.tabId), con: tbl.consoleRing.has(tab.tabId), ws: tbl.wsRing.has(tab.tabId) })
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const origSend = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (method === "Network.enable") {
      st.cdp.push({ tabId: src.tabId, method, params });
      st.chrome.runtime.lastError = { message: "Network domain is not available" };
      cb(undefined);
      st.chrome.runtime.lastError = undefined;
      return;
    }
    return origSend(src, method, params, cb);
  };
  const tab = await T.new_tab({ url: "https://noenable.example.com" }, "s1");
  const r = await T.network_log({}, "s1");
  check("Network 域没开成时顶格说出来", r.networkCaptureOff === true, JSON.stringify({ off: r.networkCaptureOff, total: r.totalCaptured }));
  check("而且说清了原因和下一步", /没开成/.test(r.captureOffNote || "") && /关掉重开/.test(r.captureOffNote || ""), JSON.stringify(r.captureOffNote));
  const w = await throws(() => T.network_wait({ urlContains: "/x", method: "GET", timeoutMs: 200 }, "s1"), /没在录网络/);
  check("network_wait 超时的解释也换成「压根没在录」", w.threw && w.match, w.msg);

  st.chrome.debugger.sendCommand = origSend;
  const st2 = freshState();
  const T2 = loadSw(st2);
  await T2.new_tab({ url: "https://ok.example.com" }, "s1");
  const r2 = await T2.network_log({}, "s1");
  check("正常情况下不带这两个字段", r2.networkCaptureOff === undefined && r2.captureOffNote === undefined, JSON.stringify(Object.keys(r2)));
  void tab;
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://body.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  ev._fire({ tabId: tab.tabId }, "Network.requestWillBeSent", {
    requestId: "nb-1",
    type: "XHR",
    timestamp: 1,
    request: { method: "POST", url: "https://body.example.com/api", headers: {} },
  });
  ev._fire({ tabId: tab.tabId }, "Network.responseReceived", {
    requestId: "nb-1",
    timestamp: 2,
    type: "XHR",
    response: { status: 200, url: "https://body.example.com/api", headers: {}, mimeType: "application/json" },
  });
  await new Promise((r) => setTimeout(r, 20));
  st.chrome.debugger.onDetach._fire({ tabId: tab.tabId }, "target_closed");
  await new Promise((r) => setTimeout(r, 20));
  const origSend = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (method === "Network.getResponseBody") {
      st.cdp.push({ tabId: src.tabId, method, params });
      st.chrome.runtime.lastError = { message: "No data found for resource with given identifier" };
      cb(undefined);
      st.chrome.runtime.lastError = undefined;
      return;
    }
    return origSend(src, method, params, cb);
  };
  const d = await T.request_detail({ requestId: "nb-1" }, "s1");
  st.chrome.debugger.sendCommand = origSend;
  check("取不回来时如实给出 CDP 的原话", /No data found/.test(d.responseBodyError || ""), JSON.stringify(d.responseBodyError));
  check("并点名「调试器断过」这个成因（否则只会被当成问早了）", /断开过/.test(d.responseBodyNote || ""), JSON.stringify(d.responseBodyNote));
  check("而且说清重试没用、要重做那个操作", /重试读不出来/.test(d.responseBodyNote || "") && /重做/.test(d.responseBodyNote || ""), JSON.stringify(d.responseBodyNote));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const tab = await T.new_tab({ url: "https://x.example.com" }, "sD");
  const ev = st.chrome.debugger.onEvent;
  const handled = () => st.cdp.filter((c) => c.method === "Page.handleJavaScriptDialog");

  ev._fire({ tabId: tab.tabId }, "Page.javascriptDialogOpening", { type: "confirm", message: "确定删除吗" });
  await tick();
  check("confirm 被当场自动处理（页面不卡死）", handled().length === 1);
  check("默认取消（保守侧：宁可没删成，不可替用户确认删除）", handled()[0].params.accept === false, JSON.stringify(handled()[0].params));
  ev._fire({ tabId: tab.tabId }, "Page.javascriptDialogClosed", { result: false });
  await tick();

  st.hostPort.onMessage._fire({ id: "d1", type: "call", tool: "tabs_list", args: {}, session: "sD" });
  await tick();
  const res = st.sent.find((m) => m.type === "result" && m.id === "d1");
  const d = res?.data?.dialogAutoDismissed;
  check("下一个工具返回值里报出 dialogAutoDismissed", !!d, JSON.stringify(res).slice(0, 240));
  check(
    "带类型、消息、处理方式与浏览器回执的最终结果",
    d?.type === "confirm" && /删除/.test(d?.message || "") && d?.accept === false && d?.result === false,
    JSON.stringify(d)
  );
  check("弹窗文案标明来自页面", Array.isArray(d?._fromPage) && d._fromPage.includes("message"), JSON.stringify(d));
  st.hostPort.onMessage._fire({ id: "d2", type: "call", tool: "tabs_list", args: {}, session: "sD" });
  await tick();
  const res2 = st.sent.find((m) => m.type === "result" && m.id === "d2");
  check("报过一次即清空，不重复唠叨", !(res2?.data && "dialogAutoDismissed" in res2.data), JSON.stringify(Object.keys(res2?.data || {})));

  const armed = await T.handle_dialog({ accept: true, promptText: "小明" }, "sD");
  check("handle_dialog 登记策略而不是发 CDP（弹窗活不到事后）", armed.armed === true && handled().length === 1, JSON.stringify(armed));
  ev._fire({ tabId: tab.tabId }, "Page.javascriptDialogOpening", { type: "prompt", message: "取个名字" });
  await tick();
  check("策略生效：accept 并带 promptText", handled()[1].params.accept === true && handled()[1].params.promptText === "小明", JSON.stringify(handled()[1].params));
  ev._fire({ tabId: tab.tabId }, "Page.javascriptDialogOpening", { type: "confirm", message: "再来一个" });
  await tick();
  check("策略一次性：第二个弹窗回到默认取消", handled()[2].params.accept === false, JSON.stringify(handled()[2].params));

  ev._fire({ tabId: tab.tabId }, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
  await tick();
  check("beforeunload 默认接受（否则导航类操作全卡死）", handled()[3].params.accept === true);
  st.hostPort.onMessage._fire({ id: "d3", type: "call", tool: "tabs_list", args: {}, session: "sD" });
  await tick();
  const res3 = st.sent.find((m) => m.type === "result" && m.id === "d3");
  const list3 = res3?.data?.dialogAutoDismissed;
  check(
    "beforeunload 的接受同样被如实报出（接管用户页时它会吃掉填一半的表单）",
    Array.isArray(list3) ? list3.some((x) => x.type === "beforeunload") : list3?.type === "beforeunload" || (Array.isArray(list3) && false),
    JSON.stringify(list3)
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://example.com" }, "sE");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };
  const feed = (id, url, type, bytes) => {
    ev._fire(src, "Network.requestWillBeSent", { requestId: id, type, timestamp: 1, request: { method: "GET", url, headers: {} } });
    ev._fire(src, "Network.responseReceived", { requestId: id, type, response: { status: 200, headers: {} } });
    ev._fire(src, "Network.loadingFinished", { requestId: id, timestamp: 2, encodedDataLength: bytes });
  };
  feed("doc", "https://example.com/", "Document", 137);
  feed("ext1", "chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh/content_main.js", "Script", 3575080);
  feed("ext2", "chrome-extension://pljclpadpglpbkmglcnbfbbhchpalafl/content/bridge.js", "Script", 644);
  await new Promise((r) => setTimeout(r, 30));

  const noExt = await T.network_log({}, "sE");
  check(
    "默认列表里没有 chrome-extension:// 的条目",
    noExt.requests.length === 1 && noExt.requests[0].requestId === "doc",
    JSON.stringify(noExt.requests.map((r) => r.url))
  );
  check("滤掉的条数如实报出来", noExt.hiddenExtensionRequests === 2, JSON.stringify(noExt.hiddenExtensionRequests));
  check("并给出怎么把它们要回来", /includeExtensions/.test(noExt.extensionHint || ""), noExt.extensionHint);

  const withExt = await T.network_log({ includeExtensions: true }, "sE");
  check("includeExtensions:true 是逃生舱，扩展流量照样查得到", withExt.requests.length === 3, JSON.stringify(withExt.requests.map((r) => r.requestId)));
  check("逃生舱那次不再报「滤掉了几条」", withExt.hiddenExtensionRequests === undefined, JSON.stringify(withExt.hiddenExtensionRequests));
  check("只是不列，记录本身没被删（totalCaptured 照算）", noExt.totalCaptured === 3, String(noExt.totalCaptured));
  const detail = await T.request_detail({ requestId: "ext1" }, "sE").catch((e) => ({ error: String(e.message) }));
  check("扩展请求仍可按 requestId 下钻（过滤只在列表层）", !detail.error && detail.requestId === "ext1", JSON.stringify(detail).slice(0, 140));
  const filtered = await T.network_log({ filter: "chrome-extension://" }, "sE");
  check("显式 filter 到扩展地址、但没开 includeExtensions 时仍然不列（默认就是默认）", filtered.requests.length === 0, JSON.stringify(filtered.requests));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://ok.example.com" }, "sN");

  st.navigateFails = (url) => (/dead\.example/.test(url) ? "net::ERR_NAME_NOT_RESOLVED" : null);
  const bad = await throws(() => T.navigate({ url: "https://dead.example.com/" }, "sN"), /导航失败/);
  check("DNS 解析失败直接报错，不再把错误页当成功", bad.threw && bad.match, bad.msg);
  check("报错里带原始 errorText", /ERR_NAME_NOT_RESOLVED/.test(bad.msg), bad.msg);

  st.navigateFails = () => "net::ERR_ABORTED";
  const dl = await throws(() => T.navigate({ url: "https://file.example.com/big.zip" }, "sN"), /导航失败/);
  check("ERR_ABORTED 提示「可能是下载/被取消」的岔路", /下载/.test(dl.msg), dl.msg);
  st.navigateFails = null;

  {
    const st2 = freshState();
    const T2 = loadSw(st2);
    const before = st2.tabs.length;
    st2.navigateFails = () => "net::ERR_CONNECTION_REFUSED";
    const nt = await throws(() => T2.new_tab({ url: "http://127.0.0.1:8899/index.html", label: "某任务" }, "sX"), /ERR_CONNECTION_REFUSED/);
    const born = st2.tabs.filter((t) => !t.url || t.url === "about:blank" || /8899/.test(t.url));
    check("导航失败时标签页确实还在（不是悄悄关掉）", st2.tabs.length > before, `${before} → ${st2.tabs.length}`);
    check(
      "报错点名了刚建出来的那个 tabId",
      born.some((t) => nt.msg.includes(String(t.id))),
      `${nt.msg} | 新建=${JSON.stringify(born.map((t) => t.id))}`
    );
    check("报错给出收拾它的三条具体路子", /browser_navigate/.test(nt.msg) && /browser_close_tab/.test(nt.msg) && /close_all/.test(nt.msg), nt.msg);
    check("并把任务名一起带上（close_all 要用）", /某任务/.test(nt.msg), nt.msg);
    st2.navigateFails = null;
  }

  {
    const st3 = freshState();
    const T3 = loadSw(st3);
    await T3.new_tab({ url: "https://a.example.com", label: "任务" }, "sG");
    const solo = await T3.new_tab({ url: "https://b.example.com", group: false }, "sG");
    check(
      "group:false 时不给 groupId（以前照回会话的组 id，读的人只会认后者）",
      solo.grouped === false && solo.groupId === undefined,
      JSON.stringify({ grouped: solo.grouped, groupId: solo.groupId })
    );
    const inGroup = await T3.new_tab({ url: "https://c.example.com" }, "sG");
    check("对照：默认分组时照常给 groupId", inGroup.grouped === true && typeof inGroup.groupId === "number", JSON.stringify(inGroup.groupId));
  }

  const ev = st.chrome.debugger.onEvent;
  ev._fire({ tabId: tab.tabId }, "Network.requestWillBeSent", {
    requestId: "doc-1",
    type: "Document",
    timestamp: 1,
    request: { method: "GET", url: "https://ok.example.com/404page", headers: {} },
  });
  ev._fire({ tabId: tab.tabId }, "Network.responseReceived", {
    requestId: "doc-1",
    type: "Document",
    timestamp: 2,
    response: { status: 404, headers: {}, mimeType: "text/html" },
  });
  const r = await T.navigate({ url: "https://ok.example.com/404page" }, "sN");
  check("导航成功时报主文档的 HTTP 状态码", r.docStatus === 404, JSON.stringify(r));

  await T.navigate({ action: "reload", bypassCache: true }, "sN");
  check("reload 带 bypassCache 硬刷新", st.tabUpdates.some((u) => u.reload && u.bypassCache === true), JSON.stringify(st.tabUpdates.filter((u) => u.reload)));
  await T.navigate({ action: "reload" }, "sN");
  check("默认 reload 不绕缓存", st.tabUpdates.some((u) => u.reload && u.bypassCache === false), JSON.stringify(st.tabUpdates.filter((u) => u.reload)));
}

{
  const src = fs.readFileSync(path.join(ROOT, "extension", "update-check.js"), "utf8");
  const win = {};
  const sandbox = { window: win, chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, management: { getSelf: async () => ({ installType: "normal" }) } }, fetch: async () => ({ ok: false }), setTimeout, clearTimeout, Date, JSON, Promise, AbortController: class { abort() {} get signal() { return null; } } };
  sandbox.globalThis = sandbox;
  vm.runInContext(src, vm.createContext(sandbox), { filename: "update-check.js" });
  const u = win.aicUpdateCheck;
  check("商店渠道：落后 1 个 minor 不提示（正常审核时差）", u.storeShouldNotify("0.40.0", "0.39.5") === false);
  check("商店渠道：落后 2 个 minor 才提示（更新多半卡住了）", u.storeShouldNotify("0.41.0", "0.39.0") === true);
  check("商店渠道：major 落后无论如何提示", u.storeShouldNotify("1.0.0", "0.39.0") === true);
  check("开发渠道的 isNewer 口径不变（任何更新都提示）", u.isNewer("0.39.1", "0.39.0") === true);
}

{
  const st = freshState();
  loadSw(st);
  st.groups.push({ id: 900, title: "💤 旧任务", color: "blue" });
  st.tabs.push({ id: 77, windowId: 10, title: "x", url: "https://x.example.com", groupId: 900, status: "complete" });
  await new Promise((r) => st.chrome.runtime.onMessage._fire({ type: "popup-status" }, null, r));
  check("💤 组被认成孤儿组并当场解散", !st.groups.some((g) => g.id === 900) && st.tabs.find((t) => t.id === 77)?.groupId === -1, JSON.stringify(st.groups));
}

{
  const st = freshState();
  const T = loadSw(st);
  const OLD = "s12345-abc";
  const NEW = "s12345-abc::sess_subagent_agent_a1100314";
  const old1 = await T.new_tab({ url: "https://old1.example.com", label: "升级前的任务" }, OLD);

  const sNew = await T.status({}, NEW);
  check("新 sid 看不到旧 sid 的标签页", sNew.tabs.length === 0 && sNew.target === null, JSON.stringify(sNew.tabs));
  check(
    "旧 sid 的标签页在 otherSessions 里还看得见（不是凭空消失）",
    sNew.otherSessions.some((o) => o.session === OLD && o.tabIds.includes(old1.tabId)),
    JSON.stringify(sNew.otherSessions)
  );

  const grab = await throws(() => T.tab_use({ takeover: true, tabId: old1.tabId }, NEW), /正被另一个 agent 会话使用/);
  check("新 sid 不能直接抢旧 sid 的标签页（与改动前的跨会话规则一致）", grab.threw && grab.match, grab.msg);

  const r = await T.close_all({ scope: "all" }, NEW);
  check("close_all scope=all 把旧 sid 的标签页收了回来", r.closed.some((c) => c.tabId === old1.tabId), JSON.stringify(r.closed));
  check("旧标签页真的被关掉了", st.removed.includes(old1.tabId), JSON.stringify(st.removed));
  check("清理后旧 sid 名下也空了", (await T.status({}, OLD)).tabs.length === 0);
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://app.example.com", label: "抓接口" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  st.bodies["req-1"] = JSON.stringify({ ok: true, user: { id: 42, name: "小明" } });
  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-1",
    type: "XHR",
    timestamp: 100.0,
    initiator: { type: "script" },
    request: {
      method: "POST",
      url: "https://api.example.com/v1/user/profile?lang=zh",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.verylongtokenvalue",
        "x-trace-id": "t-123",
      },
      postData: JSON.stringify({ fields: ["name", "avatar"] }),
      hasPostData: true,
    },
  });
  ev._fire(src, "Network.responseReceived", {
    requestId: "req-1",
    type: "XHR",
    response: {
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      remoteIPAddress: "1.2.3.4",
      headers: { "content-type": "application/json" },
    },
  });
  ev._fire(src, "Network.requestWillBeSentExtraInfo", {
    requestId: "req-1",
    headers: {
      ":method": "POST",
      ":authority": "api.example.com",
      ":path": "/v1/user/profile?lang=zh",
      ":scheme": "https",
      "content-type": "application/json",
      cookie: "session=abcdefghijklmnop; theme=dark",
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.verylongtokenvalue",
      "x-trace-id": "t-123",
      "sec-fetch-site": "cross-site",
      "accept-encoding": "gzip, deflate, br",
    },
  });
  ev._fire(src, "Network.responseReceivedExtraInfo", {
    requestId: "req-1",
    headers: {
      "content-type": "application/json",
      "set-cookie": "sid=zzzz; HttpOnly",
      "x-ratelimit-remaining": "0",
    },
    blockedCookies: [{ cookie: { name: "tracker" }, blockedReasons: ["SameSiteLax"] }],
  });
  ev._fire(src, "Network.loadingFinished", { requestId: "req-1", timestamp: 100.35, encodedDataLength: 812 });
  await tick();

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-img",
    type: "Image",
    timestamp: 101,
    request: { method: "GET", url: "https://cdn.example.com/logo.png", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-img", type: "Image", response: { status: 200, headers: {} } });
  ev._fire(src, "Network.loadingFinished", { requestId: "req-img", timestamp: 101.1, encodedDataLength: 5000 });
  await tick();

  const all = await T.network_log({}, "s1");
  check("网络列表拿到两条", all.requests.length === 2, JSON.stringify(all.requests.map((r) => r.requestId)));
  check("列表带 requestId 供下钻", all.requests.every((r) => !!r.requestId));
  check("列表给出耗时和大小", all.requests[0].durMs === 350 && all.requests[0].size === 812, JSON.stringify(all.requests[0]));
  check("列表标出哪条有响应体", all.requests[0].hasBody === true && all.requests[0].hasPostData === true);

  const api = await T.network_log({ type: "api" }, "s1");
  check("type:api 过滤掉图片", api.requests.length === 1 && api.requests[0].requestId === "req-1", JSON.stringify(api.requests));

  const d = await T.request_detail({ requestId: "req-1" }, "s1");
  check("详情带回响应体", (d.responseBody || "").includes("小明"), String(d.responseBody).slice(0, 80));
  check("详情带回请求体", (d.requestBody || "").includes("avatar"));
  check("详情带回响应头", !!d.responseHeaders?.["content-type"]);
  check("详情带回耗时/状态/IP", d.durMs === 350 && d.status === 200 && d.remoteAddr === "1.2.3.4");

  check("Cookie 默认打码", /已打码/.test(d.requestHeaders?.cookie || ""), d.requestHeaders?.cookie);
  check("Authorization 默认打码", /已打码/.test(d.requestHeaders?.authorization || ""));
  check("set-cookie 默认打码", /已打码/.test(d.responseHeaders?.["set-cookie"] || ""));
  check("非敏感头原样保留", d.requestHeaders?.["x-trace-id"] === "t-123");
  check("打码时给出提示", /revealSecrets/.test(d.headersNote || ""));

  check("拿到 ExtraInfo 时报的是原始头", /原始头/.test(d.headersSource || ""), d.headersSource);
  check("过滤头里没有的 set-cookie 也给得出来", !!d.responseHeaders?.["set-cookie"], JSON.stringify(d.responseHeaders));
  check("限流头拿得到（只在原始头里）", d.responseHeaders?.["x-ratelimit-remaining"] === "0", JSON.stringify(d.responseHeaders));
  check("请求侧同样用原始头", d.requestHeaders?.["sec-fetch-site"] === "cross-site", JSON.stringify(d.requestHeaders));
  check("拿到原始头时不再多嘴解释", d.headersSourceNote === undefined, d.headersSourceNote);
  check("被拒的 Cookie 连原因一起列出来", /tracker.*SameSiteLax/.test((d.blockedCookies || []).join("|")), JSON.stringify(d.blockedCookies));

  const d2 = await T.request_detail({ requestId: "req-1", revealSecrets: true }, "s1");
  check("revealSecrets 能拿到原文", (d2.requestHeaders?.authorization || "").includes("eyJhbGci"));

  const c = await T.as_curl({ requestId: "req-1" }, "s1");
  check("curl 含方法和 URL", c.curl.includes("-X POST") && c.curl.includes("api.example.com"));
  check("curl 含请求体", c.curl.includes("--data-raw"));
  check("curl 默认打码凭据", c.curl.includes("<REDACTED>") && c.redactedHeaders === 2, String(c.redactedHeaders));
  check("curl 带上真正发出去的 Cookie（只在原始头里）", /-H 'cookie: /.test(c.curl), c.curl);
  check("curl 报出用的是哪一份头", /^网络层原始头/.test(c.headersSource || ""), c.headersSource);
  check("拿到原始头时不多嘴解释", c.headersSourceNote === undefined, c.headersSourceNote);
  check("curl 剔除 host/content-length", !/-H 'host:|content-length:/i.test(c.curl));
  check("curl 剔除 h2 伪头", !/-H '(:authority|:method|:path|:scheme):/.test(c.curl), c.curl);
  check("curl 剔除 accept-encoding", !/-H 'accept-encoding:/i.test(c.curl), c.curl);
  check("非敏感原始头照样带上", /-H 'sec-fetch-site: cross-site'/.test(c.curl), c.curl);
  const c2 = await T.as_curl({ requestId: "req-1", revealSecrets: true }, "s1");
  check("curl 可生成可执行版本", c2.curl.includes("eyJhbGci") && !c2.curl.includes("<REDACTED>"));
  check("可执行版本里 Cookie 是原文", /-H 'cookie: session=abcdefghijklmnop; theme=dark'/.test(c2.curl), c2.curl);

  for (const v of ["yes", 1, "true", {}]) {
    const dv = await T.request_detail({ requestId: "req-1", revealSecrets: v }, "s1");
    check(
      `request_detail 的 revealSecrets:${JSON.stringify(v)} 不算数，Cookie 照旧打码`,
      /已打码/.test(dv.requestHeaders?.cookie || "") && !JSON.stringify(dv.requestHeaders).includes("eyJhbGci"),
      JSON.stringify(dv.requestHeaders?.cookie)
    );
    check(
      `request_detail 的 revealSecrets:${JSON.stringify(v)} 时提示也说还打着码`,
      /revealSecrets/.test(dv.headersNote || ""),
      dv.headersNote
    );
    const cv = await T.as_curl({ requestId: "req-1", revealSecrets: v }, "s1");
    check(
      `as_curl 的 revealSecrets:${JSON.stringify(v)} 不算数，命令里仍是 <REDACTED>`,
      cv.curl.includes("<REDACTED>") && !cv.curl.includes("eyJhbGci"),
      cv.curl.slice(0, 200)
    );
  }
  const dTrue = await T.request_detail({ requestId: "req-1", revealSecrets: true }, "s1");
  check("严格化之后 revealSecrets:true 照常给原文", (dTrue.requestHeaders?.authorization || "").includes("eyJhbGci"));

  st.bodies["req-gone"] = undefined;
  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-gone", type: "XHR", timestamp: 102,
    request: { method: "GET", url: "https://api.example.com/gone", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-gone", type: "XHR", response: { status: 200, headers: {} } });
  ev._fire(src, "Network.loadingFinished", { requestId: "req-gone", timestamp: 102.1, encodedDataLength: 1 });
  await tick();
  const dg = await T.request_detail({ requestId: "req-gone" }, "s1");
  check("body 取不到时给出原因", /No resource|identifier/.test(dg.responseBodyError || ""), dg.responseBodyError);

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-race", type: "XHR", timestamp: 103,
    request: { method: "GET", url: "https://api.example.com/race", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-race", type: "XHR", response: { status: 500, headers: {} } });
  const early = await T.request_detail({ requestId: "req-race" }, "s1");
  check("抢跑取 body 时如实报错", !!early.responseBodyError, JSON.stringify(early.responseBodyError));
  st.bodies["req-race"] = '{"marker":"late-body"}';
  ev._fire(src, "Network.loadingFinished", { requestId: "req-race", timestamp: 103.2, encodedDataLength: 22 });
  await tick();
  const late = await T.request_detail({ requestId: "req-race" }, "s1");
  check("loadingFinished 之后会重试并拿到 body", (late.responseBody || "").includes("late-body"), JSON.stringify(late.responseBody || late.responseBodyError));

  const netPair = (id, url, respExtra = {}) => {
    ev._fire(src, "Network.requestWillBeSent", {
      requestId: id, type: "XHR", timestamp: 200,
      request: { method: "GET", url, headers: { accept: "*/*" } },
    });
    ev._fire(src, "Network.responseReceived", {
      requestId: id, type: "XHR",
      response: { status: 200, headers: { "content-type": "application/json" }, ...respExtra },
    });
  };

  netPair("req-late-hdr", "https://api.example.com/late-headers");
  setTimeout(() => {
    ev._fire(src, "Network.requestWillBeSentExtraInfo", { requestId: "req-late-hdr", headers: { cookie: "a=1" } });
    ev._fire(src, "Network.responseReceivedExtraInfo", {
      requestId: "req-late-hdr",
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "7" },
    });
  }, 60);
  const t1 = Date.now();
  const lateHdr = await T.request_detail({ requestId: "req-late-hdr", includeBody: false }, "s1");
  const waited1 = Date.now() - t1;
  check("ExtraInfo 迟到时会等它，给的仍是原始头", /原始头/.test(lateHdr.headersSource || ""), lateHdr.headersSource);
  check("等到之后只在原始头里的那个头拿得到", lateHdr.responseHeaders?.["x-ratelimit-remaining"] === "7", JSON.stringify(lateHdr.responseHeaders));
  check("事件到了当场就醒，不白等满上限", waited1 < 200, `${waited1}ms`);

  netPair("req-no-extra", "https://api.example.com/no-extra-info");
  const t2 = Date.now();
  const noExtra = await T.request_detail({ requestId: "req-no-extra", includeBody: false }, "s1");
  const waited2 = Date.now() - t2;
  check("等不到 ExtraInfo 时明说给的是过滤头", /过滤/.test(noExtra.headersSource || ""), noExtra.headersSource);
  check("并说清是等过才放弃的", /等了 \d+ms/.test(noExtra.headersSourceNote || ""), noExtra.headersSourceNote);
  check("放弃了也照样把过滤头给出来", !!noExtra.responseHeaders?.["content-type"], JSON.stringify(noExtra.responseHeaders));
  check("等待有上限（没有无限等下去）", waited2 >= 200 && waited2 < 2000, String(waited2));

  netPair("req-cached", "https://cdn.example.com/cached.json", { fromDiskCache: true });
  const t3 = Date.now();
  const cached = await T.request_detail({ requestId: "req-cached", includeBody: false }, "s1");
  const waited3 = Date.now() - t3;
  check("缓存命中不为 ExtraInfo 白等", waited3 < 150, String(waited3));
  check("缓存命中也报出给的是过滤头", /过滤/.test(cached.headersSource || ""), cached.headersSource);
  check("且说清是「本来就没有」而不是「没等到」", /缓存/.test(cached.headersSourceNote || ""), cached.headersSourceNote);

  ev._fire(src, "Network.requestWillBeSentExtraInfo", {
    requestId: "req-early",
    headers: { cookie: "early=1", "sec-fetch-site": "same-origin" },
  });
  ev._fire(src, "Network.responseReceivedExtraInfo", {
    requestId: "req-early",
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "3" },
    blockedCookies: [{ cookie: { name: "blocked-early" }, blockedReasons: ["SecureOnly"] }],
  });
  netPair("req-early", "https://api.example.com/early-extra");
  const t4 = Date.now();
  const early2 = await T.request_detail({ requestId: "req-early", includeBody: false }, "s1");
  const waited4 = Date.now() - t4;
  check("ExtraInfo 早到也不丢：条目建出来就认领回去", /^网络层原始头/.test(early2.headersSource || ""), early2.headersSource);
  check("早到的原始响应头拿得到", early2.responseHeaders?.["x-ratelimit-remaining"] === "3", JSON.stringify(early2.responseHeaders));
  check("早到的原始请求头拿得到", early2.requestHeaders?.["sec-fetch-site"] === "same-origin", JSON.stringify(early2.requestHeaders));
  check("早到的被拒 Cookie 也没丢", /blocked-early.*SecureOnly/.test((early2.blockedCookies || []).join("|")), JSON.stringify(early2.blockedCookies));
  check("认领回来的不用再等", waited4 < 100, `${waited4}ms`);

  netPair("req-curl-nohdr", "https://api.example.com/no-raw-headers");
  const cNo = await T.as_curl({ requestId: "req-curl-nohdr" }, "s1");
  check("拿不到原始头时如实说是过滤头", /^浏览器过滤后的头/.test(cNo.headersSource || ""), cNo.headersSource);
  check("并且点明 Cookie 很可能整个不在命令里", /Cookie/.test(cNo.headersSourceNote || ""), cNo.headersSourceNote);
  check("明说 revealSecrets 补不回没拿到的头", /revealSecrets[\s\S]*补不回|补不回[\s\S]*revealSecrets/.test(cNo.headersSourceNote || ""), cNo.headersSourceNote);
  check("没有凭据可打码时不谈打码", cNo.redactedHeaders === 0 && cNo.note === undefined, JSON.stringify({ r: cNo.redactedHeaders, note: cNo.note }));

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-bigbody", type: "XHR", timestamp: 210,
    request: { method: "POST", url: "https://api.example.com/upload", headers: { "content-type": "application/json" }, hasPostData: true },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-bigbody", type: "XHR", response: { status: 200, headers: {} } });
  st.postDatas["req-bigbody"] = JSON.stringify({ big: "x".repeat(500) });
  const cBig = await T.as_curl({ requestId: "req-bigbody" }, "s1");
  check("大请求体现取后进了 --data-raw", /--data-raw/.test(cBig.curl) && cBig.curl.includes("xxxxx"), cBig.curl.slice(0, 120));
  check("现取成功就不必再警告 body", cBig.bodyNote === undefined, cBig.bodyNote);
  const dBig = await T.request_detail({ requestId: "req-bigbody", includeBody: false }, "s1");
  check("detail 侧同样拿得到现取的请求体", (dBig.requestBody || "").includes("xxxxx"), String(dBig.requestBody).slice(0, 80));

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-bodygone", type: "XHR", timestamp: 211,
    request: { method: "POST", url: "https://api.example.com/gone-body", headers: {}, hasPostData: true },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-bodygone", type: "XHR", response: { status: 200, headers: {} } });
  const cGoneBody = await T.as_curl({ requestId: "req-bodygone" }, "s1");
  check("请求体取不回来时命令里没有 --data-raw", !/--data-raw/.test(cGoneBody.curl), cGoneBody.curl);
  check("而且明说这条跑起来是空 body", /空 body|没有 --data-raw/.test(cGoneBody.bodyNote || ""), cGoneBody.bodyNote);

  const miss = await throws(() => T.request_detail({ requestId: "nope" }, "s1"), /没有 requestId/);
  check("未知 requestId 报错清楚", miss.threw && miss.match, miss.msg);

  const cleared = await T.network_log({ clear: true }, "s1");
  check("clear 前先返回本次数据", cleared.requests.length === 11, String(cleared.requests.length));
  const after = await T.network_log({}, "s1");
  check("clear 之后列表不再重复给已读的", after.requests.length === 0);

  const idFromCleared = cleared.requests[0].requestId;
  const stillThere = await T.request_detail({ requestId: idFromCleared }, "s1");
  check("clear 交出去的 requestId 之后依然查得到", stillThere.requestId === idFromCleared, JSON.stringify(stillThere).slice(0, 120));
  check("clear 之后 curl 导出也还查得到", !!(await T.as_curl({ requestId: idFromCleared }, "s1")).curl);
  check("列表正常时不带静态说明", !("hint" in cleared), JSON.stringify(Object.keys(cleared)));
  check("被水位挡住的条数如实报出", after.hiddenByMark === 11, JSON.stringify(after.hiddenByMark));
  const seenBack = await T.network_log({ includeSeen: true }, "s1");
  check("includeSeen 能把已读的要回来", seenBack.requests.length === 11, String(seenBack.requests.length));

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "after-clear", type: "XHR", timestamp: 200,
    request: { method: "GET", url: "https://api.example.com/fresh", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "after-clear", type: "XHR", response: { status: 200, headers: {} } });
  await tick();
  const fresh = await T.network_log({}, "s1");
  check("clear 之后新产生的请求照常列出", fresh.requests.length === 1 && fresh.requests[0].requestId === "after-clear", JSON.stringify(fresh.requests));

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "req-grow", type: "XHR", timestamp: 212,
    request: { method: "POST", url: "https://api.example.com/login", headers: {}, postData: '{"password":"12345678"}', hasPostData: true },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "req-grow", type: "XHR", response: { status: 200, headers: {} } });
  const dGrow = await T.request_detail({ requestId: "req-grow", includeBody: false, maxBody: 24 }, "s1");
  check("短凭据被打码", /已打码/.test(dGrow.requestBody || ""), dGrow.requestBody);
  check("打码变长导致被切时截断标志如实说 true", dGrow.requestBodyTruncated === true, JSON.stringify({ body: dGrow.requestBody, t: dGrow.requestBodyTruncated }));

  const WS_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  ev._fire(src, "Network.webSocketCreated", { requestId: "ws-1", url: "wss://api.example.com/graphql" });
  ev._fire(src, "Network.webSocketFrameSent", {
    requestId: "ws-1",
    response: { opcode: 1, payloadData: `{"type":"connection_init","payload":{"token":"${WS_JWT}"}}` },
  });
  ev._fire(src, "Network.webSocketFrameReceived", { requestId: "ws-1", response: { opcode: 1, payloadData: '{"type":"connection_ack"}' } });
  const wsMasked = await T.websocket({ id: "ws-1" }, "s1");
  check("WS 鉴权帧的 token 默认打码", !JSON.stringify(wsMasked.frames).includes(WS_JWT), JSON.stringify(wsMasked.frames).slice(0, 160));
  check("打码后帧里留着形状说明", /已打码|JWT/.test(wsMasked.frames[0]?.data || ""), wsMasked.frames[0]?.data);
  check("普通帧原样返回", wsMasked.frames[1]?.data === '{"type":"connection_ack"}', wsMasked.frames[1]?.data);
  check("打了码要说，并指明回显开关", /revealSecrets/.test(wsMasked.bodyRedactNote || ""), wsMasked.bodyRedactNote);
  const wsClear = await T.websocket({ id: "ws-1", revealSecrets: true }, "s1");
  check("revealSecrets:true 时 WS 帧回原文", JSON.stringify(wsClear.frames).includes(WS_JWT));
  check("原文模式不挂打码提示", wsClear.bodyRedactNote === undefined, wsClear.bodyRedactNote);
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://app.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "old", type: "XHR", timestamp: 1,
    request: { method: "GET", url: "https://api.example.com/search?q=1", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "old", type: "XHR", response: { status: 200, headers: {} } });
  ev._fire(src, "Network.loadingFinished", { requestId: "old", timestamp: 1.1, encodedDataLength: 10 });
  await new Promise((r) => setTimeout(r, 20));

  st.bodies["new"] = '{"results":[]}';
  const waiting = T.network_wait({ urlContains: "/search", timeoutMs: 3000, lookbackMs: 0 }, "s1");
  setTimeout(() => {
    ev._fire(src, "Network.requestWillBeSent", {
      requestId: "new", type: "XHR", timestamp: 5,
      request: { method: "GET", url: "https://api.example.com/search?q=2", headers: {} },
    });
    ev._fire(src, "Network.responseReceived", { requestId: "new", type: "XHR", response: { status: 200, headers: {} } });
    ev._fire(src, "Network.loadingFinished", { requestId: "new", timestamp: 5.2, encodedDataLength: 99 });
  }, 200);

  const w = await waiting;
  check("lookbackMs:0 时只认新发生的请求", w.requestId === "new", JSON.stringify(w));
  check("network_wait 返回状态和耗时", w.status === 200 && w.durMs === 200);
  const wd = await T.request_detail({ requestId: "new" }, "s1");
  check("等到之后 body 已就绪", (wd.responseBody || "").includes("results"));

  const to = await throws(
    () => T.network_wait({ urlContains: "/never-happens", timeoutMs: 300 }, "s1"),
    /等待超时/
  );
  check("等不到时报超时并给建议", to.threw && to.match && /确认操作真的触发/.test(to.msg), to.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://app.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };

  st.bodies["already"] = '{"ok":1}';
  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "already", type: "XHR", timestamp: 1,
    request: { method: "POST", url: "https://api.example.com/submit", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "already", type: "XHR", response: { status: 201, headers: {} } });
  ev._fire(src, "Network.loadingFinished", { requestId: "already", timestamp: 1.3, encodedDataLength: 10 });
  await new Promise((r) => setTimeout(r, 20));

  const back = await T.network_wait({ urlContains: "/submit", timeoutMs: 300 }, "s1");
  check("点完再调也拿得到：回看窗口内已完成的请求直接命中", back.requestId === "already", JSON.stringify(back));
  check("命中回看的明说是调用之前发生的", back.matchedBeforeCall === true && typeof back.ageMs === "number");
  check("等到的请求一律带 ageMs（窗口开得大，得能判断命中的是不是更早那一次）", typeof back.ageMs === "number", JSON.stringify(back.ageMs));
  const dflt = await throws(() => T.network_wait({ urlContains: "/绝不存在", timeoutMs: 100 }, "s1"), /含回看/);
  check("默认回看窗口是 30 秒", /含回看 30000ms/.test(dflt.msg), dflt.msg);
  check("命中回看时说清这条是调用前发生的、怎么退回严格语义", /lookbackMs:0/.test(back.note || ""), back.note);
  check("回看命中的响应体也补齐了", (await T.request_detail({ requestId: "already" }, "s1")).responseBody.includes("ok"));

  const strict = await throws(
    () => T.network_wait({ urlContains: "/submit", timeoutMs: 200, lookbackMs: 0 }, "s1"),
    /等待超时/
  );
  check("lookbackMs:0 时同一条不再算命中", strict.threw, strict.msg);
  check("lookbackMs:0 超时后说清是被这个参数挡的", /lookbackMs:0/.test(strict.msg), strict.msg);

  const stale = await throws(
    () => T.network_wait({ urlContains: "/submit", timeoutMs: 200, lookbackMs: 1 }, "s1"),
    /等待超时/
  );
  check("回看窗口之外的旧请求不算命中", stale.threw, stale.msg);
  check("窗口太小导致的超时会建议调大 lookbackMs", /把 lookbackMs 调大/.test(stale.msg), stale.msg);

  {
    st.bodies["inflight"] = '{"late":true}';
    ev._fire(src, "Network.requestWillBeSent", {
      requestId: "inflight", type: "XHR", timestamp: 10,
      request: { method: "GET", url: "https://api.example.com/inflight", headers: {} },
    });
    await new Promise((r) => setTimeout(r, 20));
    const waiting = T.network_wait({ urlContains: "/inflight", timeoutMs: 3000 }, "s1");
    setTimeout(() => {
      ev._fire(src, "Network.responseReceived", { requestId: "inflight", type: "XHR", response: { status: 200, headers: {} } });
      ev._fire(src, "Network.loadingFinished", { requestId: "inflight", timestamp: 10.4, encodedDataLength: 12 });
    }, 150);
    const got = await waiting;
    check("调用时正在飞的请求，跑完之后照样等得到", got.matched === true && got.requestId === "inflight", JSON.stringify(got));
    check("等到的是新完成的，不标 matchedBeforeCall", !got.matchedBeforeCall, JSON.stringify(got));
  }

  ev._fire(src, "Network.requestWillBeSent", {
    requestId: "doc", type: "Document", timestamp: 2,
    request: { method: "GET", url: "https://api.example.com/report.csv", headers: {} },
  });
  ev._fire(src, "Network.responseReceived", { requestId: "doc", type: "Document", response: { status: 200, headers: {} } });
  await new Promise((r) => setTimeout(r, 20));
  const narrowed = await throws(
    () => T.network_wait({ urlContains: "report.csv", timeoutMs: 200 }, "s1"),
    /等待超时/
  );
  check("URL 明明匹配却被 type 滤掉时，报错要说出来", /Document/.test(narrowed.msg) && /type:"all"/.test(narrowed.msg), narrowed.msg);
}

const focusEmuCalls = (st) => st.cdp.filter((c) => c.method === "Emulation.setFocusEmulationEnabled");
{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  check(
    "attach 不开焦点模拟（开了就是把密码管理器的浮层招进后台标签页）",
    focusEmuCalls(st).length === 0,
    JSON.stringify(st.cdp.map((c) => c.method).slice(0, 8))
  );
  await T.read_page({}, "s1");
  check("只读也不开——读页面不需要焦点", focusEmuCalls(st).length === 0, JSON.stringify(focusEmuCalls(st)));
  await T.screenshot({}, "s1");
  check("截图也不开（这条链一个输入事件都不发）", focusEmuCalls(st).length === 0, JSON.stringify(focusEmuCalls(st)));
  st.windowUpdates.length = 0;
  const r0 = await T.click({ x: 10, y: 10 }, "s1");
  check(
    "第一次真要下发输入时才开",
    focusEmuCalls(st).some((c) => c.params.enabled === true),
    JSON.stringify(focusEmuCalls(st))
  );
  check("页面不可见也能点，不抢前台", st.windowUpdates.length === 0, JSON.stringify({ r0, w: st.windowUpdates }));
  check("确实下发了鼠标事件", st.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), "");
  check(
    "也没有激活任何标签页（激活会把折叠的组掀开）",
    !st.tabUpdates.some((u) => u.props?.active),
    JSON.stringify(st.tabUpdates)
  );
}

{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  st.cdpFail = (m) => (m === "Emulation.setFocusEmulationEnabled" ? "Target closed." : null);
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com", label: "登录墙" }, "s1");
  st.windowUpdates.length = 0;
  st.tabUpdates.length = 0;
  const boom = await throws(() => T.click({ x: 10, y: 10 }, "s1"), /收不到输入/);
  check("焦点模拟失效时报错而不是假装点了", boom.threw && boom.match, boom.msg);
  check("报错时一个前台都没抢", st.windowUpdates.length === 0 && !st.tabUpdates.some((u) => u.props?.active), JSON.stringify({ w: st.windowUpdates, t: st.tabUpdates }));
  check(
    "并把标签组标成「需要你介入」（组变琥珀色）",
    st.groupUpdates.some((g) => g.props.color === "yellow"),
    JSON.stringify(st.groupUpdates.map((g) => g.props))
  );
  check("错误里告诉模型该请用户做什么", /点开.*标签组|请让用户/.test(boom.msg), boom.msg);
}

{
  const st = freshState({ visibility: "hidden", windowFocused: false, noFocusEmulation: true });
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  const r = await throws(() => T.click({ x: 10, y: 10 }, "s1"), /收不到输入/);
  check("焦点模拟根本不可用时点击报错而非静默失败", r.threw && r.match, r.msg);
  check("并且提示只读操作不受影响", /只读操作/.test(r.msg), r.msg);
  check(
    "没有任何「退回抢前台」的路径",
    st.windowUpdates.length === 0 && !st.tabUpdates.some((u) => u.props?.active),
    JSON.stringify({ w: st.windowUpdates, t: st.tabUpdates })
  );
}

{
  const st = freshState({ visibility: "visible" });
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  st.windowUpdates.length = 0;
  await T.click({ x: 10, y: 10 }, "s1");
  check("已可见时不去动窗口焦点", st.windowUpdates.length === 0, JSON.stringify(st.windowUpdates));
}

{
  const st = freshState();
  const T = loadSw(st);
  check("工具表里没有 eval 之外的意外导出", typeof T.nonexistent === "undefined");
  {
    const src = fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8");
    const declared = [...src.matchAll(/^\s{4}tool:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
    const uniq = [...new Set(declared)];
    const missing = uniq.filter((t) => typeof T[t] !== "function");
    const extra = Object.keys(T).filter((t) => !uniq.includes(t));
    check("MCP 侧每个过桥工具在扩展侧都有处理器", missing.length === 0, `缺: ${missing.join(",")}`);
    check("扩展侧没有 MCP 侧够不着的处理器", extra.length === 0, `多: ${extra.join(",")}`);
    check("过桥工具数量对得上", Object.keys(T).length === uniq.length, `扩展 ${Object.keys(T).length} / MCP ${uniq.length}`);
  }
}

{
  const st = freshState();
  loadSw(st);
  const port = st.hostPort;
  for (const evil of ["constructor", "toString", "__defineGetter__", "hasOwnProperty", "valueOf", "__proto__"]) {
    st.sent.length = 0;
    port.onMessage._fire({ id: `evil-${evil}`, type: "call", tool: evil, args: {}, session: "s1" });
    const res = st.sent.find((m) => m.id === `evil-${evil}` && m.type === "result");
    check(`原型链方法 ${evil} 被当未知工具挡下`, !!res && res.ok === false && /未知工具/.test(String(res.error || "")), JSON.stringify(res));
  }
  st.sent.length = 0;
  port.onMessage._fire({ id: "real", type: "call", tool: "tabs_list", args: {}, session: "s1" });
  await new Promise((r) => setTimeout(r, 20));
  const ok = st.sent.find((m) => m.id === "real" && m.type === "result");
  check("自有属性的真工具照常派发得到", !!ok && ok.ok === true, JSON.stringify(ok));
}

{
  const st = freshState();
  loadSw(st);
  st.chrome.runtime.id = "self-ext-id";
  let foreignReplied = false;
  st.chrome.runtime.onMessage._fire({ type: "popup-reload" }, { id: "some-other-extension" }, () => (foreignReplied = true));
  check("外来 sender 的 popup-reload 被忽略（reply 没被调用）", foreignReplied === false, JSON.stringify({ foreignReplied }));
  let noIdReplied = false;
  st.chrome.runtime.onMessage._fire({ type: "popup-reload" }, { id: undefined }, () => (noIdReplied = true));
  check("缺 id 的 sender 也被忽略", noIdReplied === false);
  let selfReply = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-reload" }, { id: "self-ext-id" }, (r) => (selfReply = r));
  check("本扩展自己的 sender 照常处理（安排了重载）", selfReply?.reloading === true, JSON.stringify(selfReply));
}

{
  const st = freshState();
  const T = loadSw(st);

  const t = await T.new_tab({ url: "https://example.com/work" });
  check("new_tab 真的开了新标签页", st.created.length === 1 && st.created[0].url.includes("/work"));
  check("new_tab 默认不抢焦点", st.created[0].active === false);
  check("新标签页被收进标签组", st.grouped.length === 1 && st.grouped[0].tabIds === st.created[0].id);
  check("首次分组用默认名", st.groupUpdates.some((g) => g.props.title === "Agent"), JSON.stringify(st.groupUpdates.map((g) => g.props.title)));
  check("new_tab 之后直接接管了它", t.tabId === st.created[0].id && st.attached.includes(t.tabId));
  check("new_tab 不去征用用户已有标签页", !st.attached.includes(1) && !st.attached.includes(2));

  st.groupUpdates.length = 0;
  await T.new_tab({ url: "https://example.com/second" });
  check("第二个标签页复用同一个组", st.grouped[1].groupId === st.grouped[0].groupId, JSON.stringify(st.grouped));
  check("复用时不重复改名", st.groupUpdates.length === 0);

  const bad = await throws(() => T.new_tab({ url: "chrome://settings" }), /浏览器内部页面/);
  check("new_tab 拒绝浏览器内部页面", bad.threw && bad.match, bad.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 2 });
  const g = await T.tab_group();
  check("tab_group 把已接管的页收进组", st.grouped.some((x) => x.tabIds === 2) && g.label === "Agent", JSON.stringify(g));
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://example.com/tmp" });
  const r = await T.close_tab();
  check("close_tab 关掉了当前接管的页", st.removed.includes(t.tabId) && r.closed === t.tabId);
  check("关掉前先 detach 调试器", st.detached.includes(t.tabId));
  const after = await T.status();
  check("关掉后 target 清空", after.target === null);
  const noTarget = await throws(() => T.close_tab(), /本会话还没有目标标签页/);
  check("没有 target 时 close_tab 报错", noTarget.threw && noTarget.match, noTarget.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const mine = await T.new_tab({ url: "https://example.com/mine" }, "s1");
  const err = await throws(() => T.close_tab({ tabId: 2 }, "s1"), /不在本会话持有的标签页里/);
  check("显式 tabId 指向用户自己的无主页时拒绝", err.threw && err.match, err.msg);
  check("用户那一页一根汗毛没动", !st.removed.includes(2), JSON.stringify(st.removed));
  check("报错里列出本会话真正持有的页，好让它改对", new RegExp(`tabId ${mine.tabId}\\b`).test(err.msg), err.msg);
  await T.close_tab({ tabId: mine.tabId }, "s1");
  check("本会话自己的页照旧关得掉", st.removed.includes(mine.tabId), JSON.stringify(st.removed));
  const solo = await T.new_tab({ url: "https://example.com/solo" }, "s1");
  await T.close_tab({}, "s1");
  check("不给 tabId 且只持有一页时照旧关那一页", st.removed.includes(solo.tabId), JSON.stringify(st.removed));
}

{
  const st = freshState();
  loadSw(st);
  const explain = st.sandbox.__explain;

  const notFound = explain("Specified native messaging host not found.");
  check(
    "「host 未找到」指向重装，且**不**叫人重启 Chrome（实测配置是每次连接现读的）",
    /install\.mjs/.test(notFound.fix) && /重连/.test(notFound.fix) && /不用重启/.test(notFound.fix),
    JSON.stringify(notFound)
  );

  const forbidden = explain("Access to the specified native messaging host is forbidden.");
  check("「禁止访问」指向扩展 ID 不匹配", /ID/.test(forbidden.why), JSON.stringify(forbidden));
  check(
    "「禁止访问」把本扩展的实际 ID 打出来（商店用户自救的唯一原料）",
    /实际 ID/.test(forbidden.why),
    JSON.stringify(forbidden)
  );
  check(
    "「禁止访问」指向 npx 重装而不是仓库脚本（商店用户没有克隆仓库）",
    /npx @liang-hz\/agent-in-chrome/.test(forbidden.fix) && !/scripts\/install\.mjs/.test(forbidden.fix),
    JSON.stringify(forbidden)
  );

  const exited = explain("Native host has exited.");
  check("「host 退出」指向日志和 launcher", /log/.test(exited.fix), JSON.stringify(exited));

  const quiet = explain("");
  check("正常断开不渲染成故障", /agent 没在跑/.test(quiet.fix), JSON.stringify(quiet));

  check("原始报错被保留下来备查", explain("weird thing").raw === "weird thing");
  check("每种情况都给了 why 和 fix", [notFound, forbidden, exited, quiet].every((d) => d.why && d.fix));
}

function uploadPage(over = {}) {
  const els = [
    el("input", { _id: "avatar", id: "avatar", type: "file", name: "avatar", ...(over.avatar || {}) }),
    el("input", { _id: "multi", id: "multi", type: "file", multiple: true }),
    el("input", { _id: "dis", id: "dis", type: "file", disabled: true }),
    el("input", { _id: "kw", id: "kw", type: "text", value: "关键词" }),
  ];
  return makePage(els);
}
const A_PATH = "/tmp/aic-upload/一号.txt";
const B_PATH = "/tmp/aic-upload/b.bin";

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 123 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file(
    { selector: "#avatar", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 123 }] },
    "s1"
  );
  check("上传成功返回文件名与字节数", r.count === 1 && r.uploaded[0].name === "一号.txt" && r.uploaded[0].sizeBytes === 123, JSON.stringify(r));
  check("返回值如实带上本机路径", r.uploaded[0].path === A_PATH, JSON.stringify(r.uploaded));

  const sent = st.cdp.find((c) => c.method === "DOM.setFileInputFiles");
  check("CDP 收到的是文件路径本身", !!sent && JSON.stringify(sent.params.files) === JSON.stringify([A_PATH]), JSON.stringify(sent?.params));
  check("没有把文件内容塞进 CDP 参数", !JSON.stringify(sent?.params || {}).includes("base64") && Object.keys(sent?.params || {}).join(",") === "objectId,files", Object.keys(sent?.params || {}).join(","));

  const avatar = st.page.elements[0];
  check("标记属性用完就删，不留在用户页面上", Object.keys(avatar._attrs).length === 0, JSON.stringify(avatar._attrs));
  check("监听器用完就摘", avatar._listeners.length === 0, String(avatar._listeners.length));
  check("如实报告 change 已由浏览器触发", r.changeFired === true && r.changeDispatchedManually === undefined, JSON.stringify(r));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 123 } });
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://example.com/form" }, "s1");
  st.frozen = new Set([tab.tabId]);
  st.execHang = (id) => !!st.frozen && st.frozen.has(id);

  const r = await T.upload_file({ selector: "#avatar", files: [A_PATH] }, "s1");
  check("冻住的页：上传照样成功（withTarget 先唤醒）", r.count === 1 && r.uploaded[0].name === "一号.txt", JSON.stringify(r).slice(0, 100));
  check("唤醒确实发了 setWebLifecycleState active", (st.lifecycle || []).some((l) => l.tabId === tab.tabId && l.state === "active"), JSON.stringify(st.lifecycle));
  check("页醒着，主路注入直达，没走降级", !st.executed.some((e) => e.immediate), JSON.stringify(st.executed.slice(-4)));
  check("唤醒之后页不再是冻的", !st.frozen.has(tab.tabId), JSON.stringify([...st.frozen]));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://frozen.example.com" }, "s1");
  const stalled = [];
  let froze = false;
  const origSend = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (method === "Page.setWebLifecycleState" && params?.state === "active") {
      (st.lifecycle = st.lifecycle || []).push({ tabId: src.tabId, state: params.state });
      while (stalled.length) stalled.shift()();
      return cb({});
    }
    if (method === "Runtime.evaluate" && !froze && src.tabId === tab.tabId && /setTimeout/.test(params?.expression || "")) {
      froze = true;
      st.cdp.push({ tabId: src.tabId, method, params });
      stalled.push(() => cb({ result: { type: "string", value: "ok" } }));
      return;
    }
    return origSend(src, method, params, cb);
  };
  const t0 = Date.now();
  let r = null;
  let evalErr = null;
  try {
    r = await T.eval_js({ expression: "new Promise(r=>setTimeout(()=>r('ok'),3000))", timeoutMs: 8000 }, "s1");
  } catch (e) {
    evalErr = String(e?.message || e).slice(0, 160);
  }
  st.chrome.debugger.sendCommand = origSend;
  while (stalled.length) stalled.shift()();
  check("等待中途被冻住的页：求值照样拿到结果（不再挂到超时）", r?.value === "ok", evalErr || JSON.stringify(r));
  check("是靠等待期间的持续唤醒解开的", (st.lifecycle || []).filter((l) => l.state === "active").length >= 2, JSON.stringify(st.lifecycle));
  check("而且没为此开焦点模拟（那条路会招来密码管理器）", !st.cdp.some((c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params?.enabled === true), JSON.stringify(st.cdp.filter((c) => /FocusEmulation/.test(c.method))));
  check("解开得比预算快得多（心跳是 2s 一拍）", Date.now() - t0 < 7000, String(Date.now() - t0));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 0 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(
    () => T.upload_file({ selector: "#avatar", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 123 }] }, "s1"),
    /没被真正读进去/
  );
  check("字节数对不上时报错而不是报成功", t.threw && t.match, t.msg);
  check("报错里给了排查方向（权限/复制到 Downloads）", /完全磁盘访问权限|Downloads/.test(t.msg), t.msg);
}

{
  const st = freshState({ page: uploadPage() });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#kw", files: [A_PATH] }, "s1"), /不是 <input type=file>/);
  check("目标不是文件输入框时报错", t.threw && t.match, t.msg);
  check("报错顺便列出页面上真正的文件输入框", /#avatar/.test(t.msg), t.msg);
  check("没有对错误的元素下发过设置", !st.cdp.some((c) => c.method === "DOM.setFileInputFiles"));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1, [B_PATH]: 2 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#avatar", files: [A_PATH, B_PATH] }, "s1"), /multiple/);
  check("单选 input 给多文件被拦下", t.threw && t.match, t.msg);
  check("拦下时根本没下发 setFileInputFiles", !st.cdp.some((c) => c.method === "DOM.setFileInputFiles"));
  check("拦下后也把标记清干净了", Object.keys(st.page.elements[0]._attrs).length === 0, JSON.stringify(st.page.elements[0]._attrs));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 5, [B_PATH]: 9 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file(
    { selector: "#multi", files: [A_PATH, B_PATH], expect: [{ name: "一号.txt", sizeBytes: 5 }, { name: "b.bin", sizeBytes: 9 }] },
    "s1"
  );
  check("multiple 输入框收下两个文件且顺序不变", r.count === 2 && r.uploaded.map((f) => f.name).join(",") === "一号.txt,b.bin", JSON.stringify(r.uploaded));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#dis", files: [A_PATH] }, "s1"), /disabled/);
  check("disabled 的输入框被拦下", t.threw && t.match, t.msg);
}

{
  const st = freshState({ page: uploadPage() });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");

  const noFiles = await throws(() => T.upload_file({ selector: "#avatar" }, "s1"), /需要 files/);
  check("没给 files 时报错", noFiles.threw && noFiles.match, noFiles.msg);

  const noTarget = await throws(() => T.upload_file({ files: [A_PATH] }, "s1"), /需要 ref/);
  check("没给 ref/selector 时说清楚要什么", noTarget.threw && noTarget.match, noTarget.msg);
  check("并提示隐藏输入框直接用 selector", /display:none|隐藏/.test(noTarget.msg), noTarget.msg);

  const badRef = await throws(() => T.upload_file({ ref: "ref_99", files: [A_PATH] }, "s1"), /重新 read_page/);
  check("失效的 ref 提示重新读页面", badRef.threw && badRef.match, badRef.msg);

  const noSel = await throws(() => T.upload_file({ selector: "#nope", files: [A_PATH] }, "s1"), /没有匹配/);
  check("selector 匹配不到时给排查建议", noSel.threw && noSel.match, noSel.msg);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 7 }, noNativeChange: true });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file({ selector: "#avatar", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 7 }] }, "s1");
  check("浏览器没触发 change 时补发一个", r.changeFired === false && r.changeDispatchedManually === true, JSON.stringify(r));
  check("补发的事件真的派发到了元素上", st.page.elements[0]._dispatched.includes("change"), JSON.stringify(st.page.elements[0]._dispatched));
  check("并提醒模型页面可能没反应", /没有收到 change/.test(r.hint || ""), r.hint);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1 }, uploadFindsNothing: true });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#avatar", files: [A_PATH] }, "s1"), /重新 read_page/);
  check("元素中途消失时报错并给出下一步", t.threw && t.match, t.msg);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1 }, setFileInputFilesFails: true });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#avatar", files: [A_PATH] }, "s1"), /CDP 设置文件失败/);
  check("CDP 报错原样透出来", t.threw && t.match, t.msg);
  check("失败后标记属性照样被清掉", Object.keys(st.page.elements[0]._attrs).length === 0, JSON.stringify(st.page.elements[0]._attrs));
}

const framePageMock = (url, extra = {}) =>
  makePage([el("input", { _id: "frame-file", id: "frame-file", type: "file", name: "ff", ...extra })], { url });

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 11 } });
  const child = framePageMock("https://cdn.example.com/uploader");
  st.subFrames = [{ frameId: 7, page: child, url: "https://cdn.example.com/uploader" }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file(
    { selector: "#frame-file", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 11 }] },
    "s1"
  );
  check("主文档没有时会到 iframe 里找并上传", r.count === 1 && r.uploaded[0].name === "一号.txt", JSON.stringify(r));
  check("如实报告文件进的是哪个帧", r.target.frame === "f7" && /cdn\.example\.com/.test(r.target.frameUrl || ""), JSON.stringify(r.target));
  check("文件确实落在子帧那个 input 上", (child.elements[0].files || []).length === 1, JSON.stringify(child.elements[0].files));
  check("主文档的输入框没被误伤", !(st.page.elements[0].files || []).length, JSON.stringify(st.page.elements[0].files));
  const iso = st.cdp.find((c) => c.method === "Page.createIsolatedWorld");
  check("同进程子帧走的是隔离世界这条通道", !!iso && iso.params.frameId === "F7", JSON.stringify(iso?.params));
  check("同进程子帧不需要开跨进程会话", !st.cdp.some((c) => c.method === "Target.setAutoAttach"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("子帧里的标记也清干净了", Object.keys(child.elements[0]._attrs).length === 0, JSON.stringify(child.elements[0]._attrs));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 9 } });
  const child = framePageMock("https://oop.example.com/iso");
  st.subFrames = [{ frameId: 11, page: child, url: "https://oop.example.com/iso", oopif: true }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  let r = null;
  let upErr = null;
  try {
    r = await T.upload_file({ selector: "#frame-file", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 9 }] }, "s1");
  } catch (e) {
    upErr = String(e?.message || e).slice(0, 200);
  }
  check("OOPIF 里的输入框也能上传（会话没被提前还掉）", r?.count === 1 && r.uploaded[0].name === "一号.txt", upErr || JSON.stringify(r).slice(0, 200));
  check("文件确实落在那个跨进程帧的 input 上", (child.elements[0].files || []).length === 1, JSON.stringify(child.elements[0].files));
  check("走的是跨进程会话这条通道", st.cdp.some((c) => c.method === "Target.setAutoAttach" && c.params?.autoAttach === true), JSON.stringify(st.cdp.map((c) => c.method)));
  const auto = st.cdp.filter((c) => c.method === "Target.setAutoAttach").map((c) => !!c.params?.autoAttach);
  check("用完之后把 auto-attach 关回去了（不许只借不还）", auto[auto.length - 1] === false, JSON.stringify(auto));
  const setAt = st.cdp.findIndex((c) => c.method === "DOM.setFileInputFiles");
  const offAt = st.cdp.findIndex((c) => c.method === "Target.setAutoAttach" && c.params?.autoAttach === false);
  check("而且是**发完文件之后**才还的", setAt >= 0 && offAt > setAt, JSON.stringify(st.cdp.map((c) => c.method)));
  check("帧里的标记也清干净了", Object.keys(child.elements[0]._attrs).length === 0, JSON.stringify(child.elements[0]._attrs));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 11 } });
  const c1 = framePageMock("https://a.example.com/one");
  const c2 = framePageMock("https://b.example.com/two");
  st.subFrames = [
    { frameId: 7, page: c1, url: "https://a.example.com/one" },
    { frameId: 9, page: c2, url: "https://b.example.com/two" },
  ];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#frame-file", files: [A_PATH] }, "s1"), /都匹配到了/);
  check("selector 同时命中多个 iframe 时拦下", t.threw && t.match, t.msg);
  check("报错列出候选帧号和地址", /f7/.test(t.msg) && /f9/.test(t.msg) && /a\.example\.com/.test(t.msg), t.msg);
  check("报错说明了怎么点名", /frame: "f7"|frame: 'f7'/.test(t.msg), t.msg);
  check("拦下时一个文件都没设过", !st.cdp.some((c) => c.method === "DOM.setFileInputFiles"));
  check("探测轮没在任何帧里留下标记", !Object.keys(c1.elements[0]._attrs).length && !Object.keys(c2.elements[0]._attrs).length, JSON.stringify([c1.elements[0]._attrs, c2.elements[0]._attrs]));
  check("探测轮也没留下监听器", !c1.elements[0]._listeners.length && !c2.elements[0]._listeners.length);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 3 } });
  const c1 = framePageMock("https://a.example.com/one");
  const c2 = framePageMock("https://b.example.com/two");
  st.subFrames = [
    { frameId: 7, page: c1, url: "https://a.example.com/one" },
    { frameId: 9, page: c2, url: "https://b.example.com/two" },
  ];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file({ selector: "#frame-file", frame: "f9", files: [A_PATH] }, "s1");
  check("frame 点名时传进指定的那一帧", r.target.frame === "f9" && (c2.elements[0].files || []).length === 1, JSON.stringify(r.target));
  check("没被点名的帧一个字节都没收到", !(c1.elements[0].files || []).length);

  const bad = await throws(() => T.upload_file({ selector: "#frame-file", frame: "第七帧", files: [A_PATH] }, "s1"), /frame 形如/);
  check("frame 格式不对时说清格式", bad.threw && bad.match, bad.msg);

  const gone = await throws(() => T.upload_file({ selector: "#frame-file", frame: "f404", files: [A_PATH] }, "s1"), /注入失败|重新 browser_read_page/);
  check("帧号不存在时报错并指向 read_page", gone.threw && gone.match, gone.msg);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 4 } });
  const child = framePageMock("https://a.example.com/one");
  st.subFrames = [{ frameId: 7, page: child, url: "https://a.example.com/one" }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  child.win.__aicRefs = [child.elements[0]];
  const r = await T.upload_file({ ref: "ref_1@f7", files: [A_PATH] }, "s1");
  check("ref_N@fM 直接落到那一帧", r.target.frame === "f7" && (child.elements[0].files || []).length === 1, JSON.stringify(r.target));

  const clash = await throws(() => T.upload_file({ ref: "ref_1@f7", frame: "f9", files: [A_PATH] }, "s1"), /对不上/);
  check("ref 的帧号和 frame 参数打架时拦下", clash.threw && clash.match, clash.msg);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 12 } });
  const child = framePageMock("https://pay.stripe.com/frame");
  st.subFrames = [{ frameId: 7, page: child, url: "https://pay.stripe.com/frame", oopif: true }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file(
    { selector: "#frame-file", files: [A_PATH], expect: [{ name: "一号.txt", sizeBytes: 12 }] },
    "s1"
  );
  check("跨进程 iframe（OOPIF）里的输入框也传得进去", r.count === 1 && (child.elements[0].files || []).length === 1, JSON.stringify(r));
  check("如实标注这是跨进程帧", r.target.crossProcessFrame === true && r.target.frame === "f7", JSON.stringify(r.target));
  const set = st.cdp.find((c) => c.method === "DOM.setFileInputFiles");
  check("设置命令是打在那个帧的会话上的", set?.sessionId === "sess-7", JSON.stringify({ sessionId: set?.sessionId }));
  const off = st.cdp.filter((c) => c.method === "Target.setAutoAttach" && c.params?.autoAttach === false);
  check("用完把跨进程会话关掉", off.length === 1, JSON.stringify(st.cdp.filter((c) => c.method === "Target.setAutoAttach").map((c) => c.params)));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 6 } });
  const outer = makePage([el("div", { _id: "x", id: "x" })]);
  const inner = framePageMock("https://deep.example.com/inner");
  st.subFrames = [
    { frameId: 7, page: outer, url: "https://ad.example.com/outer", oopif: true },
    { frameId: 8, page: inner, url: "https://deep.example.com/inner", oopif: true, under: 7 },
  ];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const r = await T.upload_file({ selector: "#frame-file", files: [A_PATH] }, "s1");
  check("跨进程帧里再嵌跨进程帧也够得着", r.count === 1 && (inner.elements[0].files || []).length === 1, JSON.stringify(r.target));
  check("是在子会话里再开一次 auto-attach 找到的", st.cdp.some((c) => c.method === "Target.setAutoAttach" && c.sessionId === "sess-7" && c.params?.autoAttach === true), JSON.stringify(st.cdp.filter((c) => c.method === "Target.setAutoAttach").map((c) => [c.sessionId, c.params?.autoAttach])));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 2 } });
  st.subFrames = [{ frameId: 7, page: framePageMock("https://a.example.com/one"), url: "https://a.example.com/one", oopif: true }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  await T.upload_file({ selector: "#avatar", files: [A_PATH] }, "s1");
  check("主文档命中时不开跨进程会话", !st.cdp.some((c) => c.method === "Target.setAutoAttach"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("主文档命中时也不去遍历帧树", !st.cdp.some((c) => c.method === "Page.getFrameTree"), JSON.stringify(st.cdp.map((c) => c.method)));
}

{
  const st = freshState({ page: uploadPage() });
  const child = makePage([
    el("button", { _id: "frame-btn", id: "frame-btn", text: "帧内按钮" }),
    el("input", { _id: "frame-file", id: "frame-file", type: "file" }),
  ]);
  st.subFrames = [{ frameId: 7, page: child, url: "https://a.example.com/one", oopif: true }];
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ selector: "#frame-btn", frame: "f7", files: [A_PATH] }, "s1"), /不是 <input type=file>/);
  check("帧内选错元素时按那一帧的情况报错", t.threw && t.match, t.msg);
  check("并列出那一帧里真正的文件输入框", /#frame-file/.test(t.msg), t.msg);
}

{
  const traceMod = await import(pathToFileURL(path.join(ROOT, "mcp", "trace.mjs")).href);
  const shapeMod = await import(pathToFileURL(path.join(ROOT, "mcp", "secret-shape.mjs")).href);
  const TDIR = fs.mkdtempSync(path.join(os.tmpdir(), "aic-trace-test-"));
  const mk = (sid) => traceMod.createTrace({ sessionId: sid, dir: TDIR, version: "test" });
  const readFile = (t) => fs.readFileSync(t.file, "utf8");
  const run = (t, tool, args, res) => {
    const s = t.begin(tool, args);
    return t.end(s, res);
  };

  {
    const src = fs.readFileSync(path.join(ROOT, "mcp", "server.mjs"), "utf8");
    const bridged = [...src.matchAll(/^\s{4}tool: "([a-z_]+)",$/gm)].map((m) => m[1]);
    const T = loadSw(freshState());
    const missing = bridged.filter((n) => typeof T[n] !== "function");
    check("MCP 侧每个过桥工具在扩展侧都有处理器", missing.length === 0, `扩展侧缺: ${missing.join(", ")}`);
    check("过桥工具数与扩展侧处理器数一致", bridged.length === Object.keys(T).length, `MCP ${bridged.length} / 扩展 ${Object.keys(T).length}`);
    check("browser_trace 是本地工具，不过桥", !src.includes('tool: "trace"') && /local: traceTool/.test(src));
  }

  {
    const t = mk("basic");
    run(t, "browser_new_tab", { url: "https://x/" }, { ok: true, data: { tabId: 5 }, page: { tabId: 5, url: "https://x/", title: "X" } });
    run(t, "browser_click", { ref: "ref_2" }, { ok: false, error: new Error("不可操作（hidden）：ref_2 当前不可见"), page: { tabId: 5, url: "https://x/", title: "X" } });
    run(t, "browser_read_page", {}, { ok: true, data: { title: "X" }, page: { tabId: 5, url: "https://x/", title: "X" } });
    const l = t.list({});
    check("步骤按序号递增", l.steps.map((s) => s.n).join(",") === "1,2,3", JSON.stringify(l.steps.map((s) => s.n)));
    check("总步数正确", l.totalSteps === 3);
    check("失败的那一步被点名", l.failedSteps.join() === "2" && l.lastFailedStep === 2, JSON.stringify(l.failedSteps));
    check("失败步在列表里带 FAILED 标记", l.steps[1].FAILED === true);
    check("失败步直接带错误原文", /ref_2 当前不可见/.test(l.steps[1].error), l.steps[1].error);
    check("成功步不带 FAILED", !l.steps[0].FAILED && !l.steps[2].FAILED);
    check("每步记了工具名", l.steps[0].tool === "browser_new_tab");
    check("每步记了当时的页面 URL 和标题", l.steps[0].url === "https://x/" && l.steps[0].title === "X");
    check("每步记了耗时", typeof l.steps[0].ms === "number");
    check("每步记了时间戳", /^\d{4}-\d\d-\d\dT/.test(l.steps[0].at));
    check("onlyFailed 只给失败的", t.list({ onlyFailed: true }).steps.length === 1);
    const d = t.detail(2);
    check("详情能取到指定步", d.step?.n === 2 && d.step.tool === "browser_click");
    check("详情带完整入参", d.step.args.ref === "ref_2", JSON.stringify(d.step.args));
    check("详情带前后步导航", d.prev?.n === 1 && d.next?.n === 3);
    const miss = t.detail(99);
    check("查不存在的步给出还剩哪些", /不在内存也不在磁盘/.test(miss.error || ""), miss.error);
  }

  {
    const t = mk("batch-marks");
    t.end(t.begin("browser_scroll", {}, null, { of: "batch#1", index: 1 }), { ok: true, data: {}, page: null });
    t.end(t.begin("browser_click", { ref: "ref_1" }, null, { of: "batch#1", index: 2 }), { ok: true, data: {}, page: null });
    run(t, "browser_read_page", {}, { ok: true, data: {}, page: null });
    t.end(t.begin("browser_type", { text: "x" }, null, { of: "batch#2", index: 1 }), { ok: true, data: {}, page: null });
    const l = t.list({});
    check("batch 展开的步骤带 batchOf + stepIndex", l.steps[0].batchOf === "batch#1" && l.steps[0].stepIndex === 1, JSON.stringify(l.steps[0]));
    check("同一批里 stepIndex 递增", l.steps[1].batchOf === "batch#1" && l.steps[1].stepIndex === 2, JSON.stringify(l.steps[1]));
    check("单发调用不带这两个字段（收到什么记什么）", !("batchOf" in l.steps[2]) && !("stepIndex" in l.steps[2]), JSON.stringify(l.steps[2]));
    check("换一批就换编号", l.steps[3].batchOf === "batch#2" && l.steps[3].stepIndex === 1, JSON.stringify(l.steps[3]));
    check("详情里也留着（回看单步时要知道它是批里的第几步）", t.detail(2).step.batchOf === "batch#1" && t.detail(2).step.stepIndex === 2, JSON.stringify(t.detail(2).step));
    check("落盘的那一份也带着（跨会话回看靠它）", /"batchOf":"batch#1"/.test(readFile(t)), readFile(t).slice(0, 200));
  }

  {
    const t = mk("secrets");
    run(t, "browser_type", { text: "hunter2-我的密码", ref: "ref_9" }, { ok: true, data: { typed: true }, page: null });
    run(t, "browser_request_detail", { requestId: "r1", revealSecrets: true }, { ok: true, data: { requestHeaders: { cookie: "SID=DEADBEEF-REAL-COOKIE" } }, page: null });
    run(t, "browser_request_detail", { requestId: "r2" }, { ok: true, data: { requestHeaders: { cookie: "SID=ANOTHER-REAL-COOKIE", authorization: "Bearer REALTOKEN123" } }, page: null });
    run(t, "browser_cdp", { method: "Network.setCookie", params: { name: "sid", token: "TOKEN-IN-ARGS" } }, { ok: true, data: { ok: 1 }, page: null });
    const raw = readFile(t);
    for (const needle of ["hunter2", "我的密码", "DEADBEEF-REAL-COOKIE", "ANOTHER-REAL-COOKIE", "REALTOKEN123", "TOKEN-IN-ARGS"]) {
      check(`凭据不明文落盘：${needle}`, !raw.includes(needle));
    }
    const l = t.list({});
    check("打了码也说明有多长", /已打码 \d+ 字符/.test(JSON.stringify(l.steps[0])), JSON.stringify(l.steps[0]));
    check("browser_type 记得住是在哪个输入框", t.detail(1).step.args.ref === "ref_9");
    check("revealSecrets 调用明说结果没记", /revealSecrets/.test(t.detail(2).step.resultNote || ""), t.detail(2).step.resultNote);
    check("revealSecrets 的结果确实是空的", t.detail(2).step.result === null);
    check("revealSecrets 开关本身不被打码", t.detail(2).step.args.revealSecrets === true, JSON.stringify(t.detail(2).step.args));
  }

  {
    const t = mk("shape");
    const JAR = "sessionid=aq3x9kf20soi3nfk2h1; csrftoken=zk29fk20dj2093ks";
    const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    run(t, "browser_eval", { expression: "document.cookie" }, { ok: true, data: { value: JAR }, page: null });
    run(t, "browser_eval", { expression: "x" }, { ok: true, data: { value: JSON.stringify({ auth: JWT }) }, page: null });
    const raw = readFile(t);
    check("cookie 串按内容认出来，不落盘", !raw.includes("aq3x9kf20soi3nfk2h1"), raw.slice(0, 200));
    check("JWT 按内容认出来，不落盘", !raw.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r"), raw.slice(0, 200));
    check("隐去了值但说得出有哪些 cookie", /sessionid/.test(raw) && /csrftoken/.test(raw), raw.slice(0, 300));

    const { looksLikeSecret } = shapeMod;
    check("认得出：典型 cookie jar", looksLikeSecret(JAR));
    check("认得出：JWT", looksLikeSecret(JWT));
    for (const [name, v] of [
      ["CSS 内联样式", "display=block; color=red"],
      ["短偏好设置", "lang=zh; theme=dark; sidebar=open"],
      ["URL 查询串", "https://a.test/s?q=hello&page=2&sort=desc&filter=active"],
      ["单个键值对", "username=someverylongusername12345"],
      ["sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["UUID", "550e8400-e29b-41d4-a716-446655440000"],
      ["Content-Type", "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW"],
      ["普通正文", "这是一段够长的中文正文，用来确认正常内容不会被误判成凭据"],
    ])
      check(`不误报：${name}`, !looksLikeSecret(v), v.slice(0, 60));
  }

  {
    const t = mk("echo");
    const PW = "P@ssw0rd-很长的密码-9527";
    run(t, "browser_type", { text: PW, ref: "ref_4" }, { ok: true, data: { typed: PW, pressEnter: false }, page: null });
    run(t, "browser_type", { text: "abc", ref: "ref_5" }, { ok: false, error: `往 abc 输入失败`, page: null });
    run(t, "browser_cdp", { method: "X", params: { apiKey: "KEY-1234567890" } }, { ok: true, data: { echoed: "收到 KEY-1234567890" }, page: null });
    const raw = readFile(t);
    check("回显的输入文本被打码（不是只打入参）", !raw.includes("P@ssw0rd"), raw.slice(0, 200));
    check("短输入也盖得住（精确规则兜底）", !/往 abc 输入失败/.test(raw), raw);
    check("报错文案里的入参原文也被清洗", /往 <已打码 3 字符> 输入失败/.test(raw), raw.slice(0, 300));
    check("结果里绕回来的凭据一样被清洗", !raw.includes("KEY-1234567890"), raw.slice(0, 200));
    check("清洗后仍看得出这一步干了什么", t.detail(1).step.result.pressEnter === false && !!t.detail(1).step.args.ref);
  }

  {
    const t = mk("cookiejar");
    const V = "sid-SECRET-COOKIE-abcdef123456";
    run(
      t,
      "browser_cookies_import",
      { cookies: [{ name: "zc_sid", value: V, domain: "a.test", path: "/" }, { name: "short", value: "ab", domain: "a.test" }], clearFirst: false },
      { ok: true, data: { requested: 2, imported: 2 }, page: null }
    );
    run(t, "browser_cookies_import", { cookies: [{ name: "x", value: V, domain: "b.test" }] }, { ok: false, error: `种 ${V} 失败`, page: null });
    const raw = readFile(t);
    check("cookie 值不明文落盘", !raw.includes("SECRET-COOKIE"), raw.slice(0, 300));
    check("name/domain 留着（回看「导入了哪些站」要用）", t.detail(1).step.args.cookies[0].name === "zc_sid" && t.detail(1).step.args.cookies[0].domain === "a.test", JSON.stringify(t.detail(1).step.args.cookies));
    check("值打码后说明有多长", /已打码 \d+ 字符/.test(String(t.detail(1).step.args.cookies[0].value)), JSON.stringify(t.detail(1).step.args.cookies[0]));
    check("短的值也被打码（打码不看长度，只有清洗才看）", /已打码/.test(String(t.detail(1).step.args.cookies[1].value)), JSON.stringify(t.detail(1).step.args.cookies[1]));
    check("报错文案里绕回来的 cookie 值也被清洗", !String(t.detail(2).step.error).includes("SECRET-COOKIE"), t.detail(2).step.error);
  }

  {
    const t = mk("rpcmeta");
    const AGENT = "agent_249b96c8-77c0-4943-afb9-218d16f2bfb3";
    const withMeta = (tool, args, meta, res) => t.end(t.begin(tool, args, meta), res);

    run(t, "browser_new_tab", { url: "https://x/" }, { ok: true, data: {}, page: null });
    withMeta(
      "browser_click",
      { ref: "ref_1" },
      { progressToken: "p-1", "x-auth-token": "REAL-TOKEN-abcdefghij", "agent/agentId": AGENT, "agent/kind": "subagent" },
      { ok: true, data: {}, page: null }
    );
    withMeta(
      "browser_click",
      { ref: "ref_2" },
      { apiKey: "sk-META-KEY-abcdefghij", nested: { token: "META-TOKEN-abcdefghij" } },
      { ok: true, data: {}, page: null }
    );
    withMeta("browser_click", { ref: "ref_3" }, {}, { ok: true, data: {}, page: null });
    withMeta(
      "browser_eval",
      { expression: "1" },
      { apiKey: "sk-ECHOED-KEY-1234567890" },
      { ok: true, data: { echoed: "收到 sk-ECHOED-KEY-1234567890" }, page: null }
    );

    const l = t.list({});
    check("没带 _meta 的调用不写空字段", !/rpcMeta/.test(JSON.stringify(l.steps[0])), JSON.stringify(l.steps[0]));
    check("_meta 是空对象时同样不写字段", !/rpcMeta/.test(JSON.stringify(l.steps[3])), JSON.stringify(l.steps[3]));
    check(
      "_meta 里的 agent 身份如实记下（要它就是为了这个）",
      l.steps[1].rpcMeta?.["agent/agentId"] === AGENT,
      JSON.stringify(l.steps[1].rpcMeta)
    );
    check("_meta 的其他字段也一并记下", l.steps[1].rpcMeta?.["agent/kind"] === "subagent", JSON.stringify(l.steps[1].rpcMeta));
    check(
      "列表视图里就看得见 _meta（横着比才看得出哪几步同源）",
      "rpcMeta" in l.steps[1],
      JSON.stringify(Object.keys(l.steps[1]))
    );
    check("详情视图里也有 _meta", t.detail(2).step?.rpcMeta?.["agent/agentId"] === AGENT, JSON.stringify(t.detail(2).step?.rpcMeta));
    check("progressToken 是协议字段，不打码（对号排查要用它）", l.steps[1].rpcMeta?.progressToken === "p-1", JSON.stringify(l.steps[1].rpcMeta));
    check(
      "但别的带 token 的字段照旧打码（放行的是精确名，不是放宽了规则）",
      /^<已打码/.test(String(l.steps[1].rpcMeta?.["x-auth-token"] ?? "<已打码 0 字符>")),
      JSON.stringify(l.steps[1].rpcMeta)
    );
    const raw = readFile(t);
    for (const needle of ["sk-META-KEY-abcdefghij", "META-TOKEN-abcdefghij", "REAL-TOKEN-abcdefghij", "sk-ECHOED-KEY-1234567890"]) {
      check(`_meta 里的凭据不明文落盘：${needle}`, !raw.includes(needle));
    }
    check("_meta 深层对象里的凭据也打码", /已打码 \d+ 字符/.test(JSON.stringify(t.detail(3).step.rpcMeta?.nested)), JSON.stringify(t.detail(3).step.rpcMeta));
    check("_meta 里的凭据从结果里绕回来也被抹掉", /已打码 \d+ 字符/.test(JSON.stringify(t.detail(5).step.result)), JSON.stringify(t.detail(5).step.result));

    const rd = traceMod.readTraceFile(t.file, { limit: 20 });
    check("带 _meta 的步骤没被当成文件头吞掉", rd.totalSteps === 5, `${rd.totalSteps} 步`);
    check("文件头仍认得出是会话元信息", rd.meta?.session === "rpcmeta", JSON.stringify(rd.meta));
    check("从磁盘读回来 _meta 还在", rd.steps.find((s) => s.n === 2)?.rpcMeta?.["agent/agentId"] === AGENT, JSON.stringify(rd.steps.find((s) => s.n === 2)?.rpcMeta));

    check("_meta 不是对象时不记", traceMod.redactMeta("agent_x") === null && traceMod.redactMeta([1, 2]) === null);
    check("没有 _meta 时不记", traceMod.redactMeta(null) === null && traceMod.redactMeta(undefined) === null && traceMod.redactMeta({}) === null);
    check("_meta 里的超长字符串一样截断留痕", /已截断，原 500 字符/.test(JSON.stringify(traceMod.redactMeta({ note: "长".repeat(500) }))));
  }

  {
    const t = mk("concurrent");
    const a = t.begin("browser_network_wait", { urlContains: "/api" });
    const b = t.begin("browser_click", { ref: "ref_1" });
    t.end(b, { ok: true, data: { clicked: 1 }, page: null });
    t.end(a, { ok: true, data: { status: 200 }, page: null });
    const l = t.list({});
    check("并发乱序完成时列表仍按步号排", l.steps.map((s) => s.n).join() === "1,2", JSON.stringify(l.steps.map((s) => s.n)));
    check("步号对应的工具没有错位", l.steps[0].tool === "browser_network_wait" && l.steps[1].tool === "browser_click", JSON.stringify(l.steps.map((s) => s.tool)));
    check("乱序时前后步导航也对", t.detail(2).prev?.n === 1 && t.detail(1).next?.n === 2);
  }

  {
    const t = mk("truncate");
    run(t, "browser_read_page", {}, { ok: true, data: { text: "长".repeat(30000), elements: new Array(150).fill({ ref: "ref_1", name: "按钮" }) }, page: null });
    run(t, "browser_screenshot", {}, { ok: true, data: { image: "A".repeat(300000), mimeType: "image/png" }, page: null });
    run(t, "browser_eval", { expression: "x".repeat(5000) }, { ok: true, data: { v: 1 }, page: null });
    const j = JSON.stringify(t.list({}));
    check("超长正文被截断且标注了原长度", /已截断，原 30000 字符/.test(j), j.slice(0, 200));
    check("大数组只留条数不留全部", /"count":150/.test(j) && /其余 149 项未记入摘要/.test(j));
    check("结果摘要明说自己是摘要", /这是结果摘要，不是完整返回值/.test(j));
    check("截图的 base64 不进 trace", !j.includes("AAAAAAAAAA"), j.slice(0, 120));
    check("截图记了大小但注明内容未记录", /base64 300000 字符，内容未记录/.test(j));
    check("超长入参也截断并标注", /已截断，原 5000 字符/.test(JSON.stringify(t.detail(3).step.args)));
    const maxLine = Math.max(...readFile(t).split("\n").map((l) => l.length));
    check("单步落盘不超过 2KB", maxLine < 2048, `最长 ${maxLine}`);
  }

  {
    const t = mk("cap");
    for (let i = 1; i <= 260; i++) run(t, "browser_click", { ref: "ref_" + i }, { ok: i !== 7, data: { i }, error: "第 7 步炸了", page: null });
    const l = t.list({ limit: 500 });
    check("环形缓冲封顶 200 步", l.kept === 200, String(l.kept));
    check("累计步数照实报", l.totalSteps === 260);
    check("被挤掉的步数明确标出来", /最早的 60 步已被环形缓冲挤掉/.test(l.dropped || ""), l.dropped);
    check("失败步号不随环形缓冲丢失", l.failedSteps.join() === "7", JSON.stringify(l.failedSteps));
    check("失败详情滚出内存时告诉你去哪捞", /browser_trace \{step:N\}/.test(l.failedOutOfMemory || ""), l.failedOutOfMemory);
    const d = t.detail(7);
    check("滚出内存的失败步能从磁盘读回", d.readFrom === "磁盘文件" && /第 7 步炸了/.test(d.step?.error || ""), JSON.stringify(d).slice(0, 150));
  }
  {
    const t = mk("compact");
    for (let i = 1; i <= 3000; i++) run(t, "browser_eval", { expression: "e".repeat(280) }, { ok: true, data: { v: "v".repeat(180) }, page: { tabId: 1, url: "https://x/", title: "T" } });
    check("trace 文件不超过 1MB", fs.statSync(t.file).size <= 1_000_000, String(fs.statSync(t.file).size));
    const rd = traceMod.readTraceFile(t.file, { limit: 5 });
    check("压实后文件仍可读", rd.totalSteps > 0 && rd.steps.length === 5);
    check("压实在文件头留了痕", typeof rd.meta?.compactedAt === "string" && rd.meta.dropped > 0, JSON.stringify(rd.meta));
  }

  {
    const a = mk("sess-A");
    const b = mk("sess-B");
    run(a, "browser_new_tab", { url: "https://a/" }, { ok: true, data: {}, page: { tabId: 1, url: "https://a/", title: "A" } });
    run(b, "browser_new_tab", { url: "https://b/" }, { ok: true, data: {}, page: { tabId: 2, url: "https://b/", title: "B" } });
    run(b, "browser_click", { ref: "ref_1" }, { ok: false, error: "B 的错误", page: null });
    check("两个会话写不同文件", a.file !== b.file, `${a.file} / ${b.file}`);
    check("A 只有自己那一步", a.list({}).totalSteps === 1 && a.list({}).failedSteps.length === 0);
    check("B 的失败没记到 A 头上", b.list({}).failedSteps.join() === "2");
    check("A 的文件里没有 B 的痕迹", !readFile(a).includes("https://b/") && !readFile(a).includes("B 的错误"));
    check("B 的文件里没有 A 的痕迹", !readFile(b).includes("https://a/"));
  }

  {
    const evil = mk("../../etc/pwn");
    const evil2 = mk("../../etc/pwn2");
    run(evil, "browser_status", {}, { ok: true, data: {}, page: null });
    run(evil2, "browser_status", {}, { ok: true, data: {}, page: null });
    check("怪异会话 id 被清洗成安全文件名", path.dirname(evil.file) === TDIR, evil.file);
    check("清洗后仍能区分不同 id", evil2.file !== evil.file);
  }

  {
    const idle = mk("idle-session");
    check("没有任何调用时不建文件", idle.file === null && !fs.existsSync(path.join(TDIR, "idle-session.jsonl")));
    run(idle, "browser_status", {}, { ok: true, data: {}, page: null });
    check("第一步一来就建上了", typeof idle.file === "string" && fs.existsSync(idle.file), String(idle.file));
  }

  {
    const blocker = path.join(TDIR, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const t = traceMod.createTrace({ sessionId: "nodisk", dir: path.join(blocker, "nope") });
    const r = run(t, "browser_click", { ref: "ref_1" }, { ok: true, data: {}, page: null });
    check("盘写不了照样在内存里记账", r?.n === 1 && t.list({}).totalSteps === 1);
    check("盘写不了会如实告诉调用方", /只在内存里/.test(t.list({}).diskNote || ""), t.list({}).diskNote);
  }

  {
    const t = traceMod.createTrace({ sessionId: "off", dir: TDIR, enabled: false });
    run(t, "browser_click", { ref: "ref_1" }, { ok: true, data: {}, page: null });
    check("enabled:false 跑了一步也不落盘", t.file === null && !fs.existsSync(path.join(TDIR, "off.jsonl")));
  }

  {
    const before = traceMod.listTraceFiles(TDIR).length;
    check("能列出本机的 trace 文件", before >= 5, String(before));
    check("列表按时间倒序", (() => {
      const l = traceMod.listTraceFiles(TDIR);
      return l.every((f, i) => i === 0 || l[i - 1].modified >= f.modified);
    })());
    const keepMe = mk("keep-me");
    run(keepMe, "browser_status", {}, { ok: true, data: {}, page: null });
    const removed = traceMod.pruneTraceDir(TDIR, { keep: 3, days: 7, keepFile: keepMe.file });
    check("清理会删掉超额的旧文件", removed > 0, String(removed));
    check("清理不删当前会话正在写的那份", fs.existsSync(keepMe.file));
    check("清理后数量收敛", traceMod.listTraceFiles(TDIR).length <= 4, String(traceMod.listTraceFiles(TDIR).length));
  }

  fs.rmSync(TDIR, { recursive: true, force: true });
}

{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aic-dev-"));
  let sockN = 0;

  const listTools = (extraEnv) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, AGENT_IN_CHROME_SOCK: path.join(TMP, `${sockN++}.sock`), AGENT_IN_CHROME_TRACE: "off", AGENT_IN_CHROME_SESSION_ID: "devtools-test" };
      delete env.AGENT_IN_CHROME_DEV;
      Object.assign(env, extraEnv);
      const p = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], { stdio: ["pipe", "pipe", "pipe"], env });
      const done = (fn, v) => {
        clearTimeout(timer);
        p.kill();
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error("tools/list 超时")), 10000);
      p.on("error", (e) => done(reject, e));
      let buf = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 2) done(resolve, (m.result?.tools || []).map((x) => x.name));
        }
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }) + "\n");
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    });

  const def = await listTools({});
  const dev = await listTools({ AGENT_IN_CHROME_DEV: "1" });
  const off = await listTools({ AGENT_IN_CHROME_DEV: "0" });

  check("默认不注册 browser_reload_extension", !def.includes("browser_reload_extension"), JSON.stringify(def.filter((n) => /reload/.test(n))));
  check("默认工具表照常给出正常浏览工具", def.includes("browser_new_tab") && def.includes("browser_trace"), `${def.length} 个`);
  check("AGENT_IN_CHROME_DEV=1 时才注册 browser_reload_extension", dev.includes("browser_reload_extension"), JSON.stringify(dev.filter((n) => /reload/.test(n))));
  check("开发者工具是加法：默认那些一个不少", def.every((n) => dev.includes(n)) && dev.length === def.length + 1, `默认 ${def.length} / dev ${dev.length}`);
  check("AGENT_IN_CHROME_DEV=0 不算打开", !off.includes("browser_reload_extension"), JSON.stringify(off.filter((n) => /reload/.test(n))));
  check("工具名不重复", new Set(dev).size === dev.length, `${dev.length} 个名字，去重后 ${new Set(dev).size}`);

  fs.rmSync(TMP, { recursive: true, force: true });
}

{
  const st = freshState();
  const T = loadSw(st);
  check("扩展侧仍有 reload_extension 处理器", typeof T.reload_extension === "function");

  const r = await T.reload_extension();
  check("不再返回会被当成新版本的 version 字段", r.version === undefined, JSON.stringify(r));
  check("改叫 versionBefore，语义钉死在「重载前」", r.versionBefore === "0.12.0" || /^\d+\.\d+\.\d+$/.test(String(r.versionBefore)), JSON.stringify(r));
  check("note 说清了这个版本号是重载前的", /重载前的版本号/.test(r.note || ""), r.note);
  check("note 指路 browser_status 确认新版本", /browser_status/.test(r.note || ""), r.note);
  check("如实告知所有会话的标签页都会被放开", /所有会话/.test(r.note || ""), r.note);

  await new Promise((res) => setTimeout(res, 400));
  check("先回包、再真的调 chrome.runtime.reload", st.runtimeReloads.length === 1, String(st.runtimeReloads.length));
}

{
  const st = freshState();
  loadSw(st);
  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-reload" }, {}, (r) => (got = r));
  check("弹窗能触发重载", got?.reloading === true, JSON.stringify(got));
  check("弹窗回执里也是 versionBefore 而不是 version", got?.version === undefined && typeof got?.versionBefore === "string", JSON.stringify(got));
  check("回包先于重载（reload 一执行通道就断了）", st.runtimeReloads.length === 0, String(st.runtimeReloads.length));
  await new Promise((res) => setTimeout(res, 400));
  check("随后确实重载了", st.runtimeReloads.length === 1, String(st.runtimeReloads.length));
}

{
  const html = fs.readFileSync(path.join(ROOT, "extension", "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");
  const htmlW = html.match(/\bhtml\s*\{[^}]*?\bwidth:\s*(\d+)px/)?.[1];
  const bodyW = html.match(/\bbody\s*\{[^}]*?\bwidth:\s*(\d+)px/)?.[1];
  check("弹窗宽度钉在 html 上（只钉 body 会被 auto-resize 自锁在 800）", htmlW !== undefined, html.match(/\bhtml\s*\{[^}]*\}/)?.[0]);
  check("html 与 body 宽度一致", htmlW !== undefined && htmlW === bodyW, JSON.stringify({ htmlW, bodyW }));
  check("弹窗上有「重载扩展」按钮", /id="reload"/.test(html) && /重载扩展/.test(html));
  check("按钮接到了 popup-reload", /\$\("reload"\)\.addEventListener/.test(js) && /popup-reload/.test(js));
  check("弹窗显示版本号（确认重载生效的唯一信号）", /id="version"/.test(html) && /\$\("version"\)/.test(js));
  check("弹窗上有「打开 agent 窗口」按钮", /id="openwin"/.test(html) && /打开 agent 窗口/.test(html));
  check("按钮接到了 popup-open-agent-window", /\$\("openwin"\)\.addEventListener/.test(js) && /popup-open-agent-window/.test(js));
  check("没有专属窗口时按钮不出现", /openWin\.hidden/.test(js) && /agentWindow/.test(js));
  check("[hidden] 自己压一道 !important，否则 .opt 的 display:flex 会把它顶掉", /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(html));
  check("弹窗文案不再宣称建窗会切屏（实测已经不会了）", !/建的那一下[^）]*切一次屏/.test(html));
  check("待认领的组和遗留组在弹窗里分得开", /reclaimable\s*\?\s*"待认领"\s*:\s*"遗留"/.test(js));
  check("弹窗按会话分组", /t\.session/.test(js) && /groups/.test(js));
  check("弹窗用色点表达状态，不再用 emoji", /sdot/.test(js) && /sdot/.test(html) && !/🟢|🙋|💤/.test(js));
  check("色点颜色取自 SW 回报的组色", /GROUP_CSS\[first\.color\]/.test(js) && /--sc/.test(html));
  check(
    "异常态整卡染色，一个小 chip 在一列卡片里跳不出来",
    /\.sess\.bad/.test(html) && /\.sess\.warn/.test(html) && /first\.state === "failed"/.test(js)
  );
  check("休眠态在弹窗里说得出口，不是只有一个褪色的点", /chip dormant/.test(js) && /休眠/.test(js));
  check("弹窗用 chrome.tabs.get 补活数据", /chrome\.tabs\.get/.test(js));
  check("关闭所有标签页仍是二次确认", /再点一次/.test(js) && /armed/.test(js));
  check("弹窗不把页面数据拼进 innerHTML", !/innerHTML\s*=\s*[^"']*\$\{/.test(js) && !/innerHTML\s*\+=/.test(js));
  check("会话卡片有勾选手动接管入口", /rel-btn/.test(js) && /popup-hold-tabs/.test(js));
  check("接管中的页有交还出口和状态标记", /popup-unhold-tabs/.test(js) && /你接管中/.test(js) && /交给AI接管/.test(js));
  check("全局重置叫「解除全部托管」（词汇对齐图标 title 的「托管」）", /解除全部托管/.test(html));
  check("维护动作是常驻图标按钮，不再有「⋯」菜单", /icon-btn/.test(html) && !/id="more"/.test(html) && !/id="menu"/.test(html));
  check("重连是情境按钮：挂在状态行、默认隐藏、连接正常不出现", /id="reconnect" hidden/.test(html) && /\$\("reconnect"\)\.hidden = !!ok/.test(js));
  check("解除全部托管要点两次确认（图标化后误触面变大）", /releaseArmed/.test(js) && /再点一次确认：解除全部托管/.test(js));
  check("接管按钮带 tooltip", /rel\.title\s*=/.test(js) && /go\.title\s*=/.test(js) && /back\.title\s*=/.test(js));
  check(
    "全局操作按钮带 tooltip（图标按钮全靠悬浮说明）",
    /id="release" class="icon-btn"[^>]*\n?\s*title="/.test(html) && /id="closeall" class="danger" title="/.test(html) && /id="reload" class="icon-btn"[^>]*\n?\s*title="/.test(html)
  );
  check("Windows 拦截提示已移除", !/Windows 还不支持/.test(js) && !/isWindows\(\)/.test(js));
  check("等待名单入口也一并移除", !/agent-in-chrome\.liangai\.org\/windows/.test(js));
}

{
  const html = fs.readFileSync(path.join(ROOT, "extension", "about.html"), "utf8");
  for (const id of ["version", "extid", "state", "hostname", "updateLine"]) {
    check(`属性页有 id="${id}"`, new RegExp(`id="${id}"`).test(html));
  }
}

console.log("\n\x1b[1m点击校验：以真实事件目标为准\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("a", { id: "lnk", innerText: "去表单页", href: "/forms", box: [10, 10, 90, 20] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  check("attach 时装了见证回传用的绑定", (st.bindings || []).includes("__aicHit"), JSON.stringify(st.bindings));

  {
    const st3 = freshState();
    st3.page = makePage([el("button", { innerText: "x" })]);
    st3.cdpHang = (m) => m === "Runtime.addBinding";
    const T3 = loadSw(st3);
    const t0 = Date.now();
    const done = await Promise.race([
      T3.tab_use({ takeover: true, tabId: 1 }).then(() => "完成"),
      new Promise((r) => setTimeout(() => r("卡住"), 9000)),
    ]);
    check("attach 里有命令不回执时也不会卡死", done === "完成", `${done}（${Date.now() - t0}ms）`);
  }

  const f = await T.find({ query: "去表单页" });
  const ref = f.matches[0].ref;

  const ok = await T.click({ ref });
  check("事件落在目标上时判定 hit", ok.verified === "hit", JSON.stringify(ok));

  const markCall = st.cdp.find(
    (c) => c.method === "Runtime.callFunctionOn" && /addEventListener/.test(String(c.params?.functionDeclaration || ""))
  );
  check("见证监听器挂在目标元素自己身上", !!markCall && /this\.addEventListener/.test(markCall.params.functionDeclaration), JSON.stringify(!!markCall));
  check("监听器走捕获阶段（页面 stopPropagation 也拦不住）", !!markCall && /, true\)/.test(markCall.params.functionDeclaration));

  const again1 = await T.click({ ref });
  const again2 = await T.click({ ref });
  check("同一元素连点，见证每次都有效", again1.verified === "hit" && again2.verified === "hit", JSON.stringify([again1.verified, again2.verified]));
  const listenerAdds = st.cdp.filter(
    (c) => c.method === "Runtime.callFunctionOn" && /addEventListener/.test(String(c.params?.functionDeclaration || ""))
  );
  check("监听器不会越装越多（装一次、每次只更新记号）", listenerAdds.every((c) => /this\.__aicMark = m/.test(c.params.functionDeclaration)), String(listenerAdds.length));

  {
    const st4 = freshState();
    st4.page = makePage([el("button", { id: "b", innerText: "x", box: [10, 10, 60, 20] })]);
    st4.visibility = "hidden";
    let allowFocus = false;
    st4.cdpFail = (m) => {
      if (m !== "Emulation.setFocusEmulationEnabled") return null;
      if (!allowFocus) return "boom";
      st4.visibility = "visible";
      return null;
    };
    const T4 = loadSw(st4);
    await T4.tab_use({ takeover: true, tabId: 1 });
    st4.tabUpdates.length = 0;
    const bad = await throws(() => T4.click({ x: 20, y: 15 }), /收不到输入/);
    check("焦点模拟开不成时如实报错", bad.threw && bad.match, bad.msg);
    check("开不成也绝不抢前台", !st4.tabUpdates.some((u) => u.active === true), JSON.stringify(st4.tabUpdates));

    allowFocus = true;
    await T4.click({ x: 20, y: 15 });
    check("下一次调用会再试一遍，标签页没被判死", st4.cdp.some((c) => c.method === "Input.dispatchMouseEvent"), JSON.stringify(focusEmuCalls(st4)));
    check("重试成功就不抢前台", !st4.tabUpdates.some((u) => u.active === true), JSON.stringify(st4.tabUpdates));
  }

  st.dispatchHit = null;
  const nav = await (async () => {
    const p = T.click({ ref });
    setTimeout(() => {
      st.chrome.debugger.onEvent._fire({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "f0", url: "/forms" } });
      st.page = makePage([el("label", { innerText: "关键词", box: [10, 10, 90, 20] })]);
    }, 0);
    return p;
  })();
  check("点中并导航时不再误报 moved", nav.verified !== "moved", JSON.stringify(nav));
  check("而是如实说这一下生效了", nav.verified === "hit" || nav.verified === "navigated", JSON.stringify(nav));

  const st2 = freshState();
  st2.page = makePage([
    el("button", { id: "b", innerText: "目标", box: [10, 10, 80, 30] }),
    el("div", { id: "mask", innerText: "迟到的遮罩", box: [0, 0, 200, 100] }),
  ]);
  st2.noHitBinding = true;
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const f2 = await T2.find({ query: "目标" });
  st2.dispatchHit = () => st2.page.all.find((e) => e.id === "mask");
  const bad = await T2.click({ ref: f2.matches[0].ref, force: false }).catch((e) => ({ threw: String(e.message) }));
  check("没见证、没导航、点位被别人占了才报 moved", bad.verified === "moved" || /不可操作/.test(bad.threw || ""), JSON.stringify(bad));
}

console.log("\n\x1b[1m见证记号的清理与 force 的两条路对齐\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("input", { id: "agree", type: "checkbox", box: [10, 10, 20, 20], attrs: { "aria-label": "同意条款" } })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "同意条款" });
  const box = st.page.all.find((e) => e.id === "agree");
  st.cdp.length = 0;
  await T.set_value({ ref: f.matches[0].ref, value: true, force: true });

  check(
    "force 勾选之后页面上不留 data-aic-hit",
    !(box._attrs && box._attrs["data-aic-hit"]),
    JSON.stringify(box._attrs)
  );
  const cleared = st.cdp.filter((c) => c.method === "Runtime.evaluate" && /removeAttribute\('data-aic-hit'\)/.test(c.params?.expression || ""));
  check("清理那一趟真的发出去了（连见证监听器一起摘）", cleared.length === 1, String(cleared.length));
  check("清理用的是事后打上的那个记号，不是进来时的 null", /data-aic-hit="h[a-z0-9]+"/.test(cleared[0]?.params?.expression || ""), (cleared[0]?.params?.expression || "").slice(0, 90));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "折线以下", box: [10, 4000, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "折线以下" });
  st.cdp.length = 0;
  await T.click({ ref: f.matches[0].ref, force: true });
  check(
    "ref_b + force 也先滚进视口（否则同一个 force 在 ref_N 上滚、在 ref_b 上不滚）",
    st.cdp.some((c) => c.method === "DOM.scrollIntoViewIfNeeded"),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const st = freshState();
  const host = el("iframe", { id: "host", src: "https://ads.example.com/x", box: [0, 0, 400, 300] });
  st.page = makePage([el("button", { id: "b", innerText: "帧里的按钮", box: [10, 10, 100, 30] }), host]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "帧里的按钮" });
  const hostId = 1000 + flatEls(st.page).indexOf(host);

  const orig = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    const fn = String(params?.functionDeclaration || "");
    if (method === "Runtime.callFunctionOn" && /ownerDocument\.documentElement/.test(fn)) return cb({ result: { objectId: "docel" } });
    if (method === "DOM.describeNode" && params?.objectId === "docel") return cb({ node: { frameId: "F7" } });
    if (method === "Page.getFrameTree") return cb({ frameTree: { frame: { id: "F0" }, childFrames: [{ frame: { id: "F7" } }] } });
    if (method === "DOM.getFrameOwner" && params?.frameId === "F7") return cb({ backendNodeId: hostId });
    if (method === "Runtime.callFunctionOn" && /data-aic-hit/.test(fn) && /__aicSeen/.test(fn)) return cb({ result: { value: false } });
    return orig(src, method, params, cb);
  };

  await T.click({ ref: f.matches[0].ref }).catch(() => {});
  st.chrome.debugger.sendCommand = orig;
  check(
    "目标标不上但祖先 iframe 标上了，记号照样要清掉",
    !(host._attrs && host._attrs["data-aic-hit"]),
    JSON.stringify(host._attrs)
  );
}

{
  const st = freshState();
  loadSw(st);
  const compose = st.sandbox.__composeOffsets;
  const chainOf = st.sandbox.__chainOf;
  const frames = [
    { frameId: 0, isTop: true, viewport: { w: 1200, h: 800 }, got: [], childFrames: [{ tok: "tokA", x: 30, y: 40, w: 600, h: 400 }] },
    {
      frameId: 7,
      isTop: false,
      offset: { x: 30, y: 40, exact: true },
      viewport: { w: 600, h: 400 },
      got: ["tokA"],
      childFrames: [{ tok: "tokB", x: 10, y: 20, w: 300, h: 200 }],
    },
    { frameId: 8, isTop: false, offset: { exact: false }, viewport: { w: 300, h: 200 }, got: ["tokB"], childFrames: [] },
  ];
  const geo = compose(frames);
  check("跨源帧的顶层偏移仍然算得出", JSON.stringify(geo.offsets.get(8)) !== undefined && geo.offsets.get(8).x === 40 && geo.offsets.get(8).y === 60, JSON.stringify(geo.offsets.get(8)));
  const chain = chainOf(geo, 8);
  check("祖先链走满两层（同源那一层不再把链掐断）", chain.length === 2, JSON.stringify(chain));
  check("链的最后一段指向顶层里的那个 iframe 元素", chain[1] && chain[1].parent === 0 && chain[1].tok === "tokA", JSON.stringify(chain));
}

console.log("\n\x1b[1m截图准备失败：改过的浏览器状态一样要还原\x1b[0m");
{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f0 = await T.find({ query: "靶子" });
  await T.click({ ref: f0.matches[0].ref });
  st.cdp.length = 0;
  const origSend = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (method === "Runtime.evaluate" && /const STABILIZE = true/.test(params?.expression || "")) {
      st.cdp.push({ tabId: src.tabId, method, params });
      st.chrome.runtime.lastError = { message: "Cannot find context with specified id" };
      cb(undefined);
      st.chrome.runtime.lastError = undefined;
      return;
    }
    return origSend(src, method, params, cb);
  };
  const shot = await T.screenshot({});
  st.chrome.debugger.sendCommand = origSend;

  const focus = st.cdp.filter((c) => c.method === "Emulation.setFocusEmulationEnabled").map((c) => c.params.enabled);
  check("准备阶段先关掉了焦点模拟", focus[0] === false, JSON.stringify(focus));
  check("注入抛错后把焦点模拟开了回来", focus[focus.length - 1] === true, JSON.stringify(focus));
  check("动画也放回去了（rate=1 + 关掉 Animation 域）", st.cdp.some((c) => c.method === "Animation.setPlaybackRate" && c.params.playbackRate === 1) && st.cdp.some((c) => c.method === "Animation.disable"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("按不住也照常把图交出去", !!shot.image, JSON.stringify(Object.keys(shot)));

  st.cdp.length = 0;
  const f = await T.find({ query: "靶子" });
  const r = await T.click({ ref: f.matches[0].ref });
  check("截图失败之后这张页照样点得动", r.clicked !== undefined || r.verified !== undefined, JSON.stringify(r).slice(0, 120));
}

console.log("\n\x1b[1m截图 clip 的坐标系\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [100, 200, 80, 30] })]);
  st.scrollX = 0;
  st.scrollY = 1500;
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  st.cdp.length = 0;
  const r = await T.screenshot({ region: { x: 100, y: 200, width: 80, height: 30 } });
  const sent = st.cdp.find((c) => c.method === "Page.captureScreenshot")?.params?.clip;
  check("下发给 CDP 的 clip 加上了滚动量（页面坐标）", sent && sent.x === 100 && sent.y === 1700, JSON.stringify(sent));
  check("回报给调用方的 clip 仍是视口坐标", r.clip.x === 100 && r.clip.y === 200, JSON.stringify(r.clip));

  st.cdp.length = 0;
  const f = await T.find({ query: "靶子" });
  st.cdp.length = 0;
  const e = await T.screenshot({ ref: f.matches[0].ref });
  const sent2 = st.cdp.find((c) => c.method === "Page.captureScreenshot")?.params?.clip;
  check("ref 截图的 clip 也换算到页面坐标", sent2 && sent2.y === 200 - 4 + 1500, JSON.stringify(sent2));
  check("ref 截图回报的 clip 仍是视口坐标", e.clip.y === 200 - 4, JSON.stringify(e.clip));
  check("ref 截图前把元素滚进了视口", st.cdp.some((c) => c.method === "DOM.scrollIntoViewIfNeeded"), JSON.stringify(st.cdp.map((c) => c.method)));

  st.cdp.length = 0;
  await T.screenshot({ fullPage: true });
  const sent3 = st.cdp.find((c) => c.method === "Page.captureScreenshot")?.params?.clip;
  check("整页截图的 clip 不做换算（它本来就是页面坐标）", sent3 && sent3.x === 0 && sent3.y === 0, JSON.stringify(sent3));
}

console.log("\n\x1b[1m性能：往返次数\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "可以点的", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "可以点的" });
  st.cdp.length = 0;
  st.executed = [];
  await T.click({ ref: f.matches[0].ref });
  const n = (m) => st.cdp.filter((c) => c.method === m).length;
  check("ref_b 点击只量两次矩形", n("DOM.getContentQuads") === 2, String(n("DOM.getContentQuads")));
  check("元素描述和可访问名各只问一次", n("DOM.describeNode") === 1 && n("Accessibility.getPartialAXTree") === 1, `${n("DOM.describeNode")}/${n("Accessibility.getPartialAXTree")}`);
  check("不再有多余的 DOM.requestNode", n("DOM.requestNode") === 0, String(n("DOM.requestNode")));
  check("点击全程不注入内容脚本", (st.executed || []).length === 0, JSON.stringify(st.executed));
  const mouse = st.cdp.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params.type);
  check("三条鼠标事件仍按 移动→按下→抬起 的顺序发出", JSON.stringify(mouse) === JSON.stringify(["mouseMoved", "mousePressed", "mouseReleased"]), JSON.stringify(mouse));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const installs = () => st.cdp.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  check("attach 时把实现注册进去（一次）", installs().length === 1, String(installs().length));
  check("注册时带 runImmediately（当前这个文档也要立刻装上）", installs()[0]?.params?.runImmediately === true, JSON.stringify(installs()[0]?.params?.runImmediately));
  check("只在顶层文档定义（这个脚本每一帧都会跑）", /window === window\.top/.test(installs()[0]?.params?.source || ""), (installs()[0]?.params?.source || "").slice(0, 60));

  for (let i = 0; i < 5; i++) await T.click({ x: 20 + i, y: 20 });
  check("连点 5 次也不再注册第二次", installs().length === 1, String(installs().length));
  check("5 次动作都发到了页面上", (st.cursorCalls || []).filter((c) => c.op === "show").length >= 5, String((st.cursorCalls || []).length));
  const lens = st.cdp.filter((c) => c.method === "Runtime.evaluate" && /__aicCursor/.test(c.params?.expression || "")).map((c) => c.params.expression.length);
  check("每次的载荷都是短调用（几十字节，不是几千）", lens.every((l) => l < 300), JSON.stringify(lens));

  st.cursorDefined = false;
  st.cdp.length = 0;
  st.cursorCalls = [];
  await T.click({ x: 33, y: 44 });
  const evs = st.cdp.filter((c) => c.method === "Runtime.evaluate" && /__aicCursor/.test(c.params?.expression || ""));
  check("没装上时补发一次整份实现", evs.some((c) => /window\.__aicCursor = /.test(c.params.expression)), JSON.stringify(evs.map((c) => c.params.expression.length)));
  check("补完这一次的动作照样画出来了", (st.cursorCalls || []).some((c) => c.arg.x === 33 && c.arg.y === 44), JSON.stringify(st.cursorCalls));

  st.cdp.length = 0;
  st.chrome.runtime.onMessage._fire({ type: "popup-cursor", on: false }, {}, () => {});
  await new Promise((r) => setTimeout(r, 20));
  check("关掉时把注册摘掉", st.cdp.some((c) => c.method === "Page.removeScriptToEvaluateOnNewDocument"), JSON.stringify(st.cdp.map((c) => c.method)));
  check("关掉时把已经画出来的擦掉", st.cdp.some((c) => /getElementById\("__aic_cursor__"\)\?\.remove/.test(c.params?.expression || "")), JSON.stringify(st.cdp.map((c) => c.method)));
  check("擦除不顺手把实现补装回去", !st.cdp.some((c) => /window\.__aicCursor = /.test(c.params?.expression || "")), "擦除那一趟又把实现塞回去了");
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const inst = (st.initScripts || []).find((s) => /__aicCursor/.test(s.source));
  check("装机脚本里带 glow 调用（新文档创建即亮，导航后自动恢复）", /__aicCursor\("glow"/.test(inst?.source || ""), (inst?.source || "").slice(-200));
  check("光晕颜色是本会话的组底色（第一个会话轮到 blue）", /#1A73E8/i.test(inst?.source || ""), (inst?.source || "").slice(-200));
  check("装机脚本可能跑得比 documentElement 还早：失败要等 DOMContentLoaded 补一次", /DOMContentLoaded/.test(inst?.source || ""), (inst?.source || "").slice(-200));
  check("装机顺手把光标停靠出来（接管即可见，不等第一次点击）", /__aicCursor\("park"/.test(inst?.source || ""), (inst?.source || "").slice(-200));
  check("停靠态有怠速浮动且只在停靠态（.w.idle .a）", /\.w\.idle \.a\{animation/.test(inst?.source || "") && /idle: true/.test(inst?.source || ""), "");

  st.cursorDefined = false;
  st.cursorCalls = [];
  await T.click({ x: 21, y: 21 });
  check(
    "自愈补发的整份实现连光晕一起点亮（且颜色不变）",
    (st.cursorCalls || []).some((c) => c.op === "glow" && /#1A73E8/i.test(String(c.arg.color))),
    JSON.stringify(st.cursorCalls)
  );
  check("自愈那趟里真正的动作调用没有被 glow 挤掉", (st.cursorCalls || []).some((c) => c.op === "show" && c.arg.x === 21), JSON.stringify(st.cursorCalls));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://tt.example.com" }, "sTT");
  const inst = (st.initScripts || []).find((s) => /__aicCursor/.test(s.source));

  const SVGNS = "http://www.w3.org/2000/svg";
  const mkStyle = () => {
    const props = {};
    return {
      cssText: "",
      opacity: "",
      transition: "",
      display: "",
      setProperty: (k, v) => (props[k] = String(v)),
      getPropertyValue: (k) => props[k] || "",
    };
  };
  class El {
    constructor(tag, ns) {
      this.tagName = String(tag).toUpperCase();
      this.namespaceURI = ns || "http://www.w3.org/1999/xhtml";
      this.children = [];
      this.dataset = {};
      this.attrs = {};
      this.textContent = "";
      this.style = mkStyle();
      this.shadowRoot = null;
      this.offsetWidth = 0;
      this.parentNode = null;
      this._class = "";
    }
    get className() {
      return this.namespaceURI === SVGNS ? this.attrs.class || "" : this._class;
    }
    set className(v) {
      if (this.namespaceURI !== SVGNS) this._class = String(v);
    }
    get classList() {
      const self = this;
      return { contains: (c) => (" " + self.className + " ").includes(" " + c + " ") };
    }
    set innerHTML(_v) {
      throw new TypeError("Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
    }
    get innerHTML() {
      throw new TypeError("This document requires 'TrustedHTML' assignment.");
    }
    setAttribute(k, v) {
      this.attrs[String(k)] = String(v);
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    }
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    }
    remove() {
      const p = this.parentNode;
      if (p) p.children = p.children.filter((n) => n !== this);
      this.parentNode = null;
    }
    attachShadow() {
      const sr = new El("#shadow-root");
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    }
    querySelector(sel) {
      const m = /^([a-z]*)\.([\w-]+)$/i.exec(String(sel));
      if (!m) return null;
      const [, tag, cls] = m;
      const walk = (n) => {
        for (const c of n.children) {
          if ((!tag || c.tagName === tag.toUpperCase()) && (" " + c.className + " ").includes(" " + cls + " ")) return c;
          const d = walk(c);
          if (d) return d;
        }
        return null;
      };
      return walk(this);
    }
  }
  const byId = new Map();
  const root = new El("html");
  const doc = {
    documentElement: root,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t, ns),
    addEventListener: () => {},
  };
  const rootAppend = root.appendChild.bind(root);
  root.appendChild = (c) => {
    if (c.id) byId.set(c.id, c);
    return rootAppend(c);
  };
  const listeners = [];
  const sandbox = {
    document: doc,
    setTimeout: () => 0,
    clearTimeout: () => {},
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (n) => listeners.push(n),
    removeEventListener: () => {},
    Date,
    Math,
    Number,
    String,
    JSON,
    TypeError,
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  let threw = null;
  try {
    vm.runInNewContext(inst?.source || "", vm.createContext(sandbox), { timeout: 5000 });
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  check("Trusted Types 页上装机源码整段跑完（不再撞 innerHTML 汇聚点）", threw === null, String(threw));

  const host = byId.get("__aic_cursor__");
  check("Trusted Types 页上遮蔽宿主真的进了 DOM", !!host && host.parentNode === root, host ? "有宿主但没挂上" : "根本没有宿主");
  const sr = host && host.shadowRoot;
  check("shadow 里有样式（style 走 textContent，不是注入汇聚点）", !!(sr && sr.children.some((c) => c.tagName === "STYLE" && c.textContent.includes(":host{all:initial}"))), "");
  check("光晕层建了出来并且已点亮", !!(sr && sr.querySelector(".g") && sr.querySelector(".g").classList.contains("on")), sr ? String(sr.querySelector(".g") && sr.querySelector(".g").className) : "");
  check("光晕的四条边 + 基底 + 加亮层一个不少", !!(sr && sr.querySelector(".g") && sr.querySelector(".g").children.length === 6), sr ? String(sr.querySelector(".g")?.children.length) : "");
  check("护盾提示胶囊与光标层都在", !!(sr && sr.querySelector(".sh") && sr.querySelector(".w") && sr.querySelector(".r") && sr.querySelector(".t")), "");
  const svg = sr && sr.querySelector("svg.a");
  check("箭头是 SVG 命名空间的元素（createElementNS + setAttribute('class')）", !!svg && svg.namespaceURI === SVGNS, svg ? svg.namespaceURI : "找不到 svg.a");
  check("箭头带齐 viewBox / 宽高（尖端精度靠这几个属性）", !!svg && svg.getAttribute("viewBox") === "0 0 21 28" && svg.getAttribute("width") === "21" && svg.getAttribute("height") === "28", svg ? JSON.stringify(svg.attrs) : "");
  const p = svg && svg.children[0];
  check("箭头路径也在 SVG 命名空间，且第一个点就是尖端 (0,0)", !!p && p.namespaceURI === SVGNS && /^M0 0 /.test(p.getAttribute("d") || ""), p ? String(p.getAttribute("d")) : "没有 path");
  check("输入护盾跟着装上了（覆盖层在 = 接管中 = 真人输入拦下）", sandbox.__aicShieldOn === true && listeners.includes("keydown") && listeners.includes("click"), JSON.stringify({ on: sandbox.__aicShieldOn, n: listeners.length }));

  try {
    vm.runInNewContext(inst?.source || "", vm.createContext(sandbox), { timeout: 5000 });
  } catch {}
  check("再跑一遍装机不会建出第二个宿主", root.children.filter((c) => c.id === "__aic_cursor__").length === 1, String(root.children.length));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com" }, "sGlow");
  const inst = (st.initScripts || []).find((s) => /__aicCursor/.test(s.source));
  check(
    "new_tab 的光晕颜色是会话底色，不是「拿不到会话」的回落色",
    /"glow",\{"color":"#1A73E8"/i.test(inst?.source || ""),
    (inst?.source || "").slice(-200)
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.click({ x: 20, y: 20 });

  let held = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [1] }, {}, (r) => (held = r));
  await new Promise((r) => setTimeout(r, 20));
  check("接管回执", held?.ok === true && held.count === 1, JSON.stringify(held));
  check("接管即断调试器（黄条立刻消失）", st.detached.includes(1), JSON.stringify(st.detached));
  check(
    "断开时统一擦掉页面上的覆盖层（光标/光晕）",
    st.cdp.some((c) => /__aic_cursor__.*remove/.test(c.params?.expression || "")),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
  check("接管标记跟着 persist 落盘（SW 回收后仍然算数）", (st.storage["aic-sessions-v1"]?.humanHold || []).includes(1), JSON.stringify(st.storage["aic-sessions-v1"]?.humanHold));

  const tryCall = async (fn) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return String(e?.message || e);
    }
  };
  let err = await tryCall(() => T.click({ x: 20, y: 20 }));
  check("普通工具调用吃固定叫停语", /手动接管/.test(err || ""), err);
  check("叫停语说清这是硬停不是障碍（别重试别绕）", /不要重试/.test(err || "") && /不要开新页/.test(err || ""), err);
  check("叫停语给出唯一的重新认领路（takeover:true）", /takeover: true/.test(err || ""), err);
  err = await tryCall(() => T.close_tab({ tabId: 1 }));
  check("close_tab 不走 withTarget，也被闸住", /手动接管/.test(err || ""), err);
  err = await tryCall(() => T.tab_use({ tabId: 1 }));
  check("tab_use 不带 takeover 夺不回", /手动接管/.test(err || ""), err);
  err = await tryCall(() => T.cdp_raw({ method: "Runtime.evaluate", params: { expression: "1" }, tabId: 1 }));
  check("cdp_raw 走同一道目标解析闸，绕不开", /手动接管/.test(err || ""), err);

  let back = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-unhold-tabs", tabIds: [1] }, {}, (r) => (back = r));
  await new Promise((r) => setTimeout(r, 20));
  check("交还回执", back?.ok === true && back.count === 1, JSON.stringify(back));
  const installs = st.cdp.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  check("交还即重挂调试器（不等下一次调用）", installs.length >= 2, String(installs.length));
  check("光晕跟着状态自动回来（装机脚本带 glow）", /__aicCursor\("glow"/.test(installs.at(-1)?.params?.source || ""), (installs.at(-1)?.params?.source || "").slice(-160));
  const clicked = await T.click({ x: 20, y: 20 });
  check("交还后调用恢复正常", !!clicked, JSON.stringify(clicked).slice(0, 80));

  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [1] }, {}, () => {});
  await new Promise((r) => setTimeout(r, 20));
  const re = await T.tab_use({ tabId: 1, takeover: true });
  check("takeover:true 能重新认领接管中的页", re?.tabId === 1, JSON.stringify(re).slice(0, 80));
  check("认领后正常干活", !!(await T.click({ x: 20, y: 20 })));

  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [1] }, {}, () => {});
  await new Promise((r) => setTimeout(r, 20));
  const swept = await T.close_all({ scope: "session" });
  check("close_all 不关接管中的页（只释放归属）", !swept.closed.some((c) => c.tabId === 1) && swept.released.some((c) => c.tabId === 1), JSON.stringify(swept));
  const after = await tryCall(() => T.tab_use({ tabId: 1 }));
  check("释放后接管标记一并清掉（不挡下一个会话）", /静默征用/.test(after || "") && !/手动接管/.test(after || ""), after);
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  const nt = await T.tab_use({ takeover: true, tabId: 1 });

  const inst = (st.initScripts || []).find((s) => /__aicCursor/.test(s.source));
  check("装机点灯带上租期（页面侧 TTL 与 SW 侧同一个数）", /"ttl":150000/.test(inst?.source || ""), (inst?.source || "").slice(-200));
  check("挂上调试器就排续租心跳 alarm", (st.alarms || []).some((a) => a.name === "aic-overlay-lease"), JSON.stringify(st.alarms));

  st.cdp.length = 0;
  await T.click({ x: 20, y: 20 });
  check(
    "每次调用顺路续租（withTarget 发 lease 短调用）",
    st.cdp.some((c) => /__aicCursor\("lease"/.test(c.params?.expression || "")),
    JSON.stringify(st.cdp.filter((c) => c.method === "Runtime.evaluate").map((c) => c.params.expression.slice(0, 40)))
  );

  st.overlayGone = true;
  st.cdp.length = 0;
  await T.click({ x: 21, y: 21 });
  await new Promise((r) => setTimeout(r, 20));
  check(
    "续租发现宿主没了就重新点灯",
    st.cdp.some((c) => /window\.__aicCursor = /.test(c.params?.expression || "") && /"glow"/.test(c.params?.expression || "")),
    JSON.stringify(st.cdp.map((c) => (c.params?.expression || "").slice(0, 40)))
  );

  st.dbgTargets = [{ tabId: nt.tabId, attached: true, type: "page" }];
  st.cdp.length = 0;
  st.chrome.alarms.onAlarm._fire({ name: "aic-overlay-lease" });
  await new Promise((r) => setTimeout(r, 30));
  check(
    "心跳给挂着的页续租",
    st.cdp.some((c) => /__aicCursor\("lease"/.test(c.params?.expression || "")),
    JSON.stringify(st.cdp.map((c) => (c.params?.expression || "").slice(0, 40)))
  );
  st.dbgTargets = [];
  st.chrome.alarms.onAlarm._fire({ name: "aic-overlay-lease" });
  await new Promise((r) => setTimeout(r, 30));
  check("没有候选页时心跳自我了断", (st.alarmClears || []).includes("aic-overlay-lease"), JSON.stringify(st.alarmClears));

  st.dbgTargets = [{ tabId: nt.tabId, attached: true, type: "page" }];
  st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [nt.tabId] }, {}, () => {});
  await new Promise((r) => setTimeout(r, 30));
  st.cdp.length = 0;
  st.chrome.alarms.onAlarm._fire({ name: "aic-overlay-lease" });
  await new Promise((r) => setTimeout(r, 30));
  check(
    "接管中的页心跳不续租",
    !st.cdp.some((c) => /__aicCursor\("lease"/.test(c.params?.expression || "")),
    JSON.stringify(st.cdp.map((c) => (c.params?.expression || "").slice(0, 40)))
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const inst = (st.initScripts || []).find((s) => /__aicCursor/.test(s.source));
  check("屏蔽器随覆盖层装机（宿主一没就自我卸载）", /installShield/.test(inst?.source || "") && /__aicShieldOn/.test(inst?.source || ""), "");
  check("屏蔽器认放行窗（__aicPass）而不是事件属性", /__aicPass/.test(inst?.source || ""), "");

  {
    const listeners = [];
    const mkEl = (tag) => {
      const el = {
        tagName: String(tag || "div").toUpperCase(),
        dataset: {},
        style: { setProperty() {}, getPropertyValue: () => "" },
        className: "",
        textContent: "",
        offsetWidth: 0,
        children: [],
        setAttribute() {},
        appendChild(c) { el.children.push(c); return c; },
        remove() {},
        attachShadow() {
          el.shadowRoot = { children: [], querySelector: () => mkEl("div"), appendChild(c) { el.shadowRoot.children.push(c); return c; } };
          return el.shadowRoot;
        },
      };
      return el;
    };
    const byId = {};
    const doc = {
      documentElement: mkEl("html"),
      getElementById: (id) => byId[id] || null,
      createElement: (t) => mkEl(t),
      createElementNS: (_ns, t) => mkEl(t),
      addEventListener() {},
    };
    doc.documentElement.appendChild = (c) => { byId[c.id] = c; return c; };
    const win = { document: doc, addEventListener: (t, h) => listeners.push({ t, h }) };
    win.window = win;
    win.top = win;
    const boot = new Function("window", "document", "setTimeout", "clearTimeout",
      String(inst?.source || "") + "\nreturn window.__aicCursor;");
    const agent = boot(win, doc, () => 0, () => {});
    check("装机源码能真的跑起来（护盾这一段有得测）", typeof agent === "function" && listeners.length > 0,
      `agent=${typeof agent} listeners=${listeners.length}`);

    const fire = (type) => {
      const e = {
        type, isTrusted: true, target: doc.documentElement, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      for (const l of listeners) if (l.t === type) l.h(e);
      return e;
    };

    win.__aicPass = Date.now() + 900;
    check("窗开着时 agent 的输入照常放行", !fire("mousedown").prevented, "");

    win.__aicPass = Date.now() - 1370;
    const late = fire("pointerdown");
    check("窗过期但没被主动关掉时，迟到的自家输入不许被自家护盾吃掉", !late.prevented && !late.stopped, "");

    win.__aicPass = 0;
    const human = fire("mousedown");
    check("窗被主动关掉之后真人输入照旧当场拦下（敞口没变宽）", human.prevented && human.stopped, "");
    check("拦下了什么要留痕（__aicShieldAte，工具层靠它把静默失败变成准确报错）",
      win.__aicShieldAte && win.__aicShieldAte.n === 1 && win.__aicShieldAte.type === "mousedown",
      JSON.stringify(win.__aicShieldAte));

    win.__aicPass = Date.now() - 60000;
    check("迟到宽限有上限，过了就照拦", fire("mousedown").prevented, "");
  }
  check("拦下时的提示写明具体接管方法", /手动接管/.test(inst?.source || ""), "");

  st.cdp.length = 0;
  await T.click({ x: 20, y: 20 });
  const gateAt = st.cdp.findIndex((c) => /window\.__aicPass=/.test(c.params?.expression || ""));
  const inputAt = st.cdp.findIndex((c) => c.method === "Input.dispatchMouseEvent");
  check("每条 Input.* 之前先开放行窗", gateAt >= 0 && inputAt >= 0 && gateAt < inputAt, `gate@${gateAt} input@${inputAt}`);

  await T.click({ x: 22, y: 20 });
  const gates = st.cdp.filter((c) => /window\.__aicPass=/.test(c.params?.expression || ""));
  check("密集输入不重复开窗（900ms 窗口 + 300ms 续窗阈值）", gates.length === 1, String(gates.length));
}

{
  const st = freshState();
  loadSw(st);
  let got = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-config" }, {}, (r) => (got = r));
  await new Promise((r) => setTimeout(r, 10));
  const q = st.sent.find((m) => m.type === "config-get");
  check("popup-config 转成 config-get 发给 host", !!q && !!q.id);
  st.hostPort.onMessage._fire({ type: "config-result", id: q.id, ok: true, value: { tools: { profile: "observe", disable: [] } }, source: "file" });
  await new Promise((r) => setTimeout(r, 10));
  check("host 的应答按 id 关联递回弹窗", got?.ok === true && got.value.tools.profile === "observe");

  let saved = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-config", patch: { tools: { profile: "observe" } } }, {}, (r) => (saved = r));
  await new Promise((r) => setTimeout(r, 10));
  const w = st.sent.find((m) => m.type === "config-set");
  check("带 patch 时转成 config-set 且 patch 原样透传", w?.patch?.tools?.profile === "observe");
  st.hostPort.onMessage._fire({ type: "config-result", id: w.id, ok: true, value: { tools: { profile: "observe", disable: [] } } });
  await new Promise((r) => setTimeout(r, 10));
  check("写的应答也递回弹窗", saved?.ok === true);

  let a = null;
  let b = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-config" }, {}, (r) => (a = r));
  st.chrome.runtime.onMessage._fire({ type: "popup-config" }, {}, (r) => (b = r));
  await new Promise((r) => setTimeout(r, 10));
  const [qa, qb] = st.sent.filter((m) => m.type === "config-get").slice(-2);
  st.hostPort.onMessage._fire({ type: "config-result", id: qb.id, ok: true, value: { tools: { profile: "full", disable: [] } } });
  st.hostPort.onMessage._fire({ type: "config-result", id: qa.id, ok: false, error: "旧的" });
  await new Promise((r) => setTimeout(r, 10));
  check("并发请求的应答不串线", a?.ok === false && b?.ok === true, JSON.stringify({ a, b }));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.executed = [];
  const r = await T.click({ x: 60, y: 25 });
  check("裸坐标点击也不注入内容脚本", (st.executed || []).length === 0, JSON.stringify(st.executed));
  check("照样说得出打在了什么上面", /button/.test(r.hit || ""), JSON.stringify(r));
  const out = await throws(() => T.click({ x: 5000, y: 25 }), /落在视口之外/);
  check("视口外的坐标照样被拦下", out.threw && out.match, out.msg);
}

{
  const st = freshState();
  st.page = makePage([el("div", { innerText: "x" })], { selectorHit: ".ready" });
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  st.executed = [];
  const hit = await T.wait_for({ selector: ".ready", timeoutMs: 2000 });
  check("wait_for 照常命中", hit.matched === true, JSON.stringify(hit));
  check("一次注入都不做（以前每轮一次 chrome.scripting）", (st.executed || []).length === 0, JSON.stringify(st.executed));
  const evals = st.cdp.filter((c) => c.method === "Runtime.evaluate" && !/__aicCursor/.test(c.params?.expression || ""));
  check("整段等待只发一次求值", evals.length === 1, String(evals.length));
}

{
  let n = 0;
  const st = freshState({
    evalHook: () => {
      n++;
      return n < 3 ? { exceptionDetails: { exception: { description: "TypeError: x" } } } : { result: { value: 5 } };
    },
  });
  st.page = makePage([el("div", { innerText: "x" })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const r = await T.wait_for({ js: "var a = 1; a > 0", timeoutMs: 4000, pollMs: 10 });
  check("内联编译不过时退回老路，照样等得到", r.matched === true && r.jsValue === 5, JSON.stringify(r));
  check("退回之后 evals 仍然是老路那套计数", r.evals === 3, String(r.evals));
}

{
  const st = freshState();
  st.page = makePage([el("button", { innerText: "x", box: [0, 0, 10, 10] })]);
  st.cookieJar = [
    { name: "sid", value: "S1", domain: "example.com", path: "/", httpOnly: true, secure: true, session: true, expires: -1 },
    { name: "vis", value: "V1", domain: "example.com", path: "/", httpOnly: false, secure: false, expires: 4102444800 },
    { name: "other", value: "O1", domain: "other.test", path: "/", expires: 4102444800 },
  ];
  st.localStorage["aic-cookie-grant-example.com"] = { t: Date.now() };
  st.localStorage["aic-cookie-grant-other.test"] = { t: Date.now() };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const redacted = await T.cookies_export({});
  check("默认导出把 cookie 的 value 打码（不是真值）", redacted.cookies.every((c) => /^«已打码 \d+ 字符»$/.test(c.value)), JSON.stringify(redacted.cookies.map((c) => c.value)));
  check("打码后 value 里不含任何真凭据字符串", !JSON.stringify(redacted.cookies).includes("S1") && !JSON.stringify(redacted.cookies).includes("V1"), JSON.stringify(redacted.cookies.map((c) => c.value)));
  check("打码摘要报出真实长度", redacted.cookies.find((c) => c.name === "sid")?.value === "«已打码 2 字符»", redacted.cookies.find((c) => c.name === "sid")?.value);
  check("打码时 revealed 如实报 false", redacted.revealed === false, JSON.stringify(redacted.revealed));
  check("打码不影响统计（count/httpOnly 照旧）", redacted.count === 3 && redacted.httpOnly === 1, JSON.stringify({ count: redacted.count, httpOnly: redacted.httpOnly }));
  check("打码不动 value 以外的字段（name/domain 照旧）", redacted.cookies.find((c) => c.name === "sid")?.domain === "example.com");
  const revealed = await T.cookies_export({ revealSecrets: true });
  check("revealSecrets:true 回显真值", revealed.cookies.some((c) => c.name === "sid" && c.value === "S1"));
  check("revealSecrets:true 时 revealed 报 true", revealed.revealed === true, JSON.stringify(revealed.revealed));

  const exp = await T.cookies_export({ _internalReveal: true });
  check("导出走 CDP 原生 Storage.getCookies", st.cdp.some((c) => c.method === "Storage.getCookies"));
  check("导出全程一行注入都没有", !st.cdp.some((c) => c.method === "Runtime.evaluate" && /cookie/i.test(String(c.params?.expression || ""))));
  check("导出给出全部 cookie", exp.count === 3, JSON.stringify(exp.count));
  check("httpOnly 的也导得出来（它才是登录态本身）", exp.cookies.some((c) => c.name === "sid" && c.value === "S1"));
  check("_internalReveal 让 Node 侧拿到真值（非打码）", exp.cookies.every((c) => !/^«已打码/.test(c.value)), JSON.stringify(exp.cookies.map((c) => c.value)));
  check("统计里点明了有几条 session cookie", exp.sessionCookies === 1, JSON.stringify(exp.sessionCookies));
  const only = await T.cookies_export({ domains: ["example.com"], _internalReveal: true });
  check("按域名过滤得动", only.count === 2 && !only.cookies.some((c) => c.domain === "other.test"), JSON.stringify(only.count));

  const st2 = freshState();
  st2.page = makePage([el("button", { innerText: "x", box: [0, 0, 10, 10] })]);
  st2.cookieJar = [];
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const imp = await T2.cookies_import({ cookies: exp.cookies });
  check("导入走 CDP 原生 Storage.setCookies", st2.cdp.some((c) => c.method === "Storage.setCookies"));
  check("全部种上时如实报", imp.imported === 3 && imp.requested === 3 && !imp.missing, JSON.stringify(imp));
  check("导入后目标实例真的有了那份登录态", st2.cookieJar.some((c) => c.name === "sid" && c.value === "S1"), JSON.stringify(st2.cookieJar.map((c) => c.name)));
  check("httpOnly 属性跟着过去了", st2.cookieJar.find((c) => c.name === "sid")?.httpOnly === true);
  check("session cookie 仍然是 session cookie（expires 没被写实）", st2.cookieJar.find((c) => c.name === "sid")?.expires === -1);

  const st3 = freshState();
  st3.page = makePage([el("button", { innerText: "x", box: [0, 0, 10, 10] })]);
  st3.cookieJar = [];
  const T3 = loadSw(st3);
  await T3.tab_use({ takeover: true, tabId: 1 });
  const bad = await T3.cookies_import({
    cookies: [
      { name: "ok", value: "1", domain: "a.test", path: "/" },
      { name: "nosecure", value: "2", domain: "a.test", path: "/", sameSite: "None", secure: false },
      { name: "expired", value: "3", domain: "a.test", path: "/", expires: 1000 },
    ],
  });
  check("没种上的不许算进 imported", bad.imported === 1 && bad.requested === 3, JSON.stringify(bad));
  check("没种上的逐条点名", (bad.missing || []).map((m) => m.name).sort().join(",") === "expired,nosecure", JSON.stringify(bad.missing));
  check("并说清各自为什么没种上", /SameSite=None/.test(JSON.stringify(bad.missing)) && /过期/.test(JSON.stringify(bad.missing)), JSON.stringify(bad.missing));

  const jarNames = () => st2.cookieJar.map((c) => `${c.name}@${c.domain}`).sort().join(",");
  const before = st2.cookieJar.length;
  const scoped = await T2.cookies_import({ cookies: [{ name: "only", value: "z", domain: "z.test", path: "/" }], clearFirst: true });
  check("clearFirst 不再清空整个浏览器的 cookie", before === 3 && st2.cookieJar.length === 4, jarNames());
  check("clearFirst 不再走全局 Storage.clearCookies", !st2.cdp.some((c) => c.method === "Storage.clearCookies"), JSON.stringify(st2.cdp.filter((c) => /Cookies/.test(c.method)).map((c) => c.method)));
  check("payload 的域本来就没有旧行时如实报「一个都没清」", Array.isArray(scoped.clearedDomains) && scoped.clearedDomains.length === 0, JSON.stringify(scoped.clearedDomains));

  const wiped = await T2.cookies_import({ cookies: [{ name: "fresh", value: "F", domain: "example.com", path: "/" }], clearFirst: true });
  check("payload 涉及的域被清干净（同域旧行不留）", !st2.cookieJar.some((c) => c.domain === "example.com" && c.name !== "fresh"), jarNames());
  check("域外的 cookie 一条没动", st2.cookieJar.some((c) => c.domain === "other.test") && st2.cookieJar.some((c) => c.name === "only"), jarNames());
  check("清了哪些域要说出来", (wiped.clearedDomains || []).join(",") === "example.com", JSON.stringify(wiped.clearedDomains));
  check("clearFirst 仍如实回报自己开着", wiped.cleared === true, JSON.stringify(wiped.cleared));

  const empty = await throws(() => T2.cookies_import({ cookies: [] }), /需要 cookies/);
  check("没给 cookies 时明确报错，不是静悄悄什么都不做", empty.threw && empty.match, empty.msg);
}

const cookieState = (jar) => {
  const st = freshState();
  st.page = makePage([el("button", { innerText: "x", box: [0, 0, 10, 10] })]);
  st.cookieJar = jar;
  return st;
};
const JAR2 = [
  { name: "sid", value: "S1", domain: "a.test", path: "/", httpOnly: true, secure: true },
  { name: "tok", value: "T1", domain: "b.test", path: "/" },
];
const askKeys = (st) => Object.keys(st.localStorage).filter((k) => k.startsWith("aic-cookie-ask-")).sort();

{
  const st = cookieState(JAR2);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  const e1 = await throws(() => T.cookies_export({ domains: ["a.test"], revealSecrets: true }), /凭据借出被拒/);
  check("未授权域要明文（revealSecrets）当场被拒", e1.threw && e1.match, e1.msg);
  check("拒绝时点名了是哪个域", /a\.test/.test(e1.msg), e1.msg);
  check("拒绝时说清去哪授权（扩展弹窗）", /弹窗|扩展图标/.test(e1.msg) && /凭据借出/.test(e1.msg), e1.msg);
  check("拒绝时说清授权后原样重试即可", /原样重跑|重试/.test(e1.msg), e1.msg);
  check("拒绝时一个真值都没漏进错误文案里", !e1.msg.includes("S1"), e1.msg);

  const e2 = await throws(() => T.cookies_export({ domains: ["a.test"], _internalReveal: true }), /凭据借出被拒/);
  check("MCP 侧要真值落盘那条路（_internalReveal）同样被拒", e2.threw && e2.match, e2.msg);

  check("被拒时记了待授权", askKeys(st).includes("aic-cookie-ask-a.test"), JSON.stringify(askKeys(st)));
  check("待授权带上了这个域有几条 cookie（用户要据此决定）", st.localStorage["aic-cookie-ask-a.test"].n === 1, JSON.stringify(st.localStorage["aic-cookie-ask-a.test"]));

  const masked = await T.cookies_export({ domains: ["a.test"] });
  check("打码返回（reveal 为假）不被闸拦", masked.count === 1 && masked.revealed === false, JSON.stringify(masked.count));
  check("打码返回里确实没有真值", !JSON.stringify(masked.cookies).includes("S1"), JSON.stringify(masked.cookies));
}

{
  const st = cookieState(JAR2);
  st.localStorage["aic-cookie-grant-a.test"] = { t: Date.now() };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const e = await throws(() => T.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  check("部分未授权时仍然整个拒绝", e.threw && e.match, e.msg);
  check("只报没授权的那个（已授权的不再骚扰用户）", /b\.test/.test(e.msg) && !/a\.test/.test(e.msg), e.msg);
  check("待授权也只记没授权的那个", askKeys(st).join() === "aic-cookie-ask-b.test", JSON.stringify(askKeys(st)));

  check("拒绝文案说清了『列出来的每个域都要点』，不是点一个就行", /每一个域|都点过|都要点/.test(e.msg), e.msg);
  check("拒绝文案给出 domains 这条更省事的出路", /domains 参数点名/.test(e.msg), e.msg);

  const st2 = cookieState(JAR2);
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  await throws(() => T2.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  st2.localStorage["aic-cookie-grant-a.test"] = { t: Date.now() };
  const partial = await throws(() => T2.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  check("只授权其中一个域之后原样重跑，仍然被拒（一条 cookie 都不漏）", partial.threw && partial.match, partial.msg);
  check("而且这一次报错里也带着 domains 这条出路", /domains 参数点名/.test(partial.msg), partial.msg);
  check("拒绝时一个真值都没漏进文案", !partial.msg.includes("T1"), partial.msg);
}

{
  const st = cookieState([
    { name: "sid", value: "S1", domain: ".example.com", path: "/" },
    { name: "api", value: "A1", domain: "api.example.com", path: "/" },
  ]);
  st.localStorage["aic-cookie-grant-example.com"] = { t: Date.now() };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const ok = await T.cookies_export({ revealSecrets: true });
  check("授权之后放行，拿得到真值", ok.cookies.some((c) => c.value === "S1"), JSON.stringify(ok.cookies.map((c) => c.name)));
  check("`.example.com` 和 `example.com` 算同一个域（前导点不算另一件事）", ok.count === 2, JSON.stringify(ok.count));
  check("父域的授权覆盖子域 api.example.com", ok.cookies.some((c) => c.value === "A1"), JSON.stringify(ok.cookies.map((c) => c.domain)));
  check("放行时不留待授权残渣", askKeys(st).length === 0, JSON.stringify(askKeys(st)));

  const st2 = cookieState(JAR2);
  st2.localStorage["aic-cookie-grant-a.test"] = { t: Date.now() - 31 * 24 * 3600 * 1000 };
  const T2 = loadSw(st2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const ex = await throws(() => T2.cookies_export({ domains: ["a.test"], revealSecrets: true }), /凭据借出被拒/);
  check("30 天前的授权已过期，按没授权处理", ex.threw && ex.match, ex.msg);
}

{
  const st = cookieState(JAR2);
  st.localStorage["aic-cookie-grant-a.test"] = { t: Date.now() };
  const ch = makeChrome(st);
  ch.storage.local.get = async () => {
    throw new Error("storage 挂了");
  };
  const T = loadSw(st, ch);
  await T.tab_use({ takeover: true, tabId: 1 });
  const e = await throws(() => T.cookies_export({ domains: ["a.test"], revealSecrets: true }), /凭据借出被拒/);
  check("storage 读不到时按拒绝处理（失败关闭，不是失败开放）", e.threw && e.match, e.msg);
}

{
  const st = cookieState(JAR2);
  const ch = makeChrome(st);
  ch.runtime.id = "aic-cli";
  const T = loadSw(st, ch);
  await T.tab_use({ takeover: true, tabId: 1 });
  const ok = await T.cookies_export({ revealSecrets: true });
  check("CLI shim 上不挂这道闸（没有弹窗可点）", ok.cookies.some((c) => c.value === "S1"), JSON.stringify(ok.count));
  check("放行也不该顺手记待授权（那边没人看得到）", askKeys(st).length === 0, JSON.stringify(askKeys(st)));

  const st2 = cookieState(JAR2);
  const ch2 = makeChrome(st2);
  ch2.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
  const T2 = loadSw(st2, ch2);
  await T2.tab_use({ takeover: true, tabId: 1 });
  const e = await throws(() => T2.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  check("不是那个哨兵 id 就当真扩展，照拦（失败方向朝拒绝）", e.threw && e.match, e.msg);

  const shim = fs.readFileSync(path.join(ROOT, "mcp", "cdp", "chrome-shim.mjs"), "utf8");
  check('CLI shim 仍然自报 runtime.id = "aic-cli"（闸的判据靠它）', /id:\s*"aic-cli"/.test(shim));
}

{
  const st = cookieState([
    { name: "a", value: "A", domain: "shop.com", path: "/" },
    { name: "b", value: "B", domain: "mail.com", path: "/" },
  ]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const e = await throws(() => T.cookies_export({ domains: ["com"], revealSecrets: true }), /凭据借出被拒/);
  check("domains:['com'] 伪装不了：报的是真实的那几个域", /shop\.com/.test(e.msg) && /mail\.com/.test(e.msg), e.msg);
  check("待授权记的也是真实的域，不是 'com'", askKeys(st).join() === "aic-cookie-ask-mail.com,aic-cookie-ask-shop.com", JSON.stringify(askKeys(st)));
}

{
  const many = [];
  for (let i = 0; i < 13; i++) many.push({ name: "c" + i, value: "V" + i, domain: `d${i}.test`, path: "/" });
  const st = cookieState(many);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const e = await throws(() => T.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  check("一次申请 13 个域被拒", e.threw && e.match, e.msg);
  check("并说清上限和该怎么办（用 domains 点名）", /上限 12/.test(e.msg) && /domains/.test(e.msg), e.msg);
  check("超上限时一条待授权都不记", askKeys(st).length === 0, JSON.stringify(askKeys(st)));
}

{
  const st = cookieState(JAR2);
  const T = loadSw(st);
  const S = st.sandbox;
  check("认得出受限 gTLD .bank", S.__isSensitiveCookieDomain("hometown.bank") === true);
  check("认得出整段标签 banking", S.__isSensitiveCookieDomain("onlinebanking.example.com") === true);
  check("认得出无歧义品牌 paypal", S.__isSensitiveCookieDomain("www.paypal.com") === true);
  check("不做子串匹配：databank.example 不是银行", S.__isSensitiveCookieDomain("databank.example") === false);
  check("不做子串匹配：bankofexampleblog.com 不是银行", S.__isSensitiveCookieDomain("bankofexampleblog.com") === false);
  check("普通站点不误判", ["github.com", "example.com", "news.ycombinator.com", "xiaohongshu.com"].every((d) => S.__isSensitiveCookieDomain(d) === false));

  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-cookie-gate", action: "allow", domain: "my.bank" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 20));
  check("敏感域点「允许」也只写成一次性票", !("aic-cookie-grant-my.bank" in st.localStorage) && "aic-cookie-once-my.bank" in st.localStorage, JSON.stringify(Object.keys(st.localStorage)));
  check("面板把它标成敏感域", (r?.onceGrants || []).some((g) => g.domain === "my.bank"), JSON.stringify(r));
}

{
  const st = cookieState([{ name: "s", value: "S", domain: "my.bank", path: "/" }]);
  st.localStorage["aic-cookie-once-my.bank"] = { t: Date.now() };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const ok = await T.cookies_export({ revealSecrets: true });
  check("一次性票放行这一次", ok.cookies.some((c) => c.value === "S"));
  check("用掉即销", !("aic-cookie-once-my.bank" in st.localStorage), JSON.stringify(Object.keys(st.localStorage)));
  const again = await throws(() => T.cookies_export({ revealSecrets: true }), /凭据借出被拒/);
  check("下一次又要重新点（这才叫「不给记住」）", again.threw && again.match, again.msg);
}

{
  const st = freshState();
  const T = loadSw(st);
  const now = Date.now();
  for (let i = 0; i < 30; i++) st.localStorage[`aic-cookie-ask-x${i}.test`] = { t: now - i * 1000 };
  st.localStorage["aic-cookie-ask-old.test"] = { t: now - 40 * 60 * 1000 };
  for (let i = 0; i < 60; i++) st.localStorage[`aic-cookie-grant-g${i}.test`] = { t: now - i * 1000 };
  st.localStorage["aic-cookie-grant-ancient.test"] = { t: now - 31 * 24 * 3600 * 1000 };
  st.localStorage["aic-cookie-once-stale.test"] = { t: now - 10 * 60 * 1000 };
  st.localStorage["aic-our-1"] = 1;
  await st.sandbox.__pruneCookieGate();
  const left = (p) => Object.keys(st.localStorage).filter((k) => k.startsWith(p)).length;
  check("待授权压到上限 20 条以内", left("aic-cookie-ask-") <= 20, String(left("aic-cookie-ask-")));
  check("过期的待授权被清掉", !("aic-cookie-ask-old.test" in st.localStorage));
  check("留下的是最近的那些（按时刻淘汰最旧的）", "aic-cookie-ask-x0.test" in st.localStorage && !("aic-cookie-ask-x29.test" in st.localStorage));
  check("长期名单压到上限 50 个以内", left("aic-cookie-grant-") <= 50, String(left("aic-cookie-grant-")));
  check("过期的长期授权被清掉", !("aic-cookie-grant-ancient.test" in st.localStorage));
  check("过期的一次性票被清掉", !("aic-cookie-once-stale.test" in st.localStorage));
  check("不碰别人的账本（aic-our-*）", st.localStorage["aic-our-1"] === 1);

  const st2 = freshState();
  st2.localStorage["aic-cookie-ask-gone.test"] = { t: Date.now() - 40 * 60 * 1000 };
  const T2 = loadSw(st2);
  await T2.status({}, "s1");
  await new Promise((res) => setTimeout(res, 30));
  check("SW 冷启动的家务会顺手清一遍（不用等定时器）", !("aic-cookie-ask-gone.test" in st2.localStorage), JSON.stringify(Object.keys(st2.localStorage)));
}

{
  const st = cookieState(JAR2);
  st.localStorage["aic-cookie-ask-a.test"] = { t: Date.now(), n: 1, a: "Claude Code", l: "查订单" };
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });

  let r = null;
  st.chrome.runtime.onMessage._fire({ type: "popup-cookie-gate" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 20));
  check("面板列得出待授权", (r?.asks || []).some((a) => a.domain === "a.test" && a.n === 1), JSON.stringify(r?.asks));
  check("面板带上「谁在申请、做什么任务」", r.asks[0].agent === "Claude Code" && r.asks[0].label === "查订单", JSON.stringify(r.asks[0]));

  st.chrome.runtime.onMessage._fire({ type: "popup-cookie-gate", action: "allow", domain: "a.test" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 20));
  check("点「允许」之后进长期名单", (r?.grants || []).some((g) => g.domain === "a.test"), JSON.stringify(r?.grants));
  check("点完待授权那条就消失（不留下一个点了没反应的按钮）", (r?.asks || []).length === 0, JSON.stringify(r?.asks));
  const after = await T.cookies_export({ domains: ["a.test"], revealSecrets: true });
  check("授权之后同样的调用真的通了", after.cookies.some((c) => c.value === "S1"), JSON.stringify(after.count));

  st.localStorage["aic-cookie-ask-google.com"] = { t: Date.now(), n: 2 };
  st.localStorage["aic-cookie-ask-mail.google.com"] = { t: Date.now(), n: 3 };
  st.localStorage["aic-cookie-ask-notgoogle.com"] = { t: Date.now(), n: 1 };
  st.chrome.runtime.onMessage._fire({ type: "popup-cookie-gate", action: "allow", domain: "google.com" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 20));
  check("授权父域时，它覆盖的子域待授权一起划掉", !("aic-cookie-ask-mail.google.com" in st.localStorage), JSON.stringify(askKeys(st)));
  check("名字长得像但不是子域的（notgoogle.com）不受影响", "aic-cookie-ask-notgoogle.com" in st.localStorage, JSON.stringify(askKeys(st)));

  st.chrome.runtime.onMessage._fire({ type: "popup-cookie-gate", action: "revoke", domain: "a.test" }, {}, (x) => (r = x));
  await new Promise((res) => setTimeout(res, 20));
  check("撤销之后名单里没了", !(r?.grants || []).some((g) => g.domain === "a.test"), JSON.stringify(r?.grants));
  const back = await throws(() => T.cookies_export({ domains: ["a.test"], revealSecrets: true }), /凭据借出被拒/);
  check("撤销之后又回到默认拒绝", back.threw && back.match, back.msg);
}

{
  const NEEDLE = "const missing = needed.filter((d) => !byGrant(d) && !byOnce(d));";
  const src = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  check("【变异守卫】找得到「默认拒绝」那一行（改名了就等于守卫失效，必须报出来）", src.includes(NEEDLE), NEEDLE);

  const st = cookieState(JAR2);
  const T = loadSw(st, undefined, (s) => s.replace(NEEDLE, "const missing = [];"));
  await T.tab_use({ takeover: true, tabId: 1 });
  let leaked = false;
  try {
    const r = await T.cookies_export({ domains: ["a.test"], revealSecrets: true });
    leaked = r.cookies.some((c) => c.value === "S1");
  } catch {}
  check("【变异守卫】改成默认放行后，未授权的真值确实漏了出去（证明上面那些断言盯的就是这一行）", leaked === true);
}

{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const mf = JSON.parse(read("../extension/manifest.json")).version;
  const grab = (src) => (src.match(/^const VERSION = "([^"]+)";/m) || [])[1];
  const sw = grab(read("../extension/sw.js"));
  const srv = grab(read("../mcp/server.mjs"));
  const pkg = JSON.parse(read("../package.json")).version;
  const plug = JSON.parse(read("../.claude-plugin/plugin.json")).version;
  check("manifest.json 里有版本号", !!mf, String(mf));
  check("sw.js 的 VERSION 与 manifest 一致", sw === mf, `sw=${sw} manifest=${mf}`);
  check("server.mjs 的 VERSION 与 manifest 一致", srv === mf, `server=${srv} manifest=${mf}`);
  check("package.json 的版本与 manifest 一致", pkg === mf, `package=${pkg} manifest=${mf}`);
  check("plugin.json 的版本与 manifest 一致", plug === mf, `plugin=${plug} manifest=${mf}`);
}

{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const pkgName = JSON.parse(read("../package.json")).name;
  const extPkg = (read("../extension/update-check.js").match(/^\s*const PKG = "([^"]+)";/m) || [])[1];
  const noticePkg = (read("../mcp/update-notice.mjs").match(/^export const PKG = "([^"]+)";/m) || [])[1];
  const noticeBin = (read("../mcp/update-notice.mjs").match(/^export const BIN = "([^"]+)";/m) || [])[1];
  check("extension/update-check.js 里抠得出 PKG 常量", !!extPkg, String(extPkg));
  check("extension/update-check.js 的 PKG 与 package.json 的 name 一致", extPkg === pkgName, `ext=${extPkg} package=${pkgName}`);
  check("mcp/update-notice.mjs 的 PKG 与 package.json 的 name 一致", noticePkg === pkgName, `notice=${noticePkg} package=${pkgName}`);
  check("BIN 就是 package.json 的 bin 键，且不带 scope", noticeBin === Object.keys(JSON.parse(read("../package.json")).bin)[0] && !String(noticeBin).includes("/"), String(noticeBin));
  check(
    "native host 名没变（改了 = 已装用户的浏览器再也找不到 host）",
    read("../scripts/install.mjs").includes('const HOST_NAME = "org.liangai.agent_in_chrome";')
  );
  check(
    "MCP 配置里那个键没变（改了 = 卸载摘不掉旧条目、同一个 server 挂两遍）",
    read("../scripts/install.mjs").includes('const MCP_NAME = "agent-in-chrome";') &&
      read("../scripts/agents.mjs").includes('const MCP_NAME = "agent-in-chrome";')
  );
  check(
    "数据目录没变（改了 = 令牌、留痕、扩展稳定副本全部失联）",
    read("../scripts/install.mjs").includes('path.join(HOME, ".agent-in-chrome")')
  );
}

{
  const { STARTUP_BUDGET_MS, BRIDGE_GRACE_MS } = await import("../mcp/cdp/browser-launch.mjs");
  check("启动预算是个正数", STARTUP_BUDGET_MS > 0, String(STARTUP_BUDGET_MS));
  check(
    "等桥接的宽限严格大于启动预算",
    BRIDGE_GRACE_MS > STARTUP_BUDGET_MS,
    `宽限 ${BRIDGE_GRACE_MS}ms vs 预算 ${STARTUP_BUDGET_MS}ms`
  );
  check(
    "宽限至少比预算多留两成余量",
    BRIDGE_GRACE_MS >= STARTUP_BUDGET_MS * 1.2,
    `宽限 ${BRIDGE_GRACE_MS}ms vs 预算 ${STARTUP_BUDGET_MS}ms`
  );
  check("宽限仍明显小于 MCP 的 60s 调用超时", BRIDGE_GRACE_MS < 55_000, `${BRIDGE_GRACE_MS}ms`);
}

console.log("\n\x1b[1m性能：并行化之后的往返段数\x1b[0m");
function batchMeter(st) {
  const orig = st.chrome.debugger.sendCommand;
  const batches = [];
  let cur = null;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (!cur) {
      cur = [];
      batches.push(cur);
      setTimeout(() => {
        cur = null;
      }, 0);
    }
    cur.push(method);
    orig(src, method, params, (...a) => setTimeout(() => cb(...a), 0));
  };
  return {
    batches,
    stop: () => {
      st.chrome.debugger.sendCommand = orig;
    },
  };
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "靶子" });
  await T.click({ ref: f.matches[0].ref });

  const m = batchMeter(st);
  await T.screenshot({});
  m.stop();
  const prep = m.batches.filter((b) => b.some((x) => x.startsWith("Emulation.") || x.startsWith("Animation.")));
  check(
    "关焦点模拟和停动画在同一段里发出（原来是两段串行）",
    prep[0].includes("Emulation.setFocusEmulationEnabled") && prep[0].includes("Animation.enable"),
    JSON.stringify(prep.slice(0, 3))
  );
  const restore = prep[prep.length - 1];
  check(
    "收尾的还原也在同一段里发出",
    restore.includes("Emulation.setFocusEmulationEnabled") && restore.includes("Animation.setPlaybackRate") && restore.includes("Animation.disable"),
    JSON.stringify(restore)
  );
  check("准备+收尾一共只剩 3 段串行（原来 6 段）", prep.length === 3, JSON.stringify(prep));
  const seq = m.batches.flat().filter((x) => x.startsWith("Emulation.") || x.startsWith("Animation."));
  check(
    "并发不等于乱序：仍是「关焦点→停动画→…→开焦点→放动画→关域」",
    JSON.stringify(seq) ===
      JSON.stringify([
        "Emulation.setFocusEmulationEnabled",
        "Animation.enable",
        "Animation.setPlaybackRate",
        "Emulation.setFocusEmulationEnabled",
        "Animation.setPlaybackRate",
        "Animation.disable",
      ]),
    JSON.stringify(seq)
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  const f = await T.find({ query: "靶子" });

  const m = batchMeter(st);
  await T.click({ ref: f.matches[0].ref });
  m.stop();
  const treeAt = m.batches.findIndex((b) => b.includes("Page.getFrameTree"));
  check("帧树那一趟和节点解析同一段发出（原来白串一次往返）", treeAt >= 0 && m.batches[treeAt].length > 1, JSON.stringify(m.batches[treeAt]));
  check("帧树和 DOM.resolveNode 是同一段", m.batches[treeAt].includes("DOM.resolveNode"), JSON.stringify(m.batches[treeAt]));
}

{
  const st = freshState();
  const items = [];
  for (let i = 0; i < 40; i++) items.push(el("button", { id: "b" + i, innerText: "按钮" + i, box: [0, i * 20, 80, 18] }));
  st.page = makePage(items);
  let rects = 0;
  for (const e of st.page.all) {
    const orig = e.getBoundingClientRect.bind(e);
    e.getBoundingClientRect = () => {
      rects++;
      return orig();
    };
  }
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  rects = 0;
  const snap = await T.read_page({});
  check("40 个候选都收进来了", snap.elements.length === 40, String(snap.elements.length));
  check("每个候选只量一次矩形（原来 80 次）", rects === 40, `量了 ${rects} 次`);
}

{
  const st = freshState();
  const iframeEl = el("iframe", { id: "x", src: "https://other.example/x", box: [200, 300, 400, 150] });
  st.page = makePage([iframeEl, el("div", { id: "mask", innerText: "遮罩", box: [0, 0, 1200, 800] })]);
  const child = makePage([el("button", { id: "xin", innerText: "跨源帧内按钮", box: [10, 10, 100, 40] })], {
    url: "https://other.example/x",
  });
  nestFrame(st.page, iframeEl, child, { sameOrigin: false });
  st.subFrames = [{ frameId: 9, page: child }];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  await T.read_page({});

  const origExec = st.chrome.scripting.executeScript;
  const batches = [];
  let cur = null;
  st.chrome.scripting.executeScript = async (opts) => {
    if (!cur) {
      cur = [];
      batches.push(cur);
      setTimeout(() => {
        cur = null;
      }, 0);
    }
    cur.push(`${opts.args?.[0]}${opts.args?.[1]?.clear ? ":clear" : ""}`);
    const r = await origExec(opts);
    await new Promise((s2) => setTimeout(s2, 0));
    return r;
  };
  await T.click({ ref: "ref_1@f9" }).catch(() => {});
  st.chrome.scripting.executeScript = origExec;

  const clears = batches.filter((b) => b.some((x) => x.endsWith(":clear")));
  check("清记号的两趟注入在同一段里发出（原来一帧一段）", clears.length === 1 && clears[0].filter((x) => x.endsWith(":clear")).length === 2, JSON.stringify(batches));
}

console.log("\n\x1b[1m光标开关：心跳与注册的收口\x1b[0m");
{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  check("attach 时建了心跳 alarm", (st.alarms || []).some((a) => a.name === "aic-overlay-lease"), JSON.stringify(st.alarms));

  st.chrome.runtime.onMessage._fire({ type: "popup-cursor", on: false }, {}, () => {});
  await new Promise((r) => setTimeout(r, 20));
  st.alarms = [];
  st.chrome.runtime.onMessage._fire({ type: "popup-cursor", on: true }, {}, () => {});
  await new Promise((r) => setTimeout(r, 20));
  check("重新打开开关时把心跳 alarm 建回来", (st.alarms || []).some((a) => a.name === "aic-overlay-lease"), JSON.stringify(st.alarms));
  check("周期仍是 1 分钟（租期 = 2.5 × 心跳）", (st.alarms || [])[0]?.info?.periodInMinutes === 1, JSON.stringify(st.alarms));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 80, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 });
  st.cdp.length = 0;
  const install = st.sandbox.__installCursorScript;
  await Promise.all([install(1), install(1), install(1)]);
  const n = st.cdp.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length;
  check("并发注册只发一次（不留摘不掉的注册）", n === 0, `又注册了 ${n} 次`);

  st.sandbox.__perTabTables().cursorScripts.delete(1);
  st.cdp.length = 0;
  await Promise.all([install(1), install(1), install(1)]);
  const m = st.cdp.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length;
  check("三条并发路进来也只注册一份", m === 1, `注册了 ${m} 次`);
  check("在途表用完就清空，不按标签页泄漏", st.sandbox.__perTabTables().cursorInstalling.size === 0, String(st.sandbox.__perTabTables().cursorInstalling.size));
}

console.log("\n\x1b[1m报文体内存预算\x1b[0m");
{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://upload.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };

  const BIG = "x".repeat(200_000);
  for (let i = 0; i < 60; i++) {
    st.postDatas[`big-${i}`] = BIG;
    ev._fire(src, "Network.requestWillBeSent", {
      requestId: `big-${i}`,
      type: "XHR",
      timestamp: 100 + i,
      request: { method: "POST", url: `https://upload.example.com/p/${i}`, headers: {}, postData: BIG, hasPostData: true },
    });
  }
  await new Promise((r) => setTimeout(r, 20));

  const oldest = await T.request_detail({ tabId: tab.tabId, requestId: "big-0", maxBody: 500_000 }, "s1");
  const newest = await T.request_detail({ tabId: tab.tabId, requestId: "big-59", maxBody: 500_000 }, "s1");
  check("最新那条的请求体还在", String(newest.requestBody || "").length > 0);
  check(
    "被腾掉的老条目仍然取得回请求体（腾掉的是缓存，不是记录）",
    String(oldest.requestBody || "").length === 200_000,
    `拿到 ${String(oldest.requestBody || "").length} 字符`
  );
  check("requestId 仍然有效，没被整条删掉", oldest.url === "https://upload.example.com/p/0", oldest.url);

  const used = st.sandbox.__bodyBytesUsed(tab.tabId);
  check("请求体也计入预算（原来一个字节都不算）", used > 0, String(used));
  check("超预算之后总量被腾回上限之内", used <= st.sandbox.__BODY_BUDGET, `用了 ${used} / 上限 ${st.sandbox.__BODY_BUDGET}`);
}

console.log("\n\x1b[1m标签页没了：按标签页的表全部归零\x1b[0m");
{
  const st = freshState();
  const T = loadSw(st);
  const opened = [];
  for (let i = 0; i < 6; i++) opened.push(await T.new_tab({ url: `https://x.example.com/${i}` }, "s1"));
  const tabIds = opened.map((t) => t.tabId);

  const before = st.sandbox.__perTabTables();
  check("开完页之后 ourTabs 确实记着这几张（不然下面归零就是假的）", before.ourTabs.size === tabIds.length, `ourTabs=${before.ourTabs.size}`);

  await T.close_tab({ tabId: tabIds[0] }, "s1");
  await T.close_tab({ tabId: tabIds[1] }, "s1");
  for (const id of tabIds.slice(2)) st.chrome.tabs.onRemoved._fire(id, { windowId: 10, isWindowClosing: false });
  await new Promise((r) => setTimeout(r, 20));

  const tables = st.sandbox.__perTabTables();
  const leftovers = Object.entries(tables)
    .map(([name, t]) => [name, tabIds.filter((id) => (t.has ? t.has(id) : false))])
    .filter(([, ids]) => ids.length);
  check(
    "关掉的标签页在每一张按标签页的表里都查不到了",
    leftovers.length === 0,
    leftovers.map(([n, ids]) => `${n} 还剩 ${ids.length} 条`).join("；")
  );

  await st.sandbox.__persist();
  const saved = st.storage["aic-sessions-v1"] || {};
  const savedOurTabs = saved.ourTabs || [];
  check(
    "storage.session 里也不再留着这些死 id（SW 回收后不会被 restore 复活）",
    tabIds.every((id) => !savedOurTabs.includes(id)),
    `存档里还有 ${savedOurTabs.length} 条：${JSON.stringify(savedOurTabs)}`
  );

  const T2 = loadSw(freshState());
  const sids = [];
  for (let i = 0; i < 8; i++) {
    const sid = `sub-${i}`;
    sids.push(sid);
    st.sandbox.__sessions.set(sid, { tabs: [], dormantAt: Date.now() - 999_999_999 });
    st.sandbox.__agentBySid.set(sid, { brand: "Claude Code", session: `子任务 ${i}` });
  }
  void T2;
  await st.sandbox.__sweepDormant();
  check(
    "回收休眠会话时 agentBySid 跟着一起清（原来只清 sessions）",
    sids.every((s) => !st.sandbox.__agentBySid.has(s)),
    `agentBySid 还剩 ${st.sandbox.__agentBySid.size} 条`
  );
}

console.log("\n\x1b[1m状态 / 账本 / 桥接：冷启动、并发窗口与热路径开销\x1b[0m");

function countingChrome(st) {
  const ch = makeChrome(st);
  const n = { localGetNull: 0, localSet: 0, localRemove: 0, sessionSet: 0, tabsQuery: 0, tabsGet: 0, groupsQuery: 0, action: 0 };
  const wrap = (obj, key, hit) => {
    const orig = obj[key].bind(obj);
    obj[key] = (...a) => {
      hit(...a);
      return orig(...a);
    };
  };
  wrap(ch.storage.local, "get", (k) => {
    if (k == null) n.localGetNull++;
  });
  wrap(ch.storage.local, "set", () => n.localSet++);
  wrap(ch.storage.local, "remove", () => n.localRemove++);
  wrap(ch.storage.session, "set", () => n.sessionSet++);
  wrap(ch.tabs, "query", () => n.tabsQuery++);
  wrap(ch.tabs, "get", () => n.tabsGet++);
  wrap(ch.tabGroups, "query", () => n.groupsQuery++);
  for (const k of ["setIcon", "setBadgeText", "setBadgeBackgroundColor", "setTitle"]) wrap(ch.action, k, () => n.action++);
  return { ch, n };
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const st = freshState();
  let release;
  const gate = new Promise((r) => (release = r));
  const ch = makeChrome(st);
  const origGet = ch.storage.local.get;
  ch.storage.local.get = async (k) => {
    if (k == null) await gate;
    return origGet(k);
  };
  loadSw(st, ch);
  const who = await Promise.race([st.sandbox.__restore().then(() => "恢复完成"), nap(200).then(() => "卡在家务上")]);
  check("冷启动第一条调用只等状态恢复，不等家务跑完", who === "恢复完成", who);
  release();
  await nap(20);
}

{
  const st = freshState();
  let release;
  const gate = new Promise((r) => (release = r));
  const ch = makeChrome(st);
  const origGet = ch.storage.local.get;
  ch.storage.local.get = async (k) => {
    if (k == null) await gate;
    return origGet(k);
  };
  loadSw(st, ch);
  let replied = false;
  ch.runtime.onMessage._fire({ type: "popup-status" }, {}, () => (replied = true));
  await nap(120);
  check("弹窗那条路仍然等家务跑完再答", replied === false, "家务还没跑完就把遗留组列出来了");
  release();
  await nap(60);
  check("家务跑完之后弹窗照常拿到回包", replied === true);
}

{
  const st = freshState();
  st.localStorage["aic-our-1"] = 1;
  st.groups.push({ id: 500, title: "旧组", color: "blue", windowId: 10 });
  const { ch, n } = countingChrome(st);
  loadSw(st, ch);
  await st.sandbox.__restore();
  check(
    "冷启动第一条调用不再替家务垫上那一整套查询",
    n.localGetNull <= 1 && n.tabsQuery <= 1 && n.groupsQuery === 0,
    `localGet(null)=${n.localGetNull} tabs.query=${n.tabsQuery} tabGroups.query=${n.groupsQuery}`
  );
  check("家务本身照常被踢起来（只是不等它）", n.localGetNull >= 1, String(n.localGetNull));
  await nap(30);
}

{
  const st = freshState();
  const ch = makeChrome(st);
  st.ops = [];
  const origA = ch.debugger.attach;
  const origD = ch.debugger.detach;
  const origS = ch.debugger.sendCommand;
  ch.debugger.attach = (t, v, cb) => {
    st.ops.push("attach");
    return origA(t, v, cb);
  };
  ch.debugger.detach = (t, cb) => {
    st.ops.push("detach");
    return origD(t, cb);
  };
  ch.debugger.sendCommand = (t, m, p, cb) => {
    if (m === "Runtime.evaluate" && /__aic_cursor__/.test(String(p?.expression || ""))) {
      setTimeout(() => origS(t, m, p, cb), 30);
      return;
    }
    return origS(t, m, p, cb);
  };
  const T = loadSw(st, ch);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.ops = [];
  const d = st.sandbox.__detach(1);
  await nap(5);
  const a = st.sandbox.__attach(1).catch(() => {});
  await Promise.all([d, a]);
  check(
    "detach 还在擦光标时进来的 attach 要排队，不能抢在 debugger.detach 之前挂上",
    JSON.stringify(st.ops) === JSON.stringify(["detach", "attach"]),
    JSON.stringify(st.ops)
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  await T.click({ x: 20, y: 20 }, "s1");
  check("输入之前确实开过放行窗（不然下面那条断言是假的）", st.sandbox.__inputGate.has(1), "根本没开过窗");
  st.chrome.debugger.onEvent._fire({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "f0", url: "https://github.com/x" } });
  check(
    "主框架一导航放行窗就作废（window.__aicPass 随旧文档一起没了）",
    !st.sandbox.__inputGate.has(1),
    "SW 还记着窗开着，新文档的屏蔽器会把 agent 自己的输入拦下，而工具照报成功"
  );
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.cdp = [];
  await T.click({ x: 20, y: 20 }, "s1");
  const passExpr = () =>
    st.cdp.filter((c) => c.method === "Runtime.evaluate" && /__aicPass=/.test(String(c.params?.expression || "")))
      .map((c) => String(c.params.expression).replace(/=\d{6,}/, "=<until>"));
  check("点完这一下窗还开着（清窗是防抖的，不能每个事件关一次）", st.sandbox.__inputGate.has(1), JSON.stringify(passExpr()));
  check("窗只开过一次（一次点击的 moved/pressed/released 共享同一扇）", passExpr().length === 1, JSON.stringify(passExpr()));
  await nap(260);
  check(
    "突发结束后主动清窗（真人的敞口从 900ms 收到防抖那一档）",
    passExpr().includes("window.__aicPass=0"),
    JSON.stringify(passExpr())
  );
  check("清窗同时把账本摘掉：下一条输入必须重新开窗并等它落地", !st.sandbox.__inputGate.has(1), "账本还留着窗，下一条输入会不等就发");
  st.cdp = [];
  await T.click({ x: 20, y: 20 }, "s1");
  check("下一次点击确实重新开了窗", passExpr().some((e) => e === "window.__aicPass=<until>"), JSON.stringify(passExpr()));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  let failOpen = true;
  st.cdpFail = (method, params) =>
    failOpen && method === "Runtime.evaluate" && /__aicPass=\d/.test(String(params?.expression || ""))
      ? "Inspected target navigated or closed"
      : null;
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  await T.click({ x: 20, y: 20 }, "s1").catch(() => {});
  check(
    "开窗失败后账本里不许留着这扇窗",
    !st.sandbox.__inputGate.has(1),
    "SW 还记着窗开着，接下来 900ms 的输入会被自家屏蔽器吃掉而工具照报成功"
  );
  failOpen = false;
  st.cdp = [];
  await T.click({ x: 20, y: 20 }, "s1");
  check(
    "恢复之后下一条输入重新开窗",
    st.cdp.some((c) => c.method === "Runtime.evaluate" && /__aicPass=\d/.test(String(c.params?.expression || ""))),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}

{
  const savedState = () => ({
    sessions: [["s1", { tabs: [{ tabId: 1, url: "https://github.com/foo", title: "GitHub" }], groupId: null, label: null, state: "idle", color: "blue" }]],
    tabOwner: [[1, "s1"]],
    ourTabs: [1],
    dialogSeen: [],
    humanHold: [],
    colorCursor: 1,
    agentWindowId: null,
  });

  {
    const st = freshState();
    st.storage["aic-sessions-v1"] = savedState();
    const ch = makeChrome(st);
    let release;
    const gate = new Promise((r) => (release = r));
    const origSess = ch.storage.session.get;
    ch.storage.session.get = async (k) => {
      const v = await origSess(k);
      if (k === "aic-sessions-v1") await gate;
      return v;
    };
    loadSw(st, ch);
    const restored = st.sandbox.__restore();
    ch.tabs.onRemoved._fire(1, { windowId: 10, isWindowClosing: false });
    release();
    await restored;
    await nap(30);
    const tables = st.sandbox.__perTabTables();
    check(
      "恢复途中关掉的页不会被 restore 又读回来（onRemoved 要等 ensureRestored）",
      !tables.tabOwner.has(1) && !tables.ourTabs.has(1),
      `tabOwner=${JSON.stringify([...tables.tabOwner.keys()])} ourTabs=${JSON.stringify([...tables.ourTabs])}`
    );
  }

  {
    const st = freshState();
    st.storage["aic-sessions-v1"] = savedState();
    const ch = makeChrome(st);
    let release;
    const gate = new Promise((r) => (release = r));
    const origSess = ch.storage.session.get;
    ch.storage.session.get = async (k) => {
      const v = await origSess(k);
      if (k === "aic-sessions-v1") await gate;
      return v;
    };
    loadSw(st, ch);
    const restored = st.sandbox.__restore();
    ch.debugger.onDetach._fire({ tabId: 1 });
    release();
    await restored;
    await nap(30);
    const saved = st.storage["aic-sessions-v1"] || {};
    check(
      "恢复途中的 onDetach 不会拿空表把存档盖掉（要等 ensureRestored）",
      (saved.sessions || []).length === 1,
      JSON.stringify(saved.sessions)
    );
  }
}

{
  const st = freshState();
  st.tabs.push({ id: 77, windowId: 10, title: "组里的页", url: "https://x.example.com/", active: false, status: "complete", groupId: 500 });
  st.groups.push({ id: 500, title: "遗留任务", color: "blue", windowId: 10 });
  loadSw(st);
  await new Promise((r) => st.chrome.runtime.onMessage._fire({ type: "popup-close-group", groupId: 500 }, {}, r));
  check(
    "弹窗关组之前先解散分组（不然整组进「最近关闭」，Cmd+Shift+T 一按就复活）",
    st.ungrouped.length > 0,
    "直接 tabs.remove 了"
  );
  check("页确实关掉了", !st.tabs.some((t) => t.id === 77), JSON.stringify(st.tabs.map((t) => t.id)));
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://x.example.com/" }, "s1");
  st.sandbox.__agentBySid.set("s1", { brand: "Claude Code" });
  check("开完页页账本上有一笔（不然下面断言是假的）", st.localStorage[`aic-our-${t.tabId}`] !== undefined, JSON.stringify(Object.keys(st.localStorage)));
  await new Promise((r) => st.chrome.runtime.onMessage._fire({ type: "popup-release" }, {}, r));
  await nap(30);
  const keys = Object.keys(st.localStorage);
  check(
    "「全部放开」把页账本一并销掉（否则 15 分钟后组会被当遗留组自动解散）",
    !keys.some((k) => k.startsWith("aic-our-")),
    JSON.stringify(keys)
  );
  check("ourTabs 也清了", st.sandbox.__perTabTables().ourTabs.size === 0, String(st.sandbox.__perTabTables().ourTabs.size));
  check("agentBySid 跟着会话一起清", st.sandbox.__agentBySid.size === 0, String(st.sandbox.__agentBySid.size));
}

{
  const st = freshState();
  st.tabs.push({ id: 88, windowId: 10, title: "任务页", url: "https://x.example.com/", active: false, status: "complete", groupId: 500 });
  st.groups.push({ id: 500, title: "改 sw.js", color: "green", windowId: 10 });
  st.localStorage["aic-our-88"] = { l: "改 sw.js" };
  st.localStorage["aic-our-group-500"] = {
    s: "s1",
    l: "改 sw.js",
    t: Date.now(),
    a: "Claude Code",
    ag: { brand: "Claude Code", surface: "cli", workspace: "agent-in-chrome", session: "改 sw.js" },
  };
  loadSw(st);
  st.sandbox.__agentBySid.set("s1", { brand: "Claude Code", surface: "cli" });
  await st.sandbox.__reclaimForSid("s1");
  const s = st.sandbox.__sessions.get("s1");
  check("认回来的会话沿用组原来的颜色（不然扩展一重载组就无故换色）", s?.color === "green", String(s?.color));
  check("认回来时账本上的会话名不被这一帧的空值挡掉", s?.agent?.session === "改 sw.js", JSON.stringify(s?.agent));
  check("这一帧带来的那几段仍然用新的那份", s?.agent?.brand === "Claude Code" && s?.agent?.surface === "cli", JSON.stringify(s?.agent));
}

{
  const st = freshState();
  const ch = makeChrome(st);
  let tries = 0;
  st.attachFail = () => (++tries <= 2 ? "Cannot access a chrome-extension:// URL of different extension" : "Cannot attach to this target.");
  const injected = [];
  ch.scripting.executeScript = async (opts) => {
    const name = opts.func?.name || "";
    injected.push(name);
    if (name === "grabForeignOverlay") {
      const first = injected.filter((x) => x === "grabForeignOverlay").length === 1;
      return [{ frameId: 0, result: first ? "DIV" : null }];
    }
    return [{ frameId: 0, result: null }];
  };
  loadSw(st, ch);
  await st.sandbox.__attach(1).catch(() => {});
  check(
    "摘了宿主但最后因为别的原因还是挂不上，要把摘掉的原位放回去",
    injected.includes("putBackForeignOverlays"),
    JSON.stringify(injected)
  );
}

{
  const st = freshState();
  const ch = makeChrome(st);
  const origS = ch.debugger.sendCommand;
  let bodyCalls = 0;
  ch.debugger.sendCommand = (t, m, p, cb) => {
    if (m === "Network.getResponseBody") {
      bodyCalls++;
      setTimeout(() => origS(t, m, p, cb), 20);
      return;
    }
    return origS(t, m, p, cb);
  };
  const T = loadSw(st, ch);
  const tab = await T.new_tab({ url: "https://api.example.com" }, "s1");
  st.bodies["r-1"] = JSON.stringify({ ok: true });
  const ev = ch.debugger.onEvent;
  const src = { tabId: tab.tabId };
  ev._fire(src, "Network.requestWillBeSent", { requestId: "r-1", type: "XHR", timestamp: 1, request: { method: "GET", url: "https://api.example.com/a", headers: {} } });
  ev._fire(src, "Network.responseReceived", { requestId: "r-1", type: "XHR", response: { status: 200, headers: {} } });
  bodyCalls = 0;
  ev._fire(src, "Network.loadingFinished", { requestId: "r-1", timestamp: 2 });
  const d = await T.request_detail({ tabId: tab.tabId, requestId: "r-1" }, "s1");
  await nap(60);
  check("同一条响应体不会被并发取两次", bodyCalls === 1, String(bodyCalls));
  check("并发的那一路照样拿得到体", String(d.responseBody || "").includes("ok"), JSON.stringify(d).slice(0, 160));
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.chrome.debugger.onEvent._fire({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "断点之前的一行" }] });
  await st.sandbox.__detach(1);
  await st.sandbox.__attach(1);
  const log = await T.console_log({ tabId: 1 }, "s1");
  check(
    "重挂调试器不清空环形缓冲（detach 只记断点，真正的清理在关页）",
    JSON.stringify(log).includes("断点之前的一行"),
    JSON.stringify(log).slice(0, 200)
  );
}

{
  const st = freshState();
  st.cookieJar = [
    { name: "a", domain: ".GitHub.com", value: "v1" },
    { name: "b", domain: "api.github.com", value: "v2" },
    { name: "c", domain: "evil-github.com", value: "v3" },
  ];
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const r = await T.cookies_export({ domains: [".GITHUB.com"], tabId: 1 }, "s1");
  check(
    "domains 过滤和凭据闸用同一条归一化：带点、大小写都认，相邻域名不误伤",
    r.count === 2,
    JSON.stringify(r.domains)
  );
}

{
  const st = freshState();
  st.localStorage["aic-our-7"] = 1;
  st.localStorage["aic-our-group-500"] = { s: "s1" };
  st.tabs.push({ id: 7, windowId: 10, title: "x", url: "https://x.example.com/", active: false, status: "complete", groupId: 500 });
  st.groups.push({ id: 500, title: "t", color: "blue", windowId: 10 });
  loadSw(st);
  const led = await st.sandbox.__ledgerRead();
  check(
    "组账本条目不会被当成页账本条目（前缀相包含，分开靠的是纯数字判据）",
    led.size === 1 && led.has(7) && led.groups.size === 1 && led.groups.has(500),
    `页 ${led.size} 组 ${led.groups.size}`
  );
  await st.sandbox.__pruneLedgers();
  check("瘦身也不会把活着的组账本当成死页删掉", st.localStorage["aic-our-group-500"] !== undefined, JSON.stringify(Object.keys(st.localStorage)));
}

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "靶子", box: [10, 10, 100, 30] })]);
  const { ch, n } = countingChrome(st);
  const T = loadSw(st, ch);
  const t = await T.new_tab({ url: "https://x.example.com/" }, "s1");
  await nap(20);
  n.action = 0;
  n.localSet = 0;
  for (let i = 0; i < 3; i++) await T.click({ x: 20, y: 20, tabId: t.tabId }, "s1");
  check("连点三次不再重刷工具栏图标（状态没变）", n.action === 0, String(n.action));
  check("连点三次不再重写页账本（url/title/openedAs 都没变）", n.localSet === 0, String(n.localSet));
  await T.set_task_state({ state: "failed" }, "s1");
  check("状态一变照旧刷图标", n.action > 0, String(n.action));
}

{
  const st = freshState();
  const { ch, n } = countingChrome(st);
  const T = loadSw(st, ch);
  await T.new_tab({ url: "https://x.example.com/" }, "s1");
  await nap(20);
  await st.sandbox.__persist();
  n.sessionSet = 0;
  for (let i = 0; i < 5; i++) await st.sandbox.__persist();
  check("状态没变时 persist 不再重复往 storage.session 里写", n.sessionSet === 0, String(n.sessionSet));
  st.sandbox.__sessions.get("s1").label = "换个任务名";
  await st.sandbox.__persist();
  check("状态一变照旧落盘", n.sessionSet === 1, String(n.sessionSet));
}

{
  const st = freshState();
  const { ch, n } = countingChrome(st);
  loadSw(st, ch);
  await st.sandbox.__restore();
  await nap(30);
  n.tabsQuery = 0;
  n.groupsQuery = 0;
  n.localGetNull = 0;
  ch.tabs.onRemoved._fire(2, { windowId: 10, isWindowClosing: false });
  await nap(30);
  check(
    "关掉一张跟 agent 无关的页不再白跑一趟胶囊重算",
    n.tabsQuery === 0 && n.groupsQuery === 0 && n.localGetNull === 0,
    `tabs.query=${n.tabsQuery} tabGroups.query=${n.groupsQuery} localGet(null)=${n.localGetNull}`
  );
}

{
  const st = freshState();
  const { ch, n } = countingChrome(st);
  const T = loadSw(st, ch);
  await st.sandbox.__restore();
  await nap(30);
  n.tabsQuery = 0;
  n.groupsQuery = 0;
  n.localGetNull = 0;
  n.tabsGet = 0;
  await T.new_tab({ url: "https://x.example.com/", label: "开页计数" }, "s1");
  await nap(20);
  check("开一张页的账本全量读不超过 2 次（两次都是写完重读，不是白读）", n.localGetNull <= 2, String(n.localGetNull));
  check("开一张页的标签组查询从 3 次降到 2 次", n.groupsQuery === 2, String(n.groupsQuery));
  check("groupInto 不再对同一张页连问三次 tabs.get", n.tabsGet <= 3, String(n.tabsGet));

  n.localGetNull = 0;
  await st.sandbox.__ledgerRead();
  await st.sandbox.__ledgerRead();
  await st.sandbox.__ledgerRead();
  check("连着读三次账本只付一次 storage 全量读", n.localGetNull === 1, String(n.localGetNull));
}

{
  const st = freshState();
  loadSw(st);
  st.hostPort.postMessage = () => {
    throw new Error("Attempting to use a disconnected port object");
  };
  st.hostPort.onMessage._fire({ type: "call", id: 9, tool: "tabs_list", args: {}, session: "s1" });
  await nap(30);
  const status = await new Promise((r) => st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, r));
  check("回包发不出去时把断线原因记下来（不然弹窗只写「未连接」，说不出断在哪）", !!status.lastDisconnect, JSON.stringify(status.lastDisconnect));
  check("同时也认了「已经断了」", status.connected === false, JSON.stringify(status.connected));
}

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://upload.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const src = { tabId: tab.tabId };
  const BIG = "y".repeat(200_000);
  for (let i = 0; i < 80; i++) {
    st.postDatas[`inc-${i}`] = BIG;
    ev._fire(src, "Network.requestWillBeSent", {
      requestId: `inc-${i}`,
      type: "XHR",
      timestamp: 100 + i,
      request: { method: "POST", url: `https://upload.example.com/p/${i}`, headers: {}, postData: BIG, hasPostData: true },
    });
  }
  await nap(20);
  const recount = (st.sandbox.__networkRing.get(tab.tabId) || []).reduce(
    (a, r) => a + (r.body ? r.body.length : 0) + (r.postData ? r.postData.length : 0),
    0
  );
  check("增量维护的报文体字节数和重新数一遍完全相符", st.sandbox.__bodyBytesUsed(tab.tabId) === recount, `记账 ${st.sandbox.__bodyBytesUsed(tab.tabId)} / 实际 ${recount}`);
  check("腾完之后仍在预算之内", recount <= st.sandbox.__BODY_BUDGET, `${recount} / ${st.sandbox.__BODY_BUDGET}`);
}

console.log("\n\x1b[1m报文体打码\x1b[0m");
{
  const st = freshState();
  loadSw(st);
  const R = st.sandbox.__redactBody;

  const tokenBody = JSON.stringify({
    access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    refresh_token: "rt_8f7e6d5c4b3a29180f1e2d3c4b5a6978",
    token_type: "Bearer",
    expires_in: 3600,
    user: { id: 42, name: "Alice", email: "alice@example.com" },
  });
  const t = R(tokenBody);
  check("JSON 里的 access_token 不再明文", !t.text.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), t.text.slice(0, 160));
  check("refresh_token 也挡住", !t.text.includes("rt_8f7e6d5c4b3a29180f1e2d3c4b5a6978"), t.text.slice(0, 160));
  check("挡住之后还说得清挡了什么、多长", /<已打码 \d+ 字符>/.test(t.text) && t.hits.length >= 2, JSON.stringify(t.hits));
  check("token_type: Bearer 这种短值不打码（打了只是让人看不见字段本来的样子）", t.text.includes('"Bearer"'), t.text.slice(0, 200));
  check("同一个对象里的业务字段原样保留", t.text.includes('"name":"Alice"') && t.text.includes("3600"), t.text.slice(0, 200));

  const form = R("grant_type=authorization_code&code=4/0AY0e-g7xKJ2m9Qw&client_secret=cs_live_9f8e7d6c5b4a&state=xyz");
  check("表单体里的 code / client_secret 挡住", !form.text.includes("4/0AY0e-g7xKJ2m9Qw") && !form.text.includes("cs_live_9f8e7d6c5b4a"), form.text);
  check("同一串里的 grant_type / state 不动", form.text.includes("grant_type=authorization_code") && form.text.includes("state=xyz"), form.text);

  const bare = R('["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcd1234", 1, 2]');
  check("没有键名的裸 JWT 也认得出来", /<JWT 已隐去/.test(bare.text), bare.text);

  for (const [label, body] of [
    ["普通业务 JSON", JSON.stringify({ items: [1, 2, 3], name: "普通业务数据", note: "这里没有凭据" })],
    ["长长的随机 hex（哈希 / id，最容易误伤的一类）", JSON.stringify({ sha: "9f8e7d6c5b4a32109f8e7d6c5b4a32109f8e7d6c" })],
    ["`code` 只在整个键就是它时才算", JSON.stringify({ errorCode: "E_TOO_MANY_REQUESTS_PLEASE_RETRY", codeName: "限流了" })],
    ["带 = 的 base64 图片", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB=="],
  ]) {
    const r = R(body);
    check(`误报闸：${label} 一个字都不动`, r.text === body && r.hits.length === 0, r.text.slice(0, 160));
  }

  check("revealSecrets 时原样返回（要原文的那条路还得通）", R(tokenBody, true).text === tokenBody);
  check("空/非字符串不抛", R(null).text === null && R("").text === "");

  {
    const st2 = freshState();
    const T = loadSw(st2);
    const tab = await T.new_tab({ url: "https://api.example.com" }, "s1");
    st2.bodies["r1"] = tokenBody;
    st2.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.requestWillBeSent", {
      requestId: "r1", type: "XHR", timestamp: 1,
      request: { method: "GET", url: "https://api.example.com/token", headers: {} },
    });
    st2.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.responseReceived", {
      requestId: "r1", type: "XHR", timestamp: 2,
      response: { status: 200, headers: {}, mimeType: "application/json" },
    });
    st2.chrome.debugger.onEvent._fire({ tabId: tab.tabId }, "Network.loadingFinished", { requestId: "r1", timestamp: 3 });
    await new Promise((r) => setTimeout(r, 20));
    const d = await T.request_detail({ tabId: tab.tabId, requestId: "r1", includeBody: true, maxBody: 40 }, "s1");
    check(
      "maxBody 正好切在凭据中间时，出去的也不是半截原文",
      !String(d.responseBody || "").includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
      String(d.responseBody)
    );
    check("截断标志照旧按原始长度算，没因为打码变短就说没截过", d.responseBodyTruncated === true, JSON.stringify(d.responseBodyTruncated));
    check("打了码就说一句，别让人以为看到的是完整数据", /已打码/.test(String(d.bodyRedactNote || "")), String(d.bodyRedactNote));
  }
}

console.log("\n\x1b[1m凭据字段：两份判据要一致\x1b[0m");
{
  const st = freshState();
  loadSw(st);
  const src = fs.readFileSync(path.join(ROOT, "extension", "sw.js"), "utf8");
  const injected = (src.split("async function cdpElementInfo(")[1] || "").split("functionDeclaration: `")[1] || "";
  for (const token of ['type === "hidden"', 'type === "password"']) {
    check(`cdpElementInfo 那份判据里有 ${token}`, injected.includes(token), injected.slice(0, 300));
  }
  check("cdpElementInfo 用的是共用常量，不再自己写一条正则", /new RegExp\(\$\{JSON\.stringify\(SECRET_AC_RE_SRC\)\}\)/.test(injected), injected.slice(0, 400));
  const constSrc = (/const SECRET_AC_RE_SRC =\s*\n?\s*("(?:[^"\\]|\\.)*");/.exec(src) || [])[1];
  const pageLit = (/return \/(\(\^\|[^\n]*?)\/\.test\(\s*\n?\s*ac\.replace/.exec(src) || [])[1];
  check("SW 里有那条常量", !!constSrc, String(constSrc));
  check("pageAgent 那份字面量与常量逐字相同", !!pageLit && !!constSrc && JSON.parse(constSrc) === pageLit, `${pageLit} vs ${constSrc && JSON.parse(constSrc)}`);
  const re = new RegExp(JSON.parse(constSrc));
  for (const v of ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "shipping cc-number"]) {
    check(`判据认得 autocomplete="${v}"`, re.test(v), v);
  }
  for (const v of ["username", "cc-numbering", "email"]) {
    check(`误报闸：autocomplete="${v}" 不算凭据`, !re.test(v), v);
  }
}

console.log("\n\x1b[1m可编辑区里的凭据不进正文\x1b[0m");
{
  const secret = "P@ssw0rdInDiv";
  const st = freshState({
    page: makePage(
      [
        el("div", {
          id: "ce",
          innerText: secret,
          box: [8, 20, 300, 40],
          attrs: { contenteditable: "true", autocomplete: "current-password" },
        }),
        el("div", { id: "ce2", innerText: "普通可编辑内容", box: [8, 80, 300, 40], attrs: { contenteditable: "true" } }),
      ],
      { bodyText: `表单\n${secret}\n普通可编辑内容` }
    ),
  });
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://forms.example.com" }, "s1");
  const page = await T.read_page({ tabId: tab.tabId }, "s1");
  const dump = JSON.stringify(page);
  check("被标成凭据的可编辑区不出现在正文里", !dump.includes(secret), String(page.text).slice(0, 200));
  check("挡住之后说清是什么、多长", /可编辑的凭据字段，\d+ 字符/.test(String(page.text)), String(page.text).slice(0, 200));
  check("误报闸：普通可编辑区原样保留", String(page.text).includes("普通可编辑内容"), String(page.text).slice(0, 200));
}

{
  const secret = "第一行\n\n\n\n第二行是口令 P@ss";
  const normalized = secret.replace(/\n{3,}/g, "\n\n");
  const st = freshState({
    page: makePage(
      [
        el("div", {
          id: "ce",
          innerText: secret,
          box: [8, 20, 300, 120],
          attrs: { contenteditable: "true", autocomplete: "current-password" },
        }),
      ],
      { bodyText: `恢复口令\n${secret}` }
    ),
  });
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://forms.example.com" }, "s1");
  const page = await T.read_page({ tabId: tab.tabId }, "s1");
  check("连续换行被归一化之后照样挡得住", !String(page.text).includes("P@ss"), String(page.text).slice(0, 200));
  check("字符数按归一化之后的算（和正文同一把尺）", String(page.text).includes(`${normalized.length} 字符`), String(page.text).slice(0, 200));
}

console.log("\n\x1b[1mOOPIF 会话：不盲等\x1b[0m");
{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://frames.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  const origSend = st.chrome.debugger.sendCommand;
  st.chrome.debugger.sendCommand = (src, method, params, cb) => {
    if (method === "Target.setAutoAttach" && params?.autoAttach && !src.sessionId)
      setTimeout(() => ev._fire(src, "Target.attachedToTarget", {
        sessionId: "kid-1",
        targetInfo: { targetId: "T-kid-1", type: "iframe", url: "https://ads.example.com/" },
        waitingForDebugger: false,
      }), 0);
    return origSend(src, method, params, cb);
  };
  const realSetTimeout = st.sandbox.setTimeout;
  const naps = [];
  st.sandbox.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === "number" && ms > 0) naps.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  const t0 = Date.now();
  const got = await st.sandbox.__attachFrameSessions(tab.tabId, { waitTries: 2, waitMs: 20 });
  const wall = Date.now() - t0;
  st.sandbox.setTimeout = realSetTimeout;
  check("拿到了那条 OOPIF 会话（少等不能变成少看）", got.size === 1, `拿到 ${got.size} 条`);
  check(
    "会话一到手就往下走，一次非零的睡眠都不排（原来是 [20,60]）",
    naps.length === 0,
    `排了 ${JSON.stringify(naps)}，墙钟 ${wall}ms`
  );
}

console.log("\n\x1b[1m输入工具的焦点闸：set_value 不能是例外\x1b[0m");
{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  st.page = makePage([el("input", { id: "q", type: "text", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  const f = await T.find({ query: "#q" }, "s1");
  st.cdp.length = 0;
  await T.set_value({ ref: f.matches[0].ref, value: "abc" }, "s1");
  check(
    "后台页上 set_value 文本控件前先开焦点模拟",
    focusEmuCalls(st).some((c) => c.params.enabled === true),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}
{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  st.page = makePage([el("input", { id: "agree", type: "checkbox", box: [10, 10, 20, 20] })]);
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  const f = await T.find({ query: "#agree" }, "s1");
  st.cdp.length = 0;
  await T.set_value({ ref: f.matches[0].ref, value: true }, "s1").catch(() => {});
  check(
    "后台页上 set_value 勾选框前也先开焦点模拟（它走的是真点击）",
    focusEmuCalls(st).some((c) => c.params.enabled === true),
    JSON.stringify(st.cdp.map((c) => c.method))
  );
}
{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  st.page = makePage([
    el("select", { id: "city", box: [10, 10, 100, 30], children: [el("option", { value: "bj", innerText: "北京" })] }),
  ]);
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  const f = await T.find({ query: "#city" }, "s1");
  st.cdp.length = 0;
  await T.set_value({ ref: f.matches[0].ref, value: "bj" }, "s1").catch(() => {});
  check("设值+派事件那条分支不开焦点模拟（开了是白招密码管理器）", focusEmuCalls(st).length === 0, JSON.stringify(focusEmuCalls(st)));
}

console.log("\n\x1b[1m标签页账目：开失败、放开、close_all 三条路口径一致\x1b[0m");

{
  const st = freshState();
  st.attachFail = () => "Another debugger is already attached to this target.";
  const T = loadSw(st);
  const boom = await throws(() => T.new_tab({ url: "https://a.example.com", label: "任务甲" }, "s1"), /debugger|挂调试器|attach/i);
  check("attach 失败时 new_tab 如实报错", boom.threw, boom.msg);
  const opened = st.created.map((c) => c.id ?? c.tabId).filter((x) => x != null);
  check("页确实已经开出来了（错在 attach，不在 create）", st.created.length === 1, JSON.stringify(st.created));
  const r = await T.close_all({ scope: "session" }, "s1");
  check(
    "close_all 够得着它（登记必须在 attach 之前完成）",
    r.closedCount + r.releasedCount >= 1,
    JSON.stringify({ opened, r, removed: st.removed })
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://a.example.com" }, "s1");
  await T.tab_release({ tabId: t.tabId }, "s1");
  check(
    "tab_release 之后这页不再算「agent 自己开的」",
    !st.sandbox.__perTabTables().ourTabs.has(t.tabId),
    `ourTabs=${JSON.stringify([...st.sandbox.__perTabTables().ourTabs])}`
  );
  await T.close_all({ scope: "all" }, "s2");
  check("放开之后 close_all({scope:'all'}) 不会把它关掉", !st.removed.flat().includes(t.tabId), JSON.stringify(st.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://a.example.com" }, "s1");
  await new Promise((r) => st.chrome.runtime.onMessage._fire({ type: "popup-hold-tabs", tabIds: [t.tabId] }, {}, r));
  await T.close_all({ scope: "session" }, "s1");
  check(
    "close_all 释放接管中的页时也摘掉 ourTabs（否则下一次会当自开页关掉）",
    !st.sandbox.__perTabTables().ourTabs.has(t.tabId),
    `ourTabs=${JSON.stringify([...st.sandbox.__perTabTables().ourTabs])}`
  );
  check("这一趟没关它", !st.removed.flat().includes(t.tabId), JSON.stringify(st.removed));
}

{
  const st = freshState();
  const T = loadSw(st);
  const a = await T.new_tab({ url: "https://a.example.com" }, "s1");
  st.sandbox.__sessions.get("s1");
  const tabOwner = st.sandbox.__perTabTables().tabOwner;
  tabOwner.set(a.tabId, "s2");
  await T.set_task_state({ state: "running" }, "s1");
  check(
    "角标数字不把已经归别人的页算进来（与 heldTabs 同口径）",
    st.action.badge === "" || st.action.badge === null,
    `badge=${JSON.stringify(st.action.badge)}`
  );
}

{
  const st = freshState();
  const T = loadSw(st);
  for (const sid of ["s1", "s2", "s3"]) await T.new_tab({ url: "https://a.example.com", label: "很长的任务名字" }, sid);
  const r = await T.set_task_state({ state: "running" }, "s1");
  const onTab = st.groupUpdates.filter((g) => g.props?.title).slice(-1)[0]?.props?.title;
  check("返回的 groupTitle 和真正写到组上的那个一致", r.groupTitle === onTab, `返回 ${JSON.stringify(r.groupTitle)} / 组上 ${JSON.stringify(onTab)}`);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com", label: "甲" }, "s1");
  const gid = st.sandbox.__sessions.get("s1").groupId;
  check("先确认建好了组", gid != null, String(gid));
  const origUpdate = st.chrome.tabGroups.update;
  st.chrome.tabGroups.update = async () => {
    throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
  };
  await T.set_task_state({ state: "running" }, "s1");
  st.chrome.tabGroups.update = origUpdate;
  check(
    "瞬时失败之后会话仍然认得自己的组（组还在就别置空）",
    st.sandbox.__sessions.get("s1").groupId === gid,
    String(st.sandbox.__sessions.get("s1").groupId)
  );
}

console.log("\n\x1b[1m目标标签页的会话 id：空 sid 不许当成一把万能钥匙\x1b[0m");

{
  const st = freshState();
  const T = loadSw(st);
  const RAW = st.sandbox.__TOOLS;
  const r1 = await throws(() => RAW.eval_js({ tabId: 1, expression: "1" }, undefined), /会话 id/);
  check("sid 缺失时不许拿到用户的无主页（tabOwner 的 undefined 不是一把钥匙）", r1.threw && r1.match, r1.msg);
  check("而且这一趟没挂上调试器、没碰过那张页", !st.attached.includes(1), JSON.stringify(st.attached));
  const r2 = await throws(() => RAW.eval_js({ tabId: 1, expression: "1" }, ""), /会话 id/);
  check("空串 sid 同样拒绝", r2.threw && r2.match, r2.msg);
  const r3 = await throws(() => RAW.read_page({}, undefined), /会话 id/);
  check("不带 tabId 时也在 heldTabs 这一侧挡住", r3.threw && r3.match, r3.msg);
  const t = await T.new_tab({ url: "https://a.example.com" }, "s1");
  check("正常 sid 不受影响", (await T.eval_js({ tabId: t.tabId, expression: "1" }, "s1")) !== undefined);
}

console.log("\n\x1b[1m清场：见证记号、临时属性、URL 闸\x1b[0m");

{
  const st = freshState({ visibility: "hidden", windowFocused: false });
  st.page = makePage([el("button", { id: "go", innerText: "提交", box: [10, 10, 100, 30] })]);
  st.cdpFail = (m) => (m === "Emulation.setFocusEmulationEnabled" ? "Target closed." : null);
  const T = loadSw(st);
  await T.new_tab({ url: "https://app.example.com" }, "s1");
  const f = await T.find({ query: "提交" }, "s1");
  await throws(() => T.click({ ref: f.matches[0].ref }, "s1"), /收不到输入/);
  const left = st.page.all.filter((e) => e._attrs && e._attrs["data-aic-hit"]);
  check("焦点模拟失败时不把 data-aic-hit 留在页面上", left.length === 0, JSON.stringify(left.map((e) => e._attrs)));
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1, [B_PATH]: 2 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const f = await T.find({ query: "#avatar" }, "s1");
  const t = await throws(() => T.upload_file({ ref: f.matches[0].ref, files: [A_PATH, B_PATH] }, "s1"), /multiple/);
  const left = st.page.all.filter((e) => Object.keys(e._attrs || {}).some((k) => k.startsWith("data-aic-ref-")));
  check("ref_b 路上 multiple 拦下时也摘掉临时属性", t.threw && t.match && left.length === 0, `${t.msg} / 残留 ${JSON.stringify(left.map((e) => e._attrs))}`);
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1 } });
  const T = loadSw(st);
  await T.new_tab({ url: "https://example.com/form" }, "s1");
  const t = await throws(() => T.upload_file({ ref: "ref_1", selector: "#avatar", files: [A_PATH] }, "s1"), /只能给一个|同时给/);
  check("ref 与 selector 同给时报错，不静默丢掉 ref", t.threw && t.match, t.msg);
}

{
  const st = freshState();
  st.tabs.push({ id: 7, windowId: 10, title: "空白页", url: "about:blank", active: false, status: "complete" });
  st.tabs.push({ id: 8, windowId: 10, title: "本机文件", url: "file:///etc/passwd", active: false, status: "complete" });
  const T = loadSw(st);
  const blank = await throws(() => T.tab_use({ takeover: true, tabId: 7 }, "s1"), /无法被调试器接管|内部页面|about:/);
  check("about:blank 照旧拒绝接管（白名单为 new_tab 放行它，接管不放）", blank.threw && blank.match, blank.msg);
  const file = await throws(() => T.tab_use({ takeover: true, tabId: 8 }, "s1"), /不打开本机文件|file:/);
  check("file:// 用的是白名单那句解释（两处口径合一）", file.threw && file.match, file.msg);
}

console.log("\n\x1b[1m等待与搜索：不白等、不把「搜不了」说成「没有」\x1b[0m");

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const done = st.sandbox.__waitForLoad(t.tabId, 30000);
  st.chrome.tabs.onRemoved._fire(t.tabId, { windowId: 10, isWindowClosing: false });
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res("__timeout__"), 200))]);
  check("等加载时页被关掉就立刻收场", r !== "__timeout__", String(r));
  check("并且说清是「页没了」而不是「加载超时」（口径同补探那条）", String(r) === "gone", String(r));
}

{
  const st = freshState();
  const T = loadSw(st);
  const t = await T.new_tab({ url: "https://a.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  ev._fire({ tabId: t.tabId }, "Network.requestWillBeSent", {
    requestId: "r1", request: { url: "https://a.example.com/api", method: "GET" }, type: "XHR", timestamp: 1,
  });
  await st.sandbox.__detach(t.tabId);
  st.cdpFail = (m) => (m === "Network.searchInResponseBody" ? "Debugger is not attached to the tab" : null);
  const r = await T.network_log({ bodyContains: "token", includeSeen: true }, "s1");
  check(
    "搜不了的时候要说搜不了，不能报成「一条都不含」",
    !/没有一条含/.test(String(r.searchNote || "")) || /调试器|搜不了|搜索失败/.test(String(r.searchNote || "")),
    JSON.stringify(r.searchNote)
  );
}

console.log("\n\x1b[1mOOPIF 会话：断线即作废、上传按引用计数借还\x1b[0m");

{
  const st = freshState();
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://frames.example.com" }, "s1");
  const ev = st.chrome.debugger.onEvent;
  ev._fire({ tabId: tab.tabId }, "Target.attachedToTarget", {
    sessionId: "kid-1",
    targetInfo: { targetId: "T-kid-1", type: "iframe", url: "https://ads.example.com/" },
    waitingForDebugger: false,
  });
  check("先确认表里有一条子会话", st.sandbox.__perTabTables().oopifSessions.get(tab.tabId)?.size === 1, "");
  await st.sandbox.__detach(tab.tabId);
  check(
    "调试器一断，子会话表跟着作废（留着的话下一次 hold 会跳过 setAutoAttach，命令全打在死会话上）",
    !(st.sandbox.__perTabTables().oopifSessions.get(tab.tabId)?.size > 0),
    JSON.stringify([...(st.sandbox.__perTabTables().oopifSessions.get(tab.tabId) || new Map()).keys()])
  );
}

{
  const st = freshState({ page: uploadPage(), fileSizes: { [A_PATH]: 1 } });
  const T = loadSw(st);
  const tab = await T.new_tab({ url: "https://example.com/form" }, "s1");
  await st.sandbox.__holdOopifSessions(tab.tabId, { waitTries: 0 });
  const before = st.sandbox.__perTabTables().oopifSessions.get(tab.tabId);
  await throws(() => T.upload_file({ selector: "#nope-not-here", files: [A_PATH] }, "s1"), /没有匹配|定位/);
  check(
    "上传走 OOPIF 通道时不重置别人正握着的会话表",
    st.sandbox.__perTabTables().oopifSessions.get(tab.tabId) === before,
    "会话表被换掉了"
  );
  check("并且没有把 auto-attach 关掉（别人还握着）", st.sandbox.__perTabTables().oopifHold.get(tab.tabId) >= 1, String(st.sandbox.__perTabTables().oopifHold.get(tab.tabId)));
}

console.log("\n\x1b[1mfind 的 container：签名收了就要真的用\x1b[0m");
{
  const st = freshState();
  const inside = el("button", { id: "in", innerText: "确定", box: [10, 10, 60, 20] });
  const outside = el("button", { id: "out", innerText: "确定", box: [10, 200, 60, 20] });
  st.page = makePage([el("div", { id: "dlg", role: "dialog", box: [0, 0, 300, 100], children: [inside] }), outside]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const all = await T.find({ query: "确定" }, "s1");
  check("不给 container 时两个都能找到", all.matches.length === 2, JSON.stringify(all.matches.map((m) => m.name)));
  const only = await T.find({ query: "确定", container: "#dlg" }, "s1");
  check("给了 container 就只在这棵子树里找", only.matches.length === 1, JSON.stringify(only.matches?.map((m) => m.ref)));
  const bad = await throws(() => T.find({ query: "确定", container: "#no-such" }, "s1"), /container/);
  check("container 匹配不到就报错，不静默回落到整页", bad.threw && bad.match, bad.msg);
}

console.log("\n\x1b[1mhover 的 settleMs：和 read_page/find 同名就该同义\x1b[0m");
{
  const st = freshState();
  st.page = makePage([el("button", { id: "m", innerText: "更多", box: [10, 10, 60, 20] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const naps = [];
  const realSetTimeout = st.sandbox.setTimeout;
  st.sandbox.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === "number" && ms > 0) naps.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  const first = await T.hover({ selector: "#m", settleMs: 120 }, "s1");
  naps.length = 0;
  const again = await T.hover({ selector: "#m", settleMs: 120 }, "s1");
  st.sandbox.setTimeout = realSetTimeout;
  check(
    "DOM 已经安静时 hover 不再死等那一整段（走沉降，不是 sleep）",
    !naps.includes(120),
    `第二次排的睡眠 ${JSON.stringify(naps)}`
  );
  check("waitedMs 报的是真的等了多久", again.waitedMs < 120 && first.waitedMs >= 0, JSON.stringify({ first: first.waitedMs, again: again.waitedMs }));
}

console.log("\n\x1b[1m往返次数：浮层扫描、find、回车、多页存活检查\x1b[0m");

{
  const st = freshState();
  st.page = makePage([el("button", { id: "b", innerText: "普通按钮", box: [10, 10, 60, 20] })]);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.cdp.length = 0;
  await T.click({ x: 20, y: 15 }, "s1");
  const n = st.cdp.filter((c) => c.method === "Page.getLayoutMetrics").length;
  check("一个浮层候选都没有时不拉 cdpViewport", n === 0, `Page.getLayoutMetrics ×${n}`);
}

{
  const st = freshState();
  const btns = [];
  for (let i = 0; i < 6; i++) btns.push(el("button", { id: "b" + i, innerText: "候选词", box: [10, 10 + i * 30, 60, 20] }));
  st.page = makePage(btns);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  st.cdp.length = 0;
  await T.find({ query: "候选词" }, "s1");
  const seq = st.cdp.map((c) => c.method);
  const firstDescribe = seq.indexOf("DOM.describeNode");
  const resolves = seq.map((m, i) => (m === "DOM.resolveNode" ? i : -1)).filter((i) => i >= 0);
  check(
    "文本命中的父元素提升是一批发出去的，不是一个个串着等",
    resolves.length >= 2 && resolves.every((i, k) => k === 0 || i === resolves[0] + k),
    `顺序 ${JSON.stringify(seq.slice(0, 20))}`
  );
  void firstDescribe;
}

function cdpIssueMarks(st) {
  const orig = st.chrome.debugger.sendCommand;
  const marks = [];
  let delivered = 0;
  st.chrome.debugger.sendCommand = (t, m, p, cb) => {
    marks.push({ method: m, after: delivered });
    orig(t, m, p, (...a) =>
      setTimeout(() => {
        delivered++;
        cb(...a);
      }, 0)
    );
  };
  return { marks, restore: () => (st.chrome.debugger.sendCommand = orig) };
}
{
  const st = freshState();
  const btns = [];
  for (let i = 0; i < 5; i++) btns.push(el("button", { id: "c" + i, innerText: "候选" + i, box: [10, 10 + i * 30, 60, 20] }));
  st.page = makePage(btns);
  const T = loadSw(st);
  await T.tab_use({ takeover: true, tabId: 1 }, "s1");
  const w = cdpIssueMarks(st);
  await T.find({ role: "button" }, "s1");
  w.restore();
  const ax = w.marks.filter((m) => m.method === "Accessibility.getPartialAXTree");
  const quads = w.marks.filter((m) => m.method === "DOM.getContentQuads");
  check("先确认 5 个候选都量了", ax.length === 5 && quads.length === 5, `${quads.length}/${ax.length}`);
  check(
    "每个候选的 AX 和它的 quads 一起发出（不排在自己那条 quads 的回执后面）",
    ax.length > 0 && Math.min(...ax.map((m) => m.after)) === Math.min(...quads.map((m) => m.after)),
    `AX 发出时已收回执 ${JSON.stringify(ax.map((m) => m.after))} / quads ${JSON.stringify(quads.map((m) => m.after))}`
  );
}

{
  const st = freshState();
  st.page = makePage([el("input", { id: "q", type: "text", box: [10, 10, 200, 30] })]);
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  const origGet = st.chrome.tabs.get;
  let gets = 0;
  st.chrome.tabs.get = (id) => {
    gets++;
    return origGet(id);
  };
  st.lifecycle = [];
  await T.type_text({ selector: "#q", text: "hi", pressEnter: true }, "s1");
  st.chrome.tabs.get = origGet;
  check("带 pressEnter 的一次 type_text 只解析一次目标标签页", gets === 1, `chrome.tabs.get ×${gets}`);
  check("也只唤醒一次页面", st.lifecycle.length === 1, `Page.setWebLifecycleState ×${st.lifecycle.length}`);
}

{
  const st = freshState();
  const T = loadSw(st);
  await T.new_tab({ url: "https://a.example.com" }, "s1");
  await T.new_tab({ url: "https://b.example.com" }, "s1");
  await T.new_tab({ url: "https://c.example.com" }, "s1");
  const origGet = st.chrome.tabs.get;
  const seq = [];
  st.chrome.tabs.get = async (id) => {
    seq.push("问" + id);
    const v = await origGet(id);
    await new Promise((r) => setTimeout(r, 0));
    seq.push("回" + id);
    return v;
  };
  await throws(() => T.read_page({}, "s1"), /没说要操作哪一个/);
  st.chrome.tabs.get = origGet;
  const firstBack = seq.findIndex((x) => x.startsWith("回"));
  check("三张页的存活检查一起问，不是问一张等一张", firstBack >= 3, JSON.stringify(seq));
}

console.log("\n\x1b[1mCDP 客户端：关闭、管道分帧\x1b[0m");
{
  const { CdpClient } = await import("../mcp/cdp/client.mjs");
  const { EventEmitter } = await import("node:events");
  const mkPipe = () => {
    const read = Object.assign(new EventEmitter(), { destroy() { setTimeout(() => read.emit("close"), 0); } });
    const write = Object.assign(new EventEmitter(), { written: [], write(s) { write.written.push(s); }, destroy() { setTimeout(() => write.emit("close"), 0); } });
    return { read, write };
  };

  {
    const { read, write } = mkPipe();
    const c = await new CdpClient({ pipe: { read, write } }).connect();
    const inflight = c.send("Runtime.evaluate", { expression: "1" });
    let settled = null;
    inflight.then(() => (settled = "resolve"), (e) => (settled = `reject: ${e.message}`));
    c.close("MCP server 退出");
    await new Promise((r) => setTimeout(r, 0));
    check("close() 当场把在途命令拒掉，不等传输的 close 事件", settled !== null, `还是 ${settled}`);
    check("拒绝理由用的是 close 传进来的那句", String(settled).includes("MCP server 退出"), String(settled));
    await new Promise((r) => setTimeout(r, 10));
    check("传输的 close 随后再来一次是空操作", c.closed === true);
  }

  {
    const { read, write } = mkPipe();
    const c = await new CdpClient({ pipe: { read, write } }).connect();
    const got = [];
    c.onEvent((m, p) => got.push([m, p]));
    const frame = (o) => Buffer.from(JSON.stringify(o) + "\0", "utf8");

    read.emit("data", Buffer.concat([frame({ method: "A", params: { i: 1 } }), frame({ method: "B", params: { i: 2 } })]));
    check("一块里的多帧都切得出来", got.length === 2 && got[0][0] === "A" && got[1][0] === "B", JSON.stringify(got));

    got.length = 0;
    const big = frame({ method: "C", params: { s: "中文汉字".repeat(500) } });
    for (let off = 0; off < big.length; off += 1001) read.emit("data", big.subarray(off, Math.min(off + 1001, big.length)));
    check("跨块的帧按字节拼回来，多字节字符没被劈坏", got.length === 1 && got[0][1].s === "中文汉字".repeat(500), JSON.stringify(got).slice(0, 120));

    got.length = 0;
    const two = Buffer.concat([frame({ method: "D", params: {} }), frame({ method: "E", params: {} })]);
    const cut = JSON.stringify({ method: "D", params: {} }).length + 1;
    read.emit("data", two.subarray(0, cut));
    read.emit("data", two.subarray(cut));
    check("分隔符正好落在块边界也不丢帧", got.length === 2 && got[1][0] === "E", JSON.stringify(got));

    const feed = (mb) => {
      const f = Buffer.from(JSON.stringify({ method: "Z", params: { d: "x".repeat(mb * 1024 * 1024) } }) + "\0", "utf8");
      for (let off = 0; off < f.length; off += 65536) read.emit("data", f.subarray(off, Math.min(off + 65536, f.length)));
    };
    const realConcat = Buffer.concat;
    let concatBytes = 0;
    let concatCalls = 0;
    Buffer.concat = (list, len) => {
      const b = realConcat(list, len);
      concatBytes += b.length;
      concatCalls += 1;
      return b;
    };
    try {
      feed(8);
    } finally {
      Buffer.concat = realConcat;
    }
    const frameBytes = 8 * 1024 * 1024;
    check(
      "8MB 帧的重组拷贝账对帧长线性（整帧只 concat 一次，不是每块一次）",
      concatBytes <= frameBytes * 1.5 && concatCalls <= 2,
      `concat ${concatCalls} 次共 ${(concatBytes / 1048576).toFixed(1)}MB（二次方那一版是 ~128 次 ~512MB）`
    );
    c.close("完事");
  }

  {
    const { Browser } = await import("../mcp/cdp/client.mjs");
    const { read, write } = mkPipe();
    write.write = (s) => {
      const f = JSON.parse(s.replace(/\0$/, ""));
      const result = f.method === "Target.getTargets" ? { targetInfos: [{ targetId: "P1", type: "page", url: "about:blank", title: "" }] } : {};
      setTimeout(() => read.emit("data", Buffer.from(JSON.stringify({ id: f.id, result }) + "\0", "utf8")), 0);
    };
    const br = await Browser.connect({ pipe: { read, write } });
    const ev = (method, params, sessionId) =>
      read.emit("data", Buffer.from(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", "utf8"));

    const pageOnly = br.targets.size;
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 30; i++) {
        const tid = `F${round}-${i}`;
        ev("Target.attachedToTarget", { sessionId: `S-${tid}`, targetInfo: { targetId: tid, type: "iframe", url: "https://ads.example.com/" } }, "S-PAGE");
        ev("Target.targetInfoChanged", { targetInfo: { targetId: tid, type: "iframe", url: "https://ads.example.com/x" } });
        ev("Target.detachedFromTarget", { sessionId: `S-${tid}` }, "S-PAGE");
        if (i % 3 === 0) ev("Target.targetDestroyed", { targetId: tid });
      }
      for (let i = 0; i < 5; i++) ev("Target.targetInfoChanged", { targetInfo: { targetId: `F${round}-${i}`, type: "iframe", url: "https://ads.example.com/y" } });
    }
    const iframes = [...br.targets.values()].filter((t) => t.type === "iframe").length;
    check("10 轮 × 30 个跨进程 iframe 之后 target 表不增长", br.targets.size === pageOnly, `targets=${br.targets.size}（其中 iframe ${iframes} 条）`);
    check("标签页那条记录一直在（它的 tabId 必须终身稳定）", br.pages().length === 1 && br.pages()[0].targetId === "P1");

    ev("Target.attachedToTarget", { sessionId: "S-PAGE2", targetInfo: { targetId: "P1", type: "page", url: "about:blank", title: "" } });
    ev("Target.detachedFromTarget", { sessionId: "S-PAGE2" });
    check("标签页 detach 之后记录还在、只是会话被置空", br.targets.get("P1") && br.targets.get("P1").sessionId === null, JSON.stringify(br.targets.get("P1")));

    {
      let created = 0;
      br.on("created", () => created++);
      ev("Target.attachedToTarget", { sessionId: "S-PAGE3", targetInfo: { targetId: "P1", type: "page", url: "about:blank", title: "" } });
      check("同一张页再次 attach 不重复报 created", created === 0, `报了 ${created} 次`);
      ev("Target.attachedToTarget", { sessionId: "S-NEW", targetInfo: { targetId: "P9", type: "page", url: "about:blank", title: "" } });
      check("真正的新页照旧报 created", created === 1, `报了 ${created} 次`);
    }
    br.client.close("完事");
  }
}

console.log("\n\x1b[1mCLI shim：装得起 sw.js，且内部表不泄漏\x1b[0m");
{
  const { createChromeShim } = await import("../mcp/cdp/chrome-shim.mjs");
  const shimStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-shim-"));

  const mkBrowser = () => {
    const listeners = new Set();
    const page = {
      targetId: "PAGE_A",
      type: "page",
      url: "about:blank",
      title: "",
      sessionId: "S_PAGE",
      tabId: 4242,
      windowId: 1,
    };
    const destroyed = new Set();
    return {
      page,
      emit: (m, p, s) => {
        for (const fn of [...listeners]) fn(m, p, s);
      },
      destroy: () => {
        for (const fn of [...destroyed]) fn(page);
      },
      browser: {
        client: {
          wsUrl: "ws://127.0.0.1:9222/devtools/browser/test-guid",
          onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
          send: async () => ({}),
          closed: false,
        },
        targets: new Map([["PAGE_A", page]]),
        pages: () => [page],
        byTabId: () => page,
        session: async () => "S_PAGE",
        send: async () => ({}),
        on: (kind, fn) => {
          if (kind === "destroyed") destroyed.add(fn);
          return () => destroyed.delete(fn);
        },
      },
    };
  };

  {
    const SHIM = pathToFileURL(path.join(ROOT, "mcp", "cdp", "chrome-shim.mjs")).href;
    const SW = pathToFileURL(path.join(ROOT, "extension", "sw.js")).href;
    const out = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(SHIM)}).then(async (m) => {
           const page = { targetId: "P", type: "page", url: "", title: "", sessionId: "S", tabId: 1, windowId: 1 };
           const browser = {
             client: { wsUrl: "ws://x/devtools/browser/g", onEvent: () => () => {}, send: async () => ({}), closed: false },
             targets: new Map([["P", page]]), pages: () => [page], byTabId: () => page,
             session: async () => "S", send: async () => ({}), on: () => () => {},
           };
           const shim = m.createChromeShim(browser, { manifest: { version: "0.0.0" }, stateDir: ${JSON.stringify(shimStateDir)} });
           globalThis.chrome = shim.chrome;
           await import(${JSON.stringify(SW)});
           console.log("OK");
           process.exit(0);
         }).catch((e) => { console.log("FAIL " + ((e && e.message) || e)); process.exit(1); });`,
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    const said = String(out.stdout || "").trim().split("\n").pop() || String(out.stderr || "").slice(-200);
    check("sw.js 能装到 CLI shim 上（chrome.* 一个都不缺）", said === "OK", said);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const fired = [];
    shim.chrome.alarms.onAlarm.addListener((a) => fired.push(a.name));

    for (let i = 0; i < 5; i++) shim.chrome.alarms.create("同一个名字", { delayInMinutes: 60 });
    check("同名 create 只留一个 alarm（不是叠加）", shim.stats().alarms === 1, `有 ${shim.stats().alarms} 个`);

    shim.chrome.alarms.create("另一个", { periodInMinutes: 60 });
    check("不同名各算一个", shim.stats().alarms === 2, `有 ${shim.stats().alarms} 个`);

    const cleared = await shim.chrome.alarms.clear("同一个名字");
    check("clear 报 true 并且真的把它拿掉了", cleared === true && shim.stats().alarms === 1, `剩 ${shim.stats().alarms} 个`);
    check("clear 一个不存在的名字报 false", (await shim.chrome.alarms.clear("没有这个")) === false);

    await shim.chrome.alarms.clearAll();
    check("clearAll 清空", shim.stats().alarms === 0, `剩 ${shim.stats().alarms} 个`);

    shim.chrome.alarms.create("一次性", { delayInMinutes: 0.0008 });
    await new Promise((r) => setTimeout(r, 220));
    check("delayInMinutes 是一次性：只响一次", fired.filter((n) => n === "一次性").length === 1, `响了 ${fired.filter((n) => n === "一次性").length} 次`);
    check("一次性 alarm 响过就不在表里了", shim.stats().alarms === 0, `剩 ${shim.stats().alarms} 个`);

    fired.length = 0;
    shim.chrome.alarms.create("按时刻", { when: Date.now() + 40 });
    await new Promise((r) => setTimeout(r, 220));
    check("when 也是一次性：只响一次", fired.filter((n) => n === "按时刻").length === 1, `响了 ${fired.filter((n) => n === "按时刻").length} 次`);

    fired.length = 0;
    shim.chrome.alarms.create("周期", { periodInMinutes: 0.0008 });
    await new Promise((r) => setTimeout(r, 260));
    await shim.chrome.alarms.clearAll();
    const n = fired.filter((x) => x === "周期").length;
    check("periodInMinutes 会重复响", n >= 2, `响了 ${n} 次`);
    const after = fired.filter((x) => x === "周期").length;
    await new Promise((r) => setTimeout(r, 150));
    check("clearAll 之后不再响", fired.filter((x) => x === "周期").length === after, "clear 之后还在响");
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const base = shim.stats();
    for (let i = 0; i < 200; i++) {
      h.emit("Target.attachedToTarget", { sessionId: `C${i}`, targetInfo: { targetId: `T${i}`, type: "iframe", url: "https://x/" } }, "S_PAGE");
      h.emit("Target.detachedFromTarget", { sessionId: `C${i}` }, "S_PAGE");
    }
    const s = shim.stats();
    check(
      "200 轮 OOPIF attach/detach 之后会话表归零",
      s.sessionInfo === base.sessionInfo && s.sessionParent === base.sessionParent && s.sessionTab === base.sessionTab,
      `sessionInfo=${s.sessionInfo} sessionParent=${s.sessionParent} sessionTab=${s.sessionTab}`
    );
    check("targets 不跟着 OOPIF 的 attach/detach 涨", s.targets === base.targets, `targets ${base.targets} → ${s.targets}`);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const base = shim.stats();
    for (let i = 0; i < 50; i++) {
      h.emit("Target.attachedToTarget", { sessionId: `父${i}`, targetInfo: { targetId: `TP${i}`, type: "iframe", url: "" } }, "S_PAGE");
      h.emit("Target.attachedToTarget", { sessionId: `孙${i}`, targetInfo: { targetId: `TG${i}`, type: "iframe", url: "" } }, `父${i}`);
      h.emit("Target.detachedFromTarget", { sessionId: `父${i}` }, "S_PAGE");
    }
    const s = shim.stats();
    check(
      "父会话断开时孙会话跟着一起收（Chrome 不补送孙辈的 detach）",
      s.sessionInfo === base.sessionInfo && s.sessionParent === base.sessionParent,
      `sessionInfo=${s.sessionInfo} sessionParent=${s.sessionParent}`
    );
    check("嵌套 OOPIF 也不让 targets 涨", s.targets === base.targets, `targets ${base.targets} → ${s.targets}`);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const nums = [];
    for (let round = 0; round < 30; round++) {
      for (let f = 0; f < 5; f++) nums.push(shim.frameNum(h.page.tabId, `帧-${round}-${f}`));
      h.emit("Page.frameNavigated", { frame: { id: "PAGE_A", url: `https://x/${round}` } }, "S_PAGE");
    }
    const s = shim.stats();
    check("30 轮导航后帧编号表不涨（只剩主框架那一条）", s.frameIds <= 1, `frameIds=${s.frameIds}`);
    check("帧号从不复用（旧号码只会查不到，不会指到别的帧上）", new Set(nums).size === nums.length, `${nums.length} 个号里只有 ${new Set(nums).size} 个不同`);
    const again = shim.frameNum(h.page.tabId, "帧-0-0");
    check("退休后同一个帧再来拿到的是新号码，不是原来那个", again !== nums[0] && !nums.includes(again), `原 ${nums[0]} → 现 ${again}`);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    for (let i = 0; i < 40; i++) {
      shim.frameNum(h.page.tabId, `临时帧${i}`);
      h.emit("Page.frameDetached", { frameId: `临时帧${i}` }, "S_PAGE");
    }
    check("frameDetached 会让那个帧号退休", shim.stats().frameIds <= 1, `frameIds=${shim.stats().frameIds}`);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const removed = [];
    shim.chrome.tabGroups.onRemoved.addListener((g) => removed.push(g.id));
    const gid = await shim.chrome.tabs.group({ tabIds: [4242] });
    check("建组之后 query 看得到", (await shim.chrome.tabGroups.query({})).length === 1);
    await shim.chrome.tabs.ungroup([4242]);
    check("最后一张页离开，组就没了", (await shim.chrome.tabGroups.query({})).length === 0);
    check("组没了要报 onRemoved（组账本靠它销账）", removed.length === 1 && removed[0] === gid, JSON.stringify(removed));
    check("组表也跟着清空", shim.stats().groups === 0, `groups=${shim.stats().groups}`);
    const r = await throws(async () => await shim.chrome.tabs.group({ tabIds: [4242], groupId: gid }), /No group with id/);
    check("往一个已经没了的组里加页要抛错（不许悄悄另建一个）", r.threw && r.match, r.msg);
  }

  {
    const h = mkBrowser();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    await shim.chrome.tabs.group({ tabIds: [4242] });
    h.emit("Target.attachedToTarget", { sessionId: "娃", targetInfo: { targetId: "TT", type: "iframe", url: "" } }, "S_PAGE");
    shim.frameNum(h.page.tabId, "某个帧");
    h.destroy();
    const s = shim.stats();
    check(
      "标签页销毁后组/会话/帧表全部归零",
      s.groups === 0 && s.sessionInfo === 0 && s.sessionParent === 0 && s.frameMaps === 0,
      JSON.stringify(s)
    );
    check("那一轮 attach 也没往 targets 里加东西", s.targets === 1, `targets=${s.targets}`);
  }

  {
    const sent = [];
    const h = mkBrowser();
    let missLen = 0;
    h.browser.client.send = async (method, params, sessionId) => {
      sent.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "PAGE_A" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") {
        if (params.awaitPromise) return { result: { value: { __aic_v: "结果", __aic_m: missLen } } };
        return { result: { value: undefined } };
      }
      if (method === "DOM.getDocument")
        return {
          root: {
            backendNodeId: 1,
            frameId: "PAGE_A",
            children: [
              { backendNodeId: 2, shadowRoots: [{ shadowRootType: "closed", backendNodeId: 3 }] },
              { backendNodeId: 4, shadowRoots: [{ shadowRootType: "open", backendNodeId: 5 }] },
            ],
          },
        };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj" + params.backendNodeId } };
      return {};
    };
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
    const coolDown = () => new Promise((r) => setTimeout(r, 170));

    await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
    await coolDown();

    sent.length = 0;
    const r0 = await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
    check("注入结果从包裹里解出来（不带 __aic_v 壳）", r0[0]?.result === "结果", JSON.stringify(r0));
    check(
      "miss=0 时一条补种命令都不发（miss 数是注入捎带的，不另花往返）",
      !sent.includes("DOM.getDocument") && !sent.includes("DOM.describeNode"),
      sent.join(",")
    );

    await coolDown();
    sent.length = 0;
    missLen = 12;
    await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
    const gets = sent.filter((m) => m === "DOM.getDocument").length;
    check("miss>0 时整树差集只走一次 getDocument", gets === 1, `getDocument ${gets} 次，序列：${sent.join(",")}`);
    check("不再逐元素 describeNode 确认", !sent.includes("DOM.describeNode"), sent.join(","));
    check(
      "closed root 那一对在返回前已投进世界（await，不溢出到下一次调用）",
      sent.filter((m) => m === "DOM.resolveNode").length === 2 && sent.includes("Runtime.callFunctionOn"),
      sent.join(",")
    );

    await coolDown();
    sent.length = 0;
    await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
    await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
    const gets2 = sent.filter((m) => m === "DOM.getDocument").length;
    check("同一调用窗口里的多趟注入共享一份 pierce 文档", gets2 === 1, `getDocument ${gets2} 次`);
  }

  {
    for (const probe of [0, 1]) {
      const sent = [];
      const h = mkBrowser();
      h.browser.client.send = async (method, params) => {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "PAGE_A" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
        if (method === "Runtime.evaluate") {
          if (params.awaitPromise) return { result: { value: { __aic_v: 1, __aic_m: 0 } } };
          return { result: { value: probe } };
        }
        if (method === "DOM.getDocument") return { root: { backendNodeId: 1, frameId: "PAGE_A" } };
        return {};
      };
      const shim = createChromeShim(h.browser, { manifest: {}, stateDir: shimStateDir });
      await shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] });
      const gets = sent.filter((m) => m === "DOM.getDocument").length;
      check(
        probe ? "探到自定义元素：建世界时 seed 照付（getDocument 一次）" : "没探到自定义元素：整量 getDocument 一次都不拉",
        probe ? gets === 1 : gets === 0,
        `getDocument ${gets} 次`
      );
    }
  }

  fs.rmSync(shimStateDir, { recursive: true, force: true });
}

console.log("\n\x1b[1mCLI shim：session 区的印、事件分流、并发建世界\x1b[0m");
{
  const { createChromeShim } = await import("../mcp/cdp/chrome-shim.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-shim2-"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const mk = ({ pipe = false, send } = {}) => {
    const listeners = new Set();
    const handlers = { created: new Set(), destroyed: new Set(), changed: new Set() };
    const page = { targetId: "PAGE_A", type: "page", url: "about:blank", title: "", sessionId: "S_PAGE", tabId: 4242, windowId: 1 };
    const targets = new Map([["PAGE_A", page]]);
    return {
      page,
      targets,
      handlers,
      emit: (m, p, s) => {
        for (const fn of [...listeners]) fn(m, p, s);
      },
      browser: {
        client: {
          wsUrl: pipe ? null : "ws://127.0.0.1:9222/devtools/browser/GUID-1",
          onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
          send: send || (async () => ({})),
          closed: false,
        },
        targets,
        pages: () => [...targets.values()].filter((t) => t.type === "page"),
        tryByTabId: (id) => [...targets.values()].find((t) => t.tabId === Number(id) && t.type === "page") || null,
        byTabId: (id) => {
          const r = [...targets.values()].find((t) => t.tabId === Number(id) && t.type === "page");
          if (!r) throw new Error(`标签页 ${id} 不在了`);
          return r;
        },
        session: async () => "S_PAGE",
        send: send ? async (rec, m, p) => send(m, p, rec.sessionId) : async () => ({}),
        on: (kind, fn) => (handlers[kind].add(fn), () => handlers[kind].delete(fn)),
      },
    };
  };

  {
    const s1 = createChromeShim(mk({ pipe: true }).browser, { manifest: {}, stateDir: dir, instanceStamp: "pid1:t1" });
    await s1.chrome.storage.session.set({ "aic-sessions-v1": { tabOwner: [[7, "s1"]] } });
    await s1.chrome.storage.local.set({ cursorOn: false });

    const same = createChromeShim(mk({ pipe: true }).browser, { manifest: {}, stateDir: dir, instanceStamp: "pid1:t1" });
    const seenSame = await same.chrome.storage.session.get("aic-sessions-v1");
    check(
      "同一个浏览器（同一枚印）的另一个 MCP 进程照旧读得到会话归属",
      seenSame["aic-sessions-v1"]?.tabOwner?.[0]?.[0] === 7,
      JSON.stringify(seenSame)
    );

    const other = createChromeShim(mk({ pipe: true }).browser, { manifest: {}, stateDir: dir, instanceStamp: "pid2:t2" });
    const seenOther = await other.chrome.storage.session.get("aic-sessions-v1");
    check(
      "管道模式下换了浏览器实例，session 区当空的（印不再恒为 \"null\"）",
      Object.keys(seenOther).length === 0,
      JSON.stringify(seenOther)
    );
    const localOther = await other.chrome.storage.local.get("cursorOn");
    check("local 区不受印影响，照旧留着", localOther.cursorOn === false, JSON.stringify(localOther));

    const a = createChromeShim(mk({ pipe: true }).browser, { manifest: {}, stateDir: dir });
    await a.chrome.storage.session.set({ 只有我: 1 });
    const b = createChromeShim(mk({ pipe: true }).browser, { manifest: {}, stateDir: dir });
    const seenB = await b.chrome.storage.session.get("只有我");
    check("没给印又没有 wsUrl 时，两个 shim 也不许共享 session 区", Object.keys(seenB).length === 0, JSON.stringify(seenB));
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const seen = [];
    shim.chrome.tabs.onUpdated.addListener((id, ch) => seen.push(ch.status));
    h.emit("Page.frameStartedLoading", { frameId: "PAGE_A" }, "S_PAGE");
    h.emit("Page.frameStoppedLoading", { frameId: "子帧-广告" }, "S_PAGE");
    check("子帧 stoppedLoading 不把整页标成 complete", !seen.includes("complete"), JSON.stringify(seen));
    h.emit("Page.frameStoppedLoading", { frameId: "PAGE_A" }, "S_PAGE");
    check("主框架 stoppedLoading 才算整页加载完", seen.includes("complete"), JSON.stringify(seen));
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const evs = [];
    shim.chrome.debugger.onEvent.addListener((src, method) => evs.push(`${src.tabId}:${method}`));
    h.emit("Target.attachedToTarget", { sessionId: "娃", targetInfo: { targetId: "TT", type: "iframe", url: "" } }, "S_PAGE");
    h.emit("Target.detachedFromTarget", { sessionId: "娃" }, "S_PAGE");
    check("attach 转给了工具层", evs.includes("4242:Target.attachedToTarget"), JSON.stringify(evs));
    check("detach 也要转（否则 oopifSessions 只增不减）", evs.includes("4242:Target.detachedFromTarget"), JSON.stringify(evs));
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const det = [];
    shim.chrome.debugger.onDetach.addListener((src, reason) => det.push(`${src.tabId}:${reason}`));
    await shim.chrome.debugger.detach({ tabId: 4242 });
    check("自己 detach 不发 onDetach（真 Chrome 也不发）", det.length === 0, JSON.stringify(det));
  }

  {
    let worlds = 0;
    let nextCtx = 100;
    const h = mk({
      send: async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "PAGE_A" } } };
        if (method === "Page.createIsolatedWorld") {
          worlds++;
          await sleep(10);
          return { executionContextId: nextCtx++ };
        }
        if (method === "Runtime.evaluate") {
          if (params.awaitPromise) return { result: { value: { __aic_v: params.contextId, __aic_m: 0 } } };
          return { result: { value: 0 } };
        }
        return {};
      },
    });
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const [r1, r2] = await Promise.all([
      shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] }),
      shim.chrome.scripting.executeScript({ target: { tabId: 4242 }, func: function () {}, args: [] }),
    ]);
    check("并发两次注入只建一个隔离世界", worlds === 1, `建了 ${worlds} 个`);
    check("两次注入落在同一个世界里（ref 表才活得下来）", r1[0]?.result === r2[0]?.result, JSON.stringify([r1[0]?.result, r2[0]?.result]));
  }

  {
    const h = mk({});
    h.browser.client.send = async (method, params) => {
      if (method === "Target.closeTarget") {
        setTimeout(() => h.targets.delete(params.targetId), 30);
        return {};
      }
      return {};
    };
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    await shim.chrome.tabs.remove([4242]);
    check("remove 返回时那张页已经不在 target 表里了", !h.targets.has("PAGE_A"), `targets=${[...h.targets.keys()]}`);
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    let unhandled = null;
    const onUnh = (e) => (unhandled = e);
    process.on("unhandledRejection", onUnh);
    shim.chrome.tabs.get(4242, () => {
      throw new Error("回调自己炸了");
    });
    await sleep(30);
    process.off("unhandledRejection", onUnh);
    check("回调抛异常不会漏成 unhandledRejection", unhandled === null, String(unhandled?.message || unhandled));
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    check("chrome.storage.sync 在", typeof shim.chrome.storage.sync?.get === "function");
    await shim.chrome.storage.sync.set({ sepWin: true });
    const viaLocal = await shim.chrome.storage.local.get("sepWin");
    check("sync 指向 local 同一份（同机同一份数据）", viaLocal.sepWin === true, JSON.stringify(viaLocal));

    const changes = [];
    shim.chrome.storage.onChanged.addListener((c, area) => changes.push([area, JSON.parse(JSON.stringify(c))]));
    await shim.chrome.storage.local.set({ 甲: 1 });
    await shim.chrome.storage.local.set({ 甲: 2 });
    await shim.chrome.storage.local.set({ 甲: 2 });
    await shim.chrome.storage.local.remove("甲");
    check("set 新键发 onChanged（只有 newValue）", changes[0]?.[1]?.甲?.newValue === 1 && !("oldValue" in (changes[0]?.[1]?.甲 || {})), JSON.stringify(changes[0]));
    check("改值发 onChanged（带 oldValue）", changes[1]?.[1]?.甲?.oldValue === 1 && changes[1]?.[1]?.甲?.newValue === 2, JSON.stringify(changes[1]));
    check("值没变不发", changes.length === 3, JSON.stringify(changes.map((c) => c[1])));
    check("remove 发 onChanged（只有 oldValue）", changes[2]?.[1]?.甲?.oldValue === 2, JSON.stringify(changes[2]));
    check("areaName 报得对", changes[0]?.[0] === "local", JSON.stringify(changes[0]));
  }

  {
    const h = mk();
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const all = await shim.chrome.windows.getAll({});
    check("windows.getAll 在，且给的是数组", Array.isArray(all) && all.length === 1, JSON.stringify(all));
    const last = await shim.chrome.windows.getLastFocused({});
    check("windows.getLastFocused 在", last?.id === 1, JSON.stringify(last));
    const w = await shim.chrome.windows.create({ url: "about:blank" });
    check("windows.create 如实报「建不出来」（返回 null，不假装成功）", w === null, JSON.stringify(w));
    const pop = await shim.chrome.windows.getAll({ populate: true });
    check("populate 时把标签页带上", pop[0]?.tabs?.[0]?.id === 4242, JSON.stringify(pop[0]?.tabs));
  }

  {
    const h = mk();
    for (let i = 0; i < 9; i++) {
      const id = `P${i}`;
      h.targets.set(id, { targetId: id, type: "page", url: "", title: "", sessionId: null, tabId: 100 + i, windowId: 1 });
    }
    const sent = [];
    h.browser.client.send = async (method) => {
      sent.push(method);
      if (method === "Target.getTargets")
        return { targetInfos: [...h.targets.values()].map((t) => ({ targetId: t.targetId, type: "page", url: "u", title: "t" })) };
      return {};
    };
    const shim = createChromeShim(h.browser, { manifest: {}, stateDir: dir });
    const list = await shim.chrome.tabs.query({});
    check("10 张页照样全列出来", list.length === 10, `列了 ${list.length} 张`);
    check("url/title 确实刷新到了最新", list.every((t) => t.url === "u" && t.title === "t"), JSON.stringify(list[0]));
    check(
      "10 张页只发 1 次 CDP（原来是每页一次 Target.getTargetInfo，10 次）",
      sent.length === 1 && sent[0] === "Target.getTargets",
      `发了 ${sent.length} 条：${sent.join(",")}`
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mCLI shim：浏览器死了之后原地换绑（rebind）\x1b[0m");
{
  const { createChromeShim } = await import("../mcp/cdp/chrome-shim.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-rebind-"));
  const tick = () => new Promise((r) => setTimeout(r, 5));

  const mkBrowser = (tag, tabIds) => {
    const listeners = new Set();
    const handlers = { created: new Set(), destroyed: new Set(), changed: new Set() };
    const targets = new Map();
    tabIds.forEach((tabId, i) => {
      targets.set(`${tag}_T${i}`, {
        targetId: `${tag}_T${i}`, type: "page", url: "about:blank", title: "",
        sessionId: `${tag}_S${i}`, tabId, windowId: 1,
      });
    });
    const sent = [];
    let nextNew = 0;
    const client = {
      wsUrl: `ws://127.0.0.1/devtools/browser/${tag}`,
      closed: false,
      onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      onClose: () => () => {},
      close: () => (client.closed = true),
      send: async (m, p = {}) => {
        sent.push(m);
        if (m === "Target.createTarget") {
          const id = `${tag}_N${nextNew++}`;
          targets.set(id, { targetId: id, type: "page", url: p.url || "", title: "", sessionId: `${id}_S`, tabId: 900 + nextNew, windowId: 1 });
          return { targetId: id };
        }
        if (m === "Target.getTargets")
          return { targetInfos: [...targets.values()].map((t) => ({ targetId: t.targetId, type: "page", url: t.url, title: t.title })) };
        return {};
      },
    };
    const br = {
      client, targets, sent,
      emit: (m, p, s) => { for (const fn of [...listeners]) fn(m, p, s); },
      pages: () => [...targets.values()].filter((t) => t.type === "page"),
      tryByTabId: (id) => [...targets.values()].find((t) => t.tabId === Number(id)) || null,
      byTabId: (id) => {
        const r = br.tryByTabId(id);
        if (!r) throw new Error(`标签页 ${id} 不在了`);
        return r;
      },
      session: async (rec) => rec.sessionId,
      send: async (rec, m) => (sent.push(m), {}),
      on: (kind, fn) => (handlers[kind].add(fn), () => handlers[kind].delete(fn)),
      activeTargetId: null,
    };
    return br;
  };

  {
    const A = mkBrowser("A", [11, 12]);
    const B = mkBrowser("B", [77]);
    const shim = createChromeShim(A, { manifest: {}, stateDir: dir, instanceStamp: "A" });

    await shim.chrome.debugger.attach({ tabId: 11 }, "1.3");
    await shim.chrome.debugger.attach({ tabId: 12 }, "1.3");
    const gid = await shim.chrome.tabs.group({ tabIds: [11, 12] });
    A.emit("Target.attachedToTarget", { sessionId: "A_OOPIF", targetInfo: { targetId: "A_IF", type: "iframe", url: "https://x/" } }, "A_S0");

    const detached = [];
    const removed = [];
    const groupsGone = [];
    shim.chrome.debugger.onDetach.addListener((src, reason) => detached.push([src.tabId, reason]));
    shim.chrome.tabs.onRemoved.addListener((tabId, info) => removed.push([tabId, info]));
    shim.chrome.tabGroups.onRemoved.addListener((g) => groupsGone.push(g.id));

    const before = shim.stats();
    check("换绑前：两张页 attach 着、有一个组、有一条 OOPIF 会话",
      before.attachedTabs === 2 && before.groups === 1 && before.sessionTab === 3,
      JSON.stringify(before));

    await shim.rebind(B, { instanceStamp: "B" });

    check("每张 attach 着的页都发了 onDetach，reason 用 Chrome 的 target_closed",
      detached.length === 2 && detached.every(([, r]) => r === "target_closed") &&
        detached.map(([t]) => t).sort((a, b) => a - b).join() === "11,12",
      JSON.stringify(detached));
    check("旧浏览器的每张页都发了 tabs.onRemoved（isWindowClosing:true，浏览器整体退出）",
      removed.length === 2 && removed.every(([, i]) => i.isWindowClosing === true) &&
        removed.map(([t]) => t).sort((a, b) => a - b).join() === "11,12",
      JSON.stringify(removed));
    check("旧浏览器的标签组发了 tabGroups.onRemoved", groupsGone.join() === String(gid), JSON.stringify(groupsGone));

    const after = shim.stats();
    check("绑着旧实例的表全部清空（attach/组/OOPIF 会话/加载状态/隔离世界）",
      after.attachedTabs === 0 && after.groups === 0 && after.childSessions === 0 &&
        after.sessionParent === 0 && after.sessionInfo === 0 && after.worldByFrame === 0 && after.loadState === 0,
      JSON.stringify(after));
    check("帧号表和会话表重新按新浏览器的页建起来（1 张页）",
      after.frameMaps === 1 && after.sessionTab === 1 && after.targets === 1,
      JSON.stringify(after));

    const gid2 = await shim.chrome.tabs.group({ tabIds: [77] });
    check("组号不复用（新组的 id 比旧的大）", gid2 > gid, `旧 ${gid} 新 ${gid2}`);
  }

  {
    const A = mkBrowser("A", [11]);
    const B = mkBrowser("B", [77]);
    const shim = createChromeShim(A, { manifest: {}, stateDir: dir, instanceStamp: "A" });
    await shim.rebind(B, { instanceStamp: "B" });

    A.sent.length = 0;
    B.sent.length = 0;
    const t = await shim.chrome.tabs.create({ url: "https://example.com/" });
    check("new_tab 发到新浏览器（旧的一条都没收到）",
      B.sent.includes("Target.createTarget") && A.sent.length === 0,
      `A=${A.sent.join(",")} B=${B.sent.join(",")}`);
    check("新页的 tabId 来自新浏览器", t && t.id === 901, JSON.stringify(t));

    A.sent.length = 0;
    B.sent.length = 0;
    await shim.chrome.debugger.attach({ tabId: 77 }, "1.3");
    check("attach 也发到新浏览器", B.sent.includes("Page.enable") && A.sent.length === 0,
      `A=${A.sent.join(",")} B=${B.sent.join(",")}`);

    const evts = [];
    shim.chrome.debugger.onEvent.addListener((src, m) => evts.push(m));
    A.emit("Page.loadEventFired", {}, "A_S0");
    B.emit("Page.loadEventFired", {}, "B_S0");
    check("旧浏览器的 CDP 事件不再转给工具层，只转新的那条",
      evts.length === 1 && evts[0] === "Page.loadEventFired", JSON.stringify(evts));
  }

  {
    const A = mkBrowser("A", [11]);
    const B = mkBrowser("B", [77]);
    const shim = createChromeShim(A, { manifest: {}, stateDir: dir, instanceStamp: "stampA" });
    await shim.chrome.storage.session.set({ aic: { tabs: [11] } });
    check("换绑前读得回来", JSON.stringify((await shim.chrome.storage.session.get("aic")).aic) === '{"tabs":[11]}');
    await shim.rebind(B, { instanceStamp: "stampB" });
    const got = await shim.chrome.storage.session.get("aic");
    check("换绑后 session 区当空的（印变了 = 上一个浏览器留下的）", got.aic === undefined, JSON.stringify(got));
  }

  {
    const A = mkBrowser("A", [11, 12]);
    const B = mkBrowser("B", [77]);
    const swDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-rebind-sw-"));
    const shim = createChromeShim(A, { manifest: { version: "0.0.0" }, stateDir: swDir, instanceStamp: "A" });
    const st = {};
    loadSw(st, shim.chrome);
    const sb = st.sandbox;
    await sb.__restore();

    const tabs = sb.__perTabTables();
    for (const tabId of [11, 12]) {
      tabs.ourTabs.add(tabId);
      tabs.tabOwner.set(tabId, "s1");
      tabs.attached.add(tabId);
      await shim.chrome.storage.local.set({ [`aic-our-${tabId}`]: 1 });
    }
    sb.__sessions.set("s1", { tabs: [{ tabId: 11 }, { tabId: 12 }], groupId: 5, label: "t", color: "blue" });
    await shim.chrome.debugger.attach({ tabId: 11 }, "1.3");
    await shim.chrome.debugger.attach({ tabId: 12 }, "1.3");

    await shim.rebind(B, { instanceStamp: "B" });
    await tick();

    check("sw.js 侧：ourTabs 里没有死浏览器的 tabId", tabs.ourTabs.size === 0, [...tabs.ourTabs].join());
    check("sw.js 侧：tabOwner 清干净", tabs.tabOwner.size === 0, [...tabs.tabOwner.keys()].join());
    check("sw.js 侧：attached 清干净", tabs.attached.size === 0, [...tabs.attached].join());
    check("sw.js 侧：会话手上不再挂着死页", (sb.__sessions.get("s1")?.tabs || []).length === 0,
      JSON.stringify(sb.__sessions.get("s1")));
    const led = await shim.chrome.storage.local.get(null);
    check("sw.js 侧：页账本里那两笔也销了",
      !Object.keys(led).some((k) => k === "aic-our-11" || k === "aic-our-12"), Object.keys(led).join());
    fs.rmSync(swDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mCDP 桥接：起不来要收掉浏览器，浏览器死了要能原地重连\x1b[0m");
{
  const { startCdpBridge } = await import("../mcp/cdp/bridge.mjs");
  const savedChrome = globalThis.chrome;

  const mkDeps = (over = {}) => {
    const calls = { stop: 0, ensure: 0 };
    const client = { closed: false, close: () => (client.closed = true), onClose: () => () => {} };
    const base = {
      ensureBrowser: async () => (calls.ensure++, { pid: 1, startedAt: "t0", kind: "chrome", version: "v", headless: true, profileDir: os.tmpdir(), wsUrl: "ws://x/devtools/browser/g" }),
      stopBrowser: () => calls.stop++,
      connect: async () => ({ client }),
      createChromeShim: () => ({ chrome: {}, setOnFromSw: () => {}, sendToSw: () => {}, stats: () => ({}), rebind: async () => {} }),
      importSw: async () => {},
      keepBrowser: () => false,
    };
    return { deps: { ...base, ...over }, calls, client };
  };

  for (const [what, over] of [
    ["连不上浏览器", { connect: async () => { throw new Error("连不上"); } }],
    ["shim 建不起来", { createChromeShim: () => { throw new Error("shim 挂了"); } }],
    ["import sw.js 抛了", { importSw: async () => { throw new Error("sw 挂了"); } }],
  ]) {
    const { deps, calls } = mkDeps(over);
    let err = null;
    await startCdpBridge({ onFrame: () => {}, deps }).catch((e) => (err = e));
    check(`${what}：异常照原样抛出去`, !!err, String(err));
    check(`${what}：刚起的浏览器被收掉（stopBrowser 一次）`, calls.stop === 1, `调了 ${calls.stop} 次`);

    const keep = mkDeps({ ...over, keepBrowser: () => true });
    await startCdpBridge({ onFrame: () => {}, deps: keep.deps }).catch(() => {});
    check(`${what}：KEEP=1 时浏览器留着不收`, keep.calls.stop === 0, `调了 ${keep.calls.stop} 次`);
  }

  {
    const rebinds = [];
    const closed = [];
    let n = 0;
    const clients = [];
    const mkClient = () => {
      const c = { closed: false, close: (why) => ((c.closed = true), closed.push(why)), onClose: () => () => {} };
      clients.push(c);
      return c;
    };
    let connectImpl = async () => ({ client: mkClient() });
    let stopImpl = () => {};
    const deps = {
      ensureBrowser: async () => ({ pid: ++n, startedAt: `t${n}`, kind: "chrome", version: "v", headless: true, profileDir: os.tmpdir(), wsUrl: `ws://x/devtools/browser/g${n}` }),
      stopBrowser: () => stopImpl(),
      connect: (t) => connectImpl(t),
      createChromeShim: () => ({
        chrome: {}, setOnFromSw: () => {}, sendToSw: () => {}, stats: () => ({}),
        rebind: async (b, o) => rebinds.push(o.instanceStamp),
      }),
      importSw: async () => {},
      keepBrowser: () => false,
    };
    const h = await startCdpBridge({ onFrame: () => {}, deps });
    check("桥接起来时 ready()", h.ready() === true);

    clients[0].closed = true;
    check("浏览器退出后 ready() 立刻变假", h.ready() === false);

    const [a, b] = await Promise.all([h.reconnect(), h.reconnect()]);
    check("重连是单飞：并发两次只起一个浏览器", n === 2, `起了 ${n} 个`);
    check("两个调用拿到同一个结果", a === b && a.pid === 2, JSON.stringify(a));
    check("shim 换绑到新浏览器，并带上新实例的印", rebinds.join() === "2:t2", rebinds.join());
    check("重连之后 ready() 又是真的（看的是新连接）", h.ready() === true);
    check("旧连接被收掉（管道模式下 fd 还挂着、在途命令还吊着）", clients[0].closed === true);
    check("句柄上的 info 换成了新浏览器那份", h.info.pid === 2, JSON.stringify(h.info));

    let stopped = 0;
    stopImpl = () => stopped++;
    connectImpl = async () => {
      throw new Error("第二次连不上");
    };
    let e2 = null;
    await h.reconnect().catch((e) => (e2 = e));
    check("重连失败时异常照原样抛出去", String(e2?.message) === "第二次连不上", String(e2));
    check("重连失败时把刚起的浏览器收掉", stopped === 1, `调了 ${stopped} 次`);

    connectImpl = async () => ({ client: mkClient() });
    const again = await h.reconnect();
    check("失败之后还能再试（单飞的 promise 已经清掉）", again.pid === 4, JSON.stringify(again));
  }

  {
    let n = 0;
    const sent = [];
    const clients = [];
    const mkClient = () => {
      const c = { closed: false, close: () => (c.closed = true), onClose: () => () => {} };
      clients.push(c);
      return c;
    };
    let stopped = 0;
    const deps = {
      ensureBrowser: async () => ({ pid: ++n, startedAt: `t${n}`, kind: "chrome", version: "v", headless: true, profileDir: os.tmpdir(), wsUrl: `ws://x/devtools/browser/g${n}` }),
      stopBrowser: () => stopped++,
      connect: async () => ({ client: mkClient() }),
      createChromeShim: () => ({
        chrome: {}, setOnFromSw: () => {}, stats: () => ({}),
        sendToSw: (m) => sent.push(m),
        rebind: async () => {},
      }),
      importSw: async () => {},
      keepBrowser: () => false,
    };
    const h = await startCdpBridge({ onFrame: () => {}, deps });
    check("桥接活着时 send 送得出去", h.send({ type: "call", id: "a" }) === true && sent.length === 1, `sent=${sent.length}`);

    clients[0].closed = true;
    const ok = h.send({ type: "call", id: "b" });
    check("浏览器没了：send 打回 false（调用方据此去自愈）", ok === false, `返回了 ${ok}`);
    check("浏览器没了：那一帧一个字都没进工具层", sent.length === 1, `工具层收到 ${sent.length} 帧`);

    await h.reconnect();
    check("重新拉起之后 send 又通了", h.send({ type: "call", id: "c" }) === true && sent.length === 2, `sent=${sent.length}`);

    const stopBefore = stopped;
    h.close({ keepBrowser: false, peersLeft: 0 });
    check("close() 收浏览器走的是注入进来的实现，不碰真账本", stopped === stopBefore + 1, `stopped ${stopBefore} → ${stopped}`);
    check("close() 之后 send 一律打回", h.send({ type: "call", id: "d" }) === false && sent.length === 2, `sent=${sent.length}`);
    let e3 = null;
    await h.reconnect().catch((e) => (e3 = e));
    check("close() 之后 reconnect 直接拒绝（不会起出没人管的浏览器）", !!e3 && n === 2, `n=${n} err=${e3?.message}`);
  }

  globalThis.chrome = savedChrome;
}

console.log("\n\x1b[1mchrome.* 成员缺失时的降级（CLI/CDP 模式的 shim 是个子集）\x1b[0m");
{
  const st = freshState();
  const ch = makeChrome(st);
  delete ch.windows.getAll;
  delete ch.windows.create;
  const T = loadSw(st, ch);
  st.localStorage.sepWin = true;
  let err = null;
  const r = await T.new_tab({ url: "https://a.example.com" }, "s1").catch((e) => ((err = e), null));
  check("windows.getAll 缺席时 new_tab 不整个失败", !err, String(err?.message || err));
  check("降级成在当前窗口开普通标签页", !!r?.tabId && st.tabs.some((t) => t.id === r.tabId), JSON.stringify(r));
}

console.log("\n\x1b[1m无角色大遮罩的判定（pickOverlayCandidates）\x1b[0m");
{
  const st = freshState();
  loadSw(st);
  const pick = st.sandbox.__pickOverlay;
  const probe = (facts, over = {}) => ({ vw: 1000, vh: 600, bodyTextLen: 10000, facts, ...over });
  const F = (rect, textLen, i = 0, title = "") => ({ i, rect, textLen, title });

  const zhihu = pick(probe([F({ x: 0, y: 0, w: 995, h: 595 }, 300)]));
  check("知乎形态（盖99%、文本占比3%）被选中", zhihu.length === 1 && zhihu[0].coverage >= 98);

  check("App shell（文本占比≈100%）被排除", pick(probe([F({ x: 0, y: 0, w: 1000, h: 600 }, 9800)])).length === 0);

  check("固定页头（盖10%）被排除", pick(probe([F({ x: 0, y: 0, w: 1000, h: 60 }, 100)])).length === 0);

  check("空白页（bodyTextLen=0）不选任何候选", pick(probe([F({ x: 0, y: 0, w: 995, h: 595 }, 0)], { bodyTextLen: 0 })).length === 0);

  const half = pick(probe([F({ x: 500, y: 0, w: 2000, h: 600 }, 100)]));
  check("视口外的面积不计入覆盖率（一半在外=50%<60%）", half.length === 0);

  const many = pick(probe([
    F({ x: 0, y: 0, w: 800, h: 600 }, 10, 0),
    F({ x: 0, y: 0, w: 1000, h: 600 }, 10, 1),
    F({ x: 0, y: 0, w: 900, h: 600 }, 10, 2),
    F({ x: 0, y: 0, w: 850, h: 600 }, 10, 3),
  ]));
  check("覆盖率降序且最多 3 个", many.length === 3 && many[0].i === 1 && many[1].i === 2);

  check("probe 为 null 时返回空", pick(null).length === 0);
  check("facts 形状不对时返回空", pick(probe([{ i: 0 }, { i: 1, rect: null }])).length === 0);
  check("视口为 0 时返回空", pick(probe([F({ x: 0, y: 0, w: 995, h: 595 }, 10)], { vw: 0 })).length === 0);

  const long = pick(probe([F({ x: 0, y: 0, w: 1000, h: 600 }, 10, 0, "标".repeat(300))]));
  check("title 截断到 120 字符", long.length === 1 && long[0].title.length === 120);
}

console.log("\n\x1b[1m冷启动路径：别冻事件循环、别重复 spawn、别每行都 stat\x1b[0m");
{
  const BL = pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href;
  const { waitGone, waitGoneAsync } = await import(BL);

  {
    let ticked = 0;
    const t = setInterval(() => ticked++, 5);
    waitGone([7], { isAlive: () => true, totalMs: 80, stepMs: 10 });
    clearInterval(t);
    check("同步版等待期间事件循环是冻住的（这正是不能在 server 里用它的理由）", ticked === 0, `定时器跑了 ${ticked} 次`);
  }
  {
    let ticked = 0;
    const t = setInterval(() => ticked++, 5);
    await waitGoneAsync([7], { isAlive: () => true, totalMs: 80, stepMs: 10 });
    clearInterval(t);
    check("异步版等同样久，但事件循环照转", ticked > 0, `定时器跑了 ${ticked} 次`);
  }
  check(
    "ensureBrowser 走的是异步版（它在 server listen 之后跑）",
    /await sweepOrphansAsync\(/.test(fs.readFileSync(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs"), "utf8"))
  );

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-ver-"));
    const tally = path.join(tmp, "tally");
    const bin = path.join(tmp, "fake-chrome");
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> ${tally}\necho "Google Chrome 151.0.7999.1"\n`);
    fs.chmodSync(bin, 0o755);
    const out = execFileSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(BL)}).then((m) => { for (let i = 0; i < 5; i++) m.browserArgs({ headless: true, bin: ${JSON.stringify(bin)} }); console.log("done"); })`],
      { encoding: "utf8", env: { ...process.env, HOME: tmp } }
    );
    const runs = fs.existsSync(tally) ? fs.readFileSync(tally, "utf8").trim().split("\n").length : 0;
    check("5 次 browserArgs 只 spawn 一次 --version（原来是 5 次）", runs === 1, `spawn 了 ${runs} 次（${out.trim()}）`);
    const args = execFileSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(BL)}).then((m) => console.log(m.browserArgs({ headless: true, bin: ${JSON.stringify(bin)} }).join("\\n")))`],
      { encoding: "utf8", env: { ...process.env, HOME: tmp } }
    );
    check("缓存的版本号确实用上了（UA 里是 151）", /--user-agent=.*Chrome\/151\.0\.0\.0/.test(args), (args.match(/--user-agent=.*/) || [""])[0]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-log-"));
    const count = (mod) =>
      Number(
        execFileSync(
          process.execPath,
          [
            "-e",
            `import("node:fs").then(async (fsm) => {
               const fs2 = fsm.default;
               const m = await import(${JSON.stringify("MODPLACEHOLDER")});
               const real = fs2.statSync;
               let n = 0;
               fs2.statSync = (...a) => { n++; return real(...a); };
               for (let i = 0; i < 200; i++) m.log("第", i, "行");
               fs2.statSync = real;
               process.stdout.write(String(n));
             });`.replace("MODPLACEHOLDER", mod),
          ],
          { encoding: "utf8", env: { ...process.env, HOME: tmp }, stdio: ["ignore", "pipe", "ignore"] }
        ).trim()
      );
    const n = count(BL);
    check("200 行日志的 statSync 次数远少于 200（原来是每行一次）", n <= 5, `stat 了 ${n} 次`);
    check("日志本身照写", fs.existsSync(path.join(tmp, ".agent-in-chrome", "agent-in-chrome.log")) || fs.readdirSync(path.join(tmp, ".agent-in-chrome")).length > 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n\x1b[1m弹窗「已连接 agent」= 管子在 且 host 那头连着 agent\x1b[0m");
{
  const st = freshState();
  loadSw(st);
  const status = async () => {
    let got = null;
    st.chrome.runtime.onMessage._fire({ type: "popup-status" }, {}, (x) => (got = x));
    await new Promise((r) => setTimeout(r, 30));
    return got;
  };
  check("老 host（从不发 agent-link）：退化成老行为，显示已连接", (await status())?.connected === true);

  st.hostPort.onMessage._fire({ type: "agent-link", up: false });
  check("host 报「连不上 agent」：弹窗显示未连接（管子还在，但发不出去）", (await status())?.connected === false);

  st.hostPort.onMessage._fire({ type: "agent-link", up: true });
  check("host 报「连上了」：恢复已连接", (await status())?.connected === true);

  st.hostPort.onMessage._fire({ type: "agent-link", up: true });
  st.hostPort.onDisconnect._fire();
  check("管子断了就是未连接", (await status())?.connected === false);
}
{
  const popup = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");
  const about = fs.readFileSync(path.join(ROOT, "extension", "about.js"), "utf8");
  const pick = (src) => (src.match(/"未连接（[^"]*）"/) || [])[0];
  check("popup 与 about 的「未连接」文案一致", pick(popup) && pick(popup) === pick(about), `${pick(popup)} vs ${pick(about)}`);
}

console.log("\n\x1b[1mcli-browser.mjs：默认传输下必须能跑通\x1b[0m");
{
  const src = fs.readFileSync(path.join(ROOT, "scripts", "cli-browser.mjs"), "utf8");
  check(
    "没有静态 import browser-launch（那会跑在设默认值之前）",
    !/^import\s[^;]*browser-launch\.mjs/m.test(src),
    (src.match(/^import\s[^;]*browser-launch\.mjs.*/m) || [""])[0]
  );
  const keepAt = src.indexOf("AGENT_IN_CHROME_KEEP");
  const importAt = src.indexOf('await import("../mcp/cdp/browser-launch.mjs")');
  check("KEEP 的默认值设在 import browser-launch 之前", keepAt > 0 && importAt > keepAt, `keep@${keepAt} import@${importAt}`);
  check("用 ??= 而不是硬赋值（用户显式指定仍然优先）", /AGENT_IN_CHROME_KEEP\s*\?\?=/.test(src));
  check(
    "连接时两种传输都接得住（管道给 {pipe}，端口给 wsUrl）",
    /Browser\.connect\(info\.pipe \? \{ pipe: info\.pipe \} : info\.wsUrl\)/.test(src),
    (src.match(/Browser\.connect\(.*\)/) || [""])[0]
  );
}
{
  const run = (env) =>
    execFileSync(process.execPath, ["-e", 'import("' + pathToFileURL(path.join(ROOT, "mcp", "cdp", "browser-launch.mjs")).href + '").then((m) => console.log(String(m.USE_PIPE)))'], {
      encoding: "utf8",
      env: { ...process.env, AGENT_IN_CHROME_CDP_TRANSPORT: "", ...env },
    }).trim();
  check("默认（不设 KEEP）走管道", run({ AGENT_IN_CHROME_KEEP: "" }) === "true", run({ AGENT_IN_CHROME_KEEP: "" }));
  check("KEEP=1 走端口（浏览器才留得住，烘热和 e2e 全靠这条）", run({ AGENT_IN_CHROME_KEEP: "1" }) === "false", run({ AGENT_IN_CHROME_KEEP: "1" }));
}

console.log("\n\x1b[1m日志轮转\x1b[0m");
{
  const { rotateIfBig } = await import("../mcp/cdp/browser-launch.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-log-"));
  const f = path.join(dir, "x.log");
  check("文件不存在时不抛也不轮转", rotateIfBig(f, 100) === false);
  fs.writeFileSync(f, "a".repeat(50));
  check("没到上限不轮转", rotateIfBig(f, 100) === false && !fs.existsSync(`${f}.1`));
  fs.writeFileSync(f, "a".repeat(200));
  check("超了上限就轮转成 .1", rotateIfBig(f, 100) === true && fs.existsSync(`${f}.1`) && !fs.existsSync(f));
  fs.writeFileSync(f, "a".repeat(200));
  rotateIfBig(f, 100);
  check("只留一代：再轮转一次会盖掉旧的 .1", fs.readFileSync(`${f}.1`, "utf8").length === 200);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[1mvariations 种子清理\x1b[0m");
{
  const { scrubVariationsSeed } = await import("../mcp/cdp/browser-launch.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-seed-"));
  check("空 profile 不抛、报告没删东西", scrubVariationsSeed(dir).length === 0);
  for (const f of ["Variations", "VariationsSeedV2", "VariationsSafeSeedV2"]) fs.writeFileSync(path.join(dir, f), "x");
  fs.mkdirSync(path.join(dir, "Default"));
  fs.writeFileSync(path.join(dir, "Default", "Cookies"), "登录态");
  fs.writeFileSync(path.join(dir, "Local State"), "{}");
  const removed = scrubVariationsSeed(dir);
  check("三个种子文件全删掉", removed.length === 3 && !fs.existsSync(path.join(dir, "VariationsSafeSeedV2")));
  check("Default/（登录态）一根毛都不碰", fs.readFileSync(path.join(dir, "Default", "Cookies"), "utf8") === "登录态");
  check("Local State 不碰", fs.existsSync(path.join(dir, "Local State")));
  check("再跑一遍幂等", scrubVariationsSeed(dir).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} 通过, ${failed} 失败\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
