# CLI / headless 模式（没有桌面 Chrome 的场合）

桌面模式的前提是「你面前有个开着的 Chrome，扩展也装好了」。终端里的 agent、cron、CI、
远程机器上没有这个前提。给 MCP server 带上 `AGENT_IN_CHROME_LAUNCH=1`，它就会**自己起一个
浏览器**，用直连 CDP 驱动，不需要扩展、不需要 native host：

```
MCP server ── 内存里的假 port ── extension/sw.js（同进程 import）── 直连 CDP ── 自启的浏览器
```

**工具行为和桌面模式一致**——两边跑的是同一个 `extension/sw.js`，只是脚下那层
`chrome.*` 换成了 `mcp/cdp/chrome-shim.mjs` 用 CDP 实现的一份。

用的是**你机器上那个正式版 Chrome**，不是 Chrome for Testing：指纹就该是它本来的样子
（CfT 的 `userAgentData.brands` 里写着 "Google Chrome for Testing"，版本还落后好几个大版本）。
headless 时 UA 里那个 `HeadlessChrome` 会被抹掉（进程级，Worker 里也一致），
`navigator.webdriver` 保证是 false。真实反爬站点实测（2026-07-30，headless 与有头同样结果）：
bot.sannysoft.com 红项 0、CreepJS 的 headless/stealth 判定 0%、nowsecure.nl 的 Cloudflare 挑战通过。

```bash
# 平时不用手动跑，MCP server 会自己保证浏览器在。这条命令用来烘热 / 排查 / 看指纹
npx @liang-hz/agent-in-chrome cli-browser            # 起（已在跑就复用）并自检
npx @liang-hz/agent-in-chrome cli-browser --headed   # 有头，想亲眼看它在干什么
npx @liang-hz/agent-in-chrome cli-browser --status
npx @liang-hz/agent-in-chrome cli-browser --stop
```

> **两种装法，两种敲法。** 上面这条是 npm / npx 装的用户敲的（装出来的运行时是扁平布局，
> 没有 `scripts/` 目录）。git 检出的用户敲 `node scripts/cli-browser.mjs …`，旗标一模一样，
> 下文两种写法混着出现，指的是同一件事。`borrow-login` 同理。

这个脚本自己把 `AGENT_IN_CHROME_KEEP` 默认成 `1`（你在环境里显式设过就听你的），
因此它起的浏览器走调试端口、**活过脚本本身**——烘热、e2e、看指纹都指望这一条：
管道模式下浏览器绑在起它的进程上，脚本一退 Chrome 三秒内跟着退，烘热等于白烘。

## 环境变量

| 环境变量 | 作用 |
|---|---|
| `AGENT_IN_CHROME_LAUNCH=1` | 打开这个模式（不设就是桌面模式，行为完全不变） |
| `AGENT_IN_CHROME_HEADLESS=0` | 有头跑，看得见 |
| `AGENT_IN_CHROME_KEEP=1` | 会话结束不收浏览器，下次省掉冷启动（1~2s），页面和登录态都留着。**要 Node 22+**：它把 CDP 从管道切到端口，端口通道用的是 Node 的全局 `WebSocket`（18.20.8 / 20.19.0 实测都没有，Node 22 才无条件有）。老 Node 上设了它，第一次工具调用会被挡回一句「这条 CDP 通道要 Node 的全局 WebSocket」 |
| `AGENT_IN_CHROME_BIN` | 指定浏览器二进制 |
| `AGENT_IN_CHROME_PROFILE` | 换 profile 目录。**设了它就等于换了一个实例**：默认桥接 socket 会自动按 profile 错开，不必再设 `AGENT_IN_CHROME_SOCK` |
| `AGENT_IN_CHROME_ARGS` | 追加启动参数（容器里常要 `--no-sandbox`） |
| `AGENT_IN_CHROME_SOCK` | 显式指定桥接 socket 路径（正常不用：换了 `AGENT_IN_CHROME_PROFILE` 时默认 sock 自动跟着错开。要用时注意 unix socket 路径上限 104 字节） |
| `AGENT_IN_CHROME_TIMEOUT_MS` | 工具调用超时 |
| `AGENT_IN_CHROME_WINDOW` | 浏览器窗口尺寸 |
| `AGENT_IN_CHROME_SPAWN_WAIT_MS` | 冷启动时等浏览器就绪的上限 |
| `AGENT_IN_CHROME_TRACE` | 操作留痕开关（`off` 整体关掉） |
| `AGENT_IN_CHROME_TRACE_DIR` | 留痕落盘位置（测试用它隔离） |
| `AGENT_IN_CHROME_SHOT_DIR` | 截图落盘位置 |
| `AGENT_IN_CHROME_COOKIE_DIR` | `browser_cookies_export` 的导出文件位置 |
| `AGENT_IN_CHROME_CDP_TRANSPORT` | 显式指定 CDP 走 `pipe` 还是 `port`（默认自动判：`AGENT_IN_CHROME_KEEP=1` 走 port，否则走 pipe，见「要知道的四件事」）。`port` 同样要 Node 22+（全局 `WebSocket`）；`pipe` 对 Node 18 起就能跑 |
| `AGENT_IN_CHROME_DISK_CACHE` | 浏览器磁盘缓存上限，字节（默认 134217728 = 128MB） |

