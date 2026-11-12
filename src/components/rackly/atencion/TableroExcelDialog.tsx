'use client'

/**
 * RACKLY — Atención · Diálogo del TABLERO por línea (Excel, 2026-11-12).
 *
 * Pedido del usuario con imagen: la presentación actual es una tabla
 * dinámica con filtros FECHA + TURNO y columnas LINEA | PRODUCTO | sku |
 * DESCRIPCION | Suma de CANTIDAD. Este diálogo elige rango + turnos y
 * genera el libro con ESE formato (construirTablero + exportarExcelTablero).
 *
 * Semántica del filtro (misma del Excel por rango de Recepción):
 *   · FECHA  = día de la SALIDA (hora Lima).
 *   · TURNO  = T1 (07:20–19:20) / T2 (19:21–07:19) de la SALIDA; en tomas
 *     históricas sin turno, derivado de la hora (regla del almacén).
 *
 * Igual que el patrón Recepción: defaults AMBOS turnos marcados y fecha de
 * HOY (el pivot diario del usuario); el rango se amplía a gusto.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BarChart3, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cargarReporteAtencion, type DatosReporte } from '@/lib/rackly/atencion-reporte'
import { construirTablero } from '@/lib/rackly/atencion-tablero'
import { exportarExcelTablero } from '@/lib/rackly/atencion-excel'
import { mensajeError } from '@/lib/rackly/errores'

function hoyISO(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function TableroExcelDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [desde, setDesde] = useState(hoyISO())
  const [hasta, setHasta] = useState(hoyISO())
  const [t1, setT1] = useState(true)
  const [t2, setT2] = useState(true)
  const [generando, setGenerando] = useState(false)

  // Re-abrir con defaults frescos (hoy, ambos turnos)
  useEffect(() => {
    if (open) {
      setDesde(hoyISO())
      setHasta(hoyISO())
      setT1(true)
      setT2(true)
    }
  }, [open])

  async function exportar() {
    if (generando) return
    if (desde > hasta) {
      toast.error('Rango inválido', { description: 'La fecha DESDE es mayor que HASTA.' })
      return
    }
    const turnos = [...(t1 ? ['T1'] : []), ...(t2 ? ['T2'] : [])]
    if (turnos.length === 0) {
      toast.error('Sin turnos', { description: 'Marca al menos un turno (T1 o T2) para exportar.' })
      return
    }
    setGenerando(true)
    try {
      const datos: DatosReporte = await cargarReporteAtencion(5000)
      const tablero = construirTablero(datos, { desde, hasta, turnos })
      if (tablero.tomasEnRango === 0) {
        toast.info('No hay salidas en ese rango', {
          description: `${desde} al ${hasta} · turnos ${turnos.join(' + ')} — prueba ampliando el rango o marcando el otro turno.`,
        })
        return
      }
      const nombre = await exportarExcelTablero({ desde, hasta, turnos, filas: tablero.filas })
      toast.success(`Excel descargado: ${nombre}`, {
        description: `${tablero.filas.length} fila(s) · ${tablero.tomasEnRango} salida(s) netas · ${desde} al ${hasta} · turnos ${turnos.join(' + ')}`,
      })
      onOpenChange(false)
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('No se pudo generar el tablero', { description: message })
    } finally {
      setGenerando(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !generando && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-teal-600" />
            Tablero de atenciones por línea
          </DialogTitle>
          <DialogDescription>
            Excel con la presentación de tu tabla dinámica: LINEA · PRODUCTO ·
            sku · DESCRIPCION · Suma de CANTIDAD — el mismo código se suma en
            UNA fila por línea (salidas netas del almacén, reversas
            descontadas), con total general y sin totales por línea.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Desde</span>
              <Input
                type="date"
                className="h-9"
                value={desde}
                max={hasta}
                onChange={(e) => setDesde(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Hasta</span>
              <Input
                type="date"
                className="h-9"
                value={hasta}
                min={desde}
                onChange={(e) => setHasta(e.target.value)}
              />
            </label>
          </div>
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Turnos</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-teal-600"
                  checked={t1}
                  onChange={(e) => setT1(e.target.checked)}
                />
                T1 (07:20–19:20)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-teal-600"
                  checked={t2}
                  onChange={(e) => setT2(e.target.checked)}
                />
                T2 (19:21–07:19)
              </label>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 rounded-lg border border-slate-100 bg-slate-50 p-2">
            El rango filtra por la FECHA de la SALIDA a la línea; el turno por la
            HORA de esa salida (regla del almacén, hora Lima). Las líneas se
            agrupan con la lista oficial (Línea 1–20 · Materiales auxiliares ·
            Jarabe); los valores históricos no reconocidos aparecen tal cual.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={generando}>
            Cancelar
          </Button>
          <Button
            className="gap-1.5 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
            disabled={generando}
            onClick={() => void exportar()}
          >
            {generando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Exportar Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
