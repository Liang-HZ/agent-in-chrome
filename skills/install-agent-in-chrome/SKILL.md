---
name: install-agent-in-chrome
description: 把 agent-in-chrome 装到用户机器上、接到某个 agent 客户端、或者装完不通时排障。触发词：安装 agent-in-chrome / 帮我装一下 / 装到 Cursor（或任意客户端）/ 配置 agent-in-chrome / 接到某某客户端 / 加到我的 MCP / 装不上 / 连不上 / 自检 / 卸载 / 换台机器重装。English triggers：install agent-in-chrome, set it up, add it to my MCP client, configure the MCP server, hook it into <client>, it won't connect, browser tools missing, run the self check, uninstall. 安装器没收录的客户端也走这份 skill：先拿 `check --print-config` 要到精确配置，再去探索那家客户端把 MCP 配置放在哪。
---

# 安装 Agent in Chrome

这份 skill 是**给你（agent）照着执行的流程**，不是给人读的教程。每一步都有判据；判据不满足就停下来问用户，不要往下猜。

安装器（`npx @liang-hz/agent-in-chrome`）负责所有确定性的活：native host 清单该写进哪个目录 / 哪个注册表键、扩展 ID 白名单、固化 node 绝对路径的启动器、16 家已收录客户端各自的配置文件位置与条目形状。**你的活是编排、判断和补空缺**，不是重新推导这些路径——推导出来的路径写进去，客户端只会报一句 `Connection closed`，用户完全无从下手。

## 第 0 步：先探环境，别急着装

```bash
node --version                      # 需要 18+
npx @liang-hz/agent-in-chrome check           # 已经装过没有（不改任何东西；有一项没过就非零退出）
```

`check` 的第 6 节「桥接通道」在**你自己就跑在一个已连上的客户端里**时必然报「未建立」或读不到——
桥接 socket 是单主的，agent 占着通道时自检插不进去。**那一条不算失败**，别据此说没装好；
真要看桥接，让用户退出 agent 再跑。前 5 节不受影响。

再确认这三件事，缺哪件就先说清楚：

| 要确认的 | 怎么看 | 不满足时 |
|---|---|---|
| 系统 | macOS / Windows / Linux | Linux 路径已写但未实测，Windows 只有插件模式；见本文最后一节 |
| 有没有桌面 Chrome（或 Edge / Brave / Vivaldi 等 Chromium 系） | macOS `ls -d /Applications/Google\ Chrome.app`；Windows 看 `%LOCALAPPDATA%\Google\Chrome`；Linux `which google-chrome` | 没有桌面浏览器就别装插件模式，改走 CLI 模式（`AGENT_IN_CHROME_LAUNCH=1`，见 [docs/CLI.md](../../docs/CLI.md)） |
| 用户想接哪个客户端 | 直接问，或看 `check` 输出里 `detected` 的那几家 | 用户说"都装上"再全装 |

`check` 已经绿了、用户只是想接一个新客户端 → 跳到第 5 步；`check` 全红或从没装过 → 第 1 步。

## 第 1 步：装（已收录的客户端）

```bash
npx @liang-hz/agent-in-chrome@latest install --yes                       # 全装（默认）
npx @liang-hz/agent-in-chrome@latest install --yes --agents=claude-code  # 只接指定的几家，逗号分隔
npx @liang-hz/agent-in-chrome@latest install --yes --no-agents           # 只装运行时，不碰任何客户端配置
```

- **可用的 agent id 以 `check` 的输出为准**，不要凭记忆写。`--agents` 里写错的 id 会被安装器点名，但那一家就漏装了。
- 安装器改的每个文件都会先备份，且只动 `agent-in-chrome` 这一个键。
- 你替用户跑（非 TTY）时它**默认全装**，不会弹选择清单。所以装完必须把"注册进了哪几家"原样转告用户，并告诉他 `npx @liang-hz/agent-in-chrome uninstall --agents=<id>` 能单独摘掉一家。这句话是那个默认的正当性来源，不许省。
- 它会打印**扩展目录**和各个被改动的文件路径。把扩展目录记下来，第 2 步要用。

