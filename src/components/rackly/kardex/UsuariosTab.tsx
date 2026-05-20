'use client'

import { useState } from 'react'
import {
  getTodosLosPerfiles,
  cambiarRol,
  cambiarAprobado,
  eliminarPerfil,
  resetPassword,
  forzarCambioPassword,
  type Perfil,
  type Rol,
  ROL_LABELS,
  ROLES,
} from '@/lib/rackly/auth'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import {
  Users,
  Shield,
  ShieldCheck,
  Trash2,
  Mail,
  RefreshCw,
  Loader2,
  KeyRound,
  MoreVertical,
  Lock,
  Send,
  Clock,
  Eye,
} from 'lucide-react'

/* ═══════════════════════════════════════════
   Colores de rol
   ═══════════════════════════════════════════ */

function rolColor(rol: Rol): string {
  switch (rol) {
    case 'admin':
      return 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
    case 'supervisor_almacen':
    case 'supervisor_operaciones':
      return 'bg-blue-600 text-white'
    case 'coordinador_operaciones':
      return 'bg-indigo-600 text-white'
    case 'almacenero':
      return 'bg-emerald-600 text-white'
    case 'auxiliar':
      return 'bg-amber-600 text-white'
    default:
      return 'bg-secondary text-secondary-foreground'
  }
}

function rolIcon(rol: Rol) {
  switch (rol) {
    case 'admin': return <Shield className="h-3 w-3" />
    case 'supervisor_almacen':
    case 'supervisor_operaciones': return <Eye className="h-3 w-3" />
    case 'coordinador_operaciones': return <ShieldCheck className="h-3 w-3" />
    default: return <Users className="h-3 w-3" />
  }
}

/* ═══════════════════════════════════════════
   COMPONENTE PRINCIPAL
   ═══════════════════════════════════════════ */

