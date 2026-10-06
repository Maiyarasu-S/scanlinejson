/* config.js: reads site.config.json. The SITE_URL environment variable, when set, replaces siteUrl, so a host
   or a CI job can supply the real address without editing a file. `siteUrlFrom` says where the value came from,
   for error messages. */
'use strict';
const fs = require('fs'), path = require('path');
const DEFAULT = path.join(__dirname, '..', 'site.config.json');

function load(file) {
  const cfg = JSON.parse(fs.readFileSync(file || DEFAULT, 'utf8'));
  cfg.siteUrlFrom = 'site.config.json';
  if (process.env.SITE_URL) { cfg.siteUrl = process.env.SITE_URL; cfg.siteUrlFrom = 'the SITE_URL environment variable'; }
  return cfg;
}

module.exports = { load };
