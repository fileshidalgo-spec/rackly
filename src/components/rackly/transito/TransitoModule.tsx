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
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  Search,
  Truck,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { calcularTurno } from '@/lib/rackly/turno'
import {
  FECHA_INICIO_TRANSITO,
  listarArticulosTransito,
  agruparEnGuias,
  contarPendientes,
  filtrarArticulos,
  type ArticuloTransito,
  type EnvioTransito,
  type GuiaTransito,
} from '@/lib/rackly/transito'
import { DialogoTransferir } from './DialogoTransferir'

const EPS = 0.0005

type EstadoCarga = 'cargando' | 'listo' | 'error'

export function TransitoModule() {
  const { perfil } = useAuth()
  const [estado, setEstado] = useState<EstadoCarga>('cargando')
  const [articulos, setArticulos] = useState<ArticuloTransito[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [guiasAbiertas, setGuiasAbiertas] = useState<Set<string>>(new Set())
  const [historialAbierto, setHistorialAbierto] = useState<Set<string>>(new Set())
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [dialogoItems, setDialogoItems] = useState<ArticuloTransito[] | null>(null)

  const cargar = useCallback(async () => {
    // Sin setEstado('cargando') síncrono: el estado inicial YA es 'cargando',
    // y en refrescos (realtime/botón) mantener 'listo' evita el flash de la
    // pantalla de carga (regla react-hooks/set-state-in-effect: setState
    // síncrono dentro del effect dispara renders en cascada).
    try {
      const data = await listarArticulosTransito()
      setArticulos(data)
      setEstado('listo')
    } catch (err) {
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

  const transferiblesDeSeleccion = (): ArticuloTransito[] => {
    const items: ArticuloTransito[] = []
    for (const id of seleccion) {
      const a = articulosPorId.get(id)
      if (a && a.transferible && a.pendiente > EPS) items.push(a)
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
            <Button variant="outline" size="sm" onClick={cargar} disabled={estado === 'cargando'} className="gap-1.5 shrink-0">
              {estado === 'cargando' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Actualizar
            </Button>
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
              placeholder="Buscar por proveedor, código, descripción o Nº de documento…"
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
              onClick={() => abrirDialogo(transferiblesDeSeleccion())}
              disabled={transferiblesDeSeleccion().length === 0}
              className="gap-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 font-semibold"
            >
              <ArrowRightLeft className="h-4 w-4" />
              Transferir juntos
            </Button>
          </div>
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
            const items = guia.articulos.filter((a) => a.transferible && a.pendiente > EPS)
            if (items.length === 0) {
              toast.info('Ningún artículo de esta guía está pendiente de transferir')
              return
            }
            abrirDialogo(items)
          }}
        />
      ))}

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
  const todosPendientesTransferibles = guia.articulos.filter((a) => a.transferible && a.pendiente > EPS)

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
            <span className="truncate max-w-[220px]">{guia.proveedor || 'Sin proveedor'}</span>
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
          {todosPendientesTransferibles.length > 1 && (
            <div className="px-4 sm:px-5 pt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={onTransferirTodoGuia}
                className="gap-1.5 text-xs font-semibold"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Transferir los {todosPendientesTransferibles.length} pendientes juntos
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

  return (
    <div className="p-2.5 sm:p-3 rounded-xl hover:bg-slate-50 transition-colors">
      <div className="flex items-start gap-2.5">
        {/* Checkbox batch (solo si es transferible y pendiente) */}
        {a.transferible && a.pendiente > EPS ? (
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
                <> · Último: {a.envios[a.envios.length - 1].ubicacion || a.envios[a.envios.length - 1].destino}</>
              )}
            </p>
          )}

          {!a.transferible && (
            <p className="text-[11px] text-rose-600 mt-0.5 font-medium">
              ⚠ {a.razonNoTransferible} — no se puede transferir desde Tránsito
            </p>
          )}
        </div>

        {/* Acciones */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Button
            size="sm"
            onClick={onTransferir}
            disabled={!a.transferible || a.pendiente <= EPS}
            className="gap-1 text-xs font-semibold h-8"
            title={
              !a.transferible
                ? a.razonNoTransferible
                : a.pendiente <= EPS
                  ? 'Ya está completo'
                  : 'Transferir a Rack o Piso'
            }
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Transferir
          </Button>
          {(a.envios.length > 0 || true) && (
            <button
              onClick={onToggleHistorial}
              className="text-[11px] text-slate-500 hover:text-slate-800 inline-flex items-center gap-1 font-medium"
            >
              <History className="h-3 w-3" />
              Historial
            </button>
          )}
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
