'use client'

import { supabase, dataClient } from '@/lib/supabase/client'
import { mensajeError } from './errores'

export type Rol = 'admin' | 'operario' | 'auxiliar' | 'almacenero' | 'supervisor_almacen' | 'supervisor_operaciones' | 'coordinador_operaciones'

export type Perfil = {
  id: string
  correo: string
  nombre: string
  rol: Rol
  aprobado: boolean
  mustChangePassword: boolean
  /** Overrides de permisos (excepciones al rol) — null si no se cargaron */
  permisosExtra?: Record<string, boolean> | null
}

/**
 * Convierte filas de user_permisos en el mapa de overrides de un usuario.
 * (user_id, permiso, concedido) → { [permiso]: concedido }
 */
function overridesDeFilas(
  filas: { user_id?: string; permiso: string; concedido: boolean }[],
  userId?: string
): Record<string, boolean> {
  const mapa: Record<string, boolean> = {}
  for (const f of filas) {
    if (userId && f.user_id !== userId) continue
    mapa[f.permiso] = f.concedido
  }
  return mapa
}

// FIX auditoría 2026-10-21 (P1): la service_role key ya NO se usa en el
// navegador. Las operaciones Admin de GoTrue (confirmar/eliminar usuario)
// van por la Edge Function `gestionar-usuario-auth` (la service key vive solo
// en el servidor de Supabase) y las verificaciones de existencia/orfandad por
// RPCs SECURITY DEFINER (correo_existe_en_auth / limpiar_perfil_huerfano).
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

/**
 * Llama a la Edge Function gestionar-usuario-auth con la sesión del usuario
 * (la función valida que el llamador sea admin antes de tocar GoTrue).
 */
