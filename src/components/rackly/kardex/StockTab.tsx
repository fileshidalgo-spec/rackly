'use client'

import { useState, useEffect } from 'react'
import {
  fetchMovimientos,
  type Movimiento,
  eliminarUbicacion,
} from '@/lib/rackly/kardex'
import { findCatalogoByCodigo, fetchCatalogo, isCatalogoLoaded } from '@/lib/rackly/catalogo'
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
import { useAuth } from '@/hooks/useAuth'

export function StockTab() {
  const { perfil } = useAuth()
  const esAdmin = perfil?.rol === 'admin'
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
      fVencimiento: string
    }[]
  >([])
  const [loading, setLoading] = useState(false)
  const [stockBM, setStockBM] = useState<number | null>(null)

  useMovimientosRealtime(setMovs)

  // Cargar catálogo al montar para garantizar que Big Magic siempre funcione
  useEffect(() => {
    if (!isCatalogoLoaded()) {
      fetchCatalogo().catch(() => {})
    }
  }, [])

  // Buscar stock_big_magic del catálogo cuando cambia el código
  useEffect(() => {
    async function lookupBM() {
      const code = codigo.trim().toUpperCase()
      if (!code) {
        setStockBM(null)
        return
      }
      try {
        // Siempre aseguramos que el catálogo esté cargado
        if (!isCatalogoLoaded()) {
          await fetchCatalogo()
        }
        const cat = findCatalogoByCodigo(code)
        setStockBM(cat ? cat.stock_big_magic : 0)
      } catch {
        setStockBM(0)
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
        fVencimiento: string
      }
    >()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const current = locMap.get(key)
      if (current) {
        current.stock += ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
        // Mantener la fecha de vencimiento más próxima (más antigua)
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
          proveedor: m.proveedor || undefined,
          fVencimiento: m.fVencimiento || '',
        })
      }
    }
    // Ordenar: vencimiento más próximo primero, sin fecha al final
    return Array.from(locMap.values())
      .filter((l) => l.stock > 0)
      .sort((a, b) => {
        if (a.fVencimiento && b.fVencimiento) return a.fVencimiento.localeCompare(b.fVencimiento)
        if (a.fVencimiento) return -1
        if (b.fVencimiento) return 1
        return 0
      })
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

      {/* Card de Stock Big Magic — siempre visible al buscar un código */}
      {codigo.trim() && stockBM !== null && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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

      {stock.length > 0 ? (
        <div className="space-y-3">
          {/* ── Mobile: Card layout (md+ hidden) ── */}
          <div className="md:hidden space-y-2">
            {stock.map((s, i) => {
              const hoy = new Date(new Date().toDateString())
              const fVen = s.fVencimiento ? new Date(s.fVencimiento + 'T00:00:00') : null
              const diffDias = fVen ? (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24) : null
              const vencido = diffDias !== null && diffDias < 0
              const naranja = !vencido && diffDias !== null && diffDias <= 15
              const azul = !vencido && !naranja && diffDias !== null && diffDias <= 30

              const badgeClass = vencido
                ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
                : naranja
                ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
                : azul
                ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
                : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'

              return (
                <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
                  {/* Row 1: Ubicación + Stock + Eliminar */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <span className="text-muted-foreground">Bloq</span>
                      <span className="font-mono">{s.bloque}</span>
                      <span className="text-muted-foreground mx-0.5">|</span>
                      <span className="text-muted-foreground">Tor</span>
                      <span className="font-mono">{s.torre}</span>
                      <span className="text-muted-foreground mx-0.5">|</span>
                      <span className="text-muted-foreground">Pis</span>
                      <span className="font-mono">{s.piso}</span>
                      <span className="text-muted-foreground mx-0.5">|</span>
                      <span className="text-muted-foreground">Pos</span>
                      <span className="font-mono">{s.posicion}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="default" className="text-sm">{s.stock}</Badge>
                      {esAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-400/60 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                          onClick={() => handleDelete(s.bloque, s.torre, s.piso, s.posicion)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Row 2: Descripción */}
                  <p className="text-xs text-muted-foreground leading-tight">{s.descripcion}</p>
                  {/* Row 3: UN + Proveedor + Vencimiento */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span><span className="text-muted-foreground">UN: </span>{s.un}</span>
                    {s.proveedor ? (
                      <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 text-[10px] px-1.5 py-0 font-semibold">
                        {s.proveedor}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Prov: —</span>
                    )}
                    {s.fVencimiento ? (
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${badgeClass}`}>
                        {s.fVencimiento}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Venc: —</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Desktop: Table layout (hidden on mobile) ── */}
          <div className="hidden md:block overflow-x-auto">
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
                  <TableHead>Vencimiento</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  {esAdmin && <TableHead className="w-12"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((s, i) => {
                  const hoy = new Date(new Date().toDateString())
                  const fVen = s.fVencimiento ? new Date(s.fVencimiento + 'T00:00:00') : null
                  const diffDias = fVen ? (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24) : null
                  const vencido = diffDias !== null && diffDias < 0
                  const naranja = !vencido && diffDias !== null && diffDias <= 15
                  const azul = !vencido && !naranja && diffDias !== null && diffDias <= 30
                  const verde = !vencido && !naranja && !azul

                  const badgeClass = vencido
                    ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
                    : naranja
                    ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
                    : azul
                    ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
                    : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'

                  return (
                    <TableRow key={i}>
                      <TableCell className="font-mono font-medium whitespace-nowrap">{s.bloque}</TableCell>
                      <TableCell className="whitespace-nowrap">{s.torre}</TableCell>
                      <TableCell className="font-medium whitespace-nowrap">{s.piso}</TableCell>
                      <TableCell className="whitespace-nowrap">{s.posicion}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{s.descripcion}</TableCell>
                      <TableCell className="whitespace-nowrap">{s.un}</TableCell>
                      <TableCell>
                        {s.proveedor ? (
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                            {s.proveedor}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.fVencimiento ? (
                          <Badge variant="outline" className={`font-semibold ${badgeClass}`}>
                            {s.fVencimiento}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        <Badge variant="default">{s.stock}</Badge>
                      </TableCell>
                      {esAdmin && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-red-400/60 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={() =>
                              handleDelete(s.bloque, s.torre, s.piso, s.posicion)
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
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
          <span>Sin stock en RACKLY para &quot;{codigo}&quot;</span>
        </div>
      ) : (
        <p className="text-muted-foreground text-center py-8">
          Escribe un código para ver el stock por ubicación.
        </p>
      )}
    </div>
  )
}
