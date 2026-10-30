'use client'

import { dataClient } from '@/lib/supabase/client'
import { PAGE_SIZE, MAX_ITERATIONS, FETCH_MOV_MAX_PAGES, MOVIMIENTOS_ENTRADA, TURNO_DIA, TURNO_NOCHE } from './constants'
import { impactoStock } from '@/lib/utils'
import { toast } from 'sonner'
import { exigirBorradas } from '@/lib/rackly/eliminacion-honesta'
import { ERR_ELIMINAR_BLOQUEADO, errorControlado } from '@/lib/rackly/errores'

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
  // ── FIX Task 24 (pestañas sin datos) ──
  // La descarga completa era SECUENCIAL (51 páginas de 500 en serie ≈ 30-60 s
  // con 25K+ filas): FEFO/Traslado/Stock/Movimientos parecían "sin datos"
  // durante todo ese lapso. Ahora se descarga la 1ª página con `count: exact`
  // para dimensionar la tabla y el resto se pide en OLEADAS CONCURRENTES
  // (8 en paralelo). Mismo orden (f_modificacion DESC, id ASC), mismo
  // resultado y mismos topes (FETCH_MOV_MAX_PAGES) — solo más rápido (~6-8×).
  const CONCURRENCY = 8

  function pagina(from: number, conCount: boolean) {
    let q = dataClient.from('movimientos').select('*', conCount ? { count: 'exact' } : undefined)
    return q
      .order('f_modificacion', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
  }

  // 1ª página: datos + total real (content-range) para calcular las páginas restantes
  const primera = await pagina(0, true)
  if (primera.error) throw primera.error
  const primeraData = (primera.data ?? []) as Record<string, unknown>[]
  if (primeraData.length < PAGE_SIZE) return primeraData.map(fromRow) // tabla pequeña: 1 página
  const total = primera.count ?? primeraData.length
  const totalPaginas = Math.min(Math.ceil(total / PAGE_SIZE), FETCH_MOV_MAX_PAGES)

  const paginas: Record<string, unknown>[][] = [primeraData]
  const numerosPagina: number[] = []
  for (let p = 1; p < totalPaginas; p++) numerosPagina.push(p)

  // Oleadas de CONCURRENCY peticiones en paralelo; el índice preserva el orden global
  for (let cursor = 0; cursor < numerosPagina.length; cursor += CONCURRENCY) {
    const lote = numerosPagina.slice(cursor, cursor + CONCURRENCY)
    const resultados = await Promise.all(
      lote.map(async (p) => {
        const from = p * PAGE_SIZE
        const r = await pagina(from, false)
        if (r.error) throw r.error
        return (r.data ?? []) as Record<string, unknown>[]
      })
    )
    paginas.push(...resultados)
  }

  return paginas.flat().map(fromRow)
}

export async function fetchMovimientosByCodigo(codigo: string): Promise<Movimiento[]> {
  const upperCode = codigo.trim().toUpperCase()
  // Paginado explícito: sin .range(), PostgREST trunca silenciosamente en ~1000
  // filas y el stock calculado en Salidas (normal e INC) quedaba incompleto para
  // códigos con historial largo.
  const all: Record<string, unknown>[] = []
  let from = 0
  const BATCH = 1000
  const MAX_PAGES = 50 // tope defensivo: 50.000 movimientos de un solo código
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await dataClient
      .from('movimientos')
      .select('*')
      .eq('codigo', upperCode)
      .order('f_modificacion', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + BATCH - 1)
    if (error) throw error
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < BATCH) break
    from += BATCH
  }
  return all.map(fromRow)
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
  /** Proveedor del lote FEFO remanente (no histórico). */
  proveedor?: string
  codigo_inc?: string
}

/**
 * Calcula el stock neto en Racks para un código dado.
 * Usado por PisoStockTab para mostrar "También en Kardex Racks".
 * Solo lectura, no modifica nada.
 *
 * FIX Buscar Stock (v3.4): el f_vencimiento ya NO es el mínimo histórico de la
 * posición (que incluía lotes YA CONSUMIDOS y mostraba "lotes antiguos"), sino
 * el del PRIMER LOTE REMANENTE (FEFO real) calculado con el mismo algoritmo que
 * Stock/Ocupación/FEFO (calcularLotesRemanentes). Las posiciones INC se excluyen
 * (igual que en Stock normal) y el proveedor es el del lote FEFO remanente.
 */
