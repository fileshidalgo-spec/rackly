-- ═══════════════════════════════════════════════════════════════════════
-- MIGRACIÓN Task 20 · v11 — Seguridad RLS + normalización de fechas absurdas
-- Fecha: 2026-10-23 · Auditoría profunda módulo por módulo
--
-- CONTENIDO (3 bloques):
--   1) Policies DELETE por rol en 15 tablas — antes: any authenticated podía
--      borrar cualquier fila (qual = true). Después: solo admin + supervisores
--      (supervisor_almacen, supervisor_operaciones, coordinador_operaciones),
--      replicando EXACTAMENTE el gateo de la UI (puedeEliminar en page.tsx,
--      CatalogoTab, RecepcionModule, RqAtencionPanel, AtencionModule,
--      MovimientosTab de Piso, DescargaTab ROLES_UPDATA).
--      Los deletes de estructura de piso (niveles/posiciones/columnas/
--      subcolumnas) solo ocurren vía RPCs SECURITY DEFINER (RLS no aplica).
--   2) REVOKE EXECUTE a anon en rq_atender_lote y rq_revertir_origen.
--      NO se revoca correo_existe_en_auth ni limpiar_perfil_huerfano: el flujo
--      de registro las llama SIN sesión (evidencia: AuthGate.tsx "funciona sin
--      sesión") — revocarlas rompería el alta de usuarios.
--   3) Normalización de 11 movimientos con f_vencimiento imposible
--      (años 0202, 3027, 20828 — creados antes del guard v8). 5 lotes están
--      en saldo 0 (pares ing/sal) → NULL sin impacto. El ingreso vivo de
--      50891 (+45) pasa a lote SIN fecha → al final del FEFO, editable desde
--      editar_lote_vencimiento cuando el almacén confirme la fecha real.
--      NULL es la única normalización que no inventa datos.
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- BLOQUE 1 · Policies DELETE por rol
-- La condición EXISTS usa user_roles (misma fuente que has_role(), que es
-- SECURITY DEFINER). Per-acción por (rol): admin + supervisores, idéntico
-- al patrón del cliente. Idempotente: DROP + CREATE.
-- ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tablas  text[] := ARRAY[
    'atencion_registros',       -- atencion_delete_auth
    'catalogo',                 -- authenticated_delete_catalogo
    'movimientos',              -- Authenticated delete movimientos
    'piso_bloques',             -- piso_bloques_delete
    'piso_columna_bloques',     -- piso_columna_bloques_delete
    'piso_columnas',            -- piso_columnas_delete
    'piso_movimiento_detalles', -- piso_movimiento_detalles_delete
    'piso_movimientos',         -- piso_movimientos_delete
    'piso_niveles',             -- piso_niveles_delete
    'piso_posiciones',          -- piso_posiciones_delete
    'piso_sectores',            -- piso_sectores_delete
    'piso_subcolumnas',         -- piso_subcolumnas_delete
    'recepcion_registros',      -- recepcion_delete_auth
    'rq_atencion_items',        -- rq_items_delete_auth
    'rq_atenciones'             -- rq_delete_auth
  ];
  v_nombres text[] := ARRAY[
    'atencion_delete_auth',
    'authenticated_delete_catalogo',
    'Authenticated delete movimientos',
    'piso_bloques_delete',
    'piso_columna_bloques_delete',
    'piso_columnas_delete',
    'piso_movimiento_detalles_delete',
    'piso_movimientos_delete',
    'piso_niveles_delete',
    'piso_posiciones_delete',
    'piso_sectores_delete',
    'piso_subcolumnas_delete',
    'recepcion_delete_auth',
    'rq_items_delete_auth',
    'rq_delete_auth'
  ];
  i int;
BEGIN
  FOR i IN 1..coalesce(array_length(v_tablas, 1), 0) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', v_nombres[i], v_tablas[i]);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I
      FOR DELETE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = auth.uid()
            AND ur.role IN (
              'admin',
              'supervisor_almacen',
              'supervisor_operaciones',
              'coordinador_operaciones'
            )
        )
      )
    $p$, v_nombres[i], v_tablas[i]);
  END LOOP;
END
$$;

-- ───────────────────────────────────────────────────────────────────────
-- BLOQUE 2 · REVOKE PUBLIC en RPCs de atención RQ (defensa en profundidad:
-- internamente ya validan auth.role(); con esto anon ni siquiera las
-- alcanza). La app siempre las ejecuta con sesión (authenticated).
-- NOTA OPERATIVA: REVOKE ... FROM anon NO basta — Supabase concede EXECUTE
-- a PUBLIC por defecto al crear la función; el patrón ACL correcto (idéntico
-- a registrar_movimiento_kardex) es REVOKE FROM PUBLIC manteniendo los
-- grants explícitos a authenticated/service_role/postgres.
-- ───────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.rq_atender_lote(uuid, text, jsonb, boolean, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rq_revertir_origen(uuid, text, text, uuid, text, text) FROM PUBLIC;

-- ───────────────────────────────────────────────────────────────────────
-- BLOQUE 3 · Normalización de fechas imposibles → NULL
-- Doble filtro (por id + año absurdo) para idempotencia y blindaje: si algo
-- cambió entre generación y ejecución, la fila no se toca.
-- ───────────────────────────────────────────────────────────────────────
UPDATE public.movimientos
   SET f_vencimiento = NULL
 WHERE id IN (
    'c3f0f9d6-e170-40c7-a452-411b3f070307',  -- 57559 ing 0202-08-21
    'da9558c9-fb0d-4363-8d8c-49e6b296e7b4',  -- 57559 sal 0202-08-21
    'a0e73be3-115a-482e-9941-5cfc5284decd',  -- 50891 ing 3027-06-04 (saldo vivo +45 → queda sin fecha)
    'e1d6a048-2909-4f4f-9300-debce52c40e3',  -- 56684 ing 3027-07-10
    '49870b36-4721-4a41-990c-959094776781',  -- 56684 sal 3027-07-10
    '88b4a93e-4a28-4d89-8f32-5626379a46ff',  -- 43683 ing 3027-09-24
    'd546a751-c1a4-4e5f-a49f-aaf3bed61d53',  -- 43683 sal 3027-09-24
    'fdcb0fb6-cabc-4e8b-ab58-b37fd5a41c62',  -- 5206 sal 3027-12-30
    '3f804be4-7f62-493a-b7bf-ac3df692b96d',  -- 5206 ing 3027-12-30
    '9569b432-b9bf-4c89-9384-e97fe2411d19',  -- 126 ing 20828-07-06
    'bb4486f8-b20b-49e9-8e5d-fcd1ac8f55b1'   -- 126 sal 20828-07-06
 )
   AND f_vencimiento IS NOT NULL
   AND (EXTRACT(YEAR FROM f_vencimiento) < 2000 OR EXTRACT(YEAR FROM f_vencimiento) > 2100);
