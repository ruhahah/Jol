import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { useEffect, useRef } from 'react'
import { SHYMKENT } from '../lib/data'
import { usePrefs } from '../lib/prefs'
import { STATUSES, type Place, type Status } from '../lib/types'
import { glyphSvg } from './StatusGlyph'

const TICK =
  '<svg class="pin__tick" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6"/><path d="M3.3 6.2l1.9 1.9 3.5-3.9"/></svg>'

const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/** Начиная с этого масштаба знаки не группируются — каждый вход виден отдельно */
const UNCLUSTER_ZOOM = 17

export interface MapBounds {
  south: number
  west: number
  north: number
  east: number
}

interface Props {
  places: Place[]
  selected: Place | null
  userPos: [number, number] | null
  onSelect: (id: number) => void
  onBounds: (bounds: MapBounds) => void
}

type StatusMarker = L.Marker & { options: L.MarkerOptions & { status: Status } }

function pinIcon(place: Place, selected: boolean): L.DivIcon {
  const size = selected ? 46 : 32
  return L.divIcon({
    className: `pin${selected ? ' pin--selected' : ''}`,
    html: glyphSvg(place.status, size) + (place.isVerified ? TICK : ''),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

/** Группа знаков: число в центре и кольцо, показывающее доли статусов внутри */
function clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const counts: Record<Status, number> = { accessible: 0, partial: 0, inaccessible: 0, unknown: 0 }
  for (const marker of cluster.getAllChildMarkers() as StatusMarker[]) counts[marker.options.status]++
  const total = cluster.getChildCount()
  let from = 0
  const stops = STATUSES.filter((s) => counts[s] > 0).map((s) => {
    const to = from + (counts[s] / total) * 100
    const stop = `var(--st-${s}) ${from}% ${to}%`
    from = to
    return stop
  })
  const size = total < 10 ? 38 : total < 100 ? 46 : 54
  return L.divIcon({
    className: 'cluster',
    html: `<span class="cluster__ring" style="background:conic-gradient(${stops.join(',')})"></span><span class="cluster__n">${total}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

export function MapView({ places, selected, userPos, onSelect, onBounds }: Props) {
  const { t, theme } = usePrefs()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const markers = useRef<L.MarkerClusterGroup | null>(null)
  const onSelectRef = useRef(onSelect)
  const onBoundsRef = useRef(onBounds)
  onSelectRef.current = onSelect
  onBoundsRef.current = onBounds

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false }).setView(SHYMKENT, 13)
    L.control.zoom({ position: 'bottomright' }).addTo(m)
    m.attributionControl.setPrefix(false)
    // Тайлы OpenStreetMap не требуют ключа; тёмная тема делается CSS-фильтром (см. map.css)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m)
    markers.current = L.markerClusterGroup({
      maxClusterRadius: 50,
      disableClusteringAtZoom: UNCLUSTER_ZOOM,
      showCoverageOnHover: false,
      chunkedLoading: true,
      iconCreateFunction: clusterIcon,
    }).addTo(m)
    map.current = m

    const reportBounds = () => {
      const b = m.getBounds()
      onBoundsRef.current({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })
    }
    m.on('moveend', reportBounds)
    reportBounds()
    const observer = new ResizeObserver(() => m.invalidateSize())
    observer.observe(el.current!)
    return () => {
      observer.disconnect()
      m.remove()
    }
  }, [])

  useEffect(() => {
    const group = markers.current!
    group.clearLayers()
    group.addLayers(
      places.map((p) =>
        L.marker([p.lat, p.lon], {
          icon: pinIcon(p, false),
          title: `${p.name} — ${t.status[p.status]}`,
          status: p.status,
        } as L.MarkerOptions).on('click', () => onSelectRef.current(p.id)),
      ),
    )
  }, [places, t])

  // Выбранное место рисуем отдельным крупным знаком поверх всего, вне группировки
  const selectedId = selected?.id ?? null
  const selectedStatus = selected?.status
  useEffect(() => {
    const m = map.current!
    if (!selected) return
    const marker = L.marker([selected.lat, selected.lon], {
      icon: pinIcon(selected, true),
      title: selected.name,
      zIndexOffset: 2000,
      interactive: false,
    }).addTo(m)
    return () => {
      marker.remove()
    }
  }, [selectedId, selectedStatus])

  useEffect(() => {
    const m = map.current!
    if (!selected) return
    const zoom = Math.max(m.getZoom(), UNCLUSTER_ZOOM)
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
