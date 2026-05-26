'use client'

import { dataClient } from '@/lib/supabase/client'
import { PAGE_SIZE, MAX_ITERATIONS, MOVIMIENTOS_ENTRADA, TURNO_DIA, TURNO_NOCHE } from './constants'
import { impactoStock } from '@/lib/utils'

export type Turno = typeof TURNO_DIA | typeof TURNO_NOCHE
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
    cantidad: typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0,
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
  const all: Record<string, unknown>[] = []
  let from = 0
  let iterations = 0
  while (iterations < MAX_ITERATIONS) {
    iterations++
    const to = from + PAGE_SIZE - 1
    const { data, error } = await dataClient
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
  const { error } = await dataClient.from('movimientos').insert({
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
  const { error } = await dataClient.from('movimientos').delete().eq('id', id)
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
  const { data, error } = await dataClient
    .from('movimientos')
    .select('tipo, cantidad')
    .eq('codigo', target)
    .eq('bloque', bloque)
    .eq('torre', torre)
    .eq('piso', piso)
    .eq('posicion', posicion)
  if (error) throw error
  return (data ?? []).reduce(
    (s: number, r: { tipo: string; cantidad: unknown }) => {
      const qty = typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0
      return s + impactoStock(r.tipo, qty)
    },
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
  try {
    // Método principal: consultar movimientos directamente con paginación
    // Agrupa por (codigo, f_vencimiento) para separar lotes con distintas fechas de vencimiento
    const allRows: Record<string, unknown>[] = []
    let from = 0
    const BATCH = 1000
    const MAX_PAGES = 10 // máximo 10,000 movimientos por ubicación

    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await dataClient
        .from('movimientos')
        .select('*')
        .eq('bloque', bloque)
        .eq('torre', torre)
        .eq('piso', piso)
        .eq('posicion', posicion)
        .order('f_modificacion', { ascending: true })
        .range(from, from + BATCH - 1)

      if (error) throw error
      const rows = data ?? []
      allRows.push(...rows)
      if (rows.length < BATCH) break
      from += BATCH
    }

    // Agrupar por (codigo, f_vencimiento)
    const groups = new Map<string, {
      codigo: string; descripcion: string; un: string;
      stock: number; fVencimiento: string;
      usuarioPrimerNombre: string; proveedor: string;
    }>()

    for (const r of allRows) {
      const m = fromRow(r)
      const fvKey = m.fVencimiento || ''
      const key = `${m.codigo}||${fvKey}`

      let group = groups.get(key)
      if (!group) {
        group = {
          codigo: m.codigo,
          descripcion: m.descripcion,
          un: m.un,
          stock: 0,
          fVencimiento: m.fVencimiento,
          usuarioPrimerNombre: m.usuarioNombre?.split(' ')[0] ?? '',
          proveedor: m.proveedor ?? '',
        }
        groups.set(key, group)
      }

      // Calcular stock neto (ingreso/devolucion/traslado = +, salida = -)
      const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
      const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? qty : -qty
      group.stock += delta
    }

    // Filtrar solo artículos con stock > 0
    const results = Array.from(groups.values()).filter(g => g.stock > 0)

    // Ordenar por FEFO: fecha de vencimiento más próxima primero, sin fecha al final
    results.sort((a, b) => {
      if (a.fVencimiento && b.fVencimiento) return a.fVencimiento.localeCompare(b.fVencimiento)
      if (a.fVencimiento && !b.fVencimiento) return -1
      if (!a.fVencimiento && b.fVencimiento) return 1
      return 0
    })

    return results.map(g => ({
      codigo: g.codigo,
      descripcion: g.descripcion,
      un: g.un,
      stock: Math.round(g.stock * 1000) / 1000,
      fVencimiento: g.fVencimiento || undefined,
      usuarioPrimerNombre: g.usuarioPrimerNombre || undefined,
      proveedor: g.proveedor || undefined,
    }))
  } catch {
    // Fallback al RPC original si falla la consulta directa
    try {
      const { data, error } = await dataClient.rpc('stock_en_ubicacion', {
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
    } catch {
      return []
    }
  }
}

export async function fetchOcupacionCeldas(): Promise<OcupacionCelda[]> {
  const { data, error } = await dataClient.rpc('ocupacion_celdas')
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    bloque: String(r.bloque ?? ''),
    torre: String(r.torre ?? ''),
    piso: String(r.piso ?? ''),
    posicion: String(r.posicion ?? ''),
    stock: Number(r.stock ?? 0),
    codigos: Array.isArray(r.codigos) ? (r.codigos as string[]).map(String) : [],
  }))
}

export type TrasladoInput = {
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  origen: { bloque: string; torre: string; piso: string; posicion: string }
  destino: { bloque: string; torre: string; piso: string; posicion: string }
  turno: Turno
  usuarioId: string
  usuarioNombre?: string
  usuarioCorreo?: string
  fVencimiento?: string
  proveedor?: string
  /** Cantidad de ajuste en origen. Positivo = ingreso (qty > stock), Negativo = salida (qty < stock) */
  cantidadAjuste?: number
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

  // Ajuste automático en origen para corregir diferencias entre stock registrado y realidad:
  //  - Si qty > stock: ajuste positivo (ingreso) para cubrir lo que falta
  //  - Si qty < stock: ajuste negativo (salida) para retirar lo que sobra
  // En ambos casos, el stock del origen queda en 0 después del traslado.
  const ajuste = (t.cantidadAjuste ?? 0) !== 0
    ? [{
        ...base,
        tipo: (t.cantidadAjuste ?? 0) > 0 ? 'ingreso' as const : 'salida' as const,
        bloque: t.origen.bloque,
        torre: t.origen.torre,
        piso: t.origen.piso,
        posicion: t.origen.posicion,
        cantidad: Math.abs(t.cantidadAjuste!),
      }]
    : []

  const { error } = await dataClient.from('movimientos').insert([
    ...ajuste,
    {
      ...base,
      tipo: 'salida',
      bloque: t.origen.bloque,
      torre: t.origen.torre,
      piso: t.origen.piso,
      posicion: t.origen.posicion,
      cantidad: t.cantidad,
    },
    {
      ...base,
      tipo: 'traslado',
      bloque: t.destino.bloque,
      torre: t.destino.torre,
      piso: t.destino.piso,
      posicion: t.destino.posicion,
      cantidad: t.cantidad,
    },
  ])
  if (error) throw error
  return fetchMovimientos()
}

/**
 * Elimina TODOS los movimientos de la tabla.
 * Usa service_role para bypassear RLS.
 * Borra en lotes de 1000 IDs para no exceder límites de URL.
 */
export async function deleteAllMovimientos(): Promise<{ deleted: boolean; error?: string }> {
  const { createClient } = await import('@supabase/supabase-js')
  const SERVICE_URL = 'https://owjryvcrhpmgtkkdcrkm.supabase.co'
  const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93anJ5dmNyaHBtZ3Rra2RjcmttIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTE5MTA4NSwiZXhwIjoyMDk0NzY3MDg1fQ.c4P6F9KZ1iXj9X_d9OjNHMgMeczT0Be8k74rtZNboxg'
  const admin = createClient(SERVICE_URL, SERVICE_KEY)

  // Obtener todos los IDs
  const allIds: string[] = []
  let from = 0
  let iterations = 0
  const BATCH = 1000
  while (iterations++ < MAX_ITERATIONS) {
    const { data, error } = await admin
      .from('movimientos')
      .select('id')
      .range(from, from + BATCH - 1)
    if (error) return { deleted: false, error: error.message }
    if (!data || data.length === 0) break
    allIds.push(...data.map((r: { id: string }) => r.id))
    if (data.length < BATCH) break
    from += BATCH
  }

  if (allIds.length === 0) return { deleted: true }

  // Borrar en lotes usando .in('id', [...])
  const DELETE_BATCH = 500
  for (let i = 0; i < allIds.length; i += DELETE_BATCH) {
    const batch = allIds.slice(i, i + DELETE_BATCH)
    const { error } = await admin
      .from('movimientos')
      .delete()
      .in('id', batch)
    if (error) return { deleted: false, error: `Lote ${Math.floor(i / DELETE_BATCH) + 1}: ${error.message}` }
  }

  return { deleted: true }
}

export type UploadStockRow = {
  codigo: string
  descripcion: string
  un: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  cantidad: number
  fVencimiento?: string
  proveedor?: string
}

/**
 * Inserta movimientos de ingreso masivamente desde un archivo Excel.
 * Usa service_role para bypassear RLS.
 * Usa batch inserts de 1000 filas para no exceder límites de Supabase.
 */
export async function addMovimientosBatch(
  rows: UploadStockRow[],
  usuarioId: string,
  usuarioNombre?: string,
  usuarioCorreo?: string,
): Promise<{ inserted: number; errors: string[] }> {
  const { createClient } = await import('@supabase/supabase-js')
  const SERVICE_URL = 'https://owjryvcrhpmgtkkdcrkm.supabase.co'
  const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93anJ5dmNyaHBtZ3Rra2RjcmttIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTE5MTA4NSwiZXhwIjoyMDk0NzY3MDg1fQ.c4P6F9KZ1iXj9X_d9OjNHMgMeczT0Be8k74rtZNboxg'
  const admin = createClient(SERVICE_URL, SERVICE_KEY)

  const turno = (await import('./turno')).calcularTurno()
  const errors: string[] = []
  let inserted = 0
  const BATCH_SIZE = 1000

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const inserts = batch.map((r) => ({
      tipo: 'ingreso' as const,
      bloque: String(r.bloque),
      torre: String(r.torre),
      piso: String(r.piso),
      posicion: String(r.posicion),
      codigo: r.codigo.trim().toUpperCase(),
      descripcion: r.descripcion,
      un: r.un || 'KG',
      cantidad: Number(r.cantidad),
      f_vencimiento: r.fVencimiento || null,
      turno,
      usuario_id: usuarioId,
      usuario_nombre: usuarioNombre ?? null,
      usuario_correo: usuarioCorreo ?? null,
      proveedor: r.proveedor ? r.proveedor : null,
    }))

    const { error } = await admin.from('movimientos').insert(inserts)
    if (error) {
      errors.push(`Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`)
      // Intentar insertar uno por uno el lote fallido para identificar la fila
      for (let j = 0; j < inserts.length; j++) {
        const { error: singleErr } = await admin
          .from('movimientos')
          .insert(inserts[j])
        if (singleErr) {
          errors.push(`Fila ${i + j + 1}: ${singleErr.message}`)
        } else {
          inserted++
        }
      }
    } else {
      inserted += batch.length
    }
  }

  return { inserted, errors }
}

export async function eliminarUbicacion(
  codigo: string,
  bloque: string,
  torre: string,
  piso: string,
  posicion: string
): Promise<Movimiento[]> {
  const target = codigo.trim().toUpperCase()
  const { error } = await dataClient
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
