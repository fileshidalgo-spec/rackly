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
import { exigirActualizadas, exigirBorradas, avisarBorradoFiltrado } from '@/lib/rackly/eliminacion-honesta'

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
  /** Turno T1/T2 del RAL — elegido por el registrador (pedido 2026-11-12).
   *  '' en históricos anteriores a la columna. */
  turno: string
  fotoUrl: string
  notas: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  /** Modelo de atención UNIFICADO con la RQ (2026-10-30): 'Pendiente' |
   *  'En proceso' | 'Atendido' — lo mantienen las RPC ral_atender_item /
   *  ral_revertir_item con la MISMA regla canónica de la RQ (Task 26):
   *  Atendido = nada pendiente · En proceso = hay algo atendido ·
   *  Pendiente = nada atendido. */
  estado: string
  /** Cantidad de materiales (rellenada por listarRals con los items). */
  articulos: number
  /** «codigo descripcion» de cada material concatenado — lo rellena
   *  listarRals para que la búsqueda de la lista incluya MATERIALES
   *  (bug 2026-10-29: buscar por código de material daba 0 resultados
   *  porque solo se buscaba en columnas del encabezado). Vacío fuera de
   *  listarRals; el filtro compara en minúsculas. */
  textoItems: string
  /** Auditoría de ediciones (2026-11-12, paridad con la RQ): más reciente
   *  primero, máx 20 — la llena la RPC ral_editar. */
  ediciones: RalEdicionLog[]
}

/** Entrada del historial de ediciones del RAL (columna rals.ediciones). */
export type RalEdicionLog = {
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

export type RalItem = {
  id: string
  ralId: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: number
  /** Atención (misma forma que rq_atencion_items — lista unificada). */
  cantidadAtendida: number
  usuarioAtencion: string
  atendidoEn: string
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
  /** Turno T1/T2 elegido por el registrador (pedido 2026-11-12). */
  turno?: string
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
    turno: String(f.turno ?? ''),
    fotoUrl: String(f.foto_url ?? ''),
    notas: String(f.notas ?? ''),
    usuarioId: String(f.usuario_id ?? ''),
    usuarioNombre: String(f.usuario_nombre ?? ''),
    usuarioCorreo: String(f.usuario_correo ?? ''),
    estado: String(f.estado ?? '') || 'Pendiente',
    articulos: 0, // lo rellena listarRals con los items reales
    textoItems: '', // ídem (código+descripción de los items, para búsqueda)
    ediciones: Array.isArray(f.ediciones)
      ? (f.ediciones as unknown[]).map(filaARalEdicion)
      : [],
  }
}

function filaARalEdicion(v: unknown): RalEdicionLog {
  const r = (v ?? {}) as Record<string, unknown>
  const res = (r.resumen ?? {}) as Record<string, unknown>
  return {
    en: String(r.en ?? ''),
    usuarioId: String(r.usuario_id ?? ''),
    usuarioNombre: String(r.usuario_nombre ?? ''),
    usuarioCorreo: String(r.usuario_correo ?? ''),
    resumen: {
      encabezado: Number(res.encabezado ?? 0),
      materialesEditados: Number(res.materiales_editados ?? 0),
      materialesAgregados: Number(res.materiales_agregados ?? 0),
      materialesQuitados: Number(res.materiales_quitados ?? 0),
    },
    cambios: Array.isArray(r.cambios) ? (r.cambios as Record<string, unknown>[]) : [],
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
    cantidadAtendida: Number(f.cantidad_atendida ?? 0),
    usuarioAtencion: String(f.usuario_atencion ?? ''),
    atendidoEn: String(f.atendido_en ?? ''),
  }
}

// ═══════════════════════════════════════════════════════════════════
// LISTADO
// ═══════════════════════════════════════════════════════════════════

/**
 * Recalcula el estado del encabezado según sus materiales (respaldo RPC).
 * Misma regla canónica v9 de recalcularEstadoRq (rq-atencion.ts).
 */
async function recalcularEstadoRal(ralId: string): Promise<void> {
  const { data: items, error: eItems } = await dataClient
    .from('ral_items')
    .select('cantidad, cantidad_atendida')
    .eq('ral_id', ralId)
  if (eItems) throw eItems
  const filas = (items ?? []) as Record<string, unknown>[]
  const pendientes = filas.filter(
    (f) => Number(f.cantidad_atendida ?? 0) < Number(f.cantidad ?? 0)
  ).length
  const algunoAtendido = filas.some((f) => Number(f.cantidad_atendida ?? 0) > 0)
  const estado =
    filas.length === 0
      ? 'Pendiente'
      : pendientes === 0
        ? 'Atendido'
        : algunoAtendido
          ? 'En proceso'
          : 'Pendiente'
  // HONESTIDAD (auditoría 2026-11-01): 0 filas de vuelta = RLS filtró el
  // UPDATE en silencio — el RAL quedaba con estado viejo tras atender
  // (misma clase que el DELETE filtrado del bug T173-00004281).
  const { data, error: eEstado } = await dataClient
    .from('rals')
    .update({ estado })
    .eq('id', ralId)
    .select('id')
  if (eEstado) throw eEstado
  exigirActualizadas(
    data,
    1,
    'El estado del RAL NO se actualizó (tu rol no permite editarlo). Recarga y verifica el estado real.'
  )
}

