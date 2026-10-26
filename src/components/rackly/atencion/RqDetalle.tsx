'use client'

/**
 * RACKLY — Atención a Línea · Detalle de una RQ (atender materiales).
 *
 * Tabla de materiales con las 3 columnas pedidas por el usuario (2026-10-22),
 * al lado de CANTIDAD:
 *   · ATENDIDO   → cantidad ya atendida (acumulada).
 *   · PENDIENTE  → cantidad − atendido.
 *   · ATENDER    → digita la cantidad y pulsa "Atender": pide CONFIRMACIÓN
 *                  (AlertDialog) antes de registrar; la escritura es atómica
 *                  (RPC rq_atender_item — 2 celulares nunca sobrepasan).
 *
 * Además: botón "Ver ubicación del producto" por material (salta a Racks/Piso
 * con los callbacks del page.tsx) y revierte atenciones equivocadas.
 *
 * EXCEDENTE AUTOMÁTICO (2026-10-22): cuando lo ATENDIDO supera lo pedido
 * (p. ej. tapas: 123 mil salieron vs 120 mil pedidas), la fila muestra sola
 * un badge "Excedente +X" (desktop) / línea "Excedente: +X" (móvil) — sin
 * digitar nada. ATENDIDO siempre refleja el TOTAL REAL que salió
 * (pedido + excedente) y PENDIENTE se satura en 0 (nunca negativo).
 * El botón "Excedente" solo sirve para AÑADIR una salida extra manual
 * sobre un artículo ya completo (error/ajuste).
 *
 * Móvil: tarjetas por material (sin scroll horizontal anidado).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime } from '@/hooks/useRegistrosRealtime'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import {
  atenderItemRq,
  revertirItemRq,
  obtenerRqCompleta,
  estadoDeItem,
  pendienteDeItem,
  type RqAtencion,
  type RqItem,
  type RqEdicionLog,
  type ResultadoEdicionRq,
} from '@/lib/rackly/rq-atencion'
import type { PisoTargetPosicion } from '@/lib/piso/navegacion'
import { guardarContextoSalidaRq } from '@/lib/rackly/rq-contexto-salida'
import { RqUbicacionesDialog } from '@/components/rackly/atencion/RqUbicacionesDialog'
import { RqRevisarDialog } from '@/components/rackly/atencion/RqRevisarDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  ArrowLeft,
  Loader2,
  MapPin,
  RotateCcw,
  ClipboardList,
  CheckCircle2,
  PackageOpen,
  Undo2,
  Plus,
  ScanLine,
  Pencil,
  History,
  ClipboardCheck,
} from 'lucide-react'
import { RqAtenderQrWizard } from '@/components/rackly/atencion/RqAtenderQrWizard'
import { RqEditarDialog } from '@/components/rackly/atencion/RqEditarDialog'
import {
  listarLotesPuenteDeItem,
  revertirOrigenRq,
  type LotePuenteDeItem,
} from '@/lib/rackly/rq-atencion'
import { calcularTurno } from '@/lib/rackly/turno'
import { aNumero } from '@/lib/rackly/formato'

const ESTADO_ITEM_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const ESTADO_RQ_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

/** Objetivo abierto en el diálogo de ubicaciones. */
type UbicacionAbierta = {
  codigo: string
  descripcion: string
  unidad: string
  itemId: string
  cantidadRequerida: number
  cantidadAtendida: number
}

/** Atención pendiente de confirmar (item + cantidad digitada). */
type ConfirmacionAtender = { item: RqItem; cantidad: number }

/** Reversión pendiente de confirmar. */
type ConfirmacionRevertir = { item: RqItem; cantidad: number }

/** Etiquetas legibles de los campos (historial de ediciones). */
const ETIQUETAS_CAMPO: Record<string, string> = {
  numero_rq: 'Nº RQ',
  orden_produccion: 'OP',
  producto_codigo: 'Cód. producto',
  producto_descripcion: 'Producto',
  fecha: 'Fecha',
  turno: 'Turno',
  linea: 'Línea',
  solicitante: 'Solicitante',
  notas: 'Notas',
  estado: 'Estado',
  codigo: 'código',
  unidad: 'unidad',
  cantidad: 'cantidad',
  descripcion: 'descripción',
}

