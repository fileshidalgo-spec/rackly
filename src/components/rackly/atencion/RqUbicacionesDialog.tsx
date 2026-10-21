'use client'

/**
 * RACKLY — Atención a Línea · "Ver ubicación del producto".
 *
 * Muestra dónde está el material pedido (Racks y Piso) con su stock por
 * ubicación, y permite SALTAR a la ubicación concreta:
 *   · Racks  → módulo Racks (Ocupación) con el detalle de la posición abierto,
 *              desde donde se registra la SALIDA.
 *   · Piso   → módulo Piso (Sectores) con el detalle de la posición abierto.
 *
 * Aislamiento: SOLO LECTURA de stock (fetchStockPorCodigoRPC / stockPisoBuscar).
 * La salida física la registra el usuario en su módulo; la atención (cantidades)
 * se cierra aquí al volver.
 */

import { useEffect, useState } from 'react'
import { fetchStockPorCodigoRPC } from '@/lib/rackly/kardex'
import { stockPisoBuscar, type StockPisoItem } from '@/lib/piso/api'
import { targetDesdeStockItem, type PisoTargetPosicion } from '@/lib/piso/navegacion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  MapPin,
  Loader2,
  Warehouse,
  Layers3,
  ArrowRight,
  PackageSearch,
  Inbox,
} from 'lucide-react'

type FilaRacks = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  fVencimiento: string | null
}

export type PropsUbicaciones = {
  open: boolean
  onOpenChange: (open: boolean) => void
  codigo: string
  descripcion: string
  unidad: string
  onIrARacks: (bloque: string, torre: string, piso: string, posicion: string) => void
  onIrAPiso: (target: PisoTargetPosicion) => void
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

export function RqUbicacionesDialog({
  open,
  onOpenChange,
  codigo,
  descripcion,
  unidad,
  onIrARacks,
  onIrAPiso,
}: PropsUbicaciones) {
  const [cargando, setCargando] = useState(false)
  const [racks, setRacks] = useState<FilaRacks[]>([])
  const [piso, setPiso] = useState<StockPisoItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !codigo.trim()) return
    let vigente = true
    setCargando(true)
    setError('')
    setRacks([])
    setPiso([])
    ;(async () => {
      try {
        const [r, p] = await Promise.all([
          fetchStockPorCodigoRPC(codigo.trim(), false),
          stockPisoBuscar(codigo.trim()).catch(() => [] as StockPisoItem[]),
        ])
        if (!vigente) return
        setRacks((r ?? []).filter((x) => x.stock > 0))
        setPiso((p ?? []).filter((x) => x.cantidad > 0))
      } catch (err: unknown) {
        if (!vigente) return
        const message = err instanceof Error ? err.message : 'Error desconocido'
        setError(message)
      } finally {
        if (vigente) setCargando(false)
      }
    })()
    return () => {
      vigente = false
    }
  }, [open, codigo])

  const totalRacks = racks.reduce((s, r) => s + r.stock, 0)
  const totalPiso = piso.reduce((s, r) => s + r.cantidad, 0)
  const sinStock = !cargando && !error && racks.length === 0 && piso.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[85vh] overflow-y-auto overscroll-contain">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-4 w-4 text-violet-600" />
            Ubicaciones del producto
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono font-bold text-indigo-700">{codigo}</span>
            {descripcion ? ` · ${descripcion}` : ''}
            {unidad ? ` (${unidad})` : ''}
          </DialogDescription>
        </DialogHeader>

        {cargando && (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando ubicaciones…
          </div>
        )}

        {error && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg p-3">
            {error}
          </p>
        )}

        {sinStock && (
          <div className="text-center py-6 text-sm text-slate-400">
            <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            Sin stock de este código en Racks ni en Piso.
          </div>
        )}

        {/* ── Racks ── */}
        {racks.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Warehouse className="h-4 w-4 text-violet-600" />
              <h4 className="text-sm font-bold text-slate-700">Racks</h4>
              <Badge variant="secondary" className="text-[10px]">
                {fmt(totalRacks)} {unidad || ''}
              </Badge>
            </div>
            <div className="space-y-1.5">
              {racks.map((r, i) => (
                <button
                  key={`${r.bloque}-${r.torre}-${r.piso}-${r.posicion}-${i}`}
                  onClick={() => {
                    onOpenChange(false)
                    onIrARacks(r.bloque, r.torre, r.piso, r.posicion)
                  }}
                  className="w-full flex items-center gap-2 rounded-lg border p-2.5 text-left hover:border-violet-300 hover:bg-violet-50/60 transition-colors"
                >
                  <MapPin className="h-4 w-4 text-violet-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800">
                      B{r.bloque} · Torre {r.torre} · P{r.piso} · Pos {r.posicion}
                    </p>
                    {r.fVencimiento && (
                      <p className="text-[10px] text-slate-400">Vence: {r.fVencimiento}</p>
                    )}
                  </div>
                  <span className="text-sm font-bold text-slate-700 shrink-0">
                    {fmt(r.stock)} {unidad || ''}
                  </span>
                  <ArrowRight className="h-4 w-4 text-violet-500 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Piso ── */}
        {piso.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Layers3 className="h-4 w-4 text-sky-600" />
              <h4 className="text-sm font-bold text-slate-700">Piso</h4>
              <Badge variant="secondary" className="text-[10px]">
                {fmt(totalPiso)} {unidad || ''}
              </Badge>
            </div>
            <div className="space-y-1.5">
              {piso.map((p, i) => {
                const target = targetDesdeStockItem(p)
                return (
                  <button
                    key={`${p.sector_id ?? 's'}-${p.posicion_id ?? 'p'}-${p.bloque_codigo}-${i}`}
                    onClick={() => {
                      if (!target) {
                        toast.error('Esta ubicación no se pudo resolver — búscala en el módulo Piso')
                        return
                      }
                      onOpenChange(false)
                      onIrAPiso(target)
                    }}
                    className="w-full flex items-center gap-2 rounded-lg border p-2.5 text-left hover:border-sky-300 hover:bg-sky-50/60 transition-colors"
                  >
                    <MapPin className="h-4 w-4 text-sky-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800 truncate">
                        {p.ubicacion || p.bloque_codigo}
                      </p>
                      <p className="text-[10px] text-slate-400 truncate">
                        Sector {p.sector_nombre}
                        {p.fecha_vencimiento ? ` · Vence: ${p.fecha_vencimiento}` : ''}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-slate-700 shrink-0">
                      {fmt(p.cantidad)} {p.bloque_unidad || ''}
                    </span>
                    <ArrowRight className="h-4 w-4 text-sky-500 shrink-0" />
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <p className="text-[11px] text-slate-400 flex items-center gap-1.5 pt-1">
          <PackageSearch className="h-3 w-3" />
          Toca una ubicación para ir a darle salida en Racks o Piso; luego vuelve con
          «Retornar a Atención».
        </p>
      </DialogContent>
    </Dialog>
  )
}
