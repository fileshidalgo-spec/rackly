'use client'

/**
 * RACKLY — TRÁNSITO · Mapa visual de ubicaciones de PISO.
 *
 * Reutiliza el motor de sectores del módulo Piso (RPC piso_stock_sector_grid
 * vía cargarPosicionesSector) y lo convierte en selector:
 *   · Sector → Columna (A, B, C…) → Subcolumna → Posición → NIVEL (la unidad
 *     física de almacenamiento; el stock del piso se registra por nivel).
 *   · Posición libre → verde. Ocupada → ámbar con contenido; al tocarla se
 *     pide SIEMPRE confirmación para co-ubicar (regla v3.3).
 *   · Mismo código del artículo → marcador violeta.
 * Sugerencia automática: la primera posición libre del primer sector, nivel 1.
 */

import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CheckCircle2, ChevronLeft, Loader2, MapPin, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  sectoresPiso,
  posicionesDeSector,
  nivelesDePosicion,
  etiquetaPiso,
  type Sector,
  type PosicionConStock,
  type Nivel,
} from '@/lib/rackly/transito'

export type SeleccionPiso = {
  nivel_id: string
  posicion_id: string
  nivelNumero: number
  etiqueta: string
  ocupada: boolean
  contenido: { bloque_codigo: string; cantidad: number }[]
}

const EPS = 0.0005

