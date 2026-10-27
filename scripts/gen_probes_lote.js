/** Sondas ZPL para calibrar la separación de dígitos del lote.
 *  Genera 4 variantes y las manda a medir.
 */
const { construirZPLRotulo } = require('@/lib/rackly/zebra')

const ENC = { fecha: '2026-10-09', numeroDocumento: 'T173-00004090' }
const DATOS = {
  codigo: '56119',
  descripcion: 'ENVASE TETRA PACK',
  cantidad: '193320',
  unidad: 'UN',
  lote: '0869051017',
  fechaProduccion: '2026-07-23',
  fechaVencimiento: '2027-07-22',
}

// Variante A: lote con espacios entre dígitos (em 104, celda 0.55×em)
// Variante B: lote con espacios, proporcional (sin celda)
// Variante C: actual (sin espacios, celda 0.8) — referencia
const variantes = {
  A_espaciado_w57: '0 8 6 9 0 5 1 0 1 7',
  B_espaciado_prop: '0 8 6 9 0 5 1 0 1 7',
  C_actual_w83: '0869051017',
}

const fs = require('fs')
// Escribimos ZPL crudos manipulando la línea del lote generada
for (const [nombre, lote] of Object.entries(variantes)) {
  let z = construirZPLRotulo({ ...DATOS, lote: 'X' }, ENC, {}) // plantilla base con lote placeholder
  // localizamos la línea del lote (contiene FDX^FS tras la caja del valor)
  const lineas = z.split('\n')
  const i = lineas.findIndex((l) => l.includes('^FDX^FS'))
  let lineaLote = lineas[i]
  if (nombre === 'A_espaciado_w57') {
    lineaLote = lineaLote.replace(/^(\^FO\d+,\d+)\^A0R,(\d+),(\d+)/, (m, fo, em) => `${fo}^A0R,${em},57`)
    lineaLote = lineaLote.replace('^FDX^FS', '^FD0 8 6 9 0 5 1 0 1 7^FS')
  } else if (nombre === 'B_espaciado_prop') {
    lineaLote = lineaLote.replace(/\^A0R,(\d+),\d+/, '$1') // sin celda → proporcional
    lineaLote = lineaLote.replace('^FDX^FS', '^FD0 8 6 9 0 5 1 0 1 7^FS')
  } else {
    lineaLote = lineaLote.replace('^FDX^FS', '^FD0869051017^FS')
  }
  lineas[i] = lineaLote
  fs.writeFileSync(`/tmp/probe_${nombre}.zpl`, lineas.join('\n'))
  console.log(`${nombre}: ${lineaLote}`)
}
