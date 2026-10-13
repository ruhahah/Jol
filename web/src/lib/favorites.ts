import { useSyncExternalStore } from 'react'

// Избранные места хранятся только в браузере посетителя: без регистрации и без сервера.

const KEY = 'jol:favs'
const listeners = new Set<() => void>()

function read(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]') as number[])
  } catch {
    return new Set()
  }
}

let favorites = read()

export function toggleFavorite(id: number) {
  const next = new Set(favorites)
  if (!next.delete(id)) next.add(id)
  favorites = next // новый объект — чтобы React заметил изменение
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* приватный режим — избранное проживёт до закрытия вкладки */
  }
  listeners.forEach((notify) => notify())
}

export function useFavorites(): Set<number> {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => favorites,
  )
}
