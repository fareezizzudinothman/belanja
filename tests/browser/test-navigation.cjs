'use strict';

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const suffix = Date.now() % 1000000;
const email = `navigation${suffix}@t.local`;
const password = 'password123';
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

const FRONTEND_FILES = [
  '/index.html',
  '/login.html',
  '/register.html',
  '/dashboard.html',
  '/fixed-expenses.html',
  '/monthly.html',
  '/variable-expenses.html',
  '/installments.html',
  '/profile.html',
  '/offline.html',
  '/js/index.js',
  '/js/auth.js',
  '/js/ui.js',
  '/js/dashboard.js',
  '/js/fixed-expenses.js',
  '/js/monthly.js',
  '/js/variable-expenses.js',
  '/js/installments.js',
  '/js/profile.js',
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  let popupCount = 0;
  context.on('page', () => { popupCount++; });

  await page.goto(BASE + '/register.html', { waitUntil: 'networkidle' });
  await page.fill('#name', 'Navigation User');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#register-form [type="submit"]'),
  ]);

  check('navigation starts on Dashboard', new URL(page.url()).pathname === '/dashboard.html', page.url());
  check('navigation starts with one page', context.pages().length === 1, `${context.pages().length} pages`);

  const routes = [
    { path: '/fixed-expenses.html', label: 'Fixed Expenses' },
    { path: '/monthly.html', label: 'Monthly Expenses' },
    { path: '/variable-expenses.html', label: 'Variable Expenses' },
    { path: '/installments.html', label: 'Installments' },
    { path: '/profile.html', label: 'Profile' },
  ];

  for (const route of routes) {
    const currentPage = page;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click(`#main-nav a[data-nav="${route.path}"]`),
    ]);

    const pathname = new URL(page.url()).pathname;
    check(`${route.label} uses the existing page`, page === currentPage);
    check(`${route.label} stays in one browser context`, context.pages().length === 1, `${context.pages().length} pages`);
    check(`${route.label} route loaded`, pathname === route.path, page.url());
    check(`${route.label} heading rendered`, await page.$eval('h1', (el) => el.textContent.trim()).then((text) => text.includes(route.label)));
  }

  const sourceIssues = await page.evaluate(async (files) => {
    const issues = [];
    for (const file of files) {
      const response = await fetch(file);
      const source = await response.text();
      if (/target\s*=\s*["']_blank["']/i.test(source)) issues.push(`${file}: target=_blank`);
      if (/window\.open\s*\(/i.test(source)) issues.push(`${file}: window.open`);
    }
    return issues;
  }, FRONTEND_FILES);

  check('frontend has no target=_blank navigation', sourceIssues.every((issue) => !issue.includes('target=_blank')), sourceIssues.join(' | '));
  check('frontend has no window.open navigation', sourceIssues.every((issue) => !issue.includes('window.open')), sourceIssues.join(' | '));
  check('navigation did not create popup pages', popupCount === 0, `${popupCount} popup pages`);

  await browser.close();
  console.log(`\n${failed === 0 ? 'ALL NAVIGATION TESTS PASSED' : `${failed} TEST(S) FAILED`}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
