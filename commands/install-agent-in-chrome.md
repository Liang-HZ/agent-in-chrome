---
description: 安装 / 配置 / 排障 Agent in Chrome：装到本机、接到某个 agent 客户端、装不上时定位
---

按 `install-agent-in-chrome` 这个 skill 执行。

> 插件规范会自动发现 `skills/` 下的每个技能目录（`.claude-plugin/plugin.json` 里 `"skills": "skills"`），
> 所以用户直说「帮我装 agent-in-chrome」时 skill 本来就会被选中；
> 这条命令只是给一个可以直接敲的入口（`/install-agent-in-chrome`）。

用户在命令后面附带的话（比如「装到 Cursor」「只接 Claude Code」「装不上，帮我看看」）就是这次的具体目标，先按它决定走哪条分支：

- 没说清要装到哪 → 先跑 skill 的第 0 步探环境，再问他要接哪个客户端。
- 点名了一个安装器已收录的客户端 → 走主流程（install → 扩展 → 重连 → `browser_status` 验证 → 收口报告）。
- 点名的客户端不在 `npx @liang-hz/agent-in-chrome check` 的清单里 → 走 skill 的「分支 A：安装器没收录这个客户端」。
- 已经装过、说不通/连不上 → 走「分支 B：排障」，先拿数据再下结论。

硬规则（skill 里写全了，这里只重复最容易被跳过的三条）：

1. **没有真的调用过一次 `browser_status` 就不许说"装好了"**。
2. **不擅自重启用户的客户端、不擅自退出他的 Chrome**；改任何配置文件之前先备份。
3. 装完把「注册进了哪几个客户端」和「怎么单独摘掉一家」原样告诉用户。
