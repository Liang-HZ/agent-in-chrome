#!/usr/bin/env node
/*
 * `prepublishOnly` 闸：防止在**私有源检出**里手滑 `npm publish`。
 *
 * 三条判据（任何一条命中就拒绝发布，退出码 1，问题打在 stderr）：
 *   1. 仓库根有 `.private-source` 标记，或者树里有 `scripts/release/`（发布流水线本身，
 *      公开快照里被整个排除）→ 这是私有源，拒绝。
 *   2. 随机抽 5 个 .js/.mjs，找**未还原的公开标记**（行首 `//!` 或 `/*!`），找到就拒绝。
 *   3. 树里有**私有层**测试（live 层 `e2e-browser` / `e2e-concurrency` / `e2e-mcp-sdk`、
 *      手动验证脚本 `verify-*.mjs`、只被 live 层引用的 `png-diff` / `read-page-bench`、
 *      发布工具自己的 `test-release-*`、官网的 `test-site`）→ 拒绝。
 *      公开层测试（不需要浏览器的那一层）**随包发布，这里放行**。
 *      判据只看文件名，失败方向是「像私有层就拒」。
 *
 * 判据一律收窄到**行首**（去掉前导空白之后）：这个文件跟着公开包一起发，
 * 不能 import 剥离器，只能自带判据，宁可漏报也不误报。
 *
 * 失败方向：认不出就当成「没剥过」拒绝，不是放行。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 保守判据：整行去掉前导空白之后以未还原的公开标记 `//!` 或 `/*!` 开头 */
export function unrestoredMarkerLines(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("//!") || t.startsWith("/*!")) out.push({ line: i + 1, text: lines[i].trim().slice(0, 100) });
  }
  return out;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

// 「这是测试文件」的判据：TEST_FILE_RE 是正则表，isTestFile(rel) 拿相对路径问一次，
// 正则锚在 basename 开头，命中即视为测试文件。
export const PRIVATE_TEST_FILE_RE = [
  /(^|\/)e2e-(browser|concurrency|mcp-sdk)\.mjs$/,
  /(^|\/)verify-[^/]+\.(mjs|cjs|js)$/,
  /(^|\/)png-diff\.mjs$/,
  /(^|\/)read-page-bench\.mjs$/,
  /(^|\/)test-release-[^/]+\.(mjs|cjs|js)$/,
  /(^|\/)test-site\.mjs$/,
  /(^|\/)pack-store\.mjs$/,
  /(^|\/)scripts\/probe(\/|$)/,
];

export function isPrivateTestFile(rel) {
  const p = String(rel).split(path.sep).join("/");
  return PRIVATE_TEST_FILE_RE.some((re) => re.test(p));
}

/* 全树列文件（不只是 js——CI 工作流也要看得见）：返回相对 root 的路径数组，跳过 .git / node_modules / dist */
export function listAllFiles(dir, acc = [], root = dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listAllFiles(p, acc, root);
    else if (e.isFile()) acc.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return acc;
}

export function listJs(dir, acc = [], root = dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, acc, root);
    else if (e.isFile() && /\.(mjs|cjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/*
 * 抽样。默认真随机——每次 publish 抽不同的 5 个，长期下来覆盖面比固定 5 个大得多。
 * 传 rng 便于单测钉死抽样。
 */
export function pickSample(files, n = 5, rng = Math.random) {
  const a = files.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// guard(root, { rng, sampleSize })：跑一遍三条判据，返回问题描述字符串数组；
// 空数组 = 放行。只读不写，不碰进程退出码，退出码由调用方决定。
export function guard(root = ROOT, { rng = Math.random, sampleSize = 5 } = {}) {
  const problems = [];

  const privateSigns = [".private-source", "scripts/release/strip-comments.mjs"].filter((p) =>
    fs.existsSync(path.join(root, p)),
  );
  if (privateSigns.length) {
    problems.push(
      `这是**私有源检出**（${privateSigns.join(" / ")} 都只在私有树里有），不许从这里发 npm。\n` +
        "  npm 只能从剥好注释的公开检出发：\n" +
        "    node scripts/release/publish.mjs --publish",
    );
  }

  const tests = listAllFiles(root).filter(isPrivateTestFile);
  if (tests.length) {
    problems.push(
      `这棵树里有**私有层**测试（${tests.length} 个，例如 ${tests.slice(0, 3).join("、")}）——` +
        `live 层 / 发布工具自测 / 官网测试都不随公开包发布，不许发。\n` +
        `  公开层测试（不需要浏览器的那一层）是允许的，这里放行的就是那一层。\n` +
        `  正常的公开检出由 scripts/release/publish.mjs 生成，它一支私有层测试都不会放进来。`,
    );
  }

  const files = listJs(root);
  if (files.length === 0) {
    problems.push("一个 .js/.mjs 都找不到：包的内容不对，先查快照是怎么打的。");
  } else {
    const sample = pickSample(files, sampleSize, rng);
    for (const f of sample) {
      let text;
      try {
        text = fs.readFileSync(f, "utf8");
      } catch (e) {
        problems.push(`读不了 ${path.relative(root, f)}：${e.message}`);
        continue;
      }
      const hits = unrestoredMarkerLines(text);
      if (hits.length) {
        problems.push(
          `${path.relative(root, f)} 里还有未还原的公开标记（抽样命中 ${hits.length} 行，` +
            `例如第 ${hits[0].line} 行：${hits[0].text}）——这棵树没剥过注释，不许发。`,
        );
      }
    }
  }
  return problems;
}

function main() {
  const problems = guard();
  if (problems.length === 0) {
    process.stderr.write("prepublishOnly 闸通过：不是私有源、树里没有私有层测试、抽样未见未还原的公开标记。\n");
    return 0;
  }
  process.stderr.write("拒绝发布：\n" + problems.map((p) => `  - ${p}`).join("\n") + "\n");
  return 1;
}

function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) process.exit(main());
