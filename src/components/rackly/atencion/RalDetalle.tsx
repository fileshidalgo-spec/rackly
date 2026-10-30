'use client'

/**
 * RACKLY — Atención a Línea · Detalle de un RAL (atender materiales).
 *
 * Modelo de atención UNIFICADO con la RQ (2026-10-30, pedido del usuario:
 * «la forma de atender debe ser similar para ambos casos»). Misma UX que
 * RqDetalle: tabla de materiales con ATENDIDO / PENDIENTE / ATENDER,
 * confirmación antes de registrar (RPC atómica ral_atender_item), excedente
 * permitido ("puede ser más, nunca menos"), reversa de atenciones erradas y
 * barra de progreso. El estado del encabezado lo recalcula la RPC con la
 * MISMA regla canónica de la RQ.
 *
 * Diferencias respecto al detalle de RQ (la «información distinta»):
 *   · Sin ubicaciones/QR/Revisar/lotes-puente: el RAL no tiene modelo
 *     lote/posición (son materiales generales de almacén).
 *   · Sin historial de ediciones.
 *   · Muestra C. de COSTOS por material (propio del formato RAL).
 *
 * Móvil: tarjetas por material (sin scroll horizontal anidado).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime } from '@/hooks/useRegistrosRealtime'
import {
  atenderItemRal,
  revertirItemRal,
  obtenerRalCompleta,
  type RalRegistro,
  type RalItem,
} from '@/lib/rackly/ral'
import { estadoDeItem, pendienteDeItem } from '@/lib/rackly/rq-atencion'
import { aNumero } from '@/lib/rackly/formato'
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
  ArrowLeft,
  Loader2,
  CheckCircle2,
  PackageOpen,
  Undo2,
  Plus,
  ClipboardList,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

const ESTADO_RAL_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

/** Atención pendiente de confirmar (item + cantidad digitada). */
type ConfirmacionAtender = { item: RalItem; cantidad: number }

/** Reversión pendiente de confirmar. */
type ConfirmacionRevertir = { item: RalItem; cantidad: number }

