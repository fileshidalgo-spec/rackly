'use client'

/**
 * RACKLY — Recepción · Excel CONSOLIDADO por RANGO DE FECHAS y TURNOS
 * (pedido del usuario 2026-11-11: "podría generar un Excel por el rango
 * de fechas que seleccione y por los turnos dentro de esa selección").
 *
 * Antes: UN Excel por cada guía (botón Excel de cada fila — sigue intacto).
 * Ahora: UN libro para todo el rango —
 *   · Hoja 1 "Resumen"  → IMPRIMIBLE: filtros aplicados (desde/hasta/
 *                          turnos/tipo), resumen POR TURNO (documentos,
 *                          filas y cantidad de cada turno) y la tabla de
 *                          TODOS los documentos del rango.
 *   · Hoja 2 "Artículos"→ TODAS las filas registradas del rango (paletas
 *                          incluidas) con el contexto de su documento:
 *                          fecha, tipo, Nº documento, empresa origen y
 *                          placa — y su TURNO por fila.
 *
 * RANGO: filtra por la FECHA DEL DOCUMENTO (columna `fecha`, la misma que
 * muestra la lista — inclusiva en ambos extremos).
 * TURNO: regla del almacén T1 = 07:20:00→19:20:59 · T2 = 19:21:00→07:19:59
 * (hora de Lima) derivada del created_at de cada fila — la MISMA regla del
 * Excel por guía (lib/rackly/turno.ts → calcularTurnoRecepcion); la BD no
 * guarda turno. El filtro por turno se aplica en el cliente.
 *
 * Patrón idéntico a guia-excel.ts: armado de datos PURO (testeable con
 * esbuild+node); solo exportarRangoExcel() toca el navegador (descarga
 * directa vía xlsx-js-style). Estilos COMPARTIDOS con guia-excel (EST +
 * clonar) — un solo look corporativo.
 */

import type { FilaRegistrada, GuiaAgrupada } from '@/lib/rackly/recepcion-filas'
import {
  agruparGuias,
  marcaPaletaDe,
  obsSinMarcaPaleta,
} from '@/lib/rackly/recepcion-filas'
import { EST, clonar, turnoDeFila } from '@/lib/rackly/guia-excel'
import type { TurnoRecepcion } from '@/lib/rackly/turno'

/** Datos que la exportación necesita (los arma RecepcionModule). */
export type ParametrosRangoExcel = {
  /** Fecha de documento inicial del rango (ISO yyyy-mm-dd). */
  desde: string
  /** Fecha de documento final del rango (ISO, inclusiva). */
  hasta: string
  /** Turnos seleccionados (T1/T2) — las filas vienen YA filtradas. */
  turnos: TurnoRecepcion[]
  /** Etiqueta legible de la pestaña exportada (Resumen). */
  etiquetaSeccion: string
  /** Prefijo del nombre de archivo ('Recepcion' | 'Devoluciones'). */
  prefijoArchivo: string
  /** Filas del rango YA filtradas por turno (orden fecha DESC). */
  filas: FilaRegistrada[]
}

/** Cantidad redondeada a 3 decimales (mismo criterio que la UI). */
const cant3 = (n: number) => Math.round(n * 1000) / 1000

