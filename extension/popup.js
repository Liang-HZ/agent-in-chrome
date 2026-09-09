/*
 * 扩展弹窗（popup.html）的脚本：显示与 agent 的连接状态、按会话列出 agent 正开着的
 * 标签页，并给出接管/交还、关页、解除全部托管、操作光标与独立窗口开关、工具档位、
 * 凭据借出授权这几个入口。
 * 数据一律经 chrome.runtime.sendMessage 向 service worker 要（popup-* 系列消息），
 * 弹窗自己不持有状态：状态 1.5s 轮询一轮，待授权列表 2s 一轮。
 */
const $ = (id) => document.getElementById(id);

const CHIP_TEXT = { attention: "需要你", failed: "失败" };
const GROUP_CSS = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
};

function host(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "";
  }
}

function favicon(t) {
  const u = t.favIconUrl || "";
  if (/^(https?:|data:image\/)/.test(u)) {
    const img = document.createElement("img");
    img.className = "fav";
    img.src = u;
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(fallbackFav()));
    return img;
  }
  return fallbackFav();
}

function fallbackFav() {
  const d = document.createElement("span");
  d.className = "fav fallback";
  d.textContent = "🌐";
  return d;
}

const SURFACE_TEXT = { cli: "CLI", app: "桌面端" };

/*
 * 「谁在开这一组」——四段身份，最多占两行：
 *
 *   Claude Code · 桌面端 · agent-in-chrome     ← 谁、什么形态、开在哪
 *   修 sid 漂移与组认领                         ← 这段对话叫什么
 *
 * 每一段都是别人给的任意字符串，只用 textContent，不拼 HTML。
 */
function agentTag(t) {
  const frag = document.createDocumentFragment();
  const surface = SURFACE_TEXT[t.agentSurface] || null;
  const who = [t.agent, surface].filter(Boolean).join(" · ");
  if (who || t.agentWorkspace) {
    const line = document.createElement("div");
    line.className = "agent";
    if (who) {
      const w = document.createElement("span");
      w.className = "who";
      w.textContent = who;
      line.append(w);
    }
    if (t.agentWorkspace) {
      const ws = document.createElement("span");
      ws.className = "ws";
      ws.textContent = (who ? "· " : "") + t.agentWorkspace;
      line.append(ws);
    }
    const tip = [];
    if (t.agentVersion) tip.push(`版本 ${t.agentVersion}`);
    if (t.agentWorkspace) {
      tip.push(`${t.agentWorkspaceKind === "git" ? "Git 仓库" : "工作目录"}：${t.agentWorkspace}`);
    }
    if (tip.length) line.title = tip.join("\n");
    frag.append(line);
  }
  if (t.agentSession || t.agentTask) {
    const line = document.createElement("div");
    line.className = "agent asess";
    line.textContent = [t.agentSession, t.agentTask].filter(Boolean).join(" › ");
    const tip = [];
    if (t.agentSession) tip.push(`这段对话的标题：${t.agentSession}`);
    if (t.agentTask) tip.push(`正在动手的子任务：${t.agentTask}${t.agentTaskType ? `（${t.agentTaskType}）` : ""}`);
    line.title = tip.join("\n");
    frag.append(line);
  }
  return frag;
}

const selecting = new Map();
let lastStatus = null;
function rerender() {
  if (lastStatus !== undefined) render(lastStatus);
}

