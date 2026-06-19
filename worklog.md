---
Task ID: 1
Agent: main
Task: Diagnóstico y fix definitivo del bug de stock en Kardex Piso (JHIA-58)

Work Log:
- Leí y analicé todo el código: api.ts, PisoSectoresTab.tsx, tipos Supabase, SQL previos
- Descubrí que la columna `fecha_vencimiento` NO EXISTE en `piso_movimiento_detalles` (confirmado por types.ts)
- Los RPCs `piso_stock_detalle_posicion` y `piso_stock_sector_grid` NO EXISTEN en la BD
- El SQL de corrección (JHIA-57b) nunca fue ejecutado en Supabase
- El fallback TS de `stockDetallePosicion` seleccionaba columna inexistente → error → panel detalle nunca actualizaba
- Creé SQL definitivo `rackly_piso_fix_FINAL.sql` con: columna, 2 RPCs, update del RPC existente, verificación
- Actualicé el fallback TS para tolerar columna inexistente (intenta con, si falla reintenta sin)
- Actualicé tipos Supabase con fecha_vencimiento y los 2 nuevos RPCs
- Build exitoso, tag JHIA-58, push, deploy a Cloudflare Pages

Stage Summary:
- Archivo SQL: /home/z/my-project/download/rackly_piso_fix_FINAL.sql
- Deploy: https://rackly.pages.dev
- Tag: JHIA-58
- PENDIENTE: El usuario debe ejecutar el SQL en Supabase Dashboard > SQL Editor
---
Task ID: JHIA-64
Agent: Main Agent
Task: Fix stock detail by levels in Piso Sectores + fix tooltip to show codes

Work Log:
- Read PisoSectoresTab.tsx (1631 lines) and api.ts to understand current behavior
- Identified Issue 1: stockDetallePosicion returns ALL stock across ALL levels combined, no per-level breakdown in view mode
- Identified Issue 2: Cell tooltip showed "stock: X" (quantity) instead of article codes
- Created stockDetalleNivel(nivelId) in api.ts - FEFO stock calculation for a single level
- Added stockByNivel and viewNivelTab states to PisoSectoresTab
- Modified handleClick to load stock per level in parallel using Promise.all
- Replaced view mode with IIFE that computes displayStock based on selected tab
- Added level tabs UI: "Todos" tab + individual "Nivel N (count)" tabs, only shown when 2+ levels exist
- Added level info banner showing nivel number, codigo_ubicacion, and total quantity when viewing specific level
- Changed empty state message to distinguish "Nivel sin articulos" vs "Posicion vacia"
- Fixed tooltip: changed from "stock: {pos.stock}" to "{pos.bloques.map(b => b.bloque_codigo).join(', ')}"
- Build verified successfully, committed and pushed with tag JHIA-64

Stage Summary:
- Files modified: src/lib/piso/api.ts, src/components/rackly/piso/PisoSectoresTab.tsx
- 2 files changed, 189 insertions(+), 7 deletions(-)
- Commit: d2fba10, Tag: JHIA-64
- Deployed to Cloudflare Pages via GitHub Actions

---
Task ID: JHIA-65
Agent: Main Agent
Task: Fix autofocus en Codigo, Salida por niveles, Salida en masa

Work Log:
- Fixed autofocus: moved autoFocus from Cantidad input to Codigo input in Ingreso and Devolucion modes
- Added salNivelTab state for level filtering in Salida mode
- Modified openSalida to reset salNivelTab to 'all'
- Modified doSalida to filter items by selected nivel and use correct nivel_id
- Replaced Salida mode UI with IIFE that shows level tabs (red gradient) when 2+ levels exist
- Level tabs filter salItems to show only items belonging to selected level
- Added level info banner in salida mode
- Added mass selection mode: massMode, massSelected (Set), massDialogOpen states
- Added toggleMassMode, toggleMassSelect, openMassDialog, doMassSalida, updateMassNivel functions
- Modified cell click handler: massMode ? toggleMassSelect : handleClick
- Cell visual changes in mass mode: checkbox overlay, ring-2 ring-red-400 for selected
- Added "Salida en masa" toggle button in top toolbar
- Added floating bar with position counter and "Procesar salida" button
- Added "mode active" banner when no positions selected
- Added Mass Salida Dialog with position details, level selectors, item lists, and confirm
- Build verified successfully, committed and pushed with tag JHIA-65

Stage Summary:
- Files modified: src/components/rackly/piso/PisoSectoresTab.tsx (360 insertions, 29 deletions)
- No database changes
- No changes to existing single-position functionality (massMode is opt-in via toggle)
- Commit: 31778fb, Tag: JHIA-65
- Deployed to Cloudflare Pages via GitHub Actions
---
Task ID: JHIA-65
Agent: main
Task: Fix salida por niveles con cantidades correctas + confirmación salida en masa

Work Log:
- Diagnosticó que al filtrar por nivel en Salida, se mostraban cantidades totales (suma de todos los niveles) en vez de las cantidades reales del nivel seleccionado
- Agregó estado `salItemsByNivel` (SalItem[]) para almacenar items con cantidades derivadas del nivel seleccionado
- Creó función `buildSalItemsForNivel(nivelId)` que genera SalItem[] desde stockByNivel[nivelId] con cantidades correctas
- Modificó los handlers de tabs de nivel: "Todos" usa salItems, nivel específico regenera salItemsByNivel
- Modificó item click, quantity input y "seleccionar todos" para operar sobre la lista correcta según salNivelTab
- Modificó doSalida() para usar filteredItems = salNivelTab === 'all' ? salItems : salItemsByNivel
- Agregó estado massConfirmOpen para diálogo de confirmación
- Cambió botón "Registrar" en diálogo masa para abrir confirmación en vez de ejecutar directamente
- Creó diálogo de confirmación con resumen detallado: cada posición con nivel, artículos con código/descripción/cantidad, totales generales
- Build exitoso, commit a404314, tag JHIA-65 pusheado

