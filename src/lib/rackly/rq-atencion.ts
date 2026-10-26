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
  /** Auditoría de ediciones (Task 26): más reciente primero, máx 20. */
  ediciones: RqEdicionLog[]
}

/** Entrada del historial de ediciones (columna rq_atenciones.ediciones). */
export type RqEdicionLog = {
  en: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  resumen: {
    encabezado: number
    materialesEditados: number
    materialesAgregados: number
    materialesQuitados: number
  }
  cambios: Record<string, unknown>[]
}

/** Material de una edición: CON id = actualizar · SIN id = agregar.
 *  Los materiales que faltan en la lista se ELIMINAN (solo si no tienen
 *  atención registrada — la valida la RPC y validarEdicionRq). */
export type ItemEditarRq = {
  id?: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  cantidad: number
}

/** Campos del encabezado corregibles (parcial: solo los presentes). */
export type EncabezadoEditarRq = Partial<{
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  linea: string
  solicitante: string
  notas: string
  fecha: string
  turno: string
}>

export type ResultadoEdicionRq = { rq: RqAtencion; items: RqItem[]; cambios: number }

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
    ediciones: Array.isArray(r.ediciones)
      ? (r.ediciones as unknown[]).map(mapEdicion)
      : [],
  }
}

function mapEdicion(v: unknown): RqEdicionLog {
  const r = (v ?? {}) as Record<string, unknown>
  const res = (r.resumen ?? {}) as Record<string, unknown>
  return {
    en: str(r.en),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
    resumen: {
      encabezado: toNum(res.encabezado),
      materialesEditados: toNum(res.materiales_editados),
      materialesAgregados: toNum(res.materiales_agregados),
      materialesQuitados: toNum(res.materiales_quitados),
    },
    cambios: Array.isArray(r.cambios) ? (r.cambios as Record<string, unknown>[]) : [],
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
  const algunoAtendido = filas.some((f) => toNum(f.cantidad_atendida) > 0)
  // v2 (Task 26): regla CANÓNICA unificada con las RPCs (atender/revertir/
  // editar): Atendido = nada pendiente · En proceso = hay algo atendido ·
  // Pendiente = nada atendido. Antes 'pendientes === filas.length' dejaba
  // 'Pendiente' una RQ con atención parcial.
  const estado =
    filas.length === 0 ? 'Pendiente' : pendientes === 0 ? 'Atendido' : algunoAtendido ? 'En proceso' : 'Pendiente'
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
// EDICIÓN SUPERVISADA (Task 26 — el supervisor corrige líneas erradas)
// ═══════════════════════════════════════════════════════════════════

/**
 * Valida la edición de una RQ con las MISMAS reglas que la RPC
 * rq_editar_rq (una sola fuente de verdad en la BD; esto es el espejo
 * para feedback inmediato en el diálogo y para el no-op del guardado).
 * Devuelve la lista de problemas; [] = la edición es válida.
 */
export function validarEdicionRq(
  items: ItemEditarRq[],
  actuales: RqItem[]
): string[] {
  const errores: string[] = []
  if (items.length === 0) {
    return ['La RQ debe conservar al menos un material. Si ya no sirve, usa Eliminar RQ.']
  }
  const ids = new Set<string>()
  for (const it of items) {
    const id = (it.id ?? '').trim()
    const codigo = it.codigo.trim().toUpperCase()
    if (id) {
      if (ids.has(id)) errores.push(`El material ${codigo || id} viene dos veces en la edición.`)
      ids.add(id)
    }
    if (!codigo) errores.push('Hay materiales sin código: completa o elimina esa fila.')
    else if (!(it.cantidad > 0)) {
      errores.push(`La cantidad de ${codigo} debe ser mayor que cero.`)
    }
    if (!id) continue // material nuevo: no tiene atención registrada
    const previo = actuales.find((a) => a.id === id)
    if (!previo) {
      errores.push(`El material ${codigo} ya no existe en la RQ: recarga la pantalla e inténtalo de nuevo.`)
      continue
    }
    if (it.cantidad < previo.cantidadAtendida) {
      errores.push(
        `${previo.codigo}: pides ${fmtNum(it.cantidad)} pero ya se atendieron ${fmtNum(previo.cantidadAtendida)} — primero revierte su atención.`
      )
    }
    if (
      previo.cantidadAtendida > 0 &&
      (codigo !== previo.codigo.trim().toUpperCase() || it.unidad.trim() !== previo.unidad.trim())
    ) {
      errores.push(
        `${previo.codigo}: con atención registrada no se puede cambiar el código ni la unidad (revierte primero).`
      )
    }
  }
  for (const a of actuales) {
    if (!ids.has(a.id) && a.cantidadAtendida > 0) {
      errores.push(
        `${a.codigo}: tiene ${fmtNum(a.cantidadAtendida)} atendidos — revierte su atención antes de quitarlo de la RQ.`
      )
    }
  }
  return errores
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

/** Payload PURO de la RPC rq_editar_rq (testeable con esbuild+node). */
export function payloadRpcEditarRq(
  rqId: string,
  encabezado: EncabezadoEditarRq,
  items: ItemEditarRq[],
  usuario: UsuarioCtx
): {
  p_rq_id: string
  p_encabezado: Record<string, string>
  p_items: Record<string, unknown>[]
  p_usuario_id: string | null
  p_usuario_nombre: string
  p_usuario_correo: string
} {
  // Encabezado: solo los campos presentes (la RPC compara y aplica).
  const p_encabezado: Record<string, string> = {}
  const CAMPOS: Array<[keyof EncabezadoEditarRq, string]> = [
    ['numeroRq', 'numero_rq'],
    ['ordenProduccion', 'orden_produccion'],
    ['productoCodigo', 'producto_codigo'],
    ['productoDescripcion', 'producto_descripcion'],
    ['linea', 'linea'],
    ['solicitante', 'solicitante'],
    ['notas', 'notas'],
    ['fecha', 'fecha'],
    ['turno', 'turno'],
  ]
  for (const [k, col] of CAMPOS) {
    if (encabezado[k] !== undefined) p_encabezado[col] = String(encabezado[k] ?? '')
  }
  return {
    p_rq_id: rqId,
    p_encabezado,
    p_items: items.map((it, i) => ({
      // el orden canónico lo manda el índice del arreglo (el UI muestra en ese orden)
      orden: Number.isInteger(it.orden) ? it.orden : i,
      ...(it.id?.trim() ? { id: it.id.trim() } : {}),
      codigo: it.codigo.trim().toUpperCase(),
      descripcion: it.descripcion.trim(),
      unidad: it.unidad.trim(),
      cantidad: it.cantidad,
    })),
    p_usuario_id: usuario.id?.trim() || null,
    p_usuario_nombre: usuario.nombre || '',
    p_usuario_correo: usuario.correo || '',
  }
}

/**
 * Edita la RQ (encabezado + diff declarativo de materiales) en UNA
 * transacción en la BD: RPC rq_editar_rq.
 *
 * Integridad física (la RPC rechaza con mensaje claro):
 *   · cantidad nueva < cantidad_atendida          → CANTIDAD_MENOR_ATENDIDA
 *   · código/unidad de un material con atención   → ITEM_CON_ATENCION
 *   · eliminar material con atención registrada   → ITEM_CON_ATENCION
 *
 * Sin respaldo cliente A PROPOSITO (diferencia con crearRq): la migración
 * SQL se aplica a producción ANTES de desplegar este frontend, así que no
 * existe ventana real sin RPC; simular el diff en el cliente escribiría en
 * varias peticiones sin transacción (peor que fallar claro). Si la RPC no
 * estuviera disponible, el mensaje pide actualizar la pestaña.
 */
export async function editarRq(
  rqId: string,
  encabezado: EncabezadoEditarRq,
  items: ItemEditarRq[],
  usuario: UsuarioCtx
): Promise<ResultadoEdicionRq> {
  const p = payloadRpcEditarRq(rqId, encabezado, items, usuario)
  const { data, error } = await dataClient.rpc('rq_editar_rq', p)
  if (!error && data) {
    const r = data as Record<string, unknown>
    return {
      rq: mapRq((r.rq ?? {}) as Record<string, unknown>),
      items: ((r.items ?? []) as Record<string, unknown>[]).map(mapItem),
      cambios: toNum(r.cambios),
    }
  }
  const msg = error?.message ?? ''
  if (/pgrst20[24]|not found|does not exist|schema cache/i.test(msg)) {
    throw new Error(
      'La edición de RQ aún no está disponible en esta conexión: recarga la pestaña (F5) e inténtalo de nuevo.'
    )
  }
  throw error ?? new Error('Error desconocido al editar la RQ')
}

// ═══════════════════════════════════════════════════════════════════
// TOMAS DE ATENCIÓN (Task 27 — ledger rq_atencion_tomas)
// ═══════════════════════════════════════════════════════════════════

/**
 * Posición de una salida que se registra como atención de la RQ.
 * La usan las rutas de salida de Racks/Piso (RqSalidaConfirmador) para dejar
 * en el ledger DESDE DÓNDE salió el material.
 */
export type TomaUbicacion = {
  /** Etiqueta legible de la posición (mismo formato que el app). */
  ubicacion: string
  cantidad: number
  /** racks | piso (transito/manual los decide la RPC). */
  origen?: 'racks' | 'piso'
}

/** Fila del ledger de tomas (rq_atencion_tomas). */
export type TomaLedger = {
  id: string
  origen: string
  /** Positivo = salida · Negativo = reversa. */
  cantidad: number
  ubicacion: string
  /** Saldo de la posición TRAS la toma (exacto en ruta racks del puente). */
  saldoResultante: number | null
  usuarioNombre: string
  fecha: string
  lote: string
}

/** Agrupación por posición para la vista «Revisar». */
export type RevisionPosicion = {
  ubicacion: string
  origen: 'racks' | 'piso'
  /** Neto sacado de ESTA posición para esta RQ (reversas descontadas). */
  sacado: number
  /** Saldo que quedó AL MOMENTO de la última toma (si la BD lo reportó). */
  saldoAlMomento: number | null
  /** Saldo HOY en esa posición (lookup de stock actual; null = sin dato). */
  saldoActual: number | null
  /** Toma(s) crono de esta posición (incluye sus reversas). */
  tomas: TomaLedger[]
  usuarios: string[]
  ultimaFecha: string
}

/** Resultado de «Revisar» un material: desde dónde se atendió y saldos. */
export type RevisionAtencion = {
  posiciones: RevisionPosicion[]
  /** Descontado de guías en tránsito (puente QR). */
  desdeTransito: { sacado: number; tomas: TomaLedger[] } | null
  /** Atención digitada (botón Atender) sin posición registrada + sus reversas. */
  manualSinPosicion: { sacado: number; tomas: TomaLedger[] } | null
  /** Total revertido (absoluto) en el ledger. */
  totalRevertido: number
  /** Suma de salidas NETAS con posición conocida (racks+piso). */
  coberturaConPosicion: number
}

/** Lista el ledger de tomas de un material (cronológico). */
export async function listarTomasDeItem(itemId: string): Promise<TomaLedger[]> {
  if (!itemId.trim()) return []
  const { data, error } = await dataClient
    .from('rq_atencion_tomas')
    .select('*')
    .eq('item_id', itemId)
    .order('creado_en', { ascending: true })
    .limit(500)
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id ?? ''),
    origen: str(r.origen),
    cantidad: toNum(r.cantidad),
    ubicacion: str(r.ubicacion),
    saldoResultante: r.saldo_resultante === null || r.saldo_resultante === undefined ? null : toNum(r.saldo_resultante),
    usuarioNombre: str(r.usuario_nombre),
    fecha: str(r.creado_en),
    lote: str(r.lote),
  }))
}

