'use client'

import { dataClient } from '@/lib/supabase/client'
import { PAGE_SIZE, MAX_ITERATIONS, FETCH_MOV_MAX_PAGES, MOVIMIENTOS_ENTRADA, TURNO_DIA, TURNO_NOCHE } from './constants'
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
  codigoInc?: string // maps from codigo_inc column
}

export type IncEnCelda = {
  codigo: string
  descripcion: string
  codigoInc: string
  cantidad: number
}

export type OcupacionCelda = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  codigos: string[]
  lotes: number
  tieneInc: boolean
  incItems: IncEnCelda[]
}

/** Normaliza campos de ubicación eliminando ceros a la izquierda.
 *  Evita fallos de comparación cuando la BD usa '01' y el grid usa '1'. */
function norm(s: unknown): string {
  if (s == null) return ''
  const n = parseInt(String(s).trim(), 10)
  return isNaN(n) ? String(s).trim() : String(n)
}

function fromRow(r: Record<string, unknown>): Movimiento {
  return {
    id: r.id as string,
    tipo: r.tipo as TipoMovimiento,
    bloque: norm(r.bloque),
    torre: norm(r.torre),
    piso: norm(r.piso),
    posicion: norm(r.posicion),
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
    codigoInc: (r.codigo_inc as string) ?? undefined,
  }
}

export async function fetchMovimientos(): Promise<Movimiento[]> {
  const all: Record<string, unknown>[] = []
  let from = 0
  let iterations = 0
  while (iterations < FETCH_MOV_MAX_PAGES) {
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

export async function fetchMovimientosByCodigo(codigo: string): Promise<Movimiento[]> {
  const upperCode = codigo.trim().toUpperCase()
  const { data, error } = await dataClient
    .from('movimientos')
    .select('*')
    .eq('codigo', upperCode)
    .order('f_modificacion', { ascending: false })
  if (error) throw error
  return (data ?? []).map(fromRow)
}

// ═══ Stock cruzado: Racks por código (usado desde PisoStockTab) ═══

export type StockRacksPorCodigoItem = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  descripcion: string
  un: string
  fVencimiento: string
  codigo_inc?: string
}

/**
 * Calcula el stock neto en Racks para un código dado.
 * Usado por PisoStockTab para mostrar "También en Kardex Racks".
 * Solo lectura, no modifica nada.
 */
export async function buscarStockRacksPorCodigo(codigo: string): Promise<StockRacksPorCodigoItem[]> {
  const movs = await fetchMovimientosByCodigo(codigo)
  const locMap = new Map<string, StockRacksPorCodigoItem>()

  for (const m of movs) {
    // Agrupar por ubicación SOLAMENTE — f_vencimiento NO participa.
    // Se rastrea la fecha más próxima (FEFO) para display.
    const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
    const current = locMap.get(posKey)
    const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
    if (current) {
      current.stock += delta
      // Rastrear fecha FEFO (más próxima)
      if (m.fVencimiento && (!current.fVencimiento || m.fVencimiento < current.fVencimiento)) {
        current.fVencimiento = m.fVencimiento
      }
    } else {
      locMap.set(posKey, {
        bloque: m.bloque,
        torre: m.torre,
        piso: m.piso,
        posicion: m.posicion,
        stock: delta,
        descripcion: m.descripcion,
        un: m.un,
        fVencimiento: m.fVencimiento || '',
        codigo_inc: m.codigoInc || undefined,
      })
    }
  }

  return Array.from(locMap.values())
    .filter(l => l.stock > 0)
    .sort((a, b) => {
      // FEFO primero
      if (a.fVencimiento && b.fVencimiento) return a.fVencimiento.localeCompare(b.fVencimiento)
      if (a.fVencimiento && !b.fVencimiento) return -1
      if (!a.fVencimiento && b.fVencimiento) return 1
      return 0
    })
}

/** Fallback: insert directo cuando la RPC no existe en Supabase */
async function addMovimientoFallback(
  m: Omit<Movimiento, 'id' | 'fModificacion'>,
  uuidSync?: string,
  skipValidation: boolean = false
): Promise<Movimiento[]> {
  console.warn('[addMovimiento] RPC no encontrada, usando insert directo como fallback')

  // ── Validación de stock negativo para salidas NORMALES (no INC) ──
  // Las salidas normales NUNCA deben generar stock negativo.
  // Los traslados se manejan aparte con autoajuste.
  // Stock = suma de TODOS los movimientos en la ubicacion para ese codigo.
  // f_vencimiento es solo para FEFO, NO para calcular stock.
  if (!skipValidation && m.tipo === 'salida' && !m.codigoInc) {
    try {
      // Stock real = movimientos en la ubicacion para ese codigo, EXCLUYENDO INC.
      // f_vencimiento es solo para FEFO, NO para calcular stock.
      const currentStock = await calcularStockUbicacion(
        m.codigo, m.bloque, m.torre, m.piso, m.posicion, true // excluir INC
      )
      // Tolerancia de 0.001 para redondeo (display redondea a 3 decimales)
      const stockRedondeado = Math.round(currentStock * 1000) / 1000
      if (m.cantidad > stockRedondeado + 0.001) {
        const err = new Error('INSUFFICIENT_STOCK')
        ;(err as unknown as Record<string, string>).detail =
          `Stock actual = ${stockRedondeado} ${m.un}, cantidad solicitada = ${m.cantidad} ${m.un}`
        throw err
      }
    } catch (stockErr) {
      // Si es error de stock insuficiente, propagarlo
      if (stockErr instanceof Error && stockErr.message === 'INSUFFICIENT_STOCK') throw stockErr
      // Si falla la consulta de stock, NO permitir la inserción sin validar.
      // Esto previene salidas con stock negativo cuando la red es inestable.
      console.error('[addMovimientoFallback] No se pudo verificar stock, BLOQUEANDO inserción:', stockErr)
      throw new Error('STOCK_VALIDATION_FAILED|No se pudo verificar el stock. Reintente.')
    }
  }

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
    uuid_sync: uuidSync || null,
    codigo_inc: m.codigoInc || null,
  })
  if (error) throw error
  try {
    return await fetchMovimientos()
  } catch (fetchErr) {
    console.warn('[addMovimientoFallback] Insert exitoso pero fetchMovimientos() falló.', fetchErr)
    return []
  }
}

