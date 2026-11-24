import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Regression test: a CLOSED historical month must NOT disappear from the
// dashboard when it is reopened.
//
// Root cause this test pins: the dashboard used to load frozen snapshot rows
// only for entries whose status was 'CLOSED'. Reopening flips the entry to
// 'OPEN' while (by design) KEEPING its snapshot rows, so the series fell back to
// "no recurring data" and September rendered as "-" instead of RM 8,622.34.
//
//   CLOSED September        -> dashboard plots the frozen snapshot
//   REOPENED September      -> dashboard STILL plots the same frozen snapshot
//   + Credit Card expense   -> that expense adds to SEPTEMBER, not October
//   CLOSE again             -> snapshot refreshed from the live masters
//
// Also covered: current OPEN month keeps using live recurring values, future /
// unopened months stay empty, the two adjacent months never mix, and
// 'credit_card' is a valid Variable Expense type end-to-end (API + DB).
//
// docker exec + psql is used ONLY to position the historical month in the
// database as if the calendar had moved on (the API intentionally refuses to
// open a past month), exactly like the other monthly tests.
// ---------------------------------------------------------------------------
const BASE = 'http://localhost:8080/api'
const suffix = Date.now() % 100000
const email = `reopen${suffix}@t.local`
const pad = (n) => String(n).padStart(2, '0')
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

const back = (y, m, n) => { const t = y * 12 + m - n - 1; return { year: Math.floor(t / 12), month: (t % 12) + 1 } }
const ymd = (mm, d) => `${mm.year}-${pad(mm.month)}-${pad(d)}`

