# 隐私说明 / Privacy

> 最后更新：2026-08-19。本文描述 Agent in Chrome 实际读写的每一样东西和精确位置。
> 代码全部开源，每一条都可以在源码里验证。English summary at the bottom.

## 一句话

**你的数据不离开你的电脑。** Agent in Chrome 自身零网络出站——没有遥测、没有统计、没有崩溃上报、不连任何我们的服务器。它访问哪些网页，完全由你对你的 agent 下的指令决定。

## 数据流

```
你的 agent（Claude Code / Cursor / …）
  ↕ 本机进程间通信（stdio + unix socket，不出网卡）
Agent in Chrome（MCP server + native host + 扩展）
  ↕ Chrome 调试协议（本机）
你的 Chrome
```

产品自身唯一的「网络」活动是访问 `127.0.0.1`（本机 Chrome 的调试端口）。
版本更新检查（向 npm registry 问一次 `agent-in-chrome` 的最新版本号）是唯一的例外，它**可以关**
（`AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1`），且只发出「查一下最新版本号」这一个请求，不携带任何本机信息。

## 它在你本机写什么、写在哪

| 位置 | 内容 | 保留策略 |
|---|---|---|
| `~/.agent-in-chrome/agent-in-chrome/` | 运行时代码副本、启动脚本 | 卸载时删除 |
| `~/.agent-in-chrome/token` | 本机连接令牌（权限 `0600`） | 卸载时删除 |
| `~/.agent-in-chrome/traces/` | 操作留痕（每步的工具名、打码后入参、当时页面 URL 和标题） | 最近 40 个会话 / 7 天，`AGENT_IN_CHROME_TRACE=off` 可整体关闭 |
| `~/.agent-in-chrome/screenshots/` | agent 要求的截图 | 保留最近 100 张 |
| `~/.agent-in-chrome/cookies/` | 你显式要求导出的 cookie（目录 `0700`、文件 `0600`） | 不自动清理——**这是明文凭据，不用了请自己删** |
| `~/.agent-in-chrome/*.log` | 连接日志（不含页面内容） | 超过 2MB 轮转一代（`.log.1`），只留当前和上一代 |
| 各浏览器的 `NativeMessagingHosts/org.liangai.agent_in_chrome.json` | native host 注册清单 | 卸载时删除 |
| 你的 agent 的 MCP 配置文件 | 一条 server 注册（写前自动备份原文件） | 卸载时移除 |
| CLI 模式：`~/.agent-in-chrome/agent-in-chrome/cli-profile/` | 一个专用 Chrome profile（该模式下浏览的历史、cookie、缓存） | 你可随时整目录删除 |

安装器在动手前会列出将要写入的每个路径；`npx @liang-hz/agent-in-chrome check` 随时可以看当前装了什么、在哪。

## 它读什么

- **你让 agent 访问的页面**：读取内容、执行操作，这是产品的功能本身。接管期间 Chrome 顶部有关不掉的「正在被调试」提示条；放开后消失。
- **各 Chrome profile 的 `Preferences` 文件（只读）**：仅安装/自检时用来判断扩展是否已装上。
- **「这一组是谁在开」用到的几样本机信息（只读）**：父进程链（`ps`）、MCP server 进程的当前目录及其所在 git 仓库名、以及 agent 客户端自己写在本机的会话记录（如 `~/.claude/sessions/`）里的会话标题。这几样只走「MCP server → 扩展 → 弹窗」这一条本机链路，显示给你自己看，既不出网卡也不进操作留痕。
- **本机文件（仅当 agent 上传文件时）**：`browser_upload_file` 有一个敏感路径黑名单（`.ssh`、`.aws`、Keychain、`.env`、私钥、密码库等），命中时必须显式确认并告知你才会继续。

## 什么东西被刻意挡住不外流

打码分两种判据，各管一头：**按字段名认**（这个字段叫什么）和**按内容形状认**（这串值长什么样）。逐个出口列清楚：

