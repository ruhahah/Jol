import {
  ArrowLeft, BadgeCheck, BellRing, Camera, Check, CircleHelp, Clock, DoorOpen, ExternalLink, Link2,
  Minus, QrCode, Send, Toilet, TriangleAlert, X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { BOT_USERNAME, IS_DEMO } from '../lib/data'
import { daysSince, STALE_DAYS } from '../lib/geo'
import { usePrefs } from '../lib/prefs'
import type { Place } from '../lib/types'
import type { Dict } from '../i18n/ru'
import { StatusBadge } from './StatusGlyph'

type Tone = 'good' | 'mid' | 'bad' | 'unknown'

const TONE_ICON: Record<Tone, ReactNode> = {
  good: <Check size={15} strokeWidth={3} />,
  mid: <Minus size={15} strokeWidth={3} />,
  bad: <X size={15} strokeWidth={3} />,
  unknown: <CircleHelp size={15} />,
}

const StepsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 20h5v-5h5v-5h5V5h3" />
  </svg>
)

const RampIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 19h18V8z" />
  </svg>
)

export function ago(t: Dict, iso: string): string {
  const days = daysSince(iso)
  if (days === 0) return t.time.today
  if (days < 60) return t.time.days(days)
  if (days < 365) return t.time.months(Math.floor(days / 30))
  return t.time.year
}

function rows(t: Dict, place: Place): { icon: ReactNode; label: string; value: string; tone: Tone }[] {
  const f = place.features!
  const v = t.place.v
  const tri = (x: 'yes' | 'no' | 'unknown') => ({ value: v[x], tone: (x === 'yes' ? 'good' : x === 'no' ? 'bad' : 'unknown') as Tone })
  const slope = f.rampSlopePct === null ? '' : ` · ${t.place.slope(f.rampSlopePct.toFixed(1))}`

  const steps = {
    none: { value: v.none, tone: 'good' },
    one: { value: v.one, tone: 'mid' },
    many: { value: v.many, tone: 'bad' },
    unknown: { value: v.unknown, tone: 'unknown' },
  }[f.steps] as { value: string; tone: Tone }

  const ramp =
    f.steps === 'none'
      ? { value: v.rampNotNeeded, tone: 'good' as Tone }
      : ({
          good: { value: v.good + slope, tone: 'good' },
          bad: { value: v.bad + slope, tone: 'bad' },
          none: { value: v.none, tone: 'bad' },
          unknown: { value: v.unknown, tone: 'unknown' },
        }[f.ramp] as { value: string; tone: Tone })

  const door = {
    yes: { value: v.doorYes, tone: 'good' },
    no: { value: v.doorNo, tone: 'bad' },
    unknown: { value: v.unknown, tone: 'unknown' },
  }[f.doorWide] as { value: string; tone: Tone }

  return [
    { icon: <StepsIcon />, label: t.place.steps, ...steps },
    { icon: <RampIcon />, label: t.place.ramp, ...ramp },
    { icon: <DoorOpen size={22} />, label: t.place.door, ...door },
    { icon: <BellRing size={22} />, label: t.place.callButton, ...tri(f.callButton) },
    { icon: <Toilet size={22} />, label: t.place.toilet, ...tri(f.toilet) },
  ]
}

export function PlaceDetail({ place, distance }: { place: Place; distance: string | null }) {
  const { t, profile } = usePrefs()
  const [copied, setCopied] = useState(false)
  const stale = place.lastCheckedAt !== null && daysSince(place.lastCheckedAt) > STALE_DAYS

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* буфер обмена недоступен — ссылка всё равно в адресной строке */
    }
  }

  return (
    <article className="detail">
      <a className="detail__back" href="#/map">
        <ArrowLeft size={18} /> {t.map.back}
      </a>

      <p className="detail__cat">
        {t.cat[place.category]}
        {distance && <> · {distance}</>}
      </p>
      <h2 className="detail__name">{place.name}</h2>

      <div className="detail__status">
        <StatusBadge status={place.status} large />
        {place.isVerified ? (
          <span className="verified"><BadgeCheck size={18} /> {t.place.verifiedBy(place.reportsCount)}</span>
        ) : (
          place.features && <span className="pending">{t.place.notVerified}</span>
        )}
      </div>

      {profile !== 'wheelchair' && place.features && (
        <p className="detail__profile">{t.profile[profile]}. {t.profile.note}</p>
      )}

      {place.lastCheckedAt && (
        <p className={`detail__date${stale ? ' is-stale' : ''}`}>
          {stale ? <TriangleAlert size={17} /> : <Clock size={17} />}
          <span>
            {t.place.checked} {ago(t, place.lastCheckedAt)}
            {stale && <><br />{t.place.stale}</>}
          </span>
        </p>
      )}

      {place.features ? (
        <section aria-labelledby="entrance-title">
          <h3 id="entrance-title" className="detail__h">{t.place.entrance}</h3>
          <dl className="features">
            {rows(t, place).map((r) => (
              <div key={r.label} className="feature">
                <span className="feature__icon">{r.icon}</span>
                <dt>{r.label}</dt>
                <dd>
                  <span className={`tone tone--${r.tone}`}>{TONE_ICON[r.tone]}</span>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <p className="detail__empty">
          <strong>{t.place.noData}</strong> {t.place.noDataCta}
        </p>
      )}

      <section aria-labelledby="photos-title">
        <h3 id="photos-title" className="detail__h">{t.place.photos}</h3>
        <p className="photos-note"><Camera size={20} /> {t.place.photosNote}</p>
      </section>

      <section aria-labelledby="open-title">
        <h3 id="open-title" className="detail__h">{t.place.openIn}</h3>
        <div className="detail__actions">
          <a className="btn btn--ghost btn--sm" target="_blank" rel="noreferrer"
             href={`https://2gis.kz/geo/${place.lon},${place.lat}`}>
            2GIS <ExternalLink size={15} />
          </a>
          <a className="btn btn--ghost btn--sm" target="_blank" rel="noreferrer"
             href={`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`}>
            Google Maps <ExternalLink size={15} />
          </a>
          <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
            {copied ? <Check size={15} /> : <Link2 size={15} />} {copied ? t.place.copied : t.place.copyLink}
          </button>
          <a className="btn btn--ghost btn--sm" href={`#/sticker/${place.id}`}>
            <QrCode size={15} /> {t.sticker.link}
          </a>
        </div>
      </section>

      {BOT_USERNAME && (
        <a className="btn btn--primary detail__update" target="_blank" rel="noreferrer"
           href={`https://t.me/${BOT_USERNAME}?start=place_${place.id}`}>
          <Send size={18} /> {t.place.update}
        </a>
      )}

      {IS_DEMO && <p className="detail__demo">{t.place.demoRecord}</p>}
    </article>
  )
}
