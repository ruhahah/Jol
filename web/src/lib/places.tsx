import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { loadPlaces } from './data'
import type { Place } from './types'

interface PlacesState {
  places: Place[]
  loading: boolean
  error: boolean
}

const Ctx = createContext<PlacesState>({ places: [], loading: true, error: false })

export function PlacesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlacesState>({ places: [], loading: true, error: false })
  useEffect(() => {
    loadPlaces()
      .then((places) => setState({ places, loading: false, error: false }))
      .catch(() => setState({ places: [], loading: false, error: true }))
  }, [])
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export const usePlaces = () => useContext(Ctx)
