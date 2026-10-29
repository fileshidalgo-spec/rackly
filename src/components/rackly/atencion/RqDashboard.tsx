'use client'

/**
 * RACKLY — Atención · Dashboard de atención a líneas (vista presentable).
 *
 * Datos: cargarReporteAtencion() (encabezados + materiales + ledger de
 * salidas + vencimientos). Gráficos CSS puros — cero dependencias nuevas.
 * Bloques: KPIs · RQs por día · por línea · top de materiales atendidos ·
 * últimas salidas. El botón de Excel reusa exportarExcelAtencion().
 *
 * Aislamiento: solo lee su módulo (rq_*). No toca otros módulos.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  cargarReporteAtencion,
  kpisAtencion,
  resumenPorArticulo,
  serieRqsPorDia,
  serieRqsPorLinea,
  topArticulosAtendidos,
  type DatosReporte,
  type ReporteItem,
} from '@/lib/rackly/atencion-reporte'
import { exportarExcelAtencion } from '@/lib/rackly/atencion-excel'

const EST_KPI: Record<string, string> = {
  Pendiente: 'border-amber-200 bg-amber-50 text-amber-700',
  'En proceso': 'border-sky-200 bg-sky-50 text-sky-700',
  Atendido: 'border-emerald-200 bg-emerald-50 text-emerald-700',
}

/** Fecha ISO → 'dd/mm' para ejes compactos. */
const diaCorto = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

