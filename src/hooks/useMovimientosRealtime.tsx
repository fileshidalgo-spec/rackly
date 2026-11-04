'use client'

import { useEffect, useRef } from 'react'
import { dataClient, supabase } from '@/lib/supabase/client'
import {
  fetchMovimientos,
  fetchMovimientosDesde,
  movimientoDesdeFila,
  type Movimiento,
} from '@/lib/rackly/kardex'
import {
  fusionarDeltas,
  eliminarPorIds,
  marcaAgua as marcaAguaDe,
  resumenDelta,
} from '@/lib/rackly/movs-sync'
import { guardarCacheMovs, leerCacheMovs } from '@/lib/rackly/movs-cache'
import { registrarRefrescadorMovs } from '@/lib/rackly/kardex'
import { POLLING_INTERVAL, MOV_FETCH_TTL_MS } from '@/lib/rackly/constants'

/**
 * Hook que mantiene la lista de movimientos sincronizada.
 * Usa Supabase Realtime como mecanismo principal y polling cada 8s como respaldo.
 * El canal usa dataClient (service_role): sigue recibiendo eventos con RLS
 * restringido a authenticated y sin exponer cambios al cliente público anon.
 *
 * SINGLETON COMPARTIDO: Todas las instancias del hook comparten el MISMO polling
 * interval y la MISMA suscripción Realtime. Solo se inicia el polling/realtime cuando
 * el primer componente se monta, y se detiene cuando el último se desmonta.
 *
 * Esto previene:
 * - Múltiples polling intervals (antes: 5 tablas × 8s = 5 fetches simultáneos)
 * - Race conditions en el moduleChannel (antes: cada mount destruía el channel del anterior)
 * - Datos stale entre pestañas
 *
 * ── FIX Task 24 (pestañas que "no muestran datos") ─────────────────────────
 * Tres defectos del singleton provocaban que FEFO / Traslado / Stock /
 * Movimientos / Descarga parecieran rotas:
 *
 * 1. SIN CACHÉ PARA LISTENERS TARDÍOS: el dataset solo se broadcasteaba a los
 *    listeners registrados en el momento en que llegaba. Una pestaña montada
 *    DESPUÉS de la descarga inicial (p. ej. cambiar FEFO → Traslado) arrancaba
 *    con movs=[] y no recibía NADA hasta la próxima escritura en BD
 *    (polling-diff y realtime solo reaccionan a writes). Se agregó caché
 *    módulo-nivel (`cacheMovs`) con REPLAY inmediato a cada nuevo listener.
 *
 * 2. RE-DESCARGA COMPLETA AL FLAPEAR: al quedarse sin listeners (usuario en
 *    Catálogo/Ocupación/Usuarios) el singleton se apagaba; al volver, la
 *    primera pestaña con el hook re-descargaba TODA la tabla (25K+ filas).
 *    Ahora el caché se difunde al instante y la re-descarga de fondo respeta
 *    un TTL (MOV_FETCH_TTL_MS); el polling/realtime siempre pueden forzar.
 *
 * 3. SIN FEEDBACK DE CARGA: las pestañas mostraban estados de vacío reales
 *    ("Sin lotes FEFO", "0 ubicaciones") mientras el dataset cargaba. El hook
 *    ahora expone un ESTADO ('cargando' | 'listo' | 'error') vía segundo
 *    callback opcional + reintentarMovimientos() para el botón de reintento.
 *    Las pestañas optan-in: la firma antigua useMovimientosRealtime(onChange)
 *    sigue funcionando sin cambios.
 */
const CHANNEL_NAME = 'movs-realtime-sync'

/** Estado de sincronización del dataset compartido. */
export type EstadoMovs = 'cargando' | 'listo' | 'error'

// ── Estado singleton a nivel de módulo ──
let listeners = new Set<(movs: Movimiento[]) => void>()
let estadoListeners = new Set<(e: EstadoMovs) => void>()
let pollInterval: ReturnType<typeof setInterval> | null = null
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null
let isRefreshing = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let refreshPendiente = false

