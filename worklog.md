---
Task ID: verificacion-accesos-20261104
Agent: Main Agent
Task: Verificación de accesos GitHub / Cloudflare / Supabase (pedido del usuario) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el PAT en el remote de git (ghp_CqrC…AJ7N) estaba MUERTO — push «Invalid username or token» (la lectura funcionaba solo por fallback anónimo del repo público); los 4 tokens Supabase MAPI guardados en scripts/ (incl. sb_config.py sbp_fc54…9e2e) devuelven 401 «Invalid access token»; el script audit_accesos.py daba falsos 401 de Cloudflare porque usa /user/tokens/verify (endpoint de usuario) sobre un token de nivel-cuenta
- 2 (causa): el remote fue dejado en una sesión previa con un PAT revocado; los sbp_ (Personal Access Tokens de Supabase) fueron revocados/rotados desde el dashboard; Cloudflare exige verificación a nivel cuenta (/accounts/{id}/tokens/verify) para tokens account-owned
- 3 (repetición): barrido de credenciales en scripts/ — 1 PAT GH, 2 cfat_, 4 sbp_, 0 JWT service_role en local (service_role vive solo como secret de GitHub); anon key viva
- 4/5 (procedimiento sin conflictos): remote reparado con el PAT vivo verificado (ghp_TQGT…VI2W, scopes repo+workflow, push=true); local estaba re-inicializado en 0fde678 (= tip del branch remoto backup/agosto-ocupacion, nada perdido) y quedó 578 commits atrás → git reset --hard origin/main (88c25a7 = producción); sin conflictos con ningún módulo (solo infra)
- 6/7 (código): nuevo scripts/verifica_accesos.py — prueba las credenciales EN USO (remote git, sb_config.py, cf_config.py, anon_key.json) contra sus APIs reales sin imprimirlas; cero cambios en la app
- 8 (accesos): GitHub OK tras reparación (secrets del workflow 5/5: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY + TU_TOKEN_DE_API_CLOUDFLARE + ID_DE_CUENTA_CLOUDFLARE; CI verde — últimos deploys 88c25a7/03a93af/b60c0d4 success); Cloudflare OK (token ACTIVE, Pages rackly OK, producción v=202611021408-88c25a7); Supabase MAPI MUERTO (401 en los 4 sbp_) — diagnósticos SQL por Management API bloqueados hasta nuevo token del dashboard; anon key viva (auth/v1/health 200) → la APP en producción sin impacto
- 9 (módulos): infraestructura (GitHub / Cloudflare / Supabase); app Rackly sin cambios

Stage Summary:
- GitHub: PUSH RESTABLECIDO — el commit de esta entrada es la prueba real de publicación; repo local resincronizado con producción
- Cloudflare: token ACTIVE (verify a nivel cuenta), producción viva; falso negativo documentado para audit_accesos.py
- Supabase: app OK (anon key viva); acceso MAPI para diagnósticos SQL requiere que el usuario genere un nuevo Access Token (Supabase → Account → Access Tokens) y se actualice scripts/sb_config.py
- Continuidad: los traces 1a1976a1b9d39725 (Task 3 auditoría integral), 1a1978d198de5c91 (Task 5 ocupación INC) y 1a19c8089fb5fba5 (Task 6 mapa INC) ya estaban resueltos y desplegados por sesiones previas — el repo local quedó atrás y fue resincronizado

