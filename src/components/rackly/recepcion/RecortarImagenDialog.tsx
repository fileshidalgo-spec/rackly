'use client'

/**
 * RACKLY — Recepción · Recorte de la foto de la guía.
 *
 * Qué resuelve: la foto salía COMPLETA al OCR y al registro (mesa de fondo,
 * hojas ajenas, bordes oscuros). El usuario pidió poder recortar ANTES de
 * procesar para que solo la parte de la guía se escanee y se guarde.
 *
 * Cómo (modelo WhatsApp/cámara, reescrito 2026-10): el MARCO se arrastra
 * para moverlo y se redimensiona desde sus 4 esquinas — SIEMPRE responde,
 * aunque la imagen encaje exacto en el aspecto (con react-easy-crop una foto
 * vertical 3:4 en aspecto Vertical quedaba sin recorrido y "no dejaba
 * recortar"). Geometría pura en recorte-marco.ts (testeada) + Pointer Events
 * (mouse/táctil/lápiz con setPointerCapture). La imagen de TRABAJO se decodifica
 * 1 vez y se techa a 2800px/16Mpx (memoria móvil); el recorte FINAL se hace
 * sobre la ORIGINAL (sin pérdida por el preview) y alimenta TODO el pipeline
 * existente sin cambios: mejorarImagenOCR → OCR (2 pasadas + zoom de tabla)
 * → foto liviana → Storage. La rotación (90°) está para las fotos de lado.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Crop, Loader2, RotateCw, ScanLine, X } from 'lucide-react'
import {
  escalaPorArea,
  marcoInicial,
  moverMarco,
  redimensionarMarco,
  rectANatural,
  type Esquina,
  type Rect,
} from '@/lib/rackly/recorte-marco'
import { mensajeError } from '@/lib/rackly/errores'

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
  { clave: 'libre', etiqueta: 'Libre', valor: 0 },
] as const

const MAX_LADO = 2800 // mismo techo que el pipeline OCR (letra pequeña legible)

/**
 * Recorta `area` (px NATURALES sobre la imagen GIRADA `rotacion` grados) de
 * `archivo`, lo escala a MAX_LADO si excede y devuelve un JPEG de calidad
 * 0.92. Basado en el helper canónico de recorte en canvas (rotación incluida).
 *
 * HARDENING (2026-10): el canvas intermedio se escala si su área excede
 * MAX_AREA_CANVAS — las fotos de 48 MP reventaban el canvas en iOS
 * (límite ~16.7 Mpx) y el recorte salía EN BLANCO. Con el escalado, el
 * recorte de fotos enormes sale igual (solo pierde resolución sobrante:
 * el resultado ya estaba techado a MAX_LADO).
 */
