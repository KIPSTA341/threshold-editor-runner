'use strict';
// Stage 2 tests with a CONTROLLED MOCK AI (scripted tool calls). They test the real pipeline end to end:
// isolated working copy, restricted tools, commit to a private branch, static + rendered validation, DB linkage.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright';
const { boot } = require('./helpers');

let T; let ed; let reg; let lift; let cfg; let prov; let lastMock;
const PW = 'correct-horse-battery';
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
const tool = (name, input) => ({ type: 'tool_use', name, input });
const turn = (...content) => ({ content, usage: { input_tokens: 4000, output_tokens: 300 } });
const finishTurn = (summary = 'Done.') => turn(tool('finish', { summary }));
const H1_OLD = 'You’ve backed the ventures. <em';
const H1_NEW = 'Your ventures are moving. <em';

function useMock(turns) {
  prov.setTestProvider(() => { lastMock = prov.mockProvider(turns); return lastMock; });
}
async function makeRequest(over = {}) {
  const body = { siteId: 'threshold', page: 'lift.html', area: { kind: 'section', index: 0, key: 'aria:h1' },
    target: { selector: '#h1', label: 'Heading', kind: 'heading' }, changeTypes: ['text'], instruction: 'Shorter heading', status: 'submitted', ...over };
  const r = await ed('/api/requests', { method: 'POST', body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function generate(crId, expectStatus = 202) {
  const r = await ed(`/api/requests/${crId}/generate`, { method: 'POST' });
  assert.equal(r.status, expectStatus, JSON.stringify(r.body));
  if (expectStatus !== 202) return r.body;
  for (let i = 0; i < 600; i++) {
    const [g] = (await ed(`/api/requests/${crId}/generations`)).body;
    if (!['queued', 'running'].includes(g.status)) return g;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('generation timed out');
}
const check = (g, id) => g.checks.find((c) => c.id === id) || {};
const failed = (g) => g.checks.filter((c) => c.status === 'fail').map((c) => c.id);

before(async () => {
  T = boot();
  cfg = require('../src/config');
  prov = require('../src/ai/provider');
  T.auth.createUser({ email: 'ed@t.test', name: 'Ed', role: 'editor', password: PW });
  ed = await T.client('ed@t.test', PW);
  reg = (await ed('/api/sites/threshold/registry')).body;
  lift = reg.pages.find((p) => p.path === 'lift.html');
});
after(() => { prov.setTestProvider(null); T.close(); });

test('AI switched off: Generate returns a clear message and nothing runs', async () => {
  prov.setTestProvider(null);
  assert.equal((await ed('/api/ai/status')).body.enabled, false);
  const cr = await makeRequest();
  const r = await generate(cr.id, 503);
  assert.match(r.error, /not switched on/);
});

test('acceptance: LIFT hero heading change → saved separately on a private branch, all checks pass, original untouched', async () => {
  useMock([
    turn(tool('read_file', { path: 'lift.html', start_line: 34, end_line: 45 })),
    turn(tool('edit_file', { path: 'lift.html', old_text: H1_OLD, new_text: H1_NEW })),
    finishTurn('Shortened the LIFT hero heading. The italic second line is unchanged.'),
  ]);
  const cr = await makeRequest({ protectedElements: [{ selector: '#main > section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)', label: 'Kicker', sectionIndex: 0 }] });
  const g = await generate(cr.id);
  assert.equal(g.status, 'ready', JSON.stringify(g.checks.filter((c) => c.status !== 'pass')));
  assert.deepEqual(g.changedFiles, ['lift.html']);
  assert.match(g.resultSha, /^[0-9a-f]{40}$/);
  assert.equal(g.provider, 'mock');
  for (const id of ['files', 'html:lift.html', 'sec:lift.html', 'links:lift.html', 'scope', 'protected', 'js', 'render-scope', 'render-protected', 'overflow']) assert.equal(check(g, id).status, 'pass', id);
  assert.ok(g.usage.costUsd > 0 && g.usage.turns === 3);
  // The AI received the brief with selection, protections and no credentials.
  const sent = JSON.stringify(lastMock.requests[0]);
  assert.match(sent, /SPECIFIC ITEM TO CHANGE/); assert.match(sent, /Kicker/); assert.doesNotMatch(sent, /x-api-key|EDITOR_ANTHROPIC/);
  // Separate version: generated commit has the new heading; base and main ref unchanged.
  const repo = path.join(T.dir, 'repos', 'threshold.git');
  const git = (...a) => execFileSync('git', a, { cwd: repo }).toString();
  assert.match(git('show', `${g.resultSha}:lift.html`), /Your ventures are moving/);
  assert.match(git('show', `${reg.sha}:lift.html`), /You’ve backed the ventures/);
  assert.equal(git('rev-parse', 'refs/heads/main').trim(), reg.sha);
  assert.equal(git('rev-parse', `refs/heads/editor/r${cr.id}-g1`).trim(), g.resultSha);
  assert.equal(git('rev-parse', `${g.resultSha}^`).trim(), reg.sha);
  // Linked to the request record for Stage 3.
  const rec = (await ed(`/api/requests/${cr.id}`)).body;
  assert.equal(rec.latestGeneration.id, g.id);
  assert.equal(rec.latestGeneration.resultSha, g.resultSha);
  // Previewable through the existing preview server.
  const { url } = (await ed(`/api/sites/threshold/preview-url?page=lift.html&sha=${g.resultSha}`)).body;
  assert.match(await (await fetch(url)).text(), /Your ventures are moving/);
});

test('scope: editing outside the selected item is rejected', async () => {
  useMock([
    turn(tool('edit_file', { path: 'lift.html', old_text: H1_OLD, new_text: H1_NEW })),
    turn(tool('edit_file', { path: 'lift.html', old_text: '<p class="lead">For foundations', new_text: '<p class="lead">For funders' })),
    finishTurn(),
  ]);
  const g = await generate((await makeRequest()).id);
  assert.equal(g.status, 'failed');
  assert.deepEqual(failed(g).includes('scope'), true);
  assert.match(check(g, 'scope').detail, /outside the selected item was changed/);
  assert.match(g.message, /did not pass/);
});

test('protection: changing a protected item is rejected', async () => {
  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: 'LIFT · For foundations and portfolio teams</span>', new_text: 'LIFT · For funders</span>' })), finishTurn()]);
  const cr = await makeRequest({ target: null, protectedElements: [{ selector: '#main > section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)', label: 'Kicker', sectionIndex: 0 }] });
  const g = await generate(cr.id);
  assert.equal(g.status, 'failed');
  assert.equal(check(g, 'protected').status, 'fail');
});

