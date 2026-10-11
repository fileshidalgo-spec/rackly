'use client'

/**
 * RACKLY — Recepción · Recorte de la foto de la guía.
 *
 * Qué resuelve: la foto salía COMPLETA al OCR y al registro (mesa de fondo,
 * hojas ajenas, bordes oscuros). El usuario pidió poder recortar ANTES de
 * procesar para que solo la parte de la guía se escanee y se guarde.
 *
 * Cómo: react-easy-crop (touch-first: arrastrar con el dedo, pellizcar para
 * zoom, control deslizante de refuerzo) + recorte en canvas sobre la foto
 * ORIGINAL (no la miniatura) para no perder resolución de lectura.
 * La rotación (90°) está para las fotos tomadas de lado.
 *
 * El recorte alimenta TODO el pipeline existente sin cambios: mejorarImagenOCR
 * → OCR (2 pasadas + zoom de tabla) → foto liviana → Storage. El zoom de la
 * tabla usa coordenadas relativas a la MISMA imagen que entra al OCR, así que
 * el recorte también lo beneficia (menos ruido = mejor lectura).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { toast } from 'sonner'
import { Crop, Loader2, RotateCw, ScanLine, X } from 'lucide-react'

export type OrigenRecorte = 'inicio' | 'confirmar'

type PropsRecorte = {
  open: boolean
  archivo: File | null
  origen: OrigenRecorte
  onCancelar: () => void
  /** Recorte aplicado → se procesa (OCR) con la parte seleccionada. */
  onAplicar: (recorte: File) => void
  /** El usuario prefiere la foto completa (sin recortar). */
  onUsarCompleto: () => void
}

const ASPECTOS = [
  { clave: 'vertical', etiqueta: 'Vertical', valor: 3 / 4 },
  { clave: 'horizontal', etiqueta: 'Horizontal', valor: 4 / 3 },
  { clave: 'cuadrado', etiqueta: 'Cuadrado', valor: 1 },
] as const

const MAX_LADO = 2800 // mismo techo que el pipeline OCR (letra pequeña legible)

/**
 * Recorta `area` (coords de react-easy-crop sobre la imagen girada) de
 * `archivo`, lo escala a MAX_LADO si excede y devuelve un JPEG de calidad
 * 0.92. Basado en el helper canónico de react-easy-crop (rotación incluida).
 */
export async function recortarImagen(
  archivo: Blob,
  area: Area,
  rotacion: number,
  maxLado = MAX_LADO
): Promise<Blob> {
  const imagen = await createImageBitmap(archivo)

  // 1) Lienzo con la imagen ROTADA: caja delimitadora del giro.
  const rad = (rotacion * Math.PI) / 180
  const seno = Math.abs(Math.sin(rad))
  const coseno = Math.abs(Math.cos(rad))
  const cajaW = imagen.width * coseno + imagen.height * seno
  const cajaH = imagen.width * seno + imagen.height * coseno
  const girado = document.createElement('canvas')
  girado.width = Math.round(cajaW)
  girado.height = Math.round(cajaH)
  const ctx = girado.getContext('2d')
  if (!ctx) throw new Error('El navegador no permitió preparar el recorte')
  ctx.translate(cajaW / 2, cajaH / 2)
  ctx.rotate(rad)
  ctx.drawImage(imagen, -imagen.width / 2, -imagen.height / 2)

  // 2) Recorte del área seleccionada (clamp defensivo a la caja girada).
  const ax = Math.max(0, Math.min(area.x, cajaW - 1))
  const ay = Math.max(0, Math.min(area.y, cajaH - 1))
  const aw = Math.max(1, Math.min(area.width, cajaW - ax))
  const ah = Math.max(1, Math.min(area.height, cajaH - ay))

  // 3) Escala si el recorte excede el techo (mismo criterio que el OCR).
  const escala = Math.min(1, maxLado / Math.max(aw, ah))
  const destino = document.createElement('canvas')
  destino.width = Math.round(aw * escala)
  destino.height = Math.round(ah * escala)
  const ctx2 = destino.getContext('2d')
  if (!ctx2) throw new Error('El navegador no permitió generar el recorte')
  ctx2.imageSmoothingQuality = 'high'
  ctx2.drawImage(girado, ax, ay, aw, ah, 0, 0, destino.width, destino.height)

  // 4) Exportar JPEG.
  return await new Promise<Blob>((resolve, reject) => {
    destino.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('No se pudo generar el recorte'))),
      'image/jpeg',
      0.92
    )
  })
}

