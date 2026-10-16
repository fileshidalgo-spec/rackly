'use client'

/**
 * RACKLY — Recepción · Exportación a EXCEL de UNA guía registrada.
 *
 * Formato pedido por el usuario (con ejemplo real adjunto):
 *   · Hoja 1 "Guía"      → IMPRIMIBLE: título, encabezado del documento
 *                          (fecha, tipo/nº, proveedor, placa, estado,
 *                          turno, quién registró, exportado) y la tabla
 *                          de ítems CON la columna TURNO. Estilos reales
 *                          (negritas, bordes, anchos) via xlsx-js-style
 *                          (fork drop-in de SheetJS con celdas
 *                          estilizables; 'xlsx' CE no escribe estilos).
 *   · Hoja 2 "Artículos" → TODOS los datos: 1 fila por CADA fila
 *                          registrada (paletas incluidas) + columna TURNO.
 *
 * TURNO (regla del almacén): T1 = 07:20:00→19:20:59 · T2 = 19:21:00→07:19:59
 * (hora de Lima). La BD no guarda turno en recepcion_registros: se DERIVA
 * del created_at de cada fila — corrige también guías históricas sin
 * migrar datos. Regla centralizada en lib/rackly/turno.ts
 * (calcularTurnoRecepcion), aislada del turno Día/Noche de Kardex.
 *
 * El armado de datos es PURO (testeable con esbuild+node); solo el
 * writeFile toca el navegador (descarga directa, sin servidor).
 */

import type { FilaRegistrada, GuiaAgrupada } from '@/lib/rackly/recepcion-filas'
import { marcaPaletaDe, obsSinMarcaPaleta } from '@/lib/rackly/recepcion-filas'
import { calcularTurnoRecepcion, type TurnoRecepcion } from '@/lib/rackly/turno'

/** Lo que la exportación necesita del grupo (GuiaAgrupada lo satisface). */
export type GuiaParaExcel = Pick<
  GuiaAgrupada,
  | 'fecha'
  | 'tipoDocumento'
  | 'numeroDocumento'
  | 'proveedor'
  | 'placa'
  | 'fotoUrl'
  | 'usuarioNombre'
  | 'usuarioCorreo'
  | 'filas'
  | 'cantidadTotal'
> & { estado: string }

/**
 * Nombre de archivo SEGURO: sin espacios, tildes ni caracteres que algunos
 * gestores de archivos rechazan. Ej: Guia_Guia_T173-00004090_2026-10-11.xlsx
 * Sin nº de documento cae al proveedor (y por último a SIN-NUMERO).
 */
