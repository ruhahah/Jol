import { MapPin } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { usePrefs } from '../lib/prefs'
import { Logo } from './Header'
import { StatusBadge } from './StatusGlyph'

/** Рисунок входа вместо настоящего фото: две ступеньки, пандус и дверь. */
function EntranceArt() {
  return (
    <svg viewBox="0 0 160 100" className="chat__photo" aria-hidden="true">
      <rect width="160" height="100" fill="var(--surface-2)" />
      <rect x="0" y="78" width="160" height="22" fill="var(--line)" />
      <rect x="92" y="18" width="40" height="48" rx="2" fill="var(--brand-soft)" stroke="var(--brand)" strokeWidth="2" />
      <circle cx="100" cy="44" r="2" fill="var(--brand)" />
      <path d="M84 66h56v6h8v6H76v-6h8z" fill="var(--muted)" />
      <path d="M14 78L76 66v12z" fill="var(--st-accessible)" />
      <path d="M14 74L76 60" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function PhoneDemo() {
  const { t } = usePrefs()
  const c = t.chat

  const messages: { me?: boolean; body: ReactNode }[] = [
    { body: c.askLocation },
    { me: true, body: <span className="chat__loc"><MapPin size={16} /> {c.location}</span> },
    { body: <>{c.choose}<span className="chat__chip">{c.place}</span></> },
    { body: c.askPhoto },
    { me: true, body: <><EntranceArt /><span className="sr-only">{c.photo}</span></> },
    { body: c.askSteps },
    { me: true, body: c.steps },
    { body: c.askRamp },
    { me: true, body: c.ramp },
    { body: <>{c.thanks}<span className="chat__result"><StatusBadge status="accessible" /></span></> },
  ]

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(reduced ? messages.length : 1)

  useEffect(() => {
    if (reduced) return
    const done = shown >= messages.length
    const id = setTimeout(() => setShown(done ? 1 : shown + 1), done ? 4200 : 1150)
    return () => clearTimeout(id)
  }, [shown, reduced, messages.length])

  return (
    <figure className="phone">
      <div className="phone__body">
        <div className="phone__bar">
          <span className="phone__avatar"><Logo /></span>
          <span>
            <strong>{c.title}</strong>
            <small>bot</small>
          </span>
        </div>
        {/* Декоративная анимация: тот же сценарий описан текстом в блоке «Как это работает» */}
        <div className="chat" aria-hidden="true">
          {messages.slice(0, shown).map((m, i) => (
            <div key={i} className={`chat__msg${m.me ? ' chat__msg--me' : ''}`}>{m.body}</div>
          ))}
        </div>
      </div>
      <figcaption>{c.caption}</figcaption>
    </figure>
  )
}