/**
 * Lista los RALs más recientes con su conteo de materiales y el TEXTO de
 * búsqueda por materiales. Dos lecturas (headers + items) y agrupado en el
 * cliente: volumen pequeño (documentos registrados por jornada), evita una
 * vista SQL extra en la BD. La lista unificada RQ+RAL carga TODOS los RAL
 * (300) para filtrarlos en cliente — sin paginación ni huecos de búsqueda.
 */
export async function listarRals(limite = 300): Promise<RalRegistro[]> {
  const { data: headers, error: eH } = await dataClient
    .from('rals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limite)
  if (eH) throw eH
  const rals = (headers ?? []).map(filaARal)
  if (rals.length === 0) return []

  const ids = rals.map((r) => r.id)
  // FIX auditoría 2026-11-12: paginar el .in() — con ~300 RALs el resultado
  // puede superar max_rows (1000) y los conteos/textos quedaban truncados.
  const items: FilaRal[] = []
  for (let from = 0; ; from += 1000) {
    const { data: pag, error: eP } = await dataClient
      .from('ral_items')
      .select('ral_id, codigo, descripcion')
      .in('ral_id', ids)
      .range(from, from + 999)
    if (eP) throw eP
    if (!pag || pag.length === 0) break
    items.push(...(pag as FilaRal[]))
    if (pag.length < 1000) break
  }
  const conteo = new Map<string, number>()
  const textos = new Map<string, string[]>()
  for (const it of items ?? []) {
    const k = String((it as FilaRal).ral_id ?? '')
    conteo.set(k, (conteo.get(k) ?? 0) + 1)
    const codigo = String((it as FilaRal).codigo ?? '').trim()
    const descripcion = String((it as FilaRal).descripcion ?? '').trim()
    if (codigo || descripcion) {
      const arr = textos.get(k) ?? []
      arr.push(`${codigo} ${descripcion}`.trim())
      textos.set(k, arr)
    }
  }
  for (const r of rals) {
    r.articulos = conteo.get(r.id) ?? 0
    r.textoItems = (textos.get(r.id) ?? []).join(' ')
  }
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
      turno: datos.turno ?? '',
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
    turno: datos.turno ?? '',
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
      // y completará): best-effort, espejo del patrón RQ. BEST-EFFORT: no
      // lanza (enmascararía eI); si la RLS filtró el delete queda cabecera
      // huérfana hasta el reintento — aviso en consola.
      const { data: borrada } = await dataClient
        .from('rals')
        .delete()
        .eq('id', id)
        .select('id')
      avisarBorradoFiltrado(borrada, 1, 'ral.registrarRal.rollback')
      throw eI
    }
  }
  return id
}

/**
 * Elimina el RAL. El header PRIMERO: valida RLS de eliminación
 * (supervisores) en el primer delete; los items caen por CASCADE.
 * HONESTIDAD (patrón T173-00004281, auditoría 2026-10-31): la RLS filtra
 * el DELETE por rol EN SILENCIO (HTTP 200, 0 filas) — un operario veía
 * «RAL eliminado» y el RAL seguía vivo. Se pide la fila de vuelta.
 */
export async function eliminarRal(id: string): Promise<void> {
  const { data: borrada, error } = await dataClient
    .from('rals')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  exigirBorradas(
    borrada,
    1,
    'El RAL NO se eliminó (tu rol no permite borrar, o ya fue eliminado por otro usuario). Recarga la lista.'
  )
}

// ═══════════════════════════════════════════════════════════════════
// ATENCIÓN (modelo unificado con la RQ — espejo de rq-atencion.ts)
// ═══════════════════════════════════════════════════════════════════

/**
 * Registra cantidad atendida de un material del RAL. RPC atómica
 * ral_atender_item (espejo rq_atender_item v8): suma, sella atendido_en al
 * completar y recalcula el estado del encabezado en UNA transacción — dos
 * celulares atendiendo a la vez nunca corrompen el estado.
 *
 * Sin tomas/ledger: el RAL no tiene modelo lote/posición (materiales
 * generales de almacén), a diferencia de la RQ.
 *
 * Sobreatención permitida (igual que la RQ v2): puede ser más, nunca menos.
 */
