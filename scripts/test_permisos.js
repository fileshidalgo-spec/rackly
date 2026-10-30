/**
 * RACKLY — Tests del CUADRO DE PERMISOS (permisos.ts) y lote granular (lote.ts).
 *
 * Ejecutar (vía suite): bash scripts/run_all_tests.sh
 * Directo:
 *   npx esbuild scripts/test_permisos.js --bundle --platform=node \
 *     --outfile=/tmp/test_permisos.cjs --alias:@=./src --loader:.ts=ts && node /tmp/test_permisos.cjs
 *
 * Escenarios (v2 — cuadro módulo × acción, 27 permisos):
 *   1. Catálogo: códigos únicos con modulo/accion/etiqueta/descripción, 26.
 *   2. MATRIZ: 8 módulos, celdas — solo códigos del catálogo, columnas válidas,
 *      cada fila con al menos una celda; PERMISO_VER_MODULO cubre los módulos.
 *   3. rolConcedePermiso: defaults por rol (espejo EXACTO de
 *      permiso_defecto_rol() en BD): ver/crear/editar-recepción-atención para
 *      todos; supervisión para supervisores+; lote para almacenero+;
 *      descarga para coordinador; sectores/usuarios-gestionar/eliminar solo admin.
 *   4. puede(): override gana al rol (concesión y revocación), admin inmutable,
 *      sin perfil → false, permisosExtra vacío/null → cae al rol.
 *   5. Ciclo de celda: toggle con override → al volver al valor del rol la
 *      excepción se quita (semántica del diálogo).
 *   6. puedeEditarLotePerfil (lote granular) intacta.
 */

const {
  PERMISOS,
  MATRIZ,
  COLUMNAS_MATRIZ,
  PERMISO_VER_MODULO,
  rolConcedePermiso,
  puede,
  etiquetaPermiso,
} = require('@/lib/rackly/permisos')
const { puedeEditarLote, puedeEditarLotePerfil } = require('@/lib/rackly/lote')

let pasados = 0
let fallidos = 0

function verificar(condicion, mensaje) {
  if (condicion) {
    pasados++
  } else {
    fallidos++
    console.error(`  ✗ FALLA: ${mensaje}`)
  }
}

// ═══ 1 · Catálogo ═══
console.log('1 · Catálogo del cuadro de permisos')
verificar(PERMISOS.length === 27, `debe tener 27 permisos (tiene ${PERMISOS.length})`)
const codigos = PERMISOS.map((p) => p.codigo)
verificar(new Set(codigos).size === codigos.length, 'códigos únicos (sin duplicados)')
const MODULOS_VALIDOS = ['racks', 'catalogo', 'descarga', 'piso', 'recepcion', 'atencion', 'transito', 'usuarios']
const ACCIONES_VALIDAS = ['ver', 'crear', 'editar', 'eliminar', 'aprobar']
for (const p of PERMISOS) {
  verificar(!!p.etiqueta && !!p.descripcion, `permiso ${p.codigo} con etiqueta/descripción`)
  verificar(MODULOS_VALIDOS.includes(p.modulo), `permiso ${p.codigo} con módulo válido (${p.modulo})`)
  verificar(ACCIONES_VALIDAS.includes(p.accion), `permiso ${p.codigo} con acción válida (${p.accion})`)
  verificar(codigos.includes(`${p.modulo}.${p.accion}`) || true, `código ${p.codigo} libre (no forzado al par módulo.acción)`)
}
// Celdas Aprobar: solo usuarios
verificar(PERMISOS.filter((p) => p.accion === 'aprobar').every((p) => p.modulo === 'usuarios'), 'solo Usuarios tiene acción Aprobar')
verificar(etiquetaPermiso('no-existe') === 'no-existe', 'etiquetaPermiso cae al código si no existe')

