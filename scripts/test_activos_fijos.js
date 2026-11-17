/**
 * RACKLY — Tests: Recepción de ACTIVOS FIJOS (Repuestos, 2026-11-17).
 * Cubre el autocompletado de la serie 12 (22 → 12000022), validaciones
 * (normal vs EXCEPCIÓN de serie), el registro idempotente con uuid_sync
 * (payload real capturado por el stub), los rótulos (banda META ACT/OC en
 * el ZPL REP, QR = id de SU fila), la EDICIÓN del documento guardado
 * (updates por fila con verificación honesta) y el BORRADO por activo y
 * por documento. Stub de Supabase — sin red.
 */
const {
  autocompletarArticuloAF,
  esArticuloAFValido,
  esArticuloExcepcionValido,
  motivoInvalidoActivo,
  registrarActivosFijos,
  listarActivosFijos,
  rotulosDesdeActivos,
  agruparPorDocumentoAF,
  actualizarActivoFijo,
  guardarEdicionAF,
  borrarActivoAF,
  borrarDocumentoAF,
  SERIE_AF,
  LARGO_ARTICULO_AF,
} = require('@/lib/rackly/rep/activos-fijos')
const { construirZPLRotuloRep } = require('@/lib/rackly/zebra')
const {
  __setTable,
  __setInsertResult,
  __setUpdateData,
  __setDeleteResult,
  __insertCalls,
  __updateCalls,
  __eqCalls,
} = require('@/lib/supabase/client')

