'use client'

/**
 * RACKLY — Recepción · Opción "Con foto de guía".
 *
 * Flujo:
 *   1. Usuario toma foto a la guía (cámara móvil o archivo) — la galería usa
 *      su PROPIO input sin `capture` (antes forzaba la cámara en el celular).
 *   1b. RECORTE: la foto pasa primero por el diálogo de recorte (marco
 *      móvil con esquinas — recorte-marco.ts); solo la parte seleccionada
 *      de la guía se escanea y se guarda.
 *      Se puede usar la foto completa o reajustar el recorte desde la
 *      confirmación (originalRef conserva la fuente original).
 *   2. Se reduce la imagen (2800px, tablas largas con letra pequeña),
 *      corre OCR (tesseract.js, idioma spa) y el parser `extraerDatosGuia`
 *      recopila: nº guía, placa, empresa de origen y TODOS los códigos de artículo
 *      detectados (cruzados contra el catálogo → descripción y unidad
 *      automáticas). Si no encontró ninguno, activa rescate fuzzy.
 *   3. Formulario de CONFIRMACIÓN con la LISTA COMPLETA de artículos
 *      (la guía puede traer 20+): todo editable, cantidad ajustable por
 *      artículo, lote y fechas manuales (con atajo "aplicar a todos").
 *   4. Al registrar: foto liviana → Storage (bucket recepcion-guias) y
 *      UNA FILA POR ARTÍCULO en recepcion_registros compartiendo el
 *      encabezado (guía, placa, empresa de origen, foto).
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import type { PSM } from 'tesseract.js'
import { fetchCatalogo, getCachedCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import {
  extraerDatosGuiaDeTextos,
  avisoNumerosDebiles,
  extraerPalabras,
  extraerAnclasTabla,
  dividirFranjaEnBandas,
  fusionarDatos,
  mejorarImagenOCR,
  MARGEN_OCR,
  puntuarExtraccion,
  recortarFranjaTabla,
  reducirImagen,
  type DatosGuia,
} from '@/lib/rackly/guia-ocr'
import { avisosDePaletas, expandirEnFilas, faltanProveedor } from '@/lib/rackly/recepcion-filas'
import { crearRecepciones, listarRecepcionesPorDocumento, marcarGuiaRecepcionada, subirFotoGuia, TIPOS_DOCUMENTO_RECEPCION, TIPO_RECEPCION } from '@/lib/rackly/modulos'
import { puede } from '@/lib/rackly/permisos'
import { useLoteUuidSync } from '@/lib/rackly/recepcion-idempotencia'
import {
  RecepcionItemsEditor,
  itemVacio,
  itemsValidos,
  type ItemRecepcion,
} from '@/components/rackly/recepcion/RecepcionItemsEditor'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
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
  PackageCheck,
  ImageIcon,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { mensajeError, codigoControladoDe, ERR_CANCELADO, ERR_DUPLICADO } from '@/lib/rackly/errores'

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

type Paso = 'elegir' | 'recortar' | 'procesando' | 'confirmar'

/** Estado del formulario de confirmación: encabezado + lista de artículos. */
type FormFoto = {
  numeroGuia: string
  placa: string
  /** Empresa que ENVÍA la guía (el OCR la lee del encabezado de la foto).
   *  El PROVEEDOR del producto se elige por artículo (ItemRecepcion). */
  empresaOrigen: string
  fecha: string
  tipoDocumento: string
  observaciones: string
  items: ItemRecepcion[]
}

/** Estado inicial FRESCO: fecha del día (FORM_VACIO congelaba la fecha de la
 *  carga de la página) y arrays propios (sin instancias compartidas). */
function formVacio(): FormFoto {
  return {
    numeroGuia: '',
    placa: '',
    empresaOrigen: '',
    fecha: hoyISO(),
    tipoDocumento: 'Guia',
    observaciones: '',
    items: [itemVacio()],
  }
}

/** ItemGuia (OCR) → ItemRecepcion (editor). */
function itemDesdeOcr(item: DatosGuia['items'][number]): ItemRecepcion {
  return {
    codigo: item.codigo,
    descripcion: item.descripcion,
    cantidad: item.cantidad,
    unidad: item.unidad,
    lote: '',
    fechaProduccion: '',
    fechaVencimiento: '',
    proveedor: '',
    enCatalogo: item.enCatalogo,
    matchPorDescripcion: Boolean(item.matchPorDescripcion),
    revision: Boolean(item.revision),
    descripcionManual: false,
    unidadManual: false,
  }
}

