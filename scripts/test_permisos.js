/**
 * RACKLY — Tests de permisos granulares (permisos.ts) y lote granular (lote.ts).
 *
 * Ejecutar (vía suite): bash scripts/run_all_tests.sh
 * Directo:
 *   npx esbuild scripts/test_permisos.js --bundle --platform=node \
 *     --outfile=/tmp/test_permisos.cjs --alias:@=./src --loader:.ts=ts && node /tmp/test_permisos.cjs
 *
 * Escenarios:
 *   1. Catálogo: códigos únicos, con etiqueta/descripción/grupo, 10 permisos.
 *   2. rolConcedePermiso: matriz por defecto admin/supervisores/almacenero/
 *      coordinador/operario/auxiliar (espejo de tiene_permiso() en BD).
 *   3. puede(): override gana al rol (concesión y revocación), admin inmutable,
 *      sin perfil → false, permisosExtra null → cae al rol.
 *   4. puedeEditarLotePerfil: rol almacenero true · operario false · operario
 *      con override true · almacenero con revocación false.
 */

const {
  PERMISOS,
  PERMISOS_SUPERVISOR,
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
console.log('1 · Catálogo de permisos')
verificar(PERMISOS.length === 10, `debe tener 10 permisos (tiene ${PERMISOS.length})`)
const codigos = PERMISOS.map((p) => p.codigo)
verificar(new Set(codigos).size === codigos.length, 'códigos únicos (sin duplicados)')
for (const p of PERMISOS) {
  verificar(!!p.etiqueta && !!p.descripcion && !!p.grupo, `permiso ${p.codigo} con etiqueta/descripción/grupo`)
}
const GRUPOS_VALIDOS = ['racks', 'piso', 'recepcion', 'atencion', 'catalogo', 'usuarios', 'otros']
for (const p of PERMISOS) {
  verificar(GRUPOS_VALIDOS.includes(p.grupo), `permiso ${p.codigo} con grupo válido (${p.grupo})`)
}
// Los 6 permisos supervisor-level deben existir en el catálogo
for (const s of PERMISOS_SUPERVISOR) {
  verificar(codigos.includes(s), `PERMISOS_SUPERVISOR "${s}" presente en catálogo`)
}
verificar(etiquetaPermiso('no-existe') === 'no-existe', 'etiquetaPermiso cae al código si no existe')

// ═══ 2 · Matriz por defecto por rol (espejo EXACTO de tiene_permiso en BD) ═══
console.log('2 · rolConcedePermiso: matriz por defecto')
const SUPERVISORES = ['supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones']

// admin: TODO
verificar(rolConcedePermiso('admin', 'movimientos.eliminar'), 'admin → movimientos.eliminar')
verificar(rolConcedePermiso('admin', 'sectores.gestionar'), 'admin → sectores.gestionar')
verificar(rolConcedePermiso('admin', 'usuarios.gestionar_roles'), 'admin → usuarios.gestionar_roles')
verificar(rolConcedePermiso('admin', 'descarga.subir'), 'admin → descarga.subir')

// supervisores: los 6 de supervisión, NADA más
for (const rol of SUPERVISORES) {
  for (const p of PERMISOS_SUPERVISOR) {
    verificar(rolConcedePermiso(rol, p), `${rol} → ${p} (por defecto)`)
  }
  verificar(!rolConcedePermiso(rol, 'sectores.gestionar'), `${rol} ✗ sectores.gestionar`)
  verificar(!rolConcedePermiso(rol, 'usuarios.gestionar_roles'), `${rol} ✗ usuarios.gestionar_roles`)
  verificar(!rolConcedePermiso(rol, 'descarga.subir') || rol === 'coordinador_operaciones', `${rol} ✗ descarga.subir (salvo coordinador)`)
}

// coordinador: + descarga.subir
verificar(rolConcedePermiso('coordinador_operaciones', 'descarga.subir'), 'coordinador → descarga.subir')
verificar(!rolConcedePermiso('supervisor_almacen', 'descarga.subir'), 'supervisor_almacen ✗ descarga.subir')

// almacenero: solo lote.editar
verificar(rolConcedePermiso('almacenero', 'lote.editar'), 'almacenero → lote.editar')
verificar(!rolConcedePermiso('almacenero', 'movimientos.eliminar'), 'almacenero ✗ movimientos.eliminar')
verificar(!rolConcedePermiso('almacenero', 'catalogo.editar'), 'almacenero ✗ catalogo.editar')

// operario/auxiliar: nada
verificar(!rolConcedePermiso('operario', 'movimientos.eliminar'), 'operario ✗ movimientos.eliminar')
verificar(!rolConcedePermiso('operario', 'lote.editar'), 'operario ✗ lote.editar')
verificar(!rolConcedePermiso('auxiliar', 'recepcion.eliminar'), 'auxiliar ✗ recepcion.eliminar')
verificar(!rolConcedePermiso(null, 'movimientos.eliminar'), 'sin rol ✗ todo')
verificar(!rolConcedePermiso('', 'movimientos.eliminar'), 'rol vacío ✗ todo')

// compat: puedeEditarLote (por rol) intacta
verificar(puedeEditarLote('almacenero') === true, 'puedeEditarLote(almacenero) true')
verificar(puedeEditarLote('operario') === false, 'puedeEditarLote(operario) false')

// ═══ 3 · puede(): overrides ═══
console.log('3 · puede(): overrides por usuario')

// Concesión a operario (gana al rol)
const operarioConPermiso = { rol: 'operario', permisosExtra: { 'movimientos.eliminar': true } }
verificar(puede(operarioConPermiso, 'movimientos.eliminar'), 'operario + override true → puede eliminar')
verificar(!puede(operarioConPermiso, 'recepcion.eliminar'), 'operario + override solo en movimientos → ✗ recepción')

// Revocación a supervisor (gana al rol)
const supervisorRevocado = { rol: 'supervisor_almacen', permisosExtra: { 'movimientos.eliminar': false } }
verificar(!puede(supervisorRevocado, 'movimientos.eliminar'), 'supervisor + override false → NO puede eliminar')
verificar(puede(supervisorRevocado, 'atencion.eliminar'), 'supervisor revocado conserva sus demás permisos de rol')

// Admin: inmutable (ignora overrides — anti-lockout)
const adminConRevoca = { rol: 'admin', permisosExtra: { 'usuarios.gestionar_roles': false } }
verificar(puede(adminConRevoca, 'usuarios.gestionar_roles'), 'admin SIEMPRE tiene todo (override ignorado)')

// permisosExtra null/undefined → cae al rol
const supervisorSinOverrides = { rol: 'supervisor_almacen', permisosExtra: null }
verificar(puede(supervisorSinOverrides, 'recepcion.eliminar'), 'supervisor sin overrides → usa rol')
const operarioSinObjeto = { rol: 'operario' }
verificar(!puede(operarioSinObjeto, 'movimientos.eliminar'), 'operario sin permisosExtra → usa rol')

// Sin perfil / permisos Extra parcial
verificar(!puede(null, 'movimientos.eliminar'), 'perfil null → false')
verificar(!puede(undefined, 'lote.editar'), 'perfil undefined → false')
verificar(puede({ rol: 'operario', permisosExtra: {} }, 'movimientos.eliminar') === false, 'permisosExtra vacío → rol')

// lote.editar granular
verificar(puede({ rol: 'operario', permisosExtra: { 'lote.editar': true } }, 'lote.editar'), 'operario + override lote.editar → puede')
verificar(!puede({ rol: 'almacenero', permisosExtra: { 'lote.editar': false } }, 'lote.editar'), 'almacenero + revocación lote.editar → no puede')
verificar(puedeEditarLotePerfil({ rol: 'almacenero' }), 'puedeEditarLotePerfil(almacenero) true')
verificar(puedeEditarLotePerfil({ rol: 'operario', permisosExtra: { 'lote.editar': true } }), 'puedeEditarLotePerfil(operario + override) true')
verificar(puedeEditarLotePerfil(null) === false, 'puedeEditarLotePerfil(null) false')

// descarga.subir granular
verificar(puede({ rol: 'operario', permisosExtra: { 'descarga.subir': true } }, 'descarga.subir'), 'operario + override descarga.subir → puede')
verificar(!puede({ rol: 'supervisor_operaciones', permisosExtra: null }, 'descarga.subir'), 'supervisor_operaciones ✗ descarga.subir')

console.log('──────────────────────────────')
console.log(`Permisos: ${pasados} OK · ${fallidos} FALLA`)
if (fallidos > 0) process.exit(1)