/** Chequeo de idempotencia: verificar si un movimiento con este uuid_sync ya existe */
async function checkExistingByUuidSync(uuidSync: string): Promise<boolean> {
  try {
    const { data, error } = await dataClient
      .from('movimientos')
      .select('id')
      .eq('uuid_sync', uuidSync)
      .limit(1)
    if (error) throw error
    return (data ?? []).length > 0
  } catch (err) {
    console.error('[checkExistingByUuidSync] Error consultando uuid_sync:', err)
    // Si falla la consulta, NO asumir que no existe — lanzar para que el caller decida
    throw new Error('IDEMPOTENCY_CHECK_FAILED|No se pudo verificar si el movimiento ya existe. Reintente.')
  }
}

export async function addMovimiento(
  m: Omit<Movimiento, 'id' | 'fModificacion'>,
  uuidSync?: string
): Promise<Movimiento[]> {
  // Idempotencia: si viene uuidSync, verificar si ya existe en el servidor
  if (uuidSync) {
    const exists = await checkExistingByUuidSync(uuidSync)
    if (exists) {
      console.warn('[addMovimiento] Movimiento ya existe (uuid_sync), saltando insert:', uuidSync)
      // Ya existe: refrescar y retornar como si hubiera sido exitoso
      return await fetchMovimientos()
    }
  }

  // NOTA: Los movimientos INC ahora pasan por la RPC como cualquier otro movimiento.
  // La RPC registrar_movimiento_kardex ya tiene p_codigo_inc (migration 20260611).
  // Esto garantiza advisory lock y validación atómica para TODOS los movimientos.

  // Usar RPC atómica con advisory lock para evitar race conditions.
  // La RPC maneja TODOS los tipos de movimiento incluyendo INC.
  // INC items son tipo 'ingreso' así que no pasan validación de stock negativo.
  try {
    const { data, error } = await dataClient.rpc('registrar_movimiento_kardex', {
      p_tipo: m.tipo,
      p_bloque: m.bloque,
      p_torre: m.torre,
      p_piso: m.piso,
      p_posicion: m.posicion,
      p_codigo: m.codigo.trim().toUpperCase(),
      p_descripcion: m.descripcion,
      p_un: m.un,
      p_cantidad: m.cantidad,
      p_f_vencimiento: m.fVencimiento || null,
      p_turno: m.turno,
      p_usuario_id: m.usuarioId,
      p_usuario_nombre: m.usuarioNombre ?? null,
      p_usuario_correo: m.usuarioCorreo ?? null,
      p_proveedor: m.proveedor ? m.proveedor : null,
      p_uuid_sync: uuidSync || null,
      p_codigo_inc: m.codigoInc || null,
    })
    // Stock insuficiente es un error controlado — NUNCA bypassear la decisión del RPC.
    // El RPC tiene advisory lock y calcula stock de forma atómica; es la fuente de verdad.
    if (error) {
      const msg = error.message || ''
      const code = (error as unknown as Record<string, string>).code || ''
      if (msg.includes('INSUFFICIENT_STOCK')) {
        const parts = msg.split('|')
        const rpcDetail = parts.length > 1 ? parts[1] : 'Stock insuficiente para esta operación'
        const err = new Error('INSUFFICIENT_STOCK')
        ;(err as unknown as Record<string, string>).detail = rpcDetail
        throw err
      }
      // Si la RPC no existe (404 / 42883 / 'Could not find'), usar fallback
      if (code === '42883' || code === 'PGRST202' || msg.includes('Could not find') || msg.includes('does not exist') || msg.includes('404')) {
        return await addMovimientoFallback(m, uuidSync)
      }
      throw error
    }
    // RPC exitosa: el movimiento ya fue registrado en la DB.
    // Intentar refrescar la lista de movimientos, pero si falla (timeout, red)
    // NO propagar el error — el movimiento ya está guardado. Retornar array vacío
    // para que el caller no reciba null (evita crashes en .map()).
    try {
      return await fetchMovimientos()
    } catch (fetchErr) {
      console.warn('[addMovimiento] RPC exitosa pero fetchMovimientos() falló. Movimiento ya registrado.', fetchErr)
      return []
    }
  } catch (err: unknown) {
    // Si la RPC no existe aún (SQL no ejecutado), fallback al insert directo
    const errMsg = err instanceof Error ? err.message : ''
    const errCode = err instanceof Error ? (err as unknown as Record<string, string>).code || '' : ''
    if (errCode === '42883' || errCode === 'PGRST202' || errMsg.includes('Could not find') || errMsg.includes('does not exist')) {
      return await addMovimientoFallback(m, uuidSync)
    }
    throw err
  }
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
  posicion: string,
  excluirInc: boolean = false
): Promise<number> {
  const target = codigo.trim().toUpperCase()
  // Filtrar en BD usando norm() en los parámetros para evitar fallos con formatos mixtos ('01' vs '1').
  // Se envían AMBOS formatos posibles (con/sin ceros) cuando el valor tiene menos de 2 dígitos,
  // pero la BD usa LPAD así que siempre tiene ceros. Aplicamos norm() al parámetro y comparamos
  // client-side como respaldo.
  const query = dataClient
    .from('movimientos')
    .select('tipo, cantidad, torre, piso, posicion, codigo_inc')
    .eq('bloque', bloque)
    .eq('codigo', target)
  if (excluirInc) {
    query.is('codigo_inc', null)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).reduce(
    (s: number, r: Record<string, unknown>) => {
      // Doble filtro: BD ya filtró por bloque+codigo, pero verificamos ubicación con norm()
      // por si hay formatos mixtos (ej. BD tiene '01' y el grid usa '1')
      if (norm(r.torre) !== torre || norm(r.piso) !== piso || norm(r.posicion) !== posicion) return s
      const qty = typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0
      return s + impactoStock(String(r.tipo), qty)
    },
    0
  )
}

