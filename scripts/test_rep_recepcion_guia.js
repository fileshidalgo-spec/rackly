/**
 * RACKLY · Tests REPUESTOS — Recepción con DOCUMENTO de guía (lógica pura).
 *
 * Cubre recepcion-guia.ts (validación de cabecera/líneas, proveedor efectivo,
 * parseo de cantidad, mapeo a rótulos) y el cambio ADITIVO de zebra.ts
 * (loteEtiqueta): Insumos sigue imprimiendo 'LOTE:' y Repuestos imprime
 * 'GUÍA:' con el número de documento.
 *
 * NO necesita stub de Supabase: todo es puro (zebra.ts no importa BD).
 */
const {
  validarRecepcionRep,
  proveedorDeLinea,
  parsearCantidadLinea,
  lineasARotulosRep,
  movimientosARotulosRep,
} = require('@/lib/rackly/rep/recepcion-guia')
const { construirZPLRotulo } = require('@/lib/rackly/zebra')

let ok = 0
function check(nombre, cond, detalle = '') {
  if (cond) {
    ok++
    console.log(`  ✓ ${nombre}`)
  } else {
    console.error(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
    process.exitCode = 1
  }
}

const CAB_OK = { guia: 'GR-12345', oc: 'OC-7788', dam: 'DAM-001', multiProveedor: false, proveedorGeneral: 'ACME S.A.' }
const LINEA_OK = {
  key: 'k1', articuloId: 'a1', codigo: 'BJ-109-003', descripcion: 'Filtro de aire',
  und: 'UND', cantidad: 4, proveedor: '',
}

async function main() {
  // ── [1] Validación: cabecera completa → sin errores ──
  console.log('\n[1] validarRecepcionRep — camino feliz')
  const e1 = validarRecepcionRep(CAB_OK, [LINEA_OK])
  check('sin errores de cabecera', e1.cabecera.length === 0, JSON.stringify(e1.cabecera))
  check('sin errores de líneas', e1.lineas.size === 0)

  // ── [2] Validación: faltan los 4 datos del documento ──
  console.log('\n[2] Cabecera incompleta → TODOS los errores de una vez')
  const e2 = validarRecepcionRep(
    { guia: '', oc: '', dam: '', multiProveedor: false, proveedorGeneral: '' },
    []
  )
  check('reporta guía faltante', e2.cabecera.some((m) => m.includes('Guía')))
  check('reporta OC faltante', e2.cabecera.some((m) => m.includes('OC')))
  check('reporta DAM faltante', e2.cabecera.some((m) => m.includes('DAM')))
  check('reporta proveedor faltante (modo único)', e2.cabecera.some((m) => m.includes('Proveedor')))
  check('reporta que no hay líneas', e2.cabecera.some((m) => m.includes('al menos un artículo')))
  check('son exactamente 5 errores', e2.cabecera.length === 5, JSON.stringify(e2.cabecera))

  // ── [3] Validación: modo multi proveedor exige proveedor POR LÍNEA ──
  console.log('\n[3] Modo multi-proveedor')
  const cabMulti = { ...CAB_OK, multiProveedor: true, proveedorGeneral: '' }
  const sinProv = { ...LINEA_OK, key: 'k2', proveedor: '' }
  const e3 = validarRecepcionRep(cabMulti, [sinProv])
  check('línea sin proveedor → error de LÍNEA (no de cabecera)', e3.lineas.size === 1 && e3.cabecera.length === 0)
  check('el error menciona el código', [...e3.lineas.values()][0].includes('BJ-109-003'))
  const conProv = { ...LINEA_OK, key: 'k3', proveedor: 'OTRO S.A.' }
  const e3b = validarRecepcionRep(cabMulti, [conProv])
  check('línea con proveedor propio → sin errores', e3b.cabecera.length === 0 && e3b.lineas.size === 0)
  // En modo multi el proveedor general NO se exige
  check('modo multi no exige proveedor general', validarRecepcionRep(cabMulti, [conProv]).cabecera.length === 0)

  // ── [4] Validación: cantidad por línea (SIN destino — eso lo resuelve Tránsito) ──
  console.log('\n[4] Cantidad inválida (sin destino: el modelo ya no lo pide)')
  const e4 = validarRecepcionRep(CAB_OK, [{ ...LINEA_OK, key: 'k4', cantidad: 0 }])
  check('cantidad 0 → error de línea k4', e4.lineas.get('k4')?.includes('Cantidad') === true)
  check('una línea válida sin loncheraId NO genera error (sin destino)',
    validarRecepcionRep(CAB_OK, [LINEA_OK]).lineas.size === 0)

  // ── [5] Proveedor efectivo de una línea ──
  console.log('\n[5] proveedorDeLinea')
  check('modo único → proveedor general', proveedorDeLinea(CAB_OK, { ...LINEA_OK, proveedor: 'ignorado' }) === 'ACME S.A.')
  check('modo multi → proveedor de la línea', proveedorDeLinea(cabMulti, { ...LINEA_OK, proveedor: ' OTRO S.A. ' }) === 'OTRO S.A.')

  // ── [6] Parseo de cantidad (aNumero: miles/decimales mixtos) ──
  console.log('\n[6] parsearCantidadLinea')
  check('"1,500" → 1500', parsearCantidadLinea('1,500') === 1500)
  check('"12,5" → 12.5', parsearCantidadLinea('12,5') === 12.5)
  check('"250.50" → 250.5', parsearCantidadLinea('250.50') === 250.5)
  check('"0" → null (no agrega la línea)', parsearCantidadLinea('0') === null)
  check('"abc" → null', parsearCantidadLinea('abc') === null)
  check('"-5" → null', parsearCantidadLinea('-5') === null)
  check('"" → null', parsearCantidadLinea('') === null)

  // ── [7] Rótulos desde líneas guardadas ──
  console.log('\n[7] lineasARotulosRep — 1 rótulo por línea, QR único por LÍNEA')
  const rot = lineasARotulosRep(
    [LINEA_OK, { ...LINEA_OK, key: 'k7', codigo: 'ZZ-001', und: 'GLN', cantidad: 2.5, descripcion: 'Aceite' }],
    ['lin-aaaa', 'lin-bbbb'],
    ' GR-12345 '
  )
  check('2 rótulos', rot.length === 2)
  check('rotulo[0]: código correcto', rot[0].codigo === 'BJ-109-003')
  check('rotulo[0]: lote = N° de guía (trim)', rot[0].lote === 'GR-12345')
  check('rotulo[0]: banda GUÍA:', rot[0].loteEtiqueta === 'GUÍA:')
  check('rotulo[0]: QR único = uuid de la LÍNEA de recepción', rot[0].recepcionId === 'lin-aaaa')
  check('rotulo[0]: cantidad como texto', rot[0].cantidad === '4')
  check('rotulo[0]: sin F.P/F.V (no aplican a repuestos)', rot[0].fechaProduccion === '' && rot[0].fechaVencimiento === '')
  check('rotulo[1]: decimal honesto', rot[1].cantidad === '2.5')
  check('rotulo[1]: SU uuid', rot[1].recepcionId === 'lin-bbbb')
  check('id vacío → sin QR de fila (degrada a guía, nunca sin identidad)',
    lineasARotulosRep([LINEA_OK], [''], 'GR-1')[0].recepcionId === undefined)

  // ── [8] Rótulos desde la BD (reimpresión) ──
  console.log('\n[8] movimientosARotulosRep — reimpresión por guía')
  const rot2 = movimientosARotulosRep([
    { id: 'm1', codigo: ' BJ-109-003 ', descripcion: ' Filtro ', und: ' UND ', cantidad: 4, guia: 'GR-1' },
    { id: 'm2', codigo: '', descripcion: 'sin código', und: '', cantidad: 1, guia: 'GR-1' },
  ])
  check('filtra filas sin código', rot2.length === 1)
  check('normaliza código/desc/unidad', rot2[0].codigo === 'BJ-109-003' && rot2[0].descripcion === 'Filtro' && rot2[0].unidad === 'UND')
  check('cantidad numérica → texto', rot2[0].cantidad === '4')
  check('QR de reimpresión = uuid de la fila', rot2[0].recepcionId === 'm1')

  // ── [9] ZPL aditivo: Insumos 'LOTE:' intacto · Repuestos 'GUÍA:' ──
  console.log('\n[9] construirZPLRotulo — loteEtiqueta aditiva')
  const base = {
    codigo: 'BJ-109-003', descripcion: 'Filtro de aire', cantidad: '4', unidad: 'UND',
    lote: '', fechaProduccion: '', fechaVencimiento: '',
  }
  const zplInsumos = construirZPLRotulo(base, { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '' })
  check('Insumos (sin loteEtiqueta) imprime LOTE:', zplInsumos.includes('LOTE:'))
  check('Insumos NO imprime GUÍA:', !zplInsumos.includes('GUÍA:'))
  const zplRep = construirZPLRotulo(
    { ...base, lote: 'GR-12345', loteEtiqueta: 'GUÍA:' },
    { fecha: '', numeroDocumento: 'GR-12345', empresaOrigen: 'ACME', placa: '' }
  )
  check('Repuestos imprime GUÍA:', zplRep.includes('GUÍA:'))
  check('Repuestos imprime el N° de guía en la banda', zplRep.includes('GR-12345'))
  check('el ZPL de repuestos sigue siendo una etiqueta válida (^XA…^XZ)', zplRep.startsWith('^XA') && zplRep.trimEnd().endsWith('^XZ'))

  // ── [10] FORMATO REP del rótulo (2026-11-11): solo código/desc/cant/UM + QR grande ──
  console.log('\n[10] construirZPLRotuloRep — formato simplificado Repuestos')
  const { construirZPLRotuloRep, construirZPLRotulos } = require('@/lib/rackly/zebra')
  const repDatos = {
    codigo: 'BJ-109-003', descripcion: 'LAMINA TERMOCONTRABLE 380 MM X 50 U', cantidad: '4', unidad: 'UND',
    lote: 'GR-12345', loteEtiqueta: 'GUÍA:', fechaProduccion: '', fechaVencimiento: '',
    recepcionId: '9f8c3e0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
  }
  const repEnc = { fecha: '', numeroDocumento: 'GR-12345', empresaOrigen: 'ACME', placa: '' }
  const zpl = construirZPLRotuloRep(repDatos, repEnc)
  check('etiqueta válida (^XA…^XZ)', zpl.startsWith('^XA') && zpl.trimEnd().endsWith('^XZ'))
  check('imprime el código', zpl.includes('BJ-109-003'))
  check('imprime la descripción (motor determinista: renglones balanceados)',
    /\^FDLAMINA\^FS/.test(zpl) && /\^FDTERMOCONTRABLE\^FS/.test(zpl) && /\^FD380 MM X 50 U\^FS/.test(zpl))
  check('imprime la cantidad', /\^FD4\^FS/.test(zpl))
  check('imprime la UM', /\^FDUND\^FS/.test(zpl))
  check('NO imprime banda GUÍA:', !zpl.includes('GUÍA:'))
  check('NO imprime el N° de guía como TEXTO (solo viaja dentro del QR)', !/\^FDGR-12345\^FS/.test(zpl))
  check('NO imprime F.P / F.V', !zpl.includes('F.P') && !zpl.includes('F.V'))
  check('NO imprime LOTE:', !zpl.includes('LOTE:'))
  check('imprime CANT:', zpl.includes('CANT:'))
  check('imprime el QR (^BQ)', zpl.includes('^BQN,2,'))
  const magQR = Number(zpl.match(/\^BQN,2,(\d+)/)?.[1])
  check('QR GRANDE: mag ≥ 10 (símbolo ≥ ~4.6 cm)', magQR >= 10, `mag=${magQR}`)
  check('QR con payload dominante v5 → mag 12 (~5.5 cm)', magQR === 12, `mag=${magQR}`)
  check('banda del código a ANCHO COMPLETO (^GB240,1200)', zpl.includes('^GB240,1200,3'))
  // Sin identidad → sin QR, pero el rótulo sigue estructurado (ancho completo)
  const zplSinQr = construirZPLRotuloRep(
    { ...repDatos, recepcionId: undefined },
    { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '' }
  )
  check('sin identidad → SIN QR (nunca un QR que no resuelve)', !zplSinQr.includes('^BQN'))
  check('sin QR → etiqueta igual válida', zplSinQr.startsWith('^XA') && zplSinQr.trimEnd().endsWith('^XZ'))
  check('sin QR → descripción a ancho completo (^GB320,1200)', zplSinQr.includes('^GB320,1200,3'))

  console.log('\n[11] construirZPLRotulos con formato "rep" — el modal elige el builder')
  const zplLote = construirZPLRotulos([repDatos], [2], repEnc, { guiaId: null, numeroDocumento: 'GR-12345' }, 'rep')
  check('formato rep: sin banda GUÍA:', !zplLote.includes('GUÍA:'))
  check('formato rep: 2 copias (^PQ2)', zplLote.includes('^PQ2,0,0,N'))
  const zplDefault = construirZPLRotulos([repDatos], [1], repEnc, { guiaId: null, numeroDocumento: 'GR-12345' })
  check('default (sin formato) sigue siendo Insumos (GUÍA: en banda)', zplDefault.includes('GUÍA:'))
  check('default: QR de Insumos con mag 9 (4 cm, sin cambio)', Number(zplDefault.match(/\^BQN,2,(\d+)/)?.[1]) === 9)

  // ── Resumen ──
  console.log(`\n════════ RESULTADO: ${ok} pasados ════════`)
  if (process.exitCode !== 1) console.log('OK test_rep_recepcion_guia')
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
