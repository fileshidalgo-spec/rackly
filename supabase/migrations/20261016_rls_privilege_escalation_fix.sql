-- ═══════════════════════════════════════════════════════════════════════════
-- RACKLY — Fix de escalada de privilegios en RLS (auditoría 2026-10-16)
-- ═══════════════════════════════════════════════════════════════════════════
-- Defecto (paso 1-2): cualquier usuario autenticado podía, vía PostgREST
-- directo con su propio JWT:
--   a) auto-asignarse el rol 'admin'  → user_roles INSERT WITH CHECK (true)
--   b) BORRAR los roles de cualquier usuario → user_roles DELETE USING (true)
--   c) editar cualquier perfil (auto-aprobarse, cambiar nombres)
--      → profiles UPDATE USING (true) WITH CHECK (true)  ("Admins update profiles")
-- Además había policies duplicadas (users_can_insert_roles vs
-- Authenticated insert user_roles / users_can_delete_roles vs Admins manage).
--
-- Paso 3 (repetición en otras pestañas): auditadas TODAS las policies de
-- user_roles y profiles en producción; el resto de tablas (movimientos,
-- piso_*, recepcion_registros, atencion_registros) no permite escalada de
-- privilegios porque no almacenan roles ni aprobaciones.
--
-- Paso 4-5 (procedimiento sin conflictos): la app escribe profiles/user_roles
-- EXCLUSIVAMENTE vía dataClient (service_role, inmune a RLS) y la gestión de
-- roles usa la RPC SECURITY DEFINER cambiar_rol_usuario (guard admin).
-- Por eso se pueden retirar las policies permisivas INSERT/DELETE/UPDATE-broad
-- SIN romper ningún flujo: la lectura (SELECT) se conserva para la UI.
-- El único escritor con cliente anon era el flag must_change_password en
-- AuthGate (SetNewPasswordScreen) — se corrige en el código a dataClient y se
-- conserva un privilegio de COLUMNA estrecho como defensa en profundidad.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) user_roles: retirar INSERT/DELETE permisivos (y duplicados) ─────────
DROP POLICY IF EXISTS "users_can_insert_roles"      ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated insert user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "users_can_delete_roles"      ON public.user_roles;
DROP POLICY IF EXISTS "Admins manage user_roles"    ON public.user_roles;
-- Detectada en la verificación post-aplicación: policy UPDATE heredada
-- (USING=true / CHECK=true) permitiría a CUALQUIER authenticated cambiar el
-- rol de cualquier fila (p. ej. auto-ascenderse a admin vía UPDATE).
DROP POLICY IF EXISTS "Admins manage user_roles2"   ON public.user_roles;
DROP POLICY IF EXISTS "users_can_update_roles"      ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated update user_roles" ON public.user_roles;
-- La lectura se mantiene (la UI necesita mostrar el rol del usuario).
-- INSERT/DELETE quedan solo para service_role (bypass RLS) y la RPC
-- cambiar_rol_usuario (SECURITY DEFINER, guard de admin).

-- ── 2) profiles: retirar el UPDATE-broad "Admins update profiles" ──────────
-- (permitía a cualquier authenticated editar CUALQUIER perfil, incluida la
--  columna aprobado → auto-aprobación).
DROP POLICY IF EXISTS "Admins update profiles" ON public.profiles;

-- Defensa en profundidad para el flujo de cambio de contraseña:
-- solo la columna must_change_password, solo la propia fila.
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
GRANT  UPDATE (must_change_password) ON TABLE public.profiles TO authenticated;
-- La policy "Users update own must_change_password" (auth.uid() = id) se
-- conserva: combinada con el privilegio de columna, un cliente con anon key
-- solo puede apagar su propio flag de "debe cambiar contraseña".

-- ── 3) Verificación (se ejecutan sin error; no-op si todo está bien) ───────
DO $$
DECLARE
  v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'user_roles'
     AND cmd IN ('INSERT', 'DELETE', 'UPDATE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'RACKLY-AUDIT: user_roles aún tiene policies de escritura permisivas (%)', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'profiles'
     AND cmd = 'UPDATE' AND COALESCE(qual, 'true') = 'true';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'RACKLY-AUDIT: profiles aún tiene UPDATE sin restricción de fila';
  END IF;
END $$;
