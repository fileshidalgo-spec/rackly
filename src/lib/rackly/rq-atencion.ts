'use client'

/**
 * RACKLY — Capa de datos de la RQ de Atención a Línea (módulo Atención).
 *
 * Principios de aislamiento (igual que modulos.ts):
 *   · SOLO consulta/escrive SUS tablas (rq_atenciones, rq_atencion_items)
 *     y lee Storage para la foto de la RQ (bucket atencion-rq).
 *   · Las ubicaciones de producto se consultan con los lectores de Racks
 *     (fetchStockPorCodigoRPC) y Piso (stockPisoBuscar) — SOLO LECTURA.
 *   · PUENTE Atención↔Tránsito (2026-10-23): las atenciones por lote van por
 *     RPC atómica (rq_atender_lote / rq_revertir_origen) que SÍ toca
 *     recepcion_registros (columna transito) y posiciones — SIEMPRE del lado
 *     de la BD, nunca el cliente; aquí solo se invoca y se lee el historial.
 *   · atender/revertir van por RPC atómico (rq_atender_item/rq_revertir_item)
 *     con respaldo optimista si la RPC no estuviera disponible.
 */

import { dataClient } from '@/lib/supabase/client'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'
import { FECHA_INICIO_TRANSITO } from '@/lib/rackly/transito-core'

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
  /** Línea/área que pide la RQ (campo "Línea:" del documento físico). */
  linea: string
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
    linea: str(r.linea),
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
  /** Línea/área de producción (L1, L2, JARABES…). Vacío = no indicada. */
  linea: string
  solicitante: string
  notas?: string
  fotoUrl?: string
}

/**
 * Crea la RQ con sus materiales. ATÓMICA e IDEMPOTENTE (Task 25):
 *
 *   · El id lo genera QUIEN LLAMA (el formulario lo mantiene estable entre
 *     reintentos de la misma intención de guardado) — antes se generaba aquí
 *     y cada reintento traía un id nuevo: la "idempotencia" jamás chocaba con
 *     la PK y la RQ se duplicaba tras una respuesta perdida.
 *   · Camino preferente: RPC rq_crear_completa — header + items en UNA
 *     transacción en la BD (si una toma falla, no queda nada a medias) y con
 *     recuperación idempotente de items faltantes en el reintento.
 *   · Respaldo (RPC no disponible): insert en 2 fases CON recuperación —
 *     duplicate del header → se completan los items faltantes; si los items
 *     fallan, se intenta limpiar el header (best-effort) y se propaga el error.
 */
export async function crearRq(
  datos: NuevoRq,
  items: NuevoRqItem[],
  usuario: UsuarioCtx,
  idPreasignado?: string
): Promise<string> {
  const id = idPreasignado?.trim() || nuevoUuid()
  const p = payloadRpcCrearRq(datos, items, usuario, id)

  // ── Camino 1: RPC atómica (transacción completa en la BD) ──
  const { data, error: eRpc } = await dataClient.rpc('rq_crear_completa', {
    p_rq: p.p_rq,
    p_items: p.p_items,
  })
  if (!eRpc && data) return typeof data === 'string' ? data : id
  // RPC ausente (deploy viejo): caemos al respaldo cliente. Cualquier otro
  // error de la RPC es REAL (validación/BD) y se propaga — no se enmascara.
  const msgRpc = eRpc?.message ?? ''
  if (!/pgrst20[24]|not found|does not exist|schema cache/i.test(msgRpc)) {
    throw eRpc ?? new Error('Error desconocido en rq_crear_completa')
  }

  // ── Camino 2: respaldo cliente en 2 fases CON recuperación ──
  const { error: eRq } = await dataClient.from('rq_atenciones').insert({
    id,
    fecha: datos.fecha,
    numero_rq: datos.numeroRq,
    orden_produccion: datos.ordenProduccion,
    producto_codigo: datos.productoCodigo,
    producto_descripcion: datos.productoDescripcion,
    turno: datos.turno || 'T1',
    linea: datos.linea ?? '',
    solicitante: datos.solicitante,
    estado: 'Pendiente',
    foto_url: datos.fotoUrl ?? '',
    notas: datos.notas ?? '',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  })
  if (eRq) {
    const msg = (eRq.message ?? '').toLowerCase()
    if (msg.includes('duplicate') || msg.includes('already exists')) {
      // Reintento con el MISMO id: el header ya estaba (primera llamada
      // llegó a medias). Completamos los materiales que falten — devolver
      // éxito sin materiales era el bug original (Task 25).
      await asegurarItemsRq(id, items)
      return id
    }
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
    if (eItems) {
      // No dejar una RQ cabeza sin materiales: si el borrador se puede
      // quitar (permisos de delete), se quita y el reintento parte limpio.
      // Si los permisos no alcanzan, el reintento con el MISMO id entra por
      // la rama duplicate y completa los items — el sistema converge igual.
      await dataClient.from('rq_atenciones').delete().eq('id', id)
      throw eItems
    }
  }
  return id
}

