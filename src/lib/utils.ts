import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { MOVIMIENTOS_ENTRADA, LOCALE } from "@/lib/rackly/constants"

// ── Tailwind ────────────────────────────────────────────
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Stock ───────────────────────────────────────────────
/** Calcula el impacto en stock de un movimiento.
 *  INGRESO, DEVOLUCIÓN, TRASLADO = positivo
 *  SALIDA = negativo
 */
export function impactoStock(tipo: string, cantidad: number): number {
  return MOVIMIENTOS_ENTRADA.includes(tipo as typeof MOVIMIENTOS_ENTRADA[number])
    ? cantidad
    : -cantidad
}

// ── Formateo ────────────────────────────────────────────
/** Formatea una fecha ISO (YYYY-MM-DD) a formato legible */
export function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Formatea una fecha ISO (YYYY-MM-DD HH:mm) a formato legible con hora */
export function formatDateTime(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Verifica si una fecha ya venció */
export function isExpired(dateStr: string): boolean {
  if (!dateStr) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return false
  return d < today
}

/** Verifica si una fecha vence en los próximos N días (default 30) */
export function isExpiringSoon(dateStr: string, days = 30): boolean {
  if (!dateStr) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return false
  const diff = (d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  return diff >= 0 && diff <= days
}

/** Formatea cantidad con unidad */
export function fmtCantidad(cantidad: number, un?: string): string {
  return `${Number.isInteger(cantidad) ? cantidad : cantidad.toFixed(3)}${un ? ' ' + un : ''}`
}

// ── Validación ──────────────────────────────────────────
/** Verifica si una descripción requiere proveedor (láminas/stretch) */
export function requiereProveedor(descripcion: string): boolean {
  const upper = descripcion.toUpperCase().trim()
  if (upper.startsWith('ETIQUETA') && upper.includes('LAMINA')) return false
  return upper.includes('LAMINA') || upper.includes('STRETCH')
}

// ── Clave de ubicación ──────────────────────────────────
export function ubicacionKey(bloque: string, torre: string, piso: string, posicion: string): string {
  return `${bloque}-${torre}-${piso}-${posicion}`
}

/** Formatea ubicación legible: B-1 T-A P-3 Pos-02 */
export function fmtUbicacion(bloque: string, torre: string, piso: string, posicion: string): string {
  return `B-${bloque} T-${torre} P-${piso} Pos-${posicion}`
}

// ── Error handling ──────────────────────────────────────
/** Extrae mensaje de error legible desde unknown */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : 'Error desconocido'
}
