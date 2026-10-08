/**
 * E2E — Flujo nuevo completo sobre la guía real AJER S.A. (foto WhatsApp).
 * Simula lo que hará el navegador:
 *   1) OCR página completa a 2800px (ahora SÍ amplía fotos pequeñas) + blocks
 *   2) extraerAnclasTabla sobre las word-boxes
 *   3) recorte de la franja de tabla (coords → px originales) + escala ×3 + OCR
 *   4) extraerDatosGuiaDeTextos(texto1, textoTabla, catálogo real de la BD)
 *
 * Ejecutar: cd /home/z/my-project/rackly && node scripts/e2e_guia_real.mjs
 */
import sharp from 'sharp'
import { createWorker, PSM } from 'tesseract.js'
import { readFileSync } from 'node:fs'
import {
  extraerDatosGuiaDeTextos,
  extraerDatosGuia,
  extraerPalabras,
  extraerAnclasTabla,
  puntuarExtraccion,
} from '../src/lib/rackly/guia-ocr.ts'

const IMAGEN = '/home/z/my-project/scripts/guia_real.jpg'
const catalogo = JSON.parse(readFileSync('/home/z/my-project/scripts/catalogo.json', 'utf8'))

async function preparar(maxLado, contrast = 1.45) {
  const img = sharp(IMAGEN).rotate()
  const meta = await img.metadata()
  const escala = maxLado / Math.max(meta.width, meta.height)
  const w = Math.round(meta.width * escala)
  const h = Math.round(meta.height * escala)
  const buf = await img.resize(w, h).grayscale().linear(contrast, -(128 * contrast) + 128).png().toBuffer()
  return { buf, w, h, escala }
}

const worker = await createWorker('spa', 1)
async function ocr(psm, con, conBloques = false) {
  await worker.setParameters({ tessedit_pageseg_mode: psm })
  const { data } = await worker.recognize(con, {}, conBloques ? { blocks: true } : {})
  return data
}

// ── PASADA 1: página completa 2800px (con ampliación) + word-boxes ──
const p1 = await preparar(2800)
const d1 = await ocr(PSM.SINGLE_BLOCK, p1.buf, true)
const texto1 = d1.text ?? ''
const palabras = extraerPalabras(d1)
const anclas = extraerAnclasTabla(palabras)
console.log(`PASADA 1: ${p1.w}×${p1.h} · palabras=${palabras.length} · anclas=${JSON.stringify(anclas)}`)

// ── PASADA ZOOM: franja de tabla ×3 sobre la foto ORIGINAL ──
let textoTabla = null
if (anclas) {
  const k = p1.escala // OCR-space → px originales (misma escala que la pasada 1)
  const y0 = Math.max(0, Math.round(anclas.yTop / k))
  const y1 = Math.min(1280, Math.round(anclas.yBot / k))
  console.log(`FRANJA en original: y[${y0}..${y1}] (alto ${y1 - y0}px)`)
  const franja = await sharp(IMAGEN).rotate()
    .extract({ left: 0, top: y0, width: 960, height: y1 - y0 })
    .resize({ width: 960 * 3, kernel: 'lanczos3' })
    .grayscale().linear(1.5, -1.5 * 128 + 128).png().toBuffer()
  const dz = await ocr(PSM.SINGLE_BLOCK, franja)
  textoTabla = dz.text ?? ''
}

// ── PARSER NUEVO ──
const datos = extraerDatosGuiaDeTextos(texto1, textoTabla, catalogo)
console.log(`\n════ RESULTADO (puntaje ${puntuarExtraccion(datos)}) ════`)
console.log(`guía=${datos.numeroGuia} · placa=${datos.placa} · proveedor=${datos.proveedor}`)
const enCat = datos.items.filter((i) => i.enCatalogo).length
const porDesc = datos.items.filter((i) => i.matchPorDescripcion).length
const revision = datos.items.filter((i) => i.revision).length
console.log(`artículos=${datos.items.length} · enCatálogo=${enCat} · porDescripción=${porDesc} · revisión=${revision}`)
for (const it of datos.items) {
  const flags = [it.enCatalogo ? 'CAT' : 'NO', it.matchPorDescripcion ? 'desc' : '', it.revision ? 'REVISAR' : ''].filter(Boolean).join(',')
  console.log(`  · ${it.codigo.padEnd(8)} [${flags.padEnd(12)}] cant=${(it.cantidad || '-').padEnd(10)} un=${(it.unidad || '-').padEnd(4)} ${it.descripcion.slice(0, 48)}`)
}

await worker.terminate()
process.exit(0)