---
Task ID: 3
Agent: Main Agent
Task: Auditoría integral 2026-11-01 — «revisa toda la app que no tenga errores ni bugs» (trace 1a1976a1b9d39725 · Módulos: todos) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): QA baseline verde (tsc 0 · eslint 0 · 39 suites · build) y E2E producción 6/6 módulos sin errores de consola; el barrido estático encontró la CLASE ESPEJO del bug T173 no cubierta: la RLS de UPDATE también FILTRA EN SILENCIO (HTTP 200, 0 filas) — 3 vías CRUD de Catálogo (alta por upsert / edición / borrado) y 4 cambios de estado (cambiarEstadoGuia, cambiarEstadoAtencion, recalcularEstadoRq, recalcularEstadoRal) celebraban escrituras que la BD podía no haber aplicado; colateral: eliminar ítem de catálogo sin verificación ejecutaba la poda del ancla de Piso aunque el DELETE no ocurriera; además cambiarEstadoRecepcion era CÓDIGO MUERTO (0 llamadores) y en BD las RPCs de mantenimiento FEFO (backfill/rebalance de lotes) estaban SECURITY DEFINER, sin guard y con EXECUTE abierto a anon
- 2 (causa): la auditoría 10-31 generalizó la honestidad del DELETE pero no la del UPDATE; el upsert de alta ocultaba que su rama ON CONFLICT UPDATE corre bajo la política de UPDATE (rol sin catalogo.editar → 0 filas → «Ítem agregado» falso)
- 3 (repetición): verificado por barrido completo — atender/revertir RQ-RAL ya usaban guard optimista + maybeSingle verificado; marcarGuiaRecepcionada ya devolvía conteo; guardarEdicionGuia ya contaba exacto; JSON.parse/.single()/catchs restantes todos con guard legítimo; BD sana: RLS 20/20, 0 huérfanos (RQ/RAL/Piso), 0 uuid_sync duplicados, 0 códigos de catálogo duplicados, estados dentro del catálogo
- 4/5 (procedimiento sin conflictos): extender eliminacion-honesta.ts con exigirActualizadas (misma filosofía, una sola implementación) y aplicarla en los 6 puntos; el alta de catálogo se separa en INSERT puro (la RLS de INSERT rechaza CON ERROR, jamás en silencio) vs edición verificada usando la lectura de existencia que ya existía (además PRESERVA stock_big_magic que el upsert habría pisado a 0); RPCs FEFO: REVOKE EXECUTE a anon/authenticated (sin llamadores en la app → impacto cero; service_role/postgres conservan); los llamadores de cambiarEstado* ya envuelven en try/catch con mensajeError → el nuevo error sale como toast claro, sin crash
- 6/7 (código): errores.ts (+ERR_ACTUALIZAR_BLOQUEADO), eliminacion-honesta.ts (+exigirActualizadas), modulos.ts (cambiarEstadoGuia/cambiarEstadoAtencion verificados; cambiarEstadoRecepcion eliminado), rq-atencion.ts/ral.ts (recalcular con verificación — el encabezado ya no queda con estado viejo tras atender por respaldo), CatalogoTab.tsx (3 vías honestas), stub (+cola FIFO __setUpdateData, compatibilidad total), suite test_eliminacion_honesta_global (+[10]/[11], 25 checks), migración scripts/migracion_revoke_fefo_rpc_1101.sql aplicada por Management API (ACL verificado: postgres+service_role; E2E anon → 401 permission denied)
- 8 (accesos): Supabase Management API (migración + verificación E2E), GitHub push, Cloudflare deploy, navegador E2E con cuenta admin
- 9 (módulos): Racks-Catálogo (CRUD honesto), Recepción (estado de guía), Atención (estado de registro), RQ/RAL (estado de encabezado en respaldo), BD (superficie anon cerrada) — Tránsito/Piso/Descarga verificados sin cambios necesarios
- QA final: tsc 0 · eslint 0 · 39/39 suites (honestidad 25 checks) · build OK

Stage Summary:
- Cierre de la CLASE ESPEJO: ninguna escritura visible al usuario (INSERT/UPDATE/DELETE) puede volver a reportar éxito sin efecto real — la app ya no celebra cambios que la BD filtró
- Superficie de ataque BD reducida: RPCs de mantenimiento FEFO ya no ejecutables por anon/authenticated (401 verificado)
- Higiene: código muerto eliminado; alta de catálogo existente ya no pisa stock_big_magic a 0
- Sin regresiones: 39/39 suites; E2E producción 6/6 módulos sin errores de consola

---
Task ID: 2
Agent: Main Agent
Task: Verificación de cierre 2026-11-01 — devoluciones de línea en producción (5d0b1c5) + QA completo del entorno reconstruido

Work Log:
- Sandbox reciclado: repo local quedó en shallow clone huérfano (0fde678 del 25-ago, pre-reinicio de historia) y SIN node_modules → fetch --unshallow + reset --hard origin/main (5d0b1c5 = producción) + npm install
- QA desde cero: 39/39 suites OK · tsc 0 errores · eslint 0 errores (misma salud que el deploy original)
- E2E producción (rackly.pages.dev, admin Miguel Hidalgo): pestañas «Recepción de guías» y «Devoluciones de línea» presentes; pestaña devoluciones lista separada («No hay devoluciones registradas…»), flujo foto «Con foto de RQ» (Tomar foto del RQ / galería) y vía manual con tipo por defecto «Requisición de devolución», Nº RQ, solicitante, OP, línea — sin placa; consola y page errors: 0
- version.json = 202610310051-5d0b1c5 (iteración Atención-identica desplegada y viva)

