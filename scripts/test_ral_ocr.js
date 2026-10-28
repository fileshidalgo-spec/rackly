#!/usr/bin/env node
/**
 * RACKLY — Task 36 · Tests del OCR del formato RAL (ral-ocr.ts).
 * Suite pura (sin stubs: ral-ocr.ts solo importa TIPOS de catálogo y
 * aNumero de formato.ts — nada de red ni DOM).
 * Ejecutada por scripts/run_all_tests.sh (esbuild → node).
 */
const assert = require('assert')
const {
  extraerDatosRalDeTexto,
  fusionarDatosRal,
  puntuarExtraccionRal,
  extraccionSuficienteRal,
} = require('../src/lib/rackly/ral-ocr')

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

// ── Fixture calibrado con el documento REAL del ERP AJE CARAL (Task 36) ──
const TEXTO_ERP = `
Consulta Requerimiento al Almacén 65 AJE CARAL
Transacción: RAL Requerimiento al Almacén
Documento: 8378     Fecha: 2026/10/27
Área Solicitante: Cadena de Suministro
Solicitante: Enriquez Mogollon, Johnnie Jhodel
Línea: 04 Materia Prima y Materiales
Aprobado Por: Alfaro Chahud, Jussef Alfredo
Almacén: 05 Almacén de Materia Prima
Código Artículo o Descripción UM Centro de Costos Cantidad Pedida Cantidad Aprobada Saldo
12E Sal Industrial KG 14040101 2000.0000 2000.0000 2000.0000
`

// 1. Documento real → encabezado completo
const d1 = extraerDatosRalDeTexto(TEXTO_ERP, [])
check('ERP real: documento = 8378', d1.documento === '8378')
check('ERP real: fecha ISO 2026-10-27 (formato aaaa/mm/dd)', d1.fecha === '2026-10-27')
check('ERP real: transacción completa SIN cortar en "AL ALMACEN"', d1.transaccion === 'RAL REQUERIMIENTO AL ALMACÉN')
check('ERP real: área solicitante', d1.areaSolicitante === 'CADENA DE SUMINISTRO')
check('ERP real: solicitante (solo persona)', d1.solicitante === 'ENRIQUEZ MOGOLLON, JOHNNIE JHODEL')
check('ERP real: aprobado por', d1.aprobadoPor === 'ALFARO CHAHUD, JUSSEF ALFREDO')
check('ERP real: almacén completo SIN contaminar del título', d1.almacen === '05 ALMACÉN DE MATERIA PRIMA')
check('ERP real: línea', d1.linea === '04 MATERIA PRIMA Y MATERIALES')

// 2. Fila del ERP real: código, descripción, und, centro de costos, pedida
check('ERP real: 1 artículo', d1.items.length === 1)
const it1 = d1.items[0]
check('ERP real: código 12E', it1.codigo === '12E')
check('ERP real: descripción "SAL INDUSTRIAL" (el 65 de la columna no nace aquí)', it1.descripcion === 'SAL INDUSTRIAL')
check('ERP real: unidad KG', it1.unidad === 'KG')
check('ERP real: centro de costos 14040101', it1.centroCostos === '14040101')
check('ERP real: cantidad pedida 2000 (NO aprobada ni saldo)', it1.cantidad === 2000)

// 3. Variante OCR SIN acentos y con fusiones de renglones
const d3 = extraerDatosRalDeTexto(
  `TRANSACCION : RAL REQUERIMIENTO AL ALMACEN
DOCUMENTO : 8378 FECHA : 27/10/2026
AREA SOLICITANTE : CADENA DE SUMINISTRO SOLICITANTE : 7126 JUAN PEREZ QUISPE
SOLICITANTE : 7126 JUAN PEREZ QUISPE
ALMACEN : 05 ALMACEN DE MATERIA PRIMA
LINEA : 04 MATERIA PRIMA
`,
  []
)
check('sin acentos: documento', d3.documento === '8378')
check('sin acentos: fecha dd/mm/aaaa → 2026-10-27', d3.fecha === '2026-10-27')
check('sin acentos: área solic. corta en la etiqueta SOLICITANTE siguiente', d3.areaSolicitante === 'CADENA DE SUMINISTRO')
check('sin acentos: solicitante sin DNI (del renglón propio)', d3.solicitante === 'JUAN PEREZ QUISPE')
check('sin acentos: almacén', d3.almacen === '05 ALMACEN DE MATERIA PRIMA')

