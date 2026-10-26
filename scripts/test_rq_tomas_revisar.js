#!/usr/bin/env node
/**
 * RACKLY — Task 27 · Tests del LEDGER de tomas + vista «Revisar».
 *
 * Feature (solicitud del usuario, módulo Atención):
 *   · «Revisar» al lado de «Ver ubicación»/«Atender con QR»: desde qué
 *     posiciones se atendió el material y el saldo (inicial / sacado / queda).
 *   · Editar también materiales ya ATENDIDOS (reversa guiada en el editor).
 *
 * Suite PURA: payloadRpcTomas + agregarRevision (rq-atencion.ts) y
 * detectarRqParaSalida con posiciones (rq-contexto-salida.ts) — sin red.
 * Las reglas de la RPC (suma = cantidad, ledger transaccional) están
 * verificadas contra la BD REAL en scripts/deploy_rq_tomas.py (6/6 ROLLBACK).
 */
const {
  payloadRpcTomas,
  agregarRevision,
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

// ═══════════════════════════════════════════════════════════════════
// 1) payloadRpcTomas — forma del p_toma para rq_atender_item
// ═══════════════════════════════════════════════════════════════════

check('sin tomas → null (la RPC registra manual)', payloadRpcTomas(undefined) === null && payloadRpcTomas([]) === null)

const pt = payloadRpcTomas([
  { ubicacion: ' B8·T1·P3·Pos14 ', cantidad: 20, origen: 'racks' },
  { ubicacion: 'Piso · A-Pos 3', cantidad: 10 },
])
check('origen por defecto = manual', pt[1].origen === 'manual')
check('ubicación recortada', pt[0].ubicacion === 'B8·T1·P3·Pos14')
check('origen racks conservado', pt[0].origen === 'racks')
check('cantidad directa', pt[0].cantidad === 20 && pt[1].cantidad === 10)

// ═══════════════════════════════════════════════════════════════════
// 2) agregarRevision — agrupación por posición + saldos
// ═══════════════════════════════════════════════════════════════════

const toma = (o) => ({
  id: o.id, origen: o.origen, cantidad: o.cantidad, ubicacion: o.ubicacion ?? '',
  saldoResultante: o.saldo ?? null, usuarioNombre: o.usuario ?? '', fecha: o.fecha ?? '', lote: '',
})

// Escenario del usuario: 2 posiciones (una vaciada, otra con saldo) + tránsito + manual + reversa
const LEDGER = [
  toma({ id: 't1', origen: 'racks', cantidad: 100, ubicacion: 'B6·T2·P4·Pos8', saldo: 0, usuario: 'Andy', fecha: '2026-10-26T16:04' }),
  toma({ id: 't2', origen: 'racks', cantidad: 1800, ubicacion: 'B5·T2·P3·Pos15', saldo: 200, usuario: 'Andy', fecha: '2026-10-26T16:18' }),
  toma({ id: 't3', origen: 'racks', cantidad: 1700, ubicacion: 'B5·T2·P3·Pos15', saldo: 200, usuario: 'Andy', fecha: '2026-10-26T16:15' }),
  toma({ id: 't4', origen: 'transito', cantidad: 500, fecha: '2026-10-26T15:00' }),
  toma({ id: 't5', origen: 'manual', cantidad: 50, fecha: '2026-10-26T17:30' }),
  toma({ id: 't6', origen: 'reversa', cantidad: -30, fecha: '2026-10-26T17:40' }),
]

// Saldo ACTUAL: Pos8 vaciada (no aparece en el stock > 0), Pos15 con 200
const saldoRacks = new Map([['B5·T2·P3·Pos15', 200]])
const rev = agregarRevision(LEDGER, saldoRacks, new Map())

check('2 posiciones agrupadas', rev.posiciones.length === 2)
const pos8 = rev.posiciones.find((p) => p.ubicacion === 'B6·T2·P4·Pos8')
const pos15 = rev.posiciones.find((p) => p.ubicacion === 'B5·T2·P3·Pos15')
check('Pos8: sacado 100, saldo actual 0 (posición vaciada → salida completa)', pos8 && pos8.sacado === 100 && pos8.saldoActual === 0 && pos8.saldoAlMomento === 0)
check('Pos15: sacado agrupado 3500 (1800+1700)', pos15 && pos15.sacado === 3500)
check('Pos15: saldo al momento = última toma con dato (200)', pos15 && pos15.saldoAlMomento === 200)
check('Pos15: saldo actual 200 del mapa', pos15 && pos15.saldoActual === 200)
check('Pos15: usuarios únicos (1) + última fecha', pos15 && pos15.usuarios.length === 1 && pos15.ultimaFecha === '2026-10-26T16:18')
check('tránsito separado (500)', rev.desdeTransito && rev.desdeTransito.sacado === 500)
check('manual sin posición (50 + reversa -30 = neto 20)', rev.manualSinPosicion && rev.manualSinPosicion.sacado === 20)
check('total revertido 30', rev.totalRevertido === 30)
check('cobertura con posición = 3600 (100+1800+1700)', rev.coberturaConPosicion === 3600)
check('orden: mayor sacado primero', rev.posiciones[0].ubicacion === 'B5·T2·P3·Pos15')

// Piso: saldo del mapa de piso; sin dato → null
const revPiso = agregarRevision(
  [toma({ id: 'p1', origen: 'piso', cantidad: 60, ubicacion: 'Piso · A-Pos 3' }), toma({ id: 'p2', origen: 'piso', cantidad: 5, ubicacion: 'Piso · B-Pos 9' })],
  new Map(),
  new Map([['Piso · A-Pos 3', 100]])
)
check('piso con saldo en mapa → 100', revPiso.posiciones[0].saldoActual === 100)
check('piso sin saldo en mapa → null (no cero falso)', revPiso.posiciones[1].saldoActual === null)

// Posición rack SIN fila en el stock actual = vaciada (la RPC solo trae > 0)
const revVacia = agregarRevision([toma({ id: 'v1', origen: 'racks', cantidad: 999, ubicacion: 'B1·T1·P1·Pos1' })], new Map(), new Map())
check('rack ausente del stock actual → saldoActual 0 (salida completa)', revVacia.posiciones[0].saldoActual === 0)

// ═══════════════════════════════════════════════════════════════════
// 3) detectarRqParaSalida — tomas por posición desde las rutas de salida
// ═══════════════════════════════════════════════════════════════════

// Mock de sessionStorage (el contexto RQ vive ahí)
const store = new Map()
global.window = {
  sessionStorage: {
    setItem: (k, v) => store.set(k, v),
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => store.delete(k),
  },
}
const { guardarContextoSalidaRq, detectarRqParaSalida } = require('../src/lib/rackly/rq-contexto-salida')

guardarContextoSalidaRq({
  rqId: 'rq-27', numeroRq: '0000192361', itemId: 'it-27', codigo: 'MAT-X',
  descripcion: 'Material X', unidad: 'KG', cantidadRequerida: 100, cantidadAtendida: 0,
})

const sinCtx = detectarRqParaSalida([{ codigo: 'MAT-X', cantidad: 40 }])
check('salida simple sin posición → tomas vacías (manual en la RPC)', !!sinCtx && sinCtx.cantidad === 40 && sinCtx.tomas.length === 0)

const conUbis = detectarRqParaSalida([
  { codigo: 'MAT-X', cantidad: 20, unidad: 'KG', ubicacion: 'B8·T1·P3·Pos14', origen: 'racks' },
  { codigo: 'MAT-X', cantidad: 20, unidad: 'KG', ubicacion: 'B8·T1·P3·Pos14', origen: 'racks' },
  { codigo: 'MAT-X', cantidad: 10, unidad: 'KG', ubicacion: 'B7·T2·P1·Pos2', origen: 'racks' },
  { codigo: 'OTRO', cantidad: 999, ubicacion: 'B1·T1·P1·Pos1' },
])
check('cantidad total solo del código de la RQ (50, sin OTRO)', conUbis && conUbis.cantidad === 50)
check('tomas agrupadas por posición (2 grupos)', conUbis && conUbis.tomas.length === 2)
check('grupo principal 40 en B8·T1·P3·Pos14', conUbis && conUbis.tomas.some((t) => t.ubicacion === 'B8·T1·P3·Pos14' && t.cantidad === 40))
check('origen racks propagado', conUbis && conUbis.tomas.every((t) => t.origen === 'racks'))

const conPiso = detectarRqParaSalida([{ codigo: 'MAT-X', cantidad: 15, ubicacion: 'Piso · A-Pos 3', origen: 'piso' }])
check('origen piso propagado', conPiso && conPiso.tomas[0].origen === 'piso')

check('sin contexto → null', guardarContextoSalidaRq({ rqId: '', numeroRq: '', itemId: '', codigo: 'MAT-X', descripcion: '', unidad: '', cantidadRequerida: 1, cantidadAtendida: 0 }) === undefined)

// ═══════════════════════════════════════════════════════════════════
console.log(`\n${ok} checks OK${process.exitCode ? ' — CON FALLOS' : ''}`)
