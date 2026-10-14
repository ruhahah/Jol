import {
  ArrowRight, BadgeCheck, Building2, CalendarCheck, Camera, HeartHandshake, Landmark, Send,
  Store, Target, UserCheck, Accessibility, Map as MapIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PhoneDemo } from '../components/PhoneDemo'
import { RampGraphic } from '../components/RampGraphic'
import { StatusGlyph } from '../components/StatusGlyph'
import { BOT_USERNAME, IS_DEMO, loadCampaigns, loadSummary, type Campaign, type Summary } from '../lib/data'
import { usePrefs } from '../lib/prefs'
import { STATUSES } from '../lib/types'
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

/**
 * Числа для блока «Карта сейчас». Главной не нужен весь список мест, поэтому берём одну
 * строку сводки и запрашиваем её, когда браузер свободен, — чтобы не мешать первой отрисовке.
 */
function useSummary(): Summary | null {
  const [summary, setSummary] = useState<Summary | null>(null)
  useEffect(() => {
    const load = () => loadSummary().then(setSummary).catch(() => {})
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(load, { timeout: 2000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(load, 200)
    return () => clearTimeout(id)
  }, [])
  return summary
}

function Stats() {
  const { t } = usePrefs()
  const summary = useSummary()
  // Пока сводка не пришла, блок уже стоит на своём месте с прочерками — страница не прыгает
  const value = (n: number | undefined) => (n === undefined ? '–' : n)
  const tiles: [number | undefined, string][] = [
    [summary?.total, t.stats.places],
    [summary?.accessible, t.stats.accessible],
    [summary?.verified, t.stats.verified],
    [summary?.reports, t.stats.reports],
  ]

  return (
    <section className="stats container" aria-labelledby="stats-title" aria-busy={!summary}>
      <div className="stats__head">
        <h2 id="stats-title">{t.stats.title}</h2>
        {IS_DEMO && <span className="demo-pill" title={t.ui.demoHint}>{t.ui.demo}</span>}
      </div>
      <dl className="stats__tiles">
        {tiles.map(([n, label]) => (
          <div key={label} className="tile">
            <dt>{label}</dt>
            <dd className="display">{value(n)}</dd>
          </div>
        ))}
      </dl>
      <div className="split" role="img" aria-label={t.stats.barLabel}>
        {summary && STATUSES.map((s) => summary[s] > 0 && (
          <span key={s} className={`split__seg split__seg--${s}`} style={{ flexGrow: summary[s] }}
                title={`${t.status[s]}: ${summary[s]}`} />
        ))}
      </div>
      <ul className="split__legend">
        {STATUSES.map((s) => (
          <li key={s}>
            <StatusGlyph status={s} size={20} />
            <span>{t.status[s]}</span>
            <strong>{value(summary?.[s])}</strong>
            {summary && summary.total > 0 && <small>{Math.round((summary[s] / summary.total) * 100)}%</small>}
          </li>
        ))}
      </ul>
      {IS_DEMO && <p className="stats__note">{t.ui.demoHint}</p>}
    </section>
  )
}

/** Идущая акция для волонтёров с прогрессом. Если акций нет, блока нет. */
function CampaignBanner() {
  const { t, lang } = usePrefs()
  const [campaign, setCampaign] = useState<Campaign | null>(null)

  useEffect(() => {
    const load = () => loadCampaigns().then((list) => setCampaign(list[0] ?? null)).catch(() => {})
    const id = setTimeout(load, 300) // после первой отрисовки
    return () => clearTimeout(id)
  }, [])

  if (!campaign) return null
  const share = Math.min(100, Math.round((campaign.done / campaign.goal) * 100))
  const until = new Date(campaign.endsAt).toLocaleDateString(lang === 'kk' ? 'kk-KZ' : lang === 'en' ? 'en-GB' : 'ru-RU',
                                                              { day: 'numeric', month: 'long' })
  return (
    <section className="container">
      <div className="campaign">
        <p className="eyebrow"><Target size={16} aria-hidden="true" /> {t.campaign.eyebrow}</p>
        <h2>{campaign.title}</h2>
        <p className="campaign__meta">
          {campaign.category ? t.cat[campaign.category] : t.campaign.any} · {t.campaign.until(until)}
        </p>
        <div className="campaign__bar" role="img" aria-label={t.campaign.progress(campaign.done, campaign.goal)}>
          <span style={{ width: `${share}%` }} />
        </div>
        <p className="campaign__progress"><strong>{share}%</strong> · {t.campaign.progress(campaign.done, campaign.goal)}</p>
        {BOT_USERNAME && (
          <a className="btn btn--primary" href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noreferrer">
            <Send size={18} /> {t.campaign.cta}
          </a>
        )}
      </div>
    </section>
  )
}

/**
 * Пандус в тизере плавно «дышит» между пологим и крутым.
 * Анимация живёт в собственном маленьком компоненте: раньше она обновляла состояние всей
 * главной страницы 60 раз в секунду. Работает только пока блок виден на экране, а
 * состояние меняется, лишь когда меняется показанная цифра (десятые доли процента).
 */
function TeaserRamp() {
  const box = useRef<HTMLDivElement>(null)
  const [pct, setPct] = useState(7)

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const next = Math.round((8.5 + 5.5 * Math.sin((now - start) / 1900)) * 10) / 10
      setPct((current) => (current === next ? current : next))
      frame = requestAnimationFrame(tick)
    }
    const observer = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frame)
      if (entry.isIntersecting) frame = requestAnimationFrame(tick)
    })
    observer.observe(box.current!)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="teaser__visual" ref={box}>
      <RampGraphic pct={pct} />
      <p className="teaser__pct display" aria-hidden="true">{pct.toFixed(1)}%</p>
    </div>
  )
}

/** Пока человек читает главную, заранее подгружаем код карты — самый вероятный следующий шаг */
function usePrefetchMap() {
  useEffect(() => {
    const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (connection?.saveData || connection?.effectiveType?.includes('2g')) return
    const id = setTimeout(() => void import('./MapPage'), 2500)
    return () => clearTimeout(id)
  }, [])
}

export function Landing() {
  const { t } = usePrefs()
  usePrefetchMap()

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

      <CampaignBanner />

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
          <TeaserRamp />
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
