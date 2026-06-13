-- ──────────────────────────────────────────────────────
-- Fix: expandir el enum app_role para incluir todos los roles
-- que el código usa (auth.ts define 7 roles pero el enum
-- solo tenía 'admin' y 'operario').
--
-- Ejecutar en Supabase SQL Editor (Dashboard → SQL Editor)
-- ──────────────────────────────────────────────────────

-- Agregar los roles faltantes al enum
-- En PostgreSQL 12+ se pueden agregar dentro de una transacción
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'auxiliar';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'almacenero';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'supervisor_almacen';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'supervisor_operaciones';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'coordinador_operaciones';

-- Verificar que el enum ahora tiene todos los valores
SELECT unnest(enum_range(null::public.app_role)) AS rol;