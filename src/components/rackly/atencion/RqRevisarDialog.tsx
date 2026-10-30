'use client'

/**
 * RACKLY — Atención a Línea · «Revisar» la atención de un material (Task 27).
 *
 * Qué resuelve (pedido del usuario): al lado de «Ver ubicación» y «Atender con
 * QR», una opción REVISAR donde se vea DESDE QUÉ POSICIONES se atendió el
 * material y si queda saldo en esa posición:
 *   · Se dio salida a todo → solo menciona desde qué ubicación salió.
 *   · Quedó saldo → muestra el saldo inicial en la posición, lo que se sacó
 *     y lo que queda (ahora en la posición).
 *
 * Datos: LEDGER rq_atencion_tomas (una fila por toma, Task 27 — rutas de
 * salida de Racks/Piso, puente QR y atenciones manuales) + stock ACTUAL de
 * Racks/Piso (mismos lectores de «Ver ubicación», SOLO LECTURA).
 *
 * Aislamiento: solo lee rq_atencion_tomas + lectores de stock. No escribe.
 */

import { useEffect, useState } from 'react'
import {
  revisarAtencionItem,
  type RqItem,
  type RevisionAtencion,
} from '@/lib/rackly/rq-atencion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Loader2,
  MapPin,
  PackageCheck,
  ScanLine,
  Undo2,
  HelpCircle,
  ClipboardList,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

