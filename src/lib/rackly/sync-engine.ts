/**
 * SyncEngine — Motor de sincronización offline/online
 * 
 * Responsabilidades:
 * - Detectar estado de conectividad (navigator.onLine + ping a Supabase)
 * - Gestionar la cola de movimientos pendientes
 * - Sincronizar movimientos al reconectarse
 * - Cachear datos (movimientos, catálogo, usuarios) para lectura offline
 * - Notificar cambios de estado a los suscriptores
 */

import {
  initOfflineDB,
  type PendingMovement,
  type CachedMovimiento,
  savePendingMovement,
  getPendingMovements,
  updatePendingMovement,
  removePendingMovement,
  countPendingMovements,
  countErrorMovements,
  countConflictMovements,
  cacheMovimientos,
  getCachedMovimientos,
  getSyncMeta,
  setSyncMeta,
} from './offline-db'

import { addMovimiento, fetchMovimientos, trasladarMovimiento, type Movimiento, type Turno } from './kardex'

// ═══════════════════════════════════════════
// Types
// ═══════════════════════════════════════════

export type ConnectivityStatus = 'online' | 'offline' | 'syncing' | 'error'

export type SyncState = {
  connectivity: ConnectivityStatus
  pendingCount: number
  errorCount: number
  conflictCount: number
  isSyncing: boolean
  lastSyncTime: number | null
  lastPingTime: number | null
  initialized: boolean
}

type SyncListener = (state: SyncState) => void

// ═══════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''

const INITIAL_STATE: SyncState = {
  connectivity: 'offline',
  pendingCount: 0,
  errorCount: 0,
  conflictCount: 0,
  isSyncing: false,
  lastSyncTime: null,
  lastPingTime: null,
  initialized: false,
}

class SyncEngineSingleton {
  private state: SyncState = { ...INITIAL_STATE }
  private listeners: Set<SyncListener> = new Set()
  private syncInProgress = false
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private countsInterval: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  // ── Init ──────────────────────────────
  async init(): Promise<void> {
    if (this.state.initialized) return

    try {
      // Abrir IndexedDB
      const dbOk = await initOfflineDB()
      if (!dbOk) {
        console.warn('[SyncEngine] IndexedDB no disponible, modo offline desactivado')
        this.updateState({ initialized: true, connectivity: 'online' }) // Sin IndexedDB, asumimos online
        return
      }

      // Cargar última sincronización
      const lastSync = await getSyncMeta('lastSyncTime')
      this.state.lastSyncTime = lastSync ? parseInt(lastSync, 10) : null

      // Conteo inicial de pendientes
      await this.refreshCounts()

      // Detectar conectividad inicial
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
      this.updateState({
        initialized: true,
        connectivity: isOnline ? 'online' : 'offline',
      })

      // Listeners de eventos del navegador
      if (typeof window !== 'undefined') {
        window.addEventListener('online', this.handleOnline)
        window.addEventListener('offline', this.handleOffline)
      }

      // Ping periódico a Supabase (cada 30s)
      this.startPing()

      // Refresco de conteos (cada 5s)
      this.countsInterval = setInterval(() => this.refreshCounts(), 5000)

      // Si estamos online, sincronizar pendientes + cachear datos
      if (isOnline) {
        this.syncAll()
      }

      console.log('[SyncEngine] Inicializado. Online:', isOnline, 'Pendientes:', this.state.pendingCount)
    } catch (err) {
      console.error('[SyncEngine] Error en init:', err)
      this.updateState({ initialized: true, connectivity: 'online' }) // Fallback: operar online
    }
  }

