#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 0);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const FORM_SUBMITS = [];

function encodeFrame(payload, opcode = 1) {
  const data = Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    out.push({ opcode, payload: payload.toString("utf8") });
    off = p + len;
  }
  return { frames: out, rest: buf.subarray(off) };
}

function framePage(id, nest, nestSandbox, autopost) {
  const inner = nest
    ? `<iframe id="inner"${nestSandbox ? ' sandbox="allow-scripts"' : ""} src="${nest}" style="width:96%;height:110px;border:1px dotted #999"></iframe>`
    : "";
  return (
    `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:6px">` +
    `<p id="frame-text">我在 iframe 里（${id}）</p>` +
    `<button id="frame-btn">iframe 内的按钮 ${id}</button>` +
    `<input id="frame-file" type="file">` +
    `<input id="frame-input" placeholder="帧内文本框 ${id}">` +
    `<button id="frame-upload">帧内提交 ${id}</button>` +
    `<div id="frame-log">未点击</div>` +
    `<div id="frame-file-log">未选择</div>${inner}` +
    `<script>
      var ID=${JSON.stringify(id)};
      var up=function(v){ try{ parent.postMessage({aicUpload:ID+':'+v},'*'); }catch(e){} };
      document.getElementById('frame-btn').onclick=function(){
        document.getElementById('frame-log').textContent='frame-clicked';
        try{ parent.postMessage({aicClick:ID},'*'); }catch(e){}
      };
      document.getElementById('frame-file').onchange=function(e){
        var names=[].map.call(e.target.files,function(f){return f.name+'@'+f.size}).join(',');
        document.getElementById('frame-file-log').textContent='frame-file:'+names;
        up('change:'+names);
        // autopost=1 的帧收到文件就自己发出去。
        // 为什么要这条路：端到端断言（服务端收到的字节 == 本机文件）只该依赖
        // 「文件真进了这个帧」，不该顺带依赖「合成点击能不能打进这个帧」——
        // 后者是另一层的事，在隔离测试浏览器里本来就不稳。
        if (${autopost ? "true" : "false"}) document.getElementById('frame-upload').click();
      };
      document.getElementById('frame-upload').onclick=function(){
        var i=document.getElementById('frame-file');
        if(!i.files.length){ up('nofile'); return; }
        var fd=new FormData();
        for(var k=0;k<i.files.length;k++) fd.append('frame-'+ID, i.files[k], i.files[k].name);
        fetch('/upload',{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(d){
          document.getElementById('frame-log').textContent='frame-uploaded:'+d.count;
          up('posted:'+d.files.map(function(f){return f.filename+'@'+f.size}).join(','));
        }).catch(function(err){ up('post-error:'+err.message); });
      };
      // 内层帧的消息往上传，最终到顶层页面
      addEventListener('message',function(e){
        if(e.data&&(e.data.aicClick||e.data.aicUpload)&&parent!==window){ try{ parent.postMessage(e.data,'*'); }catch(err){} }
      });
    <\/script>`
  );
}

const HARD_FRAMES = `<!doctype html>
<meta charset="utf-8">
<title>跨帧寻址测试页</title>
<style>
  body { font: 14px/1.5 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  iframe { width: 320px; height: 84px; border: 1px solid #ccc; vertical-align: top; }
  .cell { display: inline-block; margin: 6px; }
</style>
<h1>跨帧寻址</h1>
<div id="report">无</div>
<div id="upload-report">无</div>
<div class="cell"><iframe id="dupA" src="__ALT__/frame?id=dup"></iframe></div>
<div class="cell"><iframe id="dupB" src="__ALT__/frame?id=dup"></iframe></div>
<div class="cell"><iframe id="nav" src="__ALT__/frame?id=nav-before"></iframe></div>
<div class="cell"><iframe id="sd" srcdoc="&lt;body style='margin:4px;font:13px sans-serif'&gt;&lt;button id='b'&gt;srcdoc 按钮&lt;/button&gt;&lt;script&gt;document.getElementById('b').onclick=function(){parent.postMessage({aicClick:'srcdoc'},'*')}&lt;/scr&#105;pt&gt;"></iframe></div>
<div class="cell"><iframe id="sbx" sandbox="allow-scripts" srcdoc="&lt;body style='margin:4px;font:13px sans-serif'&gt;&lt;button id='b'&gt;sandbox 按钮&lt;/button&gt;&lt;script&gt;document.getElementById('b').onclick=function(){parent.postMessage({aicClick:'sandbox'},'*')}&lt;/scr&#105;pt&gt;"></iframe></div>
<div class="cell"><iframe id="blank"></iframe></div>
<div class="cell" style="width:340px"><iframe id="deepx" src="__ALT__/frame?id=xouter&amp;nest=__SELF__/frame%3Fid%3Ddeep-inner" style="height:150px"></iframe></div>
<div class="cell" style="position:relative">
  <iframe id="covered" src="__ALT__/frame?id=covered"></iframe>
  <div id="cover" style="position:absolute;inset:0;background:rgba(255,0,0,.25)"></div>
</div>
<!-- sandbox 不带 allow-same-origin ⇒ 不透明源 ⇒ Chrome 把它放进独立进程（OOPIF）。
     真实站点上的第三方嵌入（YouTube / Stripe / reCAPTCHA）都是这个形态，
     而本地「换个端口」造出来的跨源帧**不是** —— 端口不同但仍是同一个 site，同进程。
     OOPIF 才是真正难啃的：CDP 的 Page.getFrameTree 看不见它，
     DOM.getNodeForLocation 也穿不进去（命中的是承载它的 <iframe> 元素本身）。 -->
<div class="cell" style="position:relative">
  <iframe id="oopif" sandbox="allow-scripts" src="__ALT__/frame?id=oopif"></iframe>
</div>
<!-- 收到文件就自己 POST 的 OOPIF：端到端断言不必依赖合成点击能不能打进跨进程帧 -->
<div class="cell"><iframe id="oopifpost" sandbox="allow-scripts" src="__ALT__/frame?id=oopif-post&amp;autopost=1"></iframe></div>
<!-- OOPIF 里再套一个 sandbox 帧：跨进程会话里还嵌着帧，
     只在最外层会话的主框架里找元素是找不到它的。上传要覆盖这条路。 -->
<div class="cell" style="width:340px;height:230px">
  <iframe id="oopif2" sandbox="allow-scripts"
    src="__ALT__/frame?id=oopif-outer&amp;nest=__SELF__/frame%3Fid%3Doopif-inner&amp;nestsbx=1"
    style="height:220px"></iframe>
</div>
<div class="cell" style="position:relative">
  <iframe id="coveredx" sandbox="allow-scripts" src="__ALT__/frame?id=coveredx"></iframe>
  <div id="coverx" style="position:absolute;inset:0;background:rgba(0,0,255,.25)"></div>
</div>
<div class="cell" style="width:340px;height:120px"><iframe id="rot" src="__ALT__/frame?id=rot" style="transform:rotate(12deg)"></iframe></div>
<div class="cell" style="width:340px;height:120px"><iframe id="scaled" src="__ALT__/frame?id=scaled" style="transform:scale(.5);transform-origin:top left"></iframe></div>
<iframe id="hiddenf" src="__ALT__/frame?id=hiddenf" style="display:none"></iframe>
<script>
const sources = [];
addEventListener('message', (e) => {
  // 帧内上传的回报（change 跑了 / 文件 POST 出去了）。OOPIF 的 contentDocument
  // 顶层读不到，只有这条消息通道能证明「文件真进了那个帧」
  if (e.data && e.data.aicUpload) {
    const u = document.getElementById('upload-report');
    u.textContent = u.textContent === '无' ? e.data.aicUpload : u.textContent + ',' + e.data.aicUpload;
    return;
  }
  if (!e.data || !e.data.aicClick) return;
  let who = e.data.aicClick;
  // 两个 dup 帧内容一模一样，报上来的 id 也一样，只能靠 window 引用认人
  if (who === 'dup') {
    who = e.source === document.getElementById('dupA').contentWindow ? 'dupA'
        : e.source === document.getElementById('dupB').contentWindow ? 'dupB'
        : 'dup-unknown';
  }
  const el = document.getElementById('report');
  el.textContent = el.textContent === '无' ? who : el.textContent + ',' + who;
});
window.aicReset = () => {
  document.getElementById('report').textContent = '无';
  document.getElementById('upload-report').textContent = '无';
  return 'reset';
};
for (const id of ['cover', 'coverx']) {
  document.getElementById(id).onclick = () => {
    const el = document.getElementById('report');
    el.textContent = el.textContent === '无' ? id : el.textContent + ',' + id;
  };
}
// about:blank 帧：内容由 JS 写进去，没有任何 URL 可供配对
{
  const d = document.getElementById('blank').contentDocument;
  d.body.style.cssText = 'margin:4px;font:13px sans-serif';
  const b = d.createElement('button');
  b.textContent = 'about:blank 按钮';
  b.onclick = () => parent.postMessage({ aicClick: 'blank' }, '*');
  d.body.appendChild(b);
}
// 加载完成后自己跳到另一个地址：此后 src 属性与实际地址永久对不上
document.getElementById('nav').onload = function () {
  if (this.dataset.done) return;
  this.dataset.done = '1';
  this.contentWindow.location.replace('__ALT__/frame?id=nav-after');
};
<\/script>
`;

