/**
 * Reproduce el OCR del navegador sobre la guía sintética para diagnosticar
 * por qué el 3er artículo (7301) no fue detectado.
 * Ejecutar: cd /home/z/rackly && node --experimental-strip-types scripts/diag_ocr.mts
 *   (o vía esbuild si no hay strip-types)
 */
import { createWorker } from 'tesseract.js'

const worker = await createWorker('spa', 1)
const { data } = await worker.recognize('/home/z/my-project/download/guia_prueba_multi.png')
await worker.terminate()

console.log('===== TEXTO OCR =====')
console.log(data.text)
console.log('=====================')
// ¿Está "7301" en el texto?
const t = (data.text || '').toUpperCase()
for (const cod of ['5653', '118', '7301']) {
  const re = new RegExp('(^|[^0-9A-Z])(' + cod + ')($|[^0-9A-Z])')
  console.log(`código ${cod} con fronteras: ${re.test(t) ? 'SÍ' : 'NO'} | como subcadena: ${t.includes(cod) ? 'SÍ' : 'NO'}`)
}
process.exit(0)