| 出口 | 挡住什么 |
|---|---|
| 页面读取结果（`browser_read_page` 等） | 密码框、信用卡号、CVV、有效期、短信验证码的值，只报「已填写（N 字符）」；`type=hidden` 的隐藏域（CSRF token、OAuth 的 `state`/`code`、会话标识）同样只报长度；被 `autocomplete` 标成凭据的**可编辑区**（contenteditable，「把恢复口令粘到这里」那类）的内容不进正文 |
| 填写类工具的回读值（`browser_set` 等） | 同上一行，判据完全一致 |
| 网络请求头 / 响应头（`browser_request_detail`、`browser_as_curl`） | `Cookie`、`Set-Cookie`、`Authorization`、token、api key、password 等头字段，只显示「有、多长、前几位」 |
| 网络请求**体** / 响应**体**（`browser_request_detail`、`browser_network` 的匹配行、`browser_as_curl` 的 `--data-raw`） | JWT（`eyJ…` 三段式）；JSON 与表单编码里键名像凭据的那些值（`access_token`、`refresh_token`、`client_secret`、`password`、`api_key`、OAuth 的 `code`…）。OAuth 回调那条 POST 的凭据全在体里，头打了码不等于挡住了 |
| 操作留痕 | **输入的文本只记长度**；凭据类头字段一律打码 |
| `browser_cookies_export` | 默认**不把 cookie 明文返回给模型**——写成 `0600` 文件，只回文件路径 |

需要原文时（排查 401、要一条能重放的 curl），显式传 `revealSecrets:true`——那一份就别往外发了。

已知边界，如实告知：

- 报文体这一侧**刻意不认「长长的随机十六进制/base64」**。哈希、内部 id、图片 data URI、压缩过的 JS 全长那样，把它们打成码只会让返回值没法读——把正常数据打成码比不打码更难用。所以认的是「一眼就是凭据」的那几种形状。
- 如果 agent 用 `browser_eval` 主动执行 JS 把 `document.cookie` 读进一个普通变量，按字段名的那套认不出来（这条由 MCP 侧按内容形状兜一道，见 `mcp/secret-shape.mjs`）。
- 页面自己把凭据当正文渲染出来（比如把 token 打印在页面上），那就是页面内容，读页面就会读到。

最后一道防线始终在上一层：skill 约定 + 你对 agent 的指令。

## Chrome 扩展权限，逐条说明用途

| 权限 | 为什么要 |
|---|---|
| `debugger` | 核心机制：通过 Chrome 调试协议读页面、发可信输入事件 |
| `nativeMessaging` | 和本机 MCP server 之间的唯一通道 |
| `tabs` / `tabGroups` | 列标签页；把 agent 开的页收进可见的彩色标签组 |
| `scripting` | 页面快照与元素定位的注入式管线（OOPIF 的唯一通道） |
| `storage` | 会话-标签页归属表、cookie 借出授权名单、agent 窗口记号。这些落在 `storage.local`，**活过重启**（授权 30 天到期，账本按页/组的生死增删）；只有拨号退避档位这类临时状态放会话存储 |
| `alarms` | service worker 被回收后自动拉起重连 |
| `<all_urls>` | agent 要能操作你指定的任意站点；不装白名单是因为**你**的指令决定去哪 |

扩展不注入任何广告、不改搜索、不采集浏览历史。

## English summary

Agent in Chrome makes **zero network calls of its own** — no telemetry, no analytics, no crash reporting. All traffic is local IPC (stdio, unix sockets, localhost CDP). The only optional exception is a version check against the npm registry that carries no local data and can be disabled. Everything it writes lives under `~/.agent-in-chrome/` with restrictive permissions (cookie exports `0600`, traces auto-pruned). Credential values are redacted at every exit, by two complementary tests — *what the field is called* and *what the value looks like*: passwords, card numbers, CVV, SMS codes, `type=hidden` fields (CSRF tokens, OAuth `state`/`code`) and credential-marked contenteditable regions never appear in page-reading results; credential request/response **headers and bodies** (JWTs, `access_token`, `refresh_token`, `client_secret`, OAuth `code`) are masked in network results and in generated `curl` commands; typed text is logged as length only; cookie exports return a file path, not plaintext. Pass `revealSecrets:true` when you genuinely need the original. Deliberate limit: opaque-looking blobs (hashes, ids, base64 images) are *not* masked — over-redacting normal data is worse than not redacting it. The uninstaller removes everything it installed. Which websites the tool touches is decided entirely by the instructions you give your agent.