/** Texto corto de una entrada del historial de ediciones. */
function resumenEdicion(e: RqEdicionLog): string {
  const r = e.resumen
  const partes: string[] = []
  if (r.encabezado > 0) partes.push(`${r.encabezado} campo${r.encabezado === 1 ? '' : 's'} del encabezado`)
  if (r.materialesEditados > 0) partes.push(`${r.materialesEditados} material${r.materialesEditados === 1 ? '' : 'es'} corregido${r.materialesEditados === 1 ? '' : 's'}`)
  if (r.materialesAgregados > 0) partes.push(`${r.materialesAgregados} agregado${r.materialesAgregados === 1 ? '' : 's'}`)
  if (r.materialesQuitados > 0) partes.push(`${r.materialesQuitados} quitado${r.materialesQuitados === 1 ? '' : 's'}`)
  return partes.join(' · ') || 'sin cambios'
}

/** Texto de UN cambio individual (antes → después). */
function textoCambio(c: Record<string, unknown>): string {
  const tipo = String(c.tipo ?? '')
  if (tipo === 'material_agregado') return `+ ${String(c.item ?? '')} (${String(c.cantidad ?? '')} ${String(c.unidad ?? '')})`
  if (tipo === 'material_quitado') return `− ${String(c.item ?? '')} (${String(c.cantidad ?? '')} ${String(c.unidad ?? '')})`
  const campo = ETIQUETAS_CAMPO[String(c.campo ?? '')] ?? String(c.campo ?? '')
  const antes = String(c.antes ?? '')
  const despues = String(c.despues ?? '')
  if (tipo === 'material') return `${String(c.item ?? '')} · ${campo}: ${antes || '—'} → ${despues || '—'}`
  return `${campo}: ${antes || '—'} → ${despues || '—'}`
}