Stage Summary:
- La tarea trace 1a18f4a2b62c90cd queda VERIFICADA en producción sin regresiones; sin cambios de código en esta pasada (solo reconstrucción del entorno local)
- Sin errores pendientes: el mensaje del usuario llegó con el paso 9 vacío (sin contenido del error) — se ejecutó verificación de cierre de la última tarea activa

---
Task ID: 1
Agent: Main Agent
Task: Devoluciones de línea = RQ con la extracción de ATENCIÓN (trace 1a18f4a2b62c90cd · Módulos: recepción y transito) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el documento de devolución NO es una guía sino un RQ («REQUISICION DE DEVOLUCION DE MATERIAL DISPONIBLE», Nº 0000192967) — la iteración 1 (cd32f6e) lo parseó con el PARSER DE GUÍAS (guia-ocr + extensión esRequisicionDevolucion); el usuario lo corrige: la extracción debe ser IDÉNTICA a la de Atención, que procesa RQs con rq-ocr.ts. Producción verificada = cdb636f; BD ya con tipo_recepcion (CHECK ok, 2.633 filas, 0 devoluciones → cambio de flujo sin migrar datos)
- 2 (causa): el parser de Atención (rq-ocr.ts) ya leía el formato de la devolución (ancla B UNID→CANT con saldo/estado, calibrada con RQ 0000191740) — el error fue re-usar el parser de guías en vez del de RQ
- 3 (repetición): la extensión de devolución en guia-ocr.ts era código muerto tras el cambio → SE REVIERTE guia-ocr.ts a su estado pre-iteración-1 (86 líneas fuera, cero residuo); Atención quedó tocada solo por refactor (mismo pipeline extraído)
- 4/5 (decisión sin conflictos): pipeline OCR de RQ EXTRAÍDO a rq-ocr-runner.ts (2 pases + zoom tabla + zoom encabezado + rigor numérico) consumido por RqFotoForm (Atención) y DevolucionFotoForm (Recepción) — extracción única, sin duplicar 180 líneas; el guardado SIGUE siendo recepcion_registros (transito_registrar_envio, QR por fila, RLS y uuid_sync intactos); SIN migración de BD
- 6 (código): rq-ocr.ts RE_NUM_RQ reconoce «NUMERO REQUISICION : 0000192967»; devolucion-rq.ts (mapeo puro: numeroDocumento=Nº RQ · empresaOrigen=Solicitante · observaciones=OP · Línea · Solicita · Producto · placa=''); DevolucionFotoForm.tsx (flujo elegir→recortar→procesando→confirmar, autocompletado de catálogo igual que Atención, proveedor solo films, rótulos QR por fila + auto-estatus Recepcionado); RecepcionModule (pestaña devoluciones usa DevolucionFotoForm; vía manual con Nº del RQ/Solicitante/OP/Línea y SIN placa; contexto RQ a observaciones); GuiaFotoForm vuelve a ser SOLO guías + guard de permiso recepcion.crear (hueco detectado: la vía foto no lo tenía)
- 7 (QA): tsc 0 · eslint 0 · 39/39 suites · build OK — test_recepcion_devoluciones reescrita (42 checks: OCR del RQ real con el parser de Atención 13 checks, mapeo+alta 10, regresión de guías 4, delimitación/edición/badge 15)
- 8 (accesos): Supabase Management API (verificación de columnas/CHECK/contenido); GitHub + Cloudflare para deploy
- 9 (módulos): Recepción (pestaña devoluciones con extracción Atención + rótulos QR) · Tránsito (verificado, sin cambios — badge 'Devolución' ya operante) · Atención (solo refactor del pipeline, suites rq_* verdes)
- Deploy: commit → version.json; bundle productivo verificado

Stage Summary:
- La pestaña DEVOLUCIONES de línea ahora extrae datos EXACTAMENTE como Atención (mismo pipeline rq-ocr-runner + parser rq-ocr): Nº del RQ, OP, producto, línea, solicitante y tabla de materiales con cantidades de 4 decimales; el documento se registra como RECEPCIÓN (tipo_recepcion='devolucion') separada de guías, con rótulos y QR por fila para pegar en los artículos
- Limpieza de duplicados: guia-ocr.ts revertido (cero lógica de devolución en el parser de guías); un solo pipeline OCR de RQ compartido por Atención y Devoluciones
- Hallazgo colateral corregido: la vía foto de guías ya exige recepcion.crear (antes solo la BD lo bloqueaba al guardar)

