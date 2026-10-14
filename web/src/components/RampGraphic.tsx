export type Zone = 'gentle' | 'moderate' | 'steep'

/**
 * Границы зон в процентах. По СП РК 3.06-101-2012 (в изложении Минтруда РК) уклон пандуса —
 * не круче 5% (1:20), до 8% (1:12) — только в стеснённых условиях при подъёме до 0,8 м.
 */
export const GENTLE_MAX = 5
export const MODERATE_MAX = 8

export function zoneOf(pct: number): Zone {
  return pct <= GENTLE_MAX ? 'gentle' : pct <= MODERATE_MAX ? 'moderate' : 'steep'
}

export const ZONE_STATUS = { gentle: 'accessible', moderate: 'partial', steep: 'inaccessible' } as const

const RUN = 250
const X0 = 30
const GROUND = 150

/** Пандус в настоящем масштабе: подъём на рисунке равен измеренному уклону. */
export function RampGraphic({ pct }: { pct: number }) {
  const shown = Math.min(Math.max(pct, 0), 40)
  const rise = (RUN * shown) / 100
  const angle = (Math.atan(shown / 100) * 180) / Math.PI
  const top = GROUND - rise
  const color = `var(--st-${ZONE_STATUS[zoneOf(pct)]})`
  // телефон лежит на середине пандуса
  const mx = X0 + RUN * 0.45
  const my = GROUND - rise * 0.45

  return (
    <svg className="ramp" viewBox="0 40 340 122" aria-hidden="true">
      <line x1="8" y1={GROUND} x2="332" y2={GROUND} stroke="var(--line)" strokeWidth="2" />
      {/* площадка и дверь */}
      <rect x={X0 + RUN} y={top} width="52" height={rise + 0.01} fill="var(--surface-2)" />
      <rect x={X0 + RUN + 12} y={top - 58} width="30" height="58" rx="3" fill="none"
            stroke="var(--ink-2)" strokeWidth="2" />
      <circle cx={X0 + RUN + 19} cy={top - 28} r="2" fill="var(--ink-2)" />
      {/* сам пандус */}
      <polygon points={`${X0},${GROUND} ${X0 + RUN},${GROUND} ${X0 + RUN},${top}`}
               fill={color} opacity="0.2" />
      <line x1={X0} y1={GROUND} x2={X0 + RUN} y2={top} stroke={color} strokeWidth="4" strokeLinecap="round" />
      {/* угол */}
      <path d={`M${X0 + 46} ${GROUND} A46 46 0 0 0 ${X0 + 46 * Math.cos((angle * Math.PI) / 180)} ${
              GROUND - 46 * Math.sin((angle * Math.PI) / 180)}`}
            fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="3 3" />
      {/* телефон */}
      <g transform={`translate(${mx} ${my}) rotate(${-angle})`}>
        <rect x="-34" y="-11" width="68" height="9" rx="3.5" fill="var(--ink)" />
        <rect x="-29" y="-9.2" width="58" height="2.2" rx="1.1" fill="var(--brand)" />
      </g>
    </svg>
  )
}
