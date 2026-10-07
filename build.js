/* build.js: plain Node, no packages. The source (index.html with css/ and js/) runs as it is; this only
   prepares copies for hosting.

     node build.js            dist/ as a multi-page site: one page per tool from pages/pages.json, with shared,
                              fingerprinted CSS, JS and fonts, plus share images, icons, sitemap, robots and 404.
     node build.js --single   dist/scanline-json.html, everything folded into one file (fonts inlined),
                              handy for emailing or opening from disk. A command, not a tracked file.
     node build.js --production   the site build, but it stops with an error unless siteUrl is a real https
                              address (not the placeholder, no trailing slash, no path). Use this for releases.

   site.config.json supplies the site address, name and author for every canonical URL and social tag. The
   SITE_URL environment variable, when set, replaces its siteUrl (how a host or CI job passes the real address).
   Without --production, a bad siteUrl only prints a loud warning.
   Options for tests and staging:  --config=<file> reads that site config,  --out=<folder> writes there. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm'), zlib = require('zlib');
const images = require('./tools/images');
const siteUrl = require('./tools/siteurl');
const config = require('./tools/config');
const host = require('./tools/hostrules');
const ARGS = process.argv.slice(2);
const option = name => { const a = ARGS.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
const ROOT = __dirname, DIST = option('out') ? path.resolve(option('out')) : path.join(ROOT, 'dist');
const read = (f, enc = 'utf8') => fs.readFileSync(path.join(ROOT, f), enc);
const LICENCES = ['fonts/OFL-IBM-Plex-Mono.txt', 'fonts/OFL-VT323.txt'];
const TEMPLATE = read('index.html');
const SCRIPTS = [...TEMPLATE.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);
const STYLES = [...TEMPLATE.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"[^>]*>/g)].map(m => m[1]);
const notice = () => LICENCES.map(l => read(l).replace(/\r\n/g, '\n').replace(/\*\//g, '* /').trim()).join('\n\n');
const write = (rel, data) => { const f = path.join(DIST, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return data; };
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => String(s).replace(/[&<>"]/g, c => escMap[c]);
const kb = n => (n / 1024).toFixed(1) + ' KB';

/* ---------- one file ---------- */
function single() {
  const css = f => read(f).replace(/url\("([^"]+\.woff2)"\)/g, (m, u) =>
    'url("data:font/woff2;base64,' + read(path.join(path.dirname(f), u), null).toString('base64') + '")');
  let html = TEMPLATE.replace(/<!--page:\w+-->\n?/g, '').replace(/<!-- weights 500[^>]*-->\n/, '');
  let first = true;
  html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)"[^>]*>/g, (m, f) => {
    const head = first ? '/* Fonts embedded below: IBM Plex Mono and VT323, SIL Open Font License 1.1.\n\n' + notice() + '\n*/\n' : '';
    first = false;
    return '<style>\n' + (head + css(f)).replace(/<\/style/gi, '<\\/style') + '</style>';
  });
  html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (m, f) => '<script>\n' + read(f).replace(/<\/script/gi, '<\\/script') + '</script>');
  write('scanline-json.html', html);
  console.log('dist/scanline-json.html', kb(html.length));
}

