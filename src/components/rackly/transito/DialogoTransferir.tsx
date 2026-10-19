'use client'

/**
 * RACKLY — TRÁNSITO · Diálogo de transferencia (1 artículo o lote batch).
 *
 * Flujo (v3.3): elegir destino (RACK / PISO) → mapa visual con selección por
 * clic → revisar cantidades (parcial permitido por artículo) → confirmación
 * → ejecución secuencial: cada artículo genera SU PROPIO ingreso nativo en el
 * módulo destino y SU PROPIO registro de envío (uuid único), con su semáforo
 * independiente. Anti-sobreenvío revalidado por la RPC; errores mostrados
 * uno por uno sin bloquear a los demás artículos.
 */

import { useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Layers, Loader2, Warehouse, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  transferirArticulo,
  validarCantidad,
  mensajeRpcError,
  datosFaltantes,
  type ArticuloTransito,
  type UsuarioTransito,
} from '@/lib/rackly/transito'
import { MapaRackSelector, type SeleccionRack } from './MapaRackSelector'
import { MapaPisoSelector, type SeleccionPiso } from './MapaPisoSelector'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'

type Paso = 'destino' | 'mapaRack' | 'mapaPiso' | 'confirmar' | 'ejecutando' | 'resultado'

type ResultadoPorArticulo = {
  articulo: ArticuloTransito
  cantidad: number
  ok: boolean
  mensaje: string
}

