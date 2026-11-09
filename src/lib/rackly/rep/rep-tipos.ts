/**
 * RACKLY · ALMACÉN REPUESTOS — Tipos (espejo de las tablas rep_*) y
 * constantes compartidas por los 6 módulos del almacén.
 *
 * Aislamiento: este namespace NO toca tablas ni funciones de Insumos.
 * La fuente de verdad en BD es la migración 20261110_repuestos_fase2.sql:
 *   rep_articulos · rep_ubicaciones · rep_loncheras · rep_stock
 *   rep_ral · rep_ral_detalle · rep_movimientos
 */

// ═══════════════════════════════════════════════════════════════════
// TIPOS DE TABLA
// ═══════════════════════════════════════════════════════════════════

export type RepArticulo = {
  id: string
  created_at: string
  updated_at: string
  /** Código BIG MAGIC (único, se normaliza a mayúsculas) */
  codigo: string
  descripcion: string
  und: string
  /** SOLO REFERENCIA del Excel inicial: no es stock ni interfiere con él */
  cantidad_ref: number
  marca: string
  modelo: string
  aplicacion: string
  activo: boolean
}

export type RepTipoUbicacion = 'rack' | 'pasillo' | 'zona' | 'prepicking'

export type RepUbicacion = {
  id: string
  created_at: string
  tipo: RepTipoUbicacion
  piso: number
  /** 1..n; para pasillo vale 0 (fila de pasillos BAJO el nivel 1) */
  nivel: number
  secuencia: number
  /** Código normalizado: R-P1-N3-P05 · PAS-P1-01 · Z-P1-N3-01 · PP-P1-N1 */
  codigo: string
  nota: string
  activo: boolean
}

export type RepLonchera = {
  id: string
  created_at: string
  ubicacion_id: string
  lado: 'A' | 'B'
}

export type RepStockRow = {
  id: string
  updated_at: string
  lonchera_id: string
  articulo_id: string
  cantidad: number
  /** Lleno SOLO mientras el artículo está estacionado en Tránsito */
  ral_id: string | null
}

export type RepEstadoRal = 'registrado' | 'despachado' | 'anulado'

export type RepRal = {
  id: string
  created_at: string
  /** Número BIG MAGIC: se registra, no se genera en el app */
  numero: string
  fecha: string
  solicitante: string
  estado: RepEstadoRal
  usuario_id: string | null
  usuario_nombre: string
}

export type RepRalDetalle = {
  id: string
  created_at: string
  ral_id: string
  articulo_id: string
  cantidad: number
}

export type RepTipoMovimiento = 'ingreso' | 'salida' | 'devolucion' | 'traslado' | 'ajuste'

/**
 * Estado de una LÍNEA de recepción (rep_recepcion_lineas):
 *   en_transito → guardada en Recepción, esperando que Tránsito decida
 *                 a qué lonchera va (NO tiene stock ni kardex aún);
 *   ubicado     → con lonchera, stock y movimiento de ingreso en el kardex.
 */
export type RepEstadoLinea = 'en_transito' | 'ubicado'

export type RepMovimiento = {
  id: string
  created_at: string
  tipo: RepTipoMovimiento
  articulo_id: string
  codigo: string
  descripcion: string
  und: string
  cantidad: number
  origen_ubicacion_id: string | null
  origen_lado: 'A' | 'B' | null
  destino_ubicacion_id: string | null
  destino_lado: 'A' | 'B' | null
  ral_id: string | null
  referencia: string
  usuario_id: string | null
  usuario_nombre: string
  /** Documento de la guía (SOLO en tipo 'ingreso'; demás operaciones ''). */
  guia: string
  oc: string
  dam: string
  proveedor: string
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES DE DOMINIO
// ═══════════════════════════════════════════════════════════════════

/** Capacidad de la lonchera: máx. ARTÍCULOS DISTINTOS (valida BD-RPC y UI) */
export const REP_MAX_ARTICULOS_LONCHERA = 15

/** Lados con los que se rotula una ubicación (rack = A y B; resto = A) */
export function repLadosDeTipo(tipo: RepTipoUbicacion): Array<'A' | 'B'> {
  return tipo === 'rack' ? ['A', 'B'] : ['A']
}

export const REP_ETIQUETA_TIPO: Record<RepTipoUbicacion, string> = {
  rack: 'Rack',
  pasillo: 'Pasillo',
  zona: 'Zona',
  prepicking: 'Pre-picking',
}

export const REP_ETIQUETA_MOV: Record<RepTipoMovimiento, string> = {
  ingreso: 'Ingreso',
  salida: 'Salida',
  devolucion: 'Devolución',
  traslado: 'Traslado',
  ajuste: 'Ajuste',
}

/**
 * Código normalizado de una ubicación (misma regla que rotulará el QR):
 *   rack       → R-P<piso>-N<nivel>-P<secuencia, 2 dígitos>
 *   pasillo    → PAS-P<piso>-<secuencia, 2 dígitos>          (nivel 0)
 *   zona       → Z-P<piso>-N<nivel>-<secuencia, 2 dígitos>
 *   prepicking → PP-P<piso>-N<nivel>
 */
export function repCodigoUbicacion(
  tipo: RepTipoUbicacion,
  piso: number,
  nivel: number,
  secuencia: number
): string {
  const p = String(piso)
  const n = String(nivel)
  const s = String(secuencia).padStart(2, '0')
  switch (tipo) {
    case 'rack':
      return `R-P${p}-N${n}-P${s}`
    case 'pasillo':
      return `PAS-P${p}-${s}`
    case 'zona':
      return `Z-P${p}-N${n}-${s}`
    case 'prepicking':
      return `PP-P${p}-N${n}`
  }
}

/**
 * Clase/etiqueta del estado de un RAL — FUENTE ÚNICA compartida por los
 * módulos Atención y Tránsito (antes duplicada en ambos; auditoría 2026-11-10).
 */
export const REP_CLASE_ESTADO_RAL: Record<string, string> = {
  registrado: 'bg-sky-50 text-sky-700 border-sky-200',
  despachado: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  anulado: 'bg-slate-100 text-slate-500 border-slate-200',
}

export const REP_ETIQUETA_ESTADO_RAL: Record<string, string> = {
  registrado: 'Registrado',
  despachado: 'Despachado',
  anulado: 'Anulado',
}

/**
 * Clase/etiqueta del estado de una LÍNEA de recepción — fuente única
 * compartida por Recepción (últimas recepciones) y Tránsito (por ubicar).
 */
export const REP_CLASE_ESTADO_LINEA: Record<string, string> = {
  en_transito: 'bg-amber-50 text-amber-700 border-amber-200',
  ubicado: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

export const REP_ETIQUETA_ESTADO_LINEA: Record<string, string> = {
  en_transito: 'En tránsito',
  ubicado: 'Ubicado',
}
