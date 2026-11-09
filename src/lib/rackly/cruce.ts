/**
 * cruce.ts — Capa de datos del PANEL CRUZADO entre módulos Racks ↔ Piso.
 *
 * Historia: la búsqueda cruzada antigua (eliminada en 442e7da) fallaba porque
 * 1) reconstruía el stock en el cliente replayando el historial completo,
 * 2) silenciaba los errores (catch → []),
 * 3) disparaba 1 consulta por código en cada tecleo.
 * Esta capa corrige las tres cosas: consultas server-side acotadas por código
 * EXACTO, errores que se PROPAGAN (los pinta el panel con botón Reintentar) y
 * cadencia controlada por el componente (1 consulta por código activo).
 *
 * Solo lectura: ninguna función modifica datos ni toca rutas de escritura.
 */

import { dataClient } from '@/lib/supabase/client'
import { stockPisoPorCodigos, type StockPisoItem } from '@/lib/piso/api'

/** Fila de stock de Racks (resultado de la RPC server-side). */
export type FilaStockRacks = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  descripcion: string | null
  un: string | null
  proveedor: string | null
  fVencimiento: string
}

/**
 * Stock de Racks para un código EXACTO vía RPC server-side
 * (stock_por_codigo_kardex: convención de signos única en servidor, dentro de
 * la BD). A diferencia de fetchStockPorCodigoRPC (que devuelve null en error
 * para degradar a la ruta client-side), aquí los errores SE PROPAGAN: el panel
 * cruzado debe distinguir "sin stock" (dato válido) de "falló la consulta".
 */
export async function stockRacksPorCodigo(codigo: string): Promise<FilaStockRacks[]> {
  const clean = codigo.trim().toUpperCase()
  if (!clean) return []
  const { data, error } = await dataClient.rpc('stock_por_codigo_kardex', {
    p_codigo: clean,
    p_solo_inc: false,
  })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    bloque: String(r.bloque ?? ''),
    torre: String(r.torre ?? ''),
    piso: String(r.piso ?? ''),
    posicion: String(r.posicion ?? ''),
    stock: Number(r.stock ?? 0),
    descripcion: (r.descripcion as string) ?? null,
    un: (r.un as string) ?? null,
    proveedor: (r.proveedor as string) ?? null,
    fVencimiento: (r.f_vencimiento as string) ?? '',
  }))
}

/**
 * Stock de Piso para un código EXACTO. Delega en el núcleo compartido de
 * derivación (stockPisoPorCodigos) — el mismo que usa la búsqueda del propio
 * módulo Piso, así ambas vistas muestran SIEMPRE lo mismo.
 */
export async function stockPisoPorCodigo(codigo: string): Promise<StockPisoItem[]> {
  return stockPisoPorCodigos([codigo])
}
