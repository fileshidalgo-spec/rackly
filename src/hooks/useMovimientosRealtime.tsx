'use client'

import { useEffect, useRef } from 'react'
import { dataClient, supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
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
      broadcast(movs)
      broadcastEstado('listo')
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

async function pollCheck() {
  if (listeners.size === 0) return
  const head = await leerHead()
  if (!head) return
  if (head.count === headSnapshot.count && head.last === headSnapshot.last) return
  headSnapshot = head
  // La head SÍ cambió (verificado barato): forzar aunque esté dentro del TTL
  refreshAndBroadcast({ fuerza: true })
}

function startSharedPolling() {
  if (pollInterval) return // Ya corriendo

  // Carga inicial: si hay caché de sesión, difundirla AL INSTANTE (pestañas
  // con datos reales en 0 ms) y dejar que el refresco de fondo la actualice;
  // el TTL evita re-descargar si el caché es reciente (flapping de pestañas).
  if (cacheMovs) {
    broadcast(cacheMovs)
    broadcastEstado('listo')
  }
  refreshAndBroadcast()

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
        () => {
          // Debounce REAL: reinicia el timer (antes cada evento en ráfaga creaba
          // su propio setTimeout sin cancelar el anterior)
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => refreshAndBroadcast({ fuerza: true }), 150)
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
