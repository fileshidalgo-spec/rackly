'use client'

/**
 * RACKLY — Módulo Recepción (independiente).
 *
 * Registro de recepción de mercadería/documentos con:
 *   · Formulario de registro (usuario tomado de la sesión) con 2 vías:
 *     foto de guía (OCR) o manual; ambas con "Dividir en paletas".
 *   · Listado AGRUPADO POR GUÍA: UNA fila por documento con todos sus
 *     artículos dentro (expandible); estado y borrado del documento completo.
 *   · Impresión de rótulos agrupada por guía (un solo trabajo).
 *   · Cambio de estado inline (autor o admin/supervisores).
 *   · Eliminación (solo admin/supervisores, misma política que Racks).
 *
 * Aislamiento: solo usa su tabla `recepcion_registros` vía
 * src/lib/rackly/modulos.ts. No toca Racks ni Piso.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime, type MotivoRealtime } from '@/hooks/useRegistrosRealtime'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import { fetchCatalogo } from '@/lib/rackly/catalogo'
import { agruparGuias, avisosDePaletas, expandirEnFilas, filasAItems, obsSinMarcaPaleta, type GuiaAgrupada } from '@/lib/rackly/recepcion-filas'
import { GuiaFotoForm } from '@/components/rackly/recepcion/GuiaFotoForm'
import {
  RecepcionItemsEditor,
  itemVacio,
  itemsValidos,
  type ItemRecepcion,
} from '@/components/rackly/recepcion/RecepcionItemsEditor'
import {
  ImprimirRotulosDialog,
  filasARotulos,
  type RotuloAImprimir,
} from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'
import { exportarGuiaExcel } from '@/lib/rackly/guia-excel'
import {
  listarRecepciones,
  listarRecepcionesPorDocumento,
  crearRecepciones,
  guardarEdicionGuia,
  cambiarEstadoGuia,
  eliminarGuia,
  abrirFotoGuia,
  urlFirmadaGuia,
  ESTADOS_RECEPCION,
  TIPOS_DOCUMENTO_RECEPCION,
  type RegistroRecepcion,
} from '@/lib/rackly/modulos'
import { useLoteUuidSync } from '@/lib/rackly/recepcion-idempotencia'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  PackageCheck,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Loader2,
  Inbox,
  Camera,
  PencilLine,
  ExternalLink,
  Printer,
  FileSpreadsheet,
  ChevronDown,
  ChevronRight,
  X,
  Check,
} from 'lucide-react'

const PAGE_SIZE = 50

/** Las 2 vías de registro del módulo (independientes entre sí). */
type ModoRegistro = 'foto' | 'manual'

const ESTADO_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  Recibido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Observado: 'bg-rose-50 text-rose-700 border-rose-200',
}

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

