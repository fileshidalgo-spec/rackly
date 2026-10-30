'use client'

import { dataClient } from '@/lib/supabase/client'
import { QUERY_TIMEOUT_MS } from '@/lib/rackly/constants'
import { isLoteUnsupportedError } from '@/lib/rackly/kardex'
import { exigirBorradas, avisarBorradoFiltrado } from '@/lib/rackly/eliminacion-honesta'

/** Genera un UUID v4 simple (no requiere crypto.randomUUID que no está en todos los browsers) */
function generateUuidSync(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Elimina cabeceras huérfanas (sin detalles) para un set de IDs.
 *  Usado como rollback cuando la inserción de detalles falla.
 *  BEST-EFFORT (no lanza — enmascararía el error original): si la RLS
 *  filtra el delete queda cabecera huérfana hasta el reintento — aviso. */
async function rollbackCabeceras(ids: string[], tag: string): Promise<void> {
  for (const id of ids) {
    await dataClient
      .from('piso_movimientos')
      .delete()
      .eq('id', id)
      .select('id')
      .then(({ data }) => avisarBorradoFiltrado(data, 1, tag))
      .catch((rbErr) => {
        console.error(`[${tag}] rollback de cabecera ${id} falló:`, rbErr)
      })
  }
}

/** Normaliza el lote físico digitado: TRIM; vacío => no viaja (queda NULL en BD). */
function loteLimpio(lote?: string | null): string {
  return (lote || '').trim()
}

/** Construye las filas de piso_movimiento_detalles para un movimiento ya creado.
 *  Incluye `lote` SOLO en las filas que lo traen (como fecha_vencimiento):
 *  un ingreso multilínea puede llevar lotes distintos por artículo. */
function buildDetRows(
  movimientoId: string,
  detalles: DetalleInput[]
): { rows: Record<string, unknown>[]; tieneLote: boolean } {
  let tieneLote = false
  const rows = detalles.map((d) => {
    const lote = loteLimpio(d.lote)
    if (lote) tieneLote = true
    return {
      movimiento_id: movimientoId,
      nivel_id: d.nivel_id,
      bloque_id: d.bloque_id,
      cantidad: d.cantidad,
      ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
      ...(lote ? { lote } : {}),
    }
  })
  return { rows, tieneLote }
}

/** Inserta filas en piso_movimiento_detalles; si la columna `lote` aún no existe
 *  en la BD (migración 20260915_piso_detalles_lote.sql pendiente), reintenta SIN
 *  lote para que el movimiento NUNCA falle por el campo nuevo (mismo patrón
 *  defensivo que kardex.ts en Racks). El insert es atómico (todo-o-nada), por lo
 *  que el reintento no duplica filas. */
async function insertDetallesPiso(
  rows: Record<string, unknown>[],
  tieneLote: boolean,
  tag: string
): Promise<void> {
  if (rows.length === 0) return
  const { error } = await dataClient.from('piso_movimiento_detalles').insert(rows)
  if (error && tieneLote && isLoteUnsupportedError(error)) {
    console.warn(`[${tag}] Columna lote no existe aún — insertando SIN lote. Ejecutar 20260915_piso_detalles_lote.sql.`)
    const sinLote = rows.map((r) => { const { lote: _omit, ...rest } = r; return rest })
    const retry = await dataClient.from('piso_movimiento_detalles').insert(sinLote)
    if (retry.error) throw retry.error
    return
  }
  if (error) throw error
}

/** Limpia el prefijo del sector del código de subcolumna.
 *  BD guarda "BA1" (prefijo "B" + letra "A" + idx "1"), queremos solo "A1" */
function cleanSubcolCode(codigo: string, columnaLetra: string): string {
  const idx = codigo.indexOf(columnaLetra)
  return idx >= 0 ? codigo.substring(idx) : codigo
}

// ═══ Lógica FEFO genérica (deduplicada de stockDetallePosicion, stockDetalleNivel, stockPisoGlobal) ═══

type FefoInputEntry = {
  bloque_id: string
  tipo: string
  cantidad: number
  fecha_vencimiento: string
  extra?: Record<string, string>
}

type FefoResult = {
  bloque_id: string
  cantidad: number
  fecha_vencimiento: string
  extra?: Record<string, string>
}

/** Calcula FEFO (First Expired First Out) a partir de un pool de detalles.
 *  Agrupa ingresos por (bloque_id, fecha_vencimiento), suma salidas por bloque_id,
 *  descuenta salidas del pool ordenado por fecha, y retorna los lotes restantes.
 *  Si se pasa `groupKeyFn`, agrupa por esa clave en vez de solo `bloque_id`. */
function calcularFEFO(
  entries: FefoInputEntry[],
  groupKeyFn?: (e: FefoInputEntry) => string
): FefoResult[] {
  const isIngresoType = (tipo: string) =>
    tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion'

  const getKey = groupKeyFn ?? ((e: FefoInputEntry) => e.bloque_id)

  // Pool de lotes por ingreso (agrupado por clave)
  const ingresoPools = new Map<string, Map<string, { qty: number; extra?: Record<string, string> }>>()
  for (const e of entries) {
    if (!isIngresoType(e.tipo) || e.cantidad <= 0) continue
    const key = getKey(e)
    const pool = ingresoPools.get(key) ?? new Map()
    const existing = pool.get(e.fecha_vencimiento)
    if (existing) {
      existing.qty += e.cantidad
      // Merge extra fields (e.g., codigo_inc)
      if (e.extra && !existing.extra) existing.extra = { ...e.extra }
    } else {
      pool.set(e.fecha_vencimiento, { qty: e.cantidad, extra: e.extra ? { ...e.extra } : undefined })
    }
    ingresoPools.set(key, pool)
  }

  // Sumar salidas por clave
  const salidasPorKey = new Map<string, number>()
  for (const e of entries) {
    if (isIngresoType(e.tipo) || e.cantidad <= 0) continue
    const key = getKey(e)
    salidasPorKey.set(key, (salidasPorKey.get(key) ?? 0) + e.cantidad)
  }

  // FEFO: descontar salidas del pool
  const results: FefoResult[] = []
  for (const [key, pool] of ingresoPools) {
    const sortedLots = [...pool.entries()].sort(([a], [b]) => {
      if (!a && b) return 1
      if (a && !b) return -1
      return a.localeCompare(b)
    })
    const totalSalida = salidasPorKey.get(key) ?? 0
    let pendiente = totalSalida
    for (const [fecha, lot] of sortedLots) {
      if (pendiente <= 0) {
        results.push({ bloque_id: entries.find(e => getKey(e) === key)?.bloque_id ?? key, cantidad: lot.qty, fecha_vencimiento: fecha, extra: lot.extra })
      } else if (lot.qty <= pendiente) {
        pendiente -= lot.qty
      } else {
        results.push({ bloque_id: entries.find(e => getKey(e) === key)?.bloque_id ?? key, cantidad: lot.qty - pendiente, fecha_vencimiento: fecha, extra: lot.extra })
        pendiente = 0
      }
    }
  }

  return results.filter(r => r.cantidad > 0)
}

export type Sector = {
  id: string
  nombre: string
  prefijo: string
  n_columnas: number
  n_subcolumnas: number
  n_posiciones: number
  n_niveles: number
  created_at: string
}

export type Columna = {
  id: string
  letra: string
  sector_id: string
}

export type Subcolumna = {
  id: string
  codigo: string
  columna_id: string
}

export type Posicion = {
  id: string
  numero: number
  subcolumna_id: string
}

export type Nivel = {
  id: string
  numero: number
  posicion_id: string
  codigo_ubicacion: string | null
}

export type PisoMovimiento = {
  id: string
  numero_operacion: number
  tipo: string
  fecha: string
  turno: string
  usuario_id: string | null
  usuario_nombre: string | null
  usuario_correo: string | null
  uuid_sync?: string | null
}

export type MovimientoDetalle = {
  id: string
  movimiento_id: string
  nivel_id: string
  bloque_id: string
  cantidad: number
  fecha_vencimiento?: string | null
  /** Código de lote FÍSICO digitado en ingresos/devoluciones (trazabilidad, informativo). */
  lote?: string | null
}

export type MovimientoConDetalles = PisoMovimiento & {
  detalles: (MovimientoDetalle & {
    bloque_codigo?: string
    nivel_codigo?: string
    sector_nombre?: string
    posicion_label?: string
  })[]
}

export type DetalleInput = {
  nivel_id: string
  bloque_id: string
  cantidad: number
  fecha_vencimiento?: string | null
  /** Código de lote FÍSICO digitado (ej: AP-304501210021). Informativo: no afecta
   *  stock ni FEFO. Se persiste en piso_movimiento_detalles.lote (NULL si vacío). */
  lote?: string | null
}

// ---- Sector CRUD ----
export async function listarSectores(): Promise<Sector[]> {
  const { data, error } = await dataClient
    .from('piso_sectores')
    .select('*')
    .order('nombre')
  if (error) throw error
  return (data ?? []) as Sector[]
}

export async function crearSector(
  nombre: string,
  prefijo: string,
  n_columnas: number,
  n_subcolumnas: number,
  n_posiciones: number,
  n_niveles: number
): Promise<Sector[]> {
  const { error } = await dataClient.from('piso_sectores').insert({
    nombre,
    prefijo,
    n_columnas,
    n_subcolumnas,
    n_posiciones,
    n_niveles,
  })
  if (error) throw error
  return listarSectores()
}

export async function eliminarSector(id: string): Promise<Sector[]> {
  // HONESTIDAD (patrón T173-00004281, auditoría 2026-10-31): RLS por rol
  // filtra el delete en silencio — se verifica el efecto real.
  const { data: borrado, error } = await dataClient
    .from('piso_sectores')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  exigirBorradas(
    borrado,
    1,
    'El sector NO se eliminó (tu rol no permite borrar, o ya fue eliminado por otro usuario). Recarga la lista.'
  )
  return listarSectores()
}

// ---- Structure queries ----
export async function listarColumnas(
  sectorId: string
): Promise<Columna[]> {
  const { data, error } = await dataClient
    .from('piso_columnas')
    .select('*')
    .eq('sector_id', sectorId)
    .order('letra')
  if (error) throw error
  return (data ?? []) as Columna[]
}

export async function listarSubcolumnas(
  columnaId: string
): Promise<Subcolumna[]> {
  const { data, error } = await dataClient
    .from('piso_subcolumnas')
    .select('*')
    .eq('columna_id', columnaId)
    .order('codigo')
  if (error) throw error
  return (data ?? []) as Subcolumna[]
}

export async function listarNivelesDeSubcolumna(
  subcolumnaId: string
): Promise<{ posicion: Posicion; niveles: Nivel[] }[]> {
  const { data: posData, error: posErr } = await dataClient
    .from('piso_posiciones')
    .select('*')
    .eq('subcolumna_id', subcolumnaId)
    .order('numero')
  if (posErr) throw posErr

  const posiciones = (posData ?? []) as Posicion[]
  if (posiciones.length === 0) return []

  const posIds = posiciones.map((p) => p.id)
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('*')
    .in('posicion_id', posIds)
    .order('numero')
  if (nivErr) throw nivErr

  const niveles = (nivData ?? []) as Nivel[]

  return posiciones.map((pos) => ({
    posicion: pos,
    niveles: niveles.filter((n) => n.posicion_id === pos.id),
  }))
}

// ═══ Bloques — FUENTE ÚNICA DE VERDAD: catálogo de Racks ═══
// Desde la unificación del catálogo (Task 15), `catalogo` es la ÚNICA fuente de
// descripción/unidad. `piso_bloques` queda como ANCLA TÉCNICA: existe para dar
// UUID a la FK piso_movimiento_detalles.bloque_id (historial inmutable) y solo
// aporta datos propios para códigos históricos que ya NO están en catálogo.

export type InfoBloque = { codigo: string; descripcion: string; unidad: string }

/**
 * PURO (testeable) — Fusiona anclas de piso, catálogo de Racks y respaldo
 * histórico en un mapa id → info. Reglas:
 *  1. El CÓDIGO del id: ancla real → su fila en piso_bloques; `cat_X`/`manual_X` → X.
 *  2. descripcion/unidad: SIEMPRE del catálogo si el código existe ahí.
 *  3. Respaldo: fila de piso_bloques (códigos históricos fuera de catálogo).
 *  4. `manual_X` sin ningún registro → "Articulo nuevo (manual)" + KG.
 *  5. Sin código resoluble → el id queda fuera del mapa (el llamador lo omite).
 */
export function fusionarInfoBloques(
  ids: string[],
  anclas: { id: string; codigo: string }[],
  catFilas: { codigo: string; descripcion: string; un: string }[],
  pisoFilas: { codigo: string; descripcion: string; unidad: string }[]
): Map<string, InfoBloque> {
  const anclaPorId = new Map(anclas.map((a) => [a.id, a.codigo]))
  const catPorCodigo = new Map(
    catFilas.map((c) => [c.codigo.trim().toUpperCase(), c])
  )
  const pisoPorCodigo = new Map(
    pisoFilas.map((p) => [p.codigo.trim().toUpperCase(), p])
  )

  const info = new Map<string, InfoBloque>()
  for (const id of ids) {
    const codigo = (
      id.startsWith('cat_') || id.startsWith('manual_')
        ? id.slice(id.indexOf('_') + 1)
        : anclaPorId.get(id)
    )?.trim().toUpperCase()
    if (!codigo) continue

    const cat = catPorCodigo.get(codigo)
    if (cat) {
      info.set(id, { codigo, descripcion: cat.descripcion ?? '', unidad: cat.un ?? '' })
      continue
    }
    const piso = pisoPorCodigo.get(codigo)
    if (piso) {
      info.set(id, { codigo, descripcion: piso.descripcion ?? '', unidad: piso.unidad ?? '' })
      continue
    }
    if (id.startsWith('manual_')) {
      info.set(id, { codigo, descripcion: 'Articulo nuevo (manual)', unidad: 'KG' })
    }
    // id real sin fila de catálogo ni piso y no-manual: no debería pasar
    // (la ancla existe) — se omite igual que antes para no inventar datos.
  }
  return info
}

/**
 * Resuelve id (UUID real, `cat_<codigo>` o `manual_<codigo>`) → info de artículo
 * con el CATÁLOGO DE RACKS como fuente de verdad. piso_bloques solo aporta el
 * mapeo id→codigo de las anclas y datos de respaldo para códigos históricos.
 */
export async function resolverInfoBloques(
  ids: string[]
): Promise<Map<string, InfoBloque>> {
  const limpios = [...new Set(ids.filter(Boolean))]
  if (limpios.length === 0) return new Map()

  const reales = limpios.filter((id) => !id.startsWith('cat_') && !id.startsWith('manual_'))
  const anclas: { id: string; codigo: string }[] = []
  if (reales.length > 0) {
    for (let i = 0; i < reales.length; i += 500) {
      const { data, error } = await dataClient
        .from('piso_bloques')
        .select('id, codigo')
        .in('id', reales.slice(i, i + 500))
      if (error) throw error
      for (const b of (data ?? []) as { id: string; codigo: string }[]) anclas.push(b)
    }
  }

  // Códigos a consultar en catálogo: los de las anclas + los virtuales
  const codigos = new Set<string>(
    anclas.map((a) => a.codigo.trim().toUpperCase())
  )
  for (const id of limpios) {
    if (id.startsWith('cat_') || id.startsWith('manual_')) {
      const c = id.slice(id.indexOf('_') + 1).trim().toUpperCase()
      if (c) codigos.add(c)
    }
  }

  const catFilas: { codigo: string; descripcion: string; un: string }[] = []
  const listaCodigos = [...codigos]
  if (listaCodigos.length > 0) {
    for (let i = 0; i < listaCodigos.length; i += 500) {
      const { data, error } = await dataClient
        .from('catalogo')
        .select('codigo, descripcion, un')
        .in('codigo', listaCodigos.slice(i, i + 500))
      if (error) throw error
      for (const c of (data ?? []) as { codigo: string; descripcion: string; un: string }[]) catFilas.push(c)
    }
  }

  // Respaldo histórico: códigos que el catálogo no conoce → piso_bloques
  const enCat = new Set(catFilas.map((c) => c.codigo.trim().toUpperCase()))
  const faltantes = listaCodigos.filter((c) => !enCat.has(c))
  const pisoFilas: { codigo: string; descripcion: string; unidad: string }[] = []
  if (faltantes.length > 0) {
    for (let i = 0; i < faltantes.length; i += 500) {
      const { data, error } = await dataClient
        .from('piso_bloques')
        .select('codigo, descripcion, unidad')
        .in('codigo', faltantes.slice(i, i + 500))
      if (error) throw error
      for (const p of (data ?? []) as { codigo: string; descripcion: string; unidad: string }[]) pisoFilas.push(p)
    }
  }

  return fusionarInfoBloques(limpios, anclas, catFilas, pisoFilas)
}

/**
 * Garantiza que exista la fila-ancla en piso_bloques para un código y devuelve
 * su id (único propósito de la tabla desde la unificación del catálogo).
 * Tolerante a carrera: si el insert falla por duplicado, reconsulta.
 */
async function asegurarAnclaPiso(codigo: string): Promise<{ id: string }> {
  const target = codigo.trim().toUpperCase()
  const { data: existing } = await dataClient
    .from('piso_bloques')
    .select('id')
    .eq('codigo', target)
    .limit(1)
  if (existing && existing.length > 0) return { id: (existing[0] as { id: string }).id }
  const { data: ins, error } = await dataClient
    .from('piso_bloques')
    .insert({ codigo: target })
    .select('id')
    .single()
  if (ins) return { id: (ins as { id: string }).id }
  if (error) {
    // Carrera: otro usuario creó el ancla a la vez — reconsultar
    const { data: recheck } = await dataClient
      .from('piso_bloques')
      .select('id')
      .eq('codigo', target)
      .limit(1)
    if (recheck && recheck.length > 0) return { id: (recheck[0] as { id: string }).id }
    throw error
  }
  throw new Error('No se pudo crear el ancla del artículo en piso')
}

/**
 * Crea (o resuelve) el ancla de piso para un código. Fuente de verdad = catálogo:
 *  - Si el código existe en catálogo → devuelve la info DEL CATÁLOGO y garantiza
 *    el ancla en piso_bloques (sin duplicar descripciones divergentes).
 *  - Si NO existe (artículo manual de INC/muestras) → crea el ancla con lo digitado.
 * Devuelve el bloque resuelto (id REAL del ancla, necesario para la FK) o null.
 */
export async function crearBloque(
  codigo: string,
  descripcion: string,
  unidad: string
): Promise<InfoBloque & { id: string } | null> {
  const upper = codigo.trim().toUpperCase()
  if (!upper) return null

  // 1) El catálogo manda: si existe, usar SUS datos (evita drift en el ancla)
  const resuelto = await buscarBloquePorCodigo(upper)
  if (resuelto) return resuelto

  // 2) Artículo nuevo (fuera de catálogo): crear ancla con lo digitado
  const desc = (descripcion || '').trim()
  const un = (unidad || 'KG').trim() || 'KG'
  const { error } = await dataClient.from('piso_bloques').insert({
    codigo: upper,
    descripcion: desc,
    unidad: un,
  })
  if (!error) {
    const ancla = await asegurarAnclaPiso(upper)
    return { id: ancla.id, codigo: upper, descripcion: desc, unidad: un }
  }

  // 3) Carrera (otro usuario lo creó a la vez): reconsultar
  const retry = await buscarBloquePorCodigo(upper)
  if (retry) return retry
  throw error
}

/**
 * Poda el ancla de piso de un código SOLO si no tiene movimientos históricos
 * (FK-safe: si tiene historial, se conserva — protege la trazabilidad).
 * Silencioso por diseño: al borrar un código del catálogo el ancla es basura
 * residual, pero si está atada a historia NO debe tocarse.
 */
export async function podarAnclaPisoSiSinUso(codigo: string): Promise<void> {
  const target = codigo.trim().toUpperCase()
  if (!target) return
  const { data: bloque, error: errBusqueda } = await dataClient
    .from('piso_bloques')
    .select('id')
    .eq('codigo', target)
    .maybeSingle()
  if (errBusqueda) throw errBusqueda
  if (!bloque) return
  const bloqueId = (bloque as { id: string }).id
  // Sin asignaciones de columna (tabla heredada, hoy vacía) ni movimientos
  await dataClient.from('piso_columna_bloques').delete().eq('bloque_id', bloqueId)
  const { data: borrado, error } = await dataClient
    .from('piso_bloques')
    .delete()
    .eq('id', bloqueId)
    .select('id')
  if (error && (error as { code?: string }).code === '23503') {
    // Tiene movimientos históricos: conservar (ancla legítima del historial)
    return
  }
  if (error) throw error
  // Poda interna best-effort: si la RLS filtró, el ancla queda — inofensivo.
  avisarBorradoFiltrado(borrado, 1, 'piso.podarAnclaPisoSiSinUso')
}

// ---- Movements ----
export async function registrarMovimiento(
  tipo: string,
  turno: string,
  detalles: DetalleInput[]
): Promise<PisoMovimiento> {
  const { data, error } = await dataClient.rpc('piso_registrar_movimiento', {
    _tipo: tipo,
    _turno: turno,
    _detalles: detalles,
  })
  if (error) throw error
  if (!data || (data as unknown[]).length === 0) {
    throw new Error('La RPC piso_registrar_movimiento no devolvió resultado')
  }
  const result = data as unknown[]
  return result[0] as PisoMovimiento
}

export async function eliminarMovimiento(movimientoId: string): Promise<void> {
  // First delete details, then the movement header
  const { error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .delete()
    .eq('movimiento_id', movimientoId)
  if (detErr) throw detErr
  // HONESTIDAD (auditoría 2026-10-31): RLS por rol puede filtrar el delete
  // del header en silencio — se pide la fila de vuelta y se verifica.
  const { data: borrado, error: movErr } = await dataClient
    .from('piso_movimientos')
    .delete()
    .eq('id', movimientoId)
    .select('id')
  if (movErr) throw movErr
  exigirBorradas(
    borrado,
    1,
    'El movimiento de piso NO se eliminó (tu rol no permite borrar, o ya fue eliminado por otro usuario). Recarga la lista.'
  )
}

/**
 * Elimina un movimiento y, si es MITAD de un traslado (comparte uuid_sync con
 * otra cabecera), elimina el PAR COMPLETO. Borrar solo la salida o solo el
 * ingreso dejaba el stock inconsistente (ingreso sin su salida o viceversa).
 * Devuelve cuántas cabeceras se eliminaron (1 normal, 2 traslado).
 */
export async function eliminarMovimientoConPar(movimientoId: string): Promise<number> {
  const { data: mov, error: errMov } = await dataClient
    .from('piso_movimientos')
    .select('id, uuid_sync')
    .eq('id', movimientoId)
    .maybeSingle()
  if (errMov) throw errMov
  if (!mov) return 0
  const uuidSync = (mov as { uuid_sync?: string | null }).uuid_sync
  let idsAEliminar = [movimientoId]
  if (uuidSync) {
    const { data: hermanos, error: errHer } = await dataClient
      .from('piso_movimientos')
      .select('id')
      .eq('uuid_sync', uuidSync)
    if (errHer) throw errHer
    const ids = (hermanos ?? []).map((h: { id: string }) => h.id)
    if (ids.length > 1) idsAEliminar = ids // traslado: salida + ingreso
  }
  const { data: borradas, error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .delete()
    .in('movimiento_id', idsAEliminar)
    .select('id')
  if (detErr) throw detErr
  const { data: borradasMov, error: movErr } = await dataClient
    .from('piso_movimientos')
    .delete()
    .in('id', idsAEliminar)
    .select('id')
  if (movErr) throw movErr
  // HONESTIDAD (auditoría 2026-10-31): devolver lo REALMENTE eliminado —
  // si la RLS filtró el delete del header (0 filas), NO reportar éxito.
  exigirBorradas(
    borradasMov,
    1,
    'El movimiento NO se eliminó (tu rol no permite borrar movimientos de piso). Pide la eliminación a un supervisor/administrador.'
  )
  return (borradasMov ?? []).length
}

/**
 * Select con filtro .in() por lotes de IDs. Una URL con miles de UUIDs puede
 * exceder límites del proxy (4xx) y PostgREST trunca a max_rows silenciosamente:
 * trocear garantiza resultados completos y error visible.
 * Exportado: loadHistorial de PisoSectoresTab lo usa para sus consultas por IDs.
 */
export async function selectIn<T>(
  table: string,
  select: string,
  idColumn: string,
  ids: string[],
  CHUNK = 500
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await dataClient
      .from(table)
      .select(select)
      .in(idColumn, ids.slice(i, i + CHUNK))
    if (error) throw error
    out.push(...((data ?? []) as T[]))
  }
  return out
}

export async function listarMovimientos(
  sectorId?: string,
  columnaId?: string,
  bloqueId?: string,
  desde?: string,
  hasta?: string
): Promise<MovimientoConDetalles[]> {
  // ── Pre-filtrado server-side: resolver nivel_ids relevantes ──
  // Si se filtra por bloqueId, encontrar los nivel_ids que tienen detalles con ese bloque
  let filterNivelIds: string[] | null = null
  if (bloqueId) {
    const { data: detFilter } = await dataClient
      .from('piso_movimiento_detalles')
      .select('movimiento_id')
      .eq('bloque_id', bloqueId)
    if (detFilter && detFilter.length > 0) {
      const movIds = [...new Set((detFilter as { movimiento_id: string }[]).map(d => d.movimiento_id))]
      filterNivelIds = movIds // Usamos movIds como filtro (se reasigna abajo)
    } else {
      return []
    }
  }

  // Construir query base con filtros de fecha
  let query = dataClient
    .from('piso_movimientos')
    .select('*')
    .order('fecha', { ascending: false })
    .order('numero_operacion', { ascending: false })

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta + 'T23:59:59')

  // Paginación con límite razonable (máx 25,000 cabeceras — FIX auditoría
  // 2026-10-21: 5,000 truncaba silenciosamente la lista y los contadores
  // animados cuando la tabla creciera; hoy hay ~1,600)
  const PAGE_SIZE = 500
  const MAX_PAGES = 50
  let all: PisoMovimiento[] = []
  let from = 0
  let pages = 0
  while (pages++ < MAX_PAGES) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await query.range(from, to)
    if (error) throw error
    const rows = (data ?? []) as PisoMovimiento[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  if (all.length === 0) return []

  // ── Filtro por bloqueId (post-query) ──
  if (bloqueId && filterNivelIds) {
    const filterSet = new Set(filterNivelIds)
    all = all.filter(m => filterSet.has(m.id))
  }

  // ── Filtro por sectorId (sin columnaId): resolver columnas → subcolumnas → posiciones → niveles → detalles ──
  if (sectorId && !columnaId && !bloqueId) {
    const { data: colData, error: colErr } = await dataClient
      .from('piso_columnas')
      .select('id')
      .eq('sector_id', sectorId)
    if (colErr) throw colErr
    if (!colData || colData.length === 0) return []
    const colIds = (colData as { id: string }[]).map(c => c.id)

    const { data: subData, error: subErr } = await dataClient
      .from('piso_subcolumnas')
      .select('id')
      .in('columna_id', colIds)
    if (subErr) throw subErr
    if (!subData || subData.length === 0) return []
    const subIds = new Set((subData as { id: string }[]).map(s => s.id))

    const { data: posData, error: posErr } = await dataClient
      .from('piso_posiciones')
      .select('id')
      .in('subcolumna_id', [...subIds])
    if (posErr) throw posErr
    if (!posData || posData.length === 0) return []
    const posIds = new Set((posData as { id: string }[]).map(p => p.id))

    const { data: nivData, error: nivErr } = await dataClient
      .from('piso_niveles')
      .select('id')
      .in('posicion_id', [...posIds])
    if (nivErr) throw nivErr
    if (!nivData || nivData.length === 0) return []
    const nivIds = (nivData as { id: string }[]).map(n => n.id)

    const { data: detFilter, error: detFilterErr } = await dataClient
      .from('piso_movimiento_detalles')
      .select('movimiento_id')
      .in('nivel_id', nivIds)
    if (detFilterErr) throw detFilterErr
    if (detFilter && detFilter.length > 0) {
      const validMovIds = new Set((detFilter as { movimiento_id: string }[]).map(d => d.movimiento_id))
      all = all.filter(m => validMovIds.has(m.id))
    } else {
      all = []
    }
  }

  // ── Filtro por columnaId: validar pertenencia a sector + resolver posiciones ──
  if (columnaId) {
    // Verificar que columnaId pertenece al sector (si se proporcionó sectorId)
    if (sectorId) {
      const { data: colCheck } = await dataClient
        .from('piso_columnas')
        .select('id')
        .eq('id', columnaId)
        .eq('sector_id', sectorId)
      if (!colCheck || colCheck.length === 0) return []
    }
    // Obtener posiciones de esta columna → niveles → detalles → movimientos
    const { data: subData } = await dataClient
      .from('piso_subcolumnas')
      .select('id')
      .eq('columna_id', columnaId)
    const subIdsOfCol = new Set<string>()
    if (subData) {
      for (const s of subData as { id: string }[]) subIdsOfCol.add(s.id)
    }
    if (subIdsOfCol.size === 0) { return [] }
    const { data: posData } = await dataClient
      .from('piso_posiciones')
      .select('id')
      .in('subcolumna_id', [...subIdsOfCol])
    const posIdsOfCol = new Set<string>()
    if (posData) {
      for (const p of posData as { id: string }[]) posIdsOfCol.add(p.id)
    }
    if (posIdsOfCol.size > 0) {
      const { data: nivData } = await dataClient
        .from('piso_niveles')
        .select('id')
        .in('posicion_id', [...posIdsOfCol])
      if (nivData && nivData.length > 0) {
        const nivIds = (nivData as { id: string }[]).map(n => n.id)
        const { data: detFilter } = await dataClient
          .from('piso_movimiento_detalles')
          .select('movimiento_id')
          .in('nivel_id', nivIds)
        if (detFilter && detFilter.length > 0) {
          const validMovIds = new Set((detFilter as { movimiento_id: string }[]).map(d => d.movimiento_id))
          all = all.filter(m => validMovIds.has(m.id))
        } else {
          all = []
        }
      } else {
        all = []
      }
    } else {
      all = []
    }
  }

  if (all.length === 0) return []

  const movIds = all.map((m) => m.id)
  // Detalles por lotes: con hasta 5000 cabeceras, una única URL .in() podía
  // reventar por longitud o truncarse a max_rows (movimientos sin detalles).
  const detalles = await selectIn<MovimientoDetalle>('piso_movimiento_detalles', '*', 'movimiento_id', movIds)

  const detalleMap = new Map<
    string,
    (MovimientoDetalle & { bloque_codigo?: string; nivel_codigo?: string })[]
  >()
  for (const d of detalles) {
    if (!detalleMap.has(d.movimiento_id)) detalleMap.set(d.movimiento_id, [])
    detalleMap.get(d.movimiento_id)!.push(d)
  }

  const blockIds = [...new Set(detalles.map((d) => d.bloque_id))]
  const nivelIds = [...new Set(detalles.map((d) => d.nivel_id))]

  const [bloquesRows, nivelesRows] = await Promise.all([
    blockIds.length > 0
      ? selectIn<{ id: string; codigo: string }>('piso_bloques', 'id, codigo', 'id', blockIds)
      : Promise.resolve([] as { id: string; codigo: string }[]),
    nivelIds.length > 0
      ? selectIn<{ id: string; codigo_ubicacion: string | null; posicion_id: string }>('piso_niveles', 'id, codigo_ubicacion, posicion_id', 'id', nivelIds)
      : Promise.resolve([] as { id: string; codigo_ubicacion: string | null; posicion_id: string }[]),
  ])

  const bloqueMap = new Map<string, string>()
  bloquesRows.forEach((b) => bloqueMap.set(b.id, b.codigo))
  const nivelMap = new Map<string, string | null>()
  const nivelToPos = new Map<string, string>()
  nivelesRows.forEach((n) => {
    nivelMap.set(n.id, n.codigo_ubicacion)
    nivelToPos.set(n.id, n.posicion_id)
  })

  // Resolve sector and position for each nivel
  const posIds = [...new Set(nivelToPos.values())]
  let sectorPosMap = new Map<string, { sector_nombre: string; posicion_label: string }>()
  if (posIds.length > 0) {
    const posRows = await selectIn<{ id: string; numero: number; subcolumna_id: string }>('piso_posiciones', 'id, numero, subcolumna_id', 'id', posIds)
    const posMap = new Map<string, { numero: number; subcolumna_id: string }>()
    posRows.forEach((p) => posMap.set(p.id, { numero: p.numero, subcolumna_id: p.subcolumna_id }))
    const subIds = [...new Set([...posMap.values()].map((p) => p.subcolumna_id))]
    if (subIds.length > 0) {
      const subRows = await selectIn<{ id: string; codigo: string; columna_id: string }>('piso_subcolumnas', 'id, codigo, columna_id', 'id', subIds)
      const subMap = new Map<string, { codigo: string; columna_id: string }>()
      subRows.forEach((s) => subMap.set(s.id, { codigo: s.codigo, columna_id: s.columna_id }))
      const colIds = [...new Set([...subMap.values()].map((s) => s.columna_id))]
      if (colIds.length > 0) {
        const colRows = await selectIn<{ id: string; letra: string; sector_id: string }>('piso_columnas', 'id, letra, sector_id', 'id', colIds)
        const colMap = new Map<string, { letra: string; sector_id: string }>()
        colRows.forEach((c) => colMap.set(c.id, { letra: c.letra, sector_id: c.sector_id }))
        const sIds = [...new Set([...colMap.values()].map((c) => c.sector_id))]
        if (sIds.length > 0) {
          const secRows = await selectIn<{ id: string; nombre: string; n_columnas: number; n_subcolumnas: number }>('piso_sectores', 'id, nombre, n_columnas, n_subcolumnas', 'id', sIds)
          const secInfoMap = new Map<string, { nombre: string; nCol: number; nSub: number }>()
          secRows.forEach(
            (s) => secInfoMap.set(s.id, { nombre: s.nombre, nCol: s.n_columnas, nSub: s.n_subcolumnas })
          )
          // Build final map: nivel_id -> { sector_nombre, posicion_label }
          for (const [nivId, posId] of nivelToPos) {
            const pos = posMap.get(posId)
            if (!pos) continue
            const sub = subMap.get(pos.subcolumna_id)
            if (!sub) continue
            const col = colMap.get(sub.columna_id)
            if (!col) continue
            const secInfo = secInfoMap.get(col.sector_id)
            const secName = secInfo?.nombre ?? ''
            const label = !secInfo
              ? `${col.letra}-${cleanSubcolCode(sub.codigo, col.letra)}-Pos ${pos.numero}`
              : secInfo.nCol === 1 && secInfo.nSub === 1
                ? `Pos ${pos.numero}`
                : secInfo.nSub === 1
                  ? `${col.letra}-Pos ${pos.numero}`
                  : `${col.letra}-${cleanSubcolCode(sub.codigo, col.letra)}-Pos ${pos.numero}`
            sectorPosMap.set(nivId, {
              sector_nombre: secName,
              posicion_label: label,
            })
          }
        }
      }
    }
  }

  const result = all.map((m) => ({
    ...m,
    detalles: (detalleMap.get(m.id) ?? []).map((d) => {
      const locInfo = sectorPosMap.get(d.nivel_id)
      return {
        ...d,
        bloque_codigo: bloqueMap.get(d.bloque_id),
        nivel_codigo: nivelMap.get(d.nivel_id) ?? undefined,
        sector_nombre: locInfo?.sector_nombre ?? '',
        posicion_label: locInfo?.posicion_label ?? (d.nivel_codigo || ''),
      }
    }),
  }))

  return result
}

export async function calcularStockNivel(
  nivelId: string
): Promise<{ bloque_codigo: string; cantidad: number }[]> {
  const { data, error } = await dataClient
    .from('piso_movimiento_detalles')
    .select(
      'cantidad, bloque_id, movimiento_id, piso_movimientos!inner(tipo)'
    )
    .eq('nivel_id', nivelId)
  if (error) throw error

  const bloquesIds = [
    ...new Set((data ?? []).map((d: Record<string, unknown>) => d.bloque_id as string)),
  ] as string[]
  if (bloquesIds.length === 0) return []

  const bloqueMap = new Map<string, string>()
  // Buscar en piso_bloques (solo IDs reales, no virtuales)
  const realIds = bloquesIds.filter((id) => !id.startsWith('cat_'))
  if (realIds.length > 0) {
    const { data: bloques } = await dataClient
      .from('piso_bloques')
      .select('id, codigo')
      .in('id', realIds)
    ;((bloques ?? []) as { id: string; codigo: string }[]).forEach((b) =>
      bloqueMap.set(b.id, b.codigo)
    )
  }
  // Para IDs virtuales de catálogo, extraer código del ID
  for (const id of bloquesIds) {
    if (id.startsWith('cat_') && !bloqueMap.has(id)) {
      bloqueMap.set(id, id.replace('cat_', ''))
    }
  }

  const stockMap = new Map<string, number>()
  for (const d of data ?? []) {
    const det = d as unknown as {
      cantidad: number
      bloque_id: string
      movimiento_id: string
      piso_movimientos: { tipo: string }
    }
    const bloque = bloqueMap.get(det.bloque_id) ?? det.bloque_id
    const current = stockMap.get(bloque) ?? 0
    stockMap.set(
      bloque,
      current +
        (det.piso_movimientos.tipo === 'ingreso' ||
        det.piso_movimientos.tipo === 'stock_inicial' ||
        det.piso_movimientos.tipo === 'devolucion'
          ? det.cantidad
          : -det.cantidad)
    )
  }

  return Array.from(stockMap.entries())
    .map(([bloque_codigo, cantidad]) => ({ bloque_codigo, cantidad: Math.round(cantidad * 1000) / 1000 }))
    .filter((r) => r.cantidad > 0)
}

// ═══ Piso Sectores Grid — Carga completa de posiciones con stock ═══

export type PosicionConStock = {
  posicionId: string
  posicionNumero: number
  subcolumnaCodigo: string
  columnaLetra: string
  stock: number
  bloques: { bloque_id: string; bloque_codigo: string; cantidad: number }[]
}

/**
 * Obtiene todas las posiciones de un sector con su stock por bloque.
 * Retorna un arreglo plano de posiciones con información de columna y stock.
 * Usa RPC server-side cuando disponible, fallback client-side.
 */
export async function cargarPosicionesSector(
  sectorId: string
): Promise<PosicionConStock[]> {
  // ═══ MÉTODO PRINCIPAL: RPC server-side (JHIA-57b) ═══
  try {
    const { data, error } = await dataClient.rpc('piso_stock_sector_grid', {
      _sector_id: sectorId,
    })
    if (!error && Array.isArray(data) && data.length >= 0) {
      // El RPC retorna posiciones con stock > 0, pero necesitamos TODAS las posiciones (incluidas vacías)
      // 1. Obtener todas las posiciones del sector
      const { data: cols, error: colErr } = await dataClient
        .from('piso_columnas').select('id, letra').eq('sector_id', sectorId).order('letra')
      if (colErr) throw colErr
      const columnas = (cols ?? []) as { id: string; letra: string }[]
      if (columnas.length === 0) return []
      const colMap = new Map(columnas.map((c) => [c.id, c.letra]))

      const { data: subs } = await dataClient
        .from('piso_subcolumnas').select('id, codigo, columna_id').in('columna_id', columnas.map((c) => c.id))
      const subMap = new Map(((subs ?? []) as { id: string; codigo: string; columna_id: string }[]).map((s) => [s.id, s]))

      const { data: posData } = await dataClient
        .from('piso_posiciones').select('id, numero, subcolumna_id').in('subcolumna_id', ((subs ?? []) as { id: string }[]).map((s) => s.id))
      const posiciones = (posData ?? []) as { id: string; numero: number; subcolumna_id: string }[]

      // 2. Mapear resultados del RPC por posicion_id
      const rpcData = data as unknown as {
        posicion_id: string; posicion_numero: number; subcolumna_codigo: string;
        columna_letra: string; stock_total: unknown; bloques_json: unknown;
      }[]
      const rpcStockMap = new Map<string, { stock: number; bloques: { bloque_id: string; bloque_codigo: string; cantidad: number }[] }>()
      for (const r of rpcData) {
        const qty = typeof r.stock_total === 'number' ? r.stock_total : parseFloat(String(r.stock_total ?? '0')) || 0
        let bloques: { bloque_id: string; bloque_codigo: string; cantidad: number }[] = []
        try {
          let rawBloques = r.bloques_json
          // bloques_json puede venir como string JSON o como objeto ya parseado
          if (typeof rawBloques === 'string') {
            try { rawBloques = JSON.parse(rawBloques) } catch { rawBloques = [] }
          }
          const arr = (Array.isArray(rawBloques) ? rawBloques : []) as { bloque_id: string; bloque_codigo: string; cantidad: unknown; stock: unknown }[]
          bloques = arr.map((b) => ({
            bloque_id: b.bloque_id ?? '',
            bloque_codigo: b.bloque_codigo ?? '',
            // El RPC usa 'stock' como clave, el fallback usa 'cantidad'
            cantidad: typeof b.cantidad === 'number' ? b.cantidad
              : typeof b.stock === 'number' ? b.stock
              : parseFloat(String(b.cantidad ?? b.stock ?? '0')) || 0,
          }))
        } catch { /* json parse error */ }
        rpcStockMap.set(r.posicion_id, { stock: qty, bloques })
      }

      // 3. Construir resultado para TODAS las posiciones
      const result: PosicionConStock[] = posiciones.map((pos) => {
        const sub = subMap.get(pos.subcolumna_id)
        const rpcInfo = rpcStockMap.get(pos.id)
        const cLetra = sub ? (colMap.get(sub.columna_id) ?? '') : ''
        return {
          posicionId: pos.id,
          posicionNumero: pos.numero,
          subcolumnaCodigo: sub ? cleanSubcolCode(sub.codigo, cLetra) : '',
          columnaLetra: cLetra,
          stock: rpcInfo?.stock ?? 0,
          bloques: (rpcInfo?.bloques ?? []).filter((b) => b.cantidad > 0),
        }
      })
      return result
    }
  } catch (rpcErr) {
    console.warn('[Piso] RPC piso_stock_sector_grid no disponible, usando fallback:', rpcErr)
  }

  // ═══ FALLBACK: Cálculo client-side ═══
  // 1. Obtener todas las columnas del sector
  const { data: cols, error: colErr } = await dataClient
    .from('piso_columnas')
    .select('id, letra')
    .eq('sector_id', sectorId)
    .order('letra')
  if (colErr) throw colErr
  const columnas = (cols ?? []) as { id: string; letra: string }[]

  if (columnas.length === 0) return []

  const colIds = columnas.map((c) => c.id)

  // 2. Obtener todas las subcolumnas
  const { data: subs, error: subErr } = await dataClient
    .from('piso_subcolumnas')
    .select('id, codigo, columna_id')
    .in('columna_id', colIds)
    .order('codigo')
  if (subErr) throw subErr
  const subcolumnas = (subs ?? []) as { id: string; codigo: string; columna_id: string }[]

  if (subcolumnas.length === 0) return []

  const subIds = subcolumnas.map((s) => s.id)

  // 3. Obtener todas las posiciones
  const { data: posData, error: posErr } = await dataClient
    .from('piso_posiciones')
    .select('id, numero, subcolumna_id')
    .in('subcolumna_id', subIds)
    .order('numero')
  if (posErr) throw posErr
  const posiciones = (posData ?? []) as { id: string; numero: number; subcolumna_id: string }[]

  if (posiciones.length === 0) return []

  // 4. Obtener todos los niveles de las posiciones
  const posIds = posiciones.map((p) => p.id)
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('id, posicion_id')
    .in('posicion_id', posIds)
  if (nivErr) throw nivErr
  const niveles = (nivData ?? []) as { id: string; posicion_id: string }[]

  const nivelIds = niveles.map((n) => n.id)

  // 5. Obtener stock por nivel y bloque
  let stockPorNivel: { nivel_id: string; bloque_id: string; cantidad: number; tipo: string }[] = []
  if (nivelIds.length > 0) {
    const { data: detData, error: detErr } = await dataClient
      .from('piso_movimiento_detalles')
      .select('nivel_id, bloque_id, cantidad, movimiento_id, piso_movimientos(tipo)')
      .in('nivel_id', nivelIds)
    if (detErr) throw detErr

    const stockMap = new Map<string, { bloque_id: string; cantidad: number }[]>()

    for (const d of (detData ?? []) as unknown as {
      nivel_id: string
      bloque_id: string
      cantidad: unknown
      piso_movimientos: { tipo: string }
    }[]) {
      const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
      const delta = (d.piso_movimientos.tipo === 'ingreso' || d.piso_movimientos.tipo === 'stock_inicial' || d.piso_movimientos.tipo === 'devolucion')
        ? qty : -qty
      if (delta === 0) continue

      let arr = stockMap.get(d.nivel_id)
      if (!arr) { arr = []; stockMap.set(d.nivel_id, arr) }
      const existing = arr.find((e) => e.bloque_id === d.bloque_id)
      if (existing) {
        existing.cantidad += delta
      } else {
        arr.push({ bloque_id: d.bloque_id, cantidad: delta })
      }
    }

    // Filtrar solo stock positivo (redondeado a 3 decimales: evita residuos float)
    for (const [nivelId, bloques] of stockMap) {
      for (const b of bloques) {
        const q = Math.round(b.cantidad * 1000) / 1000
        if (q > 0) {
          stockPorNivel.push({ nivel_id: nivelId, bloque_id: b.bloque_id, cantidad: q, tipo: '' })
        }
      }
    }
  }

  // 6. Obtener códigos de bloques
  const bloqueIdsSet = [...new Set(stockPorNivel.map((s) => s.bloque_id))]
  let bloqueMap = new Map<string, string>()
  // Buscar IDs reales en piso_bloques
  const realBloqueIds = bloqueIdsSet.filter((id) => !id.startsWith('cat_'))
  if (realBloqueIds.length > 0) {
    const { data: bloqData } = await dataClient
      .from('piso_bloques')
      .select('id, codigo')
      .in('id', realBloqueIds)
    for (const b of (bloqData ?? []) as { id: string; codigo: string }[]) {
      bloqueMap.set(b.id, b.codigo)
    }
  }
  // Para IDs virtuales, extraer código del formato cat_CODIGO
  for (const id of bloqueIdsSet) {
    if (id.startsWith('cat_')) {
      bloqueMap.set(id, id.replace('cat_', ''))
    }
  }

  // 7. Construir resultado por posición
  const subMap = new Map(subcolumnas.map((s) => [s.id, s]))
  const colMap = new Map(columnas.map((c) => [c.id, c.letra]))

  // Agrupar niveles por posición
  const nivelesPorPosicion = new Map<string, string[]>()
  for (const n of niveles) {
    const arr = nivelesPorPosicion.get(n.posicion_id) ?? []
    arr.push(n.id)
    nivelesPorPosicion.set(n.posicion_id, arr)
  }

  // Agrupar stock por posición
  const stockPorPosicion = new Map<string, { bloque_id: string; bloque_codigo: string; cantidad: number }[]>()
  for (const s of stockPorNivel) {
    // Encontrar la posición de este nivel
    for (const pos of posiciones) {
      const posNivIds = nivelesPorPosicion.get(pos.id) ?? []
      if (posNivIds.includes(s.nivel_id)) {
        const arr = stockPorPosicion.get(pos.id) ?? []
        const existing = arr.find((e) => e.bloque_id === s.bloque_id)
        if (existing) {
          existing.cantidad += s.cantidad
        } else {
          arr.push({
            bloque_id: s.bloque_id,
            bloque_codigo: bloqueMap.get(s.bloque_id) ?? s.bloque_id,
            cantidad: s.cantidad,
          })
        }
        stockPorPosicion.set(pos.id, arr)
        break
      }
    }
  }

  const result: PosicionConStock[] = posiciones.map((pos) => {
    const sub = subMap.get(pos.subcolumna_id)
    const bloques = (stockPorPosicion.get(pos.id) ?? []).filter((b) => b.cantidad > 0)
    const totalStock = bloques.reduce((sum, b) => sum + b.cantidad, 0)
    const cLetra = sub ? (colMap.get(sub.columna_id) ?? '') : ''
    return {
      posicionId: pos.id,
      posicionNumero: pos.numero,
      subcolumnaCodigo: sub ? cleanSubcolCode(sub.codigo, cLetra) : '',
      columnaLetra: cLetra,
      stock: totalStock,
      bloques,
    }
  })

  return result
}

/**
 * Calcula los lotes restantes por bloque con el algoritmo ACORDADO con operación:
 *  - Una SALIDA con fecha F descuenta PRIMERO del lote con fecha F (lote elegido por el usuario).
 *  - Una SALIDA sin fecha descuenta PRIMERO del lote sin fecha (material sin vencimiento).
 *  - Si el lote dirigido no alcanza, el remanente desborda en orden FEFO
 *    (fechas más antiguas primero, lote sin fecha al final).
 * Ningún lote queda en negativo y el stock total (suma de remanentes) siempre
 * es igual a ingresos - salidas. Igual que calcularLotesRemanentes() en Racks.
 *
 * EXPORTADO: fuente única de verdad FEFO de Piso — la usan el detalle de
 * posición/nivel (Sectores), stockPisoGlobal (Stock/INC/FEFO), stockPisoBuscar
 * y los tests de regresión. Las SALIDAS se procesan en el orden en que llegan:
 * el llamador DEBE ordenar por fecha de movimiento ASC (orden temporal real).
 */
type PisoDetalleRow = {
  bloque_id: string
  cantidad: unknown
  fecha_vencimiento?: string | null
  lote?: string | null
  tipo: string | null
  fechaMov?: string | null
}

/** Tipos de movimiento que SUMAN stock en Piso (los lotes físicos provienen de estos). */
const PISO_TIPOS_INGRESO: ReadonlySet<string> = new Set(['ingreso', 'devolucion', 'stock_inicial'])

/** Fila de stock detallado de una posición o nivel. `lote` = código(s) de lote físico
 *  del ingreso asociado a ese (bloque, fecha de vencimiento) — informativo, igual que
 *  en Racks; puede unir varios códigos con ", ". No afecta stock ni FEFO. */
export type StockDetalleFila = {
  bloque_id: string
  bloque_codigo: string
  bloque_descripcion: string
  bloque_unidad: string
  cantidad: number
  fecha_vencimiento: string
  lote?: string
}

export function lotesRestantesPorBloque(
  detalles: PisoDetalleRow[]
): Map<string, { fecha: string; qty: number }[]> {
  const isIngresoType = (tipo: string) => PISO_TIPOS_INGRESO.has(tipo)
  const toQty = (c: unknown) => (typeof c === 'number' ? c : parseFloat(String(c ?? '0')) || 0)
  const toVenc = (fv: unknown) => (typeof fv === 'string' && fv ? fv : '')

  const ingresos = new Map<string, Map<string, number>>()
  const salidas = new Map<string, Array<{ venc: string; qty: number }>>()
  for (const d of detalles) {
    if (!d.tipo) continue
    const qty = toQty(d.cantidad)
    if (!(qty > 0)) continue
    if (isIngresoType(d.tipo)) {
      const fv = toVenc(d.fecha_vencimiento)
      const pool = ingresos.get(d.bloque_id) ?? new Map<string, number>()
      pool.set(fv, (pool.get(fv) ?? 0) + qty)
      ingresos.set(d.bloque_id, pool)
    } else {
      const list = salidas.get(d.bloque_id) ?? []
      list.push({ venc: toVenc(d.fecha_vencimiento), qty })
      salidas.set(d.bloque_id, list)
    }
  }

  const resultado = new Map<string, { fecha: string; qty: number }[]>()
  for (const [bloqueId, pool] of ingresos) {
    const rem = new Map(pool)
    // Orden FEFO: fechas ascendentes primero, lote sin fecha ('') al final
    const ordenFefo = Array.from(rem.keys()).sort((a, b) => {
      if (a && b) return a.localeCompare(b)
      if (a && !b) return -1
      if (!a && b) return 1
      return 0
    })
    const descontarDe = (venc: string, pend: number): number => {
      const disp = rem.get(venc) ?? 0
      if (disp <= 0) return pend
      const tomar = Math.min(pend, disp)
      rem.set(venc, disp - tomar)
      return pend - tomar
    }
    for (const s of (salidas.get(bloqueId) ?? [])) {
      let pend = s.qty
      if (!(pend > 0)) continue
      if (s.venc && (rem.get(s.venc) ?? 0) > 0) {
        pend = descontarDe(s.venc, pend)
      } else if (!s.venc && (rem.get('') ?? 0) > 0) {
        pend = descontarDe('', pend)
      }
      if (pend > 0) {
        for (const v of ordenFefo) {
          if (pend <= 0) break
          pend = descontarDe(v, pend)
        }
      }
    }
    // ═══ FIX residuos de punto flotante ═══
    // Redondear a 3 decimales (precisión de la BD) ANTES del filtro qty > 0.
    // Sin esto, sumas como 30.780+30.780+82.080 menos salidas FEFO dejan residuos
    // de ~1e-14 que pasan el filtro y se muestran como un articulo con 0 stock
    // ("lotes fantasma", ej: 48035 venc 2026-12-26 en 1A1-3-1).
    const restantes = Array.from(rem.entries())
      .map(([fecha, q]) => ({ fecha, qty: Math.round(q * 1000) / 1000 }))
      .filter(({ qty }) => qty > 0)
      .sort((a, b) => {
        if (a.fecha && b.fecha) return a.fecha.localeCompare(b.fecha)
        if (a.fecha && !b.fecha) return -1
        if (!a.fecha && b.fecha) return 1
        return 0
      })
    if (restantes.length > 0) resultado.set(bloqueId, restantes)
  }
  return resultado
}

/** Normaliza la relación piso_movimientos (objeto o array) a su tipo. */
function pisoDetalleTipo(pm: unknown): string | null {
  if (!pm) return null
  if (Array.isArray(pm)) return pm.length > 0 ? (pm[0] as { tipo: string }).tipo : null
  return (pm as { tipo: string }).tipo
}
/** Normaliza la relación piso_movimientos (objeto o array) a su fecha. */
function pisoDetalleFecha(pm: unknown): string | null {
  if (!pm) return null
  if (Array.isArray(pm)) return pm.length > 0 ? ((pm[0] as { fecha?: string }).fecha ?? null) : null
  return (pm as { fecha?: string }).fecha ?? null
}

/** Construye el mapa de códigos de lote físico por (bloque_id, fecha de vencimiento)
 *  a partir de los detalles de tipo ingreso/devolución — igual que `lotesFis` en Racks.
 *  Informativo: NO altera cantidades. */
function lotesFisicosPorFecha(detalles: PisoDetalleRow[]): Map<string, Map<string, Set<string>>> {
  const mapa = new Map<string, Map<string, Set<string>>>()
  for (const d of detalles) {
    const lote = (d.lote || '').trim()
    if (!lote || !d.tipo || !PISO_TIPOS_INGRESO.has(d.tipo)) continue
    const venc = d.fecha_vencimiento ?? ''
    const porFecha = mapa.get(d.bloque_id) ?? new Map<string, Set<string>>()
    const set = porFecha.get(venc) ?? new Set<string>()
    set.add(lote)
    porFecha.set(venc, set)
    mapa.set(d.bloque_id, porFecha)
  }
  return mapa
}

/**
 * Obtiene el stock detallado de una posición específica (todos los bloques y cantidades).
 * Cálculo client-side con el algoritmo dirigido + desborde FEFO (respeta el lote elegido).
 */
export async function stockDetallePosicion(
  posicionId: string
): Promise<StockDetalleFila[]> {
  // ═══ CÁLCULO CLIENT-SIDE: salida dirigida al lote elegido + desborde FEFO ═══
  // NOTA: la RPC piso_stock_detalle_posicion actual descuenta las salidas FEFO
  // ignorando la fecha registrada en cada salida (rompe la selección de lote).
  // Se usa el cálculo client-side corregido; para volver a RPC server-side aplicar
  // download/rackly_fefo_dirigido.sql (misma semántica) y reactivar la llamada RPC.
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('id')
    .eq('posicion_id', posicionId)
  if (nivErr) throw nivErr
  const nivelIds = ((nivData ?? []) as { id: string }[]).map((n) => n.id)
  if (nivelIds.length === 0) return []

  // Intentar select con fecha_vencimiento + lote; degradar si alguna columna no existe aún
  const getDetalles = async () => {
    // Intento 1: con fecha_vencimiento y lote
    const { data: d1, error: e1 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, lote, movimiento_id, piso_movimientos(tipo, fecha)')
      .in('nivel_id', nivelIds)
    if (!e1) return d1 as unknown[]
    // Intento 2: con fecha_vencimiento, sin lote (migración de lote pendiente)
    const { data: d2, error: e2 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, fecha)')
      .in('nivel_id', nivelIds)
    if (!e2) return d2 as unknown[]
    // Intento 3: sin fecha_vencimiento ni lote (DB antigua)
    console.warn('[Piso] fallback: fecha_vencimiento no disponible, calculando sin FEFO')
    const { data: d3, error: e3 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, movimiento_id, piso_movimientos(tipo, fecha)')
      .in('nivel_id', nivelIds)
    if (e3) throw e3
    return d3 as unknown[]
  }
  const rawDetalles = await getDetalles()

  const detalles: PisoDetalleRow[] = (rawDetalles ?? []).map((d) => {
    const r = d as Record<string, unknown>
    const pm = r.piso_movimientos
    return {
      bloque_id: r.bloque_id as string,
      cantidad: r.cantidad,
      fecha_vencimiento: (r.fecha_vencimiento as string | null) ?? null,
      lote: (r.lote as string | null) ?? null,
      tipo: pisoDetalleTipo(pm),
      fechaMov: pisoDetalleFecha(pm),
    }
  })
  // Procesar salidas en orden temporal (misma semántica que la vista de lotes de Racks)
  detalles.sort((a, b) => (a.fechaMov ?? '').localeCompare(b.fechaMov ?? ''))

  // Lotes restantes: salida dirigida al lote elegido + desborde FEFO (sin negativos)
  const lotesRestantes = lotesRestantesPorBloque(detalles)

  if (lotesRestantes.size === 0) return []

  // Códigos de lote físico por (bloque, fecha) para mostrar junto a cada lote restante
  const loteFisMap = lotesFisicosPorFecha(detalles)

  // Info de bloques — catálogo de Racks como fuente de verdad (resolución central)
  const bloqueIds = [...lotesRestantes.keys()]
  const bloqueInfoMap = await resolverInfoBloques(bloqueIds)

  const results: StockDetalleFila[] = []
  for (const [bloqueId, lots] of lotesRestantes) {
    const info = bloqueInfoMap.get(bloqueId)
    if (!info) continue
    for (const lot of lots) {
      if (lot.qty <= 0) continue
      const fis = loteFisMap.get(bloqueId)?.get(lot.fecha)
      results.push({
        bloque_id: bloqueId, bloque_codigo: info.codigo, bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad || 'KG', cantidad: Math.round(lot.qty * 1000) / 1000, fecha_vencimiento: lot.fecha,
        ...(fis && fis.size > 0 ? { lote: Array.from(fis).sort().join(', ') } : {}),
      })
    }
  }
  results.sort((a, b) => {
    if (a.fecha_vencimiento && b.fecha_vencimiento) return a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)
    if (a.fecha_vencimiento && !b.fecha_vencimiento) return -1
    if (!a.fecha_vencimiento && b.fecha_vencimiento) return 1
    return a.bloque_codigo.localeCompare(b.bloque_codigo)
  })
  return results
}

/**
 * Obtiene el stock detallado de un NIVEL específico (para vista por niveles).
 * Cálculo client-side con el algoritmo dirigido + desborde FEFO (respeta el lote elegido),
 * filtrado a un solo nivel_id.
 */
export async function stockDetalleNivel(
  nivelId: string
): Promise<StockDetalleFila[]> {
  // Obtener detalles de movimiento para este nivel específico
  // Intentar select con fecha_vencimiento + lote; degradar si alguna columna no existe aún
  const getDetalles = async () => {
    // Intento 1: con fecha_vencimiento y lote
    const { data: d1, error: e1 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, lote, movimiento_id, piso_movimientos(tipo, fecha)')
      .eq('nivel_id', nivelId)
    if (!e1) return d1 as unknown[]
    // Intento 2: con fecha_vencimiento, sin lote (migración de lote pendiente)
    const { data: d2, error: e2 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, fecha)')
      .eq('nivel_id', nivelId)
    if (!e2) return d2 as unknown[]
    // Intento 3: sin fecha_vencimiento ni lote (DB antigua)
    console.warn('[Piso] fallback: fecha_vencimiento no disponible, calculando sin FEFO')
    const { data: d3, error: e3 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, movimiento_id, piso_movimientos(tipo, fecha)')
      .eq('nivel_id', nivelId)
    if (e3) throw e3
    return d3 as unknown[]
  }
  const rawDetalles = await getDetalles()

  const detalles: PisoDetalleRow[] = (rawDetalles ?? []).map((d) => {
    const r = d as Record<string, unknown>
    const pm = r.piso_movimientos
    return {
      bloque_id: r.bloque_id as string,
      cantidad: r.cantidad,
      fecha_vencimiento: (r.fecha_vencimiento as string | null) ?? null,
      lote: (r.lote as string | null) ?? null,
      tipo: pisoDetalleTipo(pm),
      fechaMov: pisoDetalleFecha(pm),
    }
  })
  // Procesar salidas en orden temporal (misma semántica que la vista de lotes de Racks)
  detalles.sort((a, b) => (a.fechaMov ?? '').localeCompare(b.fechaMov ?? ''))

  // Lotes restantes: salida dirigida al lote elegido + desborde FEFO (sin negativos)
  const lotesRestantes = lotesRestantesPorBloque(detalles)

  if (lotesRestantes.size === 0) return []

  // Códigos de lote físico por (bloque, fecha) para mostrar junto a cada lote restante
  const loteFisMap = lotesFisicosPorFecha(detalles)

  // Info de bloques — catálogo de Racks como fuente de verdad (resolución central)
  const bloqueIds = [...lotesRestantes.keys()]
  const bloqueInfoMap = await resolverInfoBloques(bloqueIds)

  const results: StockDetalleFila[] = []
  for (const [bloqueId, lots] of lotesRestantes) {
    const info = bloqueInfoMap.get(bloqueId)
    if (!info) continue
    for (const lot of lots) {
      if (lot.qty <= 0) continue
      const fis = loteFisMap.get(bloqueId)?.get(lot.fecha)
      results.push({
        bloque_id: bloqueId, bloque_codigo: info.codigo, bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad || 'KG', cantidad: Math.round(lot.qty * 1000) / 1000, fecha_vencimiento: lot.fecha,
        ...(fis && fis.size > 0 ? { lote: Array.from(fis).sort().join(', ') } : {}),
      })
    }
  }
  results.sort((a, b) => {
    if (a.fecha_vencimiento && b.fecha_vencimiento) return a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)
    if (a.fecha_vencimiento && !b.fecha_vencimiento) return -1
    if (!a.fecha_vencimiento && b.fecha_vencimiento) return 1
    return a.bloque_codigo.localeCompare(b.bloque_codigo)
  })
  return results
}

/**
 * Valida que cada (nivel_id, bloque_id) de las salidas propuestas tenga stock
 * neto SUFICIENTE consultando la BD en ese instante (no los datos del diálogo).
 * Por qué: un diálogo abierto mientras otra sesión retira stock quedaba con
 * stockActual viejo y permitía registrar salidas imposibles → lotes fantasma y
 * "artículos en 0 que no desaparecen". La RPC piso_registrar_salida ya validaba
 * esto en servidor, pero la app registra con INSERT directo; esta barrera
 * client-side (datos frescos justo antes del insert) elimina el caso real sin
 * cambiar la ruta de escritura ni la semántica de INC.
 * Lanza Error('STOCK_INSUFICIENTE|...') si algo excede lo disponible.
 */
async function validarStockSuficiente(
  detalles: { nivel_id: string; bloque_id: string; cantidad: number }[],
  tag: string
): Promise<void> {
  if (detalles.length === 0) return
  const round3 = (n: number) => Math.round(n * 1000) / 1000

  // 1. Cantidad solicitada por (nivel_id, bloque_id)
  const solicitado = new Map<string, number>()
  for (const d of detalles) {
    const key = `${d.nivel_id}__${d.bloque_id}`
    solicitado.set(key, (solicitado.get(key) ?? 0) + (d.cantidad || 0))
  }

  const nivelIds = [...new Set(detalles.map((d) => d.nivel_id))]
  const bloqueIds = [...new Set(detalles.map((d) => d.bloque_id))]

  // 2. Stock neto ACTUAL por (nivel_id, bloque_id) desde la BD (selectIn trocea .in())
  const rows = await selectIn<{ nivel_id: string; bloque_id: string; cantidad: unknown; tipo: string }>(
    'piso_movimiento_detalles',
    'nivel_id, bloque_id, cantidad, piso_movimientos(tipo)',
    'nivel_id',
    nivelIds
  )
  const neto = new Map<string, number>()
  for (const r of rows as unknown as { nivel_id: string; bloque_id: string; cantidad: unknown; piso_movimientos: { tipo: string } | { tipo: string }[] | null }[]) {
    if (!bloqueIds.includes(r.bloque_id)) continue
    const tipo = Array.isArray(r.piso_movimientos) ? (r.piso_movimientos[0]?.tipo ?? '') : (r.piso_movimientos?.tipo ?? '')
    if (!tipo) continue
    const qty = typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0
    const delta = PISO_TIPOS_INGRESO.has(tipo) ? qty : -qty
    const key = `${r.nivel_id}__${r.bloque_id}`
    neto.set(key, (neto.get(key) ?? 0) + delta)
  }

  // 3. Códigos de bloque para el mensaje (1 query, tolerante a fallo)
  const codigos = new Map<string, string>()
  try {
    const { data: bs } = await dataClient.from('piso_bloques').select('id, codigo').in('id', bloqueIds)
    for (const b of (bs ?? []) as { id: string; codigo: string }[]) codigos.set(b.id, b.codigo)
  } catch { /* mensaje con UUID como fallback */ }

  // 4. Comparar (tolerancia de redondeo a 3 decimales = precisión de la BD)
  for (const [key, req] of solicitado) {
    if (!(req > 0)) continue
    const disp = round3(neto.get(key) ?? 0)
    if (round3(req) > disp + 1e-9) {
      const [nivelId, bloqueId] = key.split('__')
      throw new Error(
        `STOCK_INSUFICIENTE|${codigos.get(bloqueId) ?? bloqueId}: disponible ${disp}, solicitado ${round3(req)}. ` +
        `La vista estaba desactualizada (nivel ${nivelId.slice(0, 8)}). Actualice y reintente. [${tag}]`
      )
    }
  }
}

/** Normaliza los detalles para las RPC de Piso (jsonb seguro):
 *  fecha_vencimiento vacía → null; lote con trim, vacío → null. */
function detallesParaRpc(detalles: DetalleInput[]): Record<string, unknown>[] {
  return detalles.map((d) => ({
    nivel_id: d.nivel_id,
    bloque_id: d.bloque_id,
    cantidad: d.cantidad,
    fecha_vencimiento: d.fecha_vencimiento || null,
    lote: loteLimpio(d.lote) || null,
  }))
}

/** Detecta si la RPC aún no existe en la BD (migración 20261016_piso_rpc_salidas
 *  pendiente) para degradar a la ruta directa sin perder el movimiento.
 *  PostgREST responde PGRST202 ("Could not find the function...") en ese caso. */
function esRpcNoDisponible(err: unknown): boolean {
  const rec = err as { code?: string; message?: string } | null
  if (!rec) return false
  if (rec.code === 'PGRST202' || rec.code === 'PGRST404' || rec.code === '404') return true
  return /could not find the function/i.test(rec.message ?? '')
}

// ═══ Ruta DIRECTA (respaldo si la RPC no existe): cabecera + detalles en
// ═══ 2 requests con rollback manual. Es la lógica que existía antes de la
// ═══ migración a RPC; la RPC es la vía principal (atómica en servidor).

/** Inserta una cabecera de movimiento simple y devuelve su id. */
async function insertarCabeceraSimple(
  tipo: string,
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  uuidSync: string,
  opts?: { posicion_id?: string; codigo_inc?: string }
): Promise<string> {
  const insertPayload: Record<string, unknown> = {
    tipo,
    turno,
    usuario_id: usuarioId,
    usuario_nombre: usuarioNombre,
    usuario_correo: usuarioCorreo,
    uuid_sync: uuidSync,
  }
  if (opts?.posicion_id) insertPayload.posicion_id = opts.posicion_id
  if (opts?.codigo_inc) insertPayload.codigo_inc = opts.codigo_inc

  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert(insertPayload)
    .select('id')
    .single()
  if (movErr) throw movErr
  return (movData as { id: string }).id
}

/** Inserta los detalles de una cabecera; si falla, elimina las cabeceras de
 *  rollback (huérfanas) y relanza el error. */
async function insertarDetallesConRollback(
  movimientoId: string,
  detalles: DetalleInput[],
  tag: string,
  cabecerasRollback: string[]
): Promise<void> {
  const { rows, tieneLote } = buildDetRows(movimientoId, detalles)
  if (rows.length === 0) return
  try {
    await insertDetallesPiso(rows, tieneLote, tag)
  } catch (detErr) {
    console.error(`[${tag}] Error insertando detalles, haciendo rollback:`, (detErr as { message?: string }).message)
    await rollbackCabeceras(cabecerasRollback, tag)
    throw detErr
  }
}

/** Respaldo directo de registrarIngresoPosicion (RPC no disponible). */
async function registrarIngresoPosicionDirecto(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[],
  uuidSync: string,
  opts?: { posicion_id?: string; codigo_inc?: string }
): Promise<void> {
  const movimientoId = await insertarCabeceraSimple(
    'ingreso', turno, usuarioId, usuarioNombre, usuarioCorreo, uuidSync, opts
  )
  await insertarDetallesConRollback(movimientoId, detalles, 'registrarIngresoPosicion', [movimientoId])
}

/** Respaldo directo de registrarSalidaPosicion (RPC no disponible). */
async function registrarSalidaPosicionDirecto(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[],
  uuidSync: string
): Promise<void> {
  const movimientoId = await insertarCabeceraSimple(
    'salida', turno, usuarioId, usuarioNombre, usuarioCorreo, uuidSync
  )
  await insertarDetallesConRollback(movimientoId, detalles, 'registrarSalidaPosicion', [movimientoId])
}

/** Respaldo directo de registrarDevolucionPosicion (RPC no disponible). */
async function registrarDevolucionPosicionDirecto(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[],
  uuidSync: string
): Promise<void> {
  const movimientoId = await insertarCabeceraSimple(
    'devolucion', turno, usuarioId, usuarioNombre, usuarioCorreo, uuidSync
  )
  await insertarDetallesConRollback(movimientoId, detalles, 'registrarDevolucionPosicion', [movimientoId])
}

/** Respaldo directo de registrarTrasladoPosicion (RPC no disponible).
 *  Salida en origen + ingreso en destino; rollback completo ante cualquier fallo. */
async function registrarTrasladoPosicionDirecto(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detallesSalida: DetalleInput[],
  detallesIngreso: DetalleInput[],
  uuidSync: string
): Promise<void> {
  const salId = await insertarCabeceraSimple('salida', turno, usuarioId, usuarioNombre, usuarioCorreo, uuidSync)

  let ingId: string
  try {
    ingId = await insertarCabeceraSimple('ingreso', turno, usuarioId, usuarioNombre, usuarioCorreo, uuidSync)
  } catch (ingErr) {
    console.error('[registrarTrasladoPosicion] Error creando ingreso, haciendo rollback de salida:', (ingErr as { message?: string }).message)
    await rollbackCabeceras([salId], 'registrarTrasladoPosicion')
    throw ingErr
  }

  try {
    await insertarDetallesConRollback(salId, detallesSalida, 'registrarTrasladoPosicion', [salId, ingId])
    await insertarDetallesConRollback(ingId, detallesIngreso, 'registrarTrasladoPosicion', [salId, ingId])
  } finally {
    // insertarDetallesConRollback ya hace rollback de cabeceras ante fallo
  }
}

// ═══ API PÚBLICA DE ESCRITURA — RPC-FIRST (atómicas en servidor;
// ═══ migración 20261016_piso_rpc_salidas.sql) con respaldo directo.

/**
 * Registra un ingreso directo a una posición (permite múltiples bloques).
 * RPC atómica piso_registrar_movimiento: cabecera + detalles en UNA transacción
 * (idempotencia por uuid_sync en servidor; numero_operacion por secuencia).
 * Si la RPC no existe aún (migración pendiente), degrada a la ruta directa.
 */
export async function registrarIngresoPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[],
  opts?: { posicion_id?: string; codigo_inc?: string }
): Promise<void> {
  const uuidSync = generateUuidSync()

  const { error } = await dataClient.rpc('piso_registrar_movimiento', {
    _tipo: 'ingreso',
    _turno: turno,
    _detalles: detallesParaRpc(detalles),
    _uuid_sync: uuidSync,
    _codigo_inc: opts?.codigo_inc ?? null,
    _usuario_id: usuarioId,
    _usuario_nombre: usuarioNombre,
    _usuario_correo: usuarioCorreo,
    _posicion_id: opts?.posicion_id ?? null,
  })
  if (!error) return
  if (!esRpcNoDisponible(error)) throw error
  console.warn('[registrarIngresoPosicion] RPC no disponible — ruta directa. Aplicar 20261016_piso_rpc_salidas.sql.')
  await registrarIngresoPosicionDirecto(turno, usuarioId, usuarioNombre, usuarioCorreo, detalles, uuidSync, opts)
}

/**
 * Registra una salida de stock de una posición.
 * RPC atómica piso_salida_posicion: valida stock EN SERVIDOR dentro de locks
 * por nivel (sin TOCTOU), inserta cabecera + detalles en una transacción,
 * con lote físico y numero_operacion por secuencia. La validación client-side
 * (validarStockSuficiente) se conserva como barrera rápida con mensaje claro;
 * la del servidor es la autoridad.
 */
export async function registrarSalidaPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[]
): Promise<void> {
  const uuidSync = generateUuidSync()

  // Barrera anti-datos-desactualizados (fail rápido; la RPC re-valida igual)
  await validarStockSuficiente(detalles, 'registrarSalidaPosicion')

  const { error } = await dataClient.rpc('piso_salida_posicion', {
    p_turno: turno,
    p_usuario_id: usuarioId,
    p_usuario_nombre: usuarioNombre,
    p_usuario_correo: usuarioCorreo,
    p_uuid_sync: uuidSync,
    p_detalles: detallesParaRpc(detalles),
  })
  if (!error) return
  if (!esRpcNoDisponible(error)) throw error
  console.warn('[registrarSalidaPosicion] RPC no disponible — ruta directa. Aplicar 20261016_piso_rpc_salidas.sql.')
  await registrarSalidaPosicionDirecto(turno, usuarioId, usuarioNombre, usuarioCorreo, detalles, uuidSync)
}

/**
 * Registra una devolución de stock a una posición (ingreso con tipo 'devolucion').
 * RPC atómica piso_registrar_movimiento; fallback directo si no existe.
 */
export async function registrarDevolucionPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[]
): Promise<void> {
  const uuidSync = generateUuidSync()

  const { error } = await dataClient.rpc('piso_registrar_movimiento', {
    _tipo: 'devolucion',
    _turno: turno,
    _detalles: detallesParaRpc(detalles),
    _uuid_sync: uuidSync,
    _codigo_inc: null,
    _usuario_id: usuarioId,
    _usuario_nombre: usuarioNombre,
    _usuario_correo: usuarioCorreo,
    _posicion_id: null,
  })
  if (!error) return
  if (!esRpcNoDisponible(error)) throw error
  console.warn('[registrarDevolucionPosicion] RPC no disponible — ruta directa. Aplicar 20261016_piso_rpc_salidas.sql.')
  await registrarDevolucionPosicionDirecto(turno, usuarioId, usuarioNombre, usuarioCorreo, detalles, uuidSync)
}

/**
 * Registra un traslado entre posiciones del mismo sector (salida en origen +
 * ingreso en destino). RPC atómica piso_traslado_posicion: AMBAS cabeceras y
 * sus detalles en UNA transacción (antes podían quedar pares parciales),
 * valida stock de origen y saldo total en servidor, propaga el lote y limpia
 * parciales residuales del mismo uuid_sync. Fallback directo si no existe.
 */
export async function registrarTrasladoPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detallesSalida: DetalleInput[],
  detallesIngreso: DetalleInput[]
): Promise<void> {
  const uuidSync = generateUuidSync()

  // Validación client-side de la salida contra stock REAL (fail rápido;
  // la RPC re-valida en servidor dentro de locks)
  await validarStockSuficiente(detallesSalida, 'registrarTrasladoPosicion')

  const { error } = await dataClient.rpc('piso_traslado_posicion', {
    p_turno: turno,
    p_usuario_id: usuarioId,
    p_usuario_nombre: usuarioNombre,
    p_usuario_correo: usuarioCorreo,
    p_uuid_sync: uuidSync,
    p_detalles_salida: detallesParaRpc(detallesSalida),
    p_detalles_ingreso: detallesParaRpc(detallesIngreso),
  })
  if (!error) return
  if (!esRpcNoDisponible(error)) throw error
  console.warn('[registrarTrasladoPosicion] RPC no disponible — ruta directa. Aplicar 20261016_piso_rpc_salidas.sql.')
  await registrarTrasladoPosicionDirecto(turno, usuarioId, usuarioNombre, usuarioCorreo, detallesSalida, detallesIngreso, uuidSync)
}