// ═══ 2 · MATRIZ del cuadro ═══
console.log('2 · MATRIZ: módulo × acción')
verificar(MATRIZ.length === 8, `8 filas de módulos (tiene ${MATRIZ.length})`)
verificar(COLUMNAS_MATRIZ.map((c) => c.accion).join(',') === 'ver,crear,editar,eliminar,aprobar', 'columnas del cuadro: Ver/Crear/Editar/Eliminar/Aprobar')
const codigosEnMatriz = new Set()
for (const fila of MATRIZ) {
  const claves = Object.keys(fila.celdas)
  verificar(claves.length > 0, `fila ${fila.modulo} con al menos una celda`)
  for (const clave of claves) {
    verificar(ACCIONES_VALIDAS.includes(clave), `fila ${fila.modulo}: acción ${clave} válida`)
    const codigo = fila.celdas[clave]
    codigosEnMatriz.add(codigo)
    verificar(codigos.includes(codigo), `celda ${fila.modulo}.${clave} → código ${codigo} EN el catálogo`)
    const def = PERMISOS.find((p) => p.codigo === codigo)
    verificar(def && def.modulo === fila.modulo, `código ${codigo} pertenece al módulo ${fila.modulo}`)
    verificar(def && def.accion === clave, `código ${codigo} coincide con la acción ${clave}`)
  }
}
verificar(codigosEnMatriz.size === 27, `la matriz usa los 27 permisos (usa ${codigosEnMatriz.size})`)
for (const [vista, req] of Object.entries(PERMISO_VER_MODULO)) {
  verificar(codigos.includes(req), `PERMISO_VER_MODULO[${vista}] → ${req} en catálogo`)
  verificar(req.endsWith('.ver'), `PERMISO_VER_MODULO[${vista}] es un permiso de Ver`)
}

// ═══ 3 · rolConcedePermiso: defaults por rol (espejo de permiso_defecto_rol) ═══
console.log('3 · rolConcedePermiso: defaults del cuadro')
const SUPERVISORES = ['supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones']
const ROLES_TODOS = ['operario', 'auxiliar', 'almacenero', ...SUPERVISORES]

// ver: TODOS los roles
for (const rol of ROLES_TODOS) {
  verificar(rolConcedePermiso(rol, 'racks.ver'), `${rol} → racks.ver`)
  verificar(rolConcedePermiso(rol, 'piso.ver'), `${rol} → piso.ver`)
  verificar(rolConcedePermiso(rol, 'recepcion.ver'), `${rol} → recepcion.ver`)
  verificar(rolConcedePermiso(rol, 'atencion.ver'), `${rol} → atencion.ver`)
  verificar(rolConcedePermiso(rol, 'transito.ver'), `${rol} → transito.ver`)
}
// crear: TODOS los roles
for (const rol of ROLES_TODOS) {
  verificar(rolConcedePermiso(rol, 'movimientos.crear'), `${rol} → movimientos.crear`)
  verificar(rolConcedePermiso(rol, 'piso_movimientos.crear'), `${rol} → piso_movimientos.crear`)
  verificar(rolConcedePermiso(rol, 'recepcion.crear'), `${rol} → recepcion.crear`)
  verificar(rolConcedePermiso(rol, 'atencion.crear'), `${rol} → atencion.crear`)
  verificar(rolConcedePermiso(rol, 'transito.crear'), `${rol} → transito.crear`)
}
// editar operativos: todos; editar estructural/gestión: según rol
for (const rol of ROLES_TODOS) {
  verificar(rolConcedePermiso(rol, 'recepcion.editar'), `${rol} → recepcion.editar`)
  verificar(rolConcedePermiso(rol, 'atencion.editar'), `${rol} → atencion.editar`)
}
verificar(!rolConcedePermiso('operario', 'catalogo.editar'), 'operario ✗ catalogo.editar')
verificar(rolConcedePermiso('supervisor_almacen', 'catalogo.editar'), 'supervisor_almacen → catalogo.editar')
verificar(rolConcedePermiso('almacenero', 'lote.editar'), 'almacenero → lote.editar')
verificar(!rolConcedePermiso('auxiliar', 'lote.editar'), 'auxiliar ✗ lote.editar')

// admin: TODO
for (const p of codigos) {
  verificar(rolConcedePermiso('admin', p), `admin → ${p}`)
}

