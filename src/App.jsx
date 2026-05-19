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

function ClockIcon({ size = 96 }) {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <rect x="24" y="24" width="72" height="72" rx="14"
            transform="rotate(45 60 60)"
            fill="#2c2c2e" stroke="#e5342a" strokeWidth="3"/>
      <circle cx="60" cy="60" r="27" fill="none" stroke="#3a3a3c" strokeWidth="1.5"/>
      {ticks.map(deg => {
        const rad = (deg - 90) * Math.PI / 180
        const major = deg % 90 === 0
        const r1 = major ? 20 : 23.5
        return (
          <line key={deg}
            x1={60 + r1 * Math.cos(rad)}      y1={60 + r1 * Math.sin(rad)}
            x2={60 + 27 * Math.cos(rad)}       y2={60 + 27 * Math.sin(rad)}
            stroke={major ? '#8e8e93' : '#3a3a3c'}
            strokeWidth={major ? 2 : 1.2}
            strokeLinecap="round"/>
        )
      })}
      <line x1="60" y1="60" x2="51" y2="73"
            stroke="#f2f2f7" strokeWidth="3.5" strokeLinecap="round"/>
      <line x1="60" y1="60" x2="60" y2="37"
            stroke="#e5342a" strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="60" cy="60" r="3" fill="#e5342a"/>
    </svg>
  )
}

const STORAGE_KEY = 'qwik_crew_v17'
const USER_DEFAULT_KEY = 'qwik_crew_user_default'

const DEFAULT = {
  startHour: 7,
  startMin: 0,
  startWarning: 5,
  lunchHour: 5.00,
  lunchWarning: 5,
  lunchDuration: 30,
  dinnerHour: 10.00,
  dinnerWarning: 5,
  dinnerDuration: 30,
  dinnerEnabled: true,
  endHour: 8,
  endMin: 0,
  endWarning: 15,
  endEnabled: true,
  endFollowupEnabled: true,
  endFollowupDelay: 30,
  adpUrl: 'https://workforcenow.adp.com',
  cardOrder: ['shiftLength', 'lunch', 'dinner', 'schedulePreview'],
  openCards: { schedulePreview: false, shiftLength: true, lunch: true, dinner: true, clockIn: true },
}

const LUNCH_OPTS = [
  { l: '4h 00m', v: 4.00 },
  { l: '4h 15m', v: 4.25 },
  { l: '4h 30m', v: 4.50 },
  { l: '4h 45m', v: 4.75 },
  { l: '5h 00m', v: 5.00 },
]

const DINNER_OPTS = [
  { l: '9h 00m',  v: 9.00 },
  { l: '9h 15m',  v: 9.25 },
  { l: '9h 30m',  v: 9.50 },
  { l: '9h 45m',  v: 9.75 },
  { l: '10h 00m', v: 10.00 },
]

const SHIFT_HOURS = Array.from({ length: 21 }, (_, i) => i + 4)
const SHIFT_MINS  = Array.from({ length: 60 }, (_, i) => i)

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

function pad2(n) { return String(n).padStart(2, '0') }

const notifSupported  = typeof Notification !== 'undefined'
const notifPermission = () => notifSupported ? Notification.permission : 'unsupported'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
  } catch {}
  try {
    const userDef = localStorage.getItem(USER_DEFAULT_KEY)
    if (userDef) return { ...DEFAULT, ...JSON.parse(userDef) }
  } catch {}
  return { ...DEFAULT }
}

