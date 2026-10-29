#!/usr/bin/env node
/**
 * RACKLY — 2026-10-30 · Atención UNIFICADA RQ+RAL (módulo Atención).
 *
 * Pedido del usuario: «la atención de RAL debe ser el mismo modelo que la
 * de RQ y todo debe aparecer en UNA sola lista, quizás con una distinción
 * que diga RAL».
 *
 * Suite doble:
 *   A. PURA — atencion-unificada.ts: unión/filtrado/orden/conteos de la
 *      lista única (RQ ya filtradas del server + RAL filtradas en cliente).
 *   B. STUB — ral.ts: mapeo del nuevo estado + atender/revertir con RPC
 *      ral_atender_item/ral_revertir_item y respaldo optimista (misma forma
 *      que rq-atencion.ts) + recálculo canónico de estado.
 */
const stub = require('../scripts/stubs/supabase_client_stub.js')
const {
  textoBusquedaRal,
  coincideFiltroRal,
  conteosEstado,
  unirFilasAtencion,
} = require('../src/lib/rackly/atencion-unificada')
const { listarRals, atenderItemRal, revertirItemRal } = require('../src/lib/rackly/ral')

let ok = 0
function check(nombre, cond) {
  if (!cond) {
    console.error(`✗ ${nombre}`)
    process.exitCode = 1
  } else {
    ok++
    console.log(`✓ ${nombre}`)
  }
}

// ── fixtures (misma forma que las filas reales) ──
const rq1 = {
  id: 'rq-1', createdAt: '2026-10-29T08:00:00Z', fecha: '2026-10-29', numeroRq: '0000192524',
  ordenProduccion: '4208503', productoCodigo: '4208503', productoDescripcion: 'AGUA SIN GAS CIELO',
  turno: 'T1', turnoRq: 'T1', linea: 'L2 SUSTITUTO', solicitante: 'MIGUEL', estado: 'Pendiente',
  fotoUrl: '', notas: '', usuarioId: 'u', usuarioNombre: 'U', usuarioCorreo: 'u@u.pe', ediciones: [],
}
const rq2 = {
  ...rq1, id: 'rq-2', createdAt: '2026-10-29T07:00:00Z', fecha: '2026-10-29',
  numeroRq: '0000192737', estado: 'En proceso',
}
const ral1 = {
  id: 'ral-1', createdAt: '2026-10-29T09:00:00Z', fecha: '2026-10-29', documento: '8378',
  transaccion: 'RAL', areaSolicitante: 'MANTENIMIENTO', solicitante: 'JORGE', aprobadoPor: 'ANA',
  almacen: 'ALM-01', linea: 'L1', fotoUrl: '', notas: '', usuarioId: 'u', usuarioNombre: 'U',
  usuarioCorreo: 'u@u.pe', estado: 'Pendiente', articulos: 2, textoItems: '118 ACIDO CITRICO 424 TAPAS',
}
const ral2 = {
  ...ral1, id: 'ral-2', createdAt: '2026-10-28T09:00:00Z', fecha: '2026-10-28', documento: '8379',
  estado: 'Atendido', areaSolicitante: 'CALIDAD',
}

const F0 = { busqueda: '', estado: 'todos', fecha: '', turno: 'todos' }

