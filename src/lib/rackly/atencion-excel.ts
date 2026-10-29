'use client'

/**
 * RACKLY — Atención · Exportación a EXCEL del reporte de atención a líneas.
 *
 * Formato pedido por el usuario (2026-10-29):
 *   · Hoja 1 "RQs"             → TODOS los encabezados (1 fila por RQ).
 *   · Hoja 2 "Materiales"      → 1 fila por MATERIAL de cada RQ: pedido vs
 *                                atendido, quién y cuándo lo atendió.
 *   · Hoja 3 "Salidas (tomas)" → el LEDGER de salidas: 1 fila por toma con
 *                                ubicación, LOTE y F. VENCIMIENTO (resuelto
 *                                desde movimientos), saldo y usuario.
 *   · Hoja 4 "Resumen artículo"→ agregado POR ARTÍCULO atendido (pedido,
 *                                atendido, pendiente, %, RQs, usuarios).
 *   · Hoja 5 "Dashboard"       → KPIs + tablas por día/línea y top de
 *                                artículos, listo para presentar/imprimir.
 *
 * Patrón idéntico a guia-excel.ts: armado de datos PURO (testeable con
 * esbuild+node); solo exportarExcelAtencion() toca el navegador (descarga
 * directa vía xlsx-js-style — 'xlsx' CE no escribe estilos).
 */

import type { DatosReporte, ReporteRq, ReporteItem, ReporteToma, KpisAtencion, SerieDia, SerieLinea, TopArticulo, ResumenArticulo } from '@/lib/rackly/atencion-reporte'
import { kpisAtencion, resumenPorArticulo, serieRqsPorDia, serieRqsPorLinea, topArticulosAtendidos } from '@/lib/rackly/atencion-reporte'

type Celda = { s?: Record<string, unknown>; t?: string; v?: unknown }

/** Cantidad legible: 3 decimales como máximo (mismo criterio que la UI). */
const cant3 = (n: number) => Math.round(n * 1000) / 1000

/** ISO timestamp → fecha/hora local legible ('' si vacío). */
const fh = (iso: string) => (iso ? new Date(iso).toLocaleString('es-PE') : '')

/** Nombre del archivo: Reporte_Atencion_Lineas_2026-10-29.xlsx */
export function nombreArchivoReporte(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `Reporte_Atencion_Lineas_${d.getFullYear()}-${mm}-${dd}.xlsx`
}

// ═══════════════════════════════════════════════════════════════════
// FILAS de cada hoja (PURO — json_to_sheet consume estos objetos)
// ═══════════════════════════════════════════════════════════════════

export function filasHojaRqs(rqs: ReporteRq[]): Record<string, string | number>[] {
  return rqs.map((r, i) => ({
    'Nº': i + 1,
    'Nº RQ': r.numeroRq,
    'Fecha': r.fecha,
    'Turno hoja': r.turnoRq || '',
    'Turno sistema': r.turno,
    'OP': r.ordenProduccion,
    'Producto': r.productoCodigo,
    'Descripción producto': r.productoDescripcion,
    'Línea': r.linea,
    'Solicitante': r.solicitante,
    'Estado': r.estado,
    'Registró': r.usuarioNombre,
    'Registrado (fecha/hora)': fh(r.createdAt),
    'Notas': r.notas,
  }))
}

export function filasHojaMateriales(
  rqs: ReporteRq[],
  items: ReporteItem[]
): Record<string, string | number>[] {
  const rq = new Map(rqs.map((r) => [r.id, r]))
  return items.map((it, i) => {
    const h = rq.get(it.rqId)
    const pendiente = Math.max(it.cantidad - it.cantidadAtendida, 0)
    return {
      'Nº': i + 1,
      'Nº RQ': h?.numeroRq ?? '',
      'Fecha RQ': h?.fecha ?? '',
      'Turno hoja': h?.turnoRq ?? '',
      'Línea': h?.linea ?? '',
      'Solicitante': h?.solicitante ?? '',
      'Código': it.codigo,
      'Descripción': it.descripcion,
      'Und': it.unidad,
      'Cant. pedida': cant3(it.cantidad),
      'Cant. atendida': cant3(it.cantidadAtendida),
      'Pendiente': cant3(pendiente),
      'Estado': pendiente === 0 ? 'Completo' : it.cantidadAtendida > 0 ? 'Parcial' : 'Pendiente',
      'Atendió': it.usuarioAtencion,
      'Atendido (fecha/hora)': fh(it.atendidoEn),
    }
  })
}

