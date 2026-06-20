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