## 要知道的四件事

- **profile 是专用的、第一次是全新的**（`~/.agent-in-chrome/agent-in-chrome/cli-profile`）。Chrome 136+
  不允许默认 profile 开调试端口，所以这个 profile 不会自动带上你日常浏览器的登录态；
  需要登录的站点在这个 profile 里登一次，之后一直留着。
  也可以**按域把登录态借过来**，不用重登：
  `npx @liang-hz/agent-in-chrome borrow-login --domains github.com`
  （git 检出是 `node scripts/borrow-login.mjs --domains github.com`；见下面「把登录态借过来」一节）。
  **一份 profile 同时只能被一个浏览器实例用**（Chrome 的 ProcessSingleton，macOS/Linux 都一样，
  换 `--profile-directory` 也绕不过去）。并发靠的是「多个会话共用一个浏览器」——
  它们通过 socket 主从共用同一个实例，各自的标签页互相隔离。真要跑两个互不相干的实例，
  给每个设不同的 `AGENT_IN_CHROME_PROFILE`，登录态也就各是各的——**这一个环境变量就够了**：
  桥接 socket 默认按 profile 错开（路径掺 profile 的 hash，0.39.0 起；之前还要手动
  配一个不同的 `AGENT_IN_CHROME_SOCK`，忘了配的话第二个实例会静默变成第一个实例的
  从会话，命令全落到别人的浏览器上），浏览器记录（pid、调试端点）跟着 profile 放在
  `<profile>/aic-cli-browser.json`，会话状态（哪个会话占着哪些标签页）跟着 profile 放在
  `<profile>/aic-cli-session-state.json`，浏览器自己的日志也在 `<profile>/aic-cli-browser.log`，
  所以 `--stop`、收工关灯和标签页归属都只认自己那个实例，不需要再额外错开 `HOME` 之类。
- **标签组只是账面的**：CDP 没有标签组这个能力（那是只对扩展开放的 Chrome UI 概念）。
  headless 也没人看标签条，会话隔离本身不受影响。
- **`browser_reload_extension` 在这个模式下会直接报错**：工具层是 MCP server 进程 import
  的模块，没有扩展可重载。改了 `extension/` 要重跑安装器（`npx @liang-hz/agent-in-chrome@latest install`，
  从 git 克隆是 `node scripts/install.mjs`）再重启 server。
