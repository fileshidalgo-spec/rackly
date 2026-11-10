'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Ubicaciones (mapa del almacén).
 *
 * LAYOUT CANÓNICO (Excel «LAYOUT REPUESTOS», migración
 * 20261110_rep_ubicaciones_sectores — las posiciones ya NO se crean ni
 * borran desde la UI; el Excel es la fuente de verdad):
 *
 *   SECTOR RACKS (1 773 pos) · R01..R36 · nivel 0 = piso/bajo rack
 *     · Piso 1 (R01..R18): N0=1, N1=5, N2=17, N3=17, N4=5   → 810
 *     · Piso 2 (R19..R36): N1..N5 = 69/275/275/275/69       → 963
 *   SECTOR ZONAS (96 pos)
 *     · A, B, C, D (tercer piso, 16 c/u) · CONTENEDOR N° 3 (20)
 *     · PRE-PICKING (4) · RECEPCIÓN (8)
 *
 * UI: pestañas por sector. Racks en ESCENA 3D (estanterías isométricas con
 * cara superior y lateral CSS, celdas coloreadas por ocupación); zonas en
 * tarjetas con grilla de posiciones. El detalle de cada posición abre el
 * panel de loncheras (A/B) con su contenido real.
 *
 * Datos en 1 ronda (repMapaAlmacen, PAGINADA en servidor — Supabase
 * trunca a 1000 filas por request y el mapa tiene 1 869 ubicaciones y
 * 3 642 loncheras): ubicaciones + loncheras + ocupación agregada en BD.
 *
 * Puente (contrato rep-navegacion): consume target tipo 'ubicacion' con
 * onTargetConsumido (patrón targetPosicion de PisoSectoresTab) y ofrece
 * «Volver» al módulo de origen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  repMapaAlmacen,
  repStockDeLonchera,
  type RepOcupacionLonchera,
  type RepSector,
} from '@/lib/rackly/rep/rep-client'
import {
  REP_MAX_ARTICULOS_LONCHERA,
  REP_ORDEN_ZONAS,
  type RepUbicacion,
} from '@/lib/rackly/rep/rep-tipos'
import type { RepTarget } from '@/lib/rackly/rep/rep-navegacion'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  ArrowLeft,
  Boxes,
  LayoutGrid,
  Loader2,
  MapPin,
  PackageOpen,
  RefreshCw,
  Wrench,
} from 'lucide-react'

type Props = {
  /** Deep-link: aterriza con la ubicación enfocada (patrón targetPosicion). */
  target?: RepTarget | null
  onTargetConsumido?: () => void
  /** Botón «Volver a {origen}» dentro del detalle (el hub hace el salto). */
  onVolverOrigen?: () => void
}

/** Profundidad (px) de las caras 3D de cada estantería. */
const PROF = 12

/** Estado de ocupación de una POSICIÓN (agrega sus loncheras A/B). */
type EstadoPos = 'vacia' | 'stock' | 'transito' | 'llena'

const CELDA_ESTADO: Record<EstadoPos, string> = {
  vacia: 'bg-slate-200 hover:bg-slate-300',
  stock: 'bg-emerald-400 hover:bg-emerald-500',
  transito: 'bg-amber-400 hover:bg-amber-500',
  llena: 'bg-rose-500 hover:bg-rose-600',
}

const DOT_ESTADO: Record<EstadoPos, string> = {
  vacia: 'bg-slate-300',
  stock: 'bg-emerald-500',
  transito: 'bg-amber-400',
  llena: 'bg-rose-500',
}

const ETIQUETA_ESTADO: Record<EstadoPos, string> = {
  vacia: 'Vacía',
  stock: 'Con stock',
  transito: 'En tránsito',
  llena: 'Llena',
}

/** Acento visual por zona del sector 'zonas'. */
const ACENTO_ZONA: Record<string, string> = {
  A: 'border-amber-300 bg-amber-50/60 text-amber-900',
  B: 'border-amber-300 bg-amber-50/60 text-amber-900',
  C: 'border-amber-300 bg-amber-50/60 text-amber-900',
  D: 'border-amber-300 bg-amber-50/60 text-amber-900',
  'CONTENEDOR N° 3': 'border-sky-300 bg-sky-50/60 text-sky-900',
  'PRE-PICKING': 'border-rose-300 bg-rose-50/60 text-rose-900',
  RECEPCIÓN: 'border-emerald-300 bg-emerald-50/60 text-emerald-900',
}

