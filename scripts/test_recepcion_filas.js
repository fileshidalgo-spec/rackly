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
  filasAItems,
  obsSinMarcaPaleta,
  marcaPaletaDe,
  repartirEquitativo,
  totalParaRedistribuir,
  combinarPaletas,
  aPaleta,
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

/** Formato ACTUAL del editor: paleta-objeto (cantidad + lote/fechas propios). */
const pal = (cantidades) =>
  cantidades.map((c) => ({ cantidad: c, lote: '', fechaProduccion: '', fechaVencimiento: '' }))

// ─── 1. expandirEnFilas ───
console.log('\n[1] expandirEnFilas — artículo sin dividir')
const sinDividir = expandirEnFilas([{ ...base }])
check('sin paletas → 1 fila con el total', sinDividir.length === 1 && sinDividir[0].cantidadNum === 10000, JSON.stringify(sinDividir))
check('sin etiqueta de paleta', sinDividir[0].paleta === '')

console.log('\n[2] expandirEnFilas — artículo dividido en 5 paletas')
const dividido = expandirEnFilas([{ ...base, paletas: pal(['2200', '1800', '2000', '2500', '1500']) }])
check('5 paletas → 5 filas (el usuario rota paleta por paleta)', dividido.length === 5, `obtuvo ${dividido.length}`)
check('cada fila lleva SU cantidad', dividido.map((f) => f.cantidadNum).join(',') === '2200,1800,2000,2500,1500', JSON.stringify(dividido.map((f) => f.cantidad)))
check('etiquetas Paleta 1/5 … Paleta 5/5', dividido[0].paleta === 'Paleta 1/5' && dividido[4].paleta === 'Paleta 5/5', JSON.stringify(dividido.map((f) => f.paleta)))
check('el encabezado (código/lote/fechas) se replica en cada paleta', dividido.every((f) => f.codigo === '5653' && f.lote === 'L-77' && f.fechaVencimiento === '2027-10-01'))

console.log('\n[3] expandirEnFilas — paletas con vacíos y ceros')
const conVacias = expandirEnFilas([{ ...base, paletas: pal(['3000', '', '0', '7000']) }])
check('las paletas vacías/cero NO generan filas', conVacias.length === 2, JSON.stringify(conVacias.map((f) => f.cantidadNum)))
const todasVacias = expandirEnFilas([{ ...base, paletas: pal(['', '']) }])
check('todas vacías → cae a la fila con el TOTAL (nunca se pierde el artículo)', todasVacias.length === 1 && todasVacias[0].cantidadNum === 10000, JSON.stringify(todasVacias))
const unaSola = expandirEnFilas([{ ...base, paletas: pal(['4000']) }])
check('una sola paleta con cantidad → fila única con el total (no la paleta)', unaSola.length === 1 && unaSola[0].cantidadNum === 10000, JSON.stringify(unaSola))

// ─── 4. distribuirEquitativo + suma + avisos ───
console.log('\n[4] distribuirEquitativo / sumaPaletas / avisosDePaletas')
const eq = distribuirEquitativo('10000', 3)
check('10,000 en 3 → 3333.333 / 3333.333 / 3333.334 (el residuo cae al final)', eq.join('|') === '3333.333|3333.333|3333.334', JSON.stringify(eq))
check('la distribución suma exactamente el total', Math.abs(sumaPaletas(eq) - 10000) < 0.001, String(sumaPaletas(eq)))
check('total inválido → paletas vacías', distribuirEquitativo('', 3).every((p) => p === ''))
check('sumaPaletas ignora vacíos', sumaPaletas(['2200', '', '1800']) === 4000, String(sumaPaletas(['2200', '', '1800'])))

