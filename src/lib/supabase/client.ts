'use client'

import { createBrowserClient } from '@supabase/ssr'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
// FIX auditoría 2026-10-21 (P1): la service_role key NUNCA debe entrar al
// bundle del navegador — cualquiera con DevTools obtenía control total de la
// BD (RLS bypaseada). Toda la app opera ahora con el cliente anon + JWT de
// sesión (rol authenticated, cubierto por las políticas RLS) y las pocas
// operaciones admin (GoTrue/Storage) van por Edge Function o sesión de usuario.

const ES_DEV = process.env.NODE_ENV === 'development'

/** Verifica si la configuración de Supabase está completa */
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && ANON_KEY)
}

/** Retorna un mensaje de error si falta configuración */
export function getMissingConfigMessage(): string | null {
  const missing: string[] = []
  if (!SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!ANON_KEY) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  if (missing.length === 0) return null
  // B-3 (auditoría): en producción solo un aviso genérico — los nombres
  // internos de variables y la guía de configuración quedan en desarrollo.
  if (!ES_DEV) {
    return 'Configuración interna incompleta: la aplicación no puede conectarse. Contacta al administrador.'
  }
  return `[RACKLY] Variables faltantes en el build: ${missing.join(', ')}. Agrégalas en Cloudflare Pages → Settings → Environment variables.`
}

function safeCreateClient() {
  try {
    if (!SUPABASE_URL || !ANON_KEY) {
      if (ES_DEV) console.error(getMissingConfigMessage())
      return null
    }
    return createBrowserClient(SUPABASE_URL, ANON_KEY)
  } catch (err) {
    console.error('[RACKLY] Error creando cliente Supabase:', err)
    return null
  }
}

function safeCreateDataClient() {
  try {
    if (!SUPABASE_URL || !ANON_KEY) {
      if (ES_DEV) console.error(getMissingConfigMessage())
      return null
    }
    // FIX auditoría 2026-10-21 (P1): antes usaba SERVICE_KEY (RLS bypaseada
    // desde el navegador). Ahora usa ANON_KEY: con la sesión iniciada, las
    // consultas viajan con el JWT del usuario (rol authenticated) y las
    // políticas RLS de las tablas operativas aplican de verdad.
    return createBrowserClient(SUPABASE_URL, ANON_KEY)
  } catch (err) {
    console.error('[RACKLY] Error creando data client Supabase:', err)
    return null
  }
}

let _supabase: ReturnType<typeof createBrowserClient> | null = null
let _dataClient: ReturnType<typeof createBrowserClient> | null = null

/** Cliente de autenticación (anon key) — seguro ante config faltante */
export const supabase = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = safeCreateClient()
    if (!_supabase) {
      // Retorna funciones no-op para que la app no crashee
      if (prop === 'auth') {
        return new Proxy({}, {
          get(__, authProp) {
            if (typeof authProp === 'string' && authProp.startsWith('on')) {
              // onAuthStateChange, etc. → retornar { data: { subscription: { unsubscribe: () => {} } } }
              return () => ({ data: { subscription: { unsubscribe: () => {} } } })
            }
            if (typeof authProp === 'string') {
              return () => Promise.resolve({ data: null, error: { message: getMissingConfigMessage() ?? 'Supabase no configurado' } })
            }
            return undefined
          }
        })
      }
      return undefined
    }
    const value = Reflect.get(_supabase, prop, receiver)
    if (typeof value === 'function') {
      return value.bind(_supabase)
    }
    return value
  },
})

/** Cliente de datos (anon + JWT de sesión, respeta RLS) — seguro ante config faltante */
export const dataClient = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_, prop, receiver) {
    if (!_dataClient) _dataClient = safeCreateDataClient()
    if (!_dataClient) {
      const configError = getMissingConfigMessage() ?? 'Supabase no configurado'
      if (prop === 'from') {
        return (table: string) => new Proxy({}, {
          get(__, method) {
            return (...args: unknown[]) => {
              if (ES_DEV) console.error(`[RACKLY] dataClient.${table}.${String(method)}() llamado sin config válida`)
              return Promise.resolve({ data: null, error: { message: configError } })
            }
          }
        })
      }
      if (prop === 'rpc') {
        return (fn: string, ...args: unknown[]) => {
          if (ES_DEV) console.error(`[RACKLY] dataClient.rpc('${fn}') llamado sin config válida`)
          return Promise.resolve({ data: null, error: { message: configError } })
        }
      }
      if (ES_DEV) console.error(`[RACKLY] dataClient.${String(prop)} accedido sin config válida`)
      return undefined
    }
    const value = Reflect.get(_dataClient, prop, receiver)
    if (typeof value === 'function') {
      return value.bind(_dataClient)
    }
    return value
  },
})