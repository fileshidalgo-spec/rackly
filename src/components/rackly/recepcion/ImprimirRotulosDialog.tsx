'use client'

/**
 * RACKLY — Recepción · Modal "Imprimir rótulos" (Zebra ZT411 por USB).
 *
 * Flujo:
 *   1. Al abrir, sondea Zebra Browser Print (http://localhost:9100) y lista
 *      las impresoras; preselecciona la del sistema (GET /default).
 *   2. El usuario digita las etiquetas que necesita de CADA artículo
 *      (o "aplicar a todos"). El tamaño es FIJO: etiqueta APaisada de
 *      15 × 10 cm (impresa girada en la tira 10 × 15) con el formato
 *      PERECIBLE de la empresa (plantilla "ETIQUETA ALMACEN insumos.xlsm"),
 *      replicado en ZPL 1:1.
 *   3. "Imprimir" genera TODO el ZPL (^CI28 UTF-8) y lo envía en UN SOLO
 *      trabajo (un POST /write con todos los ^XA…^XZ concatenados).
 *      "Plan B: .zpl" es la vía sin middleware: el archivo se imprime
 *      con Zebra Setup Utilities (arrastrar al ícono de envío).
 *   4. La prop `nota` permite contextualizar el modal tras GUARDAR la
 *      recepción: se abre con los artículos ya registrados en la BD.
 *   5. Agrupación por guía: `rotulos` llega SIEMPRE con la guía completa
 *      (instantánea post-guardado o `listarRecepcionesPorDocumento` desde
 *      la lista) — los artículos se confirman juntos en esta única ventana.
 *
 * Layout responsive (PC y móvil): caja flex con altura máxima en `dvh` —
 *   · cabecera FIJA (título + ficha de la guía),
 *   · contenido DESLIZABLE (copias por artículo + estado del servicio),
 *   · pie FIJO (total + acciones): los botones nunca se van fuera de vista.
 *
 * Si el servicio no responde se muestra la guía de instalación/permisos en el
 * propio modal (no es un error del app: Browser Print corre en la PC de la
 * impresora, y Chrome 142+ además exige permiso de "Dispositivos de red
 * local" para el sitio).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { expandirEnFilas } from '@/lib/rackly/recepcion-filas'
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
} from 'lucide-react'

type EstadoServicio = 'verificando' | 'activo' | 'no-encontrado'

export type RotuloAImprimir = DatosRotulo & { copias: number }

/**
 * Mapea los artículos del editor de recepción (misma fuente para la vía
 * foto y la manual) a rótulos imprimibles, con 1 copia por rótulo.
 * PASA por `expandirEnFilas`: un artículo DIVIDIDO en N paletas produce
 * N rótulos (mismo código, cantidad propia por paleta) — rotular paleta
 * por paleta es el motivo de la división.
 * Solo se pasan rótulos CON código: un rótulo sin código no sirve
 * (el código de barras es su identificador en Racks/Piso).
 */
export function filasARotulos(items: ItemRecepcion[]): RotuloAImprimir[] {
  return expandirEnFilas(items)
    .filter((f) => f.codigo)
    .map((f) => ({
      codigo: f.codigo,
      descripcion: f.descripcion,
      cantidad: f.cantidad,
      unidad: f.unidad,
      lote: f.lote,
      fechaProduccion: f.fechaProduccion,
      fechaVencimiento: f.fechaVencimiento,
      paleta: f.paleta || undefined,
      copias: 1,
    }))
}

/**
 * Ficha compacta de la guía en la cabecera fija del modal: documento,
 * proveedor, fecha, placa y quién registró — el contexto del documento
 * siempre visible mientras se revisan los artículos.
 */