// 4. Varias filas + miles con coma + fila sin unidad + secuencia de fila
const d4 = extraerDatosRalDeTexto(
  `Documento: 8378
12E Sal Industrial KG 14040101 2,000.0000 2,000.0000 2,000.0000
118 ACIDO CITRICO 14040101 168.0000 168.0000
M25 Barrido diario 25 UN 1.0000
`,
  []
)
check('multi-fila: 3 artículos', d4.items.length === 3)
const i12e = d4.items.find((x) => x.codigo === '12E')
check('multi-fila: miles con coma 2,000.0000 → 2000', i12e && i12e.cantidad === 2000)
const i118 = d4.items.find((x) => x.codigo === '118')
check('multi-fila: fila sin unidad conserva descripción y centro', i118 && i118.descripcion === 'ACIDO CITRICO' && i118.centroCostos === '14040101' && i118.cantidad === 168)
const im25 = d4.items.find((x) => x.codigo === 'M25')
check('multi-fila: código con letra+dígitos', im25 && im25.cantidad === 1)

// 5. Columna de secuencia ("001 12E …") — espejo de la RQ
const d5 = extraerDatosRalDeTexto(
  `Documento: 8378
001 12E SAL INDUSTRIAL KG 14040101 2000.0000
002 118 ACIDO CITRICO 168.0000
`,
  []
)
check('secuencia: 2 artículos', d5.items.length === 2)
check('secuencia: el código real es 12E (no 001)', Boolean(d5.items.find((x) => x.codigo === '12E')))
check('secuencia: el código real es 118 (no 002)', Boolean(d5.items.find((x) => x.codigo === '118')))

// 6. ANTI-RUIDO: sin cifra no hay material; fecha no es material
const d6 = extraerDatosRalDeTexto(
  `Documento: 8378
SAL INDUSTRIAL KG 14040101
004 21/10/2026
`,
  []
)
check('anti-ruido: fila sin cantidad se descarta', d6.items.length === 0)

// 7. CATÁLOGO: match exacto + match por descripción + desconocido
const CATALOGO = [
  { codigo: '12E', descripcion: 'Sal Industrial', un: 'KG' },
  { codigo: '55487', descripcion: 'Base para bebida jarabeada', un: 'LT' },
  { codigo: '118', descripcion: 'Acido Citrico', un: 'KG' },
]
const d7 = extraerDatosRalDeTexto(
  `Documento: 8378
12E SAL INDUSTRIAL 14040101 2000.0000
118 ACIDO CITRICO MONOHIDRATO 168.0000
99999 PRODUCTO DESCONOCIDO XZ 5.0000
`,
  CATALOGO
)
const c12e = d7.items.find((x) => x.codigo === '12E')
check('catálogo: 12E en catálogo + unidad oficial KG', c12e && c12e.enCatalogo && c12e.unidad === 'KG' && !c12e.revision)
const c118 = d7.items.find((x) => x.codigo === '118')
check('catálogo: descripción oficial reemplaza a la leída', c118 && c118.enCatalogo && c118.descripcion === 'Acido Citrico')
const c999 = d7.items.find((x) => x.codigo === '99999')
check('catálogo: desconocido queda a revisión', c999 && !c999.enCatalogo && c999.revision)

// 8. FUSIÓN de 2 pases: unión sin duplicados + avisos de rigor numérico
const paseA = {
  documento: '8378',
  transaccion: 'RAL REQUERIMIENTO AL ALMACEN',
  fecha: '2026-10-27',
  areaSolicitante: 'CADENA DE SUMINISTRO',
  solicitante: 'JUAN PEREZ',
  aprobadoPor: '',
  almacen: '',
  linea: '',
  items: [
    { codigo: '12E', descripcion: 'Sal Industrial', unidad: 'KG', centroCostos: '14040101', cantidad: 2000, enCatalogo: false, revision: true },
    { codigo: '118', descripcion: 'Acido Citrico', unidad: '', centroCostos: '', cantidad: 168, enCatalogo: false, revision: true },
  ],
}
const paseB = {
  documento: '8378',
  transaccion: '',
  fecha: '',
  areaSolicitante: '',
  solicitante: '',
  aprobadoPor: 'ALFARO CHAHUD',
  almacen: '05 ALMACEN',
  linea: '04 MATERIA PRIMA',
  items: [
    { codigo: '12E', descripcion: 'Sal Industrial', unidad: 'KG', centroCostos: '14040101', cantidad: 8000, enCatalogo: false, revision: true },
    { codigo: 'M25', descripcion: 'Barrido diario', unidad: 'UN', centroCostos: '', cantidad: 1, enCatalogo: false, revision: true },
  ],
}
const f = fusionarDatosRal(paseA, paseB)
check('fusión: 3 artículos (unión sin duplicados)', f.items.length === 3)
check('fusión: aprobado por se rellena del pase B', f.aprobadoPor === 'ALFARO CHAHUD')
check('fusión: transacción se conserva del pase A', f.transaccion === 'RAL REQUERIMIENTO AL ALMACEN')
const f12e = f.items.find((x) => x.codigo === '12E')
check('fusión: cantidad discrepante queda a revisión CON aviso', f12e && f12e.revision && (f.avisos ?? []).some((a) => a.includes('12E') && a.includes('2000') && a.includes('8000')))
check('fusión: puntuación mayor con más datos', puntuarExtraccionRal(f) > puntuarExtraccionRal(paseA))

