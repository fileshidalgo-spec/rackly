'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Capa de datos (única puerta a las tablas rep_*).
 *
 * Principios (idénticos a los de modulos.ts de Insumos):
 *   · Solo consulta/escribe SUS tablas (rep_*) — jamás toca Insumos.
 *   · Toda escritura viaja por dataClient (anon key + JWT del usuario) y
 *     queda cubierta por las políticas RLS de cada tabla rep_*.
 *   · Las escrituras operativas críticas van por RPC SECURITY DEFINER
 *     (rep_registrar_ingreso): atómicas y con guard de permiso en BD.
 *   · Listados de catálogo SIEMPRE paginados en servidor (25 000 filas).
 */

import { dataClient } from '@/lib/supabase/client'
import { mensajeError, errorControlado, ERR_ACTUALIZAR_BLOQUEADO, ERR_ELIMINAR_BLOQUEADO } from '@/lib/rackly/errores'
import { terminoBusquedaSeguro } from '@/lib/rackly/formato'
import {
  type RepArticulo,
  type RepUbicacion,
  type RepLonchera,
  type RepTipoUbicacion,
  type RepSector,
  type RepMovimiento,
  type RepTipoMovimiento,
  type RepRal,
  type RepEstadoRal,
} from './rep-tipos'

// Puerta única de tipos para los módulos UI: importan TODO (funciones +
// tipos) desde rep-client; rep-tipos queda como fuente de verdad interna.
export type {
  RepArticulo,
  RepUbicacion,
  RepLonchera,
  RepStockRow,
  RepRal,
  RepRalDetalle,
  RepEstadoRal,
  RepMovimiento,
  RepTipoMovimiento,
  RepTipoUbicacion,
  RepSector,
  RepEstadoLinea,
} from './rep-tipos'

// ═══════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════════

/** Normaliza un código de artículo: mayúsculas, sin espacios de más. */
export function repNormalizarCodigo(codigo: string): string {
  return codigo.trim().toUpperCase().replace(/\s+/g, ' ')
}

function lanzar(error: { message: string } | null): void {
  if (error) throw new Error(mensajeError(error))
}

/** Guard de UPDATE honesto: la RLS puede filtrar en silencio (HTTP 200, 0 filas). */
async function exigirActualizadas(res: { count: number | null; error: { message: string } | null }, que: string) {
  lanzar(res.error)
  if (!res.count) {
    throw errorControlado(ERR_ACTUALIZAR_BLOQUEADO, `No se pudo actualizar ${que} (permiso o registro ya no existe).`)
  }
}

/** Guard de DELETE honesto (clase espejo del anterior). */
async function exigirEliminadas(res: { count: number | null; error: { message: string } | null }, que: string) {
  lanzar(res.error)
  if (!res.count) {
    throw errorControlado(ERR_ELIMINAR_BLOQUEADO, `No se pudo eliminar ${que} (permiso o registro ya no existe).`)
  }
}

// ── PAGINACIÓN DE LISTADOS GRANDES ──
// Supabase (PostgREST) trunca cada request a max_rows=1000. Con el layout
// canónico 2026-11 (1 869 ubicaciones · 3 642 loncheras · su ocupación),
// bajarlas en UNA ronda perdería filas EN SILENCIO. Este helper pagina en
// servidor con .range() hasta una página corta (patrón PAGE_SIZE de Insumos).
const REP_TODAS_PAGE = 1000

type ResPagina<T> = { data: T[] | null; error: { message: string } | null }

async function repTodas<T>(
  pagina: (from: number, to: number) => PromiseLike<ResPagina<T>>
): Promise<T[]> {
  const filas: T[] = []
  for (let from = 0; ; from += REP_TODAS_PAGE) {
    const res = await pagina(from, from + REP_TODAS_PAGE - 1)
    lanzar(res.error)
    const lote = (res.data ?? []) as T[]
    filas.push(...lote)
    if (lote.length < REP_TODAS_PAGE) return filas
  }
}

// ═══════════════════════════════════════════════════════════════════
// CATÁLOGO — rep_articulos
// ═══════════════════════════════════════════════════════════════════

export type RepPagina<T> = { filas: T[]; total: number }

export type RepFiltroArticulos = {
  busqueda?: string
  soloActivos?: boolean
  page?: number
  pageSize?: number
}

/** Búsqueda paginada en servidor (25 000 filas: jamás se bajan todas). */
export async function repBuscarArticulos(f: RepFiltroArticulos = {}): Promise<RepPagina<RepArticulo>> {
  const page = Math.max(1, f.page ?? 1)
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 50))
  const desde = (page - 1) * pageSize
  const hasta = desde + pageSize - 1

  let q = dataClient
    .from('rep_articulos')
    .select('*', { count: 'exact' })
    .order('codigo', { ascending: true })
    .range(desde, hasta)

  const busqueda = terminoBusquedaSeguro(f.busqueda ?? '')
  if (busqueda) {
    // Código por prefijo exacto o descripción por substring (índice trgm).
    // terminoBusquedaSeguro (mismo guard que Recepción/Atención de Insumos)
    // neutraliza comas/paréntesis/comodines: sin él, "tornillo, 5cm" rompía
    // la sintaxis de or() en PostgREST (HTTP 400).
    const like = `%${busqueda}%`
    q = q.or(`codigo.ilike.${like},descripcion.ilike.${like}`)
  }
  if (f.soloActivos) q = q.eq('activo', true)

  const { data, error, count } = await q
  lanzar(error)
  return { filas: (data ?? []) as RepArticulo[], total: count ?? data?.length ?? 0 }
}

