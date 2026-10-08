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

const { extraerDatosGuia, extraerDatosGuiaDeTextos, extraerFilasDeTabla, similitudDescripcion, buscarPorDescripcion } = require('@/lib/rackly/guia-ocr')
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
  { codigo: '0034403', un: 'UND', descripcion: 'CODIGO QUE CHoca CON NUMERO DE GUIA', stock_big_magic: 0 },
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

// ─── 7. OCR ESTRICTO: falsos positivos eliminados ───
console.log('\n[7] OCR estricto — cantidades y documentos NO crean artículos')
// 7a. "118.00 KGM" como CANTIDAD (no como fila): el código 118 existe en el
//     catálogo; antes lo creaba como artículo falso.
const textoCantidad = `
GUIA DE REMISION - ELECTRONICA
RAZON SOCIAL : TRANSPORTES DEL SUR S.A.C.
NUMERO DE GUIA : T005-0034403
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
5653      PURE DE DURAZNO 30-32 ºBRIX        2.884       KGM
ENTREGA PARCIAL 118.00 KGM CERTIFICADA POR EL LABORATORIO
`
const t7a = extraerDatosGuia(textoCantidad, CATALOGO)
check('cant "118.00 KGM" NO crea artículo 118', !t7a.items.some((i) => i.codigo === '118'), JSON.stringify(t7a.items.map((i) => i.codigo)))
check('fila real 5653 SÍ se detecta', t7a.items.length === 1 && t7a.items[0].codigo === '5653', JSON.stringify(t7a.items.map((i) => i.codigo)))

// 7b. El número de guía T005-0034403 contiene el código 0034403 del catálogo:
//     NO debe crear artículo.
check('nº de guía NO crea artículo 0034403', !t7a.items.some((i) => i.codigo === '0034403'), JSON.stringify(t7a.items.map((i) => i.codigo)))

// 7c. Cantidad = número pegado a la unidad (no el primer número de la línea):
//     "LAMINA 2.0 MM … 450.5 KGM" debe dar 450.5, no 2.0.
const textoCantidad2 = `
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
118       LAMINA DE ACERO 2.0 MM             450.5       KGM
`
const t7c = extraerDatosGuia(textoCantidad2, CATALOGO)
check('detecta 118 (fila real)', t7c.items.length === 1 && t7c.items[0].codigo === '118', JSON.stringify(t7c.items.map((i) => i.codigo)))
check('cantidad 450.5 (pegada a unidad, no 2.0 de la desc)', t7c.items[0]?.cantidad === '450.5', t7c.items[0]?.cantidad)

// ─── 8. buscarCatalogo: tolerancia a pegados OCR ───
console.log('\n[8] buscarCatalogo — pegados OCR ("5653.", "56 53")')
check('"5653." (punto pegado) → match', buscarCatalogo('5653.', CATALOGO)?.codigo === '5653', JSON.stringify(buscarCatalogo('5653.', CATALOGO)))
check('"56 53" (espacio interno) → match', buscarCatalogo('56 53', CATALOGO)?.codigo === '5653')
check('"5653-" (guion pegado) → match', buscarCatalogo('5653-', CATALOGO)?.codigo === '5653')
check('inexistente "5659" → undefined', buscarCatalogo('5659', CATALOGO) === undefined)
check('ambiguo sigue sin inventar', buscarCatalogo('53', CATALOGO) === undefined)

