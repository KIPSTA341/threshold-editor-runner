'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let T;
const PW = 'correct-horse-battery';
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
let reg; let lift; let editor; let editor2; let viewer; let admin;

before(async () => {
  T = boot();
  T.auth.createUser({ email: 'admin@t.test', name: 'Admin', role: 'admin', password: PW });
  T.auth.createUser({ email: 'ed@t.test', name: 'Ed', role: 'editor', password: PW });
  T.auth.createUser({ email: 'ed2@t.test', name: 'Ed Two', role: 'editor', password: PW });
  T.auth.createUser({ email: 'view@t.test', name: 'Vi', role: 'viewer', password: PW });
  admin = await T.client('admin@t.test', PW);
  editor = await T.client('ed@t.test', PW);
  editor2 = await T.client('ed2@t.test', PW);
  viewer = await T.client('view@t.test', PW);
  reg = (await editor('/api/sites/threshold/registry')).body;
  lift = reg.pages.find((p) => p.path === 'lift.html');
});
after(() => T.close());

test('authentication: wrong password rejected, session cookie is HttpOnly + SameSite=Strict, logout ends session', async () => {
  const anon = await T.client();
  assert.equal((await anon('/api/login', { method: 'POST', body: { email: 'ed@t.test', password: 'nope-nope-nope' } })).status, 401);
  assert.equal((await anon('/api/login', { method: 'POST', body: { email: 'ghost@t.test', password: PW } })).status, 401);
  assert.equal((await anon('/api/me')).status, 401);
  const r = await anon('/api/login', { method: 'POST', body: { email: 'ed@t.test', password: PW } });
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await anon('/api/me')).body.email, 'ed@t.test');
  await anon('/api/logout', { method: 'POST' });
  assert.equal((await anon('/api/me')).status, 401);
  const page = await anon('/', { raw: true });
  assert.equal(page.status, 302);
});

test('account locks after repeated wrong passwords', async () => {
  T.auth.createUser({ email: 'lock@t.test', name: 'L', role: 'editor', password: PW });
  const anon = await T.client();
  for (let i = 0; i < 8; i++) await anon('/api/login', { method: 'POST', body: { email: 'lock@t.test', password: 'wrong-wrong-wrong' } });
  const r = await anon('/api/login', { method: 'POST', body: { email: 'lock@t.test', password: PW } });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Too many attempts/);
});