/**
 * Payload de la RPC rq_crear_completa (PURO — testeable con esbuild+node).
 * El cliente manda fecha/textos ya recortados; la RPC aplica defaults y
 * coalesce defensivos.
 */
export function payloadRpcCrearRq(
  datos: NuevoRq,
  items: NuevoRqItem[],
  usuario: UsuarioCtx,
  id: string
): { p_rq: Record<string, unknown>; p_items: Record<string, unknown>[] } {
  return {
    p_rq: {
      id,
      fecha: datos.fecha,
      numero_rq: datos.numeroRq,
      orden_produccion: datos.ordenProduccion,
      producto_codigo: datos.productoCodigo,
      producto_descripcion: datos.productoDescripcion,
      turno: datos.turno || 'T1',
      linea: datos.linea ?? '',
      solicitante: datos.solicitante,
      foto_url: datos.fotoUrl ?? '',
      notas: datos.notas ?? '',
      usuario_id: usuario.id,
      usuario_nombre: usuario.nombre,
      usuario_correo: usuario.correo,
    },
    p_items: items.map((it, i) => ({
      orden: i,
      codigo: it.codigo,
      descripcion: it.descripcion,
      unidad: it.unidad,
      cantidad: it.cantidad,
    })),
  }
}

/** Inserta los materiales que falten de una RQ (recuperación de reintento). */
async function asegurarItemsRq(rqId: string, items: NuevoRqItem[]): Promise<void> {
  if (items.length === 0) return
  const { count, error: eCount } = await dataClient
    .from('rq_atencion_items')
    .select('id', { count: 'exact', head: true })
    .eq('rq_id', rqId)
  if (eCount) throw eCount
  if ((count ?? 0) > 0) return // ya tenía materiales: nada por recuperar
  const { error: eItems } = await dataClient.from('rq_atencion_items').insert(
    items.map((it, i) => ({
      rq_id: rqId,
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
// PUENTE ATENCIÓN ↔ TRÁNSITO (lote por QR — RPCs atómicas)
// ═══════════════════════════════════════════════════════════════════

export type TomaPuentePayload = {
  uuid: string
  recepcion_id: string
  ruta: 'transito' | 'posicion'
  cantidad: number
  rack: { bloque: string; torre: string; piso: string; posicion: string } | null
  piso: { nivel_id: string; posicion_id?: string; nivel_numero?: number | null } | null
  ubicacion: string
}

export type ResultadoLoteRq = {
  ok: boolean
  duplicado?: boolean
  total_atendido?: number
  tomas_ok?: number
  nuevo_atendido?: number
  pendiente_rq?: number
  estado_rq?: string
  /** Reversa (rq_revertir_origen). */
  total_revertido?: number
  tomas_revertidas?: number
  fallo?: { codigo: string; mensaje: string; toma: string | null }
}

/**
 * Registra la atención POR LOTE (todas las tomas del escaneo) con la RPC
 * atómica rq_atender_lote: descuenta guías en tránsito y/o registra salidas
 * de posiciones, actualiza el item y el estado de la RQ en UNA transacción.
 * All-or-nothing: si una toma falla, NADA queda escrito.
 */
export async function atenderLotePuente(args: {
  itemId: string
  batchUuid: string
  tomas: TomaPuentePayload[]
  confirmaExcedente: boolean
  turno: string
  usuario: { id: string; nombre: string; correo: string }
}): Promise<ResultadoLoteRq> {
  const { data, error } = await dataClient.rpc('rq_atender_lote', {
    p_item_id: args.itemId,
    p_batch_uuid: args.batchUuid,
    p_tomas: args.tomas as unknown as Record<string, unknown>[],
    p_confirma_excedente: args.confirmaExcedente,
    p_turno: args.turno,
    p_usuario_id: args.usuario.id || null,
    p_usuario_nombre: args.usuario.nombre,
    p_usuario_correo: args.usuario.correo,
  })
  if (error) {
    // La RPC devuelve fallos estructurados; si falla por otro motivo (red, RPC
    // ausente), lo envolvemos con el mismo formato para una sola UI de error.
    const msg = error.message ?? 'Error desconocido'
    const pipe = msg.indexOf('|')
    return {
      ok: false,
      fallo: {
        codigo: pipe > 0 ? msg.slice(0, pipe) : 'RPC_ERROR',
        mensaje: pipe > 0 ? msg.slice(pipe + 1) : msg,
        toma: null,
      },
    }
  }
  return (data ?? {
    ok: false,
    fallo: { codigo: 'SIN_RESPUESTA', mensaje: 'La RPC no respondió', toma: null },
  }) as ResultadoLoteRq
}

/**
 * Revierte las atenciones del puente de un material (todas, o solo el lote
 * pedido): compensa guías (reversa_atencion) y re-ingresa posiciones con el
 * mismo lote, en UNA transacción (rq_revertir_origen).
 */
export async function revertirOrigenRq(
  itemId: string,
  batchUuid: string | null,
  turno: string,
  usuario: { id: string; nombre: string; correo: string }
): Promise<ResultadoLoteRq> {
  const { data, error } = await dataClient.rpc('rq_revertir_origen', {
    p_item_id: itemId,
    p_batch_uuid: batchUuid,
    p_turno: turno,
    p_usuario_id: usuario.id || null,
    p_usuario_nombre: usuario.nombre,
    p_usuario_correo: usuario.correo,
  })
  if (error) {
    const msg = error.message ?? 'Error desconocido'
    const pipe = msg.indexOf('|')
    return {
      ok: false,
      fallo: {
        codigo: pipe > 0 ? msg.slice(0, pipe) : 'RPC_ERROR',
        mensaje: pipe > 0 ? msg.slice(pipe + 1) : msg,
        toma: null,
      },
    }
  }
  return (data ?? {
    ok: false,
    fallo: { codigo: 'SIN_RESPUESTA', mensaje: 'La RPC no respondió', toma: null },
  }) as ResultadoLoteRq
}

export type LotePuenteDeItem = {
  lote: string
  rq: string
  tomas: number
  total: number
  ultimaToma: string
}

/**
 * Lista los LOTES del puente registrados para un material (leyendo los envíos
 * 'atencion'/'atencion_posicion' de las guías del mismo código). La usa el
 * diálogo de reversa para saber si un material tiene atenciones con origen.
 */
export async function listarLotesPuenteDeItem(
  itemId: string,
  codigo: string
): Promise<LotePuenteDeItem[]> {
  const c = codigo.trim()
  if (!c || !itemId.trim()) return []
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('transito')
    .ilike('codigo', c)
    .gte('fecha', FECHA_INICIO_TRANSITO)
    .limit(2000)
  if (error) throw error
  const porLote = new Map<string, LotePuenteDeItem>()
  for (const fila of (data ?? []) as Record<string, unknown>[]) {
    const envios = (fila.transito as Record<string, unknown> | null)?.envios
    if (!Array.isArray(envios)) continue
    for (const e of envios as Record<string, unknown>[]) {
      if (e.item_id !== itemId) continue
      const destino = String(e.destino ?? '')
      if (destino !== 'atencion' && destino !== 'atencion_posicion') continue
      if (!e.lote || e.reversa_de) continue
      const key = String(e.lote)
      const cant =
        destino === 'atencion' ? Number(e.cantidad ?? 0) : Number(e.cantidad_atencion ?? 0)
      const previa = porLote.get(key)
      if (previa) {
        previa.tomas += 1
        previa.total += cant
        if (String(e.fecha ?? '') > previa.ultimaToma) previa.ultimaToma = String(e.fecha ?? '')
      } else {
        porLote.set(key, {
          lote: key,
          rq: String(e.rq ?? ''),
          tomas: 1,
          total: cant,
          ultimaToma: String(e.fecha ?? ''),
        })
      }
    }
  }
  return [...porLote.values()].sort((a, b) => b.ultimaToma.localeCompare(a.ultimaToma))
}

// ═══════════════════════════════════════════════════════════════════
// ELIMINACIÓN (solo supervisores/admin — lo valida el componente)
// ═══════════════════════════════════════════════════════════════════

export async function eliminarRq(id: string): Promise<void> {
  // FIX Task 25: el HEADER PRIMERO. La política RLS de DELETE (solo
  // supervisores) se valida en el primer delete: si ese pasa, el usuario
  // tiene permiso y el de items pasará igual. Antes se borraban los items
  // primero — si el delete del header fallaba (red), quedaba una RQ visible
  // SIN materiales (pérdida parcial). Con este orden el peor caso es lo
  // contrario: items huérfanos INVISIBLES (basura inofensiva, sin impacto
  // en la UI ni en los totales).
  const { error: eRq } = await dataClient.from('rq_atenciones').delete().eq('id', id)
  if (eRq) throw eRq
  const { error: eItems } = await dataClient.from('rq_atencion_items').delete().eq('rq_id', id)
  if (eItems) throw eItems
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

/**
 * BEST-EFFORT: borra la foto que quedó huérfana cuando la subida tuvo éxito
 * pero crearRq falló (Task 25 — sin esto el bucket privado acumula basura
 * que nadie referencia). Nunca lanza: el fallo de limpieza no debe tapar el
 * error real del guardado.
 */
export async function eliminarFotoRq(ruta: string): Promise<void> {
  const r = (ruta ?? '').trim()
  if (!r) return
  try {
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
    const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
    const { supabase } = await import('@/lib/supabase/client')
    const { data: sess } = await supabase.auth.getSession()
    const token = sess.session?.access_token
    if (!base || !anon || !token) return
    await fetch(`${base}/storage/v1/object/atencion-rq/${encodeURIComponent(r)}`, {
      method: 'DELETE',
      headers: { apikey: anon, authorization: `Bearer ${token}` },
    })
  } catch {
    // Limpieza oportunista: silenciosa por diseño.
  }
}
