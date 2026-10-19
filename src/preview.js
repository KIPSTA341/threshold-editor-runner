'use strict';
// Preview server: serves real repository files at an exact commit, on a SEPARATE origin from the editor.
// Access requires a short-lived HMAC-signed token in the path. No cookies, no write paths.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { PREVIEW_SECRET, PREVIEW_TOKEN_MINUTES, EDITOR_ORIGIN, PREVIEW_ORIGIN, ROOT } = require('./config');
const sites = require('./sites');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

const sign = (siteId, sha, exp) => crypto.createHmac('sha256', PREVIEW_SECRET).update(`${siteId}:${sha}:${exp}`).digest('base64url');

function makePreviewUrl(siteId, sha, page) {
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_MINUTES * 60;
  return `${PREVIEW_ORIGIN}/p/${exp}.${sign(siteId, sha, exp)}/${siteId}/${sha}/${page}`;
}

function verifyToken(token, siteId, sha) {
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(siteId, sha, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const overlayJs = fs.readFileSync(path.join(ROOT, 'preview-overlay', 'overlay.js'), 'utf8');

function createPreviewApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': `frame-ancestors ${EDITOR_ORIGIN}`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    next();
  });

  app.get('/__editor/overlay.js', (_req, res) => {
    res.type('text/javascript').set('Cache-Control', 'no-cache').send(overlayJs);
  });

  app.get('/p/:token/:site/:sha/*?', async (req, res) => {
    const { token, sha } = req.params;
    const site = sites.getSite(req.params.site);
    if (!site || !sites.SHA_RE.test(sha) || !verifyToken(token, site.id, sha)) {
      return res.status(403).type('text/plain').send('This preview link has expired. Reload the editor.');
    }
    const filePath = req.params[0] || 'index.html';
    const buf = await sites.readFile(site, sha, filePath);
    if (!buf) return res.status(404).type('text/plain').send('Not found');
    const ext = path.extname(filePath).toLowerCase();
    res.set('Cache-Control', 'private, max-age=300');
    res.type(TYPES[ext] || 'application/octet-stream');
    if (ext === '.html') {
      const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const tag = `<script src="/__editor/overlay.js" data-editor-origin="${attr(EDITOR_ORIGIN)}" data-section-selector="${attr(site.sectionSelector)}"></script>`;
      const html = buf.toString('utf8');
      return res.send(html.includes('</body>') ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag);
    }
    res.send(buf);
  });

  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  return app;
}

module.exports = { createPreviewApp, makePreviewUrl, verifyToken };
