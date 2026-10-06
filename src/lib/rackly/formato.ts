/**
 * RACKLY — Utilidades de parseo numérico para cantidades escritas o
 * extraídas por OCR, donde el separador de miles/decimales varía:
 *
 *   "1,500.00" → 1500    (miles con coma, decimal con punto — guía US)
 *   "1.500,00" → 1500    (miles con punto, decimal con coma — guía EU)
 *   "250.50"   → 250.5   (decimal con punto — convención Perú)
 *   "2,884"    → 2884    (patrón claro de miles: grupos de 3 con coma)
 *   "1500"     → 1500
 *
 * Regla: cuando hay coma Y punto, el ÚLTIMO separador es el decimal.
 */
export function aNumero(valor: string): number {
  const s = (valor ?? '').trim().replace(/\s/g, '')
  if (!s) return NaN
  const tieneComa = s.includes(',')
  const tienePunto = s.includes('.')
  let normalizado = s
  if (tieneComa && tienePunto) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      normalizado = s.replace(/\./g, '').replace(',', '.')
    } else {
      normalizado = s.replace(/,/g, '')
    }
  } else if (tieneComa) {
    // Solo comas: miles si forman grupos de 3 ("2,884"), decimal si no ("12,5")
    normalizado = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  }
  return parseFloat(normalizado)
}