export default function App() {
  const [s, setS]           = useState(loadState)
  const [isSet, setIsSet]   = useState(false)
  const [toast, setToast]   = useState(null)
  const [alert, setAlert]   = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [lastSetError, setLastSetError] = useState(null)
  const [setSnapshot, setSetSnapshot] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const cancelConfirmTimer = useRef(null)
  const timerIds   = useRef([])
  const toastTimer = useRef(null)
  const swReg      = useRef(null)
  const pushSub    = useRef(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/qwik-crew-clock/OneSignalSDKWorker.js', { scope: '/qwik-crew-clock/' })
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
      { id: 'ciw', emoji: '🔔', label: `Clock in in ${s.startWarning} min — heads up!`,   fireAt: start - s.startWarning },
      { id: 'ci',  emoji: '⏰', label: 'Clock In',                                         fireAt: start },
      ...(showLunch ? [
        { id: 'lw', emoji: '🔔', label: `Lunch in ${s.lunchWarning} min — heads up!`,     fireAt: lunchOut - s.lunchWarning },
        { id: 'lo', emoji: '🍽️', label: 'Clock Out — Lunch Break',                         fireAt: lunchOut },
        { id: 'li', emoji: '✅', label: `Clock Back In — Lunch (${s.lunchDuration} min)`, fireAt: lunchIn },
      ] : []),
      ...(showDinner && s.dinnerEnabled ? [
        { id: 'dw',   emoji: '🔔', label: `Dinner in ${s.dinnerWarning} min — heads up!`,     fireAt: dinnerOut - s.dinnerWarning },
        { id: 'dout', emoji: '🌙', label: 'Clock Out — Dinner Break',                         fireAt: dinnerOut },
        { id: 'din',  emoji: '🔁', label: `Clock Back In — Dinner (${s.dinnerDuration} min)`, fireAt: dinnerIn },
      ] : []),
      ...(s.endEnabled ? [
        { id: 'ew', emoji: '⚠️', label: `Shift ends in ${s.endWarning} min — heads up!`, fireAt: endOut - s.endWarning },
        { id: 'eo', emoji: '🏁', label: 'Clock Out — End of Shift',                      fireAt: endOut },
        ...(s.endFollowupEnabled ? [
          { id: 'ef', emoji: '❓', label: 'Still on the clock? Clock out now!',          fireAt: endOut + (s.endFollowupDelay ?? 30) },
        ] : []),
      ] : []),
    ]
  })()

  function scheduleKey(st) {
    return JSON.stringify({
      startHour: st.startHour, startMin: st.startMin, startWarning: st.startWarning,
      lunchHour: st.lunchHour, lunchWarning: st.lunchWarning, lunchDuration: st.lunchDuration,
      dinnerHour: st.dinnerHour, dinnerWarning: st.dinnerWarning, dinnerDuration: st.dinnerDuration, dinnerEnabled: st.dinnerEnabled,
      endHour: st.endHour, endMin: st.endMin, endWarning: st.endWarning, endEnabled: st.endEnabled,
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

      timerIds.current.push(setTimeout(() => setAlert({ emoji: item.emoji, label: item.label }), ms))
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

  const timeVal = `${pad2(s.startHour)}:${pad2(s.startMin)}`
  function handleTimeChange(e) {
    const [h, m] = e.target.value.split(':').map(Number)
    if (!isNaN(h) && !isNaN(m)) update({ startHour: h, startMin: m })
  }

  const css = {
    page:        { background: '#1c1c1e', minHeight: '100vh', overflowX: 'hidden', padding: '28px 0 40px', fontFamily: "'Barlow', sans-serif", color: '#f2f2f7' },
    inner:       { maxWidth: 920, margin: '0 auto', padding: '0 16px' },
    headerWrap:  { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 },
    rule:        { width: 40, height: 2, background: '#e5342a', borderRadius: 2, marginTop: 20 },
    tagline:     { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#636366', marginTop: 8 },
    card:        { background: '#2c2c2e', border: '1px solid #3a3a3c', borderRadius: 16, padding: 20, overflow: 'hidden' },
    lbl:         { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8e8e93', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    val:         { color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, textTransform: 'none', letterSpacing: 0 },
    divider:     { height: 1, background: '#3a3a3c', margin: '18px 0' },
    hint:        { fontSize: 12, color: '#636366', marginTop: 10 },
    segRow:      { display: 'flex', gap: 6, marginTop: 8 },
    segBase:     { flex: 1, padding: '10px 1px', borderRadius: 8, border: '1.5px solid #3a3a3c', background: 'transparent', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', transition: 'all .15s' },
    segActive:   { background: '#e5342a', borderColor: '#e5342a', color: '#fff' },
    durRow:      { display: 'flex', gap: 10, marginTop: 8 },
    durBase:     { flex: 1, padding: 12, borderRadius: 10, border: '1.5px solid #3a3a3c', background: 'transparent', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all .15s' },
    durActive:   { background: '#1a2e1c', borderColor: '#32d74b', color: '#32d74b' },
    sliderWrap:  { marginTop: 10 },
    sliderLabels:{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#636366', marginTop: 6 },
    previewGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginTop: 14 },
    previewLabel:{ color: '#aeaeb2', fontSize: 13 },
    previewTime: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900, color: '#e5342a', whiteSpace: 'nowrap', textAlign: 'right' },
    btnSet:      { width: '100%', padding: 15, background: '#e5342a', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 900, letterSpacing: '0.08em', cursor: 'pointer', marginTop: 4, textTransform: 'uppercase' },
    btnCancel:   { width: '100%', padding: 12, background: 'transparent', color: '#8e8e93', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 10 },
    footer:      { textAlign: 'center', fontSize: 11, color: '#3a3a3c', marginTop: 28 },
  }

  return (
    <div style={css.page}>
      <>
        <button
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          style={{ position: 'fixed', top: 16, right: 16, zIndex: 9990, width: 44, height: 44, borderRadius: 10, border: '1.5px solid #3a3a3c', background: '#2c2c2e', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', padding: 0, boxShadow: '0 2px 12px rgba(0,0,0,.4)' }}
        >
          {[0,1,2].map(i => (
            <span key={i} style={{ display: 'block', width: 18, height: 2, background: '#f2f2f7', borderRadius: 1 }} />
          ))}
        </button>

        <div
          onClick={() => setSettingsOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', zIndex: 9991, opacity: settingsOpen ? 1 : 0, pointerEvents: settingsOpen ? 'auto' : 'none', transition: 'opacity .3s ease' }}
        />

        <div
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(340px, 90vw)', background: '#1c1c1e', borderLeft: '1px solid #3a3a3c', zIndex: 9992, transform: settingsOpen ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .3s cubic-bezier(0.4,0,0.2,1)', display: 'flex', flexDirection: 'column', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 16px', borderBottom: '1px solid #3a3a3c', flexShrink: 0 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#8e8e93' }}>Settings</div>
            <button
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
              style={{ background: 'none', border: 'none', color: '#8e8e93', fontSize: 28, cursor: 'pointer', padding: '0 2px', lineHeight: 1, fontWeight: 300, fontFamily: 'system-ui' }}
            >×</button>
          </div>
          <div style={{ padding: 20, flex: 1 }}>
            <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid #3a3a3c' }}>
              <div style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>Saved Defaults</div>
              <button
                onClick={saveAsDefault}
                style={{ width: '100%', padding: '10px 14px', background: '#1c1c1e', border: '1.5px solid #3a3a3c', borderRadius: 10, color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}
              >
                💾 Save current settings as default
              </button>
              <div style={{ fontSize: 11, color: '#636366', marginTop: 6, lineHeight: 1.5 }}>
                Restores these settings when you clear/reinstall the app.
              </div>
            </div>
            {isIOS && <NtfySetupCard css={css} deviceId={getDeviceId()} />}
            <CardOrderPanel s={s} update={update} />
            <div style={{ borderTop: '1px solid #3a3a3c', paddingTop: 16, marginTop: 16 }}>
              <div style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>ADP Link</div>
              <input
                type="url"
                value={s.adpUrl || ''}
                placeholder="https://workforcenow.adp.com"
                onChange={e => update({ adpUrl: e.target.value })}
                style={{ width: '100%', background: '#1c1c1e', border: '1.5px solid #3a3a3c', borderRadius: 10, padding: '10px 14px', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 11, color: '#636366', marginTop: 6, lineHeight: 1.5 }}>
                Custom URL for the "Open ADP" button in alerts.
              </div>
            </div>
            <DebugPanel deviceId={getDeviceId()} lastSetError={lastSetError} />
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
          <div style={{ color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 28 }}>Clock in/out in ADP now!</div>
          <a
            href={s.adpUrl || 'https://workforcenow.adp.com'}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', marginBottom: 16, padding: '10px 24px', background: '#e5342a', color: '#fff', borderRadius: 10, textDecoration: 'none', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, letterSpacing: '0.06em' }}
          >
            Open ADP ↗
          </a>
          <button onClick={() => setAlert(null)} style={{ padding: '12px 32px', background: 'transparent', color: '#f2f2f7', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>Got it ✓</button>
        </div>
      )}

      <div style={css.inner}>
        <div style={css.headerWrap}>
          <ClockIcon />
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, letterSpacing: '0.1em', color: '#f2f2f7', marginTop: 14, textTransform: 'uppercase' }}>
            <span style={{ color: '#e5342a' }}>CLOCK-BOT</span>
          </div>
          <div style={css.rule} />
          <div style={css.tagline}>Crew Clock Reminder</div>
          {isSet && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderRadius: 20, background: isDirty ? '#2a1e00' : '#0e2a14', border: `1px solid ${isDirty ? '#d97706' : '#32d74b'}` }}>
              <span style={{ fontSize: 10 }}>{isDirty ? '⚠️' : '✓'}</span>
              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: isDirty ? '#d97706' : '#32d74b' }}>
                {isDirty ? 'Update Needed' : 'Armed'}
              </span>
            </div>
          )}
        </div>

        <ResponsiveLayout
          css={css} s={s} update={update}
          timeVal={timeVal} handleTimeChange={handleTimeChange}
          schedule={schedule} isSet={isSet}
          handleSet={handleSet} handleCancel={handleCancel}
          handleCancelClick={handleCancelClick} confirmCancel={confirmCancel}
          isDirty={isDirty} isOvernight={isOvernight}
          showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks}
        />

        <div style={css.footer}>Crew Clock Reminder</div>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1c1c1e; }
        button { outline: none; -webkit-tap-highlight-color: transparent; }
        input[type=time] {
          appearance: none; -webkit-appearance: none;
          background: #1c1c1e; border: 1.5px solid #3a3a3c; border-radius: 10px;
          padding: 13px 14px; color: #f2f2f7; width: 100%; max-width: 100%; min-width: 0;
          display: block; font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 700;
        }
        input[type=time]::-webkit-date-and-time-value { text-align: left; }
        input[type=time]::-webkit-calendar-picker-indicator { filter: invert(1); }
        input[type=range] { -webkit-appearance: none; width: 100%; height: 4px; background: #3a3a3c; border-radius: 2px; outline: none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #e5342a; cursor: pointer; border: 2px solid #1c1c1e; }
        input[type=range]::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; background: #e5342a; cursor: pointer; border: 2px solid #1c1c1e; }
        @keyframes sd        { from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);} }
        @keyframes pop       { 0%,100%{transform:scale(1);}50%{transform:scale(1.08);} }
        @keyframes fadeFlash { 0%{opacity:1;}70%{opacity:1;}100%{opacity:0;} }
        @keyframes dropDown { from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);} }
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
  const idx       = items.indexOf(value)
  const colRef    = useRef(null)
  const onChgRef  = useRef(onChange)
  const idxRef    = useRef(idx)
  onChgRef.current = onChange
  idxRef.current   = idx

  useEffect(() => {
    const el = colRef.current
    let touchStartY = 0
    let touchAccum  = 0

    const onWheel = e => {
      e.preventDefault()
      const next = (idxRef.current + (e.deltaY > 0 ? 1 : -1) + items.length) % items.length
      onChgRef.current(items[next])
    }
    const onTouchStart = e => {
      touchStartY = e.touches[0].clientY
      touchAccum  = 0
    }
    const onTouchMove = e => {
      e.preventDefault()
      const dy = touchStartY - e.touches[0].clientY
      touchAccum  += dy
      touchStartY  = e.touches[0].clientY
      if (Math.abs(touchAccum) >= 28) {
        const next = (idxRef.current + (touchAccum > 0 ? 1 : -1) + items.length) % items.length
        touchAccum = 0
        onChgRef.current(items[next])
      }
    }

    el.addEventListener('wheel',      onWheel,      { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove',  onTouchMove,  { passive: false })
    return () => {
      el.removeEventListener('wheel',      onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove',  onTouchMove)
    }
  }, [items])

  return (
    <div ref={colRef} style={{ width: 64, cursor: 'ns-resize', userSelect: 'none' }}>
      {[-2, -1, 0, 1, 2].map(offset => {
        const i   = (idx + offset + items.length) % items.length
        const sel = offset === 0
        const d   = Math.abs(offset)
        return (
          <div
            key={offset}
            onClick={() => !sel && onChgRef.current(items[i])}
            style={{
              height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize:   sel ? 30 : d === 1 ? 20 : 14,
              fontWeight: sel ? 800 : 400,
              color:      sel ? '#e5342a' : d === 1 ? '#aeaeb2' : '#3a3a3c',
              cursor:     sel ? 'default' : 'pointer',
              fontFamily: "'Barlow Condensed', sans-serif",
              transition: 'font-size .12s, color .12s',
            }}
          >
            {fmt(items[i])}
          </div>
        )
      })}
    </div>
  )
}

function DesktopTimePicker({ startHour, startMin, onHourMin }) {
  const h12  = startHour % 12 === 0 ? 12 : startHour % 12
  const ampm = startHour < 12 ? 'AM' : 'PM'
  const timeVal = `${pad2(startHour)}:${pad2(startMin)}`

  const setH = h => onHourMin((h % 12) + (ampm === 'PM' ? 12 : 0), startMin)
  const setM = m => onHourMin(startHour, m)
  const toggleAMPM = () => onHourMin(startHour < 12 ? startHour + 12 : startHour - 12, startMin)

  return (
    <div>
      <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '6px 0', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Selection highlight band */}
        <div style={{ position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)', height: 44, borderRadius: 10, border: '1.5px solid #e5342a33', background: '#e5342a08', pointerEvents: 'none' }} />
        <WheelCol items={WHEEL_HOURS} value={h12}      onChange={setH} />
        <div style={{ fontSize: 30, fontWeight: 800, color: '#e5342a', padding: '0 2px', lineHeight: 1, userSelect: 'none' }}>:</div>
        <WheelCol items={WHEEL_MINS}  value={startMin} onChange={setM} fmt={v => String(v).padStart(2, '0')} />
        <div style={{ marginLeft: 10, display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 6 }}>
          {['AM', 'PM'].map(ap => (
            <button key={ap} onClick={() => ap !== ampm && toggleAMPM()}
              style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: ap === ampm ? 'default' : 'pointer', background: ap === ampm ? '#e5342a' : 'transparent', color: ap === ampm ? '#fff' : '#636366', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', transition: 'all .15s', outline: 'none' }}>
              {ap}
            </button>
          ))}
        </div>
      </div>
      {/* Typeable input */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="time"
          value={timeVal}
          onChange={e => {
            const [h, m] = e.target.value.split(':').map(Number)
            if (!isNaN(h) && !isNaN(m)) onHourMin(h, m)
          }}
          style={{ flex: 1, appearance: 'none', WebkitAppearance: 'none', background: '#1c1c1e', border: '1.5px solid #3a3a3c', borderRadius: 10, padding: '10px 14px', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, outline: 'none', cursor: 'text', width: '100%' }}
        />
        <span style={{ fontSize: 11, color: '#3a3a3c', whiteSpace: 'nowrap', fontWeight: 600, letterSpacing: '0.06em' }}>or type</span>
      </div>
    </div>
  )
}

function ShiftTimeline({ s, schedule, showLunch, showDinner, unpaidBreaks }) {
  const start    = s.startHour * 60 + s.startMin
  const endOut   = start + s.endHour * 60 + (s.endMin ?? 0) + unpaidBreaks
  const span     = Math.max(endOut - start, 60)

  const pct = mins => {
    let pos = mins - start
    if (pos < 0) pos += 1440
    return Math.min(100, Math.max(0, (pos / span) * 100))
  }

  const dots = schedule.filter(i => ['ciw', 'ci', 'lw', 'lo', 'li', 'dw', 'dout', 'din', 'ew', 'eo', 'ef'].includes(i.id))

  const dotColor = id => {
    if (id === 'ci')  return '#32d74b'
    if (id === 'eo')  return '#e5342a'
    if (id.endsWith('w')) return '#d97706'
    return '#636366'
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ position: 'relative', height: 4, background: '#3a3a3c', borderRadius: 2, margin: '24px 0 8px' }}>
        {/* worked segments: red fill except during break zones */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, background: '#e5342a22', borderRadius: 2 }} />
        {showLunch && (() => {
          const lo = pct(start + h2m(s.lunchHour))
          const li = pct(start + h2m(s.lunchHour) + s.lunchDuration)
          return <div style={{ position: 'absolute', left: `${lo}%`, width: `${li - lo}%`, top: 0, bottom: 0, background: '#1c1c1e', borderLeft: '1px solid #3a3a3c', borderRight: '1px solid #3a3a3c' }} />
        })()}
        {showDinner && s.dinnerEnabled && (() => {
          const dout = pct(start + h2m(s.dinnerHour))
          const din  = pct(start + h2m(s.dinnerHour) + s.dinnerDuration)
          return <div style={{ position: 'absolute', left: `${dout}%`, width: `${din - dout}%`, top: 0, bottom: 0, background: '#1c1c1e', borderLeft: '1px solid #3a3a3c', borderRight: '1px solid #3a3a3c' }} />
        })()}
        {/* Event dots */}
        {dots.map(item => (
          <div key={item.id} style={{ position: 'absolute', left: `${pct(item.fireAt)}%`, top: '50%', transform: 'translate(-50%, -50%)', width: 10, height: 10, borderRadius: '50%', background: dotColor(item.id), border: '2px solid #1c1c1e', zIndex: 1 }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#636366', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.06em' }}>
        <span>{fmtTime(start)}</span>
        <span>{fmtTime(endOut)}</span>
      </div>
    </div>
  )
}

function SchedulePreviewContent({ css, schedule, s, showLunch, showDinner, unpaidBreaks }) {
  const now = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const sorted = [...schedule].sort((a, b) => {
    const ae = a.fireAt < nowMins ? a.fireAt + 1440 : a.fireAt
    const be = b.fireAt < nowMins ? b.fireAt + 1440 : b.fireAt
    return ae - be
  })
  const todayItems = sorted.filter(item => item.fireAt >= nowMins)
  const tmrwItems  = sorted.filter(item => item.fireAt < nowMins)

  const sectionLabel = txt => (
    <div style={{ fontSize: 10, color: '#636366', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{txt}</div>
  )
  const grid = (items, dim) => (
    <div style={{ ...css.previewGrid, opacity: dim ? 0.5 : 1 }}>
      {items.map(item => (
        <React.Fragment key={item.id}>
          <div style={css.previewLabel}>{item.emoji} {item.label}</div>
          <div style={css.previewTime}>{fmtTime(item.fireAt)}</div>
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div>
      <ShiftTimeline s={s} schedule={schedule} showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks} />
      {todayItems.length > 0 && <>{sectionLabel('Today')}{grid(todayItems, false)}</>}
      {tmrwItems.length > 0 && <div style={{ marginTop: todayItems.length > 0 ? 16 : 0 }}>{sectionLabel('Tomorrow')}{grid(tmrwItems, true)}</div>}
    </div>
  )
}

function CollapseCard({ css, title, summary, open, onToggle, className, children }) {
  return (
    <div className={className || ''} style={css.card}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8e8e93' }}>
            {title}
          </div>
          {!open && summary && (
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: '#e5342a', marginTop: 5, letterSpacing: '0.03em', lineHeight: 1.4 }}>
              {summary}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10, color: '#4a4a4e', marginLeft: 10, marginTop: 2, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ marginTop: 14, animation: 'dropDown .26s cubic-bezier(0.16,1,0.3,1)' }}>{children}</div>}
    </div>
  )
}

function ResponsiveLayout({ css, s, update, timeVal, handleTimeChange, schedule, isSet, handleSet, handleCancel, handleCancelClick, confirmCancel, isDirty, isOvernight, showLunch, showDinner, unpaidBreaks }) {
  const openCards = s.openCards || DEFAULT.openCards
  const cardOrder = s.cardOrder || DEFAULT.cardOrder

  function toggleCard(id) {
    update({ openCards: { ...openCards, [id]: !openCards[id] } })
  }

  const endMin   = s.endMin ?? 0
  const endLabel = `${s.endHour}h${endMin ? ` ${String(endMin).padStart(2,'0')}m` : ''}`
  const start    = s.startHour * 60 + s.startMin

  const [nowMins, setNowMins] = useState(() => {
    const n = new Date(); return n.getHours() * 60 + n.getMinutes()
  })
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date(); setNowMins(n.getHours() * 60 + n.getMinutes())
    }, 30000)
    return () => clearInterval(id)
  }, [])

  const nextItem = [...schedule].sort((a, b) => {
    const ae = a.fireAt < nowMins ? a.fireAt + 1440 : a.fireAt
    const be = b.fireAt < nowMins ? b.fireAt + 1440 : b.fireAt
    return ae - be
  })[0]
  const nextTmrw = nextItem && nextItem.fireAt < nowMins

  const cardDefs = {
    schedulePreview: {
      title: '📋 SCHEDULE PREVIEW',
      summary: schedule.length === 0
        ? 'no reminders set'
        : `${schedule.length} reminders · next ${nextItem ? fmtTime(nextItem.fireAt) + (nextTmrw ? ' (tmrw)' : '') : ''}`,
      className: 'card-full',
      visible: true,
      render: () => <SchedulePreviewContent css={css} schedule={schedule} s={s} showLunch={showLunch} showDinner={showDinner} unpaidBreaks={unpaidBreaks} />,
    },
    shiftLength: {
      title: '🏁 SHIFT LENGTH',
      summary: `clock out ${fmtTime(start + s.endHour * 60 + endMin + unpaidBreaks)}  ·  ${endLabel} shift`,
      visible: true,
      render: () => <EndOfShiftCard css={css} s={s} update={update} unpaidBreaks={unpaidBreaks} isOvernight={isOvernight} />,
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
        <ClockInCard css={css} s={s} update={update} timeVal={timeVal} handleTimeChange={handleTimeChange} />
      </CollapseCard>

      {/* Collapsible + reorderable cards */}
      {visibleOrder.map((id, visIdx) => {
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
          >
            {def.render()}
          </CollapseCard>
        )
      })}

      {/* Set Reminders — fixed at bottom */}
      <div className="card-full">
        <button
          style={{ ...css.btnSet, ...(isDirty ? { background: '#d97706' } : {}) }}
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
            <div style={{ marginTop: 12, padding: '12px 16px', background: '#2c2c2e', border: '1px solid #3a3a3c', borderRadius: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: '#636366', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>Next Reminder</div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: '#aeaeb2' }}>
                {nextItem.emoji} {nextItem.label}
              </div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, color: '#e5342a', marginTop: 2 }}>
                in {timeStr}
              </div>
              <div style={{ fontSize: 11, color: '#636366', marginTop: 2 }}>at {fmtTime(nextItem.fireAt)}{nextTmrw ? ' tomorrow' : ''}</div>
            </div>
          )
        })()}
        {notifPermission() === 'denied' && (
          <div style={{ background: '#2a1a1a', border: '1px solid #e5342a', borderRadius: 10, padding: '12px 16px', marginTop: 14, fontSize: 13, color: '#f2f2f7', lineHeight: 1.6 }}>
            &#x26A0;&#xFE0F; Notifications blocked.{' '}
            {isDesktop
              ? 'Click the 🔒 lock icon in your browser\'s address bar → set Notifications to Allow → refresh the page.'
              : 'Go to Settings → this app → Notifications → Allow.'}
          </div>
        )}
        {isDesktop && notifPermission() !== 'denied' && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#636366', textAlign: 'center', lineHeight: 1.6 }}>
            {notifPermission() === 'default' && 'You\'ll be asked to allow notifications when you tap Set Reminders.'}
            {notifPermission() === 'granted' && <>✓ Notifications allowed. <span style={{ color: '#4a4a4e' }}>On Brave, also enable <strong>brave://settings/privacy → Use Google services for push messaging</strong> so reminders fire when the browser is in the background.</span></>}
          </div>
        )}
      </div>
    </div>
  )
}

