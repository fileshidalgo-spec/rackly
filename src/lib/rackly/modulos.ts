'use client'

/**
 * RACKLY — Capa de datos de los módulos Recepción y Atención,
 * más la actividad transversal que consume el módulo Usuarios.
 *
 * Principios de aislamiento (no romper otros módulos):
 *   · Este archivo SOLO consulta/escrive sus propias tablas
 *     (recepcion_registros, atencion_registros) y hace LECTURAS de
 *     movimientos / piso_movimientos para el módulo Usuarios.
 *   · No invoca RPCs ni muta tablas de Racks o Piso.
 *   · Todas las escrituras van por dataClient (service_role), igual que
 *     el resto de la app.
 */

import { dataClient } from '@/lib/supabase/client'

// ═══════════════════════════════════════════════════════════════════
// TIPOS COMPARTIDOS
// ═══════════════════════════════════════════════════════════════════

export const ESTADOS_RECEPCION = ['Pendiente', 'Recibido', 'Observado'] as const
export const TIPOS_DOCUMENTO_RECEPCION = ['Guia', 'Orden de compra', 'Factura', 'Otro'] as const

export const ESTADOS_ATENCION = ['Pendiente', 'En proceso', 'Atendido'] as const
export const TIPOS_ATENCION = ['Consulta', 'Soporte', 'Mantenimiento', 'Otro'] as const