test('CSRF: state-changing calls without the editor Origin are blocked', async () => {
  const r = await editor('/api/requests', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('registry: LIFT hero detected with a stable key; every section has a non-positional key', () => {
  assert.equal(lift.sections[0].name, 'Top of page (hero)');
  assert.equal(lift.sections[0].key, 'aria:h1');
  assert.match(lift.sections[0].heading, /You’ve backed the ventures/);
  for (const p of reg.pages) for (const s of p.sections) assert.match(s.key, /^(id|aria|fp):/);
  assert.ok(reg.pages.some((p) => p.path === '404.html'));
});

test('preview: signed link serves the real page with overlay; tampered/expired/traversal links refused; framing restricted', async () => {
  const { url } = (await editor('/api/sites/threshold/preview-url?page=lift.html')).body;
  assert.ok(url.startsWith(T.P));
  const r = await fetch(url);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /You’ve backed the ventures/);
  assert.match(html, /__editor\/overlay\.js/);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.match(r.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${T.E}`));
  const css = await fetch(url.replace('lift.html', 'site.css'));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const tampered = url.replace(/\/p\/(\d+)\.[^/]+\//, '/p/$1.AAAA/');
  assert.equal((await fetch(tampered)).status, 403);
  const expired = url.replace(/\/p\/\d+\./, '/p/1000.');
  assert.equal((await fetch(expired)).status, 403);
  assert.equal((await fetch(url.replace('lift.html', '..%2F..%2Fetc%2Fpasswd'))).status, 404);
  assert.equal((await editor('/api/sites/threshold/preview-url?page=..%2Fsecret.html')).status, 404);
});

test('requests: create LIFT hero request with protected items, reopen intact, others cannot modify', async () => {
  const body = {
    siteId: 'threshold', page: 'lift.html', sectionIndex: 0, sectionKey: 'aria:h1',
    instruction: 'Make the main heading shorter. Keep the italic second line.',
    protectedSections: [1, 2], protectedElements: [{ selector: '#main > section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)', label: 'Kicker', sectionIndex: 0 }],
    allowSharedFiles: false, status: 'draft',
  };
  const c = await editor('/api/requests', { method: 'POST', body });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.sectionLabel, 'LIFT → Top of page (hero)');
  assert.equal(c.body.baseSha, reg.sha);

  const up = new FormData();
  up.append('files', new Blob([PNG], { type: 'image/png' }), 'ref.png');
  const u = await editor(`/api/requests/${c.body.id}/attachments`, { method: 'POST', body: up });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.attachments.length, 1);

  const fake = new FormData();
  fake.append('files', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'evil.png');
  assert.equal((await editor(`/api/requests/${c.body.id}/attachments`, { method: 'POST', body: fake })).status, 400);

  const again = (await editor(`/api/requests/${c.body.id}`)).body;
  assert.equal(again.instruction, body.instruction);
  assert.deepEqual(again.protectedSections, [1, 2]);
  assert.deepEqual(again.protectedElements, body.protectedElements);
  assert.equal(again.attachments.length, 1);
  const img = await editor(`/api/attachments/${again.attachments[0].id}`, { raw: true });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, PNG.length);

  const upd = await editor(`/api/requests/${c.body.id}`, { method: 'PUT', body: { ...body, instruction: 'Edited text', status: 'submitted' } });
  assert.equal(upd.body.status, 'submitted');
  assert.equal(upd.body.attachments.length, 1);
  assert.equal((await editor2(`/api/requests/${c.body.id}`, { method: 'PUT', body })).status, 403);
  assert.equal((await viewer('/api/requests', { method: 'POST', body })).status, 403);
});

test('requests: invalid input refused (bad selector, protecting the target section, stale section key)', async () => {
  const base = { siteId: 'threshold', page: 'lift.html', sectionIndex: 0, sectionKey: 'aria:h1', instruction: 'Change the heading' };
  assert.equal((await editor('/api/requests', { method: 'POST', body: { ...base, protectedElements: [{ selector: '#does-not-exist' }] } })).status, 400);
  assert.equal((await editor('/api/requests', { method: 'POST', body: { ...base, protectedSections: [0] } })).status, 400);
  assert.equal((await editor('/api/requests', { method: 'POST', body: { ...base, sectionKey: 'aria:t-q' } })).status, 400);
  assert.equal((await editor('/api/requests', { method: 'POST', body: { ...base, instruction: '' } })).status, 400);
});

test('admin: only admins manage people; disabling a user ends their session; audit log records actions', async () => {
  assert.equal((await editor('/api/admin/users')).status, 403);
  const created = await admin('/api/admin/users', { method: 'POST', body: { email: 'new@t.test', name: 'New', role: 'editor', password: 'short' } });
  assert.equal(created.status, 400);
  const ok = await admin('/api/admin/users', { method: 'POST', body: { email: 'new@t.test', name: 'New', role: 'editor', password: PW } });
  assert.equal(ok.status, 201);
  const newbie = await T.client('new@t.test', PW);
  assert.equal((await newbie('/api/me')).status, 200);
  await admin(`/api/admin/users/${ok.body.id}`, { method: 'PATCH', body: { disabled: true } });
  assert.equal((await newbie('/api/me')).status, 401);
  const log = (await admin('/api/admin/audit')).body.map((a) => a.action);
  for (const a of ['login', 'login_failed', 'request_created', 'attachments_added', 'user_created', 'user_updated']) assert.ok(log.includes(a), a);
});

test('backup: consistent copy passes integrity check and contains the data', async () => {
  const { backup } = require('../scripts/backup');
  const r = await backup(require('path').join(T.dir, 'bk'));
  assert.ok(r.counts.users >= 5);
  assert.ok(r.counts.change_requests >= 1);
  const Database = require('better-sqlite3');
  const copy = new Database(r.file, { readonly: true });
  assert.equal(copy.prepare("SELECT instruction FROM change_requests WHERE id=1").get().instruction, 'Edited text');
  copy.close();
});

test('registry: every page discovered (incl. error page) with sections and shared areas; nothing site-specific hard-coded', () => {
  assert.deepEqual(reg.pages.map((p) => p.path), ['index.html', 'lift.html', 'build.html', 'standard.html', 'team.html', 'begin.html', '404.html']);
  assert.deepEqual(reg.pages.map((p) => p.title), ['Home', 'LIFT', 'BUILD', 'The Standard', 'Team', 'Begin', 'Error page (404)']);
  for (const p of reg.pages) {
    assert.ok(p.sections.length >= 1, p.path);
    const names = p.shared.filter((s) => s.shared).map((s) => s.name);
    for (const n of ['Header & navigation', 'Footer']) assert.ok(names.includes(n), `${p.path} ${n}`);
    assert.ok(p.shared.every((s) => s.pageCount === 7));
  }
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'sites.js'), 'utf8')
    + require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8')
    + require('fs').readFileSync(require('path').join(__dirname, '..', 'preview-overlay', 'overlay.js'), 'utf8');
  assert.ok(!/lift\.html|build\.html|Threshold|phero|kicker/.test(src), 'site-specific names found in editor code');
});

const base = { siteId: 'threshold', instruction: 'Change it please' };
test('element-level targets: inside-area check, shared areas need explicit approval, add needs placement', async () => {
  const navKey = lift.shared.find((s) => s.name === 'Header & navigation').key;
  const navReq = { ...base, page: 'lift.html', area: { kind: 'shared', key: navKey }, target: { selector: '#nav > div:nth-of-type(2) > nav:nth-of-type(1)', label: 'Navigation', kind: 'navigation' }, changeTypes: ['typography', 'colour'] };
  const r1 = await editor('/api/requests', { method: 'POST', body: navReq });
  assert.equal(r1.status, 400); assert.match(r1.body.error, /appears on 7 pages/);
  const r2 = await editor('/api/requests', { method: 'POST', body: { ...navReq, allowSharedFiles: true } });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.requiresSharedApproval, true);
  assert.match(r2.body.sectionLabel, /^All pages → Header & navigation → Navigation/);
  // target outside its area is refused
  const r3 = await editor('/api/requests', { method: 'POST', body: { ...base, page: 'lift.html', area: { kind: 'section', index: 1, key: lift.sections[1].key }, target: { selector: '#h1', label: 'x' } } });
  assert.equal(r3.status, 400);
  // add requires placement; image replacement keeps types/devices
  const addReq = { ...base, page: 'team.html', area: { kind: 'section', index: 1, key: reg.pages.find((p) => p.path === 'team.html').sections[1].key }, changeTypes: ['add'] };
  assert.equal((await editor('/api/requests', { method: 'POST', body: addReq })).status, 400);
  const r4 = await editor('/api/requests', { method: 'POST', body: { ...addReq, placement: 'after', devices: 'mobile' } });
  assert.equal(r4.status, 201);
  assert.deepEqual([r4.body.placement, r4.body.devices, r4.body.changeTypes], ['after', 'mobile', ['add']]);
  // image purpose stored and editable
  const fd = new FormData(); fd.append('purposes', JSON.stringify(['use'])); fd.append('files', new Blob([PNG], { type: 'image/png' }), 'new-photo.png');
  const up = await editor(`/api/requests/${r4.body.id}/attachments`, { method: 'POST', body: fd });
  assert.equal(up.body.attachments[0].purpose, 'use');
  const pa = await editor(`/api/requests/${r4.body.id}/attachments/${up.body.attachments[0].id}`, { method: 'PATCH', body: { purpose: 'reference' } });
  assert.equal(pa.body.attachments[0].purpose, 'reference');
});

test('resolve: picked items must exist in the page source and match what was clicked', async () => {
  const area = lift.sections[0].selector;
  const ok = await editor('/api/sites/threshold/resolve', { method: 'POST', body: { sha: reg.sha, page: 'lift.html', areaSelector: area,
    chain: [{ selector: '#h1', sig: { tag: 'h1', text: 'You’ve backed the ventures. What’s helping them move?' } },
      { selector: '#h1', sig: { tag: 'h1', text: 'Different text injected by a script' } },
      { selector: '#main > section:nth-of-type(1) > div:nth-of-type(9)', sig: { tag: 'div' } }] } });
  assert.deepEqual(ok.body.valid, [true, false, false]);
});
