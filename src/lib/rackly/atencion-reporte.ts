'use client'

/**
 * RACKLY — Capa de REPORTE de Atención a Línea (RQ) · módulo Atención.
 *
 * Reporte de atención a líneas (solicitud 2026-10-29): descargar la
 * información de TODAS las RQ — encabezados, materiales (pedido vs
 * atendido) y el ledger de salidas (tomas) con ubicación/lote/VENCIMIENTO —
 * más el resumen por artículo y los KPI del dashboard.
 *
 * Fuentes (SOLO LECTURA, aislamiento del módulo):
 *   · rq_atenciones / rq_atencion_items — CRUD vive en rq-atencion.ts.
 *   · rq_atencion_tomas — ledger de salidas (Task 27): una fila por toma
 *     (positivo = salida · negativo = reversa) con ubicación, lote, usuario.
 *   · movimientos — SOLO para resolver el VENCIMIENTO del lote: el ledger
 *     de tomas no guarda f_vencimiento, pero el vencimiento es intrínseco
 *     al lote (codigo+lote → f_vencimiento de sus movimientos). Mapa
 *     construido aquí y usado por el Excel y el dashboard.
 *
 * Las agregaciones son PURAS (testeables con esbuild+node); solo
 * cargarReporteAtencion() toca la red.
 */

import { dataClient } from '@/lib/supabase/client'

// ═══════════════════════════════════════════════════════════════════
// TIPOS (filas crudas mapeadas)
// ═══════════════════════════════════════════════════════════════════

export type ReporteRq = {
  id: string
  fecha: string
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  /** Turno del sistema (hora de registro). */
  turno: string
  /** Task 35: turno de la HOJA física (004=T1 · 005=T2); '' = histórico. */
  turnoRq: string
  linea: string
  solicitante: string
  estado: string
  notas: string
  usuarioNombre: string
  createdAt: string
}

export type ReporteItem = {
  /** PK de rq_atencion_items — une el ledger de tomas (item_id). */
  id: string
  rqId: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  cantidad: number
  cantidadAtendida: number
  usuarioAtencion: string
  /** ISO al completar la atención ('' mientras queda pendiente). */
  atendidoEn: string
}

export type ReporteToma = {
  rqId: string
  itemId: string
  codigo: string
  /** racks | piso | transito | manual | reversa. */
  origen: string
  /** Positivo = salida · Negativo = reversa. */
  cantidad: number
  ubicacion: string
  saldoResultante: number | null
  lote: string
  usuarioNombre: string
  turno: string
  creadoEn: string
}

/** Todo lo que el Excel y el dashboard necesitan (una sola carga). */
export type DatosReporte = {
  rqs: ReporteRq[]
  items: ReporteItem[]
  tomas: ReporteToma[]
  /** «codigo|lote» → f_vencimiento (YYYY-MM-DD). */
  vencimientos: Map<string, string>
}

// ═══════════════════════════════════════════════════════════════════
// MAPEO fila BD → tipo de reporte
// ═══════════════════════════════════════════════════════════════════

type Fila = Record<string, unknown>

const str = (v: unknown) => String(v ?? '')
const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function filaARq(r: Fila): ReporteRq {
  return {
    id: str(r.id),
    fecha: str(r.fecha),
    numeroRq: str(r.numero_rq),
    ordenProduccion: str(r.orden_produccion),
    productoCodigo: str(r.producto_codigo),
    productoDescripcion: str(r.producto_descripcion),
    turno: str(r.turno),
    turnoRq: str(r.turno_rq),
    linea: str(r.linea),
    solicitante: str(r.solicitante),
    estado: str(r.estado),
    notas: str(r.notas),
    usuarioNombre: str(r.usuario_nombre),
    createdAt: str(r.created_at),
  }
}

function filaAItem(r: Fila): ReporteItem {
  return {
    id: str(r.id),
    rqId: str(r.rq_id),
    orden: num(r.orden),
    codigo: str(r.codigo),
    descripcion: str(r.descripcion),
    unidad: str(r.unidad),
    cantidad: num(r.cantidad),
    cantidadAtendida: num(r.cantidad_atendida),
    usuarioAtencion: str(r.usuario_atencion),
    atendidoEn: str(r.atendido_en),
  }
}