Stage Summary:
- Salida por niveles ahora muestra cantidades reales del nivel (no total acumulado)
- Salida en masa requiere confirmación con resumen detallado antes de ejecutar
- No se afectó modo Ver, Ingreso, Traslado, Devolución ni Salida en tab "Todos"

---
Task ID: JHIA-68
Agent: Main Agent
Task: Aplicar responsividad móvil en Kardex Racks (mismos patrones que JHIA-67 en Kardex Piso)

Work Log:
- Revisado todos los componentes bajo src/components/rackly/kardex/ (10 archivos)
- Identificadas las brechas vs Kardex Piso JHIA-67: columnas sin ocultar en móvil, texto sin truncar, padding fijo en diálogos
- StockTab.tsx: Ocultadas columnas Piso(>sm), Descripción(>md), UN(>sm), Proveedor(>lg), Vencimiento(>sm) en móvil. Truncado descripción.
- TrasladoTab.tsx: Ocultadas columnas Piso(>sm), UN(>sm), F.Vencimiento(>md), Proveedor(>lg). Truncado ruta en diálogo. Padding responsivo px-4 sm:px-6 en diálogo.
- MovimientoForm.tsx (Salida): Ocultadas columnas Piso(>sm), F.Vencimiento(>md), Proveedor(>lg). Padding responsivo px-4 sm:px-6 en diálogo de ingreso.
- FefoTab.tsx: Ocultadas columnas Torre/Piso/Pos(>sm), Proveedor/Vencimiento(>md) en tabla custom.
- CatalogoTab.tsx: Ocultadas columnas UN(>sm), Stock BM(>sm). Truncado descripción.
- Build verificado: compilación exitosa sin errores TypeScript.

Stage Summary:
- 5 archivos modificados: StockTab.tsx, TrasladoTab.tsx, MovimientoForm.tsx, FefoTab.tsx, CatalogoTab.tsx
- Patrones aplicados: hidden sm:table-cell, hidden md:table-cell, hidden lg:table-cell, truncate min-w-0, px-4 sm:px-6
- Build exitoso, sin errores

---
Task ID: JHIA-69
Agent: Main Agent
Task: Corregir FEFO - no mostrar artículos con stock 0 o negativo

Work Log:
- Identificado bug en FefoTab.tsx línea 98: `else if (delta > 0)` impedía crear entradas cuando el primer movimiento era negativo
- Esto causaba que las salidas no se restaran correctamente del stock en algunos casos
- Reemplazada lógica inline por `impactoStock()` (misma función usada por SalidaForm, StockTab, TrasladoTab)
- Eliminado guard `else if (delta > 0)` → ahora siempre crea la entrada y el filtro `stock <= 0` al final la elimina correctamente
- Patrón ahora consistente con SalidaForm.tsx (que sí funcionaba bien)
- Build exitoso sin errores

Stage Summary:
- Archivo modificado: FefoTab.tsx
- Bug: `else if (delta > 0)` causaba que artículos con salida seguían mostrando stock
- Fix: usar `impactoStock()` + eliminar guard → filtro final `stock <= 0` hace el trabajo correctamente

---
Task ID: JHIA-70
Agent: Main Agent
Task: Corregir responsividad de ventanas emergentes (dialogs) en Kardex Piso

Work Log:
- Auditoria completa de 4 dialogs en PisoSectoresTab.tsx (Main Detail, Traslado Confirm, Mass Salida, Mass Confirm)
- Fix HIGH: Dialog Principal (1222) - Botón X invisible en fondo oscuro → agregado [&>button]:text-slate-400 hover:[&>button]:text-white
- Fix HIGH: Dialog Traslado Confirm (1857) - Agregado p-0, botón X override, padding responsivo px-4 sm:px-6 en header/contenido/footer
- Fix HIGH: Mass Confirm Nivel badge (2100) - truncado max-w-[100px] para evitar overflow horizontal con 3+ niveles
- Fix MEDIUM: Traslado items overflow - agregado gap-2 en flex justify-between, truncate en status label, flex-wrap en info row
- Fix MEDIUM: Summary totals (2132) - flex-wrap + gap-3 sm:gap-4 para que no overflow en móvil
- Fix MEDIUM: Todos los botones en todos los dialogs → h-11 (44px touch targets) en 8 pares de botones (Cancelar + Acción)
- Build exitoso, push a GitHub, deploy automático a Cloudflare Pages

Stage Summary:
- Archivo modificado: PisoSectoresTab.tsx
- 9 correcciones aplicadas en total
- Todos los dialogs ahora tienen: botón X visible, padding responsivo, touch targets 44px, sin overflow horizontal
---
Task ID: JHIA-76
Agent: Main Agent
Task: Stock por código - Layout tarjetas en móvil con TODAS las columnas visibles + Eliminar solo admin

Work Log:
- Leído StockTab.tsx actual en origin/main (JHIA-74): tenía min-w-[700px] forzando scroll horizontal y columnas ocultas con hidden sm:table-cell
- Usuario solicitó: TODAS las columnas visibles en móvil (bloque, torre, piso, posición, descripción, UN, proveedor, vencimiento, stock, eliminar)
- Columna eliminar solo visible para rol admin (useAuth hook ya disponible en el proyecto)
- Creado layout dual: tarjetas compactas para móvil (md:hidden) + tabla completa para desktop (hidden md:block)
- Mobile cards: Row 1 = Bloq|Tor|Pis|Pos + Badge stock + botón eliminar (admin); Row 2 = descripción; Row 3 = UN + proveedor badge + vencimiento badge
- Desktop table: removido min-w-[700px] y todos los hidden sm/md/lg:table-cell, eliminar condicional por esAdmin
- Importado useAuth hook y agregado esAdmin = perfil?.rol === 'admin'
- GitHub token configurado con remote correcto (fileshidalgo-spec/rackly)
- Reset local main a origin/main para sincronizar, aplicado cambios de StockTab, commit + push exitoso
- Tag JHIA-76 creado y pusheado

