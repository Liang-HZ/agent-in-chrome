// Agent in Chrome — 终端多选清单（零依赖）
// 交互约定：
//   ↑↓ / kj  移动    空格  勾选/取消    a  全选/全不选
//   回车     确认    Ctrl-C / Esc / q  取消（返回 null，调用方据此中止，不是当成全不选）
// 铁律：非 TTY 一律不进这里。agent 代跑、CI、管道输入时挂在 stdin 上等按键，
// 表现是安装命令永远不返回——比少问一句严重得多。调用方负责判断，这里再兜一层底。

import readline from "node:readline";

function glyphs(platform) {
  return platform === "win32" ? { on: "[x]", off: "[ ]", cur: ">", pad: " " } : { on: "◉", off: "◯", cur: "❯", pad: " " };
}

const ESC = "\x1b";
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const CYAN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

/*
 * items: [{ label, note }]，note 是右侧的灰色补充（这里放要改的配置文件路径）
 * 返回被选中项的下标数组；用户主动取消时返回 null。
 */
export async function pickMulti(items, opts = {}) {
  const {
    title = "",
    hint = "↑↓ 移动　空格 选/不选　a 全选　回车 确认",
    input = process.stdin,
    output = process.stdout,
    platform = process.platform,
    selected = items.map(() => true),
  } = opts;

  if (!items.length) return [];
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return items.map((_, i) => i).filter((i) => selected[i]);
  }

  const g = glyphs(platform);
  const width = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
  const labelW = Math.max(...items.map((it) => width(it.label)));
  const padLabel = (s) => s + " ".repeat(Math.max(0, labelW - width(s)));
  const marks = selected.slice();
  let cur = 0;
  let drawn = 0;

  const render = () => {
    const lines = [];
    if (title) lines.push(title);
    for (let i = 0; i < items.length; i++) {
      const pointer = i === cur ? `${CYAN}${g.cur}${RESET}` : g.pad;
      const box = marks[i] ? `${CYAN}${g.on}${RESET}` : `${DIM}${g.off}${RESET}`;
      const text = items[i].note ? padLabel(items[i].label) : items[i].label;
      const label = i === cur ? `${BOLD}${text}${RESET}` : text;
      const note = items[i].note ? `  ${DIM}${items[i].note}${RESET}` : "";
      lines.push(`  ${pointer} ${box} ${label}${note}`);
    }
    lines.push(`  ${DIM}${hint}${RESET}`);

    let out = "";
    if (drawn) out += `${ESC}[${drawn}A`;
    for (const l of lines) out += `${ESC}[2K${l}\n`;
    output.write(out);
    drawn = lines.length;
  };

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  output.write(`${ESC}[?25l`);
  const wasPaused = input.isPaused();
  input.resume();

  const cleanup = () => {
    input.removeListener("keypress", onKey);
    try {
      input.setRawMode(!!wasRaw);
    } catch {}
    if (wasPaused) input.pause();
    output.write(`${ESC}[?25h`);
  };

  let done;
  const result = new Promise((r) => (done = r));

  function onKey(str, key = {}) {
    const name = key.name || "";
    if ((key.ctrl && name === "c") || name === "escape" || name === "q") {
      render();
      cleanup();
      done(null);
      return;
    }
    if (name === "up" || name === "k") cur = (cur - 1 + items.length) % items.length;
    else if (name === "down" || name === "j") cur = (cur + 1) % items.length;
    else if (name === "space") marks[cur] = !marks[cur];
    else if (name === "a") {
      const allOn = marks.every(Boolean);
      for (let i = 0; i < marks.length; i++) marks[i] = !allOn;
    } else if (name === "return" || name === "enter") {
      render();
      cleanup();
      done(marks.map((m, i) => (m ? i : -1)).filter((i) => i >= 0));
      return;
    } else if (str === " ") {
      marks[cur] = !marks[cur];
    } else return;
    render();
  }

  input.on("keypress", onKey);
  render();
  return result;
}