/** Saneado de nombre de archivo (mismo criterio que nombreArchivoGuia). */
function limpio(s: string): string {
  return (s || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Nombre del archivo: Recepcion_Rango_2026-11-01_al_2026-11-11.xlsx
 * (devoluciones → Devoluciones_Rango_…). Fechas ya vienen ISO.
 */
export function nombreArchivoRango(
  desde: string,
  hasta: string,
  prefijoArchivo: string
): string {
  const pref = limpio(prefijoArchivo) || 'Recepcion'
  const d = limpio(desde) || 'SIN-DESDE'
  const h = limpio(hasta) || 'SIN-HASTA'
  return `${pref}_Rango_${d}_al_${h}.xlsx`
}

/**
 * Filtra las filas por TURNO seleccionado (PURO). Regla honesta para filas
 * sin created_at legible (turno ''): solo se conservan cuando el usuario
 * NO está filtrando (ambos turnos marcados) — jamás se asignan a un turno
 * que no les corresponde.
 */
export function filtrarPorTurnos(
  filas: FilaRegistrada[],
  turnos: TurnoRecepcion[]
): FilaRegistrada[] {
  const ambos = turnos.length >= 2
  const sel = new Set(turnos)
  return filas.filter((f) => {
    const t = turnoDeFila(f)
    if (!t) return ambos
    return sel.has(t)
  })
}

/** Totales de UN turno (PURO, para la hoja Resumen). */
export type TotalesTurno = {
  turno: TurnoRecepcion
  filas: number
  cantidad: number
  documentos: number
}

/**
 * Agrupa las filas por turno: filas, cantidad total y Nº de DOCUMENTOS
 * distintos (identidad M-2 de la guía) presentes en cada turno.
 */
export function agruparTurnos(filas: FilaRegistrada[]): TotalesTurno[] {
  const porTurno = new Map<TurnoRecepcion, { filas: number; cantidad: number; docs: Set<string> }>()
  for (const f of filas) {
    const t = turnoDeFila(f)
    if (!t) continue
    let acc = porTurno.get(t)
    if (!acc) {
      acc = { filas: 0, cantidad: 0, docs: new Set() }
      porTurno.set(t, acc)
    }
    acc.filas += 1
    acc.cantidad += f.cantidad
    acc.docs.add(
      f.guiaId?.trim()
        ? `G:${f.guiaId.trim()}`
        : `D:${(f.tipoDocumento ?? '').trim().toUpperCase()}|${(f.numeroDocumento ?? '').trim().toUpperCase()}`
    )
  }
  // Orden estable T1 → T2 (aunque solo exista uno).
  return (['T1', 'T2'] as TurnoRecepcion[])
    .filter((t) => porTurno.has(t))
    .map((t) => {
      const acc = porTurno.get(t)!
      return { turno: t, filas: acc.filas, cantidad: cant3(acc.cantidad), documentos: acc.docs.size }
    })
}

/**
 * Filas YA registradas del rango → objeto plano para la hoja "Artículos"
 * (PURO): 1 fila por CADA fila registrada (paletas incluidas) CON el
 * contexto de su documento (fecha, tipo, Nº, empresa origen, placa) y su
 * TURNO. Mismas columnas de artículo que el Excel por guía.
 */
export function filasRangoAExcel(filas: FilaRegistrada[]): Record<string, string | number>[] {
  return filas.map((f, i) => {
    const marca = marcaPaletaDe(f.observaciones)
    return {
      'Nº': i + 1,
      'Fecha': f.fecha,
      'Tipo': f.tipoDocumento,
      'Nº documento': f.numeroDocumento,
      'Empresa origen': f.empresaOrigen || f.proveedor,
      'Placa': f.placa,
      'Código': f.codigo,
      'Descripción': f.descripcion,
      'Proveedor': f.proveedor,
      'Cantidad': cant3(f.cantidad),
      'Unidad': f.unidadMedida,
      'Lote': f.lote,
      'F. producción': f.fechaProduccion,
      'F. vencimiento': f.fechaVencimiento,
      'Paleta': marca ? `Paleta ${marca.i}/${marca.n}` : '',
      'Estado': f.estado,
      'Observaciones': obsSinMarcaPaleta(f.observaciones),
      'Registró': f.usuarioNombre,
      'Registrado (fecha/hora)': f.createdAt ? new Date(f.createdAt).toLocaleString('es-PE') : '',
      'Turno': turnoDeFila(f),
    }
  })
}

/**
 * Documentos del rango → filas de la tabla por guía de la hoja "Resumen"
 * (PURO). El estado '' (filas con estados distintos) se muestra 'Mixto'.
 * Turnos: los turnos DISTINCTOS presentes en las filas del documento.
 */
export function guiasRangoAExcel(guias: GuiaAgrupada[]): Record<string, string | number>[] {
  return guias.map((g, i) => {
    const turnos = [...new Set(g.filas.map((f) => turnoDeFila(f)).filter(Boolean))] as string[]
    return {
      'Nº': i + 1,
      'Fecha': g.fecha,
      'Tipo': g.tipoDocumento,
      'Nº documento': g.numeroDocumento,
      'Empresa origen': g.empresaOrigen || g.proveedor,
      'Placa': g.placa,
      'Estado': g.estado || 'Mixto',
      'Filas': g.filas.length,
      'Cantidad total': cant3(g.cantidadTotal),
      'Turnos': turnos.join('·') || '—',
    }
  })
}

/** Orden de columnas de la tabla por guía (la AOA la consume fijo). */
const COLS_GUIA = [
  'Nº', 'Fecha', 'Tipo', 'Nº documento', 'Empresa origen',
  'Placa', 'Estado', 'Filas', 'Cantidad total', 'Turnos',
] as const

/**
 * Construye la HOJA "Resumen" (PURO, exportado para tests): filtros +
 * resumen por turno + tabla de documentos, con los estilos corporativos.
 */
export function construirHojaResumenRango(
  p: ParametrosRangoExcel,
  guias: GuiaAgrupada[],
  XLSX: typeof import('xlsx')
): import('xlsx').WorkSheet {
  const totales = agruparTurnos(p.filas)
  const nCols = COLS_GUIA.length // A..J

  const aoa: (string | number | null)[][] = []
  aoa.push([`RECEPCIÓN POR RANGO — ${p.etiquetaSeccion.toUpperCase()}`])
  aoa.push(['RACKLY · consolidado por fechas de documento y turnos'])
  aoa.push([])
  const filtros: [string, string | number][] = [
    ['Desde', p.desde],
    ['Hasta', p.hasta],
    ['Turnos', p.turnos.join(' + ') || '—'],
    ['Tipo', p.etiquetaSeccion],
    ['Documentos', guias.length],
    ['Filas exportadas', p.filas.length],
    ['Exportado', new Date().toLocaleString('es-PE')],
  ]
  for (const [campo, valor] of filtros) aoa.push([campo, valor])
  aoa.push([])

  // — Resumen POR TURNO (pedido: "por los turnos dentro de esa selección")
  aoa.push(['RESUMEN POR TURNO'])
  aoa.push(['Turno', 'Documentos', 'Filas', 'Cantidad total'])
  for (const t of totales) aoa.push([t.turno, t.documentos, t.filas, t.cantidad])
  const rTurnoCab = 3 + filtros.length + 2 // fila 0-based de la cabecera por turno
  aoa.push([])

  // — Tabla por documento
  aoa.push(['DOCUMENTOS DEL RANGO'])
  const filasGuia = guiasRangoAExcel(guias)
  aoa.push([...COLS_GUIA])
  for (const g of filasGuia) aoa.push(COLS_GUIA.map((c) => g[c] ?? ''))
  const rDocCab = rTurnoCab + 1 + totales.length + 2 // cabecera de la tabla por documento
  const nFilasDoc = filasGuia.length
  aoa.push([])
  aoa.push(['Cantidad total del rango', cant3(p.filas.reduce((s, f) => s + f.cantidad, 0))])
  aoa.push(['Generado por', 'RACKLY · Recepción (rackly.pages.dev)'])

  const ws = XLSX.utils.aoa_to_sheet(aoa as unknown[][])

  // — Materializar celdas vacías de las filas de título (misma regla que
  //    construirHojaGuia: el borde del merge se pinta celda por celda).
  for (let R = 0; R <= 1; R++) {
    for (let C = 0; C < nCols; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      if (!(addr in ws)) ws[addr] = { t: 's', v: '' } as { v: string | number; t: string; s?: object }
    }
  }

  // — Estilos por zona (mismas plantillas que la guía)
  for (let R = 0; R < aoa.length; R++) {
    for (let C = 0; C < nCols; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      if (!(addr in ws)) continue
      const cel = ws[addr] as { v: string | number; t: string; s?: object }
      if (R === 0) { cel.s = clonar(EST.titulo); continue }
      if (R === 1) { cel.s = clonar(EST.subtitulo); continue }
      if (R >= 3 && R < 3 + filtros.length) {
        cel.s = clonar(C === 0 ? EST.etiqueta : EST.valor)
        continue
      }
      if (R === rTurnoCab - 1) { cel.s = clonar(EST.etiqueta); continue } // «RESUMEN POR TURNO»
      if (R === rTurnoCab) { cel.s = clonar(EST.cabTabla); continue }
      if (R > rTurnoCab && R < rTurnoCab + totales.length) {
        cel.s = clonar(EST.celda); continue
      }
      if (R === rDocCab - 1) { cel.s = clonar(EST.etiqueta); continue } // «DOCUMENTOS DEL RANGO»
      if (R === rDocCab) { cel.s = clonar(EST.cabTabla); continue }
      if (R > rDocCab && R < rDocCab + nFilasDoc) {
        // Nº (A) y Cantidad total (I) centrados; resto a la izquierda
        cel.s = clonar(C === 0 || C === 8 ? EST.celdaCentro : EST.celda)
        continue
      }
      const rTotal = rDocCab + nFilasDoc + 1
      if (R >= rTotal && R < rTotal + 2 && C <= 1) cel.s = clonar(EST.total)
    }
  }

  // — Fusiones de título/subtítulo a lo ancho de la tabla
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } },
  ]

  // — Alturas y anchos (caracteres) pensados para A4
  ws['!rows'] = [
    { hpt: 26 }, { hpt: 16 }, { hpt: 6 },
    ...filtros.map(() => ({ hpt: 15 })),
    { hpt: 6 },
    { hpt: 18 }, { hpt: 24 },
    ...totales.map(() => ({ hpt: 15 })),
    { hpt: 6 },
    { hpt: 18 }, { hpt: 24 },
    ...filasGuia.map(() => ({ hpt: 15 })),
    { hpt: 6 },
    { hpt: 15 }, { hpt: 15 },
  ]
  ws['!cols'] = [
    { wch: 5 },   // A  Nº
    { wch: 12 },  // B  Fecha
    { wch: 16 },  // C  Tipo
    { wch: 18 },  // D  Nº documento
    { wch: 26 },  // E  Empresa origen
    { wch: 12 },  // F  Placa
    { wch: 14 },  // G  Estado
    { wch: 8 },   // H  Filas
    { wch: 14 },  // I  Cantidad total
    { wch: 10 },  // J  Turnos
  ]
  ws['!margins'] = {
    left: 0.3, right: 0.3, top: 0.4, bottom: 0.4,
    header: 0.2, footer: 0.2,
  }
  return ws
}

