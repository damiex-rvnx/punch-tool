// QR Clock-Bot - Cloudflare Worker
// Schedules iOS background push notifications via VAPID Web Push (RFC 8291 / 8292)
//
// Secrets required (set in Cloudflare dashboard or via CI):
//   VAPID_PRIVATE_KEY  - base64url PKCS8 EC private key
//
// KV binding:
//   KV  - namespace for storing pending notification schedules

const ALLOWED      = 'https://lbrito1126.github.io'
const VAPID_SUBJECT = 'mailto:qr-clock-bot@example.com'
// Public key is not secret - safe to inline
const VAPID_PUBLIC_KEY = 'BC_wlEOLqTvLMDJK0ZntTkZQtKGVMNXIDmofUr-MlcPPN25lrlhzrFDpDTUYoftr2kXngLqSSxdIsbcTtJfBIv4'

const cors = {
  'Access-Control-Allow-Origin':  ALLOWED,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Lazy-loaded CryptoKey for VAPID signing (cached per isolate lifetime)
let _vapidPrivKey = null
async function getVapidPrivKey(env) {
  if (!_vapidPrivKey) {
    const raw = b64url_decode(env.VAPID_PRIVATE_KEY)
    _vapidPrivKey = await crypto.subtle.importKey(
      'pkcs8', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    )
  }
  return _vapidPrivKey
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    if (request.method === 'GET') {
      if (url.pathname === '/ping')
        return new Response('pong', { headers: { 'Access-Control-Allow-Origin': '*' } })
      if (url.pathname === '/vapid-public-key')
        return new Response(VAPID_PUBLIC_KEY, { headers: { ...cors, 'Content-Type': 'text/plain' } })

      // Debug: return KV record for a device
      if (url.pathname === '/status') {
        const deviceId = url.searchParams.get('deviceId')
        if (!deviceId) return respond({ error: 'missing deviceId' }, 400)
        const raw = await env.KV.get(`sched_${deviceId}`)
        if (!raw) return respond({ exists: false })
        const rec = JSON.parse(raw)
        const sorted = [...rec.schedule].sort((a, b) =>
          new Date(a.fireAtISO).getTime() - new Date(b.fireAtISO).getTime()
        )
        const now = Date.now()
        const next = sorted.find(s => new Date(s.fireAtISO).getTime() > now)
        return respond({
          exists: true,
          endpoint_host: new URL(rec.subscription.endpoint).host,
          schedule_count: rec.schedule.length,
          next_fire_iso: next?.fireAtISO ?? null,
          next_fire_in_sec: next ? Math.round((new Date(next.fireAtISO).getTime() - now) / 1000) : null,
          schedule_preview: sorted.map(s => ({ id: s.id, fireAtISO: s.fireAtISO })),
          now_iso: new Date().toISOString(),
        })
      }

      // Debug: dump recent cron runs to verify scheduler is firing
      if (url.pathname === '/cron-log') {
        const raw = await env.KV.get('cron_log')
        return respond(raw ? JSON.parse(raw) : [])
      }

      // Debug: immediately send a test push to this device
      if (url.pathname === '/test-push') {
        const deviceId = url.searchParams.get('deviceId')
        if (!deviceId) return respond({ error: 'missing deviceId' }, 400)
        const raw = await env.KV.get(`sched_${deviceId}`)
        if (!raw) return respond({ error: 'no subscription stored' }, 404)
        const rec = JSON.parse(raw)
        try {
          await sendPush(rec.subscription, {
            title: 'QR Clock-Bot TEST',
            body:  'If you see this, push delivery works ✓',
            icon:  '/qwik-crew-clock/icon-192.png',
            tag:   'test',
          }, env)
          return respond({ ok: true, sent_at: new Date().toISOString() })
        } catch (e) {
          return respond({ ok: false, error: e.message }, 500)
        }
      }
    }

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

    let body
    try { body = await request.json() } catch {
      return respond({ error: 'Bad JSON' }, 400)
    }

    const { action } = body

    if (action === 'subscribe') {
      const { deviceId, subscription, schedule } = body
      if (!deviceId || !subscription || !schedule?.length)
        return respond({ error: 'Missing deviceId, subscription, or schedule' }, 400)
      await env.KV.put(`sched_${deviceId}`,
        JSON.stringify({ subscription, schedule }),
        { expirationTtl: 172800 }  // 2 days
      )
      return respond({ ok: true })
    }

    if (action === 'cancel') {
      const { deviceId } = body
      if (deviceId) await env.KV.delete(`sched_${deviceId}`)
      return respond({ ok: true })
    }

    return respond({ error: 'Unknown action' }, 400)
  },

  // Cron trigger: runs every minute, sends push for due notifications
  async scheduled(_event, env) {
    const now = Date.now()
    const window_ms = 90_000  // 90-second window around cron fire time
    const log = { ran_at: new Date(now).toISOString(), devices: 0, sent: [], dropped: [], errors: [], future: 0 }

    const { keys } = await env.KV.list({ prefix: 'sched_' })
    log.devices = keys.length

    for (const { name } of keys) {
      const raw = await env.KV.get(name)
      if (!raw) continue
      let record
      try { record = JSON.parse(raw) } catch { continue }

      const { subscription, schedule } = record
      const remaining = []

      for (const item of schedule) {
        const fireAt = new Date(item.fireAtISO).getTime()
        const due     = fireAt <= now + window_ms && fireAt > now - window_ms
        const future  = fireAt > now + window_ms

        if (due) {
          try {
            await sendPush(subscription, {
              title: 'QR Clock-Bot',
              body:  `${item.emoji}  ${item.label}`,
              icon:  '/qwik-crew-clock/icon-192.png',
              tag:   item.id,
            }, env)
            log.sent.push({ id: item.id, fireAtISO: item.fireAtISO })
          } catch (e) {
            log.errors.push({ id: item.id, err: e.message })
            if (!e.message?.includes('GONE')) remaining.push(item)
          }
        } else if (future) {
          remaining.push(item)
          log.future++
        } else {
          log.dropped.push({ id: item.id, fireAtISO: item.fireAtISO, late_by_sec: Math.round((now - fireAt) / 1000) })
        }
      }

      if (remaining.length === 0) {
        await env.KV.delete(name)
      } else {
        await env.KV.put(name, JSON.stringify({ subscription, schedule: remaining }), { expirationTtl: 172800 })
      }
    }

    // Persist last 20 cron runs for debugging
    try {
      const prev = await env.KV.get('cron_log')
      const arr  = prev ? JSON.parse(prev) : []
      arr.unshift(log)
      await env.KV.put('cron_log', JSON.stringify(arr.slice(0, 20)), { expirationTtl: 172800 })
    } catch {}
  },
}

