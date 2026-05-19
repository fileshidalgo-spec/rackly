'use client'

import { supabase } from '@/lib/supabase/client'

export type Rol = 'admin' | 'operario'

export type Perfil = {
  id: string
  correo: string
  nombre: string
  rol: Rol
  aprobado: boolean
  mustChangePassword: boolean
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
  return data
}

export async function signIn(correo: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: correo,
    password,
  })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
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
    supabase
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .eq('id', u.user.id)
      .maybeSingle(),
    supabase.from('user_roles').select('role').eq('user_id', u.user.id),
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
    const { data: perfilCreado, error: upsertErr } = await supabase
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
  return {
    id: perfil.id,
    correo: perfil.correo,
    nombre: perfil.nombre,
    rol: esAdmin ? 'admin' : 'operario',
    aprobado: perfil.aprobado ?? false,
    mustChangePassword: perfil.must_change_password ?? false,
  }
}

export async function getTodosLosPerfiles(): Promise<Perfil[]> {
  const [{ data: perfiles }, { data: roles }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, correo, nombre, aprobado, must_change_password')
      .order('nombre'),
    supabase.from('user_roles').select('user_id, role'),
  ])
  const adminIds = new Set(
    (roles ?? [])
      .filter((r: { role: string }) => r.role === 'admin')
      .map((r: { user_id: string }) => r.user_id)
  )
  return (perfiles ?? []).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    correo: p.correo as string,
    nombre: p.nombre as string,
    rol: adminIds.has(p.id as string) ? ('admin' as const) : ('operario' as const),
    aprobado: (p.aprobado as boolean) ?? false,
    mustChangePassword: (p.must_change_password as boolean) ?? false,
  }))
}

export async function cambiarPasswordPropia(nuevaPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: nuevaPassword })
  if (error) throw error
  const { data: u } = await supabase.auth.getUser()
  if (u?.user) {
    await supabase
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', u.user.id)
  }
}

export async function cambiarAprobado(userId: string, aprobado: boolean) {
  const { error } = await supabase
    .from('profiles')
    .update({ aprobado })
    .eq('id', userId)
  if (error) throw error
}

export async function cambiarRol(userId: string, rol: Rol) {
  await supabase.from('user_roles').delete().eq('user_id', userId)
  const { error } = await supabase
    .from('user_roles')
    .insert({ user_id: userId, role: rol })
  if (error) throw error
}

export async function eliminarPerfil(userId: string) {
  await supabase.from('user_roles').delete().eq('user_id', userId)
  const { error } = await supabase
    .from('profiles')
    .delete()
    .eq('id', userId)
  if (error) throw error
}
