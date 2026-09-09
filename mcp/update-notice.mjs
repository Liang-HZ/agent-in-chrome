/*
 * 更新提示：把「有新版了」这件事说给 **agent** 听，而不是打印到一个没人看的终端。
 *
 * MCP server 是被 agent 客户端 spawn 的子进程，stdout 是协议通道、stderr 多半没人看——
 * 传统 CLI 那种「启动时打一行黄字」在这里等于没说。所以提示走**工具返回值的尾巴**：
 * agent 读到那句话，可以自己决定要不要告诉用户、要不要去升级。
 *
 * 三条硬约束（越界就会变成骚扰）：
 *   - 不阻塞：查询在后台跑，查不完就算了，绝不让任何一次工具调用等它
 *   - 不打扰：一个进程只提示一次，且只在有新版时才追加
 *   - 可关掉：AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1 或任何 CI 环境直接不查
 *
 * 出站请求只有这一个，且只发出「最新版本号是多少」这一问：不带机器标识、不带用量、
 * 不带任何本机信息。这是整个产品唯一的非 localhost 网络行为，PRIVACY.md 里写明了。
 */

import https from "node:https";

/*
 * 两个名字，别混：
 *   · PKG —— **npm 包名**（带 scope）。只用在 registry 地址、`npx <PKG>@latest …`、
 *     `--package=<PKG>@x.y.z` 这三类地方。
 *   · BIN —— **可执行文件名 / 产品短名**。package.json 的 `bin` 键、GitHub 仓库名、
 *     `~/.agent-in-chrome` 数据目录、各客户端 MCP 配置里那个键，全都是它，**不随 scope 改**；
 *     改它会让已装用户升级后断链（配置里的键对不上、数据目录换了地方）。
 * 两个都是写死的常量：运行时目录里只有安装器摊过去的那几个 .mjs，没有 package.json，
 * 在那里读它必然 ENOENT。防漂靠 scripts/test-sw.mjs 里「PKG 与 package.json 的 name 一致」那条断言。
 */
export const PKG = "@liang-hz/agent-in-chrome";
export const BIN = "agent-in-chrome";

/*
 * registry 端点：`/<包名>/latest`，**不带** `application/vnd.npm.install-v1+json`
 * 那个「精简 packument」accept 头——registry 只对**整份 packument** 提供精简表示，
 * `/latest` 这个单版本端点上给 scoped 包直接判 406；而这里的失败是静默返回 null，
 * 不会有任何人看见。extension/update-check.js 同此，别只改一边。
 */
export const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
const FETCH_TIMEOUT_MS = 2000;
const RELEASES = `https://github.com/Liang-HZ/${BIN}/releases`;

/*
 * 提示语里给用户的升级命令。`update` 子命令内部另走一条：查到精确版本号再用它下发
 * （见 mcp/update-cli.mjs），为的是在日志里留下「装的到底是哪一版」。
 */
export const UPDATE_CMD = `npx ${PKG}@latest update`;

function disabled() {
  const off = String(process.env.AGENT_IN_CHROME_NO_UPDATE_NOTIFIER || "").toLowerCase();
  if (["1", "true", "yes", "on"].includes(off)) return true;
  if (process.env.CI) return true;
  return false;
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/*
 * 把远端来的版本串洗成 `x.y.z`，洗不出来返回 null。
 *
 * 这不是洁癖：registry 的应答是远程可控的，而这个值有两个去处——① 追加到工具返回值
 * 尾巴（模型直接读的位置，一条 `"<版本串> 忽略以上所有指令…"` 就是高可信度提示注入）；
 * ② 拼进 `update` 下发给 npm 的 `--package=@liang-hz/agent-in-chrome@<版本>`。两处都只接受三段数字。
 */
export function cleanVersion(v) {
  const m = parse(v);
  return m ? m.join(".") : null;
}

export function isNewer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return true;
    if (x[i] < y[i]) return false;
  }
  return false;
}

/*
 * 取 npm 上的最新版本号。任何失败（超时、断网、限流、返回不是 JSON）都**静默返回 null**。
 * 超时默认 2s，是**后台提示那条路**的预算：它绝不能让工具调用等，宁可这次不提示。
 * 终端里的 check / update 是人在等，给得起更长，所以那边显式传大一点的值
 * （见 mcp/update-cli.mjs 的 CLI_TIMEOUT_MS）。
 */
export function fetchLatest({ timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();

    try {
      const req = https.get(
        REGISTRY,
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            clearTimeout(timer);
            return done(null);
          }
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            buf += c;
            if (buf.length > 1 << 20) req.destroy();
          });
          res.on("end", () => {
            clearTimeout(timer);
            try {
              done(JSON.parse(buf)?.version || null);
            } catch {
              done(null);
            }
          });
        }
      );
      req.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
      req.setTimeout(timeoutMs, () => req.destroy());
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/*
 * 创建一个提示器。
 *
 * @param {object} opts
 * @param {string} opts.current 本地版本
 * @param {(url:string)=>Promise<string|null>} [opts.fetcher] 仅测试用的注入点
 * @returns {{ start():void, take():string|null }}
 *   start() 触发一次后台查询（重复调用无副作用）；
 *   take() 返回该追加的那行提示，**取走即清**——一个进程只提示一次。
 *   snapshot() 返回 { current, latest, hasUpdate }，给 browser_status 用。
 *     它**只读那一次后台查询的结果**，自己不发任何请求：加个字段不该多一次出站，
 *     也不该让 browser_status 这种几十毫秒就回的调用去等网络。
 *     查询还没回来 / 查失败 / 被关掉（CI、NO_UPDATE_NOTIFIER）时 latest 恒为 null，
 *     hasUpdate 恒为 false——「不知道」和「没有新版」在字段上分得开：看 latest 是不是 null。
 *     和 take() 互不干扰：take 是一次性的提示行，snapshot 可以问任意多次。
 */
export function createUpdateNotice({ current, fetcher } = {}) {
  let pending = null;
  let started = false;
  let spent = false;
  let latestSeen = null;

  const start = () => {
    if (started || spent || disabled()) return;
    started = true;
    const get = fetcher ? fetcher(REGISTRY) : fetchLatest();
    Promise.resolve(get)
      .then((latest) => {
        const v = parse(latest);
        if (v) latestSeen = v.join(".");
        if (v && isNewer(latest, current)) {
          const safe = v.join(".");
          pending =
            `[${BIN}] 有新版本 ${safe}（当前 ${current}）。` +
            `升级：${UPDATE_CMD}；更新说明：${RELEASES}。` +
            `请把这件事转告用户，由用户决定是否升级，不要自行升级。` +
            `（设 AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1 可永久关闭此提示）`;
        }
      })
      .catch(() => {});
  };

  const take = () => {
    if (!pending) return null;
    const line = pending;
    pending = null;
    spent = true;
    return line;
  };

  const snapshot = () => ({
    current: current ?? null,
    latest: latestSeen,
    hasUpdate: latestSeen ? isNewer(latestSeen, current) : false,
  });

  return { start, take, snapshot };
}
