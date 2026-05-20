'use client'

import { useAuth } from '@/hooks/useAuth'
import { signOut, ROL_LABELS } from '@/lib/rackly/auth'
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
      <div className="hidden sm:flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{perfil.nombre}</span>
        <Badge
          variant={perfil.rol === 'admin' ? 'default' : 'secondary'}
          className="gap-1"
        >
          <Shield className="h-3 w-3" />
          {ROL_LABELS[perfil.rol]}
        </Badge>
      </div>
      <Button variant="outline" size="sm" onClick={handleLogout} className="gap-1">
        <LogOut className="h-4 w-4" />
        <span className="sm:hidden">Salir</span>
      </Button>
    </div>
  )
}
