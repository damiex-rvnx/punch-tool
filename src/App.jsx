import React, { useState, useEffect, useRef, useCallback } from 'react'

// ─── ONESIGNAL + CLOUDFLARE WORKER ───────────────────────────────────────────
const ONESIGNAL_APP_ID = 'a075be77-5334-4e47-b8a4-ff6de2836198'
// Fill this in after deploying the Cloudflare Worker
const WORKER_URL = 'https://qr-clock-bot.lbrito1126.workers.dev'

function ClockIcon({ size = 96 }) {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      {/* Diamond shell */}
      <rect x="24" y="24" width="72" height="72" rx="14"
            transform="rotate(45 60 60)"
            fill="#2c2c2e" stroke="#e5342a" strokeWidth="3"/>
      {/* Clock ring */}
      <circle cx="60" cy="60" r="27" fill="none" stroke="#3a3a3c" strokeWidth="1.5"/>
      {/* Tick marks */}
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
      {/* Hour hand → 7 o'clock */}
      <line x1="60" y1="60" x2="51" y2="73"
            stroke="#f2f2f7" strokeWidth="3.5" strokeLinecap="round"/>
      {/* Minute hand → 12 */}
      <line x1="60" y1="60" x2="60" y2="37"
            stroke="#e5342a" strokeWidth="2.5" strokeLinecap="round"/>
      {/* Center dot */}
      <circle cx="60" cy="60" r="3" fill="#e5342a"/>
    </svg>
  )
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'qwik_crew_v11'

