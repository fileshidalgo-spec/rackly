'use client'

/**
 * RACKLY — Recepción · Pestaña DEVOLUCIONES · Opción "Con foto del RQ".
 *
 * Flujo (ESPEJO de RqFotoForm de Atención — pedido del usuario 2026-10-31:
 * «la devolución es idéntico a la extracción de datos que hacemos para
 * atención… que devolución sea parecido a atención pero es recepción»):
 *   1. Usuario toma foto al RQ DE DEVOLUCIÓN (Requisición de Devolución de
 *      Material — NO es una guía) → RECORTE previo (RecortarImagenDialog
 *      reutilizado; sin duplicar lógica).
 *   2. OCR con el pipeline COMPARTIDO (rq-ocr-runner.ts): los mismos 2 pases
 *      + zooms que Atención y el MISMO parser rq-ocr.ts → Nº RQ, orden de
 *      producción, producto, fecha, línea, solicitante y la tabla de
 *      materiales (código/descripción/U/M/cantidad) contra el catálogo.
 *   3. Formulario de CONFIRMACIÓN: encabezado del RQ + materiales editables
 *      (autocompletado de catálogo igual que Atención; el proveedor SOLO
 *      para films lámina/stretch, igual que las guías).
 *   4. Registrar = RECEPCIÓN: foto liviana → bucket recepcion-guias y UNA
 *      FILA POR MATERIAL en recepcion_registros con tipo_recepcion=
 *      'devolucion' (separada de las guías) → rótulos con QR ÚNICO por fila
 *      (mismo modal ImprimirRotulosDialog; auto-estatus 'Recepcionado' al
 *      imprimir) y flujo Tránsito intacto.
 *
 * Datos del RQ → recepción (mapeo en devolucion-rq.ts):
 *   numeroDocumento = Nº RQ · empresaOrigen = Solicitante (origen de la
 *   devolución) · observaciones = OP · Línea · Producto · placa = ''.
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  buscarCatalogo,
  fetchCatalogo,
  searchCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { type DatosRq } from '@/lib/rackly/rq-ocr'
import { ejecutarOcrRq } from '@/lib/rackly/rq-ocr-runner'
import {
  contextoDesdeDatosRq,
  materialesRqAFilas,
  observacionesContextoRq,
  TIPO_DOC_DEVOLUCION,
  type ContextoRqDevolucion,
} from '@/lib/rackly/devolucion-rq'
import {
  crearRecepciones,
  listarRecepcionesPorDocumento,
  marcarGuiaRecepcionada,
  subirFotoGuia,
  TIPO_RECEPCION,
} from '@/lib/rackly/modulos'
import { expandirEnFilas, faltanProveedor } from '@/lib/rackly/recepcion-filas'
import { useLoteUuidSync } from '@/lib/rackly/recepcion-idempotencia'
import { puede } from '@/lib/rackly/permisos'
import { PROVEEDORES_FILM } from '@/lib/rackly/constants'
import { requiereProveedor } from '@/lib/utils'
import {
  ImprimirRotulosDialog,
  filasARotulos,
  rotulosDesdeFilas,
  type RotuloAImprimir,
} from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import {
  RecortarImagenDialog,
  type OrigenRecorte,
} from '@/components/rackly/recepcion/RecortarImagenDialog'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'
import type { GuiaRegistradaInfo } from '@/components/rackly/recepcion/GuiaFotoForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Camera,
  Crop,
  Loader2,
  ScanLine,
  RotateCcw,
  ClipboardList,
  Plus,
  Trash2,
  ImageIcon,
  CheckCircle2,
  XCircle,
  PackageOpen,
  SearchCheck,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { mensajeError, codigoControladoDe, ERR_CANCELADO, ERR_DUPLICADO } from '@/lib/rackly/errores'

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

/** Material editable del formulario de confirmación (cantidad como texto). */
type ItemDevo = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  enCatalogo: boolean
  revision: boolean
  /** El OCR adoptó el código por similitud de descripción (chip azul). */
  matchPorDescripcion: boolean
  /** El usuario escribió la descripción/unidad a mano: el autocompletado no las borra. */
  descripcionManual: boolean
  unidadManual: boolean
  /** Proveedor del artículo (SOLO films lámina/stretch — igual que guías). */
  proveedor: string
}

function itemVacioDevo(): ItemDevo {
  return {
    codigo: '',
    descripcion: '',
    cantidad: '',
    unidad: '',
    enCatalogo: false,
    revision: false,
    matchPorDescripcion: false,
    descripcionManual: false,
    unidadManual: false,
    proveedor: '',
  }
}

type Paso = 'elegir' | 'recortar' | 'procesando' | 'confirmar'

type FormDevo = ContextoRqDevolucion & {
  fecha: string
  notas: string
  items: ItemDevo[]
}

/** Estado inicial FRESCO: fecha del día (no congelada al montar). */
function formVacio(): FormDevo {
  return {
    numeroRq: '',
    ordenProduccion: '',
    productoCodigo: '',
    productoDescripcion: '',
    linea: '',
    solicitante: '',
    fecha: hoyISO(),
    notas: '',
    items: [itemVacioDevo()],
  }
}

