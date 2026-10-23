#!/usr/bin/env node
/**
 * RACKLY — Task 22 · REPRODUCCIÓN del error "no jala items en Atención".
 * OCR real (tesseract.js spa) de la RQ AJEPER 0000191740 (WhatsApp) →
 * parser extraerDatosRqDeTexto (rq-ocr.ts) con catálogo real de la BD.
 * Uso: node scripts/repro_task22_ocr.js [ruta_imagen] [--salida ruta.json]
 */
const fs = require('fs')
const path = require('path')

const argImg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
const IMG = argImg || '/home/z/my-project/upload/WhatsApp Image 2026-10-23 at 5.41.44 AM.jpeg'
const SALIDA = process.argv.includes('--salida')
  ? process.argv[process.argv.indexOf('--salida') + 1]
  : null

// Catálogo mínimo con los códigos REALES de la BD (verificados por SQL) + 2 distractores
const CATALOGO = [
  { codigo: '57268', descripcion: 'ETIQUETA DILYTE APPLE ICE 650 ML - DIS.25', un: 'UN' },
  { codigo: '50111', descripcion: 'PREFORMA PET 38.1 GRS CRISTAL HF (SAN MIGUEL)', un: 'UN' },
  { codigo: '56227', descripcion: 'TAPA PLANA 33 MM TRASLUCIDA HF', un: 'UN' },
  { codigo: '424198', descripcion: 'DILYTE APPLE ICE SIN AZUCAR PET NO RETORNABLE 650 ML 6 MA', un: 'PQT' },
  { codigo: '51554', descripcion: 'EMULSION PIVA 26549', un: 'KG' },
  { codigo: '118', descripcion: 'ACIDO CITRICO', un: 'KGM' },
]

async function main() {
  const { createWorker, PSM } = require('tesseract.js')
  // BUNDLE=rq_ocr_antes (código desplegado) | rq_ocr_despues (fix ancla doble)
  const bundle = process.env.BUNDLE || 'rq_ocr_despues'
  const { extraerDatosRqDeTexto, puntuarExtraccionRq } = require(`./.testbuild/${bundle}.cjs`)
  console.log(`Parser: ${bundle}`)

  console.log(`Imagen: ${IMG} (${(fs.statSync(IMG).size / 1024).toFixed(0)} KB)`)
  const worker = await createWorker('spa', 1)
  await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })

  // PASO 1 — PSM 6 (igual que el componente: SINGLE_BLOCK sobre la página)
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
  const { data: d6 } = await worker.recognize(IMG, {}, { blocks: true })
  const texto6 = d6.text ?? ''

  // PASO 2 — PSM 3 (AUTO, segundo pase del componente)
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
  const { data: d3 } = await worker.recognize(IMG)
  const texto3 = d3.text ?? ''
  await worker.terminate()

  console.log('\n════ OCR PSM 6 (primeras 40 líneas) ════')
  console.log(texto6.split('\n').slice(0, 40).join('\n'))

  const parser = { nombre: `rq-ocr (${bundle})`, fn: extraerDatosRqDeTexto }
  for (const [tag, txt] of [['PSM6', texto6], ['PSM3', texto3]]) {
    const d = parser.fn(txt, CATALOGO)
    console.log(`\n════ ${parser.nombre} · ${tag} ════`)
    console.log(`  numeroRq=${d.numeroRq}  OP=${d.ordenProduccion}  fecha=${d.fecha}  linea="${d.linea}"`)
    console.log(`  producto=${d.productoCodigo} "${d.productoDescripcion}"`)
    console.log(`  ITEMS detectados: ${d.items.length}  (puntaje ${puntuarExtraccionRq(d)})`)
    for (const it of d.items) {
      console.log(`   · ${it.codigo} | ${it.descripcion} | ${it.cantidad} ${it.unidad} | cat=${it.enCatalogo} rev=${it.revision}`)
    }
  }

  if (SALIDA) {
    fs.writeFileSync(SALIDA, JSON.stringify({ texto6, texto3 }, null, 2))
    console.log(`\nTextos OCR guardados en ${path.resolve(SALIDA)}`)
  }
}

main().catch((e) => {
  console.error('FALLO:', e)
  process.exit(1)
})
