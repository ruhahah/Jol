import type { Dict } from '../i18n/ru'
import { GENTLE_MAX } from '../components/RampGraphic'
import type { Place } from './types'

/**
 * Что владелец может улучшить у входа — по ответам последнего отчёта.
 * Это подсказки-ориентиры, а не заключение специалиста: точные требования нужно
 * сверять с действующими строительными нормами Казахстана.
 */
export function advice(place: Place, t: Dict): string[] {
  const f = place.features
  if (!f) return []
  const a = t.advice
  const tips: string[] = []
  const hasSteps = f.steps === 'one' || f.steps === 'many'
  const slope = f.rampSlopePct

  if (hasSteps && f.ramp === 'none') tips.push(a.noRamp)
  if (f.ramp === 'bad') tips.push(slope !== null ? a.rampBadMeasured(slope.toFixed(1)) : a.rampBad)
  // Пандус назвали удобным, но замер показал, что он круче нормы РК (5%)
  if (f.ramp === 'good' && slope !== null && slope > GENTLE_MAX) tips.push(a.rampSteep(slope.toFixed(1)))
  if (f.doorWide === 'no') tips.push(a.door)
  if (f.callButton !== 'yes' && place.status !== 'accessible') tips.push(a.callButton)
  if (f.toilet === 'no') tips.push(a.toilet)
  return tips
}
