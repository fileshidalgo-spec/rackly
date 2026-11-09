'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Ubicaciones (mapa del almacén).
 *
 * Layout físico (modelo acordado):
 *   · Cada piso: posiciones agrupadas por nivel. Las posiciones de tipo
 *     rack tienen 2 loncheras (A y B); zona/pasillo/prepicking tienen 1 (A).
 *   · Los PASILLOS viven BAJO el nivel 1 del piso (nivel 0) — fila propia.
 *   · Las ZONAS de almacenamiento son las ubicaciones del tercer nivel.
 *   · PRE-PICKING: zona temporal antes de la salida (1 lonchera por nivel).
 *
 * Datos en 1 ronda (repMapaAlmacen): ubicaciones + loncheras + ocupación
 * agregada EN BD (RPC rep_ocupacion_loncheras). El detalle de una lonchera
 * (su contenido) se pide al abrir el panel.
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
  repCrearUbicacion,
  repEliminarUbicacion,
  repStockDeLonchera,
  type RepOcupacionLonchera,
} from '@/lib/rackly/rep/rep-client'
import {
  REP_MAX_ARTICULOS_LONCHERA,
  REP_ETIQUETA_TIPO,
  repCodigoUbicacion,
  type RepTipoUbicacion,
  type RepUbicacion,
} from '@/lib/rackly/rep/rep-tipos'
import type { RepTarget } from '@/lib/rackly/rep/rep-navegacion'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  LayoutGrid,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  ArrowLeft,
  PackageOpen,
  Navigation2,
} from 'lucide-react'

type Props = {
  /** Deep-link: aterriza con la ubicación enfocada (patrón targetPosicion). */
  target?: RepTarget | null
  onTargetConsumido?: () => void
  /** Botón «Volver a {origen}» dentro del detalle (el hub hace el salto). */
  onVolverOrigen?: () => void
}

const COLOR_TIPO: Record<RepTipoUbicacion, string> = {
  rack: 'bg-violet-50 border-violet-300 hover:bg-violet-100 text-violet-900',
  pasillo: 'bg-sky-50 border-sky-300 hover:bg-sky-100 text-sky-900',
  zona: 'bg-amber-50 border-amber-300 hover:bg-amber-100 text-amber-900',
  prepicking: 'bg-rose-50 border-rose-300 hover:bg-rose-100 text-rose-900',
}

const DOT_TIPO: Record<RepTipoUbicacion, string> = {
  rack: 'bg-violet-500',
  pasillo: 'bg-sky-500',
  zona: 'bg-amber-500',
  prepicking: 'bg-rose-500',
}