/** Lookup exacto por código (normalizado) — lo usan Recepción y Atención. */
export async function repArticuloPorCodigo(codigo: string): Promise<RepArticulo | null> {
  const { data, error } = await dataClient
    .from('rep_articulos')
    .select('*')
    .eq('codigo', repNormalizarCodigo(codigo))
    .maybeSingle()
  lanzar(error)
  return (data as RepArticulo | null) ?? null
}

export type RepNuevoArticulo = {
  codigo: string
  descripcion: string
  und: string
  cantidad_ref?: number
  marca?: string
  modelo?: string
  aplicacion?: string
}

/** Alta manual (puente Recepción → Catálogo "alta rápida"). */
export async function repCrearArticulo(input: RepNuevoArticulo): Promise<RepArticulo> {
  const fila = {
    codigo: repNormalizarCodigo(input.codigo),
    descripcion: input.descripcion.trim(),
    und: input.und.trim(),
    cantidad_ref: input.cantidad_ref ?? 0,
    marca: input.marca?.trim() ?? '',
    modelo: input.modelo?.trim() ?? '',
    aplicacion: input.aplicacion?.trim() ?? '',
    activo: true,
  }
  if (!fila.codigo) throw new Error('El código es obligatorio')
  if (!fila.descripcion) throw new Error('La descripción es obligatoria')

  const { data, error } = await dataClient.from('rep_articulos').insert(fila).select('*').single()
  lanzar(error)
  return data as RepArticulo
}

export type RepPatchArticulo = Partial<
  Pick<RepArticulo, 'descripcion' | 'und' | 'cantidad_ref' | 'marca' | 'modelo' | 'aplicacion' | 'activo'>
>

export async function repActualizarArticulo(id: string, patch: RepPatchArticulo): Promise<void> {
  // FIX: { count: 'exact' } es OBLIGATORIO — sin él supabase-js devuelve
  // count=null y el guard honesto (exigirActualizadas) era un no-op: la RLS
  // podía filtrar el UPDATE en silencio y la app celebraba un éxito falso.
  const res = await dataClient
    .from('rep_articulos')
    .update(patch, { count: 'exact' })
    .eq('id', id)
  await exigirActualizadas(res, 'el artículo')
}

export async function repEliminarArticulo(id: string): Promise<void> {
  // FIX espejo del UPDATE: count exacto para que exigirEliminadas sea real.
  const res = await dataClient
    .from('rep_articulos')
    .delete({ count: 'exact' })
    .eq('id', id)
  await exigirEliminadas(res, 'el artículo')
}

// ── Carga masiva Excel (patrón DescargaTab: lotes + errores por fila) ──

export type RepFilaExcel = {
  fila: number
  codigo: string
  descripcion: string
  und: string
  cantidad_ref: number
}

export type RepResultadoCarga = {
  ok: number
  errores: string[]
}

const REP_LOTE = 500 // filas por upsert (PostgREST tolera bien este tamaño)

/**
 * UPSERT por código: re-subir un Excel NO duplica — actualiza descripción,
 * und y cantidad_ref de lo existente y crea lo nuevo (acordado con el usuario).
 * `repuestos.gestionar` gatea INSERT/UPDATE en RLS.
 */
export async function repUpsertArticulosLote(
  filas: RepFilaExcel[],
  onProgreso?: (hechas: number, total: number) => void
): Promise<RepResultadoCarga> {
  const errores: string[] = []
  let ok = 0
  const total = filas.length

  for (let i = 0; i < total; i += REP_LOTE) {
    const lote = filas.slice(i, i + REP_LOTE).map((r) => ({
      codigo: repNormalizarCodigo(r.codigo),
      descripcion: r.descripcion.trim(),
      und: r.und.trim(),
      cantidad_ref: r.cantidad_ref,
      activo: true,
    }))
    const { error } = await dataClient
      .from('rep_articulos')
      .upsert(lote, { onConflict: 'codigo', ignoreDuplicates: false })
    if (error) {
      errores.push(`Filas ${i + 1}–${Math.min(i + REP_LOTE, total)}: ${mensajeError(error)}`)
    } else {
      ok += lote.length
    }
    onProgreso?.(Math.min(i + REP_LOTE, total), total)
  }
  return { ok, errores }
}

// ═══════════════════════════════════════════════════════════════════
// UBICACIONES + LONCHERAS — rep_ubicaciones / rep_loncheras
// ═══════════════════════════════════════════════════════════════════

/**
 * Todas las ubicaciones (paginado en servidor — 1 869 filas). Orden:
 * sector → rack → zona → nivel → secuencia (el mapa agrupa por sector).
 */
export async function repListarUbicaciones(): Promise<RepUbicacion[]> {
  return repTodas<RepUbicacion>((from, to) =>
    dataClient
      .from('rep_ubicaciones')
      .select('*')
      .order('sector')
      .order('rack', { nullsFirst: false })
      .order('zona')
      .order('nivel')
      .order('secuencia')
      .range(from, to)
  )
}

