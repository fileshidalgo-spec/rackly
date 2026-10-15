-- ═══════════════════════════════════════════════════════════════════
-- RACKLY — Hardening + drift versionado (auditoría profunda 2026-10-16)
-- Idempotente: re-aplicable sin daño.
--   1) Drift de recepcion_registros: uuid_sync / n_paleta / índice único
--      parcial / publicación realtime — existían en producción pero no en
--      la carpeta migrations (el anti-duplicado M-1 y el realtime de
--      Recepción dependían de objetos no versionados).
--   2) transito_registrar_envio: REVOKE a anon/PUBLIC (era ejecutable por
--      el rol anónimo con SECURITY DEFINER) + guard in-function
--      (auth.role() ∈ service_role|authenticated).
--   3) RPC cambiar_rol_usuario: reemplazo atómico del delete+insert de
--      cambiarRol (evita dejar usuarios SIN rol si el insert falla).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Drift versionado ─────────────────────────────────────────────
ALTER TABLE public.recepcion_registros ADD COLUMN IF NOT EXISTS uuid_sync text;
ALTER TABLE public.recepcion_registros ADD COLUMN IF NOT EXISTS n_paleta integer;

CREATE UNIQUE INDEX IF NOT EXISTS recepcion_uuid_sync_uidx
  ON public.recepcion_registros (uuid_sync) WHERE uuid_sync IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'recepcion_registros'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.recepcion_registros;
  END IF;
END $$;

-- ── 2. transito_registrar_envio: permisos + guard ───────────────────
REVOKE EXECUTE ON FUNCTION
  public.transito_registrar_envio(uuid, text, numeric, text, uuid, text, text, text, jsonb, jsonb, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.transito_registrar_envio(uuid, text, numeric, text, uuid, text, text, text, jsonb, jsonb, text)
TO authenticated, service_role;

-- Guard in-function (la función es SECURITY DEFINER: escribe en movimientos,
-- piso_movimientos y recepcion_registros — jamás ejecutable por anon).
-- NOTA: el cuerpo completo está en 20261014_transito.sql; aquí solo se
-- re-declara la firma para dejar constancia y facilitar CREATE OR REPLACE.
-- El guard se aplicó en producción vía Management API (ver
-- scripts/hardening_db_fase2.py): IF COALESCE(auth.role(), '') NOT IN
-- ('service_role', 'authenticated') THEN RAISE EXCEPTION 'NO_AUTORIZADO|…'.

-- ── 3. RPC cambiar_rol_usuario ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cambiar_rol_usuario(
  p_user_id uuid,
  p_rol public.app_role
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    NULL; -- la app (service_role): permitido
  ELSE
    IF COALESCE(auth.role(), '') <> 'authenticated' OR NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    ) THEN
      RAISE EXCEPTION 'NO_AUTORIZADO|Solo un administrador puede cambiar roles';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USUARIO_NO_EXISTE|El usuario a modificar no existe';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (p_user_id, p_rol);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cambiar_rol_usuario(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cambiar_rol_usuario(uuid, public.app_role)
TO authenticated, service_role;
