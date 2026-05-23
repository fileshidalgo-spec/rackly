'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  fetchMovimientos,
  type Movimiento,
  eliminarUbicacion,
} from '@/lib/rackly/kardex'
import { findCatalogoByCodigo, fetchCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
import { toast } from 'sonner'
import { Trash2, PackageSearch, Loader2, Warehouse } from 'lucide-react'

type LocStock = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  ingresos: number
  salidas: number
  devoluciones: number
  traslados: number
  stock: number
  descripcion: string
  un: string
  proveedor?: string
  fVencimiento: string
}

export function StockTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{
    bloque: string
    torre: string
    piso: string
    posicion: string
    stock: number
    unStr: string
  } | null>(null)
  const [busyDelete, setBusyDelete] = useState(false)
  const [catalogoItem, setCatalogoItem] = useState<CatalogoItem | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await fetchMovimientos()
      setMovs(data)
    } catch {
      // silencioso — se reintentará con el polling
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Polling cada 8 segundos
  useEffect(() => {
    const interval = setInterval(load, 8000)
    return () => clearInterval(interval)
  }, [load])

  // Calcular stock por ubicación
  const stockLocations: LocStock[] = (() => {
    if (!codigo.trim() || movs.length === 0) return []
    const code = codigo.trim().toUpperCase()
    const locMap = new Map<string, LocStock>()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const current = locMap.get(key)
      if (current) {
        if (m.tipo === 'ingreso') current.ingresos += m.cantidad
        else if (m.tipo === 'devolucion') current.devoluciones += m.cantidad
        else if (m.tipo === 'traslado') current.traslados += m.cantidad
        else if (m.tipo === 'salida') current.salidas += m.cantidad
        current.stock += (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado') ? m.cantidad : -m.cantidad
        if (m.fVencimiento && (!current.fVencimiento || m.fVencimiento < current.fVencimiento)) {
          current.fVencimiento = m.fVencimiento
        }
      } else {
        const isPositive = m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado'
        locMap.set(key, {
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          ingresos: m.tipo === 'ingreso' ? m.cantidad : 0,
          salidas: m.tipo === 'salida' ? m.cantidad : 0,
          devoluciones: m.tipo === 'devolucion' ? m.cantidad : 0,
          traslados: m.tipo === 'traslado' ? m.cantidad : 0,
          stock: isPositive ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion,
          un: m.un,
          proveedor: m.proveedor || undefined,
          fVencimiento: m.fVencimiento || '',
        })
      }
    }
    return Array.from(locMap.values())
      .filter((l) => l.stock > 0)
      .sort((a, b) => {
        if (!a.fVencimiento && !b.fVencimiento) return 0
        if (!a.fVencimiento) return 1
        if (!b.fVencimiento) return -1
        return a.fVencimiento.localeCompare(b.fVencimiento)
      })
  })()

  const totalStock = stockLocations.reduce((s, l) => s + l.stock, 0)
  const totalIngresos = stockLocations.reduce((s, l) => s + l.ingresos, 0)
  const totalSalidas = stockLocations.reduce((s, l) => s + l.salidas, 0)
  const totalDevoluciones = stockLocations.reduce((s, l) => s + l.devoluciones, 0)
  const totalTraslados = stockLocations.reduce((s, l) => s + l.traslados, 0)

  function handleCatalogoPick(item: { codigo: string; descripcion: string; un: string; stockBigMagic?: number }) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    setCatalogoItem(item as CatalogoItem)
  }

  function handleCodigoChange(val: string) {
    setCodigo(val)
    const cat = findCatalogoByCodigo(val.trim())
    if (cat) {
      setDescripcion(cat.descripcion)
      setUn(cat.un)
      setCatalogoItem(cat)
    } else {
      // Try to find from existing movimientos
      const upper = val.trim().toUpperCase()
      const match = movs.find((m) => m.codigo === upper)
      if (match) {
        setDescripcion(match.descripcion)
        setUn(match.un)
      } else if (!val.trim()) {
        setDescripcion('')
        setUn('')
      }
    }
  }

  async function doDelete() {
    if (!confirmDelete) return
    setBusyDelete(true)
    try {
      const next = await eliminarUbicacion(codigo.trim().toUpperCase(), confirmDelete.bloque, confirmDelete.torre, confirmDelete.piso, confirmDelete.posicion)
      setMovs(next)
      toast.success('Ubicación eliminada')
      setConfirmDelete(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('No se pudo eliminar', { description: message })
    } finally {
      setBusyDelete(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* ─── Header ─── */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Warehouse className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-bold text-foreground">Ubicación por código</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Stock = ingresos + devoluciones + traslados − salidas, agrupado por bloque, torre, piso y posición. Las ubicaciones con stock 0 se eliminan automáticamente.
        </p>
      </div>

      {/* ─── Búsqueda ─── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Buscar (código o descripción)</Label>
          <CatalogoSearchInput
            onPick={handleCatalogoPick}
            value={codigo}
            onChange={handleCodigoChange}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Producto</Label>
          <Input
            value={descripcion ? `${un ? un + ' — ' : ''}${descripcion}` : ''}
            readOnly
            placeholder="Busca un producto arriba..."
            className="bg-muted/50 cursor-default"
          />
        </div>
      </div>

      {/* ─── Loading ─── */}
      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Cargando movimientos...</span>
        </div>
      )}

      {/* ─── Resumen superior ─── */}
      {!loading && stockLocations.length > 0 && (
        <div className="rounded-lg border bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 p-4">
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stockLocations.length}</p>
              <p className="text-xs text-muted-foreground">Ubicaciones encontradas</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{totalIngresos.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Ingresos</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{totalDevoluciones.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Devoluciones</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{totalSalidas.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Salidas</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-500 dark:text-blue-400">{totalTraslados.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Traslados</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{totalStock.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">{un}</span></p>
              <p className="text-xs text-muted-foreground font-semibold">Stock Disponible</p>
            </div>
            {catalogoItem && (
              <div>
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{catalogoItem.stockBigMagic.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Stock Big Magic</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Tabla de ubicaciones ─── */}
      {!loading && stockLocations.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-center">Bloque</TableHead>
                <TableHead className="w-16 text-center">Torre</TableHead>
                <TableHead className="w-16 text-center">Piso</TableHead>
                <TableHead className="w-20 text-center">Posición</TableHead>
                <TableHead className="w-28 text-center">Vencimiento</TableHead>
                <TableHead className="text-right">Ingresos</TableHead>
                <TableHead className="text-right">Devoluciones</TableHead>
                <TableHead className="text-right">Traslados</TableHead>
                <TableHead className="text-right">Salidas</TableHead>
                <TableHead className="text-right font-bold">Stock</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockLocations.map((s, i) => (
                <TableRow key={i}>
                  <TableCell className="text-center font-medium">{s.bloque}</TableCell>
                  <TableCell className="text-center font-medium">{s.torre}</TableCell>
                  <TableCell className="text-center font-medium">{s.piso}</TableCell>
                  <TableCell className="text-center font-medium">{s.posicion}</TableCell>
                  <TableCell className="text-center">
                    {s.fVencimiento ? (() => {
                      const dias = Math.ceil((new Date(s.fVencimiento).getTime() - Date.now()) / 86400000)
                      return (
                        <Badge variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'} className={dias <= 0 ? '' : dias <= 15 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}>
                          {s.fVencimiento} <span className="ml-1 opacity-70">({dias <= 0 ? 'vencido' : `${dias}d`})</span>
                        </Badge>
                      )
                    })() : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.ingresos > 0 ? (
                      <span className="text-green-600 dark:text-green-400 font-medium">+{s.ingresos.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.devoluciones > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400 font-medium">+{s.devoluciones.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.traslados > 0 ? (
                      <span className="text-blue-500 dark:text-blue-400 font-medium">+{s.traslados.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.salidas > 0 ? (
                      <span className="text-red-600 dark:text-red-400 font-medium">-{s.salidas.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-bold">
                    <Badge variant="default" className="text-sm px-2.5 py-0.5">{s.stock.toLocaleString()}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-600"
                      onClick={() => setConfirmDelete({
                        bloque: s.bloque,
                        torre: s.torre,
                        piso: s.piso,
                        posicion: s.posicion,
                        stock: s.stock,
                        unStr: s.un,
                      })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ─── Sin stock ─── */}
      {!loading && stockLocations.length === 0 && codigo.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span>Sin stock para &quot;{codigo}&quot;</span>
        </div>
      )}

      {/* ─── Sin búsqueda ─── */}
      {!loading && !codigo.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span>Escribe un código o descripción para ver el stock por ubicación.</span>
        </div>
      )}

      {/* ─── Nota inferior ─── */}
      {!loading && stockLocations.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Las ubicaciones con stock 0 se eliminan automáticamente para evitar saturación.
        </p>
      )}

      {/* ─── Dialog de confirmación para eliminar ─── */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar ubicación?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>Se eliminarán todos los movimientos de esta ubicación para el código <strong>{codigo}</strong>.</p>
                {confirmDelete && (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ubicación:</span>
                      <span className="font-medium">B-{confirmDelete.bloque} T-{confirmDelete.torre} P-{confirmDelete.piso} Pos-{confirmDelete.posicion}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Stock actual:</span>
                      <span className="font-medium">{confirmDelete.stock} {confirmDelete.unStr}</span>
                    </div>
                  </div>
                )}
                <p className="text-red-600 font-medium">Esta acción no se puede deshacer.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doDelete() }}
              disabled={busyDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {busyDelete ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Eliminando...</>
              ) : (
                'Sí, eliminar'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