export function nombreArchivoGuia(
  g: Pick<GuiaParaExcel, 'tipoDocumento' | 'numeroDocumento' | 'fecha' | 'proveedor'>
): string {
  const limpio = (s: string) =>
    (s || '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const doc = limpio(g.numeroDocumento) || limpio(g.proveedor) || 'SIN-NUMERO'
  const fecha = limpio(g.fecha)
  const partes = ['Guia', limpio(g.tipoDocumento) || 'DOC', doc]
  if (fecha) partes.push(fecha)
  return `${partes.join('_')}.xlsx`
}

/** Turno T1/T2 de una fila: por la HORA de registro (created_at, Lima).
 *  '' solo si la fila no trae fecha válida (nunca debe pasar). */
export function turnoDeFila(f: Pick<FilaRegistrada, 'createdAt'>): TurnoRecepcion | '' {
  if (!f.createdAt) return ''
  const d = new Date(f.createdAt)
  if (isNaN(d.getTime())) return ''
  return calcularTurnoRecepcion(d)
}

/** Cantidad redondeada a 3 decimales (mismo criterio que la UI). */
const cant3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Filas YA registradas → objeto plano para la hoja "Artículos" (PURO).
 * La marca "Paleta i/N" sale a SU columna y las observaciones quedan limpias
 * (solo el texto que el usuario digitó). Incluye la columna TURNO.
 */
export function filasGuiaAExcel(filas: FilaRegistrada[]): Record<string, string | number>[] {
  return filas.map((f, i) => {
    const marca = marcaPaletaDe(f.observaciones)
    return {
      'Nº': i + 1,
      'Código': f.codigo,
      'Descripción': f.descripcion,
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
 * Tabla de ítems de la HOJA "Guía" (PURO): columnas EXACTAS del formato
 * que pidió el usuario. Fila 0 = cabecera, siguientes = ítems.
 */
export function filasGuiaATablaTurno(filas: FilaRegistrada[]): (string | number)[][] {
  const cabecera = [
    'Fecha', 'Nº de documento', 'Código', 'Descripción', 'Unidad', 'Cantidad',
    'Lote', 'F. producción', 'F. vencimiento', 'Registró', 'Turno',
  ]
  const cuerpo = filas.map((f) => [
    f.fecha,
    f.numeroDocumento,
    f.codigo,
    f.descripcion,
    f.unidadMedida,
    cant3(f.cantidad),
    f.lote,
    f.fechaProduccion,
    f.fechaVencimiento,
    f.usuarioNombre,
    turnoDeFila(f),
  ])
  return [cabecera, ...cuerpo]
}

// ─── Estilos compartidos (xlsx-js-style) ─────────────────────────────
/** Paleta corporativa sobria para impresión (grises + acento oscuro). */
const EST = {
  titulo: {
    font: { bold: true, sz: 16, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1E3A5F' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
  subtitulo: {
    font: { italic: true, sz: 10, color: { rgb: '475569' } },
    fill: { fgColor: { rgb: 'EEF2F7' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  },
  etiqueta: {
    font: { bold: true, sz: 10, color: { rgb: '1E293B' } },
    fill: { fgColor: { rgb: 'E8EDF3' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: {
      top: { style: 'thin', color: { rgb: 'B9C4D0' } },
      bottom: { style: 'thin', color: { rgb: 'B9C4D0' } },
      left: { style: 'thin', color: { rgb: 'B9C4D0' } },
      right: { style: 'thin', color: { rgb: 'B9C4D0' } },
    },
  },
  valor: {
    font: { sz: 10, color: { rgb: '111827' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: {
      top: { style: 'thin', color: { rgb: 'B9C4D0' } },
      bottom: { style: 'thin', color: { rgb: 'B9C4D0' } },
      left: { style: 'thin', color: { rgb: 'B9C4D0' } },
      right: { style: 'thin', color: { rgb: 'B9C4D0' } },
    },
  },
  cabTabla: {
    font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '2E5A88' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: {
      top: { style: 'medium', color: { rgb: '1E3A5F' } },
      bottom: { style: 'medium', color: { rgb: '1E3A5F' } },
      left: { style: 'thin', color: { rgb: '8FA3B8' } },
      right: { style: 'thin', color: { rgb: '8FA3B8' } },
    },
  },
  celda: {
    font: { sz: 10, color: { rgb: '111827' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: {
      top: { style: 'hair', color: { rgb: 'C9D3DE' } },
      bottom: { style: 'hair', color: { rgb: 'C9D3DE' } },
      left: { style: 'thin', color: { rgb: 'B9C4D0' } },
      right: { style: 'thin', color: { rgb: 'B9C4D0' } },
    },
  },
  celdaCentro: {
    font: { sz: 10, color: { rgb: '111827' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: {
      top: { style: 'hair', color: { rgb: 'C9D3DE' } },
      bottom: { style: 'hair', color: { rgb: 'C9D3DE' } },
      left: { style: 'thin', color: { rgb: 'B9C4D0' } },
      right: { style: 'thin', color: { rgb: 'B9C4D0' } },
    },
  },
  total: {
    font: { bold: true, sz: 10, color: { rgb: '1E293B' } },
    fill: { fgColor: { rgb: 'E8EDF3' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: { top: { style: 'medium', color: { rgb: '1E3A5F' } } },
  },
} as const

type Celda = { v: string | number; t: string; s?: object }

/** Clon profundo de la plantilla de estilo: el writer de xlsx-js-style
 *  NORMALIZA los estilos mutándolos en sitio (rgb → "FF…", añade bgColor).
 *  Asignar la plantilla compartida contaminaría TODAS las celdas y los
 *  exportes siguientes de la sesión — cada celda recibe SU copia. */
const clonar = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T

/** Construye la HOJA "Guía" (PURO, exportado para tests): imprimible y
 *  con estilos. No escribe archivos — solo arma la WorkSheet. */
export function construirHojaGuia(g: GuiaParaExcel, XLSX: typeof import('xlsx')): import('xlsx').WorkSheet {
  const estado = g.estado || (g.filas.length > 0 ? g.filas[0].estado : '')
  const nCols = 11 // A..K: ancho de la tabla de ítems

  // — Encabezado del documento (Campo | Valor), el mismo orden del ejemplo
  const encabezado: [string, string | number][] = [
    ['Fecha', g.fecha],
    ['Tipo de documento', g.tipoDocumento],
    ['Nº de documento', g.numeroDocumento],
    ['Proveedor', g.proveedor],
    ['Placa', g.placa],
    ['Estado', estado || 'Mixto'],
    ['Turno', turnoDeFila(g.filas[0] ?? { createdAt: '' }) || '—'],
    ['Registró', [g.usuarioNombre, g.usuarioCorreo].filter(Boolean).join(' · ')],
    ['Exportado', new Date().toLocaleString('es-PE')],
  ]

  // — Tabla de ítems (columnas exactas del formato pedido, con TURNO)
  const tabla = filasGuiaATablaTurno(g.filas)

  // — AOA completa: título(2) + aire + encabezado + aire + tabla + aire + pie
  const aoa: (string | number | null)[][] = []
  aoa.push(['GUÍA DE RECEPCIÓN'])
  aoa.push(['RACKLY · Recepción de mercadería'])
  aoa.push([])
  for (const [campo, valor] of encabezado) aoa.push([campo, valor])
  aoa.push([])
  for (const fila of tabla) aoa.push(fila)
  aoa.push([])
  aoa.push(['Artículos (filas)', g.filas.length])
  aoa.push(['Cantidad total', cant3(g.cantidadTotal)])
  aoa.push(['Foto de la guía', g.fotoUrl || '—'])
  aoa.push(['Generado por', 'RACKLY · Recepción (rackly.pages.dev)'])

  const ws = XLSX.utils.aoa_to_sheet(aoa as unknown[][])

  // — Materializar celdas vacías de las filas de título: el borde/relleno
  //    de un rango FUSIONADO se pinta de cada celda del rango, no solo A1.
  for (let R = 0; R <= 1; R++) {
    for (let C = 0; C < nCols; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      if (!(addr in ws)) ws[addr] = { t: 's', v: '' } as Celda
    }
  }

  // — Estilos por zona
  const rTabla0 = 3 + encabezado.length + 1 // fila 0-based donde inicia la tabla
  const rTotal0 = rTabla0 + tabla.length + 1
  for (let R = 0; R < aoa.length; R++) {
    for (let C = 0; C < nCols; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C })
      if (!(addr in ws)) continue
      const cel = ws[addr] as Celda
      if (R === 0) { cel.s = clonar(EST.titulo); continue }
      if (R === 1) { cel.s = clonar(EST.subtitulo); continue }
      if (R >= 3 && R < 3 + encabezado.length) {
        cel.s = clonar(C === 0 ? EST.etiqueta : EST.valor)
        continue
      }
      if (R === rTabla0) { cel.s = clonar(EST.cabTabla); continue }
      if (R > rTabla0 && R < rTabla0 + tabla.length) {
        // Cantidad (col F=5) y Turno (col K=10) centrados; resto a la izquierda
        cel.s = clonar(C === 5 || C === 10 ? EST.celdaCentro : EST.celda)
        continue
      }
      if (R >= rTotal0 && R < rTotal0 + 4 && C <= 1) cel.s = clonar(EST.total)
    }
  }

  // — Fusiones: título/subtítulo a lo ancho de la tabla
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } },
  ]

  // — Alturas y anchos (caracteres) pensados para A4
  ws['!rows'] = [
    { hpt: 26 }, { hpt: 16 }, { hpt: 6 },
    ...encabezado.map(() => ({ hpt: 15 })),
    { hpt: 6 },
    ...tabla.map((_, i) => ({ hpt: i === 0 ? 24 : 15 })),
    { hpt: 6 },
    { hpt: 15 }, { hpt: 15 }, { hpt: 15 }, { hpt: 15 },
  ]
  ws['!cols'] = [
    { wch: 12 },  // A  Fecha
    { wch: 17 },  // B  Nº de documento
    { wch: 9 },   // C  Código
    { wch: 42 },  // D  Descripción
    { wch: 8 },   // E  Unidad
    { wch: 11 },  // F  Cantidad
    { wch: 12 },  // G  Lote
    { wch: 13 },  // H  F. producción
    { wch: 13 },  // I  F. vencimiento
    { wch: 24 },  // J  Registró
    { wch: 7 },   // K  Turno
  ]
  // Márgenes estrechos: más tabla por página al imprimir
  ws['!margins'] = {
    left: 0.3, right: 0.3, top: 0.4, bottom: 0.4,
    header: 0.2, footer: 0.2,
  }
  return ws
}

/**
 * Genera y DESCARGA el .xlsx de la guía. Devuelve el nombre del archivo
 * (para el toast). Dinámico: la libra entra en memoria solo al exportar.
 */
export async function exportarGuiaExcel(g: GuiaParaExcel): Promise<string> {
  // xlsx-js-style: API idéntica a SheetJS 0.18 pero ESCRIBE estilos de celda
  const XLSX = (await import('xlsx-js-style')) as unknown as typeof import('xlsx')
  const wb = XLSX.utils.book_new()

  // ── Hoja 1: Guía (imprimible: título + encabezado + ítems con Turno) ──
  XLSX.utils.book_append_sheet(wb, construirHojaGuia(g, XLSX), 'Guía')

  // ── Hoja 2: Artículos (TODOS los datos, 1 fila por fila registrada) ──
  const wsArt = XLSX.utils.json_to_sheet(filasGuiaAExcel(g.filas))
  // Cabecera con estilo (negrita + fondo + bordes) para lectura rápida
  const rango = XLSX.utils.decode_range(wsArt['!ref'] || 'A1')
  for (let C = rango.s.c; C <= rango.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: C })
    if (addr in wsArt) (wsArt[addr] as Celda).s = clonar(EST.cabTabla)
  }
  wsArt['!cols'] = [
    { wch: 5 },  // Nº
    { wch: 14 }, // Código
    { wch: 38 }, // Descripción
    { wch: 11 }, // Cantidad
    { wch: 8 },  // Unidad
    { wch: 14 }, // Lote
    { wch: 14 }, // F. producción
    { wch: 14 }, // F. vencimiento
    { wch: 11 }, // Paleta
    { wch: 11 }, // Estado
    { wch: 26 }, // Observaciones
    { wch: 18 }, // Registró
    { wch: 20 }, // Registrado (fecha/hora)
    { wch: 7 },  // Turno
  ]
  wsArt['!margins'] = {
    left: 0.3, right: 0.3, top: 0.4, bottom: 0.4,
    header: 0.2, footer: 0.2,
  }
  XLSX.utils.book_append_sheet(wb, wsArt, 'Artículos')

  const nombre = nombreArchivoGuia(g)
  XLSX.writeFile(wb, nombre)
  return nombre
}