export function filasHojaSalidas(
  rqs: ReporteRq[],
  items: ReporteItem[],
  tomas: ReporteToma[],
  vencimientos: Map<string, string>
): Record<string, string | number>[] {
  const rq = new Map(rqs.map((r) => [r.id, r]))
  const item = new Map(items.map((it) => [it.id, it]))
  return tomas.map((t, i) => {
    const h = rq.get(t.rqId)
    const it = item.get(t.itemId)
    const venc = t.lote.trim() ? (vencimientos.get(`${t.codigo}|${t.lote}`) ?? '') : ''
    return {
      'Nº': i + 1,
      'Fecha salida': fh(t.creadoEn),
      'Nº RQ': h?.numeroRq ?? '',
      'Fecha RQ': h?.fecha ?? '',
      'Turno hoja': h?.turnoRq ?? '',
      'Línea': h?.linea ?? '',
      'Código': t.codigo,
      'Descripción': it?.descripcion ?? '',
      'Und': it?.unidad ?? '',
      'Tipo': t.origen === 'reversa' ? 'REVERSA' : 'Salida',
      'Origen': t.origen,
      'Cantidad': cant3(t.cantidad),
      'Ubicación': t.ubicacion,
      'Lote': t.lote,
      'F. vencimiento': venc,
      'Saldo tras toma': t.saldoResultante === null ? '' : cant3(t.saldoResultante),
      'Atendió': t.usuarioNombre,
      'Turno salida': t.turno,
    }
  })
}

export function filasHojaResumen(resumen: ResumenArticulo[]): Record<string, string | number>[] {
  return resumen.map((r, i) => ({
    'Nº': i + 1,
    'Código': r.codigo,
    'Descripción': r.descripcion,
    'Und': r.unidad,
    'Nº de RQs': r.numRqs,
    'Total pedido': cant3(r.totalPedido),
    'Total atendido': cant3(r.totalAtendido),
    'Pendiente': cant3(r.pendiente),
    '% atendido': r.pctAtendido,
    '1ª atención': fh(r.primeraAtencion),
    'Última atención': fh(r.ultimaAtencion),
    'Usuarios': r.usuarios.join(', '),
  }))
}

// ═══════════════════════════════════════════════════════════════════
// HOJA DASHBOARD (bloques KPI + por día + por línea + top artículos)
// ═══════════════════════════════════════════════════════════════════

/** Tabla 2D del bloque dashboard: encabezado + filas (PURO). */
export function tablaDashboard(
  kpis: KpisAtencion,
  porDia: SerieDia[],
  porLinea: SerieLinea[],
  top: TopArticulo[]
): (string | number)[][] {
  const filas: (string | number)[][] = []
  filas.push(['REPORTE DE ATENCIÓN A LÍNEAS — RESUMEN'])
  filas.push([`Generado: ${new Date().toLocaleString('es-PE')}`])
  filas.push([])
  filas.push(['INDICADORES', ''])
  filas.push(['RQs totales', kpis.totalRqs])
  filas.push(['RQs pendientes', kpis.pendientes])
  filas.push(['RQs en proceso', kpis.enProceso])
  filas.push(['RQs atendidas (completas)', kpis.atendidas])
  filas.push(['Materiales (ítems)', kpis.materiales])
  filas.push(['Materiales completados', kpis.materialesAtendidos])
  filas.push(['% de atención (materiales)', kpis.pctAtencion])
  filas.push(['Unidades pedidas', cant3(kpis.unidadesPedidas)])
  filas.push(['Unidades atendidas', cant3(kpis.unidadesAtendidas)])
  filas.push([])
  filas.push(['RQs POR DÍA', ''])
  filas.push(['Día', 'Registradas', 'Atendidas'])
  for (const d of porDia) filas.push([d.dia, d.rqs, d.atendidas])
  filas.push([])
  filas.push(['RQs POR LÍNEA', ''])
  filas.push(['Línea', 'RQs', 'Atendidas'])
  for (const l of porLinea) filas.push([l.linea, l.rqs, l.atendidas])
  filas.push([])
  filas.push(['TOP ARTÍCULOS ATENDIDOS', ''])
  filas.push(['Código', 'Descripción', 'Atendido', 'Pedido', 'Und'])
  for (const t of top) filas.push([t.codigo, t.descripcion, cant3(t.atendido), cant3(t.pedido), t.unidad])
  return filas
}

// ═══════════════════════════════════════════════════════════════════
// ESTILOS (xlsx-js-style) — paleta sobria de impresión
// ═══════════════════════════════════════════════════════════════════

const BORDE = {
  top: { style: 'thin', color: { rgb: 'B9C4D0' } },
  bottom: { style: 'thin', color: { rgb: 'B9C4D0' } },
  left: { style: 'thin', color: { rgb: 'B9C4D0' } },
  right: { style: 'thin', color: { rgb: 'B9C4D0' } },
}

