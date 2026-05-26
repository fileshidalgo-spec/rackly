'use client'

import { dataClient } from '@/lib/supabase/client'

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
}

export type MovimientoConDetalles = PisoMovimiento & {
  detalles: (MovimientoDetalle & {
    bloque_codigo?: string
    nivel_codigo?: string
  })[]
}

export type DetalleInput = {
  nivel_id: string
  bloque_id: string
  cantidad: number
  fecha_vencimiento?: string | null
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
  await dataClient.from('piso_columna_bloques').delete().eq('bloque_id', id)
  const { error } = await dataClient.from('piso_bloques').delete().eq('id', id)
  if (error) throw error
  return listarBloques()
}

export async function reemplazarCatalogoBloques(
  items: { codigo: string; descripcion: string; unidad: string }[]
): Promise<Bloque[]> {
  await dataClient.from('piso_bloques').delete().neq('id', '')
  if (items.length === 0) return []
  const rows = items.map((i) => ({
    codigo: i.codigo.trim().toUpperCase(),
    descripcion: i.descripcion,
    unidad: i.unidad,
  }))
  const { error } = await dataClient.from('piso_bloques').insert(rows)
  if (error) throw error
  return listarBloques()
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
  return ((data ?? []) as unknown as { bloque_id: string; piso_bloques: Bloque }[]).map(
    (r) => r.piso_bloques
  )
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
  const result = data as unknown[]
  return result[0] as PisoMovimiento
}

