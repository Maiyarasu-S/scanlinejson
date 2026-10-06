/* convert.js: turn a parsed document into YAML, CSV, TypeScript interfaces or a JSON Schema. */
(() => {
'use strict';
const C = JF.core;

/* ---------- YAML ---------- */
const PLAIN = /^[A-Za-z_\/][A-Za-z0-9_\/.@+() -]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n)$/i;
/* Double-quoted YAML accepts JSON's escapes, so JSON.stringify output is a valid YAML scalar. */
const quoted = s => JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const ystr = s => PLAIN.test(s) && !RESERVED.test(s) && s[s.length - 1] !== ' ' ? s : quoted(s);
/* A multi-line string can use a literal block only when nothing in it depends on exact whitespace handling. */
const blockable = s => s.indexOf('\n') > 0 && /^\S/.test(s) && !/[^\n\x20-\x7e\u00a1-\ud7ff\ue000-\ufefe]/.test(s) &&
                       !/ (\n|$)/.test(s) && !/\n\n$/.test(s);

function yaml(root, width, sort) {
  const I = ' '.repeat(width), lines = [];
  /* lead: what is already on the current line ("key:", "-" or nothing). pad: indent for this value's own lines.
     dash: the value follows a list dash, so its first key or item shares that line. */
  function emit(nd, lead, pad, dash) {
    if (nd.t === 'o' && nd.e.length) {
      const list = C.ents(nd, sort);
      for (let j = 0; j < list.length; j++) {
        const k = ystr(list[j][0]) + ':';
        if (j === 0 && dash) emit(list[j][1], lead + ' ' + k, pad + I, false);
        else { if (j === 0 && lead) lines.push(lead); emit(list[j][1], pad + k, pad + I, false); }
      }
    } else if (nd.t === 'a' && nd.e.length) {
      for (let j = 0; j < nd.e.length; j++) {
        if (j === 0 && dash) emit(nd.e[j], lead + ' -', pad + '  ', true);
        else { if (j === 0 && lead) lines.push(lead); emit(nd.e[j], pad + '-', pad + '  ', true); }
      }
    } else if (nd.t === 's' && lead && blockable(nd.v)) {
      const clipEnd = nd.v[nd.v.length - 1] === '\n';
      lines.push(lead + ' |' + (clipEnd ? '' : '-'));
      for (const l of (clipEnd ? nd.v.slice(0, -1) : nd.v).split('\n')) lines.push(l ? pad + l : '');
    } else {
      const v = nd.t === 's' ? ystr(nd.v) : nd.t === 'n' || nd.t === 'b' ? nd.v : nd.t === 'z' ? 'null' : nd.t === 'a' ? '[]' : '{}';
      lines.push(lead ? lead + ' ' + v : v);
    }
  }
  emit(root, '', '', false);
  return lines.join('\n') + '\n';
}

/* ---------- CSV ---------- */
const cell = s => /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
const flat = nd => nd.t === 's' || nd.t === 'n' || nd.t === 'b' ? nd.v : nd.t === 'z' ? '' : C.ser(nd, '', (c, s) => s, false);

function csv(root) {
  const rows = root.t === 'a' ? root.e : root.t === 'o' ? [root] : null;
  if (!rows) throw new Error('CSV needs an array of objects (or one object). This value is a ' + C.typeName(root));
  if (!rows.length) throw new Error('This array is empty, so there are no rows to write');
  if (rows.every(r => r.t === 'a')) return rows.map(r => r.e.map(x => cell(flat(x))).join(',')).join('\n') + '\n';
  const cols = new Map(), recs = [];
  /* Nested objects become dotted columns. Arrays stay in one cell as JSON. */
  function spread(nd, prefix, rec) {
    for (const kv of nd.e) {
      const name = prefix + kv[0], v = kv[1];
      if (v.t === 'o' && v.e.length) spread(v, name + '.', rec);
      else { if (!cols.has(name)) cols.set(name, cols.size); rec.set(name, flat(v)); }
    }
  }
  for (const r of rows) {
    const rec = new Map();
    if (r.t === 'o') spread(r, '', rec);
    else { if (!cols.has('value')) cols.set('value', cols.size); rec.set('value', flat(r)); }
    recs.push(rec);
  }
  const names = [...cols.keys()];
  return [names.map(cell).join(',')].concat(recs.map(rec => names.map(c => cell(rec.has(c) ? rec.get(c) : '')).join(','))).join('\n') + '\n';
}

/* ---------- shape inference, shared by TypeScript and JSON Schema ----------
   { k:'s'|'i'|'n'|'b'|'z' }   string, integer, number, boolean, null
   { k:'a', el:shape|null }    array (el is null when no element was ever seen)
   { k:'o', props:Map(key -> { sh, opt }) }
   { k:'u', m:[shape, ...] }   union, at most one member per kind */
const kindOf = s => s.k === 'i' || s.k === 'n' ? 'num' : s.k;

function shape(nd) {
  switch (nd.t) {
    case 's': return { k: 's' };
    case 'n': return { k: Number.isInteger(Number(nd.v)) ? 'i' : 'n' };
    case 'b': return { k: 'b' };
    case 'z': return { k: 'z' };
    case 'a': { let el = null; for (const x of nd.e) el = merge(el, shape(x)); return { k: 'a', el }; }
    default: {
      const props = new Map();
      for (const kv of nd.e) { const had = props.get(kv[0]); props.set(kv[0], { sh: had ? merge(had.sh, shape(kv[1])) : shape(kv[1]), opt: false }); }
      return { k: 'o', props };
    }
  }
}
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.k === 'u' || b.k === 'u' || kindOf(a) !== kindOf(b)) {
    const m = a.k === 'u' ? a.m : [a];
    for (const x of b.k === 'u' ? b.m : [b]) {
      const at = m.findIndex(y => kindOf(y) === kindOf(x));
      if (at < 0) m.push(x); else m[at] = merge(m[at], x);
    }
    return { k: 'u', m };
  }
  if (a.k === 'a') { a.el = merge(a.el, b.el); return a; }
  if (a.k === 'o') {
    for (const [k, pr] of a.props) if (!b.props.has(k)) pr.opt = true;
    for (const [k, pr] of b.props) {
      const had = a.props.get(k);
      if (had) { had.sh = merge(had.sh, pr.sh); had.opt = had.opt || pr.opt; } else a.props.set(k, { sh: pr.sh, opt: true });
    }
    return a;
  }
  return a.k === b.k ? a : { k: 'n' };            /* integer meets number */
}

