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
  type RepMovimiento,
  type RepTipoMovimiento,
  type RepRal,
  type RepEstadoRal,
  repCodigoUbicacion,
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

export async function repListarUbicaciones(): Promise<RepUbicacion[]> {
  const { data, error } = await dataClient
    .from('rep_ubicaciones')
    .select('*')
    .order('piso')
    .order('nivel')
    .order('tipo')
    .order('secuencia')
  lanzar(error)
  return (data ?? []) as RepUbicacion[]
}

export async function repListarLoncheras(): Promise<RepLonchera[]> {
  const { data, error } = await dataClient.from('rep_loncheras').select('*')
  lanzar(error)
  return (data ?? []) as RepLonchera[]
}

export type RepNuevaUbicacion = {
  tipo: RepTipoUbicacion
  piso: number
  nivel: number
  secuencia: number
  nota?: string
}

/**
 * Crea la ubicación con código normalizado; las LONCHERAS las crea el
 * trigger en BD (rack → A+B, resto → A). Devuelve la fila creada.
 */
export async function repCrearUbicacion(input: RepNuevaUbicacion): Promise<RepUbicacion> {
  const codigo = repCodigoUbicacion(input.tipo, input.piso, input.nivel, input.secuencia)
  const { data, error } = await dataClient
    .from('rep_ubicaciones')
    .insert({
      tipo: input.tipo,
      piso: input.piso,
      nivel: input.nivel,
      secuencia: input.secuencia,
      codigo,
      nota: input.nota?.trim() ?? '',
    })
    .select('*')
    .single()
  lanzar(error)
  return data as RepUbicacion
}

export async function repEliminarUbicacion(id: string): Promise<void> {
  // FIX espejo del UPDATE: count exacto para que exigirEliminadas sea real.
  const res = await dataClient
    .from('rep_ubicaciones')
    .delete({ count: 'exact' })
    .eq('id', id)
  await exigirEliminadas(res, 'la ubicación')
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
 * Una sola ronda de 3 consultas para pintar el mapa completo. La ocupación
 * se AGREGA EN BD (RPC rep_ocupacion_loncheras, GROUP BY): el navegador
 * jamás descarga las filas de stock (crecen con la operación diaria).
 */
export async function repMapaAlmacen(): Promise<RepMapaAlmacen> {
  const [ubicRes, lonchRes, ocupRes] = await Promise.all([
    dataClient.from('rep_ubicaciones').select('*').order('piso').order('nivel').order('tipo').order('secuencia'),
    dataClient.from('rep_loncheras').select('*'),
    dataClient.rpc('rep_ocupacion_loncheras'),
  ])
  lanzar(ubicRes.error)
  lanzar(lonchRes.error)
  lanzar(ocupRes.error)

  const loncheras = new Map<string, RepLonchera>()
  for (const l of (lonchRes.data ?? []) as RepLonchera[]) loncheras.set(l.id, l)

  const ocupacion = new Map<string, RepOcupacionLonchera>()
  for (const o of (ocupRes.data ?? []) as Array<{
    lonchera_id: string
    articulos: number | string
    cantidad: number | string
    en_transito: number | string
  }>) {
    ocupacion.set(o.lonchera_id, {
      articulos: Number(o.articulos) || 0,
      cantidad: Number(o.cantidad) || 0,
      enTransito: Number(o.en_transito) || 0,
    })
  }

  return { ubicaciones: (ubicRes.data ?? []) as RepUbicacion[], loncheras, ocupacion }
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
 */
export async function repRegistrarIngreso(params: {
  articuloId: string
  loncheraId: string
  cantidad: number
  referencia?: string
}): Promise<RepResultadoIngreso> {
  const { data, error } = await dataClient.rpc('rep_registrar_ingreso', {
    p_articulo_id: params.articuloId,
    p_lonchera_id: params.loncheraId,
    p_cantidad: params.cantidad,
    p_referencia: params.referencia ?? '',
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
// MOVIMIENTOS — kardex repuestos
// ═══════════════════════════════════════════════════════════════════

export type RepFiltroMovimientos = {
  tipo?: RepTipoMovimiento | 'todos'
  codigo?: string
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
  const res = await dataClient
    .from('rep_ral_detalle')
    .delete({ count: 'exact' })
    .eq('id', detalleId)
  await exigirEliminadas(res, 'la línea del RAL')
}
