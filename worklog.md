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