- **默认没有调试端口可以被别人连**。CLI 模式默认用 `--remote-debugging-pipe` 起浏览器，
  CDP 走子进程的 fd 3/4，**天然只有父进程用得上**。实测（2026-08-05，Chrome 151）：
  这样起来的浏览器监听的 TCP 端口是 **0 个**，也**不写** `<profile>/DevToolsActivePort`。

  代价是**浏览器绑在这个 MCP server 进程上**：关掉管道后 Chrome 三秒内自己退出，
  所以它活不过本进程，也没法被别的进程收养。反过来也有个白捡的好处——
  **这条路产生不了孤儿浏览器**，主人猝死它自己就走了。
  （反过来也成立：主人**没死、只是闲着**时那个浏览器一直留着，这份 profile 也就
  一直被它占着。想知道现在是谁占着，读 `<profile>/SingletonLock` 那条符号链接——
  它指向 `主机名-pid`。）

  `AGENT_IN_CHROME_KEEP=1` 会切回 `--remote-debugging-port`（浏览器要活过本进程、
  等下一个会话认领，就必须有个别的进程连得上的端点）。**那条路没有访问控制**：
  Chrome 的调试端口不认令牌，桌面模式那套 socket 令牌在这里帮不上忙，任何以你身份
  跑在本机的进程都能连上 `ws://127.0.0.1:<端口>` 全权驱动这个浏览器，端口号还写在
  `<profile>/DevToolsActivePort` 里。所以开了 KEEP 就等于声明：
  **在这个 profile 里登录的账号，安全边界是「本机你自己的进程都可信」**。
  在共享机器 / 跑不可信代码的机器上别这么用，也别在那种 profile 里登要紧账号。

  想显式指定走哪条：`AGENT_IN_CHROME_CDP_TRANSPORT=pipe|port`。
  桌面模式（native messaging 链路）两条都不涉及，没有这个暴露面。
  `scripts/cli-browser.mjs` 是例外：它自带 `KEEP=1` 默认值，所以裸跑它起的浏览器一定走端口。

## 「浏览器没就绪」的几句话，说的不是一回事

CLI 模式下工具调用报「没就绪」时，先分清是哪一句——它们的下一步完全相反：

| 报的是 | 含义 | 怎么办 |
|---|---|---|
| 「自启的浏览器还没就绪（冷启动约 1~2s），稍等重试」 | 浏览器正在起 | 等一下重试就好 |
| 「自启的浏览器退出了，正在重新拉起一个（约 1~2s），稍后重试即可」 | 那个浏览器没了（用户关掉、崩了、或被 `--stop` 收了），server 正在自己拉起新的 | 等一下重试。旧浏览器里的标签页跟它一起没了，用 `browser_new_tab` 重新开 |
| 「浏览器退出后重新拉起失败：…」 | 新浏览器也起不来（端口被占、profile 被另一个实例锁着…） | 按后面那句原因处理；这条路不锁死，下一次工具调用还会再试一遍 |
| 「这个 profile 已经被另一个浏览器实例占着（pid=…）」 | 上一个实例还活着：`--stop` 没收干净，或者同一个 profile 上还有一个 MCP server 攥着它。管道传输认领不了别人的浏览器（它的 CDP 只有父进程用得上） | 照那句话给的三条走：`cli-browser.mjs --stop`（带同一个 `AGENT_IN_CHROME_PROFILE`）、换 profile、或 `AGENT_IN_CHROME_KEEP=1` 改走可共用的端口模式 |
| 「CDP 连接已关闭：浏览器退出了…」 | 帧已经进了工具层才发现浏览器没了（只可能是「查完就绪」和「发出去」之间那一拍） | 直接重试。下一次调用会走上面第二行那条路，自己拉起一个新的 |

**浏览器中途退出不需要重启 MCP server。** server 会自己起（或收养）一个新的，
并把工具层换绑过去——多数情况下这件事发生在那一次工具调用的宽限期里，调用方
根本察觉不到。丢的只有旧浏览器里的标签页和页面状态，那是浏览器退出的固有代价。

