// Значения совпадают с enum в db/schema.sql

export const STATUSES = ['accessible', 'partial', 'inaccessible', 'unknown'] as const
export type Status = (typeof STATUSES)[number]

export const CATEGORIES = ['pharmacy', 'cafe', 'government', 'clinic', 'school', 'shop', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

export type Steps = 'none' | 'one' | 'many' | 'unknown'
export type Ramp = 'good' | 'bad' | 'none' | 'unknown'
export type Tri = 'yes' | 'no' | 'unknown'

export interface Features {
  steps: Steps
  ramp: Ramp
  doorWide: Tri
  callButton: Tri
  toilet: Tri
  rampSlopePct: number | null
  /** Что ещё есть у входа (необязательный шаг отчёта) */
  extras: Extra[]
}

export const EXTRAS = ['parking', 'elevator', 'tactile'] as const
export type Extra = (typeof EXTRAS)[number]

export interface Place {
  id: number
  name: string
  category: Category
  lat: number
  lon: number
  status: Status
  score: number | null
  reportsCount: number
  isVerified: boolean
  lastCheckedAt: string | null
  /** Ответы последнего отчёта; null, если у входа ещё никто не был */
  features: Features | null
  /** Заметка волонтёра: «вход со двора» */
  comment: string | null
}
