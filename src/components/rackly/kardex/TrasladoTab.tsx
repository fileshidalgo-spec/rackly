'use client'

import { useState, useEffect } from 'react'
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
import type { CatalogoItem, StockEnUbicacion } from '@/lib/rackly/catalogo'

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
  const [destPos, setDestPos] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

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
        current.stock += m.tipo === 'ingreso' ? m.cantidad : -m.cantidad
        if (m.fVencimiento && (!current.fVencimiento || m.fVencimiento < current.fVencimiento)) {
          current.fVencimiento = m.fVencimiento
        }
      } else {
        locMap.set(key, {
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: m.tipo === 'ingreso' ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion,
          un: m.un,
          fVencimiento: m.fVencimiento || '',
          codigo: m.codigo,
          proveedor: m.proveedor,
        })
      }
    }
    setLocations(Array.from(locMap.values()).filter((l) => l.stock > 0)
      // Ordenar por vencimiento más próximo primero (sin fecha van al final)
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
    if (selectedOrigin === `${destBloque}-${destTorre}-1-${destPos}`) {
      toast.error('El destino no puede ser igual al origen')
      return
    }
    const qtyNum = parseFloat(qty) || origin.stock
    if (qtyNum <= 0 || qtyNum > origin.stock) {
      toast.error('Cantidad inválida')
      return
    }
    setConfirm(true)
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    const qtyNum = parseFloat(qty) || origin.stock
    setBusy(true)
    try {
      const result = await trasladarMovimiento({
        codigo: origin.codigo,
        descripcion: origin.descripcion,
        un: origin.un,
        cantidad: qtyNum,
        origen: {
          bloque: origin.bloque,
          torre: origin.torre,
          piso: origin.piso,
          posicion: origin.posicion,
        },
        destino: {
          bloque: destBloque,
          torre: destTorre,
          piso: '1',
          posicion: destPos,
        },
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        fVencimiento: origin.fVencimiento,
        proveedor: origin.proveedor,
      })
      toast.success('Traslado registrado')
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
                    <TableCell>B{loc.bloque} T{loc.torre} P{loc.piso} Pos{loc.posicion}</TableCell>
                    <TableCell className="text-right font-medium">{loc.stock} {loc.un}</TableCell>
                    <TableCell>{loc.fVencimiento || '—'}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </>
      )}

      {origin && step === 2 && (
        <div className="space-y-3 p-4 border rounded-lg">
          <p className="text-sm font-medium">2. Elige ubicación de destino:</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
            <Label>Cantidad</Label>
            <Input
              type="number"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={`Máx: ${origin.stock}`}
            />
          </div>

          <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPos} className="gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Confirmar traslado
          </Button>
        </div>
      )}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar traslado</AlertDialogTitle>
            <AlertDialogDescription>
              <div className="space-y-2 text-sm">
                <p><strong>Código:</strong> {origin?.codigo} — {origin?.descripcion}</p>
                <p><strong>Cantidad:</strong> {qty} {origin?.un}</p>
                <p><strong>Origen:</strong> B{origin?.bloque} T{origin?.torre} P{origin?.piso} Pos{origin?.posicion}</p>
                <p><strong>Destino:</strong> B{destBloque} T{destTorre} P1 Pos{destPos}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doTraslado}>
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