export function RecortarImagenDialog({
  open,
  archivo,
  origen,
  onCancelar,
  onAplicar,
  onUsarCompleto,
}: PropsRecorte) {
  const [url, setUrl] = useState('')
  const [zoom, setZoom] = useState(1)
  const [rotacion, setRotacion] = useState(0)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [aspecto, setAspecto] = useState<number>(ASPECTOS[0].valor)
  const [area, setArea] = useState<Area | null>(null)
  const [aplicando, setAplicando] = useState(false)
  const urlRef = useRef('')

  // objectURL de la foto a recortar (revocado al cerrar/cambiar).
  useEffect(() => {
    if (archivo && open) {
      const u = URL.createObjectURL(archivo)
      urlRef.current = u
      setUrl(u)
      setZoom(1)
      setRotacion(0)
      setCrop({ x: 0, y: 0 })
      setArea(null)
      return () => {
        URL.revokeObjectURL(u)
        urlRef.current = ''
      }
    }
  }, [archivo, open])

  const onCropComplete = useMemo(
    () => (_: Area, px: Area) => setArea(px),
    []
  )

  async function aplicar() {
    if (!archivo || !area) return
    setAplicando(true)
    try {
      const blob = await recortarImagen(archivo, area, rotacion)
      const recorte = new File([blob], 'guia-recortada.jpg', { type: 'image/jpeg' })
      onAplicar(recorte)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo recortar la foto', { description: message })
    } finally {
      setAplicando(false)
    }
  }

  const esReajuste = origen === 'confirmar'

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancelar()}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-lg gap-3 rounded-xl p-4 sm:p-5">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-amber-900">
            <Crop className="h-4 w-4 text-amber-600" />
            {esReajuste ? 'Reajustar el recorte' : 'Recorta la foto de la guía'}
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Arrastra para encuadrar la guía; pellizca (o usa el control) para acercar.{' '}
            <b>Solo la parte recortada</b> se escaneará y se guardará como foto del registro.
          </p>
        </DialogHeader>

        <div className="relative h-[44dvh] max-h-[420px] min-h-[240px] w-full overflow-hidden rounded-lg bg-slate-900">
          {url ? (
            <Cropper
              image={url}
              crop={crop}
              zoom={zoom}
              rotation={rotacion}
              aspect={aspecto}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="contain"
              mediaProps={{ alt: 'Foto de la guía a recortar' }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">
              Preparando la foto…
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRotacion((r) => (r + 90) % 360)}
            className="gap-1.5 shrink-0 text-xs"
            aria-label="Rotar 90 grados"
          >
            <RotateCw className="h-3.5 w-3.5" /> Rotar
          </Button>
          <div className="flex gap-1 shrink-0">
            {ASPECTOS.map((a) => (
              <button
                key={a.clave}
                type="button"
                onClick={() => setAspecto(a.valor)}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                  aspecto === a.valor
                    ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {a.etiqueta}
              </button>
            ))}
          </div>
          <Slider
            value={[zoom]}
            min={1}
            max={3}
            step={0.05}
            onValueChange={(v) => setZoom(v[0] ?? 1)}
            className="flex-1"
            aria-label="Zoom del recorte"
          />
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancelar}
            disabled={aplicando}
            className="gap-1.5 text-xs"
          >
            <X className="h-3.5 w-3.5" /> Cancelar
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onUsarCompleto}
            disabled={aplicando}
            className="gap-1.5 text-xs"
          >
            Usar foto completa
          </Button>
          <Button
            type="button"
            onClick={aplicar}
            disabled={aplicando || !area}
            className="gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
          >
            {aplicando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
            Recortar y escanear
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
