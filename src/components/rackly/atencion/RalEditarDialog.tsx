'use client'

/**
 * RACKLY — Atención a Línea · Edición supervisada de un RAL (2026-11-12).
 *
 * Paridad con la edición de la RQ (RqEditarDialog, Task 26 — pedido del
 * usuario: «colocar que también se pueda editar los ral así como los rq»).
 *
 * Qué se puede corregir:
 *   · Encabezado: documento, transacción, área, solicitante, aprobó,
 *     almacén, línea, notas, fecha (SIN turno: el RAL no es hoja de OP).
 *   · Materiales: código/descripción/unidad/CENTRO DE COSTOS/cantidad,
 *     AGREGAR y QUITAR. El centro de costos SIEMPRE editable (metadata de
 *     costos — la atención no queda atada a él).
 *
 * Integridad física (misma regla que la RPC ral_editar + validarEdicionRal):
 *   · cantidad nueva < cantidad_atendida → rechaza (primero revertir).
 *   · código/unidad de un material con atención registrada → congelados.
 *   · quitar un material con atención registrada → rechaza.
 *
 * Auditoría: cada guardado REAL queda en rals.ediciones (quién/cuándo/qué
 * cambió). Reversa dentro del editor: revertirItemRal (sin ledger/lotés —
 * el RAL no tiene modelo lote/posición).
 *
 * Permiso: mismos roles que la edición de RQ (admin + supervisores/
 * coordinador); el gating lo hace el componente padre con
 * puedeEditarSolicitudes, el guard de rol lo revalida la BD.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  validarEdicionRal,
  editarRal,
  revertirItemRal,
  obtenerRalCompleta,
  buscarRalPorDocumento,
  type RalRegistro,
  type RalItem,
  type ItemEditarRal,
  type EncabezadoEditarRal,
  type ResultadoEdicionRal,
} from '@/lib/rackly/ral'
import {
  buscarCatalogo,
  fetchCatalogo,
  getCachedCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'
import { LINEAS_OPCIONES, esLineaCanonica } from '@/lib/rackly/lineas'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Loader2, Plus, Trash2, TriangleAlert, Undo2 } from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

/** Fila editable del diálogo (cantidad como texto; key estable para React). */
type FilaEdicion = {
  key: string
  /** '' = material NUEVO (la RPC lo inserta). */
  id: string
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: string
  /** Atención ya registrada (congela código/unidad y prohíbe quitar). */
  atendida: number
  /** Descripción/unidad fueron puestas por el AUTOCOMPLETADO en esta sesión. */
  auto: boolean
}

/** Etiquetas legibles de los campos del encabezado (confirmación y auditoría). */
const ETIQUETAS: Record<string, string> = {
  documento: 'Documento',
  transaccion: 'Transacción',
  areaSolicitante: 'Área solicitante',
  solicitante: 'Solicitante',
  aprobadoPor: 'Aprobó',
  almacen: 'Almacén',
  linea: 'Línea',
  turno: 'Turno',
  notas: 'Notas',
  fecha: 'Fecha',
}

let seqFila = 0

/** Formato numérico es-PE (igual que el resto del módulo). */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

function filaVacia(): FilaEdicion {
  seqFila += 1
  return {
    key: `nueva-${seqFila}`,
    id: '',
    codigo: '',
    descripcion: '',
    unidad: '',
    centroCostos: '',
    cantidad: '',
    atendida: 0,
    auto: false,
  }
}

function filaDeItem(it: RalItem): FilaEdicion {
  return {
    key: it.id,
    id: it.id,
    codigo: it.codigo,
    descripcion: it.descripcion,
    unidad: it.unidad,
    centroCostos: it.centroCostos,
    cantidad: String(it.cantidad),
    atendida: it.cantidadAtendida,
    auto: false,
  }
}

