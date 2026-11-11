#!/usr/bin/env node
/**
 * RACKLY — 2026-11-12 · EDICIÓN SUPERVISADA del RAL (paridad con la RQ).
 *
 * Suite doble:
 *   A. PURA — validarEdicionRal (mismas reglas que la RPC ral_editar:
 *      cantidad < atendida, código/unidad congelados con atención, quitar
 *      con atención, duplicados, sin código, cantidad > 0) y
 *      payloadRpcEditarRal (snake_case + centro_costos + usuario).
 *   B. STUB — editarRal: llama rpc('ral_editar') con TODOS los parámetros
 *      (sin defaults — convención PGRST203) y mapea el resultado jsonb
 *      {ral, items, cambios} incluyendo ediciones.
 */
const stub = require('../scripts/stubs/supabase_client_stub.js')
const {
  validarEdicionRal,
  payloadRpcEditarRal,
  editarRal,
} = require('../src/lib/rackly/ral')

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

const USUARIO = { id: 'u-1', nombre: 'MIGUEL', correo: 'm@pe.pe' }

// ── fixtures ──
const itemA = { id: 'ia', ralId: 'r1', orden: 0, codigo: 'AC-101', descripcion: 'ALCALINO', unidad: 'UN', centroCostos: 'CC-1', cantidad: 10, cantidadAtendida: 0, usuarioAtencion: '', atendidoEn: '' }
const itemB = { id: 'ib', ralId: 'r1', orden: 1, codigo: 'OXV', descripcion: 'OXONIA', unidad: 'LT', centroCostos: 'CC-2', cantidad: 5, cantidadAtendida: 3, usuarioAtencion: 'X', atendidoEn: '2026-11-12T10:00:00Z' }

// ── A. validarEdicionRal ──────────────────────────────────────────────
check('A1 · edición válida simple', validarEdicionRal(
  [{ id: 'ia', orden: 0, codigo: 'ac-101', descripcion: 'ALCALINO', unidad: 'UN', centroCostos: 'CC-1', cantidad: 12 }],
  [itemA]
).length === 0)

check('A2 · lista vacía rechaza', validarEdicionRal([], [itemA]).length > 0)

check('A3 · cantidad menor que atendida rechaza', validarEdicionRal(
  [{ id: 'ib', orden: 0, codigo: 'OXV', descripcion: 'OXONIA', unidad: 'LT', centroCostos: '', cantidad: 2 }],
  [itemB]
).some((e) => e.includes('revierte')))

check('A4 · sobreatendido SIN modificar cantidad pasa (regla Task 34)', validarEdicionRal(
  [{ id: 'ib', orden: 0, codigo: 'OXV', descripcion: 'OXONIA', unidad: 'LT', centroCostos: '', cantidad: 5 }],
  [{ ...itemB, cantidadAtendida: 7 }]
).length === 0)

check('A5 · cambiar código con atención rechaza', validarEdicionRal(
  [{ id: 'ib', orden: 0, codigo: 'OTRO', descripcion: 'OXONIA', unidad: 'LT', centroCostos: '', cantidad: 5 }],
  [itemB]
).some((e) => e.includes('código ni la unidad')))

check('A6 · cambiar unidad con atención rechaza', validarEdicionRal(
  [{ id: 'ib', orden: 0, codigo: 'OXV', descripcion: 'OXONIA', unidad: 'GL', centroCostos: '', cantidad: 5 }],
  [itemB]
).length > 0)

check('A7 · quitar material con atención rechaza', validarEdicionRal(
  [{ id: 'ia', orden: 0, codigo: 'AC-101', descripcion: 'ALCALINO', unidad: 'UN', centroCostos: 'CC-1', cantidad: 10 }],
  [itemA, itemB]
).some((e) => e.includes('quitarlo')))

check('A8 · duplicado rechaza', validarEdicionRal(
  [
    { id: 'ia', orden: 0, codigo: 'AC-101', descripcion: 'A', unidad: 'UN', centroCostos: '', cantidad: 1 },
    { id: 'ia', orden: 1, codigo: 'AC-101', descripcion: 'A', unidad: 'UN', centroCostos: '', cantidad: 1 },
  ],
  [itemA]
).some((e) => e.includes('dos veces')))

check('A9 · sin código rechaza', validarEdicionRal(
  [{ orden: 0, codigo: '', descripcion: '', unidad: '', centroCostos: '', cantidad: 5 }],
  []
).some((e) => e.includes('sin código')))

check('A10 · cantidad <= 0 rechaza', validarEdicionRal(
  [{ orden: 0, codigo: 'X', descripcion: '', unidad: '', centroCostos: '', cantidad: 0 }],
  []
).some((e) => e.includes('mayor que cero')))

