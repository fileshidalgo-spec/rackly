'use client'

import { useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

/**
 * Hook que mantiene sincronizadas las pestañas de Piso.
 * Escucha cambios en las tablas piso_movimientos y piso_movimiento_detalles
 * mediante Supabase Realtime, con polling cada 8s como respaldo.
 *
 * Usa ref para el callback para evitar stale closures.
 * El callback se invoca cada vez que la base de datos cambia (ingreso, salida,
 * traslado, devolución, eliminación) para que cada componente refresque sus datos.
 */
const CHANNEL_NAME = 'piso-realtime-sync'

export function usePisoRealtime(onChange: () => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Memoized refresh to avoid recreating on every render
  const refresh = useCallback(() => {
    if (onChangeRef.current) onChangeRef.current()
  }, [])

  useEffect(() => {
    let active = true

    // Respaldo: polling cada 8 segundos
    refresh() // Initial trigger

    const pollInterval = setInterval(() => {
      if (active) refresh()
    }, POLLING_INTERVAL)

    // Realtime: escucha cambios en piso_movimientos (nuevos movimientos, eliminaciones)
    let channel: ReturnType<typeof supabase.channel> | null = null
    try {
      channel = supabase
        .channel(CHANNEL_NAME)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimientos' },
          () => {
            // Debounce 500ms para evitar múltiples refrescos rápidos
            setTimeout(() => { if (active) refresh() }, 500)
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'piso_movimiento_detalles' },
          () => {
            // Debounce 500ms
            setTimeout(() => { if (active) refresh() }, 500)
          }
        )
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            // Conexión exitosa — no logging para no saturar consola
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[Piso Realtime] Error de canal, el polling cubre mientras se reconecta', err)
          }
        })
    } catch (err) {
      console.warn('[Piso Realtime] No se pudo configurar canal, usando polling:', err)
    }

    return () => {
      active = false
      clearInterval(pollInterval)
      if (channel) {
        try { supabase.removeChannel(channel) } catch { /* ignore */ }
      }
    }
  }, [refresh])
}
