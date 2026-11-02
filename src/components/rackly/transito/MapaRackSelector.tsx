'use client'

/**
 * RACKLY — TRÁNSITO · Mapa visual de ubicaciones de RACKS.
 *
 * Reutiliza el motor de ocupación del módulo Racks (RPC ocupacion_celdas_v2)
 * y lo convierte en selector: TODAS las celdas son clicables.
 *   · Sin artículo   → VERDE, clic = elegir.
 *   · 1 artículo     → AZUL, clic = avisar contenido y pedir confirmación
 *                      para co-ubicar (regla v3.3: nunca silenciosa).
 *   · Más de 1       → NARANJA (mismo convenio que Ocupación de racks;
 *                      multi-lote marca un punto ámbar).
 *   · Con INC        → ROSADO, se trata como OCUPADA (nunca sugerida);
 *                      clic pide confirmación de co-ubicación igual que
 *                      cualquier celda ocupada.
 *   · Mismo código del artículo → marcador violeta para agrupar cerca.
 *   · Torre 1 / Torre 2 con encabezado propio sobre sus columnas.
 * Sugerencia automática: la primera celda libre del piso más bajo queda
 * preseleccionada ("Sugerido").
 *
 * FIX 2026-11-01 (ocupación INC): el RPC ocupacion_celdas_v2 EXCLUYE los
 * movimientos INC (codigo_inc IS NULL) — las celdas con SOLO artículos INC
 * quedaban con stock 0 y este mapa las pintaba VERDES y las SUGERÍA como
 * destino, aunque físicamente están bloqueadas por mercadería pendiente de
 * disponer. Ahora se mergea el mapa INC (mismo criterio que Ocupación de
 * racks) y una celda con INC activo se comporta como ocupada.
 *
 * FIX 2026-11-02 (trace 1a19c8089fb5fba5): si la CONSULTA INC falla (red/BD),
 * antes el merge llegaba vacío y las celdas solo-INC volvían a pintarse
 * «Libre» y a sugerirse como destino. Ahora la consulta lleva reintento
 * automático y, si aún así falla, el mapa entra en modo «INC no verificado»:
 * banner ámbar, SIN sugerencia automática y con confirmación obligatoria al
 * elegir cualquier celda que parezca libre.
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
import { CheckCircle2, AlertTriangle, Loader2, MapPin, RefreshCw, Sparkles } from 'lucide-react'
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
import { fetchIncPorUbicacionConReintento, fusionarIncEnCeldas } from '@/lib/rackly/mapa-inc'
import type { IncEnCelda } from '@/lib/rackly/kardex'

export type SeleccionRack = {
  rack: { bloque: string; torre: string; piso: string; posicion: string }
  etiqueta: string
  ocupada: boolean
  /** Códigos presentes en la celda (solo si está ocupada). */
  codigos: string[]
  /** Stock total de la celda (solo si está ocupada). */
  stockTotal: number
  /** Artículos INC presentes (solo si la celda tiene INC). Opcional: los
   * callers antiguos no lo usan — no rompe la firma. */
  incItems?: IncEnCelda[]
}

const EPS = 0.0005