function render(s) {
  lastStatus = s;
  const ok = s && s.connected;
  $("status").className = "status " + (ok ? "on" : "off");
  $("state").textContent = ok ? "已连接 agent" : "未连接（agent 未运行或链路未通）";
  $("reconnect").hidden = !!ok;
  $("version").textContent = s && s.version ? `v${s.version}` : "";
  const target = $("target");
  target.innerHTML = "";

  const list = (s && s.sessions) || [];
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.session)) groups.set(t.session, []);
    groups.get(t.session).push(t);
  }

  for (const key of [...selecting.keys()]) if (!groups.has(key)) selecting.delete(key);

  const orphans = (s && s.orphans) || [];
  const openWin = $("openwin");
  if (openWin) openWin.hidden = !(s && s.agentWindow && s.agentWindow.id != null);

  if (groups.size || orphans.length) {
    const head = document.createElement("div");
    head.className = "sec-title";
    head.append("接管中");
    const count = document.createElement("span");
    count.className = "count";
    const nTabs = list.length + orphans.reduce((n, g) => n + g.tabs.length, 0);
    count.textContent = `${nTabs} 个页面 · ${groups.size + orphans.length} 个任务`;
    head.append(count);
    target.append(head);

    for (const [key, tabs] of groups.entries()) {
      const first = tabs[0];
      const card = document.createElement("div");
      card.className =
        "sess" + (first.state === "failed" ? " bad" : first.state === "attention" ? " warn" : "") + (first.dormant ? " dormant" : "");
      if (GROUP_CSS[first.color]) card.style.setProperty("--sc", GROUP_CSS[first.color]);

      const sel = selecting.get(key);
      if (sel) {
        card.classList.add("selecting");
        for (const t of tabs) if (!sel.has(t.tabId)) sel.set(t.tabId, true);
      }

      const headRow = document.createElement("div");
      headRow.className = "sess-head";
      if (sel) {
        const allCb = document.createElement("input");
        allCb.type = "checkbox";
        allCb.checked = tabs.every((t) => sel.get(t.tabId) !== false);
        allCb.title = "全选/全不选这个任务的页面";
        allCb.addEventListener("change", () => {
          for (const t of tabs) sel.set(t.tabId, allCb.checked);
          rerender();
        });
        headRow.append(allCb);
      }
      const dot = document.createElement("span");
      dot.className = "sdot";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = first.label || first.title || "(无标题)";
      label.title = first.label || "";
      const titleCol = document.createElement("div");
      titleCol.className = "sess-title";
      titleCol.append(label);
      titleCol.append(agentTag(first));
      headRow.append(dot, titleCol);
      if (first.dormant) {
        const chip = document.createElement("span");
        chip.className = "chip dormant";
        chip.textContent = "休眠";
        chip.title = "这个任务的 agent 进程已经退出。页面先留着（对话可能还没结束），闲置一段时间后自动回收；你还在看的页不会被关。";
        headRow.append(chip);
      } else if (CHIP_TEXT[first.state]) {
        const chip = document.createElement("span");
        chip.className = "chip " + first.state;
        chip.textContent = CHIP_TEXT[first.state];
        headRow.append(chip);
      }
      if (!sel) {
        const n = document.createElement("span");
        n.className = "tabn";
        n.textContent = `${tabs.length} 页`;
        headRow.append(n);
        const heldIds = tabs.filter((t) => t.held).map((t) => t.tabId);
        if (heldIds.length) {
          const back = document.createElement("button");
          back.className = "rel-btn";
          back.textContent = "交给AI接管";
          back.title = "把你接管中的页面立即交还给 agent：调试提示条和光晕马上回来，它可以继续操作。";
          back.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "popup-unhold-tabs", tabIds: heldIds }, (r) => {
              if (chrome.runtime.lastError || !r || r.error) {
                toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
                return;
              }
              toast(`已交还 ${r.count} 个标签页`);
              setTimeout(() => toast(""), 4000);
              refresh();
            });
          });
          headRow.append(back);
        }
        const takeable = tabs.filter((t) => !t.held);
        if (takeable.length === 1) {
          const rel = document.createElement("button");
          rel.className = "rel-btn";
          rel.textContent = "手动接管";
          rel.title =
            "暂时从 agent 手里接过这个页面：调试提示条立刻消失，你可以随意操作；agent 再碰它会被明确告知「用户接管中，等他说继续」。页面留在会话里，随时可以交还。";
          rel.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "popup-hold-tabs", tabIds: [takeable[0].tabId] }, (r) => {
              if (chrome.runtime.lastError || !r || r.error) {
                toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
                return;
              }
              toast("已接管，agent 会被告知等你交还");
              setTimeout(() => toast(""), 4000);
              refresh();
            });
          });
          headRow.append(rel);
        } else if (takeable.length > 1) {
          const rel = document.createElement("button");
          rel.className = "rel-btn";
          rel.textContent = "手动接管…";
          rel.title =
            "暂时从 agent 手里接过页面：点击后勾选要接管的页，再点「手动接管已选页面」生效。接管后调试提示条消失、你可以随意操作，agent 会被明确告知「用户接管中，等他说继续」。页面留在会话里，随时可以交还。";
          rel.addEventListener("click", () => {
            selecting.set(key, new Map(tabs.map((t) => [t.tabId, false])));
            rerender();
          });
          headRow.append(rel);
        }
      }
      card.append(headRow);

      for (const t of tabs) {
        const row = document.createElement("div");
        row.className = "tabrow";
        if (sel) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !t.held && sel.get(t.tabId) !== false;
          cb.disabled = !!t.held;
          cb.addEventListener("change", () => {
            sel.set(t.tabId, cb.checked);
            rerender();
          });
          row.append(cb);
        }
        const meta = document.createElement("div");
        meta.className = "tmeta";
        const title = document.createElement("span");
        title.className = "ttitle";
        title.textContent = t.title || "(无标题)";
        const h = document.createElement("span");
        h.className = "thost";
        h.textContent = host(t.url);
        meta.title = `${t.title || ""}\n${t.url || ""}`;
        meta.append(title, h);
        if (t.openedBy) {
          const by = document.createElement("span");
          by.className = "tby";
          by.textContent = `· ${t.openedBy}`;
          by.title = `这个页面由子任务「${t.openedBy}」打开`;
          meta.append(by);
        }
        row.append(favicon(t), meta);
        if (t.held) {
          const chip = document.createElement("span");
          chip.className = "chip held";
          chip.textContent = "你接管中";
          chip.title = "你正在手动操作这个页面，agent 对它的操作会被叫停。点上方「交给AI接管」交还。";
          row.append(chip);
        }
        card.append(row);
      }

      if (sel) {
        const picked = tabs.filter((t) => !t.held && sel.get(t.tabId) !== false).map((t) => t.tabId);
        const actions = document.createElement("div");
        actions.className = "sel-actions";
        const go = document.createElement("button");
        go.className = "go";
        go.textContent = picked.length ? `手动接管已选页面（${picked.length}）` : "先勾选要接管的页面";
        go.title = "从 agent 手里接过勾选的页面：页面保持打开、留在会话里，agent 的操作会被叫停，直到你交还";
        go.disabled = picked.length === 0;
        go.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "popup-hold-tabs", tabIds: picked }, (r) => {
            if (chrome.runtime.lastError || !r || r.error) {
              toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
              return;
            }
            selecting.delete(key);
            toast(`已接管 ${r.count} 个标签页，agent 会被告知等你交还`);
            setTimeout(() => toast(""), 4000);
            refresh();
          });
        });
        const cancel = document.createElement("button");
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => {
          selecting.delete(key);
          rerender();
        });
        actions.append(go, cancel);
        card.append(actions);
      }
      target.append(card);
    }

    for (const g of orphans) {
      const card = document.createElement("div");
      card.className = "sess orphan";
      if (GROUP_CSS[g.color]) card.style.setProperty("--sc", GROUP_CSS[g.color]);

      const headRow = document.createElement("div");
      headRow.className = "sess-head";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = g.title || "(无标题)";
      const dot = document.createElement("span");
      dot.className = "sdot";
      const chip = document.createElement("span");
      chip.className = "chip orphan";
      chip.textContent = g.reclaimable ? "待认领" : "遗留";
      chip.title = g.reclaimable
        ? "扩展重载过，会话表清空了；这组的 agent 只要再有一次调用就会把它认回去。等不及就用下面两个按钮自己处置。"
        : "扩展重载或浏览器重启前留下的 agent 标签组，现在没有会话在管它";
      const titleCol = document.createElement("div");
      titleCol.className = "sess-title";
      titleCol.append(label);
      if (g.agent || g.agentWorkspace || g.agentSession) {
        titleCol.append(
          agentTag({
            agent: g.agent,
            agentSurface: g.agentSurface,
            agentWorkspace: g.agentWorkspace,
            agentWorkspaceKind: g.agentWorkspaceKind,
            agentSession: g.agentSession,
          })
        );
      }
      headRow.append(dot, titleCol, chip);
      card.append(headRow);

      for (const t of g.tabs) {
        const row = document.createElement("div");
        row.className = "tabrow";
        const meta = document.createElement("div");
        meta.className = "tmeta";
        const title = document.createElement("span");
        title.className = "ttitle";
        title.textContent = t.title || "(无标题)";
        const h = document.createElement("span");
        h.className = "thost";
        h.textContent = host(t.url);
        meta.title = `${t.title || ""}\n${t.url || ""}`;
        meta.append(title, h);
        row.append(favicon(t), meta);
        card.append(row);
      }

      const actions = document.createElement("div");
      actions.className = "sel-actions";
      const ungroup = document.createElement("button");
      ungroup.textContent = "解散分组";
      ungroup.title = "把这组拆掉：页面全部保留，只是移出分组、变回普通标签页";
      ungroup.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "popup-ungroup-group", groupId: g.groupId }, (r) => {
          if (chrome.runtime.lastError || !r || r.error) {
            toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
            return;
          }
          toast(`已解散，${r.count} 个页面保留`);
          setTimeout(() => toast(""), 4000);
          refresh();
        });
      });
      const close = document.createElement("button");
      close.className = "go";
      close.title = "关闭这组里的所有页面（不可撤销，要点两次确认）";
      close.textContent = "关闭这组";
      let closeArmed = false;
      close.addEventListener("click", () => {
        if (!closeArmed) {
          closeArmed = true;
          close.textContent = "再点一次确认";
          setTimeout(() => {
            closeArmed = false;
            close.textContent = "关闭这组";
          }, 4000);
          return;
        }
        chrome.runtime.sendMessage({ type: "popup-close-group", groupId: g.groupId }, (r) => {
          if (chrome.runtime.lastError || !r || r.error) {
            toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
            return;
          }
          toast(`已关闭 ${r.count} 个页面`);
          setTimeout(() => toast(""), 4000);
          refresh();
        });
      });
      actions.append(ungroup, close);
      card.append(actions);
      target.append(card);
    }

    const hint = document.createElement("div");
    hint.className = "drag-hint";
    hint.textContent = "提示：把标签页拖进某个会话的标签组，等于允许该会话使用它。";
    target.append(hint);
  } else if (ok) {
    const head = document.createElement("div");
    head.className = "sec-title";
    head.textContent = "接管中的页面";
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "当前没有会话在操作标签页";
    target.append(head, d);
  }

  if (!ok && s && s.lastDisconnect) {
    const box = document.createElement("div");
    box.className = "diag";
    const why = document.createElement("b");
    why.textContent = s.lastDisconnect.why;
    const fix = document.createElement("div");
    fix.textContent = s.lastDisconnect.fix;
    box.append(why, fix);
    if (s.lastDisconnect.raw) {
      const raw = document.createElement("code");
      raw.textContent = s.lastDisconnect.raw;
      box.append(raw);
    }
    target.append(box);
  }
}