/** DatosRq (OCR compartido con Atención) → filas del formulario. */
function itemsDesdeOcr(datos: DatosRq): ItemDevo[] {
  return datos.items.map((it) => ({
    codigo: it.codigo,
    descripcion: it.descripcion,
    cantidad: String(it.cantidad),
    unidad: it.unidad,
    enCatalogo: it.enCatalogo,
    revision: it.revision,
    matchPorDescripcion: it.matchPorDescripcion ?? false,
    descripcionManual: false,
    unidadManual: false,
    proveedor: '',
  }))
}

export function DevolucionFotoForm({
  onRegistrado,
}: {
  onRegistrado: (info: GuiaRegistradaInfo) => void
}) {
  const { perfil } = useAuth()
  // Cuadro de permisos: registrar devoluciones = recepcion.crear (la BD lo
  // aplica con la política RESTRICTIVE; aquí es feedback temprano).
  const puedeCrear = puede(perfil, 'recepcion.crear')
  const [paso, setPaso] = useState<Paso>('elegir')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [catError, setCatError] = useState(false)
  const [progreso, setProgreso] = useState(0)
  const [etapa, setEtapa] = useState('')
  const [thumb, setThumb] = useState<string>('')
  const [fotoBlob, setFotoBlob] = useState<Blob | null>(null)
  const [form, setForm] = useState<FormDevo>(formVacio())
  const [saving, setSaving] = useState(false)
  /** Rigor numérico (Task 23): discrepancias entre lecturas que el usuario
   *  debe verificar antes de registrar (Nº RQ / OP / producto / cantidades). */
  const [avisos, setAvisos] = useState<string[]>([])

  /**
   * Lote de uuid_sync del registro en curso (M-1): estable entre reintentos
   * del mismo formulario; liberado tras un guardado exitoso o al reiniciar.
   */
  const loteUuid = useLoteUuidSync()
  // Modal de impresión de rótulos (mismo que guías: Zebra ZT411, QR por fila,
  // auto-estatus 'Recepcionado'). Se abre SOLO tras REGISTRAR.
  const [rotulosOpen, setRotulosOpen] = useState(false)
  const [guardados, setGuardados] = useState<{
    rotulos: RotuloAImprimir[]
    encabezado: EncabezadoRotulo
    ref?: { guiaId: string; tipoDocumento: string; numeroDocumento: string; fecha: string; proveedor: string }
    nota?: string
  } | null>(null)

  function cerrarRotulos(open: boolean) {
    setRotulosOpen(open)
    if (!open) setGuardados(null)
  }

  const inputCamaraRef = useRef<HTMLInputElement>(null)
  const inputGaleriaRef = useRef<HTMLInputElement>(null)

  // ── RECORTE previo al OCR (misma mecánica que guías y Atención) ──
  const [pendiente, setPendiente] = useState<File | null>(null)
  const [origenRecorte, setOrigenRecorte] = useState<OrigenRecorte>('inicio')
  const originalRef = useRef<File | null>(null)

  useEffect(() => {
    fetchCatalogo()
      .then((c) => {
        setCatalogo(c)
        if (c.length === 0) setCatError(true)
      })
      .catch(() => setCatError(true))
  }, [])

  // Al desmontar, liberar el objectURL del thumbnail (fuga de blob retenido).
  useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb)
    }
  }, [thumb])

  function set<K extends keyof FormDevo>(k: K, v: FormDevo[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  function setItem(idx: number, parche: Partial<ItemDevo>) {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...parche } : it)),
    }))
  }

  // ── CATÁLOGO · AUTOCOMPLETADO (igual que Atención y Recepción) ──────
  // Al escribir/corregir el código se jala la descripción y la unidad del
  // catálogo; si no matchea, se limpian SALVO que el usuario las escriba a
  // mano (flags descripcionManual/unidadManual). Menú de sugerencias con
  // teclado (↑ ↓ Enter Esc) igual que RqFotoForm/RecepcionItemsEditor.
  const [menuIdx, setMenuIdx] = useState<number | null>(null)
  const [resaltado, setResaltado] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
    },
    []
  )

  function sugerenciasPara(codigo: string): CatalogoItem[] {
    const q = codigo.trim()
    if (!q) return []
    return searchCatalogo(q, 8)
  }

  function onCodigo(idx: number, valor: string) {
    const it = form.items[idx]
    const cat = valor.trim() ? buscarCatalogo(valor) : undefined
    let descripcion = it.descripcion
    let unidad = it.unidad
    if (!valor.trim()) {
      if (!it.descripcionManual) descripcion = ''
      if (!it.unidadManual) unidad = ''
    } else if (cat) {
      // En catálogo: descripción y unidad OFICIALES (igual que Atención).
      descripcion = cat.descripcion
      unidad = cat.un || it.unidad
    } else {
      // El texto previo pertenecía al código anterior → fuera (si no es manual)
      if (!it.descripcionManual) descripcion = ''
      if (!it.unidadManual) unidad = ''
    }
    setItem(idx, {
      codigo: valor,
      descripcion,
      unidad,
      enCatalogo: Boolean(cat),
      matchPorDescripcion: false,
      revision: false,
    })
    if (valor.trim()) {
      setResaltado(0)
      setMenuIdx(idx)
    } else {
      setMenuIdx(null)
    }
  }

  function aplicarSugerencia(idx: number, cat: CatalogoItem) {
    setItem(idx, {
      codigo: cat.codigo,
      descripcion: cat.descripcion,
      unidad: cat.un || '',
      enCatalogo: true,
      matchPorDescripcion: false,
      revision: false,
    })
    setMenuIdx(null)
  }

  function navMenu(e: React.KeyboardEvent<HTMLInputElement>, idx: number, sugerencias: CatalogoItem[]) {
    if (menuIdx !== idx || sugerencias.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setResaltado((r) => Math.min(r + 1, sugerencias.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setResaltado((r) => Math.max(r - 1, 0))
    } else if (e.key === 'Enter' && sugerencias[resaltado]) {
      e.preventDefault()
      aplicarSugerencia(idx, sugerencias[resaltado])
    } else if (e.key === 'Escape') {
      setMenuIdx(null)
    }
  }

  /** Aplica la mejor extracción al formulario + resumen de lo detectado. */
  function procesarExtraccion(datos: DatosRq, avisosOCR: string[]) {
    setAvisos(avisosOCR)
    const itemsOcr = itemsDesdeOcr(datos)
    const ctx = contextoDesdeDatosRq(datos)
    setForm({
      ...ctx,
      fecha: datos.fecha || hoyISO(),
      notas: '',
      items: itemsOcr.length > 0 ? itemsOcr : [itemVacioDevo()],
    })

    if (!datos.numeroRq && itemsOcr.length === 0) {
      toast.warning('No se detectaron datos automáticamente', {
        description: 'Completa los datos manualmente en el siguiente paso.',
      })
      return
    }

    const faltantes: string[] = []
    if (!datos.numeroRq) faltantes.push('nº RQ')
    if (!datos.fecha) faltantes.push('fecha')
    const enCat = itemsOcr.filter((i) => i.enCatalogo).length
    const rev = itemsOcr.filter((i) => i.revision).length
    if (avisosOCR.length > 0) {
      // RIGOR NUMÉRICO: discrepancias entre lecturas — el usuario pidió
      // máxima certeza con los números (un error malogra el proceso).
      toast.warning('Verifica los números señalados', {
        description: avisosOCR.join(' · ')
      })
    }
    toast.success(
      itemsOcr.length > 0
        ? `Se detectaron ${itemsOcr.length} material(es)${enCat > 0 ? ` · ${enCat} en catálogo` : ''}`
        : 'Datos del documento recopilados',
      {
        description:
          [
            datos.numeroRq ? `RQ ${datos.numeroRq}` : '',
            datos.ordenProduccion ? `OP ${datos.ordenProduccion}` : '',
            datos.linea ? `Línea ${datos.linea}` : '',
          ]
            .filter(Boolean)
            .join(' · ') +
          (rev > 0 ? ` · ${rev} a revisar` : '') +
          (faltantes.length ? `. Faltan: ${faltantes.join(', ')} (se completan a mano).` : ''),
      }
    )
  }

  /** Foto elegida (cámara o galería): abre el recorte ANTES de procesar. */
  function alElegirFoto(f: File | undefined, origen: OrigenRecorte) {
    if (!f) return
    setPendiente(f)
    setOrigenRecorte(origen)
    setPaso('recortar')
  }

  async function procesar(archivo: File) {
    setPaso('procesando')
    setProgreso(0)
    setEtapa('Preparando imagen…')
    try {
      if (thumb) {
        URL.revokeObjectURL(thumb)
        setThumb('')
      }
      if (!originalRef.current) originalRef.current = archivo

      // EXTRACCIÓN IDÉNTICA A ATENCIÓN (pedido 2026-10-31): el MISMO pipeline
      // OCR de RQ (rq-ocr-runner.ts) — 2 pases + zoom tabla + zoom encabezado
      // + rigor numérico sobre el parser rq-ocr.ts.
      const { datos, avisos: avisosOcr, fotoLiviana, catalogoVacio } = await ejecutarOcrRq(archivo, {
        onEtapa: setEtapa,
        onProgreso: setProgreso,
      })
      if (fotoLiviana) {
        setFotoBlob(fotoLiviana)
        setThumb(URL.createObjectURL(fotoLiviana))
      }
      if (catalogoVacio) {
        toast.warning('Catálogo no disponible', {
          description:
            'Los códigos no se podrán reconocer automáticamente; completa los materiales a mano.',
        })
      }

      procesarExtraccion(datos, avisosOcr)
      setPaso('confirmar')
    } catch (err: unknown) {
      const message = mensajeError(err)
      toast.error('No se pudo procesar la foto', { description: message })
      setPaso('elegir')
    }
  }

  function reiniciar() {
    if (thumb) URL.revokeObjectURL(thumb)
    setThumb('')
    setFotoBlob(null)
    setForm(formVacio())
    setProgreso(0)
    setAvisos([])
    originalRef.current = null
    setPendiente(null)
    setPaso('elegir')
    loteUuid.liberar() // M-1: nueva devolución → nuevo lote de uuid_sync
  }

  /** Cancela el recorte: vuelve al paso desde donde se abrió. */
  function cancelarRecorte() {
    setPendiente(null)
    setPaso(origenRecorte === 'confirmar' ? 'confirmar' : 'elegir')
  }

  /** Aplica el recorte elegido (o la foto completa) y corre el OCR. */
  function usarFoto(f: File) {
    setPendiente(null)
    void procesar(f)
  }

  // ── GUARDADO (RECEPCIÓN de la devolución) ──
  async function guardar() {
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    if (!puedeCrear) {
      toast.error('No tienes permiso para registrar devoluciones')
      return
    }
    const filas = materialesRqAFilas(form.items)
    if (filas.length === 0) {
      toast.error('Agrega al menos un material con código y cantidad mayor a 0')
      return
    }
    // PROVEEDOR OBLIGATORIO para films (lámina/stretch) — misma regla que la
    // recepción de guías: la devolución vuelve al almacén y su ingreso en
    // Racks exigirá el proveedor real del film.
    const sinProveedor = faltanProveedor(filas)
    if (sinProveedor.length > 0) {
      toast.error('Selecciona el proveedor del material', {
        description: `Falta el proveedor (lámina/stretch) de: ${sinProveedor.join(', ')}`,
      })
      return
    }
    if (!form.fecha) {
      toast.error('Ingresa la fecha del RQ')
      return
    }
    setSaving(true)
    try {
      // La foto es OPCIONAL: si falla la subida, la devolución se registra igual.
      let fotoUrl = ''
      if (fotoBlob) {
        try {
          fotoUrl = await subirFotoGuia(fotoBlob, perfil.id)
        } catch (errFoto: unknown) {
          const msg = mensajeError(errFoto)
          toast.warning('La devolución se registrará SIN foto', { description: msg })
        }
      }
      // Contexto del encabezado del RQ → observaciones de CADA fila
      // (visible en el listado expandido, el Excel y Tránsito).
      const contexto = observacionesContextoRq(form)
      // El registro SIN paletas: 1 material = 1 fila (la requisición no trae
      // división); los rótulos salen 1:1 con SU QR por fila.
      const filasGuardar = expandirEnFilas(filas)
      // M-1: lote uuid_sync estable para esta alta (reintentos idempotentes).
      const uuids = loteUuid.paraFilas(filasGuardar.length)
      // M-2: crearRecepciones devuelve la identidad única de ESTA devolución
      // (guia_id compartido por todas sus filas). Los anti-duplicados ya vienen
      // DELIMITADOS a la pestaña devoluciones dentro de crearRecepciones.
      const guiaId = await crearRecepciones(
        filasGuardar.map((f, i) => ({
          fecha: form.fecha,
          tipoDocumento: TIPO_DOC_DEVOLUCION,
          numeroDocumento: form.numeroRq.trim(),
          empresaOrigen: form.solicitante.trim(),
          proveedor: f.proveedor,
          codigo: f.codigo,
          descripcion: f.descripcion,
          cantidad: f.cantidadNum,
          unidadMedida: f.unidad,
          lote: f.lote,
          fechaProduccion: f.fechaProduccion,
          fechaVencimiento: f.fechaVencimiento,
          placa: '', // la requisición de devolución NO trae vehículo
          fotoUrl,
          observaciones: [contexto, f.paleta].filter(Boolean).join(' · '),
          uuidSync: uuids[i],
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo },
        { tipoRecepcion: TIPO_RECEPCION.DEVOLUCION }
      )
      loteUuid.liberar()
      toast.success(
        `Devolución registrada: ${filas.length} material(es) · ${filasGuardar.length} fila(s)`
      )
      // Banner "recién registrada" (mismo contrato que la vía de guías).
      onRegistrado({
        guiaId,
        fecha: form.fecha,
        tipoDocumento: TIPO_DOC_DEVOLUCION,
        numeroDocumento: form.numeroRq.trim(),
        empresaOrigen: form.solicitante.trim(),
        placa: '',
        articulos: filas.length,
        filas: filasGuardar.length,
        cantidadTotal: filasGuardar.reduce((s, f) => s + f.cantidadNum, 0),
        usuarioNombre: perfil.nombre,
        tipoRecepcion: TIPO_RECEPCION.DEVOLUCION,
      })
      // Rótulos con QR ÚNICO POR FILA: re-lee la devolución recién insertada
      // para que cada rótulo lleve el recepcionId de SU fila (QR = fila
      // exacta); respaldo = filas recién mapeadas (identidad de guía legada).
      let rotulos: RotuloAImprimir[] = []
      try {
        const filasGuardadas = await listarRecepcionesPorDocumento({
          guiaId,
          tipoDocumento: TIPO_DOC_DEVOLUCION,
          numeroDocumento: form.numeroRq.trim(),
          fecha: form.fecha,
          proveedor: form.solicitante.trim(),
        })
        rotulos = rotulosDesdeFilas(filasGuardadas)
      } catch {
        // Sin re-lectura el modal sigue funcionando con identidad de guía.
      }
      if (rotulos.length === 0) {
        // Respaldo (re-lectura fallida): rótulos sin identidad de fila —
        // misma forma que filasARotulos para las filas recién guardadas.
        rotulos = filasGuardar
          .filter((f) => f.codigo)
          .map((f) => ({
            codigo: f.codigo,
            descripcion: f.descripcion,
            cantidad: f.cantidad,
            unidad: f.unidad,
            lote: f.lote,
            fechaProduccion: f.fechaProduccion,
            fechaVencimiento: f.fechaVencimiento,
            paleta: f.paleta || undefined,
            copias: 1,
          }))
      }
      if (rotulos.length > 0) {
        setGuardados({
          rotulos,
          encabezado: {
            fecha: form.fecha,
            numeroDocumento: form.numeroRq.trim(),
            empresaOrigen: form.solicitante.trim(),
            placa: '',
            registradoPor: perfil.nombre,
            // Ficha del modal: "Devolución RQ 0000192967".
            tipoDocumento: TIPO_DOC_DEVOLUCION,
          },
          ref: {
            guiaId,
            tipoDocumento: TIPO_DOC_DEVOLUCION,
            numeroDocumento: form.numeroRq.trim(),
            fecha: form.fecha,
            proveedor: form.solicitante.trim(),
          },
          nota: `Devolución guardada: ${filasGuardar.length} fila(s) en la base de datos. Pega cada rótulo en SU artículo de devolución — el QR identifica la fila exacta al escanear.`,
        })
        setRotulosOpen(true)
      } else {
        toast.info('Devolución guardada sin rótulos', {
          description: 'Ningún material registrado tiene código; completa el código para poder imprimir etiquetas.',
        })
      }
      reiniciar()
    } catch (err: unknown) {
      // Códigos controlados (errores.ts): la cancelación anti-duplicado y el
      // reintento bloqueado NO son errores — son decisiones/avisos.
      const codigo = codigoControladoDe(err)
      const message = mensajeError(err)
      if (codigo === ERR_CANCELADO) {
        toast.info('Registro cancelado', { description: message })
      } else if (codigo === ERR_DUPLICADO) {
        toast.warning('No se registró nada nuevo', { description: message })
      } else {
        toast.error('No se pudo registrar la devolución', { description: message })
      }
    } finally {
      setSaving(false)
    }
  }

  // ────────────────────────────────────────────────────────────
  // Modales (rótulos y recorte) visibles en cualquier paso.
  // ────────────────────────────────────────────────────────────
  const dialogRotulos = (
    <ImprimirRotulosDialog
      open={rotulosOpen}
      onOpenChange={cerrarRotulos}
      rotulos={guardados ? guardados.rotulos : []}
      encabezado={
        guardados
          ? guardados.encabezado
          : { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '', registradoPor: '' }
      }
      nota={guardados?.nota}
      // M-2 + auto-estatus: identidad EXACTA de la devolución guardada; al
      // imprimir pasa a 'Recepcionado' (solo sube desde Pendiente).
      refDocumento={guardados?.ref}
      onImpreso={async () => {
        if (!guardados?.ref) return
        const marcadas = await marcarGuiaRecepcionada(guardados.ref)
        if (marcadas > 0) {
          toast.success('Devolución marcada como Recepcionada automáticamente', {
            description: `${marcadas} fila(s) actualizadas al imprimir los rótulos.`,
          })
        }
      }}
    />
  )

  const dialogRecorte = (
    <RecortarImagenDialog
      open={paso === 'recortar' && pendiente !== null}
      archivo={pendiente}
      origen={origenRecorte}
      onCancelar={cancelarRecorte}
      onAplicar={usarFoto}
      onUsarCompleto={() => {
        if (pendiente) usarFoto(pendiente)
      }}
    />
  )

  // ═══════════════════════════════════════════════════════════
  // PASO 1: elegir foto
  // ═══════════════════════════════════════════════════════════
  if (paso === 'elegir') {
    return (
      <>
        <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Undo2 className="h-4 w-4 text-sky-600" />
            <h3 className="text-sm font-bold text-sky-900">Registrar devolución con foto del RQ</h3>
          </div>
          <p className="text-xs text-slate-500 mb-2">
            La devolución de línea NO es una guía: es un <b>RQ (Requisición de Devolución de
            Material)</b>. Toma una foto al RQ y la app extrae el Nº, la orden de producción, el
            producto, la línea, el solicitante y TODOS los materiales (código, descripción del
            catálogo, cantidad y unidad) — <b>la misma extracción de datos que Atención</b>.
          </p>
          <p className="text-[11px] text-sky-700 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-1.5 mb-4">
            Consejo: foto <b>directa y nítida</b>, documento completo y sin sombras. Después de
            tomar la foto podrás <b>recortarla</b> para dejar solo el documento. La tabla se
            escanea con zoom y los códigos se verifican contra el catálogo; lo que no se lea bien
            se marca para revisar.
          </p>
          <input
            ref={inputCamaraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              alElegirFoto(e.target.files?.[0], 'inicio')
              e.currentTarget.value = ''
            }}
          />
          {/* La galería SIN `capture`: con capture el celular forzaba la cámara. */}
          <input
            ref={inputGaleriaRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              alElegirFoto(e.target.files?.[0], 'inicio')
              e.currentTarget.value = ''
            }}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              onClick={() => inputCamaraRef.current?.click()}
              className="h-11 gap-2 bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-600 hover:to-indigo-700"
            >
              <Camera className="h-4 w-4" /> Tomar foto del RQ
            </Button>
            <Button
              variant="outline"
              onClick={() => inputGaleriaRef.current?.click()}
              className="h-11 gap-2"
            >
              <ImageIcon className="h-4 w-4" /> Elegir de la galería
            </Button>
          </div>
          <Button
            variant="ghost"
            onClick={() => setPaso('confirmar')}
            className="mt-2 w-full gap-2 text-sky-700 hover:bg-sky-100/60"
          >
            <ClipboardList className="h-4 w-4" /> Registrar sin foto (manual)
          </Button>
        </div>
        {dialogRotulos}
        {dialogRecorte}
      </>
    )
  }

  // ═══════════════════════════════════════════════════════════
  // PASO 1b: recorte de la foto (el diálogo lleva la UI)
  // ═══════════════════════════════════════════════════════════
  if (paso === 'recortar') {
    return (
      <>
        <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-sky-900">
            <Crop className="h-4 w-4" /> Encuadra el RQ para escanear solo esa parte…
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Arrastra y ajusta el recorte en la ventana abierta. Allí puedes cancelar, usar la foto
            completa o aplicar el recorte.
          </p>
        </div>
        {dialogRotulos}
        {dialogRecorte}
      </>
    )
  }

  // ═══════════════════════════════════════════════════════════
  // PASO 2: procesando (OCR compartido con Atención)
  // ═══════════════════════════════════════════════════════════
  if (paso === 'procesando') {
    return (
      <>
        <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <ScanLine className="h-5 w-5 text-sky-600 animate-pulse" />
            <p className="text-sm font-semibold text-sky-900">{etapa || 'Procesando…'}</p>
          </div>
          <Progress value={progreso} className="h-2" />
          <Button variant="outline" size="sm" onClick={reiniciar} className="gap-2">
            <RotateCcw className="h-3.5 w-3.5" /> Cancelar
          </Button>
        </div>
        {dialogRotulos}
      </>
    )
  }

  // ═══════════════════════════════════════════════════════════
  // PASO 3: confirmar (encabezado del RQ + materiales)
  // ═══════════════════════════════════════════════════════════
  const fechaCorta = 'w-[130px] min-[430px]:w-auto'
  const sugerencias = menuIdx != null ? sugerenciasPara(form.items[menuIdx]?.codigo ?? '') : []
  const contextoPreview = observacionesContextoRq(form)
  return (
    <>
      <div className="rounded-xl border border-sky-100 bg-white p-4 space-y-4">
        {!thumb ? (
          <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5 text-sky-600" /> Registro manual — sin foto adjunta
            </p>
            <Button variant="ghost" size="sm" onClick={reiniciar} className="h-7 text-xs gap-1">
              <Camera className="h-3.5 w-3.5" /> Tomar foto
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src={thumb}
              alt="Foto del RQ de devolución"
              className="h-16 w-16 rounded-lg border object-cover shrink-0"
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                if (!originalRef.current) return
                setPendiente(originalRef.current)
                setOrigenRecorte('confirmar')
                setPaso('recortar')
              }}
            >
              <Crop className="h-3.5 w-3.5" /> Reajustar recorte
            </Button>
          </div>
        )}

        {/* AVISOS DE RIGOR NUMÉRICO (Task 23): discrepancias entre lecturas
            — el usuario las verifica ANTES de registrar. */}
        {avisos.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-1">
            <p className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
              <TriangleAlert className="h-3.5 w-3.5" /> Verifica estos datos con el documento físico
            </p>
            <ul className="list-disc pl-6 text-[11px] text-amber-800 space-y-0.5">
              {avisos.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Encabezado del RQ (mismos campos que Atención) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Nº de RQ</Label>
            <Input
              inputMode="numeric"
              placeholder="0000192967"
              value={form.numeroRq}
              onChange={(e) => set('numeroRq', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Orden de producción</Label>
            <Input
              inputMode="numeric"
              placeholder="2026008387"
              value={form.ordenProduccion}
              onChange={(e) => set('ordenProduccion', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Fecha</Label>
            <Input
              type="date"
              className={fechaCorta}
              value={form.fecha}
              onChange={(e) => set('fecha', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Código del producto</Label>
            <Input
              inputMode="numeric"
              placeholder="3000508"
              value={form.productoCodigo}
              onChange={(e) => set('productoCodigo', e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
            <Label className="text-xs">Descripción del producto</Label>
            <Input
              placeholder="JARABE TERMINADO PULP DURAZNO…"
              value={form.productoDescripcion}
              onChange={(e) => set('productoDescripcion', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Línea de producción</Label>
            <Input
              list="lineas-devolucion-sugeridas"
              placeholder="L1, L2, JARABES…"
              title="Campo «Línea:» de la requisición — se llena con el OCR y queda editable"
              maxLength={80}
              value={form.linea}
              onChange={(e) => set('linea', e.target.value)}
            />
            <datalist id="lineas-devolucion-sugeridas">
              <option value="L1" />
              <option value="L2" />
              <option value="L3" />
              <option value="L4" />
              <option value="L5" />
              <option value="JARABES" />
            </datalist>
          </div>
          <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
            <Label className="text-xs">Solicitante (quien devuelve)</Label>
            <Input
              placeholder="Quien solicita la devolución"
              value={form.solicitante}
              onChange={(e) => set('solicitante', e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Notas (opcional)</Label>
            <Textarea
              rows={1}
              placeholder="Observaciones de la devolución…"
              value={form.notas}
              onChange={(e) => set('notas', e.target.value)}
            />
          </div>
        </div>

        {/* Vista previa del contexto que acompaña a cada fila registrada */}
        {contextoPreview && (
          <p className="text-[11px] text-slate-500">
            <span className="font-semibold text-slate-600">Contexto del RQ (va a observaciones):</span>{' '}
            {contextoPreview}
          </p>
        )}

        {/* Materiales */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-slate-700">
              Materiales que regresan ({form.items.length})
            </h4>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 h-8"
              onClick={() => setForm((prev) => ({ ...prev, items: [...prev.items, itemVacioDevo()] }))}
            >
              <Plus className="h-3.5 w-3.5" /> Agregar material
            </Button>
          </div>
          <p className="text-[11px] text-slate-500">
            {catError
              ? 'Catálogo no disponible: escribe la descripción y la unidad a mano.'
              : catalogo.length > 0
                ? 'Catálogo listo: al colocar el código se jala la descripción y la unidad del catálogo.'
                : 'Cargando catálogo…'}
          </p>

          {/* Desktop: tabla */}
          <div className="hidden md:block rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 w-[110px]">Código</th>
                  <th className="px-3 py-2">Descripción</th>
                  <th className="px-3 py-2 w-[110px]">Cantidad</th>
                  <th className="px-3 py-2 w-[90px]">Unidad</th>
                  <th className="px-3 py-2 w-[44px]" />
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, idx) => (
                  <tr key={idx} className="border-t align-middle">
                    <td className="px-2 py-1.5">
                      <div className="relative">
                        <Input
                          className="h-8 font-mono"
                          inputMode="numeric"
                          autoComplete="off"
                          value={it.codigo}
                          onChange={(e) => onCodigo(idx, e.target.value)}
                          onFocus={() => {
                            if (it.codigo.trim()) {
                              setResaltado(0)
                              setMenuIdx(idx)
                            }
                          }}
                          onBlur={() => {
                            blurTimer.current = setTimeout(() => setMenuIdx(null), 130)
                          }}
                          onKeyDown={(e) => navMenu(e, idx, sugerencias)}
                        />
                        {menuIdx === idx && sugerencias.length > 0 && (
                          <div className="absolute z-30 top-full left-0 mt-0.5 w-full min-w-[240px] max-w-[300px] max-h-48 overflow-y-auto rounded-md border bg-white shadow-lg">
                            {sugerencias.map((c, si) => (
                              <button
                                key={`${c.codigo}-${si}`}
                                type="button"
                                className={`w-full text-left px-2.5 py-1.5 text-xs flex items-baseline gap-2 ${
                                  si === resaltado ? 'bg-amber-50' : 'bg-white'
                                } hover:bg-amber-50`}
                                onMouseDown={(e) => {
                                  e.preventDefault() // aplica antes del blur del input
                                  aplicarSugerencia(idx, c)
                                }}
                              >
                                <span className="font-bold text-slate-800 w-14 shrink-0">{c.codigo}</span>
                                <span className="truncate text-slate-500">{c.descripcion}</span>
                                {c.un && <span className="ml-auto text-[9px] text-slate-400 shrink-0">{c.un}</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8"
                          placeholder={it.enCatalogo ? '' : 'Se autocompleta al escribir el código'}
                          value={it.descripcion}
                          onChange={(e) =>
                            setItem(idx, { descripcion: e.target.value, descripcionManual: Boolean(e.target.value.trim()) })
                          }
                        />
                        {it.enCatalogo && !it.matchPorDescripcion ? (
                          <span title="Del catálogo">
                            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                          </span>
                        ) : it.matchPorDescripcion && !it.revision ? (
                          <span title="Código adoptado por descripción — confírmalo">
                            <SearchCheck className="h-4 w-4 text-sky-500 shrink-0" />
                          </span>
                        ) : it.revision ? (
                          <span title="Fuera de catálogo — revisar">
                            <TriangleAlert className="h-4 w-4 text-amber-500 shrink-0" />
                          </span>
                        ) : it.codigo.trim() ? (
                          <span title="No está en catálogo">
                            <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
                          </span>
                        ) : null}
                      </div>
                      {/* Proveedor del film (misma regla que guías): los films
                          exigen su proveedor real — cada uno en SU artículo. */}
                      {requiereProveedor(it.descripcion) && (
                        <div className="mt-1">
                          <Select
                            value={it.proveedor || undefined}
                            onValueChange={(v) => setItem(idx, { proveedor: v })}
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="Proveedor del film" />
                            </SelectTrigger>
                            <SelectContent>
                              {PROVEEDORES_FILM.map((p) => (
                                <SelectItem key={p} value={p}>
                                  {p}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        className="h-8 text-right"
                        inputMode="decimal"
                        value={it.cantidad}
                        onChange={(e) => setItem(idx, { cantidad: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        className="h-8 uppercase"
                        value={it.unidad}
                        onChange={(e) =>
                          setItem(idx, { unidad: e.target.value.toUpperCase(), unidadManual: Boolean(e.target.value.trim()) })
                        }
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-rose-500 hover:text-rose-700"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            items: prev.items.length > 1 ? prev.items.filter((_, i) => i !== idx) : [itemVacioDevo()],
                          }))
                        }
                        title="Quitar material"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Móvil: tarjetas */}
          <div className="md:hidden space-y-2">
            {form.items.map((it, idx) => (
              <div key={idx} className="rounded-lg border p-2.5 space-y-2 bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Input
                      className="h-9 font-mono"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="Código"
                      value={it.codigo}
                      onChange={(e) => onCodigo(idx, e.target.value)}
                      onFocus={() => {
                        if (it.codigo.trim()) {
                          setResaltado(0)
                          setMenuIdx(idx)
                        }
                      }}
                      onBlur={() => {
                        blurTimer.current = setTimeout(() => setMenuIdx(null), 130)
                      }}
                      onKeyDown={(e) => navMenu(e, idx, sugerencias)}
                    />
                    {menuIdx === idx && sugerencias.length > 0 && (
                      <div className="absolute z-30 top-full left-0 mt-0.5 w-full min-w-[200px] max-h-48 overflow-y-auto rounded-md border bg-white shadow-lg">
                        {sugerencias.map((c, si) => (
                          <button
                            key={`${c.codigo}-${si}`}
                            type="button"
                            className={`w-full text-left px-2.5 py-1.5 text-xs flex items-baseline gap-2 ${
                              si === resaltado ? 'bg-amber-50' : 'bg-white'
                            } hover:bg-amber-50`}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              aplicarSugerencia(idx, c)
                            }}
                          >
                            <span className="font-bold text-slate-800 w-14 shrink-0">{c.codigo}</span>
                            <span className="truncate text-slate-500">{c.descripcion}</span>
                            {c.un && <span className="ml-auto text-[9px] text-slate-400 shrink-0">{c.un}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {it.enCatalogo && !it.matchPorDescripcion ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  ) : it.matchPorDescripcion && !it.revision ? (
                    <SearchCheck className="h-4 w-4 text-sky-500 shrink-0" />
                  ) : it.revision ? (
                    <TriangleAlert className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : it.codigo.trim() ? (
                    <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-rose-500"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        items: prev.items.length > 1 ? prev.items.filter((_, i) => i !== idx) : [itemVacioDevo()],
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {(it.matchPorDescripcion || it.revision || (!it.enCatalogo && it.codigo.trim())) && (
                  <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                    {it.matchPorDescripcion && !it.revision ? (
                      <span className="inline-flex items-center gap-1 text-sky-700">
                        <SearchCheck className="h-3 w-3" /> código por descripción — confírmalo
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700">
                        <TriangleAlert className="h-3 w-3" />{' '}
                        {it.revision ? 'fuera de catálogo — corrige el código' : 'no está en catálogo'}
                      </span>
                    )}
                  </p>
                )}
                <Input
                  className="h-9"
                  placeholder={it.enCatalogo ? 'Descripción' : 'Descripción (se autocompleta con el código)'}
                  value={it.descripcion}
                  onChange={(e) =>
                    setItem(idx, { descripcion: e.target.value, descripcionManual: Boolean(e.target.value.trim()) })
                  }
                />
                {requiereProveedor(it.descripcion) && (
                  <Select
                    value={it.proveedor || undefined}
                    onValueChange={(v) => setItem(idx, { proveedor: v })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Proveedor del film (lámina/stretch)" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVEEDORES_FILM.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className="flex gap-2">
                  <Input
                    className="h-9 flex-1 text-right"
                    inputMode="decimal"
                    placeholder="Cantidad"
                    value={it.cantidad}
                    onChange={(e) => setItem(idx, { cantidad: e.target.value })}
                  />
                  <Input
                    className="h-9 w-20 uppercase"
                    placeholder="UN"
                    value={it.unidad}
                    onChange={(e) =>
                      setItem(idx, { unidad: e.target.value.toUpperCase(), unidadManual: Boolean(e.target.value.trim()) })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Acciones */}
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <Button variant="outline" onClick={reiniciar} disabled={saving} className="gap-2 h-10">
            <RotateCcw className="h-4 w-4" /> Otra foto
          </Button>
          <Button
            onClick={guardar}
            disabled={saving || !puedeCrear}
            title={!puedeCrear ? 'No tienes permiso para registrar devoluciones' : undefined}
            className="gap-2 h-10 bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-600 hover:to-indigo-700"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
            Registrar devolución
          </Button>
        </div>

        {form.items.some((i) => i.revision) && (
          <p className="text-[11px] text-amber-600 flex items-center gap-1.5">
            <Badge variant="outline" className="border-amber-300 text-amber-700 text-[10px]">
              revisar
            </Badge>
            Hay materiales fuera del catálogo o con datos dudosos — corrígelos antes de registrar.
          </p>
        )}
      </div>
      {dialogRotulos}
    </>
  )
}

