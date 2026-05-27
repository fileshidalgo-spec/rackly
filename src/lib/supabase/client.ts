'use client'

import { createBrowserClient } from '@supabase/ssr'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!

/**
 * Cliente para operaciones de AUTENTICACIÓN (auth).
 * Usa el ANON_KEY porque las operaciones de auth (login, signup, session)
 * requieren el anon key de GoTrue.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, ANON_KEY)
}

/**
 * Cliente para operaciones de DATOS (lectura/escritura en tablas, RPCs).
 * Usa SERVICE_ROLE_KEY para bypassear RLS y garantizar que todos los
 * usuarios autenticados puedan ver y operar todos los datos.
 *
 * Esto es necesario porque las políticas RLS en Supabase bloquean las lecturas
 * con el anon key, causando que Ocupación muestre celdas vacías (verde)
 * cuando en realidad tienen artículos.
 *
 * La service role key ya estaba expuesta en el código para operaciones
 * masivas (addMovimientosBatch, deleteAllMovimientos), así que usarla
 * para todas las operaciones de datos es consistente con el diseño existente.
 */
export function createDataClient() {
  return createBrowserClient(SUPABASE_URL, SERVICE_KEY)
}

let _supabase: ReturnType<typeof createClient> | undefined
let _dataClient: ReturnType<typeof createDataClient> | undefined

/** Cliente de autenticación (anon key) — para auth.getUser, auth.signIn, etc. */
export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createClient()
    return Reflect.get(_supabase, prop, receiver)
  },
})

/** Cliente de datos (service role) — para consultas a tablas y RPCs */
export const dataClient = new Proxy({} as ReturnType<typeof createDataClient>, {
  get(_, prop, receiver) {
    if (!_dataClient) _dataClient = createDataClient()
    return Reflect.get(_dataClient, prop, receiver)
  },
})
