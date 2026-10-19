'use strict';
// Stage 4: publish an approved version through a GitHub pull request, verify the deployed website, and restore.
// Only Publishers/Admins, only sites with publishEnabled, only approved + validated versions. One job at a time.
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const { db, audit } = require('./db');
const sites = require('./sites');
const gh = require('./github');
const { ROLE_RANK } = require('./auth');

db.exec(`
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  generation_id INTEGER REFERENCES generations(id),
  cr_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('publish','restore')),
  restores_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('publishing','deploying','live','unverified','failed','restored')),
  branch TEXT, pr_number INTEGER, pr_url TEXT, previous_sha TEXT, merge_sha TEXT,
  files TEXT NOT NULL DEFAULT '[]', message TEXT,
  created_by INTEGER NOT NULL, created_at INTEGER NOT NULL, live_at INTEGER, finished_at INTEGER
);`);
db.prepare("UPDATE publications SET status='unverified', message='The server restarted while this was in progress. Use “Check website” to confirm.' WHERE status IN ('publishing','deploying')").run();

const J = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn, fn); return chain; };
const repoDir = (site) => path.join(cfg.REPO_DIR, `${site.id}.git`);
const remoteUrl = (site) => `${cfg.GITHUB.pushBase}/${site.githubRepo}.git`;