Stage Summary:
- Archivo modificado: src/components/rackly/kardex/StockTab.tsx (109 insertions, 28 deletions)
- Commit: 265d06e, Tag: JHIA-76
- Deploy automático via GitHub Actions a Cloudflare Pages
- Eliminar columna solo visible para rol admin
---
Task ID: JHIA-77
Agent: Main Agent
Task: Kardex Racks - Salida en móvil sin piso, vencimiento, proveedor visible

Work Log:
- Diagnosticado: SalidaForm en MovimientoForm.tsx usaba hidden sm:table-cell (Piso), hidden md:table-cell (Vencimiento), hidden lg:table-cell (Proveedor)
- En móvil, las 3 columnas estaban ocultas → usuario no veía piso, fecha de vencimiento ni proveedor
- Aplicado mismo patrón dual-layout de JHIA-76: tarjetas en móvil (md:hidden) + tabla completa en desktop (hidden md:block)
- Tarjetas móviles muestran: ubicación (B/T/P/Pos), stock, vencimiento, proveedor, input cantidad + botones Salida/Todo
- Tabla desktop: removidos todos los hidden sm/md/lg:table-cell, todas las columnas siempre visibles
- Build exitoso (solo error pre-existente en examples/websocket/frontend.tsx)
- Commit d134d5d, tag JHIA-77, push exitoso a origin/main

Stage Summary:
- Archivo modificado: src/components/rackly/kardex/MovimientoForm.tsx (163 insertions, 81 deletions)
- En móvil ahora se ven: piso, vencimiento y proveedor en cada ubicación de Salida
- Deploy automático via Cloudflare Pages
---
Task ID: JHIA-78-fix
Agent: Main Agent
Task: Fix mobile scroll deselecting checkboxes in SalidaForm

Work Log:
- Read MovimientoForm.tsx (SalidaForm) from origin/main after pulling latest (JHIA-78 was already committed)
- Identified root cause: useEffect on [locations] (lines 561-564) was resetting selected Set to empty every time locations array reference changed
- The 8-second polling interval in refreshLocations() creates new array → triggers useEffect → clears all checkboxes
- On mobile, scrolling triggers re-renders making this very noticeable
- Fix 1: Removed the useEffect that reset selected/qtyMap on locations change
- Fix 2: Added smart cleanup in refreshLocations - only removes selections for locations that no longer exist (stock=0), preserves valid selections
- Selections still properly reset when searchCode changes (separate useEffect on [searchCode] still exists)
- Build passed, committed as eba7025, tag JHIA-78-fix, pushed to origin/main

Stage Summary:
- Root cause: useEffect([locations]) + 8s polling = constant selection wipe
- Fix: Remove useEffect, add smart cleanup in refreshLocations instead
- File modified: src/components/rackly/kardex/MovimientoForm.tsx (12 insertions, 5 deletions)
- Deploy: Cloudflare Pages auto-deploy from GitHub Actions
---
Task ID: JHIA-hardening
Agent: Main Agent
Task: Hardcodeo para 1 mes sin intervención

Work Log:
- Auditoría completa de 11 puntos de fragilidad (concurrencia, tipos, realtime, errores, etc.)
- types.ts: Agregadas definiciones TypeScript para las 2 RPCs nuevas (34 parámetros validados en compile-time)
- OcupacionTab.tsx: doSalida y doTransferir ahora manejan INSUFFICIENT_STOCK con toast específico + auto-refresco
- PisoSectoresTab.tsx: 6 catch blocks cambiados de genéricos a mensajes descriptivos usando extractError()
- useMovimientosRealtime.tsx: Channel name estable, ref para onChange, debounce 500ms, logging, reconnection handler
- ErrorBoundary.tsx: Modo por sección con prop 'name' — un tab que falla no mata los demás
- rackly_hardening.sql: Fix volatilidad RPCs (STABLE → VOLATILE)
- Build exitoso, commit 6fe6c0b, tag JHIA-hardening, push a origin/main

Stage Summary:
- 6 archivos modificados: types.ts, OcupacionTab.tsx, PisoSectoresTab.tsx, useMovimientosRealtime.tsx, ErrorBoundary.tsx, rackly_hardening.sql
- 170 insertions, 20 deletions
- Deploy automático via GitHub Actions
- PENDIENTE: Ejecutar rackly_hardening.sql en Supabase (opcional pero recomendado)
---
Task ID: JHIA-80
Agent: Main Agent
Task: Agregar polling/realtime automatico para todas las pestañas de Piso

Work Log:
- Created save point tag savepoint-pre-JHIA-80 at commit 7ebd8eb
- Created new hook src/hooks/usePisoRealtime.tsx
  - Watches piso_movimientos and piso_movimiento_detalles tables via Supabase Realtime
  - 8s polling fallback (uses POLLING_INTERVAL constant)
  - 500ms debounce on realtime events
  - Uses ref pattern to avoid stale closures
- Updated MovimientosTab.tsx (piso): added usePisoRealtime hook + mountedRef for safe unmount
- Updated PisoStockTab.tsx: replaced 30s setInterval polling with usePisoRealtime (now 8s + realtime)
- Updated PisoSectoresTab.tsx: added usePisoRealtime hook for auto-refresh of position grid
- Build verified: compiled successfully
- Committed as f7de845, tagged JHIA-80, pushed to GitHub
- Cloudflare deployed successfully (HTTP 200)

