#!/usr/bin/env node
// 编译 aic-fg（前台归还 helper）。只在 macOS 上有意义。
// 用法：node native-host/mac-foreground/build.mjs [输出目录]
// 退出码永远是 0：编不出来是降级，不是失败。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER_NAME = "aic-fg";
export const SOURCE = path.join(HERE, "aic-fg.swift");

/*
 * 编译 aic-fg 到 outDir（默认与源码同目录），原子替换同名旧文件。
 * 非 macOS、或本机没有 swiftc 时不编译也不报错，返回 ok:false 与 why。
 * @returns {{ok:boolean, out?:string, why?:string}}
 */
export function buildForegroundHelper(outDir = HERE, { run = spawnSync } = {}) {
  if (process.platform !== "darwin") return { ok: false, why: "非 macOS，这个 helper 只在 macOS 上有意义" };
  const which = run("/usr/bin/which", ["swiftc"], { encoding: "utf8" });
  if (which.status !== 0 || !String(which.stdout || "").trim())
    return { ok: false, why: "没有 swiftc（装 Xcode Command Line Tools 可得）——走 open -b 兜底路径" };
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, HELPER_NAME);
  const tmp = `${out}.incoming-${process.pid}`;
  const r = run("swiftc", ["-O", "-o", tmp, SOURCE], { encoding: "utf8" });
  if (r.status !== 0) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, why: `swiftc 失败：${String(r.stderr || r.stdout || "").trim().slice(0, 400)}` };
  }
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, out);
  return { ok: true, out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = buildForegroundHelper(process.argv[2] || HERE);
  console.log(r.ok ? `已编译：${r.out}` : `未编译：${r.why}`);
}
