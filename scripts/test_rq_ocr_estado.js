#!/usr/bin/env node
/**
 * RACKLY — Task 22 · Tests del formato de RQ con ESTADO por fila (rq-ocr.ts).
 *
 * Defecto reportado 2026-10-24 ("no jala los items en Atención"): el formato
 * AJEPER nuevo (RQ 0000191740) imprime en cada material una columna de ESTADO
 * («Pendiente») y un saldo tras la cantidad solicitada:
 *
 *   001  57268 ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25 UN 165,000.0000 120,000.0000 Pendiente
 *
 * El parser solo aceptaba «cantidad al final de la línea» → 0 materiales.
 * Este suite fija el ANCLA B (unidad → cantidad) y sus variantes, y la
 * descripción OFICIAL del catálogo sobre la lectura OCR.
 * Suite pura (rq-ocr + guia-ocr no tocan red ni Supabase).
 */
const assert = require('assert')
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

// Catálogo real de la BD (verificado por SQL 2026-10-24) + 2 distractores
const CATALOGO = [
  { codigo: '57268', descripcion: 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25', un: 'UN' },
  { codigo: '50111', descripcion: 'PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL)', un: 'UN' },
  { codigo: '56227', descripcion: 'TAPA PLANA 33 MM TRASLUCIDA HF', un: 'UN' },
  { codigo: '424198', descripcion: 'DILYTE APPLE ICE SIN AZUCAR PET NO RETORNABLE 650 ML 6 MA', un: 'PQT' },
  { codigo: '51554', descripcion: 'EMULSION PIVA 26549', un: 'KG' },
]

// ── Fixture 1: OCR REAL (tesseract spa, PSM 6) de la RQ 0000191740 ──
//    Se conserva el ruido: "MÍ"/"MI" (ML/MM), "36.1" (38.1), em-dash entre
//    cifras, unidades en minúscula y la columna de estado «Pendiente».
const TEXTO_REAL_191740 = `
AJEPER S.A.                                                                                       Pagina +: 0001
REQUISICION DE DESPACHO DE MATERIALES                       Fecha —: 23/10/2026
NUMERO REQUISICION : — 0000191740                        Hora + 08:41:27
Almacen        :20           INSUNOS EN PROVEEDORES
ORDEN/PRODUCCION +: 2026008187
LOTE DEL SISTEMA +:          o
articulo + 424198     DILYTE APPLE ICE SIN AZÚCAR PET NO RETORNABLE 650 ML 6 MA
Cantidad +: 120,000.0000 | POT
Linea: 0 LINEA 4 (HF)
Solicitante —:      7126 CHINCHAY SANDOVAL, DIANA CAROLINA
TURNO Y FECH : 004 23/10/2026                 Fecha Requisicion 00/00/0000
AITENS — MATERIAL                         Descripcion                UNID.       CANTIDAD
001         57268 ETIQUETA DILYTE APPLE ICE 650 MÍ - DIS.25     un      165,000.0000 — 120,000.0000 Pendiente
002         50111 PREFORMA PET 36.1 GRS CRISTAL HF (SAN MIGUEL) UN      165,000.0000                Pendiente
003         56227 TAPA PLANA 33 MI TRASLUCIDA HF                Un      125,000.0000                Pendiente
Solicitado por                                                                             ACEPTADO POR
`

// 1. DOCUMENTO REAL → los 3 materiales entran con datos OFICIALES
const d1 = extraerDatosRqDeTexto(TEXTO_REAL_191740, CATALOGO)
check('doc 191740: 3 materiales (antes: 0)', d1.items.length === 3)
check('doc 191740: nº RQ', d1.numeroRq === '0000191740')
check('doc 191740: OP', d1.ordenProduccion === '2026008187')
check('doc 191740: línea de producción', d1.linea === '0 LINEA 4 (HF)')
check('doc 191740: códigos en orden', d1.items.map((i) => i.codigo).join(',') === '57268,50111,56227')
check('doc 191740: cantidades solicitadas (NO el saldo 120,000)', d1.items.map((i) => i.cantidad).join(',') === '165000,165000,125000')
check('doc 191740: todos en catálogo', d1.items.every((i) => i.enCatalogo))
check('doc 191740: ninguno a revisión', d1.items.every((i) => !i.revision))
check('doc 191740: unidad UN en todos', d1.items.every((i) => i.unidad === 'UN'))
check('doc 191740: descripción OFICIAL (corrige 36.1→38.1)', d1.items[1]?.descripcion === 'PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL)')
check('doc 191740: descripción oficial etiqueta (corrige MÍ→ML)', d1.items[0]?.descripcion === 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25')

// 2. ANCLA B · paso 3: «cantidad UN Pendiente» (unidad DESPUÉS de la cantidad)
const d2 = extraerDatosRqDeTexto(
  '001  55487  BASE PARA BEBIDA  24.0000 UN Pendiente\n',
  [{ codigo: '55487', descripcion: 'BASE PARA BEBIDA', un: 'UN' }]
)
check('ancla B: "24.0000 UN Pendiente" entra con 24', d2.items.length === 1 && d2.items[0].cantidad === 24 && d2.items[0].unidad === 'UN')

// 3. ANCLA B · paso 3: «cantidad Pendiente» (solo estado al final)
const d3 = extraerDatosRqDeTexto('001  55487  BASE PARA BEBIDA  24.0000 Pendiente\n', CATALOGO)
check('ancla B: "24.0000 Pendiente" entra con 24', d3.items.length === 1 && d3.items[0].cantidad === 24)

// 4. ANCLA B · doble cifra SIN estado: la cantidad va tras la UNIDAD
const d4 = extraerDatosRqDeTexto(
  '001  57268  ETIQUETA DILYTE 650 ML DIS.25 UN 165,000.0000 120,000.0000\n',
  CATALOGO
)
check('ancla B: doble cifra sin estado → 165,000 (no 120,000)', d4.items.length === 1 && d4.items[0].cantidad === 165000)

// 5. Estado con ruido OCR («Pendiante») también se retira
const d5 = extraerDatosRqDeTexto('002  50111  PREFORMA PET HF  165,000.0000 Pendiante\n', CATALOGO)
check('estado mal leído ("Pendiante"): fila entra con 165,000', d5.items.length === 1 && d5.items[0].cantidad === 165000)

// 6. Guion separador de la tabla pegado a la fila (pase zoom)
const d6 = extraerDatosRqDeTexto(
  '--------------- 003  56227  TAPA PLANA 33 MM TRASLUCIDA HF UN 125,000.0000 Pendiente\n',
  CATALOGO
)
check('guion pegado a la fila: entra con 125,000', d6.items.length === 1 && d6.items[0].cantidad === 125000)

// 7. Línea del producto terminado del ENCABEZADO sigue sin duplicarse
check('encabezado: el producto no se repite como material', !d1.items.some((i) => i.codigo === '424198'))

// 8. FUSIÓN de 2 pases (PSM6 + PSM3) del documento real: sin duplicados
const soloFilas = TEXTO_REAL_191740
const fusion = fusionarDatosRq(
  extraerDatosRqDeTexto(soloFilas, CATALOGO),
  extraerDatosRqDeTexto(soloFilas, CATALOGO)
)
check('fusión 2 pases: siguen siendo 3 materiales', fusion.items.length === 3)

// 9. ANTI-FECHAS sigue vivo con el nuevo formato (regresión)
const d9 = extraerDatosRqDeTexto(
  'NUMERO REQUISICION : 0000191741\nTURNO Y FECH :\n004  23/10/2026\n001  57268  ETIQUETA DILYTE  UN 165,000.0000 Pendiente\n',
  CATALOGO
)
check('anti-fechas: "004 23/10/2026" no nace material', d9.items.length === 1 && d9.items[0].codigo === '57268')

// 10. Formato CLÁSICO (RQ 0000191373) intacto — el ancla A manda
const d10 = extraerDatosRqDeTexto(
  '001     55487         BASE PARA BEBIDA JARABEADA CARBONATADA PIVA 5   24.0000\n002     118           ACIDO CITRICO   168.0000\n',
  CATALOGO
)
check('formato clásico: 2 materiales sin cambios', d10.items.length === 2 && d10.items[0].cantidad === 24 && d10.items[1].cantidad === 168)

// 11. Firma del pie NO genera material (sin cifra no hay fila)
const d11 = extraerDatosRqDeTexto('Solicitado por            ACEPTADO POR\n', CATALOGO)
check('pie de firmas: 0 materiales', d11.items.length === 0)

console.log('──────────────────────────────')
console.log(`OK ${ok}/21`)
if (process.exitCode) process.exit(1)
