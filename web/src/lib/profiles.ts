import type { Place, Status } from './types'

// Один и тот же вход по-разному проходим для разных людей: ступенька — мелочь для детской
// коляски и барьер для инвалидной. Правила ниже — осознанное упрощение, их стоит уточнять
// вместе с теми, кто так передвигается.

export const PROFILES = ['wheelchair', 'stroller', 'walker'] as const
export type Profile = (typeof PROFILES)[number]

export function statusFor(place: Place, profile: Profile): Status {
  // Инвалидная коляска — основная оценка: её считает сервер по всем отчётам сразу
  if (profile === 'wheelchair') return place.status

  // Для остальных пересчитываем по ответам последнего отчёта
  const f = place.features
  if (!f || f.steps === 'unknown') return 'unknown'
  const fewSteps = f.steps === 'none' || f.steps === 'one'

  if (profile === 'stroller') {
    // Одну ступеньку коляска проходит; лестницу без пандуса — только с чьей-то помощью.
    // Узкая дверь мешает, но детская коляска уже инвалидной, поэтому это «частично».
    const easy = fewSteps || f.ramp === 'good'
    return easy && f.doorWide !== 'no' ? 'accessible' : 'partial'
  }

  // Ходунки или трость: ширина двери не важна, а каждая ступенька и крутой пандус — риск
  if (f.steps === 'none' || f.ramp === 'good') return 'accessible'
  if (f.steps === 'many' && f.ramp === 'none') return 'inaccessible'
  return 'partial'
}
