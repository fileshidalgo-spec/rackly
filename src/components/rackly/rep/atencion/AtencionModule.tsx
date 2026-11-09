'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Atención (RAL BIG MAGIC).
 *
 * Flujo acordado:
 *   1 · REGISTRO: se registra el Nº de RAL que salió de BIG MAGIC (la app
 *       NUNCA lo genera) con fecha y solicitante, y sus líneas
 *       (artículo + cantidad solicitada).
 *   2 · PICKING: cada línea se pickea — la RPC atómica rep_pickear_linea
 *       descuenta del ALMACÉN (loncheras) y estaciona en PRE-PICKING con
 *       el ral_id (eso es Tránsito). Si el stock no alcanzó, avisa el
 *       faltante (la BD jamás queda negativa).
 *
 * Estados derivados por línea: «En Tránsito» (hay fila de stock con
 * ral_id) · «Pendiente». Un RAL despachado/anulado es documento intocable.
 *
 * Puentes: consume target tipo 'ral' (aterriza con el RAL abierto) y
 * enlaza al mapa con la posición del artículo (stockDeArticulo → mapa).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repListarRals,
  repCrearRal,
  repDetalleDeRal,
  repAgregarDetalleRal,
  repEliminarDetalleRal,
  repArticuloPorCodigo,
  repPickearLinea,
  repAnularRal,
  repTransitoDeRal,
  repPrepickings,
  repStockDeArticulo,
  type RepRal,
} from '@/lib/rackly/rep/rep-client'
import { mensajeError } from '@/lib/rackly/errores'
import { aNumero, hoyISO } from '@/lib/rackly/formato'
import { REP_CLASE_ESTADO_RAL, REP_ETIQUETA_ESTADO_RAL } from '@/lib/rackly/rep/rep-tipos'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  HeartHandshake,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  PackageCheck,
  PackageOpen,
  ArrowLeft,
  MapPin,
  Ban,
  ClipboardList,
} from 'lucide-react'

type Linea = { id: string; articulo_id: string; cantidad: number; codigo: string; descripcion: string; und: string }
type TransitoFila = { articuloId: string; codigo: string; cantidad: number }

type Props = {
  target?: import('@/lib/rackly/rep/rep-navegacion').RepTarget | null
  onTargetConsumido?: () => void
  onVolverOrigen?: () => void
  /** Puente: ver en el mapa la posición de un artículo. */
  onVerEnMapa?: (ubicacionId: string, codigo: string) => void
}