// ─── 4b. REPARTO AUTOMÁTICO al cambiar el nº de paletas ───
// Pedido del usuario: "si aumento la cantidad de paletas a la que dividiré
// se vaya dividiendo a cada que aumente — 100 en 4 paletas → 25 por paleta;
// 100 en 3, borro 1 → quedan 50 y 50".
console.log('\n[4b] repartirEquitativo / totalParaRedistribuir — reparto al agregar/quitar')
const art100 = { ...base, cantidad: '100' }
check('total manda: 100 → 4 paletas = 25 por paleta', JSON.stringify(repartirEquitativo(art100, 4)) === JSON.stringify(['25', '25', '25', '25']), JSON.stringify(repartirEquitativo(art100, 4)))
check('100 en 3 → 33.333/33.333/33.334 (residuo al final)', JSON.stringify(repartirEquitativo(art100, 3)) === JSON.stringify(['33.333', '33.333', '33.334']), JSON.stringify(repartirEquitativo(art100, 3)))
check('100 en 2 → 50 y 50 (caso "borro y quedan 50 y 50")', JSON.stringify(repartirEquitativo(art100, 2)) === JSON.stringify(['50', '50']), JSON.stringify(repartirEquitativo(art100, 2)))
const editado = { ...base, cantidad: '100', paletas: pal(['60', '40', '']) }
check('con paletas editadas a mano TAMBIÉN reparte (mandan las reglas, no lo tecleado)', JSON.stringify(repartirEquitativo(editado, 3)) === JSON.stringify(['33.333', '33.333', '33.334']), JSON.stringify(repartirEquitativo(editado, 3)))
const sinTotal = { ...base, cantidad: '', paletas: pal(['30', '50']) }
check('sin total digitado usa la SUMA actual de las paletas (80 → 3 = 26.666×2 + 26.668)', JSON.stringify(repartirEquitativo(sinTotal, 3)) === JSON.stringify(['26.666', '26.666', '26.668']), JSON.stringify(repartirEquitativo(sinTotal, 3)))
check('sin total y con suma 0 → null (la UI conserva/agrega vacía)', repartirEquitativo({ ...base, cantidad: '', paletas: pal(['', '']) }, 3) === null)
check('totalParaRedistribuir: total válido manda', totalParaRedistribuir(art100) === 100)
check('totalParaRedistribuir: sin total → suma de paletas', totalParaRedistribuir(sinTotal) === 80)
check('totalParaRedistribuir: sin nada → NaN', isNaN(totalParaRedistribuir({ ...base, cantidad: '', paletas: pal(['']) })))
check('reparto a 1 paleta → null (1 no es dividir)', repartirEquitativo(art100, 1) === null)
const repartidoSuma = sumaPaletas(repartirEquitativo(art100, 4) ?? [])
check('el reparto SIEMPRE suma el total del artículo', Math.abs(repartidoSuma - 100) < 0.001, String(repartidoSuma))

const avisos = avisosDePaletas([{ ...base, paletas: pal(['2200', '1800', '2000']) }])
check('paletas 6000 ≠ total 10000 → 1 aviso', avisos.length === 1 && avisos[0].includes('5653') && avisos[0].includes('6000'), JSON.stringify(avisos))
check('paletas que cuadran → sin avisos', avisosDePaletas([{ ...base, paletas: pal(['4000', '6000']) }]).length === 0)
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

