'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS · RECEPCIÓN — PESTAÑA «ACTIVOS FIJOS»
 * (pedido del usuario 2026-11-17). Pestaña NUEVA y AUTOCONTENIDA del módulo
 * Recepción: no toca el flujo de mercadería (guía → RPC → Tránsito →
 * lonchera) ni comparte estado con él — cero conflicto con otras pestañas
 * (metodología paso 5).
 *
 * Campos: N° Guía · N° OC · N° de Artículo (autocompletado serie 12:
 * «22» → 12000022, con botón de EXCEPCIÓN para otras series) · descripción
 * manual (hasta contar con la base de datos de donde jalarla) · código de
 * activación con opción «aún no tiene» · impresión Zebra (formato 'rep',
 * código grande + QR único por activo + «ACT: …» en la descripción).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import { hoyISO } from '@/lib/rackly/formato'
import { toast } from 'sonner'
import { Boxes, FileText, Hash, Printer, QrCode, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  agruparPorDocumentoAF,
  autocompletarArticuloAF,
  duplicadosRecientesAF,
  listarActivosFijos,
  motivoInvalidoActivo,
  registrarActivosFijos,
  rotulosDesdeActivos,
  SERIE_AF,
  type ActivoFijoDB,
  type ActivoFijoNuevo,
} from '@/lib/rackly/rep/activos-fijos'
import {
  ImprimirRotulosDialog,
  type RotuloAImprimir,
} from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'

type ModalRotulos = { rotulos: RotuloAImprimir[]; encabezado: EncabezadoRotulo; nota: string } | null

