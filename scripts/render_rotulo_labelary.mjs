/**
 * RACKLY — Genera el ZPL del rótulo de ejemplo (formato PERECIBLE) y lo
 * renderiza con Labelary (API pública de renderizado ZPL) para validar
 * visualmente la geometría contra la plantilla Excel.
 *
 *   npx esbuild scripts/render_rotulo_labelary.mjs --bundle --platform=node --outfile=/tmp/render.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/render.cjs
 */
const { construirZPLRotulo, construirZPLRotulos } = require('@/lib/rackly/zebra')
const fs = require('fs')

const ENC = { fecha: '2026-10-09', numeroDocumento: 'T173-00004090', proveedor: 'AJER S.A.', placa: 'C9G7B1' }

// Caso idéntico a la plantilla (código 56119) + caso largo (172,800 KG)
const rotulos = [
  {
    datos: {
      codigo: '56119',
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
    },
    copias: 1,
  },
]

const zpl = construirZPLRotulos(rotulos.map((r) => r.datos), rotulos.map((r) => r.copias), ENC)
fs.writeFileSync('/tmp/rotulos_preview.zpl', zpl)
console.log('ZPL escrito en /tmp/rotulos_preview.zpl')

async function render(zpl, out, dpmm = 8) {
  const res = await fetch(`http://api.labelary.com/v1/printers/${dpmm}/labels/10x15cm/0.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: zpl,
  })
  if (!res.ok) {
    console.error('Labelary HTTP', res.status, await res.text())
    return false
  }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  console.log('render →', out)
  return true
}

;(async () => {
  // 2 etiquetas separadas: Labelary renderiza 1 por request (usar index)
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://api.labelary.com/v1/printers/8dpmm/labels/10x15cm/${i}.png`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: zpl,
    })
    if (res.ok) {
      fs.writeFileSync(`/tmp/rotulo_render_${i}.png`, Buffer.from(await res.arrayBuffer()))
      console.log(`render etiqueta ${i} → /tmp/rotulo_render_${i}.png`)
    } else {
      console.error(`etiqueta ${i}: HTTP`, res.status, await res.text())
    }
  }
})()
