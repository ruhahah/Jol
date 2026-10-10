import {
  ArrowRight, BadgeCheck, Building2, CalendarCheck, Camera, HeartHandshake, Landmark, Send,
  Store, UserCheck, Accessibility, Map as MapIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { PhoneDemo } from '../components/PhoneDemo'
import { RampGraphic } from '../components/RampGraphic'
import { StatusGlyph } from '../components/StatusGlyph'
import { BOT_USERNAME, IS_DEMO } from '../lib/data'
import { usePlaces } from '../lib/places'
import { usePrefs } from '../lib/prefs'
import { STATUSES, type Status } from '../lib/types'
import '../styles/landing.css'

function BotButton({ ghost = false }: { ghost?: boolean }) {
  const { t } = usePrefs()
  if (!BOT_USERNAME) return <p className="hero__soon"><Send size={16} /> {t.hero.botSoon}</p>
  return (
    <a className={`btn ${ghost ? 'btn--ghost' : 'btn--primary'}`} href={`https://t.me/${BOT_USERNAME}`}
       target="_blank" rel="noreferrer">
      <Send size={18} /> {t.hero.ctaBot}
    </a>
  )
}

function Stats() {
  const { t } = usePrefs()
  const { places, loading, error } = usePlaces()
  if (loading || error || !places.length) return null

  const count = (s: Status) => places.filter((p) => p.status === s).length
  const total = places.length
  const tiles: [number, string][] = [
    [total, t.stats.places],
    [count('accessible'), t.stats.accessible],
    [places.filter((p) => p.isVerified).length, t.stats.verified],
    [places.reduce((sum, p) => sum + p.reportsCount, 0), t.stats.reports],
  ]

  return (
    <section className="stats container" aria-labelledby="stats-title">
      <div className="stats__head">
        <h2 id="stats-title">{t.stats.title}</h2>
        {IS_DEMO && <span className="demo-pill" title={t.ui.demoHint}>{t.ui.demo}</span>}
      </div>
      <dl className="stats__tiles">
        {tiles.map(([value, label]) => (
          <div key={label} className="tile">
            <dt>{label}</dt>
            <dd className="display">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="split" role="img" aria-label={t.stats.barLabel}>
        {STATUSES.map((s) => count(s) > 0 && (
          <span key={s} className={`split__seg split__seg--${s}`} style={{ flexGrow: count(s) }}
                title={`${t.status[s]}: ${count(s)}`} />
        ))}
      </div>
      <ul className="split__legend">
        {STATUSES.map((s) => (
          <li key={s}>
            <StatusGlyph status={s} size={20} />
            <span>{t.status[s]}</span>
            <strong>{count(s)}</strong>
            <small>{Math.round((count(s) / total) * 100)}%</small>
          </li>
        ))}
      </ul>
      {IS_DEMO && <p className="stats__note">{t.ui.demoHint}</p>}
    </section>
  )
}

/** Пандус в тизере плавно «дышит» между пологим и крутым */
function useSwingingSlope(): number {
  const [pct, setPct] = useState(7)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      setPct(8.5 + 5.5 * Math.sin((now - start) / 1900))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
  return pct
}

export function Landing() {
  const { t } = usePrefs()
  const pct = useSwingingSlope()

  return (
    <>
      <section className="hero container">
        <div className="hero__text">
          <p className="eyebrow">{t.hero.eyebrow}</p>
          <h1>{t.hero.title}</h1>
          <p className="hero__sub">{t.hero.sub}</p>
          <div className="hero__cta">
            <a className="btn btn--primary" href="#/map">
              <MapIcon size={18} /> {t.hero.ctaMap}
            </a>
            <BotButton ghost />
          </div>
          <p className="hero__note">{t.hero.note}</p>
        </div>
        <div className="hero__visual">
          <svg className="hero__route" viewBox="0 0 520 560" aria-hidden="true">
            <path d="M-20 500 C 120 520 110 360 230 350 S 330 150 540 90" />
          </svg>
          <span className="float float--1"><StatusGlyph status="accessible" size={44} /></span>
          <span className="float float--2"><StatusGlyph status="partial" size={38} /></span>
          <span className="float float--3"><StatusGlyph status="inaccessible" size={34} /></span>
          <span className="float float--4"><StatusGlyph status="unknown" size={30} /></span>
          <PhoneDemo />
        </div>
      </section>

      <Stats />

      <section className="section container" aria-labelledby="signs-title">
        <h2 id="signs-title">{t.signs.title}</h2>
        <p className="section__sub">{t.signs.sub}</p>
        <ul className="signs">
          {STATUSES.map((s) => (
            <li key={s} className={`sign sign--${s}`}>
              <StatusGlyph status={s} size={56} />
              <h3>{t.status[s]}</h3>
              <p>{t.signs[s]}</p>
            </li>
          ))}
        </ul>
        <p className="signs__verified"><BadgeCheck size={22} /> {t.signs.verified}</p>
      </section>

      <section className="section container" aria-labelledby="how-title">
        <h2 id="how-title">{t.how.title}</h2>
        <ol className="steps">
          {[
            [t.how.s1t, t.how.s1d],
            [t.how.s2t, t.how.s2d],
            [t.how.s3t, t.how.s3d],
          ].map(([title, text], i) => (
            <li key={title}>
              <span className="steps__n display" aria-hidden="true">{i + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="container">
        <div className="teaser">
          <div className="teaser__text">
            <p className="eyebrow">{t.teaser.eyebrow}</p>
            <h2>{t.teaser.title}</h2>
            <p>{t.teaser.text}</p>
            <a className="btn btn--primary" href="#/slope">
              {t.teaser.cta} <ArrowRight size={18} />
            </a>
          </div>
          <div className="teaser__visual">
            <RampGraphic pct={pct} />
            <p className="teaser__pct display" aria-hidden="true">{pct.toFixed(1)}%</p>
          </div>
        </div>
      </section>

      <section className="section container" aria-labelledby="aud-title">
        <h2 id="aud-title">{t.audience.title}</h2>
        <ul className="cards cards--4">
          <li><Accessibility size={26} /><h3>{t.audience.peopleT}</h3><p>{t.audience.peopleD}</p></li>
          <li><HeartHandshake size={26} /><h3>{t.audience.volunteersT}</h3><p>{t.audience.volunteersD}</p></li>
          <li><Store size={26} /><h3>{t.audience.businessT}</h3><p>{t.audience.businessD}</p></li>
          <li><Landmark size={26} /><h3>{t.audience.cityT}</h3><p>{t.audience.cityD}</p></li>
        </ul>
      </section>

      <section className="section container" aria-labelledby="pr-title">
        <h2 id="pr-title">{t.principles.title}</h2>
        <ul className="cards cards--3 cards--plain">
          <li><UserCheck size={26} /><h3>{t.principles.humanT}</h3><p>{t.principles.humanD}</p></li>
          <li><CalendarCheck size={26} /><h3>{t.principles.dateT}</h3><p>{t.principles.dateD}</p></li>
          <li><Camera size={26} /><h3>{t.principles.photoT}</h3><p>{t.principles.photoD}</p></li>
        </ul>
      </section>

      <footer className="footer">
        <div className="container">
          <div className="footer__cta">
            <h2>{t.footer.ctaTitle}</h2>
            <p>{t.footer.ctaText}</p>
            <div className="hero__cta">
              <a className="btn btn--primary" href="#/map"><MapIcon size={18} /> {t.hero.ctaMap}</a>
              <BotButton ghost />
            </div>
          </div>
          <p className="footer__credits">
            <Building2 size={16} /> {t.footer.about} <span>{t.footer.map}</span>
          </p>
        </div>
      </footer>
    </>
  )
}
