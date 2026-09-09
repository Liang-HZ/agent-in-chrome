// Agent in Chrome — 桥接令牌。unix socket 认不出对端是谁，而这条连接的能力是**驱动用户
// 本人那个登录着的浏览器**，所以上两道：目录 0700 / socket 0600（同机器上别的用户根本
// 连不上来），外加 32 字节令牌（挡误连，以及 socket 路径被指到宽松目录时的跨用户访问）。
// 握手是质询-应答：主先出题，拨号方用令牌算 HMAC 作答，主再回一份反向证明。零依赖。
// 【诚实的边界】令牌**不挡同一个用户下的恶意进程**：令牌文件本身就是 0600、属主
// 就是当前用户，任何以该用户身份跑的进程（恶意 npm 包的 postinstall、被点开的
// 下载物）都能直接读走它再连 socket。对这个威胁模型，本机没有任何秘密能立足——
// 能防它的只有操作系统级隔离（别的用户/沙箱/容器），不是我们发一个它读得到的令牌。
// 别把这层写成「防同用户其他进程」——用户会按这个错误承诺做安全决策。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";

const TOKEN_FILE = "token";

/*
 * 令牌放在哪。
 *
 * 必须和 server.mjs / host.mjs 算 SOCK 的口径一致：显式指定了 AGENT_IN_CHROME_SOCK
 * 的场合（测试、自定义安装、CLI 模式的第二条 socket），令牌要跟着那条 socket 走。
 * 不跟着走的后果是测试会去读、去建**用户真实的那份**令牌——既污染他的安装，
 * 又会在他改过权限之后莫名其妙地红。
 */
export function defaultDataDir() {
  const sock = process.env.AGENT_IN_CHROME_SOCK;
  if (sock && !isPipePath(sock)) return path.dirname(path.resolve(sock));
  return path.join(os.homedir(), ".agent-in-chrome");
}

/*
 * Windows 命名管道路径（\\.\pipe\… 或 \\?\pipe\…）。
 * 这种路径**不是文件**：不能 dirname 出令牌目录、不能 unlink、不能 chmod——
 * 所有把 SOCK 当文件用的地方都要先过这个判断。
 */
export function isPipePath(p) {
  return /^\\\\[.?]\\pipe\\/i.test(String(p || ""));
}

/*
 * 把「身份路径」翻译成 net.listen/connect 真正用的端点。
 *
 * SOCK 在全项目里承担两个角色：桥接的**身份**（令牌目录跟着它、每条身份一个主）和桥接的
 * **端点**（真正 bind 的地址）。macOS/Linux 上两者是同一个文件路径；Windows 上端点必须是
 * 命名管道，而管道路径当不了身份（不落盘、没有目录）——所以身份路径保持不变，只在临门
 * 一脚翻译成管道名：路径进 hash，保证「不同 SOCK 必然不同管道」，测试和多 profile 的隔离
 * 语义原样成立。
 *
 * 两个平台的安全口径不一样，别混：unix socket 靠目录 0700 挡同机别的用户（别人建不出那个
 * 路径）；Windows 的管道命名空间是全局的，管道名由固定路径派生、完全可预测，任何本机进程
 * 都能抢先把它建出来占住，我们再 listen 只拿得到 EADDRINUSE、按既定逻辑降级成从、
 * 回头去连那个抢占者。所以命名管道上**只认质询-应答握手**，明文令牌一个字都不发。
 */
