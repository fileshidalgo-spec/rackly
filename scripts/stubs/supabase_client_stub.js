/**
 * Stub de '@/lib/supabase/client' para tests node (esbuild alias).
 * dataClient.from(tabla) devuelve un builder encadenable THENABLE que resuelve
 * con las filas enlatadas de __setTable(tabla, rows). Las mutaciones resuelven
 * vacío. Permite probar la lógica de consulta de api.ts sin red.
 *
 * Aditivos 2026-10-30 (atención RAL unificada — no rompen suites previos):
 *   · __updateCalls()      → captura {table, payload} de cada update().
 *   · __setUpdateResult(r) → el PRÓXIMO update().select().maybeSingle()
 *     resuelve r una vez (camino respaldo optimista de atender/revertir).
 *   · maybeSingle() resuelve la PRIMERA fila enlatada de la tabla cuando no
 *     hay updateResult pendiente (lectura única en respaldos).
 */
const tables = {}
/** Captura de llamadas or() por tabla — para tests de composición de filtros.
 *  Aditivo (2026-10-29): los suites existentes no leen esto. */
const orCalls = []
/** Captura de llamadas eq {table, col, val} — aditivo 2026-10-31 (devoluciones
 *  de línea: verificar el filtro tipo_recepcion de listados y anti-duplicados). */
const eqCalls = []
/** Captura de inserts {table, payload} — aditivo 2026-10-31 (verificar que
 *  las filas llevan tipo_recepcion en alta y en la edición). */
const insertCalls = []
/** Captura de updates {table, payload} — aditivo 2026-10-30. */
const updateCalls = []
/** Captura de llamadas rpc {name, args} — aditivo 2026-10-31. */
const rpcCalls = []
/** Resultado pendiente para update().select().maybeSingle() (un uso). */
let updateResult = null
/** El próximo maybeSingle pertenece a un update (sirve updateResult, no tabla). */
let pendingUpdate = false
/** Aditivo 2026-10-30 (honestidad de DELETE): delete() ahora es ENCADENABLE
 *  (delete().in().select()) y resuelve { data: resultado enlatado } UNA vez;
 *  sin resultado enlatado resuelve { data: null } (legado).
 *  Aditivo 2026-10-31 (COLA): funciones con VARIOS delete seguidos
 *  (eliminarRq, piso doble delete, guardarEdicionGuia) consumen los
 *  resultados enlatados EN ORDEN FIFO — __setDeleteResult encola; si la
 *  cola está vacía, resuelve { data: null } (compatibilidad total). */
const deleteQueue = []
let pendingDelete = false
/** Aditivo 2026-10-31 (regularización T173-00004274): rpc(name, args) puede
 *  resolver un resultado enlatado por NOMBRE de función — cola FIFO; sin
 *  enlatado resuelve { data: [], error: null } (compatibilidad total con
 *  todos los suites previos, cuyo guard ve data=[] ≠ true = sin permiso). */
const rpcQueue = {}

function builder(table) {
  const p = {
    select() { return p },
    or(value) { orCalls.push({ table, value }); return p },
    eq(col, val) { eqCalls.push({ table, col, val }); return p },
    in() { return p },
    order() { return p },
    limit() { return p },
    range() { return p },
    ilike() { return p },
    not() { return p },
    neq() { return p },
    gte() { return p },
    lte() { return p },
    gt() { return p },
    lt() { return p },
    is() { return p },
    textSearch() { return p },
    contains() { return p },
    maybeSingle() {
      if (pendingUpdate) {
        pendingUpdate = false
        const r = updateResult ?? { data: null, error: null }
        updateResult = null
        return Promise.resolve(r)
      }
      const rows = tables[table] ?? []
      return Promise.resolve({ data: rows[0] ?? null, error: null })
    },
    single() { return Promise.resolve({ data: null, error: null }) },
    upsert() { return Promise.resolve({ data: null, error: null }) },
    insert(payload) { insertCalls.push({ table, payload }); return Promise.resolve({ data: null, error: null }) },
    update(payload) {
      updateCalls.push({ table, payload })
      pendingUpdate = true
      return p
    },
    delete() {
      pendingDelete = true
      return p
    },
    then(resolve, reject) {
      if (pendingDelete) {
        pendingDelete = false
        const r = deleteQueue.length ? deleteQueue.shift() : { data: null, error: null }
        return Promise.resolve(r).then(resolve, reject)
      }
      return Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject)
    },
  }
  return p
}

module.exports = {
  dataClient: {
    from: (t) => builder(t),
    rpc: (name, args) => {
      const q = rpcQueue[name]
      const r = q && q.length ? q.shift() : { data: [], error: null }
      rpcCalls.push({ name, args })
      return Promise.resolve(r)
    },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel() {},
  },
  supabase: {
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel() {},
  },
  __setTable(t, rows) { tables[t] = rows },
  __orCalls() { return orCalls.slice() },
  __eqCalls() { return eqCalls.slice() },
  __insertCalls() { return insertCalls.slice() },
  __updateCalls() { return updateCalls.slice() },
  __setUpdateResult(r) { updateResult = r },
  __setDeleteResult(r) { deleteQueue.push(r) },
  /** Encola el resultado del PRÓXIMO rpc(name) (cola FIFO por nombre). */
  __setRpcResult(name, r) {
    if (!rpcQueue[name]) rpcQueue[name] = []
    rpcQueue[name].push(r)
  },
  /** Captura de llamadas rpc {name, args} — para verificar el permiso pedido. */
  __rpcCalls() { return rpcCalls.slice() },
  __clear() {
    for (const k of Object.keys(tables)) delete tables[k]
    orCalls.length = 0
    eqCalls.length = 0
    insertCalls.length = 0
    updateCalls.length = 0
    rpcCalls.length = 0
    for (const k of Object.keys(rpcQueue)) delete rpcQueue[k]
    updateResult = null
    pendingUpdate = false
    deleteQueue.length = 0
    pendingDelete = false
  },
}