export type LoteInfo = {
  fVencimiento: string
  cantidad: number
}

export type StockEnUbicacion = {
  codigo: string
  descripcion: string
  un: string
  stock: number
  fVencimiento?: string  // FEFO: fecha más próxima (para compatibilidad)
  lotes?: LoteInfo[]    // Desglose por fecha de vencimiento individual
  usuarioPrimerNombre?: string
  proveedor?: string
  codigoInc?: string
}

export async function stockEnUbicacion(
  bloque: string,
  torre: string,
  piso: string,
  posicion: string
): Promise<StockEnUbicacion[]> {
  try {
    // Filtrar en BD por ubicación completa con norm() para compatibilidad de formatos.
    // Se consulta por (bloque, torre, piso, posicion) usando los valores normalizados,
    // con un respaldo client-side para cualquier discrepancia de formato.
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

    // Agrupar por (codigo, codigo_inc, f_vencimiento) para rastrear lotes individuales,
    // luego reagrupar por (codigo, codigo_inc) con el desglose de lotes.
    // Esto permite mostrar la fecha REAL de cada ingreso, no solo la FEFO.
    const lotMap = new Map<string, {
      codigo: string; descripcion: string; un: string;
      stock: number; fVencimiento: string;
      usuarioPrimerNombre: string; proveedor: string; codigoInc: string;
    }>()

    for (const r of allRows) {
      const m = fromRow(r)
      const incKey = m.codigoInc || ''
      const vencKey = m.fVencimiento || '__sin_fecha__'
      const key = `${m.codigo}||${incKey}||${vencKey}`

      let lot = lotMap.get(key)
      if (!lot) {
        lot = {
          codigo: m.codigo,
          descripcion: m.descripcion,
          un: m.un,
          stock: 0,
          fVencimiento: m.fVencimiento || '',
          usuarioPrimerNombre: m.usuarioNombre?.split(' ')[0] ?? '',
          proveedor: m.proveedor ?? '',
          codigoInc: incKey,
        }
        lotMap.set(key, lot)
      } else {
        if (!lot.descripcion && m.descripcion) lot.descripcion = m.descripcion
      }

      // Calcular stock neto (ingreso/devolucion/traslado = +, salida = -)
      const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
      const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? qty : -qty
      lot.stock += delta
    }

    // Filtrar lotes con stock > 0
    const activeLots = Array.from(lotMap.values()).filter(l => l.stock > 0)

    // Reagrupar por (codigo, codigo_inc) para el resultado final
    const groups = new Map<string, {
      codigo: string; descripcion: string; un: string;
      stock: number; fVencimientoMasProxima: string;
      usuarioPrimerNombre: string; proveedor: string; codigoInc: string;
      lotes: LoteInfo[];
    }>()

    for (const lot of activeLots) {
      const groupKey = `${lot.codigo}||${lot.codigoInc}`
      let group = groups.get(groupKey)
      if (!group) {
        group = {
          codigo: lot.codigo,
          descripcion: lot.descripcion,
          un: lot.un,
          stock: 0,
          fVencimientoMasProxima: lot.fVencimiento,
          usuarioPrimerNombre: lot.usuarioPrimerNombre,
          proveedor: lot.proveedor,
          codigoInc: lot.codigoInc,
          lotes: [],
        }
        groups.set(groupKey, group)
      }
      group.stock += lot.stock
      // Actualizar FEFO si este lote tiene fecha más próxima
      if (lot.fVencimiento) {
        if (!group.fVencimientoMasProxima || lot.fVencimiento < group.fVencimientoMasProxima) {
          group.fVencimientoMasProxima = lot.fVencimiento
        }
      }
      // Agregar lote individual
      group.lotes.push({
        fVencimiento: lot.fVencimiento,
        cantidad: Math.round(lot.stock * 1000) / 1000,
      })
    }

    // Ordenar por FEFO: fecha de vencimiento más próxima primero, sin fecha al final
    const results = Array.from(groups.values()).filter(g => g.stock > 0)
    results.sort((a, b) => {
      if (a.fVencimientoMasProxima && b.fVencimientoMasProxima) return a.fVencimientoMasProxima.localeCompare(b.fVencimientoMasProxima)
      if (a.fVencimientoMasProxima && !b.fVencimientoMasProxima) return -1
      if (!a.fVencimientoMasProxima && b.fVencimientoMasProxima) return 1
      return 0
    })

    return results.map(g => ({
      codigo: g.codigo,
      descripcion: g.descripcion,
      un: g.un,
      stock: Math.round(g.stock * 1000) / 1000,
      fVencimiento: g.fVencimientoMasProxima || undefined,
      lotes: g.lotes.length > 1 ? g.lotes : undefined,
      usuarioPrimerNombre: g.usuarioPrimerNombre || undefined,
      proveedor: g.proveedor || undefined,
      codigoInc: g.codigoInc || undefined,
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
        codigoInc: (r.codigo_inc as string) ?? undefined,
      }))
    } catch (err) {
      console.error('[stockEnUbicacion] Tanto cálculo directo como RPC fallback fallaron:', err)
      // Retornar array vacío pero con marker de error para que el UI distinga
      return [{ codigo: '', descripcion: '', un: '', stock: 0, _error: true } as StockEnUbicacion & { _error?: boolean }]
    }
  }
}

