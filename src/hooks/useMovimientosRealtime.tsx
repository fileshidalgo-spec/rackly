'use client'

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'

/**
 * Hook que mantiene la lista de movimientos sincronizada.
 * Usa Supabase Realtime como mecanismo principal y polling cada 8s como respaldo.
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

function broadcast(movs: Movimiento[]) {
  for (const fn of listeners) {
    try { fn(movs) } catch { /* ignore render errors */ }
  }
}

function refreshAndBroadcast() {
  if (isRefreshing || listeners.size === 0) return
  isRefreshing = true
  fetchMovimientos()
    .then((movs) => {
      isRefreshing = false
      broadcast(movs)
    })
    .catch((err) => {
      isRefreshing = false
      console.warn('[Realtime] Error al refrescar movimientos:', err)
    })
}

function startSharedPolling() {
  if (pollInterval) return // Ya corriendo

  // Fetch inmediato al iniciar
  refreshAndBroadcast()

  // Polling cada 8 segundos
  pollInterval = setInterval(refreshAndBroadcast, 8000)
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
    realtimeChannel = supabase
      .channel(CHANNEL_NAME)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'movimientos' },
        () => {
          // Debounce: esperar 150ms antes de refrescar para evitar múltiples refrescos rápidos
          setTimeout(refreshAndBroadcast, 150)
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
    try { supabase.removeChannel(realtimeChannel) } catch { /* ignore */ }
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
