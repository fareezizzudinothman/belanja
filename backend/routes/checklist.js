'use strict'

const { Router } = require('express')
const { asyncHandler, AppError } = require('../utils/http')
const { requireAuth } = require('../middleware/auth')
const { validateYear, validateMonth } = require('../utils/validators')
const checklistService = require('../services/checklistService')

const router = Router()

router.use(requireAuth)

// GET /api/checklist/:year/:month
router.get(
  '/:year/:month',
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req)
    const items = await checklistService.listForMonth(req.user.id, year, month)
    res.json({ status: 'ok', items })
  })
)

// PATCH /api/checklist/:id
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const { paid } = req.body

    if (paid === undefined || paid === null) {
      throw new AppError(400, 'paid is required (true or false)')
    }
    if (typeof paid !== 'boolean') {
      throw new AppError(400, 'paid must be true or false')
    }

    const item = await checklistService.togglePaid(req.user.id, id, paid)
    if (!item) throw new AppError(404, 'Checklist item not found')

    res.json({ status: 'ok', item })
  })
)

// Helper to parse year/month from params
function parseYearMonth(req) {
  const { year, month } = req.params
  const y = validateYear(year)
  const m = validateMonth(month)
  if (y instanceof AppError) throw y
  if (m instanceof AppError) throw m
  return { year: y, month: m }
}

module.exports = router