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
  private initPromise: Promise<void> | null = null

  // ── Init ──────────────────────────────
  async init(): Promise<void> {
    // Patrón singleton async: evitar doble init en React Strict Mode
    if (this.initPromise) return this.initPromise
    if (this.state.initialized) return

    this.initPromise = this._doInit()
    try {
      await this.initPromise
    } catch {
      // Si falla, limpiar la promise para permitir reintentos
      this.initPromise = null
      throw new Error('[SyncEngine] Falló la inicialización')
    }
  }

  private async _doInit(): Promise<void> {

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
    // NO resetear syncInProgress aquí — dejar que la sincronización en curso falle
    // naturalmente. Resetearlo causaría que movimientos marcados como 'syncing'
    // se reintenten al reconectar, creando duplicados.
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
      // Ping al REST API de Supabase para verificar conectividad real.
      // Cualquier respuesta del servidor (200, 401, 400) significa que hay conexión.
      const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
        method: 'GET',
        headers: {
          'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''}`,
          'Content-Type': 'application/json',
          'Prefer': 'count=exact',
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      // Cualquier respuesta del servidor (200, 401, 400, 403) significa conectividad
      this.updateState({
        lastPingTime: Date.now(),
        connectivity: 'online',
      })
      return true
    } catch {
      if (navigator.onLine) {
        // El navegador dice online pero no hay conexión real al servidor
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
  /** Encolar un movimiento para sincronización offline.
   *  Si se provee un uuidSync externo, se usa ese (idempotencia con intento online previo).
   *  Si no, se genera uno nuevo.
   */
  async enqueueMovement(movement: Omit<PendingMovement, 'id' | 'uuidSync' | 'createdAt' | 'status' | 'retries'>, existingUuidSync?: string): Promise<PendingMovement> {
    const id = existingUuidSync || crypto.randomUUID()
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
          // Traslado — pasar uuidSync para idempotencia
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
              codigoInc: mov.codigo_inc || undefined,
              uuidSync: mov.uuidSync,
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
              codigoInc: mov.codigo_inc || undefined,
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
        // STOCK_VALIDATION_FAILED: la RPC no existe o falló la consulta de stock.
        // Si ya hubo 2 reintentos, asumir que la RPC no existe y marcar como error permanente
        // para que el usuario sepa que debe ejecutar el SQL en Supabase.
        const isValidationFailed = errMsg.includes('STOCK_VALIDATION_FAILED')


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
        } else if (isValidationFailed && mov.retries >= 2) {
          // RPC no existe o consulta de stock falla persistentemente.
          // Marcar como error permanente con mensaje claro para el usuario.
          await updatePendingMovement(mov.id, {
            status: 'error',
            retries: mov.retries + 1,
            lastError: 'VALIDACION_FALLIDA_RPC|La función RPC no existe en la base de datos. Ejecute el SQL de migración en Supabase Dashboard y reintente.',
          })
          errors++
          console.error(`[SyncEngine] ✗ Validación de stock fallida (RPC no encontrada?): ${mov.uuidSync}`)
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
          codigoInc: mov.codigo_inc || undefined,
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

  // ═══════════════════════════════════════════════════════════
  // OFFLINE-AWARE WRAPPERS — Usados por los componentes
  // ═══════════════════════════════════════════════════════════

  /**
   * Registrar un movimiento (ingreso/salida/devolución) con soporte offline.
   * Si hay internet → envía al servidor normalmente.
   * Si no hay internet → guarda en IndexedDB para sincronizar después.
   * 
   * Retorna: { movs, wasOffline }
   * - movs: array de movimientos actualizados (vacío si fue offline)
   * - wasOffline: true si se guardó offline
   */
  async offlineAwareAddMovimiento(
    m: Parameters<typeof addMovimiento>[0],
    uuidSync?: string
  ): Promise<{ movs: Movimiento[]; wasOffline: boolean }> {
    // GENERAR UUID de idempotencia ANTES del intento online.
    // Este mismo UUID se usa tanto para el intento online como para la cola offline,
    // garantizando que si el servidor recibe ambos, la UNIQUE constraint lo rechace.
    const syncId = uuidSync || crypto.randomUUID()

    // Intentar enviar al servidor si: online, o syncing/error PERO navigator dice online
    const shouldTryOnline = this.state.connectivity === 'online' || navigator.onLine

    if (shouldTryOnline) {
      try {
        const movs = await addMovimiento(m, syncId)
        return { movs, wasOffline: false }
      } catch (err) {
        // Detectar si fue un error de red/conexión
        const errMsg = err instanceof Error ? err.message : ''
        const isNetworkError = !navigator.onLine ||
          (err instanceof TypeError && errMsg.includes('fetch')) ||
          errMsg.includes('Failed to fetch') ||
          errMsg.includes('NetworkError') ||
          errMsg.includes('Network request failed') ||
          errMsg.includes('Load failed') ||
          errMsg.includes('ERR_CONNECTION') ||
          errMsg.includes('Aborted')
        if (!isNetworkError) throw err // Error de negocio (ej: INSUFFICIENT_STOCK), propagar
        // Error de red — caer al flujo offline con el MISMO UUID
        console.warn('[SyncEngine] Error de red, guardando offline con syncId:', syncId, errMsg)
      }
    }

    // Flujo offline: guardar en IndexedDB con el MISMO uuid de idempotencia
    try {
      await this.enqueueMovement({
        tipo: m.tipo,
        bloque: m.bloque,
        torre: m.torre,
        piso: m.piso,
        posicion: m.posicion,
        codigo: m.codigo,
        descripcion: m.descripcion,
        un: m.un,
        cantidad: m.cantidad,
        fVencimiento: m.fVencimiento,
        turno: m.turno,
        usuarioId: m.usuarioId,
        usuarioNombre: m.usuarioNombre || '',
        usuarioCorreo: m.usuarioCorreo || '',
        proveedor: m.proveedor,
        codigo_inc: m.codigoInc || '',
      }, syncId) // ← Pasar el MISMO UUID para idempotencia
      return { movs: [], wasOffline: true }
    } catch (offlineErr) {
      // IndexedDB no disponible — intentar enviar al servidor como último recurso
      console.error('[SyncEngine] IndexedDB no disponible, intentando enviar directo:', offlineErr)
      const movs = await addMovimiento(m, syncId)
      return { movs, wasOffline: false }
    }
  }

  /**
   * Registrar un traslado con soporte offline.
   * Si hay internet → envía al servidor normalmente.
   * Si no hay internet → guarda en IndexedDB (como un solo movimiento pendiente).
   */
  async offlineAwareTraslado(
    t: Parameters<typeof trasladarMovimiento>[0]
  ): Promise<{ movs: Movimiento[]; wasOffline: boolean }> {
    // Generar UUID de idempotencia para el traslado
    const syncId = crypto.randomUUID()

    // Intentar enviar al servidor si: online, o syncing/error PERO navigator dice online
    const shouldTryOnline = this.state.connectivity === 'online' || navigator.onLine

    if (shouldTryOnline) {
      try {
        // Pasar uuidSync para idempotencia del traslado
        const movs = await trasladarMovimiento({ ...t, uuidSync: syncId })
        return { movs, wasOffline: false }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : ''
        const isNetworkError = !navigator.onLine ||
          (err instanceof TypeError && errMsg.includes('fetch')) ||
          errMsg.includes('Failed to fetch') ||
          errMsg.includes('NetworkError') ||
          errMsg.includes('Network request failed') ||
          errMsg.includes('Load failed') ||
          errMsg.includes('Aborted')
        if (!isNetworkError) throw err
        console.warn('[SyncEngine] Error de red en traslado, guardando offline con syncId:', syncId, errMsg)
      }
    }

    // Flujo offline — usar el MISMO UUID para idempotencia
    try {
      await this.enqueueMovement({
        tipo: 'traslado',
        bloque: t.origen.bloque,
        torre: t.origen.torre,
        piso: t.origen.piso,
        posicion: t.origen.posicion,
        codigo: t.codigo,
        descripcion: t.descripcion,
        un: t.un,
        cantidad: t.cantidad,
        fVencimiento: t.fVencimiento || '',
        turno: t.turno,
        usuarioId: t.usuarioId,
        usuarioNombre: t.usuarioNombre || '',
        usuarioCorreo: t.usuarioCorreo || '',
        proveedor: t.proveedor,
        destBloque: t.destino.bloque,
        destTorre: t.destino.torre,
        destPiso: t.destino.piso,
        destPosicion: t.destino.posicion,
        cantidadAjuste: t.cantidadAjuste,
        codigo_inc: t.codigoInc || '',
      }, syncId) // ← Pasar el MISMO UUID
      return { movs: [], wasOffline: true }
    } catch (offlineErr) {
      // IndexedDB no disponible — intentar enviar al servidor como último recurso
      console.error('[SyncEngine] IndexedDB no disponible, intentando traslado directo:', offlineErr)
      // PASAR syncId para idempotencia — si el intento online parcial funcionó,
      // el uuidSync evitará duplicados en el servidor.
      const movs = await trasladarMovimiento({ ...t, uuidSync: syncId })
      return { movs, wasOffline: false }
    }
  }

  /** Verificar si estamos offline */
  isOffline(): boolean {
    return this.state.connectivity === 'offline' || this.state.connectivity === 'error'
  }
}

// Singleton exportado
export const SyncEngine = new SyncEngineSingleton()