  // ── Cleanup ─────────────────────────
  destroy(): void {
    this.destroyed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
    }
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.countsInterval) clearInterval(this.countsInterval)
    this.listeners.clear()
  }

  // ── State ────────────────────────────
  getState(): SyncState {
    return { ...this.state }
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener)
    // Enviamos estado actual inmediatamente
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private updateState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial }
    this.listeners.forEach((fn) => {
      try { fn(this.state) } catch { /* ignore listener errors */ }
    })
  }

  // ── Connectivity ────────────────────
  private handleOnline = (): void => {
    console.log('[SyncEngine] Navegador reporta: ONLINE')
    this.updateState({ connectivity: 'online' })
    // No sincronizar automáticamente aquí — esperar al ping confirmado
    this.pingSupabase().then((ok) => {
      if (ok && !this.syncInProgress) {
        this.syncAll()
      }
    })
  }

  private handleOffline = (): void => {
    console.log('[SyncEngine] Navegador reporta: OFFLINE')
    this.updateState({ connectivity: 'offline' })
    // Cancelar sincronización en curso (los retries se reintentarán al reconectar)
    this.syncInProgress = false
  }

  private startPing(): void {
    // Primer ping inmediato
    this.pingSupabase()

    // Ping cada 30 segundos
    this.pingInterval = setInterval(() => {
      this.pingSupabase()
    }, 30000)
  }

  private async pingSupabase(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      this.updateState({
        lastPingTime: Date.now(),
        connectivity: 'online',
      })
      return true
    } catch {
      if (navigator.onLine) {
        // El navegador dice online pero no hay conexión real
        this.updateState({ connectivity: 'offline' })
      }
      return false
    }
  }

  // ── Counts ───────────────────────────
  private async refreshCounts(): Promise<void> {
    try {
      const [pending, errors, conflicts] = await Promise.all([
        countPendingMovements(),
        countErrorMovements(),
        countConflictMovements(),
      ])
      this.updateState({
        pendingCount: pending,
        errorCount: errors,
        conflictCount: conflicts,
      })
    } catch {
      // Silencioso
    }
  }

  // ── Enqueue Movement ─────────────────
  /** Encolar un movimiento para sincronización offline */
  async enqueueMovement(movement: Omit<PendingMovement, 'id' | 'uuidSync' | 'createdAt' | 'status' | 'retries'>): Promise<PendingMovement> {
    const id = crypto.randomUUID()
    const uuidSync = id // El id generado local es el uuid_sync del servidor
    const pending: PendingMovement = {
      ...movement,
      id,
      uuidSync,
      createdAt: Date.now(),
      status: 'pending',
      retries: 0,
    }

    await savePendingMovement(pending)
    await this.refreshCounts()

    // Si estamos online, intentar sincronizar inmediatamente
    if (this.state.connectivity === 'online' && !this.syncInProgress) {
      this.syncAll()
    }

    return pending
  }

  // ── Sync All ─────────────────────────
  /** Sincronizar todos los pendientes + cachear datos del servidor */
  async syncAll(): Promise<void> {
    if (this.syncInProgress || this.destroyed) return
    this.syncInProgress = true
    this.updateState({ isSyncing: true, connectivity: 'syncing' })

    try {
      // 1. Enviar movimientos pendientes
      await this.syncPendingMovements()

      // 2. Cachear datos más recientes del servidor
      await this.cacheAllData()

      // 3. Marcar tiempo de última sincronización
      const now = Date.now()
      await setSyncMeta('lastSyncTime', now.toString())
      this.updateState({ lastSyncTime: now })

      // 4. Actualizar conteos
      await this.refreshCounts()

      // 5. Si no hay errores, volver a online
      if (this.state.errorCount === 0 && this.state.conflictCount === 0) {
        this.updateState({ connectivity: 'online' })
      }
    } catch (err) {
      console.error('[SyncEngine] Error en syncAll:', err)
      this.updateState({ connectivity: 'error' })
    } finally {
      this.syncInProgress = false
      this.updateState({ isSyncing: false })
    }
  }

  // ── Sync Pending Movements ───────────
  private async syncPendingMovements(): Promise<{
    synced: number
    errors: number
    conflicts: number
  }> {
    const pending = await getPendingMovements()
    if (pending.length === 0) return { synced: 0, errors: 0, conflicts: 0 }

    console.log(`[SyncEngine] Sincronizando ${pending.length} movimiento(s) pendiente(s)...`)
    let synced = 0
    let errors = 0
    let conflicts = 0

    // Procesar uno por uno, en orden cronológico
    for (const mov of pending) {
      if (this.destroyed) break
      // Si nos quedamos sin conexión durante el loop, parar
      if (!navigator.onLine) {
        console.log('[SyncEngine] Conexión perdida durante sincronización, pausando...')
        break
      }

      try {
        // Marcar como syncing
        await updatePendingMovement(mov.id, { status: 'syncing' })
        await this.refreshCounts()

        if (mov.tipo === 'traslado' && mov.destBloque) {
          // Traslado
          await trasladarMovimiento(
            {
              codigo: mov.codigo,
              descripcion: mov.descripcion,
              un: mov.un,
              cantidad: mov.cantidad,
              origen: { bloque: mov.bloque, torre: mov.torre, piso: mov.piso, posicion: mov.posicion },
              destino: { bloque: mov.destBloque, torre: mov.destTorre || '1', piso: mov.destPiso || '1', posicion: mov.destPosicion || '1' },
              turno: mov.turno as Turno,
              usuarioId: mov.usuarioId,
              usuarioNombre: mov.usuarioNombre,
              usuarioCorreo: mov.usuarioCorreo,
              fVencimiento: mov.fVencimiento || undefined,
              proveedor: mov.proveedor,
              cantidadAjuste: mov.cantidadAjuste,
            }
          )
        } else {
          // Ingreso, salida, devolución
          await addMovimiento(
            {
              tipo: mov.tipo,
              bloque: mov.bloque,
              torre: mov.torre,
              piso: mov.piso,
              posicion: mov.posicion,
              codigo: mov.codigo,
              descripcion: mov.descripcion,
              un: mov.un,
              cantidad: mov.cantidad,
              fVencimiento: mov.fVencimiento,
              turno: mov.turno as Turno,
              usuarioId: mov.usuarioId,
              usuarioNombre: mov.usuarioNombre,
              usuarioCorreo: mov.usuarioCorreo,
              proveedor: mov.proveedor,
            },
            mov.uuidSync
          )
        }

        // Éxito: eliminar de la cola
        await removePendingMovement(mov.id)
        synced++
        console.log(`[SyncEngine] ✓ Sincronizado: ${mov.tipo} ${mov.codigo} en B${mov.bloque}/T${mov.torre}/P${mov.piso}/Pos${mov.posicion}`)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const isConflict = errMsg.includes('INSUFFICIENT_STOCK')
        const isDuplicate = errMsg.includes('duplicate') || errMsg.includes('UNIQUE')

        if (isDuplicate) {
          // Ya existe en el servidor (idempotencia) — eliminar de cola
          await removePendingMovement(mov.id)
          synced++
          console.log(`[SyncEngine] ✓ Duplicado (ya sincronizado): ${mov.uuidSync}`)
        } else if (isConflict) {
          // Conflicto de stock — marcar para resolución del usuario
          await updatePendingMovement(mov.id, {
            status: 'conflict',
            retries: mov.retries + 1,
            lastError: errMsg,
          })
          conflicts++
          console.warn(`[SyncEngine] ⚠ Conflicto de stock: ${mov.codigo} en B${mov.bloque}/T${mov.torre}/P${mov.piso}/Pos${mov.posicion}`)
        } else {
          // Error genérico — reintentable
          const newRetries = mov.retries + 1
          if (newRetries >= 5) {
            // Demasiados reintentos, marcar como error permanente
            await updatePendingMovement(mov.id, {
              status: 'error',
              retries: newRetries,
              lastError: errMsg,
            })
            errors++
          } else {
            // Volver a pending para reintento
            await updatePendingMovement(mov.id, {
              status: 'pending',
              retries: newRetries,
              lastError: errMsg,
            })
            errors++
          }
          console.error(`[SyncEngine] ✗ Error (intento ${newRetries}): ${errMsg}`)
        }
      }
    }

    await this.refreshCounts()
    console.log(`[SyncEngine] Sincronización completa: ${synced} ok, ${errors} errores, ${conflicts} conflictos`)
    return { synced, errors, conflicts }
  }

  // ── Cache Data ───────────────────────
  /** Descargar y cachear todos los datos del servidor para lectura offline */
  private async cacheAllData(): Promise<void> {
    try {
      // Cachear movimientos
      const movs = await fetchMovimientos()
      const cached: CachedMovimiento[] = movs.map((m) => ({
        ...m,
        cachedAt: Date.now(),
      }))
      await cacheMovimientos(cached)

      console.log(`[SyncEngine] Datos cacheados: ${cached.length} movimientos`)
    } catch (err) {
      console.error('[SyncEngine] Error cacheando datos:', err)
      // No es crítico — la app sigue funcionando con datos antiguos
    }
  }

  // ── Manual Actions ──────────────────

  /** Forzar sincronización manual */
  async forceSync(): Promise<void> {
    if (this.state.connectivity === 'offline') {
      console.warn('[SyncEngine] No se puede sincronizar offline')
      return
    }
    await this.syncAll()
  }

  /** Reintentar un movimiento con conflicto — ajustar cantidad al stock disponible */
  async retryConflictWithAdjustedQty(id: string, adjustedQty: number): Promise<boolean> {
    const pending = await getPendingMovements()
    const mov = pending.find((m) => m.id === id)
    if (!mov) return false

    try {
      await updatePendingMovement(id, { status: 'syncing' })
      await addMovimiento(
        {
          tipo: mov.tipo,
          bloque: mov.bloque,
          torre: mov.torre,
          piso: mov.piso,
          posicion: mov.posicion,
          codigo: mov.codigo,
          descripcion: mov.descripcion,
          un: mov.un,
          cantidad: adjustedQty,
          fVencimiento: mov.fVencimiento,
          turno: mov.turno as Turno,
          usuarioId: mov.usuarioId,
          usuarioNombre: mov.usuarioNombre,
          usuarioCorreo: mov.usuarioCorreo,
          proveedor: mov.proveedor,
        },
        mov.uuidSync
      )
      await removePendingMovement(id)
      await this.refreshCounts()
      return true
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await updatePendingMovement(id, { status: 'conflict', lastError: errMsg, retries: mov.retries + 1 })
      await this.refreshCounts()
      return false
    }
  }

  /** Cancelar un movimiento con conflicto o error */
  async cancelPendingMovement(id: string): Promise<void> {
    await removePendingMovement(id)
    await this.refreshCounts()
  }

  /** Obtener movimientos con conflicto para mostrar al usuario */
  async getConflicts(): Promise<PendingMovement[]> {
    const pending = await getPendingMovements()
    return pending.filter((m) => m.status === 'conflict' || m.status === 'error')
  }

  /** Obtener movimientos cacheados para cálculo de stock local */
  async getCachedMovimientosForStock(): Promise<CachedMovimiento[]> {
    try {
      return await getCachedMovimientos()
    } catch {
      return []
    }
  }
}

// Singleton exportado
export const SyncEngine = new SyncEngineSingleton()