async function main() {
  const reg = await req('POST', '/auth/register', { name: 'Reopen User', email, password: 'password123' })
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`)
  const token = reg.json.token
  const uid = psqlT(`SELECT id FROM belanja.users WHERE email='${email}'`)

  const cur = (await req('GET', '/monthly/current', undefined, token)).json
  const cy = cur.year
  const cm = cur.month
  const prev = back(cy, cm, 1) // the historical month (September when current is October)
  const next = back(cy, cm, -1) // future month (November when current is October)
  const label = (m) => `${m.year}-${pad(m.month)}`

  // Live recurring masters, mirroring the reported figures:
  // fixed 3,754 + installments 4,868.34 = RM 8,622.34.
  await req('POST', '/fixed-expenses', { name: 'House Rent', type: 'property', amount: 3754, active: true }, token)
  await req('POST', '/installments', { loanName: 'Car', type: 'vehicle', amount: 30000, monthlyInstallment: 4868.34, totalMonths: 12, paidMonths: 3, active: true }, token)

  // Position the historical month as an OPEN month that the lazy auto-close
  // rule spares (reopened_at set), so the test can close/reopen it for real.
  psql(`INSERT INTO belanja.monthly_entries (user_id, year, month, status, reopened_at)
        VALUES ('${uid}', ${prev.year}, ${prev.month}, 'OPEN', now());`)

  const seriesOf = async () => {
    const dash = (await req('GET', '/dashboard', undefined, token)).json
    return {
      prev: dash.series.find((s) => s.year === prev.year && s.month === prev.month),
      current: dash.series.find((s) => s.year === cy && s.month === cm),
    }
  }

  // -------------------------------------------------------------------
  // R0) The current month must be OPEN for the "live recurring" side of the
  //     contract to apply at all (opening it is explicit and read-only GETs
  //     never do it).
  // -------------------------------------------------------------------
  let r = await req('POST', `/monthly/${cy}/${cm}/open`, undefined, token)
  check('R0', `open current ${label({ year: cy, month: cm })} -> OPEN`, r.status === 200 && r.json.entry.status === 'OPEN', `status=${r.status}`)

  // -------------------------------------------------------------------
  // R1) CLOSE the historical month -> frozen snapshot (RM 8,622.34).
  // -------------------------------------------------------------------
  r = await req('POST', `/monthly/${prev.year}/${prev.month}/close`, undefined, token)
  check('R1', `close ${label(prev)} -> CLOSED`, r.status === 200 && r.json.entry.status === 'CLOSED', `status=${r.status}`)
  const entryId = psqlT(`SELECT id FROM belanja.monthly_entries WHERE user_id='${uid}' AND year=${prev.year} AND month=${prev.month}`)
  check('R1', 'snapshot rows exist for the closed month',
    psqlT(`SELECT count(*) FROM belanja.monthly_fixed_expenses WHERE monthly_entry_id='${entryId}'`) === '1' &&
    psqlT(`SELECT count(*) FROM belanja.monthly_installments WHERE monthly_entry_id='${entryId}'`) === '1')

  let s = await seriesOf()
  check('R1', `dashboard plots CLOSED ${label(prev)} = 8622.34`, s.prev && Number(s.prev.total) === 8622.34, `got ${s.prev && s.prev.total}`)
  check('R1', 'breakdown frozen 3754 / 4868.34 / 0 variable',
    Number(s.prev.fixed) === 3754 && Number(s.prev.installments) === 4868.34 && Number(s.prev.variable) === 0,
    `f=${s.prev && s.prev.fixed} i=${s.prev && s.prev.installments} v=${s.prev && s.prev.variable}`)

  // -------------------------------------------------------------------
  // R2) REOPEN it: the month must keep plotting the SAME snapshot. This is
  //     the reported bug - it used to collapse to "-" / 0 here.
  // -------------------------------------------------------------------
  r = await req('POST', `/monthly/${prev.year}/${prev.month}/reopen`, undefined, token)
  check('R2', `reopen ${label(prev)} -> OPEN + reopenedAt`, r.status === 200 && r.json.entry.status === 'OPEN' && !!r.json.entry.reopenedAt, `status=${r.status}`)
  check('R2', 'reopen did NOT delete the snapshot rows',
    psqlT(`SELECT count(*) FROM belanja.monthly_fixed_expenses WHERE monthly_entry_id='${entryId}'`) === '1' &&
    psqlT(`SELECT count(*) FROM belanja.monthly_installments WHERE monthly_entry_id='${entryId}'`) === '1')

  s = await seriesOf()
  check('R2', `REOPENED ${label(prev)} STILL on the dashboard = 8622.34 (not "-")`, s.prev && Number(s.prev.total) === 8622.34, `got ${s.prev && s.prev.total}`)
  check('R2', 'reopened month keeps its own frozen 3754 / 4868.34',
    Number(s.prev.fixed) === 3754 && Number(s.prev.installments) === 4868.34,
    `f=${s.prev && s.prev.fixed} i=${s.prev && s.prev.installments}`)
  r = await req('GET', `/monthly/${prev.year}/${prev.month}`, undefined, token)
  check('R2', 'monthly page agrees with the dashboard (frozen 8622.34)',
    Number(r.json.totals.total) === 8622.34 && r.json.entry.status === 'OPEN', `got ${r.json.totals.total} / ${r.json.entry.status}`)

  // -------------------------------------------------------------------
  // R3) A reopened month must NOT start inheriting the live masters.
  // -------------------------------------------------------------------
  await req('POST', '/fixed-expenses', { name: 'Insurance', type: 'bill', amount: 5000, active: true }, token)
  s = await seriesOf()
  check('R3', `reopened ${label(prev)} does NOT inherit the new live master (still 8622.34)`, Number(s.prev.total) === 8622.34, `got ${s.prev.total}`)
  check('R3', `current OPEN month DOES follow the live masters (13622.34)`, Number(s.current.total) === 13622.34, `got ${s.current.total}`)

  // -------------------------------------------------------------------
  // R4) A Credit Card expense recorded AFTER the reopen belongs to the
  //     reopened month only, and raises that month's total.
  // -------------------------------------------------------------------
  r = await req('POST', '/variable-expenses', { name: 'CC Statement', type: 'credit_card', amount: 100, expenseDate: ymd(prev, 20) }, token)
  check('R4', 'credit_card accepted as a Variable Expense type -> 201', r.status === 201, `status=${r.status} ${JSON.stringify(r.json.message || '')}`)
  check('R4', 'credit_card expense is owned by the reopened month',
    r.status === 201 && r.json.item.year === prev.year && r.json.item.month === prev.month && r.json.item.type === 'credit_card',
    `got ${r.json.item && r.json.item.year}-${r.json.item && r.json.item.month} ${r.json.item && r.json.item.type}`)
  check('R4', 'credit_card stored in the DB row',
    psqlT(`SELECT type||'|'||year||'|'||month FROM belanja.variable_expenses WHERE id='${r.json.item.id}'`) === `credit_card|${prev.year}|${prev.month}`)

  s = await seriesOf()
  check('R4', `reopened ${label(prev)} total rises to 8722.34`, Number(s.prev.total) === 8722.34, `got ${s.prev.total}`)
  check('R4', `current month untouched by the ${label(prev)} expense (13622.34)`, Number(s.current.total) === 13622.34, `got ${s.current.total}`)
  check('R4', 'no cross-month leakage (variable stays in its own month)',
    Number(s.prev.variable) === 100 && Number(s.current.variable) === 0, `prev.v=${s.prev.variable} cur.v=${s.current.variable}`)

  // -------------------------------------------------------------------
  // R5) CLOSE again -> the snapshot is refreshed from the live masters.
  // -------------------------------------------------------------------
  r = await req('POST', `/monthly/${prev.year}/${prev.month}/close`, undefined, token)
  check('R5', `close ${label(prev)} again -> CLOSED (snapshot refreshed)`, r.status === 200 && r.json.entry.status === 'CLOSED', `status=${r.status}`)
  s = await seriesOf()
  check('R5', `re-closed ${label(prev)} = 8754 + 4868.34 + 100 = 13722.34`, Number(s.prev.total) === 13722.34, `got ${s.prev.total}`)
  check('R5', 'refreshed snapshot picked up the corrected master (8754)', Number(s.prev.fixed) === 8754, `got ${s.prev.fixed}`)
  check('R5', 'no duplicate snapshot rows after the reopen/close cycle',
    psqlT(`SELECT count(*) FROM belanja.monthly_fixed_expenses WHERE monthly_entry_id='${entryId}'`) === '2' &&
    psqlT(`SELECT count(*) FROM belanja.monthly_installments WHERE monthly_entry_id='${entryId}'`) === '1')

  // -------------------------------------------------------------------
  // R6) Lifecycle invariants that must not regress.
  // -------------------------------------------------------------------
  r = await req('GET', `/monthly/${next.year}/${next.month}`, undefined, token)
  check('R6', `future ${label(next)} stays FUTURE / empty / read-only`,
    r.json.status === 'FUTURE' && r.json.entry === null && Number(r.json.totals.total) === 0, JSON.stringify(r.json.status))
  check('R6', 'future month is not part of the 12-month series',
    !(await req('GET', '/dashboard', undefined, token)).json.series.some((x) => x.year === next.year && x.month === next.month))
  check('R6', 'series still covers exactly 12 months', (await req('GET', '/dashboard', undefined, token)).json.series.length === 12)

  // Every pre-existing variable type must still be accepted, and a bogus one
  // must still be rejected. Run on a second user so the month totals asserted
  // above stay untouched.
  const other = await req('POST', '/auth/register', { name: 'Types User', email: `reopentypes${suffix}@t.local`, password: 'password123' })
  const t2 = other.json.token
  await req('POST', `/monthly/${cy}/${cm}/open`, undefined, t2)
  const accepted = []
  const expectedVariableTypes = ['food', 'groceries', 'parent', 'toll', 'fuel', 'credit_card', 'bill', 'shopee_paylater', 'tiktok_paylater', 'atome', 'hutang_orang', 'belanja_orang', 'others']
  for (const type of expectedVariableTypes) {
    const rr = await req('POST', '/variable-expenses', { name: `T ${type}`, type, amount: 1, expenseDate: ymd({ year: cy, month: cm }, 1) }, t2)
    accepted.push(`${type}:${rr.status}`)
  }
  check('R6', 'all 13 variable expense types accepted', accepted.every((x) => x.endsWith(':201')), accepted.join(' '))
  const bogus = await req('POST', '/variable-expenses', { name: 'Bogus', type: 'not_a_type', amount: 1, expenseDate: ymd({ year: cy, month: cm }, 1) }, t2)
  check('R6', 'unknown type still rejected with 400', bogus.status === 400, `status=${bogus.status}`)
  const list = (await req('GET', `/variable-expenses?year=${cy}&month=${cm}`, undefined, t2)).json
  check('R6', 'all 13 variable records are listed back with their exact types',
    expectedVariableTypes.every((t) => list.items.some((i) => i.type === t)),
    list.items.map((i) => i.type).join(','))

  console.log(`\n${failed === 0 ? 'ALL REOPEN-DASHBOARD TESTS PASSED' : `${failed} TEST(S) FAILED`}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
