'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  signIn,
  signUp,
  signOut,
  resetPassword,
  cambiarPasswordPropia,
  type Perfil,
} from '@/lib/rackly/auth'
import { supabase, dataClient } from '@/lib/supabase/client'
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
import {
  Warehouse,
  Clock,
  RefreshCw,
  KeyRound,
  Loader2,
  Eye,
  EyeOff,
  ArrowLeft,
  Mail,
} from 'lucide-react'
import { toast } from 'sonner'

/* ─── Utilidades de validación ─── */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254 // RFC 5321
const MAX_NOMBRE_LENGTH = 200

function validarEmail(email: string): string | null {
  if (!email.trim()) return 'Ingresa tu correo electrónico'
  if (email.length > MAX_EMAIL_LENGTH) return 'El correo es demasiado largo (máx. 254 caracteres)'
  if (!EMAIL_REGEX.test(email)) return 'El formato del correo no es válido (ej: usuario@empresa.com)'
  return null
}

function esErrorRateLimit(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('rate limit') ||
    lower.includes('too many') ||
    lower.includes('throttl') ||
    lower.includes('seguridad') ||
    lower.includes('espera') ||
    lower.includes('intenta')
}

function esErrorCorreoExistente(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('already registered') ||
    lower.includes('already been registered') ||
    lower.includes('user already exists') ||
    lower.includes('user_already_exists') ||
    lower.includes('identity already exists') ||
    lower.includes('identity_already_exists') ||
    lower.includes('to use a different email')
}

/**
 * Verifica si el correo ya está registrado EN SUPABASE AUTH.
 * Usa la Admin API para listar usuarios por email, que es más confiable
 * que consultar solo la tabla profiles (que puede tener registros huérfanos).
 */
const SUPABASE_URL_ADMIN = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY_ADMIN = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY

async function correoExisteEnAuth(email: string): Promise<boolean> {
  if (!SERVICE_ROLE_KEY_ADMIN) return false
  const lower = email.trim().toLowerCase()
  try {
    const res = await fetch(
      `${SUPABASE_URL_ADMIN}/auth/v1/admin/users?email=${encodeURIComponent(lower)}`,
      {
        headers: {
          'apikey': SERVICE_ROLE_KEY_ADMIN,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY_ADMIN}`,
        },
      }
    )
    if (!res.ok) return false
    const adminData = await res.json()
    return (adminData.users?.length ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Verifica si el correo tiene un perfil huérfano (existe en profiles
 * pero NO en Supabase Auth). Si es así, elimina el perfil para que el
 * usuario pueda registrarse normalmente.
 */
async function limpiarPerfilHuerfano(email: string): Promise<boolean> {
  const lower = email.trim().toLowerCase()
  try {
    const { data: perfil } = await dataClient
      .from('profiles')
      .select('id')
      .eq('correo', lower)
      .maybeSingle()
    if (!perfil) return false

    // Verificar si existe en Auth
    const existeEnAuth = await correoExisteEnAuth(lower)
    if (!existeEnAuth) {
      // Perfil huérfano: eliminarlo para permitir registro limpio
      console.log('[RACKLY] Limpiando perfil huérfano para:', lower)
      await dataClient.from('user_roles').delete().eq('user_id', perfil.id)
      await dataClient.from('profiles').delete().eq('id', perfil.id)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Verifica si el correo ya está registrado (en Auth o en profiles).
 * Prioriza la verificación en Auth (la fuente de verdad para login).
 */
async function correoYaExiste(email: string): Promise<boolean> {
  const lower = email.trim().toLowerCase()
  try {
    // Primero verificar si existe en Supabase Auth
    const existeAuth = await correoExisteEnAuth(lower)
    if (existeAuth) return true

    // Si no existe en Auth pero sí en profiles, es un perfil huérfano
    const { data } = await dataClient
      .from('profiles')
      .select('id')
      .eq('correo', lower)
      .maybeSingle()
    if (data) {
      // Limpiar el perfil huérfano silenciosamente
      console.log('[RACKLY] Correo con perfil huérfano detectado, limpiando:', lower)
      await dataClient.from('user_roles').delete().eq('user_id', data.id)
      await dataClient.from('profiles').delete().eq('id', data.id)
      // No bloquear el registro — se acaba de limpiar
      return false
    }

    return false
  } catch {
    // Si falla la consulta, permitir el registro (dejar que Supabase decida)
    return false
  }
}

/* ─── Componente auxiliar: campo contraseña con toggle de visibilidad ─── */
function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  className,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`pr-10 ${className ?? ''}`}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? 'Ocultar contraseña' : 'Ver contraseña'}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

/* ─── AuthGate principal ─── */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { perfil, loading, refresh, passwordRecovery, clearPasswordRecovery } =
    useAuth()

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </main>
    )
  }

  // Si viene del link de recuperación de contraseña, mostrar formulario
  if (passwordRecovery) {
    return <SetNewPasswordScreen onDone={async () => { clearPasswordRecovery(); return await refresh() }} />
  }

  if (!perfil) return <LoginScreen onSuccess={refresh} />

  if (!perfil.aprobado)
    return <PendingApprovalScreen nombre={perfil.nombre} onRefresh={refresh} />

  if (perfil.mustChangePassword)
    return <ForceChangePasswordScreen onDone={refresh} />

  return <>{children}</>
}

/* ─── Pantalla: establecer nueva contraseña (tras click en link de email) ─── */
function SetNewPasswordScreen({
  onDone,
}: {
  onDone: () => Promise<Perfil | null>
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
      // Primero intentar con updateUser (funciona con tokens del hash de la URL)
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      // Si hay sesión, también actualizar el flag en profiles
      try {
        const { data: u } = await supabase.auth.getUser()
        if (u?.user) {
          await supabase
            .from('profiles')
            .update({ must_change_password: false })
            .eq('id', u.user.id)
        }
      } catch {
        // no crítico
      }
      // Limpiar el hash de la URL
      window.location.hash = ''
      toast.success('Contraseña actualizada correctamente')
      try { await signOut() } catch { /* ok */ }
      await onDone()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      if (message.toLowerCase().includes('expired') || message.toLowerCase().includes('invalid')) {
        toast.error('Enlace expirado', {
          description: 'El enlace de recuperación ha expirado. Solicita uno nuevo desde "¿Olvidaste tu contraseña?".',
        })
      } else {
        toast.error('No se pudo actualizar la contraseña', {
          description: message,
        })
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
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Nueva contraseña</CardTitle>
          <CardDescription>
            Ingresa tu nueva contraseña. Debe tener al menos 6 caracteres.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rp-pass">Nueva contraseña</Label>
              <PasswordInput
                id="rp-pass"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-pass2">Confirmar contraseña</Label>
              <PasswordInput
                id="rp-pass2"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar y continuar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

/* ─── Pantalla: forzar cambio de contraseña ─── */
function ForceChangePasswordScreen({
  onDone,
}: {
  onDone: () => Promise<Perfil | null>
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
              <PasswordInput
                id="fc-pass"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fc-pass2">Confirmar contraseña</Label>
              <PasswordInput
                id="fc-pass2"
                value={confirm}
                onChange={setConfirm}
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
                try { await signOut() } catch { /* ok */ }
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

/* ─── Pantalla: cuenta pendiente de aprobación ─── */
function PendingApprovalScreen({
  nombre,
  onRefresh,
}: {
  nombre: string
  onRefresh: () => Promise<Perfil | null>
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

/* ─── Pantalla de recuperar contraseña (solicitar email) ─── */
function ForgotPasswordScreen({
  onBack,
}: {
  onBack: () => void
}) {
  const [correo, setCorreo] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!correo.trim()) {
      toast.error('Ingresa tu correo electrónico')
      return
    }
    setBusy(true)
    try {
      await resetPassword(correo.trim().toLowerCase())
      setSent(true)
      toast.success('Correo enviado', {
        description:
          'Revisa tu bandeja de entrada y haz clic en el enlace para crear tu nueva contraseña.',
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      if (esErrorRateLimit(message)) {
        toast.error('Demasiados intentos', {
          description: 'Por seguridad, espera 60 segundos antes de solicitar otro enlace.',
          duration: 8000,
        })
      } else {
        toast.error('No se pudo enviar el correo', { description: message })
      }
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <Mail className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>Revisa tu correo</CardTitle>
            <CardDescription>
              Enviamos un enlace a <strong>{correo}</strong> para que crees tu
              nueva contraseña. Revisa también la carpeta de spam o correo no
              deseado.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2"
              onClick={() => {
                setSent(false)
                setCorreo('')
              }}
            >
              Enviar de nuevo
            </Button>
            <Button
              type="button"
              className="w-full gap-2"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
              Volver al inicio de sesión
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Recuperar contraseña</CardTitle>
          <CardDescription>
            Ingresa tu correo electrónico y te enviaremos un enlace para crear
            una nueva contraseña.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fp-correo">Correo electrónico</Label>
              <Input
                id="fp-correo"
                type="email"
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="usuario@empresa.com"
                autoComplete="email"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar enlace de recuperación'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full gap-2"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
              Volver al inicio de sesión
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

/* ─── Pantalla de login / registro ─── */
function LoginScreen({
  onSuccess,
}: {
  onSuccess: () => Promise<Perfil | null>
}) {
  const [view, setView] = useState<'auth' | 'forgot'>('auth')
  const [tab, setTab] = useState<'login' | 'signup'>('login')
  const [correo, setCorreo] = useState('')
  const [password, setPassword] = useState('')
  const [nombre, setNombre] = useState('')
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [attempts, setAttempts] = useState(0)

  // Cooldown proactivo: tras cada error, un delay creciente antes del siguiente intento
  const COOLDOWN_AFTER_ERROR = 3  // 3s tras primer error, 6s tras segundo, etc.
  const MAX_COOLDOWN = 30

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!correo.trim() || !password) {
      toast.error('Ingresa correo y contraseña')
      return
    }
    const emailError = validarEmail(correo)
    if (emailError) {
      toast.error(emailError)
      return
    }
    if (cooldown > 0) {
      toast.error(`Espera ${cooldown} segundos antes de intentar de nuevo`)
      return
    }
    setBusy(true)
    try {
      await signIn(correo.trim().toLowerCase(), password)
      const perfil = await onSuccess()
      if (perfil) {
        toast.success('Sesión iniciada')
      } else {
        toast.error('No se pudo cargar tu perfil', {
          description: 'Intenta de nuevo o contacta al administrador.',
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      const newAttempts = attempts + 1
      setAttempts(newAttempts)
      if (esErrorRateLimit(message)) {
        toast.error('Demasiados intentos', {
          description: 'Por seguridad, espera 60 segundos antes de intentar de nuevo.',
          duration: 8000,
        })
        setCooldown(60)
      } else {
        toast.error('Error al iniciar sesión', { description: message })
        // Cooldown proactivo: delay creciente tras cada error para no saturar Supabase
        const cd = Math.min(COOLDOWN_AFTER_ERROR * newAttempts, MAX_COOLDOWN)
        if (cd > 0) setCooldown(cd)
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (!nombre.trim()) {
      toast.error('Ingresa tu nombre completo')
      return
    }
    if (nombre.trim().length > MAX_NOMBRE_LENGTH) {
      toast.error('El nombre es demasiado largo (máx. 200 caracteres)')
      return
    }
    const emailError = validarEmail(correo)
    if (emailError) {
      toast.error(emailError)
      return
    }
    if (password.length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres')
      return
    }
    if (cooldown > 0) {
      toast.error(`Espera ${cooldown} segundos antes de intentar de nuevo`)
      return
    }
    setBusy(true)
    try {
      // Pre-verificar si el correo ya existe para no quemar intentos del rate limit
      if (await correoYaExiste(correo)) {
        toast.info('Esta cuenta ya existe', {
          description:
            'Inicia sesión con ese correo; si aún no accedes, un administrador debe aprobarla.',
        })
        setTab('login')
        return
      }
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
      if (esErrorCorreoExistente(message)) {
        // Verificar si es un perfil huérfano (existe en Auth pero no en profiles)
        // o si es realmente una cuenta existente
        const correoLower = correo.trim().toLowerCase()
        const { data: perfil } = await dataClient
          .from('profiles')
          .select('id')
          .eq('correo', correoLower)
          .maybeSingle()

        if (!perfil) {
          // Existe en Auth pero no tiene perfil — intentar crear el perfil
          toast.info('Activando tu cuenta...', {
            description: 'Tu correo ya estaba registrado. Creando tu perfil.',
          })
          try {
            const { data: signInData } = await supabase.auth.signInWithPassword({
              email: correoLower,
              password,
            })
            if (signInData.session) {
              await onSuccess()
              toast.success('Cuenta activada', {
                description: 'Un administrador debe aprobar tu acceso.',
              })
            } else {
              toast.error('Contraseña incorrecta', {
                description:
                  'Tu correo ya está registrado pero la contraseña no coincide. Usa "Olvidaste tu contraseña" para restablecerla.',
              })
            }
          } catch {
            toast.error('No se pudo activar la cuenta', {
              description:
                'Tu correo ya está registrado. Si no recuerdas tu contraseña, usa "Olvidaste tu contraseña".',
            })
          }
        } else {
          toast.info('Esta cuenta ya existe', {
            description:
              'Inicia sesión con ese correo; si aún no accedes, un administrador debe aprobarla.',
          })
          setTab('login')
        }
      } else if (esErrorRateLimit(message)) {
        toast.error('Demasiados intentos de registro', {
          description: 'Por seguridad, espera 60 segundos antes de crear otra cuenta o intentar de nuevo.',
          duration: 8000,
        })
        setCooldown(60)
      } else {
        toast.error('No se pudo crear la cuenta', { description: message })
        // Cooldown proactivo tras error de registro
        const newAttempts = attempts + 1
        setAttempts(newAttempts)
        const cd = Math.min(COOLDOWN_AFTER_ERROR * newAttempts, MAX_COOLDOWN)
        if (cd > 0) setCooldown(cd)
      }
    } finally {
      setBusy(false)
    }
  }

  // Cooldown para prevenir intentos repetidos
  // Resetear contador de intentos cuando el cooldown termina
  useEffect(() => {
    if (cooldown <= 0) {
      setAttempts(0)
      return
    }
    const timer = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  // Vista de recuperar contraseña
  if (view === 'forgot') {
    return <ForgotPasswordScreen onBack={() => setView('auth')} />
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
                  <PasswordInput
                    id="login-pass"
                    value={password}
                    onChange={setPassword}
                    placeholder="Tu contraseña"
                    autoComplete="current-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy || cooldown > 0}>
                  {cooldown > 0 ? `Espera ${cooldown}s` : busy ? 'Ingresando…' : 'Ingresar'}
                </Button>
                {/* Link de recuperar contraseña */}
                <div className="text-center">
                  <button
                    type="button"
                    className="text-sm text-primary hover:underline"
                    onClick={() => setView('forgot')}
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
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
                  <PasswordInput
                    id="su-pass"
                    value={password}
                    onChange={setPassword}
                    placeholder="Mínimo 6 caracteres"
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy || cooldown > 0}>
                  {cooldown > 0 ? `Espera ${cooldown}s` : busy ? 'Creando…' : 'Crear cuenta'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  )
}