export async function recortarImagen(
  archivo: Blob,
  area: Rect,
  rotacion: number,
  maxLado = MAX_LADO
): Promise<Blob> {
  const imagen = await createImageBitmap(archivo)

  // 1) Lienzo con la imagen ROTADA: caja delimitadora del giro (con techo de área).
  const rad = (rotacion * Math.PI) / 180
  const seno = Math.abs(Math.sin(rad))
  const coseno = Math.abs(Math.cos(rad))
  const cajaW = imagen.width * coseno + imagen.height * seno
  const cajaH = imagen.width * seno + imagen.height * coseno
  // Techo combinado: lado máximo (resolución de salida) + área máxima (memoria móvil).
  let k = Math.min(1, maxLado / Math.max(cajaW, cajaH))
  k *= escalaPorArea(cajaW * k, cajaH * k)
  const girado = document.createElement('canvas')
  girado.width = Math.round(cajaW * k)
  girado.height = Math.round(cajaH * k)
  const ctx = girado.getContext('2d')
  if (!ctx) throw new Error('El navegador no permitió preparar el recorte')
  ctx.translate(girado.width / 2, girado.height / 2)
  ctx.rotate(rad)
  ctx.scale(k, k)
  ctx.drawImage(imagen, -imagen.width / 2, -imagen.height / 2)

  // 2) Recorte del área seleccionada (clamp defensivo a la caja girada escalada).
  const W = girado.width
  const H = girado.height
  const ax = Math.max(0, Math.min(area.x * k, W - 1))
  const ay = Math.max(0, Math.min(area.y * k, H - 1))
  const aw = Math.max(1, Math.min(area.w * k, W - ax))
  const ah = Math.max(1, Math.min(area.h * k, H - ay))

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

/**
 * Imagen de TRABAJO: la original GIRADA `rotacion` grados y techada a
 * maxLado por lado + techo de área (memoria móvil). Es la que se muestra y
 * la referencia para el marco; el RECORTE FINAL siempre se hace sobre la
 * ORIGINAL (recortarImagen) multiplicando el área por 1/escala — sin
 * pérdida generacional por re-encode del preview.
 */
async function construirImagenTrabajo(
  archivo: Blob,
  rotacion: number,
  maxLado = MAX_LADO
): Promise<{ blob: Blob; w: number; h: number; escala: number }> {
  const bmp = await createImageBitmap(archivo)
  try {
    const rad = (rotacion * Math.PI) / 180
    const seno = Math.abs(Math.sin(rad))
    const coseno = Math.abs(Math.cos(rad))
    const cajaW = bmp.width * coseno + bmp.height * seno
    const cajaH = bmp.width * seno + bmp.height * coseno
    let k = Math.min(1, maxLado / Math.max(cajaW, cajaH))
    k *= escalaPorArea(cajaW * k, cajaH * k)
    const c = document.createElement('canvas')
    c.width = Math.round(cajaW * k)
    c.height = Math.round(cajaH * k)
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('El navegador no permitió preparar la foto')
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate(rad)
    ctx.scale(k, k)
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2)
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo preparar la foto'))), 'image/jpeg', 0.92)
    )
    return { blob, w: c.width, h: c.height, escala: k }
  } finally {
    bmp.close?.()
  }
}

/** Tamaño CSS del <img> para encajar la imagen (w×h) en la caja (cw×ch). */
function encajar(cw: number, ch: number, w: number, h: number): { w: number; h: number } {
  if (!cw || !ch || !w || !h) return { w: 0, h: 0 }
  const s = Math.min(cw / w, ch / h)
  return { w: Math.floor(w * s), h: Math.floor(h * s) }
}

const ESQUINAS: Esquina[] = ['nw', 'ne', 'sw', 'se']

