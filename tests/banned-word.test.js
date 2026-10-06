/* Fails if the retired product word appears anywhere in the project: in a file or folder name, in the project
   folder's own name, or in the contents of any file (text or binary, case-insensitive), dist/ included.
   Run:  node tests/banned-word.test.js            the whole project, source and dist/
         node tests/banned-word.test.js dist       just one folder
   The git history is not searched here (.git is skipped): rewriting history is a decision for a person.
   The word is written in two halves so that this file does not contain it and flag itself. */
'use strict';
const fs = require('fs'), path = require('path');
const WORD = 'hack' + 'er';
const ROOT = path.join(__dirname, '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
const SKIP = new Set(['.git', 'node_modules']);
if (!fs.existsSync(target)) { console.log('no such folder: ' + target); process.exit(1); }

const hits = [];
let files = 0, folders = 0;
const lineOf = (text, at) => { let n = 1; for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++; return n; };
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = path.join(dir, e.name), rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (e.name.toLowerCase().includes(WORD)) hits.push(rel + '  (name)');
    if (e.isDirectory()) { folders++; walk(f); continue; }
    files++;
    /* latin1 keeps every byte as one character, so binary files (fonts, images) are searched too */
    const text = fs.readFileSync(f).toString('latin1'), low = text.toLowerCase();
    for (let at = low.indexOf(WORD), n = 0; at !== -1 && n < 5; at = low.indexOf(WORD, at + 1), n++)
      hits.push(rel + ':' + lineOf(text, at) + '  ' + text.slice(Math.max(0, at - 30), at + WORD.length + 30).replace(/\s+/g, ' ').trim());
    /* The word can hide inside base64 (the JWT samples are base64), where a plain search cannot see it.
       Decode every long base64 or base64url run in text files and search what comes out. */
    if (!/\.(woff2?|png|ico|jpe?g|gif|webp)$/i.test(e.name)) {
      for (const m of text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
        const run = m[0].replace(/-/g, '+').replace(/_/g, '/');
        /* the encoded part may start a few characters into the run, so try each of the four alignments */
        for (let k = 0; k < 4; k++) {
          if (Buffer.from(run.slice(k), 'base64').toString('latin1').toLowerCase().includes(WORD)) {
            hits.push(rel + ':' + lineOf(text, m.index) + '  inside base64: ' + m[0].slice(0, 40) + '...');
            break;
          }
        }
      }
    }
  }
})(target);

/* the project folder's own name counts too, when the whole project is checked */
const folderName = path.basename(path.resolve(ROOT));
if (target === ROOT && folderName.toLowerCase().includes(WORD)) hits.push('the project folder is named "' + folderName + '"  (rename the folder)');

console.log('searched ' + files.toLocaleString('en') + ' files in ' + folders + ' folders under ' + (path.relative(ROOT, target) || '.') + ' for names and contents');
if (hits.length) { console.log('FAIL the retired word appears ' + hits.length + ' time(s):'); for (const h of hits) console.log('   ' + h); process.exit(1); }
console.log('0 matches');