/** Último dataset completo conocido (caché de sesión, sobrevive a desmontes). */
let cacheMovs: Movimiento[] | null = null
/** Estado actual visible para las pestañas. */
let estadoActual: EstadoMovs = 'cargando'
/** Fecha (Date.now()) del último fetch completo exitoso — base del TTL. */
let ultimoFetchOk = 0
/** ── Rendimiento 2026-11-04 ── Marca de agua del caché (máximo
 * f_modificacion): corte del fetch incremental. Con 28K+ filas (~14.5 MB)
 * la re-descarga COMPLETA en cada cambio ya no es viable — se sincroniza por
 * DELTA: realtime aplica el payload directo y el polling baja solo las filas
 * con f_modificacion > marca de agua. La descarga completa queda como camino
 * de reparación (borrados sin realtime, conteo que no cuadra, sin caché). */
let marcaAguaCache: string | null = null
/** Cola de eventos realtime coalescidos por el debounce (150 ms). */
let colaInserts: Record<string, unknown>[] = []
let colaBorrados: string[] = []

/** ── Rendimiento 2026-11-05 ── Guardado en IndexedDB del caché (debounce
 * 2 s coalesce ráfagas de deltas; cada guardado escribe ~15 MB clonados en
 * hilo de fondo — sin jank visible). El arranque caliente (F5/recarga)
 * siembra desde aquí y valida por delta en segundos. */
const GUARDADO_IDB_DEBOUNCE_MS = 2000
let guardadoTimer: ReturnType<typeof setTimeout> | null = null

function programarGuardadoIdb(): void {
  if (!cacheMovs) return
  if (guardadoTimer) clearTimeout(guardadoTimer)
  guardadoTimer = setTimeout(() => {
    guardadoTimer = null
    if (!cacheMovs) return
    void guardarCacheMovs(cacheMovs, marcaAguaCache)
  }, GUARDADO_IDB_DEBOUNCE_MS)
}

// Flush best-effort al cerrar/minimizar: reduce a ~0 la ventana de deltas sin
// guardar. Si el navegador no completa la escritura, la validación por conteo
// del arranque caliente repara igual.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (guardadoTimer) {
      clearTimeout(guardadoTimer)
      guardadoTimer = null
    }
    if (cacheMovs) void guardarCacheMovs(cacheMovs, marcaAguaCache)
  })
}

/** Aplica deltas (INSERT/UPDATE) al caché y difunde. false si no hay caché. */
function aplicarDeltas(deltas: Movimiento[]): boolean {
  if (!cacheMovs) return false
  if (deltas.length > 0) {
    const resumen = resumenDelta(cacheMovs, deltas)
    cacheMovs = fusionarDeltas(cacheMovs, deltas)
    marcaAguaCache = marcaAguaDe(cacheMovs)
    ultimoFetchOk = Date.now()
    broadcast(cacheMovs)
    broadcastEstado('listo')
    programarGuardadoIdb()
    console.info(
      `[Realtime] Delta aplicado: +${resumen.nuevos} nuevos (${resumen.antes} → ${resumen.despues} filas)`
    )
  }
  return true
}

/** Aplica eliminaciones (DELETE realtime) y difunde. false si no hay caché. */
function aplicarEliminaciones(ids: string[]): boolean {
  if (!cacheMovs) return false
  if (ids.length > 0) {
    cacheMovs = eliminarPorIds(cacheMovs, ids)
    marcaAguaCache = marcaAguaDe(cacheMovs)
    broadcast(cacheMovs)
    broadcastEstado('listo')
    programarGuardadoIdb()
  }
  return true
}

/** Auto-verificación tras aplicar deltas: el conteo local debe coincidir con
 * la BD (RLS SELECT = true ⇒ longitudes comparables). Si no cuadra algo se
 * perdió (WS reconectado, delta truncado) → descarga completa que repara. */
