import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, DEVICE_ID, errorMessage } from '../api/client'
import type { Alert, DeviceEvent, Measure } from '../api/types'
import { useAuth } from '../auth/context'
import { BellIcon, Empty, ErrorNote, PageTitle, Pill, SeverityPill } from '../components/ui'
import {
  ALERT_STATUS_LABELS,
  COMMAND_STATUS,
  alertTitle,
  eventLabel,
  fmt0,
  fmt1,
  fmtAgo,
  fmtIssuer,
  fmtParams,
  fmtTime,
  fmtWhen,
} from '../lib/format'
import { useApi, useNow } from '../lib/useApi'
import { useCommands } from '../lib/useCommands'
import { useLive } from '../live/context'
import { useStreamEvent } from '../live/stream'

function Kpi({ label, value, unit, detail, badge }: { label: string; value: string; unit?: string; detail: string; badge?: ReactNode }) {
  return (
    <div className="card flex flex-col gap-1.5 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="lbl">{label}</span>
        {badge}
      </div>
      <div className="text-[40px] leading-tight font-semibold">
        {value} {unit && <span className="text-lg font-normal">{unit}</span>}
      </div>
      <div className="text-[13px] text-muted">{detail}</div>
    </div>
  )
}

const range = (m: Measure | undefined, f: (v: number | null | undefined) => string) =>
  m ? `min ${f(m.min)} · max ${f(m.max)} sur la période` : 'aucune mesure'

