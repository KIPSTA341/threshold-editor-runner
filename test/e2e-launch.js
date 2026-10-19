'use strict';
// FULL WORKFLOW through the real UI in Chromium:
// Log in → Threshold (TEST copy) → LIFT → Hero → heading request → Generate Changes → compare → Approve → Publish
// → verify the published website → Restore previous version. Then a shared footer change on another page.
// Uses CONTROLLED STAND-INS for the AI (scripted) and for GitHub/GitHub Pages (local). Not a real-service test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
process.env.PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright';
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE)); }
const { createFake } = require('./fakegithub');
const step = (s) => console.log('✓', s);

(async () => {
  const F = await createFake({ sourceRepo: '/home/claude/threshold-src', deployDelayMs: 3000 });
  const sitesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sites-')), 'sites.json');
  const sitesCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
  sitesCfg[0].repo = '/home/claude/threshold-src';
  Object.assign(sitesCfg[1], { repo: `${F.pushBase}/${F.owner}/${F.repo}.git`, githubRepo: `${F.owner}/${F.repo}`, pagesUrl: F.pagesUrl, liveUrl: F.pagesUrl });
  fs.writeFileSync(sitesFile, JSON.stringify(sitesCfg));
  Object.assign(process.env, { SITES_FILE: sitesFile, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: F.privateKey, GITHUB_API_URL: F.apiUrl,
    GITHUB_PUSH_BASE: F.pushBase, DEPLOY_POLL_SEC: '1', DEPLOY_TIMEOUT_SEC: '40' });
  const T = require('./helpers').boot();
  const prov = require('../src/ai/provider');
  const tool = (name, input) => ({ type: 'tool_use', name, input });
  let script = [];
  prov.setTestProvider(() => prov.mockProvider(script));
  T.auth.createUser({ email: 'pia@t.test', name: 'Pia', role: 'publisher', password: 'correct-horse-battery' });

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('dialog', (d) => d.accept());
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const frame = page.frameLocator('#frame');
  async function clickIn(sel) {
    const loc = frame.locator(sel).first();
    await loc.evaluate((el) => { const r = el.getBoundingClientRect(); window.scrollTo({ top: Math.max(0, r.top + scrollY - innerHeight / 2), behavior: 'instant' }); });
    await page.waitForTimeout(300);
    const fb = await page.locator('#frame').boundingBox();
    const scale = fb.width / (await page.$eval('#frame', (f) => f.offsetWidth));
    const r = await loc.evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 14), y: b.y + Math.min(b.height / 2, 10) }; });
    await page.mouse.click(fb.x + r.x * scale, fb.y + r.y * scale);
  }
  const live = async (f) => (await fetch(`${F.pagesUrl}${f}`)).text();
  try {
    await page.goto(T.E + '/login');
    await page.fill('input[name=email]', 'pia@t.test');
    await page.fill('input[name=password]', 'correct-horse-battery');
    await page.click('button[type=submit]');
    await page.waitForSelector('#page option', { state: 'attached' });
    await page.selectOption('#site', 'threshold-test');
    await page.waitForFunction(() => document.querySelector('#frame').src.includes('/threshold-test/'));
    step('Logged in; selected Threshold (TEST copy)');

    await page.selectOption('#page', 'lift.html');
    await frame.locator('#h1').waitFor(); await page.waitForTimeout(800);
    await clickIn('#h1');
    await page.waitForSelector('#selection:has-text("Heading")');
    await page.check('#types input[value="text"]');
    await page.fill('#instruction', 'Make the LIFT hero heading shorter. Keep the italic second line.');
    script = [{ content: [tool('edit_file', { path: 'lift.html', old_text: 'You’ve backed the ventures. <em', new_text: 'Your ventures are moving. <em' })] },
      { content: [tool('finish', { summary: 'Shortened the LIFT hero heading; the italic line is unchanged.' })] }];
    await page.click('#generate');
    await page.waitForSelector('#gen.ready', { timeout: 120000 });
    assert.equal(await page.locator('#gen .checks li.fail').count(), 0);
    step('LIFT → Hero heading requested; Generate Changes produced a checked version');

    await page.click('#rv-open');
    await page.frameLocator('#rv-b').locator('#h1').waitFor();
    assert.match(await page.frameLocator('#rv-a').locator('#h1').textContent(), /You’ve backed/);
    assert.match(await page.frameLocator('#rv-b').locator('#h1').textContent(), /Your ventures are moving/);
    await page.click('#rv-close');
    step('Compared before/after');

    await page.click('#rv-panel [data-d="approve"]');
    await page.waitForSelector('#rv-panel .outcome:has-text("Approved by Pia")');
    await page.click('#rv-panel [data-pub="publish"]');
    await page.waitForSelector('#rv-panel .outcome:has-text("Live on the website")', { timeout: 90000 });
    assert.match(await live('lift.html'), /Your ventures are moving/);
    assert.equal(F.state.pulls[0].state, 'merged');
    step('Approved → Published (pull request merged) → published website verified showing the new heading');

    await page.click('#rv-panel [data-pub="restore"]');
    await page.waitForSelector('#rv-panel .outcome:has-text("Previous version restored")', { timeout: 90000 });
    assert.match(await live('lift.html'), /You’ve backed the ventures/);
    step('Restored previous version → published website verified back to the original heading');

    // Another page + a shared element: Team page footer (shared, all pages).
    await page.click('#new-req');
    await page.selectOption('#page', 'team.html');
    await frame.locator('footer').waitFor(); await page.waitForTimeout(800);
    await clickIn('footer .foot-g a');
    await page.waitForSelector('#selection:has-text("shared · all 7 pages")');
    await page.check('#types input[value="colour"]');
    await page.fill('#instruction', 'Make the footer links slightly brighter.');
    await page.check('#allow-shared');
    script = [{ content: [tool('edit_file', { path: 'site.css', old_text: '/* THRESHOLD — site system', new_text: '.foot-g a{opacity:1}\n/* THRESHOLD — site system' })] },
      { content: [tool('finish', { summary: 'Made footer links slightly brighter on every page.' })] }];
    await page.click('#generate');
    await page.waitForSelector('#gen.ready, #gen.failed', { timeout: 180000 });
    assert.ok(await page.isVisible('#gen.ready'), await page.textContent('#gen'));
    assert.match(await page.textContent('#rv-panel'), /used on every page\. A Publisher must approve/);
    await page.click('#rv-open');
    assert.equal(await page.locator('#rv-page option').count(), 7);
    await page.click('#rv-close');
    await page.click('#rv-panel [data-d="approve"]');
    await page.click('#rv-panel [data-pub="publish"]');
    await page.waitForSelector('#rv-panel .outcome:has-text("Live on the website")', { timeout: 90000 });
    assert.match(await live('site.css'), /\.foot-g a\{opacity:1\}/);
    step('Team page → shared footer link: approval by Publisher, published, shared stylesheet verified on the website');

    assert.deepEqual(errors, []);
    console.log('\nE2E-LAUNCH PASSED (stand-in AI + stand-in GitHub)');
  } catch (e) {
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'failure-launch.png') }).catch(() => {});
    console.error('E2E-LAUNCH FAILED:', e.message.split('\n').slice(0, 4).join(' | '), errors);
    process.exitCode = 1;
  } finally { await browser.close(); T.close(); F.close(); prov.setTestProvider(null); }
})();