**从会话（peer）的调用走的是同一条自愈路径。** 主替从会话代发之前一样要过「桥接
还在不在」这一道：不在就先把浏览器拉起来再发。0.52.0 之前这一道只罩得住主自己的
调用，代发那条路一次都不查——于是「主的浏览器被 `--stop` 收掉」之后，从会话的每一次
调用都被喂进一个脚下没有浏览器的工具层，拿回一句 isError 的「CDP 连接已关闭」，
重试多少次文案一字不变（而 `browser_status` 还报 connected:true、`browser_tabs_list`
静默回空表——它们不碰 CDP，所以答得上来）。

（能原地恢复的关键：工具层 `extension/sw.js` 是 ESM，一个进程只加载得了一次，
所以恢复走的不是「重建一套」，而是把它脚下的浏览器换掉。想让浏览器干脆活过整个
会话，用 `AGENT_IN_CHROME_KEEP=1`。）

## 把登录态借过来（0.49 起）

隔离 profile 是空的，但不必每个站点都重登一次——可以按域把 cookie 从你自己那个 Chrome 借过来：

```bash
npx @liang-hz/agent-in-chrome borrow-login --domains github.com,news.ycombinator.com
npx @liang-hz/agent-in-chrome borrow-login --status                  # 现在借着哪些
npx @liang-hz/agent-in-chrome borrow-login --release                 # 还掉最近那一批
npx @liang-hz/agent-in-chrome borrow-login --release --all
npx @liang-hz/agent-in-chrome borrow-login --release --domains github.com   # 只还点名的这几个域
npx @liang-hz/agent-in-chrome borrow-login --domains github.com --profile <目录>   # 借给指定的隔离 profile
```

git 检出把 `npx @liang-hz/agent-in-chrome borrow-login` 换成 `node scripts/borrow-login.mjs`，
旗标一模一样。`--help` 打出来的示例会跟着你的装法给出你真能敲的那条。

前提是你的 Chrome 开着、扩展已启用（`npx @liang-hz/agent-in-chrome check`；从 git 克隆跑的是 `node scripts/install.mjs --check`）。
`--profile <目录>` 指定收货的隔离 profile（默认 `$AGENT_IN_CHROME_PROFILE`，借和还都认它）；
`--from-profile <目录>` 可以改成从**另一个隔离 profile** 借（长期登录的那个 → 一次性任务的那个），
这条路不需要真 Chrome。另有 `--headed`（隔离实例开有头窗口）和 `--keep-file`
（留下落盘的 cookie 文件，默认用完即删——那份文件是可直接冒用的完整会话凭据）。

**三条边界，用之前先知道**：

- **会话 cookie 活不过隔离实例重启**。这是 Web 规范的语义，不是没落盘。真实登录态里
  会话 cookie 占比很高，所以借用的有效期常常就是「这个浏览器实例的寿命」。
  脚本会按实际借到的那批数出各有几条。`--pin-session <小时>` 能把它们改写成持久 cookie，
  **默认关**——那等于替站点延长了凭据寿命。
- **只搬 cookie 覆盖不了把 token 放 localStorage / IndexedDB 的站点**（Firebase Auth、
  MSAL、Supabase 这类），症状是「导入成功但仍然未登录」。
- **收浏览器要用 `--stop`**（它走 CDP `Browser.close`）。整组 SIGTERM 会把 Chrome 的
  cookie 刷盘打断，实测借来的持久 cookie 会**一条不剩**。
  注意 `Browser.close` 这条路**只有端口模式有**：管道传输的浏览器不开调试端口，
  别的进程连不上它，`--stop` 只能发信号（它会照实说「管道传输本来就只能这样收」，
  那不是出错）。借登录态的场合就用 `AGENT_IN_CHROME_KEEP=1` 起。

还回去是**按账本逐条删**的，不会碰你在这个 profile 里自己登录的站点——哪怕同一个域。
真要全清是 `--release --all --wipe`，单给 `--wipe` 会被拒。

## 服务器上并发一批实例（一实例一 profile 的 fleet）

十几个无头浏览器并发干活、每个都要带登录态，是这个模式在服务器上的标准形态。
每个 worker 只差一个环境变量：