async function verificarYAutoReparar(): Promise<void> {
  const head = await leerHead()
  if (!head) return
  if (head.count === (cacheMovs?.length ?? -1)) {
    headSnapshot = head
    return
  }
  console.warn(
    `[Realtime] Conteo local ${cacheMovs?.length} ≠ BD ${head.count} tras delta — descarga completa de reparación`
  )
  headSnapshot = head // evita re-detección infinita del poll mientras repara
  refreshAndBroadcast({ fuerza: true })
}

/** Flush del debounce realtime: aplica INSERT/UPDATE como delta y DELETE como
 * baja por id — SIN re-descargar la tabla. Sin caché, cae a la descarga
 * completa (una sola vez) como antes. */
function procesarColaRealtime(): void {
  const nuevos = colaInserts
  const borrados = colaBorrados
  colaInserts = []
  colaBorrados = []
  if (nuevos.length === 0 && borrados.length === 0) return
  if (!cacheMovs) {
    refreshAndBroadcast({ fuerza: true })
    return
  }
  let hayCache = true
  if (nuevos.length > 0) hayCache = aplicarDeltas(nuevos.map(movimientoDesdeFila)) && hayCache
  if (borrados.length > 0) hayCache = aplicarEliminaciones(borrados) && hayCache
  if (hayCache) void verificarYAutoReparar()
  else refreshAndBroadcast({ fuerza: true })
}

function broadcast(movs: Movimiento[]) {
  for (const fn of listeners) {
    try { fn(movs) } catch { /* ignore render errors */ }
  }
}

function broadcastEstado(e: EstadoMovs) {
  estadoActual = e
  for (const fn of estadoListeners) {
    try { fn(e) } catch { /* ignore render errors */ }
  }
}

// ── FIX auditoría 2026-10-22 (P2): el polling de respaldo descargaba TODA la
// tabla movimientos (~25K filas, 30-40 s) cada 8 s aunque no hubiera cambios,
// para CADA usuario con Racks abierto. Ahora el tic compara una lectura barata
// (count exacto + última f_modificacion, 0 filas de payload) y solo descarga
// todo cuando la BD realmente cambió. El canal realtime sigue refrescando al
// instante por eventos; esto es solo el respaldo sin WS.
let headSnapshot = { count: -1, last: '' }

async function leerHead(): Promise<{ count: number; last: string } | null> {
  try {
    const cnt = await dataClient
      .from('movimientos')
      .select('id', { count: 'exact', head: true })
    if (cnt.error) return null
    const ult = await dataClient
      .from('movimientos')
      .select('f_modificacion')
      .order('f_modificacion', { ascending: false })
      .limit(1)
    if (ult.error) return null
    return {
      count: cnt.count ?? -1,
      last: (ult.data?.[0]?.f_modificacion as string) ?? '',
    }
  } catch {
    return null // red caída: no tocar el snapshot ni disparar refetch
  }
}

function refreshAndBroadcast(opciones: { fuerza?: boolean } = {}) {
  if (isRefreshing) {
    // Hay un fetch en vuelo (que pudo leer la BD ANTES del write que disparó
    // este evento): encolar una pasada extra en lugar de descartar el evento
    refreshPendiente = true
    return
  }
  if (listeners.size === 0) return
  // TTL anti-re-descarga: SOLO aplica al fetch "de cortesía" al montar la
  // primera pestaña con caché reciente. pollCheck y realtime pasan fuerza:true
  // porque ya VERIFICARON que la BD cambió.
  if (!opciones.fuerza && cacheMovs && Date.now() - ultimoFetchOk < MOV_FETCH_TTL_MS) return
  isRefreshing = true
  if (!cacheMovs) broadcastEstado('cargando')
  fetchMovimientos()
    .then((movs) => {
      isRefreshing = false
      ultimoFetchOk = Date.now()
      cacheMovs = movs
      marcaAguaCache = marcaAguaDe(movs)
      broadcast(movs)
      broadcastEstado('listo')
      programarGuardadoIdb()
      // Sincronizar el snapshot del poll con la BD recién leída: evita que el
      // primer tic del polling re-descargue todo solo porque head ≠ snapshot(-1).
      void leerHead().then((h) => { if (h) headSnapshot = h })
      if (refreshPendiente) {
        refreshPendiente = false
        setTimeout(() => refreshAndBroadcast({ fuerza: true }), 50)
      }
    })
    .catch((err) => {
      isRefreshing = false
      refreshPendiente = false
      console.warn('[Realtime] Error al refrescar movimientos:', err)
      if (!cacheMovs) broadcastEstado('error') // sin caché no hay nada que mostrar
    })
}