export function RqDetalle({
  rqId,
  onVolver,
  onIrARacks,
  onIrAPiso,
}: {
  rqId: string
  onVolver: () => void
  onIrARacks: (bloque: string, torre: string, piso: string, posicion: string) => void
  onIrAPiso: (target: PisoTargetPosicion) => void
}) {
  const { perfil } = useAuth()
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEditar =
    perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)
  const [rq, setRq] = useState<RqAtencion | null>(null)
  const [items, setItems] = useState<RqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cantidades, setCantidades] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmarAtender, setConfirmarAtender] = useState<ConfirmacionAtender | null>(null)
  const [confirmarRevertir, setConfirmarRevertir] = useState<ConfirmacionRevertir | null>(null)
  const [ubicaciones, setUbicaciones] = useState<UbicacionAbierta | null>(null)
  /** Wizard del puente Atención↔Tránsito abierto para un material. */
  const [qrWizard, setQrWizard] = useState<UbicacionAbierta | null>(null)
  /** Revisar la atención de un material (Task 27: posiciones + saldos). */
  const [revisar, setRevisar] = useState<RqItem | null>(null)
  /** Lotes del puente del material en el diálogo de reversa (opción con origen). */
  const [lotesPuente, setLotesPuente] = useState<LotePuenteDeItem[] | null>(null)
  const [revertiendoOrigen, setRevertiendoOrigen] = useState(false)
  /** Filas COMPLETAS donde el usuario abrió el atender para añadir EXCEDENTE. */
  const [excedenteAbierto, setExcedenteAbierto] = useState<Record<string, boolean>>({})
  /** Editor supervisado de la RQ (Task 26). */
  const [editarAbierto, setEditarAbierto] = useState(false)

  const genRef = useRef(0)
  const savingRef = useRef(false)

  const cargar = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const { rq: rqNueva, items: itemsNuevos } = await obtenerRqCompleta(rqId)
      if (gen !== genRef.current) return
      setRq(rqNueva)
      setItems(itemsNuevos)
      setError('')
      // Precarga la cantidad PENDIENTE como propuesta de atención
      setCantidades((prev) => {
        const next = { ...prev }
        for (const it of itemsNuevos) {
          if (next[it.id] === undefined) next[it.id] = String(pendienteDeItem(it) || '')
        }
        return next
      })
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      const message = err instanceof Error ? err.message : 'Error desconocido'
      setError(message)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [rqId])

  useEffect(() => {
    void cargar()
  }, [cargar])

  /** Realtime + polling: otro usuario atendiendo aparece al instante. */
  const recargar = useCallback(
    (motivo: 'evento' | 'poll' | 'visible') => {
      if (savingRef.current) return
      // 'poll': refresco silencioso solo si hay cambios visibles no críticos
      void cargar()
      void motivo
    },
    [cargar]
  )
  useRegistrosRealtime('rq_atenciones', recargar)

  function abrirConfirmacion(item: RqItem) {
    // FIX auditoría Task 20 (M2): aNumero en vez de parseFloat — "1,5" antes
    // se leía como 1 (se atendía MENOS de lo físico) y "1,234" como 1.234.
    const leida = aNumero(cantidades[item.id] ?? '')
    if (!leida || leida <= 0) {
      toast.error('Digita la cantidad a atender')
      return
    }
    // v2 sobreatención: se PERMITE atender más de lo pendiente (p. ej. tapas:
    // piden 120 mil, el formato por paleta trae 123 mil → se registran 123 mil
    // y el material queda COMPLETO). La regla es "puede ser más, nunca menos";
    // la confirmación avisa del excedente antes de registrar.
    setConfirmarAtender({ item, cantidad: leida })
  }

  async function ejecutarAtender() {
    const conf = confirmarAtender
    if (!conf) return
    setConfirmarAtender(null)
    setSavingId(conf.item.id)
    savingRef.current = true
    try {
      const actualizado = await atenderItemRq(
        conf.item.id,
        conf.cantidad,
        perfil?.nombre || perfil?.correo || ''
      )
      setItems((prev) => prev.map((it) => (it.id === actualizado.id ? actualizado : it)))
      setCantidades((prev) => ({ ...prev, [actualizado.id]: String(pendienteDeItem(actualizado) || '') }))
      const completo = estadoDeItem(actualizado) === 'Atendido'
      toast.success(
        `Atendido: ${fmt(conf.cantidad)} ${conf.item.unidad}`.trim(),
        {
          description: completo
            ? actualizado.cantidadAtendida > actualizado.cantidad
              ? `Ya completaste este artículo (excedente: ${fmt(actualizado.cantidadAtendida - actualizado.cantidad)} ${actualizado.unidad})`.trim()
              : 'Ya completaste este artículo'
            : `Pendiente: ${fmt(pendienteDeItem(actualizado))} ${conf.item.unidad}`.trim(),
        }
      )
      if (completo) {
        setExcedenteAbierto((prev) => ({ ...prev, [actualizado.id]: false }))
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo atender', { description: message })
      void cargar() // re-sincroniza si otro usuario movió la fila
    } finally {
      setSavingId(null)
      savingRef.current = false
    }
  }

  async function ejecutarRevertir() {
    const conf = confirmarRevertir
    if (!conf) return
    setConfirmarRevertir(null)
    setSavingId(conf.item.id)
    savingRef.current = true
    try {
      const actualizado = await revertirItemRq(conf.item.id, conf.cantidad)
      setItems((prev) => prev.map((it) => (it.id === actualizado.id ? actualizado : it)))
      setCantidades((prev) => ({ ...prev, [actualizado.id]: String(pendienteDeItem(actualizado) || '') }))
      toast.success(`Revertido: ${fmt(conf.cantidad)} ${conf.item.unidad}`.trim())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo revertir', { description: message })
    } finally {
      setSavingId(null)
      savingRef.current = false
    }
  }

  /** Reversa del puente: compensa guías (Tránsito) y re-ingresa posiciones. */
  async function ejecutarRevertirOrigen() {
    const conf = confirmarRevertir
    if (!conf) return
    setRevertiendoOrigen(true)
    try {
      const r = await revertirOrigenRq(
        conf.item.id,
        null, // todos los lotes del puente de este material
        calcularTurno(),
        {
          id: perfil?.id ?? '',
          nombre: perfil?.nombre || perfil?.correo || '',
          correo: perfil?.correo ?? '',
        }
      )
      if (!r.ok) {
        toast.error('No se pudo revertir con origen', {
          description: r.fallo?.mensaje ?? 'Error desconocido',
        })
        return
      }
      if (r.duplicado) {
        toast.info('Ya estaba revertida — no se duplicó nada')
      } else {
        toast.success(`Revertido con origen: ${fmt(r.total_revertido ?? 0)} ${conf.item.unidad}`, {
          description: `${r.tomas_revertidas ?? 0} toma(s) devuelta(s) a su origen (guía/posición).`,
        })
      }
      setConfirmarRevertir(null)
      void cargar()
    } catch (err: unknown) {
      toast.error('No se pudo revertir con origen', {
        description: err instanceof Error ? err.message : 'Error desconocido',
      })
    } finally {
      setRevertiendoOrigen(false)
    }
  }

  /** Al abrir el diálogo de reversa, detecta si el material tiene lotes del puente. */
  async function abrirReversion(item: RqItem) {
    setConfirmarRevertir({ item, cantidad: item.cantidadAtendida })
    setLotesPuente(null)
    try {
      const lotes = await listarLotesPuenteDeItem(item.id, item.codigo)
      setLotesPuente(lotes)
    } catch {
      setLotesPuente([])
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-slate-500 gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando RQ…
      </div>
    )
  }

  if (error || !rq) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onVolver} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Volver al listado
        </Button>
        <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg p-3">
          {error || 'No se encontró la RQ.'}
        </p>
      </div>
    )
  }

  const atendidos = items.filter((it) => estadoDeItem(it) === 'Atendido').length
  const cantSolicitada = items.reduce((s, it) => s + it.cantidad, 0)
  const cantAtendida = items.reduce((s, it) => s + it.cantidadAtendida, 0)
  // Con sobreatención el avance puede pasar del 100%: la barra se satura en 100.
  const progresoPct = cantSolicitada > 0 ? Math.min(100, Math.round((cantAtendida / cantSolicitada) * 100)) : 0

  return (
    <div className="space-y-4">
      {/* ── Volver ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onVolver} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Retornar
        </Button>
        <span className="text-xs text-slate-400">Vuelve al listado para seguir atendiendo</span>
      </div>

      {/* ── Encabezado de la RQ ── */}
      <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-teal-600" />
              RQ {rq.numeroRq || 'sin número'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {rq.productoCodigo ? (
                <>
                  <span className="font-mono font-semibold text-indigo-700">{rq.productoCodigo}</span>
                  {rq.productoDescripcion ? ` · ${rq.productoDescripcion}` : ''}
                </>
              ) : (
                'Sin producto terminado'
              )}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {puedeEditar && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-slate-300 text-slate-600 hover:bg-slate-50"
                onClick={() => setEditarAbierto(true)}
                title="Corregir líneas erradas de la RQ"
              >
                <Pencil className="h-3.5 w-3.5" /> Editar
              </Button>
            )}
            <Badge variant="outline" className={`${ESTADO_RQ_CLASE[rq.estado] ?? ''}`}>
              {rq.estado}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600 min-[430px]:grid-cols-3">
          {rq.ordenProduccion && <span>OP: <b>{rq.ordenProduccion}</b></span>}
          <span>Fecha: <b>{rq.fecha}</b></span>
          <span>Turno: <b>{rq.turno}</b></span>
          {rq.linea && (
            <span className="min-w-0 truncate col-span-2 min-[430px]:col-span-1" title={rq.linea}>
              Línea: <b>{rq.linea}</b>
            </span>
          )}
          {rq.solicitante && <span className="col-span-2 min-[430px]:col-span-1 min-w-0 truncate" title={rq.solicitante}>Solicitante: <b>{rq.solicitante}</b></span>}
          <span>Registró: <b>{rq.usuarioNombre || '—'}</b></span>
        </div>
        {rq.notas && <p className="text-xs text-slate-500 whitespace-pre-wrap">{rq.notas}</p>}

        {/* Historial de ediciones (Task 26 — auditoría visible p/ admins) */}
        {rq.ediciones.length > 0 && (
          <details className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2">
            <summary className="text-[11px] font-bold text-slate-600 cursor-pointer flex items-center gap-1.5 select-none">
              <History className="h-3.5 w-3.5 text-slate-400" />
              Historial de ediciones ({rq.ediciones.length})
            </summary>
            <div className="mt-2 space-y-2">
              {rq.ediciones.map((e, i) => (
                <div key={i} className="border-l-2 border-teal-200 pl-2.5">
                  <p className="text-[11px] font-semibold text-slate-700">
                    {e.en} · {e.usuarioNombre}
                    <span className="font-normal text-slate-400"> — {resumenEdicion(e)}</span>
                  </p>
                  {e.cambios.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {e.cambios.slice(0, 8).map((c, j) => (
                        <li key={j} className="text-[10px] text-slate-500">{textoCambio(c)}</li>
                      ))}
                      {e.cambios.length > 8 && (
                        <li className="text-[10px] text-slate-400">… y {e.cambios.length - 8} más</li>
                      )}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Progreso */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500">
            <span>
              {atendidos}/{items.length} materiales completos · {fmt(cantAtendida)} de {fmt(cantSolicitada)}
            </span>
            <span>{progresoPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all"
              style={{ width: `${progresoPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Materiales (desktop: tabla con las 3 columnas nuevas) ── */}
      <div className="hidden md:block rounded-lg border bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 w-[100px]">Código</th>
              <th className="px-3 py-2">Descripción</th>
              <th className="px-3 py-2 w-[100px] text-right" title="Lo que pide la RQ">Cantidad</th>
              <th className="px-3 py-2 w-[100px] text-right" title="TOTAL real que salió = pedido + excedente">Atendido</th>
              <th className="px-3 py-2 w-[100px] text-right" title="Cantidad − atendido (nunca negativo)">Pendiente</th>
              <th className="px-3 py-2 w-[190px]">Atender</th>
              <th className="px-3 py-2 w-[120px]">Ubicación / QR</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-sm text-slate-400 py-8">
                  Esta RQ no tiene materiales registrados.
                </td>
              </tr>
            )}
            {items.map((it) => {
              const pendiente = pendienteDeItem(it)
              const estado = estadoDeItem(it)
              const atendiendo = savingId === it.id
              return (
                <tr key={it.id} className={`border-t ${estado === 'Atendido' ? 'bg-emerald-50/40' : ''}`}>
                  <td className="px-3 py-2">
                    <span className="font-mono font-semibold text-indigo-700">{it.codigo}</span>
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-slate-700 max-w-[260px] truncate" title={it.descripcion}>
                      {it.descripcion || '—'}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className={`${ESTADO_ITEM_CLASE[estado]} text-[10px] px-1.5 py-0`}>
                        {estado}
                      </Badge>
                      {it.cantidadAtendida > it.cantidad && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 border-amber-200 bg-amber-50 text-amber-700"
                          title={`Lo que salió de más sobre lo pedido: se registró ${fmt(it.cantidadAtendida)} en total`}
                        >
                          Excedente +{fmt(it.cantidadAtendida - it.cantidad)} {it.unidad}
                        </Badge>
                      )}
                      {it.usuarioAtencion && (
                        <span className="text-[10px] text-slate-400 truncate max-w-[140px]" title={it.usuarioAtencion}>
                          por {it.usuarioAtencion}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-slate-800">
                    {fmt(it.cantidad)} <span className="text-[10px] font-normal text-slate-400">{it.unidad}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">
                    {fmt(it.cantidadAtendida)}
                  </td>
                  {/* FIX Task 18: pendiente 0 → VERDE (ítem completo), antes gris */}
                  <td className={`px-3 py-2 text-right font-bold ${pendiente > 0 ? 'text-amber-700' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {fmt(pendiente)}
                  </td>
                  {/* ATENDER: digita la cantidad y confirma (excedente permitido) */}
                  <td className="px-3 py-2">
                    {pendiente > 0 || excedenteAbierto[it.id] ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 w-[74px] text-right"
                          inputMode="decimal"
                          placeholder={pendiente > 0 ? undefined : '+ excedente'}
                          value={cantidades[it.id] ?? ''}
                          onChange={(e) =>
                            setCantidades((prev) => ({ ...prev, [it.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') abrirConfirmacion(it)
                          }}
                        />
                        <Button
                          size="sm"
                          className="h-8 gap-1 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
                          disabled={atendiendo}
                          onClick={() => abrirConfirmacion(it)}
                        >
                          {atendiendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          Atender
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-emerald-600 flex items-center gap-1" title="Ya completaste este artículo">
                          <PackageOpen className="h-3.5 w-3.5" /> Completo
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-1.5 text-[10px] text-slate-400 hover:text-teal-600"
                          title="Agregar excedente (más de lo requerido)"
                          onClick={() =>
                            setExcedenteAbierto((prev) => ({ ...prev, [it.id]: !prev[it.id] }))
                          }
                        >
                          <Plus className="h-3 w-3" /> Excedente
                        </Button>
                        {it.cantidadAtendida > 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-400 hover:text-amber-600"
                            title="Revertir atención"
                            onClick={() => void abrirReversion(it)}
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 space-y-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 w-full border-violet-200 text-violet-700 hover:bg-violet-50"
                      onClick={() =>
                        setUbicaciones({
                          codigo: it.codigo,
                          descripcion: it.descripcion,
                          unidad: it.unidad,
                          itemId: it.id,
                          cantidadRequerida: it.cantidad,
                          cantidadAtendida: it.cantidadAtendida,
                        })
                      }
                    >
                      <MapPin className="h-3.5 w-3.5" /> Ver ubicación
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 w-full border-teal-200 text-teal-700 hover:bg-teal-50"
                      title="Escanear paletas: descuenta la guía en Tránsito o da salida desde la posición"
                      onClick={() =>
                        setQrWizard({
                          codigo: it.codigo,
                          descripcion: it.descripcion,
                          unidad: it.unidad,
                          itemId: it.id,
                          cantidadRequerida: it.cantidad,
                          cantidadAtendida: it.cantidadAtendida,
                        })
                      }
                    >
                      <ScanLine className="h-3.5 w-3.5" /> Atender con QR
                    </Button>
                    {/* Task 27: Revisar — desde qué posiciones se atendió y saldos */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 w-full border-slate-200 text-slate-600 hover:bg-slate-50"
                      title="Desde qué posiciones se atendió y qué saldo quedó en cada una"
                      onClick={() => setRevisar(it)}
                    >
                      <ClipboardCheck className="h-3.5 w-3.5" /> Revisar
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Materiales (móvil: tarjetas) ── */}
      <div className="md:hidden space-y-2.5">
        {items.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-8">Sin materiales registrados.</p>
        )}
        {items.map((it) => {
          const pendiente = pendienteDeItem(it)
          const estado = estadoDeItem(it)
          const atendiendo = savingId === it.id
          return (
            <div
              key={it.id}
              className={`rounded-xl border bg-white p-3 space-y-2.5 ${
                estado === 'Atendido' ? 'border-emerald-200 bg-emerald-50/40' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono font-bold text-indigo-700 text-sm">{it.codigo}</p>
                  <p className="text-xs text-slate-600 truncate" title={it.descripcion}>
                    {it.descripcion || '—'}
                  </p>
                </div>
                <Badge variant="outline" className={`${ESTADO_ITEM_CLASE[estado]} text-[10px] shrink-0`}>
                  {estado}
                </Badge>
              </div>

              {/* CANTIDAD · ATENDIDO · PENDIENTE */}
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-slate-50 border border-slate-100 py-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Cantidad</p>
                  <p className="text-sm font-extrabold text-slate-800">{fmt(it.cantidad)}</p>
                </div>
                <div className="rounded-lg bg-emerald-50/60 border border-emerald-100 py-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-500">Atendido</p>
                  <p className="text-sm font-extrabold text-emerald-700">{fmt(it.cantidadAtendida)}</p>
                </div>
                <div className="rounded-lg bg-amber-50/60 border border-amber-100 py-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-amber-500">Pendiente</p>
                  {/* FIX Task 18: pendiente 0 → VERDE (ítem completo), antes gris */}
                  <p className={`text-sm font-extrabold ${pendiente > 0 ? 'text-amber-700' : 'text-emerald-600'}`}>
                    {fmt(pendiente)}
                  </p>
                </div>
              </div>

              {it.usuarioAtencion && (
                <p className="text-[10px] text-slate-400">Atendió: {it.usuarioAtencion}</p>
              )}

              {/* ATENDER: digita + confirma (excedente permitido) */}
              {pendiente > 0 || excedenteAbierto[it.id] ? (
                <div className="flex items-center gap-2">
                  <Input
                    className="h-9 flex-1 text-right"
                    inputMode="decimal"
                    placeholder={
                      pendiente > 0
                        ? `Cantidad a atender (puedes atender más: quedan ${fmt(pendiente)})`
                        : 'Cantidad adicional (excedente)'
                    }
                    value={cantidades[it.id] ?? ''}
                    onChange={(e) => setCantidades((prev) => ({ ...prev, [it.id]: e.target.value }))}
                  />
                  <Button
                    className="h-9 gap-1.5 shrink-0 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
                    disabled={atendiendo}
                    onClick={() => abrirConfirmacion(it)}
                  >
                    {atendiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Atender
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1">
                      <PackageOpen className="h-3.5 w-3.5" /> Ya completaste este artículo
                    </span>
                    {it.cantidadAtendida > it.cantidad && (
                      <p
                        className="text-[10px] font-bold text-amber-600 mt-0.5"
                        title={`Lo que salió de más sobre lo pedido: se registró ${fmt(it.cantidadAtendida)} en total`}
                      >
                        Excedente: +{fmt(it.cantidadAtendida - it.cantidad)} {it.unidad} · Total: {fmt(it.cantidadAtendida)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 text-[11px] text-slate-400 hover:text-teal-600"
                      onClick={() =>
                        setExcedenteAbierto((prev) => ({ ...prev, [it.id]: !prev[it.id] }))
                      }
                    >
                      <Plus className="h-3 w-3" /> Excedente
                    </Button>
                    {it.cantidadAtendida > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-slate-500"
                        onClick={() => void abrirReversion(it)}
                      >
                        <Undo2 className="h-3.5 w-3.5" /> Revertir
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* VER UBICACIÓN + ATENDER CON QR + REVISAR (puente con Tránsito) */}
              <div className="grid grid-cols-3 gap-1.5">
                <Button
                  variant="outline"
                  className="h-9 gap-1 w-full border-violet-200 text-violet-700 hover:bg-violet-50 px-1"
                  onClick={() =>
                    setUbicaciones({
                      codigo: it.codigo,
                      descripcion: it.descripcion,
                      unidad: it.unidad,
                      itemId: it.id,
                      cantidadRequerida: it.cantidad,
                      cantidadAtendida: it.cantidadAtendida,
                    })
                  }
                >
                  <MapPin className="h-4 w-4" /> Ver ubicación
                </Button>
                <Button
                  variant="outline"
                  className="h-9 gap-1 w-full border-teal-200 text-teal-700 hover:bg-teal-50 px-1"
                  onClick={() =>
                    setQrWizard({
                      codigo: it.codigo,
                      descripcion: it.descripcion,
                      unidad: it.unidad,
                      itemId: it.id,
                      cantidadRequerida: it.cantidad,
                      cantidadAtendida: it.cantidadAtendida,
                    })
                  }
                >
                  <ScanLine className="h-4 w-4" /> Atender QR
                </Button>
                <Button
                  variant="outline"
                  className="h-9 gap-1 w-full border-slate-200 text-slate-600 hover:bg-slate-50 px-1"
                  title="Desde qué posiciones se atendió y qué saldo quedó en cada una"
                  onClick={() => setRevisar(it)}
                >
                  <ClipboardCheck className="h-4 w-4" /> Revisar
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Confirmación de ATENDER (aviso del usuario) ── */}
      <AlertDialog open={!!confirmarAtender} onOpenChange={(o) => !o && setConfirmarAtender(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Confirmas la atención?</AlertDialogTitle>
            <AlertDialogDescription>
              Vas a atender <b>{confirmarAtender ? fmt(confirmarAtender.cantidad) : ''}{' '}
              {confirmarAtender?.item.unidad}</b> del material{' '}
              <b className="font-mono">{confirmarAtender?.item.codigo}</b>{' '}
              {confirmarAtender?.item.descripcion ? `(${confirmarAtender.item.descripcion})` : ''}.
              {confirmarAtender &&
                confirmarAtender.cantidad > pendienteDeItem(confirmarAtender.item) && (
                  <>
                    <br />
                    <br />
                    <span className="font-semibold text-amber-700">
                      Atiendes MÁS de lo requerido (excedente:{' '}
                      {fmt(confirmarAtender.cantidad - pendienteDeItem(confirmarAtender.item))}{' '}
                      {confirmarAtender.item.unidad}): el material quedará COMPLETO.
                    </span>
                  </>
                )}
              <br />
              <br />
              Pendiente después:{' '}
              <b>
                {confirmarAtender
                  ? fmt(Math.max(pendienteDeItem(confirmarAtender.item) - confirmarAtender.cantidad, 0))
                  : ''}{' '}
                {confirmarAtender?.item.unidad}
              </b>
              . Esta acción suma a lo ya atendido y se registra con tu usuario.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={ejecutarAtender}
              className="bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white"
            >
              Sí, atender
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirmación de REVERTIR ── */}
      <AlertDialog open={!!confirmarRevertir} onOpenChange={(o) => !o && setConfirmarRevertir(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revertir la atención?</AlertDialogTitle>
            <AlertDialogDescription>
              Se devolverá <b>{confirmarRevertir ? fmt(confirmarRevertir.cantidad) : ''}</b> a pendiente
              del material <b className="font-mono">{confirmarRevertir?.item.codigo}</b>. Úsalo solo si
              la atención se registró por error.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={ejecutarRevertir} className="bg-amber-500 hover:bg-amber-600 text-white">
              Revertir
            </AlertDialogAction>
          </AlertDialogFooter>

          {/* Puente Atención↔Tránsito: reversa que también devuelve el material */}
          <div className="border-t pt-3 space-y-1.5">
            {lotesPuente === null ? (
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Revisando atenciones con origen…
              </p>
            ) : lotesPuente.length > 0 ? (
              <>
                <p className="text-[11px] text-slate-500">
                  Este material tiene <b>{lotesPuente.length}</b> atención(es) del puente{' '}
                  (QR/Tránsito) por{' '}
                  <b>
                    {fmt(lotesPuente.reduce((s, l) => s + l.total, 0))} {confirmarRevertir?.item.unidad}
                  </b>{' '}
                  — {lotesPuente[0].rq ? `RQ ${lotesPuente[0].rq}` : 'sin RQ'}.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revertiendoOrigen}
                  onClick={ejecutarRevertirOrigen}
                  className="w-full gap-1.5 border-teal-200 text-teal-700 hover:bg-teal-50"
                >
                  {revertiendoOrigen ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Revertir atención con origen (devuelve guías/posiciones)
                </Button>
              </>
            ) : (
              <p className="text-[11px] text-slate-400">
                Sin atenciones del puente (QR) para este material — la reversa simple de arriba solo
                ajusta cantidades.
              </p>
            )}
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Ubicaciones del producto ── */}
      <RqUbicacionesDialog
        open={!!ubicaciones}
        onOpenChange={(o) => !o && setUbicaciones(null)}
        codigo={ubicaciones?.codigo ?? ''}
        descripcion={ubicaciones?.descripcion ?? ''}
        unidad={ubicaciones?.unidad ?? ''}
        onIrARacks={(bloque, torre, piso, posicion) => {
          // Contexto efímero: al llegar a Racks, una salida de ESTE código
          // ofrecerá registrarse en esta RQ. Regularización responde "No".
          if (ubicaciones && rq) {
            guardarContextoSalidaRq({
              rqId: rq.id,
              numeroRq: rq.numeroRq,
              itemId: ubicaciones.itemId,
              codigo: ubicaciones.codigo,
              descripcion: ubicaciones.descripcion,
              unidad: ubicaciones.unidad,
              cantidadRequerida: ubicaciones.cantidadRequerida,
              cantidadAtendida: ubicaciones.cantidadAtendida,
            })
          }
          setUbicaciones(null)
          onIrARacks(bloque, torre, piso, posicion)
        }}
        onIrAPiso={(target) => {
          if (ubicaciones && rq) {
            guardarContextoSalidaRq({
              rqId: rq.id,
              numeroRq: rq.numeroRq,
              itemId: ubicaciones.itemId,
              codigo: ubicaciones.codigo,
              descripcion: ubicaciones.descripcion,
              unidad: ubicaciones.unidad,
              cantidadRequerida: ubicaciones.cantidadRequerida,
              cantidadAtendida: ubicaciones.cantidadAtendida,
            })
          }
          setUbicaciones(null)
          onIrAPiso(target)
        }}
      />
      {/* ── Wizard del puente Atención↔Tránsito (escaneo en lote) ── */}
      {rq && (
        <RqAtenderQrWizard
          open={!!qrWizard}
          onOpenChange={(o) => !o && setQrWizard(null)}
          rqNumero={rq.numeroRq || 'sin número'}
          item={{
            id: qrWizard?.itemId ?? '',
            codigo: qrWizard?.codigo ?? '',
            descripcion: qrWizard?.descripcion ?? '',
            unidad: qrWizard?.unidad ?? '',
            cantidad: qrWizard?.cantidadRequerida ?? 0,
            cantidadAtendida: qrWizard?.cantidadAtendida ?? 0,
          }}
          onRegistrado={() => void cargar()}
        />
      )}

      {/* ── Revisar atención (Task 27: posiciones + saldos) ── */}
      <RqRevisarDialog
        open={!!revisar}
        onOpenChange={(o) => !o && setRevisar(null)}
        item={revisar}
      />

      {/* ── Edición supervisada de la RQ (Task 26) ── */}
      {rq && (
        <RqEditarDialog
          open={editarAbierto}
          onOpenChange={setEditarAbierto}
          rq={rq}
          items={items}
          onGuardada={(r: ResultadoEdicionRq) => {
            // Aplica el resultado inmediato (sin esperar el refresco)
            setRq(r.rq)
            setItems(r.items)
            setCantidades((prev) => {
              const next = { ...prev }
              for (const it of r.items) {
                next[it.id] = String(pendienteDeItem(it) || '')
              }
              return next
            })
          }}
          onSincronizada={(rqNueva, itemsNuevos) => {
            // Reversa guiada dentro del editor (Task 27): sincroniza al instante
            setRq(rqNueva)
            setItems(itemsNuevos)
            setCantidades((prev) => {
              const next = { ...prev }
              for (const it of itemsNuevos) {
                next[it.id] = String(pendienteDeItem(it) || '')
              }
              return next
            })
          }}
        />
      )}
    </div>
  )
}
