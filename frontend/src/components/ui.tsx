import type { ReactNode } from 'react'
import type { Severity } from '../api/types'
import { SEVERITY_LABELS } from '../lib/format'

export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="inline-flex size-9 items-center justify-center rounded-md border-2 border-ink text-sm font-bold">
        SX
      </span>
      <span className="text-lg font-bold">Sentinel-X</span>
    </span>
  )
}

export function Pill({ tone, children, className = '' }: { tone: Severity; children: ReactNode; className?: string }) {
  return <span className={`pill pill-${tone} ${className}`}>{children}</span>
}

export function SeverityPill({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Pill tone={severity} className={className}>
      {SEVERITY_LABELS[severity]}
    </Pill>
  )
}

export function PageTitle({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="m-0 text-[28px] font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 mb-0 text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null
  return (
    <div role="alert" className="rounded-lg border-2 border-ink bg-white px-4 py-3 text-sm font-medium">
      {message}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-3 text-sm text-muted">{children}</div>
}

export function Dot({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2.5 rounded-full border-2 border-ink ${filled ? 'bg-ink' : 'bg-white'}`}
    />
  )
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const SoundIcon = () => (
  <svg {...iconProps}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </svg>
)

export const BellIcon = () => (
  <svg {...iconProps}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
)

export const DownloadIcon = () => (
  <svg {...iconProps}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)

export const ShieldIcon = () => (
  <svg {...iconProps} width={22} height={22} className="shrink-0">
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" />
  </svg>
)

export const PersonIcon = ({ size = 22 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size} stroke="#5A5A5A">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
  </svg>
)
