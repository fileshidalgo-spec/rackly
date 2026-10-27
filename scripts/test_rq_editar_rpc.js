#!/usr/bin/env node
/**
 * RACKLY — Task 26 · Tests de EDICIÓN SUPERVISADA de RQ (rq-atencion.ts).
 *
 * Feature (solicitud del usuario, módulo Atención):
 *   · El supervisor encuentra líneas erradas al atender → opción de EDITAR.
 *   · Administradores auditan todas las ediciones (historial de ediciones).
 *
 * Suite PURA: payloadRpcEditarRq + validarEdicionRq (sin red ni Supabase).
 * Las reglas de la RPC (cantidad >= atendida, identidad congelada, delete
 * solo sin atención) están verificadas contra la BD REAL en
 * scripts/smoke_editar_rq.py (10/10 con ROLLBACK).
 */
const {
  payloadRpcEditarRq,
  validarEdicionRq,
  estadoDeItem,
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

const USUARIO = { id: 'u-1', nombre: 'Miguel Hidalgo', correo: 'm@rackly.pe' }

// Materiales VIGENTES de la RQ (como vienen de obtenerRqCompleta)
const ACTUALES = [
  { id: 'a-1', rqId: 'rq-1', orden: 0, codigo: 'MAT-A', descripcion: 'Material A', unidad: 'KG', cantidad: 10, cantidadAtendida: 5, usuarioAtencion: '', atendidoEn: '' },
  { id: 'a-2', rqId: 'rq-1', orden: 1, codigo: 'MAT-B', descripcion: 'Material B', unidad: 'UN', cantidad: 20, cantidadAtendida: 0, usuarioAtencion: '', atendidoEn: '' },
  { id: 'a-3', rqId: 'rq-1', orden: 2, codigo: 'MAT-C', descripcion: 'Material C', unidad: 'KG', cantidad: 30, cantidadAtendida: 0, usuarioAtencion: '', atendidoEn: '' },
]

// ═══════════════════════════════════════════════════════════════════
// 1) payloadRpcEditarRq — forma del payload para la RPC
// ═══════════════════════════════════════════════════════════════════

const p = payloadRpcEditarRq(
  'rq-1',
  { numeroRq: '0000192360', linea: 'L6', notas: '' },
  [
    { id: 'a-1', orden: 0, codigo: 'mat-a', descripcion: 'Material A', unidad: 'KG', cantidad: 12 },
    { orden: 1, codigo: 'MAT-D', descripcion: 'Nuevo', unidad: 'KG', cantidad: 40 },
  ],
  USUARIO
)

check('p_rq_id directo', p.p_rq_id === 'rq-1')
check('encabezado solo campos presentes (snake_case)', p.p_encabezado.numero_rq === '0000192360' && p.p_encabezado.linea === 'L6' && p.p_encabezado.notas === '' && !('fecha' in p.p_encabezado))
check('items: con id se conservan', p.p_items[0].id === 'a-1')
check('items: sin id = insert', !('id' in p.p_items[1]))
check('codigo normalizado a MAYÚSCULAS', p.p_items[0].codigo === 'MAT-A')
check('orden explícito conservado', p.p_items[0].orden === 0 && p.p_items[1].orden === 1)
check('usuario_id del usuario dado se manda', p.p_usuario_id === 'u-1')
const p0 = payloadRpcEditarRq('rq-1', {}, [], { id: '', nombre: '', correo: '' })
check('usuario_id vacío → null (uuid válido en BD)', p0.p_usuario_id === null)
check('usuario nombre/correo', p.p_usuario_nombre === 'Miguel Hidalgo' && p.p_usuario_correo === 'm@rackly.pe')

// usuario.id con espacios → trimmed; id presente → se manda tal cual
const p2 = payloadRpcEditarRq('rq-2', {}, [], { id: '  u-9  ', nombre: '', correo: '' })
check('usuario_id con espacios se recorta', p2.p_usuario_id === 'u-9')
check('encabezado vacío = {} (edición solo de materiales)', Object.keys(p2.p_encabezado).length === 0)
check('items vacío = [] (no toca materiales)', p2.p_items.length === 0)

// ═══════════════════════════════════════════════════════════════════
// 2) validarEdicionRq — espejo de las reglas de la RPC
// ═══════════════════════════════════════════════════════════════════

// Edición válida completa: corrige cantidad de A, cambia código de B, quita C, agrega D
const edValida = [
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: 'Material A', unidad: 'KG', cantidad: 12 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B2', descripcion: 'Material B corregido', unidad: 'UN', cantidad: 20 },
  { orden: 2, codigo: 'MAT-D', descripcion: 'Nuevo', unidad: 'KG', cantidad: 40 },
]
check('edición completa válida = 0 errores', validarEdicionRq(edValida, ACTUALES).length === 0)

check('RQ sin materiales → error claro', validarEdicionRq([], ACTUALES).length === 1)
check('cantidad 0 → error específico', validarEdicionRq([{ orden: 0, codigo: 'X', descripcion: '', unidad: 'KG', cantidad: 0 }], ACTUALES).some((e) => e.includes('mayor que cero')) === true)
check('sin código → error específico', validarEdicionRq([{ orden: 0, codigo: '  ', descripcion: '', unidad: 'KG', cantidad: 5 }], ACTUALES).some((e) => e.includes('sin código')) === true)
check('duplicado por id → error específico', validarEdicionRq([
  { id: 'a-2', orden: 0, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 1 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 2 },
], ACTUALES).some((e) => e.includes('dos veces')) === true)

// Regla 1 (FIX Task 34): solo rechaza si la edición CRUZA el umbral hacia
// abajo (la cantidad de origen cubría lo atendido y la nueva la deja debajo).
check('cantidad < atendida cruzando el umbral → rechaza', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: '', unidad: 'KG', cantidad: 3 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 2, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).some((e) => e.includes('MAT-A') && e.includes('revierte')) === true)

