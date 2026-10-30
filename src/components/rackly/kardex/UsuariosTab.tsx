'use client'

/**
 * RACKLY — Gestión de usuarios (tabla desktop + tarjetas móvil).
 *
 * Usado por el módulo Usuarios (UsuariosModule) y por la pestaña de Kardex.
 *
 * Permisos (catálogo único en lib/rackly/permisos.ts):
 *   · usuarios.aprobar         → aprobar/revocar accesos.
 *   · usuarios.gestionar_roles → cambiar rol, eliminar, recuperar contraseña
 *                                y abrir el diálogo de permisos granulares.
 * La BD aplica las MISMAS reglas (RPCs con guard tiene_permiso): lo que la UI
 * no muestra, la BD lo rechaza.
 */

import { useState, useEffect, useRef } from 'react'
import {
  getTodosLosPerfiles,
  cambiarRol,
  cambiarAprobado,
  eliminarPerfil,
  type Perfil,
  type Rol,
} from '@/lib/rackly/auth'
import { puede, etiquetaPermiso } from '@/lib/rackly/permisos'
import { ROL_LABEL } from '@/lib/rackly/roles-label'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DialogoPermisos } from '@/components/rackly/usuarios/DialogoPermisos'
import { toast } from 'sonner'
import {
  KeyRound,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

const ROLES_DISPONIBLES: { valor: Rol; etiqueta: string }[] = [
  { valor: 'admin', etiqueta: 'Admin' },
  { valor: 'operario', etiqueta: 'Operario' },
  { valor: 'auxiliar', etiqueta: 'Auxiliar' },
  { valor: 'almacenero', etiqueta: 'Almacenero' },
  { valor: 'supervisor_almacen', etiqueta: 'Supervisor Almacén' },
  { valor: 'supervisor_operaciones', etiqueta: 'Supervisor Operaciones' },
  { valor: 'coordinador_operaciones', etiqueta: 'Coordinador Operaciones' },
]

/** Cantidad de excepciones de permisos guardadas para un usuario */
function totalExcepciones(p: Perfil): number {
  return p.permisosExtra ? Object.keys(p.permisosExtra).length : 0
}

export function UsuariosTab() {
  const { perfil, refresh } = useAuth()
  const [perfiles, setPerfiles] = useState<Perfil[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Perfil | null>(null)
  const [permisosTarget, setPermisosTarget] = useState<Perfil | null>(null)

  // Regla única de permisos (rol + overrides), espejo de la BD
  const puedeAprobar = puede(perfil, 'usuarios.aprobar')
  const puedeGestionar = puede(perfil, 'usuarios.gestionar_roles')
  // Celda «Eliminar» del módulo Usuarios (acción separada en el cuadro)
  const puedeEliminarUsuarios = puede(perfil, 'usuarios.eliminar')

  const loadedRef = useRef(false)

  async function load() {
    setLoading(true)
    try {
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('Error al cargar usuarios', { description: message })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true
      load()
    }
  }, [])

  // IDs de usuario con operación en vuelo: evita doble-submit (rol/aprobado)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function handleRolChange(userId: string, nuevoRol: Rol) {
    if (busyId) return
    setBusyId(userId)
    try {
      await cambiarRol(userId, nuevoRol)
      toast.success('Rol actualizado')
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('Error al cambiar rol', { description: message })
    } finally {
      setBusyId(null)
    }
  }

  async function handleAprobado(userId: string, aprobado: boolean) {
    if (busyId) return
    // La RPC bloquea cambiar el estado de acceso PROPIO (auto-bloqueo /
    // auto-aprobación): la UI lo impide antes de intentar.
    if (userId === perfil?.id) {
      toast.error('Operación no permitida', {
        description: 'No puedes cambiar tu propio estado de acceso.',
      })
      return
    }
    setBusyId(userId)
    try {
      await cambiarAprobado(userId, aprobado)
      toast.success(aprobado ? 'Usuario aprobado' : 'Acceso revocado')
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('Error al cambiar estado', { description: message })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const targetId = deleteTarget.id
    const targetName = deleteTarget.nombre
    setDeleteTarget(null)
    try {
      // eliminarPerfil retorna aviso (string) si el usuario NO pudo borrarse de
      // Supabase Auth — en ese caso resucitaría como pendiente en el próximo login.
      const aviso = await eliminarPerfil(targetId)
      if (aviso) toast.warning(`Perfil de ${targetName} eliminado con observación`, { description: aviso, duration: 9000 })
      else toast.success(`Perfil de ${targetName} eliminado`)
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('Error al eliminar', { description: message })
    }
  }

  async function handleSendResetEmail(email: string) {
    try {
      // supabase-js v2 NO lanza: devuelve { data, error } — el catch nunca
      // corría y siempre se mostraba "Correo enviado" aunque fallara
      const { error } = await supabase.auth.resetPasswordForEmail(email)
      if (error) {
        toast.error('Error al enviar correo', { description: error.message })
        return
      }
      toast.success('Correo de recuperación enviado')
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('Error al enviar correo', { description: message })
    }
  }

  return (
    <div className="space-y-4">
      <Button onClick={load} variant="outline" className="gap-2">
        <RefreshCw className="h-4 w-4" />
        Actualizar lista
      </Button>

      {/* ── Vista desktop: tabla ── */}
      <div className="hidden md:block overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Nombre</TableHead>
              <TableHead className="min-w-[200px] max-w-[260px]">Correo</TableHead>
              <TableHead className="w-[160px]">Rol</TableHead>
              <TableHead className="w-[120px]">Estado</TableHead>
              {puedeGestionar && <TableHead className="w-[90px]">Permisos</TableHead>}
              {puedeGestionar && <TableHead className="w-[100px] text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {perfiles.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium truncate max-w-[180px]" title={p.nombre}>{p.nombre}</TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="block truncate max-w-[260px]" title={p.correo}>{p.correo}</span>
                </TableCell>
                <TableCell>
                  {puedeGestionar ? (
                    <Select
                      value={p.rol}
                      onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                      disabled={p.id === perfil?.id || busyId === p.id}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES_DISPONIBLES.map((r) => (
                          <SelectItem key={r.valor} value={r.valor}>{r.etiqueta}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={p.rol === 'admin' ? 'default' : 'secondary'}>
                      {ROL_LABEL[p.rol] ?? p.rol}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {puedeAprobar && p.id !== perfil?.id ? (
                    <Button
                      size="sm"
                      variant={p.aprobado ? 'outline' : 'default'}
                      onClick={() => handleAprobado(p.id, !p.aprobado)}
                      disabled={busyId === p.id}
                      className="gap-1"
                    >
                      <ShieldCheck className="h-3 w-3" />
                      {p.aprobado ? 'Aprobado' : 'Sin acceso'}
                    </Button>
                  ) : (
                    <Badge variant={p.aprobado ? 'default' : 'destructive'}>
                      {p.aprobado ? 'Aprobado' : 'Pendiente'}
                    </Badge>
                  )}
                </TableCell>
                {puedeGestionar && (
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPermisosTarget(p)}
                      className="gap-1"
                      title="Permisos granulares de este usuario"
                    >
                      <KeyRound className="h-3 w-3" />
                      {totalExcepciones(p) > 0 ? (
                        <span className="text-[10px] font-bold text-amber-600">{totalExcepciones(p)}</span>
                      ) : null}
                    </Button>
                  </TableCell>
                )}
                {puedeGestionar && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleSendResetEmail(p.correo)}
                        title="Enviar correo de recuperación"
                      >
                        <Mail className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteTarget(p)}
                        disabled={p.id === perfil?.id || !puedeEliminarUsuarios}
                        title={puedeEliminarUsuarios ? 'Eliminar perfil' : 'Sin permiso para eliminar usuarios'}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Vista móvil: tarjetas ── */}
      <div className="md:hidden space-y-3">
        {perfiles.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No hay usuarios registrados.
          </p>
        )}
        {perfiles.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border border-slate-200 bg-white p-4 space-y-3"
          >
            {/* Fila 1: nombre + estado */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900 truncate" title={p.nombre}>
                  {p.nombre}
                </p>
                <p className="text-sm text-slate-500 truncate" title={p.correo}>
                  {p.correo}
                </p>
              </div>
              {puedeAprobar && p.id !== perfil?.id ? (
                <Button
                  size="sm"
                  variant={p.aprobado ? 'outline' : 'default'}
                  onClick={() => handleAprobado(p.id, !p.aprobado)}
                  disabled={busyId === p.id}
                  className="shrink-0 gap-1"
                >
                  <ShieldCheck className="h-3 w-3" />
                  {p.aprobado ? 'Aprobado' : 'Sin acceso'}
                </Button>
              ) : (
                <Badge variant={p.aprobado ? 'default' : 'destructive'} className="shrink-0">
                  {p.aprobado ? 'Aprobado' : 'Pendiente'}
                </Badge>
              )}
            </div>

            {/* Fila 2: rol + acciones */}
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                {puedeGestionar ? (
                  <Select
                    value={p.rol}
                    onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                    disabled={p.id === perfil?.id || busyId === p.id}
                  >
                    <SelectTrigger className="w-full max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES_DISPONIBLES.map((r) => (
                        <SelectItem key={r.valor} value={r.valor}>{r.etiqueta}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant={p.rol === 'admin' ? 'default' : 'secondary'}>
                    {ROL_LABEL[p.rol] ?? p.rol}
                  </Badge>
                )}
              </div>
              {puedeGestionar && (
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setPermisosTarget(p)}
                    title="Permisos granulares de este usuario"
                  >
                    <KeyRound className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleSendResetEmail(p.correo)}
                    title="Enviar correo de recuperación"
                  >
                    <Mail className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setDeleteTarget(p)}
                    disabled={p.id === perfil?.id || !puedeEliminarUsuarios}
                    title={puedeEliminarUsuarios ? 'Eliminar perfil' : 'Sin permiso para eliminar usuarios'}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            {/* Fila 3 (opcional): excepciones activas */}
            {totalExcepciones(p) > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(p.permisosExtra ?? {}).map(([codigo, concedido]) => (
                  <Badge
                    key={codigo}
                    variant="outline"
                    className={`text-[9px] px-1 py-0 ${
                      concedido
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-rose-200 bg-rose-50 text-rose-700'
                    }`}
                  >
                    {concedido ? '+' : '−'} {etiquetaPermiso(codigo)}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Diálogo de permisos granulares ── */}
      <DialogoPermisos
        perfil={permisosTarget}
        open={!!permisosTarget}
        onOpenChange={(open) => { if (!open) setPermisosTarget(null) }}
        onChanged={() => { load().finally(() => refresh()) }}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar usuario</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de eliminar al usuario{' '}
              <strong>{deleteTarget?.nombre}</strong>? Se eliminará su perfil, roles,
              permisos y cuenta de acceso. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
