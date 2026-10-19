'use strict';
// Read-only access to each registered website's GitHub repository.
// Files are read from git objects by commit SHA, so every preview is pinned to an exact,
// immutable version and nothing here can ever write to the repository or the live site.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { SITES, REPO_DIR } = require('./config');
const { db } = require('./db');

const run = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
const SHA_RE = /^[0-9a-f]{40}$/;
const PATH_RE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\-/]{1,200}$/;

const getSite = (id) => SITES.find((s) => s.id === id) || null;
const repoPath = (site) => path.join(REPO_DIR, `${site.id}.git`);

async function git(site, args, opts = {}) {
  const { stdout } = await run('git', args, {
    cwd: repoPath(site), env: GIT_ENV, maxBuffer: 50 * 1024 * 1024, encoding: opts.encoding || 'utf8', timeout: 60000,
  });
  return stdout;
}

// Fetch the latest published version (read-only, public clone). Returns the commit SHA.
async function syncSite(site) {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  const dir = repoPath(site);
  if (!fs.existsSync(dir)) {
    await run('git', ['clone', '--bare', '--depth', '50', '--branch', site.branch, '--', site.repo, dir], { env: GIT_ENV, timeout: 120000 });
  } else {
    await git(site, ['fetch', '--depth', '50', 'origin', `+refs/heads/${site.branch}:refs/heads/${site.branch}`]);
  }
  const sha = (await git(site, ['rev-parse', `refs/heads/${site.branch}`])).trim();
  db.prepare(`INSERT INTO site_versions (site_id,sha,fetched_at) VALUES (?,?,?)
    ON CONFLICT(site_id) DO UPDATE SET sha=excluded.sha, fetched_at=excluded.fetched_at`).run(site.id, sha, Date.now());
  registryCache.clear();
  return sha;
}

// Latest published version; re-checked against GitHub at most every 5 minutes (falls back to the cached one offline).
async function currentSha(site) {
  const row = db.prepare('SELECT sha, fetched_at FROM site_versions WHERE site_id=?').get(site.id);
  if (!row) return syncSite(site);
  if (Date.now() - row.fetched_at > 5 * 60 * 1000) { try { return await syncSite(site); } catch { /* keep cached */ } }
  return row.sha;
}

const fileCache = new Map();
async function readFile(site, sha, filePath) {
  if (!SHA_RE.test(sha) || !PATH_RE.test(filePath)) return null;
  const key = `${site.id}:${sha}:${filePath}`;
  if (fileCache.has(key)) return fileCache.get(key);
  let buf;
  try { buf = await git(site, ['cat-file', 'blob', `${sha}:${filePath}`], { encoding: 'buffer' }); } catch { return null; }
  if (fileCache.size > 500) fileCache.clear();
  fileCache.set(key, buf);
  return buf;
}

