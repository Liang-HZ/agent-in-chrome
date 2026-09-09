// 属性页的外壳交互：左侧目录跟着滚动高亮，以及顶栏状态胶囊的颜色跟着 about.js 写的文案走。
// 不碰 about.js：它负责填内容（版本、扩展 ID、连接状态、更新行），这里只负责导航和配色。

const links = [...document.querySelectorAll("nav.toc a[href^='#']")];
const sections = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);

const spy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links) a.classList.toggle("on", a.hash === "#" + e.target.id);
    }
  },
  { rootMargin: "-88px 0px -70% 0px", threshold: 0 }
);
for (const s of sections) spy.observe(s);

const state = document.getElementById("state");
const pill = state.closest(".pill");
const paint = () => {
  const t = state.textContent || "";
  pill.classList.toggle("state", t.includes("已连接"));
};
new MutationObserver(paint).observe(state, { childList: true, characterData: true, subtree: true });
paint();
