'use client'

/**
 * RACKLY — Atención a Línea · Opción "Nuevo RAL" (Requerimiento al Almacén).
 *
 * Espejo de RqFotoForm, calibrado al formato ERP «Consulta Requerimiento
 * al Almacén» (RAL). Flujo (misma mecánica probada de la RQ):
 *   1. Foto (cámara o archivo) → RECORTE previo (RecortarImagenDialog
 *      reutilizado; sin duplicar lógica).
 *   2. OCR tesseract.js (spa): pase PSM 6 con bloques + pase PSM 3 de
 *      respaldo → parser `extraerDatosRalDeTexto` (ral-ocr.ts) → fusión.
 *      Zoom a la franja de la tabla si faltan materiales y al encabezado
 *      para el DOCUMENTO (rigor numérico). El RAL no maneja turno.
 *   3. Formulario de CONFIRMACIÓN: encabezado (Documento, Fecha,
 *      Transacción, Área Solicitante, Solicitante, Aprobado Por, Almacén,
 *      Línea, Notas) + materiales (Código, Artículo o Descripción, UND,
 *      Centro de Costos, Cantidad Pedida) editables con catálogo.
 *   4. Registrar: foto liviana → Storage (bucket atencion-rq, el mismo
 *      patrón de la RQ) y rals + ral_items vía RPC ral_crear_completa.
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import type { PSM } from 'tesseract.js'
import {
  buscarCatalogo,
  fetchCatalogo,
  getCachedCatalogo,
  searchCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import {
  avisoNumerosDebiles,
  dividirFranjaEnBandas,
  extraerPalabras,
  mejorarImagenOCR,
  MARGEN_OCR,
  recortarFranjaTabla,
  reducirImagen,
} from '@/lib/rackly/guia-ocr'
import {
  extraccionSuficienteRal,
  extraerDatosRalDeTexto,
  fusionarDatosRal,
  puntuarExtraccionRal,
  type DatosRal,
} from '@/lib/rackly/ral-ocr'
import { crearRal } from '@/lib/rackly/ral'
import { eliminarFotoRq, subirFotoRq } from '@/lib/rackly/rq-atencion'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'
import { aNumero, hoyISO } from '@/lib/rackly/formato'
import {
  RecortarImagenDialog,
  type OrigenRecorte,
} from '@/components/rackly/recepcion/RecortarImagenDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Camera,
  Crop,
  Loader2,
  ScanLine,
  RotateCcw,
  FilePlus2,
  Plus,
  Trash2,
  ImageIcon,
  CheckCircle2,
  XCircle,
  SearchCheck,
  TriangleAlert,
} from 'lucide-react'

type Paso = 'elegir' | 'recortar' | 'procesando' | 'confirmar'

/** Artículo editable del formulario de confirmación (cantidad como texto). */
export type ItemRalForm = {
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: string
  enCatalogo: boolean
  revision: boolean
  /** El OCR adoptó el código por similitud de descripción (chip azul). */
  matchPorDescripcion: boolean
  /** El usuario escribió la descripción/unidad a mano: el autocompletado no las borra. */
  descripcionManual: boolean
  unidadManual: boolean
}

export type RalRegistradaInfo = {
  ralId: string
  documento: string
  articulos: number
}

type FormRal = {
  documento: string
  transaccion: string
  fecha: string
  areaSolicitante: string
  solicitante: string
  aprobadoPor: string
  almacen: string
  linea: string
  notas: string
  items: ItemRalForm[]
}

function itemVacio(): ItemRalForm {
  return {
    codigo: '',
    descripcion: '',
    unidad: '',
    centroCostos: '',
    cantidad: '',
    enCatalogo: false,
    revision: false,
    matchPorDescripcion: false,
    descripcionManual: false,
    unidadManual: false,
  }
}

/** Estado inicial FRESCO: fecha del momento (no congelada al montar). */
function formVacio(): FormRal {
  return {
    documento: '',
    transaccion: '',
    fecha: hoyISO(),
    areaSolicitante: '',
    solicitante: '',
    aprobadoPor: '',
    almacen: '',
    linea: '',
    notas: '',
    items: [itemVacio()],
  }
}

