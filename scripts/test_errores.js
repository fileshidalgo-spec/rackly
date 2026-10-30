/**
 * RACKLY — Tests del extractor canónico de errores (lib/rackly/errores.ts).
 * Ejecutar:
 *   npx esbuild scripts/test_errores.js --bundle --platform=node \
 *     --outfile=scripts/.testbuild/test_errores.cjs --alias:@=./src --loader:.ts=ts \
 *   && node scripts/.testbuild/test_errores.cjs
 *
 * Caso real que motivó el módulo (2026-10-29): PostgrestError OBJETO PLANO
 * (supabase-js sin throwOnError) + String(err) → «[object Object]» al escanear
 * un QR en Tránsito.
 */
const assert = require('assert')
const { mensajeError } = require('@/lib/rackly/errores')
const { mensajeRpcError } = require('@/lib/rackly/transito-core')
const { extractError } = require('@/lib/utils')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log('  ✓', nombre)
  } catch (e) {
    console.error('  ✗', nombre, '\n    ', e.message)
    process.exitCode = 1
  }
}

console.log('mensajeError — formas de error')

// ── 1) PostgrestError PLANO (el bug real) ──
t('objeto plano {message,details,hint,code} → message real (NO "[object Object]")', () => {
  const err = {
    message: 'OVER_ISSUE|La cantidad a transferir (81000) excede el pendiente de 37934 (0): excedente 81000',
    details: null,
    hint: null,
    code: 'P0001',
  }
  const out = mensajeError(err)
  assert.strictEqual(out, 'La cantidad a transferir (81000) excede el pendiente de 37934 (0): excedente 81000')
  assert.ok(!out.includes('object Object'))
})

t('objeto plano solo message', () => {
  assert.strictEqual(mensajeError({ message: 'JWT expired' }), 'JWT expired')
})

t('objeto plano con details/hint que aportan → join con puntos', () => {
  const out = mensajeError({ message: 'La fila ya no existe', details: 'PGRST116', hint: 'Verifica el id' })
  assert.ok(out.startsWith('La fila ya no existe'), out)
  assert.ok(out.includes('Verifica el id'), out)
})

t('objeto plano con details/hint YA incluidos en message → no duplica', () => {
  const out = mensajeError({ message: 'Fallo X. Verifica el id', hint: 'Verifica el id' })
  assert.strictEqual(out, 'Fallo X. Verifica el id')
})

// ── 2) Convención CODE|detalle de las RPCs ──
t('quita prefijo CODE| (detalle legible)', () => {
  assert.strictEqual(mensajeError('NO_AUTORIZADO|Solo usuarios autenticados'), 'Solo usuarios autenticados')
})

t('FECHA_INVALIDA|… → detalle', () => {
  const out = mensajeError({
    message: 'FECHA_INVALIDA|El año del vencimiento (3027) es inválido: debe estar entre 2000 y 2100',
  })
  assert.strictEqual(out, 'El año del vencimiento (3027) es inválido: debe estar entre 2000 y 2100')
})

// ── 3) Error nativo ──
t('Error simple → message', () => {
  assert.strictEqual(mensajeError(new Error('simple')), 'simple')
})

t('Error con CODE| → detalle (compat mensajeRpcError)', () => {
  assert.strictEqual(mensajeError(new Error('OVER_ISSUE|La cantidad excede el pendiente')), 'La cantidad excede el pendiente')
})

t('Error INSUFFICIENT_STOCK con .detail (forma legada addMovimiento) → detail', () => {
  const e = new Error('INSUFFICIENT_STOCK')
  e.detail = 'Stock actual = 0 UN, cantidad solicitada = 5'
  assert.strictEqual(mensajeError(e), 'Stock actual = 0 UN, cantidad solicitada = 5')
})

// ── 4) Otros tipos ──
t('string suelto → tal cual', () => {
  assert.strictEqual(mensajeError('fallo de red'), 'fallo de red')
})

t('string con CODE| → detalle', () => {
  assert.strictEqual(mensajeError('INSUFFICIENT_STOCK|Stock actual = 3'), 'Stock actual = 3')
})

t('{error:"…"} → el campo error', () => {
  assert.strictEqual(mensajeError({ error: 'correo ya registrado' }), 'correo ya registrado')
})

t('{msg:"…"} → el campo msg', () => {
  assert.strictEqual(mensajeError({ msg: 'cualquier cosa' }), 'cualquier cosa')
})

t('objeto sin message → JSON.stringify (nunca "[object Object]")', () => {
  const out = mensajeError({ foo: 1, bar: { baz: 2 } })
  assert.ok(out.includes('"foo"') && out.includes('"baz"'), out)
  assert.ok(!out.includes('object Object'))
})