export async function buscarStockRacksPorCodigo(codigo: string): Promise<StockRacksPorCodigoItem[]> {
  const movs = await fetchMovimientosByCodigo(codigo)
  return calcularStockRacksDesdeMovs(movs)
}

/** Núcleo puro de buscarStockRacksPorCodigo (testeable sin BD). */
export function calcularStockRacksDesdeMovs(movs: Movimiento[]): StockRacksPorCodigoItem[] {
  const ENTRADAS = ['ingreso', 'devolucion', 'traslado', 'stock_inicial']
  // Pools por posición (excluye INC): ingresos por venc + salidas ordenadas
  const ingMap = new Map<string, Map<string, number>>()
  const salMap = new Map<string, Array<{ venc: string; qty: number; ts: string; id: string }>>()
  const provInMap = new Map<string, Array<{ venc: string; proveedor?: string; ts: string }>>()
  const metaMap = new Map<string, StockRacksPorCodigoItem>()

  for (const m of movs) {
    if (m.codigoInc) continue // INC no participa en el stock normal (igual que Stock/Ocupación)
    const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
    const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
    if (!(qty > 0)) continue
    if (!metaMap.has(posKey)) {
      metaMap.set(posKey, {
        bloque: m.bloque, torre: m.torre, piso: m.piso, posicion: m.posicion,
        stock: 0, descripcion: m.descripcion, un: m.un, fVencimiento: '',
      })
    }
    const venc = m.fVencimiento || ''
    if (ENTRADAS.includes(m.tipo)) {
      const pool = ingMap.get(posKey) ?? new Map<string, number>()
      pool.set(venc, (pool.get(venc) ?? 0) + qty)
      ingMap.set(posKey, pool)
      if (m.proveedor) {
        const list = provInMap.get(posKey) ?? []
        list.push({ venc, proveedor: m.proveedor, ts: m.fModificacion })
        provInMap.set(posKey, list)
      }
    } else {
      const list = salMap.get(posKey) ?? []
      list.push({ venc, qty, ts: m.fModificacion, id: m.id })
      salMap.set(posKey, list)
    }
  }

  const result: StockRacksPorCodigoItem[] = []
  for (const [posKey, pool] of ingMap) {
    const meta = metaMap.get(posKey)
    if (!meta) continue
    const salidas = (salMap.get(posKey) ?? []).sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
    const rem = calcularLotesRemanentes(pool, salidas)
    const stockTotal = rem.reduce((s, l) => s + l.cantidad, 0)
    if (stockTotal <= 0) continue
    // Proveedor del lote FEFO remanente (no del movimiento histórico primero)
    const provPorVenc = proveedorPorVenc(provInMap.get(posKey) ?? [])
    const fefoVenc = rem[0]?.venc ?? ''
    const proveedorFefo = provPorVenc.get(fefoVenc)
    result.push({
      bloque: meta.bloque, torre: meta.torre, piso: meta.piso, posicion: meta.posicion,
      stock: Math.round(stockTotal * 1000) / 1000,
      descripcion: meta.descripcion, un: meta.un,
      fVencimiento: fefoVenc,
      proveedor: proveedorFefo,
    })
  }

  return result.sort((a, b) =>
    compararFEFO(a.fVencimiento, b.fVencimiento) || compararUbicacionNum(a, b))
}

