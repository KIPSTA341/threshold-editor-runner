'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Secrets are generated once and kept out of the repository (data/ is gitignored).
function secret(name) {
  if (process.env[name]) return process.env[name];
  const f = path.join(DATA_DIR, `.${name.toLowerCase()}`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

const EDITOR_PORT = Number(process.env.EDITOR_PORT || 4000);
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 4001);

module.exports = {
  ROOT,
  DATA_DIR,
  EDITOR_PORT,
  PREVIEW_PORT,
  EDITOR_ORIGIN: process.env.EDITOR_ORIGIN || `http://localhost:${EDITOR_PORT}`,
  // Previews MUST live on a different origin so site code can never read the editor session.
  PREVIEW_ORIGIN: process.env.PREVIEW_ORIGIN || `http://127.0.0.1:${PREVIEW_PORT}`,
  PREVIEW_SECRET: secret('PREVIEW_SECRET'),
  SESSION_DAYS: 7,
  PREVIEW_TOKEN_MINUTES: 120,
  SITES: JSON.parse(fs.readFileSync(process.env.SITES_FILE || path.join(ROOT, 'sites.json'), 'utf8')),
  // GitHub App used for publishing (Stage 4). Private key stays on the server.
  GITHUB: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    pushBase: process.env.GITHUB_PUSH_BASE || 'https://github.com', // remote = `${pushBase}/${owner}/${repo}.git`
    deployTimeoutSec: Number(process.env.DEPLOY_TIMEOUT_SEC || 900),
    deployPollSec: Number(process.env.DEPLOY_POLL_SEC || 15),
  },
  BACKUP_HOURS: Number(process.env.BACKUP_HOURS || 24),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  REPO_DIR: path.join(DATA_DIR, 'repos'),
  // AI generation (Stage 2). Keys come only from the server environment and are never sent to browsers.
  AI: {
    provider: process.env.AI_PROVIDER || (process.env.EDITOR_ANTHROPIC_API_KEY ? 'anthropic' : ''), // 'anthropic' | 'mock' | '' (off)
    apiKey: process.env.EDITOR_ANTHROPIC_API_KEY || '',
    apiUrl: process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages',
    model: process.env.AI_MODEL || 'claude-sonnet-5-5',
    maxCostUsd: Number(process.env.AI_MAX_COST_USD || 0.6),
    maxTurns: Number(process.env.AI_MAX_TURNS || 14),
    maxOutputTokensPerCall: Number(process.env.AI_MAX_OUTPUT_TOKENS || 8000),
    // USD per million tokens. input/output/cacheRead = Claude Sonnet 5.5 list prices checked 2026-10-15 on
    // platform.claude.com/docs/en/about-claude/pricing; cacheWrite is an assumed 1.25x input (VERIFY). Override via env.
    price: {
      input: Number(process.env.AI_PRICE_INPUT || 2), output: Number(process.env.AI_PRICE_OUTPUT || 10),
      cacheRead: Number(process.env.AI_PRICE_CACHE_READ || 0.1), cacheWrite: Number(process.env.AI_PRICE_CACHE_WRITE || 2.5),
    },
    mockScript: process.env.AI_MOCK_SCRIPT || '',
    renderCheck: process.env.AI_RENDER_CHECK !== 'off',
  },
  SECURE_COOKIES: (process.env.EDITOR_ORIGIN || '').startsWith('https://'),
};
