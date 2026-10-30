/**
 * RACKLY — Tests: DEVOLUCIONES DE LÍNEA en Recepción (trace 1a18f196e42d8cc1).
 *
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB — no toca red).
 *
 * Escenarios:
 *   1. crearRecepciones con tipoRecepcion='devolucion' → las filas llevan
 *      tipo_recepcion='devolucion' (pestaña de devoluciones).
 *   2. crearRecepciones default → 'guia' (compatibilidad total).
 *   3. listarRecepciones filtra por tipo_recepcion según la pestaña.
 *   4. hayDuplicadosRecientes y el anti-guía-duplicada se DELIMITAN a la
 *      misma pestaña (una devolución Nº X y una guía Nº X no se avisan).
 *   5. guardarEdicionGuia: las filas NUEVAS de una devolución heredan
 *      tipo_recepcion='devolucion' (C1 — sin esto nacían 'guia').
 *   6. agruparGuias propaga tipoRecepcion al encabezado (edición/banner).
 *   7. Tránsito: mapArticuloTransito + agruparEnGuias marcan la devolución
 *      (esDevolucion → badge del operario).
 *   8. OCR de la REQUISICIÓN DE DEVOLUCIÓN (formato real AJEPER, foto
 *      2026-10-30, Nº 0000192967): nº, empresa, OP/solicitante y las 2
 *      filas de la tabla con sus cantidades de 4 decimales.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { crearRecepciones, listarRecepciones, guardarEdicionGuia } = require('@/lib/rackly/modulos')
const { agruparGuias } = require('@/lib/rackly/recepcion-filas')
const { mapArticuloTransito, agruparEnGuias } = require('@/lib/rackly/transito-core')
const { extraerDatosGuiaDeTextos } = require('@/lib/rackly/guia-ocr')

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

const USUARIO = { id: 'u1', nombre: 'Walter', correo: 'w@x.com' }

function filaNueva(overrides = {}) {
  return {
    fecha: '2026-10-31',
    tipoDocumento: 'Requisición de devolución',
    numeroDocumento: '0000192967',
    empresaOrigen: 'AJEPER S.A.',
    proveedor: 'AJEPER S.A.',
    codigo: '5553',
    descripcion: 'PURE DE DURAZNO 30-32 °BRIX',
    cantidad: 15040,
    unidadMedida: 'KG',
    lote: 'L1',
    observaciones: '',
    ...overrides,
  }
}

async function main() {
  // ─── 1. Alta en la pestaña DEVOLUCIONES ───
  console.log('\n── 1. crearRecepciones escribe tipo_recepcion ──')
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await crearRecepciones([filaNueva()], USUARIO, { tipoRecepcion: 'devolucion' })
  let inserts = stub.__insertCalls().filter((c) => c.table === 'recepcion_registros')
  let payload = Array.isArray(inserts[0]?.payload) ? inserts[0].payload[0] : inserts[0]?.payload
  check('devolucion → tipo_recepcion=devolucion', payload?.tipo_recepcion === 'devolucion', JSON.stringify(payload?.tipo_recepcion))
  check('guia_id compartido por las filas', Boolean(payload?.guia_id))
  check('uuid_sync presente (idempotencia M-1)', Boolean(payload?.uuid_sync))

  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await crearRecepciones([filaNueva({ tipoDocumento: 'Guia', numeroDocumento: 'T005-0000001' })], USUARIO)
  inserts = stub.__insertCalls().filter((c) => c.table === 'recepcion_registros')
  payload = Array.isArray(inserts[0]?.payload) ? inserts[0].payload[0] : inserts[0]?.payload
  check('default (sin opciones) → tipo_recepcion=guia', payload?.tipo_recepcion === 'guia', JSON.stringify(payload?.tipo_recepcion))

  // ─── 2. Listado POR PESTAÑA ───
  console.log('\n── 2. listarRecepciones filtra tipo_recepcion ──')
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await listarRecepciones({ tipoRecepcion: 'devolucion' })
  const eqsDevo = stub.__eqCalls().filter((e) => e.table === 'recepcion_registros' && e.col === 'tipo_recepcion')
  check('pestaña devoluciones → eq tipo_recepcion=devolucion', eqsDevo.some((e) => e.val === 'devolucion'))
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await listarRecepciones({ tipoRecepcion: 'guia' })
  const eqsGuia = stub.__eqCalls().filter((e) => e.table === 'recepcion_registros' && e.col === 'tipo_recepcion')
  check('pestaña guías → eq tipo_recepcion=guia', eqsGuia.some((e) => e.val === 'guia'))
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await listarRecepciones({})
  check('sin filtro (compatibilidad) → sin eq tipo_recepcion', !stub.__eqCalls().some((e) => e.col === 'tipo_recepcion'))

  // ─── 3. Anti-duplicados DELIMITADOS a la pestaña ───
  console.log('\n── 3. hayDuplicadosRecientes por pestaña ──')
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await crearRecepciones([filaNueva()], USUARIO, { tipoRecepcion: 'devolucion' })
  const eqsDup = stub
    .__eqCalls()
    .filter((e) => e.col === 'tipo_recepcion' && e.table === 'recepcion_registros')
  check('anti-duplicado delimitado a devolucion', eqsDup.some((e) => e.val === 'devolucion'), JSON.stringify(eqsDup))

  // ─── 4. EDICIÓN: filas nuevas heredan el tipo del documento (C1) ───
  console.log('\n── 4. guardarEdicionGuia hereda tipo_recepcion ──')
  stub.__clear()
  stub.__setTable('recepcion_registros', [
    { id: 'fila-vieja', usuario_id: 'u1', transito: null },
  ])
  await guardarEdicionGuia(
    ['fila-vieja'],
    [
      {
        codigo: '30233',
        descripcion: 'PULPA DE DURAZNO HUAYCO ROJO 20°BRIX',
        cantidad: 3456,
        unidadMedida: 'KG',
        lote: '',
        fechaProduccion: '',
        fechaVencimiento: '',
        proveedor: '',
        observaciones: '',
        filaId: 'fila-vieja',
      },
      {
        codigo: '5553',
        descripcion: 'PURE DE DURAZNO 30-32 °BRIX',
        cantidad: 15040,
        unidadMedida: 'KG',
        lote: '',
        fechaProduccion: '',
        fechaVencimiento: '',
        proveedor: '',
        observaciones: '',
        filaId: null,
        uuidSync: 'uuid-nueva-fila',
      },
    ],
    {
      fecha: '2026-10-31',
      tipoDocumento: 'Requisición de devolución',
      numeroDocumento: '0000192967',
      empresaOrigen: 'AJEPER S.A.',
      proveedor: '',
      placa: '',
      estado: 'Pendiente',
      fotoUrl: '',
      guiaId: 'gggggggg-1111-4111-8111-111111111111',
      tipoRecepcion: 'devolucion',
    },
    USUARIO,
    'u1'
  )
  inserts = stub.__insertCalls().filter((c) => c.table === 'recepcion_registros')
  payload = Array.isArray(inserts[0]?.payload) ? inserts[0].payload[0] : inserts[0]?.payload
  check('fila NUEVA de devolución editada → devolucion', payload?.tipo_recepcion === 'devolucion', JSON.stringify(payload?.tipo_recepcion))
  check('fila nueva hereda la identidad de la guía (M-2)', payload?.guia_id === 'gggggggg-1111-4111-8111-111111111111')

  // ─── 5. agruparGuias propaga tipoRecepcion ───
  console.log('\n── 5. agruparGuias propaga la pestaña ──')
  const filaBase = {
    id: 'f1',
    createdAt: '2026-10-31T12:00:00Z',
    guiaId: 'gggggggg-2222-4222-8222-222222222222',
    fecha: '2026-10-31',
    tipoDocumento: 'Requisición de devolución',
    numeroDocumento: '0000192967',
    empresaOrigen: 'AJEPER S.A.',
    proveedor: 'AJEPER S.A.',
    placa: '',
    fotoUrl: '',
    estado: 'Pendiente',
    usuarioId: 'u1',
    usuarioNombre: 'Walter',
    usuarioCorreo: 'w@x.com',
    codigo: '5553',
    descripcion: 'PURE DE DURAZNO',
    cantidad: 15040,
    unidadMedida: 'KG',
    lote: '',
    fechaProduccion: '',
    fechaVencimiento: '',
    observaciones: '',
    enviosTransito: 0,
    tipoRecepcion: 'devolucion',
  }
  const grupos = agruparGuias([filaBase])
  check('GuiaAgrupada.tipoRecepcion=devolucion', grupos[0]?.tipoRecepcion === 'devolucion', JSON.stringify(grupos[0]?.tipoRecepcion))

  // ─── 6. TRÁNSITO: la devolución entra marcada ───
  console.log('\n── 6. Tránsito marca esDevolucion ──')
  // mapArticuloTransito come la fila CRUDA de la BD (snake_case).
  const crudaDevo = {
    ...filaBase,
    tipo_recepcion: 'devolucion',
    transito: null,
    fecha_vencimiento: null,
    fecha_produccion: null,
  }
  delete crudaDevo.tipoRecepcion
  const art = mapArticuloTransito(crudaDevo)
  check('mapArticuloTransito.tipoRecepcion=devolucion', art.tipoRecepcion === 'devolucion', art.tipoRecepcion)
  const guiasT = agruparEnGuias([art])
  check('agruparEnGuias → esDevolucion=true (badge)', guiasT[0]?.esDevolucion === true)
  const crudaGuia = { ...crudaDevo, tipo_recepcion: 'guia' }
  const guiaNormal = agruparEnGuias([mapArticuloTransito(crudaGuia)])
  check('guía normal → esDevolucion=false', guiaNormal[0]?.esDevolucion === false)
  const crudaLegacy = { ...crudaDevo }
  delete crudaLegacy.tipo_recepcion
  const legacy = mapArticuloTransito(crudaLegacy)
  check('fila legacy sin columna → tipoRecepcion=guia', legacy.tipoRecepcion === 'guia', legacy.tipoRecepcion)

  // ─── 7. OCR de la REQUISICIÓN DE DEVOLUCIÓN (formato real) ───
  console.log('\n── 7. OCR requisición de devolución (AJEPER) ──')
  const TEXTO_REQ = `+C1
AJEPER S.A.                REQUISICION DE DEVOLUCION DE MATERIAL DISPONIEBLE        Pagina : 0001
                           NUMERO REQUISICION :  0000192967                         Fecha : 30/10/2026
                                                                                    Hora  : 17:18:14
Almacen       : 20            INSUMOS EN PROVEEDORES
ORDEN/PRODUCCION : 2026008387
LOTE DEL SISTEMA :             O
    Articulo  : 3000508     JARABE TERMINADO PULP DURAZNO 5% AZUCARES TOTALES - AZUCAR INV
    Cantidad  : 252,000.0000   LT
    Linea     :  O TANQUES DE JARABE GASEOSA
    Solicitante :     6903 CANALES MORI, ROBERTO SERGIO
    TURNO Y FECH : 005 30/10/2026          Fecha Requisicion  00/00/0000

#ITEMS   MATERIAL           Descripcion                      UNID.    CANTIDAD
----------------------------------------------------------------------------------------------
001        5553   PURE DE DURAZNO 30-32 °BRIX                  KG      15,040.0000       Pendiente
002        30233  PULPA DE DURAZNO HUAYCO ROJO 20°BRIX         KG       3,456.0000       Pendiente`
  const cat = [
    { codigo: '5553', descripcion: 'PURE DE DURAZNO 30-32 °BRIX', un: 'KG' },
    { codigo: '30233', descripcion: 'PULPA DE DURAZNO HUAYCO ROJO 20°BRIX', un: 'KG' },
    { codigo: '3000508', descripcion: 'JARABE TERMINADO PULP DURAZNO 5% AZUCARES', un: 'LT' },
  ]
  const datos = extraerDatosGuiaDeTextos(TEXTO_REQ, null, cat)
  check('detecta REQUISICIÓN DE DEVOLUCIÓN', datos.esRequisicionDevolucion === true)
  check('nº de requisición 0000192967', datos.numeroGuia === '0000192967', datos.numeroGuia)
  check('empresa AJEPER S.A.', /AJEPER\s*S\.?A\.?/i.test(datos.proveedor), datos.proveedor)
  check(
    'notas: OP 2026008387 + solicitante',
    (datos.notasDevolucion ?? '').includes('OP 2026008387') && /CANALES MORI/i.test(datos.notasDevolucion ?? ''),
    datos.notasDevolucion
  )
  const d5553 = datos.items.find((i) => i.codigo === '5553')
  const d30233 = datos.items.find((i) => i.codigo === '30233')
  check('fila 5553 en catálogo', d5553?.enCatalogo === true, JSON.stringify(datos.items.map((i) => i.codigo)))
  check('fila 30233 en catálogo', d30233?.enCatalogo === true)
  check('cantidad 4 decimales 15,040.0000', d5553?.cantidad === '15,040.0000', d5553?.cantidad)
  check('cantidad 3,456.0000', d30233?.cantidad === '3,456.0000', d30233?.cantidad)
  check('sin placa (la requisición no trae)', datos.placa === '')

  // Guía normal SIN regressión: la T sigue resolviéndose y las cantidades
  // con separador de las guías siguen leyéndose por el lado izquierdo de la
  // unidad (formato guía: CANT antes de UNID). Un número PLANO sin
  // separador ("24") nunca fue una cantidad para el parser (por diseño —
  // así evita confundir series/bultos): el formato real impreso trae
  // separadores (2,884.00).
  const TEXTO_GUIA = `GUÍA DE REMISIÓN DEL REMITENTE
T005-0034403
RAZÓN SOCIAL: AJEPER S.A.
PESO KILOGRAMOS
BIENES TRANSPORTADOS
1  5653  BOTELLA 500ML   2,884.00  CS
NOTAS`
  const catG = [{ codigo: '5653', descripcion: 'BOTELLA 500ML', un: 'CS' }]
  const datosGuia = extraerDatosGuiaDeTextos(TEXTO_GUIA, null, catG)
  check('guía: nº T005-0034403 intacto', datosGuia.numeroGuia === 'T005-0034403', datosGuia.numeroGuia)
  check('guía: no es requisición', !datosGuia.esRequisicionDevolucion)
  check('guía: cantidad 2,884.00 (lado izquierdo intacto)', datosGuia.items[0]?.cantidad === '2,884.00', datosGuia.items[0]?.cantidad)
  check('guía: RAZÓN SOCIAL sigue mandando en empresa', /AJEPER/i.test(datosGuia.proveedor), datosGuia.proveedor)

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('ERROR FATAL:', err)
  process.exit(1)
})
