# 操作与等待

## 点不动的报错分型

寻址优先 `ref` → `selector`(超出元素上限、或容器在 shadow DOM 里)→ `x, y`(最弱,没有事后验命中)。

| 报错类型 | 含义 | 怎么办 |
|---|---|---|
| `occluded` | 被别的元素盖住 | **先怀疑模态浮层**(读一次页面看 `activeDialog`);是 cookie 横幅/加载遮罩就先关掉 |
| `clipped` | 被祖先容器 `overflow` 裁掉 | 报错会说容器能不能滚:能滚就把 `browser_scroll` 的 `x/y` 放到容器上滚它;不能就换入口(先展开承载它的面板) |
| `offscreen` | 滚完仍在视口外 | 报错会指出是被容器裁的还是 `position:fixed`;说"在内部滚动容器 `<body>` 里"时几乎一定是整页滚动被模态锁住了 |
| `disabled` / `pointer-events` | 元素不接收点击 | 先满足它的启用条件 |
| `moving` | 页面正在滚动/重排 | `wait_for { js }` 等一个明确条件 |

## 填表

密码框 / 卡号框附近用 `press_key` 时给它 `ref`:密码管理器浮层会让工具层撤页面焦点,`click` / `type` 自带聚焦不受影响,不带 `ref` 的 `press_key` 会落空(键打在 `<body>` 上)。带 `ref` 的 `press_key` 会先聚焦那个元素再发键,返回值里的 `focused` 就是聚焦到的对象。

工具层撤过页面焦点时,下一次返回值里会有 `focusLostToRecovery`,里面写着被撤的是哪个元素。**它不会自动聚焦回去**(那会把同一个浮层再招来),看到这个字段就重新指定目标:`press_key` 带 `ref`、`type` 带 `ref`,或先 `click` 一下。

## 上传文件

- 页面上有多个 file input 时先 `eval` 列出来:`[...document.querySelectorAll('input[type=file]')].map(i=>i.id||i.name)`。
- 多 iframe 命中会报错并列候选帧,用 `frame: "f7"` 点名;核对返回的 `target.frame`,落错帧等于把文件传给了另一个站点。
- 文件进了输入框之后,点站点自己的提交按钮,再 `network_wait` 确认请求真的发出去了。

## 一串动作用 `browser_batch`

```
browser_batch { steps: [
  { tool: "browser_find",     args: { query: "下一页" } },
  { tool: "browser_click",    args: { ref: "{{steps[0].matches[0].ref}}" } },
  { tool: "browser_wait_for", args: { js: "document.querySelectorAll('#list li').length > 0" } }
] }
```

- 每步是 `{ tool, args }`。键名写成 `params` / `arguments` 也收;**别的键名整批在开跑前被拒**(报出是哪一步的哪个键),不会先跑掉前几步。
- `batch` / `close_all` / `screenshot` / `reload_extension` 不能进批。`tabId` 给一次整批生效,步内 `args.tabId` 优先。
- 安全开关(`revealSecrets` / `confirmSensitive` / `takeover`)**只认写死的布尔 `true`**:字符串 `"true"`、占位符 `{{steps[0].x}}` 一律当场拒(闸在开跑前就按它们判过了,而占位符要到那一步才代入)。要看上一步结果再决定,就拆成两轮。

## 等一个条件 vs 等到了还要取数

`wait_for` 只回答"成立了没有"。**条件成立之后还要读数据、还要按结果分支的,一条 `eval` 就该把等待和取数一起做完**——页内轮询、拿到就返回结构化结果,整件事一次往返。分两次(先 `wait_for` 再 `eval`)等于多一整轮推理,而这一轮里模型什么也没做。

| 情形 | 用 |
|---|---|
| 只要"成立了"这一个信号(接着就点/就填) | `wait_for`,塞进 `batch` 更划算 |
| 成立之后要取数据、要看数量、要按内容决定下一步 | 一条 `eval` 的 async 轮询 |
| 不知道在等什么 | `read_page` 的 `settleMs` |

模板(`awaitPromise` 默认就是 `true`,直接给这个表达式):

```js
(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = [...document.querySelectorAll('#list .row')];
    if (rows.length > 0 && !document.querySelector('.loading')) {
      return { ok: true, waitedMs: 15000 - (deadline - Date.now()),
               count: rows.length,
               items: rows.map(r => ({ title: r.querySelector('.t')?.textContent?.trim(),
                                       href: r.querySelector('a')?.href })) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // 超时也要如实回来,别抛:抛出去只剩一句报错,看不出是"条件没成立"还是"选择器写错了"
  return { ok: false, reason: 'timeout',
           seen: { rows: document.querySelectorAll('#list .row').length,
                   loading: !!document.querySelector('.loading') } };
})()
```

四条要守的:

