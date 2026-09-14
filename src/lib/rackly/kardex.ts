'use client'

import { dataClient } from '@/lib/supabase/client'
import { PAGE_SIZE, MAX_ITERATIONS, FETCH_MOV_MAX_PAGES, MOVIMIENTOS_ENTRADA, TURNO_DIA, TURNO_NOCHE } from './constants'
import { impactoStock } from '@/lib/utils'
import { toast } from 'sonner'

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
  lote?: string // Código de lote FÍSICO digitado en ingresos/devoluciones (ej: AP-304501210021). Informativo: no afecta stock ni FEFO.
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
    // Si la columna aún no existe (migración SQL pendiente), r.lote es undefined -> queda undefined.
    lote: ((r.lote as string) || '').trim() || undefined,
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
    const delta = ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(m.tipo) ? m.cantidad : -m.cantidad
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

  const payload: Record<string, unknown> = {
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
  }
  // Lote físico: solo se envía si el usuario digitó uno. Si la columna aún no existe
  // (migración pendiente) se reintenta SIN lote para que el movimiento nunca falle.
  const loteClean = (m.lote || '').trim()
  if (loteClean) payload.lote = loteClean

  let insErr: unknown = null
  {
    const res = await dataClient.from('movimientos').insert(payload)
    insErr = res.error
    if (insErr && loteClean && isLoteUnsupportedError(insErr)) {
      console.warn('[addMovimientoFallback] Columna lote no existe aún — insertando SIN lote. Ejecutar rackly_lote.sql en Supabase.')
      const { lote: _omit, ...sinLote } = payload
      const retry = await dataClient.from('movimientos').insert(sinLote)
      insErr = retry.error
      if (!retry.error) avisarLoteNoGuardado('movimiento')
    }
  }
  if (insErr) throw insErr
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

  // Usar RPC atómica con advisory lock para evitar race conditions.
  // La RPC maneja TODOS los tipos de movimiento incluyendo INC.
  // INC items son tipo 'ingreso' así que no pasan validación de stock negativo.
  // p_lote SOLO se envía si el usuario digitó un lote; si la RPC aún no lo soporta
  // (firma vieja) se reintenta SIN lote para conservar la atomicidad de la RPC.
  const loteClean = (m.lote || '').trim()
  const rpcArgs: Record<string, unknown> = {
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
  }
  if (loteClean) rpcArgs.p_lote = loteClean

  try {
    let res = await dataClient.rpc('registrar_movimiento_kardex', rpcArgs)
    if (res.error && loteClean && isLoteUnsupportedError(res.error)) {
      console.warn('[addMovimiento] RPC sin soporte p_lote — reintentando SIN lote (ejecutar rackly_lote.sql para guardarlo).')
      const { p_lote: _omit, ...sinLote } = rpcArgs
      res = await dataClient.rpc('registrar_movimiento_kardex', sinLote)
      if (!res.error) avisarLoteNoGuardado('movimiento')
    }
    const { data, error } = res
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
  /** Códigos de lote FÍSICOS (digitados en ingresos) presentes en este grupo de fecha.
   *  Solo trazabilidad: no participa en el descuento ni en el orden FEFO. */
  lotesFisicos?: string[]
}

/**
 * Algoritmo de lotes remanentes (FEFO con dirección por fecha + desborde).
 *
 * Semántica (acordada con operación):
 *  - Una SALIDA con fecha F descuenta PRIMERO del lote con fecha F (el lote que el usuario eligió).
 *  - Una SALIDA sin fecha descuenta PRIMERO del lote sin fecha (material sin vencimiento).
 *  - Si el lote dirigido no alcanza, el remanente se desborda en orden FEFO
 *    (fechas más antiguas primero, lote sin fecha al final).
 *
 * Con esto ningún lote queda en negativo y la salida respeta el lote seleccionado.
 * El stock TOTAL (suma de remanentes) siempre es igual a ingresos - salidas.
 */