/**
 * Obtiene el primer nivel disponible de una posición.
 */
export async function obtenerPrimerNivel(posicionId: string): Promise<string | null> {
  const { data, error } = await dataClient
    .from('piso_niveles')
    .select('id')
    .eq('posicion_id', posicionId)
    .order('numero')
    .limit(1)
  if (error) throw error
  const rows = (data ?? []) as { id: string }[]
  return rows.length > 0 ? rows[0].id : null
}

export type NivelInfo = { id: string; numero: number; codigo_ubicacion: string | null }

/**
 * Obtiene todos los niveles de una posición, ordenados por número.
 */
export async function obtenerNivelesPosicion(posicionId: string, columnaLetra?: string): Promise<NivelInfo[]> {
  const { data, error } = await dataClient
    .from('piso_niveles')
    .select('id, numero, codigo_ubicacion')
    .eq('posicion_id', posicionId)
    .order('numero')
  if (error) throw error
  const result = (data ?? []) as NivelInfo[]
  if (columnaLetra) {
    for (const n of result) {
      if (n.codigo_ubicacion) {
        const idx = n.codigo_ubicacion.indexOf(columnaLetra)
        if (idx >= 0) n.codigo_ubicacion = n.codigo_ubicacion.substring(idx)
      }
    }
  }
  return result
}

