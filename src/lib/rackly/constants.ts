/**
 * RACKLY — Constantes centralizadas
 * Todas las configuraciones estáticas en un solo lugar para mantener consistencia.
 */

// ── Turnos ──────────────────────────────────────────────
export const TURNO_DIA_INICIO = 7 * 60 + 45   // 07:45 en minutos
export const TURNO_NOCHE_INICIO = 19 * 60 + 45 // 19:45 en minutos
export const TURNO_DIA = 'Día' as const
export const TURNO_NOCHE = 'Noche' as const

// ── Tipo de movimiento ─────────────────────────────────
export const TIPOS_MOVIMIENTO = {
  INGRESO: 'ingreso',
  SALIDA: 'salida',
  DEVOLUCION: 'devolucion',
  TRASLADO: 'traslado',
} as const

/** Son movimientos que ENTRAN stock */
export const MOVIMIENTOS_ENTRADA = [
  TIPOS_MOVIMIENTO.INGRESO,
  TIPOS_MOVIMIENTO.DEVOLUCION,
  TIPOS_MOVIMIENTO.TRASLADO,
] as const

/** Colores por tipo de movimiento */
export const COLOR_MOVIMIENTO: Record<string, { bg: string; text: string; icon: string }> = {
  ingreso:   { bg: 'bg-green-50 dark:bg-green-950/40',   text: 'text-green-700 dark:text-green-300',   icon: 'ArrowDownToLine' },
  salida:    { bg: 'bg-red-50 dark:bg-red-950/40',       text: 'text-red-700 dark:text-red-300',       icon: 'ArrowUpFromLine' },
  devolucion:{ bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-300', icon: 'ArrowRightLeft' },
  traslado:  { bg: 'bg-blue-50 dark:bg-blue-950/40',     text: 'text-blue-700 dark:text-blue-300',     icon: 'ArrowRightLeft' },
}

// ── Proveedores ─────────────────────────────────────────
export const PROVEEDORES_FILM = [
  'INCOMIN',
  'DAMAR',
  'DIAMAND',
  'NEOPACK',
  'SOLPACK',
  'ITS',
] as const

// ── Paginación y Polling ────────────────────────────────
export const PAGE_SIZE = 500                // Tamaño de página para queries paginadas
export const POLLING_INTERVAL = 8000      // ms — refresco de datos en tiempo real
export const POLLING_TURNO = 60000        // ms — refresco del turno
export const POLLING_OCUPACION = 10000    // ms — refresco de ocupación
export const MAX_ITERATIONS = 100         // Guard para bucles de paginación (admin/bulk)
export const FETCH_MOV_MAX_PAGES = 30     // Máx páginas para fetchMovimientos (15K filas)

// ── Timeouts ──────────────────────────────────────────
// Timeout para queries de stock por código.
// Configurable via NEXT_PUBLIC_QUERY_TIMEOUT_MS. Default: 15s.
export const QUERY_TIMEOUT_MS = parseInt(
  process.env.NEXT_PUBLIC_QUERY_TIMEOUT_MS ?? '15000',
  10
) || 15000

// ── Seguridad ───────────────────────────────────────────
export const PASSWORD_MIN_LENGTH = 6

// ── Roles ───────────────────────────────────────────────
export const ROL_ADMIN = 'admin' as const

/** Roles que pueden eliminar movimientos y aprobar usuarios (además del admin) */
export const ROLES_SUPERVISORES = [
  'supervisor_almacen',
  'supervisor_operaciones',
  'coordinador_operaciones',
] as const

// ── Almacén ─────────────────────────────────────────────
export const BLOQUES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
export const PISOS = ['1', '2', '3', '4'] as const
export const DEFAULT_UNIDAD = 'KG'

// ── Locale ──────────────────────────────────────────────
export const LOCALE = 'es-PE'

// ── Versión ─────────────────────────────────────────────
export const VERSION = '2.0'

// ── INC (Insumo No Conforme) ─────────────────────────
export const INC_PREFIX = 'INC'
/** Verifica si un movimiento es un insumo no conforme */
export function esInsumoNoConforme(codigoInc?: string | null): boolean {
  return !!codigoInc && codigoInc.trim().length > 0
}
