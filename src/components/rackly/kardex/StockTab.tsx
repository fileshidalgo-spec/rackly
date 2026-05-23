'use client'

import { useState, useEffect } from 'react'
import {
  fetchMovimientos,
  type Movimiento,
  calcularStockUbicacion,
  eliminarUbicacion,
} from '@/lib/rackly/kardex'
import { findCatalogoByCodigo, fetchCatalogo } from '@/lib/rackly/catalogo'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Input } from '@/components/ui/input'
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
import { toast } from 'sonner'
import { Search, Trash2, PackageSearch } from 'lucide-react'

export function StockTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [codigo, setCodigo] = useState('')
  const [stock, setStock] = useState<
    {
      bloque: string
      torre: string
      piso: string
      posicion: string
      stock: number
      descripcion: string
      un: string
      proveedor?: string
    }[]
  >([])
  const [loading, setLoading] = useState(false)
  const [stockBM, setStockBM] = useState<number | null>(null)

  useMovimientosRealtime(setMovs)

  // Buscar stock_big_magic del catálogo cuando cambia el código
  useEffect(() => {
    async function lookupBM() {
      const code = codigo.trim().toUpperCase()
      if (!code) {
        setStockBM(null)
        return
      }
      try {
        const cat = findCatalogoByCodigo(code)
        if (cat) {
          setStockBM(cat.stock_big_magic)
        } else {
          // Si no está en caché, intentar cargar catálogo
          await fetchCatalogo()
          const cat2 = findCatalogoByCodigo(code)
          setStockBM(cat2 ? cat2.stock_big_magic : null)
        }
      } catch {
        setStockBM(null)
      }
    }
    lookupBM()
  }, [codigo])

  const stockData = (() => {
    if (!codigo.trim() || movs.length === 0) return []
    const code = codigo.trim().toUpperCase()
    const locMap = new Map<
      string,
      {
        bloque: string
        torre: string
        piso: string
        posicion: string
        stock: number
        descripcion: string
        un: string
        proveedor?: string
      }
    >()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
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
          stock: ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad,
          descripcion: m.descripcion,
          un: m.un,
          proveedor: m.proveedor || undefined,
        })
      }
    }
    return Array.from(locMap.values()).filter((l) => l.stock > 0)
  })()

  useEffect(() => {
    setStock(stockData)
  }, [stockData])

  async function handleDelete(
    bloque: string,
    torre: string,
    piso: string,
    posicion: string
  ) {
    if (!confirm('¿Eliminar todos los movimientos de esta ubicación?')) return
    try {
      const next = await eliminarUbicacion(codigo, bloque, torre, piso, posicion)
      setMovs(next)
      toast.success('Ubicación eliminada')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="Buscar por código..."
            className="pl-9"
          />
        </div>
      </div>

      {stock.length > 0 ? (
        <div className="space-y-3">
          {/* Card de Stock Big Magic */}
          {stockBM !== null && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40 p-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                  <span className="text-amber-600 dark:text-amber-400 font-bold text-xs">BM</span>
                </div>
                <div>
                  <p className="text-xs text-amber-600/80 dark:text-amber-400/80 font-medium">Stock Big Magic</p>
                  <p className="text-xs text-muted-foreground">Stock disponible en sistema Big Magic</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{stockBM}</p>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bloque</TableHead>
                  <TableHead>Torre</TableHead>
                  <TableHead>Piso</TableHead>
                  <TableHead>Posición</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>UN</TableHead>
                  <TableHead>Proveedor</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell>{s.bloque}</TableCell>
                    <TableCell>{s.torre}</TableCell>
                    <TableCell>{s.piso}</TableCell>
                    <TableCell>{s.posicion}</TableCell>
                    <TableCell>{s.descripcion}</TableCell>
                    <TableCell>{s.un}</TableCell>
                    <TableCell>
                      {s.proveedor ? (
                        <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                          {s.proveedor}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <Badge variant="default">{s.stock}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          handleDelete(s.bloque, s.torre, s.piso, s.posicion)
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {/* Total sum */}
          <div className="flex justify-end">
            <Badge variant="outline" className="text-sm px-3 py-1">
              Total stock: <span className="font-bold ml-1">{stock.reduce((sum, s) => sum + s.stock, 0)}</span>
            </Badge>
          </div>
        </div>
      ) : codigo.trim() ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span>Sin stock para &quot;{codigo}&quot;</span>
        </div>
      ) : (
        <p className="text-muted-foreground text-center py-8">
          Escribe un código para ver el stock por ubicación.
        </p>
      )}
    </div>
  )
}