export function DialogoTransferir({
  items,
  usuario,
  turno,
  onListo,
  onCancelar,
}: {
  items: ArticuloTransito[]
  usuario: UsuarioTransito
  turno: string
  onListo: () => void
  onCancelar: () => void
}) {
  const [paso, setPaso] = useState<Paso>('destino')
  const [cantidades, setCantidades] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((a) => [a.id, String(a.pendiente)]))
  )
  const [seleccionRack, setSeleccionRack] = useState<SeleccionRack | null>(null)
  const [seleccionPiso, setSeleccionPiso] = useState<SeleccionPiso | null>(null)
  const [resultados, setResultados] = useState<ResultadoPorArticulo[]>([])
  /** ALERTA v2: confirmación explícita cuando algún artículo va sin lote/fechas
   *  (transferencia consciente — nadie envía sin darse cuenta). */
  const [pedirConfirmSinDatos, setPedirConfirmSinDatos] = useState(false)
  // Uuid FIJO por artículo (uno al confirmar, estable entre reintentos):
  // la idempotencia de la RPC depende de que el reintento del MISMO envío
  // lleve el MISMO uuid (nuevoUuid() por intento la mataba).
  const uuidsRef = useRef<Record<string, string>>({})

  const esBatch = items.length > 1
  const titulo = useMemo(
    () => (esBatch ? `Transferir ${items.length} artículos juntos` : 'Transferir artículo'),
    [esBatch, items.length]
  )

  /** Artículos que van SIN lote y/o fechas (v2: transferibles con alerta). */
  const itemsSinDatos = useMemo(
    () => items.filter((a) => datosFaltantes(a).length > 0),
    [items]
  )

  const cantidadDe = (a: ArticuloTransito): number => {
    const raw = (cantidades[a.id] ?? '').trim().replace(',', '.')
    const n = parseFloat(raw)
    return isNaN(n) ? 0 : n
  }

  const validarTodo = (): string | null => {
    for (const a of items) {
      const v = validarCantidad(cantidadDe(a), a.pendiente)
      if (v) return `${a.codigo}: ${v}`
    }
    return null
  }

  const recibirRack = (sel: SeleccionRack) => {
    setSeleccionRack(sel)
    setSeleccionPiso(null)
    setPaso('confirmar')
  }

  const recibirPiso = (sel: SeleccionPiso) => {
    setSeleccionPiso(sel)
    setSeleccionRack(null)
    setPaso('confirmar')
  }

  /** Click en “Confirmar”: valida cantidades y, si algo va sin datos, abre la
   *  ALERTA de confirmación explícita (el envío solo sigue con “Sí, transferir”). */
  const onConfirmarClick = () => {
    const err = validarTodo()
    if (err) {
      toast.error(err)
      return
    }
    if (itemsSinDatos.length > 0) setPedirConfirmSinDatos(true)
    else void confirmarEnvios()
  }

  const confirmarEnvios = async () => {
    const err = validarTodo()
    if (err) {
      toast.error(err)
      return
    }
    setPaso('ejecutando')
    // Un uuid POR ARTÍCULO, generado UNA vez al confirmar (idempotencia real).
    uuidsRef.current = Object.fromEntries(
      items.map((a) => [a.id, uuidsRef.current[a.id] || nuevoUuid()])
    )
    const res: ResultadoPorArticulo[] = []
    for (const a of items) {
      const cantidad = cantidadDe(a)
      try {
        const r = await transferirArticulo({
          articulo: a,
          destino: seleccionPiso ? 'piso' : 'rack',
          cantidad,
          turno,
          usuario,
          rack: seleccionRack?.rack,
          nivel: seleccionPiso
            ? { nivel_id: seleccionPiso.nivel_id, posicion_id: seleccionPiso.posicion_id, nivelNumero: seleccionPiso.nivelNumero }
            : undefined,
          etiqueta: seleccionPiso ? seleccionPiso.etiqueta : seleccionRack?.etiqueta ?? '',
          uuidSync: uuidsRef.current[a.id],
        })
        res.push({
          articulo: a,
          cantidad,
          ok: true,
          mensaje: r.duplicado
            ? 'Ya estaba registrado (reintento)'
            : r.estado === 'COMPLETO'
              ? 'Transferido completo'
              : `Parcial: quedan ${r.pendiente}`,
        })
      } catch (e) {
        console.error('[DialogoTransferir] error envío:', e)
        res.push({ articulo: a, cantidad, ok: false, mensaje: mensajeRpcError(e) })
      }
    }
    setResultados(res)
    setPaso('resultado')
    const okN = res.filter((r) => r.ok).length
    if (okN === res.length) toast.success(`Transferencia${esBatch ? 's' : ''} registrada${esBatch ? 's' : ''} (${okN})`)
    else if (okN > 0) toast.warning(`${okN} de ${res.length} transferencias registradas`)
  }

  const cerrar = () => {
    if (resultados.length > 0) onListo()
    else onCancelar()
  }

  return (
    <Dialog open onOpenChange={(open) => {
      // Durante EJECUCIÓN el diálogo no se cierra (ESC/click-fuera): el bucle
      // de RPCs sigue en vuelo — cerrarlo dejaba al usuario sin resultados y
      // la lista sin refrescar (semáforo stale sin indicación).
      if (!open && paso === 'ejecutando') return
      if (!open) cerrar()
    }}>
      <DialogContent className="max-w-2xl max-h-[92dvh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ArrowRightLeft className="h-4 w-4 text-fuchsia-600" />
            {titulo}
          </DialogTitle>
          <DialogDescription>
            Recepción → {seleccionPiso ? 'Piso' : seleccionRack ? 'Racks' : 'Racks / Piso'} ·{' '}
            {items.length} artículo{esBatch ? 's' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* ── PASO 1: destino ── */}
          {paso === 'destino' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                ¿A qué módulo entra la mercadería? Se abrirá el mapa visual del módulo elegido.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => setPaso('mapaRack')}
                  className="rounded-2xl border-2 border-violet-200 bg-violet-50/60 hover:border-violet-400 hover:bg-violet-100/60 transition-all p-5 text-left space-y-2"
                >
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md shadow-violet-500/25">
                    <Warehouse className="h-5 w-5 text-white" />
                  </div>
                  <p className="font-extrabold text-slate-900">RACK</p>
                  <p className="text-xs text-slate-500">
                    Bloque · Torre · Piso · Posición (1–9 bloques)
                  </p>
                </button>
                <button
                  onClick={() => setPaso('mapaPiso')}
                  className="rounded-2xl border-2 border-sky-200 bg-sky-50/60 hover:border-sky-400 hover:bg-sky-100/60 transition-all p-5 text-left space-y-2"
                >
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center shadow-md shadow-sky-500/25">
                    <Layers className="h-5 w-5 text-white" />
                  </div>
                  <p className="font-extrabold text-slate-900">PISO</p>
                  <p className="text-xs text-slate-500">
                    Sector · Columna · Posición · Nivel
                  </p>
                </button>
              </div>
            </div>
          )}

          {/* ── PASO 2: mapas ── */}
          {paso === 'mapaRack' && (
            <MapaRackSelector codigoMarca={items.length === 1 ? items[0].codigo : ''} onConfirm={recibirRack} />
          )}
          {paso === 'mapaPiso' && (
            <MapaPisoSelector codigoMarca={items.length === 1 ? items[0].codigo : ''} onConfirm={recibirPiso} />
          )}

          {/* ── PASO 3: confirmación con cantidades ── */}
          {paso === 'confirmar' && (
            <div className="space-y-4">
              {/* ALERTA v2 — transferencia consciente: visible ANTES de confirmar */}
              {itemsSinDatos.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-amber-900">
                      {itemsSinDatos.length} de {items.length} artículo{itemsSinDatos.length > 1 ? 's van' : ' va'} sin datos completos
                    </p>
                    <p className="text-xs text-amber-800 mt-0.5">
                      Van sin lote y/o fechas (el proveedor no los trajo). Se moverán con confirmación explícita y
                      luego puedes completar o corregir esos datos con la función <b>Editar</b> en Racks/Piso.
                    </p>
                  </div>
                </div>
              )}

              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm">
                <p className="font-bold text-slate-900">
                  Destino: {seleccionPiso ? seleccionPiso.etiqueta : seleccionRack?.etiqueta}
                </p>
                {seleccionRack?.ocupada && (
                  <p className="text-amber-700 text-xs mt-1">Co-ubicación confirmada en celda ocupada.</p>
                )}
                {seleccionPiso?.ocupada && (
                  <p className="text-amber-700 text-xs mt-1">Co-ubicación confirmada en posición ocupada.</p>
                )}
              </div>

              <ScrollArea className="max-h-[38dvh] rounded-xl border border-slate-200">
                <div className="divide-y divide-slate-100">
                  {items.map((a) => (
                    <div key={a.id} className="p-3 flex items-center gap-3">
                      <Checkbox checked disabled className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-900 truncate">
                          {a.codigo}
                          {a.nPaleta != null && (
                            <span className="ml-1.5 text-[10px] font-semibold text-slate-500">
                              Paleta {a.nPaleta}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 truncate">{a.descripcion}</p>
                        <p className="text-[11px] text-slate-400">
                          Pendiente: {a.pendiente} {a.unidadMedida} · Lote {a.lote || '—'} · Vence{' '}
                          {a.fechaVencimiento || '—'}
                        </p>
                        {/* Chips de datos faltantes (v2 — alerta consciente) */}
                        {datosFaltantes(a).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {datosFaltantes(a).map((f) => (
                              <span
                                key={f}
                                className="text-[9px] font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded px-1.5 py-px uppercase tracking-wide"
                              >
                                Sin {f}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="w-28 shrink-0">
                        <label className="text-[10px] font-semibold text-slate-500 uppercase">
                          Cantidad
                        </label>
                        <Input
                          value={cantidades[a.id] ?? ''}
                          onChange={(e) =>
                            setCantidades((prev) => ({ ...prev, [a.id]: e.target.value }))
                          }
                          inputMode="decimal"
                          className="h-9 mt-0.5"
                        />
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          de {a.pendiente} {a.unidadMedida}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <p className="text-[11px] text-slate-500">
                Puedes enviar una cantidad MENOR (parcial) — el artículo quedará en amarillo con su
                pendiente. Cada artículo genera su propio ingreso en el módulo destino.
              </p>
            </div>
          )}

          {/* ── PASO 4: ejecutando ── */}
          {paso === 'ejecutando' && (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-fuchsia-600" />
              <p className="text-sm font-semibold text-slate-700">Registrando transferencias…</p>
              <p className="text-xs text-slate-400">No cierres esta ventana</p>
            </div>
          )}

          {/* ── PASO 5: resultado ── */}
          {paso === 'resultado' && (
            <div className="space-y-3">
              {resultados.map((r) => (
                <div
                  key={r.articulo.id}
                  className={`rounded-xl border p-3 flex items-start gap-2.5 ${
                    r.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60'
                  }`}
                >
                  {r.ok ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">
                      {r.articulo.codigo} — {r.cantidad} {r.articulo.unidadMedida}
                    </p>
                    <p className={`text-xs ${r.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{r.mensaje}</p>
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-slate-500">
                El semáforo de cada artículo se actualiza al cerrar este diálogo.
              </p>
            </div>
          )}
        </div>

        {/* Pie de acciones */}
        <div className="px-5 py-3 border-t bg-white shrink-0 flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-400 truncate">
            {turno} · {usuario.nombre}
          </div>
          <div className="flex gap-2">
            {(paso === 'mapaRack' || paso === 'mapaPiso') && (
              <Button variant="outline" onClick={() => setPaso('destino')} className="gap-1">
                <XCircle className="h-4 w-4" /> Cambiar destino
              </Button>
            )}
            {paso === 'confirmar' && (
              <>
                <Button variant="outline" onClick={onCancelar}>
                  Cancelar
                </Button>
                <Button
                  onClick={onConfirmarClick}
                  className={`gap-1.5 font-semibold ${
                    itemsSinDatos.length > 0 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-fuchsia-600 hover:bg-fuchsia-700'
                  }`}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Confirmar {esBatch ? `(${items.length})` : ''}
                </Button>
              </>
            )}
            {paso === 'resultado' && (
              <Button onClick={cerrar} className="font-semibold">
                Listo
              </Button>
            )}
            {paso === 'destino' && (
              <Button variant="outline" onClick={onCancelar}>
                Cancelar
              </Button>
            )}
          </div>
        </div>
      </DialogContent>

      {/* ── ALERTA v2: confirmación EXPLÍCITA de transferencia sin lote/fechas.
          Nada se mueve hasta pulsar “Sí, transferir así” — nadie envía sin
          darse cuenta de que el artículo va sin esos datos. ── */}
      <AlertDialog open={pedirConfirmSinDatos} onOpenChange={setPedirConfirmSinDatos}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              ¿Transferir sin lote / fechas?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Estos artículos se moverán SIN estos datos:</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {itemsSinDatos.map((a) => (
                    <li key={a.id}>
                      <span className="font-semibold text-slate-900">{a.codigo}</span>
                      {a.nPaleta != null ? ` (Paleta ${a.nPaleta})` : ''}
                      {' — sin '}
                      <span className="font-semibold text-amber-800">{datosFaltantes(a).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
                <p>
                  Si el proveedor no los trajo, puedes transferir así y completarlos o corregirlos
                  después con la función <b>Editar</b> en Racks/Piso. ¿Deseas continuar?
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, revisar datos</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => {
                setPedirConfirmSinDatos(false)
                void confirmarEnvios()
              }}
            >
              Sí, transferir así
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
