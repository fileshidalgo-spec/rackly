'use client'

import { supabase, dataClient } from '@/lib/supabase/client'

export type Rol = 'admin' | 'operario' | 'auxiliar' | 'almacenero' | 'supervisor_almacen' | 'supervisor_operaciones' | 'coordinador_operaciones'

export type Perfil = {
  id: string
  correo: string
  nombre: string
  rol: Rol
  aprobado: boolean
  mustChangePassword: boolean
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY

/**
 * Confirma el email de un usuario recién registrado usando la GoTrue Admin API.
 * Esto permite que los usuarios accedan inmediatamente sin necesitar confirmar
 * su correo por email (Supabase tiene mailer_autoconfirm=false).
 */
async function confirmarEmailUsuario(userId: string): Promise<void> {
  if (!SERVICE_ROLE_KEY) {
    console.warn('[RACKLY] SERVICE_ROLE_KEY no configurada, no se puede auto-confirmar')
    return
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email_confirm: true }),
    })
    if (!res.ok) {
      console.error('[RACKLY] Error auto-confirmando email:', res.status, await res.text())
    } else {
      console.warn('[RACKLY] Email auto-confirmado para nuevo usuario')
    }
  } catch (err) {
    console.error('[RACKLY] Error en auto-confirmación:', err)
  }
}

export async function signUp(correo: string, password: string, nombre: string) {
  const redirectUrl = `${window.location.origin}/`
  const { data, error } = await supabase.auth.signUp({
    email: correo,
    password,
    options: {
      emailRedirectTo: redirectUrl,
      data: { nombre },
    },
  })
  if (error) throw error

  // Si Supabase requiere confirmación de email (no hay sesión),
  // auto-confirmar usando la Admin API para que el usuario pueda acceder de inmediato
  if (!data.session && data.user) {
    await confirmarEmailUsuario(data.user.id)
    // Intentar obtener la sesión después de confirmar
    try {
      const { data: signInData } = await supabase.auth.signInWithPassword({
        email: correo,
        password,
      })
      if (signInData.session) {
        return { ...data, session: signInData.session, user: signInData.user }
      }
    } catch {
      // Si falla el login automático, continuar con el flujo normal
    }
  }

  return data
}

export async function signIn(correo: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: correo,
    password,
  })
  if (error) {
    // Si el error es por email no confirmado, intentar auto-confirmar y reintentar
    const msg = error.message.toLowerCase()
    if (msg.includes('email not confirmed') || msg.includes('not confirmed')) {
      console.warn('[RACKLY] Intentando auto-confirmar email (usuario sin sesión)')
      // Obtener el user_id desde admin API
      if (SERVICE_ROLE_KEY) {
        try {
          const adminRes = await fetch(
            `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(correo)}`,
            {
              headers: {
                'apikey': SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
              },
            }
          )
          const adminData = await adminRes.json()
          const user = adminData.users?.[0]
          if (user?.id) {
            await confirmarEmailUsuario(user.id)
            // Reintentar login
            const retry = await supabase.auth.signInWithPassword({ email: correo, password })
            if (!retry.error) return retry.data
          }
        } catch {
          // Si falla, lanzar el error original
        }
      }
    }
    throw error
  }
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function resetPassword(correo: string) {
  const redirectTo = `${window.location.origin}/`
  const { data, error } = await supabase.auth.resetPasswordForEmail(correo, {
    redirectTo,
  })
  if (error) throw error
  return data
}