---
---
Task ID: 8
Agent: Main Agent
Task: Devoluciones de línea en Recepción — pestaña propia + rótulos QR (trace 1a18f196e42d8cc1 · Módulos: recepción y transito) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el rótulo físico NO imprime el documento — la identidad vive en el QR (recepcionId = fila); zebra.ts/ImprimirRotulosDialog/qr-rotulo.ts funcionan para devoluciones SIN tocar el ZPL calibrado. transito.ts lee recepcion_registros COMPLETA (sin filtro de tipo) → las devoluciones entran a Tránsito de facto. DB: recepcion_registros 2.624 filas sin columna de tipo; 10 políticas RLS; RPCs transito_registrar_envio + recepcion_regularizar_fila operan por id/guia_id (tipo-agnósticas)
- 2 (causa): la función no existía; los 4 puntos de conflicto previstos eran C1 (editar devolución → filas nuevas nacían 'guia' por DEFAULT), C2 (anti-duplicados cruzaban pestañas), C3 (un solo listado mezclaba), C4 (Tránsito sin distinción visual)
- 3 (repetición): RLS/uuid_sync/QR/regularización ya son tipo-agnósticos (nada que duplicar); Actividad (Usuarios) etiquetaba todo como 'Recepción' → ahora distingue 'Devolución'; OCR de guía no conocía el formato requisición
- 4/5 (decisión sin conflictos): UNA tabla + tipo_recepcion ('guia' default | 'devolucion') con CHECK + índice idx_recepcion_tipo_fecha — transito_registrar_envio, QR por fila, RLS y idempotencia siguen operando SIN duplicar lógica (tabla nueva habría exigido RPC+RLS+parser duplicados); se corrigen C1–C4 ANTES de que existan
- 6 (código): migración 20261031_devoluciones_tipo_recepcion.sql (aplicada por Management API, 2.624 filas backfill 'guia'); modulos.ts (TIPO_RECEPCION, TIPOS_DOCUMENTO_DEVOLUCION, filtro/listado, crearRecepciones opciones, edición hereda tipo, Actividad); recepcion-idempotencia (anti-duplicado por pestaña); transito-core (tipoRecepcion + esDevolucion) + badge en Tránsito; RecepcionModule (pestañas guías/devoluciones con listados separados); GuiaFotoForm modo devolucion; guia-ocr reconoce la REQUISICIÓN DE DEVOLUCIÓN DE MATERIAL (formato real foto 2026-10-30: Nº 0000192967, empresa suelta, OP/solicitante → observaciones, tabla UNID→CANT con 4 decimales)
- 7 (QA): tsc 0 · eslint OK · 39/39 suites (nueva test_recepcion_devoluciones 28 checks: tipo en alta/lista/edición, delimitación de anti-duplicados, badge Tránsito, OCR requisición real + no-regresión de guía) · build OK
- 8 (accesos): SQL por Management API; verificación de columnas/constraint/índice/conteo en BD real
- 9 (módulos): Recepción (pestañas + formularios + impresión) · Tránsito (badge devolución) · Usuarios-Actividad (etiqueta)
- Deploy: commit cd32f6e → version.json 202610302353-cd32f6e OK; bundle productivo verificado (tipo_recepcion + 'Devoluciones de línea' en chunk 9f376494)

Stage Summary:
- Nueva capacidad: recepcionar DEVOLUCIONES DE LÍNEA en su propia pestaña (separada de guías) con la MISMA extracción de datos OCR, paletas, estados, Excel, edición y rótulos con QR único por fila para pegar a los artículos de devolución; el escaneo en Tránsito resuelve la fila exacta y la transferencia a Rack/Piso funciona igual (badge 'Devolución' visible)
- El formato físico real (Requisición de devolución AJEPER) se autodetecta: nº de requisición, empresa, orden de producción y solicitante se precargan; la pestaña usa 'Requisición de devolución' como tipo de documento por defecto
- Sin regresiones: 39 suites verdes; guías legacy intactas (default 'guia'); Tránsito/RQ/Racks sin cambios de comportamiento
---

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

---
Task ID: 5 (pedido 2026-11-01 — Racks/Ocupación, trace 1a1978d198de5c91)
Agent: Main Agent
Task: «75 espacios libres — ¿se están contando como libres los espacios ocupados por artículos INC?» — verificación DB + 1 bug real corregido (Tránsito) + textos sin ambigüedad

