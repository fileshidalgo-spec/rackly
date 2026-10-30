'use client'

/**
 * RACKLY — Atención a Línea · Edición supervisada de una RQ (Task 26).
 *
 * Qué resuelve: la RQ registrada (foto/OCR o manual) era INCORREGIBLE — si
 * el supervisor encontraba una línea errada al atender (código mal leído,
 * cantidad equivocada, material que no era, encabezado errado), la única
 * salida era ELIMINAR la RQ completa (perdiendo el avance de atención) o
 * convivir con el error. Este diálogo da la opción de EDITAR.
 *
 * Qué se puede corregir:
 *   · Encabezado: Nº RQ, OP, producto, fecha, turno, línea, solicitante, notas.
 *   · Materiales: editar código/descripción/unidad/cantidad, AGREGAR y QUITAR.
 *
 * Integridad física (misma regla que la RPC rq_editar_rq — validarEdicionRq):
 *   · cantidad nueva < cantidad_atendida → rechaza (primero revertir).
 *   · código/unidad de un material con atención registrada → congelados.
 *   · quitar un material con atención registrada → rechaza.
 *
 * Auditoría: cada guardado REAL queda en rq_atenciones.ediciones (quién/
 * cuándo/qué cambió) — los administradores pueden auditarlo en el detalle
 * de la RQ. La tabla movimientos NO se toca (es el kardex del stock físico).
 *
 * Permiso: mismos roles que pueden ELIMINAR una RQ (supervisores/admin);
 * el gating lo hace el componente padre, el guard de rol lo revalida la BD.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  validarEdicionRq,
  editarRq,
  revertirItemRq,
  revertirOrigenRq,
  obtenerRqCompleta,
  listarLotesPuenteDeItem,
  buscarRqPorNumero,
  type RqAtencion,
  type RqItem,
  type ItemEditarRq,
  type EncabezadoEditarRq,
  type ResultadoEdicionRq,
  type LotePuenteDeItem,
} from '@/lib/rackly/rq-atencion'
import {
  fetchCatalogo,
  getCachedCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { calcularTurno } from '@/lib/rackly/turno'
import { aNumero } from '@/lib/rackly/formato'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  cantidad: string
  /** Atención ya registrada (congela código/unidad y prohíbe quitar). */
  atendida: number
}

/** Etiquetas legibles de los campos del encabezado (confirmación y auditoría). */
const ETIQUETAS: Record<string, string> = {
  numeroRq: 'Nº RQ',
  ordenProduccion: 'OP',
  productoCodigo: 'Cód. producto',
  productoDescripcion: 'Producto',
  fecha: 'Fecha',
  turno: 'Turno',
  turnoRq: 'Turno del RQ',
  linea: 'Línea',
  solicitante: 'Solicitante',
  notas: 'Notas',
}

let seqFila = 0

/** Formato numérico es-PE (igual que el resto del módulo). */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

function filaVacia(): FilaEdicion {
  seqFila += 1
  return { key: `nueva-${seqFila}`, id: '', codigo: '', descripcion: '', unidad: '', cantidad: '', atendida: 0 }
}

function filaDeItem(it: RqItem): FilaEdicion {
  return {
    key: it.id,
    id: it.id,
    codigo: it.codigo,
    descripcion: it.descripcion,
    unidad: it.unidad,
    cantidad: String(it.cantidad),
    atendida: it.cantidadAtendida,
  }
}

