'use client'

/**
 * RACKLY — Recepción · Editor de lista de artículos (compartido).
 *
 * Usado por las 2 vías de registro (foto de guía y manual). Una guía puede
 * traer 20+ artículos; cada artículo se edita como una tarjeta compacta:
 *
 *   · Código        → AUTOCOMPLETADO del catálogo (menú al teclear: código,
 *                     prefijo o descripción) + autollenado de descripción y
 *                     unidad. Tolerante a pegados OCR ("5653.", "56 53").
 *   · Descripción   → SE LIMPIA al borrar el código o al cambiarlo por uno
 *                     sin match (antes se quedaba pegada del código anterior).
 *                     Si el usuario la escribió a mano, se respeta.
 *   · Cantidad      → editable (si llegó menor cantidad se ajusta aquí).
 *   · Lote y fechas → manuales, por artículo; con acción "aplicar a todos"
 *                     para no repetir tecleo cuando coinciden.
 */

import { useEffect, useRef, useState } from 'react'
import { buscarCatalogo, fetchCatalogo, isCatalogoLoaded, searchCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Plus, Trash2, Check, ClipboardCopy, TriangleAlert, PackageSearch, SearchCheck } from 'lucide-react'

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
  /** El código se recuperó por coincidencia de descripción del OCR. */
  matchPorDescripcion?: boolean
  /** Requiere revisión humana contra la guía física. */
  revision?: boolean
  /** El usuario escribió la descripción a mano (no la pisa el catálogo). */
  descripcionManual: boolean
  /** El usuario escribió la unidad a mano (no la pisa el catálogo). */
  unidadManual: boolean
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
    descripcionManual: false,
    unidadManual: false,
  }
}

/** Filtra los artículos listos para registrar (con código/desc y cantidad > 0). */
export function itemsValidos(items: ItemRecepcion[]): ItemRecepcion[] {
  return items.filter((it) => {
    const cantidad = aNumero(it.cantidad)
    return Boolean(it.codigo.trim() || it.descripcion.trim()) && !isNaN(cantidad) && cantidad > 0
  })
}

