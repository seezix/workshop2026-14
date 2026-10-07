import { useState, type FormEvent } from 'react'
import { api, DEVICE_ID, errorMessage } from '../api/client'
import type { CommandInput, Device, Health } from '../api/types'
import { useAuth } from '../auth/context'
import { Empty, ErrorNote, PageTitle, Pill } from '../components/ui'
import { COMMAND_STATUS, fmtAgo, fmtIssuer, fmtParams, fmtTime, fmtWhen } from '../lib/format'
import { useApi, useNow } from '../lib/useApi'
import { useCommands } from '../lib/useCommands'
import { useLive } from '../live/context'

const PRESETS = [
  { label: 'Démo · 5 s', value: 5 },
  { label: 'Production · 60 s', value: 60 },
]

export function DevicePage() {
  const { user, can } = useAuth()
  const canOp = can('operator')
  const { device, telemetry, setDevice } = useLive()
  const now = useNow()
  const offline = device?.status !== 'online'
  const health = useApi(() => api.get<Health>('/health').catch(() => null), [])
  const cmds = useCommands(50)

  return (
    <>
      <PageTitle title={`Boîtier ${DEVICE_ID}`} subtitle="État, configuration durable et commandes ponctuelles" />

      {device && offline && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-ink bg-white px-4 py-3.5">
          <Pill tone="critical">Hors ligne</Pill>
          <span className="flex-[1_1_300px] text-sm">
            Dernier contact {fmtWhen(device.last_seen_at).toLowerCase()}. Les commandes sont bloquées. La configuration reste enregistrée et sera
            renvoyée au boîtier à sa reconnexion.
          </span>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
        <section aria-label="État" className="card flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">État</h2>
          <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">Connexion</dt>
            <dd className="m-0">{device ? (offline ? 'Hors ligne' : 'En ligne') : '–'}</dd>
            <dt className="text-muted">Firmware</dt>
            <dd className="m-0 font-mono">{device?.fw_version ?? '–'}</dd>
            <dt className="text-muted">Adresse IP</dt>
            <dd className="m-0 font-mono">{device?.ip ?? '–'}</dd>
            <dt className="text-muted">Signal Wi-Fi</dt>
            <dd className="m-0">{telemetry?.rssi_dbm != null ? `${telemetry.rssi_dbm} dBm` : '–'}</dd>
            <dt className="text-muted">Dernier message</dt>
            <dd className="m-0">
              {fmtAgo(device?.last_seen_at, now)}
              {telemetry?.seq != null && ` · seq ${telemetry.seq}`}
            </dd>
            <dt className="text-muted">Emplacement</dt>
            <dd className="m-0">{device?.location ?? '–'}</dd>
          </dl>
        </section>

        <section aria-label="Santé du serveur" className="card flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">Santé du serveur</h2>
          <div className="flex flex-col">
            <HealthRow label="API backend" state={health.data ? 'up' : health.loading ? undefined : 'down'} />
            <HealthRow label="Base PostgreSQL + TimescaleDB" state={health.data?.database} />
            <HealthRow label="Broker Mosquitto (TLS 8883)" state={health.data?.broker} />
          </div>
          <button type="button" className="btn self-start" onClick={health.reload}>
            Actualiser
          </button>
        </section>
      </div>

      {/* La clé remonte le formulaire quand la config change ailleurs (SSE device.status). */}
      {device && (
        <ConfigForm
          key={`${device.config.armed}-${device.config.interval_s}`}
          device={device}
          canOp={canOp}
          onSaved={setDevice}
        />
      )}

      <section aria-label="Commandes" className="card flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">Commandes ponctuelles</h2>
          <span className="text-[13px] text-muted">Le boîtier vérifie lui-même les limites</span>
        </div>
        {canOp ? (
          <>
            <ErrorNote message={cmds.error} />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
              <BuzzerForm disabled={offline || cmds.sending} onSend={cmds.send} />
              <LedForm disabled={offline || cmds.sending} onSend={cmds.send} />
            </div>
            {offline && <div className="text-sm font-medium">Boîtier hors ligne : envoi impossible.</div>}
          </>
        ) : (
          <div className="note text-sm">Lecture seule : les commandes demandent le rôle opérateur.</div>
        )}
      </section>

      <section aria-label="Historique des commandes" className="card overflow-hidden p-0">
        <div className="px-4 pt-4 pb-2">
          <h2 className="m-0 text-lg font-semibold">Historique des commandes</h2>
        </div>
        <ErrorNote message={cmds.loadError} />
        <div className="overflow-x-auto">
          <div className="min-w-[860px]">
            <div className="lbl grid grid-cols-[120px_80px_minmax(0,1fr)_150px_90px_110px_110px] gap-3 bg-head px-3 py-2.5">
              <span>cmd_id</span>
              <span>Action</span>
              <span>Paramètres</span>
              <span>Déclenchée par</span>
              <span>Envoyée</span>
              <span>Statut</span>
              <span>Ack</span>
            </div>
            {cmds.commands.map((c) => (
              <div key={c.cmd_id} className="row-sep grid grid-cols-[120px_80px_minmax(0,1fr)_150px_90px_110px_110px] items-center gap-3 px-3 py-2.5 text-sm">
                <span className="font-mono text-[13px]">{c.cmd_id}</span>
                <span>{c.action}</span>
                <span className="font-mono text-xs text-muted">{fmtParams(c.params)}</span>
                <span className="font-mono text-[13px]">{fmtIssuer(c, user ?? undefined)}</span>
                <span className="text-[13px] text-muted">{fmtTime(c.issued_at)}</span>
                <span>
                  <Pill tone={COMMAND_STATUS[c.status].tone}>{COMMAND_STATUS[c.status].label}</Pill>
                </span>
                <span className="text-[13px] text-muted">
                  {c.acked_at
                    ? `+${((new Date(c.acked_at).getTime() - new Date(c.issued_at).getTime()) / 1000).toFixed(1).replace('.', ',')} s`
                    : c.status === 'timeout'
                      ? 'timeout 5 s'
                      : ''}
                  {c.reason && ` ${c.reason}`}
                </span>
              </div>
            ))}
            {cmds.commands.length === 0 && (
              <div className="row-sep px-3">
                <Empty>Aucune commande.</Empty>
              </div>
            )}
          </div>
        </div>
        <p className="m-0 px-4 py-3 text-[13px] text-muted">Les réflexes locaux de l'ESP (sans réseau) n'apparaissent pas ici.</p>
      </section>
    </>
  )
}

function HealthRow({ label, state }: { label: string; state: string | undefined }) {
  const text = state === 'up' ? 'OK' : state === 'disabled' ? 'Désactivé' : state === 'down' ? 'En panne' : '…'
  return (
    <div className="row-sep flex justify-between py-2.5 text-sm">
      <span>{label}</span>
      <Pill tone={state === 'down' ? 'critical' : 'info'}>{text}</Pill>
    </div>
  )
}

function ConfigForm({ device, canOp, onSaved }: { device: Device; canOp: boolean; onSaved: (d: Device) => void }) {
  const [armed, setArmed] = useState(device.config.armed)
  const [interval, setIntervalS] = useState(device.config.interval_s)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = armed !== device.config.armed || interval !== device.config.interval_s
  const validInterval = Number.isInteger(interval) && interval >= 2 && interval <= 300

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<Device>(`/devices/${device.id}/config`, { armed, interval_s: interval }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} aria-label="Configuration" className="card flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">Configuration</h2>
        <span className="text-[13px] text-muted">Renvoyée au boîtier à chaque reconnexion</span>
      </div>
      <ErrorNote message={error} />

      <div className="flex flex-wrap gap-6">
        <div className="flex flex-[1_1_280px] flex-col gap-2">
          <div className="lbl">Surveillance</div>
          <button
            type="button"
            role="switch"
            aria-checked={armed}
            disabled={!canOp}
            onClick={() => setArmed((a) => !a)}
            className="flex min-h-11 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left text-[15px] text-ink disabled:cursor-not-allowed"
          >
            <span className={`relative h-[30px] w-[52px] shrink-0 rounded-full border-2 border-ink ${armed ? 'bg-ink' : 'bg-white'}`}>
              <span
                className={`absolute top-[3px] size-5 rounded-full transition-[left] ${armed ? 'left-[25px] bg-white' : 'left-[3px] bg-ink'}`}
              />
            </span>
            <span className="font-semibold">{armed ? 'Surveillance armée' : 'Surveillance désarmée'}</span>
          </button>
          <div className="text-[13px] text-muted">
            {armed
              ? 'Les détections créent des alertes et les règles peuvent déclencher buzzer et LED.'
              : "Les détections sont enregistrées mais ne créent pas d'alerte."}
          </div>
        </div>

        <div className="flex flex-[2_1_380px] flex-col gap-2">
          <div className="lbl">Intervalle d'envoi du résumé</div>
          <div role="group" aria-label="Préréglage" className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`btn ${interval === p.value ? 'btn-p' : ''}`}
                aria-pressed={interval === p.value}
                disabled={!canOp}
                onClick={() => setIntervalS(p.value)}
              >
                {p.label}
              </button>
            ))}
            <label className="fld flex-row items-center gap-2 text-sm text-ink">
              ou
              <input
                type="number"
                min={2}
                max={300}
                className="w-[90px]"
                disabled={!canOp}
                value={Number.isNaN(interval) ? '' : interval}
                onChange={(e) => setIntervalS(e.target.valueAsNumber)}
              />
              s
            </label>
          </div>
          <div className={`text-[13px] ${validInterval ? 'text-muted' : 'font-medium text-ink'}`}>
            Entre 2 et 300 s. Le boîtier ignore toute autre valeur.
          </div>
        </div>
      </div>

      {canOp && (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-p" disabled={!dirty || !validInterval || busy}>
            Enregistrer la configuration
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || busy}
            onClick={() => {
              setArmed(device.config.armed)
              setIntervalS(device.config.interval_s)
            }}
          >
            Annuler
          </button>
        </div>
      )}
    </form>
  )
}

