/**
 * RACKLY · Tests REPUESTOS — Cuadro de permisos (repuestos.*).
 *
 * Verifica la regla única `puede()` contra los defaults del cuadro
 * (espejo de permiso_defecto_rol en BD — migración 20261110):
 *   · repuestos.ver / repuestos.crear  → TODOS los roles.
 *   · repuestos.gestionar / eliminar   → supervisores+ (y coordinador).
 *   · admin → todo · override del usuario → gana sobre el rol.
 * Y que PERMISO_VER_MODULO cubre las 6 vistas rep- con 'repuestos.ver'.
 */
const assert = require('node:assert')
const { puede, rolConcedePermiso, PERMISO_VER_MODULO } = require('@/lib/rackly/permisos')

let n = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`FALLO #${++n}: ${msg}`)
  n++
}

// ── Admin: SIEMPRE todo (anti-lockout) ──
for (const p of ['repuestos.ver', 'repuestos.crear', 'repuestos.gestionar', 'repuestos.eliminar']) {
  ok(puede({ rol: 'admin' }, p) === true, `admin → ${p}`)
}

// ── Defaults por rol: ver y crear para TODOS (igual que los .ver/.crear de Insumos) ──
for (const rol of ['operario', 'auxiliar', 'almacenero', 'supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones']) {
  ok(rolConcedePermiso(rol, 'repuestos.ver') === true, `${rol} → repuestos.ver por defecto`)
  ok(rolConcedePermiso(rol, 'repuestos.crear') === true, `${rol} → repuestos.crear por defecto`)
}

// ── Gestionar/eliminar: SOLO supervisores+ ──
for (const rol of ['supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones']) {
  ok(rolConcedePermiso(rol, 'repuestos.gestionar') === true, `${rol} → repuestos.gestionar`)
  ok(rolConcedePermiso(rol, 'repuestos.eliminar') === true, `${rol} → repuestos.eliminar`)
}
for (const rol of ['operario', 'auxiliar', 'almacenero']) {
  ok(rolConcedePermiso(rol, 'repuestos.gestionar') === false, `${rol} SIN repuestos.gestionar`)
  ok(rolConcedePermiso(rol, 'repuestos.eliminar') === false, `${rol} SIN repuestos.eliminar`)
}

// ── Overrides: gana el usuario sobre el rol (en ambos sentidos) ──
ok(puede({ rol: 'operario', permisosExtra: { 'repuestos.gestionar': true } }, 'repuestos.gestionar') === true, 'override +gestionar para operario')
ok(puede({ rol: 'supervisor_almacen', permisosExtra: { 'repuestos.eliminar': false } }, 'repuestos.eliminar') === false, 'override −eliminar para supervisor')
ok(puede({ rol: 'admin', permisosExtra: { 'repuestos.eliminar': false } }, 'repuestos.eliminar') === true, 'admin ignora overrides (anti-lockout)')
ok(puede(null, 'repuestos.ver') === false, 'sin perfil → nada')

// ── Rama usuarios.gestionar_roles (necesaria para la RPC de accesos) ──
ok(puede({ rol: 'admin' }, 'usuarios.gestionar_roles') === true, 'admin gestiona roles')
ok(puede({ rol: 'supervisor_almacen' }, 'usuarios.gestionar_roles') === false, 'supervisor NO gestiona roles')

// ── PERMISO_VER_MODULO: las 6 vistas rep- gateadas con repuestos.ver ──
const vistasRep = ['rep-catalogo', 'rep-ubicaciones', 'rep-recepcion', 'rep-atencion', 'rep-transito', 'rep-movimientos']
for (const v of vistasRep) {
  ok(PERMISO_VER_MODULO[v] === 'repuestos.ver', `${v} → repuestos.ver en el cuadro del hub`)
}
// No colisión con Insumos: las claves de Insumos siguen intactas
ok(PERMISO_VER_MODULO.recepcion === 'recepcion.ver', 'recepcion (Insumos) sigue con su permiso')
ok(PERMISO_VER_MODULO.atencion === 'atencion.ver', 'atencion (Insumos) sigue con su permiso')

console.log(`OK test_rep_permisos — ${n} aserciones`)
