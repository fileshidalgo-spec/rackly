---
Task ID: 1
Agent: Main Agent
Task: Regularización de filas sobrantes sin envíos (T173-00004274 · guía T173-00004274 · 53414 DIVERFLOW 156) — 9 pasos

Work Log (1.1–9):
- 1.1/1.2 (DB real): guía T173-00004274 tenía 6 filas del 53414 = 172 UN registradas vs 150 reales; sobrante fantasma = fila d6d01142 (22 UN, Paleta 2, lote 20930276, 0 envíos — exactamente la fila de la captura "Sin transferir"); 118 ya transferidos a piso; pendiente aparente 54 (22 fantasma + 32 reales)
- 2 (causa): el guard "ajenas" de guardarEdicionGuia era CIEGO AL ROL — bloqueaba quitar filas de otro usuario INCLUSO a admin/supervisor con recepcion.eliminar, aunque las políticas RLS SÍ lo permiten (recepcion_delete_auth + recepcion_registros_delete_permiso bajo recepcion_delete_restr = tiene_permiso). Guard más estricto que la BD = guía imposible de corregir. Además Tránsito solo añade envíos: una fila flotante sin envíos no tenía NINGÚN camino de salida
- 3 (repetición): patrón único en modulos.ts; otros ERR_ELIMINAR_BLOQUEADO son verificaciones honestas de DELETE (correctas, intactas); eliminarGuia con envíos sigue bloqueado (política correcta)
- 4/5 (decisión sin conflictos): reutilizar la MISMA función tiene_permiso que usa la RLS (cero deriva) + RPC SECURITY DEFINER con advisory lock (mismo salt 7771 que transito_registrar_envio → serializa con envíos concurrentes) + SOLO filas 0 envíos (con envíos = stock ya en Racks/Piso, no se toca)
- 6 (código): migración 20261031_regularizacion_fila.sql (RPC recepcion_regularizar_fila: guard permiso + lock + DELETE honesto con RETURNING + snapshot de auditoría); modulos.ts guard consulta tiene_permiso vía RPC (fail-safe: si la consulta falla, bloquea); transito-core.regularizable() puro; transito.regularizarFila(); Tránsito muestra acción "Regularizar" junto a Historial (solo con recepcion.eliminar y fila 100% sin transferir) con DialogoRegularizar (confirmación + motivo → snapshot)
- 7 (QA): tsc 0 errores · eslint OK · 38/38 suites (nueva test_regularizacion 16 checks; [3b]/[3c] en test_recepcion_delete_honesto; stub rpc enlatado por nombre) · build OK
- 8 (accesos): SQL aplicado por Management API; smoke: service_role → "PERMISO|…" OK; E2E admin (cuenta proporcionada) → pasa PERMISO, llega a la fila ("RECEPCION_NO_EXISTE" con id falso) OK
- 9 (módulos): Recepción (modulos.ts) · Tránsito (UI + RPC) · Suite global de tests
- REGULARIZACIÓN EJECUTADA en producción (admin): fila d6d01142 eliminada con snapshot completo (owner Elvis R. Valdivia, motivo documentado) → guía 172→150 OK, transferido 118, pendiente real 32 OK
- Deploy: commit 866d14a → Cloudflare Pages → version.json 202610302139-866d14a OK

Stage Summary:
- Nueva capacidad: regularizar el sobrante de una guía DIRECTAMENTE desde Tránsito (puente Tránsito→Recepción) o desde el editor de Recepción (ahora permitido a quien tenga recepcion.eliminar)
- Sin regresiones: los 4 guards previos intactos (filas con envíos siguen intocables; sin permiso sigue bloqueado; DELETE honesto sigue verificando el efecto real)
- Caso T173-00004274 CERRADO: la guía quedó en 150, el pendiente de Tránsito es el stock real (32) y la fila flotante de la captura ya no existe
---

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

---
## 2026-10-29 · Atención: reporte de atención a líneas — Excel (5 hojas) + Dashboard
- Solicitud: descargar la información de TODOS los RQ para el reporte de
  atención a líneas, resumen por artículo en otra hoja y dashboard para
  presentar. Desplegado 49abc6c → rackly.pages.dev v=202610291506-49abc6c.
- Modelo de datos verificado en producción: rq_atenciones (18 cols) ·
  rq_atencion_items (pedido/atendido/atendido_en) · ledger rq_atencion_tomas
  (Task 27: 131 filas, origen racks/piso/transito/manual/reversa) — el ledger
  NO guarda f_vencimiento; el vencimiento es intrínseco al lote y se RESUELVE
  desde movimientos (codigo+lote → mayor f_vencimiento; patrón paginado
  .in('lote', lotes), 1000/batch, tope 20 batches).
