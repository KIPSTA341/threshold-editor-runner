'use strict';
// Boots an isolated editor (temp data dir, random ports) for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tse-test-'));
  const ep = 41000 + Math.floor(Math.random() * 3000);
  Object.assign(process.env, {
    DATA_DIR: dir, EDITOR_PORT: String(ep), PREVIEW_PORT: String(ep + 1),
    EDITOR_ORIGIN: `http://localhost:${ep}`, PREVIEW_ORIGIN: `http://127.0.0.1:${ep + 1}`,
  });
  const { start } = require('../src/server');
  const auth = require('../src/auth');
  const servers = start();
  const E = process.env.EDITOR_ORIGIN;
  const P = process.env.PREVIEW_ORIGIN;

  async function client(email, password) {
    let cookie = '';
    const call = async (url, { method = 'GET', body, headers = {}, raw } = {}) => {
      const h = { 'X-Requested-With': 'editor', Origin: E, Cookie: cookie, ...headers };
      if (body && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
      const r = await fetch(E + url, { method, headers: h, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, redirect: 'manual' });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return raw ? r : { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
    };
    if (email) { const r = await call('/api/login', { method: 'POST', body: { email, password } }); if (r.status !== 200) throw new Error('login failed'); }
    return call;
  }
  const close = () => { servers.editor.close(); servers.preview.close(); };
  return { dir, E, P, auth, client, close };
}
module.exports = { boot };
