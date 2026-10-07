import { createContext, useContext } from 'react'
import type { Alert, AnomalyScore, Device, TelemetryPoint } from '../api/types'

export interface LiveValue {
  /** Boîtier suivi (SX-001), mis à jour par SSE device.status. */
  device: Device | null
  /** Dernier résumé reçu (SSE telemetry.new). */
  telemetry: TelemetryPoint | null
  /** Dernier score IA (SSE anomaly.score). */
  score: AnomalyScore | null
  /** Alertes ouvertes du boîtier (badge de navigation, bandeau critique). */
  openAlerts: Alert[]
  /** Remplace une alerte modifiée localement (après PATCH). */
  upsertAlert: (alert: Alert) => void
  setDevice: (device: Device) => void
  soundOn: boolean
  toggleSound: () => void
}

export const LiveContext = createContext<LiveValue | null>(null)

export function useLive(): LiveValue {
  const value = useContext(LiveContext)
  if (!value) throw new Error('useLive hors de <LiveProvider>')
  return value
}
