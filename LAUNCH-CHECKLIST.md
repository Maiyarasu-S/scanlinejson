# Launch checklist

Do these in order. Everything here is done by hand, by you, because it needs your domain, your accounts or a real
device. `DEPLOY.md` covers creating the repository and the Cloudflare Pages project. Nothing below promises any
ranking, traffic or search result: indexing is up to the search engines, and none of these steps can guarantee it.

## 1. Set the real address and run the production build

`siteUrl` in `site.config.json` is the placeholder `https://example.com`. Every canonical URL, the sitemap,
`robots.txt` and the share-image links are built from it, so a build with the placeholder points search engines
and link previews at the wrong site.

- [ ] Choose the real address: `https://`, just the domain, no trailing slash, no path.
- [ ] Give it to the build. On Cloudflare Pages, set the `SITE_URL` environment variable (see `DEPLOY.md`, step 9).
      For a local release build, either `SITE_URL=https://your-domain node build.js --production`
      (PowerShell: `$env:SITE_URL="https://your-domain"; node build.js --production`) or edit `siteUrl` in the file.
- [ ] Build with `node build.js --production`. It stops with an error, and writes nothing, if the address is the
      placeholder, is not `https`, ends in a slash or has a path. A plain `node build.js` only warns, so always use
      `--production` for a release.
- [ ] With the same address set, run `node tests/seo.test.js`, `node tests/host.test.js` and
      `node tests/banned-word.test.js`. All must pass.
- [ ] Open a built page's source (`dist/index.html`) and check the canonical tag shows your domain.

## 2. Check each live page

For each of the 11 pages: the canonical address is the page's own address, the title and description are the ones
in `pages/pages.json`, the share image loads, and the page is in the sitemap.

- [ ] Run this for every page (bash; replace `YOUR-DOMAIN`). It should print, per page, the title, the description,
      the canonical address (your domain, with a trailing slash) and the share image address:

      for p in "" json-to-yaml json-to-csv json-to-typescript json-schema-generator fix-invalid-json json-diff json-validator json-path-query json-minify decode-jwt; do
        echo "== /$p"
        curl -s "https://YOUR-DOMAIN/$p${p:+/}" | grep -oE '<title>[^<]*|name="description" content="[^"]*|rel="canonical" href="[^"]*|property="og:image" content="[^"]*'
      done

- [ ] Open each share image address in a browser: a green terminal card, readable at a small size.
- [ ] `https://YOUR-DOMAIN/sitemap.xml` lists all 11 pages, each with your domain and a `lastmod` date.
      `https://YOUR-DOMAIN/robots.txt` allows everything and names that sitemap.
- [ ] Open each page in a browser with the developer console open: no red errors and no "Refused to ..." messages
      from the Content-Security-Policy. Try the tool, a large file, share, and the help dialog on the home page.
- [ ] Response headers on a page and on a file in `/assets/`:

      curl -sI https://YOUR-DOMAIN/ | grep -iE "^(content-security-policy|x-content-type-options|referrer-policy|permissions-policy|cache-control)"

      (PowerShell: `curl.exe -sI https://YOUR-DOMAIN/ | Select-String -Pattern "content-security|nosniff|referrer|permissions|cache-control"`.)
      The page must show the policy, `nosniff`, the referrer policy, the permissions policy and
      `Cache-Control: public, max-age=0, must-revalidate`. An `/assets/` file must show
      `public, max-age=31536000, immutable`. Cloudflare's documentation does not say whether a custom
      `Cache-Control` replaces its default, so confirm here that you see exactly one value and not two joined by a comma.
- [ ] Odd spellings must end at the one canonical address, in a single step, or be a 404. Never a second copy:
      `/json-diff` goes to `/json-diff/`; `/json-diff/index.html` goes to `/json-diff/`; `/index.html` goes to `/`;
      `/JSON-DIFF/` and `/json-diff//` are the styled "page not found" page. (Whether the host treats capital letters
      as different is not documented, so this is the one to look at.)
- [ ] `http://YOUR-DOMAIN/` ends up on `https`. A made-up address shows the "page not found" page with a 404 status.
- [ ] The `pages.dev` address Cloudflare gives the project shows a canonical tag that points at your real domain.

## 3. Search Console and Bing Webmaster Tools

- [ ] Google Search Console: add the domain as a **Domain property** and verify it with the DNS record it gives you
      (Cloudflare DNS is the easiest place to add it).
