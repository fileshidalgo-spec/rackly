'use client'

/**
 * RACKLY — TRÁNSITO · Lector de QR de rótulos (cámara + entrada manual).
 *
 * Qué hace: escanea el QR que Recepción imprime en cada rótulo
 * (RKLY|guía|Nº|artículo|Paleta — ver qr-rotulo.ts) y entrega el texto al
 * módulo para que resuelva la guía y abra la transferencia a Rack/Piso.
 *
 * DOS VÍAS de lectura (ambas siempre disponibles):
 *   1. CÁMARA — decode en vivo del video:
 *        · `BarcodeDetector` nativo si el navegador lo tiene (Android/
 *          ChromeOS/Mac) — rápido y sin costo de CPU.
 *        · fallback jsQR (WASM-free, pura JS) decodificando frames del
 *          canvas — funciona en TODO navegador (incl. Windows, donde el
 *          BarcodeDetector no está implementado).
 *   2. ENTRADA MANUAL — caja de texto que envía con Enter: pensada para
 *      PISTOLAS USB/Bluetooth (HID teclado: disparan y "escriben" el
 *      payload + Enter) y como rescate si la cámara no está disponible.
 *
 * PAUSA: mientras el diálogo de transferencia está abierto (`pausado`),
 * se deja de decodificar (la cámara sigue viva para reanudar al instante
 * al cerrar aquel) — nunca se dispara un escaneo debajo de otro flujo.
 *
 * COOLDOWN: tras una detección se ignora el MISMO símbolo 2.5 s — evita
 * re-disparos mientras el operario aparta el rótulo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  CameraOff,
  Keyboard,
  Loader2,
  ScanLine,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import jsQR from 'jsqr'

type Props = {
  open: boolean
  /** true = transferencia en curso: decodificación congelada. */
  pausado: boolean
  onOpenChange: (open: boolean) => void
  /** Texto decodificado (cámara o Enter manual), ya limpio de espacios. */
  onDetectar: (texto: string, fuente: 'camara' | 'manual') => void
  /** Copy alternativo (modo lote del puente Atención) — default: Tránsito. */
  titulo?: string
  descripcion?: string
  /**
   * Contador vivo del carrito (modo lote): se pinta en la barra inferior para
   * que el operario vea el acumulado sin salir del escáner.
   */
  contador?: { tomas: number; total: string }
}

/** Detector nativo (BarcodeDetector) tipado mínimo — no está en lib.dom. */
type DetectorLike = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }
type DetectorCtor = new (opts?: { formats?: string[] }) => DetectorLike

const INTERVALO_MS = 150
const COOLDOWN_MS = 2500

