import { Check, Copy, Crosshair, Play, Send, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { GENTLE_MAX, MODERATE_MAX, RampGraphic, ZONE_STATUS, zoneOf } from '../components/RampGraphic'
import { StatusGlyph } from '../components/StatusGlyph'
import { usePrefs } from '../lib/prefs'
import { IN_TELEGRAM, loadTelegram, type TgWebApp } from '../lib/telegram'
import '../styles/slope.css'

type Sensor = 'idle' | 'starting' | 'on' | 'none' | 'denied'

const SCALE_MAX = 16
const MEASURE_MS = 3000
const RAD = Math.PI / 180

/** Уклон в процентах по углам телефона; не зависит от того, каким краем он лежит вверх по пандусу */
function slopePct(beta: number, gamma: number): number {
  const tilt = Math.acos(Math.min(1, Math.abs(Math.cos(beta * RAD) * Math.cos(gamma * RAD))))
  return Math.min(Math.tan(tilt) * 100, 99)
}

export function SlopePage() {
  const { t } = usePrefs()
  const s = t.slope

  const [sensor, setSensor] = useState<Sensor>('idle')
  const [live, setLive] = useState(0)
  const [demo, setDemo] = useState(6.5)
  const [zeroed, setZeroed] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [result, setResult] = useState<{ mean: number; spread: number; n: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [tg, setTg] = useState<TgWebApp | null>(null)

  const raw = useRef({ beta: 0, gamma: 0 })
  const offset = useRef({ beta: 0, gamma: 0 })
  const smooth = useRef(0)
  const samples = useRef<number[] | null>(null)

  // Открыты из бота: готовим мини-приложение и разворачиваем его на весь экран
  useEffect(() => {
    loadTelegram().then((app) => {
      if (!app) return
      app.ready()
      app.expand()
      setTg(app)
    })
  }, [])

  const listening = sensor === 'starting' || sensor === 'on'

  useEffect(() => {
    if (!listening) return
    let gotData = false

    /** Одно показание датчика, углы в градусах */
    const onReading = (beta: number, gamma: number) => {
      if (!gotData) {
        gotData = true
        setSensor('on')
      }
      raw.current = { beta, gamma }
      const pct = slopePct(beta - offset.current.beta, gamma - offset.current.gamma)
      samples.current?.push(pct)
      smooth.current += (pct - smooth.current) * 0.15 // сглаживаем дрожание датчика
      setLive(smooth.current)
    }

    const onBrowserEvent = (e: DeviceOrientationEvent) => {
      if (e.beta !== null && e.gamma !== null) onReading(e.beta, e.gamma)
    }
    window.addEventListener('deviceorientation', onBrowserEvent)

    // Внутри Telegram у мини-приложений есть свой датчик (отдаёт углы в радианах).
    // Это запасной источник: включаем его, только если обычный датчик браузера молчит,
    // чтобы показания двух источников не смешивались.
    const orientation = tg?.isVersionAtLeast('8.0') ? tg.DeviceOrientation : undefined
    const onTelegramEvent = () => orientation && onReading(orientation.beta / RAD, orientation.gamma / RAD)
    let telegramStarted = false
    const fallback = setTimeout(() => {
      if (gotData || !tg || !orientation) return
      telegramStarted = true
      tg.onEvent('deviceOrientationChanged', onTelegramEvent)
      orientation.start({ refresh_rate: 60 })
    }, 600)

    // На компьютере событие либо не приходит, либо приходит пустым
    const timeout = setTimeout(() => !gotData && setSensor('none'), 2500)
    return () => {
      window.removeEventListener('deviceorientation', onBrowserEvent)
      if (telegramStarted && tg && orientation) {
        tg.offEvent('deviceOrientationChanged', onTelegramEvent)
        orientation.stop()
      }
      clearTimeout(fallback)
      clearTimeout(timeout)
    }
  }, [listening, tg])

  const start = async () => {
    // iOS показывает системный запрос и только после него отдаёт данные датчика
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
      .requestPermission
    if (typeof ask === 'function') {
      try {
        // Внутри Telegram отказ браузера не страшен: остаётся датчик самого Telegram
        if ((await ask()) !== 'granted' && !tg?.DeviceOrientation) return setSensor('denied')
      } catch {
        if (!tg?.DeviceOrientation) return setSensor('denied')
      }
    }
    setSensor('starting')
  }

  const calibrate = () => {
    offset.current = { ...raw.current }
    setZeroed(true)
    setResult(null)
  }

  const measure = () => {
    samples.current = []
    setMeasuring(true)
    setResult(null)
    setTimeout(() => {
      const list = samples.current ?? []
      samples.current = null
      setMeasuring(false)
      if (!list.length) return
      const mean = list.reduce((a, b) => a + b, 0) / list.length
      const spread = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length)
      setResult({ mean, spread, n: list.length })
    }, MEASURE_MS)
  }

  const active = sensor === 'on'
  const pct = result ? result.mean : active ? live : demo
  const zone = zoneOf(pct)
  const degrees = Math.atan(pct / 100) / RAD
  const pctText = pct.toFixed(1)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.copyText(pctText, degrees.toFixed(1)))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* буфер обмена недоступен */
    }
  }

  /** Отдаём замер боту; Telegram после этого сам закрывает мини-приложение */
  const sendToBot = () => {
    if (!tg || !result) return
    tg.sendData(JSON.stringify({
      slope_pct: Math.round(result.mean * 10) / 10,
      spread: Math.round(result.spread * 10) / 10,
      n: result.n,
    }))
  }

  return (
    <div className={`slope container${IN_TELEGRAM ? ' slope--tg' : ''}`}>
      <header className="slope__head">
        <h1>{s.title}</h1>
        <p>{s.lead}</p>
      </header>

      <div className="slope__grid">
        <section className={`gauge gauge--${zone}`} aria-live="polite">
          <p className="gauge__label">{result ? s.result : active ? s.live : s.demoSlider}</p>
          <p className="gauge__value display">
            {pctText}
            <span>%</span>
          </p>
          <dl className="gauge__facts">
            <div><dt>{s.angle}</dt><dd>{degrees.toFixed(1)}°</dd></div>
            <div><dt>{s.ratio}</dt><dd>{pct < 0.5 ? '—' : `1 : ${(100 / pct).toFixed(1)}`}</dd></div>
          </dl>
          {result && (
            <p className="gauge__stats">
              {s.samples(result.n)} · {s.spread(result.spread.toFixed(1))}
            </p>
          )}

          <RampGraphic pct={pct} />

          <div className="scale" role="img" aria-label={s.scaleLabel}>
            <div className="scale__track">
              <span style={{ flexGrow: GENTLE_MAX }} className="scale__zone scale__zone--gentle" />
              <span style={{ flexGrow: MODERATE_MAX - GENTLE_MAX }} className="scale__zone scale__zone--moderate" />
              <span style={{ flexGrow: SCALE_MAX - MODERATE_MAX }} className="scale__zone scale__zone--steep" />
              <span className="scale__needle" style={{ left: `${(Math.min(pct, SCALE_MAX) / SCALE_MAX) * 100}%` }} />
            </div>
            <div className="scale__ticks" aria-hidden="true">
              <span style={{ left: 0 }}>0</span>
              <span style={{ left: `${(GENTLE_MAX / SCALE_MAX) * 100}%` }}>{GENTLE_MAX}% · 1:20</span>
              <span style={{ left: `${(MODERATE_MAX / SCALE_MAX) * 100}%` }}>{MODERATE_MAX}% · 1:12</span>
              <span style={{ left: '100%' }}>{SCALE_MAX}%+</span>
            </div>
          </div>

          <div className="verdict">
            <StatusGlyph status={ZONE_STATUS[zone]} size={40} />
            <div>
              <strong>{s[`${zone}T`]}</strong>
              <p>{s[`${zone}D`]}</p>
            </div>
          </div>
        </section>

        <section className="controls">
          {active ? (
            <>
              <button type="button" className={`btn ${tg && result ? 'btn--ghost' : 'btn--primary'}`}
                      onClick={measure} disabled={measuring}>
                <Play size={18} /> {measuring ? s.measuring : s.measure}
              </button>
              {measuring && <span className="progress" style={{ animationDuration: `${MEASURE_MS}ms` }} />}
              <button type="button" className="btn btn--ghost" onClick={calibrate} disabled={measuring}>
                {zeroed ? <Check size={18} /> : <Crosshair size={18} />} {zeroed ? s.calibrated : s.calibrate}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--primary" onClick={start} disabled={sensor === 'starting'}>
                <Smartphone size={18} /> {s.start}
              </button>
              {sensor === 'none' && <p className="notice">{s.noSensor}</p>}
              {sensor === 'denied' && <p className="notice">{s.denied}</p>}
              {/* В боте ползунок не показываем: в отчёт должен попасть только настоящий замер */}
              {!IN_TELEGRAM && (
                <label className="slider">
                  <span>{s.demoSlider}</span>
                  <input type="range" min="0" max={SCALE_MAX} step="0.1" value={demo}
                         onChange={(e) => setDemo(Number(e.target.value))} aria-valuetext={`${demo.toFixed(1)}%`} />
                </label>
              )}
            </>
          )}

          {IN_TELEGRAM ? (
            <>
              <button type="button" className="btn btn--primary" onClick={sendToBot} disabled={!tg || !result}>
                <Send size={18} /> {s.send}{result ? ` · ${result.mean.toFixed(1)}%` : ''}
              </button>
              {!result && <p className="controls__hint">{s.needMeasure}</p>}
              <button type="button" className="btn btn--ghost" onClick={() => tg?.close()} disabled={!tg}>
                {s.backToBot}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={copy}>
              {copied ? <Check size={18} /> : <Copy size={18} />} {copied ? t.place.copied : s.copy}
            </button>
          )}

          <div className="tips">
            <h2>{s.tipsTitle}</h2>
            <ol>
              <li>{s.tip1}</li>
              <li>{s.tip2}</li>
              <li>{s.tip3}</li>
            </ol>
          </div>

          <p className="disclaimer">{s.disclaimer}</p>
        </section>
      </div>
    </div>
  )
}
