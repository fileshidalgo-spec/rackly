/**
 * RACKLY — CUADRO DE PERMISOS granular por usuario (módulo × acción).
 *
 * Cada permiso se puede CONCEDER o RESTRINGIR a un usuario concreto
 * (independientemente de su cargo/rol). La fuente de verdad en BD es la
 * función SECURITY DEFINER `tiene_permiso(user, permiso)` + la tabla
 * `user_permisos` (solo overrides) + la matriz de defaults
 * `permiso_defecto_rol(rol, permiso)` — ver supabase/migrations/
 * 20261031_permisos_matriz.sql. Los códigos de este archivo son el ESPEJO
 * del catálogo validado en la RPC `establecer_permiso_usuario`: si añades
 * un permiso aquí, añádelo también ahí.
 *
 * Semántica (idéntica en cliente y BD):
 *   1. admin                    → SIEMPRE true (sin lockout, ignora overrides).
 *   2. Override en user_permisos → su valor (true o false), gana al rol.
 *   3. Sin override              → valor por defecto del rol (CUADRO).
 *
 * La capa DENY vive en 60 políticas RLS `AS RESTRICTIVE` (se AND-ean con las
 * permissive de rol) y en guards dentro de las 14 RPCs SECURITY DEFINER de
 * escritura: marcar ✗ aquí BLOQUEA de verdad, no solo oculta botones.
 */

/** Acciones del cuadro (columnas de la matriz) */
export type AccionPermiso = 'ver' | 'crear' | 'editar' | 'eliminar' | 'aprobar'

/** Módulos (filas del cuadro) */
export type ModuloPermiso =
  | 'racks'
  | 'catalogo'
  | 'descarga'
  | 'piso'
  | 'recepcion'
  | 'atencion'
  | 'transito'
  | 'usuarios'

export type PermisoDef = {
  codigo: string
  modulo: ModuloPermiso
  accion: AccionPermiso
  etiqueta: string
  descripcion: string
}

