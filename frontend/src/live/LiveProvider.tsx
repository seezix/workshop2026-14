import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, DEVICE_ID } from '../api/client'
import type { Alert, AnomalyScore, Device, TelemetryHistory, TelemetryPoint } from '../api/types'
import { beep, unlockAudio } from '../lib/sound'
import { LiveContext } from './context'
import { connectStream, disconnectStream, useStreamEvent } from './stream'

const byNewest = (a: Alert, b: Alert) => b.last_seen_at.localeCompare(a.last_seen_at)

export function LiveProvider({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<Device | null>(null)
  const [telemetry, setTelemetry] = useState<TelemetryPoint | null>(null)
  const [score, setScore] = useState<AnomalyScore | null>(null)
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([])
  const [soundOn, setSoundOn] = useState(false)

  useEffect(() => {
    connectStream()
    return disconnectStream
  }, [])

  // État initial : GET au chargement, puis le flux SSE prend le relais.
  useEffect(() => {
    const dev = `/devices/${DEVICE_ID}`
    api.get<Device>(dev).then(setDevice, () => undefined)
    api
      .get<TelemetryHistory>(`${dev}/telemetry`, {
        from: new Date(Date.now() - 15 * 60_000).toISOString(),
        resolution: 'raw',
      })
      .then((h) => setTelemetry(h.points.at(-1) ?? null), () => undefined)
    api
      .get<AnomalyScore[]>(`${dev}/anomaly-scores`, { limit: 1 })
      .then((s) => setScore(s[0] ?? null), () => undefined)
    api
      .get<Alert[]>('/alerts', { status: 'open', device_id: DEVICE_ID, limit: 200 })
      .then((a) => setOpenAlerts(a.sort(byNewest)), () => undefined)
  }, [])

  const upsertAlert = useCallback((alert: Alert) => {
    if (alert.device_id !== DEVICE_ID) return
    setOpenAlerts((prev) => {
      const rest = prev.filter((a) => a.id !== alert.id)
      return alert.status === 'open' ? [alert, ...rest].sort(byNewest) : rest
    })
  }, [])

  useStreamEvent<Device>('device.status', (d) => {
    if (d.id === DEVICE_ID) setDevice(d)
  })
  useStreamEvent<TelemetryPoint>('telemetry.new', (t) => {
    if (t.device_id === DEVICE_ID) setTelemetry(t)
  })
  useStreamEvent<AnomalyScore>('anomaly.score', (s) => {
    if (s.device_id === DEVICE_ID) setScore(s)
  })
  useStreamEvent<Alert>('alert.updated', upsertAlert)
  useStreamEvent<Alert>('alert.created', (a) => {
    upsertAlert(a)
    if (soundOn && a.device_id === DEVICE_ID && a.severity !== 'info') beep(a.severity === 'critical')
  })

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      if (!on) void unlockAudio()
      return !on
    })
  }, [])

  const value = useMemo(
    () => ({ device, telemetry, score, openAlerts, upsertAlert, setDevice, soundOn, toggleSound }),
    [device, telemetry, score, openAlerts, upsertAlert, soundOn, toggleSound],
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
