"use strict";
/* =========================================================================
   智能AI · 檔案分解單元  (aifeature.js)
   -------------------------------------------------------------------------
   誠實的同意流程：
     1. AI 先自我介紹，並「明確、如實」說明它想做什麼、會讀什麼、送去哪。
        —— 不隱瞞範圍：使用者自己選檔案，我們只讀被選的檔案。
     2. 使用者必須主動點「我同意」才會進入檔案選擇。
     3. 分解模式二選一：
          (A) 本地分解 — 檔案完全不離開這台裝置，由瀏覽器就地拆解結構。
          (B) 雲端 AI 深度分解 — 會把檔案內容送到你設定的 API 端點。
              選這個時會再做一次明確確認，並清楚寫出「內容將離開裝置」。
              未設定端點時，退回本地深入分析（不外送），並如實告知。
     4. 分解完成後顯示結果（檔案結構的「分解」：型別、大小、區塊、
        關鍵字、位元組分佈、結構摘要等）。
   任何一步都可取消。沒有任何隱藏的全碟掃描或背景讀取。
   ========================================================================= */
(function(){
  const body = () => document.getElementById("aibody");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtBytes = n => n<1024 ? n+" B" : n<1048576 ? (n/1024).toFixed(1)+" KB" : (n/1048576).toFixed(2)+" MB";

  // -- Cloud endpoint config (opt-in, stored locally only) ------------------
  const LSKEY = "fmc_ai_endpoint";
  const getEndpoint = () => { try { return localStorage.getItem(LSKEY) || ""; } catch(e){ return ""; } };
  const setEndpoint = v => { try { v ? localStorage.setItem(LSKEY, v) : localStorage.removeItem(LSKEY); } catch(e){} };

  let mode = "local"; // "local" | "cloud"

  // ---------------------------------------------------------------------
  // SCREEN 1 — greeting + honest consent
  // ---------------------------------------------------------------------
  function renderIntro(){
    body().innerHTML = `
      <div class="bubble">
        你好，旅人。我是這座城市的 <b>智能AI · 分解者</b>。
        我可以把你交給我的檔案<b>分解</b>開來，讓你看清它的結構——它是什麼型別、
        內部由哪些區塊組成、藏著哪些關鍵字與模式。
      </div>

      <div class="consent">
        <h3>在開始前，我要先跟你說清楚（並取得你的同意）：</h3>
        <ul>
          <li>我只會讀取<b>你親手選取或拖入</b>的檔案，<b>不會</b>掃描你的資料夾、硬碟或其他任何檔案。</li>
          <li>我一次只處理你這次交給我的那些檔案，處理完就結束，<b>不保留、不背景讀取</b>。</li>
          <li>預設模式下，檔案<b>完全不會離開這台裝置</b>——分解在你的瀏覽器裡就地完成。</li>
          <li>如果你之後選擇「雲端深度分解」，我會在送出前<b>再次明確詢問</b>，
              並清楚告訴你內容將被傳到哪個端點。</li>
        </ul>
        <p class="note">這是一個遊戲中的示範功能。你可以隨時按右上角 × 或 Esc 離開，什麼都不會被讀取。</p>
        <div class="row">
          <button class="btn2 primary" id="consentYes">我同意，讓我選檔案</button>
          <button class="btn2 ghost" id="consentNo">先不要</button>
        </div>
      </div>`;
    document.getElementById("consentYes").onclick = renderPicker;
    document.getElementById("consentNo").onclick = () => window.closeAI && window.closeAI();
  }

  // ---------------------------------------------------------------------
  // SCREEN 2 — choose mode + pick files
  // ---------------------------------------------------------------------
  function renderPicker(){
    const ep = getEndpoint();
    body().innerHTML = `
      <div class="bubble">好，謝謝你的同意。<b>選擇分解方式</b>，然後把檔案交給我。</div>

      <div class="mode" id="modebox">
        <label id="mLocal" class="${mode==='local'?'on':''}">
          <div class="mt"><input type="radio" name="mode" value="local" ${mode==='local'?'checked':''}>本地分解（推薦）</div>
          <div class="md">檔案不離開這台裝置，由瀏覽器就地拆解結構。最隱私、免設定。</div>
        </label>
        <label id="mCloud" class="${mode==='cloud'?'on':''}">
          <div class="mt"><input type="radio" name="mode" value="cloud" ${mode==='cloud'?'checked':''}>雲端 AI 深度分解</div>
          <div class="md">把檔案內容送到你設定的 API 端點做語意分解。送出前會再次確認。
            ${ep ? `目前端點：<b>${esc(ep)}</b>` : `<b>尚未設定端點</b>，未設定時會退回本地深入分析。`}
            <a href="#" id="cfgEp" style="color:#7ec86a">設定/變更端點</a>
          </div>
        </label>
      </div>

      <label class="fileslot" id="drop">
        <input type="file" id="fileInput" multiple>
        <div style="font-size:32px">📦</div>
        <div>把檔案拖到這裡，或<b>點擊選擇</b></div>
        <div class="note" style="margin-top:6px">可多選。我只讀你在這裡選的檔案。</div>
      </label>

      <div class="row">
        <button class="btn2 ghost" id="back">← 返回</button>
      </div>
      <div class="result" id="result"></div>`;

    // mode radios
    body().querySelectorAll('input[name="mode"]').forEach(r=>{
      r.onchange = () => {
        mode = r.value;
        document.getElementById("mLocal").classList.toggle("on", mode==="local");
        document.getElementById("mCloud").classList.toggle("on", mode==="cloud");
      };
    });
    document.getElementById("cfgEp").onclick = (e)=>{ e.preventDefault(); configEndpoint(); };
    document.getElementById("back").onclick = renderIntro;

    const input = document.getElementById("fileInput");
    const drop = document.getElementById("drop");
    input.onchange = () => handleFiles(input.files);
    drop.addEventListener("dragover", e=>{ e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", ()=> drop.classList.remove("drag"));
    drop.addEventListener("drop", e=>{
      e.preventDefault(); drop.classList.remove("drag");
      if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
  }

  function configEndpoint(){
    const cur = getEndpoint();
    const v = prompt(
      "雲端深度分解端點（HTTPS）。\n" +
      "留空則清除。內容只有在你之後明確確認送出時才會被傳到這裡。",
      cur
    );
    if(v===null) return;
    setEndpoint(v.trim());
    renderPicker();
  }

  // ---------------------------------------------------------------------
  // Handle chosen files
  // ---------------------------------------------------------------------
  async function handleFiles(fileList){
    const files = Array.from(fileList).slice(0, 12); // cap for demo
    if(!files.length) return;

    if(mode === "cloud"){
      const ep = getEndpoint();
      const list = files.map(f=>`• ${f.name} (${fmtBytes(f.size)})`).join("\n");
      if(ep){
        const ok = confirm(
          "⚠️ 你選的是「雲端深度分解」。\n\n" +
          "以下檔案的內容將『離開這台裝置』，被傳送到：\n" + ep + "\n\n" +
          list + "\n\n確定要送出嗎？（取消則不送出）"
        );
        if(!ok) return;
        return cloudDecompose(files, ep);
      } else {
        alert("你尚未設定雲端端點，這次將以『本地深入分析』處理（內容不會離開裝置）。");
        // fall through to local
      }
    }
    localDecompose(files);
  }

  // ---------------------------------------------------------------------
  // LOCAL decomposition — read only the chosen files, in-browser
  // ---------------------------------------------------------------------
  async function localDecompose(files){
    const res = document.getElementById("result");
    res.innerHTML = `<div class="bubble">正在就地分解 <b>${files.length}</b> 個檔案（內容不離開裝置）…</div>`;
    const cards = [];
    for(const f of files){
      cards.push(await analyzeFile(f));
    }
    res.innerHTML = `<div class="bubble">分解完成 ✅ 共 <b>${files.length}</b> 個檔案。以下是它們的結構拆解：</div>` + cards.join("");
  }

  function detectType(name, bytes){
    const ext = (name.split(".").pop()||"").toLowerCase();
    const sig = (n) => Array.from(bytes.slice(0,n));
    const s = sig(8);
    const starts = arr => arr.every((b,i)=>bytes[i]===b);
    if(starts([0x89,0x50,0x4e,0x47])) return {kind:"圖片 PNG", family:"binary"};
    if(starts([0xff,0xd8,0xff]))      return {kind:"圖片 JPEG", family:"binary"};
    if(starts([0x47,0x49,0x46,0x38])) return {kind:"圖片 GIF", family:"binary"};
    if(starts([0x25,0x50,0x44,0x46])) return {kind:"PDF 文件", family:"binary"};
    if(starts([0x50,0x4b,0x03,0x04])) return {kind:"ZIP/Office 壓縮包", family:"binary"};
    if(starts([0x1f,0x8b]))           return {kind:"GZIP 壓縮", family:"binary"};
    if(starts([0x7f,0x45,0x4c,0x46])) return {kind:"ELF 執行檔", family:"binary"};
    const map = { js:"JavaScript 原始碼", ts:"TypeScript 原始碼", py:"Python 原始碼",
      json:"JSON 資料", html:"HTML 文件", css:"CSS 樣式", md:"Markdown 文件",
      csv:"CSV 表格", xml:"XML 文件", txt:"純文字", java:"Java 原始碼",
      c:"C 原始碼", cpp:"C++ 原始碼", go:"Go 原始碼", rs:"Rust 原始碼", sh:"Shell 腳本" };
    if(map[ext]) return {kind:map[ext], family:"text"};
    return {kind: ext ? ext.toUpperCase()+" 檔案" : "未知型別", family:"unknown"};
  }

  function isProbablyText(bytes){
    let printable=0, sample=Math.min(bytes.length, 4096);
    for(let i=0;i<sample;i++){ const b=bytes[i]; if(b===9||b===10||b===13||(b>=32&&b<127)||b>=128) printable++; }
    return sample===0 || printable/sample > 0.85;
  }

  function shannon(bytes){
    if(!bytes.length) return 0;
    const freq = new Array(256).fill(0);
    const n = Math.min(bytes.length, 65536);
    for(let i=0;i<n;i++) freq[bytes[i]]++;
    let h=0;
    for(const f of freq){ if(f){ const p=f/n; h -= p*Math.log2(p); } }
    return h; // 0..8 bits/byte
  }

  async function analyzeFile(f){
    const buf = new Uint8Array(await f.arrayBuffer());
    const type = detectType(f.name, buf);
    const entropy = shannon(buf);
    const looksText = type.family==="text" || (type.family==="unknown" && isProbablyText(buf));

    let structure = "";   // decomposition body per family
    if(looksText){
      const text = new TextDecoder("utf-8", {fatal:false}).decode(buf);
      structure = decomposeText(f.name, text);
    } else {
      structure = decomposeBinary(buf, entropy);
    }

    // byte-class distribution (universal decomposition view)
    let ctrl=0,ascii=0,high=0,zero=0;
    const n=Math.min(buf.length,65536);
    for(let i=0;i<n;i++){ const b=buf[i]; if(b===0)zero++; else if(b<32)ctrl++; else if(b<128)ascii++; else high++; }
    const dist = distBars({ "NUL(0)":zero, "控制字元":ctrl, "ASCII 可見":ascii, "高位元(≥128)":high }, n);

    return `
      <div class="fcard">
        <div class="fh">
          <span class="fn">${esc(f.name)}</span>
          <span class="fmeta">${fmtBytes(f.size)}</span>
        </div>
        <div class="fb">
          <div class="kv">
            <span class="k">判定型別</span><span class="v">${esc(type.kind)}</span>
            <span class="k">MIME</span><span class="v">${esc(f.type||"（瀏覽器未提供）")}</span>
            <span class="k">熵值</span><span class="v">${entropy.toFixed(2)} bits/byte ${entropy>7.5?"（高，可能已壓縮/加密）":entropy<4?"（低，重複性高）":""}</span>
            <span class="k">內容形態</span><span class="v">${looksText?"文字":"二進位"}</span>
          </div>
          ${structure}
          <div class="bars"><div class="note" style="margin-bottom:4px">位元組分佈（分解檢視）</div>${dist}</div>
        </div>
      </div>`;
  }

  function distBars(obj, total){
    return Object.entries(obj).map(([k,v])=>{
      const pct = total? (v/total*100) : 0;
      return `<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span><span>${pct.toFixed(1)}%</span></div>`;
    }).join("");
  }

  function decomposeText(name, text){
    const lines = text.split(/\r\n|\r|\n/);
    const nonEmpty = lines.filter(l=>l.trim()).length;
    const words = (text.match(/\S+/g)||[]).length;
    const chars = text.length;

    // top keywords (identifier-ish tokens), ignoring tiny/common
    const stop = new Set("the a an and or of to in is for on with this that be as at by function const let var return import from if else def class self true false null new".split(" "));
    const counts = new Map();
    (text.match(/[A-Za-z_一-鿿][\w一-鿿]{2,}/g)||[]).forEach(w=>{
      const lw=w.toLowerCase(); if(stop.has(lw)) return;
      counts.set(lw, (counts.get(lw)||0)+1);
    });
    const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);

    // structural blocks by ext
    const ext = (name.split(".").pop()||"").toLowerCase();
    let blocks = [];
    if(["js","ts","jsx","tsx"].includes(ext)){
      blocks = [
        ["函式 function", (text.match(/\bfunction\b/g)||[]).length],
        ["箭頭函式 =>", (text.match(/=>/g)||[]).length],
        ["class", (text.match(/\bclass\s+\w/g)||[]).length],
        ["import", (text.match(/\bimport\b/g)||[]).length],
        ["export", (text.match(/\bexport\b/g)||[]).length],
        ["註解 //", (text.match(/\/\//g)||[]).length],
      ];
    } else if(ext==="py"){
      blocks = [
        ["def", (text.match(/^\s*def\s/gm)||[]).length],
        ["class", (text.match(/^\s*class\s/gm)||[]).length],
        ["import", (text.match(/^\s*(import|from)\s/gm)||[]).length],
        ["註解 #", (text.match(/#/g)||[]).length],
      ];
    } else if(ext==="json"){
      let ok=true, parsed=null; try{ parsed=JSON.parse(text);}catch(e){ok=false;}
      blocks = [
        ["JSON 合法", ok?1:0],
        ["物件 {", (text.match(/{/g)||[]).length],
        ["陣列 [", (text.match(/\[/g)||[]).length],
        ["鍵值對 :", (text.match(/:/g)||[]).length],
      ];
      if(ok && parsed && typeof parsed==="object"){
        blocks.push(["頂層鍵數", Array.isArray(parsed)? parsed.length : Object.keys(parsed).length]);
      }
    } else if(["html","xml"].includes(ext)){
      const tags = text.match(/<([a-zA-Z][\w-]*)/g)||[];
      blocks = [
        ["標籤數", tags.length],
        ["不同標籤", new Set(tags.map(t=>t.slice(1).toLowerCase())).size],
        ["屬性 =", (text.match(/\w+=/g)||[]).length],
      ];
    } else if(ext==="csv"){
      const cols = (lines[0]||"").split(",").length;
      blocks = [["資料列", Math.max(0,lines.length-1)], ["欄位數", cols]];
    } else if(ext==="md"){
      blocks = [
        ["標題 #", (text.match(/^#+\s/gm)||[]).length],
        ["連結 []()", (text.match(/\[[^\]]*\]\([^)]*\)/g)||[]).length],
        ["程式區塊 ```", (text.match(/```/g)||[]).length],
      ];
    }

    const preview = esc(text.slice(0, 500)) + (text.length>500?" …":"");

    return `
      <div class="kv">
        <span class="k">行數</span><span class="v">${lines.length}（非空 ${nonEmpty}）</span>
        <span class="k">字詞 / 字元</span><span class="v">${words} 詞 · ${chars} 字元</span>
      </div>
      ${blocks.length ? `<div class="note" style="margin-top:6px">結構區塊分解</div>
        <div class="bars">${blocks.map(([k,v])=>`<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${Math.min(100, v? Math.max(6, Math.log2(v+1)*18):0)}%"></span></span><span>${v}</span></div>`).join("")}</div>` : ""}
      ${top.length ? `<div class="note" style="margin-top:8px">高頻關鍵字</div>
        <div class="chips">${top.map(([w,c])=>`<span class="chip">${esc(w)} · ${c}</span>`).join("")}</div>` : ""}
      <div class="note" style="margin-top:8px">內容預覽（前 500 字）</div>
      <pre class="hex">${preview}</pre>`;
  }

  function decomposeBinary(bytes, entropy){
    // hex dump of the first 128 bytes
    const n = Math.min(bytes.length, 128);
    let rows = "";
    for(let i=0;i<n;i+=16){
      let hex="", asc="";
      for(let j=0;j<16;j++){
        if(i+j<n){ const b=bytes[i+j]; hex += b.toString(16).padStart(2,"0")+" "; asc += (b>=32&&b<127)?String.fromCharCode(b):"."; }
        else hex += "   ";
      }
      rows += i.toString(16).padStart(6,"0")+"  "+hex+" |"+esc(asc)+"|\n";
    }
    // rough segment guess by entropy
    let note = entropy>7.5 ? "整體高熵：資料看似壓縮或加密。"
             : entropy>6   ? "中高熵：混合結構（可能含壓縮段與標頭）。"
             : "較低熵：含大量重複/結構化位元組（如未壓縮資料或標頭表）。";
    return `
      <div class="note" style="margin-top:6px">前 128 位元組（十六進位分解）</div>
      <pre class="hex">${rows}</pre>
      <div class="note" style="margin-top:6px">分段研判：${note}</div>`;
  }

  // ---------------------------------------------------------------------
  // CLOUD decomposition — only reached after explicit confirm()
  // ---------------------------------------------------------------------
  async function cloudDecompose(files, endpoint){
    const res = document.getElementById("result");
    res.innerHTML = `<div class="bubble">正在把 <b>${files.length}</b> 個檔案送往 <b>${esc(endpoint)}</b> 進行雲端深度分解…</div>`;
    const out = [];
    for(const f of files){
      const buf = new Uint8Array(await f.arrayBuffer());
      // send as base64; server decides how to decompose. This runs ONLY because
      // the user explicitly confirmed the transfer above.
      let b64=""; const CH=0x8000;
      for(let i=0;i<buf.length;i+=CH) b64 += String.fromCharCode.apply(null, buf.subarray(i,i+CH));
      b64 = btoa(b64);
      try{
        const r = await fetch(endpoint, {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ name:f.name, size:f.size, type:f.type, contentBase64:b64 })
        });
        const txt = await r.text();
        out.push(`<div class="fcard"><div class="fh"><span class="fn">${esc(f.name)}</span><span class="fmeta">${fmtBytes(f.size)} · HTTP ${r.status}</span></div><div class="fb"><pre class="hex">${esc(txt.slice(0,2000))}</pre></div></div>`);
      }catch(err){
        out.push(`<div class="fcard"><div class="fh"><span class="fn">${esc(f.name)}</span><span class="fmeta">送出失敗</span></div><div class="fb"><div class="note">無法連到端點：${esc(err.message)}。你可以改用本地分解。</div></div></div>`);
      }
    }
    res.innerHTML = `<div class="bubble">雲端分解回應如下：</div>` + out.join("");
  }

  // expose
  window.AIFeature = { render: renderIntro };
})();
