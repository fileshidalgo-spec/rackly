'use client'

/**
 * RACKLY — Diálogo "Editar lote / fecha de vencimiento" para artículos
 * registrados SIN esos datos (módulos Racks y Piso, pedido 2026-10-20).
 *
 * Compartido por OcupacionTab (Racks) y PisoSectoresTab (Piso): recibe los
 * datos del artículo para contexto y delega el guardado en `onGuardar`.
 * La validación vive en `validarDatosLote` (src/lib/rackly/lote.ts) — la
 * misma regla que re-aplica la RPC en el servidor (defensa en profundidad).
 */

import { useEffect, useState } from 'react'
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
import { Loader2, Save, CalendarOff, CircleSlash } from 'lucide-react'
import { validarDatosLote } from '@/lib/rackly/lote'

export type ArticuloAEditar = {
  codigo: string
  descripcion?: string
  stock: number
  un?: string
  /** Etiqueta legible de la ubicación ("Bloque 2 · Torre 3 · Piso 1 · Pos 04" / "Sector A · Posición 2") */
  ubicacion: string
}

type Props = {
  open: boolean
  /** Fila objetivo; `null` cierra el diálogo. */
  articulo: ArticuloAEditar | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  /** Guardar validado: (lote, fecha) ya normalizados y no vacíos en conjunto. */
  onGuardar: (lote: string, fecha: string) => Promise<void>
}

export function EditarLoteVencimientoDialog({ open, articulo, busy, onOpenChange, onGuardar }: Props) {
  const [lote, setLote] = useState('')
  const [fecha, setFecha] = useState('')

  // Re-inicializar los campos cada vez que se abre (o cambia el artículo):
  // los campos parten VACÍOS porque el flujo es "completar datos faltantes".
  useEffect(() => {
    if (open) { setLote(''); setFecha('') }
  }, [open, articulo?.codigo])

  async function doGuardar() {
    if (!articulo) return
    const val = validarDatosLote(lote, fecha)
    if (!val.ok) {
      toast.error(val.error)
      return
    }
    await onGuardar(val.lote ?? '', val.fecha ?? '')
  }

  return (
    <AlertDialog
      open={open && !!articulo}
      onOpenChange={(o) => { if (!busy) onOpenChange(o) }}
    >
      <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Editar lote y fecha de vencimiento</AlertDialogTitle>
          <AlertDialogDescription>
            Completa los datos físicos del producto registrados sin lote/fechas.
            El stock y los lotes ya existentes NO se modifican.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {articulo && (
          <div className="space-y-3 py-1">
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
                Deja vacío lo que el producto realmente no tenga (al menos un dato es obligatorio).
              </p>
            </div>
          </div>
        )}

        <AlertDialogFooter>
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
