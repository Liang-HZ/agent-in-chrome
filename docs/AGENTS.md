# 各 agent 的 MCP 配置（安装器写入的内容）

> 安装器（`npx @liang-hz/agent-in-chrome install`）会自动写好这一切，**正常情况下你不需要读这个文件**。
> 它存在的用途：核对安装器到底写了什么、或在不能跑安装器的环境里手动登记。
> 从 [README](../README.md) 挪出来，免得 16 家客户端的配置路径挡在快速开始的正路上。

安装器会自动写好这些；下面是它实际写入的文件和内容，供你核对或手动登记。把 `<RUNTIME>` 换成安装器打印的实际路径（默认 `~/.agent-in-chrome/agent-in-chrome`）。每个文件改前都会留 `.bak-<时间戳>` 备份，且只动 `agent-in-chrome` 这一个键。

**Claude Code**——有 `claude` 命令时安装器直接调它（等价于你手动跑）：
```bash
claude mcp add --scope user agent-in-chrome -- node <RUNTIME>/server.mjs
```
没有 `claude` 命令时直接编辑 `~/.claude.json` 顶层的 `mcpServers`：
```json
{ "mcpServers": { "agent-in-chrome": {
  "type": "stdio", "command": "node", "args": ["<RUNTIME>/server.mjs"], "env": {}
} } }
```

**Claude Desktop**（macOS `~/Library/Application Support/Claude/claude_desktop_config.json`，Linux `~/.config/Claude/claude_desktop_config.json`）:
```json
{ "mcpServers": { "agent-in-chrome": {
  "command": "<RUNTIME>/mcp-launcher.sh", "args": []
} } }
```
> Claude Desktop 这类 GUI 应用没有你终端里的 PATH，`node` 常找不到——所以走 `mcp-launcher.sh`，它固化了 node 绝对路径。
>
> **只在 Claude Code 的 user scope 没注册时才写这一条**。桌面端和 Claude Code 共用同一个引擎，
> 两边同名的连接器会抢命名空间：桌面端和 Claude Code 共用同一个引擎，两条同名注册会互相顶掉。
> 安装器现算这件事：`~/.claude.json` 的 user scope 里已经有 `agent-in-chrome` 时，它不写这一条，
> 而且会**主动摘掉**机器上已有的那条桌面端条目；`check` 也据此报「有意不注册」。
> 手动登记时照这条规矩来——两边都写就会重现那次事故。

**WorkBuddy**（`~/.workbuddy/mcp.json`，**非隐藏**那份）:
```json
{ "mcpServers": { "agent-in-chrome": {
  "type": "stdio", "command": "<RUNTIME>/mcp-launcher.sh", "args": [], "disabled": false
} } }
```
> 同样是 GUI 应用，同样走 `mcp-launcher.sh`。
> 同目录那个隐藏的 `.mcp.json` 是 WorkBuddy 自己的**输出**文件（每次启动写 connector-proxy 聚合条目），
> 往里写注册它不读；装的时候会顺带把老版本写错在那里的条目摘掉。

**ZCode**（`~/.zcode/cli/config.json`，段落是 `mcp.servers`）、**opencode**（`~/.config/opencode/opencode.json`，段落是 `mcp`，`command` 是数组且要 `enabled: true`）、
**Kimi CLI**（`~/.kimi/mcp.json`）、**Gemini CLI**（`~/.gemini/settings.json`）——
后两家都是标准 `mcpServers` 形状。安装器只碰 `agent-in-chrome` 这一个键，其余内容原样保留（改前自动备份）。