export function LectorQR({
  open,
  pausado,
  onOpenChange,
  onDetectar,
  titulo,
  descripcion,
  contador,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pausadoRef = useRef(pausado)
  const cooldownRef = useRef(0)
  const ultimoRef = useRef('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [estadoCam, setEstadoCam] = useState<'apagada' | 'iniciando' | 'activa' | 'error'>('apagada')
  const [errorCam, setErrorCam] = useState('')
  const [manual, setManual] = useState('')
  const [flash, setFlash] = useState(false)

  // Sincroniza `pausado` al ref del bucle SIN escribir refs durante render
  // (regla react-hooks/refs — React 19).
  useEffect(() => {
    pausadoRef.current = pausado
  }, [pausado])

  /** Feedback de éxito + entrega del texto (única puerta hacia el módulo). */
  const emitir = useCallback(
    (texto: string, fuente: 'camara' | 'manual') => {
      const limpio = texto.trim()
      if (!limpio) return
      cooldownRef.current = Date.now() + COOLDOWN_MS
      ultimoRef.current = limpio
      if (fuente === 'camara') {
        setFlash(true)
        setTimeout(() => setFlash(false), 350)
        try {
          navigator.vibrate?.(140)
        } catch {
          // Sin vibración (PC) — el flash basta.
        }
      }
      onDetectar(limpio, fuente)
    },
    [onDetectar]
  )

  /** Detiene tracks y bucle de decodificación — idempotente. */
  const detenerCamara = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  // ── Ciclo de vida de la cámara ──────────────────────────────────────
  useEffect(() => {
    if (!open) return
    let cancelado = false

    async function iniciar() {
      setEstadoCam('iniciando')
      setErrorCam('')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelado) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          try {
            await video.play()
          } catch {
            // Autoplay puede fallar en algunos navegadores hasta un gesto:
            // el diálogo ya nace de un clic, el reintento del tick lo cubre.
          }
        }
        setEstadoCam('activa')
      } catch (err: unknown) {
        if (cancelado) return
        const msg = err instanceof Error ? err.message : String(err)
        setErrorCam(
          /permission|denied|NotAllowed/i.test(msg)
            ? 'Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones (o usa la entrada manual / pistola USB).'
            : 'No se pudo acceder a la cámara en este dispositivo. Usa la entrada manual o una pistola USB.'
        )
        setEstadoCam('error')
      }
    }

    void iniciar()
    return () => {
      cancelado = true
      detenerCamara()
      setEstadoCam('apagada')
    }
  }, [open, detenerCamara])

  // ── Bucle de decodificación ─────────────────────────────────────────
  useEffect(() => {
    if (!open || estadoCam !== 'activa') return
    const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
    const nativo: DetectorLike | null = Ctor ? new Ctor({ formats: ['qr_code'] }) : null

    function tick() {
      if (pausadoRef.current) return
      if (Date.now() < cooldownRef.current) return
      const video = videoRef.current
      if (!video || video.readyState < 2) return

      if (nativo) {
        nativo
          .detect(video)
          .then((codes) => {
            const texto = codes.find((c) => c.rawValue)?.rawValue
            if (texto) emitir(texto, 'camara')
          })
          .catch(() => {
            // Frame ilegible: siguiente tick.
          })
        return
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const w = 480
      const h = Math.max(1, Math.round((video.videoHeight || 360) * (w / (video.videoWidth || 640))))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      const img = ctx.getImageData(0, 0, w, h)
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
      if (code?.data) emitir(code.data, 'camara')
    }

    timerRef.current = setInterval(tick, INTERVALO_MS)
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, estadoCam, emitir])

  // Foco al input manual al abrir (pistola USB lista sin clics).
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150)
  }, [open])

  function enviarManual(e: React.FormEvent) {
    e.preventDefault()
    if (!manual.trim()) return
    emitir(manual, 'manual')
    setManual('')
    inputRef.current?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92dvh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ScanLine className="h-4 w-4 text-fuchsia-600" />
            {titulo ?? 'Escanear rótulo'}
          </DialogTitle>
          <DialogDescription>
            {descripcion ??
              'Apunta al QR de la esquina izquierda del rótulo — abre la transferencia de ese artículo.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* ── Cámara ── */}
          <div className="relative rounded-xl overflow-hidden border border-slate-200 bg-slate-950 aspect-[4/3]">
            {/* El video SIEMPRE montado mientras el diálogo está abierto:
                pausar solo congela el decode (reanudado al instante). */}
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />

            {/* Marco guía */}
            {estadoCam === 'activa' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className={`h-44 w-44 rounded-2xl border-4 transition-colors ${flash ? 'border-emerald-400' : 'border-white/70'} shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]`} />
              </div>
            )}

            {flash && (
              <div className="pointer-events-none absolute inset-0 bg-emerald-400/25" />
            )}

            {estadoCam === 'iniciando' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-300 text-sm">
                <Loader2 className="h-6 w-6 animate-spin" /> Iniciando cámara…
              </div>
            )}

            {estadoCam === 'error' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center">
                <CameraOff className="h-7 w-7 text-rose-400" />
                <p className="text-xs text-slate-300 leading-relaxed">{errorCam}</p>
              </div>
            )}

            {pausado && estadoCam === 'activa' && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs font-semibold text-amber-300 text-center px-6">
                QR detectado — completa la transferencia; el escaneo sigue al cerrar.
              </div>
            )}

            {estadoCam === 'activa' && !pausado && (
              <div className="absolute bottom-2 left-0 right-0 flex justify-center">
                <span className="rounded-full bg-slate-950/60 px-2.5 py-1 text-[10px] font-medium text-slate-200 inline-flex items-center gap-1">
                  <Camera className="h-3 w-3" /> Buscando QR…
                </span>
              </div>
            )}
          </div>

          {/* ── Entrada manual (pistola USB / teclado) ── */}
          <form onSubmit={enviarManual} className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              <Keyboard className="h-3.5 w-3.5 text-slate-400" /> Entrada manual / pistola USB
            </label>
            <Input
              ref={inputRef}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Dispara la pistola o pega el código… (Enter para enviar)"
              className="h-10 font-mono text-xs"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Código del QR del rótulo"
            />
            <p className="text-[10px] text-slate-400">
              Las pistolas USB/Bluetooth escriben aquí y envían con Enter — no necesita cámara.
            </p>
          </form>
        </div>

        <div className="px-5 py-3 border-t bg-white shrink-0 flex items-center justify-between gap-2">
          {contador ? (
            <span
              className="text-[11px] font-bold text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2.5 py-1 truncate"
              aria-live="polite"
            >
              {contador.tomas} {contador.tomas === 1 ? 'toma' : 'tomas'} · Total {contador.total}
            </span>
          ) : (
            <p className="text-[11px] text-slate-400 truncate">Rótulos sin QR: usa la lista o la búsqueda.</p>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
