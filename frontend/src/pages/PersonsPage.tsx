import { useMemo, useRef, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api/client'
import type { Alert, Person, PersonStatus, Severity, Sighting } from '../api/types'
import { useAuth } from '../auth/context'
import { Empty, ErrorNote, PageTitle, PersonIcon, Pill, ShieldIcon } from '../components/ui'
import { fmtDateTime, fmtIn, fmtWhen, initials, personName } from '../lib/format'
import { useApi } from '../lib/useApi'
import { useStreamEvent } from '../live/stream'

const TABS: { id: PersonStatus; label: string; hint: string }[] = [
  { id: 'unknown', label: 'Inconnus', hint: 'Empreinte seulement, aucune photo. Effacés automatiquement après 72 h.' },
  { id: 'authorized', label: 'Autorisés', hint: "Membres de l'équipe ayant donné leur accord. Aucune alerte quand ils sont reconnus." },
  { id: 'denied', label: 'Refusés', hint: "Personnes signalées : alerte critique dès qu'elles sont reconnues." },
]

function tag(p: Person): { label: string; tone: Severity } {
  if (p.status === 'authorized') return { label: 'Autorisé', tone: 'info' }
  if (p.status === 'denied') return { label: 'Refusé', tone: 'critical' }
  return p.visit_count > 1 ? { label: 'Revient', tone: 'critical' } : { label: 'Inconnu', tone: 'warning' }
}

function Avatar({ person, size = 44 }: { person: Person; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-soft font-semibold" style={{ width: size, height: size }}>
      {person.display_name ? initials(person.display_name) : <PersonIcon size={size / 2} />}
    </span>
  )
}

export function PersonsPage() {
  const { can } = useAuth()
  const isAdmin = can('admin')
  const [tab, setTab] = useState<PersonStatus>('unknown')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const persons = useApi(() => (can('operator') ? api.get<Person[]>('/persons') : Promise.resolve([])), [])
  const list = useMemo(() => (persons.data ?? []).filter((p) => p.status === tab), [persons.data, tab])
  const current = list.find((p) => p.id === selectedId) ?? list[0]

  const sightings = useApi(
    () => (current ? api.get<Sighting[]>(`/persons/${current.id}/sightings`, { limit: 20 }) : Promise.resolve([])),
    [current?.id],
  )

  // Une alerte vision = une personne créée ou revue : la liste se met à jour toute seule.
  useStreamEvent<Alert>('alert.created', (a) => {
    if (a.source !== 'vision') return
    persons.reload()
    sightings.reload()
  })

  if (!can('operator')) {
    return (
      <>
        <PageTitle title="Personnes" subtitle="Reconnaissance faciale de la caméra du boîtier" />
        <GdprBanner />
        <div className="card p-10 text-center text-muted">
          <div className="text-[17px] font-semibold text-ink">Accès réservé aux opérateurs</div>
          <div>Le rôle lecteur ne voit pas les personnes ni leurs passages.</div>
        </div>
      </>
    )
  }

  async function patch(person: Person, body: Record<string, unknown>) {
    setActionError(null)
    try {
      const updated = await api.patch<Person>(`/persons/${person.id}`, body)
      persons.setData((prev) => prev?.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function remove(person: Person) {
    if (!window.confirm(`Effacer définitivement ${personName(person)} ? Empreintes et passages seront supprimés.`)) return
    setActionError(null)
    try {
      await api.delete(`/persons/${person.id}`)
      persons.setData((prev) => prev?.filter((p) => p.id !== person.id))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const countOf = (status: PersonStatus) => (persons.data ?? []).filter((p) => p.status === status).length
  const hint = TABS.find((t) => t.id === tab)!.hint

  return (
    <>
      <PageTitle title="Personnes" subtitle="Reconnaissance faciale de la caméra du boîtier" />
      <GdprBanner />
      <ErrorNote message={persons.error ?? actionError} />

      <div role="tablist" aria-label="Catégories" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`btn ${tab === t.id ? 'btn-p' : ''}`}
            onClick={() => {
              setTab(t.id)
              setSelectedId(null)
            }}
          >
            {t.label} · {countOf(t.id)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label="Liste" className="card flex flex-[2_1_380px] flex-col gap-2">
          <div className="mb-1 text-sm text-muted">{hint}</div>
          {!persons.loading && list.length === 0 && <Empty>Personne dans cette catégorie.</Empty>}
          {list.map((p) => {
            const selected = current?.id === p.id
            const t = tag(p)
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelectedId(p.id)}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line p-3 text-left hover:border-ink ${
                  selected ? 'bg-selected' : 'bg-white'
                }`}
              >
                <Avatar person={p} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{personName(p)}</span>
                  <span className="text-[13px] text-muted">
                    {p.visit_count} passage{p.visit_count > 1 ? 's' : ''} · vu {fmtWhen(p.last_seen_at).toLowerCase()}
                  </span>
                </span>
                <Pill tone={t.tone}>{t.label}</Pill>
              </button>
            )
          })}
        </section>

        <aside aria-label="Détail de la personne" className="card flex flex-[3_1_420px] flex-col gap-3.5">
          {!current ? (
            <Empty>Sélectionnez une personne.</Empty>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar person={current} size={56} />
                <div className="min-w-0 flex-1">
                  <h2 className="m-0 text-xl font-semibold">{personName(current)}</h2>
                  <Pill tone={tag(current).tone}>{tag(current).label}</Pill>
                </div>
              </div>

              <dl className="m-0 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted">Passages</dt>
                <dd className="m-0">{current.visit_count}</dd>
                <dt className="text-muted">Dernier passage</dt>
                <dd className="m-0">{fmtWhen(current.last_seen_at)}</dd>
                {current.status === 'unknown' && (
                  <>
                    <dt className="text-muted">Effacement auto</dt>
                    <dd className="m-0">{fmtIn(current.expires_at)}</dd>
                  </>
                )}
                {current.status === 'authorized' && (
                  <>
                    <dt className="text-muted">Accord donné le</dt>
                    <dd className="m-0">{fmtDateTime(current.consent_at)}</dd>
                  </>
                )}
                {current.embeddings_count !== undefined && (
                  <>
                    <dt className="text-muted">Empreintes</dt>
                    <dd className="m-0">{current.embeddings_count} (jamais affichées)</dd>
                  </>
                )}
              </dl>

              <div>
                <div className="lbl mb-1.5">Historique des passages</div>
                <ErrorNote message={sightings.error} />
                {sightings.data?.length === 0 && <Empty>Aucun passage enregistré.</Empty>}
                {sightings.data?.map((s) => (
                  <div key={s.id} className="row-sep flex flex-wrap gap-3 py-2 text-sm">
                    <span className="min-w-[130px] font-mono text-[13px] text-muted">{fmtDateTime(s.time)}</span>
                    <span className="flex-1">
                      {s.alert_id ? `Alerte · statut ${s.status_at_time}` : `Reconnu · ${s.status_at_time}`}
                    </span>
                    <span className="text-[13px] text-muted">similarité {s.similarity.toFixed(2).replace('.', ',')}</span>
                  </div>
                ))}
              </div>

              {isAdmin ? (
                <AdminActions key={current.id} person={current} onPatch={patch} onDelete={remove} />
              ) : (
                <div className="note">Renommer, autoriser, refuser ou effacer demande le rôle administrateur.</div>
              )}
            </>
          )}
        </aside>
      </div>

      {isAdmin && (
        <EnrollForm
          onDone={(personId) => {
            setTab('authorized')
            setSelectedId(personId)
            persons.reload()
          }}
        />
      )}
    </>
  )
}

function GdprBanner() {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border-[1.5px] border-ink bg-white px-4 py-3.5 text-sm">
      <ShieldIcon />
      <div className="min-w-0 flex-[1_1_300px]">
        <div className="font-semibold">Données biométriques (article 9 du RGPD)</div>
        <div className="text-muted">
          Seules les personnes ayant donné leur accord sont autorisées. Les inconnus n'ont aucune photo et sont effacés automatiquement après 72 h. Les
          empreintes ne sont jamais affichées.
        </div>
      </div>
    </div>
  )
}

function AdminActions({
  person,
  onPatch,
  onDelete,
}: {
  person: Person
  onPatch: (p: Person, body: Record<string, unknown>) => Promise<void>
  onDelete: (p: Person) => Promise<void>
}) {
  const [name, setName] = useState(person.display_name ?? '')

  function authorize() {
    // L'API exige consent: true si aucun accord n'est encore enregistré.
    if (!person.consent_at && !window.confirm(`${personName(person)} a-t-elle donné son accord explicite ? La date sera enregistrée.`)) return
    void onPatch(person, person.consent_at ? { status: 'authorized' } : { status: 'authorized', consent: true })
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-3">
      <div className="lbl">Actions administrateur</div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void onPatch(person, { display_name: name.trim() || null })
        }}
      >
        <label className="fld flex-[1_1_200px]">
          Nom affiché
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn">Renommer</button>
      </form>
      <div className="flex flex-wrap gap-2">
        {person.status !== 'authorized' && (
          <button type="button" className="btn" onClick={authorize}>
            Autoriser (accord requis)
          </button>
        )}
        {person.status !== 'denied' && (
          <button type="button" className="btn" onClick={() => void onPatch(person, { status: 'denied' })}>
            Marquer refusée
          </button>
        )}
        <button type="button" className="btn border-2 font-semibold" onClick={() => void onDelete(person)}>
          Effacer définitivement
        </button>
      </div>
    </div>
  )
}

interface EnrollResult {
  person_id: string | null
  status: 'authorized'
  embeddings: number | null
}

function EnrollForm({ onDone }: { onDone: (personId: string | null) => void }) {
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pendingName, setPendingName] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const displayName = name.trim()
    setBusy(true)
    setMessage(null)
    setPendingName(displayName)
    dialog.current?.showModal()
    try {
      // La réponse n'arrive qu'à la fin de la capture (20 s au plus).
      const result = await api.post<EnrollResult>('/persons/enroll', { display_name: displayName, consent: true })
      const count = result.embeddings
      setMessage(
        count ? `${displayName} enregistré(e) avec ${count} empreinte${count > 1 ? 's' : ''}.` : `${displayName} enregistré(e).`,
      )
      setName('')
      setConsent(false)
      onDone(result.person_id)
    } catch (err) {
      setMessage(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="Enregistrer une personne" className="card flex flex-wrap items-end gap-4">
      <div className="flex-[1_1_100%]">
        <h2 className="m-0 text-lg font-semibold">Enregistrer une personne autorisée</h2>
        <div className="text-sm text-muted">
          La personne se place seule, de face, devant la caméra du boîtier. Cinq empreintes sont capturées en 20 secondes au plus ; aucune photo n'est
          gardée.
        </div>
      </div>
      <label className="fld flex-[1_1_240px]">
        Nom
        <input required maxLength={64} placeholder="Prénom Nom" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex min-h-11 flex-[2_1_320px] items-center gap-2 text-sm">
        <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />
        La personne a donné son accord (date enregistrée)
      </label>
      <button className="btn btn-p" disabled={!consent || !name.trim() || busy}>
        {busy ? 'Capture en cours…' : 'Lancer la capture'}
      </button>
      {message && !busy && (
        <p className="m-0 flex-[1_1_100%] text-sm font-medium">
          {message}
        </p>
      )}

      {/* Fenêtre modale au centre de l'écran : le retour caméra est visible sans faire défiler. */}
      <dialog
        ref={dialog}
        aria-label="Capture du visage"
        onCancel={(e) => busy && e.preventDefault()}
        className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-lg border border-line bg-white p-5 text-ink backdrop:bg-ink/60"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 text-lg font-semibold">Enregistrement de {pendingName}</h2>
            {busy && <span className="pill pill-critical">Capture en cours</span>}
          </div>
          {busy ? (
            <>
              <p role="status" className="m-0 text-sm font-medium">
                Regardez la caméra du boîtier et bougez légèrement la tête.
              </p>
              <div className="aspect-video w-full overflow-hidden rounded-md bg-soft">
                <img src="/video/stream" alt="Flux de la caméra pendant l'enregistrement" className="h-full w-full object-cover" />
              </div>
            </>
          ) : (
            <p role="status" className="m-0 text-sm font-medium">
              {message}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" className="btn" disabled={busy} onClick={() => dialog.current?.close()}>
              Fermer
            </button>
          </div>
        </div>
      </dialog>
    </form>
  )
}
