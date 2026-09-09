---
name: agent-in-chrome
description: 用 browser_* 工具驱动用户自己的 Chrome(复用其登录态):开页读页、填表点按钮、抓数据、看 console 与网络请求、截图验证前端改动、过点选验证码。任务涉及"我开着的那个页面"、需要已登录身份的站点(内网、OA、邮箱、后台)、或要在真实浏览器里验证本地开发效果时使用。无人值守的批量抓取不用它,用独立浏览器实例。
---

# Agent in Chrome

操作的是**用户本人正在用的浏览器**:你和他共用一个窗口,你的页都在后台标签页里,没有任何工具能把页面切到前台——要他看某页,只能标 `attention` 并在对话里说清。

安全与会话的硬规则由 MCP server 在连上时注入,每个工具的参数语义与约束在它自己的描述里。本文只讲**跨工具的选型、流程和坑**。三处打架以更严格者为准。

## 选型

| 要做的事 | 用 | 而不是 |
|---|---|---|
| 知道目标长什么样(文字/选择器) | `find` | `read_page`(贵一个量级) |
| 摸不清页面结构、要正文 | `read_page` | 逐个 `find` 试 |
| 只想给新元素拿号 | `refresh_refs` | 再读一次整页 |
| 批量取数据、只确认一个状态 | 一条 `eval` 在页内 map 完 | 逐元素读页面 |
| 填下拉/勾选/单选/日期/滑块 | `set`(`read_page` 的 `ref_N` 和 `find` 的 `ref_b…`都收;填表就 `read_page` 一次拿全所有 ref 再逐个 set) | `type`(对它们静默无效) |
| 知道在等什么 | `wait_for`(能塞进 batch) | `read_page` 的 `settleMs` |
| 等到了还要取数 / 还要按结果分支 | 一条 `eval` 的 async 轮询,等待+取数一次往返 | `wait_for` 之后再 `eval`(白多一轮推理) |
| 不知道在等什么 | `settleMs` | 固定 sleep(永远不用) |
| 版式、对齐、遮挡 | `screenshot` | 读文字猜 |
| 拖滑块/拖放/画布手势 | `batch` 串一列 `cdp` 的 `Input.dispatchMouseEvent` | `eval` 合成事件(`isTrusted` 假,真验证码拒) |
| 视口/暗色/限速/定位仿真 | `emulate`(回读校验实际视口,有显式 `reset`) | `cdp` 直发 `Emulation.*`(不验证、也没人还原) |
| 别的工具都不覆盖 | `cdp` | 手写 `eval` 模拟 |
| 性能 / a11y / SEO 跑分 | Bash 里 `npx lighthouse <url> --view` | 用这套工具凑一个分数 |

## 标准流程

1. `new_tab { url, label: "任务名" }` 起手。用户说"打开我的 X 页面"= 用 `tabs_list` 拿 URL 后开自己的一张。
2. `read_page` 拿 `ref`(刚点完/刚导航完加 `settleMs: 300~800`)。返回里 `activeDialog` 非空就**先处理那个浮层**,底下整页多半点不动。
3. 操作 `click` / `type` / `set`;点完等**内容**(`wait_for` 的 selector 或 `js`),不等 URL——SPA 先改 URL 再渲染。
4. 事先写得出的一串动作合成一个 `batch`(判据:有没有哪一步必须先看到前面某步的返回内容才知道怎么写)。遇错即停,**前面的步是真做过的**,从断处接着来,别整批重跑。
5. 抓接口:先做操作,再 `network_wait`,再 `request_detail`。
6. 收尾:结果页留给用户看,组名说清是什么;查资料/中转页 `close_all`。多步任务断了先 `trace`,不是从头再来。

## 跨工具的坑

- **别用 `eval` 绕过工具**:写 `el.value`、派发 `mouseover`、`querySelector().click()` 都不派可信事件、不触发 `:hover`、跳过校验和验命中,而且"跑成功"看不出没生效。要点用 `click`,要悬停用 `hover`,要填值用 `set`,要拖拽走 `cdp` 的配方。
- **点击/输入报错就是没做**,别当成做过了往下走。反过来,`eval` / `cdp` 报成功不代表页面收到了。
- **大结果不进上下文**:`eval` / `cdp` / `screenshot` 都能落盘,只回摘要或路径。
- **凭据默认打码**,`revealSecrets` 只在用户明确要且需要原值时用;拿到的原文会进对话记录。
- **跑分不归这套工具**:性能 / 可访问性 / SEO 的分数走 `npx lighthouse <url>`(Chrome 官方口径,一条 Bash 就跑完)。这套工具负责它进不去的那半——**要登录态的页面**、点开面板之后才出现的那一屏、以及某一个请求的头和响应体。要给登录后的页面跑分,先确认那条路真的需要 Lighthouse:多数时候要的其实是"这个接口慢在哪",`network` + `request_detail` 的 timing 直接就有。
- **subagent 有自己的会话**,用不了主会话的页(报错即隔离生效),自己 `new_tab`。

## 场景索引

按需读一份,不要一次全读:

| 场景 | 读 |
|---|---|
| 多标签页、subagent 并发、接管用户的页、**点跳转链接开出来的新页**、收尾、另起实例搬登录态 | [tabs-and-sessions.md](references/tabs-and-sessions.md) |
| ref 失效、元素被截断、模态浮层、iframe/shadow DOM、页面还没渲染完 | [reading-pages.md](references/reading-pages.md) |
| 点不动的报错分型、填表、悬停菜单、上传、拖拽/滑块、批量占位符与限制、**页内轮询模板** | [actions-and-waits.md](references/actions-and-waits.md) |
| 抓接口、看请求体/头/cookie、复现给后端、WebSocket、console | [network-debugging.md](references/network-debugging.md) |
| 顺序点选文字验证码(GeeTest) | [geetest-click-captcha.md](references/geetest-click-captcha.md) |
| 高德网页版路线规划：下拉建议读不到/点不中、拿 POI 权威坐标、读路线距离时长 | [amap-dir-dropdown.md](references/amap-dir-dropdown.md) |
| 任务中断、连不上、超时、各种报错 | [recovery.md](references/recovery.md) |