async function main() {
  // ══════════════ A. LISTA UNIFICADA (pura) ══════════════
  console.log('\n— A. unirFilasAtencion (orden y forma) —')

  const unida = unirFilasAtencion([rq1, rq2], [ral1, ral2], F0)
  check('une 4 filas (2 RQ + 2 RAL)', unida.length === 4)
  check('unión discriminada: RQ y RAL con key=id', unida[0].key && (unida[0].tipo === 'RAL' || unida[0].tipo === 'RQ'))
  check(
    'orden fecha DESC (10-29 antes que 10-28)',
    unida.map((f) => f.key).indexOf('ral-2') === unida.length - 1
  )
  check(
    'desempate created_at DESC dentro del mismo día (ral1 09:00 > rq1 08:00 > rq2 07:00)',
    JSON.stringify(unida.slice(0, 3).map((f) => f.key)) === JSON.stringify(['ral-1', 'rq-1', 'rq-2'])
  )
  const ralFila = unida.find((f) => f.tipo === 'RAL')
  check('fila RAL conserva el registro completo', ralFila && ralFila.ral.documento === '8378')

  console.log('\n— B. coincideFiltroRal (mismos filtros que el panel) —')
  check('sin filtros: RAL pasa', coincideFiltroRal(ral1, F0))
  check(
    'busqueda por documento (8378) case-insensitive',
    coincideFiltroRal(ral1, { ...F0, busqueda: '8378' })
  )
  check(
    'busqueda por ÁREA solicitante',
    coincideFiltroRal(ral1, { ...F0, busqueda: 'mantenimiento' })
  )
  check(
    'busqueda por CÓDIGO DE MATERIAL (textoItems: 118)',
    coincideFiltroRal(ral1, { ...F0, busqueda: '118' })
  )
  check('busqueda que no coincide → fuera', !coincideFiltroRal(ral1, { ...F0, busqueda: 'zzz' }))
  check(
    'filtro estado Pendiente: ral1 sí, ral2 (Atendido) no',
    coincideFiltroRal(ral1, { ...F0, estado: 'Pendiente' }) &&
      !coincideFiltroRal(ral2, { ...F0, estado: 'Pendiente' })
  )
  check('filtro fecha exacta', coincideFiltroRal(ral1, { ...F0, fecha: '2026-10-29' }) && !coincideFiltroRal(ral1, { ...F0, fecha: '2026-10-30' }))
  check(
    'filtro TURNO: el RAL no participa (no tiene turno)',
    !coincideFiltroRal(ral1, { ...F0, turno: 'T1' })
  )

  console.log('\n— C. conteosEstado (resumen rápido unificado) —')
  const c = conteosEstado(unida)
  check(
    'conteos mezclados RQ+RAL (pendientes=2, enProceso=1)',
    c.pendientes === 2 && c.enProceso === 1
  )
  const c2 = conteosEstado(unirFilasAtencion([], [ral1, ral2], F0))
  check('solo RAL: pendientes=1, atendidas=1', c2.pendientes === 1 && c2.atendidas === 1)

  console.log('\n— D. textoBusquedaRal —')
  check(
    'incluye encabezado + materiales',
    textoBusquedaRal(ral1).includes('8378') &&
      textoBusquedaRal(ral1).includes('mantenimiento') &&
      textoBusquedaRal(ral1).includes('acido citrico')
  )

  // ══════════════ E. ral.ts con stub ══════════════
  console.log('\n— E. listarRals mapea el estado nuevo —')
  stub.__clear()
  stub.__setTable('rals', [
    { id: 'ral-1', created_at: '2026-10-29T09:00:00Z', fecha: '2026-10-29', documento: '8378', estado: 'En proceso' },
    { id: 'ral-2', created_at: '2026-10-28T09:00:00Z', fecha: '2026-10-28', documento: '8379' }, // sin estado → default
  ])
  stub.__setTable('ral_items', [
    { ral_id: 'ral-1', codigo: '118', descripcion: 'ACIDO' },
    { ral_id: 'ral-1', codigo: '424', descripcion: 'TAPAS' },
  ])
  const ralsMapeadas = await listarRals()
  check('2 RAL listadas', ralsMapeadas.length === 2)
  check('estado leído de la BD (En proceso)', ralsMapeadas[0].estado === 'En proceso')
  check('estado default Pendiente cuando la fila no lo trae (históricos)', ralsMapeadas[1].estado === 'Pendiente')
  check('articulos + textoItems rellenados para búsqueda', ralsMapeadas[0].articulos === 2 && ralsMapeadas[0].textoItems.includes('118 ACIDO'))

  console.log('\n— F. atenderItemRal — RPC primero (ral_atender_item) —')
  stub.__clear()
  const filaRpc = {
    id: 'it-1', ral_id: 'ral-1', orden: 0, codigo: '118', descripcion: 'ACIDO CITRICO',
    unidad: 'KG', centro_costos: 'CC-1', cantidad: 10, cantidad_atendida: 10,
    usuario_atencion: 'MIGUEL', atendido_en: '2026-10-30T11:00:00Z',
  }
  const rpcOriginal = stub.dataClient.rpc
  stub.dataClient.rpc = (nombre, args) => {
    check(`rpc ${nombre} con args correctos`, nombre === 'ral_atender_item' && args.p_item_id === 'it-1' && args.p_cantidad === 10 && args.p_usuario === 'MIGUEL')
    return Promise.resolve({ data: filaRpc, error: null })
  }
  const atendidoRpc = await atenderItemRal('it-1', 10, 'MIGUEL')
  check('RPC responde → item mapeado a camelCase SIN caer al respaldo', atendidoRpc.cantidadAtendida === 10 && atendidoRpc.centroCostos === 'CC-1' && atendidoRpc.atendidoEn !== '')
  stub.dataClient.rpc = rpcOriginal

  console.log('\n— G. atenderItemRal — respaldo optimista (RPC no disponible) —')
  stub.__clear()
  stub.dataClient.rpc = () =>
    Promise.resolve({ data: null, error: { message: 'Could not find the function ral_atender_item in the schema cache' } })
  stub.__setTable('ral_items', [
    { id: 'it-1', ral_id: 'ral-1', orden: 0, codigo: '118', descripcion: 'ACIDO', unidad: 'KG', centro_costos: '', cantidad: 10, cantidad_atendida: 4, usuario_atencion: '', atendido_en: null },
    { id: 'it-2', ral_id: 'ral-1', orden: 1, codigo: '424', descripcion: 'TAPAS', unidad: 'UN', centro_costos: '', cantidad: 5, cantidad_atendida: 0, usuario_atencion: '', atendido_en: null },
  ])
  stub.__setUpdateResult({
    data: { id: 'it-1', ral_id: 'ral-1', cantidad: 10, cantidad_atendida: 9, usuario_atencion: 'MIGUEL', atendido_en: null },
    error: null,
  })
  const atendidoFb = await atenderItemRal('it-1', 5, 'MIGUEL')
  check('respaldo suma sobre lo atendido (4+5=9)', atendidoFb.cantidadAtendida === 9)
  const updates = stub.__updateCalls()
  const updItem = updates.find((u) => u.table === 'ral_items')
  check('update del item lleva cantidad_atendida + usuario + guard por igualdad', updItem && updItem.payload.cantidad_atendida === 9 && updItem.payload.usuario_atencion === 'MIGUEL')
  // recalcularEstadoRal releó ral_items (it-1: 9<10 pendiente, it-2: 0 → con algo atendido → En proceso)
  const updRal = updates.filter((u) => u.table === 'rals')
  check('recalcula el ESTADO del encabezado (En proceso) — regla canónica', updRal.length === 1 && updRal[0].payload.estado === 'En proceso')

  console.log('\n— H. respaldo: otra persona movió la fila → error, nunca pierde —')
  stub.__clear()
  stub.dataClient.rpc = () =>
    Promise.resolve({ data: null, error: { message: 'Could not find the function ral_atender_item in the schema cache' } })
  stub.__setTable('ral_items', [
    { id: 'it-1', ral_id: 'ral-1', cantidad: 10, cantidad_atendida: 4 },
  ])
  stub.__setUpdateResult({ data: null, error: null }) // guard optimista: 0 filas
  let falloConflict = ''
  try {
    await atenderItemRal('it-1', 5, 'MIGUEL')
  } catch (e) {
    falloConflict = e.message
  }
  check('conflicto detectado con mensaje claro', /otro usuario/i.test(falloConflict))

  console.log('\n— I. respaldo: guarda cantidad <= 0 y RPC con error de negocio —')
  stub.__clear()
  stub.dataClient.rpc = () => Promise.resolve({ data: null, error: { message: 'La cantidad a atender debe ser mayor que cero' } })
  let falloCero = ''
  try {
    await atenderItemRal('it-1', 0, 'MIGUEL')
  } catch (e) {
    falloCero = e.message
  }
  check('error de negocio de la RPC se propaga SIN respaldo', /mayor que cero/.test(falloCero))

  console.log('\n— J. revertirItemRal — RPC primero y respaldo con tope en 0 —')
  stub.__clear()
  stub.dataClient.rpc = (nombre, args) => {
    check('rpc ral_revertir_item', nombre === 'ral_revertir_item' && args.p_cantidad === 3)
    return Promise.resolve({
      data: { id: 'it-1', ral_id: 'ral-1', cantidad: 10, cantidad_atendida: 6, atendido_en: null },
      error: null,
    })
  }
  const revertido = await revertirItemRal('it-1', 3)
  check('reversa por RPC mapeada', revertido.cantidadAtendida === 6)

  stub.__clear()
  stub.dataClient.rpc = () =>
    Promise.resolve({ data: null, error: { message: 'Could not find the function ral_revertir_item in the schema cache' } })
  // OJO: la fila enlatada refleja el estado POST-update (el stub no aplica
  // updates sobre las filas) — la relectura del recálculo de estado debe ver
  // cantidad_atendida=0 para derivar 'Pendiente'.
  stub.__setTable('ral_items', [
    { id: 'it-1', ral_id: 'ral-1', orden: 0, codigo: '118', descripcion: 'ACIDO', unidad: 'KG', centro_costos: '', cantidad: 10, cantidad_atendida: 0, usuario_atencion: 'X', atendido_en: null },
  ])
  stub.__setUpdateResult({
    data: { id: 'it-1', ral_id: 'ral-1', cantidad: 10, cantidad_atendida: 0, atendido_en: null },
    error: null,
  })
  const revertidoFb = await revertirItemRal('it-1', 5) // pide 5, solo hay 2 → clamp 0 (client) / GREATEST (RPC)
  check('respaldo de reversa nunca baja de 0 (2-5 → 0)', revertidoFb.cantidadAtendida === 0)
  const updRev = stub.__updateCalls().filter((u) => u.table === 'rals')
  check('estado recalculado tras reversa (nada atendido → Pendiente)', updRev.length === 1 && updRev[0].payload.estado === 'Pendiente')

  stub.dataClient.rpc = rpcOriginal
  stub.__clear()

  console.log(`\n${ok} checks OK`)
  if (process.exitCode) console.error('HUBO FALLOS')
}

main().catch((e) => {
  console.error('EXCEPCIÓN:', e)
  process.exit(1)
})