/** Resumen legible de los cambios (para la confirmación antes de guardar). */
function resumenDeCambios(
  enc: EncabezadoEditarRal,
  ral: RalRegistro,
  filas: FilaEdicion[],
  items: RalItem[]
): { encabezado: string[]; editados: string[]; agregados: string[]; quitados: string[] } {
  const encabezado: string[] = []
  const actual = ral as unknown as Record<string, string>
  for (const [campo, etiqueta] of Object.entries(ETIQUETAS)) {
    if (enc[campo as keyof EncabezadoEditarRal] === undefined) continue
    const nuevo = String(enc[campo as keyof EncabezadoEditarRal] ?? '')
    if (nuevo !== (actual[campo] ?? '')) {
      encabezado.push(`${etiqueta}: ${actual[campo] || '—'} → ${nuevo || '—'}`)
    }
  }
  const idsEditados = new Set<string>()
  const editados: string[] = []
  const agregados: string[] = []
  for (const f of filas) {
    const codigo = f.codigo.trim().toUpperCase()
    const cantidad = aNumero(f.cantidad)
    if (!f.id) {
      if (codigo) agregados.push(`${codigo} · ${cantidad} ${f.unidad.trim()}`)
      continue
    }
    idsEditados.add(f.id)
    const previo = items.find((a) => a.id === f.id)
    if (!previo) continue
    const cambiosFila: string[] = []
    if (codigo !== previo.codigo.trim().toUpperCase()) cambiosFila.push(`código ${previo.codigo} → ${codigo}`)
    if (f.descripcion.trim() !== previo.descripcion) cambiosFila.push('descripción')
    if (f.unidad.trim() !== previo.unidad.trim()) cambiosFila.push(`unidad ${previo.unidad || '—'} → ${f.unidad.trim() || '—'}`)
    if (f.centroCostos.trim() !== previo.centroCostos.trim()) cambiosFila.push(`c. costos ${previo.centroCostos || '—'} → ${f.centroCostos.trim() || '—'}`)
    if (cantidad !== previo.cantidad) cambiosFila.push(`cantidad ${previo.cantidad} → ${cantidad}`)
    if (cambiosFila.length > 0) editados.push(`${codigo}: ${cambiosFila.join(', ')}`)
  }
  const quitados = items
    .filter((a) => !idsEditados.has(a.id))
    .map((a) => `${a.codigo} · ${a.cantidad} ${a.unidad}`)
  return { encabezado, editados, agregados, quitados }
}