/** Consulta dedicada: ubicaciones que tienen INC con stock > 0.
 *  Retorna un Map que puede estar marcado con `_error: true` si la consulta falló. */
export async function fetchIncPorUbicacion(): Promise<Map<string, IncEnCelda[]> & { _error?: boolean }> {
  try {
    const allRows: Record<string, unknown>[] = []
    let from = 0
    const BATCH = 1000
    for (let page = 0; page < 10; page++) {
      const { data, error } = await dataClient
        .from('movimientos')
        .select('bloque, torre, piso, posicion, codigo, descripcion, un, codigo_inc, tipo, cantidad')
        .not('codigo_inc', 'is', null)
        .neq('codigo_inc', '')
        .range(from, from + BATCH - 1)
      if (error) {
        console.error('[fetchIncPorUbicacion] Error en paginación INC:', error.message)
        const errMap = new Map<string, IncEnCelda[]>() as Map<string, IncEnCelda[]> & { _error?: boolean }
        errMap._error = true
        return errMap
      }
      const rows = data ?? []
      allRows.push(...rows)
      if (rows.length < BATCH) break
      from += BATCH
    }
    // Calcular stock neto por ubicación + código INC
    const map = new Map<string, Map<string, { codigo: string; descripcion: string; codigoInc: string; stock: number }>>()
    for (const r of allRows) {
      const key = `${norm(r.bloque)}-${norm(r.torre)}-${norm(r.piso)}-${norm(r.posicion)}`
      const code = String(r.codigo ?? '').trim().toUpperCase()
      const codeInc = String(r.codigo_inc ?? '').trim()
      const incKey = `${code}||${codeInc}`
      let locMap = map.get(key)
      if (!locMap) { locMap = new Map(); map.set(key, locMap) }
      const qty = typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0
      const delta = ['ingreso', 'devolucion', 'traslado'].includes(String(r.tipo)) ? qty : -qty
      const item = locMap.get(incKey)
      if (item) { item.stock += delta } else {
        locMap.set(incKey, { codigo: code, descripcion: String(r.descripcion ?? ''), codigoInc: codeInc, stock: delta })
      }
    }
    const result = new Map<string, IncEnCelda[]>()
    for (const [key, locMap] of map) {
      const items: IncEnCelda[] = []
      for (const [, item] of locMap) {
        if (item.stock > 0) items.push({ codigo: item.codigo, descripcion: item.descripcion, codigoInc: item.codigoInc, cantidad: item.stock })
      }
      if (items.length > 0) result.set(key, items)
    }
    return result
  } catch (err) {
    console.error('[fetchIncPorUbicacion] Error consultando INC:', err)
    const errMap = new Map<string, IncEnCelda[]>() as Map<string, IncEnCelda[]> & { _error?: boolean }
    errMap._error = true
    return errMap
  }
}