```bash
# worker N 的 MCP server 环境（其余都用默认值）
AGENT_IN_CHROME_LAUNCH=1
AGENT_IN_CHROME_PROFILE=~/.agent-in-chrome/agent-in-chrome/worker-N   # 一实例一份
AGENT_IN_CHROME_KEEP=1        # 任务之间浏览器留着，省掉每次 1~2s 冷启动
```

**一实例一 profile 这条不变**（Chrome 的 ProcessSingleton 不许一份 profile 同时开两个实例），
但 `KEEP=1` 现在还多一层含义：**它同时把 CDP 传输切回调试端口**。
「浏览器活过起它的那个进程、等下一个会话认领」这件事只有端口模式做得到——
管道的 fd 只有父进程握得住。所以：

- **需要浏览器在任务之间留着 / 需要多个 MCP 进程共用一个浏览器** → `KEEP=1`，
  代价是那个端口没有访问控制（见上一节最后一条）。
- **每个任务自己起自己收**（默认）→ 管道，零端口暴露面，也不会留下孤儿浏览器。

管道模式下如果同一个 profile 上已经有别的进程在起浏览器，第二个进程会**当场报错并
给出两条出路**（换 profile，或切 `KEEP=1` 走端口共用），不会干等、也不会偷偷再起一个。

登录态用 cookie 搬运铺开：在**一个**实例上登录（或把桌面上导出的 jar 文件拷上来），
然后每个 worker 各导入一次——全程只有文件路径过手，cookie 明文不进任何会话的上下文：

```
（登录源实例）browser_cookies_export {}          → 返回 file 路径
（每个 worker）browser_cookies_import { inFile: "<那个路径>" }
```

几件事是设计保证，不用自己防：

- **实例之间互不可见**：pid 记录、会话账、标签页归属、浏览器日志全在各自 profile 里，
  `--stop` 和收工关灯只认自己那个实例。
- **留下的浏览器不会被别人收走**：KEEP、主从接管、烘热留下的浏览器在 profile 账上
  记着「等认领」，别的实例启动时的孤儿回收不会碰它们；回收只收「起它的进程死了、
  账上又没人认领」的真孤儿（比如被 SIGKILL 的会话残留）。
- **冷启动竞态有锁**：多个进程同时对同一份 profile 起浏览器，只会起出一个，其余自动收养。

烘热（把冷启动挪到任务开始之前）：

```bash
for n in $(seq 1 12); do AGENT_IN_CHROME_PROFILE=~/.agent-in-chrome/agent-in-chrome/worker-$n \
  node scripts/cli-browser.mjs & done; wait
```

（不用在这里额外写 `AGENT_IN_CHROME_KEEP=1`：`cli-browser.mjs` 自带这个默认值，
烘出来的浏览器一定留着等人认领。）

收工全收掉就对每个 profile 跑一遍 `cli-browser.mjs --stop`。
内存账：一个 headless Chrome 常驻约 150~300MB，十几个并发先算下机器内存。
容器里通常还要 `AGENT_IN_CHROME_ARGS=--no-sandbox`。

## 更新

不自动更新，也不静默更新。四条「有新版了」的感知通道，两条动手升级的路：

| 通道 | 怎么触发 | 看到的是 |
|---|---|---|
| 工具返回的尾巴 | agent 正常干活时自己出现，**一个 MCP 进程只出现一次** | 追加在某次工具结果末尾的一句话 |
| 扩展弹窗 | 点浏览器工具栏那个图标（结果缓存 6 小时）。CLI 模式没有这条——那里根本没有扩展 | 弹窗里多一行「有新版」 |
| `agent-in-chrome check` | 你主动跑 | 自检末尾一行 `版本：本机 vX · npm 最新 vY · 有/无新版` |
| `browser_status` 工具 | agent 主动问 | 返回里的 `update: { current, latest, hasUpdate }` |

