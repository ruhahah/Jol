import type { Features, Status } from './types'

/** То же правило, что в bot/scoring.py: цвет зависит только от входа. */
export function reportStatus(f: Pick<Features, 'steps' | 'ramp' | 'doorWide'>): Status {
  if (f.steps === 'unknown') return 'unknown'
  if (f.doorWide === 'no' || (f.steps === 'many' && f.ramp === 'none')) return 'inaccessible'
  const stepFree = f.steps === 'none' || f.ramp === 'good'
  if (stepFree && f.doorWide === 'yes') return 'accessible'
  return 'partial'
}
