import { ArrowLeft, Printer } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { Logo } from '../components/Header'
import { StatusBadge } from '../components/StatusGlyph'
import { BOT_USERNAME } from '../lib/data'
import { usePlaces } from '../lib/places'
import { usePrefs } from '../lib/prefs'
import '../styles/sticker.css'

/** Лист для печати: QR-код ведёт в бота сразу к отчёту по этому месту. */
export function StickerPage({ placeId }: { placeId: number | null }) {
  const { t } = usePrefs()
  const { places, loading } = usePlaces()
  const [qr, setQr] = useState('')
  const place = places.find((p) => p.id === placeId) ?? null

  // Без бота код ведёт на карточку места на сайте
  const target = place
    ? BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=place_${place.id}`
      : `${location.origin}/#/map/${place.id}`
    : ''

  useEffect(() => {
    if (!target) return
    QRCode.toString(target, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(setQr)
  }, [target])

  if (!place) {
    return <p className="sticker-msg container">{loading ? t.ui.loading : t.sticker.notFound}</p>
  }

  return (
    <div className="sticker-page container">
      <div className="sticker-tools">
        <a className="btn btn--ghost btn--sm" href={`#/map/${place.id}`}>
          <ArrowLeft size={16} /> {t.sticker.back}
        </a>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => window.print()}>
          <Printer size={16} /> {t.sticker.print}
        </button>
      </div>

      {/* Лист всегда светлый: его печатают на белой бумаге */}
      <article className="sticker">
        <p className="sticker__brand"><Logo /> jol</p>
        <h1>{t.sticker.title}</h1>
        <div className="sticker__qr" role="img" aria-label={target} dangerouslySetInnerHTML={{ __html: qr }} />
        <p className="sticker__text">{t.sticker.text}</p>
        <div className="sticker__place">
          <strong>{place.name}</strong>
          <span>{t.sticker.now} <StatusBadge status={place.status} /></span>
        </div>
        <p className="sticker__footer">{t.sticker.footer} · {location.host}</p>
      </article>
    </div>
  )
}
