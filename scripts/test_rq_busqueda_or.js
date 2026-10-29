/**
 * RACKLY — Tests de la búsqueda del listado de RQ (Atención).
 *
 * Bug 2026-10-29: buscar por CÓDIGO DE MATERIAL ("118" = ÁCIDO CÍTRICO,
 * que vive en rq_atencion_items) devolvía 0 resultados porque listarRqs
 * solo buscaba en 5 columnas del encabezado.
 *
 * FIX: ids de RQ con material coincidente inyectados como id.in.(…)
 * DENTRO del mismo or() del encabezado (ver src/lib/rackly/busqueda-rq.ts).
 *
 * Suite CON STUB de Supabase (sin red): el stub captura los or() emitidos
 * por listarRqs y sirve filas enlatadas de rq_atenciones/rq_atencion_items.
 * Requiere estar listado en CON_STUB de scripts/run_all_tests.sh.
 */
const stub = require('./stubs/supabase_client_stub.js')
const {
  construirOrBusquedaRq,
  MAX_IDS_MATERIALES,
} = require('../src/lib/rackly/busqueda-rq.ts')
const { listarRqs } = require('../src/lib/rackly/rq-atencion.ts')

let ok = 0
let total = 0
function check(nombre, cond) {
  total++
  if (cond) {
    ok++
    console.log(`  ✓ ${nombre}`)
  } else {
    console.log(`  ✗ ${nombre}`)
  }
}

console.log('— construirOrBusquedaRq (lógica pura) —')

// 1. Sin ids de materiales: solo los 5 campos del encabezado.
const soloHeader = construirOrBusquedaRq('118', [])
check('sin ids → 5 miembros', soloHeader.split(',').length === 5)
check(
  'sin ids → campos correctos',
  soloHeader ===
    'numero_rq.ilike.%118%,orden_produccion.ilike.%118%,producto_codigo.ilike.%118%,' +
      'producto_descripcion.ilike.%118%,solicitante.ilike.%118%'
)
check('sin ids → SIN id.in.', !soloHeader.includes('id.in.'))

// 2. Con ids: id.in.(…) como miembro FINAL del mismo or().
const conIds = construirOrBusquedaRq('118', ['aaaaaaaa-1111-2222-3333-444444444444'])
check(
  'con ids → miembro id.in. al final',
  conIds.endsWith('id.in.(aaaaaaaa-1111-2222-3333-444444444444)')
)
check('con ids → 6 miembros', conIds.split(',').length === 6)

// 3. Comma del id.in. cuenta como separador pero PostgREST respeta el
//    paréntesis: los uuids NO deben contener comillas/espacios.
const variosIds = construirOrBusquedaRq('acido', [
  'aaaaaaaa-1111-2222-3333-444444444444',
  'bbbbbbbb-2222-3333-4444-555555555555',
])
check(
  'varios ids → id.in.(a,b)',
  variosIds.includes('id.in.(aaaaaaaa-1111-2222-3333-444444444444,bbbbbbbb-2222-3333-4444-555555555555)')
)

