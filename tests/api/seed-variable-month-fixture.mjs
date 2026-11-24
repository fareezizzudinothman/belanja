import { spawnSync } from 'node:child_process'

// Host-side fixture for tests/browser/test-variable-month.cjs. The API does not
// allow a brand-new past month to be opened, so the previous month is positioned
// as an explicitly reopened month before its test expense is created.
const BASE = 'http://localhost:8080/api'
const email = 'variablemonth@fixture.local'
const password = 'password123'

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

function psql(sql, tuple = false) {
  const args = ['exec', 'belanja-db-1', 'psql', '-U', 'belanja', '-d', 'belanja', '-v', 'ON_ERROR_STOP=1']
  if (tuple) args.push('-tA')
  args.push('-c', sql)
  const out = spawnSync('docker', args, { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('psql failed: ' + (out.stderr || ''))
  return tuple ? out.stdout.trim() : out
}

function previousMonth(year, month) {
  const index = year * 12 + month - 2
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

async function main() {
  let login = await req('POST', '/auth/login', { email, password })
  let token = login.status === 200 ? login.json.token : null
  if (!token) {
    const registered = await req('POST', '/auth/register', { name: 'Variable Month Fixture', email, password })
    if (registered.status !== 201) throw new Error(`fixture register failed: ${registered.status} ${JSON.stringify(registered.json)}`)
    token = registered.json.token
  }

  const uid = psql(`SELECT id FROM belanja.users WHERE email='${email}'`, true)
  const current = (await req('GET', '/monthly/current', undefined, token)).json
  const previous = previousMonth(current.year, current.month)

  // Keep this fixture account isolated and deterministic between runs.
  psql(`DELETE FROM belanja.variable_expenses WHERE user_id = '${uid}'; DELETE FROM belanja.monthly_entries WHERE user_id = '${uid}';`)
  psql(`INSERT INTO belanja.monthly_entries (user_id, year, month, status, reopened_at)
        VALUES ('${uid}', ${previous.year}, ${previous.month}, 'OPEN', now());`)

  const expense = await req('POST', '/variable-expenses', {
    name: 'Previous month expense',
    type: 'food',
    amount: 42.5,
    expenseDate: `${previous.year}-${String(previous.month).padStart(2, '0')}-15`,
  }, token)
  if (expense.status !== 201) throw new Error(`fixture expense failed: ${expense.status} ${JSON.stringify(expense.json)}`)

  console.log(`[seed-variable-month] ready: current=${current.year}-${current.month}, previous=${previous.year}-${previous.month}`)
}

main().catch((err) => { console.error('[seed-variable-month]', err.message); process.exit(1) })
