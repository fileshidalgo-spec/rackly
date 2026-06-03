'use client'

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'

/**
 * Hook que mantiene la lista de movimientos sincronizada.
 * Usa Supabase Realtime como mecanismo principal y polling cada 8s como respaldo.
 * Channel name estable (sin Date.now()) para permitir reconexión correcta.
 * Usa ref para onChange para evitar stale closures.
 */
const CHANNEL_NAME = 'movs-realtime-sync'

export function useMovimientosRealtime(
  onChange: (movs: Movimiento[]) => void
) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    let active = true

    const refresh = () => {
      fetchMovimientos()
        .then((m) => active && onChangeRef.current(m))
        .catch((err) => console.warn('[Realtime] Error al refrescar movimientos:', err))
    }

    refresh()

    // Respaldo: polling cada 8 segundos
    const pollInterval = setInterval(() => {
      if (active) refresh()
    }, 8000)

    // Realtime: refresco instantáneo cuando se inserta/borra un movimiento
    let channel: ReturnType<typeof supabase.channel> | null = null
    try {
      channel = supabase
        .channel(CHANNEL_NAME)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'movimientos' },
          () => {
            // Debounce: esperar 500ms antes de refrescar para evitar múltiples refrescos rápidos
            setTimeout(() => { if (active) refresh() }, 500)
          }
        )
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            // Conexión exitosa
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[Realtime] Error de canal, reconectando...', err)
            // El polling cubre mientras se reconecta
          }
        })
    } catch (err) {
      console.warn('[Realtime] No se pudo configurar canal, usando polling:', err)
    }

    return () => {
      active = false
      clearInterval(pollInterval)
      if (channel) {
        try { supabase.removeChannel(channel) } catch { /* ignore */ }
      }
    }
  }, [])
}
