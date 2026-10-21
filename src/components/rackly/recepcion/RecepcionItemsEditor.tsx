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
 *   · DIVIDIR       → la guía trae la SUMA pero la mercadería llega en
 *                     N paletas con cantidades distintas: "Dividir en
 *                     paletas" parte el artículo y al registrar sale 1
 *                     fila/rótulo POR PALETA con su cantidad propia.
 *                     Agregar/quitar paletas REPARTE el total solo.
 *   · Lote y fechas → manuales, en cada tarjeta de artículo.
 *   · POR PALETA    → cada paleta puede llevar SU lote/producción/vencimiento
 *                     (corregir una paleta específica) SIN tocar código,
 *                     descripción ni la cantidad total ya jalada; vacío =
 *                     hereda del artículo (así el dato del artículo cubre a
 *                     todas las paletas sin dato propio — no hace falta un
 *                     panel de "aplicar a todos": se pidieron quitar por
 *                     redundantes, 2026-10).
 */

import { useEffect, useRef, useState } from 'react'
import { buscarCatalogo, fetchCatalogo, isCatalogoLoaded, searchCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'
import {
  combinarPaletas,
  distribuirEquitativo,
  formatearCantidad,
  MAX_PALETAS,
  repartirEquitativo,
  sumaPaletas,
  type PaletaDividir,
} from '@/lib/rackly/recepcion-filas'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { requiereProveedor } from '@/lib/utils'
import { PROVEEDORES_FILM } from '@/lib/rackly/constants'
import {
  Plus,
  Trash2,
  Check,
  TriangleAlert,
  PackageSearch,
  SearchCheck,
  Scissors,
  X,
  Package,
  Scale,
} from 'lucide-react'

/** Artículo editable de una recepción. Si se DIVIDE en paletas, al
 *  registrar se genera 1 fila por paleta (mismo código; cantidad propia). */
export type ItemRecepcion = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Proveedor del ARTÍCULO (film: MISMA lista que Racks — INCOMIN, DAMAR,
   *  …). Exigido cuando la descripción es lámina/stretch (requiereProveedor);
   *  '' cuando el producto no lo requiere. Las paletas pueden traer uno
   *  distinto (PaletaDividir.proveedor). */
  proveedor: string
  enCatalogo: boolean
  /** El código se recuperó por coincidencia de descripción del OCR. */
  matchPorDescripcion?: boolean
  /** Requiere revisión humana contra la guía física. */
  revision?: boolean
  /** El usuario escribió la descripción a mano (no la pisa el catálogo). */
  descripcionManual: boolean
  /** El usuario escribió la unidad a mano (no la pisa el catálogo). */
  unidadManual: boolean
  /** Paletas de la división (DIVIDIR): vacío/ausente = artículo sin dividir.
   *  Cada paleta lleva su cantidad y opcionalmente su lote/fechas propios
   *  ('' = usa los del artículo). */
  paletas?: PaletaDividir[]
  /** Id de la fila YA registrada de la que nació este artículo (solo edición
   *  de guía: lo adjunta filasAItems; null/ausente = artículo nuevo). */
  filaId?: string | null
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
    proveedor: '',
    enCatalogo: false,
    descripcionManual: false,
    unidadManual: false,
  }
}

/**
 * Filtra los artículos listos para registrar (código/desc + cantidad):
 *   · sin dividir → cantidad total > 0.
 *   · dividido    → basta que ALGUNA paleta tenga cantidad > 0 (el total
 *                   puede quedar vacío; las paletas mandan al registrar).
 */
export function itemsValidos(items: ItemRecepcion[]): ItemRecepcion[] {
  return items.filter((it) => {
    if (!it.codigo.trim() && !it.descripcion.trim()) return false
    if (it.paletas && it.paletas.some((p) => {
      const n = aNumero(p?.cantidad ?? '')
      return !isNaN(n) && n > 0
    })) return true
    const cantidad = aNumero(it.cantidad)
    return !isNaN(cantidad) && cantidad > 0
  })
}

const MAX_SUGERENCIAS = 8

/**
 * Opciones del Select de proveedor: la MISMA lista que Racks (PROVEEDORES_FILM)
 * + el valor actual si es legacy (guías viejas guardaban la empresa en esta
 * columna) — así re-guardar una guía antigua NO obliga a re-elegir lo que ya
 * estaba registrado.
 */
function opcionesProveedor(actual: string): string[] {
  const valor = actual.trim()
  if (!valor) return [...PROVEEDORES_FILM]
  return (PROVEEDORES_FILM as readonly string[]).includes(valor)
    ? [...PROVEEDORES_FILM]
    : [valor, ...PROVEEDORES_FILM]
}

