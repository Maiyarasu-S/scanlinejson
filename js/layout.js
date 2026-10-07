/* layout.js: the arithmetic behind the stdin/stdout divider and the text-size control, and the syntax colours
   and bracket matching that stdin draws behind its textarea. No page access: app.js applies the results. */
(() => {
'use strict';

/* ---------- the divider ---------- */
const SPLIT_LO = 0.15, SPLIT_HI = 0.85;
const SPLIT_DEFAULT = { h: 0.5, v: 0.4 };          /* side by side, and stacked (a phone) */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/* the share of the space given to stdin, kept to a sane range */
const clampRatio = r => typeof r === 'number' && isFinite(r) ? clamp(r, SPLIT_LO, SPLIT_HI) : null;
/* what was saved, made safe: anything unusable falls back to the default */
function normSplit(s) {
  const o = s && typeof s === 'object' ? s : {};
  return { h: clampRatio(o.h) || SPLIT_DEFAULT.h, v: clampRatio(o.v) || SPLIT_DEFAULT.v };
}
/* Ratio for a pointer at `pos`, with the panes spanning [start, start + size) and the divider `bar` thick, so
   the divider centres on the pointer. Neither pane may get narrower than `minPx` (unless the whole area is too small for that). */
function ratioAt(pos, start, size, bar, minPx) {
  const room = size - bar;
  if (!(room > 0)) return SPLIT_DEFAULT.h;
  const lo = Math.max(SPLIT_LO, Math.min(0.5, minPx / room)), hi = 1 - lo;
  return clamp((pos - start - bar / 2) / room, lo, hi);
}
/* the two flex shares for a grid: "fr" below a total of 1 would not fill the space, so scale up */
const shares = r => [Math.round(r * 1000) / 10, Math.round((1 - r) * 1000) / 10];
const nudge = (r, by) => clamp(Math.round((r + by) * 1000) / 1000, SPLIT_LO, SPLIT_HI);

/* ---------- text size ---------- */
const FS_MIN = 10, FS_MAX = 28;
/* 0 means the stylesheet's own size (13px, or 16px on a phone). The line height is a whole number of pixels, so the line numbers stay on their lines. */
const normFs = n => typeof n === 'number' && isFinite(n) && n > 0 ? clamp(Math.round(n), FS_MIN, FS_MAX) : 0;
const metrics = fs => ({ fs, lh: Math.round(fs * 1.5) });

/* ---------- brackets ---------- */
const OPEN = { '{': '}', '[': ']' }, CLOSE = { '}': '{', ']': '[' };
/* Every bracket outside strings and comments, with its partner: Map of offset -> offset, or -1 when it has none
   (never closed, or a closer of the wrong kind). One pass over the text. */
function pairs(text) {
  const map = new Map(), stack = [], n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') { i++; while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (OPEN[ch]) stack.push(i);
    else if (CLOSE[ch]) {
      if (stack.length && text[stack[stack.length - 1]] === CLOSE[ch]) { const o = stack.pop(); map.set(o, i); map.set(i, o); }
      else map.set(i, -1);
    }
    i++;
  }
  for (const o of stack) map.set(o, -1);
  return map;
}
/* The bracket the caret touches: the one just before it, else the one just after. Returns null, or
   { at, to } with to === -1 when it has no partner. */
function touching(text, caret, map) {
  for (const p of [caret - 1, caret]) if (p >= 0 && p < text.length && map.has(p)) return { at: p, to: map.get(p) };
  return null;
}

/* ---------- syntax colours for stdin ---------- */
const HL_MAX = 200000;               /* characters; above this stdin is drawn plain */
/* HTML for the text behind the textarea: colour spans from the search code's tokenizer, and the bracket the
   caret touches boxed together with its partner, or flagged when it has none. Removing the tags gives the text back exactly. */
function highlight(text, touch) {
  const marks = [];
  let bad = -1;
  if (touch) {
    if (touch.to < 0) { marks.push([touch.at, touch.at + 1]); bad = 0; }
    else { const a = Math.min(touch.at, touch.to), b = Math.max(touch.at, touch.to); marks.push([a, a + 1], [b, b + 1]); }
  }
  return JF.find.paint(text, JF.find.tokens(text), marks, bad);
}

/* ---------- the caret ---------- */
/* 1-based line and column of an offset (a column counts UTF-16 units, like the error messages do) */
function caretPos(text, at) {
  let line = 1, last = -1;
  for (let j = text.indexOf('\n'); j !== -1 && j < at; j = text.indexOf('\n', j + 1)) { line++; last = j; }
  return { line, col: at - last };
}

JF.layout = { SPLIT_DEFAULT, clampRatio, normSplit, ratioAt, shares, nudge, FS_MIN, FS_MAX, normFs, metrics, pairs, touching, HL_MAX, highlight, caretPos };
})();