/** Todas las loncheras (paginado en servidor — 3 642 filas). */
export async function repListarLoncheras(): Promise<RepLonchera[]> {
  return repTodas<RepLonchera>((from, to) =>
    dataClient.from('rep_loncheras').select('*').range(from, to)
  )
}

// ── MAPA DEL ALMACÉN: ubicaciones + loncheras + ocupación por lonchera ──

export type RepOcupacionLonchera = { articulos: number; cantidad: number; enTransito: number }

export type RepMapaAlmacen = {
  ubicaciones: RepUbicacion[]
  /** loncheraId → lonchera (lookup rápido) */
  loncheras: Map<string, RepLonchera>
  /** loncheraId → ocupación (nº artículos distintos, cantidad total, en tránsito) */
  ocupacion: Map<string, RepOcupacionLonchera>
}

/**
 * Una sola ronda (3 lecturas paralelas, cada una paginada en servidor)
 * para pintar el mapa completo. La ocupación se AGREGA EN BD (RPC
 * rep_ocupacion_loncheras, GROUP BY): el navegador jamás descarga las
 * filas de stock (crecen con la operación diaria).
 */
export async function repMapaAlmacen(): Promise<RepMapaAlmacen> {
  const [ubicaciones, loncherasArr, ocupacionArr] = await Promise.all([
    repListarUbicaciones(),
    repListarLoncheras(),
    repTodas<{
      lonchera_id: string
      articulos: number | string
      cantidad: number | string
      en_transito: number | string
    }>((from, to) => dataClient.rpc('rep_ocupacion_loncheras').range(from, to)),
  ])

  const loncheras = new Map<string, RepLonchera>()
  for (const l of loncherasArr) loncheras.set(l.id, l)

  const ocupacion = new Map<string, RepOcupacionLonchera>()
  for (const o of ocupacionArr) {
    ocupacion.set(o.lonchera_id, {
      articulos: Number(o.articulos) || 0,
      cantidad: Number(o.cantidad) || 0,
      enTransito: Number(o.en_transito) || 0,
    })
  }

  return { ubicaciones, loncheras, ocupacion }
}

// ═══════════════════════════════════════════════════════════════════
// STOCK — rep_stock (lecturas con joins)
// ═══════════════════════════════════════════════════════════════════

export type RepStockDeArticulo = {
  loncheraId: string
  lado: 'A' | 'B'
  ubicacionId: string
  ubicacionCodigo: string
  ubicacionTipo: RepTipoUbicacion
  cantidad: number
  enTransito: boolean
}

/** ¿Dónde vive un artículo? (regla: una lonchera; la excepción controlada crea filas extra) */
export async function repStockDeArticulo(articuloId: string): Promise<RepStockDeArticulo[]> {
  const { data, error } = await dataClient
    .from('rep_stock')
    .select('cantidad, ral_id, lonchera:rep_loncheras!inner(id, lado, ubicacion:rep_ubicaciones!inner(id, codigo, tipo))')
    .eq('articulo_id', articuloId)
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    cantidad: number
    ral_id: string | null
    lonchera: { id: string; lado: 'A' | 'B'; ubicacion: { id: string; codigo: string; tipo: RepTipoUbicacion } }
  }>).map((r) => ({
    loncheraId: r.lonchera.id,
    lado: r.lonchera.lado,
    ubicacionId: r.lonchera.ubicacion.id,
    ubicacionCodigo: r.lonchera.ubicacion.codigo,
    ubicacionTipo: r.lonchera.ubicacion.tipo,
    cantidad: Number(r.cantidad) || 0,
    enTransito: Boolean(r.ral_id),
  }))
}

export type RepStockDeLonchera = {
  stockId: string
  articuloId: string
  codigo: string
  descripcion: string
  und: string
  cantidad: number
  enTransito: boolean
}

/** Contenido de una lonchera (el QR de la posición mostrará esto para A y B). */
export async function repStockDeLonchera(loncheraId: string): Promise<RepStockDeLonchera[]> {
  const { data, error } = await dataClient
    .from('rep_stock')
    .select('id, cantidad, ral_id, articulo:rep_articulos(id, codigo, descripcion, und)')
    .eq('lonchera_id', loncheraId)
    .order('updated_at', { ascending: false })
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    cantidad: number
    ral_id: string | null
    articulo: { id: string; codigo: string; descripcion: string; und: string }
  }>).map((r) => ({
    stockId: r.id,
    articuloId: r.articulo.id,
    codigo: r.articulo.codigo,
    descripcion: r.articulo.descripcion,
    und: r.articulo.und,
    cantidad: Number(r.cantidad) || 0,
    enTransito: Boolean(r.ral_id),
  }))
}

