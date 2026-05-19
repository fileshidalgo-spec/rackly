'use client'

import { useState, useEffect } from 'react'
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
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'
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
import { Loader2, PackageSearch, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
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

/* ═══════════════════════════════════════════
   INGRESO FORM
   ═══════════════════════════════════════════ */
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
      {/* Header visual para ingreso */}
      <div className="flex items-center gap-2 mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800">
        <ArrowDownToLine className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-green-700 dark:text-green-300">Ingreso de mercadería</p>
          <p className="text-xs text-green-600/80 dark:text-green-400/70">Turno: {turno}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Ubicación — 2 columnas en mobile, 5 en desktop */}
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ubicación</Label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Bloque</Label>
              <Select value={bloque} onValueChange={(v) => { setBloque(v); setTorre(''); setPiso(''); setPosicion('') }}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>
                  {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Torre</Label>
              <Select value={torre} onValueChange={setTorre} disabled={!bloque}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>
                  {torres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Piso</Label>
              <Select value={piso} onValueChange={setPiso} disabled={!bloque}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Piso" /></SelectTrigger>
                <SelectContent>
                  {PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Posición</Label>
              <Select value={posicion} onValueChange={setPosicion} disabled={!bloque}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Pos." /></SelectTrigger>
                <SelectContent>
                  {posiciones.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <Label className="text-xs text-muted-foreground">Turno</Label>
              <Input value={turno} readOnly className="h-10 bg-muted text-sm" />
            </div>
          </div>
        </div>

        {/* Producto — búsqueda */}
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Producto</Label>
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
        </div>

        {/* Detalles del producto — aparecen automáticamente al seleccionar código */}
        {descripcion && (
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-2 transition-all">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Descripción</p>
                <p className="text-sm font-medium truncate">{descripcion}</p>
              </div>
              <div className="min-w-[60px]">
                <p className="text-xs text-muted-foreground">UN</p>
                <p className="text-sm font-medium">{un || '—'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Cantidad y fecha */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">Cantidad</Label>
            <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="0" className="h-10" />
          </div>
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">F. Vencimiento</Label>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fVencimiento} onChange={(e) => setFVencimiento(e.target.value)} disabled={sinVencimiento} className="h-10" />
              <Checkbox checked={sinVencimiento} onCheckedChange={(v) => setSinVencimiento(!!v)} />
            </div>
          </div>
          <div className="space-y-1 col-span-2 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">Proveedor</Label>
            <Input value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="Opcional" className="h-10" />
          </div>
        </div>

        <Button type="submit" disabled={busy} className="w-full h-11 bg-green-600 hover:bg-green-700 text-white text-sm font-medium sm:w-auto">
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

/* ═══════════════════════════════════════════
   SALIDA FORM
   ═══════════════════════════════════════════ */
type LocWithKey = StockEnUbicacion & { bloque: string; torre: string; piso: string; posicion: string }

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
  const [locations, setLocations] = useState<LocWithKey[]>([])
  const [selectedLoc, setSelectedLoc] = useState<string | null>(null)
  const [qtyMap, setQtyMap] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!searchCode.trim()) {
      setLocations([])
      setSelectedLoc(null)
      setQtyMap({})
      return
    }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const { fetchMovimientos } = await import('@/lib/rackly/kardex')
        const movs = await fetchMovimientos()
        const code = searchCode.trim().toUpperCase()
        const locMap = new Map<string, LocWithKey>()
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
        const results = Array.from(locMap.values()).filter((l) => l.stock > 0)
        setLocations(results)
        // Auto-seleccionar la primera ubicación siempre
        if (results.length >= 1) {
          setSelectedLoc(`${results[0].bloque}-${results[0].torre}-${results[0].piso}-${results[0].posicion}`)
        } else {
          setSelectedLoc(null)
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchCode])

  async function handleSalida(locKey: string, full = false) {
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === locKey)
    if (!loc) return
    const qtyVal = qtyMap[locKey] || ''
    const qtyNum = full ? loc.stock : parseFloat(qtyVal)
    if (isNaN(qtyNum) || qtyNum <= 0 || qtyNum > loc.stock) {
      toast.error('Cantidad inválida', { description: full ? '' : 'Ingresa una cantidad válida' })
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
      setQtyMap({})
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
      {/* Header visual para salida */}
      <div className="flex items-center gap-2 p-3 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-800">
        <ArrowUpFromLine className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-orange-700 dark:text-orange-300">Salida de mercadería</p>
          <p className="text-xs text-orange-600/80 dark:text-orange-400/70">Turno: {turno}</p>
        </div>
      </div>

      {/* Búsqueda de código */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Buscar producto</Label>
        <CatalogoSearchInput
          onPick={(item) => setSearchCode(item.codigo)}
          value={searchCode}
          onChange={setSearchCode}
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Buscando ubicaciones...</span>
        </div>
      )}

      {/* Ubicaciones con stock */}
      {locations.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Ubicaciones con stock ({locations.length})
          </p>

          {locations.map((loc) => {
            const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
            return (
              <SalidaLocationCard
                key={key}
                loc={loc}
                isSelected={selectedLoc === key}
                qty={qtyMap[key] || ''}
                busy={busy}
                onSelect={() => setSelectedLoc(key)}
                onQtyChange={(val) => setQtyMap((prev) => ({ ...prev, [key]: val }))}
                onSalida={(full) => handleSalida(key, full)}
              />
            )
          })}
        </div>
      )}

      {/* Sin stock */}
      {!loading && locations.length === 0 && searchCode.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span className="text-sm">Sin stock para este código</span>
        </div>
      )}
    </div>
  )
}

/* ─── Tarjeta de ubicación con acciones de salida integradas ─── */
function SalidaLocationCard({
  loc,
  isSelected,
  qty,
  busy,
  onSelect,
  onQtyChange,
  onSalida,
}: {
  loc: LocWithKey
  isSelected: boolean
  qty: string
  busy: boolean
  onSelect: () => void
  onQtyChange: (val: string) => void
  onSalida: (full: boolean) => void
}) {
  const [confirmDialog, setConfirmDialog] = useState<{
    full: boolean
    qtyNum: number
  } | null>(null)

  function handleButtonClick(full: boolean, e: React.MouseEvent) {
    e.stopPropagation()
    const qtyNum = full ? loc.stock : parseFloat(qty)
    if (!full && (isNaN(qtyNum) || qtyNum <= 0)) {
      toast.error('Ingresa una cantidad válida')
      return
    }
    if (qtyNum > loc.stock) {
      toast.error('La cantidad excede el stock disponible')
      return
    }
    // Mostrar diálogo de confirmación
    setConfirmDialog({ full, qtyNum })
  }

  function handleConfirm() {
    if (!confirmDialog) return
    onSalida(confirmDialog.full)
    setConfirmDialog(null)
  }

  return (
    <>
      <div
        onClick={onSelect}
        className={`rounded-xl border-2 overflow-hidden transition-all ${
          isSelected
            ? 'border-orange-400 bg-orange-50 dark:border-orange-600 dark:bg-orange-950/30'
            : 'border-border bg-card hover:border-orange-200 dark:hover:border-orange-800 cursor-pointer'
        }`}
      >
        {/* Info del producto y ubicación */}
        <div className="p-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono font-bold text-sm">{loc.codigo}</span>
            <Badge className="bg-orange-500 text-white text-xs">
              Stock: {loc.stock} {loc.un}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground truncate mb-2">{loc.descripcion}</p>
          <div className="flex gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs">B-{loc.bloque}</Badge>
            <Badge variant="outline" className="text-xs">T-{loc.torre}</Badge>
            <Badge variant="outline" className="text-xs">P-{loc.piso}</Badge>
            <Badge variant="outline" className="text-xs">Pos-{loc.posicion}</Badge>
            {loc.fVencimiento && (
              <Badge variant="outline" className="text-xs">Venc: {loc.fVencimiento}</Badge>
            )}
          </div>
        </div>

        {/* Cantidad y botones — siempre visibles */}
        <div className="border-t border-orange-200 dark:border-orange-800 p-3 pt-3 space-y-2 bg-orange-50/80 dark:bg-orange-950/20">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-orange-700 dark:text-orange-300 font-medium whitespace-nowrap">
              Cantidad a retirar
            </Label>
            <Input
              type="number"
              step="any"
              min="0.001"
              max={loc.stock}
              value={qty}
              onChange={(e) => onQtyChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="0"
              className="border-orange-300 dark:border-orange-700 h-10 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={(e) => handleButtonClick(false, e)}
              disabled={busy}
              className="flex-1 h-9 text-xs"
            >
              Salida parcial
            </Button>
            <Button
              size="sm"
              onClick={(e) => handleButtonClick(true, e)}
              disabled={busy}
              className="flex-1 h-9 text-xs bg-red-700 hover:bg-red-800 text-white"
            >
              Retirar todo ({loc.stock})
            </Button>
          </div>
        </div>
      </div>

      {/* Diálogo de confirmación Sí/No */}
      <AlertDialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDialog?.full ? 'Retirar todo el stock' : 'Confirmar salida parcial'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>¿Estás seguro de registrar esta salida?</p>
                <div className="rounded-lg border bg-muted/50 p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Producto:</span>
                    <span className="font-medium">{loc.codigo} — {loc.descripcion}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ubicación:</span>
                    <span className="font-medium">B-{loc.bloque} T-{loc.torre} P-{loc.piso} Pos-{loc.posicion}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stock actual:</span>
                    <span className="font-medium">{loc.stock} {loc.un}</span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span className="text-red-600">Cantidad a retirar:</span>
                    <span className="text-red-600">{confirmDialog?.qtyNum} {loc.un}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stock después:</span>
                    <span className="font-medium">{(loc.stock - (confirmDialog?.qtyNum ?? 0))} {loc.un}</span>
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Sí, confirmar salida
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
