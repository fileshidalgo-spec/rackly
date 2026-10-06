/**
 * RACKLY — Tests unitarios del parser de guías (guia-ocr.ts) + buscarCatalogo.
 *
 * Ejecutar:
 *   npx esbuild scripts/test_guia_ocr.js --bundle --platform=node --outfile=/tmp/test_guia.cjs --alias:@=/home/z/rackly/src --loader:.ts=ts --loader:.tsx=tsx && node /tmp/test_guia.cjs
 *
 * Escenarios:
 *   1. Guía SAN MIGUEL (1 artículo) — regresión de producción.
 *   2. Guía multi-artículo (5 códigos del catálogo, 1 por línea).
 *   3. Rescate fuzzy: códigos con 1 dígito mallado, 0 coincidencias exactas.
 *   4. Catálogo vacío → 0 ítems (sin crash).
 *   5. buscarCatalogo: exacta, con ceros a la izquierda, ambigua, inexistente.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const { extraerDatosGuia } = require('@/lib/rackly/guia-ocr')
const { buscarCatalogo, getCachedCatalogo, fetchCatalogo } = require('@/lib/rackly/catalogo')

// ─── Catálogo simulado (mismo formato que la BD: códigos numéricos texto) ───
const CATALOGO = [
  { codigo: '5653', un: 'KG', descripcion: 'PURE DE DURAZNO 30-32 ºBRIX', stock_big_magic: 0 },
  { codigo: '5654', un: 'KG', descripcion: 'PURE DE MELOCOTON 30-32 ºBRIX', stock_big_magic: 0 },
  { codigo: '118', un: 'KG', descripcion: 'ACIDO CITRICO', stock_big_magic: 0 },
  { codigo: '122', un: 'KG', descripcion: 'CITRATO DE SODIO', stock_big_magic: 0 },
  { codigo: '208', un: 'LT', descripcion: 'ACIDO SULFURICO (PA.95-100)', stock_big_magic: 0 },
  { codigo: '09', un: 'UND', descripcion: 'ARTICULO CON CERO INICIAL', stock_big_magic: 0 },
  { codigo: '7301', un: 'KGM', descripcion: 'CONCENTRADO DE MANZANA', stock_big_magic: 0 },
  { codigo: '7302', un: 'KGM', descripcion: 'JUGO CONCENTRADO DE UVA', stock_big_magic: 0 },
]

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

// ─── 1. SAN MIGUEL: guía de 1 artículo (regresión) ───
console.log('\n[1] SAN MIGUEL — 1 artículo')
const textoSanMiguel = `
GUIA DE REMISION - REMITENTE
SEÑORES : BIG MAGIC S.A.C.
RAZON SOCIAL : TRANSPORTES SAN MIGUEL S.R.L.
RUC : 20481234567
NUMERO DE GUIA : T005-0034403
FECHA DE EMISION : 05/10/26
PLACA TRACTO : A10-927
LICENCIA DE CONDUCIR : 12345678
TRANSPORTISTA : PEREZ LOPEZ JUAN
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
5653      PURE DE DURAZNO 30-32 ºBRIX        2.884       KGM
`
const sm = extraerDatosGuia(textoSanMiguel, CATALOGO)
check('nº de guía T005-0034403', sm.numeroGuia === 'T005-0034403', sm.numeroGuia)
check('placa A10-927', sm.placa === 'A10-927', sm.placa)
check('proveedor SAN MIGUEL (RAZON SOCIAL con prioridad)', /SAN MIGUEL/i.test(sm.proveedor), sm.proveedor)
check('detecta 1 artículo', sm.items.length === 1, JSON.stringify(sm.items.map((i) => i.codigo)))
check('código 5653', sm.items[0]?.codigo === '5653')
check('descripción del catálogo', sm.items[0]?.descripcion === 'PURE DE DURAZNO 30-32 ºBRIX', sm.items[0]?.descripcion)
check('cantidad 2.884', sm.items[0]?.cantidad === '2.884', sm.items[0]?.cantidad)
check('unidad del catálogo (KG con prioridad sobre línea)', sm.items[0]?.unidad === 'KG', sm.items[0]?.unidad)

// ─── 2. Guía multi-artículo: 5 códigos, uno por línea ───
console.log('\n[2] Guía multi-artículo — 5 códigos')
const lineas = [
  '5653      PURE DE DURAZNO 30-32 ºBRIX        1,500.00    KGM',
  '118       ACIDO CITRICO                        250.50    KG',
  '122       CITRATO DE SODIO                      80.00    KG',
  '208       ACIDO SULFURICO (PA.95-100)           45.00    LT',
  '7301      CONCENTRADO DE MANZANA              2,884.00   KGM',
]
const textoMulti = `
GUIA DE REMISION - ELECTRONICA
RAZON SOCIAL : COMERCIAL AJEPER S.A.C.
SEÑORES : BIG MAGIC S.A.C.
NUMERO DE GUIA : T173-00004076
PLACA (TRACTO) : D9SB18
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
${lineas.join('\n')}
`
const multi = extraerDatosGuia(textoMulti, CATALOGO)
check('detecta 5 artículos', multi.items.length === 5, `detectados: ${multi.items.length} [${multi.items.map((i) => i.codigo).join(', ')}]`)
check('todos los códigos correctos', ['5653', '118', '122', '208', '7301'].every((c) => multi.items.some((i) => i.codigo === c)), multi.items.map((i) => i.codigo).join(','))
check('descripciones del catálogo', multi.items.every((i) => i.descripcion.length > 3), JSON.stringify(multi.items.map((i) => i.descripcion)))
check('cantidades por línea', multi.items[0]?.cantidad === '1,500.00' && multi.items[1]?.cantidad === '250.50', JSON.stringify(multi.items.map((i) => i.cantidad)))
check('guía T173-00004076', multi.numeroGuia === 'T173-00004076', multi.numeroGuia)
check('placa D9SB18 con etiqueta "PLACA (TRACTO)"', multi.placa === 'D9SB18', multi.placa)
check('proveedor AJEPER (no el destinatario BIG MAGIC)', /AJEPER/i.test(multi.proveedor), multi.proveedor)

// ─── 3. Rescate fuzzy: códigos con 1 dígito mallado, 0 exactos ───
console.log('\n[3] Rescate fuzzy — OCR malla 1 dígito por código')
const textoFuzzy = `
GUIA DE REMISION - ELECTRONICA
RAZON SOCIAL : CONCENTRADOS DEL NORTE S.A.
NUMERO DE GUIA : T123-0000777
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
5753      PURE DE DURAZNO 30-32 BRIX         1,200.00    KGM
7392      JUGO CONCENTRADO DE UVA              150.00    KGM
`
const fuzzy = extraerDatosGuia(textoFuzzy, CATALOGO)
// 5753→5653 (dist 1; vs 5654 dist 2 → ÚNICO); 7392→7302 (dist 1 única)
// Fragmentos de cantidades ("200" de 1,200.00 / "150" de 150.00) NO generan códigos.
check('rescata 2 códigos fuzzy', fuzzy.items.length === 2, `rescatados: ${fuzzy.items.length} [${fuzzy.items.map((i) => i.codigo).join(', ')}]`)
check('5753 → 5653 (match único)', fuzzy.items.some((i) => i.codigo === '5653'), fuzzy.items.map((i) => i.codigo).join(','))
check('7392 → 7302 (match único)', fuzzy.items.some((i) => i.codigo === '7302'), fuzzy.items.map((i) => i.codigo).join(','))
check('fragmento de cantidad NO inventa 208', !fuzzy.items.some((i) => i.codigo === '208'), fuzzy.items.map((i) => i.codigo).join(','))
check('exacto sigue ganando (multi exacto + fuzzy no se mezclan)', extraerDatosGuia(textoMulti, CATALOGO).items.length === 5)

// ─── 4. Catálogo vacío → 0 ítems, sin crash ───
console.log('\n[4] Catálogo vacío')
const vacio = extraerDatosGuia(textoSanMiguel, [])
check('0 ítems con catálogo vacío', vacio.items.length === 0)
check('no crashea y extrae guía', vacio.numeroGuia === 'T005-0034403')

// ─── 5. buscarCatalogo: exacta / ceros / ambigua / inexistente ───
console.log('\n[5] buscarCatalogo (auto-llenado manual)')
const r1 = buscarCatalogo('5653', CATALOGO)
check('exacta: 5653 → PURE DE DURAZNO', r1?.descripcion === 'PURE DE DURAZNO 30-32 ºBRIX', JSON.stringify(r1))
check('unidad KG se obtiene junto', r1?.un === 'KG')
const r2 = buscarCatalogo('009', CATALOGO)
check('ceros: 009 → código 09 (regla 09==9)', r2?.codigo === '09', JSON.stringify(r2))
const r3 = buscarCatalogo('  208  ', CATALOGO)
check('tolera espacios: 208', r3?.codigo === '208')
const r4 = buscarCatalogo('9999', CATALOGO)
check('inexistente → undefined (sin inventar)', r4 === undefined)
check('vacío → undefined', buscarCatalogo('', CATALOGO) === undefined)

// ─── 6. aNumero: separadores de miles/decimales ───
console.log('\n[6] aNumero (cantidades con separadores)')
const { aNumero } = require('@/lib/rackly/formato')
check('"1,500.00" → 1500 (bug del 1.5 corregido)', aNumero('1,500.00') === 1500, String(aNumero('1,500.00')))
check('"1.500,00" → 1500 (formato EU)', aNumero('1.500,00') === 1500, String(aNumero('1.500,00')))
check('"250.50" → 250.5 (decimal Perú)', aNumero('250.50') === 250.5, String(aNumero('250.50')))
check('"2,884" → 2884 (miles con coma)', aNumero('2,884') === 2884, String(aNumero('2,884')))
check('"1500" → 1500', aNumero('1500') === 1500)
check('"12,5" → 12.5 (decimal con coma)', aNumero('12,5') === 12.5, String(aNumero('12,5')))
check('"" → NaN', isNaN(aNumero('')))
check('"9,400.00" → 9400 (AJEPER real)', aNumero('9,400.00') === 9400, String(aNumero('9,400.00')))

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