/** Umbral de calidad: con estos 3 pilares detectados no se re-procesa. */
function extraccionSuficiente(d: DatosGuia): boolean {
  return d.items.length > 0 && Boolean(d.numeroGuia) && Boolean(d.placa)
}
void extraccionSuficiente

/**
 * Informe del documento REGISTRADO que el módulo necesita para fijarlo en
 * pantalla (banner "recién registrada"): con guiaId, la lista/impresión
 * pueden operarlo aunque el orden por fecha lo baje de la primera página.
 */
export type GuiaRegistradaInfo = {
  guiaId: string
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía la guía (encabezado del documento). */
  empresaOrigen: string
  placa: string
  articulos: number
  filas: number
  cantidadTotal: number
  usuarioNombre: string
  /** Pestaña de origen ('guia' | 'devolucion'): el módulo solo fija el
   *  banner en la pestaña que corresponde. */
  tipoRecepcion?: string
}

/**
 * Vía foto (OCR) del módulo Recepción para GUÍAS DE REMISIÓN (guia-ocr.ts).
 *
 * Las DEVOLUCIONES de línea tienen SU PROPIA vía foto (DevolucionFotoForm):
 * su documento NO es una guía sino un RQ (Requisición de Devolución de
 * Material) y se extrae con el pipeline compartido de Atención
 * (rq-ocr-runner.ts) — extracción idéntica entre Atención y devoluciones
 * (pedido del usuario 2026-10-31).
 */
