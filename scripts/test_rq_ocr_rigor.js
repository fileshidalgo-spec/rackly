#!/usr/bin/env node
/**
 * RACKLY — Task 23 · Tests de RIGOR NUMÉRICO del OCR de RQ (rq-ocr.ts).
 *
 * Errores reportados 2026-10-24 con la RQ real AJEPER 0000191740:
 *   1. FANTASMA: el OCR leyó 57265 (8→5) y el match directo a catálogo
 *      adoptó "ETIQUETA AGUA CIELO" (otro producto real) — la descripción
 *      oficial enmascaraba el dígito confundido y la fila extra entraba
 *      con check verde. La COMPUERTA DE COHERENCIA (portada de guia-ocr)
 *      corrige al vecino que mejor explica la descripción + revisión.
 *   2. DÍGITOS 4↔9: cantidades del mismo material leídas distinto en 2
 *      pases → VOTACIÓN en la fusión (revisión + aviso, no adivinar).
 *   3. SOLICITANTE: solo nombre y apellidos ("H 7126 CHINCHAY…" → "CHINCHAY…").
 * Suite pura (rq-ocr + guia-ocr no tocan red ni Supabase).
 */
const {
  extraerDatosRqDeTexto,
  fusionarDatosRq,
} = require('../src/lib/rackly/rq-ocr')

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

