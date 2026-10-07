import type { AlertSource, AlertStatus, CommandStatus, Role, Severity } from '../api/types'

// Affichage en heure locale ; les jours sont calés sur Europe/Paris (GUIDELINES §4).
export const TZ = 'Europe/Paris'

const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const timeFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit' })
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' })
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

export const fmt1 = (v: number | null | undefined) => (v === null || v === undefined ? '–' : nf1.format(v))
export const fmt0 = (v: number | null | undefined) => (v === null || v === undefined ? '–' : nf0.format(v))
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${nf1.format(v * 100)} %`)

export const fmtTime = (iso: string | null | undefined) => (iso ? timeFmt.format(new Date(iso)) : '–')
export const fmtDateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : '–')

/** « Aujourd'hui 14:03:12 », « Hier 18:22:07 » ou « 05/10 09:14:02 ». */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  const key = dayKeyFmt.format(d)
  const today = dayKeyFmt.format(new Date())
  const yesterday = dayKeyFmt.format(new Date(Date.now() - 86_400_000))
  const prefix = key === today ? "Aujourd'hui" : key === yesterday ? 'Hier' : dayFmt.format(d)
  return `${prefix} ${timeFmt.format(d)}`
}

/** « il y a 3 s », « il y a 5 min », « il y a 2 h ». */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'jamais'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `il y a ${s} s`
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`
  return `il y a ${Math.floor(s / 86_400)} j`
}

/** « dans 71 h » pour une échéance. */
export function fmtIn(iso: string | null | undefined): string {
  if (!iso) return '–'
  const h = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000)
  return h <= 0 ? 'imminent' : `dans ${h} h`
}

export const ROLE_LABELS: Record<Role, string> = { viewer: 'Lecteur', operator: 'Opérateur', admin: 'Administrateur' }

export const SEVERITY_LABELS: Record<Severity, string> = { critical: 'Critique', warning: 'Attention', info: 'Info' }

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  open: 'Ouverte',
  acknowledged: 'Acquittée',
  resolved: 'Résolue',
}

export const SOURCES: AlertSource[] = ['esp', 'vision', 'ml', 'system']

export const COMMAND_STATUS: Record<CommandStatus, { label: string; tone: Severity }> = {
  pending: { label: 'En attente', tone: 'warning' },
  done: { label: 'Exécutée', tone: 'info' },
  rejected: { label: 'Refusée', tone: 'critical' },
  timeout: { label: 'Sans réponse', tone: 'critical' },
}

export const ALERT_TITLES: Record<string, string> = {
  MOTION_DETECTED: 'Mouvement détecté',
  IR_DETECTED: 'Présence IR',
  GAS_RISE: 'Montée rapide du gaz',
  SENSOR_FAILURE: 'Capteur en échec',
  TAMPER: 'Boîtier manipulé',
  PERSON_DETECTED: 'Personne détectée',
  PERSON_UNKNOWN: 'Personne inconnue',
  PERSON_RETURNING: 'Inconnu qui revient',
  PERSON_DENIED: 'Personne refusée',
  ANOMALY_DETECTED: 'Anomalie détectée',
  DEVICE_OFFLINE: 'Boîtier hors ligne',
  INTRUSION_CONFIRMED: 'Intrusion confirmée',
}

export const EVENT_LABELS: Record<string, string> = {
  BOOT: 'Démarrage du boîtier',
  MOTION_DETECTED: 'Mouvement détecté',
  IR_DETECTED: 'Présence IR',
  IR_CLEARED: 'Fin de présence IR',
  GAS_RISE: 'Montée rapide du gaz',
  TAMPER: 'Boîtier manipulé',
  SENSOR_FAILURE: 'Capteur en échec',
}

export const alertTitle = (type: string) => ALERT_TITLES[type] ?? type

export function eventLabel(e: { type: string; duration_ms: number | null; payload: Record<string, unknown> | null }) {
  let label = EVENT_LABELS[e.type] ?? e.type
  if (e.type === 'IR_CLEARED' && e.duration_ms !== null) label += ` · ${fmt1(e.duration_ms / 1000)} s`
  if (e.type === 'SENSOR_FAILURE' && typeof e.payload?.sensor === 'string') label += ` : ${e.payload.sensor.toUpperCase()}`
  return label
}

/** « mode beep · 3000 ms », « color red · blink true ». */
export function fmtParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => (k === 'duration_ms' ? `${v} ms` : `${k} ${String(v)}`))
    .join(' · ')
}

/** « opérateur » (vous, si c'est l'utilisateur connecté) ou l'issuer brut (rule:intrusion). */
export function fmtIssuer(c: { issuer: string; issued_by: string | null }, me?: { id: string; username: string }): string {
  if (c.issuer !== 'user') return c.issuer
  return me && c.issued_by === me.id ? `user · ${me.username}` : 'user · opérateur'
}

export function personName(p: { id: string; display_name: string | null; status: string }): string {
  if (p.display_name) return p.display_name
  return `${p.status === 'denied' ? 'Personne refusée' : 'Inconnu'} #${p.id.slice(0, 4)}`
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}
