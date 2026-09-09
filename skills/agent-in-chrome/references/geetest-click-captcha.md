# 顺序点选文字验证码(GeeTest)

适用「请在下图依次点击:X Y Z」这类点选码。三条原则:**不截图认字、不目测坐标、提交前数值验证落点**。截图会被 DPR 缩放坑(pixelated 变体字认错);目测质心会被最亮的笔画带偏。全程 4 次往返。

## 1. 一条 eval:拿情报 + 验坐标原点

```js
(() => {
  const wraps = [...document.querySelectorAll('.geetest_item_wrap')].filter(w => w.getBoundingClientRect().width > 0);
  const wrap = wraps[0];                                   // 多实例站点(一个按钮一个实例)只挑可见的
  const img  = wrap.querySelector('.geetest_item_img');
  const tip  = document.querySelector('.geetest_tip_img');
  const w = wrap.getBoundingClientRect(), i = img.getBoundingClientRect();
  if (Math.abs(w.left - i.left) > 1 || Math.abs(w.top - i.top) > 1) throw new Error('wrap 与 img 原点不一致:' + JSON.stringify({w, i}));
  const url = (getComputedStyle(tip).backgroundImage.match(/url\("?(.+?)"?\)/) || [])[1];
  return { url, img: { x: i.left, y: i.top, w: i.width, h: i.height }, wrapH: w.height, natural: { w: img.naturalWidth, h: img.naturalHeight } };
})()
```

- `.geetest_tip_img` 的 `background-image` 就是原图 URL(含 `challenge=` 参数);提示条是同一张图左下角被 `background-position` 裁出来的,顺序以它为准。
- **必须断言裁剪窗 `.geetest_item_wrap` 与 img 的 rect 一致,不一致就 throw**:原点没核对就换算,整批点击整体偏 30+px,这是头号坑。
- 可见高度可能被裁过(img 高 ≠ wrap 高,底部约 40px 是藏起来的提示条),换算只用宽度比。

## 2. 一条 Bash:下载原图 + 算质心

`curl` 下载原图(原生约 344×384,比截图清晰一个量级),PIL 一段脚本做两件事:

1. 整图 ×4 与提示条 ×8 拼成一张图,**一次 Read 认完**(顺序从提示条读,多为菜名/词组,干扰字不在条里)。
2. 按色相做掩码 → 连通域聚类 → 输出每个字的质心(原图像素坐标)。

要点:红/暖色背景会污染全图饱和度掩码,改按字的冷色(蓝/青/品红)出掩码,或分区域算;裁图用 PIL,`sips --cropOffset` 实测不稳。

## 3. Read 拼合图:字与质心一一对上

CSS 坐标 = 原点 + 原图像素 × (`img.w` / 原图宽)。把提示条读出的顺序和聚类质心对上,得到每个字的视口点击坐标。

## 4. 一个大 batch 点完

```
browser_batch { steps: [
  { tool: "browser_hover", args: { x: X1, y: Y1 } },   // hover 到精确点击坐标
  { tool: "browser_click", args: { x: X1, y: Y1 } },   // 再点同一点
  { tool: "browser_hover", args: { x: X2, y: Y2 } },
  { tool: "browser_click", args: { x: X2, y: Y2 } },
  …
  { tool: "browser_eval",  args: { expression: "<守卫:读点击标记的坐标,与预期字心比对,超差 >12px 就 throw>" } },
  { tool: "browser_click", args: { ref: "<确认按钮>" } },
  { tool: "browser_wait_for", args: { js: "/验证成功|验证失败/.test(document.querySelector('.geetest_result_tip')?.textContent || '')" } }
] }
```

- hover + click 成对、同一坐标:消除点击前的位置跳变。行为检测盯的就是这个,裸 CDP 点击没有 mousemove 轨迹,错两次就会 refresh 换题。
- 守卫 eval 放在确认之前:读页面上点击标记 div(`geetest_atip` 一类)的坐标 vs 预期字心,超差就 throw,batch 停在确认前,错误提交的成本从一轮重做降为一次拦截。标记 DOM 结构各主题版本有差异,第一次遇到时点完第一个字先 dump 一次结构再固化表达式。
- 结果看 `.geetest_result_tip` 的即时文案,别截图、别 sleep。
- 查接口看结果时注意 GeeTest 走 JSONP:`type: "api"` 会滤掉,要 `type: "all"`。
