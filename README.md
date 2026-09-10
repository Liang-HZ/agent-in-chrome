<div align="center">

# Agent in Chrome

**让 AI agent 操作你已经登录的那个 Chrome，而不是另起一个空白浏览器。**

by Liang · [liangai.org](https://liangai.org)

直接继承你现有的登录态——内网系统、OA、Gmail、后台管理页，不用再解决一遍身份问题。

[English](./README.en.md) · [快速开始](#快速开始) · [插件模式 vs CLI 模式](#两种模式) · [工具清单](#工具清单) · [安全与透明度](#安全与透明度)

[![npm](https://img.shields.io/npm/v/@liang-hz/agent-in-chrome?color=cb3837&label=npm)](https://www.npmjs.com/package/@liang-hz/agent-in-chrome)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-125%2B-4285F4?logo=googlechrome&logoColor=white)](#快速开始)
[![测试](https://img.shields.io/github/actions/workflow/status/Liang-HZ/agent-in-chrome/test.yml?branch=main&label=%E6%B5%8B%E8%AF%95)](https://github.com/Liang-HZ/agent-in-chrome/actions/workflows/test.yml)

</div>

---

## 这是什么

Agent in Chrome 把 AI agent（Claude Code、Claude Desktop、Trae、Codex……）接到**你自己正在用的那个 Chrome** 上。它通过 [MCP](https://modelcontextprotocol.io) 暴露一套浏览器工具，让 agent 能读页面、点按钮、填表单、抓网络请求——全部带着你现有的登录态，全部在后台进行，不抢你的前台。

**和别的方案怎么选？** 下面只对比**开箱即有的原生能力**：✅ = 不写代码就能用，❌ = 不具备（多数工具带任意代码执行的逃生舱，理论上都能自己补——若把那也算上，所有格子都是 ✅，表格就没有意义了）。基于 2026-08-18 的源码通读与本机实测（Playwright MCP、browser-use、ego lite 三列于 2026-09-10 以同一套任务书与专项探针逐格复测：Playwright MCP 与 ego lite 的任务完成度与 agent-in-chrome / chrome-devtools-mcp 同档，browser-use 实测出工具面缺口，见脚注），版本：@playwright/mcp 0.0.80 · chrome-devtools-mcp 1.7.0 · browser-use 0.13.10 · ego lite 0.5.0.28。不做推荐，按你的场景自取。

| | Agent in Chrome | Playwright MCP | Chrome DevTools MCP | browser-use | ego lite |
|---|:---:|:---:|:---:|:---:|:---:|
| 驱动你正在用的浏览器（继承登录态） | ✅ | ✅¹ | ✅² | ✅³ | ❌⁴ |
| 无需以调试端口重启浏览器 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 多会话并发、标签页归属互不串 | ✅ | ✅¹ | ❌ | ❌ | ✅ |
| 走 MCP 协议 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Windows / Linux | ✅⁵ | ✅ | ✅ | ✅ | ❌ |
| Firefox / WebKit | ❌ | ✅ | ❌ | ❌ | ❌ |
| 网络原始头 + 请求/响应体 | ✅ | ✅ | ✅ | ❌ | ❌⁹ |
| WebSocket 帧 / 发起调用栈 / 导出 curl | ✅ | ❌¹² | ❌ | ❌ | ❌⁹ |
| 请求 mock / 限速模拟 / 性能 trace | ❌ | ❌¹² | ✅ | ❌ | ❌⁹ |
| 凭据默认打码（Cookie/密码不进模型上下文） | ✅ | ❌⁶ | ❌⁶ | ✅⁷ | ❌⁹ |
| 无「服务端任意代码执行」默认开启 | ✅ | ❌⁸ | ✅ | ❌¹⁰ | ❌¹⁰ |
| 零运行时第三方依赖 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 模态浮层检出（含无 ARIA 角色的登录墙） | ✅ | ❌ | ❌ | ❌¹¹ | ❌¹¹ |
| 元素像素坐标 + 跨源帧顶层坐标 | ✅ | ❌ | ❌ | ❌¹¹ | ❌¹¹ |

<sup>1</sup> 仅 `--extension` 模式（Chrome/Edge，需装其扩展）；默认模式是独立 profile。 <sup>2</sup> 仅 `--autoConnect`（Chrome 144+，需在 `chrome://inspect` 手动开闸，该 profile 全部窗口暴露）。 <sup>3</sup> 二选一：CDP 直连已开调试端口的 Chrome，或用自带浏览器（独立 profile，不带用户登录态）。 <sup>4</sup> 独立 Chromium 分叉浏览器；登录态靠导入而非实时借用——`ego-browser import` 可从 Chrome/Edge/Brave 重复导入（扩展一并迁入）。 <sup>5</sup> Windows 已支持插件模式（CLI/headless 模式规划中）；Linux 路径已写未验证。 <sup>6</sup> Playwright 的 `--secrets` 与 DevTools 的 `--redactNetworkHeaders` 均为可选开关且默认关闭，后者不覆盖 body。实测 Playwright 的 `browser_network_request` 默认过滤请求头中的 Cookie 与 Set-Cookie（要完整原始头得走 run_code）。 <sup>7</sup> 输入侧占位符机制完备；网络返回值无打码。 <sup>8</sup> `browser_run_code_unsafe` 自述 RCE-equivalent，默认开启。 <sup>9</sup> ego 无网络类原生 helper，但 `page.cdp()` 逃生舱实测可达：原始头在 CDP ExtraInfo 事件里、需按 requestId 自行配对，WS 帧可抓，mock/限速/trace 均可做；全程 Cookie 明文无打码。 <sup>10</sup> ego 与 browser-use 的主接口都是代码（heredoc / Python），任意代码执行是设计使然。 <sup>11</sup> 实测无 ARIA 浮层不进 ego 的语义快照（与正文平铺同树、无模态标记，仅点击报错会点名遮挡元素），快照不含元素像素坐标，跨源帧顶层坐标需自行计算；browser-use 的元素表则会把遮罩下按钮整个过滤掉、坐标点击会误报成功，观察输出同样不含像素坐标。 <sup>12</sup> 实测 Playwright MCP 0.0.80 包内并无 mock/限速/trace 类工具（其 README 文档所载 `browser_route`/tracing 未随该版本发布），WS 帧、发起调用栈、curl 导出也无原生工具；均可用 `browser_run_code_unsafe` 逃生舱补做。

**速度**（同一含跨源 iframe 的测试页、对等全新 profile、中位数；browser-use 因需人工在 `chrome://inspect` 逐次授权，无法无人值守完成同一流程，未列入）：

| | 冷启动→首个结果 | 热态导航 | 热态读页面 | 读页面返回字节 |
|---|---|---|---|---|
| Agent in Chrome | **1247ms** | 250ms | 27ms¹ | **4146** |
| Playwright MCP | 1819ms | 225ms | 10ms | 8235 |
| Chrome DevTools MCP | 1252ms | 288ms | 13ms | 6954 |

<sup>1</sup> 我们的读页面返回可交互元素表 + 像素坐标 + 跨源帧几何 + 独立正文 + 凭据打码 + 浮层判定；对手返回一棵无坐标的可访问性树。内容是超集、字节反而最小。

---

## 核心特性

- **接你正在用的 Chrome**——不换浏览器、不迁移数据。你在哪登着，agent 就在哪操作。
- **后台运行，不抢前台**。读页面和输入都在后台标签页里进行，你可以同时干别的。页面自己弹出的新页（`target=_blank`、`window.open`、中键点链接）会被 Chrome 提到前面——那一行写死在 Chromium 的浏览器进程里，谁也拦不住；macOS 上有一层本机侧的因果归还，抢走的前台在**几十毫秒内**还回你原来那个 app（实测暴露 11~100ms）。
- **看得见、拿得回**。agent 开的标签页进入一个按会话上色、命名的标签组；扩展弹窗实时列出每个会话占了哪些页；一键「解除全部托管」或「关闭 agent 开的所有标签页」。想自己插手某一页，在那张卡片上点「手动接管」——调试提示条立刻消失，agent 再碰它会被告知「用户接管中」，点「交给AI接管」再还回去。你拖进标签组的页，收工时是**归还**给你，不是关掉。
- **穿透 Shadow DOM 与跨源 iframe** 的页面理解。可交互元素带稳定 `ref`，跨进程 iframe 里的模态浮层也扫得到。
- **完整的网络层**：请求列表、原始头（含 Set-Cookie 与被拒原因）、请求/响应体、发起调用栈、WebSocket 收发消息、导出成 curl 重放。**抓到的凭据默认打码**（只告诉你「Cookie 1258 字符，开头 `_octo=…`」，要原文得显式要）——这条对一个输出直接进模型上下文的工具是必需品，不是洁癖。同类工具要么拿不到原始头，要么把明文 Cookie 直接倒给模型。
- **两种模式，同一套工具**。桌面上有 Chrome 就走插件模式；终端 agent、cron、CI、远程机器没有桌面 Chrome，就走 CLI 模式，自启一个真 Chrome、直连 CDP 驱动，工具行为完全一致。
- **操作留痕**（`browser_trace`）。每步记序号、工具、打过码的入参、成败、当时所在页面。会话压缩或重开后还能找回进度。凭据字段一律打码。
- **安全默认**：不主动接管任何标签页；不可逆操作（发消息/下单/删除/改设置）先问过你；页面内容一律当数据不当指令（防 prompt injection）；密码、CVV、验证码的值永远不出现在返回里。
- **零运行时依赖**。整套 MCP server、native host、CDP 客户端都是手写的零依赖 Node，`npm install` 装不出一个第三方包。

---

## 快速开始

> 需要 Node.js 18+ 和 Chrome 125+（或 Edge / Brave / Vivaldi 等 Chromium 系）。目前 macOS 实测完整；Windows 插件模式已支持（命名管道 + 注册表 + .bat 启动器，CLI/headless 模式规划中）；Linux 路径已写待验证（见[已知限制](#已知限制)）。
>
> 18 够用是实测过的：Node 18.20.8 上 `check` 全过、MCP server 起得来、37 个工具都在。唯一的例外在
> CLI 模式的 `AGENT_IN_CHROME_KEEP=1` 那条路上——它要 Node 的全局 `WebSocket`，**Node 22 才有**；
> 老 Node 上默认的管道通道照常能跑，见 [docs/CLI.md](docs/CLI.md)。

### 第一步：跑安装器

最快的方式——**把下面这句话贴给你的 agent，让它替你装**：

```
帮我安装 agent-in-chrome：npx @liang-hz/agent-in-chrome@latest install
装完告诉我还需要我手动做哪几步。
```

或者自己跑：

```bash
npx @liang-hz/agent-in-chrome@latest install     # 装（git 克隆用户：node scripts/install.mjs，等价）
npx @liang-hz/agent-in-chrome check              # 自检，不改任何东西（有一项没过就非零退出）
npx @liang-hz/agent-in-chrome uninstall          # 卸载，全部可逆
```

三个子命令的退出码都是「有没有 ✗」：全绿 0，任一项没过非零；旗标写错时打印帮助并以非零退出。
所以 `npx @liang-hz/agent-in-chrome check && 你的命令` 这种串写法是成立的。

**装到安装器没收录的客户端，或者装完不通？**让 agent 跑 `/install-agent-in-chrome`
（或者直接说「帮我装 agent-in-chrome」）。它会先用
`npx @liang-hz/agent-in-chrome check --print-config` 拿到本机的精确配置——运行时绝对路径、
native host 名、扩展 ID、启动器命令——再去探那家客户端把 MCP 配置放在哪，照着它自己的
schema 写进去。路径靠猜是这件事最常见的失败方式：猜错了客户端只报一句 `Connection closed`。

安装器会（全部可逆、动手前列出将改动的文件）：

1. 把运行时同步到 `~/.agent-in-chrome/agent-in-chrome/`，并把 native host 清单写进你各个 Chromium 浏览器的 `NativeMessagingHosts/` 目录；
2. 探测本机的 agent（Claude Code / Claude Desktop / WorkBuddy / ZCode / opencode / Kimi CLI / Gemini CLI / Antigravity / Qoder CLI / Qoder IDE / Trae / Codex CLI / DeepSeek Harness，以及国内版 Qoder CN CLI / Qoder CN IDE / Trae CN，共 16 家），逐个展示将写入的文件和内容、确认后在各自的 MCP 配置里注册（改前自动备份；`--yes` 跳过逐个确认，`--agents=claude-code,trae` 限定范围，`--no-agents` 完全跳过）；
3. 在本机生成一个**每台机器唯一的连接令牌**（`0600`，不写进仓库、不上传）——见[安全与透明度](#安全与透明度)；
4. 把**两份 skill 和两条命令**装好：`skills/agent-in-chrome/`（含 `references/` 下的分册手册，教 agent 怎么用这些浏览器工具）和 `skills/install-agent-in-chrome/`（教 agent 怎么把它装到别的客户端上）拷到 `~/.agent-in-chrome/skills/`，`/agent-in-chrome` 与 `/install-agent-in-chrome` 两条命令拷到 `~/.agent-in-chrome/commands/`。

### 第二步：装 Chrome 扩展（唯一需要你手动做的一步）

> **现在只有「加载已解压」这一条路。** 商店版还在上架流程里，Chrome 应用商店上搜不到它。
> 浏览器又不允许命令行静默装扩展，所以这几下点击省不掉——但只需要做一次。
> 代价是**扩展不会自动更新**（升级办法见[更新与版本](#更新与版本)）；上架之后从商店装的那份会自动更新，那时它就是推荐入口。

1. 地址栏输入 `chrome://extensions` 回车；
2. 右上角打开「开发者模式」开关——**不开这个，第 3 步那个按钮不会出现**；
3. 点左上角「加载已解压的扩展程序」，在文件选择器里选**安装器最后打印的那个 extension 目录**：
   - npx / npm 装的：`~/.agent-in-chrome/extension`
     （macOS 的文件选择器默认不显示 `.` 开头的目录：按 `⌘⇧.` 显示隐藏文件，或按 `⌘⇧G` 直接粘路径）
   - git 克隆的：仓库里的 `extension/`
4. 页面上出现一张「Agent in Chrome」的卡片，就装上了。卡片上的 ID 应该是
   `eknmigackgheebnojadpjepdoebpfnil`——**对不上说明选错目录了**（native host 只认这个 ID）。
5. **把它钉到工具栏**：点地址栏右边的拼图图标 🧩 → 找到 Agent in Chrome → 点后面的图钉。
   下文和排障提示里所有「点扩展图标」都是指它，不钉住就得每次翻拼图菜单。

**两步谁先谁后都行**——native host 清单写的是固定的扩展 ID、跟浏览器现状无关，
扩展装上后会自己拨号重连（30 秒一次；一直没有 agent 来连就退避到 60 秒、最长 2 分钟，
有调用进来立刻复位。等不及就点扩展弹窗里的「立即重连」，即时生效）。**不用重启 Chrome，也不用重启 agent**：Chrome 在每次
`connectNative` 时现读 host 配置；agent 那边跑 `/mcp` 重连即可（Claude Code / WorkBuddy 都支持）。

### 第三步：验一下通没通

点扩展图标看弹窗顶部那行状态：显示**已连接**就通了。显示「未连接」时，弹窗里会把 Chrome
给的断开原因翻译成一句「下一步该干什么」——先照那句做（最常见的是本机组件还没装，回第一步）。

然后在你的 agent 里说「列一下我打开的标签页」或跑 `/agent-in-chrome`。能列出你真实的标签页，
整条链路就通了。工具压根不在 agent 的工具表里 = 那个客户端还没重连 MCP，不是没装上。

还不通就跑逐项自检（**要先退出 agent**：桥接通道是单主的，agent 开着时自检插不进去）：

```bash
npx @liang-hz/agent-in-chrome check
```

每条 ✗ 都自带下一步该敲什么。完整排查路径在 `/install-agent-in-chrome` 这份 skill 里。

<details>
<summary>各 agent 的 MCP 配置细节挪到了 <a href="docs/AGENTS.md">docs/AGENTS.md</a>（安装器自动写好，一般用不到）</summary>
</details>

---

## 两种模式

一套工具，两条传输路径。你几乎不用关心走的是哪条——工具行为一致。

### 插件模式（默认，你面前有 Chrome）

agent → MCP server → 本机 socket → native host（Chrome 拉起）→ 扩展 → 你打开的标签页。

用的就是你屏幕上那个 Chrome。适合日常：你登着各种系统，让 agent 帮你在里面干活。

### CLI / headless 模式（没有桌面 Chrome）

终端里的 agent、cron、CI、远程 SSH 机器上没有「一个开着的 Chrome + 装好的扩展」这个前提。给 MCP server 带上 `AGENT_IN_CHROME_LAUNCH=1`，它会**自己起一个真 Chrome**、用直连 CDP 驱动，不需要扩展、不需要 native host——跑的还是同一份工具代码。

- 用你机器上那个**正式版 Chrome**（不是 Chrome for Testing），指纹就是它本来的样子。
- profile 是专用的、第一次全新（需要登录的站点在这个 profile 里登一次，之后一直留着）。
  也可以**按域把登录态从你自己那个 Chrome 借过来**，用完精确还回去：
  `npx @liang-hz/agent-in-chrome borrow-login --domains github.com`
  （git 检出跑 `node scripts/borrow-login.mjs --domains github.com`，旗标一模一样；
  边界见 [docs/CLI.md](docs/CLI.md)：会话 cookie 活不过重启，localStorage 类站点搬不动）。
- 常用开关：`AGENT_IN_CHROME_HEADLESS=0` 有头看得见；`AGENT_IN_CHROME_KEEP=1` 会话结束不收浏览器、下次省冷启动（**这一个要 Node 22+**：它把 CDP 从管道切到端口，而端口通道用 Node 的全局 `WebSocket`，18 / 20 都没有）。完整环境变量见 [docs/CLI.md](docs/CLI.md)。

| 场景 | 用哪个 |
|---|---|
| 我本地开着 Chrome，登着一堆系统，想让 agent 帮我操作 | **插件模式** |
| 终端 agent / cron / CI / 远程机器，没有桌面环境 | **CLI 模式** |
| 想让 agent 在一个和我日常浏览器隔离的干净环境里跑 | **CLI 模式** |
| 想过反爬、要真 Chrome 指纹 | 两者都行（都是真 Chrome） |

---

## 工具清单

<details>
<summary>展开 30+ 个浏览器工具</summary>

**标签页与会话**

| 工具 | 作用 |
|---|---|
| `browser_status` | 桥接状态、本会话持有哪些标签页、`sessionOrigin` |
| `browser_tabs_list` | 列出用户打开的所有标签页 |
| `browser_new_tab` | 新开一页并接管，自动收进标签组（默认首选） |
| `browser_tab_use` | 接管一个用户已打开的标签页 |
| `browser_set_label` | 给本会话的标签组按当前任务命名 |
| `browser_tab_group` | 把接管中的页收进标签组 |
| `browser_close_tab` / `browser_close_all` | 关单个标签页 / 清理本次任务开的页（`scope:"session"` 清整份会话清单，`scope:"all"` 是跨会话大扫除） |
| `browser_tab_release` | 放开，断开调试器，还给用户（不关） |
| `browser_set_task_state` | 改标签组上的任务状态（running / attention / failed），agent 唯一不打扰的表达通道 |
| `browser_cookies_export` / `_import` | 给另一个实例搬登录态；默认不回明文，落 `0600` 文件只回路径，导入端 `inFile` 直接读文件——明文两头都不进上下文。导出真值前**按域要你授权**：没授权的域当场被拒，你在扩展弹窗「偏好 → 凭据借出」点「允许」后原样重试即可（长期授权 30 天到期） |

**页面理解**

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 导航 / 前进后退 / 刷新，等加载完成 |
| `browser_read_page` | 可交互元素表（带 `ref_N`）+ 正文，穿透 Shadow DOM 与 iframe；`activeDialog` 报出挡在前面的模态浮层 |
| `browser_refresh_refs` | 只刷新元素表和 ref 映射，不返回正文（便宜得多） |
| `browser_find` | 走 Chrome 全页搜索找元素（文本/CSS/XPath，穿 iframe 与 shadow DOM，无元素数上限） |
| `browser_screenshot` | 可视区 / 整页 / 单元素；默认落盘只回元信息 |

**操作**

| 工具 | 作用 |
|---|---|
| `browser_click` / `browser_hover` | 点击 / 悬停；点前验证点得到、点后验证打中了 |
| `browser_set` | 给表单控件设值（下拉/勾选/单选/日期/滑块），设完回读校验。只收 `browser_find` 给的 `ref_b…` 句柄，`read_page` 的 `ref_N` 请走 `browser_click` / `browser_type` |
| `browser_type` / `browser_press_key` | 输入文本 / 按键 |
| `browser_scroll` | 滚动 |
| `browser_emulate` | 视口 / 暗色 / 限速 / 地理位置仿真：回读校验视口是否真的生效（`mobile` 撞上没有 viewport meta 的页面会退回 980 宽），定位连站点权限一起给，`reset:true` 一次还原 |
| `browser_batch` | 一次跑完一串动作，遇错即停并报断在第几步 |
| `browser_upload_file` | 把本机文件放进 `<input type=file>`（隐藏的、shadow、iframe 里的都行） |

**数据与网络**

| 工具 | 作用 |
|---|---|
| `browser_eval` | 页面内求值取数据；结果不截断，可 `outFile` 落盘 |
| `browser_cdp` | 原始 CDP 直通（逃生舱） |
| `browser_console` | console 输出与页面异常 |
| `browser_network` | 请求列表（`type:"api"` 过滤、`bodyContains` 直接搜响应体） |
| `browser_request_detail` | 原始头（含 Set-Cookie 与被拒原因）/ 请求体 / 响应体 / 耗时 / 发起调用栈 |
| `browser_network_wait` | 拿到某个接口这一次的结果 |
| `browser_websocket` | WebSocket 连接与收发的消息 |
| `browser_as_curl` | 导出成 curl 重放（用网络层原始请求头，含真正发出的 Cookie） |
| `browser_wait_for` / `browser_handle_dialog` / `browser_trace` | 等条件 / 预设下一个弹窗怎么处理 / 回看操作留痕 |

</details>

---

## 配置：裁掉用不到的工具

**档位在扩展弹窗里直接切**（点扩展图标 → 工具档位）。更细的控制在配置文件
`~/.agent-in-chrome/config.json`（没有就新建一个）：

```json
{
  "tools": {
    "profile": "observe",
    "disable": ["browser_batch"]
  }
}
```

- **`profile` 两档**，管的是哪些工具出现在 agent 的工具列表里——关掉的工具不是"禁用"，是**根本不存在**，模型看不到也不会去调：
  - `observe` —— 读页面、截图、看网络、开自己的标签页并导航过去。不点、不填、不碰凭据（跨进凭据面或执行面的**参数**在这一档一律被拒：`revealSecrets`，以及 `browser_wait_for` 的 `js`——它是页面主世界的任意求值）。**如实说明边界**：导航本身会以你的身份发 GET 请求，个别站点的退订/注销就是 GET。整份 `tools/list` 在这一档约 20 KB（完整档约 36 KB），每一次请求都省。
  - `full`（默认）—— 全部工具：点击/输入、`eval` / `cdp`（任意代码）、cookies 导入导出（整份登录态）、`websocket`、`upload_file`。
  - 老配置里的 `readonly` / `standard` 仍然认：分别按 `observe` / `full` 生效（`standard` 往宽松侧迁移，不悄悄削减你已有的能力）。
- **`disable` / `enable`** 在档位之上单独关 / 开某个工具（全名，`browser_` 开头）。两边都写了同一个工具时，`disable` 赢。
- 写坏了不用怕：JSON 不合法时沿用上一份好的配置，**不会悄悄回落成全开**。

**生效时机**：保存文件就生效，不用重启我们这边的任何东西。agent 客户端那侧，实测 Claude Code
下一个回合就拿到新工具表；**其他客户端如果改了没生效，重启那个客户端**（重开会话在部分
客户端不够——有些 GUI 的 MCP 连接是跨会话复用的，重启客户端是对所有客户端都必然有效的动作）。

---

## 更新与版本

不自动更新，也不静默更新——**什么时候升级由你决定**。你有四条途径知道「有新版了」，
和两条动手升级的路。

### 怎么感知到有新版

| 通道 | 什么时候出现 | 看到的是 |
|---|---|---|
| **工具返回的尾巴** | agent 正常干活时，一个 MCP 进程只出现一次 | 追加在某次工具结果末尾的一句话，agent 读到后转告你 |
| **扩展弹窗** | 你点开浏览器工具栏那个图标时（结果缓存 6 小时） | 弹窗里多一行「有新版」和链接 |
| **`check` 子命令** | 你主动跑的时候 | 自检末尾一行：`版本：本机 vX · npm 最新 vY · 有/无新版` |
| **`browser_status` 工具** | agent 主动问的时候 | 返回里的 `update: { current, latest, hasUpdate }` |

前两条是**被动**的：会自己找上门，但都是一次性的（工具返回那句被读走就没了，弹窗要你去点）。
后两条是**主动查**的口子——想确认「我现在到底是不是最新」，跑 `check` 或让 agent 看
`browser_status` 就行。

`browser_status` 里 `latest` 为 `null` 表示**没查到**（没联网、被关掉、或查询还没回来），
这时 `hasUpdate` 一定是 `false`——「不知道」和「确认没有新版」靠 `latest` 是不是 `null` 分辨。

版本检查本身是**轻量、可关、不阻塞**的：只问 npm registry「最新版本号是多少」，不带任何本机
信息，也绝不让任何一次工具调用等它。`AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1` 或任何 CI 环境
下完全不查。

### 怎么升级

**本机组件（MCP server + native host）**：

```bash
npx @liang-hz/agent-in-chrome@latest update
```

它会查 npm 上的最新版；已经是最新就什么都不做，有新版才用**精确版本号**拉取并运行新版的
安装器，装完再核对一次真正落地的版本。透传 `--yes`、`--agents=claude-code,codex`、`--no-agents`，
和 `install` 一样。断网时它只说一句「未能联网查询」，不会报错退出。

**Chrome 扩展**是另一条发布渠道，`update` 管不到：

- **手动「加载已解压」装的（现在所有人都是这一档）**：升级完本机组件后，去 `chrome://extensions`
  点一下那张卡片上的刷新按钮——`~/.agent-in-chrome/extension` 那份副本已经被 `install` / `update`
  换成新的了，点刷新是让 Chrome 重读它。不用重启 Chrome，也不用重新「加载已解压」。
- **应用商店装的**（上架之后才有这一档）：商店自动更新，你什么都不用做。（npm 领先商店一两个
  minor 属正常审核时差，扩展不会为此唠叨；落后太多——更新多半卡住了——才提示。）

两边版本对不上时，`browser_status` 的 `versions` 字段会如实显示，agent 也会收到一次
「版本不匹配」的提示——这不是故障，npm 和商店本来就是各发各的。

发版走 git tag（`vX.Y.Z`）+ GitHub Releases（即 changelog）。要第一时间收到更新，
[Watch 这个仓库](https://github.com/Liang-HZ/agent-in-chrome)的 Releases，或关注 npm 包。

---

## 已知限制

- **`chrome://`、扩展页、应用商店页碰不了**——Chrome 硬性禁止调试器附加。
- **接管期间页面顶部有调试提示条**，关不掉（Chrome 的安全设计），`browser_tab_release` 后消失。
- **跨源 iframe 被 CSS 变换（旋转/缩放/斜切）过时坐标算不出来**，里面的元素点不了，`read_page` 会标 `coords:"未知"`——改用 `browser_new_tab` 直接打开那个地址。
- **不做性能 / a11y / SEO 审计打分**——那类需求 `npx lighthouse <url> --view` 一条命令就跑完，还带 Chrome 官方的评分口径；插件模式下我们挂的是你自己那个没有调试端口的 Chrome，硬做只会做出一个更差的 Lighthouse。**分工**：跑分交给 `npx lighthouse`，我们负责它进不去的地方——需要登录态的页面、点开某个面板之后才出现的那一屏、以及看具体某个请求的头和响应体。
- **没有专门的拖拽工具**——拖滑块、拖放排序、画布手势用 `browser_batch` 串一列 `browser_cdp` 的 `Input.dispatchMouseEvent`（配方在 [skills/agent-in-chrome/references/actions-and-waits.md](skills/agent-in-chrome/references/actions-and-waits.md#拖拽--滑块没有-drag-工具)）；用 `eval` 合成事件派的是 `isTrusted: false`，真验证码不认。
- **平台**：macOS 完整实测。**Windows 插件模式已支持**（注册表 + 命名管道 + `.bat` 启动器，桥接第一道防线由目录权限换成令牌，详见 `mcp/token.mjs` 的 bridgeEndpoint 注释）；Windows 的 CLI/headless 模式（`AGENT_IN_CHROME_LAUNCH=1`）尚未支持。Linux 路径已写未验证。欢迎 PR。

---

## 安全与透明度

这个工具拿的是**你已登录的浏览器的完全控制权**，所以透明度是设计目标，不是事后补丁。

**它做了什么防护：**

- **默认不接管任何标签页**——必须显式 `browser_tab_use`，且默认拒绝征用你已经开着的页。
- **连接令牌**：安装时在本机生成一个随机令牌（`~/.agent-in-chrome/`，权限 `0600`），控制 socket 校验它。它和目录权限（`0700`）一起挡住**别的用户**和**误连**；令牌不写进仓库、不上传、每台机器唯一。**如实说明边界**：以你本人身份运行的进程（比如你装的某个恶意 npm 包）读得到这个令牌文件，令牌挡不住它——这一层没有任何本机方案能挡，属于操作系统的用户隔离范畴。
- **不可逆操作先问你**：发消息、下单、删除、改账号设置这类动作，skill 里写死了要先说清楚并等你同意。
- **页面内容一律当数据，不当指令**（防 prompt injection）。页面上出现「忽略之前的指令」这类文字，agent 会把原文引给你看，不照做。
- **凭据永不外泄**：密码框、信用卡号、CVV、短信验证码的值不会出现在 `browser_read_page` / `browser_find` 结果里，只报「已填写（N 字符）」；操作留痕里输入文本只记长度；Cookie / Authorization / token 等头字段一律打码。
- **看得见**：Chrome 自己那条「正在被调试」的黄条关不掉（这是 Chrome 的安全设计）；agent 的标签页在一个上色、命名的标签组里；扩展弹窗每 1.5s 刷新，列出每个会话占的每个标签页。

**它在你本机读写哪些地方**（安装器和扩展的「属性」页都会列出精确路径）：

- 安装目录 `~/.agent-in-chrome/`：运行时代码副本、连接令牌、日志、操作留痕（`traces/`）、截图（`screenshots/`，保留最近 100 张）、导出的 cookie（`cookies/`，`0700`）、两份 skill 目录（`skills/`，`agent-in-chrome` 那份含 `references/`）与两条命令（`commands/`）。
- 各浏览器的 `NativeMessagingHosts/` 里一份 host 清单。
- 读取（只读）各 Chrome profile 的 `Preferences` 判断扩展是否装上。
- CLI 模式下一个专用 Chrome profile。
- **网络出站：零**。除了 localhost，产品自身不向任何服务器发数据；agent 访问什么完全由你的指令决定。

**关于反爬**：CLI 模式用你的真 Chrome、抹掉 headless 标记、不设 `navigator.webdriver`——目的是**保真**（它就是你的浏览器，替你操作），不是伪装成别人。请在你要访问的站点的服务条款允许范围内使用。

完整的隐私说明见 [PRIVACY.md](PRIVACY.md)。

---

## 关于本仓库

这里是**发布镜像**。日常开发在一个私有仓库里进行，公开树带的是产品代码、文档和测试。
官网（`site/` 与它的 Cloudflare Functions）不在这里——那部分从私有仓库部署。

- **注释**：代码保留说明性注释——这段是什么、参数怎么传、边界在哪，读代码要用的都在。
  不随代码发布的是另一半：为什么这么选、哪个坑是怎么踩出来的、实测数据是多少。
- **测试**：分两层。**不需要浏览器的那一层随仓库发布**——干净克隆下来敲 `npm test` 就能跑，
  CI 上跑的也是它（顶上那枚徽章）。要真 Chrome 的那一层留在维护者侧：真扩展的 e2e、
  并发场景、以及各家 MCP SDK 的互操作验证，都依赖本机装好的扩展和已登录的浏览器，
  搬到别人机器上跑不出同样的结论。

所以你在这里看到的每一次提交都是完整可用、可自行验证的产品，但看不到它是怎么被推导出来的。

踩过的坑和取舍会陆续以文章形式发在 [liangai.org](https://liangai.org)——
把过程写成能读的东西，比把半成品笔记塞进仓库有用。

---

## 参与贡献

架构设计、工程约定、测试分层都在 [CONTRIBUTING.md](CONTRIBUTING.md)。核心不变量：**一个工具层（`extension/sw.js`），两个传输层（native messaging / 直连 CDP），全项目只有一处按模式分流。**

```bash
npm test   # 不需要浏览器的全部单测 + 链路测试，干净克隆就能跑
```

Issue 欢迎随时开：bug、平台差异、某家客户端装不上，都是我想知道的。
PR 请先开一个 issue 说清楚要改什么再动手——公开树和私有树之间要做同步，
一个没打过招呼的大 PR 我多半合不进去。

---

## 许可

[Apache License 2.0](./LICENSE) © 2026 Liang · [liangai.org](https://liangai.org)

---

**English:** full documentation is at **[README.en.md](./README.en.md)**.
