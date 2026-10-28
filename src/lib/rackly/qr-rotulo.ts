/**
 * RACKLY — Formato del CÓDIGO QR del rótulo de Recepción (contrato compartido).
 *
 * Cada rótulo impreso en Recepción lleva UN QR (ZPL nativo ^BQ, esquina
 * DERECHA de la banda del código — según la foto anotada por el usuario:
 * "AQUÍ VA QR" a la derecha del límite) que identifica de forma ÚNICA al
 * rótulo mismo. El módulo TRÁNSITO escanea ese QR y abre la transferencia
 * de ese artículo a la posición elegida (Rack o Piso); Atención lo usa para
 * agregar la toma EXACTA de esa paleta al carrito.
 *
 * PAYLOAD (texto plano, tolerante a pistolas USB y cámaras):
 *
 *   RKLY|<identidad>|<numeroDocumento>|<codigo>[|P<paleta>]
 *
 *   · RKLY             prefijo fijo — descarta QRs ajenos en 1 comparación.
 *   · identidad        UUID del rótulo. Dos generaciones conviven:
 *                        — NUEVO (2026-10, "QR único por rótulo"): uuid de la
 *                          FILA del palet en recepcion_registros → el escaneo
 *                          resuelve a ESA fila exacta (lote/cantidad correctos
 *                          aunque la guía tenga muchas filas del mismo código,
 *                          con o sin nº de paleta, o esté registrada 2 veces).
 *                        — LEGADO (rótulos ya impresos): uuid de la GUÍA
 *                          (recepcion_registros.guia_id) → la resolución cae
 *                          al listado de la guía y elige fila por FEFO.
 *                      Los lectores prueban PRIMERO fila-por-id; si no existe,
 *                      tratan el uuid como guía (compatibilidad total).
 *                      Puede venir VACÍO en rótulos residuales sin identidad →
 *                      la resolución cae al numeroDocumento.
 *   · numeroDocumento  Nº de guía legible (fallback + mensaje al operario).
 *   · codigo           código del artículo del rótulo.
 *   · P<paleta>        SOLO si el artículo está dividido: nº de paleta
 *                      (1..N) — informativo/preselección; con identidad de
 *                      fila la paleta exacta ya viene en la fila.
 *
 * El uuid de fila y el de guía viven en el MISMO espacio (uuid4): jamás
 * colisionan, por eso un solo campo basta y el mismo largo (36) mantiene
 * las magnificaciones del QR calculadas en zebra.ts.
 *
 * Este módulo es PURA (sin UI ni BD): lo importan la impresión (zebra.ts,
 * construye) y Tránsito/Atención (parsean), y es testeable con esbuild+node.
 */

/** Prefijo del payload; también sirve de "marca" al inicio del escaneo. */
export const PREFIJO_QR = 'RKLY'

/** Payload decodificado de un QR de rótulo. */
export type PayloadQRRotulo = {
  /** UUID del rótulo: fila de recepcion_registros (nuevo) o guía (legado);
   *  '' si el rótulo es residual sin identidad. */
  identidad: string
  /** Nº de documento de la guía ('' si la guía no tiene número). */
  numeroDocumento: string
  /** Código del artículo impreso en el rótulo. */
  codigo: string
  /** Nº de paleta si el artículo está dividido; null si no. */
  paleta: number | null
}

/**
 * Construye el texto que va codificado en el QR del rótulo.
 * Los segmentos se limpian de '|' (el separador) para que un dato con ese
 * carácter no rompa el formato; trims defensivos en cada campo.
 */
export function construirPayloadQR(p: {
  identidad: string
  numeroDocumento: string
  codigo: string
  paleta?: number | null
}): string {
  const limpiar = (s: string) => (s ?? '').trim().replace(/\|/g, ' ')
  const partes = [
    PREFIJO_QR,
    limpiar(p.identidad),
    limpiar(p.numeroDocumento),
    limpiar(p.codigo),
  ]
  const paleta = p.paleta
  if (typeof paleta === 'number' && Number.isFinite(paleta) && paleta > 0) {
    partes.push(`P${Math.round(paleta)}`)
  }
  return partes.join('|')
}

/**
 * Parsea el texto crudo leído por cámara o pistola USB. Devuelve null si el
 * texto no es un QR de rótulo Rackly (tolerante a espacios/saltos de línea
 * que añaden los lectores al final). NUNCA lanza.
 */
export function parsearPayloadQR(texto: string): PayloadQRRotulo | null {
  const limpio = (texto ?? '').trim()
  // Prefijo insensible a mayúsculas; el RESTO conserva su caso original
  // (la identidad es un uuid en minúsculas y el código del catálogo es
  // case-sensitive en la comparación exacta del lado de Tránsito).
  if (!/^rkly\|/i.test(limpio)) return null
  const partes = limpio.split('|')
  // RKLY | identidad | numeroDocumento | codigo | Pn?
  if (partes.length < 4) return null
  const identidad = (partes[1] ?? '').trim()
  const numeroDocumento = (partes[2] ?? '').trim()
  const codigo = (partes[3] ?? '').trim()
  const mPaleta = /^P(\d+)$/i.exec((partes[4] ?? '').trim())
  // Sin NINGUNA identidad el escaneo no resuelve a nada útil.
  if (!identidad && !numeroDocumento) return null
  return {
    identidad,
    numeroDocumento,
    codigo,
    paleta: mPaleta ? Number(mPaleta[1]) : null,
  }
}
