'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Recepción (DOCUMENTO de guía, sin
 * destino).
 *
 * MODELO (2026-11-11, paridad Almacén Insumos): el ingreso viaja bajo una
 * GUÍA con N° de Guía, N° de OC, N° de DAM y Proveedor. Si toda la guía es
 * de UN proveedor, este se repite en cada artículo (modo único); si trae
 * VARIOS, cada artículo lleva el suyo (modo múltiple). Cada artículo =
 * código + cantidad; la DESCRIPCIÓN y la UM se JALAN del catálogo
 * rep_articulos al digitar/escanear el código (como la ficha de referencia
 * del usuario: «Se autocompleta al escribir el código»).
 *
 * SIN DESTINO (cambio de flujo): aquí NO se elige dónde se almacena. Al
 * guardar, el documento completo viaja en 1 RPC atómica e IDEMPOTENTE
 * (rep_registrar_recepcion) a rep_recepciones/rep_recepcion_lineas con
 * estado «en tránsito» — y es el módulo TRÁNSITO el que lista lo recibido
 * y decide a qué lonchera va cada artículo (rep_ubicar_desde_transito:
 * ahí se escribe stock + kardex). El rótulo tampoco lleva ubicación.
 *
 * RÓTULOS: al guardar se abre «Imprimir rótulos» (Zebra directa o archivo
 * .zpl) — 1 rótulo por artículo con el CÓDIGO EN GRANDE (banda superior
 * del ZPL) y QR único con el uuid de SU línea de recepción.
 *
 * REIMPRESIÓN: «Últimas recepciones» lista los documentos (guía, OC, DAM,
 * estado) y regenera sus rótulos desde la BD (repLineasPorGuia; fallback a
 * rep_movimientos para guías del flujo anterior con destino directo).
 *
 * Avisos honestos:
 *   · «Ya está en…» — stock EXISTENTE del artículo (información, no destino).
 *   · Código desconocido → alta rápida IN-LINE (si el usuario puede
 *     gestionar el catálogo) o puente al módulo Catálogo.
 *
 * Lección de la auditoría 2026-11-10 aplicada: el formulario se limpia
 * ANTES del refresco del contexto — un fallo de red en el refresco no
 * sugiere que el guardado falló ni provoca un segundo clic que duplique
 * (y el uuid_sync del lote hace que el reintento sea idempotente en BD).
 *
 * Puentes (contrato rep-navegacion):
 *   · onIrACatalogo  → Catálogo (alta manual completa).
 *   · onIrATransito  → Tránsito (ubicar lo recibido).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import { formatDateTime } from '@/lib/utils'
import {
  repArticuloPorCodigo,
  repRegistrarRecepcion,
  repEditarRecepcion,
  repEliminarRecepcion,
  repRecepcionCompleta,
  repStockDeArticulo,
  repListarRecepciones,
  repLineasPorGuia,
  repListarMovimientos,
  repCrearArticulo,
  repNormalizarCodigo,
  type RepArticulo,
  type RepRecepcion,
} from '@/lib/rackly/rep/rep-client'
import {
  validarRecepcionRep,
  proveedorDeLinea,
  parsearCantidadLinea,
  lineasARotulosRep,
  movimientosARotulosRep,
  type CabeceraRecepcionRep,
  type LineaRecepcionRep,
} from '@/lib/rackly/rep/recepcion-guia'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'
import type { RotuloAImprimir } from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import { ImprimirRotulosDialog } from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
import {
  PackageCheck,
  Search,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  BookOpen,
  Plus,
  Printer,
  PencilLine,
  Trash2,
  X,
  FileText,
  Truck,
} from 'lucide-react'

type Props = {
  /** Puente: abrir Catálogo (alta manual completa). */
  onIrACatalogo?: () => void
  /** Puente: ir a Tránsito a ubicar lo recibido. */
  onIrATransito?: () => void
}

/** Estado del modal de rótulos (guardado o reimpresión). */
type ModalRotulos = {
  rotulos: RotuloAImprimir[]
  encabezado: EncabezadoRotulo
  nota: string
} | null

