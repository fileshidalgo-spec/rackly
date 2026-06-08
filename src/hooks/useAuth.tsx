'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '@/lib/supabase/client'
import { getPerfilActual, type Perfil } from '@/lib/rackly/auth'

type AuthCtx = {
  perfil: Perfil | null
  loading: boolean
  refresh: () => Promise<Perfil | null>
  passwordRecovery: boolean
  clearPasswordRecovery: () => void
}

const Ctx = createContext<AuthCtx>({
  perfil: null,
  loading: true,
  refresh: async () => null,
  passwordRecovery: false,
  clearPasswordRecovery: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [loading, setLoading] = useState(true)
  const [passwordRecovery, setPasswordRecovery] = useState(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash
      if (hash.includes('type=recovery') || hash.includes('type=_recovery')) {
        console.log('[RACKLY] Tokens de recuperación detectados en URL')
        return true
      }
    }
    return false
  })

  async function refresh(): Promise<Perfil | null> {
    try {
      const p = await getPerfilActual()
      setPerfil(p)
      return p
    } catch (err) {
      console.error('[RACKLY] Error cargando perfil:', err)
      setPerfil(null)
      return null
    }
  }

  useEffect(() => {
    let active = true

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      console.log('[RACKLY] Auth event:', event)
      // Detectar flujo de recuperación de contraseña
      if (event === 'PASSWORD_RECOVERY') {
        console.log('[RACKLY] PASSWORD_RECOVERY detectado')
        setPasswordRecovery(true)
        if (!session) {
          setPerfil(null)
          setLoading(false)
          return
        }
      }
      if (event === 'TOKEN_REFRESHED' && !session) {
        supabase.auth.signOut().catch(() => {})
      }
      if (!session) {
        setPerfil(null)
        setLoading(false)
        return
      }
      // No usar setTimeout — llamar refresh directamente para evitar race conditions
      refresh().finally(() => {
        if (active) setLoading(false)
      })
    })

    // getSession() procesa los tokens del hash automáticamente
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        console.log('[RACKLY] getSession:', error ? error.message : 'OK', 'session:', !!data.session)
        if (error || !data.session) {
          // Si no hay sesión pero hay tokens de recovery en la URL, mostrar formulario
          const h = window.location.hash
          if (h.includes('type=recovery') || h.includes('type=_recovery')) {
            setPasswordRecovery(true)
            setLoading(false)
          } else {
            supabase.auth.signOut().catch(() => {})
            setPerfil(null)
            setLoading(false)
          }
        } else {
          refresh().finally(() => setLoading(false))
        }
      })
      .catch(() => {
        if (!active) return
        supabase.auth.signOut().catch(() => {})
        setPerfil(null)
        setLoading(false)
      })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  function clearPasswordRecovery() {
    setPasswordRecovery(false)
  }

  return (
    <Ctx.Provider value={{ perfil, loading, refresh, passwordRecovery, clearPasswordRecovery }}>{children}</Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