const FORMS = `<!doctype html>
<meta charset="utf-8">
<title>表单大全</title>
<style>
  body { font: 14px/1.7 -apple-system, "PingFang SC", sans-serif; margin: 16px; max-width: 900px; }
  label { display: block; margin: 6px 0; }
  .row { display: flex; gap: 8px; align-items: center; }
  fieldset { margin: 10px 0; }
  #result { white-space: pre-wrap; background: #f6f6f6; padding: 8px; }
  .floating { position: relative; }
  .floating span { position: absolute; top: -8px; left: 6px; background: #fff; font-size: 11px; }
</style>
<h1>表单大全</h1>
<!-- browser_cdp 直发 Input.* 的靶子。放在 <form> 外面（免得点击顺带提交表单）、
     放在页面最上面（直发的坐标是视口坐标，靶子滚出视口就打不到）。
     计数器由页面自己记：断言要断「页面真的收到了事件」，不是断工具的返回值 -->
<p><button type="button" id="rawtarget" style="padding:8px 24px">直发点击靶子</button>
<span id="rawcount">0</span></p>
<script>
  document.getElementById("rawtarget").addEventListener("click", () => {
    const n = document.getElementById("rawcount");
    n.textContent = String(Number(n.textContent) + 1);
  });
</script>
<form id="f" action="/form-submit" method="post">
  <fieldset><legend>文本类</legend>
    <label>姓名 <input name="name" id="name"></label>
    <label>邮箱 <input type="email" name="email" id="email"></label>
    <label>密码 <input type="password" name="password" id="password" autocomplete="new-password"></label>
    <label>数字 <input type="number" name="qty" id="qty" min="1" max="99" step="1"></label>
    <label>电话 <input type="tel" name="tel" id="tel"></label>
    <label>网址 <input type="url" name="site" id="site"></label>
    <label>搜索 <input type="search" name="q" id="q"></label>
    <label>备注 <textarea name="memo" id="memo" rows="2"></textarea></label>
    <label>带 datalist <input name="fruit" id="fruit" list="fruits"></label>
    <datalist id="fruits"><option value="苹果"><option value="香蕉"></datalist>
    <div class="floating"><span>浮动标签</span><input name="floating" id="floating" placeholder=" "></div>
    <label>只读 <input name="ro" id="ro" value="改不动" readonly></label>
    <label>禁用 <input name="off" id="off" value="禁用的" disabled></label>
  </fieldset>

  <fieldset><legend>特殊输入</legend>
    <label>日期 <input type="date" name="date" id="date"></label>
    <label>时间 <input type="time" name="time" id="time"></label>
    <label>日期时间 <input type="datetime-local" name="dt" id="dt"></label>
    <label>月份 <input type="month" name="month" id="month"></label>
    <label>周 <input type="week" name="week" id="week"></label>
    <label>颜色 <input type="color" name="color" id="color" value="#000000"></label>
    <label>滑块 <input type="range" name="level" id="level" min="0" max="10" step="1" value="0"></label>
  </fieldset>

  <fieldset><legend>选择类</legend>
    <label>城市
      <select name="city" id="city">
        <option value="">请选择</option>
        <option value="bj">北京</option>
        <option value="sh">上海</option>
        <option value="gz" disabled>广州（暂不可选）</option>
      </select>
    </label>
    <label>分组下拉
      <select name="grouped" id="grouped">
        <optgroup label="华北"><option value="bj2">北京市</option></optgroup>
        <optgroup label="华东"><option value="sh2">上海市</option><option value="hz2">杭州市</option></optgroup>
      </select>
    </label>
    <label>多选
      <select name="tags" id="tags" multiple size="3">
        <option value="a">甲</option><option value="b">乙</option><option value="c">丙</option>
      </select>
    </label>
    <label class="row"><input type="checkbox" name="agree" id="agree" value="yes"> 同意条款</label>
    <label class="row"><input type="checkbox" name="news" id="news" value="on" checked> 订阅（默认已勾）</label>
    <fieldset><legend>套餐</legend>
      <label class="row"><input type="radio" name="plan" id="plan-free" value="free"> 免费版</label>
      <label class="row"><input type="radio" name="plan" id="plan-pro" value="pro"> 专业版</label>
    </fieldset>
    <label class="row"><span id="switch" role="switch" aria-checked="false" tabindex="0"
      onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked')==='true'?'false':'true');document.getElementById('switchVal').value=this.getAttribute('aria-checked')">开关（role=switch）</span></label>
    <input type="hidden" name="switchVal" id="switchVal" value="false">
  </fieldset>

  <fieldset><legend>富文本 / 影子 / 帧</legend>
    <label>可编辑区
      <div id="rich" contenteditable="true" style="border:1px solid #ccc;min-height:32px;padding:4px"></div>
    </label>
    <input type="hidden" name="rich" id="richVal">
    <!-- 裸 contenteditable（不写值）：HTML 允许，真实站点上很常见，而 read_page 的
         候选选择器以前只认 ="true"，于是这类编辑区一个都读不到。占位文字用
         data-placeholder（Quill / ProseMirror 一类编辑器的惯例），顺带钉住
         「可访问名为空时退回 data-placeholder」那条 -->
    <label>裸可编辑区
      <div id="bare" contenteditable data-placeholder="备注（裸 contenteditable）"
           style="border:1px solid #ccc;min-height:32px;padding:4px"></div>
    </label>
    <input type="hidden" name="bare" id="bareVal">
    <!-- 反面：contenteditable="false" 不该进元素表。它和上面那个只差一个属性值，
         收得太宽（比如按 el.isContentEditable 收）就会把它一起捞进来 -->
    <div id="noedit" contenteditable="false" style="border:1px dashed #ccc;padding:4px">这块不可编辑</div>
    <div id="sd-host"></div>
    <input type="hidden" name="shadow" id="shadowVal">
  </fieldset>

  <button type="submit" id="submit">提交表单</button>
</form>
<div id="result">未提交</div>
<script>
  // shadow DOM 里也放一个输入框：跨 shadow 边界填表是很常见的一类（设计系统组件）
  const host = document.getElementById("sd-host").attachShadow({ mode: "open" });
  host.innerHTML = '<label>影子里的输入框 <input id="shadow-input"></label>';
  host.getElementById("shadow-input").addEventListener("input", (e) => {
    document.getElementById("shadowVal").value = e.target.value;
  });
  document.getElementById("rich").addEventListener("input", (e) => {
    document.getElementById("richVal").value = e.target.textContent;
  });
  document.getElementById("bare").addEventListener("input", (e) => {
    document.getElementById("bareVal").value = e.target.textContent;
  });
  // 用 fetch 提交，好把服务端**真正收到的**东西显示出来
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const res = await fetch("/form-submit", { method: "POST", body: new URLSearchParams(fd) });
    document.getElementById("result").textContent = await res.text();
  });
</script>
`;