- atencion-reporte.ts: cargarReporteAtencion() (1 tirada, Promise.all) +
  agregaciones puras: kpisAtencion · resumenPorArticulo (88 códigos reales,
  sobreatención no penaliza pendiente) · serieRqsPorDia · serieRqsPorLinea ·
  topArticulosAtendidos.
- atencion-excel.ts (patrón guia-excel, xlsx-js-style): 5 hojas — RQs ·
  Materiales (pedido vs atendido + estado Completo/Parcial/Pendiente) ·
  Salidas (tomas) con ubicación/lote/F. VENCIMIENTO/saldo/usuario ·
  Resumen artículo · Dashboard (KPIs + por día + por línea + top).
- RqDashboard.tsx: vista presentable (gráficos CSS, sin deps nuevas) +
  Exportar Excel; RqAtencionPanel: botón Dashboard.
- QA: test_atencion_reporte.js 40 checks (stub con captura __orCalls
  intacta) → 31/31 suites · tsc OK · eslint OK · build OK.
- E2E producción (test_reporte_atencion_e2e.py): 67 RQs · 210 items ·
  131 tomas (129 salidas/2 reversas) · 156/210 materiales completados ·
  lotes legados 'BACKFILL-27' sin vencimiento degradan a columna vacía
  (limitación de dato, no bug; lotes reales p.ej. 1810-26 sí resuelven).
## 2026-10-30 · Atención: RAL unificado con RQ — una sola lista y mismo modelo de atención
- 1.1/1.2 Reporte: «la atención de RAL debe ser el mismo modelo que la de RQ
  y todo debe aparecer en UNA sola lista — quizás con una distinción que diga
  RAL — para filtrar y buscar más rápido». Hallazgo en BD: rals SIN columna
  estado y ral_items SIN cantidad_atendida/usuario_atencion/atendido_en — el
  RAL era un documento de solo lectura (ver/eliminar), imposible de atender.
- 2 Causa: Task 36 diseñó el RAL como registro de documentos con aislamiento
  total, sin espejar el modelo de atención de la RQ (estado canónico v9 +
  items atendibles + RPC atómica).
- 3 Sin repetición: rals/ral_items solo los toca el módulo Atención (ral.ts,
  RalLista, panel). Dashboard/Excel (atencion-reporte.ts) leen SOLO rq_* —
  intactos. Volumen en producción al migrar: 0 filas (riesgo ≈ 0).
- 4 Vía elegida: espejo EXACTO del patrón RQ probado. Migración aditiva
  (supabase/migrations/20261030_ral_modelo_atencion.sql): rals.estado,
  ral_items.cantidad_atendida/usuario_atencion/atendido_en, índice
  idx_ral_items_ral_id, RPCs ral_atender_item/ral_revertir_item (guard de
  rol, incremento/decremento atómico, sobreatención permitida, regla
  canónica de estado), RLS UPDATE en rals.
- 5 CONFLICTO EVITADO (hallado por E2E 19/19 en producción con JWT real,
  scripts/test_ral_atencion_e2e.py): crear la política solo con
  `with check(true)` deja qual=NULL y el UPDATE afecta 0 FILAS en silencio
  (el estado nunca cambiaba). rq_update_auth tiene using(true) EXPLÍCITO —
  rals_update_auth replicada tal cual. ral_crear_completa no se toca
  (defaults aplican: Pendiente / 0).
- 6/7 Implementación: atencion-unificada.ts NUEVO (puro: FilaUnificada,
  textoBusquedaRal, coincideFiltroRal, conteosEstado, unirFilasAtencion —
  fecha DESC + created_at de desempate; turno excluye RAL: no tiene);
  ral.ts +atenderItemRal/revertirItemRal (RPC-first + respaldo optimista con
  guard por igualdad, espejo rq-atencion.ts) + estado mapeado con default
  Pendiente + listarRals limit 300; RqAtencionPanel: lista unificada
  (tabla FilaRqTabla/FilaRalTabla + tarjetas móviles) con badge violeta
  "RAL", realtime 'rals' adicional, eliminación RAL integrada, vista
  'detalle-ral'; RalDetalle NUEVO (ATENDIDO/PENDIENTE/ATENDER + confirmación
  + excedente + reversa + progreso — sin ubicaciones/QR/lotes: el RAL no
  tiene modelo lote/posición); RalLista.tsx eliminada (absorbida).
