/**
 * RACKLY — Devoluciones de línea · mapeo RQ → recepción (PURA, sin UI ni BD).
 *
 * La pestaña DEVOLUCIONES de Recepción registra el RQ de devolución como UNA
 * RECEPCIÓN (recepcion_registros, tipo_recepcion='devolucion') para que la
 * RPC transito_registrar_envio, el QR único por rótulo, las políticas RLS y
 * la idempotencia uuid_sync operen sin duplicar lógica — pero los DATOS se
 * extraen con el MISMO parser que Atención (rq-ocr.ts vía rq-ocr-runner.ts).
 *
 * Este módulo concentra el mapeo (pedido 2026-10-31: «que devolución sea
 * parecido a atención pero es recepción»):
 *
 *   · numeroDocumento ← Nº del RQ          («NUMERO REQUISICION 0000192967»)
 *   · empresaOrigen   ← Solicitante        (el origen de la devolución)
 *   · observaciones   ← OP · Línea · Producto (contexto del documento)
 *   · placa           ← SIEMPRE ''         (la requisición no trae vehículo)
 *   · filas           ← items del RQ (código/descripción/cantidad/unidad;
 *     el proveedor solo aplica a films — lámina/stretch — como en guías)
 *
 * Testeable con esbuild+node (suite test_recepcion_devoluciones).
 */

import { aNumero } from '@/lib/rackly/formato'
import type { DatosRq } from '@/lib/rackly/rq-ocr'
import type { ItemConPaletas } from '@/lib/rackly/recepcion-filas'

/** Documento por defecto de la pestaña devoluciones (RQ de devolución). */
export const TIPO_DOC_DEVOLUCION = 'Requisición de devolución'

/** Contexto de encabezado del RQ de devolución (editable en el formulario). */
export type ContextoRqDevolucion = {
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  linea: string
  solicitante: string
}

/**
 * Contexto del RQ como texto de observaciones: los datos de ENCABEZADO de la
 * requisición acompañan a CADA fila (nivel documento) — visible en el listado
 * expandido, el Excel y la ficha de tránsito. Vacío si no hay nada que decir.
 */
export function observacionesContextoRq(ctx: Partial<ContextoRqDevolucion>): string {
  return [
    ctx.ordenProduccion?.trim() ? `OP ${ctx.ordenProduccion.trim()}` : '',
    ctx.linea?.trim() ? `Línea ${ctx.linea.trim()}` : '',
    ctx.solicitante?.trim() ? `Solicita: ${ctx.solicitante.trim()}` : '',
    ctx.productoCodigo?.trim()
      ? `Producto: ${ctx.productoCodigo.trim()}${ctx.productoDescripcion?.trim() ? ` ${ctx.productoDescripcion.trim()}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Lee los datos del OCR (rq-ocr) como contexto editable: el formulario nace
 * con lo que la extracción leyó y el usuario confirma/corrige.
 */
export function contextoDesdeDatosRq(datos: DatosRq): ContextoRqDevolucion {
  return {
    numeroRq: datos.numeroRq ?? '',
    ordenProduccion: datos.ordenProduccion ?? '',
    productoCodigo: datos.productoCodigo ?? '',
    productoDescripcion: datos.productoDescripcion ?? '',
    linea: datos.linea ?? '',
    solicitante: datos.solicitante ?? '',
  }
}

/** Un material del RQ (leído por OCR o digitado) — cantidad texto o número
 *  (el OCR de rq-ocr entrega números; el formulario trabaja en texto). */
export type MaterialRq = {
  codigo: string
  descripcion: string
  cantidad: string | number
  unidad: string
  /** Solo films (lámina/stretch): la misma lista que Racks/Recepción. */
  proveedor?: string
}

/**
 * Materiales del RQ → filas de recepción (ItemConPaletas: sin dividir —
 * la requisición no trae paletas; 1 material = 1 fila = 1 rótulo con SU QR).
 */
export function materialesRqAFilas(items: MaterialRq[]): ItemConPaletas[] {
  return items
    .map((it) => ({
      codigo: it.codigo.trim(),
      descripcion: it.descripcion.trim(),
      cantidad: String(it.cantidad ?? '').trim(),
      unidad: it.unidad.trim().toUpperCase(),
      lote: '',
      fechaProduccion: '',
      fechaVencimiento: '',
      proveedor: (it.proveedor ?? '').trim(),
    }))
    .filter((f) => f.codigo && aNumero(f.cantidad) > 0)
}
