'use strict';

const { chromium } = require('playwright');

// Browser regression for the "September disappears after Reopen" report,
// driven entirely through the UI: CLOSED historical month -> Reopen Month ->
// dashboard chart -> Credit Card expense -> Close again.
//
// The historical month is positioned by tests/api/seed-reopen-fixture.mjs
// (run on the host before this container starts): the API intentionally refuses
// to OPEN a past month, so a CLOSED+REOPENED historical month cannot be created
// from inside the browser container. That fixture account also holds the
// recurring masters (fixed 3754 + installment 4868.34 = RM 8,622.34).
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const EMAIL = process.env.REOPEN_EMAIL || 'reopenui@fixture.local';
const PASSWORD = 'password123';
const pad = (n) => String(n).padStart(2, '0');
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

const norm = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const back = (y, m, n) => { const t = y * 12 + m - n - 1; return { year: Math.floor(t / 12), month: (t % 12) + 1 } };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  const api = (path, opts = {}) =>
    page.evaluate(async ([p, o]) => {
      const res = await fetch('/api' + p, {
        method: o.method || 'GET',
        headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
        body: o.body ? JSON.stringify(o.body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    }, [path, opts]);

  // ---- log in as the seeded fixture user ----
  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#login-form [type="submit"]'),
  ]);
  await page.waitForSelector('#t-total');
  check('fixture login reaches the dashboard', page.url().includes('/dashboard.html'), page.url());

  const cur = (await api('/monthly/current')).json;
  const cy = cur.year;
  const cm = cur.month;
  const prev = back(cy, cm, 1);
  const prevIdx = (await api('/dashboard')).json.series.findIndex((s) => s.year === prev.year && s.month === prev.month);

  const readBar = async () => {
    await page.waitForSelector('#chart .bar-col');
    const bars = await page.$$eval('#chart .bar-col', (els) => els.map((el) => ({
      label: el.querySelector('.bar-label').textContent.trim(),
      count: String(el.querySelector('.bar-count').textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
    })));
    return bars[prevIdx];
  };

  // ---- 1) CLOSED historical month is on the dashboard ----
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle' });
  const before = await readBar();
  check(`historical ${prev.year}-${pad(prev.month)} CLOSED shows RM 8,622.34`, before && before.count.includes('RM 8,622.34'), `got "${before && before.count}"`);

  // ---- 2) navigate to it and click Reopen Month ----
  await page.goto(BASE + '/monthly.html', { waitUntil: 'networkidle' });
  await page.click('#prev-month');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'CLOSED');
  const monthLabel = norm(await page.$eval('#month-status', (el) => el.textContent));
  check('historical month badge = CLOSED', monthLabel === 'CLOSED', monthLabel);
  check('Reopen action is offered', await page.$eval('#reopen-month-btn', (el) => el.style.display !== 'none'));

  await page.click('#reopen-month-btn');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  check('historical month is OPEN after Reopen', (await page.$eval('#month-status', (el) => el.textContent.trim())) === 'OPEN');
  const sumReopen = norm(await page.$eval('#sum-total', (el) => el.textContent));
  check('monthly page keeps the frozen RM 8,622.34 after reopen', sumReopen.includes('RM 8,622.34'), sumReopen);

  // ---- 3) Credit Card variable expense inside the reopened month ----
  await page.waitForFunction(() => document.getElementById('add-var-btn').style.display !== 'none');
  await page.click('#add-var-btn');
  await page.waitForSelector('#var-modal[open]');
  const options = await page.$$eval('#var-type option', (els) => els.map((o) => ({ value: o.value, label: o.textContent.trim() })));
  check('type dropdown lists Credit Card with the new order',
    options.map((o) => o.value).join(',') === 'food,groceries,parent,toll,fuel,credit_card,bill,shopee_paylater,tiktok_paylater,atome,hutang_orang,belanja_orang,others',
    options.map((o) => `${o.value}:${o.label}`).join(','));
  check('Credit Card option is labelled "Credit Card"', options.some((o) => o.value === 'credit_card' && o.label === 'Credit Card'));

  await page.fill('#var-name', 'CC Statement');
  await page.selectOption('#var-type', 'credit_card');
  await page.fill('#var-amount', '100');
  await page.click('#var-form [type="submit"]');
  await page.waitForFunction(() => document.getElementById('var-list').textContent.includes('CC Statement'));
  const listText = norm(await page.$eval('#var-list', (el) => el.textContent));
  check('credit_card row renders with the Credit Card badge', listText.includes('Credit Card') && listText.includes('RM 100.00'), listText.slice(0, 200));
  const sumAfter = norm(await page.$eval('#sum-total', (el) => el.textContent));
  check('reopened month total rises to RM 8,722.34', sumAfter.includes('RM 8,722.34'), sumAfter);

  // ---- 4) the dashboard must still show the month after the reopen ----
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle' });
  const after = await readBar();
  check('dashboard STILL shows RM 8,722.34 after reopen (not "-")', after && after.count.includes('RM 8,722.34'), `got "${after && after.count}"`);

  const seriesAfter = (await api('/dashboard')).json;
  const prevSer = seriesAfter.series.find((s) => s.year === prev.year && s.month === prev.month);
  const curSer = seriesAfter.series.find((s) => s.year === cy && s.month === cm);
  check('API: reopened month total = 8722.34', Number(prevSer.total) === 8722.34, `got ${prevSer.total}`);
  check('API: current CLOSED month untouched (8622.34)', Number(curSer.total) === 8622.34, `got ${curSer.total}`);
  check('API: current and reopened months never mix', Number(curSer.total) !== Number(prevSer.total), `cur=${curSer.total} prev=${prevSer.total}`);

  // ---- 5) close again from the UI: snapshot refreshes, total stays ----
  await page.goto(BASE + '/monthly.html', { waitUntil: 'networkidle' });
  await page.click('#prev-month');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  await page.click('#close-month-btn');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.includes('CLOSED'));
  const sumFinal = norm(await page.$eval('#sum-total', (el) => el.textContent));
  check('re-closed month keeps RM 8,722.34', sumFinal.includes('RM 8,722.34'), sumFinal);

  await page.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle' });
  const finalBar = await readBar();
  check('dashboard shows the final RM 8,722.34', finalBar && finalBar.count.includes('RM 8,722.34'), `got "${finalBar && finalBar.count}"`);

  const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401'));
  check('no console/runtime errors', hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');

  console.log(`\n${failed === 0 ? 'ALL REOPEN CHART CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
