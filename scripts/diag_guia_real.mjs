/**
 * DIAGNÓSTICO — Guía real AJER S.A. T173-00004090 (foto WhatsApp 960×1280).
 * Reproduce el pipeline actual (mejorarImagenOCR 2800px + PSM 6) y muestra
 * por qué "solo reconoce algunos datos". Además prueba las 3 mejoras:
 *   A) reconstrucción de tabla por columnas usando word-boxes
 *   B) matching por descripción contra el catálogo
 *   C) re-OCR con zoom de la celda de código (cuadro por cuadro)
 *
 * Ejecutar: cd /home/z/my-project/rackly && node ../scripts/diag_guia_real.mjs
 */
import sharp from 'sharp'
import { createWorker, PSM } from 'tesseract.js'
import { readFileSync } from 'node:fs'
import { extraerDatosGuia, puntuarExtraccion } from '../src/lib/rackly/guia-ocr.ts'

const IMAGEN = '/home/z/my-project/scripts/guia_real.jpg'
const catalogo = JSON.parse(readFileSync('/home/z/my-project/scripts/catalogo.json', 'utf8'))

// ── 1) Preprocesado igual al del navegador (gris + contraste, 2800px) ──
async function preparar(maxLado, contrast = 1.45) {
  const img = sharp(IMAGEN).rotate()
  const meta = await img.metadata()
  const escala = Math.min(1, maxLado / Math.max(meta.width, meta.height))
  const w = Math.round(meta.width * escala)
  const h = Math.round(meta.height * escala)
  const buf = await img
    .resize(w, h)
    .grayscale()
    .linear(contrast, -(128 * contrast) + 128)
    .png()
    .toBuffer()
  return { buf, w, h }
}

const { buf: img2800, w: W, h: H } = await preparar(2800)
await sharp(img2800).toFile('/home/z/my-project/scripts/guia_2800.png')

const worker = await createWorker('spa', 1)

async function ocr(psm, con, conBloques = false) {
  await worker.setParameters({ tessedit_pageseg_mode: psm })
  const { data } = await worker.recognize(con, {}, conBloques ? { blocks: true } : {})
  return data
}

// ── 2) PASADA ACTUAL (PSM 6 sobre 2800px) + parser actual ──
console.log('════ PASADA ACTUAL (PSM 6, 2800px) ════')
const d1 = await ocr(PSM.SINGLE_BLOCK, img2800, true)
const datos1 = extraerDatosGuia(d1.text ?? '', catalogo)
console.log(`puntaje=${puntuarExtraccion(datos1)} items=${datos1.items.length} guia=${datos1.numeroGuia} placa=${datos1.placa} prov=${datos1.proveedor}`)
for (const it of datos1.items) console.log(`  · ${it.codigo.padEnd(8)} ${it.enCatalogo ? 'CAT' : 'NO '} cant=${it.cantidad.padEnd(10)} un=${it.unidad.padEnd(4)} ${it.descripcion.slice(0, 45)}`)

console.log('\n════ TEXTO OCR (recortado) ════')
console.log((d1.text ?? '').split('\n').filter(Boolean).slice(0, 60).join('\n'))

