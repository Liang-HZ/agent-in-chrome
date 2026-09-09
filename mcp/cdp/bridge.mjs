// CLI/headless 模式的桥接：把「扩展 → native host → unix socket → MCP server」
// 这三级压成一级——工具层就在本进程里跑，直接用 CDP 说话。
//
//   桌面模式  MCP server ──socket── native host ──stdio── 扩展(SW) ──调试器 API── 浏览器
//   CLI 模式  MCP server ── 内存里的假 port ── sw.js(同进程) ── 直连 CDP ── 浏览器
//
// 两边跑的是**同一个 sw.js**，所以工具行为一致；差别只在它脚下那层 chrome.*
// 是 Chrome 给的还是 cdp/chrome-shim.mjs 给的。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBrowser, stopBrowser, markAdoptable, HEADLESS, KEEP_BROWSER, log } from "./browser-launch.mjs";
import { Browser } from "./client.mjs";
import { createChromeShim } from "./chrome-shim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * 找 extension/ 目录。
 * 安装后运行时目录是 ~/.agent-in-chrome/agent-in-chrome/（本文件在它的 cdp/ 子目录里），
 * 源码目录下则是仓库根的 extension/。
 */
export function extensionDir() {
  const cands = [
    process.env.AGENT_IN_CHROME_EXT_DIR,
    path.join(HERE, "..", "extension"),
    path.join(HERE, "..", "..", "extension"),
  ];
  for (const c of cands) if (c && fs.existsSync(path.join(c, "sw.js"))) return path.resolve(c);
  throw new Error(
    "找不到 extension/sw.js —— CLI 模式要把工具层 import 进来才能跑。\n" +
      `找过：${cands.filter(Boolean).join("、")}\n` +
      "从源码目录跑就没这个问题；装过的话补跑一次安装器把 extension/ 同步过去：\n" +
      "  npx @liang-hz/agent-in-chrome@latest install（从 git 克隆跑的是 node scripts/install.mjs）"
  );
}

/*
 * shim 的 chrome.storage 落在哪：**我们刚连上的这个浏览器自己的 profile 目录**。
 * 传入 ensureBrowser() 报回来的浏览器记录，返回解析成绝对路径的 profile 目录；
 * 记录里没有 profileDir 就直接抛错，不回落到共用目录。
 */
export function shimStateDir(info) {
  if (!info?.profileDir)
    throw new Error(
      "浏览器记录里没有 profileDir，无法决定 chrome.storage 放哪。\n" +
        "（storage 必须按 profile 分：见 cdp/chrome-shim.mjs 里 storage 那段。" +
        "这是 ensureBrowser 的返回值缺了字段，属于代码问题，不是环境问题。）"
    );
  return path.resolve(info.profileDir);
}

const DEFAULT_DEPS = {
  ensureBrowser,
  stopBrowser,
  markAdoptable,
  connect: (target) => Browser.connect(target),
  createChromeShim,
  importSw: (extDir) => import(pathToFileURL(path.join(extDir, "sw.js")).href),
  keepBrowser: () => KEEP_BROWSER,
};

function stampOf(info) {
  return `${info.pid}:${info.startedAt || info.browserGuid || ""}`;
}

/*
 * 起桥接。
 *
 * @param onFrame 收 sw.js 发出来的帧（{type:"result"|"hello"|"pong", …}），
 *                形状和桌面模式里从 socket 收到的完全一样。
 * @param deps    见 DEFAULT_DEPS，只有测试会传。
 */
export async function startCdpBridge({ onFrame, headless = HEADLESS, deps } = {}) {
  const d = { ...DEFAULT_DEPS, ...(deps || {}) };
  const extDir = extensionDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));

  const info = await d.ensureBrowser({ headless });
  let browser = null;
  try {
    browser = await d.connect(info.pipe ? { pipe: info.pipe } : info.wsUrl);

    const shim = d.createChromeShim(browser, {
      manifest,
      stateDir: shimStateDir(info),
      instanceStamp: stampOf(info),
    });
    shim.setOnFromSw((msg) => {
      try {
        onFrame?.(msg);
      } catch (e) {
        log(`onFrame 抛了：${e?.message || e}`);
      }
    });

    globalThis.chrome = shim.chrome;
    await d.importSw(extDir);

    log(
      `CDP 桥接就绪：${info.kind} ${info.version} pid=${info.pid} ` +
        `headless=${info.headless} ${info.adopted ? "（复用）" : "（新起）"}`
    );
    return makeHandle({ info, browser, manifest, shim, headless, deps: d });
  } catch (e) {
    try {
      browser?.client?.close("桥接没起来");
    } catch {}
    if (!d.keepBrowser()) {
      try {
        d.stopBrowser();
      } catch {}
    }
    throw e;
  }
}