- [ ] In Search Console, open **Sitemaps** and submit `sitemap.xml`. Check it reads as "Success" with 11 pages found.
- [ ] Open **URL inspection**, paste the home page address, and choose **Request indexing**. Google may take days or
      longer, and does not promise to index a page it has been asked about.
- [ ] Bing Webmaster Tools: add the site (there is an option to import it from Search Console), verify it, and
      submit `sitemap.xml` there too.

## 4. Lighthouse and the Rich Results Test

- [ ] Lighthouse (in Chrome or Edge developer tools): run it on the live home page and two inner pages, once for
      mobile and once for desktop. Look at what it flags rather than at a score, and write down anything about
      accessibility, contrast or layout shift.
- [ ] Rich Results Test (search.google.com/test/rich-results): test the home page and two inner pages. It should find
      the structured data (the web application, the questions, and the breadcrumb on inner pages) and report no
      errors. Valid data does not mean Google will show anything special for it: it shows rich results for
      few of these types, and the page deliberately has no ratings or reviews.

## 5. Firefox and Safari, including iPhone

Every automated check so far ran in Edge only, and the project has no test dependency, so these are done by hand.
Test in Firefox on desktop, Safari on a Mac, and Safari on a real iPhone (a narrow desktop window is not the
same thing). Best of all is the deployed site over `https`. To try it before that, run `node tools/serve.js`
for this computer, or `node tools/serve.js --lan` and open the printed address on the phone. Over plain `http`
on a network address the browser is stricter about some features, so copying to the clipboard may behave
differently there than on the real site.

Write down the browser, its version and what you saw for anything that fails.

**Content-Security-Policy** (the policy was tested in Edge only)
- [ ] With the console open on the deployed site, nothing says "Refused to ..." or "Content Security Policy" on any
      of the 11 pages, while you use the tool.
- [ ] A file over 1 MB still parses without freezing the page (the worker is built from a `blob:` address, which
      the policy allows only for workers), and its status line says "off-thread".
- [ ] The help dialog opens, and its close button closes it (it is a form, and the policy forbids form submission).
- [ ] The icon appears in the browser tab, and "save" downloads a file.

**IndexedDB persistence**
- [ ] Paste something over 1 MB. In the browser console, `copy(JSON.stringify(Array.from({length: 40000}, (_, i) => ({id: i, name: "user" + i}))))`
      puts such a document on the clipboard. Wait a second, then reload: it is still in stdin and still parses.
- [ ] Close the tab and open the site again: still there. Change the theme and press `crt`: both are remembered.
- [ ] Help dialog (`?`), "clear saved data", click twice: both tabs empty, and a reload shows the sample again.
- [ ] A private window must not break the page: either it keeps input for the session or it shows a note.
- [ ] Safari only: it can delete a site's stored data after a week without a visit. That is expected; the page
      must then simply start from the sample, with no error.

**Share links (CompressionStream)**
- [ ] Press `share`, then open the copied link in a new tab: same input, query and mode.
- [ ] Open a link made in Edge in Firefox and Safari, and one made in Firefox or Safari in Edge.
- [ ] On Safari older than 16.4 there is no CompressionStream, so the link is a longer `#j=` link. It must still
      open everywhere.
- [ ] An old-style link opens: add `#j=eyJhIjoie1wiaGVsbG9cIjogWzEsIDIsIDNdfSIsIm0iOiJ5YW1sIn0` to the home
      address. It should show yaml for `{"hello": [1, 2, 3]}`.

**Lazy fonts**
- [ ] In the network panel, only Plex Mono Regular (Latin1) and VT323 are requested before the page is drawn.
      Medium, SemiBold and the Pi file arrive afterwards.
- [ ] With the network throttled to a slow connection, text shows at once and nothing jumps when the other
      weights arrive (bold labels and the `→` next to timestamps).

**Layout at phone size** (iPhone, portrait and landscape)
- [ ] First screen: the whole tool is visible (prompt, both panes, status line and the "Made by Maiyarasu S" badge) and
      the first lines of the written text peek out below it.
- [ ] Scrolling from the peek area scrolls the page. Scrolling inside stdin or stdout until it ends does not
      carry on into the page (`overscroll-behavior`, Safari 16 and later).
