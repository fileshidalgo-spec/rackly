/**
 * RACKLY · ALMACÉN REPUESTOS — Identidad de las 6 vistas del almacén.
 *
 * Archivo pequeño a propósito: lo importan tanto los componentes (home,
 * módulos) como el hub (page.tsx) y rep-navegacion, sin ciclos.
 */

export type RepVista =
  | 'catalogo'
  | 'ubicaciones'
  | 'recepcion'
  | 'atencion'
  | 'transito'
  | 'movimientos'

export const REP_LABEL_VISTA: Record<RepVista, string> = {
  catalogo: 'Catálogo',
  ubicaciones: 'Ubicaciones',
  recepcion: 'Recepción',
  atencion: 'Atención',
  transito: 'Tránsito',
  movimientos: 'Movimientos',
}

// ────────────────────────────────────────────────────────────────────
// VISTAS DEL HUB (page.tsx) — con prefijo «rep-» para no chocar con las
// vistas de Insumos: 'recepcion', 'atencion' y 'transito' existen en
// AMBOS almacenes; el prefijo las mantiene separadas en el estado `view`
// y en PERMISO_VER_MODULO (las 6 se gatean con 'repuestos.ver').
// ────────────────────────────────────────────────────────────────────

export type RepVistaHub = `rep-${RepVista}`

export const REP_VISTAS_HUB: RepVistaHub[] = [
  'rep-catalogo',
  'rep-ubicaciones',
  'rep-recepcion',
  'rep-atencion',
  'rep-transito',
  'rep-movimientos',
]

/** ¿Es una vista del almacén Repuestos? (guard del hub y de los fallbacks) */
export function esVistaRep(view: string): view is RepVistaHub {
  return (REP_VISTAS_HUB as string[]).includes(view)
}

/** 'rep-recepcion' → 'recepcion' (para reusar REP_LABEL_VISTA y el puente). */
export function repVistaDeHub(view: RepVistaHub): RepVista {
  return view.slice(4) as RepVista
}