/** Fallback: insert directo cuando la RPC no existe en Supabase */
async function addMovimientoFallback(
  m: Omit<Movimiento, 'id' | 'fModificacion'>,
  uuidSync?: string,
  skipValidation: boolean = false,
  refetch: boolean = true
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
  if (!refetch) return []
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

/**
 * Registra un movimiento (RPC atómica registrar_movimiento_kardex).
 *
 * opts.refetch (default true): al terminar, re-descarga TODA la tabla
 * movimientos (contrato original: retorna la lista completa actualizada).
 * Con `refetch: false` retorna [] inmediatamente tras la RPC: el registro
 * queda guardado y el CALLER se encarga de refrescar lo suyo (rápido).
 *
 * FIX tiempo real 2026-10-22 (módulo Atención → Racks): el refetch completo
 * (~25K filas, ~30-40 s) bloqueaba el ciclo salida → confirmación
 * "¿Registrar esta salida en la RQ?". Las rutas de salida (OcupacionTab,
 * TrasladoTab y salidas masivas de MovimientoForm) ya se refrescan por su
 * cuenta con consultas puntuales → pasan refetch:false y el aviso aparece
 * al instante. Las rutas que CONSUMEN el array retornado (formularios de
 * ingreso) siguen igual (default true) → cero regresiones.
 */
export async function addMovimiento(
  m: Omit<Movimiento, 'id' | 'fModificacion'>,
  uuidSync?: string,
  opts?: { refetch?: boolean }
): Promise<Movimiento[]> {
  const refetch = opts?.refetch !== false
  // Idempotencia: si viene uuidSync, verificar si ya existe en el servidor
  if (uuidSync) {
    const exists = await checkExistingByUuidSync(uuidSync)
    if (exists) {
      console.warn('[addMovimiento] Movimiento ya existe (uuid_sync), saltando insert:', uuidSync)
      // Ya existe: refrescar y retornar como si hubiera sido exitoso
      return refetch ? await fetchMovimientos() : []
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
        return await addMovimientoFallback(m, uuidSync, false, refetch)
      }
      throw error
    }
    // RPC exitosa: el movimiento ya fue registrado en la DB.
    // Con refetch:false el caller refresca por su cuenta → retornar YA
    // (tiempo real: el toast y la confirmación de RQ no esperan el refetch).
    if (!refetch) return []
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
      return await addMovimientoFallback(m, uuidSync, false, refetch)
    }
    throw err
  }
}

export async function deleteMovimiento(id: string): Promise<Movimiento[]> {
  // HONESTIDAD (patrón T173-00004281, auditoría 2026-10-31): la RLS de
  // movimientos filtra el DELETE por rol en silencio (HTTP 200, 0 filas,
  // sin error) — un éxito falso aquí dejaba el movimiento vivo.
  const { data: borradas, error } = await dataClient
    .from('movimientos')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  exigirBorradas(
    borradas,
    1,
    'El movimiento NO se eliminó (tu rol no permite borrar, o ya fue eliminado por otro usuario). Recarga el kardex.'
  )
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
  /** Proveedor del ingreso más reciente que forma este lote remanente.
   *  Fix Buscar Stock: antes se mostraba el proveedor del PRIMER movimiento
   *  (histórico, lote ya consumido) — p.ej. lámina termocontraible mostraba
   *  UNION PLAST cuando el material restante era de DAMAR. */
  proveedor?: string
}

// ═══ Helpers compartidos FEFO (Buscar Stock v3.4) ═══

/**
 * Mapa venc → proveedor del ingreso MÁS RECIENTE que aportó a ese lote.
 *
 * Las salidas NO registran proveedor, así que el proveedor real del material
 * que queda en un lote es el del ingreso que lo forma. Si un mismo venc
 * recibió ingresos de varios proveedores, gana el más reciente (asunción
 * FIFO dentro del lote, consistente con el desborde FEFO).
 */
export function proveedorPorVenc(
  entradas: Array<{ venc: string; proveedor?: string; ts: string }>
): Map<string, string> {
  const m = new Map<string, string>()
  const orden = [...entradas].sort((a, b) => a.ts.localeCompare(b.ts))
  for (const e of orden) {
    const prov = e.proveedor?.trim()
    if (prov) m.set(e.venc || '', prov)
  }
  return m
}

/** Comparador FEFO para fechas de vencimiento (strings YYYY-MM-DD o '').
 *  Con fecha antes que sin fecha; entre fechas, ascendente (vence primero).
 *  Único punto de verdad — usado por Stock, FEFO, Descarga y Piso. */
export function compararFEFO(a: string, b: string): number {
  if (a && b) return a.localeCompare(b)
  if (a && !b) return -1
  if (!a && b) return 1
  return 0
}

/** Comparador numérico de ubicación (bloque → torre → piso → posición).
 *  Tolerante a ceros a la izquierda ('02' == 2). */
