---
Task ID: 2
Agent: Main Agent
Task: Eliminar modo offline del aplicativo Rackly

Work Log:
- Eliminados 4 archivos: sync-engine.ts, offline-db.ts, useConnectivity.ts, ConnectionIndicator.tsx
- Refactorizado OcupacionTab.tsx: 6 cambios (removido import SyncEngine, 5 funciones offlineAware -> addMovimiento/trasladarMovimiento directo)
- Refactorizado TrasladoTab.tsx: 3 cambios (removido import, 2 funciones offlineAware -> directo)
- Refactorizado MovimientoForm.tsx: 12 cambios (removido import, doInsert, handleSalidaDesdeAlerta, 2x mass salida, 2x getCachedMovimientosForStock fallback, 2x doSalida, doIngresoINC)
- page.tsx: removido import y <ConnectionIndicator /> del header
- catalogo.ts: removido import de offline-db, cacheCatalogo, y loadCatalogoFromIndexedDB
- Verificado: 0 referencias a SyncEngine/offlineAware/useConnectivity/ConnectionIndicator/offline-db en src/
- Compilacion exitosa: next build sin errores
- Deploy exitoso: push a main completado

Stage Summary:
- ~800 lineas de codigo eliminadas
- 4 archivos eliminados completamente
- 23 cambios en 5 archivos modificados
- Resuelve 9 hallazgos de auditoria: C10, H8, H10, H11, M10, M11, M14, M15, M16
- Deploy URL: rackly.pages.dev
- Commit: 151ad83

---
Task ID: M+LOW batch 2
Agent: Sub Agent
Task: Fix M.6 (any casts) and A.4 (busy guard) in PisoSectoresTab.tsx

Work Log:
- M.6: Replaced 5 `(x: any)` casts with proper typed parameters:
  - Line 295: `(d: any)` → `(d: { movimiento_id: string })`
  - Line 318: `(d: any)` → `(d: { bloque_id: string })`
  - Line 324: `(b: any)` → `(b: { id: string; codigo: string; descripcion: string; unidad: string })`
  - Line 325: `(m: any)` → `(m: { id: string; tipo: string; turno: string | null; fecha: string; usuario_nombre: string | null; codigo_inc: string | null })`
  - Line 329: `(d: any)` → `(d: { movimiento_id: string })`
- A.4: Existing `busy` state (line 153) was already used for button disable and setBusy(true)/finally{setBusy(false)} in handlers, but missing the early-return guard. Added `if (busy) return` as first line in 6 entry-point functions:
  - doIngresoINC, doIngreso, doSalida, doTraslado, ejecutarTrasladoPiso, doDevolucion
  - All handlers already had setBusy(true)/finally{setBusy(false)} wrapping — only the debounce guard was missing.

Stage Summary:
- 5 type-safety fixes (M.6) — removes `any` from historical loading logic
- 6 debounce guard additions (A.4) — prevents duplicate API calls on double-click
- File modified: src/components/rackly/piso/PisoSectoresTab.tsx only

---
Task ID: M+LOW batch 1
Agent: Sub Agent
Task: Fix M.4, M.5, M.7, M.8, M.9, M.10, B.5 — medium/low severity batch

Work Log:
- M.4 (OcupacionTab.tsx): Added `detailLoading` state, wrapped `handleCellClick` async call with setDetailLoading(true)/finally(false), added Loader2 spinner overlay in the detail view panel (guarded by `!detailLoading &&` for the stock list to avoid showing empty state while loading).
- M.5 (OcupacionTab.tsx): Replaced `(r: any)` with `(r: Record<string, unknown>)` in the historial mapping function.
- M.8 (ErrorBoundary.tsx): Replaced raw `{this.state.error.message}` display with a sanitized user-facing message ("Ha ocurrido un error inesperado. Por favor recarga la página."). Used optional chaining `this.state.error?.message` for null safety.
- M.7 (constants.ts): Changed `QUERY_TIMEOUT_MS` from 8000 to 15000 (15 seconds) with an explanatory comment about tolerating slow connections and complex queries.
- B.5 (auth.ts): Changed `console.log` to `console.warn` and removed the `userId` argument from the email auto-confirm success log.
- M.10 (piso/api.ts): Removed 6 debug `console.log` statements:
  - RPC sample row debug block (rpcData.length > 0 check + detailed sample logging)
  - RPC count summary log
  - piso_bloques items loaded log
  - catalogo (respaldo) merge log
  - "Bloque encontrado en piso_bloques" log
  - "Bloque encontrado en catalogo" log
- M.9 (auth.ts): Changed `console.log` to `console.warn` for the auto-confirm retry attempt log.

