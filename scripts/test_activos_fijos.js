/**
 * RACKLY — Tests: Recepción de ACTIVOS FIJOS (Repuestos, 2026-11-17).
 * Cubre el autocompletado de la serie 12 (22 → 12000022), validaciones
 * (normal vs EXCEPCIÓN de serie), el registro idempotente con uuid_sync
 * (payload real capturado por el stub) y los rótulos (ACT en descripción,
 * QR = id de SU fila). Stub de Supabase — sin red.
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
  SERIE_AF,
  LARGO_ARTICULO_AF,
} = require('@/lib/rackly/rep/activos-fijos')
const {
  __setTable,
  __setInsertResult,
  __insertCalls,
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

  console.log('── RÓTULOS (código grande + ACT en descripción + QR por fila) ──')
  const rotulos = rotulosDesdeActivos(lista.slice(0, 2))
  check('1 rótulo por activo', rotulos.length === 2)
  check('código = N° de artículo', rotulos[0].codigo === '12000022')
  check('con activación: «ACT: SN-88213» en descripción', rotulos[0].descripcion === 'TORNO · ACT: SN-88213', rotulos[0].descripcion)
  check('sin activación: descripción sin ACT', rotulos[1].descripcion === 'FRESADORA')
  check('CANT 1 ACT (unidad física única)', rotulos[0].cantidad === '1' && rotulos[0].unidad === 'ACT')
  check('QR único: recepcionId = id de SU fila', rotulos[0].recepcionId === 'af-1' && rotulos[1].recepcionId === 'af-2')
  check('1 copia por rótulo (configurable en el modal)', rotulos.every((r) => r.copias === 1))
  const sinDesc = rotulosDesdeActivos([lista[2]])
  check('descripción vacía cae al código (rótulo legible)', sinDesc[0].descripcion === '13000045', sinDesc[0].descripcion)
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