/**
 * Arma el libro COMPLETO (PURO, exportado para tests): Hoja "Resumen" +
 * Hoja "Artículos". No escribe archivos.
 */
export function construirLibroRango(
  p: ParametrosRangoExcel,
  XLSX: typeof import('xlsx')
): { wb: import('xlsx').WorkBook; guias: GuiaAgrupada[] } {
  if (p.filas.length === 0) {
    throw new Error('No hay filas para exportar en ese rango/turnos.')
  }
  // Agrupado por documento (M-2): el Resumen lista UNA fila por documento.
  const guias = agruparGuias(p.filas)
  const wb = XLSX.utils.book_new()

  // ── Hoja 1: Resumen (filtros + por turno + documentos) ──
  XLSX.utils.book_append_sheet(wb, construirHojaResumenRango(p, guias, XLSX), 'Resumen')

  // ── Hoja 2: Artículos (TODAS las filas con contexto de documento) ──
  const wsArt = XLSX.utils.json_to_sheet(filasRangoAExcel(p.filas))
  const rango = XLSX.utils.decode_range(wsArt['!ref'] || 'A1')
  for (let C = rango.s.c; C <= rango.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: C })
    if (addr in wsArt) (wsArt[addr] as { v: string | number; t: string; s?: object }).s = clonar(EST.cabTabla)
  }
  wsArt['!cols'] = [
    { wch: 5 },   // Nº
    { wch: 12 },  // Fecha
    { wch: 16 },  // Tipo
    { wch: 18 },  // Nº documento
    { wch: 24 },  // Empresa origen
    { wch: 12 },  // Placa
    { wch: 14 },  // Código
    { wch: 36 },  // Descripción
    { wch: 14 },  // Proveedor
    { wch: 11 },  // Cantidad
    { wch: 8 },   // Unidad
    { wch: 14 },  // Lote
    { wch: 14 },  // F. producción
    { wch: 14 },  // F. vencimiento
    { wch: 11 },  // Paleta
    { wch: 11 },  // Estado
    { wch: 26 },  // Observaciones
    { wch: 18 },  // Registró
    { wch: 20 },  // Registrado (fecha/hora)
    { wch: 7 },   // Turno
  ]
  wsArt['!margins'] = {
    left: 0.3, right: 0.3, top: 0.4, bottom: 0.4,
    header: 0.2, footer: 0.2,
  }
  XLSX.utils.book_append_sheet(wb, wsArt, 'Artículos')

  return { wb, guias }
}

/**
 * Genera y DESCARGA el .xlsx del rango. Devuelve nombre + conteos (toast).
 * Dinámico: la libra entra en memoria solo al exportar (igual que la guía).
 */
export async function exportarRangoExcel(
  p: ParametrosRangoExcel
): Promise<{ nombre: string; guias: number; filas: number }> {
  const XLSX = (await import('xlsx-js-style')) as unknown as typeof import('xlsx')
  const { wb, guias } = construirLibroRango(p, XLSX)
  const nombre = nombreArchivoRango(p.desde, p.hasta, p.prefijoArchivo)
  XLSX.writeFile(wb, nombre)
  return { nombre, guias: guias.length, filas: p.filas.length }
}
