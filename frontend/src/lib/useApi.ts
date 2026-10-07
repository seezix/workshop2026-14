import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../api/client'

export interface ApiState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => void
  setData: (update: (prev: T | undefined) => T | undefined) => void
}

type Dep = string | number | boolean | null | undefined

interface Loaded<T> {
  key: string | null
  data: T | undefined
  error: string | null
}

/**
 * Charge `load()` au montage et à chaque changement de `deps`.
 * Les données précédentes restent affichées pendant le rechargement.
 */
export function useApi<T>(load: () => Promise<T>, deps: Dep[]): ApiState<T> {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<Loaded<T>>({ key: null, data: undefined, error: null })
  const key = JSON.stringify([...deps, tick])
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let cancelled = false
    loadRef.current().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (err: unknown) => !cancelled && setState((s) => ({ key, data: s.data, error: errorMessage(err) })),
    )
    return () => {
      cancelled = true
    }
  }, [key])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setData = useCallback(
    (update: (prev: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: update(s.data) })),
    [],
  )
  return { data: state.data, error: state.error, loading: state.key !== key, reload, setData }
}

/** Force un rendu toutes les `ms` (libellés « il y a 3 s »). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
