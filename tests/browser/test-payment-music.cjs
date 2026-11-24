'use strict';

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const suffix = Date.now() % 1000000;
const email = `paymentmusic${suffix}@t.local`;
const videoId = 'dQw4w9WgXcQ';
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.route('https://www.youtube.com/embed/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>YouTube test frame</title>',
  }));

  await page.goto(BASE + '/register.html', { waitUntil: 'networkidle' });
  await page.fill('#name', 'Payment Music Browser User');
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#register-form [type="submit"]'),
  ]);

  await page.goto(BASE + '/profile.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#payment-music-enabled');
  check('Profile defaults music to OFF',
    await page.$eval('#payment-music-enabled', (el) => !el.checked) &&
      await page.$eval('#payment-music-url', (el) => el.value === ''));

  await page.goto(BASE + '/monthly.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#open-month-btn');
  await page.click('#open-month-btn');
  await page.waitForFunction(() => document.getElementById('checklist-btn').style.display !== 'none');

  await page.click('#checklist-btn');
  await page.waitForSelector('#checklist-modal[open]');
  check('TEST 6: checklist with music OFF does not load playback',
    await page.locator('#payment-checklist-music-frame').count() === 0);
  await page.click('#checklist-modal [data-close-modal]');
  await page.waitForFunction(() => !document.getElementById('checklist-modal').open);

  await page.goto(BASE + '/profile.html', { waitUntil: 'networkidle' });
  await page.check('#payment-music-enabled');
  await page.fill('#payment-music-url', `https://www.youtube.com/watch?v=${videoId}`);
  await page.click('#payment-music-form [type="submit"]');
  await page.waitForSelector('.toast.success');

  await page.goto(BASE + '/monthly.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('checklist-btn').style.display !== 'none');
  await page.click('#checklist-btn');
  await page.waitForSelector('#checklist-modal[open]');
  const frame = page.locator('#payment-checklist-music-frame');
  check('TEST 7: checklist with music ON loads configured YouTube video',
    await frame.count() === 1 && (await frame.getAttribute('src')).includes(`/embed/${videoId}`) &&
      (await frame.getAttribute('src')).includes('autoplay=1'));

  await page.click('#checklist-modal [data-close-modal]');
  await page.waitForFunction(() => !document.getElementById('checklist-modal').open);
  const hasPlaybackFrame = await page.$eval('body', (el) => !!el.querySelector('#payment-checklist-music-frame'));
  check('TEST 8: closing checklist removes playback', !hasPlaybackFrame);

  const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401'));
  check('payment music browser test has no runtime errors', hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');

  console.log(`\n${failed === 0 ? 'ALL PAYMENT MUSIC BROWSER TESTS PASSED' : `${failed} PAYMENT MUSIC BROWSER TEST(S) FAILED`}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
