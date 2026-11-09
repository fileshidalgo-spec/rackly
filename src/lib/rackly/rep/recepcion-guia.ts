/**
 * RACKLY · REPUESTOS — Recepción con DOCUMENTO de guía (lógica PURA, sin UI
 * ni BD). Fuente única de tipos, validación y mapeo a rótulos para el módulo
 * Recepción — separada del componente para que sea testeable con esbuild+node
 * (mismo patrón que recepcion-filas.ts en Insumos).
 *
 * MODELO (pedido del usuario, 2026-11-11):
 *   · Cabecera obligatoria de la guía: N° de Guía, N° de OC, N° de DAM y
 *     Proveedor. Si TODA la guía es de UN proveedor, ese proveedor se repite
 *     en cada artículo (modo «único»); si la guía trae VARIOS, cada artículo
 *     lleva el suyo (modo «múltiple»).
 *   · Cada artículo de la guía: código + descripción + UM (jalados del
 *     catálogo rep_articulos al digitar/escanear el código) + cantidad.
 *   · Al guardar: cada línea = 1 RPC rep_registrar_ingreso con el documento,
 *     y el lote de líneas guardadas abre la impresión de rótulos (archivo
 *     .zpl / Zebra), 1 rótulo por artículo.
 */

import type { DatosRotulo } from '@/lib/rackly/zebra'
import { aNumero } from '@/lib/rackly/formato'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

/** Datos de la guía que se está recepcionando (cabecera del documento). */
export type CabeceraRecepcionRep = {
  /** N° de Guía de remisión del proveedor (obligatorio). */
  guia: string
  /** N° de Orden de Compra (obligatorio). */
  oc: string
  /** N° de DAM — Declaración de Mercancías (obligatorio). */
  dam: string
  /** Modo de proveedor: false = UNO para toda la guía; true = por artículo. */
  multiProveedor: boolean
  /** Proveedor único (solo se usa si multiProveedor = false). */
  proveedorGeneral: string
}

/**
 * Una línea de la guía: un artículo con destino y cantidad ya validados.
 * `cantidad` llega ya parseada (aNumero) y > 0 — el builder no agrega
 * líneas inválidas, así el guardado solo trata con datos limpios.
 */
export type LineaRecepcionRep = {
  /** Identidad local de la línea (crypto.randomUUID) para el render y la
   *  eliminación; NO viaja a la BD. */
  key: string
  articuloId: string
  codigo: string
  descripcion: string
  und: string
  cantidad: number
  /** Proveedor de ESTA línea (vacío en modo proveedor único). */
  proveedor: string
  /** Lonchera destino (ubicación + lado resueltos). */
  loncheraId: string
  /** Rótulo de destino para la tabla, p. ej. «R-P1-N1-P01 · lado A». */
  destinoEtiqueta: string
}

/** Resultado de validar cabecera + líneas (mensajes listos para el usuario). */
export type ErroresRecepcionRep = {
  /** Errores de CABECERA (guía/OC/DAM/proveedor). */
  cabecera: string[]
  /** Errores por LÍNEA: key → mensaje. Solo entran las líneas inválidas. */
  lineas: Map<string, string>
}

// ═══════════════════════════════════════════════════════════════════
// VALIDACIÓN (pura)
// ═══════════════════════════════════════════════════════════════════

/**
 * Valida la recepción completa ANTES de tocar la BD:
 *   · cabecera: guía, OC, DAM y (en modo único) proveedor = obligatorios;
 *   · líneas: al menos una, con cantidad > 0, destino y — en modo múltiple —
 *     proveedor propio.
 * Devuelve TODOS los errores (no el primero): la UI los muestra de una vez.
 */
