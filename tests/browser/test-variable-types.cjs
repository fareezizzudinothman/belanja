'use strict';

// Regression test: "Credit Card is missing from the Variable Expenses
// dropdown" (report: the live UI kept showing Food/Groceries/Parent/Toll/
// Fuel/Others while the file on disk already contained credit_card).
//
// The bug was NOT in the dropdown source - frontend/js/ui.js already listed
// credit_card. It was in *delivery*: a browser that already had the previous
// release cached kept executing the previous /js/ui.js forever. So this test has
// two halves:
//
//   PART 1 - delivery. Reproduces a deploy while a browser holds the previous
//   release, on ONE origin (so the HTTP cache, the Cache Storage and the
//   service worker registration all survive the "deploy"):
//     phase 1 "old deploy" - the proxy serves a synthetic PRE-FIX /js/ui.js
//       (credit_card removed from VARIABLE_TYPES) and the pre-fix service
//       worker (plain cache.addAll + cache-first), using the same Cache-Control
//       nginx sends for .js files. The browser ends up with the old body in its
//       HTTP cache, in the v1 precache, and executing in the page.
//     phase 2 "fix shipped" - the same origin now proxies to the running app.
//       The page must end up running the CURRENT /js/ui.js. Before the fix this
//       failed forever: the new precache was refilled from the browser HTTP
//       cache and then served cache-first, so credit_card never appeared.
//
//   PART 2 - behaviour, driven through the real UI: dropdown order and labels
//   on /variable-expenses.html and in the /monthly.html modal, submitting
//   type=credit_card, the persisted API value, and pre-existing types still
//   working. Nothing here is mocked.
//
// Run: npm run test:browser:variable-types

const { chromium } = require('playwright');
const http = require('http');

const TARGET = new URL((process.env.BASE_URL || 'http://host.docker.internal:8080').replace(/\/$/, ''));
const CHROME = process.env.CHROME_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';
const EXPECTED_OPTIONS = [
  { value: 'food', label: 'Food' },
  { value: 'groceries', label: 'Groceries' },
  { value: 'parent', label: 'Parent' },
  { value: 'toll', label: 'Toll' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'bill', label: 'Bill' },
  { value: 'shopee_paylater', label: 'Shopee PayLater' },
  { value: 'tiktok_paylater', label: 'TikTok PayLater' },
  { value: 'atome', label: 'Atome' },
  { value: 'hutang_orang', label: 'Hutang Orang' },
  { value: 'belanja_orang', label: 'Belanja Orang' },
  { value: 'others', label: 'Others' },
];
const EXPECTED_ORDER = EXPECTED_OPTIONS.map((o) => o.value).join(',');
const EXPECTED_OPTION_STRINGS = EXPECTED_OPTIONS.map((o) => `${o.value}:${o.label}`).join(' ');
const LIVE_CACHE_RE = /CACHE\s*=\s*'(belanja-static-v\d+)'/;
const VARIABLE_TYPES_RE = /const VARIABLE_TYPES = \[[^\]]*\];/;

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!cond) failed++;
}

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`${url} -> ${res.statusCode}`))));
      })
      .on('error', reject);
  });

// The pre-fix service worker, reproduced verbatim in behaviour: precache with a
// plain cache.addAll() (subject to the HTTP cache) and a cache-first fetch
// handler. Phase 1 installs this, so the "stale client" is modelled exactly
// instead of depending on whatever the live worker looks like today.
const preFixSw = (cacheName, precacheBody) => `'use strict';
const CACHE = '${cacheName}';
const PRECACHE_URLS = [${precacheBody}];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('belanja-static-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => undefined)
    )
  );
});
`;

let phase = 'old';
let state = {};

const proxy = http.createServer((req, res) => {
  if (phase === 'old') {
    if (req.url === '/js/ui.js') {
      // Same headers nginx used to send for .js: a one hour public cache.
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ETag: '"prefix-release-1"',
      });
      res.end(state.oldUi);
      return;
    }
    if (req.url === '/service-worker.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ETag: '"prefix-sw-1"',
      });
      res.end(state.oldSw);
      return;
    }
  }
  const up = http.request({ host: TARGET.hostname, port: TARGET.port, path: req.url, method: req.method, headers: req.headers }, (ures) => {
    res.writeHead(ures.statusCode, ures.headers);
    ures.pipe(res);
  });
  req.pipe(up);
  up.on('error', () => { try { res.writeHead(502); } catch { /* ignore */ } res.end(); });
});