/** ¿La celda tiene artículos INC activos (stock INC neto > 0)? */
function tieneIncActiva(c: OcupacionCelda | undefined): boolean {
  return !!c && c.tieneInc && c.incItems.length > 0
}

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
  // FIX 2026-11-02: consulta INC caída — modo «INC no verificado».
  const [incError, setIncError] = useState(false)
  const [bloque, setBloque] = useState<string>('1')
  const [sel, setSel] = useState<SeleccionRack | null>(null)
  const [sugerida, setSugerida] = useState<string | null>(null)
  const [pedirConfirmCoUbicar, setPedirConfirmCoUbicar] = useState(false)

  const cargar = async () => {
    setCargando(true)
    try {
      // FIX 2026-11-01: ocupación (RPC v2) + mapa INC en paralelo, merge antes
      // de pintar — sin esto las celdas solo-INC aparecían libres/sugeridas.
      // FIX 2026-11-02: la consulta INC lleva reintento automático (fallos
      // transitorios de red) y si aún así falla se activa el modo «INC no
      // verificado» en vez de pintar celdas INC como libres.
      const [res, incMap] = await Promise.all([ocupacionRacks(), fetchIncPorUbicacionConReintento()])
      setIncError(!!incMap._error)
      if (incMap._error) console.warn('[MapaRack] Datos INC no disponibles tras reintento — no se sugieren celdas y se exige confirmación')
      setCeldas(fusionarIncEnCeldas(res ?? [], incMap))
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
    // FIX 2026-11-02: con la consulta INC caída NO se sugiere ninguna celda —
    // una celda que parece libre podría estar bloqueada por INC.
    if (!celdas || sugerida || incError) return
    for (const b of BLOQUES) {
      for (const t of torresDeBloque(b)) {
        for (const p of PISOS) {
          for (const pos of posicionesDeBloque(b)) {
            const c = mapa.get(claveCeldaRack({ bloque: b, torre: t, piso: p, posicion: pos }))
            // Solo se sugieren celdas REALMENTE libres: sin stock normal NI INC
            if (!c || (c.stock <= EPS && !tieneIncActiva(c))) {
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
  }, [celdas, mapa, sugerida, incError])

  const clickCelda = (rack: SeleccionRack['rack']) => {
    const c = mapa.get(claveCeldaRack(rack))
    // Ocupada = con stock normal O con artículos INC (físicamente bloqueada)
    const ocupada = !!c && (c.stock > EPS || tieneIncActiva(c))
    const s: SeleccionRack = {
      rack,
      etiqueta: etiquetaRack(rack),
      ocupada,
      codigos: ocupada ? (c?.codigos ?? []) : [],
      stockTotal: ocupada ? c?.stock ?? 0 : 0,
      incItems: tieneIncActiva(c) ? c?.incItems ?? [] : undefined,
    }
    setSel(s)
    setBloque(rack.bloque)
    // FIX 2026-11-02: con INC no verificado, incluso una celda «libre» exige
    // confirmación (podría estar bloqueada por mercadería INC invisible).
    if (ocupada || incError) setPedirConfirmCoUbicar(true)
  }

  const confirmar = () => {
    if (!sel) return
    if (sel.ocupada || incError) {
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

      {/* FIX 2026-11-02: banner honesto cuando la consulta INC falla. */}
      {incError && !cargando && (
        <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-amber-800">Datos INC no disponibles</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              No se pudo consultar qué celdas tienen mercadería INC (fallo de conexión). No se sugiere ninguna celda y al elegir cualquiera se pedirá confirmación. Toca «Actualizar» para reintentar.
            </p>
          </div>
        </div>
      )}

      {/* Grid del bloque: filas = pisos (4 arriba → 1 abajo), columnas = torre×posición.
          Encabezado TORRE N alineado con cada grupo de columnas (v2 2026-10-20:
          la ventana de destino muestra Torre 1 y Torre 2 con claridad) + colores
          de Ocupación de racks: VERDE sin artículo · AZUL con 1 · NARANJA con más de 1. */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 overflow-x-auto">
        {cargando ? (
          <div className="flex items-center justify-center py-10 text-sm text-slate-500 gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando mapa de ocupación…
          </div>
        ) : (
          <div className="space-y-2 min-w-max">
            {/* Encabezados de torre (misma estructura de columnas que las filas) */}
            <div className="flex items-end gap-2">
              <div className="w-12 shrink-0" />
              <div className="flex gap-1">
                {torres.map((torre) => (
                  <div
                    key={torre}
                    className="flex flex-col items-center"
                    style={{
                      paddingRight: torres.length > 1 ? 10 : 0,
                      borderRight: torres.length > 1 ? '1px solid #94a3b8' : 'none',
                    }}
                  >
                    <div className="flex gap-1">
                      {posiciones.map((posicion) => (
                        <div key={posicion} className="w-9 sm:w-10 h-0" />
                      ))}
                    </div>
                    <span className="text-[10px] font-extrabold text-slate-600 uppercase tracking-wider whitespace-nowrap">
                      Torre {torre}
                    </span>
                  </div>
                ))}
              </div>
            </div>
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
                        const esInc = tieneIncActiva(c)
                        // Ocupada = con stock normal O con INC (físicamente bloqueada)
                        const ocupada = !!c && (c.stock > EPS || esInc)
                        // Colores de Ocupación de racks (mismo convenio que el módulo):
                        // sin artículo = verde · 1 artículo = azul · más de 1 = naranja
                        // · con INC = rosado (ocupada, nunca libre).
                        const nCodigos = c?.codigos.length ?? 0
                        const multiLote = !!c && nCodigos === 1 && c.lotes > 1 && !esInc
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
                            title={
                              esInc
                                ? `${c!.codigos.join(', ')} — INC: ${c!.incItems.map((i) => `${i.codigo} (INC: ${i.codigoInc}) ×${i.cantidad}`).join(', ')}${c!.stock > EPS ? ` · stock normal ${formatearStock(c!.stock)}` : ' · (solo INC)'}`
                                : ocupada
                                  ? `${nCodigos > 1 ? `${nCodigos} artículos` : '1 artículo'} · ${c!.codigos.join(', ')} · stock ${formatearStock(c!.stock)}`
                                  : incError
                                    ? '¿Libre? — datos INC no disponibles'
                                    : 'Libre — sin artículo'
                            }
                            className={`relative w-9 h-9 sm:w-10 sm:h-10 rounded-md text-[9px] font-bold transition-all flex flex-col items-center justify-center leading-none ${
                              esSel
                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40 scale-110 z-10 ring-2 ring-blue-300'
                                : mismoCodigo
                                  ? 'bg-violet-200 text-violet-800 border-2 border-violet-500 hover:bg-violet-300'
                                  : esInc
                                    ? 'bg-rose-200 text-rose-900 hover:bg-rose-300'
                                    : !ocupada
                                      ? 'bg-emerald-200 text-emerald-800 hover:bg-emerald-300'
                                      : nCodigos > 1
                                        ? 'bg-orange-200 text-orange-900 hover:bg-orange-300'
                                        : 'bg-blue-200 text-blue-900 hover:bg-blue-300'
                            }`}
                          >
                            {esSel && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-blue-600 border-2 border-white" />}
                            {mismoCodigo && !esSel && (
                              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-violet-600 border border-white" />
                            )}
                            {multiLote && !esSel && (
                              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 ring-1 ring-white" />
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

      {/* Leyenda (convenio de Ocupación de racks) */}
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-300" /> Sin artículo</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-300" /> Con 1 artículo</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-300" /> Con más de 1</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-rose-300" /> Con INC (no libre)</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-400" /> Multi-lote (punto)</span>
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

      {/* Confirmación de co-ubicación (regla: ocupada SIEMPRE pide confirmación;
          FIX 2026-11-02: con INC no verificado TAMBIÉN se pide confirmación) */}
      <AlertDialog open={pedirConfirmCoUbicar} onOpenChange={setPedirConfirmCoUbicar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{sel?.ocupada ? 'Esta posición ya tiene stock' : 'Estado INC no verificado'}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="font-semibold text-slate-900">{sel?.etiqueta}</p>
                {sel && sel.ocupada && sel.codigos.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {sel.codigos.map((codigo) => (
                      <li key={codigo}>
                        <span className="font-semibold text-slate-900">{codigo}</span>
                      </li>
                    ))}
                    {sel.incItems && sel.incItems.length > 0 && (
                      <li className="text-rose-700">
                        INC pendiente de disponer: {sel.incItems.map((i) => `${i.codigo} ×${i.cantidad}`).join(', ')}
                      </li>
                    )}
                    <li className="text-slate-600">Stock total en la celda: {formatearStock(sel.stockTotal)}</li>
                  </ul>
                ) : (
                  <p>
                    Los datos INC no están disponibles en este momento (fallo de conexión). Esta celda parece libre, pero podría tener mercadería INC pendiente de disponer. Si confirmas, se registrará el traslado a esta ubicación.
                  </p>
                )}
                <p>{sel?.ocupada ? '¿Deseas co-ubicar aquí tu mercadería junto a lo existente?' : '¿Deseas usarla de todos modos?'}</p>
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
              {sel?.ocupada ? 'Sí, co-ubicar aquí' : 'Sí, usar de todos modos'}
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
