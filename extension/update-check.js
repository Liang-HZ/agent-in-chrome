// 扩展侧的更新检查（popup 和 about 页共用）。
// 只查 npm 上的最新版本号，不带任何本机信息。结果缓存 6 小时
// 经典 script（popup.html / about.html 都不是 module），挂在 window 上。

(() => {
  const PKG = "@liang-hz/agent-in-chrome";
  const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
  const CACHE_KEY = "aic-update-check";
  const TTL_MS = 6 * 60 * 60 * 1000;
  const STORE_MINOR_LAG = 2;

  function parse(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function isNewer(a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) {
      if (x[i] > y[i]) return true;
      if (x[i] < y[i]) return false;
    }
    return false;
  }

  function storeShouldNotify(latest, current) {
    const l = parse(latest);
    const c = parse(current);
    if (!l || !c) return false;
    if (l[0] > c[0]) return true;
    return l[0] === c[0] && l[1] - c[1] >= STORE_MINOR_LAG;
  }

  /*
   * @param {string} current 本地版本（popup-status 里拿到的 VERSION）
   * @returns {Promise<{latest:string|null, hasUpdate:boolean, channel:"store"|"dev"}>} 查不到时 latest 为 null，绝不 reject
   */
  async function check(current) {
    let channel = "dev";
    try {
      const self = await chrome.management.getSelf();
      if (self?.installType === "normal") channel = "store";
    } catch {}
    try {
      const cached = (await chrome.storage.local.get(CACHE_KEY))?.[CACHE_KEY];
      let latest = cached && Date.now() - cached.at < TTL_MS ? cached.latest : null;
      if (!latest) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const res = await fetch(REGISTRY, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(String(res.status));
        latest = (await res.json())?.version || null;
        if (latest) await chrome.storage.local.set({ [CACHE_KEY]: { latest, at: Date.now() } });
      }
      const hasUpdate = channel === "store" ? storeShouldNotify(latest, current) : isNewer(latest, current);
      return { latest, hasUpdate, channel };
    } catch {
      return { latest: null, hasUpdate: false, channel };
    }
  }

  window.aicUpdateCheck = { check, isNewer, storeShouldNotify, PKG };
})();