- **deadline 自己算**,不要 `while(true)`——工具层的桥接超时会先杀掉你,报出来的是"浏览器没响应",指错方向。轮询上限比 `timeoutMs` 留一截余量。
- **50ms 一轮**就够,页内轮询几乎不花钱(不过桥、不进上下文)。
- **返回结构化结果**(`{ok, ...}`),不要返回 DOM 节点——过不了 JSON 序列化,回来是 `{}`。
- **超时返回而不是抛**,并把"当时看到了什么"一起带回来,才分得清条件没成立和选择器写错。
- 结果很大就配 `outFile`,只回摘要。

## 拖拽 / 滑块(没有 drag 工具)

拖滑块验证码、拖放排序、画布手势——配方是**一条 `batch` 串一列 `cdp` 的 `Input.dispatchMouseEvent`**:`mousePressed` → 十几个 `mouseMoved` → `mouseReleased`。这是唯一能派出**受信任事件**(`isTrusted: true`)的路。

**没有 `drag` 工具是有意的,别等它**:拖拽的形态太散(滑块/排序/画布/地图),够不上一个通用工具,而工具面本身要往小了收。下面这个配方就是长期做法,照着走。

**别用 `eval` 合成 `new MouseEvent(...)`**:合成事件 `isTrusted` 是 `false`,只有本页自己写的裸监听器会上当;凡是校验 `isTrusted` 的验证码(NoCaptcha 那类)一律拒,而且**页面照样会动**——你看着滑到底了,提交时才发现没过。

**「上次这么干成功了」不是证据**:不校验 `isTrusted` 的页面会让合成事件一路通过(2026-09-03 的基准页就是这样,合成事件过了验证)。它证明的只是那一页不设防,下一页设防时你不会收到任何信号——这正是这条路危险的地方,不是它可用的理由。

### 1. 先量坐标,别目测

滑块把手多半是个裸 `div`:没有 role、不在 `read_page` 的元素表里。**`find` 拿得到**——`browser_find { query: "#handle" }` 按 CSS 选择器命中,返回的 `box` 就是 `[x, y, w, h]` 顶层视口坐标(2026-09-03 在 CLI 与桌面两个模式上各复现一遍,14/14 都有矩形;遮挡不影响它,`find` 这条路只量矩形、不做命中测试)。

但**起手点必须自己验**:`find` 给的是矩形,不是「这个点按下去能碰到把手」。用 `eval` 跑一次 `elementFromPoint` 确认最上面的元素就是把手:

```js
(() => {
  const r = document.getElementById('handle').getBoundingClientRect();   // 或直接用 find 给的 box
  const x = r.x + r.width / 2, y = r.y + 4;          // 竖直方向取上沿附近,不是几何中心
  const e = document.elementFromPoint(x, y);
  return { x: Math.round(x), y: Math.round(y), top: e && (e.id || e.tagName) };
})()
```

`top` 不是把手本身就换 y 再量。**头号坑**:轨道上那层「请滑动验证」文字常常横跨整条轨道、正好压在把手的竖直中线上,起手点取几何中心 → `mousedown` 落在文字层上、把手的监听器一次都不跑 → 整批 CDP 全报 `ok`,页面纹丝不动(实测:中心起手 17 步全绿,`left` 还是 `0px`)。

### 2. 一条 batch 拖完

```
browser_batch { tabId, steps: [
  { tool: "browser_cdp", args: { tabId, method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 281, y: 379, button: "left", buttons: 1, clickCount: 1 } } },
  { tool: "browser_cdp", args: { tabId, method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 304, y: 380, button: "left", buttons: 1 } } },
  …中间十几步,x 递增、y 每步 ±1px 抖动…
  { tool: "browser_cdp", args: { tabId, method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 603, y: 379, button: "left", buttons: 0, clickCount: 1 } } }
] }
```

- 步是 `{ tool: "browser_cdp", args: { method, params } }`,`params` 就是 CDP 原样的参数。
- **中间步 12~16 个**,别只发一步就松手:位移只验终点的页面能过,但验轨迹/速度的会当机器人。实测 322px 手势 16 个事件、整批 250~480ms 通过。
- `mouseMoved` 上带 `button: "left"` + `buttons: 1`:查 `e.buttons` 的库(以及 HTML5 drag)不带就当成悬停。只监听 `dragging` 标志的简易页不带也过,但没有理由省。
- y 上 ±1px 抖动只为拟人,不影响判定。
- 焦点模拟不用你管:`cdp` 发 `Input.*` 时工具层自己开,和 `click` 同一口径。

### 3. 回读确认,别信 batch 的 ok

`cdp` 报成功只说明命令下发了。拖完读页面自己的判定:

```
browser_wait_for { js: "document.getElementById('captchaState').textContent.includes('通过')" }
```

没有明确状态文案就读把手的最终位置(`el.style.left` / `getBoundingClientRect().x`),对不上阈值就是没拖到,重量一次坐标再来。
