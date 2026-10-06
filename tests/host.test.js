/* The host files in dist/: _headers (security and caching) and _redirects (one canonical address per page).
   Run after a build:  node build.js && node tests/host.test.js
   1. _headers and _redirects are read the way Cloudflare Pages reads them and checked for what they must and must not say.
   2. Every built page is checked for what a strict Content-Security-Policy would block: inline scripts, event
      handler attributes, style attributes. (JSON-LD and the page-data block are data, not scripts.)
   3. Every page, asset and redirect is requested from the real test server (tools/serve.js), which applies the
      real files, so what is tested is what the host will do.
   What this cannot show is how a browser reacts to the policy. That is checked in a real browser, page by page. */
'use strict';
const fs = require('fs'), path = require('path');
const rules = require('../tools/hostrules'), serve = require('../tools/serve');
const DIST = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(DIST, '_headers'))) { console.log('dist/ has no site yet. Run  node build.js  first.'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n   ' + JSON.stringify(extra) : '')); } };
const read = f => fs.readFileSync(path.join(DIST, f), 'utf8');
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); e.isDirectory() ? walk(f, out) : out.push(path.relative(DIST, f).split(path.sep).join('/')); } return out; };
const files = walk(DIST);

const pageFiles = files.filter(f => /(^|\/)index\.html$/.test(f)), pagePaths = pageFiles.map(f => '/' + f.replace(/index\.html$/, ''));
const sitemapPaths = [...read('sitemap.xml').matchAll(/<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g)].map(m => m[1]);
const headerText = read('_headers'), redirectText = read('_redirects');

