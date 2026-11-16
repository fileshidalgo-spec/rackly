/**
 * RACKLY · Tests REPUESTOS — TRÁNSITO con QR (paridad Insumos, 2026-11-16).
 *
 * Usa el STUB de Supabase: verifica
 *   1) CONTRATO QR: lineasARotulosRep da recepcionId = uuid de LÍNEA →
 *      construirPayloadQR → parsearPayloadQR resuelve ESA identidad (la
 *      ruta exacta 1:1 del escaneo).
 *   2) repLineaPorId: consulta por id (eq capturado), mapea el documento
 *      embebido (guia/oc/dam/fechaRecepcion) y devuelve null si no existe.
 *   3) repLineasPorGuiaNumero: guía vacía → [] SIN consultar; con guía →
 *      filta por recepcion.guia y mapea; acepta embed objeto y array.
 *   4) esErrorRpc: PostgrestError plano, Error nativo, string, objeto con
 *      msg, código distinto, código vacío — branching del diálogo.
 *   5) repUbicarDesdeTransito con LINEA_YA_UBICADA → el error es reconocible
 *      por esErrorRpc y mensajeError lo deja legible (reintento del diálogo).
 *
 * NO toca red: todo enlatado en el stub.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const {
  repLineaPorId,
  repLineasPorGuiaNumero,
  repUbicarDesdeTransito,
} = require('@/lib/rackly/rep/rep-client')
const { construirPayloadQR, parsearPayloadQR } = require('@/lib/rackly/qr-rotulo')
const { lineasARotulosRep } = require('@/lib/rackly/rep/recepcion-guia')
const { esErrorRpc, mensajeError, codigoControladoDe } = require('@/lib/rackly/errores')

let ok = 0
function check(nombre, cond, detalle = '') {
  if (cond) {
    ok++
    console.log(`  ✓ ${nombre}`)
  } else {
    console.error(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
    process.exitCode = 1
  }
}

const LINEA = 'aaaa1111-0000-4000-8000-000000000001'
const REC = 'bbbb2222-0000-4000-8000-000000000002'

/** Fila cruda como la devuelve PostgREST (embed de recepción). */
function fila(embed) {
  return {
    id: LINEA,
    created_at: '2026-11-16T10:00:00+00:00',
    recepcion_id: REC,
    articulo_id: 'art-1',
    codigo: '62005',
    descripcion: 'PANEL DE VIDRIO',
    und: 'UND',
    cantidad: 3,
    proveedor: 'SIGELEC',
    estado: 'en_transito',
    lonchera_id: null,
    ubicacion_id: null,
    movimiento_id: null,
    recepcion: embed,
  }
}

