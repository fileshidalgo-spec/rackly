'use client'

import { useState, useEffect, useRef } from 'react'
import {
  getTodosLosPerfiles,
  cambiarRol,
  cambiarAprobado,
  eliminarPerfil,
  type Perfil,
  type Rol,
} from '@/lib/rackly/auth'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
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
import { toast } from 'sonner'
import {
  Users,
  Shield,
  ShieldCheck,
  Trash2,
  Mail,
  RefreshCw,
  Loader2,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

export function UsuariosTab() {
  const { perfil, refresh } = useAuth()
  const [perfiles, setPerfiles] = useState<Perfil[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Perfil | null>(null)

  const esAdmin = perfil?.rol === 'admin'
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeAprobar = esAdmin || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)

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
        <Table className="min-w-[600px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Nombre</TableHead>
              <TableHead className="min-w-[200px] max-w-[260px]">Correo</TableHead>
              <TableHead className="w-[160px]">Rol</TableHead>
              <TableHead className="w-[120px]">Estado</TableHead>
              {puedeAprobar && <TableHead className="w-[100px] text-right">Acciones</TableHead>}
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
                  {esAdmin ? (
                    <Select
                      value={p.rol}
                      onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                      disabled={p.id === perfil?.id || busyId === p.id}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="operario">Operario</SelectItem>
                        <SelectItem value="auxiliar">Auxiliar</SelectItem>
                        <SelectItem value="almacenero">Almacenero</SelectItem>
                        <SelectItem value="supervisor_almacen">Supervisor Almacén</SelectItem>
                        <SelectItem value="supervisor_operaciones">Supervisor Operaciones</SelectItem>
                        <SelectItem value="coordinador_operaciones">Coordinador Operaciones</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={p.rol === 'admin' ? 'default' : 'secondary'}>
                      {p.rol}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {puedeAprobar ? (
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
                {esAdmin && (
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
                        disabled={p.id === perfil?.id}
                        title="Eliminar perfil"
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
            className="rounded-lg border border-white/10 bg-slate-800/50 p-4 space-y-3"
          >
            {/* Fila 1: nombre + badge estado */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white truncate" title={p.nombre}>
                  {p.nombre}
                </p>
                <p className="text-sm text-slate-400 truncate" title={p.correo}>
                  {p.correo}
                </p>
              </div>
              {puedeAprobar ? (
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
                {esAdmin ? (
                  <Select
                    value={p.rol}
                    onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                    disabled={p.id === perfil?.id || busyId === p.id}
                  >
                    <SelectTrigger className="w-full max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="operario">Operario</SelectItem>
                      <SelectItem value="auxiliar">Auxiliar</SelectItem>
                      <SelectItem value="almacenero">Almacenero</SelectItem>
                      <SelectItem value="supervisor_almacen">Supervisor Almacén</SelectItem>
                      <SelectItem value="supervisor_operaciones">Supervisor Operaciones</SelectItem>
                      <SelectItem value="coordinador_operaciones">Coordinador Operaciones</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant={p.rol === 'admin' ? 'default' : 'secondary'}>
                    {p.rol}
                  </Badge>
                )}
              </div>
              {esAdmin && (
                <div className="flex gap-1 shrink-0">
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
                    disabled={p.id === perfil?.id}
                    title="Eliminar perfil"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar usuario</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de eliminar al usuario{' '}
              <strong>{deleteTarget?.nombre}</strong>? Se eliminará su perfil, roles y
              cuenta de acceso. Esta acción no se puede deshacer.
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
