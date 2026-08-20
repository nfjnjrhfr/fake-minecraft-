/* SnapMind 拍讀 AI — 前端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), modes: $('modes'), chat: $('chat'), welcome: $('welcome'),
    starters: $('starters'), input: $('input'), send: $('send-btn'), stop: $('stop-btn'),
    thumbs: $('thumbs'), fileInput: $('file-input'), captureInput: $('capture-input'),
    cameraBtn: $('camera-btn'), uploadBtn: $('upload-btn'), extractBtn: $('extract-btn'),
    usage: $('usage'), reset: $('reset-btn'),
    sheet: $('camera-sheet'), video: $('camera-video'), shot: $('camera-shot'),
    flip: $('camera-flip'), closeCam: $('camera-close'), camTip: $('camera-tip'),
    settingsBtn: $('settings-btn'), settings: $('settings-dialog'), apiKey: $('api-key'),
    userNote: $('user-note'), showThinking: $('show-thinking'), keyNote: $('key-note'),
    notesBtn: $('notes-btn'), notes: $('notes-dialog'), notesList: $('notes-list'),
    notesSearch: $('notes-search'), notesCount: $('notes-count'), notesClose: $('notes-close'),
    notesExport: $('notes-export'), notesHint: $('notes-hint'),
  };

  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem('snapmind.' + k); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem('snapmind.' + k, JSON.stringify(v)); } catch { /* 隱私模式 */ } },
  };

  const state = {
    mode: store.get('mode', 'chat'),
    sessionId: null,
    images: [],           // { dataUrl, name }
    busy: false,
    controller: null,
    apiKey: store.get('apiKey', ''),
    userNote: store.get('userNote', ''),
    showThinking: store.get('showThinking', false),
    notes: store.get('notes', []),
    lastExtraction: null,
    modes: [],
    serverKeyReady: false,
  };

  /* ---------------- 工具 ---------------- */
  const toast = (msg, ms = 2200) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    t.style.bottom = 96 + document.querySelectorAll('.toast').length * 44 + 'px';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };

  const todayString = () => {
    const d = new Date();
    const week = '日一二三四五六'[d.getDay()];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}（星期${week}）`;
  };

  const download = (filename, text, type = 'text/plain;charset=utf-8') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('已複製');
    }
  };

  const scrollDown = (force = false) => {
    const nearBottom = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 160;
    if (force || nearBottom) el.chat.scrollTop = el.chat.scrollHeight;
  };

  /* ---------------- 圖片 ---------------- */
  const MAX_EDGE = 1568;      // 超過這個邊長對辨識沒有幫助，只是多花錢
  const MAX_IMAGES = 6;

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('讀取檔案失敗'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('這個檔案不是有效的圖片'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function imageToDataUrl(img) {
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    for (const file of list) {
      if (state.images.length >= MAX_IMAGES) { toast(`一次最多 ${MAX_IMAGES} 張`); break; }
      try {
        const img = await fileToImage(file);
        state.images.push({ dataUrl: imageToDataUrl(img), name: file.name || '照片' });
      } catch (err) { toast(err.message); }
    }
    renderThumbs();
  }

  function renderThumbs() {
    el.thumbs.innerHTML = '';
    el.thumbs.hidden = state.images.length === 0;
    state.images.forEach((im, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const img = document.createElement('img');
      img.src = im.dataUrl; img.alt = im.name;
      const rm = document.createElement('button');
      rm.type = 'button'; rm.textContent = '×'; rm.title = '移除';
      rm.onclick = () => { state.images.splice(i, 1); renderThumbs(); };
      wrap.append(img, rm);
      el.thumbs.appendChild(wrap);
    });
    updateSendState();
  }

  /* ---------------- 相機 ---------------- */
  let stream = null;
  let facing = 'environment';

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      el.captureInput.click();   // 舊瀏覽器 / 非 HTTPS：退回系統相機
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
      el.video.srcObject = stream;
      el.sheet.hidden = false;
    } catch (err) {
      toast('無法開啟相機（' + err.name + '），改用系統相機');
      el.captureInput.click();
    }
  }

  function closeCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    el.sheet.hidden = true;
  }

  function shoot() {
    if (!el.video.videoWidth) return;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_EDGE / Math.max(el.video.videoWidth, el.video.videoHeight));
    canvas.width = Math.round(el.video.videoWidth * scale);
    canvas.height = Math.round(el.video.videoHeight * scale);
    canvas.getContext('2d').drawImage(el.video, 0, 0, canvas.width, canvas.height);
    if (state.images.length >= MAX_IMAGES) { toast(`一次最多 ${MAX_IMAGES} 張`); return; }
    state.images.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), name: '拍攝照片' });
    renderThumbs();
    el.camTip.textContent = `已拍 ${state.images.length} 張，可以繼續拍或按「取消」回到對話`;
  }

  /* ---------------- 訊息渲染 ---------------- */
  function addMessage(role, { text = '', images = [] } = {}) {
    el.welcome?.remove();
    const msg = document.createElement('div');
    msg.className = 'msg ' + role;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '🙂' : '📸';

    const body = document.createElement('div');
    body.className = 'body';

    if (images.length) {
      const strip = document.createElement('div');
      strip.className = 'msg-images';
      images.forEach((im) => {
        const i = document.createElement('img');
        i.src = im.dataUrl; i.alt = im.name; strip.appendChild(i);
      });
      body.appendChild(strip);
    }

    const thinking = document.createElement('details');
    thinking.className = 'thinking';
    thinking.hidden = true;
    thinking.innerHTML = '<summary>思考中…</summary><pre></pre>';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') bubble.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'meta-line';

    body.append(thinking, bubble, meta);
    msg.append(avatar, body);
    el.chat.appendChild(msg);
    scrollDown(true);
    return { bubble, meta, thinking, thinkingPre: thinking.querySelector('pre') };
  }

  function attachActions(meta, getText, title) {
    meta.innerHTML = '';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.onclick = fn;
      meta.appendChild(b);
      return b;
    };
    mk('複製', () => copy(getText()));
    mk('存成筆記', () => saveNote(title || '對話紀錄', getText()));
    mk('下載 .md', () => download(`snapmind-${Date.now()}.md`, getText(), 'text/markdown;charset=utf-8'));
    return mk;
  }

  function bindCodeCopy(root) {
    root.querySelectorAll('.copy-code').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.onclick = () => copy(btn.parentElement.querySelector('code').textContent);
    });
  }

  /* ---------------- 送出 ---------------- */
  function updateSendState() {
    const hasContent = el.input.value.trim().length > 0 || state.images.length > 0;
    el.send.disabled = state.busy || !hasContent;
    el.extractBtn.disabled = state.busy || state.images.length === 0;
    el.extractBtn.style.opacity = el.extractBtn.disabled ? .45 : 1;
  }

  function requestHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.apiKey && !state.serverKeyReady) headers['x-user-api-key'] = state.apiKey;
    return headers;
  }

  async function send() {
    if (state.busy) return;
    const text = el.input.value.trim();
    const images = state.images.slice();
    if (!text && !images.length) return;

    addMessage('user', { text: text || '（請看圖片）', images });
    el.input.value = '';
    el.input.style.height = 'auto';
    state.images = [];
    renderThumbs();

    const view = addMessage('assistant');
    view.bubble.classList.add('cursor');
    state.busy = true;
    state.controller = new AbortController();
    el.stop.hidden = false;
    updateSendState();

    let answer = '';
    let thoughts = '';
    let pending = false;
    const paint = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        view.bubble.innerHTML = window.md.render(answer);
        bindCodeCopy(view.bubble);
        scrollDown();
      });
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: requestHeaders(),
        signal: state.controller.signal,
        body: JSON.stringify({
          sessionId: state.sessionId,
          mode: state.mode,
          text,
          images: images.map((i) => i.dataUrl),
          today: todayString(),
          userNote: state.userNote,
        }),
      });

      if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const { error } = await res.json();
        throw new Error(error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('這個瀏覽器不支援串流回應');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice(7).trim();
          let payload = {};
          try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }

          if (event === 'meta') {
            state.sessionId = payload.sessionId;
          } else if (event === 'delta') {
            answer += payload.text;
            view.bubble.classList.remove('cursor');
            paint();
          } else if (event === 'thinking') {
            thoughts += payload.text;
            if (state.showThinking) {
              view.thinking.hidden = false;
              view.thinking.open = true;
              view.thinkingPre.textContent = thoughts;
              scrollDown();
            }
          } else if (event === 'done') {
            if (payload.stop_reason === 'max_tokens') {
              answer += '\n\n> ⚠️ 內容太長被截斷了，可以說「繼續」讓我接著寫。';
            }
            if (payload.stop_reason === 'refusal') {
              answer += '\n\n> ⚠️ 這個要求被安全機制擋下了，換個方式問問看。';
            }
            const u = payload.usage || {};
            el.usage.textContent = `輸入 ${u.input ?? 0} · 輸出 ${u.output ?? 0} tokens` +
              (u.cache_read ? ` · 快取命中 ${u.cache_read}` : '');
          } else if (event === 'error') {
            throw new Error(payload.message);
          }
        }
      }

      view.bubble.classList.remove('cursor');
      view.bubble.innerHTML = window.md.render(answer || '（沒有回應內容）');
      bindCodeCopy(view.bubble);
      if (state.showThinking && thoughts) view.thinking.open = false;
      attachActions(view.meta, () => answer, text.slice(0, 40) || '拍照識別結果');
    } catch (err) {
      view.bubble.classList.remove('cursor');
      if (err.name === 'AbortError') {
        view.bubble.innerHTML = window.md.render(answer || '_已停止_');
      } else {
        view.bubble.className = 'error-box';
        view.bubble.textContent = '出錯了：' + err.message;
      }
    } finally {
      state.busy = false;
      state.controller = null;
      el.stop.hidden = true;
      updateSendState();
      scrollDown();
    }
  }

  /* ---------------- 結構化擷取 ---------------- */
  async function extract() {
    if (state.busy || !state.images.length) return;
    const images = state.images.slice();
    const hint = el.input.value.trim();
    addMessage('user', { text: hint || '⚡ 結構化擷取', images });
    state.images = []; renderThumbs();
    el.input.value = '';

    const view = addMessage('assistant');
    view.bubble.textContent = '擷取中…（完整逐字 + 欄位 + 待辦 + 行程）';
    state.busy = true; updateSendState();

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ images: images.map((i) => i.dataUrl), text: hint, today: todayString() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      state.lastExtraction = json.data;
      const markdown = extractionToMarkdown(json.data);
      view.bubble.innerHTML = window.md.render(markdown);
      bindCodeCopy(view.bubble);

      const mk = attachActions(view.meta, () => markdown, json.data.title || '擷取結果');
      if (json.data.tables?.length) {
        mk('下載 CSV', () => download(`snapmind-${Date.now()}.csv`, tablesToCsv(json.data.tables), 'text/csv;charset=utf-8'));
      }
      if (json.data.events?.length) {
        mk('加入行事曆 .ics', () => download(`snapmind-${Date.now()}.ics`, eventsToIcs(json.data.events), 'text/calendar;charset=utf-8'));
      }
      mk('只複製逐字內容', () => copy(json.data.full_text || ''));
      el.usage.textContent = `輸入 ${json.usage.input} · 輸出 ${json.usage.output} tokens`;
    } catch (err) {
      view.bubble.className = 'error-box';
      view.bubble.textContent = '擷取失敗：' + err.message;
    } finally {
      state.busy = false;
      updateSendState();
      scrollDown();
    }
  }

  function extractionToMarkdown(d) {
    const out = [];
    out.push(`## ${d.title || '擷取結果'}`);
    const tags = [d.doc_type, (d.languages || []).join('／')].filter(Boolean).join(' · ');
    if (tags) out.push(`\`${tags}\``);
    out.push('\n### 逐字內容\n');
    out.push(d.full_text || '（無）');
    if (d.summary?.length) out.push('\n### 重點\n' + d.summary.map((s) => `- ${s}`).join('\n'));
    if (d.key_values?.length) {
      out.push('\n### 重要欄位\n');
      out.push('| 欄位 | 內容 |\n| --- | --- |');
      d.key_values.forEach((kv) => out.push(`| ${kv.label} | ${kv.value} |`));
    }
    if (d.action_items?.length) {
      out.push('\n### 待辦\n' + d.action_items.map((a) => {
        const extra = [a.owner, a.due, a.notes].filter(Boolean).join(' · ');
        return `- [ ] ${a.title}${extra ? `（${extra}）` : ''}`;
      }).join('\n'));
    }
    if (d.events?.length) {
      out.push('\n### 行程\n');
      out.push('| 標題 | 開始 | 結束 | 地點 |\n| --- | --- | --- | --- |');
      d.events.forEach((e) => out.push(`| ${e.title} | ${e.start || '-'} | ${e.end || '-'} | ${e.location || '-'} |`));
    }
    (d.tables || []).forEach((t, i) => {
      out.push(`\n### 表格 ${i + 1}${t.title ? '：' + t.title : ''}\n`);
      out.push('| ' + t.columns.join(' | ') + ' |');
      out.push('| ' + t.columns.map(() => '---').join(' | ') + ' |');
      t.rows.forEach((r) => out.push('| ' + r.join(' | ') + ' |'));
    });
    if (d.contacts?.length) {
      out.push('\n### 聯絡資訊\n' + d.contacts.map((c) =>
        `- ${[c.name, c.phone, c.email, c.address].filter(Boolean).join(' · ')}`).join('\n'));
    }
    if (d.unreadable?.length) {
      out.push('\n### 辨識備註\n' + d.unreadable.map((u) => `- ${u}`).join('\n'));
    }
    return out.join('\n');
  }

  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function tablesToCsv(tables) {
    const lines = [];
    tables.forEach((t, i) => {
      if (i) lines.push('');
      if (t.title) lines.push(csvCell(t.title));
      lines.push(t.columns.map(csvCell).join(','));
      t.rows.forEach((r) => lines.push(r.map(csvCell).join(',')));
    });
    return '﻿' + lines.join('\n');   // BOM：Excel 才不會把中文變亂碼
  }

  function icsStamp(value, fallbackDays = 0) {
    const base = value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : null;
    if (!base) {
      const d = new Date(Date.now() + fallbackDays * 86400000);
      return { date: d.toISOString().slice(0, 10).replace(/-/g, ''), allDay: true };
    }
    const [datePart, timePart] = base.split(/[T ]/);
    const ymd = datePart.replace(/-/g, '');
    if (!timePart) return { date: ymd, allDay: true };
    const [h = '00', m = '00'] = timePart.split(':');
    return { date: `${ymd}T${h.padStart(2, '0')}${m.padStart(2, '0')}00`, allDay: false };
  }

  const icsEscape = (s) => String(s ?? '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

  function eventsToIcs(events) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SnapMind//TW//ZH', 'CALSCALE:GREGORIAN'];
    events.forEach((e, i) => {
      const start = icsStamp(e.start);
      const end = e.end ? icsStamp(e.end) : start;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:snapmind-${Date.now()}-${i}@localhost`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(start.allDay ? `DTSTART;VALUE=DATE:${start.date}` : `DTSTART:${start.date}`);
      lines.push(end.allDay ? `DTEND;VALUE=DATE:${end.date}` : `DTEND:${end.date}`);
      lines.push(`SUMMARY:${icsEscape(e.title || '未命名行程')}`);
      if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
      if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /* ---------------- 筆記本 ---------------- */
  function saveNote(title, body) {
    state.notes.unshift({ id: Date.now(), title, body, mode: state.mode, at: new Date().toISOString() });
    state.notes = state.notes.slice(0, 200);
    store.set('notes', state.notes);
    renderNotesCount();
    toast('已存進筆記本');
  }

  function renderNotesCount() {
    el.notesCount.textContent = state.notes.length;
    el.notesCount.hidden = state.notes.length === 0;
  }

  function renderNotes(filter = '') {
    const q = filter.trim().toLowerCase();
    const list = state.notes.filter((n) =>
      !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
    el.notesHint.textContent = `共 ${state.notes.length} 則`;
    el.notesList.innerHTML = '';
    if (!list.length) {
      el.notesList.innerHTML = '<p class="empty">還沒有筆記。在任何回覆下方按「存成筆記」就會出現在這裡。</p>';
      return;
    }
    list.forEach((n) => {
      const card = document.createElement('div');
      card.className = 'note';
      const h = document.createElement('h4');
      h.textContent = n.title || '未命名';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = new Date(n.at).toLocaleString('zh-TW') + ' · ' + n.mode;
      const body = document.createElement('p');
      body.className = 'note-body';
      body.textContent = n.body;
      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const add = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.onclick = fn; actions.appendChild(b);
      };
      add('複製', () => copy(n.body));
      add('下載 .md', () => download(`${(n.title || 'note').slice(0, 24)}.md`, `# ${n.title}\n\n${n.body}\n`, 'text/markdown;charset=utf-8'));
      add('刪除', () => {
        state.notes = state.notes.filter((x) => x.id !== n.id);
        store.set('notes', state.notes);
        renderNotesCount(); renderNotes(el.notesSearch.value);
      });
      card.append(h, meta, body, actions);
      el.notesList.appendChild(card);
    });
  }

  /* ---------------- 模式 ---------------- */
  const GROUP_LABEL = { core: '通用', work: '生產力', fun: '娛樂' };

  function renderModes(modes) {
    el.modes.innerHTML = '';
    let lastGroup = null;
    modes.forEach((m) => {
      if (lastGroup && m.group !== lastGroup) {
        const sep = document.createElement('span');
        sep.className = 'mode-sep';
        sep.textContent = '│ ' + (GROUP_LABEL[m.group] || '');
        el.modes.appendChild(sep);
      } else if (!lastGroup) {
        const sep = document.createElement('span');
        sep.className = 'mode-sep';
        sep.textContent = GROUP_LABEL[m.group] || '';
        el.modes.appendChild(sep);
      }
      lastGroup = m.group;

      const btn = document.createElement('button');
      btn.className = 'mode' + (m.id === state.mode ? ' active' : '');
      btn.dataset.id = m.id;
      btn.dataset.group = m.group;
      btn.title = m.hint;
      btn.textContent = `${m.icon} ${m.label}`;
      btn.onclick = () => {
        state.mode = m.id;
        store.set('mode', m.id);
        renderModes(modes);
        el.input.placeholder = `${m.hint}…`;
        toast(`已切換到「${m.label}」`);
      };
      el.modes.appendChild(btn);
    });
  }

  function renderStarters(modes) {
    if (!el.starters) return;
    const picks = ['ocr', 'todo', 'translate', 'table', 'roast', 'rpg'];
    el.starters.innerHTML = '';
    picks.forEach((id) => {
      const m = modes.find((x) => x.id === id);
      if (!m) return;
      const b = document.createElement('button');
      b.className = 'starter';
      b.innerHTML = `<b>${m.icon} ${window.md.escapeHtml(m.label)}</b><span>${window.md.escapeHtml(m.hint)}</span>`;
      b.onclick = () => {
        state.mode = m.id;
        store.set('mode', m.id);
        renderModes(modes);
        openCamera();
      };
      el.starters.appendChild(b);
    });
  }

  /* ---------------- 啟動 ---------------- */
  async function init() {
    renderNotesCount();
    el.showThinking.checked = state.showThinking;
    el.apiKey.value = state.apiKey;
    el.userNote.value = state.userNote;

    try {
      const health = await fetch('/api/health').then((r) => r.json());
      state.serverKeyReady = health.keyReady;
      el.status.textContent = health.keyReady
        ? `${health.model} · 伺服器金鑰已就緒`
        : (state.apiKey ? `${health.model} · 使用本機金鑰` : `${health.model} · 尚未設定金鑰，請點右上角 ⚙️`);
      el.status.classList.toggle('bad', !health.keyReady && !state.apiKey);
      if (health.keyReady) el.keyNote.textContent = '伺服器已有金鑰，這裡可以留空。';
      else if (!health.allowClientKey) el.keyNote.textContent = '此站台已停用瀏覽器端金鑰，請由伺服器設定 ANTHROPIC_API_KEY。';
    } catch {
      el.status.textContent = '連不上伺服器';
      el.status.classList.add('bad');
    }

    try {
      const { modes } = await fetch('/api/modes').then((r) => r.json());
      state.modes = modes;
      if (!modes.some((m) => m.id === state.mode)) state.mode = 'chat';
      renderModes(modes);
      renderStarters(modes);
      const current = modes.find((m) => m.id === state.mode);
      if (current) el.input.placeholder = `${current.hint}…`;
    } catch { /* 保留預設 UI */ }

    updateSendState();
  }

  /* ---------------- 事件綁定 ---------------- */
  el.send.onclick = send;
  el.stop.onclick = () => state.controller?.abort();
  el.extractBtn.onclick = extract;
  el.cameraBtn.onclick = openCamera;
  el.uploadBtn.onclick = () => el.fileInput.click();
  el.fileInput.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  el.captureInput.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  el.shot.onclick = shoot;
  el.closeCam.onclick = closeCamera;
  el.flip.onclick = async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    closeCamera();
    await openCamera();
  };

  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
    updateSendState();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); toast('已貼上圖片'); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.sheet.hidden) closeCamera();
  });

  el.reset.onclick = async () => {
    try {
      await fetch('/api/session/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
    } catch { /* 伺服器沒回應也照樣清畫面 */ }
    state.sessionId = null;
    state.images = []; renderThumbs();
    el.chat.innerHTML = '';
    el.usage.textContent = '';
    toast('已開新對話');
  };

  el.settingsBtn.onclick = () => el.settings.showModal();
  $('settings-save').onclick = () => {
    state.apiKey = el.apiKey.value.trim();
    state.userNote = el.userNote.value.trim();
    state.showThinking = el.showThinking.checked;
    store.set('apiKey', state.apiKey);
    store.set('userNote', state.userNote);
    store.set('showThinking', state.showThinking);
    setTimeout(init, 0);
    toast('設定已儲存');
  };

  el.notesBtn.onclick = () => { renderNotes(''); el.notesSearch.value = ''; el.notes.showModal(); };
  el.notesClose.onclick = () => el.notes.close();
  el.notesSearch.oninput = () => renderNotes(el.notesSearch.value);
  el.notesExport.onclick = () => {
    if (!state.notes.length) return toast('筆記本是空的');
    const text = state.notes.map((n) =>
      `# ${n.title}\n\n_${new Date(n.at).toLocaleString('zh-TW')} · ${n.mode}_\n\n${n.body}\n`).join('\n---\n\n');
    download(`snapmind-notes-${Date.now()}.md`, text, 'text/markdown;charset=utf-8');
  };

  init();
})();