Work Log:
- 1.1/1.2 (verificación en DB, owjryvcrhpmgtkkdcrkm): los números del resumen son CORRECTOS — occupied=1085 (RPC ocupacion_celdas_v2, que EXCLUYE codigo_inc), INC con stock neto>0 = 41 (1 mixta + 40 solo INC), y Vacías = 1200 − 1085 − 40 = 75: las celdas con INC NO están dentro de las 75. Anti-join contra la grilla oficial (9 bloques × torres × 4 pisos × pos): 0 celdas ocupadas fuera de grilla, 0 INC fuera de grilla, 0 celdas con stock negativo → 1085 + 40 + 75 = 1200 exacto
- 2 (causa de la duda): (a) el subtítulo de la tarjeta VACÍAS decía «Disponibles · 40 con INC» — literalmente sugiere que 40 espacios libres tienen INC (falso: están FUERA de las 75); (b) el subtítulo de OCUPADAS mezclaba «41 con INC (1 ocupadas + 40 solo INC)»; (c) BUG REAL de la misma clase: MapaRackSelector (Tránsito → DialogoTransferir, destino Piso→Rack) usa ocupacionRacks() = RPC v2 SIN merge INC → las 40 celdas solo-INC quedaban con stock 0: se pintaban VERDES «Libre — sin artículo», la sugerencia automática podía preseleccionarlas como destino y el clic NO pedía confirmación de co-ubicación → se podíameter mercadería nueva en una celda físicamente bloqueada por INC
- 3 (repetición en otras pestañas): Piso NO hereda el defecto (RPC piso_stock_sector_grid netea TODOS los movimientos sin excluir INC → sus Vacías ya cuentan INC como ocupado); Ocupación (Racks) ya mergeaba INC correctamente; el Excel exportado ya distingue «Solo INC» de «Vacío»; la leyenda del mapa de Racks (page.tsx) no documentaba el color INC → incluida
- 4/5 (procedimiento sin conflictos): 100% frontend, sin cambios de RPC ni de firmas compartidas — MapaRackSelector gana el MISMO merge que ya usa OcupacionTab (buildCellMap como referencia); SeleccionRack gana campo OPCIONAL incItems (los callers existentes no se rompen); el convenio de colores queda idéntico en ambos mapas (INC rosado gana a azul/naranja, respetando selección y marca mismo-código)
- 6/7 (implementación ordenada): MapaRackSelector — helpers tieneIncActiva/esCeldaLibre/fusionarInc (documentados), cargar() con Promise.all(ocupacionRacks, fetchIncPorUbicacion), sugerencia SOLO celdas sin stock ni INC, clic en celda INC = ocupada + confirmación de co-ubicación con detalle «INC pendiente de disponer», tooltip INC con códigos/cantidades, leyenda «Con INC (no libre)»; OcupacionTab — VACÍAS «Sin stock ni INC · N INC aparte», OCUPADAS «N con INC», ecuación visible «1085 + 40 INC + 75 = 1200» bajo la barra de %, eliminadas variables muertas con semántica incorrecta (bEmpty sin descontar INC, tInc sin uso)
- 8 (accesos): DB verificada por Supabase Mgmt API (definiciones de ocupacion_celdas/_v2/piso_stock_sector_grid + conteos reales); navegador E2E en producción con cuenta propia: login OK, pestaña Ocupación muestra los textos nuevos y la ecuación, console/page errors = 0
- 9 (Módulos): Racks/Ocupación + Tránsito (mapa de destino) — transversal a Piso solo en verificación
- QA: tsc 0 · eslint 0 · 39/39 suites · build OK · push 0f09ca2 · producción version.json = 202611011454-0f09ca2

Stage Summary:
- 4 archivos, +97/−21: MapaRackSelector.tsx (INC nunca libre ni sugerido), OcupacionTab.tsx (textos + ecuación + limpieza), page.tsx (leyenda), version-sello.ts (auto)
- Respuesta al reporte: los 75 libres NO incluyen espacios con INC (verificado fila a fila en DB); el resumen era correcto pero su texto inducía a la duda, y el MISMO criterio sí estaba mal en el mapa de Tránsito — ahí sí se podía elegir/sugerir una celda con INC como destino; ambos quedan alineados con el convenio «INC = ocupada, no libre»
- Deploy: 0f09ca2 en producción (rackly.pages.dev, 2026-11-01 14:54 UTC)

