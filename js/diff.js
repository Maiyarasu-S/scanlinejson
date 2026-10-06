/* diff.js: structural diff of two parsed documents.

   Objects are compared by key, so key order never counts as a change. Arrays are aligned with a
   longest-common-subsequence pass, so one inserted item shows as one addition, not as a change to
   every item after it. Numbers compare by value (1 and 1.0 are equal), big integers digit for digit.

   Returns { rows:[{ op:'+'|'-'|'~', pathA, pathB, a, b }], add, del, chg, capped }. */
(() => {
'use strict';
const C = JF.core;
const SAFE = /^[A-Za-z_$][\w$]*$/;
const sub = (p, k) => p + (SAFE.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
const LCS_CELLS = 4000000;

JF.diff = function (docA, docB, cap = 5000) {
  const rows = [], n = { '+': 0, '-': 0, '~': 0 };
  const put = (op, pathA, pathB, a, b) => { n[op]++; if (rows.length < cap) rows.push({ op, pathA, pathB, a, b }); };

  function walk(x, y, pa, pb) {
    if (x.t !== y.t) return put('~', pa, pb, x, y);
    if (x.t === 'z') return;
    if (x.t === 's' || x.t === 'b') { if (x.v !== y.v) put('~', pa, pb, x, y); return; }
    if (x.t === 'n') { if (x.v !== y.v && C.canon(x) !== C.canon(y)) put('~', pa, pb, x, y); return; }
    if (x.t === 'o') {
      const ma = new Map(x.e), mb = new Map(y.e);                 /* last duplicate wins */
      for (const [k, v] of ma) { if (mb.has(k)) walk(v, mb.get(k), sub(pa, k), sub(pb, k)); else put('-', sub(pa, k), null, v, null); }
      for (const [k, v] of mb) if (!ma.has(k)) put('+', null, sub(pb, k), null, v);
      return;
    }
    list(x.e, y.e, pa, pb);
  }

  function list(A, B, pa, pb) {
    /* give every distinct value a small integer id so the alignment compares numbers, not long strings */
    const ids = new Map(), id = nd => { const c = C.canon(nd); let v = ids.get(c); if (v === undefined) ids.set(c, v = ids.size); return v; };
    const ha = A.map(id), hb = B.map(id);
    let s = 0, ea = A.length, eb = B.length;
    while (s < ea && s < eb && ha[s] === hb[s]) s++;
    while (ea > s && eb > s && ha[ea - 1] === hb[eb - 1]) { ea--; eb--; }
    const na = ea - s, nb = eb - s;
    let gone = [], come = [];
    /* between two matching items: pair leftovers up as changes, the rest are plain removals or additions */
    const flush = () => {
      const both = Math.min(gone.length, come.length);
      for (let k = 0; k < both; k++) walk(A[gone[k]], B[come[k]], pa + '[' + gone[k] + ']', pb + '[' + come[k] + ']');
      for (let k = both; k < gone.length; k++) put('-', pa + '[' + gone[k] + ']', null, A[gone[k]], null);
      for (let k = both; k < come.length; k++) put('+', null, pb + '[' + come[k] + ']', null, B[come[k]]);
      gone = []; come = [];
    };
    if (na && nb && na * nb <= LCS_CELLS) {
      const W = nb + 1, T = new Uint16Array((na + 1) * W);
      for (let i = na - 1; i >= 0; i--) for (let j = nb - 1; j >= 0; j--)
        T[i * W + j] = ha[s + i] === hb[s + j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
      let i = 0, j = 0;
      while (i < na && j < nb) {
        if (ha[s + i] === hb[s + j]) { flush(); i++; j++; }
        else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) gone.push(s + i++);
        else come.push(s + j++);
      }
      while (i < na) gone.push(s + i++);
      while (j < nb) come.push(s + j++);
    } else {                                                        /* too large to align: compare index by index */
      for (let i = 0; i < na; i++) gone.push(s + i);
      for (let j = 0; j < nb; j++) come.push(s + j);
    }
    flush();
  }

  walk(docA, docB, '$', '$');
  return { rows, add: n['+'], del: n['-'], chg: n['~'], capped: n['+'] + n['-'] + n['~'] > rows.length };
};
})();
