'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Mapa de ubicaciones (sector RACKS y ZONAS).
 *
 * Visual heredado del módulo Ocupación de Insumos (kardex/OcupacionTab):
 * tarjetas oscuras por rack/zona, filas por nivel con las posiciones
 * partidas en dos renglones (mitad A / mitad B) y celdas coloreadas por
 * ocupación con hover. Colores pedidos por el usuario (2026-11-11):
 *
 *   · VERDE   — posición sin ocupar (0 artículos)
 *   · AZUL    — solo 1 artículo
 *   · NARANJA — más de 1 artículo
 *   · punto ámbar — la posición tiene stock estacionado en tránsito (RAL)
 *
 * El estado de una POSICIÓN agrega sus loncheras A/B (ocupación agregada
 * en BD por rep_ocupacion_loncheras — el navegador no descarga stock).
 */

import { useMemo } from 'react'
import { REP_MAX_ARTICULOS_LONCHERA, type RepUbicacion } from '@/lib/rackly/rep/rep-tipos'
import type { RepOcupacionLonchera } from '@/lib/rackly/rep/rep-client'

// ═══════════════════════════════════════════════════════════════════
// ESTADO DE POSICIÓN (verde / azul / naranja) — fuente única del mapa
// ═══════════════════════════════════════════════════════════════════

export type EstadoPos = 'vacia' | 'uno' | 'varios'

export type OcupacionPos = { articulos: number; enTransito: number }

/** Ocupación total de una posición = suma de sus loncheras (A y B). */
export function ocupacionPosicion(
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>,
  ocupacion: Map<string, RepOcupacionLonchera>
): OcupacionPos {
  let articulos = 0
  let enTransito = 0
  for (const l of loncheras) {
    const o = ocupacion.get(l.id)
    if (!o) continue
    articulos += o.articulos
    enTransito += o.enTransito
  }
  return { articulos, enTransito }
}

export function estadoPosicion(
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>,
  ocupacion: Map<string, RepOcupacionLonchera>
): EstadoPos {
  const { articulos } = ocupacionPosicion(loncheras, ocupacion)
  if (articulos === 0) return 'vacia'
  if (articulos === 1) return 'uno'
  return 'varios'
}

export const ETIQUETA_ESTADO: Record<EstadoPos, string> = {
  vacia: 'Vacía',
  uno: '1 artículo',
  varios: '+1 artículos',
}

/** Celdas (tema oscuro, estilo Insumos OcupacionTab). */
const CELDA_ESTADO: Record<EstadoPos, string> = {
  vacia: 'bg-gradient-to-br from-emerald-400/60 to-green-600/60 text-white/70 border-emerald-400/15 hover:from-emerald-400 hover:to-green-500 hover:text-white',
  uno: 'bg-gradient-to-br from-blue-400 to-blue-600 text-white border-blue-300/25 hover:from-blue-300 hover:to-blue-500',
  varios: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white border-amber-300/25 hover:from-amber-300 hover:to-orange-400',
}

const DOT_ESTADO: Record<EstadoPos, string> = {
  vacia: 'bg-emerald-400',
  uno: 'bg-blue-400',
  varios: 'bg-orange-400',
}

/** Tooltip compacto: «A: 3/15 · B: 0/15». */
function tipLoncheras(
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>,
  ocupacion: Map<string, RepOcupacionLonchera>
): string {
  return loncheras
    .map((l) => {
      const o = ocupacion.get(l.id)
      return `${l.lado}: ${o?.articulos ?? 0}/${REP_MAX_ARTICULOS_LONCHERA}`
    })
    .join(' · ')
}

// ═══════════════════════════════════════════════════════════════════
// CELDA — botón de una posición (coloreada, hover, punto de tránsito)
// ═══════════════════════════════════════════════════════════════════

