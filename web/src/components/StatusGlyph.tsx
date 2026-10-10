import { usePrefs } from '../lib/prefs'
import type { Status } from '../lib/types'

// Каждый статус — своя форма и свой символ, чтобы знак читался без цвета:
// круг с галочкой, ромб с волной, восьмиугольник с крестом, пунктирный круг с вопросом.
const MARKUP: Record<Status, string> = {
  accessible:
    '<circle class="shape" cx="12" cy="12" r="10"/><path class="mark" d="M7.4 12.4l3.1 3.1 6.1-6.6"/>',
  partial:
    '<rect class="shape" x="4.4" y="4.4" width="15.2" height="15.2" rx="2.6" transform="rotate(45 12 12)"/>' +
    '<path class="mark" d="M7.6 12.7c1.5-1.9 2.9-1.9 4.4-.7s2.9 1.2 4.4-.7"/>',
  inaccessible:
    '<polygon class="shape" stroke-width="2" points="8.4,3 15.6,3 21,8.4 21,15.6 15.6,21 8.4,21 3,15.6 3,8.4"/>' +
    '<path class="mark" d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"/>',
  unknown:
    '<circle class="shape" cx="12" cy="12" r="9"/>' +
    '<path class="mark" d="M9.7 9.6a2.4 2.4 0 1 1 3.5 2.2c-.8.5-1.2 1-1.2 1.8"/><circle class="dot" cx="12" cy="16.7" r="1.2"/>',
}

/** Строка SVG — для маркеров Leaflet, которые рисуются вне React */
export function glyphSvg(status: Status, size: number): string {
  return `<svg class="glyph glyph--${status}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${MARKUP[status]}</svg>`
}

export function StatusGlyph({ status, size = 24 }: { status: Status; size?: number }) {
  return (
    <svg
      className={`glyph glyph--${status}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: MARKUP[status] }}
    />
  )
}

export function StatusBadge({ status, large = false }: { status: Status; large?: boolean }) {
  const { t } = usePrefs()
  return (
    <span className={`badge badge--${status}${large ? ' badge--lg' : ''}`}>
      <StatusGlyph status={status} size={large ? 26 : 20} />
      {t.status[status]}
    </span>
  )
}
