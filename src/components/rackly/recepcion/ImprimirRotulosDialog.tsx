'use client'

/**
 * RACKLY — Recepción · Modal "Imprimir rótulos" (Zebra ZT411 por USB).
 *
 * Flujo:
 *   1. Al abrir, sondea Zebra Browser Print (http://localhost:9100) y lista
 *      las impresoras; preselecciona la del sistema (GET /default).
 *   2. El usuario digita las etiquetas que necesita de CADA artículo
 *      (o "aplicar a todos"). El tamaño es FIJO: etiqueta de 10 × 15 cm
 *      con el formato PERECIBLE de la empresa (plantilla "ETIQUETA ALMACEN
 *      insumos.xlsm"), replicado en ZPL 1:1.
 *   3. "Imprimir" genera TODO el ZPL (^CI28 UTF-8) y lo envía en UN SOLO
 *      trabajo (un POST /write con todos los ^XA…^XZ concatenados).
 *      "Descargar .zpl" es el PLAN B sin middleware: el archivo se imprime
 *      con Zebra Setup Utilities (arrastrar al ícono de envío).
 *   4. La prop `nota` permite contextualizar el modal tras GUARDAR la
 *      recepción: se abre con los artículos ya registrados en la BD.
 *
 * Si el servicio no responde se muestra la guía de instalación/permisos en el
 * propio modal (no es un error del app: Browser Print corre en la PC de la
 * impresora, y Chrome 142+ además exige permiso de "Dispositivos de red
 * local" para el sitio).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  detectarServicioZebra,
  descubrirImpresorasZebra,
  obtenerImpresoraDefaultZebra,
  enviarZPL,
  construirZPLRotulos,
  type ImpresoraZebra,
  type DatosRotulo,
  type EncabezadoRotulo,
  type MotivoFallaZebra,
} from '@/lib/rackly/zebra'
import type { ItemRecepcion } from '@/components/rackly/recepcion/RecepcionItemsEditor'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Loader2,
  Printer,
  RefreshCw,
  Download,
  MonitorDown,
  Package,
} from 'lucide-react'

type EstadoServicio = 'verificando' | 'activo' | 'no-encontrado'

export type RotuloAImprimir = DatosRotulo & { copias: number }

/**
 * Mapea los artículos del editor de recepción (misma fuente para la vía
 * foto y la manual) a rótulos imprimibles, con 1 copia por artículo.
 * Solo se pasan artículos CON código: un rótulo sin código no sirve
 * (el código de barras es su identificador en Racks/Piso).
 */
export function rotulosDesdeItems(items: ItemRecepcion[]): RotuloAImprimir[] {
  return items
    .filter((it) => it.codigo.trim())
    .map((it) => ({
      codigo: it.codigo.trim(),
      descripcion: it.descripcion.trim(),
      cantidad: it.cantidad,
      unidad: it.unidad,
      lote: it.lote,
      fechaProduccion: it.fechaProduccion,
      fechaVencimiento: it.fechaVencimiento,
      copias: 1,
    }))
}

