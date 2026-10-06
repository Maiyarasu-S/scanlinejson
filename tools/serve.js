/* serve.js: a small static file server for trying the built site, using only Node.
     node tools/serve.js              serves dist/ at http://127.0.0.1:8080/
     node tools/serve.js 9000         another port
     node tools/serve.js --lan        also reachable from other devices on your network, such as a phone
     node tools/serve.js --no-rules   ignore dist/_headers and dist/_redirects
   It behaves like the real host: it applies the rules in dist/_headers (security headers, caching) and
   dist/_redirects, folders serve their index.html, text is gzipped, a missing page gets 404.html with a 404
   status, and paths are case sensitive (a Windows or Mac file system is not, which would hide mistakes).
   Over --lan the address is plain http, so the browser treats it as a less trusted context than https
   (for example, copying to the clipboard may fall back to an older method).
   tests/host.test.js uses createHandler() below, so the tests exercise the same code. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');
const rules = require('./hostrules');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };

/* does this file exist with exactly this capitalisation, all the way down from root? */
function existsExact(root, rel) {
  let dir = root;
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return false; }
    if (!names.includes(parts[i])) return false;
    dir = path.join(dir, parts[i]);
  }
  return fs.statSync(dir).isFile();
}

function createHandler(root, { useRules = true } = {}) {
  const read = f => (useRules && fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
  const headerRules = rules.parseHeaders(read('_headers')), redirectRules = rules.parseRedirects(read('_redirects'));
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { p = '/404'; }
    const redirect = rules.redirectFor(redirectRules, p);
    if (redirect) { res.writeHead(redirect.status, { Location: redirect.to + url.search, 'Cache-Control': 'no-store' }); res.end(); return; }
    let rel = p.endsWith('/') ? p + 'index.html' : p, status = 200;
    if (rel.includes('//') || !existsExact(root, rel)) { rel = '/404.html'; status = 404; }   /* strict: no duplicate spellings of an address */
    const f = path.join(root, rel), type = TYPES[path.extname(f)] || 'application/octet-stream', body = fs.readFileSync(f);
    const head = Object.assign({ 'Content-Type': type }, rules.headersFor(headerRules, p).headers);
    if (!Object.keys(head).some(h => h.toLowerCase() === 'cache-control')) head['Cache-Control'] = 'no-store';
    if (/^(text|application\/(json|xml|manifest)|image\/svg)/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      head['Content-Encoding'] = 'gzip'; res.writeHead(status, head); res.end(zlib.gzipSync(body));
    } else { res.writeHead(status, head); res.end(body); }
  };
}

/* resolves with the listening server */
function start(root, port, host, opts) {
  return new Promise((ok, no) => { const s = http.createServer(createHandler(root, opts)); s.once('error', no); s.listen(port, host, () => ok(s)); });
}

module.exports = { createHandler, start, existsExact };

if (require.main === module) {
  const args = process.argv.slice(2), lan = args.includes('--lan');
  const port = +(args.find(a => /^\d+$/.test(a)) || 8080), root = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('dist/ has no site yet. Run  node build.js  first.'); process.exit(1); }
  start(root, port, lan ? '0.0.0.0' : '127.0.0.1', { useRules: !args.includes('--no-rules') }).then(() => {
    console.log('serving dist/ at http://127.0.0.1:' + port + '/   (Ctrl+C to stop)' + (args.includes('--no-rules') ? '   [_headers and _redirects ignored]' : ''));
    if (lan) for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log('on your network:   http://' + a.address + ':' + port + '/');
  }, e => { console.error(e.code === 'EADDRINUSE' ? 'port ' + port + ' is already in use. Pick another: node tools/serve.js 9000' : e.message); process.exit(1); });
}
