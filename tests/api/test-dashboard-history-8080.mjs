import { spawnSync } from 'node:child_process'

// Regression test for the dashboard series: a HISTORICAL month (any month other
// than the current one) must NEVER inherit the current month's live recurring
// fixed/installment totals.
//
//   - current (OPEN) month      -> lives live recurring masters
//   - previous month CLOSED, empty snapshot -> 0 (its own actual data only)
//   - previous month CLOSED with own snapshot -> the SNAPSHOT value (not live)
//   - previous month REOPENED with its snapshot -> still the SNAPSHOT value
//     (reopen never destroys the frozen data, so the month must not disappear
//     from the dashboard) plus any variable expense added while it was open
//   - previous month REOPENED without any snapshot -> variable expenses only
//
// Uses docker exec + psql ONLY to position months/snapshots in the database as
// if time had moved on (the API forbids opening past months directly).
const BASE = 'http://localhost:8080/api'
const suffix = Date.now() % 100000
const email = `dashhist${suffix}@t.local`
let failed = 0

async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

function check(code, name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  [${code}] ${name}${detail ? '  | ' + detail : ''}`)
  if (!cond) failed++
}

function psql(sql) {
  const out = spawnSync('docker', ['exec', 'belanja-db-1', 'psql', '-U', 'belanja', '-d', 'belanja', '-c', sql], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('psql failed: ' + (out.stderr || ''))
  return out
}
function psqlT(sql) {
  const out = spawnSync('docker', ['exec', 'belanja-db-1', 'psql', '-U', 'belanja', '-d', 'belanja', '-tA', '-c', sql], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('psql failed: ' + (out.stderr || ''))
  return out.stdout.trim()
}

// One calendar month back from (y, m).
const back = (y, m, n) => { const t = y * 12 + m - n - 1; return { year: Math.floor(t / 12), month: (t % 12) + 1 } }

async function main() {
  const reg = await req('POST', '/auth/register', { name: 'Dash History', email, password: 'password123' })
  const token = reg.json.token
  const cur = (await req('GET', '/monthly/current', undefined, token)).json
  const cy = cur.year
  const cm = cur.month
  const prev = back(cy, cm, 1) // August when current is September
  const prev2 = back(cy, cm, 2) // July when current is September
  const ymd = `${prev.year}-${String(prev.month).padStart(2, '0')}-10`

  const uid = psqlT(`SELECT id FROM belanja.users WHERE email='${email}'`)
  const seedEntry = (status) => psql(
    `INSERT INTO belanja.monthly_entries (user_id, year, month, status, closed_at)
     VALUES ('${uid}', ${prev.year}, ${prev.month}, '${status}', ${status === 'CLOSED' ? "now()" : 'NULL'})
     ON CONFLICT (user_id, year, month) DO UPDATE SET status = EXCLUDED.status, closed_at = EXCLUDED.closed_at, reopened_at = NULL;`
  )

  // Live recurring masters: fixed 1200 + installment 1800 = live total 3000.
  await req('POST', '/fixed-expenses', { name: 'Rent', type: 'property', amount: 1200, active: true }, token)
  await req('POST', '/installments', { loanName: 'Car', type: 'vehicle', amount: 20000, monthlyInstallment: 1800, totalMonths: 12, paidMonths: 3, active: true }, token)
  const feId = psqlT(`SELECT id FROM belanja.fixed_expenses WHERE user_id='${uid}' LIMIT 1`)
  const instId = psqlT(`SELECT id FROM belanja.installments WHERE user_id='${uid}' LIMIT 1`)

  // Current (OPEN) month records the live recurring total.
  await req('POST', `/monthly/${cy}/${cm}/open`, undefined, token)

  const seriesOf = async () => {
    const dash = (await req('GET', '/dashboard', undefined, token)).json
    const p = dash.series.find((s) => s.year === prev.year && s.month === prev.month)
    const c = dash.series.find((s) => s.year === cy && s.month === cm)
    const p2 = dash.series.find((s) => s.year === prev2.year && s.month === prev2.month)
    return { prev: p, prev2: p2, current: c }
  }

  // -----------------------------------------------------------------
  // T1) Previous month CLOSED with EMPTY snapshot -> 0, never the live total.
  // -----------------------------------------------------------------
  seedEntry('CLOSED')
  let s = await seriesOf()
  check('T1', 'GET on /dashboard uses existing CLOSED prev month (no entry created)', !!s.prev && !!s.current, JSON.stringify({ p: s.prev && s.prev.total, c: s.current && s.current.total }))
  check('T1', 'prev(total)=0 - empty snapshot, NOT live 3000', Number(s.prev.total) === 0, `prev.total=${s.prev && s.prev.total}`)
  check('T1', 'prev(fixed)=0 and prev(inst)=0', Number(s.prev.fixed) === 0 && Number(s.prev.installments) === 0, `f=${s.prev && s.prev.fixed} i=${s.prev && s.prev.installments}`)
  check('T1', 'current(OPEN) still uses live 3000', Number(s.current.total) === 3000, `current.total=${s.current && s.current.total}`)
  check('T1', 'prev.total !== current.total (no inheritance)', Number(s.prev.total) !== Number(s.current.total), `prev=${s.prev && s.prev.total} current=${s.current && s.current.total}`)

  // -----------------------------------------------------------------
  // T2) Previous month CLOSED with its OWN frozen snapshot (fixed 100 + inst 200).
  //     Must plot the SNAPSHOT value (300), never the live 3000.
  // -----------------------------------------------------------------
  const entryId = psqlT(`SELECT id FROM belanja.monthly_entries WHERE user_id='${uid}' AND year=${prev.year} AND month=${prev.month}`)
  psql(`INSERT INTO belanja.monthly_fixed_expenses (monthly_entry_id, user_id, fixed_expense_id, name, type, amount, remarks)
        VALUES ('${entryId}', '${uid}', '${feId}', 'Old Rent', 'property', 100, NULL);`)
  psql(`INSERT INTO belanja.monthly_installments (monthly_entry_id, user_id, installment_id, loan_name, type, monthly_installment, remarks)
        VALUES ('${entryId}', '${uid}', '${instId}', 'Old Car', 'vehicle', 200, NULL);`)
  s = await seriesOf()
  check('T2', 'prev(total)=300 (own snapshot, NOT live 3000)', Number(s.prev.total) === 300, `prev.total=${s.prev && s.prev.total}`)
  check('T2', 'prev(fixed)=100 snapshot, prev(inst)=200 snapshot', Number(s.prev.fixed) === 100 && Number(s.prev.installments) === 200, `f=${s.prev && s.prev.fixed} i=${s.prev && s.prev.installments}`)
  check('T2', 'prev.total !== current.total', Number(s.prev.total) !== Number(s.current.total), `prev=${s.prev && s.prev.total} current=${s.current && s.current.total}`)

  // -----------------------------------------------------------------
  // T3) Previous month OPEN but NOT current (a deliberately reopened month)
  //     WITH an existing snapshot. It must KEEP plotting its own snapshot
  //     (300) plus its own variable expenses (50) = 350. It must never
  //     inherit the current month's live 3000, and it must not collapse to
  //     the variable-only total just because it was reopened.
  // -----------------------------------------------------------------
  seedEntry('OPEN')
  psql(`UPDATE belanja.monthly_entries SET reopened_at = now() WHERE id='${entryId}'`)
  const vr = await req('POST', '/variable-expenses', { name: 'Breakfast', type: 'food', amount: 50, expenseDate: ymd }, token)
  check('T3', 'variable write allowed in reopened (OPEN) prev month', vr.status === 201, `status=${vr.status}`)
  s = await seriesOf()
  check('T3', 'reopened month with a snapshot stays on the dashboard', Number(s.prev.total) > 0, `prev.total=${s.prev && s.prev.total}`)
  check('T3', 'prev(total)=350 (kept snapshot 300 + own variable 50, NOT live 3000)', Number(s.prev.total) === 350, `prev.total=${s.prev && s.prev.total}`)
  check('T3', 'prev(fixed)=100 snapshot, prev(inst)=200 snapshot (still frozen)', Number(s.prev.fixed) === 100 && Number(s.prev.installments) === 200, `f=${s.prev && s.prev.fixed} i=${s.prev && s.prev.installments}`)
  check('T3', 'reopened month does NOT inherit the live recurring definitions', Number(s.prev.total) !== 3000, `prev.total=${s.prev && s.prev.total}`)
  check('T3', 'current(OPEN) still live 3000', Number(s.current.total) === 3000, `current.total=${s.current && s.current.total}`)
  check('T3', 'prev.total !== current.total', Number(s.prev.total) !== Number(s.current.total), `prev=${s.prev && s.prev.total} current=${s.current && s.current.total}`)

  // -----------------------------------------------------------------
  // T4) A reopened month whose snapshot was never written (opened while it
  //     was current and never closed) has no frozen data to keep, so it plots
  //     only its own variable expenses - still never the live totals.
  // -----------------------------------------------------------------
  const emptyEntry = psqlT(`SELECT id FROM belanja.monthly_entries WHERE user_id='${uid}' AND year=${cur.year} AND month=${cur.month}`)
  psql(`INSERT INTO belanja.monthly_entries (user_id, year, month, status, reopened_at)
        VALUES ('${uid}', ${prev2.year}, ${prev2.month}, 'OPEN', now())
        ON CONFLICT (user_id, year, month) DO UPDATE SET status='OPEN', reopened_at=now();`)
  const vr2 = await req('POST', '/variable-expenses', { name: 'Toll top-up', type: 'toll', amount: 12, expenseDate: `${prev2.year}-${String(prev2.month).padStart(2, '0')}-11` }, token)
  check('T4', 'variable write allowed in reopened month without snapshot', vr2.status === 201, `status=${vr2.status}`)
  s = await seriesOf()
  check('T4', 'reopened month WITHOUT a snapshot plots only its own variable (12)', Number(s.prev2.total) === 12, `got ${s.prev2 && s.prev2.total}`)
  check('T4', 'reopened month without snapshot never inherits live 3000', Number(s.prev2.total) !== 3000, `got ${s.prev2 && s.prev2.total}`)
  check('T4', 'the untouched current month entry is still OPEN', psqlT(`SELECT status FROM belanja.monthly_entries WHERE id='${emptyEntry}'`) === 'OPEN')

  console.log(`\n${failed === 0 ? 'ALL DASHBOARD-HISTORY TESTS PASSED' : `${failed} TEST(S) FAILED`}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })