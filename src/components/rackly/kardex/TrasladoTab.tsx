'use client'

import { useState } from 'react'
import {
  fetchMovimientos,
  trasladarMovimiento,
  type Movimiento,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { useAuth } from '@/hooks/useAuth'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'

const findCatalogoByCodigoFromCache = findCatalogoByCodigo
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
import { Loader2, ArrowRightLeft, ArrowDown, ArrowUp, Minus, Equal, Package, Trash2 } from 'lucide-react'
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

type ConfirmMode =
  | 'equal'      // qty === stock: traslado total directo
  | 'exceeds'    // qty > stock: con corrección
  | 'less'       // qty < stock: preguntar si ajustar a 0 o dejar saldo
  | null

export function TrasladoTab() {
  const { perfil } = useAuth()
  const [step, setStep] = useState<1 | 2>(1)
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  const [locations, setLocations] = useState<LocStock[]>([])
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null)
  const [destBloque, setDestBloque] = useState('')
  const [destTorre, setDestTorre] = useState('')
  const [destPiso, setDestPiso] = useState('')
  const [destPos, setDestPos] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null)
  const [ajustarACero, setAjustarACero] = useState(false)

  const [movs, setMovs] = useState<Movimiento[]>([])

  useMovimientosRealtime(setMovs)

  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    const code = item.codigo.toUpperCase()
    const locMap = new Map<string, LocStock>()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const current = locMap.get(key)
      if (current) {
        current.stock += (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado')
          ? m.cantidad : -m.cantidad
        if (m.fVencimiento && (!current.fVencimiento || m.fVencimiento < current.fVencimiento)) {
          current.fVencimiento = m.fVencimiento
        }
      } else {
        locMap.set(key, {
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado')
            ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion,
          un: m.un,
          fVencimiento: m.fVencimiento || '',
          codigo: m.codigo,
          proveedor: m.proveedor,
        })
      }
    }
    setLocations(Array.from(locMap.values()).filter((l) => l.stock > 0)
      .sort((a, b) => {
        if (!a.fVencimiento && !b.fVencimiento) return 0
        if (!a.fVencimiento) return 1
        if (!b.fVencimiento) return -1
        return a.fVencimiento.localeCompare(b.fVencimiento)
      }))
    setStep(1)
  }

  const origin = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === selectedOrigin)
  const qtyNum = qty ? parseFloat(qty) : 0
  const diff = qtyNum - (origin?.stock ?? 0)
  const saldo = origin ? origin.stock - qtyNum : 0

  function handleConfirm() {
    if (!origin) return
    const originKey = `${origin.bloque}-${origin.torre}-${origin.piso}-${origin.posicion}`
    const destKey = `${destBloque}-${destTorre}-${destPiso}-${destPos}`
    if (originKey === destKey) {
      toast.error('El destino no puede ser igual al origen')
      return
    }
    if (!destBloque || !destTorre || !destPiso || !destPos) {
      toast.error('Completa la ubicación de destino')
      return
    }
    if (!qtyNum || qtyNum <= 0) {
      toast.error('Ingresa una cantidad válida mayor a 0')
      return
    }
    // Determinar el modo de confirmación
    if (diff > 0) {
      setConfirmMode('exceeds')
    } else if (diff < 0) {
      setConfirmMode('less')
      setAjustarACero(false) // Por defecto, no ajustar a cero
    } else {
      setConfirmMode('equal')
    }
    setConfirm(true)
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    setBusy(true)
    try {
      const result = await trasladarMovimiento({
        codigo: origin.codigo,
        descripcion: origin.descripcion,
        un: origin.un,
        cantidad: qtyNum,
        stockActual: origin.stock,
        origen: {
          bloque: origin.bloque,
          torre: origin.torre,
          piso: origin.piso,
          posicion: origin.posicion,
        },
        destino: {
          bloque: destBloque,
          torre: destTorre,
          piso: destPiso,
          posicion: destPos,
        },
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        fVencimiento: origin.fVencimiento,
        proveedor: origin.proveedor,
        ajustarOrigenACero: ajustarACero,
      })
      // Toast según el resultado
      if (diff > 0) {
        toast.success(`Traslado registrado. Corrección de +${Math.abs(diff)} ${origin.un} en origen.`, { duration: 5000 })
      } else if (diff < 0 && ajustarACero) {
        toast.success(`Traslado registrado. Origen ajustado a 0 (salida de ajuste de ${Math.abs(diff)} ${origin.un}).`, { duration: 5000 })
      } else if (diff < 0) {
        toast.success(`Traslado registrado. Quedan ${saldo} ${origin.un} en el origen.`, { duration: 5000 })
      } else {
        toast.success('Traslado total registrado. Origen vacío.')
      }
      setMovs(result)
      resetForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al trasladar', { description: message })
    } finally {
      setBusy(false)
      setConfirm(false)
      setConfirmMode(null)
    }
  }

  function resetForm() {
    setCodigo('')
    setDescripcion('')
    setUn('')
    setLocations([])
    setSelectedOrigin(null)
    setDestBloque('')
    setDestTorre('')
    setDestPiso('')
    setDestPos('')
    setQty('')
    setStep(1)
  }

  const destTorres = torresDeBloque(destBloque)
  const destPositions = posicionesDeBloque(destBloque)

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
          const cat = findCatalogoByCodigoFromCache(v)
          if (cat) handleCatalogoPick(cat)
        }}
      />

      {locations.length > 0 && (
        <>
          <p className="text-sm font-medium">1. Selecciona ubicación de origen:</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ubicación</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>Vencimiento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((loc) => {
                const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
                return (
                  <TableRow
                    key={key}
                    className={`cursor-pointer ${selectedOrigin === key ? 'bg-accent' : ''}`}
                    onClick={() => {
                      setSelectedOrigin(key)
                      setQty(String(loc.stock))
                      setStep(2)
                    }}
                  >
                    <TableCell className="font-medium">
                      B{loc.bloque} T{loc.torre} P{loc.piso} Pos{loc.posicion}
                    </TableCell>
                    <TableCell className="text-right font-bold">{loc.stock} {loc.un}</TableCell>
                    <TableCell>
                      {loc.fVencimiento ? (() => {
                        const dias = Math.ceil((new Date(loc.fVencimiento).getTime() - Date.now()) / 86400000)
                        return (
                          <Badge variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'}
                            className={dias <= 15 && dias > 0 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}>
                            {loc.fVencimiento} ({dias <= 0 ? 'vencido' : `${dias}d`})
                          </Badge>
                        )
                      })() : <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </>
      )}

      {origin && step === 2 && (
        <div className="space-y-3 p-4 border rounded-lg bg-card">
          <p className="text-sm font-medium">2. Elige ubicación de destino:</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label>Bloque</Label>
              <Select value={destBloque} onValueChange={(v) => { setDestBloque(v); setDestTorre(''); setDestPiso(''); setDestPos('') }}>
                <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>
                  {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Torre</Label>
              <Select value={destTorre} onValueChange={(v) => { setDestTorre(v); setDestPiso(''); setDestPos('') }} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>
                  {destTorres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Piso</Label>
              <Select value={destPiso} onValueChange={(v) => { setDestPiso(v); setDestPos('') }} disabled={!destBloque}>
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
            <Label>Cantidad a trasladar ({origin.un})</Label>
            <Input
              type="text"
              inputMode="decimal"
              value={qty}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '')
                setQty(val)
              }}
              onFocus={(e) => e.target.select()}
              placeholder={`Stock disponible: ${origin.stock} ${origin.un}`}
            />
          </div>

          {/* ─── PANEL DE AJUSTE EN TIEMPO REAL ─── */}
          {qty && qtyNum > 0 && (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Resumen del ajuste</p>

              {/* Fila Origen */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="text-muted-foreground font-medium w-14 shrink-0">Origen</span>
                <span className="font-bold">{origin.stock} {origin.un}</span>
                {diff > 0 ? (
                  <>
                    <span className="text-green-600 dark:text-green-400 font-medium flex items-center gap-0.5">
                      +{Math.abs(diff)} {origin.un}
                    </span>
                    <span className="text-[10px] text-muted-foreground">(corrección)</span>
                  </>
                ) : (
                  <>
                    <span className="text-red-600 dark:text-red-400 font-medium flex items-center gap-0.5">
                      -{qtyNum} {origin.un}
                    </span>
                    <span className="text-[10px] text-muted-foreground">(salida)</span>
                    {ajustarACero && diff < 0 && (
                      <>
                        <span className="text-red-500 font-medium flex items-center gap-0.5">
                          -{Math.abs(diff)} {origin.un}
                        </span>
                        <span className="text-[10px] text-muted-foreground">(ajuste)</span>
                      </>
                    )}
                  </>
                )}
                <Equal className="h-3 w-3 text-muted-foreground" />
                <span className="font-bold">
                  {diff > 0 ? 0 : (ajustarACero ? 0 : saldo)} {origin.un}
                </span>
                <span className="text-[10px] text-muted-foreground">(queda)</span>
              </div>

              {/* Fila Destino */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="text-muted-foreground font-medium w-14 shrink-0">Destino</span>
                <span className="font-bold">0 {origin.un}</span>
                <span className="text-blue-600 dark:text-blue-400 font-medium flex items-center gap-0.5">
                  +{qtyNum} {origin.un}
                </span>
                <span className="text-[10px] text-muted-foreground">(traslado)</span>
                <Equal className="h-3 w-3 text-muted-foreground" />
                <span className="font-bold">{qtyNum} {origin.un}</span>
                <span className="text-[10px] text-muted-foreground">(nuevo stock)</span>
              </div>

              {/* Mensaje informativo según el caso */}
              {diff > 0 && (
                <div className="flex items-start gap-2 mt-1 p-2 rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                  <ArrowUp className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    <strong>Mayor al stock:</strong> Se generará un ingreso de corrección de <strong>{Math.abs(diff)} {origin.un}</strong> en el origen. El origen quedará en 0 y el destino recibirá {qtyNum} {origin.un}.
                  </p>
                </div>
              )}
              {diff < 0 && !ajustarACero && (
                <div className="flex items-start gap-2 mt-1 p-2 rounded bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                  <Minus className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-green-700 dark:text-green-300">
                    <strong>Traslado parcial:</strong> Se trasladan {qtyNum} {origin.un}. Quedan <strong>{saldo} {origin.un}</strong> en el origen.
                  </p>
                </div>
              )}
              {diff < 0 && ajustarACero && (
                <div className="flex items-start gap-2 mt-1 p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                  <Trash2 className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    <strong>Ajustar origen a 0:</strong> Se trasladan {qtyNum} {origin.un} al destino + se genera una <strong>salida de ajuste de {Math.abs(diff)} {origin.un}</strong> en el origen. El origen quedará en 0.
                  </p>
                </div>
              )}
              {diff === 0 && (
                <div className="flex items-start gap-2 mt-1 p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                  <Equal className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    <strong>Traslado total:</strong> Se trasladan todos los {origin.stock} {origin.un}. El origen quedará vacío.
                  </p>
                </div>
              )}

              {/* Toggle de ajuste a cero (solo cuando diff < 0) */}
              {diff < 0 && (
                <div className="flex items-center gap-2 mt-1 pt-2 border-t">
                  <button
                    type="button"
                    onClick={() => setAjustarACero(!ajustarACero)}
                    className={`
                      relative flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all cursor-pointer w-full
                      ${ajustarACero
                        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                        : 'border-border bg-card text-muted-foreground hover:border-amber-200 hover:bg-amber-50/50'
                      }
                    `}
                  >
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${ajustarACero ? 'border-amber-500 bg-amber-500' : 'border-muted-foreground/40'}`}>
                      {ajustarACero && <span className="text-white text-[10px] font-bold">✓</span>}
                    </div>
                    <span>Ajustar origen a 0 (generar salida de ajuste por {Math.abs(diff)} {origin.un})</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPiso || !destPos || !qty || qtyNum <= 0} className="gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Confirmar traslado
          </Button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════
          DIALOG DE CONFIRMACIÓN
          ═══════════════════════════════════════════════════ */}
      <AlertDialog open={confirm} onOpenChange={(open) => { if (!open) { setConfirm(false); setConfirmMode(null); setAjustarACero(false) } }}>
        <AlertDialogContent className="max-w-[95vw] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmMode === 'exceeds' && 'Traslado con corrección de stock'}
              {confirmMode === 'less' && !ajustarACero && 'Confirmar traslado parcial'}
              {confirmMode === 'less' && ajustarACero && 'Traslado con ajuste a 0 en origen'}
              {confirmMode === 'equal' && 'Confirmar traslado total'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {/* Info del artículo */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Código</span>
                    <p className="font-mono font-bold">{origin?.codigo}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Descripción</span>
                    <p className="font-medium line-clamp-2">{origin?.descripcion}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded border p-2">
                    <span className="text-muted-foreground">Origen</span>
                    <p className="font-bold">B{origin?.bloque} T{origin?.torre} P{origin?.piso} Pos{origin?.posicion}</p>
                    <p className="text-muted-foreground">Stock: {origin?.stock} {origin?.un}</p>
                  </div>
                  <div className="rounded border p-2">
                    <span className="text-muted-foreground">Destino</span>
                    <p className="font-bold">B{destBloque} T{destTorre} P{destPiso} Pos{destPos}</p>
                    <p className="text-muted-foreground">Recibirá: {qty} {origin?.un}</p>
                  </div>
                </div>

                {/* ─── CASO: qty > stock (con corrección) ─── */}
                {confirmMode === 'exceeds' && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-3 space-y-1.5">
                    <p className="text-xs font-bold text-blue-700 dark:text-blue-300 flex items-center gap-1">
                      <ArrowUp className="h-3.5 w-3.5" /> Corrección automática
                    </p>
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      La cantidad supera el stock del sistema en <strong>{Math.abs(diff)} {origin?.un}</strong>.
                    </p>
                    <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
                      <p>1. <strong>Ingreso de corrección</strong> de {Math.abs(diff)} {origin?.un} en origen</p>
                      <p>2. <strong>Salida</strong> de {qty} {origin?.un} en origen → queda <strong>0</strong></p>
                      <p>3. <strong>Traslado</strong> de {qty} {origin?.un} al destino</p>
                    </div>
                  </div>
                )}

                {/* ─── CASO: qty < stock (parcial) ─── */}
                {confirmMode === 'less' && (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">¿Qué desea hacer?</p>
                    <p className="text-xs text-muted-foreground">
                      La cantidad a trasladar ({qty} {origin?.un}) es <strong>menor</strong> al stock ({origin?.stock} {origin?.un}).
                    </p>

                    <div className="space-y-2">
                      {/* Opción A: Traslado parcial normal */}
                      <button
                        type="button"
                        onClick={() => setAjustarACero(false)}
                        className={`
                          w-full text-left rounded-lg border-2 p-2.5 transition-all cursor-pointer
                          ${!ajustarACero
                            ? 'border-green-400 bg-green-50 dark:bg-green-950/30'
                            : 'border-border bg-card hover:border-green-200'
                          }
                        `}
                      >
                        <div className="flex items-center gap-2">
                          <div className={`
                            shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center
                            ${!ajustarACero ? 'border-green-500 bg-green-500' : 'border-muted-foreground/40'}
                          `}>
                            {!ajustarACero && <span className="text-white text-[10px] font-bold">●</span>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-xs text-foreground">Traslado parcial — dejar saldo</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              Enviar <strong>{qty} {origin?.un}</strong> al destino. Quedan <strong>{saldo} {origin?.un}</strong> en el origen.
                            </p>
                          </div>
                          <Package className="h-4 w-4 text-green-500 shrink-0" />
                        </div>
                      </button>

                      {/* Opción B: Ajustar a cero */}
                      <button
                        type="button"
                        onClick={() => setAjustarACero(true)}
                        className={`
                          w-full text-left rounded-lg border-2 p-2.5 transition-all cursor-pointer
                          ${ajustarACero
                            ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30'
                            : 'border-border bg-card hover:border-amber-200'
                          }
                        `}
                      >
                        <div className="flex items-center gap-2">
                          <div className={`
                            shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center
                            ${ajustarACero ? 'border-amber-500 bg-amber-500' : 'border-muted-foreground/40'}
                          `}>
                            {ajustarACero && <span className="text-white text-[10px] font-bold">●</span>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-xs text-foreground">Ajustar origen a 0</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              Enviar <strong>{qty} {origin?.un}</strong> al destino + <strong>salida de ajuste</strong> de {Math.abs(diff)} {origin?.un}. Origen queda en <strong>0</strong>.
                            </p>
                          </div>
                          <Trash2 className="h-4 w-4 text-amber-500 shrink-0" />
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── CASO: qty === stock (total) ─── */}
                {confirmMode === 'equal' && (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1">
                    <p className="text-xs font-bold text-amber-700 dark:text-amber-300">Traslado total</p>
                    <p className="text-xs text-muted-foreground">
                      Se trasladan <strong>todos</strong> los {origin?.stock} {origin?.un} al destino. El origen quedará vacío.
                    </p>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doTraslado} disabled={busy}>
              {busy ? (
                <span className="flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" /> Procesando...</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <ArrowRightLeft className="h-4 w-4" />
                  {confirmMode === 'less' && ajustarACero && 'Trasladar y ajustar a 0'}
                  {confirmMode === 'less' && !ajustarACero && 'Trasladar parcialmente'}
                  {confirmMode === 'exceeds' && 'Trasladar con corrección'}
                  {confirmMode === 'equal' && 'Trasladar todo'}
                </span>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
