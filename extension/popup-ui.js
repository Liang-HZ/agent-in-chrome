// 弹窗的外壳交互：分段 Tab、以及把 popup.js 已经渲染好的计数镜像到头部。
// 刻意不碰 popup.js：它负责「有什么」（连接状态、会话卡、标签页、诊断），这里只负责
// 「怎么摆」。两边的唯一约定是 DOM——本文件只读 popup.js 写出来的东西，不改它的数据流。

(() => {
const $ = (id) => document.getElementById(id);

const TABS = [
  { btn: $("tab-tasks"), pane: $("pane-tasks") },
  { btn: $("tab-prefs"), pane: $("pane-prefs") },
];
let manual = false;

function showTab(i) {
  TABS.forEach((t, n) => {
    t.btn.setAttribute("aria-selected", String(n === i));
    t.pane.hidden = n !== i;
  });
}
TABS.forEach((t, i) =>
  t.btn.addEventListener("click", () => {
    manual = true;
    showTab(i);
  })
);

const target = $("target");
function syncCounts() {
  const count = target.querySelector(".sec-title .count");
  $("summary").textContent = count ? count.textContent : "";
  const m = count && count.textContent.match(/(\d+)\s*个任务/);
  $("tabcount").textContent = m ? m[1] : "";

  if (!manual && $("status").classList.contains("off")) showTab(0);
}
new MutationObserver(syncCounts).observe(target, { childList: true, subtree: true, characterData: true });
syncCounts();
})();