// Catálogo REAL (BD 2026-10-24): 57265 y 57268 SON productos distintos que
// comparten familia (etiquetas) — el escenario exacto del fantasma.
const CATALOGO = [
  { codigo: '57265', descripcion: 'ETIQUETA AGUA CIELO SABOR NARANJA 600 ML CON GAS - DIS.25', un: 'UN' },
  { codigo: '57268', descripcion: 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25', un: 'UN' },
  { codigo: '50111', descripcion: 'PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL)', un: 'UN' },
  { codigo: '56227', descripcion: 'TAPA PLANA 33 MM TRASLUCIDA HF', un: 'UN' },
]

// ── 1. EL FANTASMA REAL (foto del usuario 24-10): la RQ dice 57268, el OCR
//        leyó 57265 y el catálogo tiene AMBOS códigos ──
const FILA_FANTASMA =
  '001  57265  ETIQUETA DILYTE APPLE ICE 650 MÍ - DIS.25  UN  165,000.0000 120,000.0000 Pendiente\n'
const d1 = extraerDatosRqDeTexto(FILA_FANTASMA, CATALOGO)
check('fantasma: la fila termina siendo el código real 57268', d1.items.length === 1 && d1.items[0].codigo === '57268')
check('fantasma: queda marcada para REVISIÓN (check ámbar, no verde)', d1.items[0].revision === true)
check('fantasma: descripción OFICIAL del código corregido', d1.items[0].descripcion === 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25')
check('fantasma: cantidad 165,000 (no el saldo 120,000)', d1.items[0].cantidad === 165000)
check('fantasma: queda marcado como ajuste a confirmar', d1.items[0].matchPorDescripcion === true)

// ── 2. RQ COMPLETA con el fantasma incluido: dedupe → 3 materiales (no 4) ──
const RQ_CON_FANTASMA = `
NUMERO REQUISICION : 0000191740
ORDEN/PRODUCCION +: 2026008187
Solicitante —:      H 7126 CHINCHAY SANDOVAL, DIANA CAROLINA
001  57265  ETIQUETA DILYTE APPLE ICE 650 MÍ - DIS.25  UN  165,000.0000 120,000.0000 Pendiente
002  50111  PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL) UN  165,000.0000  Pendiente
003  56227  TAPA PLANA 33 MM TRASLUCIDA HF  Un  125,000.0000  Pendiente
`
const d2 = extraerDatosRqDeTexto(RQ_CON_FANTASMA, CATALOGO)
check('RQ completa: 3 materiales (el fantasma se funde con el real)', d2.items.length === 3)
check('RQ completa: códigos finales correctos', d2.items.map((i) => i.codigo).join(',') === '57268,50111,56227')
check('RQ completa: la fila corregida va a revisión', d2.items[0].revision === true)
check('RQ completa: las filas limpias NO se marcan', d2.items[1].revision === false && d2.items[2].revision === false)

// ── 3. MATCH DIRECTO incoherente SIN vecino mejor: queda a revisión,
//        NO se corrige a ciegas hacia otro producto ──
const d3 = extraerDatosRqDeTexto(
  '002  50111  TAPA PLANA 33 MM TRASLUCIDA HF  UN  100.0000 Pendiente\n',
  CATALOGO
)
check(
  'incoherente sin vecino: código del catálogo + revisión',
  d3.items.length === 1 && d3.items[0].codigo === '50111' && d3.items[0].revision === true && d3.items[0].enCatalogo === true
)

// ── 4. Fila correcta (código Y descripción cuadran): SIN revisión (regresión) ──
const d4 = extraerDatosRqDeTexto(
  '003  56227  TAPA PLANA 33 MI TRASLUCIDA HF  Un  125,000.0000 Pendiente\n',
  CATALOGO
)
check(
  'fila correcta con ruido leve: sin revisión',
  d4.items.length === 1 && d4.items[0].codigo === '56227' && d4.items[0].revision === false
)

// ── 5. SOLICITANTE = solo nombre y apellidos ──
const SOL1 = 'Solicitante —:      H 7126 CHINCHAY SANDOVAL, DIANA CAROLINA\n'
const d5 = extraerDatosRqDeTexto(SOL1, [])
check(
  'solicitante: quita ruido "H" y DNI "7126"',
  d5.solicitante === 'CHINCHAY SANDOVAL, DIANA CAROLINA'
)
const d5b = extraerDatosRqDeTexto('Solicitante : 7126 CHINCHAY SANDOVAL, DIANA CAROLINA\n', [])
check('solicitante: DNI delante también se quita', d5b.solicitante === 'CHINCHAY SANDOVAL, DIANA CAROLINA')
const d5c = extraerDatosRqDeTexto('Solicitante : DE LA CRUZ, MARIA FERNANDA\n', [])
check('solicitante: partículas DE/LA se conservan', d5c.solicitante === 'DE LA CRUZ, MARIA FERNANDA')
const d5d = extraerDatosRqDeTexto('Solicitante : 7126 JUAN PEREZ\nTURNO Y FECH : 004 21/10/2026\n', [])
check('solicitante: corta en la etiqueta siguiente', d5d.solicitante === 'JUAN PEREZ')

// ── 6. VOTACIÓN DE CANTIDADES entre 2 pases (4↔9) ──
const base = {
  numeroRq: '', ordenProduccion: '', productoCodigo: '',
  productoDescripcion: '', fecha: '', linea: '', solicitante: '', items: [],
}
const paseA = {
  ...base,
  items: [{ codigo: '57268', descripcion: 'ETIQUETA DILYTE', cantidad: 165000, unidad: 'UN', enCatalogo: true, revision: false, matchPorDescripcion: false }],
}
const paseB = {
  ...base,
  items: [{ codigo: '57268', descripcion: 'ETIQUETA DILYTE', cantidad: 169000, unidad: 'UN', enCatalogo: true, revision: false, matchPorDescripcion: false }],
}
const f1 = fusionarDatosRq(paseA, paseB)
check('votación: mismo material, cantidades distintas → 1 fila', f1.items.length === 1)
check('votación: la fila discrepante queda a revisión', f1.items[0].revision === true)
check('votación: aviso visible con ambas lecturas', (f1.avisos ?? []).some((a) => a.includes('57268') && a.includes('165000') && a.includes('169000')))
const f2 = fusionarDatosRq(paseA, paseA)
check('votación: lecturas coincidentes → sin revisión ni avisos', f2.items[0].revision === false && (f2.avisos ?? []).length === 0)

// ── 7. REGRESIÓN: fusión del documento real sigue sin avisos (filas íntegras) ──
const RQ_LIMPIA = `
NUMERO REQUISICION : 0000191740
001  57268  ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25  UN  165,000.0000 120,000.0000 Pendiente
002  50111  PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL) UN  165,000.0000  Pendiente
`
const f3 = fusionarDatosRq(
  extraerDatosRqDeTexto(RQ_LIMPIA, CATALOGO),
  extraerDatosRqDeTexto(RQ_LIMPIA, CATALOGO)
)
check('regresión: doc limpio → 2 filas sin revisión', f3.items.length === 2 && f3.items.every((i) => !i.revision))
check('regresión: doc limpio → sin avisos', (f3.avisos ?? []).length === 0)

console.log('──────────────────────────────')
console.log(`OK ${ok}/21`)
if (process.exitCode) process.exit(1)