---
Task ID: 6 (pedido 2026-11-02 — Racks, trace 1a19c8089fb5fba5)
Agent: Main Agent
Task: «los INC les sale con color verde en vez de rosado» — causa raíz (consulta INC que falla) corregida en los 2 mapas que la comparten

Work Log:
- 1.1/1.2 (averiguación): la regla de render es y era correcta (isInc → rosado). El verde era REAL e intermitente: el mapa INC se consulta APARTE (fetchIncPorUbicacion) y al fallar devuelve un mapa vacío con _error=true (no lanza) → el merge no aportaba nada y las celdas solo-INC caían a la rama «Vacío» (verde). Segunda vía: el fallback RPC v1 de Ocupación hacía setOcupacion(celdas) SIN fusionar INC. Con el polling de 10 s, cualquier fallo transitorio de red/BD («tema de internet») pintaba el mapa sin INC hasta el siguiente ciclo, y el toast que avisaba se perdía
- 2 (causa): el estado «INC desconocido» se representaba como «Vacío» — un verde que PROMETE «sin stock ni INC» cuando en realidad no se sabía
- 3 (repetición): MapaRackSelector (Tránsito → transferencias) tenía el MISMO hueco vía _error: tras el fix de Task 5 seguía fusionando bien en el camino normal, pero con consulta INC caída las celdas solo-INC volvían a «Libre» y la sugerencia automática podía preseleccionarlas como destino. Verificados y a salvo: MapaPisoSelector (RPC piso netea INC como ocupado), leyenda de Racks (texto estático), StockIncTab (lista, no mapa)
- 4/5 (procedimiento sin conflictos): 100% frontend, sin cambios de RPC ni de firmas — (a) lib compartida mapa-inc.ts: fusionarIncEnCeldas (UNA implementación del merge para los dos mapas, reemplaza buildCellMap + fusionarInc duplicadas) y fetchIncPorUbicacionConReintento (1 reintento automático a ~800 ms absorbe los fallos transitorios dentro del mismo ciclo; _truncated no se reintenta); (b) si aún así falla, honestidad en vez de mentira: banner ámbar persistente + celdas «vacío» en gris neutro con tooltip «INC desconocido» (nunca verde), ecuación y contadores INC marcados «no verificado»; (c) MapaRackSelector en modo «INC no verificado»: SIN sugerencia automática, tooltip «¿Libre? — datos INC no disponibles» y confirmación obligatoria al elegir cualquier celda (diálogo adaptado: «Estado INC no verificado» / «Sí, usar de todos modos»)
- 6/7 (experto/ordenado): eliminadas las dos copias del merge; clave canónica única (claveCelda = claveCeldaRack); incError se setea/cleara en TODOS los caminos (RPC v2, client-side, fallback v1); dataSource muestra «· INC falló»; banner se limpia solo al ciclo siguiente exitoso
- 8 (accesos): E2E en producción con cuenta propia (login → Racks → Ocupación): Total 1,200 · Ocupadas 1077 · Vacías 83 · Con INC 41 · ecuación «1077 + 40 INC + 83 = 1200» visible, SIN banner (consulta INC OK con reintento activo); 40/40 celdas solo-INC pintadas rosado (clase rose verificada por DOM), tooltips con código/codigoInc/cantidad; console errors = 0, page errors = 0
- 9 (Módulos): Racks/Ocupación + Tránsito (MapaRackSelector) — transversal: mapa-inc.ts compartido
- QA: tsc 0 · eslint 0 · 40/40 suites (nueva test_mapa_inc: 8 checks) · build OK · push 03a93af · producción version.json = 202611021400-03a93af

Stage Summary:
- 5 archivos, +318/−96: mapa-inc.ts (nuevo, merge único + reintento), OcupacionTab.tsx (fallback con merge + banner + celdas grises honestas), MapaRackSelector.tsx (modo INC no verificado), test_mapa_inc.js (nuevo), run_all_tests.sh (registro)
- Respuesta al reporte: no era «internet del usuario» ni un color mal definido — era la consulta INC cayendo de forma intermitente y el mapa pintando «Vacío» lo que no podía verificar; ahora el fallo transitorio se reintenta solo y, si persiste, la app lo DICE (banner) y no pinta libres las celdas que no puede verificar
- Deploy: 03a93af en producción (rackly.pages.dev, 2026-11-02 14:00 UTC)
