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
  faltanProveedor,
  agruparGuias,
  claveGuiaDe,
  filasAItems,
  obsSinMarcaPaleta,
  marcaPaletaDe,
  repartirEquitativo,
  totalParaRedistribuir,
  combinarPaletas,
  aPaleta,
  planSyncEdicionPorId,
  MAX_PALETAS,
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

console.log('\n[2b] LÍMITE 44 paletas (pedido 2026-10: camión completo paleta por paleta)')
check('MAX_PALETAS = 44', MAX_PALETAS === 44, String(MAX_PALETAS))
const cantidades44 = Array.from({ length: 44 }, (_, i) => String(227 + i)) // 227..270 → suma 10934
const dividido44 = expandirEnFilas([{ ...base, cantidad: '10934', paletas: pal(cantidades44) }])
check('44 paletas → 44 filas', dividido44.length === 44, `obtuvo ${dividido44.length}`)
check('marcas Paleta 1/44 … Paleta 44/44', dividido44[0].paleta === 'Paleta 1/44' && dividido44[43].paleta === 'Paleta 44/44', `${dividido44[0].paleta} .. ${dividido44[dividido44.length - 1].paleta}`)
check('cada paleta conserva SU cantidad (índice 43 → 270)', dividido44[43].cantidadNum === 270)
check('marcaPaletaDe entiende i de 2 dígitos', JSON.stringify(marcaPaletaDe('Paleta 44/44')) === '{"i":44,"n":44}')
check('reparto equitativo de 10934 en 44 → suma exacta', (() => {
  const rep = distribuirEquitativo('10934', 44)
  return rep.length === 44 && Math.abs(sumaPaletas(rep) - 10934) < 0.001
})())

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
  empresaOrigen: 'AJEPER',
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

// ─── [10] SINCRONIZACIÓN DE EDICIÓN POR IDENTIDAD (bug P0 corregido) ───
console.log('\n[10] planSyncEdicionPorId — identidad, nunca posición')
{
  const p = (filaId, codigo) => ({ filaId, codigo, cantidad: 1 })

  // REORDENAMIENTO: el contenido de cada fila va a SU PROPIO id (antes el
  // sincronizado posicional cruzaba contenido al desplazarse la lista).
  const reorden = planSyncEdicionPorId(['id-A', 'id-B'], [p('id-B', 'COD-B'), p('id-A', 'COD-A')])
  check('reordenado: 2 updates, 0 insert/delete', reorden.actualizar.length === 2 && reorden.insertar.length === 0 && reorden.eliminar.length === 0)
  check('COD-B va al id-B (no cruza)', reorden.actualizar.some((u) => u.id === 'id-B' && u.fila.codigo === 'COD-B'))
  check('COD-A va al id-A (no cruza)', reorden.actualizar.some((u) => u.id === 'id-A' && u.fila.codigo === 'COD-A'))

  // QUITAR un artículo del medio: la fila sobrante se DELETEa, las demás
  // conservan su identidad (antes: todo se desplazaba y se cruzaba).
  const quitar = planSyncEdicionPorId(['id-A', 'id-B', 'id-C'], [p('id-A', 'COD-A'), p('id-C', 'COD-C')])
  check('quitar del medio: 2 updates + 1 delete (id-B)', quitar.actualizar.length === 2 && JSON.stringify(quitar.eliminar) === JSON.stringify(['id-B']))
  check('sin cruces tras quitar', quitar.actualizar.every((u) => u.fila.codigo === 'COD-' + u.id.slice(3)))

  // AGREGAR: sin filaId → INSERT.
  const agregar = planSyncEdicionPorId(['id-A'], [p('id-A', 'COD-A'), { filaId: null, codigo: 'NUEVO', cantidad: 1 }])
  check('agregar: 1 update + 1 insert + 0 delete', agregar.actualizar.length === 1 && agregar.insertar.length === 1 && agregar.eliminar.length === 0)

  // DIVIDIR (1 fila → 2 paletas): la paleta 1 conserva el id de la fila;
  // la paleta 2 nace sin id → INSERT.
  const dividir = planSyncEdicionPorId(['id-A'], [p('id-A', 'COD-A'), { filaId: null, codigo: 'COD-A', cantidad: 1 }])
  check('dividir: paleta 1 actualiza id-A, paleta 2 inserta', dividir.actualizar.length === 1 && dividir.actualizar[0].id === 'id-A' && dividir.insertar.length === 1)

  // UNIR paletas (2 filas → 1 fila): la fila sobrante se DELETEa.
  const unir = planSyncEdicionPorId(['id-A', 'id-B'], [p('id-A', 'COD-A')])
  check('unir paletas: 1 update + delete id-B', unir.actualizar.length === 1 && JSON.stringify(unir.eliminar) === JSON.stringify(['id-B']))

  // SEGURIDAD: dos filas reclamando el mismo id → la 1ª actualiza, la 2ª
  // inserta (nunca doble escritura sobre una misma fila).
  const dupli = planSyncEdicionPorId(['id-A'], [p('id-A', 'UNO'), p('id-A', 'DOS')])
  check('id reclamado 2 veces: 1º update, 2º insert', dupli.actualizar.length === 1 && dupli.actualizar[0].fila.codigo === 'UNO' && dupli.insertar.length === 1)

  // SEGURIDAD: filaId ajeno a la guía → INSERT (jamás escribe sobre una
  // fila que no es suya).
  const ajeno = planSyncEdicionPorId(['id-A'], [p('id-X', 'AJENO')])
  check('filaId ajeno → insert seguro (no toca id-X)', ajeno.actualizar.length === 0 && ajeno.insertar.length === 1 && ajeno.eliminar.length === 1)
}