function filaAToma(r: Fila): ReporteToma {
  return {
    rqId: str(r.rq_id),
    itemId: str(r.item_id),
    codigo: str(r.codigo),
    origen: str(r.origen),
    cantidad: num(r.cantidad),
    ubicacion: str(r.ubicacion),
    saldoResultante:
      r.saldo_resultante === null || r.saldo_resultante === undefined ? null : num(r.saldo_resultante),
    lote: str(r.lote),
    usuarioNombre: str(r.usuario_nombre),
    turno: str(r.turno),
    creadoEn: str(r.creado_en),
  }
}

// ═══════════════════════════════════════════════════════════════════
// CARGA (una lectura por tabla + resolución de vencimientos)
// ═══════════════════════════════════════════════════════════════════

const LOTE_BATCH = 1000
const LOTE_MAX_BATCHES = 20 // cinta de seguridad: 20k filas de movimientos

/**
 * Vencimiento del lote: mapa «codigo|lote» → f_vencimiento (el MAYOR, por
 * si el lote tuvo correcciones). Los pares salen de las tomas del reporte;
 * los datos vienen de movimientos (entrada/salida del lote). PURO.
 */
export function construirMapaVencimiento(
  tomas: ReporteToma[],
  filasMov: { codigo: string; lote: string; f_vencimiento: string }[]
): Map<string, string> {
  const utiles = new Set(paresLoteDeTomas(tomas).map((p) => `${p.codigo}|${p.lote}`))
  const mapa = new Map<string, string>()
  for (const m of filasMov) {
    if (!m.lote || !m.f_vencimiento) continue
    const k = `${m.codigo}|${m.lote}`
    if (!utiles.has(k)) continue
    const previo = mapa.get(k)
    if (!previo || m.f_vencimiento > previo) mapa.set(k, m.f_vencimiento)
  }
  return mapa
}

/** Pares (codigo,lote) únicos de las tomas que requieren lookup. */
export function paresLoteDeTomas(tomas: ReporteToma[]): { codigo: string; lote: string }[] {
  const vistos = new Set<string>()
  const pares: { codigo: string; lote: string }[] = []
  for (const t of tomas) {
    if (!t.lote.trim()) continue
    const k = `${t.codigo}|${t.lote}`
    if (vistos.has(k)) continue
    vistos.add(k)
    pares.push({ codigo: t.codigo, lote: t.lote })
  }
  return pares
}

/**
 * Resuelve el vencimiento de los lotes de las tomas leyendo movimientos
 * (3 columnas, paginado por lotes). Si la lectura falla, el reporte sigue
 * SIN vencimientos (columna vacía) — nunca rompe la exportación.
 */
async function resolverVencimientos(tomas: ReporteToma[]): Promise<Map<string, string>> {
  const pares = paresLoteDeTomas(tomas)
  if (pares.length === 0) return new Map()
  const lotes = Array.from(new Set(pares.map((p) => p.lote)))
  const filas: { codigo: string; lote: string; f_vencimiento: string }[] = []
  try {
    let from = 0
    for (let b = 0; b < LOTE_MAX_BATCHES; b++) {
      const { data, error } = await dataClient
        .from('movimientos')
        .select('codigo, lote, f_vencimiento')
        .in('lote', lotes)
        .not('f_vencimiento', 'is', null)
        .range(from, from + LOTE_BATCH - 1)
      if (error) throw error
      const rows = (data ?? []) as Record<string, unknown>[]
      filas.push(
        ...rows.map((r) => ({
          codigo: str(r.codigo),
          lote: str(r.lote),
          f_vencimiento: str(r.f_vencimiento),
        }))
      )
      if (rows.length < LOTE_BATCH) break
      from += LOTE_BATCH
    }
  } catch (err: unknown) {
    console.warn('[reporte-atencion] vencimientos no disponibles:', err)
  }
  return construirMapaVencimiento(tomas, filas)
}