export async function getPerfilActual(): Promise<Perfil | null> {
  const {
    data: u,
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr) {
    console.error('[RACKLY] getUser error:', userErr.message)
    return null
  }
  if (!u?.user) return null

  const [perfilRes, rolesRes] = await Promise.all([
    dataClient
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .eq('id', u.user.id)
      .maybeSingle(),
    dataClient.from('user_roles').select('role').eq('user_id', u.user.id),
  ])

  if (perfilRes.error) {
    console.error('[RACKLY] profiles query error:', perfilRes.error.message)
  }
  if (rolesRes.error) {
    console.error('[RACKLY] user_roles query error:', rolesRes.error.message)
  }

  const perfil = perfilRes.data
  const roles = rolesRes.data

  if (!perfil) {
    const nombre =
      (u.user.user_metadata?.nombre as string | undefined)?.trim() ||
      u.user.email?.split('@')[0] ||
      'Usuario'
    const { data: perfilCreado, error: upsertErr } = await dataClient
      .from('profiles')
      .upsert(
        { id: u.user.id, correo: u.user.email ?? '', nombre, aprobado: false },
        { onConflict: 'id' }
      )
      .select('id, correo, nombre, aprobado, must_change_password')
      .maybeSingle()
    if (upsertErr) {
      console.error('[RACKLY] profile upsert error:', upsertErr.message)
    }
    if (!perfilCreado) return null
    return {
      id: perfilCreado.id,
      correo: perfilCreado.correo,
      nombre: perfilCreado.nombre,
      rol: 'operario',
      aprobado: perfilCreado.aprobado ?? false,
      mustChangePassword: perfilCreado.must_change_password ?? false,
    }
  }

  const esAdmin = (roles ?? []).some((r: { role: string }) => r.role === 'admin')
  const userRole = (roles ?? []).map((r: { role: string }) => r.role).find((role: string) => role !== 'admin')
  const effectiveRole: Rol = esAdmin ? 'admin' : (userRole as Rol) || 'operario'
  return {
    id: perfil.id,
    correo: perfil.correo,
    nombre: perfil.nombre,
    rol: effectiveRole,
    aprobado: perfil.aprobado ?? false,
    mustChangePassword: perfil.must_change_password ?? false,
  }
}

export async function getTodosLosPerfiles(): Promise<Perfil[]> {
  const [perfilesRes, rolesRes] = await Promise.all([
    dataClient
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .order('nombre'),
    dataClient.from('user_roles').select('user_id, role'),
  ])
  if (perfilesRes.error) throw perfilesRes.error
  if (rolesRes.error) throw rolesRes.error
  const perfiles = perfilesRes.data ?? []
  const roles = rolesRes.data ?? []
  const roleMap = new Map<string, Rol>()
  for (const r of roles as { user_id: string; role: string }[]) {
    // Mantener admin si existe, sino el primer rol no-admin encontrado
    if (r.role === 'admin' || !roleMap.has(r.user_id)) {
      roleMap.set(r.user_id, r.role as Rol)
    }
  }
  return perfiles.map((p: Record<string, unknown>) => ({
    id: p.id as string,
    correo: p.correo as string,
    nombre: p.nombre as string,
    rol: roleMap.get(p.id as string) ?? ('operario' as const),
    aprobado: (p.aprobado as boolean) ?? false,
    mustChangePassword: (p.must_change_password as boolean) ?? false,
  }))
}

export async function cambiarPasswordPropia(nuevaPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: nuevaPassword })
  if (error) throw error
  const { data: u } = await supabase.auth.getUser()
  if (u?.user) {
    await dataClient
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', u.user.id)
  }
}

export async function cambiarAprobado(userId: string, aprobado: boolean) {
  const { error } = await dataClient
    .from('profiles')
    .update({ aprobado })
    .eq('id', userId)
  if (error) throw error
}

export async function cambiarRol(userId: string, rol: Rol) {
  const { error: delErr } = await dataClient.from('user_roles').delete().eq('user_id', userId)
  if (delErr) throw delErr
  const { error } = await dataClient
    .from('user_roles')
    .insert({ user_id: userId, role: rol })
  if (error) throw error
}

export async function eliminarPerfil(userId: string) {
  const { error: delErr } = await dataClient.from('user_roles').delete().eq('user_id', userId)
  if (delErr) throw delErr
  const { error } = await dataClient
    .from('profiles')
    .delete()
    .eq('id', userId)
  if (error) throw error
}