export function RecepcionItemsEditor({
  items,
  onChange,
}: {
  items: ItemRecepcion[]
  onChange: (items: ItemRecepcion[]) => void
}) {
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
      // El proveedor pertenece al ARTÍCULO: si el nuevo código/descripción
      // ya no es lámina/stretch, el elegido antes sobra (evita arrastrar un
      // proveedor de film a un producto que no lo es).
      proveedor: requiereProveedor(descripcion) ? it.proveedor : '',
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
      proveedor: requiereProveedor(cat.descripcion) ? items[idx].proveedor : '',
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

  // ─── DIVIDIR EN PALETAS ───────────────────────────────────────────
  // La guía trae la SUMA; la mercadería llega en N paletas con cantidades
  // distintas y CADA paleta se rotula con SU cantidad. Dividir pre-llena
  // partes iguales (editable) y al registrar salen filas separadas.

  const PALETAS_INICIALES = 3

  function dividir(idx: number) {
    const it = items[idx]
    actualizar(idx, {
      paletas: combinarPaletas([], distribuirEquitativo(it.cantidad, PALETAS_INICIALES)),
    })
  }

  function quitarDivision(idx: number) {
    actualizar(idx, { paletas: undefined })
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

      {/* Lista de artículos */}
      <div className="space-y-2">
        {items.map((it, idx) => {
          const sugerencias = menuIdx === idx ? sugerenciasPara(it.codigo) : []
          return (
            <div
              key={idx}
              className={`rounded-lg border p-2.5 sm:p-3 space-y-2 ${
                it.enCatalogo ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
              }`}
            >
              {/* Fila 1 (móvil): Nº + CÓDIGO ancho completo + quitar.
                  Cantidad y Unidad bajan a la fila 2 al 50% cada una
                  (en sm+ vuelven a la misma fila, compactas). Antes las
                  3 columnas fijas dejaban el código de ~60px en móvil
                  ("fuera de su sitio/margen"). */}
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-[10px] font-bold text-slate-400 w-6 shrink-0 pb-2">#{idx + 1}</span>
                <div className="flex-1 min-w-[140px] relative space-y-1">
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
                {items.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 mb-0.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                    onClick={() => eliminar(idx)}
                    title={`Quitar artículo #${idx + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
                <div className="w-[calc(50%-0.25rem)] sm:w-24 space-y-1">
                  <Label className="text-[10px] text-slate-500">Cantidad</Label>
                  <Input
                    className="h-8 text-xs"
                    inputMode="decimal"
                    value={it.cantidad}
                    onChange={(e) => actualizar(idx, { cantidad: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div className="w-[calc(50%-0.25rem)] sm:w-20 space-y-1">
                  <Label className="text-[10px] text-slate-500">Unidad</Label>
                  <Input
                    className="h-8 text-xs"
                    value={it.unidad}
                    onChange={(e) => actualizar(idx, { unidad: e.target.value.toUpperCase(), unidadManual: Boolean(e.target.value.trim()) })}
                    placeholder="KGM"
                  />
                </div>
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
              {/* PROVEEDOR DEL ARTÍCULO — zona de códigos (2026-10-22): el
                  MISMO criterio que Racks — los films (lámina/stretch) exigen
                  elegir de la lista. La empresa que envía la guía vive en el
                  encabezado ("Empresa de Origen"); aquí se registra el
                  proveedor REAL del producto (una guía de una empresa trae
                  multi-productos de distintos proveedores). */}
              {requiereProveedor(it.descripcion) && (
                <div className="flex items-end gap-2 pl-8">
                  <div className="flex-1 min-w-[180px] space-y-1">
                    <Label className="text-[10px] text-slate-500">
                      Proveedor <span className="text-red-500">*</span>
                    </Label>
                    <Select
                      value={it.proveedor}
                      onValueChange={(v) => actualizar(idx, { proveedor: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Selecciona proveedor" />
                      </SelectTrigger>
                      <SelectContent>
                        {opcionesProveedor(it.proveedor).map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
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
              {/* DIVIDIR EN PALETAS: la guía trae la suma; la mercadería llega
                  en N paletas con cantidades distintas y cada una se rotula
                  con SU cantidad (al registrar: 1 fila por paleta).
                  BOTÓN PROMINENTE: antes era un texto gris casi invisible y
                  el usuario no lo encontraba — ahora es un botón delineado
                  ámbar, ancho completo en móvil. */}
              {!(it.paletas && it.paletas.length > 0) ? (
                <div className="sm:pl-8">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 w-full gap-1.5 border-dashed border-amber-300 text-xs font-semibold text-amber-700 hover:bg-amber-50 hover:text-amber-800 sm:w-auto sm:px-4"
                    onClick={() => dividir(idx)}
                    title="La guía trae la suma: divide la cantidad por paleta para rotular paleta por paleta"
                  >
                    <Scissors className="h-3.5 w-3.5" />
                    Dividir en paletas
                    <span className="hidden sm:inline font-normal text-slate-400">— la guía trae la suma; separa la cantidad por paleta</span>
                  </Button>
                </div>
              ) : (
                <div className="sm:pl-8">
                  <PanelPaletas
                    it={it}
                    onPaletas={(pl) => actualizar(idx, { paletas: pl })}
                    onQuitarDivision={() => quitarDivision(idx)}
                  />
                </div>
              )}
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

/**
 * Panel "DIVIDIR EN PALETAS" de UN artículo: una tarjeta por paleta con SU
 * cantidad y — OPCIONALMENTE — SU lote/producción/vencimiento propios.
 *
 * Reglas (pedidas por el usuario):
 *   · Agregar/quitar paletas REPARTE el total del artículo en partes iguales
 *     (100 en 3 → quito 1 → 50 y 50; 100 → 4 → 25 por paleta).
 *   · El lote/fechas de UNA paleta se corrige SOLO en esa paleta; si todas
 *     comparten datos basta ponerlos en el artículo (las paletas vacías lo
 *     heredan). "Quitar diferencias" vuelve a hacerlas heredar. El atajo
 *     "mismo lote/fechas para TODAS" se quitó por redundante (2026-10).
 *   · JAMÁS se toca código, descripción ni la cantidad total ya jalada de la
 *     guía: esos datos viven en la tarjeta del artículo, no en este panel.
 *     Vacío en un campo = esa paleta USA el dato del artículo (así editar el
 *     lote/fechas del artículo sigue moviendo a las paletas sin dato propio).
 *
 * Presentación móvil (reporte 2026-10: "se ve todo junto y desordenado" y
 * problemas de navegabilidad al registrar desde celulares):
 *   · Cabecera compacta de 1 línea (título + badge de suma/guía) en vez del
 *     párrafo de ~7 líneas; el aviso de descuadre tiene línea propia.
 *   · SIN scroll anidado en móvil: el max-h-72 atrapaba el gesto del dedo y
 *     la página dejaba de desplazarse. En móvil la lista fluye con la página;
 *     en escritorio se conserva compacta (sm:max-h-80 + scroll propio).
 *   · Lote/fechas apilados a ancho completo bajo 430px (en 2 columnas se
 *     recortaba "dd/mm/aaaa") y controles a 36px (h-9) para el pulgar.
 *   · La lógica de reparto y herencia NO cambió: es solo presentación.
 */
function PanelPaletas({
  it,
  onPaletas,
  onQuitarDivision,
}: {
  it: ItemRecepcion
  onPaletas: (paletas: PaletaDividir[]) => void
  onQuitarDivision: () => void
}) {
  const paletas = it.paletas ?? []

  function editarPaleta(pi: number, patch: Partial<PaletaDividir>) {
    onPaletas(paletas.map((p, i) => (i === pi ? { ...p, ...patch } : p)))
  }

  /** AGREGAR: el total se redistribuye en partes iguales (la última absorbe
   *  el residuo); la paleta nueva hereda el lote/fechas del artículo. */
  function agregarPaleta() {
    if (paletas.length >= MAX_PALETAS) return
    const n = paletas.length + 1
    const cant = repartirEquitativo(it, n) ?? [...paletas.map((p) => p.cantidad), '']
    onPaletas(combinarPaletas(paletas, cant))
  }

  /** QUITAR: las restantes se reparten el total en partes iguales (100 en
   *  3 → borro 1 → 50 y 50); cada paleta conservadora SU lote/fechas propio. */
  function quitarPaleta(pi: number) {
    if (paletas.length <= 2) {
      // Con menos de 2 ya no tiene sentido dividir: se quita la división.
      onQuitarDivision()
      return
    }
    const restantes = paletas.filter((_, i) => i !== pi)
    const cant = repartirEquitativo(it, restantes.length) ?? restantes.map((p) => p.cantidad)
    onPaletas(combinarPaletas(restantes, cant))
  }

  /** Vuelve a partes iguales sin cambiar el nº de paletas (deshace el
   *  tecleo manual; NO toca los lote/fechas propios de cada paleta). */
  function repartir() {
    if (paletas.length < 2) return
    const next = repartirEquitativo(it, paletas.length)
    if (next) onPaletas(combinarPaletas(paletas, next))
  }

  /** Borra los datos propios de todas las paletas: vuelven a heredar del
   *  artículo (el "reset" cómodo después de corregir a mano). */
  function usarElDelArticulo() {
    onPaletas(
      paletas.map((p) => ({
        ...p,
        lote: '',
        fechaProduccion: '',
        fechaVencimiento: '',
        proveedor: '',
      }))
    )
  }

  const conDatosPropios = paletas.some(
    (p) => p.lote || p.fechaProduccion || p.fechaVencimiento || p.proveedor
  )
  /** El artículo es film → cada paleta puede traer SU proveedor distinto
   *  (pedido 2026-10-22: dividir y seleccionar otro proveedor por paleta). */
  const conProveedor = requiereProveedor(it.descripcion)
  const suma = sumaPaletas(paletas)
  const total = aNumero(it.cantidad)
  const difieren = suma > 0 && !isNaN(total) && total > 0 && Math.abs(suma - total) > 0.001

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-2 space-y-2 sm:p-2.5">
      {/* CABECERA COMPACTA (orden en móvil): el párrafo explicativo de antes
          ocupaba ~7 líneas en un celular y empujaba las paletas fuera de
          pantalla ("se ve todo junto y desordenado"). Ahora: título + badge
          con la suma/total + "Quitar división" a tamaño táctil (h-9 ≈ 36px;
          el botón de h-6 antes era casi imposible de pulsar con el dedo).
          flex-wrap: en pantallas muy angostas (360px) el botón salta a una
          segunda línea en lugar de desbordar y quedar invisible. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] font-bold text-sky-900">
          <Package className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">Paletas ({paletas.length})</span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
              difieren ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-700'
            }`}
          >
            Suma {formatearCantidad(suma)}
            {!isNaN(total) && total > 0 ? ` · guía ${formatearCantidad(total)}` : ''}
          </span>
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-9 shrink-0 gap-1 px-2 text-[11px] text-slate-500 hover:text-rose-600 sm:h-7 sm:px-1.5 sm:text-[10px]"
          onClick={onQuitarDivision}
          title="Quita la división: el artículo vuelve a una sola cantidad con su lote/fechas"
        >
          <X className="h-3 w-3" /> Quitar división
        </Button>
      </div>
      {/* Ayuda reducida a UNA línea (el detalle completo vive en los
          title/hover de cada botón, no estorba a la vista). */}
      <p className="text-[10px] leading-snug text-sky-800/90">
        Agregar o quitar reparte el total en partes iguales · lote/fechas/proveedor vacíos usan los del artículo.
      </p>
      {/* Aviso de descuadre con LÍNEA PROPIA y visible: antes iba perdido en
          la esquina inferior derecha, en texto de 10px mezclado con botones. */}
      {difieren && (
        <p className="flex items-center gap-1.5 rounded-md bg-amber-100/90 px-2 py-1.5 text-[10px] font-semibold text-amber-800">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          La suma de paletas no coincide con el total de la guía — revisa las cantidades.
        </p>
      )}

      {/* LISTA DE PALETAS — flujo natural en móvil: el scroll anidado
          (max-h-72 overflow-y-auto) atrapaba el gesto del dedo y la página
          dejaba de desplazarse = "problemas de navegabilidad". En móvil la
          lista crece con la página (un solo scroll, el de la pantalla); en
          escritorio se mantiene compacta con scroll propio (con el mouse no
          hay atrape). */}
      <div className="-mx-0.5 space-y-1.5 px-0.5 sm:max-h-80 sm:overflow-y-auto sm:overscroll-contain">
        {paletas.map((p, pi) => (
          <div key={pi} className="space-y-1.5 rounded-md border border-sky-100 bg-white p-2">
            {/* Fila 1: Nº + cantidad + quitar — controles a 36px en móvil
                (h-8 = 32px quedaba bajo el mínimo táctil cómodo). */}
            <div className="flex items-center gap-2">
              <span
                className="w-7 shrink-0 text-[10px] font-bold text-slate-400"
                title={`Paleta ${pi + 1}`}
              >
                P{pi + 1}
              </span>
              <Input
                className="h-9 min-w-0 flex-1 text-xs sm:h-8"
                inputMode="decimal"
                value={p.cantidad}
                onChange={(e) => editarPaleta(pi, { cantidad: e.target.value })}
                placeholder="Cantidad"
                aria-label={`Cantidad de la paleta ${pi + 1}`}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0 text-slate-400 hover:text-rose-600 sm:h-8 sm:w-8"
                onClick={() => quitarPaleta(pi)}
                title={`Quitar paleta ${pi + 1}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {/* Datos PROPIOS de esta paleta (solo si difieren): al registrar,
                esta fila sale con SU lote/fechas y su rótulo se imprime con
                ellos — sin cambiar código/descripción/cantidad total.
                APILADOS a ancho completo en móvil (igual que la tarjeta del
                artículo): las fechas nativas necesitan ~110px y en 2 columnas
                se recortaba "dd/mm/aaaa"; pasan a 3 columnas desde 430px. */}
            <div className="grid grid-cols-1 min-[430px]:grid-cols-3 gap-1.5">
              <div className="space-y-0.5">
                <Label className="text-[10px] text-slate-500">
                  Lote propio{it.lote ? ` (= ${it.lote})` : ' (opcional)'}
                </Label>
                <Input
                  className="h-9 text-xs sm:h-8"
                  value={p.lote}
                  onChange={(e) => editarPaleta(pi, { lote: e.target.value })}
                  placeholder={it.lote ? `Usa ${it.lote}` : 'Del artículo'}
                  aria-label={`Lote de la paleta ${pi + 1}`}
                />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10px] text-slate-500">F. producción</Label>
                <Input
                  className="h-9 text-xs sm:h-8"
                  type="date"
                  value={p.fechaProduccion}
                  onChange={(e) => editarPaleta(pi, { fechaProduccion: e.target.value })}
                  aria-label={`Fecha de producción de la paleta ${pi + 1}`}
                />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10px] text-slate-500">F. vencimiento</Label>
                <Input
                  className="h-9 text-xs sm:h-8"
                  type="date"
                  value={p.fechaVencimiento}
                  onChange={(e) => editarPaleta(pi, { fechaVencimiento: e.target.value })}
                  aria-label={`Fecha de vencimiento de la paleta ${pi + 1}`}
                />
              </div>
              {/* Proveedor PROPIO de la paleta (solo artículos film): una
                  paleta puede venir de OTRO proveedor — vacío = usa el del
                  artículo (misma herencia que lote/fechas). */}
              {conProveedor && (
                <div className="space-y-0.5">
                  <Label className="text-[10px] text-slate-500">
                    Proveedor propio{it.proveedor ? ` (= ${it.proveedor})` : ' (opcional)'}
                  </Label>
                  <Select
                    value={p.proveedor}
                    onValueChange={(v) => editarPaleta(pi, { proveedor: v })}
                  >
                    <SelectTrigger className="h-9 text-xs sm:h-8">
                      <SelectValue
                        placeholder={it.proveedor ? `Usa ${it.proveedor}` : 'Del artículo'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {opcionesProveedor(p.proveedor || it.proveedor).map((pr) => (
                        <SelectItem key={pr} value={pr}>
                          {pr}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* PIE: solo las 3 acciones (la suma vive en el badge de la cabecera y
          el aviso de descuadre tiene su línea propia). Botones h-8 con texto
          de 11px para pulsación cómoda en celulares. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 border-dashed px-2.5 text-[11px]"
          disabled={paletas.length >= MAX_PALETAS}
          onClick={agregarPaleta}
          title={paletas.length >= MAX_PALETAS ? `Máximo ${MAX_PALETAS} paletas por artículo` : `Agrega una paleta más (máximo ${MAX_PALETAS})`}
        >
          <Plus className="h-3 w-3" /> Agregar paleta
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1 px-2.5 text-[11px] text-sky-700 hover:bg-sky-100 hover:text-sky-800"
          onClick={repartir}
          title="Divide de nuevo el total del artículo en partes iguales entre todas las paletas (no toca los lote/fechas propios)"
        >
          <Scale className="h-3 w-3" /> Repartir en partes iguales
        </Button>
        {/* Reset cómodo: si te equivocaste digitando datos propios en las
            paletas, un clic las devuelve a heredar el dato del artículo.
            Solo aparece cuando HAY datos propios (no estorba el resto). */}
        {conDatosPropios && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1 px-2.5 text-[11px] text-slate-500 hover:text-rose-600"
            onClick={usarElDelArticulo}
            title="Borra los datos propios de las paletas: todas vuelven a usar el lote/fechas del artículo"
          >
            <X className="h-3 w-3" /> Quitar diferencias
          </Button>
        )}
      </div>
    </div>
  )
}
