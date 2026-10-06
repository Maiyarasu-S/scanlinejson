/* core.js: parser, serialiser and small AST helpers.

   The whole library sits inside one function that touches nothing outside itself.
   app.js relies on that: it turns this function's source into a Web Worker so large
   inputs parse off the main thread. That also works when the page is opened straight
   from disk (file://), where a separate worker script would be blocked.

   AST node shapes
     { t:'o', e:[[key, node], ...] }   object, entries in source order, duplicates kept
     { t:'a', e:[node, ...] }          array (jl:true when it wraps a JSON Lines stream)
     { t:'s', v:'text' }               string
     { t:'n', v:'123.4' }              number, kept as source text so big integers stay exact
     { t:'b', v:'true'|'false' }       boolean
     { t:'z' }                         null
   A node carries dup:true when its key already appeared earlier in the same object. */
function jfCore() {
'use strict';

const ID = /[A-Za-z_$][\w$]*/y;
const JSONP = /[A-Za-z_$][\w$.]*\s*\(/y;
const FENCE = /```[\w-]*[ \t]*\r?\n?/y;
const HEXD = /[0-9a-fA-F]/;
const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const LAX_WORDS = { True: 'true', False: 'false', None: null, undefined: null, NaN: null, Infinity: null };
const TAILS = ['true', 'false', 'null'];
const MAX_LOG = 500, MAX_DUP = 200;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clip = w => '"' + (w.length > 24 ? w.slice(0, 24) + '…' : w) + '"';
const dig = c => c >= '0' && c <= '9';
const dq = c => c === 0x201C || c === 0x201D || c === 0x201E || c === 0x201F;   /* curly double quotes */
const sq = c => c === 0x2018 || c === 0x2019 || c === 0x201A || c === 0x201B;   /* curly single quotes */
const odd = c => c === 0xA0 || c === 0xFEFF || c === 0x2028 || c === 0x2029 || c === 0x3000 || c === 0x202F ||
                 c === 0x205F || c === 0x1680 || c === 11 || c === 12 || (c >= 0x2000 && c <= 0x200B);

/* ---------- parser: strict by default, lax mode powers auto-fix ----------
   Lax mode accepts what strict rejects and logs each repair as { at, msg }. */
function parse(t, lax) {
  let i = 0, n = t.length, nodes = 0, deep = 0, fixes = 0, dups = 0, cut = false;
  const fixLog = [], dupLog = [];
  const die = (m, at = i) => { const e = new Error(m); e.at = at; throw e; };
  const fix = (msg, at = i) => { fixes++; if (fixLog.length < MAX_LOG) fixLog.push({ at, msg }); };
  const word = () => { ID.lastIndex = i; const m = ID.exec(t); return m ? m[0] : ''; };

  function ws() {
    for (;;) {
      if (i >= n) return;
      const c = t.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else if (c === 47 && (t[i + 1] === '/' || t[i + 1] === '*')) {
        if (!lax) die('Comments are not allowed in JSON');
        fix('Comment');
        if (t[i + 1] === '/') { const e = t.indexOf('\n', i); i = e < 0 || e > n ? n : e; }
        else { const e = t.indexOf('*/', i + 2); if (e < 0 || e + 2 > n) die('Comment is never closed'); i = e + 2; }
      }
      else if (odd(c)) {
        if (!lax) die('Unusual whitespace character (U+' + c.toString(16).toUpperCase().padStart(4, '0') + '). JSON allows only spaces, tabs and line breaks');
        if (!(i > 0 && odd(t.charCodeAt(i - 1)))) fix('Non-standard whitespace');
        i++;
      }
      else return;
    }
  }

  /* kind: 0 "double", 1 'single', 2 curly double, 3 curly single */
  function str(kind) {
    const start = i;
    i++;
    let out = '', seg = i;
    for (;;) {
      if (i >= n) {
        if (!lax) die('String is never closed', start);
        fix('Unclosed string', start); cut = true;
        return out + t.slice(seg, i);
      }
      const c = t.charCodeAt(i);
      if (kind === 0 ? c === 34 : kind === 1 ? c === 39 : kind === 2 ? dq(c) : sq(c)) { out += t.slice(seg, i); i++; return out; }
      if (c === 92) {
        out += t.slice(seg, i);
        i++;
        if (i >= n) { if (!lax) die('String is never closed', start); fix('Unclosed string', start); cut = true; return out; }
        const e = t[i];
        if (hasOwn(ESC, e)) out += ESC[e];
        else if (e === 'u') {
          const h = t.substr(i + 1, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) {
            if (lax && i + 5 > n) { fix('Unclosed string', start); cut = true; i = n; return out; }
            die('\\u needs four hex digits', i - 1);
          }
          out += String.fromCharCode(parseInt(h, 16)); i += 4;
        }
        else if (!lax) die('Invalid escape \\' + e, i - 1);
        else {
          fix('Invalid escape \\' + e, i - 1);
          const h = t.substr(i + 1, 2);
          if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 2; }
          else out += e === 'v' ? '\v' : e === '0' ? '\0' : e;
        }
        seg = ++i;
      } else if (c < 32) {
        if (!lax) die(c === 10 || c === 13 ? 'Line break inside a string. Write \\n instead' : c === 9 ? 'Tab inside a string. Write \\t instead' : 'Control character inside a string');
        fix(c === 10 || c === 13 ? 'Raw line break inside a string' : c === 9 ? 'Raw tab inside a string' : 'Control character inside a string');
        i++;
      } else i++;
    }
  }

  function num() {
    const start = i;
    let neg = false;
    if (t[i] === '-') { neg = true; i++; }
    else if (t[i] === '+') { if (!lax) die('Numbers cannot start with "+"'); fix('Leading "+" on a number'); i++; }
    const hex = t[i] === '0' && (t[i + 1] === 'x' || t[i + 1] === 'X');
    if (lax) {
      const w = word();
      if (w === 'Infinity' || w === 'NaN') { i += w.length; fix(t.slice(start, i) + ' is not JSON, written as null', start); return { t: 'z' }; }
      if (hex) {
        let j = i + 2;
        while (j < n && HEXD.test(t[j])) j++;
        if (j === i + 2) die('Expected hex digits after "0x"', start);
        const v = (neg ? '-' : '') + BigInt(t.slice(i, j)).toString();
        fix('Hex number written as decimal', start); i = j;
        return { t: 'n', v };
      }
    } else if (hex) die('Hex numbers are not allowed in JSON', start);

    const s = i;
    let ip;
    if (t[i] === '0') { i++; if (dig(t[i])) die('Numbers cannot have leading zeros', start); ip = '0'; }
    else if (dig(t[i])) { while (dig(t[i])) i++; ip = t.slice(s, i); }
    else if (t[i] === '.' && dig(t[i + 1])) {
      if (!lax) die('Numbers need a digit before the decimal point', start);
      fix('Missing 0 before the decimal point', start); ip = '0';
    }
    else if (lax && i >= n) { fix('Unfinished number, written as null', start); cut = true; return { t: 'z' }; }
    else if (i === start) die('Expected a value, found "' + t[i] + '"');
    else die('Expected a digit after "' + t[start] + '"');

    let frac = '', ex = '';
    if (t[i] === '.') {
      const d0 = ++i;
      while (dig(t[i])) i++;
      if (i === d0) {
        if (!lax) die('Expected a digit after the decimal point');
        if (i >= n) { fix('Unfinished number', d0 - 1); cut = true; } else fix('Dangling decimal point', d0 - 1);
      } else frac = t.slice(d0 - 1, i);
    }
    if (t[i] === 'e' || t[i] === 'E') {
      const e0 = i++;
      if (t[i] === '+' || t[i] === '-') i++;
      const d0 = i;
      while (dig(t[i])) i++;
      if (i === d0) {
        if (!(lax && i >= n)) die('Expected a digit in the exponent');
        fix('Unfinished number', e0); cut = true;
      } else ex = t.slice(e0, i);
    }
    return { t: 'n', v: (neg ? '-' : '') + ip + frac + ex };
  }

  function arr(d) {
    const start = i++, e = [];
    const shut = () => { fix('Unclosed array', start); cut = true; return { t: 'a', e }; };
    ws();
    if (i < n && t[i] === ']') { i++; return { t: 'a', e }; }
    for (;;) {
      ws();
      if (i >= n) { if (lax) return shut(); die('Array is never closed', start); }
      if (lax && t[i] === ',') { fix('Extra comma'); i++; continue; }
      if (lax && t[i] === ']') { i++; return { t: 'a', e }; }       /* only reachable after an extra comma */
      e.push(val(d + 1));
      ws();
      if (i >= n) { if (lax) return shut(); die('Array is never closed', start); }
      const c = t[i];
      if (c === ',') {
        const at = i++; ws();
        if (i < n && t[i] === ']') { if (!lax) die('Trailing comma before "]"', at); fix('Trailing comma', at); i++; return { t: 'a', e }; }
      }
      else if (c === ']') { i++; return { t: 'a', e }; }
      else if (lax && c !== '}' && c !== ':' && c !== ')') fix('Missing comma');
      else die('Expected "," or "]"');
    }
  }

  function obj(d) {
    const start = i++, e = [], seen = new Map();
    const shut = () => { fix('Unclosed object', start); cut = true; return { t: 'o', e }; };
    ws();
    if (i < n && t[i] === '}') { i++; return { t: 'o', e }; }
    for (;;) {
      ws();
      if (i >= n) { if (lax) return shut(); die('Object is never closed', start); }
      const ks = i, c = t[i], cc = t.charCodeAt(i);
      let k;
      if (c === '"') k = str(0);
      else if (c === "'") { if (!lax) die('Keys need double quotes, not single quotes'); fix('Single-quoted key'); k = str(1); }
      else if (dq(cc) || sq(cc)) { if (!lax) die('Curly "smart" quotes are not valid here. Use straight double quotes'); fix('Smart quotes'); k = str(dq(cc) ? 2 : 3); }
      else if (lax && c === ',') { fix('Extra comma'); i++; continue; }
      else if (lax && c === '}') { i++; return { t: 'o', e }; }     /* only reachable after an extra comma */
      else {
        let w = word();
        if (!w && lax) { let j = i; while (dig(t[j])) j++; w = t.slice(i, j); }   /* {1: "a"} */
        if (!w) die('Expected a key in double quotes');
        if (!lax) die('Key ' + clip(w) + ' needs double quotes');
        fix('Unquoted key ' + clip(w)); i += w.length; k = w;
      }
      ws();
      if (i >= n && lax) { fix('Key cut off before its value, dropped', ks); cut = true; return { t: 'o', e }; }
      if (i >= n || t[i] !== ':') die('Expected ":" after the key');
      i++;
      const v = val(d + 1);
      const first = seen.get(k);
      if (first !== undefined) { dups++; v.dup = true; if (dupLog.length < MAX_DUP) dupLog.push({ at: ks, first, key: k }); }
      else seen.set(k, ks);
      e.push([k, v]);
      ws();
      if (i >= n) { if (lax) return shut(); die('Object is never closed', start); }
      const x = t[i];
      if (x === ',') {
        const at = i++; ws();
        if (i < n && t[i] === '}') { if (!lax) die('Trailing comma before "}"', at); fix('Trailing comma', at); i++; return { t: 'o', e }; }
      }
      else if (x === '}') { i++; return { t: 'o', e }; }
      else if (lax && x !== ']' && x !== ':' && x !== ')') fix('Missing comma');
      else die('Expected "," or "}"');
    }
  }

  function val(d) {
    ws();
    if (i >= n) {
      if (lax && d > 0) { fix('Missing value at the end, written as null'); cut = true; nodes++; return { t: 'z' }; }
      die('Unexpected end of input');
    }
    if (d > 1000) die('Nesting is deeper than 1000 levels');
    nodes++; if (d > deep) deep = d;
    const c = t[i];
    if (c === '{') return obj(d);
    if (c === '[') return arr(d);
    if (c === '"') return { t: 's', v: str(0) };
    if (c === "'") { if (!lax) die('Strings need double quotes, not single quotes'); fix('Single-quoted string'); return { t: 's', v: str(1) }; }
    if (c === '-' || c === '+' || c === '.' || dig(c)) return num();
    const cc = t.charCodeAt(i);
    if (dq(cc) || sq(cc)) {
      if (!lax) die('Curly "smart" quotes are not valid here. Use straight double quotes');
      fix('Smart quotes'); return { t: 's', v: str(dq(cc) ? 2 : 3) };
    }
    const w = word();
    if (w === 'true' || w === 'false') { i += w.length; return { t: 'b', v: w }; }
    if (w === 'null') { i += 4; return { t: 'z' }; }
    if (w) {
      if (hasOwn(LAX_WORDS, w)) {
        const to = LAX_WORDS[w];
        if (!lax) die(to === null ? w + ' is not allowed in JSON. Use null' : 'JSON spells ' + w + ' as ' + to);
        fix(w + ' is not JSON, written as ' + (to === null ? 'null' : to)); i += w.length;
        return to === null ? { t: 'z' } : { t: 'b', v: to };
      }
      if (lax && i + w.length >= n) {                             /* tru, fals, nul at the very end */
        const full = TAILS.find(x => x.startsWith(w));
        if (full) { fix('Unfinished ' + full); cut = true; i += w.length; return full === 'null' ? { t: 'z' } : { t: 'b', v: full }; }
      }
      die('Unexpected word ' + clip(w) + '. Strings need double quotes');
    }
    die('Expected a value, found "' + c + '"');
  }

  if (t.charCodeAt(0) === 0xFEFF) i = 1;
  let jsonp = false;
  if (lax) {
    ws();
    if (i < n && t[i] !== '{' && t[i] !== '[') {
      /* ```json ... ``` as pasted from a chat or a README, with or without prose around it */
      const f = t.indexOf('```', i);
      if (f >= 0 && !/[{\[]/.test(t.slice(i, f))) {
        fix('Markdown code fence', f);
        FENCE.lastIndex = f; i = f + FENCE.exec(t)[0].length;
        let close = t.indexOf('\n```', i);
        if (close < 0) close = t.indexOf('```', i);
        if (close >= 0) n = close;
        ws();
      }
    }
    JSONP.lastIndex = i;
    const m = i < n ? JSONP.exec(t) : null;
    if (m && i + m[0].length <= n) { fix('JSONP wrapper'); i += m[0].length; jsonp = true; }
  }

  const docs = [val(0)];
  let end = i;
  ws();
  if (jsonp) {
    if (i < n && t[i] === ')') { i++; ws(); if (i < n && t[i] === ';') { i++; ws(); } }
    else if (i < n) die('Expected ")" to close the JSONP wrapper');
    else cut = true;
  }
  /* More values, each starting on a later line, make this a JSON Lines stream. */
  while (i < n) {
    if (jsonp || t.lastIndexOf('\n', i - 1) < end) die('Unexpected content after the end of the JSON');
    const s = i;
    try { docs.push(val(0)); }
    catch (e) { if (docs.length === 1 && e.at === s) die('Unexpected content after the end of the JSON', s); throw e; }
    end = i;
    ws();
  }

  const jsonl = docs.length > 1;
  if (jsonl) { nodes++; deep++; }
  return { root: jsonl ? { t: 'a', e: docs, jl: true } : docs[0], nodes, depth: deep, fixes, fixLog, dups, dupLog, cut, jsonl, docs: docs.length };
}

/* Strict parse, and when that fails, a lax parse to see what auto-fix could do.
   Runs unchanged on the main thread and inside the worker. */
function analyse(t) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  let out;
  try { out = { ok: true, res: parse(t, false) }; }
  catch (e) {
    const deepErr = e.at === undefined;                            /* stack overflow, not a syntax error */
    let fixed = null;
    try { const r = parse(t, true); if (r.fixes) fixed = r; } catch (x) {}
    out = { ok: false, err: { message: deepErr ? 'Nesting is too deep to parse' : e.message, at: deepErr ? 0 : Math.min(e.at, t.length) }, fixed };
  }
  out.ms = now() - t0;
  return out;
}