console.log('\n[10b] filaId viaja por TODO el pipeline de edición')
{
  // filasAItems adjunta identidades → el editor las preserva en las
  // paletas → expandirEnFilas las re-adjunta a las filas.
  const f1 = filaBd({ codigo: '301', cantidad: 40, observaciones: 'Paleta 1/2' })
  const f2 = filaBd({ codigo: '301', cantidad: 60, observaciones: 'Paleta 2/2' })
  const items = filasAItems([f1, f2])
  check('paleta 1 conserva el id de su fila', items[0].paletas[0].filaId === f1.id)
  check('paleta 2 conserva el id de su fila', items[0].paletas[1].filaId === f2.id)
  const filas = expandirEnFilas(items)
  check('expandir: fila 1 lleva filaId de paleta 1', filas[0].filaId === f1.id)
  check('expandir: fila 2 lleva filaId de paleta 2', filas[1].filaId === f2.id)
  check('round-trip 2 filas → 2 filas con las MISMAS identidades', filas.length === 2 && filas.every((f) => !!f.filaId))

  // combinarPaletas preserva identidades por POSICIÓN (quitar paleta 1
  // deja la identidad de la paleta 2 en su posición — el par (filaId,
  // cantidad) no se re-asigna).
  const comb = combinarPaletas(items[0].paletas, ['25', '75'])
  check('combinar: identidades intactas por posición', comb[0].filaId === f1.id && comb[1].filaId === f2.id)
  const quitarPrimera = combinarPaletas(items[0].paletas.slice(1), null)
  check('tras quitar la 1ª paleta, la restante conserva SU id', quitarPrimera.length === 1 && quitarPrimera[0].filaId === f2.id)
  const conNuevaId = combinarPaletas(items[0].paletas, ['20', '40', '40'])
  check('paleta NUEVA nace sin identidad (filaId null)', conNuevaId[2].filaId === null && conNuevaId[0].filaId === f1.id)

  // Artículo sin dividir: fila única lleva el id del item.
  const simple = filasAItems([filaBd({ codigo: '5653', cantidad: 100 })])
  const filaSimple = expandirEnFilas(simple)
  check('artículo sin dividir: filaId = id de su fila', filaSimple[0].filaId === simple[0].filaId)
}

console.log('\n[10c] expandirEnFilas — total VACÍO con UNA paleta válida (antes: 0 silencioso)')
{
  const caso = [
    {
      codigo: '118', descripcion: 'X', cantidad: '', unidad: 'KG', lote: 'L-BASE',
      fechaProduccion: '', fechaVencimiento: '', filaId: 'id-CAB',
      paletas: [{ cantidad: '60', lote: 'L-P1', fechaProduccion: '', fechaVencimiento: '', filaId: 'id-P1' }],
    },
  ]
  const filas = expandirEnFilas(caso)
  check('total vacío + 1 paleta → registra la PALETA (60), no 0', filas.length === 1 && filas[0].cantidadNum === 60, JSON.stringify(filas))
  check('...y usa el lote PROPIO de la paleta', filas[0].lote === 'L-P1')
  check('...y conserva la identidad de la paleta', filas[0].filaId === 'id-P1')

  // Con total DIGITADO manda el total (comportamiento fijado por tests).
  const conTotal = expandirEnFilas([{ ...caso[0], cantidad: '100' }])
  check('con total digitado: manda el total (100)', conTotal[0].cantidadNum === 100 && conTotal[0].paleta === '')
  check('con total digitado: identidad = fila cabecera del item', conTotal[0].filaId === 'id-CAB')

  // Sin total y SIN paletas válidas → sigue viniendo itemsValidos antes;
  // la fila única con 0 se mantiene como último recurso (sin cambio).
  const vacio = expandirEnFilas([{ ...caso[0], paletas: [] }])
  check('sin total y sin paletas: fila 0 (sin cambio de contrato)', vacio[0].cantidadNum === 0)
}