const DEFAULT = {
  startHour: 7,
  startMin: 0,
  lunchHour: 5.00,
  lunchWarning: 5,
  lunchDuration: 30,
  dinnerHour: 10.00,
  dinnerWarning: 5,
  dinnerDuration: 30,
  dinnerEnabled: true,
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

const DUR_OPTS = [
  { l: '30 min', v: 30 },
  { l: '45 min', v: 45 },
  { l: '60 min', v: 60 },
]

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

const notifSupported = typeof Notification !== 'undefined'
const notifPermission = () => notifSupported ? Notification.permission : 'unsupported'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT }
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [s, setS] = useState(loadState)
  const [isSet, setIsSet] = useState(false)
  const [toast, setToast] = useState(null)
  const [alert, setAlert] = useState(null)
  const [debug, setDebug] = useState({ sdk: '?', perm: '?', subId: '?', worker: '?' })
  const timerIds = useRef([])
  const toastTimer = useRef(null)
  const swReg = useRef(null)

  // Refresh OneSignal state every second so debug box always shows current state
  useEffect(() => {
    const tick = () => {
      setDebug(d => ({
        ...d,
        sdk:  window.OneSignal ? 'loaded' : 'NOT LOADED',
        perm: window.OneSignal?.Notifications?.permission ? 'granted' : (notifPermission() || 'unknown'),
        subId: window.OneSignal?.User?.PushSubscription?.id || 'null',
      }))
    }
    tick()
    const i = setInterval(tick, 1000)
    return () => clearInterval(i)
  }, [])

  // Register service worker and init OneSignal on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/qwik-crew-clock/OneSignalSDKWorker.js', { scope: '/qwik-crew-clock/' })
        .then(reg => { swReg.current = reg })
        .catch(() => {})
    }

    if (ONESIGNAL_APP_ID !== 'YOUR_ONESIGNAL_APP_ID') {
      window.OneSignalDeferred = window.OneSignalDeferred || []
      window.OneSignalDeferred.push(async OneSignal => {
        await OneSignal.init({
          appId: ONESIGNAL_APP_ID,
          serviceWorkerPath: '/qwik-crew-clock/OneSignalSDKWorker.js',
          serviceWorkerParam: { scope: '/qwik-crew-clock/' },
          notifyButton: { enable: false },
        })
        // Permission is requested on user gesture in handleSet, not here
      })
    }
  }, [])

  // Persist on every state change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  }, [s])

  const update = useCallback((patch) => setS(prev => ({ ...prev, ...patch })), [])

  // ─── Schedule calc ──────────────────────────────────────────────────────────
  const schedule = (() => {
    const start    = s.startHour * 60 + s.startMin
    const lunchOut = start + h2m(s.lunchHour)
    const lunchIn  = lunchOut + s.lunchDuration
    const dinnerOut = start + h2m(s.dinnerHour)
    const dinnerIn  = dinnerOut + s.dinnerDuration
    return [
      { id: 'ci',   emoji: '⏰', label: 'Clock In',                                          fireAt: start },
      { id: 'lw',   emoji: '🔔', label: `Lunch in ${s.lunchWarning} min — heads up!`,        fireAt: lunchOut - s.lunchWarning },
      { id: 'lo',   emoji: '🍽️', label: 'Clock Out — Lunch Break',                            fireAt: lunchOut },
      { id: 'li',   emoji: '✅', label: `Clock Back In — Lunch (${s.lunchDuration} min)`,    fireAt: lunchIn },
      ...(s.dinnerEnabled ? [
        { id: 'dw',   emoji: '🔔', label: `Dinner in ${s.dinnerWarning} min — heads up!`,       fireAt: dinnerOut - s.dinnerWarning },
        { id: 'dout', emoji: '🌙', label: 'Clock Out — Dinner Break',                           fireAt: dinnerOut },
        { id: 'din',  emoji: '🔁', label: `Clock Back In — Dinner (${s.dinnerDuration} min)`,  fireAt: dinnerIn },
      ] : []),
    ]
  })()

  // ─── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, color) {
    clearTimeout(toastTimer.current)
    setToast({ msg, color })
    toastTimer.current = setTimeout(() => setToast(null), 3800)
  }

  // ─── Cancel via Cloudflare Worker ───────────────────────────────────────────
  async function cancelWorkerNotifs() {
    if (WORKER_URL === 'YOUR_CLOUDFLARE_WORKER_URL') return
    const ids = JSON.parse(localStorage.getItem('qr_notif_ids') || '[]')
    if (!ids.length) return
    try {
      await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', notifIds: ids }),
      })
    } catch {}
    localStorage.removeItem('qr_notif_ids')
  }

  // ─── Clear timers ───────────────────────────────────────────────────────────
  function clearTimers() {
    timerIds.current.forEach(id => clearTimeout(id))
    timerIds.current = []
    swReg.current?.active?.postMessage({ type: 'QR_CANCEL' })
    cancelWorkerNotifs()
  }

  // ─── Set reminders ──────────────────────────────────────────────────────────
  async function handleSet() {
    if (window.OneSignal) {
      try {
        if (!window.OneSignal.Notifications.permission) {
          await window.OneSignal.Notifications.requestPermission()
        }
        // Poll up to 8 seconds for OneSignal to assign a subscription ID
        for (let i = 0; i < 16; i++) {
          if (window.OneSignal.User?.PushSubscription?.id) break
          await new Promise(r => setTimeout(r, 500))
        }
        const sid = window.OneSignal.User?.PushSubscription?.id
        if (!sid) showToast('OneSignal not ready — try again', '#d97706')
      } catch {}
    } else if (notifSupported && notifPermission() === 'default') {
      await Notification.requestPermission()
    }

    clearTimers()

    const now = new Date()
    const nowMins = now.getHours() * 60 + now.getMinutes()

    const swItems = []
    const workerItems = []

    schedule.forEach(item => {
      let ms = (item.fireAt - nowMins) * 60000 - now.getSeconds() * 1000
      if (ms < 0) ms += 86400000

      // Main-thread timer — fires in-app alert overlay when app is open
      timerIds.current.push(setTimeout(() => {
        setAlert({ emoji: item.emoji, label: item.label })
      }, ms))

      // SW timer — fires background notification (reliable on Android)
      swItems.push({ id: item.id, ms, label: item.label, emoji: item.emoji })

      // Cloudflare Worker item — fires via OneSignal even when iOS is closed
      workerItems.push({
        id: item.id,
        fireAtISO: new Date(Date.now() + ms).toISOString(),
        label: item.label,
        emoji: item.emoji,
      })
    })

    // ── Cloudflare Worker → OneSignal (iOS background push) ──────────────────
    if (WORKER_URL !== 'YOUR_CLOUDFLARE_WORKER_URL') {
      const playerId = window.OneSignal?.User?.PushSubscription?.id
      if (playerId) {
        fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'schedule', playerId, items: workerItems }),
        })
          .then(r => r.json())
          .then(d => {
            setDebug(prev => ({ ...prev, worker: JSON.stringify(d).slice(0, 200) }))
            if (d.ids?.length) localStorage.setItem('qr_notif_ids', JSON.stringify(d.ids))
          })
          .catch(e => setDebug(prev => ({ ...prev, worker: `ERR: ${e.message}` })))
      } else {
        setDebug(prev => ({ ...prev, worker: 'SKIPPED: no subscription ID' }))
      }
    }

    // ── Service Worker (Android background / fallback) ────────────────────────
    const sw = swReg.current
    if (sw?.active) {
      sw.active.postMessage({ type: 'QR_SCHEDULE', items: swItems })
    } else if (sw) {
      navigator.serviceWorker.ready.then(reg => {
        reg.active?.postMessage({ type: 'QR_SCHEDULE', items: swItems })
      })
    }

    setIsSet(true)

    if (notifPermission() === 'granted') {
      showToast('Reminders set ✓', '#15803d')
    } else if (notifPermission() === 'denied') {
      showToast('Notifications blocked — enable in browser settings', '#d97706')
    } else {
      showToast('Saved — enable notifications to get alerts', '#d97706')
    }
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────────
  function handleCancel() {
    clearTimers()
    setIsSet(false)
    showToast('Reminders cancelled', '#374151')
  }

  // ─── Time input ─────────────────────────────────────────────────────────────
  const timeVal = `${pad2(s.startHour)}:${pad2(s.startMin)}`
  function handleTimeChange(e) {
    const [h, m] = e.target.value.split(':').map(Number)
    if (!isNaN(h) && !isNaN(m)) update({ startHour: h, startMin: m })
  }

  // ─── Styles ──────────────────────────────────────────────────────────────────
  const css = {
    page: { background: '#1c1c1e', minHeight: '100vh', overflowX: 'hidden', padding: '28px 0 40px', fontFamily: "'Barlow', sans-serif", color: '#f2f2f7' },
    inner: { maxWidth: 920, margin: '0 auto', padding: '0 16px' },
    headerWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 },
    rule: { width: 40, height: 2, background: '#e5342a', borderRadius: 2, marginTop: 20 },
    tagline: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#636366', marginTop: 8 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 },
    card: { background: '#2c2c2e', border: '1px solid #3a3a3c', borderRadius: 16, padding: 20, overflow: 'hidden' },
    lbl: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8e8e93', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    val: { color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, textTransform: 'none', letterSpacing: 0 },
    divider: { height: 1, background: '#3a3a3c', margin: '18px 0' },
    hint: { fontSize: 12, color: '#636366', marginTop: 10 },
    segRow: { display: 'flex', gap: 6, marginTop: 8 },
    segBase: { flex: 1, padding: '10px 1px', borderRadius: 8, border: '1.5px solid #3a3a3c', background: 'transparent', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', transition: 'all .15s' },
    segActive: { background: '#e5342a', borderColor: '#e5342a', color: '#fff' },
    durRow: { display: 'flex', gap: 10, marginTop: 8 },
    durBase: { flex: 1, padding: 12, borderRadius: 10, border: '1.5px solid #3a3a3c', background: 'transparent', color: '#f2f2f7', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all .15s' },
    durActive: { background: '#1a2e1c', borderColor: '#32d74b', color: '#32d74b' },
    sliderWrap: { marginTop: 10 },
    sliderLabels: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#636366', marginTop: 6 },
    previewGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginTop: 14 },
    previewLabel: { color: '#aeaeb2', fontSize: 13 },
    previewTime: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 900, color: '#e5342a', whiteSpace: 'nowrap', textAlign: 'right' },
    btnSet: { width: '100%', padding: 15, background: '#e5342a', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 19, fontWeight: 900, letterSpacing: '0.08em', cursor: 'pointer', marginTop: 4, textTransform: 'uppercase' },
    btnCancel: { width: '100%', padding: 12, background: 'transparent', color: '#8e8e93', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 10 },
    deniedBox: { background: '#2a1a1a', border: '1px solid #e5342a', borderRadius: 10, padding: '12px 16px', marginTop: 14, fontSize: 13, color: '#f2f2f7' },
    footer: { textAlign: 'center', fontSize: 11, color: '#3a3a3c', marginTop: 28 },
  }


  return (
    <div style={css.page}>
      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', background: toast.color, color: '#fff', padding: '10px 22px', borderRadius: 10, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, zIndex: 9999, animation: 'sd .25s ease', whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,.5)' }}>
          {toast.msg}
        </div>
      )}

      {/* Full-screen alert */}
      {alert && (
        <div style={{ position: 'fixed', inset: 0, background: '#1c1c1ef5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 9998, padding: 24 }}>
          <div style={{ fontSize: 72, animation: 'pop 1s ease infinite', marginBottom: 20 }}>{alert.emoji}</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 700, textAlign: 'center', maxWidth: 380, marginBottom: 12 }}>{alert.label}</div>
          <div style={{ color: '#e5342a', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 28 }}>Clock in/out in ADP now!</div>
          <button onClick={() => setAlert(null)} style={{ padding: '12px 32px', background: 'transparent', color: '#f2f2f7', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>Got it ✓</button>
        </div>
      )}

      <div style={css.inner}>
        {/* Header */}
        <div style={css.headerWrap}>
          <ClockIcon />
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, letterSpacing: '0.1em', color: '#f2f2f7', marginTop: 14, textTransform: 'uppercase' }}>
            QR <span style={{ color: '#e5342a' }}>CLOCK-BOT</span>
          </div>
          <div style={css.rule} />
          <div style={css.tagline}>Crew Clock Reminder</div>
        </div>

        {/* Responsive grid */}
        <ResponsiveLayout
          css={css}
          s={s}
          update={update}
          timeVal={timeVal}
          handleTimeChange={handleTimeChange}
          schedule={schedule}
          isSet={isSet}
          handleSet={handleSet}
          handleCancel={handleCancel}
        />

        <div style={{ background: '#000', border: '1px solid #e5342a', borderRadius: 8, padding: 10, marginTop: 20, fontFamily: 'monospace', fontSize: 11, color: '#32d74b', wordBreak: 'break-all' }}>
          <div style={{ color: '#e5342a', fontWeight: 700, marginBottom: 6 }}>DEBUG</div>
          <div>SDK: {debug.sdk}</div>
          <div>perm: {debug.perm}</div>
          <div>subId: {debug.subId}</div>
          <div>worker: {debug.worker}</div>
        </div>

        <div style={css.footer}>QwikResponse Restoration &amp; Construction</div>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1c1c1e; }
        input[type=time] {
          appearance: none;
          -webkit-appearance: none;
          background: #1c1c1e;
          border: 1.5px solid #3a3a3c;
          border-radius: 10px;
          padding: 13px 14px;
          color: #f2f2f7;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          display: block;
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 22px;
          font-weight: 700;
        }
        input[type=time]::-webkit-date-and-time-value { text-align: left; }
        input[type=time]::-webkit-calendar-picker-indicator { filter: invert(1); }
        input[type=range] {
          -webkit-appearance: none;
          width: 100%;
          height: 4px;
          background: #3a3a3c;
          border-radius: 2px;
          outline: none;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #e5342a;
          cursor: pointer;
          border: 2px solid #1c1c1e;
        }
        input[type=range]::-moz-range-thumb {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #e5342a;
          cursor: pointer;
          border: 2px solid #1c1c1e;
        }
        @keyframes sd  { from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);} }
        @keyframes pop { 0%,100%{transform:scale(1);}50%{transform:scale(1.08);} }

        @media (min-width: 800px) {
          .responsive-grid {
            display: grid !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 16px !important;
          }
          .card-full { grid-column: 1 / -1 !important; }
        }
      `}</style>
    </div>
  )
}

// ─── RESPONSIVE LAYOUT ────────────────────────────────────────────────────────
function ResponsiveLayout({ css, s, update, timeVal, handleTimeChange, schedule, isSet, handleSet, handleCancel }) {
  return (
    <div className="responsive-grid" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Card 1: Start Time — full width */}
      <div className="card-full" style={css.card}>
        <div style={css.lbl}>⏰ YOUR START TIME</div>
        <div style={{ overflow: 'hidden' }}>
          <input type="time" value={timeVal} onChange={handleTimeChange} />
        </div>
        <div style={css.hint}>💡 Set this the night before if you know your start time</div>
      </div>

      {/* Card 2: Lunch */}
      <div style={css.card}>
        <LunchCard css={css} s={s} update={update} />
      </div>

      {/* Card 3: Dinner */}
      <div style={css.card}>
        <DinnerCard css={css} s={s} update={update} />
      </div>

      {/* Card 4: Schedule Preview — full width */}
      <div className="card-full" style={css.card}>
        <div style={css.lbl}>📋 TODAY'S SCHEDULE PREVIEW</div>
        <div style={css.previewGrid}>
          {schedule.map(item => (
            <React.Fragment key={item.id}>
              <div style={css.previewLabel}>{item.emoji} {item.label}</div>
              <div style={css.previewTime}>{fmtTime(item.fireAt)}</div>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Buttons — full width */}
      <div className="card-full">
        <button style={css.btnSet} onClick={handleSet}>
          {isSet ? '✓ UPDATE REMINDERS' : 'SET REMINDERS'}
        </button>
        {isSet && (
          <button style={css.btnCancel} onClick={handleCancel}>Cancel Reminders</button>
        )}
        {notifPermission() === 'denied' && (
          <div style={{ background: '#2a1a1a', border: '1px solid #e5342a', borderRadius: 10, padding: '12px 16px', marginTop: 14, fontSize: 13, color: '#f2f2f7' }}>
            ⚠️ Notifications are blocked. To enable: open browser settings → Site Settings → Notifications → allow this site.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── LUNCH CARD ───────────────────────────────────────────────────────────────
function LunchCard({ css, s, update }) {
  const lunchLabel = LUNCH_OPTS.find(o => o.v === s.lunchHour)?.l ?? `${s.lunchHour}h`
  return (
    <>
      <div style={css.lbl}>
        🍽️ LUNCH BREAK
        <span style={css.val}>{lunchLabel} mark</span>
      </div>
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
      <div style={css.segRow}>
        {LUNCH_OPTS.map(o => (
          <button key={o.v} style={{ ...css.segBase, ...(s.lunchHour === o.v ? css.segActive : {}) }} onClick={() => update({ lunchHour: o.v })}>
            {o.l}
          </button>
        ))}
      </div>

      <div style={css.divider} />

      <div style={css.lbl}>
        ⏱ LUNCH DURATION
        <span style={css.val}>{s.lunchDuration} min</span>
      </div>
      <div style={css.durRow}>
        {DUR_OPTS.map(o => (
          <button key={o.v} style={{ ...css.durBase, ...(s.lunchDuration === o.v ? css.durActive : {}) }} onClick={() => update({ lunchDuration: o.v })}>
            {o.l}
          </button>
        ))}
      </div>

      <div style={css.divider} />

      <div style={css.lbl}>
        🔔 HEADS-UP BEFORE LUNCH
        <span style={css.val}>{s.lunchWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input
          type="range"
          min={1} max={15} step={1}
          value={s.lunchWarning}
          onChange={e => update({ lunchWarning: Number(e.target.value) })}
        />
        <div style={css.sliderLabels}>
          <span>1 min early</span>
          <span>15 min early</span>
        </div>
      </div>
    </>
  )
}

// ─── DINNER CARD ─────────────────────────────────────────────────────────────
function DinnerCard({ css, s, update }) {
  const dinnerLabel = DINNER_OPTS.find(o => o.v === s.dinnerHour)?.l ?? `${s.dinnerHour}h`
  return (
    <>
      <div style={css.lbl}>
        🌙 DINNER / LONG DAY BREAK
        <span style={css.val}>{dinnerLabel} mark</span>
      </div>
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Clock Out at Hour Mark:</div>
      <div style={css.segRow}>
        {DINNER_OPTS.map(o => (
          <button key={o.v} style={{ ...css.segBase, ...(s.dinnerHour === o.v ? css.segActive : {}) }} onClick={() => update({ dinnerHour: o.v })}>
            {o.l}
          </button>
        ))}
      </div>

      <div style={css.divider} />

      <div style={css.lbl}>
        ⏱ DINNER DURATION
        <span style={css.val}>{s.dinnerDuration} min</span>
      </div>
      <div style={css.durRow}>
        {DUR_OPTS.map(o => (
          <button key={o.v} style={{ ...css.durBase, ...(s.dinnerDuration === o.v ? css.durActive : {}) }} onClick={() => update({ dinnerDuration: o.v })}>
            {o.l}
          </button>
        ))}
      </div>

      <div style={css.divider} />

      <div style={css.lbl}>
        🔔 HEADS-UP BEFORE DINNER
        <span style={css.val}>{s.dinnerWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input
          type="range"
          min={1} max={15} step={1}
          value={s.dinnerWarning}
          onChange={e => update({ dinnerWarning: Number(e.target.value) })}
        />
        <div style={css.sliderLabels}>
          <span>1 min early</span>
          <span>15 min early</span>
        </div>
      </div>

      <div style={css.divider} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: '#f2f2f7', fontWeight: 600 }}>Dinner reminders</div>
          <div style={{ fontSize: 11, color: '#636366', marginTop: 2 }}>
            {s.dinnerEnabled ? 'On — working a long day' : 'Off — no dinner break today'}
          </div>
        </div>
        <button
          onClick={() => update({ dinnerEnabled: !s.dinnerEnabled })}
          style={{
            width: 51, height: 31, borderRadius: 15.5, border: 'none', cursor: 'pointer',
            background: s.dinnerEnabled ? '#32d74b' : '#3a3a3c',
            position: 'relative', transition: 'background .25s', flexShrink: 0,
          }}
          aria-label="Toggle dinner reminders"
        >
          <span style={{
            position: 'absolute', top: 2,
            left: s.dinnerEnabled ? 22 : 2,
            width: 27, height: 27, borderRadius: '50%',
            background: '#fff', transition: 'left .25s',
          }} />
        </button>
      </div>
    </>
  )
}