async function main() {
  // ── [1] Contrato QR: rótulo REP → payload → parseo exacto ──
  console.log('\n[1] Contrato QR del rótulo REP (uuid de LÍNEA)')
  const rotulos = lineasARotulosRep(
    [{ codigo: '62005', descripcion: 'PANEL DE VIDRIO', cantidad: 3, und: 'UND' }],
    [LINEA],
    'T001-125411'
  )
  check('recepcionId del rótulo = uuid de la línea', rotulos[0].recepcionId === LINEA)
  const payload = construirPayloadQR({
    identidad: rotulos[0].recepcionId ?? '',
    numeroDocumento: 'T001-125411',
    codigo: rotulos[0].codigo,
  })
  const p = parsearPayloadQR(payload)
  check('payload parsea', p !== null)
  check('identidad = uuid de la LÍNEA', p?.identidad === LINEA, p?.identidad)
  check('numeroDocumento = guía', p?.numeroDocumento === 'T001-125411')
  check('código del artículo', p?.codigo === '62005')

  // ── [2] repLineaPorId: ruta EXACTA del escaneo ──
  console.log('\n[2] repLineaPorId — consulta por uuid de línea')
  stub.__clear()
  stub.__setTable('rep_recepcion_lineas', [fila({ guia: 'T001-125411', oc: '12487', dam: '', created_at: '2026-11-16T09:00:00+00:00' })])
  const linea = await repLineaPorId(LINEA)
  check('resuelve la línea', linea !== null && linea.id === LINEA)
  check('documento embebido: guía', linea?.guia === 'T001-125411')
  check('documento embebido: OC', linea?.oc === '12487')
  check('fechaRecepcion de la cabecera', linea?.fechaRecepcion === '2026-11-16T09:00:00+00:00')
  check('cantidad numérica', linea?.cantidad === 3)
  const eqLinea = stub.__eqCalls().find((c) => c.table === 'rep_recepcion_lineas' && c.col === 'id')
  check('filtra por id = uuid del rótulo', eqLinea?.val === LINEA)
  stub.__setTable('rep_recepcion_lineas', [])
  const fantasma = await repLineaPorId(LINEA)
  check('línea inexistente → null (rótulo ajeno a Repuestos)', fantasma === null)

  // ── [3] repLineasPorGuiaNumero: fallback por Nº de guía ──
  console.log('\n[3] repLineasPorGuiaNumero — rótulos residuales')
  stub.__clear()
  const vacio = await repLineasPorGuiaNumero('   ')
  check('guía vacía → [] sin consultar', Array.isArray(vacio) && vacio.length === 0 && stub.__eqCalls().length === 0)
  stub.__setTable('rep_recepcion_lineas', [
    fila({ guia: 'T001-125411', oc: '12487', dam: '', created_at: '2026-11-16T09:00:00+00:00' }),
    { ...fila({ guia: 'T001-125411', oc: '12487', dam: '', created_at: '2026-11-16T09:00:00+00:00' }), id: 'lin-2', codigo: '62006' },
  ])
  const porGuia = await repLineasPorGuiaNumero('T001-125411')
  check('2 líneas de la guía', porGuia.length === 2)
  const eqGuia = stub.__eqCalls().find((c) => c.table === 'rep_recepcion_lineas' && c.col === 'recepcion.guia')
  check('filtra por recepcion.guia = Nº limpio', eqGuia?.val === 'T001-125411')
  stub.__setTable('rep_recepcion_lineas', [
    // Embed como ARRAY (forma relativa de PostgREST en algunos clientes)
    fila([{ guia: 'T001-125411', oc: '12487', dam: '', created_at: '2026-11-16T09:00:00+00:00' }]),
  ])
  const conArray = await repLineasPorGuiaNumero('T001-125411')
  check('embed en ARRAY también mapea', conArray.length === 1 && conArray[0].guia === 'T001-125411')

  // ── [4] esErrorRpc — branching del diálogo ──
  console.log('\n[4] esErrorRpc — convención «CODE|detalle»')
  check('PostgrestError plano', esErrorRpc({ message: 'LINEA_YA_UBICADA|62005 ya fue ubicado a su lonchera' }, 'LINEA_YA_UBICADA'))
  check('Error nativo', esErrorRpc(new Error('LONCHERA_LLENA|La lonchera ya tiene 15 artículos distintos'), 'LONCHERA_LLENA'))
  check('String plano', esErrorRpc('NO_AUTORIZADO|sin permiso', 'NO_AUTORIZADO'))
  check('objeto con msg', esErrorRpc({ msg: 'DATO_REQUERIDO|falta la línea' }, 'DATO_REQUERIDO'))
  check('código distinto → false', !esErrorRpc({ message: 'LINEA_YA_UBICADA|x' }, 'LONCHERA_LLENA'))
  check('código vacío → false', !esErrorRpc({ message: 'LINEA_YA_UBICADA|x' }, ''))
  check('null/undefined → false', !esErrorRpc(null, 'LINEA_YA_UBICADA') && !esErrorRpc(undefined, 'X'))

  // ── [5] repUbicarDesdeTransito: error controlado reconocible ──
  console.log('\n[5] repUbicarDesdeTransito — LINEA_YA_UBICADA (reintento del diálogo)')
  stub.__clear()
  stub.__setRpcResult('rep_ubicar_desde_transito', {
    data: null,
    error: { message: 'LINEA_YA_UBICADA|62005 ya fue ubicado a su lonchera', details: null, hint: null, code: 'P0001' },
  })
  let capturado = null
  try {
    await repUbicarDesdeTransito({ lineaId: LINEA, loncheraId: 'lon-1' })
  } catch (e) {
    capturado = e
  }
  check('lanza el error de BD', capturado !== null)
  check('código en Error.name (errorControlado)', codigoControladoDe(capturado) === 'LINEA_YA_UBICADA', String(capturado))
  check('esErrorRpc lo reconoce (rama "Ya estaba ubicado")', esErrorRpc(capturado, 'LINEA_YA_UBICADA'))
  check('mensajeError lo deja legible', mensajeError(capturado) === '62005 ya fue ubicado a su lonchera', mensajeError(capturado))

  console.log(`\nRESULTADO: ${ok} checks OK`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exitCode = 1
})
