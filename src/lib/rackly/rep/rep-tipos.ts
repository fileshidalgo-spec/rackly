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

/**
 * Sector físico del layout (Excel «LAYOUT REPUESTOS», migración
 * 20261110_rep_ubicaciones_sectores): el almacén tiene DOS sectores.
 *   · racks — R01..R36 (piso 1 y 2), posición = rack→nivel→secuencia.
 *   · zonas — Zonas A/B/C/D (tercer piso) + CONTENEDOR N° 3 +
 *     PRE-PICKING + RECEPCIÓN (piso 1), posición = zona→secuencia.
 */
export type RepSector = 'racks' | 'zonas'

export type RepUbicacion = {
  id: string
  created_at: string
  tipo: RepTipoUbicacion
  sector: RepSector
  /** Nº de rack 1..36 (sector 'racks'; null en 'zonas'). */
  rack: number | null
  /** Nombre de zona: 'A'..'D' · 'CONTENEDOR N° 3' · 'PRE-PICKING' ·
 *  'RECEPCIÓN' (sector 'zonas'; '' en 'racks'). */
  zona: string
  piso: number
  /** 1..5 (racks; 0 = posición de piso/bajo rack); zonas = 1 */
  nivel: number
  secuencia: number
  /** Código físico del Excel: R01-02-17 · A-01 · CN3-07 · PP-02 · REC-08 */
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

export const REP_ETIQUETA_SECTOR: Record<RepSector, string> = {
  racks: 'Racks',
  zonas: 'Zonas',
}

/**
 * Orden canónico de las zonas del sector 'zonas' (hoja UBICACIÓN ZONA:
 * primero las 4 zonas del tercer piso, luego contenedor/prepicking/recepción).
 */
export const REP_ORDEN_ZONAS = ['A', 'B', 'C', 'D', 'CONTENEDOR N° 3', 'PRE-PICKING', 'RECEPCIÓN'] as const

/** Prefijo de código por zona (se pinta junto al nombre en la UI). */
export const REP_PREFIJO_ZONA: Record<string, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  'CONTENEDOR N° 3': 'CN3',
  'PRE-PICKING': 'PP',
  RECEPCIÓN: 'REC',
}

export const REP_ETIQUETA_MOV: Record<RepTipoMovimiento, string> = {
  ingreso: 'Ingreso',
  salida: 'Salida',
  devolucion: 'Devolución',
  traslado: 'Traslado',
  ajuste: 'Ajuste',
}

/**
 * [LEGADO — el layout canónico 2026-11 se define en la migración
 * 20261110_rep_ubicaciones_sectores y ya NO se crean ubicaciones a mano:
 * los códigos los construye la migración (R{rack}-{nivel}-{pos} ·
 * {prefijo}-{pos}). Esta función solo queda para reconstruir el código
 * desde sus partes en herramientas internas.]
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