/* ---------- serialising ---------- */
const cmp = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const ents = (nd, sort) => sort ? (nd.se || (nd.se = nd.e.slice().sort(cmp))) : nd.e;

/* w(cls, text) wraps each token, so the same walk gives plain text or highlighted HTML. */
function ser(root, ind, w, sort) {
  const out = [], nl = ind ? '\n' : '', sp = ind ? ' ' : '';
  (function go(nd, pad) {
    if (nd.t === 's') out.push(w('s', JSON.stringify(nd.v)));
    else if (nd.t === 'n') out.push(w('nu', nd.v));
    else if (nd.t === 'b') out.push(w('b', nd.v));
    else if (nd.t === 'z') out.push(w('z', 'null'));
    else {
      const o = nd.t === 'o', list = o ? ents(nd, sort) : nd.e;
      if (!list.length) { out.push(o ? '{}' : '[]'); return; }
      const p2 = pad + ind;
      out.push(o ? '{' : '[');
      for (let j = 0; j < list.length; j++) {
        out.push(j ? ',' + nl + p2 : nl + p2);
        if (o) { out.push(w('k', JSON.stringify(list[j][0])), ':' + sp); go(list[j][1], p2); }
        else go(list[j], p2);
      }
      out.push(nl + pad, o ? '}' : ']');
    }
  })(root, '');
  return out.join('');
}

