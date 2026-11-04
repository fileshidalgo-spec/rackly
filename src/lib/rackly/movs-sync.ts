/**
 * RACKLY — Motor de sincronización INCREMENTAL del dataset de movimientos.
 *
 * Contexto (rendimiento 2026-11-04): el dataset completo de `movimientos`
 * superó las 28K filas (~14.5 MB en JSON). El mecanismo anterior re-descargaba
 * la TABLA ENTERA (≈21 s medidos en red real) cada vez que cualquier usuario
 * escribía algo y cada vez que se montaba FEFO/Traslado/Stock/Movimientos.
 * Esta librería concentra la lógica PURA de fusión de deltas:
 *
 *  - fusionarDeltas()      → upsert de filas nuevas/actualizadas (realtime
 *                            postgres_changes o fetch incremental por marca
 *                            de agua f_modificacion)
 *  - eliminarPorIds()      → aplica eventos DELETE (payload.old.id)
 *  - ordenarMovs()         → re-ordena según el contrato global del dataset
 *                            (f_modificacion DESC, id ASC — igual que
 *                            fetchMovimientos) para que ninguna pestaña note
 *                            la diferencia entre descarga completa y delta
 *  - marcaAgua()           → máximo f_modificacion del dataset; es el punto
 *                            de corte del fetch incremental siguiente
 *
 * Todo es puro y sin I/O: testeable en node (scripts/test_movs_sync_delta.js)
 * y reutilizable por el hook singleton useMovimientosRealtime.
 */
import type { Movimiento } from './kardex'

/** Comparación del orden global: f_modificacion DESC, id ASC (contrato fetchMovimientos). */
function compararGlobal(a: Movimiento, b: Movimiento): number {
  const fa = a.fModificacion ?? ''
  const fb = b.fModificacion ?? ''
  if (fa !== fb) return fa < fb ? 1 : -1 // DESC
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 // ASC
}

/** Reordena el dataset según el contrato global (muta y retorna la misma lista). */
export function ordenarMovs(movs: Movimiento[]): Movimiento[] {
  movs.sort(compararGlobal)
  return movs
}

/**
 * Upsert de deltas sobre el caché: INSERT/UPDATE de realtime o filas del
 * fetch incremental. La fila delta SIEMPRE gana (estado más reciente de BD).
 * Retorna NUEVA lista (no muta el caché de entrada).
 */
export function fusionarDeltas(cache: Movimiento[], deltas: Movimiento[]): Movimiento[] {
  if (deltas.length === 0) return cache
  const mapa = new Map(cache.map((m) => [m.id, m]))
  for (const d of deltas) mapa.set(d.id, d)
  return ordenarMovs(Array.from(mapa.values()))
}

/** Elimina filas por id (eventos DELETE de realtime). Retorna NUEVA lista;
 * si ningún id coincide retorna la MISMA referencia (no-op sin difusión). */
export function eliminarPorIds(cache: Movimiento[], ids: string[]): Movimiento[] {
  if (ids.length === 0) return cache
  const borrar = new Set(ids)
  const salida = cache.filter((m) => !borrar.has(m.id))
  return salida.length === cache.length ? cache : salida
}

/**
 * Marca de agua: máximo f_modificacion del dataset (ISO lexicográfico es
 * cronológico). El fetch incremental siguiente pide solo f_modificacion >
 * marca de agua. null si el dataset está vacío.
 */
export function marcaAgua(movs: Movimiento[]): string | null {
  let max: string | null = null
  for (const m of movs) {
    const f = m.fModificacion ?? ''
    if (f && (max === null || f > max)) max = f
  }
  return max
}

/** Tamaño de una fusión delta (para logs/telemetría). */
export function resumenDelta(cache: Movimiento[], deltas: Movimiento[]): {
  antes: number
  despues: number
  nuevos: number
} {
  const idsCache = new Set(cache.map((m) => m.id))
  const nuevos = deltas.filter((d) => !idsCache.has(d.id)).length
  return { antes: cache.length, despues: cache.length + nuevos, nuevos }
}
