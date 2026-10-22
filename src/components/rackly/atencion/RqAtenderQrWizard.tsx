'use client'

/**
 * RACKLY — Atención a Línea · Wizard "Atender con QR" (puente con Tránsito).
 *
 * Modo lote continuo (prompt v1.0 §4.2/§4.3, decisiones del usuario):
 *   · La cámara (o pistola USB) agrega UNA TOMA por escaneo — la cantidad se
 *     jala de Recepción (cada paleta es UNA fila con SU cantidad); al final
 *     se registra la SUMA de todo lo escaneado como LA atención.
 *   · Ruta por toma determinística: pendiente > 0 → TRÁNSITO (descuenta la
 *     guía); ya transferida → POSICIÓN (salida de la ubicación de sus envíos,
 *     con 1 clic de confirmación y validación de saldo de las RPC nativas).
 *   · FEFO en toda ambigüedad; jamás dos veces la misma paleta; código ajeno
 *     a la RQ rechazado siempre. La lógica pura vive en atencion-qr-lote.ts.
 *   · La confirmación única llama la RPC rq_atender_lote (all-or-nothing).
 *
 * Ruta manual (sin QR): lista las guías del código ordenadas FEFO y agrega
 * filas al carrito con las mismas reglas — nunca auto-elegir en silencio.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { toast } from 'sonner'
import {
  ScanLine,
  Keyboard,
  ListChecks,
  ClipboardCheck,
  Trash2,
  Loader2,
  MapPin,
  Package,
  AlertTriangle,
  Camera,
  Search,
  ArrowRightLeft,
  Warehouse,
  Layers3,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import { LectorQR } from '@/components/rackly/transito/LectorQR'
import { fetchStockPorCodigoRPC } from '@/lib/rackly/kardex'
import { stockPisoBuscar } from '@/lib/piso/api'
import { calcularTurno } from '@/lib/rackly/turno'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'
import { claveCeldaRack, EPS_TRANSITO, type ArticuloTransito } from '@/lib/rackly/transito-core'
import { listarArticulosPorGuiaId, listarArticulosPorCodigo } from '@/lib/rackly/transito'
import {
  agregarFilaManual,
  ordenarFEFO,
  resolverToma,
  totalesCarrito,
  ubicacionesDeFila,
  payloadDeTexto,
  type TomaQR,
} from '@/lib/rackly/atencion-qr-lote'
import { atenderLotePuente, type TomaPuentePayload } from '@/lib/rackly/rq-atencion'

type ItemWizard = {
  id: string
  codigo: string
  descripcion: string
  unidad: string
  cantidad: number
  cantidadAtendida: number
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  rqNumero: string
  item: ItemWizard
  /** Refresca el detalle de la RQ tras registrar el lote. */
  onRegistrado: () => void
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

type TabActivo = 'escanear' | 'carrito' | 'resumen'

