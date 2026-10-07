// Flux SSE GET /api/v1/stream (GUIDELINES §6.4) : une seule connexion
// partagée par toute l'application, authentifiée par le cookie httpOnly.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { API_BASE } from '../api/client'

export type StreamEventType =
  | 'telemetry.new'
  | 'device_event.new'
  | 'alert.created'
  | 'alert.updated'
  | 'device.status'
  | 'command.updated'
  | 'anomaly.score'

const EVENT_TYPES: StreamEventType[] = [
  'telemetry.new',
  'device_event.new',
  'alert.created',
  'alert.updated',
  'device.status',
  'command.updated',
  'anomaly.score',
]

export type StreamState = 'connecting' | 'open' | 'closed'

type Handler = (data: unknown) => void

const handlers = new Map<StreamEventType, Set<Handler>>()
const stateListeners = new Set<() => void>()
let source: EventSource | null = null
let state: StreamState = 'closed'
let retryTimer: ReturnType<typeof setTimeout> | undefined

function setState(next: StreamState) {
  if (state === next) return
  state = next
  stateListeners.forEach((l) => l())
}

export function connectStream() {
  if (source) return
  clearTimeout(retryTimer)
  setState('connecting')
  const es = new EventSource(`${API_BASE}/stream`, { withCredentials: true })
  source = es
  es.onopen = () => setState('open')
  es.onerror = () => {
    // EventSource se reconnecte seul tant qu'il n'est pas CLOSED (ex. 401 ou 502).
    if (es.readyState === EventSource.CLOSED) {
      source = null
      setState('closed')
      retryTimer = setTimeout(connectStream, 5_000)
    } else {
      setState('connecting')
    }
  }
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (ev) => {
      let data: unknown
      try {
        data = JSON.parse((ev as MessageEvent<string>).data)
      } catch {
        return
      }
      handlers.get(type)?.forEach((h) => h(data))
    })
  }
}

export function disconnectStream() {
  clearTimeout(retryTimer)
  source?.close()
  source = null
  setState('closed')
}

function subscribe(type: StreamEventType, handler: Handler) {
  let set = handlers.get(type)
  if (!set) handlers.set(type, (set = new Set()))
  set.add(handler)
  return () => {
    set.delete(handler)
  }
}

/** Appelle `handler` à chaque événement `type` reçu (dernière version du handler). */
export function useStreamEvent<T>(type: StreamEventType, handler: (data: T) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => subscribe(type, (d) => ref.current(d as T)), [type])
}

export function useStreamState(): StreamState {
  return useSyncExternalStore(
    (l) => {
      stateListeners.add(l)
      return () => stateListeners.delete(l)
    },
    () => state,
  )
}
