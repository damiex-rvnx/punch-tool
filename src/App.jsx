import React, { useState, useEffect, useRef, useCallback } from 'react'

const WORKER_URL       = 'https://qr-clock-bot.lbrito1126.workers.dev'
const VAPID_PUBLIC_KEY = 'BC_wlEOLqTvLMDJK0ZntTkZQtKGVMNXIDmofUr-MlcPPN25lrlhzrFDpDTUYoftr2kXngLqSSxdIsbcTtJfBIv4'

function b64url_to_uint8(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

function getDeviceId() {
  let id = localStorage.getItem('qr_device_id')
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('qr_device_id', id) }
  return id
}

function getNtfyTopic(deviceId) {
  return 'qr-' + deviceId.replace(/-/g, '').substring(0, 16)
}

const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isAndroid = /Android/.test(navigator.userAgent)
const isMobile  = isIOS || isAndroid

// UKG Ready native app targets. Android package is known and lets us deep-link
// straight into the app via an Android intent. The iOS custom URL scheme is not
// publicly documented — set UKG_IOS_SCHEME once confirmed (e.g. 'ukgready://')
// to open the app directly; until then iOS breaks out to the system browser
// (so the tap escapes the trapped in-PWA webview and universal links can hand
// off to the app if the account has them configured).
const UKG_ANDROID_PKG = 'com.kronos.workforceready'
const UKG_IOS_SCHEME  = ''
const UKG_DEFAULT_URL = 'https://secure7.saashr.com/ta/6200194.login'

// Validate a saved UKG URL to http(s) only (guards against javascript:/data:
// injection) and fall back to the tenant login default.
function safeUkgUrl(raw) {
  try {
    const u = new URL(raw || UKG_DEFAULT_URL)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
  } catch { /* fall through */ }
  return UKG_DEFAULT_URL
}

// Open a URL in the real system browser, escaping a standalone PWA's in-app
// webview (window.location would stay trapped inside the installed app).
function openExternal(url) {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function ClockIcon({ size = 96 }) {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <rect x="24" y="24" width="72" height="72" rx="14"
            transform="rotate(45 60 60)"
            style={{ fill: 'var(--card)', stroke: '#e5342a', strokeWidth: 3 }}/>
      <circle cx="60" cy="60" r="27" style={{ fill: 'none', stroke: 'var(--bdr)', strokeWidth: 1.5 }}/>
      {ticks.map(deg => {
        const rad = (deg - 90) * Math.PI / 180
        const major = deg % 90 === 0
        const r1 = major ? 20 : 23.5
        return (
          <line key={deg}
            x1={60 + r1 * Math.cos(rad)}      y1={60 + r1 * Math.sin(rad)}
            x2={60 + 27 * Math.cos(rad)}       y2={60 + 27 * Math.sin(rad)}
            style={{ stroke: major ? 'var(--lbl)' : 'var(--bdr)', strokeWidth: major ? 2 : 1.2, strokeLinecap: 'round' }}/>
        )
      })}
      <line x1="60" y1="60" x2="51" y2="73"
            style={{ stroke: 'var(--fg)', strokeWidth: 3.5, strokeLinecap: 'round' }}/>
      <line x1="60" y1="60" x2="60" y2="37"
            style={{ stroke: '#e5342a', strokeWidth: 2.5, strokeLinecap: 'round' }}/>
      <circle cx="60" cy="60" r="3" style={{ fill: '#e5342a' }}/>
    </svg>
  )
}

const STORAGE_KEY = 'qwik_crew_v17'
const USER_DEFAULT_KEY = 'qwik_crew_user_default'

const DEFAULT = {
  startHour: 7,
  startMin: 0,
  startWarning: 5,
  ciWarnOn: true,
  lunchHour: 4.50,
  lunchWarning: 5,
  lwOn: true,
  liWarning: 5,
  liWarnOn: true,
  lunchDuration: 30,
  dinnerHour: 9.50,
  dinnerWarning: 5,
  dwOn: true,
  dinWarning: 5,
  dinWarnOn: true,
  dinnerDuration: 30,
  dinnerEnabled: true,
  endHour: 8,
  endMin: 0,
  endWarning: 15,
  ewOn: true,
  endEnabled: true,
  endFollowupEnabled: true,
  endFollowupDelay: 30,
  ukgUrl: 'https://secure7.saashr.com/ta/6200194.login',
  lightMode: false,
  cardOrder: ['shiftLength', 'lunch', 'dinner', 'schedulePreview'],
  openCards: { schedulePreview: false, shiftLength: true, lunch: true, dinner: true, clockIn: true },
}

// California meal-break compliance: the clock-out must land BEFORE the 5th /
// 10th hour of work. We cap the latest option at 5 minutes before that mark
// (4h55m / 9h55m) as a safety margin — never 5h00m / 10h00m.
const LUNCH_MAX_H = 295 / 60   // 4h55m in decimal hours
const DINNER_MAX_H = 595 / 60  // 9h55m in decimal hours

const LUNCH_OPTS = [
  { l: '4h 00m', v: 4.00 },
  { l: '4h 15m', v: 4.25 },
  { l: '4h 30m', v: 4.50 },
  { l: '4h 45m', v: 4.75 },
  { l: '4h 55m', v: LUNCH_MAX_H },
]

const DINNER_OPTS = [
  { l: '9h 00m', v: 9.00 },
  { l: '9h 15m', v: 9.25 },
  { l: '9h 30m', v: 9.50 },
  { l: '9h 45m', v: 9.75 },
  { l: '9h 55m', v: DINNER_MAX_H },
]


const DUR_OPTS = [
  { l: '30 min', v: 30 },
  { l: '45 min', v: 45 },
  { l: '60 min', v: 60 },
]

function h2m(h) {
  return Math.floor(h) * 60 + Math.round((h - Math.floor(h)) * 60)
}