// SW 里存的 title/url 是接管那一刻的快照；标签页此后可能导航过。
// 弹窗有 tabs 权限，直接问浏览器要当下的标题和图标，问不到（标签页已关）就用快照。
async function enrich(s) {
  const list = (s && s.sessions) || [];
  await Promise.all(
    list.map(async (t) => {
      if (!t.tabId) return;
      try {
        const live = await chrome.tabs.get(t.tabId);
        if (live.title) t.title = live.title;
        if (live.url) t.url = live.url;
        if (live.favIconUrl) t.favIconUrl = live.favIconUrl;
      } catch {}
    })
  );
  return s;
}

let renderSeq = 0;
function refresh() {
  const seq = ++renderSeq;
  chrome.runtime.sendMessage({ type: "popup-status" }, async (s) => {
    if (chrome.runtime.lastError) return render(null);
    await enrich(s);
    if (seq === renderSeq) render(s);
  });
}

(async () => {
  const current = chrome.runtime.getManifest().version;
  const { latest, hasUpdate, channel } = await window.aicUpdateCheck.check(current);
  if (!hasUpdate) return;
  const a = document.createElement("a");
  a.href = "https://github.com/Liang-HZ/agent-in-chrome/releases";
  a.target = "_blank";
  a.textContent = `新版 ${latest} →`;
  a.title =
    channel === "store"
      ? `当前 ${current}，落后较多——商店更新可能卡住了，去 chrome://extensions 开自动更新或重装商店版`
      : `当前 ${current}，点击查看更新说明`;
  $("update").append(a);
})();