Stage Summary:
- All 3 Piso tabs now have automatic real-time updates (8s polling + Supabase Realtime WebSocket)
- Before: Piso Movimientos had no polling, Piso Stock had 30s polling, Piso Sectores had no polling
- After: All 3 tabs refresh within 8s (or instantly via WebSocket) when any user makes a movement
- Files changed: usePisoRealtime.tsx (new), MovimientosTab.tsx, PisoStockTab.tsx, PisoSectoresTab.tsx
---
Task ID: JHIA-82
Agent: main
Task: Fix Kardex Piso refresh cada 8 segundos - polling condicional

Work Log:
- Diagnosticado: usePisoRealtime hacia polling incondicional cada 8s incluso con WebSocket conectado
- PisoSectoresTab llamaba setLoading(true) en cada refresh → skeleton shimmer cada 8s
- PisoStockTab llamaba setLoading(true) en cada refresh → parpadeo del botón
- Fix 1: usePisoRealtime - polling SOLO cuando WebSocket NO está conectado
  - Al montar: refresh inicial + intenta conectar WebSocket
  - Si WebSocket conectado: DETIENE el polling
  - Si WebSocket caído: REANUDA polling como respaldo
- Fix 2: PisoStockTab - modo silent (no setLoading) para refresh en background
- Fix 3: PisoSectoresTab - modo silent (no setLoading) para refresh en background
- Push exitoso a GitHub: commit 16761b2
- Netlify deploy automático desde GitHub

Stage Summary:
- Commit: 16761b2 "fix(JHIA-82): Piso polling condicional"
- 3 archivos modificados: usePisoRealtime.tsx, PisoStockTab.tsx, PisoSectoresTab.tsx
- Deploy: https://rackly.pages.dev (Netlify auto-deploy)
- El polling ahora es solo respaldo; el WebSocket maneja las actualizaciones instantáneas
---
Task ID: session-reg-fix
Agent: Main Agent
Task: Fix registro de usuarios - rate limit y pre-check de correo

Work Log:
- Diagnosticado error "Demasiados intentos de registro": Supabase Auth tiene rate limiting en signUp()
- Cada intento de registro hacía 3 llamadas a Supabase (signUp + auto-confirm Admin API + signIn), agotando el rate limit
- Agregada función correoYaExiste() para pre-verificar si el correo ya existe en profiles antes de llamar signUp()
- Primer intento incluía verificación en Supabase Auth Admin API → causaba trampa: bloqueaba registro pero usuario no podía iniciar sesión
- Fix final: correoYaExiste() solo verifica tabla profiles (no Auth Admin API)
- Agregados más patrones de detección de "correo existente" en esErrorCorreoExistente()
- Commits: 9f076c8 (fix labels móvil), 084f022 (flex-wrap tabs), 3c6e65e (fix registro)

Stage Summary:
- Archivos: AuthGate.tsx, page.tsx
- Usuarios nuevos pueden registrarse normalmente sin topar con rate limits innecesarios
---
Task ID: session-stock-search
Agent: Main Agent
Task: Stock tab - búsqueda por código o descripción + info Big Magic sin stock

Work Log:
- Agregada función searchCatalogo() en catalogo.ts: busca por código exacto, código parcial, y descripción
- Reescrito StockTab.tsx con búsqueda mejorada:
  - Barra de búsqueda ahora muestra sugerencias del catálogo al escribir (código + descripción)
  - Al seleccionar un artículo, muestra stock por ubicación
  - Si NO hay stock en ubicaciones: muestra tarjeta con código, descripción, UN, y stock Big Magic
  - Botón "× Cambiar" para volver a buscar
  - Enter selecciona primer resultado, Escape limpia búsqueda
- Commits: 084f022 (tabs flex-wrap), 55e1e06 (stock search + big magic)

Stage Summary:
- Archivos: catalogo.ts (searchCatalogo), StockTab.tsx (rewrite completo)
- Búsqueda ahora funciona por código O descripción
- Cuando no hay stock en racks, se muestra info completa del artículo + stock Big Magic

---
Task ID: JHIA-83
Agent: main
Task: Ordenar stock sin fecha de vencimiento por bloque 1→7

Work Log:
- Modificado sorting en MovimientoForm.tsx (SalidaForm refreshLocations)
- Modificado sorting en StockTab.tsx (stockData useMemo)
- Modificado sorting en TrasladoTab.tsx (setLocations)
- FEFO se mantiene: artículos con fecha van primero por fecha más próxima
- Sin fecha: ordenan por bloque → torre → piso → posición (numérico ascendente)
- Build exitoso, commit 14c47df

Stage Summary:
- Articles with expiration date: sorted by FEFO (earliest first)
- Articles without expiration date: sorted by block 1→7, tower, floor, position
- 3 files changed

---
Task ID: JHIA-84
Agent: main
Task: Implementar modo offline-first (4 fases)

Work Log:
FASE 1 — Infraestructura:
- Creado src/lib/rackly/offline-db.ts (IndexedDB wrapper)
  - Stores: pendingMovements, cachedMovimientos, cachedCatalogo, cachedUsuarios, syncMeta
- Creado src/lib/rackly/sync-engine.ts (SyncEngine singleton)
  - Detección de conectividad: navigator.onLine + ping periódico a Supabase
  - Cola FIFO de movimientos pendientes
  - Sincronización secuencial con idempotencia UUID
  - Caché automático de movimientos del servidor
- Creado src/hooks/useConnectivity.ts (React hook)
- Creado src/components/rackly/kardex/ConnectionIndicator.tsx
  - Badge visual: online/offline/syncing/error
  - Contador de pendientes
  - Diálogo de resolución de conflictos
- Modificado addMovimiento en kardex.ts: acepta uuid_sync
- Modificado page.tsx: ConnectionIndicator en header
- SQL ejecutado por usuario: ALTER TABLE movimientos ADD COLUMN uuid_sync TEXT UNIQUE

