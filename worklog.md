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
