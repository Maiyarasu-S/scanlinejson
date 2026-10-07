/* modes.js: what stdout can show, the command the prompt line displays for it, and which saved or
   page-supplied state the page starts from. build.js uses the same code to write the first paint. */
(() => {
'use strict';
const MODES = ['pretty', 'min', 'yaml', 'csv', 'ts', 'schema', 'diff', 'check'];
const TREE = { pretty: 1, schema: 1 };
const isMode = m => MODES.indexOf(m) >= 0;
/* the plain word for a mode on the view button and in its menu (the prompt line keeps the command form) */
const LABEL = { pretty: 'pretty', min: 'minify', yaml: 'yaml', csv: 'csv', ts: 'ts', schema: 'schema', diff: 'diff', check: 'validate' };
const label = m => LABEL[m] || 'pretty';

/* The command shown on the prompt line, e.g. "convert --to=yaml --indent=2". */
function prompt(o) {
  const m = o.mode, ind = o.ind || '2', sort = !!o.sort;
  if (m === 'diff') return 'diff a b';
  if (m === 'check') return 'validate a --schema=b';
  if (m === 'min') return 'fmt --minify' + (sort ? ' --sort-keys' : '');
  return (TREE[m] ? 'fmt' : 'convert') + (m === 'pretty' ? '' : ' --to=' + m) + (m === 'csv' ? '' : ' --indent=' + ind) +
    (sort && m !== 'ts' && m !== 'csv' ? ' --sort-keys' : '');
}

/* Where the page starts.
     mode:  a share link, then the page's own mode, then the saved mode, then pretty.
     input: a share link, then saved tabs. When the settings say text was stored but it is gone (it could not
            be kept, or the browser dropped it) the tabs start empty. Otherwise, with no saved input, the page's
            starting input (or the sample) loads together with its query. A sample nobody has touched is not
            saved (see app.js), so it never follows the visitor to another tool page.
   o = { shared: {a,b,q,m} | null, page: {mode, a, b, q, name} | null, saved: settings | null,
         tabs: {a: {text,name} | null, b: ...} | null, sample } */
function start(o) {
  const page = o.page || {}, saved = o.saved;
  const mode = o.shared ? o.shared.m : isMode(page.mode) ? page.mode : saved && isMode(saved.mode) ? saved.mode : 'pretty';
  const tab = t => t ? { text: t.text, name: t.name } : { text: '', name: '' };
  const out = { mode, q: '', buf: saved && saved.buf === 'b' ? 'b' : 'a', from: '' };
  if (o.shared) Object.assign(out, { a: { text: o.shared.a, name: 'shared' }, b: { text: o.shared.b, name: '' }, q: o.shared.q, buf: 'a', from: 'shared' });
  else if (o.tabs) Object.assign(out, { a: tab(o.tabs.a), b: tab(o.tabs.b), from: 'saved' });
  else if (saved && (saved.where || saved.s === null)) Object.assign(out, { a: tab(null), b: tab(null), from: 'lost' });
  else if (typeof page.a === 'string') Object.assign(out, { a: { text: page.a, name: page.name || 'sample.json' }, b: { text: page.b || '', name: '' }, q: page.q || '', buf: 'a', from: 'page' });
  else Object.assign(out, { a: { text: o.sample, name: 'sample.json' }, b: tab(null), buf: 'a', from: 'sample' });
  return out;
}

/* This app's localStorage keys among `keys`: each base key itself, and anything stored under "base.". */
const ownKeys = (keys, bases) => keys.filter(k => bases.some(b => k === b || k.startsWith(b + '.')));

JF.modes = { MODES, LABEL, label, isMode, prompt, start, ownKeys };
})();
