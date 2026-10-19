'use strict';
// Browser test of the Stage 2 flow with a CONTROLLED MOCK AI: request → Generate Changes → progress → checked result,
// then reload to confirm the result stays linked to the request. No real AI is called.
const path = require('path');
const assert = require('node:assert/strict');
process.env.PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright';
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE)); }
const { boot } = require('./helpers');

(async () => {
  const T = boot();
  const prov = require('../src/ai/provider');
  const tool = (name, input) => ({ type: 'tool_use', name, input });
  prov.setTestProvider(() => prov.mockProvider([
    { content: [tool('edit_file', { path: 'lift.html', old_text: 'You’ve backed the ventures. <em', new_text: 'Your ventures are moving. <em' })] },
    { content: [tool('finish', { summary: 'Shortened the LIFT hero heading; the italic second line is unchanged.' })] },
  ]));
  T.auth.createUser({ email: 'maya@t.test', name: 'Maya', role: 'editor', password: 'correct-horse-battery' });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(T.E + '/login');
    await page.fill('input[name=email]', 'maya@t.test');
    await page.fill('input[name=password]', 'correct-horse-battery');
    await page.click('button[type=submit]');
    await page.waitForSelector('#page option', { state: 'attached' });
    await page.selectOption('#page', 'lift.html');
    const frame = page.frameLocator('#frame');
    await frame.locator('#h1').waitFor();
    await page.waitForTimeout(800);
    const fb = await page.locator('#frame').boundingBox();
    const scale = fb.width / (await page.$eval('#frame', (f) => f.offsetWidth));
    const r = await frame.locator('#h1').evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + 14, y: b.y + 14 }; });
    await page.mouse.click(fb.x + r.x * scale, fb.y + r.y * scale);
    await page.waitForSelector('#selection:not(.empty)');
    await page.check('#types input[value="text"]');
    await page.fill('#instruction', 'Make the LIFT hero heading shorter. Keep the italic second line.');
    await page.click('#generate');
    await page.waitForSelector('#gen .spin, #gen.ready', { timeout: 10000 });
    console.log('✓ Generate Changes saved the request and started generation (progress shown)');
    await page.waitForSelector('#gen.ready', { timeout: 120000 });
    const txt = await page.textContent('#gen');
    assert.match(txt, /Change generated and checked/);
    assert.match(txt, /test mode – not real AI/);
    assert.match(txt, /Shortened the LIFT hero heading/);
    assert.match(txt, /Affects: LIFT/);
    assert.ok((await page.locator('#gen .checks li.pass').count()) >= 8);
    assert.equal(await page.locator('#gen .checks li.fail').count(), 0);
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'stage2-generation-ready.png') });
    console.log('✓ Result shown: summary, affected page, all safety checks passed, labelled as test mode');
    const url = page.url();
    await page.goto('about:blank'); await page.goto(url);
    await page.waitForSelector('#gen.ready');
    console.log('✓ After reload, the generated result is still linked to the request');
    // Stage 3: compare before/after, desktop + mobile, scroll together, approve.
    await page.waitForSelector('#rv-panel .rv-items li');
    assert.match(await page.textContent('#rv-panel .rv-items'), /You’ve backed the ventures.*→.*Your ventures are moving/s);
    await page.click('#rv-open');
    await page.waitForSelector('#review:not([hidden])');
    const fa = page.frameLocator('#rv-a'); const fbF = page.frameLocator('#rv-b');
    await fa.locator('#h1').waitFor(); await fbF.locator('#h1').waitFor();
    assert.match(await fa.locator('#h1').textContent(), /You’ve backed the ventures/);
    assert.match(await fbF.locator('#h1').textContent(), /Your ventures are moving/);
    await page.waitForTimeout(800);
    assert.equal(await fbF.locator('[data-tse-sel]').count(), 1, 'selection outlined in After');
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'stage3-compare-desktop.png') });
    await page.frameLocator("#rv-a").locator("body").evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
    await page.waitForTimeout(700);
    const yB = await page.frameLocator("#rv-b").locator("body").evaluate(() => window.scrollY);
    assert.ok(Math.abs(yB - 1500) < 60, `scroll sync: after frame at ${yB}`);
    console.log('✓ Before/after shown side by side: old vs new heading, selection outlined, scrolling kept in step');
    await page.click('#rv-device [data-device="mobile"]');
    await page.waitForTimeout(500);
    assert.equal(await page.frameLocator('#rv-b').locator('body').evaluate(() => innerWidth), 390);
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'stage3-compare-mobile.png') });
    console.log('✓ Mobile comparison at 390px');
    page.once('dialog', (d) => d.accept());
    await page.click('#rv-panel [data-d="approve"]');
    await page.waitForSelector('#rv-panel .outcome:has-text("Approved by Maya")');
    assert.match(await page.textContent('#rv-panel'), /nothing has been published/);
    console.log('✓ Approved by the requester (page-only change); clearly marked as not published');
    await page.click('#rv-close');
    assert.deepEqual(errors, []);
    console.log('\nE2E-GENERATE PASSED');
  } catch (e) {
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'failure-gen.png') }).catch(() => {});
    console.error('E2E-GENERATE FAILED:', e.message.split('\n')[0], errors);
    process.exitCode = 1;
  } finally { await browser.close(); T.close(); prov.setTestProvider(null); }
})();
