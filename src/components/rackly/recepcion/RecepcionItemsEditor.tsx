'use client'

/**
 * RACKLY — Recepción · Editor de lista de artículos (compartido).
 *
 * Usado por las 2 vías de registro (foto de guía y manual). Una guía puede
 * traer 20+ artículos; cada artículo se edita como una tarjeta compacta:
 *
 *   · Código        → al escribirlo se autocompletan DESCRIPCIÓN y UNIDAD
 *                     desde el catálogo (busqueda tolerante 09 == 9).
 *   · Cantidad      → editable (si llegó menor cantidad se ajusta aquí).
 *   · Lote y fechas → manuales, por artículo; con acción "aplicar a todos"
 *                     para no repetir tecleo cuando coinciden.
 */

import { useState } from 'react'
import { buscarCatalogo } from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Plus, Trash2, Check, ClipboardCopy } from 'lucide-react'

/** Artículo editable de una recepción (1 fila en BD al registrar). */
export type ItemRecepcion = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  enCatalogo: boolean
}

export function itemVacio(): ItemRecepcion {
  return {
    codigo: '',
    descripcion: '',
    cantidad: '',
    unidad: '',
    lote: '',
    fechaProduccion: '',
    fechaVencimiento: '',
    enCatalogo: false,
  }
}

/** Filtra los artículos listos para registrar (con código/desc y cantidad > 0). */
export function itemsValidos(items: ItemRecepcion[]): ItemRecepcion[] {
  return items.filter((it) => {
    const cantidad = aNumero(it.cantidad)
    return Boolean(it.codigo.trim() || it.descripcion.trim()) && !isNaN(cantidad) && cantidad > 0
  })
}

export function RecepcionItemsEditor({
  items,
  onChange,
}: {
  items: ItemRecepcion[]
  onChange: (items: ItemRecepcion[]) => void
}) {
  const [aLote, setALote] = useState('')
  const [aProd, setAProd] = useState('')
  const [aVenc, setAVenc] = useState('')

  function actualizar(idx: number, patch: Partial<ItemRecepcion>) {
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  /** Al escribir el código: descripción y unidad salen del catálogo. */
  function onCodigoChange(idx: number, valor: string) {
    const cat = buscarCatalogo(valor)
    actualizar(idx, {
      codigo: valor,
      descripcion: cat ? cat.descripcion : items[idx].descripcion,
      unidad: cat ? cat.un : items[idx].unidad,
      enCatalogo: Boolean(cat),
    })
  }

  function agregar() {
    onChange([...items, itemVacio()])
  }

  function eliminar(idx: number) {
    onChange(items.filter((_, i) => i !== idx))
  }

  function aplicarLoteYFechasATodos() {
    if (!aLote && !aProd && !aVenc) {
      toast.error('Escribe al menos el lote o una fecha para aplicar')
      return
    }
    onChange(items.map((it) => ({ ...it, lote: aLote || it.lote, fechaProduccion: aProd || it.fechaProduccion, fechaVencimiento: aVenc || it.fechaVencimiento })))
    toast.success(`Aplicado a ${items.length} artículo(s)`)
  }

  return (
    <div className="space-y-3">
      {/* Aplicar lote/fechas a todos (atajo para guías que comparten datos) */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
        <div className="flex items-center gap-1.5 mb-2">
          <ClipboardCopy className="h-3.5 w-3.5 text-amber-600" />
          <p className="text-[11px] font-semibold text-amber-900">
            Lote y fechas para todos los artículos (opcional)
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-slate-500">Lote</Label>
            <Input className="h-8 text-xs" value={aLote} onChange={(e) => setALote(e.target.value)} placeholder="L-001" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-slate-500">F. producción</Label>
            <Input className="h-8 text-xs" type="date" value={aProd} onChange={(e) => setAProd(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-slate-500">F. vencimiento</Label>
            <Input className="h-8 text-xs" type="date" value={aVenc} onChange={(e) => setAVenc(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button type="button" size="sm" variant="outline" className="w-full h-8 text-xs gap-1" onClick={aplicarLoteYFechasATodos}>
              Aplicar a todos
            </Button>
          </div>
        </div>
      </div>

      {/* Lista de artículos */}
      <div className="space-y-2">
        {items.map((it, idx) => (
          <div
            key={idx}
            className={`rounded-lg border p-2.5 space-y-2 ${
              it.enCatalogo ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 w-6 shrink-0">#{idx + 1}</span>
              <div className="flex-1 space-y-1">
                <Label className="text-[10px] text-slate-500">Código del artículo</Label>
                <Input
                  className="h-8 text-xs font-semibold"
                  value={it.codigo}
                  onChange={(e) => onCodigoChange(idx, e.target.value)}
                  placeholder="Ej: 5653"
                  autoComplete="off"
                  inputMode="numeric"
                />
              </div>
              <div className="w-24 shrink-0 space-y-1">
                <Label className="text-[10px] text-slate-500">Cantidad</Label>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  value={it.cantidad}
                  onChange={(e) => actualizar(idx, { cantidad: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div className="w-20 shrink-0 space-y-1">
                <Label className="text-[10px] text-slate-500">Unidad</Label>
                <Input
                  className="h-8 text-xs"
                  value={it.unidad}
                  onChange={(e) => actualizar(idx, { unidad: e.target.value.toUpperCase() })}
                  placeholder="KGM"
                />
              </div>
              {items.length > 1 && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                  onClick={() => eliminar(idx)}
                  title={`Quitar artículo #${idx + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2 pl-8">
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Label className="text-[10px] text-slate-500">Descripción</Label>
                  {it.enCatalogo && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-emerald-700">
                      <Check className="h-2.5 w-2.5" /> del catálogo
                    </span>
                  )}
                </div>
                <Input
                  className="h-8 text-xs"
                  value={it.descripcion}
                  onChange={(e) => actualizar(idx, { descripcion: e.target.value })}
                  placeholder={it.enCatalogo ? '' : 'Se autocompleta al escribir el código'}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pl-8">
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-500">Lote</Label>
                <Input className="h-8 text-xs" value={it.lote} onChange={(e) => actualizar(idx, { lote: e.target.value })} placeholder="Manual" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-500">F. producción</Label>
                <Input className="h-8 text-xs" type="date" value={it.fechaProduccion} onChange={(e) => actualizar(idx, { fechaProduccion: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-500">F. vencimiento</Label>
                <Input className="h-8 text-xs" type="date" value={it.fechaVencimiento} onChange={(e) => actualizar(idx, { fechaVencimiento: e.target.value })} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" className="w-full gap-1.5 text-xs border-dashed" onClick={agregar}>
        <Plus className="h-3.5 w-3.5" /> Agregar artículo ({items.length} en la guía)
      </Button>
    </div>
  )
}