export function AtencionModule({ target, onTargetConsumido, onVolverOrigen, onVerEnMapa }: Props) {
  const { perfil } = useAuth()
  const puedeCrear = puede(perfil, 'repuestos.crear')

  const [rals, setRals] = useState<RepRal[]>([])
  const [total, setTotal] = useState(0)
  const [filtroEstado, setFiltroEstado] = useState<'registrado' | 'despachado' | 'anulado' | 'todos'>('registrado')
  const [loading, setLoading] = useState(true)
  const [seleccionado, setSeleccionado] = useState<RepRal | null>(null)
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const genRef = useRef(0)

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    try {
      const res = await repListarRals({ estado: filtroEstado, page: 1, pageSize: 100 })
      if (gen !== genRef.current) return
      setRals(res.filas)
      setTotal(res.total)
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      toast.error('Error al cargar RALs', { description: mensajeError(err) })
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [filtroEstado])

  useEffect(() => {
    cargar()
  }, [cargar])

  // Deep-link: aterriza con el RAL abierto (desde Tránsito/Movimientos).
  // Tolerante al filtro activo: si el RAL no está en la lista (p. ej. está
  // despachado y el filtro es «Registrados»), amplía a «Todos» y reintenta;
  // si aun así no existe, consume el target para no dejarlo colgado.
  useEffect(() => {
    if (!target || target.tipo !== 'ral' || loading) return
    const r = rals.find((x) => x.id === target.ralId)
    if (r) {
      setSeleccionado(r)
      onTargetConsumido?.()
    } else if (filtroEstado !== 'todos') {
      setFiltroEstado('todos')
    } else {
      onTargetConsumido?.()
    }
  }, [target, loading, rals, filtroEstado])

  function abrirRal(r: RepRal) {
    setSeleccionado(r)
  }

  return (
    <div className="space-y-4">
      {!seleccionado ? (
        <div className="rounded-xl border bg-white p-4 space-y-4">
          {/* Barra: filtros + nuevo RAL */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={filtroEstado} onValueChange={(v) => setFiltroEstado(v as typeof filtroEstado)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="registrado">Registrados</SelectItem>
                <SelectItem value="despachado">Despachados</SelectItem>
                <SelectItem value="anulado">Anulados</SelectItem>
                <SelectItem value="todos">Todos</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={cargar} variant="outline" size="sm" className="gap-2" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Actualizar
            </Button>
            {puedeCrear && (
              <Button onClick={() => setNuevoOpen(true)} className="gap-2 ml-auto" size="sm">
                <Plus className="h-4 w-4" /> Registrar RAL
              </Button>
            )}
          </div>

          <p className="text-xs text-slate-500">
            <Badge variant="outline" className="font-semibold">{total} RAL(s)</Badge>{' '}
            {total > rals.length && (
              <span className="text-amber-700">Mostrando los primeros {rals.length} — afina el filtro de estado para ver el resto. </span>
            )}
            El número viene de BIG MAGIC: la app lo registra, no lo genera. El picking estaciona los
            artículos en pre-picking (Tránsito) para la salida del día siguiente.
          </p>

          {/* Lista de RALs */}
          <div className="rounded-lg border overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[130px]">Nº RAL</TableHead>
                  <TableHead className="w-[110px]">Fecha</TableHead>
                  <TableHead className="min-w-[180px]">Solicitante</TableHead>
                  <TableHead className="w-[120px]">Estado</TableHead>
                  <TableHead className="min-w-[120px]">Registró</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rals.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-slate-400 py-10">
                      <ClipboardList className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                      {filtroEstado === 'registrado' ? 'No hay RALs registrados. Usa «Registrar RAL».' : 'Sin RALs para este filtro.'}
                    </TableCell>
                  </TableRow>
                )}
                {rals.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => abrirRal(r)}
                  >
                    <TableCell className="font-mono text-xs font-extrabold text-sky-700">{r.numero}</TableCell>
                    <TableCell className="text-xs text-slate-500">{r.fecha}</TableCell>
                    <TableCell className="text-sm truncate max-w-[240px]" title={r.solicitante}>{r.solicitante || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`${REP_CLASE_ESTADO_RAL[r.estado]} text-[10px] font-semibold`}>
                        {REP_ETIQUETA_ESTADO_RAL[r.estado]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{r.usuario_nombre || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <DetalleRal
          ral={seleccionado}
          onVolver={() => setSeleccionado(null)}
          onChanged={() => cargar()}
          onVolverOrigen={onVolverOrigen}
          onVerEnMapa={onVerEnMapa}
        />
      )}

      <DialogoNuevoRal
        open={nuevoOpen}
        onOpenChange={setNuevoOpen}
        onCreado={(r) => {
          setNuevoOpen(false)
          cargar()
          setSeleccionado(r)
        }}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DETALLE DE UN RAL: líneas + picking
   ═══════════════════════════════════════════════════════════════════ */

function DetalleRal({
  ral,
  onVolver,
  onChanged,
  onVolverOrigen,
  onVerEnMapa,
}: {
  ral: RepRal
  onVolver: () => void
  onChanged: () => void
  onVolverOrigen?: () => void
  onVerEnMapa?: (ubicacionId: string, codigo: string) => void
}) {
  const { perfil } = useAuth()
  const puedeCrear = puede(perfil, 'repuestos.crear')

  const [lineas, setLineas] = useState<Linea[]>([])
  const [transito, setTransito] = useState<Map<string, number>>(new Map()) // articuloId → cantidad en tránsito
  const [loading, setLoading] = useState(true)
  const [codigoLinea, setCodigoLinea] = useState('')
  const [cantidadLinea, setCantidadLinea] = useState('')
  const [articuloLinea, setArticuloLinea] = useState<{ id: string; codigo: string; descripcion: string; und: string } | null>(null)
  const [buscando, setBuscando] = useState(false)
  const [agregando, setAgregando] = useState(false)
  const [pickeando, setPickeando] = useState<string | null>(null)
  const [pickOpen, setPickOpen] = useState<Linea | null>(null)
  const [prepickingElegido, setPrepickingElegido] = useState('')
  const [prepickingDestinos, setPrepickingDestinos] = useState<Array<{ loncheraId: string; codigo: string; nota: string }>>([])
  const [anulando, setAnulando] = useState(false)
  // Guard de generación para la búsqueda de líneas (respuestas tardías
  // de un código anterior nunca deben pintarse).
  const busquedaGenRef = useRef(0)

  const editable = ral.estado === 'registrado' && puedeCrear

  const cargarLineas = useCallback(async () => {
    setLoading(true)
    try {
      const [det, tr] = await Promise.all([repDetalleDeRal(ral.id), repTransitoDeRal(ral.id)])
      setLineas(det)
      setTransito(new Map(tr.map((t) => [t.articuloId, t.cantidad])))
    } catch (err: unknown) {
      toast.error('Error al cargar el RAL', { description: mensajeError(err) })
    } finally {
      setLoading(false)
    }
  }, [ral.id])

  useEffect(() => {
    cargarLineas()
  }, [cargarLineas])

  // Destinos de pre-picking (para el diálogo de picking)
  useEffect(() => {
    repPrepickings()
      .then((ps) => {
        setPrepickingDestinos(ps)
        if (ps.length > 0) setPrepickingElegido(ps[0].loncheraId)
      })
      .catch(() => setPrepickingDestinos([]))
  }, [])

  async function buscarArticulo() {
    if (!codigoLinea.trim()) return
    const gen = ++busquedaGenRef.current
    setBuscando(true)
    setArticuloLinea(null)
    try {
      const a = await repArticuloPorCodigo(codigoLinea)
      if (gen !== busquedaGenRef.current) return
      if (!a) {
        toast.warning(`El código ${codigoLinea.trim().toUpperCase()} no existe en el catálogo`)
        return
      }
      if (!a.activo) {
        toast.error('El artículo está inactivo en el catálogo')
        return
      }
      setArticuloLinea({ id: a.id, codigo: a.codigo, descripcion: a.descripcion, und: a.und })
    } catch (err: unknown) {
      toast.error('Error al buscar', { description: mensajeError(err) })
    } finally {
      if (gen === busquedaGenRef.current) setBuscando(false)
    }
  }

  async function agregarLinea() {
    if (!articuloLinea) return
    const cant = aNumero(cantidadLinea)
    if (!Number.isFinite(cant) || cant <= 0) {
      toast.error('La cantidad debe ser mayor que cero')
      return
    }
    if (lineas.some((l) => l.articulo_id === articuloLinea.id)) {
      toast.error('El artículo ya está en este RAL', { description: 'Elimina la línea y agrégala con la cantidad corregida.' })
      return
    }
    setAgregando(true)
    try {
      await repAgregarDetalleRal(ral.id, articuloLinea.id, cant)
      toast.success(`Línea agregada: ${articuloLinea.codigo} × ${cant}`)
      setArticuloLinea(null)
      setCodigoLinea('')
      setCantidadLinea('')
      cargarLineas()
    } catch (err: unknown) {
      toast.error('No se pudo agregar la línea', { description: mensajeError(err) })
    } finally {
      setAgregando(false)
    }
  }

  async function quitarLinea(l: Linea) {
    if (!confirm(`¿Quitar la línea ${l.codigo} del RAL?`)) return
    try {
      await repEliminarDetalleRal(l.id)
      toast.success('Línea quitada')
      cargarLineas()
    } catch (err: unknown) {
      toast.error('No se pudo quitar', { description: mensajeError(err) })
    }
  }

  async function pickear() {
    if (!pickOpen) return
    setPickeando(pickOpen.id)
    try {
      const res = await repPickearLinea(pickOpen.id, prepickingElegido || undefined)
      if (res.faltante > 0) {
        toast.warning(`Picking registrado en ${res.prepicking}`, {
          description: `Ojo: solo había ${res.tomadoDeAlmacen} en lonchera — faltó ${res.faltante} (quedó estacionado el total solicitado).`,
          duration: 12000,
        })
      } else {
        toast.success(`Pickeado → ${res.prepicking} (Tránsito)`)
      }
      setPickOpen(null)
      cargarLineas()
    } catch (err: unknown) {
      toast.error('No se pudo pickear', { description: mensajeError(err) })
    } finally {
      setPickeando(null)
    }
  }

  async function anular() {
    if (!confirm(`¿ANULAR el RAL ${ral.numero}? Queda como documento anulado (no se borra).`)) return
    setAnulando(true)
    try {
      await repAnularRal(ral.id)
      toast.success(`RAL ${ral.numero} anulado`)
      onChanged()
      onVolver()
    } catch (err: unknown) {
      toast.error('No se pudo anular', { description: mensajeError(err) })
    } finally {
      setAnulando(false)
    }
  }

  async function verEnMapa(l: Linea) {
    try {
      const st = await repStockDeArticulo(l.articulo_id)
      const enAlmacen = st.find((s) => !s.enTransito) ?? st[0]
      if (enAlmacen && onVerEnMapa) onVerEnMapa(enAlmacen.ubicacionId, enAlmacen.ubicacionCodigo)
      else toast.info('El artículo no tiene stock en ninguna ubicación')
    } catch (err: unknown) {
      toast.error('No se pudo ubicar', { description: mensajeError(err) })
    }
  }

  const enTransito = (l: Linea) => transito.has(l.articulo_id)
  const conTransito = Array.from(transito.values()).reduce((s, n) => s + n, 0) > 0

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* Cabecera */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onVolver} variant="ghost" size="sm" className="gap-2 font-semibold">
          <ArrowLeft className="h-4 w-4" /> RALs
        </Button>
        <Badge variant="outline" className={`${REP_CLASE_ESTADO_RAL[ral.estado]} font-bold`}>
          {REP_ETIQUETA_ESTADO_RAL[ral.estado]}
        </Badge>
        {editable && !conTransito && (
          <Button onClick={anular} variant="ghost" size="sm" className="gap-1.5 text-slate-500 hover:text-rose-600 ml-auto" disabled={anulando}>
            <Ban className="h-3.5 w-3.5" /> Anular RAL
          </Button>
        )}
      </div>

      <div className="rounded-lg bg-slate-50 border p-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span className="font-mono font-extrabold text-slate-900">RAL {ral.numero}</span>
        <span className="text-slate-500">Fecha: <strong className="text-slate-700">{ral.fecha}</strong></span>
        <span className="text-slate-500">Solicitante: <strong className="text-slate-700">{ral.solicitante || '—'}</strong></span>
        {onVolverOrigen && (
          <Button onClick={onVolverOrigen} variant="outline" size="sm" className="gap-1.5 ml-auto">
            Volver
          </Button>
        )}
      </div>

      {/* Alta de líneas (solo editable) */}
      {editable && (
        <div className="rounded-lg border border-dashed p-3 space-y-2">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Agregar artículo al RAL</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                className="pl-9 font-mono uppercase"
                placeholder="Código BIG MAGIC…"
                value={codigoLinea}
                onChange={(e) => setCodigoLinea(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') buscarArticulo() }}
              />
            </div>
            <Input
              className="sm:w-28"
              inputMode="decimal"
              placeholder="Cantidad"
              value={cantidadLinea}
              onChange={(e) => setCantidadLinea(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') agregarLinea() }}
            />
            <Button onClick={buscarArticulo} disabled={buscando || !codigoLinea.trim()} variant="outline" className="gap-2">
              {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
            <Button onClick={agregarLinea} disabled={!articuloLinea || agregando} className="gap-2">
              {agregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Agregar
            </Button>
          </div>
          {articuloLinea && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
              ✓ {articuloLinea.codigo} — {articuloLinea.descripcion} {articuloLinea.und && `(${articuloLinea.und})`}
            </p>
          )}
        </div>
      )}

      {/* Líneas */}
      <div className="rounded-lg border overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[130px]">Código</TableHead>
              <TableHead className="min-w-[200px]">Descripción</TableHead>
              <TableHead className="w-[90px] text-right">Cant.</TableHead>
              <TableHead className="w-[120px]">Estado</TableHead>
              {editable && <TableHead className="w-[200px] text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-slate-400" />
                </TableCell>
              </TableRow>
            )}
            {!loading && lineas.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-slate-400 py-10">
                  <PackageOpen className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  {editable ? 'Agrega artículos al RAL con el buscador de arriba.' : 'El RAL no tiene líneas.'}
                </TableCell>
              </TableRow>
            )}
            {lineas.map((l) => {
              const enT = enTransito(l)
              return (
                <TableRow key={l.id} className={enT ? 'bg-amber-50/40' : ''}>
                  <TableCell className="font-mono text-xs font-bold">{l.codigo}</TableCell>
                  <TableCell className="text-sm truncate max-w-[280px]" title={l.descripcion}>{l.descripcion}</TableCell>
                  <TableCell className="text-right text-sm font-semibold">
                    {l.cantidad.toLocaleString('es-PE')} {l.und && <span className="text-slate-400 text-xs font-normal">{l.und}</span>}
                  </TableCell>
                  <TableCell>
                    {enT ? (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] font-semibold">
                        En Tránsito
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 text-[10px]">
                        Pendiente
                      </Badge>
                    )}
                  </TableCell>
                  {editable && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" onClick={() => verEnMapa(l)} title="Ver en el mapa">
                          <MapPin className="h-4 w-4 text-slate-500" />
                        </Button>
                        {!enT && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={prepickingDestinos.length === 0}
                            title={prepickingDestinos.length === 0 ? 'No hay pre-picking: créalo en Ubicaciones' : 'Pickear a pre-picking'}
                            onClick={() => setPickOpen(l)}
                          >
                            <PackageCheck className="h-3.5 w-3.5" />
                            Pickear
                          </Button>
                        )}
                        {!enT && lineas.length > 0 && (
                          <Button size="icon" variant="ghost" onClick={() => quitarLinea(l)} title="Quitar línea">
                            <Trash2 className="h-4 w-4 text-rose-500" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {editable && prepickingDestinos.length === 0 && lineas.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          No hay ubicaciones de pre-picking: créalas en el módulo Ubicaciones (tipo «Pre-picking») para poder pickear.
        </p>
      )}

      {/* Diálogo de picking: destino pre-picking */}
      <Dialog open={!!pickOpen} onOpenChange={(open) => { if (!open) setPickOpen(null) }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pickear {pickOpen?.codigo}</DialogTitle>
            <DialogDescription>
              {pickOpen?.cantidad.toLocaleString('es-PE')} al estacionamiento pre-picking para la salida
              del RAL {ral.numero}. Se descuenta de su lonchera y se registra en el kardex.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>Destino (pre-picking)</Label>
            <Select value={prepickingElegido} onValueChange={setPrepickingElegido}>
              <SelectTrigger><SelectValue placeholder="Elige el pre-picking" /></SelectTrigger>
              <SelectContent>
                {prepickingDestinos.map((p) => (
                  <SelectItem key={p.loncheraId} value={p.loncheraId}>
                    <span className="font-mono">{p.codigo}</span>
                    {p.nota && <span className="text-slate-400 ml-1.5 text-xs">{p.nota}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickOpen(null)} disabled={!!pickeando}>Cancelar</Button>
            <Button onClick={pickear} disabled={!!pickeando || !prepickingElegido} className="gap-2">
              {pickeando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
              Pickear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DIÁLOGO NUEVO RAL (registro del número BIG MAGIC)
   ═══════════════════════════════════════════════════════════════════ */

function DialogoNuevoRal({
  open,
  onOpenChange,
  onCreado,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreado: (r: RepRal) => void
}) {
  const { perfil } = useAuth()
  // hoyISO(): fecha LOCAL (Lima) — toISOString() usaba UTC y después de las
  // 19:00 el RAL nacía con la fecha de "mañana" (regresión del fix P3 del
  // 2026-10-22 que este módulo había omitido).
  const hoy = hoyISO()
  const [numero, setNumero] = useState('')
  const [fecha, setFecha] = useState(hoy)
  const [solicitante, setSolicitante] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setNumero('')
      setFecha(hoy)
      setSolicitante('')
    }
     
  }, [open])

  async function crear() {
    if (!numero.trim()) {
      toast.error('El número de RAL es obligatorio (viene de BIG MAGIC)')
      return
    }
    setBusy(true)
    try {
      const r = await repCrearRal({
        numero: numero.trim(),
        fecha,
        solicitante: solicitante.trim(),
        usuarioId: perfil?.id ?? '',
        usuarioNombre: perfil?.nombre ?? '',
      })
      toast.success(`RAL ${r.numero} registrado`)
      onCreado(r)
    } catch (err: unknown) {
      toast.error('No se pudo registrar', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HeartHandshake className="h-5 w-5 text-teal-600" /> Registrar RAL
          </DialogTitle>
          <DialogDescription>
            Anota el número tal cual salió de BIG MAGIC. Luego agrega sus artículos y pickea.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ral-numero">Nº RAL (BIG MAGIC) *</Label>
            <Input id="ral-numero" className="font-mono uppercase" value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="RAL-2026-0142" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ral-fecha">Fecha</Label>
              <Input id="ral-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ral-solicitante">Solicitante</Label>
              <Input id="ral-solicitante" value={solicitante} onChange={(e) => setSolicitante(e.target.value)} placeholder="Área o persona" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={crear} disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