/**
 * Agregación PURA del ledger → vista «Revisar» (testeable sin red).
 * Agrupa tomas por posición (racks/piso), separa tránsito y manual, y
 * conecta el saldo ACTUAL de cada posición desde los mapas de stock.
 */
export function agregarRevision(
  tomas: TomaLedger[],
  saldoRacks: Map<string, number>,
  saldoPiso: Map<string, number>
): RevisionAtencion {
  const porPosicion = new Map<string, RevisionPosicion>()
  const transito: TomaLedger[] = []
  const manual: TomaLedger[] = []
  let totalRevertido = 0
  let cobertura = 0

  for (const t of tomas) {
    if (t.origen === 'reversa') totalRevertido += Math.abs(t.cantidad)
    if (t.origen === 'transito') {
      transito.push(t)
      continue
    }
    const conPosicion = (t.origen === 'racks' || t.origen === 'piso') && t.ubicacion.trim() !== ''
    if (conPosicion) {
      const previa = porPosicion.get(t.ubicacion)
      if (previa) {
        previa.sacado += t.cantidad
        if (t.cantidad > 0) cobertura += t.cantidad
        previa.tomas.push(t)
        if (t.saldoResultante !== null) previa.saldoAlMomento = t.saldoResultante
        if (t.usuarioNombre && !previa.usuarios.includes(t.usuarioNombre)) previa.usuarios.push(t.usuarioNombre)
        if (t.fecha > previa.ultimaFecha) previa.ultimaFecha = t.fecha
      } else {
        if (t.cantidad > 0) cobertura += t.cantidad
        porPosicion.set(t.ubicacion, {
          ubicacion: t.ubicacion,
          origen: t.origen === 'piso' ? 'piso' : 'racks',
          sacado: t.cantidad,
          saldoAlMomento: t.saldoResultante,
          saldoActual:
            t.origen === 'racks'
              ? (saldoRacks.get(t.ubicacion) ?? 0)
              : saldoPiso.has(t.ubicacion)
                ? Number(saldoPiso.get(t.ubicacion))
                : null,
          tomas: [t],
          usuarios: t.usuarioNombre ? [t.usuarioNombre] : [],
          ultimaFecha: t.fecha,
        })
      }
      continue
    }
    // Manual sin posición + reversas sin posición (revertir simple).
    manual.push(t)
  }

  return {
    posiciones: [...porPosicion.values()].sort(
      (a, b) => b.sacado - a.sacado || a.ubicacion.localeCompare(b.ubicacion)
    ),
    desdeTransito:
      transito.length > 0
        ? { sacado: transito.reduce((s, t) => s + t.cantidad, 0), tomas: transito }
        : null,
    manualSinPosicion:
      manual.length > 0
        ? { sacado: manual.reduce((s, t) => s + t.cantidad, 0), tomas: manual }
        : null,
    totalRevertido,
    coberturaConPosicion: cobertura,
  }
}

