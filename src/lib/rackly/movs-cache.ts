/**
 * RACKLY — Persistencia del dataset de movimientos (caché de sesión durable).
 *
 * Rendimiento 2026-11-05: el caché del singleton useMovimientosRealtime vivía
 * SOLO en memoria a nivel de módulo — cada recarga de página (F5), cierre de
 * navegador o vuelta a la app re-descargaba la tabla completa de movimientos
 * (28K+ filas ≈ 14.5 MB ≈ 21 s en red real) ANTES de mostrar un solo dato en
 * FEFO/Stock/Traslado/Descarga. Este módulo guarda el dataset en IndexedDB
 * para que el hook lo siembre al instante («arranque caliente») y lo
 * valide/actualice en segundo plano por delta (marca de agua f_modificacion).
 *
 * Diseño:
 *  - IndexedDB (no localStorage): el dataset ronda los 15 MB; localStorage
 *    queda corto (~5 MB) además de ser síncrono y bloquear el hilo.
 *  - Payload versionado (SCHEMA): si el formato cambia o llega algo
 *    incompatible, el caché se descarta — jamás se siembran datos viejos.
 *  - Tolerante a fallos de punta a punta: sin IndexedDB (SSR/tests), cuota
 *    excedida o payload corrupto → null/false y el hook cae al camino frío
 *    actual (descarga completa), sin romper nada.
 *  - Seguridad: se guardan datos de inventario del MISMO origen (same-origin,
 *    perfil del navegador del propio usuario); ninguna credencial; el acceso
 *    a datos sigue gobernado por RLS en la BD.
 */

/** Versión del formato del caché persistido. Subir si cambia el shape de
 * Movimiento o la semántica de marcaAgua — invalida los cachés viejos. */
export const CACHE_MOVS_SCHEMA = 1

const DB_NAME = 'rackly-cache'
const STORE = 'kv'
const KEY = 'movimientos'

/** Payload tal como se guarda en IndexedDB (movs es Movimiento[] en la
 * práctica; `unknown[]` evita el import circular con kardex.ts). */
export type CacheGuardado = {
  schema: number
  movs: unknown[]
  marcaAgua: string | null
  guardadoEn: number
}

/** Validación PURA del payload leído (testeable en node sin IndexedDB):
 * descarta cachés de otra versión, vacíos o malformados. */
export function validarCacheGuardado(valor: unknown): CacheGuardado | null {
  if (!valor || typeof valor !== 'object') return null
  const c = valor as CacheGuardado
  if (c.schema !== CACHE_MOVS_SCHEMA) return null
  if (!Array.isArray(c.movs) || c.movs.length === 0) return null
  if (typeof c.guardadoEn !== 'number' || !isFinite(c.guardadoEn)) return null
  if (c.marcaAgua !== null && typeof c.marcaAgua !== 'string') return null
  // Los ids son la columna vertebral del delta (upsert/eliminación por id):
  // un payload sin ids es inservible para fusionarDeltas.
  const primero = c.movs[0] as { id?: unknown } | null
  if (!primero || typeof primero !== 'object' || typeof primero.id !== 'string') return null
  return c
}

function idbDisponible(): boolean {
  return typeof indexedDB !== 'undefined'
}

/** Abre la BD (o null si no hay IndexedDB / falla — nunca lanza). */
function abrirDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!idbDisponible()) return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** Lee el dataset persistido — null si no existe, es incompatible o falla. */
export async function leerCacheMovs(): Promise<CacheGuardado | null> {
  const db = await abrirDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        db.close()
        resolve(validarCacheGuardado(req.result))
      }
      req.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      try { db.close() } catch { /* ignore */ }
      resolve(null)
    }
  })
}

/** Guarda el dataset + marca de agua (silent-fail: si la cuota o la BD
 * fallan, la app simplemente sigue con el caché en memoria). */
export async function guardarCacheMovs(
  movs: unknown[],
  marcaAgua: string | null
): Promise<boolean> {
  if (!Array.isArray(movs) || movs.length === 0) return false
  const db = await abrirDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const payload: CacheGuardado = {
        schema: CACHE_MOVS_SCHEMA,
        movs,
        marcaAgua,
        guardadoEn: Date.now(),
      }
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(payload, KEY)
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onerror = () => {
        db.close()
        resolve(false)
      }
      tx.onabort = () => {
        db.close()
        resolve(false)
      }
    } catch {
      try { db.close() } catch { /* ignore */ }
      resolve(false)
    }
  })
}

/** Borra el caché persistido (camino de reparación). */
export async function borrarCacheMovs(): Promise<boolean> {
  const db = await abrirDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onerror = () => {
        db.close()
        resolve(false)
      }
    } catch {
      try { db.close() } catch { /* ignore */ }
      resolve(false)
    }
  })
}