// Task 34 (regresión del reporte real): RQ atendida CON EXCEDENTE preexistente
// (pedidas 240000, atendidas 255478) — la edición de OTRAS filas NO debe
// bloquearse (antes NINGÚN guardado era posible en esta RQ).
const EXCEDENTE = [
  { id: 'x-1', rqId: 'rq-x', orden: 0, codigo: '56685', descripcion: 'ETIQUETA', unidad: 'UN', cantidad: 240000, cantidadAtendida: 255478, usuarioAtencion: '', atendidoEn: '' },
  { id: 'x-2', rqId: 'rq-x', orden: 1, codigo: '50111', descripcion: 'PREFORMA', unidad: 'UN', cantidad: 240000, cantidadAtendida: 0, usuarioAtencion: '', atendidoEn: '' },
]
check('excedente preexistente + editar OTRA fila → 0 errores (Task 34)', validarEdicionRq([
  { id: 'x-1', orden: 0, codigo: '56685', descripcion: 'ETIQUETA', unidad: 'UN', cantidad: 240000 },
  { id: 'x-2', orden: 1, codigo: '50111', descripcion: 'PREFORMA', unidad: 'UN', cantidad: 250000 },
], EXCEDENTE).length === 0)
check('excedente preexistente + NO tocar la fila → 0 errores (Task 34)', validarEdicionRq([
  { id: 'x-1', orden: 0, codigo: '56685', descripcion: 'ETIQUETA', unidad: 'UN', cantidad: 240000 },
  { id: 'x-2', orden: 1, codigo: '50111', descripcion: 'PREFORMA', unidad: 'UN', cantidad: 240000 },
], EXCEDENTE).length === 0)
check('excedente preexistente + cambiar la cantidad de esa fila → 0 errores', validarEdicionRq([
  { id: 'x-1', orden: 0, codigo: '56685', descripcion: 'ETIQUETA', unidad: 'UN', cantidad: 300000 },
  { id: 'x-2', orden: 1, codigo: '50111', descripcion: 'PREFORMA', unidad: 'UN', cantidad: 240000 },
], EXCEDENTE).length === 0)

// cantidad IGUAL a la atendida SÍ es válida (cierra el material)
check('cantidad = atendida → válido', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: '', unidad: 'KG', cantidad: 5 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 2, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).length === 0)

// Regla 2: identidad congelada con atención registrada
check('cambiar código con atención → rechaza', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-Z', descripcion: '', unidad: 'KG', cantidad: 12 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 2, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).some((e) => e.includes('código ni la unidad')) === true)
check('cambiar unidad con atención → rechaza', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: '', unidad: 'BX', cantidad: 12 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 2, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).some((e) => e.includes('código ni la unidad')) === true)
check('sin atención SÍ se puede cambiar código/unidad', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: '', unidad: 'KG', cantidad: 12 },
  { id: 'a-2', orden: 1, codigo: 'MAT-BX', descripcion: '', unidad: 'BX', cantidad: 20 },
  { id: 'a-3', orden: 2, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).length === 0)

// Regla 3: quitar material con atención registrada
check('quitar material con atención → rechaza', validarEdicionRq([
  { id: 'a-2', orden: 0, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 1, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).some((e) => e.includes('MAT-A') && e.includes('quitarlo')) === true)
check('quitar material SIN atención → válido', validarEdicionRq([
  { id: 'a-1', orden: 0, codigo: 'MAT-A', descripcion: '', unidad: 'KG', cantidad: 12 },
  { id: 'a-2', orden: 1, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
], ACTUALES).length === 0)

// Material fantasma (otro usuario lo eliminó mientras editaba)
check('id inexistente → pide recargar', validarEdicionRq([
  { id: 'fantasma', orden: 0, codigo: 'X', descripcion: '', unidad: 'KG', cantidad: 1 },
  { id: 'a-1', orden: 1, codigo: 'MAT-A', descripcion: '', unidad: 'KG', cantidad: 12 },
  { id: 'a-2', orden: 2, codigo: 'MAT-B', descripcion: '', unidad: 'UN', cantidad: 20 },
  { id: 'a-3', orden: 3, codigo: 'MAT-C', descripcion: '', unidad: 'KG', cantidad: 30 },
], ACTUALES).some((e) => e.includes('recarga')) === true)

// ═══════════════════════════════════════════════════════════════════
// 3) Regresión: helpers intactos tras ampliar RqAtencion (ediciones)
// ═══════════════════════════════════════════════════════════════════

check('estadoDeItem completo', estadoDeItem({ cantidad: 10, cantidadAtendida: 10 }) === 'Atendido')
check('estadoDeItem parcial', estadoDeItem({ cantidad: 10, cantidadAtendida: 3 }) === 'En proceso')
check('estadoDeItem pendiente', estadoDeItem({ cantidad: 10, cantidadAtendida: 0 }) === 'Pendiente')
check('estadoDeItem excedente (atendida > cantidad)', estadoDeItem({ cantidad: 10, cantidadAtendida: 12 }) === 'Atendido')

console.log(`\n${ok} checks OK${process.exitCode ? ' — CON FALLOS' : ''}`)
