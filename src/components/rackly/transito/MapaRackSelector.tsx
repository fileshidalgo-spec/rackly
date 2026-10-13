'use client'

/**
 * RACKLY — TRÁNSITO · Mapa visual de ubicaciones de RACKS.
 *
 * Reutiliza el motor de ocupación del módulo Racks (RPC ocupacion_celdas_v2)
 * y lo convierte en selector: TODAS las celdas son clicables.
 *   · Libre    → verde, clic = elegir.
 *   · Ocupada  → ámbar con stock, clic = avisar contenido y pedir
 *                confirmación para co-ubicar (regla v3.3: nunca silenciosa).
 *   · Mismo código del artículo → marcador violeta para agrupar cerca.
 * Sugerencia automática: la primera celda libre del piso más bajo queda
 * preseleccionada ("Sugerido").
 */

import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { CheckCircle2, Loader2, MapPin, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  BLOQUES,
  PISOS,
  torresDeBloque,
  posicionesDeBloque,
} from '@/lib/rackly/ubicaciones'
import {
  ocupacionRacks,
  claveCeldaRack,
  etiquetaRack,
  type OcupacionCelda,
} from '@/lib/rackly/transito'

export type SeleccionRack = {
  rack: { bloque: string; torre: string; piso: string; posicion: string }
  etiqueta: string
  ocupada: boolean
  /** Códigos presentes en la celda (solo si está ocupada). */
  codigos: string[]
  /** Stock total de la celda (solo si está ocupada). */
  stockTotal: number
}

const EPS = 0.0005

