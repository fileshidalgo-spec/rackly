/**
 * RACKLY — Recepción · Geometría del marco de recorte (núcleo PURO, sin UI).
 *
 * Por qué se reemplazó react-easy-crop (2026-10): su modelo mueve la IMAGEN
 * bajo un marco fijo. Con una foto vertical 3:4 (celular en mano, típico al
 * fotografiar la guía) y el aspecto por defecto Vertical 3/4, a zoom 1 el
 * solape imagen/marco es total → arrastre con recorrido CERO: el usuario
 * veía "Recortar" pero la imagen no respondía ("no me deja recortar").
 *
 * Modelo nuevo (el que la gente conoce de WhatsApp/cámara): el marco se
 * MUEVE arrastrando y se REDIMENSIONA desde sus 4 esquinas. Siempre hay
 * interacción posible — el marco se mueve aunque la imagen encaje exacto.
 *
 * Todas las funciones son puras y trabajan en el espacio que les den
 * (display px o px naturales); el diálogo mapea display→natural con
 * rectANatural antes de recortar. Testeable con esbuild+node
 * (scripts/test_recorte_marco.js).
 */

export type Rect = { x: number; y: number; w: number; h: number }

export type Esquina = 'nw' | 'ne' | 'sw' | 'se'

/** Lado mínimo del marco en px de display (que se pueda agarrar con dedo). */
export const MIN_LADO_MARCO = 56

/** Área máxima del canvas intermedio (px²) — fotos de 48 MP reventaban el
 *  canvas en iOS (límite ~16.7 Mpx) y salía un recorte en blanco. */
export const MAX_AREA_CANVAS = 16_000_000

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/**
 * Marco inicial: el MAYOR rectángulo con `aspecto` (w/h) que cabe en la
 * imagen dejando un margen relativo alrededor (para que se vea que se puede
 * ajustar). aspecto 0 (libre) usa el aspect de la imagen.
 */
export function marcoInicial(imgW: number, imgH: number, aspecto: number, margen = 0.07): Rect {
  const a = aspecto > 0 ? aspecto : imgW / imgH
  const dispW = imgW * (1 - margen * 2)
  const dispH = imgH * (1 - margen * 2)
  let w = dispW
  let h = w / a
  if (h > dispH) {
    h = dispH
    w = h * a
  }
  return { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h }
}

/** Mueve el marco (dx, dy) sin salirse de la imagen. */
export function moverMarco(m: Rect, imgW: number, imgH: number, dx: number, dy: number): Rect {
  return {
    ...m,
    x: clamp(m.x + dx, 0, Math.max(0, imgW - m.w)),
    y: clamp(m.y + dy, 0, Math.max(0, imgH - m.h)),
  }
}

/**
 * Redimensiona el marco arrastrando una ESQUINA (la opuesta queda fija).
 * Con aspecto > 0 se conserva el aspecto (la diagonal de la esquina manda);
 * con aspecto 0 (libre) ancho y alto se ajustan por separado.
 * El resultado SIEMPRE queda dentro de la imagen y con lados ≥ minLado.
 */
export function redimensionarMarco(
  m: Rect,
  imgW: number,
  imgH: number,
  esquina: Esquina,
  dx: number,
  dy: number,
  aspecto: number,
  minLado = MIN_LADO_MARCO
): Rect {
  // Esquina OPUESTA fija (ancla) + dirección de crecimiento desde el ancla.
  const creceX = esquina === 'se' || esquina === 'ne' ? 1 : -1
  const creceY = esquina === 'se' || esquina === 'sw' ? 1 : -1
  const ax = creceX === 1 ? m.x : m.x + m.w
  const ay = creceY === 1 ? m.y : m.y + m.h
  // Espacio disponible desde el ancla hasta el borde de la imagen.
  const dispX = creceX === 1 ? imgW - ax : ax
  const dispY = creceY === 1 ? imgH - ay : ay

  // Tamaño pedido por el arrastre (en la dirección de la esquina).
  let w = m.w + creceX * dx
  let h = m.h + creceY * dy

  if (aspecto > 0) {
    // La diagonal manda: gana la dimensión que el usuario más estiró.
    w = Math.max(w, h * aspecto)
    h = w / aspecto
  }
  // Clamps: mínimo agarrable y máximo disponible (el marco no sale de la imagen).
  w = clamp(w, minLado, Math.max(minLado, dispX))
  h = clamp(h, minLado, Math.max(minLado, dispY))
  if (aspecto > 0) {
    // Tras clampar w pudo pasarse h (o viceversa): una pasada más lo cierra.
    if (h > dispY) {
      h = dispY
      w = clamp(h * aspecto, minLado, dispX)
      h = w / aspecto
    } else if (w > dispX) {
      w = dispX
      h = clamp(w / aspecto, minLado, dispY)
      w = h * aspecto
    }
  }

  return {
    x: creceX === 1 ? ax : ax - w,
    y: creceY === 1 ? ay : ay - h,
    w,
    h,
  }
}

/** Rect de display → px NATURALES de la imagen (el <img> va escalado). */
export function rectANatural(r: Rect, dispW: number, dispH: number, natW: number, natH: number): Rect {
  const sx = dispW > 0 ? natW / dispW : 1
  const sy = dispH > 0 ? natH / dispH : 1
  return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy }
}

/**
 * Al girar la imagen 90° horario el marco acompaña: el rect dado vive en el
 * espacio de la imagen SIN girar (W×H) y se devuelve en el espacio girado
 * (H×W). Píxel (x, y) → (H − y − h, x) con w↔h intercambiados.
 */
export function rotarRect90Horario(r: Rect, imgH: number): Rect {
  return { x: imgH - r.y - r.h, y: r.x, w: r.h, h: r.w }
}

/**
 * Escala que debe aplicarse a un canvas de `w×h` para no pasar de
 * MAX_AREA_CANVAS (1 = sin cambio). Fotos de 12-48 MP entran al límite.
 */
export function escalaPorArea(w: number, h: number, maxArea = MAX_AREA_CANVAS): number {
  const area = w * h
  if (area <= maxArea || area <= 0) return 1
  return Math.sqrt(maxArea / area)
}