/* ---------- helpers shared by query, diff and validation ---------- */
const NAMES = { o: 'object', a: 'array', s: 'string', n: 'number', b: 'boolean', z: 'null' };
const typeName = nd => NAMES[nd.t];

/* Canonical text: keys sorted, last duplicate wins, 1.0 and 1 read the same. Equal text means equal value. */
function cnum(v) {
  if (/^-?\d+$/.test(v)) return v === '-0' ? '0' : v;
  const x = Number(v);
  return Number.isFinite(x) ? String(x) : v;
}
function canon(nd) {
  switch (nd.t) {
    case 's': return JSON.stringify(nd.v);
    case 'n': return cnum(nd.v);
    case 'b': return nd.v;
    case 'z': return 'null';
    case 'a': return '[' + nd.e.map(canon).join(',') + ']';
    default: {
      const m = new Map();
      for (const kv of nd.e) m.set(kv[0], kv[1]);
      return '{' + [...m.keys()].sort().map(k => JSON.stringify(k) + ':' + canon(m.get(k))).join(',') + '}';
    }
  }
}

function toJS(nd) {
  switch (nd.t) {
    case 's': return nd.v;
    case 'n': return Number(nd.v);
    case 'b': return nd.v === 'true';
    case 'z': return null;
    case 'a': return nd.e.map(toJS);
    default: {
      const o = {};
      for (const kv of nd.e) Object.defineProperty(o, kv[0], { value: toJS(kv[1]), enumerable: true, writable: true, configurable: true });
      return o;
    }
  }
}
function fromJS(v) {
  if (v === null || v === undefined) return { t: 'z' };
  if (typeof v === 'string') return { t: 's', v };
  if (typeof v === 'number') return Number.isFinite(v) ? { t: 'n', v: String(v) } : { t: 'z' };
  if (typeof v === 'boolean') return { t: 'b', v: v ? 'true' : 'false' };
  if (Array.isArray(v)) return { t: 'a', e: v.map(fromJS) };
  return { t: 'o', e: Object.keys(v).map(k => [k, fromJS(v[k])]) };
}

