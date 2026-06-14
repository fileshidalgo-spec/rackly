'use client'

import { dataClient } from '@/lib/supabase/client'

/** Limpia el prefijo del sector del código de subcolumna.
 *  BD guarda "BA1" (prefijo "B" + letra "A" + idx "1"), queremos solo "A1" */
function cleanSubcolCode(codigo: string, columnaLetra: string): string {
  const idx = codigo.indexOf(columnaLetra)
  return idx >= 0 ? codigo.substring(idx) : codigo
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
          .select('id, codigo_ubicacion, posicion_id')
          .in('id', nivelIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  const bloqueMap = new Map<string, string>()
  ;((bloquesRes.data ?? []) as { id: string; codigo: string }[]).forEach(
    (b) => bloqueMap.set(b.id, b.codigo)
  )
  const nivelMap = new Map<string, string | null>()
  const nivelToPos = new Map<string, string>()
  ;(
    (nivelesRes.data ?? []) as { id: string; codigo_ubicacion: string | null; posicion_id: string }[]
  ).forEach((n) => {
    nivelMap.set(n.id, n.codigo_ubicacion)
    nivelToPos.set(n.id, n.posicion_id)
  })

  // Resolve sector and position for each nivel
  const posIds = [...new Set(nivelToPos.values())]
  let sectorPosMap = new Map<string, { sector_nombre: string; posicion_label: string }>()
  if (posIds.length > 0) {
    const posRes = await dataClient.from('piso_posiciones').select('id, numero, subcolumna_id').in('id', posIds)
    const posMap = new Map<string, { numero: number; subcolumna_id: string }>()
    ;((posRes.data ?? []) as { id: string; numero: number; subcolumna_id: string }[]).forEach(
      (p) => posMap.set(p.id, { numero: p.numero, subcolumna_id: p.subcolumna_id })
    )
    const subIds = [...new Set([...posMap.values()].map((p) => p.subcolumna_id))]
    if (subIds.length > 0) {
      const subRes = await dataClient.from('piso_subcolumnas').select('id, codigo, columna_id').in('id', subIds)
      const subMap = new Map<string, { codigo: string; columna_id: string }>()
      ;((subRes.data ?? []) as { id: string; codigo: string; columna_id: string }[]).forEach(
        (s) => subMap.set(s.id, { codigo: s.codigo, columna_id: s.columna_id })
      )
      const colIds = [...new Set([...subMap.values()].map((s) => s.columna_id))]
      if (colIds.length > 0) {
        const colRes = await dataClient.from('piso_columnas').select('id, letra, sector_id').in('id', colIds)
        const colMap = new Map<string, { letra: string; sector_id: string }>()
        ;((colRes.data ?? []) as { id: string; letra: string; sector_id: string }[]).forEach(
          (c) => colMap.set(c.id, { letra: c.letra, sector_id: c.sector_id })
        )
        const sIds = [...new Set([...colMap.values()].map((c) => c.sector_id))]
        if (sIds.length > 0) {
          const secData = await dataClient.from('piso_sectores').select('id, nombre, n_columnas, n_subcolumnas').in('id', sIds)
          const secInfoMap = new Map<string, { nombre: string; nCol: number; nSub: number }>()
          ;((secData.data ?? []) as { id: string; nombre: string; n_columnas: number; n_subcolumnas: number }[]).forEach(
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

  let result = all.map((m) => ({
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

      // Debug: log primer resultado del RPC para verificar datos
      if (rpcData.length > 0) {
        const sample = rpcData[0]
        console.log('[Piso] RPC sample row:', {
          posicion_id: sample.posicion_id,
          stock_total: sample.stock_total,
          bloques_json_type: typeof sample.bloques_json,
          bloques_json_val: typeof sample.bloques_json === 'string' ? sample.bloques_json.substring(0, 100) : sample.bloques_json,
          parsed_bloques: rpcStockMap.get(sample.posicion_id)?.bloques,
        })
      }
      console.log(`[Piso] RPC: ${rpcData.length} posiciones con stock, ${posiciones.length} posiciones totales`)

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
 * Obtiene el stock detallado de una posición específica (todos los bloques y cantidades).
 * Usa el RPC server-side `piso_stock_detalle_posicion` para cálculo FEFO robusto.
 * Fallback: cálculo client-side si el RPC no existe aún.
 */
export async function stockDetallePosicion(
  posicionId: string
): Promise<{ bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; fecha_vencimiento: string }[]> {
  // ═══ MÉTODO PRINCIPAL: RPC server-side (JHIA-57b) ═══
  try {
    const { data, error } = await dataClient.rpc('piso_stock_detalle_posicion', {
      _posicion_id: posicionId,
    })
    if (!error && data) {
      return (data as unknown as {
        bloque_id: string; bloque_codigo: string; bloque_descripcion: string;
        bloque_unidad: string; cantidad: unknown; fecha_vencimiento: string | null;
      }[]).map((r) => ({
        bloque_id: r.bloque_id,
        bloque_codigo: r.bloque_codigo,
        bloque_descripcion: r.bloque_descripcion ?? '',
        bloque_unidad: r.bloque_unidad || 'KG',
        cantidad: Math.round((typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0) * 1000) / 1000,
        fecha_vencimiento: r.fecha_vencimiento ?? '',
      }))
    }
    // Si el RPC no existe (error 428P01), caer al fallback
    console.warn('[Piso] RPC piso_stock_detalle_posicion no disponible, usando fallback client-side')
  } catch (rpcErr) {
    console.warn('[Piso] Error RPC piso_stock_detalle_posicion:', rpcErr)
  }

  // ═══ FALLBACK: Cálculo client-side FEFO ═══
  const { data: nivData, error: nivErr } = await dataClient
    .from('piso_niveles')
    .select('id')
    .eq('posicion_id', posicionId)
  if (nivErr) throw nivErr
  const nivelIds = ((nivData ?? []) as { id: string }[]).map((n) => n.id)
  if (nivelIds.length === 0) return []

  // Intentar select con fecha_vencimiento primero; si falla (columna no existe), reintentar sin ella
  const getDetalles = async () => {
    // Intento 1: con fecha_vencimiento
    const { data: d1, error: e1 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo)')
      .in('nivel_id', nivelIds)
    if (!e1) return d1 as unknown[]
    // Intento 2: sin fecha_vencimiento (columna no existe en la DB)
    console.warn('[Piso] fallback: fecha_vencimiento no disponible, calculando sin FEFO')
    const { data: d2, error: e2 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, movimiento_id, piso_movimientos(tipo)')
      .in('nivel_id', nivelIds)
    if (e2) throw e2
    return d2 as unknown[]
  }
  const rawDetalles = await getDetalles()

  type DetRow = { bloque_id: string; cantidad: unknown; fecha_vencimiento?: string | null; piso_movimientos: { tipo: string } | null | { tipo: string }[] }
  const detalles = (rawDetalles ?? []) as DetRow[]

  const isIngresoType = (tipo: string) =>
    tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion'
  const getTipo = (pm: DetRow['piso_movimientos']): string | null => {
    if (!pm) return null
    if (Array.isArray(pm)) return pm.length > 0 ? pm[0].tipo : null
    return pm.tipo
  }

  // Pool de lotes por ingreso
  const ingresoPools = new Map<string, Map<string, number>>()
  for (const d of detalles) {
    const tipo = getTipo(d.piso_movimientos)
    if (!tipo || !isIngresoType(tipo)) continue
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    const fv = (typeof d.fecha_vencimiento === 'string' && d.fecha_vencimiento) ? d.fecha_vencimiento : ''
    const pool = ingresoPools.get(d.bloque_id) ?? new Map<string, number>()
    pool.set(fv, (pool.get(fv) ?? 0) + qty)
    ingresoPools.set(d.bloque_id, pool)
  }

  // Sumar salidas por bloque_id (sin importar fecha)
  const salidasPorBloque = new Map<string, number>()
  for (const d of detalles) {
    const tipo = getTipo(d.piso_movimientos)
    if (!tipo || isIngresoType(tipo)) continue
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    salidasPorBloque.set(d.bloque_id, (salidasPorBloque.get(d.bloque_id) ?? 0) + qty)
  }

  // FEFO: descontar salidas del pool
  const lotesRestantes = new Map<string, { fecha: string; qty: number }[]>()
  for (const [bloqueId, pool] of ingresoPools) {
    const sortedLots = [...pool.entries()].sort(([a], [b]) => {
      if (!a && b) return 1
      if (a && !b) return -1
      return a.localeCompare(b)
    })
    const totalSalida = salidasPorBloque.get(bloqueId) ?? 0
    let pendiente = totalSalida
    const restantes: { fecha: string; qty: number }[] = []
    for (const [fecha, qty] of sortedLots) {
      if (pendiente <= 0) { restantes.push({ fecha, qty }) }
      else if (qty <= pendiente) { pendiente -= qty }
      else { restantes.push({ fecha, qty: qty - pendiente }); pendiente = 0 }
    }
    if (restantes.length > 0) lotesRestantes.set(bloqueId, restantes)
  }

  if (lotesRestantes.size === 0) return []

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

  const results: { bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; fecha_vencimiento: string }[] = []
  for (const [bloqueId, lots] of lotesRestantes) {
    const info = bloqueInfoMap.get(bloqueId)
    if (!info) continue
    for (const lot of lots) {
      if (lot.qty <= 0) continue
      results.push({
        bloque_id: bloqueId, bloque_codigo: info.codigo, bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad || 'KG', cantidad: Math.round(lot.qty * 1000) / 1000, fecha_vencimiento: lot.fecha,
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
 * Usa cálculo client-side FEFO idéntico al fallback de stockDetallePosicion
 * pero filtrado a un solo nivel_id.
 */
export async function stockDetalleNivel(
  nivelId: string
): Promise<{ bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; fecha_vencimiento: string }[]> {
  // Obtener detalles de movimiento para este nivel específico
  const getDetalles = async () => {
    const { data: d1, error: e1 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo)')
      .eq('nivel_id', nivelId)
    if (!e1) return d1 as unknown[]
    const { data: d2, error: e2 } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id, cantidad, movimiento_id, piso_movimientos(tipo)')
      .eq('nivel_id', nivelId)
    if (e2) throw e2
    return d2 as unknown[]
  }
  const rawDetalles = await getDetalles()

  type DetRow = { bloque_id: string; cantidad: unknown; fecha_vencimiento?: string | null; piso_movimientos: { tipo: string } | null | { tipo: string }[] }
  const detalles = (rawDetalles ?? []) as DetRow[]

  const isIngresoType = (tipo: string) =>
    tipo === 'ingreso' || tipo === 'stock_inicial' || tipo === 'devolucion'
  const getTipo = (pm: DetRow['piso_movimientos']): string | null => {
    if (!pm) return null
    if (Array.isArray(pm)) return pm.length > 0 ? pm[0].tipo : null
    return pm.tipo
  }

  // Pool de lotes por ingreso
  const ingresoPools = new Map<string, Map<string, number>>()
  for (const d of detalles) {
    const tipo = getTipo(d.piso_movimientos)
    if (!tipo || !isIngresoType(tipo)) continue
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    const fv = (typeof d.fecha_vencimiento === 'string' && d.fecha_vencimiento) ? d.fecha_vencimiento : ''
    const pool = ingresoPools.get(d.bloque_id) ?? new Map<string, number>()
    pool.set(fv, (pool.get(fv) ?? 0) + qty)
    ingresoPools.set(d.bloque_id, pool)
  }

  // Sumar salidas por bloque_id
  const salidasPorBloque = new Map<string, number>()
  for (const d of detalles) {
    const tipo = getTipo(d.piso_movimientos)
    if (!tipo || isIngresoType(tipo)) continue
    const qty = typeof d.cantidad === 'number' ? d.cantidad : parseFloat(String(d.cantidad ?? '0')) || 0
    if (qty <= 0) continue
    salidasPorBloque.set(d.bloque_id, (salidasPorBloque.get(d.bloque_id) ?? 0) + qty)
  }

  // FEFO: descontar salidas del pool
  const lotesRestantes = new Map<string, { fecha: string; qty: number }[]>()
  for (const [bloqueId, pool] of ingresoPools) {
    const sortedLots = [...pool.entries()].sort(([a], [b]) => {
      if (!a && b) return 1
      if (a && !b) return -1
      return a.localeCompare(b)
    })
    const totalSalida = salidasPorBloque.get(bloqueId) ?? 0
    let pendiente = totalSalida
    const restantes: { fecha: string; qty: number }[] = []
    for (const [fecha, qty] of sortedLots) {
      if (pendiente <= 0) { restantes.push({ fecha, qty }) }
      else if (qty <= pendiente) { pendiente -= qty }
      else { restantes.push({ fecha, qty: qty - pendiente }); pendiente = 0 }
    }
    if (restantes.length > 0) lotesRestantes.set(bloqueId, restantes)
  }

  if (lotesRestantes.size === 0) return []

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

  const results: { bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; fecha_vencimiento: string }[] = []
  for (const [bloqueId, lots] of lotesRestantes) {
    const info = bloqueInfoMap.get(bloqueId)
    if (!info) continue
    for (const lot of lots) {
      if (lot.qty <= 0) continue
      results.push({
        bloque_id: bloqueId, bloque_codigo: info.codigo, bloque_descripcion: info.descripcion,
        bloque_unidad: info.unidad || 'KG', cantidad: Math.round(lot.qty * 1000) / 1000, fecha_vencimiento: lot.fecha,
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
 */
export async function registrarIngresoPosicion(
  turno: string,
  usuarioId: string,
  usuarioNombre: string,
  usuarioCorreo: string,
  detalles: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[],
  opts?: { posicion_id?: string; codigo_inc?: string }
): Promise<void> {
  // Crear cabecera
  const insertPayload: Record<string, unknown> = {
    tipo: 'ingreso',
    turno,
    usuario_id: usuarioId,
    usuario_nombre: usuarioNombre,
    usuario_correo: usuarioCorreo,
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
  detalles: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[]
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
      ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
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
  detallesSalida: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[],
  detallesIngreso: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento?: string | null }[]
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
      detallesSalida.map((d) => ({
        movimiento_id: (salData as { id: string }).id,
        nivel_id: d.nivel_id,
        bloque_id: d.bloque_id,
        cantidad: d.cantidad,
        ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
      }))
    )
  }

  // Insertar detalles de ingreso
  if (detallesIngreso.length > 0) {
    await dataClient.from('piso_movimiento_detalles').insert(
      detallesIngreso.map((d) => ({
        movimiento_id: (ingData as { id: string }).id,
        nivel_id: d.nivel_id,
        bloque_id: d.bloque_id,
        cantidad: d.cantidad,
        ...(d.fecha_vencimiento ? { fecha_vencimiento: d.fecha_vencimiento } : {}),
      }))
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
  // 1. Fetch ALL detalles with movement type
  const { data: detData, error: detErr } = await dataClient
    .from('piso_movimiento_detalles')
    .select('bloque_id, nivel_id, cantidad, fecha_vencimiento, movimiento_id, piso_movimientos(tipo, codigo_inc)')
  if (detErr) throw detErr

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
  const rawDets = (detData ?? []) as RawDet[]

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
