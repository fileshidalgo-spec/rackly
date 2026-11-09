'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Tránsito.
 *
 * El estacionamiento del día: los artículos pickeados en Atención viven
 * aquí (pre-picking, stock con ral_id) hasta el despacho del día siguiente.
 *
 *   · DESPACHAR RAL  → rep_despachar_ral: salida física de TODA la carga,
 *     kardex 'salida' por artículo y estado despachado (documento intocable).
 *   · DEVOLVER línea → rep_devolver_linea: un artículo regresa a su
 *     lonchera de origen (kardex 'devolucion') — el RAL sigue registrado.
 *
 * Solo se despacha un RAL con carga estacionada (la RPC lo valida).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repListarRals,
  repDetalleDeRal,
  repTransitoDeRal,
  repDespacharRal,
  repDevolverLinea,
  type RepRal,
} from '@/lib/rackly/rep/rep-client'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Truck,
  Loader2,
  RefreshCw,
  Undo2,
  PackageCheck,
  ArrowLeft,
  PackageOpen,
} from 'lucide-react'

type Linea = { id: string; articulo_id: string; cantidad: number; codigo: string; descripcion: string; und: string }
type VistaRal = {
  ral: RepRal
  lineas: Linea[]
  /** articuloId → cantidad estacionada en pre-picking */
  transito: Map<string, number>
}

const CLASE_ESTADO: Record<string, string> = {
  registrado: 'bg-sky-50 text-sky-700 border-sky-200',
  despachado: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  anulado: 'bg-slate-100 text-slate-500 border-slate-200',
}

const ETIQUETA_ESTADO: Record<string, string> = {
  registrado: 'Registrado',
  despachado: 'Despachado',
  anulado: 'Anulado',
}