export function GuiaFotoForm({
  onRegistrado,
}: {
  onRegistrado: (info: GuiaRegistradaInfo) => void
}) {
  const { perfil } = useAuth()
  // Cuadro de permisos: registrar guías = recepcion.crear (la BD lo aplica
  // con la política RESTRICTIVE; aquí es feedback temprano — la vía manual
  // ya lo exigía y la vía foto quedó fuera).
  const puedeCrear = puede(perfil, 'recepcion.crear')
  const [paso, setPaso] = useState<Paso>('elegir')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [progreso, setProgreso] = useState(0)
  const [etapa, setEtapa] = useState('')
  const [thumb, setThumb] = useState<string>('')
  const [fotoBlob, setFotoBlob] = useState<Blob | null>(null)
  const [form, setForm] = useState<FormFoto>(() => formVacio())
  const [saving, setSaving] = useState(false)

  /**
   * Lote de uuid_sync del registro en curso (M-1): estable entre reintentos
   * del mismo formulario; liberado tras un guardado exitoso o al reiniciar.
   */
  const loteUuid = useLoteUuidSync()
  // Modal de impresión de rótulos (Zebra ZT411). Se abre SOLO tras REGISTRAR
  // (la carga ya validada y guardada en la BD): automáticamente al guardar,
  // con la instantánea exacta de lo registrado (`guardados`). Nunca con
  // datos sin registrar.
  const [rotulosOpen, setRotulosOpen] = useState(false)
  const [guardados, setGuardados] = useState<{
    rotulos: RotuloAImprimir[]
    encabezado: EncabezadoRotulo
    /** M-2: identidad de la guía guardada → al imprimir se marca 'Recepcionado'. */
    ref?: { guiaId: string; tipoDocumento: string; numeroDocumento: string; fecha: string; proveedor: string }
    nota?: string
  } | null>(null)

  /** Cierra el modal y libera la instantánea post-guardado. */
  function cerrarRotulos(open: boolean) {
    setRotulosOpen(open)
    if (!open) setGuardados(null)
  }
  const inputCamaraRef = useRef<HTMLInputElement>(null)
  const inputGaleriaRef = useRef<HTMLInputElement>(null)

  // ── RECORTE previo al OCR ──
  // La foto elegida pasa primero por el recorte (solo la parte de la guía
  // se escanea y se guarda). `pendiente` es la foto original esperando
  // recorte; `originalRef` conserva la fuente ORIGINAL para poder
  // re-recortar desde la confirmación sin volver a tomar la foto.
  const [pendiente, setPendiente] = useState<File | null>(null)
  const [origenRecorte, setOrigenRecorte] = useState<OrigenRecorte>('inicio')
  const originalRef = useRef<File | null>(null)

  useEffect(() => {
    fetchCatalogo().then((c) => setCatalogo(c))
  }, [])

  function set<K extends keyof FormFoto>(k: K, v: FormFoto[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  /** Carga (o recarga) el catálogo; false si sigue vacío. */
  async function asegurarCatalogo(): Promise<boolean> {
    if (catalogo.length > 0) return true
    const c = await fetchCatalogo()
    setCatalogo(c)
    return c.length > 0
  }

  /** Aplica la mejor extracción al formulario + resumen de lo detectado. */
  function procesarExtraccion(datos: DatosGuia, avisosOCR: string[] = []) {
    // RIGOR NUMÉRICO (Task 23): los avisos llegan de 2 fuentes — la
    // fusión (mismo artículo con cantidades distintas entre pases, ahora
    // unificado a revisión) y la confianza de Tesseract (números leídos
    // por debajo del umbral — ahí viven las confusiones 4↔9). Se muestran
    // con toast ANTES del resumen: la guía alimenta las paletas y los
    // rótulos QR, un dígito errado se propaga a toda la cadena.
    if (avisosOCR.length > 0) {
      toast.warning(
        `${avisosOCR.length} aviso(s) de lectura — verifica antes de guardar`,
        { description: avisosOCR.slice(0, 3).join(' · ') }
      )
    }
    const itemsOcr = datos.items.map(itemDesdeOcr)
    setForm({
      ...formVacio(),
      numeroGuia: datos.numeroGuia,
      placa: datos.placa,
      // El OCR lee del encabezado de la guía física a la EMPRESA que envía
      // (antes se etiquetaba "proveedor" — separación 2026-10-22).
      empresaOrigen: datos.proveedor,
      items: itemsOcr.length > 0 ? itemsOcr : [itemVacio()],
    })

    if (!datos.numeroGuia && itemsOcr.length === 0) {
      toast.warning('No se detectaron datos automáticamente', {
        description: 'Completa los datos manualmente en el siguiente paso.',
      })
      return
    }

    const faltantes: string[] = []
    if (!datos.numeroGuia) faltantes.push('nº guía')
    if (!datos.placa) faltantes.push('placa')
    const enCat = itemsOcr.filter((i) => i.enCatalogo).length
    const fueraCat = itemsOcr.length - enCat
    const porDesc = itemsOcr.filter((i) => i.matchPorDescripcion).length
    const rev = itemsOcr.filter((i) => i.revision).length
    toast.success(
      itemsOcr.length > 0
        ? `Se detectaron ${itemsOcr.length} artículo(s)${enCat > 0 ? ` · ${enCat} en catálogo` : ''}`
        : 'Datos del documento recopilados',
      {
        description:
          [
            datos.numeroGuia ? `guía ${datos.numeroGuia}` : '',
            datos.placa ? `placa ${datos.placa}` : '',
          ]
            .filter(Boolean)
            .join(' · ') +
          (porDesc > 0 ? ` · ${porDesc} por descripción` : '') +
          (rev > 0 ? ` · ${rev} a revisar` : '') +
          (fueraCat > 0 ? ` · ${fueraCat} sin match en catálogo` : '') +
          (faltantes.length ? `. Faltan: ${faltantes.join(', ')} (se completan a mano).` : ''),
      }
    )
  }

  /** Foto elegida (cámara o galería): abre el recorte ANTES de procesar. */
  function alElegirFoto(f: File, origen: OrigenRecorte) {
    setPendiente(f)
    setOrigenRecorte(origen)
    setPaso('recortar')
  }

  async function procesar(archivo: File) {
    setPaso('procesando')
    setProgreso(0)
    setEtapa('Preparando imagen…')
    try {
      // Si un intento anterior dejó thumbnail, liberarlo (fuga de objectURL).
      if (thumb) {
        URL.revokeObjectURL(thumb)
        setThumb('')
      }
      setEtapa('Preparando imagen (contraste)…')
      // Fuente ORIGINAL conservada para "Recortar foto" desde la
      // confirmación (re-encuadrar y re-escanear sin volver a fotografiar).
      // SOLO se fija la PRIMERA vez: si `archivo` ya ES un recorte
      // (re-escaneo tras "Aplicar recorte"), el original auténtico se
      // conserva — antes el recorte PISABA el original y "Reajustar el
      // recorte" solo permitía ENCOGER más (la zona perdida del primer
      // encuadre quedaba irrecuperable) y cada re-escaneo re-comprimía el
      // JPEG degradándolo. `reiniciar()` (Otra foto) sí lo limpia.
      if (!originalRef.current) originalRef.current = archivo
      // Preprocesado: gris + contraste → mejora la lectura de la tabla
      const imagen = await mejorarImagenOCR(archivo, 2800)
      const liviana = await reducirImagen(archivo, 1200, 0.8)
      setFotoBlob(liviana)
      setThumb(URL.createObjectURL(liviana))

      setEtapa('Verificando catálogo…')
      const catOk = await asegurarCatalogo()
      if (!catOk) {
        toast.warning('Catálogo no disponible', {
          description:
            'Los códigos no se podrán reconocer automáticamente; el app abrirá el formulario para completarlos a mano.',
        })
      }

      setEtapa('Leyendo la guía (OCR español)…')
      const { createWorker, PSM } = await import('tesseract.js')
      const worker = await createWorker('spa', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setProgreso(Math.round(m.progress * 100))
            setEtapa(`Reconociendo texto… ${Math.round(m.progress * 100)}%`)
          }
        },
      })
      // DPI fijo + espacios entre palabras: sin `user_defined_dpi` Tesseract
      // ESTIMA la resolución ("Estimating resolution as 143") y re-escala
      // regiones pequeñas hasta fallar ("Image too small to scale!!" /
      // "Line cannot be recognized!!"). Con 300 dpi (nuestra imagen ya viene
      // ampliada a 2800px) lee directo y sin warnings. El espaciado
      // inter-palabra conserva las columnas de la tabla para el parser.
      await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })
      const catalogoParaOCR = catOk ? getCachedCatalogo() : []
      async function ocrData(psm: PSM, con: Blob, conBloques = false) {
        await worker.setParameters({ tessedit_pageseg_mode: psm })
        const { data } = await worker.recognize(con, {}, conBloques ? { blocks: true } : {})
        return data
      }
      async function ocrTexto(psm: PSM, con: Blob): Promise<string> {
        return (await ocrData(psm, con)).text ?? ''
      }

      try {
        // PASADA 1 — PSM 6 (bloque uniforme) sobre la página completa.
        // Con `blocks: true` además entrega las cajas de palabras para
        // localizar la tabla de artículos.
        const d1 = await ocrData(PSM.SINGLE_BLOCK, imagen, true)
        const texto1 = d1.text ?? ''

        // PASADA ZOOM — "cuadro por cuadro": con las anclas del formato
        // estándar (…TRANSPORTADOS / NOTAS…) se recorta la franja de la
        // tabla y se vuelve a leer escalada ×3, dividida en TRAMOS con
        // solape (una tabla larga a ×3 entera era una imagen enorme y el
        // OCR perdía filas enteras al final). Es lo que rescata los códigos
        // de letra pequeña (validado con la guía real AJER).
        let textoTabla: string | null = null
        const palabras1 = extraerPalabras(d1)
        const anclas = extraerAnclasTabla(palabras1)
        if (anclas) {
          try {
            const bitmap = await createImageBitmap(archivo)
            // La imagen leída por el OCR viene de mejorarImagenOCR: escalada
            // a 2800 px y con MARGEN_OCR px de margen blanco por lado.
            // Coordenada original = (yOcr - MARGEN) / escala. Antes se
            // ignoraba el margen y el recorte quedaba corrido ~26 px hacia
            // abajo (podía comerse la primera fila de la tabla).
            const escala = 2800 / Math.max(bitmap.width, bitmap.height)
            bitmap.close?.()
            const aOriginal = (yOcr: number) => Math.max(0, (yOcr - MARGEN_OCR) / escala)
            const bandas = dividirFranjaEnBandas(aOriginal(anclas.yTop), aOriginal(anclas.yBot))
            const textos: string[] = []
            for (let bi = 0; bi < bandas.length; bi++) {
              setEtapa(
                bandas.length > 1
                  ? `Escaneando la tabla (zoom, parte ${bi + 1} de ${bandas.length})…`
                  : 'Escaneando la tabla de artículos (zoom)…'
              )
              try {
                const franja = await recortarFranjaTabla(archivo, bandas[bi].y0, bandas[bi].y1, 3)
                const t = await ocrTexto(PSM.SINGLE_BLOCK, franja)
                if (t.trim()) textos.push(t)
              } catch {
                // Un tramo fallido no aborta los demás (exhaustivo por diseño).
              }
            }
            textoTabla = textos.length > 0 ? textos.join('\n') : null
          } catch {
            textoTabla = null
          }
        }

        let datos = extraerDatosGuiaDeTextos(texto1, textoTabla, catalogoParaOCR)

        // PASADA 3 — SIEMPRE: releer la página completa con PSM 3 (layout
        // automático) y FUSIONAR (unión sin duplicados). Antes solo corría
        // si faltaban pilares y el ganador por puntos DESCARTABA las filas
        // que el otro pase sí había leído — esa era la fuente principal de
        // datos omitidos. El 2º pase cuesta segundos y rescata filas.
        // `avisosFusion` se IZA al nivel de la función del componente de
        // proceso: importa aunque la fusión no gane (las discrepancias de
        // cantidades entre pases avisan igual — votación Task 23).
        let avisosFusion: string[] = []
        {
          setEtapa('Revisando la lectura con un segundo pase…')
          const imagenBase = await reducirImagen(archivo, 2800, 0.9)
          const texto2 = await ocrTexto(PSM.AUTO, imagenBase)
          const datos2 = extraerDatosGuiaDeTextos(texto2, textoTabla, catalogoParaOCR)
          const fusion = fusionarDatos(datos, datos2)
          avisosFusion = fusion.avisos ?? []
          // La fusión gana si aporta algo (más artículos, guía o placa);
          // si el 2º pase no añadió nada, se queda la lectura original.
          if (
            fusion.items.length > datos.items.length ||
            (!datos.numeroGuia && fusion.numeroGuia) ||
            (!datos.placa && fusion.placa) ||
            (!datos.proveedor && fusion.proveedor)
          ) {
            datos = fusion
          } else if (puntuarExtraccion(datos2) > puntuarExtraccion(datos)) {
            // Sin aporte en cantidad pero mejor lectura cualitativa (más
            // en catálogo): gana el 2º pase para encabezados/items coherentes.
            datos = datos2
          }
        }

        // Avisos combinados (Task 23): discrepancias de la fusión 2 pases
        // + internos de la extracción ganadora + confianza baja por palabra.
        // Dedupe: la fusión ya arrastra los internos de la 1ª extracción.
        const avisosOCR = Array.from(
          new Set([
            ...avisosFusion,
            ...(datos.avisos ?? []),
            ...avisoNumerosDebiles(palabras1),
          ])
        )
        procesarExtraccion(datos, avisosOCR)
      } finally {
        await worker.terminate()
      }

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
    originalRef.current = null
    setPendiente(null)
    setPaso('elegir')
    loteUuid.liberar() // M-1: nueva guía → nuevo lote de uuid_sync
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

  // Al desmontar (cambiar a modo Manual o salir del módulo), liberar el
  // objectURL del thumbnail: el blob quedaba retenido hasta recargar la página
  useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb)
    }
  }, [thumb])

  async function guardar() {
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    // Cuadro de permisos: mismo guard que la vía manual (feedback temprano;
    // la BD lo aplica con la política RESTRICTIVE recepcion_crear_restr).
    if (!puedeCrear) {
      toast.error('No tienes permiso para registrar recepciones')
      return
    }
    const validos = itemsValidos(form.items)
    if (validos.length === 0) {
      toast.error('Agrega al menos un artículo con código y cantidad mayor a 0')
      return
    }
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    // PROVEEDOR OBLIGATORIO (igual que Racks y que la vía manual): los films
    // (lámina/stretch) exigen su proveedor por artículo.
    const sinProveedor = faltanProveedor(validos)
    if (sinProveedor.length > 0) {
      toast.error('Selecciona el proveedor del artículo', {
        description: `Falta el proveedor (lámina/stretch) de: ${sinProveedor.join(', ')}`,
      })
      return
    }
    setSaving(true)
    try {
      let fotoUrl = ''
      if (fotoBlob) {
        try {
          fotoUrl = await subirFotoGuia(fotoBlob, perfil.id)
        } catch {
          toast.warning('La foto no se pudo subir; el registro se guarda sin ella.')
        }
      }
      const fecha = form.fecha || hoyISO()
      // DIVIDIR: cada artículo dividido en N paletas se expande a N filas
      // (mismo código; cantidad propia; "Paleta i/N" en observaciones).
      const filas = expandirEnFilas(validos)
      // M-1: lote uuid_sync estable para esta alta (reintentos idempotentes).
      const uuids = loteUuid.paraFilas(filas.length)
      // Aviso POR ARTÍCULO dividido: la suma de sus paletas debería
      // cuadrar con el total de la guía (se permite guardar igual —
      // mermas/parciales — pero nunca en silencio). MISMA regla que la vía
      // manual: una sola implementación (avisosDePaletas).
      const avisos = avisosDePaletas(validos)
      if (avisos.length > 0) {
        toast.warning('Las paletas no suman el total del artículo', {
          // Mismo texto VERAZ que la vía manual (una paleta → total; varias →
          // lo digitado en las paletas).
          description: `${avisos[0]}. Con UNA sola paleta con cantidad se registra el total del artículo; con varias paletas, lo digitado en ellas.`,
        })
      }
      // M-2: crearRecepciones devuelve la identidad única de ESTA recepción
      // (guia_id compartido por todas sus filas).
      const guiaId = await crearRecepciones(
        filas.map((f, i) => ({
          fecha,
          tipoDocumento: form.tipoDocumento,
          numeroDocumento: form.numeroGuia,
          empresaOrigen: form.empresaOrigen,
          proveedor: f.proveedor,
          codigo: f.codigo,
          descripcion: f.descripcion,
          cantidad: f.cantidadNum,
          unidadMedida: f.unidad,
          lote: f.lote,
          fechaProduccion: f.fechaProduccion,
          fechaVencimiento: f.fechaVencimiento,
          placa: form.placa,
          fotoUrl,
          observaciones: [form.observaciones, f.paleta].filter(Boolean).join(' · '),
          uuidSync: uuids[i],
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo },
        // Pestaña de origen: este formulario SOLO registra guías (las
        // devoluciones tienen SU vía foto: DevolucionFotoForm).
        { tipoRecepcion: TIPO_RECEPCION.GUIA }
      )
      // Informe para el banner "recién registrada" ANTES de limpiar el form.
      const infoRegistrada: GuiaRegistradaInfo = {
        guiaId,
        fecha,
        tipoDocumento: form.tipoDocumento,
        numeroDocumento: form.numeroGuia,
        empresaOrigen: form.empresaOrigen,
        placa: form.placa,
        articulos: validos.length,
        filas: filas.length,
        cantidadTotal: filas.reduce((s, f) => s + f.cantidadNum, 0),
        usuarioNombre: perfil.nombre,
        tipoRecepcion: TIPO_RECEPCION.GUIA,
      }
      loteUuid.liberar()
      toast.success(`Recepción registrada con foto: ${validos.length} artículo(s) · ${filas.length} fila(s)`)
      // Instantánea de EXACTAMENTE lo guardado en la BD → el modal de rótulos
      // se abre solo, listo para digitar las etiquetas por artículo/paleta.
      // La impresión solo existe DESPUÉS de registrar (carga ya validada).
      // Si lo guardado no trae ningún código no hay rótulos que imprimir:
      // se avisa en vez de abrir un modal vacío.
      // QR ÚNICO POR RÓTULO: re-lee la guía recién insertada para que cada
      // rótulo lleve el recepcionId de SU fila (QR = paleta exacta);
      // respaldo = instantánea del editor (identidad de guía legada).
      let rotulos: RotuloAImprimir[] = []
      try {
        const filasGuardadas = await listarRecepcionesPorDocumento({
          guiaId,
          tipoDocumento: form.tipoDocumento,
          numeroDocumento: form.numeroGuia,
          fecha,
          proveedor: form.empresaOrigen,
        })
        rotulos = rotulosDesdeFilas(filasGuardadas)
      } catch {
        // Sin re-lectura el modal sigue funcionando con identidad de guía.
      }
      if (rotulos.length === 0) rotulos = filasARotulos(validos)
      if (rotulos.length > 0) {
        setGuardados({
          rotulos,
          encabezado: {
            fecha,
            numeroDocumento: form.numeroGuia,
            empresaOrigen: form.empresaOrigen,
            placa: form.placa,
            registradoPor: perfil.nombre,
            // La ficha del modal dice "Devolución X" en la pestaña de
            // devoluciones (EncabezadoRotulo.tipoDocumento, opcional).
            tipoDocumento: form.tipoDocumento,
          },
          ref: {
            guiaId,
            tipoDocumento: form.tipoDocumento,
            numeroDocumento: form.numeroGuia,
            fecha,
            proveedor: form.empresaOrigen,
          },
          nota: `Recepción guardada: ${filas.length} fila(s) en la base de datos. Digita cuántas etiquetas necesitas de cada rótulo e imprime todo de una vez.`,
        })
        setRotulosOpen(true)
      } else {
        toast.info('Recepción guardada sin rótulos', {
          description: 'Ningún artículo registrado tiene código; completa el código en la lista para poder imprimir etiquetas.',
        })
      }
      reiniciar()
      onRegistrado(infoRegistrada)
    } catch (err: unknown) {
      // Códigos controlados (errores.ts): cancelación anti-duplicado y
      // reintento bloqueado NO son errores (el branch viejo startsWith era
      // código muerto — el extractor ya había quitado el prefijo CODE|).
      const codigo = codigoControladoDe(err)
      const message = mensajeError(err)
      if (codigo === ERR_CANCELADO) {
        toast.info('Registro cancelado', { description: message })
      } else if (codigo === ERR_DUPLICADO) {
        toast.warning('No se registró nada nuevo', { description: message })
      } else {
        toast.error('No se pudo registrar', { description: message })
      }
    } finally {
      setSaving(false)
    }
  }

  // ────────────────────────────────────────────────────────────
  // Modal de rótulos: visible en CUALQUIER paso (tras guardar, el
  // formulario vuelve al paso 1 con el modal abierto encima).
  // Modal de recorte: se abre sobre el paso actual al elegir foto
  // (o al reajustar desde la confirmación).
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
      // M-2 + auto-estatus: identidad EXACTA de la guía guardada; al imprimir
      // pasa a 'Recepcionado' (solo sube desde Pendiente, nunca pisa Observado).
      refDocumento={guardados?.ref}
      onImpreso={async () => {
        if (!guardados?.ref) return
        const marcadas = await marcarGuiaRecepcionada(guardados.ref)
        if (marcadas > 0) {
          toast.success('Guía marcada como Recepcionada automáticamente', {
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

  // ────────────────────────────────────────────────────────────
  // PASO 1: elegir foto
  // ────────────────────────────────────────────────────────────
  if (paso === 'elegir') {
    return (
      <>
      <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Camera className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">Registrar con foto de guía</h3>
        </div>
        <p className="text-xs text-slate-500 mb-2">
          Toma una foto a la guía y el app recopila el número de guía, placa, empresa de origen y
          TODOS los artículos detectados (código, descripción del catálogo, cantidad y unidad). La
          fecha de producción, vencimiento y el lote se completan manualmente. Todo es editable
          antes de registrar.
        </p>
        <p className="text-[11px] text-sky-700 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-1.5 mb-4">
          Consejo: foto <b>directa y nítida</b>, guía completa y sin sombras. Las fotos reenviadas
          por WhatsApp pierden resolución. Después de tomar la foto podrás <b>recortarla</b> para
          dejar solo la guía (se escanea y se guarda solo esa parte). El app escanea la tabla con
          zoom y verifica los códigos contra el catálogo; lo que no se lea bien se marca para revisar.
        </p>
        <input
          ref={inputCamaraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) alElegirFoto(f, 'inicio')
            e.currentTarget.value = ''
          }}
        />
        {/* La galería SIN `capture`: con capture el celular forzaba la cámara
            también en este botón y no dejaba elegir de la galería. */}
        <input
          ref={inputGaleriaRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) alElegirFoto(f, 'inicio')
            e.currentTarget.value = ''
          }}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            onClick={() => inputCamaraRef.current?.click()}
            className="gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
          >
            <Camera className="h-4 w-4" /> Tomar foto a la guía
          </Button>
          <Button variant="outline" onClick={() => inputGaleriaRef.current?.click()} className="gap-2">
            <ImageIcon className="h-4 w-4" /> Elegir imagen de la galería
          </Button>
        </div>
      </div>
      {dialogRotulos}
      {dialogRecorte}
      </>
    )
  }

  // ────────────────────────────────────────────────────────────
  // PASO 1b: recorte de la foto (el diálogo lleva la UI; el panel
  // de fondo solo informa). Al aplicar se pasa al paso procesando.
  // ────────────────────────────────────────────────────────────
  if (paso === 'recortar') {
    return (
      <>
      <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
          <Crop className="h-4 w-4" /> Encuadra la guía para escanear solo esa parte…
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

  // ────────────────────────────────────────────────────────────
  // PASO 2: procesando (OCR)
  // ────────────────────────────────────────────────────────────
  if (paso === 'procesando') {
    return (
      <>
      <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
          <ScanLine className="h-4 w-4 animate-pulse" /> {etapa || 'Procesando…'}
        </div>
        <Progress value={progreso} className="h-2" />
        <p className="text-xs text-slate-400">Esto puede tardar unos segundos según la foto.</p>
      </div>
      {dialogRotulos}
      {dialogRecorte}
      </>
    )
  }

  // ────────────────────────────────────────────────────────────
  // PASO 3: confirmación (encabezado + lista de artículos)
  // ────────────────────────────────────────────────────────────
  const detectados = form.items.filter((i) => i.codigo.trim()).length
  return (
    <>
    <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">Confirmar datos de la guía</h3>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Reajustar el recorte sobre la foto ORIGINAL (sin volver a
              fotografiar): re-escanea con el nuevo encuadre. */}
          {originalRef.current && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPendiente(originalRef.current)
                setOrigenRecorte('confirmar')
                setPaso('recortar')
              }}
              className="gap-1.5 text-xs"
            >
              <Crop className="h-3.5 w-3.5" /> Recortar foto
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={reiniciar} className="gap-1.5 text-xs">
            <RotateCcw className="h-3.5 w-3.5" /> Otra foto
          </Button>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">
        {thumb && (
          <img
            src={thumb}
            alt="Foto de la guía"
            className="h-28 w-28 rounded-lg border object-cover shadow-sm"
          />
        )}
        <div className="flex-1 min-w-[220px] space-y-1.5">
          {form.numeroGuia ? (
            <p className="text-xs flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />{' '}
              Guía detectada: <b>{form.numeroGuia}</b>
            </p>
          ) : (
            <p className="text-xs flex items-center gap-1.5 text-amber-700">
              <XCircle className="h-3.5 w-3.5" /> Nº de guía no detectado — colócalo abajo
            </p>
          )}
          {form.placa ? (
            <p className="text-xs flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Placa detectada: <b>{form.placa}</b>
            </p>
          ) : (
            <p className="text-xs flex items-center gap-1.5 text-amber-700">
              <XCircle className="h-3.5 w-3.5" /> Placa no detectada — colócala abajo
            </p>
          )}
          <p className={`text-xs flex items-center gap-1.5 ${detectados > 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
            {detectados > 0 ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Artículos detectados: <b>{detectados}</b>
              </>
            ) : (
              <>
                <XCircle className="h-3.5 w-3.5" /> Sin códigos detectados — agrégalos abajo
              </>
            )}
          </p>
        </div>
      </div>

      {/* Encabezado del documento (compartido por todos los artículos) */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Nº de guía</Label>
          <Input value={form.numeroGuia} onChange={(e) => set('numeroGuia', e.target.value)} placeholder="T000-000000" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Placa</Label>
          <Input value={form.placa} onChange={(e) => set('placa', e.target.value.toUpperCase())} placeholder="ABC-123" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Empresa de Origen</Label>
          <Input value={form.empresaOrigen} onChange={(e) => set('empresaOrigen', e.target.value)} placeholder="Empresa que nos envía (ej: AJEPER S.A.)" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Fecha de recepción</Label>
          <Input type="date" value={form.fecha} onChange={(e) => set('fecha', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Tipo de documento</Label>
          <Select value={form.tipoDocumento} onValueChange={(v) => set('tipoDocumento', v)}>
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
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
          <Label className="text-xs">Observaciones</Label>
          <Textarea rows={1} value={form.observaciones} onChange={(e) => set('observaciones', e.target.value)} placeholder="Opcional" />
        </div>
      </div>

      {/* Artículos detectados por el OCR + agregados a mano */}
      <RecepcionItemsEditor
        items={form.items}
        onChange={(items) => set('items', items)}
      />

      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          onClick={guardar}
          disabled={saving || !puedeCrear}
          title={!puedeCrear ? 'No tienes permiso para registrar recepciones' : undefined}
          className="flex-1 gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
          Registrar recepción ({itemsValidos(form.items).length} artículo(s))
        </Button>
        {/* La impresión de rótulos NO va aquí: el modal se abre solo tras
            REGISTRAR, cuando la carga ya fue validada y guardada. */}
      </div>

      {/* Impresión de rótulos + recorte: renderizado compartido al final. */}
    </div>
    {dialogRotulos}
    {dialogRecorte}
    </>
  )
}
