# 高德网页版路线规划的浮层列表（感知/定位/选中）

适用：`www.amap.com`（2026-09 的 ssr-next + React/antd 版本，`/ssr/dir`、`/ssr/search`）。同类"自定义下拉建议列表"（无 ARIA 角色、React 重渲染频繁）都可套用。实测环境：Chrome 152 + agent-in-chrome 0.53.8。

## 三个症状与真因

| 症状 | 真因 | 对策 |
|---|---|---|
| "下拉闪一下就消失，来不及读" | 浮层其实稳定存在（实测聚焦状态下 10 秒+/215 个采样无一次隐藏），只是 `find`/`read_page`/`refresh_refs` 走无障碍树，**列表项是裸 div、无 a11y 角色，读不到** | 别再靠 a11y 工具找列表项，直接用 CSS 选择器 + `eval` |
| `click(selector)` 报"目标动了" | React 在 hover/mousedown 时重渲染，按下和抬起之间节点被替换 | `force: true`（实测点中且生效） |
| `refresh_refs`/`find` 在列表上两眼一抹黑 | 同症状 1；a11y 提取把无角色元素折叠/丢弃 | 见下"感知" |

## 感知：浮层在哪、活多久

- 列表**不是** body 级 portal，就挂在路线面板内：
  - 容器 `[class*="POISugList_searchSuggestions"]`
  - 列表项 `[class*="POISugList_suggestionItem"]`（textContent = "名称+地址"，可据此核对是不是你要的 POI）
- 寿命（MutationObserver + 150ms 采样器实测）：**输入框聚焦期间 ≥10s 稳定可见；失焦或选中某项后隐藏**。你通常死于"读的方式不对"，不是"它跑得快"。
- 重新唤起：**点一下输入框即可**（focus 会用当前文本重放建议列表），不用重新打字。
- 通用测量手法：先 `eval` 装 `setInterval` 采样器/MutationObserver 把可见性记到 `window.__log`，再触发 UI，再 `eval` 读时间线——把"感觉它闪"变成有数字的结论。

## 定位：读到列表项、选中第 N 项

```js
// eval：枚举建议项（名称+地址核对用）
[...document.querySelectorAll('[class*="POISugList_suggestionItem"]')]
  .map(el => ({ txt: el.textContent.slice(0, 60),
                box: (r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])(el.getBoundingClientRect()) }))
```

- 要第 1 项：直接 `click { selector: '[class*="POISugList_suggestionItem"]', force: true }`（多个匹配点第一个可见的）。
- 要第 N 项：上面 eval 拿到 `box`，`click { x, y }` 点它的坐标；CSS `:nth-child` 仅当各项是同父兄弟时才可靠。

## 选中：点完之后怎么确认没点错

1. 输入框 `value` 变成**完整 POI 名**（不再是你的搜索词）。
2. `decodeURIComponent(location.href)` 追加了权威参数：
   `fname/flat/flon/fid/fpoitype`（起点）+ `dname/dlat/dlon/did/dpoitype`（终点）+ `policy`。
   **这组坐标比搜索接口返回的更准**（实测同一酒店：接口 39.882309 vs UI 选中 39.883205——UI 给的是入口级坐标）。做深链（`uri.amap.com`）就取这里的值。
3. 两端都从下拉里显式选中最稳；只打字不选时高德会自动解析成"它认为最佳"的 POI（起点常被自动解析），**名字有歧义就必须显式选**，用 URL 里的 `fid/did` 核对。

## 完整配方（一段路线 ≈ 6 次调用）

```
navigate https://www.amap.com/ssr/dir          # URL 带 from/to 坐标参数不会预填(实测无效),别抄近路
click   input[placeholder="请输入起点"]         # 触发浮层
type    起点关键词(越具体越好)                   # 浮层刷新
click   [class*="POISugList_suggestionItem"] force:true   # 起点(要第N项先eval取box再click x,y)
click   input[placeholder="请输入终点"] → type → 同法点终点
eval    decodeURIComponent(location.href)      # 拿两端坐标/POI ID —— 存下来给深链用
```

两端选齐后**自动出路线**，无需提交按钮。

## 读路线结果（驾车/步行同一面板）

```js
[...document.querySelectorAll('[class*="CarOrWalkRoutePlanItem_routePlanItem"]')]
  .map(el => ({ dur_s: el.querySelector('[data-duration]')?.dataset.duration,
                dist_m: el.querySelector('[data-distance]')?.dataset.distance,
                text: el.innerText.replace(/\n/g, ' ') }))
```

- 每方案给 3 条左右：`时长 / 距离 / 红绿灯数 / 途经道路`。
- **方案里的第三个数字是红绿灯数（旁边有红绿灯图标），不是打车估价**——网页版路线面板不提供打车费，别把它当车费写进方案（实测 innerHTML 无任何打车元素）。车费要用计价公式估算并明示"估算"。
- `data-duration`（秒）/`data-distance`（米）是程序化读数的正道，别正则抠文本。