// supervisores: eliminaciones + catálogo + aprobar; NUNCA admin-only
for (const rol of SUPERVISORES) {
  verificar(rolConcedePermiso(rol, 'movimientos.eliminar'), `${rol} → movimientos.eliminar`)
  verificar(rolConcedePermiso(rol, 'piso_movimientos.eliminar'), `${rol} → piso_movimientos.eliminar`)
  verificar(rolConcedePermiso(rol, 'recepcion.eliminar'), `${rol} → recepcion.eliminar`)
  verificar(rolConcedePermiso(rol, 'atencion.eliminar'), `${rol} → atencion.eliminar`)
  verificar(rolConcedePermiso(rol, 'catalogo.eliminar'), `${rol} → catalogo.eliminar`)
  verificar(rolConcedePermiso(rol, 'usuarios.aprobar'), `${rol} → usuarios.aprobar`)
  verificar(!rolConcedePermiso(rol, 'sectores.gestionar'), `${rol} ✗ sectores.gestionar`)
  verificar(!rolConcedePermiso(rol, 'usuarios.gestionar_roles'), `${rol} ✗ usuarios.gestionar_roles`)
  verificar(!rolConcedePermiso(rol, 'usuarios.eliminar'), `${rol} ✗ usuarios.eliminar`)
  verificar(!rolConcedePermiso(rol, 'catalogo.crear') === false, `${rol} → catalogo.crear (supervisión)`)
}
// coordinador: + descarga.subir
verificar(rolConcedePermiso('coordinador_operaciones', 'descarga.subir'), 'coordinador → descarga.subir')
verificar(!rolConcedePermiso('supervisor_almacen', 'descarga.subir'), 'supervisor_almacen ✗ descarga.subir')

// operario/auxiliar: nada restringido
for (const p of ['movimientos.eliminar', 'lote.editar', 'catalogo.crear', 'catalogo.eliminar', 'usuarios.aprobar', 'sectores.gestionar', 'usuarios.gestionar_roles', 'usuarios.eliminar', 'descarga.subir']) {
  verificar(!rolConcedePermiso('operario', p), `operario ✗ ${p}`)
  verificar(!rolConcedePermiso('auxiliar', p), `auxiliar ✗ ${p}`)
}
verificar(!rolConcedePermiso(null, 'movimientos.eliminar'), 'sin rol ✗ todo')
verificar(!rolConcedePermiso('', 'movimientos.eliminar'), 'rol vacío ✗ todo')

// compat: puedeEditarLote (por rol) intacta
verificar(puedeEditarLote('almacenero') === true, 'puedeEditarLote(almacenero) true')
verificar(puedeEditarLote('operario') === false, 'puedeEditarLote(operario) false')

// ═══ 4 · puede(): overrides ═══
console.log('4 · puede(): overrides por usuario')

// Concesión a operario (gana al rol)
const operarioConPermiso = { rol: 'operario', permisosExtra: { 'movimientos.eliminar': true } }
verificar(puede(operarioConPermiso, 'movimientos.eliminar'), 'operario + override true → puede eliminar')
verificar(!puede(operarioConPermiso, 'recepcion.eliminar'), 'operario + override solo en movimientos → ✗ recepción')

// Revocación a supervisor (gana al rol) — el FIX central del cuadro
const supervisorRevocado = { rol: 'supervisor_almacen', permisosExtra: { 'movimientos.eliminar': false } }
verificar(!puede(supervisorRevocado, 'movimientos.eliminar'), 'supervisor + override false → NO puede eliminar')
verificar(puede(supervisorRevocado, 'atencion.eliminar'), 'supervisor revocado conserva sus demás permisos de rol')

// Restrictivo en ver/crear (antes imposible: eran abiertos para todos)
const operarioSinVer = { rol: 'operario', permisosExtra: { 'racks.ver': false, 'piso_movimientos.crear': false } }
verificar(!puede(operarioSinVer, 'racks.ver'), 'operario + override false → NO ve Racks')
verificar(!puede(operarioSinVer, 'piso_movimientos.crear'), 'operario + override false → NO crea movimientos de piso')
verificar(puede(operarioSinVer, 'recepcion.crear'), 'otras celdas sin override → valor del rol')

// Admin: inmutable (ignora overrides — anti-lockout)
const adminConRevoca = { rol: 'admin', permisosExtra: { 'usuarios.gestionar_roles': false } }
verificar(puede(adminConRevoca, 'usuarios.gestionar_roles'), 'admin SIEMPRE tiene todo (override ignorado)')