// ═══ Ocupación y Stock por RPC (PostgreSQL calcula, sin límite de filas) ═══

/** Ocupación v2: usa el RPC que calcula en PostgreSQL (sin límite).
 *  Fallback: retorna null para que el caller use client-side. */
export async function fetchOcupacionCeldasV2(): Promise<OcupacionCelda[] | null> {
  try {
    const { data, error } = await dataClient.rpc('ocupacion_celdas_v2')
    if (error) {
      console.warn('[fetchOcupacionCeldasV2] RPC no disponible o error:', error.message)
      return null
    }
    const raw = (data ?? []) as Record<string, unknown>[]
    // Si el RPC retorna 0 celdas, podría estar mal — fall through a null
    // para que el caller use el fallback client-side.
    if (raw.length === 0) {
      console.warn('[fetchOcupacionCeldasV2] RPC retornó 0 celdas, usando fallback')
      return null
    }
    const cells = raw.map((r) => ({
      bloque: norm(r.bloque),
      torre: norm(r.torre),
      piso: norm(r.piso),
      posicion: norm(r.posicion),
      stock: Number(r.stock ?? 0),
      codigos: Array.isArray(r.codigos) ? (r.codigos as string[]).map(String) : [],
      lotes: Number(r.lotes ?? 0),
      tieneInc: false,
      incItems: [],
    }))
    // Diagnóstico: muestra si hay celdas en bloques 7-9 con posiciones normalizadas
    const b789 = cells.filter(c => ['7','8','9'].includes(c.bloque))
    if (b789.length > 0) {
      console.log('[OcupacionV2] Muestra bloques 7-9:', b789.slice(0, 5).map(c => `B${c.bloque}-T${c.torre}-P${c.piso}-Pos${c.posicion} stock=${c.stock}`))
    }
    return cells
  } catch (err) {
    console.warn('[fetchOcupacionCeldasV2] Falló:', err)
    return null
  }
}