export async function listarMovimientos(
  sectorId?: string,
  columnaId?: string,
  bloqueId?: string,
  desde?: string,
  hasta?: string
): Promise<MovimientoConDetalles[]> {
  let query = dataClient
    .from('piso_movimientos')
    .select('*')
    .order('fecha', { ascending: false })
    .order('numero_operacion', { ascending: false })

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta + 'T23:59:59')
  const PAGE_SIZE = 500
  const MAX_PAGES = 100
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

  const movIds = all.map((m) => m.id)
  const { data: detData, error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .select('*')
    .in('movimiento_id', movIds)
  if (detErr) throw detErr
  const detalles = (detData ?? []) as MovimientoDetalle[]

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

  const [bloquesRes, nivelesRes] = await Promise.all([
    blockIds.length > 0
      ? dataClient
          .from('piso_bloques')
          .select('id, codigo')
          .in('id', blockIds)
      : Promise.resolve({ data: [], error: null }),
    nivelIds.length > 0
      ? dataClient
          .from('piso_niveles')
          .select('id, codigo_ubicacion')
          .in('id', nivelIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  const bloqueMap = new Map<string, string>()
  ;((bloquesRes.data ?? []) as { id: string; codigo: string }[]).forEach(
    (b) => bloqueMap.set(b.id, b.codigo)
  )
  const nivelMap = new Map<string, string | null>()
  ;(
    (nivelesRes.data ?? []) as { id: string; codigo_ubicacion: string | null }[]
  ).forEach((n) => nivelMap.set(n.id, n.codigo_ubicacion))

  let result = all.map((m) => ({
    ...m,
    detalles: (detalleMap.get(m.id) ?? []).map((d) => ({
      ...d,
      bloque_codigo: bloqueMap.get(d.bloque_id),
      nivel_codigo: nivelMap.get(d.nivel_id) ?? undefined,
    })),
  }))

  // Filter by sector/columna/bloque if specified
  if (sectorId || columnaId || bloqueId) {
    if (columnaId) {
      const { data: cols, error: colErr } = await dataClient
        .from('piso_columnas')
        .select('id')
        .eq('sector_id', sectorId ?? columnaId)
      if (!colErr && cols) {
        const colIds = new Set(
          (cols as { id: string }[]).map((c) => c.id)
        )
        if (!colIds.has(columnaId)) {
          return []
        }
      }
    }
  }

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
  ]
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
    .filter(([, qty]) => qty > 0)
    .map(([bloque_codigo, cantidad]) => ({ bloque_codigo, cantidad }))
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
 */
export async function cargarPosicionesSector(
  sectorId: string
): Promise<PosicionConStock[]> {
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

    // Filtrar solo stock positivo
    for (const [nivelId, bloques] of stockMap) {
      for (const b of bloques) {
        if (b.cantidad > 0) {
          stockPorNivel.push({ nivel_id: nivelId, bloque_id: b.bloque_id, cantidad: b.cantidad, tipo: '' })
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
    return {
      posicionId: pos.id,
      posicionNumero: pos.numero,
      subcolumnaCodigo: sub?.codigo ?? '',
      columnaLetra: sub ? (colMap.get(sub.columna_id) ?? '') : '',
      stock: totalStock,
      bloques,
    }
  })

  return result
}

/**
 * Obtiene el stock detallado de una posición específica (todos los bloques y cantidades).
 */
export async function stockDetallePosicion(
  posicionId: string
): Promise<{ bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number }[]> {
  // Obtener niveles de esta posición
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('id')
    .eq('posicion_id', posicionId)
  if (nivErr) throw nivErr
  const nivelIds = ((nivData ?? []) as { id: string }[]).map((n) => n.id)

  if (nivelIds.length === 0) return []

  // Obtener detalles de movimiento con stock
  const { data: detData, error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .select('bloque_id, cantidad, movimiento_id, piso_movimientos(tipo)')
    .in('nivel_id', nivelIds)
  if (detErr) throw detErr

  // Calcular stock neto por bloque
  const stockMap = new Map<string, number>()
  for (const d of (detData ?? []) as unknown as {
    bloque_id: string; cantidad: unknown; piso_movimientos: { tipo: string }
  }[]) {
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    const delta = (d.piso_movimientos.tipo === 'ingreso' || d.piso_movimientos.tipo === 'stock_inicial' || d.piso_movimientos.tipo === 'devolucion')
      ? qty : -qty
    const current = stockMap.get(d.bloque_id) ?? 0
    stockMap.set(d.bloque_id, current + delta)
  }

  // Obtener info de bloques
  const bloqueIds = [...stockMap.keys()].filter((id) => (stockMap.get(id) ?? 0) > 0)
  if (bloqueIds.length === 0) return []

  const bloqueInfoMap = new Map<string, { codigo: string; descripcion: string; unidad: string }>()

  // Buscar en piso_bloques (solo IDs reales)
  const realIds = bloqueIds.filter((id) => !id.startsWith('cat_'))
  if (realIds.length > 0) {
    const { data: bloqData } = await dataClient
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .in('id', realIds)
    for (const b of (bloqData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[]) {
      bloqueInfoMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' })
    }
  }
  // Para IDs virtuales, buscar en catalogo
  const virtualIds = bloqueIds.filter((id) => id.startsWith('cat_'))
  if (virtualIds.length > 0) {
    const codes = virtualIds.map((id) => id.replace('cat_', ''))
    const { data: catData } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .in('codigo', codes)
    for (const c of (catData ?? []) as { codigo: string; descripcion: string; un: string }[]) {
      bloqueInfoMap.set(`cat_${c.codigo}`, { codigo: c.codigo, descripcion: c.descripcion ?? '', unidad: c.un ?? '' })
    }
  }

  return bloqueIds
    .filter((id) => bloqueInfoMap.has(id))
    .map((id) => {
      const info = bloqueInfoMap.get(id)!
      return {
        bloque_id: id,
        bloque_codigo: info.codigo,
        bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad || 'KG',
        cantidad: Math.round((stockMap.get(id) ?? 0) * 1000) / 1000,
      }
    })
}

/**
 * Registra un ingreso directo a una posición (sin pasar por el RPC completo).
 * Permite múltiples bloques en una sola posición.
 */
export async function registrarIngresoPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[]
): Promise<void> {
  // Crear cabecera
  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'ingreso', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo })
    .select('id')
    .single()
  if (movErr) throw movErr
  const movimientoId = (movData as { id: string }).id

  // Crear detalles
  if (detalles.length > 0) {
    const detRows = detalles.map((d) => ({
      movimiento_id: movimientoId,
      nivel_id: d.nivel_id,
      bloque_id: d.bloque_id,
      cantidad: d.cantidad,
      ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
    }))
    const { error: detErr } = await dataClient
      .from('piso_movimiento_detalles')
      .insert(detRows)
    if (detErr) throw detErr
  }
}

/**
 * Registra una salida de stock de una posición.
 */
export async function registrarSalidaPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: { nivel_id: string; bloque_id: string; cantidad: number }[]
): Promise<void> {
  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'salida', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo })
    .select('id')
    .single()
  if (movErr) throw movErr
  const movimientoId = (movData as { id: string }).id

  if (detalles.length > 0) {
    const detRows = detalles.map((d) => ({
      movimiento_id: movimientoId,
      nivel_id: d.nivel_id,
      bloque_id: d.bloque_id,
      cantidad: d.cantidad,
    }))
    const { error: detErr } = await dataClient
      .from('piso_movimiento_detalles')
      .insert(detRows)
    if (detErr) throw detErr
  }
}