- Tests: scripts/test_ral_unificado.js (31 checks: unión/orden/filtros/
  conteos + RPC-first + respaldos + recálculo); stub +__updateCalls/
  __setUpdateResult/pendingUpdate (aditivo, no rompe suites previos).
  32/32 suites · tsc OK · eslint OK · build OK.
- Deploy a4142d3 → rackly.pages.dev v=202610291658-a4142d3. Post-deploy:
  listarRals con estado 200, RPCs en schema cache (error de negocio, no 404),
  ral_items expone columnas de atención.

## 2026-10-30 · Tránsito/Racks: fin del «[object Object]» + ingreso por QR en Racks > Ocupaciones
- 1.1/1.2 Reporte (screenshot 16:54, usuario Elmer): al escanear un QR en
  Tránsito, el diálogo «Transferir artículo» muestra «[object Object]» en el
  artículo 37934 — 81000 UN. Evidencia en BD: fila 8c16a5ab
  (recepcion_registros, 37934 · 81000 UN · vencimiento **3027-07-31**, typo
  del proveedor) SIN envío de tránsito; movimientos con ingreso manual
  16:55:49 B3·T1·P4·Pos1 (Elmer, uuid_sync NULL, no pasó por la RPC).
- 2 Causa (doble): (a) CLIENTE — postgrest-js devuelve el error como OBJETO
  PLANO {message,details,hint,code} (no `Error`); mensajeRpcError hacía
  `err instanceof Error ? err.message : String(err)` → «[object Object]»;
  (b) BD — el guard v8 de transito_registrar_envio era CÓDIGO MUERTO:
  `v_venc := v_row.fecha_vencimiento` estaba DESPUÉS del check de año
  absurdo (corría sobre NULL), así que el venc 3027 llegó crudo a
  registrar_movimiento_kardex → FECHA_INVALIDA. El error real quedó
  enmascarado por (a).
- 3 Repetición: el patrón ingenuo estaba en 3 sitios (auth.ts, transito-core,
  LectorQR) y la variante «Error desconocido»/'Error' en ~45 más (31 archivos:
  Atención, Recepción, Kardex, Piso, Usuarios, page.tsx) — mismo defecto de
  clase: errores PostgrestError planos perdían el mensaje.
- 4 Vía: extractor CANÓNICO src/lib/rackly/errores.ts — mensajeError()
  (Error, PostgrestError plano, string, {error|msg|detalle}, prefijo
  «CODE|» de las RPCs → solo el detalle, fallback JSON — jamás
  [object Object]). mensajeRpcError y extractError delegan (contrato
  intacto, incl. Error('INSUFFICIENT_STOCK') con .detail); codemod
  (scripts/codemod_errores.js + fix_imports_errores.js) reemplazó las
  variantes en todos los módulos.
- 5 Sin conflictos: todos los branching de códigos (isInsufficientStockError,
  isLoteUnsupportedError, fallbacks RPC 42883/PGRST202) operan sobre el error
  CRUDO, no sobre la salida del extractor — intactos. QA: 34/34 suites ·
  tsc 0 · eslint 0 · build OK. Tests nuevos: test_errores (21) +
  test_ingreso_qr (14).
- 6/7 BD (Management API, scripts/fix_rpc_venc_guard.py): guard v8 reparado
  (asignación ANTES del check) — verificado con transacción ROLLBACK en
  producción: fila venc 0027-09-04 ahora viaja «sin fecha» (ok, PARCIAL) y el
  anti-sobreenvío sigue rechazando (OVER_ISSUE). Corrección de datos
  (scripts/sincronizar_fila_fantasma.py): el envío del ingreso REAL de Elmer
  quedó documentado en recepcion_registros.transito con trazabilidad 1:1 al
  movimiento (uuid = mov 036c2dd2) — fila pasó de ROJO/pendiente fantasma a
  VERDE sin tocar stock (el ingreso físico ya existía).
- FEATURE (pedido del usuario): ingreso por QR en Racks > Ocupaciones.
  lib pura ingreso-qr.ts (rotuloDesdeFila/prefillDesdeRotulo/
  validarCantidadRotulo/etiquetaPosicionRack); OcupacionTab: botón
  «Escanear rótulo (QR)» + chip del rótulo + LectorQR compartido (cámara +
  pistola USB); prefill de código/descripción/UN/cantidad(pendiente)/lote/
  vencimiento/proveedor. registrarIngresoRackDesdeRotulo (transito.ts) usa la
  RPC ATÓMICA transito_registrar_envio: ingreso en la posición + marca en
  Tránsito en UNA transacción — elimina la clase «palet fantasma» del
  incidente (doble registro); uuid estable por fila (idempotencia entre
  reintentos); rótulos ya transferidos van por la vía genérica con aviso.