前两条是被动的、一次性的（那句话被读走就没了，弹窗要你去点）；后两条是**主动查的口子**。
`update.latest` 为 `null` 表示**没查到**（没联网、被 `AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1`
或 CI 关掉、或查询还没回来），这时 `hasUpdate` 一定是 `false`——「不知道」和「确认没有新版」
靠 `latest` 是不是 `null` 分辨。`browser_status` 读的是握手时那一次后台查询的结果，
**不会为了这个字段多发一次请求，也不会等网络**。

升级本机组件（MCP server + native host）：

```bash
npx @liang-hz/agent-in-chrome@latest update            # 已是最新就什么都不做
npx @liang-hz/agent-in-chrome@latest update --yes      # 不逐个确认
npx @liang-hz/agent-in-chrome@latest update --agents=claude-code,codex
npx @liang-hz/agent-in-chrome@latest update --no-agents
```

`update` 查到最新版之后是用**精确版本号**（`--package=@liang-hz/agent-in-chrome@x.y.z`）去拉安装器的，
装完再核对一次真正落地的版本——「查到的版本」和「装下去的版本」必须是同一个。断网时它只说
一句「未能联网查询」，退出码仍是 0：那不是升级失败，是这次判断不了。

扩展是另一条发布渠道，`update` 管不到：商店装的自动更新；手动「加载已解压」的，升级完去
`chrome://extensions` 点那张卡片上的刷新按钮（路径安装器会打印）。**CLI 模式下没有扩展**，
工具层是 MCP server 进程直接 import 的 `extension/sw.js`，跟着本机组件一起更新——
但升级完要**重启 MCP server**，ESM 模块一个进程只加载得了一次。

## 验证

不需要浏览器的那一层测试随仓库发布，克隆下来直接跑（项数以 `npm test` 的总结行为准）：

```bash
npm test
```

零依赖、不联网、不需要 Chrome。本机没有 `~/.agent-in-chrome` 时，其中验启动器的那两节
会自己在临时目录里装一份来跑——不跳过，也不因为「没装过」而红。

`scripts/test-sw.mjs` 把 `chrome.*` 全套换成可观测的假实现，在 vm 里**真的执行** `extension/sw.js`，
逐个跑处理器：接管校验、CDP 事件序列与坐标、ref 解析与失效、输入模拟、错误路径。
`chrome.scripting.executeScript` 被换成「在最小 DOM 上真的调用那个注入函数」——
这个假 DOM 实现了选择器匹配、`elementFromPoint` 命中测试、shadow root、以及 iframe 的父子帧串联，
所以 `pageAgent`（页面快照 / ref 解析 / 可操作性检查）那一整段跑在页面里的代码也被覆盖到。

`scripts/test-protocol.mjs` 假扮 native host 连上 socket，看得见「过桥那一帧长什么样」——
版本协商、`annotations` 覆盖率、进度与取消这三件事的真相只在那一帧上。
`scripts/e2e.mjs` 覆盖 MCP 握手与工具调用、native messaging 帧协议的粘包拆包重组、
以及启动器在 Chrome 那种最小 PATH 下能否起来。

要真浏览器的那几层（真 Chrome / 真扩展 / 并发隔离 / 官方 MCP SDK 互操作）不在这个仓库里，
由维护者在合 PR 之前跑，通过数写在 PR 里。

要自己验 CLI 模式整条链路，最直接的两条路：

- `node scripts/cli-browser.mjs` 起浏览器并自检（顺带报出站点看到的指纹）；
- 在你的 agent 的 MCP 配置里给这个 server 带上 `AGENT_IN_CHROME_LAUNCH=1`，然后直接对
  agent 说「列一下我打开的标签页」，或跑 `/agent-in-chrome`。能列出标签页就说明整条链路通了。

桌面模式（扩展 + native messaging）那条链路与本模式无关，装完之后自检用：

```bash
npx @liang-hz/agent-in-chrome@latest install --check
```

跑它之前要先完全退出你的 agent 客户端——桥接 socket 是单主的，agent 客户端开着时
它占着通道，自检插不进去（会明确告诉你是这种情况，不会伪装成「装失败了」）。
