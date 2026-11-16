'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — TRÁNSITO · Diálogo de UBICACIÓN.
 *
 * Paridad con el Tránsito de Insumos (pedido 2026-11-16): elegir DESTINO
 * (sector del almacén) → MAPA VISUAL con selección por clic (o búsqueda
 * directa) → LADO (A/B si la posición lo tiene) → confirmación → ejecución
 * secuencial: cada línea llama a la RPC atómica rep_ubicar_desde_transito
 * (valida capacidad 15, upsert de stock, kardex 'ingreso' con el documento,
 * marca la línea). Errores por línea sin bloquear a las demás.
 *
 * Diferencias (reglas REP, intencionales):
 *   · El destino NO es Rack vs Piso (REP tiene un solo almacén): es el
 *     SECTOR — Racks 1er piso / Racks 2do piso / Zonas.
 *   · La LÍNEA viaja COMPLETA (la RPC no acepta parcial): la cantidad es
 *     informativa, sin caja de edición.
 *   · El mapa es el de Ubicaciones (mapa.tsx) con el resaltado «marcadas»:
 *     las posiciones donde el artículo escaneado ya tiene stock.
 */

import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangle, CheckCircle2, Layers, Loader2, PackageCheck, Search, Warehouse, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  repUbicarDesdeTransito,
  repMapaAlmacen,
  repStockDeArticulo,
  type RepLineaConDocumento,
  type RepMapaAlmacen,
} from '@/lib/rackly/rep/rep-client'
import { REP_ORDEN_ZONAS, repLadosDeTipo, type RepUbicacion } from '@/lib/rackly/rep/rep-tipos'
import { mensajeError, esErrorRpc } from '@/lib/rackly/errores'
import { SelectorUbicacionRep } from '@/components/rackly/rep/ubicaciones/SelectorUbicacionRep'
import {
  LeyendaMapa,
  SectorRacks,
  SectorZonas,
  type RackVista,
  type ZonaVista,
} from '@/components/rackly/rep/ubicaciones/mapa'

type Paso = 'destino' | 'mapaRacks' | 'mapaZonas' | 'lado' | 'confirmar' | 'ejecutando' | 'resultado'

type ResultadoPorLinea = {
  linea: RepLineaConDocumento
  ok: boolean
  mensaje: string
}

type LoncheraRef = { id: string; lado: 'A' | 'B' }

