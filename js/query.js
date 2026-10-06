/* query.js: the prompt-line query language. JSONPath and a small jq subset share one grammar.

     $.users[0].name      .users[0].name       $["odd key"]      $.a.b?
     $.users[*].name      .users[].name        $..name           $.ports[1:3]     $.ports[-1]
     $.users[?(@.sudo)]   $.users[?(@.id > 1001 && @.name != "ada")]
     .users[] | select(.sudo) | .name          .users | map(.name) | sort
     [.users[] | select(.id >= 1002)] | length

   pipe := or ('|' or)*          or  := and (('||' | 'or') and)*
   and  := cmp (('&&' | 'and') cmp)*           cmp := term (op term)?
   term := literal | '!' term | '(' pipe ')' | '[' pipe ']' | function | path

   Every expression maps one input to a stream of outputs, as in jq. Each output remembers the
   path it came from when it is a real node of the document, so the tree can still show it. */
(() => {
'use strict';
const C = JF.core;
const SAFE = /^[A-Za-z_$][\w$]*$/;
const IDENT = /[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/y;
const NUMLIT = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
const INT = /-?\d+/y;
const LIMIT = 200000;

const S = v => ({ t: 's', v });
const N = v => ({ t: 'n', v: String(v) });
const B = v => ({ t: 'b', v: v ? 'true' : 'false' });
const Z = () => ({ t: 'z' });
const A = (e, cp) => { const a = { t: 'a', e }; if (cp) a.cp = cp; return a; };   /* cp: source path of each element */
const sub = (p, k) => p === null ? null : p + (SAFE.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
const at = (nd, p, j) => nd.cp ? nd.cp[j] : p === null ? null : p + '[' + j + ']';
const one = nd => [{ nd, p: null }];

/* name: 0 = no argument, 1 = one argument */
const FN = { length: 0, keys: 0, keys_unsorted: 0, values: 0, type: 0, first: 0, last: 0, sort: 0, unique: 0, reverse: 0,
             flatten: 0, add: 0, min: 0, max: 0, to_entries: 0, not: 0, select: 1, map: 1, sort_by: 1, has: 1,
             test: 1, contains: 1, startswith: 1, endswith: 1 };

/* ---------- compile ---------- */
function compile(text) {
  let p = 0;
  const n = text.length;
  const fail = (m, where = p) => { const e = new Error(m); e.col = where + 1; throw e; };
  const sp = () => { while (p < n && /\s/.test(text[p])) p++; };
  const eat = s => { if (text.startsWith(s, p)) { p += s.length; return true; } return false; };
  const need = s => { sp(); if (!eat(s)) fail('Expected "' + s + '"'); };
  const kw = w => { if (text.startsWith(w, p) && !/[\w$]/.test(text[p + w.length] || '')) { p += w.length; return true; } return false; };
  const ident = () => { IDENT.lastIndex = p; const m = IDENT.exec(text); return m ? m[0] : ''; };
  const int = () => { INT.lastIndex = p; const m = INT.exec(text); if (!m) return null; p += m[0].length; return +m[0]; };

  function string() {
    const q = text[p], start = p;
    let out = '';
    p++;
    for (;;) {
      if (p >= n) fail('String is never closed', start);
      const c = text[p++];
      if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = text[p++];
      if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(p, 4))) { out += String.fromCharCode(parseInt(text.substr(p, 4), 16)); p += 4; }
      else out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === undefined ? '' : e;
    }
  }

  function pipe() {
    let l = or();
    for (;;) {
      sp();
      if (text[p] === '|' && text[p + 1] !== '|') { p++; l = { k: 'pipe', l, r: or() }; }
      else return l;
    }
  }
  function or() {
    let l = and();
    for (;;) { sp(); if (eat('||') || kw('or')) l = { k: 'or', l, r: and() }; else return l; }
  }
  function and() {
    let l = cmp();
    for (;;) { sp(); if (eat('&&') || kw('and')) l = { k: 'and', l, r: cmp() }; else return l; }
  }
  function cmp() {
    const l = term();
    sp();
    for (const op of ['===', '!==', '==', '!=', '<=', '>=', '<', '>'])
      if (eat(op)) return { k: 'cmp', op: op.slice(0, 2) === '==' ? '==' : op === '!==' ? '!=' : op, l, r: term() };
    return l;
  }

  function term() {
    sp();
    const c = text[p], start = p;
    let node;
    if (c === undefined) fail('Expected a path, like $.users[0].name');
    if (c === '(') { p++; node = pipe(); need(')'); }
    else if (c === '!') { p++; return { k: 'not', e: term() }; }
    else if (c === '"' || c === "'") node = { k: 'lit', v: S(string()) };
    else if (c === '[') {
      p++; sp();
      if (eat(']')) node = { k: 'lit', v: A([]) };
      else { const e = pipe(); need(']'); node = { k: 'collect', e }; }
    }
    else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMLIT.lastIndex = p;
      const m = NUMLIT.exec(text);
      if (!m) fail('Unexpected "' + c + '"');
      p += m[0].length; node = { k: 'lit', v: N(m[0]) };
    }
    else if (c === '$') { p++; node = { k: 'root' }; }
    else if (c === '@') { p++; node = { k: 'this' }; }
    else if (c === '.') node = { k: 'this', dot: true };
    else {
      const w = ident();
      if (!w) fail('Unexpected "' + c + '"');
      p += w.length;
      if (w === 'true' || w === 'false') node = { k: 'lit', v: B(w === 'true') };
      else if (w === 'null') node = { k: 'lit', v: Z() };
      else {
        if (!Object.prototype.hasOwnProperty.call(FN, w))
          fail('Unknown word "' + w + '". Paths start with $ or a dot, like $.' + w, start);
        const args = [];
        sp();
        if (FN[w]) { if (!eat('(')) fail(w + ' needs an argument, like ' + w + '(…)'); args.push(pipe()); need(')'); }
        else if (eat('(')) need(')');
        node = { k: 'fn', name: w, args };
      }
    }
    return steps(node);
  }

  function name(st) {
    const c = text[p];
    if (c === '*') { p++; st.push({ s: 'wild' }); return true; }
    if (c === '"' || c === "'") { st.push({ s: 'key', k: string() }); return true; }
    const w = ident();
    if (!w) return false;
    p += w.length; st.push({ s: 'key', k: w });
    return true;
  }

  function steps(base) {
    const st = [];
    let lone = base.dot === true;                 /* a bare "." is the identity, but only on its own */
    for (;;) {
      const c = text[p];
      if (c === '.') {
        if (text[p + 1] === '.') { p += 2; st.push({ s: 'desc' }); name(st); }
        else { p++; if (!name(st) && text[p] !== '[' && !lone) fail('Expected a key after "."'); }
      }
      else if (c === '[') { p++; bracket(st); }
      else if (c === '?') p++;                    /* jq's "optional" marker: missing keys are already skipped */
      else break;
      lone = false;
    }
    return st.length ? { k: 'path', base, st } : base;
  }

  function bracket(st) {
    sp();
    if (eat(']')) { st.push({ s: 'wild' }); return; }
    if (eat('*')) { need(']'); st.push({ s: 'wild' }); return; }
    if (eat('?')) { const e = pipe(); need(']'); st.push({ s: 'filter', e }); return; }
    const parts = [];
    for (;;) {
      sp();
      const c = text[p];
      if (c === '"' || c === "'") parts.push({ key: string() });
      else {
        const a = int();
        sp();
        if (text[p] === ':') {
          p++; sp();
          const b = int();
          sp();
          let step = null;
          if (text[p] === ':') { p++; sp(); step = int(); sp(); }
          if (step !== null && step < 1) fail('Slice steps must be 1 or more');
          parts.push({ slice: [a, b, step === null ? 1 : step] });
        }
        else if (a === null) fail('Expected an index, a slice, a quoted key, * or ?(…)');
        else parts.push({ idx: a });
      }
      sp();
      if (eat(',')) continue;
      need(']');
      break;
    }
    const only = parts.length === 1 ? parts[0] : null;
    if (only && only.key !== undefined) st.push({ s: 'key', k: only.key });
    else if (only && only.idx !== undefined) st.push({ s: 'idx', i: only.idx });
    else if (only) st.push({ s: 'slice', sl: only.slice });
    else st.push({ s: 'union', parts });
  }

  const ast = pipe();
  sp();
  if (p < n) fail('Unexpected "' + text[p] + '"');
  return ast;
}

/* Can this expression give more than one output? Decides whether results show as a list of matches. */
function multi(e) {
  if (e.k === 'path') return multi(e.base) || e.st.some((s, j) => s.s === 'wild' || s.s === 'desc' || s.s === 'filter' || s.s === 'union' ||
                                                                 (s.s === 'slice' && e.st.slice(j + 1).some(x => x.s === 'key')));
  if (e.k === 'pipe') return multi(e.l) || multi(e.r);
  return false;
}

/* ---------- evaluate ---------- */
const truthy = it => !!it && it.nd.t !== 'z' && !(it.nd.t === 'b' && it.nd.v === 'false');
const isInt = v => /^-?\d+$/.test(v);
const RANK = { z: 0, b: 1, n: 3, s: 4, a: 5, o: 6 };
const rank = nd => nd.t === 'b' ? (nd.v === 'true' ? 2 : 1) : RANK[nd.t];

/* jq's ordering: null < false < true < numbers < strings < arrays < objects */
function order(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a.t === 'n') {
    if (isInt(a.v) && isInt(b.v)) { const x = BigInt(a.v), y = BigInt(b.v); return x < y ? -1 : x > y ? 1 : 0; }
    return Number(a.v) - Number(b.v);
  }
  if (a.t === 's') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.t === 'a' || a.t === 'o') { const x = C.canon(a), y = C.canon(b); return x < y ? -1 : x > y ? 1 : 0; }
  return 0;
}
function compare(op, a, b) {
  if (op === '==' || op === '!=') {
    const same = a.t === b.t && (a.t === 'z' || (a.t === 's' || a.t === 'b' ? a.v === b.v : C.canon(a) === C.canon(b)));
    return (op === '==') === same;
  }
  if (a.t !== b.t || (a.t !== 'n' && a.t !== 's')) return false;
  const d = order(a, b);
  return op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d >= 0;
}