export type RegistroRecepcion = {
  id: string
  createdAt: string
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  proveedor: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  placa: string
  fotoUrl: string
  estado: string
  observaciones: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export type RegistroAtencion = {
  id: string
  createdAt: string
  fecha: string
  solicitante: string
  area: string
  tipo: string
  asunto: string
  detalle: string
  estado: string
  atendidoEn: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export type NuevoRecepcion = {
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  proveedor: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida?: string
  lote?: string
  fechaProduccion?: string // 'YYYY-MM-DD' o '' = sin dato
  fechaVencimiento?: string
  placa?: string
  fotoUrl?: string
  observaciones: string
}

export type NuevoAtencion = {
  fecha: string
  solicitante: string
  area: string
  tipo: string
  asunto: string
  detalle: string
}

type UsuarioCtx = { id: string; nombre: string; correo: string }

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

function mapRecepcion(r: Record<string, unknown>): RegistroRecepcion {
  return {
    id: r.id as string,
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    tipoDocumento: str(r.tipo_documento),
    numeroDocumento: str(r.numero_documento),
    proveedor: str(r.proveedor),
    codigo: str(r.codigo),
    descripcion: str(r.descripcion),
    cantidad: toNum(r.cantidad),
    unidadMedida: str(r.unidad_medida),
    lote: str(r.lote),
    fechaProduccion: str(r.fecha_produccion),
    fechaVencimiento: str(r.fecha_vencimiento),
    placa: str(r.placa),
    fotoUrl: str(r.foto_url),
    estado: str(r.estado),
    observaciones: str(r.observaciones),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
  }
}

function mapAtencion(r: Record<string, unknown>): RegistroAtencion {
  return {
    id: r.id as string,
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    solicitante: str(r.solicitante),
    area: str(r.area),
    tipo: str(r.tipo),
    asunto: str(r.asunto),
    detalle: str(r.detalle),
    estado: str(r.estado),
    atendidoEn: str(r.atendido_en),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
  }
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN — API
// ═══════════════════════════════════════════════════════════════════

export type FiltrosRecepcion = {
  busqueda?: string
  estado?: string // '' = todos
  limit?: number
  offset?: number
}

export async function listarRecepciones(
  filtros: FiltrosRecepcion = {}
): Promise<{ filas: RegistroRecepcion[]; total: number }> {
  const { busqueda = '', estado = '', limit = 50, offset = 0 } = filtros
  let q = dataClient
    .from('recepcion_registros')
    .select('*', { count: 'exact' })
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
  if (estado) q = q.eq('estado', estado)
  const b = busqueda.trim()
  if (b) {
    const like = `%${b}%`
    q = q.or(`proveedor.ilike.${like},codigo.ilike.${like},numero_documento.ilike.${like},descripcion.ilike.${like}`)
  }
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return { filas: (data ?? []).map(mapRecepcion), total: count ?? (data ?? []).length }
}

/**
 * Registra UNA recepción de N artículos: cada artículo se guarda como su
 * propia fila (compatible con búsqueda por código, actividad y listado)
 * compartiendo el encabezado del documento (guía, proveedor, placa, foto).
 */
export async function crearRecepciones(
  items: NuevoRecepcion[],
  usuario: UsuarioCtx
): Promise<void> {
  if (items.length === 0) return
  const filas = items.map((datos) => ({
    fecha: datos.fecha,
    tipo_documento: datos.tipoDocumento,
    numero_documento: datos.numeroDocumento.trim(),
    proveedor: datos.proveedor.trim(),
    codigo: datos.codigo.trim().toUpperCase(),
    descripcion: datos.descripcion.trim(),
    cantidad: datos.cantidad,
    unidad_medida: (datos.unidadMedida ?? '').trim().toUpperCase(),
    lote: (datos.lote ?? '').trim(),
    fecha_produccion: datos.fechaProduccion?.trim() || null,
    fecha_vencimiento: datos.fechaVencimiento?.trim() || null,
    placa: (datos.placa ?? '').trim().toUpperCase(),
    foto_url: datos.fotoUrl?.trim() || null,
    observaciones: datos.observaciones.trim() || null,
    estado: 'Pendiente',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  }))
  const { error } = await dataClient.from('recepcion_registros').insert(filas)
  if (error) throw error
}

/**
 * Sube la foto de la guía al bucket `recepcion-guias` y devuelve su URL
 * pública. Ruta por usuario + timestamp para evitar colisiones.
 *
 * Usa fetch directo al Storage API (probado en producción): el cliente
 * storage.upload() de supabase-js devolvía 400 en este entorno.
 */
export async function subirFotoGuia(archivo: Blob, usuarioId: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ?? ''
  const ruta = `${usuarioId}/${Date.now()}.jpg`
  const res = await fetch(`${base}/storage/v1/object/recepcion-guias/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'image/jpeg',
      'x-upsert': 'false',
    },
    body: archivo,
  })
  if (!res.ok) {
    const detalle = await res.text().catch(() => '')
    throw new Error(`Storage ${res.status}: ${detalle.slice(0, 140)}`)
  }
  return `${base}/storage/v1/object/public/recepcion-guias/${ruta}`
}

export async function cambiarEstadoRecepcion(id: string, estado: string): Promise<void> {
  const { error } = await dataClient
    .from('recepcion_registros')
    .update({ estado })
    .eq('id', id)
  if (error) throw error
}

export async function eliminarRecepcion(id: string): Promise<void> {
  const { error } = await dataClient.from('recepcion_registros').delete().eq('id', id)
  if (error) throw error
}

// ═══════════════════════════════════════════════════════════════════
// ATENCIÓN — API
// ═══════════════════════════════════════════════════════════════════

export type FiltrosAtencion = {
  busqueda?: string
  estado?: string // '' = todos
  limit?: number
  offset?: number
}

export async function listarAtenciones(
  filtros: FiltrosAtencion = {}
): Promise<{ filas: RegistroAtencion[]; total: number }> {
  const { busqueda = '', estado = '', limit = 50, offset = 0 } = filtros
  let q = dataClient
    .from('atencion_registros')
    .select('*', { count: 'exact' })
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
  if (estado) q = q.eq('estado', estado)
  const b = busqueda.trim()
  if (b) {
    const like = `%${b}%`
    q = q.or(`solicitante.ilike.${like},area.ilike.${like},asunto.ilike.${like},tipo.ilike.${like}`)
  }
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return { filas: (data ?? []).map(mapAtencion), total: count ?? (data ?? []).length }
}

export async function crearAtencion(datos: NuevoAtencion, usuario: UsuarioCtx): Promise<void> {
  const { error } = await dataClient.from('atencion_registros').insert({
    fecha: datos.fecha,
    solicitante: datos.solicitante.trim(),
    area: datos.area.trim(),
    tipo: datos.tipo,
    asunto: datos.asunto.trim(),
    detalle: datos.detalle.trim() || null,
    estado: 'Pendiente',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  })
  if (error) throw error
}

export async function cambiarEstadoAtencion(id: string, estado: string): Promise<void> {
  // Al pasar a 'Atendido' se sella la hora de cierre; al retroceder se limpia.
  const patch: Record<string, unknown> = { estado }
  if (estado === 'Atendido') patch.atendido_en = new Date().toISOString()
  else patch.atendido_en = null
  const { error } = await dataClient
    .from('atencion_registros')
    .update(patch)
    .eq('id', id)
  if (error) throw error
}

export async function eliminarAtencion(id: string): Promise<void> {
  const { error } = await dataClient.from('atencion_registros').delete().eq('id', id)
  if (error) throw error
}

// ═══════════════════════════════════════════════════════════════════
// ACTIVIDAD TRANSVERSAL (módulo Usuarios → conecta todos los módulos)
// Solo lectura. Unifica en una fila común los movimientos de cada módulo.
// ═══════════════════════════════════════════════════════════════════

export type ModuloActividad = 'racks' | 'piso' | 'recepcion' | 'atencion'

export const ETIQUETA_MODULO: Record<ModuloActividad, string> = {
  racks: 'Racks',
  piso: 'Piso',
  recepcion: 'Recepción',
  atencion: 'Atención',
}

export type FilaActividad = {
  id: string
  fecha: string // fecha principal (date o timestamp ISO)
  tipo: string
  titulo: string // código / asunto / documento / operación
  detalle: string
  cantidad: number | null
  estado: string | null
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export async function listarActividad(
  modulo: ModuloActividad,
  usuarioId: string | null, // null = todos los usuarios
  limit = 100,
  offset = 0
): Promise<{ filas: FilaActividad[]; total: number }> {
  if (modulo === 'racks') {
    let q = dataClient
      .from('movimientos')
      .select('id, f_modificacion, tipo, codigo, descripcion, cantidad, lote, usuario_id, usuario_nombre, usuario_correo', { count: 'exact' })
      .order('f_modificacion', { ascending: false })
    if (usuarioId) q = q.eq('usuario_id', usuarioId)
    q = q.range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw error
    return {
      filas: (data ?? []).map((r) => ({
        id: r.id as string,
        fecha: str(r.f_modificacion),
        tipo: str(r.tipo),
        titulo: str(r.codigo),
        detalle: str(r.descripcion) + (r.lote ? ` · Lote ${str(r.lote)}` : ''),
        cantidad: toNum(r.cantidad),
        estado: null,
        usuarioId: str(r.usuario_id),
        usuarioNombre: str(r.usuario_nombre),
        usuarioCorreo: str(r.usuario_correo),
      })),
      total: count ?? 0,
    }
  }

  if (modulo === 'piso') {
    let q = dataClient
      .from('piso_movimientos')
      .select('id, numero_operacion, tipo, fecha, usuario_id, usuario_nombre, usuario_correo', { count: 'exact' })
      .order('numero_operacion', { ascending: false })
    if (usuarioId) q = q.eq('usuario_id', usuarioId)
    q = q.range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw error
    return {
      filas: (data ?? []).map((r) => ({
        id: r.id as string,
        fecha: str(r.fecha),
        tipo: str(r.tipo),
        titulo: `Operación #${str(r.numero_operacion)}`,
        detalle: '',
        cantidad: null,
        estado: null,
        usuarioId: str(r.usuario_id),
        usuarioNombre: str(r.usuario_nombre),
        usuarioCorreo: str(r.usuario_correo),
      })),
      total: count ?? 0,
    }
  }

  const tabla = modulo === 'recepcion' ? 'recepcion_registros' : 'atencion_registros'
  const cols =
    modulo === 'recepcion'
      ? 'id, created_at, fecha, tipo_documento, numero_documento, proveedor, codigo, descripcion, cantidad, estado, usuario_id, usuario_nombre, usuario_correo'
      : 'id, created_at, fecha, solicitante, area, tipo, asunto, detalle, estado, usuario_id, usuario_nombre, usuario_correo'
  let q = dataClient
    .from(tabla)
    .select(cols, { count: 'exact' })
    .order('created_at', { ascending: false })
  if (usuarioId) q = q.eq('usuario_id', usuarioId)
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return {
    filas: (data ?? []).map((r: Record<string, unknown>) =>
      modulo === 'recepcion'
        ? {
            id: str(r.id),
            fecha: str(r.fecha) || str(r.created_at),
            tipo: 'Recepción',
            titulo: str(r.numero_documento) || '(sin documento)',
            detalle: [str(r.proveedor), str(r.codigo), str(r.descripcion)].filter(Boolean).join(' · '),
            cantidad: toNum(r.cantidad),
            estado: str(r.estado),
            usuarioId: str(r.usuario_id),
            usuarioNombre: str(r.usuario_nombre),
            usuarioCorreo: str(r.usuario_correo),
          }
        : {
            id: str(r.id),
            fecha: str(r.fecha) || str(r.created_at),
            tipo: str(r.tipo),
            titulo: str(r.asunto),
            detalle: [str(r.solicitante), str(r.area)].filter(Boolean).join(' · '),
            cantidad: null,
            estado: str(r.estado),
            usuarioId: str(r.usuario_id),
            usuarioNombre: str(r.usuario_nombre),
            usuarioCorreo: str(r.usuario_correo),
          }
    ),
    total: count ?? 0,
  }
}