// 4. Higiene de ids: basura filtrada, uuids válidos conservados.
const higiene = construirOrBusquedaRq('x', [
  'aaaaaaaa-1111-2222-3333-444444444444',
  'DROP TABLE users; --',
  '',
  'id con espacios',
  'bbbbbbbb-2222-3333-4444-555555555555',
])
check('ids maliciosos/vacíos filtrados', higiene.includes('id.in.(aaaaaaaa-1111-2222-3333-444444444444,bbbbbbbb-2222-3333-4444-555555555555)'))
check('higiene → sin "DROP" ni espacios', !higiene.includes('DROP') && !/id\.in\.\(.*\s/.test(higiene))

// 5. Tope MAX_IDS_MATERIALES.
const muchos = Array.from({ length: 500 }, (_, i) =>
  `${(i + 1).toString(16).padStart(8, '0')}-1111-2222-3333-444444444444`
)
const capado = construirOrBusquedaRq('x', muchos)
const enIn = capado.split('id.in.(')[1].split(')')[0].split(',').length
check(`tope de ids (${MAX_IDS_MATERIALES}) respetado`, enIn === MAX_IDS_MATERIALES)

// 6. Término con comodines/paréntesis ya saneado aguas arriba no rompe.
const saneo = construirOrBusquedaRq('LIMA PERU', [])
check('término con espacios saneados no rompe', saneo.includes('ilike.%LIMA PERU%'))

console.log('— listarRqs con stub (composición end-to-end) —')

const HEADER = {
  id: 'cccccccc-3333-4444-5555-666666666666',
  created_at: '2026-10-29T10:46:04Z',
  fecha: '2026-10-29',
  numero_rq: '0000192737',
  orden_produccion: 'OP-77',
  producto_codigo: '3000261',
  producto_descripcion: 'BEBIDA X 500ML',
  turno: 'T1',
  turno_rq: 'T1',
  solicitante: 'ENRIQUEZ, JHONNIE',
  estado: 'Atendido',
  linea: 'L1',
  notas: '',
  foto_url: '',
}

async function correrCaso(nombre, { items, headers, filtros }, aserciones) {
  stub.__clear()
  stub.__setTable('rq_atenciones', headers)
  stub.__setTable('rq_atencion_items', items)
  const res = await listarRqs(filtros)
  const ors = stub.__orCalls()
  const orRq = ors.filter((o) => o.table === 'rq_atenciones')
  const orItems = ors.filter((o) => o.table === 'rq_atencion_items')
  aserciones(res, { orRq, orItems })
  check(`${nombre} — sin excepción`, true)
}

;(async () => {
  // CASO A: término "118" — material en items → id.in. inyectado en el
  // or() del encabezado (semántica «encabezado O material»).
  await correrCaso(
    'A búsqueda por material',
    {
      items: [
        { rq_id: 'aaaaaaaa-1111-2222-3333-444444444444' },
        { rq_id: 'bbbbbbbb-2222-3333-4444-555555555555' },
      ],
      headers: [HEADER],
      filtros: { busqueda: '118', estado: '', fecha: '2026-10-29', turno: 'T1', limit: 50, offset: 0 },
    },
    (res, { orRq, orItems }) => {
      check('A — filas devueltas (1)', res.filas.length === 1 && res.filas[0].numeroRq === '0000192737')
      check('A — total exacto 1', res.total === 1)
      check('A — dos or() a rq_atenciones (búsqueda + turno T1)', orRq.length === 2)
      const expr = orRq[0].value
      check('A — 5 campos header + id.in.', expr.split(',').length === 5 + 2)
      check(
        'A — id.in. con los 2 uuids',
        expr.includes('id.in.(aaaaaaaa-1111-2222-3333-444444444444,bbbbbbbb-2222-3333-4444-555555555555)')
      )
      check('A — or() emitido a rq_atencion_items (prelookup)', orItems.length === 1)
      check(
        'A — prelookup busca codigo+descripcion',
        orItems[0].value === 'codigo.ilike.%118%,descripcion.ilike.%118%'
      )
    }
  )

  // CASO B: término sin coincidencias en items → or() de encabezado puro.
  // (stub es ciego a filtros: para «sin coincidencia» la tabla items va vacía)
  await correrCaso(
    'B sin coincidencia en items',
    {
      items: [],
      headers: [HEADER],
      filtros: { busqueda: '999', estado: '', fecha: '', turno: '', limit: 50, offset: 0 },
    },
    (res, { orRq, orItems }) => {
      const expr = orRq[0].value
      check('B — or() SIN id.in.', expr.split(',').length === 5 && !expr.includes('id.in.'))
      check('B — items consultado igualmente', orItems.length === 1)
    }
  )

  // CASO C: sin búsqueda → NINGÚN or() al encabezado; filtro turno intacto.
  await correrCaso(
    'C sin término, con turno',
    {
      items: [],
      headers: [HEADER],
      filtros: { busqueda: '', estado: '', fecha: '2026-10-29', turno: 'T2', limit: 50, offset: 0 },
    },
    (res, { orRq, orItems }) => {
      check('C — solo el or() de turno (T2), sin búsqueda', orRq.length === 1)
      check(
        'C — or() de turno T2 exacto',
        orRq[0].value === 'turno_rq.eq.T2,and(turno_rq.is.null,turno.eq.T2)'
      )
      check('C — sin prelookup de items', orItems.length === 0)
    }
  )

  // CASO D: término con caracteres peligrosos → saneado por
  // terminoBusquedaSeguro (la coma de "118, ACIDO" no rompe el or()).
  await correrCaso(
    'D término peligroso saneado',
    {
      items: [{ rq_id: 'eeeeeeee-5555-6666-7777-888888888888' }],
      headers: [HEADER],
      filtros: { busqueda: '118, ACIDO (KG)', estado: '', fecha: '', turno: '', limit: 50, offset: 0 },
    },
    (res, { orRq, orItems }) => {
      const expr = orRq[0].value
      check('D — sin comas del término en la expresión', !expr.includes('%118,') && !expr.includes('%ACIDO'))
      check('D — término saneado presente', expr.includes('ilike.%118 ACIDO KG%'))
      check('D — prelookup usa término saneado', orItems[0].value === 'codigo.ilike.%118 ACIDO KG%,descripcion.ilike.%118 ACIDO KG%')
    }
  )

  // CASO E: búsqueda + turno → DOS or() al encabezado (PostgREST los ANDA);
  // el or() de turno (Task 35) queda intacto tras el fix.
  await correrCaso(
    'E filtro turno intacto',
    {
      items: [],
      headers: [HEADER],
      filtros: { busqueda: '192811', estado: '', fecha: '2026-10-29', turno: 'T1', limit: 50, offset: 0 },
    },
    (res, { orRq }) => {
      check('E — dos or(): búsqueda + turno', orRq.length === 2)
      check('E — búsqueda sin id.in. (items vacíos)', !orRq[0].value.includes('id.in.'))
      check(
        'E — or() de turno exacto (fallback histórico)',
        orRq[1].value === 'turno_rq.eq.T1,and(turno_rq.is.null,turno.eq.T1)'
      )
    }
  )

  console.log('— resultado —')
  console.log(`${ok}/${total} checks OK`)
  if (ok !== total) process.exit(1)
})().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
