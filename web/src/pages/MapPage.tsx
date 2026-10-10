import {
  Accessibility, Baby, BadgeCheck, ChevronDown, ChevronUp, Coffee, Footprints, GraduationCap, Landmark,
  LocateFixed, MapPin, Pill, Search, Send, ShoppingBag, Stethoscope, X, type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { MapView, type MapBounds } from '../components/MapView'
import { ago, PlaceDetail } from '../components/PlaceDetail'
import { StatusGlyph } from '../components/StatusGlyph'
import { BOT_USERNAME, IS_DEMO } from '../lib/data'
import { distanceM } from '../lib/geo'
import { usePlaces } from '../lib/places'
import { usePrefs } from '../lib/prefs'
import { PROFILES, statusFor, type Profile } from '../lib/profiles'
import { navigate } from '../lib/router'
import { CATEGORIES, STATUSES, type Category, type Place, type Status } from '../lib/types'
import '../styles/map.css'

const CATEGORY_ICON: Record<Category, LucideIcon> = {
  pharmacy: Pill,
  cafe: Coffee,
  government: Landmark,
  clinic: Stethoscope,
  school: GraduationCap,
  shop: ShoppingBag,
  other: MapPin,
}

const PROFILE_ICON: Record<Profile, LucideIcon> = {
  wheelchair: Accessibility,
  stroller: Baby,
  walker: Footprints,
}

const STATUS_RANK: Record<Status, number> = { accessible: 0, partial: 1, inaccessible: 2, unknown: 3 }

/** Сколько строк списка рисуем за раз: мест тысячи, а читать больше экрана-двух никто не будет */
const LIST_LIMIT = 60

export function MapPage({ placeId }: { placeId: number | null }) {
  const { t, profile, setProfile } = usePrefs()
  const { places: rawPlaces, loading, error } = usePlaces()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [only, setOnly] = useState<Set<Status>>(new Set()) // пусто = показывать все статусы
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [userPos, setUserPos] = useState<[number, number] | null>(null)
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [bounds, setBounds] = useState<MapBounds | null>(null)

  // Статус каждого места — с точки зрения выбранного способа передвижения
  const places = useMemo(
    () => (profile === 'wheelchair' ? rawPlaces : rawPlaces.map((p) => ({ ...p, status: statusFor(p, profile) }))),
    [rawPlaces, profile],
  )

  const selected = places.find((p) => p.id === placeId) ?? null

  const distanceLabel = (p: Place): string | null => {
    if (!userPos) return null
    const m = distanceM(userPos, [p.lat, p.lon])
    return m < 1000 ? t.place.m(Math.round(m / 10) * 10) : t.place.km((m / 1000).toFixed(1))
  }

  // Всё, кроме фильтра по статусу — по этому набору считаются счётчики на кнопках статусов
  const base = useMemo(() => {
    const q = query.trim().toLowerCase()
    return places.filter(
      (p) =>
        (category === 'all' || p.category === category) &&
        (!verifiedOnly || p.isVerified) &&
        (!q || p.name.toLowerCase().includes(q)),
    )
  }, [places, query, category, verifiedOnly])

  const counts = useMemo(() => {
    const result: Record<Status, number> = { accessible: 0, partial: 0, inaccessible: 0, unknown: 0 }
    for (const p of base) result[p.status]++
    return result
  }, [base])

  const visible = useMemo(() => base.filter((p) => only.size === 0 || only.has(p.status)), [base, only])

  // Выбранное место остаётся на карте, даже если фильтры его скрыли
  const onMap = useMemo(
    () => (selected && !visible.includes(selected) ? [...visible, selected] : visible),
    [visible, selected],
  )

  // В списке — только то, что сейчас видно на карте
  const inView = useMemo(() => {
    const list = bounds
      ? visible.filter((p) => p.lat >= bounds.south && p.lat <= bounds.north &&
                              p.lon >= bounds.west && p.lon <= bounds.east)
      : visible
    return [...list].sort((a, b) =>
      userPos
        ? distanceM(userPos, [a.lat, a.lon]) - distanceM(userPos, [b.lat, b.lon])
        : STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          Number(b.isVerified) - Number(a.isVerified) ||
          a.name.localeCompare(b.name),
    )
  }, [visible, bounds, userPos])

  const filtered = query !== '' || category !== 'all' || only.size > 0 || verifiedOnly
  const reset = () => {
    setQuery('')
    setCategory('all')
    setOnly(new Set())
    setVerifiedOnly(false)
  }

  const toggleStatus = (s: Status) => {
    const next = new Set(only)
    if (!next.delete(s)) next.add(s)
    setOnly(next)
  }

  const locate = () => {
    if (!navigator.geolocation) return setLocError(true)
    setLocating(true)
    setLocError(false)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserPos([pos.coords.latitude, pos.coords.longitude])
        setLocating(false)
      },
      () => {
        setLocError(true)
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  const open = sheetOpen || selected !== null

  return (
    <div className={`mapapp${open ? ' is-open' : ''}`}>
      <aside className="panel">
        <button type="button" className="panel__handle" aria-expanded={open}
                onClick={() => (selected ? navigate('map') : setSheetOpen(!sheetOpen))}>
          <span className="panel__grip" aria-hidden="true" />
          {open ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          {selected ? t.ui.close : open ? t.map.hideList : `${t.map.showList} · ${inView.length}`}
        </button>

        {selected ? (
          <div className="panel__scroll">
            <PlaceDetail place={selected} distance={distanceLabel(selected)} />
          </div>
        ) : (
          <>
            <div className="filters">
              <label className="search">
                <Search size={19} aria-hidden="true" />
                <span className="sr-only">{t.map.search}</span>
                <input type="search" value={query} placeholder={t.map.search}
                       onChange={(e) => setQuery(e.target.value)} onFocus={() => setSheetOpen(true)} />
              </label>

              <div className="chips" role="group" aria-label={t.map.categories}>
                <button type="button" className="chip" aria-pressed={category === 'all'}
                        onClick={() => setCategory('all')}>
                  {t.cat.all}
                </button>
                {CATEGORIES.map((c) => {
                  const Icon = CATEGORY_ICON[c]
                  return (
                    <button key={c} type="button" className="chip" aria-pressed={category === c}
                            onClick={() => setCategory(c)}>
                      <Icon size={16} /> {t.cat[c]}
                    </button>
                  )
                })}
              </div>

              <div className="profile">
                <span className="profile__title" id="profile-title">{t.profile.title}</span>
                <div className="profile__seg" role="group" aria-labelledby="profile-title">
                  {PROFILES.map((p) => {
                    const Icon = PROFILE_ICON[p]
                    return (
                      <button key={p} type="button" aria-pressed={profile === p} title={t.profile[p]}
                              aria-label={t.profile[p]} onClick={() => setProfile(p)}>
                        <Icon size={17} aria-hidden="true" /> {t.profile[`${p}Short`]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="statuses" role="group" aria-label={t.map.statusFilter}>
                {STATUSES.map((s) => (
                  <button key={s} type="button" className="status-btn" aria-pressed={only.has(s)}
                          onClick={() => toggleStatus(s)}>
                    <StatusGlyph status={s} size={22} />
                    <span>{t.status[s]}</span>
                    <strong>{counts[s]}</strong>
                  </button>
                ))}
              </div>

              <label className="switch">
                <input type="checkbox" checked={verifiedOnly}
                       onChange={(e) => setVerifiedOnly(e.target.checked)} />
                <span className="switch__track" aria-hidden="true" />
                <BadgeCheck size={18} aria-hidden="true" /> {t.map.verifiedOnly}
              </label>
            </div>

            <div className="panel__scroll">
              <div className="list__head" aria-live="polite">
                <span>
                  {loading ? t.ui.loading : t.map.inView(inView.length, visible.length)}
                  {userPos && !loading && <small> · {t.map.nearestFirst}</small>}
                </span>
                {filtered && (
                  <button type="button" className="link-btn" onClick={reset}>
                    <X size={15} /> {t.map.reset}
                  </button>
                )}
              </div>

              {error && <p className="list__msg">{t.ui.loadError}</p>}
              {!loading && !error && visible.length === 0 && (
                places.length > 0 ? (
                  <p className="list__msg">{t.map.empty}</p>
                ) : (
                  <div className="list__msg">
                    <p>{t.map.noPlaces}</p>
                    {BOT_USERNAME && (
                      <a className="btn btn--primary btn--sm" target="_blank" rel="noreferrer"
                         href={`https://t.me/${BOT_USERNAME}`}>
                        <Send size={16} /> {t.hero.ctaBot}
                      </a>
                    )}
                  </div>
                )
              )}

              <ul className="list">
                {inView.slice(0, LIST_LIMIT).map((p) => {
                  const Icon = CATEGORY_ICON[p.category]
                  const dist = distanceLabel(p)
                  return (
                    <li key={p.id}>
                      <a className="row" href={`#/map/${p.id}`}>
                        <StatusGlyph status={p.status} size={30} />
                        <span className="row__main">
                          <span className="row__name">
                            {p.name}
                            {p.isVerified && <BadgeCheck size={16} className="row__tick" aria-label={t.place.checked} />}
                          </span>
                          <span className="row__meta">
                            <Icon size={14} aria-hidden="true" />
                            {t.status[p.status]}
                            {dist ? ` · ${dist}` : p.lastCheckedAt ? ` · ${ago(t, p.lastCheckedAt)}` : ''}
                          </span>
                        </span>
                      </a>
                    </li>
                  )
                })}
              </ul>

              {inView.length > LIST_LIMIT && <p className="list__more">{t.map.capped(LIST_LIMIT)}</p>}
              {IS_DEMO && <p className="list__demo">{t.ui.demoHint}</p>}
            </div>
          </>
        )}
      </aside>

      <div className="mapwrap">
        <MapView places={onMap} selected={selected} userPos={userPos}
                 onSelect={(id) => navigate(`map/${id}`)} onBounds={setBounds} />
        <div className="mapwrap__top">
          {IS_DEMO && <span className="demo-pill" title={t.ui.demoHint}>{t.ui.demo}</span>}
          <button type="button" className="map-btn" onClick={locate} disabled={locating}
                  aria-label={t.map.locate} title={t.map.locate}>
            <LocateFixed size={20} className={locating ? 'is-spinning' : ''} />
          </button>
        </div>
        {locError && (
          <p className="map-toast" role="alert">
            {t.map.locateError}
            <button type="button" className="icon-btn" aria-label={t.ui.close} onClick={() => setLocError(false)}>
              <X size={16} />
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
