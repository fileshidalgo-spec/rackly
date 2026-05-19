'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'

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

    const channelName = `movimientos-realtime-${Math.random().toString(36).slice(2)}`
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'movimientos' },
        () => refresh()
      )
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