/** ¿Cuántos artículos distintos tiene la lonchera? (pre-chequeo de capacidad 15) */
export async function repContarArticulosLonchera(loncheraId: string): Promise<number> {
  const { count, error } = await dataClient
    .from('rep_stock')
    .select('id', { count: 'exact', head: true })
    .eq('lonchera_id', loncheraId)
  lanzar(error)
  return count ?? 0
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN — RPC atómica rep_registrar_ingreso
// ═══════════════════════════════════════════════════════════════════

export type RepResultadoIngreso = {
  movimientoId: string
  ubicacion: string
  lado: 'A' | 'B'
  /** Aviso (no bloquea): el artículo ya vivía en otra lonchera */
  enOtraLonchera: { lado: string; ubicacion: string } | null
}

/**
 * Ingreso a lonchera con TODAS las validaciones en BD (atómico):
 * capacidad 15 · artículo activo · upsert de cantidad · kardex.
 * Errores controlados: LONCHERA_LLENA, ARTICULO_INACTIVO, NO_AUTORIZADO…
 *
 * Documento de guía (2026-11-11): guía/OC/DAM/proveedor viajan al kardex
 * (rep_movimientos) para la reimpresión de rótulos por documento. Son
 * OPCIONALES — sin ellos la RPC es exactamente la de siempre.
 */
export async function repRegistrarIngreso(params: {
  articuloId: string
  loncheraId: string
  cantidad: number
  referencia?: string
  guia?: string
  oc?: string
  dam?: string
  proveedor?: string
}): Promise<RepResultadoIngreso> {
  const { data, error } = await dataClient.rpc('rep_registrar_ingreso', {
    p_articulo_id: params.articuloId,
    p_lonchera_id: params.loncheraId,
    p_cantidad: params.cantidad,
    p_referencia: params.referencia ?? '',
    p_guia: params.guia ?? '',
    p_oc: params.oc ?? '',
    p_dam: params.dam ?? '',
    p_proveedor: params.proveedor ?? '',
  })
  lanzar(error)
  const d = (data ?? {}) as {
    ok?: boolean
    movimiento_id?: string
    ubicacion?: string
    lado?: 'A' | 'B'
    en_otra_lonchera?: { lado: string; ubicacion: string } | null
  }
  return {
    movimientoId: d.movimiento_id ?? '',
    ubicacion: d.ubicacion ?? '',
    lado: d.lado ?? 'A',
    enOtraLonchera: d.en_otra_lonchera ?? null,
  }
}

// ═══════════════════════════════════════════════════════════════════
// MOVIMIENTOS DIRECTOS DESDE EL MAPA (paridad Insumos OcupacionTab)
// — salida y traslado: RPCs atómicas con las mismas validaciones en BD
//   que rep_registrar_ingreso (capacidad, stock, permiso, kardex).
// ═══════════════════════════════════════════════════════════════════

export type RepResultadoSalida = {
  ubicacion: string
  lado: 'A' | 'B'
  /** Cantidad que queda en la lonchera tras la salida. */
  restante: number
}

/** Salida directa de stock de una lonchera (RPC rep_registrar_salida). */
export async function repRegistrarSalida(params: {
  articuloId: string
  loncheraId: string
  cantidad: number
  referencia?: string
}): Promise<RepResultadoSalida> {
  const { data, error } = await dataClient.rpc('rep_registrar_salida', {
    p_articulo_id: params.articuloId,
    p_lonchera_id: params.loncheraId,
    p_cantidad: params.cantidad,
    p_referencia: params.referencia ?? '',
  })
  lanzar(error)
  const d = (data ?? {}) as { ubicacion?: string; lado?: 'A' | 'B'; restante?: number | string }
  return {
    ubicacion: d.ubicacion ?? '',
    lado: d.lado ?? 'A',
    restante: Number(d.restante) || 0,
  }
}

export type RepResultadoTraslado = {
  origen: string
  destino: string
  ladoDestino: 'A' | 'B'
}

/** Traslado directo entre loncheras (RPC rep_registrar_traslado). */
export async function repRegistrarTraslado(params: {
  articuloId: string
  loncheraOrigenId: string
  loncheraDestinoId: string
  cantidad: number
  referencia?: string
}): Promise<RepResultadoTraslado> {
  const { data, error } = await dataClient.rpc('rep_registrar_traslado', {
    p_articulo_id: params.articuloId,
    p_lonchera_origen_id: params.loncheraOrigenId,
    p_lonchera_destino_id: params.loncheraDestinoId,
    p_cantidad: params.cantidad,
    p_referencia: params.referencia ?? '',
  })
  lanzar(error)
  const d = (data ?? {}) as { origen?: string; destino?: string; lado_destino?: 'A' | 'B' }
  return {
    origen: d.origen ?? '',
    destino: d.destino ?? '',
    ladoDestino: d.lado_destino ?? 'A',
  }
}

/** Historial de UNA ubicación: movimientos donde es origen o destino. */
export async function repMovimientosDeUbicacion(ubicacionId: string, limite = 80): Promise<RepMovimiento[]> {
  const { data, error } = await dataClient
    .from('rep_movimientos')
    .select('*')
    .or(`origen_ubicacion_id.eq.${ubicacionId},destino_ubicacion_id.eq.${ubicacionId}`)
    .order('created_at', { ascending: false })
    .limit(limite)
  lanzar(error)
  return (data ?? []) as RepMovimiento[]
}

// ═══════════════════════════════════════════════════════════════════
// MOVIMIENTOS — kardex repuestos
// ═══════════════════════════════════════════════════════════════════

export type RepFiltroMovimientos = {
  tipo?: RepTipoMovimiento | 'todos'
  codigo?: string
  /** N° de guía EXACTO (reimpresión de rótulos de un documento). */
  guia?: string
  page?: number
  pageSize?: number
}

export async function repListarMovimientos(f: RepFiltroMovimientos = {}): Promise<RepPagina<RepMovimiento>> {
  const page = Math.max(1, f.page ?? 1)
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 50))
  const desde = (page - 1) * pageSize
  const hasta = desde + pageSize - 1

  let q = dataClient
    .from('rep_movimientos')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(desde, hasta)

  if (f.tipo && f.tipo !== 'todos') q = q.eq('tipo', f.tipo)
  const codigo = (f.codigo ?? '').trim().toUpperCase()
  if (codigo) q = q.ilike('codigo', `%${codigo}%`)
  const guia = (f.guia ?? '').trim()
  if (guia) q = q.eq('guia', guia)

  const { data, error, count } = await q
  lanzar(error)
  return { filas: (data ?? []) as RepMovimiento[], total: count ?? 0 }
}

