'use strict';

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const suffix = Date.now() % 1000000;
const VIEWPORTS = [[375, 667], [390, 844], [412, 915]];
const AUTH_PAGES = [
  '/dashboard.html',
  '/monthly.html',
  '/fixed-expenses.html',
  '/variable-expenses.html',
  '/installments.html',
  '/profile.html',
];
let failed = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

async function footerState(page) {
  return page.$eval('#site-footer', (footer) => ({
    text: footer.textContent.trim(),
    position: getComputedStyle(footer).position,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const [width, height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

    for (const path of ['/login.html', '/register.html', '/offline.html']) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      await page.waitForSelector('#site-footer');
      const state = await footerState(page);
      check(`[${width}] ${path} has the shared footer`, state.text === 'Powered by FareezIO', state.text);
      check(`[${width}] ${path} footer is in normal flow`, state.position === 'static', state.position);
      check(`[${width}] ${path} has no horizontal overflow`, state.scrollWidth <= state.innerWidth + 1, `${state.scrollWidth}/${state.innerWidth}`);
    }

    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.waitForURL('**/login.html');
    await page.waitForSelector('#site-footer');
    const indexState = await footerState(page);
    check(`[${width}] index redirect retains the shared footer`, indexState.text === 'Powered by FareezIO', indexState.text);

    await page.goto(BASE + '/register.html', { waitUntil: 'networkidle' });
    await page.fill('#name', 'Footer User');
    await page.fill('#email', `footer${width}${suffix}@t.local`);
    await page.fill('#password', 'password123');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#register-form [type="submit"]'),
    ]);

    for (const path of AUTH_PAGES) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      await page.waitForSelector('#site-footer');
      const state = await footerState(page);
      check(`[${width}] ${path} has the shared footer`, state.text === 'Powered by FareezIO', state.text);
      check(`[${width}] ${path} footer is in normal flow`, state.position === 'static', state.position);
      check(`[${width}] ${path} has no horizontal overflow`, state.scrollWidth <= state.innerWidth + 1, `${state.scrollWidth}/${state.innerWidth}`);
    }

    const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401'));
    check(`[${width}] footer checks have no runtime errors`, hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');
    await context.close();
  }

  console.log(`\n${failed === 0 ? 'ALL FOOTER TESTS PASSED' : `${failed} FOOTER TEST(S) FAILED`}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