export function RecortarImagenDialog({
  open,
  archivo,
  origen,
  onCancelar,
  onAplicar,
  onUsarCompleto,
}: PropsRecorte) {
  /** URL de la imagen de TRABAJO (girada + techada) — la que se muestra. */
  const [url, setUrl] = useState('')
  /** Naturales de la imagen de trabajo. */
  const [dims, setDims] = useState({ w: 0, h: 0 })
  /** Caja visible del contenedor (px CSS). */
  const [caja, setCaja] = useState({ w: 0, h: 0 })
  /** Tamaño CSS del <img> encajado en la caja. */
  const [fit, setFit] = useState({ w: 0, h: 0 })
  /** Marco de recorte en px CSS del escenario (el <img> encajado). */
  const [marco, setMarco] = useState<Rect | null>(null)
  const [aspecto, setAspecto] = useState<number>(ASPECTOS[0].valor)
  const [rotacion, setRotacion] = useState(0)
  const [preparando, setPreparando] = useState(false)
  const [aplicando, setAplicando] = useState(false)
  const [errorPrep, setErrorPrep] = useState('')
  /** Nodo del escenario — callback ref: Radix monta el portal ASINCRÓNICO, un
   *  effect por [open] llegaba a contRef null y la caja quedaba en 0×0 (el
   *  escenario jamás se dibujaba). El callback ref dispara al montar el nodo. */
  const [contEl, setContEl] = useState<HTMLDivElement | null>(null)
  /** Escala aplicada al construir la imagen de trabajo (trabajo → original girada). */
  const escalaRef = useRef(1)
  /** objectURL VIGENTE de la imagen de trabajo — para revocarlo al CERRAR el
   *  diálogo (antes el último blob (varios MB en móvil) quedaba retenido hasta
   *  recargar la página: las rotaciones superadas ya se revocan en setUrl). */
  const urlRef = useRef('')
  const dragRef = useRef<{
    modo: 'mover' | 'resize'
    esquina?: Esquina
    lastX: number
    lastY: number
  } | null>(null)

  // ── Cierre del diálogo: revocar el objectURL VIGENTE (el último blob
  //    retenido hasta recargar la página). Unmount-only ([]). ──
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = ''
      }
    }
  }, [])

  // ── Construcción de la imagen de trabajo (al abrir y al rotar) ──
  useEffect(() => {
    if (!archivo || !open) return
    let vigente = true
    setPreparando(true)
    setErrorPrep('')
    construirImagenTrabajo(archivo, rotacion)
      .then(({ blob, w, h, escala }) => {
        if (!vigente) return
        const u = URL.createObjectURL(blob)
        urlRef.current = u
        escalaRef.current = escala
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return u
        })
        setDims({ w, h })
        setMarco(null) // el marco se reinicia centrado al llegar el fit nuevo
      })
      .catch((err: unknown) => {
        if (!vigente) return
        // FIX auditoría 2026-10-16: revocar también el objectURL que pudiera
        // haber quedado de un fit anterior — antes solo se limpiaba el estado
        // y el blob (varios MB en móvil) quedaba retenido sin referencia.
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return ''
        })
        urlRef.current = '' // el unmount ya no debe revocar una URL ya revocada
        const message = mensajeError(err)
        setErrorPrep(message)
      })
      .finally(() => {
        if (vigente) setPreparando(false)
      })
    return () => {
      vigente = false
    }
  }, [archivo, open, rotacion])

  // ── Medición del contenedor (callback ref + ResizeObserver: giro del
  //    celular incluido; se re-mide si el nodo se remonta) ──
  useEffect(() => {
    if (!contEl) return
    const medir = () => {
      const r = contEl.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setCaja({ w: r.width, h: r.height })
    }
    medir()
    const ro = new ResizeObserver(medir)
    ro.observe(contEl)
    return () => ro.disconnect()
  }, [contEl])

  // ── Encaje del <img> dentro de la caja ──
  useEffect(() => {
    setFit(encajar(caja.w, caja.h, dims.w, dims.h))
  }, [caja, dims])

  // ── Marco: nace/reinicia centrado con el aspecto elegido. `url` en deps:
  //    con la MISMA imagen 2ª vez, fit no cambia de valor y sin url el marco
  //    quedaba null para siempre (segunda foto = sin marco). ──
  useEffect(() => {
    if (url && fit.w > 0 && fit.h > 0) setMarco(marcoInicial(fit.w, fit.h, aspecto))
  }, [url, fit.w, fit.h, aspecto])

  // ── Arrastre (Pointer Events unificados: mouse + táctil + lápiz) ──
  function iniciarArrastre(modo: 'mover' | 'resize', esquina?: Esquina) {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (modo === 'resize') e.stopPropagation() // la esquina NO activa el mover del marco
      if (!marco || !fit.w) return
      e.preventDefault()
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* navegadores sin capture: el arrastre sigue funcionando con move/up */
      }
      dragRef.current = { modo, esquina, lastX: e.clientX, lastY: e.clientY }
    }
  }

  function enArrastre(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current
    if (!d || !marco || !fit.w) return
    const dx = e.clientX - d.lastX
    const dy = e.clientY - d.lastY
    if (!dx && !dy) return
    d.lastX = e.clientX
    d.lastY = e.clientY
    setMarco(
      d.modo === 'mover'
        ? moverMarco(marco, fit.w, fit.h, dx, dy)
        : redimensionarMarco(marco, fit.w, fit.h, d.esquina ?? 'se', dx, dy, aspecto)
    )
  }

  function finArrastre() {
    dragRef.current = null
  }

  async function aplicar() {
    if (!archivo || !marco || !fit.w || !dims.w) return
    setAplicando(true)
    try {
      // marco (CSS del escenario) → naturales de la imagen de TRABAJO →
      // naturales de la ORIGINAL girada (el espacio que recortarImagen espera).
      const enTrabajo = rectANatural(marco, fit.w, fit.h, dims.w, dims.h)
      const inv = 1 / (escalaRef.current || 1)
      const areaOriginal: Rect = {
        x: enTrabajo.x * inv,
        y: enTrabajo.y * inv,
        w: enTrabajo.w * inv,
        h: enTrabajo.h * inv,
      }
      const blob = await recortarImagen(archivo, areaOriginal, rotacion)
      const recorte = new File([blob], 'guia-recortada.jpg', { type: 'image/jpeg' })
      onAplicar(recorte)
    } catch (err: unknown) {
      const message = mensajeError(err)
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
            Arrastra el marco para moverlo y usa las <b>esquinas</b> para ajustarlo.{' '}
            <b>Solo la parte recortada</b> se escaneará y se guardará como foto del registro.
          </p>
        </DialogHeader>

        {/* ── Escenario de recorte: img encajada + marco móvil con esquinas ── */}
        <div
          ref={setContEl}
          className="relative h-[44dvh] max-h-[420px] min-h-[240px] w-full select-none overflow-hidden rounded-lg bg-slate-900"
        >
          {url && caja.w > 0 && fit.w > 0 && (
            <div
              className="absolute"
              style={{
                left: (caja.w - fit.w) / 2,
                top: (caja.h - fit.h) / 2,
                width: fit.w,
                height: fit.h,
              }}
            >
              <img
                src={url}
                alt="Foto de la guía a recortar"
                draggable={false}
                className="absolute inset-0 h-full w-full select-none"
              />
              {marco && (
                <div
                  className="absolute cursor-move touch-none"
                  style={{
                    left: marco.x,
                    top: marco.y,
                    width: marco.w,
                    height: marco.h,
                    boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.62)',
                  }}
                  onPointerDown={iniciarArrastre('mover')}
                  onPointerMove={enArrastre}
                  onPointerUp={finArrastre}
                  onPointerCancel={finArrastre}
                >
                  <div className="pointer-events-none absolute inset-0 rounded-[2px] border-2 border-white/90" />
                  {/* Rejilla de tercios (referencia visual para encuadrar) */}
                  <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/40" />
                  <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/40" />
                  {/* 4 esquinas: arrastrar para redimensionar (hit 36px = dedo) */}
                  {ESQUINAS.map((q) => (
                    <div
                      key={q}
                      role="button"
                      aria-label={`Redimensionar el recorte desde la esquina ${q}`}
                      className="absolute flex h-9 w-9 cursor-nwse-resize touch-none items-center justify-center"
                      style={{
                        top: q.includes('n') ? -18 : undefined,
                        bottom: q.includes('s') ? -18 : undefined,
                        left: q.includes('w') ? -18 : undefined,
                        right: q.includes('e') ? -18 : undefined,
                      }}
                      onPointerDown={iniciarArrastre('resize', q)}
                      onPointerMove={enArrastre}
                      onPointerUp={finArrastre}
                      onPointerCancel={finArrastre}
                    >
                      <span className="block h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-400 shadow-md" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {preparando && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-900/70 text-xs text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparando la foto…
            </div>
          )}
          {!url && !preparando && (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">
              {errorPrep
                ? `No se pudo preparar la foto: ${errorPrep}. Usa «Usar foto completa» o vuelve a intentarlo.`
                : 'Preparando la foto…'}
            </div>
          )}
        </div>

        {/* ── Controles: rotación + aspecto (el zoom ya no hace falta: las
               esquinas del marco SON el zoom, modelo WhatsApp/cámara) ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRotacion((r) => (r + 90) % 360)}
            disabled={preparando || aplicando}
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
            disabled={aplicando || preparando || !marco}
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