function fmtTime(totalMins) {
  const m = ((totalMins % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const min = m % 60
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`
}

// Monotonic key for one-shot flash messages — changing the React key re-mounts
// the element so its CSS animation replays. Pure, unlike Date.now().
let _flashSeq = 0
const nextKey = () => (_flashSeq = (_flashSeq + 1) % 1e9)

// Shared AudioContext, created/unlocked on a user gesture (Set Reminders press).
// Browsers block audio started from a timer unless a context was unlocked by a
// gesture first, so we keep one alive rather than making a new one at fire time.
let _audioCtx = null
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    if (!_audioCtx) _audioCtx = new AC()
    if (_audioCtx.state === 'suspended') _audioCtx.resume?.().catch(() => {})
  } catch {}
}

// Fire an attention-grabbing alarm when a reminder pops while the app is open:
// strong vibration pattern (Android) + a rising Web Audio chime (all platforms).
function fireAlarmEffect() {
  try {
    navigator.vibrate?.([0, 400, 150, 400, 150, 600])
  } catch {}
  try {
    unlockAudio()
    const ctx = _audioCtx
    if (!ctx) return
    ctx.resume?.().catch(() => {})
    const now = ctx.currentTime
    // Three short beeps, rising pitch, so it reads as an alert not a notification blip.
    ;[880, 1046, 1318].forEach((freq, i) => {
      const t = now + i * 0.28
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.24)
    })
  } catch {}
}

const notifSupported  = typeof Notification !== 'undefined'
const notifPermission = () => notifSupported ? Notification.permission : 'unsupported'

// Migrate stale saved settings forward on load.
function migrateState(st) {
  // CA compliance: never keep a meal clock-out at/after the 5th or 10th hour.
  if (st.lunchHour > LUNCH_MAX_H)   st.lunchHour = LUNCH_MAX_H
  if (st.dinnerHour > DINNER_MAX_H) st.dinnerHour = DINNER_MAX_H
  // Replace the old placeholder UKG URL (ukg.com/login 404s) with the real
  // SaaSHR tenant login so devices that saved the placeholder get fixed.
  if (!st.ukgUrl || /(^$)|ukg\.com/i.test(st.ukgUrl)) st.ukgUrl = DEFAULT.ukgUrl
  return st
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return migrateState({ ...DEFAULT, ...JSON.parse(raw) })
  } catch {}
  try {
    const userDef = localStorage.getItem(USER_DEFAULT_KEY)
    if (userDef) return migrateState({ ...DEFAULT, ...JSON.parse(userDef) })
  } catch {}
  return { ...DEFAULT }
}

export default function App() {
  const [s, setS]           = useState(loadState)
  const [isSet, setIsSet]   = useState(() => localStorage.getItem('qwik_crew_isset') === '1')
  const [toast, setToast]   = useState(null)
  const [alert, setAlert]   = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [lastSetError, setLastSetError] = useState(null)
  const [setSnapshot, setSetSnapshot] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [nextReminderOpen, setNextReminderOpen] = useState(false)
  const [legalOpen, setLegalOpen] = useState(false)
  const [nowMins, setNowMins] = useState(() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() })
  const cancelConfirmTimer = useRef(null)
  const timerIds   = useRef([])
  const toastTimer = useRef(null)
  const swReg      = useRef(null)
  const pushSub    = useRef(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/OneSignalSDKWorker.js', { scope: '/' })
      .then(reg => {
        swReg.current = reg
        return reg.pushManager.getSubscription()
      })
      .then(sub => { if (sub) pushSub.current = sub })
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  }, [s])

  useEffect(() => {
    fetch(`${WORKER_URL}/status?deviceId=${getDeviceId()}`)
      .then(r => r.json())
      .then(data => { if (data.exists) setIsSet(true) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const id = setInterval(() => { const n = new Date(); setNowMins(n.getHours() * 60 + n.getMinutes()) }, 30000)
    return () => clearInterval(id)
  }, [])

  const update = useCallback(patch => setS(prev => ({ ...prev, ...patch })), [])

  const endMin      = s.endMin ?? 0
  const endTotal    = s.endHour * 60 + endMin
  const showLunch   = endTotal > 300
  const showDinner  = endTotal > 720
  const unpaidBreaks = (showLunch ? s.lunchDuration : 0) + (showDinner && s.dinnerEnabled ? s.dinnerDuration : 0)

  const schedule = (() => {
    const start     = s.startHour * 60 + s.startMin
    const lunchOut  = start + h2m(s.lunchHour)
    const lunchIn   = lunchOut + s.lunchDuration
    const dinnerOut = start + h2m(s.dinnerHour)
    const dinnerIn  = dinnerOut + s.dinnerDuration
    const endOut    = start + endTotal + unpaidBreaks
    return [
      ...(s.ciWarnOn !== false ? [
        { id: 'ciw', emoji: '🔔', label: `Clock in in ${s.startWarning} min — heads up!`, fireAt: start - s.startWarning },
      ] : []),
      { id: 'ci', emoji: '⏰', label: 'Clock In', fireAt: start },
      ...(showLunch ? [
        ...(s.lwOn !== false ? [
          { id: 'lw', emoji: '🔔', label: `Lunch in ${s.lunchWarning} min — heads up!`, fireAt: lunchOut - s.lunchWarning },
        ] : []),
        { id: 'lo', emoji: '🍽️', label: 'Clock Out — Lunch Break', fireAt: lunchOut },
        ...(s.liWarnOn !== false ? [
          { id: 'liw', emoji: '🔔', label: `Back from lunch in ${s.liWarning ?? 5} min — heads up!`, fireAt: lunchIn - (s.liWarning ?? 5) },
        ] : []),
        { id: 'li', emoji: '✅', label: `Clock Back In — Lunch (${s.lunchDuration} min)`, fireAt: lunchIn },
      ] : []),
      ...(showDinner && s.dinnerEnabled ? [
        ...(s.dwOn !== false ? [
          { id: 'dw', emoji: '🔔', label: `Dinner in ${s.dinnerWarning} min — heads up!`, fireAt: dinnerOut - s.dinnerWarning },
        ] : []),
        { id: 'dout', emoji: '🌙', label: 'Clock Out — Dinner Break', fireAt: dinnerOut },
        ...(s.dinWarnOn !== false ? [
          { id: 'dinw', emoji: '🔔', label: `Back from dinner in ${s.dinWarning ?? 5} min — heads up!`, fireAt: dinnerIn - (s.dinWarning ?? 5) },
        ] : []),
        { id: 'din', emoji: '🔁', label: `Clock Back In — Dinner (${s.dinnerDuration} min)`, fireAt: dinnerIn },
      ] : []),
      ...(s.endEnabled ? [
        ...(s.ewOn !== false ? [
          { id: 'ew', emoji: '⚠️', label: `Shift ends in ${s.endWarning} min — heads up!`, fireAt: endOut - s.endWarning },
        ] : []),
        { id: 'eo', emoji: '🏁', label: 'Clock Out — End of Shift', fireAt: endOut },
        ...(s.endFollowupEnabled ? [
          { id: 'ef', emoji: '❓', label: 'Still on the clock? Clock out now!', fireAt: endOut + (s.endFollowupDelay ?? 30) },
        ] : []),
      ] : []),
    ]
  })()

  function scheduleKey(st) {
    return JSON.stringify({
      startHour: st.startHour, startMin: st.startMin, startWarning: st.startWarning, ciWarnOn: st.ciWarnOn,
      lunchHour: st.lunchHour, lunchWarning: st.lunchWarning, lwOn: st.lwOn, liWarning: st.liWarning, liWarnOn: st.liWarnOn, lunchDuration: st.lunchDuration,
      dinnerHour: st.dinnerHour, dinnerWarning: st.dinnerWarning, dwOn: st.dwOn, dinWarning: st.dinWarning, dinWarnOn: st.dinWarnOn, dinnerDuration: st.dinnerDuration, dinnerEnabled: st.dinnerEnabled,
      endHour: st.endHour, endMin: st.endMin, endWarning: st.endWarning, ewOn: st.ewOn, endEnabled: st.endEnabled,
      endFollowupEnabled: st.endFollowupEnabled, endFollowupDelay: st.endFollowupDelay,
    })
  }
  const isDirty = isSet && setSnapshot !== null && scheduleKey(s) !== scheduleKey(setSnapshot)
  const isOvernight = (s.startHour * 60 + s.startMin + s.endHour * 60 + (s.endMin ?? 0) + unpaidBreaks) >= 1440

  function showToast(msg, color) {
    clearTimeout(toastTimer.current)
    setToast({ msg, color })
    toastTimer.current = setTimeout(() => setToast(null), 3800)
  }

  function saveAsDefault() {
    localStorage.setItem(USER_DEFAULT_KEY, JSON.stringify(s))
    showToast('Default saved ✓', '#15803d')
  }

  const nextItem = [...schedule].sort((a, b) => {
    const ae = a.fireAt < nowMins ? a.fireAt + 1440 : a.fireAt
    const be = b.fireAt < nowMins ? b.fireAt + 1440 : b.fireAt
    return ae - be
  })[0]
  const nextTmrw = nextItem && nextItem.fireAt < nowMins

  function openUKG() {
    const url = safeUkgUrl(s.ukgUrl)

    if (isAndroid) {
      // Deep-link into the UKG Ready Android app; fall back to the web URL in
      // the browser if the app isn't installed.
      const bare = url.replace(/^https?:\/\//, '')
      window.location.href =
        `intent://${bare}#Intent;scheme=https;package=${UKG_ANDROID_PKG};` +
        `S.browser_fallback_url=${encodeURIComponent(url)};end`
      return
    }

    if (isIOS) {
      if (UKG_IOS_SCHEME) {
        // Try the app's custom scheme; if nothing takes over (page stays
        // visible) fall back to the web login in the system browser.
        let handedOff = false
        const onHide = () => { handedOff = true }
        document.addEventListener('visibilitychange', onHide, { once: true })
        window.location.href = UKG_IOS_SCHEME
        setTimeout(() => {
          document.removeEventListener('visibilitychange', onHide)
          if (!handedOff) openExternal(url)
        }, 1400)
      } else {
        // No confirmed scheme yet: open in real Safari (not the trapped in-PWA
        // webview) so universal links can hand off to the app if configured.
        openExternal(url)
      }
      return
    }

    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function subscribePush() {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: b64url_to_uint8(VAPID_PUBLIC_KEY),
      })
    }
    pushSub.current = sub
    return sub
  }

  async function cancelWorkerNotifs() {
    try {
      await fetch(WORKER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'cancel', deviceId: getDeviceId() }),
      })
    } catch {}
  }

  function clearTimers() {
    timerIds.current.forEach(id => clearTimeout(id))
    timerIds.current = []
    swReg.current?.active?.postMessage({ type: 'QR_CANCEL' })
    cancelWorkerNotifs()
  }

  async function handleSet() {
    unlockAudio() // prime audio while we still have the user's tap gesture
    if (notifSupported && notifPermission() === 'default') {
      await Notification.requestPermission()
    }
    if (notifPermission() === 'denied') {
      showToast('Notifications blocked — enable in Settings', '#d97706')
      return
    }

    let sub = null
    let subscribeErr = null
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      try {
        sub = await subscribePush()
      } catch (e) {
        subscribeErr = e?.message || String(e)
        setLastSetError('Subscribe: ' + subscribeErr)
      }
    }

    clearTimers()

    const now     = new Date()
    const nowMins = now.getHours() * 60 + now.getMinutes()
    const swItems     = []
    const workerItems = []

    schedule.forEach(item => {
      let ms = (item.fireAt - nowMins) * 60000 - now.getSeconds() * 1000
      if (ms < 0) ms += 86400000

      timerIds.current.push(setTimeout(() => { fireAlarmEffect(); setAlert({ emoji: item.emoji, label: item.label }) }, ms))
      swItems.push({ id: item.id, ms, label: item.label, emoji: item.emoji })
      workerItems.push({ id: item.id, fireAtISO: new Date(Date.now() + ms).toISOString(), label: item.label, emoji: item.emoji, urgency: 'high', requireInteraction: true })
    })

    let workerOk = false
    if (sub) {
      try {
        const res = await fetch(WORKER_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            action:       'subscribe',
            deviceId:     getDeviceId(),
            subscription: sub.toJSON(),
            schedule:     workerItems,
            ntfyTopic:    isIOS ? getNtfyTopic(getDeviceId()) : undefined,
          }),
        })
        workerOk = res.ok
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          setLastSetError(`Worker ${res.status}: ${txt}`)
        } else {
          setLastSetError(null)
        }
      } catch (e) {
        setLastSetError('Fetch: ' + (e?.message || String(e)))
      }
    }

    const sw = swReg.current
    if (sw?.active) {
      sw.active.postMessage({ type: 'QR_SCHEDULE', items: swItems })
    } else if (sw) {
      navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({ type: 'QR_SCHEDULE', items: swItems }))
    }

    setIsSet(true)
    localStorage.setItem('qwik_crew_isset', '1')
    setSetSnapshot({ ...s })
    const swActive = !!(swReg.current?.active)
    if (subscribeErr) {
      // Local SW timer still works — notifications fire while browser is open
      const isBravePush = subscribeErr.includes('push service') || subscribeErr.includes('Registration failed')
      if (isBravePush && isDesktop) {
        showToast('Reminders set — browser must stay open', '#d97706')
      } else {
        showToast('Reminders set' + (swActive ? ' — browser must stay open' : ' (limited)'), '#d97706')
      }
    } else if (sub && !workerOk) {
      showToast('Server sync failed — check connection', '#d97706')
    } else if (!sub) {
      showToast('Reminders set (no server sync)', '#d97706')
    } else {
      showToast('Reminders set ✓', '#15803d')
    }
  }

  function handleCancel() {
    clearTimers()
    setIsSet(false)
    localStorage.removeItem('qwik_crew_isset')
    setSetSnapshot(null)
    setConfirmCancel(false)
    showToast('Reminders cancelled', '#374151')
  }

  function handleCancelClick() {
    if (!confirmCancel) {
      setConfirmCancel(true)
      clearTimeout(cancelConfirmTimer.current)
      cancelConfirmTimer.current = setTimeout(() => setConfirmCancel(false), 3000)
    } else {
      clearTimeout(cancelConfirmTimer.current)
      handleCancel()
    }
  }

  const css = {
    page:        { background: 'var(--bg)', minHeight: '100vh', overflowX: 'hidden', padding: '28px 0 40px', fontFamily: "'Barlow', sans-serif", color: 'var(--fg)' },
    inner:       { maxWidth: 920, margin: '0 auto', padding: '0 16px' },
    headerWrap:  { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 },
    rule:        { width: 40, height: 2, background: '#e5342a', borderRadius: 2, marginTop: 20 },
    tagline:     { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--lbl)', marginTop: 8 },
    card:        { background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 20, overflow: 'hidden' },
    lbl:         { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--lbl)', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    val:         { color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, textTransform: 'none', letterSpacing: 0 },
    divider:     { height: 1, background: 'var(--bdr)', margin: '18px 0' },
    hint:        { fontSize: 12, color: 'var(--hint)', marginTop: 10 },
    segRow:      { display: 'flex', gap: 6, marginTop: 8 },
    segBase:     { flex: 1, padding: '10px 1px', borderRadius: 8, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', transition: 'all .15s' },
    segActive:   { background: '#e5342a', borderColor: '#e5342a', color: '#fff' },
    durRow:      { display: 'flex', gap: 10, marginTop: 8 },
    durBase:     { flex: 1, padding: 12, borderRadius: 10, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all .15s' },
    durActive:   { background: '#1a2e1c', borderColor: '#32d74b', color: '#32d74b' },
    sliderWrap:  { marginTop: 10 },
    sliderLabels:{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--hint)', marginTop: 6 },
    previewGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginTop: 14 },
    previewLabel:{ color: 'var(--fg2)', fontSize: 13 },
    previewTime: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900, color: '#e5342a', whiteSpace: 'nowrap', textAlign: 'right' },
    btnSet:      { width: '100%', padding: 15, background: '#e5342a', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 900, letterSpacing: '0.08em', cursor: 'pointer', marginTop: 4, textTransform: 'uppercase' },
    btnCancel:   { width: '100%', padding: 12, background: 'transparent', color: 'var(--lbl)', border: '1.5px solid var(--bdr)', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 10 },
    footer:      { textAlign: 'center', fontSize: 11, color: 'var(--bdr)', marginTop: 28 },
  }

  return (
    <div style={css.page} className={s.lightMode ? 'qc-light' : ''}>
      <>
        {/* Hamburger — top right */}
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          style={{ position: 'fixed', top: 16, right: 16, zIndex: 9990, width: 44, height: 44, borderRadius: 10, border: '1.5px solid var(--bdr)', background: 'var(--card)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', padding: 0, boxShadow: '0 2px 12px rgba(0,0,0,.4)' }}
        >
          {[0,1,2].map(i => (
            <span key={i} style={{ display: 'block', width: 18, height: 2, background: 'var(--fg)', borderRadius: 1 }} />
          ))}
        </button>

        {/* Next-reminder chip — top left, visible when armed */}
        {isSet && nextItem && (() => {
          const eff  = nextItem.fireAt < nowMins ? nextItem.fireAt + 1440 : nextItem.fireAt
          const diff = eff - nowMins
          const h = Math.floor(diff / 60), m = diff % 60
          const countdown = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
          return (
            <>
              {nextReminderOpen && <div onClick={() => setNextReminderOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9988 }} />}
              <button
                onClick={() => setNextReminderOpen(o => !o)}
                style={{ position: 'fixed', top: 16, left: 16, zIndex: 9990, display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', height: 44, borderRadius: 10, border: `1.5px solid ${nextReminderOpen ? '#e5342a' : 'var(--bdr)'}`, background: 'var(--card)', cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,.4)', transition: 'border-color .15s' }}
              >
                <span style={{ fontSize: 14 }}>{nextItem.emoji}</span>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 900, color: '#e5342a', letterSpacing: '0.04em', lineHeight: 1.1 }}>{countdown}</span>
                  <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700, color: 'var(--hint)', letterSpacing: '0.06em', lineHeight: 1.1 }}>{fmtTime(nextItem.fireAt)}{nextTmrw ? ' tmrw' : ''}</span>
                </div>
              </button>
              <AnimatedReveal show={nextReminderOpen} style={{ position: 'fixed', top: 68, left: 16, zIndex: 9989 }}>
                <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, padding: '14px 16px', minWidth: 230, maxWidth: 290, boxShadow: '0 8px 32px rgba(0,0,0,.6)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Next Alert</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, color: 'var(--hint)' }}>{fmtTime(nextItem.fireAt)}{nextTmrw ? ' · tmrw' : ''}</div>
                  </div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e5342a', lineHeight: 1 }}>fires in {countdown}</div>
                  <div style={{ marginTop: 10, padding: '7px 9px', background: 'var(--inp)', borderRadius: 8, borderLeft: '3px solid var(--bdr)' }}>
                    <div style={{ fontSize: 9, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 2 }}>Notification</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: 'var(--fg2)', lineHeight: 1.3 }}>{nextItem.emoji} {nextItem.label}</div>
                  </div>
                  <button onClick={() => setNextReminderOpen(false)} style={{ marginTop: 10, width: '100%', padding: '7px 0', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: 8, color: 'var(--hint)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Dismiss</button>
                </div>
              </AnimatedReveal>
            </>
          )
        })()}

        {/* Floating UKG button — a real anchor so a genuine tap on iOS can hand
            off to the UKG Ready app via universal links (a programmatic click
            wouldn't). Android/custom-scheme cases intercept and use openUKG. */}
        <a
          href={safeUkgUrl(s.ukgUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => { if (isAndroid || (isIOS && UKG_IOS_SCHEME)) { e.preventDefault(); openUKG() } }}
          style={{ position: 'fixed', bottom: 24, right: 16, zIndex: 9980, display: 'flex', alignItems: 'center', gap: 7, padding: '11px 18px', background: '#e5342a', color: '#fff', border: 'none', borderRadius: 28, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900, letterSpacing: '0.06em', cursor: 'pointer', boxShadow: '0 4px 18px rgba(229,52,42,0.45)', userSelect: 'none', textDecoration: 'none' }}
        >
          <span style={{ fontSize: 16 }}>📋</span> Open UKG ↗
        </a>

        <div
          onClick={() => setSettingsOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', zIndex: 9991, opacity: settingsOpen ? 1 : 0, pointerEvents: settingsOpen ? 'auto' : 'none', transition: 'opacity .3s ease' }}
        />

        <div
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(340px, 90vw)', background: 'var(--bg)', borderLeft: '1px solid var(--bdr)', zIndex: 9992, transform: settingsOpen ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .3s cubic-bezier(0.4,0,0.2,1)', display: 'flex', flexDirection: 'column', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 16px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--lbl)' }}>Settings</div>
            <button
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
              style={{ background: 'none', border: 'none', color: 'var(--lbl)', fontSize: 28, cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontWeight: 300, fontFamily: 'system-ui' }}
            >×</button>
          </div>
          <div style={{ padding: 20, flex: 1 }}>
            <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Appearance</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>Light mode</div>
                  <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>{s.lightMode ? 'On — light background' : 'Off — dark background'}</div>
                </div>
                <Toggle on={s.lightMode} onToggle={() => update({ lightMode: !s.lightMode })} label="Toggle light mode" />
              </div>
            </div>
            {(() => {
              const warnKeys = ['ciWarnOn','lwOn','liWarnOn','dwOn','dinWarnOn','ewOn']
              const anyWarnOn = warnKeys.some(k => s[k] !== false)
              return (
                <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>Heads-Up Notifications</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>All heads-up alerts</div>
                      <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>{anyWarnOn ? 'On — advance warnings active' : 'Off — no advance warnings'}</div>
                    </div>
                    <Toggle on={anyWarnOn} onToggle={() => update(Object.fromEntries(warnKeys.map(k => [k, !anyWarnOn])))} label="Toggle all heads-up" />
                  </div>
                </div>
              )
            })()}
            <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>Saved Defaults</div>
              <button
                onClick={saveAsDefault}
                style={{ width: '100%', padding: '10px 14px', background: 'var(--inp)', border: '1.5px solid var(--bdr)', borderRadius: 10, color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}
              >
                💾 Save current settings as default
              </button>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6, lineHeight: 1.5 }}>
                Restores these settings when you clear/reinstall the app.
              </div>
            </div>
            {isIOS && <NtfySetupCard css={css} deviceId={getDeviceId()} />}
            <CardOrderPanel s={s} update={update} />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 16, marginTop: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>UKG Link</div>
              <input
                type="url"
                value={s.ukgUrl || ''}
                placeholder="https://secure7.saashr.com/ta/6200194.login"
                onChange={e => update({ ukgUrl: e.target.value })}
                style={{ width: '100%', background: 'var(--inp)', border: '1.5px solid var(--bdr)', borderRadius: 10, padding: '10px 14px', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6, lineHeight: 1.5 }}>
                Your company's UKG Ready login URL for the "Open UKG" button.
              </div>
            </div>
            <DebugPanel deviceId={getDeviceId()} lastSetError={lastSetError} schedule={schedule} nowMins={nowMins} />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 16, marginTop: 16 }}>
              <button
                onClick={() => { setSettingsOpen(false); setLegalOpen(true) }}
                style={{ background: 'none', border: 'none', color: 'var(--hint)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer', padding: 0 }}
              >
                Terms of Service &amp; Privacy Policy ↗
              </button>
              <div style={{ marginTop: 14, fontSize: 10, color: 'var(--bdr)', lineHeight: 1.8 }}>
                Made by Damiex Solutions · Luis A. Brito<br />
                <span style={{ fontSize: 9, color: 'var(--muted)' }}>Configured with Claude Code</span>
              </div>
            </div>
          </div>
        </div>
      </>

      {toast && (
        <div style={{ position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', background: toast.color, color: '#fff', padding: '10px 22px', borderRadius: 10, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, zIndex: 9999, animation: 'sd .25s ease', whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,.5)' }}>
          {toast.msg}
        </div>
      )}

      {alert && (
        <div style={{ position: 'fixed', inset: 0, background: '#1c1c1ef5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 9998, padding: 24 }}>
          <div style={{ fontSize: 72, animation: 'pop 1s ease infinite', marginBottom: 20 }}>{alert.emoji}</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 700, textAlign: 'center', maxWidth: 380, marginBottom: 12 }}>{alert.label}</div>
          <div style={{ color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Clock in/out in UKG now!</div>
          <a
            href={safeUkgUrl(s.ukgUrl)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => { if (isAndroid || (isIOS && UKG_IOS_SCHEME)) { e.preventDefault(); openUKG() } setAlert(null) }}
            style={{ display: 'inline-block', marginBottom: 20, padding: '13px 32px', background: '#e5342a', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer', textDecoration: 'none' }}
          >
            📋 Open UKG ↗
          </a>
          <button onClick={() => setAlert(null)} style={{ padding: '12px 32px', background: 'transparent', color: '#f2f2f7', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>Got it ✓</button>
        </div>
      )}

      {legalOpen && <LegalModal onClose={() => setLegalOpen(false)} />}

      <div style={css.inner}>
        <div style={css.headerWrap}>
          <ClockIcon />
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, letterSpacing: '0.1em', color: 'var(--fg)', marginTop: 14, textTransform: 'uppercase' }}>
            <span style={{ color: '#e5342a' }}>CLOCK-BOT</span>
          </div>
          <div style={css.rule} />
          <div style={css.tagline}>Crew Clock Reminder</div>
          {(() => {
            const [bg, border, color, icon, text] = !isSet
              ? ['rgba(229,52,42,0.1)', '#e5342a', '#e5342a', '○', 'NOT SET']
              : isDirty
                ? ['rgba(217,119,6,0.12)', '#d97706', '#d97706', '⚠', 'UPDATE REMINDERS']
                : ['rgba(50,215,75,0.12)', '#32d74b', '#32d74b', '✓', 'ARMED']
            return (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderRadius: 20, background: bg, border: `1.5px solid ${border}` }}>
                <span style={{ fontSize: 10, color }}>{icon}</span>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color }}>{text}</span>
              </div>
            )
          })()}
          {isSet && !isDirty && nextItem && (() => {
            const eff = nextItem.fireAt < nowMins ? nextItem.fireAt + 1440 : nextItem.fireAt
            const diff = eff - nowMins
            const h = Math.floor(diff / 60), m = diff % 60
            const countdown = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
            return (
              <div style={{ marginTop: 5, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, color: 'var(--hint)', letterSpacing: '0.06em', textAlign: 'center' }}>
                {nextItem.emoji} <span style={{ color: '#e5342a', fontWeight: 700 }}>{countdown}</span> · {nextItem.label}
              </div>
            )
          })()}
        </div>

        <ResponsiveLayout
          css={css} s={s} update={update}
          schedule={schedule} isSet={isSet}
          handleSet={handleSet}
          handleCancelClick={handleCancelClick} confirmCancel={confirmCancel}
          isDirty={isDirty} isOvernight={isOvernight}
          showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks}
          nowMins={nowMins} nextItem={nextItem} nextTmrw={nextTmrw}
          showToast={showToast}
        />

      </div>

      <style>{`
        :root{--bg:#1c1c1e;--card:#2c2c2e;--bdr:#3a3a3c;--fg:#f2f2f7;--fg2:#aeaeb2;--lbl:#8e8e93;--hint:#636366;--muted:#4a4a4e;--inp:#1c1c1e;--deep:#0a0a0b;}
        .qc-light{--bg:#f5f5f7;--card:#ffffff;--bdr:#d1d1d6;--fg:#1c1c1e;--fg2:#48484a;--lbl:#636366;--hint:#8e8e93;--muted:#c7c7cc;--inp:#f0f0f5;--deep:#e8e8ef;}
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); }
        button { outline: none; -webkit-tap-highlight-color: transparent; }
        input[type=time] {
          appearance: none; -webkit-appearance: none;
          background: var(--inp); border: 1.5px solid var(--bdr); border-radius: 10px;
          padding: 13px 14px; color: var(--fg); width: 100%; max-width: 100%; min-width: 0;
          display: block; font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 700;
        }
        input[type=time]::-webkit-date-and-time-value { text-align: left; }
        input[type=time]::-webkit-calendar-picker-indicator { filter: invert(1); }
        input[type=range] { -webkit-appearance: none; width: 100%; height: 6px; background: var(--bdr); border-radius: 3px; outline: none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; border-radius: 50%; background: #e5342a; cursor: pointer; border: 2px solid var(--bg); box-shadow: 0 2px 6px rgba(0,0,0,.3); }
        input[type=range]::-moz-range-thumb { width: 28px; height: 28px; border-radius: 50%; background: #e5342a; cursor: pointer; border: 2px solid var(--bg); box-shadow: 0 2px 6px rgba(0,0,0,.3); }
        @keyframes sd        { from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);} }
        @keyframes pop       { 0%,100%{transform:scale(1);}50%{transform:scale(1.08);} }
        @keyframes fadeFlash { 0%{opacity:1;}70%{opacity:1;}100%{opacity:0;} }
        @keyframes dropDown { from{opacity:0;transform:translateY(-16px);}to{opacity:1;transform:translateY(0);} }
        @keyframes dropUp      { from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(-16px);} }
        @keyframes dirtyPulse  { 0%,100%{box-shadow:0 0 0 0 rgba(217,119,6,0);}50%{box-shadow:0 0 0 6px rgba(217,119,6,0.35);} }
        @supports (backdrop-filter: blur(1px)) { .settings-backdrop { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); } }
        @media (min-width: 800px) {
          .responsive-grid { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 16px !important; }
          .card-full { grid-column: 1 / -1 !important; }
        }
      `}</style>
    </div>
  )
}