export function MapaRackSelector({
  codigoMarca,
  onConfirm,
}: {
  /** Código del artículo a transferir (marca sus celdas para agrupar). */
  codigoMarca: string
  onConfirm: (sel: SeleccionRack) => void
}) {
  const [celdas, setCeldas] = useState<OcupacionCelda[] | null>(null)
  const [cargando, setCargando] = useState(true)
  const [bloque, setBloque] = useState<string>('1')
  const [sel, setSel] = useState<SeleccionRack | null>(null)
  const [sugerida, setSugerida] = useState<string | null>(null)
  const [pedirConfirmCoUbicar, setPedirConfirmCoUbicar] = useState(false)

  const cargar = async () => {
    setCargando(true)
    try {
      const res = await ocupacionRacks()
      setCeldas(res ?? [])
    } catch (err) {
      console.error('[MapaRack] Error cargando ocupación:', err)
      toast.error('No se pudo cargar la ocupación de racks')
      setCeldas([])
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    cargar()
  }, [])

  const mapa = useMemo(() => {
    const m = new Map<string, OcupacionCelda>()
    for (const c of celdas ?? []) m.set(claveCeldaRack(c), c)
    return m
  }, [celdas])

  // Sugerencia: primera celda libre (bloque asc, torre 1ª, piso más bajo, posición 1ª)
  useEffect(() => {
    if (!celdas || sugerida) return
    for (const b of BLOQUES) {
      for (const t of torresDeBloque(b)) {
        for (const p of PISOS) {
          for (const pos of posicionesDeBloque(b)) {
            const c = mapa.get(claveCeldaRack({ bloque: b, torre: t, piso: p, posicion: pos }))
            if (!c || c.stock <= EPS) {
              const r = { bloque: b, torre: t, piso: p, posicion: pos }
              setSugerida(claveCeldaRack(r))
              setBloque(b)
              setSel({ rack: r, etiqueta: etiquetaRack(r), ocupada: false, codigos: [], stockTotal: 0 })
              return
            }
          }
        }
      }
    }
    // Sin celdas libres: no se sugiere (co-ubicar sigue siendo posible)
  }, [celdas, mapa, sugerida])

  const clickCelda = (rack: SeleccionRack['rack']) => {
    const c = mapa.get(claveCeldaRack(rack))
    const ocupada = !!c && c.stock > EPS
    const s: SeleccionRack = {
      rack,
      etiqueta: etiquetaRack(rack),
      ocupada,
      codigos: ocupada ? (c?.codigos ?? []) : [],
      stockTotal: ocupada ? c?.stock ?? 0 : 0,
    }
    setSel(s)
    setBloque(rack.bloque)
    if (ocupada) setPedirConfirmCoUbicar(true)
  }

  const confirmar = () => {
    if (!sel) return
    if (sel.ocupada) {
      setPedirConfirmCoUbicar(true)
      return
    }
    onConfirm(sel)
  }

  const torres = torresDeBloque(bloque)
  const posiciones = posicionesDeBloque(bloque)
  const esSugeridaVisible = !!sel && sugerida === claveCeldaRack(sel.rack)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          <MapPin className="h-4 w-4 text-violet-600" />
          Toca una celda del mapa para elegir la ubicación
        </p>
        <Button variant="ghost" size="sm" onClick={cargar} disabled={cargando} className="h-8 gap-1.5">
          {cargando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Actualizar
        </Button>
      </div>

      {/* Chips de bloque */}
      <div className="flex flex-wrap gap-1.5">
        {BLOQUES.map((b) => (
          <button
            key={b}
            onClick={() => setBloque(b)}
            className={`h-8 min-w-8 px-2 rounded-lg text-xs font-bold transition-all ${
              bloque === b
                ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30 scale-105'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {b}
          </button>
        ))}
      </div>

      {/* Grid del bloque: filas = pisos (4 arriba → 1 abajo), columnas = torre×posición */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 overflow-x-auto">
        {cargando ? (
          <div className="flex items-center justify-center py-10 text-sm text-slate-500 gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando mapa de ocupación…
          </div>
        ) : (
          <div className="space-y-2 min-w-max">
            {[...PISOS].reverse().map((piso) => (
              <div key={piso} className="flex items-center gap-2">
                <div className="w-12 shrink-0 text-[10px] font-bold text-slate-400 uppercase">Piso {piso}</div>
                <div className="flex gap-1">
                  {torres.map((torre) => (
                    <div
                      key={torre}
                      className="flex gap-1"
                      style={{ paddingRight: torres.length > 1 ? 10 : 0, borderRight: torres.length > 1 ? '1px dashed #cbd5e1' : 'none' }}
                    >
                      {posiciones.map((posicion) => {
                        const rack = { bloque, torre, piso, posicion }
                        const key = claveCeldaRack(rack)
                        const c = mapa.get(key)
                        const ocupada = !!c && c.stock > EPS
                        const mismoCodigo = !!c && !!codigoMarca && c.codigos.includes(codigoMarca)
                        const esSel =
                          sel?.rack.bloque === rack.bloque &&
                          sel?.rack.torre === torre &&
                          sel?.rack.piso === piso &&
                          sel?.rack.posicion === posicion
                        const esSugerida = sugerida === key
                        return (
                          <button
                            key={key}
                            onClick={() => clickCelda(rack)}
                            title={ocupada ? `Ocupada · ${c!.codigos.join(', ')} · stock ${c!.stock}` : 'Libre'}
                            className={`relative w-9 h-9 sm:w-10 sm:h-10 rounded-md text-[9px] font-bold transition-all flex flex-col items-center justify-center leading-none ${
                              esSel
                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40 scale-110 z-10'
                                : mismoCodigo
                                  ? 'bg-violet-200 text-violet-800 border-2 border-violet-500 hover:bg-violet-300'
                                  : ocupada
                                    ? 'bg-amber-200 text-amber-900 hover:bg-amber-300'
                                    : 'bg-emerald-200 text-emerald-800 hover:bg-emerald-300'
                            }`}
                          >
                            {esSel && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-blue-600 border-2 border-white" />}
                            {mismoCodigo && !esSel && (
                              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-violet-600 border border-white" />
                            )}
                            {esSugerida && !esSel && (
                              <span className="absolute -top-1.5 -left-1.5">
                                <Sparkles className="h-3 w-3 text-blue-600" />
                              </span>
                            )}
                            <span>{posicion}</span>
                            {ocupada && <span className="text-[7px] font-semibold opacity-80">{formatearStock(c!.stock)}</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Leyenda */}
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-300" /> Libre</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-300" /> Ocupada (clic = co-ubicar)</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-violet-400" /> Mismo código</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-600" /> Seleccionada</span>
        <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3 text-blue-600" /> Sugerida</span>
      </div>

      {sel && (
        <div className="rounded-xl border-2 border-blue-200 bg-blue-50/60 p-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {esSugeridaVisible && (
              <Badge className="bg-blue-600 text-white gap-1 shrink-0"><Sparkles className="h-3 w-3" /> Sugerido</Badge>
            )}
            <div className="min-w-0">
              <p className="text-sm font-bold text-blue-900 truncate">{sel.etiqueta}</p>
              {sel.ocupada && sel.codigos.length > 0 && (
                <p className="text-[11px] text-amber-700 truncate">
                  Ya tiene: {sel.codigos.join(', ')} — stock total {formatearStock(sel.stockTotal)}
                </p>
              )}
            </div>
          </div>
          <Button onClick={confirmar} className="gap-1.5 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Usar esta celda
          </Button>
        </div>
      )}

      {/* Confirmación de co-ubicación (regla: ocupada SIEMPRE pide confirmación) */}
      <AlertDialog open={pedirConfirmCoUbicar} onOpenChange={setPedirConfirmCoUbicar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Esta posición ya tiene stock</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="font-semibold text-slate-900">{sel?.etiqueta}</p>
                {sel && sel.codigos.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {sel.codigos.map((codigo) => (
                      <li key={codigo}>
                        <span className="font-semibold text-slate-900">{codigo}</span>
                      </li>
                    ))}
                    <li className="text-slate-600">Stock total en la celda: {formatearStock(sel.stockTotal)}</li>
                  </ul>
                ) : null}
                <p>¿Deseas co-ubicar aquí tu mercadería junto a lo existente?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Elegir otra celda</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => {
                setPedirConfirmCoUbicar(false)
                if (sel) onConfirm(sel)
              }}
            >
              Sí, co-ubicar aquí
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatearStock(n: number): string {
  const r = Math.round(n * 100) / 100
  return String(r)
}