console.log('\n[7] filasAItems — re-ensamblado para EDITAR una guía registrada')
const itemsReensamblados = filasAItems([
  filaBd({ codigo: '5653', cantidad: 1000, observaciones: '' }),
  filaBd({ codigo: '118', cantidad: 40, observaciones: 'obs usuario · Paleta 1/3' }),
  filaBd({ codigo: '118', cantidad: 35, observaciones: 'obs usuario · Paleta 2/3' }),
  filaBd({ codigo: '118', cantidad: 25, observaciones: 'obs usuario · Paleta 3/3' }),
  filaBd({ codigo: '208', cantidad: 10, observaciones: '' }),
])
check('5 filas (1 dividida en 3) → 3 items (5653, 118 con paletas, 208)', itemsReensamblados.length === 3, JSON.stringify(itemsReensamblados.map((i) => i.codigo)))
const it118 = itemsReensamblados[1]
check('el item 118 queda con 3 paletas 40/35/25', it118.paletas && it118.paletas.length === 3 && it118.paletas.map((p) => p.cantidad).join(',') === '40,35,25', JSON.stringify(it118.paletas))
check('el total del item dividido = suma de sus paletas (100)', it118.cantidad === '100', it118.cantidad)
check('los items sin dividir conservan su cantidad', itemsReensamblados[0].cantidad === '1000' && itemsReensamblados[2].cantidad === '10')
check('round-trip expandirEnFilas(filasAItems) reproduce las MISMAS cantidades', JSON.stringify(expandirEnFilas(itemsReensamblados).map((f) => [f.codigo, f.cantidadNum, f.paleta])) === JSON.stringify([['5653', 1000, ''], ['118', 40, 'Paleta 1/3'], ['118', 35, 'Paleta 2/3'], ['118', 25, 'Paleta 3/3'], ['208', 10, '']]))

console.log('\n[8] filasAItems — casos borde')
const mismoCodigoDosFilas = filasAItems([
  filaBd({ codigo: '118', cantidad: 40, observaciones: 'Paleta 1/2' }),
  filaBd({ codigo: '118', cantidad: 30, observaciones: 'Paleta 2/2' }),
  filaBd({ codigo: '118', cantidad: 7, observaciones: '' }),
])
check('un código 2 paletas + misma código fila suelta LUEGO → items separados', mismoCodigoDosFilas.length === 2 && mismoCodigoDosFilas[0].paletas?.length === 2 && !mismoCodigoDosFilas[1].paletas, JSON.stringify(mismoCodigoDosFilas.map((i) => [i.cantidad, i.paletas?.length ?? 0])))
const huerfana = filasAItems([
  filaBd({ codigo: '118', cantidad: 5, observaciones: 'Paleta 2/3' }),
  filaBd({ codigo: '118', cantidad: 6, observaciones: 'Paleta 3/3' }),
])
check('grupo de paletas huérfano (falta la 1ª) se re-ensambla igual', huerfana.length === 1 && huerfana[0].paletas?.length === 2, JSON.stringify(huerfana))
check('obsSinMarcaPaleta quita la marca y deja el texto del usuario', obsSinMarcaPaleta('obs usuario · Paleta 2/3') === 'obs usuario', obsSinMarcaPaleta('obs usuario · Paleta 2/3'))
check('marcaPaletaDe valida rangos', marcaPaletaDe('Paleta 3/3')?.i === 3 && marcaPaletaDe('Paleta 4/3') === null && marcaPaletaDe('sin marca') === null)

// ─── 9. LOTE/FECHAS POR PALETA (pedido: corregir vencimiento/producción/lote
//         de UNA paleta específica — o de todas — sin tocar código,
//         descripción ni cantidad total) ───
console.log('\n[9] lote/fechas por paleta — herencia + datos propios')
const conPropios = expandirEnFilas([
  {
    ...base,
    paletas: [
      { cantidad: '4000', lote: '', fechaProduccion: '', fechaVencimiento: '' },
      { cantidad: '6000', lote: 'L-2', fechaProduccion: '2026-09-15', fechaVencimiento: '2027-06-01' },
    ],
  },
])
check('2 paletas → 2 filas', conPropios.length === 2, JSON.stringify(conPropios.map((f) => f.cantidadNum)))
check('paleta 1 (vacía) HEREDA el lote/fechas del artículo', conPropios[0].lote === 'L-77' && conPropios[0].fechaProduccion === '2026-10-01' && conPropios[0].fechaVencimiento === '2027-10-01', JSON.stringify(conPropios[0]))
check('paleta 2 usa SUS datos PROPIOS', conPropios[1].lote === 'L-2' && conPropios[1].fechaProduccion === '2026-09-15' && conPropios[1].fechaVencimiento === '2027-06-01', JSON.stringify(conPropios[1]))
check('código/descripción idénticos en ambas (JAMÁS cambian)', conPropios.every((f) => f.codigo === '5653' && f.descripcion === base.descripcion))
check('la suma sigue siendo el total del artículo', Math.abs(conPropios.reduce((s, f) => s + f.cantidadNum, 0) - 10000) < 0.001)