// ─── 9. GUÍA REAL AJER S.A. (T173-00004090, foto WhatsApp 960×1280) ───
// Casos calibrados con el OCR real del ZOOM de la franja de tabla (×3).
console.log('\n[9] Guía real AJER — zoom de tabla + matching por descripción')
const CATALOGO_AJER = [
  { codigo: '126', un: 'KG', descripcion: 'SAL INDUSTRIAL', stock_big_magic: 0 },
  { codigo: '125', un: 'KG', descripcion: 'HIDROXIDO DE CALCIO (IND.60-94 por ciento)', stock_big_magic: 0 },
  { codigo: '6634', un: 'KG', descripcion: 'ASEPTICPER WC', stock_big_magic: 0 },
  { codigo: '11688', un: 'GLS', descripcion: 'ALCOHOL RECTIFICADO AL 75 por ciento', stock_big_magic: 0 },
  { codigo: '23961', un: 'UN', descripcion: 'CARTON SEPARADOR PARA ESTIBA', stock_big_magic: 0 },
  { codigo: '53414', un: 'UN', descripcion: 'DIVERFLOW 156 (ENVASE X 28 KG.)', stock_big_magic: 0 },
  { codigo: '53524', un: 'KG', descripcion: 'LAMINA TERMOCONTRAIBLE 470 CM X 50 µ - MAQUINA SIDEL - CARAL', stock_big_magic: 0 },
  { codigo: '53574', un: 'UN', descripcion: 'BASES PAPAS PICANTES BOLSA X 25 KG 49854', stock_big_magic: 0 },
  { codigo: '56119', un: 'UN', descripcion: 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 2025', stock_big_magic: 0 },
  { codigo: '56364', un: 'UN', descripcion: 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 100 ML', stock_big_magic: 0 },
]

// Texto OCR REAL del zoom de la franja de tabla (imperfecciones incluidas).
const FRANJA_AJER = `
| cómGOo | DESCRIPCIÓN o — o
| E 4 SAL INDUSTRIAL 4,000:09 KGM 4000.00
2 |es ASEPTICPER WC 128000 KG 1,280.00
3 | 11688 ALCOMOL RECTIFICADO AL 75 por ciento 50.00 CLL 50.00
| 23951 CARTON SEPARADOR PARA ESTIBA 7,000.00 UND 1.050,00
La 5u1a DIVERFLOW 155 (ENVASE X 25 KG) 20.00 UND 56000
[=] 53574 LAMINA TERMOCONTRAIBLE 470 CM X 50 Ap - MAQUINA SIDEL - CARAL 1,356.80 KGM 1,356.80
7 56119 ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEAYO 2925 77327000 UND 6,418 14
B| 56264 ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 100 ML 545,000.00 UND 546,000.00
NOTAS! VER NRO DE COMPROBANTES DE PAGO Y DIRECCION DEL PUNTO DE LLEGADA EN ANEXO ADJUNTO
`
const ajer = extraerDatosGuiaDeTextos('NRO. T173-00004090\nPLACA: C9G7B1\nRAZÓN SOCIAL: AJEPER S.A.', FRANJA_AJER, CATALOGO_AJER)
const codigosAj = ajer.items.map((i) => i.codigo)
check('recupera los 8 artículos de la tabla', ajer.items.length === 8, `obtuvo ${ajer.items.length}: [${codigosAj.join(', ')}]`)
check('SAL INDUSTRIAL → 126 (por descripción, código ilegible "4")', ajer.items.some((i) => i.codigo === '126' && i.matchPorDescripcion), JSON.stringify(codigosAj))
check('ASEPTICPER WC → 6634 (código ilegible "es")', ajer.items.some((i) => i.codigo === '6634' && i.matchPorDescripcion && i.revision), JSON.stringify(codigosAj))
check('ALCOHOL: 11688 exacto y coherente (sin flags)', ajer.items.some((i) => i.codigo === '11688' && i.enCatalogo && !i.matchPorDescripcion && !i.revision), JSON.stringify(ajer.items.find((i) => i.codigo === '11688')))
check('CARTON: 23951 → 23961 (1 dígito, validado por descripción)', ajer.items.some((i) => i.codigo === '23961'), JSON.stringify(codigosAj))
check('LAMINA: 53574 NO queda con BASES PAPAS (cross-check)', !ajer.items.some((i) => i.codigo === '53574'), JSON.stringify(codigosAj))
check('LAMINA → 53524 (código re-buscado por descripción)', ajer.items.some((i) => i.codigo === '53524' && i.matchPorDescripcion), JSON.stringify(ajer.items.find((i) => /535/.test(i.codigo))))
check('TETRA 145 ML → 56119 exacto (número discriminante)', ajer.items.some((i) => i.codigo === '56119' && !i.matchPorDescripcion), JSON.stringify(codigosAj))
check('TETRA 100 ML: 56264 → 56364 (vecino + descripción)', ajer.items.some((i) => i.codigo === '56364' && i.matchPorDescripcion), JSON.stringify(codigosAj))
check('FICHER ilegible queda editable (código 5U1A + revisión)', ajer.items.some((i) => i.codigo === '5U1A' && i.revision && /DIVERFLOW/i.test(i.descripcion)), JSON.stringify(ajer.items.find((i) => /DIVERFLOW/i.test(i.descripcion))))
check('cantidad plana 77327000 → 773,270.00', ajer.items.find((i) => i.codigo === '56119')?.cantidad === '773,270.00', ajer.items.find((i) => i.codigo === '56119')?.cantidad)
check('cantidad plana 128000 → 1,280.00', ajer.items.find((i) => i.codigo === '6634')?.cantidad === '1,280.00', ajer.items.find((i) => i.codigo === '6634')?.cantidad)
check('cantidad con basura 4,000:09 → 4,000', ajer.items.find((i) => i.codigo === '126')?.cantidad === '4,000', ajer.items.find((i) => i.codigo === '126')?.cantidad)
check('unidad del catálogo manda (11688 → GLS)', ajer.items.find((i) => i.codigo === '11688')?.unidad === 'GLS', ajer.items.find((i) => i.codigo === '11688')?.unidad)
check('encabezados: guía/placa del texto completo', ajer.numeroGuia === 'T173-00004090' && ajer.placa === 'C9G7B1', `${ajer.numeroGuia} / ${ajer.placa}`)

// Texto COMPLETO mallado (sin zoom): los falsos positivos de antes NO vuelven.
const MALLA_AJER = `
Ro AJEPER SA. R.U.C. 20331061655
NRO. T173-00004090
NES TRANSPORTADOS.
E SAL IDUSTUAL 400000 = cmoco)
E ASEPTICPER VIC 120000 Lo 120000
| 125 ALCONOL RECTIFICADO AL 75 por cardo E a soce|
[2000 CARTON SEPARADOR PARA ESTBA 700000 uo 105000
NOTAS? Fecha de entrega de bienes al transportista - 06/10/2026
`
const malla = extraerDatosGuia(MALLA_AJER, CATALOGO_AJER)
check('texto malla: el fragmento "125" NO crea HIDROXIDO falso', !malla.items.some((i) => i.codigo === '125'), JSON.stringify(malla.items.map((i) => i.codigo)))
check('texto malla: "2000" NO crea artículo falso', !malla.items.some((i) => i.codigo === '2000'), JSON.stringify(malla.items.map((i) => i.codigo)))

// ─── 10. similitudDescripcion — números discriminan ───
console.log('\n[10] similitudDescripcion / buscarPorDescripcion')
const d145 = 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEAYO 2025'
const c56119 = similitudDescripcion(d145, 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 2025')
const c56364 = similitudDescripcion(d145, 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 100 ML')
check('145 ML puntúa más alto que 100 ML', c56119 > c56364, `145→${c56119.toFixed(2)} vs 100→${c56364.toFixed(2)}`)
check('145 ML supera umbral auto (0.82)', c56119 >= 0.82, c56119.toFixed(2))
const bm = buscarPorDescripcion('SAL INDUSTRIAL', CATALOGO_AJER)
check('"SAL INDUSTRIAL" → 126 exacto', bm?.item.codigo === '126' && bm.score >= 0.99, JSON.stringify(bm))
check('descripción vacía → null', buscarPorDescripcion('', CATALOGO_AJER) === null)
check('sin match → null', buscarPorDescripcion('ZZZZ QQQ 12345', CATALOGO_AJER) === null)

// ─── 11. Filas repetidas del MISMO código (2 lotes en la misma guía) ───
// Bug corregido: el dedupe por código descartaba la 2ª fila en silencio.
console.log('\n[11] Mismo código en 2 filas (2 lotes/cantidades distintas)')
const textoRepetido = `
GUIA DE REMISION - ELECTRONICA
RAZON SOCIAL : COMERCIAL AJEPER S.A.C.
NUMERO DE GUIA : T173-00004076
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
5653      PURE DE DURAZNO 30-32 ºBRIX        1,000.00    KGM
5653      PURE DE DURAZNO 30-32 ºBRIX        2,500.00    KGM
`
const rep = extraerDatosGuia(textoRepetido, CATALOGO)
check('mismo código con 2 cantidades → 2 filas (antes: 1)', rep.items.length === 2, `obtuvo ${rep.items.length}`)
check('cantidades 1,000.00 y 2,500.00 presentes', rep.items.some((i) => i.cantidad === '1,000.00') && rep.items.some((i) => i.cantidad === '2,500.00'), JSON.stringify(rep.items.map((i) => i.cantidad)))

// Tartamudeo del OCR: misma línea leída 2 veces idéntica → 1 fila.
const textoDuplicado = `
BIENES TRANSPORTADOS
CODIGO    DESCRIPCION                        CANTIDAD    UNIDAD
5653      PURE DE DURAZNO 30-32 ºBRIX        1,000.00    KGM
5653      PURE DE DURAZNO 30-32 ºBRIX        1,000.00    KGM
`
const dup = extraerDatosGuia(textoDuplicado, CATALOGO)
check('línea idéntica duplicada (OCR) → 1 fila', dup.items.length === 1, `obtuvo ${dup.items.length}`)

// ─── 12. terminoBusquedaSeguro — filtro .or() de PostgREST ───
// Bug corregido: una coma/paréntesis en la búsqueda rompía el listado
// ("Error al cargar recepciones") en Recepción, Atención y StockInc.
console.log('\n[12] terminoBusquedaSeguro (búsqueda con caracteres de PostgREST)')
const { terminoBusquedaSeguro } = require('@/lib/rackly/formato')
check('"LIMA, PERU (S.A.)" → sin coma/paréntesis', terminoBusquedaSeguro('LIMA, PERU (S.A.)') === 'LIMA PERU S.A.', terminoBusquedaSeguro('LIMA, PERU (S.A.)'))
check('"50%" → comodín LIKE eliminado', terminoBusquedaSeguro('50%') === '50', terminoBusquedaSeguro('50%'))
check('"T005_003" → guion bajo eliminado', terminoBusquedaSeguro('T005_003') === 'T005 003', terminoBusquedaSeguro('T005_003'))
check('espacios colapsados y recortados', terminoBusquedaSeguro('  ACIDO    CITRICO  ') === 'ACIDO CITRICO')
check('término solo de caracteres peligrosos → "" (se omite el filtro)', terminoBusquedaSeguro(',"()') === '')
check('término normal pasa intacto', terminoBusquedaSeguro('AJEPER') === 'AJEPER')

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
