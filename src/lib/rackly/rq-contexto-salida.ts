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