t('null / undefined / vacío → "Error desconocido"', () => {
  assert.strictEqual(mensajeError(null), 'Error desconocido')
  assert.strictEqual(mensajeError(undefined), 'Error desconocido')
  assert.strictEqual(mensajeError(''), 'Error desconocido')
})

t('number → String', () => {
  assert.strictEqual(mensajeError(42), '42')
})

// ── 5) Compatibilidad de los wrappers históricos ──
console.log('\nmensajeRpcError (transito-core) y extractError (utils) — mismo contrato')
t('mensajeRpcError: mismos resultados que antes para Error', () => {
  assert.strictEqual(mensajeRpcError(new Error('OVER_ISSUE|La cantidad excede el pendiente')), 'La cantidad excede el pendiente')
  assert.strictEqual(mensajeRpcError(new Error('simple')), 'simple')
})
t('mensajeRpcError: NUEVO — objeto plano PostgrestError → mensaje real', () => {
  const out = mensajeRpcError({ message: 'UBICACION_RACK_REQUERIDA|Falta la ubicación del rack', code: 'P0001' })
  assert.strictEqual(out, 'Falta la ubicación del rack')
})
t('extractError: compat INSUFFICIENT_STOCK Error con detail', () => {
  const e = new Error('INSUFFICIENT_STOCK')
  e.detail = 'Stock actual = 0 UN, cantidad solicitada = 5'
  assert.strictEqual(extractError(e), 'Stock actual = 0 UN, cantidad solicitada = 5')
})
t('extractError: compat objeto con message (sin cambio visible)', () => {
  assert.strictEqual(extractError({ message: 'no autorizado' }), 'no autorizado')
})
t('extractError: NUEVO — PostgrestError plano → message (antes JSON.stringify)', () => {
  assert.strictEqual(extractError({ message: 'columna no existe', code: '42703' }), 'columna no existe')
})

// ── 6) Errores CONTROLADOS (auditoría 2026-10-30, R1) ──
// El bug real: Recepción lanzaba Error('REGISTRO_CANCELADO|…') y la UI
// branqueaba con message.startsWith('REGISTRO_CANCELADO|') — pero mensajeError
// ya había quitado el prefijo → CÓDIGO MUERTO: cancelar un duplicado se
// pintaba como error rojo en vez de aviso. El código ahora viaja en Error.name.
console.log('\nerrores controlados — código en Error.name (sobrevive a mensajeError)')
const { errorControlado, codigoControladoDe, ERR_CANCELADO, ERR_DUPLICADO } = require('@/lib/rackly/errores')

t('errorControlado: name = código · message = texto legible', () => {
  const e = errorControlado(ERR_CANCELADO, 'Registro cancelado por posible duplicado.')
  assert.strictEqual(e.name, 'REGISTRO_CANCELADO')
  assert.strictEqual(e.message, 'Registro cancelado por posible duplicado.')
})

t('codigoControladoDe: recupera el código DESPUÉS de mensajeError', () => {
  const e = errorControlado(ERR_DUPLICADO, 'Estas filas ya fueron registradas (reintento detectado).')
  const msg = mensajeError(e) // el flujo real de la UI: mensajeError primero
  assert.strictEqual(msg, 'Estas filas ya fueron registradas (reintento detectado).')
  assert.strictEqual(codigoControladoDe(e), 'REGISTRO_DUPLICADO')
})

t('codigoControladoDe: null para errores nativos y no-Error', () => {
  assert.strictEqual(codigoControladoDe(new TypeError('x')), null)
  assert.strictEqual(codigoControladoDe(new Error('x')), null)
  assert.strictEqual(codigoControladoDe({ name: 'REGISTRO_CANCELADO' }), null) // objeto plano
  assert.strictEqual(codigoControladoDe('REGISTRO_CANCELADO|algo'), null)
  assert.strictEqual(codigoControladoDe(null), null)
})

t('flujo UI completo: branch por codigoControladoDe + toast.info (no error rojo)', () => {
  // Simula el catch de RecepcionModule/GuiaFotoForm.
  function clasificar(err) {
    const codigo = codigoControladoDe(err)
    const message = mensajeError(err)
    if (codigo === ERR_CANCELADO) return 'info'
    if (codigo === ERR_DUPLICADO) return 'warning'
    return 'error'
  }
  assert.strictEqual(clasificar(errorControlado(ERR_CANCELADO, 'Registro cancelado: el documento ya estaba registrado.')), 'info')
  assert.strictEqual(clasificar(errorControlado(ERR_DUPLICADO, 'Estas filas ya fueron registradas.')), 'warning')
  assert.strictEqual(clasificar(new Error('fallo de red')), 'error')
  assert.strictEqual(clasificar({ message: 'P0001|algo' }), 'error')
})

console.log(`\n${ok} checks OK${process.exitCode ? ' (con fallos)' : ''}`)
