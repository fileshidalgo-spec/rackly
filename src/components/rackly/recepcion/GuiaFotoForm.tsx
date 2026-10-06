'use client'

/**
 * RACKLY — Recepción · Opción "Con foto de guía".
 *
 * Flujo:
 *   1. Usuario toma foto a la guía (cámara móvil o archivo).
 *   2. Se reduce la imagen (2800px, tablas largas con letra pequeña),
 *      corre OCR (tesseract.js, idioma spa) y el parser `extraerDatosGuia`
 *      recopila: nº guía, placa, proveedor y TODOS los códigos de artículo
 *      detectados (cruzados contra el catálogo → descripción y unidad
 *      automáticas). Si no encontró ninguno, activa rescate fuzzy.
 *   3. Formulario de CONFIRMACIÓN con la LISTA COMPLETA de artículos
 *      (la guía puede traer 20+): todo editable, cantidad ajustable por
 *      artículo, lote y fechas manuales (con atajo "aplicar a todos").
 *   4. Al registrar: foto liviana → Storage (bucket recepcion-guias) y
 *      UNA FILA POR ARTÍCULO en recepcion_registros compartiendo el
 *      encabezado (guía, placa, proveedor, foto).
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { fetchCatalogo, getCachedCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import {
  extraerDatosGuia,
  reducirImagen,
  type DatosGuia,
} from '@/lib/rackly/guia-ocr'
import { crearRecepciones, subirFotoGuia, TIPOS_DOCUMENTO_RECEPCION } from '@/lib/rackly/modulos'
import {
  RecepcionItemsEditor,
  itemVacio,
  itemsValidos,
  type ItemRecepcion,
} from '@/components/rackly/recepcion/RecepcionItemsEditor'
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
  Loader2,
  ScanLine,
  RotateCcw,
  PackageCheck,
  ImageIcon,
  CheckCircle2,
  XCircle,
} from 'lucide-react'

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

type Paso = 'elegir' | 'procesando' | 'confirmar'

/** Estado del formulario de confirmación: encabezado + lista de artículos. */
type FormFoto = {
  numeroGuia: string
  placa: string
  proveedor: string
  fecha: string
  tipoDocumento: string
  observaciones: string
  items: ItemRecepcion[]
}

const FORM_VACIO: FormFoto = {
  numeroGuia: '',
  placa: '',
  proveedor: '',
  fecha: hoyISO(),
  tipoDocumento: 'Guia',
  observaciones: '',
  items: [itemVacio()],
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
    enCatalogo: item.enCatalogo,
  }
}