export function DialogoUbicarRep({
  items,
  usuario,
  turno,
  onListo,
  onCancelar,
}: {
  items: RepLineaConDocumento[]
  usuario: { id: string; nombre: string }
  turno: string
  onListo: () => void
  onCancelar: () => void
}) {
  const [paso, setPaso] = useState<Paso>('destino')
  const [mapa, setMapa] = useState<RepMapaAlmacen | null>(null)
  const [cargandoMapa, setCargandoMapa] = useState(true)
  const [piso, setPiso] = useState<1 | 2>(1)
  const [ubicacion, setUbicacion] = useState<RepUbicacion | null>(null)
  const [lado, setLado] = useState<'A' | 'B'>('A')
  const [resultados, setResultados] = useState<ResultadoPorLinea[]>([])
  /** Posiciones donde el artículo escaneado ya tiene stock (resaltado). */
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set())

  const esBatch = items.length > 1
  const titulo = esBatch ? `Ubicar ${items.length} líneas juntas` : 'Ubicar artículo'
  const documento = items[0]?.guia || items[0]?.oc || items[0]?.dam || ''

  // ── Mapa del almacén: UNA ronda al abrir el diálogo ──
  useEffect(() => {
    let cancelado = false
    // Sin setCargandoMapa(true) síncrono: el estado inicial YA es true y el
    // efecto corre una sola vez al montar (regla react-hooks/set-state-in-effect).
    repMapaAlmacen()
      .then((m) => {
        if (cancelado) return
        setMapa(m)
        setCargandoMapa(false)
      })
      .catch(() => {
        if (cancelado) return
        setCargandoMapa(false)
        toast.error('No se pudo cargar el mapa del almacén')
      })
    return () => {
      cancelado = true
    }
  }, [])

  // ── Resaltado: dónde ya vive el artículo (solo escaneo/unitario) ──
  useEffect(() => {
    if (esBatch || !items[0]) return
    let cancelado = false
    repStockDeArticulo(items[0].articulo_id)
      .then((filas) => {
        if (cancelado) return
        setMarcadas(new Set(filas.map((f) => f.ubicacionId)))
      })
      .catch(() => {
        // Informativo: sin resaltado el flujo sigue igual.
      })
    return () => {
      cancelado = true
    }
  }, [esBatch, items])

  // ── Agrupación del mapa (misma que UbicacionesModule) ──
  const loncherasPorUbicacion = useMemo(() => {
    const porUbi = new Map<string, LoncheraRef[]>()
    if (!mapa) return porUbi
    for (const [, l] of mapa.loncheras) {
      const arr = porUbi.get(l.ubicacion_id) ?? []
      arr.push({ id: l.id, lado: l.lado })
      porUbi.set(l.ubicacion_id, arr)
    }
    for (const arr of porUbi.values()) arr.sort((x, y) => x.lado.localeCompare(y.lado))
    return porUbi
  }, [mapa])

  const racksPiso = useMemo(() => {
    const porRack = new Map<number, Map<number, RepUbicacion[]>>()
    for (const u of mapa?.ubicaciones ?? []) {
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
  }, [mapa, piso])

  const zonasVista = useMemo(() => {
    const porZona = new Map<string, RepUbicacion[]>()
    for (const u of mapa?.ubicaciones ?? []) {
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
  }, [mapa])

  const ubicacionesActivas = useMemo(
    () => (mapa?.ubicaciones ?? []).filter((u) => u.activo),
    [mapa]
  )

  /** Lados de la posición elegida (rack = A y B; zonas = A). */
  const ladosDe = (u: RepUbicacion) => repLadosDeTipo(u.tipo)

  /** Clic en el mapa (o búsqueda): guarda la posición y pide lado si toca. */
  function elegirUbicacion(u: RepUbicacion) {
    const lados = ladosDe(u)
    if (lados.length === 0) {
      toast.error(`${u.codigo}: la posición no tiene loncheras disponibles`)
      return
    }
    setUbicacion(u)
    setLado(lados[0])
    setPaso(lados.length > 1 ? 'lado' : 'confirmar')
  }

  /** Búsqueda directa (combobox): resuelve a la posición y sigue el flujo. */
  const busquedaElegida = (ubicacionId: string) => {
    const u = ubicacionesActivas.find((x) => x.id === ubicacionId)
    if (u) elegirUbicacion(u)
  }

  /** Lonchera concreta de la posición+lado (null si no existe). */
  const loncheraDe = useMemo(() => {
    if (!ubicacion || !mapa) return null
    const lons = loncherasPorUbicacion.get(ubicacion.id) ?? []
    return lons.find((l) => l.lado === lado) ?? null
  }, [ubicacion, lado, loncherasPorUbicacion, mapa])

  const confirmarEnvios = async () => {
    if (!ubicacion || !loncheraDe || !mapa) return
    setPaso('ejecutando')
    const res: ResultadoPorLinea[] = []
    for (const l of items) {
      try {
        const r = await repUbicarDesdeTransito({ lineaId: l.id, loncheraId: loncheraDe.id })
        res.push({
          linea: l,
          ok: true,
          mensaje: `${r.ubicacion} · lado ${r.lado}`,
        })
        if (r.enOtraLonchera) {
          toast.warning(`${l.codigo} ya vivía en ${r.enOtraLonchera.ubicacion} lado ${r.enOtraLonchera.lado}`, {
            description: 'Excepción controlada: el ingreso se registró igual. Revísalo en el mapa.',
            duration: 10000,
          })
        }
      } catch (err) {
        if (esErrorRpc(err, 'LINEA_YA_UBICADA')) {
          res.push({ linea: l, ok: true, mensaje: 'Ya estaba ubicado (reintento)' })
        } else {
          res.push({ linea: l, ok: false, mensaje: mensajeError(err) })
        }
      }
    }
    setResultados(res)
    setPaso('resultado')
    const okN = res.filter((r) => r.ok).length
    if (okN === res.length) {
      toast.success(`Ubicación${esBatch ? 'es' : ''} registrada${esBatch ? 's' : ''} (${okN})`, {
        description: 'Stock y kardex de ingreso registrados con el documento de la guía.',
      })
    } else if (okN > 0) {
      toast.warning(`${okN} de ${res.length} ubicaciones registradas`)
    }
  }

  const cerrar = () => {
    if (resultados.length > 0) onListo()
    else onCancelar()
  }

  const ocupacionLado = (u: RepUbicacion, l: 'A' | 'B'): number => {
    const lon = (loncherasPorUbicacion.get(u.id) ?? []).find((x) => x.lado === l)
    if (!lon) return 0
    return mapa?.ocupacion.get(lon.id)?.articulos ?? 0
  }

  return (
    <Dialog open onOpenChange={(open) => {
      // Durante EJECUCIÓN el diálogo no se cierra (ESC/click-fuera): el bucle
      // de RPCs sigue en vuelo — cerrarlo dejaba al usuario sin resultados.
      if (!open && paso === 'ejecutando') return
      if (!open) cerrar()
    }}>
      <DialogContent className="max-w-3xl max-h-[92dvh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <PackageCheck className="h-4 w-4 text-fuchsia-600" />
            {titulo}
          </DialogTitle>
          <DialogDescription>
            Recepción → {paso === 'destino' || paso === 'mapaRacks' || paso === 'mapaZonas' ? 'Ubicación' : `${ubicacion?.codigo ?? ''} · lado ${lado}`} ·{' '}
            {items.length} línea{esBatch ? 's' : ''}{documento && !esBatch ? ` · doc ${documento}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* ── PASO 1: destino (sector del almacén) ── */}
          {paso === 'destino' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                ¿A dónde entra la mercadería? Se abrirá el mapa visual del almacén para elegir la posición.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {([
                  { sector: 'racks1', titulo: 'RACKS · 1ER PISO', detalle: 'Rack · Nivel · Posición · Lado', grad: 'from-violet-500 to-indigo-600', borde: 'border-violet-200 bg-violet-50/60 hover:border-violet-400 hover:bg-violet-100/60' },
                  { sector: 'racks2', titulo: 'RACKS · 2DO PISO', detalle: 'Rack · Nivel · Posición · Lado', grad: 'from-indigo-500 to-blue-600', borde: 'border-indigo-200 bg-indigo-50/60 hover:border-indigo-400 hover:bg-indigo-100/60' },
                  { sector: 'zonas', titulo: 'ZONAS', detalle: 'Zona · Posición · Lado', grad: 'from-sky-500 to-blue-600', borde: 'border-sky-200 bg-sky-50/60 hover:border-sky-400 hover:bg-sky-100/60' },
                ] as const).map((c) => (
                  <button
                    key={c.sector}
                    onClick={() => {
                      if (c.sector === 'racks1') { setPiso(1); setPaso('mapaRacks') }
                      else if (c.sector === 'racks2') { setPiso(2); setPaso('mapaRacks') }
                      else setPaso('mapaZonas')
                    }}
                    className={`rounded-2xl border-2 transition-all p-5 text-left space-y-2 ${c.borde}`}
                  >
                    <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${c.grad} flex items-center justify-center shadow-md`}>
                      {c.sector === 'zonas' ? <Layers className="h-5 w-5 text-white" /> : <Warehouse className="h-5 w-5 text-white" />}
                    </div>
                    <p className="font-extrabold text-slate-900">{c.titulo}</p>
                    <p className="text-xs text-slate-500">{c.detalle}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── PASO 2: mapa visual ── */}
          {(paso === 'mapaRacks' || paso === 'mapaZonas') && (
            <div className="space-y-3">
              {/* Búsqueda directa: 1 869 posiciones — el clic del mapa y el
                  combobox son la MISMA selección (paridad con el selector viejo). */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                  <Search className="h-3.5 w-3.5" /> ¿Prefieres buscarla?
                </div>
                <SelectorUbicacionRep
                  ubicaciones={ubicacionesActivas}
                  value={ubicacion?.id ?? ''}
                  onChange={busquedaElegida}
                />
                <div className="ml-auto">
                  <Button variant="outline" size="sm" onClick={() => setPaso('destino')} className="gap-1">
                    <XCircle className="h-4 w-4" /> Cambiar destino
                  </Button>
                </div>
              </div>
              {cargandoMapa ? (
                <div className="flex items-center justify-center py-12 text-slate-400">
                  <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando mapa del almacén…
                </div>
              ) : !mapa ? (
                <p className="text-sm text-rose-600 text-center py-8">No se pudo cargar el mapa. Cancela y reintenta.</p>
              ) : (
                <>
                  {paso === 'mapaRacks' ? (
                    <SectorRacks
                      piso={piso}
                      setPiso={setPiso}
                      racks={racksPiso}
                      totalSector={racksPiso.reduce((s, r) => s + r.niveles.reduce((t, n) => t + n.posiciones.length, 0), 0)}
                      loncherasPorUbicacion={loncherasPorUbicacion}
                      ocupacion={mapa.ocupacion}
                      onAbrir={elegirUbicacion}
                      marcadas={marcadas}
                    />
                  ) : (
                    <SectorZonas
                      zonas={zonasVista}
                      loncherasPorUbicacion={loncherasPorUbicacion}
                      ocupacion={mapa.ocupacion}
                      onAbrir={elegirUbicacion}
                      marcadas={marcadas}
                    />
                  )}
                  <LeyendaMapa />
                </>
              )}
            </div>
          )}

          {/* ── PASO 3: lado (solo posiciones con A y B) ── */}
          {paso === 'lado' && ubicacion && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Posición <span className="font-mono font-extrabold">{ubicacion.codigo}</span> — ¿qué lado?
              </p>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                {ladosDe(ubicacion).map((l) => (
                  <button
                    key={l}
                    onClick={() => { setLado(l); setPaso('confirmar') }}
                    className="rounded-2xl border-2 border-slate-200 bg-slate-50/60 hover:border-fuchsia-400 hover:bg-fuchsia-50/60 transition-all p-4 text-left space-y-1"
                  >
                    <p className="font-extrabold text-slate-900">Lado {l}</p>
                    <p className="text-xs text-slate-500">
                      {ocupacionLado(ubicacion, l)} artículo(s) de 15
                    </p>
                  </button>
                ))}
              </div>
              <Button variant="outline" onClick={() => setPaso(ubicacion.sector === 'zonas' ? 'mapaZonas' : 'mapaRacks')} className="gap-1">
                <XCircle className="h-4 w-4" /> Cambiar posición
              </Button>
            </div>
          )}

          {/* ── PASO 4: confirmación ── */}
          {paso === 'confirmar' && ubicacion && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm">
                <p className="font-bold text-slate-900">
                  Destino: {ubicacion.codigo} · lado {lado}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {ocupacionLado(ubicacion, lado)} artículo(s) ya en esa lonchera (máx. 15) · la RPC valida capacidad y avisa si el artículo vive en otra lonchera.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-[40dvh] overflow-y-auto">
                {items.map((l) => (
                  <div key={l.id} className="p-3 flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900">{l.codigo}</p>
                      <p className="text-xs text-slate-500 truncate">{l.descripcion}</p>
                      <p className="text-[11px] text-slate-400">
                        Guía {l.guia || '—'}{l.oc ? ` · OC ${l.oc}` : ''}{l.dam ? ` · DAM ${l.dam}` : ''}{l.proveedor ? ` · ${l.proveedor}` : ''}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs font-bold shrink-0">
                      {l.cantidad.toLocaleString('es-PE')} {l.und}
                    </Badge>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-slate-500">
                Cada línea se ubica COMPLETA (la RPC de Repuestos no acepta parcial): suma al stock, registra el kardex de ingreso con el documento y marca la línea como ubicada.
              </p>
            </div>
          )}

          {/* ── PASO 5: ejecutando ── */}
          {paso === 'ejecutando' && (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-fuchsia-600" />
              <p className="text-sm font-semibold text-slate-700">Registrando ubicaciones…</p>
              <p className="text-xs text-slate-400">No cierres esta ventana</p>
            </div>
          )}

          {/* ── PASO 6: resultado ── */}
          {paso === 'resultado' && (
            <div className="space-y-3">
              {resultados.map((r) => (
                <div
                  key={r.linea.id}
                  className={`rounded-xl border p-3 flex items-start gap-2.5 ${
                    r.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60'
                  }`}
                >
                  {r.ok ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">
                      {r.linea.codigo} — {r.linea.cantidad.toLocaleString('es-PE')} {r.linea.und}
                    </p>
                    <p className={`text-xs ${r.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{r.mensaje}</p>
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-slate-500">
                La lista «Por ubicar» se actualiza al cerrar este diálogo.
              </p>
            </div>
          )}
        </div>

        {/* Pie de acciones */}
        <div className="px-5 py-3 border-t bg-white shrink-0 flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-400 truncate">
            {turno} · {usuario.nombre}
          </div>
          <div className="flex gap-2">
            {(paso === 'mapaRacks' || paso === 'mapaZonas') && (
              <Button variant="outline" onClick={() => setPaso('destino')} className="gap-1">
                <XCircle className="h-4 w-4" /> Cambiar destino
              </Button>
            )}
            {paso === 'lado' && (
              <Button variant="outline" onClick={() => setPaso(ubicacion?.sector === 'zonas' ? 'mapaZonas' : 'mapaRacks')} className="gap-1">
                <XCircle className="h-4 w-4" /> Cambiar posición
              </Button>
            )}
            {paso === 'confirmar' && (
              <>
                <Button variant="outline" onClick={onCancelar}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => void confirmarEnvios()}
                  disabled={!loncheraDe}
                  className="gap-1.5 font-semibold bg-fuchsia-600 hover:bg-fuchsia-700"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Confirmar {esBatch ? `(${items.length})` : ''}
                </Button>
              </>
            )}
            {paso === 'resultado' && (
              <Button onClick={cerrar} className="font-semibold">
                Listo
              </Button>
            )}
            {paso === 'destino' && (
              <Button variant="outline" onClick={onCancelar}>
                Cancelar
              </Button>
            )}
          </div>
        </div>

        {/* Aviso discreto mientras el mapa carga en pasos previos */}
        {cargandoMapa && paso === 'destino' && (
          <div className="px-5 pb-3 -mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
            <AlertTriangle className="h-3 w-3" /> Preparando el mapa del almacén en segundo plano…
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
