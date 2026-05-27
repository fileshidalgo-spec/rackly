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
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Loader2, ArrowRightLeft, ArrowDown, ArrowUp, Minus, Equal,
  Package, Trash2, MapPin, Building2, Warehouse, Clock,
  ChevronRight, RotateCcw, Truck, BoxSelect, Tag, User,
} from 'lucide-react'
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

type ConfirmMode = 'equal' | 'exceeds' | 'less' | null

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */
function diasVencimiento(fVenc: string): number | null {
  if (!fVenc) return null
  return Math.ceil((new Date(fVenc).getTime() - Date.now()) / 86400000)
}

function VencimientoBadge({ fVenc }: { fVenc: string }) {
  const dias = diasVencimiento(fVenc)
  if (dias === null) return <span className="text-muted-foreground text-xs">Sin fecha</span>
  return (
    <Badge
      variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'}
      className={`text-[11px] gap-1 ${dias <= 15 && dias > 0 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}`}
    >
      <Clock className="h-3 w-3" />
      {dias <= 0 ? 'Vencido' : `${dias}d`}
    </Badge>
  )
}

function fmtNum(n: number) {
  return Number.isInteger(n) ? n.toString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

/* ═══════════════════════════════════════════
   COMPONENTE PRINCIPAL
   ═══════════════════════════════════════════ */
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

  /* ─── Buscar ubicaciones con stock ─── */
  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    const code = item.codigo.toUpperCase()
    const locMap = new Map<string, LocStock>()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const cur = locMap.get(key)
      if (cur) {
        cur.stock += (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado')
          ? m.cantidad : -m.cantidad
        if (m.fVencimiento && (!cur.fVencimiento || m.fVencimiento < cur.fVencimiento)) {
          cur.fVencimiento = m.fVencimiento
        }
        if (m.proveedor && !cur.proveedor) cur.proveedor = m.proveedor
      } else {
        locMap.set(key, {
          bloque: m.bloque, torre: m.torre, piso: m.piso, posicion: m.posicion,
          stock: (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado') ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion, un: m.un, fVencimiento: m.fVencimiento || '',
          codigo: m.codigo, proveedor: m.proveedor,
        })
      }
    }
    setLocations(Array.from(locMap.values()).filter((l) => l.stock > 0)
      .sort((a, b) => {
        const da = a.fVencimiento ? new Date(a.fVencimiento).getTime() : Infinity
        const db = b.fVencimiento ? new Date(b.fVencimiento).getTime() : Infinity
        return da - db
      }))
    setStep(1)
    setSelectedOrigin(null)
    setDestBloque(''); setDestTorre(''); setDestPiso(''); setDestPos('')
    setQty('')
  }

  const origin = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === selectedOrigin)
  const qtyNum = qty ? parseFloat(qty) : 0
  const diff = qtyNum - (origin?.stock ?? 0)
  const saldo = origin ? origin.stock - qtyNum : 0
  const destTorres = torresDeBloque(destBloque)
  const destPositions = posicionesDeBloque(destBloque)

  function handleConfirm() {
    if (!origin) return
    const oKey = `${origin.bloque}-${origin.torre}-${origin.piso}-${origin.posicion}`
    const dKey = `${destBloque}-${destTorre}-${destPiso}-${destPos}`
    if (oKey === dKey) { toast.error('El destino no puede ser igual al origen'); return }
    if (!destBloque || !destTorre || !destPiso || !destPos) { toast.error('Completa la ubicación de destino'); return }
    if (!qtyNum || qtyNum <= 0) { toast.error('Ingresa una cantidad válida mayor a 0'); return }
    if (diff > 0) setConfirmMode('exceeds')
    else if (diff < 0) { setConfirmMode('less'); setAjustarACero(false) }
    else setConfirmMode('equal')
    setConfirm(true)
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    setBusy(true)
    try {
      const result = await trasladarMovimiento({
        codigo: origin.codigo, descripcion: origin.descripcion, un: origin.un,
        cantidad: qtyNum, stockActual: origin.stock,
        origen: { bloque: origin.bloque, torre: origin.torre, piso: origin.piso, posicion: origin.posicion },
        destino: { bloque: destBloque, torre: destTorre, piso: destPiso, posicion: destPos },
        turno: calcularTurno(), usuarioId: perfil.id,
        usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        fVencimiento: origin.fVencimiento, proveedor: origin.proveedor,
        ajustarOrigenACero: ajustarACero,
      })
      if (diff > 0) toast.success(`Traslado registrado. Corrección de +${fmtNum(Math.abs(diff))} ${origin.un} en origen.`, { duration: 5000 })
      else if (diff < 0 && ajustarACero) toast.success(`Traslado registrado. Origen ajustado a 0 (salida de ajuste de ${fmtNum(Math.abs(diff))} ${origin.un}).`, { duration: 5000 })
      else if (diff < 0) toast.success(`Traslado registrado. Quedan ${fmtNum(saldo)} ${origin.un} en el origen.`, { duration: 5000 })
      else toast.success('Traslado total registrado. Origen vacío.')
      setMovs(result)
      resetForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al trasladar', { description: message })
    } finally { setBusy(false); setConfirm(false); setConfirmMode(null) }
  }

  function resetForm() {
    setCodigo(''); setDescripcion(''); setUn(''); setLocations([]); setSelectedOrigin(null)
    setDestBloque(''); setDestTorre(''); setDestPiso(''); setDestPos(''); setQty(''); setStep(1)
  }

  return (
    <div className="space-y-5">
      {/* ─── Búsqueda ─── */}
      <CatalogoSearchInput
        onPick={handleCatalogoPick}
        value={codigo}
        onChange={(v) => { setCodigo(v); const cat = findCatalogoByCodigoFromCache(v); if (cat) handleCatalogoPick(cat) }}
      />

      {/* ═══════════════════════════════════════════════════
          PASO 1: SELECCIONAR ORIGEN (tarjetas modernas)
          ═══════════════════════════════════════════════════ */}
      {locations.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">1</div>
            <h3 className="text-sm font-bold text-foreground">Selecciona ubicación de origen</h3>
            <Badge variant="secondary" className="text-[10px]">{locations.length} ubicaciones</Badge>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {locations.map((loc) => {
              const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
              const dias = diasVencimiento(loc.fVencimiento)
              const isSelected = selectedOrigin === key

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setSelectedOrigin(key); setQty(String(loc.stock)); setStep(2) }}
                  className={`
                    group relative text-left rounded-xl border-2 p-3.5 transition-all duration-200 cursor-pointer
                    hover:shadow-md hover:scale-[1.01]
                    ${isSelected
                      ? 'border-blue-500 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 shadow-md ring-1 ring-blue-200 dark:ring-blue-800'
                      : 'border-border bg-card hover:border-blue-300 dark:hover:border-blue-700'
                    }
                  `}
                >
                  {/* Header: ubicación + stock */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`
                        shrink-0 flex h-8 w-8 items-center justify-center rounded-lg
                        ${isSelected
                          ? 'bg-blue-600 text-white'
                          : 'bg-muted text-muted-foreground group-hover:bg-blue-100 group-hover:text-blue-600 dark:group-hover:bg-blue-950 dark:group-hover:text-blue-400'
                        }
                      `}>
                        <MapPin className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-mono font-bold text-sm text-foreground">
                          B{loc.bloque} T{loc.torre} P{loc.piso} Pos{loc.posicion}
                        </p>
                      </div>
                    </div>
                    <div className={`
                      shrink-0 px-2.5 py-1 rounded-lg text-sm font-bold
                      ${isSelected
                        ? 'bg-blue-600 text-white'
                        : 'bg-muted text-foreground'
                      }
                    `}>
                      {fmtNum(loc.stock)} <span className="text-xs font-medium">{loc.un}</span>
                    </div>
                  </div>

                  {/* Descripción */}
                  <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {loc.descripcion}
                  </p>

                  {/* Tags: vencimiento + proveedor */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <VencimientoBadge fVenc={loc.fVencimiento} />
                    {loc.proveedor && (
                      <Badge variant="outline" className="text-[11px] gap-1 border-slate-200 dark:border-slate-700">
                        <User className="h-3 w-3" />
                        {loc.proveedor}
                      </Badge>
                    )}
                    {isSelected && (
                      <Badge className="text-[11px] bg-blue-600 text-white ml-auto gap-0.5">
                        Seleccionado <ChevronRight className="h-3 w-3" />
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════
          PASO 2: DESTINO + CANTIDAD
          ═══════════════════════════════════════════════════ */}
      {origin && step === 2 && (
        <div className="space-y-4">
          {/* Origen seleccionado (compacto) */}
          <div className="flex items-center gap-2 px-1">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-600 text-white text-xs font-bold">
              <BoxSelect className="h-3 w-3" />
            </div>
            <h3 className="text-sm font-bold text-foreground">Origen seleccionado</h3>
          </div>

          <div className="rounded-xl border-2 border-green-300 dark:border-green-800 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 p-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              {/* Info del producto origen */}
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-xl bg-green-600 text-white">
                  <Warehouse className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-bold text-sm">{origin.codigo}</p>
                  <p className="text-xs text-muted-foreground line-clamp-1">{origin.descripcion}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[11px] gap-1">
                      <MapPin className="h-3 w-3" /> B{origin.bloque} T{origin.torre} P{origin.piso} Pos{origin.posicion}
                    </Badge>
                    <VencimientoBadge fVenc={origin.fVencimiento} />
                    {origin.proveedor && (
                      <Badge variant="outline" className="text-[11px] gap-1">
                        <User className="h-3 w-3" /> {origin.proveedor}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              {/* Stock */}
              <div className="shrink-0 text-center sm:text-right px-3 py-2 rounded-lg bg-green-100 dark:bg-green-900/40">
                <p className="text-2xl font-bold text-green-700 dark:text-green-400">{fmtNum(origin.stock)}</p>
                <p className="text-[10px] text-green-600 dark:text-green-500 font-medium uppercase">{origin.un} disponibles</p>
              </div>
            </div>
          </div>

          {/* Destino */}
          <div className="flex items-center gap-2 px-1">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs font-bold">2</div>
            <h3 className="text-sm font-bold text-foreground">Elige ubicación de destino</h3>
          </div>

          <div className="rounded-xl border bg-card p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Bloque', icon: Building2, val: destBloque, set: (v: string) => { setDestBloque(v); setDestTorre(''); setDestPiso(''); setDestPos('') }, opts: BLOQUES, dis: false },
                { label: 'Torre', icon: Warehouse, val: destTorre, set: (v: string) => { setDestTorre(v); setDestPiso(''); setDestPos('') }, opts: destTorres, dis: !destBloque },
                { label: 'Piso', icon: ArrowDown, val: destPiso, set: (v: string) => { setDestPiso(v); setDestPos('') }, opts: PISOS, dis: !destBloque },
                { label: 'Posición', icon: MapPin, val: destPos, set: setDestPos, opts: destPositions, dis: !destBloque },
              ].map(({ label, icon: Icon, val, set, opts, dis }) => (
                <div key={label} className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Icon className="h-3 w-3" /> {label}
                  </Label>
                  <Select value={val} onValueChange={set} disabled={dis}>
                    <SelectTrigger className={`h-10 ${val ? 'border-blue-300 dark:border-blue-700' : ''}`}>
                      <SelectValue placeholder={label} />
                    </SelectTrigger>
                    <SelectContent>
                      {opts.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {/* Cantidad */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Tag className="h-3 w-3" /> Cantidad a trasladar ({origin.un})
              </Label>
              <div className="relative">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={qty}
                  onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                  onFocus={(e) => e.target.select()}
                  placeholder={origin.stock.toString()}
                  className={`h-11 text-lg font-bold pr-16 ${diff > 0 ? 'border-blue-300 dark:border-blue-700' : diff < 0 ? 'border-amber-300 dark:border-amber-700' : diff === 0 && qtyNum > 0 ? 'border-green-300 dark:border-green-700' : ''}`}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">{origin.un}</span>
              </div>
            </div>

            {/* ─── PANEL DE AJUSTE EN TIEMPO REAL ─── */}
            {qty && qtyNum > 0 && (
              <div className="rounded-xl border bg-muted/30 p-3.5 space-y-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Resumen del ajuste</p>

                {/* Flujo visual Origen → Destino */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                  {/* Origen */}
                  <div className={`
                    flex-1 rounded-lg border p-2.5 space-y-1
                    ${diff > 0
                      ? 'border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20'
                      : diff < 0 && ajustarACero
                        ? 'border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'
                        : 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20'
                    }
                  `}>
                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Origen</p>
                    <p className="text-lg font-bold">{origin.stock} → <span className={
                      diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                    }>{diff > 0 ? 0 : (ajustarACero ? 0 : fmtNum(saldo))}</span> <span className="text-xs text-muted-foreground">{origin.un}</span></p>
                    {diff > 0 && (
                      <p className="text-[10px] text-blue-600 dark:text-blue-400">+{fmtNum(Math.abs(diff))} corrección</p>
                    )}
                    {diff < 0 && !ajustarACero && (
                      <p className="text-[10px] text-green-600 dark:text-green-400">-{qtyNum} salida</p>
                    )}
                    {diff < 0 && ajustarACero && (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">-{qtyNum} salida + -{fmtNum(Math.abs(diff))} ajuste</p>
                    )}
                  </div>

                  {/* Flecha */}
                  <div className="flex items-center justify-center sm:py-4">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50">
                      <Truck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    </div>
                  </div>

                  {/* Destino */}
                  <div className="flex-1 rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-2.5 space-y-1">
                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Destino</p>
                    <p className="text-lg font-bold">0 → <span className="text-blue-600 dark:text-blue-400">{fmtNum(qtyNum)}</span> <span className="text-xs text-muted-foreground">{origin.un}</span></p>
                    <p className="text-[10px] text-blue-600 dark:text-blue-400">+{fmtNum(qtyNum)} por traslado</p>
                  </div>
                </div>

                {/* Mensaje según caso */}
                {diff > 0 && (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                    <ArrowUp className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-blue-700 dark:text-blue-300">
                      <strong>Mayor al stock.</strong> Se generará un ingreso de corrección de <strong>{fmtNum(Math.abs(diff))} {origin.un}</strong> en el origen antes de la salida. Origen quedará en 0.
                    </p>
                  </div>
                )}
                {diff < 0 && !ajustarACero && (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
                    <Minus className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-green-700 dark:text-green-300">
                      <strong>Traslado parcial.</strong> Se trasladan {fmtNum(qtyNum)} {origin.un}. Quedan <strong>{fmtNum(saldo)} {origin.un}</strong> en el origen.
                    </p>
                  </div>
                )}
                {diff < 0 && ajustarACero && (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                    <Trash2 className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      <strong>Ajustar a 0.</strong> Se trasladan {fmtNum(qtyNum)} {origin.un} + salida de ajuste de {fmtNum(Math.abs(diff))} {origin.un}. Origen queda en 0.
                    </p>
                  </div>
                )}
                {diff === 0 && (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                    <Equal className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                      <strong>Traslado total.</strong> Se trasladan todos los {origin.stock} {origin.un}. El origen quedará vacío.
                    </p>
                  </div>
                )}

                {/* Toggle ajustar a cero */}
                {diff < 0 && (
                  <button
                    type="button"
                    onClick={() => setAjustarACero(!ajustarACero)}
                    className={`
                      flex items-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-xs font-medium transition-all cursor-pointer w-full
                      ${ajustarACero
                        ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-700'
                        : 'border-border bg-card text-muted-foreground hover:border-amber-200 hover:bg-amber-50/50 dark:hover:border-amber-800'
                      }
                    `}
                  >
                    <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${ajustarACero ? 'border-amber-500 bg-amber-500' : 'border-muted-foreground/30'}`}>
                      {ajustarACero && <span className="text-white text-xs font-bold">✓</span>}
                    </div>
                    <span>Ajustar origen a 0 (salida de ajuste por {fmtNum(Math.abs(diff))} {origin.un})</span>
                  </button>
                )}
              </div>
            )}

            {/* Botones */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setStep(1); setSelectedOrigin(null) }} className="gap-1.5 shrink-0">
                <RotateCcw className="h-4 w-4" /> <span className="hidden sm:inline">Volver</span>
              </Button>
              <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPiso || !destPos || !qty || qtyNum <= 0} className="gap-2 flex-1">
                <ArrowRightLeft className="h-4 w-4" />
                Confirmar traslado
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════
          DIALOG DE CONFIRMACIÓN
          ═══════════════════════════════════════════════════ */}
      <AlertDialog open={confirm} onOpenChange={(open) => { if (!open) { setConfirm(false); setConfirmMode(null); setAjustarACero(false) } }}>
        <AlertDialogContent className="max-w-[95vw] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {confirmMode === 'exceeds' && <><ArrowUp className="h-5 w-5 text-blue-500" /> Traslado con corrección</>}
              {confirmMode === 'less' && !ajustarACero && <><Minus className="h-5 w-5 text-green-500" /> Traslado parcial</>}
              {confirmMode === 'less' && ajustarACero && <><Trash2 className="h-5 w-5 text-amber-500" /> Traslado con ajuste a 0</>}
              {confirmMode === 'equal' && <><Equal className="h-5 w-5 text-emerald-500" /> Traslado total</>}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {/* Info del artículo */}
                <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono font-bold">{origin?.codigo}</span>
                    <Badge variant="secondary" className="text-[10px]">{qty} {origin?.un}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{origin?.descripcion}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <VencimientoBadge fVenc={origin?.fVencimiento ?? ''} />
                    {origin?.proveedor && (
                      <Badge variant="outline" className="text-[11px] gap-1"><User className="h-3 w-3" /> {origin.proveedor}</Badge>
                    )}
                  </div>
                </div>

                {/* Origen → Destino */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border-2 border-red-200 dark:border-red-800 p-2.5 space-y-1">
                    <p className="text-[10px] font-bold uppercase text-red-600 dark:text-red-400">Origen (salida)</p>
                    <p className="font-bold text-sm">B{origin?.bloque} T{origin?.torre} P{origin?.piso} Pos{origin?.posicion}</p>
                    <p className="text-xs text-muted-foreground">Stock: {origin?.stock} {origin?.un}</p>
                  </div>
                  <div className="rounded-lg border-2 border-blue-200 dark:border-blue-800 p-2.5 space-y-1">
                    <p className="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400">Destino (ingreso)</p>
                    <p className="font-bold text-sm">B{destBloque} T{destTorre} P{destPiso} Pos{destPos}</p>
                    <p className="text-xs text-muted-foreground">Recibirá: {qty} {origin?.un}</p>
                  </div>
                </div>

                {/* Excede */}
                {confirmMode === 'exceeds' && (
                  <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-3 space-y-1.5">
                    <p className="text-xs font-bold text-blue-700 dark:text-blue-300 flex items-center gap-1"><ArrowUp className="h-3.5 w-3.5" /> Corrección automática</p>
                    <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
                      <p>1. <strong className="text-blue-600 dark:text-blue-400">Ingreso</strong> de {fmtNum(Math.abs(diff))} {origin?.un} en origen</p>
                      <p>2. <strong className="text-red-600 dark:text-red-400">Salida</strong> de {qty} {origin?.un} en origen → <strong>0</strong></p>
                      <p>3. <strong className="text-blue-600 dark:text-blue-400">Traslado</strong> de {qty} {origin?.un} al destino</p>
                    </div>
                  </div>
                )}

                {/* Menor al stock: 2 opciones */}
                {confirmMode === 'less' && (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                    <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">¿Qué desea hacer con el excedente de {fmtNum(Math.abs(diff))} {origin?.un}?</p>
                    <div className="space-y-2">
                      <button type="button" onClick={() => setAjustarACero(false)} className={`w-full text-left rounded-lg border-2 p-3 transition-all cursor-pointer ${!ajustarACero ? 'border-green-400 bg-green-50 dark:bg-green-950/30' : 'border-border bg-card hover:border-green-200'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${!ajustarACero ? 'border-green-500 bg-green-500' : 'border-muted-foreground/40'}`}>
                            {!ajustarACero && <span className="text-white text-[10px]">●</span>}
                          </div>
                          <div className="flex-1">
                            <p className="font-semibold text-xs">Dejar saldo en origen</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">Quedan <strong>{fmtNum(saldo)} {origin?.un}</strong> en el origen.</p>
                          </div>
                          <Package className="h-4 w-4 text-green-500 shrink-0" />
                        </div>
                      </button>
                      <button type="button" onClick={() => setAjustarACero(true)} className={`w-full text-left rounded-lg border-2 p-3 transition-all cursor-pointer ${ajustarACero ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30' : 'border-border bg-card hover:border-amber-200'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${ajustarACero ? 'border-amber-500 bg-amber-500' : 'border-muted-foreground/40'}`}>
                            {ajustarACero && <span className="text-white text-[10px]">●</span>}
                          </div>
                          <div className="flex-1">
                            <p className="font-semibold text-xs">Ajustar origen a 0</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">Generar <strong>salida de ajuste</strong> de {fmtNum(Math.abs(diff))} {origin?.un}. Origen = 0.</p>
                          </div>
                          <Trash2 className="h-4 w-4 text-amber-500 shrink-0" />
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {/* Total */}
                {confirmMode === 'equal' && (
                  <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-3">
                    <p className="text-xs text-muted-foreground">Se trasladan <strong className="text-emerald-700 dark:text-emerald-300">todos los {origin?.stock} {origin?.un}</strong> al destino. El origen quedará vacío.</p>
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
