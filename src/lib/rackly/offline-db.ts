/**
 * OfflineDB — Almacenamiento local con IndexedDB
 * 
 * Almacena:
 * - pendingMovements: movimientos creados offline pendientes de sincronizar
 * - cachedMovimientos: todos los movimientos para cálculo de stock offline
 * - cachedCatalogo: catálogo completo para búsquedas offline
 * - cachedUsuarios: lista de usuarios/perfiles offline
 * - syncMeta: metadata de sincronización (lastSyncTime, etc.)
 */

const DB_NAME = 'rackly-offline'
const DB_VERSION = 1

// ═══════════════════════════════════════════
// Types
// ═══════════════════════════════════════════

export type PendingMovement = {
  id: string // UUID generado en el dispositivo (crypto.randomUUID)
  uuidSync: string // Mismo UUID que se envía al servidor para idempotencia
  tipo: 'ingreso' | 'salida' | 'devolucion' | 'traslado'
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  fVencimiento: string
  turno: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  proveedor?: string
  codigo_inc?: string
  // Metadata de sincronización
  createdAt: number // timestamp Unix (ms)
  status: 'pending' | 'syncing' | 'error' | 'conflict'
  retries: number
  lastError?: string
  // Para traslados: campos adicionales del destino
  destBloque?: string
  destTorre?: string
  destPiso?: string
  destPosicion?: string
  cantidadAjuste?: number
}

export type CachedMovimiento = {
  id: string
  tipo: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  codigo: string
  descripcion: string
  un: string
  cantidad: number
  fVencimiento: string
  fModificacion: string
  turno: string
  usuarioId: string
  usuarioNombre?: string
  usuarioCorreo?: string
  proveedor?: string
  cachedAt: number
}

export type SyncMeta = {
  key: string
  value: string
}

// ═══════════════════════════════════════════
// Database singleton
// ═══════════════════════════════════════════

let dbInstance: IDBDatabase | null = null
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('[OfflineDB] Error abriendo base de datos:', request.error)
      dbPromise = null
      reject(request.error)
    }

    request.onsuccess = () => {
      dbInstance = request.result
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Store: movimientos pendientes de sincronizar
      if (!db.objectStoreNames.contains('pendingMovements')) {
        const pendingStore = db.createObjectStore('pendingMovements', { keyPath: 'id' })
        pendingStore.createIndex('status', 'status', { unique: false })
        pendingStore.createIndex('createdAt', 'createdAt', { unique: false })
      }

      // Store: movimientos cacheados (stock local)
      if (!db.objectStoreNames.contains('cachedMovimientos')) {
        const movStore = db.createObjectStore('cachedMovimientos', { keyPath: 'id' })
        movStore.createIndex('codigo', 'codigo', { unique: false })
        movStore.createIndex('fModificacion', 'fModificacion', { unique: false })
      }

      // Store: catálogo cacheado
      if (!db.objectStoreNames.contains('cachedCatalogo')) {
        db.createObjectStore('cachedCatalogo', { keyPath: 'codigo' })
      }

      // Store: usuarios cacheados
      if (!db.objectStoreNames.contains('cachedUsuarios')) {
        db.createObjectStore('cachedUsuarios', { keyPath: 'id' })
      }

      // Store: metadata de sincronización
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'key' })
      }
    }
  })

  return dbPromise
}

// ═══════════════════════════════════════════
// Generic helpers
// ═══════════════════════════════════════════

function withTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const request = operation(store)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

// ═══════════════════════════════════════════
// Pending Movements (cola de sincronización)
// ═══════════════════════════════════════════

/** Guardar un movimiento pendiente de sincronizar */
export function savePendingMovement(movement: PendingMovement): Promise<void> {
  return withTransaction('pendingMovements', 'readwrite', (store) => store.put(movement)).then(() => {})
}

/** Obtener todos los movimientos pendientes, ordenados por createdAt */
export function getPendingMovements(): Promise<PendingMovement[]> {
  return openDB().then(
    (db) =>
      new Promise<PendingMovement[]>((resolve, reject) => {
        const tx = db.transaction('pendingMovements', 'readonly')
        const store = tx.objectStore('pendingMovements')
        const index = store.index('createdAt')
        const request = index.getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

/** Actualizar estado de un movimiento pendiente */
export function updatePendingMovement(id: string, updates: Partial<PendingMovement>): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pendingMovements', 'readwrite')
        const store = tx.objectStore('pendingMovements')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const existing = getReq.result
          if (existing) {
            const updated = { ...existing, ...updates }
            const putReq = store.put(updated)
            putReq.onsuccess = () => resolve()
            putReq.onerror = () => reject(putReq.error)
          } else {
            resolve()
          }
        }
        getReq.onerror = () => reject(getReq.error)
      })
  )
}