const isDesktop = !isMobile

const WHEEL_HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const WHEEL_MINS  = Array.from({ length: 60 }, (_, i) => i)

function WheelCol({ items, value, onChange, fmt = String }) {
  const ITEM_H = 44
  const N      = items.length

  const colRef   = useRef(null)
  const trackRef = useRef(null)
  const elRefs   = useRef([])

  const st = useRef({
    idx:   Math.max(0, items.indexOf(value)),
    dragY: 0,
    vel:   0,
    raf:   null,
    lastY: 0,
    lastT: 0,
  })

  const cbRef  = useRef(onChange)
  const itmRef = useRef(items)
  const fmtRef = useRef(fmt)
  // Keep latest props in refs so the imperative pointer/RAF handlers never read
  // stale closures. Written during render on purpose (read only after commit).
  /* eslint-disable react-hooks/refs */
  cbRef.current  = onChange
  itmRef.current = items
  fmtRef.current = fmt
  /* eslint-enable react-hooks/refs */

  const applyDOM = useCallback((animated) => {
    const s = st.current
    const track = trackRef.current
    if (!track) return
    // dragY is the sole offset — slots always render the 5 items around idx
    track.style.transition = animated ? 'transform 0.22s cubic-bezier(0.34,1.56,0.64,1)' : 'none'
    track.style.transform  = `translateY(${s.dragY}px)`
    elRefs.current.forEach((el, slot) => {
      if (!el) return
      const itemIdx = ((s.idx - 2 + slot) % N + N) % N
      const off     = slot - 2
      const sel     = off === 0
      const d       = Math.abs(off)
      el.textContent      = fmtRef.current(itmRef.current[itemIdx])
      el.style.fontSize   = sel ? '30px' : d === 1 ? '20px' : '14px'
      el.style.fontWeight = sel ? '800' : '400'
      el.style.color      = sel ? '#e5342a' : d === 1 ? 'var(--fg2)' : 'var(--bdr)'
    })
  }, [N])

  // Used during touch drag only — advances idx and compensates dragY to keep items in view
  const step = useCallback((dir) => {
    const s = st.current
    s.idx   = ((s.idx + dir) % N + N) % N
    s.dragY += dir * ITEM_H   // compensate: slot shifts one position, so dragY offsets by +ITEM_H
    applyDOM(false)
    cbRef.current(itmRef.current[s.idx])
    if (navigator.vibrate) navigator.vibrate(6)
  }, [N, applyDOM])

  // Sync external value changes
  useEffect(() => {
    const newIdx = items.indexOf(value)
    if (newIdx === -1 || newIdx === st.current.idx) return
    st.current.idx   = newIdx
    st.current.dragY = 0
    applyDOM(true)
  }, [value, items, applyDOM])

  // Initial render
  useEffect(() => { applyDOM(false) }, [applyDOM])

  // Input event listeners
  useEffect(() => {
    const el = colRef.current
    if (!el) return

    const onWheel = e => {
      e.preventDefault()
      if (st.current.raf) { cancelAnimationFrame(st.current.raf); st.current.raf = null }
      const dir = e.deltaY > 0 ? 1 : -1
      st.current.idx   = ((st.current.idx + dir) % N + N) % N
      st.current.dragY = 0
      applyDOM(false)
      cbRef.current(itmRef.current[st.current.idx])
    }

    const onTouchStart = e => {
      if (st.current.raf) { cancelAnimationFrame(st.current.raf); st.current.raf = null }
      st.current.vel   = 0
      st.current.lastY = e.touches[0].clientY
      st.current.lastT = performance.now()
    }

    const onTouchMove = e => {
      e.preventDefault()
      const now = performance.now()
      const dy  = st.current.lastY - e.touches[0].clientY
      const dt  = Math.max(now - st.current.lastT, 1)
      st.current.vel   = dy / dt
      st.current.lastY = e.touches[0].clientY
      st.current.lastT = now
      st.current.dragY -= dy
      while (st.current.dragY >  ITEM_H / 2) step(-1)
      while (st.current.dragY < -ITEM_H / 2) step(1)
      applyDOM(false)
    }

    const onTouchEnd = () => {
      let vel = st.current.vel * 16
      const DECEL   = 0.88
      const MIN_VEL = 0.4
      const tick = () => {
        vel *= DECEL
        if (Math.abs(vel) < MIN_VEL) {
          st.current.dragY = 0
          applyDOM(true)
          st.current.raf = null
          return
        }
        st.current.dragY -= vel
        while (st.current.dragY >  ITEM_H / 2) step(-1)
        while (st.current.dragY < -ITEM_H / 2) step(1)
        applyDOM(false)
        st.current.raf = requestAnimationFrame(tick)
      }
      st.current.raf = requestAnimationFrame(tick)
    }

    el.addEventListener('wheel',      onWheel,      { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove',  onTouchMove,  { passive: false })
    el.addEventListener('touchend',   onTouchEnd,   { passive: true })
    return () => {
      el.removeEventListener('wheel',      onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove',  onTouchMove)
      el.removeEventListener('touchend',   onTouchEnd)
      // st is a stable ref object; read .raf at cleanup to cancel the pending
      // frame. Copying it early (as the rule suggests) would capture a stale id.
      /* eslint-disable-next-line react-hooks/exhaustive-deps */
      if (st.current.raf) cancelAnimationFrame(st.current.raf)
    }
  }, [N, step, applyDOM])

  const handleClick = e => {
    const rect     = colRef.current.getBoundingClientRect()
    const clickY   = e.clientY - rect.top
    const slotOff  = Math.round(clickY / ITEM_H) - 2  // slots 0-4, center = slot 2
    if (slotOff === 0) return
    st.current.idx   = ((st.current.idx + slotOff) % N + N) % N
    st.current.dragY = 0
    applyDOM(false)
    cbRef.current(itmRef.current[st.current.idx])
  }

  return (
    <div
      ref={colRef}
      onClick={handleClick}
      style={{
        width: 64, height: ITEM_H * 5, overflow: 'hidden',
        cursor: 'ns-resize', userSelect: 'none', touchAction: 'none',
        position: 'relative',
      }}
    >
      <div
        ref={trackRef}
        style={{ willChange: 'transform', position: 'absolute', top: 0, left: 0, right: 0 }}
      >
        {[0, 1, 2, 3, 4].map(slot => (
          <div
            key={slot}
            ref={el => { elRefs.current[slot] = el }}
            style={{
              height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'Barlow Condensed', sans-serif",
              pointerEvents: 'none',
            }}
          />
        ))}
      </div>
    </div>
  )
}


function ShiftTimeline({ s, schedule, showLunch, showDinner, unpaidBreaks, update }) {
  const start  = s.startHour * 60 + s.startMin
  const endOut = start + s.endHour * 60 + (s.endMin ?? 0) + unpaidBreaks
  const span   = Math.max(endOut - start, 60)

  const barRef      = useRef(null)
  const dragRef     = useRef(null)
  const dragSnapRef = useRef(null)
  const sRef        = useRef(s)
  const updRef      = useRef(update)
  // Latest state/updater for the imperative drag handlers (read after commit).
  /* eslint-disable-next-line react-hooks/refs */
  sRef.current      = s
  /* eslint-disable-next-line react-hooks/refs */
  updRef.current    = update

  const [activeDot, setActiveDot] = useState(null)
  const [tooltip, setTooltip]     = useState(null)

  const pct = mins => {
    let pos = mins - start
    if (pos < 0) pos += 1440
    return Math.min(100, Math.max(0, (pos / span) * 100))
  }

  function computeAndApply(id, clientX) {
    if (!barRef.current || !dragSnapRef.current) return null
    const cur      = sRef.current
    const curStart = cur.startHour * 60 + cur.startMin
    const curEndT  = cur.endHour * 60 + (cur.endMin ?? 0)
    const curShowL = curEndT > 300
    const curShowD = curEndT > 720
    const curUnp   = (curShowL ? cur.lunchDuration : 0) + (curShowD && cur.dinnerEnabled ? cur.dinnerDuration : 0)
    const snap     = dragSnapRef.current
    const rect     = barRef.current.getBoundingClientRect()
    const p        = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const abs      = snap.start + p * snap.span
    const s5       = m => Math.round(m / 5) * 5

    switch (id) {
      case 'ci': {
        const t = ((s5(Math.round(abs)) % 1440) + 1440) % 1440
        updRef.current({ startHour: Math.floor(t / 60), startMin: t % 60 })
        navigator.vibrate?.(5)
        return { text: fmtTime(t), pct: 0 }
      }
      case 'lo': {
        // Cap at 4h55m (5 min before the 5th hour) for CA meal-break compliance.
        const rel = Math.max(4 * 60, Math.min(295, Math.round((abs - curStart) / 15) * 15))
        updRef.current({ lunchHour: rel / 60 })
        navigator.vibrate?.(5)
        return { text: fmtTime(curStart + rel), pct: p * 100 }
      }
      case 'lw': {
        const lunchOut = curStart + h2m(cur.lunchHour)
        const w = Math.max(2, Math.min(15, Math.round(lunchOut - abs)))
        updRef.current({ lunchWarning: w })
        navigator.vibrate?.(5)
        return { text: `${w}m warn`, pct: p * 100 }
      }
      case 'li': {
        const lunchOut = curStart + h2m(cur.lunchHour)
        const dur = Math.max(30, Math.min(60, Math.round((abs - lunchOut) / 15) * 15))
        updRef.current({ lunchDuration: dur })
        navigator.vibrate?.(5)
        return { text: `${dur}m break`, pct: p * 100 }
      }
      case 'dout': {
        // Cap at 9h55m (5 min before the 10th hour) for CA meal-break compliance.
        const rel = Math.max(9 * 60, Math.min(595, Math.round((abs - curStart) / 15) * 15))
        updRef.current({ dinnerHour: rel / 60 })
        navigator.vibrate?.(5)
        return { text: fmtTime(curStart + rel), pct: p * 100 }
      }
      case 'dw': {
        const dinnerOut = curStart + h2m(cur.dinnerHour)
        const w = Math.max(2, Math.min(15, Math.round(dinnerOut - abs)))
        updRef.current({ dinnerWarning: w })
        navigator.vibrate?.(5)
        return { text: `${w}m warn`, pct: p * 100 }
      }
      case 'din': {
        const dinnerOut = curStart + h2m(cur.dinnerHour)
        const dur = Math.max(30, Math.min(60, Math.round((abs - dinnerOut) / 15) * 15))
        updRef.current({ dinnerDuration: dur })
        navigator.vibrate?.(5)
        return { text: `${dur}m break`, pct: p * 100 }
      }
      case 'eo': {
        const rel = Math.max(240, s5(Math.round(abs - curStart - curUnp)))
        updRef.current({ endHour: Math.min(24, Math.floor(rel / 60)), endMin: rel % 60 })
        navigator.vibrate?.(5)
        return { text: fmtTime(curStart + rel + curUnp), pct: p * 100 }
      }
      case 'ew': {
        const endT = curStart + cur.endHour * 60 + (cur.endMin ?? 0) + curUnp
        const w    = Math.max(2, Math.min(30, Math.round(endT - abs)))
        updRef.current({ endWarning: w })
        navigator.vibrate?.(5)
        return { text: `${w}m warn`, pct: p * 100 }
      }
      default: return null
    }
  }

  useEffect(() => {
    function getX(e) { return e.touches ? e.touches[0].clientX : e.clientX }
    function onMove(e) {
      if (!dragRef.current) return
      if (e.cancelable) e.preventDefault()
      const res = computeAndApply(dragRef.current, getX(e))
      if (res) setTooltip(res)
    }
    function onUp() {
      dragRef.current = null
      dragSnapRef.current = null
      setActiveDot(null)
      setTooltip(null)
    }
    document.addEventListener('pointermove', onMove, { passive: false })
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [])

  function onDotDown(id, e) {
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
    const cur      = sRef.current
    const curStart = cur.startHour * 60 + cur.startMin
    const curEndT  = cur.endHour * 60 + (cur.endMin ?? 0)
    const curShowL = curEndT > 300
    const curShowD = curEndT > 720
    const curUnp   = (curShowL ? cur.lunchDuration : 0) + (curShowD && cur.dinnerEnabled ? cur.dinnerDuration : 0)
    const curEO    = curStart + curEndT + curUnp
    dragSnapRef.current = { span: Math.max(curEO - curStart, 60), start: curStart }
    dragRef.current = id
    setActiveDot(id)
    const res = computeAndApply(id, e.touches ? e.touches[0].clientX : e.clientX)
    if (res) setTooltip(res)
    navigator.vibrate?.(10)
  }

  const draggable = new Set(['ci', 'lo', 'lw', 'li', 'dout', 'dw', 'din', 'eo', 'ew'])
  const dots = schedule.filter(i => ['ciw', 'ci', 'lw', 'lo', 'liw', 'li', 'dw', 'dout', 'dinw', 'din', 'ew', 'eo', 'ef'].includes(i.id))

  const dotColor = id => {
    if (['ci', 'li', 'din'].includes(id)) return '#32d74b'
    if (id === 'eo')  return '#e5342a'
    if (id.endsWith('w')) return '#d97706'
    return 'var(--hint)'
  }
  const dotSz = id => ['ci', 'lo', 'li', 'dout', 'din', 'eo'].includes(id) ? 22 : id.endsWith('w') ? 16 : 12

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ position: 'relative', margin: '24px 0 48px' }}>
        {tooltip && (
          <div style={{
            position: 'absolute',
            left: `${Math.max(8, Math.min(92, tooltip.pct))}%`,
            bottom: 'calc(100% + 8px)',
            transform: 'translateX(-50%)',
            background: '#e5342a', color: '#fff',
            padding: '3px 10px', borderRadius: 6,
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700,
            pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 10,
          }}>{tooltip.text}</div>
        )}
        <div ref={barRef} style={{ position: 'relative', height: 8, background: 'var(--bdr)', borderRadius: 4 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, background: '#e5342a22', borderRadius: 4 }} />
          {showLunch && (() => {
            const lo = pct(start + h2m(s.lunchHour))
            const li = pct(start + h2m(s.lunchHour) + s.lunchDuration)
            const midPct = (lo + li) / 2
            return <>
              <div style={{ position: 'absolute', left: `${lo}%`, width: `${li - lo}%`, top: 0, bottom: 0, background: 'var(--bg)', borderLeft: '2px solid var(--bdr)', borderRight: '2px solid var(--bdr)' }} />
              <div style={{ position: 'absolute', left: `${midPct}%`, top: '50%', transform: 'translate(-50%, -50%)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 9, fontWeight: 800, color: 'var(--hint)', letterSpacing: '0.06em', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{s.lunchDuration}m</div>
            </>
          })()}
          {showDinner && s.dinnerEnabled && (() => {
            const dout = pct(start + h2m(s.dinnerHour))
            const din  = pct(start + h2m(s.dinnerHour) + s.dinnerDuration)
            const midPct = (dout + din) / 2
            return <>
              <div style={{ position: 'absolute', left: `${dout}%`, width: `${din - dout}%`, top: 0, bottom: 0, background: 'var(--bg)', borderLeft: '2px solid var(--bdr)', borderRight: '2px solid var(--bdr)' }} />
              <div style={{ position: 'absolute', left: `${midPct}%`, top: '50%', transform: 'translate(-50%, -50%)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 9, fontWeight: 800, color: 'var(--hint)', letterSpacing: '0.06em', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{s.dinnerDuration}m</div>
            </>
          })()}
          {[...dots].sort((a, b) => a.id.endsWith('w') ? 1 : b.id.endsWith('w') ? -1 : 0).map(item => {
            const isWarn = item.id.endsWith('w')
            const isDr = draggable.has(item.id)
            const isAc = activeDot === item.id
            const sz   = dotSz(item.id)
            const HIT  = isDr ? 44 : sz
            return (
              <div
                key={item.id}
                onPointerDown={isDr ? e => onDotDown(item.id, e) : undefined}
                style={{
                  position: 'absolute',
                  left: `${pct(item.fireAt)}%`,
                  top: isWarn ? 'calc(50% + 28px)' : '50%',
                  transform: 'translate(-50%, -50%)',
                  width: HIT,
                  height: HIT,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: isDr ? (isAc ? 'grabbing' : 'grab') : 'default',
                  touchAction: isDr ? 'none' : 'auto',
                  zIndex: isAc ? 5 : isWarn ? 3 : isDr ? 2 : 1,
                }}
              >
                <div
                  style={{
                    width: isAc ? sz + 6 : sz,
                    height: isAc ? sz + 6 : sz,
                    borderRadius: '50%',
                    background: dotColor(item.id),
                    border: `${isAc ? 3 : 2}px solid var(--bg)`,
                    transition: isAc ? 'none' : 'width .1s, height .1s',
                    boxShadow: isAc ? `0 0 0 4px ${dotColor(item.id)}55` : 'none',
                    pointerEvents: 'none',
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--hint)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.06em' }}>
        <span>{fmtTime(start)}</span>
        <span>{fmtTime(endOut)}</span>
      </div>
      <div style={{ textAlign: 'center', fontSize: 9, color: 'var(--muted)', marginTop: 5, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        ⟺ drag circles to adjust
      </div>
    </div>
  )
}

function SchedulePreviewContent({ css, schedule, s, showLunch, showDinner, unpaidBreaks, update }) {
  const now = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const [copied, setCopied] = React.useState(false)
  const sorted = [...schedule].sort((a, b) => {
    const ae = a.fireAt < nowMins ? a.fireAt + 1440 : a.fireAt
    const be = b.fireAt < nowMins ? b.fireAt + 1440 : b.fireAt
    return ae - be
  })
  const upcomingItems = sorted.filter(item => item.fireAt >= nowMins)
  const firedItems    = sorted.filter(item => item.fireAt < nowMins)

  function copySchedule() {
    const dayStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const lines = [`CLOCK-BOT — ${dayStr}`, '']
    schedule.slice().sort((a, b) => {
      const ae = a.fireAt < 0 ? a.fireAt + 1440 : a.fireAt
      const be = b.fireAt < 0 ? b.fireAt + 1440 : b.fireAt
      return ae - be
    }).forEach(item => {
      lines.push(`${item.emoji}  ${item.label.padEnd(32)} ${fmtTime(item.fireAt)}`)
    })
    const text = lines.join('\n')
    if (navigator.share) {
      navigator.share({ title: 'Clock-Bot Schedule', text }).catch(() => {})
    } else {
      navigator.clipboard?.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    }
  }

  const sectionLabel = (txt, accent) => (
    <div style={{ fontSize: 10, color: accent || 'var(--hint)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{txt}</div>
  )
  const upcomingGrid = items => (
    <div style={css.previewGrid}>
      {items.map(item => (
        <React.Fragment key={item.id}>
          <div style={css.previewLabel}>{item.emoji} {item.label}</div>
          <div style={css.previewTime}>{fmtTime(item.fireAt)}</div>
        </React.Fragment>
      ))}
    </div>
  )
  const firedGrid = items => (
    <div style={{ ...css.previewGrid, opacity: 0.45 }}>
      {items.map(item => (
        <React.Fragment key={item.id}>
          <div style={{ ...css.previewLabel, textDecoration: 'line-through' }}>✓ {item.label}</div>
          <div style={{ ...css.previewTime, color: 'var(--hint)', textDecoration: 'line-through' }}>{fmtTime(item.fireAt)}</div>
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div>
      <ShiftTimeline s={s} schedule={schedule} showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks} update={update} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          onClick={copySchedule}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: 8, color: copied ? '#32d74b' : 'var(--hint)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.08em', transition: 'color .2s' }}
        >
          {copied ? '✓ COPIED' : (navigator.share ? '↑ SHARE' : '📋 COPY')}
        </button>
      </div>
      {firedItems.length > 0 && (
        <div style={{ marginBottom: upcomingItems.length > 0 ? 16 : 0 }}>
          {sectionLabel('✓ Already Fired')}
          {firedGrid(firedItems)}
        </div>
      )}
      {upcomingItems.length > 0 && <>{sectionLabel('Up Next')}{upcomingGrid(upcomingItems)}</>}
    </div>
  )
}

function AnimatedReveal({ show, style = {}, children }) {
  const [rendered, setRendered] = useState(show)
  const [closing, setClosing]   = useState(false)
  // Drive mount/enter/exit from the `show` prop. setState-in-effect is the
  // intended pattern here; `rendered` is intentionally not a dep (we only react
  // to `show` changing, and read `rendered` as a guard).
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (show) { setRendered(true); setClosing(false) }
    else if (rendered) setClosing(true)
  }, [show])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  if (!rendered) return null
  return (
    <div
      style={{ ...style, animation: closing ? 'dropUp .36s cubic-bezier(0.16,1,0.3,1) forwards' : 'dropDown .42s cubic-bezier(0.16,1,0.3,1)' }}
      onAnimationEnd={() => { if (closing) { setRendered(false); setClosing(false) } }}
    >
      {children}
    </div>
  )
}

function LegalModal({ onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9993, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', animation: 'sd .25s ease' }}>
      <div style={{ width: '100%', maxHeight: '90vh', background: 'var(--bg)', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'dropDown .42s cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--lbl)' }}>Terms of Service &amp; Privacy Policy</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--lbl)', fontSize: 28, cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontWeight: 300, fontFamily: 'system-ui' }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '20px 20px 40px', WebkitOverflowScrolling: 'touch' }}>
          {[
            {
              heading: 'Terms of Service',
              body: [
                ['Free to use', 'Clock-Bot is provided free of charge with no subscription or in-app purchases.'],
                ['No warranty', 'This app is provided "as is" without warranty of any kind. We do not guarantee that notifications will be delivered on time or at all — delivery depends on your device settings, browser permissions, network connectivity, and push service availability.'],
                ['Your responsibility', 'You are solely responsible for clocking in and out in UKG or any other timekeeping system on time. Clock-Bot is a reminder tool only and does not interact with UKG or any payroll system.'],
                ['Not affiliated with UKG', 'Clock-Bot is an independent tool and is not affiliated with, endorsed by, or connected to UKG, UKG Ready, or any of their products.'],
                ['Changes', 'We may update these terms at any time. Continued use of the app after changes constitutes acceptance.'],
              ],
            },
            {
              heading: 'Privacy Policy',
              body: [
                ['What we collect', 'An anonymous random device ID (generated on your device and never linked to your identity), your push notification subscription endpoint (required to deliver notifications), and your schedule settings.'],
                ['What we do NOT collect', 'No name, email address, phone number, location, or any personally identifiable information is ever collected or transmitted.'],
                ['How data is used', 'Your device ID, push endpoint, and schedule are stored temporarily on Cloudflare Workers solely to schedule and deliver your notifications. This data is not used for any other purpose.'],
                ['Data retention', 'Schedule data on our server is automatically deleted after your shift ends or within 24 hours, whichever comes first. Cancelling reminders deletes it immediately.'],
                ['iOS notifications', 'If you use the ntfy.sh option for background notifications on iPhone, only your generated topic code (a random string) is shared with ntfy.sh. No personal data is involved.'],
                ['Third parties', 'Push notifications are delivered via Cloudflare Workers using standard Web Push (Google FCM / Apple APNS depending on your browser). No data is sold or shared with any third party beyond what is required for notification delivery.'],
                ['Local storage', 'Your settings are also saved in your browser\'s localStorage. This data never leaves your device except as described above.'],
              ],
            },
          ].map(section => (
            <div key={section.heading} style={{ marginBottom: 28 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 900, letterSpacing: '0.06em', color: '#e5342a', textTransform: 'uppercase', marginBottom: 14 }}>{section.heading}</div>
              {section.body.map(([title, text]) => (
                <div key={title} style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, color: 'var(--fg)', marginBottom: 4, letterSpacing: '0.04em' }}>{title}</div>
                  <div style={{ fontSize: 13, color: 'var(--lbl)', lineHeight: 1.7 }}>{text}</div>
                </div>
              ))}
            </div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 8 }}>Clock-Bot · Free app · No ads · No tracking</div>
        </div>
      </div>
    </div>
  )
}

function CollapseCard({ css, title, summary, open, onToggle, className, children, peek }) {
  return (
    <div className={className || ''} style={css.card}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--lbl)' }}>
            {title}
          </div>
          {!open && summary && (
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: '#e5342a', marginTop: 5, letterSpacing: '0.03em', lineHeight: 1.4 }}>
              {summary}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 10, marginTop: 2, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>
      {!open && peek && <div style={{ marginTop: 10 }}>{peek}</div>}
      <AnimatedReveal show={open} style={{ marginTop: 14 }}>{children}</AnimatedReveal>
    </div>
  )
}

function ResponsiveLayout({ css, s, update, schedule, isSet, handleSet, handleCancelClick, confirmCancel, isDirty, isOvernight, showLunch, showDinner, unpaidBreaks, nowMins, nextItem, nextTmrw, showToast }) {
  const openCards = s.openCards || DEFAULT.openCards
  const cardOrder = s.cardOrder || DEFAULT.cardOrder

  function toggleCard(id) {
    update({ openCards: { ...openCards, [id]: !openCards[id] } })
  }

  const endMin   = s.endMin ?? 0
  const endLabel = `${s.endHour}h${endMin ? ` ${String(endMin).padStart(2,'0')}m` : ''}`
  const start    = s.startHour * 60 + s.startMin

  const cardDefs = {
    schedulePreview: {
      title: '📋 SCHEDULE PREVIEW',
      summary: schedule.length === 0
        ? 'no reminders set'
        : `${schedule.length} reminders · next ${nextItem ? fmtTime(nextItem.fireAt) + (nextTmrw ? ' (tmrw)' : '') : ''}`,
      className: 'card-full',
      visible: true,
      peek: <ShiftTimeline s={s} schedule={schedule} showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks} update={update} />,
      render: () => <SchedulePreviewContent css={css} schedule={schedule} s={s} showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks} update={update} />,
    },
    shiftLength: {
      title: '🕔 CLOCK OUT',
      summary: `clock out ${fmtTime(start + s.endHour * 60 + endMin + unpaidBreaks)}  ·  ${endLabel} shift`,
      visible: true,
      render: () => <EndOfShiftCard css={css} s={s} update={update} unpaidBreaks={unpaidBreaks} isOvernight={isOvernight} showToast={showToast} />,
    },
    lunch: {
      title: '🍽️ LUNCH BREAK',
      summary: `clock out ${fmtTime(start + h2m(s.lunchHour))}  ·  ${s.lunchDuration} min break`,
      visible: showLunch,
      render: () => <LunchCard css={css} s={s} update={update} />,
    },
    dinner: {
      title: '🌙 DINNER BREAK',
      summary: `clock out ${fmtTime(start + h2m(s.dinnerHour))}  ·  ${s.dinnerDuration} min break`,
      visible: showDinner,
      render: () => <DinnerCard css={css} s={s} update={update} />,
    },
  }

  const visibleOrder = cardOrder.filter(id => cardDefs[id]?.visible)

  return (
    <div className="responsive-grid" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Clock-in — collapsible, fixed at top */}
      <CollapseCard
        css={css}
        className="card-full"
        title="⏰ YOUR START TIME"
        summary={`clock in ${fmtTime(start)} · warn ${s.startWarning} min early`}
        open={openCards.clockIn ?? true}
        onToggle={() => toggleCard('clockIn')}
      >
        <ClockInCard css={css} s={s} update={update} />
      </CollapseCard>

      {/* Collapsible + reorderable cards */}
      {visibleOrder.map(id => {
        const def = cardDefs[id]
        return (
          <CollapseCard
            key={id}
            css={css}
            title={def.title}
            summary={def.summary}
            open={openCards[id] ?? true}
            onToggle={() => toggleCard(id)}
            className={def.className || ''}
            peek={def.peek}
          >
            {def.render()}
          </CollapseCard>
        )
      })}

      {/* Set Reminders — fixed at bottom */}
      <div className="card-full">
        <button
          style={{ ...css.btnSet, ...(isDirty ? { background: '#d97706', animation: 'dirtyPulse 2s ease-in-out infinite' } : {}) }}
          onClick={handleSet}
        >
          {isDirty ? '⚠ SETTINGS CHANGED — UPDATE' : isSet ? '✓ UPDATE REMINDERS' : 'SET REMINDERS'}
        </button>
        {isSet && (
          <button
            style={{ ...css.btnCancel, ...(confirmCancel ? { borderColor: '#e5342a', color: '#e5342a' } : {}) }}
            onClick={handleCancelClick}
          >
            {confirmCancel ? '⚠ Tap again to confirm cancel' : 'Cancel Reminders'}
          </button>
        )}
        {isSet && nextItem && (() => {
          const eff = nextItem.fireAt < nowMins ? nextItem.fireAt + 1440 : nextItem.fireAt
          const diff = eff - nowMins
          const h = Math.floor(diff / 60), m = diff % 60
          const timeStr = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
          return (
            <div style={{ marginTop: 12, padding: '14px 16px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,.18)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Next Alert</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, color: 'var(--hint)' }}>
                  {fmtTime(nextItem.fireAt)}{nextTmrw ? ' · tomorrow' : ''}
                </div>
              </div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e5342a', lineHeight: 1 }}>
                fires in {timeStr}
              </div>
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--inp)', borderRadius: 8, borderLeft: '3px solid var(--bdr)' }}>
                <div style={{ fontSize: 9, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 3 }}>Notification</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: 'var(--fg2)' }}>
                  {nextItem.emoji} {nextItem.label}
                </div>
              </div>
            </div>
          )
        })()}
        {notifPermission() === 'denied' && (
          <div style={{ background: '#2a1a1a', border: '1px solid #e5342a', borderRadius: 10, padding: '12px 16px', marginTop: 14, fontSize: 13, color: 'var(--fg)', lineHeight: 1.6 }}>
            &#x26A0;&#xFE0F; Notifications blocked.{' '}
            {isDesktop
              ? 'Click the 🔒 lock icon in your browser\'s address bar → set Notifications to Allow → refresh the page.'
              : 'Go to Settings → this app → Notifications → Allow.'}
          </div>
        )}
        {isDesktop && notifPermission() !== 'denied' && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--hint)', textAlign: 'center', lineHeight: 1.6 }}>
            {notifPermission() === 'default' && 'You\'ll be asked to allow notifications when you tap Set Reminders.'}
            {notifPermission() === 'granted' && <>✓ Notifications allowed. <span style={{ color: 'var(--muted)' }}>On Brave, also enable <strong>brave://settings/privacy → Use Google services for push messaging</strong> so reminders fire when the browser is in the background.</span></>}
          </div>
        )}
      </div>
    </div>
  )
}

function CardOrderPanel({ s, update }) {
  const cardNames = {
    schedulePreview: '📋 Schedule Preview',
    shiftLength:     '🕔 Clock Out',
    lunch:           '🍽️ Lunch Break',
    dinner:          '🌙 Dinner Break',
  }
  const endTotal   = (s.endHour || 8) * 60 + (s.endMin ?? 0)
  const showLunch  = endTotal > 300
  const showDinner = endTotal > 720
  const order      = s.cardOrder || DEFAULT.cardOrder
  const visible    = order.filter(id => {
    if (id === 'lunch'  && !showLunch)  return false
    if (id === 'dinner' && !showDinner) return false
    return true
  })

  function move(id, dir) {
    const next   = [...order]
    const target = visible[visible.indexOf(id) + dir]
    if (!target) return
    const ai = next.indexOf(id), bi = next.indexOf(target)
    ;[next[ai], next[bi]] = [next[bi], next[ai]]
    update({ cardOrder: next })
  }

  const btn = active => ({
    background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 6,
    padding: '6px 11px', fontSize: 12, cursor: active ? 'pointer' : 'default',
    color: active ? 'var(--fg)' : 'var(--bdr)',
  })

  return (
    <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 16, marginTop: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Card Order</div>
      {visible.map((id, i) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < visible.length - 1 ? '1px solid var(--deep)' : 'none' }}>
          <div style={{ fontSize: 13, color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>{cardNames[id]}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => move(id, -1)} disabled={i === 0} style={btn(i > 0)}>▲</button>
            <button onClick={() => move(id, 1)} disabled={i === visible.length - 1} style={btn(i < visible.length - 1)}>▼</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function NtfySetupCard({ css, deviceId }) {
  const topic = getNtfyTopic(deviceId)
  const [copied, setCopied] = useState(false)

  function copyTopic() {
    navigator.clipboard?.writeText(topic).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{ ...css.card, marginTop: 0 }}>
      <div style={css.lbl}>&#x1F514; BACKGROUND NOTIFICATIONS</div>
      <div style={{ fontSize: 13, color: 'var(--fg2)', lineHeight: 1.6, marginBottom: 16 }}>
        iPhone requires the free <span style={{ color: 'var(--fg)', fontWeight: 700 }}>ntfy</span> app
        to deliver alerts when your screen is off.
      </div>

      <a
        href="https://apps.apple.com/app/ntfy/id1625396347"
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'block', background: 'transparent', border: '1.5px solid #e5342a', borderRadius: 10, padding: '12px 16px', textDecoration: 'none', textAlign: 'center', color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, letterSpacing: '0.06em', marginBottom: 16 }}
      >
        1 &nbsp;·&nbsp; DOWNLOAD NTFY — FREE ON APP STORE ↗
      </a>

      <div style={{ fontSize: 11, color: 'var(--lbl)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
        2 &nbsp;·&nbsp; Your notification code
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--inp)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
        <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 14, color: '#32d74b', letterSpacing: '0.04em', wordBreak: 'break-all' }}>{topic}</span>
        <button
          onClick={copyTopic}
          style={{ background: 'none', border: '1px solid var(--bdr)', borderRadius: 6, padding: '5px 12px', color: copied ? '#32d74b' : 'var(--lbl)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'color .15s', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--hint)', lineHeight: 1.6 }}>
        <span style={{ color: 'var(--lbl)' }}>3 &nbsp;·&nbsp;</span>
        Open ntfy &rarr; tap <span style={{ color: 'var(--fg2)', fontWeight: 700 }}>+</span> &rarr; paste code &rarr; <span style={{ color: 'var(--fg2)', fontWeight: 700 }}>Subscribe</span>
        <br />
        <span style={{ color: 'var(--lbl)' }}>4 &nbsp;·&nbsp;</span>
        Come back here and press <span style={{ color: 'var(--fg2)', fontWeight: 700 }}>Set Reminders</span>
      </div>

      <div style={{ marginTop: 16, padding: '11px 13px', background: 'rgba(50,215,75,0.07)', border: '1px solid rgba(50,215,75,0.25)', borderRadius: 10 }}>
        <div style={{ fontSize: 11, color: '#32d74b', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>⏰ Make it ring like an alarm</div>
        <div style={{ fontSize: 12.5, color: 'var(--hint)', lineHeight: 1.6 }}>
          In the ntfy app, open your subscription &rarr; notification settings and set it to
          <span style={{ color: 'var(--fg2)', fontWeight: 700 }}> Max priority</span>. On Android also pick a
          loud sound and turn on <span style={{ color: 'var(--fg2)', fontWeight: 700 }}>Insistent</span> so it
          vibrates and repeats until you look. Alerts already go out at max priority.
        </div>
      </div>
    </div>
  )
}

// Debug-panel gate. Only a salted SHA-256 hash of the password lives in the
// repo — the plaintext never appears in source or git history. The entered
// password is hashed client-side and compared. (Still client-side, so it's a
// speed-bump for a diagnostics panel, not a secret store; the strong random
// password makes offline brute-forcing of the hash infeasible.)
const DEBUG_SALT = '4e95c46053033dd951e1e22de1c40bf2'
const DEBUG_HASH = 'ade231cf8b8ff20b40340f4badd19183562ab7b5014d26045c9a1021240e07de'

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function DebugPanel({ deviceId, lastSetError, schedule, nowMins }) {
  const [pw, setPw]             = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pwError, setPwError]   = useState(false)
  const [status, setStatus]     = useState(null)
  const [ntfyRes, setNtfyRes]   = useState(null)
  const [pushRes, setPushRes]   = useState(null)
  const [regRes, setRegRes]     = useState(null)
  const [cronLog, setCronLog]   = useState(null)
  const [schedRes, setSchedRes] = useState(null)
  const [schemeTry, setSchemeTry] = useState('ukgready://')
  const [loading, setLoading]   = useState('')
  const [subInfo, setSubInfo]   = useState(null)
  const [swState, setSwState]   = useState(null)
  const [battery, setBattery]   = useState(null)
  const [clearDone, setClearDone] = useState(false)

  useEffect(() => {
    if (!unlocked) return
    ;(async () => {
      if (!('serviceWorker' in navigator)) { setSubInfo({ error: 'No service worker support' }); return }
      try {
        const reg = await navigator.serviceWorker.ready
        setSwState(reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'unknown')
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          setSubInfo({ exists: true, endpoint: new URL(sub.endpoint).host })
        } else {
          try {
            const newSub = await reg.pushManager.subscribe({
              userVisibleOnly:      true,
              applicationServerKey: b64url_to_uint8(VAPID_PUBLIC_KEY),
            })
            setSubInfo({ exists: true, freshlyCreated: true, endpoint: new URL(newSub.endpoint).host })
          } catch (e) {
            setSubInfo({ exists: false, subscribeError: e.message || String(e) })
          }
        }
      } catch (e) {
        setSubInfo({ error: e.message || String(e) })
      }
      if ('getBattery' in navigator) {
        try { const b = await navigator.getBattery(); setBattery(`${Math.round(b.level * 100)}% ${b.charging ? '⚡ charging' : '🔋'}`) } catch {}
      }
    })()
  }, [unlocked])

  async function tryUnlock() {
    try {
      const hash = await sha256hex(DEBUG_SALT + pw)
      if (hash === DEBUG_HASH) { setUnlocked(true); setPwError(false) }
      else setPwError(true)
    } catch {
      setPwError(true)
    }
  }

  async function hit(path, setter, key) {
    setLoading(key)
    try {
      const r = await fetch(`${WORKER_URL}${path}`)
      setter(await r.json())
    } catch (e) {
      setter({ error: e.message })
    }
    setLoading('')
  }

  const mono = { fontFamily: 'monospace', fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }
  const box  = { background: 'var(--deep)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 12px', marginTop: 8 }
  const btn  = { background: 'var(--inp)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 14px', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'left', width: '100%' }

  if (!unlocked) {
    return (
      <div style={{ marginTop: 16, borderTop: '1px solid var(--bdr)', paddingTop: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>🔒 Debug</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            value={pw}
            placeholder="Password"
            onChange={e => { setPw(e.target.value); setPwError(false) }}
            onKeyDown={e => e.key === 'Enter' && tryUnlock()}
            style={{ flex: 1, background: 'var(--inp)', border: `1.5px solid ${pwError ? '#e5342a' : 'var(--bdr)'}`, borderRadius: 8, padding: '9px 12px', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, outline: 'none' }}
          />
          <button onClick={tryUnlock} style={{ background: 'var(--bdr)', border: 'none', borderRadius: 8, padding: '9px 16px', color: 'var(--fg)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            Unlock
          </button>
        </div>
        {pwError && <div style={{ fontSize: 11, color: '#e5342a', marginTop: 6 }}>Wrong password</div>}
      </div>
    )
  }

  const sectionHdr = lbl => (
    <div style={{ fontSize: 10, color: 'var(--hint)', marginBottom: 4, marginTop: 14, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{lbl}</div>
  )
  const infoRow = (label, val, ok) => (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid var(--inp)', gap: 8 }}>
      <span style={{ fontSize: 10, color: 'var(--hint)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 10, fontFamily: 'monospace', color: ok === true ? '#32d74b' : ok === false ? '#e5342a' : '#aeaeb2', textAlign: 'right', wordBreak: 'break-all' }}>{val}</span>
    </div>
  )

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--bdr)', paddingTop: 16 }}>
      <div style={{ fontSize: 11, color: '#32d74b', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>🔓 Debug</div>
      {lastSetError && (
        <div style={{ background: '#2a1010', border: '1px solid #e5342a', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: '#e5342a', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          ⚠ Last Set Reminders error:{'\n'}{lastSetError}
        </div>
      )}

      {/* Environment */}
      {sectionHdr('Environment')}
      <div style={{ ...box, marginTop: 0 }}>
        {[
          ['Installed PWA',  window.navigator.standalone === true ? 'Yes' : 'No — add to home screen', window.navigator.standalone === true],
          ['Notifications',  notifPermission() === 'granted' ? 'Granted' : notifPermission(), notifPermission() === 'granted'],
          ['Service Worker', 'serviceWorker' in navigator ? `Supported · ${swState ?? '…'}` : 'Not supported', 'serviceWorker' in navigator],
          ['Push API',       'PushManager' in window ? 'Supported' : 'Not supported', 'PushManager' in window],
          ['Push Sub',       subInfo == null ? '…' : subInfo.exists ? subInfo.endpoint : subInfo.subscribeError ?? subInfo.error ?? 'None', subInfo?.exists ?? null],
          ['Network',        navigator.onLine ? 'Online' : 'Offline', navigator.onLine],
          ['Battery',        battery ?? 'N/A', null],
          ['Time Zone',      Intl.DateTimeFormat().resolvedOptions().timeZone, null],
          ['Local Time',     new Date().toLocaleTimeString(), null],
          ['Platform',       navigator.userAgentData?.platform ?? navigator.platform ?? 'Unknown', null],
          ['Browser',        (() => { const ua = navigator.userAgent; const m = ua.match(/(Chrome|Firefox|Safari|Edge|OPR)\/[\d.]+/g); return m ? m[m.length - 1] : ua.slice(0, 40) })(), null],
        ].map(([l, v, ok]) => infoRow(l, v, ok))}
      </div>

      {/* IDs */}
      {sectionHdr('Device ID')}
      <div style={{ ...box, marginTop: 0 }}><pre style={{ ...mono, color: '#8e8e93' }}>{deviceId}</pre></div>
      {sectionHdr('ntfy Topic')}
      <div style={{ ...box, marginTop: 0 }}><pre style={{ ...mono, color: '#32d74b' }}>{getNtfyTopic(deviceId)}</pre></div>

      {/* Current Schedule */}
      {sectionHdr('Active Schedule')}
      <div style={{ ...box, marginTop: 0 }}>
        {schedule && schedule.length > 0 ? schedule.slice().sort((a, b) => a.fireAt - b.fireAt).map(item => {
          const eff = item.fireAt < nowMins ? item.fireAt + 1440 : item.fireAt
          const diff = eff - nowMins
          const h = Math.floor(diff / 60), m = diff % 60
          const rel = diff <= 0 ? 'now' : h > 0 ? `in ${h}h ${m}m` : `in ${m}m`
          const past = item.fireAt < nowMins
          return (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--inp)', opacity: past ? 0.45 : 1 }}>
              <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--fg2)' }}>{item.emoji} {item.id}</span>
              <span style={{ fontSize: 10, fontFamily: 'monospace', color: past ? 'var(--hint)' : '#32d74b' }}>{fmtTime(item.fireAt)} · {rel}</span>
            </div>
          )
        }) : <span style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>No schedule set</span>}
      </div>

      {/* LocalStorage */}
      {sectionHdr('Local Storage')}
      <div style={{ ...box, marginTop: 0 }}>
        {[STORAGE_KEY, 'qwik_crew_isset', 'qwik_crew_user_default', 'qwik_crew_device'].map(k => {
          const v = localStorage.getItem(k)
          return infoRow(k.replace('qwik_crew_', ''), v == null ? '—' : v.length > 40 ? `${v.length} chars` : v, v != null)
        })}
      </div>

      {/* Actions */}
      {sectionHdr('Actions')}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button style={{ ...btn, borderColor: '#32d74b', color: '#32d74b' }} disabled={loading === 'reg'} onClick={async () => {
          setLoading('reg')
          try {
            const reg = await navigator.serviceWorker.ready
            const sub = await reg.pushManager.getSubscription()
            if (!sub) { setRegRes({ error: 'No push subscription found — press Set Reminders first' }); setLoading(''); return }
            const res = await fetch(WORKER_URL, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ action: 'subscribe', deviceId, subscription: sub.toJSON(), schedule: [{ id: 'test', fireAtISO: new Date(Date.now() + 300000).toISOString(), label: 'Debug test', emoji: '🧪' }], ntfyTopic: getNtfyTopic(deviceId) }),
            })
            const json = await res.json().catch(() => ({}))
            setRegRes({ http_status: res.status, ok: res.ok, ...json })
          } catch (e) {
            setRegRes({ error: e.message || String(e) })
          }
          setLoading('')
        }}>
          {loading === 'reg' ? '⏳ Registering...' : '🔗 Force Register with Server'}
        </button>
        {regRes && <div style={box}><pre style={{ ...mono, color: regRes.ok ? '#32d74b' : '#e5342a' }}>{JSON.stringify(regRes, null, 2)}</pre></div>}

        <button style={btn} disabled={loading === 'status'} onClick={() => hit(`/status?deviceId=${deviceId}`, setStatus, 'status')}>
          {loading === 'status' ? '⏳ Checking...' : '📡 Check Server Status'}
        </button>
        {status && <div style={box}><pre style={{ ...mono, color: status.exists === false || status.error ? '#e5342a' : '#aeaeb2' }}>{JSON.stringify(status, null, 2)}</pre></div>}

        <button style={btn} disabled={loading === 'ntfy'} onClick={() => hit(`/test-ntfy?topic=${getNtfyTopic(deviceId)}`, setNtfyRes, 'ntfy')}>
          {loading === 'ntfy' ? '⏳ Sending...' : '🔔 Test ntfy Notification'}
        </button>
        {ntfyRes && <div style={box}><pre style={{ ...mono, color: ntfyRes.ok ? '#32d74b' : '#e5342a' }}>{JSON.stringify(ntfyRes, null, 2)}</pre></div>}

        <button style={btn} disabled={loading === 'push'} onClick={() => hit(`/test-push?deviceId=${deviceId}`, setPushRes, 'push')}>
          {loading === 'push' ? '⏳ Sending...' : '📲 Test Web Push'}
        </button>
        {pushRes && <div style={box}><pre style={{ ...mono, color: pushRes.ok ? '#32d74b' : '#e5342a' }}>{JSON.stringify(pushRes, null, 2)}</pre></div>}

        <button style={{ ...btn, borderColor: '#8b5cf6', color: '#a78bfa' }} disabled={loading === 'sched'} onClick={() => hit(`/schedule-test?deviceId=${deviceId}&min=2`, setSchedRes, 'sched')}>
          {loading === 'sched' ? '⏳ Scheduling...' : '⏱️ Test in 2 min — then CLOSE the app'}
        </button>
        {schedRes && <div style={box}>
          <pre style={{ ...mono, color: schedRes.ok ? '#32d74b' : '#e5342a' }}>{JSON.stringify(schedRes, null, 2)}</pre>
          {schedRes.ok && <div style={{ fontSize: 11, color: '#a78bfa', marginTop: 6, lineHeight: 1.5 }}>Now fully close the app (swipe it away). A push + ntfy should arrive in ~2 min while it's closed — that proves background delivery.</div>}
        </div>}

        <button style={btn} disabled={loading === 'log'} onClick={() => hit('/cron-log', setCronLog, 'log')}>
          {loading === 'log' ? '⏳ Loading...' : '📋 Cron Log'}
        </button>
        {cronLog && <div style={box}><pre style={{ ...mono, color: '#aeaeb2' }}>{JSON.stringify(cronLog.slice(0, 5), null, 2)}</pre></div>}

        {/* UKG app scheme finder — try candidates until one launches the app */}
        <div style={{ ...box, marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>UKG App Scheme Finder</div>
          <div style={{ fontSize: 11, color: 'var(--hint)', lineHeight: 1.5, marginBottom: 8 }}>
            Type a scheme and tap Try. If the UKG Ready app opens, that's the one — tell me and I'll bake it in. Candidates: <span style={{ color: 'var(--fg2)' }}>ukgready://</span>, <span style={{ color: 'var(--fg2)' }}>workforceready://</span>, <span style={{ color: 'var(--fg2)' }}>kronos://</span>, <span style={{ color: 'var(--fg2)' }}>com.kronos.workforceready://</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={schemeTry}
              onChange={e => setSchemeTry(e.target.value)}
              placeholder="ukgready://"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              style={{ flex: 1, background: 'var(--inp)', border: '1.5px solid var(--bdr)', borderRadius: 8, padding: '9px 12px', color: 'var(--fg)', fontFamily: 'monospace', fontSize: 13, outline: 'none', minWidth: 0 }}
            />
            <button
              onClick={() => { try { window.location.href = schemeTry } catch {} }}
              style={{ background: '#8b5cf6', border: 'none', borderRadius: 8, padding: '9px 16px', color: '#fff', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
            >
              Try ↗
            </button>
          </div>
        </div>

        <button style={{ ...btn, borderColor: '#e5342a', color: clearDone ? '#32d74b' : '#e5342a' }} onClick={() => {
          if (!clearDone) {
            [STORAGE_KEY, 'qwik_crew_isset', 'qwik_crew_user_default'].forEach(k => localStorage.removeItem(k))
            setClearDone(true)
            setTimeout(() => window.location.reload(), 800)
          }
        }}>
          {clearDone ? '✓ Cleared — reloading…' : '🗑 Clear App Storage & Reset'}
        </button>
      </div>
    </div>
  )
}

function Toggle({ on, onToggle, label }) {
  return (
    <button
      onClick={onToggle}
      aria-label={label}
      style={{
        padding: '7px 14px', borderRadius: 8,
        border: `2px solid ${on ? '#32d74b' : 'rgba(229,52,42,0.22)'}`,
        background: on ? 'rgba(50,215,75,0.13)' : 'rgba(229,52,42,0.06)',
        color: on ? '#32d74b' : 'var(--hint)',
        fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        cursor: 'pointer', transition: 'all .15s', flexShrink: 0, whiteSpace: 'nowrap',
        minWidth: 56, textAlign: 'center',
      }}
    >
      {on ? '✓ ON' : 'OFF'}
    </button>
  )
}

function EndOfShiftCard({ css, s, update, unpaidBreaks, isOvernight, showToast }) {
  const [wheelOpen, setWheelOpen] = useState(false)
  const [warnFlash, setWarnFlash] = useState(null)
  const warnTimer = useRef(null)
  const endMin   = s.endMin ?? 0
  const endLabel = `${s.endHour}h${endMin ? ` ${String(endMin).padStart(2, '0')}m` : ''}`

  const clockOutTotal = (s.startHour * 60 + s.startMin + s.endHour * 60 + endMin + unpaidBreaks) % 1440
  const coH24  = Math.floor(clockOutTotal / 60)
  const coM    = clockOutTotal % 60
  const coH12  = coH24 % 12 === 0 ? 12 : coH24 % 12
  const coAmpm = coH24 < 12 ? 'AM' : 'PM'

  function recalcFromTime(h24, m) {
    const startMins = s.startHour * 60 + s.startMin
    let elapsed = h24 * 60 + m - startMins
    if (elapsed <= 0) elapsed += 1440
    const workedMins = elapsed - (unpaidBreaks ?? 0)
    if (workedMins < 240) { showToast?.('Minimum shift is 4h', '#d97706'); return }
    update({ endHour: Math.min(24, Math.floor(workedMins / 60)), endMin: workedMins % 60 })
  }

  function handleEndWarning(v) {
    update({ endWarning: v })
    clearTimeout(warnTimer.current)
    const endOutMins = s.startHour * 60 + s.startMin + s.endHour * 60 + endMin + (unpaidBreaks ?? 0)
    setWarnFlash({ text: `Notified at ${fmtTime(endOutMins - v)}`, k: nextKey() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  return (
    <>
      {/* Time display box — tap to open wheel */}
      <div
        onClick={() => setWheelOpen(o => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--inp)', border: `1.5px solid ${wheelOpen ? '#e5342a' : 'var(--bdr)'}`, borderRadius: 10, padding: '13px 14px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700, color: 'var(--fg)', transition: 'border-color .15s', userSelect: 'none' }}
      >
        <span>
          {String(coH12).padStart(2, '0')}
          <span style={{ color: '#e5342a', margin: '0 3px' }}>:</span>
          {String(coM).padStart(2, '0')}
          <span style={{ color: 'var(--lbl)', marginLeft: 8, fontSize: 15, fontWeight: 700 }}>{coAmpm}</span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.1em' }}>
          {wheelOpen ? 'DONE ▲' : 'EDIT ▼'}
        </span>
      </div>

      {/* Collapsible wheel */}
      <AnimatedReveal show={wheelOpen} style={{ marginTop: 8 }}>
        <div style={{ background: 'var(--inp)', borderRadius: 14, padding: '6px 0 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)', height: 44, borderRadius: 10, border: '1.5px solid #e5342a33', background: '#e5342a08', pointerEvents: 'none' }} />
            <WheelCol items={WHEEL_HOURS} value={coH12} onChange={h => recalcFromTime((h % 12) + (coAmpm === 'PM' ? 12 : 0), coM)} />
            <div style={{ fontSize: 30, fontWeight: 800, color: '#e5342a', padding: '0 2px', lineHeight: 1, userSelect: 'none' }}>:</div>
            <WheelCol items={WHEEL_MINS} value={coM} onChange={m => recalcFromTime(coH24, m)} fmt={v => String(v).padStart(2, '0')} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['AM', 'PM'].map(ap => (
              <button key={ap}
                onClick={e => { e.stopPropagation(); ap !== coAmpm && recalcFromTime((coH12 % 12) + (ap === 'PM' ? 12 : 0), coM) }}
                style={{ padding: '6px 20px', borderRadius: 8, border: 'none', cursor: ap === coAmpm ? 'default' : 'pointer', background: ap === coAmpm ? '#e5342a' : 'var(--muted)', color: ap === coAmpm ? '#fff' : 'var(--fg2)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', transition: 'all .15s', outline: 'none' }}>
                {ap}
              </button>
            ))}
          </div>
        </div>
      </AnimatedReveal>

      <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 8, lineHeight: 1.6 }}>
        <span style={{ color: '#e5342a', fontWeight: 700 }}>{endLabel}</span> shift
        {unpaidBreaks > 0 && <span> + <span style={{ color: '#8e8e93' }}>{unpaidBreaks}m unpaid</span></span>}
      </div>
      {isOvernight && (
        <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 10, background: '#1a1a2e', border: '1px solid #5a5aff', fontSize: 11, color: '#8888ff', fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.08em' }}>
          🌙 Overnight — clock-out next day
        </div>
      )}

      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE SHIFT END
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.ewOn !== false && <span style={css.val}>{s.endWarning} min</span>}
          <Toggle on={s.ewOn !== false} onToggle={() => update({ ewOn: s.ewOn === false })} label="Toggle shift-end heads-up" />
        </div>
      </div>
      {s.ewOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={30} step={1} value={s.endWarning}
            onChange={e => handleEndWarning(Number(e.target.value))} />
          <div style={css.sliderLabels}><span>2 min early</span><span>30 min early</span></div>
        </div>
      )}
      {warnFlash && s.ewOn !== false && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}

      <div style={css.divider} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>End-of-shift reminder</div>
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>
            {s.endEnabled ? 'On — remind me to clock out' : 'Off — no end-of-shift alert'}
          </div>
        </div>
        <Toggle on={s.endEnabled} onToggle={() => update({ endEnabled: !s.endEnabled })} label="Toggle end-of-shift reminder" />
      </div>

      {s.endEnabled && (
        <>
          <div style={css.divider} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>❓ 30-min follow-up</div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>
                {s.endFollowupEnabled ? 'On — "Still on the clock?" alert' : 'Off — no follow-up'}
              </div>
            </div>
            <Toggle on={s.endFollowupEnabled} onToggle={() => update({ endFollowupEnabled: !s.endFollowupEnabled })} label="Toggle follow-up reminder" />
          </div>
          {s.endFollowupEnabled && (
            <>
              <div style={css.divider} />
              <div style={css.lbl}>
                &#x2753; FOLLOW-UP DELAY
                <span style={css.val}>{s.endFollowupDelay ?? 30} min</span>
              </div>
              <div style={css.segRow}>
                {[15, 30, 45].map(v => (
                  <button
                    key={v}
                    style={{ ...css.segBase, ...((s.endFollowupDelay ?? 30) === v ? css.segActive : {}) }}
                    onClick={() => update({ endFollowupDelay: v })}
                  >
                    {v} min
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

function DurDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--inp)', border: `1.5px solid ${open ? '#e5342a' : 'var(--bdr)'}`, borderRadius: 10, padding: '11px 14px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 700, color: 'var(--fg)', transition: 'border-color .15s', userSelect: 'none' }}
      >
        <span>{value} min</span>
        <span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.1em' }}>
          {open ? 'DONE ▲' : 'EDIT ▼'}
        </span>
      </div>
      <AnimatedReveal show={open}>
        <div style={{ marginTop: 4, background: 'var(--inp)', border: '1.5px solid #e5342a', borderRadius: 10, overflow: 'hidden' }}>
          {DUR_OPTS.map((o, i) => (
            <div
              key={o.v}
              onClick={() => { onChange(o.v); setOpen(false); navigator.vibrate?.(10) }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, color: o.v === value ? '#e5342a' : 'var(--fg)', background: o.v === value ? '#e5342a0f' : 'transparent', borderBottom: i < DUR_OPTS.length - 1 ? '1px solid var(--bdr)' : 'none' }}
            >
              <span>{o.l}</span>
              {o.v === value && <span style={{ fontSize: 13 }}>✓</span>}
            </div>
          ))}
        </div>
      </AnimatedReveal>
    </>
  )
}

function ClockInCard({ css, s, update }) {
  const [wheelOpen, setWheelOpen] = useState(false)
  const [warnFlash, setWarnFlash] = useState(null)
  const warnTimer  = useRef(null)
  const start      = s.startHour * 60 + s.startMin
  const h12  = s.startHour % 12 === 0 ? 12 : s.startHour % 12
  const ampm = s.startHour < 12 ? 'AM' : 'PM'

  function handleStartWarning(v) {
    update({ startWarning: v })
    clearTimeout(warnTimer.current)
    setWarnFlash({ text: `Notified at ${fmtTime(start - v)}`, k: nextKey() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  async function sendTestNotif() {
    if (!notifSupported) return
    if (notifPermission() === 'default') await Notification.requestPermission()
    if (notifPermission() === 'granted') {
      new Notification('🧪 Clock-Bot Test', { body: 'Notifications are working!', icon: '/icon-192.png' })
    }
  }

  return (
    <>
      {/* Time display box — tap to open wheel */}
      <div
        onClick={() => setWheelOpen(o => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--inp)', border: `1.5px solid ${wheelOpen ? '#e5342a' : 'var(--bdr)'}`, borderRadius: 10, padding: '13px 14px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700, color: 'var(--fg)', transition: 'border-color .15s', userSelect: 'none' }}
      >
        <span>
          {String(h12).padStart(2, '0')}
          <span style={{ color: '#e5342a', margin: '0 3px' }}>:</span>
          {String(s.startMin).padStart(2, '0')}
          <span style={{ color: 'var(--lbl)', marginLeft: 8, fontSize: 15, fontWeight: 700 }}>{ampm}</span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 700, letterSpacing: '0.1em' }}>
          {wheelOpen ? 'DONE ▲' : 'EDIT ▼'}
        </span>
      </div>

      {/* Collapsible wheel */}
      <AnimatedReveal show={wheelOpen} style={{ marginTop: 8 }}>
        <div style={{ background: 'var(--inp)', borderRadius: 14, padding: '6px 0 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          {/* Hour : Minute wheels */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)', height: 44, borderRadius: 10, border: '1.5px solid #e5342a33', background: '#e5342a08', pointerEvents: 'none' }} />
            <WheelCol items={WHEEL_HOURS} value={h12} onChange={h => update({ startHour: (h % 12) + (ampm === 'PM' ? 12 : 0) })} />
            <div style={{ fontSize: 30, fontWeight: 800, color: '#e5342a', padding: '0 2px', lineHeight: 1, userSelect: 'none' }}>:</div>
            <WheelCol items={WHEEL_MINS} value={s.startMin} onChange={m => update({ startMin: m })} fmt={v => String(v).padStart(2, '0')} />
          </div>
          {/* AM / PM below wheels — outside the selection box */}
          <div style={{ display: 'flex', gap: 8 }}>
            {['AM', 'PM'].map(ap => (
              <button key={ap}
                onClick={e => { e.stopPropagation(); ap !== ampm && update({ startHour: s.startHour < 12 ? s.startHour + 12 : s.startHour - 12 }) }}
                style={{ padding: '6px 20px', borderRadius: 8, border: 'none', cursor: ap === ampm ? 'default' : 'pointer', background: ap === ampm ? '#e5342a' : 'var(--muted)', color: ap === ampm ? '#fff' : 'var(--fg2)', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', transition: 'all .15s', outline: 'none' }}>
                {ap}
              </button>
            ))}
          </div>
        </div>
      </AnimatedReveal>

      <div style={css.hint}>&#x1F4A1; Set this the night before if you know your start time</div>
      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE CLOCK-IN
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.ciWarnOn !== false && <span style={css.val}>{s.startWarning} min</span>}
          <Toggle on={s.ciWarnOn !== false} onToggle={() => update({ ciWarnOn: s.ciWarnOn === false })} label="Toggle clock-in heads-up" />
        </div>
      </div>
      {s.ciWarnOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={15} step={1} value={s.startWarning}
            onChange={e => handleStartWarning(Number(e.target.value))} />
          <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
        </div>
      )}
      {warnFlash && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <button
        onClick={sendTestNotif}
        style={{ width: '100%', padding: '10px 14px', background: 'transparent', color: 'var(--hint)', border: '1.5px solid var(--bdr)', borderRadius: 10, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.06em' }}
      >
        🧪 Send Test Notification
      </button>
    </>
  )
}

function LunchCard({ css, s, update }) {
  const [lunchFlash, setLunchFlash] = useState(null)
  const lunchFlashTimer = useRef(null)
  const [warnFlash, setWarnFlash]   = useState(null)
  const warnTimer                   = useRef(null)

  function handleLunchWarning(v) {
    update({ lunchWarning: v })
    clearTimeout(warnTimer.current)
    const lunchOutMins = s.startHour * 60 + s.startMin + h2m(s.lunchHour)
    setWarnFlash({ text: `Notified at ${fmtTime(lunchOutMins - v)}`, k: nextKey() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  function pickLunchHour(v) {
    update({ lunchHour: v })
    const t = fmtTime(s.startHour * 60 + s.startMin + h2m(v))
    clearTimeout(lunchFlashTimer.current)
    setLunchFlash({ text: `Clock out at ${t}`, k: nextKey() })
    lunchFlashTimer.current = setTimeout(() => setLunchFlash(null), 2500)
  }

  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--lbl)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
      <div style={css.segRow}>
        {LUNCH_OPTS.map(o => (
          <button key={o.v} style={{ ...css.segBase, ...(s.lunchHour === o.v ? css.segActive : {}) }} onClick={() => pickLunchHour(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
      {lunchFlash && (
        <div key={lunchFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {lunchFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <div style={{ fontSize: 11, color: 'var(--lbl)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>&#x23F1; Lunch Duration</div>
      <DurDropdown value={s.lunchDuration} onChange={v => update({ lunchDuration: v })} />
      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE LUNCH
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.lwOn !== false && <span style={css.val}>{s.lunchWarning} min</span>}
          <Toggle on={s.lwOn !== false} onToggle={() => update({ lwOn: s.lwOn === false })} label="Toggle lunch heads-up" />
        </div>
      </div>
      {s.lwOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={15} step={1} value={s.lunchWarning}
            onChange={e => handleLunchWarning(Number(e.target.value))} />
          <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
        </div>
      )}
      {warnFlash && s.lwOn !== false && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE CLOCK BACK IN
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.liWarnOn !== false && <span style={css.val}>{s.liWarning ?? 5} min</span>}
          <Toggle on={s.liWarnOn !== false} onToggle={() => update({ liWarnOn: s.liWarnOn === false })} label="Toggle clock-back-in heads-up" />
        </div>
      </div>
      {s.liWarnOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={15} step={1} value={s.liWarning ?? 5}
            onChange={e => update({ liWarning: Number(e.target.value) })} />
          <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
        </div>
      )}
    </>
  )
}

function DinnerCard({ css, s, update }) {
  const [dinnerFlash, setDinnerFlash] = useState(null)
  const dinnerFlashTimer = useRef(null)
  const [warnFlash, setWarnFlash]   = useState(null)
  const warnTimer                   = useRef(null)

  function handleDinnerWarning(v) {
    update({ dinnerWarning: v })
    clearTimeout(warnTimer.current)
    const dinnerOutMins = s.startHour * 60 + s.startMin + h2m(s.dinnerHour)
    setWarnFlash({ text: `Notified at ${fmtTime(dinnerOutMins - v)}`, k: nextKey() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  function pickDinnerHour(v) {
    update({ dinnerHour: v })
    const t = fmtTime(s.startHour * 60 + s.startMin + h2m(v))
    clearTimeout(dinnerFlashTimer.current)
    setDinnerFlash({ text: `Clock out at ${t}`, k: nextKey() })
    dinnerFlashTimer.current = setTimeout(() => setDinnerFlash(null), 2500)
  }

  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--lbl)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
      <div style={css.segRow}>
        {DINNER_OPTS.map(o => (
          <button key={o.v} style={{ ...css.segBase, ...(s.dinnerHour === o.v ? css.segActive : {}) }} onClick={() => pickDinnerHour(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
      {dinnerFlash && (
        <div key={dinnerFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {dinnerFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <div style={{ fontSize: 11, color: 'var(--lbl)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>&#x23F1; Dinner Duration</div>
      <DurDropdown value={s.dinnerDuration} onChange={v => update({ dinnerDuration: v })} />
      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE DINNER
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.dwOn !== false && <span style={css.val}>{s.dinnerWarning} min</span>}
          <Toggle on={s.dwOn !== false} onToggle={() => update({ dwOn: s.dwOn === false })} label="Toggle dinner heads-up" />
        </div>
      </div>
      {s.dwOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={15} step={1} value={s.dinnerWarning}
            onChange={e => handleDinnerWarning(Number(e.target.value))} />
          <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
        </div>
      )}
      {warnFlash && s.dwOn !== false && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <div style={{ ...css.lbl, alignItems: 'center' }}>
        &#x1F514; HEADS-UP BEFORE CLOCK BACK IN
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.dinWarnOn !== false && <span style={css.val}>{s.dinWarning ?? 5} min</span>}
          <Toggle on={s.dinWarnOn !== false} onToggle={() => update({ dinWarnOn: s.dinWarnOn === false })} label="Toggle dinner clock-back-in heads-up" />
        </div>
      </div>
      {s.dinWarnOn !== false && (
        <div style={css.sliderWrap}>
          <input type="range" min={2} max={15} step={1} value={s.dinWarning ?? 5}
            onChange={e => update({ dinWarning: Number(e.target.value) })} />
          <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
        </div>
      )}
      <div style={css.divider} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>Dinner reminders</div>
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>
            {s.dinnerEnabled ? 'On — working a long day' : 'Off — no dinner break today'}
          </div>
        </div>
        <Toggle on={s.dinnerEnabled} onToggle={() => update({ dinnerEnabled: !s.dinnerEnabled })} label="Toggle dinner reminders" />
      </div>
    </>
  )
}
