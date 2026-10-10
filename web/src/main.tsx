import '@fontsource-variable/onest'
import '@fontsource-variable/unbounded'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PlacesProvider } from './lib/places'
import { PrefsProvider } from './lib/prefs'
import './styles/base.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <PlacesProvider>
        <App />
      </PlacesProvider>
    </PrefsProvider>
  </StrictMode>,
)
