'use strict';
const crypto = require('crypto');
const { db, audit } = require('./db');
const { SESSION_DAYS, SECURE_COOKIES, EDITOR_ORIGIN } = require('./config');

const COOKIE = 'tse_sid';
const ROLE_RANK = { viewer: 1, editor: 2, publisher: 3, admin: 4 };
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, n, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { ...SCRYPT, N: Number(n) });
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

// A dummy hash so that unknown emails take the same time as wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`,
    SECURE_COOKIES ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function login(email, password, ip) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  const now = Date.now();
  if (!user) {
    verifyPassword(String(password || ''), DUMMY_HASH);
    audit(null, 'login_failed', { email: String(email || '').slice(0, 200), reason: 'unknown' }, ip);
    return { error: 'Email or password is incorrect.' };
  }
  if (user.disabled) {
    audit(user.id, 'login_failed', { reason: 'disabled' }, ip);
    return { error: 'This account is disabled. Ask an administrator.' };
  }
  if (user.locked_until > now) {
    audit(user.id, 'login_failed', { reason: 'locked' }, ip);
    return { error: 'Too many attempts. Try again in 15 minutes.' };
  }
  if (!verifyPassword(String(password || ''), user.pw_hash)) {
    const fails = user.failed_logins + 1;
    const lock = fails >= MAX_FAILS ? now + LOCK_MS : 0;
    db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(lock ? 0 : fails, lock, user.id);
    audit(user.id, 'login_failed', { reason: 'password', locked: !!lock }, ip);
    return { error: 'Email or password is incorrect.' };
  }
  db.prepare('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?').run(user.id);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(sha256(token), user.id, now + SESSION_DAYS * 864e5, now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  audit(user.id, 'login', {}, ip);
  return { token, user };
}

function logout(req) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(t));
}

// Attaches req.user when a valid session cookie is present.
function sessionMiddleware(req, _res, next) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) {
    const row = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.disabled,s.expires_at FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha256(t));
    if (row && row.expires_at > Date.now() && !row.disabled) req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
  }
  next();
}

// CSRF defence for state-changing requests: SameSite=Strict cookie + exact Origin match + custom header.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.origin !== EDITOR_ORIGIN || req.headers['x-requested-with'] !== 'editor') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
}

const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) return res.status(403).json({ error: 'You do not have permission for this.' });
  next();
};

function createUser({ email, name, role, password }) {
  if (!ROLE_RANK[role]) throw new Error('Invalid role');
  const err = validatePassword(password);
  if (err) throw new Error(err);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Invalid email');
  return db.prepare('INSERT INTO users (email,name,role,pw_hash,created_at) VALUES (?,?,?,?,?)')
    .run(email.trim(), String(name || email).trim().slice(0, 100), role, hashPassword(password), Date.now()).lastInsertRowid;
}

module.exports = {
  COOKIE, ROLE_RANK, cookieHeader, login, logout, sessionMiddleware, csrfGuard, requireRole,
  createUser, hashPassword, validatePassword,
};