// 9. Suficiencia: items + documento + fecha
check('suficiente: ERP real sí', extraccionSuficienteRal(d1))
check('suficiente: sin documento no', !extraccionSuficienteRal({ ...d1, documento: '' }))

// 10. Texto vacío → estructura vacía
const d10 = extraerDatosRalDeTexto('', [])
check('vacío: estructura vacía sin items', d10.documento === '' && d10.items.length === 0)

// 11. PANTALLA ERP REAL (cajillas SIN dos puntos) — reporte del usuario:
//     el solicitante quedaba DENTRO del área solicitante y la fila
//     "126 SAL INDUSTRIAL KG 65 44040101 …" no se jalaba (columna CEDIS
//     + Parcial/Item al final rompían la corrida decimal).
const PANTALLA_ERP = `
AXS Consulta Requerimiento al Almacen - Sucursal : 65 AJE CARAL
Transaccion RAL REQUERIMIENTO AL ALMACEN Documento 8378 Fecha 27/10/2026
Area Solicitante CADENA DE SUMINISTRO Solicitante 138712 ENRIQUEZ MOGOLLON, IHONNIE JHONEL
Linea 04 MATERIA PRIMA E INSUMOS Aprobado por ALFARO CHAHUD, JUSSEF ALFREDO
Atendido No Compras Fecha Atencion 00/00/0000 Almacen 05 MATERIAS PRIMAS E IN Transaccion SPP SALIDA DE MATERI
Trab. en Curso 0 Mejora 0
Tipo Mantenimiento
Codigo Articulo Und Cedis Lin. Man Equipo Mant. Centro Costo Cant. Pedida Cant. Aprobada Cant Cancelada Saldo Parcial Item Nota
126 SAL INDUSTRIAL KG 65 44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0
`
const d11 = extraerDatosRalDeTexto(PANTALLA_ERP, [])
check('pantalla ERP: documento 8378', d11.documento === '8378')
check('pantalla ERP: fecha 2026-10-27', d11.fecha === '2026-10-27')
check('pantalla ERP: transacción completa sin contaminar', d11.transaccion === 'RAL REQUERIMIENTO AL ALMACEN')
check('pantalla ERP: área solicitante LIMPIA (sin el solicitante dentro)', d11.areaSolicitante === 'CADENA DE SUMINISTRO')
check('pantalla ERP: solicitante con nombre (no vacío)', d11.solicitante === 'ENRIQUEZ MOGOLLON, IHONNIE JHONEL')
check('pantalla ERP: aprobado por', d11.aprobadoPor === 'ALFARO CHAHUD, JUSSEF ALFREDO')
check('pantalla ERP: almacén SIN ":" (cajilla)', d11.almacen === '05 MATERIAS PRIMAS E IN')
check('pantalla ERP: línea sin contaminar del "Aprobado por"', d11.linea === '04 MATERIA PRIMA E INSUMOS')
check('pantalla ERP: 1 artículo jalado', d11.items.length === 1)
const p11 = d11.items[0]
if (p11) {
  check('pantalla ERP: código 126', p11.codigo === '126')
  check('pantalla ERP: artículo SAL INDUSTRIAL (sin KG/CEDIS/basura)', p11.descripcion === 'SAL INDUSTRIAL')
  check('pantalla ERP: und KG (ya no está pegada a la cifra)', p11.unidad === 'KG')
  check('pantalla ERP: centro de costos 44040101', p11.centroCostos === '44040101')
  check('pantalla ERP: cantidad pedida 2000 (no aprobada/saldo/parcial)', p11.cantidad === 2000)
}

// 12. FILA PARTIDA por el OCR (código y descripción en renglones propios)
const d12 = extraerDatosRalDeTexto(
  `Documento 8378
126
SAL INDUSTRIAL KG
44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0
`,
  []
)
check('fila partida: 1 artículo fusionado', d12.items.length === 1)
const p12 = d12.items[0]
if (p12) {
  check('fila partida: código 126 (venía en su renglón)', p12.codigo === '126')
  check('fila partida: descripción desde el fragmento', p12.descripcion === 'SAL INDUSTRIAL')
  check('fila partida: und KG del fragmento', p12.unidad === 'KG')
  check('fila partida: centro 44040101 (era el líder de las cifras)', p12.centroCostos === '44040101')
  check('fila partida: cantidad 2000', p12.cantidad === 2000)
}

// 13. "JEFE DE COMPRAS" como solicitante: la palabra COMPRAS ya no corta
const d13 = extraerDatosRalDeTexto('SOLICITANTE : JEFE DE COMPRAS\nDocumento: 8378', [])
check('solicitante "JEFE DE COMPRAS" completo', d13.solicitante === 'JEFE DE COMPRAS')

console.log(`\nSuite ral-ocr: ${ok} checks OK`)
if (process.exitCode) console.error('HUBO FALLOS ✗')
