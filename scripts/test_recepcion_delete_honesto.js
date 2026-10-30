/**
 * RACKLY — Honestidad de los BORRADOS de Recepción/Atención (bug T173-00004281).
 *
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB)
 *
 * BUG REAL (2026-10-30): la política RLS de recepcion_registros solo permite
 * DELETE a supervisores+; un operario que borraba un artículo en el editor y
 * guardaba recibía HTTP 200 con 0 filas borradas (RLS filtra en silencio, sin
 * error). La app creía el guardado, las filas seguían vivas y al re-agregar
 * los artículos la guía se DUPLICABA (16→23→36→50→63 filas en una mañana).
 *
 * Contrato nuevo:
 *   · guardarEdicionGuia: guard de propiedad ANTES de escribir (filas de
 *     otro usuario) + verificación del DELETE real al final.
 *   · eliminarGuia / eliminarRecepcion / eliminarAtencion: verificación del
 *     efecto real (0 filas = error controlado ELIMINAR_BLOQUEADO).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const {
  guardarEdicionGuia,
  eliminarGuia,
  eliminarRecepcion,
  eliminarAtencion,
} = require('@/lib/rackly/modulos')
const { codigoControladoDe, ERR_ELIMINAR_BLOQUEADO } = require('@/lib/rackly/errores')

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

const U_YO = '11111111-1111-4111-8111-111111111111'
const U_OTRO = '22222222-2222-4222-8222-222222222222'

const fila = (id, sobre = {}) => ({
  id,
  created_at: '2026-10-30T14:31:38.422803+00',
  transito: null,
  usuario_id: U_YO,
  ...sobre,
})

async function capturaError(fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

async function main() {
  console.log('\n[1] guardarEdicionGuia — borrado aplicado COMPLETO (dueño de la fila)')
  stub.__clear()
  stub.__setTable('recepcion_registros', [
    fila('A', { transito: {} }),
    fila('B'),
    fila('C'),
  ])
  stub.__setDeleteResult({ data: [{ id: 'C' }], error: null }) // sobre completo
  const resOk = await guardarEdicionGuia(
    ['A', 'B', 'C'],
    [
      { codigo: '56101', descripcion: 'X', cantidad: 10, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'A' },
      { codigo: '56101', descripcion: 'X', cantidad: 20, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'B' },
    ],
    { fecha: '2026-10-30', tipoDocumento: 'Guia', numeroDocumento: 'T173-00004281', empresaOrigen: 'AJEPER', proveedor: '', placa: '', estado: 'Pendiente', fotoUrl: '', guiaId: 'g1' },
    { id: U_YO, nombre: 'Edwin', correo: 'e@e.pe' },
    U_YO
  )
  check('guardado completo: 2 updates + 1 delete', resOk.actualizadas === 2 && resOk.eliminadas === 1 && resOk.insertadas === 0, JSON.stringify(resOk))

  console.log('\n[2] guardarEdicionGuia — RLS FILTRA el delete en silencio (el bug real)')
  stub.__clear()
  stub.__setTable('recepcion_registros', [fila('A'), fila('B'), fila('C')])
  stub.__setDeleteResult({ data: [], error: null }) // RLS filtró: HTTP 200, 0 filas borradas
  const errRls = await capturaError(() =>
    guardarEdicionGuia(
      ['A', 'B', 'C'],
      [
        { codigo: '56101', descripcion: 'X', cantidad: 10, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'A' },
        { codigo: '56101', descripcion: 'X', cantidad: 20, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'B' },
      ],
      { fecha: '2026-10-30', tipoDocumento: 'Guia', numeroDocumento: 'T', empresaOrigen: 'AJEPER', proveedor: '', placa: '', estado: 'Pendiente', fotoUrl: '', guiaId: 'g1' },
      { id: U_YO, nombre: 'Edwin', correo: 'e@e.pe' },
      U_YO
    )
  )
  check('lanza error controlado ELIMINAR_BLOQUEADO', codigoControladoDe(errRls) === ERR_ELIMINAR_BLOQUEADO, JSON.stringify(errRls))
  check('el mensaje es accionable (no [object Object])', errRls && errRls.message.includes('NO se completó'), errRls && errRls.message)

  console.log('\n[3] guardarEdicionGuia — filas de OTRO usuario: aborta ANTES de escribir')
  stub.__clear()
  stub.__setTable('recepcion_registros', [
    fila('A'),
    fila('B'),
    fila('C', { usuario_id: U_OTRO }), // registrada por supervisor — no borrable
  ])
  stub.__setDeleteResult({ data: [{ id: 'C' }, { id: 'C' }], error: null }) // canario
  const errAjena = await capturaError(() =>
    guardarEdicionGuia(
      ['A', 'B', 'C'],
      [
        { codigo: '56101', descripcion: 'X', cantidad: 10, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'A' },
        { codigo: '56101', descripcion: 'X', cantidad: 20, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'B' },
      ],
      { fecha: '2026-10-30', tipoDocumento: 'Guia', numeroDocumento: 'T', empresaOrigen: 'AJEPER', proveedor: '', placa: '', estado: 'Pendiente', fotoUrl: '', guiaId: 'g1' },
      { id: U_OTRO, nombre: 'Autor', correo: 'a@e.pe' },
      U_YO
    )
  )
  check('aborta con ELIMINAR_BLOQUEADO (pre-guard, no el conteo final)', codigoControladoDe(errAjena) === ERR_ELIMINAR_BLOQUEADO && errAjena.message.includes('OTRO usuario'), errAjena && errAjena.message)

  console.log('\n[4] guardarEdicionGuia — guard de Tránsito SIGUE primero')
  stub.__clear()
  stub.__setTable('recepcion_registros', [
    fila('A'),
    fila('C', { transito: { envios: [{ id: 'e1' }] } }),
  ])
  const errTransito = await capturaError(() =>
    guardarEdicionGuia(
      ['A', 'C'],
      [
        { codigo: '56101', descripcion: 'X', cantidad: 10, unidadMedida: 'KG', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '', observaciones: '', filaId: 'A' },
      ],
      { fecha: '2026-10-30', tipoDocumento: 'Guia', numeroDocumento: 'T', empresaOrigen: 'AJEPER', proveedor: '', placa: '', estado: 'Pendiente', fotoUrl: '', guiaId: 'g1' },
      { id: U_YO, nombre: 'Edwin', correo: 'e@e.pe' },
      U_YO
    )
  )
  check('fila transferida por Tránsito sigue abortando (política intacta)', errTransito && !(codigoControladoDe(errTransito) === ERR_ELIMINAR_BLOQUEADO) && errTransito.message.includes('Tránsito'), errTransito && errTransito.message)

  console.log('\n[5] eliminarGuia — borrado filtrado por RLS ya NO es éxito falso')
  stub.__clear()
  stub.__setTable('recepcion_registros', [fila('A'), fila('B')])
  stub.__setDeleteResult({ data: [], error: null })
  const errGuia = await capturaError(() => eliminarGuia({ guiaId: 'g1', tipoDocumento: 'Guia', numeroDocumento: 'T' }))
  check('guía no borrada → ELIMINAR_BLOQUEADO', codigoControladoDe(errGuia) === ERR_ELIMINAR_BLOQUEADO, JSON.stringify(errGuia))
  stub.__setDeleteResult({ data: [{ id: 'A' }, { id: 'B' }], error: null })
  await eliminarGuia({ guiaId: 'g1', tipoDocumento: 'Guia', numeroDocumento: 'T' })
  check('guía borrada completa → resuelve sin error', true)

  console.log('\n[6] eliminarRecepcion / eliminarAtencion — misma honestidad')
  stub.__clear()
  stub.__setTable('recepcion_registros', [fila('A')])
  stub.__setDeleteResult({ data: [], error: null })
  const errFila = await capturaError(() => eliminarRecepcion('A'))
  check('fila no borrada → ELIMINAR_BLOQUEADO', codigoControladoDe(errFila) === ERR_ELIMINAR_BLOQUEADO)
  stub.__setTable('atencion_registros', [{ id: 'at1' }])
  stub.__setDeleteResult({ data: [], error: null })
  const errAt = await capturaError(() => eliminarAtencion('at1'))
  check('atención no borrada → ELIMINAR_BLOQUEADO (patrón repetido, paso 3)', codigoControladoDe(errAt) === ERR_ELIMINAR_BLOQUEADO)

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
