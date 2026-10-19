'use strict';
// Stage 3: review rules and change summaries, using controlled mock generations (no real AI, no API key).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright';
process.env.AI_RENDER_CHECK = 'off'; // rendered checks are covered in generate.test.js; keep this suite fast
const { boot } = require('./helpers');

let T; let prov; let ed; let ed2; let pub; let viewer; let reg; let lastMock;
const PW = 'correct-horse-battery';
const tool = (name, input) => ({ type: 'tool_use', name, input });
const headingTurns = (newText = 'Your ventures are moving. <em') => [
  { content: [tool('edit_file', { path: 'lift.html', old_text: 'You’ve backed the ventures. <em', new_text: newText })] },
  { content: [tool('finish', { summary: 'Shortened the heading.' })] }];
const mock = (turns) => prov.setTestProvider(() => { lastMock = prov.mockProvider(turns); return lastMock; });

async function generated(client, over = {}, turns = headingTurns()) {
  mock(turns);
  const body = { siteId: 'threshold', page: 'lift.html', area: { kind: 'section', index: 0, key: 'aria:h1' },
    target: { selector: '#h1', label: 'Heading' }, changeTypes: ['text'], instruction: 'Shorter heading', status: 'submitted', ...over };
  const cr = (await client('/api/requests', { method: 'POST', body })).body;
  await client(`/api/requests/${cr.id}/generate`, { method: 'POST' });
  for (;;) {
    const [g] = (await client(`/api/requests/${cr.id}/generations`)).body;
    if (!['queued', 'running'].includes(g.status)) return { cr, g };
    await new Promise((r) => setTimeout(r, 100));
  }
}
const decide = (client, g, decision, note) => client(`/api/generations/${g.id}/review`, { method: 'POST', body: { decision, note } });

before(async () => {
  T = boot();
  prov = require('../src/ai/provider');
  for (const [e, r] of [['ed', 'editor'], ['ed2', 'editor'], ['pub', 'publisher'], ['view', 'viewer']]) T.auth.createUser({ email: `${e}@t.test`, name: e, role: r, password: PW });
  [ed, ed2, pub, viewer] = await Promise.all(['ed', 'ed2', 'pub', 'view'].map((e) => T.client(`${e}@t.test`, PW)));
  reg = (await ed('/api/sites/threshold/registry')).body;
});
after(() => { prov.setTestProvider(null); T.close(); });

test('change summary and comparison data for a page change; owner can approve; decisions are final; nothing published', async () => {
  const { cr, g } = await generated(ed);
  assert.equal(g.status, 'ready'); assert.equal(g.sharedChange, false);
  const rv = (await ed(`/api/generations/${g.id}/review`)).body;
  assert.deepEqual(rv.pages.map((p) => p.path), ['lift.html']);
  const t = rv.items.find((i) => i.kind === 'text');
  assert.match(t.before, /You’ve backed the ventures/); assert.match(t.after, /Your ventures are moving/);
  assert.deepEqual(rv.allowed, { approve: null, reject: null, revise: null });
  assert.equal((await viewer(`/api/generations/${g.id}/review`)).body.allowed.approve, 'Viewers cannot review changes.');
  assert.equal((await decide(viewer, g, 'approve')).status, 403);
  assert.equal((await decide(ed2, g, 'approve')).status, 403); // not the owner, not a publisher
  const ok = await decide(ed, g, 'approve');
  assert.equal(ok.status, 200); assert.equal(ok.body.review.status, 'approved'); assert.equal(ok.body.review.byName, 'ed');
  assert.match((await decide(pub, g, 'reject')).body.error, /already been reviewed/);
  assert.equal((await ed(`/api/requests/${cr.id}`)).body.latestGeneration.review.status, 'approved');
  const repo = path.join(T.dir, 'repos', 'threshold.git');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repo }).toString().trim(), reg.sha, 'main unchanged');
});

test('shared/global changes need a Publisher; publisher may approve; all pages offered for comparison', async () => {
  const navKey = reg.pages[1].shared.find((s) => s.name === 'Header & navigation').key;
  const { g } = await generated(ed, { area: { kind: 'shared', key: navKey }, target: null, changeTypes: ['typography'], allowSharedFiles: true },
    [{ content: [tool('edit_file', { path: 'site.css', old_text: '/* THRESHOLD — site system', new_text: '.nav-links a{letter-spacing:.1em}\n/* THRESHOLD — site system' })] },
      { content: [tool('finish', { summary: 'Spaced out navigation links.' })] }]);
  assert.equal(g.status, 'ready', JSON.stringify(g.checks)); assert.equal(g.sharedChange, true);
  const rv = (await ed(`/api/generations/${g.id}/review`)).body;
  assert.equal(rv.pages.length, 7);
  assert.ok(rv.items.some((i) => i.kind === 'shared' && /all 7 pages/.test(i.text)));
  assert.match(rv.allowed.approve, /Publisher must approve/);
  assert.equal(rv.allowed.reject, null); // the requester may still reject their own change
  assert.equal((await decide(ed, g, 'approve')).status, 403);
  assert.equal((await decide(pub, g, 'approve')).body.review.status, 'approved');
});

test('request revision: note required, feedback passed to the next AI attempt, old version no longer reviewable', async () => {
  const { cr, g } = await generated(ed);
  assert.equal((await decide(ed, g, 'revise', '')).status, 400);
  assert.equal((await decide(ed, g, 'revise', 'Keep the word "backed" please')).body.review.status, 'revision_requested');
  mock(headingTurns('You’ve backed moving ventures. <em'));
  await ed(`/api/requests/${cr.id}/generate`, { method: 'POST' });
  let g2;
  for (;;) { [g2] = (await ed(`/api/requests/${cr.id}/generations`)).body; if (!['queued', 'running'].includes(g2.status)) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(g2.n, 2); assert.equal(g2.status, 'ready');
  const brief = JSON.stringify(lastMock.requests[0].messages[0]);
  assert.match(brief, /THIS IS A REVISION/); assert.match(brief, /Keep the word \\"backed\\" please/);
  assert.match((await ed(`/api/generations/${g.id}/review`)).body.allowed.approve, /already been reviewed|newer version/);
  assert.equal((await decide(pub, g2, 'reject', 'Not needed now')).body.review.status, 'rejected');
});

test('failed generations cannot be approved', async () => {
  const { g } = await generated(ed, {}, [{ content: [tool('edit_file', { path: 'lift.html', old_text: '<p class="lead">For foundations', new_text: '<p class="lead">For funders' })] },
    { content: [tool('finish', { summary: 'x' })] }]);
  assert.equal(g.status, 'failed');
  assert.match((await decide(pub, g, 'approve')).body.error, /passed all checks/);
});