export function CeldaPosicion({
  u,
  loncheras,
  ocupacion,
  onAbrir,
  compacta,
}: {
  u: RepUbicacion
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
  /** Compacta = celda de zona (muestra el código completo, alto fijo). */
  compacta?: boolean
}) {
  const e = estadoPosicion(loncheras, ocupacion)
  const { enTransito } = ocupacionPosicion(loncheras, ocupacion)
  const sufijo = u.codigo.split('-').pop() ?? u.codigo
  return (
    <button
      onClick={() => onAbrir(u)}
      title={`${u.codigo} — ${ETIQUETA_ESTADO[e]}${tipLoncheras(loncheras, ocupacion) ? ` (${tipLoncheras(loncheras, ocupacion)})` : ''}`}
      aria-label={`${u.codigo}, ${ETIQUETA_ESTADO[e]}`}
      className={`relative flex-1 min-w-0 rounded font-bold transition-all duration-150 cursor-pointer border flex flex-col items-center justify-center hover:scale-105 active:scale-95 ${
        compacta ? 'px-1 py-1.5 text-[10px]' : 'h-9 text-[9px]'
      } ${CELDA_ESTADO[e]}`}
    >
      <span className="truncate w-full text-center px-px">{sufijo}</span>
      {enTransito > 0 && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-300 rounded-full ring-1 ring-slate-800" />
      )}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SECTOR RACKS — tarjetas oscuras por rack (estilo «Torre» de Insumos)
// ═══════════════════════════════════════════════════════════════════

export type RackVista = {
  rack: number
  niveles: Array<{ nivel: number; posiciones: RepUbicacion[] }>
}

export function SectorRacks({
  piso,
  setPiso,
  racks,
  totalSector,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
}: {
  piso: 1 | 2
  setPiso: (p: 1 | 2) => void
  racks: RackVista[]
  totalSector: number
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
}) {
  return (
    <div className="space-y-3">
      {/* Selector de piso */}
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
          {racks.length} racks · {totalSector.toLocaleString('es-PE')} posiciones
        </span>
      </div>

      {racks.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">Sin racks en este piso.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {racks.map((r) => (
            <RackCard
              key={r.rack}
              rack={r.rack}
              niveles={r.niveles}
              loncherasPorUbicacion={loncherasPorUbicacion}
              ocupacion={ocupacion}
              onAbrir={onAbrir}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Umbral para partir un nivel en dos renglones (mitad A / mitad B). */
const PARTIR_SI_MAS_DE = 10

function RackCard({
  rack,
  niveles,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
}: {
  rack: number
  niveles: RackVista['niveles']
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
}) {
  const etiqueta = `R${String(rack).padStart(2, '0')}`
  const { total, ocupadas } = useMemo(() => {
    let t = 0
    let o = 0
    for (const n of niveles) {
      for (const u of n.posiciones) {
        t++
        if (estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion) !== 'vacia') o++
      }
    }
    return { total: t, ocupadas: o }
  }, [niveles, loncherasPorUbicacion, ocupacion])
  const pct = total > 0 ? Math.round((ocupadas / total) * 100) : 0

  return (
    <div className="rounded-xl border border-slate-600/30 bg-gradient-to-b from-slate-800/80 to-slate-900/80 shadow-lg overflow-hidden">
      {/* Encabezado del rack */}
      <div className="px-4 py-3 border-b border-slate-600/25 bg-gradient-to-r from-slate-800/60 to-transparent flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-bold text-[11px] shadow">
            {etiqueta}
          </div>
          <div>
            <p className="text-xs font-bold text-slate-200">Rack {etiqueta}</p>
            <p className="text-[10px] text-slate-500">
              {niveles.length} niveles · {total} pos
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-violet-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-bold text-violet-300">{pct}%</span>
          <span className="text-[10px] text-slate-500">({ocupadas}/{total})</span>
        </div>
      </div>

      {/* Niveles: N5 arriba … N0 (piso) abajo */}
      <div className="p-3 space-y-1">
        {niveles.map(({ nivel, posiciones }) => {
          const mitad = posiciones.length > PARTIR_SI_MAS_DE ? Math.ceil(posiciones.length / 2) : posiciones.length
          const renglonA = posiciones.slice(0, mitad)
          const renglonB = posiciones.slice(mitad)
          const nivelOcupadas = posiciones.filter((u) => estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion) !== 'vacia').length
          return (
            <div key={nivel} className="rounded-lg border border-slate-600/15 bg-slate-900/40 overflow-hidden">
              <div className="flex items-center gap-2 py-1.5 px-2 bg-slate-800/50 border-b border-slate-700/15">
                <span className="text-[10px] font-bold text-slate-300 tracking-wide">
                  {nivel === 0 ? 'PISO' : `N${nivel}`}
                </span>
                {nivelOcupadas > 0 && (
                  <span className="text-[9px] font-bold text-violet-300 bg-violet-400/10 px-1.5 py-px rounded-full">{nivelOcupadas}</span>
                )}
                <div className="flex-1 h-px bg-slate-700/20" />
                <span className="text-[8px] text-slate-600">{posiciones.length} pos</span>
              </div>
              <div className="flex px-1.5 pt-1.5 gap-[2px]">
                {renglonA.map((u) => (
                  <CeldaPosicion key={u.id} u={u} loncheras={loncherasPorUbicacion.get(u.id) ?? []} ocupacion={ocupacion} onAbrir={onAbrir} />
                ))}
              </div>
              {renglonB.length > 0 && (
                <div className="flex px-1.5 pt-[2px] pb-1.5 gap-[2px]">
                  {renglonB.map((u) => (
                    <CeldaPosicion key={u.id} u={u} loncheras={loncherasPorUbicacion.get(u.id) ?? []} ocupacion={ocupacion} onAbrir={onAbrir} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SECTOR ZONAS — tarjetas oscuras por zona (grilla de posiciones)
// ═══════════════════════════════════════════════════════════════════

export type ZonaVista = { zona: string; piso: number; posiciones: RepUbicacion[] }

export function SectorZonas({
  zonas,
  loncherasPorUbicacion,
  ocupacion,
  onAbrir,
}: {
  zonas: ZonaVista[]
  loncherasPorUbicacion: Map<string, Array<{ id: string; lado: 'A' | 'B' }>>
  ocupacion: Map<string, RepOcupacionLonchera>
  onAbrir: (u: RepUbicacion) => void
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {zonas.map(({ zona, piso, posiciones }) => {
        const ocupadas = posiciones.filter((u) => estadoPosicion(loncherasPorUbicacion.get(u.id) ?? [], ocupacion) !== 'vacia').length
        const pct = posiciones.length > 0 ? Math.round((ocupadas / posiciones.length) * 100) : 0
        return (
          <div key={zona} className="rounded-xl border border-slate-600/30 bg-gradient-to-b from-slate-800/80 to-slate-900/80 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-600/25 bg-gradient-to-r from-slate-800/60 to-transparent flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-white font-bold text-[10px] shadow shrink-0">
                  {zona.length <= 3 ? zona : zona.slice(0, 3)}
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-200">{zona.length <= 3 ? `Zona ${zona}` : zona}</p>
                  <p className="text-[10px] text-slate-500">piso {piso} · {posiciones.length} pos</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs font-bold text-sky-300">{pct}%</span>
                <span className="text-[10px] text-slate-500">({ocupadas}/{posiciones.length})</span>
              </div>
            </div>
            <div className="p-3 grid grid-cols-8 gap-1.5">
              {posiciones.map((u) => (
                <div key={u.id} className="flex">
                  <CeldaPosicion u={u} loncheras={loncherasPorUbicacion.get(u.id) ?? []} ocupacion={ocupacion} onAbrir={onAbrir} compacta />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// LEYENDA — compartida por ambos sectores
// ═══════════════════════════════════════════════════════════════════

export function LeyendaMapa() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
      {(['vacia', 'uno', 'varios'] as EstadoPos[]).map((e) => (
        <span key={e} className="flex items-center gap-1">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_ESTADO[e]}`} />
          {ETIQUETA_ESTADO[e]}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-300 ring-1 ring-slate-400" />
        En tránsito (RAL)
      </span>
    </div>
  )
}