function children(it, out) {
  const nd = it.nd;
  if (nd.t === 'a') for (let j = 0; j < nd.e.length; j++) out.push({ nd: nd.e[j], p: at(nd, it.p, j) });
  else if (nd.t === 'o') for (const kv of nd.e) out.push({ nd: kv[1], p: sub(it.p, kv[0]) });
}
function descend(it, out) {
  out.push(it);
  if (out.length > LIMIT) throw new Error('More than ' + LIMIT.toLocaleString('en') + ' matches. Narrow the query');
  const kids = [];
  children(it, kids);
  for (const k of kids) descend(k, out);
}
function key(it, k, out) {
  const nd = it.nd;
  if (nd.sp) { const kids = []; children(it, kids); for (const c of kids) key(c, k, out); return; }   /* $.users[0:2].name */
  if (nd.t !== 'o') return;
  for (let j = nd.e.length - 1; j >= 0; j--) if (nd.e[j][0] === k) { out.push({ nd: nd.e[j][1], p: sub(it.p, k) }); return; }
}
function index(it, i, out) {
  const nd = it.nd;
  if (nd.t !== 'a') return;
  const j = i < 0 ? nd.e.length + i : i;
  if (j >= 0 && j < nd.e.length) out.push({ nd: nd.e[j], p: at(nd, it.p, j) });
}
function slice(it, sl, out) {
  const nd = it.nd;
  if (nd.t !== 'a') return;
  const len = nd.e.length, fixIdx = (v, dflt) => v === null ? dflt : Math.max(0, Math.min(len, v < 0 ? len + v : v));
  for (let j = fixIdx(sl[0], 0), to = fixIdx(sl[1], len); j < to; j += sl[2]) out.push({ nd: nd.e[j], p: at(nd, it.p, j) });
}

