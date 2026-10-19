'use strict';
// Stage 4 publishing against a CONTROLLED GitHub STAND-IN (local origin repo + fake REST API + fake Pages host).
// Proves the editor's GitHub App auth, branch/PR/merge flow, deploy verification and restore logic. It is NOT a
// test against real GitHub.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFake } = require('./fakegithub');

let T; let F; let prov; let ed; let pub; let reg;
const PW = 'correct-horse-battery';
const tool = (name, input) => ({ type: 'tool_use', name, input });
const SITE = 'threshold-test';

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 200)); }
}
async function approvedHeadingChange(newText = 'Your ventures are moving. <em') {
  prov.setTestProvider(() => prov.mockProvider([
    { content: [tool('edit_file', { path: 'lift.html', old_text: 'You’ve backed the ventures. <em', new_text: newText })] },
    { content: [tool('finish', { summary: 'Shortened the heading.' })] }]));
  const cr = (await ed('/api/requests', { method: 'POST', body: { siteId: SITE, page: 'lift.html', area: { kind: 'section', index: 0, key: 'aria:h1' },
    target: { selector: '#h1', label: 'Heading' }, changeTypes: ['text'], instruction: 'Shorter heading', status: 'submitted' } })).body;
  await ed(`/api/requests/${cr.id}/generate`, { method: 'POST' });
  const g = await waitFor(async () => { const [x] = (await ed(`/api/requests/${cr.id}/generations`)).body; return !['queued', 'running'].includes(x.status) && x; });
  assert.equal(g.status, 'ready', JSON.stringify(g.checks));
  assert.equal((await ed(`/api/generations/${g.id}/review`, { method: 'POST', body: { decision: 'approve' } })).status, 200);
  return { cr, g };
}
const pubs = async (gid) => (await pub(`/api/generations/${gid}/review`)).body.publications;
const settle = (gid) => waitFor(async () => { const p = (await pubs(gid)).at(-1); return p && !['publishing', 'deploying'].includes(p.status) && p; });

before(async () => {
  F = await createFake({ sourceRepo: '/home/claude/threshold-src', deployDelayMs: 2500 });
  const sitesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sites-')), 'sites.json');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
  base[0].repo = '/home/claude/threshold-src';
  Object.assign(base[1], { repo: `${F.pushBase}/${F.owner}/${F.repo}.git`, githubRepo: `${F.owner}/${F.repo}`, pagesUrl: F.pagesUrl, liveUrl: F.pagesUrl });
  fs.writeFileSync(sitesFile, JSON.stringify(base));
  Object.assign(process.env, { SITES_FILE: sitesFile, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: F.privateKey, GITHUB_API_URL: F.apiUrl,
    GITHUB_PUSH_BASE: F.pushBase, DEPLOY_POLL_SEC: '1', DEPLOY_TIMEOUT_SEC: '30', AI_RENDER_CHECK: 'off' });
  T = require('./helpers').boot();
  prov = require('../src/ai/provider');
  T.auth.createUser({ email: 'ed@t.test', name: 'Ed', role: 'editor', password: PW });
  T.auth.createUser({ email: 'pub@t.test', name: 'Pia', role: 'publisher', password: PW });
  ed = await T.client('ed@t.test', PW); pub = await T.client('pub@t.test', PW);
  reg = (await ed(`/api/sites/${SITE}/registry`)).body;
});
after(() => { prov.setTestProvider(null); T.close(); F.close(); });