export function compararUbicacionNum(
  a: { bloque: string; torre: string; piso: string; posicion: string },
  b: { bloque: string; torre: string; piso: string; posicion: string }
): number {
  const aB = parseInt(a.bloque, 10) || 0
  const bB = parseInt(b.bloque, 10) || 0
  if (aB !== bB) return aB - bB
  const aT = parseInt(a.torre, 10) || 0
  const bT = parseInt(b.torre, 10) || 0
  if (aT !== bT) return aT - bT
  const aP = parseInt(a.piso, 10) || 0
  const bP = parseInt(b.piso, 10) || 0
  if (aP !== bP) return aP - bP
  return (parseInt(a.posicion, 10) || 0) - (parseInt(b.posicion, 10) || 0)
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
        // FIX auditoría Task 20 (P1): tiebreaker — varios movimientos comparten
        // el mismo segundo de f_modificacion y sin desempate el paginado podía
        // repetir u omitir filas al cruzar 1,000 registros de una celda.
        .order('id', { ascending: true })
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
    // Ingresos con proveedor por key (para el proveedor REAL del lote remanente)
    const provInMap = new Map<string, Array<{ venc: string; proveedor?: string; ts: string }>>()
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
        // Registrar el proveedor del ingreso (el lote remanente hereda el del más reciente)
        if (m.proveedor) {
          const list = provInMap.get(key) ?? []
          list.push({ venc, proveedor: m.proveedor, ts: m.fModificacion })
          provInMap.set(key, list)
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
      // Proveedor REAL por lote: el del ingreso más reciente de ese venc.
      // Antes se usaba meta.proveedor (primer movimiento histórico — puede ser
      // de un lote YA CONSUMIDO de otro proveedor). Fallback: meta.proveedor.
      const provPorVenc = proveedorPorVenc(provInMap.get(key) ?? [])
      const lotesConFisico: LoteInfo[] = remanentes.map(l => {
        const codigos = porVenc?.get(l.venc)
        const fisicos = codigos && codigos.size > 0 ? Array.from(codigos).sort() : undefined
        const prov = provPorVenc.get(l.venc)
        const base = { fVencimiento: l.venc, cantidad: Math.round(l.cantidad * 1000) / 1000 }
        if (fisicos && prov) return { ...base, lotesFisicos: fisicos, proveedor: prov }
        if (fisicos) return { ...base, lotesFisicos: fisicos }
        if (prov) return { ...base, proveedor: prov }
        return base
      })
      const fefoFisicos = lotesConFisico[0]?.lotesFisicos
      const fefoVenc = remanentes.find(l => l.venc)?.venc || ''
      groups.set(key, {
        codigo: meta.codigo, descripcion: meta.descripcion, un: meta.un,
        stock: Math.round(stockTotal * 1000) / 1000,
        fVencimientoMasProxima: fefoVenc,
        usuarioPrimerNombre: meta.usuarioPrimerNombre,
        proveedor: provPorVenc.get(fefoVenc) ?? meta.proveedor, codigoInc: meta.codigoInc,
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
 *  Retorna un Map que puede estar marcado con `_error: true` si la consulta falló
 *  o `_truncated: true` si se alcanzó el tope de páginas (datos parciales). */
export async function fetchIncPorUbicacion(): Promise<Map<string, IncEnCelda[]> & { _error?: boolean; _truncated?: boolean }> {
  try {
    const allRows: Record<string, unknown>[] = []
    let from = 0
    const BATCH = 1000
    const MAX_PAGES = 50 // FIX auditoría 2026-10-21: 10 páginas (10K filas INC) truncaba el mapa sin aviso
    let truncated = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await dataClient
        .from('movimientos')
        .select('bloque, torre, piso, posicion, codigo, descripcion, un, codigo_inc, tipo, cantidad')
        .not('codigo_inc', 'is', null)
        .neq('codigo_inc', '')
        // FIX auditoría Task 20 (P1): orden determinista — sin .order() el
        // paginado INC (>1,000 filas) podía repetir/omitir filas entre páginas.
        .order('id', { ascending: true })
        .range(from, from + BATCH - 1)
      if (error) {
        console.error('[fetchIncPorUbicacion] Error en paginación INC:', error.message)
        const errMap = new Map<string, IncEnCelda[]>() as Map<string, IncEnCelda[]> & { _error?: boolean; _truncated?: boolean }
        errMap._error = true
        return errMap
      }
      const rows = data ?? []
      allRows.push(...rows)
      if (rows.length < BATCH) break
      from += BATCH
      if (page === MAX_PAGES - 1) truncated = true
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
      // Redondeo a 3 decimales (precisión de la BD) ANTES de acumular/filtrar:
      // sin esto, un residuo binario (ej. 1.4e-14) pasaba el filtro > 0 y mostraba
      // INC fantasma con stock 0 (misma clase de bug que calcularLotesRemanentes).
      const deltaR = Math.round(delta * 1000) / 1000
      const item = locMap.get(incKey)
      if (item) { item.stock = Math.round((item.stock + deltaR) * 1000) / 1000 } else {
        locMap.set(incKey, { codigo: code, descripcion: String(r.descripcion ?? ''), codigoInc: codeInc, stock: deltaR })
      }
    }
    const result = new Map<string, IncEnCelda[]>() as Map<string, IncEnCelda[]> & { _truncated?: boolean }
    for (const [key, locMap] of map) {
      const items: IncEnCelda[] = []
      for (const [, item] of locMap) {
        if (item.stock > 0) items.push({ codigo: item.codigo, descripcion: item.descripcion, codigoInc: item.codigoInc, cantidad: item.stock })
      }
      if (items.length > 0) result.set(key, items)
    }
    if (truncated) {
      console.warn('[fetchIncPorUbicacion] Tope de páginas alcanzado: el mapa INC puede estar incompleto')
      result._truncated = true
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
async function trasladarMovimientoFallback(
  t: TrasladoInput,
  refetch: boolean = true
): Promise<Movimiento[]> {
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
      // FIX auditoría 2026-10-21 (P2): el ajuste POSITIVO ingresa mercadería en
      // origen ANTES de la salida (misma operación), así que el disponible real
      // es stock + ajuste — igual que la RPC. Antes el panel "Ajuste positivo"
      // de la UI era inalcanzable (siempre INSUFFICIENT_STOCK).
      const disponible = stockRedondeado + Math.max(t.cantidadAjuste ?? 0, 0)
      if (t.cantidad > disponible + 0.001) {
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
  if (!refetch) return []
  try {
    return await fetchMovimientos()
  } catch (fetchErr) {
    console.warn('[trasladarMovimientoFallback] Insert exitoso pero fetchMovimientos() falló.', fetchErr)
    return []
  }
}

/**
 * Registra un traslado (RPC atómica registrar_traslado_kardex).
 *
 * opts.refetch (default true): re-descarga TODA la tabla movimientos al final
 * (contrato original). Con `refetch:false` retorna [] inmediatamente tras la
 * RPC — FIX auditoría 2026-10-22 (P2): un traslado multi-lote hacía N RPC ×
 * refetch completo (~30-40 s cada uno) con el formulario congelado. Los dos
 * callers (OcupacionTab.ejecutarTraslado y TrasladoTab) ya refrescan por su
 * cuenta al terminar.
 */
export async function trasladarMovimiento(
  t: TrasladoInput,
  opts?: { refetch?: boolean }
): Promise<Movimiento[]> {
  const refetch = opts?.refetch !== false
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
        return await trasladarMovimientoFallback(t, refetch)
      }
      // Origen = destino (server guard)
      if (msg.includes('SAME_ORIGIN_DESTINATION')) {
        const err = new Error('SAME_ORIGIN_DESTINATION')
        ;(err as unknown as Record<string, string>).detail = 'El destino no puede ser igual al origen'
        throw err
      }
      throw error
    }
    // RPC exitosa: el traslado ya quedó registrado en la DB.
    // Con refetch:false el caller refresca por su cuenta → retornar YA.
    if (!refetch) return []
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
      return await trasladarMovimientoFallback(t, refetch)
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

/**
 * Snapshot de los IDs actuales de movimientos (paginado, orden estable por id).
 * Lo usa la carga masiva de UP Data para borrar SOLO los registros antiguos
 * DESPUÉS de insertar los nuevos (antes era delete-all-then-insert: si el insert
 * fallaba a mitad, la tabla quedaba vacía o parcial e irrecuperable).
 */
export async function listarMovimientoIds(): Promise<string[]> {
  const ids: string[] = []
  let from = 0
  const BATCH = 1000
  for (let page = 0; page < 100; page++) {
    const { data, error } = await dataClient
      .from('movimientos')
      .select('id')
      .order('id')
      .range(from, from + BATCH - 1)
    if (error) throw error
    const rows = (data ?? []) as { id: string }[]
    ids.push(...rows.map((r) => r.id))
    if (rows.length < BATCH) break
    from += BATCH
  }
  return ids
}

/**
 * Elimina movimientos por IDs explícitos, por lotes de 500 (una URL con miles
 * de UUIDs excede límites del proxy). Devuelve el total eliminado y los errores
 * por lote: si un lote falla, el resto continúa y el llamador informa lo que faltó.
 */
export async function eliminarMovimientosPorIds(
  ids: string[]
): Promise<{ eliminados: number; errores: string[] }> {
  const errores: string[] = []
  let eliminados = 0
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    // HONESTIDAD (auditoría 2026-10-31): se cuentan SOLO las filas que la
    // BD borró DE VERDAD (.select('id')) — antes se sumaba Math.min(CHUNK,
    // restante) aunque la RLS filtrara el lote completo: contador falso.
    const lote = ids.slice(i, i + CHUNK)
    const { data: borradas, error } = await dataClient
      .from('movimientos')
      .delete()
      .in('id', lote)
      .select('id')
    if (error) errores.push(`Lote ${Math.floor(i / CHUNK) + 1}: ${error.message}`)
    else eliminados += (borradas ?? []).length
  }
  return { eliminados, errores }
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
 * Carga masiva de ingresos desde el Excel de Descarga.
 * FIX auditoría 2026-10-21 (f9a5bae): usa dataClient (anon + JWT de sesión;
 * RLS aplica) — la service_role NUNCA entra al bundle.
 * Batch inserts de 1000 filas para no exceder límites de Supabase.
 */
export async function addMovimientosBatch(
  rows: UploadStockRow[],
  usuarioId: string,
  usuarioNombre?: string,
  usuarioCorreo?: string,
): Promise<{ inserted: number; errors: string[] }> {
  // dataClient (anon + JWT de sesión) — ya configurado, sin credenciales hardcodeadas
  const admin = dataClient

  const turno = (await import('./turno')).calcularTurno()
  const errors: string[] = []
  let inserted = 0
  const BATCH_SIZE = 1000

  // FIX auditoría Task 20 (K1): defensa en profundidad anti-fechas absurdas.
  // Esta vía de INSERT directo no pasa por registrar_movimiento_kardex (que
  // valida año 2000-2100 en BD desde v8); sin este guard un Excel con
  // "3027-12-30" o serial ~2119 corrompía el orden FEFO de forma persistente.
  const fechaVencValida = (f?: string): boolean => {
    if (!f) return true // sin vencimiento es válido (lote sin fecha)
    const m = /^(\d{4})-\d{2}-\d{2}/.exec(f)
    if (!m) return false // formato no ISO no debería llegar aquí
    const y = Number(m[1])
    return y >= 2000 && y <= 2100
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const inserts: Record<string, unknown>[] = []
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j]
      if (!fechaVencValida(r.fVencimiento)) {
        errors.push(
          `Fila ${i + j + 1} (código ${r.codigo}): vencimiento "${r.fVencimiento}" fuera del rango 2000-2100 — fila descartada`,
        )
        continue
      }
      inserts.push({
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
      })
    }

    if (inserts.length === 0) continue

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
      inserted += inserts.length
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

  // FIX auditoría 2026-10-21 (P3): la BD puede tener formatos mixtos ('01' vs
  // '1', igual que documenta calcularStockUbicacion) — con eq() crudo esas
  // filas NO matcheaban y el admin veía "Ubicación eliminada" con el stock
  // intacto (éxito falso). Se recolectan los IDs de TODAS las variantes de
  // torre/piso/posicion (con y sin cero a la izquierda) y se borra por IDs;
  // si no se borra ninguna, se lanza error en vez de fingir éxito.
  const variantes = (v: string): string[] => {
    const t = String(v ?? '')
    const sinCero = t.replace(/^0+(?=\d)/, '')
    return t === sinCero ? [t] : [t, sinCero]
  }
  const ids: string[] = []
  for (const t of variantes(torre)) {
    for (const p of variantes(piso)) {
      for (const pos of variantes(posicion)) {
        let query = dataClient
          .from('movimientos')
          .select('id')
          .eq('codigo', target)
          .eq('bloque', bloque)
          .eq('torre', t)
          .eq('piso', p)
          .eq('posicion', pos)
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
        const { data, error } = await query
        if (error) throw error
        for (const r of (data ?? []) as { id: string }[]) {
          if (!ids.includes(r.id)) ids.push(r.id)
        }
      }
    }
  }
  if (ids.length === 0) {
    throw new Error(
      'No se encontraron movimientos para eliminar en esta ubicación (verifique que el stock exista y no haya sido movido por otro usuario).'
    )
  }
  // Borrar por IDs en chunks de 500 — HONESTIDAD (auditoría 2026-10-31):
  // se verifica el efecto REAL; si la RLS filtra (0 borradas sin error) el
  // usuario lo sabe AHORA, no con un «stock eliminado» que reaparece.
  let borradasTotal = 0
  for (let i = 0; i < ids.length; i += 500) {
    const { data: borradas, error } = await dataClient
      .from('movimientos')
      .delete()
      .in('id', ids.slice(i, i + 500))
      .select('id')
    if (error) throw error
    borradasTotal += (borradas ?? []).length
  }
  if (borradasTotal < ids.length) {
    throw errorControlado(
      ERR_ELIMINAR_BLOQUEADO,
      `La eliminación NO se completó: se borraron ${borradasTotal} de ${ids.length} movimiento(s) (tu rol no permite borrarlos). Recarga el kardex.`
    )
  }
  return fetchMovimientos()
}

// ═══════════════════════════════════════════════════════════════════
// EDITAR LOTE / F. VENCIMIENTO de artículos (2026-10-20, v2)
// v1: completar datos de artículos SIN lote/fechas.
// v2: también CORREGIR artículos que ya tienen lote/fechas — se apunta al
// bucket EXACTO (lote_actual + f_vencimiento_actual); los parámetros son
// opcionales con default "bucket vacío" para retrocompatibilidad total.
// ═══════════════════════════════════════════════════════════════════

export type EdicionLoteResultado = {
  filasActualizadas: number
  lote: string | null
  fVencimiento: string | null
}

/**
 * Guarda lote y/o fecha de vencimiento de UN bucket de un artículo en una
 * ubicación de Racks. La RPC (SECURITY DEFINER) solo toca las filas cuyo
 * (lote, f_vencimiento) coincide con el bucket ACTUAL indicado — entradas
 * y salidas históricas del bucket — con advisory lock idéntico al del
 * registro de movimientos: el saldo se conserva exacto (mismo conjunto de
 * filas, mismas cantidades — solo cambia la etiqueta).
 *
 *  · `loteActual`/`fVencimientoActual` vacíos/ausentes → bucket "sin lote
 *    y sin fecha" (flujo original v1 de completar datos faltantes).
 *  · Con valores → corrección v2 (p.ej. lote mal digitado en el ingreso).
 *
 * Errores controlados que propaga (mensaje "CÓDIGO|detalle"):
 *   · SIN_DATOS — no llegó ni lote ni fecha (o código vacío).
 *   · SIN_FILAS — no hay filas de ese bucket exacto allí (ya corregido, o
 *     la ubicación/código/lote actual no coincide).
 */
export async function editarLoteVencimientoRacks(params: {
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  lote?: string
  fVencimiento?: string
  /** Lote físico ACTUAL del bucket a editar ('' = sin lote). */
  loteActual?: string
  /** Fecha de vencimiento ACTUAL del bucket a editar ('' = sin fecha). */
  fVencimientoActual?: string
}): Promise<EdicionLoteResultado> {
  const { data, error } = await dataClient.rpc('editar_lote_vencimiento_racks', {
    p_bloque: params.bloque,
    p_torre: params.torre,
    p_piso: params.piso,
    p_posicion: params.posicion,
    p_codigo: params.codigo.trim().toUpperCase(),
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
