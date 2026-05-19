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
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthCtx>({
  perfil: null,
  loading: true,
  refresh: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const p = await getPerfilActual()
      setPerfil(p)
    } catch {
      setPerfil(null)
    }
  }

  useEffect(() => {
    let active = true

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'TOKEN_REFRESHED' && !session) {
        supabase.auth.signOut().catch(() => {})
      }
      if (!session) {
        setPerfil(null)
        setLoading(false)
        return
      }
      setTimeout(() => {
        if (active) refresh().finally(() => setLoading(false))
      }, 0)
    })

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        if (error || !data.session) {
          supabase.auth.signOut().catch(() => {})
          setPerfil(null)
          setLoading(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Ctx.Provider value={{ perfil, loading, refresh }}>{children}</Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
