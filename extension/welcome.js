// 欢迎页的两个复制按钮。MV3 扩展页 CSP 禁内联脚本，所以单独一个文件。
// 全文只用 textContent，不碰 innerHTML（与 popup.js/about.js 同一条纪律）。

for (const [btnId, srcId] of [
  ["copy", "cmd"],
  ["copy2", "agentline"],
]) {
  const btn = document.getElementById(btnId);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById(srcId).textContent);
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1500);
    } catch {
      btn.textContent = "请手动复制";
    }
  });
}