export async function atenderItemRal(
  itemId: string,
  cantidad: number,
  usuarioNombre: string
): Promise<RalItem> {
  const { data, error } = await dataClient.rpc('ral_atender_item', {
    p_item_id: itemId,
    p_cantidad: cantidad,
    p_usuario: usuarioNombre,
  })
  if (!error && data) return filaARalItem(data as FilaRal)

  // Respaldo (RPC no disponible): lectura → suma con guard optimista
  const razon = error?.message ?? ''
  if (/excede|mayor que cero|no encontrado|NO_AUTORIZADO/i.test(razon)) throw new Error(razon)
  const { data: previo, error: ePrevio } = await dataClient
    .from('ral_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle()
  if (ePrevio) throw ePrevio
  if (!previo) throw new Error('Artículo no encontrado')
  const itemPrevio = filaARalItem(previo as FilaRal)
  if (cantidad <= 0) throw new Error('La cantidad a atender debe ser mayor que cero')
  const nuevo = itemPrevio.cantidadAtendida + cantidad
  const { data: upd, error: eUpd } = await dataClient
    .from('ral_items')
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
  await recalcularEstadoRal(itemPrevio.ralId)
  return filaARalItem(upd as FilaRal)
}

/** Revierte una atención equivocada del RAL (devuelve la cantidad al pendiente). */
export async function revertirItemRal(itemId: string, cantidad: number): Promise<RalItem> {
  const { data, error } = await dataClient.rpc('ral_revertir_item', {
    p_item_id: itemId,
    p_cantidad: cantidad,
  })
  if (!error && data) return filaARalItem(data as FilaRal)

  const razon = error?.message ?? ''
  if (/mayor que cero|no encontrado|NO_AUTORIZADO/i.test(razon)) throw new Error(razon)
  const { data: previo, error: ePrevio } = await dataClient
    .from('ral_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle()
  if (ePrevio) throw ePrevio
  if (!previo) throw new Error('Artículo no encontrado')
  const itemPrevio = filaARalItem(previo as FilaRal)
  const nuevo = Math.max(itemPrevio.cantidadAtendida - cantidad, 0)
  const { data: upd, error: eUpd } = await dataClient
    .from('ral_items')
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
  await recalcularEstadoRal(itemPrevio.ralId)
  return filaARalItem(upd as FilaRal)
}

// ═══════════════════════════════════════════════════════════════════
// EDICIÓN SUPERVISADA (2026-11-12 — paridad con la RQ, Task 26)
// ═══════════════════════════════════════════════════════════════════

/**
 * RAL existentes con ESTE documento (máx 5, excluye un id). Espejo de
 * buscarRqPorNumero (DB1, 2026-11-12): la idempotencia por `id` de
 * ral_crear_completa NO cubre el mismo `documento` con id distinto — caso
 * REAL detectado en auditoría (RAL 8455 registrado ×2 a 46 segundos por el
 * mismo usuario). Sin constraint UNIQUE a propósito: la verificación es
 * una ADVERTENCIA en la UI, no un bloqueo duro.
 */
export async function buscarRalPorDocumento(
  documento: string,
  excluirId?: string
): Promise<RalRegistro[]> {
  const d = documento.trim()
  if (!d) return []
  const { data, error } = await dataClient
    .from('rals')
    .select('*')
    .eq('documento', d)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  return ((data ?? []) as FilaRal[])
    .map(filaARal)
    .filter((r) => r.id !== excluirId)
}

/** Material de una edición del RAL: CON id = actualizar · SIN id = agregar.
 *  Los materiales que faltan en la lista se ELIMINAN (solo si no tienen
 *  atención registrada — lo valida la RPC ral_editar y validarEdicionRal). */
export type ItemEditarRal = {
  id?: string
  orden: number
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: number
}

/** Campos del encabezado corregibles (parcial: solo los presentes).
 *  turno: T1/T2 elegido por el registrador (pedido 2026-11-12). */
export type EncabezadoEditarRal = Partial<{
  documento: string
  transaccion: string
  areaSolicitante: string
  solicitante: string
  aprobadoPor: string
  almacen: string
  linea: string
  turno: string
  notas: string
  fecha: string
}>

export type ResultadoEdicionRal = { ral: RalRegistro; items: RalItem[]; cambios: number }

function fmtNumRal(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

/**
 * Valida la edición de un RAL con las MISMAS reglas que la RPC ral_editar
 * (espejo del cliente para feedback inmediato en el diálogo). Devuelve la
 * lista de problemas; [] = la edición es válida.
 */
export function validarEdicionRal(items: ItemEditarRal[], actuales: RalItem[]): string[] {
  const errores: string[] = []
  if (items.length === 0) {
    return ['El RAL debe conservar al menos un material. Si ya no sirve, usa Eliminar RAL.']
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
      errores.push(`El material ${codigo} ya no existe en el RAL: recarga la pantalla e inténtalo de nuevo.`)
      continue
    }
    if (it.cantidad !== previo.cantidad && it.cantidad < previo.cantidadAtendida) {
      errores.push(
        `${previo.codigo}: pides ${fmtNumRal(it.cantidad)} pero ya se atendieron ${fmtNumRal(previo.cantidadAtendida)} — primero revierte su atención.`
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
        `${a.codigo}: tiene ${fmtNumRal(a.cantidadAtendida)} atendidos — revierte su atención antes de quitarlo del RAL.`
      )
    }
  }
  return errores
}

/** Payload PURO de la RPC ral_editar (testeable con esbuild+node). */
export function payloadRpcEditarRal(
  ralId: string,
  encabezado: EncabezadoEditarRal,
  items: ItemEditarRal[],
  usuario: UsuarioCtx
): {
  p_ral_id: string
  p_encabezado: Record<string, string>
  p_items: Record<string, unknown>[]
  p_usuario_id: string | null
  p_usuario_nombre: string
  p_usuario_correo: string
} {
  // Encabezado: solo los campos presentes (la RPC compara y aplica).
  const p_encabezado: Record<string, string> = {}
  const CAMPOS: Array<[keyof EncabezadoEditarRal, string]> = [
    ['documento', 'documento'],
    ['transaccion', 'transaccion'],
    ['areaSolicitante', 'area_solicitante'],
    ['solicitante', 'solicitante'],
    ['aprobadoPor', 'aprobado_por'],
    ['almacen', 'almacen'],
    ['linea', 'linea'],
    ['turno', 'turno'],
    ['notas', 'notas'],
    ['fecha', 'fecha'],
  ]
  for (const [k, col] of CAMPOS) {
    if (encabezado[k] !== undefined) p_encabezado[col] = String(encabezado[k] ?? '')
  }
  return {
    p_ral_id: ralId,
    p_encabezado,
    p_items: items.map((it, i) => ({
      orden: Number.isInteger(it.orden) ? it.orden : i,
      ...(it.id?.trim() ? { id: it.id.trim() } : {}),
      codigo: it.codigo.trim().toUpperCase(),
      descripcion: it.descripcion.trim(),
      unidad: it.unidad.trim(),
      centro_costos: it.centroCostos.trim(),
      cantidad: it.cantidad,
    })),
    p_usuario_id: usuario.id?.trim() || null,
    p_usuario_nombre: usuario.nombre || '',
    p_usuario_correo: usuario.correo || '',
  }
}

/**
 * Edita el RAL (encabezado + diff declarativo de materiales) en UNA
 * transacción en la BD: RPC ral_editar (paridad rq_editar_rq).
 *
 * Integridad física (la RPC rechaza con mensaje claro):
 *   · cantidad CAMBIADA a < cantidad_atendida     → CANTIDAD_MENOR_ATENDIDA
 *   · código/unidad de un material con atención   → ITEM_CON_ATENCION
 *     (el CENTRO DE COSTOS sí es editable siempre: metadata de costos)
 *   · eliminar material con atención registrada   → ITEM_CON_ATENCION
 *
 * Sin respaldo cliente A PROPOSITO (diferencia con crearRal): la migración
 * se aplica a producción ANTES de desplegar el frontend; simular el diff
 * en el cliente escribiría en varias peticiones sin transacción.
 */
export async function editarRal(
  ralId: string,
  encabezado: EncabezadoEditarRal,
  items: ItemEditarRal[],
  usuario: UsuarioCtx
): Promise<ResultadoEdicionRal> {
  const p = payloadRpcEditarRal(ralId, encabezado, items, usuario)
  const { data, error } = await dataClient.rpc('ral_editar', p)
  if (!error && data) {
    const r = data as Record<string, unknown>
    return {
      ral: filaARal((r.ral ?? {}) as FilaRal),
      items: ((r.items ?? []) as Record<string, unknown>[]).map(filaARalItem),
      cambios: Number(r.cambios ?? 0),
    }
  }
  const msg = error?.message ?? ''
  if (/pgrst20[24]|not found|does not exist|schema cache/i.test(msg)) {
    throw new Error(
      'La edición de RAL aún no está disponible en esta conexión: recarga la pestaña (F5) e inténtalo de nuevo.'
    )
  }
  throw error ?? new Error('Error desconocido al editar el RAL')
}
