/**
 * RACKLY — Mapa INC compartido (Ocupación de racks + MapaRackSelector de Tránsito).
 *
 * Convenio (v3.3 / Task 5): una celda con INC activo (stock INC neto > 0) está
 * FÍSICAMENTE OCUPADA — nunca se pinta «Vacío/Libre» ni se sugiere como destino.
 *
 * FIX 2026-11-02 (trace 1a19c8089fb5fba5 — «inc les sale verde en vez de rosado»):
 * el mapa INC se consulta APARTE (fetchIncPorUbicacion) y se fusiona en el
 * cliente. Si esa consulta falla (red/BD intermitente), devuelve un mapa vacío
 * con `_error: true` — el merge no aportaba nada y las celdas solo-INC caían a
 * la rama «Vacío» (VERDE) hasta el siguiente ciclo del polling. Además, el
 * fallback RPC v1 de Ocupación pintaba SIN fusionar INC.
 *
 * Este módulo centraliza (a) la fusión INC sobre las celdas de ocupación —
 * única implementación para los dos mapas — y (b) la consulta INC con
 * reintento automático para absorber fallos transitorios sin mentirle al
 * usuario con celdas «Vacío» falsas.
 */

import { fetchIncPorUbicacion, type IncEnCelda, type OcupacionCelda } from '@/lib/rackly/kardex'

/** Mapa INC por ubicación, con banderas de estado de la consulta. */
export type IncPorUbicacionMap = Map<string, IncEnCelda[]> & {
  /** true: la consulta INC falló — el mapa puede estar SIN los INC reales. */
  _error?: boolean
  /** true: se alcanzó el tope de páginas — datos INC parciales. */
  _truncated?: boolean
}

/** Clave canónica de celda (idéntica a claveCeldaRack de transito-core). */
export function claveCelda(c: { bloque: string; torre: string; piso: string; posicion: string }): string {
  return `${c.bloque}-${c.torre}-${c.piso}-${c.posicion}`
}

/**
 * Fusiona el mapa INC (por ubicación) sobre las celdas de ocupación.
 * Mismo criterio que usaban OcupacionTab.buildCellMap y MapaRackSelector.fusionarInc:
 *  · La celda que ya existe (con stock) gana `tieneInc` + `incItems` (mixta).
 *  · La celda que SOLO existe en el mapa INC se añade con stock 0 y sus
 *    códigos INC — físicamente bloqueada, nunca «Vacío».
 * Nota: muta los objetos de celda que recibe (igual que las versiones previas).
 */
export function fusionarIncEnCeldas(
  celdas: OcupacionCelda[],
  incMap: Map<string, IncEnCelda[]>,
): OcupacionCelda[] {
  const map = new Map<string, OcupacionCelda>()
  for (const cell of celdas) map.set(claveCelda(cell), cell)
  for (const [key, incItems] of incMap) {
    const existing = map.get(key)
    if (existing) {
      existing.tieneInc = true
      existing.incItems = incItems
    } else {
      const [bloque, torre, piso, posicion] = key.split('-')
      map.set(key, { bloque, torre, piso, posicion, stock: 0, codigos: incItems.map(i => i.codigo), lotes: incItems.length, tieneInc: true, incItems })
    }
  }
  return Array.from(map.values())
}

/**
 * Consulta el mapa INC con REINTENTO automático ante fallo (`_error`).
 *
 * Los fallos de red/BD transitorios («tema de internet») duran menos de un
 * segundo; con un reintento a los ~800 ms la gran mayoría se absorbe en el
 * MISMO ciclo de refresco y el mapa nunca llega a pintarse sin INC.
 * `_truncated` NO se reintenta (datos parciales pero válidos).
 *
 * @param base    inyectable para tests (por defecto fetchIncPorUbicacion).
 * @param intentos intentos totales (2 = 1 consulta + 1 reintento).
 * @param pausaMs pausa base entre intentos (crece linealmente: pausaMs·i).
 */
export async function fetchIncPorUbicacionConReintento(
  base: () => Promise<IncPorUbicacionMap> = fetchIncPorUbicacion,
  { intentos = 2, pausaMs = 800 }: { intentos?: number; pausaMs?: number } = {},
): Promise<IncPorUbicacionMap> {
  let resultado = await base()
  for (let i = 1; i < intentos; i++) {
    if (!resultado._error) return resultado
    await new Promise(r => setTimeout(r, pausaMs * i))
    const reintento = await base()
    if (!reintento._error) return reintento
    resultado = reintento
  }
  return resultado
}