const ADOPT = `<!doctype html>
<meta charset="utf-8">
<title>能力采纳测试页</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  /* 纯 CSS 驱动的下拉：合成 mouseover 打不开它，只有真的移过去才行 */
  #menu-host { display: inline-block; position: relative; }
  #menu-panel { display: none; position: absolute; top: 24px; left: 0; background: #fff; border: 1px solid #333; padding: 8px; }
  #menu-host:hover #menu-panel { display: block; }
  .row { margin: 2px 0; }
</style>
<h1 id="adopt-title">能力采纳</h1>

<div id="shadow-host"></div>
<script>
  // 页面顶部就放一个 shadow root：窗口再矮也够得着，
  // 「CDP 能不能穿 shadow DOM」这条断言才不会被窗口高度左右
  const sh = document.getElementById("shadow-host").attachShadow({ mode: "open" });
  sh.innerHTML = '<button id="in-shadow">影子里的确认</button>';
</script>

<div id="menu-host"><span id="menu-trigger">更多操作</span>
  <div id="menu-panel"><button id="hidden-action">悬停才出现的删除</button></div>
</div>

<form id="f" onsubmit="return false">
  <input id="who" placeholder="姓名">
  <input id="tel" placeholder="手机号">
  <input id="card" placeholder="卡号" autocomplete="cc-number" value="4111111111111111">
  <input id="cvv" placeholder="安全码" autocomplete="cc-csc" value="321">
  <input id="pw" type="password" placeholder="密码" value="hunter2">
  <input id="addr" placeholder="地址" autocomplete="street-address" value="北京市朝阳区">
  <button id="submitBtn" type="button" onclick="document.getElementById('done').textContent='提交成功 ' + document.getElementById('who').value + '/' + document.getElementById('tel').value">提交表单</button>
</form>
<div id="done">未提交</div>

<button id="hitApi" onclick="fetch('/api/user').then(r=>r.json()).then(j=>{document.getElementById('apiOut').textContent=j.marker})">调接口</button>
<div id="apiOut">未调用</div>

<div id="rows"></div>
<button id="deep-target">深处的应用筛选</button>
<script>
  // 300 个可交互元素排在目标前面：read_page 默认上限 200，目标必然拿不到 ref
  const rows = document.getElementById("rows");
  for (let i = 0; i < 300; i++) {
    const b = document.createElement("button");
    b.className = "row";
    b.textContent = "列表行 " + i;
    rows.appendChild(b);
  }
</script>
`;

const MODALS_OOPIF = `<!doctype html>
<meta charset="utf-8">
<title>跨进程浮层测试页</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  button { font: inherit; padding: 5px 10px; }
  iframe { border: 0; }
  /* 铺满视口：真实的跨站同意平台就是拿一个满屏 iframe 盖住整页 */
  #consent { position: fixed; inset: 0; width: 100%; height: 100%; }
  #widget { position: fixed; right: 12px; bottom: 12px; width: 200px; height: 120px; }
  #veiled { position: absolute; left: 20px; top: 300px; width: 260px; height: 140px; }
  #veil { position: absolute; left: 20px; top: 300px; width: 260px; height: 140px; background: rgba(255,0,0,.25); }
  .pad { height: 900px; }
</style>
<h1 id="oopif-title">跨进程浮层</h1>
<div id="modal-log">未触发</div>
<button id="under">浮层底下的按钮</button>
<div class="pad"></div>

<iframe id="veiled" sandbox="allow-scripts" src="__ALT__/modal-oopif-frame?id=veiled"></iframe>
<div id="veil"></div>
<iframe id="widget" sandbox="allow-scripts" src="__ALT__/modal-oopif-frame?id=widget"></iframe>
<iframe id="consent" sandbox="allow-scripts" src="__ALT__/modal-oopif-frame?id=consent"></iframe>
<script>
// 帧是不透明源，读不到它的 contentDocument——断言只能靠它自己 postMessage 上来的这条。
// 这也正是「拿页面自己记下来的状态做断言」在跨进程场景下的唯一形态
addEventListener('message', function (e) {
  if (!e.data || !e.data.aicModal) return;
  var el = document.getElementById('modal-log');
  el.textContent = el.textContent === '未触发' ? e.data.aicModal : el.textContent + ',' + e.data.aicModal;
});
document.getElementById('under').onclick = function () {
  var el = document.getElementById('modal-log');
  el.textContent = el.textContent === '未触发' ? 'under-clicked' : el.textContent + ',under-clicked';
};
<\/script>
`;

function modalOopifFrame(id) {
  return (
    `<!doctype html><meta charset="utf-8"><title>oopif-${id}</title>` +
    `<style>html,body{margin:0;font:13px sans-serif}` +
    `#d{position:fixed;inset:0;background:#eef;padding:8px}</style>` +
    `<div id="d" role="dialog" aria-modal="true"><h2>跨进程的${
      id === "consent" ? "同意浮层" : id === "widget" ? "客服浮窗" : "遮住的浮层"
    }</h2>` +
    `<button id="ok">${id}-确认</button></div>` +
    `<script>
      document.getElementById('ok').onclick=function(){
        document.title='${id}-ok-clicked';
        try{ parent.postMessage({aicModal:'${id}-ok-clicked'},'*'); }catch(e){}
      };
    <\/script>`
  );
}

