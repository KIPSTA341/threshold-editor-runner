'use strict';
// Runs ONE editor job on a free GitHub Actions runner, using the existing editor code unchanged:
//   generate → existing request validation, AI tool loop (real Workers AI via the editor Worker), static + rendered checks
//   publish  → existing pull request + squash merge + deploy verification
//   restore  → existing exact undo of that publication + deploy verification
// Inputs: JOB_ID (number), EDITOR_API (Worker origin), RUNNER_SECRET. Nothing from the job is ever executed as code.
const fs = require('fs');
const os = require('os');
const path = require('path');

const JOB_ID = String(process.env.JOB_ID || '');
if (!/^\d{1,9}$/.test(JOB_ID)) { console.error('Invalid JOB_ID'); process.exit(1); }
const API = String(process.env.EDITOR_API || '').replace(/\/$/, '');
if (!/^https:\/\/[\w.-]+$/.test(API) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(API)) { console.error('Invalid EDITOR_API'); process.exit(1); }
const SECRET = process.env.RUNNER_SECRET || '';

async function worker(step, body) {
  const r = await fetch(`${API}/runner/jobs/${JOB_ID}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Editor ${step}: ${d.error || r.status}`);
  return d;
}

(async () => {
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  const spec = await worker('spec', { runUrl });
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${spec.githubToken}`);
  const { site, change } = spec;
  if (site.repo === 'KIPSTA341/Threshold-Website') throw new Error('Refusing to touch the original Threshold repository.');

  // Configure the existing editor for this single job (temporary data folder, one site, one-time token).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-job-'));
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify([{ id: 'test', name: 'Test', repo: `${process.env.GITHUB_PUSH_BASE || 'https://github.com'}/${site.repo}.git`, githubRepo: site.repo, branch: site.branch,
    liveUrl: site.pagesUrl, pagesUrl: site.pagesUrl, publishEnabled: true, allowedPaths: ['*.html', 'site.css', 'site.js'], sharedFiles: ['site.css', 'site.js'],
    excludePages: [], labelSelector: '.kicker', sectionSelector: site.sectionSelector }]));
  Object.assign(process.env, { DATA_DIR: path.join(tmp, 'data'), SITES_FILE: sitesFile, GITHUB_INSTALLATION_TOKEN: spec.githubToken,
    AI_PROVIDER: 'workers-ai-proxy', AI_PROXY_URL: `${API}/runner/jobs/${JOB_ID}/ai`, AI_PROXY_TOKEN: SECRET, AI_PROXY_MODEL: spec.aiModel,
    AI_PRICE_INPUT: '0', AI_PRICE_OUTPUT: '0', AI_PRICE_CACHE_READ: '0', AI_PRICE_CACHE_WRITE: '0', AI_MAX_OUTPUT_TOKENS: '2048', AI_MAX_READ_CHARS: '12000', // Llama 3.3 70B fp8 on Workers AI has a 24k-token context
    DEPLOY_TIMEOUT_SEC: '600', DEPLOY_POLL_SEC: '10' });
  const { boot } = require('../test/helpers');
  const T = boot();
  const sites = require('../src/sites');
  const pub = require('../src/publish');
  const gh = require('../src/github');
  const s = sites.getSite('test');

  try {
    if (spec.kind === 'generate') {
      const pass = require('crypto').randomBytes(18).toString('base64url'); // throwaway local account for this job only
      T.auth.createUser({ email: 'runner@local.test', name: 'Runner', role: 'admin', password: pass });
      const c = await T.client('runner@local.test', pass);
      const reg = (await c('/api/sites/test/registry')).body;
      const body = { siteId: 'test', page: change.page, area: { kind: change.area.kind, index: change.area.index, key: change.area.kind === 'shared' ? change.area.key : undefined },
        target: change.target, changeTypes: ['text'], instruction: change.instruction, status: 'submitted' };
      const cr = await c('/api/requests', { method: 'POST', body });
      if (cr.status !== 201) return worker('result', { status: 'failed', baseSha: reg.sha, message: cr.body.error || 'The request could not be validated.' });
      const st = await c(`/api/requests/${cr.body.id}/generate`, { method: 'POST' });
      if (st.status !== 202) return worker('result', { status: 'failed', baseSha: reg.sha, message: st.body.error });
      let g;
      for (;;) { [g] = (await c(`/api/requests/${cr.body.id}/generations`)).body; if (!['queued', 'running'].includes(g.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
      let branch = null;
      if (g.status === 'ready') {
        branch = `editor/change-${change.id}`;
        await pub.git(s, ['push', '--force', `${process.env.GITHUB_PUSH_BASE || 'https://github.com'}/${site.repo}.git`, `${g.resultSha}:refs/heads/${branch}`], gh.gitAuthEnv(spec.githubToken));
      }
      await worker('result', { status: g.status === 'ready' ? 'ready' : 'failed', baseSha: g.baseSha, resultSha: g.status === 'ready' ? g.resultSha : null, branch,
        summary: g.summary, checks: g.checks, model: g.model, usage: g.usage,
        message: g.status === 'ready' ? null : g.status === 'needs_permission' ? `Needs permission for shared design: ${g.message}` : g.message });
    } else if (spec.kind === 'publish') {
      await sites.syncSite(s);
      await pub.git(s, ['fetch', `${process.env.GITHUB_PUSH_BASE || 'https://github.com'}/${site.repo}.git`, `+refs/heads/${change.branch}:refs/heads/${change.branch}`], gh.gitAuthEnv(spec.githubToken));
      const prev = await pub.fetchMain(s, spec.githubToken);
      const r = await pub.ship(s, spec.githubToken, { commit: change.resultSha, branch: change.branch, title: `Website editor: change #${change.id} on ${change.page}`,
        body: `${change.summary || ''}\n\nRequest: “${change.instruction}”\nPublished via Limitless Website Editor (TEST).` });
      await pub.fetchMain(s, spec.githubToken);
      const files = (await pub.git(s, ['diff', '--name-only', prev, r.mergeSha])).split('\n').filter(Boolean);
      const v = await pub.verifyDeploy(s, r.mergeSha, files);
      await worker('result', { status: v.ok ? 'live' : 'unverified', prUrl: r.prUrl, mergeSha: r.mergeSha, previousSha: prev,
        message: v.ok ? null : `Merged, but the website had not updated yet (${v.detail}).` });
    } else if (spec.kind === 'restore') {
      await sites.syncSite(s);
      const head = await pub.fetchMain(s, spec.githubToken);
      let tree;
      try { tree = (await pub.git(s, ['merge-tree', '--write-tree', `--merge-base=${change.mergeSha}`, head, `${change.mergeSha}^`])).split('\n')[0]; }
      catch { return worker('result', { status: 'restore_failed', message: 'Later changes overlap with this one, so it cannot be restored automatically.' }); }
      const env = { GIT_AUTHOR_NAME: 'Website Editor', GIT_AUTHOR_EMAIL: 'editor@localhost', GIT_COMMITTER_NAME: 'Website Editor', GIT_COMMITTER_EMAIL: 'editor@localhost' };
      const commit = await pub.git(s, ['commit-tree', tree, '-p', head, '-m', `Restore previous version (undo editor change #${change.id})`], env);
      const r = await pub.ship(s, spec.githubToken, { commit, branch: `editor/restore-${change.id}`, title: `Website editor: restore previous version (undo change #${change.id})`, body: 'Restores the TEST website to how it was before this change.' });
      await pub.fetchMain(s, spec.githubToken);
      const files = (await pub.git(s, ['diff', '--name-only', head, r.mergeSha])).split('\n').filter(Boolean);
      const v = await pub.verifyDeploy(s, r.mergeSha, files);
      await worker('result', { status: v.ok ? 'restored' : 'restore_failed', prUrl: r.prUrl, message: v.ok ? null : `Restored on GitHub, but the website had not updated yet (${v.detail}).` });
    }
  } catch (e) {
    const status = { generate: 'failed', publish: 'publish_failed', restore: 'restore_failed' }[spec.kind];
    await worker('result', { status, message: e.message.replace(/ghs_\w+/g, '[token]') }).catch(() => {});
    throw e;
  } finally { T.close(); }
})().then(() => process.exit(0)).catch((e) => { console.error(e.message.replace(/ghs_\w+/g, '[token]'), e.cause ? String(e.cause) : '', (e.stack || '').split('\n').slice(1, 4).join(' ')); process.exit(1); });