// ── 3) WORD-BOXES: localizar cabecera de la tabla ──
const palabras = []
for (const b of d1.blocks ?? []) {
  for (const p of b.paragraphs ?? []) {
    for (const l of p.lines ?? []) {
      for (const w of l.words ?? []) {
        palabras.push({ t: (w.text ?? '').toUpperCase(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })
      }
    }
  }
}
console.log(`\npalabras totales: ${palabras.length}`)
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const cabDesc = palabras.find((p) => norm(p.t).startsWith('DESCRIP'))
const cabCant = palabras.find((p) => norm(p.t).startsWith('CANT'))
const cabUnid = palabras.find((p) => norm(p.t).startsWith('UNID'))
const cabCod = palabras.find((p) => norm(p.t).startsWith('COD'))
const notas = palabras.find((p) => norm(p.t).startsWith('NOTAS'))
console.log('anclas cabecera:', { cabCod: cabCod?.t, cabDesc: cabDesc?.t, cabCant: cabCant?.t, cabUnid: cabUnid?.t, notas: notas?.t })
if (cabDesc) console.log('bbox cabDesc:', cabDesc, 'cabCant:', cabCant, 'cabUnid:', cabUnid, 'notas y0:', notas?.y0)

// ── 4) RE-OCR CON ZOOM por celda de código (Leg C) ──
if (cabDesc && cabCod && notas) {
  const xCod0 = Math.max(0, cabCod.x0 - 40)
  const xCod1 = cabDesc.x0 - 10
  const yTop = cabDesc.y1 + 6
  const yBot = notas.y0 - 4
  console.log(`\n════ ZOOM COLUMNA CÓDIGO: x[${xCod0}..${xCod1}] y[${yTop}..${yBot}] (escala original = ${2800 / 1280}x) ════`)
  // Crop de la franja completa de la columna de código y upscale ×2.5 extra
  const franja = await sharp(IMAGEN).rotate()
    .extract({ left: Math.round(xCod0 / (W / 960)), top: Math.round(yTop / (H / 1280)), width: Math.round((xCod1 - xCod0) / (W / 960)), height: Math.round((yBot - yTop) / (H / 1280)) })
    .resize({ width: Math.round(((xCod1 - xCod0) / (W / 960)) * 2.5), kernel: 'lanczos3' })
    .grayscale().linear(1.6, -1.6 * 128 + 128).png().toBuffer()
  const dz = await ocr(PSM.SINGLE_BLOCK, franja)
  console.log('texto columna códigos (zoom 2.5x):')
  console.log(dz.text?.split('\n').filter((l) => l.trim()).join('\n'))
}
// ── 5) ZOOM DE FRANJA DE TABLA (recorte entre anclas + ×3) ──
console.log('\n════ ZOOM FRANJA TABLA ×3 ════')
{
  const anclaTop = palabras.find((p) => p.t.includes('TRANSPORTADOS'))
  const anclaBot = palabras.find((p) => norm(p.t).startsWith('NOTAS'))
  if (anclaTop && anclaBot) {
    const k = 960 / W // 2800→960
    const top = Math.max(0, Math.round(anclaTop.y1 * k) - 4)
    const bot = Math.min(1280, Math.round(anclaBot.y0 * k) - 2)
    const franja = await sharp(IMAGEN).rotate()
      .extract({ left: 0, top, width: 960, height: bot - top })
      .resize({ width: 960 * 3, kernel: 'lanczos3' })
      .grayscale().linear(1.5, -1.5 * 128 + 128).png().toBuffer()
    await sharp(franja).toFile('/home/z/my-project/scripts/guia_tabla_x3.png')
    const dt = await ocr(PSM.SINGLE_BLOCK, franja)
    console.log(dt.text)
    const datos = extraerDatosGuia(dt.text ?? '', catalogo)
    console.log(`→ parser: items=${datos.items.length}`)
    for (const it of datos.items) console.log(`  · ${it.codigo.padEnd(8)} ${it.enCatalogo ? 'CAT' : 'NO '} cant=${it.cantidad.padEnd(10)} un=${it.unidad.padEnd(4)} ${it.descripcion.slice(0, 45)}`)
  }
}

// ── 6) ZOOM COLUMNA CÓDIGOS ×4 + PSM SINGLE_LINE + whitelist ──
console.log('\n════ ZOOM COLUMNA CÓDIGOS ×4 ════')
{
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789' })
  const anclaTop = palabras.find((p) => p.t.includes('TRANSPORTADOS'))
  const anclaBot = palabras.find((p) => norm(p.t).startsWith('NOTAS'))
  const k = 960 / W
  const top = Math.round(anclaTop.y1 * k) - 2
  const bot = Math.round(anclaBot.y0 * k) - 4
  const col = await sharp(IMAGEN).rotate()
    .extract({ left: 75, top, width: 105, height: bot - top })
    .resize({ width: 105 * 4, kernel: 'lanczos3' })
    .grayscale().linear(1.5, -1.5 * 128 + 128).png().toBuffer()
  await sharp(col).toFile('/home/z/my-project/scripts/guia_codigos_x4.png')
  const dc = await ocr(PSM.SINGLE_LINE, col)
  console.log(dc.text)
  await worker.setParameters({ tessedit_char_whitelist: '' })
}
await worker.terminate()
process.exit(0)
