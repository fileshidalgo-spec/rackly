'use client'

/**
 * RACKLY — Atención · TABLERO de atenciones por línea y materiales
 * auxiliares (pedido 2026-11-12 con imagen de la presentación actual).
 *
 * El usuario presenta HOY una tabla dinámica (Excel) con filtros FECHA +
 * TURNO y columnas: LINEA | PRODUCTO | sku | DESCRIPCION | Suma de
 * CANTIDAD. Este módulo genera ESO desde el app.
 *
 * Fuente de verdad: el LEDGER de salidas (rq_atencion_tomas) — cada
 * atención física de la RQ deja una fila con fecha/hora (creado_en) y
 * cantidad con signo (positivo = salida · negativo = reversa). El tablero
 * es el NETO por línea+material (pedido 2026-11-12: el mismo código se
 * suma en una fila por línea): lo que realmente salió del
 * almacén hacia la línea en el rango/turno elegidos.
 *
 *   · FECHA  = día de la SALIDA en hora Lima (creado_en).
 *   · TURNO  = turno de la SALIDA: la columna turno del ledger (que el
 *              trigger trg_rq_tomas_turno llena desde 2026-11-12) o,
 *              en históricos sin turno, DERIVADO con la misma regla del
 *              almacén (Lima 07:20–19:20:59 → T1, resto T2 — igual que
 *              el Excel por rango de Recepción).
 *   · LINEA / PRODUCTO = del encabezado de la RQ; LINEA se NORMALIZA con
 *              el catálogo canónico (lineas.ts) solo para AGRUPAR — los
 *              históricos sin mapeo aparecen tal cual, nunca se inventan.
 *              PRODUCTO vacío en RQ de materiales auxiliares muestra
 *              «MATERIALES AUXILIARES» (como la presentación actual).
 *
 * PURO (sin red): testeable con esbuild+node. Solo el Excel toca el
 * navegador (exportarExcelTablero en atencion-excel.ts).
 */

import type { DatosReporte, ReporteItem, ReporteRq, ReporteToma } from '@/lib/rackly/atencion-reporte'
import { calcularTurnoRecepcion } from '@/lib/rackly/turno'
import { claveOrdenLinea, lineaParaAgrupar } from '@/lib/rackly/lineas'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

export type FilaTablero = {
  /** Línea (normalizada para agrupar; históricos sin mapeo quedan tal cual). */
  linea: string
  /** Producto de la OP de la RQ (o MATERIALES AUXILIARES / (sin producto)).
   *  Pedido 2026-11-12: el mismo CÓDIGO se suma en UNA fila por línea —
   *  cuando el código salió para varios productos se muestra el dominante
   *  (el de mayor cantidad neta; empate → alfabético). */
  producto: string
  /** Código del material (sku). */
  sku: string
  /** Descripción del material (la más reciente entre las tomas). */
  descripcion: string
  /** Suma NETA de cantidades (salidas − reversas) del código EN la línea. */
  cantidad: number
  /** Nº de tomas (salidas + reversas) que forman la fila. */
  numTomas: number
}

export type FiltroTablero = {
  /** Fecha inicial (YYYY-MM-DD, día de la salida en hora Lima). */
  desde: string
  /** Fecha final (YYYY-MM-DD, inclusive). */
  hasta: string
  /** Turnos incluidos (['T1'], ['T2'] o ambos). */
  turnos: string[]
}

export type TableroAtenciones = {
  filas: FilaTablero[]
  /** Subtotales por línea (mismo orden que filas). El EXCEL ya no los
   *  imprime (pedido 2026-11-12: quitar los totales de cada línea) pero
   *  quedan para pruebas y futuros reportes. */
  subtotales: Map<string, number>
  /** Total general neto. */
  totalGeneral: number
  /** Tomas que pasaron el filtro (para el aviso «sin registros»). */
  tomasEnRango: number
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS (puros)
// ═══════════════════════════════════════════════════════════════════

/** ISO timestamp → día en hora Lima (YYYY-MM-DD). Misma TZ que turno.ts. */
export function fechaLimaISO(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d) // en-CA → YYYY-MM-DD
}

/**
 * Turno de UNA toma: la columna del ledger si vino (T1/T2) y, si no,
 * derivada de la HORA de la salida con la regla del almacén (Lima) —
 * igual que el Excel por rango de Recepción.
 */
