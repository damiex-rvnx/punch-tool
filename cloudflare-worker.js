// QR Clock-Bot - Cloudflare Worker
// Schedules and cancels OneSignal push notifications on behalf of each device.
//
// Environment variable required (set as a Secret in Cloudflare dashboard):
//   ONESIGNAL_REST_KEY  - found in OneSignal dashboard > Settings > Keys & IDs

const APP_ID   = 'a075be77-5334-4e47-b8a4-ff6de2836198'
const OS_API   = 'https://onesignal.com/api/v1/notifications'
const ALLOWED  = 'https://lbrito1126.github.io'

const cors = {
  'Access-Control-Allow-Origin':  ALLOWED,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
    if (request.method !== 'POST')   return new Response('Method Not Allowed', { status: 405 })

    let body
    try { body = await request.json() } catch {
      return json({ error: 'Bad JSON' }, 400)
    }

    const { action } = body

    // -- Schedule ---------------------------------------------------------
    if (action === 'schedule') {
      const { playerId, items } = body
      if (!playerId || !items?.length) return json({ error: 'Missing playerId or items' }, 400)

      const ids = []
      for (const item of items) {
        const res = await fetch(OS_API, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${env.ONESIGNAL_REST_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            app_id:              APP_ID,
            include_player_ids:  [playerId],
            headings:            { en: 'QR Clock-Bot' },
            contents:            { en: `${item.emoji}  ${item.label}` },
            send_after:          item.fireAtISO,   // ISO 8601 UTC
          }),
        })
        const data = await res.json()
        if (data.id) ids.push(data.id)
      }
      return json({ ok: true, ids })
    }

    // -- Cancel -----------------------------------------------------------
    if (action === 'cancel') {
      const { notifIds } = body
      if (!notifIds?.length) return json({ ok: true })

      await Promise.all(notifIds.map(id =>
        fetch(`${OS_API}/${id}?app_id=${APP_ID}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Basic ${env.ONESIGNAL_REST_KEY}` },
        })
      ))
      return json({ ok: true })
    }

    return json({ error: 'Unknown action' }, 400)
  },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