- [ ] Tapping into stdin or the search box does not zoom the page.
- [ ] No sideways page scroll after rotating. In landscape on an iPhone with a notch, nothing sits under the notch
      (the page asks for full-screen layout but has no safe-area padding, so this one may fail).
- [ ] Every button can be tapped. The button rows scroll sideways with no hint yet (Phase 2.2).

**Keyboard shortcuts** (desktop Firefox and Safari; an iPhone needs a keyboard attached)
- [ ] `Ctrl+Enter` (`Cmd+Enter` on a Mac) formats stdin. `Ctrl/Cmd+F` focuses the search box, and a second press
      opens the browser's own find. `Ctrl/Cmd+S` saves the output, not the page.
- [ ] `Alt+Q`, `Alt+C`, `Alt+M`, `Alt+S`, `Alt+F`, `Alt+T`, `Alt+1`, `Alt+2` (`Option` on a Mac) all work. With focus in
      stdin, `Option+1` must not type a symbol, and in Firefox on Windows no browser menu may open.
- [ ] `/` focuses search and `?` opens help when focus is not in a box. `Tab` and `Shift+Tab` indent in stdin, and
      `Esc` then `Tab` leaves it. The arrow keys move through the tree. `Ctrl/Cmd+Z` undoes a format.

## 6. Screen reader test of the JSON tree

The tree has been checked in a browser for its roles and keyboard behaviour, but not yet with a real screen
reader. Test it with one of these:

- NVDA on Windows, with Firefox or Chrome
- VoiceOver on macOS, with Safari (turn it on with Cmd+F5)

Steps, on the home page:

1. Press **clear** in stdin, then **sample**, so the tree shows the sample document.
2. Press Tab until focus reaches the tree. You should hear something like "JSON tree. Arrow keys move, left and
   right fold, tree", then the root row (the opening brace) as **expanded, level 1, 1 of 1**. If NVDA stays in
   browse mode, press NVDA+Space to switch to focus mode.
3. Press **Down arrow**. You should hear the first row, `"host": "node-07.lab.internal"`, with its level and
   position: **level 2, 1 of 15**.
4. Keep pressing **Down arrow** to the `"ports"` row. You should hear that it is **expanded**, at
   **level 2, 5 of 15**.
5. Press **Left arrow**. You should hear **collapsed**. Press **Right arrow**: **expanded**.
6. Press **Down arrow** once to move into the list. You should hear `22`, **level 3, 1 of 4**.
7. Press **Left arrow** to go back up to `"ports"`. Then press **Home** to reach the root row, **Shift+Left arrow**
   to fold everything and **Shift+Right arrow** to open it all again. Each change should be announced.
8. Press **End**, then **Home**. Focus should move to the last and first rows and read them.
9. Move to the `"session"` row and press **Enter**. The decoded token opens below it; moving down should read
   its rows one level deeper.

Note anything read twice, read in the wrong order, missing its level or position, or not announced at all.

## 7. Social preview check, with the real domain

- [ ] Paste the home page address and two inner page addresses into a chat app you use (a message to yourself is
      enough). Each should show the page title, its description and the green terminal share image.
- [ ] Try one of the link debuggers the big networks offer (Facebook's Sharing Debugger, LinkedIn's Post Inspector).
      They fetch the page the way their crawlers do, and can be asked to refresh a cached preview.
- [ ] If a preview looks stale after you change an image or a title, that is the network's cache, not the site.
      Use the debugger to refresh it.

## 8. What to watch in the first weeks

None of this has a target. It is what to look at, so a problem is noticed early.

- [ ] Search Console, **Pages** report: how many of the 11 pages are indexed, and the reason given for any that
      are not. "Discovered" or "Crawled, currently not indexed" can simply mean "not yet".
- [ ] Search Console, **Performance** report: which queries show the pages, and how many people click. Read it as
      it is; do not expect a number by a date.
- [ ] Search Console, **Sitemaps** and **Page experience** or **Core Web Vitals**: errors in the sitemap, and
      real-user speed data once there is enough of it to show.
- [ ] Cloudflare's analytics for the project: a spike in 404s usually means a mistyped or removed address that
      something still links to.
- [ ] Open the live site on a phone and a laptop now and then, in more than one browser, after every deploy.
- [ ] When you change a page's text in `pages/pages.json`, update its `updated` date so the sitemap's `lastmod` is true.
- [ ] Keep a short list of anything people report. Fix it, and re-run section 1 before the next release.
