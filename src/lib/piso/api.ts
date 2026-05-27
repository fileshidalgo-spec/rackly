'use client'

import { supabase } from '@/lib/supabase/client'

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
    bloque_descripcion?: string
    nivel_codigo?: string
  })[]
}

export type DetalleInput = {
  nivel_id: string
  bloque_id: string
  cantidad: number
}

// ---- Visualization types ----
export type PosicionConStock = {
  posicionId: string
  posicionNumero: number
  subcolumnaCodigo: string
  columnaLetra: string
  stock: number
  bloques: { bloque_id: string; bloque_codigo: string; cantidad: number }[]
}

export type DetailStock = {
  bloque_id: string
  bloque_codigo: string
  bloque_descripcion: string
  bloque_unidad: string
  cantidad: number
  nivel_numero: number
}

export type BloqueOption = {
  id: string
  codigo: string
  descripcion: string
  unidad: string
}

// ---- Sector CRUD ----
export async function listarSectores(): Promise<Sector[]> {
  const { data, error } = await supabase
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
  const { error } = await supabase.from('piso_sectores').insert({
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
  const { error } = await supabase.from('piso_sectores').delete().eq('id', id)
  if (error) throw error
  return listarSectores()
}

// ---- Structure queries ----
export async function listarColumnas(
  sectorId: string
): Promise<Columna[]> {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  const { data: posData, error: posErr } = await supabase
    .from('piso_posiciones')
    .select('*')
    .eq('subcolumna_id', subcolumnaId)
    .order('numero')
  if (posErr) throw posErr

  const posiciones = (posData ?? []) as Posicion[]
  if (posiciones.length === 0) return []

  const posIds = posiciones.map((p) => p.id)
  const { data: nivData, error: nivErr } = await supabase
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
  const { data, error } = await supabase
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
  const { error } = await supabase.from('piso_bloques').insert({
    codigo: codigo.trim().toUpperCase(),
    descripcion,
    unidad,
  })
  if (error) throw error
  return listarBloques()
}

export async function eliminarBloque(id: string): Promise<Bloque[]> {
  await supabase.from('piso_columna_bloques').delete().eq('bloque_id', id)
  const { error } = await supabase.from('piso_bloques').delete().eq('id', id)
  if (error) throw error
  return listarBloques()
}

export async function reemplazarCatalogoBloques(
  items: { codigo: string; descripcion: string; unidad: string }[]
): Promise<Bloque[]> {
  await supabase.from('piso_bloques').delete().neq('id', '')
  if (items.length === 0) return []
  const rows = items.map((i) => ({
    codigo: i.codigo.trim().toUpperCase(),
    descripcion: i.descripcion,
    unidad: i.unidad,
  }))
  const { error } = await supabase.from('piso_bloques').insert(rows)
  if (error) throw error
  return listarBloques()
}

// ---- Column-Block assignments ----
export async function listarBloquesDeColumna(
  columnaId: string
): Promise<Bloque[]> {
  const { data, error } = await supabase
    .from('piso_columna_bloques')
    .select('bloque_id, piso_bloques(*)')
    .eq('columna_id', columnaId)
  if (error) throw error
  return ((data ?? []) as { bloque_id: string; piso_bloques: Bloque }[]).map(
    (r) => r.piso_bloques
  )
}

export async function asignarBloqueAColumna(
  bloqueId: string,
  columnaId: string
) {
  const { error } = await supabase
    .from('piso_columna_bloques')
    .insert({ bloque_id: bloqueId, columna_id: columnaId })
  if (error) throw error
}

export async function quitarBloqueDeColumna(
  bloqueId: string,
  columnaId: string
) {
  const { error } = await supabase
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
  const { data, error } = await supabase.rpc('piso_registrar_movimiento', {
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
  let query = supabase
    .from('piso_movimientos')
    .select('*')
    .order('fecha', { ascending: false })
    .order('numero_operacion', { ascending: false })

  if (desde) query = query.gte('fecha', desde)
  if (hasta) query = query.lte('fecha', hasta + 'T23:59:59')
  const PAGE_SIZE = 500
  let all: PisoMovimiento[] = []
  let from = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
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
  const { data: detData, error: detErr } = await supabase
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
      ? supabase
          .from('piso_bloques')
          .select('id, codigo, descripcion')
          .in('id', blockIds)
      : Promise.resolve({ data: [], error: null }),
    nivelIds.length > 0
      ? supabase
          .from('piso_niveles')
          .select('id, codigo_ubicacion')
          .in('id', nivelIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  const bloqueMap = new Map<string, { codigo: string; descripcion: string }>()
  ;((bloquesRes.data ?? []) as { id: string; codigo: string; descripcion: string }[]).forEach(
    (b) => bloqueMap.set(b.id, { codigo: b.codigo, descripcion: b.descripcion ?? '' })
  )
  const nivelMap = new Map<string, string | null>()
  ;(
    (nivelesRes.data ?? []) as { id: string; codigo_ubicacion: string | null }[]
  ).forEach((n) => nivelMap.set(n.id, n.codigo_ubicacion))

  let result = all.map((m) => ({
    ...m,
    detalles: (detalleMap.get(m.id) ?? []).map((d) => ({
      ...d,
      bloque_codigo: bloqueMap.get(d.bloque_id)?.codigo,
      bloque_descripcion: bloqueMap.get(d.bloque_id)?.descripcion,
      nivel_codigo: nivelMap.get(d.nivel_id) ?? undefined,
    })),
  }))

  // Filter by sector/columna/bloque if specified
  if (sectorId || columnaId || bloqueId) {
    if (columnaId) {
      const { data: cols, error: colErr } = await supabase
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
  const { data, error } = await supabase
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

  const { data: bloques } = await supabase
    .from('piso_bloques')
    .select('id, codigo')
    .in('id', bloquesIds)

  const bloqueMap = new Map<string, string>()
  ;((bloques ?? []) as { id: string; codigo: string }[]).forEach((b) =>
    bloqueMap.set(b.id, b.codigo)
  )

  const stockMap = new Map<string, number>()
  for (const d of data ?? []) {
    const det = d as {
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
        det.piso_movimientos.tipo === 'stock_inicial'
          ? det.cantidad
          : -det.cantidad)
    )
  }

  return Array.from(stockMap.entries())
    .filter(([, qty]) => qty > 0)
    .map(([bloque_codigo, cantidad]) => ({ bloque_codigo, cantidad }))
}

// ---- Visualization helpers ----

export async function cargarPosicionesSector(sectorId: string): Promise<PosicionConStock[]> {
  // 1. Get columnas
  const columnas = await listarColumnas(sectorId)
  if (columnas.length === 0) return []

  // 2. Get subcolumnas for all columnas in parallel
  const subcolumnasResults = await Promise.all(columnas.map((c) => listarSubcolumnas(c.id)))

  // Build maps
  const colMap = new Map<string, Columna>(columnas.map((c) => [c.id, c]))
  const allSubs = subcolumnasResults.flat()
  const subMap = new Map<string, Subcolumna>(allSubs.map((s) => [s.id, s]))

  if (allSubs.length === 0) return []

  // 3. Batch fetch all posiciones
  const subIds = allSubs.map((s) => s.id)
  const { data: posData, error: posErr } = await supabase
    .from('piso_posiciones')
    .select('*')
    .in('subcolumna_id', subIds)
    .order('numero')
  if (posErr) throw posErr
  const posiciones = (posData ?? []) as Posicion[]

  if (posiciones.length === 0) return []

  // 4. Batch fetch all niveles
  const posIds = posiciones.map((p) => p.id)
  const { data: nivData, error: nivErr } = await supabase
    .from('piso_niveles')
    .select('*')
    .in('posicion_id', posIds)
    .order('numero')
  if (nivErr) throw nivErr
  const niveles = (nivData ?? []) as Nivel[]

  if (niveles.length === 0) return []

  // 5. Build position→niveles map
  const nivByPos = new Map<string, Nivel[]>()
  for (const n of niveles) {
    if (!nivByPos.has(n.posicion_id)) nivByPos.set(n.posicion_id, [])
    nivByPos.get(n.posicion_id)!.push(n)
  }

  // 6. Batch fetch all movement details for these niveles
  const allNivelIds = niveles.map((n) => n.id)
  const { data: movDetData, error: movDetErr } = await supabase
    .from('piso_movimiento_detalles')
    .select('cantidad, bloque_id, movimiento_id, piso_movimientos!inner(tipo)')
    .in('nivel_id', allNivelIds)
  if (movDetErr) throw movDetErr

  // 7. Build stock per nivel
  const nivelStockMap = new Map<string, Map<string, number>>()
  const movDets = (movDetData ?? []) as unknown as {
    cantidad: number
    bloque_id: string
    nivel_id: string
    movimiento_id: string
    piso_movimientos: { tipo: string }
  }[]

  for (const d of movDets) {
    if (!nivelStockMap.has(d.nivel_id)) nivelStockMap.set(d.nivel_id, new Map())
    const m = nivelStockMap.get(d.nivel_id)!
    const cur = m.get(d.bloque_id) ?? 0
    const delta =
      d.piso_movimientos.tipo === 'ingreso' || d.piso_movimientos.tipo === 'stock_inicial'
        ? d.cantidad
        : -d.cantidad
    m.set(d.bloque_id, cur + delta)
  }

  // 8. Get all block info
  const bloqueIds = [...new Set(movDets.map((d) => d.bloque_id))]
  let bloqueInfoMap = new Map<string, { id: string; codigo: string; descripcion: string; unidad: string }>()
  if (bloqueIds.length > 0) {
    const { data: bloquesData } = await supabase
      .from('piso_bloques')
      .select('id, codigo, descripcion, unidad')
      .in('id', bloqueIds)
    ;((bloquesData ?? []) as { id: string; codigo: string; descripcion: string; unidad: string }[]).forEach(
      (b) => bloqueInfoMap.set(b.id, b)
    )
  }

  // 9. Build results
  const results: PosicionConStock[] = []
  for (const pos of posiciones) {
    const sub = subMap.get(pos.subcolumna_id)
    if (!sub) continue
    const col = colMap.get(sub.columna_id)
    if (!col) continue

    const posNiveles = nivByPos.get(pos.id) || []
    const posBloques = new Map<string, number>()
    for (const niv of posNiveles) {
      const nivSt = nivelStockMap.get(niv.id)
      if (!nivSt) continue
      for (const [bId, qty] of nivSt) {
        if (qty > 0) posBloques.set(bId, (posBloques.get(bId) ?? 0) + qty)
      }
    }

    const totalStock = Array.from(posBloques.values()).reduce((a, b) => a + b, 0)
    const bloques = Array.from(posBloques.entries()).map(([bId, qty]) => ({
      bloque_id: bId,
      bloque_codigo: bloqueInfoMap.get(bId)?.codigo ?? bId,
      cantidad: qty,
    }))

    results.push({
      posicionId: pos.id,
      posicionNumero: pos.numero,
      subcolumnaCodigo: sub.codigo,
      columnaLetra: col.letra,
      stock: totalStock,
      bloques,
    })
  }

  return results
}

export async function stockDetallePosicion(posicionId: string): Promise<DetailStock[]> {
  // Get all niveles for this position
  const { data: nivData, error: nivErr } = await supabase
    .from('piso_niveles')
    .select('*')
    .eq('posicion_id', posicionId)
    .order('numero')
  if (nivErr) throw nivErr
  const niveles = (nivData ?? []) as Nivel[]
  if (niveles.length === 0) return []

  const nivIds = niveles.map((n) => n.id)

  // Get movement details for these niveles
  const { data: detData, error: detErr } = await supabase
    .from('piso_movimiento_detalles')
    .select('cantidad, bloque_id, movimiento_id, piso_movimientos!inner(tipo)')
    .in('nivel_id', nivIds)
  if (detErr) throw detErr

  // Calculate stock per nivel per bloque
  const nivMap = new Map<string, number>(niveles.map((n) => [n.id, n.numero]))
  const stockMap = new Map<string, Map<string, number>>()

  for (const d of (detData ?? []) as {
    cantidad: number
    bloque_id: string
    nivel_id: string
    movimiento_id: string
    piso_movimientos: { tipo: string }
  }[]) {
    if (!stockMap.has(d.nivel_id)) stockMap.set(d.nivel_id, new Map())
    const m = stockMap.get(d.nivel_id)!
    const cur = m.get(d.bloque_id) ?? 0
    const delta =
      d.piso_movimientos.tipo === 'ingreso' || d.piso_movimientos.tipo === 'stock_inicial'
        ? d.cantidad
        : -d.cantidad
    m.set(d.bloque_id, cur + delta)
  }

  // Get block info
  const allBloqueIds = [...new Set((detData ?? []).map((d: unknown) => (d as { bloque_id: string }).bloque_id))]
  let bloqueInfo = new Map<string, Bloque>()
  if (allBloqueIds.length > 0) {
    const { data: bData } = await supabase
      .from('piso_bloques')
      .select('*')
      .in('id', allBloqueIds)
    ;((bData ?? []) as Bloque[]).forEach((b) => bloqueInfo.set(b.id, b))
  }

  // Build results
  const results: DetailStock[] = []
  for (const niv of niveles) {
    const nivStock = stockMap.get(niv.id)
    if (!nivStock) continue
    for (const [bId, qty] of nivStock) {
      if (qty <= 0) continue
      const info = bloqueInfo.get(bId)
      results.push({
        bloque_id: bId,
        bloque_codigo: info?.codigo ?? bId,
        bloque_descripcion: info?.descripcion ?? '',
        bloque_unidad: info?.unidad ?? '',
        cantidad: qty,
        nivel_numero: niv.numero,
      })
    }
  }
  return results
}

export async function obtenerPrimerNivel(posicionId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('piso_niveles')
    .select('id')
    .eq('posicion_id', posicionId)
    .order('numero')
    .limit(1)
  if (error) throw error
  if (!data || data.length === 0) return null
  return (data[0] as { id: string }).id
}

export async function listarBloquesParaSelect(): Promise<BloqueOption[]> {
  const { data, error } = await supabase
    .from('piso_bloques')
    .select('id, codigo, descripcion, unidad')
    .order('codigo')
  if (error) throw error
  return ((data ?? []) as Bloque[]).map((b) => ({
    id: b.id,
    codigo: b.codigo,
    descripcion: b.descripcion,
    unidad: b.unidad,
  }))
}

export async function buscarBloquePorCodigo(code: string): Promise<Bloque | null> {
  const c = code.trim().toUpperCase()
  const { data, error } = await supabase
    .from('piso_bloques')
    .select('*')
    .eq('codigo', c)
    .limit(1)
  if (error) throw error
  if (!data || data.length === 0) return null
  return data[0] as Bloque
}