function fechaCorta(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ')
  return d.toLocaleString('es-PE', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function RqRevisarDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item: RqItem | null
}) {
  const [cargando, setCargando] = useState(false)
  const [rev, setRev] = useState<RevisionAtencion | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !item) return
    let vigente = true
    setCargando(true)
    setError('')
    setRev(null)
    ;(async () => {
      try {
        const r = await revisarAtencionItem(item)
        if (vigente) setRev(r)
      } catch (err: unknown) {
        if (vigente) setError(mensajeError(err))
      } finally {
        if (vigente) setCargando(false)
      }
    })()
    return () => {
      vigente = false
    }
  }, [open, item])

  const pendiente = item ? Math.max(item.cantidad - item.cantidadAtendida, 0) : 0
  const sinTrazabilidad =
    rev && !rev.desdeTransito && rev.posiciones.length === 0 &&
    (!rev.manualSinPosicion || rev.manualSinPosicion.sacado === 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-xl max-h-[88vh] overflow-y-auto overscroll-contain">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-teal-600" />
            Revisar atención
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono font-bold text-indigo-700">{item?.codigo}</span>
            {item?.descripcion ? ` · ${item.descripcion}` : ''}
            {item ? ` — pedido ${fmt(item.cantidad)} · atendido ${fmt(item.cantidadAtendida)}${pendiente > 0 ? ` · pendiente ${fmt(pendiente)}` : ''}` : ''}
          </DialogDescription>
        </DialogHeader>

        {cargando && (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Revisando posiciones…
          </div>
        )}

        {error && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg p-3">{error}</p>
        )}

        {sinTrazabilidad && (
          <div className="text-center py-6 text-sm text-slate-400">
            <HelpCircle className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            Este material aún no tiene atención registrada
            {item && item.cantidadAtendida > 0 ? ' con trazabilidad (fue atendido antes del ledger de tomas).' : '.'}
          </div>
        )}

        {rev && (
          <div className="space-y-3">
            {/* ── Posiciones físicas (racks/piso) ── */}
            {rev.posiciones.map((p) => {
              const salidaCompleta = p.saldoActual !== null ? p.saldoActual <= 0 : (p.saldoAlMomento ?? null) === 0
              const quedo = p.saldoAlMomento ?? p.saldoActual
              const inicial = quedo !== null ? quedo + p.sacado : null
              return (
                <div
                  key={p.ubicacion}
                  className={`rounded-xl border p-3 space-y-2 ${
                    salidaCompleta ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                        <MapPin className={`h-4 w-4 shrink-0 ${p.origen === 'piso' ? 'text-sky-500' : 'text-violet-500'}`} />
                        {p.ubicacion}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        {p.origen === 'piso' ? 'Piso' : 'Racks'}
                        {p.usuarios.length > 0 ? ` · ${p.usuarios.join(', ')}` : ''}
                        {p.ultimaFecha ? ` · ${fechaCorta(p.ultimaFecha)}` : ''}
                      </p>
                    </div>
                    {salidaCompleta ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 bg-emerald-100 text-emerald-800 shrink-0">
                        <PackageCheck className="h-3 w-3 mr-0.5" /> Salida completa
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] border-amber-200 bg-amber-50 text-amber-700 shrink-0">
                        Quedó saldo
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    <div className="rounded-lg bg-slate-50 border border-slate-100 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Saldo inicial</p>
                      <p className="text-sm font-extrabold text-slate-700">{inicial !== null ? fmt(inicial) : '—'}</p>
                    </div>
                    <div className="rounded-lg bg-teal-50/60 border border-teal-100 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-teal-600">Se sacó</p>
                      <p className="text-sm font-extrabold text-teal-700">{fmt(p.sacado)}</p>
                    </div>
                    <div className="rounded-lg bg-amber-50/60 border border-amber-100 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-amber-500">
                        {p.saldoAlMomento !== null ? 'Quedó' : 'Queda (ahora)'}
                      </p>
                      <p className={`text-sm font-extrabold ${quedo === 0 ? 'text-emerald-600' : 'text-amber-700'}`}>
                        {quedo !== null ? fmt(quedo) : '—'}
                      </p>
                    </div>
                  </div>
                  {p.saldoAlMomento !== null && p.saldoActual !== null && p.saldoAlMomento !== p.saldoActual && (
                    <p className="text-[10px] text-slate-400">
                      Saldo actual en la posición: <b>{fmt(p.saldoActual)}</b> (hubo otros movimientos después).
                    </p>
                  )}
                  {p.tomas.length > 1 && (
                    <details className="text-[10px] text-slate-500">
                      <summary className="cursor-pointer select-none">Detalle de tomas ({p.tomas.length})</summary>
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {p.tomas.map((t) => (
                          <li key={t.id}>
                            {t.cantidad > 0 ? '+' : ''}{fmt(t.cantidad)} · {fechaCorta(t.fecha)}
                            {t.usuarioNombre ? ` · ${t.usuarioNombre}` : ''}
                            {t.saldoResultante !== null ? ` · saldo ${fmt(t.saldoResultante)}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )
            })}

            {/* ── Descontado de guías en tránsito (puente QR) ── */}
            {rev.desdeTransito && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-3 space-y-1">
                <p className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                  <ScanLine className="h-4 w-4 text-sky-500 shrink-0" />
                  Desde Tránsito (guía)
                </p>
                <p className="text-xs text-slate-600">
                  Se sacó <b>{fmt(rev.desdeTransito.sacado)} {item?.unidad}</b> directamente de la guía en tránsito
                  (escaneo de paletas).
                </p>
                {rev.desdeTransito.tomas.length > 0 && (
                  <p className="text-[10px] text-slate-400">
                    {rev.desdeTransito.tomas.length} toma(s) · {fechaCorta(rev.desdeTransito.tomas[rev.desdeTransito.tomas.length - 1].fecha)}
                  </p>
                )}
              </div>
            )}

            {/* ── Atención manual sin posición + reversas ── */}
            {rev.manualSinPosicion && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-1">
                <p className="text-sm font-bold text-slate-700">Atención manual (sin posición)</p>
                <p className="text-xs text-slate-600">
                  {rev.manualSinPosicion.sacado > 0 ? (
                    <>Se registró <b>{fmt(rev.manualSinPosicion.sacado)} {item?.unidad}</b> con el botón «Atender»
                      (digitado), sin marcar la posición de salida.</>
                  ) : (
                    <>Solo hay reversas registradas de esta atención.</>
                  )}
                </p>
                <ul className="text-[10px] text-slate-400 space-y-0.5 pl-3">
                  {rev.manualSinPosicion.tomas.slice(-6).map((t) => (
                    <li key={t.id}>
                      {t.cantidad > 0 ? '+' : ''}{fmt(t.cantidad)} · {fechaCorta(t.fecha)}
                      {t.usuarioNombre ? ` · ${t.usuarioNombre}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── Resumen de reversas ── */}
            {rev.totalRevertido > 0 && (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <Undo2 className="h-3 w-3 text-amber-500" />
                Total revertido en esta atención: <b>{fmt(rev.totalRevertido)} {item?.unidad}</b> (ya descontado de los
                saldos de arriba).
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cerrar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