export function validarRecepcionRep(
  cab: CabeceraRecepcionRep,
  lineas: LineaRecepcionRep[]
): ErroresRecepcionRep {
  const res: ErroresRecepcionRep = { cabecera: [], lineas: new Map() }

  if (!cab.guia.trim()) res.cabecera.push('Ingresa el N° de Guía')
  if (!cab.oc.trim()) res.cabecera.push('Ingresa el N° de OC')
  if (!cab.dam.trim()) res.cabecera.push('Ingresa el N° de DAM')
  if (!cab.multiProveedor && !cab.proveedorGeneral.trim()) {
    res.cabecera.push('Ingresa el Proveedor de la guía')
  }
  if (lineas.length === 0) res.cabecera.push('Agrega al menos un artículo a la guía')

  for (const l of lineas) {
    if (!(l.cantidad > 0)) {
      res.lineas.set(l.key, `Cantidad inválida (${l.codigo || 'sin código'})`)
      continue
    }
    if (!l.loncheraId) {
      res.lineas.set(l.key, `Falta el destino (${l.codigo})`)
      continue
    }
    if (cab.multiProveedor && !l.proveedor.trim()) {
      res.lineas.set(l.key, `Falta el proveedor de ${l.codigo}`)
    }
  }
  return res
}

/**
 * Proveedor EFECTIVO de una línea: el propio en modo múltiple, el general en
 * modo único. Fuente única de la regla — la usa el guardado y la ficha.
 */
export function proveedorDeLinea(cab: CabeceraRecepcionRep, linea: LineaRecepcionRep): string {
  return (cab.multiProveedor ? linea.proveedor : cab.proveedorGeneral).trim()
}

/**
 * Parsea la cantidad digitada en el builder (aNumero: "1,500" → 1500,
 * "12,5" → 12.5). Devuelve null si no es mayor que cero — el builder NO
 * agrega la línea y muestra el error en el momento (feedback inmediato).
 */
export function parsearCantidadLinea(texto: string): number | null {
  const n = aNumero(texto)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ═══════════════════════════════════════════════════════════════════
// RÓTULOS (puro) — 1 rótulo por LÍNEA guardada
// ═══════════════════════════════════════════════════════════════════

/** Rótulo listo para el modal de impresión (mismo contrato que Insumos). */
export type RotuloAImprimirRep = DatosRotulo & { copias: number }

/**
 * Mapea las líneas YA GUARDADAS (con su uuid de rep_movimientos) a rótulos.
 *
 *   · recepcionId = uuid del MOVIMIENTO → QR ÚNICO POR RÓTULO (mismo espacio
 *     uuid4 que Insumos; el escaneo resuelve a ESA fila exacta).
 *   · Banda «LOTE» → «GUÍA: <número>»: en repuestos no hay lote; la traza
 *     física del rótulo es el documento que trajo la pieza.
 *   · F.P / F.V quedan vacías (no aplican a repuestos).
 *
 * `movimientoId` vacío (no debería pasar: la RPC siempre devuelve
 * movimiento_id) degrada a QR de guía — nunca un rótulo sin identidad.
 */
export function lineasARotulosRep(
  lineas: LineaRecepcionRep[],
  movimientoIds: string[],
  guia: string
): RotuloAImprimirRep[] {
  return lineas.map((l, i) => ({
    codigo: l.codigo,
    descripcion: l.descripcion,
    cantidad: String(l.cantidad),
    unidad: l.und,
    lote: guia.trim(),
    loteEtiqueta: 'GUÍA:',
    fechaProduccion: '',
    fechaVencimiento: '',
    recepcionId: movimientoIds[i] || undefined,
    copias: 1,
  }))
}

/**
 * Rótulos desde movimientos YA EN BD (reimpresión desde «Últimos ingresos»).
 * Solo filas tipo 'ingreso' con guía; cada rótulo porta SU uuid de fila.
 */
export function movimientosARotulosRep(
  filas: Array<{
    id: string
    codigo: string
    descripcion: string
    und: string
    cantidad: number
    guia: string
  }>
): RotuloAImprimirRep[] {
  return filas
    .filter((m) => m.codigo.trim())
    .map((m) => ({
      codigo: m.codigo.trim(),
      descripcion: m.descripcion.trim(),
      cantidad: String(Number(m.cantidad)),
      unidad: m.und.trim(),
      lote: m.guia.trim(),
      loteEtiqueta: 'GUÍA:',
      fechaProduccion: '',
      fechaVencimiento: '',
      recepcionId: m.id,
      copias: 1,
    }))
}