/** DatosRal (OCR) → filas del formulario. */
function itemsDesdeOcr(datos: DatosRal): ItemRalForm[] {
  return datos.items.map((it) => ({
    codigo: it.codigo,
    descripcion: it.descripcion,
    unidad: it.unidad,
    centroCostos: it.centroCostos,
    cantidad: String(it.cantidad),
    enCatalogo: it.enCatalogo,
    revision: it.revision,
    matchPorDescripcion: it.matchPorDescripcion ?? false,
    descripcionManual: false,
    unidadManual: false,
  }))
}

export function RalFotoForm({
  onRegistrado,
  onCancelar,
}: {
  onRegistrado: (info: RalRegistradaInfo) => void
  onCancelar: () => void
}) {
  const { perfil } = useAuth()
  const [paso, setPaso] = useState<Paso>('elegir')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [catError, setCatError] = useState(false)
  const [progreso, setProgreso] = useState(0)
  const [etapa, setEtapa] = useState('')
  const [thumb, setThumb] = useState('')
  const [fotoBlob, setFotoBlob] = useState<Blob | null>(null)
  const [form, setForm] = useState<FormRal>(formVacio())
  const [saving, setSaving] = useState(false)
  /** Rigor numérico: discrepancias entre lecturas que el usuario verifica. */
  const [avisos, setAvisos] = useState<string[]>([])

  /**
   * ID de idempotencia del RAL: se asigna UNA VEZ por intención de guardado
   * y se MANTIENE entre reintentos (misma mecánica que la RQ, Task 25):
   * si la red cae y el usuario vuelve a tocar «Registrar», la RPC reconoce
   * el MISMO id y completa lo que falte en vez de duplicar.
   */
  const ralIdRef = useRef<string | null>(null)

  const inputCamaraRef = useRef<HTMLInputElement>(null)
  const inputGaleriaRef = useRef<HTMLInputElement>(null)

  // ── RECORTE previo al OCR (misma mecánica que la RQ y la guía) ──
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

  function set<K extends keyof FormRal>(k: K, v: FormRal[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  function setItem(idx: number, parche: Partial<ItemRalForm>) {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...parche } : it)),
    }))
  }

  // ── CATÁLOGO · AUTOCOMPLETADO (igual que la RQ/Recepción) ──────────
  // Al escribir/corregir el código se jala la descripción y la unidad del
  // catálogo; si no matchea, se limpian SALVO que el usuario las escriba a
  // mano. El CENTRO DE COSTOS nunca viene del catálogo (es del documento).
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

  function onCodigoRal(idx: number, valor: string) {
    const it = form.items[idx]
    const cat = valor.trim() ? buscarCatalogo(valor) : undefined
    let descripcion = it.descripcion
    let unidad = it.unidad
    if (!valor.trim()) {
      if (!it.descripcionManual) descripcion = ''
      if (!it.unidadManual) unidad = ''
    } else if (cat) {
      descripcion = cat.descripcion
      unidad = cat.un || it.unidad
    } else {
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

  async function asegurarCatalogo(): Promise<boolean> {
    if (catalogo.length > 0) return true
    const c = await fetchCatalogo()
    setCatalogo(c)
    return c.length > 0
  }

  /** Aplica la mejor extracción al formulario + resumen de lo detectado. */
  function procesarExtraccion(datos: DatosRal, avisosExtra: string[] = []) {
    const itemsOcr = itemsDesdeOcr(datos)
    setAvisos(avisosExtra)
    const base = formVacio()
    setForm({
      ...base,
      documento: datos.documento,
      transaccion: datos.transaccion,
      fecha: datos.fecha || hoyISO(),
      areaSolicitante: datos.areaSolicitante,
      solicitante: datos.solicitante,
      aprobadoPor: datos.aprobadoPor,
      almacen: datos.almacen,
      linea: datos.linea,
      items: itemsOcr.length > 0 ? itemsOcr : [itemVacio()],
    })

    if (!datos.documento && itemsOcr.length === 0) {
      toast.warning('No se detectaron datos automáticamente', {
        description: 'Completa los datos manualmente en el siguiente paso.',
      })
      return
    }

    const faltantes: string[] = []
    if (!datos.documento) faltantes.push('documento')
    if (!datos.fecha) faltantes.push('fecha')
    if (itemsOcr.length === 0) faltantes.push('artículos de la tabla')
    const enCat = itemsOcr.filter((i) => i.enCatalogo).length
    const rev = itemsOcr.filter((i) => i.revision).length
    if (avisosExtra.length > 0) {
      toast.warning('Verifica los números señalados', { description: avisosExtra.join(' · ') })
    }
    toast.success(
      itemsOcr.length > 0
        ? `Se detectaron ${itemsOcr.length} artículo(s)${enCat > 0 ? ` · ${enCat} en catálogo` : ''}`
        : 'Datos del documento recopilados',
      {
        description:
          [
            datos.documento ? `Doc. ${datos.documento}` : '',
            datos.areaSolicitante ? datos.areaSolicitante : '',
            datos.almacen ? `Almacén ${datos.almacen}` : '',
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
      setEtapa('Preparando imagen (contraste)…')
      if (!originalRef.current) originalRef.current = archivo
      // Preprocesado: gris + contraste a 2800px (igual que la RQ)
      const imagen = await mejorarImagenOCR(archivo, 2800)
      const liviana = await reducirImagen(archivo, 1200, 0.8)
      setFotoBlob(liviana)
      setThumb(URL.createObjectURL(liviana))

      setEtapa('Verificando catálogo…')
      const catOk = await asegurarCatalogo()
      if (!catOk) {
        toast.warning('Catálogo no disponible', {
          description:
            'Los códigos no se podrán reconocer automáticamente; completa los artículos a mano.',
        })
      }
      const catalogoParaOCR = catOk ? getCachedCatalogo() : []

      setEtapa('Leyendo el RAL (OCR español)…')
      const { createWorker, PSM } = await import('tesseract.js')
      const worker = await createWorker('spa', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setProgreso(Math.round(m.progress * 100))
            setEtapa(`Reconociendo texto… ${Math.round(m.progress * 100)}%`)
          }
        },
      })
      // Igual que la guía/RQ: DPI fijo + espacios inter-palabra para
      // conservar las columnas de la tabla de artículos.
      await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })

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
        const d1 = await ocrData(PSM.SINGLE_BLOCK, imagen, true)
        const texto1 = d1.text ?? ''
        const palabras1 = extraerPalabras(d1)
        let datos = extraerDatosRalDeTexto(texto1, catalogoParaOCR)

        // PASADA 2 — SIEMPRE: releer con PSM 3 (layout automático) y fusionar
        // (unión sin duplicados; rescata filas que el 1er pase omitió).
        setEtapa('Revisando la lectura con un segundo pase…')
        const imagenBase = await reducirImagen(archivo, 2800, 0.9)
        const texto2 = await ocrTexto(PSM.AUTO, imagenBase)
        const datos2 = extraerDatosRalDeTexto(texto2, catalogoParaOCR)
        const fusion = fusionarDatosRal(datos, datos2)
        if (puntuarExtraccionRal(fusion) > puntuarExtraccionRal(datos)) datos = fusion
        else if (!extraccionSuficienteRal(datos) && extraccionSuficienteRal(datos2)) datos = datos2

        // Geometría compartida de los 2 pases zoom: la imagen leída viene
        // de mejorarImagenOCR (2800px + MARGEN_OCR) → original = (y − margen)/escala.
        const bmpProc = await createImageBitmap(imagen)
        const altoProc = bmpProc.height
        bmpProc.close()
        const bmpOrig = await createImageBitmap(archivo)
        const escala = 2800 / Math.max(bmpOrig.width, bmpOrig.height)
        bmpOrig.close()
        const aOriginal = (yOcr: number) => Math.max(0, (yOcr - MARGEN_OCR) / escala)

        // Ancla del encabezado: el bloque de etiquetas (Documento / Área
        // Solicitante / Almacén…) termina donde empieza la tabla.
        const yEncabezadoProc = palabras1
          .filter((p) =>
            /^(DOCUMENTO|FECHA|TRANSACCION|AREA|SOLICITANT|APROBAD|ALMACEN|LINEA)/.test(p.t)
          )
          .reduce((m, p) => Math.max(m, p.y1), 0)
        const yTabla = yEncabezadoProc > 0 ? aOriginal(yEncabezadoProc) : Math.round(altoProc * 0.3)

        // PASADA ZOOM · TABLA — "cuadro por cuadro": si no se leyó ningún
        // artículo o quedan a revisión, se relee SOLO la franja de la tabla
        // escalada ×3 en tramos con solape. SOLO se adopta si mejora — la
        // fusión jamás puede empeorar la lectura.
        const aRevisar = (d: DatosRal) => d.items.filter((i) => i.revision || !i.enCatalogo).length
        if (catOk && (datos.items.length === 0 || aRevisar(datos) > 0)) {
          try {
            setEtapa('Releyendo la tabla de artículos con zoom…')
            const bandas = dividirFranjaEnBandas(yTabla, altoProc)
            let textoZoom = ''
            for (const b of bandas) {
              const trozo = await recortarFranjaTabla(archivo, b.y0, b.y1, 3)
              const t = await ocrTexto(PSM.SINGLE_BLOCK, trozo)
              if (t.trim()) textoZoom += (textoZoom ? '\n' : '') + t
            }
            if (textoZoom.trim()) {
              const datosZoom = extraerDatosRalDeTexto(textoZoom, catalogoParaOCR)
              if (datos.items.length === 0 && datosZoom.items.length > 0) {
                datos = datosZoom
              } else {
                const fusionZoom = fusionarDatosRal(datos, datosZoom)
                if (
                  datosZoom.items.length > datos.items.length ||
                  aRevisar(fusionZoom) < aRevisar(datos)
                ) {
                  datos = fusionZoom
                }
              }
            }
          } catch {
            // Zoom oportunista: si falla queda la lectura de página completa.
          }
        }

        // PASADA ZOOM · ENCABEZADO (rigor numérico, pedido del usuario):
        // el DOCUMENTO y la FECHA se releen a ×3 sobre la banda superior.
        // Si el zoom DIFIERE de la lectura de página completa, GANA el zoom
        // y queda un aviso visible con ambas lecturas.
        const avisos: string[] = [
          ...avisoNumerosDebiles(palabras1),
          ...(fusion.avisos ?? []),
        ]
        try {
          setEtapa('Verificando los números del encabezado…')
          const yTopOrig = Math.min(yTabla, Math.max(60, altoProc / 4))
          if (yTopOrig >= 60) {
            const trozo = await recortarFranjaTabla(archivo, 0, yTopOrig, 3)
            const textoHz = await ocrTexto(PSM.SINGLE_BLOCK, trozo)
            if (textoHz.trim()) {
              const hz = extraerDatosRalDeTexto(textoHz, catalogoParaOCR)
              const campos: { k: 'documento' | 'fecha'; etq: string }[] = [
                { k: 'documento', etq: 'Documento' },
                { k: 'fecha', etq: 'Fecha' },
              ]
              for (const { k, etq } of campos) {
                const leidoZoom = (hz[k] ?? '').trim()
                if (!leidoZoom) continue
                const leidoActual = (datos[k] ?? '').trim()
                if (!leidoActual) {
                  datos = { ...datos, [k]: leidoZoom }
                } else if (leidoZoom !== leidoActual) {
                  datos = { ...datos, [k]: leidoZoom }
                  avisos.push(`${etq}: el zoom leyó ${leidoZoom} (antes ${leidoActual}) — verifica`)
                }
              }
            }
          }
        } catch {
          // Zoom oportunista: sin él queda la lectura de página completa.
        }

        procesarExtraccion(datos, Array.from(new Set(avisos)))
      } finally {
        await worker.terminate()
      }

      setPaso('confirmar')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
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
    ralIdRef.current = null // nueva intención de guardado
    originalRef.current = null
    setPendiente(null)
    setPaso('elegir')
  }

  /** Cancela el recorte: vuelve al paso desde donde se abrió. */
  function cancelarRecorte() {
    setPendiente(null)
    setPaso('elegir')
  }

  // ── GUARDADO ──
  async function guardar() {
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    const itemsValidos = form.items.filter(
      (it) => it.codigo.trim() && aNumero(it.cantidad) > 0
    )
    if (!form.documento.trim()) {
      toast.error('Ingresa el Nº de documento del RAL')
      return
    }
    if (itemsValidos.length === 0) {
      toast.error('Agrega al menos un artículo con código y cantidad pedida')
      return
    }
    if (!form.fecha) {
      toast.error('Ingresa la fecha del RAL')
      return
    }
    setSaving(true)
    try {
      // La foto es OPCIONAL: si falla la subida, el RAL se registra igual.
      // Mismo bucket privado atencion-rq (carpeta por usuario) que la RQ.
      let fotoUrl = ''
      if (fotoBlob) {
        try {
          fotoUrl = await subirFotoRq(fotoBlob, perfil.id)
        } catch (errFoto: unknown) {
          const msg = errFoto instanceof Error ? errFoto.message : 'error desconocido'
          toast.warning('El RAL se registrará SIN foto', { description: msg })
        }
      }
      if (!ralIdRef.current) ralIdRef.current = nuevoUuid()
      try {
        await crearRal(
          {
            fecha: form.fecha,
            documento: form.documento.trim(),
            transaccion: form.transaccion.trim(),
            areaSolicitante: form.areaSolicitante.trim(),
            solicitante: form.solicitante.trim(),
            aprobadoPor: form.aprobadoPor.trim(),
            almacen: form.almacen.trim(),
            linea: form.linea.trim(),
            notas: form.notas.trim(),
            fotoUrl,
          },
          itemsValidos.map((it) => ({
            codigo: it.codigo.trim(),
            descripcion: it.descripcion.trim(),
            unidad: it.unidad.trim(),
            centroCostos: it.centroCostos.trim(),
            cantidad: aNumero(it.cantidad),
          })),
          { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo },
          ralIdRef.current
        )
      } catch (errRal: unknown) {
        // La foto ya subió pero el RAL no: limpieza BEST-EFFORT del objeto
        // huérfano (patrón Task 25) — sin tapar el error real del guardado.
        if (fotoUrl) void eliminarFotoRq(fotoUrl)
        throw errRal
      }
      const idRegistrada = ralIdRef.current as string
      ralIdRef.current = null // éxito: el próximo RAL será una nueva intención
      toast.success('RAL registrado', {
        description: `${itemsValidos.length} artículo(s) en el documento ${form.documento.trim()}.`,
      })
      onRegistrado({
        ralId: idRegistrada,
        documento: form.documento.trim(),
        articulos: itemsValidos.length,
      })
      reiniciar()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo registrar el RAL', { description: message })
    } finally {
      setSaving(false)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  if (paso === 'elegir') {
    return (
      <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <FilePlus2 className="h-4 w-4 text-violet-600" />
          <h3 className="text-sm font-bold text-violet-900">Nuevo RAL — Requerimiento al Almacén</h3>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Toma una foto al RAL y la app extrae el documento, área solicitante, aprobado por,
          almacén y los artículos (código, descripción, und, centro de costos y cantidad pedida).
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            onClick={() => inputCamaraRef.current?.click()}
            className="h-11 gap-2 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
          >
            <Camera className="h-4 w-4" /> Tomar foto del RAL
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
          className="w-full gap-2 text-violet-700 hover:bg-violet-100/60"
        >
          <FilePlus2 className="h-4 w-4" /> Registrar sin foto (manual)
        </Button>
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
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancelar} className="text-slate-500">
            Cancelar
          </Button>
        </div>
      </div>
    )
  }

  if (paso === 'recortar' && pendiente) {
    return (
      <RecortarImagenDialog
        open
        archivo={pendiente}
        origen={origenRecorte}
        onAplicar={(recorte) => {
          setPendiente(null)
          void procesar(recorte)
        }}
        onUsarCompleto={() => {
          const completo = pendiente
          setPendiente(null)
          void procesar(completo)
        }}
        onCancelar={cancelarRecorte}
      />
    )
  }

  if (paso === 'procesando') {
    return (
      <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <ScanLine className="h-5 w-5 text-violet-600 animate-pulse" />
          <p className="text-sm font-semibold text-violet-900">{etapa || 'Procesando…'}</p>
        </div>
        <Progress value={progreso} className="h-2" />
        <Button variant="outline" size="sm" onClick={reiniciar} className="gap-2">
          <RotateCcw className="h-3.5 w-3.5" /> Cancelar
        </Button>
      </div>
    )
  }

  // ── CONFIRMAR (con o sin foto) ──
  const fechaCorta = 'w-[130px] min-[430px]:w-auto'
  // Sugerencias del catálogo para la fila con el menú abierto (se recalcula
  // en cada render con el código actual de esa fila).
  const sugerencias = menuIdx != null ? sugerenciasPara(form.items[menuIdx]?.codigo ?? '') : []
  return (
    <div className="rounded-xl border border-violet-100 bg-white p-4 space-y-4">
      {!thumb ? (
        <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <FilePlus2 className="h-3.5 w-3.5 text-violet-600" /> Registro manual — sin foto adjunta
          </p>
          <Button variant="ghost" size="sm" onClick={reiniciar} className="h-7 text-xs gap-1">
            <Camera className="h-3.5 w-3.5" /> Tomar foto
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <img
            src={thumb}
            alt="Foto del RAL"
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

      {/* AVISOS DE RIGOR NUMÉRICO: discrepancias entre lecturas — el usuario
          las verifica ANTES de registrar (revisión > corrección). */}
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

      {/* Encabezado */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Documento</Label>
          <Input
            inputMode="numeric"
            placeholder="8378"
            value={form.documento}
            onChange={(e) => set('documento', e.target.value)}
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
          <Label className="text-xs">Transacción</Label>
          <Input
            placeholder="RAL Requerimiento al Almacén"
            value={form.transaccion}
            onChange={(e) => set('transaccion', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Área solicitante</Label>
          <Input
            placeholder="Cadena de Suministro…"
            value={form.areaSolicitante}
            onChange={(e) => set('areaSolicitante', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Solicitante</Label>
          <Input
            placeholder="Quien pide los materiales"
            value={form.solicitante}
            onChange={(e) => set('solicitante', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Aprobado por</Label>
          <Input
            placeholder="Quien aprueba el RAL"
            value={form.aprobadoPor}
            onChange={(e) => set('aprobadoPor', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Almacén</Label>
          <Input
            placeholder="05 Almacén de Materia Prima…"
            value={form.almacen}
            onChange={(e) => set('almacen', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Línea</Label>
          <Input
            placeholder="04 Materia Prima y Materiales…"
            value={form.linea}
            onChange={(e) => set('linea', e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-1 lg:col-span-3">
          <Label className="text-xs">Notas (opcional)</Label>
          <Textarea
            rows={2}
            placeholder="Observaciones del RAL…"
            value={form.notas}
            onChange={(e) => set('notas', e.target.value)}
          />
        </div>
      </div>

      {/* Artículos */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-700">
            Artículos ({form.items.length})
          </h4>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 h-8"
            onClick={() => setForm((prev) => ({ ...prev, items: [...prev.items, itemVacio()] }))}
          >
            <Plus className="h-3.5 w-3.5" /> Agregar artículo
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
                <th className="px-3 py-2">Artículo o descripción</th>
                <th className="px-3 py-2 w-[80px]">Und</th>
                <th className="px-3 py-2 w-[130px]">Centro de costos</th>
                <th className="px-3 py-2 w-[120px]">Cantidad pedida</th>
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
                        autoComplete="off"
                        value={it.codigo}
                        onChange={(e) => onCodigoRal(idx, e.target.value)}
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
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8 font-mono"
                      inputMode="numeric"
                      placeholder="14040101"
                      value={it.centroCostos}
                      onChange={(e) => setItem(idx, { centroCostos: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8 text-right"
                      inputMode="decimal"
                      value={it.cantidad}
                      onChange={(e) => setItem(idx, { cantidad: e.target.value })}
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
                          items: prev.items.length > 1 ? prev.items.filter((_, i) => i !== idx) : [itemVacio()],
                        }))
                      }
                      title="Quitar artículo"
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
                    autoComplete="off"
                    placeholder="Código"
                    value={it.codigo}
                    onChange={(e) => onCodigoRal(idx, e.target.value)}
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
                      items: prev.items.length > 1 ? prev.items.filter((_, i) => i !== idx) : [itemVacio()],
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
              <div className="flex gap-2">
                <Input
                  className="h-9 flex-1 text-right"
                  inputMode="decimal"
                  placeholder="Cantidad pedida"
                  value={it.cantidad}
                  onChange={(e) => setItem(idx, { cantidad: e.target.value })}
                />
                <Input
                  className="h-9 w-16 uppercase"
                  placeholder="UND"
                  value={it.unidad}
                  onChange={(e) =>
                    setItem(idx, { unidad: e.target.value.toUpperCase(), unidadManual: Boolean(e.target.value.trim()) })
                  }
                />
              </div>
              <Input
                className="h-9 font-mono"
                inputMode="numeric"
                placeholder="Centro de costos"
                value={it.centroCostos}
                onChange={(e) => setItem(idx, { centroCostos: e.target.value })}
              />
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
          disabled={saving}
          className="gap-2 h-10 bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
          Registrar RAL
        </Button>
      </div>

      {form.items.some((i) => i.revision) && (
        <p className="text-[11px] text-amber-600 flex items-center gap-1.5">
          <Badge variant="outline" className="border-amber-300 text-amber-700 text-[10px]">
            revisar
          </Badge>
          Hay artículos fuera del catálogo o con datos dudosos — corrígelos antes de registrar.
        </p>
      )}
    </div>
  )
}