## 第 2 步：装 Chrome 扩展（唯一必须用户手动做的一步）

浏览器不允许命令行静默装扩展，这一步省不掉。先拿准确信息，别背路径：

```bash
npx @liang-hz/agent-in-chrome check --print-config    # stdout 只有 JSON，可以直接喂 jq
```

看 `extension` 这段：

- `storeUrl` **非 null** → 让用户点这个链接从 Chrome 应用商店装，这是首选。
- `storeUrl` 是 `null`（**当前就是这一档**：商店还没上架）→ 把下面这几步**逐条**给他，一步都不要省：

  1. 地址栏输入 `chrome://extensions` 回车。
  2. 右上角打开「开发者模式」——**不开这个，下一步那个按钮根本不出现**。这是这一步最常见的卡点。
  3. 点「加载已解压的扩展程序」，选 `extension.dir` 打印出来的那个目录。
     **把绝对路径逐字给他，不要写成 `~/...` 让他自己展开**——macOS 的文件选择器默认不显示
     `.` 开头的目录，所以还要告诉他：按 `⌘⇧G` 粘路径，或按 `⌘⇧.` 显示隐藏文件。
  4. 让他核对新出现那张卡片上的扩展 ID，必须等于 `extension.id`。**对不上就是选错目录了**
     （native host 的 `allowed_origins` 逐个枚举 ID，不支持通配符，ID 不对必然连不上）。
  5. 让他点地址栏右边的拼图图标 🧩 → 把 Agent in Chrome **钉到工具栏**。后面所有排障步骤
     都要他「点扩展图标看弹窗」，不钉住他就得每次翻拼图菜单。

  再补一句预期：解压加载的扩展**不会自动更新**，以后升级本机组件后要回 `chrome://extensions`
  点一下那张卡片上的刷新按钮。

然后告诉他两件事，避免他白等或白重启：

- **不用重启 Chrome**，也不用重启 agent 客户端里的 Chrome。扩展装上后自己拨号重连（30 秒一次，退避到最长 2 分钟）；等不及就点扩展图标 →「立即重连」。
- 装扩展和跑安装器**谁先谁后都行**。

## 第 3 步：让客户端读到新配置

**不要擅自重启用户的客户端**——他可能正在里面干活。你要做的是说清楚该怎么做，然后等他。

- Claude Code / WorkBuddy：让他敲 `/mcp` 重连，不用重启。
- 其他 GUI 客户端：Settings → MCP 里重连 `agent-in-chrome`；没有重连入口的才需要重启客户端（**由用户自己动手**）。
- 你自己就跑在刚被注册的那个客户端里时：你这个会话拿不到新工具，得等用户重连/重开之后的下一个会话。如实说明，别假装工具已经在手。

## 第 4 步：验证（必须真的调一次工具）

链路通不通只认一条证据：**`browser_status` 真的回了东西**。

1. 调 `browser_status`。返回里 `connected` 为真、`versions` 两边一致 = 整条链路通了。
2. 再调一次 `browser_tabs_list`，能列出用户真实的标签页 = 工具层也活着。
3. 工具根本不在你的工具表里 → 客户端还没重连（回第 3 步），不是安装失败。
4. 工具在、但报桥接没连上 → 进「排障分支」。

**没有真的调过工具就不许说"装好了"。** `check` 全绿只说明文件都在位，它证明不了浏览器那一端。

## 第 5 步：收口报告

给用户这几件事，一条都不要省：

- 注册进了哪几个客户端（原样列出安装器打印的那一行）、怎么单独摘掉一家。
- 扩展装在哪、是商店版还是解压加载版。
- 验证结果：`browser_status` 回了什么。
- 还需要他手动做的（通常只剩「客户端重连」这一项）。
- 卸载入口：`npx @liang-hz/agent-in-chrome uninstall`（全部可逆，只摘我们自己的键）。

