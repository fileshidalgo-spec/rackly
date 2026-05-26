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
    nivel_codigo?: string
  })[]
}

export type DetalleInput = {
  nivel_id: string
  bloque_id: string
  cantidad: number
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
  return ((data ?? []) as unknown as { bloque_id: string; piso_bloques: Bloque }[]).map(
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
          .select('id, codigo')
          .in('id', blockIds)
      : Promise.resolve({ data: [], error: null }),
    nivelIds.length > 0
      ? supabase
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
        det.piso_movimientos.tipo === 'stock_inicial'
          ? det.cantidad
          : -det.cantidad)
    )
  }

  return Array.from(stockMap.entries())
    .filter(([, qty]) => qty > 0)
    .map(([bloque_codigo, cantidad]) => ({ bloque_codigo, cantidad }))
}
