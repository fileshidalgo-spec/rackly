-- ──────────────────────────────────────────────────────────
-- Fix: permitir eliminar usuarios de Auth aunque tengan movimientos.
--
-- PROBLEMA: la tabla movimientos tiene usuario_id REFERENCES auth.users(id)
-- sin ON DELETE CASCADE, lo que causa error 500 al intentar eliminar
-- un usuario de Auth que tiene registros de movimientos.
--
-- SOLUCIÓN: cambiar el FK a ON DELETE SET NULL. Al eliminar un usuario
-- de Auth, el campo usuario_id de sus movimientos queda en NULL
-- (se preservan los datos del movimiento, solo se pierde la referencia).
--
-- Ejecutar en Supabase SQL Editor (Dashboard → SQL Editor)
-- ──────────────────────────────────────────────────────────

-- 1. Cambiar la restricción FK de usuario_id a ON DELETE SET NULL
ALTER TABLE public.movimientos
  DROP CONSTRAINT IF EXISTS movimientos_usuario_id_fkey,
  ADD CONSTRAINT movimientos_usuario_id_fkey
    FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Verificar que la restricción se aplicó correctamente
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
WHERE tc.table_name = 'movimientos'
  AND kcu.column_name = 'usuario_id';

-- Resultado esperado: delete_rule = 'SET NULL'