function BuzzerForm({ disabled, onSend }: { disabled: boolean; onSend: (c: CommandInput) => Promise<void> }) {
  const [mode, setMode] = useState<'beep' | 'on' | 'off'>('beep')
  const [duration, setDuration] = useState(3000)
  const validDuration = Number.isInteger(duration) && duration >= 1 && duration <= 10_000

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3.5">
      <legend className="px-1.5 font-semibold">Buzzer</legend>
      <div role="radiogroup" aria-label="Mode" className="flex flex-wrap gap-3.5 text-sm">
        {(
          [
            ['beep', 'Bip'],
            ['on', 'Continu'],
            ['off', 'Arrêt'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="inline-flex min-h-11 items-center gap-1.5">
            <input type="radio" name="buzzer-mode" checked={mode === value} onChange={() => setMode(value)} /> {label}
          </label>
        ))}
      </div>
      {mode !== 'off' && (
        <label className="fld">
          Durée (ms, 10 000 max)
          <input type="number" min={1} max={10_000} step={500} value={Number.isNaN(duration) ? '' : duration} onChange={(e) => setDuration(e.target.valueAsNumber)} />
        </label>
      )}
      <button
        type="button"
        className="btn btn-p"
        disabled={disabled || (mode !== 'off' && !validDuration)}
        onClick={() => void onSend({ action: 'BUZZER', params: mode === 'off' ? { mode } : { mode, duration_ms: duration } })}
      >
        Envoyer au boîtier
      </button>
    </fieldset>
  )
}

function LedForm({ disabled, onSend }: { disabled: boolean; onSend: (c: CommandInput) => Promise<void> }) {
  const [color, setColor] = useState<'red' | 'green' | 'off'>('red')
  const [blink, setBlink] = useState(false)

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3.5">
      <legend className="px-1.5 font-semibold">LED</legend>
      <div role="radiogroup" aria-label="Couleur" className="flex flex-wrap gap-3.5 text-sm">
        {(
          [
            ['red', 'Rouge'],
            ['green', 'Verte'],
            ['off', 'Éteinte'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="inline-flex min-h-11 items-center gap-1.5">
            <input type="radio" name="led-color" checked={color === value} onChange={() => setColor(value)} /> {label}
          </label>
        ))}
      </div>
      <label className="inline-flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={blink} disabled={color === 'off'} onChange={(e) => setBlink(e.target.checked)} /> Clignotement
      </label>
      <button
        type="button"
        className="btn btn-p"
        disabled={disabled}
        onClick={() => void onSend({ action: 'LED', params: color === 'off' ? { color } : { color, blink } })}
      >
        Envoyer au boîtier
      </button>
    </fieldset>
  )
}
