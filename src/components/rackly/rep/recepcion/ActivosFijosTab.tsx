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
 * activación con opción «aún no tiene» · impresión Zebra (formato 'rep':
 * código grande + QR único por activo + banda META con «ACT: … · OC: …»).
 *
 * EDICIÓN/ELIMINACIÓN (ampliación del mismo día): en «Últimos activos
 * recibidos» cada documento se puede MODIFICAR (se re-carga en el formulario;
 * los activos conservados mantienen su id/QR — solo se actualizan las filas
 * tocadas y, si el documento cambia, sus campos de documento; los nuevos
 * imprimen rótulo) o ELIMINAR completo (permiso repuestos.eliminar +
 * confirmación; cuenta las filas borradas — honesto).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import { hoyISO } from '@/lib/rackly/formato'
import { toast } from 'sonner'
import { Boxes, FileText, Hash, Pencil, Printer, QrCode, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  agruparPorDocumentoAF,
  autocompletarArticuloAF,
  borrarDocumentoAF,
  duplicadosRecientesAF,
  esArticuloAFValido,
  guardarEdicionAF,
  listarActivosFijos,
  motivoInvalidoActivo,
  registrarActivosFijos,
  rotulosDesdeActivos,
  SERIE_AF,
  type ActivoFijoDB,
  type ActivoFijoNuevo,
  type FilaEditadaAF,
} from '@/lib/rackly/rep/activos-fijos'
import {
  ImprimirRotulosDialog,
  type RotuloAImprimir,
} from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'

type ModalRotulos = { rotulos: RotuloAImprimir[]; encabezado: EncabezadoRotulo; nota: string } | null

/** Fila del documento en edición (con snapshot original para detectar cambios). */
type FilaEdicionUI = {
  id: string
  articulo: string
  descripcion: string
  /** null = «sin activación» (checkbox marcado). */
  activacion: string | null
  conExcepcion: boolean
  original: { articulo: string; descripcion: string; activacion: string | null; conExcepcion: boolean }
}

type DocAF = { fecha: string; guia: string; oc: string }

type ModoEdicion = {
  clave: string
  docOriginal: DocAF
  filas: FilaEdicionUI[]
  idsEliminados: string[]
} | null

/** Detecta la EXCEPCIÓN al editar el código: todo lo que no sea 12+6 dígitos. */
function esExcepcion(articulo: string): boolean {
  return articulo.trim() !== '' && !esArticuloAFValido(articulo)
}

