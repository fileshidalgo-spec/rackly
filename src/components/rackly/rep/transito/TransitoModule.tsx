'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Tránsito.
 *
 * DOS COLAS DE TRABAJO (pestañas):
 *
 *  1 · POR UBICAR (2026-11-11, paridad Insumos): las líneas que Recepción
 *      guardó SIN destino (rep_recepcion_lineas.estado='en_transito',
 *      agrupadas por guía). Aquí SE DECIDE a qué lonchera va cada artículo:
 *      «Ubicar» → RPC atómica rep_ubicar_desde_transito que en UNA
 *      transacción valida capacidad (15 artículos distintos), hace upsert
 *      de rep_stock, escribe el kardex 'ingreso' con el documento
 *      (guía/OC/DAM/proveedor) y marca la línea como ubicada. Antes de
 *      ubicar la mercadería NO tiene stock ni kardex: vive solo en el
 *      documento de recepción.
 *
 *  2 · DESPACHO RAL: el estacionamiento del día — los artículos pickeados
 *      en Atención viven aquí (pre-picking, stock con ral_id) hasta el
 *      despacho del día siguiente.
 *
 *      · DESPACHAR RAL  → rep_despachar_ral: salida física de TODA la carga,
 *        kardex 'salida' por artículo y estado despachado (documento
 *        intocable).
 *      · DEVOLVER línea → rep_devolver_linea: un artículo regresa a su
 *        lonchera de origen (kardex 'devolucion') — el RAL sigue
 *        registrado.
 *
 * Solo se despacha un RAL con carga estacionada (la RPC lo valida).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repListarRals,
  repDetalleDeRal,
  repTransitoDeRal,
  repDespacharRal,
  repDevolverLinea,
  repLineasEnTransito,
  repUbicarDesdeTransito,
  repListarUbicaciones,
  repListarLoncheras,
  type RepRal,
  type RepUbicacion,
  type RepLonchera,
  type RepLineaConDocumento,
} from '@/lib/rackly/rep/rep-client'
import { mensajeError } from '@/lib/rackly/errores'
import { REP_CLASE_ESTADO_RAL, REP_ETIQUETA_ESTADO_RAL, repLadosDeTipo } from '@/lib/rackly/rep/rep-tipos'
import { SelectorUbicacionRep } from '@/components/rackly/rep/ubicaciones/SelectorUbicacionRep'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Truck,
  Loader2,
  RefreshCw,
  Undo2,
  PackageCheck,
  PackageOpen,
  MapPin,
} from 'lucide-react'

type Linea = { id: string; articulo_id: string; cantidad: number; codigo: string; descripcion: string; und: string }
type VistaRal = {
  ral: RepRal
  lineas: Linea[]
  /** articuloId → cantidad estacionada en pre-picking */
  transito: Map<string, number>
}

/** Grupo de líneas «por ubicar» bajo el MISMO documento de recepción. */
type GuiaPorUbicar = {
  recepcionId: string
  guia: string
  oc: string
  dam: string
  fecha: string
  lineas: RepLineaConDocumento[]
}

