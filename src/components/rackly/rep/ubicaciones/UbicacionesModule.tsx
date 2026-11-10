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
 * UI 2026-11-11 (paridad con Ocupación de Insumos): tarjetas oscuras
 * ordenadas por rack/zona con celdas coloreadas por ocupación —
 * VERDE vacía · AZUL 1 artículo · NARANJA +1 artículos (punto ámbar =
 * stock estacionado en tránsito). El clic abre el dialog de la posición
 * con VER / INGRESO / SALIDA / TRASLADO / HISTORIAL (DialogPosicion,
 * RPCs atómicas con validaciones en BD).
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
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repMapaAlmacen,
  type RepOcupacionLonchera,
  type RepSector,
} from '@/lib/rackly/rep/rep-client'
import {
  REP_ORDEN_ZONAS,
  type RepLonchera,
  type RepUbicacion,
} from '@/lib/rackly/rep/rep-tipos'
import type { RepTarget } from '@/lib/rackly/rep/rep-navegacion'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Boxes, LayoutGrid, Loader2, RefreshCw } from 'lucide-react'
import {
  SectorRacks,
  SectorZonas,
  LeyendaMapa,
  estadoPosicion,
  type RackVista,
  type ZonaVista,
} from './mapa'
import { DialogPosicion } from './DialogPosicion'

type Props = {
  /** Deep-link: aterriza con la ubicación enfocada (patrón targetPosicion). */
  target?: RepTarget | null
  onTargetConsumido?: () => void
  /** Botón «Volver a {origen}» dentro del detalle (el hub hace el salto). */
  onVolverOrigen?: () => void
}

type LoncheraRef = { id: string; lado: 'A' | 'B' }

/** Resumen de ocupación de un sector (chips de la barra superior). */
type ResumenSector = { total: number; vacias: number; conUno: number; conVarios: number; enTransito: number }

function resumen(
  ubs: RepUbicacion[],
  loncherasPorUbicacion: Map<string, LoncheraRef[]>,
  ocupacion: Map<string, RepOcupacionLonchera>
): ResumenSector {
  const r: ResumenSector = { total: ubs.length, vacias: 0, conUno: 0, conVarios: 0, enTransito: 0 }
  for (const u of ubs) {
    const e = estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion)
    if (e === 'vacia') r.vacias++
    else if (e === 'uno') r.conUno++
    else r.conVarios++
    for (const l of loncherasPorUbicacion.get(u.id) ?? []) {
      const o = ocupacion.get(l.id)
      if (o && o.enTransito > 0) { r.enTransito++; break }
    }
  }
  return r
}

export function UbicacionesModule({ target, onTargetConsumido, onVolverOrigen }: Props) {
  const { perfil } = useAuth()
  const puedeOperar = puede(perfil, 'repuestos.crear')

  const [sector, setSector] = useState<RepSector>('racks')
  const [piso, setPiso] = useState<1 | 2>(1)
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [ocupacion, setOcupacion] = useState<Map<string, RepOcupacionLonchera>>(new Map())
  const [loncheras, setLoncheras] = useState<Map<string, RepLonchera>>(new Map())
  const [loncherasPorUbicacion, setLoncherasPorUbicacion] = useState<Map<string, LoncheraRef[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [detalleUbicacion, setDetalleUbicacion] = useState<RepUbicacion | null>(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const mapa = await repMapaAlmacen()
      setUbicaciones(mapa.ubicaciones)
      setOcupacion(mapa.ocupacion)
      setLoncheras(mapa.loncheras)
      // Loncheras por ubicación (rack = A y B; zonas = A)
      const porUbi = new Map<string, LoncheraRef[]>()
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
      .map(([rack, nivs]): RackVista => ({
        rack,
        niveles: Array.from(nivs.entries())
          .sort((a, b) => b[0] - a[0]) // visual: N5 arriba … N0 (piso) abajo
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
    return REP_ORDEN_ZONAS.filter((z) => porZona.has(z)).map((zona): ZonaVista => ({
      zona,
      piso: porZona.get(zona)![0].piso,
      posiciones: porZona.get(zona)!.sort((a, b) => a.secuencia - b.secuencia),
    }))
  }, [ubicaciones])

  const racksTodas = useMemo(() => ubicaciones.filter((u) => u.sector === 'racks'), [ubicaciones])
  const zonasTodas = useMemo(() => ubicaciones.filter((u) => u.sector === 'zonas'), [ubicaciones])
  const resumenRacks = useMemo(
    () => resumen(racksTodas, loncherasPorUbicacion, ocupacion),
    [racksTodas, loncherasPorUbicacion, ocupacion]
  )
  const resumenZonas = useMemo(
    () => resumen(zonasTodas, loncherasPorUbicacion, ocupacion),
    [zonasTodas, loncherasPorUbicacion, ocupacion]
  )

  const loncherasDetalle = detalleUbicacion
    ? loncherasPorUbicacion.get(detalleUbicacion.id) ?? []
    : []

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* ═══ Barra superior: refresh + tabs de sector + resumen + leyenda ═══ */}
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

        {/* Leyenda: verde / azul / naranja + tránsito */}
        <div className="ml-auto">
          <LeyendaMapa />
        </div>
      </div>

      {/* Chips de resumen del sector activo */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(() => {
          const r = sector === 'racks' ? resumenRacks : resumenZonas
          return (
            <>
              <ChipResumen color="bg-emerald-400" etiqueta="Vacías" valor={r.vacias} />
              <ChipResumen color="bg-blue-400" etiqueta="Con 1 artículo" valor={r.conUno} />
              <ChipResumen color="bg-orange-400" etiqueta="Con +1 artículos" valor={r.conVarios} />
              <ChipResumen color="bg-amber-300" etiqueta="En tránsito" valor={r.enTransito} />
            </>
          )
        })()}
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
          totalSector={resumenRacks.total}
          loncherasPorUbicacion={loncherasPorUbicacion}
          ocupacion={ocupacion}
          onAbrir={setDetalleUbicacion}
        />
      ) : (
        <SectorZonas
          zonas={zonasOrdenadas}
          loncherasPorUbicacion={loncherasPorUbicacion}
          ocupacion={ocupacion}
          onAbrir={setDetalleUbicacion}
        />
      )}

      {/* ═══ Dialog de la posición: ver / ingreso / salida / traslado / historial ═══ */}
      <DialogPosicion
        key={detalleUbicacion?.id ?? 'sin-ubicacion'}
        ubicacion={detalleUbicacion}
        loncheras={loncherasDetalle}
        loncherasMap={loncheras}
        ubicaciones={ubicaciones}
        ocupacion={ocupacion}
        puedeOperar={puedeOperar}
        onHecho={cargar}
        onClose={() => setDetalleUbicacion(null)}
        onVolverOrigen={onVolverOrigen}
      />
    </div>
  )
}

/** Chip pequeño de resumen (punto de color + etiqueta + número). */
function ChipResumen({ color, etiqueta, valor }: { color: string; etiqueta: string; valor: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      <span className="text-slate-500">{etiqueta}</span>
      <span className="font-bold text-slate-700 font-mono">{valor.toLocaleString('es-PE')}</span>
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════
// NOTAS INTERNAS
// ═══════════════════════════════════════════════════════════════════