/** Ocupación v1: RPC legacy (ya existente, sin codigos array) */
export async function fetchOcupacionCeldas(): Promise<OcupacionCelda[]> {
  const { data, error } = await dataClient.rpc('ocupacion_celdas')
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    bloque: norm(r.bloque),
    torre: norm(r.torre),
    piso: norm(r.piso),
    posicion: norm(r.posicion),
    stock: Number(r.stock ?? 0),
    codigos: Array.isArray(r.codigos) ? (r.codigos as string[]).map(String) : [],
    lotes: Number(r.lotes ?? 0),
    tieneInc: false,
    incItems: [],
  }))
}

/** Stock por código: RPC que calcula en PostgreSQL (sin límite).
 *  Fallback: retorna null para que el caller use client-side. */
export async function fetchStockPorCodigoRPC(
  codigo: string,
  soloInc: boolean = false
): Promise<{ bloque: string; torre: string; piso: string; posicion: string; stock: number; descripcion: string | null; un: string | null; proveedor: string | null; fVencimiento: string | null; codigoInc?: string }[] | null> {
  try {
    const { data, error } = await dataClient.rpc('stock_por_codigo_kardex', {
      p_codigo: codigo.trim().toUpperCase(),
      p_solo_inc: soloInc,
    })
    if (error) {
      console.warn('[fetchStockPorCodigoRPC] RPC no disponible o error:', error.message)
      return null
    }
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      bloque: norm(r.bloque),
      torre: norm(r.torre),
      piso: norm(r.piso),
      posicion: norm(r.posicion),
      stock: Number(r.stock ?? 0),
      descripcion: (r.descripcion as string) ?? null,
      un: (r.un as string) ?? null,
      proveedor: (r.proveedor as string) ?? null,
      fVencimiento: (r.f_vencimiento as string) ?? null,
      codigoInc: soloInc ? codigo.trim().toUpperCase() : undefined,
    }))
  } catch (err) {
    console.warn('[fetchStockPorCodigoRPC] Falló:', err)
    return null
  }
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
  codigoInc?: string
  /** Cantidad de ajuste en origen. Positivo = ingreso (qty > stock), Negativo = salida (qty < stock) */
  cantidadAjuste?: number
  /** UUID de idempotencia para reintentos offline y prevención de duplicados */
  uuidSync?: string
}

