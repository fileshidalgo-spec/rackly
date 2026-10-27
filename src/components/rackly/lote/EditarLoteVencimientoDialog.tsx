'use client'

/**
 * RACKLY — Diálogo "Editar lote / fecha de vencimiento" (módulos Racks y
 * Piso, pedido 2026-10-20 y su ampliación del mismo día).
 *
 * Dos flujos en una sola ventana, siempre ordenada y sin recortes:
 *   · COMPLETAR  — artículo registrado sin lote/fechas: los campos parten
 *     vacíos y el usuario añade los datos físicos reales.
 *   · CORREGIR   — artículo que YA tiene lote/fechas mal digitados: los
 *     campos se prellenan con los datos actuales del bucket elegido y el
 *     usuario los reemplaza.
 *
 * Si la fila de stock agrega varios buckets (varias fechas o varios lotes
 * físicos bajo una misma fecha), se muestra un SELECTOR para elegir el
 * bucket exacto a corregir — la misma precisión con la que las salidas
 * eligen lote. El guardado delega en `onGuardar(lote, fecha, loteActual,
 * fechaActual)`; la validación vive en `validarDatosLote` (src/lib/rackly/
 * lote.ts) y la RPC re-aplica la regla en el servidor (defensa en profundidad).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Loader2, Save, CalendarOff, CircleSlash, Check, ListChecks, Package } from 'lucide-react'
import { validarDatosLote, etiquetaOpcionLote, type OpcionLote } from '@/lib/rackly/lote'

export type ArticuloAEditar = {
  codigo: string
  descripcion?: string
  stock: number
  un?: string
  /** Etiqueta legible de la ubicación ("Bloque 2 · Torre 3 · Piso 1 · Pos 04" / "Columna A · Posición 2") */
  ubicacion: string
  /**
   * Buckets exactos (lote físico × fecha) disponibles para editar.
   * Con UNA opción el diálogo prellena directo; con varias muestra el selector.
   * Ausente/vacío → flujo "completar" puro (bucket sin lote y sin fecha).
   */
  opciones?: OpcionLote[]
}

type Props = {
  open: boolean
  /** Fila objetivo; `null` cierra el diálogo. */
  articulo: ArticuloAEditar | null
  busy: boolean
  /**
   * Task 28 (Racks): habilita la corrección de CANTIDAD del bucket —
   * además del lote/fecha. Al guardar, el llamador registra el movimiento
   * compensatorio (ingreso/salida de ajuste) con uuid_sync idempotente.
   * Default false: Piso mantiene el diálogo de lote/fecha puro.
   */
  permitirCantidad?: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Guardar validado: valores NUEVOS (lote, fecha) y valores ACTUALES del
   * bucket (loteActual, fechaActual) para que la RPC apunte con precisión.
   * `cantidadNueva` (solo con permitirCantidad): la cantidad corregida del
   * bucket, o null si no cambió / no aplica.
   */
  onGuardar: (
    lote: string,
    fecha: string,
    loteActual: string,
    fechaActual: string,
    cantidadNueva?: number | null
  ) => Promise<void>
}

