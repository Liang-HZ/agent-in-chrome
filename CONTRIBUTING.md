# 贡献指南

**这个仓库是发布镜像。** 真源是作者的私有仓库；每个版本以一个 `vX.Y.Z` 提交的形式
整棵推过来，所以这里看不到逐个改动的历史，也看不到开发过程中的分支。
镜像里的代码就是 npm 包和商店扩展里跑的那一份，不是精简版。

## 测试：随仓库发布的那一层，和留在维护者侧的那一层

不需要浏览器的那一层测试就在这个仓库里，干净克隆之后直接跑：

```bash
npm test
```

零依赖、不联网、不需要 Chrome、不需要事先装过什么——本机没有 `~/.agent-in-chrome`
时它会自己在临时目录里装一份来验启动器，不会跳过也不会红。同一条链由
`.github/workflows/test.yml` 在 PR 和推 main 时跑（ubuntu / macOS × Node 22 / 24）。

需要真环境的那几层在维护者侧跑，不在这个仓库里：

- 真浏览器层：真 Chrome、真扩展、真 CDP、真网络，自带零依赖的本地测试站
- 并发层：模式 / 实例 / 会话 / 标签页四层隔离——上面那层是顺序跑的，
  两个会话从不真的同时动手，而这个项目的隔离每一层都只在并发时才可能塌
- 互操作层：官方 MCP SDK 当客户端真连一次

它们要真 Chrome，在 CI runner 上是偶发失败的主要来源，**偶发红的 CI 比没有 CI 更糟**
（它训练人忽略红色，于是真回归来的那天也会被当成「又抽了」）。所以这几层由维护者
在合之前跑，跑了哪几层、各层通过数会写在 PR 里。碰了工具层 / 传输层 / 扩展的改动，
真浏览器那层要连跑 3 轮全绿才合——真实环境里最伤人的是偶发，一次绿不算数。

### PR 的门槛

**`npm test` 必须绿。** 这是你自己就能跑完的那一道，PR 页面上看得到结果。
真环境那几层的结果由维护者补上。

### 你能做的三件事

1. **提 issue，带复现步骤。** 这是最有用的一种贡献。一个能稳定复现的场景，
   价值远高于一个猜出来的补丁——见下面「提 issue 要带什么」。
2. **小改动 PR**：文案、报错信息、文档、明确的单点 bug 修复。
   改动要带测试：修 bug 先写一条在旧代码上真的会红的用例。
3. **大改动先开 issue 谈。** 这个项目的很多写法是绕某个具体的坑绕出来的
   （下面列了一部分），看着像可以简化的地方往往不能。先说想法，别先写代码。

### 提 issue 要带什么

- **版本号**：扩展弹窗顶上有，或者问 agent 跑一次 `browser_status`
- **模式**：桌面模式（扩展 + native messaging）还是 CLI / headless 模式
- **客户端**：Claude Code / Codex / 桌面客户端 / 其他
- **复现步骤**，以及你期望发生什么、实际发生了什么
- 如果是「工具报成功但页面没反应」这一类，**把页面的实际状态也写上**——
  工具返回值正是这类 bug 里骗人的那个东西

## 尤其警惕「静默做错事」

这个项目出现过两次「工具报告成功，实际什么也没发生 / 做错了对象」：

- 后台标签页点击：`{"clicked": "GET 用户"}` 返回成功，页面毫无反应
- 遮挡元素点击：`{"clicked": "被遮住的按钮"}` 返回成功，实际打在遮罩上

**这比报错严重得多**——它带着用户的真实登录态在真实站点上操作，agent 会以为
自己点了「确认」然后继续往下走。

**凡是你实现的操作，都要能验证它真的生效了；验证不了就报错，绝不假装成功。**

两条都已经修掉了（`click` / `type` 下发前做可操作性检查），真浏览器那层有断言盯着，
而且**断的是页面实际状态**，不是工具的返回值。你新增能力时照这个来。

## 环境地雷（都已修复，但改动时别踩回去）

### macOS TCC：运行时不能放在 `~/Documents`

TCC 会阻止 GUI 应用（Chrome、agent 桌面客户端）读取 `~/Documents` 下的文件。
所以 `scripts/install.mjs` 会把运行时**同步到 `~/.agent-in-chrome/agent-in-chrome/`**，
native host 清单和 MCP 注册都指向那里，不指向源码目录。

**改完源码必须跑 `node scripts/install.mjs` 同步过去**，否则你测的是旧代码。