/* ---------- offsets to line and column ---------- */
function locate(t, at) {
  let line = 1, ls = 0;
  for (let j = t.indexOf('\n'); j !== -1 && j < at; j = t.indexOf('\n', j + 1)) { line++; ls = j + 1; }
  let le = t.indexOf('\n', at); if (le < 0) le = t.length;
  return { line, col: at - ls + 1, ls, le };
}
/* Same, for many offsets in one pass. `ats` must be sorted ascending. */
function lines(t, ats) {
  const out = [];
  let line = 1, ls = 0, j = t.indexOf('\n');
  for (const at of ats) {
    while (j !== -1 && j < at) { line++; ls = j + 1; j = t.indexOf('\n', j + 1); }
    out.push({ line, col: at - ls + 1 });
  }
  return out;
}

/* ---------- moving a parsed tree between threads ----------
   Posting the tree itself makes the receiving thread rebuild millions of small objects in one go,
   which freezes the page about as long as parsing would have. So the worker flattens the tree into
   three typed arrays (transferred, not copied) plus one string holding every key and value end to
   end, and the page rebuilds it in short slices between which it stays responsive.

   Per node, in document order: kind (0 object, 1 array, 2 string, 3 number, 4 true, 5 false, 6 null,
   +8 duplicate key, +16 JSON Lines wrapper) and len (child count, or text length). klen holds the
   key length for each object entry. */
