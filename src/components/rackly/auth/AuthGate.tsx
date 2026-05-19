'use client'

import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  signIn,
  signUp,
  signOut,
  cambiarPasswordPropia,
} from '@/lib/rackly/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Warehouse, Clock, RefreshCw, KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { perfil, loading, refresh } = useAuth()

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </main>
    )
  }

  if (!perfil) return <LoginScreen onSuccess={refresh} />

  if (!perfil.aprobado)
    return <PendingApprovalScreen nombre={perfil.nombre} onRefresh={refresh} />

  if (perfil.mustChangePassword)
    return <ForceChangePasswordScreen onDone={refresh} />

  return <>{children}</>
}

function ForceChangePasswordScreen({
  onDone,
}: {
  onDone: () => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres')
      return
    }
    if (password !== confirm) {
      toast.error('Las contraseñas no coinciden')
      return
    }
    setBusy(true)
    try {
      await cambiarPasswordPropia(password)
      toast.success('Contraseña actualizada')
      await onDone()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo actualizar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Debes cambiar tu contraseña</CardTitle>
          <CardDescription>
            El administrador requiere que definas una nueva contraseña antes de
            continuar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fc-pass">Nueva contraseña</Label>
              <Input
                id="fc-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fc-pass2">Confirmar contraseña</Label>
              <Input
                id="fc-pass2"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar y continuar'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={async () => {
                await signOut()
                await onDone()
              }}
            >
              Cerrar sesión
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

function PendingApprovalScreen({
  nombre,
  onRefresh,
}: {
  nombre: string
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <Clock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Cuenta pendiente de aprobación</CardTitle>
          <CardDescription>
            Hola {nombre}, tu cuenta fue creada correctamente. Un administrador
            debe aprobar tu acceso antes de que puedas usar la aplicación.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full gap-2"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onRefresh()
                toast.info('Estado actualizado')
              } finally {
                setBusy(false)
              }
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Verificar estado
          </Button>
          <Button
            className="w-full"
            variant="ghost"
            onClick={async () => {
              await signOut()
              await onRefresh()
            }}
          >
            Cerrar sesión
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}

function LoginScreen({
  onSuccess,
}: {
  onSuccess: () => Promise<void>
}) {
  const [tab, setTab] = useState<'login' | 'signup'>('login')
  const [correo, setCorreo] = useState('')
  const [password, setPassword] = useState('')
  const [nombre, setNombre] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!correo.trim() || !password) {
      toast.error('Ingresa correo y contraseña')
      return
    }
    setBusy(true)
    try {
      await signIn(correo.trim().toLowerCase(), password)
      await onSuccess()
      toast.success('Sesión iniciada')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al iniciar sesión', { description: message })
    } finally {
      setBusy(false)
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (!correo.trim() || !password || !nombre.trim()) {
      toast.error('Completa todos los campos')
      return
    }
    if (password.length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres')
      return
    }
    setBusy(true)
    try {
      const data = await signUp(
        correo.trim().toLowerCase(),
        password,
        nombre.trim()
      )
      if (data.session) {
        await onSuccess()
        toast.success('Cuenta creada', {
          description: 'Un administrador debe aprobar tu acceso.',
        })
      } else {
        toast.success('Cuenta creada', {
          description:
            'Revisa tu correo para confirmar y luego inicia sesión.',
        })
        setTab('login')
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Error desconocido'
      if (message.toLowerCase().includes('already registered')) {
        toast.info('Esta cuenta ya existe', {
          description:
            'Inicia sesión con ese correo; si aún no accedes, un administrador debe aprobarla.',
        })
        setTab('login')
      } else {
        toast.error('No se pudo crear la cuenta', { description: message })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <Warehouse className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">RACKLY</CardTitle>
          <CardDescription>
            Sistema de Gestión de Almacenes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as 'login' | 'signup')}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Iniciar sesión</TabsTrigger>
              <TabsTrigger value="signup">Registrarse</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="mt-4">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="login-correo">Correo</Label>
                  <Input
                    id="login-correo"
                    type="email"
                    value={correo}
                    onChange={(e) => setCorreo(e.target.value)}
                    placeholder="usuario@empresa.com"
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-pass">Contraseña</Label>
                  <Input
                    id="login-pass"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Ingresando…' : 'Ingresar'}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup" className="mt-4">
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="su-nombre">Nombre completo</Label>
                  <Input
                    id="su-nombre"
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                    placeholder="Nombre y apellido"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="su-correo">Correo</Label>
                  <Input
                    id="su-correo"
                    type="email"
                    value={correo}
                    onChange={(e) => setCorreo(e.target.value)}
                    placeholder="usuario@empresa.com"
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="su-pass">Contraseña (mín. 6 caracteres)</Label>
                  <Input
                    id="su-pass"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Creando…' : 'Crear cuenta'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  )
}