export function RqAtenderQrWizard({ open, onOpenChange, rqNumero, item, onRegistrado }: Props) {
  const { perfil } = useAuth()
  const [tab, setTab] = useState<TabActivo>('escanear')
  const [tomas, setTomas] = useState<TomaQR[]>([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [cargandoFilas, setCargandoFilas] = useState(false)
  const [manual, setManual] = useState('')
  const [registrando, setRegistrando] = useState(false)
  const [confirmarAbierto, setConfirmarAbierto] = useState(false)
  const [confirmaExcedente, setConfirmaExcedente] = useState(false)

  // Ruta manual: filas del código ordenadas FEFO
  const [filasManual, setFilasManual] = useState<ArticuloTransito[] | null>(null)
  const [buscandoManual, setBuscandoManual] = useState(false)

  // Saldos actuales de posiciones rack (pre-chequeo — la RPC revalida)
  const [saldosRack, setSaldosRack] = useState<Record<string, number>>({})

  /** Cache de filas por clave (guía:{guiaId} | codigo:{codigo}) — 50 tomas sin re-descargar. */
  const cacheRef = useRef(new Map<string, ArticuloTransito[]>())
  const resolviendoRef = useRef(false)
  const manualRef = useRef<HTMLInputElement | null>(null)

  const pendienteRq = Math.max(item.cantidad - item.cantidadAtendida, 0)
  const totales = useMemo(() => totalesCarrito(tomas), [tomas])
  const excede = totales.total > pendienteRq + 0.0005

  // Líneas POSICIÓN-rack sin saldo suficiente (bloquean la confirmación)
  const lineasSinSaldo = useMemo(() => {
    return tomas.filter((t) => {
      if (t.ruta !== 'posicion' || !t.origen?.rack) return false
      const clave = claveCeldaRack(t.origen.rack)
      const saldo = saldosRack[clave]
      return saldo !== undefined && t.cantidad > saldo + 0.0005
    })
  }, [tomas, saldosRack])

  // Reset al abrir/cerrar
  useEffect(() => {
    if (open) {
      setTab('escanear')
      setTomas([])
      setManual('')
      setConfirmaExcedente(false)
      setFilasManual(null)
      setSaldosRack({})
      cacheRef.current = new Map()
    }
  }, [open])

  /** Filas de la guía del payload (con cache) — rescate igual que Tránsito. */
  const obtenerFilas = useCallback(async (guiaId: string, numeroDocumento: string) => {
    const clave = `guia:${guiaId}`
    const enCache = cacheRef.current.get(clave)
    if (enCache) return enCache
    setCargandoFilas(true)
    try {
      const filas = await listarArticulosPorGuiaId(guiaId)
      cacheRef.current.set(clave, filas)
      return filas
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error(`No se pudo leer la guía ${numeroDocumento || ''}`.trim(), { description: message })
      return []
    } finally {
      setCargandoFilas(false)
    }
  }, [])

  /** Pre-chequeo de saldos rack cuando entra la primera línea de posición. */
  const asegurarSaldos = useCallback(async () => {
    if (Object.keys(saldosRack).length > 0) return
    try {
      const filas = await fetchStockPorCodigoRPC(item.codigo, false)
      const map: Record<string, number> = {}
      for (const f of filas ?? []) map[claveCeldaRack(f)] = f.stock
      setSaldosRack(map)
    } catch {
      // Sin pre-chequeo no se bloquea nada: la RPC nativa valida al confirmar.
    }
  }, [item.codigo])

  /** Puerta única de tomas: cámara o pistola. Nunca interrumpe la sesión. */
  const procesarTexto = useCallback(
    async (texto: string) => {
      if (resolviendoRef.current) return
      resolviendoRef.current = true
      try {
        const payload = payloadDeTexto(texto)
        if (!payload) {
          toast.error('El QR no es un rótulo de Rackly', { description: texto.slice(0, 60) })
          return
        }
        if (payload.codigo.trim().toUpperCase() !== item.codigo.trim().toUpperCase()) {
          toast.error('Ese código no pertenece a este material de la RQ', {
            description: `QR=${payload.codigo} · RQ=${item.codigo}`,
          })
          return
        }
        let filas: ArticuloTransito[]
        if (payload.guiaId) {
          filas = await obtenerFilas(payload.guiaId, payload.numeroDocumento)
        } else {
          // Rótulo sin guia_id: resuelve por código (todas las guías del material)
          const clave = `codigo:${item.codigo.toUpperCase()}`
          const enCache = cacheRef.current.get(clave)
          if (enCache) filas = enCache
          else {
            setCargandoFilas(true)
            try {
              filas = await listarArticulosPorCodigo(item.codigo)
              cacheRef.current.set(clave, filas)
            } catch (err: unknown) {
              toast.error('No se pudo leer el listado de guías', {
                description: err instanceof Error ? err.message : 'Error desconocido',
              })
              return
            } finally {
              setCargandoFilas(false)
            }
          }
        }

        setTomas((carritoActual) => {
          const res = resolverToma({
            texto,
            codigoRq: item.codigo,
            filas,
            carrito: carritoActual,
            nuevoUuid,
          })
          if (res.estado === 'rechazada') {
            toast.error('Toma rechazada', { description: res.mensaje })
            return carritoActual
          }
          const t = res.toma
          const esNuevaPosicion = t.ruta === 'posicion'
          toast.success(
            `Toma ${t.cantidad === t.cantidadOriginal ? `${fmt(t.cantidad)} ${t.unidad}` : `${fmt(t.cantidad)} ${t.unidad} (ajustable)`}`,
            {
              description: `Guía ${t.numeroDocumento || t.fecha}${t.paleta != null ? ` · Paleta ${t.paleta}` : ''}${
                t.lote ? ` · Lote ${t.lote}` : ''
              } · ${t.ruta === 'transito' ? 'se descuenta de la guía' : `salida de ${t.origen?.etiqueta ?? 'posición'}`}`,
            }
          )
          if (esNuevaPosicion) void asegurarSaldos()
          return [...carritoActual, t]
        })
      } finally {
        resolviendoRef.current = false
      }
    },
    [item.codigo, obtenerFilas, asegurarSaldos]
  )

  /** Carga el listado FEFO del código para la ruta manual. */
  const cargarManual = useCallback(async () => {
    if (filasManual) return
    setBuscandoManual(true)
    try {
      const filas = await listarArticulosPorCodigo(item.codigo)
      cacheRef.current.set(`codigo:${item.codigo.toUpperCase()}`, filas)
      setFilasManual(filas)
    } catch (err: unknown) {
      toast.error('No se pudo cargar el listado de guías', {
        description: err instanceof Error ? err.message : 'Error desconocido',
      })
    } finally {
      setBuscandoManual(false)
    }
  }, [filasManual, item.codigo])

  const agregarManual = useCallback(
    (fila: ArticuloTransito) => {
      setTomas((carritoActual) => {
        const res = agregarFilaManual(fila, carritoActual, nuevoUuid)
        if (res.estado === 'rechazada') {
          toast.error('No se agregó', { description: res.mensaje })
          return carritoActual
        }
        const t = res.toma
        toast.success(`Toma ${fmt(t.cantidad)} ${t.unidad}`, {
          description: `Guía ${t.numeroDocumento || t.fecha}${t.paleta != null ? ` · Paleta ${t.paleta}` : ''} · ${
            t.ruta === 'transito' ? 'se descuenta de la guía' : `salida de ${t.origen?.etiqueta ?? 'posición'}`
          }`,
        })
        if (t.ruta === 'posicion') void asegurarSaldos()
        return [...carritoActual, t]
      })
    },
    [asegurarSaldos]
  )

  /** Cambiar la ubicación de una línea posición (entre las de SUS envíos). */
  const cambiarOrigen = useCallback((uuid: string, indice: number) => {
    setTomas((prev) =>
      prev.map((t) => {
        if (t.uuid !== uuid) return t
        const opciones = t.opcionesOrigen
        const elegida = opciones[indice]
        if (!elegida) return t
        return { ...t, origen: elegida }
      })
    )
  }, [])

  async function ejecutarRegistro() {
    if (tomas.length === 0 || lineasSinSaldo.length > 0) return
    setConfirmarAbierto(false)
    setRegistrando(true)
    const batchUuid = nuevoUuid()
    const payload: TomaPuentePayload[] = tomas.map((t) => ({
      uuid: t.uuid,
      recepcion_id: t.recepcionId,
      ruta: t.ruta,
      cantidad: t.cantidad,
      rack: t.origen?.rack ?? null,
      piso: t.origen?.piso ?? null,
      ubicacion: t.origen?.etiqueta ?? '',
    }))
    try {
      const r = await atenderLotePuente({
        itemId: item.id,
        batchUuid,
        tomas: payload,
        confirmaExcedente: excede ? confirmaExcedente : true,
        turno: calcularTurno(),
        usuario: {
          id: perfil?.id ?? '',
          nombre: perfil?.nombre || perfil?.correo || '',
          correo: perfil?.correo ?? '',
        },
      })
      if (!r.ok) {
        toast.error('El lote NO se registró', {
          description: r.fallo?.toma
            ? `${r.fallo.mensaje} (toma ${r.fallo.toma.slice(0, 8)}…)`
            : r.fallo?.mensaje ?? 'Error desconocido',
        })
        return
      }
      if (r.duplicado) {
        toast.info('Este lote ya estaba registrado — no se duplicó nada')
      } else {
        toast.success(`Atención registrada: ${fmt(r.total_atendido ?? totales.total)} ${item.unidad}`, {
          description: `${totales.tomas} tomas · Guías en tránsito: ${fmt(totales.transito)} · Salidas de posición: ${fmt(totales.posicion)}`,
        })
      }
      onRegistrado()
      onOpenChange(false)
    } catch (err: unknown) {
      toast.error('No se pudo registrar el lote', {
        description: err instanceof Error ? err.message : 'Error desconocido',
      })
    } finally {
      setRegistrando(false)
    }
  }

  const guiasManual = useMemo(() => {
    if (!filasManual) return []
    // Agrupa por guía (key) conservando el orden FEFO dentro de cada guía
    const grupos = new Map<string, ArticuloTransito[]>()
    for (const f of ordenarFEFO(filasManual)) {
      const key = f.guiaId || f.numeroDocumento || f.fecha
      const arr = grupos.get(key) ?? []
      arr.push(f)
      grupos.set(key, arr)
    }
    return [...grupos.values()]
  }, [filasManual])

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !registrando && onOpenChange(o)}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[92dvh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ScanLine className="h-4 w-4 text-teal-600" />
              Atender con QR · <span className="font-mono text-indigo-700">{item.codigo}</span>
            </DialogTitle>
            <DialogDescription className="truncate">
              RQ {rqNumero} · pide {fmt(item.cantidad)} {item.unidad} · pendiente {fmt(pendienteRq)}
            </DialogDescription>
          </DialogHeader>

          {/* Contador vivo SIEMPRE visible */}
          <div className="px-5 py-2.5 border-b bg-slate-50/60 flex flex-wrap items-center gap-1.5 text-[11px] shrink-0">
            <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-700 font-bold">
              {totales.tomas} {totales.tomas === 1 ? 'toma' : 'tomas'}
            </Badge>
            <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700 font-bold">
              Total {fmt(totales.total)} {item.unidad}
            </Badge>
            {totales.transito > 0 && (
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                Tránsito: {fmt(totales.transito)}
              </Badge>
            )}
            {totales.posicion > 0 && (
              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                Posiciones: {fmt(totales.posicion)}
              </Badge>
            )}
            {excede && (
              <Badge variant="outline" className="border-orange-300 bg-orange-50 text-orange-700 font-bold">
                <AlertTriangle className="h-3 w-3 mr-1" /> Excede por {fmt(totales.total - pendienteRq)}
              </Badge>
            )}
          </div>

          {/* Tabs */}
          <div className="px-5 pt-3 flex gap-1.5 shrink-0">
            {(
              [
                { id: 'escanear', label: 'Escanear', icon: ScanLine },
                { id: 'carrito', label: `Carrito (${totales.tomas})`, icon: ListChecks },
                { id: 'resumen', label: 'Resumen', icon: ClipboardCheck },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setTab(id)
                  if (id === 'carrito') void cargarManual()
                }}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold border transition-colors ${
                  tab === id
                    ? 'border-teal-300 bg-teal-50 text-teal-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>

          {/* Cuerpo */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* ── ESCANEAR ── */}
            {tab === 'escanear' && (
              <div className="space-y-3">
                <Button
                  onClick={() => setScannerOpen(true)}
                  className="w-full h-20 gap-3 bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white text-base"
                >
                  <Camera className="h-6 w-6" />
                  <span className="text-left">
                    <span className="block font-bold">Escanear paletas</span>
                    <span className="block text-[11px] font-normal opacity-90">
                      Cada escaneo suma su cantidad de Recepción
                    </span>
                  </span>
                </Button>

                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    const v = manual.trim()
                    if (!v) return
                    void procesarTexto(v)
                    setManual('')
                    manualRef.current?.focus()
                  }}
                  className="space-y-1.5"
                >
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <Keyboard className="h-3.5 w-3.5 text-slate-400" /> Pistola USB / entrada manual
                  </label>
                  <Input
                    ref={manualRef}
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder="Dispara la pistola o pega el QR… (Enter = 1 toma)"
                    className="h-10 font-mono text-xs"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-slate-400">
                    Cada Enter agrega una toma al carrito. Rechazos avisan sin cortar la sesión.
                  </p>
                </form>

                <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-[11px] text-slate-500 space-y-1">
                  <p className="flex items-center gap-1.5 font-semibold text-slate-600">
                    <ArrowRightLeft className="h-3.5 w-3.5" /> Cómo se registra cada toma
                  </p>
                  <p>
                    <b className="text-amber-600">Tránsito:</b> la paleta aún no tiene posición → se
                    descuenta de la guía y deja de ser transferible.
                  </p>
                  <p>
                    <b className="text-emerald-600">Posición:</b> la paleta ya fue transferida → se
                    registra la salida de esa ubicación (FEFO de lotes).
                  </p>
                </div>
              </div>
            )}

            {/* ── CARRITO ── */}
            {tab === 'carrito' && (
              <div className="space-y-3">
                {tomas.length === 0 && (
                  <p className="text-center text-sm text-slate-400 py-6">
                    Sin tomas aún — escanea o agrega sin QR abajo.
                  </p>
                )}
                {tomas.map((t) => {
                  const clave = t.origen?.rack ? claveCeldaRack(t.origen.rack) : ''
                  const saldo = clave ? saldosRack[clave] : undefined
                  const sinSaldo = t.ruta === 'posicion' && t.origen?.rack && saldo !== undefined && t.cantidad > saldo + 0.0005
                  return (
                    <div key={t.uuid} className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-slate-800">
                            {t.numeroDocumento || 'Guía sin número'}
                            {t.paleta != null && <span className="text-slate-500"> · Paleta {t.paleta}</span>}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">
                            {t.lote ? `Lote ${t.lote}` : 'Sin lote'}
                            {t.fechaVencimiento ? ` · Vence ${t.fechaVencimiento}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {t.ruta === 'transito' ? (
                            <Badge variant="outline" className="text-[9px] border-amber-200 bg-amber-50 text-amber-700">
                              Tránsito
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] border-emerald-200 bg-emerald-50 text-emerald-700">
                              Posición
                            </Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-400 hover:text-rose-600"
                            title="Quitar toma"
                            onClick={() => setTomas((prev) => prev.filter((x) => x.uuid !== t.uuid))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {t.ruta === 'posicion' && t.origen && (
                        <div className="space-y-1">
                          <p className="text-[11px] flex items-center gap-1 text-emerald-700 bg-emerald-50/60 border border-emerald-100 rounded px-2 py-1">
                            {t.origen.rack ? (
                              <Warehouse className="h-3 w-3 shrink-0" />
                            ) : (
                              <Layers3 className="h-3 w-3 shrink-0" />
                            )}
                            Salida de <b className="truncate">{t.origen.etiqueta}</b>
                            {t.origen.rack && saldo !== undefined && (
                              <span className="text-slate-400 shrink-0">· saldo {fmt(saldo)}</span>
                            )}
                          </p>
                          {t.opcionesOrigen.length > 1 && (
                            <select
                              className="w-full h-8 rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-600"
                              value={t.opcionesOrigen.findIndex((o) => o.etiqueta === t.origen?.etiqueta)}
                              onChange={(e) => cambiarOrigen(t.uuid, Number(e.target.value))}
                            >
                              {t.opcionesOrigen.map((o, oi) => (
                                <option key={`${o.etiqueta}-${oi}`} value={oi}>
                                  {o.etiqueta}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}

                      {sinSaldo && (
                        <p className="text-[11px] font-semibold text-rose-600 bg-rose-50 border border-rose-100 rounded px-2 py-1 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3 shrink-0" /> La posición ya no tiene saldo
                          suficiente — cambia la ubicación o quita la toma.
                        </p>
                      )}

                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                          {t.cantidad === t.cantidadOriginal ? 'Cantidad:' : 'Ajustada:'}
                        </span>
                        <Input
                          className="h-8 w-[110px] text-right"
                          inputMode="decimal"
                          value={String(t.cantidad)}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value.replace(',', '.'))
                            setTomas((prev) =>
                              prev.map((x) =>
                                x.uuid === t.uuid
                                  ? { ...x, cantidad: isNaN(v) ? 0 : v }
                                  : x
                              )
                            )
                          }}
                        />
                        <span className="text-[10px] text-slate-400 truncate">
                          {t.unidad} (Recepción: {fmt(t.cantidadOriginal)})
                        </span>
                      </div>
                    </div>
                  )
                })}

                {/* Ruta manual: agregar sin QR */}
                <div className="rounded-lg border border-dashed border-slate-300 p-3 space-y-2">
                  <p className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                    <Search className="h-3.5 w-3.5" /> Agregar sin QR (guías del código, FEFO)
                  </p>
                  {!filasManual && (
                    <Button variant="outline" size="sm" disabled={buscandoManual} onClick={() => void cargarManual()}>
                      {buscandoManual ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                      Buscar guías de {item.codigo}
                    </Button>
                  )}
                  {filasManual && guiasManual.length === 0 && (
                    <p className="text-[11px] text-slate-400">
                      No hay guías de este código desde el 13-10-2026 (fecha de inicio de Tránsito).
                    </p>
                  )}
                  {guiasManual.map((filas, gi) => {
                    const primera = filas[0]
                    const pendGuia = filas.reduce((s, f) => s + Math.max(f.pendiente, 0), 0)
                    return (
                      <div key={`${primera.guiaId}-${gi}`} className="rounded border border-slate-200 p-2 space-y-1">
                        <p className="text-[11px] font-bold text-slate-700">
                          {primera.numeroDocumento || `Guía del ${primera.fecha}`}
                          <span className="font-normal text-slate-400">
                            {' '}
                            · {filas.length} paleta(s) · pendiente {fmt(pendGuia)}
                          </span>
                        </p>
                        <div className="space-y-1">
                          {filas.map((f) => {
                            const enCarrito = tomas.some((t) => t.recepcionId === f.id)
                            const disponibilidad =
                              f.pendiente > EPS_TRANSITO
                                ? `tránsito: ${fmt(f.pendiente)}`
                                : f.envios.length > 0
                                  ? 'en posición'
                                  : 'sin origen'
                            return (
                              <div key={f.id} className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="truncate text-slate-500">
                                  {f.lote ? `Lote ${f.lote}` : 'Sin lote'}
                                  {f.nPaleta != null ? ` · P${f.nPaleta}` : ''}
                                  {f.fechaVencimiento ? ` · vence ${f.fechaVencimiento}` : ''} ·{' '}
                                  {disponibilidad}
                                </span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className="font-bold text-slate-700">{fmt(f.cantidad)}</span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    disabled={enCarrito}
                                    onClick={() => agregarManual(f)}
                                  >
                                    {enCarrito ? 'En lista' : '+ Agregar'}
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── RESUMEN ── */}
            {tab === 'resumen' && (
              <div className="space-y-3">
                {tomas.length === 0 ? (
                  <p className="text-center text-sm text-slate-400 py-6">
                    El carrito está vacío — escanea primero.
                  </p>
                ) : (
                  <>
                    <div className="rounded-xl border border-teal-100 bg-teal-50/50 p-3 space-y-1.5 text-sm">
                      <p className="font-bold text-slate-800">
                        Se atenderá {fmt(totales.total)} {item.unidad} en {totales.tomas} toma(s)
                      </p>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <ArrowRightLeft className="h-3.5 w-3.5 text-amber-500" />
                        Descuento de guías en tránsito: <b>{fmt(totales.transito)}</b>
                      </p>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 text-emerald-500" />
                        Salidas desde posiciones: <b>{fmt(totales.posicion)}</b>
                      </p>
                      {totales.ajustadas > 0 && (
                        <p className="text-xs text-amber-600">
                          {totales.ajustadas} toma(s) con cantidad ajustada manualmente.
                        </p>
                      )}
                      <p className="text-xs text-slate-500">
                        Pendiente de la RQ después: <b>{fmt(Math.max(pendienteRq - totales.total, 0))}</b>{' '}
                        {item.unidad}
                      </p>
                    </div>

                    {lineasSinSaldo.length > 0 && (
                      <p className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 rounded-lg p-3 flex items-start gap-1.5">
                        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                        {lineasSinSaldo.length} toma(s) de posición superan el saldo actual — corrígelas
                        en el carrito antes de registrar.
                      </p>
                    )}

                    {excede && (
                      <label className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs text-orange-800 cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-orange-600"
                          checked={confirmaExcedente}
                          onChange={(e) => setConfirmaExcedente(e.target.checked)}
                        />
                        <span>
                          Atiendes <b>{fmt(totales.total - pendienteRq)} {item.unidad} de MÁS</b> que el
                          pendiente de la RQ (excedente). Confírmalo para continuar — puede ser más,
                          nunca menos.
                        </span>
                      </label>
                    )}

                    <Button
                      className="w-full h-12 gap-2 bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white font-bold"
                      disabled={
                        registrando || lineasSinSaldo.length > 0 || (excede && !confirmaExcedente)
                      }
                      onClick={() => setConfirmarAbierto(true)}
                    >
                      {registrando ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <ClipboardCheck className="h-5 w-5" />
                      )}
                      Registrar atención ({totales.tomas} tomas · {fmt(totales.total)} {item.unidad})
                    </Button>
                    <p className="text-[10px] text-center text-slate-400">
                      Una sola transacción: si una toma falla, no se registra nada.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t bg-white shrink-0 flex items-center justify-between">
            <p className="text-[11px] text-slate-400 truncate flex items-center gap-1">
              <Package className="h-3 w-3" /> {item.descripcion || 'Material de la RQ'}
            </p>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={registrando}>
              Cerrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Escáner en modo lote: cada detección agrega una toma y sigue */}
      <LectorQR
        open={scannerOpen}
        pausado={false}
        onOpenChange={setScannerOpen}
        onDetectar={(texto) => void procesarTexto(texto)}
        titulo="Escaneo en lote — Atender"
        descripcion="Cada QR agregado suma su cantidad de Recepción. El total se registra al final."
        contador={{ tomas: totales.tomas, total: `${fmt(totales.total)} ${item.unidad}` }}
      />

      {/* Confirmación única del lote */}
      <AlertDialog open={confirmarAbierto} onOpenChange={setConfirmarAbierto}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Registrar la atención del lote?</AlertDialogTitle>
            <AlertDialogDescription>
              Se registrarán <b>{totales.tomas} tomas</b> por un total de{' '}
              <b>
                {fmt(totales.total)} {item.unidad}
              </b>{' '}
              del material <b className="font-mono">{item.codigo}</b> en la RQ {rqNumero}.
              <br />
              <br />
              · Descuento de guías en tránsito: <b>{fmt(totales.transito)}</b>
              <br />· Salidas desde posiciones: <b>{fmt(totales.posicion)}</b>
              {excede && (
                <>
                  <br />
                  <br />
                  <span className="font-semibold text-orange-700">
                    Incluye excedente de {fmt(totales.total - pendienteRq)} {item.unidad} sobre lo
                    pedido.
                  </span>
                </>
              )}
              <br />
              <br />
              Todo se registra en UNA transacción con tu usuario. Esta acción es trazable y reversible
              (Revertir → atención con origen).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={ejecutarRegistro}
              className="bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white"
            >
              Sí, registrar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