let armed = false;
let armTimer = null;
function disarm() {
  armed = false;
  clearTimeout(armTimer);
  $("closeall").classList.remove("confirm");
  $("closeall").textContent = "关闭 agent 开的所有标签页";
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = !text;
}

$("closeall").addEventListener("click", () => {
  if (!armed) {
    armed = true;
    $("closeall").classList.add("confirm");
    $("closeall").textContent = "确定要关闭？再点一次";
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  toast("清理中…");
  chrome.runtime.sendMessage({ type: "popup-close-all" }, (r) => {
    if (chrome.runtime.lastError || !r || r.error) {
      toast(`失败：${r?.error || chrome.runtime.lastError?.message || "未知错误"}`);
      return;
    }
    const parts = [`已关闭 ${r.closedCount || 0} 个标签页`];
    if (r.releasedCount) parts.push(`${r.releasedCount} 个你拖进来的已还给你`);
    toast(parts.join("，"));
    setTimeout(() => toast(""), 4000);
    refresh();
  });
});

$("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popup-reconnect" }, () => setTimeout(refresh, 300));
});

let releaseArmed = false;
let releaseTimer = null;
const RELEASE_TITLE = $("release").title;
function disarmRelease() {
  releaseArmed = false;
  clearTimeout(releaseTimer);
  $("release").classList.remove("confirm");
  $("release").title = RELEASE_TITLE;
}
$("release").addEventListener("click", () => {
  if (!releaseArmed) {
    releaseArmed = true;
    $("release").classList.add("confirm");
    $("release").title = "再点一次确认：解除全部托管";
    toast("再点一次「解除全部托管」确认：页面全保留，agent 需重新接管");
    releaseTimer = setTimeout(() => {
      disarmRelease();
      toast("");
    }, 4000);
    return;
  }
  disarmRelease();
  chrome.runtime.sendMessage({ type: "popup-release" }, () => {
    toast("已解除全部托管");
    setTimeout(() => toast(""), 3000);
    setTimeout(refresh, 200);
  });
});
$("reload").addEventListener("click", () => {
  toast("重载中…约 1-2 秒");
  chrome.runtime.sendMessage({ type: "popup-reload" }, () => {
    setTimeout(() => {
      toast("");
      refresh();
    }, 2000);
  });
});

