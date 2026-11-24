'use strict'

const { query } = require('../db/pool')
const { AppError } = require('../utils/http')
const variableExpenseService = require('./variableExpenseService')
const fixedExpenseService = require('./fixedExpenseService')
const installmentService = require('./installmentService')

function mapRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    year: row.year,
    month: row.month,
    expense_type: row.expense_type,
    source_id: row.source_id,
    name: row.name,
    amount: Number(row.amount),
    paid: row.paid,
    paid_at: row.paid_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function listForMonth(userId, year, month) {
  // Synchronize on every read. Existing rows are left untouched so paid and
  // paid_at survive while expenses added after the first read are inserted.
  await deriveChecklistFromExpenses(userId, year, month)

  const { rows } = await query(
    `SELECT id, user_id, year, month, expense_type, source_id, name, amount, paid, paid_at, created_at, updated_at
     FROM belanja.monthly_payment_checklist
     WHERE user_id = $1 AND year = $2 AND month = $3
     ORDER BY expense_type ASC, name ASC`,
    [userId, year, month]
  )
  return rows.map(mapRow)
}

async function deriveChecklistFromExpenses(userId, year, month) {
  const items = []

  // 1. Fixed expenses: active fixed expenses of the user
  const fixedExpenses = await fixedExpenseService.listForUser(userId, { includeInactive: false })
  for (const f of fixedExpenses) {
    items.push({
      user_id: userId,
      year,
      month,
      expense_type: 'fixed',
      source_id: f.id,
      name: f.name,
      amount: f.amount,
      paid: false,
      paid_at: null,
    })
  }

  // 2. Installments: active installments of the user
  const installments = await installmentService.listForUser(userId, { includeInactive: false })
  for (const i of installments) {
    items.push({
      user_id: userId,
      year,
      month,
      expense_type: 'installment',
      source_id: i.id,
      name: i.loanName,
      amount: i.monthlyInstallment,
      paid: false,
      paid_at: null,
    })
  }

  // 3. Variable expenses: variable expenses whose expense_date falls in this month
  const varRows = await variableExpenseService.listForMonth(userId, year, month)
  for (const v of varRows) {
    items.push({
      user_id: userId,
      year,
      month,
      expense_type: 'variable',
      source_id: v.id,
      name: v.name,
      amount: Number(v.amount),
      paid: false,
      paid_at: null,
    })
  }

  // Insert all items (ignore duplicates due to unique constraint)
  for (const item of items) {
    try {
      await query(
        `INSERT INTO belanja.monthly_payment_checklist (user_id, year, month, expense_type, source_id, name, amount, paid, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, year, month, expense_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [item.user_id, item.year, item.month, item.expense_type, item.source_id, item.name, item.amount, item.paid, item.paid_at]
      )
    } catch (err) {
      // Ignore duplicate key errors - another request may have inserted it
      if (!err.message.includes('duplicate key')) throw err
    }
  }

  // Return all items (including any that were already created by another request)
  const { rows } = await query(
    `SELECT id, user_id, year, month, expense_type, source_id, name, amount, paid, paid_at, created_at, updated_at
     FROM belanja.monthly_payment_checklist
     WHERE user_id = $1 AND year = $2 AND month = $3
     ORDER BY expense_type ASC, name ASC`,
    [userId, year, month]
  )
  return rows.map(mapRow)
}

async function getForUser(userId, id) {
  const { rows } = await query(
    `SELECT id, user_id, year, month, expense_type, source_id, name, amount, paid, paid_at, created_at, updated_at
     FROM belanja.monthly_payment_checklist
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

async function togglePaid(userId, id, paid) {
  const { rows: currentRows } = await query(
    `SELECT c.id, e.status AS month_status
     FROM belanja.monthly_payment_checklist c
     LEFT JOIN belanja.monthly_entries e
       ON e.user_id = c.user_id AND e.year = c.year AND e.month = c.month
     WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]
  )
  if (!currentRows[0]) return null
  if (currentRows[0].month_status === 'CLOSED') {
    throw new AppError(409, 'This month is closed and its payment checklist is read-only.')
  }

  const paidAt = paid ? new Date() : null

  const { rows } = await query(
    `UPDATE belanja.monthly_payment_checklist
     SET paid = $1, paid_at = $2, updated_at = now()
      WHERE id = $3 AND user_id = $4
        AND NOT EXISTS (
          SELECT 1
          FROM belanja.monthly_entries e
          WHERE e.user_id = monthly_payment_checklist.user_id
            AND e.year = monthly_payment_checklist.year
            AND e.month = monthly_payment_checklist.month
            AND e.status = 'CLOSED'
        )
      RETURNING id, user_id, year, month, expense_type, source_id, name, amount, paid, paid_at, created_at, updated_at`,
    [paid, paidAt, id, userId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

module.exports = {
  listForMonth,
  getForUser,
  togglePaid,
}
