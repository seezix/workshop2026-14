import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setUnauthorizedHandler } from '../api/client'
import type { LoginResponse, Role, User } from '../api/types'
import { AuthContext, hasRole } from './context'

// Seuls le profil et l'échéance sont gardés côté JS ; le jeton reste dans le cookie httpOnly.
const STORAGE_KEY = 'sx_user'

interface Stored {
  user: User
  expires_at: number
}

function readStored(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as Stored
    return stored.expires_at > Date.now() ? stored.user : null
  } catch {
    return null
  }
}

function writeStored(value: Stored | null) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* stockage indisponible : la session ne survivra pas au rechargement */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readStored)

  const clear = useCallback(() => {
    writeStored(null)
    setUser(null)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(clear)
    return () => setUnauthorizedHandler(undefined)
  }, [clear])

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<LoginResponse>('/auth/login', { username, password })
    writeStored({ user: res.user, expires_at: Date.now() + res.expires_in * 1000 })
    setUser(res.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } finally {
      clear()
    }
  }, [clear])

  const can = useCallback((role: Role) => (user ? hasRole(user.role, role) : false), [user])

  const value = useMemo(() => ({ user, login, logout, can }), [user, login, logout, can])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