const MODALS = `<!doctype html>
<meta charset="utf-8">
<title>模态浮层测试页</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  button { font: inherit; padding: 5px 10px; margin: 3px 5px 3px 0; }
  /* 刻意不写 z-index：整条祖先链都靠 DOM 顺序堆叠。
     实测悉尼大学那个弹窗就是这样（容器 position:fixed 但 z-index:auto），
     任何靠 z-index 判模态的逻辑都会漏掉它 */
  #sheet-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; }
  #sheet-wrap.on { display: block; }
  /* 刻意**不给它 id**：真实站点的浮层壳子多半没有稳定 id（悉尼大学那个就没有），
     activeDialog.container 只能从 ARIA 属性推出来，那条分支才被测到 */
  .sheet { background: #fff; margin: 40px auto; padding: 16px; max-width: 420px; }
  #banner { position: fixed; left: 0; right: 0; bottom: 0; background: #ffe; border-top: 1px solid #cc9; padding: 6px 10px; }
  #banner.off { display: none; }
  /* 一直藏着的那个：不能被报出来 */
  #ghost { display: none; }
  .pad { height: 900px; background: linear-gradient(#fff,#eee); }
</style>
<h1 id="modals-title">模态浮层</h1>
<div id="modal-log">未触发</div>

<button id="open-sheet">打开满屏浮层</button>
<button id="open-native">打开原生 dialog</button>
<button id="open-shadow">打开影子里的浮层</button>
<button id="plain">什么都不开的普通按钮</button>
<button id="under-sheet">浮层底下的按钮</button>

<!-- ① cookie 横幅：一开始就在，role=dialog 但 aria-modal="false" -->
<div id="banner" role="dialog" aria-modal="false" aria-label="Cookie 偏好">
  <span>我们使用 Cookie。</span>
  <button id="banner-ok">同意</button>
  <button id="banner-close">关闭横幅</button>
</div>

<!-- ② 满屏浮层。role=dialog + aria-modal=true，标题在 <h2> 里（不是 aria-label），
     这样才能验证「标题取的是标题，不是整段正文糊成一团」 -->
<div id="sheet-wrap"><div class="sheet" role="dialog" aria-modal="true">
  <h2>请选择你的偏好</h2>
  <p>这一段是浮层正文，故意排在标题后面，好证明标题不是拿 innerText 前几十字凑的。</p>
  <button id="sheet-a">本地学生</button>
  <button id="sheet-b">国际学生</button>
  <button id="sheet-c">2026 年入学</button>
  <button id="sheet-d">2027 年入学</button>
  <button id="sheet-ok">确认偏好</button>
  <button id="sheet-cancel">取消</button>
</div></div>

<!-- ③ 原生 dialog：showModal() 开的，:modal 认得出来 -->
<dialog id="native"><h3>原生对话框</h3><button id="native-ok">原生确认</button><button id="native-close">关掉</button></dialog>

<!-- ④ shadow DOM 里的浮层 -->
<div id="shadow-modal-host"></div>

<!-- ⑤ 永远藏着的浮层壳子 -->
<div id="ghost" role="dialog" aria-modal="true" aria-label="不该被看见的浮层"><button id="ghost-btn">幽灵按钮</button></div>

<!-- ⑥ iframe 里的浮层：cookie 同意平台、支付确认、客服窗口十有八九都是这形态。
     判定必须逐帧跑（read_page 本来就是 inAllFrames），ref 要带 @fN。
     它盖满自己那个小帧，所以 coverage 是 100——正因如此，跨帧排序里
     **顶层帧要优先**，不然一个 300×160 的帧就能盖过真正拦住整页的那个 -->
<iframe id="dlgframe" src="/modal-frame" style="width:320px;height:160px;border:1px dashed #99f"></iframe>

<div class="pad">这一大块只为让页面可以滚动，好验证浮层打开时整页滚动被锁住</div>

<script>
const mlog = (s) => { document.getElementById('modal-log').textContent = s; };
for (const id of ['plain','under-sheet','banner-ok','sheet-a','sheet-b','sheet-c','sheet-d','ghost-btn']) {
  document.getElementById(id).onclick = () => mlog(id + '-clicked');
}
document.getElementById('banner-close').onclick = () => {
  document.getElementById('banner').classList.add('off');
  mlog('banner-closed');
};
// 打开浮层顺手把整页滚动锁住——真实站点几乎都这么做，也是「模态开着」的通用旁证
document.getElementById('open-sheet').onclick = () => {
  document.getElementById('sheet-wrap').classList.add('on');
  document.body.style.position = 'fixed';
  document.body.style.overflow = 'hidden';
  mlog('sheet-opened');
};
const closeSheet = (why) => {
  document.getElementById('sheet-wrap').classList.remove('on');
  document.body.style.position = '';
  document.body.style.overflow = '';
  mlog(why);
};
document.getElementById('sheet-ok').onclick = () => closeSheet('sheet-confirmed');
document.getElementById('sheet-cancel').onclick = () => closeSheet('sheet-cancelled');

const nat = document.getElementById('native');
document.getElementById('open-native').onclick = () => { nat.showModal(); mlog('native-opened'); };
document.getElementById('native-ok').onclick = () => mlog('native-ok-clicked');
document.getElementById('native-close').onclick = () => { nat.close(); mlog('native-closed'); };

// shadow root 里的浮层：判定要穿得进去，但 container 选择器进不去
const smRoot = document.getElementById('shadow-modal-host').attachShadow({ mode: 'open' });
smRoot.innerHTML =
  '<div id="sm" role="dialog" aria-modal="true" style="display:none;position:fixed;inset:0;background:#fff">' +
  '<h2>影子里的浮层</h2><button id="sm-ok">影子里的确认</button></div>';
smRoot.getElementById('sm-ok').onclick = () => mlog('shadow-modal-ok-clicked');
document.getElementById('open-shadow').onclick = () => {
  smRoot.getElementById('sm').style.display = 'block';
  mlog('shadow-modal-opened');
};
<\/script>
`;

const KEYS_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>按键目标测试页</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  input { display: block; margin: 8px 0; width: 260px; padding: 4px; }
</style>
<h1 id="keys-title">按键落到了谁身上</h1>
<input id="k1" type="text" aria-label="第一个按键靶子">
<input id="k2" type="text" aria-label="第二个按键靶子">
<div id="keylog">空</div>
<script>
window.__keys = [];
// 捕获阶段挂在 document 上：输入框自己把事件吃掉也照样记得到；焦点在 body 上时
// target 就是 BODY，正好把「键打歪了」这件事记成一条可断言的证据
document.addEventListener('keydown', function (e) {
  var t = e.target || document.body;
  var tag = String(t.tagName || '').toUpperCase();
  window.__keys.push(tag + (t.id ? '#' + t.id : '') + ':' + e.key);
  document.getElementById('keylog').textContent = window.__keys.join(' | ');
}, true);
window.__keysReset = function () {
  window.__keys = [];
  document.getElementById('k1').value = '';
  document.getElementById('k2').value = '';
  document.getElementById('keylog').textContent = '空';
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  return true;
};
<\/script>
`;

const SPAWN = `<!doctype html>
<meta charset="utf-8">
<title>新页接管测试页</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  a, button { display: block; margin: 10px 0; font-size: 15px; }
</style>
<h1 id="spawn-title">页面自开的新页</h1>
<a id="a-blank" href="/spawn-child?via=blank" target="_blank">target=_blank 链接</a>
<a id="a-noopener" href="/spawn-child?via=noopener" target="_blank" rel="noopener">target=_blank rel=noopener 链接</a>
<button id="b-open" onclick="window.open('/spawn-child?via=open')">window.open(url)</button>
<button id="b-popup" onclick="window.open('/spawn-child?via=popup', '_blank', 'width=400,height=300')">window.open 独立小窗</button>
<button id="b-delayed" onclick="setTimeout(function(){ window.open('/spawn-child?via=delayed'); }, 300)">延迟 300ms 后 window.open</button>
<!-- 表单的 target=_blank：又一种「页面自开新页」的入口，和链接/window.open 走的不是同一条 JS 路 -->
<form id="f-blank" action="/spawn-child" method="get" target="_blank">
  <input type="hidden" name="via" value="form">
  <button id="b-form">表单 target=_blank 提交</button>
</form>
<!-- 中键 / Cmd+左键专用的两条链接。这条路上浏览器不发 Page.windowOpen、也不设 opener，
     认领只能靠 browser_click 自己记的那笔意图 -->
