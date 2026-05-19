'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  addMovimiento,
  calcularStockUbicacion,
  stockEnUbicacion,
  type Movimiento,
  type TipoMovimiento,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { findCatalogoByCodigo, fetchCatalogo } from '@/lib/rackly/catalogo'
import { useAuth } from '@/hooks/useAuth'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Loader2, PackageSearch } from 'lucide-react'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

type Props = {
  tipo: TipoMovimiento
  onCreated: (movs: Movimiento[]) => void
}

export function MovimientoForm({ tipo, onCreated }: Props) {
  const { perfil } = useAuth()
  const [turno, setTurno] = useState(calcularTurno())

  useEffect(() => {
    const interval = setInterval(() => setTurno(calcularTurno()), 60000)
    return () => clearInterval(interval)
  }, [])

  if (tipo === 'ingreso') {
    return <IngresoForm turno={turno} onCreated={onCreated} perfil={perfil!} />
  }
  return <SalidaForm turno={turno} onCreated={onCreated} perfil={perfil!} />
}

function IngresoForm({
  turno,
  onCreated,
  perfil,
}: {
  turno: string
  onCreated: (movs: Movimiento[]) => void
  perfil: { id: string; nombre: string; correo: string }
}) {
  const [bloque, setBloque] = useState('')
  const [torre, setTorre] = useState('')
  const [piso, setPiso] = useState('')
  const [posicion, setPosicion] = useState('')
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [fVencimiento, setFVencimiento] = useState('')
  const [sinVencimiento, setSinVencimiento] = useState(false)
  const [proveedor, setProveedor] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmData, setConfirmData] = useState<StockEnUbicacion[] | null>(null)

  const torres = torresDeBloque(bloque)
  const posiciones = posicionesDeBloque(bloque)

  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    if (item.descripcion.toLowerCase().includes('lámina termocontraible')) {
      // proveedor required
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!bloque || !torre || !piso || !posicion || !codigo.trim() || !cantidad) {
      toast.error('Completa todos los campos requeridos')
      return
    }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('La cantidad debe ser mayor a 0')
      return
    }
    setBusy(true)
    try {
      const stock = await calcularStockUbicacion(codigo, bloque, torre, piso, posicion)
      if (stock > 0) {
        const details = await stockEnUbicacion(bloque, torre, piso, posicion)
        setConfirmData(details)
        setBusy(false)
        return
      }
      await doInsert(qty)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al verificar stock', { description: message })
      setBusy(false)
    }
  }

  async function doInsert(qty: number) {
    try {
      const movs = await addMovimiento({
        tipo: 'ingreso',
        bloque,
        torre,
        piso,
        posicion,
        codigo,
        descripcion,
        un,
        cantidad: qty,
        fVencimiento: sinVencimiento ? '' : fVencimiento,
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: proveedor || undefined,
      })
      toast.success('Ingreso registrado')
      setCodigo('')
      setDescripcion('')
      setUn('')
      setCantidad('')
      setFVencimiento('')
      setProveedor('')
      onCreated(movs)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al registrar ingreso', { description: message })
    } finally {
      setBusy(false)
      setConfirmData(null)
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label>Bloque</Label>
            <Select value={bloque} onValueChange={(v) => { setBloque(v); setTorre(''); setPiso(''); setPosicion('') }}>
              <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
              <SelectContent>
                {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Torre</Label>
            <Select value={torre} onValueChange={setTorre} disabled={!bloque}>
              <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
              <SelectContent>
                {torres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Piso</Label>
            <Select value={piso} onValueChange={setPiso} disabled={!bloque}>
              <SelectTrigger><SelectValue placeholder="Piso" /></SelectTrigger>
              <SelectContent>
                {PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Posición</Label>
            <Select value={posicion} onValueChange={setPosicion} disabled={!bloque}>
              <SelectTrigger><SelectValue placeholder="Posición" /></SelectTrigger>
              <SelectContent>
                {posiciones.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Turno</Label>
            <Input value={turno} readOnly className="bg-muted" />
          </div>
        </div>

        <CatalogoSearchInput
          onPick={handleCatalogoPick}
          value={codigo}
          onChange={(v) => {
            setCodigo(v)
            const cat = findCatalogoByCodigo(v)
            if (cat) {
              setDescripcion(cat.descripcion)
              setUn(cat.un)
            }
          }}
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label>Descripción</Label>
            <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} readOnly placeholder="Se llena desde catálogo" />
          </div>
          <div className="space-y-1">
            <Label>UN</Label>
            <Input value={un} onChange={(e) => setUn(e.target.value)} readOnly placeholder="UN" />
          </div>
          <div className="space-y-1">
            <Label>Cantidad</Label>
            <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="0" />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>F. Vencimiento</Label>
            <div className="flex items-center gap-2">
              <Input type="date" value={fVencimiento} onChange={(e) => setFVencimiento(e.target.value)} disabled={sinVencimiento} />
              <Checkbox checked={sinVencimiento} onCheckedChange={(v) => setSinVencimiento(!!v)} />
            </div>
          </div>
          <div className="space-y-1 col-span-2">
            <Label>Proveedor</Label>
            <Input value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="Opcional" />
          </div>
        </div>

        <Button type="submit" disabled={busy} className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white">
          {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Registrar Ingreso
        </Button>
      </form>

      <AlertDialog open={!!confirmData} onOpenChange={() => setConfirmData(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ubicación ocupada</AlertDialogTitle>
            <AlertDialogDescription>
              Esta posición ya tiene stock. ¿Deseas agregar de todas formas?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmData && confirmData.length > 0 && (
            <div className="my-2">
              <Table>
                <TableBody>
                  {confirmData.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono">{s.codigo}</TableCell>
                      <TableCell>{s.descripcion}</TableCell>
                      <TableCell className="text-right">{s.stock}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => doInsert(parseFloat(cantidad))}>
              Confirmar ingreso
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SalidaForm({
  turno,
  onCreated,
  perfil,
}: {
  turno: string
  onCreated: (movs: Movimiento[]) => void
  perfil: { id: string; nombre: string; correo: string }
}) {
  const [searchCode, setSearchCode] = useState('')
  const [locations, setLocations] = useState<(StockEnUbicacion & { bloque: string; torre: string; piso: string; posicion: string })[]>([])
  const [selectedLoc, setSelectedLoc] = useState<string | null>(null)
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!searchCode.trim()) {
      setLocations([])
      return
    }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const { fetchMovimientos } = await import('@/lib/rackly/kardex')
        const movs = await fetchMovimientos()
        const code = searchCode.trim().toUpperCase()
        const locMap = new Map<string, (StockEnUbicacion & { bloque: string; torre: string; piso: string; posicion: string })>()
        const relevant = movs.filter((m) => m.codigo === code)
        for (const m of relevant) {
          const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
          const current = locMap.get(key)
          if (current) {
            current.stock += m.tipo === 'ingreso' ? m.cantidad : -m.cantidad
          } else {
            locMap.set(key, {
              bloque: m.bloque,
              torre: m.torre,
              piso: m.piso,
              posicion: m.posicion,
              codigo: m.codigo,
              descripcion: m.descripcion,
              un: m.un,
              stock: m.tipo === 'ingreso' ? m.cantidad : -m.cantidad,
              fVencimiento: m.fVencimiento || undefined,
              proveedor: m.proveedor,
            })
          }
        }
        setLocations(Array.from(locMap.values()).filter((l) => l.stock > 0))
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchCode])

  async function handleSalida(full = false) {
    if (!selectedLoc) {
      toast.error('Selecciona una ubicación')
      return
    }
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === selectedLoc)
    if (!loc) return
    const qtyNum = full ? loc.stock : parseFloat(qty)
    if (isNaN(qtyNum) || qtyNum <= 0 || qtyNum > loc.stock) {
      toast.error('Cantidad inválida')
      return
    }
    setBusy(true)
    try {
      const result = await addMovimiento({
        tipo: 'salida',
        bloque: loc.bloque,
        torre: loc.torre,
        piso: loc.piso,
        posicion: loc.posicion,
        codigo: loc.codigo,
        descripcion: loc.descripcion,
        un: loc.un,
        cantidad: qtyNum,
        fVencimiento: loc.fVencimiento ?? '',
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: loc.proveedor,
      })
      toast.success(`Salida de ${qtyNum} ${loc.un} registrada`)
      setQty('')
      setSelectedLoc(null)
      setLocations([])
      setSearchCode('')
      onCreated(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('Error al registrar salida', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <CatalogoSearchInput
        onPick={(item) => setSearchCode(item.codigo)}
        value={searchCode}
        onChange={setSearchCode}
      />

      {loading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Buscando ubicaciones...</span>
        </div>
      )}

      {locations.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Bloque</TableHead>
              <TableHead>Torre</TableHead>
              <TableHead>Piso</TableHead>
              <TableHead>Pos</TableHead>
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
                  className={`cursor-pointer transition-colors ${selectedLoc === key ? 'bg-orange-100 dark:bg-orange-950' : 'hover:bg-muted'}`}
                  onClick={() => setSelectedLoc(key)}
                >
                  <TableCell className="font-mono">{loc.codigo}</TableCell>
                  <TableCell>{loc.descripcion}</TableCell>
                  <TableCell><Badge variant="outline">{loc.bloque}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{loc.torre}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{loc.piso}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{loc.posicion}</Badge></TableCell>
                  <TableCell className="text-right font-bold text-orange-600 dark:text-orange-400">{loc.stock}</TableCell>
                  <TableCell>{loc.fVencimiento || '—'}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {!loading && locations.length === 0 && searchCode.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span>Sin stock para este código</span>
        </div>
      )}

      {selectedLoc && (
        <div className="flex items-end gap-3 rounded-lg border-2 border-orange-200 dark:border-orange-900 p-4 bg-orange-50 dark:bg-orange-950/30">
          <div className="space-y-1 flex-1">
            <Label className="text-orange-700 dark:text-orange-300 font-medium">Cantidad a retirar</Label>
            <Input
              type="number"
              step="any"
              min="0.001"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Cantidad"
              className="border-orange-300 dark:border-orange-700"
            />
          </div>
          <Button variant="destructive" onClick={() => handleSalida(false)} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Salida parcial
          </Button>
          <Button variant="destructive" onClick={() => handleSalida(true)} disabled={busy} className="bg-red-700 hover:bg-red-800">
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Retirar todo
          </Button>
        </div>
      )}
    </div>
  )
}
