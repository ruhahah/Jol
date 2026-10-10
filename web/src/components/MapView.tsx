import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { SHYMKENT } from '../lib/data'
import { usePrefs } from '../lib/prefs'
import type { Place } from '../lib/types'
import { glyphSvg } from './StatusGlyph'

const TICK =
  '<svg class="pin__tick" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6"/><path d="M3.3 6.2l1.9 1.9 3.5-3.9"/></svg>'

const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

interface Props {
  places: Place[]
  selected: Place | null
  userPos: [number, number] | null
  onSelect: (id: number) => void
}

export function MapView({ places, selected, userPos, onSelect }: Props) {
  const { t, theme } = usePrefs()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const markers = useRef<L.LayerGroup | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false }).setView(SHYMKENT, 13)
    L.control.zoom({ position: 'bottomright' }).addTo(m)
    m.attributionControl.setPrefix(false)
    markers.current = L.layerGroup().addTo(m)
    map.current = m
    // Тайлы OpenStreetMap не требуют ключа; тёмная тема делается CSS-фильтром (см. map.css)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m)
    const observer = new ResizeObserver(() => m.invalidateSize())
    observer.observe(el.current!)
    return () => {
      observer.disconnect()
      m.remove()
    }
  }, [])

  const selectedId = selected?.id ?? null

  useEffect(() => {
    const group = markers.current!
    group.clearLayers()
    for (const p of places) {
      const isSelected = p.id === selectedId
      const size = isSelected ? 46 : 32
      const icon = L.divIcon({
        className: `pin${isSelected ? ' pin--selected' : ''}`,
        html: glyphSvg(p.status, size) + (p.isVerified ? TICK : ''),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      })
      L.marker([p.lat, p.lon], {
        icon,
        title: `${p.name} — ${t.status[p.status]}`,
        zIndexOffset: isSelected ? 1000 : p.status === 'unknown' ? -200 : 0,
      })
        .on('click', () => onSelectRef.current(p.id))
        .addTo(group)
    }
  }, [places, selectedId, t])

  useEffect(() => {
    const m = map.current!
    if (!selected) return
    const zoom = Math.max(m.getZoom(), 16)
    let target = L.latLng(selected.lat, selected.lon)
    // На телефоне нижняя панель закрывает часть карты — сдвигаем точку в видимую часть
    if (matchMedia('(max-width: 860px)').matches) {
      target = m.unproject(m.project(target, zoom).add([0, m.getSize().y * 0.27]), zoom)
    }
    move(m, target, zoom)
  }, [selectedId])

  useEffect(() => {
    const m = map.current!
    if (!userPos) return
    const dot = L.circleMarker(userPos, {
      radius: 9, color: '#fff', weight: 3, fillColor: '#1f4fd8', fillOpacity: 1, interactive: false,
    }).addTo(m)
    const halo = L.circle(userPos, { radius: 60, stroke: false, fillColor: '#1f4fd8', fillOpacity: 0.15,
                                     interactive: false }).addTo(m)
    move(m, L.latLng(userPos), Math.max(m.getZoom(), 16))
    return () => {
      dot.remove()
      halo.remove()
    }
  }, [userPos])

  return <div ref={el} className={`map map--${theme}`} role="application" aria-label={t.map.mapLabel} />
}

function move(m: L.Map, target: L.LatLng, zoom: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) m.setView(target, zoom)
  else m.flyTo(target, zoom, { duration: 0.6 })
}