### GUI 应用的 PATH 里没有你的 node

Chrome 和 agent 桌面客户端都是 GUI 应用，PATH 不经过 `.zshrc`，nvm/homebrew 的 node
一律找不到。`#!/usr/bin/env node` 在它们手里必然 `env: node: No such file or directory`，
而且失败得很安静。所以安装时会生成 launcher 脚本，把 node 的**绝对路径固化**下来。
别改成依赖 PATH 的写法。

### sw.js 用了新的 `chrome.*`，CLI 模式会当场死在启动路径上

工具层跑在两套 `chrome.*` 上：桌面模式是 Chrome 给的，CLI/headless 模式是
`mcp/cdp/chrome-shim.mjs` 给的。**sw.js 在模块顶层就注册事件监听器**，所以只要用到
一个 shim 没有的 API，CLI 模式在 `import sw.js` 那一刻就整个起不来——不是某个工具坏掉，
是整个模式没了。

**在 sw.js 里新用一个 `chrome.*` API，就要同步在 shim 里补上**（空实现也要补齐）。

### shim 的内部表：建了就要有对应的删

shim 那几张按 sessionId / frameId / tabId 存的表，全是「只在某个事件到达时才删」的形状。
漏一处不会报错、功能全对，只是跑一天多占几百 MB——从外面完全看不出来。
`shim.stats()` 把这些表的条目数摆出来，`npm test` 按它断言「跑完一轮回到起点」。
加新表就往 `stats()` 里加一行。

### MV3 service worker 随时会被回收

回收后 sw.js 里所有内存态全没。所以状态落在 `chrome.storage.session`，
每次处理调用前 `ensureRestored()` 捞回来，任何修改后 `persist()` 存回去。
**你新增的跨调用状态，也必须进这套持久化**，否则用户会遇到「干着干着突然失忆」。

### 后台标签页与焦点模拟

`Emulation.setFocusEmulationEnabled({enabled:true})` 让页面始终以为自己聚焦活跃。
**不开这个，后台标签页收不到 CDP 输入事件**。

**它是按需开的，不在 attach 的握手里开**：只有真要下发输入时（`click` / `hover` /
`type` / `press_key` / `scroll` 走的 `ensureInteractive`）才开这一下。
read_page / find / eval / 网络 / 截图都不碰它。理由是**开焦点模拟这一下本身就是把
密码管理器招进页面的那一下**（focus 事件在无焦点文档里根本不派发，是我们骗它
「你是聚焦的」才让所有 focus 监听器跑起来）。所以别再把它挪回 attach，
也别在只读路径上顺手开。

**产品承诺是「全程后台，不抢用户前台」**，真浏览器那层有断言盯着（点击前后标签页都必须
`active === false`）。你的改动不能破坏这个承诺。

自己写探针直连 CDP 起浏览器时，**必须自己下发这条焦点模拟**——否则后台标签页
`requestAnimationFrame` 不跑、`mouseMoved` 一次 5 秒，你会得出「环境不产帧」这个错误结论。

### CDP 响应体会被淘汰

`Network.getResponseBody` 取的是 CDP 自己的缓冲区，满了按 LRU 淘汰。
所以 XHR/Fetch 的响应体在 `loadingFinished` 时**主动抓取**存下来，
不能等模型来问——那时多半已经没了。

### 网络层原始头只以事件的形式存在

`Network.responseReceived` 给的响应头是**被浏览器过滤过**的：没有 `Set-Cookie`，
跨源时也只剩 `Access-Control-Expose-Headers` 放出来的那几个。网络层真正收到的那份
只出现在 `Network.responseReceivedExtraInfo` 事件里，**CDP 没有它的命令版本**——
错过就等不回来了。而且 ExtraInfo 和 `requestWillBeSent` / `responseReceived`
**谁先到没有保证**，两个方向都会咬人，所以两头都堵着。**等不到不许假装拿到了**：
`headersSource` 两种结果、两侧都如实分开报。真实站点上「拿不到」是常态，
本地测试站 2/2 全有——**别按 localhost 推断线上**。

## 项目约定

### 改动之后

```bash
node --check <改过的文件>             # 语法
node scripts/install.mjs              # 同步运行时到 ~/.agent-in-chrome（必做）
npm test                              # 不需要浏览器，随时能跑
```

改了 `extension/` 下的代码后，扩展必须重载才生效。两条路：

