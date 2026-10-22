'use client'

import { useEffect, useRef } from 'react'
import { dataClient, supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

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
 */
const CHANNEL_NAME = 'movs-realtime-sync'

// ── Estado singleton a nivel de módulo ──
let listeners = new Set<(movs: Movimiento[]) => void>()
let pollInterval: ReturnType<typeof setInterval> | null = null
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null
let isRefreshing = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let refreshPendiente = false

function broadcast(movs: Movimiento[]) {
  for (const fn of listeners) {
    try { fn(movs) } catch { /* ignore render errors */ }
  }
}

function refreshAndBroadcast() {
  if (isRefreshing) {
    // Hay un fetch en vuelo (que pudo leer la BD ANTES del write que disparó
    // este evento): encolar una pasada extra en lugar de descartar el evento
    refreshPendiente = true
    return
  }
  if (listeners.size === 0) return
  isRefreshing = true
  fetchMovimientos()
    .then((movs) => {
      isRefreshing = false
      broadcast(movs)
      if (refreshPendiente) {
        refreshPendiente = false
        setTimeout(refreshAndBroadcast, 50)
      }
    })
    .catch((err) => {
      isRefreshing = false
      refreshPendiente = false
      console.warn('[Realtime] Error al refrescar movimientos:', err)
    })
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

async function pollCheck() {
  if (listeners.size === 0) return
  const head = await leerHead()
  if (!head) return
  if (head.count === headSnapshot.count && head.last === headSnapshot.last) return
  headSnapshot = head
  refreshAndBroadcast()
}

function startSharedPolling() {
  if (pollInterval) return // Ya corriendo

  // Fetch inmediato al iniciar
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
          debounceTimer = setTimeout(refreshAndBroadcast, 150)
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
  onChange: (movs: Movimiento[]) => void
) {
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const isFirstListener = listeners.size === 0

    // Envolver en ref para evitar stale closure en delete
    const listenerFn = (movs: Movimiento[]) => {
      onChangeRef.current(movs)
    }
    listeners.add(listenerFn)

    if (isFirstListener) {
      startSharedPolling()
      startSharedRealtime()
    }

    return () => {
      listeners.delete(listenerFn)

      // Último listener: detener todo
      if (listeners.size === 0) {
        stopSharedPolling()
        stopSharedRealtime()
      }
    }
  }, [])
}