console.log('\n[11] proveedor del artículo y de la paleta (empresa de origen separada, 2026-10-22)')
{
  // Artículo film CON proveedor → la fila lo lleva.
  const film = expandirEnFilas([
    {
      ...base,
      descripcion: 'LAMINA TERMOCOCONTRAIBLE 500',
      proveedor: 'NEOPACK',
    },
  ])
  check('artículo film: la fila lleva SU proveedor', film[0].proveedor === 'NEOPACK')

  // Artículo no-film sin proveedor → '' (no arrastra nada).
  const noFilm = expandirEnFilas([{ ...base }])
  check("artículo no film: fila sin proveedor ('')", noFilm[0].proveedor === '')

  // DIVIDIDO: una paleta de OTRO proveedor; las demás heredan.
  const div = expandirEnFilas([
    {
      ...base,
      descripcion: 'STRETCH FILM 500',
      proveedor: 'INCOMIN',
      paletas: [
        { cantidad: '40', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: '' },
        { cantidad: '60', lote: '', fechaProduccion: '', fechaVencimiento: '', proveedor: 'DAMAR' },
      ],
    },
  ])
  check('paleta sin proveedor propio hereda el del artículo', div[0].proveedor === 'INCOMIN')
  check('paleta con proveedor PROPIO lo conserva', div[1].proveedor === 'DAMAR')

  // Round-trip de EDICIÓN: filas → items → filas reproduce los overrides.
  const f1 = filaBd({ codigo: '301', cantidad: 40, observaciones: 'Paleta 1/2', proveedor: 'INCOMIN', empresaOrigen: 'AJEPER S.A.' })
  const f2 = filaBd({ codigo: '301', cantidad: 60, observaciones: 'Paleta 2/2', proveedor: 'DAMAR', empresaOrigen: 'AJEPER S.A.' })
  const itemsEd = filasAItems([f1, f2])
  check('edición: paleta 1 hereda (mismo proveedor que el artículo)', itemsEd[0].paletas[0].proveedor === '')
  check('edición: paleta 2 conserva SU proveedor distinto', itemsEd[0].paletas[1].proveedor === 'DAMAR')
  const reExp = expandirEnFilas(itemsEd)
  check('re-expandir: fila 1 INCOMIN · fila 2 DAMAR (round-trip exacto)', reExp[0].proveedor === 'INCOMIN' && reExp[1].proveedor === 'DAMAR')

  // combinarPaletas conserva el proveedor propio al agregar/quitar/repartir.
  const comb = combinarPaletas(itemsEd[0].paletas, ['30', '70'])
  check('combinar: proveedor propio intacto por posición', comb[0].proveedor === '' && comb[1].proveedor === 'DAMAR')
  const conNueva = combinarPaletas(itemsEd[0].paletas, ['20', '40', '40'])
  check("paleta NUEVA nace heredando (proveedor '')", conNueva[2].proveedor === '')

  // faltanProveedor: MISMA regla que Racks (requiereProveedor).
  check(
    'faltanProveedor: film sin proveedor se detecta',
    JSON.stringify(faltanProveedor([{ ...base, descripcion: 'LAMINA TERMOCOCONTRAIBLE 500' }])) === JSON.stringify(['5653'])
  )
  check(
    'faltanProveedor: film CON proveedor pasa',
    faltanProveedor([{ ...base, descripcion: 'STRETCH FILM 500', proveedor: 'ITS' }]).length === 0
  )
  check(
    'faltanProveedor: no-film no se exige',
    faltanProveedor([{ ...base, descripcion: 'PURE DE DURAZNO' }]).length === 0
  )
  check(
    'faltanProveedor: ETIQUETA…LAMINA NO exige (regla de Racks)',
    faltanProveedor([{ ...base, descripcion: 'ETIQUETA LAMINA 500' }]).length === 0
  )

  // agruparGuias lleva la empresa de origen al encabezado de la guía.
  const gEmp = agruparGuias([f1, f2])
  check('agrupado: empresaOrigen del encabezado = AJEPER S.A.', gEmp[0].empresaOrigen === 'AJEPER S.A.')
}