// ═══════════════════════════════════════════════════════════════════
// RAL — rep_ral (registro desde BIG MAGIC; picking/despacho en incr. 2)
// ═══════════════════════════════════════════════════════════════════

export async function repListarRals(params: { estado?: RepEstadoRal | 'todos'; page?: number; pageSize?: number } = {}): Promise<RepPagina<RepRal>> {
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(200, Math.max(10, params.pageSize ?? 50))
  const desde = (page - 1) * pageSize
  const hasta = desde + pageSize - 1

  let q = dataClient
    .from('rep_ral')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(desde, hasta)
  if (params.estado && params.estado !== 'todos') q = q.eq('estado', params.estado)

  const { data, error, count } = await q
  lanzar(error)
  return { filas: (data ?? []) as RepRal[], total: count ?? 0 }
}

export async function repRalPorNumero(numero: string): Promise<RepRal | null> {
  const { data, error } = await dataClient
    .from('rep_ral')
    .select('*')
    .eq('numero', numero.trim().toUpperCase())
    .maybeSingle()
  lanzar(error)
  return (data as RepRal | null) ?? null
}

export async function repCrearRal(input: { numero: string; fecha: string; solicitante: string; usuarioId: string; usuarioNombre: string }): Promise<RepRal> {
  const { data, error } = await dataClient
    .from('rep_ral')
    .insert({
      numero: input.numero.trim().toUpperCase(),
      fecha: input.fecha,
      solicitante: input.solicitante.trim(),
      estado: 'registrado',
      usuario_id: input.usuarioId,
      usuario_nombre: input.usuarioNombre,
    })
    .select('*')
    .single()
  lanzar(error)
  return data as RepRal
}

export async function repDetalleDeRal(ralId: string): Promise<Array<{ id: string; articulo_id: string; cantidad: number; codigo: string; descripcion: string; und: string }>> {
  const { data, error } = await dataClient
    .from('rep_ral_detalle')
    .select('id, cantidad, articulo:rep_articulos(id, codigo, descripcion, und)')
    .eq('ral_id', ralId)
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    cantidad: number
    articulo: { id: string; codigo: string; descripcion: string; und: string }
  }>).map((r) => ({
    id: r.id,
    articulo_id: r.articulo.id,
    cantidad: Number(r.cantidad) || 0,
    codigo: r.articulo.codigo,
    descripcion: r.articulo.descripcion,
    und: r.articulo.und,
  }))
}

export async function repAgregarDetalleRal(ralId: string, articuloId: string, cantidad: number): Promise<void> {
  const { error } = await dataClient
    .from('rep_ral_detalle')
    .insert({ ral_id: ralId, articulo_id: articuloId, cantidad })
  lanzar(error)
}

export async function repEliminarDetalleRal(detalleId: string): Promise<void> {
  // FIX espejo del UPDATE: count exacto para que exigirEliminadas sea real.
  // La RLS solo permite borrar líneas de un RAL en estado 'registrado'.
  const res = await dataClient
    .from('rep_ral_detalle')
    .delete({ count: 'exact' })
    .eq('id', detalleId)
  await exigirEliminadas(res, 'la línea del RAL')
}

// ═══════════════════════════════════════════════════════════════════
// ATENCIÓN / TRÁNSITO — RPCs atómicas (migración 20261110d)
//   picking → pre-picking (Tránsito) · despacho · devolución · anulación
// ═══════════════════════════════════════════════════════════════════

export type RepResultadoPicking = {
  prepicking: string
  cantidad: number
  /** Lo que efectivamente había en lonchera (puede ser menor) */
  tomadoDeAlmacen: number
  /** cantidad − tomadoDeAlmacen: faltante de stock (aviso, no bloquea) */
  faltante: number
}

