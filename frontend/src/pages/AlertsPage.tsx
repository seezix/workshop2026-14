import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, DEVICE_ID, errorMessage } from '../api/client'
import type { Alert, AlertSource, AlertStatus, Severity } from '../api/types'
import { useAuth } from '../auth/context'
import { Empty, ErrorNote, PageTitle, SeverityPill } from '../components/ui'
import { ALERT_STATUS_LABELS, SEVERITY_LABELS, SOURCES, alertTitle, fmtTime, fmtWhen } from '../lib/format'
import { useApi, useNow } from '../lib/useApi'
import { useLive } from '../live/context'
import { useStreamEvent } from '../live/stream'

type StatusFilter = AlertStatus | 'all'
const PERIODS = { '24h': 1, '7d': 7, '30d': 30 } as const
type Period = keyof typeof PERIODS

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'open', label: 'Ouvertes' },
  { id: 'acknowledged', label: 'Acquittées' },
  { id: 'resolved', label: 'Résolues' },
  { id: 'all', label: 'Toutes' },
]

/** Valeur de details lisible (nombres en français, objets en JSON). */
function detailValue(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('fr-FR')
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** Capture jointe par vision.py, servie par le boîtier (proxy /video) et effacée après 24 h. */
function Snapshot({ name }: { name: string }) {
  const [missing, setMissing] = useState(false)
  if (missing) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-md bg-soft p-4 text-center text-[13px] text-muted">
        Capture {name} expirée ou indisponible (effacée après 24 h)
      </div>
    )
  }
  return (
    <figure className="m-0 flex flex-col gap-1">
      <a href={`/video/snapshots/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">
        <img
          src={`/video/snapshots/${encodeURIComponent(name)}`}
          alt="Capture de la caméra au moment de l'alerte"
          className="aspect-[4/3] w-full rounded-md bg-soft object-cover"
          onError={() => setMissing(true)}
        />
      </a>
      <figcaption className="text-[12px] text-muted">Capture · supprimée après 24 h</figcaption>
    </figure>
  )
}

export function AlertsPage() {
  const { can } = useAuth()
  const { upsertAlert } = useLive()
  const canOp = can('operator')
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<StatusFilter>('open')
  const [source, setSource] = useState<AlertSource | 'all'>('all')
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [period, setPeriod] = useState<Period>('24h')
  const [search, setSearch] = useState('')
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const freshTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const now = useNow(30_000)

  // Les filtres sont appliqués côté client : 500 alertes couvrent largement 30 jours.
  const all = useApi(() => api.get<Alert[]>('/alerts', { device_id: DEVICE_ID, limit: 500 }), [])
  useEffect(() => () => freshTimers.current.forEach(clearTimeout), [])

  const upsert = (a: Alert) => {
    if (a.device_id !== DEVICE_ID) return
    all.setData((prev) => [a, ...(prev ?? []).filter((x) => x.id !== a.id)])
  }
  useStreamEvent<Alert>('alert.created', (a) => {
    upsert(a)
    // Nouvelle ligne en haut, surbrillance 3 s.
    setFresh((s) => new Set(s).add(a.id))
    freshTimers.current.push(
      setTimeout(() => setFresh((s) => {
        const next = new Set(s)
        next.delete(a.id)
        return next
      }), 3_000),
    )
  })
  useStreamEvent<Alert>('alert.updated', (a) =>
    all.setData((prev) => prev?.map((x) => (x.id === a.id ? a : x))),
  )

  const inPeriod = useMemo(() => {
    const since = now - PERIODS[period] * 86_400_000
    return (all.data ?? []).filter((a) => new Date(a.last_seen_at).getTime() >= since)
  }, [all.data, period, now])

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { open: 0, acknowledged: 0, resolved: 0, all: inPeriod.length }
    for (const a of inPeriod) c[a.status]++
    return c
  }, [inPeriod])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inPeriod
      .filter((a) => status === 'all' || a.status === status)
      .filter((a) => source === 'all' || a.source === source)
      .filter((a) => severity === 'all' || a.severity === severity)
      .filter(
        (a) =>
          !q ||
          a.type.toLowerCase().includes(q) ||
          alertTitle(a.type).toLowerCase().includes(q) ||
          (a.message ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
  }, [inPeriod, status, source, severity, search])

  const selectedId = params.get('id')
  const current = (all.data ?? []).find((a) => a.id === selectedId) ?? rows[0]
  const select = (id: string) => setParams({ id }, { replace: true })

  async function changeStatus(alert: Alert, next: 'acknowledged' | 'resolved') {
    setActionError(null)
    try {
      const updated = await api.patch<Alert>(`/alerts/${alert.id}`, { status: next })
      upsert(updated)
      upsertAlert(updated)
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  return (
    <>
      <PageTitle
        title="Alertes"
        subtitle="Tout ce qui demande une action humaine. Les doublons de moins de 10 s sont regroupés."
      />

      <div role="group" aria-label="Statut" className="flex flex-wrap gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn ${status === t.id ? 'btn-p' : ''}`}
            aria-pressed={status === t.id}
            onClick={() => setStatus(t.id)}
          >
            {t.label}
            {t.id !== 'all' && ` · ${counts[t.id]}`}
          </button>
        ))}
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <label className="fld flex-[2_1_220px]">
          Rechercher
          <input type="search" placeholder="Type, message…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="fld flex-[1_1_140px]">
          Source
          <select value={source} onChange={(e) => setSource(e.target.value as AlertSource | 'all')}>
            <option value="all">Toutes</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="fld flex-[1_1_140px]">
          Sévérité
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity | 'all')}>
            <option value="all">Toutes</option>
            {(['critical', 'warning', 'info'] as const).map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="fld flex-[1_1_140px]">
          Période
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="24h">24 dernières heures</option>
            <option value="7d">7 jours</option>
            <option value="30d">30 jours</option>
          </select>
        </label>
      </div>

      <ErrorNote message={all.error ?? actionError} />

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label="Liste des alertes" className="card flex-[3_1_600px] overflow-hidden p-0">
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="lbl grid min-h-10 grid-cols-[110px_minmax(0,1fr)_80px_150px_48px_100px] items-center gap-3 bg-head px-3">
                <span>Sévérité</span>
                <span>Alerte</span>
                <span>Source</span>
                <span>Survenue</span>
                <span>Nb</span>
                <span>Statut</span>
              </div>
              {rows.map((a) => {
                const selected = current?.id === a.id
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => select(a.id)}
                    aria-pressed={selected}
                    className={`row-sep grid min-h-14 w-full cursor-pointer grid-cols-[110px_minmax(0,1fr)_80px_150px_48px_100px] items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      fresh.has(a.id) ? 'bg-soft' : selected ? 'bg-selected' : 'bg-white hover:bg-page'
                    }`}
                  >
                    <span>
                      <SeverityPill severity={a.severity} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold">{alertTitle(a.type)}</span>
                      <span className="font-mono text-[11px] text-muted">{a.type}</span>
                    </span>
                    <span className="font-mono text-[13px]">{a.source}</span>
                    <span className="text-[13px] text-muted">{fmtWhen(a.first_seen_at)}</span>
                    <span className="text-[13px]">×{a.occurrences}</span>
                    <span className="text-[13px] font-medium">{ALERT_STATUS_LABELS[a.status]}</span>
                  </button>
                )
              })}
              {!all.loading && rows.length === 0 && <div className="row-sep px-3"><Empty>Aucune alerte pour ces filtres.</Empty></div>}
            </div>
          </div>
          <div className="row-sep flex items-center justify-between p-3 text-[13px] text-muted">
            <span>
              {rows.length} alerte{rows.length > 1 ? 's' : ''} affichée{rows.length > 1 ? 's' : ''}
            </span>
          </div>
        </section>

        <aside aria-label="Détail de l'alerte" className="card flex flex-[1_1_340px] flex-col gap-3.5">
          {!current ? (
            <Empty>Sélectionnez une alerte.</Empty>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityPill severity={current.severity} />
                <span className="font-mono text-xs text-muted">{current.type}</span>
              </div>
              <h2 className="m-0 text-xl font-semibold">{alertTitle(current.type)}</h2>
              {current.message && <p className="m-0 text-sm text-muted">{current.message}</p>}

              {typeof current.details?.snapshot === 'string' && (
                <Snapshot key={current.details.snapshot} name={current.details.snapshot} />
              )}

              <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted">Source</dt>
                <dd className="m-0 font-mono">{current.source}</dd>
                <dt className="text-muted">Survenue</dt>
                <dd className="m-0">{fmtWhen(current.first_seen_at)}</dd>
                <dt className="text-muted">Occurrences</dt>
                <dd className="m-0">{current.occurrences}</dd>
                <dt className="text-muted">Statut</dt>
                <dd className="m-0">{ALERT_STATUS_LABELS[current.status]}</dd>
                {Object.entries(current.details ?? {})
                  .filter(([k]) => k !== 'snapshot')
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-mono text-[13px] text-muted">{k}</dt>
                      <dd className="m-0 break-words">{detailValue(v)}</dd>
                    </div>
                  ))}
              </dl>

              <div>
                <div className="lbl mb-1.5">Suite donnée</div>
                <TimelineRow time={current.first_seen_at} text="Alerte créée" />
                {current.occurrences > 1 && (
                  <TimelineRow time={current.last_seen_at} text={`Doublon regroupé (×${current.occurrences})`} />
                )}
                {current.acknowledged_at && <TimelineRow time={current.acknowledged_at} text="Acquittée" />}
                {current.resolved_at && <TimelineRow time={current.resolved_at} text="Résolue" />}
              </div>

              {canOp ? (
                <div className="flex flex-wrap gap-2">
                  {current.status === 'open' && (
                    <button type="button" className="btn btn-p" onClick={() => void changeStatus(current, 'acknowledged')}>
                      Acquitter
                    </button>
                  )}
                  {current.status !== 'resolved' && (
                    <button type="button" className="btn" onClick={() => void changeStatus(current, 'resolved')}>
                      Marquer résolue
                    </button>
                  )}
                </div>
              ) : (
                <div className="note">Acquitter ou résoudre demande le rôle opérateur.</div>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  )
}

function TimelineRow({ time, text }: { time: string; text: string }) {
  return (
    <div className="row-sep flex gap-2.5 py-1.5 text-[13px]">
      <span className="font-mono whitespace-nowrap text-muted">{fmtTime(time)}</span>
      <span>{text}</span>
    </div>
  )
}
