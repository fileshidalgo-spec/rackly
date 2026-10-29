'use client'

/**
 * RACKLY — Atención a Línea · Sección de RALs registrados (Task 36).
 *
 * Lista aparte de los RQ: los RAL (Requerimiento al Almacén) son un formato
 * de documento DISTINTO — no comparten tabla ni listado con rq_atenciones
 * (aislamiento total: solo toca rals / ral_items vía ral.ts).
 *
 *   · Carga al montar + realtime (canal 'rals') + botón refrescar.
 *   · Búsqueda local por documento / área / solicitante / almacén.
 *   · Detalle expandible: encabezado completo + tabla de artículos
 *     (código, descripción, und, centro de costos, cantidad pedida).
 *   · Eliminar SOLO supervisores (RLS rals_delete_auth — el mismo criterio
 *     de rq_delete_auth).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRegistrosRealtime, type MotivoRealtime } from '@/hooks/useRegistrosRealtime'
import {
  eliminarRal,
  listarRals,
  type RalRegistro,
} from '@/lib/rackly/ral'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'

type RalConItems = RalRegistro & {
  items: {
    id: string
    orden: number
    codigo: string
    descripcion: string
    unidad: string
    centroCostos: string
    cantidad: number
  }[]
}

export function RalLista({ puedeEliminar }: { puedeEliminar: boolean }) {
  const [rals, setRals] = useState<RalRegistro[]>([])
  const [loading, setLoading] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null)
  const [detalles, setDetalles] = useState<Record<string, RalConItems['items']>>({})
  const [cargandoDetalle, setCargandoDetalle] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RalRegistro | null>(null)
  const [actualizado, setActualizado] = useState('')

  const cargaGenRef = useRef(0)

  const cargar = useCallback(async () => {
    const gen = ++cargaGenRef.current
    try {
      const filas = await listarRals()
      if (gen !== cargaGenRef.current) return
      setRals(filas)
      setActualizado(
        new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      )
    } catch (err: unknown) {
      if (gen !== cargaGenRef.current) return
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al cargar los RAL', { description: message })
    } finally {
      if (gen === cargaGenRef.current) setLoading(false)
    }
  }, [])

  const recargar = useCallback(
    (motivo: MotivoRealtime) => {
      // El polling no avisa (evita falsas alarmas); eventos y retorno a la
      // pestaña sí refrescan — igual que el panel de RQ.
      if (motivo === 'poll') return
      void cargar()
    },
    [cargar]
  )
  useRegistrosRealtime('rals', recargar)

  useEffect(() => {
    void cargar()
  }, [cargar])

  /** Abre/cierra el detalle; la primera vez carga los artículos. */
  async function alternarDetalle(r: RalRegistro) {
    if (detalleAbierto === r.id) {
      setDetalleAbierto(null)
      return
    }
    setDetalleAbierto(r.id)
    if (detalles[r.id]) return
    setCargandoDetalle(r.id)
    try {
      const { obtenerRalCompleta } = await import('@/lib/rackly/ral')
      const { items } = await obtenerRalCompleta(r.id)
      setDetalles((prev) => ({ ...prev, [r.id]: items }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo abrir el detalle del RAL', { description: message })
      setDetalleAbierto(null)
    } finally {
      setCargandoDetalle(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await eliminarRal(target.id)
      toast.success('RAL eliminado')
      if (detalleAbierto === target.id) setDetalleAbierto(null)
      void cargar()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar el RAL', { description: message })
    }
  }

  const q = busqueda.trim().toLowerCase()
  const filtrados = q
    ? rals.filter((r) =>
        [r.documento, r.transaccion, r.areaSolicitante, r.solicitante, r.aprobadoPor, r.almacen, r.linea, r.textoItems]
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
    : rals

  return (
    <div className="space-y-3">
      {/* Encabezado de la sección */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-extrabold text-violet-900">
          <FileText className="h-4 w-4 text-violet-600" />
          Requerimientos al Almacén (RAL)
          <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700 text-[10px]">
            {rals.length}
          </Badge>
        </h3>
        <div className="flex items-center gap-2 sm:ml-auto">
          <div className="relative flex-1 sm:w-56">
            <Input
              className="h-8 text-xs"
              placeholder="Buscar por documento, área, material o solicitante…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void cargar()}
            disabled={loading}
            title="Refrescar"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {actualizado && (
        <p className="text-[10px] text-emerald-700 -mt-2">
          <span className="inline-flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
            </span>
            En vivo{` · actualizado ${actualizado}`}
          </span>
        </p>
      )}

      {/* Listado */}
      {filtrados.length === 0 && !loading ? (
        <p className="text-sm text-slate-400 text-center py-8 rounded-xl border border-dashed">
          <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
          {rals.length === 0
            ? 'Aún no hay RAL registrados — usa el botón «Nuevo RAL».'
            : 'Ningún RAL coincide con la búsqueda.'}
        </p>
      ) : (
        <div className="space-y-2">
          {filtrados.map((r) => {
            const abierto = detalleAbierto === r.id
            return (
              <div key={r.id} className="rounded-xl border bg-white overflow-hidden">
                <button
                  type="button"
                  className="w-full text-left p-3 flex flex-wrap items-start gap-x-3 gap-y-1.5 hover:bg-violet-50/40"
                  onClick={() => void alternarDetalle(r)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-extrabold text-slate-900 font-mono">
                      {r.documento || 'sin documento'}
                      <span className="ml-2 font-sans text-[11px] font-medium text-slate-500">
                        {r.fecha}
                        {r.transaccion ? ` · ${r.transaccion}` : ''}
                      </span>
                    </p>
                    <p className="text-xs text-slate-600 truncate">
                      {r.areaSolicitante || '—'}
                      {r.solicitante ? ` · ${r.solicitante}` : ''}
                    </p>
                    <p className="text-[11px] text-slate-400 truncate">
                      {[r.almacen, r.linea, r.aprobadoPor ? `Aprobó: ${r.aprobadoPor}` : '']
                        .filter(Boolean)
                        .join(' · ') || '\u00a0'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700 text-[10px]">
                      {r.articulos} art.
                    </Badge>
                    {puedeEliminar && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(r)
                        }}
                        title="Eliminar RAL"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    {abierto ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {/* Detalle expandible */}
                {abierto && (
                  <div className="border-t bg-slate-50/60 p-3 space-y-3">
                    {cargandoDetalle === r.id && !detalles[r.id] ? (
                      <p className="flex items-center gap-2 text-xs text-slate-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando artículos…
                      </p>
                    ) : (
                      <>
                        <div className="grid gap-1 text-[11px] text-slate-600 sm:grid-cols-2">
                          <p><span className="font-semibold text-slate-500">Área solicitante:</span> {r.areaSolicitante || '—'}</p>
                          <p><span className="font-semibold text-slate-500">Solicitante:</span> {r.solicitante || '—'}</p>
                          <p><span className="font-semibold text-slate-500">Aprobado por:</span> {r.aprobadoPor || '—'}</p>
                          <p><span className="font-semibold text-slate-500">Almacén:</span> {r.almacen || '—'}</p>
                          <p><span className="font-semibold text-slate-500">Transacción:</span> {r.transaccion || '—'}</p>
                          <p><span className="font-semibold text-slate-500">Línea:</span> {r.linea || '—'}</p>
                        </div>
                        <div className="rounded-lg border bg-white overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                              <tr>
                                <th className="px-2.5 py-1.5 w-[90px]">Código</th>
                                <th className="px-2.5 py-1.5">Artículo o descripción</th>
                                <th className="px-2.5 py-1.5 w-[60px]">Und</th>
                                <th className="px-2.5 py-1.5 w-[110px]">C. de costos</th>
                                <th className="px-2.5 py-1.5 w-[110px] text-right">Cant. pedida</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(detalles[r.id] ?? []).map((it) => (
                                <tr key={it.id} className="border-t">
                                  <td className="px-2.5 py-1.5 font-mono font-semibold text-violet-700">{it.codigo || '—'}</td>
                                  <td className="px-2.5 py-1.5">{it.descripcion || '—'}</td>
                                  <td className="px-2.5 py-1.5">{it.unidad || '—'}</td>
                                  <td className="px-2.5 py-1.5 font-mono">{it.centroCostos || '—'}</td>
                                  <td className="px-2.5 py-1.5 text-right font-semibold">
                                    {it.cantidad.toLocaleString('es-PE', { maximumFractionDigits: 4 })}
                                  </td>
                                </tr>
                              ))}
                              {(detalles[r.id] ?? []).length === 0 && (
                                <tr>
                                  <td colSpan={5} className="px-2.5 py-3 text-center text-slate-400">
                                    Sin artículos registrados en este RAL.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                        {r.notas && (
                          <p className="text-[11px] text-slate-600">
                            <span className="font-semibold text-slate-500">Notas:</span> {r.notas}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Confirmación de eliminación */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar el RAL {deleteTarget?.documento || ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se quitará el documento y sus {deleteTarget?.articulos ?? 0} artículo(s). Esta acción
              no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
            >
              Sí, eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
