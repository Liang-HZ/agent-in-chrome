#!/usr/bin/env node
// 用 ext-key.pem 把 extension/ 打成签名的 CRX3。
//   node scripts/pack-crx.mjs   →  dist/agent-in-chrome.crx
// 私钥缺失（仓库根目录没有 ext-key.pem）直接退出码 1，不产出半成品。
// CRX3 结构：
//   "Cr24" | uint32le(3) | uint32le(headerLen) | CrxFileHeader(protobuf) | zip
// 签名覆盖的字节是：
//   "CRX3 SignedData\0" | uint32le(len(signedHeaderData)) | signedHeaderData | zip

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "extension");
const KEY = path.join(ROOT, "ext-key.pem");
const OUT_DIR = path.join(ROOT, "dist");
const OUT = path.join(OUT_DIR, "agent-in-chrome.crx");

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function field(num, payload) {
  return Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
}

if (!fs.existsSync(KEY)) {
  console.error(`找不到私钥 ${KEY}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")).version;

const zipPath = path.join(OUT_DIR, "extension.zip");
fs.rmSync(zipPath, { force: true });
execFileSync("/usr/bin/zip", ["-r", "-X", "-q", zipPath, "."], { cwd: EXT_DIR });
const zip = fs.readFileSync(zipPath);

const pubDer = crypto.createPublicKey(fs.readFileSync(KEY)).export({ type: "spki", format: "der" });
const digest = crypto.createHash("sha256").update(pubDer).digest();
const crxId = digest.subarray(0, 16);
const extId = [...crxId]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")
  .split("")
  .map((c) => String.fromCharCode(c.charCodeAt(0) + (c >= "0" && c <= "9" ? 49 : 10)))
  .join("");

const signedHeaderData = field(1, crxId);

const lenLE = Buffer.alloc(4);
lenLE.writeUInt32LE(signedHeaderData.length, 0);
const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "binary"), lenLE, signedHeaderData, zip]);
const signature = crypto.sign("sha256", payload, {
  key: fs.readFileSync(KEY),
  padding: crypto.constants.RSA_PKCS1_PADDING,
});

const proof = Buffer.concat([field(1, pubDer), field(2, signature)]);
const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

const magic = Buffer.from("Cr24", "binary");
const ver = Buffer.alloc(4);
ver.writeUInt32LE(3, 0);
const hlen = Buffer.alloc(4);
hlen.writeUInt32LE(header.length, 0);
fs.writeFileSync(OUT, Buffer.concat([magic, ver, hlen, header, zip]));
fs.rmSync(zipPath, { force: true });

console.log(`打包完成  ${OUT}`);
console.log(`  版本    ${version}`);
console.log(`  扩展 ID ${extId}`);
console.log(`  大小    ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