export function RalEditarDialog({
  open,
  onOpenChange,
  ral,
  items,
  onGuardada,
  /** Tras revertir dentro del editor, sincroniza ral+items con el padre. */
  onSincronizada,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  ral: RalRegistro
  items: RalItem[]
  onGuardada: (r: ResultadoEdicionRal) => void
  onSincronizada?: (ral: RalRegistro, items: RalItem[]) => void
}) {
  const { perfil } = useAuth()

  // ── Encabezado ──
  const [documento, setDocumento] = useState('')
  const [transaccion, setTransaccion] = useState('')
  const [areaSolicitante, setAreaSolicitante] = useState('')
  const [solicitante, setSolicitante] = useState('')
  const [aprobadoPor, setAprobadoPor] = useState('')
  const [almacen, setAlmacen] = useState('')
  const [linea, setLinea] = useState('')
  const [turno, setTurno] = useState('')
  const [notas, setNotas] = useState('')
  const [fecha, setFecha] = useState('')

  // ── Materiales ──
  const [filas, setFilas] = useState<FilaEdicion[]>([])
  const [errores, setErrores] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmar, setConfirmar] = useState(false)

  // ── Reversa de material ATENDIDO dentro del editor ──
  const [revertirFila, setRevertirFila] = useState<FilaEdicion | null>(null)
  const [revirtiendo, setRevirtiendo] = useState(false)

  /** Catálogo cargado una vez (autocompletado de códigos). */
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  /** Fila cuyo código está tipeando (para mostrar sugerencias). */
  const [sugerenciaKey, setSugerenciaKey] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Carga inicial cada vez que se abre (estado fresco, nunca arrastrado)
  useEffect(() => {
    if (!open) return
    setDocumento(ral.documento)
    setTransaccion(ral.transaccion)
    setAreaSolicitante(ral.areaSolicitante)
    setSolicitante(ral.solicitante)
    setAprobadoPor(ral.aprobadoPor)
    setAlmacen(ral.almacen)
    setLinea(ral.linea)
    setTurno(ral.turno)
    setNotas(ral.notas)
    setFecha(ral.fecha)
    setFilas(items.length > 0 ? items.map(filaDeItem) : [filaVacia()])
    setErrores([])
    setConfirmar(false)
    setSugerenciaKey('')
    const cache = getCachedCatalogo()
    if (cache.length > 0) setCatalogo(cache)
    else void fetchCatalogo().then(setCatalogo).catch(() => setCatalogo([]))
  }, [open, ral, items])

  /** Cierra sugerencias al hacer clic fuera. */
  useEffect(() => {
    if (!sugerenciaKey) return
    const cerrar = () => setSugerenciaKey('')
    document.addEventListener('click', cerrar)
    return () => document.removeEventListener('click', cerrar)
  }, [sugerenciaKey])

  /** El catálogo llegó tarde: completa filas con código tipeado pero SIN
   *  descripción. Nunca toca descripciones guardadas ni escritas a mano. */
  useEffect(() => {
    if (catalogo.length === 0) return
    setFilas((prev) =>
      prev.map((f) => {
        if (!f.codigo.trim() || f.descripcion.trim()) return f
        const cat = buscarCatalogo(f.codigo, catalogo)
        return cat
          ? { ...f, descripcion: cat.descripcion, unidad: cat.un || f.unidad, auto: true }
          : f
      })
    )
  }, [catalogo])

  const erroresVivos = useMemo(
    () => validarEdicionRal(filasAItems(filas), items),
    [filas, items]
  )

  const resumen = useMemo(() => {
    const enc = encabezadoDesdeEstado({
      documento, transaccion, areaSolicitante, solicitante, aprobadoPor,
      almacen, linea, turno, notas, fecha,
    })
    return resumenDeCambios(enc, ral, filas, items)
  }, [ral, items, filas, documento, transaccion, areaSolicitante, solicitante, aprobadoPor, almacen, linea, turno, notas, fecha])

  const hayCambios =
    resumen.encabezado.length > 0 ||
    resumen.editados.length > 0 ||
    resumen.agregados.length > 0 ||
    resumen.quitados.length > 0

  function editarFila(key: string, patch: Partial<FilaEdicion>) {
    setFilas((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  }

  function quitarFila(key: string) {
    setFilas((prev) => (prev.length <= 1 ? prev : prev.filter((f) => f.key !== key)))
  }

  function agregarFila() {
    setFilas((prev) => [...prev, filaVacia()])
  }

  /** Abre la reversa de un material con atención (primero revertir, luego
   *  el código/unidad/cantidad quedan editables). */
  function abrirReversionFila(f: FilaEdicion) {
    setRevertirFila(f)
  }

  /** Revierte TODA la atención de la fila y refresca el editor. */
  async function ejecutarReversionFila() {
    const f = revertirFila
    if (!f || !f.id) return
    setRevirtiendo(true)
    try {
      await revertirItemRal(f.id, f.atendida)
      const completa = await obtenerRalCompleta(ral.id)
      setFilas(completa.items.length > 0 ? completa.items.map(filaDeItem) : [filaVacia()])
      setRevertirFila(null)
      onSincronizada?.(completa.ral, completa.items)
      toast.success(
        `Atención revertida: ${f.codigo} vuelve a pendiente`,
        { description: 'Ahora puedes corregir su código, unidad, cantidad o quitarlo, y volver a atender.' }
      )
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('No se pudo revertir la atención', { description: message })
    } finally {
      setRevirtiendo(false)
    }
  }

  /**
   * Código tipeado: resuelve contra el catálogo EN CADA TECLA — misma
   * política que el alta y la edición de RQ.
   */
  function editarCodigo(f: FilaEdicion, valor: string) {
    const v = valor.toUpperCase()
    const cat = v.trim()
      ? buscarCatalogo(v, catalogo.length > 0 ? catalogo : undefined)
      : undefined
    if (cat) {
      editarFila(f.key, {
        codigo: v,
        descripcion: cat.descripcion,
        unidad: cat.un || f.unidad,
        auto: true,
      })
    } else {
      editarFila(f.key, {
        codigo: v,
        descripcion: f.auto ? '' : f.descripcion,
        unidad: f.auto ? '' : f.unidad,
        auto: false,
      })
    }
    setSugerenciaKey(f.key)
  }

  /** Adopta una sugerencia del catálogo: código, descripción y unidad oficiales. */
  function adoptarCatalogo(key: string, c: CatalogoItem) {
    editarFila(key, {
      codigo: c.codigo,
      descripcion: c.descripcion,
      unidad: c.un,
      auto: true,
    })
    setSugerenciaKey('')
  }

  async function guardar() {
    // Revalida en el guardado (el usuario pudo editar mientras confirmaba)
    const vivos = validarEdicionRal(filasAItems(filas), items)
    if (vivos.length > 0) {
      setErrores(vivos)
      setConfirmar(false)
      return
    }
    // DB1 (auditoría 2026-11-12): si el DOCUMENTO CAMBIÓ, advertir si ya
    // existe otro RAL con ese número (misma política que el alta: aviso, no
    // bloqueo).
    if (documento.trim() && documento.trim() !== ral.documento.trim()) {
      try {
        const existentes = await buscarRalPorDocumento(documento, ral.id)
        if (existentes.length > 0) {
          const e0 = existentes[0]
          const ok = window.confirm(
            `Ya existe ${existentes.length > 1 ? `${existentes.length} RAL` : 'UN RAL'} con el documento ${documento.trim()}` +
              `${e0.fecha ? ` (fecha ${e0.fecha})` : ''}.\n\n¿Guardar la edición de todos modos?`
          )
          if (!ok) return
        }
      } catch {
        // Verificación no disponible: seguir (nunca peor).
      }
    }
    setErrores([])
    setSaving(true)
    try {
      const enc = encabezadoDesdeEstado({
        documento, transaccion, areaSolicitante, solicitante, aprobadoPor,
        almacen, linea, turno, notas, fecha,
      })
      const resultado = await editarRal(
        ral.id,
        enc,
        filasAItems(filas),
        {
          id: perfil?.id ?? '',
          nombre: perfil?.nombre || perfil?.correo || '',
          correo: perfil?.correo ?? '',
        }
      )
      setConfirmar(false)
      onOpenChange(false)
      if (resultado.cambios === 0) {
        toast.info('No había cambios por guardar')
      } else {
        toast.success(`RAL actualizado (${resultado.cambios} cambio${resultado.cambios === 1 ? '' : 's'})`, {
          description: 'La corrección quedó registrada en el historial de ediciones.',
        })
      }
      onGuardada(resultado)
    } catch (err: unknown) {
      const message = mensajeError(err)
      setErrores([message])
      setConfirmar(false)
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      toast.error('No se pudo guardar la edición', { description: message })
    } finally {
      setSaving(false)
    }
  }

  // ── Render ──
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[92vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Editar RAL {ral.documento || 'sin documento'}
            </DialogTitle>
            <DialogDescription>
              Corrige el encabezado o los materiales errados. La atención ya registrada se conserva;
              los cambios quedan en el historial de ediciones.
            </DialogDescription>
          </DialogHeader>

          <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-0.5">
            {/* ── Errores de validación ── */}
            {errores.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                <p className="text-[11px] font-bold text-amber-800 flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5" /> Revisa antes de guardar
                </p>
                {errores.map((e, i) => (
                  <p key={i} className="text-xs text-amber-800">{e}</p>
                ))}
              </div>
            )}

            {/* ── Encabezado ── */}
            <section className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Encabezado</h4>
              <div className="grid grid-cols-2 gap-2">
                <Campo etiqueta="Documento">
                  <Input className="h-9" value={documento} onChange={(e) => setDocumento(e.target.value)} />
                </Campo>
                <Campo etiqueta="Transacción">
                  <Input className="h-9" value={transaccion} onChange={(e) => setTransaccion(e.target.value)} />
                </Campo>
                <Campo etiqueta="Área solicitante">
                  <Input className="h-9" value={areaSolicitante} onChange={(e) => setAreaSolicitante(e.target.value)} />
                </Campo>
                <Campo etiqueta="Solicitante">
                  <Input className="h-9" value={solicitante} onChange={(e) => setSolicitante(e.target.value)} />
                </Campo>
                <Campo etiqueta="Aprobó">
                  <Input className="h-9" value={aprobadoPor} onChange={(e) => setAprobadoPor(e.target.value)} />
                </Campo>
                <Campo etiqueta="Almacén">
                  <Input className="h-9" value={almacen} onChange={(e) => setAlmacen(e.target.value)} />
                </Campo>
                <Campo etiqueta="Línea">
                  {/* Lista OFICIAL de líneas (pedido 2026-11-12). El valor
                      histórico no canónico se conserva como opción extra
                      para no mutar datos al abrir → guardar sin tocar. */}
                  <Select value={linea} onValueChange={setLinea}>
                    <SelectTrigger
                      className={`h-9 ${linea ? '' : 'text-slate-400'}`}
                      title="Por defecto Materiales auxiliares; elige de la lista (Línea 1–20 · Materiales auxiliares · Jarabe)"
                    >
                      <SelectValue placeholder="Selecciona la línea…" />
                    </SelectTrigger>
                    <SelectContent>
                      {!linea && (
                        <SelectItem value="(sin línea)" disabled>
                          (histórico sin línea — elige una de la lista)
                        </SelectItem>
                      )}
                      {!esLineaCanonica(linea) && linea.trim() !== '' && (
                        <SelectItem value={linea}>{linea} (histórico)</SelectItem>
                      )}
                      {LINEAS_OPCIONES.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Campo>
                <Campo etiqueta="Turno">
                  <Select value={turno} onValueChange={setTurno}>
                    <SelectTrigger className={`h-9 ${turno ? '' : 'text-slate-400'}`}>
                      <SelectValue placeholder="Selecciona el turno…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="T1">T1 (07:20 – 19:20)</SelectItem>
                      <SelectItem value="T2">T2 (19:21 – 07:19)</SelectItem>
                    </SelectContent>
                  </Select>
                </Campo>
                <Campo etiqueta="Fecha">
                  <Input type="date" className="h-9" value={fecha} onChange={(e) => setFecha(e.target.value)} />
                </Campo>
                <div className="col-span-2">
                  <Campo etiqueta="Notas">
                    <Input className="h-9" value={notas} onChange={(e) => setNotas(e.target.value)} />
                  </Campo>
                </div>
              </div>
            </section>

            {/* ── Materiales ── */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Materiales ({filas.length})
                </h4>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={agregarFila}>
                  <Plus className="h-3 w-3" /> Agregar material
                </Button>
              </div>

              <div className="space-y-2">
                {filas.map((f, idx) => (
                  <div
                    key={f.key}
                    className={`rounded-lg border p-2 space-y-1.5 ${
                      f.atendida > 0 ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-slate-400 w-4 shrink-0">{idx + 1}</span>
                      {/* Código + autocompletado */}
                      <div className="relative flex-1 min-w-0">
                        <Input
                          className="h-8 font-mono text-xs uppercase"
                          placeholder="Código"
                          value={f.codigo}
                          autoComplete="off"
                          onChange={(e) => editarCodigo(f, e.target.value)}
                        />
                        {sugerenciaKey === f.key && f.codigo.trim().length >= 2 && (
                          <SugerenciasCodigo
                            filtro={f.codigo.trim().toUpperCase()}
                            catalogo={catalogo}
                            onElegir={(c) => adoptarCatalogo(f.key, c)}
                          />
                        )}
                      </div>
                      {/* Descripción */}
                      <Input
                        className="h-8 text-xs flex-[2] min-w-0"
                        placeholder="Descripción"
                        value={f.descripcion}
                        onChange={(e) => editarFila(f.key, { descripcion: e.target.value, auto: false })}
                      />
                      {/* Unidad */}
                      <Input
                        className="h-8 text-xs w-14 shrink-0"
                        placeholder="Un"
                        value={f.unidad}
                        onChange={(e) => editarFila(f.key, { unidad: e.target.value })}
                      />
                      {/* Centro de costos (SIEMPRE editable) */}
                      <Input
                        className="h-8 font-mono text-xs w-24 shrink-0"
                        placeholder="C. costos"
                        value={f.centroCostos}
                        onChange={(e) => editarFila(f.key, { centroCostos: e.target.value })}
                      />
                      {/* Cantidad */}
                      <Input
                        className="h-8 text-xs w-20 shrink-0 text-right"
                        placeholder="Cant."
                        inputMode="decimal"
                        value={f.cantidad}
                        onChange={(e) => editarFila(f.key, { cantidad: e.target.value })}
                      />
                      {/* Quitar */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                        disabled={filas.length <= 1 || f.atendida > 0}
                        title={
                          f.atendida > 0
                            ? `Tiene ${f.atendida} atendidos: revierte su atención antes de quitarlo`
                            : 'Quitar del RAL'
                        }
                        onClick={() => quitarFila(f.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      {/* Revertir la atención de este material AQUÍ */}
                      {f.id && f.atendida > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                          disabled={revirtiendo}
                          title="Revertir su atención para poder corregirlo"
                          onClick={() => abrirReversionFila(f)}
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    {f.atendida > 0 && (
                      <p className="text-[10px] font-semibold text-emerald-700 pl-5 flex items-center flex-wrap gap-x-2">
                        <span>
                          Atendidos: {f.atendida} — para corregir código/unidad o quitarlo, revierte su atención
                          (botón ⟲); la cantidad no puede bajar de {f.atendida}.
                        </span>
                        <button
                          type="button"
                          className="underline text-amber-700 hover:text-amber-800"
                          onClick={() => abrirReversionFila(f)}
                        >
                          Revertir ahora
                        </button>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button
              className="gap-1.5 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
              disabled={saving || !hayCambios || erroresVivos.length > 0}
              onClick={() => {
                const vivos = validarEdicionRal(filasAItems(filas), items)
                if (vivos.length > 0) {
                  setErrores(vivos)
                  return
                }
                setErrores([])
                setConfirmar(true)
              }}
              title={!hayCambios ? 'No has modificado nada todavía' : undefined}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmación con resumen ── */}
      <AlertDialog open={confirmar} onOpenChange={(o) => !o && setConfirmar(false)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Guardar la corrección?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  La corrección se registra con tu usuario y queda en el historial de ediciones
                  (visible para administradores).
                </p>
                {resumen.encabezado.length > 0 && (
                  <div>
                    <p className="font-bold text-slate-700">Encabezado</p>
                    <ul className="list-disc pl-4">
                      {resumen.encabezado.map((c, i) => (
                        <li key={i} className="text-xs">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {resumen.editados.length > 0 && (
                  <div>
                    <p className="font-bold text-slate-700">Materiales corregidos</p>
                    <ul className="list-disc pl-4">
                      {resumen.editados.map((c, i) => (
                        <li key={i} className="text-xs">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {resumen.agregados.length > 0 && (
                  <div>
                    <p className="font-bold text-emerald-700">Agregados</p>
                    <ul className="list-disc pl-4">
                      {resumen.agregados.map((c, i) => (
                        <li key={i} className="text-xs">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {resumen.quitados.length > 0 && (
                  <div>
                    <p className="font-bold text-rose-700">Quitados</p>
                    <ul className="list-disc pl-4">
                      {resumen.quitados.map((c, i) => (
                        <li key={i} className="text-xs">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Revisar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void guardar()
              }}
              className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white"
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Sí, guardar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* ── Confirmación de la reversa dentro del editor ── */}
      <AlertDialog open={!!revertirFila} onOpenChange={(o) => !o && !revirtiendo && setRevertirFila(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revertir la atención de {revertirFila?.codigo}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Se devolverán <b>{revertirFila ? fmt(revertirFila.atendida) : ''} {revertirFila?.unidad}</b> a pendiente
                  y el material quedará EDITABLE (código, unidad, cantidad o quitarlo).
                </p>
                <p className="text-[11px] text-slate-500">
                  La reversa solo ajusta cantidades del RAL (los materiales son generales de
                  almacén: sin lotes ni posiciones).
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revirtiendo}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void ejecutarReversionFila()
              }}
              disabled={revirtiendo}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              {revirtiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
              Sí, revertir y editar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function encabezadoDesdeEstado(s: {
  documento: string
  transaccion: string
  areaSolicitante: string
  solicitante: string
  aprobadoPor: string
  almacen: string
  linea: string
  turno: string
  notas: string
  fecha: string
}): EncabezadoEditarRal {
  // Siempre presentes: la RPC compara con lo guardado y solo aplica lo cambiado.
  return {
    documento: s.documento,
    transaccion: s.transaccion,
    areaSolicitante: s.areaSolicitante,
    solicitante: s.solicitante,
    aprobadoPor: s.aprobadoPor,
    almacen: s.almacen,
    linea: s.linea,
    turno: s.turno,
    notas: s.notas,
    fecha: s.fecha,
  }
}

function filasAItems(filas: FilaEdicion[]): ItemEditarRal[] {
  return filas.map((f, i) => ({
    ...(f.id ? { id: f.id } : {}),
    orden: i,
    codigo: f.codigo.trim().toUpperCase(),
    descripcion: f.descripcion,
    unidad: f.unidad,
    centroCostos: f.centroCostos,
    // aNumero — "1,5" se lee como 1,5 (no 15 ni 1).
    cantidad: aNumero(f.cantidad),
  }))
}

/** Sugerencias de código del catálogo (máx 6, por código o descripción). */
function SugerenciasCodigo({
  filtro,
  catalogo,
  onElegir,
}: {
  filtro: string
  catalogo: CatalogoItem[]
  onElegir: (c: CatalogoItem) => void
}) {
  const opciones = useMemo(() => {
    if (!filtro) return []
    return catalogo
      .filter(
        (c) =>
          c.codigo.toUpperCase().includes(filtro) ||
          c.descripcion.toUpperCase().includes(filtro)
      )
      .slice(0, 6)
  }, [filtro, catalogo])
  if (opciones.length === 0) return null
  return (
    <div
      className="absolute z-50 mt-1 w-full rounded-md border bg-white shadow-lg max-h-44 overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      {opciones.map((c) => (
        <button
          key={c.codigo}
          type="button"
          className="w-full text-left px-2.5 py-1.5 hover:bg-violet-50 flex items-baseline gap-2"
          onClick={() => onElegir(c)}
        >
          <span className="font-mono text-[11px] font-bold text-violet-700 shrink-0">{c.codigo}</span>
          <span className="text-[11px] text-slate-600 truncate">{c.descripcion}</span>
          <span className="text-[10px] text-slate-400 ml-auto shrink-0">{c.un}</span>
        </button>
      ))}
    </div>
  )
}

/** Etiqueta + control apilados (grid del encabezado). */
function Campo({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{etiqueta}</span>
      {children}
    </label>
  )
}
