'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const cfg = require('./config');
const { db, audit } = require('./db');
const auth = require('./auth');
const sites = require('./sites');
const { createPreviewApp, makePreviewUrl } = require('./preview');
const aiProvider = require('./ai/provider');
const { startGeneration, serializeGeneration } = require('./ai/generate');
const review = require('./review');
const publisher = require('./publish');

fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true, mode: 0o700 });
const PUB = path.join(cfg.ROOT, 'public');
const MAX_FILES = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'frame-src': [cfg.PREVIEW_ORIGIN],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': cfg.SECURE_COOKIES ? [] : null,
    },
  },
  strictTransportSecurity: cfg.SECURE_COOKIES,
}));
app.use(express.json({ limit: '100kb' }));
app.use(auth.sessionMiddleware);
app.use('/api', auth.csrfGuard);

const ip = (req) => req.ip;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Pages ----------
app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.type('text/plain').send('ok'); });
app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(PUB, 'login.html'))));
app.get('/', (req, res) => (req.user ? res.sendFile(path.join(PUB, 'app.html')) : res.redirect('/login')));
app.use('/assets', express.static(PUB, { index: false, maxAge: 0 }));

// ---------- Auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait a few minutes.' } });

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const r = auth.login(email, password, ip(req));
  if (r.error) return bad(res, r.error, 401);
  res.set('Set-Cookie', auth.cookieHeader(r.token, cfg.SESSION_DAYS * 86400));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  auth.logout(req);
  if (req.user) audit(req.user.id, 'logout', {}, ip(req));
  res.set('Set-Cookie', auth.cookieHeader('', 0));
  res.json({ ok: true });
});
app.get('/api/me', auth.requireRole('viewer'), (req, res) => res.json(req.user));

// ---------- Websites, pages, sections, previews ----------
const siteParam = (req, res) => {
  const s = sites.getSite(req.params.id);
  if (!s) bad(res, 'Unknown website', 404);
  return s;
};

app.get('/api/sites', auth.requireRole('viewer'), (_req, res) => {
  res.json(cfg.SITES.map((s) => ({ id: s.id, name: s.name, liveUrl: s.liveUrl, sectionSelector: s.sectionSelector })));
});

app.get('/api/sites/:id/registry', auth.requireRole('viewer'), wrap(async (req, res) => {
  const site = siteParam(req, res); if (!site) return;
  let sha;
  try { sha = req.query.sha ? String(req.query.sha) : await sites.currentSha(site); }
  catch { return bad(res, 'This website could not be loaded from GitHub. Check that its repository exists and is reachable.', 503); }
  if (!sites.SHA_RE.test(sha)) return bad(res, 'Unknown version', 404);
  let reg;
  try { reg = await sites.getRegistry(site, sha); } catch { return bad(res, 'Unknown version', 404); }
  const row = db.prepare('SELECT fetched_at FROM site_versions WHERE site_id=?').get(site.id);
  res.json({ ...reg, fetchedAt: row && row.fetched_at, sharedFiles: site.sharedFiles || [] });
}));

app.get('/api/sites/:id/preview-url', auth.requireRole('viewer'), wrap(async (req, res) => {
  const site = siteParam(req, res); if (!site) return;
  const sha = String(req.query.sha || await sites.currentSha(site));
  const page = String(req.query.page || 'index.html');
  if (!sites.SHA_RE.test(sha) || !/^[A-Za-z0-9._-]+\.html$/.test(page) || !(await sites.readFile(site, sha, page))) {
    return bad(res, 'Page not found', 404);
  }
  res.json({ url: makePreviewUrl(site.id, sha, page), previewOrigin: cfg.PREVIEW_ORIGIN });
}));

app.post('/api/sites/:id/resolve', auth.requireRole('viewer'), wrap(async (req, res) => {
  const site = siteParam(req, res); if (!site) return;
  const { sha, page, areaSelector, chain } = req.body || {};
  if (!sites.SHA_RE.test(String(sha)) || typeof areaSelector !== 'string') return bad(res, 'Invalid selection');
  const valid = await sites.resolveChain(site, sha, String(page), areaSelector, chain);
  if (!valid) return bad(res, 'That item could not be identified. Choose a section instead.');
  res.json({ valid });
}));