const MAX_SUGERENCIAS = 8

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

  // Catálogo para el autocompletado (comparte la carga con el módulo).
  const [catTamano, setCatTamano] = useState(isCatalogoLoaded() ? -1 : 0)
  const [catError, setCatError] = useState(false)
  useEffect(() => {
    if (isCatalogoLoaded()) return
    let vivo = true
    void fetchCatalogo().then((c) => {
      if (!vivo) return
      setCatTamano(c.length)
      // La carga respondió pero trajo 0 códigos (BD vacía o red caída):
      // antes quedaba "Catálogo: cargando…" para siempre.
      if (c.length === 0) setCatError(true)
    })
    return () => {
      vivo = false
    }
  }, [])

  // Menú de sugerencias: fila abierta + índice resaltado.
  const [menuIdx, setMenuIdx] = useState<number | null>(null)
  const [resaltado, setResaltado] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
  }, [])

  function actualizar(idx: number, patch: Partial<ItemRecepcion>) {
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  function sugerenciasPara(codigo: string): CatalogoItem[] {
    const q = codigo.trim()
    if (!q) return []
    return searchCatalogo(q, MAX_SUGERENCIAS)
  }

  /**
   * Al escribir/borrar el código:
   *   · vacío      → descripción y unidad SE LIMPIAN (ya no quedan pegadas).
   *   · en catálogo→ se autocompletan con el match.
   *   · sin match  → se limpian, salvo que el usuario las haya escrito a mano
   *                  (flag descripcionManual/unidadManual): respeta el tecleo
   *                  de artículos que no están en el catálogo.
   */
  function onCodigoChange(idx: number, valor: string) {
    const it = items[idx]
    const cat = valor.trim() ? buscarSeguro(valor) : undefined
    let descripcion = it.descripcion
    let unidad = it.unidad
    if (!valor.trim()) {
      if (!it.descripcionManual) descripcion = ''
      if (!it.unidadManual) unidad = ''
    } else if (cat) {
      descripcion = cat.descripcion
      unidad = cat.un
    } else {
      // El texto previo pertenecía al código anterior → fuera (si no es manual)
      if (!it.descripcionManual) descripcion = ''
      if (!it.unidadManual) unidad = ''
    }
    actualizar(idx, {
      codigo: valor,
      descripcion,
      unidad,
      enCatalogo: Boolean(cat),
      matchPorDescripcion: false,
      revision: false,
    })
    // Reabrir menú con las sugerencias del nuevo texto
    if (valor.trim()) {
      setResaltado(0)
      setMenuIdx(idx)
    } else {
      setMenuIdx(null)
    }
  }

  /** Match canónico del catálogo (exacta + normalización + regla 09==9). */
  function buscarSeguro(valor: string): CatalogoItem | undefined {
    return buscarCatalogo(valor)
  }

  function aplicarSugerencia(idx: number, cat: CatalogoItem) {
    actualizar(idx, {
      codigo: cat.codigo,
      descripcion: cat.descripcion,
      unidad: cat.un,
      enCatalogo: true,
      matchPorDescripcion: false,
      revision: false,
    })
    setMenuIdx(null)
  }

  function agregar() {
    onChange([...items, itemVacio()])
  }

  function eliminar(idx: number) {
    onChange(items.filter((_, i) => i !== idx))
    setMenuIdx(null)
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
      {/* Estado del catálogo (fuente del autocompletado) */}
      <p className="text-[10px] text-slate-400 flex items-center gap-1">
        <PackageSearch className="h-3 w-3" />
        {catError
          ? 'Catálogo no disponible (revisa tu conexión y recarga la página). Puedes digitar código, descripción y unidad a mano.'
          : catTamano === 0
            ? 'Catálogo: cargando… (mientras, puedes teclear el código a mano)'
            : catTamano < 0
              ? `Catálogo listo — al escribir el código se muestran sugerencias y se autocompleta descripción y unidad.`
              : `Catálogo listo (${catTamano} códigos) — al escribir el código se muestran sugerencias.`}
      </p>

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
        {items.map((it, idx) => {
          const sugerencias = menuIdx === idx ? sugerenciasPara(it.codigo) : []
          return (
            <div
              key={idx}
              className={`rounded-lg border p-2.5 space-y-2 ${
                it.enCatalogo ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-400 w-6 shrink-0">#{idx + 1}</span>
                <div className="flex-1 relative space-y-1">
                  <Label className="text-[10px] text-slate-500">Código del artículo</Label>
                  <Input
                    className="h-8 text-xs font-semibold"
                    value={it.codigo}
                    onChange={(e) => onCodigoChange(idx, e.target.value)}
                    onFocus={() => {
                      if (blurTimer.current) clearTimeout(blurTimer.current)
                      if (it.codigo.trim()) {
                        setResaltado(0)
                        setMenuIdx(idx)
                      }
                    }}
                    onBlur={() => {
                      // Espera el click del menú antes de cerrar
                      blurTimer.current = setTimeout(() => setMenuIdx(null), 150)
                    }}
                    onKeyDown={(e) => {
                      if (menuIdx !== idx || sugerencias.length === 0) return
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setResaltado((r) => (r + 1) % sugerencias.length)
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setResaltado((r) => (r - 1 + sugerencias.length) % sugerencias.length)
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        aplicarSugerencia(idx, sugerencias[resaltado])
                      } else if (e.key === 'Escape') {
                        setMenuIdx(null)
                      }
                    }}
                    placeholder="Ej: 5653"
                    autoComplete="off"
                    inputMode="numeric"
                  />
                  {/* Menú de sugerencias del catálogo */}
                  {sugerencias.length > 0 && (
                    <div className="absolute z-30 top-full left-0 mt-0.5 w-full min-w-[240px] max-w-[320px] max-h-52 overflow-y-auto rounded-md border bg-white shadow-lg">
                      {sugerencias.map((c, si) => (
                        <button
                          key={c.codigo}
                          type="button"
                          className={`w-full text-left px-2.5 py-1.5 text-xs flex items-baseline gap-2 ${
                            si === resaltado ? 'bg-amber-50' : 'bg-white'
                          } hover:bg-amber-50`}
                          onMouseDown={(e) => {
                            // mousedown para aplicar antes del blur del input
                            e.preventDefault()
                            aplicarSugerencia(idx, c)
                          }}
                        >
                          <span className="font-bold text-slate-800 w-14 shrink-0">{c.codigo}</span>
                          <span className="truncate text-slate-500">{c.descripcion}</span>
                          {c.un && <span className="ml-auto text-[9px] text-slate-400 shrink-0">{c.un}</span>}
                        </button>
                      ))}
                    </div>
                  )}
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
                    onChange={(e) => actualizar(idx, { unidad: e.target.value.toUpperCase(), unidadManual: Boolean(e.target.value.trim()) })}
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
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-[10px] text-slate-500">Descripción</Label>
                    {it.revision && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-amber-700">
                        <TriangleAlert className="h-2.5 w-2.5" /> revisar con la guía
                      </span>
                    )}
                    {!it.revision && it.matchPorDescripcion && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-sky-700">
                        <SearchCheck className="h-2.5 w-2.5" /> código por descripción — confírmalo
                      </span>
                    )}
                    {!it.revision && !it.matchPorDescripcion && it.enCatalogo && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-emerald-700">
                        <Check className="h-2.5 w-2.5" /> del catálogo
                      </span>
                    )}
                    {!it.enCatalogo && !it.revision && it.codigo.trim() && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-amber-700">
                        <TriangleAlert className="h-2.5 w-2.5" /> no está en catálogo — revisa el código
                      </span>
                    )}
                  </div>
                  <Input
                    className="h-8 text-xs"
                    value={it.descripcion}
                    onChange={(e) => actualizar(idx, { descripcion: e.target.value, descripcionManual: Boolean(e.target.value.trim()) })}
                    placeholder={it.enCatalogo ? '' : 'Se autocompleta al escribir el código'}
                  />
                </div>
              </div>
              {/* En móvil las fechas nativas necesitan ~110px: en 3 columnas
                  quedaban a 69px y el valor elegido se veía recortado. */}
              <div className="grid grid-cols-1 min-[430px]:grid-cols-3 gap-2 pl-8">
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
          )
        })}
      </div>

      <Button type="button" variant="outline" className="w-full gap-1.5 text-xs border-dashed" onClick={agregar}>
        <Plus className="h-3.5 w-3.5" /> Agregar artículo ({items.length} en la guía)
      </Button>
    </div>
  )
}
