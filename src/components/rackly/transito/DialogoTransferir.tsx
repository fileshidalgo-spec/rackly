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

import { useMemo, useState } from 'react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowRightLeft, CheckCircle2, Layers, Loader2, Warehouse, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  transferirArticulo,
  validarCantidad,
  mensajeRpcError,
  type ArticuloTransito,
  type UsuarioTransito,
} from '@/lib/rackly/transito'
import { MapaRackSelector, type SeleccionRack } from './MapaRackSelector'
import { MapaPisoSelector, type SeleccionPiso } from './MapaPisoSelector'

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

  const esBatch = items.length > 1
  const titulo = useMemo(
    () => (esBatch ? `Transferir ${items.length} artículos juntos` : 'Transferir artículo'),
    [esBatch, items.length]
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

  const confirmarEnvios = async () => {
    const err = validarTodo()
    if (err) {
      toast.error(err)
      return
    }
    setPaso('ejecutando')
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
    <Dialog open onOpenChange={(open) => !open && cerrar()}>
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
                  onClick={confirmarEnvios}
                  className="gap-1.5 font-semibold bg-fuchsia-600 hover:bg-fuchsia-700"
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
    </Dialog>
  )
}
