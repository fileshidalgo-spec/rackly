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