test('shared files: blocked without permission; AI asks for permission instead', async () => {
  useMock([
    turn(tool('edit_file', { path: 'site.css', old_text: ':root{', new_text: ':root{--x:1;' })),
    turn(tool('request_permission', { reason: 'Making every hero heading lighter needs the shared stylesheet.', files: ['site.css'] })),
  ]);
  const g = await generate((await makeRequest({ changeTypes: ['typography'] })).id);
  assert.equal(g.status, 'needs_permission');
  assert.match(g.message, /shared stylesheet/);
  const toolResult = JSON.stringify(lastMock.requests[1].messages.at(-1));
  assert.match(toolResult, /shared by every page and you do not have permission/);
  assert.equal(g.resultSha, null);
});

test('page-scoped design change via <style data-editor> passes; a leaking style is caught by the rendered check', async () => {
  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: '</head>', new_text: '<style data-editor>#main > section:nth-of-type(1) #h1{letter-spacing:-0.03em;font-size:3.6rem}</style>\n</head>' })), finishTurn()]);
  const ok = await generate((await makeRequest({ changeTypes: ['typography'] })).id);
  assert.equal(ok.status, 'ready', JSON.stringify(ok.checks.filter((c) => c.status !== 'pass')));

  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: '</head>', new_text: '<style data-editor>h2{color:#f00}</style>\n</head>' })), finishTurn()]);
  const bad = await generate((await makeRequest({ changeTypes: ['colour'] })).id);
  assert.equal(bad.status, 'failed');
  assert.equal(check(bad, 'render-scope').status, 'fail');
  assert.match(check(bad, 'render-scope').detail, /LIFT → /);
});