/** Catálogo completo (26 permisos — espejo de la RPC `establecer_permiso_usuario`) */
export const PERMISOS: PermisoDef[] = [
  // ── Racks (Kardex) ──
  // movimientos.eliminar cubre TAMBIÉN el borrado de filas de stock (la
  // acción "eliminar ubicación" borra de la tabla movimientos — mismo permiso,
  // misma política BD; un solo permiso evita promesas que la BD rechace).
  { codigo: 'racks.ver', modulo: 'racks', accion: 'ver', etiqueta: 'Ver Racks', descripcion: 'Abrir el módulo Racks y consultar stock, movimientos, ocupación y FEFO.' },
  { codigo: 'movimientos.crear', modulo: 'racks', accion: 'crear', etiqueta: 'Crear movimientos', descripcion: 'Registrar ingresos, salidas y traslados en el kardex de racks.' },
  { codigo: 'lote.editar', modulo: 'racks', accion: 'editar', etiqueta: 'Editar lote y vencimiento', descripcion: 'Completar o corregir lote/fecha de vencimiento de artículos (Racks y Piso).' },
  { codigo: 'movimientos.eliminar', modulo: 'racks', accion: 'eliminar', etiqueta: 'Eliminar movimientos y stock', descripcion: 'Borrar registros de movimientos de racks y filas de stock por ubicación.' },
  // ── Catálogo ──
  { codigo: 'catalogo.ver', modulo: 'catalogo', accion: 'ver', etiqueta: 'Ver catálogo', descripcion: 'Abrir la pestaña Catálogo (las búsquedas de artículos del resto del app no se afectan).' },
  { codigo: 'catalogo.crear', modulo: 'catalogo', accion: 'crear', etiqueta: 'Crear artículos', descripcion: 'Agregar artículos nuevos e importar catálogo desde Excel o texto.' },
  { codigo: 'catalogo.editar', modulo: 'catalogo', accion: 'editar', etiqueta: 'Editar artículos', descripcion: 'Modificar datos de artículos existentes.' },
  { codigo: 'catalogo.eliminar', modulo: 'catalogo', accion: 'eliminar', etiqueta: 'Eliminar artículos', descripcion: 'Borrar artículos del catálogo.' },
  // ── Descarga (UP Data) ──
  { codigo: 'descarga.subir', modulo: 'descarga', accion: 'crear', etiqueta: 'Subir UP Data', descripcion: 'Usar la pestaña UP Data de la Descarga (carga de datos desde Excel).' },
  // ── Piso ──
  { codigo: 'piso.ver', modulo: 'piso', accion: 'ver', etiqueta: 'Ver Piso', descripcion: 'Abrir el módulo Piso y consultar su kardex y stock.' },
  { codigo: 'piso_movimientos.crear', modulo: 'piso', accion: 'crear', etiqueta: 'Crear movimientos', descripcion: 'Registrar ingresos, salidas y traslados en el kardex de piso.' },
  { codigo: 'sectores.gestionar', modulo: 'piso', accion: 'editar', etiqueta: 'Gestionar sectores', descripcion: 'Crear, modificar o eliminar sectores, bloques, columnas, niveles, posiciones y subcolumnas.' },
  { codigo: 'piso_movimientos.eliminar', modulo: 'piso', accion: 'eliminar', etiqueta: 'Eliminar movimientos', descripcion: 'Borrar registros de movimientos del kardex de piso.' },
  // ── Recepción ──
  { codigo: 'recepcion.ver', modulo: 'recepcion', accion: 'ver', etiqueta: 'Ver Recepción', descripcion: 'Abrir el módulo Recepción y consultar las guías registradas.' },
  { codigo: 'recepcion.crear', modulo: 'recepcion', accion: 'crear', etiqueta: 'Registrar guías', descripcion: 'Registrar guías de recepción nuevas.' },
  { codigo: 'recepcion.editar', modulo: 'recepcion', accion: 'editar', etiqueta: 'Editar guías', descripcion: 'Abrir y guardar la edición de guías existentes.' },
  { codigo: 'recepcion.eliminar', modulo: 'recepcion', accion: 'eliminar', etiqueta: 'Eliminar guías', descripcion: 'Borrar guías de recepción registradas por cualquier usuario.' },
  // ── Atención ──
  { codigo: 'atencion.ver', modulo: 'atencion', accion: 'ver', etiqueta: 'Ver Atención', descripcion: 'Abrir el módulo Atención y consultar RQ y RAL.' },
  { codigo: 'atencion.crear', modulo: 'atencion', accion: 'crear', etiqueta: 'Atender / crear', descripcion: 'Crear solicitudes (RQ), RAL y atender materiales.' },
  { codigo: 'atencion.editar', modulo: 'atencion', accion: 'editar', etiqueta: 'Editar solicitudes', descripcion: 'Editar el encabezado y los materiales de una RQ; revertir atenciones.' },
  { codigo: 'atencion.eliminar', modulo: 'atencion', accion: 'eliminar', etiqueta: 'Eliminar RQ/RAL', descripcion: 'Borrar solicitudes (RQ), atenciones y registros RAL de cualquier usuario.' },
  // ── Tránsito ──
  { codigo: 'transito.ver', modulo: 'transito', accion: 'ver', etiqueta: 'Ver Tránsito', descripcion: 'Abrir el módulo Tránsito (también le permite leer las guías de Recepción que transfiere).' },
  { codigo: 'transito.crear', modulo: 'transito', accion: 'crear', etiqueta: 'Registrar envíos', descripcion: 'Transferir artículos de Recepción hacia Racks o Piso.' },
  // ── Usuarios ──
  { codigo: 'usuarios.ver', modulo: 'usuarios', accion: 'ver', etiqueta: 'Ver Usuarios', descripcion: 'Abrir el módulo Usuarios y ver la lista y su actividad.' },
  { codigo: 'usuarios.gestionar_roles', modulo: 'usuarios', accion: 'editar', etiqueta: 'Gestionar roles y permisos', descripcion: 'Cambiar roles, enviar recuperación de contraseña y gestionar permisos de otros.' },
  { codigo: 'usuarios.eliminar', modulo: 'usuarios', accion: 'eliminar', etiqueta: 'Eliminar usuarios', descripcion: 'Eliminar perfiles y cuentas de acceso de otros usuarios.' },
  { codigo: 'usuarios.aprobar', modulo: 'usuarios', accion: 'aprobar', etiqueta: 'Aprobar accesos', descripcion: 'Aprobar o revocar el acceso de usuarios a la app.' },
]

export type Permiso = string

/** CUADRO: una fila por módulo, celdas = acción → código (— si no existe) */
export type FilaMatriz = {
  modulo: ModuloPermiso
  etiqueta: string
  /** icono lucide por nombre (el diálogo mapea el nombre al componente) */
  icono: 'warehouse' | 'book' | 'upload' | 'layers' | 'package' | 'heart' | 'truck' | 'users'
  celdas: Partial<Record<AccionPermiso, string>>
}

export const COLUMNAS_MATRIZ: { accion: AccionPermiso; etiqueta: string }[] = [
  { accion: 'ver', etiqueta: 'Ver' },
  { accion: 'crear', etiqueta: 'Crear' },
  { accion: 'editar', etiqueta: 'Editar' },
  { accion: 'eliminar', etiqueta: 'Eliminar' },
  { accion: 'aprobar', etiqueta: 'Aprobar' },
]