/** Pickea una línea del RAL: lonchera → pre-picking con ral_id (atómico). */
export async function repPickearLinea(detalleId: string, prepickingLoncheraId?: string): Promise<RepResultadoPicking> {
  const { data, error } = await dataClient.rpc('rep_pickear_linea', {
    p_detalle_id: detalleId,
    p_prepicking_lonchera_id: prepickingLoncheraId ?? null,
  })
  lanzar(error)
  const d = (data ?? {}) as { prepicking?: string; cantidad?: number; tomado_de_almacen?: number; faltante?: number }
  return {
    prepicking: d.prepicking ?? '',
    cantidad: Number(d.cantidad) || 0,
    tomadoDeAlmacen: Number(d.tomado_de_almacen) || 0,
    faltante: Number(d.faltante) || 0,
  }
}

/** Despacha el RAL completo: salida física + kardex + estado despachado. */
export async function repDespacharRal(ralId: string): Promise<{ lineas: number; cantidad: number }> {
  const { data, error } = await dataClient.rpc('rep_despachar_ral', { p_ral_id: ralId })
  lanzar(error)
  const d = (data ?? {}) as { lineas?: number; cantidad?: number }
  return { lineas: Number(d.lineas) || 0, cantidad: Number(d.cantidad) || 0 }
}

/** Devuelve UNA línea del RAL de pre-picking a su lonchera de origen. */
export async function repDevolverLinea(detalleId: string): Promise<{ destino: string }> {
  const { data, error } = await dataClient.rpc('rep_devolver_linea', { p_detalle_id: detalleId })
  lanzar(error)
  return { destino: ((data ?? {}) as { destino?: string }).destino ?? '' }
}

/** Anula un RAL registrado sin carga estacionada. */
export async function repAnularRal(ralId: string): Promise<void> {
  const { error } = await dataClient.rpc('rep_anular_ral', { p_ral_id: ralId })
  lanzar(error)
}

/** Filas del RAL que están estacionadas en pre-picking (Tránsito). */
export async function repTransitoDeRal(ralId: string): Promise<Array<{ articuloId: string; codigo: string; cantidad: number }>> {
  const { data, error } = await dataClient
    .from('rep_stock')
    .select('cantidad, articulo:rep_articulos(id, codigo)')
    .eq('ral_id', ralId)
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    cantidad: number
    articulo: { id: string; codigo: string }
  }>).map((r) => ({
    articuloId: r.articulo.id,
    codigo: r.articulo.codigo,
    cantidad: Number(r.cantidad) || 0,
  }))
}

/** Ubicaciones de pre-picking con su lonchera (para elegir destino del picking). */
export async function repPrepickings(): Promise<Array<{ loncheraId: string; ubicacionId: string; codigo: string; nota: string }>> {
  const { data, error } = await dataClient
    .from('rep_ubicaciones')
    .select('id, codigo, nota, loncheras:rep_loncheras(id)')
    .eq('tipo', 'prepicking')
    .eq('activo', true)
    .order('piso')
    .order('nivel')
    .order('secuencia')
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    codigo: string
    nota: string
    loncheras: Array<{ id: string }>
  }>).map((u) => ({
    loncheraId: u.loncheras[0]?.id ?? '',
    ubicacionId: u.id,
    codigo: u.codigo,
    nota: u.nota,
  })).filter((p) => p.loncheraId !== '')
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN CON DOCUMENTO (sin destino) + TRÁNSITO que UBICA
// Paridad Insumos: Recepción SOLO registra el documento (rep_recepciones
// + rep_recepcion_lineas, estado en_transito); el stock y el kardex se
// escriben cuando TRÁNSITO ubica cada línea (rep_ubicar_desde_transito).
// ═══════════════════════════════════════════════════════════════════

/** Cabecera de una recepción guardada (documento de guía). */
export type RepRecepcion = {
  id: string
  created_at: string
  guia: string
  oc: string
  dam: string
  usuario_nombre: string
  /** Resumen de sus líneas (llenado en cliente con el embed `lineas`). */
  totalLineas: number
  pendientes: number
  /** Proveedores distintos de sus líneas (la cabecera no tiene proveedor:
   *  en modo múltiple cada línea lleva el suyo). */
  proveedores: string[]
}

/** Línea de una recepción guardada (1 artículo de la guía). */
export type RepLineaRecepcion = {
  id: string
  created_at: string
  recepcion_id: string
  articulo_id: string
  codigo: string
  descripcion: string
  und: string
  cantidad: number
  proveedor: string
  estado: 'en_transito' | 'ubicado'
  /** Solo en estado 'ubicado' */
  lonchera_id: string | null
  ubicacion_id: string | null
  movimiento_id: string | null
}

/** Documento de la guía embebido en cada línea (para listar en Tránsito). */
export type RepLineaConDocumento = RepLineaRecepcion & {
  guia: string
  oc: string
  dam: string
  fechaRecepcion: string
}

/**
 * Guarda el DOCUMENTO de recepción completo (1 RPC atómica):
 *   · valida todas las líneas en BD ANTES de insertar (todo-o-nada);
 *   · codigo/descripcion/und se copian DESDE el catálogo (fuente de verdad);
 *   · IDEMPOTENTE por uuid_sync: el reintento del MISMO formulario devuelve
 *     el documento ya guardado (duplicado=true) sin crear filas nuevas.
 * NO escribe stock ni kardex: eso ocurre al ubicar en Tránsito.
 */