console.log('\n[9b] combinarPaletas — reparto que conserva lo digitado por paleta')
const previas = [
  { cantidad: '10', lote: 'LX', fechaProduccion: '2026-08-01', fechaVencimiento: '2027-02-01' },
  { cantidad: '20', lote: '', fechaProduccion: '', fechaVencimiento: '' },
]
const combinadas = combinarPaletas(previas, ['50', '50'])
check('conserva el lote/fechas PROPIO de la 1ª y toma la cantidad nueva', combinadas[0].cantidad === '50' && combinadas[0].lote === 'LX' && combinadas[0].fechaVencimiento === '2027-02-01', JSON.stringify(combinadas[0]))
check('la 2ª (vacía) sigue heredando', combinadas[1].cantidad === '50' && combinadas[1].lote === '' && combinadas[1].fechaVencimiento === '')
const conNueva = combinarPaletas(previas, ['30', '30', '40'])
check('paleta NUEVA al agregar: hereda del artículo (override vacío)', conNueva.length === 3 && conNueva[2].cantidad === '40' && conNueva[2].lote === '', JSON.stringify(conNueva[2]))
const sinReparto = combinarPaletas(previas, null)
check('sin reparto (null) conserva las cantidades tal cual', sinReparto.map((p) => p.cantidad).join(',') === '10,20')
check('acepta paletas en formato viejo (string) sin romper', combinarPaletas(['5', '7'], ['1', '2', '3'])[0].cantidad === '1' && combinarPaletas(['5', '7'], null)[1].cantidad === '7')
check('aPaleta: string viejo → objeto con SOLO la cantidad', aPaleta('42').cantidad === '42' && aPaleta('42').lote === '' && aPaleta('42').fechaVencimiento === '')

console.log('\n[9c] filasAItems — re-ensambla los datos propios de cada paleta')
const registrada = filasAItems([
  filaBd({ codigo: '118', cantidad: 40, observaciones: 'Paleta 1/2', lote: 'L-1', fechaVencimiento: '2027-01-01' }),
  filaBd({ codigo: '118', cantidad: 60, observaciones: 'obs · Paleta 2/2', lote: 'L-2', fechaVencimiento: '2027-06-30' }),
])
const itReg = registrada[0]
check('la 1ª fila define el artículo y NO lleva override', itReg.lote === 'L-1' && itReg.paletas[0].lote === '' && itReg.paletas[0].fechaVencimiento === '')
check('la 2ª paleta recupera SU lote/fechas distintos', itReg.paletas[1].lote === 'L-2' && itReg.paletas[1].fechaVencimiento === '2027-06-30', JSON.stringify(itReg.paletas[1]))
check('total del item = suma de paletas (100)', itReg.cantidad === '100')
check('ROUND-TRIP completo con datos por paleta', JSON.stringify(expandirEnFilas(registrada).map((f) => [f.cantidadNum, f.lote, f.fechaVencimiento])) === JSON.stringify([[40, 'L-1', '2027-01-01'], [60, 'L-2', '2027-06-30']]))
const mismaTodo = filasAItems([
  filaBd({ codigo: '208', cantidad: 10, observaciones: 'Paleta 1/2', lote: 'LX', fechaVencimiento: '2027-03-03' }),
  filaBd({ codigo: '208', cantidad: 5, observaciones: 'Paleta 2/2', lote: 'LX', fechaVencimiento: '2027-03-03' }),
])
check('paletas con el MISMO lote/fechas → sin overrides (heredan)', mismaTodo[0].lote === 'LX' && mismaTodo[0].paletas.every((p) => p.lote === '' && p.fechaVencimiento === ''))

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