/* ---------- the site ---------- */
const hash = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 10);
const fingerprint = (name, data) => name.replace(/(\.\w+)$/, '.' + hash(data) + '$1');
/* text of a paragraph: `code` becomes <code>, everything else is escaped */
const rich = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const plainText = s => s.replace(/`([^`]+)`/g, '$1');
const ld = o => '<script type="application/ld+json">' + JSON.stringify(o).replace(/</g, '\\u003c') + '</script>';
/* words a reader sees in the content section, up to the related links (tests/seo.test.js counts the same way) */
const words = docHtml => docHtml.split('<h2>Related tools</h2>')[0].replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot);/g, 'x')
  .split(/\s+/).filter(w => /\w/.test(w)).length;

function site() {
  const cfg = config.load(option('config') ? path.resolve(option('config')) : undefined);

  /* Before anything is written: a placeholder address would put the wrong site in every canonical tag. */
  const urlProblems = siteUrl.check(cfg.siteUrl, cfg.siteUrlFrom);
  const warn = () => {
    if (!urlProblems.length) return;
    const bar = '!'.repeat(78);
    console.error('\n' + bar + '\n!! THIS BUILD IS NOT READY TO PUBLISH: siteUrl from ' + cfg.siteUrlFrom + ' is not usable\n' + urlProblems.map(p => '!! ' + p).join('\n') +
      '\n!! Canonical tags, sitemap.xml, robots.txt and share-image links point at that address.\n!! Fix it, then build with:  node build.js --production\n' + bar + '\n');
  };
  if (ARGS.includes('--production') && urlProblems.length) {
    console.error('\nBuild stopped: siteUrl (from ' + cfg.siteUrlFrom + ') cannot be published.\n' + urlProblems.map(p => '  - ' + p).join('\n') + '\n\nNothing was written. Fix siteUrl (in ' + cfg.siteUrlFrom + ') and run  node build.js --production  again.');
    process.exit(1);
  }
  warn();
  const base = String(cfg.siteUrl).replace(/\/+$/, '');
  const pages = JSON.parse(read('pages/pages.json'));
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  const urlOf = p => base + (p.slug ? '/' + p.slug + '/' : '/');
  const today = new Date().toISOString().slice(0, 10);

  /* start clean, keeping only the single-file build */
  for (const e of fs.existsSync(DIST) ? fs.readdirSync(DIST) : []) if (e !== 'scanline-json.html') fs.rmSync(path.join(DIST, e), { recursive: true, force: true });

  /* fonts, CSS and JS under assets/, with the content hash in each name so they can be cached for good */
  const fontMap = {};
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) {
    const data = read('fonts/' + f, null);
    const out = f.endsWith('.woff2') ? fingerprint(f, data) : f;
    write('assets/fonts/' + out, data);
    fontMap[f] = 'fonts/' + out;
  }
  const assets = {};
  for (const f of STYLES) {
    const body = read(f).replace(/url\("\.\.\/fonts\/([^"]+)"\)/g, (m, u) => 'url("' + fontMap[u] + '")');
    const css = '/* Fonts: IBM Plex Mono and VT323, SIL Open Font License 1.1, see fonts/OFL-*.txt */\n' + body;
    assets[f] = 'assets/' + fingerprint(path.basename(f), css);
    write(assets[f], css);
  }
  const js = SCRIPTS.map(f => '/* ' + f + ' */\n' + read(f)).join('\n;\n');
  const jsName = 'assets/' + fingerprint('app.js', js);
  write(jsName, js);
  const preload = ['IBMPlexMono-Regular-Latin1.woff2', 'vt323-latin-400-normal.woff2'].map(f => 'assets/' + fontMap[f]);

  /* the prompt text for a page's mode comes from the same code the page runs */
  const ctx = { JF: {} };
  vm.runInNewContext(read('js/modes.js'), ctx);
  const modes = ctx.JF.modes;

  /* icons and share images */
  write('favicon.ico', images.faviconIco());
  write('favicon.svg', images.faviconSvg());
  write('apple-touch-icon.png', images.iconPng(180));
  write('icon-192.png', images.iconPng(192));
  write('icon-512.png', images.iconPng(512));
  const ogName = p => 'og/' + (p.slug || 'home') + '.png';
  for (const p of pages) write(ogName(p), images.og(p.h1, cfg.name));

  const toolList = (rel, current) => '<ul>' + pages.map(p => '<li><a href="' + rel + (p.slug ? p.slug + '/' : '') + '"' +
    (p.slug === current ? ' aria-current="page"' : '') + '>' + esc(p.nav) + '</a></li>').join('') + '</ul>';
  const siteFooter = (rel, current) => '<footer class="site">\n  <nav aria-label="All tools">\n    <h2>all tools</h2>\n    ' + toolList(rel, current) +
    '\n  </nav>\n  <p>' + esc(cfg.name) + ' · runs in your browser, nothing is uploaded</p>\n</footer>\n';

  const report = [];
  for (const p of pages) {
    const rel = p.slug ? '../' : '', url = urlOf(p), img = base + '/' + ogName(p);
    const link = s => rel + (s ? s + '/' : '');
    for (const s of p.related) if (!bySlug.has(s)) throw new Error(p.slug + ': related page "' + s + '" does not exist');
    const sample = p.sample || {};
    const seed = { mode: p.mode };
    if (sample.a) { seed.a = read('pages/samples/' + sample.a); seed.name = sample.name || ''; }
    if (sample.b) seed.b = read('pages/samples/' + sample.b);
    if (sample.q) seed.q = sample.q;

    const app = { '@context': 'https://schema.org', '@type': 'WebApplication', name: cfg.name + ': ' + p.h1, url, description: p.metaDescription,
      applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', browserRequirements: 'Requires JavaScript and a current web browser.',
      isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, author: { '@type': 'Person', name: cfg.author } };
    const faq = { '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: p.faq.map(f => ({ '@type': 'Question', name: plainText(f.q), acceptedAnswer: { '@type': 'Answer', text: plainText(f.a) } })) };
    const crumbs = p.slug && { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: cfg.name, item: base + '/' }, { '@type': 'ListItem', position: 2, name: p.h1, item: url }] };

    const head = [
      '<meta name="description" content="' + esc(p.metaDescription) + '">',
      '<meta name="author" content="' + esc(cfg.author) + '">',
      ...(!p.slug && cfg.googleVerification ? ['<meta name="google-site-verification" content="' + esc(cfg.googleVerification) + '">'] : []),
      '<link rel="canonical" href="' + esc(url) + '">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="' + esc(cfg.name) + '">',
      '<meta property="og:title" content="' + esc(p.title) + '">',
      '<meta property="og:description" content="' + esc(p.metaDescription) + '">',
      '<meta property="og:url" content="' + esc(url) + '">',
      '<meta property="og:image" content="' + esc(img) + '">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="' + esc(p.h1 + ', ' + cfg.name) + '">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="' + esc(p.title) + '">',
      '<meta name="twitter:description" content="' + esc(p.metaDescription) + '">',
      '<meta name="twitter:image" content="' + esc(img) + '">',
      '<link rel="icon" href="' + rel + 'favicon.ico" sizes="32x32">',
      '<link rel="icon" href="' + rel + 'favicon.svg" type="image/svg+xml">',
      '<link rel="apple-touch-icon" href="' + rel + 'apple-touch-icon.png">',
      '<link rel="manifest" href="' + rel + 'site.webmanifest">',
      ...preload.map(f => '<link rel="preload" href="' + rel + f + '" as="font" type="font/woff2" crossorigin>'),
      ld(app), ld(faq), ...(crumbs ? [ld(crumbs)] : []),
    ].join('\n');

    const doc = '<section class="doc" aria-labelledby="doc-' + (p.slug || 'home') + '">\n' +
      '  <p class="intro">' + rich(p.intro) + '</p>\n' +
      p.sections.map((s, i) => '  <h2' + (i ? '' : ' id="doc-' + (p.slug || 'home') + '"') + '>' + esc(s.heading) + '</h2>\n' + s.paragraphs.map(x => '  <p>' + rich(x) + '</p>\n').join('')).join('') +
      '  <h2>Questions</h2>\n' + p.faq.map(f => '  <h3>' + rich(f.q) + '</h3>\n  <p>' + rich(f.a) + '</p>\n').join('') +
      '  <h2>Related tools</h2>\n  <ul class="related">' + p.related.map(s => { const r = bySlug.get(s); return '<li><a href="' + link(s) + '">' + esc(r.nav) + '</a>: ' + esc(r.h1) + '</li>'; }).join('') + '</ul>\n' +
      '</section>\n';

    let html = TEMPLATE;
    const rep = (re, to) => {
      if (typeof re === 'string' ? !html.includes(re) : !new RegExp(re.source).test(html)) throw new Error((p.slug || 'home') + ': template marker not found: ' + re);
      html = html.replace(re, to);
    };
    rep('<title>Scanline JSON</title>', '<title>' + esc(p.title) + '</title>');
    rep('<!--page:head-->', head);
    rep(/<link rel="stylesheet" href="(css\/[^"]+)"/g, (m, f) => '<link rel="stylesheet" href="' + rel + assets[f] + '"');
    rep(/<h1>[^<]*<\/h1>/, '<h1>' + esc(p.h1) + '</h1>');
    rep(/<span id="cmd">[^<]*<\/span>/, '<span id="cmd">' + esc(modes.prompt({ mode: p.mode, ind: '2', sort: false })) + '</span>');
    rep(/<button type="button" data-mode="(\w+)" aria-pressed="(true|false)"/g, (m, md) => '<button type="button" data-mode="' + md + '" aria-pressed="' + (md === p.mode) + '"');
    /* the convert menu: its items and its button show the page's mode before any script runs */
    rep(/<button type="button" role="menuitemradio" aria-checked="(?:true|false)" data-mode="(\w+)"/g, (m, md) => '<button type="button" role="menuitemradio" aria-checked="' + (md === p.mode) + '" data-mode="' + md + '"');
    const conv = ['yaml', 'csv', 'ts', 'schema'].includes(p.mode);
    rep(/(<button type="button" id="convert"[^>]*? aria-pressed=")false("[^>]*>)convert(<\/button>)/, (m, a, b, c) => conv ? a + 'true' + b + 'convert: ' + p.mode + c : m);
    rep('<main>', '<main class="with-doc">');
    rep('<!--page:doc-->', doc);
    rep('<!--page:site-->\n', siteFooter(rel, p.slug));
    rep('<!--page:data-->', '<script type="application/json" id="page">' + JSON.stringify(seed).replace(/</g, '\\u003c') + '</script>');
    rep(/(<script src="js\/[^"]+"><\/script>\n)+/, '<script defer src="' + rel + jsName + '"></script>\n');
    write((p.slug ? p.slug + '/' : '') + 'index.html', html);
    report.push({ path: p.slug ? '/' + p.slug + '/' : '/', title: p.title, description: p.metaDescription, words: words(doc), html: html.length });
  }

  /* 404: served at any depth, so its links start at the site root. Its few lines of script live in an asset file
     (shows the saved theme and the address that was not found) because the site's policy forbids inline scripts. */
  const NOT_FOUND_JS = "try{var s=JSON.parse(localStorage.getItem('scanline-json'));if(s&&/^(green|amber|ice)$/.test(s.theme))document.documentElement.dataset.theme=s.theme;if(s&&s.fx===false)document.documentElement.dataset.fx='off'}catch(e){}\n" +
    "addEventListener('DOMContentLoaded',function(){var w=document.getElementById('where');if(w)w.textContent=location.pathname});\n";
  const notFoundJs = 'assets/' + fingerprint('notfound.js', NOT_FOUND_JS);
  write(notFoundJs, NOT_FOUND_JS);
  write('404.html', `<!DOCTYPE html>