- Deploy 4845c4b → rackly.pages.dev v=202610301352-4845c4b. E2E REST con
  JWT real: el error llega {code:"P0001", message:"OVER_ISSUE|La cantidad a
  transferir (1) excede el pendiente de 37934 (0): excedente 1"} — la UI ahora
  lo muestra completo.

---

## 2026-10-30 · Auditoría integral de la app — 23 defectos cerrados en TODOS los módulos
- 1.1 Detección (pedido: «hay errores en la app, bugs, duplicados… estructura
  de datos eficiente y segura, DB funcionando correctamente — módulos: todos»):
  (a) QA estático: tsc 0 · eslint 0 · 34/34 suites · build OK;
  (b) auditoría DB completa con Management API (audit_db.py): RLS activa en
  20/20 tablas, ninguna policy sin qual, ninguna tabla pública, 12 FKs con
  reglas correctas, 60+ índices; duplicados de datos analizados caso a caso;
  (c) 3 revisores en paralelo (Recepción · Kardex+Piso · Tránsito+QR con
  catálogo completo de errores del camino de escaneo) + revisión directa de
  Atención (unificada) y auth.ts.
- 2 Causas raíz consolidadas (8 P2 + 15 P3), entre ellas: convención de error
  «CODE|texto» que moría dentro de mensajeError (branching AFTER extractor —
  código muerto); idempotencia M-1 ausente en la EDICIÓN de guías; auto-confirm
  de login doblemente roto (id vacío + Edge Function con sesión admin que no
  existe durante el login); parseFloat truncando decimales con coma en 8
  sitios de OcupacionTab; payload QR sin sanear ^ ~ \; sin guard de numero_rq
  duplicado (caso real 2026008365 ×2 a 16 min — confirmado en BD);
  piso_registrar_movimiento aceptando _detalles vacíos (cabecera fantasma);
  búsqueda unificada RAL-viva vs RQ-al-pulsar (lista mixta incoherente).
- 3 Repetición verificada por hallazgo: parseFloat→aNumero estaba corregido en
  DialogoTransferir pero replicado en NINGÚN otro sitio de OcupacionTab (8
  sitios); guard NaN de FEFO existía en FefoTab y no en FefoPisoTab; ilike con
  comodines en 2 capas (transito.ts + rq-atencion.ts); el patrón «CODE|» en
  3 throws × 2 catches (RecepcionModule + GuiaFotoForm).
- 4 Vía más efectiva: fixes quirúrgicos por bloque (A lib compartida ·
  B Recepción · C Kardex/Piso/Auth · D Tránsito/QR · E Atención · F SQL),
  errors.ts como única fuente de códigos controlados (Error.name), migración
  SQL única para los 5 cambios de BD.
- 5 Sin conflictos: contrato de mensajeError intacto (los códigos viajan en
  .name, no en message); los branches existentes de RPC (OVER_ISSUE,
  INSUFFICIENT_STOCK…) operan sobre el error crudo; tolerancia legada de
  grupos huérfanos de paletas PRESERVADA (2/3,3/3 sigue uniendo — test que
  lo cubre); 34/34 suites · tsc 0 · eslint 0 · build OK.
- 6/7 Implementación experta y ordenada (26 archivos, +938/−91): errores.ts
  (errorControlado/codigoControladoDe/ERR_*), modulos.ts, recepcion-filas.ts,
  RecortarImagenDialog, RecepcionModule, GuiaFotoForm, auth.ts, PisoSectoresTab,
  FefoPisoTab, FechaVencimientoField, DescargaTab, OcupacionTab, LectorQR,
  transito.ts, rq-atencion.ts (buscarRqPorNumero), zebra.ts, qr-rotulo.ts,
  RqAtencionPanel, RqFotoForm, RqEditarDialog.
- 8 Accesos usados: GitHub PAT (push bd34f5e), Supabase Management API
  (migración + verificaciones), JWT de app (RPC E2E), Cloudflare Pages (deploy
  automático), anon key (prueba de bloqueo de escritura anónima).
- 9 Todos los módulos: Recepción, Racks/Ocupaciones (Kardex), Piso, Tránsito,
  Atención (RQ+RAL unificados), Auth, Etiquetas/ZPL, Usuarios. Falsos
  positivos descartados con evidencia: 5 pares de movimientos <3 s (salidas
  partidas con cantidades distintas — legítimas) y logs «odulos]» (artefacto
  del pipeline de render — el fuente siempre tuvo «[modulos]»; NO hubo cambio).
