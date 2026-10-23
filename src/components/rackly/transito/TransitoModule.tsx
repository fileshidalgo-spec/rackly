'use client'

/**
 * RACKLY — Módulo TRÁNSITO (puente Recepción → Racks/Pisos).
 *
 * Muestra las guías registradas desde la fecha de implementación agrupadas
 * por documento (nº, fecha, proveedor, placa) con sus artículos y un SEMÁFORO
 * por artículo:
 *   🔴 ROJO = sin transferir · 🟡 AMBAR = parcial · 🟢 VERDE = 100 % en rack/piso.
 *
 * Cada artículo se transfiere al mapa visual de Racks o Piso (clic en celda),
 * con soporte parcial, co-ubicación confirmada, batch de artículos de una
 * misma guía y trazabilidad completa (registrado por → trasladado por … a …).
 *
 * Aislamiento: solo LEE recepcion_registros y escribe vía la RPC
 * transito_registrar_envio. No modifica Recepción, Racks ni Piso.
 *
 * SINCRONIZACIÓN CON RECEPCIÓN: esta pestaña es una VISTA VIVA de
 * recepcion_registros (única fuente de verdad — el historial de envíos
 * viaja en el jsonb `transito` de cada fila). Si Recepción modifica o
 * elimina una guía (o su contenido), el cambio se ve aquí en segundos:
 * realtime (INSERT/UPDATE/DELETE) + polling de respaldo + refresco al
 * volver a la pestaña — mismo patrón que Recepción y Atención.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ArrowRightLeft,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Circle,
  FileText,
  History,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanLine,
  Search,
  Truck,
  Users,
  RotateCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime } from '@/hooks/useRegistrosRealtime'
import { calcularTurno } from '@/lib/rackly/turno'
import {
  FECHA_INICIO_TRANSITO,
  MAX_FILAS_TRANSITO,
  listarArticulosTransito,
  listarArticulosPorGuiaId,
  agruparEnGuias,
  contarPendientes,
  filtrarArticulos,
  datosFaltantes,
  type ArticuloTransito,
  type EnvioTransito,
  type GuiaTransito,
} from '@/lib/rackly/transito'
import { parsearPayloadQR, type PayloadQRRotulo } from '@/lib/rackly/qr-rotulo'
import { DialogoTransferir } from './DialogoTransferir'
import { LectorQR } from './LectorQR'

const EPS = 0.0005

type EstadoCarga = 'cargando' | 'listo' | 'error'

export function TransitoModule() {
  const { perfil } = useAuth()
  const [estado, setEstado] = useState<EstadoCarga>('cargando')
  const [articulos, setArticulos] = useState<ArticuloTransito[]>([])
  /** Hora del último refresco (prueba VISIBLE del auto-refresco en vivo). */
  const [enVivoHora, setEnVivoHora] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [guiasAbiertas, setGuiasAbiertas] = useState<Set<string>>(new Set())
  const [historialAbierto, setHistorialAbierto] = useState<Set<string>>(new Set())
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [dialogoItems, setDialogoItems] = useState<ArticuloTransito[] | null>(null)
  /** Lector de QR (cámara + pistola USB): abierto y en pausa durante transferencia. */
  const [lectorOpen, setLectorOpen] = useState(false)
  /** Anti-doble-disparo: una resolución a la vez (ref, no estado — no renderiza). */
  const escaneandoRef = useRef(false)
  /** Guard de cargas cruzadas: la respuesta más vieja nunca pisa la nueva. */
  const cargaGenRef = useRef(0)

  const cargar = useCallback(async () => {
    // Sin setEstado('cargando') síncrono: el estado inicial YA es 'cargando',
    // y en refrescos (realtime/botón) mantener 'listo' evita el flash de la
    // pantalla de carga (regla react-hooks/set-state-in-effect: setState
    // síncrono dentro del effect dispara renders en cascada).
    // Guard generacional (igual que Recepción): si dos refrescos se cruzan
    // (realtime + cierre de diálogo), la respuesta VIEJA no pisa la nueva.
    const gen = ++cargaGenRef.current
    try {
      const data = await listarArticulosTransito()
      if (gen !== cargaGenRef.current) return
      setArticulos(data)
      setEstado('listo')
      setEnVivoHora(
        new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      )
    } catch (err) {
      if (gen !== cargaGenRef.current) return
      console.error('[Transito] Error cargando guías:', err)
      toast.error('Error al cargar las guías de Tránsito')
      setEstado('error')
    }
  }, [])

  useEffect(() => {
    // Diferido (macrotask): la carga arranca tras el primer render y ningún
    // setState ocurre síncronamente en el cuerpo del effect (regla
    // react-hooks/set-state-in-effect). Limpieza: si el módulo se desmonta
    // antes del tick, no se carga.
    const t = setTimeout(() => { void cargar() }, 0)
    return () => clearTimeout(t)
  }, [cargar])

  // ── REFRESCO EN VIVO (realtime + polling + visibilidad) ──
  // Recepción puede MODIFICAR o ELIMINAR una guía (o su contenido) en
  // cualquier momento y desde otro dispositivo: sin esto, la guía editada
  // o borrada seguía apareciendo (o con datos viejos) hasta pulsar
  // "Actualizar" — la sincronización existía en la BD (misma tabla, una
  // sola fuente de verdad) pero NO en la pantalla.
  // Misma suscripción que Recepción/Atención: canal singleton sobre
  // recepcion_registros (INSERT/UPDATE/DELETE, debounce 200 ms) + polling
  // de respaldo cada 8 s + refresco al volver a la pestaña. Aquí NO hay
  // paginación (la lista es el dataset completo), así que el refresco
  // reemplaza TODO y nunca rompe la lectura del usuario. Los envíos del
  // jsonb `transito` viajan DENTRO de cada fila: un UPDATE de Recepción no
  // los toca y un DELETE se los lleva junto con la fila (el borrado con
  // envíos ya está bloqueado por el guard de Recepción).
  const recargarEnVivo = useCallback(() => {
    void cargar()
  }, [cargar])
  useRegistrosRealtime('recepcion_registros', recargarEnVivo)

  const guias = useMemo(() => agruparEnGuias(filtrarArticulos(articulos, busqueda)), [articulos, busqueda])
  const pendientes = useMemo(() => contarPendientes(articulos), [articulos])
  const articulosPorId = useMemo(() => {
    const m = new Map<string, ArticuloTransito>()
    for (const a of articulos) m.set(a.id, a)
    return m
  }, [articulos])

  const toggleGuia = (key: string) =>
    setGuiasAbiertas((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleHistorial = (id: string) =>
    setHistorialAbierto((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleSeleccion = (id: string) =>
    setSeleccion((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Artículos seleccionados con pendiente — TODOS son transferibles (v2:
   *  sin lote/fechas también; el diálogo pedirá la confirmación con alerta). */
  const pendientesDeSeleccion = (): ArticuloTransito[] => {
    const items: ArticuloTransito[] = []
    for (const id of seleccion) {
      const a = articulosPorId.get(id)
      if (a && a.pendiente > EPS) items.push(a)
    }
    return items
  }

  const abrirDialogo = (items: ArticuloTransito[]) => {
    if (items.length === 0) return
    setDialogoItems(items)
  }

  const cerrarDialogo = () => {
    setDialogoItems(null)
    setSeleccion(new Set())
    cargar()
  }

  // ═══ LECTOR DE QR (rótulos de Recepción → transferencia directa) ═══

  /** Artículos de la guía del payload dentro de `base` (guiaId exacto;
   *  si el rótulo es de una guía residual sin guia_id, por Nº documento). */
  function articulosDelPayload(base: ArticuloTransito[], p: PayloadQRRotulo): ArticuloTransito[] {
    if (p.guiaId) {
      const g = p.guiaId.toLowerCase()
      const porGuia = base.filter((a) => a.guiaId.toLowerCase() === g)
      if (porGuia.length > 0) return porGuia
    }
    if (p.numeroDocumento) {
      const d = p.numeroDocumento.toLowerCase()
      return base.filter((a) => a.numeroDocumento.toLowerCase() === d)
    }
    return []
  }

  /** Artículo objetivo del escaneo: código (case-insensitive) y, si el
   *  rótulo era de una paleta, la paleta EXACTA primero.
   *  Task 23 (rigor QR): dentro del código manda la fila CON PENDIENTE —
   *  porCodigo[0]/find podían caer en una fila ya transferida (o en otra
   *  fila gemela de una guía registrada 2 veces) y mostrar datos equivocados
   *  del físico. Con varias filas del mismo código/paleta se elige la que
   *  aún tiene pendiente; si ninguna, la primera (aviso "ya transferido"). */
  function objetivoDelPayload(arts: ArticuloTransito[], p: PayloadQRRotulo): ArticuloTransito | null {
    if (!p.codigo) return null
    const c = p.codigo.toLowerCase()
    const porCodigo = arts.filter((a) => a.codigo.toLowerCase() === c)
    if (porCodigo.length === 0) return null
    if (p.paleta != null) {
      const dePaleta = porCodigo.filter((a) => a.nPaleta === p.paleta)
      if (dePaleta.length > 0) {
        const conPendiente = dePaleta.filter((a) => a.pendiente > EPS)
        return conPendiente[0] ?? dePaleta[0]
      }
    }
    const conPendiente = porCodigo.filter((a) => a.pendiente > EPS)
    return conPendiente[0] ?? porCodigo[0]
  }

  /**
   * Resuelve el texto escaneado y abre la transferencia "ahí mismo":
   *   1. busca la guía en el listado cargado;
   *   2. si no está (guía vieja fuera del tope), la TRAE de la BD y la
   *      suma al listado — un escaneo válido jamás se pierde;
   *   3. abre la tarjeta de la guía y, si el artículo es inequívoco,
   *      el diálogo de transferencia directo (destino Rack/Piso → mapa).
   */
  const resolverQR = async (texto: string, _fuente: 'camara' | 'manual') => {
    if (escaneandoRef.current) return
    const p = parsearPayloadQR(texto)
    if (!p) {
      toast.error('El QR no es un rótulo de Rackly', { description: texto.slice(0, 60) })
      return
    }
    escaneandoRef.current = true
    try {
      let base = articulos
      let arts = articulosDelPayload(base, p)
      if (arts.length === 0 && p.guiaId) {
        const extra = await listarArticulosPorGuiaId(p.guiaId)
        if (extra.length > 0) {
          base = [...extra, ...base]
          setArticulos((prev) => {
            const ids = new Set(prev.map((a) => a.id))
            return [...extra.filter((e) => !ids.has(e.id)), ...prev]
          })
          arts = articulosDelPayload(base, p)
        }
      }
      if (arts.length === 0) {
        toast.error('La guía del QR no está en Tránsito', {
          description: p.numeroDocumento
            ? `Guía ${p.numeroDocumento}: verifica la fecha (desde ${formatearFecha(FECHA_INICIO_TRANSITO)}) o reimprime los rótulos en Recepción.`
            : 'No se pudo identificar la guía del rótulo.',
        })
        return
      }
      const guia = agruparEnGuias(arts)[0]
      setGuiasAbiertas((prev) => new Set(prev).add(guia.key))
      const objetivo = objetivoDelPayload(arts, p)
      const etiquetaGuia = guia.numeroDocumento || `guía del ${formatearFecha(guia.fecha)}`

      // ── AVISOS DE RIGOR QR (Task 23) — el escaneo nunca se bloquea, pero
      // el operario DEBE saber cuando los datos vienen de un registro ambiguo.
      // a) La guía del QR está registrada MÁS DE UNA vez en Recepción (dos
      //    guia_id para el mismo Nº — casos reales T173-00004192 y
      //    T012-00000188): hay rótulos de dos registros circulando.
      if (p.numeroDocumento) {
        const guiasDelDoc = new Set(
          base
            .filter((a) => a.numeroDocumento === p.numeroDocumento)
            .map((a) => a.guiaId)
        )
        if (guiasDelDoc.size > 1) {
          toast.warning(`Guía ${p.numeroDocumento} está registrada ${guiasDelDoc.size} veces en Recepción`, {
            description: 'Puede haber rótulos de dos registros mezclados — verifica que el artículo y la cantidad sean los del físico.',
          })
        }
      }
      // b) PALETA AMBIGUA: el mismo Nº de paleta aparece en varias filas de
      //    la guía (registro repetido por paleta) — la fila elegida puede no
      //    ser la paleta física escaneada.
      if (p.paleta != null) {
        const gemelas = arts.filter(
          (a) => a.codigo.toLowerCase() === p.codigo.toLowerCase() && a.nPaleta === p.paleta
        ).length
        if (gemelas > 1) {
          toast.warning(`Paleta ${p.paleta} aparece ${gemelas} veces en la guía ${etiquetaGuia}`, {
            description: 'Se tomó la fila con pendiente — confirma que la cantidad coincida con la paleta física.',
          })
        }
      }

      if (!objetivo) {
        toast.info(`Guía ${etiquetaGuia}: ${arts.length} artículo(s)`, {
          description: 'El QR no trae el código del artículo — elige uno en la tarjeta abierta.',
        })
        return
      }
      if (!objetivo.pendiente || objetivo.pendiente <= EPS) {
        toast.info(`${objetivo.codigo}: ya está transferido completo`, {
          description: `Guía ${etiquetaGuia} — revisa su historial si necesitas moverlo.`,
        })
        return
      }
      // v2: sin lote/fechas SÍ se transfiere — aviso NO bloqueante; el diálogo
      // pedirá la confirmación explícita antes de mover la mercadería.
      const faltan = datosFaltantes(objetivo)
      if (faltan.length > 0) {
        toast.warning(`${objetivo.codigo}: sin ${faltan.join(', ')}`, {
          description: `Guía ${etiquetaGuia} — al confirmar se pedirá confirmación; completa los datos después con Editar (Racks/Piso).`,
        })
      }
      const mismos = arts.filter(
        (a) => a.codigo.toLowerCase() === objetivo.codigo.toLowerCase() && a.id !== objetivo.id
      )
      toast.success(`Guía ${etiquetaGuia} · ${objetivo.codigo}${objetivo.nPaleta != null ? ` (Paleta ${objetivo.nPaleta})` : ''}`, {
        description: mismos.length > 0
          ? `Hay ${mismos.length + 1} filas con ese código — se transfiere la fila con pendiente; revisa la tarjeta si no es la correcta.`
          : 'Elige destino (Rack o Piso) y posición.',
      })
      abrirDialogo([objetivo])
    } catch (err) {
      console.error('[Transito] Error resolviendo QR:', err)
      toast.error('Error al resolver el QR del rótulo')
    } finally {
      escaneandoRef.current = false
    }
  }

  const usuarioCtx = { id: perfil?.id ?? '', nombre: perfil?.nombre ?? '', correo: perfil?.correo ?? '' }
  const turno = calcularTurno()

  return (
    <div className="space-y-4">
      {/* ═══ Encabezado con contadores ═══ */}
      <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
        <CardContent className="p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center shadow-md shadow-fuchsia-500/25 shrink-0">
                <Truck className="h-5 w-5 text-white" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-extrabold text-slate-900 leading-tight">
                  Almacén de Tránsito
                </h3>
                <p className="text-xs text-slate-500">
                  Guías desde {formatearFecha(FECHA_INICIO_TRANSITO)} · transfiere con un clic al mapa de Racks o Piso
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* EN VIVO: la lista se refresca sola cuando Recepción modifica o
                  elimina una guía (realtime + respaldo 8 s). Hora del último
                  refresco, misma prueba visible que en Recepción. */}
              <span
                className="hidden md:flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 mr-1 whitespace-nowrap"
                title="La lista se actualiza sola cuando Recepción modifica o elimina una guía (realtime + refresco de respaldo)"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                {enVivoHora ? `En vivo · ${enVivoHora}` : 'En vivo'}
              </span>
              <Button
                size="sm"
                onClick={() => setLectorOpen(true)}
                className="gap-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 font-semibold"
                title="Escanear el QR de un rótulo (cámara o pistola USB) y transferir directamente"
              >
                <ScanLine className="h-4 w-4" />
                Escanear QR
              </Button>
              <Button variant="outline" size="sm" onClick={cargar} disabled={estado === 'cargando'} className="gap-1.5 shrink-0">
                {estado === 'cargando' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Actualizar
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Guías</p>
              <p className="text-xl font-extrabold text-slate-900">{guias.length}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Artículos</p>
              <p className="text-xl font-extrabold text-slate-900">{articulos.length}</p>
            </div>
            <div className={`rounded-xl border p-3 ${pendientes > 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pendientes</p>
              <p className={`text-xl font-extrabold ${pendientes > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                {pendientes}
              </p>
            </div>
          </div>

          {/* Búsqueda por proveedor / código / descripción / nº documento */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por empresa, proveedor, código, descripción o Nº de documento…"
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* ═══ Barra de selección batch ═══ */}
      {seleccion.size > 0 && (
        <div className="sticky top-[52px] sm:top-16 z-30 rounded-xl border-2 border-fuchsia-300 bg-white shadow-lg shadow-fuchsia-500/10 p-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-900">
            {seleccion.size} seleccionado{seleccion.size > 1 ? 's' : ''}
            <span className="ml-1.5 text-xs font-medium text-slate-500">misma ubicación, un solo envío cada uno</span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSeleccion(new Set())}>
              Quitar selección
            </Button>
            <Button
              size="sm"
              onClick={() => abrirDialogo(pendientesDeSeleccion())}
              disabled={pendientesDeSeleccion().length === 0}
              className="gap-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 font-semibold"
            >
              <ArrowRightLeft className="h-4 w-4" />
              Transferir juntos
            </Button>
          </div>
        </div>
      )}

      {/* ═══ Aviso de recorte (nunca silencioso) ═══ */}
      {estado === 'listo' && articulos.length >= MAX_FILAS_TRANSITO && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 font-medium">
          Hay muchas guías en Tránsito: se muestran las MÁS RECIENTES (límite de {MAX_FILAS_TRANSITO.toLocaleString('es-PE')} filas alcanzado). Las guías más antiguas siguen en Recepción.
        </div>
      )}

      {/* ═══ Listado de guías ═══ */}
      {estado === 'cargando' && articulos.length === 0 && (
        <div className="flex items-center justify-center py-16 text-sm text-slate-500 gap-2">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando guías de Tránsito…
        </div>
      )}

      {estado === 'error' && articulos.length === 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-center text-sm text-rose-700">
          No se pudo cargar el listado. Intenta de nuevo con “Actualizar”.
        </div>
      )}

      {estado === 'listo' && guias.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center space-y-2">
          <PackageCheck className="h-8 w-8 text-slate-300 mx-auto" />
          <p className="text-sm font-semibold text-slate-700">Sin guías en Tránsito</p>
          <p className="text-xs text-slate-500">
            Las guías registradas en Recepción desde el {formatearFecha(FECHA_INICIO_TRANSITO)} aparecen aquí
            automáticamente.
          </p>
        </div>
      )}

      {guias.map((guia) => (
        <TarjetaGuia
          key={guia.key}
          guia={guia}
          abierta={guiasAbiertas.has(guia.key)}
          onToggle={() => toggleGuia(guia.key)}
          seleccion={seleccion}
          onToggleSeleccion={toggleSeleccion}
          historialAbierto={historialAbierto}
          onToggleHistorial={toggleHistorial}
          onTransferir={(a) => abrirDialogo([a])}
          onTransferirTodoGuia={() => {
            const items = guia.articulos.filter((a) => a.pendiente > EPS)
            if (items.length === 0) {
              toast.info('Ningún artículo de esta guía está pendiente de transferir')
              return
            }
            abrirDialogo(items)
          }}
        />
      ))}

      {/* ═══ Lector de QR de rótulos (pausado mientras hay transferencia abierta) ═══ */}
      <LectorQR
        open={lectorOpen}
        pausado={!!dialogoItems}
        onOpenChange={setLectorOpen}
        onDetectar={(texto, fuente) => void resolverQR(texto, fuente)}
      />

      {/* ═══ Diálogo de transferencia ═══ */}
      {dialogoItems && (
        <DialogoTransferir
          items={dialogoItems}
          usuario={usuarioCtx}
          turno={turno}
          onListo={cerrarDialogo}
          onCancelar={() => setDialogoItems(null)}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// TARJETA DE GUÍA (encabezado + artículos)
// ═══════════════════════════════════════════════════════════════════

function TarjetaGuia({
  guia,
  abierta,
  onToggle,
  seleccion,
  onToggleSeleccion,
  historialAbierto,
  onToggleHistorial,
  onTransferir,
  onTransferirTodoGuia,
}: {
  guia: GuiaTransito
  abierta: boolean
  onToggle: () => void
  seleccion: Set<string>
  onToggleSeleccion: (id: string) => void
  historialAbierto: Set<string>
  onToggleHistorial: (id: string) => void
  onTransferir: (a: ArticuloTransito) => void
  onTransferirTodoGuia: () => void
}) {
  const nArticulos = guia.articulos.length
  const nPendientes = guia.articulos.filter((a) => a.pendiente > EPS).length
  const pendientesDeGuia = guia.articulos.filter((a) => a.pendiente > EPS)

  return (
    <Card className="border-0 shadow-md shadow-slate-200/50 bg-white overflow-hidden">
      {/* Encabezado de la guía (siempre visible) */}
      <button
        onClick={onToggle}
        className="w-full text-left p-4 sm:p-5 flex items-center gap-3 hover:bg-slate-50 transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-md shadow-amber-500/20 shrink-0">
          <FileText className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold text-slate-900 truncate">
            {guia.numeroDocumento || 'Guía sin número'}
            <span className="ml-2 text-xs font-medium text-slate-500">{guia.tipoDocumento}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 mt-0.5">
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" /> {formatearFecha(guia.fecha)}
            </span>
            <span className="truncate max-w-[220px]" title="Empresa que nos envía">
              {guia.empresaOrigen || guia.proveedor || 'Sin empresa'}
            </span>
            {guia.placa && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                {guia.placa}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-[10px] font-semibold">
            {nArticulos} art.
          </Badge>
          {nPendientes > 0 ? (
            <Badge className="bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-bold">
              {nPendientes} pend.
            </Badge>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold">
              Completa
            </Badge>
          )}
          {abierta ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        </div>
      </button>

      {/* Artículos */}
      {abierta && (
        <div className="border-t border-slate-100">
          {pendientesDeGuia.length > 1 && (
            <div className="px-4 sm:px-5 pt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={onTransferirTodoGuia}
                className="gap-1.5 text-xs font-semibold"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Transferir los {pendientesDeGuia.length} pendientes juntos
              </Button>
            </div>
          )}
          <div className="divide-y divide-slate-100 p-2 sm:p-3 space-y-0">
            {guia.articulos.map((a) => (
              <FilaArticulo
                key={a.id}
                articulo={a}
                seleccionado={seleccion.has(a.id)}
                onToggleSeleccion={() => onToggleSeleccion(a.id)}
                historialAbierto={historialAbierto.has(a.id)}
                onToggleHistorial={() => onToggleHistorial(a.id)}
                onTransferir={() => onTransferir(a)}
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// FILA DE ARTÍCULO (semáforo + datos + acciones)
// ═══════════════════════════════════════════════════════════════════

function FilaArticulo({
  articulo: a,
  seleccionado,
  onToggleSeleccion,
  historialAbierto,
  onToggleHistorial,
  onTransferir,
}: {
  articulo: ArticuloTransito
  seleccionado: boolean
  onToggleSeleccion: () => void
  historialAbierto: boolean
  onToggleHistorial: () => void
  onTransferir: () => void
}) {
  const sem = a.estado
  // Datos ausentes del artículo (lote/vencimiento/producción) — alerta consciente
  const faltanFila = datosFaltantes(a)

  return (
    <div className="p-2.5 sm:p-3 rounded-xl hover:bg-slate-50 transition-colors">
      <div className="flex items-start gap-2.5">
        {/* Checkbox batch (siempre que tenga pendiente — sin datos también,
            v2: el diálogo pide confirmación explícita) */}
        {a.pendiente > EPS ? (
          <Checkbox
            checked={seleccionado}
            onCheckedChange={onToggleSeleccion}
            className="mt-1 shrink-0"
            aria-label={`Seleccionar ${a.codigo}`}
          />
        ) : (
          <div className="w-4 shrink-0" />
        )}

        {/* Semáforo */}
        <div className="shrink-0 mt-0.5" title={TITULO_SEMAFORO[sem]}>
          <Circle className={`h-5 w-5 fill-current ${COLOR_SEMAFORO[sem]}`} strokeWidth={1.5} />
        </div>

        {/* Datos */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="text-sm font-extrabold text-slate-900">{a.codigo}</p>
            <Badge variant="outline" className={`text-[10px] font-bold px-1.5 py-0 h-4 border ${CHIP_SEMAFORO[sem]}`}>
              {LABEL_SEMAFORO[a.pendiente <= EPS && a.enviados > EPS ? 'VERDE' : sem]}
            </Badge>
            {a.nPaleta != null && (
              <span className="text-[10px] font-semibold text-slate-500">Paleta {a.nPaleta}</span>
            )}
          </div>
          <p className="text-xs text-slate-600 truncate">{a.descripcion}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Cant: <span className="font-bold">{formatearNum(a.cantidad)}</span> {a.unidadMedida}
            {' · '}Lote: <span className="font-semibold">{a.lote || '—'}</span>
            {' · '}Vence: <span className="font-semibold">{formatearFecha(a.fechaVencimiento) || '—'}</span>
            {' · '}Fab: {formatearFecha(a.fechaProduccion) || '—'}
          </p>

          {/* Resumen de transferencias */}
          {a.enviados > EPS && (
            <p className={`text-[11px] mt-0.5 font-medium ${sem === 'AMAR' ? 'text-amber-700' : 'text-emerald-700'}`}>
              Enviado: {formatearNum(a.enviados)}/{formatearNum(a.cantidad)}
              {a.pendiente > EPS ? ` · Pendiente: ${formatearNum(a.pendiente)}` : ' · Completo'}
              {a.envios.length > 0 && (
                <>
                  {' '}· Último:{' '}
                  {(() => {
                    const u = a.envios[a.envios.length - 1]
                    if (u.destino === 'atencion' || u.destino === 'atencion_posicion')
                      return u.rq ? `Atendido RQ ${u.rq}` : 'Atendido'
                    if (u.destino === 'reversa_atencion') return 'Reversa de atención'
                    return u.ubicacion || u.destino
                  })()}
                </>
              )}
            </p>
          )}

          {/* ALERTA v2: sin lote/fechas se transfiere, pero NUNCA en silencio */}
          {faltanFila.length > 0 && (
            <p className="text-[11px] text-amber-700 mt-0.5 font-medium">
              ⚠ Sin {faltanFila.join(' · ')} — al transferir se pedirá confirmación (luego corrige con Editar)
            </p>
          )}
        </div>

        {/* Acciones */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Button
            size="sm"
            onClick={onTransferir}
            disabled={a.pendiente <= EPS}
            className={`gap-1 text-xs font-semibold h-8 ${
              faltanFila.length > 0 ? 'bg-amber-600 hover:bg-amber-700 text-white' : ''
            }`}
            title={
              a.pendiente <= EPS
                ? 'Ya está completo'
                : faltanFila.length > 0
                  ? `Sin ${faltanFila.join(' · ')} — se pedirá confirmación antes de mover`
                  : 'Transferir a Rack o Piso'
            }
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Transferir
          </Button>
          <button
            onClick={onToggleHistorial}
            className="text-[11px] text-slate-500 hover:text-slate-800 inline-flex items-center gap-1 font-medium"
          >
            <History className="h-3 w-3" />
            Historial
          </button>
        </div>
      </div>

      {/* Historial / trazabilidad */}
      {historialAbierto && (
        <div className="mt-2 ml-8 sm:ml-10 rounded-lg border border-slate-200 bg-slate-50/70 p-3 space-y-1.5">
          <p className="text-[11px] text-slate-600">
            <span className="font-bold">Registrado</span> por {a.usuarioNombre || '—'} el día{' '}
            {formatearFechaHora(a.createdAt)}
          </p>
          {a.envios.length === 0 ? (
            <p className="text-[11px] text-slate-500">Aún sin transferencias.</p>
          ) : (
            a.envios.map((e) => <LineaEnvio key={e.uuid} envio={e} />)
          )}
        </div>
      )}
    </div>
  )
}

function LineaEnvio({ envio: e }: { envio: EnvioTransito }) {
  // Puente Atención↔Tránsito: los envíos 'atencion*' no son traslados —
  // se presentan como atenciones (badge propio) y la reversa como devolución.
  if (
    e.destino === 'atencion' ||
    e.destino === 'atencion_posicion' ||
    e.destino === 'reversa_atencion'
  ) {
    const esReversa = e.destino === 'reversa_atencion'
    const cant = Math.abs(e.cantidad_atencion ?? e.cantidad)
    const etiqueta = esReversa
      ? 'Reversa de atención'
      : e.destino === 'atencion_posicion'
        ? 'Atendido desde la posición'
        : 'Atendido (sin posición aún)'
    return (
      <p className="text-[11px] text-slate-600 flex items-start gap-1.5">
        {esReversa ? (
          <RotateCcw className="h-3 w-3 mt-0.5 text-amber-500 shrink-0" />
        ) : (
          <ScanLine className="h-3 w-3 mt-0.5 text-teal-500 shrink-0" />
        )}
        <span>
          <span className={`font-bold ${esReversa ? 'text-amber-600' : 'text-teal-700'}`}>
            {etiqueta}
          </span>{' '}
          por {e.usuario_nombre || '—'} el día {formatearFechaHora(e.fecha)}
          {e.ubicacion ? (
            <>
              {' '}
              desde <span className="font-semibold">{e.ubicacion}</span>
            </>
          ) : null}{' '}
          · {formatearNum(cant)}
          {esReversa ? ' (devuelto a pendiente)' : ''}
          {e.rq ? (
            <>
              {' '}
              · RQ <span className="font-semibold">{e.rq}</span>
            </>
          ) : null}
          {' '}· Turno {e.turno || '—'}
        </span>
      </p>
    )
  }
  return (
    <p className="text-[11px] text-slate-600 flex items-start gap-1.5">
      <ArrowRightLeft className="h-3 w-3 mt-0.5 text-fuchsia-500 shrink-0" />
      <span>
        <span className="font-bold">Trasladado</span> por {e.usuario_nombre || '—'} el día{' '}
        {formatearFechaHora(e.fecha)} a{' '}
        <span className="font-semibold">
          {e.destino === 'rack' ? 'Rack' : 'Piso'} {e.ubicacion}
        </span>{' '}
        · {formatearNum(e.cantidad)} · Turno {e.turno || '—'}
      </span>
    </p>
  )
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS DE PRESENTACIÓN
// ═══════════════════════════════════════════════════════════════════

const COLOR_SEMAFORO: Record<string, string> = {
  ROJO: 'text-rose-500',
  AMAR: 'text-amber-400',
  VERDE: 'text-emerald-500',
}

const CHIP_SEMAFORO: Record<string, string> = {
  ROJO: 'bg-rose-50 text-rose-700 border-rose-200',
  AMAR: 'bg-amber-50 text-amber-800 border-amber-300',
  VERDE: 'bg-emerald-50 text-emerald-700 border-emerald-300',
}

const LABEL_SEMAFORO: Record<string, string> = {
  ROJO: 'Sin transferir',
  AMAR: 'Parcial',
  VERDE: 'En ubicación',
}

const TITULO_SEMAFORO: Record<string, string> = {
  ROJO: 'Nada transferido',
  AMAR: 'Transferencia parcial',
  VERDE: 'Transferido por completo',
}

function formatearNum(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

/** 'YYYY-MM-DD' → 'DD/MM/YY' (null/'' → ''). */
function formatearFecha(v: string | null | undefined): string {
  if (!v) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (!m) return v
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`
}

/** ISO/timestamptz o 'YYYY-MM-DD HH:MI' → 'DD/MM/YY HH:MM'.
 *  El timestamptz se formatea SIEMPRE en hora Lima (America/Lima): antes usaba
 *  getHours() — la TZ del DISPOSITIVO — y en equipos fuera de Lima la fila
 *  "Registrado…" se mostraba en hora local mientras "Trasladado…" (texto
 *  sellado por la RPC en hora Lima) se mostraba tal cual: dos horas distintas
 *  en la MISMA tarjeta de trazabilidad. */
const FMT_LIMA = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima',
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
function formatearFechaHora(v: string | null | undefined): string {
  if (!v) return '—'
  const iso = new Date(v)
  if (!isNaN(iso.getTime())) {
    // es-PE con hour12:false puede anteponer "24:" a medianoche en algunos
    // motores: normalizar a 00.
    const parts = FMT_LIMA.formatToParts(iso)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const hh = get('hour') === '24' ? '00' : get('hour')
    return `${get('day')}/${get('month')}/${get('year')} ${hh}:${get('minute')}`
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(v)
  if (m) return `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}`
  return v
}
