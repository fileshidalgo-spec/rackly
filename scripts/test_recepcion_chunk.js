/**
 * RACKLY — Tests del chunking de crearRecepciones (auditoría 2026-10-16).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_recepcion_chunk.js --bundle --platform=node \
 *     --alias:@=/home/z/my-project/rackly/src \
 *     --alias:@/lib/supabase/client=/home/z/my-project/rackly/scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr \
 *     --outfile=scripts/.testbuild/test_recepcion_chunk.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_recepcion_chunk.cjs
 *
 * Regresión: crearRecepciones insertaba TODAS las filas en UNA petición
 * (30 artículos × 44 paletas = hasta 1.320 filas → riesgo timeout/413,
 * todo-o-nada). Ahora: chunks de 500.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const { crearRecepciones } = require('@/lib/rackly/modulos')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ── Instrumentación del stub: registrar tamaños de insert y error inyectable ──
const insertSizes = []
let insertHandler = null
const realFrom = supabaseStub.dataClient.from.bind(supabaseStub.dataClient)
supabaseStub.dataClient.from = (t) => {
  const b = realFrom(t)
  if (t === 'recepcion_registros') {
    b.insert = (payload) => {
      insertSizes.push(Array.isArray(payload) ? payload.length : 1)
      if (insertHandler) return insertHandler(payload)
      return Promise.resolve({ data: null, error: null })
    }
  }
  return b
}

const USUARIO = { id: 'u1', nombre: 'Test', correo: 't@t.co' }

function items(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      fecha: '2026-10-16',
      tipoDocumento: 'GUIA',
      numeroDocumento: `T-${i}`,
      proveedor: 'PROV',
      codigo: `C${String(i).padStart(4, '0')}`,
      descripcion: 'Desc',
      cantidad: 1,
      unidadMedida: 'KG',
      lote: '',
      placa: 'ABC-123',
      observaciones: '',
      uuidSync: `uuid-${String(i).padStart(6, '0')}`,
    })
  }
  return out
}

async function main() {
  console.log('— crearRecepciones chunking —')

  // 1) 1.200 filas → 3 inserts (500/500/200)
  insertSizes.length = 0
  insertHandler = null
  await crearRecepciones(items(1200), USUARIO)
  check('1200 filas → 3 chunks', insertSizes.length === 3, `obtuvo ${insertSizes.length}: ${insertSizes}`)
  check('tamaños 500/500/200', JSON.stringify(insertSizes) === '[500,500,200]', JSON.stringify(insertSizes))

  // 2) < 500 filas → 1 solo chunk
  insertSizes.length = 0
  await crearRecepciones(items(120), USUARIO)
  check('120 filas → 1 chunk', insertSizes.length === 1 && insertSizes[0] === 120, JSON.stringify(insertSizes))

  // 3) error en el chunk 2 se propaga (todo-o-nada por chunk, visible al usuario)
  insertSizes.length = 0
  insertHandler = (payload) => {
    if (insertSizes.length === 2) return Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } })
    return Promise.resolve({ data: null, error: null })
  }
  let lanzo = false
  try { await crearRecepciones(items(1200), USUARIO) } catch { lanzo = true }
  check('error en chunk 2 se propaga', lanzo && insertSizes.length === 2, `lanzamiento=${lanzo} chunks=${insertSizes.length}`)

  // 4) error 23505 → mensaje de duplicado amigable (idempotencia intacta)
  insertSizes.length = 0
  insertHandler = () => Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } })
  let msg = ''
  try { await crearRecepciones(items(10), USUARIO) } catch (e) { msg = e.message }
  check('23505 → REGISTRO_DUPLICADO', msg.startsWith('REGISTRO_DUPLICADO'), msg)

  console.log(`\n${passed} OK / ${failed} FALLOS`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