export function TransitoModule() {
  const { perfil } = useAuth()
  const puedeOperar = puede(perfil, 'repuestos.crear')

  const [filtroEstado, setFiltroEstado] = useState<'registrado' | 'despachado'>('registrado')
  const [vista, setVista] = useState<VistaRal[]>([])
  const [loading, setLoading] = useState(true)
  const [despachando, setDespachando] = useState<string | null>(null)
  const [devolviendo, setDevolviendo] = useState<string | null>(null)
  const genRef = useRef(0)

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    try {
      const res = await repListarRals({ estado: filtroEstado, page: 1, pageSize: 100 })
      if (gen !== genRef.current) return
      // Para RALs registrados carga líneas + tránsito en paralelo (por RAL)
      const conDetalle = await Promise.all(
        res.filas.map(async (ral) => {
          try {
            const [lineas, tr] = await Promise.all([repDetalleDeRal(ral.id), repTransitoDeRal(ral.id)])
            return { ral, lineas, transito: new Map(tr.map((t) => [t.articuloId, t.cantidad])) }
          } catch {
            return { ral, lineas: [] as Linea[], transito: new Map<string, number>() }
          }
        })
      )
      if (gen !== genRef.current) return
      // Los que tienen carga estacionada primero (los que toca despachar hoy)
      conDetalle.sort((a, b) => {
        const ta = Array.from(a.transito.values()).reduce((s, n) => s + n, 0)
        const tb = Array.from(b.transito.values()).reduce((s, n) => s + n, 0)
        if (ta > 0 !== tb > 0) return ta > 0 ? -1 : 1
        return a.ral.created_at.localeCompare(b.ral.created_at)
      })
      setVista(conDetalle)
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      toast.error('Error al cargar Tránsito', { description: mensajeError(err) })
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [filtroEstado])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function despachar(v: VistaRal) {
    const total = Array.from(v.transito.values()).reduce((s, n) => s + n, 0)
    if (
      !confirm(
        `Despachar el RAL ${v.ral.numero}: ${v.transito.size} artículo(s), ${total.toLocaleString('es-PE')} unidades salen físicamente.\n\nEl RAL queda DESPACHADO (intocable) y se registra la salida en el kardex. ¿Continuar?`
      )
    ) return
    setDespachando(v.ral.id)
    try {
      const r = await repDespacharRal(v.ral.id)
      toast.success(`RAL ${v.ral.numero} despachado`, {
        description: `${r.lineas} artículo(s) · ${r.cantidad.toLocaleString('es-PE')} unidades — salida registrada en el kardex.`,
        duration: 9000,
      })
      cargar()
    } catch (err: unknown) {
      toast.error('No se pudo despachar', { description: mensajeError(err) })
    } finally {
      setDespachando(null)
    }
  }

  async function devolver(v: VistaRal, l: Linea) {
    if (!confirm(`¿Devolver ${l.codigo} a su lonchera de origen?`)) return
    setDevolviendo(l.id)
    try {
      const r = await repDevolverLinea(l.id)
      toast.success(`${l.codigo} devuelto a ${r.destino}`)
      cargar()
    } catch (err: unknown) {
      toast.error('No se pudo devolver', { description: mensajeError(err) })
    } finally {
      setDevolviendo(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filtroEstado} onValueChange={(v) => setFiltroEstado(v as typeof filtroEstado)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="registrado">En tránsito (registrados)</SelectItem>
              <SelectItem value="despachado">Historial (despachados)</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={cargar} variant="outline" size="sm" className="gap-2" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualizar
          </Button>
        </div>

        <p className="text-xs text-slate-500">
          Carga estacionada en pre-picking esperando la salida del día siguiente. Devolver regresa el
          artículo a su lonchera; despachar registra la salida definitiva.
        </p>

        {loading && vista.length === 0 && (
          <div className="flex items-center justify-center py-12 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando…
          </div>
        )}

        {!loading && vista.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <PackageOpen className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="text-sm font-semibold text-slate-500">
              {filtroEstado === 'registrado' ? 'Nada estacionado en pre-picking' : 'Aún no hay despachos'}
            </p>
            <p className="text-xs mt-1">
              {filtroEstado === 'registrado'
                ? 'Los RALs pickeados en Atención aparecen aquí para su despacho.'
                : 'Los RALs despachados se archivan aquí.'}
            </p>
          </div>
        )}

        <div className="space-y-3">
          {vista.map((v) => {
            const conCarga = Array.from(v.transito.values()).reduce((s, n) => s + n, 0) > 0
            const pendienteDespacho = filtroEstado === 'registrado' && conCarga
            return (
              <div
                key={v.ral.id}
                className={`rounded-xl border p-3 space-y-2 ${pendienteDespacho ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'}`}
              >
                {/* Cabecera del RAL */}
                <div className="flex flex-wrap items-center gap-2">
                  <Truck className={`h-4 w-4 ${pendienteDespacho ? 'text-amber-600' : 'text-slate-400'}`} />
                  <span className="font-mono font-extrabold text-sm text-slate-900">{v.ral.numero}</span>
                  <Badge variant="outline" className={`${CLASE_ESTADO[v.ral.estado]} text-[10px] font-semibold`}>
                    {ETIQUETA_ESTADO[v.ral.estado]}
                  </Badge>
                  <span className="text-xs text-slate-500">{v.ral.fecha} · {v.ral.solicitante || 'sin solicitante'}</span>
                  {pendienteDespacho && puedeOperar && (
                    <Button
                      onClick={() => despachar(v)}
                      size="sm"
                      disabled={despachando === v.ral.id}
                      className="gap-1.5 ml-auto"
                    >
                      {despachando === v.ral.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                      Despachar RAL
                    </Button>
                  )}
                </div>

                {/* Líneas */}
                {v.lineas.length === 0 ? (
                  <p className="text-xs text-slate-400">Sin líneas registradas.</p>
                ) : (
                  <ul className="space-y-1">
                    {v.lineas.map((l) => {
                      const enT = v.transito.has(l.articulo_id)
                      return (
                        <li
                          key={l.id}
                          className={`flex items-center gap-2 text-xs border-b border-slate-100 pb-1 last:border-0 ${enT ? '' : 'opacity-60'}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${enT ? 'bg-amber-500' : 'bg-slate-300'}`} />
                          <span className="font-mono font-bold text-slate-700 shrink-0">{l.codigo}</span>
                          <span className="text-slate-500 truncate flex-1" title={l.descripcion}>{l.descripcion}</span>
                          <span className="font-bold text-slate-900 shrink-0">
                            {l.cantidad.toLocaleString('es-PE')} {l.und}
                          </span>
                          {enT ? (
                            <>
                              <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                                En pre-picking
                              </Badge>
                              {filtroEstado === 'registrado' && puedeOperar && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => devolver(v, l)}
                                  disabled={devolviendo === l.id}
                                  className="gap-1 h-6 px-1.5 text-[10px] shrink-0"
                                  title="Devolver a su lonchera"
                                >
                                  {devolviendo === l.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                                  Devolver
                                </Button>
                              )}
                            </>
                          ) : (
                            <span className="text-[9px] text-slate-400 shrink-0">
                              {filtroEstado === 'registrado' ? 'devuelto/pendiente' : 'salida registrada'}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
