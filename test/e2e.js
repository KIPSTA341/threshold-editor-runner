'use strict';
// End-to-end check through the real UI in Chromium, across EVERY page of the configured site:
// representative text, images, buttons, cards, backgrounds, shared navigation/menu/footer, design-change requests,
// protections, images — then every request is reopened after a browser reload and verified field by field.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const { boot } = require('./helpers');

const OUT = path.join(__dirname, '..', 'test-results');
const PW = 'correct-horse-battery';
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
const step = (s) => console.log('✓', s);

// Representative selections covering every page and every element family. `click` is a selector inside the preview.
const CASES = [
  { page: 'index.html', click: '#hero h1', expect: /^Heading/, area: /Top of page/, types: ['text'], text: 'Make the homepage headline shorter.' },
  { page: 'lift.html', click: '#h1', expect: /^Heading/, area: /Top of page/, types: ['text', 'typography'], text: 'Adjust the LIFT hero heading: shorter, keep the italic second line.',
    protect: '#main > section:nth-of-type(1) .kicker', image: 'reference', screenshot: 'lift-hero-heading' },
  { page: 'build.html', click: '#main img', expect: /^Image/, types: ['image'], text: 'Replace this photo with the attached one.', image: 'use' },
  { page: 'standard.html', click: '#main > section:nth-of-type(2) li span', expect: /^Label/, types: ['spacing', 'layout'], devices: 'mobile', text: 'More space between these paragraphs on phones.' },
  { page: 'team.html', click: '#main img', expect: /^Image/, widen: 1, types: ['add'], placement: 'after', text: 'Add a short quote under this team member card.', screenshot: 'team-card-widened' },
  { page: 'begin.html', click: '#main a.btn', expect: /^Button/, types: ['colour', 'link'], text: 'Make this button gold and link to the LIFT form.' },
  { page: '404.html', click: '#main > section:nth-of-type(1)', at: 'br', expect: /^(Background animation|Whole section|Block)/, types: ['animation'], text: 'Slow down this background animation.' },
  { page: 'lift.html', click: '#nav .nav-links a', expect: /^Link/, area: /Header & navigation/, shared: true, types: ['typography', 'colour'], text: 'Make the navigation links slightly larger.', screenshot: 'shared-nav-approval' },
  { page: 'team.html', click: 'footer .foot-g a', expect: /^Link/, area: /Footer/, shared: true, types: ['text', 'link'], text: 'Add the LinkedIn page to the footer links.' },
  { page: 'build.html', menu: true, click: '#sheet ol a', expect: /^(Link|Label)/, area: /Menu panel/, shared: true, types: ['remove'], text: 'Remove the Team item from the mobile menu.' },
  { page: 'standard.html', listIndex: 3, expect: /^Whole section/, types: ['layout', 'responsive'], text: 'Turn this section into two columns on desktop.' },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'reference.png'), PNG);
  const T = boot();
  T.auth.createUser({ email: 'maya@t.test', name: 'Maya', role: 'editor', password: PW });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|status of 40[01]/.test(m.text())) errors.push(`console: ${m.text()}`); });
  const frame = page.frameLocator('#frame');

  const previewFrame = () => page.frames().find((f) => f.url().includes('/p/'));
  async function waitPreview(file) {
    await page.waitForFunction((f) => { const fr = document.querySelector('#frame'); return fr && fr.src.endsWith('/' + f); }, file);
    for (let i = 0; i < 40; i++) { const pf = previewFrame(); if (pf && pf.url().endsWith('/' + file)) break; await page.waitForTimeout(100); }
    await previewFrame().waitForLoadState('load');
    await page.waitForTimeout(600);
  }
  // Real mouse click at the element's on-screen position (the preview is scaled to fit, exactly as users see it).
  async function clickIn(sel, at) {
    const loc = frame.locator(sel).first();
    await loc.evaluate((el) => { const r = el.getBoundingClientRect(); window.scrollTo({ top: Math.max(0, r.top + scrollY - innerHeight / 2), behavior: 'instant' }); });
    await page.waitForTimeout(300);
    const fb = await page.locator('#frame').boundingBox();
    const scale = fb.width / (await page.$eval('#frame', (f) => f.offsetWidth));
    const r = await loc.evaluate((el, at) => { const b = el.getBoundingClientRect(); return at === 'br' ? { x: b.right - 60, y: Math.min(b.bottom, innerHeight) - 60 } : { x: b.x + Math.min(b.width / 2, 14), y: b.y + Math.min(b.height / 2, 14) }; }, at);
    if (process.env.DEBUG) console.log('  click', sel, r, scale, await loc.evaluate((el, p) => { const e = document.elementFromPoint(p.x, p.y); return e && e.outerHTML.slice(0, 80); }, r), await page.evaluate(() => S.mode));
    await page.mouse.move(fb.x + r.x * scale, fb.y + r.y * scale);
    await page.mouse.click(fb.x + r.x * scale, fb.y + r.y * scale);
  }
  async function setDevice(d) { await page.click(`#device [data-device="${d}"]`); await page.waitForTimeout(400); }

  const saved = [];
  try {
    await page.goto(T.E + '/login');
    await page.fill('input[name=email]', 'maya@t.test');
    await page.fill('input[name=password]', PW);
    await page.click('button[type=submit]');
    await page.waitForSelector('#who:has-text("Maya")');
    await page.waitForSelector('#page option', { state: 'attached' });
    const pageTitles = await page.$$eval('#page option', (o) => o.map((x) => x.textContent));
    assert.deepEqual(pageTitles, ['Home', 'LIFT', 'BUILD', 'The Standard', 'Team', 'Begin', 'Error page (404)']);
    step(`Signed in; all ${pageTitles.length} pages listed: ${pageTitles.join(', ')}`);

    for (const [n, c] of CASES.entries()) {
      if (await page.isVisible('#new-req')) { await page.click('#new-req'); await page.waitForTimeout(400); }
      await page.selectOption('#page', c.page);
      await waitPreview(c.page);
      if (c.menu) {
        await setDevice('mobile');
        await page.click('#mode [data-mode="off"]');
        await clickIn('#menuB');
        await frame.locator('#sheet:not([hidden])').waitFor();
        await page.click('#mode [data-mode="change"]');
      }
      if (c.listIndex !== undefined) {
        await page.click('#areas-box summary');
        await page.locator('#sections .choice').nth(c.listIndex).click();
      } else {
        await clickIn(c.click, c.at);
      }
      await page.waitForSelector('#selection:not(.empty)');
      if (c.widen) await page.locator('#scope input').nth(c.widen).check();
      const selText = (await page.textContent('#selection')).replace(/\s+/g, ' ');
      const firstLine = (await page.textContent('#selection b')).trim();
      if (!c.widen) assert.match(firstLine, c.expect, `case ${n}: ${firstLine}`);
      if (c.area) assert.match(selText, c.area, `case ${n} area: ${selText}`);
      if (c.shared) assert.match(selText, /shared · all 7 pages/);
      assert.equal(await previewFrame().locator('[data-tse-sel]').count(), 1, `case ${n}: preview outline`);
      for (const t of c.types) await page.check(`#types input[value="${t}"]`);
      if (c.placement) await page.selectOption('#placement', c.placement);
      if (c.devices) await page.click(`#devices [data-v="${c.devices}"]`);
      await page.fill('#instruction', c.text);
      if (c.protect) {
        await page.click('#pick-items');
        await clickIn(c.protect);
        await page.waitForSelector('#protect-items li');
        await page.click('#mode [data-mode="change"]');
      }
      if (c.image) {
        await page.setInputFiles('#files', path.join(OUT, 'reference.png'));
        await page.selectOption('#thumbs select', c.image);
      }
      await page.click('#save');
      if (c.shared) {
        await page.waitForSelector('#form-err:has-text("appears on 7 pages")');
        if (c.screenshot) await page.screenshot({ path: path.join(OUT, `${c.screenshot}.png`) });
        await page.check('#allow-shared');
        await page.click('#save');
      } else if (c.screenshot) await page.screenshot({ path: path.join(OUT, `${c.screenshot}.png`) });
      await page.waitForSelector('#form-ok:has-text("Draft saved")');
      const id = Number(page.url().match(/request=(\d+)/)[1]);
      saved.push({ id, c, firstLine });
      if (c.menu) { await page.screenshot({ path: path.join(OUT, 'menu-panel-mobile.png') }); await setDevice('desktop'); }
      step(`${c.page.padEnd(14)} → ${firstLine.slice(0, 58)}${c.widen ? ' (widened)' : ''}${c.shared ? '  [shared: approval demanded, then given]' : ''} · ${c.types.join(', ')}`);
    }

    // Reopen every request after a full reload and compare.
    for (const s of saved) {
      await page.goto('about:blank');
      await page.goto(`${T.E}/#request=${s.id}`);
      await page.waitForSelector('#selection:not(.empty)');
      await waitPreview(s.c.page);
      assert.equal(await page.inputValue('#page'), s.c.page);
      assert.equal((await page.textContent('#selection b')).trim(), s.firstLine, `reopen ${s.id}`);
      assert.equal(await page.inputValue('#instruction'), s.c.text);
      assert.deepEqual(await page.$$eval('#types input:checked', (i) => i.map((x) => x.value)).then((v) => v.sort()), [...s.c.types].sort());
      assert.equal(await page.getAttribute('#devices button.on', 'data-v'), s.c.devices || 'all');
      if (s.c.placement) assert.equal(await page.inputValue('#placement'), s.c.placement);
      assert.equal(await page.isChecked('#allow-shared'), !!s.c.shared);
      assert.equal(await page.locator('#protect-items li').count(), s.c.protect ? 1 : 0);
      if (s.c.image) { await page.waitForSelector('#thumbs li img'); assert.equal(await page.inputValue('#thumbs select'), s.c.image); }
      if (!s.c.menu) assert.equal(await previewFrame().locator('[data-tse-sel]').count(), 1, `reopen ${s.id} outline`);
      if (s.c.protect) assert.equal(await previewFrame().locator('[data-tse-prot]').count(), 1, `reopen ${s.id} protection outline`);
    }
    step(`Reopened all ${saved.length} requests after a browser reload: page, selection, scope, change types, screens, placement, protections, approvals and images intact`);

    await page.click('[data-view="list"]');
    await page.waitForSelector('#req-rows tr[data-id]');
    assert.equal(await page.locator('#req-rows tr[data-id]').count(), saved.length);
    await page.screenshot({ path: path.join(OUT, 'requests-list.png') });
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop + document.body.scrollTop + document.querySelector('main').scrollTop), 0, 'editor shell scrolled');

    for (const p of ['index.html', 'lift.html', 'build.html', 'standard.html', 'team.html', 'begin.html', '404.html']) {
      await page.click('#new-req').catch(() => page.click('[data-view="edit"]'));
      await page.click('[data-view="edit"]');
      await page.selectOption('#page', p);
      await waitPreview(p);
      await setDevice('mobile');
      const [w, sw] = await previewFrame().evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
      assert.equal(w, 390); assert.ok(sw <= 390, `${p} overflows on mobile: ${sw}`);
      await setDevice('desktop');
    }
    step('All 7 pages render in the 390px mobile preview with no horizontal overflow');

    assert.deepEqual(errors, [], 'errors');
    step('No JavaScript errors in editor or preview');
    console.log('\nE2E PASSED');
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
    console.error('\nE2E FAILED:', await page.textContent('#sel-note').catch(() => ''), e.message.split('\n').slice(0, 12).join('\n'), '\nerrors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    T.close();
  }
})();