export function bridgeEndpoint(sockPath) {
  if (process.platform !== "win32") return sockPath;
  if (isPipePath(sockPath)) return sockPath;
  const h = crypto.createHash("sha1").update(path.resolve(sockPath)).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\agent-in-chrome-${h}`;
}

export function dataDirFor(sockPath) {
  if (isPipePath(sockPath)) return path.join(os.homedir(), ".agent-in-chrome");
  return path.dirname(path.resolve(sockPath));
}

export function tokenPath(dir = defaultDataDir()) {
  return path.join(dir, TOKEN_FILE);
}

/*
 * 建目录并把权限收到 0700。
 *
 * 已经存在的目录也要收：老版本建出来的是 0755，多用户机器上别人能进去读令牌、
 * 也能 connect 那条 socket。升级的人是**最需要**被修好的那批（他们的目录已经敞着一段时间了），
 * 只保护新装的等于没修。
 */
export function ensureDataDir(dir = defaultDataDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      const st = fs.statSync(dir);
      if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    } catch {}
  }
  return dir;
}

/*
 * 读令牌，没有就现建一个。
 *
 * 建的时候把 0600 写在 open 的参数里，而不是先写再 chmod：先写再 chmod 中间有一瞬
 * 文件是按 umask 建出来的（通常 0644），那一瞬别人读得到——同 saveCookies 那处的理由。
 */
export function getToken(dir = defaultDataDir()) {
  ensureDataDir(dir);
  const file = tokenPath(dir);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cur = fs.readFileSync(file, "utf8").trim();
      if (cur) {
        const st = fs.statSync(file);
        if (typeof process.getuid === "function" && st.uid !== process.getuid())
          throw new Error(
            `拒绝采用 ${file}：文件属主不是当前用户。世界可写目录里的令牌文件可能是别人预置的——` +
              `删掉它，或把 AGENT_IN_CHROME_SOCK 指回你自己的私有目录（别用 /tmp）。`
          );
        if (process.platform !== "win32" && st.mode & 0o077) fs.chmodSync(file, 0o600);
        return cur;
      }
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const val = crypto.randomBytes(32).toString("base64url");
    try {
      fs.writeFileSync(file, val, { mode: 0o600, flag: "wx" });
      return val;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`建不出桥接令牌 ${file}（目录不可写？）`);
}

/*
 * 定长时间比较。
 *
 * 逐字符比较会因为「第几位开始不同」而快慢不同，本机进程可以拿它一位一位地猜出令牌。
 * 长度不同直接返回 false：crypto.timingSafeEqual 长度不等会抛，而且长度本来就藏不住。
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const A = Buffer.from(a, "utf8");
  const B = Buffer.from(b, "utf8");
  if (A.length === 0 || A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function handshakeNonce() {
  return crypto.randomBytes(24).toString("base64url");
}

/*
 * 握手证明：拿令牌当 HMAC 密钥，对「方向 + 两边各出的随机数」签一次。
 *
 * 三条都是必要的，少一条就漏：
 *   · **令牌当密钥、不当消息** —— 这次修的就是「令牌明文过线」。签出来的东西
 *     换一次握手就作废，抢占管道名的人拿到也没用。
 *   · **两边各出一个随机数** —— 只有主出题的话，抢占者可以把偷来的 {nonce,proof}
 *     原样重放给真正的主；只有拨号方出的话，主没法确认这次不是重放。各出一个，
 *     两个方向都不可重放。
 *   · **方向进签名（side）** —— 不分方向的话，主发出去的那份反向证明可以被抢占者
 *     掉头拿来冒充拨号方（反射攻击）。
 *
 * token 读不到时（host 那侧会回落成空串）照样算得出一个值，但它必然对不上主的那份，
 * 于是被当场拒——比「悄悄放行」好，也比在这里抛异常好。
 */
export function handshakeProof(token, side, serverNonce, clientNonce) {
  return crypto
    .createHmac("sha256", String(token ?? ""))
    .update(`agent-in-chrome/bridge/1|${side}|${serverNonce}|${clientNonce}`)
    .digest("base64url");
}

/*
 * 拒绝时回给对方的那一句。
 *
 * 只说「第一行该长什么样」和「令牌在哪个文件」，不说令牌是什么——路径不是秘密
 * （能读到它的人已经赢了），但它能让真正的调用方自己看出是没带、还是带错了。
 */
export function unauthorizedMessage(dir = defaultDataDir()) {
  return (
    `未通过桥接认证：主会先发 {"type":"challenge","nonce":"…"}，第一行必须是 ` +
    `{"type":"hello","role":"host"|"peer","nonce":"<你出的随机数>","proof":"<见 mcp/token.mjs 的 handshakeProof>"}` +
    `（unix socket 上仍认老写法 {"type":"hello","role":…,"token":"…"}；命名管道上不认——` +
    `那个名字可以被抢占，明文令牌等于白送）。` +
    `令牌取自 ${tokenPath(dir)}（0600，只有本人读得到）。` +
    `这条 socket 能驱动你登录着的浏览器，所以证明不了自己的连接一律断开。`
  );
}

export function permStatus(dir = defaultDataDir()) {
  const modeOf = (p) => {
    try {
      return fs.statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  };
  const file = tokenPath(dir);
  return { dir, dirMode: modeOf(dir), tokenFile: file, tokenMode: modeOf(file), tokenExists: fs.existsSync(file) };
}

/*
 * 清掉这个目录里**没人在听**的 CLI 桥接 socket 文件，返回删掉的个数。
 *
 * 只扫按 profile 分出来的那些（名字里带 hash）：非正常退出（SIGKILL、崩溃、被整组打掉的
 * 测试进程）不跑 cleanup，而 CLI 模式一个 profile 一个 socket 名，于是死文件只涨不减。
 * 固定路径的那两条不碰——下一个进程 bind 时的探活-unlink 会自然处理掉，攒不起来。
 *
 * 两道保险，方向都是「宁可留下，不可错删」：
 *   · **年龄**：太新的不碰。活着的主可能正卡在 bind 与 listen 之间（毫秒级窗口），
 *     那时文件已经出现、还连不上；错删的代价是把一个活主的 socket 删了，
 *     后来的人连不到它，于是选出第二个主。
 *   · **探活**：连得上就是有主，一律留着。
 *
 * @param keep   不许碰的路径（本进程自己那条 SOCK）
 * @param probe  (path) => Promise<boolean>，连得上返回 true。测试从这里换掉
 */
export async function pruneDeadSocks({
  dir = defaultDataDir(),
  keep = [],
  minAgeMs = 60_000,
  now = Date.now,
  fs: fsMod = fs,
  probe = probeSock,
} = {}) {
  const spare = new Set(keep.map((p) => path.resolve(p)));
  let names = [];
  try {
    names = fsMod.readdirSync(dir).filter((n) => /^agent-in-chrome-cli-[0-9a-f]{8}\.sock$/.test(n));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    const f = path.join(dir, n);
    if (spare.has(path.resolve(f))) continue;
    try {
      const st = fsMod.statSync(f);
      if (!st.isSocket()) continue;
      if (now() - st.mtimeMs < minAgeMs) continue;
      if (await probe(f)) continue;
      fsMod.unlinkSync(f);
      removed++;
    } catch {
    }
  }
  return removed;
}

function probeSock(file) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        c.destroy();
      } catch {}
      resolve(v);
    };
    const c = net.connect(file);
    c.on("connect", () => finish(true));
    c.on("error", (e) => finish(!(e?.code === "ECONNREFUSED" || e?.code === "ENOENT")));
    setTimeout(() => finish(true), 300).unref?.();
  });
}