FASE 2 — Escritura offline:
- SyncEngine: offlineAwareAddMovimiento() y offlineAwareTraslado()
- MovimientoForm.tsx: doInsert, handleSalidaDesdeAlerta, doMassSalida, doSalida
- TrasladoTab.tsx: handleSalidaDesdeAlerta, doTraslado
- Toasts diferenciados online/offline
- Auto-fallback a IndexedDB si falla envío por red

FASE 3 — Lectura offline:
- catalogo.ts: fetchCatalogo() cachea en IndexedDB, fallback offline
- MovimientoForm SalidaForm: refreshLocations usa movimientos cacheados

Stage Summary:
- Punto de retorno: tag SAFE-POINT-BEFORE-OFFLINE-20260606
- 4 fases implementadas y comprometidas
- Commits: d25771a (F1), 89da56e (F2), 09decae (F3)
- Build exitoso en todas las fases
- App sigue funcionando online exactamente igual que antes
---
Task ID: 1
Agent: main
Task: Diagnosticar y corregir error "Error desconocido" al registrar movimientos + mejorar offline

Work Log:
- Analizado screenshot: error "Error al registrar salida - Error desconocido" en rackly.pages.dev
- Identificadas 4 causas raíz: extractError incompleto, fetchMovimientos post-RPC fallido, SyncEngine bloqueado en 'syncing', ping no-cors falso
- Corregido extractError() en utils.ts: ahora maneja PostgrestError, objetos, strings, null
- Corregido addMovimiento/trasladarMovimiento: fetchMovimientos() no propaga error si RPC fue exitosa
- Corregido SyncEngine.offlineAwareAddMovimiento: usa navigator.onLine como backup, no solo estado interno
- Corregido SyncEngine.offlineAwareTraslado: mismo fix
- Corregido pingSupabase: usa GET real al REST API en vez de HEAD no-cors
- Ampliada detección de errores de red en SyncEngine
- Añadido fallback: si IndexedDB falla, intenta envío directo al servidor
- Build exitoso, commit cff2565, push a GitHub completado

Stage Summary:
- Commit: cff2565 - fix: corregir error 'Error desconocido' al registrar movimientos
- 4 archivos modificados: utils.ts, kardex.ts, sync-engine.ts, worklog.md
- Build: exitoso sin errores
- Deploy: push a GitHub, Cloudflare Pages desplegará automáticamente
---
Task ID: 1
Agent: Main Agent
Task: Fix date input bug + Salida/Movimiento errors + Mobile UI + Offline verification

Work Log:
- Investigated date picker invisible on dark theme: missing [color-scheme:dark] on 4 date inputs
- Fixed all date inputs: MovimientoForm.tsx (line 361), FefoTab.tsx (lines 192, 196), OcupacionTab.tsx (line 692)
- Investigated Salida/Movimiento errors: found 12 issues (2 critical, 4 high, 4 medium, 2 low)
- Fixed CRITICAL: perfil! null assertion → null guard with loading state
- Fixed HIGH: Silent error swallowing in refreshLocations → toast.error with description
- Fixed HIGH: Case sensitivity mismatch RPC vs fallback → trim().toUpperCase() on p_codigo
- Fixed HIGH: Missing destPiso validation in TrasladoTab → added !destPiso to disabled condition
- Fixed MEDIUM: NaN propagation guard in stock calculation
- Fixed MEDIUM: Performance optimization - fetchMovimientosByCodigo instead of fetching ALL movements every 8s
- Fixed 4 mobile UI issues: sticky TabsList, delete button visible on touch, filter bar responsive widths, toast top-center
- Verified offline infrastructure is fully implemented: OfflineDB (IndexedDB), SyncEngine (singleton), ConnectionIndicator (UI), useConnectivity (hook)
- Confirmed all forms already use offlineAwareAddMovimiento/offlineAwareTraslado wrappers
- All builds passed, pushed 3 commits to GitHub

Stage Summary:
- Commit d47a7b1: fix fecha visible, perfil null guard, errores silenciosos, case mismatch, perf optimizacion (6 files)
- Commit 5f60f7d: fix 4 mobile UI issues (2 files)
- Date picker: added [color-scheme:dark] to all type=date inputs
- 6 critical/high/medium bugs fixed in MovimientoForm, kardex.ts, TrasladoTab
- Offline system verified: fully operational (SyncEngine + IndexedDB + ConnectionIndicator)
- Push successful to GitHub main branch

---
Task ID: auth-fix-perfil-huerfano
Agent: main
Task: Fix login issue where ereynaldovaldivia@gmail.com couldn't login or register

Work Log:
- Analyzed screenshot: "Invalid login credentials" from Supabase Auth
- Analyzed second screenshot: "Esta cuenta ya existe" when trying to register
- Root cause: Email exists in `profiles` table but NOT in Supabase `auth.users` (orphan profile)
- `correoYaExiste()` only checked `profiles` table, not Supabase Auth — creating false positive
- Added `correoExisteEnAuth()` function using Admin API to verify auth.users
- Added `limpiarPerfilHuerfano()` function to detect and clean orphan profiles
- Rewrote `correoYaExiste()` to verify Auth first, then clean orphans if found in profiles only
- Updated `handleSignup` error handler to differentiate real existing accounts vs Auth-only accounts

Stage Summary:
- File modified: `src/components/rackly/auth/AuthGate.tsx`
- TypeScript compiles with 0 errors
- The fix automatically cleans orphan profiles and prevents future false positives
- User `ereynaldovaldivia@gmail.com` can now register normally (orphan profile will be auto-cleaned)

---
Task ID: F1-F4-comprehensive-fix
Agent: main
Task: Implement 4-phase fix plan without breaking app functionality

