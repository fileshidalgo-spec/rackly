'use client'

/**
 * RACKLY — Recepción · Opción "Con foto de guía".
 *
 * Flujo:
 *   1. Usuario toma foto a la guía (cámara móvil o archivo).
 *   2. Se reduce la imagen, corre OCR (tesseract.js, idioma spa) y el
 *      parser `extraerDatosGuia` recopila: nº guía, placa, proveedor y
 *      códigos de artículo (cruzados contra el catálogo → descripción
 *      y unidad automáticas).
 *   3. Formulario de CONFIRMACIÓN prellenado: todo editable (la cantidad
 *      se ajusta si llegó menor), fechas de producción/vencimiento y lote
 *      se colocan manualmente.
 *   4. Al registrar: foto liviana → Storage (bucket recepcion-guias) y
 *      registro en recepcion_registros (misma tabla que la vía manual).
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  fetchCatalogo,
  findCatalogoByCodigo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import {
  extraerDatosGuia,
  reducirImagen,
  type DatosGuia,
  type ItemGuia,
} from '@/lib/rackly/guia-ocr'
import { crearRecepcion, subirFotoGuia, TIPOS_DOCUMENTO_RECEPCION } from '@/lib/rackly/modulos'
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

/** Estado del formulario de confirmación (todo editable). */
type FormFoto = {
  numeroGuia: string
  placa: string
  proveedor: string
  fecha: string
  tipoDocumento: string
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  fechaProduccion: string
  fechaVencimiento: string
  lote: string
  observaciones: string
  enCatalogo: boolean
}

