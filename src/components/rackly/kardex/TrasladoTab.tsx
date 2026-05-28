'use client'

import { useState, useEffect } from 'react'
import {
  fetchMovimientos,
  trasladarMovimiento,
  stockEnUbicacion,
  addMovimiento,
  type Movimiento,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { useAuth } from '@/hooks/useAuth'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'

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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, ArrowRightLeft, PackageSearch, AlertTriangle, ArrowUpFromLine, Package, MapPin, TriangleAlert, CheckCircle2 } from 'lucide-react'
import { formatDate, isExpired, isExpiringSoon } from '@/lib/utils'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

type LocStock = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  descripcion: string
  un: string
  fVencimiento: string
  codigo: string
  proveedor?: string
}

export function TrasladoTab() {
  const { perfil } = useAuth()
  const [step, setStep] = useState<1 | 2>(1)
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  const [locations, setLocations] = useState<LocStock[]>([])
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null)
  const [trasladoTotal, setTrasladoTotal] = useState(true)
  const [destBloque, setDestBloque] = useState('')
  const [destTorre, setDestTorre] = useState('')
  const [destPiso, setDestPiso] = useState('')
  const [destPos, setDestPos] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [destinoOcupado, setDestinoOcupado] = useState<StockEnUbicacion[]>([])
  const [salidaBusy, setSalidaBusy] = useState<string | null>(null)

  const [movs, setMovs] = useState<Movimiento[]>([])

  useMovimientosRealtime(setMovs)

  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    // Find locations with stock
    const code = item.codigo.toUpperCase()
    const locMap = new Map<string, LocStock>()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const current = locMap.get(key)
      if (current) {
        current.stock += ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
        if (m.fVencimiento && (!current.fVencimiento || m.fVencimiento < current.fVencimiento)) {
          current.fVencimiento = m.fVencimiento
        }
      } else {
        locMap.set(key, {
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion,
          un: m.un,
          fVencimiento: m.fVencimiento || '',
          codigo: m.codigo,
          proveedor: m.proveedor,
        })
      }
    }
    // Ordenar: vencimiento más próximo primero, sin fecha al final
    setLocations(
      Array.from(locMap.values())
        .filter((l) => l.stock > 0)
        .sort((a, b) => {
          if (a.fVencimiento && b.fVencimiento) return a.fVencimiento.localeCompare(b.fVencimiento)
          if (a.fVencimiento) return -1
          if (b.fVencimiento) return 1
          return 0
        })
    )
    setStep(1)
  }

  const origin = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === selectedOrigin)

  const qtyNum = parseFloat(qty) || 0
  const saldoRestante = origin ? origin.stock - qtyNum : 0
  const excedeStock = origin ? qtyNum > origin.stock : false
  const faltaStock = origin ? qtyNum > 0 && qtyNum < origin.stock : false
  const diferencia = origin ? qtyNum - origin.stock : 0
  const tieneAjuste = excedeStock || faltaStock

  async function handleConfirm() {
    if (!origin) return
    if (selectedOrigin === `${destBloque}-${destTorre}-${destPiso || '1'}-${destPos}`) {
      toast.error('El destino no puede ser igual al origen')
      return
    }
    if (qtyNum <= 0) {
      toast.error('Cantidad inválida')
      return
    }
    // Verificar si destino está ocupado
    try {
      const destStock = await stockEnUbicacion(destBloque, destTorre, destPiso || '1', destPos)
      setDestinoOcupado(destStock)
    } catch {
      setDestinoOcupado([])
    }
    setConfirm(true)
  }

  // Dar salida a un producto desde el alerta de destino ocupado
  async function handleSalidaDesdeAlerta(stockItem: StockEnUbicacion) {
    if (!perfil) return
    setSalidaBusy(stockItem.codigo)
    try {
      const result = await addMovimiento({
        tipo: 'salida',
        bloque: destBloque,
        torre: destTorre,
        piso: destPiso || '1',
        posicion: destPos,
        codigo: stockItem.codigo,
        descripcion: stockItem.descripcion,
        un: stockItem.un,
        cantidad: stockItem.stock,
        fVencimiento: stockItem.fVencimiento ?? '',
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: stockItem.proveedor,
      })
      toast.success(`Salida de ${stockItem.stock} ${stockItem.un} de ${stockItem.codigo}`)
      setMovs(result)
      // Refrescar datos del alerta
      const updated = await stockEnUbicacion(destBloque, destTorre, destPiso || '1', destPos)
      setDestinoOcupado(updated)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al dar salida', { description: message })
    } finally {
      setSalidaBusy(null)
    }
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    const cantidadFinal = qtyNum || origin.stock
    setBusy(true)
    try {
      const result = await trasladarMovimiento({
        codigo: origin.codigo,
        descripcion: origin.descripcion,
        un: origin.un,
        cantidad: cantidadFinal,
        origen: {
          bloque: origin.bloque,
          torre: origin.torre,
          piso: origin.piso,
          posicion: origin.posicion,
        },
        destino: {
          bloque: destBloque,
          torre: destTorre,
          piso: destPiso || '1',
          posicion: destPos,
        },
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        fVencimiento: origin.fVencimiento,
        proveedor: origin.proveedor,
        // Se genera ajuste automático cuando qty != stock (positivo o negativo)
        cantidadAjuste: tieneAjuste ? diferencia : undefined,
      })
      toast.success('Traslado registrado')
      if (tieneAjuste) {
        if (excedeStock) {
          toast.info(`Ajuste automático: +${Math.abs(diferencia)} ${origin.un} en origen (faltaba stock)`, { duration: 6000 })
        } else {
          toast.info(`Ajuste automático: -${Math.abs(diferencia)} ${origin.un} en origen (sobraba stock)`, { duration: 6000 })
        }
      }
      setMovs(result)
      resetForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al trasladar', { description: message })
    } finally {
      setBusy(false)
      setConfirm(false)
      setDestinoOcupado([])
    }
  }

  function resetForm() {
    setCodigo('')
    setDescripcion('')
    setUn('')
    setLocations([])
    setSelectedOrigin(null)
    setTrasladoTotal(true)
    setDestBloque('')
    setDestTorre('')
    setDestPiso('')
    setDestPos('')
    setQty('')
    setStep(1)
  }

  const destTorres = torresDeBloque(destBloque)
  const destPositions = posicionesDeBloque(destBloque)
  const destPisoSeleccionado = destPiso || '1'

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Busca un código, elige la ubicación de origen y destino. Confirma el traslado.
      </p>

      <CatalogoSearchInput
        onPick={handleCatalogoPick}
        value={codigo}
        onChange={(v) => {
          setCodigo(v)
          const cat = findCatalogoByCodigo(v)
          if (cat) handleCatalogoPick(cat)
        }}
      />

      {/* Info del producto buscado */}
      {codigo && descripcion && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
              <PackageSearch className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold text-sm text-blue-800 dark:text-blue-300">{codigo}</span>
                <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{un || '—'}</span>
                {locations[0]?.proveedor && (
                  <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold text-[10px]">
                    {locations[0].proveedor}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">{descripcion}</p>
            </div>
            <Badge variant="outline" className="border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-semibold">
              {locations.length} ubicacion{locations.length !== 1 ? 'es' : ''}
            </Badge>
          </div>
        </div>
      )}

      {locations.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">1. Selecciona ubicación de origen:</p>
            <p className="text-xs text-muted-foreground">y elige el tipo de traslado</p>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200/60">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Bloque</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Torre</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Piso</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Pos.</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Stock</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">UN</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">F. Vencimiento</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Proveedor</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((loc) => {
                  const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
                  const isSelected = selectedOrigin === key
                  return (
                    <TableRow
                      key={key}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-blue-50/60 dark:bg-blue-950/30 border-l-4 border-l-blue-500'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-900/40'
                      }`}
                      onClick={() => {
                        setSelectedOrigin(key)
                        setTrasladoTotal(true)
                        setQty(String(loc.stock))
                        setStep(2)
                      }}
                    >
                      <TableCell className="text-center font-medium text-slate-700">{loc.bloque}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700">{loc.torre}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700">{loc.piso}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700">{loc.posicion}</TableCell>
                      <TableCell className="text-right font-bold text-slate-800">{loc.stock}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-medium text-xs">{loc.un}</Badge>
                      </TableCell>
                      <TableCell>
                        {loc.fVencimiento ? (
                          <span className={`text-sm font-medium ${
                            isExpired(loc.fVencimiento)
                              ? 'text-red-600 dark:text-red-400 font-semibold'
                              : isExpiringSoon(loc.fVencimiento, 15)
                                ? 'text-orange-600 dark:text-orange-400'
                                : isExpiringSoon(loc.fVencimiento, 30)
                                  ? 'text-sky-600 dark:text-sky-400'
                                  : 'text-muted-foreground'
                          }`}>{formatDate(loc.fVencimiento)}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {loc.proveedor ? (
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold text-xs">
                            {loc.proveedor}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {isSelected ? (
                          <div className="flex items-center justify-center gap-1 text-xs font-bold text-blue-700 dark:text-blue-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>{trasladoTotal ? 'Total' : 'Parcial'}</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2.5 text-[11px] font-semibold gap-1 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedOrigin(key)
                                setTrasladoTotal(true)
                                setQty(String(loc.stock))
                                setStep(2)
                              }}
                            >
                              <Package className="h-3 w-3" />
                              Todo
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2.5 text-[11px] font-semibold gap-1 border-sky-200 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-800 dark:text-sky-400 dark:hover:bg-sky-950/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedOrigin(key)
                                setTrasladoTotal(false)
                                setQty('')
                                setStep(2)
                              }}
                            >
                              <ArrowUpFromLine className="h-3 w-3" />
                              Parcial
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Haz clic en una fila o pulsa "Seleccionar" para elegir el origen del traslado.
          </p>
        </>
      )}

      {origin && step === 2 && (
        <div className="space-y-3 p-4 border rounded-lg">
          {/* Indicador del tipo de traslado seleccionado */}
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">2. Elige ubicación de destino:</p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { setTrasladoTotal(true); setQty(String(origin.stock)) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  trasladoTotal
                    ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-400 shadow-sm'
                    : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                }`}
              >
                <Package className="h-3 w-3 inline-block mr-1 -mt-0.5" />
                Traslado Total
              </button>
              <button
                onClick={() => { setTrasladoTotal(false); setQty('') }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  !trasladoTotal
                    ? 'bg-sky-100 text-sky-800 border-2 border-sky-400 shadow-sm dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-600'
                    : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                }`}
              >
                <ArrowUpFromLine className="h-3 w-3 inline-block mr-1 -mt-0.5" />
                Traslado Parcial
              </button>
            </div>
          </div>

          {/* Info del tipo de traslado */}
          <div className={`rounded-lg border p-2.5 flex items-center gap-2.5 ${
            trasladoTotal
              ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20'
              : 'border-sky-200 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/20'
          }`}>
            {trasladoTotal ? (
              <>
                <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
                  <Package className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  <strong>Traslado Total:</strong> Se moverán <strong>todas las {origin.stock} {origin.un}</strong> al destino.
                  La ubicación de origen quedará con <strong>stock 0</strong>.
                </p>
              </>
            ) : (
              <>
                <div className="w-7 h-7 rounded-full bg-sky-100 dark:bg-sky-900/40 flex items-center justify-center shrink-0">
                  <ArrowUpFromLine className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                </div>
                <p className="text-xs text-sky-700 dark:text-sky-300">
                  <strong>Traslado Parcial:</strong> Ingresa la cantidad que deseas mover.
                  El <strong>saldo restante ({origin.stock} - cantidad)</strong> se quedará en la ubicación de origen.
                </p>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label>Bloque</Label>
              <Select value={destBloque} onValueChange={(v) => { setDestBloque(v); setDestTorre(''); setDestPos('') }}>
                <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>
                  {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Torre</Label>
              <Select value={destTorre} onValueChange={setDestTorre} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>
                  {destTorres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Piso</Label>
              <Select value={destPiso} onValueChange={setDestPiso} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Piso" /></SelectTrigger>
                <SelectContent>
                  {PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Posición</Label>
              <Select value={destPos} onValueChange={setDestPos} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Pos" /></SelectTrigger>
                <SelectContent>
                  {destPositions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>{trasladoTotal ? 'Cantidad a trasladar (stock total)' : 'Cantidad a trasladar'}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                disabled={trasladoTotal}
                placeholder={`Stock disponible: ${origin.stock} ${origin.un}`}
                className={trasladoTotal ? 'bg-emerald-50 dark:bg-emerald-950/20 font-bold' : ''}
              />
              {!trasladoTotal && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setQty(String(origin.stock))}
                  className="shrink-0 h-9 px-2.5 text-xs font-semibold border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
                >
                  Max: {origin.stock}
                </Button>
              )}
            </div>
            {!trasladoTotal && qtyNum > 0 && qtyNum <= origin.stock && (
              <div className="flex items-center justify-between text-xs">
                <p className="text-muted-foreground">
                  Stock disponible: <strong>{origin.stock} {origin.un}</strong>
                </p>
                <p className={`font-semibold ${saldoRestante === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'}`}>
                  Saldo en origen: <strong>{saldoRestante} {origin.un}</strong>
                </p>
              </div>
            )}
            {trasladoTotal && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                Se trasladará todo el stock. La ubicación quedará vacía (0).
              </p>
            )}
          </div>

          {/* Sección de ajuste cuando qty != stock (no aplica en traslado total) */}
          {tieneAjuste && !trasladoTotal && (
            <div className={`rounded-lg border p-3 space-y-2 ${
              excedeStock
                ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800'
                : 'border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800'
            }`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${
                  excedeStock
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-sky-600 dark:text-sky-400'
                }`} />
                <div className={`text-sm ${
                  excedeStock
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-sky-700 dark:text-sky-300'
                }`}>
                  <p className="font-medium">Ajuste de stock requerido</p>
                  {excedeStock ? (
                    <>
                      <p className="mt-1">
                        La cantidad a trasladar ({qtyNum} {origin.un}) supera el stock registrado ({origin.stock} {origin.un}).
                      </p>
                      <p className="mt-1">
                        Diferencia: <strong>+{Math.abs(diferencia)} {origin.un}</strong> (faltaba en el sistema)
                      </p>
                      <p className="mt-1 text-xs opacity-90">
                        Se registrará un <strong>ingreso de ajuste</strong> de {Math.abs(diferencia)} {origin.un} en el origen
                        para cubrir lo que falta, dejando el stock en 0. Útil cuando un operador dejó saldo adicional
                        no registrado.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="mt-1">
                        La cantidad a trasladar ({qtyNum} {origin.un}) es menor al stock registrado ({origin.stock} {origin.un}).
                      </p>
                      <p className="mt-1">
                        Diferencia: <strong>-{Math.abs(diferencia)} {origin.un}</strong> (sobra en el sistema)
                      </p>
                      <p className="mt-1 text-xs opacity-90">
                        Se registrará una <strong>salida de ajuste</strong> de {Math.abs(diferencia)} {origin.un} en el origen
                        para retirar lo que sobra, dejando el stock en 0. Útil cuando un operador registró de más
                        o faltó producto físico.
                      </p>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs font-medium">
                <Badge variant="outline" className={excedeStock
                  ? 'border-amber-400 text-amber-700 dark:text-amber-300'
                  : 'border-sky-400 text-sky-700 dark:text-sky-300'
                }>
                  Origen: {origin.stock} → {qtyNum} {origin.un}
                  [{diferencia > 0 ? '+' : ''}{diferencia} ajuste]
                </Badge>
                <Badge variant="outline" className="border-blue-400 text-blue-700 dark:text-blue-300">
                  Destino: +{qtyNum} {origin.un}
                </Badge>
              </div>
            </div>
          )}

          <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPos || qtyNum <= 0} className="gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Confirmar traslado
          </Button>
        </div>
      )}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className="max-w-lg p-0 overflow-hidden">
          {/* Header con gradiente */}
          <div className={`px-6 py-5 text-white ${
            destinoOcupado.length > 0
              ? 'bg-gradient-to-r from-orange-500 via-red-500 to-red-600'
              : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                {destinoOcupado.length > 0 ? (
                  <TriangleAlert className="h-6 w-6 text-white" />
                ) : (
                  <ArrowRightLeft className="h-6 w-6 text-white" />
                )}
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  {destinoOcupado.length > 0 ? 'Destino Ocupado' : 'Confirmar Traslado'}
                </AlertDialogTitle>
                <AlertDialogDescription className={`text-sm mt-0.5 ${
                  destinoOcupado.length > 0 ? 'text-orange-100' : 'text-blue-100'
                }`}>
                  {destinoOcupado.length > 0
                    ? 'El destino ya tiene stock. Revisa o retira productos antes de trasladar.'
                    : trasladoTotal
                      ? `Traslado total de ${qty} ${origin?.un}. La ubicación de origen quedará vacía.`
                      : `Traslado parcial. Quedará un saldo de ${saldoRestante} ${origin?.un} en el origen.`}
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          <AlertDialogDescription className="sr-only">
            Confirmación de traslado
          </AlertDialogDescription>

          {/* Contenido scrolleable */}
          <div className="max-h-[60vh] overflow-y-auto">
            {/* Ruta origen → destino */}
            <div className="px-6 pt-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Ruta del traslado</p>
              <div className="flex items-center gap-2 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2.5">
                <MapPin className="h-4 w-4 text-blue-500 flex-shrink-0" />
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300">
                  B-{origin?.bloque} T-{origin?.torre} P-{origin?.piso} Pos-{origin?.posicion}
                  <span className="mx-2 text-indigo-500 font-bold">→</span>
                  B-{destBloque} T-{destTorre} P-{destPisoSeleccionado} Pos-{destPos}
                </span>
              </div>
            </div>

            {/* Producto a trasladar */}
            <div className="px-6 pb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Producto a trasladar</p>
              <div className="rounded-xl border-2 border-dashed border-blue-300 dark:border-blue-700 bg-blue-50/60 dark:bg-blue-950/20 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-sm text-blue-800 dark:text-blue-300">{origin?.codigo}</span>
                    <span className="text-[10px] text-blue-700/60 dark:text-blue-400/60 bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 rounded">{origin?.un || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <ArrowRightLeft className="h-3.5 w-3.5 text-blue-600" />
                    <span className="font-bold text-blue-700 dark:text-blue-300">{qty} {origin?.un}</span>
                  </div>
                </div>
                {origin?.descripcion && (
                  <p className="text-xs text-blue-700/70 dark:text-blue-400/70 truncate">{origin?.descripcion}</p>
                )}
                {origin?.fVencimiento && (
                  <p className="text-[10px] text-muted-foreground">Venc: {origin?.fVencimiento}</p>
                )}
              </div>
            </div>

            {/* Tipo de traslado y saldo */}
            <div className="px-6 pb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={`text-xs font-bold ${
                  trasladoTotal
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700'
                    : 'bg-sky-100 text-sky-800 border border-sky-300 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-700'
                }`}>
                  {trasladoTotal
                    ? <><Package className="h-3 w-3 mr-1" /> Traslado Total</>
                    : <><ArrowUpFromLine className="h-3 w-3 mr-1" /> Traslado Parcial</>
                  }
                </Badge>
                {!trasladoTotal && qtyNum > 0 && (
                  <Badge variant="outline" className="border-sky-300 text-sky-700 dark:text-sky-300 text-xs font-semibold">
                    Saldo en origen: {saldoRestante} {origin?.un}
                  </Badge>
                )}
                {trasladoTotal && (
                  <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                    Origen quedará en 0
                  </Badge>
                )}
              </div>
            </div>

            {/* Ajuste automático */}
            {tieneAjuste && !trasladoTotal && (
              <div className="px-6 pb-3">
                <div className={`rounded-xl border p-3 ${
                  excedeStock
                    ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                    : 'border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800 text-sky-700 dark:text-sky-300'
                }`}>
                  <p className="font-medium mb-1">
                    <AlertTriangle className="h-4 w-4 inline-block mr-1" />
                    Ajuste automático: {diferencia > 0 ? '+' : ''}{diferencia} {origin?.un} en origen
                  </p>
                  <p className="text-xs">
                    {excedeStock
                      ? `Se registrará un ingreso de ${Math.abs(diferencia)} ${origin?.un} en el origen.`
                      : `Se registrará una salida de ${Math.abs(diferencia)} ${origin?.un} en el origen.`}
                  </p>
                </div>
              </div>
            )}

            {/* Separador si hay productos en destino */}
            {destinoOcupado.length > 0 && (
              <div className="px-6 pb-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Stock actual en el destino</span>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                </div>
              </div>
            )}

            {/* Productos existentes en destino */}
            {destinoOcupado.length > 0 && (
              <div className="px-6 pb-4">
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-2">
                  {destinoOcupado.length} producto{destinoOcupado.length !== 1 ? 's' : ''} encontrado{destinoOcupado.length !== 1 ? 's' : ''}
                </p>
                <div className="space-y-2">
                  {destinoOcupado.map((s, i) => (
                    <div
                      key={`${s.codigo}-${i}`}
                      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Package className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-semibold text-sm text-slate-800 dark:text-slate-200">{s.codigo}</span>
                            <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{s.un}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{s.descripcion}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                            <span className="font-bold text-slate-700 dark:text-slate-300 text-sm">{s.stock} {s.un}</span>
                            {s.fVencimiento && <span>Venc: {s.fVencimiento}</span>}
                            {s.proveedor && <span>Prov: {s.proveedor}</span>}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSalidaDesdeAlerta(s)}
                          disabled={salidaBusy === s.codigo}
                          className="h-9 px-3 text-xs font-semibold border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 hover:border-red-300 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-300 dark:hover:border-red-700 flex-shrink-0 gap-1.5 self-center"
                        >
                          {salidaBusy === s.codigo ? (
                            <><Loader2 className="h-3 w-3 animate-spin" /> Procesando...</>
                          ) : (
                            <><ArrowUpFromLine className="h-3 w-3" /> Dar Salida</>
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  Presiona "Dar Salida" para retirar productos que ya no están físicamente en esta ubicación.
                </p>
              </div>
            )}
          </div>

          {/* Botones de acción */}
          <AlertDialogFooter className="px-6 pb-6 pt-3 border-t border-slate-100 dark:border-slate-800 gap-2 sm:gap-2">
            <AlertDialogCancel className="flex-1 h-11 rounded-lg text-sm font-medium border-slate-300 dark:border-slate-600">
              Cancelar
            </AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doTraslado() }}
              disabled={busy}
              className="flex-1 h-11 rounded-lg text-sm font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-md shadow-blue-600/20 gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="h-4 w-4" />
              )}
              Confirmar Traslado
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
