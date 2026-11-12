/**
 * lotes.ts — AGREGACIÓN CENTRAL DE LOTES (extraída de la deuda técnica
 * documentada en la auditoría 2026-11-12).
 *
 * El patrón "pool por ubicación → ingresos por fecha + salidas dirigidas con
 * desborde FEFO (calcularLotesRemanentes) → proveedor del ingreso más reciente
 * + códigos de lote físicos" estaba copiado en 6 pestañas de Kardex
 * (SalidaForm, SalidaIncForm, TrasladoTab, FefoTab, StockTab ×2 modos,
 * DescargaTab) y ya había divergido una vez (el FIX Task 24 de normalización
 * trim+mayúsculas se aplicó a Traslado/Stock/FEFO pero no a Salidas).
 *
 * Esta libra captura el TRONCO común (agrupar + remanentes + textos
 * auxiliares); cada pestaña conserva su clave de agrupación, su orden de
 * salidas y su orden/filas finales, que es donde difieren de verdad.
 *
 * Semántica preservada al milímetro:
 * - `ordenarSalidas: false` (Salidas/Traslado): las salidas se procesan en el
 *   orden en que llegan (fetchMovimientosByCodigo trae DESC por f_modificacion).
 * - `ordenarSalidas: true` (FEFO/Stock/Descarga): salidas ordenadas ASC por
 *   (f_modificacion, id) antes de descontar.
 * - El filtro de código NORMALIZA ambos lados (trim + mayúsculas) — extiende el
 *   FIX Task 24 a las salidas (clase entera de "código con espacios no salía").
 */
import { calcularLotesRemanentes, proveedorPorVenc } from '@/lib/rackly/kardex'
import { esTipoEntrada } from '@/lib/utils'

/** Campos de Movimiento que la agregación necesita (estructural: acepta el
 *  tipo Movimiento de kardex.ts y variantes locales equivalentes). */
export type MovLote = {
  /** id/fModificacion opcionales: las vistas de salidas (MovimientoForm) proyectan
   *  un tipo ligero sin ellos — solo hacen falta para ordenarSalidas=true. */
  id?: string
  tipo: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  fVencimiento?: string
  fModificacion?: string
  proveedor?: string
  codigoInc?: string
  lote?: string
}

export type PoolLote = {
  /** Misma clave que devuelve claveDe (útil al iterar el Map). */
  clave: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  descripcion: string
  un: string
  /** Primer proveedor visto en el pool (fallback histórico de cada pestaña). */
  proveedor?: string
  codigoInc: string
  /** Ingresos acumulados por fecha de vencimiento ('' = sin fecha). */
  ingresos: Map<string, number>
  /** Salidas dirigidas { venc, qty } (orden: el elegido por la pestaña). */
  salidas: Array<{ venc: string; qty: number; ts: string; id: string }>
  /** Proveedores de ingresos por fecha (para proveedorPorVenc). */
  provIn: Array<{ venc: string; proveedor?: string; ts: string }>
  /** Códigos de lote FÍSICOS por fecha (trazabilidad, no afecta stock). */
  lotesFis: Map<string, Set<string>>
}

export type OpcionesPoolsLote = {
  /** Si viene: solo movimientos cuyo codigo (trim + mayúsculas) coincida. */
  codigo?: string
  /** excluir = Stock/FEFO/Salidas normales; solo = pestañas INC; todos = Descarga. */
  modoInc: 'excluir' | 'solo' | 'todos'
  /** Clave de agrupación de cada pestaña (ubicación, ubicación||inc, código|…). */
  claveDe: (m: MovLote) => string
  /** true = ordenar salidas ASC por (ts, id) — FEFO/Stock/Descarga.
   *  false (default) = respetar el orden de llegada — Salidas/Traslado. */
  ordenarSalidas?: boolean
}

/** Agrupa movimientos en pools de lote (tronco común de las 6 pestañas). */
export function agruparPoolsLote(
  movs: MovLote[],
  o: OpcionesPoolsLote
): Map<string, PoolLote> {
  const codeNorm = o.codigo?.trim().toUpperCase()
  const pools = new Map<string, PoolLote>()
  for (const m of movs) {
    if (o.codigo && m.codigo.trim().toUpperCase() !== codeNorm) continue
    if (o.modoInc === 'excluir' && m.codigoInc) continue
    if (o.modoInc === 'solo' && !m.codigoInc) continue
    const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
    if (!(qty > 0)) continue
    const clave = o.claveDe(m)
    let p = pools.get(clave)
    if (!p) {
      p = {
        clave,
        bloque: m.bloque, torre: m.torre, piso: m.piso, posicion: m.posicion,
        codigo: m.codigo, descripcion: m.descripcion, un: m.un,
        proveedor: m.proveedor || undefined, codigoInc: m.codigoInc || '',
        ingresos: new Map(), salidas: [], provIn: [], lotesFis: new Map(),
      }
      pools.set(clave, p)
    }
    if (!p.descripcion && m.descripcion) p.descripcion = m.descripcion
    if (!p.proveedor && m.proveedor) p.proveedor = m.proveedor
    const venc = m.fVencimiento || ''
    if (esTipoEntrada(m.tipo)) {
      p.ingresos.set(venc, (p.ingresos.get(venc) ?? 0) + qty)
      if (m.proveedor) p.provIn.push({ venc, proveedor: m.proveedor, ts: m.fModificacion ?? '' })
      if (m.lote) {
        const set = p.lotesFis.get(venc) ?? new Set<string>()
        set.add(m.lote)
        p.lotesFis.set(venc, set)
      }
    } else {
      p.salidas.push({ venc, qty, ts: m.fModificacion ?? '', id: m.id ?? '' })
    }
  }
  if (o.ordenarSalidas) {
    for (const p of pools.values()) {
      if (p.salidas.length > 1) {
        p.salidas.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
      }
    }
  }
  return pools
}

/** Remanentes FEFO de un pool — delega en la fuente única
 *  calcularLotesRemanentes (descuento dirigido + desborde, sin negativos). */
export function remanentesDePool(p: PoolLote): { venc: string; cantidad: number }[] {
  return calcularLotesRemanentes(p.ingresos, p.salidas)
}

/** Texto de códigos de lote físicos de una fecha (join ordenado) o undefined. */
export function textoLoteFisico(p: PoolLote, venc: string): string | undefined {
  const fis = p.lotesFis.get(venc)
  return fis && fis.size > 0 ? Array.from(fis).sort().join(', ') : undefined
}

/** Mapa venc → proveedor real (ingreso más reciente de cada venc). */
export function proveedoresDePool(p: PoolLote): Map<string, string> {
  return proveedorPorVenc(p.provIn)
}
