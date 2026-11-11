/**
 * RACKLY — LÍNEAS DE PRODUCCIÓN: catálogo canónico y normalización.
 *
 * Pedido del usuario (2026-11-12): «en la colocación de líneas a la hora de
 * registrar el RQ les salga una lista desplegable con (Línea 1 hasta el 20 y
 * Materiales auxiliares) para que no se confunda ya que al digitalizar puede
 * que no sea tan exacto».
 *
 * Problema real en la BD (auditado 2026-11-12): la línea llegaba como TEXTO
 * LIBRE (OCR + tipeo) y coexistían «LINEA 9», «L9», «Linea 9», «AUXILIAR»,
 * «AUXILIARES», «PS MATERIALES AUXILIARES», «D4 MATERIA PRIMA E INSUMOS»…
 * El tablero por línea agrupaba variantes del MISMO valor como filas
 * distintas. Este módulo es la ÚNICA fuente de la lista oficial y del
 * mapeo tolerante de valores históricos/OCR.
 *
 * PURO (sin red): testeable con esbuild+node.
 */

// ═══════════════════════════════════════════════════════════════════
// LISTA CANÓNICA (exactamente la del pedido: Línea 1…20 + Materiales)
// ═══════════════════════════════════════════════════════════════════

export const LINEA_AUXILIARES = 'Materiales auxiliares' as const

export const LINEAS_OPCIONES: readonly string[] = [
  ...Array.from({ length: 20 }, (_, i) => `Línea ${i + 1}`),
  LINEA_AUXILIARES,
]

/** ¿Es un valor canónico exacto? (los históricos «LINEA 2» NO lo son). */
export function esLineaCanonica(valor: string): boolean {
  return LINEAS_OPCIONES.includes(valor)
}

// ═══════════════════════════════════════════════════════════════════
// ORDEN CANÓNICO (para ordenar el tablero y listados)
// ═══════════════════════════════════════════════════════════════════

const ORDEN_CANONICO = new Map(LINEAS_OPCIONES.map((l, i) => [l, i]))

/**
 * Clave de orden: las canónicas primero (Línea 1 → 20, Materiales
 * auxiliares), luego el resto alfabético (valores históricos sin mapeo,
 * que NO se inventan: se muestran tal cual).
 */
export function claveOrdenLinea(linea: string): [number, string] {
  const i = ORDEN_CANONICO.get(linea)
  if (i !== undefined) return [0, String(i).padStart(2, '0')]
  return [1, linea.toLowerCase()]
}

// ═══════════════════════════════════════════════════════════════════
// NORMALIZADOR (OCR / texto histórico → canónico)
// ═══════════════════════════════════════════════════════════════════

/**
 * Mapea un valor libre (OCR de la hoja física o texto histórico) a su
 * opción canónica. Devuelve '' cuando NO hay match confiable — el usuario
 * elige de la lista a mano (nunca se adivina una línea equivocada).
 *
 * Casos que SÍ resuelve (confiables):
 *   · «L7», «L-07», «L 12»            → Línea 7 / Línea 12
 *   · «LINEA 2», «Linea 02», «linea2» → Línea 2
 *   · «2» (solo un número 1..20)      → Línea 2
 *   · «AUXILIAR», «AUXILIARES», «MAT AUX», «MATERIALES AUXILIARES»
 *                                     → Materiales auxiliares
 * Casos que NO resuelve (devuelve ''): «JARABES», «60 TANQUES DE JARABE»,
 * «D4 MATERIA PRIMA E INSUMOS» — valores que no identifican una línea
 * canónica sin ambigüedad.
 */
export function normalizarLinea(valor: string): string {
  const t = (valor ?? '').trim()
  if (!t) return ''
  if (esLineaCanonica(t)) return t

  const min = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  // Materiales auxiliares: «auxili» (auxiliar/auxiliares) o «aux» como
  // palabra completa (abreviatura «mat aux», «aux», «aux 1»…)
  if (/auxil|\baux\b/.test(min)) return LINEA_AUXILIARES

  // Número: «L7», «L-07», «L 12», «linea 2», «linea2», «2»
  const m = min.match(/^l[\s.\-–_:]*(\d{1,2})$/) ?? min.match(/^linea[\s.\-–_:]*(\d{1,2})$/)
  const n = m ? parseInt(m[1], 10) : /^\d{1,2}$/.test(min) ? parseInt(min, 10) : NaN
  if (Number.isInteger(n) && n >= 1 && n <= 20) return `Línea ${n}`

  return ''
}

/**
 * Mapeo para AGRUPAR (tablero/listados): como el tablero ordena por línea,
 * los valores históricos sin mapeo se muestran tal cual bajo su propio
 * grupo (no se re-etiquetan datos históricos).
 */
export function lineaParaAgrupar(valor: string): string {
  const t = (valor ?? '').trim()
  if (!t) return '(sin línea)'
  return normalizarLinea(t) || t
}