export function ImprimirRotulosDialog({
  open,
  onOpenChange,
  rotulos,
  encabezado,
  nota,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rotulos: RotuloAImprimir[]
  encabezado: EncabezadoRotulo
  /** Banner contextual (p. ej. "Recepción guardada") cuando se abre tras guardar. */
  nota?: string
}) {
  const [estado, setEstado] = useState<EstadoServicio>('verificando')
  /** Por qué falló la detección (guía diferenciada en el panel amber). */
  const [motivo, setMotivo] = useState<MotivoFallaZebra>('sin-servicio')
  const [impresoras, setImpresoras] = useState<ImpresoraZebra[]>([])
  const [seleccion, setSeleccion] = useState<string>('')
  const [copias, setCopias] = useState<number[]>([])
  const [copiasTodos, setCopiasTodos] = useState('')
  const [imprimiendo, setImprimiendo] = useState(false)

  const sondear = useCallback(async () => {
    setEstado('verificando')
    setImpresoras([])
    setSeleccion('')
    // 1) Detectar el middleware (y SU MOTIVO de falla si no responde).
    const det = await detectarServicioZebra()
    if (!det.base) {
      setMotivo(det.motivo)
      setEstado('no-encontrado')
      return
    }
    // 2) Con el servicio vivo, listar impresoras y preseleccionar la default.
    const lista = await descubrirImpresorasZebra()
    setImpresoras(lista)
    if (lista.length === 0) {
      setMotivo('sin-servicio')
      setEstado('no-encontrado')
      return
    }
    const porDefecto = await obtenerImpresoraDefaultZebra()
    const elegida =
      lista.find((p) => porDefecto && p.uid === porDefecto.uid) ?? lista[0]
    setSeleccion(elegida.uid)
    setEstado('activo')
  }, [])

  useEffect(() => {
    if (open) {
      setCopias(rotulos.map(() => 1))
      void sondear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function setCopiasDe(idx: number, valor: number) {
    setCopias((prev) => prev.map((c, i) => (i === idx ? Math.max(1, Math.min(999, Math.round(valor || 1))) : c)))
  }

  /** Misma cantidad de etiquetas para TODOS los artículos de una vez. */
  function aplicarCopiasATodos() {
    const n = Number(copiasTodos)
    if (!n || n < 1) return
    const v = Math.min(999, Math.round(n))
    setCopias(rotulos.map(() => v))
    setCopiasTodos('')
  }

  const totalEtiquetas = rotulos.reduce((s, _r, i) => s + (copias[i] ?? 1), 0)

  function zplActual(): string {
    return construirZPLRotulos(
      rotulos,
      copias.map((c) => c || 1),
      encabezado
    )
  }

  async function imprimir() {
    const impresora = impresoras.find((p) => p.uid === seleccion)
    if (!impresora) {
      toast.error('Selecciona una impresora')
      return
    }
    setImprimiendo(true)
    try {
      await enviarZPL(impresora, zplActual())
      toast.success(`${totalEtiquetas} etiqueta(s) enviadas en UN solo trabajo a ${impresora.name}`)
      onOpenChange(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo imprimir', { description: message })
    } finally {
      setImprimiendo(false)
    }
  }

  function descargar() {
    const blob = new Blob([zplActual()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const guia = (encabezado.numeroDocumento || 'rotulos').replace(/[^\w-]+/g, '_')
    a.download = `rotulos_${guia}.zpl`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.info('Archivo .zpl descargado', {
      description: 'Ábrelo con Zebra Setup Utilities (arrastrar al ícono de enviar) para imprimirlo.',
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] max-w-lg max-h-[85vh] overflow-y-auto overscroll-contain">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4 text-amber-600" /> Imprimir rótulos
          </DialogTitle>
          <DialogDescription>
            {rotulos.length} artículo(s) · etiqueta 10 × 15 cm · formato PERECIBLE de la empresa.
          </DialogDescription>
        </DialogHeader>

        {nota && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800">
            {nota}
          </p>
        )}

        {/* Copias por artículo: digitable SIEMPRE (con o sin Browser Print). */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">Etiquetas por artículo</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                max={999}
                placeholder="N"
                value={copiasTodos}
                onChange={(e) => setCopiasTodos(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && aplicarCopiasATodos()}
                className="h-7 w-14 text-xs text-right"
                title="Misma cantidad de etiquetas para todos los artículos"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={aplicarCopiasATodos}
                disabled={rotulos.length === 0}
              >
                Aplicar a todos
              </Button>
            </div>
          </div>
          <div className="rounded-lg border divide-y max-h-44 overflow-y-auto">
            {rotulos.map((r, i) => (
              <div key={`${r.codigo}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <Package className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate">
                    {r.codigo || '(sin código)'}
                    {r.descripcion ? ` · ${r.descripcion}` : ''}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    Cant.: {r.cantidad}{r.unidad ? ` ${r.unidad}` : ''}
                    {r.lote ? ` · Lote ${r.lote}` : ''}
                  </p>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={999}
                  value={copias[i] ?? 1}
                  onChange={(e) => setCopiasDe(i, Number(e.target.value))}
                  className="h-7 w-16 text-xs text-right"
                  title="Etiquetas de este artículo"
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            Total: <b className="text-slate-600">{totalEtiquetas}</b> etiqueta(s) · se envían todas en
            {' '}<b className="text-slate-600">un solo trabajo</b> de impresión.
          </p>
        </div>

        {estado === 'verificando' && (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando Zebra Browser Print en esta computadora…
          </div>
        )}

        {estado === 'no-encontrado' && (
          <div className="space-y-2 text-sm">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <p className="font-semibold mb-1">
                {motivo === 'permiso-bloqueado'
                  ? 'Chrome bloqueó la conexión con la impresora local'
                  : 'No se detectó Zebra Browser Print'}
              </p>
              <p className="text-xs leading-relaxed">
                {motivo === 'permiso-bloqueado'
                  ? 'El navegador denegó el salto del sitio hacia el programa local (protección de "red local"). Se concede UNA vez por computadora:'
                  : 'El navegador no puede hablar con la impresora USB directamente. Hace falta el programa gratuito Zebra Browser Print corriendo en la PC donde está conectada la ZT411. Si YA lo tienes instalado, es casi seguro el bloqueo de red local de Chrome:'}
              </p>
            </div>
            <ol className="list-decimal list-inside text-xs text-slate-600 space-y-1 py-1">
              <li>
                Instala o ACTUALIZA Browser Print:{' '}
                <a
                  className="text-sky-700 font-semibold underline"
                  href="https://www.zebra.com/browserprint"
                  target="_blank"
                  rel="noreferrer"
                >
                  zebra.com/browserprint
                </a>{' '}
                (versiones antiguas no pasan el control de seguridad de Chrome) y déjalo abierto
                (ícono junto al reloj de Windows).
              </li>
              <li>
                Concede el permiso local: ícono de la barra de direcciones → Permisos →{' '}
                <b>Dispositivos de red local</b> → Permitir (o abre
                <code className="mx-1 rounded bg-slate-100 px-1">chrome://settings/content/localNetworkAccess</code>
                y permite rackly.pages.dev). Si Chrome pregunta "¿acceder a dispositivos de tu red
                local?" → <b>Permitir</b>.
              </li>
              <li>
                Enciende la ZT411. Si al imprimir pide certificado, abre{' '}
                <a
                  className="text-sky-700 underline"
                  href="https://localhost:9101"
                  target="_blank"
                  rel="noreferrer"
                >
                  https://localhost:9101
                </a>{' '}
                y acéptalo una sola vez.
              </li>
            </ol>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void sondear()} className="flex-1 gap-2">
                <RefreshCw className="h-4 w-4" /> Reintentar detección
              </Button>
              <Button variant="outline" onClick={descargar} className="flex-1 gap-2" title="Plan B: imprimir con Zebra Setup Utilities">
                <Download className="h-4 w-4" /> Plan B: .zpl
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Plan B sin permisos: descarga los rótulos como archivo .zpl y envíalos a la impresora
              con Zebra Setup Utilities (arrastrar al ícono de envío).
            </p>
          </div>
        )}

        {estado === 'activo' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Impresora</Label>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void sondear()}>
                  <RefreshCw className="h-3 w-3" /> Buscar de nuevo
                </Button>
              </div>
              <Select value={seleccion} onValueChange={setSeleccion}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Selecciona impresora" />
                </SelectTrigger>
                <SelectContent>
                  {impresoras.map((p) => (
                    <SelectItem key={p.uid} value={p.uid}>
                      {p.name}
                      {p.connection ? ` (${p.connection})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
              <span className="text-xs text-slate-500">Tamaño de etiqueta</span>
              <span className="text-xs font-bold text-slate-700">10 × 15 cm · formato PERECIBLE</span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => void imprimir()}
                disabled={imprimiendo || rotulos.length === 0}
                className="flex-1 gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
              >
                {imprimiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                Imprimir todo de una vez ({totalEtiquetas})
              </Button>
              <Button variant="outline" onClick={descargar} className="gap-2" title="Plan B: imprimir con Zebra Setup Utilities">
                <Download className="h-4 w-4" /> .zpl
              </Button>
            </div>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <MonitorDown className="h-3 w-3" />
              La impresión va directa por Zebra Browser Print instalado en la PC de la impresora.
            </p>
            <details className="text-[11px] text-slate-400">
              <summary className="cursor-pointer hover:text-slate-600">
                ¿Sin el programa? Descarga los rótulos como .zpl
              </summary>
              <Button variant="outline" onClick={descargar} className="mt-1.5 w-full gap-2">
                <Download className="h-4 w-4" /> Descargar {totalEtiquetas} rótulo(s) en .zpl
              </Button>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