export function turnoDeToma(t: Pick<ReporteToma, 'turno' | 'creadoEn'>): string {
  const propio = (t.turno ?? '').trim().toUpperCase()
  if (propio === 'T1' || propio === 'T2') return propio
  return calcularTurnoRecepcion(new Date(t.creadoEn))
}

/** PRODUCTO de la fila: descripción de la OP; fallbacks como el pivot actual. */
export function productoDeRq(rq: ReporteRq | undefined, linea: string): string {
  if (!rq) return ''
  const prod = rq.productoDescripcion.trim() || rq.productoCodigo.trim()
  if (prod) return prod
  if (linea === 'Materiales auxiliares') return 'MATERIALES AUXILIARES'
  return '(sin producto)'
}

// ═══════════════════════════════════════════════════════════════════
// AGREGACIÓN (pura)
// ═══════════════════════════════════════════════════════════════════

/**
 * Construye el tablero: filtra tomas por FECHA de salida (Lima) + TURNOS,
 * resuelve línea/producto desde la RQ y agrupa neto por línea+sku —
 * pedido 2026-11-12: «haga la suma de los artículos del mismo código
 * atendido en cada línea» (el producto ya NO divide filas; se muestra el
 * dominante). Orden: Línea 1→20, Materiales auxiliares, Jarabe, luego
 * valores históricos sin mapeo alfabéticos; dentro: producto, sku.
 */
export function construirTablero(
  datos: Pick<DatosReporte, 'rqs' | 'items' | 'tomas'>,
  filtro: FiltroTablero
): TableroAtenciones {
  const rq = new Map<string, ReporteRq>(datos.rqs.map((r) => [r.id, r]))
  const item = new Map<string, ReporteItem>(datos.items.map((i) => [i.id, i]))

  const acc = new Map<
    string,
    { linea: string; sku: string; desc: string; cant: number; n: number; prods: Map<string, number> }
  >()

  for (const t of datos.tomas) {
    const dia = fechaLimaISO(t.creadoEn)
    if (!dia || dia < filtro.desde || dia > filtro.hasta) continue
    if (!filtro.turnos.includes(turnoDeToma(t))) continue

    const h = rq.get(t.rqId)
    const linea = h ? lineaParaAgrupar(h.linea) : '(sin RQ)'
    const producto = h ? productoDeRq(h, linea) : '(sin RQ)'
    const sku = t.codigo.trim().toUpperCase()
    const desc = item.get(t.itemId)?.descripcion?.trim() ?? ''

    const k = `${linea}\u0001${sku}`
    let a = acc.get(k)
    if (!a) {
      a = { linea, sku, desc: '', cant: 0, n: 0, prods: new Map() }
      acc.set(k, a)
    }
    a.cant += t.cantidad
    a.n += 1
    a.prods.set(producto, (a.prods.get(producto) ?? 0) + t.cantidad)
    if (desc && !a.desc) a.desc = desc
  }

  /** Producto dominante: mayor cantidad neta; empate → alfabético. */
  const productoDominante = (prods: Map<string, number>): string => {
    let mejor = ''
    let cantMejor = -Infinity
    for (const [p, c] of prods) {
      if (c > cantMejor || (c === cantMejor && p < mejor)) {
        mejor = p
        cantMejor = c
      }
    }
    return mejor
  }

  const filas = Array.from(acc.values())
    .map<FilaTablero>((a) => ({
      linea: a.linea,
      producto: productoDominante(a.prods),
      sku: a.sku,
      descripcion: a.desc,
      cantidad: Math.round(a.cant * 1000) / 1000,
      numTomas: a.n,
    }))
    .sort(
      (x, y) =>
        claveOrdenLinea(x.linea)[0] - claveOrdenLinea(y.linea)[0] ||
        claveOrdenLinea(x.linea)[1].localeCompare(claveOrdenLinea(y.linea)[1]) ||
        x.producto.localeCompare(y.producto) ||
        x.sku.localeCompare(y.sku, undefined, { numeric: true })
    )

  const subtotales = new Map<string, number>()
  let total = 0
  let enRango = 0
  for (const f of filas) {
    subtotales.set(f.linea, Math.round(((subtotales.get(f.linea) ?? 0) + f.cantidad) * 1000) / 1000)
    total += f.cantidad
    enRango += f.numTomas
  }
  total = Math.round(total * 1000) / 1000

  return { filas, subtotales, totalGeneral: total, tomasEnRango: enRango }
}