/**
 * Carga TODO el reporte en una tirada: encabezados + materiales + ledger de
 * salidas + vencimientos. Volúmenes de jornada (decenas de RQ, centenas de
 * filas) — un select completo por tabla con tope holgado.
 */
export async function cargarReporteAtencion(limiteRqs = 5000): Promise<DatosReporte> {
  const [{ data: filasRq, error: eRq }, { data: filasIt, error: eIt }, { data: filasTo, error: eTo }] =
    await Promise.all([
      dataClient.from('rq_atenciones').select('*').order('fecha', { ascending: false }).limit(limiteRqs),
      dataClient.from('rq_atencion_items').select('*').limit(limiteRqs * 20),
      dataClient.from('rq_atencion_tomas').select('*').order('creado_en', { ascending: true }).limit(20000),
    ])
  if (eRq) throw eRq
  if (eIt) throw eIt
  if (eTo) throw eTo

  const rqs = ((filasRq ?? []) as Fila[]).map(filaARq)
  const items = ((filasIt ?? []) as Fila[]).map(filaAItem)
  const tomas = ((filasTo ?? []) as Fila[]).map(filaAToma)
  const vencimientos = await resolverVencimientos(tomas)
  return { rqs, items, tomas, vencimientos }
}

// ═══════════════════════════════════════════════════════════════════
// AGREGACIONES PURAS (dashboard + hoja resumen del Excel)
// ═══════════════════════════════════════════════════════════════════

export type KpisAtencion = {
  totalRqs: number
  pendientes: number
  enProceso: number
  atendidas: number
  /** Materiales (ítems) totales y atendidos (alcanzaron/superaron lo pedido). */
  materiales: number
  materialesAtendidos: number
  /** Unidades pedidas y atendidas (suma de cantidades de ítems). */
  unidadesPedidas: number
  unidadesAtendidas: number
  /** % de materiales completados (0-100, 1 decimal). */
  pctAtencion: number
}

export function kpisAtencion(rqs: ReporteRq[], items: ReporteItem[]): KpisAtencion {
  const materialesAtendidos = items.filter((i) => i.cantidadAtendida >= i.cantidad && i.cantidad > 0).length
  const unidadesPedidas = items.reduce((s, i) => s + i.cantidad, 0)
  const unidadesAtendidas = items.reduce((s, i) => s + i.cantidadAtendida, 0)
  return {
    totalRqs: rqs.length,
    pendientes: rqs.filter((r) => r.estado === 'Pendiente').length,
    enProceso: rqs.filter((r) => r.estado === 'En proceso').length,
    atendidas: rqs.filter((r) => r.estado === 'Atendido').length,
    materiales: items.length,
    materialesAtendidos,
    unidadesPedidas,
    unidadesAtendidas,
    pctAtencion: items.length === 0 ? 0 : Math.round((materialesAtendidos / items.length) * 1000) / 10,
  }
}

export type ResumenArticulo = {
  codigo: string
  descripcion: string
  unidad: string
  /** Nº de RQs distintas que pidieron este artículo. */
  numRqs: number
  totalPedido: number
  totalAtendido: number
  pendiente: number
  /** % atendido sobre lo pedido (0-100, 1 decimal; >100 si sobreatención). */
  pctAtendido: number
  primeraAtencion: string
  ultimaAtencion: string
  usuarios: string[]
}

/**
 * Resumen POR ARTÍCULO atendido (hoja propia del Excel): agrupa los ítems
 * de todas las RQs por código, con pedido/atendido/pendiente, fechas y
 * usuarios de atención. La descripción/unidad tomadas del ítem más reciente.
 */