export function MapaPisoSelector({
  codigoMarca,
  onConfirm,
}: {
  codigoMarca: string
  onConfirm: (sel: SeleccionPiso) => void
}) {
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState<string | null>(null)
  const [posiciones, setPosiciones] = useState<PosicionConStock[]>([])
  const [cargando, setCargando] = useState(true)
  const [posAbierta, setPosAbierta] = useState<{
    pos: PosicionConStock
    niveles: Nivel[]
  } | null>(null)
  const [cargandoNiveles, setCargandoNiveles] = useState(false)
  const [selNivelId, setSelNivelId] = useState<string | null>(null)
  const [sugerida, setSugerida] = useState<string | null>(null)
  const [pedirConfirmCoUbicar, setPedirConfirmCoUbicar] = useState(false)

  const cargarSectores = async () => {
    setCargando(true)
    try {
      const secs = await sectoresPiso()
      setSectores(secs)
      if (secs.length > 0 && !sectorId) setSectorId(secs[0].id)
    } catch (err) {
      console.error('[MapaPiso] Error cargando sectores:', err)
      toast.error('No se pudo cargar los sectores del piso')
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    cargarSectores()
  }, [])

  const cargarPosiciones = async (sid: string) => {
    setCargando(true)
    try {
      const data = await posicionesDeSector(sid)
      setPosiciones(data)
      setPosAbierta(null)
      setSelNivelId(null)
    } catch (err) {
      console.error('[MapaPiso] Error cargando posiciones:', err)
      toast.error('No se pudo cargar las posiciones del sector')
      setPosiciones([])
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    if (sectorId) cargarPosiciones(sectorId)
  }, [sectorId])

  const sector = sectores.find((s) => s.id === sectorId) ?? null

  // Agrupar posiciones por columna → subcolumna
  const columnas = useMemo(() => {
    const map = new Map<string, { letra: string; subs: Map<string, PosicionConStock[]> }>()
    for (const p of posiciones) {
      let col = map.get(p.columnaLetra)
      if (!col) {
        col = { letra: p.columnaLetra, subs: new Map() }
        map.set(p.columnaLetra, col)
      }
      let sub = col.subs.get(p.subcolumnaCodigo)
      if (!sub) {
        sub = []
        col.subs.set(p.subcolumnaCodigo, sub)
      }
      sub.push(p)
    }
    return Array.from(map.values()).sort((a, b) => a.letra.localeCompare(b.letra))
  }, [posiciones])

  // Sugerencia: primera posición libre (columna asc, subcolumna, número) nivel 1
  useEffect(() => {
    if (posiciones.length === 0 || sugerida) return
    const ordenadas = [...posiciones].sort(
      (a, b) =>
        a.columnaLetra.localeCompare(b.columnaLetra) ||
        a.subcolumnaCodigo.localeCompare(b.subcolumnaCodigo) ||
        a.posicionNumero - b.posicionNumero
    )
    const libre = ordenadas.find((p) => p.stock <= EPS)
    if (libre) setSugerida(libre.posicionId)
  }, [posiciones, sugerida])

  const clickPosicion = async (p: PosicionConStock) => {
    if (p.stock > EPS) {
      // Ocupada: confirmación SIEMPRE antes de elegir nivel (co-ubicar)
      setPosAbierta({ pos: p, niveles: [] })
      setPedirConfirmCoUbicar(true)
      return
    }
    await abrirNiveles(p)
  }

  const abrirNiveles = async (p: PosicionConStock, nivelPreselecc?: string) => {
    setCargandoNiveles(true)
    setSelNivelId(nivelPreselecc ?? null)
    try {
      const niveles = await nivelesDePosicion(p.posicionId)
      setPosAbierta({ pos: p, niveles })
      // Sugerida y libre: preseleccionar nivel 1 (el más bajo) automáticamente
      if (!nivelPreselecc && p.stock <= EPS && sugerida === p.posicionId && niveles.length > 0) {
        setSelNivelId(niveles[0].id)
      }
    } catch (err) {
      console.error('[MapaPiso] Error cargando niveles:', err)
      toast.error('No se pudo cargar los niveles de la posición')
    } finally {
      setCargandoNiveles(false)
    }
  }

  const confirmar = () => {
    if (!posAbierta || !selNivelId) return
    const nivel = posAbierta.niveles.find((n) => n.id === selNivelId)
    if (!nivel) return
    onConfirm({
      nivel_id: nivel.id,
      posicion_id: posAbierta.pos.posicionId,
      nivelNumero: nivel.numero,
      etiqueta: etiquetaPiso({
        sector: sector?.nombre,
        columna: posAbierta.pos.columnaLetra,
        subcolumna: posAbierta.pos.subcolumnaCodigo,
        posicionNumero: posAbierta.pos.posicionNumero,
        nivelNumero: nivel.numero,
      }),
      ocupada: posAbierta.pos.stock > EPS,
      contenido: posAbierta.pos.bloques.map((b) => ({ bloque_codigo: b.bloque_codigo, cantidad: b.cantidad })),
    })
  }

  const posAbiertaOcupada = posAbierta ? posAbierta.pos.stock > EPS : false

  if (!cargando && sectores.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No hay sectores configurados en el módulo Piso. Configúralos desde Piso → Sectores.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          <MapPin className="h-4 w-4 text-sky-600" />
          Toca una posición y luego el nivel (unidad física)
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSugerida(null)
            if (sectorId) cargarPosiciones(sectorId)
          }}
          disabled={cargando}
          className="h-8 gap-1.5"
        >
          {cargando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Actualizar
        </Button>
      </div>

      {/* Chips de sector */}
      <div className="flex flex-wrap gap-1.5">
        {sectores.map((s) => (
          <button
            key={s.id}
            onClick={() => setSectorId(s.id)}
            className={`h-8 px-3 rounded-lg text-xs font-bold transition-all ${
              sectorId === s.id
                ? 'bg-sky-600 text-white shadow-md shadow-sky-600/30 scale-105'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {s.nombre}
          </button>
        ))}
      </div>

      {/* Grid de posiciones agrupadas por columna */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 overflow-x-auto">
        {cargando ? (
          <div className="flex items-center justify-center py-10 text-sm text-slate-500 gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando mapa del sector…
          </div>
        ) : (
          <div className="flex gap-3 min-w-max">
            {columnas.map((col) => (
              <div key={col.letra} className="space-y-2">
                <div className="text-[10px] font-extrabold text-sky-700 uppercase tracking-wider text-center">
                  Col. {col.letra}
                </div>
                {Array.from(col.subs.entries()).map(([subCodigo, poss]) => (
                  <div key={subCodigo} className="space-y-1">
                    <div className="text-[9px] font-bold text-slate-400 text-center">{subCodigo || 'Sub.'}</div>
                    <div className="flex gap-1 justify-center">
                      {poss
                        .slice()
                        .sort((a, b) => a.posicionNumero - b.posicionNumero)
                        .map((p) => {
                          const ocupada = p.stock > EPS
                          const mismoCodigo = !!codigoMarca && p.bloques.some((b) => b.bloque_codigo === codigoMarca)
                          const abierta = posAbierta?.pos.posicionId === p.posicionId
                          const esSugerida = sugerida === p.posicionId
                          return (
                            <button
                              key={p.posicionId}
                              onClick={() => clickPosicion(p)}
                              title={
                                ocupada
                                  ? `Ocupada · ${p.bloques.map((b) => `${b.bloque_codigo} (${b.cantidad})`).join(', ')}`
                                  : 'Libre'
                              }
                              className={`relative w-9 h-9 sm:w-10 sm:h-10 rounded-md text-[9px] font-bold transition-all flex flex-col items-center justify-center leading-none ${
                                abierta
                                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/40 scale-110 z-10'
                                  : mismoCodigo
                                    ? 'bg-violet-200 text-violet-800 border-2 border-violet-500 hover:bg-violet-300'
                                    : ocupada
                                      ? 'bg-amber-200 text-amber-900 hover:bg-amber-300'
                                      : 'bg-emerald-200 text-emerald-800 hover:bg-emerald-300'
                              }`}
                            >
                              {abierta && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-blue-600 border-2 border-white" />}
                              {mismoCodigo && !abierta && (
                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-violet-600 border border-white" />
                              )}
                              {esSugerida && !abierta && (
                                <span className="absolute -top-1.5 -left-1.5">
                                  <Sparkles className="h-3 w-3 text-blue-600" />
                                </span>
                              )}
                              <span>{p.posicionNumero}</span>
                              {ocupada && (
                                <span className="text-[7px] font-semibold opacity-80">{formatearStock(p.stock)}</span>
                              )}
                            </button>
                          )
                        })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {columnas.length === 0 && (
              <div className="text-sm text-slate-500 py-6 text-center w-full">
                El sector no tiene posiciones configuradas.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Niveles de la posición abierta */}
      {posAbierta && (
        <div className="rounded-xl border-2 border-blue-200 bg-blue-50/60 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-blue-900 flex items-center gap-1.5">
              <ChevronLeft className="h-4 w-4" />
              {sector?.nombre} · Col. {posAbierta.pos.columnaLetra} · {posAbierta.pos.subcolumnaCodigo} · Pos{' '}
              {posAbierta.pos.posicionNumero}
              {posAbiertaOcupada && (
                <Badge className="bg-amber-500 text-white ml-1">Co-ubicación</Badge>
              )}
            </p>
            {posAbiertaOcupada && posAbierta.pos.bloques.length > 0 && (
              <p className="text-[11px] text-amber-700 truncate">
                Ya tiene: {posAbierta.pos.bloques.map((b) => `${b.bloque_codigo} (${formatearStock(b.cantidad)})`).join(' · ')}
              </p>
            )}
          </div>

          {cargandoNiveles ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando niveles…
            </div>
          ) : posAbierta.niveles.length === 0 ? (
            <p className="text-sm text-slate-500">Esta posición no tiene niveles configurados.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {posAbierta.niveles.map((n) => (
                <button
                  key={n.id}
                  onClick={() => setSelNivelId(n.id)}
                  className={`h-9 min-w-12 px-2 rounded-lg text-xs font-bold transition-all ${
                    selNivelId === n.id
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30 scale-105'
                      : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  N{n.numero}
                  {n.codigo_ubicacion && (
                    <span className="block text-[8px] font-medium opacity-70">{n.codigo_ubicacion}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <Button onClick={confirmar} disabled={!selNivelId} className="gap-1.5 font-semibold w-full sm:w-auto">
            <CheckCircle2 className="h-4 w-4" />
            Usar este nivel
          </Button>
        </div>
      )}

      {/* Leyenda */}
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-300" /> Libre</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-300" /> Ocupada (clic = co-ubicar)</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-violet-400" /> Mismo código</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-600" /> Abierta</span>
      </div>

      {/* Confirmación de co-ubicación (siempre antes de elegir nivel si está ocupada) */}
      <AlertDialog open={pedirConfirmCoUbicar} onOpenChange={setPedirConfirmCoUbicar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Esta posición ya tiene stock</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p className="font-semibold text-slate-900">
                  {posAbierta
                    ? `${sector?.nombre ?? ''} · Col. ${posAbierta.pos.columnaLetra} · ${posAbierta.pos.subcolumnaCodigo} · Pos ${posAbierta.pos.posicionNumero}`
                    : ''}
                </p>
                {posAbierta && posAbierta.pos.bloques.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {posAbierta.pos.bloques.map((b) => (
                      <li key={b.bloque_id}>
                        <span className="font-semibold text-slate-900">{b.bloque_codigo}</span> — {formatearStock(b.cantidad)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p>¿Deseas co-ubicar aquí tu mercadería junto a lo existente?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Elegir otra posición</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => {
                setPedirConfirmCoUbicar(false)
                if (posAbierta) abrirNiveles(posAbierta.pos)
              }}
            >
              Sí, co-ubicar aquí
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatearStock(n: number): string {
  return String(Math.round(n * 100) / 100)
}
