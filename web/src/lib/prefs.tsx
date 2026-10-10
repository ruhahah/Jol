import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en } from '../i18n/en'
import { kk } from '../i18n/kk'
import { ru, type Dict } from '../i18n/ru'

export type Lang = 'kk' | 'ru' | 'en'
type Theme = 'light' | 'dark'

const DICTS: Record<Lang, Dict> = { kk, ru, en }
const KEY = 'jol:prefs'

interface Stored {
  lang?: Lang
  theme?: Theme
  largeText?: boolean
}

function read(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
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

  useEffect(() => {
    const root = document.documentElement
    root.lang = lang
    if (stored.theme) root.dataset.theme = stored.theme
    else delete root.dataset.theme
    if (largeText) root.dataset.text = 'large'
    else delete root.dataset.text
    document.title = DICTS[lang].meta.title
    try {
      localStorage.setItem(KEY, JSON.stringify(stored))
    } catch {
      /* приватный режим — живём без сохранения */
    }
  }, [stored, lang, largeText])

  const value = useMemo<Prefs>(
    () => ({
      lang,
      t: DICTS[lang],
      theme,
      largeText,
      setLang: (l) => setStored((s) => ({ ...s, lang: l })),
      toggleTheme: () => setStored((s) => ({ ...s, theme: theme === 'dark' ? 'light' : 'dark' })),
      toggleLargeText: () => setStored((s) => ({ ...s, largeText: !s.largeText })),
    }),
    [lang, theme, largeText],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePrefs(): Prefs {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePrefs outside PrefsProvider')
  return ctx
}
