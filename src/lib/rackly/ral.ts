'use client'

/**
 * RACKLY — Capa de datos del RAL (Requerimiento al Almacén) · módulo Atención.
 *
 * Principios de aislamiento (espejo de rq-atencion.ts):
 *   · SOLO consulta/escrive SUS tablas (rals, ral_items) — cero contacto
 *     con rq_atenciones/rq_atencion_items ni con otros módulos.
 *   · La foto viaja al MISMO bucket privado atencion-rq (patrón
 *     subirFotoRq: carpeta por usuario, misma política de Storage).
 *   · Creación ATÓMICA e IDEMPOTENTE vía RPC ral_crear_completa
 *     (header + items en UNA transacción; el id lo preasigna quien llama
 *     y se mantiene entre reintentos — mismo criterio Task 25 de la RQ).
 *   · Respaldo (RPC no disponible): insert en 2 fases CON recuperación.
 */

import { dataClient } from '@/lib/supabase/client'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

export type RalRegistro = {
  id: string
  createdAt: string
  fecha: string
  /** Nº de documento del ERP (p.ej. "8378"). */
  documento: string
  transaccion: string
  areaSolicitante: string
  solicitante: string
  aprobadoPor: string
  almacen: string
  linea: string
  fotoUrl: string
  notas: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  /** Cantidad de materiales (rellenada por listarRals con los items). */
  articulos: number
}

export type RalItem = {
  id: string
  ralId: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: number
}

export type RalCompleta = { ral: RalRegistro; items: RalItem[] }

export type NuevoRalItem = {
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: number
}

export type NuevoRal = {
  fecha: string
  documento: string
  transaccion?: string
  areaSolicitante?: string
  solicitante?: string
  aprobadoPor?: string
  almacen?: string
  linea?: string
  notas?: string
  fotoUrl?: string
}

type UsuarioCtx = { id: string; nombre: string; correo: string }

// ═══════════════════════════════════════════════════════════════════
// MAPEO fila ↔ registro (PostgREST snake_case ↔ app camelCase)
// ═══════════════════════════════════════════════════════════════════

type FilaRal = Record<string, unknown>

function filaARal(f: FilaRal): RalRegistro {
  return {
    id: String(f.id ?? ''),
    createdAt: String(f.created_at ?? ''),
    fecha: String(f.fecha ?? ''),
    documento: String(f.documento ?? ''),
    transaccion: String(f.transaccion ?? ''),
    areaSolicitante: String(f.area_solicitante ?? ''),
    solicitante: String(f.solicitante ?? ''),
    aprobadoPor: String(f.aprobado_por ?? ''),
    almacen: String(f.almacen ?? ''),
    linea: String(f.linea ?? ''),
    fotoUrl: String(f.foto_url ?? ''),
    notas: String(f.notas ?? ''),
    usuarioId: String(f.usuario_id ?? ''),
    usuarioNombre: String(f.usuario_nombre ?? ''),
    usuarioCorreo: String(f.usuario_correo ?? ''),
    articulos: 0, // lo rellena listarRals con los items reales
  }
}

function filaARalItem(f: FilaRal): RalItem {
  return {
    id: String(f.id ?? ''),
    ralId: String(f.ral_id ?? ''),
    orden: Number(f.orden ?? 0),
    codigo: String(f.codigo ?? ''),
    descripcion: String(f.descripcion ?? ''),
    unidad: String(f.unidad ?? ''),
    centroCostos: String(f.centro_costos ?? ''),
    cantidad: Number(f.cantidad ?? 0),
  }
}

// ═══════════════════════════════════════════════════════════════════
// LISTADO
// ═══════════════════════════════════════════════════════════════════

/**
 * Lista los RALs más recientes con su conteo de materiales. Dos lecturas
 * (headers + items) y agrupado en el cliente: volumen pequeño (documentos
 * registrados por jornada), evita una vista SQL extra en la BD.
 */
export async function listarRals(limite = 100): Promise<RalRegistro[]> {
  const { data: headers, error: eH } = await dataClient
    .from('rals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limite)
  if (eH) throw eH
  const rals = (headers ?? []).map(filaARal)
  if (rals.length === 0) return []

  const ids = rals.map((r) => r.id)
  const { data: items, error: eI } = await dataClient
    .from('ral_items')
    .select('ral_id')
    .in('ral_id', ids)
  if (eI) throw eI
  const conteo = new Map<string, number>()
  for (const it of items ?? []) {
    const k = String((it as FilaRal).ral_id ?? '')
    conteo.set(k, (conteo.get(k) ?? 0) + 1)
  }
  for (const r of rals) r.articulos = conteo.get(r.id) ?? 0
  return rals
}

/** RAL completo (encabezado + materiales) para el detalle expandible. */
export async function obtenerRalCompleta(id: string): Promise<RalCompleta> {
  const { data: h, error: eH } = await dataClient
    .from('rals')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (eH) throw eH
  if (!h) throw new Error('RAL no encontrado')
  const { data: items, error: eI } = await dataClient
    .from('ral_items')
    .select('*')
    .eq('ral_id', id)
    .order('orden', { ascending: true })
  if (eI) throw eI
  return {
    ral: filaARal(h as FilaRal),
    items: (items ?? []).map(filaARalItem),
  }
}

// ═══════════════════════════════════════════════════════════════════
// CREACIÓN (atómica + idempotente) Y ELIMINACIÓN
// ═══════════════════════════════════════════════════════════════════

/** Payload de la RPC ral_crear_completa (texto ya recortado por el caller). */
export function payloadRpcCrearRal(
  datos: NuevoRal,
  items: NuevoRalItem[],
  usuario: UsuarioCtx,
  id: string
): { p_ral: Record<string, unknown>; p_items: Record<string, unknown>[] } {
  return {
    p_ral: {
      id,
      fecha: datos.fecha,
      documento: datos.documento,
      transaccion: datos.transaccion ?? '',
      area_solicitante: datos.areaSolicitante ?? '',
      solicitante: datos.solicitante ?? '',
      aprobado_por: datos.aprobadoPor ?? '',
      almacen: datos.almacen ?? '',
      linea: datos.linea ?? '',
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
      centro_costos: it.centroCostos,
      cantidad: it.cantidad,
    })),
  }
}

