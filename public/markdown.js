/**
 * 輕量 Markdown → HTML（不依賴任何外部套件，離線也能跑）。
 * 支援：標題、粗體/斜體/刪除線、行內程式碼、程式碼區塊、清單、待辦框、
 * 表格、引言、分隔線、連結、<details> 折疊區塊。
 * 一律先跳脫 HTML，只放行白名單語法。
 */
(function (global) {
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  function tableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function render(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let i = 0;
    let listType = null;

    const closeList = () => {
      if (listType) {
        html.push(listType === 'ol' ? '</ol>' : '</ul>');
        listType = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // 程式碼區塊
      const fence = /^\s*```(\w*)\s*$/.exec(line);
      if (fence) {
        closeList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        html.push(
          `<pre data-lang="${escapeHtml(lang)}"><button class="copy-code" type="button">複製</button>` +
          `<code>${escapeHtml(buf.join('\n'))}</code></pre>`,
        );
        continue;
      }

      // 折疊區塊（模型會用來藏答案）
      if (/^\s*<details>/.test(line)) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*<\/details>/.test(lines[i])) buf.push(lines[i++]);
        i++;
        let summary = '展開';
        const rest = [];
        for (const b of buf) {
          const m = /^\s*<summary>(.*?)<\/summary>\s*$/.exec(b);
          if (m) summary = m[1];
          else rest.push(b);
        }
        html.push(`<details><summary>${inline(summary)}</summary>${render(rest.join('\n'))}</details>`);
        continue;
      }

      if (!line.trim()) { closeList(); i++; continue; }

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        closeList();
        const head = tableRow(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(tableRow(lines[i++]));
        html.push(
          '<div class="table-wrap"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
        );
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); html.push('<hr />'); i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
      if (task) {
        if (listType !== 'ul') { closeList(); html.push('<ul class="tasks">'); listType = 'ul'; }
        const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
        html.push(`<li><input type="checkbox"${checked} /> <span>${inline(task[2])}</span></li>`);
        i++;
        continue;
      }

      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      if (ul) {
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push(`<li>${inline(ul[1])}</li>`);
        i++;
        continue;
      }

      const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (ol) {
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push(`<li>${inline(ol[2])}</li>`);
        i++;
        continue;
      }

      // 段落：連續非空行合併
      closeList();
      const para = [];
      while (
        i < lines.length && lines[i].trim() &&
        !/^\s*(#{1,6}\s|[-*]\s|\d+[.)]\s|>|```|\|)/.test(lines[i]) &&
        !/^\s*<details>/.test(lines[i])
      ) para.push(lines[i++]);
      if (para.length) html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
      else i++;
    }
    closeList();
    return html.join('');
  }

  global.md = { render, escapeHtml };
})(window);
