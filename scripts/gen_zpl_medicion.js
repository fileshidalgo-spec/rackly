/** Genera el ZPL del rótulo (caso del test) para medición con Labelary.
 *  Uso: npx esbuild scripts/gen_zpl_medicion.js --bundle --platform=node --outfile=/tmp/gen_zpl.cjs --alias:@=./src --loader:.ts=ts --log-level=error && node /tmp/gen_zpl.cjs > /tmp/rotulo.zpl
 */
const { construirZPLRotulo } = require('@/lib/rackly/zebra')

const ENCABEZADO = {
  fecha: '2026-10-09',
  numeroDocumento: 'T173-00004090',
}
const DATOS = {
  codigo: '56119',
  descripcion: 'ENVASE TETRA PACK PULP DURAZNO FORTI HIERRO 145 ML - DISEÑO 202',
  cantidad: '193320',
  unidad: 'UN',
  lote: '0869051017',
  fechaProduccion: '2026-07-23',
  fechaVencimiento: '2027-07-22',
}
// Con QR (payload dominante v5) como en producción
process.stdout.write(
  construirZPLRotulo(DATOS, ENCABEZADO, {
    qr: { guiaId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', numeroDocumento: 'T173-00004090' },
  })
)