export function UbicacionesModule({ target, onTargetConsumido, onVolverOrigen }: Props) {
  const { perfil } = useAuth()
  const puedeGestionar = puede(perfil, 'repuestos.gestionar')
  const puedeEliminar = puede(perfil, 'repuestos.eliminar')

  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [ocupacion, setOcupacion] = useState<Map<string, RepOcupacionLonchera>>(new Map())
  const [loncherasPorUbicacion, setLoncherasPorUbicacion] = useState<Map<string, Array<{ id: string; lado: 'A' | 'B' }>>>(new Map())
  const [loading, setLoading] = useState(true)
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const [detalleUbicacion, setDetalleUbicacion] = useState<RepUbicacion | null>(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const mapa = await repMapaAlmacen()
      setUbicaciones(mapa.ubicaciones)
      setOcupacion(mapa.ocupacion)
      // Loncheras por ubicación (para saber si la posición es A/B o solo A)
      const porUbi = new Map<string, Array<{ id: string; lado: 'A' | 'B' }>>()
      for (const [id, l] of mapa.loncheras) {
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
      setDetalleUbicacion(u)
      onTargetConsumido?.()
    }
  }, [target, loading, ubicaciones])

  // ── Agrupación del mapa: piso → { pasillos, niveles, prepicking } ──
  const pisos = useMemo(() => {
    const porPiso = new Map<number, RepUbicacion[]>()
    for (const u of ubicaciones) {
      const arr = porPiso.get(u.piso) ?? []
      arr.push(u)
      porPiso.set(u.piso, arr)
    }
    return Array.from(porPiso.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([piso, ubs]) => {
        const pasillos = ubs.filter((u) => u.tipo === 'pasillo').sort((a, b) => a.secuencia - b.secuencia)
        const prepicking = ubs.filter((u) => u.tipo === 'prepicking').sort((a, b) => a.nivel - b.nivel)
        const porNivel = new Map<number, RepUbicacion[]>()
        for (const u of ubs) {
          if (u.tipo !== 'rack' && u.tipo !== 'zona') continue
          const arr = porNivel.get(u.nivel) ?? []
          arr.push(u)
          porNivel.set(u.nivel, arr)
        }
        const niveles = Array.from(porNivel.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([nivel, list]) => ({
            nivel,
            posiciones: list.sort((a, b) =>
              a.tipo === b.tipo ? a.secuencia - b.secuencia : a.tipo === 'rack' ? -1 : 1
            ),
          }))
        return { piso, pasillos, prepicking, niveles }
      })
  }, [ubicaciones])

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* Barra superior */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={cargar} variant="outline" size="sm" className="gap-2" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualizar
        </Button>
        {puedeGestionar && (
          <Button onClick={() => setNuevoOpen(true)} variant="outline" size="sm" className="gap-2">
            <Plus className="h-4 w-4" /> Nueva ubicación
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-3 ml-auto text-[11px] text-slate-500">
          {(['rack', 'pasillo', 'zona', 'prepicking'] as RepTipoUbicacion[]).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_TIPO[t]}`} />
              {REP_ETIQUETA_TIPO[t]}
            </span>
          ))}
        </div>
      </div>

      {/* Mapa */}
      {loading && ubicaciones.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando mapa…
        </div>
      ) : ubicaciones.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <LayoutGrid className="h-10 w-10 mx-auto mb-3 text-slate-300" />
          <p className="text-sm font-semibold text-slate-500">El almacén no tiene ubicaciones todavía</p>
          <p className="text-xs mt-1">Crea la primera con «Nueva ubicación»: elige tipo, piso, nivel y posición.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {pisos.map(({ piso, pasillos, prepicking, niveles }) => (
            <div key={piso} className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="bg-slate-100/80 px-4 py-2 flex items-center gap-2">
                <MapPin className="h-4 w-4 text-slate-500" />
                <span className="text-sm font-extrabold text-slate-700">PISO {piso}</span>
                {onVolverOrigen && detalleUbicacion?.piso === piso && (
                  <Badge variant="outline" className="ml-2 text-[10px]">ubicación enfocada abajo</Badge>
                )}
              </div>

              <div className="p-4 space-y-4">
                {/* Niveles con posiciones (rack + zona) */}
                {niveles.map(({ nivel, posiciones }) => (
                  <div key={nivel}>
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                      Nivel {nivel}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {posiciones.map((u) => (
                        <CeldaUbicacion
                          key={u.id}
                          ubicacion={u}
                          loncheras={loncherasPorUbicacion.get(u.id) ?? []}
                          ocupacion={ocupacion}
                          onClick={() => setDetalleUbicacion(u)}
                        />
                      ))}
                    </div>
                  </div>
                ))}

                {/* Pasillos (bajo nivel 1) */}
                {pasillos.length > 0 && (
                  <div>
                    <p className="text-[11px] font-bold text-sky-500 uppercase tracking-wide mb-1.5">
                      Pasillos (bajo nivel 1)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {pasillos.map((u) => (
                        <CeldaUbicacion
                          key={u.id}
                          ubicacion={u}
                          loncheras={loncherasPorUbicacion.get(u.id) ?? []}
                          ocupacion={ocupacion}
                          onClick={() => setDetalleUbicacion(u)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Pre-picking */}
                {prepicking.length > 0 && (
                  <div>
                    <p className="text-[11px] font-bold text-rose-500 uppercase tracking-wide mb-1.5">
                      Pre-picking (salida del día)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {prepicking.map((u) => (
                        <CeldaUbicacion
                          key={u.id}
                          ubicacion={u}
                          loncheras={loncherasPorUbicacion.get(u.id) ?? []}
                          ocupacion={ocupacion}
                          onClick={() => setDetalleUbicacion(u)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Diálogo: nueva ubicación */}
      <DialogoNuevaUbicacion
        open={nuevoOpen}
        ubicaciones={ubicaciones}
        onOpenChange={setNuevoOpen}
        onCreada={() => {
          setNuevoOpen(false)
          cargar()
        }}
      />

      {/* Panel de detalle de la ubicación */}
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
                  {REP_ETIQUETA_TIPO[detalleUbicacion.tipo]} · Piso {detalleUbicacion.piso} · Nivel {detalleUbicacion.nivel} · Posición {detalleUbicacion.secuencia}
                  {detalleUbicacion.nota ? ` — ${detalleUbicacion.nota}` : ''}
                </DialogDescription>
              </DialogHeader>
              <DetalleLoncheras
                ubicacion={detalleUbicacion}
                loncheras={loncherasPorUbicacion.get(detalleUbicacion.id) ?? []}
                puedeEliminar={puedeEliminar}
                onEliminada={() => {
                  setDetalleUbicacion(null)
                  cargar()
                }}
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
   CELDA DE POSICIÓN EN EL MAPA
   ═══════════════════════════════════════════════════════════════════ */

function CeldaUbicacion({
  ubicacion,
  loncheras,
  ocupacion,
  onClick,
}: {
  ubicacion: RepUbicacion
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>
  ocupacion: Map<string, RepOcupacionLonchera>
  onClick: () => void
}) {
  const llena = loncheras.some((l) => (ocupacion.get(l.id)?.articulos ?? 0) >= REP_MAX_ARTICULOS_LONCHERA)
  const conStock = loncheras.some((l) => (ocupacion.get(l.id)?.articulos ?? 0) > 0)
  const enTransito = loncheras.some((l) => (ocupacion.get(l.id)?.enTransito ?? 0) > 0)

  return (
    <button
      onClick={onClick}
      className={`relative rounded-lg border px-3 py-2 text-left transition-colors ${COLOR_TIPO[ubicacion.tipo]}`}
      title={`${ubicacion.codigo}${ubicacion.nota ? ` — ${ubicacion.nota}` : ''}`}
    >
      <span className="block font-mono text-xs font-extrabold leading-none">{ubicacion.codigo}</span>
      <span className="mt-1 flex items-center gap-1.5">
        {loncheras.map((l) => {
          const o = ocupacion.get(l.id)
          return (
            <span key={l.lado} className="text-[10px] font-bold opacity-80">
              {l.lado}: {o?.articulos ?? 0}/{REP_MAX_ARTICULOS_LONCHERA}
            </span>
          )
        })}
      </span>
      {/* Semáforo: llena (rojo) · en tránsito (ámbar) · con stock (verde) */}
      <span
        className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full ${
          llena ? 'bg-rose-500' : enTransito ? 'bg-amber-400' : conStock ? 'bg-emerald-500' : 'bg-slate-300'
        }`}
      />
    </button>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DETALLE: CONTENIDO DE LAS LONCHERAS DE LA POSICIÓN
   ═══════════════════════════════════════════════════════════════════ */

function DetalleLoncheras({
  ubicacion,
  loncheras,
  puedeEliminar,
  onEliminada,
}: {
  ubicacion: RepUbicacion
  loncheras: Array<{ id: string; lado: 'A' | 'B' }>
  puedeEliminar: boolean
  onEliminada: () => void
}) {
  const [contenido, setContenido] = useState<Map<string, Awaited<ReturnType<typeof repStockDeLonchera>>>>(new Map())
  const [loading, setLoading] = useState(false)
  const [eliminando, setEliminando] = useState(false)

  useEffect(() => {
    let vivo = true
    setLoading(true)
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
      setLoading(false)
    })
    return () => { vivo = false }
  }, [loncheras])

  async function eliminar() {
    if (!confirm(`¿Eliminar la ubicación ${ubicacion.codigo}? Sus loncheras y stock asociado se borran en cascada.`)) return
    setEliminando(true)
    try {
      await repEliminarUbicacion(ubicacion.id)
      toast.success(`Ubicación ${ubicacion.codigo} eliminada`)
      onEliminada()
    } catch (err: unknown) {
      toast.error('No se pudo eliminar', { description: mensajeError(err) })
    } finally {
      setEliminando(false)
    }
  }

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

      {puedeEliminar && (
        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" onClick={eliminar} disabled={eliminando} className="gap-1.5 text-rose-600 border-rose-200 hover:bg-rose-50">
            {eliminando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Eliminar ubicación
          </Button>
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DIÁLOGO NUEVA UBICACIÓN (el código se normaliza en vivo)
   ═══════════════════════════════════════════════════════════════════ */

function DialogoNuevaUbicacion({
  open,
  ubicaciones,
  onOpenChange,
  onCreada,
}: {
  open: boolean
  ubicaciones: RepUbicacion[]
  onOpenChange: (open: boolean) => void
  onCreada: () => void
}) {
  const [tipo, setTipo] = useState<RepTipoUbicacion>('rack')
  const [piso, setPiso] = useState('1')
  const [nivel, setNivel] = useState('1')
  const [nota, setNota] = useState('')
  const [busy, setBusy] = useState(false)

  const pisoN = Math.max(1, Math.floor(Number(piso) || 1))
  const nivelN = tipo === 'pasillo' ? 0 : Math.max(0, Math.floor(Number(nivel) || 0))
  // Secuencia sugerida: siguiente dentro del grupo (tipo, piso, nivel)
  const secuenciaSugerida =
    ubicaciones.filter((u) => u.tipo === tipo && u.piso === pisoN && u.nivel === nivelN).reduce((m, u) => Math.max(m, u.secuencia), 0) + 1
  const codigoPreview = repCodigoUbicacion(tipo, pisoN, nivelN, secuenciaSugerida)

  async function crear() {
    setBusy(true)
    try {
      const u = await repCrearUbicacion({ tipo, piso: pisoN, nivel: nivelN, secuencia: secuenciaSugerida, nota })
      toast.success(`Ubicación ${u.codigo} creada`, {
        description: tipo === 'rack' ? 'Se crearon las loncheras A y B automáticamente.' : 'Se creó la lonchera A automáticamente.',
      })
      onCreada()
    } catch (err: unknown) {
      toast.error('No se pudo crear', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Navigation2 className="h-5 w-5 text-violet-600" /> Nueva ubicación
          </DialogTitle>
          <DialogDescription>
            Las loncheras se crean solas: rack → A y B · los demás tipos → A.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={(v) => setTipo(v as RepTipoUbicacion)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="rack">Rack (estantería, 2 loncheras)</SelectItem>
                <SelectItem value="pasillo">Pasillo (bajo nivel 1)</SelectItem>
                <SelectItem value="zona">Zona de almacenamiento</SelectItem>
                <SelectItem value="prepicking">Pre-picking (salida del día)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ub-piso">Piso</Label>
              <Input id="ub-piso" inputMode="numeric" value={piso} onChange={(e) => setPiso(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ub-nivel">Nivel {tipo === 'pasillo' && '(fijo: 0)'}</Label>
              <Input
                id="ub-nivel"
                inputMode="numeric"
                value={tipo === 'pasillo' ? '0' : nivel}
                disabled={tipo === 'pasillo'}
                onChange={(e) => setNivel(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ub-nota">Nota (opcional)</Label>
            <Input id="ub-nota" value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Ej. repuestos de motor" />
          </div>
          <div className="rounded-lg bg-slate-50 border px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-slate-500">Código generado</span>
            <span className="font-mono text-sm font-extrabold text-slate-900">{codigoPreview}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={crear} disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Crear {codigoPreview}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
