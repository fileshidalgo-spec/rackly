/**
 * RACKLY · Tests REPUESTOS — Recepción SIN destino + Tránsito que UBICA.
 *
 * Usa el STUB de Supabase: verifica que
 *   1) repRegistrarRecepcion llama a rep_registrar_recepcion con el
 *      documento (guía/OC/DAM), las líneas (artículo/cantidad/proveedor)
 *      y el uuid_sync del lote — y mapea recepcion_id/linea_ids/duplicado.
 *   2) repUbicarDesdeTransito llama a rep_ubicar_desde_transito con la
 *      línea y la lonchera — y mapea ubicación/lado/aviso otra lonchera.
 *   3) repLineasEnTransito / repListarRecepciones leen con el filtro de
 *      estado correcto y aplanan el documento embebido.
 *   4) Los errores controlados de BD (LONCHERA_LLENA, LINEA_YA_UBICADA,
 *      NO_AUTORIZADO…) llegan legibles al operario vía mensajeError.
 *
 * NO toca red: todo enlatado en el stub.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const {
  repRegistrarRecepcion,
  repUbicarDesdeTransito,
  repLineasEnTransito,
  repListarRecepciones,
  repLineasPorGuia,
} = require('@/lib/rackly/rep/rep-client')
const { mensajeError } = require('@/lib/rackly/errores')

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

const ART1 = '11111111-1111-4111-8111-111111111111'
const ART2 = '22222222-2222-4222-8222-222222222222'
const LON = '33333333-3333-4333-8333-333333333333'

async function main() {
  // ── [1] Guardar recepción: documento completo en 1 RPC ──
  console.log('\n[1] repRegistrarRecepcion — documento atómico')
  stub.__clear()
  stub.__setRpcResult('rep_registrar_recepcion', {
    data: {
      ok: true,
      duplicado: false,
      recepcion_id: 'rec-1',
      linea_ids: ['lin-1', 'lin-2'],
    },
    error: null,
  })
  const res = await repRegistrarRecepcion({
    guia: 'GR-777',
    oc: 'OC-1',
    dam: 'DAM-9',
    lineas: [
      { articuloId: ART1, cantidad: 4, proveedor: 'ACME' },
      { articuloId: ART2, cantidad: 2.5, proveedor: 'OTRO' },
    ],
    uuidSync: 'lote-abc',
  })
  const calls = stub.__rpcCalls().filter((c) => c.name === 'rep_registrar_recepcion')
  check('1 llamada a rep_registrar_recepcion', calls.length === 1)
  check('p_guia = "GR-777"', calls[0].args.p_guia === 'GR-777')
  check('p_oc y p_dam viajan', calls[0].args.p_oc === 'OC-1' && calls[0].args.p_dam === 'DAM-9')
  check('p_uuid_sync del lote', calls[0].args.p_uuid_sync === 'lote-abc')
  check('2 líneas al RPC', Array.isArray(calls[0].args.p_lineas) && calls[0].args.p_lineas.length === 2)
  check('línea[0] = artículo/cantidad/proveedor', calls[0].args.p_lineas[0].articulo_id === ART1 && calls[0].args.p_lineas[0].cantidad === 4 && calls[0].args.p_lineas[0].proveedor === 'ACME')
  check('respuesta mapeada: recepcionId + 2 linea_ids', res.recepcionId === 'rec-1' && res.lineaIds.length === 2)
  check('no duplicado', res.duplicado === false)

  // ── [2] Idempotencia: reintento devuelve el documento previo ──
  console.log('\n[2] Reintento del mismo lote → duplicado honesto')
  stub.__clear()
  stub.__setRpcResult('rep_registrar_recepcion', {
    data: { ok: true, duplicado: true, recepcion_id: 'rec-1', linea_ids: ['lin-1', 'lin-2'] },
    error: null,
  })
  const res2 = await repRegistrarRecepcion({
    guia: 'GR-777', oc: 'OC-1', dam: 'DAM-9',
    lineas: [{ articuloId: ART1, cantidad: 4, proveedor: 'ACME' }],
    uuidSync: 'lote-abc',
  })
  check('marca duplicado=true', res2.duplicado === true)
  check('mismos ids del documento previo', res2.recepcionId === 'rec-1' && res2.lineaIds.length === 2)

  // ── [3] Ubicar desde Tránsito ──
  console.log('\n[3] repUbicarDesdeTransito — stock+kardex en 1 RPC')
  stub.__clear()
  stub.__setRpcResult('rep_ubicar_desde_transito', {
    data: {
      ok: true,
      movimiento_id: 'mov-1',
      ubicacion: 'R-P1-N1-P01',
      lado: 'B',
      en_otra_lonchera: { lado: 'A', ubicacion: 'R-P1-N2-P05' },
    },
    error: null,
  })
  const r3 = await repUbicarDesdeTransito({ lineaId: 'lin-1', loncheraId: LON })
  const c3 = stub.__rpcCalls().filter((c) => c.name === 'rep_ubicar_desde_transito')
  check('1 llamada a rep_ubicar_desde_transito', c3.length === 1)
  check('p_linea_id correcto', c3[0].args.p_linea_id === 'lin-1')
  check('p_lonchera_id correcto', c3[0].args.p_lonchera_id === LON)
  check('respuesta mapeada: ubicación + lado', r3.ubicacion === 'R-P1-N1-P01' && r3.lado === 'B')
  check('aviso otra lonchera presente', r3.enOtraLonchera?.ubicacion === 'R-P1-N2-P05')

  // ── [4] Errores controlados de BD: legibles para el operario ──
  console.log('\n[4] Errores controlados (CODE|detalle → solo detalle)')
  const CASOS = [
    ['rep_registrar_recepcion', 'GUIA_REQUERIDA|Ingresa el N° de Guía', 'N° de Guía'],
    ['rep_registrar_recepcion', 'LINEAS_REQUERIDAS|Agrega al menos un artículo a la guía', 'al menos un artículo'],
    ['rep_ubicar_desde_transito', 'LONCHERA_LLENA|La lonchera R-P1-N1-P01 ya tiene 15 artículos distintos', 'ya tiene 15 artículos'],
    ['rep_ubicar_desde_transito', 'LINEA_YA_UBICADA|BJ-109-003 ya fue ubicado a su lonchera', 'ya fue ubicado'],
    ['rep_ubicar_desde_transito', 'NO_AUTORIZADO|No tienes permiso para ubicar artículos en Repuestos', 'No tienes permiso'],
  ]
  for (const [rpc, raw, esperado] of CASOS) {
    stub.__clear()
    stub.__setRpcResult(rpc, { data: null, error: { message: raw } })
    let msg = ''
    try {
      if (rpc === 'rep_registrar_recepcion') {
        await repRegistrarRecepcion({ guia: 'G', oc: '', dam: '', lineas: [{ articuloId: ART1, cantidad: 1, proveedor: '' }], uuidSync: 'u1' })
      } else {
        await repUbicarDesdeTransito({ lineaId: 'lin-1', loncheraId: LON })
      }
    } catch (e) {
      msg = mensajeError(e)
    }
    check(`"${raw.split('|')[0]}" → detalle legible`, msg.includes(esperado), `mensaje="${msg}"`)
    check(`"${raw.split('|')[0]}" no filtra código al usuario`, !msg.startsWith(raw.split('|')[0]))
  }

  // ── [5] Lecturas: en tránsito + recepciones + por guía ──
  console.log('\n[5] Listados (embeds aplanados)')
  stub.__clear()
  stub.__setTable('rep_recepcion_lineas', [
    {
      id: 'lin-1', created_at: '2026-11-11T10:00:00Z', recepcion_id: 'rec-1', articulo_id: ART1,
      codigo: 'BJ-109-003', descripcion: 'Filtro de aire', und: 'UND', cantidad: 4, proveedor: 'ACME',
      estado: 'en_transito', lonchera_id: null, ubicacion_id: null, movimiento_id: null,
      recepcion: { guia: 'GR-777', oc: 'OC-1', dam: 'DAM-9', created_at: '2026-11-11T09:59:00Z' },
    },
    {
      id: 'lin-2', created_at: '2026-11-11T10:00:00Z', recepcion_id: 'rec-1', articulo_id: ART2,
      codigo: 'ZZ-001', descripcion: 'Aceite', und: 'GLN', cantidad: 2.5, proveedor: 'OTRO',
      estado: 'ubicado', lonchera_id: LON, ubicacion_id: 'ubi-1', movimiento_id: 'mov-1',
      recepcion: { guia: 'GR-777', oc: 'OC-1', dam: 'DAM-9', created_at: '2026-11-11T09:59:00Z' },
    },
  ])
  const pend = await repLineasEnTransito()
  // El stub devuelve TODAS las filas enlatadas (no aplica .eq): el filtro
  // real es server-side y se verifica con la captura de eqCalls de abajo.
  check('mapea cada fila y respeta el estado de la fila', pend.length === 2 && pend[0].estado === 'en_transito' && pend[1].estado === 'ubicado')
  check('aplanó el documento embebido', pend[0].guia === 'GR-777' && pend[0].oc === 'OC-1' && pend[0].dam === 'DAM-9')
  const eqEstado = stub.__eqCalls().filter((c) => c.table === 'rep_recepcion_lineas' && c.col === 'estado').map((c) => c.val)
  check('consulta con eq estado=en_transito', eqEstado.includes('en_transito'), JSON.stringify(eqEstado))

  stub.__clear()
  stub.__setTable('rep_recepciones', [
    {
      id: 'rec-1', created_at: '2026-11-11T09:59:00Z', guia: 'GR-777', oc: 'OC-1', dam: 'DAM-9',
      usuario_nombre: 'Miguel',
      lineas: [
        { estado: 'en_transito', proveedor: 'ACME' },
        { estado: 'ubicado', proveedor: 'ACME' },
        { estado: 'en_transito', proveedor: 'OTRO' },
      ],
    },
  ])
  const recs = await repListarRecepciones()
  check('recepción con 3 líneas', recs.length === 1 && recs[0].totalLineas === 3)
  check('pendientes = 2 (en_transito)', recs[0].pendientes === 2)
  check('proveedores únicos = [ACME, OTRO]', recs[0].proveedores.join(',') === 'ACME,OTRO')

  stub.__clear()
  stub.__setTable('rep_recepcion_lineas', [
    { id: 'lin-1', created_at: '2026-11-11T10:00:00Z', codigo: 'BJ-109-003', descripcion: 'Filtro', und: 'UND', cantidad: 4, recepcion: { guia: 'GR-777' } },
    { id: 'lin-2', created_at: '2026-11-11T10:00:01Z', codigo: 'ZZ-001', descripcion: 'Aceite', und: 'GLN', cantidad: 2.5, recepcion: [{ guia: 'GR-777' }] },
  ])
  const filas = await repLineasPorGuia('GR-777')
  check('por guía: 2 filas con SU uuid', filas.length === 2 && filas[0].id === 'lin-1' && filas[1].id === 'lin-2')
  check('por guía: documento aplanado (embed objeto y array)', filas[0].guia === 'GR-777' && filas[1].guia === 'GR-777')
  const eqGuia = stub.__eqCalls().find((c) => c.table === 'rep_recepcion_lineas' && c.col === 'recepcion.guia')
  check('consulta filtra por la guía exacta', eqGuia?.val === 'GR-777')

  // ── Resumen ──
  console.log(`\n════════ RESULTADO: ${ok} pasados ════════`)
  if (process.exitCode !== 1) console.log('OK test_rep_transito_ubicar')
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
