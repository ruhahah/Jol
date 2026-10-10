import { ALargeSmall, Menu, Moon, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePrefs, type Lang } from '../lib/prefs'

const LANG_LABELS: Record<Lang, string> = { kk: 'ҚАЗ', ru: 'РУС', en: 'ENG' }

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path d="M9 23c7 0 3-11 10-11" fill="none" stroke="var(--brand-ink)" strokeWidth="3"
            strokeLinecap="round" strokeDasharray="0.1 5.2" />
      <circle cx="9" cy="23" r="2.6" fill="var(--brand-ink)" />
      <circle cx="22" cy="11" r="4.2" fill="none" stroke="var(--brand-ink)" strokeWidth="2.6" />
    </svg>
  )
}

export function Header({ page }: { page: string }) {
  const { t, lang, setLang, theme, toggleTheme, largeText, toggleLargeText } = usePrefs()
  const [open, setOpen] = useState(false)

  useEffect(() => setOpen(false), [page])

  const links: [string, string][] = [
    ['', t.nav.home], ['map', t.nav.map], ['slope', t.nav.slope], ['stats', t.nav.stats],
  ]
  const nav = links.map(([path, label]) => (
    <a key={path} href={`#/${path}`} aria-current={page === path ? 'page' : undefined}>
      {label}
    </a>
  ))

  const tools = (
    <>
      <div className="seg" role="group" aria-label={t.ui.lang}>
        {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
          <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {LANG_LABELS[l]}
          </button>
        ))}
      </div>
      <button type="button" className="icon-btn" aria-pressed={largeText} aria-label={t.ui.largeText}
              title={t.ui.largeText} onClick={toggleLargeText}>
        <ALargeSmall size={22} />
      </button>
      <button type="button" className="icon-btn" aria-label={t.ui.theme} title={t.ui.theme} onClick={toggleTheme}>
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>
    </>
  )

  return (
    <header className="header">
      <div className="header__in">
        <a className="logo" href="#/" aria-label="Jol">
          <Logo />
          <span>jol</span>
        </a>
        <nav className="nav nav--desktop" aria-label={t.ui.menu}>{nav}</nav>
        <div className="header__tools header__tools--desktop">{tools}</div>
        <button type="button" className="icon-btn menu-btn" aria-expanded={open}
                aria-label={open ? t.ui.close : t.ui.menu} onClick={() => setOpen(!open)}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open && (
        <div className="drawer">
          <nav className="nav" aria-label={t.ui.menu}>{nav}</nav>
          <div className="header__tools">{tools}</div>
        </div>
      )}
    </header>
  )
}
