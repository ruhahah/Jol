import { Download, Medal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { StatusGlyph } from '../components/StatusGlyph'
import { IS_DEMO, loadLeaders, type Leader } from '../lib/data'
import { usePlaces } from '../lib/places'
import { usePrefs } from '../lib/prefs'
import { CATEGORIES, type Category, type Place, type Status } from '../lib/types'
import '../styles/stats.css'

/** Статусы, у которых есть оценка (без «нет данных») — в порядке от лучшего к худшему */
const RATED = ['accessible', 'partial', 'inaccessible'] as const
/** Очки, с которых начинается уровень; те же пороги, что LEVELS в bot/main.py */
const LEVEL_POINTS = [0, 30, 100, 300]

interface Row {
  category: Category
  total: number
  described: number
  counts: Record<Status, number>
}

function buildRows(places: Place[]): Row[] {
  return CATEGORIES.map((category) => {
    const counts: Record<Status, number> = { accessible: 0, partial: 0, inaccessible: 0, unknown: 0 }
    let total = 0
    for (const p of places) {
      if (p.category !== category) continue
      total++
      counts[p.status]++
    }
    return { category, total, described: total - counts.unknown, counts }
  })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.described - a.described || b.total - a.total)
}

function downloadCsv(places: Place[]) {
  const cell = (v: string | number | boolean | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [
    ['id', 'name', 'category', 'lat', 'lon', 'status', 'verified', 'reports', 'last_checked'].join(';'),
    ...places.map((p) =>
      [p.id, p.name, p.category, p.lat, p.lon, p.status, p.isVerified, p.reportsCount, p.lastCheckedAt]
        .map(cell).join(';'),
    ),
  ]
  // BOM в начале — чтобы Excel правильно прочитал кириллицу и казахские буквы
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'jol-places.csv'
  link.click()
  URL.revokeObjectURL(link.href)
}

export function StatsPage() {
  const { t } = usePrefs()
  const s = t.stats2
  const { places, loading, error } = usePlaces()
  const [leaders, setLeaders] = useState<Leader[] | null>(null)

  useEffect(() => {
    loadLeaders().then(setLeaders).catch(() => setLeaders([]))
  }, [])

  const rows = useMemo(() => buildRows(places), [places])
  const total = places.length
  const described = places.filter((p) => p.status !== 'unknown').length
  const tiles: [number, string][] = [
    [total, s.places],
    [described, s.described],
    [places.filter((p) => p.isVerified).length, s.verified],
    [places.reduce((sum, p) => sum + p.reportsCount, 0), s.reports],
  ]
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0)

  return (
    <div className="stats-page container">
      <header className="stats-page__head">
        <h1>{s.title}</h1>
        <p>{s.lead}</p>
        {IS_DEMO && <span className="demo-pill" title={t.ui.demoHint}>{t.ui.demo}</span>}
      </header>

      {loading && <p className="stats-page__msg">{t.ui.loading}</p>}
      {error && <p className="stats-page__msg">{t.ui.loadError}</p>}

      {!loading && !error && (
        <>
          <dl className="kpis">
            {tiles.map(([value, label]) => (
              <div key={label} className="kpi">
                <dt>{label}</dt>
                <dd className="display">{value.toLocaleString('ru')}</dd>
              </div>
            ))}
          </dl>

          <section className="card" aria-labelledby="coverage-title">
            <h2 id="coverage-title">{s.coverage}</h2>
            <div className="meter" role="img"
                 aria-label={`${s.coverageOf(described, total)}, ${share(described, total)}%`}>
              <span style={{ width: `${total ? (described / total) * 100 : 0}%` }} />
            </div>
            <p className="meter__label">
              <strong>{share(described, total)}%</strong> · {s.coverageOf(described, total)}
            </p>
          </section>

          <section className="card" aria-labelledby="cat-title">
            <h2 id="cat-title">{s.byCategory}</h2>
            <p className="card__note">{s.byCategoryNote}</p>

            <ul className="legend">
              {RATED.map((st) => (
                <li key={st}><StatusGlyph status={st} size={18} /> {t.status[st]}</li>
              ))}
            </ul>

            <ul className="bars">
              {rows.map((r) => (
                <li key={r.category} className="bars__row">
                  <span className="bars__name">{t.cat[r.category]}</span>
                  <span className="bars__track">
                    {r.described === 0 ? (
                      <span className="bars__empty">{s.noReports}</span>
                    ) : (
                      RATED.filter((st) => r.counts[st] > 0).map((st) => (
                        <span key={st} className={`bars__seg bars__seg--${st}`} tabIndex={0}
                              style={{ flexGrow: r.counts[st] }}
                              data-tip={`${t.status[st]}: ${r.counts[st]} (${share(r.counts[st], r.described)}%)`}
                              aria-label={`${t.cat[r.category]}, ${t.status[st]}: ${r.counts[st]}`} />
                      ))
                    )}
                  </span>
                  <span className="bars__meta">{s.describedOf(r.described, r.total)}</span>
                </li>
              ))}
            </ul>

            <details className="table-toggle">
              <summary>{s.table}</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{s.category}</th>
                      <th scope="col">{s.total}</th>
                      {RATED.map((st) => <th key={st} scope="col">{t.status[st]}</th>)}
                      <th scope="col">{t.status.unknown}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.category}>
                        <th scope="row">{t.cat[r.category]}</th>
                        <td>{r.total}</td>
                        {RATED.map((st) => <td key={st}>{r.counts[st]}</td>)}
                        <td>{r.counts.unknown}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <div className="export">
              <button type="button" className="btn btn--ghost" onClick={() => downloadCsv(places)}>
                <Download size={18} /> {s.exportCsv}
              </button>
              <span>{s.exportNote}</span>
            </div>
          </section>

          {!IS_DEMO && (
            <section className="card" aria-labelledby="leaders-title">
              <h2 id="leaders-title">{s.leaders}</h2>
              {leaders && leaders.length > 0 ? (
                <>
                  <ol className="leaders">
                    {leaders.map((l, i) => {
                      const level = LEVEL_POINTS.filter((p) => l.points >= p).length - 1
                      return (
                        <li key={l.id}>
                          <span className={`leaders__rank${i < 3 ? ' is-top' : ''}`}>
                            {i < 3 ? <Medal size={18} aria-hidden="true" /> : null}
                            {i + 1}
                          </span>
                          <span className="leaders__name">
                            {l.name ?? s.anon(l.id)}
                            <small>{s.levels[level]}</small>
                          </span>
                          <span className="leaders__num"><strong>{l.points}</strong> {s.points}</span>
                          <span className="leaders__num"><strong>{l.reportsCount}</strong> {s.contributions}</span>
                        </li>
                      )
                    })}
                  </ol>
                  <p className="card__note">{s.leadersNote}</p>
                </>
              ) : (
                <p className="card__note">{leaders ? s.leadersEmpty : t.ui.loading}</p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
