import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Host-side fixture for tests/browser/test-dashboard-reopen.cjs.
//
// The browser suite runs inside the Playwright container, which has no docker
// CLI and no psql, so it cannot position a HISTORICAL month in the database.
// The API deliberately refuses to open a past month (past months can only be
// reopened), so this is the only way to produce the "September is CLOSED, then
// September is REOPENED" state the browser test needs to observe.
//
// This seeds ONE dedicated fixture account (`reopenui@fixture.local`) with a
// recurring fixed expense + installment, exactly like the other tests create
// their own throwaway users. It never touches any real user's data.
// ---------------------------------------------------------------------------
const BASE = 'http://localhost:8080/api'
const email = 'reopenui@fixture.local'
const password = 'password123'

async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

function psql(sql) {
  const out = spawnSync('docker', ['exec', 'belanja-db-1', 'psql', '-U', 'belanja', '-d', 'belanja', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('psql failed: ' + (out.stderr || ''))
  return out
}
function psqlT(sql) {
  const out = spawnSync('docker', ['exec', 'belanja-db-1', 'psql', '-U', 'belanja', '-d', 'belanja', '-tA', '-c', sql], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('psql failed: ' + (out.stderr || ''))
  return out.stdout.trim()
}

const back = (y, m, n) => { const t = y * 12 + m - n - 1; return { year: Math.floor(t / 12), month: (t % 12) + 1 } }

async function main() {
  // --- fixture account (reused across runs so the browser test can log in) ---
  let token = null
  const login = await req('POST', '/auth/login', { email, password })
  if (login.status === 200) {
    token = login.json.token
  } else {
    const reg = await req('POST', '/auth/register', { name: 'Reopen UI', email, password })
    if (reg.status !== 201) throw new Error(`fixture register failed: ${reg.status} ${JSON.stringify(reg.json)}`)
    token = reg.json.token
  }
  const uid = psqlT(`SELECT id FROM belanja.users WHERE email='${email}'`)

  // --- reset the fixture's month state so the run is deterministic ---
  const cur = (await req('GET', '/monthly/current', undefined, token)).json
  const cy = cur.year
  const cm = cur.month
  const prev = back(cy, cm, 1)

  psql(`DELETE FROM belanja.variable_expenses WHERE user_id = '${uid}';`)
  psql(`DELETE FROM belanja.monthly_entries WHERE user_id = '${uid}';`)

  // --- recurring masters: fixed 3754 + installment 4868.34 = RM 8,622.34 ---
  const fixed = await req('GET', '/fixed-expenses', undefined, token)
  if (fixed.json.items.length === 0) {
    await req('POST', '/fixed-expenses', { name: 'House Rent', type: 'property', amount: 3754, active: true }, token)
    await req('POST', '/installments', { loanName: 'Car', type: 'vehicle', amount: 30000, monthlyInstallment: 4868.34, totalMonths: 12, paidMonths: 3, active: true }, token)
  }

  // --- open + close the current month, and position the historical month as
  //     an OPEN month that the lazy auto-close rule spares (reopened_at set),
  //     then close it so it owns a real frozen snapshot ---
  await req('POST', `/monthly/${cy}/${cm}/open`, undefined, token)
  await req('POST', `/monthly/${cy}/${cm}/close`, undefined, token)
  psql(`INSERT INTO belanja.monthly_entries (user_id, year, month, status, reopened_at)
        VALUES ('${uid}', ${prev.year}, ${prev.month}, 'OPEN', now());`)
  const closed = await req('POST', `/monthly/${prev.year}/${prev.month}/close`, undefined, token)
  if (closed.status !== 200 || closed.json.entry.status !== 'CLOSED') {
    throw new Error(`fixture: could not close ${prev.year}-${prev.month}: ${closed.status}`)
  }

  const entryId = psqlT(`SELECT id FROM belanja.monthly_entries WHERE user_id='${uid}' AND year=${prev.year} AND month=${prev.month}`)
  const fx = psqlT(`SELECT count(*) FROM belanja.monthly_fixed_expenses WHERE monthly_entry_id='${entryId}'`)
  const inst = psqlT(`SELECT count(*) FROM belanja.monthly_installments WHERE monthly_entry_id='${entryId}'`)
  if (fx !== '1' || inst !== '1') throw new Error(`fixture: snapshot missing (fixed=${fx} installments=${inst})`)

  console.log(`[seed-reopen] ready: current=${cy}-${cm} CLOSED, historical=${prev.year}-${prev.month} CLOSED with snapshot (fixed=${fx}, installments=${inst})`)
}

main().catch((e) => { console.error('[seed-reopen]', e.message); process.exit(1) })