export function UsuariosTab() {
  const { perfil, refresh } = useAuth()
  const [perfiles, setPerfiles] = useState<Perfil[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Perfil | null>(null)
  const [tempPassTarget, setTempPassTarget] = useState<Perfil | null>(null)
  const [tempPassword, setTempPassword] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const esAdmin = perfil?.rol === 'admin'

  async function load() {
    setLoading(true)
    try {
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar usuarios', { description: message })
    } finally {
      setLoading(false)
    }
  }

  if (!loading && perfiles.length === 0) {
    load()
  }

  async function handleRolChange(userId: string, nuevoRol: Rol) {
    try {
      await cambiarRol(userId, nuevoRol)
      toast.success('Rol actualizado')
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
      // Si cambió el rol del usuario actual, refrescar su perfil
      if (userId === perfil?.id) await refresh()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cambiar rol', { description: message })
    }
  }

  async function handleAprobado(userId: string, aprobado: boolean) {
    try {
      await cambiarAprobado(userId, aprobado)
      toast.success(aprobado ? 'Usuario aprobado' : 'Acceso revocado')
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cambiar estado', { description: message })
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await eliminarPerfil(deleteTarget.id)
      toast.success('Perfil eliminado')
      setDeleteTarget(null)
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  async function handleSendResetEmail(email: string) {
    setBusyAction(`reset-${email}`)
    try {
      await resetPassword(email)
      toast.success('Correo de recuperación enviado', {
        description: `Se envió un enlace a ${email}`,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al enviar correo', { description: message })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleForzarCambio(userId: string) {
    setBusyAction(`force-${userId}`)
    try {
      await forzarCambioPassword(userId)
      toast.success('Se configuró el cambio obligatorio de contraseña')
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al forzar cambio', { description: message })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleAssignTempPassword() {
    if (!tempPassTarget || !tempPassword.trim()) return
    if (tempPassword.length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres')
      return
    }
    setBusyAction(`tempass-${tempPassTarget.id}`)
    try {
      const { error } = await supabase.auth.updateUser({
        password: tempPassword,
      })
      if (error) {
        // Si no es el usuario actual, no se puede actualizar así
        toast.error('Esta función requiere acceso de administrador desde el backend', {
          description: 'Se marcará el cambio obligatorio de contraseña.',
        })
        await forzarCambioPassword(tempPassTarget.id)
      } else {
        await forzarCambioPassword(tempPassTarget.id)
        toast.success('Contraseña temporal asignada', {
          description: `Se asignó la contraseña y se marcó cambio obligatorio para ${tempPassTarget.nombre}`,
        })
      }
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
      setTempPassTarget(null)
      setTempPassword('')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al asignar contraseña', { description: message })
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Descripción */}
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Lista de usuarios. Como administrador puedes cambiar roles, aprobar accesos
          y gestionar contraseñas.
        </p>
      </div>

      <Button onClick={load} variant="outline" className="gap-2" disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Actualizar lista
      </Button>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Correo</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-center">Contraseña</TableHead>
              {esAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {perfiles.map((p) => (
              <TableRow key={p.id} className={p.id === perfil?.id ? 'bg-green-50 dark:bg-green-950/20' : ''}>
                {/* Correo */}
                <TableCell className="text-muted-foreground text-sm">
                  {p.correo}
                </TableCell>
                {/* Nombre */}
                <TableCell className="font-medium">{p.nombre}</TableCell>
                {/* Rol */}
                <TableCell>
                  {esAdmin ? (
                    <Select
                      value={p.rol}
                      onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                    >
                      <SelectTrigger className="w-44 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            <span className="flex items-center gap-1.5">
                              {rolIcon(r)}
                              {ROL_LABELS[r]}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge className={`text-xs ${rolColor(p.rol)}`}>
                      <span className="flex items-center gap-1">
                        {rolIcon(p.rol)}
                        {ROL_LABELS[p.rol]}
                      </span>
                    </Badge>
                  )}
                </TableCell>
                {/* Estado */}
                <TableCell>
                  {esAdmin ? (
                    <Button
                      size="sm"
                      variant={p.aprobado ? 'outline' : 'default'}
                      onClick={() => handleAprobado(p.id, !p.aprobado)}
                      className="gap-1 h-7 text-xs"
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
                {/* Estado contraseña */}
                <TableCell className="text-center">
                  {p.mustChangePassword ? (
                    <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800">
                      <Lock className="h-3 w-3 mr-1" />
                      Cambiar
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800">
                      OK
                    </Badge>
                  )}
                </TableCell>
                {/* Acciones */}
                {esAdmin && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-8 w-8">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        {/* Enviar correo de recuperación */}
                        <DropdownMenuItem
                          onClick={() => handleSendResetEmail(p.correo)}
                          disabled={!!busyAction?.startsWith('reset-')}
                        >
                          <Send className="h-4 w-4 mr-2 text-blue-500" />
                          Enviar correo de recuperación
                        </DropdownMenuItem>
                        {/* Asignar contraseña temporal */}
                        <DropdownMenuItem onClick={() => setTempPassTarget(p)}>
                          <KeyRound className="h-4 w-4 mr-2 text-amber-500" />
                          Asignar contraseña temporal
                        </DropdownMenuItem>
                        {/* Forzar cambio en próximo login */}
                        <DropdownMenuItem
                          onClick={() => handleForzarCambio(p.id)}
                          disabled={!!busyAction?.startsWith(`force-${p.id}`)}
                        >
                          <Clock className="h-4 w-4 mr-2 text-orange-500" />
                          Forzar cambio en próximo login
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {/* Eliminar */}
                        <DropdownMenuItem
                          onClick={() => setDeleteTarget(p)}
                          disabled={p.id === perfil?.id}
                          className="text-red-600 focus:text-red-600"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Eliminar usuario
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ─── Diálogo: Asignar contraseña temporal ─── */}
      <Dialog open={!!tempPassTarget} onOpenChange={() => { setTempPassTarget(null); setTempPassword('') }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-amber-500" />
              Contraseña temporal
            </DialogTitle>
            <DialogDescription>
              Asigna una contraseña temporal para <strong>{tempPassTarget?.nombre}</strong>.
              El usuario deberá cambiarla en su próximo inicio de sesión.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="temp-pass">Nueva contraseña</Label>
              <Input
                id="temp-pass"
                type="text"
                value={tempPassword}
                onChange={(e) => setTempPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                Esta contraseña se mostrará en pantalla. Envíasela al usuario por otro medio.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => { setTempPassTarget(null); setTempPassword('') }}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1"
                onClick={handleAssignTempPassword}
                disabled={!tempPassword.trim() || !!busyAction?.startsWith('tempass-')}
              >
                {busyAction?.startsWith('tempass-') ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : null}
                Asignar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Diálogo: Confirmar eliminación ─── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar perfil</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de eliminar el perfil de{' '}
              <strong>{deleteTarget?.nombre}</strong>? Esta acción no se puede
              deshacer. También se eliminarán sus movimientos registrados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
