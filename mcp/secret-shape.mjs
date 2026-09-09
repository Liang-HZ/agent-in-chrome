// 按**内容形状**认凭据——补上「按字段名认」认不出的那一类。
// 所以这里认的是**值长什么样**和**要的是什么**，与字段名无关：
//   · JWT —— `eyJ` 开头的三段式。`eyJ` 是 base64 的 `{"`，加上两个点几乎不可能误命中
//   · cookie 串 —— `a=1; b=2` 这种整串都是键值对的形状，要求 ≥2 对且整串匹配
//   · 意图 —— eval 的表达式提到 document.cookie / localStorage 之类，
//     或 cdp 调的是取 cookie 的命令。这一路是零误报的，而且能盖住
//     「只有一个 cookie，凑不满两对」这种内容判据够不着的情形
// 打码不是抹掉：`describe()` 会把**形状**如实说清楚（是什么、多长、cookie 有哪些名字），
// 因为「这个站有没有 sessionid」是正当问题，而回答它不需要值。

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/;

const COOKIE_JAR = /^[A-Za-z0-9_\-.~%]+=[^;=]*(?:;\s*[A-Za-z0-9_\-.~%]+=[^;=]*)+$/;

const TOKENISH = /^[A-Za-z0-9_\-.%~+/=]{16,}$/;

function hasOpaqueValue(s) {
  return s.split(/;\s*/).some((p) => TOKENISH.test(p.slice(p.indexOf("=") + 1)));
}

const CRED_EXPR = /document\s*\.\s*cookie|(?:local|session)Storage/i;

/*
 * 意图判据触发打码的最短长度：短到装不下一个会话凭据的返回值一律放行——
 * 宁可漏掉 `sid=x` 这种玩具值，也不能把正常的状态字符串打成码。
 * 内容判据（JWT / cookie 串）不受这条限制，它认的是形状，本来就自带长度要求。
 */
export const INTENT_MIN = 16;

const CRED_CDP = /^(?:Storage\.getCookies|Network\.get(?:All)?Cookies|Storage\.setCookies)$/;

/*
 * 这个字符串本身像不像凭据。
 * 只认前面说的两种形状——宁可漏，不可把正常数据打成码。
 */
export function looksLikeSecret(s) {
  if (typeof s !== "string") return false;
  if (s.length < 24) return false;
  if (JWT.test(s)) return true;
  const t = s.trim();
  return COOKIE_JAR.test(t) && hasOpaqueValue(t);
}

/*
 * eval 的表达式是不是在要凭据。
 * 这一路**看意图不看结果**，所以 `document.cookie` 只返回一个 cookie（凑不满两对）
 * 时照样拦得住。
 */
export function exprWantsSecrets(expression) {
  return typeof expression === "string" && CRED_EXPR.test(expression);
}

export function methodWantsSecrets(method) {
  return typeof method === "string" && CRED_CDP.test(method);
}

/*
 * 把一个凭据值描述成「说得清形状、给不出值」的字符串。
 *
 * cookie 串会把**名字**列出来：「这个站登录了吗」「有没有 csrftoken」是正当问题，
 * 回答它不需要值。名字最多列 12 个，免得一个塞了几十个 cookie 的站把摘要撑爆。
 */
export function describe(v) {
  if (typeof v !== "string") return `<凭据已隐去（${typeof v}）>`;
  const s = v.trim();
  if (COOKIE_JAR.test(s) && hasOpaqueValue(s)) {
    const names = s.split(/;\s*/).map((p) => p.split("=")[0]).filter(Boolean);
    const shown = names.slice(0, 12).join("、");
    const more = names.length > 12 ? `…等 ${names.length} 项` : "";
    return `<cookie 串，${names.length} 项：${shown}${more}；值已隐去，共 ${v.length} 字符>`;
  }
  if (JWT.test(v)) return `<含 JWT，值已隐去，共 ${v.length} 字符>`;
  return `<凭据已隐去，共 ${v.length} 字符>`;
}

export function redactSecrets(node, depth = 0) {
  let hit = false;
  const walk = (n, d) => {
    if (d > 6 || n == null) return n;
    if (typeof n === "string") {
      if (looksLikeSecret(n)) {
        hit = true;
        return describe(n);
      }
      return n;
    }
    if (Array.isArray(n)) return n.map((x) => walk(x, d + 1));
    if (typeof n === "object") {
      const out = {};
      for (const [k, v] of Object.entries(n)) out[k] = walk(v, d + 1);
      return out;
    }
    return n;
  };
  const value = walk(node, depth);
  return { value, hit };
}

/*
 * 把 cookie **对象**里的值隐去，名字/域名/属性照留。
 *
 * `Storage.getCookies` 回的是 `[{name,value,domain,httpOnly,…}]`——值是结构化的，
 * 上面那套按字符串形状认的判据够不着它（单个 cookie value 就是一串随机字符，
 * 和普通 id 长得一样，认它必然误报一片）。所以这条按**结构**认：
 * 一个对象同时有 name 和 value，且 value 是字符串，那它就是一条 cookie。
 *
 * 保留 name/domain 是刻意的，和 browser_cookies_export 的默认返回值一个口径：
 * 「这个站登录了吗、有几条、哪些是 httpOnly」都答得上来，唯独值给不出去。
 */
export function redactCookieObjects(node, depth = 0) {
  let hit = false;
  const walk = (n, d) => {
    if (d > 6 || n == null) return n;
    if (Array.isArray(n)) return n.map((x) => walk(x, d + 1));
    if (typeof n !== "object") return n;
    const isCookie = typeof n.name === "string" && typeof n.value === "string";
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (isCookie && k === "value") {
        hit = true;
        out[k] = `<值已隐去，${v.length} 字符>`;
      } else out[k] = walk(v, d + 1);
    }
    return out;
  };
  const value = walk(node, depth);
  return { value, hit };
}

/*
 * 「有没有」和「换掉」分开：`hasSecrets` / `hasCookieObjects` 只判有没有，不重建结构；
 * 两个 redact 函数才做替换。判据完全复用同一套规则，两处只有「命中之后做什么」不同——
 * 判据本身绝不能在这里另写一套，否则总有一天它们会认得不一样。
 */
export function hasSecrets(node, depth = 0) {
  const walk = (n, d) => {
    if (d > 6 || n == null) return false;
    if (typeof n === "string") return looksLikeSecret(n);
    if (Array.isArray(n)) return n.some((x) => walk(x, d + 1));
    if (typeof n === "object") return Object.values(n).some((v) => walk(v, d + 1));
    return false;
  };
  return walk(node, depth);
}

export function hasCookieObjects(node, depth = 0) {
  const walk = (n, d) => {
    if (d > 6 || n == null) return false;
    if (Array.isArray(n)) return n.some((x) => walk(x, d + 1));
    if (typeof n !== "object") return false;
    if (typeof n.name === "string" && typeof n.value === "string") return true;
    return Object.values(n).some((v) => walk(v, d + 1));
  };
  return walk(node, depth);
}
