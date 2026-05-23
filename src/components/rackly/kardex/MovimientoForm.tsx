'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  addMovimiento,
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
import { Loader2, PackageSearch, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft } from 'lucide-react'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

const PROVEEDORES_FILM = ['INCOMIN', 'DAMAR', 'DIAMAND', 'NEOPACK', 'SOLPACK', 'ITS']

function requiereProveedor(descripcion: string): boolean {
  const upper = descripcion.toUpperCase().trim()
  // Excepción: si inicia con "ETIQUETA" y contiene "LÁMINA"/"LAMINA", NO requiere proveedor
  if (upper.startsWith('ETIQUETA') && upper.includes('LAMINA')) return false
  return upper.includes('LAMINA') || upper.includes('STRETCH')
}

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

  if (tipo === 'salida') {
    return <SalidaForm turno={turno} onCreated={onCreated} perfil={perfil!} />
  }
  // ingreso y devolucion usan el mismo formulario, solo cambia el tipo
  return <IngresoForm turno={turno} onCreated={onCreated} perfil={perfil!} tipo={tipo} />
}

/* ═══════════════════════════════════════════
   INGRESO FORM
   ═══════════════════════════════════════════ */
function IngresoForm({
  turno,
  onCreated,
  perfil,
  tipo = 'ingreso',
}: {
  turno: string
  onCreated: (movs: Movimiento[]) => void
  perfil: { id: string; nombre: string; correo: string }
  tipo?: TipoMovimiento
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
    if (requiereProveedor(descripcion) && !proveedor) {
      toast.error('Selecciona un proveedor para este producto')
      return
    }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('La cantidad debe ser mayor a 0')
      return
    }
    setBusy(true)
    try {
      // Verificar si CUALQUIER producto existe en esta posición
      const details = await stockEnUbicacion(bloque, torre, piso, posicion)
      if (details.length > 0) {
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
        tipo,
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
      toast.success(tipo === 'devolucion' ? 'Devolución registrada' : 'Ingreso registrado')
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
      <div className={`flex items-center gap-2 mb-4 p-3 rounded-lg border ${
        tipo === 'devolucion'
          ? 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-800'
          : 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800'
      }`}>
        {tipo === 'devolucion' ? (
          <ArrowRightLeft className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
        ) : (
          <ArrowDownToLine className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
        )}
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${
            tipo === 'devolucion'
              ? 'text-orange-700 dark:text-orange-300'
              : 'text-green-700 dark:text-green-300'
          }`}>
            {tipo === 'devolucion' ? 'Ingreso por devolución' : 'Ingreso de mercadería'}
          </p>
          <p className="text-xs text-muted-foreground">Turno: {turno}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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
          {requiereProveedor(descripcion) && (
            <div className="space-y-1 col-span-2">
              <Label className="text-xs text-muted-foreground font-medium">Proveedor <span className="text-red-500">*</span></Label>
              <Select value={proveedor} onValueChange={setProveedor}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Selecciona proveedor" />
                </SelectTrigger>
                <SelectContent>
                  {PROVEEDORES_FILM.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <Button type="submit" disabled={busy} className={`w-full h-11 text-white text-sm font-medium sm:w-auto ${
          tipo === 'devolucion'
            ? 'bg-orange-600 hover:bg-orange-700'
            : 'bg-green-600 hover:bg-green-700'
        }`}>
          {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          {tipo === 'devolucion' ? 'Registrar Devolución' : 'Registrar Ingreso'}
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
   SALIDA FORM — Tabla con formato exacto de la imagen
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
  const [productoDesc, setProductoDesc] = useState('')
  const [productoUn, setProductoUn] = useState('')
  const [locations, setLocations] = useState<LocWithKey[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const searchCodeRef = useRef(searchCode)
  searchCodeRef.current = searchCode

  // Función central para refrescar las ubicaciones
  const refreshLocations = useCallback(async () => {
    const code = searchCodeRef.current.trim()
    if (!code) {
      setLocations([])
      setProductoDesc('')
      setProductoUn('')
      setQtyMap({})
      return
    }
    try {
      const { fetchMovimientos } = await import('@/lib/rackly/kardex')
      const movs = await fetchMovimientos()
      const upperCode = code.toUpperCase()
      const locMap = new Map<string, LocWithKey>()
      const relevant = movs.filter((m) => m.codigo === upperCode)
      let desc = ''
      let un = ''
      for (const m of relevant) {
        if (!desc && m.descripcion) desc = m.descripcion
        if (!un && m.un) un = m.un
        const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const current = locMap.get(key)
        if (current) {
          current.stock += ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
        } else {
          locMap.set(key, {
            bloque: m.bloque,
            torre: m.torre,
            piso: m.piso,
            posicion: m.posicion,
            codigo: m.codigo,
            descripcion: m.descripcion,
            un: m.un,
            stock: ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad,
            fVencimiento: m.fVencimiento || undefined,
            proveedor: m.proveedor,
          })
        }
      }
      const results = Array.from(locMap.values()).filter((l) => l.stock > 0)
      setLocations(results)
      setProductoDesc(desc)
      setProductoUn(un)
    } catch {
      // silencioso
    }
  }, [])

  // Búsqueda inicial con debounce
  useEffect(() => {
    if (!searchCode.trim()) {
      setLocations([])
      setProductoDesc('')
      setProductoUn('')
      setQtyMap({})
      return
    }
    setLoading(true)
    const timer = setTimeout(async () => {
      await refreshLocations()
      setLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchCode, refreshLocations])

  // POLLING: refrescar automáticamente cada 8 segundos
  useEffect(() => {
    if (!searchCode.trim()) return
    const interval = setInterval(() => {
      refreshLocations()
    }, 8000)
    return () => clearInterval(interval)
  }, [searchCode, refreshLocations])

  async function handleSalidaParcial(locKey: string) {
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === locKey)
    if (!loc) return
    const qtyVal = qtyMap[locKey] || ''
    const qtyNum = parseFloat(qtyVal)
    if (isNaN(qtyNum) || qtyNum <= 0) {
      toast.error('Ingresa una cantidad válida para la salida parcial')
      return
    }
    if (qtyNum > loc.stock) {
      toast.error('La cantidad excede el stock disponible')
      return
    }
    setConfirmState({ loc, qtyNum, full: false })
  }

  function handleRetirarTodo(locKey: string) {
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === locKey)
    if (!loc) return
    setConfirmState({ loc, qtyNum: loc.stock, full: true })
  }

  const [confirmState, setConfirmState] = useState<{
    loc: LocWithKey
    qtyNum: number
    full: boolean
  } | null>(null)

  async function doSalida() {
    if (!confirmState) return
    const { loc, qtyNum } = confirmState
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
      setConfirmState(null)
      setSearchCode('')
      setQtyMap({})
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
      {/* Búsqueda */}
      <div className="space-y-1">
        <Label className="text-sm text-muted-foreground">Buscar (código o descripción)</Label>
        <CatalogoSearchInput
          onPick={(item) => setSearchCode(item.codigo)}
          value={searchCode}
          onChange={setSearchCode}
        />
      </div>

      {/* Producto (solo lectura) */}
      {productoDesc && (
        <div className="space-y-1">
          <Label className="text-sm text-muted-foreground">Producto</Label>
          <Input
            value={`${productoUn ? productoUn + ' — ' : ''}${productoDesc}`}
            readOnly
            className="h-10 bg-muted/50 cursor-default"
          />
        </div>
      )}

      {/* Badges de metadata */}
      {searchCode.trim() && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
            Turno: {turno}
          </Badge>
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
            Usuario: {perfil.nombre}
          </Badge>
          {!loading && (
            <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800">
              Ubicaciones con stock: <span className="font-bold">{locations.length}</span>
            </Badge>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Buscando...</span>
        </div>
      )}

      {/* Tabla de ubicaciones */}
      {locations.length > 0 && !loading && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-center">Bloque</TableHead>
                <TableHead className="w-16 text-center">Torre</TableHead>
                <TableHead className="w-16 text-center">Piso</TableHead>
                <TableHead className="w-20 text-center">Posición</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                {(productoDesc && requiereProveedor(productoDesc)) && (
                  <TableHead className="w-28">Proveedor</TableHead>
                )}
                <TableHead className="w-36">Cantidad salida</TableHead>
                <TableHead className="w-44">Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((loc) => {
                const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
                return (
                  <TableRow key={key}>
                    <TableCell className="text-center font-medium">{loc.bloque}</TableCell>
                    <TableCell className="text-center font-medium">{loc.torre}</TableCell>
                    <TableCell className="text-center font-medium">{loc.piso}</TableCell>
                    <TableCell className="text-center font-medium">{loc.posicion}</TableCell>
                    <TableCell className="text-right font-bold">{loc.stock}</TableCell>
                    {(productoDesc && requiereProveedor(productoDesc)) && (
                      <TableCell>
                        {loc.proveedor ? (
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                            {loc.proveedor}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <Input
                        type="number"
                        step="any"
                        min="0.001"
                        max={loc.stock}
                        value={qtyMap[key] || ''}
                        onChange={(e) => setQtyMap((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder="Parcial"
                        className="h-9 text-sm"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleSalidaParcial(key)}
                          disabled={busy}
                          className="flex-1 h-9 text-xs bg-red-600 hover:bg-red-700 text-white"
                        >
                          Salida
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRetirarTodo(key)}
                          disabled={busy}
                          className="flex-1 h-9 text-xs"
                        >
                          Todo
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Sin stock */}
      {!loading && locations.length === 0 && searchCode.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span className="text-sm">Sin stock para este código</span>
        </div>
      )}

      {/* Nota inferior */}
      {locations.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Las ubicaciones que lleguen a stock 0 desaparecen automáticamente de esta lista.
        </p>
      )}

      {/* Diálogo de confirmación Sí/No */}
      <AlertDialog open={!!confirmState} onOpenChange={(open) => { if (!open) setConfirmState(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmState?.full ? 'Retirar todo el stock' : 'Confirmar salida'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>¿Estás seguro de registrar esta salida?</p>
                {confirmState && (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Producto:</span>
                      <span className="font-medium">{confirmState.loc.codigo} — {confirmState.loc.descripcion}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ubicación:</span>
                      <span className="font-medium">
                        B-{confirmState.loc.bloque} T-{confirmState.loc.torre} P-{confirmState.loc.piso} Pos-{confirmState.loc.posicion}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Stock actual:</span>
                      <span className="font-medium">{confirmState.loc.stock} {confirmState.loc.un}</span>
                    </div>
                    <div className="border-t pt-1.5 flex justify-between font-bold">
                      <span className="text-red-600">Cantidad a retirar:</span>
                      <span className="text-red-600">{confirmState.qtyNum} {confirmState.loc.un}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Stock después:</span>
                      <span className={`font-medium ${confirmState.loc.stock - confirmState.qtyNum === 0 ? 'text-red-600' : ''}`}>
                        {confirmState.loc.stock - confirmState.qtyNum} {confirmState.loc.un}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, cancelar</AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doSalida() }}
              disabled={busy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {busy ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Procesando...</>
              ) : (
                'Sí, confirmar'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
