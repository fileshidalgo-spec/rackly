'use client'

import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

/**
 * Hook que mantiene sincronizadas las pestañas de Piso.
 * Escucha cambios en las tablas piso_movimientos y piso_movimiento_detalles
 * mediante Supabase Realtime, con polling SOLO como respaldo cuando el
 * WebSocket NO está conectado.
 *
 * Comportamiento:
 * - Al montar: carga inicial (refresh) + intenta conectar WebSocket
 * - Si WebSocket se conecta: DETIENE el polling
 * - Si WebSocket falla/timeout: REANUDA el polling como respaldo
 * - Al desmontar: limpia intervalo y canal
 */
const CHANNEL_NAME = 'piso-realtime-sync'

// Referencia a nivel de módulo para limpiar el canal correctamente entre remounts
let moduleChannel: ReturnType<typeof supabase.channel> | null = null

export function usePisoRealtime(onChange: () => void) {
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  })

  // Memoized refresh to avoid recreating on every render
  const refresh = useCallback(() => {
    if (onChangeRef.current) onChangeRef.current()
  }, [])

  useEffect(() => {
    let active = true
    let wsConnected = false

    // Polling como respaldo — solo corre cuando WebSocket NO está conectado
    refresh() // Carga inicial

    let pollInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (active && !wsConnected) refresh()
    }, POLLING_INTERVAL)

    // Función para iniciar polling (respaldo)
    const startPolling = () => {
      if (!pollInterval && active) {
        pollInterval = setInterval(() => {
          if (active && !wsConnected) refresh()
        }, POLLING_INTERVAL)
      }
    }

    // Función para detener polling (WebSocket activo)
    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
    }

    // Limpiar canal previo (React Strict Mode / remount)
    if (moduleChannel) {
      try { supabase.removeChannel(moduleChannel) } catch { /* ignore */ }
      moduleChannel = null
    }

    // Realtime: escucha cambios en piso_movimientos y piso_movimiento_detalles
    try {
      moduleChannel = supabase
        .channel(CHANNEL_NAME)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimientos' },
          () => {
            setTimeout(() => { if (active) refresh() }, 500)
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimiento_detalles' },
          () => {
            setTimeout(() => { if (active) refresh() }, 500)
          }
        )
        .subscribe((status, err) => {
          if (!active) return

          if (status === 'SUBSCRIBED') {
            wsConnected = true
            stopPolling()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            wsConnected = false
            startPolling()
            console.warn('[Piso Realtime] WebSocket desconectado, reanudando polling de respaldo')
          }
        })
    } catch (err) {
      console.warn('[Piso Realtime] No se pudo configurar canal, usando polling:', err)
    }

    return () => {
      active = false
      stopPolling()
      if (moduleChannel) {
        try { supabase.removeChannel(moduleChannel) } catch { /* ignore */ }
        moduleChannel = null
      }
    }
  }, [refresh])
}
