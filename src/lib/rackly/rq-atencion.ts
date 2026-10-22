'use client'

/**
 * RACKLY — Capa de datos de la RQ de Atención a Línea (módulo Atención).
 *
 * Principios de aislamiento (igual que modulos.ts):
 *   · SOLO consulta/escrive SUS tablas (rq_atenciones, rq_atencion_items)
 *     y lee Storage para la foto de la RQ (bucket atencion-rq).
 *   · Las ubicaciones de producto se consultan con los lectores de Racks
 *     (fetchStockPorCodigoRPC) y Piso (stockPisoBuscar) — SOLO LECTURA.
 *   · Escrituras operativas con dataClient (anon + JWT de sesión; RLS real).
 *   · atender/revertir van por RPC atómico (rq_atender_item/rq_revertir_item)
 *     con respaldo optimista si la RPC no estuviera disponible.
 */

import { dataClient } from '@/lib/supabase/client'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

export const ESTADOS_RQ = ['Pendiente', 'En proceso', 'Atendido'] as const

export type RqAtencion = {
  id: string
  createdAt: string
  fecha: string
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  /** T1/T2 — calculado por la app con la regla del almacén (turno.ts). */
  turno: string
  solicitante: string
  /** 'Pendiente' | 'En proceso' | 'Atendido' (lo mantiene la RPC). */
  estado: string
  fotoUrl: string
  notas: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export type RqItem = {
  id: string
  rqId: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  cantidad: number
  cantidadAtendida: number
  usuarioAtencion: string
  atendidoEn: string
}

export type NuevoRqItem = {
  codigo: string
  descripcion: string
  unidad: string
  cantidad: number
}

export type RqCompleta = { rq: RqAtencion; items: RqItem[] }

type UsuarioCtx = { id: string; nombre: string; correo: string }

/** Estado DERIVADO de un material (no se guarda: 1 sola fuente de verdad). */
export function estadoDeItem(it: Pick<RqItem, 'cantidad' | 'cantidadAtendida'>): string {
  if (it.cantidadAtendida >= it.cantidad && it.cantidad > 0) return 'Atendido'
  if (it.cantidadAtendida > 0) return 'En proceso'
  return 'Pendiente'
}

export function pendienteDeItem(it: Pick<RqItem, 'cantidad' | 'cantidadAtendida'>): number {
  return Math.max(it.cantidad - it.cantidadAtendida, 0)
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════════

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  const n = parseFloat(String(v ?? '0'))
  return isNaN(n) ? 0 : n
}

function str(v: unknown): string {
  return (v as string | null)?.toString() ?? ''
}

function mapRq(r: Record<string, unknown>): RqAtencion {
  return {
    id: r.id as string,
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    numeroRq: str(r.numero_rq),
    ordenProduccion: str(r.orden_produccion),
    productoCodigo: str(r.producto_codigo),
    productoDescripcion: str(r.producto_descripcion),
    turno: str(r.turno) || 'T1',
    solicitante: str(r.solicitante),
    estado: str(r.estado) || 'Pendiente',
    fotoUrl: str(r.foto_url),
    notas: str(r.notas),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
  }
}

function mapItem(r: Record<string, unknown>): RqItem {
  return {
    id: r.id as string,
    rqId: str(r.rq_id),
    orden: toNum(r.orden),
    codigo: str(r.codigo),
    descripcion: str(r.descripcion),
    unidad: str(r.unidad),
    cantidad: toNum(r.cantidad),
    cantidadAtendida: toNum(r.cantidad_atendida),
    usuarioAtencion: str(r.usuario_atencion),
    atendidoEn: str(r.atendido_en),
  }
}

/** Recalcula el estado del encabezado según sus materiales (respaldo RPC). */
async function recalcularEstadoRq(rqId: string): Promise<void> {
  const { data: items, error: eItems } = await dataClient
    .from('rq_atencion_items')
    .select('cantidad, cantidad_atendida')
    .eq('rq_id', rqId)
  if (eItems) throw eItems
  const filas = (items ?? []) as Record<string, unknown>[]
  const pendientes = filas.filter((f) => toNum(f.cantidad_atendida) < toNum(f.cantidad)).length
  const estado =
    filas.length === 0 ? 'Pendiente' : pendientes === 0 ? 'Atendido' : pendientes === filas.length ? 'Pendiente' : 'En proceso'
  // FIX auditoría 2026-10-22 (P3): el resultado del UPDATE no se revisaba — un
  // fallo dejaba el encabezado de la RQ con estado viejo y sin rastro.
  const { error: eEstado } = await dataClient.from('rq_atenciones').update({ estado }).eq('id', rqId)
  if (eEstado) throw eEstado
}

// ═══════════════════════════════════════════════════════════════════
// LISTADO / LECTURA
// ═══════════════════════════════════════════════════════════════════

export type FiltrosRq = {
  busqueda?: string
  estado?: string
  limit?: number
  offset?: number
}

export async function listarRqs(
  filtros: FiltrosRq = {}
): Promise<{ filas: RqAtencion[]; total: number }> {
  const limit = filtros.limit ?? 50
  const offset = filtros.offset ?? 0
  let q = dataClient
    .from('rq_atenciones')
    .select('*', { count: 'exact' })
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const busqueda = (filtros.busqueda ?? '').trim()
  if (busqueda) {
    const seguro = busqueda.replace(/[%,()]/g, ' ').trim()
    if (seguro) {
      q = q.or(
        [
          `numero_rq.ilike.%${seguro}%`,
          `orden_produccion.ilike.%${seguro}%`,
          `producto_codigo.ilike.%${seguro}%`,
          `producto_descripcion.ilike.%${seguro}%`,
          `solicitante.ilike.%${seguro}%`,
        ].join(',')
      )
    }
  }
  const estado = (filtros.estado ?? '').trim()
  if (estado && estado !== 'todos') q = q.eq('estado', estado)

  const { data, error, count } = await q
  if (error) throw error
  return { filas: ((data ?? []) as Record<string, unknown>[]).map(mapRq), total: count ?? (data ?? []).length }
}

/** RQ completa: encabezado + materiales ordenados (para la vista de detalle). */
export async function obtenerRqCompleta(id: string): Promise<RqCompleta> {
  const { data: rq, error: eRq } = await dataClient
    .from('rq_atenciones')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (eRq) throw eRq
  if (!rq) throw new Error('La RQ ya no existe (puede haber sido eliminada).')

  const { data: items, error: eItems } = await dataClient
    .from('rq_atencion_items')
    .select('*')
    .eq('rq_id', id)
    .order('orden', { ascending: true })
  if (eItems) throw eItems

  return {
    rq: mapRq(rq as Record<string, unknown>),
    items: ((items ?? []) as Record<string, unknown>[]).map(mapItem),
  }
}

// ═══════════════════════════════════════════════════════════════════
// CREACIÓN
// ═══════════════════════════════════════════════════════════════════

export type NuevoRq = {
  fecha: string
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  turno: string
  solicitante: string
  notas?: string
  fotoUrl?: string
}

/**
 * Crea la RQ con sus materiales. El id del ENCABEZADO se genera en el
 * cliente: si la red se cae tras guardar y el usuario reintenta, el INSERT
 * duplicado choca con la PK y se reconoce como YA GUARDADA (idempotencia).
 */
export async function crearRq(
  datos: NuevoRq,
  items: NuevoRqItem[],
  usuario: UsuarioCtx
): Promise<string> {
  const id = nuevoUuid()
  const { error: eRq } = await dataClient.from('rq_atenciones').insert({
    id,
    fecha: datos.fecha,
    numero_rq: datos.numeroRq,
    orden_produccion: datos.ordenProduccion,
    producto_codigo: datos.productoCodigo,
    producto_descripcion: datos.productoDescripcion,
    turno: datos.turno || 'T1',
    solicitante: datos.solicitante,
    estado: 'Pendiente',
    foto_url: datos.fotoUrl ?? '',
    notas: datos.notas ?? '',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  })
  if (eRq) {
    // Reintento tras una red caída: la RQ con ese id YA existe → éxito.
    const msg = (eRq.message ?? '').toLowerCase()
    if (msg.includes('duplicate') || msg.includes('already exists')) return id
    throw eRq
  }
  if (items.length > 0) {
    const { error: eItems } = await dataClient.from('rq_atencion_items').insert(
      items.map((it, i) => ({
        rq_id: id,
        orden: i,
        codigo: it.codigo,
        descripcion: it.descripcion,
        unidad: it.unidad,
        cantidad: it.cantidad,
        cantidad_atendida: 0,
      }))
    )
    if (eItems) throw eItems
  }
  return id
}

// ═══════════════════════════════════════════════════════════════════
// ATENDER / REVERTIR (RPC atómica + respaldo optimista)
// ═══════════════════════════════════════════════════════════════════

/**
 * Registra cantidad atendida de un material. RPC atómica: valida el tope,
 * suma y recalcula el estado del encabezado en UNA transacción en la BD
 * (dos celulares atendiendo a la vez nunca sobrepasan lo pendiente).
 */
export async function atenderItemRq(
  itemId: string,
  cantidad: number,
  usuarioNombre: string
): Promise<RqItem> {
  const { data, error } = await dataClient.rpc('rq_atender_item', {
    p_item_id: itemId,
    p_cantidad: cantidad,
    p_usuario: usuarioNombre,
  })
  if (!error && data) return mapItem(data as Record<string, unknown>)

  // Respaldo (RPC no disponible): lectura → suma con guard optimista
  const razon = error?.message ?? ''
  if (/excede|mayor que cero|no encontrado/i.test(razon)) throw new Error(razon)
  const { data: previo, error: ePrevio } = await dataClient
    .from('rq_atencion_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle()
  if (ePrevio) throw ePrevio
  if (!previo) throw new Error('Artículo no encontrado')
  const itemPrevio = mapItem(previo as Record<string, unknown>)
  if (cantidad <= 0) throw new Error('La cantidad a atender debe ser mayor que cero')
  // v2 sobreatención: SIN tope superior — la salida física puede exceder lo
  // requerido (p. ej. formato por paleta 123 mil vs requerido 120 mil).
  // El estado pasa a 'Atendido' al alcanzar o superar la cantidad pedida.
  const nuevo = itemPrevio.cantidadAtendida + cantidad
  const { data: upd, error: eUpd } = await dataClient
    .from('rq_atencion_items')
    .update({
      cantidad_atendida: nuevo,
      usuario_atencion: usuarioNombre || itemPrevio.usuarioAtencion,
      atendido_en: nuevo >= itemPrevio.cantidad ? new Date().toISOString() : null,
    })
    .eq('id', itemId)
    .eq('cantidad_atendida', itemPrevio.cantidadAtendida) // guard optimista
    .select()
    .maybeSingle()
  if (eUpd) throw eUpd
  if (!upd)
    throw new Error('Otro usuario atendió este artículo al mismo tiempo. Recarga e intenta de nuevo.')
  await recalcularEstadoRq(itemPrevio.rqId)
  return mapItem(upd as Record<string, unknown>)
}

/** Revierte una atención equivocada (devuelve la cantidad al pendiente). */
export async function revertirItemRq(itemId: string, cantidad: number): Promise<RqItem> {
  const { data, error } = await dataClient.rpc('rq_revertir_item', {
    p_item_id: itemId,
    p_cantidad: cantidad,
  })
  if (!error && data) return mapItem(data as Record<string, unknown>)

  const razon = error?.message ?? ''
  if (/mayor que cero|no encontrado/i.test(razon)) throw new Error(razon)
  const { data: previo, error: ePrevio } = await dataClient
    .from('rq_atencion_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle()
  if (ePrevio) throw ePrevio
  if (!previo) throw new Error('Artículo no encontrado')
  const itemPrevio = mapItem(previo as Record<string, unknown>)
  const nuevo = Math.max(itemPrevio.cantidadAtendida - cantidad, 0)
  const { data: upd, error: eUpd } = await dataClient
    .from('rq_atencion_items')
    .update({
      cantidad_atendida: nuevo,
      atendido_en: nuevo >= itemPrevio.cantidad ? itemPrevio.atendidoEn : null,
    })
    .eq('id', itemId)
    .eq('cantidad_atendida', itemPrevio.cantidadAtendida)
    .select()
    .maybeSingle()
  if (eUpd) throw eUpd
  if (!upd)
    throw new Error('Otro usuario modificó este artículo al mismo tiempo. Recarga e intenta de nuevo.')
  await recalcularEstadoRq(itemPrevio.rqId)
  return mapItem(upd as Record<string, unknown>)
}

// ═══════════════════════════════════════════════════════════════════
// ELIMINACIÓN (solo supervisores/admin — lo valida el componente)
// ═══════════════════════════════════════════════════════════════════

export async function eliminarRq(id: string): Promise<void> {
  // Los materiales primero (si el cascade fallara por permisos, no queda huérfano)
  const { error: eItems } = await dataClient.from('rq_atencion_items').delete().eq('rq_id', id)
  if (eItems) throw eItems
  const { error: eRq } = await dataClient.from('rq_atenciones').delete().eq('id', id)
  if (eRq) throw eRq
}

// ═══════════════════════════════════════════════════════════════════
// FOTO DE LA RQ (bucket privado atencion-rq — patrón subirFotoGuia)
// ═══════════════════════════════════════════════════════════════════

export async function subirFotoRq(archivo: Blob, usuarioId: string): Promise<string> {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  const { supabase } = await import('@/lib/supabase/client')
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!base || !anon) throw new Error('Configuración de Supabase incompleta')
  if (!token) throw new Error('Sesión expirada: vuelve a iniciar sesión para adjuntar la foto')
  const ruta = `${usuarioId}/${Date.now()}.jpg`
  const res = await fetch(`${base}/storage/v1/object/atencion-rq/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: anon,
      authorization: `Bearer ${token}`,
      'content-type': 'image/jpeg',
      'x-upsert': 'false',
    },
    body: archivo,
  })
  if (!res.ok) {
    // Sin foto NO se bloquea el registro: la RQ vale aunque falle la imagen
    throw new Error(`Storage ${res.status}: ${(await res.text().catch(() => '')).slice(0, 140)}`)
  }
  return ruta
}