export function GuiaFotoForm({ onRegistrado }: { onRegistrado: () => void }) {
  const { perfil } = useAuth()
  const [paso, setPaso] = useState<Paso>('elegir')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [progreso, setProgreso] = useState(0)
  const [etapa, setEtapa] = useState('')
  const [thumb, setThumb] = useState<string>('')
  const [fotoBlob, setFotoBlob] = useState<Blob | null>(null)
  const [form, setForm] = useState<FormFoto>(FORM_VACIO)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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

  async function procesar(archivo: File) {
    setPaso('procesando')
    setProgreso(0)
    setEtapa('Preparando imagen…')
    try {
      // 2800px: las guías con 20+ artículos imprimen la tabla en letra
      // pequeña; a 2000px el OCR no distinguía los dígitos del código.
      const imagen = await reducirImagen(archivo, 2800, 0.9)
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
      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('spa', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setProgreso(Math.round(m.progress * 100))
            setEtapa(`Reconociendo texto… ${Math.round(m.progress * 100)}%`)
          }
        },
      })
      let datos: DatosGuia
      try {
        const { data } = await worker.recognize(imagen)
        datos = extraerDatosGuia(data.text ?? '', catOk ? getCachedCatalogo() : [])
      } finally {
        await worker.terminate()
      }

      const itemsOcr = datos.items.map(itemDesdeOcr)
      setForm({
        ...FORM_VACIO,
        numeroGuia: datos.numeroGuia,
        placa: datos.placa,
        proveedor: datos.proveedor,
        items: itemsOcr.length > 0 ? itemsOcr : [itemVacio()],
      })

      if (!datos.numeroGuia && itemsOcr.length === 0) {
        toast.warning('No se detectaron datos automáticamente', {
          description: 'Completa los datos manualmente en el siguiente paso.',
        })
      } else {
        const faltantes: string[] = []
        if (!datos.numeroGuia) faltantes.push('nº guía')
        if (!datos.placa) faltantes.push('placa')
        const enCat = itemsOcr.filter((i) => i.enCatalogo).length
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
              (faltantes.length ? `. Faltan: ${faltantes.join(', ')} (se completan a mano).` : ''),
          }
        )
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
    setForm(FORM_VACIO)
    setProgreso(0)
    setPaso('elegir')
  }

  async function guardar() {
    const validos = itemsValidos(form.items)
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
      let fotoUrl = ''
      if (fotoBlob) {
        try {
          fotoUrl = await subirFotoGuia(fotoBlob, perfil.id)
        } catch {
          toast.warning('La foto no se pudo subir; el registro se guarda sin ella.')
        }
      }
      const fecha = form.fecha || hoyISO()
      await crearRecepciones(
        validos.map((it) => ({
          fecha,
          tipoDocumento: form.tipoDocumento,
          numeroDocumento: form.numeroGuia,
          proveedor: form.proveedor,
          codigo: it.codigo,
          descripcion: it.descripcion,
          cantidad: parseFloat(it.cantidad.replace(',', '.')),
          unidadMedida: it.unidad,
          lote: it.lote,
          fechaProduccion: it.fechaProduccion,
          fechaVencimiento: it.fechaVencimiento,
          placa: form.placa,
          fotoUrl,
          observaciones: form.observaciones,
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success(`Recepción registrada con foto: ${validos.length} artículo(s)`)
      reiniciar()
      onRegistrado()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo registrar', { description: message })
    } finally {
      setSaving(false)
    }
  }

  // ────────────────────────────────────────────────────────────
  // PASO 1: elegir foto
  // ────────────────────────────────────────────────────────────
  if (paso === 'elegir') {
    return (
      <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Camera className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">Registrar con foto de guía</h3>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Toma una foto a la guía y el app recopila el número de guía, placa, proveedor y TODOS los
          artículos detectados (código, descripción del catálogo, cantidad y unidad). La fecha de
          producción, vencimiento y el lote se completan manualmente. Todo es editable antes de
          registrar.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void procesar(f)
            e.currentTarget.value = ''
          }}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            onClick={() => inputRef.current?.click()}
            className="gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
          >
            <Camera className="h-4 w-4" /> Tomar foto a la guía
          </Button>
          <Button variant="outline" onClick={() => inputRef.current?.click()} className="gap-2">
            <ImageIcon className="h-4 w-4" /> Elegir imagen de la galería
          </Button>
        </div>
      </div>
    )
  }

  // ────────────────────────────────────────────────────────────
  // PASO 2: procesando (OCR)
  // ────────────────────────────────────────────────────────────
  if (paso === 'procesando') {
    return (
      <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
          <ScanLine className="h-4 w-4 animate-pulse" /> {etapa || 'Procesando…'}
        </div>
        <Progress value={progreso} className="h-2" />
        <p className="text-xs text-slate-400">Esto puede tardar unos segundos según la foto.</p>
      </div>
    )
  }

  // ────────────────────────────────────────────────────────────
  // PASO 3: confirmación (encabezado + lista de artículos)
  // ────────────────────────────────────────────────────────────
  const detectados = form.items.filter((i) => i.codigo.trim()).length
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">Confirmar datos de la guía</h3>
        </div>
        <Button size="sm" variant="ghost" onClick={reiniciar} className="gap-1.5 text-xs">
          <RotateCcw className="h-3.5 w-3.5" /> Otra foto
        </Button>
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
              <CheckCircle2 className="h-3.5 w-3.5" /> Guía detectada: <b>{form.numeroGuia}</b>
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
          <Label className="text-xs">Proveedor</Label>
          <Input value={form.proveedor} onChange={(e) => set('proveedor', e.target.value)} placeholder="Nombre del proveedor" />
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

      <Button
        onClick={guardar}
        disabled={saving}
        className="w-full gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
        Registrar recepción ({itemsValidos(form.items).length} artículo(s))
      </Button>
    </div>
  )
}
