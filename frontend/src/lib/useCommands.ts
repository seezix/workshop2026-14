import { useCallback, useState } from 'react'
import { api, DEVICE_ID, errorMessage } from '../api/client'
import type { Command, CommandInput } from '../api/types'
import { useStreamEvent } from '../live/stream'
import { useApi } from './useApi'

/** Historique des commandes + envoi (POST → 202 pending, puis SSE command.updated). */
export function useCommands(limit: number) {
  const list = useApi(() => api.get<Command[]>(`/devices/${DEVICE_ID}/commands`, { limit }), [limit])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { reload, setData } = list

  useStreamEvent<Command>('command.updated', (cmd) => {
    if (cmd.device_id !== DEVICE_ID) return
    setData((prev) => {
      if (!prev) return prev
      return prev.some((c) => c.cmd_id === cmd.cmd_id)
        ? prev.map((c) => (c.cmd_id === cmd.cmd_id ? cmd : c))
        : [cmd, ...prev].slice(0, limit)
    })
  })

  const send = useCallback(
    async (input: CommandInput) => {
      setSending(true)
      setError(null)
      try {
        await api.post<{ cmd_id: string; status: string }>(`/devices/${DEVICE_ID}/commands`, input)
        reload()
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setSending(false)
      }
    },
    [reload],
  )

  return { commands: list.data ?? [], loadError: list.error, send, sending, error }
}