<a id="a-mid" href="/spawn-child?via=mid" target="_blank">中键点它</a>
<a id="a-cmd" href="/spawn-child?via=cmd" target="_blank">Cmd+左键点它</a>
`;

const SPAWN_CHILD = (via) => `<!doctype html>
<meta charset="utf-8">
<title>子页 ${via}</title>
<body>
<h1 id="child-title">我是子页</h1>
<p id="child-via">${via}</p>
<input id="child-input" aria-label="子页输入框">
<script>
// 接管遮蔽（光晕宿主 + 输入护盾）是不是**在这一页出生的第一时间**就装上了，
// 只有页面自己记得——事后拿 browser_eval 去问，那次调用本身就会把它装上，
// 断言等于自证。所以这里由页面自己盯着，把第一次看见宿主的时刻记下来。
window.__aicHostSeenAt = null;
(function () {
  var t0 = performance.now();
  var iv = setInterval(function () {
    if (document.getElementById('__aic_cursor__')) {
      window.__aicHostSeenAt = performance.now() - t0;
      clearInterval(iv);
    } else if (performance.now() - t0 > 20000) {
      clearInterval(iv);
    }
  }, 20);
})();
<\/script>
`;

const ERGO = `<!doctype html>
<meta charset="utf-8">
<title>交互人体工学测试页</title>
<style>
  html { scroll-behavior: smooth; }   /* 关键：整页平滑滚动 */
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 16px; }
  .pad { height: 1600px; background: linear-gradient(#fff, #eee); }
  .cage { width: 260px; height: 60px; border: 2px solid #999; margin: 8px 0; }
  #clipcage { overflow: clip; }
  #scrollcage { overflow: auto; }
  #virtcage { overflow: hidden; position: relative; }
  #virtinner { position: absolute; top: 0; left: 0; }
  .inpad { height: 400px; }
  #drawer { position: fixed; left: -600px; top: 200px; }
</style>
<h1 id="ergo-title">交互人体工学</h1>
<div id="log">未触发</div>
<div id="grow">短</div>
<button id="more">See more</button>
<button id="racer">开始长距离平滑滚动</button>
<button id="addlate">3 秒后追加一个按钮</button>
<button id="addfirst">往最前面插一个按钮</button>
<div id="late-slot"></div>

<div class="cage" id="clipcage"><div class="inpad">裁剪容器的垫片</div><button id="btn-clip">被裁掉的按钮</button></div>
<div class="cage" id="scrollcage"><div class="inpad">滚动容器的垫片</div><button id="btn-scroll">容器里的按钮</button></div>
<div class="cage" id="virtcage"><div id="virtinner"><div class="inpad">虚拟滚动的垫片</div><button id="btn-virt">虚拟滚动里的按钮</button></div></div>
<button id="drawer">抽屉里的按钮</button>

<div class="pad">这一大块只为把下面的按钮挤出视口</div>
<button id="btn-deep">平滑滚动页面深处的按钮</button>
<div class="pad">再来一块</div>
<button id="btn-deeper">更深处的按钮</button>

<script>
const mark = (s) => { document.getElementById('log').textContent = s; };
for (const id of ['btn-clip','btn-scroll','btn-virt','drawer','btn-deep','btn-deeper']) {
  document.getElementById(id).onclick = () => mark(id + '-clicked');
}
document.getElementById('racer').onclick = () => {
  scrollTo(0, 0);
  // 先回到顶部再往下滚一大段，制造一段持续数百毫秒的平滑滚动
  setTimeout(() => scrollTo(0, 4000), 30);
  mark('racer-started');
};
// 文案会变的按钮：selector/文本/URL 三条都等不住「文案从 A 变成 B」
document.getElementById('more').onclick = function () {
  if (this.textContent === 'See more') {
    document.getElementById('grow').textContent = '展开后的长正文。'.repeat(90);
    this.textContent = 'See less';
  } else {
    document.getElementById('grow').textContent = '短';
    this.textContent = 'See more';
  }
};
document.getElementById('addlate').onclick = () => {
  setTimeout(() => {
    const b = document.createElement('button');
    b.id = 'late-btn';
    b.textContent = '迟到的按钮';
    b.onclick = () => mark('late-clicked');
    document.getElementById('late-slot').appendChild(b);
  }, 1500);
  mark('late-scheduled');
};
document.getElementById('addfirst').onclick = () => {
  if (document.getElementById('intruder')) return;
  const b = document.createElement('button');
  b.id = 'intruder';
  b.textContent = '插队的按钮';
  b.onclick = () => mark('intruder-clicked');
  document.body.insertBefore(b, document.body.firstChild);
  mark('intruder-added');
};
window.aicReset = () => {
  mark('未触发');
  document.documentElement.style.scrollBehavior = 'auto';
  scrollTo(0, 0);
  document.getElementById('scrollcage').scrollTop = 0;
  document.documentElement.style.scrollBehavior = '';
  // 折叠区块也复位：它是个 toggle，状态一旦被前面某一步搞乱，
  // 后面等文案变化的用例就会莫名超时，报错指向的地方跟真正的病灶差着十万八千里
  document.getElementById('more').textContent = 'See more';
  document.getElementById('grow').textContent = '短';
  return 'reset';
};
// 造一段指定长度的字符串，用来量「eval 返回值到底在哪一档被截断」
window.aicBigString = (n) => '零一二三四五六七八九'.repeat(Math.ceil(n / 10)).slice(0, n);
<\/script>
`;

function heavyPage(n, depth) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      `<div class="r"><span class="t">条目 ${i}</span>` +
        `<a href="/api/user?i=${i}">链接 ${i}</a>` +
        `<button class="b">按钮 ${i}</button>` +
        `<input type="text" value="v${i}" aria-label="输入 ${i}">` +
        `<span class="x">${"文本填充 ".repeat(3)}${i}</span></div>`
    );
  }
  const hidden = [];
  for (let i = 0; i < Math.floor(n / 2); i++) {
    hidden.push(`<div><button>隐藏按钮 ${i}</button><a href="#h${i}">隐藏链接 ${i}</a><span>隐藏文本 ${i}</span></div>`);
  }
  let nest = `<button id="deep-btn">最深处的按钮</button>`;
  for (let i = 0; i < depth; i++) nest = `<div class="d${i}">${nest}</div>`;
  return (
    `<!doctype html><meta charset="utf-8"><title>重页面 ${n}</title>` +
    `<style>body{font:13px sans-serif;margin:8px}.r{padding:2px}.hid{display:none}</style>` +
    `<h1>重页面</h1><div id="rows">${rows.join("")}</div>` +
    `<div class="hid" id="hidden-block">${hidden.join("")}</div>` +
    `<div id="nest">${nest}</div>` +
    `<script>document.getElementById('deep-btn').onclick=function(){document.title='deep-clicked'}<\/script>`
  );
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>agent-in-chrome 测试台</title>
<style>
  body { font: 15px/1.6 -apple-system, "PingFang SC", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; }
  button { font: inherit; padding: 6px 12px; margin: 4px 6px 4px 0; }
  #log { background: #f4f4f5; padding: 10px; border-radius: 6px; min-height: 60px; white-space: pre-wrap; }
  .box { border: 1px solid #ddd; border-radius: 8px; padding: 14px; margin: 14px 0; }
</style>
<h1 id="title">测试台</h1>
<p id="intro">这个页面只为端到端测试存在，所有行为都是确定的。</p>

<div class="box">
  <h2>接口</h2>
  <button id="btn-get">GET 用户</button>
  <button id="btn-post">POST 订单</button>
  <button id="btn-slow">慢接口 (1.2s)</button>
  <button id="btn-500">失败接口 (500)</button>
</div>

<div class="box">
  <h2>表单</h2>
  <label>关键词 <input id="kw" type="text" placeholder="输入关键词"></label>
  <label><input id="agree" type="checkbox"> 我同意</label>
  <button id="btn-submit">提交搜索</button>
  <div id="result">尚未搜索</div>
</div>

<div class="box">
  <h2>WebSocket</h2>
  <button id="btn-ws-connect">连接</button>
  <button id="btn-ws-send">发一条消息</button>
  <button id="btn-ws-close">断开</button>
  <div id="ws-state">未连接</div>
</div>

<div class="box">
  <h2>控制台</h2>
  <button id="btn-log">打一条 log</button>
  <button id="btn-error">抛一个异常</button>
</div>

<div class="box">
  <h2>对话框</h2>
  <button id="btn-alert">弹 alert</button>
  <button id="btn-confirm">confirm 后删除</button>
  <button id="btn-prompt">prompt 取名</button>
  <span id="confirm-result"></span>
</div>

<div class="box">
  <h2>难啃的结构</h2>
  <p>下面这些是判断「能不能真做测试」的分水岭。</p>
  <iframe id="frame" src="/frame?id=frame1&amp;nest=/frame%3Fid%3Dframe1-inner" style="width:100%;height:190px;border:1px dashed #bbb"></iframe>
  <iframe id="xframe" src="__ALT__/frame?id=xframe&amp;autopost=1" style="width:100%;height:90px;border:1px dashed #f90"></iframe>
  <div id="host"></div>
  <div id="host-nested"></div>
  <div id="host-closed"></div>
  <!-- aria-disabled="true" 的输入框：ARIA 只是给辅助技术看的提示，元素本身照样收输入。
       可操作性检查会（正确地）拦下它，而这正是 force:true 存在的意义——
       用它验证 browser_type 的 force 是真能强行下发并且**文字真的落进去**，
       不是只对 click 有效。 -->
  <input id="force-input" aria-disabled="true" placeholder="伪禁用输入框">
  <div id="force-log">未输入</div>
  <div style="position:relative;display:inline-block">
    <button id="btn-covered">被遮住的按钮</button>
    <div id="overlay" style="position:absolute;inset:0;background:rgba(255,0,0,.25)"></div>
  </div>
  <button id="btn-disabled" disabled>禁用的按钮</button>
  <button id="btn-aria" aria-disabled="true">aria 禁用的按钮</button>
  <button id="btn-pe" style="pointer-events:none">穿透的按钮</button>
  <span style="position:relative;display:inline-block">
    <button id="btn-dyn">会被动态遮罩盖住的按钮</button>
  </span>
  <button id="btn-hide-me">会被藏起来的按钮</button>
  <input id="file" type="file">
  <div id="hard-log">未触发</div>
  <div id="frame-report">无</div>
  <div id="frame-upload-report">无</div>
</div>

<div class="box">
  <h2>要滚动才看得见</h2>
  <div style="height:1800px;background:linear-gradient(#fff,#eee)">中间这一大块只为把下面那个按钮挤出视口</div>
  <button id="btn-far">滚动后才可见的按钮</button>
</div>

<div class="box">
  <h2>文件上传</h2>
  <p>上面那个 #file 是单选的。这里补齐多选、隐藏、以及真正发出去的一条链路。</p>
  <label>多选 <input id="file-multi" type="file" multiple></label>
  <div id="multi-log">未选择</div>
  <!-- 真实站点最常见的形态：input 藏起来，露在外面的是个好看的按钮。
       按坐标点它没用（弹出的是系统文件框），只能靠 setFileInputFiles。 -->
  <input id="file-hidden" type="file" style="display:none">
  <button id="btn-pick">选择文件…（外观按钮，点了会弹系统框）</button>
  <div id="hidden-log">未选择</div>
  <input id="file-disabled" type="file" disabled>
  <!-- 把第一次 change 吞掉的输入框：真实站点上有页面在捕获阶段 stopImmediatePropagation。
       这时 Chrome 原生派发的 change 我们收不到（changeFired=false），工具必须补发一次，
       否则「文件放进去了但页面不知道」——最难查的一类故障。
       第二次就放行，好让测试能断言「补发之后页面处理函数真的跑了」。 -->
  <input id="file-swallow" type="file">
  <div id="swallow-log">未选择</div>
  <div id="shadow-file-log">未选择</div>
  <button id="btn-upload">上传到服务端</button>
  <div id="upload-log">未上传</div>
</div>

<!-- 会真的跳转的链接。点击校验必须能分清「点中了、然后页面跳走了」和「点歪了」——
     这两件事在「事后再量一次几何」的验法里长得一模一样（目标都不在原地了）。 -->
<div class="box">
  <h2>跳转链接</h2>
  <a id="go-forms" href="/forms">去表单页</a>
</div>

<!-- 操作光标的靶子。要求：一整块纯色、不含文字、不动、尺寸固定。
     截图断言靠「同一块区域截两张、逐字节比」来判断光标有没有进图，
     区域里但凡有一点非确定性（动画、字体回退、光标闪烁）这条断言就会自己红。 -->
<div class="box">
  <!-- 标题带 id：ref 元素截图的断言要按 find 拿到它、再改它的样式，
       从而验证「滚动之后 ref 截的确实是那个元素」 -->
  <h2 id="cursor-pad-title">光标靶</h2>
  <div id="cursor-pad" style="width:240px;height:140px;background:#dcdcdc"></div>
</div>

<div id="log">就绪</div>

<script>
const log = (s) => { document.getElementById('log').textContent = s; };
document.getElementById('btn-get').onclick = () =>
  fetch('/api/user').then(r => r.json()).then(d => log('GET → ' + JSON.stringify(d)));
document.getElementById('btn-post').onclick = () =>
  fetch('/api/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-token': 'tok_secret_value_12345' },
    body: JSON.stringify({ sku: 'A-1', qty: 3 }),
  }).then(r => r.json()).then(d => log('POST → ' + JSON.stringify(d)));
document.getElementById('btn-slow').onclick = () =>
  fetch('/api/slow').then(r => r.json()).then(d => log('慢接口 → ' + JSON.stringify(d)));
document.getElementById('btn-500').onclick = () =>
  fetch('/api/boom').then(r => log('失败接口 → HTTP ' + r.status));

document.getElementById('btn-submit').onclick = () => {
  const kw = document.getElementById('kw').value;
  document.getElementById('result').textContent = '搜索结果：' + kw;
};

let ws = null;
document.getElementById('btn-ws-connect').onclick = () => {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => { document.getElementById('ws-state').textContent = '已连接'; };
  ws.onmessage = (e) => { document.getElementById('ws-state').textContent = '收到：' + e.data; };
  ws.onclose = () => { document.getElementById('ws-state').textContent = '已断开'; };
};
document.getElementById('btn-ws-send').onclick = () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ hello: '来自测试页', n: 42 }));
};
document.getElementById('btn-ws-close').onclick = () => ws && ws.close();

const hard = (s) => { document.getElementById('hard-log').textContent = s; };

// Shadow DOM 里的按钮：普通 querySelectorAll 穿不进去
const host = document.getElementById('host');
const root = host.attachShadow({ mode: 'open' });
// shadow 里既放按钮（测穿透）也放 file input（web component 做的上传控件就是这形态）
root.innerHTML = '<button id="shadow-btn">影子按钮</button><input id="shadow-file" type="file">';
root.getElementById('shadow-btn').onclick = () => hard('shadow-clicked');
root.getElementById('shadow-file').onchange = (e) => {
  document.getElementById('shadow-file-log').textContent = 'shadow-file:' + (e.target.files[0]?.name || '');
};

// closed shadow root：host.shadowRoot 是 null，页面自己的脚本都拿不到。
// 只有扩展的 chrome.dom.openOrClosedShadowRoot 看得见——这条路以前只有 mock 覆盖过。
const hostC = document.getElementById('host-closed');
const rootC = hostC.attachShadow({ mode: 'closed' });
rootC.innerHTML = '<button id="closed-btn">封闭影子按钮</button>';
rootC.getElementById('closed-btn').onclick = () => hard('closed-shadow-clicked');
window.aicClosedShadowIsClosed = () => hostC.shadowRoot === null;

document.getElementById('force-input').oninput = (e) => {
  document.getElementById('force-log').textContent = 'force-input:' + e.target.value;
};

// 嵌套 shadow root：shadow 里再挂一个 shadow，递归穿不到底就找不到它
const hostN = document.getElementById('host-nested');
const rootN = hostN.attachShadow({ mode: 'open' });
const midHost = document.createElement('div');
rootN.appendChild(midHost);
const rootN2 = midHost.attachShadow({ mode: 'open' });
rootN2.innerHTML = '<button id="deep-btn">深层影子按钮</button>';
rootN2.getElementById('deep-btn').onclick = () => hard('deep-shadow-clicked');

document.getElementById('btn-covered').onclick = () => hard('covered-clicked');
document.getElementById('overlay').onclick = () => hard('overlay-clicked');
document.getElementById('btn-disabled').onclick = () => hard('disabled-clicked');
document.getElementById('btn-aria').onclick = () => hard('aria-clicked');
document.getElementById('btn-pe').onclick = () => hard('pe-clicked');
document.getElementById('btn-dyn').onclick = () => hard('dyn-clicked');
document.getElementById('btn-hide-me').onclick = () => hard('hidden-clicked');
document.getElementById('btn-far').onclick = () => hard('far-clicked');
document.getElementById('file').onchange = (e) => {
  hard('file:' + (e.target.files[0]?.name || ''));
};

// 测试用的钩子：读页面之后再改页面，模拟「拿到 ref 之后页面变了」
window.aicReset = () => {
  hard('未触发');
  document.getElementById('frame-report').textContent = '无';
  document.getElementById('frame-upload-report').textContent = '无';
  const o = document.getElementById('dyn-overlay');
  if (o) o.remove();
  document.getElementById('btn-hide-me').style.display = '';
  return 'reset';
};
window.aicAddOverlay = () => {
  const btn = document.getElementById('btn-dyn');
  if (document.getElementById('dyn-overlay')) return 'exists';
  const o = document.createElement('div');
  o.id = 'dyn-overlay';
  o.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,255,.2)';
  o.onclick = () => hard('dyn-overlay-clicked');
  btn.parentNode.appendChild(o);
  return 'added';
};
window.aicResetForceInput = () => {
  document.getElementById('force-input').value = '';
  document.getElementById('force-log').textContent = '未输入';
  return 'reset';
};
window.aicHideBtn = () => {
  document.getElementById('btn-hide-me').style.display = 'none';
  return 'hidden';
};

document.getElementById('file-multi').onchange = (e) => {
  document.getElementById('multi-log').textContent =
    'multi:' + e.target.files.length + ':' + [...e.target.files].map(f => f.name).join(',');
};
{
  let swallowed = false;
  const sw = document.getElementById('file-swallow');
  sw.addEventListener('change', (e) => {
    if (!swallowed) { swallowed = true; e.stopImmediatePropagation(); }
  }, true);
  sw.addEventListener('change', (e) => {
    document.getElementById('swallow-log').textContent = 'swallow:' + (e.target.files[0]?.name || '');
  });
}
document.getElementById('file-hidden').onchange = (e) => {
  document.getElementById('hidden-log').textContent = 'hidden:' + (e.target.files[0]?.name || '');
};
// 外观按钮：点它等于 input.click()，浏览器会弹出系统文件选择框。
// 测试里断言「不要走这条路」，工具应该直接设置 input。
document.getElementById('btn-pick').onclick = () => document.getElementById('file-hidden').click();

// 真正把选中的文件发出去，用于验证「字节确实到了服务端」
document.getElementById('btn-upload').onclick = () => {
  const fd = new FormData();
  const one = document.getElementById('file').files[0];
  if (one) fd.append('single', one, one.name);
  for (const f of document.getElementById('file-multi').files) fd.append('many', f, f.name);
  const h = document.getElementById('file-hidden').files[0];
  if (h) fd.append('hidden', h, h.name);
  document.getElementById('upload-log').textContent = '上传中…';
  fetch('/upload', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(d => {
      document.getElementById('upload-log').textContent =
        'uploaded:' + d.count + ':' + d.files.map(f => f.filename + '@' + f.size).join(',');
    })
    .catch(e => { document.getElementById('upload-log').textContent = 'upload-error:' + e.message; });
};

// 各层 iframe 的点击一路冒泡到这里，跨源帧也走这条路
addEventListener('message', (e) => {
  const v = e.data && (e.data.aicClick || e.data.aicUpload);
  if (!v) return;
  // 上传相关的消息单独记一格：跨源 iframe 的 contentDocument 从顶层读不到，
  // 「帧内 change 真的跑了 / 帧内真把文件 POST 出去了」只能靠这条通道断言
  const id = e.data.aicUpload ? 'frame-upload-report' : 'frame-report';
  const el = document.getElementById(id);
  el.textContent = el.textContent === '无' ? v : el.textContent + ',' + v;
});

document.getElementById('btn-log').onclick = () => console.log('测试日志 marker-abc');
document.getElementById('btn-error').onclick = () => { throw new Error('测试异常 marker-boom'); };
document.getElementById('btn-alert').onclick = () => { alert('这是一个 alert'); };
// confirm 的取消/接受要能从页面状态看出来：审计 6.1 的核心场景就是
// 「confirm 被静默取消而 click 报成功」——结果元素让测试能验「到底删没删」
document.getElementById('btn-confirm').onclick = () => {
  document.getElementById('confirm-result').textContent = confirm('确定删除吗') ? '已删除' : '没删';
};
document.getElementById('btn-prompt').onclick = () => {
  const name = prompt('取个名字', '默认名');
  document.getElementById('confirm-result').textContent = name === null ? '取消了' : '名字:' + name;
};
</script>
`;

function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`);
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const start = idx + delim.length;
    if (buf.subarray(start, start + 2).toString("latin1") === "--") break;
    const headerEnd = buf.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const headers = buf.subarray(start + 2, headerEnd).toString("utf8");
    const next = buf.indexOf(delim, headerEnd);
    if (next === -1) break;
    parts.push({ headers, body: Buffer.from(buf.subarray(headerEnd + 4, next - 2)) });
    idx = next;
  }
  return parts;
}

let lastUpload = null;
const AUTH_SESSIONS = new Map();

let ALT_BASE = "";
let SELF_BASE = "";

const handler = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (obj, code = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE.replace(/__ALT__/g, ALT_BASE));
  }
  if (url.pathname === "/emulate") {
    const meta = url.searchParams.get("nometa") ? "" : `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><meta charset="utf-8">${meta}<title>仿真验证页</title>` +
        `<style>body{margin:0;font:14px sans-serif;background:#ffffff;color:#111111}` +
        `@media (prefers-color-scheme: dark){body{background:#101010;color:#eeeeee}}` +
        `@media (max-width: 600px){#bp{outline:2px solid red}}</style>` +
        `<h1 id="t">仿真验证页</h1><div id="bp">断点靶子</div><pre id="log"></pre>` +
        `<script>
window.__emuProbe = function () {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    bg: getComputedStyle(document.body).backgroundColor,
    narrow: matchMedia('(max-width: 600px)').matches,
    hasViewportMeta: !!document.querySelector('meta[name=viewport]')
  };
};
window.__emuGeo = function () {
  return new Promise(function (r) {
    if (!navigator.geolocation) return r({ ok: false, msg: 'no geolocation api' });
    navigator.geolocation.getCurrentPosition(
      function (p) { r({ ok: true, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); },
      function (e) { r({ ok: false, code: e.code, msg: e.message }); },
      { timeout: 8000, maximumAge: 0 }
    );
  });
};
window.__emuPermission = function () {
  return navigator.permissions.query({ name: 'geolocation' }).then(function (p) { return p.state; }).catch(function () { return 'error'; });
};
window.__emuFetch = function (bytes) {
  var t = Date.now();
  return fetch('/big?n=' + bytes).then(function (r) { return r.text(); }).then(function (s) { return { bytes: s.length, ms: Date.now() - t }; })
    .catch(function (e) { return { error: String(e) }; });
};
<\/script>`
    );
  }
  if (url.pathname === "/frames-hard") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(HARD_FRAMES.replace(/__ALT__/g, ALT_BASE).replace(/__SELF__/g, SELF_BASE));
  }
  if (url.pathname === "/forms") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(FORMS);
  }
  if (url.pathname === "/form-submits") {
    const out = FORM_SUBMITS.slice();
    if (url.searchParams.get("clear") === "1") FORM_SUBMITS.length = 0;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ count: out.length, submits: out }));
  }
  if (url.pathname === "/form-submit" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const got = {};
    for (const [k, v] of new URLSearchParams(body)) {
      if (k in got) got[k] = [].concat(got[k], v);
      else got[k] = v;
    }
    FORM_SUBMITS.push({
      at: new Date().toISOString(),
      ua: req.headers["user-agent"] || null,
      referer: req.headers["referer"] || null,
      origin: req.headers["origin"] || null,
      contentType: req.headers["content-type"] || null,
      remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
      rawBody: body,
      rawBytes: Buffer.byteLength(body),
      fieldCount: Object.keys(got).length,
      received: got,
    });
    if (FORM_SUBMITS.length > 50) FORM_SUBMITS.shift();
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "e2e_raw_hdr=1; Path=/; SameSite=Lax",
    });
    return res.end(JSON.stringify({ ok: true, received: got, marker: "form-submit-marker" }));
  }
  if (url.pathname === "/adopt") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(ADOPT);
  }
  if (url.pathname === "/spawn") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(SPAWN);
  }
  if (url.pathname === "/spawn-child") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(SPAWN_CHILD(url.searchParams.get("via") || "?"));
  }
  if (url.pathname === "/trusted-types") {
    const names = !!url.searchParams.get("names");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "require-trusted-types-for 'script'" + (names ? "; trusted-types page-policy" : ""),
    });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>Trusted Types 页</title>` +
        `<h1 id="t">Trusted Types 页</h1><pre id="log"></pre>` +
        `<script>
