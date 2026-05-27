'use client'

import { supabase } from '@/lib/supabase/client'

export type Turno = 'Día' | 'Noche'
export type TipoMovimiento = 'ingreso' | 'salida' | 'devolucion' | 'traslado'

export type Movimiento = {
  id: string
  tipo: TipoMovimiento
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  fVencimiento: string
  fModificacion: string
  turno: Turno
  usuarioId: string
  usuarioNombre?: string
  usuarioCorreo?: string
  proveedor?: string
}

export type OcupacionCelda = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  codigos: string[]
}

function fromRow(r: Record<string, unknown>): Movimiento {
  return {
    id: r.id as string,
    tipo: r.tipo as TipoMovimiento,
    bloque: r.bloque as string,
    torre: r.torre as string,
    piso: r.piso as string,
    posicion: r.posicion as string,
    codigo: r.codigo as string,
    descripcion: r.descripcion as string,
    un: r.un as string,
    cantidad: r.cantidad as number,
    fVencimiento: (r.f_vencimiento as string) ?? '',
    fModificacion: r.f_modificacion as string,
    turno: r.turno as Turno,
    usuarioId: (r.usuario_id as string) ?? '',
    usuarioNombre: (r.usuario_nombre as string) ?? undefined,
    usuarioCorreo: (r.usuario_correo as string) ?? undefined,
    proveedor: (r.proveedor as string) ?? undefined,
  }
}

export async function fetchMovimientos(): Promise<Movimiento[]> {
  const PAGE_SIZE = 1000
  const all: Record<string, unknown>[] = []
  let from = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('movimientos')
      .select('*')
      .order('f_modificacion', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw error
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all.map(fromRow)
}

export async function addMovimiento(
  m: Omit<Movimiento, 'id' | 'fModificacion'>
): Promise<Movimiento[]> {
  const { error } = await supabase.from('movimientos').insert({
    tipo: m.tipo,
    bloque: m.bloque,
    torre: m.torre,
    piso: m.piso,
    posicion: m.posicion,
    codigo: m.codigo.trim().toUpperCase(),
    descripcion: m.descripcion,
    un: m.un,
    cantidad: m.cantidad,
    f_vencimiento: m.fVencimiento || null,
    turno: m.turno,
    usuario_id: m.usuarioId,
    usuario_nombre: m.usuarioNombre ?? null,
    usuario_correo: m.usuarioCorreo ?? null,
    proveedor: m.proveedor ? m.proveedor : null,
  })
  if (error) throw error
  return fetchMovimientos()
}

export async function deleteMovimiento(id: string): Promise<Movimiento[]> {
  const { error } = await supabase.from('movimientos').delete().eq('id', id)
  if (error) throw error
  return fetchMovimientos()
}

export async function calcularStockUbicacion(
  codigo: string,
  bloque: string,
  torre: string,
  piso: string,
  posicion: string
): Promise<number> {
  const target = codigo.trim().toUpperCase()
  const { data, error } = await supabase
    .from('movimientos')
    .select('tipo, cantidad')
    .eq('codigo', target)
    .eq('bloque', bloque)
    .eq('torre', torre)
    .eq('piso', piso)
    .eq('posicion', posicion)
  if (error) throw error
  return (data ?? []).reduce(
    (s: number, r: { tipo: string; cantidad: number }) =>
      s + (r.tipo === 'ingreso' || r.tipo === 'devolucion' || r.tipo === 'traslado' ? r.cantidad : -r.cantidad),
    0
  )
}

export type StockEnUbicacion = {
  codigo: string
  descripcion: string
  un: string
  stock: number
  fVencimiento?: string
  usuarioPrimerNombre?: string
  proveedor?: string
}

export async function stockEnUbicacion(
  bloque: string,
  torre: string,
  piso: string,
  posicion: string
): Promise<StockEnUbicacion[]> {
  const { data, error } = await supabase.rpc('stock_en_ubicacion', {
    _bloque: bloque,
    _torre: torre,
    _piso: piso,
    _posicion: posicion,
  })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    codigo: String(r.codigo ?? '').trim().toUpperCase(),
    descripcion: (r.descripcion as string) ?? '',
    un: (r.un as string) ?? '',
    stock: Number(r.stock ?? 0),
    fVencimiento: (r.f_vencimiento as string) ?? '',
    usuarioPrimerNombre: (r.usuario_primer_nombre as string) ?? '',
    proveedor: (r.proveedor as string) ?? '',
  }))
}