/** Completa los items que falten tras un reintento (respaldo cliente). */
async function asegurarItemsRal(ralId: string, items: NuevoRalItem[]): Promise<void> {
  const { data: existentes, error } = await dataClient
    .from('ral_items')
    .select('orden, codigo')
    .eq('ral_id', ralId)
  if (error) throw error
  const clave = (orden: number, codigo: string) => `${orden}|${codigo}`
  const vistas = new Set((existentes ?? []).map((x) => clave(Number((x as FilaRal).orden), String((x as FilaRal).codigo))))
  const faltantes = items
    .map((it, i) => ({ ...it, orden: i }))
    .filter((it) => !vistas.has(clave(it.orden, it.codigo)))
  if (faltantes.length === 0) return
  const { error: eIns } = await dataClient.from('ral_items').insert(
    faltantes.map((it) => ({
      ral_id: ralId,
      orden: it.orden,
      codigo: it.codigo,
      descripcion: it.descripcion,
      unidad: it.unidad,
      centro_costos: it.centroCostos,
      cantidad: it.cantidad,
    }))
  )
  if (eIns) throw eIns
}

/**
 * Crea el RAL con sus materiales. ATÓMICO e IDEMPOTENTE:
 *   · El id lo genera QUIEN LLAMA y se mantiene entre reintentos de la
 *     misma intención de guardado — la RPC completa lo que falte en vez
 *     de duplicar (mismo criterio que la RQ, Task 25).
 *   · Camino preferente: RPC ral_crear_completa (1 transacción).
 *   · Respaldo (RPC ausente): insert en 2 fases con recuperación; si los
 *     items fallan se intenta limpiar el header (best-effort).
 */
export async function crearRal(
  datos: NuevoRal,
  items: NuevoRalItem[],
  usuario: UsuarioCtx,
  idPreasignado?: string
): Promise<string> {
  const id = idPreasignado?.trim() || nuevoUuid()
  const p = payloadRpcCrearRal(datos, items, usuario, id)

  // ── Camino 1: RPC atómica ──
  const { data, error: eRpc } = await dataClient.rpc('ral_crear_completa', {
    p_ral: p.p_ral,
    p_items: p.p_items,
  })
  if (!eRpc && data) return typeof data === 'string' ? data : id
  // RPC ausente (deploy viejo): respaldo cliente. Otros errores son REALES.
  const msgRpc = eRpc?.message ?? ''
  if (!/pgrst20[24]|not found|does not exist|schema cache/i.test(msgRpc)) {
    throw eRpc ?? new Error('Error desconocido en ral_crear_completa')
  }

  // ── Camino 2: respaldo cliente en 2 fases CON recuperación ──
  const { error: eH } = await dataClient.from('rals').insert({
    id,
    fecha: datos.fecha,
    documento: datos.documento,
    transaccion: datos.transaccion ?? '',
    area_solicitante: datos.areaSolicitante ?? '',
    solicitante: datos.solicitante ?? '',
    aprobado_por: datos.aprobadoPor ?? '',
    almacen: datos.almacen ?? '',
    linea: datos.linea ?? '',
    foto_url: datos.fotoUrl ?? '',
    notas: datos.notas ?? '',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  })
  if (eH) {
    const msg = (eH.message ?? '').toLowerCase()
    if (msg.includes('duplicate') || msg.includes('already exists')) {
      // Reintento con el MISMO id: completar los items que falten.
      await asegurarItemsRal(id, items)
      return id
    }
    throw eH
  }
  if (items.length > 0) {
    const { error: eI } = await dataClient.from('ral_items').insert(
      items.map((it, i) => ({
        ral_id: id,
        orden: i,
        codigo: it.codigo,
        descripcion: it.descripcion,
        unidad: it.unidad,
        centro_costos: it.centroCostos,
        cantidad: it.cantidad,
      }))
    )
    if (eI) {
      // No dejar un header sin materiales (reintento entrará por duplicate
      // y completará): best-effort, espejo del patrón RQ.
      await dataClient.from('rals').delete().eq('id', id)
      throw eI
    }
  }
  return id
}

/**
 * Elimina el RAL. El header PRIMERO: valida RLS de eliminación
 * (supervisores) en el primer delete; los items caen por CASCADE.
 */
export async function eliminarRal(id: string): Promise<void> {
  const { error } = await dataClient.from('rals').delete().eq('id', id)
  if (error) throw error
}
