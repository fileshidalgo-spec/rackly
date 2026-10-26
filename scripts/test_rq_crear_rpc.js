#!/usr/bin/env node
/**
 * RACKLY — Task 25 · Tests de creación IDEMPOTENTE de RQ (rq-atencion.ts).
 *
 * Bugs corregidos (auditoría 2026-10-27, módulo Atención):
 *   1. crearRq generaba el id DENTRO de cada llamada → un reintento tras
 *      respuesta perdida creaba la RQ DOS VECES (ids distintos no chocan
 *      con la PK). Ahora el id lo preasigna el formulario (estable entre
 *      reintentos) y crearRq lo respeta.
 *   2. Header + items en 2 fases sin recuperación: duplicate devolvía
 *      "éxito" SIN materiales. Ahora payloadRpcCrearRq alimenta una RPC
 *      atómica con recuperación de items faltantes.
 * Suite PURA: solo payloadRpcCrearRq (sin red ni Supabase).
 */
const { payloadRpcCrearRq } = require('../src/lib/rackly/rq-atencion')

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

const USUARIO = { id: 'u-1', nombre: 'Miguel Hidalgo', correo: 'm@rackly.pe' }
const DATOS = {
  fecha: '2026-10-27',
  numeroRq: 'RQ-001',
  ordenProduccion: 'OP-77',
  productoCodigo: 'PT-9',
  productoDescripcion: 'Producto terminado',
  turno: 'T2',
  linea: 'L3',
  solicitante: 'CHINCHAY QUISPE',
  notas: 'urgente',
  fotoUrl: 'u-1/1.jpg',
}
const ITEMS = [
  { codigo: '58199', descripcion: 'Tapa roja', unidad: 'UN', cantidad: 123000 },
  { codigo: '56123', descripcion: 'Etiqueta', unidad: 'UN', cantidad: 7.5 },
]

const p = payloadRpcCrearRq(DATOS, ITEMS, USUARIO, '11111111-2222-4333-8444-555555555555')

// ── p_rq: mapeo completo y sin sorpresas ──
check('p_rq.id = id preasignado (idempotencia estable)', p.p_rq.id === '11111111-2222-4333-8444-555555555555')
check('p_rq.fecha', p.p_rq.fecha === '2026-10-27')
check('p_rq.numero_rq', p.p_rq.numero_rq === 'RQ-001')
check('p_rq.orden_produccion', p.p_rq.orden_produccion === 'OP-77')
check('p_rq.producto_codigo/descripcion', p.p_rq.producto_codigo === 'PT-9' && p.p_rq.producto_descripcion === 'Producto terminado')
check('p_rq.turno', p.p_rq.turno === 'T2')
check('p_rq.linea', p.p_rq.linea === 'L3')
check('p_rq.solicitante', p.p_rq.solicitante === 'CHINCHAY QUISPE')
check('p_rq.foto_url', p.p_rq.foto_url === 'u-1/1.jpg')
check('p_rq.notas', p.p_rq.notas === 'urgente')
check('p_rq.usuario_id/nombre/correo', p.p_rq.usuario_id === 'u-1' && p.p_rq.usuario_nombre === 'Miguel Hidalgo' && p.p_rq.usuario_correo === 'm@rackly.pe')
check('p_rq NO lleva estado (la RPC lo fija Pendiente)', !('estado' in p.p_rq))

// ── p_items: orden secuencial + valores limpios ──
check('p_items: 2 filas', p.p_items.length === 2)
check('p_items[0]: orden 0, código y cantidad numérica', p.p_items[0].orden === 0 && p.p_items[0].codigo === '58199' && p.p_items[0].cantidad === 123000)
check('p_items[1]: orden 1 y decimal intacto (7.5)', p.p_items[1].orden === 1 && p.p_items[1].cantidad === 7.5)
check('p_items NO lleva cantidad_atendida (RPC fija 0)', p.p_items.every((x) => !('cantidad_atendida' in x)))

// ── defaults defensivos en el cliente ──
const pVacio = payloadRpcCrearRq(
  { ...DATOS, turno: '', linea: undefined, notas: undefined, fotoUrl: undefined },
  [],
  USUARIO,
  '22222222-3333-4444-8555-666666666666'
)
check('turno vacío → T1', pVacio.p_rq.turno === 'T1')
check('linea undefined → ""', pVacio.p_rq.linea === '')
check('notas undefined → ""', pVacio.p_rq.notas === '')
check('fotoUrl undefined → ""', pVacio.p_rq.foto_url === '')
check('items vacíos → array [] (RQ sin materiales es legítima)', Array.isArray(pVacio.p_items) && pVacio.p_items.length === 0)

console.log(`\n${ok} checks OK`)
if (process.exitCode) process.exit(1)