async function llamarEdgeUsuario(
  accion: 'confirmar' | 'eliminar',
  payload: Record<string, string>
): Promise<{ ok: boolean; error?: string }> {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!SUPABASE_URL || !ANON_KEY || !token) return { ok: false, error: 'SIN_SESION' }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gestionar-usuario-auth`, {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accion, ...payload }),
    })
    const d = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) return { ok: false, error: String(d?.error ?? `HTTP ${res.status}`) }
    return { ok: true }
  } catch (err) {
    // mensajeError (lib/rackly/errores.ts): los errores de red/fetch pueden
    // llegar como objeto plano — String(err) los volvía "[object Object]".
    return { ok: false, error: mensajeError(err) }
  }
}

/**
 * Confirma el email de un usuario vía la Edge Function gestionar-usuario-auth
 * (requiere sesión admin activa; la service_role key ya no viaja al navegador).
 * Con mailer_autoconfirm=true los registros nuevos ya nacen confirmados: esta
 * función queda como red de seguridad para el fallback de login.
 */
async function confirmarEmailUsuario(userId: string): Promise<boolean> {
  const r = await llamarEdgeUsuario('confirmar', { userId })
  if (!r.ok) {
    console.error('[RACKLY] No se pudo confirmar el email vía Edge Function:', r.error)
    return false
  }
  return true
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
 * Localiza si un correo existe en Supabase Auth vía la RPC SECURITY DEFINER
 * `correo_existe_en_auth` (la fuente de verdad es auth.users, dentro de la BD).
 *
 * FIX auditoría 2026-10-21: ya no usa la Admin API del navegador (service key
 * fuera del bundle). Devuelve tri-estado: 'encontrado' | 'ausente' | 'error'.
 * El id ya no es necesario: los perfiles comparten id con auth.users.
 */
export type ResultadoBusquedaAuth =
  | { estado: 'encontrado'; id: string }
  | { estado: 'ausente' }
  | { estado: 'error' }

export async function buscarUsuarioEnAuth(correo: string): Promise<ResultadoBusquedaAuth> {
  const email = correo.trim().toLowerCase()
  if (!email) return { estado: 'error' }
  try {
    const { data, error } = await supabase.rpc('correo_existe_en_auth', { p_correo: email })
    if (error) {
      console.error('[RACKLY] correo_existe_en_auth error:', error.message)
      return { estado: 'error' }
    }
    return data ? { estado: 'encontrado', id: '' } : { estado: 'ausente' }
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
    // Si el error es por email no confirmado, intentar auto-confirmar y reintentar.
    // FIX auditoría 2026-10-30 (K1): la vía anterior estaba DOBLEMENTE rota —
    //   · buscarUsuarioEnAuth() ya no devuelve id (devolvía id:''), y
    //   · la Edge Function gestionar-usuario-auth exige sesión ADMIN, que NO
    //     existe durante el login (el usuario aún no entra).
    // La RPC confirmar_correo_en_auth(correo, password) es SECURITY DEFINER,
    // verifica bcrypt(correo+password) contra auth.users y SOLO entonces
    // confirma: sin la contraseña correcta no se confirma nada (E2E probado:
    // correcta→true · incorrecta→false · inexistente→false).
    const msg = error.message.toLowerCase()
    if (msg.includes('email not confirmed') || msg.includes('not confirmed')) {
      console.warn('[RACKLY] Email no confirmado: auto-confirmación con prueba de contraseña (RPC)...')
      try {
        const { data: confirmed, error: errRpc } = await supabase.rpc('confirmar_correo_en_auth', {
          p_correo: correo.trim().toLowerCase(),
          p_password: password,
        })
        if (!errRpc && confirmed === true) {
          // Reintentar login después de confirmar
          const retry = await supabase.auth.signInWithPassword({ email: correo, password })
          if (!retry.error) return retry.data
          console.error('[RACKLY] Login reintentado tras confirmar pero falló:', retry.error.message)
        } else {
          console.error('[RACKLY] No se pudo confirmar el email de', correo, '(credenciales no verificadas)')
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

  const [perfilRes, rolesRes, permisosRes] = await Promise.all([
    dataClient
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .eq('id', u.user.id)
      .maybeSingle(),
    dataClient.from('user_roles').select('role').eq('user_id', u.user.id),
    // Overrides propios (la política RLS permite leer los propios)
    dataClient
      .from('user_permisos')
      .select('permiso, concedido')
      .eq('user_id', u.user.id),
  ])

  if (perfilRes.error) {
    console.error('[RACKLY] profiles query error:', perfilRes.error.message)
  }
  if (rolesRes.error) {
    console.error('[RACKLY] user_roles query error:', rolesRes.error.message)
  }
  if (permisosRes.error) {
    // No es crítico: sin overrides la app cae al valor por defecto del rol
    console.warn('[RACKLY] user_permisos query (no crítico):', permisosRes.error.message)
  }

  const perfil = perfilRes.data
  const roles = rolesRes.data
  const overrides = overridesDeFilas(permisosRes.data ?? [])

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
      permisosExtra: overrides,
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
    permisosExtra: esAdmin ? null : overrides, // admin: sin overrides (siempre todo)
  }
}

export async function getTodosLosPerfiles(): Promise<Perfil[]> {
  const [perfilesRes, rolesRes, permisosRes] = await Promise.all([
    dataClient
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .order('nombre'),
    dataClient.from('user_roles').select('user_id, role'),
    // Overrides de todos (la RLS devuelve los propios si el caller no es
    // gestor: la lista sigue sirviendo para filtros de actividad)
    dataClient.from('user_permisos').select('user_id, permiso, concedido'),
  ])
  if (perfilesRes.error) throw perfilesRes.error
  if (rolesRes.error) throw rolesRes.error
  // No crítico: un no-gestor solo recibirá sus propias filas (RLS)
  if (permisosRes.error) {
    console.warn('[RACKLY] user_permisos global (no crítico):', permisosRes.error.message)
  }
  const perfiles = perfilesRes.data ?? []
  const roles = rolesRes.data ?? []
  const roleMap = new Map<string, Rol>()
  for (const r of roles as { user_id: string; role: string }[]) {
    // Mantener admin si existe, sino el primer rol no-admin encontrado
    if (r.role === 'admin' || !roleMap.has(r.user_id)) {
      roleMap.set(r.user_id, r.role as Rol)
    }
  }
  // Overrides por usuario (solo filas de usuarios NO admin: los admin no
  // admiten excepciones y su mapa se queda en null)
  const overridesPorUsuario = new Map<string, Record<string, boolean>>()
  for (const f of (permisosRes.data ?? []) as { user_id: string; permiso: string; concedido: boolean }[]) {
    const mapa = overridesPorUsuario.get(f.user_id) ?? {}
    mapa[f.permiso] = f.concedido
    overridesPorUsuario.set(f.user_id, mapa)
  }
  return perfiles.map((p: Record<string, unknown>) => {
    const rol = roleMap.get(p.id as string) ?? ('operario' as const)
    return {
      id: p.id as string,
      correo: p.correo as string,
      nombre: p.nombre as string,
      rol,
      aprobado: (p.aprobado as boolean) ?? false,
      mustChangePassword: (p.must_change_password as boolean) ?? false,
      permisosExtra: rol === 'admin' ? null : overridesPorUsuario.get(p.id as string) ?? null,
    }
  })
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
  // RPC SECURITY DEFINER con guard por permiso (usuarios.aprobar) — ver
  // migración 20261031_permisos_por_usuario.sql. La RPC además bloquea
  // cambiar el estado de acceso PROPIO (ni auto-aprobarse ni auto-bloquearse).
  const { error } = await dataClient.rpc('aprobar_usuario', {
    p_user_id: userId,
    p_aprobado: aprobado,
  })
  if (error) throw error
}

/**
 * Establece (o retira) el OVERRIDE de un permiso para un usuario concreto.
 *
 *   p_concedido = true/false → guarda la excepción (gana al rol).
 *   p_concedido = null       → borra el override (vuelve al valor del rol).
 *
 * RPC SECURITY DEFINER `establecer_permiso_usuario` (guard: admin o quien
 * tenga usuarios.gestionar_roles; los admin NO admiten overrides).
 */
export async function establecerPermisoUsuario(
  userId: string,
  permiso: string,
  concedido: boolean | null
): Promise<void> {
  const { error } = await dataClient.rpc('establecer_permiso_usuario', {
    p_user_id: userId,
    p_permiso: permiso,
    p_concedido: concedido,
  })
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

export async function eliminarPerfil(userId: string): Promise<string | null> {
  // 1. Filas en BD (user_roles + profiles) vía RPC atómica con guard admin.
  //    FIX auditoría 2026-10-21: antes era delete directo con service_role;
  //    con el cliente anon las políticas de profiles/user_roles lo impedían.
  const { error } = await dataClient.rpc('eliminar_usuario', { p_user_id: userId })
  if (error) throw error

  // 2. Eliminar usuario de Supabase Auth para que no pueda volver a loguearse.
  //    Va por la Edge Function (admin-only): si falla, se avisa a la UI para
  //    que el admin lo elimine desde el panel de Supabase Auth (mismo aviso
  //    del flujo anterior).
  const r = await llamarEdgeUsuario('eliminar', { userId })
  if (!r.ok) {
    console.error('[RACKLY] Error eliminando usuario Auth (Edge):', r.error)
    return `El perfil se eliminó, pero NO se pudo eliminar el usuario de Autenticación (${r.error ?? 'error de red'}). Podría volver a aparecer como pendiente — elimínalo desde el panel de Supabase Auth.`
  }
  return null
}
