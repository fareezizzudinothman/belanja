'use strict';

const { chromium } = require('playwright');

// Browser regression test for the monthly UI state machine (rule P):
// NOT OPEN -> OPEN -> CLOSED -> OPEN(reopened), plus the FUTURE read-only state.
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const suffix = Date.now() % 1000000;
const email = `monthlyui${suffix}@t.local`;
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

  const badge = () => page.$eval('#month-status', (el) => el.textContent.trim());
  const btnState = () => page.evaluate(() => ({
    open: document.getElementById('open-month-btn').style.display,
    close: document.getElementById('close-month-btn').style.display,
    reopen: document.getElementById('reopen-month-btn').style.display,
    addVar: document.getElementById('add-var-btn').style.display,
  }));

  // register
  await page.goto(BASE + '/register.html', { waitUntil: 'networkidle' });
  await page.fill('#name', 'Monthly UI');
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#register-form [type="submit"]'),
  ]);
  await page.waitForSelector('#t-total');
  const current = await page.evaluate(() => fetch('/api/monthly/current').then((r) => r.json()));

  // a master so the current month preview is non-empty
  await page.goto(BASE + '/fixed-expenses.html', { waitUntil: 'networkidle' });
  await page.click('#add-fixed-btn');
  await page.waitForSelector('#fixed-modal[open]');
  await page.fill('#fixed-name', 'Rent');
  await page.selectOption('#fixed-type', 'property');
  await page.fill('#fixed-amount', '1500');
  await page.click('#fixed-form [type="submit"]');
  await page.waitForSelector('#fixed-tbody tr');

  // 1) current month, never opened
  await page.goto(BASE + '/monthly.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('month-status').textContent.includes('NOT OPEN'));
  check('P-1 badge = NOT OPEN', (await badge()) === 'NOT OPEN', await badge());
  let b = await btnState();
  check('P-1 only Open visible (close/reopen/add hidden)', b.open !== 'none' && b.close === 'none' && b.reopen === 'none' && b.addVar === 'none', JSON.stringify(b));
  const sum = await page.$eval('#sum-total', (el) => el.textContent);
  check('P-1 preview total = RM 1,500.00', sum.replace(/\u00a0/g, ' ').trim() === 'RM 1,500.00', sum);

  // 2) Open the current month
  await page.click('#open-month-btn');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  b = await btnState();
  check('P-2 badge = OPEN', (await badge()) === 'OPEN');
  check('P-2 Open hidden; Close + Add visible', b.open === 'none' && b.close !== 'none' && b.addVar !== 'none' && b.reopen === 'none', JSON.stringify(b));

  // Payment Checklist synchronization: initialize it, add variables from the
  // Variable Expenses page, then reopen it from Monthly Expenses.
  await page.click('#checklist-btn');
  await page.waitForSelector('#checklist-modal[open]');
  const initialChecklist = await page.$eval('#checklist-modal-container', (el) => el.textContent);
  check('checklist initializes before later variables', !initialChecklist.includes('Bil Api') && !initialChecklist.includes('Bil Air'));
  await page.click('#checklist-modal [data-close-modal]');

  await page.goto(`${BASE}/variable-expenses.html?year=${current.year}&month=${current.month}`, { waitUntil: 'networkidle' });
  for (const [name, amount] of [['Bil Api', '202'], ['Bil Air', '29']]) {
    await page.click('#add-var-btn');
    await page.waitForSelector('#var-modal[open]');
    await page.fill('#var-name', name);
    await page.selectOption('#var-type', 'bill');
    await page.fill('#var-amount', amount);
    await page.fill('#var-date', `${current.year}-${String(current.month).padStart(2, '0')}-02`);
    await page.click('#var-form [type="submit"]');
    await page.waitForFunction((expected) => document.getElementById('var-tbody').textContent.includes(expected), name);
  }

  await page.goto(`${BASE}/monthly.html?year=${current.year}&month=${current.month}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  await page.click('#checklist-btn');
  await page.waitForSelector('#checklist-modal[open]');
  await page.waitForFunction(() => {
    const text = document.getElementById('checklist-modal-container').textContent;
    return text.includes('Bil Api') && text.includes('Bil Air');
  });
  const syncedChecklist = (await page.$eval('#checklist-modal-container', (el) => el.textContent)).replace(/\u00a0/g, ' ');
  check('reopened checklist shows Bil Api RM 202', syncedChecklist.includes('Bil Api') && syncedChecklist.includes('RM 202.00'));
  check('reopened checklist shows Bil Air RM 29', syncedChecklist.includes('Bil Air') && syncedChecklist.includes('RM 29.00'));
  await page.click('#checklist-modal [data-close-modal]');

  // 3) Future month = read-only
  await page.click('#next-month');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.includes('FUTURE'));
  b = await btnState();
  check('P-3 badge = FUTURE', (await badge()) === 'FUTURE');
  check('P-3 all actions hidden', b.open === 'none' && b.close === 'none' && b.reopen === 'none' && b.addVar === 'none', JSON.stringify(b));

  // 4) Back to current month - OPEN preserved server-side
  await page.click('#prev-month');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  check('P-4 back to OPEN current month', (await badge()) === 'OPEN');

  // 5) Close
  await page.click('#close-month-btn');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.includes('CLOSED'));
  b = await btnState();
  check('P-5 badge = CLOSED', (await badge()) === 'CLOSED');
  check('P-5 only Reopen visible', b.close === 'none' && b.reopen !== 'none' && b.open === 'none' && b.addVar === 'none', JSON.stringify(b));
  const banner = await page.$eval('#month-banner', (el) => el.textContent);
  check('P-5 closed banner', banner.toLowerCase().includes('closed'), banner.trim().slice(0, 60));

  // 6) reload keeps it closed
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('month-status').textContent.includes('CLOSED'));
  const sumClosed = await page.$eval('#sum-total', (el) => el.textContent);
  check('P-6 closed survives reload (RM 1,731.00)', sumClosed.replace(/\u00a0/g, ' ').trim() === 'RM 1,731.00', sumClosed);

  // 7) Reopen restores editability
  await page.click('#reopen-month-btn');
  await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  b = await btnState();
  check('P-7 reopened -> OPEN, Add visible again', (await badge()) === 'OPEN' && b.addVar !== 'none' && b.close !== 'none');

  // 8) add a variable expense after reopen
  await page.click('#add-var-btn');
  await page.waitForSelector('#var-modal[open]');
  await page.fill('#var-name', 'Milo');
  await page.selectOption('#var-type', 'food');
  await page.fill('#var-amount', '4.5');
  await page.click('#var-form [type="submit"]');
  await page.waitForFunction(() => document.getElementById('var-list').textContent.includes('Milo'));
  const sumReopen = await page.$eval('#sum-total', (el) => el.textContent);
  check('P-8 reopened month accepts expense (RM 1,735.50)', sumReopen.replace(/\u00a0/g, ' ').trim() === 'RM 1,735.50', sumReopen);

  // 9) stale / invalid navigation does not create anything anywhere (read-only GET)
  const prevInfo = await page.evaluate(() => fetch('/api/monthly/2020/1').then((r) => r.json()));
  check('P-9 ancient month stays empty & read-only', prevInfo.entry === null && prevInfo.status === 'HISTORY', JSON.stringify(prevInfo.entry));

  const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401'));
  check('no console/runtime errors', hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');

  console.log(`\n${failed === 0 ? 'ALL UI TESTS PASSED' : `${failed} TEST(S) FAILED`}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1) });