test('shared change WITH permission: allowed, but every affected page/section is flagged for review', async () => {
  const navKey = lift.shared.find((s) => s.name === 'Header & navigation').key;
  useMock([turn(tool('edit_file', { path: 'site.css', old_text: '/* THRESHOLD — site system', new_text: '.kicker{letter-spacing:.3em !important}\n/* THRESHOLD — site system' })), finishTurn('Widened label spacing site-wide.')]);
  const cr = await makeRequest({ area: { kind: 'shared', key: navKey }, target: null, changeTypes: ['typography'], allowSharedFiles: true });
  const g = await generate(cr.id);
  assert.equal(g.status, 'ready', JSON.stringify(g.checks.filter((c) => c.status === 'fail')));
  assert.equal(check(g, 'shared').status, 'warn');
  assert.equal(check(g, 'render-scope').status, 'warn');
  assert.ok(g.flagged.length >= 7, `flagged ${g.flagged.length}`);
  assert.ok(new Set(g.flagged.map((f) => f.page)).size === 7, 'all pages flagged');
});

test('integrity and safety: broken HTML and external scripts are rejected', async () => {
  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: '</em></h1>', new_text: '</em>' })), finishTurn()]);
  const g1 = await generate((await makeRequest()).id);
  assert.equal(g1.status, 'failed');
  assert.ok(failed(g1).some((id) => /^(html|scope)/.test(id)), JSON.stringify(failed(g1)));

  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: H1_OLD, new_text: 'Hi <script src="https://evil.example/x.js"></script><em' })), finishTurn()]);
  const g2 = await generate((await makeRequest()).id);
  assert.equal(g2.status, 'failed');
  assert.equal(check(g2, 'sec:lift.html').status, 'fail');
});

test('image replacement: an attached image marked "use" is added and referenced; links resolve', async () => {
  const team = reg.pages.find((p) => p.path === 'team.html');
  const cr = await makeRequest({ page: 'team.html', area: { kind: 'section', index: 1, key: team.sections[1].key }, target: null, changeTypes: ['image'], status: 'draft' });
  // Build the exact selector of the first photo in that section from the source (as the preview overlay would).
  const cheerio = require('cheerio');
  const html = execFileSync('git', ['show', `${reg.sha}:team.html`], { cwd: path.join(T.dir, 'repos', 'threshold.git') }).toString();
  const $ = cheerio.load(html);
  let el = $('#main > section:nth-of-type(2) img[src="team-akshay-cherian.jpg"]')[0]; const parts = [];
  while (el && el.tagName !== 'body') {
    if (el.attribs.id) { parts.unshift(`#${el.attribs.id}`); break; }
    parts.unshift(`${el.tagName}:nth-of-type(${$(el).prevAll(el.tagName).length + 1})`); el = el.parent;
  }
  const sel = parts.join(' > ');
  const fd = new FormData(); fd.append('purposes', JSON.stringify(['use'])); fd.append('files', new Blob([PNG], { type: 'image/png' }), 'new.png');
  const att = (await ed(`/api/requests/${cr.id}/attachments`, { method: 'POST', body: fd })).body.attachments[0];
  const upd = await ed(`/api/requests/${cr.id}`, { method: 'PUT', body: { siteId: 'threshold', page: 'team.html', area: { kind: 'section', index: 1, key: team.sections[1].key },
    target: { selector: sel, label: 'Image' }, changeTypes: ['image'], instruction: 'Use the attached photo', status: 'submitted' } });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  useMock([
    turn(tool('insert_image', { attachment_id: att.id })),
    turn(tool('edit_file', { path: 'team.html', old_text: 'src="team-akshay-cherian.jpg" alt="Portrait of Akshay Cherian"', new_text: `src="editor-r${cr.id}-${att.id}.png" alt="Portrait of Akshay Cherian"` })),
    finishTurn('Replaced the photo.'),
  ]);
  const g = await generate(cr.id);
  assert.ok(g.changedFiles.includes(`editor-r${cr.id}-${att.id}.png`));
  assert.equal(check(g, 'links:team.html').status, 'pass');
  assert.equal(check(g, 'files').status, 'pass');
  assert.equal(g.status, 'ready', JSON.stringify(g.checks.filter((c) => c.status !== 'pass')));
});

