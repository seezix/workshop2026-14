import { createContext, useContext } from 'react'
import type { Role, User } from '../api/types'

export interface AuthValue {
  user: User | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Le rôle de l'utilisateur atteint-il `role` ? */
  can: (role: Role) => boolean
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth hors de <AuthProvider>')
  return value
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }
export const hasRole = (actual: Role, required: Role) => RANK[actual] >= RANK[required]
