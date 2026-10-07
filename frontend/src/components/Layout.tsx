import { Link, NavLink, Outlet } from 'react-router-dom'
import { DEVICE_ID } from '../api/client'
import { useAuth } from '../auth/context'
import { ROLE_LABELS, initials } from '../lib/format'
import { useLive } from '../live/context'
import { useStreamState } from '../live/stream'
import { Dot, Logo, Pill, SoundIcon } from './ui'

const NAV = [
  { to: '/', label: "Vue d'ensemble", end: true },
  { to: '/alertes', label: 'Alertes' },
  { to: '/historique', label: 'Historique' },
  { to: '/personnes', label: 'Personnes' },
  { to: '/boitier', label: 'Boîtier' },
]

function Header() {
  const { user, logout } = useAuth()
  const { device, soundOn, toggleSound } = useLive()
  const online = device?.status === 'online'
  const armed = device?.config.armed

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-white px-6 py-2.5">
      <Link to="/" className="text-ink no-underline">
        <Logo />
      </Link>
      <div className="flex flex-wrap items-center gap-2.5 text-sm">
        <span className="rounded border border-line px-2 py-0.5 font-mono">{DEVICE_ID}</span>
        <span className="inline-flex items-center gap-1.5">
          <Dot filled={online} />
          {device ? (online ? 'En ligne' : 'Hors ligne') : 'État inconnu'}
        </span>
        {armed !== undefined && (
          <Pill tone={armed ? 'critical' : 'warning'}>{armed ? 'Surveillance armée' : 'Surveillance désarmée'}</Pill>
        )}
      </div>
      <div className="flex-1" />
      <button type="button" className="btn" onClick={toggleSound} aria-pressed={soundOn}>
        <SoundIcon />
        {soundOn ? 'Alertes sonores activées' : 'Activer les alertes sonores'}
      </button>
      {user && (
        <div className="flex items-center gap-2.5 text-sm">
          <span className="inline-flex size-9 items-center justify-center rounded-full bg-soft font-semibold">
            {initials(user.username)}
          </span>
          <span className="flex flex-col">
            <span className="font-semibold">{user.username}</span>
            <span className="text-[13px] text-muted">{ROLE_LABELS[user.role]}</span>
          </span>
          <button type="button" className="btn ml-1" onClick={() => void logout()}>
            Déconnexion
          </button>
        </div>
      )}
    </header>
  )
}

function Nav() {
  const { openAlerts, device } = useLive()
  const stream = useStreamState()
  const hasCritical = openAlerts.some((a) => a.severity === 'critical')

  return (
    <nav aria-label="Navigation principale" className="flex flex-[1_1_200px] flex-col gap-1 self-start">
      {NAV.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className="nv">
          {item.label}
          {item.to === '/alertes' && openAlerts.length > 0 && (
            <Pill tone={hasCritical ? 'critical' : 'info'}>{openAlerts.length}</Pill>
          )}
        </NavLink>
      ))}
      <div className="mt-4 rounded-md border border-dashed border-line p-3 text-[13px] text-muted">
        <div className="flex items-center gap-1.5 font-medium text-ink">
          <Dot filled={stream === 'open'} />
          {stream === 'open' ? 'Temps réel connecté' : stream === 'connecting' ? 'Connexion au temps réel…' : 'Temps réel coupé'}
        </div>
        {device && (
          <div>
            {device.config.interval_s <= 5 ? 'Mode démo' : 'Mode production'} : envoi toutes les {device.config.interval_s} s
          </div>
        )}
      </div>
    </nav>
  )
}

export function Layout() {
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto flex max-w-[1440px] flex-wrap gap-6 p-6">
        <Nav />
        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
