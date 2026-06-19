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

// Referencia a nivel de módulo para limpiar el canal correctamente entre remounts
let moduleChannel: ReturnType<typeof supabase.channel> | null = null

export function useMovimientosRealtime(
  onChange: (movs: Movimiento[]) => void
) {
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  })

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

    // Limpiar canal previo (React Strict Mode / remount)
    if (moduleChannel) {
      try { supabase.removeChannel(moduleChannel) } catch { /* ignore */ }
      moduleChannel = null
    }

    // Realtime: refresco instantáneo cuando se inserta/borra un movimiento
    try {
      moduleChannel = supabase
        .channel(CHANNEL_NAME)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'movimientos' },
          () => {
            // Debounce: esperar 150ms antes de refrescar para evitar múltiples refrescos rápidos
            setTimeout(() => { if (active) refresh() }, 150)
          }
        )
        .subscribe((status, err) => {
          if (!active) return
          if (status === 'SUBSCRIBED') {
            // Conexión exitosa
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[Realtime] Error de canal, reconectando...', err)
          }
        })
    } catch (err) {
      console.warn('[Realtime] No se pudo configurar canal, usando polling:', err)
    }

    return () => {
      active = false
      clearInterval(pollInterval)
      if (moduleChannel) {
        try { supabase.removeChannel(moduleChannel) } catch { /* ignore */ }
        moduleChannel = null
      }
    }
  }, [])
}
