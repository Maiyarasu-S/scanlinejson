/* app.js: everything that touches the page. Parsing, querying, converting, diffing and validating
   live in the other files and know nothing about the DOM.

   Flow: each stdin tab is a buffer that gets analysed (on the main thread, or in a worker when large).
   render() then decides what stdout shows: a message, the tree, converted text, or a diff/validation list. */
(() => {
'use strict';
const C = JF.core, H = JF.hints, V = JF.convert, L = JF.layout;
const $ = id => document.getElementById(id);

/* Stylesheets marked data-lazy are linked with media="print" so they do not hold up the first paint. Switch them on
   once the page has loaded. (A script does this, not an onload attribute, so the page can run under a
   Content-Security-Policy that forbids inline handlers.) */
const switchOnLazy = () => document.querySelectorAll('link[data-lazy]').forEach(l => { l.media = 'all'; });
if (document.readyState === 'complete') switchOnLazy(); else addEventListener('load', switchOnLazy);

const qEl = $('q'), qwrap = $('qwrap'), cmd = $('cmd'), stateEl = $('state'), themeBtn = $('theme'), help = $('help'),
      inPane = $('inPane'), gut = $('gut'), nums = $('nums'), errline = $('errline'), file = $('file'),
      findEl = $('find'), findN = $('findN'), tree = $('tree'), pre = $('text'), list = $('list'), msg = $('msg'), insp = $('insp'),
      statsEl = $('stats'), qmsg = $('qmsg'), noteEl = $('note'), foldBtn = $('fold'), sortBtn = $('sort'), copyBtn = $('copy'), saveBtn = $('save'),
      fmtBtn = $('format'), undoBtn = $('undo'), shareBtn = $('share'), fxBtn = $('fx'),
      themeMeta = document.querySelector('meta[name="theme-color"]'),
      panes = document.querySelector('.panes'), splitEl = $('split'), ed = $('ed'), hlEl = $('hl'), hlin = $('hlin'), caretEl = $('caret'),
      wrapBtn = $('wrap'), hlBtn = $('hlBtn'), fsDown = $('fsDown'), fsVal = $('fsVal'), fsUp = $('fsUp'), convertBtn = $('convert'), cmenu = $('cmenu');

const KEY = 'scanline-json', CHUNK = 500;
const WORKER_MIN = 500000;      /* characters. Below this, parsing on the spot takes a few tens of milliseconds */
const SHOW_MAX = 1500000;       /* characters of plain text put on screen. Copy and save still get everything */
const MARK_MAX = 5000;          /* search matches marked in text output */
const THEMES = ['green', 'amber', 'ice'];
const TREE = { pretty: 1, schema: 1 }, TWO = { diff: 1, check: 1 }, TEXT = { min: 1, yaml: 1, csv: 1, ts: 1 };
const SAFE_KEY = /^[A-Za-z_$][\w$]*$/;
const isMode = JF.modes.isMode;

const b64u = s => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const SAMPLE = String.raw`{"host":"node-07.lab.internal","online":true,"uptime_s":1846203,"booted_at":1765379397,
 "ports":[22,80,443,8080],"load":[0.42,0.37,0.31],
 "tls":{"version":"1.3","cipher":"TLS_AES_256_GCM_SHA384","expires":"2027-03-14T00:00:00Z"},
 "users":[{"id":1001,"name":"ada","shell":"/bin/zsh","sudo":true},{"id":1002,"name":"linus","shell":"/bin/bash","sudo":false}],
 "docs":"https://example.com/runbooks/node-07",
 "session":"` + [b64u('{"alg":"HS256","typ":"JWT"}'), b64u('{"sub":"ada","role":"admin","iat":1767225600,"exp":1893456000}'), 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.') + String.raw`",
 "limits":"{\"max_conn\":512,\"burst\":[10,20,40]}","banner":"` + btoa('stay curious, stay kind') + String.raw`",
 "big_id":9007199254740993,"last_error":null,"motd":"hello, world — stay curious"}`;

const st = { mode: 'pretty', ind: '2', sort: false, theme: 'green', buf: 'a', scope: 'all', fx: true,
             split: L.normSplit(null), wrap: false, fs: 0, hl: true, max: '' };      /* max is not saved: a reload shows both panes */
const CONVERT = { yaml: 1, csv: 1, ts: 1, schema: 1 };
const stacked = matchMedia('(max-width:760px)');      /* the panes sit one above the other */
const mkBuf = (id, el) => ({ id, el, state: 'empty', res: null, err: null, fixed: null, text: '', ms: 0, bytes: 0, name: '',
                             job: 0, worker: null, busy: false, sent: '', threaded: false, timer: 0, jwt: null });
const bufs = { a: mkBuf('a', $('srcA')), b: mkBuf('b', $('srcB')) };
const active = () => bufs[st.buf];

let view = null;            /* { root, path }: what stdout is showing, after the query */
let qInfo = null;           /* outcome of the query, for the status line */
let lastGood = null;        /* last view that worked, kept on screen while a query is half typed */
let troot = null, tpath = '$';   /* root of the drawn tree (the view, or its generated schema) */
let reg = [], budget = 0, folded = false, note = '';
let txt = null, hasOut = false, listText = '';
let sq = null, gen = 0;     /* active search in the tree, and its stamp */
let tq = null;              /* active search in text output: { n, more, cur } */
let sel = null;             /* selected tree row */
let gutLines = 1, tabOut = false, qTimer = 0, findTimer = 0;
const hist = [], redo = [];
let prog = '';              /* tab whose latest change was made by a button, not by typing */

/* ---------- small helpers ---------- */
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => String(s).replace(/[&<>"]/g, c => escMap[c]);
const plain = (c, s) => s;
const pl = (n, w, many) => n.toLocaleString('en') + ' ' + (n === 1 ? w : many || w + 's');
const bytes = s => new Blob([s]).size;
const fmtB = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
const indStr = () => st.ind === 'tab' ? '\t' : ' '.repeat(+st.ind);
const sub = (p, k) => p + (SAFE_KEY.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
const clipText = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

function show(which) {
  tree.hidden = which !== 'tree'; pre.hidden = which !== 'text'; list.hidden = which !== 'list'; msg.hidden = which !== 'msg';
}
function setState(s, label) { stateEl.dataset.s = s; stateEl.textContent = label; }
function message(cls, head, body, extra) {
  msg.innerHTML = '<p class="eh ' + cls + '">' + head + '</p><p class="em">' + body + '</p>' + (extra || '');
  show('msg');
}
/* One-off messages get their own slot in the status line, so the next render does not wipe them. */
let noteTimer = 0;
function notify(text, kind) {
  clearTimeout(noteTimer);
  noteEl.className = kind || '';
  noteEl.textContent = text;
  noteTimer = setTimeout(() => { noteEl.textContent = ''; noteEl.className = ''; }, kind === 'err' ? 9000 : 6000);
}
function flash(btn, label) {
  const was = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = label;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = was; }, 1300);
}

/* ---------- clipboard ---------- */
function legacyCopy(t) {
  const a = document.createElement('textarea');
  a.value = t; a.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(a); a.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  a.remove(); return ok;
}
function copy(t, done) {
  const no = () => done(legacyCopy(t));
  try { navigator.clipboard.writeText(t).then(() => done(true), no); } catch (e) { no(); }
}
const copyVia = (btn, t) => copy(t, ok => flash(btn, ok ? 'copied' : 'copy blocked'));

/* ---------- analysing a tab: main thread for small input, a worker for large ---------- */
let workerOK = typeof Worker === 'function', workerURL = '';
/* The worker parses, then sends the tree back flattened (see pack in core.js). */
const WORKER_SRC = 'const C=(' + jfCore.toString() + ')();onmessage=e=>{const r=C.analyse(e.data.text),tr=[];' +
  'for(const x of[r.res,r.fixed]){if(!x)continue;const p=C.pack(x);if(p){x.root=null;x.packed=p;tr.push(p.kind.buffer,p.len.buffer,p.klen.buffer)}}' +
  'r.job=e.data.job;postMessage(r,tr)};';
function spawn(b) {
  if (!workerOK) return null;
  try {
    if (!workerURL) workerURL = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const w = new Worker(workerURL);
    w.onmessage = e => { if (e.data.job === b.job) rebuild(b, e.data); };
    w.onerror = e => {                             /* blocked or broken: carry on without workers */
      if (e.preventDefault) e.preventDefault();
      workerOK = false; b.worker = null;
      if (b.busy) { b.busy = false; settle(b, C.analyse(b.sent), b.sent, false); }
    };
    return w;
  } catch (e) { workerOK = false; return null; }
}
/* Rebuild the tree from the worker's flat form a slice at a time, so typing and scrolling keep working meanwhile. */
function rebuild(b, r) {
  const job = b.job, todo = [r.res, r.fixed].filter(x => x && x.packed).map(x => ({ x, step: C.unpacker(x.packed) }));
  (function tick() {
    if (b.job !== job) return;                     /* the input changed again: drop this result */
    while (todo.length) {
      const root = todo[0].step(12);
      if (root === undefined) { setTimeout(tick, 0); return; }
      todo[0].x.root = root; todo[0].x.packed = null;
      todo.shift();
    }
    b.busy = false;
    settle(b, r, b.sent, true);
  })();
}

function analyse(id) {
  const b = bufs[id], t = b.el.value;
  clearTimeout(b.timer);
  b.job++;
  save();
  if (b.busy) { b.worker.terminate(); b.worker = null; b.busy = false; }
  if (!t.trim()) { b.state = 'empty'; b.res = b.err = b.fixed = b.jwt = null; b.text = t; touch(id); return; }
  if (t.length >= WORKER_MIN) {
    if (!b.worker) b.worker = spawn(b);
    if (b.worker) {
      b.busy = true; b.sent = t; b.state = 'busy'; b.res = b.err = b.fixed = null;
      b.worker.postMessage({ job: b.job, text: t });
      touch(id);
      return;
    }
  }
  settle(b, C.analyse(t), t, false);
}
function settle(b, r, t, threaded) {
  b.text = t; b.ms = r.ms; b.bytes = bytes(t); b.threaded = threaded;
  if (r.ok) { b.state = 'ok'; b.res = r.res; b.err = b.fixed = null; }
  else { b.state = 'err'; b.res = null; b.err = r.err; b.fixed = r.fixed; }
  b.jwt = r.ok ? null : H.bareJwt(t);              /* not JSON, but a token we can offer to decode */
  touch(b.id);
}
/* redraw only when the tab that changed is on screen */
function touch(id) { if (id === st.buf || TWO[st.mode]) render(); else syncButtons(); }

/* ---------- render: decide what stdout shows ---------- */
function render() {
  txt = null; hasOut = false; note = ''; qInfo = null; view = null; listText = ''; tq = null;
  select(null);
  if (!TREE[st.mode]) findN.textContent = '';
  const act = active(), two = TWO[st.mode];
  if (act.state === 'err' && !act.jwt && !st.wrap) { errline.hidden = false; posErr(); } else errline.hidden = true;
  let blocked = false;
  for (const id of two ? ['a', 'b'] : [st.buf]) {
    const b = bufs[id];
    if (b.state === 'ok') continue;
    if (b.state === 'empty') showEmpty(id, two);
    else if (b.state === 'busy') showBusy(b);
    else showErr(b, two);
    blocked = true;
    break;
  }
  if (!blocked) { if (st.mode === 'diff') paintDiff(); else if (st.mode === 'check') paintCheck(); else paintDoc(); }
  showQ();
  syncButtons();
}

function showEmpty(id, two) {
  setState('idle', 'IDLE');
  statsEl.textContent = 'waiting for input';
  if (!two) {
    message('idle', id === 'a' ? 'stdin is empty' : 'tab b is empty',
      'Paste JSON into stdin, drop a file onto it, or load the sample. Broken or cut-off JSON is fine: you get a list of fixes to apply.',
      '<div class="ea"><button type="button" data-act="sample">load sample</button></div>');
    return;
  }
  const diff = st.mode === 'diff';
  message('idle', 'tab ' + id + ' is empty',
    diff ? 'Diff compares tab a with tab b. Paste the ' + (id === 'a' ? 'first' : 'second') + ' document into tab ' + id + '.'
         : id === 'a' ? 'Validate checks the document in tab a against the JSON Schema in tab b. Paste the document into tab a.'
                      : 'Validate checks tab a against a JSON Schema in tab b. Paste a schema into tab b, or start from one generated from tab a.',
    '<div class="ea">' + (id !== st.buf ? '<button type="button" data-act="tab" data-buf="' + id + '">go to tab ' + id + '</button>' : '') +
    (!diff && id === 'b' && bufs.a.state === 'ok' ? '<button type="button" data-act="gen">generate a schema from tab a</button>' : '') + '</div>');
}
function showBusy(b) {
  setState('idle', 'PARSING');
  statsEl.textContent = 'parsing ' + fmtB(b.sent.length) + ' in a background thread, the page stays usable';
  message('idle', 'parsing…', 'Large input is parsed off the main thread.', '');
}

/* The whole input is a JWT: offer to decode it rather than report a parse error. */
function showJwt(b, two) {
  setState('idle', 'JWT');
  message('idle', 'json web token',
    (two ? 'Tab ' + b.id + ' holds' : 'This is') + ' a JWT, not JSON. Decoding shows its header and payload as JSON. ' +
    'The signature is not verified, so decoding cannot tell you whether the token is genuine.',
    '<div class="ea"><button type="button" data-act="jwt" data-buf="' + b.id + '">decode jwt</button></div>');
  statsEl.textContent = 'a bare JSON Web Token' + (two ? ' in tab ' + b.id : '') + ', ' + fmtB(b.bytes) + ', signature not verified';
}
function showErr(b, two) {
  if (b.jwt) { showJwt(b, two); return; }
  const t = b.text, at = b.err.at, f = b.fixed;
  const { line, col, ls, le } = C.locate(t, at);
  let lt = t.slice(ls, le).replace(/[\t\r]/g, ' '), c = at - ls, lead = '';
  if (c > 60) { const cut = c - 40; lt = lt.slice(cut); c -= cut - 1; lead = '…'; }
  if (lt.length > 110) lt = lt.slice(0, 110) + '…';
  const no = String(line);
  let h = '<p class="eh">ERR <span>' + (two ? 'tab ' + b.id + ', ' : '') + 'line ' + line + ', col ' + col + '</span></p>' +
    '<p class="em">' + esc(b.err.message) + '.</p>' +
    '<pre class="ex">' + no + ' | ' + esc(lead + lt) + '\n<span class="ca">' + ' '.repeat(no.length) + ' | ' + ' '.repeat(c) + '^</span></pre>' +
    '<div class="ea"><button type="button" data-act="jump" data-buf="' + b.id + '" data-at="' + at + '">go to error</button>' +
    (f ? '<button type="button" data-act="fix" data-buf="' + b.id + '">apply ' + pl(f.fixes, 'fix', 'fixes') + '</button>' : '') + '</div>';
  if (f) {
    /* the preview: every repair auto-fix would make, with where it is */
    const log = f.fixLog.slice().sort((x, y) => x.at - y.at), pos = C.lines(t, log.map(x => x.at)), shown = Math.min(log.length, 200);
    h += '<p class="fh">' + (f.cut ? 'The input looks cut off. ' : '') + 'Auto-fix would make ' + pl(f.fixes, 'change') + ':</p><ol class="fx">';
    for (let j = 0; j < shown; j++)
      h += '<li><button type="button" data-act="jump" data-buf="' + b.id + '" data-at="' + log[j].at + '"><b>' + pos[j].line + ':' + pos[j].col + '</b><span>' + esc(log[j].msg) + '</span></button></li>';
    if (f.fixes > shown) h += '<li class="rest">and ' + (f.fixes - shown).toLocaleString('en') + ' more</li>';
    h += '</ol><p class="hint">Applying rewrites stdin as strict JSON' + (f.jsonl ? ', one document per line' : '') + '. Undo brings your original back.</p>';
  }
  msg.innerHTML = h;
  show('msg');
  setState('err', 'ERR ' + line + ':' + col);
  statsEl.textContent = 'parse failed at line ' + line + ', col ' + col + (two ? ' of tab ' + b.id : '');
}

/* ---------- query ---------- */
function computeView(res) {
  const q = qEl.value.trim();
  if (!q) { lastGood = null; return { root: res.root, path: '$' }; }
  try {
    const r = JF.query(res.root, q);
    qInfo = { count: r.count, single: r.single, none: r.none };
    const v = r.none ? null : { root: r.root, path: r.path };
    lastGood = { res, view: v, info: qInfo };
    return v;
  } catch (e) {
    /* half-typed or wrong: keep the last good result on screen and say what is wrong */
    const keep = lastGood && lastGood.res === res ? lastGood : null;
    qInfo = { err: e.message, col: e.col, kept: keep ? keep.info : null };
    return keep ? keep.view : { root: res.root, path: '$' };
  }
}
function showQ() {
  qmsg.className = '';
  if (!qInfo) { qmsg.textContent = ''; return; }
  if (qInfo.err) { qmsg.className = 'err'; qmsg.textContent = 'query: ' + qInfo.err + (qInfo.col ? ' (col ' + qInfo.col + ')' : ''); }
  else qmsg.textContent = 'query: ' + (qInfo.none ? 'no match' : qInfo.single ? '1 result' : pl(qInfo.count, 'match', 'matches'));
}

/* ---------- document views ---------- */
function text() {
  if (txt !== null) return txt;
  const m = st.mode;
  if (TWO[m]) return (txt = listText);
  const r = view.root, I = indStr(), jl = r.jl && m === 'min';
  if (m === 'pretty') txt = C.ser(r, I, plain, st.sort);
  else if (m === 'min') txt = jl ? r.e.map(d => C.ser(d, '', plain, st.sort)).join('\n') : C.ser(r, '', plain, st.sort);
  else if (m === 'schema') txt = C.ser(troot, I, plain, st.sort);
  else if (m === 'yaml') txt = V.yaml(r, st.ind === '4' ? 4 : 2, st.sort);
  else if (m === 'csv') txt = V.csv(r);
  else txt = V.ts(r, I);
  return txt;
}

function paintDoc(od) {
  const b = active(), res = b.res, m = st.mode;
  setState('ok', res.jsonl ? 'VALID JSONL' : 'VALID');
  view = computeView(res);
  if (!view) {
    message('idle', 'no match', 'Nothing in this document is at that path.', '<div class="ea"><button type="button" data-act="clearq">clear the query</button></div>');
    footer(b);
    return;
  }
  hasOut = true;
  if (TREE[m]) {
    troot = m === 'schema' ? V.schema(view.root) : view.root;
    tpath = m === 'schema' ? '$' : view.path;
    drawTree(od);
  } else {
    try { text(); }
    catch (e) { hasOut = false; txt = null; message('idle', 'cannot convert', esc(e.message) + '.', ''); footer(b); return; }
    if (txt.length > SHOW_MAX) note = 'showing the first ' + fmtB(SHOW_MAX) + ', copy and save give all of it';
    paintText();
    pre.scrollTop = 0;
    show('text');
  }
  footer(b);
}

/* Text output, with the search box's matches marked. Minified JSON also keeps its syntax colours. */
function paintText() {
  const t = txt.length > SHOW_MAX ? txt.slice(0, SHOW_MAX) : txt, F = JF.find, p = F.pattern(findEl.value);
  let marks = [];
  tq = null;
  if (p && p.error) findN.textContent = p.error;
  else if (p) {
    const r = F.ranges(t, p.mark, MARK_MAX);
    marks = r.ranges;
    tq = { n: marks.length, more: r.more, cur: -1 };
    findN.textContent = marks.length ? pl(marks.length, 'match', 'matches') + (r.more ? ' marked, more past that' : '') : 'no matches';
  }
  else findN.textContent = '';
  const colour = st.mode === 'min' && t.length < 300000;
  if (colour || marks.length) pre.innerHTML = F.paint(t, colour ? F.tokens(t) : [], marks, -1);
  else pre.textContent = t;
}

function footer(b) {
  const res = b.res;
  let h = fmtB(b.bytes) + ' in';
  if (hasOut && (b.bytes <= 2000000 || txt !== null)) {          /* sizing huge output would mean serialising it just for this line */
    const out = bytes(text()), d = b.bytes ? Math.round((out - b.bytes) / b.bytes * 100) : 0;
    h += ' &rarr; ' + fmtB(out) + ' out (' + (d > 0 ? '+' : '') + d + '%)';
  }
  h += ' · ' + pl(res.nodes, 'value') + ' · depth ' + res.depth + ' · parsed in ' + (b.ms < 10 ? b.ms.toFixed(1) : Math.round(b.ms)) + ' ms' + (b.threaded ? ' off-thread' : '');
  if (res.jsonl) h += ' · JSON Lines, ' + pl(res.docs, 'document') + (st.mode === 'min' ? '' : ' shown as one array');
  if (res.dups) h += ' · <button type="button" class="warn" data-act="dups" title="Show where they are">' + pl(res.dups, 'duplicate key') + '</button>';
  if (note) h += ' · <span class="warn">' + note + '</span>';
  statsEl.innerHTML = h;
}

/* ---------- search: stamp every node that matches, or leads to a match ---------- */
function prepSearch(root) {
  const p = JF.find.pattern(findEl.value);
  sq = null;
  if (!p) { findN.textContent = ''; return false; }
  if (p.error) { findN.textContent = p.error; return false; }
  sq = { gen: ++gen, test: p.test, mark: p.mark, keys: st.scope !== 'values', vals: st.scope !== 'keys', n: 0 };
  (function walk(nd, keyHit) {
    const g = sq.gen;
    let below = false, valHit = false;
    if (nd.t === 'o') { for (const kv of nd.e) { const h = sq.keys && sq.test.test(kv[0]); if (h) sq.n++; if (walk(kv[1], h)) below = true; } }
    else if (nd.t === 'a') { for (const x of nd.e) if (walk(x, false)) below = true; }
    else if (sq.vals && sq.test.test(nd.t === 'z' ? 'null' : nd.v)) { valHit = true; sq.n++; }
    nd.sk = keyHit ? g : 0; nd.sv = valHit ? g : 0; nd.sd = below ? g : 0;
    const any = keyHit || valHit || below;
    nd.sg = any ? g : 0;
    return any;
  })(root, false);
  findN.textContent = pl(sq.n, 'match', 'matches');
  return true;
}
function marked(s) {
  const re = sq.mark;
  re.lastIndex = 0;
  let out = '', last = 0, m, k = 0;
  while ((m = re.exec(s)) && k++ < 200) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return last ? out + esc(s.slice(last)) : '<mark>' + esc(s) + '</mark>';
}

/* ---------- folding tree, rendered lazily ---------- */
const BADGE = {
  json: ['{…}', 'This string holds JSON. Click to expand it'],
  jwt: ['jwt', 'JSON Web Token. Click to decode it (the signature is not verified)'],
  b64: ['b64', 'Base64 text. Click to decode it'],
};
function scalar(nd, key, hit) {
  if (nd.t === 's') {
    const j = JSON.stringify(nd.v), body = hit ? '"' + marked(j.slice(1, -1)) + '"' : esc(j), k = H.kind(nd.v);
    if (k === 'url') return '<a class="s lnk" href="' + esc(nd.v) + '" target="_blank" rel="noopener noreferrer">' + body + '</a>';
    return '<span class="s">' + body + '</span>' +
      (k ? '<button type="button" class="tag bd" tabindex="-1" data-x="' + k + '" aria-expanded="false" title="' + BADGE[k][1] + '">' + BADGE[k][0] + '</button>' : '');
  }
  const cls = nd.t === 'n' ? 'nu' : nd.t === 'b' ? 'b' : 'z', s = nd.t === 'z' ? 'null' : nd.v;
  let h = '<span class="' + cls + '">' + (hit ? marked(s) : esc(s)) + '</span>';
  if (nd.t === 'n') { const ts = H.stamp(nd.v, key); if (ts && ts.likely) h += '<span class="ann">' + ts.iso + '</span>'; }
  return h;
}
/* Accessibility: every visible row is a treeitem that states its own level and place among its siblings,
   so the wrappers around branches (.n, .kids, .nest) and the closing-bracket rows stay out of the way. */
function row(key, nd, last, path, od, lv, pos, size) {
  const id = reg.push({ nd, path, key, lv }) - 1;
  const g = sq ? sq.gen : -1, keyHit = nd.sk === g, valHit = nd.sv === g;
  const kp = key === null ? '' : '<span class="k">' + (keyHit ? '"' + marked(JSON.stringify(key).slice(1, -1)) + '"' : esc(JSON.stringify(key))) + '</span><span class="p">: </span>';
  const cm = (last ? '' : '<span class="p">,</span>') + (nd.dup ? '<span class="tag warn" title="This key already appeared earlier in the same object">dup</span>' : '');
  const cls = 'ln' + (keyHit || valHit ? ' hit' : ''), ti = ' role="treeitem" aria-level="' + lv + '" aria-posinset="' + pos + '" aria-setsize="' + size + '"';
  if (nd.t !== 'o' && nd.t !== 'a')
    return '<div class="' + cls + '" data-id="' + id + '"' + ti + '>' + kp + scalar(nd, key, valHit) + cm + '</div>';
  const o = nd.t === 'o', a = o ? '{' : '[', b = o ? '}' : ']', len = nd.e.length;
  if (!len) return '<div class="' + cls + '" data-id="' + id + '"' + ti + '>' + kp + '<span class="p">' + a + b + '</span>' + cm + '</div>';
  const open = budget > 0 && (od > 0 || nd.sd === g);
  const sum = len + (nd.jl ? ' document' : o ? ' key' : ' item') + (len === 1 ? '' : 's');
  return '<div class="n' + (open ? ' open' : '') + '" data-id="' + id + '" role="none">' +
    '<div class="' + cls + '" data-id="' + id + '"' + ti + ' aria-expanded="' + open + '"><button type="button" class="tw" tabindex="-1" aria-hidden="true"></button>' +
    kp + '<span class="p">' + a + '</span><span class="cz"><span class="sum">' + sum + '</span><span class="p">' + b + '</span>' + cm + '</span></div>' +
    '<div class="kids" role="none">' + (open ? kids(nd, path, 0, od - 1, lv + 1) : '') + '</div>' +
    '<div class="ln end" role="none" aria-hidden="true"><span class="p">' + b + '</span>' + cm + '</div></div>';
}
function kids(nd, path, from, od, lv) {
  const o = nd.t === 'o', items = o ? C.ents(nd, st.sort) : nd.e, len = items.length;
  /* while searching, a branch that leads to matches shows only the children on the way to them */
  let pick = null;
  if (sq && nd.sd === sq.gen) { pick = []; for (let j = 0; j < len; j++) if ((o ? items[j][1] : items[j]).sg === sq.gen) pick.push(j); }
  const total = pick ? pick.length : len, to = Math.min(total, from + CHUNK);
  let h = '';
  for (let x = from; x < to; x++) {
    const j = pick ? pick[x] : x;
    budget--;
    if (o) h += row(items[j][0], items[j][1], x === total - 1, sub(path, items[j][0]), od, lv, x + 1, total);
    else h += row(null, items[j], x === total - 1, nd.cp && nd.cp[j] ? nd.cp[j] : path + '[' + j + ']', od, lv, x + 1, total);
  }
  /* hidden from screen readers: moving down past the last row loads the next chunk anyway */
  if (to < total) h += '<button type="button" class="more" tabindex="-1" aria-hidden="true" data-from="' + to + '">show ' + Math.min(CHUNK, total - to) + ' more (' + (total - to).toLocaleString('en') + ' left)</button>';
  return h;
}

function drawTree(od) {
  if (od === undefined) folded = false;
  foldBtn.textContent = folded ? 'unfold' : 'fold';
  note = '';
  const searching = prepSearch(troot);
  reg = [];
  if (searching && troot.sg !== sq.gen) {
    message('idle', 'no matches', 'Nothing in this view matches the search.', '<div class="ea"><button type="button" data-act="clearfind">clear the search</button></div>');
    return;
  }
  budget = od === Infinity ? 20000 : 5000;
  const depth = od !== undefined ? od : searching ? 0 : active().res.nodes <= 3000 ? Infinity : 2;
  tree.style.setProperty('--ind', st.ind === '2' ? '2ch' : '4ch');
  tree.innerHTML = row(null, troot, true, tpath, depth, 1, 1, 1);
  if (budget <= 0) note = 'large document, deeper levels stay folded';
  /* a document that is only a token: show it decoded straight away */
  if (!searching && troot.t === 's' && H.kind(troot.v) === 'jwt') toggleNest(tree.querySelector('.ln'));
  tree.scrollTop = 0;
  show('tree');
}

/* ---------- tree: folding, selection, keyboard ---------- */
const isHead = ln => ln.parentElement.classList.contains('n') && ln.parentElement.firstElementChild === ln;
const itemOf = ln => isHead(ln) ? ln.parentElement : ln;

function setOpen(n, open) {
  if (n.classList.contains('open') === open) return;
  const k = n.children[1];
  if (open && !k.firstChild) { const r = reg[n.dataset.id]; budget = 5000; k.innerHTML = kids(r.nd, r.path, 0, 0, r.lv + 1); }
  n.classList.toggle('open', open);
  n.firstElementChild.setAttribute('aria-expanded', open);
  if (!open && sel && k.contains(sel)) select(n.firstElementChild);
}
function openAll(n) {
  const r = reg[n.dataset.id];
  budget = 20000;
  n.children[1].innerHTML = kids(r.nd, r.path, 0, Infinity, r.lv + 1);
  n.classList.add('open');
  n.firstElementChild.setAttribute('aria-expanded', 'true');
}
function shutAll(n) {
  n.querySelectorAll('.n.open').forEach(x => { x.classList.remove('open'); x.firstElementChild.setAttribute('aria-expanded', 'false'); });
  setOpen(n, false);
}

/* first and last visible row inside an item (a plain row, a .n branch, or a .nest of decoded content) */
function headOf(el) {
  const c = el.classList;
  if (c.contains('ln')) return c.contains('end') ? null : el;
  if (c.contains('n')) return el.firstElementChild;
  if (c.contains('nest')) return el.firstElementChild ? headOf(el.firstElementChild) : null;
  return null;
}
function tailOf(el) {
  const c = el.classList;
  if (c.contains('ln')) return el;
  if (c.contains('nest')) return el.lastElementChild ? tailOf(el.lastElementChild) : null;
  if (c.contains('n')) {
    if (c.contains('open')) {
      let k = el.children[1].lastElementChild;
      while (k && k.classList.contains('more')) k = k.previousElementSibling;
      if (k) return tailOf(k);
    }
    return el.firstElementChild;
  }
  return null;
}
function nextRow(ln) {
  const n = ln.parentElement;
  if (isHead(ln) && n.classList.contains('open') && n.children[1].firstElementChild) return headOf(n.children[1].firstElementChild);
  let it = itemOf(ln);
  for (;;) {
    let nx = it.nextElementSibling;
    if (nx && nx.classList.contains('more')) { nx.click(); nx = it.nextElementSibling; }      /* walking past the end loads the next chunk */
    if (nx) { const h = headOf(nx); if (h) return h; it = nx; continue; }
    const box = it.parentElement;
    if (box === tree) return null;
    it = box.classList.contains('kids') ? box.parentElement : box;
  }
}
function prevRow(ln) {
  const it = itemOf(ln), pv = it.previousElementSibling;
  if (pv) return tailOf(pv);
  return parentRow(ln);
}
function parentRow(ln) {
  const box = itemOf(ln).parentElement;
  if (box === tree) return null;
  return box.classList.contains('kids') ? box.parentElement.firstElementChild : box.previousElementSibling;
}
/* make a row visible by opening everything above it */
function reveal(ln) {
  for (let el = ln.parentElement; el && el !== tree; el = el.parentElement) if (el.classList.contains('n')) setOpen(el, true);
}

function what(nd) {
  return nd.t === 's' ? 'string, ' + pl(nd.v.length, 'char') : nd.t === 'n' ? 'number' : nd.t === 'b' ? 'boolean' : nd.t === 'z' ? 'null'
    : nd.t === 'o' ? 'object, ' + pl(nd.e.length, 'key') : nd.jl ? 'JSON Lines, ' + pl(nd.e.length, 'document') : 'array, ' + pl(nd.e.length, 'item');
}
function select(ln) {
  if (sel) { sel.classList.remove('sel'); sel.removeAttribute('aria-selected'); }
  sel = ln;
  if (!ln) { insp.hidden = true; insp.innerHTML = ''; tree.removeAttribute('aria-activedescendant'); return; }
  ln.classList.add('sel');
  ln.setAttribute('aria-selected', 'true');
  if (!ln.id) ln.id = 'r' + ln.dataset.id;
  tree.setAttribute('aria-activedescendant', ln.id);
  const r = reg[ln.dataset.id], nd = r.nd, box = isHead(ln);
  const real = st.mode === 'pretty' && r.path[0] === '$' && r.path.indexOf(' | ') < 0;      /* a path the query line can take */
  const facts = H.describe(nd, r.key);
  insp.innerHTML =
    '<div class="iw"><button type="button" class="ipath" data-act="path" title="Copy this path">' + esc(r.path) + '</button><span class="what">' + esc(what(nd)) + '</span>' +
    (facts.length ? '<div class="ih">' + facts.map(esc).join(' · ') + '</div>' : '') + '</div>' +
    '<div class="acts"><button type="button" data-act="value">copy value</button><button type="button" data-act="path">copy path</button>' +
    (real && r.path !== '$' ? '<button type="button" data-act="query" title="Show only this node">query this</button>' : '') +
    (box ? '<button type="button" data-act="open" title="Shift + right arrow">expand all</button><button type="button" data-act="shut" title="Shift + left arrow">collapse all</button>' : '') +
    '<button type="button" data-act="close" aria-label="Close">x</button></div>';
  insp.hidden = false;
}
const selNode = () => sel && reg[sel.dataset.id];

function toggleNest(ln) {
  const bd = ln.querySelector('.bd');
  if (!bd || bd.disabled) return;
  const nx = ln.nextElementSibling;
  if (nx && nx.classList.contains('nest')) {
    if (sel && nx.contains(sel)) select(ln);
    nx.remove(); bd.setAttribute('aria-expanded', 'false');
    return;
  }
  const r = reg[ln.dataset.id], d = H.decode(bd.dataset.x, r.nd.v);
  if (!d) { bd.textContent = 'cannot decode'; bd.disabled = true; return; }
  budget = 5000;
  ln.insertAdjacentHTML('afterend', '<div class="nest" role="none" data-label="' + esc(d.label) + '">' + row(null, d.root, true, r.path + ' | ' + d.fn, 3, r.lv + 1, 1, 1) + '</div>');
  bd.setAttribute('aria-expanded', 'true');
}

tree.addEventListener('click', e => {
  const more = e.target.closest('.more');
  if (more) {
    const r = reg[more.closest('.n').dataset.id];
    budget = 5000;
    more.insertAdjacentHTML('beforebegin', kids(r.nd, r.path, +more.dataset.from, 0, r.lv + 1));
    more.remove();
    tree.focus({ preventScroll: true });
    return;
  }
  const ln = e.target.closest('.ln');
  if (!ln || ln.classList.contains('end')) return;
  if (e.target.closest('.bd')) { toggleNest(ln); select(ln); tree.focus({ preventScroll: true }); return; }
  if (e.target.closest('.tw,.sum')) { const n = ln.parentElement; setOpen(n, !n.classList.contains('open')); select(ln); tree.focus({ preventScroll: true }); return; }
  if (String(getSelection())) return;             /* the click ended a text selection: leave it alone */
  select(ln);
});

tree.addEventListener('keydown', e => {
  if (e.altKey) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if ((k === 'c' || k === 'C') && sel && !String(getSelection())) { e.preventDefault(); copyVia(insp.querySelector('[data-act="value"]'), C.ser(selNode().nd, indStr(), plain, st.sort)); }
    return;
  }
  if (e.target !== tree && (k === 'Enter' || k === ' ')) return;      /* a focused button or link handles its own keys */
  if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].indexOf(k) < 0) return;
  e.preventDefault();
  const first = tree.firstElementChild && headOf(tree.firstElementChild);
  if (!first) return;
  const cur = sel && tree.contains(sel) ? sel : null;
  let to = null;
  if (!cur) to = first;
  else {
    const head = isHead(cur), n = cur.parentElement, open = head && n.classList.contains('open');
    if (k === 'ArrowDown') to = nextRow(cur);
    else if (k === 'ArrowUp') to = prevRow(cur);
    else if (k === 'Home') to = first;
    else if (k === 'End') to = tailOf(tree.lastElementChild);
    else if (k === 'ArrowRight') { if (head && e.shiftKey) openAll(n); else if (head && !open) setOpen(n, true); else if (head) to = nextRow(cur); }
    else if (k === 'ArrowLeft') { if (head && e.shiftKey) shutAll(n); else if (open) setOpen(n, false); else to = parentRow(cur); }
    else if (head) setOpen(n, !open);
    else toggleNest(cur);
  }
  if (to) { select(to); to.scrollIntoView({ block: 'nearest' }); }
});
tree.addEventListener('focus', () => {
  if (!sel && tree.matches(':focus-visible') && tree.firstElementChild) { const f = headOf(tree.firstElementChild); if (f) select(f); }
});

/* inspector buttons, and the duplicate-key list that shares the same strip */
insp.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, r = selNode();
  if (act === 'close') { select(null); return; }
  if (act === 'jump') { jump(st.buf, +b.dataset.at); return; }
  if (!r) return;
  const n = sel.parentElement;
  if (act === 'value') copyVia(b, C.ser(r.nd, indStr(), plain, st.sort));
  else if (act === 'path') copyVia(b.classList.contains('ipath') ? insp.querySelector('.acts [data-act="path"]') : b, r.path);
  else if (act === 'query') setQuery(r.path);
  else if (act === 'open') openAll(n);
  else if (act === 'shut') shutAll(n);
});
function showDups() {
  const b = active(), log = b.res.dupLog, pos = C.lines(b.text, log.map(d => d.at)), firsts = log.map(d => C.locate(b.text, d.first));
  select(null);
  let h = '<div class="iw">' + pl(b.res.dups, 'duplicate key') + '. JSON keeps both, but most programs read only the last one.</div>' +
    '<div class="acts"><button type="button" data-act="close" aria-label="Close">x</button></div><ol class="dl">';
  log.forEach((d, j) => {
    h += '<li><button type="button" data-act="jump" data-at="' + d.at + '">' + esc(clipText(JSON.stringify(d.key), 60)) + ' at line ' + pos[j].line + ':' + pos[j].col + '</button>' +
         ' <span>first seen at line ' + firsts[j].line + ':' + firsts[j].col + '</span></li>';
  });
  if (b.res.dups > log.length) h += '<li><span>and ' + (b.res.dups - log.length).toLocaleString('en') + ' more</span></li>';
  insp.innerHTML = h + '</ol>';
  insp.hidden = false;
}
statsEl.addEventListener('click', e => { if (e.target.closest('[data-act="dups"]')) showDups(); });

/* ---------- diff and validation lists ---------- */
const brief = nd => clipText(C.ser(nd, '', plain, false), 240);
function paintList(head, rows, more) {
  list.innerHTML = '<p class="lh">' + head + '</p>' + rows.join('') + (more ? '<p class="lh">' + more + '</p>' : '');
  list.scrollTop = 0;
  show('list');
  hasOut = true;
}
function paintDiff() {
  const d = JF.diff(bufs.a.res.root, bufs.b.res.root), total = d.add + d.del + d.chg;
  if (!total) {
    setState('ok', 'SAME');
    message('ok', 'no differences', 'Tab a and tab b hold the same data. Key order and number spelling (1 vs 1.0) are not counted as differences.', '');
    statsEl.textContent = 'compared ' + pl(bufs.a.res.nodes, 'value') + ' with ' + pl(bufs.b.res.nodes, 'value');
    return;
  }
  setState('warn', pl(total, 'DIFF', 'DIFFS'));
  const lines = [], rows = d.rows.slice(0, 2000).map(r => {
    const p = r.pathA || r.pathB, cls = r.op === '+' ? 'add' : r.op === '-' ? 'del' : 'chg';
    const val = r.op === '+' ? '<span class="new">' + esc(brief(r.b)) + '</span>' : r.op === '-' ? '<span class="old">' + esc(brief(r.a)) + '</span>'
      : '<span class="old">' + esc(brief(r.a)) + '</span> &rarr; <span class="new">' + esc(brief(r.b)) + '</span>';
    lines.push(r.op + ' ' + p + ': ' + (r.op === '+' ? brief(r.b) : r.op === '-' ? brief(r.a) : brief(r.a) + ' -> ' + brief(r.b)));
    return '<button type="button" class="dr ' + cls + '" data-path="' + esc(p) + '" data-buf="' + (r.op === '+' ? 'b' : 'a') + '" title="Open this in the tree">' +
      '<span class="op">' + r.op + '</span><span class="dp">' + esc(p) + '</span><span class="dv">' + val + '</span></button>';
  });
  const head = '<b>' + pl(d.chg, 'change') + '</b>, <b>' + d.add.toLocaleString('en') + ' added</b>, <b>' + d.del.toLocaleString('en') + ' removed</b>, going from tab a to tab b';
  paintList(head, rows, total > rows.length ? 'showing the first ' + rows.length.toLocaleString('en') + ' of ' + total.toLocaleString('en') : '');
  listText = '# ' + d.chg + ' changed, ' + d.add + ' added, ' + d.del + ' removed (a -> b)\n' + lines.join('\n') + '\n';
  statsEl.textContent = 'compared ' + pl(bufs.a.res.nodes, 'value') + ' with ' + pl(bufs.b.res.nodes, 'value');
}
function paintCheck() {
  const sroot = bufs.b.res.root;
  if (sroot.t !== 'o' && sroot.t !== 'b') {
    setState('idle', 'NO SCHEMA');
    message('idle', 'tab b is not a schema', 'A JSON Schema is an object (or true / false). Tab b holds ' + (sroot.t === 'a' ? 'an array' : 'a ' + C.typeName(sroot)) + '.',
      '<div class="ea"><button type="button" data-act="gen">generate a schema from tab a</button></div>');
    statsEl.textContent = 'validate needs a JSON Schema in tab b';
    return;
  }
  const t0 = performance.now(), r = JF.validate(bufs.a.res.root, C.toJS(sroot)), ms = performance.now() - t0;
  const skipped = r.ignored.length ? 'Not checked, because this validator does not support it: ' + r.ignored.map(esc).join(', ') + '.' : '';
  statsEl.textContent = 'checked ' + pl(bufs.a.res.nodes, 'value') + ' in ' + (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
  if (!r.errors.length) {
    setState('ok', 'PASS');
    message('ok', 'valid', 'Tab a fits the schema in tab b.', skipped ? '<p class="hint">' + skipped + '</p>' : '');
    return;
  }
  setState('err', r.errors.length + (r.capped ? '+' : '') + ' FAIL');
  const rows = r.errors.map(e => '<button type="button" class="dr del" data-path="' + esc(e.path) + '" data-buf="a" title="Open this in the tree">' +
    '<span class="op">x</span><span class="dp">' + esc(e.path) + '</span><span class="dv">' + esc(e.msg) + '</span></button>');
  paintList('<b>' + pl(r.errors.length, 'problem') + (r.capped ? ' or more' : '') + '</b> checking tab a against the schema in tab b', rows, skipped);
  listText = r.errors.map(e => e.path + ': ' + e.msg).join('\n') + '\n';
}
list.addEventListener('click', e => {
  const r = e.target.closest('.dr');
  if (!r) return;
  if (r.dataset.buf !== st.buf) setBuf(r.dataset.buf, true);
  st.mode = 'pretty';
  setQuery(r.dataset.path);
});

/* ---------- stdin: gutter, error line, tabs ---------- */
let lineHpx = 0;
const lineH = () => lineHpx || (lineHpx = parseFloat(getComputedStyle(active().el).lineHeight) || 20);
let errLineNo = 0;
function posErr() {
  const b = active();
  if (errline.hidden || b.state !== 'err') return;
  errLineNo = C.locate(b.text, b.err.at).line;
  errline.style.transform = 'translateY(' + ((errLineNo - 1) * lineH() - b.el.scrollTop) + 'px)';
}
/* The gutter draws only the line numbers in view. A full column of numbers for a file with
   hundreds of thousands of lines costs the browser seconds of layout on every load. */
const PAD = 10;                                    /* the textarea's top padding in style.css */
let gutWin = '';
function drawGutter() {
  const el = active().el, lh = lineH();
  const first = Math.max(0, Math.floor((el.scrollTop - PAD) / lh)), last = Math.min(gutLines, first + Math.ceil(el.clientHeight / lh) + 2);
  const win = first + ':' + last;
  if (win !== gutWin) {
    let t = '';
    for (let k = first + 1; k <= last; k++) t += k + '\n';
    nums.textContent = t; gutWin = win;
  }
  nums.style.transform = 'translateY(' + (PAD + first * lh - el.scrollTop) + 'px)';
  syncHl();
}
function updateGutter() {
  const v = active().el.value;
  let lines = 1;
  for (let j = v.indexOf('\n'); j !== -1; j = v.indexOf('\n', j + 1)) lines++;
  gutLines = lines;
  gut.style.minWidth = (String(lines).length + 2) + 'ch';
  drawGutter();
  paintHl();
}
function setBuf(id, quiet) {
  st.buf = id;
  sync();
  updateGutter();
  save();
  if (!quiet) render();
}
function jump(id, at) {
  showPane('in');
  if (id !== st.buf) setBuf(id);
  const el = bufs[id].el, line = C.locate(el.value, at).line;
  el.focus();
  el.setSelectionRange(at, Math.min(at + 1, el.value.length));
  el.scrollTop = Math.max(0, (line - 1) * lineH() - el.clientHeight / 2);
}

/* ---------- replacing stdin from a button, with our own undo ----------
   A scripted change to textarea.value is invisible to the browser's undo history, and the stale history
   then replays onto the new text and garbles it. (Routing big replacements through insertText would keep
   the history, but that call takes seconds on a few hundred KB.) So every scripted replacement swaps in a
   fresh textarea, which starts with a clean history, and is snapshotted here so it can be undone.
   Typing still uses the browser's own undo. */
function setValue(b, v) {
  const old = b.el, el = old.cloneNode(false), focused = document.activeElement === old;
  el.value = v;
  old.replaceWith(el);
  b.el = el;
  if (focused) el.focus({ preventScroll: true });
}
const snap = id => { const el = bufs[id].el; return { id, v: el.value, s: el.selectionStart, e: el.selectionEnd, top: el.scrollTop, left: el.scrollLeft, name: bufs[id].name }; };
function put(h) {
  const b = bufs[h.id];
  if (st.buf !== h.id) setBuf(h.id, true);
  setValue(b, h.v);
  b.el.setSelectionRange(h.s || 0, h.e || 0);      /* a fresh textarea parks the caret at the end, and focusing it would scroll there */
  b.el.scrollTop = h.top || 0; b.el.scrollLeft = h.left || 0;
  b.name = h.name;
  updateGutter();
  prog = h.id;
  analyse(h.id);
}
function trimHist(stack) {
  let size = 0;
  for (let j = stack.length - 1; j >= 0; j--) { size += stack[j].v.length; if (size > 40000000 || stack.length - j > 30) { stack.splice(0, j + 1); break; } }
}
function replaceInput(id, v, name, keep) {
  const b = bufs[id];
  paused = pristine = false;
  if (b.el.value === v) { if (id !== st.buf) setBuf(id); return; }
  hist.push(snap(id)); trimHist(hist);
  redo.length = 0;
  put(Object.assign({ id, v, name: name === undefined ? b.name : name }, keep));
}
function undo() { const h = hist.pop(); if (!h) return; redo.push(snap(h.id)); put(h); flash(undoBtn, 'undone'); }
function redoIt() { const h = redo.pop(); if (!h) return; hist.push(snap(h.id)); put(h); }

function readFile(f) {
  if (!f) return;
  if (f.size > 20 * 1048576) { notify(f.name + ' is larger than 20 MB, too big to load here', 'err'); return; }
  const r = new FileReader();
  r.onload = () => replaceInput(st.buf, String(r.result), f.name);
  r.onerror = () => notify('could not read ' + f.name, 'err');
  r.readAsText(f);
}

/* the document as text for stdin: JSON Lines stays one document per line */
function docText(res, minify) {
  const I = minify ? '' : indStr();
  return res.jsonl ? res.root.e.map(d => C.ser(d, I, plain, st.sort)).join('\n') + '\n' : C.ser(res.root, I, plain, st.sort);
}
function formatInPlace() {
  const b = active();
  if (b.state !== 'ok') return;
  replaceInput(b.id, docText(b.res, st.mode === 'min'));
  flash(fmtBtn, 'formatted');
}
function applyFix(id) {
  const b = bufs[id];
  if (b.fixed) replaceInput(id, b.fixed.jsonl ? b.fixed.root.e.map(d => C.ser(d, '', plain, false)).join('\n') + '\n' : C.ser(b.fixed.root, indStr(), plain, false));
}

/* Tab indents, Shift+Tab outdents. Small edits go through insertText so they stay in the browser's undo
   history. Large blocks would take seconds that way, so they use the snapshot route above instead. */
function edit(b, from, to, s, selFrom, selTo) {
  const el = b.el;
  let ok = false;
  if (s.length <= 20000) {
    el.setSelectionRange(from, to);
    try { ok = document.execCommand('insertText', false, s); } catch (e) {}
  }
  if (!ok) { const v = el.value; replaceInput(b.id, v.slice(0, from) + s + v.slice(to), undefined, { top: el.scrollTop, left: el.scrollLeft }); b.el.focus({ preventScroll: true }); }
  if (selFrom !== undefined) b.el.setSelectionRange(selFrom, selTo);
}
function indent(b, out) {
  const el = b.el, unit = indStr(), v = el.value, s = el.selectionStart, e = el.selectionEnd;
  if (s === e && !out) { edit(b, s, e, unit, s + unit.length, s + unit.length); return; }
  const ls = v.lastIndexOf('\n', s - 1) + 1, block = v.slice(ls, e);
  const strip = l => l[0] === '\t' ? l.slice(1) : l.slice(Math.min(unit === '\t' ? 2 : unit.length, l.length - l.replace(/^ +/, '').length));
  const lines = block.split('\n'), done = lines.map(l => out ? strip(l) : unit + l).join('\n');
  if (done === block) return;
  const shift = out ? strip(lines[0]).length - lines[0].length : unit.length, from = Math.max(ls, s + shift);
  edit(b, ls, e, done, from, s === e ? from : ls + done.length);
}

/* The textareas get swapped out (see setValue), so their events are handled on the container. */
const bufOf = t => t === bufs.a.el ? bufs.a : t === bufs.b.el ? bufs.b : null;
ed.addEventListener('input', e => {
  const b = bufOf(e.target);
  if (!b) return;
  paused = pristine = false;
  if (prog === b.id) prog = '';
  if (b.id === st.buf) { updateGutter(); if (b.el.value.length < 60000) paintHl(true); }
  clearTimeout(b.timer);
  b.timer = setTimeout(() => analyse(b.id), b.el.value.length > 200000 ? 350 : 120);
});
ed.addEventListener('scroll', e => { const b = bufOf(e.target); if (b && b.id === st.buf) { drawGutter(); posErr(); } }, true);
ed.addEventListener('focusout', () => { tabOut = false; });
ed.addEventListener('keydown', e => {
  const b = bufOf(e.target);
  if (!b) return;
  const el = b.el, id = b.id, mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === 'Escape') { tabOut = true; return; }
  if (e.key === 'Tab' && !mod && !e.altKey) {
    if (tabOut) { tabOut = false; return; }
    e.preventDefault(); indent(b, e.shiftKey);
    return;
  }
  if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') tabOut = false;
  if (!mod || e.altKey) return;
  const mine = hist.length && hist[hist.length - 1].id === id;
  if (k === 'z' && !e.shiftKey && mine) {
    /* Right after a scripted change, Ctrl+Z undoes it. Otherwise the browser undoes typing first, and when
       that changes nothing the same key reaches back to the last scripted change. "Nothing" has to cover
       every field: Chrome keeps one undo history per page, so its undo may land in the search or query box. */
    if (prog === id) { e.preventDefault(); undo(); }
    else {
      const fields = [bufs.a.el, bufs.b.el, qEl, findEl], before = fields.map(f => f.value);
      setTimeout(() => { if (b.el === el && fields.every((f, j) => f.value === before[j])) undo(); }, 0);
    }
  }
  else if ((k === 'y' || (k === 'z' && e.shiftKey)) && prog === id && redo.length && redo[redo.length - 1].id === id) { e.preventDefault(); redoIt(); }
});
addEventListener('resize', () => { lineHpx = 0; drawGutter(); posErr(); });

inPane.addEventListener('dragover', e => { e.preventDefault(); inPane.classList.add('drop'); });
inPane.addEventListener('dragleave', () => inPane.classList.remove('drop'));
inPane.addEventListener('drop', e => {
  e.preventDefault(); inPane.classList.remove('drop');
  if (e.dataTransfer && e.dataTransfer.files.length) readFile(e.dataTransfer.files[0]);
});

/* ---------- save and share ---------- */
function saveFile() {
  if (!hasOut) return;
  const b = active(), m = st.mode, jl = m === 'min' && view && view.root.jl;
  const ext = { pretty: '.json', min: jl ? '.jsonl' : '.min.json', yaml: '.yaml', csv: '.csv', ts: '.d.ts', schema: '.schema.json', diff: '.diff.txt', check: '.validation.txt' }[m];
  const base = (b.name || 'data').replace(/\.[^.\/\\]+$/, '').replace(/[\/\\:*?"<>|]/g, '_') || 'data';
  const mime = m === 'csv' ? 'text/csv' : m === 'yaml' || m === 'ts' || TWO[m] ? 'text/plain' : 'application/json';
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text()], { type: mime + ';charset=utf-8' }));
  a.href = url; a.download = base + ext;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  flash(saveBtn, 'saved');
}

/* A share link carries the input in the URL fragment: deflate, then base64url. The fragment never reaches a server. */
const toB64u = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); };
const fromB64u = s => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const pump = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
async function share() {
  const data = { a: bufs.a.el.value };
  if (bufs.b.el.value.trim()) data.b = bufs.b.el.value;
  if (qEl.value.trim()) data.q = qEl.value;
  if (st.mode !== 'pretty') data.m = st.mode;
  if (!data.a.trim() && !data.b) { flash(shareBtn, 'nothing to share'); return; }
  const raw = new TextEncoder().encode(JSON.stringify(data));
  let frag;
  try { frag = 'z=' + toB64u(await pump(raw, new CompressionStream('deflate-raw'))); }
  catch (e) { frag = 'j=' + toB64u(raw); }                           /* no CompressionStream in this browser */
  if (frag.length > 2000000) { flash(shareBtn, 'too big to share'); notify('this input is too large for a link (' + fmtB(frag.length) + '). Save it as a file instead', 'err'); return; }
  const url = location.href.split('#')[0] + '#' + frag;
  try { history.replaceState(null, '', '#' + frag); } catch (e) {}
  copy(url, ok => {
    flash(shareBtn, ok ? 'link copied' : 'copy blocked');
    notify((ok ? 'share link copied' : 'share link is in the address bar') + ' (' + fmtB(url.length) + ')' +
      (url.length > 8000 ? '. It is long: some chat apps cut links this size' : '') + '. Anyone with the link can read the input');
  });
}
async function readShared() {
  const m = /^#(z|j)=([\w+\/-]+)=*$/.exec(location.hash);
  if (!m) return null;
  try {
    let raw = fromB64u(m[2]);
    if (m[1] === 'z') raw = await pump(raw, new DecompressionStream('deflate-raw'));
    const d = JSON.parse(new TextDecoder().decode(raw));
    if (typeof d.a !== 'string') throw 0;
    return { a: d.a, b: typeof d.b === 'string' ? d.b : '', q: typeof d.q === 'string' ? d.q : '', m: isMode(d.m) ? d.m : 'pretty' };
  } catch (e) { notify('that share link is damaged or incomplete', 'err'); return null; }
}

/* ---------- controls ---------- */
function sync() {
  const m = st.mode;
  document.documentElement.dataset.theme = st.theme;
  document.documentElement.dataset.fx = st.fx ? 'on' : 'off';
  const nextTheme = THEMES[(THEMES.indexOf(st.theme) + 1) % THEMES.length];
  themeBtn.textContent = 'theme: ' + st.theme;
  themeBtn.title = 'Switch theme (Alt+T). Now ' + st.theme + ', next ' + nextTheme;
  themeBtn.setAttribute('aria-label', 'Theme: ' + st.theme + '. Switch to ' + nextTheme);
  fxBtn.setAttribute('aria-pressed', st.fx);
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute(b.getAttribute('role') === 'menuitemradio' ? 'aria-checked' : 'aria-pressed', b.dataset.mode === m));
  convertBtn.setAttribute('aria-pressed', !!CONVERT[m]);
  convertBtn.textContent = CONVERT[m] ? 'convert: ' + m : 'convert';
  document.querySelectorAll('[data-ind]').forEach(b => { b.setAttribute('aria-pressed', b.dataset.ind === st.ind); b.disabled = !(TREE[m] || m === 'yaml' || m === 'ts'); });
  /* text output has no reliable split into keys and values, so there the search covers everything */
  document.querySelectorAll('[data-scope]').forEach(b => { b.setAttribute('aria-pressed', b.dataset.scope === st.scope); b.disabled = !!TEXT[m]; });
  findEl.placeholder = TEXT[m] ? 'search the output' : 'search keys and values';
  findEl.setAttribute('aria-label', TEXT[m] ? 'Search the output' : 'Search keys and values');
  document.querySelectorAll('[data-buf]').forEach(b => b.setAttribute('aria-pressed', b.dataset.buf === st.buf));
  bufs.a.el.hidden = st.buf !== 'a'; bufs.b.el.hidden = st.buf !== 'b';
  sortBtn.setAttribute('aria-pressed', st.sort);
  sortBtn.disabled = !(TREE[m] || m === 'min' || m === 'yaml');
  foldBtn.disabled = !TREE[m];
  qwrap.classList.toggle('has', qEl.value !== '');
  cmd.textContent = JF.modes.prompt(st);
  fadeAll();
  if (themeMeta) themeMeta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}
function syncButtons() {
  copyBtn.disabled = saveBtn.disabled = !hasOut;
  fmtBtn.disabled = active().state !== 'ok';
  undoBtn.disabled = !hist.length;
}
/* ---------- layout: the stdin editor, the divider, maximise, the convert menu, toolbar fades ---------- */
/* Text size and wrapping. A size of 0 leaves the stylesheet's own (13px, 16px on a phone). */
function applyEditor() {
  if (st.fs) { const m = L.metrics(st.fs); ed.style.setProperty('--efs', m.fs + 'px'); ed.style.setProperty('--elh', m.lh + 'px'); }
  else { ed.style.removeProperty('--efs'); ed.style.removeProperty('--elh'); }
  ed.classList.toggle('wrap', st.wrap);
  for (const id of ['a', 'b']) bufs[id].el.wrap = st.wrap ? 'soft' : 'off';
  lineHpx = 0; gutWin = '';
  const now = Math.round(parseFloat(getComputedStyle(ed).fontSize)) || 13;
  fsVal.textContent = now + 'px';
  fsDown.disabled = now <= L.FS_MIN; fsUp.disabled = now >= L.FS_MAX;
  wrapBtn.setAttribute('aria-pressed', st.wrap);
  const a = active();
  errline.hidden = st.wrap || !(a.state === 'err' && !a.jwt);
  updateGutter(); posErr();
}
const stepFs = by => { st.fs = L.normFs((parseFloat(getComputedStyle(ed).fontSize) || 13) + by); applyEditor(); save(); };
fsDown.addEventListener('click', () => stepFs(-1));
fsUp.addEventListener('click', () => stepFs(1));
fsVal.addEventListener('click', () => { st.fs = 0; applyEditor(); save(); });
wrapBtn.addEventListener('click', () => { st.wrap = !st.wrap; applyEditor(); save(); });
hlBtn.addEventListener('click', () => { st.hl = !st.hl; paintHl(true); save(); });

/* Syntax colours and bracket matching: the text is drawn in #hl behind the textarea (see style.css). Off above
   HL_MAX characters, where drawing it all again on each change would be felt. */
let hlRaf = 0, hlText = null, hlKey = '', hlPairs = null;
function syncHl() {
  const el = active().el;
  hlEl.style.setProperty('--sbw', (el.offsetWidth - el.clientWidth) + 'px');
  hlin.style.transform = 'translate(' + (-el.scrollLeft) + 'px,' + (-el.scrollTop) + 'px)';
}
function paintHl(now) {
  if (now) { cancelAnimationFrame(hlRaf); hlRaf = 0; drawHl(); return; }
  if (!hlRaf) hlRaf = requestAnimationFrame(() => { hlRaf = 0; drawHl(); });
}
function drawHl() {
  const el = active().el, v = el.value, on = st.hl && v.length <= L.HL_MAX;
  hlBtn.setAttribute('aria-pressed', st.hl);
  hlBtn.textContent = st.hl && !on ? 'syntax: off' : 'syntax';
  ed.classList.toggle('hl-on', on);
  if (!on) { hlin.textContent = ''; hlText = null; return; }
  if (v !== hlText) { hlText = v; hlPairs = null; hlKey = '#'; }
  let touch = null;
  if (document.activeElement === el && el.selectionStart === el.selectionEnd) {
    const at = el.selectionStart, near = c => c !== undefined && '{}[]'.indexOf(c) >= 0;
    if (near(v[at - 1]) || near(v[at])) { hlPairs = hlPairs || L.pairs(v); touch = L.touching(v, at, hlPairs); }
  }
  const key = touch ? touch.at + ':' + touch.to : '';
  if (key !== hlKey) { hlKey = key; hlin.innerHTML = L.highlight(v, touch); }
  syncHl();
}
/* where the caret is, and the bracket it touches */
function showCaret() {
  const el = active().el;
  if (document.activeElement !== el) { paintHl(); return; }
  const v = el.value, a = el.selectionStart, z = el.selectionEnd;
  if (v.length > 1000000) caretEl.textContent = 'char ' + (a + 1).toLocaleString('en');      /* counting lines in a huge text on every key is not worth it */
  else { const p = L.caretPos(v, a); caretEl.textContent = 'ln ' + p.line.toLocaleString('en') + ', col ' + p.col; }
  if (z > a) caretEl.textContent += ' (' + (z - a).toLocaleString('en') + ' selected)';
  paintHl();
}
let caretRaf = 0;
document.addEventListener('selectionchange', () => { if (!caretRaf) caretRaf = requestAnimationFrame(() => { caretRaf = 0; showCaret(); }); });
ed.addEventListener('focusin', () => paintHl());
ed.addEventListener('focusout', () => paintHl());

/* The divider. Each layout (side by side, stacked) remembers its own ratio. */
const ratio = () => stacked.matches ? st.split.v : st.split.h;
function applySplit() {
  const [a, b] = L.shares(ratio());
  panes.style.setProperty('--a', a + 'fr'); panes.style.setProperty('--b', b + 'fr');
  splitEl.setAttribute('aria-valuenow', Math.round(ratio() * 100));
  splitEl.setAttribute('aria-orientation', stacked.matches ? 'horizontal' : 'vertical');
  relayout();
}
function setRatio(r) { if (stacked.matches) st.split.v = r; else st.split.h = r; applySplit(); }
/* the editor changed size: redraw what depends on it */
function relayout() { lineHpx = 0; gutWin = ''; drawGutter(); posErr(); fadeAll(); }
let dragging = false;
splitEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitEl.focus({ preventScroll: true });
  dragging = true; splitEl.setPointerCapture(e.pointerId); panes.classList.add('dragging');
});
splitEl.addEventListener('pointermove', e => {
  if (!dragging) return;
  const r = panes.getBoundingClientRect(), s = splitEl.getBoundingClientRect(), v = stacked.matches;
  setRatio(L.ratioAt(v ? e.clientY : e.clientX, v ? r.top : r.left, v ? r.height : r.width, v ? s.height : s.width, v ? 120 : 200));
});
const endDrag = () => { if (!dragging) return; dragging = false; panes.classList.remove('dragging'); save(); };
splitEl.addEventListener('pointerup', endDrag);
splitEl.addEventListener('pointercancel', endDrag);
splitEl.addEventListener('lostpointercapture', endDrag);
splitEl.addEventListener('dblclick', () => { setRatio(stacked.matches ? L.SPLIT_DEFAULT.v : L.SPLIT_DEFAULT.h); save(); });
splitEl.addEventListener('keydown', e => {
  const back = stacked.matches ? 'ArrowUp' : 'ArrowLeft', fwd = stacked.matches ? 'ArrowDown' : 'ArrowRight';
  let r = null;
  if (e.key === back) r = L.nudge(ratio(), -0.03);
  else if (e.key === fwd) r = L.nudge(ratio(), 0.03);
  else if (e.key === 'Home') r = 0;
  else if (e.key === 'End') r = 1;
  else if (e.key === 'Enter') r = stacked.matches ? L.SPLIT_DEFAULT.v : L.SPLIT_DEFAULT.h;
  if (r === null) return;
  e.preventDefault();
  setRatio(L.clampRatio(r)); save();
});
/* Maximise: one pane fills the window. Not saved; a reload shows both. */
function setMax(which) {
  st.max = which;
  if (which) panes.dataset.fill = which; else delete panes.dataset.fill;
  for (const b of document.querySelectorAll('[data-max]')) {
    const on = b.dataset.max === which;
    b.setAttribute('aria-pressed', on); b.textContent = on ? 'restore' : 'max';
  }
  relayout();
}
/* a shortcut that needs the pane that is hidden brings both back */
const showPane = which => { if (st.max && st.max !== which) setMax(''); };
document.querySelectorAll('[data-max]').forEach(b => b.addEventListener('click', () => setMax(st.max === b.dataset.max ? '' : b.dataset.max)));
stacked.addEventListener('change', () => { applySplit(); applyEditor(); });
const applyLayout = () => { applySplit(); applyEditor(); };

/* A toolbar that is wider than its pane scrolls sideways. Fade the edge that still has buttons behind it. */
const scrollers = [...document.querySelectorAll('.bar > .acts')];
function fade(el) {
  const l = el.scrollLeft > 1, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  if (l || r) el.dataset.fade = l && r ? 'lr' : l ? 'l' : 'r'; else delete el.dataset.fade;
}
function fadeAll() { scrollers.forEach(fade); }
scrollers.forEach(el => el.addEventListener('scroll', () => { fade(el); closeMenu(); }, { passive: true }));
if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(fadeAll); scrollers.forEach(el => ro.observe(el)); }
addEventListener('resize', () => { fadeAll(); closeMenu(); });

/* The convert menu. Fixed-position, so the sideways-scrolling toolbar cannot clip it. */
function openMenu(focusFirst) {
  const r = convertBtn.getBoundingClientRect();
  cmenu.hidden = false;
  cmenu.style.left = Math.max(4, Math.min(r.left, innerWidth - cmenu.offsetWidth - 4)) + 'px';
  cmenu.style.top = (r.bottom + 2) + 'px';
  convertBtn.setAttribute('aria-expanded', 'true');
  if (focusFirst) (cmenu.querySelector('[aria-checked="true"]') || cmenu.firstElementChild).focus();
}
function closeMenu(refocus) {
  if (cmenu.hidden) return;
  cmenu.hidden = true;
  convertBtn.setAttribute('aria-expanded', 'false');
  if (refocus) convertBtn.focus();
}
convertBtn.addEventListener('click', () => { if (cmenu.hidden) openMenu(false); else closeMenu(); });
convertBtn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(true); } });
cmenu.addEventListener('click', e => { if (e.target.closest('[data-mode]')) closeMenu(true); });
cmenu.addEventListener('keydown', e => {
  const items = [...cmenu.querySelectorAll('button')], i = items.indexOf(document.activeElement), k = e.key;
  if (k === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (k === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (k === 'Home') items[0].focus();
  else if (k === 'End') items[items.length - 1].focus();
  else if (k === 'Escape') closeMenu(true);
  else if (k === 'Tab') { closeMenu(); return; }
  else return;
  e.preventDefault();
});
document.addEventListener('pointerdown', e => { if (!cmenu.hidden && !cmenu.contains(e.target) && !convertBtn.contains(e.target)) closeMenu(); });
addEventListener('blur', () => closeMenu());

/* ---------- persistence ----------
   Settings are small and live in localStorage under KEY. Tab text can run to many megabytes, so it goes to
   IndexedDB, written a moment after the last change and again when the page is hidden. Where IndexedDB is
   missing or fails, the text goes to localStorage instead (KEY.a and KEY.b). `where` in the settings records
   which store holds the latest text, so boot never reads a stale copy from the other one.
   Older versions kept the text inside the settings as s and b; that copy stays until the new store has it. */
const DB = 'scanline-json', TABS = 'tabs', TAB_DELAY = 400;
let booted = false, paused = false, pristine = false, where = '', legacy = null, tabTimer = 0, stored = null, warnedFull = false, dbP = null;
function openDB() {
  return dbP || (dbP = new Promise(done => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(TABS);
      r.onsuccess = () => done(r.result);
      r.onerror = () => done(null);
    } catch (e) { done(null); }
  }));
}
function idb(mode, work) {
  return openDB().then(db => db && new Promise(done => {
    try {
      const tx = db.transaction(TABS, mode), os = tx.objectStore(TABS), out = work(os);
      tx.oncomplete = () => done(out.length ? out.map(r => r.result) : true);
      tx.onerror = tx.onabort = () => done(null);
    } catch (e) { done(null); }
  }));
}
const tabRec = t => t && typeof t === 'object' && typeof t.text === 'string' ? { text: t.text, name: typeof t.name === 'string' ? t.name : '' } : null;
async function loadTabs(saved) {
  if (saved && typeof saved.s === 'string') {
    legacy = { s: saved.s, b: typeof saved.b === 'string' ? saved.b : '' };
    return { a: { text: legacy.s, name: '' }, b: { text: legacy.b, name: '' } };
  }
  const fromLS = () => { try { const a = tabRec(JSON.parse(localStorage.getItem(KEY + '.a'))), b = tabRec(JSON.parse(localStorage.getItem(KEY + '.b'))); return a || b ? { a, b } : null; } catch (e) { return null; } };
  if (saved && saved.where === 'ls') return fromLS();
  const got = await idb('readonly', os => [os.get('a'), os.get('b')]);
  if (got && (got[0] || got[1])) return { a: tabRec(got[0]), b: tabRec(got[1]) };
  return fromLS();
}
function writeSettings() {
  const s = { mode: st.mode, ind: st.ind, sort: st.sort, theme: st.theme, buf: st.buf, scope: st.scope, fx: st.fx, where, split: st.split, wrap: st.wrap, fs: st.fs, hl: st.hl };
  if (legacy) { s.s = legacy.s; s.b = legacy.b; }
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
}
async function saveTabs() {
  clearTimeout(tabTimer);
  if (!booted || paused || pristine) return;           /* an untouched sample is not the visitor's input */
  const now = { a: { text: bufs.a.el.value, name: bufs.a.name }, b: { text: bufs.b.el.value, name: bufs.b.name } };
  if (stored && ['a', 'b'].every(k => stored[k].text === now[k].text && stored[k].name === now[k].name)) return;
  let to = '';
  if (await idb('readwrite', os => { os.put(now.a, 'a'); os.put(now.b, 'b'); return []; })) {
    to = 'idb';
    try { localStorage.removeItem(KEY + '.a'); localStorage.removeItem(KEY + '.b'); } catch (e) {}
  } else {
    try { localStorage.setItem(KEY + '.a', JSON.stringify(now.a)); localStorage.setItem(KEY + '.b', JSON.stringify(now.b)); to = 'ls'; }
    catch (e) { try { localStorage.removeItem(KEY + '.a'); localStorage.removeItem(KEY + '.b'); } catch (x) {} }
  }
  if (!to) {
    if (!warnedFull) { warnedFull = true; notify('this input is too large to keep in this browser. It stays on screen, but will not come back after a reload', 'err'); }
    return;
  }
  stored = now; where = to; legacy = null; warnedFull = false;
  writeSettings();
}
/* Called after every change: settings now, tab text shortly after. */
function save() {
  if (!booted || paused) return;
  writeSettings();
  clearTimeout(tabTimer);
  tabTimer = setTimeout(saveTabs, TAB_DELAY);
}
addEventListener('pagehide', () => { saveTabs(); });
/* "clear saved data": remove this app's keys (never other pages' data, which can share a file:// origin) and
   the database, then empty both tabs. Nothing is saved again until the next edit or load. */
async function clearSaved() {
  clearTimeout(tabTimer);
  paused = true;
  try { for (const k of JF.modes.ownKeys(Object.keys(localStorage), [KEY])) localStorage.removeItem(k); } catch (e) {}
  const db = dbP && await dbP;
  if (db) db.close();
  dbP = null;
  await new Promise(done => { try { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => done(); } catch (e) { done(); } });
  stored = legacy = null; where = '';
  hist.length = redo.length = 0;
  for (const id of ['b', 'a']) { setValue(bufs[id], ''); bufs[id].name = ''; }
  qEl.value = ''; findEl.value = '';
  if (st.buf !== 'a') setBuf('a', true);
  sync(); updateGutter();
  analyse('b'); analyse('a');
  notify('saved input and settings are cleared from this browser. Your next edit starts saving again');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveTabs(); });

function setMode(m) { st.mode = m; sync(); save(); render(); }
function setQuery(q) { qEl.value = q === '$' ? '' : q; sync(); save(); render(); }

document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-ind]').forEach(b => b.addEventListener('click', () => { st.ind = b.dataset.ind; sync(); save(); render(); }));
document.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { st.scope = b.dataset.scope; sync(); save(); if (findEl.value) render(); }));
document.querySelectorAll('[data-buf]').forEach(b => b.addEventListener('click', () => { setBuf(b.dataset.buf); active().el.focus(); }));
sortBtn.addEventListener('click', () => { st.sort = !st.sort; sync(); save(); render(); });
foldBtn.addEventListener('click', () => { if (!TREE[st.mode] || !view) return; folded = !folded; select(null); drawTree(folded ? 1 : Infinity); footer(active()); });
copyBtn.addEventListener('click', () => { if (hasOut) copyVia(copyBtn, text()); });
saveBtn.addEventListener('click', saveFile);
fmtBtn.addEventListener('click', formatInPlace);
undoBtn.addEventListener('click', undo);
shareBtn.addEventListener('click', share);
themeBtn.addEventListener('click', () => { st.theme = THEMES[(THEMES.indexOf(st.theme) + 1) % THEMES.length]; sync(); save(); });
fxBtn.addEventListener('click', () => { st.fx = !st.fx; sync(); save(); });
$('helpBtn').addEventListener('click', () => help.showModal());
/* two clicks, so a stray one cannot wipe anything */
const wipeBtn = $('wipe');
wipeBtn.addEventListener('click', () => {
  if (wipeBtn.dataset.armed) { delete wipeBtn.dataset.armed; clearTimeout(wipeBtn._t); wipeBtn.textContent = 'clear saved data'; help.close(); clearSaved(); return; }
  wipeBtn.dataset.armed = '1'; wipeBtn.textContent = 'click again to clear';
  clearTimeout(wipeBtn._t);
  wipeBtn._t = setTimeout(() => { delete wipeBtn.dataset.armed; wipeBtn.textContent = 'clear saved data'; }, 4000);
});
$('sample').addEventListener('click', () => replaceInput(st.buf, SAMPLE, 'sample.json'));
$('clear').addEventListener('click', () => { replaceInput(st.buf, '', ''); active().el.focus(); });
$('open').addEventListener('click', () => file.click());
file.addEventListener('change', () => { readFile(file.files[0]); file.value = ''; });

msg.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'sample') replaceInput(st.buf, SAMPLE, 'sample.json');
  else if (act === 'fix') applyFix(b.dataset.buf);
  else if (act === 'jwt') { const t = bufs[b.dataset.buf]; if (t.jwt) replaceInput(t.id, JSON.stringify(t.jwt), t.name); }
  else if (act === 'jump') jump(b.dataset.buf, +b.dataset.at);
  else if (act === 'tab') { showPane('in'); setBuf(b.dataset.buf); active().el.focus(); }
  else if (act === 'gen') replaceInput('b', C.ser(V.schema(bufs.a.res.root), indStr(), plain, false), 'schema.json');
  else if (act === 'clearq') setQuery('');
  else if (act === 'clearfind') { findEl.value = ''; render(); findEl.focus(); }
});

/* query prompt */
qEl.addEventListener('input', () => {
  qwrap.classList.toggle('has', qEl.value !== '');
  clearTimeout(qTimer);
  qTimer = setTimeout(render, 160);
});
qEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(qTimer); render(); }
  else if (e.key === 'Escape') { if (qEl.value) { e.preventDefault(); clearTimeout(qTimer); setQuery(''); } else qEl.blur(); }
});

/* search box */
function hopText(dir) {
  if (!tq || !tq.n) return;
  const was = pre.querySelectorAll('mark.now');
  was.forEach(m => m.classList.remove('now'));
  tq.cur = tq.cur < 0 ? (dir > 0 ? 0 : tq.n - 1) : (tq.cur + dir + tq.n) % tq.n;
  const now = pre.querySelectorAll('mark[data-m="' + tq.cur + '"]');
  now.forEach(m => m.classList.add('now'));
  if (now[0]) now[0].scrollIntoView({ block: 'center', inline: 'nearest' });
  findN.textContent = (tq.cur + 1).toLocaleString('en') + ' of ' + pl(tq.n, 'match', 'matches') + (tq.more ? ' marked' : '');
}
function hop(dir) {
  if (!pre.hidden) { hopText(dir); return; }
  const hits = tree.hidden ? [] : [...tree.querySelectorAll('.ln.hit')];
  if (!hits.length) return;
  let i = sel ? hits.indexOf(sel) : -1;
  i = i < 0 ? (dir > 0 ? 0 : hits.length - 1) : (i + dir + hits.length) % hits.length;
  reveal(hits[i]);
  select(hits[i]);
  hits[i].scrollIntoView({ block: 'center' });
  findN.textContent = (i + 1).toLocaleString('en') + ' of ' + pl(sq ? sq.n : hits.length, 'match', 'matches');
}
findEl.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(refind, 140);
});
/* Text output only needs its marks redrawn. Diff and validate lists have no search, so they switch to the tree. */
function refind() {
  clearTimeout(findTimer);
  if (findEl.value && TWO[st.mode]) { st.mode = 'pretty'; sync(); save(); }
  if (TEXT[st.mode] && hasOut && txt !== null && !pre.hidden) paintText();
  else render();
}
findEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); hop(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { if (findEl.value) { e.preventDefault(); findEl.value = ''; refind(); } else findEl.blur(); }
});

/* page-wide shortcuts */
addEventListener('keydown', e => {
  if (help.open) return;
  const mod = e.ctrlKey || e.metaKey, tag = e.target.tagName, typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (mod && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'f') { if (document.activeElement !== findEl) { e.preventDefault(); showPane('out'); findEl.focus(); findEl.select(); } return; }   /* a second Ctrl+F reaches the browser's own find */
    if (k === 's') { e.preventDefault(); saveFile(); return; }
    if (e.key === 'Enter') { e.preventDefault(); formatInPlace(); return; }
  }
  if (e.altKey && !mod) {
    const act = { KeyQ: () => { qEl.focus(); qEl.select(); }, KeyC: () => copyBtn.click(), KeyM: () => setMode(st.mode === 'min' ? 'pretty' : 'min'),
                  KeyS: () => sortBtn.click(), KeyF: () => foldBtn.click(), KeyT: () => themeBtn.click(),
                  Digit1: () => { showPane('in'); setBuf('a'); active().el.focus(); }, Digit2: () => { showPane('in'); setBuf('b'); active().el.focus(); } }[e.code];
    if (act) { e.preventDefault(); act(); }
    return;
  }
  if (mod && !e.altKey && !typing) {              /* undo and redo also work when focus is on a button or the tree */
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey && hist.length) { e.preventDefault(); undo(); }
    else if ((k === 'y' || (k === 'z' && e.shiftKey)) && redo.length) { e.preventDefault(); redoIt(); }
    return;
  }
  if (typing || mod) return;
  if (e.key === '/') { e.preventDefault(); showPane('out'); findEl.focus(); findEl.select(); }
  else if (e.key === '?') { e.preventDefault(); help.showModal(); }
  else if (e.key === 'Escape' && !insp.hidden) select(null);
});
addEventListener('hashchange', async () => {
  const d = await readShared();
  if (!d) return;
  qEl.value = d.q; st.mode = d.m;
  replaceInput('b', d.b, '');
  replaceInput('a', d.a, 'shared');
  if (st.buf !== 'a') setBuf('a', true);
  sync(); render();
});

/* ---------- boot ---------- */
(async () => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!saved || typeof saved !== 'object') saved = null;
  /* a tool page says which mode it opens in, and may bring its own starting input and query */
  let page = null;
  try { const el = $('page'); if (el) page = JSON.parse(el.textContent); } catch (e) {}
  if (saved) {
    if (saved.ind === '2' || saved.ind === '4' || saved.ind === 'tab') st.ind = saved.ind;
    if (THEMES.indexOf(saved.theme) >= 0) st.theme = saved.theme;
    if (saved.scope === 'all' || saved.scope === 'keys' || saved.scope === 'values') st.scope = saved.scope;
    if (saved.fx === false) st.fx = false;
    st.split = L.normSplit(saved.split); st.wrap = saved.wrap === true; st.fs = L.normFs(saved.fs); if (saved.hl === false) st.hl = false;
    if (saved.where === 'idb' || saved.where === 'ls') where = saved.where;
    st.sort = !!saved.sort;
  }
  st.mode = page && isMode(page.mode) ? page.mode : saved && isMode(saved.mode) ? saved.mode : st.mode;
  sync();                                           /* theme and effects before the wait for stored text */
  const tabs = await loadTabs(saved), shared = await readShared();
  const s = JF.modes.start({ shared, page, saved, tabs, sample: SAMPLE });
  st.mode = s.mode; st.buf = s.buf; qEl.value = s.q;
  for (const id of ['a', 'b']) { bufs[id].el.value = s[id].text; bufs[id].name = s[id].name; }
  if (s.from === 'saved' && !legacy) stored = { a: s.a, b: s.b };   /* already stored; legacy text still has to move */
  pristine = s.from === 'page' || s.from === 'sample';
  /* settings without text: an older version could not keep input over 200,000 characters */
  if (s.from === 'lost' && saved.s === null) notify('the last input was too large for this browser to keep, so it could not be restored', 'err');
  booted = true;
  sync(); applyLayout();
  analyse('b'); analyse('a');
})();

window.__jsonfmt = JF;   /* handy from the console: __jsonfmt.core.parse(text), __jsonfmt.query(root, "$.a") */
})();