/** Reintento manual para las pestañas (botón cuando estado === 'error'). */
export function reintentarMovimientos() {
  refreshAndBroadcast({ fuerza: true })
}

/** ── Rendimiento 2026-11-05 ── Refresco INCREMENTAL canónico tras una
 * escritura. Las funciones de escritura de kardex (addMovimiento,
 * trasladarMovimiento, deleteMovimiento, …) devuelven el dataset actualizado
 * — antes re-descargaban la TABLA COMPLETA (28K filas ≈ 14.5 MB ≈ 21 s en
 * red real) tras CADA operación; ahora este refresco fusiona sobre el caché
 * del singleton (a) las bajas conocidas (`bajas` — el delta por
 * f_modificacion no puede ver DELETE) y (b) el delta por marca de agua
 * (filas nuevas/actualizadas de esta y otras sesiones, ~1 s). El resultado
 * se difunde a todas las pestañas y se retorna. Sin caché (o delta fallido)
 * → descarga completa: comportamiento previo intacto. */
export async function refrescarMovimientosIncremental(bajas?: string[]): Promise<Movimiento[]> {
  if (!cacheMovs) return fetchMovimientos()
  let base = bajas && bajas.length > 0 ? eliminarPorIds(cacheMovs, bajas) : cacheMovs
  try {
    const desde = marcaAguaDe(base)
    if (desde) base = fusionarDeltas(base, await fetchMovimientosDesde(desde))
  } catch (err) {
    console.warn('[Realtime] Delta del refresco post-escritura falló — descarga completa:', err)
    const completa = await fetchMovimientos()
    cacheMovs = completa
    marcaAguaCache = marcaAguaDe(completa)
    ultimoFetchOk = Date.now()
    broadcast(completa)
    programarGuardadoIdb()
    return completa
  }
  cacheMovs = base
  marcaAguaCache = marcaAguaDe(base)
  ultimoFetchOk = Date.now()
  broadcast(base)
  programarGuardadoIdb()
  return base
}

// Inyección: todas las escrituras de kardex pasan a refrescarse por delta.
// Sin el hook cargado (tests/SSR) kardex mantiene su descarga completa.
registrarRefrescadorMovs(refrescarMovimientosIncremental)

/** ── Rendimiento 2026-11-05 ── ARRANQUE CALIENTE: sembrar el caché desde
 * IndexedDB (guardado por el cierre de la sesión anterior) y mostrar datos
 * AL INSTANTE, validando contra la BD en segundo plano por delta. Convierte
 * la recarga de página (F5/cierre de navegador) de «21 s esperando» a
 * «datos en ~0 s + actualización en ~1-2 s». */
