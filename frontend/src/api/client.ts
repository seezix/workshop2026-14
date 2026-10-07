// Client REST. Le JWT voyage dans le cookie httpOnly posé par /auth/login
// (même origine via le proxy Vite / nginx) : rien n'est stocké côté JS.

export const API_BASE = '/api/v1'

/** Le dashboard ne pilote qu'un boîtier (GUIDELINES §1). */
export const DEVICE_ID: string = import.meta.env.VITE_DEVICE_ID ?? 'SX-001'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

let onUnauthorized: (() => void) | undefined

/** Appelé quand l'API répond 401 (session expirée). */
export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  onUnauthorized = handler
}

type Query = Record<string, string | number | boolean | undefined | null>

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 204) return undefined as T
  const data: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    // Format unique (GUIDELINES §6.5) : { error: { code, message, details } }
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.()
    throw new ApiError(
      res.status,
      err?.code ?? 'INTERNAL_ERROR',
      err?.message ?? `Erreur ${res.status}`,
      err?.details,
    )
  }
  return data as T
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

/** Message lisible pour l'interface. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'DEVICE_OFFLINE':
        return 'Boîtier hors ligne : envoi impossible.'
      case 'FORBIDDEN':
        return 'Droits insuffisants pour cette action.'
      case 'RATE_LIMITED':
        return 'Trop de tentatives, réessayez dans une minute.'
      default:
        return err.message
    }
  }
  return 'API injoignable.'
}
