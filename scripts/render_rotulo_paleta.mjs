/**
 * RACKLY — Render Labelary del rótulo CON PALETA (artículo dividido).
 * Verifica visualmente la nueva caja "Paleta i/N" en la banda LOTE.
 *
 *   npx esbuild scripts/render_rotulo_paleta.mjs --bundle --platform=node --outfile=node_modules/.cache/render_paleta.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node node_modules/.cache/render_paleta.cjs
 */
const { construirZPLRotulo } = require('@/lib/rackly/zebra')
const fs = require('fs')

const ENC = { fecha: '2026-10-12', numeroDocumento: 'T999-TESTDIV', proveedor: 'PRUEBA DIVIDIR E2E', placa: 'C75804' }

// Rótulo de UNA paleta (artículo 5653 dividido en 3) + control sin paleta
const casos = [
  {
    nombre: 'con-paleta',
    datos: {
      codigo: '5653',
      descripcion: 'PURE DE DURAZNO 30-32 ºBRIX',
      cantidad: '40',
      unidad: 'KG',
      lote: 'Y57822',
      fechaProduccion: '2026-09-30',
      fechaVencimiento: '2027-09-29',
      paleta: 'Paleta 1/3',
    },
  },
  {
    nombre: 'sin-paleta',
    datos: {
      codigo: '5653',
      descripcion: 'PURE DE DURAZNO 30-32 ºBRIX',
      cantidad: '100',
      unidad: 'KG',
      lote: 'Y57822',
      fechaProduccion: '2026-09-30',
      fechaVencimiento: '2027-09-29',
    },
  },
]

;(async () => {
  for (const c of casos) {
    const zpl = construirZPLRotulo(c.datos, ENC, { copias: 1 })
    fs.writeFileSync(`/home/z/my-project/download/rotulo_${c.nombre}.zpl`, zpl)
    // OJO: el API exige la barra final tras el índice (validado antes).
    const res = await fetch('https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: zpl,
    })
    if (!res.ok) {
      console.error(`${c.nombre}: Labelary HTTP`, res.status, (await res.text()).slice(0, 200))
      continue
    }
    fs.writeFileSync(`/home/z/my-project/download/rotulo_${c.nombre}.png`, Buffer.from(await res.arrayBuffer()))
    console.log(`render ${c.nombre} → /home/z/my-project/download/rotulo_${c.nombre}.png`)
  }
})()
