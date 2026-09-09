# 读页面

## 页面还没渲染完:`settleMs`

客户端渲染的站点点完要 2~3 秒 DOM 才更新,立刻读拿到的是上一屏,**不报错、返回值上看不出是旧的**。

`read_page` / `refresh_refs` / `find` 都支持 `settleMs`:等 DOM 连续这么多毫秒不变再快照。总预算是它的 6 倍并夹在 1~10 秒;到点还在变照常快照,返回 `settleTimedOut: true` + `settleNoisyFrames`(还在动的是哪一帧)。每一帧各自计时,广告位、轮播、倒计时会让它超时——只剩广告帧在动时结果照常能用。

## 模态浮层

```
browser_read_page { container: "<activeDialog.container 原样抄>", maxText: 0 }   # 只读浮层子树拿 ref
```

`container` 直接抄它给的值,那是当场验过的。验不过就不给,那时看 `hint`:多半浮层在 shadow DOM 里,改用 `browser_find` 按文字找里面的控件,或直接点 `activeDialog.ref`。

跨进程 iframe(OOPIF)里的浮层报"iframe 被父页面挡住"时,是父页面盖了东西在整个帧上,先关父页面的遮挡物,别 `force`。

## 元素被截断

超出 `maxElements` 的元素**没有 ref、点不了**,不是页面上没有(`elementsTotal` 是真实总数)。浮层是重灾区:弹出后底下整页元素还在 DOM 里占名额,浮层里的"确定"排在几百位开外——截断时若正开着浮层,`truncatedHint` 会写明该用的 `container`。

`container` 认 iframe 里的子树,子树内部的 shadow DOM 照样穿。但选择器本身进不了 shadow DOM——**容器自己在 shadow 里就选不中**,改用 `browser_click` 的 `selector`。

`browser_find` 也收 `container`:全页搜索命中太杂时,先把范围收到那棵子树里。它走顶层文档的 `querySelector`,进不了 closed shadow DOM 和跨进程 iframe,匹配不到直接报错、**不回落整页**(同 `read_page`)。注意 `maxCandidates` 是在收窄**之前**截断的,子树里东西少却还嫌漏,就把它调大。

## iframe 与 shadow DOM

- iframe 内元素 ref 形如 `ref_3@f7`,shadow 内的带 `inShadow: true`;坐标一律换算成顶层视口坐标,截图、`x/y` 点击、ref 点击同一套坐标系。
- `frames` 里某个跨源 iframe 标了 `coords: "未知"`:它被 CSS 旋转/斜切/缩放过,里面的元素点不了——`browser_new_tab` 直接打开那个地址。
