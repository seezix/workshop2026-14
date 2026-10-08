import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, buildUrl, DEVICE_ID } from '../api/client'
import type { AnomalyScore, Device, DeviceEvent, Measure, Resolution, Stats, TelemetryHistory, TelemetryPoint } from '../api/types'
import { BAND, EChart, GRID_LINE, INK, MUTED, type ChartOption } from '../components/EChart'
import { DownloadIcon, ErrorNote, PageTitle, Pill } from '../components/ui'
import { TZ, fmt0, fmt1, pct } from '../lib/format'
import { useApi } from '../lib/useApi'
import { useStreamEvent } from '../live/stream'

const RANGES = [
  { id: '24h', label: '24 h', days: 1 },
  { id: '7d', label: '7 j', days: 7 },
  { id: '30d', label: '30 j', days: 30 },
  { id: '90d', label: '90 j', days: 90 },
] as const
type RangeId = (typeof RANGES)[number]['id'] | 'custom'

/** Délai minimal entre deux rafraîchissements automatiques des graphiques. */
const REFRESH_MS = 10_000

const RESOLUTION_LABELS: Record<Resolution, string> = {
  raw: 'brut · telemetry',
  '1h': 'telemetry_1h',
  '1d': 'telemetry_1d',
}

const DAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']
const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

/** Valeur de <input type="datetime-local"> (heure locale du navigateur). */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

function axisLabel(spanDays: number) {
  return (value: number) => {
    const d = new Date(value)
    return spanDays <= 1
      ? d.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-FR', { timeZone: TZ, day: 'numeric', month: 'short' })
  }
}

const baseOption = (spanDays: number): ChartOption => ({
  animation: false,
  grid: { left: 44, right: 12, top: 16, bottom: 28 },
  tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toLocaleString('fr-FR') : String(v)) },
  xAxis: {
    type: 'time',
    axisLabel: { color: MUTED, formatter: axisLabel(spanDays), hideOverlap: true },
    axisLine: { lineStyle: { color: GRID_LINE } },
  },
  yAxis: { type: 'value', scale: true, axisLabel: { color: MUTED }, splitLine: { lineStyle: { color: GRID_LINE } } },
})

/** Courbe moyenne + bande min / max (pile min, puis max - min). */
function bandOption(points: TelemetryPoint[], pick: (p: TelemetryPoint) => Measure, name: string, spanDays: number): ChartOption {
  const t = (p: TelemetryPoint) => new Date(p.time).getTime()
  const valid = points.filter((p) => pick(p).min !== null && pick(p).max !== null)
  return {
    ...baseOption(spanDays),
    series: [
      { name: 'min', type: 'line', stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, data: valid.map((p) => [t(p), pick(p).min]), tooltip: { show: false } },
      {
        name: 'min / max',
        type: 'line',
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color: BAND, opacity: 1 },
        data: valid.map((p) => [t(p), (pick(p).max ?? 0) - (pick(p).min ?? 0)]),
        tooltip: { show: false },
      },
      { name, type: 'line', symbol: 'none', lineStyle: { color: INK, width: 2 }, data: points.map((p) => [t(p), pick(p).avg]) },
    ],
  }
}

/** Regroupe les points en `count` tranches (sommes des compteurs). */
function detectionBuckets(points: TelemetryPoint[], from: number, to: number, count: number) {
  const size = (to - from) / count
  const buckets = Array.from({ length: count }, (_, i) => ({ t: from + i * size + size / 2, motion: 0, ir: 0 }))
  for (const p of points) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((new Date(p.time).getTime() - from) / size)))
    buckets[i]!.motion += p.motion_count
    buckets[i]!.ir += p.ir_count
  }
  return buckets
}

/** Activité (PIR + IR) par jour de la semaine et heure, en heure de Paris. */
function heatmapData(points: TelemetryPoint[]) {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const p of points) {
    const parts = weekdayFmt.formatToParts(new Date(p.time))
    const day = WEEKDAY_INDEX[parts.find((x) => x.type === 'weekday')?.value ?? '']
    const hour = Number(parts.find((x) => x.type === 'hour')?.value)
    if (day === undefined || Number.isNaN(hour)) continue
    grid[day]![hour]! += p.motion_count + p.ir_count
  }
  const data: [number, number, number][] = []
  grid.forEach((row, d) => row.forEach((v, h) => data.push([h, 6 - d, v])))
  return { data, max: Math.max(1, ...grid.flat()) }
}

