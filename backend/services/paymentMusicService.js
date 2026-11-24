'use strict'

const { query } = require('../db/pool')
const { AppError } = require('../utils/http')

function mapRow(row) {
  return {
    enabled: row.payment_music_enabled,
    youtubeId: row.payment_music_youtube_id,
  }
}

async function getForUser(userId) {
  const { rows } = await query(
    `SELECT payment_music_enabled, payment_music_youtube_id
     FROM belanja.user_payment_settings
     WHERE user_id = $1`,
    [userId]
  )
  return rows[0] ? mapRow(rows[0]) : { enabled: false, youtubeId: null }
}

async function saveForUser(userId, { enabled, youtubeId }) {
  const existing = await getForUser(userId)
  const resolvedYoutubeId = youtubeId === undefined ? existing.youtubeId : youtubeId
  if (enabled && !resolvedYoutubeId) {
    throw new AppError(400, 'A valid YouTube URL is required when music is ON')
  }

  const { rows } = await query(
    `INSERT INTO belanja.user_payment_settings
       (user_id, payment_music_enabled, payment_music_youtube_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       payment_music_enabled = EXCLUDED.payment_music_enabled,
       payment_music_youtube_id = EXCLUDED.payment_music_youtube_id
     RETURNING payment_music_enabled, payment_music_youtube_id`,
    [userId, enabled, resolvedYoutubeId]
  )
  return mapRow(rows[0])
}

module.exports = { getForUser, saveForUser }