- BD (20261030_auditoria_integral.sql, aplicada + verificada): revoke
  insert/update/delete a anon (prueba en vivo: 401/42501) · search_path de
  piso_auto_estructura_sector · confirmar_correo_en_auth (bcrypt; E2E
  correcta→true/incorrecta→false/inexistente→false) · DETALLES_REQUERIDOS en
  piso_registrar_movimiento · EPS 0.0005 en el anti-sobreenvío de
  transito_registrar_envio.
- Tests: +22 checks (R3/R5 en filas, Z1/Z2 en zebra, errores controlados,
  23505 amigable) → 34/34 suites.
- Deploy bd34f5e → rackly.pages.dev v=202610301512-bd34f5e (verificado).

---

## 2026-10-30 · Recepción: fin de la duplicación de guías al editar (T173-00004281) — commit c66cf5f

**1.1 Detección** (reporte del usuario: «cada que modifico una guía, elimino un artículo y le doy guardar, se duplican los artículos y rótulos a imprimir; tenía 24 etiquetas y se triplicó»): la guía T173-00004281 tiene DOS guias_id — `0bbdef5d` con **63 filas** (la corrupta) y `d24dacf6` con 22 (la recreación del usuario como workaround, confirmado por él). Evidencia en BD: 16 filas originales (14:31) + INSERTS de 7/13/14/13 filas en 4 guardados (14:39→15:08) con **CERO deletes efectivos**, mezclando marcas «Paleta 2/6» y «2/7» en una misma tanda.

**2. Causa** (doble): (a) la política RLS `recepcion_delete_auth` solo permite DELETE a supervisores+; Edwin tiene rol **operario** → cada DELETE que disparaba al quitar un artículo llegaba como HTTP 200 con **0 filas borradas** (RLS filtra en silencio, sin error); la app creía el guardado y al re-agregar los artículos la guía se inflaba. (b) `filasAItems` fusionaba grupos de paletas del mismo código con N distinto («1/7» + «2/5» → artículo fantasma) y la lectura ordenaba solo por `created_at` (16 filas comparten el MISMO microsegundo → orden arbitrario).

**3. Repetición en otras pestañas**: el patrón «UPDATE=true / DELETE=solo supervisores» se repite en `rals`, `rq_atenciones`, `rq_atencion_items` y `atencion_registros` — mismos borrados silenciosos. Se corrigió la honestidad en las 3 vías de borrado de Recepción + Atención; las demás tablas quedan para una pasada siguiente (los roles supervisores ya podían borrar).

**4/5. Procedimiento + no-conflictos**: (a) política RLS nueva `recepcion_delete_propia_sin_transito` — el DUEÑO borra SUS filas sin envíos de Tránsito; supervisores conservan el poder total (política anterior intacta); (b) guard de propiedad ANTES de escribir en `guardarEdicionGuia` (filas de otro usuario → `ELIMINAR_BLOQUEADO` sin tocar nada) + verificación del DELETE real al final; (c) `eliminarGuia/eliminarRecepcion/eliminarAtencion` verifican el efecto (0 filas = error claro, jamás éxito falso); (d) `filasAItems` exige el MISMO N del grupo abierto y las filas sin marca cierran el grupo; (e) orden determinista `created_at→codigo→n_paleta→id` en `listarRecepcionesPorDocumento`. Los guards de Tránsito y la sincronización por identidad quedan intactos (tests [4] y T173 round-trip 0 inserts/0 deletes).

**6/7. Código**: `errores.ts` (+`ERR_ELIMINAR_BLOQUEADO`), `recepcion-filas.ts` (guard N), `modulos.ts` (pre-guard, conteo real, orden), `RecepcionModule.tsx` (pasa `perfil.id` + toast de aviso, no error rojo: «Guardado incompleto: no se borraron filas»), stub encadenable `delete()`. Estructura: la verificación vive en la capa de datos (una sola fuente), la UI solo interpreta códigos.