export async function repRegistrarRecepcion(params: {
  guia: string
  oc: string
  dam: string
  lineas: Array<{ articuloId: string; cantidad: number; proveedor: string }>
  uuidSync: string
}): Promise<{ recepcionId: string; lineaIds: string[]; duplicado: boolean }> {
  const { data, error } = await dataClient.rpc('rep_registrar_recepcion', {
    p_guia: params.guia,
    p_oc: params.oc,
    p_dam: params.dam,
    p_lineas: params.lineas.map((l) => ({
      articulo_id: l.articuloId,
      cantidad: l.cantidad,
      proveedor: l.proveedor,
    })),
    p_uuid_sync: params.uuidSync,
  })
  lanzar(error)
  const d = (data ?? {}) as { recepcion_id?: string; linea_ids?: string[]; duplicado?: boolean }
  return {
    recepcionId: d.recepcion_id ?? '',
    lineaIds: d.linea_ids ?? [],
    duplicado: Boolean(d.duplicado),
  }
}

/**
 * UBICA una línea en tránsito a la lonchera elegida (RPC atómica):
 * capacidad 15 · upsert de stock · kardex 'ingreso' con el documento ·
 * línea marcada como ubicada. Errores controlados: LONCHERA_LLENA,
 * LINEA_YA_UBICADA, ARTICULO_INACTIVO, NO_AUTORIZADO…
 */
export async function repUbicarDesdeTransito(params: {
  lineaId: string
  loncheraId: string
}): Promise<RepResultadoIngreso> {
  const { data, error } = await dataClient.rpc('rep_ubicar_desde_transito', {
    p_linea_id: params.lineaId,
    p_lonchera_id: params.loncheraId,
  })
  lanzar(error)
  const d = (data ?? {}) as {
    movimiento_id?: string
    ubicacion?: string
    lado?: 'A' | 'B'
    en_otra_lonchera?: { lado: string; ubicacion: string } | null
  }
  return {
    movimientoId: d.movimiento_id ?? '',
    ubicacion: d.ubicacion ?? '',
    lado: d.lado ?? 'A',
    enOtraLonchera: d.en_otra_lonchera ?? null,
  }
}

/**
 * Documento COMPLETO de una recepción (cabecera + líneas) para EDITAR:
 * la edición carga la guía en el formulario y cada línea conserva SU id
 * (uuid estable del rótulo QR — rep_editar_recepcion hace UPDATE por id,
 * no reinserciones, para no romper los QR ya impresos).
 */
export async function repRecepcionCompleta(recepcionId: string): Promise<{
  id: string
  guia: string
  oc: string
  dam: string
  lineas: RepLineaRecepcion[]
}> {
  const [recRes, linRes] = await Promise.all([
    dataClient
      .from('rep_recepciones')
      .select('id, created_at, guia, oc, dam, usuario_nombre')
      .eq('id', recepcionId)
      .maybeSingle(),
    dataClient
      .from('rep_recepcion_lineas')
      .select(
        'id, created_at, recepcion_id, articulo_id, codigo, descripcion, und, cantidad, proveedor, estado, lonchera_id, ubicacion_id, movimiento_id'
      )
      .eq('recepcion_id', recepcionId)
      .order('created_at', { ascending: true }),
  ])
  lanzar(recRes.error)
  lanzar(linRes.error)
  const r = recRes.data as {
    id: string
    created_at: string
    guia: string
    oc: string
    dam: string
    usuario_nombre: string
  } | null
  if (!r) throw new Error('RECEPCION_NO_EXISTE|La guía ya no existe (¿alguien la eliminó?)')
  const lineas = ((linRes.data ?? []) as unknown as RepLineaRecepcion[]).map(
    (l): RepLineaRecepcion => ({
      ...l,
      cantidad: Number(l.cantidad) || 0,
      estado: l.estado === 'ubicado' ? 'ubicado' : 'en_transito',
    })
  )
  return { id: r.id, guia: r.guia, oc: r.oc, dam: r.dam, lineas }
}

/**
 * EDITA el documento de recepción completo (1 RPC atómica):
 *   · cabecera (guía/OC/DAM) + conjunto de líneas sincronizadas por id:
 *     con id → UPDATE conservando el uuid (QR ya impreso sigue válido);
 *     sin id → INSERT (línea nueva); las que faltan en la lista → DELETE.
 *   · SOLO guías 100% en tránsito (si algo ya está ubicado la BD rechaza
 *     con GUIA_YA_UBICADA — stock/kardex intocables).
 *   · Devuelve linea_ids en el MISMO orden de entrada (contrato de rótulos
 *     igual al del registro).
 */
export async function repEditarRecepcion(params: {
  recepcionId: string
  guia: string
  oc: string
  dam: string
  lineas: Array<{ id?: string | null; articuloId: string; cantidad: number; proveedor: string }>
}): Promise<{ lineaIds: string[] }> {
  const { data, error } = await dataClient.rpc('rep_editar_recepcion', {
    p_recepcion_id: params.recepcionId,
    p_guia: params.guia,
    p_oc: params.oc,
    p_dam: params.dam,
    p_lineas: params.lineas.map((l) => ({
      id: l.id ?? null,
      articulo_id: l.articuloId,
      cantidad: l.cantidad,
      proveedor: l.proveedor,
    })),
  })
  lanzar(error)
  const d = (data ?? {}) as { linea_ids?: string[] }
  return { lineaIds: d.linea_ids ?? [] }
}

