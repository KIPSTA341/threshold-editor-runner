# Limitless Threshold Website Editor

A separate app for requesting website changes visually. It's read-only towards the website: Stage 1 never writes to the Threshold repository, GitHub Pages or Wix.

## Run locally (Node 20+)

    npm install
    npm run user:add -- you@limitless.institute admin "Your Name"   # prompts for a password (12+ chars)
    npm start                                                         # editor http://localhost:4000

The first start downloads a read-only copy of the Threshold site from GitHub. Previews are served from a separate address (http://127.0.0.1:4001) by design, so keep both ports free.

## Tests

    npm test           # API / security tests
    npm run test:e2e   # full browser walkthrough (needs Playwright + Chromium)

## Data

Everything lives in `data/` (database, uploaded images, secrets, site copy). It's never committed. Back it up with `npm run backup`, which makes an online copy and runs an integrity check on it.

Add another GitHub-hosted website by adding an entry to `sites.json`.

## AI generation (Stage 2)

Switched off until a key is set. Configure these on the server only; they never reach browsers.

    EDITOR_ANTHROPIC_API_KEY=...       # turns on live generation (Claude API)
    AI_MODEL=claude-sonnet-5-5         # default
    AI_MAX_COST_USD=0.60               # hard limit per generation (default 0.60)
    AI_MAX_TURNS=14                    # AI steps per generation
    PLAYWRIGHT_MODULE=...              # only if Playwright isn't installed in node_modules (needed for the rendered check)

Each generation runs once (no automatic retries). It's saved as a private local branch `editor/r<request>-g<n>` and is never pushed or published.

## Publishing (Stage 4)

An approved version is published by a Publisher: the editor pushes it to a temporary branch, opens a pull request, squash-merges it, then checks the GitHub Pages site until the new files are being served. "Restore previous version" undoes exactly that change through another pull request. Publishing only works on sites with `"publishEnabled": true` in `sites.json`. The live Threshold site is set to `false`; only "Threshold (TEST copy)" is enabled.

Server secrets: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the .pem contents). The app needs Contents and Pull requests set to read & write, and must be installed on the target repository only.

## Hosting (Fly.io)

`Dockerfile` and `fly.toml` are included: one always-on 1 GB machine, a persistent `/data` volume, daily volume snapshots, nightly in-app backups and automatic HTTPS.

    fly launch --no-deploy --copy-config
    fly volumes create editor_data --size 3 --region bom
    fly secrets set ADMIN_EMAIL=... ADMIN_INITIAL_PASSWORD=... EDITOR_ANTHROPIC_API_KEY=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
    fly deploy
    fly certs add editor.limitless.institute && fly certs add editor-preview.limitless.institute

Then add the two DNS records that `fly certs` shows. Check that live AI works with `fly ssh console -C "node scripts/verify-live-ai.js"`. This makes one real AI call on a throwaway copy and publishes nothing.