app.post('/api/sites/:id/refresh', auth.requireRole('admin'), wrap(async (req, res) => {
  const site = siteParam(req, res); if (!site) return;
  const sha = await sites.syncSite(site);
  audit(req.user.id, 'site_refreshed', { site: site.id, sha }, ip(req));
  res.json({ sha });
}));

// ---------- Change requests ----------
const CHANGE_TYPES = ['text', 'image', 'typography', 'colour', 'spacing', 'layout', 'animation', 'responsive', 'add', 'remove', 'link', 'other'];
const PLACEMENTS = ['before', 'after', 'inside', 'replace'];
const DEVICES = ['all', 'desktop', 'mobile'];
const J = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

function serialize(cr) {
  const atts = db.prepare('SELECT id,original_name,mime,size,purpose FROM attachments WHERE cr_id=? ORDER BY id').all(cr.id);
  const author = db.prepare('SELECT name,email FROM users WHERE id=?').get(cr.created_by);
  return {
    id: cr.id, siteId: cr.site_id, page: cr.page, sectionIndex: cr.section_index, sectionKey: cr.section_key,
    area: { kind: cr.area_kind, key: cr.area_key || cr.section_key, index: cr.section_index },
    target: J(cr.target, null), changeTypes: J(cr.change_types, []), placement: cr.placement, devices: cr.devices,
    sectionLabel: cr.section_label, baseSha: cr.base_sha, instruction: cr.instruction,
    protectedSections: J(cr.protected_sections, []), protectedElements: J(cr.protected_elements, []),
    allowSharedFiles: !!cr.allow_shared_files, requiresSharedApproval: !!cr.requires_shared_approval,
    status: cr.status, createdBy: cr.created_by,
    author: author ? author.name : 'Unknown', createdAt: cr.created_at, updatedAt: cr.updated_at, attachments: atts,
    latestGeneration: serializeGeneration(db.prepare('SELECT * FROM generations WHERE cr_id=? ORDER BY n DESC LIMIT 1').get(cr.id)),
  };
}

