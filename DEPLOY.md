# Deploying to Cloudflare Pages

Scanline JSON is a static site. `dist/` is not committed (it is in `.gitignore`); Cloudflare Pages builds it from
the repository on every push. GitHub Actions only runs the tests (`.github/workflows/ci.yml`) and never deploys.

Steps marked **Only you can do this** need your accounts, your money or your domain. Nothing in this repository
creates an account, pushes to a remote or changes a setting for you.

Button and menu names below follow Cloudflare's and GitHub's documentation as of writing. The dashboards change
now and then, so if a label differs, look for the closest one.

## Before you start

- **Decide about the git history first.** The first three commits still contain the product's retired old name
  (in file contents, in one commit message and in one file name), and earlier commits contain built `dist/`
  files. Once you push to a public repository, anyone can read that history. Keep it, or squash it into one clean
  commit before the first push. Pushing to a private repository still sends it to GitHub.
- Pick the real address, for example `https://json.yourname.dev`: `https` and just the domain, no trailing slash
  and no path. The site is built to live at the root of a domain.
- Tested with **Node 24.19.0** (`.node-version`), and only that version. `node tests/host.test.js` and the other
  tests need nothing installed.

## 1. GitHub

1. **Only you can do this.** Sign in to GitHub, or create an account.
2. **Only you can do this.** Create the repository: click **+** at the top right, then **New repository**. Give it a
   name, choose **Private** or **Public**, and leave **Add a README file**, **.gitignore** and **licence** all
   off, because the project already has its own files.
3. **Only you can do this.** In a terminal in the project folder, push the code (use the address GitHub shows):

       git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
       git push -u origin main

4. **Only you can do this.** Open the repository's **Actions** tab and check the **CI** run is green. It runs the
   logic, SEO, host-file and banned-word tests and a production build against a dummy address.

## 2. Cloudflare Pages project

5. **Only you can do this.** Sign in to Cloudflare, or create an account.
6. **Only you can do this.** In the dashboard open **Workers & Pages**, click **Create**, choose the **Pages** tab,
   then **Connect to Git**.
7. **Only you can do this.** Authorise Cloudflare to read your GitHub account (you can limit it to this one
   repository), select the repository, and click **Begin setup**.
8. **Only you can do this.** Fill in the build settings:

   | Setting | Value |
   | --- | --- |
   | Project name | anything; it becomes `your-name.pages.dev` |
   | Production branch | `main` |
   | Framework preset | `None` |
   | Build command | `node build.js --production` |
   | Build output directory | `dist` |
   | Root directory (under Advanced) | leave empty, if the repository root is the project folder |

   There is no install step to configure. `package.json` has no dependencies, and an empty `package-lock.json` is
   included so an automatic install has nothing to fetch.

9. **Only you can do this.** Open **Environment variables** (under Advanced, or later under **Settings**) and add
   these for **Production**:

   | Variable | Value |
   | --- | --- |
   | `NODE_VERSION` | `24.19.0` |
   | `SITE_URL` | `https://your-real-domain` |

   `NODE_VERSION` is the Node version the build runs on, and `24.19.0` is the version this was tested with.
   Cloudflare's documentation says the default on the current build image (v3) is Node 22.16.0, so without the
   variable the build would run on a version nobody tested here. `.node-version` holds the same number; keep the
   two equal, because the documentation does not say which one wins.

   `SITE_URL` is the real address. Every canonical tag, the sitemap, `robots.txt` and the share-image links come
   from it.

   **How `siteUrl` reaches the build.** `site.config.json` holds a placeholder (`https://example.com`) and the
   `SITE_URL` environment variable replaces it when set. Because the build command is `--production`, the build
   **fails with an error, writing nothing**, if `SITE_URL` is missing (the placeholder is then used), is not
   `https`, ends in a slash or has a path. You can instead edit `siteUrl` in `site.config.json` and commit it;
   the variable wins when both are set.

   **Preview builds run the same command**, so they need a valid `SITE_URL` too. Add the variable for
   **Preview** as well, for example `https://your-name.pages.dev`.

10. **Only you can do this.** Click **Save and Deploy**. Open the build log and check it ends with
    `dist/: 11 pages, ...` and does not contain a banner of `!!!!` lines.

## 3. Your domain

11. **Only you can do this.** Open the project, then **Custom domains**, then **Set up a custom domain**, and enter
    the domain exactly as it appears in `SITE_URL`.
12. **Only you can do this.** Follow what Cloudflare shows. If the domain's DNS is on Cloudflare it can add the record
    for you. Otherwise add the CNAME record it names at your registrar. A bare domain (no `www.` or
    subdomain) normally needs its DNS on Cloudflare. Wait until the domain shows as **Active** and its
    certificate has been issued.
13. **Only you can do this.** If you also use the `www.` form (or the bare form), send it to the one in `SITE_URL`
    with a redirect rule (in the domain's **Rules** section), so there is a single address for every page.
14. **Only you can do this. Force HTTPS.** In the Cloudflare dashboard open the domain, then **SSL/TLS**, then **Edge
    Certificates**, and turn on **Always Use HTTPS**. Check that `http://your-domain/` ends up on `https`.
    Optionally turn on HTTP Strict Transport Security there too, but only after every page works over `https`:
    browsers remember it, and it is slow to undo.
15. If you set `SITE_URL` to the `pages.dev` address at first, change it to the real domain now (step 9), then
    redeploy (**Deployments**, then **Retry deployment** on the latest, or push a commit).

Then work through `LAUNCH-CHECKLIST.md`.

## Rolling back

**Only you can do this.** If a deployment is wrong:

1. Open the project, then **Deployments**.
2. Find the last good **Production** deployment, open its **...** menu and choose **Rollback to this deployment**
   (or open the deployment and look for the rollback button).
3. Confirm. The older build goes live at once, without a new build. Pages keeps previous deployments for this.
4. To make the repository match, `git revert` the bad commit and push. That starts a normal build, which replaces
   the rolled-back version when it succeeds.

## What the build gives the host

- `_headers`: a Content-Security-Policy with no outside hosts (scripts, styles, fonts, images and the manifest only
  from the site itself, workers only from `blob:`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a Permissions-Policy that switches off features the site
  never uses, and caching: one year and `immutable` for `/assets/*`, always revalidated for pages, and at most an
  hour for `robots.txt`, `sitemap.xml` and the manifest. Cloudflare joins a repeated header from several
  matching rules with a comma, so each header is set by exactly one rule (`tests/host.test.js` checks this).
  Cloudflare's documentation does not say whether a custom `Cache-Control` replaces its default for static
  files, so check the live headers (see the checklist).
- `_redirects`: one address per page, lowercase with a trailing slash. `/index.html` goes to `/`, and `/page` and
  `/page/index.html` go to `/page/`, each in a single step.
- `404.html`, which Pages serves for any unknown address.

## Trying it locally

    node build.js
    node tools/serve.js            then open http://127.0.0.1:8080/

`tools/serve.js` applies the real `_headers` and `_redirects`, so what you see is what the host will do. A plain
`node build.js` with the placeholder address prints a loud warning twice and still builds. `node build.js
--single` writes `dist/scanline-json.html`, one file with everything inlined; it is a command, not something to
commit.
