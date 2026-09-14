'use client'

import { dataClient } from '@/lib/supabase/client'
import { QUERY_TIMEOUT_MS } from '@/lib/rackly/constants'
import { isLoteUnsupportedError } from '@/lib/rackly/kardex'

/** Genera un UUID v4 simple (no requiere crypto.randomUUID que no está en todos los browsers) */
function generateUuidSync(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Elimina cabeceras huérfanas (sin detalles) para un set de IDs.
 *  Usado como rollback cuando la inserción de detalles falla. */
async function rollbackCabeceras(ids: string[], tag: string): Promise<void> {
  for (const id of ids) {
    await dataClient.from('piso_movimientos').delete().eq('id', id).catch((rbErr) => {
      console.error(`[${tag}] rollback de cabecera ${id} falló:`, rbErr)
    })
  }
}

/** Elimina detalles huérfanos para un set de movimiento_ids.
 *  Usado como rollback cuando la segunda parte de un traslado falla. */
async function rollbackDetalles(movIds: string[], tag: string): Promise<void> {
  for (const movId of movIds) {
    await dataClient.from('piso_movimiento_detalles').delete().eq('movimiento_id', movId).catch((rbErr) => {
      console.error(`[${tag}] rollback de detalles ${movId} falló:`, rbErr)
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

export type Bloque = {
  id: string
  codigo: string
  descripcion: string
  unidad: string
  created_at: string
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
  const { error } = await dataClient.from('piso_sectores').delete().eq('id', id)
  if (error) throw error
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

// ---- Bloques ----
export async function listarBloques(): Promise<Bloque[]> {
  const { data, error } = await dataClient
    .from('piso_bloques')
    .select('*')
    .order('codigo')
  if (error) throw error
  return (data ?? []) as Bloque[]
}

export async function crearBloque(
  codigo: string,
  descripcion: string,
  unidad: string
): Promise<Bloque[]> {
  const { error } = await dataClient.from('piso_bloques').insert({
    codigo: codigo.trim().toUpperCase(),
    descripcion,
    unidad,
  })
  if (error) throw error
  return listarBloques()
}

export async function eliminarBloque(id: string): Promise<Bloque[]> {
  const { error: errAsig } = await dataClient.from('piso_columna_bloques').delete().eq('bloque_id', id)
  if (errAsig) throw errAsig
  const { error } = await dataClient.from('piso_bloques').delete().eq('id', id)
  if (error) throw error
  return listarBloques()
}

/**
 * Reemplaza el catálogo de bloques de Piso con el contenido de un archivo.
 *
 * SEGURO (antes era destructivo): hacía DELETE de TODO + INSERT único en una
 * sola petición; si el insert fallaba (>1000 filas, payload, códigos duplicados),
 * la tabla quedaba VACÍA. Ahora:
 *  1) Normaliza y deduplica por código (conserva la última aparición del archivo).
 *  2) UPSERT por lotes ANTES de borrar nada — si algo falla, el catálogo actual
 *     queda intacto y se puede reintentar.
 *  3) Al final, poda SOLO los códigos que ya no vienen en el archivo (por lotes,
 *     no fatal: si no se pueden podar, el catálogo queda como superset válido).
 */
export async function reemplazarCatalogoBloques(
  items: { codigo: string; descripcion: string; unidad: string }[]
): Promise<{ bloques: Bloque[]; cargados: number; eliminados: number; errores: string[] }> {
  const errores: string[] = []
  // 1) Normalizar + deduplicar por código
  const mapa = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
  for (const i of items) {
    const codigo = i.codigo.trim().toUpperCase()
    if (!codigo) continue
    mapa.set(codigo, { codigo, descripcion: i.descripcion, unidad: i.unidad })
  }
  const rows = [...mapa.values()]

  // 2) Snapshot de los códigos actuales (para podar los que ya no vienen)
  const { data: actuales, error: errActuales } = await dataClient
    .from('piso_bloques')
    .select('id, codigo')
  if (errActuales) throw errActuales
  const actualesRows = (actuales ?? []) as unknown as { id: string; codigo: string }[]

  // 3) Upsert por lotes ANTES de borrar nada
  const CHUNK = 500
  let cargados = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await dataClient
      .from('piso_bloques')
      .upsert(chunk, { onConflict: 'codigo' })
    if (error) {
      // Fallback fila por fila para identificar la fila problemática y no perder el resto
      for (const r of chunk) {
        const { error: singleErr } = await dataClient
          .from('piso_bloques')
          .upsert(r, { onConflict: 'codigo' })
        if (singleErr) errores.push(`${r.codigo}: ${singleErr.message}`)
        else cargados++
      }
    } else {
      cargados += chunk.length
    }
  }

  // 4) Podar los códigos que ya no vienen en el archivo (por lotes, no fatal)
  const codigosArchivo = new Set(rows.map((r) => r.codigo))
  const aPodar = actualesRows.filter((b) => !codigosArchivo.has(b.codigo)).map((b) => b.id)
  let eliminados = 0
  for (let i = 0; i < aPodar.length; i += CHUNK) {
    const chunk = aPodar.slice(i, i + CHUNK)
    const { error } = await dataClient.from('piso_bloques').delete().in('id', chunk)
    if (error) {
      // No fatal: el catálogo nuevo ya está cargado; los obsoletos quedan y se avisan
      errores.push(`No se pudieron eliminar ${aPodar.length - i} bloque(s) obsoleto(s): ${error.message}`)
      break
    }
    eliminados += chunk.length
  }

  const bloques = await listarBloques()
  return { bloques, cargados, eliminados, errores }
}

// ---- Column-Block assignments ----
export async function listarBloquesDeColumna(
  columnaId: string
): Promise<Bloque[]> {
  const { data, error } = await dataClient
    .from('piso_columna_bloques')
    .select('bloque_id, piso_bloques(*)')
    .eq('columna_id', columnaId)
  if (error) throw error
  // Filtrar asignaciones huérfanas (piso_bloques null tras podas del catálogo)
  return ((data ?? []) as unknown as { bloque_id: string; piso_bloques: Bloque | null }[])
    .map((r) => r.piso_bloques)
    .filter((b): b is Bloque => b !== null)
}

export async function asignarBloqueAColumna(
  bloqueId: string,
  columnaId: string
) {
  const { error } = await dataClient
    .from('piso_columna_bloques')
    .insert({ bloque_id: bloqueId, columna_id: columnaId })
  if (error) throw error
}

export async function quitarBloqueDeColumna(
  bloqueId: string,
  columnaId: string
) {
  const { error } = await dataClient
    .from('piso_columna_bloques')
    .delete()
    .eq('bloque_id', bloqueId)
    .eq('columna_id', columnaId)
  if (error) throw error
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
  const { error: movErr } = await dataClient
    .from('piso_movimientos')
    .delete()
    .eq('id', movimientoId)
  if (movErr) throw movErr
}

/**
 * Select con filtro .in() por lotes de IDs. Una URL con miles de UUIDs puede
 * exceder límites del proxy (4xx) y PostgREST trunca a max_rows silenciosamente:
 * trocear garantiza resultados completos y error visible.
 */
async function selectIn<T>(
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

  // Paginación con límite razonable (máx 5,000 cabeceras)
  const PAGE_SIZE = 500
  const MAX_PAGES = 10
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

function lotesRestantesPorBloque(
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

  // Info de bloques
  const bloqueIds = [...lotesRestantes.keys()]
  const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
  const realIds = bloqueIds.filter((id) => !id.startsWith('cat_'))
  if (realIds.length > 0) {
    const { data: bloqData } = await dataClient.from('piso_bloques').select('id, codigo, descripcion, unidad').in('id', realIds)
    for (const b of (bloqData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[])
      bloqueInfoMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' })
  }
  const virtualIds = bloqueIds.filter((id) => id.startsWith('cat_'))
  if (virtualIds.length > 0) {
    const codes = virtualIds.map((id) => id.replace('cat_', ''))
    const { data: catData } = await dataClient.from('catalogo').select('codigo, descripcion, un').in('codigo', codes)
    for (const c of (catData ?? []) as { codigo: string; descripcion: string; un: string }[])
      bloqueInfoMap.set(`cat_${c.codigo}`, { codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
  }

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

  // Info de bloques
  const bloqueIds = [...lotesRestantes.keys()]
  const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
  const realIds = bloqueIds.filter((id) => !id.startsWith('cat_') && !id.startsWith('manual_'))
  if (realIds.length > 0) {
    const { data: bloqData } = await dataClient.from('piso_bloques').select('id, codigo, descripcion, unidad').in('id', realIds)
    for (const b of (bloqData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[])
      bloqueInfoMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' })
  }
  const virtualIds = bloqueIds.filter((id) => id.startsWith('cat_'))
  if (virtualIds.length > 0) {
    const codes = virtualIds.map((id) => id.replace('cat_', ''))
    const { data: catData } = await dataClient.from('catalogo').select('codigo, descripcion, un').in('codigo', codes)
    for (const c of (catData ?? []) as { codigo: string; descripcion: string; un: string }[])
      bloqueInfoMap.set(`cat_${c.codigo}`, { codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
  }
  // Handle manual_ IDs
  for (const id of bloqueIds) {
    if (id.startsWith('manual_') && !bloqueInfoMap.has(id)) {
      bloqueInfoMap.set(id, { codigo: id.replace('manual_', ''), descripcion: 'Articulo nuevo (manual)', unidad: 'KG' })
    }
  }

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
 * Registra un ingreso directo a una posición (sin pasar por el RPC completo).
 * Permite múltiples bloques en una sola posición.
 * Incluye uuid_sync para idempotencia: si ya existe una cabecera con el mismo
 * uuid_sync, la operación se considera exitosa (no duplica).
 * Si los detalles fallan, hace rollback de la cabecera.
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

  // Idempotencia: verificar si ya existe una cabecera con este uuid_sync
  const { data: existing } = await dataClient
    .from('piso_movimientos')
    .select('id')
    .eq('uuid_sync', uuidSync)
    .maybeSingle()
  if (existing) return // Ya registrado, operación idempotente

  // Crear cabecera
  const insertPayload: Record<string, unknown> = {
    tipo: 'ingreso',
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
  const movimientoId = (movData as { id: string }).id

  // Crear detalles (con lote físico si se digitó; fallback sin lote si la columna no existe)
  const { rows: detRows, tieneLote } = buildDetRows(movimientoId, detalles)
  if (detRows.length > 0) {
    try {
      await insertDetallesPiso(detRows, tieneLote, 'registrarIngresoPosicion')
    } catch (detErr) {
      // Rollback: eliminar cabecera huérfana
      console.error('[registrarIngresoPosicion] Error insertando detalles, haciendo rollback:', (detErr as { message?: string }).message)
      await rollbackCabeceras([movimientoId], 'registrarIngresoPosicion')
      throw detErr
    }
  }
}

/**
 * Registra una salida de stock de una posición.
 * Incluye uuid_sync para idempotencia.
 * Si los detalles fallan, hace rollback de la cabecera.
 */
export async function registrarSalidaPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[]
): Promise<void> {
  const uuidSync = generateUuidSync()

  // Idempotencia
  const { data: existing } = await dataClient
    .from('piso_movimientos')
    .select('id')
    .eq('uuid_sync', uuidSync)
    .maybeSingle()
  if (existing) return

  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'salida', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo, uuid_sync: uuidSync })
    .select('id')
    .single()
  if (movErr) throw movErr
  const movimientoId = (movData as { id: string }).id

  const { rows: detRows, tieneLote } = buildDetRows(movimientoId, detalles)
  if (detRows.length > 0) {
    try {
      await insertDetallesPiso(detRows, tieneLote, 'registrarSalidaPosicion')
    } catch (detErr) {
      console.error('[registrarSalidaPosicion] Error insertando detalles, haciendo rollback:', (detErr as { message?: string }).message)
      await rollbackCabeceras([movimientoId], 'registrarSalidaPosicion')
      throw detErr
    }
  }
}

/**
 * Registra una devolución de stock a una posición.
 * Funciona como un ingreso pero con tipo 'devolucion'.
 * Incluye uuid_sync para idempotencia.
 * Si los detalles fallan, hace rollback de la cabecera.
 */
export async function registrarDevolucionPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: DetalleInput[]
): Promise<void> {
  const uuidSync = generateUuidSync()

  // Idempotencia
  const { data: existing } = await dataClient
    .from('piso_movimientos')
    .select('id')
    .eq('uuid_sync', uuidSync)
    .maybeSingle()
  if (existing) return

  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'devolucion', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo, uuid_sync: uuidSync })
    .select('id')
    .single()
  if (movErr) throw movErr
  const movimientoId = (movData as { id: string }).id

  const { rows: detRows, tieneLote } = buildDetRows(movimientoId, detalles)
  if (detRows.length > 0) {
    try {
      await insertDetallesPiso(detRows, tieneLote, 'registrarDevolucionPosicion')
    } catch (detErr) {
      console.error('[registrarDevolucionPosicion] Error insertando detalles, haciendo rollback:', (detErr as { message?: string }).message)
      await rollbackCabeceras([movimientoId], 'registrarDevolucionPosicion')
      throw detErr
    }
  }
}

/**
 * Registra un traslado entre posiciones del mismo sector.
 * Crea una salida en el origen y un ingreso en el destino.
 * Ambas cabeceras comparten un uuid_sync para detectar traslados parciales.
 * Si cualquier paso falla, hace rollback completo.
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

  // Idempotencia: si ya existen 2 movimientos con este uuid_sync, ya fue procesado
  const { data: existingMovs, error: checkErr } = await dataClient
    .from('piso_movimientos')
    .select('id')
    .eq('uuid_sync', uuidSync)
  if (checkErr) throw checkErr
  if (existingMovs && existingMovs.length >= 2) return // Traslado ya registrado

  // Si hay exactamente 1 movimiento, es un traslado parcial — limpiar y reintentar
  if (existingMovs && existingMovs.length === 1) {
    console.warn('[registrarTrasladoPosicion] Traslado parcial detectado, limpiando:', uuidSync)
    const partialId = (existingMovs[0] as { id: string }).id
    await rollbackDetalles([partialId], 'registrarTrasladoPosicion-partial')
    await rollbackCabeceras([partialId], 'registrarTrasladoPosicion-partial')
  }

  // Crear movimiento de salida (origen)
  const { data: salData, error: salErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'salida', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo, uuid_sync: uuidSync })
    .select('id')
    .single()
  if (salErr) throw salErr
  const salId = (salData as { id: string }).id

  // Crear movimiento de ingreso (destino)
  const { data: ingData, error: ingErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'ingreso', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo, uuid_sync: uuidSync })
    .select('id')
    .single()
  if (ingErr) {
    console.error('[registrarTrasladoPosicion] Error creando ingreso, haciendo rollback de salida:', ingErr.message)
    await rollbackCabeceras([salId], 'registrarTrasladoPosicion')
    throw ingErr
  }
  const ingId = (ingData as { id: string }).id

  // Insertar detalles de salida (con lote si se digitó; el traslado lo propaga al destino)
  const salRows = buildDetRows(salId, detallesSalida)
  if (salRows.rows.length > 0) {
    try {
      await insertDetallesPiso(salRows.rows, salRows.tieneLote, 'registrarTrasladoPosicion')
    } catch (salDetErr) {
      console.error('[registrarTrasladoPosicion] Error en detalles salida, rollback completo:', (salDetErr as { message?: string }).message)
      await rollbackDetalles([salId, ingId], 'registrarTrasladoPosicion')
      await rollbackCabeceras([salId, ingId], 'registrarTrasladoPosicion')
      throw salDetErr
    }
  }

  // Insertar detalles de ingreso (destino)
  const ingRows = buildDetRows(ingId, detallesIngreso)
  if (ingRows.rows.length > 0) {
    try {
      await insertDetallesPiso(ingRows.rows, ingRows.tieneLote, 'registrarTrasladoPosicion')
    } catch (ingDetErr) {
      console.error('[registrarTrasladoPosicion] Error en detalles ingreso, rollback completo:', (ingDetErr as { message?: string }).message)
      await rollbackDetalles([salId, ingId], 'registrarTrasladoPosicion')
      await rollbackCabeceras([salId, ingId], 'registrarTrasladoPosicion')
      throw ingDetErr
    }
  }
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
    if (stock > 0) {
      results.push({ nivel_id: nivelId, nivel_numero: nivelMap.get(nivelId) ?? 0, bloque_codigo: '', cantidad: stock })
    }
  }
  return results
}

/**
 * Lista bloques disponibles para selección.
 * Busca en piso_bloques PRIMERO y luego en catalogo (Racks) como respaldo.
 * Fusiona ambos resultados sin duplicar por código.
 */
export async function listarBloquesParaSelect(): Promise<{ id: string; codigo: string; descripcion: string; unidad: string }[]> {
  const results: { id: string; codigo: string; descripcion: string; unidad: string }[] = []
  const seen = new Map<string, boolean>()

  // 1. piso_bloques (tabla local de Piso)
  try {
    const { data, error } = await dataClient
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .order('codigo')
    if (error) console.error('[Piso] Error consultando piso_bloques:', error.message)
    for (const b of (data ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[]) {
      const code = (b.codigo ?? '').trim().toUpperCase()
      if (code && !seen.has(code)) {
        seen.set(code, true)
        results.push({
          id: b.id,
          codigo: code,
          descripcion: b.descripcion ?? '',
          unidad: b.unidad ?? '',
        })
      }
    }
    // items loaded from piso_bloques
  } catch (err) { console.error('[Piso] Error en piso_bloques:', err) }

  // 2. catalogo (tabla de Racks como respaldo)
  try {
    const { data, error } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .order('codigo')
    if (error) console.error('[Piso] Error consultando catalogo:', error.message)
    for (const c of (data ?? []) as { codigo: string; descripcion: string; un: string }[]) {
      const code = (c.codigo ?? '').trim().toUpperCase()
      if (code && !seen.has(code)) {
        seen.set(code, true)
        results.push({
          id: `cat_${code}`, // ID virtual para items del catálogo de Racks
          codigo: code,
          descripcion: c.descripcion ?? '',
          unidad: c.un ?? '',
        })
      }
    }
    // items merged from catalogo backup
  } catch (err) { console.error('[Piso] Error en catalogo:', err) }

  return results
}

/**
 * Busca un bloque por código exacto. Busca en piso_bloques primero, luego en catalogo.
 * Si lo encuentra en catalogo pero no en piso_bloques, lo crea automáticamente
 * (es legítimo: el producto existe en el sistema de Racks).
 * Si no se encuentra en ninguna tabla, retorna null (no auto-crea para evitar bloques basura).
 */
export async function buscarBloquePorCodigo(codigo: string): Promise<{ id: string; codigo: string; descripcion: string; unidad: string } | null> {
  const target = codigo.trim().toUpperCase()
  if (!target) return null

  // 1. Buscar en piso_bloques
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

  // 2. Buscar en catalogo (Racks) — si existe, auto-crear en piso_bloques
  try {
    const { data, error } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .eq('codigo', target)
      .limit(1)
    if (error) console.error('[Piso] Error buscando en catalogo:', error.message)
    if (data && data.length > 0) {
      const c = data[0] as { codigo: string; descripcion: string; un: string }
      // Auto-crear en piso_bloques para futuro uso (producto legítimo del catálogo)
      try {
        const { data: inserted } = await dataClient
          .from('piso_bloques')
          .insert({ codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
          .select('id')
          .single()
        if (inserted) {
          return {
            id: (inserted as { id: string }).id,
            codigo: c.codigo,
            descripcion: c.descripcion ?? '',
            unidad: c.un ?? '',
          }
        }
      } catch (insertErr) { console.warn('[Piso] Auto-create piso_bloques falló, usando ID virtual:', insertErr) }
      return { id: `cat_${c.codigo}`, codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' }
    }
  } catch (err) { console.error('[Piso] Error en búsqueda catalogo:', err) }

  // 3. No encontrado en ninguna tabla — retornar null (no auto-crear bloques basura)
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
      .select('bloque_id, nivel_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, codigo_inc)')
      .range(detFrom, detTo)
    if (detErr) throw detErr
    const rows = pageData ?? []
    allDetData.push(...rows)
    if (rows.length < DET_PAGE_SIZE) break
    detFrom += DET_PAGE_SIZE
  }
  if (allDetData.length === 0) return []

  // 2. Group by (bloque_id, nivel_id)
  const isIngresoType = (tipo: string) =>
    tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion'
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
    piso_movimientos: { tipo: string; codigo_inc?: string | null } | null | { tipo: string; codigo_inc?: string | null }[]
  }
  const rawDets = allDetData as RawDet[]

  const blockNivelMap = new Map<string, { bloque_id: string; nivel_id: string; tipo: string; cantidad: number; fecha_vencimiento: string; codigo_inc: string }[]>()
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
    const codigoInc = getCodigoInc(d.piso_movimientos)
    const key = `${d.bloque_id}__${d.nivel_id}`
    const arr = blockNivelMap.get(key) ?? []
    arr.push({ bloque_id: d.bloque_id, nivel_id: d.nivel_id, tipo, cantidad: qty, fecha_vencimiento: fv, codigo_inc: codigoInc })
    blockNivelMap.set(key, arr)
  }

  // 3. FEFO per (bloque_id, nivel_id)
  const fefoResults: { bloque_id: string; nivel_id: string; cantidad: number; fecha_vencimiento: string; codigo_inc: string }[] = []
  for (const [key, details] of blockNivelMap) {
    const ingresoPool = new Map<string, { cantidad: number; codigo_inc: string }>()
    let totalExit = 0
    for (const d of details) {
      if (isIngresoType(d.tipo)) {
        const existing = ingresoPool.get(d.fecha_vencimiento)
        if (existing) {
          existing.cantidad += d.cantidad
          if (!existing.codigo_inc && d.codigo_inc) existing.codigo_inc = d.codigo_inc
        } else {
          ingresoPool.set(d.fecha_vencimiento, { cantidad: d.cantidad, codigo_inc: d.codigo_inc })
        }
      } else {
        totalExit += d.cantidad
      }
    }
    const sortedLots = [...ingresoPool.entries()].sort(([a], [b]) => {
      if (!a && b) return 1
      if (a && !b) return -1
      return a.localeCompare(b)
    })
    let pendiente = totalExit
    for (const [fecha, pool] of sortedLots) {
      if (pendiente <= 0) {
        fefoResults.push({ bloque_id: details[0].bloque_id, nivel_id: details[0].nivel_id, cantidad: pool.cantidad, fecha_vencimiento: fecha, codigo_inc: pool.codigo_inc })
      } else if (pool.cantidad <= pendiente) {
        pendiente -= pool.cantidad
      } else {
        fefoResults.push({ bloque_id: details[0].bloque_id, nivel_id: details[0].nivel_id, cantidad: pool.cantidad - pendiente, fecha_vencimiento: fecha, codigo_inc: pool.codigo_inc })
        pendiente = 0
      }
    }
  }

  if (fefoResults.length === 0) return []

  // 4. Resolve bloque info
  const bloqueIds = [...new Set(fefoResults.map(r => r.bloque_id))]
  const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
  const realIds = bloqueIds.filter(id => !id.startsWith('cat_') && !id.startsWith('manual_'))
  if (realIds.length > 0) {
    const { data: bData } = await dataClient.from('piso_bloques').select('id, codigo, descripcion, unidad').in('id', realIds)
    for (const b of (bData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[])
      bloqueInfoMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' })
  }
  const catIds = bloqueIds.filter(id => id.startsWith('cat_'))
  if (catIds.length > 0) {
    const codes = catIds.map(id => id.replace('cat_', ''))
    const { data: cData } = await dataClient.from('catalogo').select('codigo, descripcion, un').in('codigo', codes)
    for (const c of (cData ?? []) as { codigo: string; descripcion: string; un: string }[])
      bloqueInfoMap.set(`cat_${c.codigo}`, { codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
  }
  for (const id of bloqueIds) {
    if (id.startsWith('manual_') && !bloqueInfoMap.has(id))
      bloqueInfoMap.set(id, { codigo: id.replace('manual_', ''), descripcion: 'Articulo nuevo', unidad: 'KG' })
  }

  // 5. Resolve location for each nivel_id
  const nivelIds = [...new Set(fefoResults.map(r => r.nivel_id))]
  const locMap = new Map<string, { ubicacion: string; sector_nombre: string }>()
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
    console.error('[stockPisoGlobal] Error consultando stock de Piso:', err)
    return []
  }
}

/**
 * Busca stock en Piso para UN código específico.
 * Usa dataClient (service role) con JOINs profundos para resolver
 * toda la cadena de ubicación en una sola query, evitando la cadena
 * de 6-7 queries secuenciales que causaba loading infinito.
 */
export async function stockPisoPorCodigo(codigo: string): Promise<StockPisoItem[]> {
  const code = codigo.trim().toUpperCase()

  // ─── TIMEOUT: seguridad contra hang ───
  const TIMEOUT_MS = QUERY_TIMEOUT_MS
  const result = await Promise.race([
    _stockPisoPorCodigoImpl(code),
    new Promise<StockPisoItem[]>((resolve) =>
      setTimeout(() => {
        console.warn('[stockPisoPorCodigo] TIMEOUT', TIMEOUT_MS, 'ms')
        resolve([])
      }, TIMEOUT_MS)
    ),
  ])
  return result
}

async function _stockPisoPorCodigoImpl(code: string): Promise<StockPisoItem[]> {
  try {
    // ─── 1. Buscar bloque por código ───
    const { data: bloques, error: errB } = await dataClient
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .ilike('codigo', code)
    if (errB) {
      console.warn('[stockPisoPorCodigo] Error buscando bloques:', errB.message)
      return []
    }
    if (!bloques || bloques.length === 0) return []

    const bloqueIds = bloques.map((b: { id: string }) => b.id)
    const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
    for (const b of bloques as { id: string; codigo: string; descripcion: string; unidad: string }[]) {
      bloqueInfoMap.set(b.id, {
        codigo: b.codigo ?? '',
        descripcion: b.descripcion ?? '',
        unidad: b.unidad ?? 'KG',
      })
    }

    // ─── 2. Detalles de movimiento con JOIN profundo: movimiento + nivel → posicion → subcolumna → columna → sector ───
    // Una sola query que resuelve toda la cadena de ubicación
    const { data: detalles, error: errD } = await dataClient
      .from('piso_movimiento_detalles')
      .select(`
        bloque_id,
        nivel_id,
        cantidad,
        fecha_vencimiento,
        piso_movimientos(tipo, codigo_inc),
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
    if (errD) {
      console.warn('[stockPisoPorCodigo] Error detalles:', errD.message)
      return []
    }
    if (!detalles || detalles.length === 0) return []

    // ─── 3. FEFO calculation ───
    type DetRow = {
      bloque_id: string
      nivel_id: string
      cantidad: unknown
      fecha_vencimiento?: string | null
      piso_movimientos: { tipo: string; codigo_inc: string | null } | null | { tipo: string; codigo_inc: string | null }[]
      piso_niveles: PisoNivelLoc
    }

    const getTipo = (pm: { tipo?: string } | { tipo?: string }[] | null): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? pm[0].tipo ?? '' : ''
      return pm.tipo ?? ''
    }
    const getCodigoInc = (pm: { codigo_inc?: string | null } | { codigo_inc?: string | null }[] | null): string => {
      if (!pm) return ''
      if (Array.isArray(pm)) return pm.length > 0 ? pm[0].codigo_inc || '' : ''
      return pm.codigo_inc || ''
    }
    const isIngreso = (t: string) => t === 'ingreso' || t === 'stock_inicial' || t === 'devolucion'

    // Group by (bloque_id, nivel_id)
    const groups = new Map<string, {
      bloque_id: string
      nivel_id: string
      tipo: string
      cantidad: number
      fecha_vencimiento: string
      codigo_inc: string
      loc: DetRow['piso_niveles']
    }[]>()

    for (const d of detalles as DetRow[]) {
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
        loc: d.piso_niveles,
      })
      groups.set(key, arr)
    }

    // FEFO per group
    const results: StockPisoItem[] = []
    for (const [, entries] of groups) {
      const ingresoPool = new Map<string, { cantidad: number; codigo_inc: string }>()
      let totalExit = 0
      for (const e of entries) {
        if (isIngreso(e.tipo)) {
          const existing = ingresoPool.get(e.fecha_vencimiento)
          if (existing) {
            existing.cantidad += e.cantidad
            if (!existing.codigo_inc && e.codigo_inc) existing.codigo_inc = e.codigo_inc
          } else {
            ingresoPool.set(e.fecha_vencimiento, { cantidad: e.cantidad, codigo_inc: e.codigo_inc })
          }
        } else {
          totalExit += e.cantidad
        }
      }
      const sortedLots = [...ingresoPool.entries()].sort(([a], [b]) => {
        if (!a && b) return 1
        if (a && !b) return -1
        return a.localeCompare(b)
      })
      let pendiente = totalExit
      for (const [fecha, pool] of sortedLots) {
        if (pendiente <= 0) {
          // Lote completo disponible
          const e = entries[0]
          results.push({
            bloque_codigo: bloqueInfoMap.get(e.bloque_id)?.codigo ?? e.bloque_id,
            bloque_descripcion: bloqueInfoMap.get(e.bloque_id)?.descripcion ?? '',
            bloque_unidad: bloqueInfoMap.get(e.bloque_id)?.unidad ?? 'KG',
            ubicacion: buildUbicacion(e.loc),
            sector_nombre: e.loc?.piso_posiciones?.piso_subcolumnas?.piso_columnas?.piso_sectores?.nombre ?? '',
            cantidad: Math.round(pool.cantidad * 1000) / 1000,
            fecha_vencimiento: fecha,
            codigo_inc: pool.codigo_inc || undefined,
          })
        } else if (pool.cantidad <= pendiente) {
          pendiente -= pool.cantidad
        } else {
          const remaining = pool.cantidad - pendiente
          pendiente = 0
          const e = entries[0]
          results.push({
            bloque_codigo: bloqueInfoMap.get(e.bloque_id)?.codigo ?? e.bloque_id,
            bloque_descripcion: bloqueInfoMap.get(e.bloque_id)?.descripcion ?? '',
            bloque_unidad: bloqueInfoMap.get(e.bloque_id)?.unidad ?? 'KG',
            ubicacion: buildUbicacion(e.loc),
            sector_nombre: e.loc?.piso_posiciones?.piso_subcolumnas?.piso_columnas?.piso_sectores?.nombre ?? '',
            cantidad: Math.round(remaining * 1000) / 1000,
            fecha_vencimiento: fecha,
            codigo_inc: pool.codigo_inc || undefined,
          })
        }
      }
    }

    return results.sort((a, b) => {
      if (a.fecha_vencimiento && b.fecha_vencimiento) return a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)
      if (a.fecha_vencimiento && !b.fecha_vencimiento) return -1
      if (!a.fecha_vencimiento && b.fecha_vencimiento) return 1
      return a.ubicacion.localeCompare(b.ubicacion)
    })
  } catch (err) {
    console.error('[stockPisoPorCodigo] Error:', err)
    return []
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
  if (colErr || !colData) return []

  // 2. Obtener subcolumnas → posiciones → niveles en una sola query anidada
  const { data: treeData, error: treeErr } = await dataClient
    .from('piso_subcolumnas')
    .select(`
      id, codigo,
      piso_posiciones(id, numero, piso_niveles(id, numero))
    `)
    .eq('columna_id', colData.id)
    .order('codigo')
  if (treeErr || !treeData) return []

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

  // 5. Obtener info de bloques (1 query)
  const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()
  const realIds = [...bloqueIds].filter(id => !id.startsWith('cat_') && !id.startsWith('manual_'))
  if (realIds.length > 0) {
    const { data: bData } = await dataClient.from('piso_bloques').select('id, codigo, descripcion, unidad').in('id', realIds)
    for (const b of (bData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[]) {
      bloqueInfoMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' })
    }
  }
  const catIds = [...bloqueIds].filter(id => id.startsWith('cat_'))
  if (catIds.length > 0) {
    const codes = catIds.map(id => id.replace('cat_', ''))
    const { data: cData } = await dataClient.from('catalogo').select('codigo, descripcion, un').in('codigo', codes)
    for (const c of (cData ?? []) as { codigo: string; descripcion: string; un: string }[]) {
      bloqueInfoMap.set(`cat_${c.codigo}`, { codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
    }
  }

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
    const items: VistaNivelStock['bloques'] = []
    for (const [key, val] of stockMap) {
      const [nId, bId] = key.split('::')
      if (nId !== n.id || val.cantidad <= 0) continue
      const info = bloqueInfoMap.get(bId) || { codigo: bId, descripcion: '', unidad: '' }
      items.push({
        bloque_codigo: info.codigo,
        bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad,
        cantidad: Math.round(val.cantidad * 1000) / 1000,
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