---

## 分支 A：安装器没收录这个客户端

判据：`check` 的输出里没有这家客户端，或用户点名的客户端不在 `--agents` 的 id 清单里。

**顺序照这个来，别跳步。**

### A1. 先拿到精确配置，不要凭记忆写

```bash
npx @liang-hz/agent-in-chrome check --print-config=json         # 全部事实（默认格式，可省略 =json）
npx @liang-hz/agent-in-chrome check --print-config=toml         # Codex 风格的 [mcp_servers.*] 段
npx @liang-hz/agent-in-chrome check --print-config=claude-cli   # 一条 claude mcp add 命令
```

JSON 里你要用到的字段：

| 字段 | 是什么 |
|---|---|
| `mcp.launcher` | `{command, args, env}`：本机启动器版。**GUI 客户端一律用这个**——它固化了 node 的绝对路径，而 GUI 应用拿不到你终端里的 PATH（`node` 在它手里常常直接找不到）。Windows 上这一项是 `cmd /c <启动器.bat>`。 |
| `mcp.npx` | `npx -y @liang-hz/agent-in-chrome serve`：不依赖安装路径的版本。适合还没装过、或不想把路径写死的场合。 |
| `serverPath` | 装好的 `server.mjs` 绝对路径。客户端要 `node <脚本>` 这种形状时用它。 |
| `mcp.name` | server 在配置里的键名，固定是 `agent-in-chrome`。用别的名字会让排障和卸载都对不上。 |
| `extension.dir` / `storeUrl` | 第 2 步要用 |

### A2. 探索这家客户端把 MCP 配置放在哪

按这个顺序找，**找到硬证据再动手**：

