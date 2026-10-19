'use strict';
// ONE real AI generation against a disposable copy of the Threshold site (temporary data folder; nothing is
// published or pushed). Checks that the LIFT hero heading changed and the protected kicker did not.
// Usage: EDITOR_ANTHROPIC_API_KEY=... node scripts/verify-live-ai.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
if (!process.env.EDITOR_ANTHROPIC_API_KEY) { console.error('EDITOR_ANTHROPIC_API_KEY is not set. Nothing was run.'); process.exit(2); }
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-ai-'));
process.env.AI_PROVIDER = 'anthropic';
const { boot } = require('../test/helpers');

(async () => {
  const T = boot();
  T.auth.createUser({ email: 'verify@local', name: 'Verifier', role: 'admin', password: 'verify-password-123' });
  const c = await T.client('verify@local', 'verify-password-123');
  const kicker = '#main > section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)';
  const cr = (await c('/api/requests', { method: 'POST', body: { siteId: 'threshold', page: 'lift.html', area: { kind: 'section', index: 0, key: 'aria:h1' },
    target: { selector: '#h1', label: 'Heading' }, changeTypes: ['text'], status: 'submitted',
    instruction: 'Change the first line of this heading to: "Your ventures are moving." Keep the italic second line exactly as it is.',
    protectedElements: [{ selector: kicker, label: 'Kicker label', sectionIndex: 0 }] } })).body;
  const start = await c(`/api/requests/${cr.id}/generate`, { method: 'POST' });
  if (start.status !== 202) throw new Error(JSON.stringify(start.body));
  let g;
  for (;;) { [g] = (await c(`/api/requests/${cr.id}/generations`)).body; if (!['queued', 'running'].includes(g.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
  console.log(JSON.stringify({ status: g.status, provider: g.provider, model: g.model, summary: g.summary, message: g.message, usage: g.usage,
    checks: g.checks.map((x) => `${x.status.toUpperCase()} ${x.label}${x.detail && x.status !== 'pass' ? ` — ${x.detail}` : ''}`) }, null, 2));
  if (g.resultSha) {
    const repo = path.join(process.env.DATA_DIR, 'repos', 'threshold.git');
    const show = (sha) => execFileSync('git', ['show', `${sha}:lift.html`], { cwd: repo }).toString();
    const cheerio = require('cheerio');
    const a = cheerio.load(show(g.baseSha)); const b = cheerio.load(show(g.resultSha));
    console.log('Heading before:', a('#h1').text().trim());
    console.log('Heading after: ', b('#h1').text().trim());
    console.log('Protected kicker unchanged:', a.html(a(kicker)) === b.html(b(kicker)));
  }
  T.close();
  process.exit(g.status === 'ready' ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
