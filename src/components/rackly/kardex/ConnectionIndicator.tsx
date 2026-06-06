'use client'

import { useConnectivity } from '@/hooks/useConnectivity'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  RefreshCw,
  CloudOff,
  CloudUpload,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useState, useEffect } from 'react'
import { SyncEngine } from '@/lib/rackly/sync-engine'
import { type PendingMovement } from '@/lib/rackly/offline-db'

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return 'Nunca'
  const diff = Date.now() - timestamp
  if (diff < 60000) return 'Justo ahora'
  if (diff < 3600000) return `Hace ${Math.floor(diff / 60000)} min`
  if (diff < 86400000) return `Hace ${Math.floor(diff / 3600000)} h`
  return `Hace ${Math.floor(diff / 86400000)} d`
}

export function ConnectionIndicator() {
  const {
    connectivity,
    pendingCount,
    errorCount,
    conflictCount,
    isSyncing,
    lastSyncTime,
    initialized,
    forceSync,
  } = useConnectivity()

  const [showConflicts, setShowConflicts] = useState(false)
  const [conflicts, setConflicts] = useState<PendingMovement[]>([])
  const [syncingConflict, setSyncingConflict] = useState<string | null>(null)

  // Cargar conflictos cuando se abre el dialog
  useEffect(() => {
    if (showConflicts) {
      SyncEngine.getConflicts().then(setConflicts)
    }
  }, [showConflicts])

  // No mostrar hasta que esté inicializado
  if (!initialized) return null

  const hasIssues = pendingCount > 0 || errorCount > 0 || conflictCount > 0

  // Configuración visual según estado
  const config = {
    online: {
      icon: Wifi,
      label: 'Online',
      bgClass: 'bg-green-100 text-green-700 border-green-200',
      iconClass: 'text-green-600',
    },
    offline: {
      icon: WifiOff,
      label: 'Offline',
      bgClass: 'bg-red-100 text-red-700 border-red-200',
      iconClass: 'text-red-600',
    },
    syncing: {
      icon: CloudUpload,
      label: 'Sincronizando...',
      bgClass: 'bg-amber-100 text-amber-700 border-amber-200',
      iconClass: 'text-amber-600',
    },
    error: {
      icon: CloudOff,
      label: 'Error sync',
      bgClass: 'bg-slate-200 text-slate-700 border-slate-300',
      iconClass: 'text-slate-600',
    },
  }[connectivity]

  const Icon = config.icon

  return (
    <>
      <div className="flex items-center gap-1.5">
        {/* Indicador principal */}
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold border transition-all ${config.bgClass}`}
          onClick={() => hasIssues && setShowConflicts(true)}
          role="status"
          aria-label={`Estado: ${config.label}`}
        >
          {isSyncing ? (
            <Loader2 className={`h-3 w-3 animate-spin ${config.iconClass}`} />
          ) : (
            <Icon className={`h-3 w-3 ${config.iconClass}`} />
          )}
          <span className="hidden sm:inline">{config.label}</span>
          {pendingCount > 0 && (
            <span className="bg-red-500 text-white rounded-full px-1 py-0 text-[8px] font-bold min-w-[14px] text-center leading-[14px]">
              {pendingCount}
            </span>
          )}
        </div>

        {/* Botón forzar sync (solo cuando hay pendientes y estamos online) */}
        {pendingCount > 0 && connectivity === 'online' && !isSyncing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={forceSync}
            className="h-6 px-1.5 text-slate-400 hover:text-slate-600"
            title="Forzar sincronización"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Diálogo de conflictos/errores */}
      <AlertDialog open={showConflicts} onOpenChange={setShowConflicts}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          <div className="bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 px-4 sm:px-6 py-5 text-white shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="h-6 w-6 text-white" />
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  Pendientes de Sincronización
                </AlertDialogTitle>
                <AlertDialogDescription className="text-amber-100 text-sm mt-0.5">
                  {pendingCount} pendiente{pendingCount !== 1 ? 's' : ''} · {errorCount} error{errorCount !== 1 ? 'es' : ''} · {conflictCount} conflicto{conflictCount !== 1 ? 's' : ''}
                  {lastSyncTime && ` · Últ. sync: ${formatTimeAgo(lastSyncTime)}`}
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {conflicts.length > 0 ? (
              <div className="p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Movimientos que requieren atención
                </p>
                {conflicts.map((c) => (
                  <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={
                        c.status === 'conflict'
                          ? 'bg-red-50 text-red-700 border-red-200 font-semibold'
                          : 'bg-amber-50 text-amber-700 border-amber-200 font-semibold'
                      }>
                        {c.status === 'conflict' ? 'Conflicto de stock' : 'Error'}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(c.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm space-y-1">
                      <p><span className="font-semibold">{c.tipo.toUpperCase()}</span> — {c.codigo}</p>
                      <p className="text-muted-foreground text-xs">{c.descripcion}</p>
                      <p className="font-mono text-xs">B{c.bloque}/T{c.torre}/P{c.piso}/Pos{c.posicion} · {c.cantidad} {c.un}</p>
                    </div>
                    {c.lastError && (
                      <p className="text-xs text-red-600 bg-red-50 rounded p-2">{c.lastError}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          setSyncingConflict(c.id)
                          await SyncEngine.forceSync()
                          setSyncingConflict(null)
                          const updated = await SyncEngine.getConflicts()
                          setConflicts(updated)
                        }}
                        disabled={syncingConflict === c.id}
                        className="h-8 text-xs gap-1.5"
                      >
                        {syncingConflict === c.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Reintentar
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await SyncEngine.cancelPendingMovement(c.id)
                          const updated = await SyncEngine.getConflicts()
                          setConflicts(updated)
                        }}
                        className="h-8 text-xs gap-1.5 border-red-200 text-red-700 hover:bg-red-50"
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-muted-foreground text-sm py-8">
                {pendingCount > 0 ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <p>{pendingCount} movimiento(s) en cola de sincronización...</p>
                  </div>
                ) : (
                  <p>No hay movimientos pendientes.</p>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter className="px-4 sm:px-6 pb-6 pt-3 border-t border-slate-100 shrink-0">
            {connectivity === 'online' && pendingCount > 0 && (
              <AlertDialogAction
                onClick={async () => {
                  await forceSync()
                  const updated = await SyncEngine.getConflicts()
                  setConflicts(updated)
                }}
                className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Sincronizar ahora
              </AlertDialogAction>
            )}
            <AlertDialogCancel>Cerrar</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