function pack(res) {
  const n = res.nodes + 1, kind = new Uint8Array(n), len = new Uint32Array(n), klen = new Uint32Array(n), parts = [];
  let i = 0, k = 0, ok = true;
  (function go(nd) {
    if (i >= n) { ok = false; return; }
    const at = i++, dup = nd.dup ? 8 : 0;
    if (nd.t === 'o') {
      kind[at] = dup; len[at] = nd.e.length;
      for (const kv of nd.e) { if (!ok) return; klen[k++] = kv[0].length; parts.push(kv[0]); go(kv[1]); }
    }
    else if (nd.t === 'a') { kind[at] = 1 | dup | (nd.jl ? 16 : 0); len[at] = nd.e.length; for (const x of nd.e) { if (!ok) return; go(x); } }
    else if (nd.t === 's' || nd.t === 'n') { kind[at] = (nd.t === 's' ? 2 : 3) | dup; len[at] = nd.v.length; parts.push(nd.v); }
    else kind[at] = (nd.t === 'z' ? 6 : nd.v === 'true' ? 4 : 5) | dup;
  })(res.root);
  return ok ? { n: i, kind, len, klen, blob: parts.join('') } : null;
}
/* Returns step(ms): call it until it gives back the root. Each call works for about `ms` milliseconds. */
function unpacker(p) {
  const n = p.n, kind = p.kind, len = p.len, klen = p.klen, blob = p.blob, stack = [];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let i = 0, k = 0, sp = 0, root;
  return function step(ms) {
    const until = now() + ms;
    while (i < n) {
      const kd = kind[i], L = len[i], t = kd & 7, top = stack.length ? stack[stack.length - 1] : null;
      i++;
      let key, nd;
      if (top && top.o) { const kl = klen[k++]; key = blob.slice(sp, sp + kl); sp += kl; }
      if (t === 0) nd = { t: 'o', e: [] };
      else if (t === 1) { nd = { t: 'a', e: [] }; if (kd & 16) nd.jl = true; }
      else if (t === 2 || t === 3) { nd = { t: t === 2 ? 's' : 'n', v: blob.slice(sp, sp + L) }; sp += L; }
      else nd = t === 6 ? { t: 'z' } : { t: 'b', v: t === 4 ? 'true' : 'false' };
      if (kd & 8) nd.dup = true;
      if (!top) root = nd;
      else { top.nd.e.push(top.o ? [key, nd] : nd); top.left--; }
      if (t < 2 && L) stack.push({ nd, left: L, o: t === 0 });
      else while (stack.length && stack[stack.length - 1].left === 0) stack.pop();
      if ((i & 1023) === 0 && now() >= until) return undefined;
    }
    return root;
  };
}

return { parse, analyse, ser, ents, canon, typeName, toJS, fromJS, locate, lines, pack, unpacker };
}

globalThis.JF = globalThis.JF || {};
JF.core = jfCore();
