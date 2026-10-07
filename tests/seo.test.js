/* Checks the built site in dist/ for what search engines and link previews need.   Run:  node build.js && node tests/seo.test.js
   Plain Node, no packages. The HTML is our own generated output, so simple pattern matching is enough to read it.
   This reads files only: requests made by scripts while a page runs are checked in a real browser, not here. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist');
const { inspect } = require('../tools/png');
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('dist/ has no site yet. Run  node build.js  first.'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n   ' + JSON.stringify(extra) : '')); } };
const cfg = require('../tools/config').load(), base = cfg.siteUrl.replace(/\/+$/, '');   /* the same address the build used, SITE_URL included */
const ctx = { JF: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/modes.js'), 'utf8'), ctx);

const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = s => { const o = {}; for (const m of s.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) o[m[1].toLowerCase()] = m[2] === undefined ? '' : unesc(m[2]); return o; };
const tags = (html, name) => [...html.matchAll(new RegExp('<' + name + '\\b([^>]*)>', 'gi'))].map(m => attrs(m[1]));
const meta = (html, key, val) => (tags(html, 'meta').find(a => a[key] === val) || {}).content;
const text = h => unesc(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const words = docHtml => docHtml.split('<h2>Related tools</h2>')[0].replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot);/g, 'x').split(/\s+/).filter(w => /\w/.test(w)).length;
const external = u => /^(https?:)?\/\//i.test(u);

/* every page: dist/index.html and dist/<slug>/index.html, plus 404.html */
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name === 'index.html') pages.push({ file: f, url: '/' + path.relative(DIST, dir).split(path.sep).filter(Boolean).map(x => x + '/').join('') });
  }
})(DIST);
const notFound = { file: path.join(DIST, '404.html'), url: '/404.html', is404: true };
ok(fs.existsSync(notFound.file), '404.html exists');
ok(pages.length >= 11, 'all tool pages were built', pages.map(p => p.url));

/* resolve a link on a page to a file in dist/ */
function target(pageUrl, href) {
  const u = new URL(href, 'https://site.invalid' + pageUrl);
  if (u.host !== 'site.invalid') return null;
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  return path.join(DIST, rel);
}

const sitemap = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
const inMap = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/g)].map(m => ({ loc: unesc(m[1]), lastmod: m[2] }));
const titles = new Map(), descs = new Map();

