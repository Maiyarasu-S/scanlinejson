/* images.js: the share image for each page (1200 x 630) and the icon set, drawn in the green theme. */
'use strict';
const { Bitmap, ico } = require('./png');
const font = require('./pixelfont');

/* the green theme's colours (css/style.css) */
const PAL = [[0x04, 0x09, 0x06], [0x02, 0x05, 0x03], [0x16, 0x3a, 0x27], [0x5d, 0x9d, 0x78], [0x3d, 0xff, 0x8f], [0xa9, 0xef, 0xc0]];
const BG = 0, SCAN = 1, LINE = 2, DIM = 3, HI = 4, FG = 5;

function text(bm, s, x, y, scale, c) { font.draw(s, x, y, scale, (px, py, n) => bm.rect(px, py, n, n, c)); }
/* split `s` into lines that fit `max` characters, breaking at spaces */
function wrap(s, max) {
  const out = [];
  let line = '';
  for (const w of s.split(/\s+/)) {
    if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

/* Title large enough to read at 600 px wide: 9 px per font pixel, so each letter is 45 x 63 here. */
function og(title, name) {
  const W = 1200, H = 630, M = 72, bm = new Bitmap(W, H, PAL, BG);
  for (let y = 3; y < H; y += 4) bm.rect(0, y, W, 1, SCAN);                       /* faint scanlines */
  bm.rect(32, 32, W - 64, 3, LINE); bm.rect(32, H - 35, W - 64, 3, LINE);          /* frame */
  bm.rect(32, 32, 3, H - 64, LINE); bm.rect(W - 35, 32, 3, H - 64, LINE);
  text(bm, 'guest@json:~$', M, 80, 5, DIM);
  const S = 9, adv = (font.W + font.GAP) * S, lines = wrap(title.toLowerCase(), Math.floor((W - 2 * M + font.GAP * S) / adv) - 1).slice(0, 3);
  let y = 170;
  lines.forEach((l, i) => {
    text(bm, l, M, y, S, HI);
    if (i === lines.length - 1) bm.rect(M + l.length * adv + S, y, font.W * S, font.H * S, HI);   /* block cursor */
    y += font.H * S + 27;
  });
  const by = H - M - font.H * 6;
  text(bm, name.toLowerCase(), M, by, 6, FG);
  const tag = 'runs in your browser';
  text(bm, tag, W - M - font.measure(tag, 4), by + font.H * 6 - font.H * 4, 4, DIM);
  return bm.png();
}

/* Icon art on a 16 x 16 grid: a prompt chevron and a cursor. */
const ART = [
  '................',
  '................',
  '.##.............',
  '.###............',
  '..###...........',
  '...###..........',
  '....###.........',
  '.....###........',
  '....###.........',
  '...###..........',
  '..###...........',
  '.###.....######.',
  '.##......######.',
  '................',
  '................',
  '................',
];
function iconBitmap(size) {
  const scale = size <= 48 ? size / 16 : Math.floor(size * 0.8 / 16), off = Math.floor((size - 16 * scale) / 2), bm = new Bitmap(size, size, PAL, BG);
  ART.forEach((row, y) => { for (let x = 0; x < 16; x++) if (row[x] === '#') bm.rect(off + x * scale, off + y * scale, scale, scale, HI); });
  return bm;
}
const iconPng = size => iconBitmap(size).png();
const faviconIco = () => ico([16, 32, 48].map(iconPng));
/* the same art as vector rectangles, one per horizontal run */
function faviconSvg() {
  let d = '';
  ART.forEach((row, y) => { for (const m of row.matchAll(/#+/g)) d += 'M' + m.index + ' ' + y + 'h' + m[0].length + 'v1h-' + m[0].length + 'z'; });
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#040906"/><path fill="#3dff8f" d="' + d + '"/></svg>\n';
}

module.exports = { og, iconPng, faviconIco, faviconSvg, wrap };