// Validates a request body against the site's real registry at the request's base version.
// Scope model: one area (a page section or a shared area such as navigation/footer), optionally narrowed to one
// element inside it. Everything outside that scope is protected by default; extra protections can be added inside it.
async function validateRequest(body, site, baseSha) {
  const reg = await sites.getRegistry(site, baseSha);
  const page = reg.pages.find((p) => p.path === body.page);
  if (!page) return { error: 'Choose a page.' };
  const a = body.area || { kind: 'section', index: body.sectionIndex, key: body.sectionKey };
  let area;
  if (a.kind === 'shared') {
    const sh = page.shared.find((x) => x.key === a.key);
    if (!sh) return { error: 'Choose what to change.' };
    area = { kind: 'shared', index: -1, key: sh.key, selector: sh.selector, name: sh.name, shared: sh.shared, pageCount: sh.pageCount };
  } else {
    const idx = Number(a.index);
    const sec = Number.isInteger(idx) ? page.sections[idx] : null;
    if (!sec) return { error: 'Choose what to change (click it in the preview).' };
    if (a.key && a.key !== sec.key) return { error: 'That section has changed on the website. Please choose it again.' };
    area = { kind: 'section', index: idx, key: sec.key, selector: sec.selector, name: sec.name, shared: false, pageCount: 1 };
  }
  let target = null;
  if (body.target && body.target.selector !== area.selector) {
    if (!(await sites.validateSelector(site, baseSha, page.path, body.target.selector, area.selector))) {
      return { error: 'The selected item could not be found on the page. Please click it again.' };
    }
    target = { selector: body.target.selector, label: String(body.target.label || 'Item').slice(0, 160), kind: String(body.target.kind || 'element').slice(0, 30) };
  }
  const changeTypes = Array.isArray(body.changeTypes) ? [...new Set(body.changeTypes)].filter((t) => CHANGE_TYPES.includes(t)) : [];
  const placement = changeTypes.includes('add') ? body.placement : null;
  if (changeTypes.includes('add') && !PLACEMENTS.includes(placement)) return { error: 'Say where the new item should go.' };
  const devices = DEVICES.includes(body.devices) ? body.devices : 'all';
  const instruction = String(body.instruction || '').trim();
  if (instruction.length < 3) return { error: 'Describe the change you want.' };
  if (instruction.length > 4000) return { error: 'Please keep the description under 4,000 characters.' };
  const ps = Array.isArray(body.protectedSections) ? [...new Set(body.protectedSections.map(Number))] : [];
  if (ps.some((i) => !Number.isInteger(i) || !page.sections[i])) return { error: 'A protected section is not valid.' };
  if (area.kind === 'section' && ps.includes(area.index)) return { error: 'The section you are changing cannot also be marked “keep unchanged”.' };
  const pe = Array.isArray(body.protectedElements) ? body.protectedElements : [];
  if (pe.length > 50) return { error: 'Too many protected items (maximum 50).' };
  const elements = [];
  for (const e of pe) {
    if (!e || !(await sites.validateSelector(site, baseSha, page.path, e.selector))) return { error: 'A protected item could not be found on the page. Please pick it again.' };
    if (e.selector === (target ? target.selector : area.selector)) return { error: 'The item you are changing cannot also be marked “keep unchanged”.' };
    elements.push({ selector: e.selector, label: String(e.label || 'Element').slice(0, 160), sectionIndex: Number.isInteger(e.sectionIndex) ? e.sectionIndex : -1 });
  }
  const requiresShared = area.shared ? 1 : 0;
  const allowShared = body.allowSharedFiles ? 1 : 0;
  if (requiresShared && !allowShared) {
    return { error: `“${area.name}” appears on ${area.pageCount} pages. Tick the shared-change box to confirm it should change everywhere.` };
  }
  const status = body.status === 'submitted' ? 'submitted' : 'draft';
  const where = area.shared ? `All pages → ${area.name}` : `${page.title} → ${area.name}`;
  return {
    value: {
      page: page.path, area, target, changeTypes, placement, devices, instruction, ps, elements, allowShared, requiresShared, status,
      label: target ? `${where} → ${target.label}` : where,
    },
  };
}

const canEdit = (user, cr) => cr.created_by === user.id || user.role === 'admin';

app.get('/api/requests', auth.requireRole('viewer'), (req, res) => {
  const rows = db.prepare('SELECT * FROM change_requests WHERE site_id=? ORDER BY updated_at DESC LIMIT 200')
    .all(String(req.query.site || cfg.SITES[0].id));
  res.json(rows.map(serialize));
});

app.get('/api/requests/:rid', auth.requireRole('viewer'), (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  res.json(serialize(cr));
});

const CR_FIELDS = ['page', 'section_index', 'section_key', 'section_label', 'instruction', 'protected_sections', 'protected_elements',
  'allow_shared_files', 'status', 'area_kind', 'area_key', 'target', 'change_types', 'placement', 'devices', 'requires_shared_approval'];
const crValues = (x) => [x.page, x.area.index, x.area.key, x.label, x.instruction, JSON.stringify(x.ps), JSON.stringify(x.elements),
  x.allowShared, x.status, x.area.kind, x.area.key, x.target ? JSON.stringify(x.target) : null, JSON.stringify(x.changeTypes),
  x.placement, x.devices, x.requiresShared];

