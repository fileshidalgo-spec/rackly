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
import { Loader2, ArrowRightLeft, PackageSearch } from 'lucide-react'
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
  const [destBloque, setDestBloque] = useState('')
  const [destTorre, setDestTorre] = useState('')
  const [destPiso, setDestPiso] = useState('')
  const [destPos, setDestPos] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [exceedsStock, setExceedsStock] = useState(false)

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
    const qtyNum = parseFloat(qty)
    if (!qtyNum || qtyNum <= 0) {
      toast.error('Ingresa una cantidad válida mayor a 0')
      return
    }
    // Permitir qty > stock con confirmación especial
    if (qtyNum > origin.stock) {
      setExceedsStock(true)
    } else {
      setExceedsStock(false)
    }
    setConfirm(true)
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    const qtyNum = parseFloat(qty)
    setBusy(true)
    try {
      const diferencia = qtyNum - origin.stock
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
      })
      if (diferencia > 0) {
        toast.success(`Traslado registrado. Se generó un ingreso de corrección de ${diferencia} ${origin.un} en origen.`, { duration: 5000 })
      } else {
        toast.success('Traslado registrado')
      }
      setMovs(result)
      resetForm()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al trasladar', { description: message })
    } finally {
      setBusy(false)
      setConfirm(false)
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
            <Label>Cantidad a trasladar {origin.un}</Label>
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
            {qty && parseFloat(qty) > origin.stock && (
              <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                La cantidad ({parseFloat(qty)}) supera el stock del sistema ({origin.stock} {origin.un}). Se generará un ingreso de corrección automático de {(parseFloat(qty) - origin.stock)} {origin.un} en el origen.
              </p>
            )}
          </div>

          <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPiso || !destPos || !qty || parseFloat(qty) <= 0} className="gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Confirmar traslado
          </Button>
        </div>
      )}

      {/* Dialog de confirmación */}
      <AlertDialog open={confirm} onOpenChange={(open) => { if (!open) { setConfirm(false); setExceedsStock(false) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {exceedsStock ? 'Traslado con corrección de stock' : 'Confirmar traslado'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {exceedsStock && (
                  <>
                    <div className="rounded-lg border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-3 text-blue-700 dark:text-blue-300">
                      <p className="font-medium mb-1">Corrección automática</p>
                      <p>La cantidad supera el stock del sistema. Se registrará un <strong>ingreso de corrección</strong> de <strong>{(() => { const q = parseFloat(qty); const o = origin?.stock ?? 0; return (q - o).toLocaleString() })()} {origin?.un}</strong> en el origen para igualar la cantidad física real.</p>
                    </div>
                    <div className="rounded-lg border border-muted p-2.5 text-xs text-muted-foreground space-y-1">
                      <p>• Origen: stock {origin?.stock} {origin?.un} → ingreso de {(() => { const q = parseFloat(qty); const o = origin?.stock ?? 0; return (q - o).toLocaleString() })()} {origin?.un} → stock {parseFloat(qty)} {origin?.un}</p>
                      <p>• Luego: salida de {qty} {origin?.un} en origen → stock 0</p>
                      <p>• Destino: ingreso de {qty} {origin?.un} por traslado</p>
                    </div>
                  </>
                )}
                <p><strong>Código:</strong> {origin?.codigo} — {origin?.descripcion}</p>
                <p><strong>Cantidad a trasladar:</strong> {qty} {origin?.un}</p>
                <p><strong>Origen:</strong> B{origin?.bloque} T{origin?.torre} P{origin?.piso} Pos{origin?.posicion}</p>
                <p><strong>Destino:</strong> B{destBloque} T{destTorre} P{destPiso} Pos{destPos}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doTraslado}>
              {busy ? 'Procesando...' : 'Confirmar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
