-- ═══════════════════════════════════════════════════════════════════════════
-- Task 15 · UNIFICACIÓN DE CATÁLOGO — Catálogo único en `catalogo` (Racks)
-- ───────────────────────────────────────────────────────────────────────────
-- Contexto: el módulo Piso tenía su propio catálogo (piso_bloques como fuente
-- de descripcion/unidad, replicado desde `catalogo`). Ahora `catalogo` es la
-- ÚNICA fuente de verdad: Piso la lee en vivo (resolverInfoBloques en
-- src/lib/piso/api.ts) y piso_bloques queda como ANCLA TÉCNICA exclusivamente
-- (UUID para la FK piso_movimiento_detalles.bloque_id, historial inmutable).
--
-- Esta limpieza elimina SOLO las anclas SIN NINGÚN uso (0 movimientos y 0
-- asignaciones de sector) — FK-safe por construcción. Conserva:
--   · 137 anclas con historial de movimientos (incluye 2 códigos de muestras
--     manuales: MUESTRASVARIAS, ARTÍCULOSVARIOSMUESTRAS).
-- Las anclas eliminadas (espejo del catálogo + 40 códigos basura de cargas
-- Excel antiguas) se recrean on-demand desde el catálogo si algún día se
-- vuelven a usar (asegurarAnclaPiso).
-- ═══════════════════════════════════════════════════════════════════════════

-- Conteo previo esperado: 1024 (984 espejo sin uso + 40 basura fuera de catálogo)
SELECT count(*) AS anclas_sin_uso_a_podar
FROM piso_bloques pb
WHERE NOT EXISTS (SELECT 1 FROM piso_movimiento_detalles pmd WHERE pmd.bloque_id = pb.id)
  AND NOT EXISTS (SELECT 1 FROM piso_columna_bloques pcb WHERE pcb.bloque_id = pb.id);

DELETE FROM piso_bloques pb
WHERE NOT EXISTS (SELECT 1 FROM piso_movimiento_detalles pmd WHERE pmd.bloque_id = pb.id)
  AND NOT EXISTS (SELECT 1 FROM piso_columna_bloques pcb WHERE pcb.bloque_id = pb.id);

-- Verificación: deben quedar SOLO las anclas con historial (137)
SELECT count(*) AS anclas_restantes_con_historial
FROM piso_bloques pb
WHERE EXISTS (SELECT 1 FROM piso_movimiento_detalles pmd WHERE pmd.bloque_id = pb.id);