export function EditarLoteVencimientoDialog({
  open,
  articulo,
  busy,
  permitirCantidad = false,
  onOpenChange,
  onGuardar,
}: Props) {
  const [lote, setLote] = useState('')
  const [fecha, setFecha] = useState('')
  /** Cantidad digitada del bucket (solo con permitirCantidad). '' = sin tocar. */
  const [cantidad, setCantidad] = useState('')
  // Bucket actualmente elegido (índice dentro de articulo.opciones)
  const [idxOpcion, setIdxOpcion] = useState(0)

  const opciones = useMemo<OpcionLote[]>(
    () => (articulo?.opciones && articulo.opciones.length > 0 ? articulo.opciones : []),
    [articulo]
  )
  const haySelector = opciones.length > 1
  const opcionActual: OpcionLote = opciones[idxOpcion] ?? { loteFisico: '', fecha: '', cantidad: articulo?.stock ?? 0 }
  // ¿El bucket elegido YA tiene datos? → modo corrección (textos y prefill)
  const esCorreccion = !!opcionActual.loteFisico || !!opcionActual.fecha

  // Re-inicializar cada vez que se abre o cambia el artículo/elección:
  // COMPLETAR parte vacío; CORREGIR prellena con los datos actuales del bucket.
  // FIX lint react-hooks/set-state-in-effect: el reset se hace ajustando el
  // estado DURANTE el render (patrón oficial "adjust state when props change"),
  // con una firma de contenido en vez de deps de identidad de arrays.
  const firmaReset = `${open ? '1' : '0'}|${articulo?.codigo ?? ''}|${
    (articulo?.opciones ?? []).map((o) => `${o.loteFisico}/${o.fecha}`).join(',')
  }`
  const [firmaPrev, setFirmaPrev] = useState(firmaReset)
  if (firmaReset !== firmaPrev) {
    setFirmaPrev(firmaReset)
    if (open) {
      setIdxOpcion(0)
      const primera = articulo?.opciones?.[0]
      setLote(primera?.loteFisico ?? '')
      setFecha(primera?.fecha ?? '')
      setCantidad(permitirCantidad && primera ? String(primera.cantidad) : '')
    }
  }

  /** Elegir otro bucket en el selector: los campos se prellenan con SUS datos. */
  function elegirOpcion(i: number) {
    if (busy) return
    setIdxOpcion(i)
    setLote(opciones[i]?.loteFisico ?? '')
    setFecha(opciones[i]?.fecha ?? '')
    if (permitirCantidad) setCantidad(String(opciones[i]?.cantidad ?? ''))
  }

  /** Cantidad corregida a pasar al llamador: null = sin cambio / no aplica. */
  function cantidadNuevaO(): number | null {
    if (!permitirCantidad) return null
    const txt = cantidad.trim()
    if (txt === '') return null
    const n = Number(txt)
    if (!Number.isFinite(n) || n < 0) {
      toast.error('Cantidad inválida — usa un número ≥ 0')
      return NaN // centinela: doGuardar aborta
    }
    return Math.round(n * 1000) / 1000
  }

  async function doGuardar() {
    if (!articulo) return
    const val = validarDatosLote(lote, fecha)
    if (!val.ok) {
      toast.error(val.error)
      return
    }
    const nueva = cantidadNuevaO()
    if (Number.isNaN(nueva)) return // validación de cantidad falló
    const sinCambio = nueva == null || Math.abs(nueva - opcionActual.cantidad) < 1e-9
    await onGuardar(
      val.lote ?? '',
      val.fecha ?? '',
      opcionActual.loteFisico,
      opcionActual.fecha,
      sinCambio ? null : nueva
    )
  }

  return (
    <AlertDialog
      open={open && !!articulo}
      onOpenChange={(o) => { if (!busy) onOpenChange(o) }}
    >
      <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto gap-3 p-4 sm:p-6">
        <AlertDialogHeader className="gap-1.5">
          <AlertDialogTitle className="text-base">
            {esCorreccion ? 'Corregir lote y fecha de vencimiento' : 'Editar lote y fecha de vencimiento'}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs">
            {permitirCantidad
              ? 'Reemplaza los datos actuales por los correctos. Si cambias la CANTIDAD, se registra un ajuste (ingreso o salida) que queda en el kardex.'
              : esCorreccion
                ? 'Reemplaza los datos actuales por los correctos. El stock y las cantidades NO se modifican.'
                : 'Completa los datos físicos del producto registrados sin lote/fechas. El stock y los lotes ya existentes NO se modifican.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {articulo && (
          <div className="space-y-3 py-0.5">
            {/* Contexto del artículo */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-2.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-sm text-slate-800 dark:text-slate-100">{articulo.codigo}</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400 text-sm">{articulo.stock} {articulo.un || ''}</span>
              </div>
              {articulo.descripcion && (
                <p className="text-xs text-muted-foreground truncate">{articulo.descripcion}</p>
              )}
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{articulo.ubicacion}</p>
            </div>

            {/* ── Selector de bucket (solo cuando la fila agrega varios lotes/fechas) ── */}
            {haySelector && (
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-sky-500" /> ¿Qué lote corregir?
                </Label>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                  {opciones.map((o, i) => (
                    <button
                      key={`${o.loteFisico}||${o.fecha}||${i}`}
                      type="button"
                      onClick={() => elegirOpcion(i)}
                      disabled={busy}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors ${
                        i === idxOpcion
                          ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <span className="text-[11px] font-medium">{etiquetaOpcionLote(o)}</span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{o.cantidad}</span>
                        {i === idxOpcion && <Check className="w-3.5 h-3.5 text-sky-500" />}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Lote */}
            <div className="space-y-1">
              <Label className="text-xs">Código de lote</Label>
              <div className="flex gap-2">
                <Input
                  value={lote}
                  onChange={(e) => setLote(e.target.value)}
                  placeholder="Ej: AP-304501210021"
                  disabled={busy}
                  autoComplete="off"
                  className="h-9"
                />
                <button
                  type="button"
                  onClick={() => setLote('')}
                  title="Dejar sin lote"
                  className={`flex items-center gap-1.5 px-3 rounded-lg text-[10px] font-semibold border transition-all flex-shrink-0 ${
                    lote
                      ? 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-slate-700 dark:hover:text-slate-200'
                      : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-600 dark:text-cyan-400'
                  }`}
                >
                  <CircleSlash className="w-3.5 h-3.5" /> Sin lote
                </button>
              </div>
            </div>

            {/* Fecha de vencimiento */}
            <div className="space-y-1">
              <Label className="text-xs">Fecha de vencimiento</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={fecha}
                  onChange={(e) => setFecha(e.target.value)}
                  disabled={busy}
                  className="h-9 [color-scheme:light] dark:[color-scheme:dark]"
                />
                <button
                  type="button"
                  onClick={() => setFecha('')}
                  title="Dejar sin fecha"
                  className={`flex items-center gap-1.5 px-3 rounded-lg text-[10px] font-semibold border transition-all flex-shrink-0 ${
                    fecha
                      ? 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-slate-700 dark:hover:text-slate-200'
                      : 'bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400'
                  }`}
                >
                  <CalendarOff className="w-3.5 h-3.5" /> Sin fecha
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                {esCorreccion
                  ? `Datos actuales: ${opcionActual.loteFisico ? `lote ${opcionActual.loteFisico}` : 'sin lote'} · ${opcionActual.fecha ? `vence ${opcionActual.fecha}` : 'sin fecha'}.`
                  : 'Deja vacío lo que el producto realmente no tenga (al menos un dato es obligatorio).'}
              </p>
            </div>

            {/* Cantidad del bucket (Task 28 — Racks): corregir lo digitado mal.
                El guardado registra el movimiento compensatorio (kardex). */}
            {permitirCantidad && (
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5 text-emerald-500" /> Cantidad registrada
                </Label>
                <Input
                  type="number"
                  step="any"
                  min="0"
                  value={cantidad}
                  onChange={(e) => setCantidad(e.target.value)}
                  disabled={busy}
                  inputMode="decimal"
                  autoComplete="off"
                  className="h-9"
                />
                <p className="text-[10px] text-muted-foreground italic">
                  Actual: {opcionActual.cantidad} {articulo.un || ''}. Al guardar se registra el ajuste
                  (salida si sobra, ingreso si falta) — el kardex queda trazado, nada se borra.
                </p>
              </div>
            )}
          </div>
        )}

        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <Button onClick={doGuardar} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Guardar
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