export function calcularLotesRemanentes(
  ingresos: Map<string, number>,
  salidas: Array<{ venc: string; qty: number }>
): { venc: string; cantidad: number }[] {
  // Remanente inicial por lote (solo ingresos positivos)
  const rem = new Map<string, number>()
  for (const [v, q] of ingresos) {
    if (q > 0) rem.set(v, (rem.get(v) ?? 0) + q)
  }
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
  for (const s of salidas) {
    let pend = s.qty
    if (!(pend > 0)) continue
    if (s.venc && (rem.get(s.venc) ?? 0) > 0) {
      // Salida dirigida al lote con la fecha registrada
      pend = descontarDe(s.venc, pend)
    } else if (!s.venc && (rem.get('') ?? 0) > 0) {
      // Salida sin fecha: primero el lote sin fecha
      pend = descontarDe('', pend)
    }
    // Desborde FEFO por lo que falte
    if (pend > 0) {
      for (const v of ordenFefo) {
        if (pend <= 0) break
        pend = descontarDe(v, pend)
      }
    }
  }
  // ═══ FIX residuos de punto flotante ═══
  // Redondear a 3 decimales (precisión de la BD) ANTES del filtro cantidad > 0.
  // Sin esto, sumas binarias como 30.780+30.780+82.080 menos salidas FEFO dejan
  // residuos de ~1e-14 que pasan el filtro y aparecen como lotes con 0 stock.
  const out = Array.from(rem.entries())
    .map(([venc, cantidad]) => ({ venc, cantidad: Math.round(cantidad * 1000) / 1000 }))
    .filter(({ cantidad }) => cantidad > 0)
  out.sort((a, b) => {
    if (a.venc && b.venc) return a.venc.localeCompare(b.venc)
    if (a.venc && !b.venc) return -1
    if (!a.venc && b.venc) return 1
    return 0
  })
  return out
}

export type StockEnUbicacion = {
  codigo: string
  descripcion: string
  un: string
  stock: number
  fVencimiento?: string  // FEFO: fecha más próxima (para compatibilidad)
  lotes?: LoteInfo[]    // Desglose por fecha de vencimiento individual
  /** Código de lote físico del primer lote (FEFO) cuando es único.
   *  Para ver el detalle por lote usar `lotes[].lotesFisicos`. */
  loteFisico?: string
  usuarioPrimerNombre?: string
  proveedor?: string
  codigoInc?: string
}

/** Detecta si un error se debe a que la columna/parámetro `lote` aún no existe en la BD
 *  (migración rackly_lote.sql pendiente de ejecutar). Permite reintentar sin lote
 *  para que el movimiento NUNCA falle por el campo nuevo.
 *  IMPORTANTE: postgrest-js resuelve los errores HTTP como OBJETOS PLANOS
 *  (JSON.parse del body: { code, message, details, hint }), NO como instancias de
 *  Error. Por eso NO se puede usar `instanceof Error` aquí — se hace duck-typing
 *  para soportar ambas formas. (Fix del 400 PGRST204 que bloqueaba ingresos.) */
export function isLoteUnsupportedError(err: unknown): boolean {
  const obj = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>
  const code = typeof obj.code === 'string' ? obj.code : ''
  const msg = typeof obj.message === 'string' ? obj.message : String(err ?? '')
  if (code === '42703' || code === 'PGRST204') return true // columna no existe
  // Parámetro no reconocido por una RPC con firma vieja (PGRST202 / 'Could not find the function')
  if ((code === 'PGRST202' || code === '42883' || msg.includes('Could not find')) && msg.toLowerCase().includes('lote')) return true
  return false
}

/** Aviso al usuario: el movimiento/traslado SÍ se registró, pero el lote digitado NO
 *  quedó guardado porque la BD aún no tiene la columna/parámetro (migración
 *  rackly_lote.sql pendiente de ejecutar en Supabase → SQL Editor).
 *  id fijo: evita apilar avisos duplicados en ráfaga. */
