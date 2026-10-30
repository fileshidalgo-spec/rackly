/**
 * RACKLY — Escaneo de rótulo QR para INGRESOS desde Racks > Ocupaciones.
 *
 * NUEVA FUNCIÓN 2026-10-30 (pedido del usuario): «desde el módulo racks en
 * ocupaciones al querer realizar un ingreso en una posición se pueda hacer
 * mediante QR». El operario escanea el QR del rótulo impreso en Recepción y
 * el formulario de ingreso se llena solo (código, descripción, UN, cantidad
 * pendiente, lote, vencimiento).
 *
 * DISEÑO ANTÍGENO-DUPLICADO (lección del incidente 2026-10-29: un ingreso
 * manual en Racks dejó la fila de Tránsito sin marcar y el palet quedó
 * «pendiente» fantasma): si la fila escaneada tiene pendiente, el registro se
 * hace por la RPC atómica transito_registrar_envio — que en UNA transacción
 * crea el ingreso nativo en Racks Y marca el envío en recepcion_registros.
 * El semáforo de Tránsito queda coherente sin pasos extra.
 *
 * Este módulo es PURA (sin UI ni BD): transforma la fila de recepción
 * (ArticuloTransito) en el rotulo + prefill del formulario. El fetch y las
 * llamadas RPC viven en transito.ts / OcupacionTab.tsx. Testeable sin red.
 */

import type { ArticuloTransito } from './transito-core'

/** Datos del rótulo escaneado que la UI muestra y usa para registrar. */
export type RotuloIngreso = {
  /** uuid de la FILA en recepcion_registros (identidad 1:1 del QR nuevo). */
  recepcionId: string
  guiaId: string
  /** Nº de guía legible ('' si la guía no tiene número). */
  numeroDocumento: string
  codigo: string
  descripcion: string
  unidadMedida: string
  /** Cantidad registrada en la guía (total de la fila). */
  cantidadTotal: number
  /** Pendiente de transferir (cantidad - envíos de tránsito). */
  pendiente: number
  lote: string
  fechaVencimiento: string | null
  fechaProduccion: string
  proveedor: string
  nPaleta: number | null
  /** true = la fila ya está 100 % transferida (pendiente ≈ 0). El ingreso en
   *  Racks pasa entonces por la vía genérica (addMovimiento) con aviso. */
  yaTransferido: boolean
}

/** Prefill que recibe el formulario de ingreso de Ocupación. */
export type DatosPrefillIngreso = {
  codigo: string
  descripcion: string
  un: string
  /** Cantidad sugerida: el pendiente del rótulo ('0' si ya transferido). */
  cantidad: string
  lote: string
  fVenc: string
  sinFecha: boolean
  sinLote: boolean
}

const EPS = 0.0005

/** Convierte una fila de recepción en el rotulo del formulario. Nunca lanza. */
export function rotuloDesdeFila(fila: ArticuloTransito): RotuloIngreso {
  return {
    recepcionId: fila.id,
    guiaId: fila.guiaId,
    numeroDocumento: fila.numeroDocumento,
    codigo: fila.codigo,
    descripcion: fila.descripcion,
    unidadMedida: fila.unidadMedida,
    cantidadTotal: fila.cantidad,
    pendiente: fila.pendiente,
    lote: fila.lote,
    fechaVencimiento: fila.fechaVencimiento,
    fechaProduccion: fila.fechaProduccion,
    proveedor: fila.proveedor,
    nPaleta: fila.nPaleta,
    yaTransferido: fila.pendiente <= EPS,
  }
}

/** Prefill del formulario desde el rotulo. Nunca lanza. */
export function prefillDesdeRotulo(r: RotuloIngreso): DatosPrefillIngreso {
  // Redondeo a 3 decimales (precisión BD) para no pintar 80999.999999.
  const pend = Math.round(r.pendiente * 1000) / 1000
  return {
    codigo: r.codigo,
    descripcion: r.descripcion,
    un: r.unidadMedida,
    cantidad: String(pend > 0 ? pend : 0),
    lote: r.lote,
    fVenc: r.fechaVencimiento ?? '',
    // Los toggles del formulario siguen el dato del rótulo: si trae fecha no
    // se marca "Sin fecha"; si no trae lote se marca "Sin lote".
    sinFecha: !r.fechaVencimiento,
    sinLote: !r.lote,
  }
}

/**
 * Validación PREVIA en cliente del ingreso por rótulo (la RPC revalida todo):
 * la cantidad no puede exceder el pendiente del rótulo. Devuelve el mensaje
 * de error o null. El excedente casi siempre significa mercadería SIN guía —
 * el mensaje dirige a quitar el rótulo y usar el ingreso genérico.
 */
export function validarCantidadRotulo(cantidad: number, rotulo: RotuloIngreso): string | null {
  if (!(cantidad > 0)) return 'La cantidad debe ser mayor que cero'
  if (rotulo.yaTransferido) return null // la vía genérica lo decide (aviso ya mostrado)
  if (cantidad - rotulo.pendiente > EPS)
    return (
      `La cantidad excede el pendiente del rótulo (${rotulo.pendiente} ${rotulo.unidadMedida}). ` +
      'Si es mercadería nueva sin guía, quita el rótulo escaneado y registra un ingreso normal.'
    )
  return null
}

/** Etiqueta de ubicación legible para el historial de Tránsito. */
export function etiquetaPosicionRack(p: {
  bloque: string
  torre: string
  piso: string
  posicion: string
}): string {
  return `B${p.bloque}·T${p.torre}·P${p.piso}·Pos${p.posicion}`
}
