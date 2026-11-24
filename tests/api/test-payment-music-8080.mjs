const BASE = 'http://localhost:8080/api'
const suffix = Date.now() % 100000
const A_EMAIL = `paymentmusic-a${suffix}@t.local`
const B_EMAIL = `paymentmusic-b${suffix}@t.local`
const VIDEO_ID = 'dQw4w9WgXcQ'
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

async function main() {
  let r = await req('POST', '/auth/register', { name: 'Payment Music A', email: A_EMAIL, password: 'password123' })
  const tokenA = r.json.token
  check('register payment music user A', r.status === 201 && !!tokenA)

  r = await req('POST', '/auth/register', { name: 'Payment Music B', email: B_EMAIL, password: 'password123' })
  const tokenB = r.json.token
  check('register payment music user B', r.status === 201 && !!tokenB)

  r = await req('GET', '/profile/payment-music', undefined, tokenA)
  check('TEST 1: default music setting is OFF',
    r.status === 200 && r.json.setting?.enabled === false && r.json.setting?.youtubeUrl === '' && r.json.setting?.youtubeId === null)

  r = await req('PATCH', '/profile/payment-music', {
    enabled: true,
    youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  }, tokenA)
  check('TEST 2: save YouTube URL + ON',
    r.status === 200 && r.json.setting?.enabled === true && r.json.setting?.youtubeId === VIDEO_ID)

  r = await req('PATCH', '/profile/payment-music', { enabled: false }, tokenA)
  check('TEST 3: turn music OFF without a URL',
    r.status === 200 && r.json.setting?.enabled === false)

  r = await req('PATCH', '/profile/payment-music', {
    enabled: true,
    youtubeUrl: 'https://example.com/watch?v=dQw4w9WgXcQ',
  }, tokenA)
  check('TEST 4: invalid YouTube URL is rejected', r.status === 400)

  r = await req('GET', '/profile/payment-music', undefined, tokenB)
  check('TEST 5: user B cannot access user A setting',
    r.status === 200 && r.json.setting?.enabled === false && r.json.setting?.youtubeUrl === '')

  r = await req('PATCH', '/profile/payment-music', {
    enabled: true,
    youtubeUrl: `https://youtu.be/${VIDEO_ID}`,
  }, tokenB)
  check('supported youtu.be URL stores only its video ID',
    r.status === 200 && r.json.setting?.youtubeId === VIDEO_ID)

  r = await req('PATCH', '/profile/payment-music', {
    enabled: true,
    youtubeUrl: `https://www.youtube.com/embed/${VIDEO_ID}`,
  }, tokenA)
  check('supported embed URL stores only its video ID',
    r.status === 200 && r.json.setting?.youtubeId === VIDEO_ID)

  console.log(`\n${failed === 0 ? 'ALL PAYMENT MUSIC API TESTS PASSED' : `${failed} PAYMENT MUSIC API TEST(S) FAILED`}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