1. **问它自己**：`<client> --help`、`<client> mcp --help`、`<client> mcp add --help`。很多 CLI 自带 `mcp add` 子命令——**有就优先用它**，它写出来的形状必然是对的，比你手写强。
2. **搜它的文档**：在它的官网/仓库里搜 `mcp`、`mcpServers`、`config.toml`。注意区分**用户级**和**项目级**配置，用户点名要"全局能用"就写用户级。
3. **常见落点**（按平台）：
   - macOS：`~/Library/Application Support/<Client>/`、`~/.<client>/`、`~/.config/<client>/`
   - Linux：`~/.config/<client>/`
   - Windows：`%APPDATA%\<Client>\`、`%LOCALAPPDATA%\<Client>\`
   - 项目级：仓库根的 `.mcp.json` / `mcp.json` / `.cursor/mcp.json` / `config.toml`
   - 常见文件名：`mcp.json`、`settings.json`、`config.json`、`config.toml`、`mcp_config.json`
4. **拿现有条目当模板**：那个文件里已经有别的 MCP server 就照它的形状写——键名、是不是要 `type`/`enabled`/`disabled`、`command` 是字符串还是数组，各家都不一样。**照抄邻居**比照抄我们的示例更可靠。
5. **实在找不到**：不要瞎写。告诉用户你找不到落点，请他在客户端 UI 里看 MCP 设置界面显示的路径，或者贴一段它现有的 MCP 配置给你。

### A3. 写入

- **写之前先备份**：`cp <配置文件> <配置文件>.bak-$(date +%s)`（Windows：`copy "<配置文件>" "<配置文件>.bak"`）。备份路径要告诉用户。
- **只加/改 `agent-in-chrome` 这一个键**，文件里其它内容一个字节都不动。
- JSON 配置改完**必须验一遍能不能解析**：`node -e 'JSON.parse(require("fs").readFileSync("<文件>","utf8"))'`。把用户的配置写成坏 JSON，那个客户端会整个起不来——比没装严重得多。
- 目录不存在就建（那家客户端确实装着的前提下）；**不要给没装的客户端凭空建目录**。

### A4. 验证 + 回报作者

重启/重连那个客户端（**让用户自己动手**）→ 调 `browser_status` 验证（同第 4 步）。

**通了之后，请用户去提一个 issue**，好把这家收进安装器，下一个人就不用再摸一遍：

> https://github.com/Liang-HZ/agent-in-chrome/issues
> 附上：客户端名称与版本、配置文件的完整路径、你实际写进去的那段配置、以及它是 CLI 还是 GUI 应用（决定用 launcher 还是 `node`）。

没通也值得报，把你试过的路径一并写上。

---

## 分支 B：排障

每条都是「症状 → 命令 → 判据」。**先跑命令拿到数据再下结论**，不要按症状猜。

### B1. 客户端里根本没有 `browser_*` 工具

```bash
npx @liang-hz/agent-in-chrome check
```

- 那家客户端报「未注册」→ 重跑 `install --agents=<id>`。
- 报「已注册」→ 客户端没重连。让用户 `/mcp` 或重启客户端（**GUI 客户端重开会话往往不够**，它的 MCP 连接是跨会话复用的）。
- 那家客户端压根没出现在输出里 → 走分支 A。

### B2. 工具在，但报桥接没连上 / `browser_status` 说 `connected:false`

按这个顺序排，一次说一条，别一口气全倒给用户：

1. Chrome 在跑吗？
2. `chrome://extensions` 里「Agent in Chrome」启用了吗？
3. 点扩展图标 →「立即重连」，弹窗里会把 Chrome 给的断开原因翻译成下一步动作。**先看那句话**。
4. host 日志：`~/.agent-in-chrome/agent-in-chrome-host.log`（Windows：`%USERPROFILE%\.agent-in-chrome\`）。

### B3. 扩展装上了，但 host 连不上（`Native host has exited` / `forbidden`）

- **扩展 ID 不匹配**：native host 清单里的 `allowed_origins` 是逐个枚举的扩展 ID，不支持通配符。商店版和解压加载版的 ID **必然不同**。判据：
  ```bash
  npx @liang-hz/agent-in-chrome check --print-config > /tmp/aic-config.json
  node -p 'JSON.parse(require("fs").readFileSync("/tmp/aic-config.json","utf8")).extension.ids.join("\n")'
  ```
  把它和 `chrome://extensions` 上那个扩展显示的 ID 对一下。对不上 → `npx @liang-hz/agent-in-chrome@latest install`（升级到带新 ID 的版本）。
- **清单文件不在位**：`print-config` 的 `nativeHost.manifestPaths` 给的是每个浏览器该有那份清单的绝对路径，逐个 `ls` 一下。缺了就重跑 install。
- **macOS 上仓库放在 `~/Documents` / `~/Desktop` / `~/Downloads`**：TCC 会挡住 GUI 应用执行那里的文件，表现就是「扩展一切正常但 host 从没被拉起」。运行时本来就装在 `~/.agent-in-chrome`（不受 TCC 管），所以走 `npx` 安装的用户不会撞上；从 git 检出直接跑的把仓库挪出这三个目录。

### B4. Windows：注册表没登记

Windows 上 Chromium 系不扫 `NativeMessagingHosts` 目录，只查注册表。

```powershell
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\org.liangai.agent_in_chrome" /ve
```

- 键不存在 → 重跑 install。
- 键指向的路径和 `print-config` 的 `nativeHost.manifestPaths` 对不上 → 重跑 install 覆盖。
- `check` 说「启动器是旧版本生成的」→ 必须重跑 install：旧版 `.bat` 少一行 `chcp 65001`，**中文用户名下的路径会被 cmd 读坏**，而扩展那边只显示一句 `Native host has exited`。

### B5. 「代码改了/升级了，跑的还是上一版」

这一类最贵：它和「新功能完全失效」长得一模一样。

