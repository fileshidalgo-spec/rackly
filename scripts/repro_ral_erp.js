#!/usr/bin/env node
/**
 * REPRO del reporte del usuario (registrar RAL · módulo Atención):
 *  1) "el solicitante lo colocó en área solicitante" (mezclado, sin dos puntos)
 *  2) "no jaló código, artículo, und y cantidad pedida" (fila 126 SAL INDUSTRIAL)
 * Simula la lectura OCR REAL de la pantalla ERP (cajillas SIN dos puntos,
 * columna CEDIS 65, columnas Parcial/Item al final).
 */
const assert = require('assert')
const { extraerDatosRalDeTexto } = require('../src/lib/rackly/ral-ocr')

// ── Pantalla ERP real (AJE CARAL 65) leída por OCR — cajillas sin ":" ──
const PANTALLA_ERP = `AXS Consulta Requerimiento al Almacen - Sucursal : 65 AJE CARAL
Transaccion RAL REQUERIMIENTO AL ALMACEN Documento 8378 Fecha 27/10/2026
Area Solicitante CADENA DE SUMINISTRO Solicitante 138712 ENRIQUEZ MOGOLLON, IHONNIE JHONEL
Linea 04 MATERIA PRIMA E INSUMOS Aprobado por ALFARO CHAHUD, JUSSEF ALFREDO
Atendido No Compras Fecha Atencion 00/00/0000 Almacen 05 MATERIAS PRIMAS E IN Transaccion SPP SALIDA DE MATERI
Trab. en Curso 0 Mejora 0
Tipo Mantenimiento
Codigo Articulo Und Cedis Lin. Man Equipo Mant. Centro Costo Cant. Pedida Cant. Aprobada Cant Cancelada Saldo Parcial Item Nota
126 SAL INDUSTRIAL KG 65 44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0
`

const d = extraerDatosRalDeTexto(PANTALLA_ERP, [])
console.log('── Encabezado ──')
console.log('documento      =', JSON.stringify(d.documento))
console.log('fecha          =', JSON.stringify(d.fecha))
console.log('transaccion    =', JSON.stringify(d.transaccion))
console.log('areaSolicitante=', JSON.stringify(d.areaSolicitante))
console.log('solicitante    =', JSON.stringify(d.solicitante))
console.log('aprobadoPor    =', JSON.stringify(d.aprobadoPor))
console.log('almacen        =', JSON.stringify(d.almacen))
console.log('linea          =', JSON.stringify(d.linea))
console.log('── Artículos ──', d.items.length)
for (const it of d.items) console.log(' ', JSON.stringify(it))

let fallos = 0
function check(n, c) {
  console.log(`${c ? '✓' : '✗ FALLO'} ${n}`)
  if (!c) fallos++
}
console.log('\n── Objetivo (lo que el usuario marcó en verde) ──')
check('documento 8378', d.documento === '8378')
check('fecha 2026-10-27', d.fecha === '2026-10-27')
check('transaccion RAL completa', d.transaccion === 'RAL REQUERIMIENTO AL ALMACEN')
check('area = CADENA DE SUMINISTRO (NO mezclada)', d.areaSolicitante === 'CADENA DE SUMINISTRO')
check('solicitante = ENRIQUEZ MOGOLLON, IHONNIE JHONEL', d.solicitante === 'ENRIQUEZ MOGOLLON, IHONNIE JHONEL')
check('aprobado = ALFARO CHAHUD, JUSSEF ALFREDO', d.aprobadoPor === 'ALFARO CHAHUD, JUSSEF ALFREDO')
check('almacen = 05 MATERIAS PRIMAS E IN', d.almacen === '05 MATERIAS PRIMAS E IN')
check('linea = 04 MATERIA PRIMA E INSUMOS', d.linea === '04 MATERIA PRIMA E INSUMOS')
check('1 artículo', d.items.length === 1)
const it = d.items[0]
if (it) {
  check('código 126', it.codigo === '126')
  check('artículo SAL INDUSTRIAL', it.descripcion === 'SAL INDUSTRIAL')
  check('und KG', it.unidad === 'KG')
  check('centro 44040101', it.centroCostos === '44040101')
  check('cantidad pedida 2000 (no aprobada/saldo)', it.cantidad === 2000)
}

// ── Variante: fila fragmentada por el OCR (celdas en renglones) ──
const FRAGMENTADA = `Documento 8378
126
SAL INDUSTRIAL KG
44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0
`
const df = extraerDatosRalDeTexto(FRAGMENTADA, [])
console.log('\n── Fila fragmentada ──', df.items.length)
for (const it2 of df.items) console.log(' ', JSON.stringify(it2))
check('fragmentada: 1 artículo', df.items.length === 1)
const f0 = df.items[0]
if (f0) {
  check('fragmentada: código 126', f0.codigo === '126')
  check('fragmentada: SAL INDUSTRIAL', f0.descripcion === 'SAL INDUSTRIAL')
  check('fragmentada: KG', f0.unidad === 'KG')
  check('fragmentada: 2000', f0.cantidad === 2000)
}

console.log(fallos ? `\n${fallos} FALLOS ✗` : '\nTODO OK ✓')
process.exitCode = fallos ? 1 : 0