- **点扩展图标，弹窗里的「重载扩展」按钮**（不依赖 MCP，随时能用）。
  弹窗顶上有版本号，重载完看它变没变，就知道生效了没有。
- `browser_reload_extension` 这个 MCP 工具。它是**开发者工具，默认不注册**——
  起 MCP server 时带 `AGENT_IN_CHROME_DEV=1` 才出现在 `tools/list` 里。

重载后等 8 秒再测。它的返回值里是 `versionBefore`（**重载前**的版本号），
新版本要重载完用 `browser_status` 问。

要验 CLI 模式整条链路，最直接的一条：`node scripts/cli-browser.mjs` 起浏览器并自检。

### 新增工具

工具要同时在**三**个地方注册：

- `extension/sw.js` 的 `TOOLS` 对象（处理器）
- `mcp/server.mjs` 的 `TOOLS` 数组（带 `inputSchema` 和给模型看的 `description`）
- 紧挨着工具表的 `TOOL_ANNOTATIONS`（四个 hint 全是显式布尔 + 一行理由）

漏了第三处，`npm test` 里的协议测试会红——那是客户端**唯一**能判断这个工具
该不该自动批准的信号，不许留空。别忘了还有 `mcp/tool-tiers.mjs` 的档位登记。

只对开发者有用的工具放 `mcp/server.mjs` 的 `DEV_TOOLS` 数组（`AGENT_IN_CHROME_DEV=1`
才注册）。判断标准：这个工具对**正常浏览任务**有没有价值。没有就别常驻——
每份 description 都要占每个 agent 的系统提示预算，还多一个选错的机会。

### 版本号：五处必须一致

改了 `extension/` 就把这五处的版本号一起升：

```
extension/manifest.json
extension/sw.js
mcp/server.mjs
package.json
.claude-plugin/plugin.json
```

漏一处，`npm test` 会红。

### 注释与文案风格

- 注释写**为什么**，不写做了什么。尤其是绕过某个坑的地方，要写清坑是什么，
  否则后人会「顺手简化」掉，把 bug 放回来。
- 面向模型的 `description` 和报错文案：说清**下一步该做什么**，不要只说「失败了」。
  这些文字是模型的唯一线索。
- 中文。

## 文件地图

目录按「**一个工具层 + 两个传输层**」摆：

```
extension/        工具层（两种模式跑的是同一份 sw.js）+ 桌面模式的扩展外壳
native-host/      传输层 A：桌面模式（native messaging）
mcp/cdp/          传输层 B：CLI/headless 模式（直连 CDP）
mcp/server.mjs    MCP 协议层；**全项目只有这里一处按模式分流**（CDP_MODE）
```

| 路径 | 说明 |
|---|---|
| `extension/` | 工具层 + Chrome 扩展外壳（「加载已解压」指的就是这个目录） |
| `native-host/host.mjs` | 传输层 A：native messaging host |
| `native-host/launcher.sh` | 安装时生成，固化 node 绝对路径，勿手改 |
| `mcp/server.mjs` | 零依赖 MCP server，两种模式共用；模式分流只在这里 |
| `mcp/tool-tiers.mjs` | 工具的观察 / 操作档位登记 |
| `mcp/trace.mjs` | 操作留痕：打码、摘要、环形缓冲、落盘 |
| `mcp/cdp/browser-launch.mjs` | 传输层 B：找浏览器、起/收/收养、启动参数 |
| `mcp/cdp/client.mjs` | 传输层 B：零依赖 CDP 客户端 |
| `mcp/cdp/chrome-shim.mjs` | 传输层 B：用 CDP 实现 `sw.js` 需要的 `chrome.*` |
| `mcp/cdp/bridge.mjs` | 传输层 B：把 sw.js 当模块拉起来，接上假的 native port |
| `scripts/cli-browser.mjs` | CLI 模式的浏览器：起 / 收 / 查 / 自检 |
| `scripts/install.mjs` | 安装 / 自检 / 卸载 |
| `scripts/borrow-login.mjs` | 按域把登录态借给隔离 profile |
| `.ext-id.txt` | 扩展 ID，native host 白名单要用 |

## PR 约定

- 一个 PR 一件事。混在一起的改动没法分开合。
- 说清**为什么**：改的是哪个行为、在什么情况下现在是错的。
- **没验证到的部分如实列出来**，宁可写「这条我没测」。维护者按你写的去补验证；
  写了「已测」但其实没测，下次你的 PR 就要多花一倍时间。