function step(s, cur, root) {
  const out = [];
  for (const it of cur) {
    if (s.s === 'key') key(it, s.k, out);
    else if (s.s === 'idx') index(it, s.i, out);
    else if (s.s === 'wild') children(it, out);
    else if (s.s === 'desc') descend(it, out);
    else if (s.s === 'slice') {
      /* A lone slice gives one array, as in jq, so "| length" counts it. A key right after it still reaches
         into each item, as in JSONPath. */
      if (it.nd.t === 'a') { const xs = []; slice(it, s.sl, xs); const a = A(xs.map(x => x.nd), xs.map(x => x.p)); a.sp = true; out.push({ nd: a, p: null }); }
    }
    else if (s.s === 'filter') { const kids = []; children(it, kids); for (const c of kids) if (truthy(run(s.e, c, root)[0])) out.push(c); }
    else for (const part of s.parts) {
      if (part.key !== undefined) key(it, part.key, out);
      else if (part.idx !== undefined) index(it, part.idx, out);
      else slice(it, part.slice, out);
    }
    if (out.length > LIMIT) throw new Error('More than ' + LIMIT.toLocaleString('en') + ' matches. Narrow the query');
  }
  return out;
}

function call(e, it, root) {
  const nd = it.nd, fn = e.name, tn = C.typeName(nd);
  const wants = (types, what) => { if (types.indexOf(nd.t) < 0) throw new Error(fn + ' works on ' + what + ', not on ' + (nd.t === 'z' ? 'null' : 'a ' + tn)); };
  const items = () => { const out = []; children(it, out); return out; };
  const arg = () => run(e.args[0], it, root)[0];
  const strArg = () => { const a = arg(); if (!a || a.nd.t !== 's') throw new Error(fn + ' needs a string argument, like ' + fn + '("text")'); return a.nd.v; };
  const list = xs => one(A(xs.map(x => x.nd), xs.map(x => x.p)));
  switch (fn) {
    case 'length':
      if (nd.t === 'a' || nd.t === 'o') return one(N(nd.e.length));
      if (nd.t === 's') return one(N([...nd.v].length));
      if (nd.t === 'z') return one(N(0));
      if (nd.t === 'n') return one(N(nd.v.replace(/^-/, '')));
      wants([], 'arrays, objects, strings and numbers');
      break;
    case 'keys': case 'keys_unsorted': {
      wants(['o', 'a'], 'objects and arrays');
      if (nd.t === 'a') return one(A(nd.e.map((x, j) => N(j))));
      const ks = [...new Set(nd.e.map(kv => kv[0]))];
      if (fn === 'keys') ks.sort();
      return one(A(ks.map(S)));
    }
    case 'values': wants(['o', 'a'], 'objects and arrays'); return list(items());
    case 'type': return one(S(tn));
    case 'first': case 'last': {
      wants(['a'], 'arrays');
      const out = [];
      index(it, fn === 'first' ? 0 : -1, out);
      return out;
    }
    case 'sort': wants(['a'], 'arrays'); return list(items().sort((x, y) => order(x.nd, y.nd)));
    case 'sort_by': {
      wants(['a'], 'arrays');
      const keyed = items().map(x => { const k = run(e.args[0], x, root)[0]; return { x, k: k ? k.nd : Z() }; });
      return list(keyed.sort((x, y) => order(x.k, y.k)).map(r => r.x));
    }
    case 'unique': {
      wants(['a'], 'arrays');
      const seen = new Set(), out = [];
      for (const x of items().sort((p, q) => order(p.nd, q.nd))) { const c = C.canon(x.nd); if (!seen.has(c)) { seen.add(c); out.push(x); } }
      return list(out);
    }
    case 'reverse':
      if (nd.t === 's') return one(S([...nd.v].reverse().join('')));
      wants(['a'], 'arrays and strings');
      return list(items().reverse());
    case 'flatten': {
      wants(['a'], 'arrays');
      const out = [];
      (function flat(x) { const kids = []; children(x, kids); for (const k of kids) { if (k.nd.t === 'a') flat(k); else out.push(k); } })(it);
      return list(out);
    }
    case 'add': {
      wants(['a'], 'arrays');
      if (!nd.e.length) return one(Z());
      const ts = new Set(nd.e.map(x => x.t));
      if (ts.size !== 1) throw new Error('add needs items of one type');
      if (ts.has('n')) return one(N(nd.e.every(x => isInt(x.v)) ? nd.e.reduce((s, x) => s + BigInt(x.v), 0n) : nd.e.reduce((s, x) => s + Number(x.v), 0)));
      if (ts.has('s')) return one(S(nd.e.map(x => x.v).join('')));
      if (ts.has('a')) return one(A([].concat(...nd.e.map(x => x.e))));
      throw new Error('add works on numbers, strings and arrays');
    }
    case 'min': case 'max': {
      wants(['a'], 'arrays');
      const xs = items();
      if (!xs.length) return one(Z());
      return [xs.reduce((m, x) => (fn === 'min' ? order(x.nd, m.nd) < 0 : order(x.nd, m.nd) > 0) ? x : m)];
    }
    case 'to_entries': wants(['o'], 'objects'); return one(A(nd.e.map(kv => ({ t: 'o', e: [['key', S(kv[0])], ['value', kv[1]]] }))));
    case 'not': return one(B(!truthy(it)));
    case 'select': return truthy(arg()) ? [it] : [];
    case 'map': {
      wants(['a', 'o'], 'arrays and objects');
      const out = [];
      for (const x of items()) for (const y of run(e.args[0], x, root)) out.push(y);
      return list(out);
    }
    case 'has': {
      const a = arg();
      if (nd.t === 'o' && a && a.nd.t === 's') return one(B(nd.e.some(kv => kv[0] === a.nd.v)));
      if (nd.t === 'a' && a && a.nd.t === 'n') return one(B(+a.nd.v >= 0 && +a.nd.v < nd.e.length));
      throw new Error('has takes a key for objects or an index for arrays');
    }
    case 'test': {
      const src = strArg();
      if (nd.t !== 's') return one(B(false));
      let re;
      try { re = new RegExp(src); } catch (x) { throw new Error('test: that is not a valid regular expression'); }
      return one(B(re.test(nd.v)));
    }
    case 'startswith': { const a = strArg(); return one(B(nd.t === 's' && nd.v.startsWith(a))); }
    case 'endswith': { const a = strArg(); return one(B(nd.t === 's' && nd.v.endsWith(a))); }
    case 'contains': {
      const a = arg();
      if (!a) return one(B(false));
      if (nd.t === 's' && a.nd.t === 's') return one(B(nd.v.indexOf(a.nd.v) >= 0));
      if (nd.t === 'a') {
        const have = new Set(nd.e.map(C.canon));
        return one(B((a.nd.t === 'a' ? a.nd.e : [a.nd]).every(x => have.has(C.canon(x)))));
      }
      return one(B(C.canon(nd) === C.canon(a.nd)));
    }
  }
  return [];
}

