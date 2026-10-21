'use client'

/**
 * RACKLY — Atención a Línea · Opción "Con foto de RQ".
 *
 * Flujo (espejo del de Guía en Recepción, calibrado a la RQ AJEPER):
 *   1. Usuario toma foto a la RQ (cámara o archivo) → RECORTE previo
 *      (RecortarImagenDialog reutilizado; sin duplicar lógica).
 *   2. OCR tesseract.js (spa): pase PSM 6 con bloques + pase PSM 3 de
 *      respaldo → parser `extraerDatosRqDeTexto` (rq-ocr.ts) → fusión.
 *      El TURNO NO se lee del documento: se calcula con la regla T1/T2
 *      del almacén (turno.ts) y queda editable.
 *   3. Formulario de CONFIRMACIÓN: encabezado (Nº RQ, orden de producción,
 *      producto, fecha, turno, solicitante) + materiales con cantidad y
 *      unidad editables. Del encabezado de la RQ se IGNORAN "Lote de
 *      Sistema" y "Cantidad" (regla del usuario).
 *   4. Registrar: foto liviana → Storage (bucket atencion-rq) y
 *      rq_atenciones + rq_atencion_items en la BD.
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import type { PSM } from 'tesseract.js'
import { fetchCatalogo, getCachedCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import { mejorarImagenOCR, reducirImagen } from '@/lib/rackly/guia-ocr'
import {
  extraerDatosRqDeTexto,
  fusionarDatosRq,
  type DatosRq,
} from '@/lib/rackly/rq-ocr'
import { calcularTurnoRecepcion } from '@/lib/rackly/turno'
import { crearRq, subirFotoRq, type RqAtencion } from '@/lib/rackly/rq-atencion'
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
} from 'lucide-react'

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

/** Material editable del formulario de confirmación (cantidad como texto). */
export type ItemRqForm = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  enCatalogo: boolean
  revision: boolean
}

type Paso = 'elegir' | 'recortar' | 'procesando' | 'confirmar'

type FormRq = {
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  fecha: string
  turno: string
  solicitante: string
  notas: string
  items: ItemRqForm[]
}

function itemVacio(): ItemRqForm {
  return { codigo: '', descripcion: '', cantidad: '', unidad: '', enCatalogo: false, revision: false }
}

/** Estado inicial FRESCO: fecha/turno del momento (no congelados al montar). */
function formVacio(): FormRq {
  return {
    numeroRq: '',
    ordenProduccion: '',
    productoCodigo: '',
    productoDescripcion: '',
    fecha: hoyISO(),
    turno: calcularTurnoRecepcion(new Date()),
    solicitante: '',
    notas: '',
    items: [itemVacio()],
  }
}

/** DatosRq (OCR) → filas del formulario. */
function itemsDesdeOcr(datos: DatosRq): ItemRqForm[] {
  return datos.items.map((it) => ({
    codigo: it.codigo,
    descripcion: it.descripcion,
    cantidad: String(it.cantidad),
    unidad: it.unidad,
    enCatalogo: it.enCatalogo,
    revision: it.revision,
  }))
}

/** Umbral de calidad: con estos pilares no se re-procesa. */
function extraccionSuficiente(d: DatosRq): boolean {
  return d.items.length > 0 && Boolean(d.numeroRq) && Boolean(d.fecha)
}

export type RqRegistradaInfo = {
  rq: RqAtencion
  articulos: number
}