export function TransitoModule() {
  const { perfil } = useAuth()
  const puedeOperar = puede(perfil, 'repuestos.crear')

  const [pestaña, setPestaña] = useState<'ubicar' | 'ral'>('ubicar')

  // ── 1 · Por ubicar ──
  const [pendientes, setPendientes] = useState<GuiaPorUbicar[]>([])
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [loncheras, setLoncheras] = useState<RepLonchera[]>([])
  const [loadingUbi, setLoadingUbi] = useState(true)
  const [ubicando, setUbicando] = useState('')
  const [cargandoLista, setCargandoLista] = useState(true)
  const genUbiRef = useRef(0)

  // ── 2 · Despacho RAL ──
  const [filtroEstado, setFiltroEstado] = useState<'registrado' | 'despachado'>('registrado')
  const [vista, setVista] = useState<VistaRal[]>([])
  const [loading, setLoading] = useState(true)
  const [despachando, setDespachando] = useState<string | null>(null)
  const [devolviendo, setDevolviendo] = useState<string | null>(null)
  const genRef = useRef(0)

  // ── Selección de destino POR LÍNEA (lineaId → {ubicacionId, lado}) ──
  const [destinoLinea, setDestinoLinea] = useState<Map<string, { ubicacionId: string; lado: 'A' | 'B' }>>(new Map())

  const cargarPendientes = useCallback(async () => {
    const gen = ++genUbiRef.current
    setCargandoLista(true)
    try {
      const [lineas, ubs, lons] = await Promise.all([
        repLineasEnTransito(300),
        repListarUbicaciones(),
        repListarLoncheras(),
      ])
      if (gen !== genUbiRef.current) return
      setUbicaciones(ubs)
      setLoncheras(lons)
      // Agrupar por recepción conservando el orden (más vieja primero)
      const grupos = new Map<string, GuiaPorUbicar>()
      for (const l of lineas) {
        let g = grupos.get(l.recepcion_id)
        if (!g) {
          g = {
            recepcionId: l.recepcion_id,
            guia: l.guia,
            oc: l.oc,
            dam: l.dam,
            fecha: l.fechaRecepcion,
            lineas: [],
          }
          grupos.set(l.recepcion_id, g)
        }
        g.lineas.push(l)
      }
      setPendientes([...grupos.values()])
      // Prerrellenar el destino de cada línea: primer lado disponible de la
      // primera ubicación activa (el operario lo cambia; nunca un valor roto).
      const pre = new Map<string, { ubicacionId: string; lado: 'A' | 'B' }>()
      for (const l of lineas) {
        const u = ubs.find((x) => x.activo)
        const lonsU = lons.filter((x) => x.ubicacion_id === u?.id)
        const lado = lonsU.some((x) => x.lado === 'A') ? 'A' : lonsU[0]?.lado ?? 'A'
        if (u) pre.set(l.id, { ubicacionId: u.id, lado })
      }
      setDestinoLinea(pre)
    } catch (err: unknown) {
      if (gen !== genUbiRef.current) return
      toast.error('Error al cargar lo recibido', { description: mensajeError(err) })
    } finally {
      if (gen === genUbiRef.current) setCargandoLista(false)
    }
  }, [])

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    try {
      const res = await repListarRals({ estado: filtroEstado, page: 1, pageSize: 100 })
      if (gen !== genRef.current) return
      // Para RALs registrados carga líneas + tránsito en paralelo (por RAL)
      const conDetalle = await Promise.all(
        res.filas.map(async (ral) => {
          try {
            const [lineas, tr] = await Promise.all([repDetalleDeRal(ral.id), repTransitoDeRal(ral.id)])
            return { ral, lineas, transito: new Map(tr.map((t) => [t.articuloId, t.cantidad])) }
          } catch {
            return { ral, lineas: [] as Linea[], transito: new Map<string, number>() }
          }
        })
      )
      if (gen !== genRef.current) return
      // Los que tienen carga estacionada primero (los que toca despachar hoy)
      conDetalle.sort((a, b) => {
        const ta = Array.from(a.transito.values()).reduce((s, n) => s + n, 0)
        const tb = Array.from(b.transito.values()).reduce((s, n) => s + n, 0)
        if (ta > 0 !== tb > 0) return ta > 0 ? -1 : 1
        return a.ral.created_at.localeCompare(b.ral.created_at)
      })
      setVista(conDetalle)
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      toast.error('Error al cargar Tránsito', { description: mensajeError(err) })
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [filtroEstado])

  useEffect(() => {
    cargarPendientes()
  }, [cargarPendientes])

  useEffect(() => {
    if (pestaña === 'ral') cargar()
  }, [pestaña, cargar])

  /** Lonchera destino de una línea según su selector (o null si incompleto). */
  function loncheraDe(lineaId: string): RepLonchera | null {
    const d = destinoLinea.get(lineaId)
    if (!d) return null
    const lons = loncheras.filter((l) => l.ubicacion_id === d.ubicacionId)
    if (lons.length === 0) return null
    return lons.find((l) => l.lado === d.lado) ?? lons[0]
  }

  function fijarDestino(lineaId: string, parche: Partial<{ ubicacionId: string; lado: 'A' | 'B' }>) {
    setDestinoLinea((prev) => {
      const actual = prev.get(lineaId) ?? { ubicacionId: '', lado: 'A' as const }
      const nuevo = { ...actual, ...parche }
      // Mantén el lado solo si la nueva ubicación lo tiene; si no, cae al
      // primero disponible (evita pre-chequeos cruzados).
      if (parche.ubicacionId) {
        const lons = loncheras.filter((l) => l.ubicacion_id === parche.ubicacionId)
        if (lons.length > 0 && !lons.some((l) => l.lado === nuevo.lado)) {
          nuevo.lado = lons[0].lado
        }
      }
      const sig = new Map(prev)
      sig.set(lineaId, nuevo)
      return sig
    })
  }

  /** UBICA la línea: stock + kardex + estado (RPC atómica). */
  async function ubicar(g: GuiaPorUbicar, linea: RepLineaConDocumento) {
    const lon = loncheraDe(linea.id)
    if (!lon) {
      toast.error('Elige la ubicación de destino')
      return
    }
    setUbicando(linea.id)
    try {
      const r = await repUbicarDesdeTransito({ lineaId: linea.id, loncheraId: lon.id })
      toast.success(`${linea.codigo} ubicado en ${r.ubicacion} · lado ${r.lado}`, {
        description: 'Stock y kardex de ingreso registrados con el documento de la guía.',
      })
      if (r.enOtraLonchera) {
        toast.warning(`${linea.codigo} ya vivía en ${r.enOtraLonchera.ubicacion} lado ${r.enOtraLonchera.lado}`, {
          description: 'Excepción controlada: el ingreso se registró igual. Revísalo en el mapa.',
          duration: 10000,
        })
      }
      cargarPendientes()
    } catch (err: unknown) {
      toast.error(`No se pudo ubicar ${linea.codigo}`, { description: mensajeError(err) })
    } finally {
      setUbicando('')
    }
  }

  async function despachar(v: VistaRal) {
    const total = Array.from(v.transito.values()).reduce((s, n) => s + n, 0)
    if (
      !confirm(
        `Despachar el RAL ${v.ral.numero}: ${v.transito.size} artículo(s), ${total.toLocaleString('es-PE')} unidades salen físicamente.\n\nEl RAL queda DESPACHADO (intocable) y se registra la salida en el kardex. ¿Continuar?`
      )
    ) return
    setDespachando(v.ral.id)
    try {
      const r = await repDespacharRal(v.ral.id)
      toast.success(`RAL ${v.ral.numero} despachado`, {
        description: `${r.lineas} artículo(s) · ${r.cantidad.toLocaleString('es-PE')} unidades — salida registrada en el kardex.`,
        duration: 9000,
      })
      cargar()
    } catch (err: unknown) {
      toast.error('No se pudo despachar', { description: mensajeError(err) })
    } finally {
      setDespachando(null)
    }
  }

  async function devolver(v: VistaRal, l: Linea) {
    if (!confirm(`¿Devolver ${l.codigo} a su lonchera de origen?`)) return
    setDevolviendo(l.id)
    try {
      const r = await repDevolverLinea(l.id)
      toast.success(`${l.codigo} devuelto a ${r.destino}`)
      cargar()
    } catch (err: unknown) {
      toast.error('No se pudo devolver', { description: mensajeError(err) })
    } finally {
      setDevolviendo(null)
    }
  }

  const totalPendientes = useMemo(() => pendientes.reduce((s, g) => s + g.lineas.length, 0), [pendientes])

  return (
    <div className="space-y-4">
      {/* ── Pestañas del módulo ── */}
      <div className="flex items-center gap-1 bg-white/70 border rounded-lg p-1 w-fit">
        <button
          onClick={() => setPestaña('ubicar')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
            pestaña === 'ubicar'
              ? 'bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <MapPin className="h-3.5 w-3.5" />
          Por ubicar {totalPendientes > 0 && `(${totalPendientes})`}
        </button>
        <button
          onClick={() => setPestaña('ral')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
            pestaña === 'ral'
              ? 'bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <Truck className="h-3.5 w-3.5" />
          Despacho RAL
        </button>
      </div>

      {/* ═══ 1 · POR UBICAR (recepciones sin destino) ═══ */}
      {pestaña === 'ubicar' && (
        <div className="rounded-xl border bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={cargarPendientes} variant="outline" size="sm" className="gap-2" disabled={cargandoLista}>
              {cargandoLista ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Actualizar
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            Lo que Recepción recibió, esperando su lugar. Elige la lonchera de cada artículo y pulsa{' '}
            <b>Ubicar</b>: ahí se registran el stock y el kardex de ingreso con la guía.
          </p>

          {cargandoLista && pendientes.length === 0 && (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando…
            </div>
          )}

          {!cargandoLista && pendientes.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <PackageOpen className="h-10 w-10 mx-auto mb-3 text-slate-300" />
              <p className="text-sm font-semibold text-slate-500">Nada pendiente de ubicar</p>
              <p className="text-xs mt-1">Las recepciones nuevas aparecen aquí agrupadas por su guía.</p>
            </div>
          )}

          <div className="space-y-3">
            {pendientes.map((g) => (
              <div key={g.recepcionId} className="rounded-xl border border-amber-200 bg-amber-50/30 p-3 space-y-2">
                {/* Cabecera del documento */}
                <div className="flex flex-wrap items-center gap-2">
                  <Truck className="h-4 w-4 text-amber-600" />
                  <span className="font-mono font-extrabold text-sm text-slate-900">{g.guia}</span>
                  {(g.oc || g.dam) && (
                    <span className="text-[10px] font-mono text-slate-500">
                      {g.oc && <>OC {g.oc}</>}{g.oc && g.dam && ' · '}{g.dam && <>DAM {g.dam}</>}
                    </span>
                  )}
                  <span className="text-xs text-slate-500">
                    {new Date(g.fecha).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' })}
                  </span>
                  <Badge variant="outline" className="text-[10px] bg-white">
                    {g.lineas.length} artículo(s)
                  </Badge>
                </div>

                {/* Líneas con destino editable */}
                <ul className="space-y-1.5">
                  {g.lineas.map((l) => {
                    const d = destinoLinea.get(l.id)
                    const lons = loncheras.filter((x) => x.ubicacion_id === d?.ubicacionId)
                    const ubi = ubicaciones.find((u) => u.id === d?.ubicacionId)
                    const lados = ubi ? repLadosDeTipo(ubi.tipo) : ['A']
                    const lonElegida = loncheraDe(l.id)
                    return (
                      <li key={l.id} className="rounded-lg border bg-white px-2.5 py-2 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-extrabold text-sm text-slate-900 shrink-0">{l.codigo}</span>
                          <span className="text-slate-500 truncate flex-1 min-w-[120px]" title={l.descripcion}>{l.descripcion}</span>
                          {l.proveedor && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 bg-slate-50 text-slate-600 shrink-0" title="Proveedor de la línea">
                              {l.proveedor}
                            </Badge>
                          )}
                          <span className="font-bold text-slate-900 shrink-0">
                            {l.cantidad.toLocaleString('es-PE')} {l.und}
                          </span>
                        </div>
                        {puedeOperar && (
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Selector con búsqueda: el layout canónico tiene
                                1 869 posiciones — un <Select> plano es inusable */}
                            <SelectorUbicacionRep
                              ubicaciones={ubicaciones}
                              value={d?.ubicacionId ?? ''}
                              onChange={(v) => fijarDestino(l.id, { ubicacionId: v })}
                              disabled={ubicando === l.id}
                            />
                            {lons.length > 1 && (
                              <Select
                                value={d?.lado ?? 'A'}
                                onValueChange={(v) => fijarDestino(l.id, { lado: v as 'A' | 'B' })}
                                disabled={ubicando === l.id}
                              >
                                <SelectTrigger className="h-8 w-[92px] text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {lados.map((lado) => (
                                    <SelectItem key={lado} value={lado}>Lado {lado}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            <Button
                              onClick={() => ubicar(g, l)}
                              size="sm"
                              disabled={!lonElegida || ubicando === l.id}
                              className="gap-1.5 h-8"
                            >
                              {ubicando === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                              Ubicar
                            </Button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 2 · DESPACHO RAL (estacionamiento pre-picking) ═══ */}
      {pestaña === 'ral' && (
        <div className="rounded-xl border bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={filtroEstado} onValueChange={(v) => setFiltroEstado(v as typeof filtroEstado)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="registrado">En tránsito (registrados)</SelectItem>
                <SelectItem value="despachado">Historial (despachados)</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={cargar} variant="outline" size="sm" className="gap-2" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Actualizar
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            Carga estacionada en pre-picking esperando la salida del día siguiente. Devolver regresa el
            artículo a su lonchera; despachar registra la salida definitiva.
          </p>

          {loading && vista.length === 0 && (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando…
            </div>
          )}

          {!loading && vista.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <PackageOpen className="h-10 w-10 mx-auto mb-3 text-slate-300" />
              <p className="text-sm font-semibold text-slate-500">
                {filtroEstado === 'registrado' ? 'Nada estacionado en pre-picking' : 'Aún no hay despachos'}
              </p>
              <p className="text-xs mt-1">
                {filtroEstado === 'registrado'
                  ? 'Los RALs pickeados en Atención aparecen aquí para su despacho.'
                  : 'Los RALs despachados se archivan aquí.'}
              </p>
            </div>
          )}

          <div className="space-y-3">
            {vista.map((v) => {
              const conCarga = Array.from(v.transito.values()).reduce((s, n) => s + n, 0) > 0
              const pendienteDespacho = filtroEstado === 'registrado' && conCarga
              return (
                <div
                  key={v.ral.id}
                  className={`rounded-xl border p-3 space-y-2 ${pendienteDespacho ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'}`}
                >
                  {/* Cabecera del RAL */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Truck className={`h-4 w-4 ${pendienteDespacho ? 'text-amber-600' : 'text-slate-400'}`} />
                    <span className="font-mono font-extrabold text-sm text-slate-900">{v.ral.numero}</span>
                    <Badge variant="outline" className={`${REP_CLASE_ESTADO_RAL[v.ral.estado]} text-[10px] font-semibold`}>
                      {REP_ETIQUETA_ESTADO_RAL[v.ral.estado]}
                    </Badge>
                    <span className="text-xs text-slate-500">{v.ral.fecha} · {v.ral.solicitante || 'sin solicitante'}</span>
                    {pendienteDespacho && puedeOperar && (
                      <Button
                        onClick={() => despachar(v)}
                        size="sm"
                        disabled={despachando === v.ral.id}
                        className="gap-1.5 ml-auto"
                      >
                        {despachando === v.ral.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                        Despachar RAL
                      </Button>
                    )}
                  </div>

                  {/* Líneas */}
                  {v.lineas.length === 0 ? (
                    <p className="text-xs text-slate-400">Sin líneas registradas.</p>
                  ) : (
                    <ul className="space-y-1">
                      {v.lineas.map((l) => {
                        const enT = v.transito.has(l.articulo_id)
                        return (
                          <li
                            key={l.id}
                            className={`flex items-center gap-2 text-xs border-b border-slate-100 pb-1 last:border-0 ${enT ? '' : 'opacity-60'}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${enT ? 'bg-amber-500' : 'bg-slate-300'}`} />
                            <span className="font-mono font-bold text-slate-700 shrink-0">{l.codigo}</span>
                            <span className="text-slate-500 truncate flex-1" title={l.descripcion}>{l.descripcion}</span>
                            <span className="font-bold text-slate-900 shrink-0">
                              {l.cantidad.toLocaleString('es-PE')} {l.und}
                            </span>
                            {enT ? (
                              <>
                                <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                                  En pre-picking
                                </Badge>
                                {filtroEstado === 'registrado' && puedeOperar && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => devolver(v, l)}
                                    disabled={devolviendo === l.id}
                                    className="gap-1 h-6 px-1.5 text-[10px] shrink-0"
                                    title="Devolver a su lonchera"
                                  >
                                    {devolviendo === l.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                                    Devolver
                                  </Button>
                                )}
                              </>
                            ) : (
                              <span className="text-[9px] text-slate-400 shrink-0">
                                {filtroEstado === 'registrado' ? 'devuelto/pendiente' : 'salida registrada'}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