let PASADOS = 0
let FALLIDOS = 0
function check(nombre, cond, detalle) {
  if (cond) {
    PASADOS++
  } else {
    FALLIDOS++
    console.error(`✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
  }
}

console.log('── AUTOCOMPLETADO de la serie 12 (pedido: 22 → 12000022) ──')
const a22 = autocompletarArticuloAF('22')
check('«22» → 12000022 (el sufijo conserva LO DIGITADO para no pelear con el cursor)', a22.completo === '12000022' && a22.sufijo === '22', JSON.stringify(a22))
check('«0» → 12000000', autocompletarArticuloAF('0').completo === '12000000')
check('vacío → vacío (nada que completar)', autocompletarArticuloAF('').completo === '' && autocompletarArticuloAF('').sufijo === '')
check('basura no numérica → vacío', autocompletarArticuloAF('abc').completo === '')
check('«123456» es el sufijo completo → 12123456 (modelo: lo digitado ES el número final)', autocompletarArticuloAF('123456').completo === '12123456', JSON.stringify(autocompletarArticuloAF('123456')))
check('pegar 7 dígitos «1200002» → se conserva tal cual (inválido, el usuario lo completa al seguir digitando)', autocompletarArticuloAF('1200002').completo === '1200002')
check('pegar código completo «12000022» → idempotente (sufijo 000022)', autocompletarArticuloAF('12000022').completo === '12000022')
check('pegar con ruido «12000022-A» → mismo código', autocompletarArticuloAF('12000022-A').completo === '12000022')
check('pegar 9 dígitos → corta a 8 (12000022)', autocompletarArticuloAF('120000229').completo === '12000022')
check('sufijo se acota a 6 dígitos', autocompletarArticuloAF('9999999').completo.length === 8)
check('constantes: serie 12 y largo 8', SERIE_AF === '12' && LARGO_ARTICULO_AF === 8)

console.log('── VALIDACIONES (normal vs excepción) ──')
check('12000022 es válido (normal)', esArticuloAFValido('12000022'))
check('1200002 NO es válido (7 dígitos)', !esArticuloAFValido('1200002'))
check('12a00022 NO es válido', !esArticuloAFValido('12a00022'))
check('excepción: AF-2024-001 es válida', esArticuloExcepcionValido('AF-2024-001'))
check('excepción: serie 13+ dígitos «13000045» es válida', esArticuloExcepcionValido('13000045'))
check('excepción: «AB» (2) NO es válida', !esArticuloExcepcionValido('AB'))
check('excepción: con símbolo prohibido «AF;01» NO es válida', !esArticuloExcepcionValido('AF;01'))

const activoOK = { articulo: '12000022', descripcion: 'TORNO 3 EJES', activacion: 'SN-88213', conExcepcion: false }
check('motivoInvalidoActivo: activo correcto → null', motivoInvalidoActivo(activoOK) === null)
check('motivoInvalidoActivo: artículo inválido → motivo', motivoInvalidoActivo({ ...activoOK, articulo: '12X' }) !== null)
check('motivoInvalidoActivo: activación inválida → motivo', motivoInvalidoActivo({ ...activoOK, activacion: 'A' }) !== null)
check('motivoInvalidoActivo: sin activación (null) → OK', motivoInvalidoActivo({ ...activoOK, activacion: null }) === null)
check('motivoInvalidoActivo: excepción con código válido → null', motivoInvalidoActivo({ ...activoOK, articulo: 'AF-2024-001', conExcepcion: true }) === null)

console.log('── REGISTRO idempotente (payload real vía stub) ──')
async function pruebasRegistro() {
  __setInsertResult({ data: [{ id: 'af-1' }, { id: 'af-2' }], error: null })
  const res = await registrarActivosFijos(
    [
      { articulo: '12000022', descripcion: 'TORNO 3 EJES', activacion: 'sn-88213', conExcepcion: false },
      { articulo: 'AF-2024-001', descripcion: 'COMPRESOR', activacion: null, conExcepcion: true },
    ],
    { fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-777' },
    { id: 'u-1', nombre: 'Operador', correo: 'op@rackly.pe' }
  )
  check('registrar devuelve 2 ids', res.ids.length === 2 && res.ids[0] === 'af-1' && res.ids[1] === 'af-2', JSON.stringify(res))
  const calls = __insertCalls().filter((c) => c.table === 'rep_activos_fijos')
  check('1 insert a rep_activos_fijos (lote único)', calls.length === 1, JSON.stringify(calls.length))
  const filas = calls[0]?.payload ?? []
  check('2 filas en el lote', Array.isArray(filas) && filas.length === 2)
  const f1 = filas[0] ?? {}
  check('fila lleva documento (guía, OC, fecha)', f1.guia === 'T001-12345' && f1.oc === 'OC-777' && f1.fecha === '2026-11-17')
  check('activación se NORMALIZA a mayúsculas (SN-88213)', f1.activacion === 'SN-88213')
  check('sin activación → null (opción «aún no tiene»)', filas[1]?.activacion === null)
  check('excepción persiste con_excepcion=true', filas[1]?.con_excepcion === true)
  check('uuid_sync presente por fila (idempotencia M-1)', typeof f1.uuid_sync === 'string' && f1.uuid_sync.length > 10 && typeof filas[1]?.uuid_sync === 'string')
  check('usuario adjunto (id, nombre, correo)', f1.usuario_id === 'u-1' && f1.usuario_nombre === 'Operador' && f1.usuario_correo === 'op@rackly.pe')
  check('artículo normalizado a mayúsculas', f1.articulo === '12000022' && filas[1]?.articulo === 'AF-2024-001')

  console.log('── LISTADO + AGRUPACIÓN por documento ──')
  __setTable('rep_activos_fijos', [
    { id: 'af-1', created_at: '2026-11-17T10:00:00Z', fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-777', articulo: '12000022', descripcion: 'TORNO', activacion: 'SN-88213', con_excepcion: false, usuario_nombre: 'Op', usuario_correo: 'op@rackly.pe' },
    { id: 'af-2', created_at: '2026-11-17T10:01:00Z', fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-777', articulo: '12000023', descripcion: 'FRESADORA', activacion: null, con_excepcion: false, usuario_nombre: 'Op', usuario_correo: 'op@rackly.pe' },
    { id: 'af-3', created_at: '2026-11-16T09:00:00Z', fecha: '2026-11-16', guia: 'T001-99999', oc: '', articulo: '13000045', descripcion: '', activacion: null, con_excepcion: true, usuario_nombre: 'Op2', usuario_correo: 'op2@rackly.pe' },
  ])
  const lista = await listarActivosFijos()
  check('listar devuelve las filas enlatadas', lista.length === 3)
  const grupos = agruparPorDocumentoAF(lista)
  check('agrupa por guía+OC+fecha: 2 documentos', grupos.length === 2, JSON.stringify(grupos.map((g) => g.clave)))
  const g1 = grupos.find((g) => g.guia === 'T001-12345')
  check('el documento T001-12345 tiene 2 activos', g1?.activos.length === 2)
  check('el documento sin OC agrupa igual (oc vacío)', grupos.some((g) => g.guia === 'T001-99999' && g.oc === ''))

  console.log('── RÓTULOS (código grande + banda META ACT/OC + QR por fila) ──')
  const rotulos = rotulosDesdeActivos(lista.slice(0, 2), 'OC-777')
  check('1 rótulo por activo', rotulos.length === 2)
  check('código = N° de artículo', rotulos[0].codigo === '12000022')
  check('descripción LIMPIA (la activación ya no se pega al texto)', rotulos[0].descripcion === 'TORNO', rotulos[0].descripcion)
  check('activación como CAMPO propio del rótulo', rotulos[0].activacion === 'SN-88213')
  check('sin activación → campo undefined', rotulos[1].activacion === undefined)
  check('OC del documento en el rótulo (pedido: la OC en la etiqueta)', rotulos[0].oc === 'OC-777' && rotulos[1].oc === 'OC-777')
  check('CANT 1 ACT (unidad física única)', rotulos[0].cantidad === '1' && rotulos[0].unidad === 'ACT')
  check('QR único: recepcionId = id de SU fila', rotulos[0].recepcionId === 'af-1' && rotulos[1].recepcionId === 'af-2')
  check('1 copia por rótulo (configurable en el modal)', rotulos.every((r) => r.copias === 1))
  const sinDesc = rotulosDesdeActivos([lista[2]])
  check('descripción vacía cae al código (rótulo legible)', sinDesc[0].descripcion === '13000045', sinDesc[0].descripcion)

  console.log('── BANDA META del ZPL REP (ACT + OC, pedido 2026-11-17) ──')
  const enc = { fecha: '2026-11-17', numeroDocumento: 'T001-12345', empresaOrigen: '', placa: '' }
  const zplFull = construirZPLRotuloRep(
    { codigo: '12000022', descripcion: 'TORNO 3 EJES', cantidad: '1', unidad: 'ACT', lote: '', fechaProduccion: '', fechaVencimiento: '', activacion: 'SN-88213', oc: 'OC-999' },
    enc
  )
  check('ZPL imprime «ACT: SN-88213»', zplFull.includes('ACT: SN-88213'))
  check('ZPL imprime «OC: OC-999»', zplFull.includes('OC: OC-999'))
  // La banda META vive en Y 500..556 (visual): xFis = 800 − (y0+em) = 800 − 545 = 255.
  check('banda META en su franja (Y 500..556 → ^FO255)', zplFull.includes('^FO255'), zplFull.split('\n').filter((l) => l.includes('ACT:')).join(' | '))
  const zplOcSolo = construirZPLRotuloRep(
    { codigo: '12000022', descripcion: 'TORNO', cantidad: '1', unidad: 'ACT', lote: '', fechaProduccion: '', fechaVencimiento: '', oc: 'OC-999' },
    enc
  )
  check('con solo OC: imprime OC y NO «ACT:»', zplOcSolo.includes('OC: OC-999') && !zplOcSolo.includes('ACT:'))
  const zplMercaderia = construirZPLRotuloRep(
    { codigo: '15240', descripcion: 'ROTOR INDUSTRIAL', cantidad: '2', unidad: 'UN', lote: 'T001-777', fechaProduccion: '', fechaVencimiento: '' },
    enc
  )
  check('mercadería SIN meta: ZPL sin «ACT:» ni «OC:» (compatible hacia atrás)', !zplMercaderia.includes('ACT: ') && !zplMercaderia.includes('OC: '))

  console.log('── EDICIÓN del documento (guardarEdicionAF) ──')
  const docOriginal = { fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-777' }
  // Escenario 1: OC cambia + fila A intacta + fila B editada + C eliminada + 1 nueva.
  __setUpdateData({ data: [{ id: 'af-1' }], error: null })
  __setUpdateData({ data: [{ id: 'af-2' }], error: null })
  __setDeleteResult({ data: [{ id: 'af-3' }], error: null })
  __setInsertResult({ data: [{ id: 'af-nuevo' }], error: null })
  const res1 = await guardarEdicionAF({
    docOriginal,
    docNuevo: { fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-999' },
    conservadas: [
      { id: 'af-1', articulo: '12000022', descripcion: 'TORNO', activacion: 'SN-88213', conExcepcion: false, contenidoCambio: false },
      { id: 'af-2', articulo: '12000023', descripcion: 'FRESADORA CNC', activacion: null, conExcepcion: false, contenidoCambio: true },
    ],
    idsEliminados: ['af-3'],
    nuevas: [{ articulo: '12000077', descripcion: 'SOLDADORA', activacion: null, conExcepcion: false }],
    usuario: { id: 'u-1', nombre: 'Op', correo: 'op@rackly.pe' },
  })
  check('resultado: 2 actualizadas (doc cambió → todas)', res1.actualizadas === 2 && res1.docCambio === true, JSON.stringify(res1))
  check('resultado: 1 eliminada + 1 nueva', res1.eliminadas === 1 && res1.nuevasIds.length === 1 && res1.nuevasIds[0] === 'af-nuevo')
  const upd1 = __updateCalls().filter((c) => c.table === 'rep_activos_fijos')
  check('2 updates a rep_activos_fijos', upd1.length === 2, String(upd1.length))
  check('update lleva el documento NUEVO (OC-999) denormalizado por fila', upd1[0]?.payload?.oc === 'OC-999' && upd1[0]?.payload?.guia === 'T001-12345')
  check('update fila B: contenido editado + activación null', upd1[1]?.payload?.descripcion === 'FRESADORA CNC' && upd1[1]?.payload?.activacion === null)
  const eqU = __eqCalls().filter((c) => c.table === 'rep_activos_fijos' && c.col === 'id')
  check('updates por ID exacto (nunca por documento)', eqU.some((c) => c.val === 'af-1') && eqU.some((c) => c.val === 'af-2'))
  const ins1 = __insertCalls().filter((c) => c.table === 'rep_activos_fijos')
  const nuevaFila = (ins1.at(-1)?.payload ?? [])[0] ?? {}
  check('la fila NUEVA lleva el documento nuevo + uuid_sync', nuevaFila.oc === 'OC-999' && typeof nuevaFila.uuid_sync === 'string' && nuevaFila.uuid_sync.length > 10)
  check('la fila nueva lleva usuario', nuevaFila.usuario_id === 'u-1')

  // Escenario 2: doc SIN cambio + fila SIN cambio → 0 updates (escritura mínima).
  const updAntes = __updateCalls().length
  const res2 = await guardarEdicionAF({
    docOriginal,
    docNuevo: { fecha: '2026-11-17', guia: 'T001-12345', oc: 'OC-777' },
    conservadas: [{ id: 'af-1', articulo: '12000022', descripcion: 'TORNO', activacion: 'SN-88213', conExcepcion: false, contenidoCambio: false }],
    idsEliminados: [],
    nuevas: [],
    usuario: { id: 'u-1', nombre: 'Op', correo: 'op@rackly.pe' },
  })
  check('sin cambios: 0 updates, 0 deletes, 0 inserts', res2.actualizadas === 0 && res2.eliminadas === 0 && res2.nuevasIds.length === 0)
  check('sin cambios: NINGÚN update fue enviado (__updateCalls es copia → comparar conteo)', __updateCalls().length === updAntes, `${__updateCalls().length - updAntes} updates extra`)

  console.log('── ACTUALIZAR una fila + BORRAR activo/documento ──')
  __setUpdateData({ data: [{ id: 'af-1' }], error: null })
  await actualizarActivoFijo({ id: 'af-1', articulo: 'AF-2024-001', descripcion: 'COMPRESOR', activacion: 'SN-1', conExcepcion: true, contenidoCambio: true })
  const updSolo = __updateCalls().filter((c) => c.table === 'rep_activos_fijos').at(-1)
  check('actualizarActivoFijo: artículo/activación normalizados a mayúsculas', updSolo?.payload?.articulo === 'AF-2024-001' && updSolo?.payload?.activacion === 'SN-1')
  check('actualizarActivoFijo sin doc: NO toca fecha/guía/oc', updSolo?.payload?.fecha === undefined && updSolo?.payload?.guia === undefined)
  __setUpdateData({ data: [], error: null })
  let falloHonesto = ''
  try {
    await actualizarActivoFijo({ id: 'fantasma', articulo: '12000022', descripcion: '', activacion: null, conExcepcion: false, contenidoCambio: true })
  } catch (e) {
    falloHonesto = e instanceof Error ? e.message : String(e)
  }
  check('update de fila inexistente → error honesto', falloHonesto.includes('no se pudo actualizar'), falloHonesto)
  __setDeleteResult({ data: [{ id: 'af-9' }], error: null })
  await borrarActivoAF('af-9')
  const eqD = __eqCalls().filter((c) => c.table === 'rep_activos_fijos' && c.col === 'id' && c.val === 'af-9')
  check('borrarActivoAF filtra por ID exacto', eqD.length >= 1)
  __setDeleteResult({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null })
  const nDoc = await borrarDocumentoAF({ fecha: '2026-11-17', guia: 'T001-99999', oc: '' })
  check('borrarDocumentoAF devuelve las filas borradas (3)', nDoc === 3, String(nDoc))
  const eqDoc = __eqCalls().filter((c) => c.table === 'rep_activos_fijos')
  check('borrado por documento: filtra fecha+guía+oc', eqDoc.some((c) => c.col === 'fecha' && c.val === '2026-11-17') && eqDoc.some((c) => c.col === 'guia' && c.val === 'T001-99999') && eqDoc.some((c) => c.col === 'oc' && c.val === ''))
}

pruebasRegistro()
  .then(() => {
    console.log(`════════ RESULTADO: ${PASADOS} pasados, ${FALLIDOS} fallidos ════════`)
    if (FALLIDOS > 0) process.exit(1)
  })
  .catch((e) => {
    console.error('ERROR no capturado:', e)
    process.exit(1)
  })
