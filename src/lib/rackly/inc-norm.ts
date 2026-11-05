/**
 * RACKLY — Normalización de códigos INC (auditoría exhaustiva 2026-11-05).
 *
 * Problema detectado en producción: el mismo INC físico quedaba registrado
 * bajo variantes de escritura («Inc26-577», «INC026-451») y el sistema, que
 * agrupa por la cadena EXACTA, lo mostraba como DOS INC distintos con stock
 * dividido (split-brain). Casos reales corregidos en BD: INC26-577/578
 * (mayúsculas) e INC026-110/429/451/501 (cero extra en el año).
 *
 * Reglas (mismo convenio que el UPPER(TRIM(codigo)) del stock normal):
 *   1. trim + mayúsculas → «Inc26-579» ≡ «INC26-579»
 *   2. cero extra del año → «INC026-451» ≡ «INC26-451»
 *   3. texto libre no estructurado («Elmer-01», «LIBERADO???», «Dañadas»)
 *      solo se recorta y pasa a mayúsculas — jamás se descarta ni se inventa.
 *
 * Aplicar en TODA escritura (insert/RPC) y en TODA agrupación por lectura,
 * para que un INC registrado bajo cualquier variante sea siempre el mismo.
 */
export function normalizarCodigoInc(valor: string | null | undefined): string | null {
  const limpio = (valor ?? '').trim()
  if (!limpio) return null
  const canon = limpio.toUpperCase()
  // INC026-429 (cero extra en el año) → INC26-429; INC12-34 queda intacto.
  const m = canon.match(/^INC0(\d{2})-(\d+)$/)
  return m ? `INC${m[1]}-${m[2]}` : canon
}