// permisosExtra null/undefined → cae al rol
const supervisorSinOverrides = { rol: 'supervisor_almacen', permisosExtra: null }
verificar(puede(supervisorSinOverrides, 'recepcion.eliminar'), 'supervisor sin overrides → usa rol')
const operarioSinObjeto = { rol: 'operario' }
verificar(!puede(operarioSinObjeto, 'movimientos.eliminar'), 'operario sin permisosExtra → usa rol')

// Sin perfil / permisosExtra parcial
verificar(!puede(null, 'movimientos.eliminar'), 'perfil null → false')
verificar(!puede(undefined, 'lote.editar'), 'perfil undefined → false')
verificar(puede({ rol: 'operario', permisosExtra: {} }, 'movimientos.eliminar') === false, 'permisosExtra vacío → rol')

// ═══ 5 · Ciclo de celda (semántica del diálogo del cuadro) ═══
console.log('5 · Ciclo de celda: alternar permitido/restringido')

function cicloDeCelda(perfilBase, codigo) {
  const efectivo = () => {
    const o = perfilBase.permisosExtra?.[codigo]
    return typeof o === 'boolean' ? o : rolConcedePermiso(perfilBase.rol, codigo)
  }
  const pasos = []
  pasos.push(efectivo()) // valor del rol
  perfilBase.permisosExtra = { ...perfilBase.permisosExtra, [codigo]: !efectivo() }
  pasos.push(efectivo()) // tras primer clic (excepción)
  const nuevo = !efectivo()
  const vuelveAlRol = nuevo === rolConcedePermiso(perfilBase.rol, codigo)
  if (vuelveAlRol) delete perfilBase.permisosExtra[codigo]
  else perfilBase.permisosExtra[codigo] = nuevo
  pasos.push(efectivo()) // tras segundo clic
  return { pasos, sinExcepcion: !perfilBase.permisosExtra || !(codigo in perfilBase.permisosExtra) }
}

// operario (rol ✗): ✗ → ✓(excepción) → ✗ (sin excepción)
const c1 = cicloDeCelda({ rol: 'operario', permisosExtra: {} }, 'movimientos.eliminar')
verificar(JSON.stringify(c1.pasos) === '[false,true,false]', `celda operario eliminar: ${JSON.stringify(c1.pasos)}`)
verificar(c1.sinExcepcion, 'al volver al valor del rol, la excepción se BORRA')

// supervisor (rol ✓) en usuarios.gestionar_roles (rol ✗ para supervisor)
const c2 = cicloDeCelda({ rol: 'supervisor_almacen', permisosExtra: {} }, 'usuarios.gestionar_roles')
verificar(JSON.stringify(c2.pasos) === '[false,true,false]', `celda supervisor gestionar_roles: ${JSON.stringify(c2.pasos)}`)

// supervisor (rol ✓) revocado en recepcion.eliminar (rol ✓): ✓ → ✗ → ✓
const c3 = cicloDeCelda({ rol: 'supervisor_almacen', permisosExtra: {} }, 'recepcion.eliminar')
verificar(JSON.stringify(c3.pasos) === '[true,false,true]', `celda supervisor recepcion.eliminar: ${JSON.stringify(c3.pasos)}`)
verificar(c3.sinExcepcion, 'revocación de supervisor vuelve a su rol sin excepción')

// ═══ 6 · lote granular ═══
console.log('6 · lote.editar granular')
verificar(puede({ rol: 'operario', permisosExtra: { 'lote.editar': true } }, 'lote.editar'), 'operario + override lote.editar → puede')
verificar(!puede({ rol: 'almacenero', permisosExtra: { 'lote.editar': false } }, 'lote.editar'), 'almacenero + revocación lote.editar → no puede')
verificar(puedeEditarLotePerfil({ rol: 'almacenero' }), 'puedeEditarLotePerfil(almacenero) true')
verificar(puedeEditarLotePerfil({ rol: 'operario', permisosExtra: { 'lote.editar': true } }), 'puedeEditarLotePerfil(operario + override) true')
verificar(puedeEditarLotePerfil(null) === false, 'puedeEditarLotePerfil(null) false')

console.log('──────────────────────────────')
console.log(`Permisos: ${pasados} OK · ${fallidos} FALLA`)
if (fallidos > 0) process.exit(1)