/** uuid v4 local (clave de línea / uuid_sync del lote; fallback sin crypto). */
function uuidLocal(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `l-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function RecepcionModule({ onIrACatalogo, onIrATransito }: Props) {
  const { perfil } = useAuth()
  const puedeGestionar = puede(perfil, 'repuestos.gestionar')
  const puedeEliminarRep = puede(perfil, 'repuestos.eliminar')

  // ── Panel lateral ──
  const [recepciones, setRecepciones] = useState<RepRecepcion[]>([])

  // ── Cabecera de la guía ──
  const [guia, setGuia] = useState('')
  const [oc, setOc] = useState('')
  const [dam, setDam] = useState('')
  const [multiProveedor, setMultiProveedor] = useState(false)
  const [proveedorGeneral, setProveedorGeneral] = useState('')

  // ── Constructor de línea (ficha del artículo, como la imagen de referencia) ──
  const [codigo, setCodigo] = useState('')
  const [articulo, setArticulo] = useState<RepArticulo | null>(null)
  const [stockActual, setStockActual] = useState<Awaited<ReturnType<typeof repStockDeArticulo>>>([])
  const [cantidad, setCantidad] = useState('')
  const [proveedorLinea, setProveedorLinea] = useState('')

  // ── Líneas de la guía ──
  const [lineas, setLineas] = useState<LineaRecepcionRep[]>([])

  const [buscando, setBuscando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [altaOpen, setAltaOpen] = useState(false)
  const [modal, setModal] = useState<ModalRotulos>(null)
  const [imprimiendo, setImprimiendo] = useState('')
  // ── EDICIÓN / ELIMINACIÓN de guías guardadas (supervisión): el cuadro de
  //    permisos da EDITAR con repuestos.gestionar y BORRAR con
  //    repuestos.eliminar — por defecto supervisores, coordinadores y admin.
  const [editando, setEditando] = useState<{ recepcionId: string; guia: string } | null>(null)
  const [cargandoEdicion, setCargandoEdicion] = useState('')
  const [eliminando, setEliminando] = useState<RepRecepcion | null>(null)
  const [borrando, setBorrando] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)
  const codigoRef = useRef<HTMLInputElement>(null)
  // Guard de generación: solo la búsqueda más reciente puede pintar resultados
  // (evita que la respuesta tardía de un código anterior sobrescriba al nuevo).
  const busquedaGenRef = useRef(0)
  // uuid_sync del lote: ESTABLE entre reintentos del mismo formulario — la BD
  // hace el guardado idempotente (reintento de red ≠ filas duplicadas).
  const loteRef = useRef<string | null>(null)

  const cabecera: CabeceraRecepcionRep = { guia, oc, dam, multiProveedor, proveedorGeneral }

  const cargarContexto = useCallback(async () => {
    try {
      const recs = await repListarRecepciones(8)
      setRecepciones(recs)
    } catch (err: unknown) {
      toast.error('Error al cargar recepciones', { description: mensajeError(err) })
    }
  }, [])

  useEffect(() => {
    cargarContexto()
  }, [cargarContexto])

  async function buscarArticulo(codigoInput?: string) {
    const c = repNormalizarCodigo(codigoInput ?? codigo)
    if (!c) return
    const gen = ++busquedaGenRef.current
    setBuscando(true)
    setArticulo(null)
    setStockActual([])
    try {
      const a = await repArticuloPorCodigo(c)
      if (gen !== busquedaGenRef.current) return // llegó tarde: el usuario ya buscó otro código
      if (a) {
        setArticulo(a)
        const st = await repStockDeArticulo(a.id)
        if (gen !== busquedaGenRef.current) return
        setStockActual(st)
        codigoRef.current?.focus()
      } else {
        toast.warning(`El código ${c} no existe en el catálogo`, {
          description: puedeGestionar
            ? 'Puedes crearlo aquí mismo con «Alta rápida».'
            : 'Pide a un supervisor que lo agregue en el módulo Catálogo.',
          duration: 8000,
        })
        if (puedeGestionar) setAltaOpen(true)
      }
    } catch (err: unknown) {
      toast.error('Error al buscar el artículo', { description: mensajeError(err) })
    } finally {
      if (gen === busquedaGenRef.current) setBuscando(false)
    }
  }

  /** Agrega el artículo buscado como línea de la guía (valida en el momento). */
  function agregarLinea() {
    if (!articulo) return
    const cant = parsearCantidadLinea(cantidad)
    if (cant === null) {
      toast.error('La cantidad debe ser mayor que cero')
      return
    }
    if (multiProveedor && !proveedorLinea.trim()) {
      toast.error('Ingresa el proveedor de este artículo')
      return
    }
    setLineas((prev) => [
      ...prev,
      {
        key: claveLinea(),
        articuloId: articulo.id,
        codigo: articulo.codigo,
        descripcion: articulo.descripcion,
        und: articulo.und,
        cantidad: cant,
        proveedor: multiProveedor ? proveedorLinea.trim() : '',
      },
    ])
    // La línea quedó lista: limpiar SOLO artículo/cantidad/proveedor de línea.
    setCodigo('')
    setCantidad('')
    setProveedorLinea('')
    setArticulo(null)
    setStockActual([])
    codigoRef.current?.focus()
  }

  function quitarLinea(key: string) {
    setLineas((prev) => prev.filter((l) => l.key !== key))
  }

  function limpiarCabecera() {
    setGuia('')
    setOc('')
    setDam('')
    setMultiProveedor(false)
    setProveedorGeneral('')
  }

  /** Guarda el DOCUMENTO completo (1 RPC atómica, idempotente por uuid_sync). */
  async function guardar() {
    const errores = validarRecepcionRep(cabecera, lineas)
    const total = errores.cabecera.length + errores.lineas.size
    if (total > 0) {
      toast.error(`Faltan datos de la guía (${total})`, {
        description: [...errores.cabecera, ...[...errores.lineas.values()]].slice(0, 4).join(' · '),
        duration: 10000,
      })
      return
    }
    setGuardando(true)
    const guiaGuardada = cabecera.guia.trim()
    const edicion = editando
    try {
      if (edicion) {
        // ── EDICIÓN: 1 RPC atómica que sincroniza por id (UPDATE conserva
        //    el uuid del rótulo; INSERT para nuevas; DELETE para las que
        //    quedaron fuera). La BD rechaza si algo ya está ubicado.
        const res = await repEditarRecepcion({
          recepcionId: edicion.recepcionId,
          guia: guiaGuardada,
          oc: cabecera.oc.trim(),
          dam: cabecera.dam.trim(),
          lineas: lineas.map((l) => ({
            id: l.id ?? null,
            articuloId: l.articuloId,
            cantidad: l.cantidad,
            proveedor: proveedorDeLinea(cabecera, l),
          })),
        })

        const lineasOk = [...lineas]
        // Limpieza ANTES del refresco (misma lección del alta): el formulario
        // sale del modo edición aunque el refresco falle.
        setLineas([])
        limpiarCabecera()
        setEditando(null)

        toast.success(`Guía ${guiaGuardada} actualizada (${lineasOk.length} artículo(s))`, {
          description: 'Los cambios reemplazaron el documento.',
          duration: 9000,
        })
        setModal({
          rotulos: lineasARotulosRep(lineasOk, res.lineaIds, guiaGuardada),
          encabezado: {
            fecha: formatDateTime(new Date().toISOString()),
            numeroDocumento: guiaGuardada,
            empresaOrigen: etiquetaProveedores(lineasOk.map((l) => proveedorDeLinea(cabecera, l))),
            placa: '',
            registradoPor: perfil?.nombre ?? undefined,
            tipoDocumento: 'Guía',
          },
          nota: `Edición guardada — ${lineasOk.length} artículo(s) de la guía ${guiaGuardada}. Las líneas conservadas mantienen su QR; las nuevas llevan rótulo nuevo.`,
        })
      } else {
        if (!loteRef.current) loteRef.current = uuidLocal()
        const res = await repRegistrarRecepcion({
          guia: guiaGuardada,
          oc: cabecera.oc.trim(),
          dam: cabecera.dam.trim(),
          lineas: lineas.map((l) => ({
            articuloId: l.articuloId,
            cantidad: l.cantidad,
            proveedor: proveedorDeLinea(cabecera, l),
          })),
          uuidSync: loteRef.current,
        })

        const lineasOk = [...lineas]
        // Limpieza ANTES del refresco (lección auditoría 2026-11-10): las líneas
        // salen de la lista aunque el refresco falle — y el lote liberado hace
        // que un siguiente guardado sea un documento NUEVO, no un eco.
        setLineas([])
        limpiarCabecera()
        loteRef.current = null

        if (res.duplicado) {
          toast.info('La recepción ya estaba guardada', {
            description: 'Un reintento anterior llegó a la base de datos — no se duplicó nada.',
          })
        } else {
          toast.success(`Guía ${guiaGuardada}: ${lineasOk.length} artículo(s) en tránsito`, {
            description: 'Asígnalos a su lonchera desde el módulo TRÁNSITO.',
            duration: 9000,
          })
        }
        setModal({
          rotulos: lineasARotulosRep(lineasOk, res.lineaIds, guiaGuardada),
          encabezado: {
            fecha: formatDateTime(new Date().toISOString()),
            numeroDocumento: guiaGuardada,
            empresaOrigen: etiquetaProveedores(lineasOk.map((l) => proveedorDeLinea(cabecera, l))),
            placa: '',
            registradoPor: perfil?.nombre ?? undefined,
            tipoDocumento: 'Guía',
          },
          nota: `Recepción guardada — ${lineasOk.length} artículo(s) de la guía ${guiaGuardada} en tránsito. Descarga el archivo .zpl o imprime directo.`,
        })
      }

      // Refresco best-effort con aviso propio (nunca enmascara el guardado).
      try {
        await cargarContexto()
      } catch (errRefresco: unknown) {
        toast.info('Guardado, pero no se pudo refrescar el panel', { description: mensajeError(errRefresco) })
      }
    } catch (err: unknown) {
      // Las líneas quedan en la lista: corregir y reintentar es un clic.
      toast.error('No se pudo guardar la recepción', { description: mensajeError(err) })
    } finally {
      setGuardando(false)
    }
  }

  /** Reimpresión: rótulos de una guía YA guardada, releídos de la BD. */
  async function reimprimirGuia(numGuia: string) {
    setImprimiendo(numGuia)
    try {
      // Fuente principal: el DOCUMENTO de recepción (rótulos aunque la línea
      // aún no esté ubicada). Fallback honesto: guías del flujo anterior
      // (destino directo) solo existen en rep_movimientos.
      let filas = await repLineasPorGuia(numGuia)
      if (filas.length === 0) {
        const movs = await repListarMovimientos({ tipo: 'ingreso', guia: numGuia, pageSize: 200 })
        filas = movs.filas.map((m) => ({
          id: m.id,
          created_at: m.created_at,
          codigo: m.codigo,
          descripcion: m.descripcion,
          und: m.und,
          cantidad: Number(m.cantidad),
          guia: m.guia,
        }))
      }
      if (filas.length === 0) {
        toast.warning(`La guía ${numGuia} ya no tiene artículos registrados`)
        return
      }
      setModal({
        rotulos: movimientosARotulosRep(filas),
        encabezado: {
          fecha: formatDateTime(filas[0].created_at ?? new Date().toISOString()),
          numeroDocumento: numGuia,
          empresaOrigen: etiquetaProveedores(filas.map((f) => '')),
          placa: '',
          registradoPor: perfil?.nombre ?? undefined,
          tipoDocumento: 'Guía',
        },
        nota: `Reimpresión — ${filas.length} artículo(s) de la guía ${numGuia} (leídos de la base de datos).`,
      })
    } catch (err: unknown) {
      toast.error('No se pudo releer la guía', { description: mensajeError(err) })
    } finally {
      setImprimiendo('')
    }
  }

  /**
   * EDICIÓN (supervisión): trae el documento completo al formulario —
   * cabecera + líneas conservando el id BD de cada línea (identidad del
   * rótulo QR). Guardar llama a rep_editar_recepcion (UPDATE por id / INSERT
   * de nuevas / DELETE de las que faltan) — paridad Insumos «Revisar/editar».
   */
  async function abrirEdicion(r: RepRecepcion) {
    if (cargandoEdicion) return
    setCargandoEdicion(r.id)
    try {
      const doc = await repRecepcionCompleta(r.id)
      // Proveedores de las líneas → modo único (todos iguales) o múltiple.
      const provs = [...new Set(doc.lineas.map((l) => l.proveedor.trim()).filter(Boolean))]
      const multi = provs.length > 1
      setEditando({ recepcionId: doc.id, guia: doc.guia })
      setGuia(doc.guia)
      setOc(doc.oc)
      setDam(doc.dam)
      setMultiProveedor(multi)
      setProveedorGeneral(provs[0] ?? '')
      setLineas(
        doc.lineas.map((l) => ({
          key: claveLinea(),
          id: l.id,
          articuloId: l.articulo_id,
          codigo: l.codigo,
          descripcion: l.descripcion,
          und: l.und,
          cantidad: Number(l.cantidad) || 0,
          proveedor: multi ? l.proveedor : '',
        }))
      )
      // El borrador de ALTA pendiente se descarta (sus líneas fueron
      // reemplazadas por las de la guía editada).
      loteRef.current = null
      toast.info(`Editando la guía ${doc.guia}`, {
        description:
          'Corrige guía/OC/DAM, códigos, cantidades o proveedores y pulsa «Guardar cambios».',
        duration: 8000,
      })
      setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    } catch (err: unknown) {
      toast.error('No se pudo abrir la guía para editar', { description: mensajeError(err) })
    } finally {
      setCargandoEdicion('')
    }
  }

  /** Sale del modo edición y deja el formulario limpio (sin tocar la BD). */
  function cancelarEdicion() {
    setEditando(null)
    setLineas([])
    limpiarCabecera()
    setCodigo('')
    setCantidad('')
    setProveedorLinea('')
    setArticulo(null)
    setStockActual([])
    loteRef.current = null
  }

  /** Elimina la guía confirmada (RPC rep_eliminar_recepcion: solo si nada
   *  está ubicado — la BD rechaza y el mensaje real sube en el toast). */
  async function confirmarEliminar() {
    const target = eliminando
    if (!target) return
    setBorrando(true)
    try {
      const res = await repEliminarRecepcion(target.id)
      toast.success(`Guía ${target.guia} eliminada`, {
        description: `${res.lineasEliminadas} artículo(s) en tránsito borrados del documento.`,
      })
      setEliminando(null)
      // Si la guía eliminada estaba abierta en edición: salir limpio.
      if (editando?.recepcionId === target.id) cancelarEdicion()
      await cargarContexto()
    } catch (err: unknown) {
      toast.error('No se pudo eliminar la guía', { description: mensajeError(err) })
    } finally {
      setBorrando(false)
    }
  }

  /** Proveedores únicos de un conjunto de valores (etiqueta compacta). */
  function etiquetaProveedores(vals: string[]): string {
    const unicos = [...new Set(vals.map((v) => v.trim()).filter(Boolean))]
    if (unicos.length === 0) return ''
    return unicos.length === 1 ? unicos[0] : `${unicos.length} proveedores`
  }

  const puedeGuardar = lineas.length > 0 && !guardando
  const pendientesTotal = recepciones.reduce((s, r) => s + r.pendientes, 0)

  return (
    <div className="space-y-4">
      {/* ═══ AVISO DE EDICIÓN (supervisión) ═══ */}
      {editando && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-2.5">
          <p className="text-xs text-sky-900">
            <b>Editando la guía {editando.guia}</b> — al guardar, los cambios reemplazan el
            documento: las líneas conservadas mantienen su QR y las nuevas imprimen rótulo nuevo.
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

      {/* ═══ 1 · DATOS DE LA GUÍA ═══ */}
      <div ref={formRef} className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-400" />
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">1 · Datos de la guía</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="guia-num" className="text-xs">N° de Guía *</Label>
            <Input id="guia-num" className="font-mono uppercase" placeholder="Guía de remisión" value={guia} onChange={(e) => setGuia(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="guia-oc" className="text-xs">N° de OC *</Label>
            <Input id="guia-oc" className="font-mono uppercase" placeholder="Orden de compra" value={oc} onChange={(e) => setOc(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="guia-dam" className="text-xs">N° de DAM *</Label>
            <Input id="guia-dam" className="font-mono uppercase" placeholder="Declaración de mercancías" value={dam} onChange={(e) => setDam(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <Switch id="multi-prov" checked={multiProveedor} onCheckedChange={setMultiProveedor} />
            <Label htmlFor="multi-prov" className="text-xs cursor-pointer">
              Varios proveedores en esta guía
            </Label>
          </div>
          <div className="flex-1 min-w-[200px]">
            {multiProveedor ? (
              <p className="text-[11px] text-slate-500">Cada artículo llevará <b>su propio proveedor</b> (campo en el paso 2).</p>
            ) : (
              <Input
                placeholder="Proveedor único de la guía *"
                value={proveedorGeneral}
                onChange={(e) => setProveedorGeneral(e.target.value)}
                className="h-8 text-xs"
              />
            )}
          </div>
        </div>
      </div>

      {/* ═══ 2 · AGREGAR ARTÍCULO (ficha como la imagen de referencia) ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-4">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
          2 · Agregar artículo <span className="text-slate-300">· #{lineas.length + 1}</span>
          {multiProveedor && ' (con su proveedor)'}
        </p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {/* Código del artículo */}
          <div className="grid gap-1">
            <Label htmlFor="art-codigo" className="text-xs font-semibold text-slate-600">Código del artículo</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  id="art-codigo"
                  ref={codigoRef}
                  className="pl-9 font-mono uppercase text-base font-bold"
                  placeholder="Ej: 5653"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') buscarArticulo() }}
                />
              </div>
              <Button onClick={() => buscarArticulo()} disabled={buscando || !codigo.trim()} className="gap-2">
                {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="hidden sm:inline">Buscar</span>
              </Button>
            </div>
          </div>

          {/* Descripción (se autocompleta) */}
          <div className="grid gap-1">
            <Label htmlFor="art-desc" className="text-xs font-semibold text-slate-600">Descripción</Label>
            <div
              className={`flex min-h-[2.4rem] items-center rounded-md border px-3 text-sm ${
                articulo ? 'border-emerald-200 bg-emerald-50/60 text-slate-700' : 'border-dashed border-slate-200 bg-slate-50/50 text-slate-400'
              }`}
            >
              {articulo ? (
                <span className="truncate" title={articulo.descripcion}>{articulo.descripcion}</span>
              ) : (
                <span className="text-xs">Se autocompleta al escribir el código</span>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1">
            <Label htmlFor="art-cant" className="text-xs font-semibold text-slate-600">Cantidad</Label>
            <Input
              id="art-cant"
              inputMode="decimal"
              placeholder="0"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') agregarLinea() }}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs font-semibold text-slate-600">Unidad</Label>
            <div className="flex h-9 items-center rounded-md border border-dashed border-slate-200 bg-slate-50/50 px-3">
              {articulo?.und ? (
                <span className="font-mono text-sm font-bold text-slate-700">{articulo.und}</span>
              ) : (
                <span className="text-xs text-slate-400">Se jala del catálogo</span>
              )}
            </div>
          </div>
          {multiProveedor && (
            <div className="grid gap-1 sm:col-span-2">
              <Label htmlFor="art-prov" className="text-xs font-semibold text-slate-600">Proveedor de este artículo *</Label>
              <Input
                id="art-prov"
                placeholder="Proveedor del artículo"
                value={proveedorLinea}
                onChange={(e) => setProveedorLinea(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') agregarLinea() }}
              />
            </div>
          )}
          <div className={`grid gap-1 ${multiProveedor ? 'sm:col-span-4' : 'sm:col-span-2'}`}>
            <Button onClick={agregarLinea} disabled={!articulo} className="gap-2 w-full sm:w-auto sm:justify-self-end self-end">
              <Plus className="h-4 w-4" /> Agregar a la guía
            </Button>
          </div>
        </div>

        {articulo && stockActual.length > 0 && (
          <p className="text-xs text-slate-500 rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-1.5">
            <strong>Ya está en</strong> (stock existente, no destino):{' '}
            {stockActual
              .map((s) => `${s.ubicacionCodigo} lado ${s.lado} (${s.cantidad.toLocaleString('es-PE')})`)
              .join(' · ')}
          </p>
        )}
        {multiProveedor && (
          <p className="text-[11px] text-slate-400">
            El proveedor de la guía se repite en cada artículo; con «Varios proveedores» activado, cada artículo lleva el suyo.
          </p>
        )}
      </div>

      {/* ═══ 3 · ARTÍCULOS DE LA GUÍA + GUARDAR ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
          3 · Artículos de la guía ({lineas.length})
        </p>

        {lineas.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">
            Aún no hay artículos. Escribe el código del primero — la descripción y la UM se jalan solas del catálogo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-2.5 py-2 font-semibold w-8">#</th>
                  <th className="px-2.5 py-2 font-semibold">Código</th>
                  <th className="px-2.5 py-2 font-semibold">Descripción</th>
                  <th className="px-2.5 py-2 font-semibold">UM</th>
                  <th className="px-2.5 py-2 font-semibold text-right">Cantidad</th>
                  {(multiProveedor || lineas.some((l) => l.proveedor)) && <th className="px-2.5 py-2 font-semibold">Proveedor</th>}
                  <th className="px-2.5 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lineas.map((l, i) => (
                  <tr key={l.key} className="hover:bg-slate-50/60">
                    <td className="px-2.5 py-1.5 text-slate-400">{i + 1}</td>
                    <td className="px-2.5 py-1.5 font-mono font-bold text-slate-800">{l.codigo}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 max-w-[260px] truncate" title={l.descripcion}>{l.descripcion}</td>
                    <td className="px-2.5 py-1.5 text-slate-500">{l.und || '—'}</td>
                    <td className="px-2.5 py-1.5 text-right font-bold text-slate-900">{l.cantidad.toLocaleString('es-PE')}</td>
                    {(multiProveedor || lineas.some((l2) => l2.proveedor)) && (
                      <td className="px-2.5 py-1.5 text-slate-600 max-w-[140px] truncate" title={l.proveedor}>{l.proveedor || '—'}</td>
                    )}
                    <td className="px-2.5 py-1.5">
                      <button
                        onClick={() => quitarLinea(l.key)}
                        disabled={guardando}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                        title="Quitar de la guía"
                        aria-label={`Quitar ${l.codigo}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 justify-end">
          {!articulo && !codigo && puedeGestionar && (
            <Button variant="outline" onClick={() => setAltaOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" /> Alta rápida
            </Button>
          )}
          {!articulo && !codigo && onIrACatalogo && (
            <Button variant="ghost" onClick={onIrACatalogo} className="gap-2">
              <BookOpen className="h-4 w-4" /> Ir a Catálogo
            </Button>
          )}
          <Button onClick={guardar} disabled={!puedeGuardar} className="gap-2">
            {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            {editando
              ? `Guardar cambios ${lineas.length > 0 ? `(${lineas.length})` : ''}`
              : `Guardar recepción ${lineas.length > 0 ? `(${lineas.length})` : ''} y generar rótulos`}
          </Button>
        </div>
        {guardando && (
          <p className="text-[11px] text-slate-500 text-right">
            Registrando el documento… no cierres ni hagas clic de nuevo.
          </p>
        )}
        <p className="text-[11px] text-slate-400">
          Al guardar, los artículos quedan <b>en tránsito</b>: ni este formulario ni el rótulo muestran ubicación —
          el destino se decide en el módulo Tránsito.
        </p>
      </div>

      {/* ═══ ÚLTIMAS RECEPCIONES (+ reimpresión) ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-extrabold text-slate-900">Últimas recepciones</p>
          {onIrATransito && pendientesTotal > 0 && (
            <Button variant="outline" size="sm" onClick={onIrATransito} className="gap-2 h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-50">
              <Truck className="h-3.5 w-3.5" />
              Ir a Tránsito ({pendientesTotal} por ubicar)
            </Button>
          )}
        </div>
        {recepciones.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">Aún no hay recepciones guardadas.</p>
        ) : (
          <ul className="space-y-1">
            {recepciones.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs border-b border-slate-100 pb-1 last:border-0">
                <span className="font-mono font-bold text-slate-700 shrink-0" title={`Guía ${r.guia}`}>{r.guia}</span>
                {(r.oc || r.dam) && (
                  <span className="text-slate-400 shrink-0 hidden sm:inline font-mono text-[10px]">
                    {r.oc && <>OC {r.oc}</>}{r.oc && r.dam && ' · '}{r.dam && <>DAM {r.dam}</>}
                  </span>
                )}
                {r.proveedores.length > 0 && (
                  <span className="text-slate-500 truncate flex-1 min-w-[100px]" title={r.proveedores.join(' · ')}>
                    {r.proveedores.length === 1 ? r.proveedores[0] : `${r.proveedores.length} proveedores`}
                  </span>
                )}
                <Badge variant="outline" className="text-[10px] shrink-0">{r.totalLineas} art.</Badge>
                <Badge
                  variant="outline"
                  className={`text-[10px] shrink-0 ${
                    r.pendientes > 0 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  }`}
                >
                  {r.pendientes > 0 ? `En tránsito (${r.pendientes})` : 'Ubicado'}
                </Badge>
                <span className="text-slate-400 shrink-0 hidden sm:inline">{new Date(r.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 shrink-0"
                  onClick={() => reimprimirGuia(r.guia)}
                  disabled={imprimiendo !== ''}
                  title={`Reimprimir los rótulos de la guía ${r.guia}`}
                  aria-label={`Reimprimir rótulos de la guía ${r.guia}`}
                >
                  {imprimiendo === r.guia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                </Button>
                {puedeGestionar && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 shrink-0 text-slate-400 hover:text-sky-700 hover:bg-sky-50"
                    onClick={() => abrirEdicion(r)}
                    disabled={guardando || cargandoEdicion !== '' || r.pendientes !== r.totalLineas}
                    title={
                      r.pendientes !== r.totalLineas
                        ? `No editable: ${r.totalLineas - r.pendientes} artículo(s) ya ubicados`
                        : `Revisar / editar la guía ${r.guia}`
                    }
                    aria-label={`Editar la guía ${r.guia}`}
                  >
                    {cargandoEdicion === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PencilLine className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {puedeEliminarRep && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 shrink-0 text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                    onClick={() => setEliminando(r)}
                    disabled={guardando || borrando || r.pendientes !== r.totalLineas}
                    title={
                      r.pendientes !== r.totalLineas
                        ? `No eliminable: ${r.totalLineas - r.pendientes} artículo(s) ya ubicados`
                        : `Eliminar la guía ${r.guia}`
                    }
                    aria-label={`Eliminar la guía ${r.guia}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ═══ MODAL DE RÓTULOS (guardado o reimpresión) ═══ */}
      <ImprimirRotulosDialog
        open={modal !== null}
        onOpenChange={(o) => { if (!o) setModal(null) }}
        rotulos={modal?.rotulos ?? []}
        encabezado={modal?.encabezado ?? { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '' }}
        nota={modal?.nota}
        subtitulo={`${modal?.rotulos.length ?? 0} artículo(s) de la guía · etiqueta 15 × 10 cm · almacén Repuestos`}
        formato="rep"
      />

      {/* ═══ ALTA RÁPIDA (puente Recepción → Catálogo) ═══ */}
      <DialogoAltaRapida
        open={altaOpen}
        codigoInicial={repNormalizarCodigo(codigo)}
        onOpenChange={setAltaOpen}
        onCreada={(a) => {
          setCodigo(a.codigo)
          buscarArticulo(a.codigo)
        }}
      />

      {/* ═══ CONFIRMAR ELIMINACIÓN DE GUÍA (supervisión) ═══ */}
      <AlertDialog open={eliminando !== null} onOpenChange={(o) => { if (!o) setEliminando(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar la guía {eliminando?.guia}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borrarán {eliminando?.totalLineas ?? 0} artículo(s) en tránsito y desaparecerán del
              módulo Tránsito. No hay stock ni kardex asociados (nada está ubicado). Esta acción no
              se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={borrando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              disabled={borrando}
              onClick={(e) => {
                e.preventDefault()
                void confirmarEliminar()
              }}
            >
              {borrando ? 'Eliminando…' : 'Sí, eliminar guía'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Clave local de línea (uuid; fallback por navegadores sin randomUUID). */
function claveLinea(): string {
  return uuidLocal()
}

/* ═══════════════════════════════════════════════════════════════════
   ALTA RÁPIDA DE ARTÍCULO DESCONOCIDO
   ═══════════════════════════════════════════════════════════════════ */

function DialogoAltaRapida({
  open,
  codigoInicial,
  onOpenChange,
  onCreada,
}: {
  open: boolean
  codigoInicial: string
  onOpenChange: (open: boolean) => void
  onCreada: (a: RepArticulo) => void
}) {
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [und, setUnd] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setCodigo(codigoInicial)
      setDescripcion('')
      setUnd('')
    }
  }, [open, codigoInicial])

  async function crear() {
    if (!codigo.trim() || !descripcion.trim()) {
      toast.error('Código y descripción son obligatorios')
      return
    }
    setBusy(true)
    try {
      const a = await repCrearArticulo({ codigo: codigo.trim(), descripcion: descripcion.trim(), und: und.trim() })
      toast.success(`Artículo ${a.codigo} creado`)
      onOpenChange(false)
      onCreada(a)
    } catch (err: unknown) {
      toast.error('No se pudo crear', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Alta rápida de artículo
          </DialogTitle>
          <DialogDescription>
            Crea el artículo en el catálogo para poder recibirlo. El código es el de BIG MAGIC.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="qr-codigo">Código *</Label>
            <Input id="qr-codigo" className="font-mono uppercase" value={codigo} onChange={(e) => setCodigo(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qr-desc">Descripción *</Label>
            <Input id="qr-desc" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') crear() }} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qr-und">Und</Label>
            <Input id="qr-und" value={und} onChange={(e) => setUnd(e.target.value)} placeholder="UND / GLN / MTS" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={crear} disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Crear y continuar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