export function resumenPorArticulo(items: ReporteItem[], rqs: ReporteRq[]): ResumenArticulo[] {
  // rq_id → fecha (para «Nº de RQs» por código y orden estable).
  const fechaRq = new Map(rqs.map((r) => [r.id, r.fecha]))
  const porCodigo = new Map<string, { desc: string; unidad: string; rqIds: Set<string>; pedido: number; atendido: number; primera: string; ultima: string; usuarios: Set<string>; creadoMax: string }>()
  for (const it of items) {
    const k = it.codigo.trim() || '(sin código)'
    let acc = porCodigo.get(k)
    if (!acc) {
      acc = { desc: it.descripcion, unidad: it.unidad, rqIds: new Set(), pedido: 0, atendido: 0, primera: '', ultima: '', usuarios: new Set(), creadoMax: '' }
      porCodigo.set(k, acc)
    }
    acc.pedido += it.cantidad
    acc.atendido += it.cantidadAtendida
    if (it.descripcion.trim()) acc.desc = it.descripcion
    if (it.unidad.trim()) acc.unidad = it.unidad
    if (it.rqId) acc.rqIds.add(it.rqId)
    if (it.atendidoEn) {
      if (!acc.primera || it.atendidoEn < acc.primera) acc.primera = it.atendidoEn
      if (it.atendidoEn > acc.ultima) acc.ultima = it.atendidoEn
    }
    if (it.usuarioAtencion.trim()) acc.usuarios.add(it.usuarioAtencion.trim())
  }
  return Array.from(porCodigo.entries())
    .map(([codigo, a]) => ({
      codigo,
      descripcion: a.desc,
      unidad: a.unidad,
      numRqs: a.rqIds.size,
      totalPedido: a.pedido,
      totalAtendido: a.atendido,
      pendiente: Math.max(a.pedido - a.atendido, 0),
      pctAtendido: a.pedido === 0 ? 0 : Math.round((a.atendido / a.pedido) * 1000) / 10,
      primeraAtencion: a.primera,
      ultimaAtencion: a.ultima,
      usuarios: Array.from(a.usuarios).sort(),
    }))
    .sort((x, y) => y.totalAtendido - x.totalAtendido || y.numRqs - x.numRqs)
}

export type SerieDia = { dia: string; rqs: number; atendidas: number }

/** RQs registradas y completadas por día (últimos N días calendario, Lima). */
export function serieRqsPorDia(rqs: ReporteRq[], dias = 14): SerieDia[] {
  const hoy = new Date()
  const diasClave: string[] = []
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoy)
    d.setDate(hoy.getDate() - i)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    diasClave.push(`${d.getFullYear()}-${mm}-${dd}`)
  }
  const registradas = new Map<string, number>(diasClave.map((k) => [k, 0]))
  const completadas = new Map<string, number>(diasClave.map((k) => [k, 0]))
  for (const r of rqs) {
    if (registradas.has(r.fecha)) registradas.set(r.fecha, (registradas.get(r.fecha) ?? 0) + 1)
    if (r.estado === 'Atendido' && completadas.has(r.fecha))
      completadas.set(r.fecha, (completadas.get(r.fecha) ?? 0) + 1)
  }
  return diasClave.map((dia) => ({ dia, rqs: registradas.get(dia) ?? 0, atendidas: completadas.get(dia) ?? 0 }))
}

export type SerieLinea = { linea: string; rqs: number; atendidas: number }

/** RQs por línea/área (top N por volumen; '' agrupa como «Sin línea»). */
export function serieRqsPorLinea(rqs: ReporteRq[], top = 6): SerieLinea[] {
  const acc = new Map<string, { rqs: number; atendidas: number }>()
  for (const r of rqs) {
    const k = r.linea.trim() || 'Sin línea'
    let a = acc.get(k)
    if (!a) {
      a = { rqs: 0, atendidas: 0 }
      acc.set(k, a)
    }
    a.rqs++
    if (r.estado === 'Atendido') a.atendidas++
  }
  return Array.from(acc.entries())
    .map(([linea, a]) => ({ linea, ...a }))
    .sort((x, y) => y.rqs - x.rqs)
    .slice(0, top)
}

export type TopArticulo = { codigo: string; descripcion: string; atendido: number; pedido: number; unidad: string }

/** Top N artículos por unidades atendidas (gráfico del dashboard). */
export function topArticulosAtendidos(items: ReporteItem[], top = 8): TopArticulo[] {
  const resumen = resumenPorArticulo(items, [])
  return resumen
    .filter((r) => r.totalAtendido > 0)
    .slice(0, top)
    .map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, atendido: r.totalAtendido, pedido: r.totalPedido, unidad: r.unidad }))
}
