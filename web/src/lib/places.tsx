import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadPlaces } from './data'
import type { Place } from './types'

interface PlacesState {
  places: Place[]
  loading: boolean
  error: boolean
}

interface PlacesContext {
  state: PlacesState
  /** Начинает загрузку, если она ещё не начата */
  ensure: () => void
}

const Ctx = createContext<PlacesContext>({ state: { places: [], loading: true, error: false }, ensure: () => {} })

/**
 * Полный список мест нужен карте, статистике и наклейке, но не главной странице.
 * Поэтому загрузка начинается не при открытии сайта, а когда список впервые кому-то
 * понадобился (первый вызов usePlaces), и результат общий для всех страниц.
 */
export function PlacesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlacesState>({ places: [], loading: true, error: false })
  const started = useRef(false)

  const ensure = useCallback(() => {
    if (started.current) return
    started.current = true
    loadPlaces()
      .then((places) => setState({ places, loading: false, error: false }))
      .catch(() => setState({ places: [], loading: false, error: true }))
  }, [])

  return <Ctx.Provider value={{ state, ensure }}>{children}</Ctx.Provider>
}

export function usePlaces(): PlacesState {
  const { state, ensure } = useContext(Ctx)
  useEffect(ensure, [ensure])
  return state
}
