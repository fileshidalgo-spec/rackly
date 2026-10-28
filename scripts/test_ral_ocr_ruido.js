#!/usr/bin/env node
/**
 * test_ral_ocr_ruido.js — Robustez del parser RAL ante ruido OCR de una
 * NUEVA foto (Paso 2 del 9 pasos): variantes de la pantalla ERP real con
 * fusiones, gluing, acentos perdidos y columnas movidas. El parser no
 * debe TRAGARSE campos cruzados ni perder los artículos.
 */
const assert = require('assert')
const { extraerDatosRalDeTexto, fusionarDatosRal } = require('../src/lib/rackly/ral-ocr')

let ok = 0
function check(nombre, cond) {
  if (!cond) { console.error(`✗ ${nombre}`); process.exitCode = 1 } else { ok++; console.log(`✓ ${nombre}`) }
}

// V1 — Ruido: espacios dobles, sin acentos, "Solicitante" con dos puntos
// mezclado con formato de cajilla en el MISMO renglón.
const V1 = `
Consulta Requerimiento al Almacen - Sucursal : 65 AJE CARAL
Transaccion: RAL REQUERIMIENTO AL ALMACEN   Documento: 8378   Fecha: 27/10/2026
Area Solicitante: CADENA DE SUMINISTRO   Solicitante: 138712 ENRIQUEZ MOGOLLON, JOHNNIE JHODEL
Linea: 04 MATERIA PRIMA E INSUMOS   Aprobado Por: ALFARO CHAHUD, JUSSEF ALFREDO
Almacen: 05 MATERIAS PRIMAS E IN
Codigo Articulo Und Cedis Centro Costo Cant. Pedida Cant. Aprobada Saldo
126 SAL INDUSTRIAL KG 65 44040101 2000.0000 2000.0000 2000.0000
`
const d1 = extraerDatosRalDeTexto(V1, [])
check('V1: documento', d1.documento === '8378')
check('V1: área limpia', d1.areaSolicitante === 'CADENA DE SUMINISTRO')
check('V1: solicitante persona', d1.solicitante === 'ENRIQUEZ MOGOLLON, JOHNNIE JHODEL')
check('V1: aprobado', d1.aprobadoPor === 'ALFARO CHAHUD, JUSSEF ALFREDO')
check('V1: almacén', d1.almacen === '05 MATERIAS PRIMAS E IN')
check('V1: línea', d1.linea === '04 MATERIA PRIMA E INSUMOS')
check('V1: 1 artículo', d1.items.length === 1)
if (d1.items[0]) {
  check('V1: código 126', d1.items[0].codigo === '126')
  check('V1: cantidad 2000', d1.items[0].cantidad === 2000)
  check('V1: centro 44040101', d1.items[0].centroCostos === '44040101')
}

// V2 — Gluing: UND pegada a la descripción ("SAL INDUSTRIALKG") y CEDIS
// pegado al centro ("6544040101" es 10 dígitos → centro válido NO: el ERP
// usa 65 + 44040101; el OCR puede unirlos).
const V2 = `Documento 8378
126 SAL INDUSTRIALKG 65 44040101 2000.0000 2000.0000 0.0000 2000.0000
`
const d2 = extraerDatosRalDeTexto(V2, [])
check('V2: artículo jala a pesar del gluing', d2.items.length === 1)
if (d2.items[0]) {
  check('V2: cantidad 2000 correcta', d2.items[0].cantidad === 2000)
  check('V2: unidad recuperada (rabo "…KG")', d2.items[0].unidad === 'KG')
}

// V3 — Cifras "pegadas": el OCR pierde el punto decimal de la corrida
// ("2000 2000 0 2000") — respaldo de enteros.
const V3 = `Documento 8378
126 SAL INDUSTRIAL KG 44040101 2000 2000 0 2000
`
const d3 = extraerDatosRalDeTexto(V3, [])
check('V3: fila con enteros sin decimal jala', d3.items.length === 1)
if (d3.items[0]) check('V3: cantidad 2000', d3.items[0].cantidad === 2000)

// V4 — Dos artículos con salto de columna: el 2º sin unidad y con centro
// corto; y fila partida entre ellos.
const V4 = `Documento 8378
126 SAL INDUSTRIAL KG 44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0
001
118 ACIDO CITRICO
44040101 168.0000 168.0000
`
const d4 = extraerDatosRalDeTexto(V4, [])
check('V4: 2 artículos (fila partida fusionada)', d4.items.length === 2)
const a118 = d4.items.find((x) => x.codigo === '118')
check('V4: 118 con cantidad 168', Boolean(a118) && a118.cantidad === 168)
const a126 = d4.items.find((x) => x.codigo === '126')
check('V4: 126 con cantidad 2000', Boolean(a126) && a126.cantidad === 2000)

// V5 — El encabezado llega PARTIDO en varios renglones (columna estrecha)
const V5 = `AXS Consulta Requerimiento al Almacen
Transaccion RAL REQUERIMIENTO AL ALMACEN
Documento 8378 Fecha 27/10/2026
Area Solicitante CADENA DE SUMINISTRO
Solicitante 138712 ENRIQUEZ MOGOLLON, JOHNNIE JHODEL
Aprobado por ALFARO CHAHUD, JUSSEF ALFREDO
Linea 04 MATERIA PRIMA E INSUMOS
Almacen 05 MATERIAS PRIMAS E IN
126 SAL INDUSTRIAL KG 44040101 2000.0000
`
const d5 = extraerDatosRalDeTexto(V5, [])
check('V5 (partido): documento', d5.documento === '8378')
check('V5 (partido): área', d5.areaSolicitante === 'CADENA DE SUMINISTRO')
check('V5 (partido): solicitante', d5.solicitante === 'ENRIQUEZ MOGOLLON, JOHNNIE JHODEL')
check('V5 (partido): almacén', d5.almacen === '05 MATERIAS PRIMAS E IN')
check('V5 (partido): línea', d5.linea === '04 MATERIA PRIMA E INSUMOS')
check('V5 (partido): 1 artículo', d5.items.length === 1)

// V6 — FUSIÓN de pases: un pase lee solo el encabezado, otro solo la tabla.
const soloHead = extraerDatosRalDeTexto(
  'Documento 8378 Fecha 27/10/2026\nArea Solicitante CADENA DE SUMINISTRO\nSolicitante 138712 ENRIQUEZ MOGOLLON, JOHNNIE JHODEL', [])
const soloTabla = extraerDatosRalDeTexto(
  '126 SAL INDUSTRIAL KG 44040101 2000.0000 2000.0000 0.0000 2000.0000', [])
const fus = fusionarDatosRal(soloHead, soloTabla)
check('fusión: encabezado + tabla se complementan', fus.documento === '8378' && fus.items.length === 1)
check('fusión: área conservada', fus.areaSolicitante === 'CADENA DE SUMINISTRO')

console.log(`\nSuite ral-ocr-ruido: ${ok} checks OK`)
if (process.exitCode) console.error('HUBO FALLOS ✗')