/**
 * «Revisar» un material (Task 27): desde qué posiciones se atendió y el saldo
 * de cada una. Combina el LEDGER (rq_atencion_tomas) con el stock ACTUAL de
 * Racks/Piso (solo lectura, mismos lectores que «Ver ubicación»).
 */
export async function revisarAtencionItem(
  item: Pick<RqItem, 'id' | 'codigo' | 'unidad' | 'cantidad' | 'cantidadAtendida'>
): Promise<RevisionAtencion> {
  const [tomas, stockRacks, stockPiso] = await Promise.all([
    listarTomasDeItem(item.id),
    import('@/lib/rackly/kardex')
      .then((m) => m.fetchStockPorCodigoRPC(item.codigo, false))
      .catch(() => null),
    import('@/lib/piso/api')
      .then((m) => m.stockPisoBuscar(item.codigo))
      .catch(() => []),
  ])

  // Mapas de saldo ACTUAL por posición (mismas etiquetas que el ledger).
  const saldoRacks = new Map<string, number>()
  for (const r of stockRacks ?? []) {
    saldoRacks.set(`B${r.bloque}·T${r.torre}·P${r.piso}·Pos${r.posicion}`, r.stock)
  }
  const saldoPiso = new Map<string, string>()
  for (const p of stockPiso ?? []) {
    if (p.ubicacion) saldoPiso.set(p.ubicacion, String(p.cantidad))
  }

  return agregarRevision(
    tomas,
    saldoRacks,
    new Map<string, number>([...saldoPiso].map(([k, v]) => [k, Number(v)]))
  )
}