test('publish → pull request merged → website verified live → restore → previous version verified live', async () => {
  const originalMain = F.git('rev-parse', 'refs/heads/main');
  const originalTree = F.git('rev-parse', 'refs/heads/main^{tree}');
  const { g } = await approvedHeadingChange();
  assert.equal((await ed(`/api/generations/${g.id}/publish`, { method: 'POST' })).status, 403, 'editors cannot publish');
  const r = await pub(`/api/generations/${g.id}/publish`, { method: 'POST' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const p = await settle(g.id);
  assert.equal(p.status, 'live', p.message);
  assert.equal(p.prNumber, 1);
  assert.equal(F.state.pulls[0].state, 'merged');
  assert.match(F.state.pulls[0].head, /^editor\/r\d+-g1$/);
  assert.match(F.git('show', 'refs/heads/main:lift.html'), /Your ventures are moving/);
  assert.equal(F.git('rev-parse', 'refs/heads/main^'), originalMain, 'merged on top of the previous website');
  assert.match(await (await fetch(`${F.pagesUrl}lift.html`)).text(), /Your ventures are moving/);
  assert.match((await (await fetch(`${F.pagesUrl}lift.html`)).text()), /What’s helping them move\?/, 'rest of heading intact');
  assert.ok(F.state.calls.some((c) => c.startsWith('DELETE')), 'temporary branch removed');
  // The editor's own copy now follows the published website.
  assert.equal((await ed(`/api/sites/${SITE}/registry`)).body.sha, F.git('rev-parse', 'refs/heads/main'));
  assert.equal((await pub(`/api/generations/${g.id}/publish`, { method: 'POST' })).status, 409, 'cannot publish twice');

  const rs = await pub(`/api/publications/${p.id}/restore`, { method: 'POST' });
  assert.equal(rs.status, 202, JSON.stringify(rs.body));
  const restored = await settle(g.id);
  assert.equal(restored.kind, 'restore'); assert.equal(restored.status, 'live', restored.message);
  assert.equal(F.git('rev-parse', 'refs/heads/main^{tree}'), originalTree, 'website files exactly as before');
  assert.match(await (await fetch(`${F.pagesUrl}lift.html`)).text(), /You’ve backed the ventures/);
  assert.equal((await pubs(g.id)).find((x) => x.id === p.id).status, 'restored');
});

test('safety: live Threshold site is locked; unapproved versions and stale versions cannot be published', async () => {
  // Locked site (publishEnabled false) — the real Threshold entry.
  const live = (await pub('/api/sites/threshold/registry')).body;
  assert.ok(live.pages.length >= 7);
  const db = require('../src/db').db;
  const g = db.prepare("SELECT id FROM generations ORDER BY id DESC LIMIT 1").get();
  db.prepare("UPDATE generations SET request_snapshot=json_set(request_snapshot,'$.siteId','threshold') WHERE id=?").run(g.id);
  assert.match((await pub(`/api/generations/${g.id}/publish`, { method: 'POST' })).body.error, /locked/);
  db.prepare("UPDATE generations SET request_snapshot=json_set(request_snapshot,'$.siteId',?) WHERE id=?").run(SITE, g.id);

  // Someone edits the same heading on GitHub after the version was generated → merge refused, nothing changed.
  const { g: g2 } = await approvedHeadingChange('Ventures in motion. <em');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  F.git('worktree', 'add', '--quiet', wt, 'main');
  const f = path.join(wt, 'lift.html');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('You’ve backed the ventures. <em', 'Edited directly on GitHub. <em'));
  require('child_process').execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'direct edit'], { cwd: wt });
  F.state.history.push({ sha: F.git('rev-parse', 'refs/heads/main'), at: Date.now() });
  const before2 = F.git('rev-parse', 'refs/heads/main');
  assert.equal((await pub(`/api/generations/${g2.id}/publish`, { method: 'POST' })).status, 202);
  const p2 = await settle(g2.id);
  assert.equal(p2.status, 'failed');
  assert.match(p2.message, /changed by someone else/);
  assert.equal(F.git('rev-parse', 'refs/heads/main'), before2, 'website untouched');
  assert.equal(F.state.pulls.at(-1).state, 'closed');
});

test('no credentials stored or returned', async () => {
  const Database = require('better-sqlite3');
  const dbx = new Database(path.join(T.dir, 'editor.db'), { readonly: true });
  const dump = JSON.stringify(['publications', 'audit_log', 'generations'].map((t) => dbx.prepare(`SELECT * FROM ${t}`).all()));
  dbx.close();
  assert.ok(!/ghs_|BEGIN PRIVATE KEY|AUTHORIZATION/.test(dump));
});