const FORM_VACIO: FormFoto = {
  numeroGuia: '',
  placa: '',
  proveedor: '',
  fecha: hoyISO(),
  tipoDocumento: 'Guia',
  codigo: '',
  descripcion: '',
  cantidad: '',
  unidad: '',
  fechaProduccion: '',
  fechaVencimiento: '',
  lote: '',
  observaciones: '',
  enCatalogo: false,
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

  /** Al escribir el código: descripción y unidad se sacan del catálogo. */
  function onCodigoChange(valor: string) {
    const cat = findCatalogoByCodigo(valor)
    setForm((prev) => ({
      ...prev,
      codigo: valor,
      descripcion: cat ? cat.descripcion : prev.descripcion,
      unidad: cat ? cat.un : prev.unidad,
      enCatalogo: Boolean(cat),
    }))
  }

  function aplicarItemPrincipal(datos: DatosGuia) {
    const item: ItemGuia | undefined = datos.items[0]
    setForm({
      ...FORM_VACIO,
      numeroGuia: datos.numeroGuia,
      placa: datos.placa,
      proveedor: datos.proveedor,
      codigo: item?.codigo ?? '',
      descripcion: item?.descripcion ?? '',
      cantidad: item?.cantidad ?? '',
      unidad: item?.unidad ?? '',
      enCatalogo: item?.enCatalogo ?? false,
    })
  }

  async function procesar(archivo: File) {
    setPaso('procesando')
    setProgreso(0)
    setEtapa('Preparando imagen…')
    try {
      const imagen = await reducirImagen(archivo, 2000, 0.9)
      const liviana = await reducirImagen(archivo, 1200, 0.8)
      setFotoBlob(liviana)
      setThumb(URL.createObjectURL(liviana))

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
      try {
        const { data } = await worker.recognize(imagen)
        const datos = extraerDatosGuia(data.text ?? '', catalogo)
        aplicarItemPrincipal(datos)
        if (!datos.numeroGuia && datos.items.length === 0) {
          toast.warning('No se detectaron datos automáticamente', {
            description: 'Completa los datos manualmente en el siguiente paso.',
          })
        } else {
          const faltantes: string[] = []
          if (!datos.numeroGuia) faltantes.push('nº guía')
          if (!datos.placa) faltantes.push('placa')
          toast.success('Datos recopilados de la guía', {
            description:
              `Detectados: ${[
                datos.numeroGuia ? `guía ${datos.numeroGuia}` : '',
                datos.placa ? `placa ${datos.placa}` : '',
                `${datos.items.length} código(s)`,
              ]
                .filter(Boolean)
                .join(' · ')}` +
              (faltantes.length ? `. Faltan: ${faltantes.join(', ')} (se completan a mano).` : ''),
          })
        }
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
    setForm(FORM_VACIO)
    setProgreso(0)
    setPaso('elegir')
  }

  async function guardar() {
    const cantidad = parseFloat((form.cantidad || '').replace(',', '.'))
    if (!form.codigo.trim() && !form.proveedor.trim()) {
      toast.error('Ingresa al menos el código del artículo o el proveedor')
      return
    }
    if (isNaN(cantidad) || cantidad <= 0) {
      toast.error('La cantidad debe ser un número mayor a 0')
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
      await crearRecepcion(
        {
          fecha: form.fecha || hoyISO(),
          tipoDocumento: form.tipoDocumento,
          numeroDocumento: form.numeroGuia,
          proveedor: form.proveedor,
          codigo: form.codigo,
          descripcion: form.descripcion,
          cantidad,
          unidadMedida: form.unidad,
          lote: form.lote,
          fechaProduccion: form.fechaProduccion,
          fechaVencimiento: form.fechaVencimiento,
          placa: form.placa,
          fotoUrl,
          observaciones: form.observaciones,
        },
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success('Recepción registrada con foto de guía')
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
          Toma una foto a la guía y el app recopila el código del artículo, descripción (desde el
          catálogo), cantidad, unidad, placa y número de guía. La fecha de producción, vencimiento y
          el lote se completan manualmente. Todo es editable antes de registrar.
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
  // PASO 3: confirmación prellenada
  // ────────────────────────────────────────────────────────────
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
          {form.enCatalogo ? (
            <p className="text-xs flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Código encontrado en catálogo
            </p>
          ) : (
            <p className="text-xs flex items-center gap-1.5 text-slate-500">
              <XCircle className="h-3.5 w-3.5" /> Código no está en el catálogo (descripción manual)
            </p>
          )}
        </div>
      </div>

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
          <Label className="text-xs">Código del artículo</Label>
          <Input value={form.codigo} onChange={(e) => onCodigoChange(e.target.value)} placeholder="Se autocompleta la descripción" />
        </div>
        <div className="space-y-1.5 lg:col-span-2">
          <Label className="text-xs">Descripción {form.enCatalogo ? '(del catálogo)' : ''}</Label>
          <Input value={form.descripcion} onChange={(e) => set('descripcion', e.target.value)} placeholder="Descripción del artículo" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Cantidad (editable)</Label>
          <Input inputMode="decimal" value={form.cantidad} onChange={(e) => set('cantidad', e.target.value)} placeholder="0" />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Unidad de medida</Label>
          <Input value={form.unidad} onChange={(e) => set('unidad', e.target.value.toUpperCase())} placeholder="KGM, MILL, UND…" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Fecha de producción (manual)</Label>
          <Input type="date" value={form.fechaProduccion} onChange={(e) => set('fechaProduccion', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Fecha de vencimiento (manual)</Label>
          <Input type="date" value={form.fechaVencimiento} onChange={(e) => set('fechaVencimiento', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Lote (manual)</Label>
          <Input value={form.lote} onChange={(e) => set('lote', e.target.value)} placeholder="Lote de fabricación" />
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
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
          <Label className="text-xs">Observaciones</Label>
          <Textarea rows={1} value={form.observaciones} onChange={(e) => set('observaciones', e.target.value)} placeholder="Opcional" />
        </div>
        <div className="flex items-end">
          <Button
            onClick={guardar}
            disabled={saving}
            className="w-full gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Registrar recepción
          </Button>
        </div>
      </div>
    </div>
  )
}
