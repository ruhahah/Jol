import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en } from '../i18n/en'
import { kk } from '../i18n/kk'
import { ru, type Dict } from '../i18n/ru'
import { PROFILES, type Profile } from './profiles'
import { URL_LANG } from './telegram'

export type Lang = 'kk' | 'ru' | 'en'
type Theme = 'light' | 'dark'

const DICTS: Record<Lang, Dict> = { kk, ru, en }
const KEY = 'jol:prefs'

interface Stored {
  lang?: Lang
  theme?: Theme
  largeText?: boolean
  contrast?: boolean
  profile?: Profile
}

function read(): Stored {
  let stored: Stored = {}
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    /* хранилище недоступно */
  }
  // Бот открывает измеритель со своим языком: ?lang=kk
  if (URL_LANG && URL_LANG in DICTS) stored.lang = URL_LANG as Lang
  return stored
}

function browserLang(): Lang {
  const l = navigator.language.toLowerCase()
  return l.startsWith('kk') ? 'kk' : l.startsWith('en') ? 'en' : 'ru'
}

interface Prefs {
  lang: Lang
  setLang: (l: Lang) => void
  t: Dict
  theme: Theme
  toggleTheme: () => void
  largeText: boolean
  toggleLargeText: () => void
  /** Режим высокого контраста для слабовидящих */
  contrast: boolean
  toggleContrast: () => void
  /** Как человек передвигается — от этого зависят цвета знаков на карте */
  profile: Profile
  setProfile: (p: Profile) => void
}

const Ctx = createContext<Prefs | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Stored>(read)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const lang = stored.lang ?? browserLang()
  const theme: Theme = stored.theme ?? (systemDark ? 'dark' : 'light')
  const largeText = !!stored.largeText
  const contrast = !!stored.contrast
  const profile: Profile = PROFILES.includes(stored.profile!) ? stored.profile! : 'wheelchair'

  useEffect(() => {
    const root = document.documentElement
    root.lang = lang
    if (stored.theme) root.dataset.theme = stored.theme
    else delete root.dataset.theme
    if (largeText) root.dataset.text = 'large'
    else delete root.dataset.text
    if (contrast) root.dataset.contrast = 'high'
    else delete root.dataset.contrast
    document.title = DICTS[lang].meta.title
    try {
      localStorage.setItem(KEY, JSON.stringify(stored))
    } catch {
      /* приватный режим — живём без сохранения */
    }
  }, [stored, lang, largeText, contrast])

  const value = useMemo<Prefs>(
    () => ({
      lang,
      t: DICTS[lang],
      theme,
      largeText,
      setLang: (l) => setStored((s) => ({ ...s, lang: l })),
      toggleTheme: () => setStored((s) => ({ ...s, theme: theme === 'dark' ? 'light' : 'dark' })),
      toggleLargeText: () => setStored((s) => ({ ...s, largeText: !s.largeText })),
      contrast,
      toggleContrast: () => setStored((s) => ({ ...s, contrast: !s.contrast })),
      profile,
      setProfile: (p) => setStored((s) => ({ ...s, profile: p })),
    }),
    [lang, theme, largeText, contrast, profile],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePrefs(): Prefs {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePrefs outside PrefsProvider')
  return ctx
}
