/**
 * RACKLY — Tests unitarios M-2: identidad de guía (guia_id) + auto-estatus.
 *
 * Ejecutar:
 *   npx esbuild scripts/test_recepcion_guia_id.js --bundle --platform=node --outfile=/tmp/test_guia_id.cjs --alias:@=/home/z/my-project/rackly-repo/src --loader:.ts=ts && node /tmp/test_guia_id.cjs
 *
 * Escenarios (corrección del reporte 2026-10):
 *   1. claveGuiaDe: con guia_id → identidad EXACTA (G:<uuid>).
 *   2. Dos guías con el MISMO Nº de documento pero guia_id distinto
 *      (re-registro en otra fecha) quedan SEPARADAS — impresión/editado/
 *      estado/borrado jamás las cruzan ("que al imprimir solo salga la guía").
 *   3. Respaldo heredado intacto: filas SIN guia_id agrupan como antes
 *      (con Nº → tipo+número; sin Nº → fecha+tipo+proveedor).
 *   4. Guías sin Nº el MISMO día pero con guia_id propio NO se fusionan.
 *   5. agruparGuias: ref.guiaId propagado para operar la guía exacta.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const { agruparGuias, claveGuiaDe } = require('@/lib/rackly/recepcion-filas')

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

const filaBase = {
  id: 'f1',
  createdAt: '2026-10-16T12:00:00Z',
  fecha: '2026-10-15',
  tipoDocumento: 'Guia',
  numeroDocumento: 'T173-00004159',
  proveedor: 'AJEPER S.A.',
  placa: 'ABC123',
  fotoUrl: '',
  estado: 'Pendiente',
  usuarioId: 'u1',
  usuarioNombre: 'Walter',
  usuarioCorreo: 'w@x.com',
  codigo: '5653',
  descripcion: 'Botella 500ml',
  cantidad: 24,
  unidadMedida: 'CS',
  lote: 'L1',
  fechaProduccion: '',
  fechaVencimiento: '',
  observaciones: '',
  enviosTransito: 0,
}

// ─── 1. claveGuiaDe con guia_id ───
console.log('\n── 1. Identidad EXACTA con guia_id ──')
check('con guia_id → G:<uuid>', claveGuiaDe({ ...filaBase, guiaId: '11111111-1111-4111-8111-111111111111' }) === 'G:11111111-1111-4111-8111-111111111111')
check('guia_id vacío → respaldo D:<tipo>|<nº>', claveGuiaDe({ ...filaBase, guiaId: '' }).startsWith('D:GUIA|T173-00004159'))
check('null → respaldo igual', claveGuiaDe({ ...filaBase, guiaId: null }).startsWith('D:'))
check('sin guia_id ni Nº → S:<fecha>|<tipo>|<prov>', claveGuiaDe({ ...filaBase, guiaId: null, numeroDocumento: '' }).startsWith('S:2026-10-15|GUIA|AJEPER'))

// ─── 2. Mismo Nº, guia_id distinto → SEPARADAS (el fix de impresión) ───
console.log('\n── 2. Mismo Nº en guías distintas (guia_id separa) ──')
const gid1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const gid2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const guias = agruparGuias([
  { ...filaBase, id: 'f1', guiaId: gid1, fecha: '2026-10-01', codigo: '5653', cantidad: 10 },
  { ...filaBase, id: 'f2', guiaId: gid2, fecha: '2026-10-15', codigo: '9901', cantidad: 20 },
])
check('mismo Nº, distinta recepción → DOS guías separadas', guias.length === 2, `obtuvo ${guias.length}`)
check('cada grupo conserva SU guiaId', guias.every((g) => g.ref.guiaId === (g.filas[0].guiaId ?? null)))
check('cantidades no mezcladas', guias.find((g) => g.ref.guiaId === gid1)?.cantidadTotal === 10 && guias.find((g) => g.ref.guiaId === gid2)?.cantidadTotal === 20)

// ─── 3. Respaldo heredado intacto (filas sin guia_id) ───
console.log('\n── 3. Respaldo heredado (sin guia_id) ──')
const legacy = agruparGuias([
  { ...filaBase, id: 'f1', guiaId: null, codigo: '5653', cantidad: 5 },
  { ...filaBase, id: 'f2', guiaId: null, codigo: '9901', cantidad: 7 },
])
check('mismo tipo+Nº (sin guia_id) → sigue fusionándose (compatibilidad)', legacy.length === 1 && legacy[0].filas.length === 2)
const sinNum = agruparGuias([
  { ...filaBase, id: 'f3', guiaId: null, numeroDocumento: '', codigo: '5653' },
  { ...filaBase, id: 'f4', guiaId: null, numeroDocumento: '', codigo: '9901' },
])
check('sin Nº: fecha+tipo+proveedor agrupa (compatibilidad)', sinNum.length === 1)

// ─── 4. Sin Nº el MISMO día, con guia_id propio → NO se fusionan ───
console.log('\n── 4. Guías sin Nº el mismo día (guia_id separa) ──')
const sinNumHoy = agruparGuias([
  { ...filaBase, id: 'f5', guiaId: gid1, numeroDocumento: '', codigo: '5653', cantidad: 3 },
  { ...filaBase, id: 'f6', guiaId: gid2, numeroDocumento: '', codigo: '9901', cantidad: 4 },
])
check('dos recepciones sin Nº el mismo día → separadas', sinNumHoy.length === 2, `obtuvo ${sinNumHoy.length}`)

// ─── 5. agruparGuias propaga ref.guiaId + paletas ───
console.log('\n── 5. Propagación de identidad para operar la guía exacta ──')
const conPaletas = agruparGuias([
  { ...filaBase, id: 'p1', guiaId: gid1, observaciones: 'Paleta 1/2', cantidad: 10 },
  { ...filaBase, id: 'p2', guiaId: gid1, observaciones: 'Paleta 2/2', cantidad: 14 },
])
check('guía con paletas agrupa en UNA', conPaletas.length === 1 && conPaletas[0].filas.length === 2)
check('ref.guiaId disponible para imprimir/editar/estado/borrar', conPaletas[0].ref.guiaId === gid1)
check('ref hereda los datos del documento', conPaletas[0].ref.numeroDocumento === 'T173-00004159' && conPaletas[0].ref.proveedor === 'AJEPER S.A.')

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