/**
 * Obtiene el stock detallado de una posición desglosado por nivel.
 */
export async function stockPorNivelPosicion(
  posicionId: string
): Promise<{ nivel_id: string; nivel_numero: number; bloque_codigo: string; cantidad: number }[]> {
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('id, numero')
    .eq('posicion_id', posicionId)
    .order('numero')
  if (nivErr) throw nivErr
  const niveles = (nivData ?? []) as { id: string; numero: number }[]
  if (niveles.length === 0) return []

  const nivelIds = niveles.map((n) => n.id)
  const nivelMap = new Map(niveles.map((n) => [n.id, n.numero]))

  const { data: detData, error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .select('nivel_id, bloque_id, cantidad, movimiento_id, piso_movimientos(tipo)')
    .in('nivel_id', nivelIds)
  if (detErr) throw detErr

  // Calcular stock neto por nivel y bloque
  const stockMap = new Map<string, number>()
  for (const d of (detData ?? []) as unknown as {
    nivel_id: string; bloque_id: string; cantidad: unknown;
    piso_movimientos: { tipo: string } | null | { tipo: string }[]
  }[]) {
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    const tipo = Array.isArray(d.piso_movimientos) ? (d.piso_movimientos[0]?.tipo ?? '') : (d.piso_movimientos?.tipo ?? '')
    const delta = (tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion') ? qty : -qty
    if (delta === 0) continue
    stockMap.set(d.nivel_id, (stockMap.get(d.nivel_id) ?? 0) + delta)
  }

  // Obtener códigos de bloques
  const bloqueIds = [...new Set((detData ?? []).map((d: unknown) => (d as { bloque_id: string }).bloque_id))] as string[]
  const bloqueMap = new Map<string, string>()
  const realIds = bloqueIds.filter((id) => !id.startsWith('cat_') && !id.startsWith('manual_'))
  if (realIds.length > 0) {
    const { data: bloqData } = await dataClient.from('piso_bloques').select('id, codigo').in('id', realIds)
    for (const b of (bloqData ?? []) as { id: string; codigo: string }[]) bloqueMap.set(b.id, b.codigo)
  }
  for (const id of bloqueIds) {
    if (!bloqueMap.has(id)) {
      bloqueMap.set(id, id.startsWith('cat_') ? id.replace('cat_', '') : id.startsWith('manual_') ? id.replace('manual_', '') : id)
    }
  }

  const results: { nivel_id: string; nivel_numero: number; bloque_codigo: string; cantidad: number }[] = []
  for (const [nivelId, stock] of stockMap) {
    // Redondeo defensivo ANTES del filtro > 0 (evita "artículos en 0" por residuos)
    const q = Math.round(stock * 1000) / 1000
    if (q > 0) {
      results.push({ nivel_id: nivelId, nivel_numero: nivelMap.get(nivelId) ?? 0, bloque_codigo: '', cantidad: q })
    }
  }
  return results
}

/**
 * Lista artículos para los selectores de Piso — FUENTE ÚNICA: catálogo de Racks.
 * Devuelve todo el catálogo con ids virtuales `cat_<codigo>` y añade al final
 * los códigos SOLO-piso (anclas históricas cuyo código ya no está en catálogo,
 * p.ej. muestras manuales) con su id real.
 */
export async function listarBloquesParaSelect(): Promise<{ id: string; codigo: string; descripcion: string; unidad: string }[]> {
  const results: { id: string; codigo: string; descripcion: string; unidad: string }[] = []
  const seen = new Set<string>()

  // 1. CATÁLOGO DE RACKS — fuente de verdad (ids virtuales: el ancla real se
  //    garantiza al usar el artículo, vía buscarBloquePorCodigo/crearBloque)
  try {
    const { data, error } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .order('codigo')
    if (error) console.error('[Piso] Error consultando catalogo:', error.message)
    for (const c of (data ?? []) as { codigo: string; descripcion: string; un: string }[]) {
      const code = (c.codigo ?? '').trim().toUpperCase()
      if (code && !seen.has(code)) {
        seen.add(code)
        results.push({
          id: `cat_${code}`,
          codigo: code,
          descripcion: c.descripcion ?? '',
          unidad: c.un ?? '',
        })
      }
    }
  } catch (err) { console.error('[Piso] Error en catalogo:', err) }

  // 2. Respaldo histórico: anclas de piso cuyo código NO está en catálogo
  try {
    const { data, error } = await dataClient
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .order('codigo')
    if (error) console.error('[Piso] Error consultando piso_bloques:', error.message)
    for (const b of (data ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[]) {
      const code = (b.codigo ?? '').trim().toUpperCase()
      if (code && !seen.has(code)) {
        seen.add(code)
        results.push({
          id: b.id,
          codigo: code,
          descripcion: b.descripcion ?? '',
          unidad: b.unidad ?? '',
        })
      }
    }
  } catch (err) { console.error('[Piso] Error en piso_bloques:', err) }

  return results
}

/**
 * Busca un artículo por código exacto — CATÁLOGO DE RACKS PRIMERO (fuente de
 * verdad de descripción/unidad); si existe, garantiza el ancla en piso_bloques
 * (necesaria para la FK al registrar movimientos) y devuelve sus datos.
 * Si no está en catálogo, respalda en piso_bloques (códigos históricos/muestras).
 * Si no existe en ninguna fuente, retorna null (no auto-crea artículos basura).
 */
export async function buscarBloquePorCodigo(codigo: string): Promise<{ id: string; codigo: string; descripcion: string; unidad: string } | null> {
  const target = codigo.trim().toUpperCase()
  if (!target) return null

  // 1. Catálogo de Racks (fuente de verdad)
  try {
    const { data, error } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .eq('codigo', target)
      .limit(1)
    if (error) console.error('[Piso] Error consultando catalogo:', error.message)
    if (data && data.length > 0) {
      const c = data[0] as { codigo: string; descripcion: string; un: string }
      // Ancla garantizada para que la FK de piso_movimiento_detalles nunca falle
      const ancla = await asegurarAnclaPiso(c.codigo)
      return { id: ancla.id, codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' }
    }
  } catch (err) { console.error('[Piso] Error en búsqueda catalogo:', err) }

  // 2. Respaldo histórico: piso_bloques (fuera de catálogo, p.ej. muestras)
  try {
    const { data, error } = await dataClient
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .eq('codigo', target)
      .limit(1)
    if (error) console.error('[Piso] Error buscando en piso_bloques:', error.message)
    if (data && data.length > 0) {
      const b = data[0] as { id: string; codigo: string; descripcion: string; unidad: string }
      return { id: b.id, codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' }
    }
  } catch (err) { console.error('[Piso] Error en búsqueda piso_bloques:', err) }

  // 3. No encontrado en ninguna fuente
  return null
}

// ═══ Stock global Piso — todos los lotes FEFO con ubicación ═══

export type StockPisoItem = {
  bloque_codigo: string
  bloque_descripcion: string
  bloque_unidad: string
  ubicacion: string
  sector_nombre: string
  cantidad: number
  fecha_vencimiento: string
  codigo_inc?: string
  /** IDs de navegación (deep-link Stock/FEFO/INC → Sectores). Ausentes si la
   *  ubicación no se pudo resolver: la fila se muestra como texto plano. */
  sector_id?: string
  posicion_id?: string
  posicion_numero?: number
  columna_letra?: string
  subcolumna_codigo?: string
}

/**
 * Obtiene todo el stock de Piso con FEFO y ubicación resuelta.
 * Para cada (bloque_id, nivel_id) calcula el stock FEFO restante
 * y resuelve la ubicación (sector, columna, subcolumna, posicion).
 */
export async function stockPisoGlobal(): Promise<StockPisoItem[]> {
  try {
  // 1. Fetch detalles with movement type — paginated to avoid unbounded growth
  const DET_PAGE_SIZE = 2000
  const DET_MAX_PAGES = 20  // máx 40,000 detalles (suficiente para la escala actual)
  let allDetData: Record<string, unknown>[] = []
  let detFrom = 0
  let detPages = 0
  while (detPages++ < DET_MAX_PAGES) {
    const detTo = detFrom + DET_PAGE_SIZE - 1
    const { data: pageData, error: detErr } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, nivel_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, codigo_inc, fecha)')
      // FIX auditoría Task 20 (P1): orden determinista — sin .order(), al cruzar
      // 2,000 detalles PostgREST puede repetir u omitir filas entre páginas y el
      // stock FEFO global se suma mal (filas fantasma o perdidas).
      .order('id')
      .range(detFrom, detTo)
    if (detErr) throw detErr
    const rows = pageData ?? []
    allDetData.push(...rows)
    if (rows.length < DET_PAGE_SIZE) break
    detFrom += DET_PAGE_SIZE
  }
  if (allDetData.length === 0) return []

  // 2. Group by (bloque_id, nivel_id)
  const getTipo = (pm: unknown): string => {
    if (!pm) return ''
    if (Array.isArray(pm)) return pm.length > 0 ? (pm[0] as { tipo: string }).tipo : ''
    return (pm as { tipo: string }).tipo ?? ''
  }

  type RawDet = {
    bloque_id: string
    nivel_id: string
    cantidad: unknown
    fecha_vencimiento?: string | null
    movimiento_id: string
    piso_movimientos: { tipo: string; codigo_inc?: string | null; fecha?: string | null } | null | { tipo: string; codigo_inc?: string | null; fecha?: string | null }[]
  }
  const rawDets = allDetData as RawDet[]

  const blockNivelMap = new Map<string, { bloque_id: string; nivel_id: string; tipo: string; cantidad: number; fecha_vencimiento: string; codigo_inc: string; fechaMov: string }[]>()
  for (const d of rawDets) {
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    const tipo = getTipo(d.piso_movimientos)
    if (!tipo) continue
    const fv = (typeof d.fecha_vencimiento === 'string' && d.fecha_vencimiento) ? d.fecha_vencimiento : ''
    const getCodigoInc = (pm: unknown): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? (pm[0] as { codigo_inc?: string | null }).codigo_inc || '' : ''
      return (pm as { codigo_inc?: string | null }).codigo_inc || ''
    }
    const getFechaMov = (pm: unknown): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? (pm[0] as { fecha?: string | null }).fecha ?? '' : ''
      return (pm as { fecha?: string | null }).fecha ?? ''
    }
    const codigoInc = getCodigoInc(d.piso_movimientos)
    const key = `${d.bloque_id}__${d.nivel_id}`
    const arr = blockNivelMap.get(key) ?? []
    arr.push({ bloque_id: d.bloque_id, nivel_id: d.nivel_id, tipo, cantidad: qty, fecha_vencimiento: fv, codigo_inc: codigoInc, fechaMov: getFechaMov(d.piso_movimientos) })
    blockNivelMap.set(key, arr)
  }

  // 3. FEFO DIRIGIDO per (bloque_id, nivel_id) — misma semántica que el detalle de
  //    posición/nivel en Sectores (lotesRestantesPorBloque): la salida descuenta
  //    PRIMERO el lote con SU fecha registrada y solo el remanente desborda FEFO.
  //    Antes se agrupaban TODAS las salidas como totalExit y se descontaban FEFO
  //    puro: la pestaña Stock mostraba lotes distintos a los reales de la posición
  //    (lotes antiguos "pegados" de ingresos ya consumidos, 19 grupos reales).  
  const fefoResults: { bloque_id: string; nivel_id: string; cantidad: number; fecha_vencimiento: string; codigo_inc: string }[] = []
  for (const [, details] of blockNivelMap) {
    // Orden temporal real (requisito de lotesRestantesPorBloque para las salidas)
    const rows = [...details].sort((a, b) =>
      (a.fechaMov || '').localeCompare(b.fechaMov || ''))
    const remanentes = lotesRestantesPorBloque(rows.map((d) => ({
      bloque_id: d.bloque_id,
      cantidad: d.cantidad,
      fecha_vencimiento: d.fecha_vencimiento,
      tipo: d.tipo,
      fechaMov: d.fechaMov,
    })))
    // codigo_inc REAL por lote remanente: primer ingreso (temporal) de esa fecha que lo traiga
    const incPorFecha = new Map<string, string>()
    for (const d of rows) {
      if (!PISO_TIPOS_INGRESO.has(d.tipo) || !d.codigo_inc) continue
      if (!incPorFecha.has(d.fecha_vencimiento)) incPorFecha.set(d.fecha_vencimiento, d.codigo_inc)
    }
    const bloqueId = details[0].bloque_id
    const nivelId = details[0].nivel_id
    for (const lot of remanentes.get(bloqueId) ?? []) {
      fefoResults.push({
        bloque_id: bloqueId,
        nivel_id: nivelId,
        cantidad: lot.qty,
        fecha_vencimiento: lot.fecha,
        codigo_inc: incPorFecha.get(lot.fecha) ?? '',
      })
    }
  }

  if (fefoResults.length === 0) return []

  // 4. Resolve bloque info — catálogo de Racks como fuente de verdad
  const bloqueIds = [...new Set(fefoResults.map(r => r.bloque_id))]
  const bloqueInfoMap = await resolverInfoBloques(bloqueIds)

  // 5. Resolve location for each nivel_id
  const nivelIds = [...new Set(fefoResults.map(r => r.nivel_id))]
  const locMap = new Map<string, { ubicacion: string; sector_nombre: string; sector_id: string; posicion_id: string; posicion_numero: number; columna_letra: string; subcolumna_codigo: string }>()
  if (nivelIds.length > 0) {
    const { data: nivData } = await dataClient.from('piso_niveles').select('id, posicion_id').in('id', nivelIds)
    const nivToPos = new Map<string, string>()
    for (const n of (nivData ?? []) as { id: string; posicion_id: string }[]) nivToPos.set(n.id, n.posicion_id)

    const posIds = [...nivToPos.values()]
    if (posIds.length > 0) {
      const { data: posData } = await dataClient.from('piso_posiciones').select('id, numero, subcolumna_id').in('id', posIds)
      const posMap = new Map<string, { numero: number; subcolumna_id: string }>()
      for (const p of (posData ?? []) as { id: string; numero: number; subcolumna_id: string }[])
        posMap.set(p.id, { numero: p.numero, subcolumna_id: p.subcolumna_id })
      const subIds = [...new Set([...posMap.values()].map(p => p.subcolumna_id))]
      if (subIds.length > 0) {
        const { data: subData } = await dataClient.from('piso_subcolumnas').select('id, codigo, columna_id').in('id', subIds)
        const subMap = new Map<string, { codigo: string; columna_id: string }>()
        for (const s of (subData ?? []) as { id: string; codigo: string; columna_id: string }[])
          subMap.set(s.id, { codigo: s.codigo, columna_id: s.columna_id })
        const colIds = [...new Set([...subMap.values()].map(s => s.columna_id))]
        if (colIds.length > 0) {
          const { data: colData } = await dataClient.from('piso_columnas').select('id, letra, sector_id').in('id', colIds)
          const colMap = new Map<string, { letra: string; sector_id: string }>()
          for (const c of (colData ?? []) as { id: string; letra: string; sector_id: string }[])
            colMap.set(c.id, { letra: c.letra, sector_id: c.sector_id })
          const secIds = [...new Set([...colMap.values()].map(c => c.sector_id))]
          if (secIds.length > 0) {
            const { data: secData } = await dataClient.from('piso_sectores').select('id, nombre, n_columnas, n_subcolumnas').in('id', secIds)
            const secMap = new Map<string, { nombre: string; nCol: number; nSub: number }>()
            for (const s of (secData ?? []) as { id: string; nombre: string; n_columnas: number; n_subcolumnas: number }[]) secMap.set(s.id, { nombre: s.nombre, nCol: s.n_columnas, nSub: s.n_subcolumnas })
            for (const [nivId, posId] of nivToPos) {
              const pos = posMap.get(posId)
              if (!pos) continue
              const sub = subMap.get(pos.subcolumna_id)
              if (!sub) continue
              const col = colMap.get(sub.columna_id)
              if (!col) continue
              const secInfo = secMap.get(col.sector_id)
              const ubicacion = !secInfo
                ? `${col.letra}-${cleanSubcolCode(sub.codigo, col.letra)}-Pos ${pos.numero}`
                : secInfo.nCol === 1 && secInfo.nSub === 1
                  ? `Pos ${pos.numero}`
                  : secInfo.nSub === 1
                    ? `${col.letra}-Pos ${pos.numero}`
                    : `${col.letra}-${cleanSubcolCode(sub.codigo, col.letra)}-Pos ${pos.numero}`
              locMap.set(nivId, {
                ubicacion,
                sector_nombre: secInfo?.nombre ?? '',
                // IDs para el deep-link clickeable (Stock/FEFO/INC → Sectores)
                sector_id: col.sector_id,
                posicion_id: posId,
                posicion_numero: pos.numero,
                columna_letra: col.letra,
                subcolumna_codigo: sub.codigo,
              })
            }
          }
        }
      }
    }
  }

  // 6. Build results
  return fefoResults
    .filter(r => r.cantidad > 0)
    .map(r => {
      const info = bloqueInfoMap.get(r.bloque_id)
      const loc = locMap.get(r.nivel_id)
      return {
        bloque_codigo: info?.codigo ?? r.bloque_id,
        bloque_descripcion: info?.descripcion ?? '',
        bloque_unidad: info?.unidad ?? 'KG',
        ubicacion: loc?.ubicacion ?? '',
        sector_nombre: loc?.sector_nombre ?? '',
        cantidad: Math.round(r.cantidad * 1000) / 1000,
        fecha_vencimiento: r.fecha_vencimiento,
        codigo_inc: r.codigo_inc || undefined,
        sector_id: loc?.sector_id,
        posicion_id: loc?.posicion_id,
        posicion_numero: loc?.posicion_numero,
        columna_letra: loc?.columna_letra,
        subcolumna_codigo: loc?.subcolumna_codigo,
      }
    })
    .sort((a, b) => {
      if (a.bloque_codigo !== b.bloque_codigo) return a.bloque_codigo.localeCompare(b.bloque_codigo)
      if (a.fecha_vencimiento && b.fecha_vencimiento) return a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)
      if (a.fecha_vencimiento && !b.fecha_vencimiento) return -1
      if (!a.fecha_vencimiento && b.fecha_vencimiento) return 1
      return a.ubicacion.localeCompare(b.ubicacion)
    })
  } catch (err) {
    // PROPAGAR el error (antes tragaba el fallo y devolvía []): StockIncPisoTab
    // necesitaba distinguir "0 INC" de "fallo de consulta" para mostrar su panel
    // de error; PisoStockTab ya tiene su propio try/catch y no cambia.
    console.error('[stockPisoGlobal] Error consultando stock de Piso:', err)
    throw err
  }
}

/**
 * Busca stock en Piso por término (código O descripción) — CONSULTA BAJO DEMANDA.
 * Solo descarga los detalles de los bloques que matchean (filtro server-side con
 * JOIN profundo de ubicación), en vez de traer toda la base de datos y filtrar en
 * cliente (comportamiento anterior de PisoStockTab: cargaba TODOS los detalles
 * paginados + FEFO + ubicaciones de todo el almacén en cada tecleo).
 * FEFO DIRIGIDO por (bloque, nivel): la salida descuenta primero el lote con SU
 * fecha registrada y solo el remanente desborda FEFO — idéntico al detalle de
 * Sectores (lotesRestantesPorBloque), así la búsqueda muestra los lotes reales.
 */
export async function stockPisoBuscar(term: string): Promise<StockPisoItem[]> {
  const TIMEOUT_MS = QUERY_TIMEOUT_MS
  // Antes: Promise.race con un setTimeout que resolvía [] y NUNCA se limpiaba —
  // 1) una consulta lenta "ganaba" el [] del timeout y la UI mostraba
  //    "Sin resultados" FALSO aunque los datos existieran;
  // 2) cuando la consulta sí ganaba, el setTimeout zombie disparaba igual el
  //    warn "TIMEOUT 15000 ms" 15 s después (ruido de consola engañoso).
  // Ahora: éxito/fallo limpia el temporizador; un timeout REAL rechaza con un
  // error claro (la UI lo muestra como error, no como "sin datos").
  return new Promise<StockPisoItem[]>((resolve, reject) => {
    const t = setTimeout(() => {
      console.warn('[stockPisoBuscar] TIMEOUT', TIMEOUT_MS, 'ms')
      reject(
        new Error(
          `La búsqueda tardó más de ${Math.round(TIMEOUT_MS / 1000)} s y fue cancelada. Refina el término e intenta de nuevo.`
        )
      )
    }, TIMEOUT_MS)
    _stockPisoBuscarImpl(term)
      .then((r) => {
        clearTimeout(t)
        resolve(r)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
}

async function _stockPisoBuscarImpl(term: string): Promise<StockPisoItem[]> {
  try {
    const t = term.trim()
    if (!t) return []
    // Sanitizar para el .or() de PostgREST: comas/paréntesis rompen la sintaxis
    const safe = t.replace(/[,()]/g, ' ').trim()
    if (!safe) return []

    // ─── 1. Códigos candidatos: CATÁLOGO DE RACKS (fuente de verdad, descripción
    //        vigente) + anclas de piso (códigos históricos/muestras) ───
    const [catRes, pisoRes] = await Promise.all([
      dataClient
        .from('catalogo')
        .select('codigo')
        .or(`codigo.ilike.%${safe}%,descripcion.ilike.%${safe}%`)
        .order('codigo')
        .limit(80),
      dataClient
        .from('piso_bloques')
        .select('id, codigo')
        .or(`codigo.ilike.%${safe}%,descripcion.ilike.%${safe}%`)
        .order('codigo')
        .limit(80),
    ])
    if (catRes.error) throw catRes.error
    if (pisoRes.error) throw pisoRes.error
    const codigosCandidatos = [...new Set([
      ...((catRes.data ?? []) as { codigo: string }[]).map((c) => (c.codigo ?? '').trim().toUpperCase()),
      ...((pisoRes.data ?? []) as { codigo: string }[]).map((b) => (b.codigo ?? '').trim().toUpperCase()),
    ])].filter(Boolean)
    if (codigosCandidatos.length === 0) return []

    // ─── 1b. Anclas reales: solo ellas pueden tener movimientos/stock en piso ───
    const { data: anclas, error: errA } = await dataClient
      .from('piso_bloques')
      .select('id, codigo')
      .in('codigo', codigosCandidatos)
    if (errA) throw errA
    if (!anclas || anclas.length === 0) return []
    const bloqueIds = (anclas as { id: string; codigo: string }[]).map((a) => a.id)

    // ─── 1c. Info de artículo: catálogo primero (resolución central) ───
    const bloqueInfoMap = await resolverInfoBloques(bloqueIds)

    // ─── 2. Detalles SOLO de esos bloques + ubicación resuelta en 1 query ───
    const { data: detalles, error: errD } = await dataClient
      .from('piso_movimiento_detalles')
      .select(`
        bloque_id,
        nivel_id,
        cantidad,
        fecha_vencimiento,
        piso_movimientos(tipo, codigo_inc, fecha),
        piso_niveles!inner(
          posicion_id,
          piso_posiciones!inner(
            numero,
            subcolumna_id,
            piso_subcolumnas!inner(
              codigo,
              columna_id,
              piso_columnas!inner(
                letra,
                sector_id,
                piso_sectores!inner(
                  nombre,
                  n_columnas,
                  n_subcolumnas
                )
              )
            )
          )
        )
      `)
      .in('bloque_id', bloqueIds)
    if (errD) throw errD
    if (!detalles || detalles.length === 0) return []

    // ─── 3. FEFO DIRIGIDO por (bloque_id, nivel_id) con orden temporal ───
    type BusqRow = {
      bloque_id: string
      nivel_id: string
      cantidad: unknown
      fecha_vencimiento?: string | null
      piso_movimientos: { tipo: string; codigo_inc: string | null; fecha?: string | null } | null | { tipo: string; codigo_inc: string | null; fecha?: string | null }[]
      piso_niveles: PisoNivelLoc
    }
    const getTipo = (pm: BusqRow['piso_movimientos']): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? pm[0].tipo ?? '' : ''
      return pm.tipo ?? ''
    }
    const getCodigoInc = (pm: BusqRow['piso_movimientos']): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? pm[0].codigo_inc || '' : ''
      return pm.codigo_inc || ''
    }
    const getFechaMov = (pm: BusqRow['piso_movimientos']): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? pm[0].fecha ?? '' : ''
      return pm.fecha ?? ''
    }

    const groups = new Map<string, {
      bloque_id: string
      nivel_id: string
      tipo: string
      cantidad: number
      fecha_vencimiento: string
      codigo_inc: string
      fechaMov: string
      loc: PisoNivelLoc
    }[]>()

    for (const d of detalles as BusqRow[]) {
      const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
      if (qty <= 0) continue
      const tipo = getTipo(d.piso_movimientos)
      if (!tipo) continue
      const fv = (typeof d.fecha_vencimiento === 'string' && d.fecha_vencimiento) ? d.fecha_vencimiento : ''
      const key = `${d.bloque_id}__${d.nivel_id}`
      const arr = groups.get(key) ?? []
      arr.push({
        bloque_id: d.bloque_id,
        nivel_id: d.nivel_id,
        tipo,
        cantidad: qty,
        fecha_vencimiento: fv,
        codigo_inc: getCodigoInc(d.piso_movimientos),
        fechaMov: getFechaMov(d.piso_movimientos),
        loc: d.piso_niveles,
      })
      groups.set(key, arr)
    }

    const results: StockPisoItem[] = []
    for (const [, entries] of groups) {
      // Orden temporal real (requisito de lotesRestantesPorBloque para las salidas)
      const rows = [...entries].sort((a, b) => (a.fechaMov || '').localeCompare(b.fechaMov || ''))
      const remanentes = lotesRestantesPorBloque(rows.map((d) => ({
        bloque_id: d.bloque_id,
        cantidad: d.cantidad,
        fecha_vencimiento: d.fecha_vencimiento,
        tipo: d.tipo,
        fechaMov: d.fechaMov,
      })))
      // codigo_inc REAL por lote remanente: primer ingreso (temporal) de esa fecha que lo traiga
      const incPorFecha = new Map<string, string>()
      for (const d of rows) {
        if (!PISO_TIPOS_INGRESO.has(d.tipo) || !d.codigo_inc) continue
        if (!incPorFecha.has(d.fecha_vencimiento)) incPorFecha.set(d.fecha_vencimiento, d.codigo_inc)
      }
      const bloqueId = entries[0].bloque_id
      const info = bloqueInfoMap.get(bloqueId)
      if (!info) continue
      for (const lot of remanentes.get(bloqueId) ?? []) {
        const locRow = entries[0].loc
        results.push({
          bloque_codigo: info.codigo,
          bloque_descripcion: info.descripcion,
          bloque_unidad: info.unidad,
          ubicacion: buildUbicacion(locRow),
          sector_nombre: locRow?.piso_posiciones?.piso_subcolumnas?.piso_columnas?.piso_sectores?.nombre ?? '',
          cantidad: lot.qty,
          fecha_vencimiento: lot.fecha,
          codigo_inc: incPorFecha.get(lot.fecha) || undefined,
          // IDs de navegación para el deep-link clickeable hacia Sectores
          sector_id: locRow?.piso_posiciones?.piso_subcolumnas?.piso_columnas?.sector_id,
          posicion_id: locRow?.posicion_id,
          posicion_numero: locRow?.piso_posiciones?.numero,
          columna_letra: locRow?.piso_posiciones?.piso_subcolumnas?.piso_columnas?.letra,
          subcolumna_codigo: locRow?.piso_posiciones?.piso_subcolumnas?.codigo,
        })
      }
    }

    // ─── 4. Orden FEFO global: lo más próximo a vencer primero, sin fecha al final ───
    return results
      .map((r) => ({ ...r, cantidad: Math.round(r.cantidad * 1000) / 1000 }))
      .filter((r) => r.cantidad > 0)
      .sort((a, b) => {
        if (a.fecha_vencimiento && b.fecha_vencimiento) return a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)
        if (a.fecha_vencimiento && !b.fecha_vencimiento) return -1
        if (!a.fecha_vencimiento && b.fecha_vencimiento) return 1
        if (a.bloque_codigo !== b.bloque_codigo) return a.bloque_codigo.localeCompare(b.bloque_codigo)
        return a.ubicacion.localeCompare(b.ubicacion)
      })
  } catch (err) {
    console.error('[stockPisoBuscar] Error:', err)
    throw err
  }
}

/** Tipo para la cadena de JOINs deep en piso_niveles */
type PisoNivelLoc = {
  posicion_id: string
  piso_posiciones: {
    numero: number
    subcolumna_id: string
    piso_subcolumnas: {
      codigo: string
      columna_id: string
      piso_columnas: {
        letra: string
        sector_id: string
        piso_sectores: {
          nombre: string
          n_columnas: number
          n_subcolumnas: number
        }
      }
    }
  }
}

/** Construye string de ubicación legible a partir de la cadena de JOINs */
function buildUbicacion(loc: PisoNivelLoc): string {
  if (!loc?.piso_posiciones) return ''
  const pos = loc.piso_posiciones
  const sub = pos.piso_subcolumnas
  const col = sub?.piso_columnas
  const sec = col?.piso_sectores
  if (!col || !sec) return `Pos ${pos.numero}`
  const numPos = pos.numero
  const letra = col.letra ?? ''
  const subCode = sub?.codigo ?? ''
  if (sec.n_columnas === 1 && sec.n_subcolumnas === 1) return `Pos ${numPos}`
  if (sec.n_subcolumnas === 1) return `${letra}-Pos ${numPos}`
  return `${letra}-${cleanSubcolCode(subCode, letra)}-Pos ${numPos}`
}

// ═══════════════════════════════════════════════════════════
//  VISTA COLUMNA — Tabla de posiciones × niveles
// ═══════════════════════════════════════════════════════════

export type VistaNivelStock = {
  nivelId: string
  nivelNumero: number
  bloques: { bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; codigo_inc: string }[]
}

export type VistaPosicion = {
  posicionId: string
  posicionNumero: number
  subcolumnaCodigo: string
  tieneInc: boolean
  niveles: VistaNivelStock[]
}

/**
 * Carga toda la información de una columna para la vista de tabla:
 * posiciones → niveles → stock por nivel (con detección de INC).
 * Usa ~4 queries en total (muy eficiente).
 */
export async function cargarVistaColumna(
  sectorId: string,
  columnaLetra: string
): Promise<VistaPosicion[]> {
  // 1. Obtener columna ID
  const { data: colData, error: colErr } = await dataClient
    .from('piso_columnas')
    .select('id')
    .eq('sector_id', sectorId)
    .eq('letra', columnaLetra)
    .single()
  // FIX auditoría Task 20 (E1): un error de consulta ya NO se traga devolviendo
  // [] (el usuario veía la columna vacía sin saber que falló). throw → el
  // consumidor principal (loadColumnDetail) ya muestra toast de error; el
  // refresh silencioso realtime conserva su .catch(() => {}) intencional.
  // !colData (columna sin fila) sigue siendo un estado legítimo → [].
  if (colErr) throw colErr
  if (!colData) return []

  // 2. Obtener subcolumnas → posiciones → niveles en una sola query anidada
  const { data: treeData, error: treeErr } = await dataClient
    .from('piso_subcolumnas')
    .select(`
      id, codigo,
      piso_posiciones(id, numero, piso_niveles(id, numero))
    `)
    .eq('columna_id', colData.id)
    .order('codigo')
  if (treeErr) throw treeErr
  if (!treeData) return []

  // Build flat structure
  type FlatNivel = { id: string; numero: number; posicionId: string; posicionNumero: number; subcolCodigo: string }
  const niveles: FlatNivel[] = []
  for (const sc of treeData as { id: string; codigo: string; piso_posiciones: { id: string; numero: number; piso_niveles: { id: string; numero: number }[] | null }[] }[]) {
    for (const pos of sc.piso_posiciones ?? []) {
      for (const niv of pos.piso_niveles ?? []) {
        niveles.push({
          id: niv.id,
          numero: niv.numero,
          posicionId: pos.id,
          posicionNumero: pos.numero,
          subcolCodigo: sc.codigo,
        })
      }
    }
  }

  if (niveles.length === 0) {
    // Return positions without niveles
    const cleanSubcol = (code: string) => {
      const idx = code.indexOf(columnaLetra)
      return idx >= 0 ? code.substring(idx) : code
    }
    const result: VistaPosicion[] = []
    for (const sc of treeData as { id: string; codigo: string; piso_posiciones: { id: string; numero: number; piso_niveles: unknown[] | null }[] }[]) {
      for (const pos of (sc.piso_posiciones ?? [])) {
        result.push({
          posicionId: pos.id,
          posicionNumero: pos.numero,
          subcolumnaCodigo: cleanSubcol(sc.codigo),
          tieneInc: false,
          niveles: [],
        })
      }
    }
    return result.sort((a, b) => a.posicionNumero - b.posicionNumero)
  }

  const nivelIds = niveles.map(n => n.id)

  // 3. Obtener TODOS los detalles de movimiento para estos niveles (1 sola query)
  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimiento_detalles')
    .select('nivel_id, bloque_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, codigo_inc)')
    .in('nivel_id', nivelIds)
  const movDetalles = (movData ?? []) as {
    nivel_id: string; bloque_id: string; cantidad: unknown; fecha_vencimiento: string | null;
    movimiento_id: string;
    piso_movimientos: { tipo: string; codigo_inc: string | null } | null | { tipo: string; codigo_inc: string | null }[]
  }[]

  // 4. Calcular stock por nivel por bloque (neto: ingresos - salidas)
  const isIngreso = (tipo: string) => tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion'
  const getMovInfo = (pm: typeof movDetalles[0]['piso_movimientos']): { tipo: string; codigo_inc: string } => {
    if (!pm) return { tipo: '', codigo_inc: '' }
    if (Array.isArray(pm)) return pm.length > 0 ? { tipo: pm[0].tipo, codigo_inc: pm[0].codigo_inc || '' } : { tipo: '', codigo_inc: '' }
    return { tipo: (pm as { tipo: string; codigo_inc: string | null }).tipo, codigo_inc: (pm as { tipo: string; codigo_inc: string | null }).codigo_inc || '' }
  }

  // Stock neto por (nivel_id, bloque_id): cantidad y si tiene INC
  const stockMap = new Map<string, { cantidad: number; codigo_inc: string }>()
  const bloqueIds = new Set<string>()

  for (const d of movDetalles) {
    const { tipo, codigo_inc } = getMovInfo(d.piso_movimientos)
    if (!tipo) continue
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    bloqueIds.add(d.bloque_id)
    const key = `${d.nivel_id}::${d.bloque_id}`
    const existing = stockMap.get(key) || { cantidad: 0, codigo_inc: '' }
    if (isIngreso(tipo)) {
      existing.cantidad += qty
      if (codigo_inc && !existing.codigo_inc) existing.codigo_inc = codigo_inc
    } else {
      existing.cantidad -= qty
    }
    stockMap.set(key, existing)
  }

  // 5. Obtener info de bloques — catálogo de Racks como fuente de verdad
  const bloqueInfoMap = await resolverInfoBloques([...bloqueIds])

  // 6. Build result: agrupar por posición
  const posMap = new Map<string, VistaPosicion>()
  for (const n of niveles) {
    const cleanCode = cleanSubcolCode(n.subcolCodigo, columnaLetra)
    if (!posMap.has(n.posicionId)) {
      posMap.set(n.posicionId, {
        posicionId: n.posicionId,
        posicionNumero: n.posicionNumero,
        subcolumnaCodigo: cleanCode,
        tieneInc: false,
        niveles: [],
      })
    }
    const pos = posMap.get(n.posicionId)!

    // Find stock items for this nivel
    // Redondeo defensivo a 3 decimales (precisión BD) ANTES del filtro > 0:
    // sin esto, un residuo flotante futuro se colaría como "artículo en 0" pegado.
    const items: VistaNivelStock['bloques'] = []
    for (const [key, val] of stockMap) {
      const [nId, bId] = key.split('::')
      const cant = Math.round(val.cantidad * 1000) / 1000
      if (nId !== n.id || cant <= 0) continue
      const info = bloqueInfoMap.get(bId) || { codigo: bId, descripcion: '', unidad: '' }
      items.push({
        bloque_codigo: info.codigo,
        bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad,
        cantidad: cant,
        codigo_inc: val.codigo_inc,
      })
      if (val.codigo_inc) pos.tieneInc = true
    }
    items.sort((a, b) => a.bloque_codigo.localeCompare(b.bloque_codigo))

    pos.niveles.push({
      nivelId: n.id,
      nivelNumero: n.numero,
      bloques: items,
    })
  }

  // Sort niveles within each position
  for (const pos of posMap.values()) {
    pos.niveles.sort((a, b) => a.nivelNumero - b.nivelNumero)
  }

  return [...posMap.values()].sort((a, b) => a.posicionNumero - b.posicionNumero)
}

// ═══════════════════════════════════════════════════════════════════
// EDITAR LOTE / F. VENCIMIENTO de artículos (2026-10-20, v2)
// v1: completar datos de artículos SIN lote/fechas.
// v2: también CORREGIR artículos que ya tienen lote/fechas — se apunta al
// bucket EXACTO (lote_actual + f_vencimiento_actual) en TODOS los niveles
// de la posición; parámetros opcionales con default "bucket vacío".
// ═══════════════════════════════════════════════════════════════════

export type EdicionLotePisoResultado = {
  filasActualizadas: number
  lote: string | null
  fVencimiento: string | null
}

/**
 * Guarda lote y/o fecha de vencimiento de UN bucket de un artículo (bloque
 * de Piso) en una posición, en TODOS sus niveles. La RPC (SECURITY DEFINER)
 * solo toca detalles cuyo (lote, fecha_vencimiento) coincide con el bucket
 * ACTUAL indicado; las cantidades no cambian, por lo que el saldo por lote
 * se conserva exacto — imposible fabricar negativos.
 *
 *  · `loteActual`/`fVencimientoActual` vacíos/ausentes → bucket "sin lote
 *    y sin fecha" (flujo original v1).
 *  · Con valores → corrección v2 (p.ej. lote mal digitado en el ingreso).
 *
 * Errores controlados que propaga (mensaje "CÓDIGO|detalle"):
 *   · SIN_DATOS — no llegó ni lote ni fecha.
 *   · SIN_FILAS — no hay filas de ese bucket exacto allí (ya corregido, o
 *     el lote/fecha actual no coincide).
 */
export async function editarLoteVencimientoPiso(params: {
  posicionId: string
  bloqueId: string
  lote?: string
  fVencimiento?: string
  /** Lote físico ACTUAL del bucket a editar ('' = sin lote). */
  loteActual?: string
  /** Fecha de vencimiento ACTUAL del bucket a editar ('' = sin fecha). */
  fVencimientoActual?: string
}): Promise<EdicionLotePisoResultado> {
  const { data, error } = await dataClient.rpc('editar_lote_vencimiento_piso', {
    p_posicion_id: params.posicionId,
    p_bloque_id: params.bloqueId,
    p_lote: params.lote?.trim() || null,
    p_f_vencimiento: params.fVencimiento?.trim() || null,
    p_lote_actual: params.loteActual?.trim() || null,
    p_f_vencimiento_actual: params.fVencimientoActual?.trim() || null,
  })
  if (error) throw error
  const d = (data ?? {}) as Record<string, unknown>
  return {
    filasActualizadas: Number(d.filas_actualizadas ?? 0),
    lote: (d.lote as string | null) ?? null,
    fVencimiento: (d.f_vencimiento as string | null) ?? null,
  }
}
