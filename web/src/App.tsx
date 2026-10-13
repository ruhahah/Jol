import { lazy, Suspense, useEffect } from 'react'
import { Header } from './components/Header'
import { usePrefs } from './lib/prefs'
import { useRoute } from './lib/router'
import { IN_TELEGRAM } from './lib/telegram'
import { Landing } from './pages/Landing'

// Каждая страница, кроме главной, — отдельный файл, который скачивается, только когда она
// нужна. Иначе посетитель главной качал бы карту (Leaflet), генератор QR-кодов и всё остальное.
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })))
const SlopePage = lazy(() => import('./pages/SlopePage').then((m) => ({ default: m.SlopePage })))
const StatsPage = lazy(() => import('./pages/StatsPage').then((m) => ({ default: m.StatsPage })))
const StickerPage = lazy(() => import('./pages/StickerPage').then((m) => ({ default: m.StickerPage })))

export default function App() {
  const { t } = usePrefs()
  const route = useRoute()
  const page = ['map', 'slope', 'stats', 'sticker'].includes(route[0]) ? route[0] : ''

  useEffect(() => {
    window.scrollTo(0, 0) // в фигурных скобках: новые браузеры возвращают из scrollTo Promise
  }, [page])

  const loading = <p className="page-loading" role="status">{t.ui.loadingPage}</p>

  // Открыты из бота как мини-приложение: только измеритель, без шапки и остального сайта
  if (IN_TELEGRAM) {
    return (
      <main id="main">
        <Suspense fallback={loading}>
          <SlopePage />
        </Suspense>
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
        <Suspense fallback={loading}>
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
        </Suspense>
      </main>
    </>
  )
}