**8. Accesos usados**: Supabase Management API (política aplicada + E2E RLS con `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims')` y ROLLBACK: **dueño borra 27, no-dueño 0**), GitHub/Cloudflare (deploy `202610301553-c66cf5f` verificado en `rackly.pages.dev/version.json`).

**Tests**: `test_recepcion_delete_honesto` (9 checks, nuevo) + caso real T173 en `test_recepcion_filas` (120 checks) — **35/35 suites**, tsc/eslint/build verdes.

**Pendiente para el usuario**: la guía corrupta (63 filas) es de Edwin y no tiene envíos de Tránsito → con la política nueva puede eliminarla él mismo desde la app (botón Eliminar), o dejar que un supervisor lo haga.

---
Task ID: 1 (auditoría global 2026-10-31 — Módulos: todos)
Agent: Main Agent
Task: Honestidad de DELETE en TODOS los módulos — fin de los éxitos falsos por RLS (patrón T173-00004281 generalizado)

Work Log:
- Cierre del bug T173-00004281 (guía 16→63 filas al editar): verificado que el fix c66cf5f (RLS recepcion_delete_propia_sin_transito + DELETE honesto + ensamblado de paletas) ya está en producción (a00bc31) y que la BD quedó limpia: la guía duplicada fue eliminada (0 filas), queda la reconstrucción del usuario (22 filas, workaround intencional)
- Paso 3 (no se repite en otras pestañas): barrido de TODO .delete() de src/ + pg_policies → 18 tablas con DELETE por rol filtran EN SILENCIO la misma clase de defecto en RQ, RAL, Kardex, Piso y Catálogo
- Paso 6/7: nuevo src/lib/rackly/eliminacion-honesta.ts (exigirBorradas + avisarBorradoFiltrado, una sola implementación); 21 puntos de delete cubiertos: modulos.ts (4 refactorizados al helper), rq-atencion.ts (eliminarRq + rollback), ral.ts (eliminarRal + rollback), kardex.ts (deleteMovimiento, eliminarMovimientosPorIds con contador honesto, eliminación por ubicación), piso/api.ts (eliminarSector, eliminarMovimiento, eliminarMovimientoConPar, rollbackCabeceras, podarAncla), catalogo.ts (clearCatalogo, podarAnclasPisoSinUso)
- Rollbacks best-effort NO lanzan (convergencia por diseño se preserva) — solo avisan en consola
- Stub: cola FIFO de delete-results + neq/gte/lte/gt/lt/is
- Suite nueva test_eliminacion_honesta_global (9 secciones / 20 checks): RQ, RAL, Kardex, Piso y Catálogo ya NO reportan éxitos falsos
- QA: 36/36 suites, tsc, eslint, build OK; push main → deploy verificado (ba5fcad, 2026-10-30 16:24 UTC)
- Salud BD: 0 items huérfanos (rq/ral/piso), 0 uuid_sync duplicados, 0 residuos sin guia_id, 20/20 tablas con RLS activa y con políticas

Stage Summary:
- 11 archivos, +452/-59 líneas; 2 nuevos (eliminacion-honesta.ts, test_eliminacion_honesta_global.js)
- Clase entera de defectos (éxito falso por RLS silencioso) eliminada en TODOS los módulos
- Deploy: rackly.pages.dev — commit ba5fcad

---
Task ID: 2 (auditoría 2026-10-31 — bug T012-00000192)
Agent: Main Agent
Task: Editar guía reabre la división en paletas COMPLETA — grupos intercalados por el orden SQL

Work Log:
- Evidencia BD: la guía T012-00000192 está ÍNTEGRA (32 filas, UN guardado 18:23:36 UTC: artículo 30233 × 27 paletas lote 090926 + × 5 paletas lote 030926). El dato NUNCA se perdió
- Repro EXACTO con las 32 filas reales: el ensamblado viejo producía los «9 artículos sin división» que reportó el usuario (8 sueltos + 1 fantasma de 2 paletas + 1 de 23) — guardar esa vista habría reescrito/destruido las marcas
- CAUSA: el desempate determinista n_paleta ASC (c66cf5f) intercala dos grupos del mismo artículo con N distinto (1/27, 1/5, 2/27, 2/5… 5/5 antes que 5/27 por id) y filasAItems solo miraba «el item anterior»
- FIX: filasAItems por GRUPOS ABIERTOS con índice esperado (robusto al orden; contratos legados intactos) + NUEVO ordenarFilasGuia (contigüidad 1..N por primera aparición, idempotente) aplicado en listarRecepcionesPorDocumento (detalle/impresión/edición)
- Paso 3: RQ/Atención usa su propio filasAItems 1:1 sin marcas de paleta — sin el defecto
- TESTS: sección [13] con el orden EXACTO de BD (2 items 27+5, lotes, round-trip 32u/0i/0e, contigüidad, idempotencia) — 131 checks; 36/36 suites, tsc, eslint, build OK
- Deploy: 656aaf7 en producción (2026-10-30 18:50 UTC). PAT de remote reconfigurado (token anterior caducó)

