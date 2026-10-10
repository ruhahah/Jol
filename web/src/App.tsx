import { useEffect } from 'react'
import { Header } from './components/Header'
import { usePrefs } from './lib/prefs'
import { useRoute } from './lib/router'
import { Landing } from './pages/Landing'
import { MapPage } from './pages/MapPage'
import { SlopePage } from './pages/SlopePage'

export default function App() {
  const { t } = usePrefs()
  const route = useRoute()
  const page = ['map', 'slope'].includes(route[0]) ? route[0] : ''

  useEffect(() => {
    window.scrollTo(0, 0) // в фигурных скобках: новые браузеры возвращают из scrollTo Promise
  }, [page])

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
        ) : (
          <Landing />
        )}
      </main>
    </>
  )
}
