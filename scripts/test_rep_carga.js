/**
 * RACKLY · Tests REPUESTOS — Carga masiva por lotes (repUpsertArticulosLote).
 *
 * Usa el STUB de Supabase (alias en run_all_tests.sh): verifica el loteo
 * (500 por lote), la normalización de códigos, la barra de progreso y el
 * manejo honesto de errores por lote. UPSERT por código: re-subir un
 * Excel NO duplica (acordado con el usuario).
 *
 * Ejecutar: bash scripts/run_all_tests.sh (suite CON_STUB)
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const stub = require('@/lib/supabase/client')
const { repUpsertArticulosLote, repNormalizarCodigo } = require('@/lib/rackly/rep/rep-client')

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

async function main() {
  // ── [1] Loteo: 1200 filas → 3 lotes (500 + 500 + 200) ──
  console.log('\n[1] Loteo de 500 filas por llamada')
  stub.__clear()
  const filas = Array.from({ length: 1200 }, (_, i) => ({
    fila: i + 2,
    codigo: `rep-${String(i + 1).padStart(5, '0')}`,
    descripcion: `Repuesto ${i + 1}`,
    und: 'UND',
    cantidad_ref: i,
  }))
  const progreso = []
  const res1 = await repUpsertArticulosLote(filas, (hechas, total) => progreso.push([hechas, total]))
  const calls = stub.__upsertCalls()
  check('3 lotes para 1200 filas', calls.length === 3, `recibidos ${calls.length}`)
  check('lote 1 tiene 500', calls[0].payload.length === 500)
  check('lote 2 tiene 500', calls[1].payload.length === 500)
  check('lote 3 tiene 200', calls[2].payload.length === 200)
  check('resultado ok = 1200', res1.ok === 1200, `ok=${res1.ok}`)
  check('sin errores', res1.errores.length === 0)
  check('upsert con onConflict codigo', calls[0].opts && calls[0].opts.onConflict === 'codigo')
  check('progreso termina en (1200, 1200)', progreso.length > 0 && progreso[progreso.length - 1][0] === 1200 && progreso[progreso.length - 1][1] === 1200)

  // ── [2] Normalización dentro del lote (código en mayúsculas) ──
  console.log('\n[2] Normalización de códigos en el payload')
  check('código "rep-00001" → "REP-00001"', calls[0].payload[0].codigo === 'REP-00001')
  check('lleva activo=true', calls[0].payload[0].activo === true)
  check('lleva cantidad_ref', calls[0].payload[0].cantidad_ref === 0)
  check('repNormalizarCodigo trim+mayúsculas', repNormalizarCodigo('  bj-109 ') === 'BJ-109')

  // ── [3] Error en un lote: reporte honesto (el lote falla, el resto pasa) ──
  console.log('\n[3] Error en un lote → se reporta y la carga continúa')
  stub.__clear()
  stub.__setUpsertResult({ data: null, error: { message: 'NEW_VIOLATES_RLS_POLICY|denegado' } })
  const pocas = [
    { fila: 2, codigo: 'A-1', descripcion: 'uno', und: 'UND', cantidad_ref: 1 },
    { fila: 3, codigo: 'A-2', descripcion: 'dos', und: 'UND', cantidad_ref: 2 },
    { fila: 4, codigo: 'A-3', descripcion: 'tres', und: 'UND', cantidad_ref: 3 },
  ]
  const res3 = await repUpsertArticulosLote(pocas)
  check('1 lote para 3 filas', stub.__upsertCalls().length === 1)
  check('ok = 0 (lote rechazado)', res3.ok === 0)
  check('error reportado con rango de filas', res3.errores.length === 1 && res3.errores[0].includes('Filas 1–3'), res3.errores[0] ?? '')

  // ── [4] Lote exacto: 500 → 1 sola llamada ──
  console.log('\n[4] Borde: exactamente 500 filas = 1 lote')
  stub.__clear()
  const exacto = Array.from({ length: 500 }, (_, i) => ({
    fila: i + 2, codigo: `E-${i}`, descripcion: `d ${i}`, und: '', cantidad_ref: 0,
  }))
  await repUpsertArticulosLote(exacto)
  check('1 llamada', stub.__upsertCalls().length === 1)

  // ── Resumen ──
  console.log(`\n════════ RESULTADO: ${ok} pasados ════════`)
  if (process.exitCode !== 1) console.log('OK test_rep_carga')
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
