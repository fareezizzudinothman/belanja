'use strict'

const { Router } = require('express')
const { asyncHandler, AppError } = require('../utils/http')
const { validateBody } = require('../middleware/validate')
const { requireAuth } = require('../middleware/auth')
const paymentMusicService = require('../services/paymentMusicService')

const router = Router()
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

function extractYouTubeId(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  let id = null

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    if (parts.length === 1) id = parts[0]
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v')
    } else if (parts.length === 2 && parts[0] === 'embed') {
      id = parts[1]
    }
  }

  return id && YOUTUBE_ID.test(id) ? id : null
}

function validateEnabled(value) {
  return typeof value === 'boolean'
    ? value
    : new AppError(400, 'enabled must be true or false')
}

function validateYouTubeUrl(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return new AppError(400, 'youtubeUrl must be a string')

  const url = value.trim()
  if (!url) return null

  const youtubeId = extractYouTubeId(url)
  return youtubeId || new AppError(400, 'youtubeUrl must be a valid supported YouTube URL')
}

function publicSetting(setting) {
  return {
    enabled: setting.enabled,
    youtubeId: setting.youtubeId,
    youtubeUrl: setting.youtubeId ? `https://www.youtube.com/watch?v=${setting.youtubeId}` : '',
  }
}

router.use(requireAuth)

// GET /api/profile/payment-music
router.get(
  '/payment-music',
  asyncHandler(async (req, res) => {
    const setting = await paymentMusicService.getForUser(req.user.id)
    res.json({ status: 'ok', setting: publicSetting(setting) })
  })
)

// PATCH /api/profile/payment-music
router.patch(
  '/payment-music',
  validateBody({ enabled: validateEnabled, youtubeUrl: validateYouTubeUrl }),
  asyncHandler(async (req, res) => {
    const setting = await paymentMusicService.saveForUser(req.user.id, {
      enabled: req.clean.enabled,
      youtubeId: req.clean.youtubeUrl,
    })
    res.json({ status: 'ok', setting: publicSetting(setting) })
  })
)

module.exports = router
