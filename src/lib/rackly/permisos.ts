/**
 * RACKLY — Catálogo único de PERMISOS granulares por usuario.
 *
 * Cada permiso se puede CONCEDER o REVOCAR a un usuario concreto
 * (independientemente de su cargo/rol). La fuente de verdad en BD es la
 * función SECURITY DEFINER `tiene_permiso(user, permiso)` + la tabla
 * `user_permisos` (solo overrides) — ver supabase/migrations/
 * 20261031_permisos_por_usuario.sql. Los códigos de este archivo son el
 * ESPEJO del catálogo validado en la RPC `establecer_permiso_usuario`:
 * si añades un permiso aquí, añádelo también ahí.
 *
 * Semántica (idéntica en cliente y BD):
 *   1. admin                    → SIEMPRE true (sin lockout, ignora overrides).
 *   2. Override en user_permisos → su valor (true o false), gana al rol.
 *   3. Sin override              → valor por defecto del rol.
 */

import { ROLES_SUPERVISORES } from './constants'

/** Permisos que los roles de supervisión tienen por defecto */
export const PERMISOS_SUPERVISOR = [
  'movimientos.eliminar',
  'piso_movimientos.eliminar',
  'recepcion.eliminar',
  'atencion.eliminar',
  'catalogo.editar',
  'usuarios.aprobar',
] as const

/** Catálogo completo (10 permisos — espejo de la RPC en BD) */
export const PERMISOS = [
  // ── Racks (Kardex) ──
  // movimientos.eliminar cubre TAMBIÉN el borrado de filas de stock (la
  // acción "eliminar ubicación" borra de la tabla movimientos — mismo permiso,
  // misma política BD; un solo permiso evita promesas que la BD rechace).
  { codigo: 'movimientos.eliminar', grupo: 'racks', etiqueta: 'Eliminar movimientos y stock', descripcion: 'Borrar registros de movimientos de racks y filas de stock por ubicación.' },
  { codigo: 'lote.editar', grupo: 'racks', etiqueta: 'Editar lote y vencimiento', descripcion: 'Completar o corregir lote/fecha de vencimiento de artículos (Racks y Piso).' },
  // ── Piso ──
  { codigo: 'piso_movimientos.eliminar', grupo: 'piso', etiqueta: 'Eliminar movimientos', descripcion: 'Borrar registros de movimientos del kardex de piso.' },
  { codigo: 'sectores.gestionar', grupo: 'piso', etiqueta: 'Gestionar sectores', descripcion: 'Crear o eliminar sectores, bloques, columnas, niveles, posiciones y subcolumnas del piso.' },
  // ── Recepción ──
  { codigo: 'recepcion.eliminar', grupo: 'recepcion', etiqueta: 'Eliminar guías', descripcion: 'Borrar guías de recepción registradas por cualquier usuario.' },
  // ── Atención ──
  { codigo: 'atencion.eliminar', grupo: 'atencion', etiqueta: 'Eliminar RQ/RAL', descripcion: 'Borrar solicitudes (RQ), atenciones y registros RAL de cualquier usuario.' },
  // ── Catálogo ──
  { codigo: 'catalogo.editar', grupo: 'catalogo', etiqueta: 'Editar catálogo', descripcion: 'Agregar, editar o eliminar artículos; importar catálogo desde Excel o texto.' },
  // ── Usuarios ──
  { codigo: 'usuarios.aprobar', grupo: 'usuarios', etiqueta: 'Aprobar accesos', descripcion: 'Aprobar o revocar el acceso de usuarios a la app.' },
  { codigo: 'usuarios.gestionar_roles', grupo: 'usuarios', etiqueta: 'Gestionar roles y usuarios', descripcion: 'Cambiar roles, eliminar usuarios, enviar recuperación de contraseña y gestionar permisos de otros.' },
  // ── Otros ──
  { codigo: 'descarga.subir', grupo: 'otros', etiqueta: 'Subir UP Data', descripcion: 'Usar la pestaña UP Data de la Descarga (carga de datos desde Excel).' },
] as const

export type Permiso = (typeof PERMISOS)[number]['codigo']

export type GrupoPermiso = (typeof PERMISOS)[number]['grupo']

/** Mapa de permisos supervisor-level para lookup O(1) */
const SUPERVISOR_SET = new Set<string>(PERMISOS_SUPERVISOR)

/**
 * ¿El ROL concede este permiso por defecto (sin overrides)?
 * Espejo exacto de los defaults dentro de `tiene_permiso()` en BD.
 */
export function rolConcedePermiso(
  rol: string | null | undefined,
  permiso: string
): boolean {
  if (!rol) return false
  if (rol === 'admin') return true
  // lote.editar (ROLES_EDICION_LOTE)
  if (permiso === 'lote.editar') {
    return rol === 'almacenero' || rol === 'supervisor_almacen' || rol === 'supervisor_operaciones'
  }
  // descarga.subir (ROLES_UPDATA)
  if (permiso === 'descarga.subir') return rol === 'coordinador_operaciones'
  // Permisos de supervisión
  return (ROLES_SUPERVISORES as readonly string[]).includes(rol) && SUPERVISOR_SET.has(permiso)
}

/** Forma mínima de perfil para evaluar permisos (evita imports circulares) */
export type PerfilConPermisos = {
  rol?: string | null
  permisosExtra?: Record<string, boolean> | null
}

/**
 * ¿PUEDE este usuario ejercer el permiso? (regla única de la app)
 *   admin → true · override → su valor · defecto → según el rol.
 */
export function puede(
  perfil: PerfilConPermisos | null | undefined,
  permiso: Permiso
): boolean {
  if (!perfil) return false
  if (perfil.rol === 'admin') return true
  const override = perfil.permisosExtra?.[permiso]
  if (typeof override === 'boolean') return override
  return rolConcedePermiso(perfil.rol, permiso)
}

/** Etiqueta legible de un permiso (para toasts y badges) */
export function etiquetaPermiso(permiso: string): string {
  return PERMISOS.find((p) => p.codigo === permiso)?.etiqueta ?? permiso
}