function git(site, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoDir(site), env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }, maxBuffer: 20 * 1024 * 1024, timeout: 120000 },
      (e, out, errOut) => (e ? reject(Object.assign(new Error((errOut || e.message).toString().replace(/AUTHORIZATION:[^\n]*/gi, '[redacted]').slice(0, 400)), { code: e.code, stdout: out })) : resolve(out.trim())));
  });
}
const update = (id, f) => {
  const cols = Object.keys(f);
  db.prepare(`UPDATE publications SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => f[c]), id);
};

function serialize(p) {
  if (!p) return null;
  const by = db.prepare('SELECT name FROM users WHERE id=?').get(p.created_by);
  return { id: p.id, kind: p.kind, status: p.status, prNumber: p.pr_number, prUrl: p.pr_url, mergeSha: p.merge_sha, previousSha: p.previous_sha,
    files: J(p.files, []), message: p.message, byName: by && by.name, createdAt: p.created_at, liveAt: p.live_at, restoresId: p.restores_id,
    restoredBy: p.status === 'restored' ? serialize(db.prepare("SELECT * FROM publications WHERE restores_id=? AND kind='restore' ORDER BY id DESC LIMIT 1").get(p.id)) : undefined };
}

// Push a commit to a fresh branch, open a pull request and merge it. Returns { prNumber, prUrl, mergeSha }.
async function ship(site, token, { commit, branch, title, body }) {
  const env = gh.gitAuthEnv(token);
  await git(site, ['push', '--force', remoteUrl(site), `${commit}:refs/heads/${branch}`], env);
  const pr = await gh.call('POST', `/repos/${site.githubRepo}/pulls`, { token, body: { title, head: branch, base: site.branch, body } });
  let merged;
  try {
    merged = await gh.call('PUT', `/repos/${site.githubRepo}/pulls/${pr.number}/merge`, { token, body: { merge_method: 'squash', sha: commit, commit_title: `${title} (#${pr.number})` } });
  } catch (e) {
    if ([405, 409, 422].includes(e.status)) {
      await gh.call('PATCH', `/repos/${site.githubRepo}/pulls/${pr.number}`, { token, body: { state: 'closed' } }).catch(() => {});
      throw Object.assign(new Error('The website was changed by someone else after this version was made, so it could not be merged safely. Generate the change again.'), { pr });
    }
    throw Object.assign(e, { pr });
  }
  await gh.call('DELETE', `/repos/${site.githubRepo}/git/refs/heads/${branch}`, { token, ok: [204, 422, 404] }).catch(() => {});
  return { prNumber: pr.number, prUrl: pr.html_url, mergeSha: merged.sha };
}

// Poll the deployed website until every changed file is served exactly as committed at mergeSha.
async function verifyDeploy(site, mergeSha, files, { timeoutSec = cfg.GITHUB.deployTimeoutSec, pollSec = cfg.GITHUB.deployPollSec } = {}) {
  const wanted = [];
  for (const f of files) {
    const b = await sites.readFile(site, mergeSha, f);
    wanted.push({ f, body: b ? b.toString('utf8').replace(/\r\n/g, '\n') : null });
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  for (;;) {
    let ok = true;
    for (const w of wanted) {
      try {
        const r = await fetch(`${site.pagesUrl.replace(/\/?$/, '/')}${w.f}?v=${mergeSha.slice(0, 10)}-${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
        const body = (await r.text()).replace(/\r\n/g, '\n');
        const binary = /\.(png|jpe?g|webp|gif|ico|woff2?)$/i.test(w.f);
        if (w.body === null ? r.status !== 404 : (r.status !== 200 || (!binary && body !== w.body))) { ok = false; last = `${w.f}: ${r.status === 200 ? 'old version still showing' : `HTTP ${r.status}`}`; break; }
      } catch (e) { ok = false; last = `${w.f}: ${e.message}`; break; }
    }
    if (ok) return { ok: true };
    if (Date.now() > deadline) return { ok: false, detail: last };
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

async function fetchMain(site, token) {
  await git(site, ['fetch', '--depth', '50', remoteUrl(site), `+refs/heads/${site.branch}:refs/heads/${site.branch}`], gh.gitAuthEnv(token));
  const sha = await git(site, ['rev-parse', `refs/heads/${site.branch}`]);
  db.prepare(`INSERT INTO site_versions (site_id,sha,fetched_at) VALUES (?,?,?) ON CONFLICT(site_id) DO UPDATE SET sha=excluded.sha, fetched_at=excluded.fetched_at`).run(site.id, sha, Date.now());
  return sha;
}

function guard(user, site) {
  if (ROLE_RANK[user.role] < ROLE_RANK.publisher) return 'Only Publishers can publish or restore.';
  if (!site || !site.publishEnabled) return 'Publishing to this website is locked. An administrator must enable it.';
  if (!site.githubRepo || !site.pagesUrl) return 'This website is not set up for publishing.';
  if (!gh.configured()) return 'Publishing is not connected to GitHub yet. An administrator must add the GitHub App.';
  return null;
}

function publish(user, gid, ip) {
  const g = db.prepare('SELECT * FROM generations WHERE id=?').get(gid);
  if (!g) return { error: 'Not found', code: 404 };
  const cr = JSON.parse(g.request_snapshot);
  const site = sites.getSite(cr.siteId);
  const err = guard(user, site);
  if (err) return { error: err, code: 403 };
  if (g.status !== 'ready' || g.review_status !== 'approved') return { error: 'Only approved versions can be published.', code: 400 };
  if (db.prepare("SELECT id FROM publications WHERE generation_id=? AND kind='publish' AND status IN ('publishing','deploying','live','unverified')").get(g.id)) {
    return { error: 'This version has already been published.', code: 409 };
  }
  const files = JSON.parse(g.changed_files || '[]');
  const id = db.prepare(`INSERT INTO publications (site_id,generation_id,cr_id,kind,status,branch,files,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(site.id, g.id, g.cr_id, 'publish', 'publishing', `editor/r${g.cr_id}-g${g.n}`, JSON.stringify(files), user.id, Date.now()).lastInsertRowid;
  audit(user.id, 'publish_started', { request: g.cr_id, generation: g.id, publication: id, site: site.id }, ip);
  const done = enqueue(async () => {
    try {
      const token = await gh.installationToken(site.githubRepo);
      const prev = await fetchMain(site, token);
      update(id, { previous_sha: prev });
      const approver = db.prepare('SELECT name FROM users WHERE id=?').get(g.reviewed_by);
      const r = await ship(site, token, {
        commit: g.result_sha, branch: `editor/r${g.cr_id}-g${g.n}`,
        title: `Website editor: ${cr.sectionLabel}`.slice(0, 120),
        body: `${g.summary || ''}\n\nRequest #${cr.id} by ${cr.author}: “${cr.instruction}”\nApproved by ${approver ? approver.name : 'a reviewer'}. Published by ${user.name} via Limitless Website Editor.`,
      });
      update(id, { status: 'deploying', pr_number: r.prNumber, pr_url: r.prUrl, merge_sha: r.mergeSha });
      await fetchMain(site, token);
      const v = await verifyDeploy(site, r.mergeSha, files);
      update(id, v.ok ? { status: 'live', live_at: Date.now(), finished_at: Date.now(), message: null }
        : { status: 'unverified', finished_at: Date.now(), message: `Published, but the website had not updated after ${Math.round(cfg.GITHUB.deployTimeoutSec / 60)} minutes (${v.detail}). Use “Check website” later.` });
      audit(user.id, v.ok ? 'publish_live' : 'publish_unverified', { publication: id, pr: r.prNumber, merge: r.mergeSha });
    } catch (e) {
      update(id, { status: 'failed', finished_at: Date.now(), message: e.message, ...(e.pr ? { pr_number: e.pr.number, pr_url: e.pr.html_url } : {}) });
      audit(user.id, 'publish_failed', { publication: id, error: e.message });
    }
  });
  return { id, done };
}

function restore(user, pubId, ip) {
  const p = db.prepare('SELECT * FROM publications WHERE id=?').get(pubId);
  if (!p) return { error: 'Not found', code: 404 };
  const site = sites.getSite(p.site_id);
  const err = guard(user, site);
  if (err) return { error: err, code: 403 };
  if (p.kind !== 'publish' || !['live', 'unverified'].includes(p.status) || !p.merge_sha) return { error: 'Only a published change can be restored.', code: 400 };
  if (db.prepare("SELECT id FROM publications WHERE status IN ('publishing','deploying') AND site_id=?").get(site.id)) return { error: 'Another publish is in progress. Try again in a moment.', code: 409 };
  const files = J(p.files, []);
  const id = db.prepare(`INSERT INTO publications (site_id,generation_id,cr_id,kind,restores_id,status,branch,files,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(site.id, p.generation_id, p.cr_id, 'restore', p.id, 'publishing', `editor/restore-${p.id}`, p.files, user.id, Date.now()).lastInsertRowid;
  audit(user.id, 'restore_started', { publication: p.id, restore: id }, ip);
  const done = enqueue(async () => {
    try {
      const token = await gh.installationToken(site.githubRepo);
      const head = await fetchMain(site, token);
      update(id, { previous_sha: head });
      // Undo exactly that publication on top of the current website (keeps any later, unrelated changes).
      let tree;
      try { tree = await git(site, ['merge-tree', '--write-tree', `--merge-base=${p.merge_sha}`, head, `${p.merge_sha}^`]); }
      catch (e) { throw new Error('Later changes overlap with this one, so it cannot be restored automatically.'); }
      tree = tree.split('\n')[0];
      const env = { GIT_AUTHOR_NAME: 'Website Editor', GIT_AUTHOR_EMAIL: 'editor@localhost', GIT_COMMITTER_NAME: 'Website Editor', GIT_COMMITTER_EMAIL: 'editor@localhost' };
      const commit = await git(site, ['commit-tree', tree, '-p', head, '-m', `Restore previous version (undo editor request #${p.cr_id})`], env);
      const r = await ship(site, token, { commit, branch: `editor/restore-${p.id}`, title: `Website editor: restore previous version (undo #${p.pr_number || p.id})`,
        body: `Restores the website to how it was before pull request #${p.pr_number}. Requested by ${user.name} via Limitless Website Editor.` });
      update(id, { status: 'deploying', pr_number: r.prNumber, pr_url: r.prUrl, merge_sha: r.mergeSha });
      await fetchMain(site, token);
      const v = await verifyDeploy(site, r.mergeSha, files);
      update(id, v.ok ? { status: 'live', live_at: Date.now(), finished_at: Date.now() } : { status: 'unverified', finished_at: Date.now(), message: `Restored on GitHub, but the website had not updated yet (${v.detail}).` });
      update(p.id, { status: 'restored' });
      audit(user.id, v.ok ? 'restore_live' : 'restore_unverified', { publication: p.id, restore: id, pr: r.prNumber });
    } catch (e) {
      update(id, { status: 'failed', finished_at: Date.now(), message: e.message });
      audit(user.id, 'restore_failed', { publication: p.id, error: e.message });
    }
  });
  return { id, done };
}

// Re-check whether the website shows a publication (e.g. after a slow deploy or a restart).
function recheck(user, pubId) {
  const p = db.prepare('SELECT * FROM publications WHERE id=?').get(pubId);
  if (!p) return { error: 'Not found', code: 404 };
  const site = sites.getSite(p.site_id);
  const err = guard(user, site);
  if (err) return { error: err, code: 403 };
  if (p.status !== 'unverified' || !p.merge_sha) return { error: 'Nothing to check.', code: 400 };
  const done = enqueue(async () => {
    const v = await verifyDeploy(site, p.merge_sha, J(p.files, []), { timeoutSec: 60 });
    if (v.ok) update(p.id, { status: 'live', live_at: Date.now(), message: null });
    else update(p.id, { message: `The website still does not show this change (${v.detail}).` });
  });
  return { id: p.id, done };
}

const forGeneration = (gid) => db.prepare('SELECT * FROM publications WHERE generation_id=? ORDER BY id').all(gid).map(serialize);
module.exports = { publish, restore, recheck, forGeneration, serialize, verifyDeploy, guard, ship, fetchMain, git };
