// 属性页：把「它现在是什么状态、有没有新版」填进静态说明里。
// 路径类信息不在这里现算——扩展进程看不到文件系统，真实绝对路径让用户跑
// `npx @liang-hz/agent-in-chrome check` 去拿，页面上只写约定位置（~/.agent-in-chrome/…）。

const $ = (id) => document.getElementById(id);

$("extid").textContent = chrome.runtime.id;
$("version").textContent = chrome.runtime.getManifest().version;

chrome.runtime.sendMessage({ type: "popup-status" }, (s) => {
  if (chrome.runtime.lastError || !s) {
    $("state").textContent = "service worker 未响应（点扩展图标可唤醒）";
    return;
  }
  $("state").textContent = s.connected ? "已连接 agent" : "未连接（agent 未运行或链路未通）";
});

$("hostname").textContent = "org.liangai.agent_in_chrome.json";

(async () => {
  const current = chrome.runtime.getManifest().version;
  const { latest, hasUpdate, channel } = await window.aicUpdateCheck.check(current);
  const el = $("updateLine");
  if (hasUpdate) {
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent =
      channel === "store"
        ? `有新版本 ${latest}（当前 ${current}，落后较多）。商店更新可能卡住了：去 chrome://extensions 确认开启了自动更新，或从商店页重装。`
        : `有新版本 ${latest}（当前 ${current}）。`;
    const a = document.createElement("a");
    a.href = "https://github.com/Liang-HZ/agent-in-chrome/releases";
    a.target = "_blank";
    a.textContent = "查看更新说明 →";
    el.append(b, " ", a);
    el.classList.remove("muted");
  } else if (latest && channel === "store") {
    el.textContent = `当前 ${current}（商店版，自动更新）。`;
  } else if (latest) {
    el.textContent = `当前 ${current}，已是最新。`;
  } else {
    el.textContent = `当前 ${current}。（没查到最新版本号：联不上 npm，可能是离线或代理拦截；重开这页会再试）`;
  }
})();