/** Estado agregado de una posición a partir de la ocupación de sus loncheras. */
function estadoPosicion(
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>,
  ocupacion: Map<string, RepOcupacionLonchera>
): EstadoPos {
  let estados = 0
  let transito = 0
  for (const l of loncheras) {
    const o = ocupacion.get(l.id)
    if (!o) continue
    if (o.articulos >= REP_MAX_ARTICULOS_LONCHERA) estados += 2
    else if (o.articulos > 0) estados = Math.max(estados, 1)
    if (o.enTransito > 0) transito = 1
  }
  if (estados >= 2) return 'llena'
  if (transito) return 'transito'
  if (estados === 1) return 'stock'
  return 'vacia'
}

/** Resumen de ocupación de un conjunto de ubicaciones (badges del sector). */
function resumen(
  ubs: RepUbicacion[],
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>,
  ocupacion: Map<string, RepOcupacionLonchera>
) {
  let conStock = 0
  let llenas = 0
  let enTransito = 0
  for (const u of ubs) {
    const e = estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion)
    if (e === 'stock') conStock++
    if (e === 'llena') llenas++
    if (e === 'transito') enTransito++
  }
  return { total: ubs.length, conStock, llenas, enTransito }
}

export function UbicacionesModule({ target, onTargetConsumido, onVolverOrigen }: Props) {
  const [sector, setSector] = useState<RepSector>('racks')
  const [piso, setPiso] = useState<1 | 2>(1)
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [ocupacion, setOcupacion] = useState<Map<string, RepOcupacionLonchera>>(new Map())
  const [loncherasPorUbicacion, setLoncherasPorUbicacion] = useState<Map<string, Array<{ id: string; lado: 'A' | 'B' }>>>(new Map())
  const [loading, setLoading] = useState(true)
  const [detalleUbicacion, setDetalleUbicacion] = useState<RepUbicacion | null>(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const mapa = await repMapaAlmacen()
      setUbicaciones(mapa.ubicaciones)
      setOcupacion(mapa.ocupacion)
      // Loncheras por ubicación (rack = A y B; zonas = A)
      const porUbi = new Map<string, Array<{ id: string; lado: 'A' | 'B' }>>()
      for (const [, l] of mapa.loncheras) {
        const arr = porUbi.get(l.ubicacion_id) ?? []
        arr.push({ id: l.id, lado: l.lado })
        porUbi.set(l.ubicacion_id, arr)
      }
      for (const arr of porUbi.values()) arr.sort((x, y) => x.lado.localeCompare(y.lado))
      setLoncherasPorUbicacion(porUbi)
    } catch (err: unknown) {
      toast.error('Error al cargar el mapa', { description: mensajeError(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  // ── Deep-link: abrir el detalle de la ubicación pedida ──
  useEffect(() => {
    if (!target || target.tipo !== 'ubicacion' || loading) return
    const u = ubicaciones.find((x) => x.id === target.ubicacionId)
    if (u) {
      setSector(u.sector)
      setDetalleUbicacion(u)
      onTargetConsumido?.()
    }
  }, [target, loading, ubicaciones, onTargetConsumido])

  // ── Sector RACKS: racks del piso elegido, agrupados por nivel ──
  const racksPiso = useMemo(() => {
    const porRack = new Map<number, Map<number, RepUbicacion[]>>()
    for (const u of ubicaciones) {
      if (u.sector !== 'racks' || u.piso !== piso) continue
      const nivs = porRack.get(u.rack ?? 0) ?? new Map<number, RepUbicacion[]>()
      const arr = nivs.get(u.nivel) ?? []
      arr.push(u)
      nivs.set(u.nivel, arr)
      porRack.set(u.rack ?? 0, nivs)
    }
    return Array.from(porRack.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([rack, nivs]) => ({
        rack,
        niveles: Array.from(nivs.entries())
          .sort((a, b) => b[0] - a[0]) // visual: N5 arriba … N0 abajo
          .map(([nivel, list]) => ({ nivel, posiciones: list.sort((a, b) => a.secuencia - b.secuencia) })),
      }))
  }, [ubicaciones, piso])

  // ── Sector ZONAS: zonas en su orden canónico ──
  const zonasOrdenadas = useMemo(() => {
    const porZona = new Map<string, RepUbicacion[]>()
    for (const u of ubicaciones) {
      if (u.sector !== 'zonas') continue
      const arr = porZona.get(u.zona) ?? []
      arr.push(u)
      porZona.set(u.zona, arr)
    }
    return REP_ORDEN_ZONAS.filter((z) => porZona.has(z)).map((zona) => ({
      zona,
      piso: porZona.get(zona)![0].piso,
      posiciones: porZona.get(zona)!.sort((a, b) => a.secuencia - b.secuencia),
    }))
  }, [ubicaciones])

  const racksTodas = useMemo(() => ubicaciones.filter((u) => u.sector === 'racks'), [ubicaciones])
  const zonasTodas = useMemo(() => ubicaciones.filter((u) => u.sector === 'zonas'), [ubicaciones])
  const resumenRacks = useMemo(() => resumen(racksTodas, loncherasPorUbicacion, ocupacion), [racksTodas, loncherasPorUbicacion, ocupacion])
  const resumenZonas = useMemo(() => resumen(zonasTodas, loncherasPorUbicacion, ocupacion), [zonasTodas, loncherasPorUbicacion, ocupacion])

  const filtroDetalle = detalleUbicacion
    ? { sector: detalleUbicacion.sector, zona: detalleUbicacion.zona, piso: detalleUbicacion.piso, rack: detalleUbicacion.rack }
    : null

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* ═══ Barra superior: refresh + tabs de sector + resumen ═══ */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={cargar} variant="outline" size="sm" className="gap-2" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualizar
        </Button>

        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(['racks', 'zonas'] as RepSector[]).map((s) => {
            const r = s === 'racks' ? resumenRacks : resumenZonas
            const activo = sector === s
            return (
              <button
                key={s}
                onClick={() => setSector(s)}
                className={`px-3.5 py-1.5 text-sm font-bold transition-colors flex items-center gap-2 ${
                  activo
                    ? s === 'racks'
                      ? 'bg-violet-600 text-white'
                      : 'bg-amber-500 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {s === 'racks' ? <LayoutGrid className="h-4 w-4" /> : <Boxes className="h-4 w-4" />}
                {s === 'racks' ? 'Racks' : 'Zonas'}
                <span className={`text-[10px] font-mono ${activo ? 'opacity-80' : 'text-slate-400'}`}>
                  {r.total.toLocaleString('es-PE')}
                </span>
              </button>
            )
          })}
        </div>

        {/* Leyenda semáforo */}
        <div className="flex flex-wrap items-center gap-3 ml-auto text-[11px] text-slate-500">
          {(['vacia', 'stock', 'transito', 'llena'] as EstadoPos[]).map((e) => (
            <span key={e} className="flex items-center gap-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_ESTADO[e]}`} />
              {ETIQUETA_ESTADO[e]}
            </span>
          ))}
        </div>
      </div>

      {/* ═══ MAPA ═══ */}
      {loading && ubicaciones.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando mapa del almacén…
        </div>
      ) : ubicaciones.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <LayoutGrid className="h-10 w-10 mx-auto mb-3 text-slate-300" />
          <p className="text-sm font-semibold text-slate-500">El almacén no tiene ubicaciones</p>
          <p className="text-xs mt-1">El layout se carga con la migración 20261110_rep_ubicaciones_sectores.</p>
        </div>
      ) : sector === 'racks' ? (
        <SectorRacks
          piso={piso}
          setPiso={setPiso}
          racks={racksPiso}
          resumen={resumenRacks}
          loncherasPorUbicacion={loncherasPorUbicacion}
          ocupacion={ocupacion}
          onAbrir={setDetalleUbicacion}
          enfocada={filtroDetalle}
        />
      ) : (
        <SectorZonas
          zonas={zonasOrdenadas}
          loncherasPorUbicacion={loncherasPorUbicacion}
          ocupacion={ocupacion}
          onAbrir={setDetalleUbicacion}
          enfocada={filtroDetalle}
        />
      )}

      {/* ═══ Panel de detalle de la posición (loncheras A/B con contenido) ═══ */}
      <Dialog open={!!detalleUbicacion} onOpenChange={(open) => { if (!open) setDetalleUbicacion(null) }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {detalleUbicacion && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-mono">
                  <Wrench className="h-5 w-5 text-violet-600" />
                  {detalleUbicacion.codigo}
                </DialogTitle>
                <DialogDescription>
                  {detalleUbicacion.sector === 'racks'
                    ? `Rack R${String(detalleUbicacion.rack).padStart(2, '0')} · Nivel ${detalleUbicacion.nivel} · Posición ${detalleUbicacion.secuencia}`
                    : `Zona ${detalleUbicacion.zona} · Posición ${detalleUbicacion.secuencia}`}
                  {' · '}{detalleUbicacion.nota}
                </DialogDescription>
              </DialogHeader>
              <DetalleLoncheras
                ubicacion={detalleUbicacion}
                loncheras={loncherasPorUbicacion.get(detalleUbicacion.id) ?? []}
              />
              {onVolverOrigen && (
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
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   SECTOR RACKS — escena 3D del piso: estanterías isométricas
   ═══════════════════════════════════════════════════════════════════ */

function SectorRacks({
  piso,
  setPiso,
  racks,
  resumen: resumenSector,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
  enfocada,
}: {
  piso: 1 | 2
  setPiso: (p: 1 | 2) => void
  racks: Array<{ rack: number; niveles: Array<{ nivel: number; posiciones: RepUbicacion[] }> }>
  resumen: { total: number; conStock: number; llenas: number; enTransito: number }
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
  enfocada: { sector: RepSector; zona: string; piso: number; rack: number | null } | null
}) {
  const enPiso = racks.length > 0
  return (
    <div className="space-y-3">
      {/* Selector de piso + resumen del piso */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {([1, 2] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPiso(p)}
              className={`px-3 py-1 text-xs font-bold transition-colors ${
                piso === p ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {p === 1 ? '1er piso' : '2do piso'}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500">
          {racks.length} racks · {resumenSector.total.toLocaleString('es-PE')} posiciones
        </span>
        <ResumenBadges resumen={resumenSector} />
      </div>

      {/* Escena 3D: piso con perspectiva + racks isométricos */}
      {enPiso ? (
        <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-100 via-slate-50 to-slate-200 p-5 overflow-x-auto">
          <div className="flex flex-wrap justify-center gap-x-7 gap-y-9 min-w-max py-3">
            {racks.map(({ rack, niveles }) => (
              <Rack3D
                key={rack}
                rack={rack}
                piso={piso}
                niveles={niveles}
                loncherasPorUbicacion={loncherasPorUbicacion}
                ocupacion={ocupacion}
                onAbrir={onAbrir}
                enfocada={enfocada}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-slate-400 text-sm">Sin racks en este piso.</div>
      )}
    </div>
  )
}

function ResumenBadges({ resumen: r }: { resumen: { total: number; conStock: number; llenas: number; enTransito: number } }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
        {r.conStock} con stock
      </Badge>
      <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
        {r.enTransito} en tránsito
      </Badge>
      <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-200">
        {r.llenas} llenas
      </Badge>
    </div>
  )
}

/**
 * Estantería isométrica (pseudo-3D con skews CSS — barato de renderizar):
 * cara frontal = niveles apilados con sus posiciones, cara superior y
 * lateral = profundidad del rack. Cada celda abre el detalle de la posición.
 */
function Rack3D({
  rack,
  piso,
  niveles,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
  enfocada,
}: {
  rack: number
  piso: 1 | 2
  niveles: Array<{ nivel: number; posiciones: RepUbicacion[] }>
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
  enfocada: { sector: RepSector; zona: string; piso: number; rack: number | null } | null
}) {
  const etiqueta = `R${String(rack).padStart(2, '0')}`
  const conStock = niveles.reduce(
    (acc, n) => acc + n.posiciones.filter((u) => estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion) !== 'vacia').length,
    0
  )
  const enfocadaRack = enfocada?.sector === 'racks' && enfocada.piso === piso && enfocada.rack === rack

  return (
    <div className="relative" style={{ marginRight: PROF, marginTop: PROF }}>
      {/* CARA SUPERIOR (profundidad, se inclina hacia atrás-derecha) */}
      <div
        className="absolute rounded-tl-sm bg-gradient-to-r from-slate-300 to-slate-200 border border-slate-300/70"
        style={{ left: 0, top: -PROF, width: '100%', height: PROF, transform: `skewX(-45deg)`, transformOrigin: 'bottom' }}
      />
      {/* CARA LATERAL DERECHA (profundidad) */}
      <div
        className="absolute bg-gradient-to-b from-slate-400 to-slate-300 border border-slate-400/60"
        style={{ top: 0, right: -PROF, width: PROF, height: '100%', transform: `skewY(-45deg)`, transformOrigin: 'left' }}
      />

      {/* CARA FRONTAL: niveles apilados */}
      <div
        className={`relative rounded-lg border-2 bg-white p-1.5 shadow-sm ${
          enfocadaRack ? 'border-violet-500 ring-2 ring-violet-200' : 'border-slate-300'
        }`}
      >
        {niveles.map(({ nivel, posiciones }) => (
          <div key={nivel} className="flex items-center gap-1 py-[2px]">
            <span
              className={`shrink-0 text-[8px] font-extrabold rounded px-1 text-center ${
                nivel === 0 ? 'bg-slate-200 text-slate-500' : 'bg-violet-100 text-violet-700'
              }`}
              style={{ width: 22 }}
            >
              {nivel === 0 ? 'PISO' : `N${nivel}`}
            </span>
            <div className="flex gap-[3px]">
              {posiciones.map((u) => {
                const e = estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion)
                const lons = loncherasPorUbicacion.get(u.id) ?? []
                const tip = lons
                  .map((l) => {
                    const o = ocupacion.get(l.id)
                    return `${l.lado}: ${o?.articulos ?? 0}/${REP_MAX_ARTICULOS_LONCHERA}`
                  })
                  .join(' · ')
                return (
                  <button
                    key={u.id}
                    onClick={() => onAbrir(u)}
                    className={`h-[15px] w-[15px] rounded-[3px] transition-colors ${CELDA_ESTADO[e]}`}
                    title={`${u.codigo} — ${ETIQUETA_ESTADO[e]}${tip ? ` (${tip})` : ''}`}
                    aria-label={`${u.codigo}, ${ETIQUETA_ESTADO[e]}`}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Etiqueta del rack */}
      <div className="mt-2 flex items-center justify-center gap-1.5">
        <span className="font-mono text-[11px] font-extrabold text-slate-700">{etiqueta}</span>
        {conStock > 0 && (
          <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-1.5">
            {conStock}
          </span>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   SECTOR ZONAS — tarjetas con grilla de posiciones
   ═══════════════════════════════════════════════════════════════════ */

function SectorZonas({
  zonas,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
  enfocada,
}: {
  zonas: Array<{ zona: string; piso: number; posiciones: RepUbicacion[] }>
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
  enfocada: { sector: RepSector; zona: string; piso: number; rack: number | null } | null
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {zonas.map(({ zona, piso, posiciones }) => {
        const r = resumen(posiciones, loncherasPorUbicacion, ocupacion)
        const enfocadaZona = enfocada?.sector === 'zonas' && enfocada.zona === zona
        return (
          <div
            key={zona}
            className={`rounded-xl border overflow-hidden ${
              enfocadaZona ? 'ring-2 ring-violet-400' : ''
            } ${ACENTO_ZONA[zona] ?? 'border-slate-200 bg-white'}`}
          >
            <div className="px-3.5 py-2 flex items-center gap-2 bg-white/70 border-b">
              <MapPin className="h-4 w-4 opacity-60" />
              <span className="text-sm font-extrabold">{zona === 'A' || zona === 'B' || zona === 'C' || zona === 'D' ? `Zona ${zona}` : zona}</span>
              <Badge variant="outline" className="text-[10px] bg-white">piso {piso}</Badge>
              <span className="text-[11px] text-slate-500 ml-auto font-mono">{posiciones.length} pos</span>
              <ResumenBadges resumen={r} />
            </div>
            <div className="p-3 grid grid-cols-8 gap-1.5">
              {posiciones.map((u) => {
                const e = estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion)
                const lons = loncherasPorUbicacion.get(u.id) ?? []
                const tip = lons
                  .map((l) => {
                    const o = ocupacion.get(l.id)
                    return `${l.lado}: ${o?.articulos ?? 0}/${REP_MAX_ARTICULOS_LONCHERA}`
                  })
                  .join(' · ')
                return (
                  <button
                    key={u.id}
                    onClick={() => onAbrir(u)}
                    className={`rounded-md border px-1 py-1.5 text-center transition-colors ${CELDA_ESTADO[e]} ${
                      e === 'vacia' ? 'border-slate-300' : 'border-transparent'
                    }`}
                    title={`${u.codigo} — ${ETIQUETA_ESTADO[e]}${tip ? ` (${tip})` : ''}`}
                  >
                    <span className="block font-mono text-[10px] font-extrabold leading-none text-slate-700">{u.codigo}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DETALLE: CONTENIDO DE LAS LONCHERAS DE LA POSICIÓN
   (solo lectura: el layout es canónico — se elimina el borrado desde UI)
   ═══════════════════════════════════════════════════════════════════ */

function DetalleLoncheras({
  ubicacion,
  loncheras,
}: {
  ubicacion: RepUbicacion
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>
}) {
  const [contenido, setContenido] = useState<Map<string, Awaited<ReturnType<typeof repStockDeLonchera>>>>(new Map())

  useEffect(() => {
    let vivo = true
    void Promise.all(
      loncheras.map(async (l) => {
        try {
          const filas = await repStockDeLonchera(l.id)
          return [l.id, filas] as [string, Awaited<ReturnType<typeof repStockDeLonchera>>]
        } catch {
          return [l.id, [] as Awaited<ReturnType<typeof repStockDeLonchera>>] as [string, Awaited<ReturnType<typeof repStockDeLonchera>>]
        }
      })
    ).then((pares) => {
      if (!vivo) return
      setContenido(new Map(pares))
    })
    return () => { vivo = false }
  }, [loncheras])

  /** Cargando = alguna lonchera de ESTA posición aún no tiene su contenido
   *  (estado DERIVADO: sin setState síncrono en el efecto — react-hooks). */
  const loading = loncheras.some((l) => !contenido.has(l.id))

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Cargando contenido…
        </div>
      ) : loncheras.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-6">Sin loncheras (situación anómala: revisa la BD).</p>
      ) : (
        loncheras.map((l) => {
          const items = contenido.get(l.id) ?? []
          const ocupadas = items.length
          const pct = Math.min(100, Math.round((ocupadas / REP_MAX_ARTICULOS_LONCHERA) * 100))
          return (
            <div key={l.id} className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-extrabold text-sm text-slate-700">
                  Lonchera {l.lado}
                </span>
                <span className={`text-xs font-bold ${ocupadas >= REP_MAX_ARTICULOS_LONCHERA ? 'text-rose-600' : 'text-slate-500'}`}>
                  {ocupadas}/{REP_MAX_ARTICULOS_LONCHERA} artículos
                </span>
              </div>
              <Progress value={pct} className="h-1.5 mb-2" />
              {items.length === 0 ? (
                <p className="text-xs text-slate-400 flex items-center gap-1.5 py-2">
                  <PackageOpen className="h-3.5 w-3.5" /> Lonchera vacía
                </p>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {items.map((s) => (
                    <li key={s.stockId} className="flex items-center justify-between gap-2 text-xs border-b border-slate-100 pb-1 last:border-0">
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
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