<html lang="en" data-theme="green">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#040906">
<meta name="robots" content="noindex">
<title>Page not found | ${esc(cfg.name)}</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/${assets['css/style.css']}">
<script defer src="/${notFoundJs}"></script>
</head>
<body>
<main class="nf">
<div class="lede">
  <h1>page not found</h1>
  <p>runs in your browser, nothing is uploaded</p>
</div>
<pre><span class="ps">guest@json:~$</span> cd <span id="where">this-page</span>
cd: no such page</pre>
<p>The address may be mistyped, or the page has moved. Every tool is listed below.</p>
${siteFooter('/', null).replace('<footer class="site">', '<div class="site">').replace('</footer>', '</div>')}</main>
</body>
</html>
`);

  write('site.webmanifest', JSON.stringify({ name: cfg.name, short_name: 'Scanline', description: bySlug.get('').metaDescription, start_url: '/', scope: '/',
    display: 'standalone', background_color: '#040906', theme_color: '#040906',
    icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 2) + '\n');
  write('robots.txt', 'User-agent: *\nAllow: /\n\nSitemap: ' + base + '/sitemap.xml\n');
  write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.map(p => '  <url><loc>' + esc(urlOf(p)) + '</loc><lastmod>' + (p.updated || today) + '</lastmod></url>\n').join('') + '</urlset>\n');
  /* Cloudflare Pages reads these two files (Netlify reads the same format); other hosts need the same rules in
     their own settings. Written by tools/hostrules.js, which tools/serve.js and tests/host.test.js read back. */
  write('_headers', host.headersFile(pages.map(p => p.slug)));
  write('_redirects', host.redirectsFile(pages.map(p => p.slug)));

  /* what was built, and what the home page costs on the wire (gzip for text, woff2 is already compressed) */
  const gz = f => zlib.gzipSync(fs.readFileSync(path.join(DIST, f)), { level: 9 }).length;
  const raw = f => fs.statSync(path.join(DIST, f)).size;
  const first = [['index.html', gz], [assets['css/style.css'], gz], [jsName, gz], [preload[0], raw], [preload[1], raw], ['favicon.ico', raw]];
  const lazy = [[assets['css/fonts-lazy.css'], gz], ...['IBMPlexMono-Medium-Latin1.woff2', 'IBMPlexMono-SemiBold-Latin1.woff2', 'IBMPlexMono-Regular-Pi.woff2'].map(f => ['assets/' + fontMap[f], raw])];
  const sum = list => list.reduce((s, [f, m]) => s + m(f), 0);
  console.log('dist/: ' + pages.length + ' pages, 404, sitemap, robots, manifest, icons, ' + pages.length + ' share images');
  for (const r of report) console.log('  ' + r.path.padEnd(24) + String(r.words).padStart(4) + ' words  ' + kb(r.html));
  console.log('home page, first paint: ' + kb(sum(first)) + ' (' + first.map(([f, m]) => path.basename(f) + ' ' + kb(m(f))).join(', ') + ')');
  console.log('home page, with lazy fonts: ' + kb(sum(first) + sum(lazy)) + ' (+ ' + lazy.map(([f, m]) => path.basename(f) + ' ' + kb(m(f))).join(', ') + ')');
  warn();                                             /* again at the end, so it is the last thing on screen */
  return report;
}

if (ARGS.includes('--single')) single();
else site();