async function arranqueCaliente(): Promise<void> {
  const c = await leerCacheMovs()
  if (cacheMovs) return // una descarga completa (poll/realtime) ganó la carrera
  if (!c) {
    refreshAndBroadcast({ fuerza: true }) // sin caché persistido: camino frío de siempre
    return
  }
  cacheMovs = c.movs as Movimiento[]
  marcaAguaCache = c.marcaAgua ?? marcaAguaDe(cacheMovs)
  // ultimoFetchOk fresco: el refresco de cortesía con TTL NO re-descarga la
  // tabla; la validación por delta de abajo es la que actualiza.
  ultimoFetchOk = Date.now()
  broadcast(cacheMovs)
  broadcastEstado('listo')
  console.info(
    `[Realtime] Arranque caliente: ${cacheMovs.length} movimientos del caché persistido — validando contra BD`
  )
  void validarArranqueCaliente()
}

/** Validación en segundo plano del caché sembrado: conteo vs BD (borrados sin
 * realtime) + delta por marca de agua (altas/cambios mientras la app estuvo
 * cerrada). Cualquier descuadre degrada a descarga completa que repara. */
async function validarArranqueCaliente(): Promise<void> {
  try {
    const head = await leerHead()
    if (!head) return // red caída: el polling de 8 s tomará el relevo
    if (head.count !== (cacheMovs?.length ?? -1)) {
      console.warn(
        `[Realtime] Caché persistido ${cacheMovs?.length} ≠ BD ${head.count} — descarga de reparación`
      )
      headSnapshot = head
      refreshAndBroadcast({ fuerza: true })
      return
    }
    headSnapshot = head
    if (marcaAguaCache) {
      const deltas = await fetchMovimientosDesde(marcaAguaCache)
      aplicarDeltas(deltas)
      const h2 = await leerHead()
      if (h2 && h2.count !== (cacheMovs?.length ?? -1)) refreshAndBroadcast({ fuerza: true })
      else if (h2) headSnapshot = h2
    }
  } catch (err) {
    console.warn('[Realtime] Validación del arranque caliente falló — el polling tomará el relevo:', err)
  }
}

async function pollCheck() {
  if (listeners.size === 0) return
  const head = await leerHead()
  if (!head) return
  if (head.count === headSnapshot.count && head.last === headSnapshot.last) return
  // ── Rendimiento 2026-11-04: camino RÁPIDO por DELTA ──
  // Si hay caché, no se detectaron borrados (el count no bajó) y tenemos
  // marca de agua, basta con bajar las filas nuevas/actualizadas (0-2
  // páginas pequeñas) en lugar de la tabla completa (14.5 MB / ~21 s).
  if (cacheMovs && head.count >= headSnapshot.count && marcaAguaCache) {
    try {
      const deltas = await fetchMovimientosDesde(marcaAguaCache)
      aplicarDeltas(deltas)
      const h2 = await leerHead()
      if (h2 && h2.count === (cacheMovs?.length ?? -1)) {
        headSnapshot = h2 // delta verificado contra BD
        return
      }
      // El conteo no cuadra (borrados sin realtime o delta truncado) → cae a
      // la descarga completa de abajo, que auto-repara.
    } catch (err) {
      console.warn('[Realtime] Delta incremental falló, cayendo a descarga completa:', err)
    }
  }
  // La head SÍ cambió (verificado barato): forzar aunque esté dentro del TTL.
  // FIX auditoría 2026-10-29: el snapshot NO se avanza aquí — solo cuando el
  // refetch tiene ÉXITO (sincronización en refreshAndBroadcast). Si se avanza
  // antes y el refetch falla (blip de red con WebSocket caído), el próximo tic
  // ve head === snapshot y el cambio queda congelado sin datos frescos ni
  // reintentos; ahora cada tic re-detecta y reintenta hasta lograrlo.
  refreshAndBroadcast({ fuerza: true })
}