/** Fallback: insert directo para traslado cuando la RPC no existe en Supabase */
async function trasladarMovimientoFallback(t: TrasladoInput): Promise<Movimiento[]> {
  console.warn('[trasladarMovimiento] RPC no encontrada, usando insert directo como fallback')
  const codigo = t.codigo.trim().toUpperCase()

  // ── Prevenir traslado a la misma ubicación ──
  if (t.origen.bloque === t.destino.bloque && t.origen.torre === t.destino.torre 
      && t.origen.piso === t.destino.piso && t.origen.posicion === t.destino.posicion) {
    const err = new Error('SAME_ORIGIN_DESTINATION')
    ;(err as unknown as Record<string, string>).detail = 'El destino no puede ser igual al origen'
    throw err
  }

  // ── Validar stock suficiente en origen (solo si NO es INC) ──
  if (!t.codigoInc) {
    try {
      const originStock = await calcularStockUbicacion(
        codigo, t.origen.bloque, t.origen.torre, t.origen.piso, t.origen.posicion, true // excluir INC
      )
      const stockRedondeado = Math.round(originStock * 1000) / 1000
      if (t.cantidad > stockRedondeado + 0.001) {
        const err = new Error('INSUFFICIENT_STOCK')
        ;(err as unknown as Record<string, string>).detail =
          `Stock en origen = ${stockRedondeado} ${t.un}, cantidad a trasladar = ${t.cantidad} ${t.un}`
        throw err
      }
    } catch (stockErr) {
      if (stockErr instanceof Error && stockErr.message === 'INSUFFICIENT_STOCK') throw stockErr
      console.error('[trasladarMovimientoFallback] No se pudo verificar stock, BLOQUEANDO:', stockErr)
      throw new Error('STOCK_VALIDATION_FAILED|No se pudo verificar el stock en origen. Reintente.')
    }
  }

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
    codigo_inc: t.codigoInc || null,
  }
  const ajuste = (t.cantidadAjuste ?? 0) !== 0
    ? [{
        ...base,
        tipo: (t.cantidadAjuste ?? 0) > 0 ? 'ingreso' as const : 'salida' as const,
        bloque: t.origen.bloque,
        torre: t.origen.torre,
        piso: t.origen.piso,
        posicion: t.origen.posicion,
        cantidad: Math.abs(t.cantidadAjuste!),
        uuid_sync: t.uuidSync || null, // uuid_sync solo en la primera fila (ajuste o salida)
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
      // uuid_sync: solo en primera fila para evitar violación UNIQUE
      uuid_sync: ajuste.length === 0 ? (t.uuidSync || null) : null,
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
  try {
    return await fetchMovimientos()
  } catch (fetchErr) {
    console.warn('[trasladarMovimientoFallback] Insert exitoso pero fetchMovimientos() falló.', fetchErr)
    return []
  }
}

export async function trasladarMovimiento(t: TrasladoInput): Promise<Movimiento[]> {
  // Usar RPC atómica con advisory locks en origen Y destino
  try {
    const { data, error } = await dataClient.rpc('registrar_traslado_kardex', {
      p_codigo: t.codigo,
      p_descripcion: t.descripcion,
      p_un: t.un,
      p_cantidad: t.cantidad,
      p_orig_bloque: t.origen.bloque,
      p_orig_torre: t.origen.torre,
      p_orig_piso: t.origen.piso,
      p_orig_pos: t.origen.posicion,
      p_dest_bloque: t.destino.bloque,
      p_dest_torre: t.destino.torre,
      p_dest_piso: t.destino.piso,
      p_dest_pos: t.destino.posicion,
      p_turno: t.turno,
      p_usuario_id: t.usuarioId,
      p_usuario_nombre: t.usuarioNombre ?? null,
      p_usuario_correo: t.usuarioCorreo ?? null,
      p_f_vencimiento: t.fVencimiento || null,
      p_proveedor: t.proveedor ? t.proveedor : null,
      p_cantidad_ajuste: t.cantidadAjuste ?? 0,
      p_codigo_inc: t.codigoInc || null,
      p_uuid_sync: t.uuidSync || null,
    })
    // Stock insuficiente en origen — NUNCA bypassear la decisión del RPC.
    // El RPC tiene advisory locks en origen Y destino; es la fuente de verdad.
    if (error) {
      const msg = error.message || ''
      const code = (error as unknown as Record<string, string>).code || ''
      if (msg.includes('INSUFFICIENT_STOCK')) {
        const parts = msg.split('|')
        const rpcDetail = parts.length > 1 ? parts[1] : 'Stock insuficiente en origen para este traslado'
        const err = new Error('INSUFFICIENT_STOCK')
        ;(err as unknown as Record<string, string>).detail = rpcDetail
        throw err
      }
      // Si la RPC no existe (404 / 42883 / 'Could not find'), usar fallback
      if (code === '42883' || code === 'PGRST202' || msg.includes('Could not find') || msg.includes('does not exist') || msg.includes('404')) {
        return await trasladarMovimientoFallback(t)
      }
      // Origen = destino (server guard)
      if (msg.includes('SAME_ORIGIN_DESTINATION')) {
        const err = new Error('SAME_ORIGIN_DESTINATION')
        ;(err as unknown as Record<string, string>).detail = 'El destino no puede ser igual al origen'
        throw err
      }
      throw error
    }
    // RPC exitosa: refrescar movimientos, pero no fallar si fetchMovimientos falla.
    // Retornar array vacío para evitar crashes en el UI.
    try {
      return await fetchMovimientos()
    } catch (fetchErr) {
      console.warn('[trasladarMovimiento] RPC exitosa pero fetchMovimientos() falló. Traslado ya registrado.', fetchErr)
      return []
    }
  } catch (err: unknown) {
    // Fallback si la RPC no existe aún
    const errMsg = err instanceof Error ? err.message : ''
    const errCode = err instanceof Error ? (err as unknown as Record<string, string>).code || '' : ''
    if (errCode === '42883' || errCode === 'PGRST202' || errMsg.includes('Could not find') || errMsg.includes('does not exist')) {
      return await trasladarMovimientoFallback(t)
    }
    throw err
  }
}

/**
 * Elimina TODOS los movimientos de la tabla.
 * Usa service_role para bypassear RLS.
 * Borra en lotes de 1000 IDs para no exceder límites de URL.
 */
export async function deleteAllMovimientos(): Promise<{ deleted: boolean; error?: string }> {
  // Usar dataClient (service role) ya configurado — sin credenciales hardcodeadas
  const admin = dataClient

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
  // Usar dataClient (service role) ya configurado — sin credenciales hardcodeadas
  const admin = dataClient

  const turno = (await import('./turno')).calcularTurno()
  const errors: string[] = []
  let inserted = 0
  const BATCH_SIZE = 1000

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const inserts = batch.map((r) => ({
      tipo: 'ingreso' as const,
      bloque: norm(r.bloque),
      torre: norm(r.torre),
      piso: norm(r.piso),
      posicion: norm(r.posicion),
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
      codigo_inc: null,
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
  posicion: string,
  fVencimiento?: string,
  codigoInc?: string
): Promise<Movimiento[]> {
  const target = codigo.trim().toUpperCase()
  let query = dataClient
    .from('movimientos')
    .delete()
    .eq('codigo', target)
    .eq('bloque', bloque)
    .eq('torre', torre)
    .eq('piso', piso)
    .eq('posicion', posicion)
  // Si se especifica fVencimiento, filtrar solo ese lote
  if (fVencimiento) {
    query = query.eq('f_vencimiento', fVencimiento)
  }
  // Filtrar por codigo_inc para no borrar INC junto con stock normal
  if (codigoInc) {
    query = query.eq('codigo_inc', codigoInc)
  } else {
    query = query.is('codigo_inc', null)
  }
  const { error } = await query
  if (error) throw error
  return fetchMovimientos()
}
