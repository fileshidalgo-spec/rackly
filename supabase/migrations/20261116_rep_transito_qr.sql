-- RACKLY · migración 20261116 — TRÁNSITO REPUESTOS con QR (paridad Insumos)
--
-- El módulo Tránsito de Repuestos ya escribe su lista de trabajo en
-- rep_recepcion_lineas (Recepción guarda, Tránsito lee). Para el refresco
-- EN VIVO (realtime + debounce, mismo patrón que Recepción/Atención/Tránsito
-- de Insumos vía useRegistrosRealtime) la tabla debe estar en la publicación
-- supabase_realtime — sin esto, el canal no entrega NINGÚN evento (así se
-- descubrió en 2026-10 con las tablas de Insumos: publicación VACÍA).
--
-- Idempotente: solo agrega si aún no está (pg_publication_tables).
-- El POLLING de respaldo del hook (cada 8 s) mantiene "En vivo" funcionando
-- aunque esta migración no se haya aplicado todavía; el realtime la baja a
-- ~instantáneo.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'rep_recepcion_lineas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rep_recepcion_lineas;
  END IF;
END $$;
