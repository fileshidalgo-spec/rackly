'use client'

import { useAuth } from '@/hooks/useAuth'
import { signOut } from '@/lib/rackly/auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LogOut, Shield, User } from 'lucide-react'
import { toast } from 'sonner'

export function SesionBar() {
  const { perfil, refresh } = useAuth()

  if (!perfil) return null

  async function handleLogout() {
    try {
      await signOut()
      await refresh()
    } catch {
      toast.error('Error al cerrar sesión')
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
