// 提示文案里那条「你去敲这个」的命令怎么拼——**一处真源**，谁要给用户一条命令都从这里取。
//
// 同一个工具有两种敲法，取决于用户是怎么装的：
//   · 仓库检出：`node scripts/borrow-login.mjs …`，直接跑树里那个文件
//   · npm / npx 装的：走 bin 的子命令 `npx @liang-hz/agent-in-chrome borrow-login …`
//
// 装出来的运行时是**扁平布局**（`~/.agent-in-chrome/agent-in-chrome/server.mjs`、
// `<runtime>/cdp/…`），里面没有 `scripts/` 这个目录；npm 包里虽然有 `scripts/`，但它
// 躺在 npx 缓存或全局 prefix 底下，路径是一串没人抄得动的 hash。这两种情况下写死
// `node scripts/x.mjs` 的提示，用户照着敲得到的只有一句 Cannot find module。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// npm 上的包名。bin 名不带 scope，包名带——提示里出现的是包名（`npx <包名> <子命令>`）。
export const PKG = "@liang-hz/agent-in-chrome";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 这棵树的根：仓库根 / npm 包根 / 扁平运行时目录，三种形态都是本模块的上一层。
const ROOT = path.join(HERE, "..");

/*
 * 判据是「用户 cd 得进去、敲得着 scripts/ 那个目录吗」，两条否决：
 *
 *   · 这棵树里根本没有 `scripts/<name>.mjs` —— 装出来的扁平运行时就是这样
 *     （`<runtime>/server.mjs`、`<runtime>/cdp/…`，本模块摊在 `<runtime>/cli-invocation.mjs`）。
 *   · 这棵树在 `node_modules/` 底下 —— npm -g、npx 缓存、项目依赖三种装法全长这样。
 *     文件确实在盘上，但那条路径是包管理器的内部布局（npx 那份还是一串 hash），
 *     不是能写进文档让人照敲的东西。
 *
 * 两条都不成立才给「直接跑脚本」的敲法：仓库检出（含剥过注释的公开树）就落在这一档。
 */
function reachableScript(name) {
  try {
    if (/(^|[\\/])node_modules([\\/]|$)/.test(ROOT)) return false;
    return fs.existsSync(path.join(ROOT, "scripts", `${name}.mjs`));
  } catch {
    return false;
  }
}

const inCheckout = () => reachableScript("borrow-login");

/*
 * 一条用户真能敲的命令。
 *
 * @param {string} name  scripts/ 下的脚本名，不带扩展名（也就是 bin 的子命令名，两者同名）
 * @param {string} [args] 跟在后面的参数，原样拼上
 */
export function scriptCmd(name, args = "") {
  const base = reachableScript(name) ? `node scripts/${name}.mjs` : `npx ${PKG} ${name}`;
  return args ? `${base} ${args}` : base;
}

// 自检那一条同理：仓库里是 `node scripts/install.mjs --check`，npm 装的是 `check` 子命令。
export function checkCmd() {
  return inCheckout() ? "node scripts/install.mjs --check" : `npx ${PKG} check`;
}

// 「重装一遍」那一条。npm 那边带 `@latest`：让用户去拉新的那一份，而不是重跑手上这份。
export function reinstallCmd() {
  return inCheckout() ? "node scripts/install.mjs" : `npx ${PKG}@latest install`;
}

// 这棵树里的 `scripts/` 用户敲不敲得着（测试和调用方要复用同一条判据时用它）。
export const isCheckout = inCheckout;
