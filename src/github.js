'use strict';
// Minimal GitHub App client (no SDK): app JWT → installation token → REST calls. The private key and tokens stay
// in server memory; tokens are passed to git via an HTTP header in the environment, never in URLs or logs.
const crypto = require('crypto');
const { GITHUB } = require('./config');

const b64u = (b) => Buffer.from(b).toString('base64url');
function appJwt() {
  if (!GITHUB.appId || !GITHUB.privateKey) throw new Error('Publishing is not connected to GitHub yet (GitHub App not configured).');
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: GITHUB.appId }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(GITHUB.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function call(method, path, { token, body, ok = [200, 201, 204] } = {}) {
  const res = await fetch(`${GITHUB.apiUrl}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'limitless-website-editor',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!ok.includes(res.status)) {
    const e = new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}${data && data.message ? `: ${data.message}` : ''}`);
    e.status = res.status; throw e;
  }
  return data;
}

const tokens = new Map(); // repo -> { token, exp }
async function installationToken(fullRepo) {
  // On the GitHub Actions runner a short-lived token for the TEST repository is supplied by the editor Worker.
  if (process.env.GITHUB_INSTALLATION_TOKEN) return process.env.GITHUB_INSTALLATION_TOKEN;
  const c = tokens.get(fullRepo);
  if (c && c.exp - Date.now() > 5 * 60 * 1000) return c.token;
  const jwt = appJwt();
  const inst = await call('GET', `/repos/${fullRepo}/installation`, { token: jwt });
  const t = await call('POST', `/app/installations/${inst.id}/access_tokens`, { token: jwt, body: { repositories: [fullRepo.split('/')[1]] } });
  tokens.set(fullRepo, { token: t.token, exp: Date.parse(t.expires_at) });
  return t.token;
}

// Environment for git commands that talk to GitHub as the App (header auth; nothing in argv).
function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const n = Number(process.env.GIT_CONFIG_COUNT || 0); // append to any existing env-provided git config
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: `http.${GITHUB.pushBase}/.extraheader`, [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${basic}` };
}

const configured = () => !!(GITHUB.appId && GITHUB.privateKey) || !!process.env.GITHUB_INSTALLATION_TOKEN;
module.exports = { call, installationToken, gitAuthEnv, configured };