function CardOrderPanel({ s, update }) {
  const cardNames = {
    schedulePreview: '📋 Schedule Preview',
    shiftLength:     '🏁 Shift Length',
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
    background: '#2c2c2e', border: '1px solid #3a3a3c', borderRadius: 6,
    padding: '6px 11px', fontSize: 12, cursor: active ? 'pointer' : 'default',
    color: active ? '#f2f2f7' : '#3a3a3c',
  })

  return (
    <div style={{ borderTop: '1px solid #3a3a3c', paddingTop: 16, marginTop: 16 }}>
      <div style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Card Order</div>
      {visible.map((id, i) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < visible.length - 1 ? '1px solid #2c2c2e' : 'none' }}>
          <div style={{ fontSize: 13, color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>{cardNames[id]}</div>
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
      <div style={{ fontSize: 13, color: '#aeaeb2', lineHeight: 1.6, marginBottom: 16 }}>
        iPhone requires the free <span style={{ color: '#f2f2f7', fontWeight: 700 }}>ntfy</span> app
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

      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
        2 &nbsp;·&nbsp; Your notification code
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#1c1c1e', border: '1px solid #3a3a3c', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
        <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 14, color: '#32d74b', letterSpacing: '0.04em', wordBreak: 'break-all' }}>{topic}</span>
        <button
          onClick={copyTopic}
          style={{ background: 'none', border: '1px solid #3a3a3c', borderRadius: 6, padding: '5px 12px', color: copied ? '#32d74b' : '#8e8e93', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'color .15s', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>

      <div style={{ fontSize: 13, color: '#636366', lineHeight: 1.6 }}>
        <span style={{ color: '#8e8e93' }}>3 &nbsp;·&nbsp;</span>
        Open ntfy &rarr; tap <span style={{ color: '#aeaeb2', fontWeight: 700 }}>+</span> &rarr; paste code &rarr; <span style={{ color: '#aeaeb2', fontWeight: 700 }}>Subscribe</span>
        <br />
        <span style={{ color: '#8e8e93' }}>4 &nbsp;·&nbsp;</span>
        Come back here and press <span style={{ color: '#aeaeb2', fontWeight: 700 }}>Set Reminders</span>
      </div>
    </div>
  )
}

function DebugPanel({ deviceId, lastSetError }) {
  const [pw, setPw]             = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pwError, setPwError]   = useState(false)
  const [status, setStatus]     = useState(null)
  const [ntfyRes, setNtfyRes]   = useState(null)
  const [pushRes, setPushRes]   = useState(null)
  const [regRes, setRegRes]     = useState(null)
  const [cronLog, setCronLog]   = useState(null)
  const [loading, setLoading]   = useState('')
  const [subInfo, setSubInfo]   = useState(null)

  useEffect(() => {
    if (!unlocked) return
    ;(async () => {
      if (!('serviceWorker' in navigator)) { setSubInfo({ error: 'No service worker support' }); return }
      try {
        const reg = await navigator.serviceWorker.ready
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
    })()
  }, [unlocked])

  function tryUnlock() {
    if (pw === '25896211') { setUnlocked(true); setPwError(false) }
    else setPwError(true)
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
  const box  = { background: '#0a0a0b', border: '1px solid #3a3a3c', borderRadius: 8, padding: '10px 12px', marginTop: 8 }
  const btn  = { background: '#1c1c1e', border: '1px solid #3a3a3c', borderRadius: 8, padding: '10px 14px', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'left', width: '100%' }

  if (!unlocked) {
    return (
      <div style={{ marginTop: 16, borderTop: '1px solid #3a3a3c', paddingTop: 16 }}>
        <div style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10 }}>🔒 Debug</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            value={pw}
            placeholder="Password"
            onChange={e => { setPw(e.target.value); setPwError(false) }}
            onKeyDown={e => e.key === 'Enter' && tryUnlock()}
            style={{ flex: 1, background: '#1c1c1e', border: `1.5px solid ${pwError ? '#e5342a' : '#3a3a3c'}`, borderRadius: 8, padding: '9px 12px', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, outline: 'none' }}
          />
          <button onClick={tryUnlock} style={{ background: '#3a3a3c', border: 'none', borderRadius: 8, padding: '9px 16px', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            Unlock
          </button>
        </div>
        {pwError && <div style={{ fontSize: 11, color: '#e5342a', marginTop: 6 }}>Wrong password</div>}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid #3a3a3c', paddingTop: 16 }}>
      <div style={{ fontSize: 11, color: '#32d74b', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>🔓 Debug</div>
      {lastSetError && (
        <div style={{ background: '#2a1010', border: '1px solid #e5342a', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: '#e5342a', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          ⚠ Last Set Reminders error:{'\n'}{lastSetError}
        </div>
      )}

      {(() => {
        const standalone   = window.navigator.standalone === true
        const permission   = notifPermission()
        const swOk         = 'serviceWorker' in navigator
        const pushOk       = 'PushManager' in window
        const rows = [
          ['Installed PWA',    standalone ? '✅ Yes' : '❌ No — add to home screen',    standalone],
          ['Notifications',    permission === 'granted' ? '✅ Granted' : `❌ ${permission}`, permission === 'granted'],
          ['Service Worker',   swOk ? '✅ Supported' : '❌ Not supported',               swOk],
          ['Push API',         pushOk ? '✅ Supported' : '❌ Not supported',             pushOk],
          ['Push Sub',         subInfo == null ? '⏳ Checking...' : subInfo.exists ? `✅ ${subInfo.endpoint}` : `❌ ${subInfo.subscribeError ?? subInfo.error ?? 'None'}`, subInfo?.exists ?? true],
        ]
        return (
          <div style={{ ...box, marginTop: 0, marginBottom: 14 }}>
            {rows.map(([label, val, ok]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1c1c1e' }}>
                <span style={{ fontSize: 10, color: '#636366', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: ok ? '#32d74b' : '#e5342a' }}>{val}</span>
              </div>
            ))}
          </div>
        )
      })()}

      <div style={{ fontSize: 10, color: '#636366', marginBottom: 3, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Device ID</div>
      <div style={{ ...box, marginTop: 0, marginBottom: 10 }}>
        <pre style={{ ...mono, color: '#8e8e93' }}>{deviceId}</pre>
      </div>

      <div style={{ fontSize: 10, color: '#636366', marginBottom: 3, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>ntfy Topic</div>
      <div style={{ ...box, marginTop: 0, marginBottom: 14 }}>
        <pre style={{ ...mono, color: '#32d74b' }}>{getNtfyTopic(deviceId)}</pre>
      </div>

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

        <button style={btn} disabled={loading === 'log'} onClick={() => hit('/cron-log', setCronLog, 'log')}>
          {loading === 'log' ? '⏳ Loading...' : '📋 Cron Log'}
        </button>
        {cronLog && <div style={box}><pre style={{ ...mono, color: '#aeaeb2' }}>{JSON.stringify(cronLog.slice(0, 5), null, 2)}</pre></div>}
      </div>
    </div>
  )
}

function Toggle({ on, onToggle, label }) {
  return (
    <button
      onClick={onToggle}
      aria-label={label}
      style={{ width: 51, height: 31, borderRadius: 15.5, border: 'none', cursor: 'pointer', background: on ? '#32d74b' : '#3a3a3c', position: 'relative', transition: 'background .25s', flexShrink: 0 }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 27, height: 27, borderRadius: '50%', background: '#fff', transition: 'left .25s' }} />
    </button>
  )
}

function EndOfShiftCard({ css, s, update, unpaidBreaks, isOvernight }) {
  const [wheelOpen, setWheelOpen] = useState(false)
  const [warnFlash, setWarnFlash]   = useState(null)
  const warnTimer                   = useRef(null)
  const endMin   = s.endMin ?? 0
  const endLabel = `${s.endHour}h${endMin ? ` ${String(endMin).padStart(2, '0')}m` : ''}`

  function handleEndWarning(v) {
    update({ endWarning: v })
    clearTimeout(warnTimer.current)
    const endOutMins = s.startHour * 60 + s.startMin + s.endHour * 60 + endMin + (unpaidBreaks ?? 0)
    setWarnFlash({ text: `Notified at ${fmtTime(endOutMins - v)}`, k: Date.now() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  const clockOutTotal = (s.startHour * 60 + s.startMin + s.endHour * 60 + endMin + unpaidBreaks) % 1440
  const clockOutH   = Math.floor(clockOutTotal / 60)
  const clockOutM   = clockOutTotal % 60
  const clockOutVal = `${pad2(clockOutH)}:${pad2(clockOutM)}`

  function handleClockOutChange(e) {
    const [h, m] = e.target.value.split(':').map(Number)
    if (isNaN(h) || isNaN(m)) return
    const startMins = s.startHour * 60 + s.startMin
    let elapsed = h * 60 + m - startMins
    if (elapsed <= 0) elapsed += 1440
    const workedMins = Math.max(0, elapsed - unpaidBreaks)
    update({ endHour: Math.min(24, Math.max(4, Math.floor(workedMins / 60))), endMin: workedMins % 60 })
  }

  return (
    <>
      {/* Duration display box — tap to open wheel */}
      <div
        onClick={() => setWheelOpen(o => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1c1c1e', border: `1.5px solid ${wheelOpen ? '#e5342a' : '#3a3a3c'}`, borderRadius: 10, padding: '13px 14px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700, color: '#f2f2f7', transition: 'border-color .15s', userSelect: 'none' }}
      >
        <span>
          {String(s.endHour).padStart(2, '0')}
          <span style={{ color: '#e5342a', margin: '0 3px' }}>h</span>
          {String(endMin).padStart(2, '0')}
          <span style={{ color: '#e5342a', margin: '0 3px' }}>m</span>
        </span>
        <span style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.1em' }}>
          {wheelOpen ? 'DONE ▲' : 'EDIT ▼'}
        </span>
      </div>

      {/* Collapsible wheel */}
      {wheelOpen && (
        <div style={{ marginTop: 8, background: '#1c1c1e', borderRadius: 14, padding: '6px 0', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'dropDown .26s cubic-bezier(0.16,1,0.3,1)' }}>
          <div style={{ position: 'absolute', left: 12, right: 12, top: '50%', transform: 'translateY(-50%)', height: 44, borderRadius: 10, border: '1.5px solid #e5342a33', background: '#e5342a08', pointerEvents: 'none' }} />
          <WheelCol items={SHIFT_HOURS} value={s.endHour} onChange={h => update({ endHour: h })} />
          <div style={{ fontSize: 22, fontWeight: 800, color: '#e5342a', padding: '0 4px', lineHeight: 1, userSelect: 'none' }}>h</div>
          <WheelCol items={SHIFT_MINS} value={endMin} onChange={m => update({ endMin: m })} fmt={v => String(v).padStart(2, '0')} />
          <div style={{ fontSize: 22, fontWeight: 800, color: '#e5342a', padding: '0 4px', lineHeight: 1, userSelect: 'none' }}>m</div>
        </div>
      )}

      {/* Clock-out time input — always visible, stays in sync with wheel */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>Clock-out time</div>
        <div style={{ overflow: 'hidden' }}>
          <input type="time" value={clockOutVal} onChange={handleClockOutChange} />
        </div>
        <div style={{ fontSize: 11, color: '#636366', marginTop: 6, lineHeight: 1.6 }}>
          <span style={{ color: '#e5342a', fontWeight: 700 }}>{endLabel}</span> worked
          {unpaidBreaks > 0 && (
            <span> + <span style={{ color: '#8e8e93' }}>{unpaidBreaks}m unpaid break</span></span>
          )}
        </div>
        {isOvernight && (
          <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 10, background: '#1a1a2e', border: '1px solid #5a5aff', fontSize: 11, color: '#8888ff', fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.08em' }}>
            🌙 Overnight — clock-out next day
          </div>
        )}
      </div>

      <div style={css.divider} />
      <div style={css.lbl}>
        &#x1F514; HEADS-UP BEFORE SHIFT END
        <span style={css.val}>{s.endWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={2} max={30} step={1} value={s.endWarning}
          onChange={e => handleEndWarning(Number(e.target.value))} />
        <div style={css.sliderLabels}><span>2 min early</span><span>30 min early</span></div>
      </div>
      {warnFlash && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}

      <div style={css.divider} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: '#f2f2f7', fontWeight: 600 }}>End-of-shift reminder</div>
          <div style={{ fontSize: 11, color: '#636366', marginTop: 2 }}>
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
              <div style={{ fontSize: 13, color: '#f2f2f7', fontWeight: 600 }}>❓ 30-min follow-up</div>
              <div style={{ fontSize: 11, color: '#636366', marginTop: 2 }}>
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
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1c1c1e', border: `1.5px solid ${open ? '#e5342a' : '#3a3a3c'}`, borderRadius: 10, padding: '11px 14px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 700, color: '#f2f2f7', transition: 'border-color .15s', userSelect: 'none' }}
      >
        <span>{value} min</span>
        <span style={{ fontSize: 11, color: '#636366', fontWeight: 700, letterSpacing: '0.1em' }}>
          {open ? 'DONE ▲' : 'EDIT ▼'}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 4, background: '#1c1c1e', border: '1.5px solid #e5342a', borderRadius: 10, overflow: 'hidden', animation: 'dropDown .26s cubic-bezier(0.16,1,0.3,1)' }}>
          {DUR_OPTS.map((o, i) => (
            <div
              key={o.v}
              onClick={() => { onChange(o.v); setOpen(false); navigator.vibrate?.(10) }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, color: o.v === value ? '#e5342a' : '#f2f2f7', background: o.v === value ? '#e5342a0f' : 'transparent', borderBottom: i < DUR_OPTS.length - 1 ? '1px solid #2c2c2e' : 'none' }}
            >
              <span>{o.l}</span>
              {o.v === value && <span style={{ fontSize: 13 }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ClockInCard({ css, s, update, timeVal, handleTimeChange }) {
  const [warnFlash, setWarnFlash] = useState(null)
  const warnTimer  = useRef(null)
  const start      = s.startHour * 60 + s.startMin

  function handleStartWarning(v) {
    update({ startWarning: v })
    clearTimeout(warnTimer.current)
    setWarnFlash({ text: `Notified at ${fmtTime(start - v)}`, k: Date.now() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  async function sendTestNotif() {
    if (!notifSupported) return
    if (notifPermission() === 'default') await Notification.requestPermission()
    if (notifPermission() === 'granted') {
      new Notification('🧪 Clock-Bot Test', { body: 'Notifications are working!', icon: '/qwik-crew-clock/icon-192.png' })
    }
  }

  return (
    <>
      {isDesktop ? (
        <DesktopTimePicker
          startHour={s.startHour}
          startMin={s.startMin}
          onHourMin={(h, m) => update({ startHour: h, startMin: m })}
        />
      ) : (
        <div style={{ overflow: 'hidden' }}>
          <input type="time" value={timeVal} onChange={handleTimeChange} />
        </div>
      )}
      <div style={css.hint}>&#x1F4A1; Set this the night before if you know your start time</div>
      <div style={css.divider} />
      <div style={css.lbl}>
        &#x1F514; HEADS-UP BEFORE CLOCK-IN
        <span style={css.val}>{s.startWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={2} max={15} step={1} value={s.startWarning}
          onChange={e => handleStartWarning(Number(e.target.value))} />
        <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
      </div>
      {warnFlash && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <button
        onClick={sendTestNotif}
        style={{ width: '100%', padding: '10px 14px', background: 'transparent', color: '#636366', border: '1.5px solid #3a3a3c', borderRadius: 10, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.06em' }}
      >
        🧪 Send Test Notification
      </button>
    </>
  )
}

function LunchCard({ css, s, update }) {
  const lunchLabel = LUNCH_OPTS.find(o => o.v === s.lunchHour)?.l ?? `${s.lunchHour}h`
  const [lunchFlash, setLunchFlash] = useState(null)
  const lunchFlashTimer = useRef(null)
  const [warnFlash, setWarnFlash]   = useState(null)
  const warnTimer                   = useRef(null)

  function handleLunchWarning(v) {
    update({ lunchWarning: v })
    clearTimeout(warnTimer.current)
    const lunchOutMins = s.startHour * 60 + s.startMin + h2m(s.lunchHour)
    setWarnFlash({ text: `Notified at ${fmtTime(lunchOutMins - v)}`, k: Date.now() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  function pickLunchHour(v) {
    update({ lunchHour: v })
    const t = fmtTime(s.startHour * 60 + s.startMin + h2m(v))
    clearTimeout(lunchFlashTimer.current)
    setLunchFlash({ text: `Clock out at ${t}`, k: Date.now() })
    lunchFlashTimer.current = setTimeout(() => setLunchFlash(null), 2500)
  }

  return (
    <>
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
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
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>&#x23F1; Lunch Duration</div>
      <DurDropdown value={s.lunchDuration} onChange={v => update({ lunchDuration: v })} />
      <div style={css.divider} />
      <div style={css.lbl}>
        &#x1F514; HEADS-UP BEFORE LUNCH
        <span style={css.val}>{s.lunchWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={2} max={15} step={1} value={s.lunchWarning}
          onChange={e => handleLunchWarning(Number(e.target.value))} />
        <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
      </div>
      {warnFlash && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
    </>
  )
}

function DinnerCard({ css, s, update }) {
  const dinnerLabel = DINNER_OPTS.find(o => o.v === s.dinnerHour)?.l ?? `${s.dinnerHour}h`
  const [dinnerFlash, setDinnerFlash] = useState(null)
  const dinnerFlashTimer = useRef(null)
  const [warnFlash, setWarnFlash]   = useState(null)
  const warnTimer                   = useRef(null)

  function handleDinnerWarning(v) {
    update({ dinnerWarning: v })
    clearTimeout(warnTimer.current)
    const dinnerOutMins = s.startHour * 60 + s.startMin + h2m(s.dinnerHour)
    setWarnFlash({ text: `Notified at ${fmtTime(dinnerOutMins - v)}`, k: Date.now() })
    warnTimer.current = setTimeout(() => setWarnFlash(null), 2500)
    navigator.vibrate?.(10)
  }

  function pickDinnerHour(v) {
    update({ dinnerHour: v })
    const t = fmtTime(s.startHour * 60 + s.startMin + h2m(v))
    clearTimeout(dinnerFlashTimer.current)
    setDinnerFlash({ text: `Clock out at ${t}`, k: Date.now() })
    dinnerFlashTimer.current = setTimeout(() => setDinnerFlash(null), 2500)
  }

  return (
    <>
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
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
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>&#x23F1; Dinner Duration</div>
      <DurDropdown value={s.dinnerDuration} onChange={v => update({ dinnerDuration: v })} />
      <div style={css.divider} />
      <div style={css.lbl}>
        &#x1F514; HEADS-UP BEFORE DINNER
        <span style={css.val}>{s.dinnerWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={2} max={15} step={1} value={s.dinnerWarning}
          onChange={e => handleDinnerWarning(Number(e.target.value))} />
        <div style={css.sliderLabels}><span>2 min early</span><span>15 min early</span></div>
      </div>
      {warnFlash && (
        <div key={warnFlash.k} style={{ textAlign: 'center', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: '#e5342a', marginTop: 6, animation: 'fadeFlash 2.5s ease forwards' }}>
          {warnFlash.text}
        </div>
      )}
      <div style={css.divider} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: '#f2f2f7', fontWeight: 600 }}>Dinner reminders</div>
          <div style={{ fontSize: 11, color: '#636366', marginTop: 2 }}>
            {s.dinnerEnabled ? 'On — working a long day' : 'Off — no dinner break today'}
          </div>
        </div>
        <Toggle on={s.dinnerEnabled} onToggle={() => update({ dinnerEnabled: !s.dinnerEnabled })} label="Toggle dinner reminders" />
      </div>
    </>
  )
}