export async function fetchOcupacionCeldas(): Promise<OcupacionCelda[]> {
  // Consultar TODOS los movimientos con paginación (límite default de Supabase: 1000)
  const PAGE_SIZE = 1000
  const all: Record<string, unknown>[] = []
  let from = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('movimientos')
      .select('bloque, torre, piso, posicion, tipo, cantidad, codigo')
      .range(from, to)
    if (error) throw error
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Calcular stock por celda usando la misma lógica que calcularStockUbicacion:
  // Positivo = ingreso, devolucion, traslado | Negativo = salida
  const cellMap = new Map<string, { stock: number; codigos: Set<string> }>()
  for (const row of all) {
    const bloque = String(row.bloque ?? '')
    const torre = String(row.torre ?? '')
    const piso = String(row.piso ?? '')
    const posicion = String(row.posicion ?? '')
    const tipo = String(row.tipo ?? '')
    const cantidad = Number(row.cantidad ?? 0)
    const codigo = String(row.codigo ?? '').trim().toUpperCase()

    const key = `${bloque}-${torre}-${piso}-${posicion}`
    if (!cellMap.has(key)) {
      cellMap.set(key, { stock: 0, codigos: new Set() })
    }
    const cell = cellMap.get(key)!
    if (tipo === 'ingreso' || tipo === 'devolucion' || tipo === 'traslado') {
      cell.stock += cantidad
    } else if (tipo === 'salida') {
      cell.stock -= cantidad
    }
    if (cell.stock > 0) {
      cell.codigos.add(codigo)
    }
  }

  // Retornar todas las celdas que tienen movimientos (ocupadas y vacías)
  return Array.from(cellMap.entries()).map(([key, val]) => {
    const [bloque, torre, piso, posicion] = key.split('-')
    return {
      bloque,
      torre,
      piso,
      posicion,
      stock: val.stock,
      codigos: [...val.codigos],
    }
  })
}

export type TrasladoInput = {
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  stockActual: number
  origen: { bloque: string; torre: string; piso: string; posicion: string }
  destino: { bloque: string; torre: string; piso: string; posicion: string }
  turno: Turno
  usuarioId: string
  usuarioNombre?: string
  usuarioCorreo?: string
  fVencimiento?: string
  proveedor?: string
}

export async function trasladarMovimiento(t: TrasladoInput): Promise<Movimiento[]> {
  const codigo = t.codigo.trim().toUpperCase()
  const base = {
    codigo,
    descripcion: t.descripcion,
    un: t.un,
    f_vencimiento: t.fVencimiento || null,
    turno: t.turno,
    usuario_id: t.usuarioId,
    usuario_nombre: t.usuarioNombre ?? null,
    usuario_correo: t.usuarioCorreo ?? null,
    proveedor: t.proveedor ? t.proveedor : null,
  }

  const rows: Record<string, unknown>[] = []

  // Si la cantidad a trasladar supera el stock del sistema en origen,
  // generar un ingreso de corrección automático para que no quede negativo.
  const diferencia = t.cantidad - t.stockActual
  if (diferencia > 0) {
    rows.push({
      ...base,
      tipo: 'ingreso',
      cantidad: diferencia,
      bloque: t.origen.bloque,
      torre: t.origen.torre,
      piso: t.origen.piso,
      posicion: t.origen.posicion,
    })
  }

  // Salida en origen por la cantidad total trasladada
  rows.push({
    ...base,
    tipo: 'salida',
    cantidad: t.cantidad,
    bloque: t.origen.bloque,
    torre: t.origen.torre,
    piso: t.origen.piso,
    posicion: t.origen.posicion,
  })

  // Traslado (ingreso) en destino
  rows.push({
    ...base,
    tipo: 'traslado',
    cantidad: t.cantidad,
    bloque: t.destino.bloque,
    torre: t.destino.torre,
    piso: t.destino.piso,
    posicion: t.destino.posicion,
  })

  const { error } = await supabase.from('movimientos').insert(rows)
  if (error) throw error
  return fetchMovimientos()
}

export async function eliminarUbicacion(
  codigo: string,
  bloque: string,
  torre: string,
  piso: string,
  posicion: string
): Promise<Movimiento[]> {
  const target = codigo.trim().toUpperCase()
  const { error } = await supabase
    .from('movimientos')
    .delete()
    .eq('codigo', target)
    .eq('bloque', bloque)
    .eq('torre', torre)
    .eq('piso', piso)
    .eq('posicion', posicion)
  if (error) throw error
  return fetchMovimientos()
}