function makeHandle({ info, browser, manifest, shim, headless, deps }) {
  let cur = { info, browser };
  let stopped = false;
  let reconnecting = null;
  const lostHandlers = new Set();

  function watchLost(b) {
    b.client.onClose?.(() => {
      if (stopped || b !== cur.browser) return;
      for (const fn of [...lostHandlers]) {
        try {
          fn();
        } catch (e) {
          log(`onLost 抛了：${e?.message || e}`);
        }
      }
    });
  }
  watchLost(browser);

  const ready = () => !cur.browser.client.closed;

  return {
    get info() {
      return cur.info;
    },
    get browser() {
      return cur.browser;
    },
    version: manifest.version,
    /*
     * 浏览器那头没了的时候叫一声（返回一个取消订阅的函数）。恢复本身不在这里做。
     */
    onLost: (fn) => (lostHandlers.add(fn), () => lostHandlers.delete(fn)),
    /*
     * 浏览器退出后在**本进程内**恢复：重新起（或收养）一个浏览器，把 shim 换绑过去。
     * 复用同一个 shim（sw.js 一个进程只 import 得了一次），并发调用共用同一个 promise，
     * 成功返回新的浏览器记录；失败时把刚起的浏览器收掉再抛。
     */
    reconnect: () => {
      if (stopped) return Promise.reject(new Error("CDP 桥接已经收掉了（server 正在退出）"));
      if (reconnecting) return reconnecting;
      reconnecting = (async () => {
        const prev = cur.browser;
        const nextInfo = await deps.ensureBrowser({ headless });
        let next = null;
        try {
          next = await deps.connect(nextInfo.pipe ? { pipe: nextInfo.pipe } : nextInfo.wsUrl);
          await shim.rebind(next, { instanceStamp: stampOf(nextInfo) });
        } catch (e) {
          try {
            next?.client?.close("重连没起来");
          } catch {}
          if (!deps.keepBrowser()) {
            try {
              deps.stopBrowser();
            } catch {}
          }
          throw e;
        }
        cur = { info: nextInfo, browser: next };
        watchLost(next);
        try {
          prev.client.close("浏览器已退出，换绑到新实例");
        } catch {}
        log(
          `CDP 桥接已重连：${nextInfo.kind} ${nextInfo.version} pid=${nextInfo.pid} ` +
            `${nextInfo.adopted ? "（复用）" : "（新起）"}`
        );
        return cur.info;
      })().finally(() => {
        reconnecting = null;
      });
      return reconnecting;
    },
    /*
     * 送一帧给工具层，等价于桌面模式里的 sendLine(hostConn, frame)。
     * **连接没了就打回 false**，语义和 sendLine 写不进去时一致。
     */
    send: (frame) => {
      if (stopped || !ready()) return false;
      shim.sendToSw(frame);
      return true;
    },
    ready,
    /* shim 各张内部表的条目数，见 chrome-shim.mjs 里 stats 的注释。只给诊断和测试用 */
    stats: shim.stats,
    /*
     * 收工，「最后一个走的人关灯」。
     *
     * @param peersLeft 还有几个从会话连着。>0 就把浏览器留着：它们会重新竞争出
     *                  新主，新主收养这个浏览器，标签页和登录态都不丢。
     *                  AGENT_IN_CHROME_KEEP=1 则永远留着（下次冷启动省 1~2s）。
     */
    close: ({ keepBrowser, peersLeft = 0 } = {}) => {
      stopped = true;
      const keep = keepBrowser ?? deps.keepBrowser();
      const { info, browser } = cur;
      if (info.transport === "pipe") {
        try {
          browser.client.close("MCP server 退出");
        } catch {}
        if (peersLeft > 0)
          log(
            `还有 ${peersLeft} 个从会话在用，但当前是管道传输——浏览器跟本进程一起走。` +
              "要让浏览器活过主会话，用 AGENT_IN_CHROME_KEEP=1 改走端口模式（见 docs/CLI.md）。"
          );
        deps.stopBrowser();
        return;
      }
      try {
        browser.client.close("MCP server 退出");
      } catch {}
      if (!keep && peersLeft === 0) deps.stopBrowser();
      else {
        deps.markAdoptable();
        log(`不收浏览器：${keep ? "AGENT_IN_CHROME_KEEP=1" : `还有 ${peersLeft} 个从会话在用`}`);
      }
    },
  };
}
