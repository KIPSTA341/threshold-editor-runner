'use strict';
// CONTROLLED STAND-IN for GitHub used only by tests: a local "origin" git repository, a minimal REST API
// (App installation token, refs, pull requests, squash merge) and a static "Pages" server that serves the
// origin's main branch with a configurable deploy delay. It verifies the App JWT signature like GitHub does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function createFake({ sourceRepo, owner = 'test-owner', repo = 'Threshold-Website-Test', deployDelayMs = 1500 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'));
  const originDir = path.join(root, owner, `${repo}.git`);
  fs.mkdirSync(path.dirname(originDir), { recursive: true });
  execFileSync('git', ['clone', '--bare', '--quiet', sourceRepo, originDir]);
  const git = (...a) => execFileSync('git', a, { cwd: originDir, env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@x', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@x' } }).toString().trim();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const state = { tokens: new Set(), pulls: [], history: [{ sha: git('rev-parse', 'refs/heads/main'), at: 0 }], calls: [] };

  const verifyJwt = (auth) => {
    const [h, b, s] = String(auth || '').replace(/^Bearer /, '').split('.');
    if (!s) return false;
    return crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'));
  };
  const api = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { try { handle(); } catch (e) { console.error('FAKE GITHUB ERROR', req.method, req.url, e.message); res.writeHead(500); res.end('{}'); } });
    const handle = () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const data = body ? JSON.parse(body) : {};
      const u = req.url; const m = req.method;
      state.calls.push(`${m} ${u}`);
      if (m === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(u)) {
        if (u.includes('/Threshold-Website/')) return send(404, { message: 'Not Found' }); // App not installed on the original
        return verifyJwt(req.headers.authorization) ? send(200, { id: 77 }) : send(401, { message: 'Bad JWT' });
      }
      if (m === 'POST' && u === '/app/installations/77/access_tokens') {
        if (!verifyJwt(req.headers.authorization)) return send(401, { message: 'Bad JWT' });
        const t = `ghs_${crypto.randomBytes(12).toString('hex')}`; state.tokens.add(t);
        (state.tokenRequests = state.tokenRequests || []).push(data);
        return send(201, { token: t, expires_at: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (!state.tokens.has(String(req.headers.authorization).replace(/^Bearer /, ''))) return send(401, { message: 'Bad credentials' });
      const base = `/repos/${owner}/${repo}`;
      let dm;
      if (m === 'POST' && (dm = u.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/))) { state.dispatches = state.dispatches || []; state.dispatches.push({ repo: dm[1], workflow: dm[2], ...data }); return send(204); }
      if (m === 'GET' && u === `${base}/commits/main`) return send(200, { sha: git('rev-parse', 'refs/heads/main') });
      if (m === 'GET' && (dm = u.match(new RegExp(`^${base}/git/trees/([0-9a-f]{40})$`)))) return send(200, { tree: git('ls-tree', '--name-only', dm[1]).split('\n').map((p) => ({ path: p, type: 'blob' })) });
      if (m === 'POST' && u === `${base}/pulls`) {
        const n = state.pulls.length + 1;
        const head = git('rev-parse', `refs/heads/${data.head}`);
        state.pulls.push({ number: n, head: data.head, headSha: head, base: data.base, title: data.title, state: 'open' });
        return send(201, { number: n, html_url: `https://github.example/${owner}/${repo}/pull/${n}` });
      }
      let mm;
      if (m === 'PUT' && (mm = u.match(new RegExp(`^${base}/pulls/(\\d+)/merge$`)))) {
        const pr = state.pulls[Number(mm[1]) - 1];
        if (data.sha && data.sha !== pr.headSha) return send(409, { message: 'Head branch was modified' });
        const main = git('rev-parse', 'refs/heads/main');
        let tree;
        try {
          const mb = git('merge-base', main, pr.headSha);
          tree = git('merge-tree', '--write-tree', `--merge-base=${mb}`, main, pr.headSha).split('\n')[0];
        } catch { return send(405, { message: 'Pull Request is not mergeable' }); }
        const sha = git('commit-tree', tree, '-p', main, '-m', data.commit_title || pr.title);
        git('update-ref', 'refs/heads/main', sha);
        pr.state = 'merged'; pr.mergeSha = sha;
        state.history.push({ sha, at: Date.now() });
        return send(200, { sha, merged: true });
      }
      if (m === 'PATCH' && (mm = u.match(new RegExp(`^${base}/pulls/(\\d+)$`)))) { state.pulls[Number(mm[1]) - 1].state = data.state; return send(200, {}); }
      if (m === 'DELETE' && u.startsWith(`${base}/git/refs/heads/`)) { try { git('update-ref', '-d', `refs/heads/${u.slice(`${base}/git/refs/heads/`.length)}`); } catch { /* ignore */ } return send(204); }
      return send(404, { message: 'Not Found' });
    };
  });
  // "GitHub Pages": serves the main branch as it was deployDelayMs ago.
  const pages = http.createServer((req, res) => {
    const rawM = req.url.match(/^\/raw\/[^/]+\/[^/]+\/([0-9a-f]{40})\/(.+)$/);
    if (rawM) { try { res.writeHead(200); res.end(execFileSync('git', ['show', `${rawM[1]}:${rawM[2]}`], { cwd: originDir })); } catch { res.writeHead(404); res.end('nf'); } return; }
    const live = [...state.history].reverse().find((h) => Date.now() - h.at >= deployDelayMs) || state.history[0];
    const f = decodeURIComponent(req.url.split('?')[0].replace(/^\//, '')) || 'index.html';
    try { const out = execFileSync('git', ['show', `${live.sha}:${f}`], { cwd: originDir }); res.writeHead(200); res.end(out); } catch { res.writeHead(404); res.end('nf'); }
  });
  return new Promise((resolve) => api.listen(0, () => pages.listen(0, () => resolve({
    root, originDir, git, state, privateKey, owner, repo,
    apiUrl: `http://127.0.0.1:${api.address().port}`, pagesUrl: `http://127.0.0.1:${pages.address().port}/`,
    pushBase: `file://${root}`, close: () => { api.close(); pages.close(); },
  }))));
}
module.exports = { createFake };
