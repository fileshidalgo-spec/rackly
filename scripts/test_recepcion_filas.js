/**
 * RACKLY — Tests unitarios de recepcion-filas.ts (paletas + agrupado por guía).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_recepcion_filas.js --bundle --platform=node --outfile=/tmp/test_filas.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/test_filas.cjs
 *
 * Escenarios:
 *   1. expandirEnFilas: sin dividir → 1 fila · dividido → 1 fila por paleta.
 *   2. Paletas con vacías/cero → solo las válidas · todas vacías → total.
 *   3. distribuirEquitativo + sumaPaletas + avisosDePaletas.
 *   4. agruparGuias: 1 fila por guía (con y sin Nº de documento) + totales.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const {
  expandirEnFilas,
  distribuirEquitativo,
  sumaPaletas,
  avisosDePaletas,
  agruparGuias,
  claveGuiaDe,
} = require('@/lib/rackly/recepcion-filas')

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

const base = {
  codigo: '5653',
  descripcion: 'PURE DE DURAZNO 30-32 ºBRIX',
  cantidad: '10000',
  unidad: 'KG',
  lote: 'L-77',
  fechaProduccion: '2026-10-01',
  fechaVencimiento: '2027-10-01',
}

// ─── 1. expandirEnFilas ───
console.log('\n[1] expandirEnFilas — artículo sin dividir')
const sinDividir = expandirEnFilas([{ ...base }])
check('sin paletas → 1 fila con el total', sinDividir.length === 1 && sinDividir[0].cantidadNum === 10000, JSON.stringify(sinDividir))
check('sin etiqueta de paleta', sinDividir[0].paleta === '')

console.log('\n[2] expandirEnFilas — artículo dividido en 5 paletas')
const dividido = expandirEnFilas([{ ...base, paletas: ['2200', '1800', '2000', '2500', '1500'] }])
check('5 paletas → 5 filas (el usuario rota paleta por paleta)', dividido.length === 5, `obtuvo ${dividido.length}`)
check('cada fila lleva SU cantidad', dividido.map((f) => f.cantidadNum).join(',') === '2200,1800,2000,2500,1500', JSON.stringify(dividido.map((f) => f.cantidad)))
check('etiquetas Paleta 1/5 … Paleta 5/5', dividido[0].paleta === 'Paleta 1/5' && dividido[4].paleta === 'Paleta 5/5', JSON.stringify(dividido.map((f) => f.paleta)))
check('el encabezado (código/lote/fechas) se replica en cada paleta', dividido.every((f) => f.codigo === '5653' && f.lote === 'L-77' && f.fechaVencimiento === '2027-10-01'))

console.log('\n[3] expandirEnFilas — paletas con vacíos y ceros')
const conVacias = expandirEnFilas([{ ...base, paletas: ['3000', '', '0', '7000'] }])
check('las paletas vacías/cero NO generan filas', conVacias.length === 2, JSON.stringify(conVacias.map((f) => f.cantidadNum)))
const todasVacias = expandirEnFilas([{ ...base, paletas: ['', ''] }])
check('todas vacías → cae a la fila con el TOTAL (nunca se pierde el artículo)', todasVacias.length === 1 && todasVacias[0].cantidadNum === 10000, JSON.stringify(todasVacias))
const unaSola = expandirEnFilas([{ ...base, paletas: ['4000'] }])
check('una sola paleta con cantidad → fila única con el total (no la paleta)', unaSola.length === 1 && unaSola[0].cantidadNum === 10000, JSON.stringify(unaSola))

// ─── 4. distribuirEquitativo + suma + avisos ───
console.log('\n[4] distribuirEquitativo / sumaPaletas / avisosDePaletas')
const eq = distribuirEquitativo('10000', 3)
check('10,000 en 3 → 3333.333 / 3333.333 / 3333.334 (el residuo cae al final)', eq.join('|') === '3333.333|3333.333|3333.334', JSON.stringify(eq))
check('la distribución suma exactamente el total', Math.abs(sumaPaletas(eq) - 10000) < 0.001, String(sumaPaletas(eq)))
check('total inválido → paletas vacías', distribuirEquitativo('', 3).every((p) => p === ''))
check('sumaPaletas ignora vacíos', sumaPaletas(['2200', '', '1800']) === 4000, String(sumaPaletas(['2200', '', '1800'])))

const avisos = avisosDePaletas([{ ...base, paletas: ['2200', '1800', '2000'] }])
check('paletas 6000 ≠ total 10000 → 1 aviso', avisos.length === 1 && avisos[0].includes('5653') && avisos[0].includes('6000'), JSON.stringify(avisos))
check('paletas que cuadran → sin avisos', avisosDePaletas([{ ...base, paletas: ['4000', '6000'] }]).length === 0)
check('artículo sin dividir → sin avisos', avisosDePaletas([{ ...base }]).length === 0)

// ─── 5. agruparGuias — UNA fila por guía en el registro ───
console.log('\n[5] agruparGuias — registro agrupado por documento')
const filaBd = (sobre) => ({
  id: Math.random().toString(36).slice(2),
  createdAt: '2026-10-11T10:00:00Z',
  fecha: '2026-10-11',
  tipoDocumento: 'Guia',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJEPER',
  placa: 'V3P-114',
  fotoUrl: '',
  estado: 'Pendiente',
  usuarioId: 'u1',
  usuarioNombre: 'Miguel',
  usuarioCorreo: 'm@e.pe',
  codigo: '5653',
  descripcion: 'PURE DE DURAZNO',
  cantidad: 1000,
  unidadMedida: 'KG',
  lote: '',
  fechaProduccion: '',
  fechaVencimiento: '',
  observaciones: '',
  ...sobre,
})
const grupos = agruparGuias([
  filaBd({ codigo: '5653', cantidad: 1000 }),
  filaBd({ codigo: '118', cantidad: 50, observaciones: 'Paleta 1/2' }),
  filaBd({ codigo: '118', cantidad: 30, observaciones: ' · Paleta 2/2' }),
  filaBd({ numeroDocumento: 'T005-0034403', proveedor: 'SAN MIGUEL', codigo: '208', cantidad: 10 }),
])
check('3 filas de T173 + 1 de T005 → 2 guías (no 4 filas)', grupos.length === 2, `obtuvo ${grupos.length}`)
check('la guía T173 contiene TODAS sus filas (3)', grupos[0].filas.length === 3, String(grupos[0].filas.length))
check('cantidad total = suma de las filas de la guía', grupos[0].cantidadTotal === 1080, String(grupos[0].cantidadTotal))
check('estado uniforme heredado', grupos[0].estado === 'Pendiente')
const mezclados = agruparGuias([
  filaBd({ codigo: '5653' }),
  filaBd({ codigo: '118', estado: 'Recibido' }),
])
check('estados distintos en la misma guía → estado vacío ("Mixto" en la UI)', mezclados[0].estado === '')

console.log('\n[6] agruparGuias — guía SIN número de documento (huella fecha+tipo+proveedor)')
const sinNumero = agruparGuias([
  filaBd({ numeroDocumento: '', codigo: '5653' }),
  filaBd({ numeroDocumento: '', codigo: '118' }),
  filaBd({ numeroDocumento: '', proveedor: 'OTRO', codigo: '208' }),
])
check('2 filas mismo día/proveedor → 1 guía; el proveedor distinto → otra', sinNumero.length === 2 && sinNumero[0].filas.length === 2, JSON.stringify(sinNumero.map((g) => g.filas.length)))
check('clave distinta entre con-Nº y sin-Nº', claveGuiaDe({ tipoDocumento: 'Guia', numeroDocumento: 'T1-1', fecha: 'x', proveedor: 'y' }) !== claveGuiaDe({ tipoDocumento: 'Guia', numeroDocumento: '', fecha: 'x', proveedor: 'y' }))

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