const EST = {
  cabTabla: {
    font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '2E5A88' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: BORDE,
  },
  seccion: {
    font: { bold: true, sz: 11, color: { rgb: '1E3A5F' } },
    fill: { fgColor: { rgb: 'EEF2F7' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  titulo: {
    font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1E3A5F' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
}

/** Cabecera de una tabla json_to_sheet con estilo + anchos. */
function estilizarTabla(
  ws: Record<string, unknown>,
  XLSX: typeof import('xlsx'),
  anchos: { wch: number }[]
): void {
  const rango = XLSX.utils.decode_range((ws['!ref'] as string) || 'A1')
  for (let C = rango.s.c; C <= rango.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: C })
    if (addr in ws) (ws[addr] as Celda).s = EST.cabTabla
  }
  ws['!cols'] = anchos
  ws['!margins'] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTADOR (única función que toca el navegador)
// ═══════════════════════════════════════════════════════════════════

/**
 * Genera y DESCARGA el .xlsx del reporte de atención. Devuelve el nombre
 * del archivo (para el toast). La libra entra en memoria solo al exportar.
 */
export async function exportarExcelAtencion(datos: DatosReporte): Promise<string> {
  const XLSX = (await import('xlsx-js-style')) as unknown as typeof import('xlsx')
  const wb = XLSX.utils.book_new()

  const kpis = kpisAtencion(datos.rqs, datos.items)
  const resumen = resumenPorArticulo(datos.items, datos.rqs)
  const porDia = serieRqsPorDia(datos.rqs)
  const porLinea = serieRqsPorLinea(datos.rqs)
  const top = topArticulosAtendidos(datos.items)

  // ── Hoja 1: RQs ──
  const wsRqs = XLSX.utils.json_to_sheet(filasHojaRqs(datos.rqs))
  estilizarTabla(wsRqs, XLSX, [
    { wch: 5 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
    { wch: 11 }, { wch: 34 }, { wch: 9 }, { wch: 30 }, { wch: 11 }, { wch: 24 },
    { wch: 19 }, { wch: 26 },
  ])
  XLSX.utils.book_append_sheet(wb, wsRqs, 'RQs')

  // ── Hoja 2: Materiales ──
  const wsMat = XLSX.utils.json_to_sheet(filasHojaMateriales(datos.rqs, datos.items))
  estilizarTabla(wsMat, XLSX, [
    { wch: 5 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 9 }, { wch: 26 },
    { wch: 10 }, { wch: 36 }, { wch: 7 }, { wch: 12 }, { wch: 13 }, { wch: 11 },
    { wch: 10 }, { wch: 24 }, { wch: 19 },
  ])
  XLSX.utils.book_append_sheet(wb, wsMat, 'Materiales')

  // ── Hoja 3: Salidas (tomas) ──
  const wsSal = XLSX.utils.json_to_sheet(
    filasHojaSalidas(datos.rqs, datos.items, datos.tomas, datos.vencimientos)
  )
  estilizarTabla(wsSal, XLSX, [
    { wch: 5 }, { wch: 19 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 9 },
    { wch: 10 }, { wch: 36 }, { wch: 7 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
    { wch: 16 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 24 }, { wch: 10 },
  ])
  XLSX.utils.book_append_sheet(wb, wsSal, 'Salidas (tomas)')

  // ── Hoja 4: Resumen por artículo ──
  const wsRes = XLSX.utils.json_to_sheet(filasHojaResumen(resumen))
  estilizarTabla(wsRes, XLSX, [
    { wch: 5 }, { wch: 10 }, { wch: 36 }, { wch: 7 }, { wch: 10 }, { wch: 13 },
    { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 19 }, { wch: 19 }, { wch: 30 },
  ])
  XLSX.utils.book_append_sheet(wb, wsRes, 'Resumen artículo')

  // ── Hoja 5: Dashboard (bloques, listo para presentar) ──
  const wsDash = XLSX.utils.aoa_to_sheet(tablaDashboard(kpis, porDia, porLinea, top))
  aplicarEstilosDashboard(wsDash, XLSX)
  XLSX.utils.book_append_sheet(wb, wsDash, 'Dashboard')

  const nombre = nombreArchivoReporte()
  XLSX.writeFile(wb, nombre)
  return nombre
}

/** Estilos del dashboard: título + secciones + cabeceras de mini-tablas. */
function aplicarEstilosDashboard(
  ws: Record<string, unknown>,
  XLSX: typeof import('xlsx'),
): void {
  const rango = XLSX.utils.decode_range((ws['!ref'] as string) || 'A1')
  for (let R = rango.s.r; R <= rango.e.r; R++) {
    for (let C = rango.s.c; C <= Math.min(rango.e.c, 4); C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      if (!(addr in ws)) continue
      const v = String((ws[addr] as Celda).v ?? '')
      if (R === 0) (ws[addr] as Celda).s = EST.titulo
      else if (['INDICADORES', 'RQs POR DÍA', 'RQs POR LÍNEA', 'TOP ARTÍCULOS ATENDIDOS'].includes(v))
        (ws[addr] as Celda).s = EST.seccion
      else if (v === 'Día' || v === 'Línea' || v === 'Código')
        (ws[addr] as Celda).s = EST.cabTabla
    }
  }
  ws['!cols'] = [{ wch: 28 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 8 }]
  ws['!margins'] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
}
