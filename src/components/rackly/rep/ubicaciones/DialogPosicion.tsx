'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Dialog de la posición (mapa de Ubicaciones).
 *
 * Paridad con OcupacionTab de Insumos: al hacer clic sobre una celda del
 * mapa se abre ESTE dialog con las acciones operativas de la posición:
 *
 *   · VER      — contenido real de las loncheras A/B (artículos, cantidades)
 *   · INGRESO  — búsqueda de artículo + cantidad → rep_registrar_ingreso
 *   · SALIDA   — artículo de la lonchera + cantidad → rep_registrar_salida
 *   · TRASLADO — artículo + posición destino → rep_registrar_traslado
 *   · HISTORIAL— kardex filtrado por esta ubicación (origen o destino)
 *
 * Las tres escrituras son RPC atómicas (validaciones en BD: capacidad 15,
 * stock suficiente, permiso repuestos.crear, kardex en la misma
 * transacción). El stock estacionado en tránsito (RAL) no se toca desde
 * aquí: la UI lo marca y la RPC lo rechazaría.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  repBuscarArticulos,
  repMovimientosDeUbicacion,
  repRegistrarIngreso,
  repRegistrarSalida,
  repRegistrarTraslado,
  repStockDeLonchera,
  type RepArticulo,
  type RepMovimiento,
  type RepOcupacionLonchera,
  type RepStockDeLonchera,
  type RepUbicacion,
} from '@/lib/rackly/rep/rep-client'
import {
  REP_ETIQUETA_MOV,
  REP_MAX_ARTICULOS_LONCHERA,
  repLadosDeTipo,
  type RepLonchera,
  type RepTipoMovimiento,
} from '@/lib/rackly/rep/rep-tipos'
import { aNumero } from '@/lib/rackly/formato'
import { mensajeError } from '@/lib/rackly/errores'
import { formatDateTime } from '@/lib/utils'
import { SelectorUbicacionRep } from '@/components/rackly/rep/ubicaciones/SelectorUbicacionRep'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpFromLine,
  Clock,
  Loader2,
  PackageOpen,
  Search,
  Wrench,
} from 'lucide-react'

type LoncheraRef = { id: string; lado: 'A' | 'B' }
type Modo = 'view' | 'ingreso' | 'salida' | 'traslado' | 'historial'

const CLASE_TIPO: Record<RepTipoMovimiento, string> = {
  ingreso: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  salida: 'bg-rose-50 text-rose-700 border-rose-200',
  devolucion: 'bg-orange-50 text-orange-700 border-orange-200',
  traslado: 'bg-sky-50 text-sky-700 border-sky-200',
  ajuste: 'bg-violet-50 text-violet-700 border-violet-200',
}