/**
 * Registra una devolución de stock a una posición.
 * Funciona como un ingreso pero con tipo 'devolucion'.
 */
export async function registrarDevolucionPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[]
): Promise<void> {
  const { data: movData, error: movErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'devolucion', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo })
    .select('id')
    .single()
  if (movErr) throw movErr
  const movimientoId = (movData as { id: string }).id

  if (detalles.length > 0) {
    const detRows = detalles.map((d) => ({
      movimiento_id: movimientoId,
      nivel_id: d.nivel_id,
      bloque_id: d.bloque_id,
      cantidad: d.cantidad,
      ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
    }))
    const { error: detErr } = await dataClient
      .from('piso_movimiento_detalles')
      .insert(detRows)
    if (detErr) throw detErr
  }
}

/**
 * Registra un traslado entre posiciones del mismo sector.
 * Crea una salida en el origen y un ingreso en el destino.
 */
export async function registrarTrasladoPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detallesSalida: { nivel_id: string; bloque_id: string; cantidad: number }[],
  detallesIngreso: { nivel_id: string; bloque_id: string; cantidad: number }[]
): Promise<void> {
  // Crear movimiento de salida (origen)
  const { data: salData, error: salErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'salida', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo })
    .select('id')
    .single()
  if (salErr) throw salErr

  // Crear movimiento de ingreso (destino) con tipo 'ingreso'
  const { data: ingData, error: ingErr } = await dataClient
    .from('piso_movimientos')
    .insert({ tipo: 'ingreso', turno, usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_correo: usuarioCorreo })
    .select('id')
    .single()
  if (ingErr) throw ingErr

  // Insertar detalles de salida
  if (detallesSalida.length > 0) {
    await dataClient.from('piso_movimiento_detalles').insert(
      detallesSalida.map((d) => ({ movimiento_id: (salData as { id: string }).id, nivel_id: d.nivel_id, bloque_id: d.bloque_id, cantidad: d.cantidad }))
    )
  }

  // Insertar detalles de ingreso
  if (detallesIngreso.length > 0) {
    await dataClient.from('piso_movimiento_detalles').insert(
      detallesIngreso.map((d) => ({ movimiento_id: (ingData as { id: string }).id, nivel_id: d.nivel_id, bloque_id: d.bloque_id, cantidad: d.cantidad }))
    )
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
    console.log(`[Piso] piso_bloques: ${(data ?? []).length} items cargados`)
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
    console.log(`[Piso] catalogo (respaldo): ${(data ?? []).length} items, total merge: ${results.length}`)
  } catch (err) { console.error('[Piso] Error en catalogo:', err) }

  return results
}

/**
 * Busca un bloque por código exacto. Busca en piso_bloques primero, luego en catalogo.
 * Si lo encuentra en catalogo pero no en piso_bloques, lo crea automáticamente.
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
      console.log('[Piso] Bloque encontrado en piso_bloques:', b.codigo)
      return { id: b.id, codigo: b.codigo, descripcion: b.descripcion ?? '', unidad: b.unidad ?? '' }
    }
  } catch (err) { console.error('[Piso] Error en búsqueda piso_bloques:', err) }

  // 2. Buscar en catalogo (Racks)
  try {
    const { data, error } = await dataClient
      .from('catalogo')
      .select('codigo, descripcion, un')
      .eq('codigo', target)
      .limit(1)
    if (error) console.error('[Piso] Error buscando en catalogo:', error.message)
    if (data && data.length > 0) {
      const c = data[0] as { codigo: string; descripcion: string; un: string }
      console.log('[Piso] Bloque encontrado en catalogo:', c.codigo)
      // Auto-crear en piso_bloques para futuro uso
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

  // 3. No encontrado en ninguna tabla — auto-crear en piso_bloques con info mínima
  try {
    console.log('[Piso] Bloque no encontrado en ninguna tabla, auto-creando:', target)
    const { data: inserted, error: insertErr } = await dataClient
      .from('piso_bloques')
      .insert({ codigo: target, descripcion: '', unidad: 'KG' })
      .select('id')
      .single()
    if (!insertErr && inserted) {
      return {
        id: (inserted as { id: string }).id,
        codigo: target,
        descripcion: '',
        unidad: 'KG',
      }
    }
    console.warn('[Piso] Auto-crear piso_bloques falló:', insertErr)
  } catch (err) { console.warn('[Piso] Error auto-creando bloque:', err) }

  return null
}
