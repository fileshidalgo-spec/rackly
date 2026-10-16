/**
 * RACKLY — Tests de la regla de turno de RECEPCIÓN (T1/T2).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_turno_recepcion.js --bundle --platform=node --outfile=/tmp/test_turno.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/test_turno.cjs
 *
 * Regla (hora de Lima, America/Lima — sin DST):
 *   T1 = 07:20:00 → 19:20:59 (inclusive)   T2 = 19:21:00 → 07:19:59
 * Las fechas de prueba se expresan con offset -05:00 explícito (Lima) o
 * en UTC — el cálculo DEBE dar lo mismo: nunca usa la zona del host.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const { calcularTurnoRecepcion } = require('@/lib/rackly/turno')
const { TURNO_T1, TURNO_T2 } = require('@/lib/rackly/constants')

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

// [iso, esperado] — cubre TODAS las fronteras de la regla
const CASOS = [
  ['2026-10-16T12:19:00Z', TURNO_T2],  // 07:19:00 Lima → T2 (último minuto)
  ['2026-10-16T12:20:00Z', TURNO_T1],  // 07:20:00 Lima → T1 (primer minuto)
  ['2026-10-16T12:20:59Z', TURNO_T1],  // 07:20:59 Lima → T1
  ['2026-10-16T17:00:00Z', TURNO_T1],  // 12:00:00 Lima → T1 (pleno día)
  ['2026-10-17T00:20:00Z', TURNO_T1],  // 19:20:00 Lima → T1 (último minuto)
  ['2026-10-17T00:20:59Z', TURNO_T1],  // 19:20:59 Lima → T1 (inclusive)
  ['2026-10-17T00:21:00Z', TURNO_T2],  // 19:21:00 Lima → T2 (primer minuto)
  ['2026-10-17T04:59:00Z', TURNO_T2],  // 23:59:00 Lima → T2
  ['2026-10-16T05:00:00Z', TURNO_T2],  // 00:00:00 Lima → T2
  ['2026-10-16T10:42:21Z', TURNO_T2],  // 05:42:21 Lima → T2 (CASO REAL de la guía T012-00000184)
]

console.log('\n[1] calcularTurnoRecepcion — todas las fronteras (hora Lima)')
for (const [iso, esperado] of CASOS) {
  const d = new Date(iso)
  const got = calcularTurnoRecepcion(d)
  check(`${iso} → ${esperado}`, got === esperado, `salió ${got}`)
}

console.log('\n[2] independencia de la zona del host (siempre Lima)')
// El mismo instante escrito en 3 zonas distintas → mismo turno
const instante = '2026-10-16T12:20:00Z' // 07:20 Lima
const variantes = [
  '2026-10-16T12:20:00+00:00',      // UTC
  '2026-10-16T07:20:00-05:00',      // Lima
  '2026-10-16T14:20:00+02:00',      // Madrid verano
]
const resultados = new Set(variantes.map((v) => calcularTurnoRecepcion(new Date(v))))
check('instante en UTC/Lima/Madrid → un único turno T1', resultados.size === 1 && resultados.has(TURNO_T1), [...resultados].join(','))

console.log('\n[3] el turno Día/Noche de Kardex NO cambió (regla 07:45/19:45)')
const { calcularTurno } = require('@/lib/rackly/turno')
check('07:44 Lima → Noche', calcularTurno(new Date('2026-10-16T12:44:00Z')) === 'Noche')
check('07:45 Lima → Día', calcularTurno(new Date('2026-10-16T12:45:00Z')) === 'Día')
check('19:44 Lima → Día', calcularTurno(new Date('2026-10-17T00:44:00Z')) === 'Día')
check('19:45 Lima → Noche', calcularTurno(new Date('2026-10-17T00:45:00Z')) === 'Noche')

console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
