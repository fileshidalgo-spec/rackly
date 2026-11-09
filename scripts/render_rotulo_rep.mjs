/**
 * RACKLY — Render Labelary del rótulo de REPUESTOS (banda GUÍA: + QR único).
 *
 * Construye el ZPL EXACTO que imprimirá Recepción de Repuestos (mismo
 * construirZPLRotulo que Insumos, con loteEtiqueta='GUÍA:' y lote=N° de
 * guía) y lo renderiza en Labelary (mismo motor que el firmware ZT411).
 * El PNG queda en download/ para revisión visual.
 */
const { construirZPLRotulo } = require('@/lib/rackly/zebra')
const fs = require('fs')

const rotulo = {
  codigo: 'E2E-FILTRO-001',
  descripcion: 'Filtro de aire motor E2E',
  cantidad: '2',
  unidad: 'UND',
  lote: 'E2E-GUIA-001',
  loteEtiqueta: 'GUÍA:',
  fechaProduccion: '',
  fechaVencimiento: '',
  recepcionId: 'e93c02ab-4193-4c88-9dad-7ea04b2edc72',
}

const encabezado = {
  fecha: '2026-11-09',
  numeroDocumento: 'E2E-GUIA-001',
  empresaOrigen: 'PROVEEDOR E2E SAC',
  placa: '',
  tipoDocumento: 'Guía',
}

const zpl = construirZPLRotulo(rotulo, encabezado, {
  copias: 1,
  qr: { guiaId: null, numeroDocumento: 'E2E-GUIA-001' },
})

async function main() {
  const res = await fetch('https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'image/png' },
    body: zpl,
  })
  if (!res.ok) {
    console.error('Labelary HTTP', res.status, await res.text())
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const out = '/home/z/my-project/download/rotulo_repuestos_guia.png'
  fs.mkdirSync('/home/z/my-project/download', { recursive: true })
  fs.writeFileSync(out, buf)
  console.log(`render rótulo REPUESTOS → ${out} (${buf.length} bytes)`)
  console.log(`ZPL: ${zpl.split('\n').length} líneas · banda GUÍA: ${zpl.includes('GUÍA:')} · QR: ${zpl.includes('^BQN')}`)
  if (!zpl.includes('GUÍA:') || !zpl.includes('^BQN') || buf.length < 2000) process.exit(1)
}

main()