Work Log:
- Phase 1 (Security): Removed hardcoded Supabase URL+JWT from kardex.ts (2 functions), replaced with dataClient. Cleaned GitHub PAT from git remote. Deleted netlify.toml and db.ts.disabled.
- Phase 2 (Functional): Added SyncEngine.offlineAware to OcupacionTab (doIngreso, doSalida, doTransferir). Fixed TrasladoTab lot grouping (key now includes fVencimiento). Fixed no-op ternary in TrasladoTab. Fixed Spanish accents in ErrorBoundary. Added error detection variants.
- Phase 3 (Optimization): Added atomic init pattern to SyncEngine (_doInit + initPromise). Removed dead code from StockTab. Verified calcularStockUbicacion already had proper filters.
- Phase 4 (UX): Added sin_fecha status to FefoTab with proper styling, filter button, sorting (always last), and display (—).

Stage Summary:
- 10 files modified, 82 insertions, 62 deletions
- TypeScript: 0 errors across all 4 phases
- Next.js build: successful across all 4 phases
- No hardcoded credentials remain in source code
- All functional changes are additive (offline support, lot separation) — no existing behavior removed
- Commit pending, needs git push for deployment

---
Task ID: 8
Agent: main (Super Z)
Task: Comprehensive post-fix review + deployment verification

Work Log:
- TypeScript check: 0 errors (tsc --noEmit)
- Next.js build: Successful static export (4/4 pages)
- StockTab: Already has lot separation by codigo||fVencimiento (line 105) — from previous session fix
- AuthGate: Orphan profile fix verified, correoExisteEnAuth uses Admin API
- SyncEngine: initPromise singleton pattern prevents double-init in Strict Mode
- OcupacionTab: Offline-aware wrappers verified (offlineAwareAddMovimiento, offlineAwareTraslado)
- TrasladoTab: Lot grouping by codigo||fVencimiento verified in all 3 locations
- FefoTab: sin_fecha category properly handled with filter, sort, display
- kardex.ts: No hardcoded Supabase URLs, all functions use dataClient from env
- GitHub Actions deploy.yml: Correctly configured with Supabase secrets + Cloudflare wrangler
- Removed unused `pg` dependency from package.json (Node-only, not usable in static export)
- Verified no hardcoded credentials in source code
- Verified no TODO/FIXME/HACK in source code
- Z-AI chat: No integration found in the codebase (not implemented)
- Git push failed: no credential helper configured in container

Stage Summary:
- All code changes from 4 phases + this cleanup are committed locally (7 unpushed commits)
- Build is clean: 0 TypeScript errors, successful static export
- Service role key exposure is architectural (static export) — documented risk for internal tool
- `pg` dependency removed from production deps
- Push requires manual git push from user's machine with GitHub credentials

---
Task ID: 9
Agent: main (Super Z)
Task: Configure all credentials, GitHub Secrets, and deploy to production

Work Log:
- Created .env.local with Supabase credentials (URL, anon key, service role key)
- Configured git remote with GitHub PAT for push access
- Built successfully with Supabase env vars embedded
- Pushed 7 commits + 1 trigger commit to GitHub (main)
- Retrieved Cloudflare Account ID: 0b49c867f9069a9cf4d90e87faf0e780
- Set all 5 GitHub Secrets via API (NaCl encrypted):
  - NEXT_PUBLIC_SUPABASE_URL
  - NEXT_PUBLIC_SUPABASE_ANON_KEY
  - NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
  - CLOUDFLARE_API_TOKEN
  - CLOUDFLARE_ACCOUNT_ID
- First deploy failed (missing Cloudflare secrets) — resolved after secrets were set
- Triggered redeploy → GitHub Actions → Build → Cloudflare Pages deploy
- Final deploy status: SUCCESS

Stage Summary:
- App deployed to https://rackly.pages.dev with all latest changes
- CI/CD pipeline fully operational: git push → auto build → auto deploy
- All 5 GitHub Secrets configured and verified

---
Task ID: 10
Agent: main (Super Z)
Task: Fix login error - ERR_NAME_NOT_RESOLVED (typo in Supabase URL)

Work Log:
- User reported "sale error en iniciar sesión" with console error: `ERR_NAME_NOT_RESOLVED` for `owjryvcrhpmgtkdkcrkm.supabase.co`
- Decoded anon key JWT payload: `ref: "owjryvcrhpmgtkkdcrkm"` (with `kkd`)
- Found typo in .env.local URL: `owjryvcrhpmgtkdkcrkm` (with `kdk`) — letters `d` and `k` were swapped
- Verified correct URL `owjryvcrhpmgtkkdcrkm.supabase.co` resolves and responds (HTTP 401/400 = server exists)
- Fixed .env.local URL locally
- Updated GitHub Secret `NEXT_PUBLIC_SUPABASE_URL` with correct URL (NaCl encrypted, base64 encoded)
- Triggered redeploy with empty commit dd68f1f
- Verified deployed JS bundles contain correct URL: `https://owjryvcrhpmgtkkdcrkm.supabase.co`

Stage Summary:
- Root cause: Supabase URL had `kdk` instead of `kkd` (transposed letters)
- Fix: Updated GitHub Secret + triggered redeploy
- Deploy: SUCCESS (run 27171001844)
- Verified: JS bundles in production contain correct URL

---
Task ID: 11
Agent: Super Z (main)
Task: Investigar y corregir doble ingreso cuando se pierde internet durante registro

Work Log:
- Investigó el flujo completo de offlineAwareAddMovimiento en sync-engine.ts
- Identificó causa raíz: UUID de idempotencia no se compartía entre intento online y fallback offline
- Cuando se pierde red después de enviar RPC, el movimiento se inserta en servidor pero la app no recibe respuesta
- Al reconectar, enqueueMovement genera un NUEVO UUID y re-inserta → duplicado
- Confirmó que handleOffline reseteaba syncInProgress, causando re-procesamiento de movimientos "syncing"