check('A11 · CENTRO DE COSTOS editable con atención (no rechaza)', validarEdicionRal(
  [{ id: 'ib', orden: 0, codigo: 'OXV', descripcion: 'OXONIA', unidad: 'LT', centroCostos: 'CC-NUEVO', cantidad: 5 }],
  [itemB]
).length === 0)

// ── B. payloadRpcEditarRal (PURO) ─────────────────────────────────────
const p = payloadRpcEditarRal(
  'ral-1',
  { documento: '8378', linea: 'Línea 9', notas: '', fecha: '2026-11-12' },
  [
    { id: 'ia', orden: 0, codigo: 'ac-101', descripcion: 'ALCALINO', unidad: 'UN', centroCostos: 'CC-9', cantidad: 10 },
    { orden: 1, codigo: 'nuevo', descripcion: 'NUEVO', unidad: 'UN', centroCostos: '', cantidad: 2 },
  ],
  USUARIO
)
check('B1 · args completos SIN defaults (p_ral_id)', p.p_ral_id === 'ral-1')
check('B2 · encabezado snake_case con campos presentes', p.p_encabezado.documento === '8378' && p.p_encabezado.linea === 'Línea 9' && p.p_encabezado.fecha === '2026-11-12')
check('B3 · encabezado omite campos ausentes', p.p_encabezado.transaccion === undefined)
check('B4 · items: código upper + centro_costos', p.p_items[0].codigo === 'AC-101' && p.p_items[0].centro_costos === 'CC-9')
check('B5 · items: nuevo SIN id', p.p_items[1].id === undefined && p.p_items[1].codigo === 'NUEVO')
check('B6 · usuario al RPC', p.p_usuario_id === 'u-1' && p.p_usuario_nombre === 'MIGUEL' && p.p_usuario_correo === 'm@pe.pe')

// ── C. editarRal vía STUB (contrato rpc) ──────────────────────────────
const ralJson = {
  id: 'ral-1', created_at: '2026-11-12T09:00:00Z', fecha: '2026-11-12', documento: '8378',
  transaccion: 'RAL', area_solicitante: 'MANT', solicitante: 'JORGE', aprobado_por: 'ANA',
  almacen: 'ALM-01', linea: 'Línea 9', foto_url: '', notas: '', usuario_id: 'u1',
  usuario_nombre: 'U', usuario_correo: 'u@u.pe', estado: 'Pendiente',
  ediciones: [{ en: '2026-11-12 10:00', usuario_id: 'u-1', usuario_nombre: 'MIGUEL',
    usuario_correo: 'm@pe.pe', resumen: { encabezado: 1, materiales_editados: 1, materiales_agregados: 0, materiales_quitados: 0 },
    cambios: [{ tipo: 'encabezado', campo: 'linea', antes: 'AUXILIAR', despues: 'Línea 9' }] }],
}
const itemsJson = [{
  id: 'ia', ral_id: 'ral-1', orden: 0, codigo: 'AC-101', descripcion: 'ALCALINO', unidad: 'UN',
  centro_costos: 'CC-9', cantidad: 12, cantidad_atendida: 0, usuario_atencion: '', atendido_en: null,
}]

// El stub rpc devuelve la respuesta PostgREST COMPLETA: {data, error}.
stub.__setRpcResult('ral_editar', { data: { ral: ralJson, items: itemsJson, cambios: 3 }, error: null })

editarRal('ral-1', { linea: 'Línea 9' }, [{ id: 'ia', orden: 0, codigo: 'AC-101', descripcion: 'ALCALINO', unidad: 'UN', centroCostos: 'CC-9', cantidad: 12 }], USUARIO)
  .then((r) => {
    const llamada = stub.__rpcCalls().find((c) => c.name === 'ral_editar')
    check('C1 · llama rpc ral_editar', !!llamada)
    check('C2 · envía TODOS los args (sin defaults: 6 claves)', Object.keys(llamada.args).length === 6 &&
      'p_ral_id' in llamada.args && 'p_encabezado' in llamada.args && 'p_items' in llamada.args &&
      'p_usuario_id' in llamada.args && 'p_usuario_nombre' in llamada.args && 'p_usuario_correo' in llamada.args)
    check('C3 · mapea resultado jsonb → ResultadoEdicionRal', r.ral.id === 'ral-1' && r.cambios === 3 && r.items[0].centroCostos === 'CC-9' && r.items[0].cantidad === 12)
    check('C4 · mapea auditoría ediciones', r.ral.ediciones.length === 1 && r.ral.ediciones[0].resumen.encabezado === 1 && r.ral.ediciones[0].cambios[0].campo === 'linea')
    check('C5 · estado default si BD no trae', r.ral.estado === 'Pendiente')
    console.log(`— ral_editar: ${ok} checks —`)
    if (process.exitCode) process.exit(1)
  })
  .catch((e) => {
    console.error('✗ editarRal lanzó error:', e)
    process.exit(1)
  })
