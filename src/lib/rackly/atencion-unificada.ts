/**
 * RACKLY — Lista UNIFICADA de Atención (RQ + RAL en una sola lista).
 *
 * Qué pidió el usuario (módulo Atención, 2026-10-30): «la atención de RAL
 * debe ser el mismo modelo que para la atención de RQ y todo debe aparecer
 * en UNA sola lista — quizás con una distinción que diga RAL — para poder
 * filtrar más rápido y hacer las búsquedas más rápido».
 *
 * Las TABLAS siguen separadas (rals/ral_items vs rq_atenciones/rq_atencion_items
 * — el usuario lo acepta: «tienen otras tablas con datos distintos») y cada
 * capa de datos mantiene su aislamiento; la UNIÓN vive solo en esta capa de
 * presentación:
 *
 *   · Las RQ llegan ya filtradas del servidor (listarRqs — búsqueda en
 *     encabezado + materiales, paginadas).
 *   · Los RAL se cargan COMPLETOS (listarRals — volumen pequeño por jornada)
 *     y se filtran aquí con los MISMOS filtros del panel:
 *       - búsqueda: encabezado + texto de materiales (textoItems).
 *       - estado:   ahora el RAL tiene estado (modelo de atención unificado).
 *       - fecha:    exacta, igual que la columna.
 *       - turno:    el RAL NO tiene turno (no es hoja de producción) → cuando
 *                   el filtro de turno está activo, los RAL no participan.
 *   · El orden resultante es fecha DESC con created_at DESC de desempate:
 *     la lista mezclada se lee igual que la lista de RQ actual.
 *
 * Lógica PURA (sin supabase) para poder testearla sin red.
 */

import type { RalRegistro } from '@/lib/rackly/ral'
import type { RqAtencion } from '@/lib/rackly/rq-atencion'

/** Fila de la lista unificada: unión discriminada RQ | RAL. */
export type FilaUnificada =
  | { tipo: 'RQ'; key: string; rq: RqAtencion }
  | { tipo: 'RAL'; key: string; ral: RalRegistro }

/** Filtros del panel, tal cual los maneja RqAtencionPanel. */
export type FiltrosUnificados = {
  /** Término libre (ya normalizado por la UI: trim). */
  busqueda: string
  /** '' | 'todos' | 'Pendiente' | 'En proceso' | 'Atendido'. */
  estado: string
  /** YYYY-MM-DD o ''. */
  fecha: string
  /** '' | 'todos' | 'T1' | 'T2' — SOLO RQ (el RAL no tiene turno). */
  turno: string
}

/** Texto de búsqueda de un RAL: encabezado + materiales (textoItems). */
export function textoBusquedaRal(r: RalRegistro): string {
  return [
    r.documento,
    r.transaccion,
    r.areaSolicitante,
    r.solicitante,
    r.aprobadoPor,
    r.almacen,
    r.linea,
    r.textoItems,
  ]
    .join(' ')
    .toLowerCase()
}

/** ¿El RAL pasa los filtros del panel? (los RQ llegan ya filtrados del server). */
export function coincideFiltroRal(r: RalRegistro, f: FiltrosUnificados): boolean {
  // Turno: el RAL no tiene turno → solo participa cuando el filtro está cerrado.
  if (f.turno && f.turno !== 'todos') return false

  const estado = f.estado && f.estado !== 'todos' ? f.estado : ''
  if (estado && r.estado !== estado) return false

  if (f.fecha && r.fecha !== f.fecha) return false

  const q = f.busqueda.trim().toLowerCase()
  if (q && !textoBusquedaRal(r).includes(q)) return false

  return true
}

/** Conteos del resumen rápido sobre la lista unificada cargada. */
export function conteosEstado(filas: FilaUnificada[]): {
  pendientes: number
  enProceso: number
  atendidas: number
} {
  let pendientes = 0
  let enProceso = 0
  let atendidas = 0
  for (const f of filas) {
    const estado = f.tipo === 'RQ' ? f.rq.estado : f.ral.estado
    if (estado === 'Pendiente') pendientes += 1
    else if (estado === 'En proceso') enProceso += 1
    else if (estado === 'Atendido') atendidas += 1
  }
  return { pendientes, enProceso, atendidas }
}

/**
 * Une RQs + RALs en UNA lista ordenada (fecha DESC, created_at DESC):
 *   · `rqs` ya vienen filtradas/paginadas del servidor.
 *   · `rals` se filtran aquí con coincideFiltroRal.
 * `key` es el id de la fila (ambas tablas usan uuid — sin colisiones).
 */
export function unirFilasAtencion(
  rqs: RqAtencion[],
  rals: RalRegistro[],
  filtros: FiltrosUnificados
): FilaUnificada[] {
  const filas: FilaUnificada[] = [
    ...rqs.map(
      (rq): FilaUnificada => ({ tipo: 'RQ', key: rq.id, rq })
    ),
    ...rals
      .filter((ral) => coincideFiltroRal(ral, filtros))
      .map((ral): FilaUnificada => ({ tipo: 'RAL', key: ral.id, ral })),
  ]
  filas.sort((a, b) => {
    const fa = a.tipo === 'RQ' ? a.rq.fecha : a.ral.fecha
    const fb = b.tipo === 'RQ' ? b.rq.fecha : b.ral.fecha
    if (fa !== fb) return fa < fb ? 1 : -1 // fecha DESC
    const ca = a.tipo === 'RQ' ? a.rq.createdAt : a.ral.createdAt
    const cb = b.tipo === 'RQ' ? b.rq.createdAt : b.ral.createdAt
    return ca < cb ? 1 : ca > cb ? -1 : 0 // desempate: más nuevo primero
  })
  return filas
}