export const MATRIZ: FilaMatriz[] = [
  { modulo: 'racks', etiqueta: 'Racks (Kardex)', icono: 'warehouse', celdas: { ver: 'racks.ver', crear: 'movimientos.crear', editar: 'lote.editar', eliminar: 'movimientos.eliminar' } },
  { modulo: 'catalogo', etiqueta: 'Catálogo', icono: 'book', celdas: { ver: 'catalogo.ver', crear: 'catalogo.crear', editar: 'catalogo.editar', eliminar: 'catalogo.eliminar' } },
  { modulo: 'descarga', etiqueta: 'Descarga (UP Data)', icono: 'upload', celdas: { crear: 'descarga.subir' } },
  { modulo: 'piso', etiqueta: 'Piso', icono: 'layers', celdas: { ver: 'piso.ver', crear: 'piso_movimientos.crear', editar: 'sectores.gestionar', eliminar: 'piso_movimientos.eliminar' } },
  { modulo: 'recepcion', etiqueta: 'Recepción', icono: 'package', celdas: { ver: 'recepcion.ver', crear: 'recepcion.crear', editar: 'recepcion.editar', eliminar: 'recepcion.eliminar' } },
  { modulo: 'atencion', etiqueta: 'Atención', icono: 'heart', celdas: { ver: 'atencion.ver', crear: 'atencion.crear', editar: 'atencion.editar', eliminar: 'atencion.eliminar' } },
  { modulo: 'transito', etiqueta: 'Tránsito', icono: 'truck', celdas: { ver: 'transito.ver', crear: 'transito.crear' } },
  { modulo: 'usuarios', etiqueta: 'Usuarios', icono: 'users', celdas: { ver: 'usuarios.ver', editar: 'usuarios.gestionar_roles', eliminar: 'usuarios.eliminar', aprobar: 'usuarios.aprobar' } },
]

/** Permiso que la UI usa para decidir si el MÓDULO se ve (celda Ver) */
export const PERMISO_VER_MODULO: Record<string, string> = {
  racks: 'racks.ver',
  piso: 'piso.ver',
  recepcion: 'recepcion.ver',
  atencion: 'atencion.ver',
  transito: 'transito.ver',
  usuarios: 'usuarios.ver',
}

/** Roles de supervisión (defaults de los permisos restringidos) */
const ROLES_SUPERVISION = ['supervisor_almacen', 'supervisor_operaciones', 'coordinador_operaciones'] as const

const PERMISOS_VER_TODOS = new Set(
  PERMISOS.filter((p) => p.accion === 'ver').map((p) => p.codigo)
)
const PERMISOS_CREAR_TODOS = new Set(
  ['movimientos.crear', 'piso_movimientos.crear', 'recepcion.crear', 'atencion.crear', 'transito.crear']
)
const PERMISOS_SUPERVISION = new Set([
  'catalogo.crear', 'catalogo.editar', 'catalogo.eliminar',
  'movimientos.eliminar', 'piso_movimientos.eliminar', 'recepcion.eliminar',
  'atencion.eliminar', 'usuarios.aprobar',
])

/**
 * ¿El ROL concede este permiso por defecto (sin overrides)?
 * Espejo EXACTO de `permiso_defecto_rol()` en BD (migración
 * 20261031_permisos_matriz.sql) — si cambias uno, cambia el otro.
 */
export function rolConcedePermiso(
  rol: string | null | undefined,
  permiso: string
): boolean {
  if (!rol) return false
  if (rol === 'admin') return true
  // Ver y Crear operativos, y edición de recepción/atención: todos los roles
  if (PERMISOS_VER_TODOS.has(permiso)) return true
  if (PERMISOS_CREAR_TODOS.has(permiso)) return true
  if (permiso === 'recepcion.editar' || permiso === 'atencion.editar') return true
  // lote.editar (ROLES_EDICION_LOTE)
  if (permiso === 'lote.editar') {
    return rol === 'almacenero' || rol === 'supervisor_almacen' || rol === 'supervisor_operaciones'
  }
  // descarga.subir (ROLES_UPDATA)
  if (permiso === 'descarga.subir') return rol === 'coordinador_operaciones'
  // Permisos de supervisión
  if (PERMISOS_SUPERVISION.has(permiso)) {
    return (ROLES_SUPERVISION as readonly string[]).includes(rol)
  }
  // sectores.gestionar · usuarios.gestionar_roles · usuarios.eliminar → admin
  return false
}

/** Forma mínima de perfil para evaluar permisos (evita imports circulares) */
export type PerfilConPermisos = {
  rol?: string | null
  permisosExtra?: Record<string, boolean> | null
}

/**
 * ¿PUEDE este usuario ejercer el permiso? (regla única de la app)
 *   admin → true · override → su valor · defecto → según el cuadro.
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