app.post('/api/requests', auth.requireRole('editor'), wrap(async (req, res) => {
  const site = sites.getSite(String(req.body.siteId || ''));
  if (!site) return bad(res, 'Choose a website.');
  const baseSha = await sites.currentSha(site);
  const v = await validateRequest(req.body, site, baseSha);
  if (v.error) return bad(res, v.error);
  const x = v.value; const now = Date.now();
  const cols = ['site_id', 'base_sha', 'created_by', 'created_at', 'updated_at', ...CR_FIELDS];
  const id = db.prepare(`INSERT INTO change_requests (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(site.id, baseSha, req.user.id, now, now, ...crValues(x)).lastInsertRowid;
  audit(req.user.id, 'request_created', { id, status: x.status, page: x.page, area: x.area.key, target: x.target && x.target.selector }, ip(req));
  res.status(201).json(serialize(db.prepare('SELECT * FROM change_requests WHERE id=?').get(id)));
}));

app.put('/api/requests/:rid', auth.requireRole('editor'), wrap(async (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  if (!canEdit(req.user, cr)) return bad(res, 'Only the person who created this request can change it.', 403);
  const site = sites.getSite(cr.site_id);
  const v = await validateRequest(req.body, site, cr.base_sha);
  if (v.error) return bad(res, v.error);
  const x = v.value;
  db.prepare(`UPDATE change_requests SET ${CR_FIELDS.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`)
    .run(...crValues(x), Date.now(), cr.id);
  audit(req.user.id, 'request_updated', { id: cr.id, status: x.status }, ip(req));
  res.json(serialize(db.prepare('SELECT * FROM change_requests WHERE id=?').get(cr.id)));
}));

// ---------- AI generation (Stage 2) ----------
app.get('/api/ai/status', auth.requireRole('viewer'), (_req, res) => res.json(aiProvider.status()));

app.post('/api/requests/:rid/generate', auth.requireRole('editor'), (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  if (!canEdit(req.user, cr)) return bad(res, 'Only the person who created this request can generate changes for it.', 403);
  if (cr.status !== 'submitted') return bad(res, 'Mark the request as ready (Generate Changes) first.');
  const r = startGeneration(cr, serialize(cr), req.user);
  if (r.error) return bad(res, r.error, r.code);
  res.status(202).json(serializeGeneration(db.prepare('SELECT * FROM generations WHERE id=?').get(r.id)));
});

app.get('/api/requests/:rid/generations', auth.requireRole('viewer'), (req, res) => {
  res.json(db.prepare('SELECT * FROM generations WHERE cr_id=? ORDER BY n DESC').all(Number(req.params.rid)).map(serializeGeneration));
});

// ---------- Review (Stage 3): compare, approve, reject, request revision. Never publishes. ----------
app.get('/api/generations/:gid/review', auth.requireRole('viewer'), wrap(async (req, res) => {
  const g = db.prepare('SELECT * FROM generations WHERE id=?').get(Number(req.params.gid));
  if (!g || !g.result_sha) return bad(res, 'No generated version to review.', 404);
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(g.cr_id);
  const allowed = Object.fromEntries(['approve', 'reject', 'revise'].map((d) => [d, review.canDecide(req.user, g, cr, d)]));
  const site = sites.getSite(JSON.parse(g.request_snapshot).siteId);
  res.json({ generation: serializeGeneration(g), ...(await review.changeSummary(g)), allowed,
    publications: publisher.forGeneration(g.id), publishBlocked: publisher.guard(req.user, site), siteLiveUrl: site && site.liveUrl, pagesUrl: site && site.pagesUrl });
}));

app.post('/api/generations/:gid/review', auth.requireRole('editor'), (req, res) => {
  const r = review.decide(req.user, Number(req.params.gid), String((req.body || {}).decision || ''), (req.body || {}).note, ip(req));
  if (r.error) return bad(res, r.error, r.code);
  res.json(serializeGeneration(db.prepare('SELECT * FROM generations WHERE id=?').get(Number(req.params.gid))));
});

// ---------- Publishing (Stage 4): GitHub pull request + merge, deploy verification, restore ----------
const pubResult = (res, r) => (r.error ? bad(res, r.error, r.code) : res.status(202).json(publisher.serialize(db.prepare('SELECT * FROM publications WHERE id=?').get(r.id))));
app.post('/api/generations/:gid/publish', auth.requireRole('publisher'), (req, res) => pubResult(res, publisher.publish(req.user, Number(req.params.gid), ip(req))));
app.post('/api/publications/:pid/restore', auth.requireRole('publisher'), (req, res) => pubResult(res, publisher.restore(req.user, Number(req.params.pid), ip(req))));
app.post('/api/publications/:pid/recheck', auth.requireRole('publisher'), (req, res) => pubResult(res, publisher.recheck(req.user, Number(req.params.pid))));

// ---------- Attachments (reference images) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: cfg.UPLOAD_DIR,
    filename: (_req, _f, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 5 },
});

function sniffImage(file) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

app.post('/api/requests/:rid/attachments', auth.requireRole('editor'), (req, res, next) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  if (!canEdit(req.user, cr)) return bad(res, 'Only the person who created this request can change it.', 403);
  const existing = db.prepare('SELECT COUNT(*) n FROM attachments WHERE cr_id=?').get(cr.id).n;
  upload.array('files', MAX_FILES)(req, res, (err) => {
    const files = req.files || [];
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    if (err) { cleanup(); return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 8 MB.' : 'Upload failed.'); }
    if (existing + files.length > MAX_FILES) { cleanup(); return bad(res, `You can attach up to ${MAX_FILES} images.`); }
    const typed = files.map((f) => ({ f, mime: sniffImage(f.path) }));
    if (typed.some((t) => !t.mime)) { cleanup(); return bad(res, 'Only PNG, JPEG, WebP or GIF images can be attached.'); }
    const ins = db.prepare('INSERT INTO attachments (cr_id,original_name,stored_name,mime,size,created_at,purpose) VALUES (?,?,?,?,?,?,?)');
    const purposes = J(req.body && req.body.purposes, []);
    typed.forEach(({ f, mime }, i) => ins.run(cr.id, path.basename(f.originalname).slice(0, 150), f.filename, mime, f.size, Date.now(),
      purposes[i] === 'use' ? 'use' : 'reference'));
    db.prepare('UPDATE change_requests SET updated_at=? WHERE id=?').run(Date.now(), cr.id);
    audit(req.user.id, 'attachments_added', { id: cr.id, count: files.length }, ip(req));
    res.json(serialize(db.prepare('SELECT * FROM change_requests WHERE id=?').get(cr.id)));
  });
});

app.delete('/api/requests/:rid/attachments/:aid', auth.requireRole('editor'), (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  if (!canEdit(req.user, cr)) return bad(res, 'Not allowed', 403);
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND cr_id=?').get(Number(req.params.aid), cr.id);
  if (!a) return bad(res, 'Image not found', 404);
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  fs.rmSync(path.join(cfg.UPLOAD_DIR, a.stored_name), { force: true });
  audit(req.user.id, 'attachment_removed', { id: cr.id, attachment: a.id }, ip(req));
  res.json(serialize(cr));
});

app.patch('/api/requests/:rid/attachments/:aid', auth.requireRole('editor'), (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(Number(req.params.rid));
  if (!cr) return bad(res, 'Request not found', 404);
  if (!canEdit(req.user, cr)) return bad(res, 'Not allowed', 403);
  const purpose = req.body && req.body.purpose === 'use' ? 'use' : 'reference';
  const r = db.prepare('UPDATE attachments SET purpose=? WHERE id=? AND cr_id=?').run(purpose, Number(req.params.aid), cr.id);
  if (!r.changes) return bad(res, 'Image not found', 404);
  audit(req.user.id, 'attachment_updated', { id: cr.id, attachment: Number(req.params.aid), purpose }, ip(req));
  res.json(serialize(db.prepare('SELECT * FROM change_requests WHERE id=?').get(cr.id)));
});

app.get('/api/attachments/:aid', auth.requireRole('viewer'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(req.params.aid));
  if (!a) return bad(res, 'Not found', 404);
  res.set({ 'Content-Type': a.mime, 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `inline; filename="attachment-${a.id}"` });
  res.sendFile(path.join(cfg.UPLOAD_DIR, a.stored_name));
});

// ---------- Administration ----------
app.get('/api/admin/users', auth.requireRole('admin'), (_req, res) => {
  res.json(db.prepare('SELECT id,email,name,role,disabled,created_at FROM users ORDER BY id').all());
});
app.post('/api/admin/users', auth.requireRole('admin'), (req, res) => {
  try {
    const id = auth.createUser(req.body || {});
    audit(req.user.id, 'user_created', { id, email: req.body.email, role: req.body.role }, ip(req));
    res.status(201).json({ id });
  } catch (e) {
    bad(res, /UNIQUE/.test(e.message) ? 'A user with that email already exists.' : e.message);
  }
});
app.patch('/api/admin/users/:uid', auth.requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.uid));
  if (!u) return bad(res, 'User not found', 404);
  const { role, disabled, password } = req.body || {};
  if (u.id === req.user.id && (disabled || (role && role !== 'admin'))) return bad(res, 'You cannot remove your own admin access.');
  if (role !== undefined) { if (!auth.ROLE_RANK[role]) return bad(res, 'Invalid role'); db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id); }
  if (disabled !== undefined) {
    db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, u.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  }
  if (password !== undefined) {
    const err = auth.validatePassword(password); if (err) return bad(res, err);
    db.prepare('UPDATE users SET pw_hash=?, failed_logins=0, locked_until=0 WHERE id=?').run(auth.hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  }
  audit(req.user.id, 'user_updated', { id: u.id, role, disabled, passwordReset: password !== undefined }, ip(req));
  res.json({ ok: true });
});
app.get('/api/admin/audit', auth.requireRole('admin'), (_req, res) => {
  res.json(db.prepare(`SELECT a.ts,a.action,a.details,a.ip,u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 200`).all());
});

app.use('/api', (_req, res) => bad(res, 'Not found', 404));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Nothing on the website was changed.' });
});

// First start on a new server: create the first administrator from secrets (then they manage everyone in People).
function bootstrapAdmin() {
  const { ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_INITIAL_PASSWORD) return;
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  auth.createUser({ email: ADMIN_EMAIL, name: ADMIN_NAME || 'Administrator', role: 'admin', password: ADMIN_INITIAL_PASSWORD });
  audit(null, 'admin_bootstrapped', { email: ADMIN_EMAIL });
  console.log(`Created first administrator ${ADMIN_EMAIL}`);
}
function scheduleBackups() {
  if (!cfg.BACKUP_HOURS) return;
  const { backup } = require('../scripts/backup');
  const run = () => backup().then((r) => console.log('Backup OK', r.file)).catch((e) => console.error('BACKUP FAILED', e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, cfg.BACKUP_HOURS * 3600 * 1000).unref();
}

function start() {
  if (require.main === module) { bootstrapAdmin(); scheduleBackups(); }
  // Hosting: one port behind an HTTPS proxy, routed by hostname. The preview hostname must differ from the editor's,
  // so previewed site code can never read the editor's session (host-only cookies are not sent across hostnames).
  if (process.env.SINGLE_PORT) {
    const previewApp = createPreviewApp();
    const previewHost = new URL(cfg.PREVIEW_ORIGIN).host;
    if (previewHost === new URL(cfg.EDITOR_ORIGIN).host) throw new Error('PREVIEW_ORIGIN must use a different hostname from EDITOR_ORIGIN');
    const server = require('http').createServer((req, res) => (req.headers.host === previewHost ? previewApp(req, res) : app(req, res)));
    server.listen(Number(process.env.SINGLE_PORT), () => console.log(`Listening on ${process.env.SINGLE_PORT}: ${cfg.EDITOR_ORIGIN} + ${cfg.PREVIEW_ORIGIN}`));
    return { editor: server, preview: { close: () => {} } };
  }
  const editor = app.listen(cfg.EDITOR_PORT, () => console.log(`Editor:   ${cfg.EDITOR_ORIGIN}`));
  const preview = createPreviewApp().listen(cfg.PREVIEW_PORT, () => console.log(`Previews: ${cfg.PREVIEW_ORIGIN}`));
  return { editor, preview };
}

if (require.main === module) start();
module.exports = { app, start };
