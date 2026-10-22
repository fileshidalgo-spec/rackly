#!/usr/bin/env node
/**
 * RACKLY — Task 15 · Unificación de catálogo (fuente única: catálogo de Racks).
 * Suite pura de `fusionarInfoBloques` (piso/api.ts) — sin BD: la función es
 * pura y recibe los datos ya consultados.
 * Ejecutada por scripts/run_all_tests.sh (esbuild → node).
 * Requiere el STUB de Supabase (api.ts importa dataClient al cargar):
 *   npx esbuild scripts/test_piso_catalogo_unico.js --bundle --platform=node \
 *     --alias:@=./src --alias:@/lib/supabase/client=./scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr --outfile=scripts/.testbuild/test_piso_catalogo_unico.cjs \
 *     --loader:.ts=ts && node scripts/.testbuild/test_piso_catalogo_unico.cjs
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
const assert = require('assert')
const { fusionarInfoBloques } = require('@/lib/piso/api.ts')

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

// ── Fixtures ──
const ANCLAS = [
  { id: 'uuid-1', codigo: '52210' },
  { id: 'uuid-2', codigo: 'MUESTRASVARIAS' },
  { id: 'uuid-3', codigo: '52555' },
]
const CAT = [
  { codigo: '52210', descripcion: 'PREFORMA PET 15.7 GRS (DESCRIPCIÓN VIGENTE)', un: 'UN' },
  { codigo: '52555', descripcion: 'OXTERIL 350 BATH', un: 'KG' },
]
const PISO = [
  // código histórico fuera de catálogo con datos propios
  { codigo: 'MUESTRASVARIAS', descripcion: 'Articulo nuevo (manual)', unidad: 'KG' },
]

// ── 1. Catálogo GANA: id real anclado cuyo código existe en catálogo ──
{
  const m = fusionarInfoBloques(['uuid-1'], ANCLAS, CAT, PISO)
  const info = m.get('uuid-1')
  check('id real + código en catálogo → descripción del CATÁLOGO', info?.descripcion === 'PREFORMA PET 15.7 GRS (DESCRIPCIÓN VIGENTE)')
  check('id real + código en catálogo → unidad del catálogo (un)', info?.unidad === 'UN')
  check('id real + código en catálogo → codigo normalizado', info?.codigo === '52210')
}

// ── 2. Respaldo histórico: código solo en piso_bloques ──
{
  const m = fusionarInfoBloques(['uuid-2'], ANCLAS, CAT, PISO)
  const info = m.get('uuid-2')
  check('código histórico (no en catálogo) → datos de piso_bloques', info?.descripcion === 'Articulo nuevo (manual)' && info?.unidad === 'KG')
}

// ── 3. Id virtual cat_<codigo>: catálogo gana, sin ancla necesaria ──
{
  const m = fusionarInfoBloques(['cat_52555'], ANCLAS, CAT, PISO)
  const info = m.get('cat_52555')
  check('id virtual cat_ → info del catálogo', info?.codigo === '52555' && info?.descripcion === 'OXTERIL 350 BATH' && info?.unidad === 'KG')
}

// ── 4. Id virtual manual_<codigo> sin registro → texto manual + KG ──
{
  const m = fusionarInfoBloques(['manual_XX999'], [], [], [])
  const info = m.get('manual_XX999')
  check('manual_ sin registro → "Articulo nuevo (manual)" + KG', info?.descripcion === 'Articulo nuevo (manual)' && info?.unidad === 'KG')
}

// ── 5. manual_ con datos en catálogo → catálogo gana (no el texto manual) ──
{
  const m = fusionarInfoBloques(['manual_52210'], [], CAT, [])
  const info = m.get('manual_52210')
  check('manual_ con código en catálogo → catálogo gana', info?.descripcion === 'PREFORMA PET 15.7 GRS (DESCRIPCIÓN VIGENTE)' && info?.unidad === 'UN')
}

// ── 6. manual_ con datos históricos de piso → piso gana ──
{
  const m = fusionarInfoBloques(['manual_MUESTRASVARIAS'], [], [], PISO)
  const info = m.get('manual_MUESTRASVARIAS')
  check('manual_ con histórico en piso → datos de piso', info?.descripcion === 'Articulo nuevo (manual)')
}

// ── 7. Id real sin ancla y no virtual → omitido (no inventa datos) ──
{
  const m = fusionarInfoBloques(['uuid-desconocido'], ANCLAS, CAT, PISO)
  check('id real sin ancla → fuera del mapa', !m.has('uuid-desconocido'))
}

// ── 8. Mezcla completa (los 3 tipos en una sola resolución) ──
{
  const m = fusionarInfoBloques(['uuid-1', 'cat_52555', 'manual_MUESTRASVARIAS', 'manual_NUEVO'], ANCLAS, CAT, PISO)
  check('mezcla: ancla→catálogo', m.get('uuid-1')?.descripcion === 'PREFORMA PET 15.7 GRS (DESCRIPCIÓN VIGENTE)')
  check('mezcla: cat_→catálogo', m.get('cat_52555')?.descripcion === 'OXTERIL 350 BATH')
  check('mezcla: manual_→histórico piso', m.get('manual_MUESTRASVARIAS')?.descripcion === 'Articulo nuevo (manual)')
  check('mezcla: manual_ nuevo→texto manual', m.get('manual_NUEVO')?.descripcion === 'Articulo nuevo (manual)')
  check('mezcla: 4 ids resueltos', m.size === 4)
}

// ── 9. Normalización: catálogo/piso con espacios o minúsculas ──
{
  const m = fusionarInfoBloques(
    ['uuid-1'],
    [{ id: 'uuid-1', codigo: ' 52210 ' }],
    [{ codigo: '52210', descripcion: 'VIGENTE', un: 'UN' }],
    [{ codigo: '52210', descripcion: 'VIEJA', unidad: 'KG' }]
  )
  check('normalización trim/upper en las 3 fuentes', m.get('uuid-1')?.descripcion === 'VIGENTE')
}

// ── 10. Entrada vacía → mapa vacío ──
{
  const m = fusionarInfoBloques([], [], [], [])
  check('ids vacíos → mapa vacío', m.size === 0)
}

// ── 11. Prioridad explícita: catálogo gana aunque piso tenga "otra verdad" ──
{
  // Este es el caso del usuario: el catálogo de racks se actualiza a diario;
  // la copia de piso puede quedar obsoleta y NO debe prevalecer.
  const m = fusionarInfoBloques(
    ['uuid-1'],
    [{ id: 'uuid-1', codigo: '52210' }],
    [{ codigo: '52210', descripcion: 'DESCRIPCIÓN ACTUALIZADA HOY', un: 'KG' }],
    [{ codigo: '52210', descripcion: 'DESCRIPCIÓN VIEJA DE PISO', unidad: 'UN' }]
  )
  const info = m.get('uuid-1')
  check('PRIORIDAD: catálogo racks > piso (descripción actualizada)', info?.descripcion === 'DESCRIPCIÓN ACTUALIZADA HOY')
  check('PRIORIDAD: catálogo racks > piso (unidad)', info?.unidad === 'KG')
}

console.log(`\n${ok} checks OK${process.exitCode ? ' (CON FALLOS)' : ''}`)