Stage Summary:
- 7 fixes across 5 files: OcupacionTab.tsx, ErrorBoundary.tsx, constants.ts, auth.ts, piso/api.ts
- TypeScript compilation passes with zero errors
- No behavioral changes beyond the loading indicator addition (M.4) and the timeout value change (M.7)
---
Task ID: 3
Agent: Main Agent
Task: Decouple Kardex Racks/Piso + fix Stock vs Ocupacion discrepancy

Work Log:
- Analyzed all cross-dependencies between Kardex Racks and Kardex Piso
- Found 2 cross-sections: PisoStockTab→buscarStockRacksPorCodigo and StockTab→CrossSectionPiso(stockPisoPorCodigo)
- Confirmed both are read-only informational, no functional impact if removed
- Identified root cause of Stock vs Ocupacion discrepancy: StockTab includes INC movements in base calculation, OcupacionTab excludes them
- Removed CrossSectionPiso component and all related state/imports from StockTab.tsx
- Removed buscarStockRacksPorCodigo call, all Racks cross-lookup state/imports from PisoStockTab.tsx
- Fixed StockTab stockData useMemo: exclude INC movements from base calc (consistent with OcupacionTab)
- Removed codigoInc from stock key (no longer partitions stock by INC status)
- TypeScript check: 0 errors
- Next.js build: successful (static export)
- Pushed to GitHub (main branch)

Stage Summary:
- Kardex Racks and Kardex Piso are now fully decoupled, sharing only catalogo table
- Stock tab now matches Ocupacion tab numbers for non-INC items
- INC items only show when filter is set to "Solo INC"
- Deploy pending via Cloudflare Pages auto-deploy from GitHub
---
---
Task ID: 1
Agent: main
Task: Fix Stock vs Ocupación discrepancy (4th attempt - final fix)

Work Log:
- Read StockTab.tsx and OcupacionTab.tsx full files to compare calculations line-by-line
- Confirmed both use fetchMovimientos() via dataClient (same data source)
- Confirmed both exclude INC movements and use identical delta formula
- Identified that StockTab was splitting stock by FEFO lots (multiple rows per position), which could cause user confusion when comparing with OcupacionTab (one row per position)
- Rewrote stockData calculation in StockTab to use IDENTICAL logic to calcularOcupacion(): groups by (position, code), excludes INC, calculates net delta, ignores vencimiento for stock total
- FEFO info (vencimiento dates) now shown as informational field only - one row per position, with tooltip showing all lots
- Updated Mobile card and Desktop table UI to show lot count badge and tooltip
- Updated delete handler to clear all stock in position (not just one lot)
- Build successful, pushed to main for Cloudflare Pages deployment

Stage Summary:
- Root cause: StockTab's FEFO visual split created multiple rows per position, and the distribution algorithm could differ from OcupacionTab's aggregate view
- Solution: Replaced FEFO split with aggregate-per-position approach matching OcupacionTab exactly. FEFO dates now informational only.
- Key change: stockData now calculates net stock by (position, code) identically to calcularOcupacion, then filters by selected code
- Deployed via git push to main (Cloudflare Pages auto-build)
---
Task ID: 2
Agent: main
Task: Implement server-side stock calculation without 15K row limit

Work Log:
- Added fetchOcupacionServerSide() in kardex.ts — queries movimientos with only needed columns, excludes INC, groups by (position, code) client-side from smaller dataset
- Added fetchStockPorCodigoServerSide(codigo, soloInc) — queries movimientos filtered by specific code, groups by position, tracks FEFO dates
- Both functions return null on failure to signal caller to use fallback
- Updated StockTab: added useEffect that calls fetchStockPorCodigoServerSide when selectedCodigo changes, falls back to client-side stockData if server-side fails. Uses displayStock = serverStock ?? stock for rendering
- Updated OcupacionTab: inverted refreshData order — now tries server-side first, falls back to fetchMovimientos+calcularOcupacion (15K limit), then to RPC legacy
- Build successful, pushed to main