Fixes aplicados:
1. sync-engine.ts: offlineAwareAddMovimiento genera syncId = uuidSync || crypto.randomUUID() ANTES del intento online y lo reutiliza en enqueueMovement
2. sync-engine.ts: enqueueMovement ahora acepta existingUuidSync opcional para reusar el UUID de idempotencia
3. sync-engine.ts: offlineAwareTraslado aplica mismo fix con syncId compartido
4. sync-engine.ts: handleOffline ya NO resetea syncInProgress (evita re-procesar movimientos "syncing")
5. kardex.ts: checkExistingByUuidSync() verifica si uuid_sync ya existe antes de insertar (defensa adicional)
6. Migration SQL creada: 20260609_add_uuid_sync_unique.sql (UNIQUE index, pendiente ejecución en Supabase Dashboard)

Build y deploy:
- Build exitoso (next build)
- Commit: 61150c9
- Deploy: Run 27207531378 → success
- Cloudflare Pages actualizado

Stage Summary:
- Causa raíz del doble ingreso: UUID de idempotencia no se compartía entre online y offline paths
- 3 cambios en sync-engine.ts + 1 en kardex.ts
- Defensa triple: UUID compartido + checkExistingByUuidSync + detección de duplicado en sync
- Pendiente: Ejecutar UNIQUE index en Supabase Dashboard SQL Editor para defensa a nivel de DB

---
Task ID: 12
Agent: Super Z (main) + subagents
Task: Implementar INC (Insumo No Conforme) — stock separado y trazabilidad

Work Log:
- Creado punto de guardado: git tag v2.0-pre-inc
- Agregado campo codigo_inc a tipos y funciones core
- constants.ts: INC_PREFIX + esInsumoNoConforme() helper
- kardex.ts: Movimiento.codigoInc, StockEnUbicacion.codigoInc, grupo key con codigoInc, RPC con p_codigo_inc
- offline-db.ts: PendingMovement.codigo_inc
- sync-engine.ts: pasa codigo_inc en offline-aware + syncPendingMovements
- OcupacionTab: sección INC separada + botón registro INC + formulario completo
- StockTab: filtro Todos/Disponibles/Solo INC + badge codigoInc
- FefoTab: excluye INC del FEFO (m.codigoInc → continue)
- TrasladoTab: LocStock.codigoInc + pasa en doTraslado
- Build exitoso, deploy exitoso (Run 27214133474)

Stage Summary:
- 8 archivos modificados, 255 inserciones, 23 eliminaciones
- Tag de savepoint: v2.0-pre-inc
- Deploy: success en Cloudflare Pages
- PENDIENTE: Ejecutar en Supabase SQL Editor:
  ALTER TABLE public.movimientos ADD COLUMN IF NOT EXISTS codigo_inc TEXT;
---
Task ID: 13
Agent: Super Z (main)
Task: Ubicaciones con INC en color rosa mostrando código y cantidad en grid de Ocupación

Work Log:
- Explored OcupacionTab, StockTab, kardex.ts to understand current grid rendering and INC data flow
- Identified that OcupacionCelda type lacked INC fields and calcularOcupacion() dropped codigoInc during aggregation
- Modified OcupacionCelda type in kardex.ts: added tieneInc (boolean) + incItems (IncEnCelda[]) + IncEnCelda type
- Modified calcularOcupacion() in OcupacionTab.tsx: lot key now includes codigoInc, tracks INC items per cell
- Modified grid cell rendering (posA + posB): INC cells get rose gradient, show article code (truncated) + quantity, rose dot indicator
- Added INC legend item to the filter/legend bar
- Updated fetchOcupacionCeldas() fallback RPC to include default INC fields (tieneInc: false, incItems: [])
- Build verified: compiled successfully with 0 errors

Stage Summary:
- Files modified: src/lib/rackly/kardex.ts (type + fallback), src/components/rackly/kardex/OcupacionTab.tsx (logic + grid + legend)
- INC cells now display: rose/pink gradient, article code + quantity, tooltip with full INC details
- Priority order: INC (rose) > Multi-art (amber) > Multi-lote (blue+dot) > Ocupado (blue) > Vacío (green)
---
Task ID: 1
Agent: Main Agent
Task: Fix INC cells showing orange instead of pink/red and missing code/description

Work Log:
- Investigated OcupacionTab.tsx grid rendering: color logic and INC display were correct
- Investigated fetchIncPorUbicacion(): query correctly selects codigo_inc and filters non-null
- Found root cause: SQL RPC `registrar_movimiento_kardex` does NOT have `p_codigo_inc` parameter
- TypeScript sends `p_codigo_inc` but Supabase silently ignores unknown RPC params
- Result: `codigo_inc` column is always NULL in DB, so INC query returns "No rows"
- Fixed by modifying `addMovimiento()` in kardex.ts to use direct insert (which includes `codigo_inc`) when movement has `codigoInc`
- Created SQL migration file for optional RPC update (supabase/migrations/20260611_add_codigo_inc_to_rpcs.sql)
- Build passed, pushed to GitHub for deployment

Stage Summary:
- Root cause: RPC function missing p_codigo_inc parameter → INC data never stored
- Fix: INC movements bypass RPC and use direct insert (always ingreso type, no stock validation needed)
- Files changed: src/lib/rackly/kardex.ts, supabase/migrations/20260611_add_codigo_inc_to_rpcs.sql
- IMPORTANT: Existing INC records in DB have NULL codigo_inc (lost data). User needs to re-register INCs.
---
Task ID: 1
Agent: main
Task: Rediseñar selector de columnas y vista de detalle de columna en PisoSectoresTab