export function DialogPosicion({
  ubicacion,
  loncheras,
  loncherasMap,
  ubicaciones,
  ocupacion,
  puedeOperar,
  onHecho,
  onClose,
  onVolverOrigen,
}: {
  ubicacion: RepUbicacion | null
  /** Loncheras de ESTA ubicación (rack = A y B; zonas = A). */
  loncheras: LoncheraRef[]
  /** Todas las loncheras del almacén (para resolver destino del traslado). */
  loncherasMap: Map<string, RepLonchera>
  /** Todas las ubicaciones (selector de destino del traslado). */
  ubicaciones: RepUbicacion[]
  /** Ocupación agregada (badges del encabezado sin recargar). */
  ocupacion: Map<string, RepOcupacionLonchera>
  puedeOperar: boolean
  /** Recargar el mapa tras un movimiento exitoso. */
  onHecho: () => void
  onClose: () => void
  onVolverOrigen?: () => void
}) {
  const [modo, setModo] = useState<Modo>('view')
  const [ladoActivo, setLadoActivo] = useState<'A' | 'B'>(loncheras[0]?.lado ?? 'A')
  const [contenido, setContenido] = useState<Map<string, RepStockDeLonchera[]>>(new Map())
  const [busy, setBusy] = useState(false)
  /** Preselección al abrir Salida/Traslado desde una fila de la lista. */
  const [itemSalida, setItemSalida] = useState<RepStockDeLonchera | null>(null)
  const [itemTraslado, setItemTraslado] = useState<RepStockDeLonchera | null>(null)
  const vivoRef = useRef(true)

  useEffect(() => () => { vivoRef.current = false }, [])

  // NOTA: el reset de modo/lado/contenido al cambiar de posición NO va en un
  // efecto (react-hooks/set-state-in-effect): el padre monta este dialog con
  // key={ubicacion.id}, así que el estado interno se reinicia al remontar.

  const cargarContenido = useCallback(async () => {
    if (!ubicacion || loncheras.length === 0) return
    const vivo = vivoRef
    await Promise.all(
      loncheras.map(async (l) => {
        try {
          const filas = await repStockDeLonchera(l.id)
          if (vivo.current) setContenido((prev) => new Map(prev).set(l.id, filas))
        } catch {
          if (vivo.current) setContenido((prev) => new Map(prev).set(l.id, []))
        }
      })
    )
  }, [ubicacion, loncheras])

  useEffect(() => {
    void cargarContenido()
  }, [cargarContenido])

  const loncheraActiva = loncheras.find((l) => l.lado === ladoActivo) ?? null
  const itemsActivos = loncheraActiva ? contenido.get(loncheraActiva.id) ?? [] : []
  const cargandoContenido = loncheras.some((l) => !contenido.has(l.id))

  /** Tras un movimiento OK: recarga contenido + mapa y vuelve a VER. */
  async function trasExito(mensaje: string) {
    toast.success(mensaje)
    await cargarContenido()
    onHecho()
    setModo('view')
  }

  function errorMovimiento(err: unknown) {
    toast.error('No se pudo completar el movimiento', { description: mensajeError(err) })
  }

  const descripcionUbicacion = ubicacion
    ? ubicacion.sector === 'racks'
      ? `Rack R${String(ubicacion.rack).padStart(2, '0')} · Nivel ${ubicacion.nivel} · Posición ${ubicacion.secuencia}`
      : `Zona ${ubicacion.zona} · Posición ${ubicacion.secuencia}`
    : ''

  return (
    <Dialog open={!!ubicacion} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        {ubicacion && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-mono">
                {modo !== 'view' ? (
                  <button
                    onClick={() => setModo('view')}
                    className="rounded-md p-1 hover:bg-slate-100 text-slate-500"
                    aria-label="Volver a la vista de la posición"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                ) : (
                  <Wrench className="h-5 w-5 text-violet-600" />
                )}
                {ubicacion.codigo}
                {modo !== 'view' && (
                  <span className="text-xs font-sans font-semibold text-slate-400">
                    — {modo === 'ingreso' ? 'Ingreso' : modo === 'salida' ? 'Salida' : modo === 'traslado' ? 'Traslado' : 'Historial'}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>{descripcionUbicacion}{ubicacion.nota ? ` · ${ubicacion.nota}` : ''}</DialogDescription>
            </DialogHeader>

            {/* ══════════ VER: contenido de las loncheras ══════════ */}
            {modo === 'view' && (
              <VistaContenido
                loncheras={loncheras}
                ladoActivo={ladoActivo}
                setLadoActivo={setLadoActivo}
                items={itemsActivos}
                ocupacion={ocupacion}
                cargando={cargandoContenido}
                puedeOperar={puedeOperar}
                onIngreso={() => setModo('ingreso')}
                onSalida={(item) => { setItemSalida(item); setModo('salida') }}
                onTraslado={(item) => { setItemTraslado(item); setModo('traslado') }}
                onHistorial={() => setModo('historial')}
              />
            )}

            {/* ══════════ INGRESO ══════════ */}
            {modo === 'ingreso' && loncheraActiva && (
              <FormIngreso
                loncheraId={loncheraActiva.id}
                lado={ladoActivo}
                busy={busy}
                setBusy={setBusy}
                onExito={trasExito}
                onError={errorMovimiento}
                onCancel={() => setModo('view')}
              />
            )}

            {/* ══════════ SALIDA ══════════ */}
            {modo === 'salida' && loncheraActiva && (
              <FormSalida
                items={itemsActivos}
                loncheraId={loncheraActiva.id}
                lado={ladoActivo}
                codigoUbicacion={ubicacion.codigo}
                itemInicial={itemSalida}
                busy={busy}
                setBusy={setBusy}
                onExito={trasExito}
                onError={errorMovimiento}
                onCancel={() => setModo('view')}
              />
            )}

            {/* ══════════ TRASLADO ══════════ */}
            {modo === 'traslado' && loncheraActiva && (
              <FormTraslado
                items={itemsActivos}
                loncheraOrigenId={loncheraActiva.id}
                ladoOrigen={ladoActivo}
                ubicaciones={ubicaciones.filter((u) => u.id !== ubicacion.id)}
                loncherasMap={loncherasMap}
                itemInicial={itemTraslado}
                busy={busy}
                setBusy={setBusy}
                onExito={trasExito}
                onError={errorMovimiento}
                onCancel={() => setModo('view')}
              />
            )}

            {/* ══════════ HISTORIAL ══════════ */}
            {modo === 'historial' && (
              <PanelHistorial ubicacionId={ubicacion.id} ubicaciones={ubicaciones} />
            )}

            {/* Pie: volver al origen (deep-link) solo en VER */}
            {modo === 'view' && onVolverOrigen && (
              <DialogFooter>
                <Button variant="outline" onClick={onVolverOrigen} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Volver
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   VISTA — chips de lado + panel de la lonchera activa con acciones
   ═══════════════════════════════════════════════════════════════════ */

function VistaContenido({
  loncheras,
  ladoActivo,
  setLadoActivo,
  items,
  ocupacion,
  cargando,
  puedeOperar,
  onIngreso,
  onSalida,
  onTraslado,
  onHistorial,
}: {
  loncheras: LoncheraRef[]
  ladoActivo: 'A' | 'B'
  setLadoActivo: (l: 'A' | 'B') => void
  items: RepStockDeLonchera[]
  ocupacion: Map<string, RepOcupacionLonchera>
  cargando: boolean
  puedeOperar: boolean
  onIngreso: () => void
  onSalida: (item: RepStockDeLonchera) => void
  onTraslado: (item: RepStockDeLonchera) => void
  onHistorial: () => void
}) {
  const loncheraActiva = loncheras.find((l) => l.lado === ladoActivo)
  const o = loncheraActiva ? ocupacion.get(loncheraActiva.id) : undefined
  const articulos = o?.articulos ?? items.length
  const pct = Math.min(100, Math.round((articulos / REP_MAX_ARTICULOS_LONCHERA) * 100))

  return (
    <div className="space-y-3">
      {/* Chips de lado (solo si la posición tiene A y B) */}
      {loncheras.length > 1 && (
        <div className="flex rounded-lg border border-slate-200 overflow-hidden w-fit">
          {loncheras.map((l) => (
            <button
              key={l.id}
              onClick={() => setLadoActivo(l.lado)}
              className={`px-3.5 py-1 text-xs font-bold transition-colors ${
                ladoActivo === l.lado ? 'bg-violet-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              Lonchera {l.lado}
            </button>
          ))}
        </div>
      )}

      {cargando ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Cargando contenido…
        </div>
      ) : loncheras.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-6">Sin loncheras (situación anómala: revisa la BD).</p>
      ) : (
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="font-extrabold text-sm text-slate-700">Lonchera {ladoActivo}</span>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold ${articulos >= REP_MAX_ARTICULOS_LONCHERA ? 'text-rose-600' : 'text-slate-500'}`}>
                {articulos}/{REP_MAX_ARTICULOS_LONCHERA} artículos
              </span>
              {puedeOperar && (
                <Button size="sm" onClick={onIngreso} className="h-7 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700">
                  <ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso
                </Button>
              )}
            </div>
          </div>
          <Progress value={pct} className="h-1.5 mb-2" />

          {items.length === 0 ? (
            <p className="text-xs text-slate-400 flex items-center gap-1.5 py-3 justify-center">
              <PackageOpen className="h-3.5 w-3.5" /> Lonchera vacía
            </p>
          ) : (
            <ul className="space-y-1 max-h-56 overflow-y-auto">
              {items.map((s) => (
                <li key={s.stockId} className="flex items-center gap-2 text-xs border-b border-slate-100 pb-1.5 last:border-0">
                  <span className="font-mono font-bold text-slate-700 shrink-0">{s.codigo}</span>
                  <span className="text-slate-500 truncate flex-1" title={s.descripcion}>{s.descripcion}</span>
                  {s.enTransito && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                      Tránsito
                    </Badge>
                  )}
                  <span className="font-bold text-slate-900 shrink-0 text-right">
                    {s.cantidad.toLocaleString('es-PE')} {s.und}
                  </span>
                  {puedeOperar && (
                    <span className="flex gap-1 shrink-0">
                      <button
                        onClick={() => onSalida(s)}
                        disabled={s.enTransito}
                        title={s.enTransito ? 'Estacionado en tránsito (RAL): despáchalo o devuélvelo desde Tránsito' : 'Registrar salida'}
                        className="rounded-md px-1.5 py-1 bg-rose-50 text-rose-600 hover:bg-rose-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ArrowUpFromLine className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => onTraslado(s)}
                        disabled={s.enTransito}
                        title={s.enTransito ? 'Estacionado en tránsito (RAL): despáchalo o devuélvelo desde Tránsito' : 'Trasladar a otra posición'}
                        className="rounded-md px-1.5 py-1 bg-sky-50 text-sky-600 hover:bg-sky-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Historial (disponible siempre) */}
      <Button variant="outline" onClick={onHistorial} className="w-full gap-2 text-xs border-violet-200 text-violet-700 hover:bg-violet-50">
        <Clock className="h-3.5 w-3.5" /> Ver historial de la posición
      </Button>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   FORMULARIO INGRESO — búsqueda de artículo + cantidad
   ═══════════════════════════════════════════════════════════════════ */

function FormIngreso({
  loncheraId,
  lado,
  busy,
  setBusy,
  onExito,
  onError,
  onCancel,
}: {
  loncheraId: string
  lado: 'A' | 'B'
  busy: boolean
  setBusy: (v: boolean) => void
  onExito: (mensaje: string) => void
  onError: (err: unknown) => void
  onCancel: () => void
}) {
  const [q, setQ] = useState('')
  const [resultados, setResultados] = useState<RepArticulo[]>([])
  const [buscando, setBuscando] = useState(false)
  const [articulo, setArticulo] = useState<RepArticulo | null>(null)
  const [cantidad, setCantidad] = useState('')
  const [referencia, setReferencia] = useState('')
  const [errorLocal, setErrorLocal] = useState('')

  // Búsqueda con debounce (repBuscarArticulos pagina en servidor)
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResultados([])
      return
    }
    setBuscando(true)
    const t = setTimeout(async () => {
      try {
        const res = await repBuscarArticulos({ busqueda: term, soloActivos: true, page: 1, pageSize: 8 })
        setResultados(res.filas)
      } catch {
        setResultados([])
      } finally {
        setBuscando(false)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  const cant = aNumero(cantidad)

  async function registrar() {
    setErrorLocal('')
    if (!articulo) { setErrorLocal('Elige un artículo del catálogo'); return }
    if (!(cant > 0)) { setErrorLocal('Ingresa una cantidad mayor que cero'); return }
    setBusy(true)
    try {
      const r = await repRegistrarIngreso({
        articuloId: articulo.id,
        loncheraId,
        cantidad: cant,
        referencia: referencia.trim() || undefined,
      })
      const aviso = r.enOtraLonchera ? ` (ojo: también vive en ${r.enOtraLonchera.ubicacion} lado ${r.enOtraLonchera.lado})` : ''
      await onExito(`Ingreso de ${articulo.codigo} a ${r.ubicacion} lado ${r.lado}${aviso}`)
      setArticulo(null); setCantidad(''); setReferencia(''); setQ('')
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {!articulo ? (
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              autoFocus
              className="pl-9"
              placeholder="Código o descripción del artículo…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Buscar artículo"
            />
            {buscando && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />}
          </div>
          {resultados.length > 0 && (
            <div className="rounded-lg border divide-y max-h-56 overflow-y-auto">
              {resultados.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { setArticulo(a); setResultados([]) }}
                  className="w-full text-left px-3 py-2 hover:bg-violet-50 flex items-center gap-2"
                >
                  <span className="font-mono text-xs font-bold text-slate-800 shrink-0">{a.codigo}</span>
                  <span className="text-xs text-slate-500 truncate flex-1">{a.descripcion}</span>
                  <Badge variant="outline" className="text-[9px] shrink-0">{a.und}</Badge>
                </button>
              ))}
            </div>
          )}
          {q.trim().length >= 2 && !buscando && resultados.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-2">Sin resultados para «{q.trim()}»</p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-sm font-bold text-slate-800">{articulo.codigo}</p>
              <p className="text-xs text-slate-600 truncate" title={articulo.descripcion}>{articulo.descripcion}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">UM: {articulo.und}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setArticulo(null)} className="shrink-0 text-xs">
              Cambiar
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="text-[11px] font-bold text-slate-500">Cantidad *</label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="0"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500">Referencia (opcional)</label>
              <Input
                placeholder="OC, nota, solicito…"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {errorLocal && <p className="text-xs text-rose-600 font-semibold">{errorLocal}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancelar</Button>
        <Button
          onClick={registrar}
          disabled={busy || !articulo || !(cant > 0)}
          className="gap-2 bg-emerald-600 hover:bg-emerald-700"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
          Ingresar a lonchera {lado}
        </Button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   FORMULARIO SALIDA — artículo de la lonchera + cantidad
   ═══════════════════════════════════════════════════════════════════ */

function FormSalida({
  items,
  loncheraId,
  lado,
  codigoUbicacion,
  itemInicial,
  busy,
  setBusy,
  onExito,
  onError,
  onCancel,
}: {
  items: RepStockDeLonchera[]
  loncheraId: string
  lado: 'A' | 'B'
  codigoUbicacion: string
  /** Artículo preseleccionado (viene del botón de su fila en VER). */
  itemInicial?: RepStockDeLonchera | null
  busy: boolean
  setBusy: (v: boolean) => void
  onExito: (mensaje: string) => void
  onError: (err: unknown) => void
  onCancel: () => void
}) {
  const [itemSel, setItemSel] = useState<RepStockDeLonchera | null>(itemInicial ?? null)
  const [cantidad, setCantidad] = useState('')
  const [referencia, setReferencia] = useState('')
  const [errorLocal, setErrorLocal] = useState('')

  const cant = aNumero(cantidad)
  const excede = itemSel ? cant > itemSel.cantidad : false

  async function registrar() {
    setErrorLocal('')
    if (!itemSel) { setErrorLocal('Elige el artículo a retirar'); return }
    if (!(cant > 0)) { setErrorLocal('Ingresa una cantidad mayor que cero'); return }
    if (excede) { setErrorLocal(`Solo hay ${itemSel.cantidad} ${itemSel.und} en la lonchera`); return }
    setBusy(true)
    try {
      const r = await repRegistrarSalida({
        articuloId: itemSel.articuloId,
        loncheraId,
        cantidad: cant,
        referencia: referencia.trim() || undefined,
      })
      await onExito(`Salida de ${itemSel.codigo} desde ${r.ubicacion} lado ${r.lado} — queda ${r.restante}`)
      setItemSel(null); setCantidad(''); setReferencia('')
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-6">La lonchera {lado} está vacía: nada que retirar.</p>
      ) : !itemSel ? (
        <>
          <p className="text-xs font-bold text-slate-500">Elige el artículo a retirar de {codigoUbicacion} (lonchera {lado}):</p>
          <div className="rounded-lg border divide-y max-h-56 overflow-y-auto">
            {items.map((s) => (
              <button
                key={s.stockId}
                onClick={() => { setItemSel(s); setCantidad('') }}
                disabled={s.enTransito}
                className="w-full text-left px-3 py-2 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <span className="font-mono text-xs font-bold text-slate-800 shrink-0">{s.codigo}</span>
                <span className="text-xs text-slate-500 truncate flex-1">{s.descripcion}</span>
                {s.enTransito && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200 shrink-0">Tránsito</Badge>
                )}
                <span className="text-xs font-bold text-slate-900 shrink-0">{s.cantidad.toLocaleString('es-PE')} {s.und}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-sm font-bold text-slate-800">{itemSel.codigo}</p>
              <p className="text-xs text-slate-600 truncate" title={itemSel.descripcion}>{itemSel.descripcion}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Disponible: <b>{itemSel.cantidad.toLocaleString('es-PE')} {itemSel.und}</b></p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setItemSel(null)} className="shrink-0 text-xs">Cambiar</Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="text-[11px] font-bold text-slate-500">Cantidad a retirar *</label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="0"
                  value={cantidad}
                  onChange={(e) => setCantidad(e.target.value)}
                />
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setCantidad(String(itemSel.cantidad))}
                  className="shrink-0 text-xs"
                  title="Retirar todo el stock"
                >
                  Todo
                </Button>
              </div>
              {excede && <p className="text-[10px] text-rose-600 mt-1">Excede el disponible ({itemSel.cantidad}).</p>}
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500">Referencia (opcional)</label>
              <Input
                placeholder="RQ, vale, destino…"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {errorLocal && <p className="text-xs text-rose-600 font-semibold">{errorLocal}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancelar</Button>
        <Button
          onClick={registrar}
          disabled={busy || !itemSel || !(cant > 0) || excede}
          className="gap-2 bg-rose-600 hover:bg-rose-700"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
          Registrar salida
        </Button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   FORMULARIO TRASLADO — artículo + posición destino (A/B del destino)
   ═══════════════════════════════════════════════════════════════════ */

function FormTraslado({
  items,
  loncheraOrigenId,
  ladoOrigen,
  ubicaciones,
  loncherasMap,
  itemInicial,
  busy,
  setBusy,
  onExito,
  onError,
  onCancel,
}: {
  items: RepStockDeLonchera[]
  loncheraOrigenId: string
  ladoOrigen: 'A' | 'B'
  /** Ya SIN la ubicación de origen. */
  ubicaciones: RepUbicacion[]
  loncherasMap: Map<string, RepLonchera>
  /** Artículo preseleccionado (viene del botón de su fila en VER). */
  itemInicial?: RepStockDeLonchera | null
  busy: boolean
  setBusy: (v: boolean) => void
  onExito: (mensaje: string) => void
  onError: (err: unknown) => void
  onCancel: () => void
}) {
  const [itemSel, setItemSel] = useState<RepStockDeLonchera | null>(itemInicial ?? null)
  const [cantidad, setCantidad] = useState('')
  const [referencia, setReferencia] = useState('')
  const [destinoId, setDestinoId] = useState('')
  const [ladoDestino, setLadoDestino] = useState<'A' | 'B'>('A')
  const [errorLocal, setErrorLocal] = useState('')

  const destino = useMemo(() => ubicaciones.find((u) => u.id === destinoId) ?? null, [ubicaciones, destinoId])
  const ladosDestino = useMemo(() => (destino ? repLadosDeTipo(destino.tipo) : ['A' as const]), [destino])

  // Al cambiar la ubicación destino, resetea el lado si deja de existir
  useEffect(() => {
    if (destino && !ladosDestino.includes(ladoDestino)) setLadoDestino(ladosDestino[0])
  }, [destino, ladosDestino, ladoDestino])

  const loncheraDestino = useMemo(
    () => (destino ? Array.from(loncherasMap.values()).find((l) => l.ubicacion_id === destino.id && l.lado === ladoDestino) ?? null : null),
    [destino, ladoDestino, loncherasMap]
  )

  const cant = aNumero(cantidad)
  const excede = itemSel ? cant > itemSel.cantidad : false

  async function registrar() {
    setErrorLocal('')
    if (!itemSel) { setErrorLocal('Elige el artículo a trasladar'); return }
    if (!(cant > 0)) { setErrorLocal('Ingresa una cantidad mayor que cero'); return }
    if (excede) { setErrorLocal(`Solo hay ${itemSel.cantidad} ${itemSel.und} en la lonchera`); return }
    if (!destino || !loncheraDestino) { setErrorLocal('Elige la posición destino'); return }
    setBusy(true)
    try {
      const r = await repRegistrarTraslado({
        articuloId: itemSel.articuloId,
        loncheraOrigenId,
        loncheraDestinoId: loncheraDestino.id,
        cantidad: cant,
        referencia: referencia.trim() || undefined,
      })
      await onExito(`Traslado de ${itemSel.codigo}: ${r.origen} → ${r.destino} lado ${r.ladoDestino}`)
      setItemSel(null); setCantidad(''); setReferencia(''); setDestinoId('')
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {!itemSel ? (
        items.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">La lonchera {ladoOrigen} está vacía: nada que trasladar.</p>
        ) : (
          <>
            <p className="text-xs font-bold text-slate-500">Elige el artículo a trasladar (lonchera {ladoOrigen}):</p>
            <div className="rounded-lg border divide-y max-h-56 overflow-y-auto">
              {items.map((s) => (
                <button
                  key={s.stockId}
                  onClick={() => { setItemSel(s); setCantidad('') }}
                  disabled={s.enTransito}
                  className="w-full text-left px-3 py-2 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <span className="font-mono text-xs font-bold text-slate-800 shrink-0">{s.codigo}</span>
                  <span className="text-xs text-slate-500 truncate flex-1">{s.descripcion}</span>
                  {s.enTransito && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200 shrink-0">Tránsito</Badge>
                  )}
                  <span className="text-xs font-bold text-slate-900 shrink-0">{s.cantidad.toLocaleString('es-PE')} {s.und}</span>
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-sm font-bold text-slate-800">{itemSel.codigo}</p>
              <p className="text-xs text-slate-600 truncate" title={itemSel.descripcion}>{itemSel.descripcion}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Disponible: <b>{itemSel.cantidad.toLocaleString('es-PE')} {itemSel.und}</b></p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setItemSel(null)} className="shrink-0 text-xs">Cambiar</Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="text-[11px] font-bold text-slate-500">Cantidad a trasladar *</label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="0"
                  value={cantidad}
                  onChange={(e) => setCantidad(e.target.value)}
                />
                <Button variant="outline" type="button" onClick={() => setCantidad(String(itemSel.cantidad))} className="shrink-0 text-xs" title="Trasladar todo">
                  Todo
                </Button>
              </div>
              {excede && <p className="text-[10px] text-rose-600 mt-1">Excede el disponible ({itemSel.cantidad}).</p>}
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500">Referencia (opcional)</label>
              <Input placeholder="Motivo, nota…" value={referencia} onChange={(e) => setReferencia(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-500">Posición destino *</label>
            <SelectorUbicacionRep
              ubicaciones={ubicaciones}
              value={destinoId}
              onChange={setDestinoId}
            />
            {destino && (
              <p className="text-[10px] text-slate-400 mt-1">
                {destino.sector === 'racks'
                  ? `Rack R${String(destino.rack).padStart(2, '0')} · N${destino.nivel}`
                  : destino.zona}
              </p>
            )}
          </div>

          {ladosDestino.length > 1 && (
            <div>
              <label className="text-[11px] font-bold text-slate-500">Lonchera destino</label>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden w-fit">
                {ladosDestino.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLadoDestino(l)}
                    className={`px-3 py-1 text-xs font-bold transition-colors ${
                      ladoDestino === l ? 'bg-sky-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Lonchera {l}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {errorLocal && <p className="text-xs text-rose-600 font-semibold">{errorLocal}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancelar</Button>
        <Button
          onClick={registrar}
          disabled={busy || !itemSel || !(cant > 0) || excede || !destino || !loncheraDestino}
          className="gap-2 bg-sky-600 hover:bg-sky-700"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
          Trasladar
        </Button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   HISTORIAL — kardex de la ubicación (origen o destino)
   ═══════════════════════════════════════════════════════════════════ */

function PanelHistorial({
  ubicacionId,
  ubicaciones,
}: {
  ubicacionId: string
  ubicaciones: RepUbicacion[]
}) {
  const [movs, setMovs] = useState<RepMovimiento[] | null>(null)
  const [error, setError] = useState('')

  const codigosUbi = useMemo(() => new Map(ubicaciones.map((u) => [u.id, u.codigo])), [ubicaciones])

  useEffect(() => {
    let vivo = true
    // Sin setState síncrono en el cuerpo: movs inicia en null (cargando) y
    // este dialog se remonta por posición (key del padre), así que no hay
    // estado viejo que limpiar.
    repMovimientosDeUbicacion(ubicacionId)
      .then((filas) => { if (vivo) setMovs(filas) })
      .catch((err) => { if (vivo) setError(mensajeError(err)) })
    return () => { vivo = false }
  }, [ubicacionId])

  return (
    <div className="space-y-2">
      {movs === null && !error && (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Cargando historial…
        </div>
      )}
      {error && <p className="text-xs text-rose-600 text-center py-4">{error}</p>}
      {movs !== null && movs.length === 0 && (
        <p className="text-xs text-slate-400 text-center py-6 flex flex-col items-center gap-1.5">
          <Clock className="h-6 w-6 text-slate-300" />
          Sin movimientos registrados para esta posición.
        </p>
      )}
      {movs !== null && movs.length > 0 && (
        <ul className="space-y-1.5 max-h-72 overflow-y-auto">
          {movs.map((m) => {
            const esOrigen = m.origen_ubicacion_id === ubicacionId
            const otraId = esOrigen ? m.destino_ubicacion_id : m.origen_ubicacion_id
            const otra = otraId ? codigosUbi.get(otraId) ?? '¿?' : null
            return (
              <li key={m.id} className="rounded-lg border p-2.5 flex items-center gap-2 text-xs">
                <div className="shrink-0 text-[10px] text-slate-400 w-[110px] leading-tight">
                  {formatDateTime(m.created_at)}
                </div>
                <Badge variant="outline" className={`${CLASE_TIPO[m.tipo]} text-[9px] font-semibold shrink-0`}>
                  {REP_ETIQUETA_MOV[m.tipo]}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-bold text-slate-700">
                    {m.codigo}
                    <span className="ml-1.5 text-slate-900">{Number(m.cantidad).toLocaleString('es-PE')} {m.und}</span>
                  </p>
                  <p className="text-slate-500 truncate" title={m.descripcion}>
                    {otra ? (m.tipo === 'traslado' ? (esOrigen ? `→ ${otra}` : `${otra} →`) : m.descripcion) : m.descripcion}
                  </p>
                </div>
                <span className="text-[10px] text-slate-400 shrink-0 truncate max-w-[90px]" title={m.usuario_nombre}>
                  {m.usuario_nombre || '—'}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
