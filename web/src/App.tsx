import { useEffect } from 'react'
import { Header } from './components/Header'
import { usePrefs } from './lib/prefs'
import { useRoute } from './lib/router'
import { IN_TELEGRAM } from './lib/telegram'
import { Landing } from './pages/Landing'
import { MapPage } from './pages/MapPage'
import { SlopePage } from './pages/SlopePage'
import { StatsPage } from './pages/StatsPage'
import { StickerPage } from './pages/StickerPage'

export default function App() {
  const { t } = usePrefs()
  const route = useRoute()
  const page = ['map', 'slope', 'stats', 'sticker'].includes(route[0]) ? route[0] : ''

  useEffect(() => {
    window.scrollTo(0, 0) // в фигурных скобках: новые браузеры возвращают из scrollTo Promise
  }, [page])

  // Открыты из бота как мини-приложение: только измеритель, без шапки и остального сайта
  if (IN_TELEGRAM) {
    return (
      <main id="main">
        <SlopePage />
      </main>
    )
  }

  const skip = (e: React.MouseEvent) => {
    e.preventDefault() // обычный href="#main" сломал бы hash-маршруты
    document.getElementById('main')?.focus()
  }

  return (
    <>
      <a className="skip-link" href="#main" onClick={skip}>{t.ui.skip}</a>
      <Header page={page} />
      <main id="main" tabIndex={-1}>
        {page === 'map' ? (
          <MapPage placeId={route[1] ? Number(route[1]) : null} />
        ) : page === 'slope' ? (
          <SlopePage />
        ) : page === 'stats' ? (
          <StatsPage />
        ) : page === 'sticker' ? (
          <StickerPage placeId={route[1] ? Number(route[1]) : null} />
        ) : (
          <Landing />
        )}
      </main>
    </>
  )
}