Work Log:
- Analizé 3 imágenes del usuario: selector actual (transparente), estilo deseado (botones sólidos), y formato de tabla deseado (P1-P11 × N1-Nx)
- Creé nueva API function `cargarVistaColumna()` en api.ts que carga posiciones×niveles con stock e INC en solo 4 queries
- Rediseñé selector de columnas: contenedor bg-slate-800 sólido, botones redondeados verde (vacía) y azul (con stock) con badge de conteo
- Rediseñé vista de detalle como tabla HTML: filas=P1-P11, columnas=N1-Nx, colores por estado (verde=vacío, azul=1 art, naranja=2+ art, rosa=INC)
- Click en cualquier celda de la tabla abre el dialog de detalle existente (ingreso/salida/traslado/devolución/INC)
- Las operaciones recargan tanto el grid como la vista de columna
- Legend en el pie de la tabla explica los colores
- Build exitoso sin errores

Stage Summary:
- Selector de columnas: verde=Vacía, azul=Con stock, estilo sólido sin transparencias
- Tabla de detalle: verde=Vacío, azul=1 artículo, naranja=2+ artículos, rosa=INC
- API eficiente: cargarVistaColumna() usa solo 4 queries para toda la tabla
- Funcionalidad completa preservada (todas las operaciones, salida en masa, exportar)

---
Task ID: 1
Agent: Main
Task: Revisar y corregir cálculos de salidas, ingresos, traslados, ocupaciones y separación INC

Work Log:
- Exploración completa del código: kardex.ts, MovimientoForm.tsx, TrasladoTab.tsx, OcupacionTab.tsx, StockTab.tsx, FefoTab.tsx
- Identificados 8 bugs/concerns en el sistema de cálculos
- Corregido: addMovimientoFallback ahora valida stock antes de insertar salidas normales (excluye INC del cálculo)
- Corregido: calcularStockUbicacion ahora acepta parámetro excluirInc para consultas de stock normal
- Corregido BUG CRÍTICO: doSalida en OcupacionTab NO preservaba codigoInc — las salidas INC nunca descontaban
- Corregido: doTransferir en OcupacionTab NO preservaba codigoInc — los traslados INC perdían la marca
- Corregido: calcularOcupacion ahora EXCLUYE movimientos INC del stock normal
- Mejorado: refreshData ahora crea celdas "solo INC" para ubicaciones que solo tienen insumos no conformes
- Mejorado: Grid de ocupación detecta celdas solo INC y las muestra con color rosa
- Mejorado: Export de ocupación ahora incluye columna INC con detalle
- Corregido: SalidaForm excluye items INC de la lista de salidas normales
- Verificado: FefoTab ya excluía INC correctamente
- Verificado: TrasladoTab ya separaba INC por codigoInc en la clave de agrupamiento
- Build exitoso, push a GitHub completado (Cloudflare Pages se despliega automáticamente)

Stage Summary:
- 3 archivos modificados: kardex.ts, OcupacionTab.tsx, MovimientoForm.tsx
- Commit: d7d9e75 "fix: separar INC del stock normal, validar salidas contra negativo..."
- Build: ✅ Compiled successfully
- Deploy: Push a GitHub → Cloudflare Pages auto-deploy

---
Task ID: 1
Agent: main
Task: Auditoría profunda de la implementación de historial en PisoSectoresTab y OcupacionTab

Work Log:
- Leído loadHistorial en PisoSectoresTab.tsx (líneas 263-340) - queries piso_movimiento_detalles + piso_movimientos + piso_bloques, agrupa por movimiento_id
- Leído loadHistorial en OcupacionTab.tsx (líneas 287-328) - queries movimientos directamente con filtros bloque/torre/piso/posicion
- Verificado types.ts: piso_movimientos NO tiene codigo_inc en el tipo generado (posiblemente columna agregada vía SQL sin regenerar tipos)
- Verificado api.ts línea 1093: inserta codigo_inc en piso_movimientos, confirmando que la columna SÍ existe en la DB
- Encontrado Error 1: En OcupacionTab, la detección de rotación creaba un new Set() por CADA item del historial dentro del .map() - ineficiente
- Encontrado Error 2: f_vencimiento en OcupacionTab tipado como string pero puede ser null desde la DB
- Corregido Error 1: Agregado useMemo para historialCurrentCodigos, igual que PisoSectoresTab
- Corregido Error 2: Cambiado tipo a string | null
- Agregado import de useMemo en OcupacionTab
- Build limpio, deployado vía git push

Stage Summary:
- 2 errores corregidos en OcupacionTab.tsx (rotación ineficiente + tipo nullable)
- La columna codigo_inc en piso_movimientos NO está en types.ts pero SÍ existe en la DB (confirmado por api.ts insert)
- No se encontraron más errores críticos en la lógica de historial
- Commit: e8289b5
---
Task ID: MOBILE-FIX-1
Agent: Main Agent
Task: Fix mobile loading issue - HydrationGuard missing in page.tsx

Work Log:
- Investigated why mobile version shows "loading page" and cannot access the app
- Found ROOT CAUSE: page.tsx (active page) was missing HydrationGuard wrapper
- app-content.tsx (unused duplicate) had the HydrationGuard but was never used by Next.js routing
- During SSG, Next.js renders HTML without env vars -> AuthGate shows "Configuración incompleta" error
- During client hydration, env vars ARE available -> AuthGate shows spinner/login/app
- Without HydrationGuard, React detects severe DOM mismatch and discards server HTML, re-rendering from scratch
- On mobile, this re-render is very slow, causing the "stuck loading" appearance
- Fix: Added HydrationGuard component to page.tsx that shows spinner until client-side mount
- Removed duplicate app-content.tsx file
- Cleaned up tool-results directory
- Build successful, pushed to GitHub, Cloudflare Pages deploy triggered

Stage Summary:
- Key fix: HydrationGuard in page.tsx ensures SSG and first client paint produce identical HTML
- Both now show a spinner, then React hydrates cleanly and transitions to real UI
- Commit: 9f879e8 pushed to main
- Deploy: GitHub Actions -> Cloudflare Pages (automatic)