async function listFiles(site, sha) {
  if (!SHA_RE.test(sha)) return [];
  return (await git(site, ['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean);
}

function globToRegex(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
}
const isAllowedPath = (site, p) => site.allowedPaths.some((g) => globToRegex(g).test(p));

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Derive pages, sections and shared areas (navigation, footer, menus…) directly from the HTML,
// so the registry never drifts from the site and works for any configured website.
const SKIP_TAGS = new Set(['main', 'script', 'style', 'noscript', 'template', 'link', 'meta']);
const areaKey = (tag, id, cls) => `shared:${tag}${id ? '#' + id : ''}${(cls || '').trim() ? '.' + cls.trim().split(/\s+/).join('.') : ''}`;

function sharedName($, $el) {
  const tag = $el[0].tagName;
  const label = clean($el.attr('aria-label'));
  const text = clip(clean($el.text()), 40);
  if (tag === 'header') return 'Header & navigation';
  if (tag === 'footer') return 'Footer';
  if (tag === 'nav') return label || 'Navigation';
  if ($el.attr('role') === 'dialog' || $el.attr('hidden') !== undefined) return `${label || 'Pop-up'} panel (opens on click)`;
  if (tag === 'a' && /^#/.test($el.attr('href') || '') && /skip/i.test(text)) return 'Skip-to-content link (keyboard users)';
  if (tag === 'a' || tag === 'button') return `Floating ${tag === 'a' ? 'link' : 'button'}${label || text ? `: “${clip(label || text, 40)}”` : ''}`;
  return label || `${tag} block`;
}

const registryCache = new Map();
async function getRegistry(site, sha) {
  const key = `${site.id}:${sha}`;
  if (registryCache.has(key)) return registryCache.get(key);
  const files = (await listFiles(site, sha)).filter((f) => f.endsWith('.html') && !(site.excludePages || []).includes(f));
  const pages = [];
  for (const file of files) {
    const html = (await readFile(site, sha, file)).toString('utf8');
    const $ = cheerio.load(html);
    const sections = [];
    $(site.sectionSelector).each((i, el) => {
      const $el = $(el);
      const labelledby = $el.attr('aria-labelledby');
      const heading = clean((labelledby && $(`#${labelledby}`).first().text()) || $el.find('h1,h2,h3').first().text()
        || $el.attr('aria-label') || $el.find('p,blockquote').first().text());
      const label = site.labelSelector ? clean($el.find(site.labelSelector).first().text()) : '';
      sections.push({
        index: i,
        // Stable identity: element id, else its labelling heading id, else a content fingerprint (never a bare position).
        key: $el.attr('id') ? `id:${$el.attr('id')}` : labelledby ? `aria:${labelledby}`
          : `fp:${crypto.createHash('sha1').update(`${$el.attr('class') || ''}|${clean($el.text()).slice(0, 160)}`).digest('hex').slice(0, 10)}`,
        name: i === 0 ? 'Top of page (hero)' : clip(label || heading || `Section ${i + 1}`, 48),
        heading: clip(heading, 90),
        selector: `${site.sectionSelector}:nth-of-type(${i + 1})`,
      });
    });
    const seen = {};
    sections.forEach((s) => { seen[s.key] = (seen[s.key] || 0) + 1; if (seen[s.key] > 1) s.key += `~${seen[s.key]}`; });
    // Areas outside the main content (header, menus, footer, floating buttons).
    const outer = [];
    const tagCount = {};
    $('body').children().each((_i, el) => {
      const tag = el.tagName;
      tagCount[tag] = (tagCount[tag] || 0) + 1;
      if (SKIP_TAGS.has(tag)) return;
      const $el = $(el);
      outer.push({ key: areaKey(tag, $el.attr('id'), $el.attr('class')), name: sharedName($, $el), selector: `body > ${tag}:nth-of-type(${tagCount[tag]})` });
    });
    pages.push({ path: file, rawTitle: clean($('title').text()), html, sections, outer });
  }
  // Mark areas that appear on more than one page as shared.
  const counts = {};
  pages.forEach((p) => new Set(p.outer.map((o) => o.key)).forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
  // Generic page titles: drop a suffix common to every title (e.g. " · Site name").
  const suffix = (() => {
    const m = pages.map((p) => (p.rawTitle.match(/\s[·|–-]\s[^·|–-]+$/) || [''])[0]);
    const freq = {}; m.forEach((x) => { if (x) freq[x] = (freq[x] || 0) + 1; });
    const best = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    return best && freq[best] >= Math.max(2, pages.length / 2) ? best : '';
  })();
  // Generic order: home first, then the order pages are linked from the home page, then alphabetical; error pages last.
  const home = pages.find((p) => p.path === 'index.html');
  const pos = (p) => (p.path === 'index.html' ? -1 : /^\d{3}\.html$/.test(p.path) ? 1e9 : home && home.html.indexOf(`href="${p.path}`) >= 0 ? home.html.indexOf(`href="${p.path}`) : 1e8);
  pages.sort((a, b) => pos(a) - pos(b) || a.path.localeCompare(b.path));
  const out = pages.map((p) => ({
    path: p.path,
    title: p.path === 'index.html' ? 'Home' : /^\d{3}\.html$/.test(p.path) ? `Error page (${p.path.slice(0, 3)})` : (suffix && p.rawTitle.endsWith(suffix) ? p.rawTitle.slice(0, -suffix.length) : p.rawTitle) || p.path,
    sections: p.sections,
    shared: p.outer.map((o) => ({ ...o, pageCount: counts[o.key], shared: counts[o.key] > 1 })),
  }));
  const reg = { sha, pages: out, pageCount: out.length };
  registryCache.set(key, reg);
  return reg;
}

// Checks that a CSS selector picked in the preview matches exactly one element on the page at that version,
// and (optionally) that it lies inside the given area.
async function validateSelector(site, sha, page, selector, withinSelector) {
  if (typeof selector !== 'string' || selector.length > 400) return false;
  const html = await readFile(site, sha, page);
  if (!html) return false;
  try {
    const $ = cheerio.load(html.toString('utf8'));
    const el = $(selector);
    if (el.length !== 1) return false;
    if (!withinSelector) return true;
    const area = $(withinSelector);
    return area.length === 1 && (area[0] === el[0] || area.find(el).length === 1);
  } catch { return false; }
}

// For each element in a picked chain, confirm it exists in the page's source (not created later by scripts) and is
// the same element the user clicked (tag + text/image source match). Returns one boolean per item.
async function resolveChain(site, sha, page, areaSelector, chain) {
  const html = await readFile(site, sha, page);
  if (!html || !Array.isArray(chain) || chain.length > 10) return null;
  const $ = cheerio.load(html.toString('utf8'));
  let area;
  try { area = $(areaSelector); } catch { return null; }
  if (area.length !== 1) return null;
  return chain.map((c) => {
    if (!c || typeof c.selector !== 'string' || c.selector.length > 400) return false;
    let el;
    try { el = $(c.selector); } catch { return false; }
    if (el.length !== 1 || !(el[0] === area[0] || area.find(el).length === 1)) return false;
    const g = c.sig || {};
    if (g.tag && el[0].tagName !== g.tag) return false;
    if (g.src) return (el.attr('src') || '') === g.src;
    return clean(el.text()).slice(0, 80) === clean(g.text || '');
  });
}

module.exports = { resolveChain,  SHA_RE, getSite, syncSite, currentSha, readFile, listFiles, isAllowedPath, getRegistry, validateSelector };
