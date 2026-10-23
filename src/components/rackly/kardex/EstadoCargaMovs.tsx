'use client'

import { Loader2, WifiOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { EstadoMovs } from '@/hooks/useMovimientosRealtime'

/**
 * Estado visual del dataset compartido de movimientos (Task 24).
 *
 * Antes las pestañas mostraban su vacío REAL ("Sin lotes FEFO", "0 ubicaciones",
 * "Aún no hay movimientos") mientras el dataset aún descargaba — el usuario
 * interpretaba que la pestaña estaba rota. Este componente muestra un spinner
 * honesto mientras `estado === 'cargando'` y un panel de reintento cuando
 * `estado === 'error'`. Solo debe renderizarse si además NO hay datos en caché.
 */
export function EstadoCargaMovs({ estado, onRetry }: { estado: EstadoMovs; onRetry: () => void }) {
  if (estado === 'cargando') {
    return (
      <div className="flex flex-col items-center gap-3 text-muted-foreground py-12 justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-sky-500" />
        <span className="text-sm font-medium">Cargando movimientos…</span>
        <span className="text-xs">Sincronizando el kardex completo — puede tardar unos segundos</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-3 text-muted-foreground py-12 justify-center">
      <WifiOff className="h-8 w-8 text-red-400" />
      <span className="text-sm font-medium text-red-600 dark:text-red-400">No se pudieron cargar los movimientos</span>
      <span className="text-xs">Revisa tu conexión e inténtalo de nuevo</span>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-2 mt-1">
        <RefreshCw className="h-4 w-4" />
        Reintentar
      </Button>
    </div>
  )
}
