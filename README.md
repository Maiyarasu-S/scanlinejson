<div align="center">

  ```
  ┌──────────────────────────────────────────────┐
  │ guest@json:~$ cat mess.json | scanline       │
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ {                                            │
  │   "status": "fixed",                         │
  │   "uploaded": false,                         │
  │   "dependencies": 0                          │
  │ }                                            │
  └──────────────────────────────────────────────┘
  ```

# Scanline JSON

**Paste the mess. Get the meaning.**
A JSON formatter, repair tool and explorer that lives in a glowing green terminal, and never phones home.

*Made by Maiyarasu S*

</div>

---

## What does it do?

You hand it JSON, even broken JSON. It hands you back something you can actually read.

- **Foldable tree.** Click through nested data instead of squinting at one giant line.
- **Error detective.** Broken input gets the exact line and column of the first problem, plus a list of repairs you can apply.
- **Query line.** Ask questions with JSONPath or a small jq-style filter.
- **Shape-shifter.** Turn it into YAML, CSV, TypeScript interfaces or a JSON Schema.
- **Spot the difference.** Compare tab a against tab b, or check a against a schema in tab b.
- **JWT peeker.** Paste a bare token and it decodes the contents. It never verifies the signature, so don't trust what it shows.
- **Three moods.** Green phosphor, amber, or ice. The `crt` button turns scanlines and glow off if they get too dramatic.

## The part you'll like

| Promise | How it's kept |
| --- | --- |
| Nothing is uploaded | No page ever requests another site. The fonts ship with it, and the security policy blocks the rest |
| No dependencies | No `node_modules`, no install step, no supply chain to worry about |
| No server | Works from a double-click, straight off your disk |
| Shareable | A share link carries the compressed input inside the link itself (so anyone with the link can read it) |

## Try it in 10 seconds

Double-click `index.html`. That's the whole install.

Want the full multi-page site on your machine?

    node build.js
    node tools/serve.js            then open http://127.0.0.1:8080/

You need [Node](https://nodejs.org) for that, and for the tests. It was built on the version in `.node-version` (24.19.0).

## Eleven tools, eleven doors

One tool, many front doors. Each page opens the tool in the right mode and has its own title, description, share image and written guide, so people (and search engines) can find it by what they actually need:

`/` · `/json-to-yaml/` · `/json-to-csv/` · `/json-to-typescript/` · `/json-schema-generator/` · `/fix-invalid-json/` · `/json-diff/` · `/json-validator/` · `/json-path-query/` · `/json-minify/` · `/decode-jwt/`

## Commands

| Command | What it does |
| --- | --- |
| `node build.js` | Builds the site into `dist/`. With the placeholder address it still builds, and shouts about it twice |
| `node build.js --production` | Same, but refuses to build unless the site address is a real `https` one. Use this for releases |
| `node build.js --single` | One file with everything inlined, for emailing or opening from disk |
| `node tools/serve.js` | Serves `dist/` locally with the real `_headers` and `_redirects` applied (`--lan` opens it to your phone) |
| `node tests/logic.test.js` | Parser, repair, query, converters, diff, schema validation, hints, search, modes |
| `node tests/build-guard.test.js` | The site address guard |
| `node tests/seo.test.js` | Built pages: titles, descriptions, canonical tags, headings, structured data, links, sitemap |
| `node tests/host.test.js` | The host files, no inline scripts, every page requested from the test server |
| `node tests/banned-word.test.js` | Fails if the product's retired old name shows up anywhere in the project |

`npm run build`, `build:production`, `build:single`, `serve` and `npm test` do the same thing. Still zero dependencies.

The site address comes from `siteUrl` in `site.config.json`, or from the `SITE_URL` environment variable, which wins when set. Before publishing it must be real: `https`, just the domain, no trailing slash, no path.

## A tour of the code

The rule of the house: only one file touches the page. Everything else is plain logic that attaches to a single global, `JF`, so it can be tested without a browser.

| Path | What lives there |
| --- | --- |
| `index.html` | The tool, the help dialog, and the template every built page is cut from (see the `<!--page:...-->` markers) |
| `css/` | The three themes and the layout; heavier font weights load lazily |
| `js/core.js` | Parser (strict, plus a lax mode behind auto-fix) and serialiser. Self-contained, so it can run in a Web Worker |
| `js/query.js` | The prompt-line query language: JSONPath and a small jq subset |
| `js/convert.js` | YAML, CSV, TypeScript interfaces, generated JSON Schema |
| `js/diff.js`, `js/schema.js` | Structural diff and JSON Schema validation |
| `js/hints.js` | Spots Unix times, links, JWTs, base64 and JSON hiding inside strings |
| `js/find.js`, `js/modes.js` | The search box; output modes and which state the page starts in |
| `js/app.js` | The only file that touches the DOM |
| `fonts/` | IBM Plex Mono and VT323 as `woff2`, with their licences |
| `pages/`, `site.config.json` | One entry per tool page, sample inputs, and the site name and address |
| `build.js`, `tools/` | The site builder; the host-file rules, the local server, and a PNG and icon maker written from scratch (even the pixel font) |
| `tests/` | Everything listed above |
| `.github/workflows/ci.yml` | Runs the tests and a production build on every push. It never deploys |
| `DEPLOY.md`, `LAUNCH-CHECKLIST.md` | Click-by-click deployment to Cloudflare Pages, and what to check by hand |

## What a build produces

`node build.js` writes `dist/`, a multi-page site for the root of a domain: one real page per tool, one fingerprinted stylesheet and script, fonts, 1200 × 630 share images, icons, `site.webmanifest`, `robots.txt`, `sitemap.xml`, `404.html`, and two files for the host:

- `_headers`: a Content-Security-Policy that allows no outside host (the one exception is `blob:` for the worker that parses big input), plus `nosniff`, a referrer policy, a permissions policy, and caching: a year for `/assets/*`, always revalidated for pages.
- `_redirects`: one address per page, lowercase with a trailing slash, reached in a single step.

`dist/` is not committed. The host builds it from source.

## Memory and privacy

What you paste is saved in your browser so it's waiting next visit: settings in `localStorage`, the text of tabs a and b in IndexedDB (with a `localStorage` fallback, and a message if neither has room). It never leaves your machine. **Clear saved data** in the help dialog wipes it. An untouched sample is never saved, so each tool page shows its own sample until you edit something.

Where the page starts: a share link wins, then the page's own mode, then your saved mode. Saved input beats the page's sample.

## Accessibility

The tree is an ARIA `tree` of `treeitem` rows with level, position and expanded state. The `crt` button turns scanlines and glow off, and `prefers-contrast: more` does the same while brightening text and borders. It has been checked in a browser but not yet with a real screen reader. `LAUNCH-CHECKLIST.md` has the steps.

## Browsers

Automated checks run in Edge. Firefox, Safari and iPhone Safari are covered by a manual checklist in `LAUNCH-CHECKLIST.md`. Share links use `CompressionStream` where the browser has it and fall back to a longer uncompressed link where it doesn't.

## Credits

Made by **Maiyarasu S**. IBM Plex Mono (IBM) and VT323 (The VT323 Project Authors) are used under the SIL Open Font License 1.1; the licence texts are in `fonts/`. The pixel font in `tools/pixelfont.js` is original work.

<div align="center">

`guest@json:~$ exit`

</div>
