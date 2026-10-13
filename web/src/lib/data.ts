import { reportStatus } from './scoring'
import type { Category, Features, Place, Ramp, Steps, Tri } from './types'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME as string | undefined) || null
export const IS_DEMO = !(SUPABASE_URL && SUPABASE_KEY)
export const SHYMKENT: [number, number] = [42.3265, 69.5965]

/**
 * Запрос к публичным представлениям Supabase (db/public_api.sql).
 * Публичный ключ передаётся в адресе, а не в заголовках: запрос без своих заголовков
 * браузер отправляет сразу, без предварительного CORS-запроса — это экономит один
 * поход на сервер. Ключ и так виден всем в коде сайта, секретом он не является.
 */
async function api(view: string, query: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${view}?${query}&apikey=${SUPABASE_KEY}`)
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return res.json()
}

export interface Summary {
  total: number
  accessible: number
  partial: number
  inaccessible: number
  unknown: number
  verified: number
  reports: number
}

/** Числа для главной страницы: одна строка вместо загрузки всего списка мест */
export async function loadSummary(): Promise<Summary> {
  if (!IS_DEMO) return (await api('places_summary_public', 'select=*'))[0] as Summary
  const places = demoPlaces()
  const count = (status: Place['status']) => places.filter((p) => p.status === status).length
  return {
    total: places.length,
    accessible: count('accessible'),
    partial: count('partial'),
    inaccessible: count('inaccessible'),
    unknown: count('unknown'),
    verified: places.filter((p) => p.isVerified).length,
    reports: places.reduce((sum, p) => sum + p.reportsCount, 0),
  }
}

export async function loadPlaces(): Promise<Place[]> {
  if (IS_DEMO) return demoPlaces()
  // Supabase отдаёт не больше 1000 строк за запрос, поэтому читаем страницами.
  const PAGE = 1000
  const rows: Record<string, any>[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await api('places_public', `select=*&order=id&limit=${PAGE}&offset=${offset}`)
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    lat: r.lat,
    lon: r.lon,
    status: r.status,
    score: r.score,
    reportsCount: r.reports_count,
    isVerified: r.is_verified,
    lastCheckedAt: r.last_checked_at,
    features: r.steps
      ? {
          steps: r.steps,
          ramp: r.ramp,
          doorWide: r.door_wide,
          callButton: r.call_button,
          toilet: r.toilet,
          rampSlopePct: r.ramp_slope_pct === null ? null : Number(r.ramp_slope_pct),
        }
      : null,
    comment: r.comment ?? null,
  }))
}

export interface Check {
  date: string
  status: Place['status']
  slopePct: number | null
}

/** Последние проверки места: дата, оценка и измеренный уклон. Кто проверял — не отдаётся. */
export async function loadHistory(placeId: number): Promise<Check[]> {
  if (IS_DEMO) return []
  const rows = await api('place_history_public', `select=*&place_id=eq.${placeId}&order=created_at.desc&limit=6`)
  return rows.map((r) => ({
    date: r.created_at,
    status: r.status,
    slopePct: r.ramp_slope_pct === null ? null : Number(r.ramp_slope_pct),
  }))
}

export interface Leader {
  id: number
  name: string | null
  points: number
  reportsCount: number
}

/** Рейтинг волонтёров (представление leaderboard_public). В демо-режиме рейтинга нет. */
export async function loadLeaders(): Promise<Leader[]> {
  if (IS_DEMO) return []
  const rows = await api('leaderboard_public', 'select=*')
  return rows.map((r) => ({ id: r.id, name: r.name, points: r.points, reportsCount: r.reports_count }))
}

// --- Демо-данные -------------------------------------------------------------------
// Вымышленные точки, чтобы карта не была пустой до запуска бота. Генератор
// детерминированный: при каждой загрузке получается один и тот же набор.

const ANCHORS: [string, number, number][] = [
  ['на Тауке хана', 42.3172, 69.5962],
  ['на Байтурсынова', 42.3338, 69.6018],
  ['на Кунаева', 42.3415, 69.6105],
  ['на Казыбек би', 42.3158, 69.5868],
  ['на Республики', 42.3402, 69.5905],
  ['на Туркестанской', 42.3121, 69.5815],
  ['на Абая', 42.3287, 69.5762],
  ['на Желтоксан', 42.3248, 69.6055],
  ['на Жибек жолы', 42.3085, 69.6190],
  ['в Нурсате', 42.3562, 69.6268],
]

const NAMES: Record<Category, string[]> = {
  pharmacy: ['Аптека'],
  cafe: ['Кафе', 'Кофейня', 'Чайхана', 'Столовая'],
  government: ['ЦОН', 'Отделение почты', 'Отдел занятости'],
  clinic: ['Поликлиника', 'Стоматология', 'Лаборатория'],
  school: ['Школа', 'Колледж', 'Библиотека'],
  shop: ['Супермаркет', 'Магазин у дома', 'Пекарня'],
  other: ['Банк', 'Парикмахерская', 'Фитнес-зал'],
}

const CATEGORY_WEIGHTS: [Category, number][] = [
  ['pharmacy', 20], ['cafe', 22], ['shop', 16], ['clinic', 13],
  ['government', 10], ['school', 10], ['other', 9],
]

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function demoPlaces(): Place[] {
  const rnd = mulberry32(2026)
  const pick = <T,>(weighted: [T, number][]): T => {
    let x = rnd() * weighted.reduce((sum, [, w]) => sum + w, 0)
    for (const [value, w] of weighted) if ((x -= w) < 0) return value
    return weighted[0][0]
  }
  const day = 86_400_000
  const places: Place[] = []

  for (let id = 1; id <= 72; id++) {
    const category = pick(CATEGORY_WEIGHTS)
    const [where, lat, lon] = ANCHORS[Math.floor(rnd() * ANCHORS.length)]
    const kinds = NAMES[category]
    const base: Pick<Place, 'id' | 'name' | 'category' | 'lat' | 'lon'> = {
      id,
      name: `${kinds[Math.floor(rnd() * kinds.length)]} ${where}`,
      category,
      lat: lat + (rnd() - 0.5) * 0.011,
      lon: lon + (rnd() - 0.5) * 0.015,
    }

    if (rnd() < 0.2) {
      places.push({ ...base, status: 'unknown', score: null, reportsCount: 0, isVerified: false,
                    lastCheckedAt: null, features: null, comment: null })
      continue
    }

    const steps = pick<Steps>([['none', 30], ['one', 30], ['many', 40]])
    const ramp: Ramp = steps === 'none' ? 'unknown' : pick<Ramp>([['good', 32], ['bad', 28], ['none', 40]])
    const features: Features = {
      steps,
      ramp,
      doorWide: pick<Tri>([['yes', 72], ['no', 7], ['unknown', 21]]),
      callButton: pick<Tri>([['yes', 25], ['no', 60], ['unknown', 15]]),
      toilet: pick<Tri>([['yes', 15], ['no', 50], ['unknown', 35]]),
      rampSlopePct: null,
    }
    if (ramp === 'good' && rnd() < 0.6) features.rampSlopePct = Math.round((4 + rnd() * 4) * 10) / 10
    if (ramp === 'bad' && rnd() < 0.6) features.rampSlopePct = Math.round((9 + rnd() * 8) * 10) / 10

    const status = reportStatus(features)
    const reportsCount = 1 + Math.floor(rnd() * 5)
    places.push({
      ...base,
      status,
      score: status === 'accessible' ? 100 : status === 'partial' ? 50 : 0,
      reportsCount,
      isVerified: reportsCount >= 2 && rnd() < 0.75,
      lastCheckedAt: new Date(Date.now() - Math.floor(1 + rnd() * rnd() * 420) * day).toISOString(),
      features,
      comment: id % 6 === 0 ? 'Вход со двора, звонок справа от двери' : null,
    })
  }
  return places
}