$("cursor").addEventListener("change", (e) => {
  chrome.runtime.sendMessage({ type: "popup-cursor", on: e.target.checked }, (r) => {
    if (!chrome.runtime.lastError && r) $("cursor").checked = !!r.on;
  });
});
chrome.runtime.sendMessage({ type: "popup-cursor" }, (r) => {
  if (!chrome.runtime.lastError && r) $("cursor").checked = !!r.on;
});

$("openwin").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popup-open-agent-window" }, () => window.close());
});

$("sepwin").addEventListener("change", (e) => {
  chrome.runtime.sendMessage({ type: "popup-sepwin", on: e.target.checked }, (r) => {
    if (!chrome.runtime.lastError && r) $("sepwin").checked = !!r.on;
  });
});
chrome.runtime.sendMessage({ type: "popup-sepwin" }, (r) => {
  if (!chrome.runtime.lastError && r) $("sepwin").checked = !!r.on;
});

// 工具档位。真源是 ~/.agent-in-chrome/config.json（经 SW → host 落盘），这里不留副本。
// 档位决定哪些工具出现在 agent 的工具列表里；改完 server 靠 fs.watch 立即热更新，
// 客户端那侧没跟上的话提示重启客户端（README「配置」一节的口径）。
function cfgShow(r, changed) {
  const hint = $("cfghint");
  const tiers = document.getElementById("profile");
  if (!r || !r.ok) {
    tiers.classList.add("off");
    hint.textContent = (r && r.error) || "读不到配置";
    return;
  }
  tiers.classList.remove("off");
  const cur = r.value?.tools?.profile || "full";
  for (const el of tiers.querySelectorAll("input")) el.checked = el.value === cur;
  const extras = (r.value?.tools?.disable || []).length;
  hint.textContent = changed
    ? "已保存，立即生效。agent 那边没跟上的话，重启那个客户端。"
    : extras
      ? `另有 ${extras} 个工具在 config.json 里被单独关掉`
      : "";
}
document.getElementById("profile").addEventListener("change", (e) => {
  chrome.runtime.sendMessage({ type: "popup-config", patch: { tools: { profile: e.target.value } } }, (r) => {
    if (!chrome.runtime.lastError) cfgShow(r, true);
  });
});
chrome.runtime.sendMessage({ type: "popup-config" }, (r) => {
  if (!chrome.runtime.lastError) cfgShow(r, false);
});