- **扩展**：解压加载的扩展改了文件不会自动生效。看 `browser_status` 的 `versions.extensionLoadedAt` —— 它**晚于**你改文件/升级的时刻，才是新代码。重载：`chrome://extensions` 点刷新，或扩展弹窗底部的重载按钮。
- **MCP server**：`npx @liang-hz/agent-in-chrome@latest install` 只换磁盘上的文件，**不重启已经在跑的会话**。让持有连接的那个客户端重连一次 MCP。已经装过、只想升级本机组件时用 `npx @liang-hz/agent-in-chrome update`（已是最新就什么都不做）。
- **版本对不齐**：`browser_status` 的 `versions` 会如实显示两边版本；`check` 里也有「装的是 vX，仓库里是 vY」这条。

### B6. 装完 `check` 有红项

`check` 的每一条 ✗ 都自带下一步该敲什么，**照它说的做**，不要另发明一套。退出码就是「有没有 ✗」，所以 `npx @liang-hz/agent-in-chrome check && <下一步>` 这种串写法是成立的。

---

## 安全边界（硬规则）

- **只碰 `agent-in-chrome` 这一个键**。用户配置文件里其它任何内容都不动——那里面常常有别人的 API key 和别的 server。
- **改任何配置文件之前先备份**，并把备份路径告诉用户。
- **不读、不复制、不打印用户的凭据**：token 文件（`~/.agent-in-chrome/` 下那个 0600 的）、配置里别的 server 的 API key、cookie 导出目录。排障要看配置时，只看 `agent-in-chrome` 那一段，别把整份文件贴进对话。
- **不擅自重启用户的客户端、不擅自退出他的 Chrome**。说清楚该怎么做，等他自己动手。要收掉某个进程时先说明理由并等他同意。
- **不擅自卸载**。用户说"重装"时，先跑 `install`（它是幂等的，会覆盖更新）；只有他明确要卸才跑 `uninstall`。
- **装不上就如实说**，写清楚卡在哪一层、试过什么、看到的原文是什么。别用「应该可以了」收场。

## Windows / Linux 差异

| | macOS | Windows | Linux |
|---|---|---|---|
| 实测程度 | 完整实测 | 插件模式已支持；CLI/headless 模式（`AGENT_IN_CHROME_LAUNCH=1`）**尚未支持** | 路径已写，**未实测**，遇到问题如实告诉用户 |
| native host 注册 | 各浏览器的 `NativeMessagingHosts/` 目录里一份清单 | **注册表** `HKCU\Software\<厂商>\...\NativeMessagingHosts\`，值指向一份共用的清单文件 | 同 macOS，目录在 `~/.config/<浏览器>/` |
| 启动器 | `mcp-launcher.sh`（有可执行位） | `mcp-launcher.bat`；客户端配置里写成 `cmd /c <bat>`——批处理不是可执行文件，直接 spawn 会 EINVAL | 同 macOS |
| 桥接端点 | unix socket（`0600` + 目录 `0700`） | 命名管道，第一道防线是令牌 | 同 macOS |
| 配置目录 | `~/Library/Application Support/<Client>/` | `%APPDATA%\<Client>\` | `~/.config/<client>/` |

Windows 上写客户端配置时，**`command` 一律用 `print-config` 给的那一组**（`cmd` + `["/c", "<bat>"]`），不要直接把 `.bat` 当 command 塞进去。

## 相关文档

- [README 快速开始](../../README.md#快速开始) · [两种模式](../../README.md#两种模式) · [安全与透明度](../../README.md#安全与透明度)
- [docs/CLI.md](../../docs/CLI.md)：没有桌面 Chrome 时的 CLI / headless 模式、环境变量、把登录态借过来
- [docs/AGENTS.md](../../docs/AGENTS.md)：16 家已收录客户端各自的配置路径与条目形状（安装器写的就是这些，用来核对）