export function ActivosFijosTab() {
  const { perfil } = useAuth()
  const puedeRegistrar = puede(perfil, 'repuestos.gestionar')
  const puedeEliminar = puede(perfil, 'repuestos.eliminar')

  // ── Documento ──
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fGuia, setFGuia] = useState('')
  const [fOc, setFOc] = useState('')

  // ── Activo nuevo en edición ──
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
  const [editando, setEditando] = useState<ModoEdicion>(null)

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

  function limpiarDocumento() {
    setActivos([])
    setFGuia('')
    setFOc('')
    setFFecha(hoyISO())
  }

  /** Entra al MODO EDICIÓN del documento (re-carga sus filas editables). */
  function iniciarEdicion(g: { clave: string; fecha: string; guia: string; oc: string; activos: ActivoFijoDB[] }) {
    if (!puedeRegistrar) {
      toast.error('No tienes permiso para modificar recepciones de repuestos')
      return
    }
    setEditando({
      clave: g.clave,
      docOriginal: { fecha: g.fecha, guia: g.guia, oc: g.oc },
      filas: g.activos.map((a) => ({
        id: a.id,
        articulo: a.articulo,
        descripcion: a.descripcion,
        activacion: a.activacion,
        conExcepcion: a.con_excepcion,
        original: { articulo: a.articulo, descripcion: a.descripcion, activacion: a.activacion, conExcepcion: a.con_excepcion },
      })),
      idsEliminados: [],
    })
    setFFecha(g.fecha)
    setFGuia(g.guia)
    setFOc(g.oc)
    setActivos([])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /** Sale del modo edición (descarta los cambios no guardados — con aviso). */
  function cancelarEdicion() {
    const totalSinGuardar = activos.length
    if (totalSinGuardar > 0 && !window.confirm(`Hay ${totalSinGuardar} activo(s) nuevo(s) sin guardar en esta edición.\n\n¿Descartar los cambios?`)) {
      return
    }
    setEditando(null)
    limpiarDocumento()
  }

  /** Quita una fila conservada (se borrará al GUARDAR la edición). */
  function quitarFilaEdicion(i: number) {
    setEditando((prev) => {
      if (!prev) return prev
      const fila = prev.filas[i]
      return {
        ...prev,
        filas: prev.filas.filter((_, k) => k !== i),
        idsEliminados: [...prev.idsEliminados, fila.id],
      }
    })
  }

  /** Restaura una fila quitada (antes de guardar). */
  function restaurarFila(id: string) {
    setEditando((prev) => {
      if (!prev) return prev
      const filaOriginal = ultimos.find((a) => a.id === id)
      if (!filaOriginal) return prev
      return {
        ...prev,
        filas: [
          ...prev.filas,
          {
            id: filaOriginal.id,
            articulo: filaOriginal.articulo,
            descripcion: filaOriginal.descripcion,
            activacion: filaOriginal.activacion,
            conExcepcion: filaOriginal.con_excepcion,
            original: { articulo: filaOriginal.articulo, descripcion: filaOriginal.descripcion, activacion: filaOriginal.activacion, conExcepcion: filaOriginal.con_excepcion },
          },
        ],
        idsEliminados: prev.idsEliminados.filter((x) => x !== id),
      }
    })
  }

  /** Guarda la EDICIÓN: actualiza conservadas tocadas, borra quitadas, inserta nuevas. */
  async function guardarEdicion() {
    if (!editando || !puedeRegistrar) return
    if (fGuia.trim().length < 3) {
      toast.error('Digita el N° de Guía (mínimo 3 caracteres)')
      return
    }
    if (editando.filas.length + activos.length === 0) {
      toast.error('El documento quedó sin activos: quita el documento con «Eliminar» o restaura filas')
      return
    }
    // Validar TODAS las filas (conservadas editadas + nuevas) y anti-duplicado interno.
    const vistos = new Set<string>()
    for (const f of editando.filas) {
      const motivo = motivoInvalidoActivo({ articulo: f.articulo, descripcion: f.descripcion, activacion: f.activacion, conExcepcion: f.conExcepcion })
      if (motivo) {
        toast.error(`${f.original.articulo}: ${motivo}`)
        return
      }
      const clave = `${f.articulo.trim().toUpperCase()}|${f.activacion ?? ''}`
      if (vistos.has(clave)) {
        toast.error(`El activo ${f.articulo} está repetido en el documento`)
        return
      }
      vistos.add(clave)
    }
    for (const a of activos) {
      const motivo = motivoInvalidoActivo(a)
      if (motivo) {
        toast.error(`${a.articulo}: ${motivo}`)
        return
      }
      const clave = `${a.articulo.trim().toUpperCase()}|${a.activacion ?? ''}`
      if (vistos.has(clave)) {
        toast.error(`El activo ${a.articulo} está repetido en el documento`)
        return
      }
      vistos.add(clave)
    }
    setGuardando(true)
    try {
      const docNuevo: DocAF = { fecha: fFecha, guia: fGuia, oc: fOc }
      const conservadas: FilaEditadaAF[] = editando.filas.map((f) => ({
        id: f.id,
        articulo: f.articulo,
        descripcion: f.descripcion,
        activacion: f.activacion,
        conExcepcion: f.conExcepcion,
        contenidoCambio:
          f.articulo !== f.original.articulo ||
          f.descripcion !== f.original.descripcion ||
          (f.activacion ?? null) !== f.original.activacion ||
          f.conExcepcion !== f.original.conExcepcion,
      }))
      const res = await guardarEdicionAF({
        docOriginal: editando.docOriginal,
        docNuevo,
        conservadas,
        idsEliminados: editando.idsEliminados,
        nuevas: activos,
        usuario: { id: perfil?.id ?? '', nombre: perfil?.nombre ?? '', correo: perfil?.correo ?? '' },
      })
      const partes: string[] = []
      if (res.docCambio) partes.push('documento actualizado')
      if (res.actualizadas > 0) partes.push(`${res.actualizadas} activo(s) actualizado(s)`)
      if (res.eliminadas > 0) partes.push(`${res.eliminadas} eliminado(s)`)
      if (res.nuevasIds.length > 0) partes.push(`${res.nuevasIds.length} nuevo(s)`)
      toast.success(`Edición guardada · guía ${docNuevo.guia.trim()} — ${partes.join(' · ') || 'sin cambios'}`)

      // Rótulos SOLO de los activos NUEVOS (los conservados mantienen su QR).
      if (res.nuevasIds.length > 0) {
        const porId = new Map(res.nuevasIds.map((id, i) => [id, activos[i]]))
        const filasNuevas: ActivoFijoDB[] = res.nuevasIds.map((id) => {
          const a = porId.get(id) as ActivoFijoNuevo
          return {
            id,
            created_at: '',
            fecha: docNuevo.fecha,
            guia: docNuevo.guia.trim(),
            oc: docNuevo.oc.trim(),
            articulo: a.articulo,
            descripcion: a.descripcion,
            activacion: a.activacion,
            con_excepcion: a.conExcepcion,
            usuario_nombre: '',
            usuario_correo: '',
          }
        })
        setModal({
          rotulos: rotulosDesdeActivos(filasNuevas),
          encabezado: { fecha: docNuevo.fecha, numeroDocumento: docNuevo.guia.trim(), empresaOrigen: docNuevo.oc.trim() ? `OC ${docNuevo.oc.trim()}` : '', placa: '', registradoPor: perfil?.nombre ?? undefined },
          nota: `Rótulos NUEVOS de la edición (guía ${docNuevo.guia.trim()}): ${filasNuevas.length} activo(s) añadido(s). Los conservados mantienen su QR — reimprímelos con «Rótulos» si lo necesitas.`,
        })
      }
      setEditando(null)
      limpiarDocumento()
      await cargarUltimos()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la edición')
      await cargarUltimos() // mostrar el estado REAL de la BD tras el fallo
    } finally {
      setGuardando(false)
    }
  }

  /** ELIMINA el documento completo (todas sus filas) — con confirmación. */
  async function eliminarDocumento(g: { clave: string; fecha: string; guia: string; oc: string; activos: ActivoFijoDB[] }) {
    if (!puedeEliminar) {
      toast.error('No tienes permiso para eliminar recepciones de repuestos')
      return
    }
    if (editando?.clave === g.clave) {
      toast.error('Estás editando ese documento: cancela o guarda la edición antes de eliminarlo')
      return
    }
    const ok = window.confirm(
      `¿ELIMINAR el documento de activos fijos?\n\nGuía ${g.guia}${g.oc ? ` · OC ${g.oc}` : ''} · ${g.fecha}\nSe borrarán ${g.activos.length} activo(s).\n\nEsta acción no se puede deshacer.`
    )
    if (!ok) return
    setGuardando(true)
    try {
      const n = await borrarDocumentoAF({ fecha: g.fecha, guia: g.guia, oc: g.oc })
      toast.success(`Documento eliminado: ${n} activo(s) de la guía ${g.guia}`)
      await cargarUltimos()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar el documento')
      await cargarUltimos()
    } finally {
      setGuardando(false)
    }
  }

  /** Guarda el documento NUEVO (1 fila por activo) y abre los rótulos. */
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
        rotulos = rotulosDesdeActivos(res.ids.map((id) => porId.get(id)).filter(Boolean) as ActivoFijoDB[], fOc)
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
      limpiarDocumento()
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
      {/* ═══ AVISO DE EDICIÓN ═══ */}
      {editando && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-2.5">
          <p className="text-xs text-sky-900">
            <b>Editando el documento {editando.docOriginal.guia}</b> — al guardar, los cambios reemplazan el documento:
            los activos conservados mantienen su QR y los nuevos imprimen rótulo.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelarEdicion}
            disabled={guardando}
            className="h-7 shrink-0 gap-1 text-xs text-sky-700 hover:bg-sky-100"
          >
            <X className="h-3.5 w-3.5" /> Cancelar edición
          </Button>
        </div>
      )}

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
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
              {editando ? '2 · Agregar activo NUEVO al documento' : '2 · Activo recibido'}
            </p>
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

      {/* ═══ 3 · FILAS CONSERVADAS EDITABLES (solo en edición) ═══ */}
      {editando && editando.filas.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
            3 · Activos del documento ({editando.filas.length}) — edita, quita o restaura
          </p>
          <ul className="space-y-2">
            {editando.filas.map((f, i) => {
              const tocada =
                f.articulo !== f.original.articulo ||
                f.descripcion !== f.original.descripcion ||
                (f.activacion ?? null) !== f.original.activacion ||
                f.conExcepcion !== f.original.conExcepcion
              return (
                <li key={f.id} className={`rounded-lg border p-2 space-y-1.5 ${tocada ? 'border-amber-300 bg-amber-50/50' : ''}`}>
                  <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr]">
                    <div className="grid gap-1">
                      <Label className="text-[11px] text-slate-500">N° de Artículo</Label>
                      <Input
                        className="h-8 font-mono uppercase"
                        value={f.articulo}
                        onChange={(e) => {
                          const v = e.target.value.toUpperCase()
                          setEditando((prev) => prev && {
                            ...prev,
                            filas: prev.filas.map((x, k) => (k === i ? { ...x, articulo: v, conExcepcion: esExcepcion(v) } : x)),
                          })
                        }}
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-[11px] text-slate-500">Descripción</Label>
                      <Input
                        className="h-8"
                        value={f.descripcion}
                        onChange={(e) => {
                          const v = e.target.value
                          setEditando((prev) => prev && {
                            ...prev,
                            filas: prev.filas.map((x, k) => (k === i ? { ...x, descripcion: v } : x)),
                          })
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="h-8 w-56 font-mono uppercase disabled:opacity-50"
                      placeholder="Código de activación"
                      value={f.activacion ?? ''}
                      disabled={f.activacion === null}
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase()
                        setEditando((prev) => prev && {
                          ...prev,
                          filas: prev.filas.map((x, k) => (k === i ? { ...x, activacion: v } : x)),
                        })
                      }}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={f.activacion === null}
                        onChange={(e) => {
                          const sin = e.target.checked
                          setEditando((prev) => prev && {
                            ...prev,
                            filas: prev.filas.map((x, k) => (k === i ? { ...x, activacion: sin ? null : '' } : x)),
                          })
                        }}
                        className="h-3.5 w-3.5"
                      />
                      Aún no tiene
                    </label>
                    <span className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={() => quitarFilaEdicion(i)} disabled={guardando} className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-50">
                      <Trash2 className="h-3.5 w-3.5" /> Quitar
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ═══ FILAS QUITADAS (restaurables antes de guardar) ═══ */}
      {editando && editando.idsEliminados.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 space-y-2">
          <p className="text-[11px] font-bold text-red-400 uppercase tracking-wide">Se eliminarán al guardar ({editando.idsEliminados.length})</p>
          <ul className="divide-y">
            {editando.idsEliminados.map((id) => {
              const a = ultimos.find((x) => x.id === id)
              return (
                <li key={id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <span className="font-mono font-bold">{a?.articulo ?? id}</span>
                  <Button variant="ghost" size="sm" onClick={() => restaurarFila(id)} className="h-7 gap-1 px-2 text-xs text-emerald-700 hover:bg-emerald-50">
                    Restaurar
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ═══ 4 · LISTA DEL DOCUMENTO (activos nuevos) ═══ */}
      {activos.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <div className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-slate-400" />
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
              {editando ? `Activos NUEVOS a añadir (${activos.length})` : `3 · Activos del documento (${activos.length})`}
            </p>
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
          {editando ? (
            <Button onClick={guardarEdicion} disabled={guardando} className="w-full gap-1">
              {guardando ? 'Guardando…' : 'Guardar cambios de la edición'}
            </Button>
          ) : (
            <Button onClick={guardar} disabled={guardando} className="w-full gap-1">
              {guardando ? 'Guardando…' : `Guardar ${activos.length} activo(s) e imprimir rótulos`}
            </Button>
          )}
        </div>
      )}

      {/* Botón de guardar edición visible aunque no haya NUEVOS (solo cambió filas/documento) */}
      {editando && activos.length === 0 && (
        <Button onClick={guardarEdicion} disabled={guardando} className="w-full gap-1">
          {guardando ? 'Guardando…' : 'Guardar cambios de la edición'}
        </Button>
      )}

      {/* ═══ 5 · ÚLTIMOS ACTIVOS RECIBIDOS (reimpresión · edición · eliminación) ═══ */}
      {grupos.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Últimos activos recibidos (reimpresión · editar · eliminar)</p>
          <ul className="divide-y">
            {grupos.map((g) => (
              <li key={g.clave} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <span>
                  <b className="font-mono">{g.guia}</b>
                  {g.oc ? <span className="text-xs text-slate-500"> · OC {g.oc}</span> : null}
                  <span className="text-xs text-slate-500"> · {g.fecha} · {g.activos.length} activo(s)</span>
                </span>
                {editando?.clave === g.clave ? (
                  <span className="text-xs font-bold text-sky-700">· en edición</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={guardando}
                      onClick={() => {
                        setModal({
                          rotulos: rotulosDesdeActivos(g.activos, g.oc),
                          encabezado: { fecha: g.fecha, numeroDocumento: g.guia, empresaOrigen: g.oc ? `OC ${g.oc}` : '', placa: '' },
                          nota: `Reimpresión · guía ${g.guia}: ${g.activos.length} rótulo(s) de activos fijos (con OC y código de activación en la banda inferior).`,
                        })
                      }}
                    >
                      <Printer className="h-3.5 w-3.5" /> Rótulos
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={guardando}
                      onClick={() => iniciarEdicion(g)}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs text-red-600 hover:bg-red-50"
                      disabled={guardando}
                      onClick={() => eliminarDocumento(g)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Eliminar
                    </Button>
                  </span>
                )}
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