/** Barra horizontal proporcional (gráfico CSS). */
function Barra({ etiqueta, valor, max, detalle, color }: {
  etiqueta: string
  valor: number
  max: number
  detalle: string
  color: string
}) {
  const pct = max > 0 ? Math.max((valor / max) * 100, valor > 0 ? 4 : 0) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 truncate text-right text-slate-600" title={etiqueta}>{etiqueta}</span>
      <div className="h-4 flex-1 rounded bg-slate-100">
        <div className={`h-4 rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 shrink-0 tabular-nums text-slate-700">{detalle}</span>
    </div>
  )
}

/** Tarjeta KPI. */
function Kpi({ titulo, valor, pie, clase }: { titulo: string; valor: string | number; pie?: string; clase?: string }) {
  return (
    <div className={`rounded-xl border p-3 ${clase ?? 'border-slate-200 bg-white'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{titulo}</p>
      <p className="text-xl font-extrabold text-slate-900">{valor}</p>
      {pie && <p className="text-[11px] text-slate-500">{pie}</p>}
    </div>
  )
}

export function RqDashboard() {
  const [datos, setDatos] = useState<DatosReporte | null>(null)
  const [loading, setLoading] = useState(true)
  const [exportando, setExportando] = useState(false)
  const [hora, setHora] = useState('')
  const genRef = useRef(0)

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    try {
      const d = await cargarReporteAtencion()
      if (gen !== genRef.current) return
      setDatos(d)
      setHora(new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }))
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al cargar el dashboard', { description: message })
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function exportar() {
    setExportando(true)
    try {
      const nombre = await exportarExcelAtencion(datos ?? (await cargarReporteAtencion()))
      toast.success(`Descargado: ${nombre}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo exportar el Excel', { description: message })
    } finally {
      setExportando(false)
    }
  }

  if (loading && !datos) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando dashboard…
      </div>
    )
  }
  if (!datos) return null

  const kpis = kpisAtencion(datos.rqs, datos.items)
  const porDia = serieRqsPorDia(datos.rqs)
  const porLinea = serieRqsPorLinea(datos.rqs)
  const top = topArticulosAtendidos(datos.items)
  const maxDia = Math.max(...porDia.map((d) => d.rqs), 1)
  const maxLinea = Math.max(...porLinea.map((l) => l.rqs), 1)
  const maxTop = Math.max(...top.map((t) => t.atendido), 1)

  /** Últimas salidas reales del ledger (reversas excluidas). */
  const rqNum = new Map(datos.rqs.map((r) => [r.id, r.numeroRq]))
  const itemDe = new Map(datos.items.map((i) => [i.rqId + '|' + i.codigo, i]))
  const ultimas: { fecha: string; rq: string; codigo: string; desc: string; cant: number; und: string; user: string }[] =
    [...datos.tomas]
      .filter((t) => t.cantidad > 0)
      .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1))
      .slice(0, 10)
      .map((t) => {
        const it: ReporteItem | undefined = itemDe.get(t.rqId + '|' + t.codigo)
        return {
          fecha: t.creadoEn ? new Date(t.creadoEn).toLocaleString('es-PE') : '',
          rq: rqNum.get(t.rqId) ?? '',
          codigo: t.codigo,
          desc: it?.descripcion ?? '',
          cant: t.cantidad,
          und: it?.unidad ?? '',
          user: t.usuarioNombre,
        }
      })

  return (
    <div className="space-y-4">
      {/* Acciones */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-extrabold text-slate-800">Dashboard · Atención a Líneas</h3>
        {hora && <span className="text-xs text-slate-400">actualizado {hora}</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void cargar()} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualizar
          </Button>
          <Button
            size="sm"
            onClick={() => void exportar()}
            disabled={exportando}
            className="gap-1.5 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
          >
            {exportando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Exportar Excel
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi titulo="RQs totales" valor={kpis.totalRqs} />
        <Kpi titulo="Pendientes" valor={kpis.pendientes} clase={EST_KPI['Pendiente']} />
        <Kpi titulo="En proceso" valor={kpis.enProceso} clase={EST_KPI['En proceso']} />
        <Kpi titulo="Atendidas" valor={kpis.atendidas} clase={EST_KPI['Atendido']} />
        <Kpi titulo="% atención" valor={`${kpis.pctAtencion}%`} pie={`${kpis.materialesAtendidos}/${kpis.materiales} materiales`} />
        <Kpi titulo="Unidades" valor={kpis.unidadesAtendidas} pie={`de ${kpis.unidadesPedidas} pedidas`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* RQs por día */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">RQs por día (14 días)</p>
          <div className="space-y-1.5">
            {porDia.filter((d) => d.rqs > 0 || d.atendidas > 0).length === 0 && (
              <p className="py-4 text-center text-xs text-slate-400">Sin registros en los últimos 14 días</p>
            )}
            {porDia.filter((d) => d.rqs > 0 || d.atendidas > 0).map((d) => (
              <Barra
                key={d.dia}
                etiqueta={diaCorto(d.dia)}
                valor={d.rqs}
                max={maxDia}
                detalle={`${d.rqs} · ${d.atendidas} att.`}
                color="bg-gradient-to-r from-teal-400 to-cyan-500"
              />
            ))}
          </div>
        </div>

        {/* Por línea */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">RQs por línea / área</p>
          <div className="space-y-1.5">
            {porLinea.length === 0 && <p className="py-4 text-center text-xs text-slate-400">Sin datos</p>}
            {porLinea.map((l) => (
              <Barra
                key={l.linea}
                etiqueta={l.linea}
                valor={l.rqs}
                max={maxLinea}
                detalle={`${l.rqs} · ${l.atendidas} att.`}
                color="bg-gradient-to-r from-violet-400 to-purple-500"
              />
            ))}
          </div>
        </div>

        {/* Top materiales */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Top materiales atendidos</p>
          <div className="space-y-1.5">
            {top.length === 0 && <p className="py-4 text-center text-xs text-slate-400">Aún no hay atenciones</p>}
            {top.map((t) => (
              <Barra
                key={t.codigo}
                etiqueta={t.codigo}
                valor={t.atendido}
                max={maxTop}
                detalle={`${t.atendido.toLocaleString('es-PE')} ${t.unidad}`}
                color="bg-gradient-to-r from-amber-400 to-orange-500"
              />
            ))}
          </div>
        </div>

        {/* Últimas salidas */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Últimas salidas (ledger)</p>
          <div className="max-h-56 space-y-1 overflow-y-auto text-xs">
            {ultimas.length === 0 && <p className="py-4 text-center text-slate-400">Sin salidas registradas</p>}
            {ultimas.map((u, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
                <span className="w-20 shrink-0 truncate text-slate-400">{u.fecha.split(',')[0]}</span>
                <span className="w-24 shrink-0 truncate font-semibold text-slate-700">{u.rq}</span>
                <span className="w-14 shrink-0 text-slate-500">{u.codigo}</span>
                <span className="flex-1 truncate text-slate-600" title={u.desc}>{u.desc}</span>
                <span className="shrink-0 tabular-nums font-semibold text-slate-800">
                  {u.cant.toLocaleString('es-PE')} {u.und}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Resumen por artículo (compacto, top 10) */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
          Resumen por artículo (top 10 por atendido — completo en el Excel)
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2 font-semibold">Código</th>
                <th className="py-1 pr-2 font-semibold">Descripción</th>
                <th className="py-1 pr-2 text-right font-semibold">RQs</th>
                <th className="py-1 pr-2 text-right font-semibold">Pedido</th>
                <th className="py-1 pr-2 text-right font-semibold">Atendido</th>
                <th className="py-1 text-right font-semibold">%</th>
              </tr>
            </thead>
            <tbody>
              {resumenPorArticulo(datos.items, datos.rqs).slice(0, 10).map((r) => (
                <tr key={r.codigo} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-semibold text-slate-700">{r.codigo}</td>
                  <td className="py-1 pr-2 text-slate-600">{r.descripcion || '—'}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.numRqs}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.totalPedido.toLocaleString('es-PE')}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.totalAtendido.toLocaleString('es-PE')}</td>
                  <td className={`py-1 text-right tabular-nums font-semibold ${r.pctAtendido >= 100 ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {r.pctAtendido}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