// ═══════════════════════════════════════════════════════════════════
// ATENDER / REVERTIR (RPC atómica + respaldo optimista)
// ═══════════════════════════════════════════════════════════════════

/**
 * Payload PURO de p_toma para la RPC rq_atender_item (testeable con esbuild+node).
 * Normaliza el origen y recorta la ubicación; null = sin posiciones (la RPC
 * registra una toma 'manual').
 */
export function payloadRpcTomas(
  tomas?: TomaUbicacion[]
): Record<string, unknown>[] | null {
  if (!tomas || tomas.length === 0) return null
  return tomas.map((t) => ({
    origen: t.origen ?? 'manual',
    ubicacion: t.ubicacion.trim(),
    cantidad: t.cantidad,
  }))
}

/**
 * Registra cantidad atendida de un material. RPC atómica: valida el tope,
 * suma y recalcula el estado del encabezado en UNA transacción en la BD
 * (dos celulares atendiendo a la vez nunca sobrepasan lo pendiente).
 *
 * `tomas` (Task 27): posiciones desde donde salió físicamente el material
 * (rutas de salida de Racks/Piso con contexto RQ). La RPC las valida (la
 * suma debe ser la cantidad) y las deja en el ledger rq_atencion_tomas;
 * sin tomas registra una toma 'manual' para trazabilidad de quién atendió.
 */
export async function atenderItemRq(
  itemId: string,
  cantidad: number,
  usuarioNombre: string,
  tomas?: TomaUbicacion[]
): Promise<RqItem> {
  const args: Record<string, unknown> = {
    p_item_id: itemId,
    p_cantidad: cantidad,
    p_usuario: usuarioNombre,
  }
  const pToma = payloadRpcTomas(tomas)
  if (pToma) args.p_toma = pToma
  const { data, error } = await dataClient.rpc('rq_atender_item', args)
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
