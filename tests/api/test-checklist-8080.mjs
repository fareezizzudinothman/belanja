const BASE = 'http://localhost:8080/api'
const suffix = Date.now() % 100000
const email = `checklist${suffix}@t.local`
let failed = 0

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
  if (!cond) failed++
}

const pad = (n) => String(n).padStart(2, '0')
const keyOf = (item) => `${item.expense_type}:${item.source_id}`

async function main() {
  let r = await req('POST', '/auth/register', { name: 'Checklist User', email, password: 'password123' })
  const token = r.json.token
  check('register checklist user', r.status === 201 && !!token)

  const current = (await req('GET', '/monthly/current', undefined, token)).json
  const year = current.year
  const month = current.month
  const date = `${year}-${pad(month)}-02`

  r = await req('POST', '/fixed-expenses', { name: 'Fixed Bill', type: 'bill', amount: 100, active: true }, token)
  const fixedId = r.json.item?.id
  check('create active fixed expense', r.status === 201 && !!fixedId)

  r = await req('POST', '/installments', {
    loanName: 'Installment Bill',
    type: 'bill',
    amount: 1200,
    totalMonths: 12,
    monthlyInstallment: 100,
    startDate: `${year}-${pad(month)}-01`,
  }, token)
  const installmentId = r.json.item?.id
  check('create active installment', r.status === 201 && !!installmentId)

  r = await req('POST', `/monthly/${year}/${month}/open`, undefined, token)
  check('open checklist month', r.status === 200 && r.json.entry?.status === 'OPEN')

  r = await req('POST', '/variable-expenses', { name: 'Existing Variable', type: 'bill', amount: 50, expenseDate: date }, token)
  const existingVariableId = r.json.item?.id
  check('create existing variable expense', r.status === 201 && !!existingVariableId)

  // TEST 1: first checklist read includes all expenses already in the month.
  r = await req('GET', `/checklist/${year}/${month}`, undefined, token)
  let items = r.json.items || []
  check('TEST 1: existing expenses appear',
    r.status === 200 &&
      items.some((item) => item.expense_type === 'fixed' && item.source_id === fixedId) &&
      items.some((item) => item.expense_type === 'installment' && item.source_id === installmentId) &&
      items.some((item) => item.expense_type === 'variable' && item.source_id === existingVariableId))

  const existingItem = items.find((item) => item.source_id === existingVariableId)
  r = await req('PATCH', `/checklist/${existingItem.id}`, { paid: true }, token)
  check('mark an existing checklist item paid', r.status === 200 && r.json.item?.paid === true)
  const paidAt = r.json.item?.paid_at

  // TEST 2/3: add expenses after checklist initialization and preserve payment state.
  await req('POST', '/variable-expenses', { name: 'Bil Api', type: 'bill', amount: 202, expenseDate: date }, token)
  await req('POST', '/variable-expenses', { name: 'Bil Air', type: 'bill', amount: 29, expenseDate: date }, token)
  r = await req('GET', `/checklist/${year}/${month}`, undefined, token)
  items = r.json.items || []
  const refreshedExisting = items.find((item) => item.id === existingItem.id)
  check('TEST 2: newly-added variable expenses appear',
    items.some((item) => item.expense_type === 'variable' && item.name === 'Bil Api' && Number(item.amount) === 202) &&
      items.some((item) => item.expense_type === 'variable' && item.name === 'Bil Air' && Number(item.amount) === 29))
  check('TEST 3: existing paid item and paid_at are preserved',
    refreshedExisting?.paid === true && refreshedExisting?.paid_at === paidAt)

  // TEST 4: repeated reads never create a second row for a source expense.
  await req('GET', `/checklist/${year}/${month}`, undefined, token)
  const keys = items.map(keyOf)
  check('TEST 4: repeated checklist reads do not duplicate rows',
    keys.length === new Set(keys).size && items.length === 5)

  // TEST 5: all three source categories are represented.
  check('TEST 5: fixed, installment, and variable categories appear',
    new Set(items.map((item) => item.expense_type)).size === 3 &&
      items.filter((item) => item.expense_type === 'fixed').length === 1 &&
      items.filter((item) => item.expense_type === 'installment').length === 1 &&
      items.filter((item) => item.expense_type === 'variable').length === 3)

  // TEST 6: closing makes checklist writes read-only but does not hide rows.
  r = await req('POST', `/monthly/${year}/${month}/close`, undefined, token)
  check('close checklist month', r.status === 200 && r.json.status === 'CLOSED')
  r = await req('GET', `/checklist/${year}/${month}`, undefined, token)
  const closedItems = r.json.items || []
  check('TEST 6: closed month displays all checklist items',
    r.status === 200 && closedItems.length === 5 && closedItems.some((item) => item.name === 'Bil Api') && closedItems.some((item) => item.name === 'Bil Air'))
  r = await req('PATCH', `/checklist/${existingItem.id}`, { paid: false }, token)
  check('TEST 6: closed month rejects paid-status changes', r.status === 409)
  const closedExisting = (await req('GET', `/checklist/${year}/${month}`, undefined, token)).json.items.find((item) => item.id === existingItem.id)
  check('TEST 6: closed month preserves paid status', closedExisting?.paid === true && closedExisting?.paid_at === paidAt)

  // TEST 7: reopening keeps paid state and syncs another expense.
  r = await req('POST', `/monthly/${year}/${month}/reopen`, undefined, token)
  check('reopen checklist month', r.status === 200 && r.json.entry?.status === 'OPEN')
  await req('POST', '/variable-expenses', { name: 'Added After Reopen', type: 'bill', amount: 10, expenseDate: date }, token)
  r = await req('GET', `/checklist/${year}/${month}`, undefined, token)
  const reopenedItems = r.json.items || []
  const reopenedExisting = reopenedItems.find((item) => item.id === existingItem.id)
  check('TEST 7: reopened month synchronizes new expenses and preserves paid state',
    reopenedItems.some((item) => item.name === 'Added After Reopen') &&
      reopenedExisting?.paid === true && reopenedExisting?.paid_at === paidAt)

  console.log(`\n${failed === 0 ? 'ALL CHECKLIST TESTS PASSED' : `${failed} CHECKLIST TEST(S) FAILED`}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