// --- Web Push send -------------------------------------------------------------

async function sendPush(subscription, data, env) {
  const privKey    = await getVapidPrivKey(env)
  const authHeader = await buildVapidAuth(subscription.endpoint, privKey)
  const body       = await encryptPayload(JSON.stringify(data), subscription.keys)

  const res = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    authHeader,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '600',       // 10 min - keep trying if device offline briefly
      'Urgency':          'high',      // APNs priority 10 - deliver immediately, don't batch
    },
    body,
  })

  if (res.status === 410 || res.status === 404) {
    throw new Error('GONE: subscription expired')
  }
  if (!res.ok && res.status !== 201) {
    const txt = await res.text().catch(() => '')
    throw new Error(`push HTTP ${res.status}: ${txt}`)
  }
}

// --- VAPID JWT (RFC 8292) ------------------------------------------------------

async function buildVapidAuth(endpoint, privKey) {
  const origin = new URL(endpoint).origin
  const exp    = Math.floor(Date.now() / 1000) + 43200  // 12 h

  const hdr    = b64url_json({ typ: 'JWT', alg: 'ES256' })
  const claims = b64url_json({ aud: origin, exp, sub: VAPID_SUBJECT })

  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      enc(`${hdr}.${claims}`)
    )
  )

  return `vapid t=${hdr}.${claims}.${b64url_bytes(sig)},k=${VAPID_PUBLIC_KEY}`
}

// --- aes128gcm payload encryption (RFC 8291) ----------------------------------

async function encryptPayload(plaintext, keys) {
  const ua_public   = b64url_decode(keys.p256dh)  // 65-byte uncompressed EC point
  const auth_secret = b64url_decode(keys.auth)    // 16-byte auth secret

  // Ephemeral sender key pair
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )
  const as_public = new Uint8Array(await crypto.subtle.exportKey('raw', senderPair.publicKey))

  // Import subscriber's public key
  const ua_key = await crypto.subtle.importKey(
    'raw', ua_public, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )

  // ECDH shared secret (32 bytes)
  const ecdh_secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: ua_key }, senderPair.privateKey, 256)
  )

  // Phase 1: derive IKM from auth secret + ECDH secret
  const auth_info = cat(enc('WebPush: info\x00'), ua_public, as_public)
  const prk_key   = await hmac_sha256(auth_secret, ecdh_secret)
  const ikm       = (await hmac_sha256(prk_key, cat(auth_info, new Uint8Array([1])))).slice(0, 32)

  // Phase 2: derive CEK (16 bytes) and nonce (12 bytes) from random salt
  const salt      = crypto.getRandomValues(new Uint8Array(16))
  const prk       = await hmac_sha256(salt, ikm)
  const cek       = (await hmac_sha256(prk, cat(enc('Content-Encoding: aes128gcm\x00'), new Uint8Array([1])))).slice(0, 16)
  const nonce     = (await hmac_sha256(prk, cat(enc('Content-Encoding: nonce\x00'),      new Uint8Array([1])))).slice(0, 12)

  // Encrypt: AES-128-GCM with \x02 padding delimiter for final record
  const aes_key    = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes_key, cat(enc(plaintext), new Uint8Array([2])))
  )

  // aes128gcm header: salt(16) + rs_uint32_be(4) + idlen(1) + sender_pub(65)
  const header = new Uint8Array(21 + as_public.length)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096, false)
  header[20] = as_public.length
  header.set(as_public, 21)

  return cat(header, ciphertext).buffer
}

// --- Crypto helpers ------------------------------------------------------------

async function hmac_sha256(key_bytes, data) {
  const key = await crypto.subtle.importKey('raw', key_bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
}

// --- Encoding helpers ----------------------------------------------------------

function enc(str) { return new TextEncoder().encode(str) }

function cat(...arrays) {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0))
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

function b64url_decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

function b64url_bytes(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64url_json(obj) {
  return btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