for (const pg of [...pages, notFound]) {
  const html = fs.readFileSync(pg.file, 'utf8'), name = pg.url;
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1], desc = meta(html, 'name', 'description');
  ok(/<html[^>]* lang="en"/.test(html), name + ': lang attribute');
  ok(meta(html, 'name', 'viewport'), name + ': viewport meta');
  ok(/^#[0-9a-f]{6}$/i.test(meta(html, 'name', 'theme-color') || ''), name + ': theme-color');
  ok(title, name + ': has a title');
  const h1s = html.match(/<h1\b/g) || [];
  ok(h1s.length === 1, name + ': exactly one h1', h1s.length);
  /* headings never skip a level on the way down, and the h1 comes first */
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map(m => +m[1]);
  ok(levels[0] === 1 && levels.every((l, i) => !i || l <= levels[i - 1] + 1), name + ': heading order', levels.join(''));
  ok(/runs in your browser, nothing is uploaded/.test(text(html.split('</header>')[0] || html)), name + ': privacy line above the tool');

  /* nothing on the page loads from another site */
  const loads = [
    ...tags(html, 'script').map(a => a.src), ...tags(html, 'img').map(a => a.src), ...tags(html, 'img').map(a => a.srcset),
    ...tags(html, 'source').map(a => a.src || a.srcset), ...tags(html, 'iframe').map(a => a.src), ...tags(html, 'video').map(a => a.src),
    ...tags(html, 'audio').map(a => a.src), ...tags(html, 'embed').map(a => a.src), ...tags(html, 'object').map(a => a.data),
    ...tags(html, 'link').filter(a => /\b(stylesheet|preload|modulepreload|prefetch|preconnect|dns-prefetch|icon|apple-touch-icon|manifest)\b/.test(a.rel)).map(a => a.href),
    ...[...html.matchAll(/url\(\s*['"]?([^'")\s]+)/g)].map(m => m[1]), ...[...html.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)].map(m => m[1]),
  ].filter(Boolean);
  ok(!loads.some(external), name + ': no external requests', loads.filter(external));
  for (const u of loads.filter(u => !u.startsWith('data:'))) { const f = target(pg.url, u); ok(f && fs.existsSync(f), name + ': loads a file that exists: ' + u); }
  for (const a of tags(html, 'img')) ok(a.width && a.height, name + ': image has width and height', a.src);

  /* links inside the site lead somewhere real */
  for (const a of tags(html, 'a').filter(a => a.href && !external(a.href) && !/^(#|mailto:)/.test(a.href))) {
    const f = target(pg.url, a.href);
    ok(f && fs.existsSync(f), name + ': link to ' + a.href + ' exists');
  }
  if (pg.is404) { ok(/<meta name="robots" content="noindex">/.test(html), '404: not indexed'); continue; }

  ok(title.length <= 55, name + ': title at most 55 characters, so it is not cut off in results', title.length);
  ok(desc && desc.length <= 160, name + ': description under 160 characters', desc && desc.length);
  ok(!titles.has(title), name + ': title is unique', titles.get(title)); titles.set(title, name);
  ok(desc && !descs.has(desc), name + ': description is unique', descs.get(desc)); descs.set(desc, name);
  const canon = (tags(html, 'link').find(a => a.rel === 'canonical') || {}).href;
  ok(canon && /^https?:\/\//.test(canon), name + ': canonical is absolute', canon);
  ok(canon === base + pg.url, name + ': canonical matches the page address', canon);
  /* the Search Console ownership tag: on the home page only, and only when site.config.json has a code */
  ok(meta(html, 'name', 'google-site-verification') === (pg.url === '/' && cfg.googleVerification ? cfg.googleVerification : undefined), name + ': Google verification tag only on the home page', meta(html, 'name', 'google-site-verification'));
  ok(meta(html, 'property', 'og:url') === canon &&meta(html, 'property', 'og:title') && meta(html, 'property', 'og:description') && meta(html, 'property', 'og:type'), name + ': Open Graph tags');
  ok(meta(html, 'name', 'twitter:card') === 'summary_large_image' && meta(html, 'name', 'twitter:title') && meta(html, 'name', 'twitter:description'), name + ': Twitter card tags');
  const img = meta(html, 'property', 'og:image');
  ok(img && img.startsWith(base + '/') && meta(html, 'name', 'twitter:image') === img, name + ': share image is absolute', img);
  const png = img && fs.existsSync(path.join(DIST, img.slice(base.length))) ? inspect(fs.readFileSync(path.join(DIST, img.slice(base.length)))) : null;
  ok(png && png.ok && png.w === 1200 && png.h === 630 && meta(html, 'property', 'og:image:width') === '1200' && meta(html, 'property', 'og:image:height') === '630', name + ': share image is a valid 1200x630 PNG', png);

  /* structured data */
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch (e) { return { invalid: e.message }; } });
  ok(blocks.length && blocks.every(b => !b.invalid), name + ': JSON-LD is valid JSON', blocks.filter(b => b.invalid));
  const of = t => blocks.find(b => b['@type'] === t);
  const appLd = of('WebApplication');
  ok(appLd && appLd.url === canon && appLd.offers && appLd.offers.price === '0' && appLd.browserRequirements && appLd.applicationCategory, name + ': WebApplication data, free, with browser requirements');
  const faqLd = of('FAQPage'), shown = text(html);
  ok(faqLd && faqLd.mainEntity.length >= 3 && faqLd.mainEntity.length <= 5, name + ': FAQPage with 3 to 5 questions', faqLd && faqLd.mainEntity.length);
  ok(faqLd && faqLd.mainEntity.every(q => shown.includes(q.name) && shown.includes(q.acceptedAnswer.text)), name + ': every FAQ question and answer is visible on the page');
  if (pg.url !== '/') ok(of('BreadcrumbList') && of('BreadcrumbList').itemListElement.length === 2 && of('BreadcrumbList').itemListElement[1].item === canon, name + ': BreadcrumbList');
  ok(!/aggregateRating|"review"/i.test(JSON.stringify(blocks)), name + ': no ratings or reviews in structured data');

  /* the written content sits below the tool, and links on */
  const doc = (/<section class="doc"[^>]*>([\s\S]*?)<\/section>/.exec(html) || [])[1];
  ok(doc && html.indexOf('<section class="doc"') > html.indexOf('</footer>'), name + ': content section comes after the tool');
  const n = doc ? words(doc) : 0;
  ok(n >= 250 && n <= 400, name + ': 250 to 400 words of content', n);
  const related = doc ? [...doc.matchAll(/<ul class="related">([\s\S]*?)<\/ul>/g)].flatMap(m => tags(m[1], 'a')) : [];
  ok(related.length >= 2, name + ': links to related tools', related.length);
  const nav = (/<footer class="site">([\s\S]*?)<\/footer>/.exec(html) || [])[1] || '';
  ok(tags(nav, 'a').length === pages.length, name + ': footer links to every tool page', tags(nav, 'a').length);

  /* the tool opens in the page's mode, and the prompt line says so */
  const seed = JSON.parse((/<script type="application\/json" id="page">([\s\S]*?)<\/script>/.exec(html) || [, '{}'])[1]);
  const pressed = tags(html, 'button').filter(a => a['data-mode'] && (a['aria-pressed'] === 'true' || a['aria-checked'] === 'true')).map(a => a['data-mode']);
  const cmd = (/<span id="cmd">([^<]*)<\/span>/.exec(html) || [])[1];
  ok(ctx.JF.modes.isMode(seed.mode) && pressed.join() === seed.mode && cmd === ctx.JF.modes.prompt({ mode: seed.mode }), name + ': opens in its mode with a matching prompt', { mode: seed.mode, pressed, cmd });

  const entry = inMap.find(u => u.loc === canon);
  ok(entry, name + ': listed in the sitemap');
  ok(entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.lastmod), name + ': sitemap lastmod is a date', entry && entry.lastmod);
}

/* site files */
ok(inMap.length === pages.length && inMap.every(u => pages.some(p => base + p.url === u.loc)), 'the sitemap lists exactly the built pages', inMap.map(u => u.loc));
const robots = fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8');
ok(/User-agent: \*\nAllow: \//.test(robots) && robots.includes('Sitemap: ' + base + '/sitemap.xml'), 'robots.txt allows all and points to the sitemap');
const man = JSON.parse(fs.readFileSync(path.join(DIST, 'site.webmanifest'), 'utf8'));
ok(man.name === cfg.name && man.icons.length >= 2 && man.icons.every(i => !external(i.src) && fs.existsSync(path.join(DIST, i.src))), 'web manifest with local icons');
for (const [f, w] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const i = inspect(fs.readFileSync(path.join(DIST, f)));
  ok(i && i.ok && i.w === w && i.h === w, f + ' is a valid ' + w + 'px PNG', i);
}
ok(fs.readFileSync(path.join(DIST, 'favicon.ico')).readUInt16LE(2) === 1, 'favicon.ico is an icon file');
ok(/^<svg[^>]+viewBox="0 0 16 16"/.test(fs.readFileSync(path.join(DIST, 'favicon.svg'), 'utf8')), 'favicon.svg');
for (const f of fs.readdirSync(path.join(DIST, 'assets')).filter(f => f.endsWith('.css'))) {
  const css = fs.readFileSync(path.join(DIST, 'assets', f), 'utf8'), urls = [...css.matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]);
  ok(!urls.some(external) && !/@import/.test(css), 'assets/' + f + ': no external requests', urls.filter(external));
  for (const u of urls.filter(u => !u.startsWith('data:'))) ok(fs.existsSync(path.join(DIST, 'assets', u)), 'assets/' + f + ': ' + u + ' exists');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
