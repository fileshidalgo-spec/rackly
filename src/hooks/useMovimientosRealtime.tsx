'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'

/**
 * Hook que mantiene la lista de movimientos sincronizada.
 * Usa Supabase Realtime como mecanismo principal y polling cada 8s como respaldo.
 */
export function useMovimientosRealtime(
  onChange: (movs: Movimiento[]) => void
) {
  useEffect(() => {
    let active = true

    const refresh = () => {
      fetchMovimientos()
        .then((m) => active && onChange(m))
        .catch(() => {})
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
        .channel(`movs-rt-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'movimientos' },
          () => refresh()
        )
        .subscribe()
    } catch {
      // Si Realtime no está configurado, el polling cubre
    }

    return () => {
      active = false
      clearInterval(pollInterval)
      if (channel) {
        try { supabase.removeChannel(channel) } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
