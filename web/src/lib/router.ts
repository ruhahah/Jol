import { useEffect, useState } from 'react'

// Маршруты на hash (#/map/12): работают на любом статическом хостинге без настройки.

function parse(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const onChange = () => setRoute(parse())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(path: string, replace = false) {
  const hash = `#/${path}`
  if (replace) history.replaceState(null, '', hash), window.dispatchEvent(new HashChangeEvent('hashchange'))
  else window.location.hash = hash
}
