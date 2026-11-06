'use client'

import { useEffect, useRef, useCallback } from 'react'
import { dataClient, supabase } from '@/lib/supabase/client'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

/**
 * Hook que mantiene sincronizadas las pestañas de Piso.
 * Escucha cambios en las tablas piso_movimientos y piso_movimiento_detalles
 * mediante Supabase Realtime, con polling SOLO como respaldo cuando el
 * WebSocket NO está conectado.
 * El canal usa dataClient (service_role): sigue recibiendo eventos con RLS
 * restringido a authenticated y sin exponer cambios al cliente público anon.
 *
 * Comportamiento:
 * - Al montar: carga inicial (refresh) + intenta conectar WebSocket
 * - Si WebSocket se conecta: DETIENE el polling
 * - Si WebSocket falla/timeout: REANUDA el polling como respaldo
 * - Al desmontar: limpia intervalo y canal
 * - Coalescing (mejoras-piso 20261107): ráfagas de eventos (un traslado genera
 *   2 cabeceras + N detalles; N operarios concurrentes multiplican) se colapsan
 *   en UN solo refresh (mín 50 ms, techo 1.2 s anti-hambre).
 */
const CHANNEL_NAME = 'piso-realtime-sync'
const DEBOUNCE_LEAD_MS = 50   // primer evento: espera mínima para agrupar la ráfaga
const DEBOUNCE_MAX_MS = 1200  // techo anti-hambre: refresca aunque sigan llegando eventos

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

  // Coalescing: agrupa ráfagas de eventos en un solo refresh (crítico con
  // varios operarios concurrentes: cada atención no debe refrescar N veces)
  const debounceRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; first: number } | null>(null)
  const activeRef = useRef(false)
  const scheduleRefresh = useCallback(() => {
    const state = debounceRef.current ?? { timer: null, first: 0 }
    if (state.timer) clearTimeout(state.timer)
    const now = Date.now()
    if (!state.first) state.first = now
    const delay = Math.max(DEBOUNCE_LEAD_MS, DEBOUNCE_MAX_MS - (now - state.first))
    state.timer = setTimeout(() => {
      debounceRef.current = null
      if (activeRef.current) refresh()
    }, delay)
    debounceRef.current = state
  }, [refresh])

  useEffect(() => {
    let active = true
    activeRef.current = active
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
      try { dataClient.removeChannel(moduleChannel) } catch { /* ignore */ }
      moduleChannel = null
    }

    // Realtime: escucha cambios en piso_movimientos y piso_movimiento_detalles
    try {
      moduleChannel = dataClient
        .channel(CHANNEL_NAME)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimientos' },
          () => scheduleRefresh()
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimiento_detalles' },
          () => scheduleRefresh()
        )
        .subscribe((status, err) => {
          if (!active) return

          if (status === 'SUBSCRIBED') {
            wsConnected = true
            stopPolling()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
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
      activeRef.current = false
      stopPolling()
      if (debounceRef.current?.timer) clearTimeout(debounceRef.current.timer)
      debounceRef.current = null
      if (moduleChannel) {
        try { dataClient.removeChannel(moduleChannel) } catch { /* ignore */ }
        moduleChannel = null
      }
    }
  }, [refresh])
}
