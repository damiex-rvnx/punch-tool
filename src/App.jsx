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

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

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
  return { ...DEFAULT }
}

export default function App() {
  const [s, setS]           = useState(loadState)
  const [isSet, setIsSet]   = useState(false)
  const [toast, setToast]   = useState(null)
  const [alert, setAlert]   = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  const update = useCallback(patch => setS(prev => ({ ...prev, ...patch })), [])

  const schedule = (() => {
    const start     = s.startHour * 60 + s.startMin
    const lunchOut  = start + h2m(s.lunchHour)
    const lunchIn   = lunchOut + s.lunchDuration
    const dinnerOut = start + h2m(s.dinnerHour)
    const dinnerIn  = dinnerOut + s.dinnerDuration
    return [
      { id: 'ci',   emoji: '⏰', label: 'Clock In',                                        fireAt: start },
      { id: 'lw',   emoji: '🔔', label: `Lunch in ${s.lunchWarning} min — heads up!`,      fireAt: lunchOut - s.lunchWarning },
      { id: 'lo',   emoji: '🍽️', label: 'Clock Out — Lunch Break',                          fireAt: lunchOut },
      { id: 'li',   emoji: '✅', label: `Clock Back In — Lunch (${s.lunchDuration} min)`,  fireAt: lunchIn },
      ...(s.dinnerEnabled ? [
        { id: 'dw',   emoji: '🔔', label: `Dinner in ${s.dinnerWarning} min — heads up!`,     fireAt: dinnerOut - s.dinnerWarning },
        { id: 'dout', emoji: '🌙', label: 'Clock Out — Dinner Break',                         fireAt: dinnerOut },
        { id: 'din',  emoji: '🔁', label: `Clock Back In — Dinner (${s.dinnerDuration} min)`, fireAt: dinnerIn },
      ] : []),
    ]
  })()

  function showToast(msg, color) {
    clearTimeout(toastTimer.current)
    setToast({ msg, color })
    toastTimer.current = setTimeout(() => setToast(null), 3800)
  }

  async function subscribePush() {
    const reg = swReg.current || await navigator.serviceWorker.ready
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
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      try {
        sub = await subscribePush()
      } catch {
        showToast('Could not enable push — reminders set for this session only', '#d97706')
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
      workerItems.push({ id: item.id, fireAtISO: new Date(Date.now() + ms).toISOString(), label: item.label, emoji: item.emoji })
    })

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
        if (!res.ok) showToast('Server sync failed — try again', '#d97706')
      } catch {
        showToast('Could not reach server — check connection', '#d97706')
      }
    }

    const sw = swReg.current
    if (sw?.active) {
      sw.active.postMessage({ type: 'QR_SCHEDULE', items: swItems })
    } else if (sw) {
      navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({ type: 'QR_SCHEDULE', items: swItems }))
    }

    setIsSet(true)
    showToast('Reminders set ✓', '#15803d')
  }

  function handleCancel() {
    clearTimers()
    setIsSet(false)
    showToast('Reminders cancelled', '#374151')
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
      {isIOS && (
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
              <NtfySetupCard css={css} deviceId={getDeviceId()} />
              <DebugPanel deviceId={getDeviceId()} />
            </div>
          </div>
        </>
      )}

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
          <button onClick={() => setAlert(null)} style={{ padding: '12px 32px', background: 'transparent', color: '#f2f2f7', border: '1.5px solid #3a3a3c', borderRadius: 12, fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>Got it ✓</button>
        </div>
      )}

      <div style={css.inner}>
        <div style={css.headerWrap}>
          <ClockIcon />
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, letterSpacing: '0.1em', color: '#f2f2f7', marginTop: 14, textTransform: 'uppercase' }}>
            QR <span style={{ color: '#e5342a' }}>CLOCK-BOT</span>
          </div>
          <div style={css.rule} />
          <div style={css.tagline}>Crew Clock Reminder</div>
        </div>

        <ResponsiveLayout
          css={css} s={s} update={update}
          timeVal={timeVal} handleTimeChange={handleTimeChange}
          schedule={schedule} isSet={isSet}
          handleSet={handleSet} handleCancel={handleCancel}
        />

        <div style={css.footer}>QwikResponse Restoration &amp; Construction</div>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1c1c1e; }
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
        @keyframes sd  { from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);} }
        @keyframes pop { 0%,100%{transform:scale(1);}50%{transform:scale(1.08);} }
        @supports (backdrop-filter: blur(1px)) { .settings-backdrop { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); } }
        @media (min-width: 800px) {
          .responsive-grid { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 16px !important; }
          .card-full { grid-column: 1 / -1 !important; }
        }
      `}</style>
    </div>
  )
}

function ResponsiveLayout({ css, s, update, timeVal, handleTimeChange, schedule, isSet, handleSet, handleCancel }) {
  return (
    <div className="responsive-grid" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card-full" style={css.card}>
        <div style={css.lbl}>&#x23F0; YOUR START TIME</div>
        <div style={{ overflow: 'hidden' }}>
          <input type="time" value={timeVal} onChange={handleTimeChange} />
        </div>
        <div style={css.hint}>&#x1F4A1; Set this the night before if you know your start time</div>
      </div>

      <div style={css.card}><LunchCard css={css} s={s} update={update} /></div>
      <div style={css.card}><DinnerCard css={css} s={s} update={update} /></div>

      <div className="card-full" style={css.card}>
        <div style={css.lbl}>&#x1F4CB; SCHEDULE PREVIEW</div>
        <div style={css.previewGrid}>
          {(() => {
            const nowMins = new Date().getHours() * 60 + new Date().getMinutes()
            return [...schedule]
              .sort((a, b) => {
                const ae = a.fireAt < nowMins ? a.fireAt + 1440 : a.fireAt
                const be = b.fireAt < nowMins ? b.fireAt + 1440 : b.fireAt
                return ae - be
              })
              .map(item => {
                const tmrw = item.fireAt < nowMins
                return (
                  <React.Fragment key={item.id}>
                    <div style={css.previewLabel}>{item.emoji} {item.label}</div>
                    <div style={css.previewTime}>
                      {fmtTime(item.fireAt)}
                      {tmrw && <span style={{ color: '#636366', fontSize: 10, fontWeight: 400, marginLeft: 5 }}>tmrw</span>}
                    </div>
                  </React.Fragment>
                )
              })
          })()}
        </div>
      </div>

      <div className="card-full">
        <button style={css.btnSet} onClick={handleSet}>
          {isSet ? '✓ UPDATE REMINDERS' : 'SET REMINDERS'}
        </button>
        {isSet && (
          <button style={css.btnCancel} onClick={handleCancel}>Cancel Reminders</button>
        )}
        {notifPermission() === 'denied' && (
          <div style={{ background: '#2a1a1a', border: '1px solid #e5342a', borderRadius: 10, padding: '12px 16px', marginTop: 14, fontSize: 13, color: '#f2f2f7' }}>
            &#x26A0;&#xFE0F; Notifications blocked. Open Settings &gt; [app] &gt; Notifications &gt; Allow.
          </div>
        )}
      </div>
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

function DebugPanel({ deviceId }) {
  const [pw, setPw]           = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pwError, setPwError] = useState(false)
  const [status, setStatus]   = useState(null)
  const [ntfyRes, setNtfyRes] = useState(null)
  const [pushRes, setPushRes] = useState(null)
  const [loading, setLoading] = useState('')

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
      </div>
    </div>
  )
}

function LunchCard({ css, s, update }) {
  const lunchLabel = LUNCH_OPTS.find(o => o.v === s.lunchHour)?.l ?? `${s.lunchHour}h`
  return (
    <>
      <div style={css.lbl}>
        &#x1F37D;&#xFE0F; LUNCH BREAK
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
        &#x23F1; LUNCH DURATION
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
        &#x1F514; HEADS-UP BEFORE LUNCH
        <span style={css.val}>{s.lunchWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={1} max={15} step={1} value={s.lunchWarning} onChange={e => update({ lunchWarning: Number(e.target.value) })} />
        <div style={css.sliderLabels}><span>1 min early</span><span>15 min early</span></div>
      </div>
    </>
  )
}

function DinnerCard({ css, s, update }) {
  const dinnerLabel = DINNER_OPTS.find(o => o.v === s.dinnerHour)?.l ?? `${s.dinnerHour}h`
  return (
    <>
      <div style={css.lbl}>
        &#x1F319; DINNER / LONG DAY BREAK
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
        &#x23F1; DINNER DURATION
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
        &#x1F514; HEADS-UP BEFORE DINNER
        <span style={css.val}>{s.dinnerWarning} min</span>
      </div>
      <div style={css.sliderWrap}>
        <input type="range" min={1} max={15} step={1} value={s.dinnerWarning} onChange={e => update({ dinnerWarning: Number(e.target.value) })} />
        <div style={css.sliderLabels}><span>1 min early</span><span>15 min early</span></div>
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
          style={{ width: 51, height: 31, borderRadius: 15.5, border: 'none', cursor: 'pointer', background: s.dinnerEnabled ? '#32d74b' : '#3a3a3c', position: 'relative', transition: 'background .25s', flexShrink: 0 }}
          aria-label="Toggle dinner reminders"
        >
          <span style={{ position: 'absolute', top: 2, left: s.dinnerEnabled ? 22 : 2, width: 27, height: 27, borderRadius: '50%', background: '#fff', transition: 'left .25s' }} />
        </button>
      </div>
    </>
  )
}
