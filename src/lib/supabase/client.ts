'use client'

import { createBrowserClient } from '@supabase/ssr'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const SERVICE_KEY = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ?? ''

/** Verifica si la configuración de Supabase está completa */
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && ANON_KEY)
}

/** Retorna un mensaje de error si falta configuración */
export function getMissingConfigMessage(): string | null {
  const missing: string[] = []
  if (!SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!ANON_KEY) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  if (!SERVICE_KEY) missing.push('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length === 0) return null
  return `[RACKLY] Variables faltantes en el build: ${missing.join(', ')}. Agrégalas en Cloudflare Pages → Settings → Environment variables.`
}

function safeCreateClient() {
  try {
    if (!SUPABASE_URL || !ANON_KEY) {
      console.error(getMissingConfigMessage())
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
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error(getMissingConfigMessage())
      return null
    }
    return createBrowserClient(SUPABASE_URL, SERVICE_KEY)
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

/** Cliente de datos (service role) — seguro ante config faltante */
export const dataClient = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_, prop, receiver) {
    if (!_dataClient) _dataClient = safeCreateDataClient()
    if (!_dataClient) {
      const configError = getMissingConfigMessage() ?? 'Supabase no configurado'
      if (prop === 'from') {
        return (table: string) => new Proxy({}, {
          get(__, method) {
            return (...args: unknown[]) => {
              console.error(`[RACKLY] dataClient.${table}.${String(method)}() llamado sin config válida`)
              return Promise.resolve({ data: null, error: { message: configError } })
            }
          }
        })
      }
      if (prop === 'rpc') {
        return (fn: string, ...args: unknown[]) => {
          console.error(`[RACKLY] dataClient.rpc('${fn}') llamado sin config válida`)
          return Promise.resolve({ data: null, error: { message: configError } })
        }
      }
      console.error(`[RACKLY] dataClient.${String(prop)} accedido sin config válida`)
      return undefined
    }
    const value = Reflect.get(_dataClient, prop, receiver)
    if (typeof value === 'function') {
      return value.bind(_dataClient)
    }
    return value
  },
})