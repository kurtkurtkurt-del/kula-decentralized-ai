// A small markdown renderer for model answers, safe by construction: every piece of the text
// is HTML-escaped before any tag is added, links keep http(s) and mailto only, and nothing
// carries a style or an event attribute. A pure module: the page imports it and so does
// test/ui.test.ts (node), which checks the escaping.
//
// Covered: paragraphs, headings, lists (nested by indent, ordered and not), block quotes,
// fenced code (with a copy button the page wires up), tables, rules, **bold**, *italic*,
// ~~strike~~, `code`, [links](https://…) and bare https:// links. An open fence while an
// answer streams renders as code up to the end.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// qwen3 and friends think out loud first: "<think>…</think> answer". While the closing tag has
// not come yet the whole text is thinking.
export function splitThink(text) {
  const s = String(text ?? '');
  const lead = s.match(/^\s*<think>/);
  if (!lead) return { think: null, answer: s, thinking: false };
  const rest = s.slice(lead[0].length);
  const end = rest.indexOf('</think>');
  if (end < 0) return { think: rest.trim(), answer: '', thinking: true };
  return { think: rest.slice(0, end).trim(), answer: rest.slice(end + 8).replace(/^\s+/, ''), thinking: false };
}

// The answer without its thinking: what goes back to the model as history.
export function stripThink(text) {
  return splitThink(text).answer;
}

function safeUrl(raw) {
  // `raw` is already escaped; quotes are entities, so it cannot leave the attribute
  const u = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  return null;
}

// Inline markup over one line or paragraph of raw text.
export function inline(raw) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(raw).replace(/\u0000/g, '');
  // code spans first: nothing inside them is markup
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${escapeHtml(code.trim() || code)}</code>`));
  s = escapeHtml(s);
  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    const href = safeUrl(url);
    return href ? keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m;
  });
  // bare links
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"])/g, (_, pre, url) => `${pre}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function list(lines, start) {
  // items with their indent; a deeper indent opens a nested list inside the previous item
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] }); i++; continue; }
    // a continuation line (indented, not blank) belongs to the item above
    if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
    break;
  }
  let pos = 0;
  const build = (indent) => {
    const first = items[pos];
    const tag = first.ordered ? 'ol' : 'ul';
    const startAttr = first.ordered && first.num > 1 ? ` start="${first.num}"` : '';
    let html = `<${tag}${startAttr}>`;
    while (pos < items.length && (items[pos].indent > indent || (items[pos].indent === indent && items[pos].ordered === first.ordered))) {
      const it = items[pos];
      if (it.indent > indent) { html = html.replace(/<\/li>$/, '') + build(it.indent) + '</li>'; continue; }
      const task = /^\[([ xX])\]\s+/.exec(it.text);
      const body = task ? `<span class="task${task[1] === ' ' ? '' : ' done'}">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(it.text.slice(task[0].length))}` : inline(it.text);
      html += `<li>${body}</li>`;
      pos++;
    }
    return html + `</${tag}>`;
  };
  let out = '';
  while (pos < items.length) out += build(items[pos].indent);
  return { html: out, next: i };
}

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((l) => inline(l)).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const lang = fence[2].toLowerCase();
      const body = [];
      i++;
      const closes = (l) => { const t = l.trim(); return t.length >= mark.length && t === mark[0].repeat(t.length); };
      while (i < lines.length && !closes(lines[i])) body.push(lines[i++]);
      const closed = i < lines.length;
      if (closed) i++;
      const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '<span class="lang">code</span>';
      out.push(`<div class="code"><div class="code-head">${label}<button type="button" class="copy" data-copy>copy</button></div><pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = HEADING.exec(line);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (RULE.test(line) && !para.length) { flush(); out.push('<hr>'); i++; continue; }
    if (ITEM.test(line) && (!para.length || /^\s*([-*+]|\d{1,9}[.)])\s/.test(line))) {
      flush();
      const l = list(lines, i);
      out.push(l.html);
      i = l.next;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${aligns[k] ? ` class="al-${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}
