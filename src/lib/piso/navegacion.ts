/**
 * Navegación Stock → Posición (módulo Piso).
 *
 * Une la búsqueda (Stock / FEFO / Stock INC) con la interfaz de movimientos
 * (Sectores): al tocar una ubicación en los resultados, el usuario aterriza en
 * la POSICIÓN concreta con su diálogo de detalle abierto, desde donde puede
 * registrar ingreso / salida / traslado / devolución / INC.
 *
 * Helpers PUROS (sin React) para que la resolución sea testeable.
 */

import type { PosicionConStock, StockPisoItem } from './api'

/**
 * Objetivo de navegación hacia una posición de Piso. Viaja desde las pestañas
 * de búsqueda hasta PisoSectoresTab vía page.tsx (deep-link de una sola vez).
 */
export type PisoTargetPosicion = {
  sector_id: string
  sector_nombre?: string
  posicion_id: string
  posicion_numero?: number
  columna_letra?: string
  subcolumna_codigo?: string
  /** String legible (p.ej. "A-A1-Pos 3") para mensajes/labels */
  ubicacion?: string
  /** Código del artículo buscado (contexto del banner de retorno) */
  bloque_codigo?: string
}

/**
 * Extrae el target de navegación de una fila de stock. Devuelve null si la fila
 * no tiene la ubicación resuelta (p.ej. estructura huérfana en BD) — en ese caso
 * la pestaña muestra la ubicación como texto plano, nunca un botón roto.
 */
export function targetDesdeStockItem(item: StockPisoItem): PisoTargetPosicion | null {
  if (!item.sector_id || !item.posicion_id) return null
  return {
    sector_id: item.sector_id,
    sector_nombre: item.sector_nombre || undefined,
    posicion_id: item.posicion_id,
    posicion_numero: item.posicion_numero,
    columna_letra: item.columna_letra,
    subcolumna_codigo: item.subcolumna_codigo,
    ubicacion: item.ubicacion || undefined,
    bloque_codigo: item.bloque_codigo || undefined,
  }
}

/**
 * Limpia el prefijo del código de subcolumna ('BA1' → 'A1' cuando la columna
 * es 'A'): las filas de stock traen el código CRUDO de piso_subcolumnas, pero
 * PosicionConStock.subcolumnaCodigo viene limpiado (cleanSubcolCode en api.ts).
 * Sin esto el fallback por coordenadas NUNCA matchea ('A1' === 'BA1' → falso).
 * Idempotente y tolerante: si no encuentra la letra, devuelve el código tal cual.
 */
function limpiarSubcol(codigo: string, columnaLetra: string): string {
  if (!codigo || !columnaLetra) return codigo
  const idx = codigo.indexOf(columnaLetra)
  return idx >= 0 ? codigo.substring(idx) : codigo
}

/**
 * Resuelve el target contra la lista de posiciones YA cargada del sector
 * destino. Primero por ID (canónico); si el ID ya no existe (datos migrados),
 * reintenta por coordenadas (columna + número + subcolumna — comparando el
 * código de subcolumna LIMPIO por ambos lados).
 */
export function resolverPosicionTarget(
  posiciones: PosicionConStock[],
  target: PisoTargetPosicion
): PosicionConStock | null {
  const porId = posiciones.find((p) => p.posicionId === target.posicion_id)
  if (porId) return porId
  if (target.columna_letra && target.posicion_numero != null) {
    const subTarget = target.subcolumna_codigo
      ? limpiarSubcol(target.subcolumna_codigo, target.columna_letra)
      : ''
    return (
      posiciones.find(
        (p) =>
          p.columnaLetra === target.columna_letra &&
          p.posicionNumero === target.posicion_numero &&
          (!subTarget || limpiarSubcol(p.subcolumnaCodigo, target.columna_letra) === subTarget)
      ) ?? null
    )
  }
  return null
}

/** Firma estable del target para aplicar el deep-link una sola vez por destino. */
export function firmaTarget(t: PisoTargetPosicion | null | undefined): string {
  if (!t?.sector_id || !t?.posicion_id) return ''
  return `${t.sector_id}|${t.posicion_id}`
}
