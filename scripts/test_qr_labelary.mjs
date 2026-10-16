/**
 * RACKLY — E2E del QR del rótulo: ZPL → Labelary (render 203dpi) → decode QR.
 *
 * Valida que el QR que saldrá de la ZT411 (mismo ZPL, render idéntico al
 * firmware) decodifica EXACTAMENTE el payload esperado con EC 'Q' y la
 * magnificación elegida. El PNG queda en download/ para revisión visual.
 *
 *   npx esbuild scripts/test_qr_labelary.mjs --bundle --platform=node \
 *     --outfile=scripts/.testbuild/test_qr_labelary.cjs --alias:@=./src --loader:.ts=ts \
 *   && node scripts/.testbuild/test_qr_labelary.cjs
 *   python3 scripts/decode_qr_labelary.py
 */
const { construirZPLRotulos } = require('@/lib/rackly/zebra')
const fs = require('fs')

const GUIA = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const ENC = {
  fecha: '2026-10-17',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJER S.A.',
  placa: 'C9G7B1',
}

const rotulos = [
  {
    datos: {
      codigo: '49310',
      descripcion: 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 202',
      cantidad: '193320',
      unidad: 'UN',
      lote: '0869051017',
      fechaProduccion: '2026-07-23',
      fechaVencimiento: '2027-07-22',
    },
    copias: 1,
  },
  {
    datos: {
      codigo: '126',
      descripcion: 'SAL INDUSTRIAL',
      cantidad: '172800',
      unidad: 'KG',
      lote: '',
      fechaProduccion: '',
      fechaVencimiento: '',
      paleta: 'Paleta 2/4',
    },
    copias: 1,
  },
]

const zpl = construirZPLRotulos(
  rotulos.map((r) => r.datos),
  rotulos.map((r) => r.copias),
  ENC,
  { guiaId: GUIA, numeroDocumento: ENC.numeroDocumento }
)
fs.writeFileSync('/tmp/rotulos_qr.zpl', zpl)
console.log('ZPL con QR escrito en /tmp/rotulos_qr.zpl')

;(async () => {
  for (let i = 0; i < rotulos.length; i++) {
    const res = await fetch(`https://api.labelary.com/v1/printers/8dpmm/labels/4x6/${i}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'image/png' },
      body: zpl,
    })
    if (!res.ok) {
      console.error(`etiqueta ${i}: HTTP`, res.status, await res.text())
      process.exitCode = 1
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(`/tmp/rotulo_qr_${i}.png`, buf)
    console.log(`render etiqueta ${i} → /tmp/rotulo_qr_${i}.png (${buf.length} bytes)`)
  }
})()
