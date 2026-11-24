'use strict';

const { chromium } = require('playwright');

// Browser regression for month-state synchronization between Monthly Expenses
// and Variable Expenses. The fixture account has one expense in the previous
// month and none in the current month.
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const EMAIL = process.env.VARIABLE_MONTH_EMAIL || 'variablemonth@fixture.local';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const PASSWORD = 'password123';
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

const value = (month) => `${month.year}-${String(month.month).padStart(2, '0')}`;
const label = (month) => new Date(Date.UTC(month.year, month.month - 1, 1)).toLocaleString('en-MY', { month: 'long', year: 'numeric' });
const previousMonth = (month) => {
  const index = month.year * 12 + month.month - 2;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('request', (r) => {
    if (r.url().includes('/api/variable-expenses') && r.method() === 'GET') requests.push(r.url());
  });

  const api = (path) => page.evaluate((p) => fetch('/api' + p).then((r) => r.json()), path);
  const emptyText = () => page.$eval('#var-empty', (el) => el.textContent.trim());
  const filterValue = () => page.$eval('#month-filter', (el) => el.value);
  const waitForView = async (month, hasExpense) => {
    await page.waitForFunction(({ expected, present }) => {
      const input = document.getElementById('month-filter');
      const body = document.getElementById('var-tbody').textContent;
      const empty = document.getElementById('var-empty').textContent;
      return input && input.value === expected && (present ? body.includes('Previous month expense') : empty.includes('No variable expenses found for this view.'));
    }, { expected: value(month), present: hasExpense });
  };

  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#login-form [type="submit"]'),
  ]);

  const current = await api('/monthly/current');
  const previous = previousMonth(current);
  const currentValue = value(current);
  const previousValue = value(previous);

  // 1) Monthly current month -> Variable Expenses carries the selected month.
  await page.goto(`${BASE}/monthly.html?year=${current.year}&month=${current.month}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((expected) => document.getElementById('month-title').textContent.trim() === expected, label(current));
  const navHref = await page.getAttribute('#main-nav a[data-nav="/variable-expenses.html"]', 'href');
  check(`navigation carries ${label(current)}`, navHref === `/variable-expenses.html?year=${current.year}&month=${current.month}`, navHref);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#main-nav a[data-nav="/variable-expenses.html"]'),
  ]);
  await waitForView(current, false);
  check('Monthly current -> Variable filter matches current month', await filterValue() === currentValue, await filterValue());
  check('Monthly current -> API request is month-scoped', requests.some((u) => u.includes(`/api/variable-expenses?year=${current.year}&month=${current.month}`)), requests.join(' | '));

  // 2) Monthly previous month -> Variable Expenses carries the new selection.
  await page.goto(`${BASE}/monthly.html?year=${previous.year}&month=${previous.month}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((expected) => document.getElementById('month-title').textContent.trim() === expected, label(previous));
  const previousNavHref = await page.getAttribute('#main-nav a[data-nav="/variable-expenses.html"]', 'href');
  check(`navigation carries ${label(previous)}`, previousNavHref === `/variable-expenses.html?year=${previous.year}&month=${previous.month}`, previousNavHref);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#main-nav a[data-nav="/variable-expenses.html"]'),
  ]);
  await waitForView(previous, true);
  check('Monthly previous -> Variable filter matches previous month', await filterValue() === previousValue, await filterValue());
  check('previous-month expense is displayed', (await page.$eval('#var-tbody', (el) => el.textContent)).includes('Previous month expense'));

  // 3-4) Direct month URLs select the requested empty/results view.
  await page.goto(`${BASE}/variable-expenses.html?year=${current.year}&month=${current.month}`, { waitUntil: 'networkidle' });
  await waitForView(current, false);
  check('direct current-month URL shows the empty state', await emptyText() === 'No variable expenses found for this view.', await emptyText());

  await page.goto(`${BASE}/variable-expenses.html?year=${previous.year}&month=${previous.month}`, { waitUntil: 'networkidle' });
  await waitForView(previous, true);
  check('direct previous-month URL shows its records', (await page.$eval('#var-tbody', (el) => el.textContent)).includes('Previous month expense'));

  // 5) Changing the filter issues a new request and updates both directions.
  requests.length = 0;
  await page.fill('#month-filter', currentValue);
  await waitForView(current, false);
  check('previous -> current filter refreshes data', await emptyText() === 'No variable expenses found for this view.');
  check('previous -> current request has current query', requests.some((u) => u.includes(`/api/variable-expenses?year=${current.year}&month=${current.month}`)), requests.join(' | '));
  await page.fill('#month-filter', previousValue);
  await waitForView(previous, true);
  check('current -> previous filter refreshes data', (await page.$eval('#var-tbody', (el) => el.textContent)).includes('Previous month expense'));
  check('current -> previous request has previous query', requests.some((u) => u.includes(`/api/variable-expenses?year=${previous.year}&month=${previous.month}`)), requests.join(' | '));

  // 6) Explicit current URL and 7) no URL both use the application current month.
  await page.goto(`${BASE}/variable-expenses.html?year=${current.year}&month=${current.month}`, { waitUntil: 'networkidle' });
  await waitForView(current, false);
  check('explicit current URL remains selected', await filterValue() === currentValue, await filterValue());
  await page.goto(BASE + '/variable-expenses.html', { waitUntil: 'networkidle' });
  await waitForView(current, false);
  check('no URL month uses application current month', await filterValue() === currentValue, await filterValue());
  check('no URL month does not load the unfiltered expense list', (await page.$eval('#var-tbody', (el) => el.textContent)).trim() === '', await emptyText());

  const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401'));
  check('no console/runtime errors', hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');

  console.log(`\n${failed === 0 ? 'ALL VARIABLE-MONTH CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
