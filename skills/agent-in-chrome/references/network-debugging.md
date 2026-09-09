# 抓接口与排查前端

等价于 DevTools 的 Network 面板:**先看列表,再点进去看内容**。

```
browser_click { ref: "ref_12" }                         # 先做那个操作
browser_network_wait { urlContains: "/api/orders" }     # 再等它;默认先回看最近 30s
browser_request_detail { requestId }                    # 完整请求/响应头与体
```

不知道该等什么就换水位法:`browser_network { clear: true }` → 做操作 → `browser_network { type: "api" }`,只剩这次产生的接口。

## 分型

- **等不到**:多半是 `type: "api"` 把 Document / EventSource / Script 滤掉了。第三方 JSONP 类接口(验证码服务等)是 Script 类型,必须 `type: "all"`。
- **拿不到响应体**:XHR / Fetch 的在完成时就抓好了;其他类型是现取的,可能已被 CDP 缓冲淘汰,那时返回 `responseBodyError`。
- **`bodyContains` 搜不到**:先看返回值里有没有 `searchFailed`。整批都搜不成时它会明说「不知道有没有含」——那是**搜不了**(多半调试器不在这一页),不是「没有」。搜的是 Chrome 自己的响应缓冲,页面刷新过或过了很久的会被淘汰;匹配是逐字节的,值在页面上被格式化过(千分位、日期、转义)就搜不到原样。
- **页面报错看不出所以然**:`browser_console` 看异常,再 `browser_network { onlyFailed: true }`。
- **复现给后端**:`browser_as_curl`。`headersSource` 是过滤头时命令多半缺 Cookie、重放 401;`revealSecrets` 补不回"头本身没拿到",得自己补 Cookie。
- **WebSocket 一条连接都没有**:只记录接管之后建立的连接,早连上的刷新页面即可。`new_tab` 开的页天然没这问题(先挂调试器再导航)。
