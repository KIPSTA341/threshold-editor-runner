'use strict';
// Rendered check: loads the original and generated versions in a headless browser (desktop + mobile) through the
// preview server and compares JavaScript errors, page areas and protected items. Read-only; nothing is published.
const { makePreviewUrl } = require('../preview');

function loadPlaywright() {
  for (const m of ['playwright', process.env.PLAYWRIGHT_MODULE].filter(Boolean)) {
    try { return require(m); } catch { /* try next */ }
  }
  return null;
}

const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }];

// Runs in the page: one signature per area (each section + each part outside <main>) and per protected selector.
function collect({ sectionSelector, protectedSelectors }) {
  const PROPS = ['display', 'position', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-transform', 'text-align', 'color', 'background-color', 'background-image', 'margin', 'padding', 'border',
    'grid-template-columns', 'flex-direction', 'gap', 'width', 'visibility', 'animation-name', 'transition-property'];
  const sigOf = (root) => {
    if (!root) return null;
    const els = [root, ...root.querySelectorAll('*')].slice(0, 600);
    let h = 0;
    const s = els.map((e) => { const cs = getComputedStyle(e); return e.tagName + PROPS.map((p) => cs.getPropertyValue(p)).join('|') + (e.children.length ? '' : (e.textContent || '').trim().slice(0, 80)); }).join('\n');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const r = root.getBoundingClientRect();
    return { hash: h, w: Math.round(r.width), h: Math.round(r.height / 2) * 2 };
  };
  const sections = [...document.querySelectorAll(sectionSelector)].map(sigOf);
  const main = document.querySelector('main');
  const outside = [...document.body.children].filter((e) => e !== main && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)).map(sigOf);
  const prot = protectedSelectors.map((s) => { try { return sigOf(document.querySelector(s)); } catch { return null; } });
  return { sections, outside, prot, scrollWidth: document.documentElement.scrollWidth, innerWidth };
}

async function snapshot(browser, url, vp, opts) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort()); // no third-party requests from previews
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  // Scroll through once so scroll-triggered reveals settle identically in both versions.
  await page.evaluate(async () => {
    const step = innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(400);
  const data = await page.evaluate(collect, opts);
  await ctx.close();
  return { ...data, errors };
}

const same = (a, b) => !!a && !!b && a.hash === b.hash && a.w === b.w && a.h === b.h;

/**
 * jobs: [{ path, title, sections:[names], outsideNames:[names], allowed:{ sectionIndex|null, outsideIndex|null }, protectedSelectors, protectedLabels }]
 * Returns { checks, flagged }
 */
async function renderCheck({ site, baseSha, newSha, jobs, sharedPermitted }) {
  const pw = loadPlaywright();
  if (!pw) return { checks: [{ id: 'render', label: 'Rendered on desktop and mobile', status: 'fail', detail: 'The visual and behaviour check is unavailable on this server (Playwright not installed).' }], flagged: [] };
  const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const checks = []; const flagged = []; const unstable = []; const jsErrors = []; const protLost = []; const overflow = []; const leaks = [];
  try {
    for (const job of jobs) {
      for (const vp of VIEWPORTS) {
        const opts = { sectionSelector: site.sectionSelector, protectedSelectors: job.protectedSelectors };
        const a = await snapshot(browser, makePreviewUrl(site.id, baseSha, job.path), vp, opts);
        const a2 = await snapshot(browser, makePreviewUrl(site.id, baseSha, job.path), vp, opts);
        const b = await snapshot(browser, makePreviewUrl(site.id, newSha, job.path), vp, opts);
        // Areas that differ between two renders of the ORIGINAL are animated/time-dependent: they cannot be compared
        // automatically, so they are listed for manual review instead of being assumed safe.
        const unstableS = new Set(a.sections.map((x, k) => (same(x, a2.sections[k]) ? -1 : k)).filter((k) => k >= 0));
        const unstableO = new Set(a.outside.map((x, k) => (same(x, a2.outside[k]) ? -1 : k)).filter((k) => k >= 0));
        unstableS.forEach((k) => unstable.push(`${job.title} → ${job.sections[k] || `section ${k + 1}`} (${vp.name})`));
        unstableO.forEach((k) => unstable.push(`${job.title} → ${job.outsideNames[k] || `area ${k + 1}`} (${vp.name})`));
        b.errors.filter((e) => !a.errors.includes(e)).forEach((e) => jsErrors.push(`${job.title} (${vp.name}): ${e}`));
        if (b.scrollWidth > b.innerWidth + 1 && a.scrollWidth <= a.innerWidth + 1) overflow.push(`${job.title} (${vp.name})`);
        a.prot.forEach((s, k) => { if (s && same(s, a2.prot[k]) && !same(s, b.prot[k])) protLost.push(`${job.protectedLabels[k]} (${vp.name})`); });
        // Areas outside the main content: compared by position.
        a.outside.forEach((s, k) => {
          if (k === job.allowed.outsideIndex || unstableO.has(k)) return;
          if (!same(s, b.outside[k])) leaks.push({ page: job.title, area: job.outsideNames[k] || `area ${k + 1}`, vp: vp.name });
        });
        // Sections: align by unchanged prefix/suffix, so an added or removed section next to the selection is tolerated.
        const A = a.sections; const B = b.sections;
        const eq = (x, y, k) => same(x, y) || unstableS.has(k);
        let pre = 0; while (pre < A.length && pre < B.length && eq(A[pre], B[pre], pre)) pre++;
        let suf = 0; while (suf < A.length - pre && suf < B.length - pre && eq(A[A.length - 1 - suf], B[B.length - 1 - suf], A.length - 1 - suf)) suf++;
        for (let k = pre; k < A.length - suf; k++) if (k !== job.allowed.sectionIndex && !unstableS.has(k)) leaks.push({ page: job.title, area: job.sections[k] || `section ${k + 1}`, vp: vp.name });
      }
    }
  } finally { await browser.close(); }
  const uniq = (arr) => [...new Set(arr)];
  checks.push({ id: 'js', label: 'No new JavaScript errors', status: jsErrors.length ? 'fail' : 'pass', detail: uniq(jsErrors).slice(0, 5).join('; ') });
  checks.push({ id: 'render-protected', label: 'Protected items look the same', status: protLost.length ? 'fail' : 'pass', detail: uniq(protLost).join('; ') });
  checks.push({ id: 'overflow', label: 'No sideways scrolling introduced', status: overflow.length ? 'fail' : 'pass', detail: overflow.join('; ') });
  const leakNames = uniq(leaks.map((l) => `${l.page} → ${l.area} (${l.vp})`));
  leaks.forEach((l) => { if (!flagged.some((f) => f.page === l.page && f.area === l.area)) flagged.push({ page: l.page, area: l.area }); });
  checks.push({
    id: 'render-scope', label: 'Rest of the website looks the same (desktop + mobile)',
    status: !leaks.length ? 'pass' : sharedPermitted ? 'warn' : 'fail',
    detail: leaks.length ? `${sharedPermitted ? 'Also changed (review before publishing)' : 'Changed outside the selection'}: ${leakNames.slice(0, 10).join('; ')}${leakNames.length > 10 ? '…' : ''}` : '',
  });
  if (unstable.length) {
    checks.push({ id: 'render-unstable', label: 'Animated areas need a visual check', status: 'warn',
      detail: `These areas move or change on their own, so they were not compared automatically: ${uniq(unstable).slice(0, 8).join('; ')}` });
  }
  return { checks, flagged };
}

module.exports = { renderCheck, loadPlaywright };