function startSharedPolling() {
  if (pollInterval) return // Ya corriendo

  // Carga inicial: si hay caché de sesión (memoria), difundirla AL INSTANTE
  // (pestañas con datos reales en 0 ms) y dejar que el refresco de fondo la
  // actualice; el TTL evita re-descargar si el caché es reciente (flapping).
  if (cacheMovs) {
    broadcast(cacheMovs)
    broadcastEstado('listo')
    refreshAndBroadcast()
  } else {
    // ── Rendimiento 2026-11-05: ARRANQUE CALIENTE ── intenta sembrar desde
    // IndexedDB (datos en ~0 s tras un F5/recarga) y valida por delta en
    // segundo plano; sin caché persistido cae a la descarga completa de siempre.
    broadcastEstado('cargando')
    void arranqueCaliente()
  }

  // Polling barato: compara count + última f_modificacion y solo descarga
  // la tabla completa cuando detecta cambios (interval centralizado en constants)
  pollInterval = setInterval(pollCheck, POLLING_INTERVAL)
}

function stopSharedPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

function startSharedRealtime() {
  if (realtimeChannel) return // Ya suscrito

  try {
    realtimeChannel = dataClient
      .channel(CHANNEL_NAME)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'movimientos' },
        (payload) => {
          // ── Rendimiento 2026-11-04: DELTA directo desde el payload ──
          // Antes cada evento disparaba la re-descarga COMPLETA de la tabla
          // (14.5 MB / ~21 s) para TODOS los usuarios conectados. Ahora el
          // INSERT/UPDATE llega con la fila completa (replica identity default)
          // y DELETE con la PK — se coalescen en el debounce y se aplican como
          // delta sobre el caché. verificarYAutoReparar() compara el conteo
          // contra la BD y degradar a descarga completa si algo no cuadra.
          if (payload.eventType === 'DELETE') {
            const id = (payload.old as { id?: string } | null)?.id
            if (id) colaBorrados.push(id)
          } else if (payload.new) {
            colaInserts.push(payload.new as Record<string, unknown>)
          }
          // Debounce REAL: reinicia el timer (antes cada evento en ráfaga creaba
          // su propio setTimeout sin cancelar el anterior)
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(procesarColaRealtime, 150)
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Realtime] Error de canal, reconectando...', err)
        }
      })
  } catch (err) {
    console.warn('[Realtime] No se pudo configurar canal, usando polling:', err)
  }
}

function stopSharedRealtime() {
  if (realtimeChannel) {
    try { dataClient.removeChannel(realtimeChannel) } catch { /* ignore */ }
    realtimeChannel = null
  }
}

// ── Hook ──
export function useMovimientosRealtime(
  onChange: (movs: Movimiento[]) => void,
  onEstado?: (e: EstadoMovs) => void
) {
  const onChangeRef = useRef(onChange)
  const onEstadoRef = useRef(onEstado)

  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    onEstadoRef.current = onEstado
  })

  useEffect(() => {
    const isFirstListener = listeners.size === 0

    // Envolver en ref para evitar stale closure en delete
    const listenerFn = (movs: Movimiento[]) => {
      onChangeRef.current(movs)
    }
    listeners.add(listenerFn)

    // Estado (opt-in): suscribir y REPLAY del estado actual sin esperar tic
    let estadoFn: ((e: EstadoMovs) => void) | null = null
    if (onEstadoRef.current) {
      estadoFn = (e) => onEstadoRef.current?.(e)
      estadoListeners.add(estadoFn)
      onEstadoRef.current(estadoActual)
    }

    // REPLAY inmediato del caché de sesión: la pestaña arranca con datos reales
    // en vez de movs=[] hasta la próxima escritura en BD (causa raíz del reporte
    // "FEFO no muestra datos" / "Traslado no da información").
    if (cacheMovs) {
      try { onChangeRef.current(cacheMovs) } catch { /* ignore render errors */ }
    }

    if (isFirstListener) {
      startSharedPolling()
      startSharedRealtime()
    }

    return () => {
      listeners.delete(listenerFn)
      if (estadoFn) estadoListeners.delete(estadoFn)

      // Último listener: detener polling/realtime (el caché de sesión persiste
      // módulo-nivel para el próximo montaje)
      if (listeners.size === 0) {
        stopSharedPolling()
        stopSharedRealtime()
      }
    }
  }, [])
}
