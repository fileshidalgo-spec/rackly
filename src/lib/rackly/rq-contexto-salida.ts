'use client'

/**
 * RACKLY — Contexto efímero de "salida para una RQ" (módulo Atención).
 *
 * Cuando el usuario salta desde el detalle de una RQ ("Ver ubicación del
 * producto") a Racks o Piso, se guarda AQUÍ qué material está atendiendo.
 * Tras una salida exitosa del código coincidente, Racks/Piso ofrecen
 * registrar esa salida en la RQ (atenderItemRq) con confirmación.
 *
 * Garantía de NO conflicto con la regularización (pedido del usuario):
 *   · El contexto SOLO existe si se llegó desde la RQ.
 *   · Entradas directas a Racks/Piso jamás lo leen → salida pura.
 *   · Responder "No" a la confirmación = regularización (no toca la RQ).
 *   · Se limpia al volver a Atención o a los 2 horas por seguridad.
 */

const KEY = 'atencion.ctxSalidaRq'
/** Vida útil máxima del contexto (2 h): evita diálogos fantasma en sesiones largas. */
const TTL_MS = 2 * 60 * 60 * 1000

export type ContextoSalidaRq = {
  rqId: string
  numeroRq: string
  itemId: string
  codigo: string
  descripcion: string
  unidad: string
  /** Cantidad requerida por la RQ (para mostrar el avance en la confirmación). */
  cantidadRequerida: number
  /** Cantidad atendida al momento del salto (referencia; la real se lee al registrar). */
  cantidadAtendida: number
  ts: number
}

export function guardarContextoSalidaRq(ctx: Omit<ContextoSalidaRq, 'ts'>): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...ctx, ts: Date.now() }))
  } catch {
    /* sessionStorage lleno/bloqueado: la salida funciona igual, solo no ofrecerá el registro */
  }
}

export function leerContextoSalidaRq(): ContextoSalidaRq | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const ctx = JSON.parse(raw) as ContextoSalidaRq
    if (!ctx?.itemId || !ctx?.codigo) return null
    if (Date.now() - (ctx.ts ?? 0) > TTL_MS) {
      limpiarContextoSalidaRq()
      return null
    }
    return ctx
  } catch {
    return null
  }
}

export function limpiarContextoSalidaRq(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    /* noop */
  }
}

/** Comparación tolerante de códigos (mayúsculas, sin espacios). */
export function mismoCodigo(a: string, b: string): boolean {
  return (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase()
}

// ═══════════════════════════════════════════════════════════════════
// Detección UNIVERSAL de salidas que corresponden a una RQ abierta.
//
// FIX auditoría 2026-10-22 (P2): solo 2 de ~9 rutas de salida ofrecían el
// registro en la RQ ("Ver ubicación → detalle de posición"), aunque el banner
// "Atendiendo la RQ…" promete lo contrario. Con este helper TODAS las rutas
// (salida simple, salida desde alerta de destino ocupado, salidas masivas,
// SalidaForm por código) usan la MISMA detección: filtran lo salido por el
// código de la RQ y devuelven el payload listo para el confirmador.
// Las salidas INC se excluyen a propósito (stock no conforme, pool aparte).
// ═══════════════════════════════════════════════════════════════════

export type RqSalidaDetectada = {
  numeroRq: string
  itemId: string
  codigo: string
  unidad: string
  /** Cantidad TOTAL de esta salida que corresponde al código de la RQ. */
  cantidad: number
  /** Cantidad requerida por la RQ (referencia para el aviso). */
  requerido: number
  /** Task 27: posiciones desde donde salió el material (para el ledger). */
  tomas: Array<{ ubicacion: string; cantidad: number; origen: 'racks' | 'piso' }>
}

/**
 * Dadas las filas salidas ({codigo, cantidad, unidad?, ubicacion?, origen?}),
 * devuelve el registro pendiente para la RQ si hay coincidencia de código con
 * el contexto efímero; null si no hay contexto, si el código no coincide o
 * si la cantidad coincidente es 0. Las filas con `ubicacion` agregan tomas
 * (agrupadas por posición) que el ledger de la RQ registra con la atención.
 */
export function detectarRqParaSalida(
  filas: Array<{
    codigo: string
    cantidad: number
    unidad?: string
    ubicacion?: string
    origen?: 'racks' | 'piso'
  }>
): RqSalidaDetectada | null {
  const ctx = leerContextoSalidaRq()
  if (!ctx) return null
  let total = 0
  let unidad = ctx.unidad
  const tomas = new Map<string, { ubicacion: string; cantidad: number; origen: 'racks' | 'piso' }>()
  for (const f of filas) {
    if (!mismoCodigo(ctx.codigo, f.codigo)) continue
    const q = Number(f.cantidad)
    if (!Number.isFinite(q) || q <= 0) continue
    total += q
    if (!unidad && f.unidad) unidad = f.unidad
    const ubic = (f.ubicacion ?? '').trim()
    if (ubic) {
      const previa = tomas.get(ubic)
      if (previa) previa.cantidad += q
      else tomas.set(ubic, { ubicacion: ubic, cantidad: q, origen: f.origen === 'piso' ? 'piso' : 'racks' })
    }
  }
  if (total <= 0) return null
  return {
    numeroRq: ctx.numeroRq,
    itemId: ctx.itemId,
    codigo: ctx.codigo,
    unidad: unidad || '',
    cantidad: total,
    requerido: ctx.cantidadRequerida,
    tomas: [...tomas.values()],
  }
}