/** Resumen legible de los cambios (para la confirmación antes de guardar). */
function resumenDeCambios(
  enc: EncabezadoEditarRq,
  rq: RqAtencion,
  filas: FilaEdicion[],
  items: RqItem[]
): { encabezado: string[]; editados: string[]; agregados: string[]; quitados: string[] } {
  const encabezado: string[] = []
  const actual = rq as unknown as Record<string, string>
  for (const [campo, etiqueta] of Object.entries(ETIQUETAS)) {
    if (enc[campo as keyof EncabezadoEditarRq] === undefined) continue
    const nuevo = String(enc[campo as keyof EncabezadoEditarRq] ?? '')
    if (nuevo !== (actual[campo] ?? '')) {
      encabezado.push(
        `${etiqueta}: ${actual[campo] || '—'} → ${nuevo || '—'}`
      )
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
    if (f.unidad.trim() !== previo.unidad) cambiosFila.push(`unidad ${previo.unidad || '—'} → ${f.unidad.trim() || '—'}`)
    if (cantidad !== previo.cantidad) cambiosFila.push(`cantidad ${previo.cantidad} → ${cantidad}`)
    if (cambiosFila.length > 0) editados.push(`${codigo}: ${cambiosFila.join(', ')}`)
  }
  const quitados = items
    .filter((a) => !idsEditados.has(a.id))
    .map((a) => `${a.codigo} · ${a.cantidad} ${a.unidad}`)
  return { encabezado, editados, agregados, quitados }
}

export function RqEditarDialog({
  open,
  onOpenChange,
  rq,
  items,
  onGuardada,
  onSincronizada,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  rq: RqAtencion
  items: RqItem[]
  onGuardada: (r: ResultadoEdicionRq) => void
  /** Task 27: tras revertir dentro del editor, sincroniza rq+items con el padre. */
  onSincronizada?: (rq: RqAtencion, items: RqItem[]) => void
}) {
  const { perfil } = useAuth()

  // ── Encabezado ──
  const [numeroRq, setNumeroRq] = useState('')
  const [ordenProduccion, setOrdenProduccion] = useState('')
  const [productoCodigo, setProductoCodigo] = useState('')
  const [productoDescripcion, setProductoDescripcion] = useState('')
  const [fecha, setFecha] = useState('')
  const [turno, setTurno] = useState('T1')
  // Task 35: turno de la HOJA física (004=T1 · 005=T2). Históricos sin
  // dato arrancan con el turno del sistema (fallback COALESCE del filtro).
  const [turnoRq, setTurnoRq] = useState('T1')
  const [linea, setLinea] = useState('')
  const [solicitante, setSolicitante] = useState('')
  const [notas, setNotas] = useState('')

  // ── Materiales ──
  const [filas, setFilas] = useState<FilaEdicion[]>([])
  const [errores, setErrores] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmar, setConfirmar] = useState(false)

  // ── Reversa guiada de material ATENDIDO (Task 27: «editar los atendidos») ──
  const [revertirFila, setRevertirFila] = useState<FilaEdicion | null>(null)
  const [lotesDeFila, setLotesDeFila] = useState<LotePuenteDeItem[] | null>(null)
  const [revirtiendo, setRevirtiendo] = useState(false)

  /** Catálogo cargado una vez (autocompletado de códigos). */
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  /** Fila cuyo código está tipeando (para mostrar sugerencias). */
  const [sugerenciaKey, setSugerenciaKey] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Carga inicial cada vez que se abre (estado fresco, nunca arrastrado)
  useEffect(() => {
    if (!open) return
    setNumeroRq(rq.numeroRq)
    setOrdenProduccion(rq.ordenProduccion)
    setProductoCodigo(rq.productoCodigo)
    setProductoDescripcion(rq.productoDescripcion)
    setFecha(rq.fecha)
    setTurno(rq.turno || 'T1')
    setTurnoRq(rq.turnoRq || rq.turno || 'T1')
    setLinea(rq.linea)
    setSolicitante(rq.solicitante)
    setNotas(rq.notas)
    setFilas(items.length > 0 ? items.map(filaDeItem) : [filaVacia()])
    setErrores([])
    setConfirmar(false)
    setSugerenciaKey('')
    const cache = getCachedCatalogo()
    if (cache.length > 0) setCatalogo(cache)
    else void fetchCatalogo().then(setCatalogo).catch(() => setCatalogo([]))
  }, [open, rq, items])

  /** Cierra sugerencias al hacer clic fuera. */
  useEffect(() => {
    if (!sugerenciaKey) return
    const cerrar = () => setSugerenciaKey('')
    document.addEventListener('click', cerrar)
    return () => document.removeEventListener('click', cerrar)
  }, [sugerenciaKey])

  const erroresVivos = useMemo(
    () => validarEdicionRq(filasAItems(filas), items),
    [filas, items]
  )

  const resumen = useMemo(() => {
    const enc = encabezadoDesdeEstado({
      numeroRq, ordenProduccion, productoCodigo, productoDescripcion,
      fecha, turno, turnoRq, linea, solicitante, notas,
    })
    return resumenDeCambios(enc, rq, filas, items)
  }, [rq, items, filas, numeroRq, ordenProduccion, productoCodigo, productoDescripcion, fecha, turno, turnoRq, linea, solicitante, notas])

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

  /** Abre la reversa guiada de un material con atención (primero revertir,
   *  luego el código/unidad/cantidad quedan editables). */
  async function abrirReversionFila(f: FilaEdicion) {
    setRevertirFila(f)
    setLotesDeFila(null)
    try {
      const lotes = await listarLotesPuenteDeItem(f.id, f.codigo)
      setLotesDeFila(lotes)
    } catch {
      setLotesDeFila([])
    }
  }

  /** Revierte TODA la atención de la fila (con origen si tiene lotes del
   *  puente: devuelve guías/posiciones) y refresca el editor. */
  async function ejecutarReversionFila() {
    const f = revertirFila
    if (!f || !f.id) return
    setRevirtiendo(true)
    try {
      if (lotesDeFila && lotesDeFila.length > 0) {
        const r = await revertirOrigenRq(f.id, null, calcularTurno(), {
          id: perfil?.id ?? '',
          nombre: perfil?.nombre || perfil?.correo || '',
          correo: perfil?.correo ?? '',
        })
        if (!r.ok) throw new Error(r.fallo?.mensaje ?? 'No se pudo revertir con origen')
      } else {
        await revertirItemRq(f.id, f.atendida)
      }
      const completa = await obtenerRqCompleta(rq.id)
      setFilas(completa.items.length > 0 ? completa.items.map(filaDeItem) : [filaVacia()])
      setRevertirFila(null)
      onSincronizada?.(completa.rq, completa.items)
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

  /** Adopta código del catálogo: completa descripción/unidad si están vacíos. */
  function adoptarCatalogo(key: string, c: CatalogoItem) {
    editarFila(key, {
      codigo: c.codigo,
      descripcion: c.descripcion,
      unidad: c.un,
    })
    setSugerenciaKey('')
  }

  async function guardar() {
    // Revalida en el guardado (el usuario pudo editar mientras confirmaba)
    const vivos = validarEdicionRq(filasAItems(filas), items)
    if (vivos.length > 0) {
      setErrores(vivos)
      setConfirmar(false)
      return
    }
    // DB1 (auditoría 2026-10-30): si el Nº de RQ CAMBIÓ, advertir si ya existe
    // otra RQ con ese número (misma política que el alta: aviso, no bloqueo).
    if (numeroRq.trim() && numeroRq.trim() !== rq.numeroRq.trim()) {
      try {
        const existentes = await buscarRqPorNumero(numeroRq, rq.id)
        if (existentes.length > 0) {
          const e0 = existentes[0]
          const ok = window.confirm(
            `Ya existe ${existentes.length > 1 ? `${existentes.length} RQ` : 'UNA RQ'} con el número ${numeroRq.trim()}` +
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
        numeroRq, ordenProduccion, productoCodigo, productoDescripcion,
        fecha, turno, turnoRq, linea, solicitante, notas,
      })
      const resultado = await editarRq(
        rq.id,
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
        toast.success(`RQ actualizada (${resultado.cambios} cambio${resultado.cambios === 1 ? '' : 's'})`, {
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
              Editar RQ {rq.numeroRq || 'sin número'}
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
                <Campo etiqueta="Nº RQ">
                  <Input className="h-9" value={numeroRq} onChange={(e) => setNumeroRq(e.target.value)} inputMode="numeric" />
                </Campo>
                <Campo etiqueta="Orden de producción">
                  <Input className="h-9" value={ordenProduccion} onChange={(e) => setOrdenProduccion(e.target.value)} />
                </Campo>
                <Campo etiqueta="Cód. producto">
                  <Input className="h-9 font-mono" value={productoCodigo} onChange={(e) => setProductoCodigo(e.target.value)} />
                </Campo>
                <Campo etiqueta="Producto">
                  <Input className="h-9" value={productoDescripcion} onChange={(e) => setProductoDescripcion(e.target.value)} />
                </Campo>
                <Campo etiqueta="Fecha">
                  <Input type="date" className="h-9" value={fecha} onChange={(e) => setFecha(e.target.value)} />
                </Campo>
                <Campo etiqueta="Turno">
                  <select
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none"
                    value={turno}
                    onChange={(e) => setTurno(e.target.value)}
                  >
                    <option value="T1">T1</option>
                    <option value="T2">T2</option>
                  </select>
                </Campo>
                {/* Task 35: turno de la hoja física (004=T1 · 005=T2). */}
                <Campo etiqueta="Turno del RQ (hoja)">
                  <select
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none"
                    value={turnoRq}
                    onChange={(e) => setTurnoRq(e.target.value)}
                    title="Turno impreso en la hoja: 004 = turno 1 · 005 = turno 2"
                  >
                    <option value="T1">T1 (hoja 004)</option>
                    <option value="T2">T2 (hoja 005)</option>
                  </select>
                </Campo>
                <Campo etiqueta="Línea">
                  <Input className="h-9" value={linea} onChange={(e) => setLinea(e.target.value)} placeholder="Ej. 6 LÍNEA 15" />
                </Campo>
                <Campo etiqueta="Solicitante">
                  <Input className="h-9" value={solicitante} onChange={(e) => setSolicitante(e.target.value)} />
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
                          onChange={(e) => {
                            editarFila(f.key, { codigo: e.target.value.toUpperCase() })
                            setSugerenciaKey(f.key)
                          }}
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
                        onChange={(e) => editarFila(f.key, { descripcion: e.target.value })}
                      />
                      {/* Unidad */}
                      <Input
                        className="h-8 text-xs w-16 shrink-0"
                        placeholder="Un"
                        value={f.unidad}
                        onChange={(e) => editarFila(f.key, { unidad: e.target.value })}
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
                            : 'Quitar de la RQ'
                        }
                        onClick={() => quitarFila(f.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      {/* Task 27: revertir la atención de este material AQUÍ (guiado) */}
                      {f.id && f.atendida > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                          disabled={revirtiendo}
                          title="Revertir su atención para poder corregirlo"
                          onClick={() => void abrirReversionFila(f)}
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
                          onClick={() => void abrirReversionFila(f)}
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
              className="gap-1.5 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
              disabled={saving || !hayCambios || erroresVivos.length > 0}
              onClick={() => {
                const vivos = validarEdicionRq(filasAItems(filas), items)
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
              className="bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white"
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Sí, guardar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* ── Confirmación de la reversa guiada (Task 27) ── */}
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
                {lotesDeFila === null ? (
                  <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" /> Revisando atenciones con origen…
                  </p>
                ) : lotesDeFila.length > 0 ? (
                  <p className="text-[11px] text-slate-600 rounded-lg border border-teal-100 bg-teal-50/60 p-2">
                    Este material tiene <b>{lotesDeFila.length}</b> atención(es) del puente (QR/Tránsito) — la reversa
                    devolverá las guías/posiciones a su origen (compensación física completa).
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-500">
                    La reversa solo ajusta cantidades de la RQ; no toca el stock físico (no hubo puente de escaneo).
                  </p>
                )}
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
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  fecha: string
  turno: string
  turnoRq: string
  linea: string
  solicitante: string
  notas: string
}): EncabezadoEditarRq {
  // Siempre presentes: la RPC compara con lo guardado y solo aplica lo cambiado.
  return {
    numeroRq: s.numeroRq,
    ordenProduccion: s.ordenProduccion,
    productoCodigo: s.productoCodigo,
    productoDescripcion: s.productoDescripcion,
    fecha: s.fecha,
    turno: s.turno,
    turnoRq: s.turnoRq,
    linea: s.linea,
    solicitante: s.solicitante,
    notas: s.notas,
  }
}

function filasAItems(filas: FilaEdicion[]): ItemEditarRq[] {
  return filas.map((f, i) => ({
    ...(f.id ? { id: f.id } : {}),
    orden: i,
    codigo: f.codigo.trim().toUpperCase(),
    descripcion: f.descripcion,
    unidad: f.unidad,
    // FIX auditoría Task 20: aNumero — "1,5" se lee como 1,5 (no 15 ni 1).
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
          className="w-full text-left px-2.5 py-1.5 hover:bg-teal-50 flex items-baseline gap-2"
          onClick={() => onElegir(c)}
        >
          <span className="font-mono text-[11px] font-bold text-indigo-700 shrink-0">{c.codigo}</span>
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
