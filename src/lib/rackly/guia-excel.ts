'use client'

/**
 * RACKLY — Recepción · Exportación a EXCEL de UNA guía registrada.
 *
 * Pedido del usuario: "que en la guía registrada genere un archivo en excel
 * que se pueda descargar, con toda la información registrada".
 *
 * Libro que genera (mismo patrón que DescargaTab/FefoTab/OcupacionTab…:
 * `await import('xlsx')` — la libra solo se descarga cuando el usuario
 * realmente exporta; no engorda el bundle de Recepción):
 *
 *   · Hoja "Guía"      → encabezado del documento: fecha, tipo/nº de
 *                        documento, proveedor, placa, estado, quién registró,
 *                        foto de la guía, nº de artículos, cantidad total y
 *                        sello de cuándo se exportó.
 *   · Hoja "Artículos" → 1 fila por CADA fila registrada (las paletas
 *                        incluidas: cada paleta es su propia fila con SU
 *                        lote/fechas propios y su marca "Paleta i/N").
 *
 * El armado de datos es PURO (testeable con esbuild+node); solo el
 * writeFile toca el navegador (descarga directa, sin servidor).
 */

import type { FilaRegistrada, GuiaAgrupada } from '@/lib/rackly/recepcion-filas'
import { marcaPaletaDe, obsSinMarcaPaleta } from '@/lib/rackly/recepcion-filas'

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

/**
 * Filas YA registradas → objeto plano para la hoja "Artículos" (PURO).
 * La marca "Paleta i/N" sale a SU columna y las observaciones quedan limpias
 * (solo el texto que el usuario digitó). Cantidad redondeada a 3 decimales
 * (mismo criterio que la UI).
 */
export function filasGuiaAExcel(filas: FilaRegistrada[]): Record<string, string | number>[] {
  return filas.map((f, i) => {
    const marca = marcaPaletaDe(f.observaciones)
    return {
      'Nº': i + 1,
      'Código': f.codigo,
      'Descripción': f.descripcion,
      'Cantidad': Math.round(f.cantidad * 1000) / 1000,
      'Unidad': f.unidadMedida,
      'Lote': f.lote,
      'F. producción': f.fechaProduccion,
      'F. vencimiento': f.fechaVencimiento,
      'Paleta': marca ? `Paleta ${marca.i}/${marca.n}` : '',
      'Estado': f.estado,
      'Observaciones': obsSinMarcaPaleta(f.observaciones),
      'Registró': f.usuarioNombre,
      'Registrado (fecha/hora)': f.createdAt ? new Date(f.createdAt).toLocaleString('es-PE') : '',
    }
  })
}

/**
 * Genera y DESCARGA el .xlsx de la guía. Devuelve el nombre del archivo
 * (para el toast). Dinámico: `xlsx` entra en memoria solo al exportar.
 */
export async function exportarGuiaExcel(g: GuiaParaExcel): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  // ── Hoja 1: Guía (encabezado del documento) ──
  const estado = g.estado || (g.filas.length > 0 ? g.filas[0].estado : '')
  const guiaAoa: (string | number)[][] = [
    ['Campo', 'Valor'],
    ['Fecha', g.fecha],
    ['Tipo de documento', g.tipoDocumento],
    ['Nº de documento', g.numeroDocumento],
    ['Proveedor', g.proveedor],
    ['Placa', g.placa],
    ['Estado', estado || 'Mixto'],
    ['Registró', [g.usuarioNombre, g.usuarioCorreo].filter(Boolean).join(' · ')],
    ['Foto de la guía', g.fotoUrl],
    ['Artículos (filas)', g.filas.length],
    ['Cantidad total', Math.round(g.cantidadTotal * 1000) / 1000],
    ['Exportado', new Date().toLocaleString('es-PE')],
    ['Generado por', 'RACKLY · Recepción (rackly.pages.dev)'],
  ]
  const wsGuia = XLSX.utils.aoa_to_sheet(guiaAoa)
  wsGuia['!cols'] = [{ wch: 20 }, { wch: 46 }]
  XLSX.utils.book_append_sheet(wb, wsGuia, 'Guía')

  // ── Hoja 2: Artículos (1 fila por fila registrada, paletas incluidas) ──
  const wsArt = XLSX.utils.json_to_sheet(filasGuiaAExcel(g.filas))
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
  ]
  XLSX.utils.book_append_sheet(wb, wsArt, 'Artículos')

  const nombre = nombreArchivoGuia(g)
  XLSX.writeFile(wb, nombre)
  return nombre
}
