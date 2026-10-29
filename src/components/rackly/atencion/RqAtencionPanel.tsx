'use client'

/**
 * RACKLY — Atención a Línea · Panel principal del módulo Atención.
 *
 * Vistas:
 *   · lista        → resumen + búsqueda + LISTA UNIFICADA RQ+RAL (tiempo real).
 *   · nueva        → registro con foto/OCR (RqFotoForm) con confirmación.
 *   · nueva-ral    → registro del formato RAL (RalFotoForm, Task 36).
 *   · detalle      → atender materiales de una RQ (RqDetalle) + ubicaciones.
 *   · detalle-ral  → atender materiales de un RAL (RalDetalle, 2026-10-30).
 *   · dashboard    → reporte de atención a líneas (RqDashboard + Excel).
 *
 * LISTA UNIFICADA (pedido del usuario 2026-10-30): «la atención de RAL debe
 * ser el mismo modelo que la de RQ y todo debe aparecer en UNA sola lista,
 * quizás con una distinción que diga RAL». Las tablas siguen separadas
 * (rals/rq_atenciones — el usuario lo acepta) y cada capa de datos mantiene
 * su aislamiento; la unión vive en src/lib/rackly/atencion-unificada.ts:
 *   · RQ: buscadas/paginadas en el servidor (listarRqs).
 *   · RAL: cargadas completas y filtradas en cliente con los MISMOS filtros
 *     (búsqueda/estado/fecha; el RAL no tiene turno) — fila con badge violeta.
 *   · El RAL ya es ATENDIBLE con el mismo modelo (estado + cantidad atendida
 *     por material vía RPC ral_atender_item/ral_revertir_item).
 *
 * La RQ/RAL ABIERTA se recuerda en sessionStorage: al saltar a Racks/Piso y
 * volver con «Retornar a Atención», el detalle queda abierto donde estaba.
 *
 * Aislamiento: usa las capas rq-atencion.ts (tablas rq_*) y ral.ts (rals_*).
 * No toca tickets (atencion_registros) ni otros módulos.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime, type MotivoRealtime } from '@/hooks/useRegistrosRealtime'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import { loadTabState, saveTabState } from '@/lib/rackly/tab-state'
import {
  listarRqs,
  eliminarRq,
  obtenerRqCompleta,
  type RqAtencion,
  type RqItem,
} from '@/lib/rackly/rq-atencion'
import {
  listarRals,
  eliminarRal,
  type RalRegistro,
} from '@/lib/rackly/ral'
import {
  conteosEstado,
  unirFilasAtencion,
  type FilaUnificada,
} from '@/lib/rackly/atencion-unificada'
import type { PisoTargetPosicion } from '@/lib/piso/navegacion'
import { RqFotoForm, type RqRegistradaInfo } from '@/components/rackly/atencion/RqFotoForm'
import { RalFotoForm } from '@/components/rackly/atencion/RalFotoForm'
import { RalDetalle } from '@/components/rackly/atencion/RalDetalle'
import { RqDashboard } from '@/components/rackly/atencion/RqDashboard'
import { RqDetalle } from '@/components/rackly/atencion/RqDetalle'
import { RqEditarDialog } from '@/components/rackly/atencion/RqEditarDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { toast } from 'sonner'
import {
  Plus,
  Search,
  RefreshCw,
  Loader2,
  Inbox,
  Trash2,
  PackageOpen,
  Eye,
  Pencil,
  X,
  FilePlus2,
  BarChart3,
} from 'lucide-react'

const PAGE_SIZE = 50

/** sessionStorage: la RQ/RAL abierta sobrevive al salto Racks/Piso → retorno. */
const KEY_RQ_ABIERTA = 'atencion.rqAbierta'
const KEY_RAL_ABIERTA = 'atencion.ralAbierta'

const ESTADO_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

type Vista = 'lista' | 'nueva' | 'nueva-ral' | 'detalle' | 'detalle-ral' | 'dashboard'

