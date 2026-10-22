#!/usr/bin/env node
/**
 * RACKLY — Task 14 · Tests del OCR de RQ con CATÁLOGO (rq-ocr.ts):
 *   · anti-fechas: un fragmento de fecha JAMÁS se registra como material
 *   · match por descripción (igual criterio que la guía): rescata filas con
 *     código mal leído adoptando el código del catálogo
 *   · anclasTablaRq: franja de la tabla para el zoom "cuadro por cuadro"
 * Suite pura (rq-ocr + guia-ocr no tocan red ni Supabase).
 */
const assert = require('assert')
const {
  extraerDatosRqDeTexto,
  anclasTablaRq,
} = require('../src/lib/rackly/rq-ocr')
const {
  UMBRAL_AUTO,
  UMBRAL_MIN,
  similitudDescripcion,
} = require('../src/lib/rackly/guia-ocr')

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

const CATALOGO = [
  { codigo: '55487', un: 'UN', descripcion: 'BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5', stock_big_magic: 0 },
  { codigo: '51554', un: 'KG', descripcion: 'EMULSION PIVA 26549', stock_big_magic: 0 },
  { codigo: '42975', un: 'KG', descripcion: 'TASTEGEN FLAVOR 534199 47T', stock_big_magic: 0 },
  { codigo: '118', un: 'KG', descripcion: 'ACIDO CITRICO', stock_big_magic: 0 },
]

// 1. ANTI-FECHAS: el renglón del turno partido en 2 líneas nacía un
//    material fantasma ("004" con cantidad 2026). Ahora se descarta.
const TEXTO_FECHA_PARTIDA = `
NUMERO REQUISICION : 0000191373
ORDEN/PRODUCCION : 2026008121
TURNO Y FECH :
004  21/10/2026
001     55487    BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5   24.0000
`
const d1 = extraerDatosRqDeTexto(TEXTO_FECHA_PARTIDA, CATALOGO)
check('anti-fechas: "004 21/10/2026" NO genera material', d1.items.length === 1)
check('anti-fechas: el material real sigue entrando', d1.items[0]?.codigo === '55487')
check('anti-fechas: la fecha igual alimenta el campo fecha', d1.fecha === '2026-10-21')

// 2. MATCH POR DESCRIPCIÓN: código ilegible ("5S487") pero descripción
//    idéntica al catálogo → adopta el código del catálogo sin revisión.
const TEXTO_CODIGO_MALO = `
NUMERO REQUISICION : 0000191374
001  5S487  BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5  24.0000
002  51S54  EMULSION PIVA 26549  322.0000
`
const d2 = extraerDatosRqDeTexto(TEXTO_CODIGO_MALO, CATALOGO)
check('match por descripción: rescata los 2 materiales', d2.items.length === 2)
check('match por descripción: adopta código 55487', d2.items[0]?.codigo === '55487')
check('match por descripción: enCatalogo=true', d2.items[0]?.enCatalogo === true)
check('match por descripción: marcado para confirmar', d2.items[0]?.matchPorDescripcion === true)
check('match por descripción: score ≥ auto → sin revisión', d2.items[0]?.revision === false)
check('match por descripción: unidad del catálogo', d2.items[1]?.unidad === 'KG')

// 3. LA REVISIÓN RESPONDE AL SCORE REAL (mecanismo, no a un score adivinado):
//    score ≥ UMBRAL_AUTO → adopta sin revisión; score < UMBRAL_AUTO → revisión.
const TEXTO_DEBIL = `
NUMERO REQUISICION : 0000191375
001  99999  BASE PARA BEBIDA CARBONATADA  10.0000
`
const d3 = extraerDatosRqDeTexto(TEXTO_DEBIL, CATALOGO)
check('match débil/auto: se adopta el candidato', d3.items.length === 1 && d3.items[0].enCatalogo === true)
const scoreReal = similitudDescripcion(
  'BASE PARA BEBIDA CARBONATADA',
  'BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5'
)
check(
  `revisión ⇔ score < ${UMBRAL_AUTO} (score real ${scoreReal.toFixed(2)})`,
  d3.items[0].revision === (scoreReal < UMBRAL_AUTO) && d3.items[0].matchPorDescripcion === true
)
check('umbral débil configurado por debajo del auto', UMBRAL_MIN < UMBRAL_AUTO)

// 4. REGRESIÓN: código exacto del catálogo sigue teniendo prioridad y NO se
//    marca como matchPorDescripcion (ventaja del código sobre la descripción).
const d4 = extraerDatosRqDeTexto(
  'NUMERO REQUISICION : 0000191376\n001  118  ACIDO CITRICO  168.0000\n',
  CATALOGO
)
check('regresión: código exacto gana', d4.items[0]?.codigo === '118' && d4.items[0]?.enCatalogo === true)
check('regresión: no marcado como por-descripción', !d4.items[0]?.matchPorDescripcion)
check('regresión: sin revisión', d4.items[0]?.revision === false)

// 5. SIN CATÁLOGO (red caída): las filas entran igual, fuera de catálogo.
const d5 = extraerDatosRqDeTexto('001  118  ACIDO CITRICO  168.0000\n', [])
check('sin catálogo: fila entra como revisión', d5.items.length === 1 && d5.items[0].revision === true)

// 6. ANCLAS DE LA TABLA: la franja arranca tras la última etiqueta del
//    encabezado y corre hasta el fondo de la imagen.
const PALABRAS = [
  { t: 'NUMERO', x0: 0, y0: 10, x1: 60, y1: 24 },
  { t: 'ORDEN/PRODUCCION', x0: 0, y0: 40, x1: 200, y1: 54 },
  { t: 'LINEA', x0: 0, y0: 100, x1: 60, y1: 114 },
  { t: 'SOLICITANTE', x0: 0, y0: 120, x1: 120, y1: 134 },
  { t: 'CANTIDAD', x0: 500, y0: 160, x1: 600, y1: 174 },
]
const a1 = anclasTablaRq(PALABRAS, 1000)
check('anclas: yTop tras la última etiqueta del encabezado', a1.yTop === 138)
check('anclas: yBot = fondo de la imagen', a1.yBot === 1000)

// Sin anclas (encabezado ilegible) → inicio seguro al 30%
const a2 = anclasTablaRq([{ t: 'AJEPER', x0: 0, y0: 0, x1: 50, y1: 14 }], 1000)
check('anclas: respaldo al 30% de la imagen', a2.yTop === 300 && a2.yBot === 1000)

// Ancla que caería fuera de rango → respaldo
const a3 = anclasTablaRq([{ t: 'FECHA', x0: 0, y0: 980, x1: 50, y1: 996 }], 1000)
check('anclas: etiqueta al borde → respaldo 30%', a3.yTop === 300 && a3.yBot === 1000)

console.log('──────────────────────────────')
console.log(`OK ${ok}/20`)
if (process.exitCode) process.exit(1)