Stage Summary:
- 5 archivos, +270/-63; el editor, el detalle y la impresión de rótulos reabren la guía EXACTAMENTE como se registró
- Commit: 656aaf7

---
Task ID: 3 (pedido 2026-10-31 — Módulo Usuarios)
Agent: Main Agent
Task: Permisos granulares por usuario, independientes del cargo/rol

Work Log:
- 1.1/1.2 (error + averiguación): el módulo Usuarios solo manejaba roles todo-o-nada. Hallazgos: (a) sin permisos por usuario; (b) BUG REAL — la UI mostraba "Aprobar" a supervisores (puedeAprobar) pero la RPC aprobar_usuario exigía admin (falso permiso UI/BD, error garantizado al usar); (c) lógica de permisos duplicada en 12 archivos (new Set(ROLES_SUPERVISORES) repetido); (d) tarjetas móviles de UsuariosTab en tema oscuro dentro de contenedores claros
- 2 (causa): permisos acoplados 1:1 al cargo sin tabla de excepciones; reglas client-side sin fuente única; BD duplicando la lista de roles en 19 políticas
- 3 (repetición): mismo patrón en page.tsx, StockTab, CatalogoTab, DescargaTab, RecepcionModule, AtencionModule, RqAtencionPanel, RqDetalle, MovimientosTab, SectoresTab×2, lote.ts, UsuariosTab
- 4 (procedimiento): tabla user_permisos (solo OVERRIDES) + función SQL tiene_permiso() SECURITY DEFINER STABLE (admin→true · override→su valor · defecto→rol) + 18 políticas DELETE ADITIVAS (OR) en 19 tablas + RPC establecer_permiso_usuario con guard; cliente: catálogo único permisos.ts + puede()
- 5 (sin conflictos): políticas aditivas NUNCA restringen lo actual; admin inmutable (anti-lockout, overrides ignorados); recepcion_delete_propia_sin_transito intacta; escritura de overrides SOLO vía RPC (sin políticas INSERT/UPDATE/DELETE en la tabla); movimientos.eliminar unificado con el borrado de stock (eliminarUbicacion borra de movimientos — evita permisos que la BD rechazaría); descartados permisos muertos (stock.eliminar, catalogo.importar)
- 6/7 (experto/ordenado): migración documentada 20261031_permisos_por_usuario.sql; lib/permisos.ts (catálogo + rolConcedePermiso + puede); DialogoPermisos.tsx (checkboxes por módulo, badge Rol/Personalizado, "Restablecer rol", admin bloqueado); RPC wrapper en auth.ts; ROL_LABEL deduplicado (roles-label.ts)
- 8 (accesos): Supabase Mgmt API (migración + verificación E2E: matriz de 12 casos por rol correcta, override concedido/revocado, guard RPC rechaza sin permiso); GitHub push 9b1d175
- 9 (Módulos): Usuarios (transversal: gates activos en Racks, Piso, Recepción, Atención, Catálogo, Descarga)
- Extras: aprobar_usuario/cambiar_rol_usuario/eliminar_usuario ahora aceptan los permisos usuarios.aprobar/usuarios.gestionar_roles (coherencia UI↔BD); protecciones nuevas (no cambiar el acceso PROPIO; admin no admite overrides); puedeEditarLotePerfil (lote granular); contador de excepciones visible en la lista
- QA: tsc OK · eslint OK · 37/37 suites (nueva test_permisos, 80+ checks) · build OK

Stage Summary:
- 23 archivos, +1198/-105; nuevos: permisos.ts, DialogoPermisos.tsx, roles-label.ts, test_permisos.js, migración SQL
- El admin puede marcar por usuario qué puede y qué no puede hacer, independiente del cargo; la BD aplica la MISMA regla (no es solo cosmética)
- Deploy: 9b1d175 en producción (rackly.pages.dev)

---
Task ID: 4 (pedido 2026-10-31 — Módulo Usuarios, trace 1a18e676af27d259)
Agent: Main Agent
Task: CUADRO DE PERMISOS módulo × acción — fin de los bugs del v1 (denegar BLOQUEA de verdad)