export function RqAtencionPanel({
  onIrARacks,
  onIrAPiso,
}: {
  onIrARacks: (bloque: string, torre: string, piso: string, posicion: string) => void
  onIrAPiso: (target: PisoTargetPosicion) => void
}) {
  const { perfil } = useAuth()
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEliminar =
    perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)

  const [vista, setVista] = useState<Vista>('lista')
  const [rqAbiertaId, setRqAbiertaId] = useState<string>(() =>
    loadTabState<string>(KEY_RQ_ABIERTA, '')
  )
  const [ralAbiertaId, setRalAbiertaId] = useState<string>(() =>
    loadTabState<string>(KEY_RAL_ABIERTA, '')
  )
  const [filas, setFilas] = useState<RqAtencion[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  /** Lista unificada: RALs cargadas completas (se filtran/ordenan en cliente). */
  const [rals, setRals] = useState<RalRegistro[]>([])
  const [cargandoRals, setCargandoRals] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [estadoFiltro, setEstadoFiltro] = useState('todos')
  /** Task 35: filtro por fecha exacta (YYYY-MM-DD) y turno del RQ (hoja). */
  const [fechaFiltro, setFechaFiltro] = useState('')
  const [turnoFiltro, setTurnoFiltro] = useState('todos')
  const [offset, setOffset] = useState(0)
  const [deleteTarget, setDeleteTarget] = useState<RqAtencion | null>(null)
  const [deleteRalTarget, setDeleteRalTarget] = useState<RalRegistro | null>(null)
  /** Edición supervisada (Task 26): RQ + materiales cargados al abrir. */
  const [editarTarget, setEditarTarget] = useState<RqAtencion | null>(null)
  const [editarItems, setEditarItems] = useState<RqItem[]>([])
  const [cargandoEdicion, setCargandoEdicion] = useState<string | null>(null)

  const cargaGenRef = useRef(0)
  const offsetRef = useRef(0)
  const filtrosActivosRef = useRef({ busqueda: '', estado: '', fecha: '', turno: '' })

  const [enVivoHora, setEnVivoHora] = useState('')
  const [nuevosPendientes, setNuevosPendientes] = useState(false)

  // Montaje: si había una RQ/RAL abierta (retorno de Racks/Piso), reabrir detalle
  useEffect(() => {
    if (rqAbiertaId) setVista('detalle')
    else if (ralAbiertaId) setVista('detalle-ral')
     
  }, [])

  useEffect(() => {
    saveTabState(KEY_RQ_ABIERTA, rqAbiertaId)
  }, [rqAbiertaId])

  useEffect(() => {
    saveTabState(KEY_RAL_ABIERTA, ralAbiertaId)
  }, [ralAbiertaId])

  const cargar = useCallback(
    async (
      nuevoOffset: number,
      reemplazar: boolean,
      filtros?: { busqueda: string; estado: string; fecha: string; turno: string }
    ) => {
      const gen = ++cargaGenRef.current
      setLoading(true)
      try {
        const fBusqueda = filtros?.busqueda ?? busqueda
        const fEstado = filtros ? filtros.estado : estadoFiltro === 'todos' ? '' : estadoFiltro
        // Task 35: fecha exacta + turno del RQ (hoja 004/005).
        const fFecha = filtros?.fecha ?? fechaFiltro
        const fTurno = filtros ? filtros.turno : turnoFiltro === 'todos' ? '' : turnoFiltro
        if (!filtros)
          filtrosActivosRef.current = { busqueda: fBusqueda, estado: fEstado, fecha: fFecha, turno: fTurno }
        const { filas: filasNuevas, total: totalNuevo } = await listarRqs({
          busqueda: fBusqueda,
          estado: fEstado,
          fecha: fFecha,
          turno: fTurno,
          limit: PAGE_SIZE,
          offset: nuevoOffset,
        })
        if (gen !== cargaGenRef.current) return
        setFilas((prev) => (reemplazar ? filasNuevas : [...prev, ...filasNuevas]))
        setTotal(totalNuevo)
        offsetRef.current = nuevoOffset
        setOffset(nuevoOffset)
        if (reemplazar) {
          setEnVivoHora(
            new Date().toLocaleTimeString('es-PE', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          )
          if (nuevoOffset === 0) setNuevosPendientes(false)
        }
      } catch (err: unknown) {
        if (gen !== cargaGenRef.current) return
        const message = err instanceof Error ? err.message : 'Error desconocido'
        toast.error('Error al cargar las RQ', { description: message })
      } finally {
        if (gen === cargaGenRef.current) setLoading(false)
      }
    },
    [busqueda, estadoFiltro, fechaFiltro, turnoFiltro]
  )

  const recargarLista = useCallback(
    (motivo: MotivoRealtime = 'evento') => {
      if (offsetRef.current !== 0) {
        if (motivo !== 'poll') setNuevosPendientes(true)
        return
      }
      void cargar(0, true, filtrosActivosRef.current)
    },
    [cargar]
  )

  useRegistrosRealtime('rq_atenciones', recargarLista)

  /** Carga los RAL (lista unificada): se cargan completos, filtro/orden en
   *  cliente (atencion-unificada.ts). Volumen pequeño por jornada. */
  const cargarRals = useCallback(async (silencioso = false) => {
    if (!silencioso) setCargandoRals(true)
    try {
      const filasR = await listarRals()
      setRals(filasR)
      setEnVivoHora(
        new Date().toLocaleTimeString('es-PE', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al cargar los RAL', { description: message })
    } finally {
      if (!silencioso) setCargandoRals(false)
    }
  }, [])

  const recargarRals = useCallback(
    (motivo: MotivoRealtime) => {
      // El polling no avisa (evita falsas alarmas) — igual que el panel RQ.
      if (motivo === 'poll') return
      void cargarRals(true)
    },
    [cargarRals]
  )
  useRegistrosRealtime('rals', recargarRals)

  useEffect(() => {
    if (vista === 'lista') {
      void cargar(0, true)
      void cargarRals()
    }
      
  }, [vista])

  function buscar() {
    cargar(0, true)
  }

  function abrirDetalle(id: string) {
    setRqAbiertaId(id)
    setVista('detalle')
  }

  function abrirDetalleRal(id: string) {
    setRalAbiertaId(id)
    setVista('detalle-ral')
  }

  function volverALista() {
    setRqAbiertaId('')
    setRalAbiertaId('')
    setVista('lista')
  }

  function alRegistrada(info: RqRegistradaInfo) {
    cargar(0, true)
    abrirDetalle(info.rq.id)
  }

  /** Task 36: tras registrar un RAL se recarga la lista unificada — el
   *  realtime 'rals' también lo habría visto, pero el refresco explícito
   *  garantiza que el nuevo documento aparezca ya en la vista. */
  function alRegistradoRal() {
    volverALista()
    void cargarRals()
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await eliminarRq(target.id)
      toast.success('RQ eliminada')
      if (rqAbiertaId === target.id) volverALista()
      else cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  /** Elimina un RAL desde la lista unificada (solo supervisores). */
  async function handleDeleteRal() {
    if (!deleteRalTarget) return
    const target = deleteRalTarget
    setDeleteRalTarget(null)
    try {
      await eliminarRal(target.id)
      toast.success('RAL eliminado')
      if (ralAbiertaId === target.id) volverALista()
      else void cargarRals()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar el RAL', { description: message })
    }
  }

  /** Abre el editor con los materiales vigentes (una lectura al abrir). */
  async function abrirEdicion(r: RqAtencion) {
    setCargandoEdicion(r.id)
    try {
      const { items } = await obtenerRqCompleta(r.id)
      setEditarItems(items)
      setEditarTarget(r)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo abrir la edición', { description: message })
    } finally {
      setCargandoEdicion(null)
    }
  }

  // ── DASHBOARD (reporte de atención a líneas) ──
  if (vista === 'dashboard') {
    return <RqDashboard />
  }

  // ── DETALLE RAL (modelo de atención unificado con la RQ) ──
  if (vista === 'detalle-ral' && ralAbiertaId) {
    return <RalDetalle ralId={ralAbiertaId} onVolver={volverALista} />
  }

  // ── DETALLE ──
  if (vista === 'detalle' && rqAbiertaId) {
    return (
      <RqDetalle
        rqId={rqAbiertaId}
        onVolver={volverALista}
        onIrARacks={onIrARacks}
        onIrAPiso={onIrAPiso}
      />
    )
  }

  // ── NUEVA ──
  if (vista === 'nueva') {
    return <RqFotoForm onRegistrado={alRegistrada} onCancelar={volverALista} />
  }

  // ── NUEVA RAL (Task 36) ──
  if (vista === 'nueva-ral') {
    return <RalFotoForm onRegistrado={alRegistradoRal} onCancelar={volverALista} />
  }

  // ── LISTA UNIFICADA (RQ + RAL) ──
  // RQ ya filtradas del server; RAL filtradas/ordenadas aquí (puro, testeable).
  // Cómputo directo (no useMemo: está tras los early-returns de vista — Rules
  // of Hooks) — barato: ≤ 50 RQ por página + ≤ 300 RAL.
  const filasUnificadas = unirFilasAtencion(filas, rals, {
    busqueda,
    estado: estadoFiltro,
    fecha: fechaFiltro,
    turno: turnoFiltro,
  })
  const { pendientes, enProceso, atendidas } = conteosEstado(filasUnificadas)
  const hayMas = filas.length < total

  return (
    <div className="space-y-4">
      {/* ── Acción principal ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button
            onClick={() => setVista('nueva')}
            className="w-full sm:w-auto gap-2 h-10 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
          >
            <Plus className="h-4 w-4" /> Nueva RQ (con foto)
          </Button>
          {/* Task 36: formato RAL (Requerimiento al Almacén) — distinto al RQ. */}
          <Button
            onClick={() => setVista('nueva-ral')}
            className="w-full sm:w-auto gap-2 h-10 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
          >
            <FilePlus2 className="h-4 w-4" /> Nuevo RAL
          </Button>
        </div>
        {/* Reporte de atención a líneas: dashboard + Excel descargable. */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setVista('dashboard')}
            className="w-full sm:w-auto gap-2 h-10"
          >
            <BarChart3 className="h-4 w-4" /> Dashboard
          </Button>
        </div>
        <p className="text-xs text-slate-500 sm:ml-1">
          Registra la Requisición de Despacho y atiende sus materiales desde aquí.
        </p>
      </div>

      {/* ── Resumen rápido ── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3">
          <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">Pendientes</p>
          <p className="text-xl font-extrabold text-amber-900">{pendientes}</p>
        </div>
        <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-3">
          <p className="text-[11px] font-semibold text-sky-700 uppercase tracking-wide">En proceso</p>
          <p className="text-xl font-extrabold text-sky-900">{enProceso}</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
          <p className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wide">Atendidas</p>
          <p className="text-xl font-extrabold text-emerald-900">{atendidas}</p>
        </div>
      </div>

      {/* ── Filtros ── */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
        <div className="relative flex-1 sm:min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Buscar por Nº RQ/RAL, OP, producto, material o solicitante…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && buscar()}
          />
        </div>
        <Select value={estadoFiltro} onValueChange={setEstadoFiltro}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            <SelectItem value="Pendiente">Pendiente</SelectItem>
            <SelectItem value="En proceso">En proceso</SelectItem>
            <SelectItem value="Atendido">Atendido</SelectItem>
          </SelectContent>
        </Select>
        {/* Task 35: filtro por FECHA (columna Fecha de la lista). */}
        <div className="relative w-full sm:w-[150px]">
          <Input
            type="date"
            className="pr-8"
            title="Filtrar por fecha de la RQ"
            value={fechaFiltro}
            onChange={(e) => setFechaFiltro(e.target.value)}
          />
          {fechaFiltro && (
            <button
              type="button"
              aria-label="Quitar filtro de fecha"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              onClick={() => setFechaFiltro('')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Task 35: filtro por TURNO del RQ (hoja 004=T1 · 005=T2).
            Históricos sin turno de hoja se filtran por su turno del sistema. */}
        <Select value={turnoFiltro} onValueChange={setTurnoFiltro}>
          <SelectTrigger className="w-full sm:w-[150px]">
            <SelectValue placeholder="Turno" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los turnos</SelectItem>
            <SelectItem value="T1">Turno 1 (T1 · 004)</SelectItem>
            <SelectItem value="T2">Turno 2 (T2 · 005)</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={buscar} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Buscar
        </Button>
      </div>

      {/* ── EN VIVO ── */}
      <div className="flex items-center gap-2 flex-wrap -mt-1">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          En vivo{enVivoHora ? ` · actualizado ${enVivoHora}` : ''}
          <span className="hidden min-[430px]:inline font-normal text-slate-500">
            — lo que registre otro usuario aparece solo
          </span>
        </span>
        {nuevosPendientes && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[10px] border-amber-300 text-amber-800 hover:bg-amber-50"
            onClick={() => {
              setNuevosPendientes(false)
              cargar(0, true, filtrosActivosRef.current)
            }}
          >
            <RefreshCw className="h-2.5 w-2.5" /> Hay RQ nuevas — Ver actualizado
          </Button>
        )}
      </div>

      {/* ── Listado desktop (UNIFICADO: RQ + RAL con badge violeta) ── */}
      <div className="hidden md:block rounded-lg border bg-white overflow-x-auto">
        <table className="w-full text-sm min-w-[960px]">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 w-[150px]">Nº Documento</th>
              <th className="px-3 py-2">Detalle</th>
              <th className="px-3 py-2 w-[120px]">Fecha</th>
              <th className="px-3 py-2 w-[70px]">Turno</th>
              <th className="px-3 py-2 w-[150px]">Línea</th>
              <th className="px-3 py-2 w-[120px]">Solicitante</th>
              <th className="px-3 py-2 w-[110px]">Estado</th>
              <th className="px-3 py-2 w-[190px]">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filasUnificadas.length === 0 && !loading && !cargandoRals && (
              <tr>
                <td colSpan={8} className="text-center text-sm text-slate-400 py-10">
                  <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  No hay RQ ni RAL registradas con los filtros actuales.
                </td>
              </tr>
            )}
            {filasUnificadas.map((f) =>
              f.tipo === 'RQ' ? (
                <FilaRqTabla
                  key={f.key}
                  r={f.rq}
                  puedeEliminar={puedeEliminar}
                  cargandoEdicion={cargandoEdicion === f.rq.id}
                  onAtender={() => abrirDetalle(f.rq.id)}
                  onEditar={() => void abrirEdicion(f.rq)}
                  onEliminar={() => setDeleteTarget(f.rq)}
                />
              ) : (
                <FilaRalTabla
                  key={f.key}
                  r={f.ral}
                  puedeEliminar={puedeEliminar}
                  onAtender={() => abrirDetalleRal(f.ral.id)}
                  onEliminar={() => setDeleteRalTarget(f.ral)}
                />
              )
            )}
          </tbody>
        </table>
      </div>

      {/* ── Listado móvil (UNIFICADO: RQ + RAL con badge violeta) ── */}
      <div className="md:hidden space-y-3">
        {filasUnificadas.length === 0 && !loading && !cargandoRals && (
          <p className="text-sm text-slate-400 text-center py-8">
            <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            No hay RQ ni RAL registradas con los filtros actuales.
          </p>
        )}
        {filasUnificadas.map((f) =>
          f.tipo === 'RQ' ? (
            <div key={f.key} className="rounded-xl border bg-white p-3.5 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-slate-900">RQ {f.rq.numeroRq || 'sin número'}</p>
                  <p className="text-xs text-slate-500 truncate">
                    {f.rq.productoCodigo ? `${f.rq.productoCodigo} · ` : ''}
                    {f.rq.productoDescripcion || 'sin producto'}
                  </p>
                </div>
                <Badge variant="outline" className={`${ESTADO_CLASE[f.rq.estado] ?? ''} text-[10px] shrink-0`}>
                  {f.rq.estado}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs text-slate-500">
                <span>Fecha: {f.rq.fecha}</span>
                <span>
                  Turno: {f.rq.turnoRq || f.rq.turno}
                  {f.rq.turnoRq && f.rq.turnoRq !== f.rq.turno ? ` (sist. ${f.rq.turno})` : ''}
                </span>
                {f.rq.linea && (
                  <span className="min-w-0 truncate col-span-2" title={f.rq.linea}>
                    Línea: {f.rq.linea}
                  </span>
                )}
                {f.rq.ordenProduccion && <span>OP: {f.rq.ordenProduccion}</span>}
                {f.rq.solicitante && <span className="min-w-0 truncate" title={f.rq.solicitante}>Pide: {f.rq.solicitante}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="flex-1 h-9 gap-1.5 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
                  onClick={() => abrirDetalle(f.rq.id)}
                >
                  {f.rq.estado === 'Pendiente' ? (
                    <>
                      <PackageOpen className="h-4 w-4" /> Atender
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4" /> Ver / seguir atendiendo
                    </>
                  )}
                </Button>
                {puedeEliminar && (
                  <>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-slate-500 hover:text-teal-700"
                      onClick={() => void abrirEdicion(f.rq)}
                      disabled={cargandoEdicion === f.rq.id}
                      title="Editar RQ (corregir líneas erradas)"
                    >
                      {cargandoEdicion === f.rq.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Pencil className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-rose-500 hover:bg-rose-50"
                      onClick={() => setDeleteTarget(f.rq)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div key={f.key} className="rounded-xl border border-violet-100 bg-white p-3.5 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
                    <Badge variant="outline" className="border-violet-300 bg-violet-100 text-violet-800 text-[10px]">RAL</Badge>
                    {f.ral.documento || 'sin documento'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {f.ral.areaSolicitante || '—'}
                    {f.ral.solicitante ? ` · ${f.ral.solicitante}` : ''}
                  </p>
                </div>
                <Badge variant="outline" className={`${ESTADO_CLASE[f.ral.estado] ?? ''} text-[10px] shrink-0`}>
                  {f.ral.estado}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs text-slate-500">
                <span>Fecha: {f.ral.fecha}</span>
                <span>{f.ral.articulos} artículo(s)</span>
                {f.ral.linea && <span className="min-w-0 truncate col-span-2" title={f.ral.linea}>Línea: {f.ral.linea}</span>}
                {f.ral.almacen && <span>Almacén: {f.ral.almacen}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="flex-1 h-9 gap-1.5 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
                  onClick={() => abrirDetalleRal(f.ral.id)}
                >
                  {f.ral.estado === 'Pendiente' ? (
                    <>
                      <PackageOpen className="h-4 w-4" /> Atender
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4" /> Ver / seguir atendiendo
                    </>
                  )}
                </Button>
                {puedeEliminar && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-rose-500 hover:bg-rose-50"
                    onClick={() => setDeleteRalTarget(f.ral)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* ── Paginación ── */}
      {hayMas && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() =>
              cargar(offset + PAGE_SIZE, false, filtrosActivosRef.current)
            }
            disabled={loading}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Cargar más ({filas.length} de {total})
          </Button>
        </div>
      )}

      {/* ── Confirmar eliminación RQ ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar RQ</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar la RQ <b>{deleteTarget?.numeroRq || 'sin número'}</b>
              {deleteTarget?.ordenProduccion ? ` (OP ${deleteTarget.ordenProduccion})` : ''} con todos
              sus materiales y su atención? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirmar eliminación RAL ── */}
      <AlertDialog open={!!deleteRalTarget} onOpenChange={(open) => !open && setDeleteRalTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar RAL</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar el RAL <b>{deleteRalTarget?.documento || 'sin documento'}</b> con sus{' '}
              {deleteRalTarget?.articulos ?? 0} artículo(s) y su atención? Esta acción no se puede
              deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRal}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Edición supervisada (Task 26 + reversa guiada Task 27) ── */}
      {editarTarget && (
        <RqEditarDialog
          open={!!editarTarget}
          onOpenChange={(o) => !o && setEditarTarget(null)}
          rq={editarTarget}
          items={editarItems}
          onGuardada={() => {
            cargar(0, true, filtrosActivosRef.current)
          }}
          onSincronizada={(rqNueva, itemsNuevos) => {
            // Reversa guiada dentro del editor: mantiene rq+items frescos
            // (el estado de la RQ puede cambiar de Atendido a En proceso).
            setEditarTarget(rqNueva)
            setEditarItems(itemsNuevos)
            cargar(0, true, filtrosActivosRef.current)
          }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// FILAS de la tabla desktop (lista unificada RQ + RAL)
// Componentes de fila puros: misma forma visual para ambos documentos,
// la distinción es el badge «RAL» violeta (pedido del usuario).
// ═══════════════════════════════════════════════════════════════════

function FilaRqTabla({
  r,
  puedeEliminar,
  cargandoEdicion,
  onAtender,
  onEditar,
  onEliminar,
}: {
  r: RqAtencion
  puedeEliminar: boolean
  cargandoEdicion: boolean
  onAtender: () => void
  onEditar: () => void
  onEliminar: () => void
}) {
  return (
    <tr className="border-t hover:bg-slate-50/60">
      <td className="px-3 py-2 font-mono font-semibold text-indigo-700">{r.numeroRq || '—'}</td>
      <td className="px-3 py-2">
        <p className="font-medium text-slate-800 truncate max-w-[300px]" title={r.productoDescripcion}>
          {r.productoCodigo || '—'}
          {r.productoDescripcion ? ` · ${r.productoDescripcion}` : ''}
        </p>
        {r.ordenProduccion && <p className="text-[10px] text-slate-400">OP {r.ordenProduccion}</p>}
      </td>
      <td className="px-3 py-2 text-xs text-slate-500">{r.fecha}</td>
      <td className="px-3 py-2">
        {(() => {
          // Task 35: la columna muestra el TURNO DEL RQ (hoja) y avisa
          // cuando difiere del turno del sistema.
          const mostrado = r.turnoRq || r.turno
          const difiere = r.turnoRq && r.turnoRq !== r.turno
          return (
            <Badge
              variant="outline"
              title={difiere ? `Turno del RQ (hoja): ${r.turnoRq} · Turno del sistema: ${r.turno}` : undefined}
              className={`text-[10px] ${difiere ? 'border-amber-300 bg-amber-50 text-amber-800' : ''}`}
            >
              {mostrado}
            </Badge>
          )
        })()}
      </td>
      <td className="px-3 py-2 max-w-[150px]">
        {r.linea ? (
          <span className="block text-xs text-slate-600 truncate" title={r.linea}>
            {r.linea}
          </span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs truncate max-w-[120px]" title={r.solicitante}>
        {r.solicitante || '—'}
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline" className={`${ESTADO_CLASE[r.estado] ?? ''} text-[10px]`}>
          {r.estado}
        </Badge>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
            onClick={onAtender}
          >
            {r.estado === 'Pendiente' ? (
              <>
                <PackageOpen className="h-3.5 w-3.5" /> Atender
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Ver
              </>
            )}
          </Button>
          {puedeEliminar && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-slate-500 hover:text-teal-700 hover:bg-teal-50"
                onClick={onEditar}
                disabled={cargandoEdicion}
                title="Editar RQ (corregir líneas erradas)"
              >
                {cargandoEdicion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                onClick={onEliminar}
                title="Eliminar RQ"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

function FilaRalTabla({
  r,
  puedeEliminar,
  onAtender,
  onEliminar,
}: {
  r: RalRegistro
  puedeEliminar: boolean
  onAtender: () => void
  onEliminar: () => void
}) {
  return (
    <tr className="border-t bg-violet-50/20 hover:bg-violet-50/50">
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <Badge variant="outline" className="border-violet-300 bg-violet-100 text-violet-800 text-[10px] shrink-0">
            RAL
          </Badge>
          <span className="font-mono font-semibold text-violet-700 truncate" title={r.documento}>
            {r.documento || '—'}
          </span>
        </span>
      </td>
      {/* Detalle: el RAL no pide un producto de OP — pide MATERIALES para un
          área. Se muestra el área solicitante + almacén + nº de artículos. */}
      <td className="px-3 py-2">
        <p className="font-medium text-slate-800 truncate max-w-[300px]" title={r.areaSolicitante}>
          {r.areaSolicitante || '—'}
          {r.solicitante ? ` · ${r.solicitante}` : ''}
        </p>
        <p className="text-[10px] text-slate-400">
          {r.articulos} artículo(s)
          {r.almacen ? ` · Almacén ${r.almacen}` : ''}
          {r.transaccion ? ` · ${r.transaccion}` : ''}
        </p>
      </td>
      <td className="px-3 py-2 text-xs text-slate-500">{r.fecha}</td>
      {/* El RAL no es hoja de producción: no tiene turno. */}
      <td className="px-3 py-2 text-xs text-slate-300">—</td>
      <td className="px-3 py-2 max-w-[150px]">
        {r.linea ? (
          <span className="block text-xs text-slate-600 truncate" title={r.linea}>
            {r.linea}
          </span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs truncate max-w-[120px]" title={r.solicitante}>
        {r.solicitante || '—'}
      </td>
      <td className="px-3 py-2">
        <Badge variant="outline" className={`${ESTADO_CLASE[r.estado] ?? ''} text-[10px]`}>
          {r.estado}
        </Badge>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
            onClick={onAtender}
          >
            {r.estado === 'Pendiente' ? (
              <>
                <PackageOpen className="h-3.5 w-3.5" /> Atender
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Ver
              </>
            )}
          </Button>
          {puedeEliminar && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
              onClick={onEliminar}
              title="Eliminar RAL"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