export function ActivosFijosTab() {
  const { perfil } = useAuth()
  const puedeRegistrar = puede(perfil, 'repuestos.gestionar')

  // ── Documento ──
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fGuia, setFGuia] = useState('')
  const [fOc, setFOc] = useState('')

  // ── Activo en edición ──
  const [sufijo, setSufijo] = useState('')
  const [conExcepcion, setConExcepcion] = useState(false)
  const [articuloExcepcion, setArticuloExcepcion] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [activacion, setActivacion] = useState('')
  const [sinActivacion, setSinActivacion] = useState(false)

  // ── Documento en curso + datos ──
  const [activos, setActivos] = useState<ActivoFijoNuevo[]>([])
  const [guardando, setGuardando] = useState(false)
  const [modal, setModal] = useState<ModalRotulos>(null)
  const [ultimos, setUltimos] = useState<ActivoFijoDB[]>([])

  const autocompletado = useMemo(() => autocompletarArticuloAF(sufijo), [sufijo])
  const articuloActual = conExcepcion
    ? articuloExcepcion.trim().toUpperCase()
    : autocompletado.completo

  const cargarUltimos = useCallback(async () => {
    try {
      setUltimos(await listarActivosFijos())
    } catch {
      // la lista es informativa: un fallo de red no bloquea el registro
    }
  }, [])

  useEffect(() => {
    cargarUltimos()
  }, [cargarUltimos])

  /** Agrega el activo digitado a la lista del documento (validado). */
  function agregarActivo() {
    const activo: ActivoFijoNuevo = {
      articulo: articuloActual,
      descripcion: descripcion.trim(),
      activacion: sinActivacion ? null : activacion.trim().toUpperCase(),
      conExcepcion,
    }
    const motivo = motivoInvalidoActivo(activo)
    if (motivo) {
      toast.error(motivo)
      return
    }
    if (activos.some((a) => a.articulo === activo.articulo && a.activacion === activo.activacion)) {
      toast.error('Ese activo ya está en la lista (mismo artículo y mismo código de activación)')
      return
    }
    setActivos((prev) => [...prev, activo])
    setSufijo('')
    setArticuloExcepcion('')
    setDescripcion('')
    setActivacion('')
    setSinActivacion(false)
  }

  /** Guarda el documento completo (1 fila por activo) y abre los rótulos. */
  async function guardar() {
    if (!puedeRegistrar) {
      toast.error('No tienes permiso para registrar recepciones de repuestos')
      return
    }
    if (fGuia.trim().length < 3) {
      toast.error('Digita el N° de Guía (mínimo 3 caracteres)')
      return
    }
    if (activos.length === 0) {
      toast.error('Agrega al menos un activo a la lista')
      return
    }
    setGuardando(true)
    try {
      // ANTI-DUPLICADO: mismos artículos bajo la misma guía hace <1 min → confirmar.
      const recientes = await duplicadosRecientesAF(fGuia, activos.map((a) => a.articulo))
      if (recientes > 0) {
        const ok = window.confirm(
          `Ya existen ${recientes} activo(s) con estos artículos bajo la guía ${fGuia.trim()} registrados hace menos de 1 minuto.\n\n¿Registrar de todos modos?`
        )
        if (!ok) {
          setGuardando(false)
          return
        }
      }
      const res = await registrarActivosFijos(
        activos,
        { fecha: fFecha, guia: fGuia, oc: fOc },
        { id: perfil?.id ?? '', nombre: perfil?.nombre ?? '', correo: perfil?.correo ?? '' }
      )
      toast.success(`Activos fijos registrados: ${res.ids.length} activo(s) · guía ${fGuia.trim()}`)
      const encabezado: EncabezadoRotulo = {
        fecha: fFecha,
        numeroDocumento: fGuia.trim(),
        empresaOrigen: fOc.trim() ? `OC ${fOc.trim()}` : '',
        placa: '',
        registradoPor: perfil?.nombre ?? undefined,
      }
      // Rótulos con QR único: re-lee las filas recién insertadas para que el
      // QR de cada rótulo lleve el id de SU fila (misma convención del módulo).
      let rotulos: RotuloAImprimir[] = []
      try {
        const filas = await listarActivosFijos(res.ids.length + 20)
        const porId = new Map(filas.map((f) => [f.id, f]))
        rotulos = rotulosDesdeActivos(res.ids.map((id) => porId.get(id)).filter(Boolean) as ActivoFijoDB[])
      } catch {
        rotulos = rotulosDesdeActivos(
          activos.map((a, i) => ({
            id: res.ids[i] ?? '',
            created_at: '',
            fecha: fFecha,
            guia: fGuia.trim(),
            oc: fOc.trim(),
            articulo: a.articulo,
            descripcion: a.descripcion,
            activacion: a.activacion,
            con_excepcion: a.conExcepcion,
            usuario_nombre: '',
            usuario_correo: '',
          }))
        )
      }
      if (rotulos.length > 0) {
        setModal({
          rotulos,
          encabezado,
          nota: `Activos fijos de la guía ${fGuia.trim()}: ${rotulos.length} rótulo(s). Configura las copias e imprime en la Zebra.`,
        })
      }
      setActivos([])
      setFGuia('')
      setFOc('')
      await cargarUltimos()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la recepción de activos fijos')
    } finally {
      setGuardando(false)
    }
  }

  const grupos = useMemo(() => agruparPorDocumentoAF(ultimos), [ultimos])

  return (
    <div className="space-y-4">
      {/* ═══ 1 · DATOS DEL DOCUMENTO ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-400" />
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">1 · Datos del documento (activos fijos)</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="af-guia" className="text-xs">N° de Guía *</Label>
            <Input id="af-guia" className="font-mono uppercase" placeholder="Guía de remisión" value={fGuia} onChange={(e) => setFGuia(e.target.value.toUpperCase())} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="af-oc" className="text-xs">N° de OC</Label>
            <Input id="af-oc" className="font-mono uppercase" placeholder="Orden de compra" value={fOc} onChange={(e) => setFOc(e.target.value.toUpperCase())} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="af-fecha" className="text-xs">Fecha</Label>
            <Input id="af-fecha" type="date" value={fFecha} onChange={(e) => setFFecha(e.target.value || hoyISO())} />
          </div>
        </div>
      </div>

      {/* ═══ 2 · ACTIVO ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-slate-400" />
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">2 · Activo recibido</p>
          </div>
          {/* BOTÓN DE EXCEPCIÓN: otra serie de inicio distinta a 12… */}
          <Button
            type="button"
            size="sm"
            variant={conExcepcion ? 'default' : 'outline'}
            onClick={() => setConExcepcion((v) => !v)}
            className="h-7 gap-1 text-xs"
          >
            <TriangleAlert className="h-3.5 w-3.5" />
            {conExcepcion ? 'Excepción de serie: ACTIVA' : 'Excepción de serie'}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="af-articulo" className="text-xs">N° de Artículo *</Label>
            {conExcepcion ? (
              <Input
                id="af-articulo"
                className="font-mono uppercase"
                placeholder="Serie distinta (ej: AF-2024-001)"
                value={articuloExcepcion}
                onChange={(e) => setArticuloExcepcion(e.target.value.toUpperCase())}
              />
            ) : (
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">{SERIE_AF}</span>
                <Input
                  id="af-articulo"
                  className="pl-7 font-mono"
                  inputMode="numeric"
                  placeholder="22 → 12000022"
                  value={sufijo}
                  onChange={(e) => setSufijo(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                />
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              {conExcepcion
                ? 'Excepción: escribe el código COMPLETO (otra serie de inicio).'
                : articuloActual
                  ? <>Se autocompleta a <b className="font-mono">{articuloActual}</b> (serie {SERIE_AF} fija + lo que digites)</>
                  : `Digita el número final: 22 → ${SERIE_AF}000022 · pega el código completo si lo tienes`}
            </p>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="af-desc" className="text-xs">Descripción (manual)</Label>
            <Input id="af-desc" placeholder="Ej: TORNO INDUSTRIAL 3 EJES" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
            <p className="text-[11px] text-slate-500">Escritura manual — se jalará de la base de datos cuando esté disponible.</p>
          </div>

          <div className="grid gap-1 sm:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="af-act" className="text-xs flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-slate-400" /> Código de activación
              </Label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={sinActivacion}
                  onChange={(e) => setSinActivacion(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Aún no tiene código de activación (desactivar el campo)
              </label>
            </div>
            <Input
              id="af-act"
              className="font-mono uppercase disabled:opacity-50"
              placeholder="Ej: SN-88213 / 2024-ACT-015"
              value={activacion}
              disabled={sinActivacion}
              onChange={(e) => setActivacion(e.target.value.toUpperCase())}
            />
          </div>
        </div>

        <Button type="button" size="sm" onClick={agregarActivo} className="gap-1">
          <Hash className="h-3.5 w-3.5" /> Agregar activo a la lista
        </Button>
      </div>

      {/* ═══ 3 · LISTA DEL DOCUMENTO ═══ */}
      {activos.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <div className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-slate-400" />
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">3 · Activos del documento ({activos.length})</p>
          </div>
          <ul className="divide-y">
            {activos.map((a, i) => (
              <li key={`${a.articulo}-${a.activacion ?? 'sin'}-${i}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="font-mono font-bold">{a.articulo}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-600">
                  {a.descripcion || '—'}
                  {a.activacion ? ` · ACT: ${a.activacion}` : ' · sin activación'}
                  {a.conExcepcion ? ' · excepción' : ''}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setActivos((prev) => prev.filter((_, k) => k !== i))} className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-50">
                  <Trash2 className="h-3.5 w-3.5" /> Quitar
                </Button>
              </li>
            ))}
          </ul>
          <Button onClick={guardar} disabled={guardando} className="w-full gap-1">
            {guardando ? 'Guardando…' : `Guardar ${activos.length} activo(s) e imprimir rótulos`}
          </Button>
        </div>
      )}

      {/* ═══ 4 · ÚLTIMOS ACTIVOS RECIBIDOS (reimpresión) ═══ */}
      {grupos.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Últimos activos recibidos (reimpresión de rótulos)</p>
          <ul className="divide-y">
            {grupos.map((g) => (
              <li key={g.clave} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <span>
                  <b className="font-mono">{g.guia}</b>
                  {g.oc ? <span className="text-xs text-slate-500"> · OC {g.oc}</span> : null}
                  <span className="text-xs text-slate-500"> · {g.fecha} · {g.activos.length} activo(s)</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    setModal({
                      rotulos: rotulosDesdeActivos(g.activos),
                      encabezado: { fecha: g.fecha, numeroDocumento: g.guia, empresaOrigen: g.oc ? `OC ${g.oc}` : '', placa: '' },
                      nota: `Reimpresión · guía ${g.guia}: ${g.activos.length} rótulo(s) de activos fijos.`,
                    })
                  }}
                >
                  <Printer className="h-3.5 w-3.5" /> Rótulos
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ImprimirRotulosDialog
        open={modal !== null}
        onOpenChange={(o) => { if (!o) setModal(null) }}
        rotulos={modal?.rotulos ?? []}
        encabezado={modal?.encabezado ?? { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '' }}
        nota={modal?.nota}
        subtitulo={`${modal?.rotulos.length ?? 0} activo(s) · etiqueta 15 × 10 cm · activos fijos de Repuestos`}
        formato="rep"
      />
    </div>
  )
}