/**
 * ELIMINA la guía de recepción completa (1 RPC atómica). Solo permitido si
 * NADA de la guía está ubicado (la BD rechaza con GUIA_YA_UBICADA: no se
 * deja stock ni kardex huérfanos). Las líneas en tránsito desaparecen de
 * Tránsito con el documento.
 */
export async function repEliminarRecepcion(
  recepcionId: string
): Promise<{ lineasEliminadas: number }> {
  const { data, error } = await dataClient.rpc('rep_eliminar_recepcion', {
    p_recepcion_id: recepcionId,
  })
  lanzar(error)
  const d = (data ?? {}) as { lineas_eliminadas?: number }
  return { lineasEliminadas: Number(d.lineas_eliminadas ?? 0) }
}

/** Últimas recepciones guardadas (para el panel de Recepción). */
export async function repListarRecepciones(limit = 10): Promise<RepRecepcion[]> {
  const { data, error } = await dataClient
    .from('rep_recepciones')
    .select(
      'id, created_at, guia, oc, dam, usuario_nombre, lineas:rep_recepcion_lineas(estado, proveedor)'
    )
    .order('created_at', { ascending: false })
    .limit(limit)
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    created_at: string
    guia: string
    oc: string
    dam: string
    usuario_nombre: string
    lineas: Array<{ estado: string; proveedor: string }>
  }>).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    guia: r.guia,
    oc: r.oc,
    dam: r.dam,
    usuario_nombre: r.usuario_nombre,
    totalLineas: r.lineas.length,
    pendientes: r.lineas.filter((l) => l.estado === 'en_transito').length,
    proveedores: [...new Set(r.lineas.map((l) => l.proveedor.trim()).filter(Boolean))],
  }))
}

/**
 * Líneas EN TRÁNSITO con su documento (la lista de trabajo de Tránsito).
 * Ordenadas por recepción (más vieja primero: lo que llegó antes, se ubica
 * antes) y con un tope generoso de líneas.
 */
export async function repLineasEnTransito(limit = 300): Promise<RepLineaConDocumento[]> {
  const { data, error } = await dataClient
    .from('rep_recepcion_lineas')
    .select(
      'id, created_at, recepcion_id, articulo_id, codigo, descripcion, und, cantidad, proveedor, estado, lonchera_id, ubicacion_id, movimiento_id, recepcion:rep_recepciones(guia, oc, dam, created_at)'
    )
    .eq('estado', 'en_transito')
    .order('created_at', { ascending: true })
    .limit(limit)
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    created_at: string
    recepcion_id: string
    articulo_id: string
    codigo: string
    descripcion: string
    und: string
    cantidad: number
    proveedor: string
    estado: string
    lonchera_id: string | null
    ubicacion_id: string | null
    movimiento_id: string | null
    recepcion: { guia: string; oc: string; dam: string; created_at: string } | Array<{ guia: string; oc: string; dam: string; created_at: string }>
  }>).map((l) => {
    const rec = Array.isArray(l.recepcion) ? l.recepcion[0] : l.recepcion
    return {
      id: l.id,
      created_at: l.created_at,
      recepcion_id: l.recepcion_id,
      articulo_id: l.articulo_id,
      codigo: l.codigo,
      descripcion: l.descripcion,
      und: l.und,
      cantidad: Number(l.cantidad) || 0,
      proveedor: l.proveedor,
      estado: l.estado === 'ubicado' ? 'ubicado' : 'en_transito',
      lonchera_id: l.lonchera_id,
      ubicacion_id: l.ubicacion_id,
      movimiento_id: l.movimiento_id,
      guia: rec?.guia ?? '',
      oc: rec?.oc ?? '',
      dam: rec?.dam ?? '',
      fechaRecepcion: rec?.created_at ?? '',
    }
  })
}

/**
 * Líneas de UNA guía (por el número de documento) — reimpresión de rótulos
 * desde el documento de recepción. Devuelve la forma mínima que consume
 * movimientosARotulosRep (uuid de la LÍNEA como identidad del QR).
 */
export async function repLineasPorGuia(guia: string): Promise<Array<{
  id: string
  created_at: string
  codigo: string
  descripcion: string
  und: string
  cantidad: number
  guia: string
}>> {
  const { data, error } = await dataClient
    .from('rep_recepcion_lineas')
    .select('id, created_at, codigo, descripcion, und, cantidad, recepcion:rep_recepciones!inner(guia)')
    .eq('recepcion.guia', guia)
    .order('created_at', { ascending: true })
  lanzar(error)
  return ((data ?? []) as unknown as Array<{
    id: string
    created_at: string
    codigo: string
    descripcion: string
    und: string
    cantidad: number
    recepcion: { guia: string } | Array<{ guia: string }>
  }>).map((l) => {
    const rec = Array.isArray(l.recepcion) ? l.recepcion[0] : l.recepcion
    return {
      id: l.id,
      created_at: l.created_at,
      codigo: l.codigo,
      descripcion: l.descripcion,
      und: l.und,
      cantidad: Number(l.cantidad) || 0,
      guia: rec?.guia ?? '',
    }
  })
}
