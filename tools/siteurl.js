/* siteurl.js: is the siteUrl in site.config.json safe to publish?
   Every canonical tag, sitemap entry, robots.txt line and share-image link is built from it, so a placeholder
   would point search engines and link previews at the wrong site. */
'use strict';
const PLACEHOLDER = /(^|\.)(example\.(com|org|net)|localhost)$|\.(invalid|test|example)$/i;

/* Returns a list of plain-English problems; an empty list means the address is fine to publish. */
function check(raw, where = 'site.config.json') {
  if (typeof raw !== 'string' || !raw.trim()) return ['siteUrl is missing from ' + where + '. Set it to your real address, for example "https://tools.yourname.dev".'];
  let u;
  try { u = new URL(raw); } catch (e) { return ['siteUrl "' + raw + '" is not a valid address. It should look like "https://tools.yourname.dev".']; }
  const problems = [];
  if (PLACEHOLDER.test(u.hostname)) problems.push('siteUrl "' + raw + '" is still a placeholder. Set it to your real domain in ' + where + '.');
  if (u.protocol !== 'https:') problems.push('siteUrl must start with https:// (found "' + raw + '"). Canonical tags and the sitemap should use the secure address.');
  if (raw.endsWith('/')) problems.push('siteUrl must not end with a slash (found "' + raw + '"). Use "' + raw.replace(/\/+$/, '') + '".');
  if (u.pathname.replace(/\/+$/, '') || u.search || u.hash) problems.push('siteUrl must be just the domain, without a path or query (found "' + raw + '"). The site is built to live at the root of a domain.');
  return problems;
}

module.exports = { check };