function FichaGuia({ encabezado }: { encabezado: EncabezadoRotulo }) {
  const { numeroDocumento, proveedor, fecha, placa, registradoPor } = encabezado
  if (!numeroDocumento && !proveedor && !fecha && !placa) return null
  return (
    <div className="mt-2.5 rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2">
      <p className="text-xs font-bold text-amber-900 truncate">
        {numeroDocumento
          ? `Guía ${numeroDocumento}`
          : proveedor || 'Documento sin número'}
      </p>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] sm:text-[11px] text-slate-500">
        {numeroDocumento && proveedor && (
          <span className="max-w-[14rem] truncate font-semibold text-slate-600" title={proveedor}>
            {proveedor}
          </span>
        )}
        {fecha && <span>Fecha: {fecha}</span>}
        {placa && <span>Placa: {placa}</span>}
        {registradoPor && (
          <span className="max-w-[12rem] truncate" title={registradoPor}>
            Registró: {registradoPor}
          </span>
        )}
      </div>
    </div>
  )
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

  // Guard generacional (FIX auditoría 2026-10-16): cerrar/abrir rápido el
  // modal (o "Reintentar" tras un sondeo lento) lanzaba DOS sondas solapadas
  // y la vieja — terminando última — pisaba el resultado fresco con
  // "no detectado" aunque el servicio estuviera activo.
  const sondeoGenRef = useRef(0)
  const sondear = useCallback(async () => {
    const gen = ++sondeoGenRef.current
    setEstado('verificando')
    setImpresoras([])
    setSeleccion('')
    // 1) Detectar el middleware (y SU MOTIVO de falla si no responde).
    const det = await detectarServicioZebra()
    if (gen !== sondeoGenRef.current) return // llegó un sondeo más reciente
    if (!det.base) {
      setMotivo(det.motivo)
      setEstado('no-encontrado')
      return
    }
    // 2) Con el servicio vivo, listar impresoras y preseleccionar la default.
    const lista = await descubrirImpresorasZebra()
    if (gen !== sondeoGenRef.current) return
    setImpresoras(lista)
    if (lista.length === 0) {
      setMotivo('sin-servicio')
      setEstado('no-encontrado')
      return
    }
    const porDefecto = await obtenerImpresoraDefaultZebra()
    if (gen !== sondeoGenRef.current) return
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
  }, [open])

  /** REIMPRESIÓN PARCIAL (pedido 2026-10): 0 = ESE artículo NO se imprime.
   *  Se permite digitar 0 (o vaciar el campo) para saltarlo; tope 999.
   *  NaN-safe: input type=number vacío/inválido llega como NaN/'' → 0. */
  function setCopiasDe(idx: number, valor: number) {
    const v = Number.isFinite(valor) ? Math.max(0, Math.min(999, Math.round(valor))) : 0
    setCopias((prev) => prev.map((c, i) => (i === idx ? v : c)))
  }

  /** Misma cantidad de etiquetas para TODOS los artículos de una vez.
   *  Acepta 0 explícito (útil: "0 a todos, y luego los que sí quiero").
   *  Campo vacío = no-op (nunca zera todo por accidente). */
  function aplicarCopiasATodos() {
    const txt = copiasTodos.trim()
    if (txt === '') return
    const n = Number(txt)
    if (!Number.isFinite(n) || n < 0) return
    const v = Math.min(999, Math.round(n))
    setCopias(rotulos.map(() => v))
    setCopiasTodos('')
  }

  const totalEtiquetas = rotulos.reduce((s, _r, i) => s + (copias[i] ?? 1), 0)
  /** Artículos quedaron en 0 (reimpresión parcial: esos NO salen). */
  const enCero = rotulos.reduce((s, _r, i) => s + ((copias[i] ?? 1) === 0 ? 1 : 0), 0)

  function zplActual(): string {
    // copias ya viene normalizada (0..999, sin NaN): el 0 queda tal cual y
    // construirZPLRotulos OMITE esos rótulos — solo se imprimen los > 0.
    return construirZPLRotulos(rotulos, copias, encabezado)
  }

  async function imprimir() {
    const impresora = impresoras.find((p) => p.uid === seleccion)
    if (!impresora) {
      toast.error('Selecciona una impresora')
      return
    }
    if (totalEtiquetas === 0) {
      toast.error('No hay etiquetas que imprimir', { description: 'Todos los artículos están en 0. Ponle copias a los que sí necesitas.' })
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
    if (totalEtiquetas === 0) {
      toast.info('Nada que descargar', { description: 'Todos los artículos están en 0: ponle copias a los que sí necesitas.' })
      return
    }
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
      {/* Caja flex con techo en dvh: cabecera y pie fijos, solo el centro
          se desliza. En móvil ocupa casi todo el alto útil del navegador. */}
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-xl lg:max-w-2xl">
        {/* ── Cabecera FIJA: título + ficha de la guía ── */}
        <div className="shrink-0 border-b border-slate-100 pr-11 pl-4 pt-4 pb-3 sm:px-5 sm:pt-5">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Printer className="h-4 w-4 text-amber-600" /> Imprimir rótulos
            </DialogTitle>
            <DialogDescription className="text-xs">
              {rotulos.length} artículo(s) de la guía · etiqueta horizontal 15 × 10 cm · formato PERECIBLE de la empresa.
            </DialogDescription>
          </DialogHeader>
          <FichaGuia encabezado={encabezado} />
        </div>

        {/* ── Contenido DESLIZABLE ── */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 sm:px-5">
          {nota && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800">
              {nota}
            </p>
          )}

          {/* Copias por artículo: digitable SIEMPRE (con o sin Browser Print). */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <Label className="text-xs">Etiquetas por artículo</Label>
                <p className="text-[10px] leading-tight text-slate-400">
                  Pon <b className="text-slate-500">0</b> a los que NO quieras — se imprimen solo los que quedan con copias
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={0}
                  max={999}
                  placeholder="N"
                  value={copiasTodos}
                  onChange={(e) => setCopiasTodos(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && aplicarCopiasATodos()}
                  className="h-8 w-14 text-xs text-right"
                  title="Misma cantidad para todos (0 = no imprime ninguno hasta que los cambies uno por uno)"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-2.5 text-[11px]"
                  onClick={aplicarCopiasATodos}
                  disabled={rotulos.length === 0}
                >
                  Aplicar a todos
                </Button>
              </div>
            </div>
            <div className="max-h-[38vh] min-h-20 overflow-y-auto overscroll-contain rounded-lg border divide-y">
              {rotulos.map((r, i) => (
                <div key={`${r.codigo}-${i}`} className="flex items-center gap-2.5 px-2.5 py-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-bold text-slate-500">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold truncate" title={`${r.codigo} · ${r.descripcion}`}>
                      {r.codigo || '(sin código)'}
                      {r.descripcion ? ` · ${r.descripcion}` : ''}
                    </p>
                    <p className="text-[10px] text-slate-400 truncate">
                      Cant.: {r.cantidad}{r.unidad ? ` ${r.unidad}` : ''}
                      {r.lote ? ` · Lote ${r.lote}` : ''}
                    </p>
                  </div>
                  {r.paleta && (
                    <span
                      className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-700"
                      title="Rótulo de una paleta (artículo dividido) — se imprime con SU cantidad"
                    >
                      {r.paleta}
                    </span>
                  )}
                  <Input
                    type="number"
                    min={0}
                    max={999}
                    value={copias[i] ?? 1}
                    onChange={(e) => setCopiasDe(i, Number(e.target.value))}
                    className={`h-8 w-16 shrink-0 text-xs text-right ${(copias[i] ?? 1) === 0 ? 'border-slate-300 bg-slate-100 text-slate-400 line-through' : ''}`}
                    title="Etiquetas de este artículo (0 = no se imprime)"
                    aria-label={`Etiquetas de ${r.codigo} (0 = no se imprime)`}
                  />
                </div>
              ))}
            </div>
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
              <Button variant="outline" onClick={() => void sondear()} className="w-full gap-2">
                <RefreshCw className="h-4 w-4" /> Reintentar detección
              </Button>
              <p className="text-xs text-slate-500">
                Mientras tanto, el botón <b>«Plan B: .zpl»</b> del pie descarga los rótulos para
                imprimirlos con Zebra Setup Utilities (arrastrar al ícono de envío).
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
                <span className="text-xs font-bold text-slate-700">15 × 10 cm horizontal · formato PERECIBLE</span>
              </div>

              <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <MonitorDown className="h-3 w-3 shrink-0" />
                La impresión va directa por Zebra Browser Print instalado en la PC de la impresora.
              </p>
            </div>
          )}
        </div>

        {/* ── Pie FIJO: total + acciones siempre a la vista ── */}
        <div className="shrink-0 space-y-2 border-t border-slate-100 bg-slate-50/90 px-4 py-3 sm:px-5">
          <p className="text-[11px] text-slate-500">
            Total: <b className="text-slate-700">{totalEtiquetas}</b> etiqueta(s) · se envían todas en
            {' '}<b className="text-slate-700">un solo trabajo</b> de impresión.
            {enCero > 0 && (
              <>
                {' '}<span className="font-semibold text-slate-400">
                  {enCero} artículo(s) en 0: no se imprimen.
                </span>
              </>
            )}
            {totalEtiquetas === 0 && (
              <span className="font-semibold text-amber-700"> Todo está en 0 — ponle copias a los artículos que sí necesitas.</span>
            )}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={descargar}
              className="gap-2"
              title="Plan B: imprimir con Zebra Setup Utilities"
            >
              <Download className="h-4 w-4" /> Plan B: .zpl
            </Button>
            <Button
              onClick={() => void imprimir()}
              disabled={estado !== 'activo' || imprimiendo || rotulos.length === 0 || totalEtiquetas === 0}
              className="flex-1 gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700 sm:flex-none sm:px-6"
            >
              {imprimiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
              Imprimir todo de una vez ({totalEtiquetas})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