export function RqFotoForm({
  onRegistrado,
  onCancelar,
}: {
  onRegistrado: (info: RqRegistradaInfo) => void
  onCancelar: () => void
}) {
  const { perfil } = useAuth()
  const [paso, setPaso] = useState<Paso>('elegir')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [progreso, setProgreso] = useState(0)
  const [etapa, setEtapa] = useState('')
  const [thumb, setThumb] = useState<string>('')
  const [fotoBlob, setFotoBlob] = useState<Blob | null>(null)
  const [form, setForm] = useState<FormRq>(formVacio())
  const [saving, setSaving] = useState(false)

  const inputCamaraRef = useRef<HTMLInputElement>(null)
  const inputGaleriaRef = useRef<HTMLInputElement>(null)

  // ── RECORTE previo al OCR (misma mecánica que la guía) ──
  const [pendiente, setPendiente] = useState<File | null>(null)
  const [origenRecorte, setOrigenRecorte] = useState<OrigenRecorte>('inicio')
  const originalRef = useRef<File | null>(null)

  useEffect(() => {
    fetchCatalogo().then((c) => setCatalogo(c))
  }, [])

  function set<K extends keyof FormRq>(k: K, v: FormRq[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  function setItem(idx: number, parche: Partial<ItemRqForm>) {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...parche } : it)),
    }))
  }

  async function asegurarCatalogo(): Promise<boolean> {
    if (catalogo.length > 0) return true
    const c = await fetchCatalogo()
    setCatalogo(c)
    return c.length > 0
  }

  /** Aplica la mejor extracción al formulario + resumen de lo detectado. */
  function procesarExtraccion(datos: DatosRq) {
    const itemsOcr = itemsDesdeOcr(datos)
    setForm({
      ...formVacio(),
      numeroRq: datos.numeroRq,
      ordenProduccion: datos.ordenProduccion,
      productoCodigo: datos.productoCodigo,
      productoDescripcion: datos.productoDescripcion,
      fecha: datos.fecha || hoyISO(),
      solicitante: datos.solicitante,
      items: itemsOcr.length > 0 ? itemsOcr : [itemVacio()],
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
    toast.success(
      itemsOcr.length > 0
        ? `Se detectaron ${itemsOcr.length} material(es)${enCat > 0 ? ` · ${enCat} en catálogo` : ''}`
        : 'Datos del documento recopilados',
      {
        description:
          [
            datos.numeroRq ? `RQ ${datos.numeroRq}` : '',
            datos.ordenProduccion ? `OP ${datos.ordenProduccion}` : '',
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
      // Preprocesado: gris + contraste a 2800px (letra pequeña de la RQ)
      const imagen = await mejorarImagenOCR(archivo, 2800)
      const liviana = await reducirImagen(archivo, 1200, 0.8)
      setFotoBlob(liviana)
      setThumb(URL.createObjectURL(liviana))

      setEtapa('Verificando catálogo…')
      const catOk = await asegurarCatalogo()
      if (!catOk) {
        toast.warning('Catálogo no disponible', {
          description:
            'Los códigos no se podrán reconocer automáticamente; completa los materiales a mano.',
        })
      }

      setEtapa('Leyendo la RQ (OCR español)…')
      const { createWorker, PSM } = await import('tesseract.js')
      const worker = await createWorker('spa', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setProgreso(Math.round(m.progress * 100))
            setEtapa(`Reconociendo texto… ${Math.round(m.progress * 100)}%`)
          }
        },
      })
      // Igual que la guía: DPI fijo + espacios inter-palabra para conservar
      // las columnas de la tabla de materiales.
      await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })

      async function ocrTexto(psm: PSM, con: Blob): Promise<string> {
        await worker.setParameters({ tessedit_pageseg_mode: psm })
        const { data } = await worker.recognize(con, {}, {})
        return data.text ?? ''
      }

      try {
        // PASADA 1 — PSM 6 (bloque uniforme) sobre la página completa
        const texto1 = await ocrTexto(PSM.SINGLE_BLOCK, imagen)
        const catalogoParaOCR = catOk ? getCachedCatalogo() : []
        let datos = extraerDatosRqDeTexto(texto1, catalogoParaOCR)

        // PASADA 2 — SIEMPRE: releer con PSM 3 (layout automático) y fusionar
        // (unión sin duplicados; rescata filas que el 1er pase omitió).
        setEtapa('Revisando la lectura con un segundo pase…')
        const imagenBase = await reducirImagen(archivo, 2800, 0.9)
        const texto2 = await ocrTexto(PSM.AUTO, imagenBase)
        const datos2 = extraerDatosRqDeTexto(texto2, catalogoParaOCR)
        const fusion = fusionarDatosRq(datos, datos2)
        if (
          fusion.items.length > datos.items.length ||
          (!datos.numeroRq && fusion.numeroRq) ||
          (!datos.fecha && fusion.fecha) ||
          (!datos.solicitante && fusion.solicitante) ||
          (!datos.ordenProduccion && fusion.ordenProduccion)
        ) {
          datos = fusion
        } else if (!extraccionSuficiente(datos) && extraccionSuficiente(datos2)) {
          datos = datos2
        }

        procesarExtraccion(datos)
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
      (it) => it.codigo.trim() && parseFloat(it.cantidad) > 0
    )
    if (itemsValidos.length === 0) {
      toast.error('Agrega al menos un material con código y cantidad')
      return
    }
    if (!form.fecha) {
      toast.error('Ingresa la fecha de la RQ')
      return
    }
    setSaving(true)
    try {
      // La foto es OPCIONAL: si falla la subida, la RQ se registra igual
      let fotoUrl = ''
      if (fotoBlob) {
        try {
          fotoUrl = await subirFotoRq(fotoBlob, perfil.id)
        } catch (errFoto: unknown) {
          const msg = errFoto instanceof Error ? errFoto.message : 'error desconocido'
          toast.warning('La RQ se registrará SIN foto', { description: msg })
        }
      }
      const id = await crearRq(
        {
          fecha: form.fecha,
          numeroRq: form.numeroRq.trim(),
          ordenProduccion: form.ordenProduccion.trim(),
          productoCodigo: form.productoCodigo.trim(),
          productoDescripcion: form.productoDescripcion.trim(),
          turno: form.turno,
          solicitante: form.solicitante.trim(),
          notas: form.notas.trim(),
          fotoUrl,
        },
        itemsValidos.map((it) => ({
          codigo: it.codigo.trim(),
          descripcion: it.descripcion.trim(),
          unidad: it.unidad.trim(),
          cantidad: parseFloat(it.cantidad),
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success('RQ registrada — ya puedes atenderla', {
        description: itemsValidos.length > 0 ? `${itemsValidos.length} material(es) por atender.` : undefined,
      })
      onRegistrado({
        rq: {
          id,
          createdAt: new Date().toISOString(),
          fecha: form.fecha,
          numeroRq: form.numeroRq.trim(),
          ordenProduccion: form.ordenProduccion.trim(),
          productoCodigo: form.productoCodigo.trim(),
          productoDescripcion: form.productoDescripcion.trim(),
          turno: form.turno,
          solicitante: form.solicitante.trim(),
          estado: 'Pendiente',
          fotoUrl,
          notas: form.notas.trim(),
          usuarioId: perfil.id,
          usuarioNombre: perfil.nombre,
          usuarioCorreo: perfil.correo,
        },
        articulos: itemsValidos.length,
      })
      reiniciar()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo registrar la RQ', { description: message })
    } finally {
      setSaving(false)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  if (paso === 'elegir') {
    return (
      <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-teal-600" />
          <h3 className="text-sm font-bold text-teal-900">Registrar RQ de Atención a Línea</h3>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Toma una foto a la RQ (Requisición de Despacho de Materiales) y la app extrae el Nº,
          orden de producción, producto y los materiales a atender.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            onClick={() => inputCamaraRef.current?.click()}
            className="h-11 gap-2 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
          >
            <Camera className="h-4 w-4" /> Tomar foto de la RQ
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
          className="w-full gap-2 text-teal-700 hover:bg-teal-100/60"
        >
          <ClipboardList className="h-4 w-4" /> Registrar sin foto (manual)
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
      <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <ScanLine className="h-5 w-5 text-teal-600 animate-pulse" />
          <p className="text-sm font-semibold text-teal-900">{etapa || 'Procesando…'}</p>
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
  return (
    <div className="rounded-xl border border-teal-100 bg-white p-4 space-y-4">
      {!thumb ? (
        <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5 text-teal-600" /> Registro manual — sin foto adjunta
          </p>
          <Button variant="ghost" size="sm" onClick={reiniciar} className="h-7 text-xs gap-1">
            <Camera className="h-3.5 w-3.5" /> Tomar foto
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <img
            src={thumb}
            alt="Foto de la RQ"
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

      {/* Encabezado */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Nº de RQ</Label>
          <Input
            inputMode="numeric"
            placeholder="0000191373"
            value={form.numeroRq}
            onChange={(e) => set('numeroRq', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Orden de producción</Label>
          <Input
            inputMode="numeric"
            placeholder="2026008121"
            value={form.ordenProduccion}
            onChange={(e) => set('ordenProduccion', e.target.value)}
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
          <Label className="text-xs">Código del producto</Label>
          <Input
            inputMode="numeric"
            placeholder="3000047"
            value={form.productoCodigo}
            onChange={(e) => set('productoCodigo', e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
          <Label className="text-xs">Descripción del producto</Label>
          <Input
            placeholder="SYRUP KR PIÑA 5%…"
            value={form.productoDescripcion}
            onChange={(e) => set('productoDescripcion', e.target.value)}
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
          <Label className="text-xs">Turno (automático)</Label>
          <Select value={form.turno} onValueChange={(v) => set('turno', v)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="T1">T1 (07:20 – 19:20)</SelectItem>
              <SelectItem value="T2">T2 (19:21 – 07:19)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
          <Label className="text-xs">Notas (opcional)</Label>
          <Textarea
            rows={2}
            placeholder="Observaciones de la atención…"
            value={form.notas}
            onChange={(e) => set('notas', e.target.value)}
          />
        </div>
      </div>

      {/* Materiales */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-700">
            Materiales a atender ({form.items.length})
          </h4>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 h-8"
            onClick={() => setForm((prev) => ({ ...prev, items: [...prev.items, itemVacio()] }))}
          >
            <Plus className="h-3.5 w-3.5" /> Agregar material
          </Button>
        </div>

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
                    <Input
                      className="h-8 font-mono"
                      inputMode="numeric"
                      value={it.codigo}
                      onChange={(e) => setItem(idx, { codigo: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-8"
                        value={it.descripcion}
                        onChange={(e) => setItem(idx, { descripcion: e.target.value })}
                      />
                      {it.enCatalogo ? (
                        <span title="En catálogo">
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        </span>
                      ) : it.revision ? (
                        <span title="Fuera de catálogo">
                          <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
                        </span>
                      ) : null}
                    </div>
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
                      onChange={(e) => setItem(idx, { unidad: e.target.value.toUpperCase() })}
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
                <Input
                  className="h-9 flex-1 font-mono"
                  inputMode="numeric"
                  placeholder="Código"
                  value={it.codigo}
                  onChange={(e) => setItem(idx, { codigo: e.target.value })}
                />
                {it.enCatalogo ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                ) : it.revision ? (
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
              <Input
                className="h-9"
                placeholder="Descripción"
                value={it.descripcion}
                onChange={(e) => setItem(idx, { descripcion: e.target.value })}
              />
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
                  onChange={(e) => setItem(idx, { unidad: e.target.value.toUpperCase() })}
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
          disabled={saving}
          className="gap-2 h-10 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
          Registrar RQ
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
  )
}
