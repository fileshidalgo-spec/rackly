'use client'

import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { signOut, signOutOtrosDispositivos } from '@/lib/rackly/auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { LogOut, MonitorSmartphone, Shield, User } from 'lucide-react'
import { toast } from 'sonner'

export function SesionBar() {
  const { perfil, refresh } = useAuth()
  const [cerrandoOtros, setCerrandoOtros] = useState(false)
  const [dialogOtros, setDialogOtros] = useState(false)

  if (!perfil) return null

  async function handleLogout() {
    try {
      await signOut()
      await refresh()
    } catch {
      toast.error('Error al cerrar sesión')
    }
  }

  async function handleCerrarOtros() {
    setCerrandoOtros(true)
    try {
      await signOutOtrosDispositivos()
      toast.success(
        'Sesiones cerradas en los otros equipos. Este equipo mantiene su sesión activa.'
      )
      setDialogOtros(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido'
      toast.error(`No se pudo cerrar las otras sesiones: ${msg}`)
    } finally {
      setCerrandoOtros(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex items-center gap-2 text-sm min-w-0 max-w-[240px]">
        <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
          <User className="h-3.5 w-3.5 text-indigo-300" />
        </div>
        <span className="font-semibold text-white truncate" title={perfil.nombre}>{perfil.nombre}</span>
        <Badge className="bg-white/15 text-indigo-200 border-white/10 hover:bg-white/20 font-medium text-[10px] gap-1">
          <Shield className="h-2.5 w-2.5" />
          {perfil.rol}
        </Badge>
      </div>
      <AlertDialog open={dialogOtros} onOpenChange={setDialogOtros}>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={cerrandoOtros}
            title="Cerrar sesión en otros equipos (este equipo mantiene su sesión)"
            className="gap-1 text-slate-400 hover:text-white hover:bg-white/10"
          >
            <MonitorSmartphone className="h-4 w-4" />
            <span className="sm:hidden text-xs">Otros equipos</span>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cerrar las sesiones abiertas en otros equipos?</AlertDialogTitle>
            <AlertDialogDescription>
              Este equipo mantiene su sesión activa. Las demás computadoras quedarán fuera en
              cuanto intenten continuar (máximo 1 hora, cuando su sesión deje de renovarse).
              Úsalo si dejaste la sesión abierta en otro equipo o sospechas de un acceso ajeno.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cerrandoOtros}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={cerrandoOtros}
              onClick={(e) => {
                e.preventDefault()
                handleCerrarOtros()
              }}
            >
              {cerrandoOtros ? 'Cerrando…' : 'Sí, cerrar otras sesiones'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleLogout}
        className="gap-1 text-slate-400 hover:text-white hover:bg-white/10"
      >
        <LogOut className="h-4 w-4" />
        <span className="sm:hidden text-xs">Salir</span>
      </Button>
    </div>
  )
}
