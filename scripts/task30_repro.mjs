/**
 * Task 30 — REPRODUCCIÓN del rótulo de la foto del usuario:
 * código 55492 · "BASE PARA BEBIDA JARABEADA CARBONATADA FRESA 50496" ·
 * lote 2288609080291 · 40 UN · F.P 08/09/2026 · F.V 08/09/2027 · QR de guía.
 *
 * npx esbuild scripts/task30_repro.mjs --bundle --platform=node --outfile=/tmp/t30.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node /tmp/t30.cjs
 */
const { construirZPLRotulo } = require('@/lib/rackly/zebra')
const fs = require('fs')

const ENC = {
  fecha: '2026-10-26',
  numeroDocumento: 'T173-00004090',
  proveedor: 'AJER S.A.',
  placa: 'C9G7B1',
  guiaId: '1cf54664-45e2-469f-95fd-9152efe8b107',
}

const datos = {
  codigo: '55492',
  descripcion: 'BASE PARA BEBIDA JARABEADA CARBONATADA FRESA 50496',
  cantidad: '40',
  unidad: 'UN',
  lote: '2288609080291',
  fechaProduccion: '2026-09-08',
  fechaVencimiento: '2027-09-08',
}

const zpl = construirZPLRotulo(datos, ENC, { copias: 1, qr: { guiaId: ENC.guiaId, numeroDocumento: ENC.numeroDocumento } })
fs.writeFileSync('/tmp/t30_rotulo.zpl', zpl)
// Solo el campo de descripción para inspección
console.log(zpl.split('\n').filter((l) => l.includes('BASE PARA') || l.includes('^FB')).join('\n'))

async function render(zpl, out, ancho = '4.1') {
  const res = await fetch(`https://api.labelary.com/v1/printers/8dpmm/labels/${ancho}x6/0/`, {
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
  await render(zpl, '/tmp/t30_repro.png')
})()