// 断言这一页真的在强制执行。没有这两笔的话，哪天 Chrome 改了行为、CSP 头写错了、
// 或者夹具被人顺手改坏，遮蔽测试会静静地变成一条什么都没测的绿线。
window.__ttEnforced = (function () {
  try { document.createElement('div').innerHTML = '<b>x</b>'; return false; } catch (e) { return true; }
})();
// 策略路通不通（?names=1 的那一页应当是 false：连 'default' 都建不出来）
window.__ttPolicyOk = (function () {
  try { window.trustedTypes.createPolicy('default', { createHTML: function (s) { return s; } }); return true; }
  catch (e) { return false; }
})();
document.getElementById('log').textContent = 'enforced=' + window.__ttEnforced + ' policyOk=' + window.__ttPolicyOk;
</script>`,
    );
  }
  if (url.pathname === "/ergo") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(ERGO);
  }
  if (url.pathname === "/keys") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(KEYS_PAGE);
  }
  if (url.pathname === "/modals") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(MODALS);
  }
  if (url.pathname === "/modals-oopif") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(MODALS_OOPIF.replace(/__ALT__/g, ALT_BASE));
  }
  if (url.pathname === "/modal-oopif-frame") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(modalOopifFrame(url.searchParams.get("id") || "consent"));
  }
  if (url.pathname === "/modal-frame") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>帧内浮层</title>` +
        `<style>html,body{margin:0;font:13px sans-serif}` +
        `#fd{position:fixed;inset:0;background:#eef;padding:8px}</style>` +
        `<div id="fd" role="dialog" aria-modal="true"><h2>帧内的浮层</h2>` +
        `<button id="fd-ok">帧内确认</button><button id="fd-close">帧内关掉</button></div>` +
        `<script>document.getElementById('fd-ok').onclick=function(){document.title='frame-dialog-ok'};` +
        `document.getElementById('fd-close').onclick=function(){document.getElementById('fd').style.display='none';document.title='frame-dialog-closed'}<\/script>`
    );
  }
  if (url.pathname === "/big") {
    const n = Math.min(Number(url.searchParams.get("n") || 1000), 40_000_000);
    const body = "0123456789".repeat(Math.ceil(n / 10)).slice(0, n);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
    return res.end(body);
  }
  if (url.pathname === "/text-pager" || url.pathname === "/text-pager-frame") {
    const inFrame = url.pathname === "/text-pager-frame";
    const seed = inFrame ? 97 : 65;
    const mark = (url.searchParams.get("mark") || "").replace(/[^A-Za-z]/g, "").slice(0, 20);
    const n = Math.min(Number(url.searchParams.get("n") || 3000), 200_000);
    let body = mark;
    for (let i = 0; body.length < n; i++) {
      body += String.fromCharCode(seed + (i % 20)).repeat(10);
    }
    body = body.slice(0, n);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>text-pager${inFrame ? "-frame" : ""}</title>` +
        `<body style="margin:0"><div id="t" style="word-break:break-all">${body}</div>` +
        (inFrame
          ? ""
          : `<iframe id="vis" src="/text-pager-frame?n=3000&mark=VISIBLEFRAMEMARK" style="width:300px;height:120px"></iframe>` +
            `<iframe id="inv" src="/text-pager-frame?n=600&mark=HIDDENFRAMEMARK" style="display:none"></iframe>` +
            `<button id="longname" aria-label="${"甲乙丙丁戊己庚辛壬癸".repeat(30)}">x</button>` +
            `<button id="byid" aria-labelledby="lbl">y</button>` +
            `<span id="lbl" style="position:absolute;left:-9999px">${"子丑寅卯辰巳午未申酉".repeat(30)}</span>`) +
        `</body>`
    );
  }
  if (url.pathname === "/heavy") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(heavyPage(Number(url.searchParams.get("n") || 1500), Number(url.searchParams.get("depth") || 30)));
  }
  if (url.pathname === "/frame") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      framePage(
        url.searchParams.get("id") || "frame",
        url.searchParams.get("nest"),
        url.searchParams.get("nestsbx") === "1",
        url.searchParams.get("autopost") === "1"
      )
    );
  }
  if (url.pathname === "/api/user") {
    return json({ id: 7, name: "测试用户", roles: ["admin", "dev"], marker: "user-payload-marker" });
  }
  if (url.pathname === "/needs-cookie") {
    const cookie = String(req.headers.cookie || "");
    if (!/\be2e_raw_hdr=1\b/.test(cookie)) {
      return json({ error: "未登录", need: "e2e_raw_hdr", marker: "needs-cookie-401" }, 401);
    }
    return json({ ok: true, who: "cookie 认过了", marker: "needs-cookie-200" });
  }
  if (url.pathname === "/auth/login") {
    const sid = "S" + Math.random().toString(36).slice(2, 12);
    AUTH_SESSIONS.set(sid, { user: "alice", at: Date.now() });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `zc_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true, user: "alice", marker: "auth-login" }));
  }
  if (url.pathname === "/auth/me") {
    const sid = (String(req.headers.cookie || "").match(/\bzc_sid=([^;]+)/) || [])[1];
    const s = sid && AUTH_SESSIONS.get(sid);
    if (!s) return json({ ok: false, reason: "未登录", marker: "auth-401" }, 401);
    return json({ ok: true, user: s.user, sid, marker: "auth-200" });
  }
  if (url.pathname === "/api/order" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    return json({ ok: true, echo: JSON.parse(body || "{}"), orderId: "ord_9527", marker: "order-payload-marker" });
  }
  if (url.pathname === "/api/slow") {
    await new Promise((r) => setTimeout(r, 1200));
    return json({ slow: true, marker: "slow-payload-marker" });
  }
  if (url.pathname === "/api/boom") {
    return json({ error: "内部错误", marker: "boom-marker" }, 500);
  }
  if (url.pathname === "/upload" && req.method === "POST") {
    res.setHeader("access-control-allow-origin", "*");
    const ct = req.headers["content-type"] || "";
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!m) return json({ error: "不是 multipart 请求", contentType: ct }, 400);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const parts = parseMultipart(Buffer.concat(chunks), (m[1] || m[2]).trim());
    const files = [];
    for (const p of parts) {
      const cd = /content-disposition:.*/i.exec(p.headers)?.[0] || "";
      const field = /name="([^"]*)"/i.exec(cd)?.[1] ?? "";
      const filename = /filename="([^"]*)"/i.exec(cd)?.[1];
      if (filename === undefined) continue;
      files.push({
        field,
        filename,
        contentType: /content-type:\s*(\S+)/i.exec(p.headers)?.[1] || "",
        size: p.body.length,
        sha256: crypto.createHash("sha256").update(p.body).digest("hex"),
        preview: p.body.length <= 2048 ? p.body.toString("utf8") : undefined,
      });
    }
    lastUpload = { at: Date.now(), count: files.length, files, marker: "upload-marker" };
    return json({ ok: true, count: files.length, files, marker: "upload-marker" });
  }
  if (url.pathname === "/upload/last") {
    return json(lastUpload || { count: 0, files: [], empty: true });
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
};

