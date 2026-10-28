#!/usr/bin/env node
/**
 * RACKLY — Task 35 · Tests del TURNO DEL RQ (hoja física 004/005).
 *
 * Feature (módulo Atención, solicitud del usuario):
 *   · La hoja física de la Requisición trae su propio turno
 *     («Turno: 004» = turno 1 · «005» = turno 2), que puede DIFIERIR del
 *     turno del sistema (hora de registro): una RQ entregada en la
 *     madrugada pertenece al turno del día siguiente.
 *   · El OCR pre-llena el turno de la hoja; el formulario lo deja editable.
 *   · La lista filtra por fecha y por turno del RQ (históricos sin
 *     turno_rq caen al turno del sistema).
 *
 * Suite PURA: rq-ocr + payloadRpcCrearRq + payloadRpcEditarRq
 * (sin red ni Supabase).
 */
const assert = require('assert')
const { extraerDatosRqDeTexto, fusionarDatosRq } = require('../src/lib/rackly/rq-ocr')
const {
  payloadRpcCrearRq,
  payloadRpcEditarRq,
} = require('../src/lib/rackly/rq-atencion')

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

const CATALOGO = [
  { codigo: '57268', descripcion: 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25', un: 'UN' },
]

const USUARIO = { id: 'u-1', nombre: 'Miguel Hidalgo', correo: 'm@rackly.pe' }

// ═══════════════════════════════════════════════════════════════════
// 1) OCR — extracción del turno de la hoja (004=T1 · 005=T2)
// ═══════════════════════════════════════════════════════════════════

// 1.1 Rengón completo del documento real (RQ 0000191740): TURNO Y FECH : 004
const d1 = extraerDatosRqDeTexto(
  'REQUISICION DE DESPACHO DE MATERIALES   Fecha —: 23/10/2026\nTURNO Y FECH : 004  23/10/2026\n001  57268  ETIQUETA DILYTE  UN 165,000.0000 Pendiente\n',
  CATALOGO
)
check('OCR: «TURNO Y FECH : 004 …» → T1', d1.turnoRq === 'T1')
check('OCR: el renglón de turno/fecha no nace material', d1.items.length === 1)

// 1.2 Turno 2 de la hoja: 005
const d2 = extraerDatosRqDeTexto('TURNO Y FECH : 005  23/10/2026\n', CATALOGO)
check('OCR: «TURNO Y FECH : 005 …» → T2', d2.turnoRq === 'T2')

// 1.3 Variante partida por el OCR (mismo artefacto del fantasma de fecha)
const d3 = extraerDatosRqDeTexto('TURNO Y FECH :\n004  23/10/2026\n', CATALOGO)
check('OCR: renglón partido «004 23/10/2026» → T1', d3.turnoRq === 'T1')

// 1.4 Sin etiqueta TURNO ni par 004/005+fecha → vacío
const d4 = extraerDatosRqDeTexto('NUMERO REQUISICION : 0000191740\n001  57268  ETIQUETA  UN 165,000.0000\n', CATALOGO)
check('OCR: sin turno en la hoja → \'\'', d4.turnoRq === '')

// 1.5 Números que NO son turno (007, DNI, cantidades) → vacío (sin falsos positivos)
const d5 = extraerDatosRqDeTexto('TURNO Y FECH : 007  23/10/2026\n', CATALOGO)
check('OCR: turno 007 no válido → \'\'', d5.turnoRq === '')
const d6 = extraerDatosRqDeTexto('TURNO Y FECH : 45  23/10/2026\n', CATALOGO)
check('OCR: «45» no es 004/005 → \'\'', d6.turnoRq === '')
const d7 = extraerDatosRqDeTexto('TURNO Y FECH : 001  23/10/2026\n', CATALOGO)
check('OCR: turno 001 → \'\' (solo 004/005)', d7.turnoRq === '')

// 1.6 Formato «TURNO: 4» (dígito suelto tras la etiqueta)
const d8 = extraerDatosRqDeTexto('TURNO : 4\nFECHA : 23/10/2026\n', CATALOGO)
check('OCR: «TURNO : 4» → T1', d8.turnoRq === 'T1')

// ═══════════════════════════════════════════════════════════════════
// 2) FUSIÓN de pases — el turno de la hoja se conserva (a || b)
// ═══════════════════════════════════════════════════════════════════

const f1 = fusionarDatosRq(
  { ...vacioDatos(), turnoRq: '' },
  { ...vacioDatos(), turnoRq: 'T2' }
)
check('fusión: turno de la hoja del pase B gana', f1.turnoRq === 'T2')
const f2 = fusionarDatosRq(
  { ...vacioDatos(), turnoRq: 'T1' },
  { ...vacioDatos(), turnoRq: '' }
)
check('fusión: turno del pase A se conserva', f2.turnoRq === 'T1')

function vacioDatos() {
  return {
    numeroRq: '', ordenProduccion: '', productoCodigo: '', productoDescripcion: '',
    fecha: '', linea: '', turnoRq: '', solicitante: '', items: [],
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3) PAYLOAD de la RPC rq_crear_completa — turno_rq viaja a la BD
// ═══════════════════════════════════════════════════════════════════

const DATOS = {
  fecha: '2026-10-28',
  numeroRq: '0000192677',
  ordenProduccion: '2026006121',
  productoCodigo: '3000047',
  productoDescripcion: 'SYRUP KR PIÑA 5%',
  turno: 'T2',        // turno del SISTEMA (hora de registro, madrugada)
  turnoRq: 'T1',      // turno de la HOJA (004) — difiere del sistema
  linea: 'L13',
  solicitante: 'DIANA CHINCHAY',
  notas: '',
  fotoUrl: '',
}
const ITEMS = [{ codigo: '57268', descripcion: 'ETIQUETA', unidad: 'UN', cantidad: 165000 }]
const pCrear = payloadRpcCrearRq(DATOS, ITEMS, USUARIO, '11111111-2222-4333-8444-555555555555')
check('crear: p_rq.turno = turno del sistema (T2)', pCrear.p_rq.turno === 'T2')
check('crear: p_rq.turno_rq = turno de la hoja (T1)', pCrear.p_rq.turno_rq === 'T1')

const pCrearVacio = payloadRpcCrearRq(
  { ...DATOS, turnoRq: undefined },
  ITEMS,
  USUARIO,
  '11111111-2222-4333-8444-555555555556'
)
check('crear: turno_rq vacío → \'\' (la RPC guarda NULL)', pCrearVacio.p_rq.turno_rq === '')

// ═══════════════════════════════════════════════════════════════════
// 4) PAYLOAD de la RPC rq_editar_rq — turno_rq corregible
// ═══════════════════════════════════════════════════════════════════

const pEditar = payloadRpcEditarRq(
  'rq-1',
  { turnoRq: 'T2', turno: 'T1' },
  [],
  USUARIO
)
check('editar: encabezado.turno_rq en snake_case', pEditar.p_encabezado.turno_rq === 'T2')
check('editar: turno del sistema sigue presente', pEditar.p_encabezado.turno === 'T1')

const pEditarSin = payloadRpcEditarRq('rq-1', { notas: 'x' }, [], USUARIO)
check('editar: sin turnoRq no viaja el campo', !('turno_rq' in pEditarSin.p_encabezado))

// ═══════════════════════════════════════════════════════════════════
// 5) RESPALDO cliente (crearRq sin RPC) — columna turno_rq al insert
//    (se valida por el mapeo de tipos: turnoRq opcional en NuevoRq)
// ═══════════════════════════════════════════════════════════════════

const pRespaldo = payloadRpcCrearRq({ ...DATOS, turnoRq: 'T2' }, ITEMS, USUARIO, '11111111-2222-4333-8444-555555555557')
check('respaldo/crear: turno_rq T2 pasa intacto', pRespaldo.p_rq.turno_rq === 'T2')

console.log('──────────────────────────────')
console.log(`OK ${ok}/18`)
if (process.exitCode) process.exit(1)
