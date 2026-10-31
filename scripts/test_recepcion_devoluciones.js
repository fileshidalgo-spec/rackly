/**
 * RACKLY — Tests: DEVOLUCIONES DE LÍNEA en Recepción (trace 1a18f4a2b62c90cd).
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
 *   8. OCR del RQ DE DEVOLUCIÓN con la EXTRACCIÓN DE ATENCIÓN (pedido
 *      2026-10-31: «la devolución es idéntico a la extracción de datos que
 *      hacemos para atención… no es una guía si no un RQ»): el parser es
 *      rq-ocr.ts (extraerDatosRqDeTexto) — Nº de requisición «NUMERO
 *      REQUISICION», OP, producto, línea, solicitante, turno de hoja y las
 *      2 filas de la tabla UNID→CANT con sus cantidades de 4 decimales.
 *   9. Mapeo RQ → recepción (devolucion-rq.ts): contexto a observaciones,
 *      materiales a filas (1:1, sin paletas) y guard films sin proveedor.
 *  10. SIN REGRESIÓN en guías: guia-ocr.ts quedó EXACTAMENTE como antes de
 *      la iteración 1 (revertido) — el Nº T y las cantidades del lado
 *      izquierdo (CANT UNID) siguen leyéndose igual.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { crearRecepciones, listarRecepciones, guardarEdicionGuia } = require('@/lib/rackly/modulos')
const { agruparGuias } = require('@/lib/rackly/recepcion-filas')
const { mapArticuloTransito, agruparEnGuias } = require('@/lib/rackly/transito-core')
const { extraerDatosRqDeTexto } = require('@/lib/rackly/rq-ocr')
const {
  contextoDesdeDatosRq,
  observacionesContextoRq,
  materialesRqAFilas,
  TIPO_DOC_DEVOLUCION,
} = require('@/lib/rackly/devolucion-rq')
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

  // ─── 7. OCR del RQ DE DEVOLUCIÓN con la extracción de ATENCIÓN ───
  console.log('\n── 7. OCR RQ de devolución (rq-ocr = extracción Atención) ──')
  // Documento real (foto del usuario 2026-10-30): «REQUISICION DE DEVOLUCION
  // DE MATERIAL DISPONIBLE» Nº 0000192967 — NO es una guía; el parser es EL
  // MISMO de Atención (rq-ocr.ts), que ya lee la tabla UNID→CANT con saldo.
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
  const rq = extraerDatosRqDeTexto(TEXTO_REQ, cat)
  check('nº de requisición 0000192967 (NUMERO REQUISICION)', rq.numeroRq === '0000192967', rq.numeroRq)
  check('orden de producción 2026008387', rq.ordenProduccion === '2026008387', rq.ordenProduccion)
  check('fecha 30/10/2026 → 2026-10-30', rq.fecha === '2026-10-30', rq.fecha)
  check('línea «O TANQUES DE JARABE GASEOSA»', rq.linea.includes('TANQUES DE JARABE'), rq.linea)
  check('solicitante sin DNI (6903 fuera)', /CANALES MORI/i.test(rq.solicitante) && !/6903/.test(rq.solicitante), rq.solicitante)
  check('producto 3000508 (JARABE TERMINADO)', rq.productoCodigo === '3000508' && /JARABE/.test(rq.productoDescripcion), `${rq.productoCodigo} ${rq.productoDescripcion}`)
  check('turno de hoja 005 → T2', rq.turnoRq === 'T2', rq.turnoRq)
  const r5553 = rq.items.find((i) => i.codigo === '5553')
  const r30233 = rq.items.find((i) => i.codigo === '30233')
  check('material 5553 en catálogo', r5553?.enCatalogo === true, JSON.stringify(rq.items.map((i) => i.codigo)))
  check('material 30233 en catálogo', r30233?.enCatalogo === true)
  check('cantidad 15,040.0000 → 15040', r5553?.cantidad === 15040, String(r5553?.cantidad))
  check('cantidad 3,456.0000 → 3456', r30233?.cantidad === 3456, String(r30233?.cantidad))
  check('unidad KG leída de la columna UNID', r5553?.unidad === 'KG', r5553?.unidad)
  check('sin filas fantasma (cabecera no fecunda)', rq.items.length === 2, String(rq.items.length))

  // ─── 8. MAPEO RQ → RECEPCIÓN (devolucion-rq.ts) ───
  console.log('\n── 8. Mapeo RQ → recepción (contexto + filas) ──')
  const ctx = contextoDesdeDatosRq(rq)
  check('contexto hereda Nº RQ / OP / solicitante', ctx.numeroRq === '0000192967' && ctx.ordenProduccion === '2026008387' && /CANALES/.test(ctx.solicitante), JSON.stringify(ctx))
  const obs = observacionesContextoRq(ctx)
  check(
    'observaciones: OP · Línea · Solicita · Producto',
    obs.includes('OP 2026008387') && obs.includes('Línea') && obs.includes('Solicita:') && obs.includes('Producto: 3000508'),
    obs
  )
  const filasRq = materialesRqAFilas(rq.items)
  check('2 materiales → 2 filas (1:1, sin paletas)', filasRq.length === 2 && filasRq.every((f) => !f.paletas), String(filasRq.length))
  check('fila 5553: cantidad 15040 + unidad KG', filasRq[0]?.codigo === '5553' && filasRq[0]?.cantidad === '15040' && filasRq[0]?.unidad === 'KG', JSON.stringify(filasRq[0]))
  check('fila sin lote/fechas (la requisición no trae)', filasRq.every((f) => f.lote === '' && f.fechaProduccion === '' && f.fechaVencimiento === ''), '')
  // Guard films: un film sin proveedor queda marcado (misma regla que guías).
  const filasFilm = materialesRqAFilas([
    { codigo: '9001', descripcion: 'LAMINA STRETCH 500MM 20MIC', cantidad: '120', unidad: 'KGM' },
    { codigo: '9002', descripcion: 'ETIQUETA AGUA CIELO 500ML', cantidad: '3000', unidad: 'UN' },
  ])
  const { faltanProveedor } = require('@/lib/rackly/recepcion-filas')
  check('film sin proveedor queda marcado por faltanProveedor', JSON.stringify(faltanProveedor(filasFilm)) === JSON.stringify(['9001']), JSON.stringify(faltanProveedor(filasFilm)))
  // Guardado con el mapeo: la fila nace 'devolucion' con el solicitante como
  // empresa de origen y el contexto del RQ en observaciones.
  stub.__clear()
  stub.__setTable('recepcion_registros', [])
  await crearRecepciones(
    filasRq.map((f, i) => ({
      fecha: rq.fecha || '2026-10-30',
      tipoDocumento: TIPO_DOC_DEVOLUCION,
      numeroDocumento: ctx.numeroRq,
      empresaOrigen: ctx.solicitante,
      proveedor: f.proveedor,
      codigo: f.codigo,
      descripcion: f.descripcion,
      cantidad: Number(f.cantidad),
      unidadMedida: f.unidad,
      lote: f.lote,
      observaciones: obs,
      uuidSync: `uuid-dev-${i}`,
    })),
    USUARIO,
    { tipoRecepcion: 'devolucion' }
  )
  const insertsRq = stub.__insertCalls().filter((c) => c.table === 'recepcion_registros')
  const payloadRq = Array.isArray(insertsRq[0]?.payload) ? insertsRq[0].payload[0] : insertsRq[0]?.payload
  check('alta RQ → tipo_documento «Requisición de devolución»', payloadRq?.tipo_documento === 'Requisición de devolución', payloadRq?.tipo_documento)
  check('alta RQ → empresa_origen = solicitante', /CANALES MORI/i.test(payloadRq?.empresa_origen ?? ''), payloadRq?.empresa_origen)
  check('alta RQ → observaciones = contexto (OP+Línea+Solicita+Producto)', (payloadRq?.observaciones ?? '').includes('OP 2026008387') && (payloadRq?.observaciones ?? '').includes('Solicita:'), payloadRq?.observaciones)
  check('alta RQ → tipo_recepcion=devolucion', payloadRq?.tipo_recepcion === 'devolucion', payloadRq?.tipo_recepcion)

  // ─── 9. SIN REGRESIÓN en guías (guia-ocr revertido a su estado original) ───
  console.log('\n── 9. Regresión guías: parser intacto ──')
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
  check('guía: sin campos de devolución (revertido)', datosGuia.esRequisicionDevolucion === undefined && datosGuia.notasDevolucion === undefined)
  check('guía: cantidad 2,884.00 (CANT antes de UNID)', datosGuia.items[0]?.cantidad === '2,884.00', datosGuia.items[0]?.cantidad)
  check('guía: RAZÓN SOCIAL sigue mandando en empresa', /AJEPER/i.test(datosGuia.proveedor), datosGuia.proveedor)

  // ─── Resumen ───
  console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
  process.exit(fallidos > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('ERROR FATAL:', err)
  process.exit(1)
})
