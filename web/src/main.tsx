import '@fontsource-variable/onest'
import '@fontsource-variable/unbounded'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PlacesProvider } from './lib/places'
import { PrefsProvider } from './lib/prefs'
import { IN_TELEGRAM } from './lib/telegram'
import './styles/base.css'

// Офлайн-режим и установка на телефон (public/sw.js). Только в собранной версии:
// при разработке кэш мешал бы видеть свежие правки. Внутри Telegram он тоже не нужен.
if (import.meta.env.PROD && !IN_TELEGRAM && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <PlacesProvider>
        <App />
      </PlacesProvider>
    </PrefsProvider>
  </StrictMode>,
)
