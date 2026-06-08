'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { SyncEngine, type SyncState } from '@/lib/rackly/sync-engine'

/**
 * Hook para reactividad del estado de conectividad y sincronización.
 * 
 * Uso:
 *   const { connectivity, pendingCount, isSyncing, forceSync } = useConnectivity()
 */
export function useConnectivity() {
  const [state, setState] = useState<SyncState>({
    connectivity: 'online',
    pendingCount: 0,
    errorCount: 0,
    conflictCount: 0,
    isSyncing: false,
    lastSyncTime: null,
    lastPingTime: null,
    initialized: false,
  })

  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    // Iniciar el SyncEngine
    SyncEngine.init()

    // Suscribirse a cambios de estado
    const unsub = SyncEngine.subscribe((newState) => {
      setState(newState)
    })

    return unsub
  }, [])

  const forceSync = useCallback(async () => {
    await SyncEngine.forceSync()
  }, [])

  const retryConflict = useCallback(async (id: string, adjustedQty: number) => {
    return SyncEngine.retryConflictWithAdjustedQty(id, adjustedQty)
  }, [])

  const cancelPending = useCallback(async (id: string) => {
    await SyncEngine.cancelPendingMovement(id)
  }, [])

  return {
    ...state,
    forceSync,
    retryConflict,
    cancelPending,
  }
}
