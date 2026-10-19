'use strict';
// Stage 3: plain-language change summaries and the approve / reject / request-revision decision rules.
// Nothing here publishes or pushes anything.
const cheerio = require('cheerio');
const { db, audit } = require('./db');
const sites = require('./sites');
const { ROLE_RANK } = require('./auth');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Word-level diff → list of {before, after} phrases that changed.
function phraseChanges(a, b) {
  const A = a.split(' ').slice(0, 700); const B = b.split(' ').slice(0, 700);
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0; let del = []; let ins = [];
  const flush = () => { if (del.length || ins.length) out.push({ before: clip(del.join(' ')), after: clip(ins.join(' ')) }); del = []; ins = []; };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { flush(); i++; j++; } else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) ins.push(B[j++]); else del.push(A[i++]);
  }
  flush();
  return out.slice(0, 12);
}

async function changeSummary(g) {
  const cr = JSON.parse(g.request_snapshot);
  const site = sites.getSite(cr.siteId);
  const reg = await sites.getRegistry(site, g.base_sha);
  const files = JSON.parse(g.changed_files || '[]');
  const shared = site.sharedFiles || [];
  const items = [];
  const read = async (sha, p) => { const b = await sites.readFile(site, sha, p); return b ? b.toString('utf8') : ''; };
  for (const p of files) {
    const pg = reg.pages.find((x) => x.path === p);
    if (pg) {
      const $a = cheerio.load(await read(g.base_sha, p)); const $b = cheerio.load(await read(g.result_sha, p));
      const sa = $a(site.sectionSelector).toArray(); const sb = $b(site.sectionSelector).toArray();
      if (sb.length > sa.length) items.push({ kind: 'structure', text: `${sb.length - sa.length} new section${sb.length - sa.length > 1 ? 's' : ''} added on ${pg.title}` });
      if (sb.length < sa.length) items.push({ kind: 'structure', text: `${sa.length - sb.length} section${sa.length - sb.length > 1 ? 's' : ''} removed from ${pg.title}` });
      const changes = phraseChanges(norm($a('body').text()), norm($b('body').text()));
      changes.forEach((c) => items.push({ kind: 'text', page: pg.title, before: c.before, after: c.after }));
      const imgs = (S) => S('img').toArray().map((e) => S(e).attr('src'));
      const ia = imgs($a); const ib = imgs($b);
      ib.forEach((src, k) => { if (src !== ia[k] && !ia.includes(src)) items.push({ kind: 'image', page: pg.title, before: ia[k] || '(none)', after: src }); });
      const st = (S) => norm(S('head style[data-editor]').text());
      if (st($a) !== st($b)) items.push({ kind: 'design', text: `Design adjustments (fonts, colours, spacing or layout) for the selection on ${pg.title} only` });
      if (!changes.length && st($a) === st($b) && ia.join() === ib.join() && sa.length === sb.length) items.push({ kind: 'design', text: `Page structure or attributes adjusted on ${pg.title}` });
    } else if (shared.includes(p)) {
      items.push({ kind: 'shared', text: `Shared site-wide ${p.endsWith('.css') ? 'styles' : 'script'} changed — affects all ${reg.pages.length} pages` });
    } else items.push({ kind: 'image', text: `New image added (${p})` });
  }
  const sharedCss = files.some((f) => shared.includes(f));
  const pages = reg.pages.filter((x) => sharedCss || files.includes(x.path) || x.path === cr.page).map((x) => ({ path: x.path, title: x.title }));
  return { items, pages, requestPage: cr.page, target: cr.target, area: cr.area };
}

// Returns an error string, or null when allowed.
function canDecide(user, g, cr, decision) {
  const rank = ROLE_RANK[user.role];
  const owner = cr.created_by === user.id;
  const publisher = rank >= ROLE_RANK.publisher;
  if (rank < ROLE_RANK.editor) return 'Viewers cannot review changes.';
  if (g.status !== 'ready') return 'Only a change that passed all checks can be reviewed.';
  const latest = db.prepare('SELECT MAX(n) m FROM generations WHERE cr_id=?').get(g.cr_id).m;
  if (g.n !== latest) return 'A newer version exists for this request. Review that one instead.';
  if (g.review_status !== 'pending') return 'This version has already been reviewed.';
  if (decision === 'approve' && g.shared_change && !publisher) return 'This change affects every page, so a Publisher must approve it.';
  if (!owner && !publisher) return 'Only the person who made the request or a Publisher can review it.';
  return null;
}

function decide(user, gid, decision, note, ip) {
  const g = db.prepare('SELECT * FROM generations WHERE id=?').get(gid);
  if (!g) return { error: 'Not found', code: 404 };
  if (!['approve', 'reject', 'revise'].includes(decision)) return { error: 'Unknown decision.', code: 400 };
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(g.cr_id);
  const err = canDecide(user, g, cr, decision);
  if (err) return { error: err, code: 403 };
  const text = String(note || '').trim().slice(0, 2000);
  if (decision === 'revise' && text.length < 3) return { error: 'Say what should be different.', code: 400 };
  const status = { approve: 'approved', reject: 'rejected', revise: 'revision_requested' }[decision];
  db.prepare('UPDATE generations SET review_status=?, review_note=?, reviewed_by=?, reviewed_at=? WHERE id=?').run(status, text || null, user.id, Date.now(), g.id);
  audit(user.id, `generation_${status}`, { request: g.cr_id, generation: g.id, shared: !!g.shared_change }, ip);
  return { ok: true };
}

module.exports = { changeSummary, canDecide, decide, phraseChanges };
