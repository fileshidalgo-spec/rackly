'use client'

import { useState } from 'react'
import {
  getTodosLosPerfiles,
  cambiarRol,
  cambiarAprobado,
  eliminarPerfil,
  type Perfil,
  type Rol,
} from '@/lib/rackly/auth'
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

export function UsuariosTab() {
  const { perfil, refresh } = useAuth()
  const [perfiles, setPerfiles] = useState<Perfil[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Perfil | null>(null)

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
    try {
      await supabase.auth.resetPasswordForEmail(email)
      toast.success('Correo de recuperación enviado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al enviar correo', { description: message })
    }
  }

  return (
    <div className="space-y-4">
      <Button onClick={load} variant="outline" className="gap-2">
        <RefreshCw className="h-4 w-4" />
        Actualizar lista
      </Button>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Correo</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Estado</TableHead>
              {esAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {perfiles.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.nombre}</TableCell>
                <TableCell className="text-muted-foreground">
                  {p.correo}
                </TableCell>
                <TableCell>
                  {esAdmin ? (
                    <Select
                      value={p.rol}
                      onValueChange={(v) => handleRolChange(p.id, v as Rol)}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">
                          <span className="flex items-center gap-1">
                            <Shield className="h-3 w-3" /> Admin
                          </span>
                        </SelectItem>
                        <SelectItem value="operario">
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" /> Operario
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={p.rol === 'admin' ? 'default' : 'secondary'}>
                      {p.rol}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {esAdmin ? (
                    <Button
                      size="sm"
                      variant={p.aprobado ? 'outline' : 'default'}
                      onClick={() => handleAprobado(p.id, !p.aprobado)}
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

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar perfil</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de eliminar el perfil de{' '}
              <strong>{deleteTarget?.nombre}</strong>? Esta acción no se puede
              deshacer.
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