export function OverviewPage() {
  const { user, can } = useAuth()
  const { device, telemetry, score, openAlerts, upsertAlert } = useLive()
  const now = useNow()
  const canOp = can('operator')
  const online = device?.status === 'online'
  const [actionError, setActionError] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)

  const recent = useApi(() => api.get<Alert[]>('/alerts', { device_id: DEVICE_ID, limit: 5 }), [])
  const events = useApi(() => api.get<DeviceEvent[]>(`/devices/${DEVICE_ID}/events`, { limit: 6 }), [])
  const cmds = useCommands(3)

  const upsertRecent = (a: Alert) => {
    if (a.device_id !== DEVICE_ID) return
    recent.setData((prev) => [a, ...(prev ?? []).filter((x) => x.id !== a.id)].slice(0, 5))
  }
  useStreamEvent<Alert>('alert.created', upsertRecent)
  useStreamEvent<Alert>('alert.updated', (a) =>
    recent.setData((prev) => prev?.map((x) => (x.id === a.id ? a : x))),
  )
  useStreamEvent<DeviceEvent>('device_event.new', (e) => {
    if (e.device_id === DEVICE_ID) events.setData((prev) => [e, ...(prev ?? [])].slice(0, 6))
  })

  const critical = openAlerts.find((a) => a.severity === 'critical')

  async function acknowledge(alert: Alert) {
    setActionError(null)
    try {
      upsertAlert(await api.patch<Alert>(`/alerts/${alert.id}`, { status: 'acknowledged' }))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const t = telemetry
  const subtitle = t
    ? `Dernier résumé reçu ${fmtAgo(t.time, now)} · intervalle ${t.interval_s ?? device?.config.interval_s ?? '–'} s · ${t.samples} lectures valides`
    : 'Aucun résumé reçu ces 15 dernières minutes'

  return (
    <>
      <PageTitle title="Vue d'ensemble" subtitle={subtitle}>
        <Link className="btn" to="/historique">
          Voir l'historique
        </Link>
      </PageTitle>

      <ErrorNote message={actionError ?? cmds.error} />

      {critical && (
        <section aria-label="Alerte critique en cours" className="card flex flex-wrap items-center gap-4 border-2 border-ink">
          <SeverityPill severity="critical" />
          <div className="min-w-0 flex-[1_1_320px]">
            <div className="text-[17px] font-semibold">
              {alertTitle(critical.type)}
              {critical.occurrences > 1 && ` ×${critical.occurrences}`}
            </div>
            <div className="text-sm text-muted">
              {critical.message ?? critical.source} · {fmtWhen(critical.first_seen_at)}
            </div>
          </div>
          {canOp && (
            <button type="button" className="btn btn-p" onClick={() => void acknowledge(critical)}>
              Acquitter
            </button>
          )}
          <Link className="btn" to={`/alertes?id=${critical.id}`}>
            Détails
          </Link>
        </section>
      )}

      <section aria-label="Mesures actuelles" className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        <Kpi label="Température" value={fmt1(t?.temperature_c.last)} unit="°C" detail={range(t?.temperature_c, fmt1)} />
        <Kpi label="Humidité" value={fmt1(t?.humidity_pct.last)} unit="%" detail={range(t?.humidity_pct, fmt1)} />
        <Kpi label="Gaz MQ-2 (brut)" value={fmt0(t?.gas_raw.last)} detail={t ? `pic ${fmt0(t.gas_raw.max)} sur la période` : 'aucune mesure'} />
        <Kpi
          label="Capteur magnétique (brut)"
          value={fmt0(t?.magnetic_raw.last)}
          detail={t ? `pic ${fmt0(t.magnetic_raw.max)} sur la période` : 'aucune mesure'}
        />
        <Kpi
          label="Score d'anomalie IA"
          value={score ? score.score.toFixed(2).replace('.', ',') : '–'}
          detail={score ? `modèle ${score.model_version ?? '?'} · ${fmtAgo(score.time, now)}` : 'aucun score reçu'}
          badge={score && <Pill tone={score.is_anomaly ? 'critical' : 'info'}>{score.is_anomaly ? 'Anomalie' : 'Normal'}</Pill>}
        />
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label="Caméra et actions" className="card flex flex-[2_1_560px] flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-lg font-semibold">Caméra · flux annoté</h2>
            <Pill tone="info">{videoError ? 'Indisponible' : 'En direct'}</Pill>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-md bg-soft">
            {videoError ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                Flux vidéo indisponible (vision.py ne répond pas)
              </div>
            ) : (
              <img
                src="/video/stream"
                alt="Flux annoté de la webcam du boîtier"
                className="h-full w-full object-cover"
                onError={() => setVideoError(true)}
              />
            )}
            <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white/95 p-2">
              {canOp ? (
                <div role="group" aria-label="Actions rapides sur le boîtier" className="flex flex-auto flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={!online || cmds.sending}
                    onClick={() => void cmds.send({ action: 'BUZZER', params: { mode: 'beep', duration_ms: 3000 } })}
                  >
                    <BellIcon />
                    Tester l'alarme (3 s)
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!online || cmds.sending}
                    onClick={() => void cmds.send({ action: 'BUZZER', params: { mode: 'off' } })}
                  >
                    Couper le buzzer
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!online || cmds.sending}
                    onClick={() => void cmds.send({ action: 'LED', params: { color: 'red' } })}
                  >
                    <span className="size-3 rounded-full bg-ink" aria-hidden="true" />
                    LED rouge
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!online || cmds.sending}
                    onClick={() => void cmds.send({ action: 'LED', params: { color: 'green' } })}
                  >
                    <span className="size-3 rounded-full border-2 border-ink" aria-hidden="true" />
                    LED verte
                  </button>
                </div>
              ) : (
                <span className="flex-auto px-1.5 text-sm text-muted">Lecture seule : les actions demandent le rôle opérateur.</span>
              )}
              {canOp && !online && <span className="px-1.5 text-[13px] font-medium">Boîtier hors ligne</span>}
            </div>
          </div>

          <div>
            <div className="lbl mb-1">Dernières commandes</div>
            {cmds.commands.length === 0 && <Empty>Aucune commande envoyée.</Empty>}
            {cmds.commands.map((c) => (
              <div key={c.cmd_id} className="row-sep flex items-center gap-3 py-2 text-sm">
                <span className="font-mono text-[13px] whitespace-nowrap text-muted">{fmtTime(c.issued_at)}</span>
                <span className="min-w-0 flex-1">
                  {c.action} · {fmtParams(c.params)}{' '}
                  <span className="font-mono text-[11px] text-muted">· {fmtIssuer(c, user ?? undefined)}</span>
                </span>
                <Pill tone={COMMAND_STATUS[c.status].tone}>{COMMAND_STATUS[c.status].label}</Pill>
              </div>
            ))}
          </div>
        </section>

        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <section aria-label="Alertes récentes" className="card flex flex-col gap-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="m-0 text-lg font-semibold">Alertes récentes</h2>
              <Link to="/alertes" className="text-sm">
                Tout voir
              </Link>
            </div>
            <ErrorNote message={recent.error} />
            {recent.data?.length === 0 && <Empty>Aucune alerte.</Empty>}
            {recent.data?.map((a) => (
              <Link key={a.id} to={`/alertes?id=${a.id}`} className="row-sep flex items-start gap-2.5 py-2.5 no-underline">
                <SeverityPill severity={a.severity} className="min-w-[72px] justify-center" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">
                    {alertTitle(a.type)}
                    {a.occurrences > 1 && ` ×${a.occurrences}`}
                  </div>
                  <div className="text-[13px] text-muted">
                    {a.source} · {fmtTime(a.first_seen_at)}
                  </div>
                </div>
                <span className="text-xs whitespace-nowrap text-muted">{ALERT_STATUS_LABELS[a.status]}</span>
              </Link>
            ))}
          </section>

          <section aria-label="Événements du boîtier" className="card flex flex-col gap-1">
            <h2 className="m-0 mb-2 text-lg font-semibold">Événements du boîtier</h2>
            <ErrorNote message={events.error} />
            {events.data?.length === 0 && <Empty>Aucun événement sur 24 h.</Empty>}
            {events.data?.map((e) => (
              <div key={e.id} className="row-sep flex gap-3 py-2 text-sm">
                <span className="font-mono text-[13px] whitespace-nowrap text-muted">{fmtTime(e.time)}</span>
                <div className="min-w-0 flex-1">
                  <div>{eventLabel(e)}</div>
                  <div className="font-mono text-[11px] text-muted">{e.type}</div>
                </div>
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  )
}