export function RecepcionModule() {
  const { perfil } = useAuth()
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEliminar =
    perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)
  const puedeCambiarEstado = useCallback(
    (reg: RegistroRecepcion) => puedeEliminar || reg.usuarioId === perfil?.id,
    [puedeEliminar, perfil?.id]
  )

  const [filas, setFilas] = useState<RegistroRecepcion[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [estadoFiltro, setEstadoFiltro] = useState('todos')
  const [offset, setOffset] = useState(0)
  const [saving, setSaving] = useState(false)
  // Borrado POR GUÍA: el registro está agrupado por documento y el documento
  // completo entra y sale junto (con confirmación que muestra el conteo).
  const [deleteTarget, setDeleteTarget] = useState<GuiaAgrupada | null>(null)
  // Guías EXPANDIDAS en el registro (chevron → ver sus artículos).
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set())
  function alternarExpansion(clave: string) {
    setExpandidas((prev) => {
      const next = new Set(prev)
      if (next.has(clave)) next.delete(clave)
      else next.add(clave)
      return next
    })
  }
  // Vía de registro activa: foto de guía (OCR) o formulario manual.
  const [modo, setModo] = useState<ModoRegistro>('foto')
  // Modal de impresión de rótulos (Zebra ZT411). Se abre SOLO tras REGISTRAR
  // (la carga ya validada y guardada en la BD): automáticamente al guardar
  // (instantánea `guardados`) o con el botón de reimpresión de una fila ya
  // registrada en la lista. Nunca con datos sin registrar.
  const [rotulosOpen, setRotulosOpen] = useState(false)
  // Impresión AGRUPADA POR GUÍA: un click en cualquier fila de una guía
  // abre el modal con TODOS sus artículos (copias por artículo, un solo
  // trabajo de impresión). `cargandoGuia` evita dobles clicks mientras
  // se consulta la BD.
  const [cargandoGuia, setCargandoGuia] = useState(false)
  // Exportación a EXCEL por guía: guarda la CLAVE de la guía en curso (un
  // archivo a la vez; el botón de ESA guía muestra el spinner mientras se
  // trae la guía completa de la BD y se genera el libro).
  const [exportando, setExportando] = useState<string | null>(null)
  const [guardados, setGuardados] = useState<{
    rotulos: RotuloAImprimir[]
    encabezado: EncabezadoRotulo
    nota?: string
  } | null>(null)

  /**
   * EDICIÓN de una guía YA registrada (el usuario pidió poder "revisar" el
   * documento después de registrarlo). Trae TODAS las filas de la guía de la
   * BD al formulario manual (re-ensamblando paletas), y al guardar las
   * sincroniza por id SIN borrar todo (guardarEdicionGuia). null = modo alta.
   */
  const [editando, setEditando] = useState<{
    ids: string[]
    estado: string
    autor: { id: string; nombre: string; correo: string }
    fotoUrl: string
    doc: string
    /** Nº de filas con envíos de Tránsito al abrir la edición (guard de guardado). */
    conEnvios: number
  } | null>(null)
  const [cargandoEdicion, setCargandoEdicion] = useState(false)

  /**
   * Lote de uuid_sync de la ALTA en curso (M-1): estable entre reintentos
   * del mismo formulario; se libera tras un guardado exitoso para que la
   * siguiente guía genere lotes nuevos.
   */
  const loteUuid = useLoteUuidSync()

  /** Cierra el modal y libera la instantánea post-guardado. */
  function cerrarRotulos(open: boolean) {
    setRotulosOpen(open)
    if (!open) setGuardados(null)
  }

  /**
   * Reimpresión de rótulos por GUÍA completa. Desde cualquier fila de la
   * lista trae de la BD TODOS los artículos del mismo documento (la página
   * visible puede estar paginada) y abre el modal con ellos: allí se
   * confirman las copias de cada artículo y se imprime todo de una vez.
   * Solo opera sobre datos YA registrados en la BD: se conserva la regla
   * de negocio "imprimir solo lo registrado".
   */
  async function reimprimirGuia(r: RegistroRecepcion) {
    if (cargandoGuia) return
    setCargandoGuia(true)
    try {
      const filasGuia = await listarRecepcionesPorDocumento({
        tipoDocumento: r.tipoDocumento,
        numeroDocumento: r.numeroDocumento,
        fecha: r.fecha,
        proveedor: r.proveedor,
      })
      // Fallback defensivo: la fila clickeada SIEMPRE participa.
      const vistas = filasGuia.length > 0 ? filasGuia : [r]
      const rotulos: RotuloAImprimir[] = vistas
        .filter((f) => f.codigo.trim())
        .map((f) => ({
          codigo: f.codigo.trim(),
          descripcion: f.descripcion.trim(),
          cantidad: String(f.cantidad),
          unidad: f.unidadMedida.trim(),
          lote: f.lote.trim(),
          fechaProduccion: f.fechaProduccion,
          fechaVencimiento: f.fechaVencimiento,
          // Marca "Paleta i/N" de las filas de artículos divididos: llega
          // al modal (badge) y al ZPL (caja propia en la banda LOTE).
          paleta: f.observaciones?.match(/Paleta \d+\/\d+/)?.[0] || undefined,
          copias: 1,
        }))
      if (rotulos.length === 0) {
        toast.info('Esa guía no tiene artículos con código', {
          description: 'El código de barras es el identificador del rótulo; completa el código del artículo en el registro para poder imprimirlo.',
        })
        return
      }
      const doc = r.numeroDocumento ? `${r.tipoDocumento} ${r.numeroDocumento}` : r.tipoDocumento
      setGuardados({
        rotulos,
        encabezado: {
          fecha: r.fecha,
          numeroDocumento: r.numeroDocumento,
          proveedor: r.proveedor,
          placa: r.placa,
          registradoPor: r.usuarioNombre,
        },
        nota: `Reimpresión de la guía completa (${doc}): ${rotulos.length} artículo(s) ya registrados en la base de datos. Digita cuántas etiquetas necesitas de cada uno e imprime todo de una vez.`,
      })
      setRotulosOpen(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo cargar la guía completa', { description: message })
    } finally {
      setCargandoGuia(false)
    }
  }

  /**
   * Exporta la guía COMPLETA a Excel (pedido del usuario: "que en la guía
   * registrada genere un archivo en excel que se pueda descargar, con toda
   * la información registrada"). Antes de exportar trae TODAS las filas del
   * documento desde la BD: la página visible puede estar paginada y el
   * Excel debe contener TODO el documento, no solo lo ya cargado en memoria.
   */
  async function descargarExcelGuia(g: GuiaAgrupada) {
    if (exportando) return
    setExportando(g.clave)
    try {
      const filasGuia = await listarRecepcionesPorDocumento({
        tipoDocumento: g.ref.tipoDocumento,
        numeroDocumento: g.ref.numeroDocumento,
        fecha: g.ref.fecha,
        proveedor: g.ref.proveedor,
      })
      // Fallback defensivo (mismo criterio que la reimpresión): la guía
      // clickeada SIEMPRE exporta aunque la consulta venga vacía.
      const filas = filasGuia.length > 0 ? filasGuia : g.filas
      // H-2: la foto ya no vive en una URL pública — se firma una URL
      // (1 h) solo para este archivo; si falla, el Excel sale sin ella.
      const fotoParaExcel = g.fotoUrl ? await urlFirmadaGuia(g.fotoUrl) : null
      const nombre = await exportarGuiaExcel({
        fecha: g.fecha,
        tipoDocumento: g.tipoDocumento,
        numeroDocumento: g.numeroDocumento,
        proveedor: g.proveedor,
        placa: g.placa,
        fotoUrl: fotoParaExcel ?? '',
        estado: g.estado,
        usuarioNombre: g.usuarioNombre,
        usuarioCorreo: g.usuarioCorreo,
        filas,
        cantidadTotal: filas.reduce((s, f) => s + f.cantidad, 0),
      })
      toast.success(`Excel descargado: ${nombre}`, {
        description: `${filas.length} fila(s) con toda la información registrada (artículos, paletas, lote y fechas).`,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo generar el Excel', { description: message })
    } finally {
      setExportando(null)
    }
  }

  // Formulario manual: encabezado del documento + lista de artículos.
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fDoc, setFDoc] = useState('Guia')
  const [fNumero, setFNumero] = useState('')
  const [fProveedor, setFProveedor] = useState('')
  const [fPlaca, setFPlaca] = useState('')
  const [fObs, setFObs] = useState('')
  const [items, setItems] = useState<ItemRecepcion[]>([itemVacio()])

  const formRef = useRef<HTMLDivElement>(null)

  /**
   * Reabre una guía registrada para REVISAR/EDITAR: encabezado + artículos
   * (incluidas las paletas de los artículos divididos) vuelven al formulario.
   * Al guardar, los cambios sincronizan por id (sin pérdida de datos) y el
   * modal de rótulos se abre de nuevo para imprimir paleta por paleta.
   */
  async function abrirEdicion(g: GuiaAgrupada) {
    if (cargandoEdicion) return
    setCargandoEdicion(true)
    try {
      const filasGuia = await listarRecepcionesPorDocumento({
        tipoDocumento: g.ref.tipoDocumento,
        numeroDocumento: g.ref.numeroDocumento,
        fecha: g.ref.fecha,
        proveedor: g.ref.proveedor,
      })
      const filasCompletas = filasGuia.length > 0 ? filasGuia : g.filas
      const primera = filasCompletas[0]
      if (!primera) return
      // Re-ensambla las filas en items editables (paletas incluidas).
      const itemsGuia = filasAItems(filasCompletas)
      const doc = g.numeroDocumento
        ? `${g.tipoDocumento} ${g.numeroDocumento}`
        : g.tipoDocumento
      setEditando({
        ids: filasCompletas.map((f) => f.id),
        estado: g.estado || primera.estado || 'Pendiente',
        autor: {
          id: primera.usuarioId,
          nombre: primera.usuarioNombre,
          correo: primera.usuarioCorreo,
        },
        fotoUrl: g.fotoUrl || '',
        doc,
        conEnvios: filasCompletas.filter((f) => (f.enviosTransito ?? 0) > 0).length,
      })
      // El editor vive en la vía manual: cámbiala y pre-llena el encabezado.
      setModo('manual')
      setFFecha(primera.fecha || hoyISO())
      setFDoc(primera.tipoDocumento || 'Guia')
      setFNumero(primera.numeroDocumento)
      setFProveedor(primera.proveedor)
      setFPlaca(g.placa || primera.placa || '')
      setFObs(obsSinMarcaPaleta(primera.observaciones || ''))
      setItems(itemsGuia.map((it) => ({ ...itemVacio(), ...it })))
      // AVISO Tránsito: la guía ya tiene envíos registrados. Se permite
      // abrir/revisar (corregir observaciones, etc.), pero al GUARDAR se
      // exigirá confirmación explícita — bajar cantidades por debajo de lo
      // enviado descuaradría el semáforo de Tránsito.
      const conEnvios = filasCompletas.filter((f) => (f.enviosTransito ?? 0) > 0).length
      toast.info(`Editando ${doc}`, {
        description:
          conEnvios > 0
            ? `ATENCIÓN: ${conEnvios} fila(s) ya fueron transferidas por Tránsito. Al guardar se pedirá confirmación; no bajes cantidades por debajo de lo enviado.`
            : 'Revisa los artículos y cantidades (puedes dividir en paletas) y pulsa "Guardar cambios".',
      })
      setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo abrir la guía para editar', { description: message })
    } finally {
      setCargandoEdicion(false)
    }
  }

  /** Sale del modo edición y limpia el formulario (sin tocar la BD). */
  function cancelarEdicion() {
    setEditando(null)
    setFNumero('')
    setFProveedor('')
    setFPlaca('')
    setFObs('')
    setItems([itemVacio()])
  }
  // Guard generacional: si cambian los filtros mientras una carga está en vuelo,
  // la respuesta VIEJA no debe pisar la lista (antes mezclaba filas de dos
  // filtros y el conteo/paginación quedaban incoherentes)
  const cargaGenRef = useRef(0)

  // ── REFRESCO AUTOMÁTICO (realtime + polling) ──
  // offsetRef: ¿dónde está navegando el usuario? Si cargó más páginas
  // ("Cargar más"), NO se le pisa la lista al refrescar: respetar su lectura.
  // filtrosActivosRef: los filtros COMMITADOS en la última carga (no lo que
  // el usuario esté tecleando a medio buscar) para re-refrescar igual.
  const offsetRef = useRef(0)
  const filtrosActivosRef = useRef({ busqueda: '', estado: '' })

  // EN VIVO: prueba VISIBLE del auto-refresco. El usuario pidió confirmar
  // que "lo que agrego desde mi celular u otro usuario se vea solo": con la
  // hora de la última actualización y el punto verde se comprueba de un
  // vistazo (realtime + polling de respaldo, sin recargar la página).
  const [enVivoHora, setEnVivoHora] = useState('')
  // Novedades FUERA de la vista actual: si el usuario avanzó con "Cargar
  // más" (offset ≠ 0) el refresco automático NO le pisa la lista (rompería
  // su lectura), pero con un cambio REAL de la BD (evento realtime o vuelta
  // a la pestaña) ahora se le AVISA — antes se saltaba en silencio y
  // parecía que el realtime "no funciona".
  const [nuevosPendientes, setNuevosPendientes] = useState(false)

  const cargar = useCallback(
    async (
      nuevoOffset: number,
      reemplazar: boolean,
      filtros?: { busqueda: string; estado: string }
    ) => {
      const gen = ++cargaGenRef.current
      setLoading(true)
      try {
        const fBusqueda = filtros?.busqueda ?? busqueda
        const fEstado = filtros ? filtros.estado : estadoFiltro === 'todos' ? '' : estadoFiltro
        if (!filtros) filtrosActivosRef.current = { busqueda: fBusqueda, estado: fEstado }
        const { filas: filasNuevas, total: totalNuevo } = await listarRecepciones({
          busqueda: fBusqueda,
          estado: fEstado,
          limit: PAGE_SIZE,
          offset: nuevoOffset,
        })
        if (gen !== cargaGenRef.current) return // llegó una carga más reciente
        setFilas((prev) => (reemplazar ? filasNuevas : [...prev, ...filasNuevas]))
        setTotal(totalNuevo)
        offsetRef.current = nuevoOffset
        setOffset(nuevoOffset)
        if (reemplazar) {
          setEnVivoHora(
            new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          )
          if (nuevoOffset === 0) setNuevosPendientes(false)
        }
      } catch (err: unknown) {
        if (gen !== cargaGenRef.current) return
        const message = err instanceof Error ? err.message : 'Error desconocido'
        toast.error('Error al cargar recepciones', { description: message })
      } finally {
        if (gen === cargaGenRef.current) setLoading(false)
      }
    },
    [busqueda, estadoFiltro]
  )

  /**
   * Refresco en segundo plano (lo dispara el realtime/polling): SOLO cuando
   * el usuario está en la primera página — si ya cargó más filas con "Cargar
   * más", pisarle la lista cada evento le rompería la lectura. En ese caso
   * el botón Buscar/actualizar sigue disponible.
   */
  const recargarLista = useCallback(
    (motivo: MotivoRealtime = 'evento') => {
      if (offsetRef.current !== 0) {
        // Lectura avanzada ("Cargar más"): no pisar la lista. Solo un cambio
        // REAL de la BD (evento del canal o vuelta a la pestaña) levanta el
        // aviso; el tic del polling NO (evita falsas alarmas).
        if (motivo !== 'poll') setNuevosPendientes(true)
        return
      }
      void cargar(0, true, {
        busqueda: filtrosActivosRef.current.busqueda,
        estado: filtrosActivosRef.current.estado,
      })
    },
    [cargar]
  )

  /** Botón del aviso "Hay registros nuevos": recarga con los filtros
   *  COMMITADOS (no con lo que esté a medio teclear en el buscador). */
  function aplicarNuevos() {
    setNuevosPendientes(false)
    void cargar(0, true, {
      busqueda: filtrosActivosRef.current.busqueda,
      estado: filtrosActivosRef.current.estado,
    })
  }

  // Realtime: lo que registra OTRO usuario (o este mismo desde el celular)
  // aparece sin recargar la página.
  useRegistrosRealtime('recepcion_registros', recargarLista)

  useEffect(() => {
    // Con los filtros COMMITADOS (filtrosActivosRef), NO con lo que el usuario
    // esté tecleando a medio buscar: antes cambiar el filtro de estado
    // aplicaba también la búsqueda no confirmada (filtro fantasma que el
    // realtime heredaba en los refrescos siguientes).
    const f = filtrosActivosRef.current
    cargar(0, true, { busqueda: f.busqueda, estado: estadoFiltro === 'todos' ? '' : estadoFiltro })
  }, [estadoFiltro])

  // Catálogo en cache para el auto-llenado de descripción/unidad al
  // escribir el código (en el editor de artículos).
  useEffect(() => {
    void fetchCatalogo()
  }, [])

  function buscar() {
    cargar(0, true)
  }

  async function handleRegistrar() {
    const validos = itemsValidos(items)
    if (validos.length === 0) {
      toast.error('Agrega al menos un artículo con código y cantidad mayor a 0')
      return
    }
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    setSaving(true)
    try {
      const fecha = fFecha || hoyISO()
      // DIVIDIR: cada artículo dividido en N paletas se expande a N filas
      // (mismo código; cantidad propia; "Paleta i/N" en observaciones).
      const filasGuardar = expandirEnFilas(validos)
      // M-1: lote uuid_sync estable para esta alta (reintentos idempotentes).
      const uuids = loteUuid.paraFilas(filasGuardar.length)
      for (const aviso of avisosDePaletas(validos)) {
        toast.warning('Las paletas no suman el total del artículo', {
          // Texto VERAZ en ambos casos: con UNA sola paleta con cantidad se
          // registra el TOTAL del artículo (no la paleta); con varias, lo
          // digitado en las paletas (o el total si quedó vacío).
          description: `${aviso}. Con UNA sola paleta con cantidad se registra el total del artículo; con varias paletas, lo digitado en ellas.`,
        })
        break // un solo aviso basta
      }

      // ── EDICIÓN de una guía ya registrada: sincroniza POR IDENTIDAD ──
      // Cada fila expandida lleva el filaId de la fila de la BD de la que
      // nació (filasAItems adjuntó las identidades al abrir la edición):
      // quitar/dividir/agregar ya NO cruza contenido entre filas.
      if (editando) {
        // GUARD Tránsito (edición): si la guía ya tiene envíos, exigir
        // confirmación explícita — el historial de Tránsito queda pegado a
        // estas filas (el UPDATE no re-atribuye transito) y bajar cantidades
        // por debajo de lo enviado descuaradría el semáforo.
        if (editando.conEnvios > 0) {
          const ok = window.confirm(
            `Esta guía ya tiene ${editando.conEnvios} fila(s) transferida(s) por Tránsito.\n\n` +
              'Al guardar, el historial de Tránsito sigue pegado a estas filas. Si bajas cantidades por debajo de lo ya enviado, el semáforo de Tránsito quedará descuadrado.\n\n' +
              '¿Guardar los cambios de todos modos?'
          )
          if (!ok) {
            setSaving(false)
            return
          }
        }
        const res = await guardarEdicionGuia(
          editando.ids,
          filasGuardar.map((f) => ({
            codigo: f.codigo,
            descripcion: f.descripcion,
            cantidad: f.cantidadNum,
            unidadMedida: f.unidad,
            lote: f.lote,
            fechaProduccion: f.fechaProduccion,
            fechaVencimiento: f.fechaVencimiento,
            observaciones: [fObs, f.paleta].filter(Boolean).join(' · '),
            filaId: f.filaId ?? null,
          })),
          {
            fecha,
            tipoDocumento: fDoc,
            numeroDocumento: fNumero,
            proveedor: fProveedor,
            placa: fPlaca,
            estado: editando.estado,
            fotoUrl: editando.fotoUrl,
          },
          editando.autor
        )
        toast.success(
          `Guía actualizada: ${res.actualizadas} fila(s) actualizada(s) · ${res.insertadas} nueva(s) · ${res.eliminadas} quitada(s)`
        )
        // Misma regla que al registrar: el modal de rótulos se abre con la
        // instantánea recién guardada (ahora incluye las paletas) para
        // configurar copias e imprimir de una vez.
        const rotulos = filasARotulos(validos)
        if (rotulos.length > 0) {
          setGuardados({
            rotulos,
            encabezado: {
              fecha,
              numeroDocumento: fNumero,
              proveedor: fProveedor,
              placa: fPlaca,
              registradoPor: editando.autor.nombre,
            },
            nota: `Guía actualizada: ${filasGuardar.length} fila(s) en la base de datos. Configura las etiquetas por rótulo/paleta e imprime todo de una vez.`,
          })
          setRotulosOpen(true)
        }
        cancelarEdicion()
        cargar(0, true)
        return
      }

      // ── ALTA normal: filas nuevas con el encabezado digitado ──
      await crearRecepciones(
        filasGuardar.map((f, i) => ({
          fecha,
          tipoDocumento: fDoc,
          numeroDocumento: fNumero,
          proveedor: fProveedor,
          codigo: f.codigo,
          descripcion: f.descripcion,
          cantidad: f.cantidadNum,
          unidadMedida: f.unidad,
          lote: f.lote,
          fechaProduccion: f.fechaProduccion,
          fechaVencimiento: f.fechaVencimiento,
          placa: fPlaca,
          observaciones: [fObs, f.paleta].filter(Boolean).join(' · '),
          uuidSync: uuids[i],
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      loteUuid.liberar()
      toast.success(
        `Recepción registrada: ${validos.length} artículo(s) · ${filasGuardar.length} fila(s)`
      )
      // Instantánea de EXACTAMENTE lo guardado en la BD → el modal de rótulos
      // se abre solo, listo para digitar las etiquetas por rótulo/paleta. La
      // impresión solo existe DESPUÉS de registrar (carga ya validada).
      // Si lo guardado no trae ningún código no hay rótulos que imprimir:
      // se avisa en vez de abrir un modal vacío.
      const rotulos = filasARotulos(validos)
      if (rotulos.length > 0) {
        setGuardados({
          rotulos,
          encabezado: {
            fecha,
            numeroDocumento: fNumero,
            proveedor: fProveedor,
            placa: fPlaca,
            registradoPor: perfil.nombre,
          },
          nota: `Recepción guardada: ${filasGuardar.length} fila(s) en la base de datos. Digita cuántas etiquetas necesitas de cada rótulo e imprime todo de una vez.`,
        })
        setRotulosOpen(true)
      } else {
        toast.info('Recepción guardada sin rótulos', {
          description: 'Ningún artículo registrado tiene código; completa el código en la lista para poder imprimir etiquetas.',
        })
      }
      setFNumero('')
      setFProveedor('')
      setFPlaca('')
      setFObs('')
      setItems([itemVacio()])
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      // M-1: la cancelación anti-duplicado no es un error — es una decisión
      // del usuario (y el reintento bloqueado por uuid_sync, un aviso).
      if (message.startsWith('REGISTRO_CANCELADO|')) {
        toast.info('Registro cancelado', {
          description: message.split('|')[1],
        })
      } else if (message.startsWith('REGISTRO_DUPLICADO|')) {
        toast.warning('No se registró nada nuevo', { description: message.split('|')[1] })
      } else {
        toast.error('No se pudo registrar', { description: message })
      }
    } finally {
      setSaving(false)
    }
  }

  /** Grupos del registro: UNA fila por guía con todos sus artículos dentro. */
  const grupos = useMemo(() => agruparGuias(filas), [filas])

  async function handleEstadoGuia(grupo: GuiaAgrupada, estado: string) {
    const primera = grupo.filas[0]
    if (!primera || !puedeCambiarEstado(primera)) {
      toast.error('Solo el autor o un supervisor puede cambiar el estado.')
      return
    }
    try {
      await cambiarEstadoGuia(grupo.ref, estado)
      const ids = new Set(grupo.filas.map((f) => f.id))
      setFilas((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, estado } : r)))
      toast.success(`Guía actualizada a ${estado} (${grupo.filas.length} fila(s))`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo actualizar el estado', { description: message })
    }
  }

  async function handleDeleteGuia() {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      // GUARD Tránsito: re-lee la guía COMPLETA (la lista paginada puede ser
      // parcial) y bloquea el borrado si ALGUNA fila ya tiene envíos de
      // Tránsito — borrarla dejaría el ingreso en kardex/piso como stock
      // huérfano sin trazabilidad (el semáforo perdería su origen).
      const completas = await listarRecepcionesPorDocumento(target.ref)
      const conEnvios = completas.filter((f) => (f.enviosTransito ?? 0) > 0).length
      if (conEnvios > 0) {
        toast.error('No se puede eliminar: la guía ya fue transferida por Tránsito', {
          description: `${conEnvios} fila(s) tienen envíos registrados. Primero revierte/anula los traslados en el módulo Tránsito (o contacta al administrador) — eliminar la guía dejaría stock huérfano sin trazabilidad.`,
        })
        return
      }
      await eliminarGuia(target.ref)
      toast.success(`Guía eliminada (${target.filas.length} fila(s))`)
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  const hayMas = filas.length < total

  return (
    <div className="space-y-5">
      {/* ── Selector de las 2 vías de registro ── */}
      <div className="flex items-center gap-1 bg-white/70 border rounded-lg p-1 w-fit">
        <button
          onClick={() => setModo('foto')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            modo === 'foto'
              ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <Camera className="h-3.5 w-3.5" />
          Con foto de guía
        </button>
        <button
          onClick={() => setModo('manual')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            modo === 'manual'
              ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <PencilLine className="h-3.5 w-3.5" />
          Manual
        </button>
      </div>

      {/* ── Opción 1: registro con foto de la guía (OCR + catálogo) ── */}
      {modo === 'foto' && <GuiaFotoForm onRegistrado={() => cargar(0, true)} />}

      {/* ── Opción 2: formulario manual (encabezado + N artículos) ── */}
      {modo === 'manual' && (
      <div ref={formRef} className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 space-y-4 scroll-mt-20">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {editando ? (
              <PencilLine className="h-4 w-4 text-sky-600" />
            ) : (
              <Plus className="h-4 w-4 text-amber-600" />
            )}
            <h3 className="text-sm font-bold text-amber-900">
              {editando ? `Editando ${editando.doc}` : 'Nueva recepción (manual)'}
            </h3>
          </div>
          {editando ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={cancelarEdicion}
              className="h-7 gap-1 text-xs text-slate-500"
            >
              <X className="h-3.5 w-3.5" /> Cancelar edición
            </Button>
          ) : (
            <p className="text-[11px] text-slate-500">
              Escribe el código y se autocompletan descripción y unidad desde el catálogo.
            </p>
          )}
        </div>
        {editando && (
          <p className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] font-semibold text-sky-800">
            Modo revisión: ajusta cantidades, divide en paletas o corrige datos y pulsa
            "Guardar cambios" — las filas registradas se actualizan sin perder quién registró
            ni la foto de la guía.
          </p>
        )}

        {/* Encabezado del documento (compartido por todos los artículos) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Fecha</Label>
            <Input type="date" value={fFecha} onChange={(e) => setFFecha(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tipo de documento</Label>
            <Select value={fDoc} onValueChange={setFDoc}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS_DOCUMENTO_RECEPCION.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nº de documento</Label>
            <Input
              placeholder="Ej: T005-0034403"
              value={fNumero}
              onChange={(e) => setFNumero(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Proveedor</Label>
            <Input
              placeholder="Nombre del proveedor"
              value={fProveedor}
              onChange={(e) => setFProveedor(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Placa</Label>
            <Input
              placeholder="Placa del vehículo"
              value={fPlaca}
              onChange={(e) => setFPlaca(e.target.value.toUpperCase())}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Observaciones</Label>
            <Textarea
              rows={1}
              placeholder="Observaciones de la recepción (opcional)"
              value={fObs}
              onChange={(e) => setFObs(e.target.value)}
            />
          </div>
        </div>

        {/* Artículos de la guía (1, 20 o más) */}
        <RecepcionItemsEditor items={items} onChange={setItems} />

        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={handleRegistrar}
            disabled={saving}
            className={`flex-1 gap-2 text-white ${
              editando
                ? 'bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700'
                : 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700'
            }`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editando ? <Check className="h-4 w-4" /> : <PackageCheck className="h-4 w-4" />}
            {editando
              ? `Guardar cambios (${itemsValidos(items).length} artículo(s))`
              : `Registrar ${itemsValidos(items).length > 0 ? `${itemsValidos(items).length} artículo(s)` : 'recepción'}`}
          </Button>
          {/* La impresión de rótulos NO va aquí: solo se ofrece tras REGISTRAR
              (el modal se abre solo al guardar, o desde la lista de
              registrados), cuando la carga ya fue validada. */}
        </div>
      </div>
      )}

      {/* ── Filtros ── */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Buscar por proveedor, código, documento o descripción…"
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
            {ESTADOS_RECEPCION.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={buscar} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Buscar
        </Button>
      </div>

      {/* ── EN VIVO: la lista se refresca sola (realtime + polling de
          respaldo). El usuario debe poder COMPROBAR de un vistazo que la
          actualización automática está activa — era invisible y por eso
          parecía que "no sale". ── */}
      <div className="flex items-center gap-2 flex-wrap -mt-1">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          En vivo{enVivoHora ? ` · actualizado ${enVivoHora}` : ''}
          <span className="hidden min-[430px]:inline font-normal text-slate-500">
            — lo que registre otro usuario (o tu celular) aparece solo
          </span>
        </span>
        {nuevosPendientes && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[10px] border-amber-300 text-amber-800 hover:bg-amber-50"
            onClick={aplicarNuevos}
          >
            <RefreshCw className="h-2.5 w-2.5" /> Hay registros nuevos — Ver actualizado
          </Button>
        )}
      </div>

      {/* ── Listado desktop AGRUPADO POR GUÍA: 1 fila por documento con
          TODOS sus artículos dentro (expandibles con el chevron). El
          estado y el borrado operan sobre el documento completo. ── */}
      <div className="hidden md:block rounded-lg border overflow-x-auto bg-white">
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36px]" />
              <TableHead className="w-[100px]">Fecha</TableHead>
              <TableHead className="w-[150px]">Documento</TableHead>
              <TableHead className="min-w-[140px]">Proveedor</TableHead>
              <TableHead className="min-w-[200px]">Artículos</TableHead>
              <TableHead className="w-[100px] text-right">Cant. total</TableHead>
              <TableHead className="w-[60px] text-center">Foto</TableHead>
              <TableHead className="w-[140px]">Estado</TableHead>
              <TableHead className="min-w-[130px]">Registró</TableHead>
              <TableHead className="w-[60px] text-center" title="Imprimir los rótulos de TODA la guía (todos sus artículos)">Rótulo</TableHead>
              <TableHead className="w-[60px] text-center" title="Revisar y EDITAR la guía completa (cantidades, paletas, lote, fechas…)">Editar</TableHead>
              <TableHead className="w-[60px] text-center" title="Descargar esta guía completa en Excel (encabezado + todos los artículos y paletas)">Excel</TableHead>
              {puedeEliminar && <TableHead className="w-[60px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grupos.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={puedeEliminar ? 13 : 12} className="text-center text-sm text-slate-400 py-10">
                  <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  No hay recepciones registradas con los filtros actuales.
                </TableCell>
              </TableRow>
            )}
            {grupos.map((g) => {
              const abierta = expandidas.has(g.clave)
              const primera = g.filas[0]
              const puedeEstado = primera ? puedeCambiarEstado(primera) : false
              const resumen =
                primera
                  ? `${primera.codigo || '(sin código)'}${primera.descripcion ? ` · ${primera.descripcion}` : ''}${g.filas.length > 1 ? `  +${g.filas.length - 1} más` : ''}`
                  : ''
              return (
                <Fragment key={g.clave}>
                  <TableRow className={abierta ? 'bg-amber-50/40' : ''}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => alternarExpansion(g.clave)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-amber-50 hover:text-amber-700"
                        title={abierta ? 'Ocultar artículos de la guía' : 'Ver TODOS los artículos de la guía'}
                        aria-label={abierta ? 'Ocultar artículos' : 'Ver artículos'}
                      >
                        {abierta ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{g.fecha}</TableCell>
                    <TableCell>
                      <p className="text-xs font-semibold">{g.tipoDocumento}</p>
                      <p className="text-xs text-slate-400">{g.numeroDocumento || '—'}</p>
                    </TableCell>
                    <TableCell className="text-sm truncate max-w-[180px]" title={g.proveedor}>
                      {g.proveedor || '—'}
                    </TableCell>
                    <TableCell>
                      <p className="text-sm font-semibold">
                        {g.filas.length} artículo{g.filas.length !== 1 ? 's' : ''}
                        {g.filas.length > 1 && (
                          <span className="ml-1.5 text-[10px] font-normal text-slate-400">(chevron para verlos)</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-400 truncate max-w-[240px]" title={resumen}>
                        {resumen}
                      </p>
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold">
                      {String(Math.round(g.cantidadTotal * 1000) / 1000)}
                    </TableCell>
                    <TableCell className="text-center">
                      {g.fotoUrl ? (
                        // H-2: bucket privado — la URL se firma al hacer clic
                        // (nunca una URL pública persistente).
                        <button
                          type="button"
                          onClick={() => void abrirFotoGuia(g.fotoUrl)}
                          title="Ver foto de la guía"
                          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border text-slate-500 hover:bg-amber-50 hover:text-amber-600"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {puedeEstado && g.estado ? (
                        <Select value={g.estado} onValueChange={(v) => void handleEstadoGuia(g, v)}>
                          <SelectTrigger className="h-8 w-[125px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ESTADOS_RECEPCION.map((e) => (
                              <SelectItem key={e} value={e}>
                                {e}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className={ESTADO_CLASE[g.estado] ?? ''}>
                          {g.estado || 'Mixto'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-xs font-medium truncate max-w-[130px]" title={g.usuarioNombre}>
                        {g.usuarioNombre || '—'}
                      </p>
                      <p className="text-[10px] text-slate-400 truncate max-w-[130px]">{g.usuarioCorreo}</p>
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => primera && void reimprimirGuia(primera)}
                        disabled={cargandoGuia || !primera}
                        title="Imprimir los rótulos de TODA la guía, agrupados en una sola ventana"
                      >
                        {cargandoGuia ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-sky-600 hover:text-sky-700 hover:bg-sky-50"
                        onClick={() => void abrirEdicion(g)}
                        disabled={cargandoEdicion}
                        title="Revisar / EDITAR la guía completa: cantidades, paletas, lote y fechas — al guardar se actualizan las filas registradas"
                      >
                        {cargandoEdicion ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                        onClick={() => void descargarExcelGuia(g)}
                        disabled={!!exportando}
                        title="Descargar esta guía completa en Excel: encabezado + todos los artículos y paletas (lote, fechas, estado…)"
                      >
                        {exportando === g.clave ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    {puedeEliminar && (
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                          onClick={() => setDeleteTarget(g)}
                          title="Eliminar TODA la guía (todas sus filas)"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                  {abierta && (
                    <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
                      <TableCell colSpan={puedeEliminar ? 13 : 12} className="p-0">
                        <div className="px-4 py-3 space-y-1.5">
                          {g.filas.map((f, i) => {
                            const mPaleta = f.observaciones?.match(/Paleta \d+\/\d+/)
                            return (
                              <div
                                key={f.id}
                                className="flex items-center gap-3 text-xs border-b border-slate-100 pb-1.5 last:border-0 last:pb-0"
                              >
                                <span className="w-6 shrink-0 text-slate-400 font-bold">{i + 1}</span>
                                <span className="w-24 shrink-0 font-semibold text-slate-800">{f.codigo || '—'}</span>
                                <span className="flex-1 truncate text-slate-600" title={f.descripcion}>
                                  {f.descripcion || '—'}
                                </span>
                                {f.lote && <span className="shrink-0 text-slate-400">Lote {f.lote}</span>}
                                {mPaleta && (
                                  <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-700">
                                    {mPaleta[0]}
                                  </span>
                                )}
                                <span className="w-28 shrink-0 text-right font-semibold text-slate-800">
                                  {f.cantidad}
                                  {f.unidadMedida ? ` ${f.unidadMedida}` : ''}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* ── Listado móvil AGRUPADO POR GUÍA ── */}
      <div className="md:hidden space-y-3">
        {grupos.length === 0 && !loading && (
          <p className="text-sm text-slate-400 text-center py-8">No hay recepciones para mostrar.</p>
        )}
        {grupos.map((g) => {
          const abierta = expandidas.has(g.clave)
          const primera = g.filas[0]
          const puedeEstado = primera ? puedeCambiarEstado(primera) : false
          return (
            <div key={g.clave} className="rounded-lg border bg-white p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">
                    {g.tipoDocumento} {g.numeroDocumento || '(sin número)'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {g.proveedor || '—'} · {g.fecha}
                  </p>
                </div>
                <Badge variant="outline" className={`${ESTADO_CLASE[g.estado] ?? ''} shrink-0`}>
                  {g.estado || 'Mixto'}
                </Badge>
              </div>
              <button
                type="button"
                onClick={() => alternarExpansion(g.clave)}
                className="w-full flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800"
                title={abierta ? 'Ocultar artículos' : 'Ver todos los artículos de la guía'}
              >
                {abierta ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">
                  {g.filas.length} artículo{g.filas.length !== 1 ? 's' : ''} · Cant. total:{' '}
                  {String(Math.round(g.cantidadTotal * 1000) / 1000)}
                  {g.placa ? ` · Placa ${g.placa}` : ''}
                </span>
              </button>
              {abierta && (
                <div className="space-y-1 rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                  {g.filas.map((f, i) => {
                    const mPaleta = f.observaciones?.match(/Paleta \d+\/\d+/)
                    return (
                      <div key={f.id} className="flex items-center gap-2 text-xs">
                        <span className="w-5 shrink-0 text-slate-400 font-bold">{i + 1}</span>
                        <span className="font-semibold text-slate-800 shrink-0">{f.codigo || '—'}</span>
                        <span className="flex-1 truncate text-slate-600" title={f.descripcion}>
                          {f.descripcion || '—'}
                        </span>
                        {mPaleta && (
                          <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1 py-0.5 text-[9px] font-semibold text-sky-700">
                            {mPaleta[0]}
                          </span>
                        )}
                        <span className="shrink-0 text-right font-semibold text-slate-800">
                          {f.cantidad}
                          {f.unidadMedida ? ` ${f.unidadMedida}` : ''}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1 text-xs text-slate-500">
                <span className="truncate">Por: {g.usuarioNombre || '—'}</span>
                {g.fotoUrl && (
                  // H-2: igual que la tabla — URL firmada solo al hacer clic.
                  <button
                    type="button"
                    onClick={() => void abrirFotoGuia(g.fotoUrl)}
                    className="cursor-pointer text-amber-600 font-semibold underline text-right"
                  >
                    Ver foto de la guía
                  </button>
                )}
              </div>
              {puedeEstado && g.estado && (
                <Select value={g.estado} onValueChange={(v) => void handleEstadoGuia(g, v)}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ESTADOS_RECEPCION.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1 text-amber-700 hover:bg-amber-50"
                onClick={() => primera && void reimprimirGuia(primera)}
                disabled={cargandoGuia || !primera}
              >
                {cargandoGuia ? <Loader2 className="h-3 w-3 animate-spin" /> : <Printer className="h-3 w-3" />}
                Imprimir rótulos de la guía
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1 text-sky-700 hover:bg-sky-50"
                onClick={() => void abrirEdicion(g)}
                disabled={cargandoEdicion}
              >
                {cargandoEdicion ? <Loader2 className="h-3 w-3 animate-spin" /> : <PencilLine className="h-3 w-3" />}
                Revisar / editar la guía
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1 text-emerald-700 hover:bg-emerald-50"
                onClick={() => void descargarExcelGuia(g)}
                disabled={!!exportando}
              >
                {exportando === g.clave ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSpreadsheet className="h-3 w-3" />}
                Descargar Excel de la guía
              </Button>
              {puedeEliminar && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1 text-rose-600 hover:bg-rose-50"
                  onClick={() => setDeleteTarget(g)}
                >
                  <Trash2 className="h-3 w-3" /> Eliminar guía completa
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Paginación ── */}
      {hayMas && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => cargar(offset + PAGE_SIZE, false)}
            disabled={loading}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Cargar más ({filas.length} de {total} filas · agrupadas por guía)
          </Button>
        </div>
      )}

      {/* ── Impresión de rótulos (Zebra ZT411 por USB) — solo datos YA
          registrados: instantánea post-guardado o reimpresión AGRUPADA
          por guía completa ── */}
      <ImprimirRotulosDialog
        open={rotulosOpen}
        onOpenChange={cerrarRotulos}
        rotulos={guardados ? guardados.rotulos : []}
        encabezado={
          guardados
            ? guardados.encabezado
            : { fecha: '', numeroDocumento: '', proveedor: '', placa: '', registradoPor: '' }
        }
        nota={guardados?.nota}
      />

      {/* ── Confirmar eliminación POR GUÍA ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar la guía completa</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar {deleteTarget?.tipoDocumento}{' '}
              <strong>{deleteTarget?.numeroDocumento || '(sin número)'}</strong> de{' '}
              <strong>{deleteTarget?.proveedor || 'proveedor sin nombre'}</strong> con{' '}
              <strong>TODAS sus {deleteTarget?.filas.length ?? 0} fila(s)</strong> (artículos y
              paletas registrados)? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteGuia}>Eliminar guía</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
