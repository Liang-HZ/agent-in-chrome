# 标签页与会话

## 组名是用户唯一看得见的字

同会话开的页自动进同一个标签组;组是折叠的、钉在标签条最右,用户只看到一个胶囊,上面是状态标记 + 任务名。任务名要说人话("Cloudflare 域名检查",不是 "task-3")。

## 用户已经开着那个页面

"打开我的 X 页面看看 Y" = 让你去看 X,不是征用他那张:`browser_tabs_list` 拿 URL,`browser_new_tab` 开自己的一张——登录态是浏览器级的,新页照样已登录。

真接管时(用户明说,或页上确有填了一半、重开就没了的东西),接管的页会被收进本会话的组,`browser_tab_release` 时移出还回原处。

## 页面自己开出来的新页

在你的页上点了 `target=_blank` 链接、或者页面自己 `window.open`(OAuth 弹窗之类),开出来的新页**一出生就归你**:进本会话的持有清单、进角标计数、带上接管遮蔽,`browser_status` 里能直接看到它的 `tabId`,拿这个 tabId 照常读页面/点/输入。收尾时 `browser_close_all` 把它当你自己开的页关掉。

所以点完跳转链接之后,先 `browser_status` 拿新页的 `tabId`,不用再 `tabs_list` + `tab_use` 去"捡"它。

新页出生的那一瞬间 Chrome 会把它放到前台(你的点击算用户手势),扩展当场就把用户原来那张活动页换回去,几十毫秒的事——**你不用为此做任何事,也别自己去 activate 任何页**。用户在别的 app 时 Chrome 仍会被提到前面,那一格扩展兜不住。

## subagent 并发

server 按每次调用的 `_meta.session_id` 派生会话身份,主会话与各 subagent 互不相同,每个 agent 自动拥有独立会话。

- subagent 自己 `new_tab`、自己操作、不用传 `tabId`,天然不串页。
- 主会话开的页 subagent 用不了(报错即隔离生效)。
- 走的哪条路看 `browser_status` 的 `sessionOrigin`。客户端不在 `_meta` 里带 `session_id` 时回落成"一个 MCP 进程一个会话",并行 agent 只剩 `tabId` 一道隔离。

## 另起浏览器实例时搬登录态(CLI / headless)

同一个浏览器上的多个会话共享登录态,不需要搬。只有**真的另起一个实例**才需要:Chrome 不许两实例共用 profile,新实例没有任何登录态。

- 新实例给一个 `AGENT_IN_CHROME_PROFILE`(0.39.0 起 socket 自动错开;更早版本还要手配不同的 `AGENT_IN_CHROME_SOCK`,漏配则第二实例静默变成第一个的从会话)。批量部署见仓库 `docs/CLI.md`。
- `browser_cookies_export` 的产物等价于完整会话凭据:只让 0600 文件的路径过手,别读进上下文、别贴聊天、别提交仓库。`cookies` 数组参数只留给"数组本来就在上下文里"的少数场合。