function run(e, it, root) {
  switch (e.k) {
    case 'root': return [{ nd: root, p: '$' }];
    case 'this': return [it];
    case 'lit': return one(e.v);
    case 'path': {
      let cur = run(e.base, it, root);
      for (const s of e.st) cur = step(s, cur, root);
      return cur;
    }
    case 'pipe': {
      const out = [];
      for (const x of run(e.l, it, root)) for (const y of run(e.r, x, root)) out.push(y);
      return out;
    }
    case 'collect': { const xs = run(e.e, it, root); return one(A(xs.map(x => x.nd), xs.map(x => x.p))); }
    case 'cmp': {                                  /* a missing side compares as null, as in jq */
      const a = run(e.l, it, root)[0], b = run(e.r, it, root)[0];
      return one(B(compare(e.op, a ? a.nd : Z(), b ? b.nd : Z())));
    }
    case 'or': return one(B(truthy(run(e.l, it, root)[0]) || truthy(run(e.r, it, root)[0])));
    case 'and': return one(B(truthy(run(e.l, it, root)[0]) && truthy(run(e.r, it, root)[0])));
    case 'not': return one(B(!truthy(run(e.e, it, root)[0])));
    default: return call(e, it, root);
  }
}

/* Returns { root, path, count, single } or { none:true } when a single-valued query finds nothing.
   Throws an Error (with .col for syntax errors) when the query cannot run. */
JF.query = function (root, text) {
  const ast = compile(text);
  const items = run(ast, { nd: root, p: '$' }, root);
  if (multi(ast)) return { root: A(items.map(x => x.nd), items.map(x => x.p)), path: '(matches)', count: items.length, single: false };
  if (!items.length) return { none: true, count: 0 };
  return { root: items[0].nd, path: items[0].p === null ? '(result)' : items[0].p, count: 1, single: true };
};
JF.query.functions = Object.keys(FN);
})();
