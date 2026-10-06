/**
 * Diagnóstico final: texto OCR (2800px) + catálogo REAL → extraerDatosGuia.
 * npx esbuild scripts/diag_parser.mjs --bundle --platform=node --outfile=/tmp/diag.cjs --alias:@=/home/z/rackly/src && node /tmp/diag.cjs
 */
import { readFileSync } from 'fs'
import { extraerDatosGuia } from '@/lib/rackly/guia-ocr'

const texto = readFileSync('/tmp/ocr_text.txt', 'utf8')
const catalogo = JSON.parse(readFileSync('/tmp/catalogo_real.json', 'utf8')).map((r) => ({
  codigo: String(r.codigo ?? ''),
  un: String(r.un ?? ''),
  descripcion: String(r.descripcion ?? ''),
  stock_big_magic: 0,
}))

const datos = extraerDatosGuia(texto, catalogo)
console.log('guia:', datos.numeroGuia)
console.log('placa:', datos.placa)
console.log('proveedor:', datos.proveedor)
console.log('items detectados:', datos.items.length)
for (const it of datos.items) {
  console.log(`  ${it.codigo} | ${it.descripcion.slice(0, 40)} | cant=${it.cantidad} | un=${it.unidad} | cat=${it.enCatalogo}`)
}