export function RalDetalle({ ralId, onVolver }: { ralId: string; onVolver: () => void }) {
  const { perfil } = useAuth()
  const [ral, setRal] = useState<RalRegistro | null>(null)
  const [items, setItems] = useState<RalItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cantidades, setCantidades] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmarAtender, setConfirmarAtender] = useState<ConfirmacionAtender | null>(null)
  const [confirmarRevertir, setConfirmarRevertir] = useState<ConfirmacionRevertir | null>(null)
  /** Filas COMPLETAS donde el usuario abrió el atender para añadir EXCEDENTE. */
  const [excedenteAbierto, setExcedenteAbierto] = useState<Record<string, boolean>>({})

  const genRef = useRef(0)
  const savingRef = useRef(false)

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const { ral: ralNuevo, items: itemsNuevos } = await obtenerRalCompleta(ralId)
      if (gen !== genRef.current) return
      setRal(ralNuevo)
      setItems(itemsNuevos)
      setError('')
      // Precarga la cantidad PENDIENTE como propuesta de atención (igual que RQ)
      setCantidades((prev) => {
        const next = { ...prev }
        for (const it of itemsNuevos) {
          if (next[it.id] === undefined) next[it.id] = String(pendienteDeItem(it) || '')
        }
        return next
      })
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      const message = mensajeError(err)
      setError(message)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [ralId])

  useEffect(() => {
    void cargar()
  }, [cargar])

  /** Realtime: otro usuario atendiendo el mismo RAL aparece al instante. */
  const recargar = useCallback(() => {
    if (savingRef.current) return
    void cargar()
  }, [cargar])
  useRegistrosRealtime('rals', recargar)

  function abrirConfirmacion(item: RalItem) {
    // Igual que la RQ: aNumero lee coma decimal (Task 20 M2).
    const leida = aNumero(cantidades[item.id] ?? '')
    if (!leida || leida <= 0) {
      toast.error('Digita la cantidad a atender')
      return
    }
    setConfirmarAtender({ item, cantidad: leida })
  }

  async function ejecutarAtender() {
    const conf = confirmarAtender
    if (!conf) return
    setConfirmarAtender(null)
    setSavingId(conf.item.id)
    savingRef.current = true
    try {
      const actualizado = await atenderItemRal(
        conf.item.id,
        conf.cantidad,
        perfil?.nombre || perfil?.correo || ''
      )
      setItems((prev) => prev.map((it) => (it.id === actualizado.id ? actualizado : it)))
      setCantidades((prev) => ({ ...prev, [actualizado.id]: String(pendienteDeItem(actualizado) || '') }))
      const completo = estadoDeItem(actualizado) === 'Atendido'
      toast.success(
        `Atendido: ${fmt(conf.cantidad)} ${conf.item.unidad}`.trim(),
        {
          description: completo
            ? actualizado.cantidadAtendida > actualizado.cantidad
              ? `Ya completaste este artículo (excedente: ${fmt(actualizado.cantidadAtendida - actualizado.cantidad)} ${actualizado.unidad})`.trim()
              : 'Ya completaste este artículo'
            : `Pendiente: ${fmt(pendienteDeItem(actualizado))} ${conf.item.unidad}`.trim(),
        }
      )
      if (completo) {
        setExcedenteAbierto((prev) => ({ ...prev, [actualizado.id]: false }))
      }
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('No se pudo atender', { description: message })
      void cargar() // re-sincroniza si otro usuario movió la fila
    } finally {
      setSavingId(null)
      savingRef.current = false
    }
  }

  function abrirReversion(item: RalItem) {
    if (item.cantidadAtendida <= 0) {
      toast.error('Este artículo no tiene atención registrada')
      return
    }
    setConfirmarRevertir({ item, cantidad: item.cantidadAtendida })
  }

  async function ejecutarRevertir() {
    const conf = confirmarRevertir
    if (!conf) return
    setConfirmarRevertir(null)
    setSavingId(conf.item.id)
    savingRef.current = true
    try {
      const actualizado = await revertirItemRal(conf.item.id, conf.cantidad)
      setItems((prev) => prev.map((it) => (it.id === actualizado.id ? actualizado : it)))
      setCantidades((prev) => ({ ...prev, [actualizado.id]: String(pendienteDeItem(actualizado) || '') }))
      toast.success(`Revertido: ${fmt(conf.cantidad)} ${conf.item.unidad}`.trim())
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('No se pudo revertir', { description: message })
    } finally {
      setSavingId(null)
      savingRef.current = false
    }
  }

  if (loading && !ral) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500 py-10 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando el RAL…
      </p>
    )
  }

  if (error || !ral) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onVolver} className="gap-2">
            <ArrowLeft className="h-4 w-4" /> Retornar
          </Button>
        </div>
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error || 'RAL no encontrado'}
        </p>
      </div>
    )
  }

  const atendidos = items.filter((it) => estadoDeItem(it) === 'Atendido').length
  const cantSolicitada = items.reduce((s, it) => s + it.cantidad, 0)
  const cantAtendida = items.reduce((s, it) => s + it.cantidadAtendida, 0)
  // Con sobreatención el avance puede pasar del 100%: la barra se satura en 100.
  const progresoPct = cantSolicitada > 0 ? Math.min(100, Math.round((cantAtendida / cantSolicitada) * 100)) : 0

  return (
    <div className="space-y-4">
      {/* ── Volver ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onVolver} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Retornar
        </Button>
        <span className="text-xs text-slate-400">Vuelve a la lista unificada para seguir atendiendo</span>
      </div>

      {/* ── Encabezado del RAL ── */}
      <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-violet-600" />
              <Badge variant="outline" className="border-violet-300 bg-violet-100 text-violet-800 text-[10px]">
                RAL
              </Badge>
              {ral.documento || 'sin documento'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Requerimiento al Almacén
              {ral.transaccion ? ` · transacción ${ral.transaccion}` : ''}
            </p>
          </div>
          <Badge variant="outline" className={`${ESTADO_RAL_CLASE[ral.estado] ?? ''}`}>
            {ral.estado}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600 min-[430px]:grid-cols-3">
          <span>Fecha: <b>{ral.fecha}</b></span>
          {ral.areaSolicitante && <span className="min-w-0 truncate" title={ral.areaSolicitante}>Área: <b>{ral.areaSolicitante}</b></span>}
          {ral.solicitante && <span className="min-w-0 truncate" title={ral.solicitante}>Solicitante: <b>{ral.solicitante}</b></span>}
          {ral.aprobadoPor && <span className="min-w-0 truncate" title={ral.aprobadoPor}>Aprobó: <b>{ral.aprobadoPor}</b></span>}
          {ral.almacen && <span className="min-w-0 truncate" title={ral.almacen}>Almacén: <b>{ral.almacen}</b></span>}
          {ral.linea && <span className="min-w-0 truncate" title={ral.linea}>Línea: <b>{ral.linea}</b></span>}
          <span>Registró: <b>{ral.usuarioNombre || '—'}</b></span>
        </div>
        {ral.notas && <p className="text-xs text-slate-500 whitespace-pre-wrap">{ral.notas}</p>}

        {/* Progreso (igual que la RQ) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500">
            <span>
              {atendidos}/{items.length} materiales completos · {fmt(cantAtendida)} de {fmt(cantSolicitada)}
            </span>
            <span>{progresoPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all"
              style={{ width: `${progresoPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Materiales (desktop: tabla — mismas columnas de atención que la RQ) ── */}
      <div className="hidden md:block rounded-lg border bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 w-[90px]">Código</th>
              <th className="px-3 py-2">Artículo o descripción</th>
              <th className="px-3 py-2 w-[60px]">Und</th>
              <th className="px-3 py-2 w-[100px]">C. costos</th>
              <th className="px-3 py-2 w-[100px] text-right">Cantidad</th>
              <th className="px-3 py-2 w-[100px] text-right">Atendido</th>
              <th className="px-3 py-2 w-[100px] text-right">Pendiente</th>
              <th className="px-3 py-2 w-[190px]">Atender</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-sm text-slate-400 py-10">
                  Sin materiales registrados en este RAL.
                </td>
              </tr>
            )}
            {items.map((it) => {
              const pendiente = pendienteDeItem(it)
              const atendiendo = savingId === it.id
              const excedente = it.cantidadAtendida - it.cantidad
              return (
                <tr key={it.id} className="border-t hover:bg-slate-50/40">
                  <td className="px-3 py-2 font-mono font-semibold text-violet-700">{it.codigo || '—'}</td>
                  <td className="px-3 py-2 max-w-[280px] truncate" title={it.descripcion}>
                    {it.descripcion || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{it.unidad || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{it.centroCostos || '—'}</td>
                  <td className="px-3 py-2 text-right font-bold text-slate-800">
                    {fmt(it.cantidad)} <span className="text-[10px] font-normal text-slate-400">{it.unidad}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">
                    {fmt(it.cantidadAtendida)}
                    {excedente > 0 && (
                      <span className="ml-1 text-[10px] font-semibold text-amber-700" title="Excedente sobre lo pedido">
                        +{fmt(excedente)}
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${pendiente > 0 ? 'text-amber-700' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {fmt(pendiente)}
                  </td>
                  <td className="px-3 py-2">
                    {pendiente > 0 || excedenteAbierto[it.id] ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 w-[74px] text-right"
                          inputMode="decimal"
                          placeholder={pendiente > 0 ? undefined : '+ excedente'}
                          value={cantidades[it.id] ?? ''}
                          onChange={(e) =>
                            setCantidades((prev) => ({ ...prev, [it.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') abrirConfirmacion(it)
                          }}
                        />
                        <Button
                          size="sm"
                          className="h-8 gap-1 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
                          disabled={atendiendo}
                          onClick={() => abrirConfirmacion(it)}
                        >
                          {atendiendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          Atender
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-emerald-600 flex items-center gap-1" title="Ya completaste este artículo">
                          <PackageOpen className="h-3.5 w-3.5" /> Completo
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-1.5 text-[10px] text-slate-400 hover:text-violet-600"
                          title="Agregar excedente (más de lo requerido)"
                          onClick={() =>
                            setExcedenteAbierto((prev) => ({ ...prev, [it.id]: !prev[it.id] }))
                          }
                        >
                          <Plus className="h-3 w-3" /> Excedente
                        </Button>
                        {it.cantidadAtendida > 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-400 hover:text-amber-600"
                            title="Revertir atención"
                            onClick={() => abrirReversion(it)}
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Materiales (móvil: tarjetas) ── */}
      <div className="md:hidden space-y-2.5">
        {items.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-8">Sin materiales registrados en este RAL.</p>
        )}
        {items.map((it) => {
          const pendiente = pendienteDeItem(it)
          const atendiendo = savingId === it.id
          const excedente = it.cantidadAtendida - it.cantidad
          return (
            <div key={it.id} className="rounded-xl border bg-white p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-slate-900 font-mono">{it.codigo || '—'}</p>
                  <p className="text-xs text-slate-500 truncate" title={it.descripcion}>
                    {it.descripcion || '—'}
                    {it.centroCostos ? ` · CC ${it.centroCostos}` : ''}
                  </p>
                </div>
                <Badge variant="outline" className={`${pendiente > 0 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'} text-[10px] shrink-0`}>
                  {pendiente > 0 ? `Pendiente ${fmt(pendiente)}` : 'Completo'}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-1 text-xs">
                <span className="text-slate-500">
                  Cantidad: <b className="text-slate-800">{fmt(it.cantidad)}</b> {it.unidad}
                </span>
                <span className="text-slate-500">
                  Atendido: <b className="text-emerald-700">{fmt(it.cantidadAtendida)}</b>
                  {excedente > 0 ? <span className="text-amber-700"> (+{fmt(excedente)})</span> : null}
                </span>
                <span className="text-slate-500">
                  Queda: <b className={pendiente > 0 ? 'text-amber-700' : 'text-emerald-600'}>{fmt(pendiente)}</b>
                </span>
              </div>
              {pendiente > 0 || excedenteAbierto[it.id] ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    className="h-9 flex-1 text-right"
                    inputMode="decimal"
                    placeholder={pendiente > 0 ? String(pendiente) : '+ excedente'}
                    value={cantidades[it.id] ?? ''}
                    onChange={(e) => setCantidades((prev) => ({ ...prev, [it.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') abrirConfirmacion(it)
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-9 gap-1 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
                    disabled={atendiendo}
                    onClick={() => abrirConfirmacion(it)}
                  >
                    {atendiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Atender
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-emerald-600 flex items-center gap-1 flex-1">
                    <PackageOpen className="h-3.5 w-3.5" /> Completo
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-[10px] text-slate-500"
                    onClick={() => setExcedenteAbierto((prev) => ({ ...prev, [it.id]: !prev[it.id] }))}
                  >
                    <Plus className="h-3 w-3" /> Excedente
                  </Button>
                  {it.cantidadAtendida > 0 && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-amber-600"
                      title="Revertir atención"
                      onClick={() => abrirReversion(it)}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Confirmación de ATENDER ── */}
      <AlertDialog open={!!confirmarAtender} onOpenChange={(o) => !o && setConfirmarAtender(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Registrar la atención?</AlertDialogTitle>
            <AlertDialogDescription>
              Registrarás <b>{confirmarAtender ? fmt(confirmarAtender.cantidad) : ''}</b>{' '}
              {confirmarAtender?.item.unidad} del artículo{' '}
              <b className="font-mono">{confirmarAtender?.item.codigo}</b>{' '}
              {confirmarAtender?.item.descripcion ? `(${confirmarAtender.item.descripcion})` : ''}.
              {confirmarAtender &&
                confirmarAtender.cantidad > pendienteDeItem(confirmarAtender.item) && (
                  <>
                    <br />
                    <br />
                    <span className="font-semibold text-amber-700">
                      Atiendes MÁS de lo requerido (excedente:{' '}
                      {fmt(confirmarAtender.cantidad - pendienteDeItem(confirmarAtender.item))}{' '}
                      {confirmarAtender.item.unidad}): el material quedará COMPLETO.
                    </span>
                  </>
                )}
              <br />
              <br />
              Pendiente después:{' '}
              <b>
                {confirmarAtender
                  ? fmt(Math.max(pendienteDeItem(confirmarAtender.item) - confirmarAtender.cantidad, 0))
                  : ''}{' '}
                {confirmarAtender?.item.unidad}
              </b>
              . Esta acción suma a lo ya atendido y se registra con tu usuario.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={ejecutarAtender}
              className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white"
            >
              Sí, atender
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirmación de REVERTIR ── */}
      <AlertDialog open={!!confirmarRevertir} onOpenChange={(o) => !o && setConfirmarRevertir(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revertir la atención?</AlertDialogTitle>
            <AlertDialogDescription>
              Se devolverá <b>{confirmarRevertir ? fmt(confirmarRevertir.cantidad) : ''}</b> a pendiente
              del artículo <b className="font-mono">{confirmarRevertir?.item.codigo}</b>. Úsalo solo si
              la atención se registró por error.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={ejecutarRevertir} className="bg-amber-500 hover:bg-amber-600 text-white">
              Revertir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