**Antigravity**（`~/.gemini/config/mcp_config.json`，官方文档 antigravity.google/docs/ide/mcp 明写的全局位置；
IDE 和 agy CLI 共用这一份）也是标准 `mcpServers`，但它是 GUI 应用，所以走 `mcp-launcher.sh`：
```json
{ "mcpServers": { "agent-in-chrome": {
  "command": "<RUNTIME>/mcp-launcher.sh", "args": []
} } }
```
> 它和 Gemini CLI 共用 `~/.gemini` 这个根目录，但两家占的子路径不相交：Gemini CLI 的东西
> （`settings.json`、`oauth_creds.json`、`tmp/`、`commands/`…）都直接摊在 `~/.gemini` 下、MCP 写在
> `settings.json` 里，`~/.gemini/config/` 这个**目录**只有 Antigravity 会建——探测就认它。
> 首启建出来的 `mcp_config.json` 可能是 0 字节（本机实测），空文件按 `{}` 处理，不当成「坏 JSON」拒写。
> 工作区级的 `.agents/mcp_config.json` 是项目内文件，安装器不碰。

**Qoder CLI**（`~/.qoder/settings.json`）也是标准 `mcpServers` —— 这个路径是装上 `qodercli` 实测的
（`qodercli mcp get` 打出 `Location: ~/.qoder/settings.json` / `Status: ✓ Connected`），
不是国内版文档里的 `~/.qoder-cn/`；后者作为 **Qoder CN CLI** 单列，只在那个目录真存在时才写。
注意 `~/.qoder` 是 IDE 与 CLI 共用目录：IDE 读 `mcp.json`，CLI 读 `settings.json`，互不相干。

**国内版**同构，只是换了数据目录：**Qoder CN CLI** `~/.qoder-cn/settings.json`（已实测 ✓ Connected）、
**Qoder CN IDE**（见下）、**Trae CN** `~/Library/Application Support/Trae CN/User/mcp.json`。
三家都已实测连通（Trae CN 日志 `Connected.` + 36 个工具；Qoder CN 缓存 `toolCount: 36`）。

> **Qoder IDE 的配置文件有两个候选位置，安装器会挑对的那个写**：数据目录
> （`~/.qoder/mcp.json`、`~/.qoder-cn/mcp.json`）只是**首启时的迁移源**，一旦
> `QODER_HOME/mcp.json`（`~/Library/Application Support/{Qoder,QoderCN}/SharedClientCache/mcp.json`）
> 存在，它就再也不看数据目录了（二进制里那句 `copy data: target mcp.json already exists, skip`）。
> 实测：国际版没有后者，写数据目录就通；CN 版有后者，写数据目录完全没反应，改写它立刻拉起。
> 规则是 **QODER_HOME 那份存在就写它，否则写数据目录**；卸载时两处都清（迁移源里留着会在下次首启诈尸）。

**Trae**（`~/Library/Application Support/Trae/User/mcp.json`）和 **Qoder IDE**（`~/.qoder/mcp.json`）
也都是标准 `mcpServers`，同为 GUI 应用所以走 `mcp-launcher.sh`。这两条路径是装上真机实测出来的
（写配置 → 重启 → 读它自己的日志确认 server 真的被拉起），不是从文档抄的——它们的官方文档都没写。

> **卸载按名字，不按位置**：会在整份配置里找我们的条目（含改名前的 `zcode-in-chrome`）逐个摘掉，
> 不管它躺在哪个段落。按固定路径删会留下指向已删运行时的悬空条目——客户端每次启动报
> Connection closed，而用户刚刚明明「卸载成功」了。重装时同样会顺手清掉旧位置的残留。

**Codex CLI**（`~/.codex/config.toml`）:
```toml
[mcp_servers.agent-in-chrome]
command = "node"
args = ["<RUNTIME>/server.mjs"]
```

**其他 MCP 客户端**：任意 stdio 配置指向 `node <RUNTIME>/server.mjs` 即可；不想依赖固定安装路径的话，命令也可以用 `npx -y @liang-hz/agent-in-chrome serve`。

不想手抄的话，让安装器把本机的精确配置吐出来：`npx @liang-hz/agent-in-chrome check --print-config=json|toml|claude-cli`（`json` 是默认值，可省略 `=json`；`toml` 给 Codex 那种 `[mcp_servers.*]` 形状；`claude-cli` 直接给一条 `claude mcp add` 命令）。stdout 只有配置本身，可以直接喂 `jq`，也可以让 agent 照着改写成那家客户端自己的 schema——这条路径一个字节都不写盘。