Work Log:
- 1.1/1.2 (bug del v1 9b1d175 reproducido y probado): (a) MÓVIL: el pie del diálogo se SUPERPONÍA a la lista (screenshot iPhone); (b) BD: marcar ✗ NO bloqueaba — las 18 políticas *_delete_permiso son PERMISSIVE (OR con las de rol: un supervisor con override seguía borrando) y SELECT/INSERT/UPDATE seguían abiertos a todos; (c) 14 RPCs SECURITY DEFINER saltaban RLS (ningún override las frenaba); (d) el catálogo (10 permisos) no formaba el cuadro Ver/Crear/Editar/Eliminar/Aprobar del modelo del usuario; (e) RqDetalle usaba atencion.eliminar para EDITAR; (f) toast «Permiso restringido» al quitar una excepción
- 2 (causa): arquitectura solo-aditiva (OR nunca restringe) sin capa DENY ni matriz módulo×acción
- 3 (repetición): E2 en las 18 tablas; E3 en todo el catálogo; E4 en Atención/RqDetalle; E5 en las 14 RPCs de escritura (registrar_movimiento_kardex, registrar_traslado_kardex, editar_lote_vencimiento_racks/_piso, piso_registrar_salida/traslado, piso_auto_estructura_sector, rq_crear_completa, rq_atender_lote, rq_revertir_origen, rq_editar_rq, ral_crear_completa, transito_registrar_envio, rackly_reemplazar_movimientos)
- 4/5 (procedimiento sin conflictos): capa DENY = 60 políticas AS RESTRICTIVE (se AND-ean con las permissive de rol, que NO se tocan) + guards dentro de las 14 RPCs (splice de pg_get_functiondef con respaldo scripts/respaldo_rpc_antes_guard_20261031.sql) + marcador de llamada anidada (GUC rackly.en_rpc_interna) para que transito→registrar_movimiento_kardex herede autorización; defaults por rol en permiso_defecto_rol() que REPRODUCEN el comportamiento actual con cero overrides (verificado contra pg_policies); admin inmutable; uniones explícitas: movimientos INSERT ∪ descarga.subir (UP Data), recepcion SELECT ∪ transito.ver, recepcion/atencion UPDATE ∪ .crear (flujos de atender/imprimir)
- 6/7: migración 20261031_permisos_matriz.sql (4 funciones + 60 políticas + 14 guards, aplicada statement a statement con scripts/aplicar_migracion.py aware de dollar-quoting); permisos.ts v2 (27 permisos + MATRIZ 8 módulos × 5 acciones + PERMISO_VER_MODULO); DialogoPermisos v2 = cuadro como el modelo (✓ verde / ✗ rojo / borde azul = excepción, columnas pegajosas, scroll móvil, pie NUNCA superpuesto, toasts correctos); gates por celda: ModulosHome/page (Ver por módulo), MovimientoForm (crear racks), PisoSectoresTab×5 handlers (crear piso), Recepción (registrar/editar), RqAtencionPanel (Nueva RQ/RAL), Tránsito (transferir), Catálogo (crear/editar/eliminar separados), UsuariosTab (eliminar), RqDetalle (editar = atencion.editar)
- 8 (accesos): Supabase Mgmt API (migración + E2E BD scripts/e2e_cuadro_permisos.py 10/10: defaults, DENY bloquea DELETE por RLS con JWT simulado, guard RPC NO_AUTORIZADO, limpieza sin residuos) + navegador E2E (cuadro como modelo, excepción azul guardada, badge contador, denegación en supervisor)
- 9 (Módulos): Usuarios (transversal: Racks, Catálogo, Descarga, Piso, Recepción, Atención, Tránsito)
- QA: tsc OK · eslint OK · 37/37 suites (test_permisos v2: 423 checks) · build OK
- Deploy: dabdca2 en producción (rackly.pages.dev, 2026-10-30 20:43 UTC), verificado con el cuadro en vivo; BD sin overrides residuales tras las pruebas

Stage Summary:
- 15 archivos, +3387/-269; nuevos: migración del cuadro, aplicar_migracion.py, gen_guard_rpc.py, e2e_cuadro_permisos.py, respaldo RPCs
- Marcar ✗ en el cuadro ahora BLOQUEA en la base de datos (RLS RESTRICTIVE + guards RPC), no solo oculta botones; con cero excepciones todo funciona exactamente igual que antes
- Commit: dabdca2
