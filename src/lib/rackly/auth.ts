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
async function confirmarEmailUsuario(userId: string): Promise<boolean> {
  if (!SERVICE_ROLE_KEY) {
    console.warn('[RACKLY] SERVICE_ROLE_KEY no configurada, no se puede auto-confirmar')
    return false
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
      return false
    }
    const data = await res.json()
    const confirmed = !!data.email_confirmed_at
    if (confirmed) {
      console.warn('[RACKLY] Email auto-confirmado para usuario', userId)
    } else {
      console.error('[RACKLY] Auto-confirmación no surtió efecto para', userId)
    }
    return confirmed
  } catch (err) {
    console.error('[RACKLY] Error en auto-confirmación:', err)
    return false
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
    const confirmed = await confirmarEmailUsuario(data.user.id)
    if (confirmed) {
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
  }

  return data
}

/**
 * Localiza un usuario de Supabase Auth por su email EXACTO usando la Admin API.
 *
 * IMPORTANTE: la Admin API IGNORA el parámetro `?email=` de GET /admin/users
 * (devuelve la primera página completa, sin filtrar). Por eso hay que paginar
 * y comparar el email lado cliente. Tomar `users[0]` de esa lista confirmaba
 * (o evaluaba) el email de un usuario ARBITRARIO, no del solicitado.
 *
 * Devuelve un tri-estado para que los llamadores NUNCA actúen sobre una
 * consulta fallida como si fuera un resultado definitivo:
 *   - 'encontrado'  → existe un usuario con ese email exacto (devuelve su id)
 *   - 'ausente'     → la consulta terminó bien y NO existe
 *   - 'error'       → la consulta falló (red, rate-limit, key ausente): no se sabe
 */
export type ResultadoBusquedaAuth =
  | { estado: 'encontrado'; id: string }
  | { estado: 'ausente' }
  | { estado: 'error' }

export async function buscarUsuarioEnAuth(correo: string): Promise<ResultadoBusquedaAuth> {
  const email = correo.trim().toLowerCase()
  if (!email || !SERVICE_ROLE_KEY) return { estado: 'error' }
  try {
    const PER_PAGE = 200
    const MAX_PAGES = 10 // hasta 2000 usuarios; el proyecto hoy tiene ~30
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          },
        }
      )
      if (!res.ok) return { estado: 'error' }
      const adminData = await res.json()
      const users: { id?: string; email?: string }[] = adminData.users ?? []
      const match = users.find((u) => u.email?.trim().toLowerCase() === email)
      if (match?.id) return { estado: 'encontrado', id: match.id }
      // Página incompleta = última página: el usuario no está en el listado
      if (users.length < PER_PAGE) return { estado: 'ausente' }
    }
    // Más de MAX_PAGES × PER_PAGE usuarios: tratar como no concluyente
    console.warn('[RACKLY] buscarUsuarioEnAuth: se agotaron las páginas de la Admin API')
    return { estado: 'error' }
  } catch (err) {
    console.error('[RACKLY] buscarUsuarioEnAuth error:', err)
    return { estado: 'error' }
  }
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
      console.warn('[RACKLY] Email no confirmado, intentando auto-confirmar vía Admin API...')
      try {
        // Localizar al usuario EXACTO por email (paginado + match exacto);
        // nunca usar users[0] de una consulta sin filtro real.
        const busqueda = await buscarUsuarioEnAuth(correo)
        if (busqueda.estado === 'encontrado') {
          const confirmed = await confirmarEmailUsuario(busqueda.id)
          if (confirmed) {
            // Reintentar login después de confirmar
            const retry = await supabase.auth.signInWithPassword({ email: correo, password })
            if (!retry.error) return retry.data
            console.error('[RACKLY] Login reintentado tras confirmar pero falló:', retry.error.message)
          } else {
            console.error('[RACKLY] No se pudo confirmar el email de', correo)
          }
        } else {
          console.error('[RACKLY] Usuario', correo, 'no localizable en Admin API (estado:', busqueda.estado, ')')
        }
      } catch (confirmErr) {
        console.error('[RACKLY] Error en auto-confirmación durante login:', confirmErr)
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
    // B-1 (auditoría): "Auth session missing" es el estado NORMAL al cargar
    // el login o tras cerrar sesión — no es un error; se degrada a info para
    // no acostumbrar a ignorar errores reales en la consola.
    if (userErr.message.includes('Auth session missing')) {
      console.info('[RACKLY] getUser: sin sesión activa (esperado en login/logout)')
    } else {
      console.error('[RACKLY] getUser error:', userErr.message)
    }
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
  // RPC ATÓMICA (cambiar_rol_usuario, migración 20261016_hardening): antes era
  // delete+insert desde el cliente — si el insert fallaba (red, restart), el
  // usuario quedaba SIN rol y getPerfilActual lo degradaba a 'operario' (un
  // admin afectado perdía permisos hasta corrección manual). La RPC es
  // SECURITY DEFINER con guard: service_role (la app) o admin autenticado.
  const { error } = await dataClient.rpc('cambiar_rol_usuario', {
    p_user_id: userId,
    p_rol: rol,
  })
  if (error) throw error
}

export async function eliminarPerfil(userId: string) {
  // 1. Eliminar rol
  const { error: delErr } = await dataClient.from('user_roles').delete().eq('user_id', userId)
  if (delErr) throw delErr
  // 2. Eliminar perfil
  const { error } = await dataClient
    .from('profiles')
    .delete()
    .eq('id', userId)
  if (error) throw error
  // 3. Eliminar usuario de Supabase Auth para que no pueda volver a loguearse
  if (SERVICE_ROLE_KEY) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
      })
      if (!res.ok) {
        console.error('[RACKLY] Error eliminando usuario Auth:', res.status, await res.text())
      }
    } catch (err) {
      console.error('[RACKLY] Error eliminando usuario Auth:', err)
    }
  }
}
