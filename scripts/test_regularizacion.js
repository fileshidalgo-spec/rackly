/**
 * RACKLY — Regularización de filas sobrantes (T173-00004274, 2026-10-31).
 *
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB)
 *
 * CASO REAL: la guía T173-00004274 registró 172 UN del artículo 53414
 * (DIVERFLOW 156) cuando físicamente llegaron 150 → 22 UN de sobrante que
 * "flotan" en Tránsito con semáforo ROJO para siempre (nunca existieron).
 * Antes no había NINGÚN camino de regularización:
 *   · el editor de Recepción bloqueaba a TODO usuario que quitara filas
 *     ajenas (guard ciego al rol — incluso admin con recepcion.eliminar);
 *   · Tránsito solo añade envíos: la fila fantasma jamás se resolvía.
 *
 * Contrato probado aquí:
 *   · transito-core.regularizable(): SOLO filas 100 % sin transferir
 *     (enviados = 0 y pendiente > 0) son regularizables — con CUALQUIER
 *     envío el stock ya vive en Racks/Piso y la fila no se toca.
 *   · transito.regularizarFila(): llama a la RPC recepcion_regularizar_fila
 *     con (p_fila_id, p_motivo) y propaga el snapshot; los errores "CODE|…"
 *     de la RPC se propagan tal cual (fuente de verdad en BD).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { regularizable, estadoSem } = require('@/lib/rackly/transito-core')
const { regularizarFila } = require('@/lib/rackly/transito')

let pasados = 0
let fallidos = 0
function check(nombre, cond, detalle = '') {
  if (cond) {
    pasados++
    console.log(`  ✓ ${nombre}`)
  } else {
    fallidos++
    console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
  }
}

const envio = (cantidad, extra = {}) => ({
  uuid: 'u' + Math.random().toString(36).slice(2, 8),
  fecha: '2026-10-31 10:00',
  destino: 'piso',
  ubicacion: 'QUIMICOS·A·A1·Pos4·N1',
  cantidad,
  usuario_id: null,
  usuario_nombre: 'Walter',
  turno: 'DÍA',
  ...extra,
})

async function main() {
  console.log('\n[1] regularizable — la fila fantasma del caso real (22 UN, 0 envíos)')
  check('22 UN sin envíos → regularizable', regularizable({ cantidad: 22, envios: [] }) === true)

  console.log('\n[2] regularizable — con CUALQUIER envío ya NO es regularizable')
  check('32 UN con 1 envío de 32 (VERDE) → NO', regularizable({ cantidad: 32, envios: [envio(32)] }) === false)
  check('54 UN con envío parcial de 22 (AMAR) → NO', regularizable({ cantidad: 54, envios: [envio(22)] }) === false)
  const parcial = estadoSem({ cantidad: 54, envios: [envio(22)] })
  check('coherencia con el semáforo: AMAR = enviados>0', parcial.estado === 'AMAR' && parcial.enviados === 22 && parcial.pendiente === 32)

  console.log('\n[3] regularizable — bordes numéricos (EPS 0.0005)')
  check('pendiente 0.0004 (residuo binario) → NO', regularizable({ cantidad: 22.0004, envios: [envio(22)] }) === false)
  check('cantidad 0 sin envíos → NO (nada que regularizar)', regularizable({ cantidad: 0, envios: [] }) === false)
  check('cantidad negativa → NO', regularizable({ cantidad: -5, envios: [] }) === false)

  console.log('\n[4] regularizable — reversas de atención NO habilitan la fila')
  // reversa_atencion devuelve el pendiente pero deja enviados != 0 en el
  // cálculo… la reversa compensa con cantidad NEGATIVA en ruta tránsito:
  // enviados vuelve a 0 → si quedó pendiente, vuelve a ser regularizable.
  check(
    'toma atendida + reversa (enviados neto 0) → regularizable de nuevo',
    regularizable({ cantidad: 22, envios: [envio(-22, { destino: 'reversa_atencion' })] }) === true
  )

  console.log('\n[5] regularizarFila — delega en la RPC con (p_fila_id, p_motivo) y devuelve el snapshot')
  stub.__clear()
  const snapshot = {
    ok: true,
    accion: 'regularizacion',
    fila: {
      id: 'd6d01142-0000-0000-0000-000000000000',
      guia_id: 'g1',
      tipo_documento: 'Guia-T173',
      numero_documento: '00004274',
      fecha: '2026-10-29',
      codigo: '53414',
      descripcion: 'DIVERFLOW 156 (ENVASE X 28 KG.)',
      cantidad: 22,
      unidad_medida: 'UN',
      lote: '20930276',
      n_paleta: 2,
      owner_nombre: 'Elvis Reynaldo Valdivia',
    },
    regularizado_por: 'Miguel Hidalgo',
    motivo: 'Sobrante: colocaron 54, llegaron 32',
    fecha: '2026-10-31 09:30',
  }
  stub.__setRpcResult('recepcion_regularizar_fila', { data: snapshot, error: null })
  const res = await regularizarFila({ recepcionId: snapshot.fila.id, motivo: snapshot.motivo })
  const llamadas = stub.__rpcCalls().filter((c) => c.name === 'recepcion_regularizar_fila')
  check('RPC llamada exactamente 1 vez', llamadas.length === 1, JSON.stringify(stub.__rpcCalls()))
  check(
    'argumentos exactos (p_fila_id + p_motivo)',
    llamadas[0] && llamadas[0].args.p_fila_id === snapshot.fila.id && llamadas[0].args.p_motivo === snapshot.motivo,
    JSON.stringify(llamadas[0])
  )
  check('devuelve el snapshot de auditoría completo', res.ok === true && res.fila && res.fila.codigo === '53414' && res.fila.cantidad === 22, JSON.stringify(res))
  check('regularizado_por presente (trazabilidad)', res.regularizado_por === 'Miguel Hidalgo')

  console.log('\n[6] regularizarFila — los errores "CODE|…" de la RPC se propagan tal cual')
  stub.__clear()
  stub.__setRpcResult('recepcion_regularizar_fila', { data: null, error: { message: 'PERMISO|No tienes el permiso "Eliminar guías"', code: 'P0001' } })
  let errRpc = null
  try {
    await regularizarFila({ recepcionId: 'x' })
  } catch (e) {
    errRpc = e
  }
  check('error propagado (la UI lo muestra con mensajeRpcError)', !!errRpc && String(errRpc.message).startsWith('PERMISO|'), errRpc && errRpc.message)

  stub.__clear()
  stub.__setRpcResult('recepcion_regularizar_fila', { data: null, error: { message: 'CON_ENVIOS|Esta fila ya tiene 1 envío(s) de Tránsito', code: 'P0001' } })
  let errEnv = null
  try {
    await regularizarFila({ recepcionId: 'y' })
  } catch (e) {
    errEnv = e
  }
  check('fila CON envíos → rechazada por la BD (política intacta)', !!errEnv && String(errEnv.message).startsWith('CON_ENVIOS|'), errEnv && errEnv.message)

  console.log('\n[7] regularizarFila — id vacío falla en cliente (sin tocar BD)')
  stub.__clear()
  let errVacio = null
  try {
    await regularizarFila({ recepcionId: '   ' })
  } catch (e) {
    errVacio = e
  }
  check('id en blanco → error temprano', !!errVacio && String(errVacio.message).startsWith('FILA_REQUERIDA|'), errVacio && errVacio.message)
  check('y NO se llamó a la RPC', stub.__rpcCalls().length === 0, JSON.stringify(stub.__rpcCalls()))

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
