---
description: 查看 Agent in Chrome 的连接状态，列出可接管的标签页
---

检查浏览器桥接是否正常，并把当前可接管的标签页列给用户看。

步骤：

1. 调用 `browser_status`。报告：桥接是否连上、当前接管了哪个标签页、共有多少个打开的标签页。
2. 若未连上，按顺序给出排查项，不要一次全倒出来：
   - Chrome 是否在运行
   - `chrome://extensions` 里 "Agent in Chrome" 是否已启用
   - 装完 native host 后是否重启过 Chrome（Chrome 只在启动时读 host 配置）
   - 扩展弹窗里点一下"重新连接"
3. 若已连上，调用 `browser_tabs_list`，用表格列出 tabId / 标题 / URL，并标出当前活动页和已接管页。
4. 结尾提示用户可以说"接管 xxx 那个标签页"来开始。

只做状态检查，不要自作主张接管任何标签页。
