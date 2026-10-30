/**
 * REPRO T012-00000192 — guía real del usuario (32 filas: 27 paletas lote
 * 090926 + 5 paletas lote 030926 del MISMO artículo 30233).
 * Simula el orden de listarRecepcionesPorDocumento (created_at, codigo,
 * n_paleta nullsFirst, id) y ejecuta filasAItems + ordenarFilasGuia.
 * Uso: npx esbuild scripts/repro_t012.js --bundle --platform=node \
 *        --outfile=/tmp/repro_t012.cjs --alias:@=./src \
 *        --external:react --loader:.ts=ts --log-level=error && node /tmp/repro_t012.cjs
 */
const fs = require('fs')
const raw = fs.readFileSync('/tmp/t012_raw.txt', 'utf8')
const filasBd = JSON.parse(raw.slice(raw.indexOf('[')))

const aFilaRegistrada = (r) => ({
  id: r.id,
  createdAt: r.created_at,
  fecha: '2026-10-30',
  tipoDocumento: 'Guia',
  numeroDocumento: 'T012-00000192',
  empresaOrigen: 'AJEPER S.A.',
  proveedor: '',
  placa: '',
  fotoUrl: '',
  estado: 'Pendiente',
  usuarioId: 'u1',
  usuarioNombre: r.usuario_nombre,
  usuarioCorreo: '',
  guiaId: r.guia_id,
  codigo: r.codigo,
  descripcion: r.descripcion || 'PULPA DE DURAZNO HUAYCO ROJO 20°BRIX',
  cantidad: r.cantidad,
  unidadMedida: r.unidad_medida || 'KG',
  lote: r.lote || '',
  fechaProduccion: r.fecha_produccion || '',
  fechaVencimiento: r.fecha_vencimiento || '',
  observaciones: r.observaciones || '',
})

// Orden SQL simulado (lo que entrega la consulta hoy):
const ordenSql = [...filasBd].sort((a, b) => {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  if (a.codigo !== b.codigo) return a.codigo < b.codigo ? -1 : 1
  const na = a.n_paleta, nb = b.n_paleta
  if (na === null && nb !== null) return -1
  if (na !== null && nb === null) return 1
  if (na !== nb) return na - nb
  return a.id < b.id ? -1 : 1
})

const { filasAItems, ordenarFilasGuia, expandirEnFilas, planSyncEdicionPorId } = require('@/lib/rackly/recepcion-filas')

const filas = ordenSql.map(aFilaRegistrada)
console.log('== ORDEN SQL (primeras 12 marcas) ==')
console.log(filas.slice(0, 12).map((f) => (f.observaciones || '(sin marca)').replace('Paleta ', '')))

console.log('\n== ANTES del reorden (filasAItems sobre orden SQL puro) ==')
const itemsSinReorden = filasAItems(filas)
console.log(`items: ${itemsSinReorden.length}`)
itemsSinReorden.forEach((it, i) =>
  console.log(`  #${i + 1} cod=${it.codigo} cant=${it.cantidad} lote=${it.lote} paletas=${it.paletas?.length ?? 0}`)
)

console.log('\n== DESPUÉS (ordenarFilasGuia + filasAItems) ==')
const ordenadas = ordenarFilasGuia(filas)
console.log('marcas reordenadas:', ordenadas.map((f) => (f.observaciones || '(·)').replace('Paleta ', '')).join(', '))
const items = filasAItems(ordenadas)
console.log(`items: ${items.length}`)
items.forEach((it, i) =>
  console.log(`  #${i + 1} cod=${it.codigo} cant=${it.cantidad} lote=${it.lote} paletas=${it.paletas?.length ?? 0} lotePaletas=[${(it.paletas ?? []).map((p) => p.lote || '(hereda)').join(',')}]`)
)

// Round-trip de identidad: guardar de nuevo NO debe crear/borrar nada
const ids = items.flatMap((it) => [it.filaId, ...(it.paletas ?? []).map((p) => p.filaId)])
const plan = planSyncEdicionPorId(ids.filter(Boolean), expandirEnFilas(items))
console.log(`\nround-trip: actualizar=${plan.actualizar.length} insertar=${plan.insertar.length} eliminar=${plan.eliminar.length}`)

const ok =
  items.length === 2 &&
  items[0].paletas?.length === 27 &&
  items[1].paletas?.length === 5 &&
  items[0].lote === '090926' &&
  items[1].lote === '030926' &&
  plan.insertar.length === 0 &&
  plan.eliminar.length === 0 &&
  plan.actualizar.length === 32
console.log(`\nRESULTADO: ${ok ? 'OK ✓ (2 items: 27+5, identidades preservadas)' : 'FALLO ✗'}`)
process.exit(ok ? 0 : 1)
