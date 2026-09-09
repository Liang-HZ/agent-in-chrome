// Agent in Chrome — 工具档位表
// 两档：observe ⊂ full。TOOL_TIER 按工具名把每个工具归档；另有两张参数级提档登记表
// （REVEAL_REQUIRES_FULL / PARAM_REQUIRES_FULL）。server 据此过滤 tools/list 与每次调用。
// 归档判据只有一句话：**这个工具能不能替用户做出他没同意的事，或者交出他的凭据？**
// 能就进 full。observe 的诚实边界（写进 popup 与文档，不许出现「绝不」式承诺）：
// 读页面、截图、看网络、开自己的标签页并导航过去；不点、不填、不碰凭据——
// 但**导航本身会以用户身份发 GET 请求**，个别站点的退订/注销/删除就是 GET。
// **档位是按工具名圈的，但边界不是**：同一个工具的某个**参数**可以整个跨到凭据面 /
// 执行面去。所以这个文件除了 TOOL_TIER 还有两张「参数级提档」登记表——
// REVEAL_REQUIRES_FULL（凭据回显）和 PARAM_REQUIRES_FULL（按参数名的通用表，
// 目前登记着自由 JS 执行口）。两张表由 server 的**同一个** revealDenied 判定，
// 挂点是同样的三处：runTool / batch 的 plan 阶段 / tools/call；只按工具名判的闸会被参数
// 绕开，加新闸时工具名与参数名两侧都要挂。
export const TOOL_TIER = {
  browser_trace: "observe",
  browser_status: "observe",
  browser_tabs_list: "observe",
  browser_new_tab: "observe",
  browser_tab_release: "observe",
  browser_tab_group: "observe",
  browser_set_label: "observe",
  browser_set_task_state: "observe",
  browser_navigate: "observe",
  browser_read_page: "observe",
  browser_refresh_refs: "observe",
  browser_find: "observe",
  browser_screenshot: "observe",
  browser_scroll: "observe",
  browser_wait_for: "observe",
  browser_console: "observe",
  browser_network: "observe",
  browser_network_wait: "observe",
  browser_request_detail: "observe",
  browser_as_curl: "observe",
  browser_close_all: "observe",
  // batch 本身不做事，每一步在开跑前按档位单独校验过（server.mjs BATCH 校验）
  browser_batch: "observe",
  browser_click: "full",
  browser_type: "full",
  browser_hover: "full",
  browser_press_key: "full",
  browser_set: "full",
  browser_handle_dialog: "full",
  browser_tab_use: "full",
  browser_close_tab: "full",
  browser_eval: "full",
  browser_cdp: "full",
  browser_cookies_export: "full",
  browser_cookies_import: "full",
  browser_websocket: "full",
  browser_upload_file: "full",
  browser_emulate: "full",
  browser_reload_extension: "full",
};

export const TIER_RANK = { observe: 0, full: 1 };

/*
 * 这些工具的 revealSecrets 参数会把网络层原始请求头里的真实 Cookie / Authorization
 * 放进返回值。工具本身在 observe 档（看请求元数据是观察），但带上这个参数就跨进了
 * 凭据面——server 在 observe 档下对它们一律拒绝。
 * cookies_export / eval / cdp 也有 revealSecrets，但这三个整个工具就在 full 档，不用再列
 *（eval 与 cdp 的那个参数解的是**返回值里认出凭据形状**时的隐去，见 mcp/secret-shape.mjs）。
 */
export const REVEAL_REQUIRES_FULL = new Set(["browser_request_detail", "browser_as_curl"]);

/*
 * 参数级的档位闸（按参数名的通用登记表）：工具整体在 observe，但某个参数把它整个
 * 跨到执行面 / 凭据面去。判定与 revealSecrets 那道闸合成一支（server.mjs 的
 * `revealDenied`），挂点是同样的三处：runTool / batch 的 plan 阶段 / tools/call。
 *
 * 目前登记着一条：`browser_wait_for` 的 `js` —— 页面主世界的任意求值，能点、能填、
 * 能读 cookie，所以它在观察档被按 full 拦掉；`selector` / `urlContains` /
 * `textContains` 三条是纯观察，不受影响。完全档不拦，但返回值要过 `guardSecretResult`。
 *
 * 加新工具时：只要一个 observe 档工具的 inputSchema 里出现 js / expression / script /
 * code 这类自由执行字段，就必须登记到这里，否则 `test-config` 的结构性断言会红。
 */
export const PARAM_REQUIRES_FULL = {
  browser_wait_for: ["js"],
};

/* 结构性断言用：算作「自由 JS 执行口」的参数名。见 PARAM_REQUIRES_FULL 的头注释。 */
export const FREE_JS_PARAM_NAMES = ["js", "expression", "script", "code", "eval", "evaluate", "fn", "func", "function", "snippet", "source"];