/* ---------- TypeScript ---------- */
const TS_IDENT = /^[A-Za-z_$][\w$]*$/;
const pascal = s => String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const singular = s => /ies$/i.test(s) ? s.slice(0, -3) + 'y' : /(ss|us|is)$/i.test(s) ? s : /s$/i.test(s) ? s.slice(0, -1) : s;

function ts(root, ind) {
  const decl = [], byBody = new Map(), used = new Set(['Root']);
  function fresh(hint) {
    let base = pascal(hint) || 'Item';
    if (/^\d/.test(base)) base = '_' + base;
    let nm = base;
    for (let k = 2; used.has(nm); k++) nm = base + k;
    used.add(nm);
    return nm;
  }
  function body(s) {
    let b = '';
    for (const [k, pr] of s.props) b += ind + (TS_IDENT.test(k) ? k : JSON.stringify(k)) + (pr.opt ? '?' : '') + ': ' + ty(pr.sh, k) + ';\n';
    return b;
  }
  function ty(s, hint) {
    if (!s) return 'unknown';
    switch (s.k) {
      case 's': return 'string';
      case 'i': case 'n': return 'number';
      case 'b': return 'boolean';
      case 'z': return 'null';
      case 'u': return s.m.map(m => ty(m, hint)).join(' | ');
      case 'a': { const el = ty(s.el, singular(hint)); return (el.indexOf(' | ') >= 0 ? '(' + el + ')' : el) + '[]'; }
      default: {
        if (!s.props.size) return 'Record<string, unknown>';
        const b = body(s);
        let nm = byBody.get(b);                    /* identical shapes share one interface */
        if (!nm) { nm = fresh(hint); byBody.set(b, nm); decl.push('export interface ' + nm + ' {\n' + b + '}'); }
        return nm;
      }
    }
  }
  const sh = shape(root);
  if (sh.k === 'o' && sh.props.size) decl.push('export interface Root {\n' + body(sh) + '}');
  else decl.push('export type Root = ' + ty(sh, 'RootItems') + ';');
  return decl.reverse().join('\n\n') + '\n';
}

/* ---------- JSON Schema (built as an AST so the tree view can show it) ---------- */
const TYPE = { s: 'string', i: 'integer', n: 'number', b: 'boolean', z: 'null', a: 'array', o: 'object' };
const str = v => ({ t: 's', v });
const obj = e => ({ t: 'o', e });

function schemaOf(s) {
  if (s.k === 'u') {
    if (s.m.every(m => m.k !== 'a' && m.k !== 'o')) return obj([['type', { t: 'a', e: s.m.map(m => str(TYPE[m.k])) }]]);
    return obj([['anyOf', { t: 'a', e: s.m.map(schemaOf) }]]);
  }
  const e = [['type', str(TYPE[s.k])]];
  if (s.k === 'a' && s.el) e.push(['items', schemaOf(s.el)]);
  if (s.k === 'o') {
    const req = [];
    e.push(['properties', obj([...s.props].map(([k, pr]) => { if (!pr.opt) req.push(str(k)); return [k, schemaOf(pr.sh)]; }))]);
    if (req.length) e.push(['required', { t: 'a', e: req }]);
  }
  return obj(e);
}
function schema(root) {
  const s = schemaOf(shape(root));
  s.e.unshift(['$schema', str('https://json-schema.org/draft/2020-12/schema')]);
  return s;
}

JF.convert = { yaml, csv, ts, schema };
})();
