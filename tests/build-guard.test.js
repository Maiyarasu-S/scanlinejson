/* The placeholder-domain guard.   Run:  node tests/build-guard.test.js
   Unit tests for the siteUrl rules, then real runs of build.js against throwaway configs and output folders:
   --production must refuse a bad address before writing anything, a plain build must only warn loudly, and a
   good address must build with that address in every canonical tag and in the sitemap. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const siteUrl = require('../tools/siteurl');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n   ' + JSON.stringify(extra) : '')); } };

/* ---------- the rules ---------- */
const probs = u => siteUrl.check(u).map(p => /placeholder/.test(p) ? 'placeholder' : /https:\/\//.test(p) && /must start/.test(p) ? 'not-https' : /end with a slash/.test(p) ? 'slash'
  : /without a path/.test(p) ? 'path' : /missing/.test(p) ? 'missing' : /not a valid/.test(p) ? 'invalid' : p);
const cases = [
  ['https://example.com', ['placeholder']],
  ['https://example.com/', ['placeholder', 'slash']],
  ['http://example.com', ['placeholder', 'not-https']],
  ['https://www.example.org', ['placeholder']],
  ['https://tools.example.net', ['placeholder']],
  ['https://site.test', ['placeholder']],
  ['https://localhost', ['placeholder']],
  ['https://scanline.dev', []],
  ['https://tools.scanline.dev', []],
  ['https://notexample.com', []],
  ['http://scanline.dev', ['not-https']],
  ['https://scanline.dev/', ['slash']],
  ['https://scanline.dev//', ['slash']],
  ['https://scanline.dev/tools', ['path']],
  ['https://scanline.dev/tools/', ['slash', 'path']],
  ['https://scanline.dev?x=1', ['path']],
  ['scanline.dev', ['invalid']],
  ['', ['missing']],
  [undefined, ['missing']],
];
for (const [u, want] of cases) ok(JSON.stringify(probs(u)) === JSON.stringify(want), 'siteUrl ' + JSON.stringify(u) + ' -> ' + (want.join(', ') || 'fine'), probs(u));
ok(siteUrl.check('https://example.com').every(p => p.length > 30 && /site\.config\.json/.test(p) || /siteUrl/.test(p)), 'each message names siteUrl and says what to do');

/* ---------- real runs ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const config = (name, url) => { const f = path.join(tmp, name + '.json'); fs.writeFileSync(f, JSON.stringify({ siteUrl: url, name: 'Scanline JSON', author: 'Maiyarasu S' })); return f; };
/* SITE_URL is cleared for every run, so one exported in your shell cannot change a result; buildWithEnv sets it on purpose */
const buildWithEnv = (name, url, env, ...flags) => {
  const out = path.join(tmp, name + '-out'), r = spawnSync(process.execPath, [path.join(ROOT, 'build.js'), '--config=' + config(name, url), '--out=' + out, ...flags],
    { encoding: 'utf8', env: Object.assign({}, process.env, { SITE_URL: env || '' }) });
  return { code: r.status, out: r.stdout, err: r.stderr, dir: out, wrote: fs.existsSync(out) && fs.readdirSync(out).length > 0 };
};
const build = (name, url, ...flags) => buildWithEnv(name, url, '', ...flags);

/* the SITE_URL environment variable replaces the file's siteUrl, which is how a host or CI job supplies the real address */
{
  const good = buildWithEnv('env-good', 'https://example.com', 'https://env.scanline-tools.dev', '--production');
  ok(good.code === 0 && good.err === '', 'SITE_URL replaces a placeholder in the file: --production builds, no warning', { code: good.code, err: good.err.slice(0, 100) });
  ok(fs.readFileSync(path.join(good.dir, 'sitemap.xml'), 'utf8').includes('https://env.scanline-tools.dev/json-diff/') && !/example\.com/.test(fs.readFileSync(path.join(good.dir, 'index.html'), 'utf8')),
    'and every address in the build comes from SITE_URL');
  const bad = buildWithEnv('env-bad', 'https://scanline.dev', 'https://example.com', '--production');
  ok(bad.code === 1 && !bad.wrote && /SITE_URL environment variable/.test(bad.err), 'a placeholder in SITE_URL is refused even when the file is fine, and the message names SITE_URL', bad.err.slice(0, 160));
  const slash = buildWithEnv('env-slash', 'https://scanline.dev', 'https://env.scanline-tools.dev/', '--production');
  ok(slash.code === 1 && /slash/.test(slash.err), 'the same rules apply to SITE_URL (trailing slash)');
  const warnOnly = buildWithEnv('env-warn', 'https://scanline.dev', 'https://example.com');
  ok(warnOnly.code === 0 && /SITE_URL environment variable/.test(warnOnly.err), 'a plain build with a placeholder SITE_URL warns and names SITE_URL');
}

for (const [url, why] of [['https://example.com', 'the placeholder'], ['https://scanline.dev/', 'a trailing slash'], ['http://scanline.dev', 'plain http']]) {
  const r = build('prod-bad', url, '--production');
  ok(r.code === 1, '--production fails for ' + why, r.code);
  ok(/Build stopped/.test(r.err) && r.err.includes(url) && /site\.config\.json/.test(r.err), '--production explains what to fix for ' + why, r.err.slice(0, 200));
  ok(!r.wrote, '--production writes nothing for ' + why, r.wrote);
}
{
  const r = build('warn', 'https://example.com');
  const bars = (r.err.match(/!{20,}/g) || []).length, notices = (r.err.match(/NOT READY TO PUBLISH/g) || []).length;
  ok(r.code === 0 && r.wrote, 'a plain build with the placeholder still builds', r.code);
  ok(notices === 2 && bars === 4, 'and warns loudly, at the start and again at the end', { notices, bars });
  ok(/placeholder/.test(r.err) && /--production/.test(r.err), 'the warning says what is wrong and how to make it an error');
  ok(/example\.com/.test(fs.readFileSync(path.join(r.dir, 'sitemap.xml'), 'utf8')), 'the warned build really does carry the placeholder (so the warning is truthful)');
}
{
  const r = build('good', 'https://json.scanline-tools.dev', '--production');
  ok(r.code === 0 && r.wrote && r.err === '', '--production builds a good address with no warning', { code: r.code, err: r.err.slice(0, 120) });
  const map = fs.readFileSync(path.join(r.dir, 'sitemap.xml'), 'utf8'), home = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8'), robots = fs.readFileSync(path.join(r.dir, 'robots.txt'), 'utf8');
  ok(!/example\.com/.test(map + home + robots), 'nothing points at the placeholder');
  ok(map.includes('<loc>https://json.scanline-tools.dev/</loc>') && map.includes('<loc>https://json.scanline-tools.dev/json-diff/</loc>'), 'sitemap uses the configured address');
  ok(home.includes('<link rel="canonical" href="https://json.scanline-tools.dev/">') && home.includes('content="https://json.scanline-tools.dev/og/home.png"'), 'canonical and share image use the configured address');
  ok(robots.includes('Sitemap: https://json.scanline-tools.dev/sitemap.xml'), 'robots.txt points at the configured sitemap');
}
{
  const r = build('single', 'https://example.com', '--single', '--production');
  ok(r.code === 0 && fs.existsSync(path.join(r.dir, 'scanline-json.html')) && !fs.existsSync(path.join(r.dir, 'index.html')), '--single is not held back by siteUrl, and writes only the one file');
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
