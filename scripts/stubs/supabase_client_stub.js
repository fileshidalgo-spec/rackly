/**
 * Stub de '@/lib/supabase/client' para tests node (esbuild alias).
 * dataClient.from(tabla) devuelve un builder encadenable THENABLE que resuelve
 * con las filas enlatadas de __setTable(tabla, rows). Las mutaciones resuelven
 * vacío. Permite probar la lógica de consulta de api.ts sin red.
 */
const tables = {}
/** Captura de llamadas or() por tabla — para tests de composición de filtros.
 *  Aditivo (2026-10-29): los suites existentes no leen esto. */
const orCalls = []

function builder(table) {
  const p = {
    select() { return p },
    or(value) { orCalls.push({ table, value }); return p },
    eq() { return p },
    in() { return p },
    order() { return p },
    limit() { return p },
    range() { return p },
    ilike() { return p },
    not() { return p },
    textSearch() { return p },
    contains() { return p },
    maybeSingle() { return Promise.resolve({ data: null, error: null }) },
    single() { return Promise.resolve({ data: null, error: null }) },
    upsert() { return Promise.resolve({ data: null, error: null }) },
    insert() { return Promise.resolve({ data: null, error: null }) },
    update() { return Promise.resolve({ data: null, error: null }) },
    delete() { return Promise.resolve({ data: null, error: null }) },
    then(resolve, reject) {
      return Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject)
    },
  }
  return p
}

module.exports = {
  dataClient: {
    from: (t) => builder(t),
    rpc: () => Promise.resolve({ data: [], error: null }),
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel() {},
  },
  supabase: {
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel() {},
  },
  __setTable(t, rows) { tables[t] = rows },
  __orCalls() { return orCalls.slice() },
  __clear() {
    for (const k of Object.keys(tables)) delete tables[k]
    orCalls.length = 0
  },
}