// 凭据借出：cookie 导出的按域授权面板。真源是扩展自己的 storage.local（见 sw.js 的
// cookieLoanGate），不经 host、不进 config.json——闸在扩展里执行，判据就得在扩展手边，
// 否则 host 一断就成了失败开放。
function cgRow(cls) {
  const d = document.createElement("div");
  d.className = "cg-row" + (cls ? " " + cls : "");
  return d;
}
function cgBtn(text, cls, title, onClick) {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function cgShow(r) {
  const askBox = $("cgask");
  const grantBox = $("cggrants");
  const hint = $("cghint");
  askBox.innerHTML = "";
  grantBox.innerHTML = "";
  if (!r || r.error) {
    askBox.hidden = grantBox.hidden = true;
    hint.textContent = r?.error ? `读不到授权名单：${r.error}（读不到一律按拒绝处理）` : "";
    return;
  }

  const asks = r.asks || [];
  askBox.hidden = !asks.length;
  for (const a of asks) {
    const row = cgRow();
    const top = document.createElement("div");
    top.className = "cg-dom";
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = a.domain;
    d.title = a.domain;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${a.n} 条 cookie`;
    top.append(d, n);
    if (a.sensitive) {
      const tag = document.createElement("span");
      tag.className = "cg-tag";
      tag.textContent = "敏感";
      tag.title = "银行 / 支付 / 券商这类域只给一次性授权，不进长期名单——下次还要再点一次。";
      top.append(tag);
    }
    row.append(top);
    const who = [a.agent, a.label].filter(Boolean).join(" · ");
    if (who) {
      const w = document.createElement("div");
      w.className = "cg-who";
      w.textContent = who;
      w.title = who;
      row.append(w);
    }
    const acts = document.createElement("div");
    acts.className = "cg-acts";
    if (!a.sensitive) {
      acts.append(
        cgBtn("允许", "ok", `以后这个 agent 导出 ${a.domain} 的 cookie 不再问你（30 天后失效，随时可以在下面撤销）`, () =>
          cgSend("allow", a.domain)
        )
      );
    }
    acts.append(
      cgBtn("只这一次", a.sensitive ? "ok" : "", "只放行接下来这一次导出，用掉即失效（5 分钟内没用也失效）", () =>
        cgSend("once", a.domain)
      ),
      cgBtn("拒绝", "", "把这条待授权划掉。agent 那边已经被拒过了，这只是清掉这条记录", () => cgSend("deny", a.domain))
    );
    row.append(acts);
    askBox.append(row);
  }

  const grants = [...(r.grants || []), ...(r.onceGrants || [])];
  grantBox.hidden = !grants.length;
  for (const g of grants) {
    const row = cgRow("granted");
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = g.domain;
    d.title = g.domain;
    row.append(d);
    if (g.once) {
      const tag = document.createElement("span");
      tag.className = "cg-tag";
      tag.textContent = "一次性";
      tag.title = "只够用一次，用掉或 5 分钟后自动失效";
      row.append(tag);
    }
    row.append(cgBtn("撤销", "rel-btn", `以后再导出 ${g.domain} 的 cookie 要重新问你`, () => cgSend("revoke", g.domain)));
    grantBox.append(row);
  }

  hint.textContent = asks.length
    ? "有 agent 在申请借用你的登录态。允许之后让它原样重跑那一次调用即可。"
    : grants.length
      ? "已授权的域，agent 导出它们的 cookie 时不再问你。授权 30 天后自动失效。"
      : "agent 导出 cookie 明文（等于可直接冒用的登录态）默认被拒；它申请哪个域，这里就出现哪个域。";
}

function cgSend(action, domain) {
  chrome.runtime.sendMessage({ type: "popup-cookie-gate", action, domain }, (r) => {
    if (chrome.runtime.lastError) return cgShow({ error: chrome.runtime.lastError.message });
    cgShow(r);
  });
}
cgSend(null);
setInterval(() => cgSend(null), 2000);

refresh();
setInterval(refresh, 1500);