// ─── [11] R3 (auditoría 2026-10-30): total "0" + UNA paleta con cantidad ───
console.log('\n[11] R3 — total "0" explícito + una paleta válida usa SU cantidad')
{
  // Antes: totalNum=0 no era NaN → la fila salía con cantidad 0 aunque la
  // única paleta con cantidad tuviera el valor real (aviso mentiroso).
  const conCero = expandirEnFilas([{ ...base, cantidad: '0', paletas: pal(['4000']) }])
  check('total "0" + paleta 4000 → fila con 4000 (no 0)', conCero.length === 1 && conCero[0].cantidadNum === 4000)
  const conCeroYVacias = expandirEnFilas([{ ...base, cantidad: '0', paletas: pal(['', '4000']) }])
  check('total "0" + 1 válida entre vacías → usa la válida', conCeroYVacias.length === 1 && conCeroYVacias[0].cantidadNum === 4000)
  // El total digitado > 0 sigue mandando (comportamiento fijado por tests).
  const conTotal = expandirEnFilas([{ ...base, cantidad: '9000', paletas: pal(['4000']) }])
  check('total 9000 + paleta 4000 → manda el total (9000)', conTotal.length === 1 && conTotal[0].cantidadNum === 9000)
}

// ─── [12] R5 (auditoría 2026-10-30): grupos de paletas NO contiguos ───
console.log('\n[12] R5 — filasAItems no fusiona dos grupos de paletas del mismo código')
{
  // Grupo 1: Paleta 1/2, 2/2 — Grupo 2 (otra carga del mismo código): Paleta 1/3.
  // Antes se fusionaban en UN item de 3 paletas y la renumeración impresa ya
  // no coincidía con la física.
  const filas = [
    filaBd({ codigo: '301', cantidad: 40, observaciones: 'Paleta 1/2' }),
    filaBd({ codigo: '301', cantidad: 60, observaciones: 'Paleta 2/2' }),
    filaBd({ codigo: '301', cantidad: 30, observaciones: 'Paleta 1/3' }),
  ]
  const items = filasAItems(filas)
  check('grupo 2/2 + grupo 1/3 del mismo código → items SEPARADOS', items.length === 2)
  check('grupo 1 conserva 2 paletas', items[0].paletas?.length === 2)
  check('grupo 2 nace como item de 1 paleta (fila marcada nueva)', items[1].paletas?.length === 1 && items[1].paletas[0].cantidad === '30')
  // La contigüidad correcta SIGUE uniendo: 1/3, 2/3, 3/3 consecutivos.
  const contiguo = filasAItems([
    filaBd({ codigo: '301', cantidad: 10, observaciones: 'Paleta 1/3' }),
    filaBd({ codigo: '301', cantidad: 20, observaciones: 'Paleta 2/3' }),
    filaBd({ codigo: '301', cantidad: 30, observaciones: 'Paleta 3/3' }),
  ])
  check('secuencia contigua 1/3→2/3→3/3 SÍ fusiona en 3 paletas', contiguo.length === 1 && contiguo[0].paletas?.length === 3)
  // Tolerancia legada intacta: grupo huérfano SIN la 1ª paleta sigue
  // re-ensamblándose (filas perdidas en BD; cubierto en [8] borde).
  const huerfano = filasAItems([
    filaBd({ codigo: '301', cantidad: 20, observaciones: 'Paleta 2/3' }),
    filaBd({ codigo: '301', cantidad: 30, observaciones: 'Paleta 3/3' }),
  ])
  check('huérfano 2/3→3/3 (sin la 1ª) sigue uniéndose (legado)', huerfano.length === 1 && huerfano[0].paletas?.length === 2)
  // Y DOS grupos completos consecutivos del mismo N se separan.
  const dosGrupos = filasAItems([
    filaBd({ codigo: '301', cantidad: 40, observaciones: 'Paleta 1/2' }),
    filaBd({ codigo: '301', cantidad: 60, observaciones: 'Paleta 2/2' }),
    filaBd({ codigo: '301', cantidad: 15, observaciones: 'Paleta 1/2' }),
    filaBd({ codigo: '301', cantidad: 25, observaciones: 'Paleta 2/2' }),
  ])
  check('dos grupos completos 1/2,2/2 + 1/2,2/2 → 2 items', dosGrupos.length === 2 && dosGrupos[1].paletas?.length === 2)
}

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