test('add a new section after the selection is accepted only when requested', async () => {
  const newSec = '</section>\n<section class="sec t-bone" data-nav="light"><div class="wrap"><h2>New FAQ</h2><p>Answer.</p></div></section>';
  const s2 = lift.sections[1];
  const anchor = 'Portfolio updates do not always reveal'; // inside section 2; we append after its closing tag via unique context
  useMock([turn(tool('read_file', { path: 'lift.html' })), turn(tool('edit_file', { path: 'lift.html', old_text: '</section>\n\n<section class="desk t-char"', new_text: `${newSec}\n<section class="desk t-char"` })), finishTurn()]);
  const ok = await generate((await makeRequest({ area: { kind: 'section', index: 1, key: s2.key }, target: null, changeTypes: ['add'], placement: 'after' })).id);
  assert.equal(ok.status, 'ready', JSON.stringify(ok.checks.filter((c) => c.status !== 'pass')) + anchor);
  useMock([turn(tool('edit_file', { path: 'lift.html', old_text: '</section>\n\n<section class="desk t-char"', new_text: `${newSec}\n<section class="desk t-char"` })), finishTurn()]);
  const bad = await generate((await makeRequest({ area: { kind: 'section', index: 1, key: s2.key }, target: null, changeTypes: ['text'] })).id);
  assert.equal(bad.status, 'failed');
  assert.match(check(bad, 'scope').detail, /adding/);
});

test('cost limit stops the generation before overspending; provider errors are not retried', async () => {
  const old = cfg.AI.maxCostUsd;
  cfg.AI.maxCostUsd = 0.05;
  useMock([turn(tool('read_file', { path: 'lift.html' })), turn(tool('read_file', { path: 'site.css' })), finishTurn()]);
  const g = await generate((await makeRequest()).id);
  cfg.AI.maxCostUsd = old;
  assert.equal(g.status, 'failed');
  assert.match(g.message, /per-change limit \(\$0\.05\)/);
  assert.ok(g.usage.costUsd <= 0.05);

  useMock([{ error: 'overloaded', status: 529 }, finishTurn()]);
  const g2 = await generate((await makeRequest()).id);
  assert.equal(g2.status, 'failed');
  assert.match(g2.message, /overloaded/);
  assert.equal(lastMock.requests.length, 1);
});

test('live provider wiring (against a local stand-in for the AI API): key sent only server-to-API, never stored or returned', async () => {
  const http = require('http');
  const seen = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 'tu1', name: 'edit_file', input: { path: 'lift.html', old_text: H1_OLD, new_text: H1_NEW } }], stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 200, cache_creation_input_tokens: 3000 } },
    { content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'Heading shortened.' } }], stop_reason: 'tool_use', usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 8000 } },
  ];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ headers: req.headers, body: JSON.parse(body) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(replies[seen.length - 1])); });
  }).listen(0);
  const port = srv.address().port;
  const saved = { ...cfg.AI };
  Object.assign(cfg.AI, { provider: 'anthropic', apiKey: 'sk-test-SECRET-123', apiUrl: `http://127.0.0.1:${port}/v1/messages` });
  prov.setTestProvider(null);
  try {
    assert.deepEqual((await ed('/api/ai/status')).body, { enabled: true, mode: 'live' });
    const cr = await makeRequest();
    const g = await generate(cr.id);
    assert.equal(g.status, 'ready', JSON.stringify(g.checks.filter((c) => c.status !== 'pass')));
    assert.equal(g.provider, 'anthropic'); assert.equal(g.model, 'claude-sonnet-5-5');
    assert.equal(seen[0].headers['x-api-key'], 'sk-test-SECRET-123');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].body.model, 'claude-sonnet-5-5');
    assert.deepEqual(seen[0].body.tools.map((t) => t.name), ['list_files', 'read_file', 'edit_file', 'insert_image', 'request_permission', 'finish']);
    assert.ok(seen[0].body.system[0].cache_control);
    assert.equal(seen[1].body.messages.at(-1).content[0].type, 'tool_result');
    assert.ok(!JSON.stringify(seen.map((s) => s.body)).includes('SECRET'), 'key leaked into prompt');
    // Cost from reported usage: 5000*2 + 200*10 + 3000*2.5 + 300*2 + 60*10 + 8000*0.1 per 1e6
    assert.equal(g.usage.costUsd, (5000 * 2 + 200 * 10 + 3000 * 2.5 + 300 * 2 + 60 * 10 + 8000 * 0.1) / 1e6);
    const everything = JSON.stringify([(await ed(`/api/requests/${cr.id}`)).body, (await ed(`/api/requests/${cr.id}/generations`)).body]);
    assert.ok(!everything.includes('SECRET'));
    const Database = require('better-sqlite3');
    const dbx = new Database(path.join(T.dir, 'editor.db'), { readonly: true });
    assert.ok(!JSON.stringify(dbx.prepare('SELECT * FROM generations').all().concat(dbx.prepare('SELECT * FROM audit_log').all())).includes('SECRET'));
    dbx.close();
  } finally { Object.assign(cfg.AI, saved); srv.close(); }
});
