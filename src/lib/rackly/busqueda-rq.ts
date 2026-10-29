/**
 * RACKLY — Composición del filtro de búsqueda del listado de RQ (Atención).
 *
 * Por qué existe (bug 2026-10-29): el usuario buscaba por CÓDIGO DE MATERIAL
 * (p.ej. "118" = ÁCIDO CÍTRICO, que vive en rq_atencion_items) y el listado
 * solo buscaba en las 5 columnas del ENCABEZADO (numero_rq, orden_produccion,
 * producto_codigo, producto_descripcion, solicitante) → 0 resultados aunque
 * hubiera RQs que pidieran ese material.
 *
 * Por qué NO se filtra embebido (validado contra producción 2026-10-29,
 * scripts/test_rq_busqueda_embed.py):
 *   · or=(…,rq_atencion_items.codigo.ilike.*x*)  → PGRST100: el parser de
 *     PostgREST no admite referencias embebidas dentro de or().
 *   · rq_atencion_items.codigo=ilike.*x* sin embed en select → PGRST108.
 *   · .or(…, { referencedTable }) produce un AND entre parámetros, no el
 *     OR «encabezado O material» que se necesita.
 *
 * Camino elegido (validado HTTP 200 en producción,
 * scripts/test_rq_busqueda_planC.py): 2 pasos —
 *   1) leer los rq_id cuyo material coincide (capados),
 *   2) inyectarlos como `id.in.(…)` dentro del MISMO or() del encabezado:
 *      PostgREST los evalúa como un miembro más del OR y la paginación,
 *      el total y el orden del listado quedan intactos.
 * Lógica PURA (sin supabase) para poder testearla sin red.
 */

/** Tope de ids inyectables: 200 uuids × 37 chars ≈ 7.4 KB de URL, holgado
 *  bajo los límites de Cloudflare/PostgREST. Si hubiera más coincidencias
 *  de materiales, se capan (el listado sigue buscando también por
 *  encabezado, que es el caso dominante). */
export const MAX_IDS_MATERIALES = 200

const CAMPOS_ENCABEZADO_RQ = [
  'numero_rq',
  'orden_produccion',
  'producto_codigo',
  'producto_descripcion',
  'solicitante',
] as const

/**
 * Construye la expresión del filtro `.or(...)` de la búsqueda de RQ:
 *   · un miembro `campo.ilike.%término%` por cada campo del encabezado;
 *   · si hay ids de RQ con material coincidente, un miembro
 *     `id.in.(uuid1,uuid2,…)` (hasta MAX_IDS_MATERIALES).
 * Los ids se higienizan (solo hex+guiones) como defensa en profundidad:
 * el término ya sale de terminoBusquedaSeguro() y los ids vienen de la BD,
 * pero la expresión se arma por interpolación y se defiende sola.
 */
export function construirOrBusquedaRq(seguro: string, idsMateriales: string[]): string {
  const miembros = CAMPOS_ENCABEZADO_RQ.map((c) => `${c}.ilike.%${seguro}%`)
  const ids = idsMateriales
    .filter((id) => /^[0-9a-fA-F-]{1,64}$/.test(id))
    .slice(0, MAX_IDS_MATERIALES)
  if (ids.length > 0) miembros.push(`id.in.(${ids.join(',')})`)
  return miembros.join(',')
}