function avisarLoteNoGuardado(contexto: 'movimiento' | 'traslado'): void {
  toast.warning(
    contexto === 'traslado' ? 'Traslado registrado — lote NO guardado' : 'Movimiento registrado — lote NO guardado',
    {
      id: 'lote-no-guardado',
      description: 'Falta ejecutar el SQL rackly_lote.sql en Supabase (SQL Editor). El lote digitado no quedó almacenado en la BD.',
    }
  )
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

    // ── Paso 1: Pools de INGRESOS por lote y SALIDAS dirigidas por (codigo, codigo_inc) ──
    const ingresosMap = new Map<string, Map<string, number>>()   // key -> (venc -> qty)
    const salidasMap = new Map<string, Array<{ venc: string; qty: number }>>()
    // Códigos de lote FÍSICOS (digitados en ingresos) por (key -> venc): solo trazabilidad
    const lotesFisMap = new Map<string, Map<string, Set<string>>>()
    const metaMap = new Map<string, {
      codigo: string; descripcion: string; un: string;
      usuarioPrimerNombre: string; proveedor: string; codigoInc: string;
    }>()

    const isPosTipo = (t: string) => ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(t)

    for (const r of allRows) {
      const m = fromRow(r)
      const incKey = m.codigoInc || ''
      const key = `${m.codigo}||${incKey}`
      const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
      if (!(qty > 0)) continue

      if (!metaMap.has(key)) {
        metaMap.set(key, {
          codigo: m.codigo, descripcion: m.descripcion, un: m.un,
          usuarioPrimerNombre: m.usuarioNombre?.split(' ')[0] ?? '',
          proveedor: m.proveedor ?? '', codigoInc: incKey,
        })
      } else {
        const meta = metaMap.get(key)!
        if (!meta.descripcion && m.descripcion) meta.descripcion = m.descripcion
      }

      const venc = m.fVencimiento || ''
      if (isPosTipo(m.tipo)) {
        const pool = ingresosMap.get(key) ?? new Map<string, number>()
        pool.set(venc, (pool.get(venc) ?? 0) + qty)
        ingresosMap.set(key, pool)
        // Registrar el código de lote físico si el ingreso lo trajo
        if (m.lote) {
          let porKey = lotesFisMap.get(key)
          if (!porKey) { porKey = new Map(); lotesFisMap.set(key, porKey) }
          const set = porKey.get(venc) ?? new Set<string>()
          set.add(m.lote)
          porKey.set(venc, set)
        }
      } else {
        // Las salidas conservan su orden temporal (allRows viene ordenado por f_modificacion ASC)
        const list = salidasMap.get(key) ?? []
        list.push({ venc, qty })
        salidasMap.set(key, list)
      }
    }

    // ── Paso 2: Remanentes por lote (salida dirigida al lote elegido + desborde FEFO) ──
    // Ver calcularLotesRemanentes(): ningún lote queda en negativo y el descuento
    // respeta la fecha registrada en cada salida. Stock total = ingresos - salidas.
    const groups = new Map<string, {
      codigo: string; descripcion: string; un: string;
      stock: number; fVencimientoMasProxima: string;
      usuarioPrimerNombre: string; proveedor: string; codigoInc: string;
      lotes: LoteInfo[]; loteFisico?: string;
    }>()

    for (const [key, pool] of ingresosMap) {
      const meta = metaMap.get(key)
      if (!meta) continue
      const remanentes = calcularLotesRemanentes(pool, salidasMap.get(key) ?? [])
      const stockTotal = remanentes.reduce((s, l) => s + l.cantidad, 0)
      if (stockTotal <= 0) continue
      const porVenc = lotesFisMap.get(key)
      const lotesConFisico: LoteInfo[] = remanentes.map(l => {
        const codigos = porVenc?.get(l.venc)
        const fisicos = codigos && codigos.size > 0 ? Array.from(codigos).sort() : undefined
        return fisicos ? { fVencimiento: l.venc, cantidad: Math.round(l.cantidad * 1000) / 1000, lotesFisicos: fisicos } : { fVencimiento: l.venc, cantidad: Math.round(l.cantidad * 1000) / 1000 }
      })
      const fefoFisicos = lotesConFisico[0]?.lotesFisicos
      groups.set(key, {
        codigo: meta.codigo, descripcion: meta.descripcion, un: meta.un,
        stock: Math.round(stockTotal * 1000) / 1000,
        fVencimientoMasProxima: remanentes.find(l => l.venc)?.venc || '',
        usuarioPrimerNombre: meta.usuarioPrimerNombre, proveedor: meta.proveedor, codigoInc: meta.codigoInc,
        lotes: lotesConFisico,
        loteFisico: fefoFisicos && fefoFisicos.length > 0 ? fefoFisicos.join(', ') : undefined,
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
      loteFisico: g.loteFisico || undefined,
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
      const delta = ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(String(r.tipo)) ? qty : -qty
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
  /** Código de lote físico del material trasladado (se conserva en destino). Solo si es inequívoco. */
  lote?: string
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
  // Lote físico del material: solo si el usuario/origen lo aporta. Si la columna aún no
  // existe (migración pendiente) se reintenta SIN lote para que el traslado nunca falle.
  const loteClean = (t.lote || '').trim()
  const baseAny = base as Record<string, unknown>
  if (loteClean) baseAny.lote = loteClean
  const ajuste = (t.cantidadAjuste ?? 0) !== 0
    ? [{
        ...baseAny,
        tipo: (t.cantidadAjuste ?? 0) > 0 ? 'ingreso' as const : 'salida' as const,
        bloque: t.origen.bloque,
        torre: t.origen.torre,
        piso: t.origen.piso,
        posicion: t.origen.posicion,
        cantidad: Math.abs(t.cantidadAjuste!),
        uuid_sync: t.uuidSync || null, // uuid_sync solo en la primera fila (ajuste o salida)
      }]
    : []
  const filas = [
    ...ajuste,
    {
      ...baseAny,
      tipo: 'salida' as const,
      bloque: t.origen.bloque,
      torre: t.origen.torre,
      piso: t.origen.piso,
      posicion: t.origen.posicion,
      cantidad: t.cantidad,
      // uuid_sync: solo en primera fila para evitar violación UNIQUE
      uuid_sync: ajuste.length === 0 ? (t.uuidSync || null) : null,
    },
    {
      ...baseAny,
      tipo: 'traslado' as const,
      bloque: t.destino.bloque,
      torre: t.destino.torre,
      piso: t.destino.piso,
      posicion: t.destino.posicion,
      cantidad: t.cantidad,
    },
  ]
  let insErr: unknown = null
  {
    const res = await dataClient.from('movimientos').insert(filas)
    insErr = res.error
    if (insErr && loteClean && isLoteUnsupportedError(insErr)) {
      console.warn('[trasladarMovimientoFallback] Columna lote no existe aún — insertando SIN lote. Ejecutar rackly_lote.sql en Supabase.')
      const filasSinLote = filas.map((f) => {
        const { lote: _omit, ...resto } = f as Record<string, unknown>
        return resto
      })
      const retry = await dataClient.from('movimientos').insert(filasSinLote)
      insErr = retry.error
      if (!retry.error) avisarLoteNoGuardado('traslado')
    }
  }
  if (insErr) throw insErr
  try {
    return await fetchMovimientos()
  } catch (fetchErr) {
    console.warn('[trasladarMovimientoFallback] Insert exitoso pero fetchMovimientos() falló.', fetchErr)
    return []
  }
}

export async function trasladarMovimiento(t: TrasladoInput): Promise<Movimiento[]> {
  // Usar RPC atómica con advisory locks en origen Y destino
  // p_lote SOLO se envía si el traslado aporta un lote inequívoco; si la RPC aún no
  // lo soporta (firma vieja) se reintenta SIN lote para conservar la atomicidad.
  const loteClean = (t.lote || '').trim()
  const rpcArgs: Record<string, unknown> = {
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
  }
  if (loteClean) rpcArgs.p_lote = loteClean

  try {
    let res = await dataClient.rpc('registrar_traslado_kardex', rpcArgs)
    if (res.error && loteClean && isLoteUnsupportedError(res.error)) {
      console.warn('[trasladarMovimiento] RPC sin soporte p_lote — reintentando SIN lote (ejecutar rackly_lote.sql para guardarlo).')
      const { p_lote: _omit, ...sinLote } = rpcArgs
      res = await dataClient.rpc('registrar_traslado_kardex', sinLote)
      if (!res.error) avisarLoteNoGuardado('traslado')
    }
    const { data, error } = res
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
 */
export async function deleteAllMovimientos(): Promise<{ deleted: boolean; error?: string }> {
  const admin = dataClient

  // Borrar todo — gte('id', '00000000-...') matchea todos los UUIDs
  const { error } = await admin
    .from('movimientos')
    .delete()
    .gte('id', '00000000-0000-0000-0000-000000000000')

  if (error) return { deleted: false, error: error.message }

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
  codigoInc?: string
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
      codigo_inc: r.codigoInc ? r.codigoInc.trim() : null,
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
