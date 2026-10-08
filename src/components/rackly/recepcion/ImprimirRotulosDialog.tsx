'use client'

/**
 * RACKLY — Recepción · Modal "Imprimir rótulos" (Zebra ZT411 por USB).
 *
 * Flujo:
 *   1. Al abrir, sondea Zebra Browser Print (http://localhost:9100) y lista
 *      las impresoras; preselecciona la del sistema (GET /default).
 *   2. El usuario elige tamaño de etiqueta (4×6 o 4×2) y copias por artículo.
 *   3. "Imprimir" genera ZPL (^CI28 UTF-8, Code128 del código) y lo envía por
 *      POST /write. "Descargar .zpl" es el PLAN B sin middleware: el archivo
 *      se imprime con Zebra Setup Utilities (arrastrar al ícono de envío).
 *
 * Si el servicio no responde se muestra la guía de instalación en el propio
 * modal (no es un error del app: Browser Print corre en la PC de la impresora).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  descubrirImpresorasZebra,
  obtenerImpresoraDefaultZebra,
  enviarZPL,
  construirZPLRotulos,
  type ImpresoraZebra,
  type DatosRotulo,
  type EncabezadoRotulo,
  type TamanoRotulo,
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rotulos: RotuloAImprimir[]
  encabezado: EncabezadoRotulo
}) {
  const [estado, setEstado] = useState<EstadoServicio>('verificando')
  const [impresoras, setImpresoras] = useState<ImpresoraZebra[]>([])
  const [seleccion, setSeleccion] = useState<string>('')
  const [tamano, setTamano] = useState<TamanoRotulo>('4x6')
  const [copias, setCopias] = useState<number[]>([])
  const [imprimiendo, setImprimiendo] = useState(false)

  const sondear = useCallback(async () => {
    setEstado('verificando')
    setImpresoras([])
    setSeleccion('')
    const lista = await descubrirImpresorasZebra()
    setImpresoras(lista)
    if (lista.length === 0) {
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

  const totalEtiquetas = rotulos.reduce((s, _r, i) => s + (copias[i] ?? 1), 0)

  function zplActual(): string {
    return construirZPLRotulos(
      rotulos,
      copias.map((c) => c || 1),
      encabezado,
      tamano
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
      toast.success(`${totalEtiquetas} rótulo(s) enviados a ${impresora.name}`)
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
            {rotulos.length} artículo(s) · Zebra ZT411 conectada por USB a esta computadora.
          </DialogDescription>
        </DialogHeader>

        {estado === 'verificando' && (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando Zebra Browser Print en esta computadora…
          </div>
        )}

        {estado === 'no-encontrado' && (
          <div className="space-y-2 text-sm">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <p className="font-semibold mb-1">No se detectó Zebra Browser Print</p>
              <p className="text-xs leading-relaxed">
                El navegador no puede hablar con la impresora USB directamente. Instala el
                programa gratuito <b>Zebra Browser Print</b> en la computadora donde está
                conectada la ZT411 y vuelve a abrir este diálogo (no hace falta reiniciar).
              </p>
            </div>
            <ol className="list-decimal list-inside text-xs text-slate-600 space-y-1 py-1">
              <li>
                Descarga e instala:{' '}
                <a
                  className="text-sky-700 font-semibold underline"
                  href="https://www.zebra.com/browserprint"
                  target="_blank"
                  rel="noreferrer"
                >
                  zebra.com/browserprint
                </a>
              </li>
              <li>Enciende la ZT411 y verifica que aparezca lista en el programa.</li>
              <li>
                Si al imprimir pide certificado, abre{' '}
                <a className="text-sky-700 underline" href="https://localhost:9101" target="_blank" rel="noreferrer">
                  https://localhost:9101
                </a>{' '}
                y acepta el aviso una sola vez.
              </li>
            </ol>
            <p className="text-xs text-slate-500">
              Mientras tanto puedes descargar los rótulos como archivo .zpl y enviarlos a la
              impresora con Zebra Setup Utilities.
            </p>
            <Button variant="outline" onClick={descargar} className="w-full gap-2">
              <Download className="h-4 w-4" /> Descargar {totalEtiquetas} rótulo(s) en .zpl
            </Button>
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

            <div className="space-y-1.5">
              <Label className="text-xs">Tamaño de etiqueta</Label>
              <Select value={tamano} onValueChange={(v) => setTamano(v as TamanoRotulo)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="4x6">4×6 pulgadas (100×150 mm) — rótulo completo</SelectItem>
                  <SelectItem value="4x2">4×2 pulgadas (100×50 mm) — compacto</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Copias por artículo</Label>
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
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => void imprimir()}
                disabled={imprimiendo || rotulos.length === 0}
                className="flex-1 gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
              >
                {imprimiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                Imprimir {totalEtiquetas} rótulo(s)
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