const readTypes = (page) =>
  page.evaluate(async () => {
    const grab = (s) => (s ? (s.match(/const VARIABLE_TYPES = \[[^\]]*\];/) || [''])[0] : '(nothing)');
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    const cached = keys.length ? await caches.match('/js/ui.js') : null;
    return {
      runtime: typeof UI !== 'undefined' ? String(UI.VARIABLE_TYPES) : '(ui.js not loaded)',
      cacheStorage: grab(cached ? await cached.clone().text() : null),
      servedByBrowser: grab(await fetch('/js/ui.js').then((r) => r.text())),
      cacheKeys: keys,
      swCache: reg && reg.active ? ((await fetch('/service-worker.js', { cache: 'no-store' }).then((r) => r.text())).match(/CACHE\s*=\s*'(belanja-static-v\d+)'/) || [])[1] : '(no active worker)',
    };
  });

(async () => {
  const liveUi = await httpGet(`${TARGET.href}/js/ui.js`);
  const liveSw = await httpGet(`${TARGET.href}/service-worker.js`);
  const liveCache = (liveSw.match(LIVE_CACHE_RE) || [])[1];
  if (!liveCache) throw new Error('could not read the cache name from the live service worker');
  if (!VARIABLE_TYPES_RE.test(liveUi)) throw new Error('could not read VARIABLE_TYPES from the live ui.js');
  if (!/credit_card/.test(VARIABLE_TYPES_RE.exec(liveUi)[0])) {
    throw new Error(`the live ui.js does not contain credit_card: ${VARIABLE_TYPES_RE.exec(liveUi)[0]}`);
  }
  const precacheBody = (liveSw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/) || [, "''"])[1];
  state.oldUi = liveUi.replace(VARIABLE_TYPES_RE, "const VARIABLE_TYPES = ['food', 'groceries', 'parent', 'toll', 'fuel', 'others'];");
  state.oldSw = preFixSw('belanja-static-v1', precacheBody);
  console.log(`live cache "${liveCache}"; pre-fix cache "belanja-static-v1"`);

  const PORT = await new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  const BASE = `http://localhost:${PORT}`;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  // ---------------- PART 1: delivery across a deploy ----------------
  console.log('\n== PART 1: the browser already has the previous release cached ==');
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const stale = await readTypes(page);
  check('pre-fix deploy: stale ui.js is executing (reproduction primed)',
    stale.runtime === 'food,groceries,parent,toll,fuel,others',
    stale.runtime);
  check('pre-fix deploy: stale body also sits in the v1 precache', !stale.cacheStorage.includes('credit_card'), stale.cacheStorage);
  check('pre-fix deploy: stale body also sits in the HTTP cache', !stale.servedByBrowser.includes('credit_card'), stale.servedByBrowser);

  console.log('\n== shipping the fix (same origin now proxies to the running app) ==');
  phase = 'live';
  // The browser picks the new worker up on navigation/register(); give it a few
  // passes, exactly like a user who reloads the app after a deploy.
  let now = null;
  for (let i = 0; i < 5; i++) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    now = await readTypes(page);
    if (now.runtime.includes('credit_card') && now.servedByBrowser.includes('credit_card')) break;
  }
  check('after deploy the page runs the current ui.js (credit_card present)',
    now.runtime.includes('credit_card') && now.servedByBrowser.includes('credit_card'),
    `runtime=${now.runtime} served=${now.servedByBrowser}`);
  check('the running service worker is the deployed one', now.swCache === liveCache, `${now.swCache} (expected ${liveCache})`);
  check('the precache holds the current ui.js', now.cacheStorage.includes('credit_card'), now.cacheStorage);
  check('the pre-fix cache was purged', !now.cacheKeys.includes('belanja-static-v1'), now.cacheKeys.join(','));
  check('exactly one belanja-static cache is kept', now.cacheKeys.filter((k) => k.startsWith('belanja-static-')).length === 1, now.cacheKeys.join(','));

  // A user who left the app open across the deploy must not be stuck on the old
  // worker either: force the update and re-read.
  await page.goto(`${BASE}/variable-expenses.html`, { waitUntil: 'networkidle' });
  check('Variable Expenses page reports the 13-type list after the deploy',
    await page.evaluate(() => typeof UI !== 'undefined' && UI.VARIABLE_TYPES.length === 13 && UI.VARIABLE_TYPES.includes('credit_card')),
    await page.evaluate(() => (typeof UI !== 'undefined' ? String(UI.VARIABLE_TYPES) : '(no UI)')));

  // ---------------- PART 2: behaviour through the real UI ----------------
  console.log('\n== PART 2: Credit Card in the live UI ==');
  const email = `vartypes${Date.now() % 1000000}@t.local`;
  await page.goto(`${BASE}/register.html`, { waitUntil: 'networkidle' });
  await page.fill('#name', 'Var Types');
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#register-form [type="submit"]'),
  ]);
  check('register -> dashboard', page.url().includes('/dashboard.html'), page.url());

  // A variable expense can only be recorded in an OPEN month.
  await page.goto(`${BASE}/monthly.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#month-status');
  if ((await page.$eval('#month-status', (el) => el.textContent)).includes('NOT OPEN')) {
    await page.click('#open-month-btn');
    await page.waitForFunction(() => document.getElementById('month-status').textContent.trim() === 'OPEN');
  }
  await page.click('#add-var-btn');
  await page.waitForSelector('#var-modal[open]');
  const modalOpts = await page.$$eval('#var-type option', (els) => els.map((o) => `${o.value}:${o.textContent.trim()}`));
  check('monthly modal type dropdown order', (await page.$$eval('#var-type option', (els) => els.map((o) => o.value))).join(',') === EXPECTED_ORDER, modalOpts.join(' '));
  check('monthly modal type labels', modalOpts.join(' ') === EXPECTED_OPTION_STRINGS, modalOpts.join(' '));
  check('monthly modal offers a "Credit Card" option', modalOpts.includes('credit_card:Credit Card'), modalOpts.join(' '));
  await page.keyboard.press('Escape');

  // ---- the Variable Expenses page itself ----
  await page.goto(`${BASE}/variable-expenses.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#var-tbody', { state: 'attached' });
  await page.click('#add-var-btn');
  await page.waitForSelector('#var-modal[open]');
  const opts = await page.$$eval('#var-type option', (els) => els.map((o) => ({ value: o.value, label: o.textContent.trim() })));
  check('Variable Expenses dropdown order', opts.map((o) => o.value).join(',') === EXPECTED_ORDER,
    opts.map((o) => `${o.value}:${o.label}`).join(' '));
  check('Variable Expenses dropdown has the exact labels', JSON.stringify(opts) === JSON.stringify(EXPECTED_OPTIONS),
    JSON.stringify(opts));
  check('Variable Expenses dropdown shows "Credit Card"', opts.some((o) => o.value === 'credit_card' && o.label === 'Credit Card'),
    JSON.stringify(opts.map((o) => o.label)));
  check('Credit Card sits between Fuel and Bill', opts.map((o) => o.label).join('|').includes('Fuel|Credit Card|Bill'),
    opts.map((o) => o.label).join('|'));

  const submitted = [];
  page.on('request', (r) => { if (r.url().includes('/api/variable-expenses') && r.method() === 'POST') submitted.push(r.postData()); });

  await page.fill('#var-name', 'CC Statement');
  await page.selectOption('#var-type', 'credit_card');
  await page.fill('#var-amount', '100');
  await page.click('#var-form [type="submit"]');
  await page.waitForFunction(() => document.getElementById('var-tbody').textContent.includes('CC Statement'));
  check('selecting Credit Card submits type=credit_card', submitted.some((b) => JSON.parse(b).type === 'credit_card'), submitted.join(' | '));
  const rowText = await page.$eval('#var-tbody', (el) => el.textContent.replace(/\s+/g, ' '));
  check('the row renders the Credit Card badge', rowText.includes('Credit Card') && rowText.includes('RM 100.00'), rowText.slice(0, 160));

  const api = await page.evaluate(() => fetch('/api/variable-expenses').then((r) => r.json()));
  const cc = (api.items || []).find((i) => i.name === 'CC Statement');
  check('the API persisted type=credit_card', !!cc && cc.type === 'credit_card', JSON.stringify(cc && { type: cc.type, amount: cc.amount }));

  // A pre-existing type must keep working.
  await page.click('#add-var-btn');
  await page.waitForSelector('#var-modal[open]');
  await page.fill('#var-name', 'Petrol Top Up');
  await page.selectOption('#var-type', 'fuel');
  await page.fill('#var-amount', '55.5');
  await page.click('#var-form [type="submit"]');
  await page.waitForFunction(() => document.getElementById('var-tbody').textContent.includes('Petrol Top Up'));
  const api2 = await page.evaluate(() => fetch('/api/variable-expenses').then((r) => r.json()));
  check('pre-existing type fuel still saves', (api2.items || []).some((i) => i.name === 'Petrol Top Up' && i.type === 'fuel'),
    JSON.stringify((api2.items || []).map((i) => `${i.name}=${i.type}`)));

  // Editing a credit_card row must keep its type selectable.
  await page.click('#var-tbody tr:has-text("CC Statement") [data-edit]');
  await page.waitForSelector('#var-modal[open]');
  const editVal = await page.$eval('#var-type', (el) => el.value);
  check('editing the credit_card row preselects credit_card', editVal === 'credit_card', editVal);
  await page.keyboard.press('Escape');

  // Only errors raised by the real UI flow count; part 1 deliberately visits a
  // protected page while logged out, which 401s by design.
  const hardErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('401') && !e.includes('Authentication required'));
  check('no console/runtime errors', hardErrors.length === 0, hardErrors.join(' ;; ') || 'none');

  console.log(`\n${failed === 0 ? 'ALL VARIABLE-TYPE CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  await browser.close();
  proxy.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
