#!/usr/bin/env node
/**
 * RACKLY — Task 13 · Tests del campo LÍNEA en el OCR de RQ (rq-ocr.ts).
 * Suite pura (sin stubs: rq-ocr.ts solo importa TIPOS de catálogo).
 * Ejecutada por scripts/run_all_tests.sh (esbuild → node).
 */
const assert = require('assert')
const {
  extraerDatosRqDeTexto,
  fusionarDatosRq,
  puntuarExtraccionRq,
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

// ── Fixture calibrado con el documento REAL AJEPER 0000191373 (2026-10-23) ──
const TEXTO_REAL = `
AJEPER S.A.                       REQUISICION DE DESPACHO DE MATERIALES
                                  NUMERO REQUISICION : 0000191373
Almacen      : 20                 INSUMOS EN PROVEEDORES
ORDEN/PRODUCCION : 2026008121
LOTE DEL SISTEMA : 0
   Articulo  : 3000047  JARABE TERMINADO KR PIVA 5% AZUCARES TOTALES - AZUCAR INVERTID
   Cantidad  : 50,400.0000  LT
Línea        : 0 TANQUES DE JARABE GASEOSA
Solicitante  : 7126 CHINCHAY SANDOVAL, DIANA CAROLINA
TURNO Y FECH : 004  21/10/2026              Fecha Requisicion 00/00/0000
#ITEMS  MATERIAL      Descripcion              UNID.   CANTIDAD
001     55487         BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5   24.0000
002     51554         EMULSION PIVA 26549   322.0000
003     42975         TASTEGEN FLAVOR 534199 47T   106.0000
004     118           ACIDO CITRICO   168.0000
`

// 1. Documento real → la LÍNEA se extrae completa y sin contaminar campos
const d1 = extraerDatosRqDeTexto(TEXTO_REAL, [])
check('doc real: linea = "0 TANQUES DE JARABE GASEOSA"', d1.linea === '0 TANQUES DE JARABE GASEOSA')
check('doc real: nº RQ intacto', d1.numeroRq === '0000191373')
check('doc real: OP intacta', d1.ordenProduccion === '2026008121')
check('doc real: solicitante intacto', d1.solicitante.includes('CHINCHAY'))
check('doc real: 4 materiales', d1.items.length === 4)

// 2. Valores cortos tipo código (L1/L2/L3, JARABES)
const d2 = extraerDatosRqDeTexto('Línea : L1\nSolicitante : JUAN PEREZ\n', [])
check('línea corta "L1"', d2.linea === 'L1')
const d2b = extraerDatosRqDeTexto('LINEA : JARABES\n', [])
check('sin tilde + "JARABES"', d2b.linea === 'JARABES')

// 3. OCR fusiona renglones → corta en la siguiente etiqueta
const d3 = extraerDatosRqDeTexto(
  'LÍNEA : TANQUES DE JARABE SOLICITANTE : 7126 JUAN PEREZ\n',
  []
)
check('corte en etiqueta siguiente', d3.linea === 'TANQUES DE JARABE')

// 4. Material con "LINEA" en la descripción NO contamina el encabezado
const d4 = extraerDatosRqDeTexto(
  'NUMERO REQUISICION : 0000191374\n005  99999  FILTRO LINEA 3  12.0000 KG\n',
  []
)
check('material con LINEA: no hay línea de encabezado', d4.linea === '')
check(
  'material con LINEA: el material no se pierde',
  d4.items.length === 1 && /LINEA 3/.test(d4.items[0].descripcion)
)

// 5. Fusión de 2 pases OCR propaga la línea (primera lectura no vacía)
const base = {
  numeroRq: '', ordenProduccion: '', productoCodigo: '',
  productoDescripcion: '', fecha: '', linea: '', solicitante: '', items: [],
}
const f1 = fusionarDatosRq({ ...base, linea: 'L1' }, { ...base })
const f2 = fusionarDatosRq({ ...base }, { ...base, linea: 'L2' })
check('fusión: gana la primera no vacía (a)', f1.linea === 'L1')
check('fusión: gana la primera no vacía (b)', f2.linea === 'L2')

// 6. Puntuación: la línea suma 1 al puntaje de calidad
const conLinea = puntuarExtraccionRq({ ...base, linea: 'L1' })
const sinLinea = puntuarExtraccionRq({ ...base })
check('puntuación: linea suma 1', conLinea === sinLinea + 1)

console.log('──────────────────────────────')
console.log(`OK ${ok}/13`)
if (process.exitCode) process.exit(1)