/* ---------- 1. _headers ---------- */
const H = rules.parseHeaders(headerText);
ok(H.length > 0 && H.length <= 100, '_headers has between 1 and 100 rules (Cloudflare allows 100)', H.length);
ok(headerText.split('\n').every(l => l.length <= 2000), '_headers has no line over 2,000 characters (Cloudflare limit)');
const all = rules.headersFor(H, '/no/such/page').headers;
ok(all['X-Content-Type-Options'] === 'nosniff', 'X-Content-Type-Options: nosniff on every response', all['X-Content-Type-Options']);
ok(all['Referrer-Policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy: strict-origin-when-cross-origin', all['Referrer-Policy']);
ok(['camera', 'microphone', 'geolocation', 'payment', 'usb'].every(f => new RegExp('\\b' + f + '=\\(\\)').test(all['Permissions-Policy'] || '')), 'Permissions-Policy switches off camera, microphone, geolocation, payment and usb', all['Permissions-Policy']);
ok(!/clipboard/.test(all['Permissions-Policy'] || ''), 'Permissions-Policy leaves clipboard access alone (copy and share need it)');
const csp = Object.fromEntries((all['Content-Security-Policy'] || '').split(';').map(d => d.trim()).filter(Boolean).map(d => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));
ok(csp['default-src'] && csp['default-src'].join() === "'none'", "CSP starts from default-src 'none'", csp['default-src']);
ok(csp['frame-ancestors'] && csp['frame-ancestors'].join() === "'none'", "CSP has frame-ancestors 'none'", csp['frame-ancestors']);
ok(csp['script-src'] && csp['script-src'].join() === "'self'", "CSP: scripts only from the site itself", csp['script-src']);
ok(csp['worker-src'] && csp['worker-src'].join() === 'blob:', 'CSP: workers only from blob: (the parsing worker)', csp['worker-src']);
ok(['style-src', 'font-src', 'img-src', 'manifest-src'].every(d => csp[d] && csp[d].join() === "'self'"), "CSP: styles, fonts, images and the manifest only from the site itself");
const allowed = Object.values(csp).flat();
ok(!allowed.some(v => /^(https?|wss?|ftp):|\*|^data:|unsafe-/.test(v) || /\./.test(v)), 'CSP names no external host, no wildcard, no data:, no unsafe-inline or unsafe-eval', allowed.filter(v => /^(https?|wss?|ftp):|\*|^data:|unsafe-/.test(v) || /\./.test(v)));
ok(!('connect-src' in csp) && !('frame-src' in csp) && !('object-src' in csp), "connections, frames and objects fall back to 'none'");

const assetFiles = files.filter(f => f.startsWith('assets/'));
const cache = p => rules.headersFor(H, p).headers['Cache-Control'];
const expect = [
  ...pagePaths.map(p => [p, rules.CACHE.html, 'page ' + p]), ['/404.html', rules.CACHE.html, '404 page'],
  ...assetFiles.map(f => ['/' + f, rules.CACHE.asset, 'asset ' + f]),
  ['/robots.txt', rules.CACHE.file, 'robots.txt'], ['/sitemap.xml', rules.CACHE.file, 'sitemap.xml'], ['/site.webmanifest', rules.CACHE.file, 'manifest'],
];
for (const [p, want, label] of expect) ok(cache(p) === want, 'caching: ' + label, cache(p));
ok(cache('/favicon.ico') === undefined && cache('/og/home.png') === undefined, 'icons and share images have no rule of their own (host default)');
ok(/max-age=31536000/.test(rules.CACHE.asset) && /immutable/.test(rules.CACHE.asset) && /max-age=0/.test(rules.CACHE.html) && /must-revalidate/.test(rules.CACHE.html) && /must-revalidate/.test(rules.CACHE.file), 'assets cache for a year, pages and small files are revalidated');
const probe = [...expect.map(e => e[0]), '/', '/favicon.ico', '/og/home.png', '/no/such/page', '/no/such/page/', '/assets/fonts/'];
const repeated = probe.map(p => [p, rules.headersFor(H, p).repeated]).filter(x => x[1].length);
ok(!repeated.length, 'no header is set by two rules for the same address (Cloudflare would join the values with a comma)', repeated);
ok(rules.headersFor(H, '/').headers['Cache-Control'] === rules.CACHE.html, 'the home page address "/" is covered');
ok(rules.match('/*/', '/json-diff/') && !rules.match('/*/', '/') && rules.match('/assets/*', '/assets/fonts/x.woff2') && !rules.match('/assets/*', '/assetsx'), 'pattern matching behaves as documented (splat, exact root)');

/* ---------- 1b. _redirects ---------- */
const R = rules.parseRedirects(redirectText);
const slugs = sitemapPaths.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
ok(R.length > 0 && R.length <= 2000, '_redirects has at most 2,000 rules (Cloudflare limit)', R.length);
ok(redirectText.split('\n').every(l => l.length <= 1000), '_redirects has no line over 1,000 characters');
ok(R.every(r => r.status === 301), 'every redirect is spelled out as 301 (the default would be 302)');
ok(R.every(r => !/[*:]/.test(r.from + r.to)), 'every redirect is a plain address, no splat or placeholder (so rule order cannot matter)');
ok(new Set(R.map(r => r.from)).size === R.length, 'no source is listed twice');
const target = f => R.find(r => r.from === f);
ok(target('/index.html') && target('/index.html').to === '/', '/index.html goes to /');
for (const s of slugs) {
  ok(target('/' + s) && target('/' + s).to === '/' + s + '/', 'redirect: /' + s + ' goes to /' + s + '/');
  ok(target('/' + s + '/index.html') && target('/' + s + '/index.html').to === '/' + s + '/', 'redirect: /' + s + '/index.html goes to /' + s + '/');
}
ok(sitemapPaths.length === pagePaths.length && sitemapPaths.every(p => /^\/([a-z0-9]+(-[a-z0-9]+)*\/)?$/.test(p)), 'every canonical address is lowercase with a trailing slash', sitemapPaths.filter(p => !/^\/([a-z0-9]+(-[a-z0-9]+)*\/)?$/.test(p)));
ok(sitemapPaths.every(p => !rules.redirectFor(R, p)), 'no canonical address is itself redirected');
ok(R.every(r => !rules.redirectFor(R, r.to)), 'no redirect chains: every destination is final', R.filter(r => rules.redirectFor(R, r.to)));
ok(R.every(r => sitemapPaths.includes(r.to)), 'every destination is a canonical address', R.filter(r => !sitemapPaths.includes(r.to)).map(r => r.to));
ok(R.every(r => r.from === r.from.toLowerCase()), 'every redirect source is lowercase (other capitalisations are simply not found)');

/* ---------- 2. markup that a strict policy would block ---------- */
for (const f of [...pageFiles, '404.html']) {
  const html = read(f), name = '/' + f.replace(/index\.html$/, '');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc=/.test(m[1]) && !/type="application\/(ld\+)?json"/.test(m[1]) && m[2].trim());
  ok(!inline.length, name + ': no inline scripts', inline.map(m => m[2].slice(0, 60)));
  ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script type="application\/(ld\+)?json"[\s\S]*?<\/script>/g, '')), name + ': no event handler attributes');
  ok(!/\sstyle\s*=/i.test(html) && !/<style\b/i.test(html), name + ': no style attributes or style elements');
  ok(!/javascript:/i.test(html), name + ': no javascript: addresses');
  ok(!/<(iframe|object|embed|form|base)\b/i.test(html.replace(/<form method="dialog"[\s\S]*?<\/form>/, '')), name + ': no frames, objects, embeds, forms or base tags (apart from the help dialog)');
}
for (const f of assetFiles.filter(f => f.endsWith('.js'))) {
  const js = read(f);
  ok(!/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/.test(js), f + ': no eval, Function constructor or string timers');
  ok(!/https?:\/\//.test(js.replace(/https:\/\/(json-schema\.org|example\.com|developers\.cloudflare\.com)[^\s'"`)]*/g, '')), f + ': no other web addresses in the script (only the schema URL it writes, and example text)');
}
for (const f of assetFiles.filter(f => f.endsWith('.css'))) ok(!/@import|url\(\s*['"]?(https?:)?\/\//.test(read(f)), f + ': stylesheet loads nothing external');

/* ---------- 3. through the real test server ---------- */
(async () => {
  const server = await serve.start(DIST, 0, '127.0.0.1'), base = 'http://127.0.0.1:' + server.address().port;
  const get = (p, opts = {}) => fetch(base + p, Object.assign({ redirect: 'manual' }, opts));
  const wantCsp = rules.CSP;
  try {
    for (const p of pagePaths) {
      const r = await get(p), body = await r.text();
      ok(r.status === 200 && /^text\/html/.test(r.headers.get('content-type')) && /<h1>/.test(body), 'GET ' + p + ' is 200 html', r.status);
      ok(r.headers.get('content-security-policy') === wantCsp && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') && r.headers.get('permissions-policy'), 'GET ' + p + ' carries the security headers from _headers');
      ok(r.headers.get('cache-control') === rules.CACHE.html, 'GET ' + p + ' is revalidated', r.headers.get('cache-control'));
    }
    for (const r0 of R) {
      const a = await get(r0.from);
      ok(a.status === 301 && a.headers.get('location') === r0.to, 'GET ' + r0.from + ' answers 301 to ' + r0.to, [a.status, a.headers.get('location')]);
      const b = await get(a.headers.get('location'));
      ok(b.status === 200, '... and that address answers 200 with no second redirect', b.status);
    }
    const q = await get('/json-diff?x=1');
    ok(q.status === 301 && q.headers.get('location') === '/json-diff/?x=1', 'a redirect keeps the query string', q.headers.get('location'));
    for (const p of ['/JSON-DIFF/', '/Json-Diff/', '/json-diff/INDEX.HTML', '/json-diff//', '/no/such/page', '/assets/missing.js', '/robots.txt/']) {
      const r = await get(p), body = await r.text();
      ok(r.status === 404 && /page not found/.test(body), 'GET ' + p + ' is the 404 page', r.status);
    }
    const nf = await get('/no/such/page');
    ok(nf.headers.get('content-security-policy') === wantCsp && nf.headers.get('x-content-type-options') === 'nosniff', 'the 404 page carries the security headers too');
    const home = await (await get('/')).text();
    const js = (/<script defer src="([^"]+)"/.exec(home) || [])[1], css = (/<link rel="stylesheet" href="([^"]+)"/.exec(home) || [])[1], font = (/<link rel="preload" href="([^"]+)"/.exec(home) || [])[1];
    for (const [label, p, type] of [['script', js, /javascript/], ['stylesheet', css, /css/], ['font', font, /woff2/]]) {
      const r = await get('/' + p);
      ok(r.status === 200 && type.test(r.headers.get('content-type')) && r.headers.get('cache-control') === rules.CACHE.asset, 'the ' + label + ' (' + p + ') is cached for a year', [r.status, r.headers.get('cache-control')]);
    }
    for (const [p, type] of [['/robots.txt', /text\/plain/], ['/sitemap.xml', /xml/], ['/site.webmanifest', /manifest/]]) {
      const r = await get(p);
      ok(r.status === 200 && type.test(r.headers.get('content-type')) && r.headers.get('cache-control') === rules.CACHE.file && r.headers.get('x-content-type-options') === 'nosniff', p + ' is 200, revalidated within the hour, with nosniff');
    }
    const gz = await get('/', { headers: { 'accept-encoding': 'gzip' } });
    ok(gz.headers.get('content-encoding') === 'gzip', 'text is gzipped when the browser accepts it');
  } finally { server.close(); }

  /* the test server really takes its headers from the files: without them there is no policy */
  const bare = await serve.start(DIST, 0, '127.0.0.1', { useRules: false });
  try {
    const r = await fetch('http://127.0.0.1:' + bare.address().port + '/', { redirect: 'manual' }), r2 = await fetch('http://127.0.0.1:' + bare.address().port + '/json-diff', { redirect: 'manual' });
    ok(!r.headers.get('content-security-policy') && r2.status === 404, 'with the rule files ignored there is no policy and no redirect, so the other results come from the files');
  } finally { bare.close(); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
