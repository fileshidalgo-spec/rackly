// ═══════════════════════════════════════════════════════════════════
// HONESTIDAD DE LOS BORRADOS — helper compartido por TODOS los módulos
// (bug T173-00004281 generalizado; auditoría 2026-10-31, Módulos: todos)
// ═══════════════════════════════════════════════════════════════════
//
// BUG REAL (2026-10-30, recepción): la política RLS de DELETE por rol
// FILTRA EN SILENCIO — HTTP 200, 0 filas borradas, SIN error. Cualquier
// `.delete()` sin verificación de efecto es un ÉXITO FALSO: la app cree
// que borró, la fila sigue viva y el flujo se corrompe (la guía se
// DUPLICABA al re-agregar artículos: 16→23→36→50→63 filas).
//
// Esta clase de defecto existía en TODAS las tablas con DELETE por rol
// (pg_policies 2026-10-31): rq_atenciones, rq_atencion_items, rals,
// movimientos, piso_* (9 tablas), catalogo, atencion_registros.
// Regla del proyecto desde el fix T173: TODO delete visible al usuario
// pide las filas de vuelta (.select('id')) y VERIFICA el efecto real.
//
// Este módulo centraliza esa verificación (una sola implementación,
// mensajes consistentes) — usada por modulos.ts, rq-atencion.ts, ral.ts,
// kardex.ts, piso/api.ts y catalogo.ts.

import { ERR_ELIMINAR_BLOQUEADO, errorControlado } from '@/lib/rackly/errores'

/**
 * Exige que un DELETE haya borrado AL MENOS `esperadas` filas.
 *
 * @param data      filas devueltas por `.delete().select('id')`
 * @param esperadas mínimo que el plan quería borrar (1 = «alguna»)
 * @param mensaje   texto para el usuario (es-PE), consistente con el flujo
 * @returns cuántas filas se borraron DE VERDAD (para contadores honestos)
 * @throws errorControlado(ERR_ELIMINAR_BLOQUEADO) si se borró menos
 */
export function exigirBorradas(
  data: Array<unknown> | null,
  esperadas: number,
  mensaje: string
): number {
  const borradas = (data ?? []).length
  if (borradas < esperadas) {
    throw errorControlado(ERR_ELIMINAR_BLOQUEADO, mensaje)
  }
  return borradas
}

/**
 * Rollback BEST-EFFORT (no lanza): avisa en consola si un delete interno
 * fue filtrado por RLS. Se usa SOLO en rutas de recuperación donde el
 * sistema converge aunque el borrado no ocurra (p. ej. rollback de
 * cabeceras huérfanas — el reintento entra por la rama duplicate y
 * completa los items); lanzar aquí ENMASCARARÍA el error original.
 */
export function avisarBorradoFiltrado(
  data: Array<unknown> | null,
  esperadas: number,
  tag: string
): void {
  const borradas = (data ?? []).length
  if (borradas < esperadas) {
    console.warn(
      `[${tag}] rollback INEFECTIVO: se pidieron ${esperadas} fila(s) y la BD borró ${borradas} ` +
        '(RLS filtró el delete en silencio o ya no existían). El flujo continúa por diseño best-effort.'
    )
  }
}