Stage Summary:
- Both tabs now have 3-tier fallback: server-side (no limit) → client-side (15K limit) → RPC legacy
- No existing functionality broken — all changes are additive with graceful fallback
- StockTab calculates server-side per-code (efficient: only downloads that code's movements)
- OcupacionTab calculates server-side for all positions (downloads all movements but with fewer columns)
---
Task ID: 719-negativos-validacion
Agent: Main Agent
Task: Revisar los 719 negativos — validación, prevención y reparación completa

Work Log:
- Diagnóstico REST + Postgres (Management API): 88 celdas negativas por lote (antes 740), 34 activas en 7 días
- Causa raíz confirmada: RPCs v3 (auto-lote FEFO) NUNCA se desplegaron en Supabase; 56% de salidas seguían naciendo sin lote
- Deploy v4 (rackly_lote_v4_auto_salida.sql) vía Management API: RPCs con auto-lote FEFO activas
- Backfill FASE 1-2 (rackly_backfill_lote_v2.sql): re-atribución FEFO + división por cuotas → 88→33
- FASE 3 rebalanceo (rackly_rebalance_lotes.sql): re-atribución ENTRE lotes (32 lotes físicos negativos en celdas positivas) → 33→1
- Descubierta brecha residual en v4: fallback "mayor saldo" podía fabricar negativo por lote con superávit sin-lote presente
- Deploy v5 (rackly_lote_v5_auto_salida.sql): regla intermedia (bucket sin-lote absorbe antes de forzar lote físico)
- Tests funcionales con ROLLBACK: 3 ramas de v5 verificadas (cubriente FEFO / NULL por superávit sl / mayor saldo)
- Estado final: 1 única celda negativa = déficit REAL 57630 @ 1/1/2/12 (-221,202) — requiere decisión de negocio
- Piso verificado con semántica de piso_stock_sector_grid: 0 negativos reales
- 57630 tiene +242,200 en 2/1/4/6 → probable traslado no registrado (recomendado al usuario)

Stage Summary:
- Negativos por atribución: 100% reparados (740/88 → 0)
- Prevención v5 activa en producción (misma firma, GRANTs intactos, sin cambios en app)
- Scripts persistidos: download/rackly_backfill_lote_v2.sql, download/rackly_rebalance_lotes.sql, download/rackly_lote_v5_auto_salida.sql

---
## 2026-10-19 · Auditoría proactiva: cierre del cauce de negativos por lote (v6)
- Hallazgo: tras el fix 719 (5c7c165), nacieron 11 artefactos de atribución nuevos (17-19 oct)
  por salidas CON lote que no cubría (typo/agotado): la RPC v5 solo reasignaba cuando la
  salida llegaba SIN lote. Caso claro: SO00432338 vs SO000432338 (typo).
- Fix RPC v6 (supabase/migrations/20261019_salida_lote_validacion_v6.sql): si el lote
  digitado no cubre, cae al pipeline v4/v5 (FEFO cubierta -> sin-lote -> mayor saldo).
  Validada en producción con 4 casos en transacción con ROLLBACK (A reasigna, B respeta,
  C rechaza INSUFFICIENT_STOCK, D absorbe sin-lote). INC y idempotencia intactos.
- Rebalanceo de los 11 artefactos: UPDATE/split FEFO por celda, respaldo previo en
  download/backup_negativos_19oct.json. Resultado: 0 artefactos; solo queda el déficit
  real 57630 @ 1/1/2/12 (-221,202, decisión de negocio ya documentada).
- Scripts: scripts/{auditoria_bd,clasifica_negativos,rebalanceo_lotes,traza_negativos}.py

---
## 2026-10-28 · Registrar RAL (Atención) — verificación E2E del autollenado + UND pegada
- Verificación integral del fix 1206e64 (pantalla ERP sin dos puntos): parser auditado
  línea por línea; 59 checks de test_ral_ocr en verde; entorno reconstruido
  (npm install — 28 suites afectadas por node_modules vacío, ya sanado).
- DB en producción verificada: rals/ral_items + RPC ral_crear_completa (atómica,
  idempotente) + RLS espejo de rq_* (DELETE solo admin/supervisores). Tabla rals
  vacía: el usuario reportó desde la pantalla de confirmación, nunca llegó a guardar.
- E2E real de la RPC vía Management API (scripts/test_ral_rpc_e2e.py, 16 checks):
  cada campo en SU columna (area_solicitante ≠ solicitante), item completo
  (código/desc/und/centro/cantidad), idempotencia ante reintento, limpieza total.
- Robustez ante NUEVA foto: suite test_ral_ocr_ruido (26 checks) con variantes
  adversarias del ERP (espacios dobles, gluing, decimales perdidos, encabezado
  partido, fusión de pases). Halló 1 gap residual: UND pegada a la última palabra
  del artículo ("SAL INDUSTRIALKG") quedaba vacía.
- Fix 782bf0e: helper unidadPegada() en ral-ocr.ts — separa sufijo unidad (≥2
  letras) si el prefijo conserva ≥3; aplicado en búsqueda derecha (d) y segunda
  pasada (d2). rq-ocr NO tocado (formato distinto, rigor 26/26 intacto).
- Deploy: GitHub Actions success → rackly.pages.dev v=202610281955-782bf0e.
- Remote git tenía token viejo (ghp_CqrC…AJ7N, rechazado en push): actualizado al
  PAT vigente. Reconstruido scripts/sb_config.py (Management API, ref
  owjryvcrhpmgtkkdcrkm) — el entorno reset lo había borrado.
- 29/29 suites · tsc OK · eslint OK · build OK.

---
## 2026-10-29 · Auditoría integral módulo por módulo — 6 defectos cerrados
- 1.1 Batería: 29/29 suites · tsc OK · eslint src/ 0/0 · build OK.
- 1.2 BD (scripts/auditoria_integral_db.py, nuevo): RLS 20/20 tablas ON con políticas;
  DELETEs sensibles restringidos por rol; 44 RPCs, cross-check de los 25 rpc() que la
  app llama → todos existen; 0 huérfanos RQ/RAL; 0 stock negativo; realtime OK (rals
  incluida). Dato a corregir en captura: 50891 (Base bebida) venc=2017-04-09 typo.
- 1.3 Módulos: QR (resolverToma legado estricto + fila exacta), FefoTab (cálculo FEFO),
  tab-state, RqSalidaConfirmador, TransitoModule = limpios. 6 hallazgos verificados:
  · MEDIO realtime: headSnapshot avanzado antes del refetch → cambio congelado si
    fallaba; ahora avanza solo en éxito (reintento por tic).
  · MEDIO salida masiva INC: type=number + badInput es-PE → '' → 'vacío=todo'
    registraba el STOCK COMPLETO en vez del parcial; espejo P2 (text+inputMode).
  · parseFloat('1,5')=1 en salida parcial INC y resumen → aNumero.
  · salidaBusy colisión normal/INC → clave codigo|codigoInc|venc|lote (espejo P3).
  · piso MovimientosTab sin guard generacional → espejo TransitoModule.
  · TrasladoTab click sin feedback si origen drenado + badge 'en 0' falsa por lote.
- Fix 611f75a desplegado → rackly.pages.dev. Scripts: auditoria_integral_db.py.

---
## 2026-10-29 · Atención: búsqueda RQ/RAL por código de MATERIAL (items)
- 1.1/1.2 Reporte: buscar por código de producto o RQ no devolvía datos
  (captura: "118" + fecha hoy + T1 → 0 filas). Reproducido E2E con JWT real
  (scripts/test_rq_busqueda_e2e.py): la API respondía bien con códigos del
  ENCABEZADO (424689, 192811) — pero "118" no existe en ningún campo del
  encabezado: es el código de ÁCIDO CÍTRICO en rq_atencion_items.
- 2 Causa raíz: listarRqs buscaba solo en 5 columnas del encabezado
  (numero_rq/orden_produccion/producto_codigo/producto_descripcion/solicitante);
  los MATERIALES pedidos viven en rq_atencion_items y no participaban.
  Evidencia: RQ 0000192737 (hoy, T1) pide material 118 — debía salir y no salía.
- 3 Mismo defecto detectado en la pestaña RAL (RalLista filtra solo
  encabezado). Barrido sin más casos: Kardex (eq codigo), Piso (codigo+
  descripcion), Recepción (modulos.ts), Tickets y Tránsito buscan columnas
  directas — limpios.
- 4 Vías evaluadas contra producción PostgREST (test_rq_busqueda_embed.py):
  or embebido → PGRST100; filtro embebido sin select → PGRST108;
  referencedTable .or() → AND (semántica equivocada). ELEGIDO: prelookup de
  rq_id en items + id.in.(…) DENTRO del mismo or() del encabezado — validado
  HTTP 200 y devuelve la RQ esperada (test_rq_busqueda_planC.py).
- 5 Sin conflictos: firmas sin cambios (llamadores únicos RqAtencionPanel/
  RalLista); paginación/total/orden intactos; degradación a búsqueda de
  encabezado si el prelookup falla (nunca peor); RLS SELECT de items = true
  autenticados; realtime/Task 35 (fecha+turno) sin tocar.
- 6/7 Implementación: busqueda-rq.ts (nuevo, puro: construirOrBusquedaRq +
  MAX_IDS_MATERIALES=200 con higiene uuid); rq-atencion.ts
  (buscarIdsPorMateriales capado + integración + sanitización unificada con
  terminoBusquedaSeguro de formato.ts, antes duplicada); ral.ts adjunta
  textoItems en listarRals; RalLista/RqAtencionPanel incluyen material y
  placeholders actualizados.
- Tests: scripts/test_rq_busqueda_or.js (33 checks, stub con captura aditiva
  __orCalls) → 30/30 suites · tsc OK · eslint OK · build OK.
- Deploy d15d909 → rackly.pages.dev v=202610291443-d15d909; E2E del escenario
  del usuario en producción devuelve la RQ 0000192737.
- Nota: remote git tenía de nuevo el PAT viejo (ghp_CqrC…) tras el reset del
  entorno; actualizado al vigente. sb_config.py reconstruido (2ª vez).