const guarded = (req, res) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((err) => {
      const gone = err?.code === "ECONNRESET" || /aborted/i.test(String(err?.message)) || !req.complete || res.destroyed;
      if (gone) return;
      process.stderr.write(`[fixture] ${req.method} ${req.url} 处理失败：${err?.stack || err}\n`);
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("fixture handler error");
      } catch {}
    });
};

const server = http.createServer(guarded);
const altServer = http.createServer(guarded);

process.on("uncaughtException", (err) => {
  process.stderr.write(`[fixture] 未捕获异常（已忽略，站点继续跑）：${err?.stack || err}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[fixture] 未处理拒绝（已忽略，站点继续跑）：${err?.stack || err}\n`);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  setTimeout(() => socket.writable && socket.write(encodeFrame(JSON.stringify({ push: "服务端主动推送", marker: "ws-push-marker" }))), 100);

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 8) return socket.end();
      if (f.opcode === 1) {
        socket.write(encodeFrame(JSON.stringify({ echo: f.payload, marker: "ws-echo-marker" })));
      }
    }
  });
  socket.on("error", () => socket.destroy());
});

altServer.listen(0, "127.0.0.1", () => {
  ALT_BASE = `http://127.0.0.1:${altServer.address().port}`;
  server.listen(PORT, "127.0.0.1", () => {
    const p = server.address().port;
    SELF_BASE = `http://127.0.0.1:${p}`;
    console.log(`FIXTURE_READY http://127.0.0.1:${p}`);
    console.log(`FIXTURE_ALT ${ALT_BASE}`);
  });
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