/** Eliminar un movimiento pendiente (ya sincronizado) */
export function removePendingMovement(id: string): Promise<void> {
  return withTransaction('pendingMovements', 'readwrite', (store) => store.delete(id)).then(() => {})
}

/** Contar movimientos pendientes */
export function countPendingMovements(): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction('pendingMovements', 'readonly')
        const store = tx.objectStore('pendingMovements')
        const index = store.index('status')
        // Solo contar pending (no syncing, error o conflict)
        const range = IDBKeyRange.only('pending')
        const request = index.count(range)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

/** Contar movimientos con error */
export function countErrorMovements(): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction('pendingMovements', 'readonly')
        const store = tx.objectStore('pendingMovements')
        const index = store.index('status')
        const range = IDBKeyRange.only('error')
        const request = index.count(range)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

/** Contar movimientos en conflicto */
export function countConflictMovements(): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction('pendingMovements', 'readonly')
        const store = tx.objectStore('pendingMovements')
        const index = store.index('status')
        const range = IDBKeyRange.only('conflict')
        const request = index.count(range)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

// ═══════════════════════════════════════════
// Cached Movimientos (stock local)
// ═══════════════════════════════════════════

/** Guardar todos los movimientos en caché local */
export async function cacheMovimientos(movs: CachedMovimiento[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cachedMovimientos', 'readwrite')
    const store = tx.objectStore('cachedMovimientos')
    // Limpiar cache anterior y guardar nuevo
    store.clear()
    for (const mov of movs) {
      store.put(mov)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Obtener todos los movimientos cacheados */
export function getCachedMovimientos(): Promise<CachedMovimiento[]> {
  return withTransaction('cachedMovimientos', 'readonly', (store) => store.getAll())
}

/** Obtener movimientos cacheados por código */
export function getCachedMovimientosByCodigo(codigo: string): Promise<CachedMovimiento[]> {
  return openDB().then(
    (db) =>
      new Promise<CachedMovimiento[]>((resolve, reject) => {
        const tx = db.transaction('cachedMovimientos', 'readonly')
        const store = tx.objectStore('cachedMovimientos')
        const index = store.index('codigo')
        const request = index.getAll(codigo)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

// ═══════════════════════════════════════════
// Cached Catalogo
// ═══════════════════════════════════════════

/** Guardar un item del catálogo en caché */
export function saveCachedCatalogoItem(item: Record<string, unknown> & { codigo: string }): Promise<void> {
  return withTransaction('cachedCatalogo', 'readwrite', (store) => store.put(item)).then(() => {})
}

/** Guardar todo el catálogo en caché */
export async function cacheCatalogo(items: (Record<string, unknown> & { codigo: string })[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cachedCatalogo', 'readwrite')
    const store = tx.objectStore('cachedCatalogo')
    store.clear()
    for (const item of items) {
      store.put(item)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Obtener todo el catálogo cacheado */
export function getCachedCatalogo(): Promise<Record<string, unknown>[]> {
  return withTransaction('cachedCatalogo', 'readonly', (store) => store.getAll())
}

// ═══════════════════════════════════════════
// Cached Usuarios
// ═══════════════════════════════════════════

/** Guardar usuarios en caché */
export async function cacheUsuarios(users: (Record<string, unknown> & { id: string })[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cachedUsuarios', 'readwrite')
    const store = tx.objectStore('cachedUsuarios')
    store.clear()
    for (const user of users) {
      store.put(user)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Obtener usuarios cacheados */
export function getCachedUsuarios(): Promise<Record<string, unknown>[]> {
  return withTransaction('cachedUsuarios', 'readonly', (store) => store.getAll())
}

// ═══════════════════════════════════════════
// Sync Meta
// ═══════════════════════════════════════════

/** Guardar un valor de metadata */
export function setSyncMeta(key: string, value: string): Promise<void> {
  return withTransaction('syncMeta', 'readwrite', (store) =>
    store.put({ key, value })
  ).then(() => {})
}

/** Obtener un valor de metadata */
export function getSyncMeta(key: string): Promise<string | null> {
  return withTransaction<SyncMeta | undefined>('syncMeta', 'readonly', (store) =>
    store.get(key)
  ).then((result) => (result ? result.value : null))
}

// ═══════════════════════════════════════════
// Init (abrir la DB al inicio)
// ═══════════════════════════════════════════

/** Inicializar la base de datos offline */
export async function initOfflineDB(): Promise<boolean> {
  try {
    await openDB()
    return true
  } catch (err) {
    console.error('[OfflineDB] Error inicializando:', err)
    return false
  }
}
