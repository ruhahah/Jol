// Страница измерителя уклона умеет открываться внутри Telegram как мини-приложение:
// бот даёт кнопку со ссылкой вида https://сайт/?tg=1&lang=ru#/slope, а результат замера
// возвращается боту через sendData.

interface TgOrientation {
  beta: number // радианы
  gamma: number
  start(params: { refresh_rate?: number; need_absolute?: boolean }, callback?: (started: boolean) => void): void
  stop(): void
}

export interface TgWebApp {
  ready(): void
  expand(): void
  close(): void
  sendData(data: string): void
  isVersionAtLeast(version: string): boolean
  onEvent(event: string, handler: () => void): void
  offEvent(event: string, handler: () => void): void
  DeviceOrientation?: TgOrientation
}

const params = new URLSearchParams(location.search)

export const IN_TELEGRAM = params.get('tg') === '1'
export const URL_LANG = params.get('lang')

let loading: Promise<TgWebApp | null> | null = null

/** Подгружает скрипт Telegram только когда страница открыта из бота */
export function loadTelegram(): Promise<TgWebApp | null> {
  if (!IN_TELEGRAM) return Promise.resolve(null)
  loading ??= new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-web-app.js'
    script.onload = () => resolve((window as any).Telegram?.WebApp ?? null)
    script.onerror = () => resolve(null)
    document.head.append(script)
  })
  return loading
}