export function HistoryPage() {
  const [deviceId, setDeviceId] = useState(DEVICE_ID)
  const [rangeId, setRangeId] = useState<RangeId>('24h')
  const [custom, setCustom] = useState(() => ({
    from: toLocalInput(new Date(Date.now() - 2 * 86_400_000)),
    to: toLocalInput(new Date()),
  }))
  // Fenêtre figée au choix de la période (évite de recharger à chaque rendu),
  // puis avancée quand le temps réel signale de nouvelles données.
  const [anchor, setAnchor] = useState(() => Date.now())
  const stale = useRef(false)

  const markStale = (e: { device_id: string }) => {
    if (e.device_id === deviceId) stale.current = true
  }
  useStreamEvent('telemetry.new', markStale)
  useStreamEvent('anomaly.score', markStale)
  useStreamEvent('device_event.new', markStale)
  useStreamEvent('alert.created', markStale)
  useStreamEvent('alert.updated', markStale)

  // Regroupe les événements : au plus un rechargement toutes les REFRESH_MS.
  useEffect(() => {
    if (rangeId === 'custom') return
    const id = setInterval(() => {
      if (!stale.current || document.hidden) return
      stale.current = false
      setAnchor(Date.now())
    }, REFRESH_MS)
    return () => clearInterval(id)
  }, [rangeId])

  const period = useMemo(() => {
    if (rangeId === 'custom') return { from: new Date(custom.from), to: new Date(custom.to) }
    const days = RANGES.find((r) => r.id === rangeId)!.days
    return { from: new Date(anchor - days * 86_400_000), to: new Date(anchor) }
  }, [rangeId, custom, anchor])
  const validPeriod = !Number.isNaN(period.from.getTime()) && !Number.isNaN(period.to.getTime()) && period.from < period.to
  const spanDays = (period.to.getTime() - period.from.getTime()) / 86_400_000
  const query = { from: period.from.toISOString(), to: period.to.toISOString() }
  const key = `${deviceId}|${query.from}|${query.to}`

  const devices = useApi(() => api.get<Device[]>('/devices'), [])
  const device = devices.data?.find((d) => d.id === deviceId)

  const load = <T,>(path: string, extra?: Record<string, string | number>) =>
    validPeriod ? api.get<T>(`/devices/${deviceId}${path}`, { ...query, ...extra }) : Promise.reject(new Error('Période invalide'))
  const history = useApi(() => load<TelemetryHistory>('/telemetry'), [key])
  const stats = useApi(() => load<Stats>('/stats'), [key])
  const scores = useApi(() => load<AnomalyScore[]>('/anomaly-scores', { limit: 10_000 }), [key])
  const gasRises = useApi(() => load<DeviceEvent[]>('/events', { type: 'GAS_RISE', limit: 200 }), [key])

  const points = useMemo(() => history.data?.points ?? [], [history.data])

  const charts = useMemo(() => {
    const from = period.from.getTime()
    const to = period.to.getTime()
    // Le max de chaque tranche, pour ne jamais lisser un pic court.
    const gas: ChartOption = { ...baseOption(spanDays), series: [] }
    ;(gas.series as object[]).push({
      name: 'max',
      type: 'line',
      symbol: 'none',
      lineStyle: { color: INK, width: 2 },
      data: points.map((p) => [new Date(p.time).getTime(), p.gas_raw.max]),
      markLine: {
        symbol: 'none',
        label: { formatter: 'GAS_RISE', color: INK, position: 'insideEndTop' },
        lineStyle: { color: INK, type: 'dotted' },
        data: (gasRises.data ?? []).map((e) => ({ xAxis: new Date(e.time).getTime() })),
      },
    })

    const ordered = [...(scores.data ?? [])].reverse()
    const score: ChartOption = {
      ...baseOption(spanDays),
      tooltip: {
        trigger: 'axis',
        formatter: (items: { data: [number, number, string | null] }[]) => {
          const [t, v, model] = items[0]!.data
          return `${new Date(t).toLocaleString('fr-FR', { timeZone: TZ })}<br/>score ${v.toFixed(3)}<br/>modèle ${model ?? '?'}`
        },
      },
      series: [
        {
          type: 'line',
          symbol: 'none',
          lineStyle: { color: INK, width: 2 },
          data: ordered.map((s) => [new Date(s.time).getTime(), s.score, s.model_version]),
          markPoint: {
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: INK },
            label: { show: false },
            data: ordered.filter((s) => s.is_anomaly).map((s) => ({ coord: [new Date(s.time).getTime(), s.score] })),
          },
        },
      ],
    }

    const buckets = detectionBuckets(points, from, to, spanDays <= 1 ? 24 : Math.min(60, Math.round(spanDays)))
    const detections: ChartOption = {
      ...baseOption(spanDays),
      legend: { top: 0, right: 0, textStyle: { color: MUTED } },
      grid: { left: 44, right: 12, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis' },
      yAxis: { type: 'value', axisLabel: { color: MUTED }, splitLine: { lineStyle: { color: GRID_LINE } } },
      series: [
        { name: 'Mouvements (PIR)', type: 'bar', itemStyle: { color: INK }, data: buckets.map((b) => [b.t, b.motion]) },
        { name: 'Présences IR', type: 'bar', itemStyle: { color: '#A3A39E' }, data: buckets.map((b) => [b.t, b.ir]) },
      ],
    }

    const heat = heatmapData(points)
    const heatmap: ChartOption = {
      animation: false,
      grid: { left: 44, right: 12, top: 8, bottom: 28 },
      tooltip: {
        formatter: (p: { data: [number, number, number] }) => `${DAYS[6 - p.data[1]]} ${p.data[0]} h : ${p.data[2]} détections`,
      },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, h) => `${h} h`), axisLabel: { color: MUTED, interval: 5 }, splitArea: { show: false } },
      yAxis: { type: 'category', data: [...DAYS].reverse(), axisLabel: { color: MUTED } },
      visualMap: { min: 0, max: heat.max, show: false, inRange: { color: ['#F1F1EE', '#CFCFCC', '#8A8A85', INK] } },
      series: [{ type: 'heatmap', data: heat.data, itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 2 } }],
    }

    return {
      temperature: bandOption(points, (p) => p.temperature_c, 'moyenne', spanDays),
      humidity: bandOption(points, (p) => p.humidity_pct, 'moyenne', spanDays),
      gas,
      score,
      detections,
      heatmap,
    }
  }, [points, scores.data, gasRises.data, period, spanDays])

  const s = stats.data
  const exportUrl = validPeriod ? buildUrl(`/devices/${deviceId}/telemetry/export`, query) : undefined

  const pickRange = (id: RangeId) => {
    setRangeId(id)
    setAnchor(() => Date.now())
  }

  return (
    <>
      <PageTitle title="Historique" subtitle="Jours calés sur Europe/Paris · heures affichées en heure locale">
        <a className="btn" href={exportUrl} download aria-disabled={!exportUrl}>
          <DownloadIcon />
          Exporter en CSV
        </a>
      </PageTitle>

      <div className="card flex flex-wrap items-end gap-4">
        <label className="fld flex-[1_1_220px]">
          Boîtier
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {(devices.data ?? [{ id: DEVICE_ID, is_simulated: false } as Device]).map((d) => (
              <option key={d.id} value={d.id}>
                {d.id} · {d.is_simulated ? 'historique simulé' : 'boîtier réel'}
              </option>
            ))}
          </select>
        </label>
        <div className="fld flex-[2_1_320px]">
          <span>Période</span>
          <div role="group" aria-label="Période" className="flex flex-wrap gap-1.5">
            {RANGES.map((r) => (
              <button key={r.id} type="button" className={`btn ${rangeId === r.id ? 'btn-p' : ''}`} aria-pressed={rangeId === r.id} onClick={() => pickRange(r.id)}>
                {r.label}
              </button>
            ))}
            <button type="button" className={`btn ${rangeId === 'custom' ? 'btn-p' : ''}`} aria-pressed={rangeId === 'custom'} onClick={() => pickRange('custom')}>
              Personnalisée…
            </button>
          </div>
        </div>
        <div className="flex flex-[1_1_200px] flex-col gap-1">
          <span className="text-[13px] text-muted">Résolution choisie par l'API</span>
          <span className="font-mono text-sm font-medium">{history.data ? RESOLUTION_LABELS[history.data.resolution] : '–'}</span>
        </div>
        {rangeId === 'custom' && (
          <div className="flex flex-[1_1_100%] flex-wrap gap-3">
            <label className="fld flex-[1_1_200px]">
              Du
              <input type="datetime-local" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </label>
            <label className="fld flex-[1_1_200px]">
              Au
              <input type="datetime-local" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </label>
          </div>
        )}
      </div>

      {device?.is_simulated && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-ink bg-white px-4 py-3 text-sm">
          <Pill tone="warning">Données simulées</Pill>
          <span>
            {device.id} porte un mois d'historique généré pour la démo (cycle jour/nuit, incidents injectés). Il n'est jamais mélangé aux vraies
            données.
          </span>
        </div>
      )}

      <ErrorNote message={validPeriod ? (history.error ?? stats.error) : 'Période invalide : la date de début doit précéder la date de fin.'} />
      {history.data?.truncated && <ErrorNote message="Trop de points : la courbe est tronquée. Réduisez la période." />}

      <section aria-label="Résumé de la période" className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        <StatTile label="Température moy." value={s ? `${fmt1(s.temperature_c.avg)} °C` : '–'} sub={s ? `min ${fmt1(s.temperature_c.min)} · max ${fmt1(s.temperature_c.max)}` : ''} />
        <StatTile label="Humidité moy." value={s ? `${fmt1(s.humidity_pct.avg)} %` : '–'} sub={s ? `min ${fmt1(s.humidity_pct.min)} · max ${fmt1(s.humidity_pct.max)}` : ''} />
        <StatTile
          label="Gaz (brut)"
          value={fmt0(s?.gas_raw.avg)}
          sub={s ? `pic ${fmt0(s.gas_raw.max)} · ${gasRises.data?.length ?? 0} montée${(gasRises.data?.length ?? 0) > 1 ? 's' : ''} rapide${(gasRises.data?.length ?? 0) > 1 ? 's' : ''}` : ''}
        />
        <StatTile label="Détections" value={s ? fmt0(s.motion_count + s.ir_count) : '–'} sub={s ? `${s.motion_count} PIR · ${s.ir_count} IR` : ''} />
        <StatTile
          label="Alertes"
          value={fmt0(s?.alerts.total)}
          sub={s ? `${s.alerts.by_severity.critical} critiques · ${s.alerts.by_severity.warning} attention` : ''}
        />
        <StatTile label="Disponibilité" value={pct(s?.availability)} sub={s ? `${s.summaries} résumés reçus` : ''} />
      </section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] gap-4">
        <ChartCard title="Température" hint="moyenne pondérée + bande min / max">
          <EChart option={charts.temperature} label="Courbe de température" />
        </ChartCard>
        <ChartCard title="Humidité" hint="moyenne + bande min / max">
          <EChart option={charts.humidity} label="Courbe d'humidité" />
        </ChartCard>
        <ChartCard title="Gaz MQ-2 (valeur brute)" hint="pics conservés via max">
          <EChart option={charts.gas} label="Courbe du gaz" />
        </ChartCard>
        <ChartCard title="Score d'anomalie IA" hint="pas de seuil fixe : marqueurs = anomalies">
          {scores.data?.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted">Aucun score sur la période.</div>
          ) : (
            <EChart option={charts.score} label="Courbe du score d'anomalie" />
          )}
        </ChartCard>
      </div>

      <ChartCard title="Détections par période">
        <EChart option={charts.detections} height={180} label="Détections PIR et IR par tranche" />
      </ChartCard>

      <ChartCard title="Activité par jour et par heure">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <EChart option={charts.heatmap} height={220} label="Activité par jour de la semaine et par heure" />
          </div>
        </div>
      </ChartCard>
    </>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card">
      <div className="lbl">{label}</div>
      <div className="mt-1 text-[26px] font-semibold">{value}</div>
      <div className="text-[13px] text-muted">{sub}</div>
    </div>
  )
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="card flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        {hint && <span className="text-[13px] text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  )
}
