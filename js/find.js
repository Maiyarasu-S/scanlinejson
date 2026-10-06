/* find.js: the search box. Turns what was typed into a pattern, finds matches in plain text output,
   and paints that text as HTML with syntax colours and <mark>s. The tree view does its own marking
   from the same pattern. */
(() => {
'use strict';
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => s.replace(/[&<>"]/g, c => escMap[c]);

/* "text" matches literally, ignoring case. "/pattern/flags" is a regular expression.
   Returns null for an empty box, { error } for a bad pattern, else { test, mark }: mark is the global form. */
function pattern(term) {
  if (!term) return null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(term);
  let re;
  try { re = m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  catch (e) { return { error: 'not a valid pattern' }; }
  return { test: re, mark: new RegExp(re.source, re.flags + 'g') };
}

/* Match offsets as [start, end) pairs, at most `cap` of them. Empty matches are skipped. */
function ranges(text, mark, cap) {
  const out = [];
  mark.lastIndex = 0;
  let m;
  while ((m = mark.exec(text))) {
    if (!m[0]) { mark.lastIndex++; continue; }
    if (out.length === cap) return { ranges: out, more: true };
    out.push([m.index, m.index + m[0].length]);
  }
  return { ranges: out, more: false };
}

/* Colour spans for JSON text (one document, or JSON Lines), as [start, end, class] with the classes the
   serialiser uses: k key, s string, nu number, b true/false, z null. Punctuation gets no span. */
function tokens(text) {
  const out = [], n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      const s = i++;
      while (i < n && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
      i = Math.min(i + 1, n);
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      out.push([s, i, text[j] === ':' ? 'k' : 's']);
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      const s = i++;
      while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
      out.push([s, i, 'nu']);
    } else if (text.startsWith('true', i) || text.startsWith('false', i)) {
      const L = text[i] === 't' ? 4 : 5;
      out.push([i, i + L, 'b']); i += L;
    } else if (text.startsWith('null', i)) {
      out.push([i, i + 4, 'z']); i += 4;
    } else i++;
  }
  return out;
}

/* HTML for `text` with colour spans and match marks laid over it. Spans and marks may cross each other,
   so the text is cut at every boundary. Each mark carries data-m (its index); the one at `cur` also gets class "now". */
function paint(text, spans, marks, cur) {
  const cuts = new Set([0, text.length]);
  for (const s of spans) { cuts.add(s[0]); cuts.add(s[1]); }
  for (const m of marks) { cuts.add(m[0]); cuts.add(m[1]); }
  const at = [...cuts].filter(x => x >= 0 && x <= text.length).sort((a, b) => a - b);
  let h = '', si = 0, mi = 0;
  for (let j = 0; j + 1 < at.length; j++) {
    const a = at[j], b = at[j + 1];
    while (si < spans.length && spans[si][1] <= a) si++;
    while (mi < marks.length && marks[mi][1] <= a) mi++;
    const cls = si < spans.length && spans[si][0] <= a ? spans[si][2] : '';
    const mk = mi < marks.length && marks[mi][0] <= a ? mi : -1;
    let t = esc(text.slice(a, b));
    if (mk >= 0) t = '<mark data-m="' + mk + '"' + (mk === cur ? ' class="now"' : '') + '>' + t + '</mark>';
    h += cls ? '<span class="' + cls + '">' + t + '</span>' : t;
  }
  return h;
}

JF.find = { pattern, ranges, tokens, paint };
})();
