'use client'

/**
 * RACKLY — Reglas compartidas para la EDICIÓN de lote / fecha de vencimiento
 * de artículos sin esos datos (módulos Racks y Piso, pedido 2026-10-20).
 *
 * Quién puede editar:
 *   · `almacenero` — el cargo que pidió el usuario para corregir artículos
 *     registrados sin lote/fechas.
 *   · `admin` — conserva poder completo sobre todo el sistema.
 *   · El resto de roles NO ve la acción (igual que eliminar movimientos,
 *     que queda para admin/supervisores).
 *
 * Qué se puede guardar:
 *   · Lote y/o fecha de vencimiento (al menos UNO de los dos, con formato
 *     ISO YYYY-MM-DD si viene fecha). La RPC del servidor re-aplica esta
 *     regla (defensa en profundidad) y solo toca filas realmente vacías.
 */

export const ROLES_EDICION_LOTE = ['almacenero', 'admin'] as const

/** ¿Este rol puede editar lote/fecha de artículos sin esos datos? */
export function puedeEditarLote(rol: string | null | undefined): boolean {
  if (!rol) return false
  return (ROLES_EDICION_LOTE as readonly string[]).includes(rol)
}

const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

export type ResultadoValidacionLote =
  | { ok: true; lote: string | null; fecha: string | null }
  | { ok: false; error: string }

/**
 * Normaliza y valida los datos digitados en el diálogo de edición.
 * Devuelve el par normalizado (vacío → null) o el motivo del rechazo.
 */
export function validarDatosLote(
  lote: string | null | undefined,
  fecha: string | null | undefined
): ResultadoValidacionLote {
  const loteNorm = (lote ?? '').trim() || null
  const fechaNorm = (fecha ?? '').trim() || null

  if (!loteNorm && !fechaNorm) {
    return { ok: false, error: 'Indique el lote y/o la fecha de vencimiento del producto' }
  }
  if (loteNorm && loteNorm.length > 100) {
    return { ok: false, error: 'El código de lote no puede exceder 100 caracteres' }
  }
  if (fechaNorm && !RE_FECHA_ISO.test(fechaNorm)) {
    return { ok: false, error: 'Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)' }
  }
  return { ok: true, lote: loteNorm, fecha: fechaNorm }
}
