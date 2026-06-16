'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  type Movimiento,
  eliminarUbicacion,
} from '@/lib/rackly/kardex'
import { stockPisoGlobal, type StockPisoItem } from '@/lib/piso/api'
import {
  findCatalogoByCodigo,
  fetchCatalogo,
  isCatalogoLoaded,
  searchCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
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
import { Search, Trash2, PackageSearch, Warehouse, ArrowRight, AlertTriangle, Layers3, MapPin, Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

// ═══ Sub-componente: Sección cruzada Kardex Piso ═══
function CrossSectionPiso({
  selectedCodigo,
  stockFilter,
  pisoStock,
  setPisoStock,
  pisoLoading,
  setPisoLoading,
  pisoSearchedCode,
  setPisoSearchedCode,
}: {
  selectedCodigo: string
  stockFilter: string
  pisoStock: StockPisoItem[]
  setPisoStock: (v: StockPisoItem[]) => void
  pisoLoading: boolean
  setPisoLoading: (v: boolean) => void
  pisoSearchedCode: string
  setPisoSearchedCode: (v: string) => void
}) {
  // Buscar stock en Piso cuando se selecciona un código en Racks
  const [pisoError, setPisoError] = useState(false)

  useEffect(() => {
    if (!selectedCodigo) {
      setPisoStock([])
      setPisoSearchedCode('')
      setPisoError(false)
      return
    }
    if (selectedCodigo === pisoSearchedCode) return

    let cancelled = false
    setPisoLoading(true)
    setPisoSearchedCode(selectedCodigo)
    setPisoError(false)

    stockPisoGlobal()
      .then((allPiso) => {
        if (cancelled) return
        const code = selectedCodigo.toUpperCase().trim()
        const filtered = allPiso.filter(item =>
          item.bloque_codigo.toUpperCase().trim() === code
        )
        console.log('[CrossSectionPiso] buscando:', code, 'en', allPiso.length, 'items de Piso, encontrados:', filtered.length)
        if (filtered.length === 0 && allPiso.length > 0) {
          const codes = [...new Set(allPiso.map(i => i.bloque_codigo.toUpperCase().trim()))]
          console.log('[CrossSectionPiso] codigos disponibles (primeros 20):', codes.slice(0, 20))
          const similar = codes.filter(c => c.includes(code) || code.includes(c))
          console.log('[CrossSectionPiso] similares:', similar)
        }
        setPisoStock(filtered)
        setPisoLoading(false)
      })
      .catch((err) => {
        console.error('[CrossSectionPiso] error:', err)
        if (!cancelled) {
          setPisoLoading(false)
          setPisoError(true)
        }
      })

    return () => { cancelled = true }
  }, [selectedCodigo, pisoSearchedCode, setPisoStock, setPisoLoading, setPisoSearchedCode])

  // Aplicar filtro INC
  const filtered = pisoStock.filter((i) => {
    if (stockFilter === 'inc') return !!i.codigo_inc
    if (stockFilter === 'disponibles') return !i.codigo_inc
    return true
  })

  const totalPiso = filtered.reduce((sum, i) => sum + i.cantidad, 0)

  // Siempre mostrar la sección cuando hay un código seleccionado (loading, resultados, o vacío)
  if (!selectedCodigo) return null

  return (
      <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 overflow-hidden">
        <div className="px-4 py-3 bg-amber-100/50 dark:bg-amber-900/20 border-b border-amber-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center">
              <Layers3 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-xs font-bold text-amber-700 dark:text-amber-300">Tambien en Kardex Piso</p>
              <p className="text-[10px] text-amber-500/70">Stock en piso para este articulo</p>
            </div>
          </div>
          {pisoLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
          ) : (
            <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-amber-500/40 text-amber-700 dark:text-amber-300">
              Total: <span className="font-bold ml-1">{totalPiso}</span>
            </Badge>
          )}
        </div>

        {pisoError ? (
          <div className="px-4 py-4 text-center text-amber-600/60 text-xs">
            Error al buscar en Kardex Piso. Intenta de nuevo.
          </div>
        ) : pisoLoading ? (
          <div className="px-4 py-6 text-center text-amber-500/60 text-xs">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />
            Buscando en Kardex Piso...
          </div>
        ) : filtered.length > 0 ? (
          <div className="hidden sm:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-amber-50/50 dark:bg-amber-900/10 hover:bg-amber-900/10">
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase">Ubicacion</TableHead>
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase hidden lg:table-cell">Sector</TableHead>
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase hidden sm:table-cell">Descripcion</TableHead>
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase">UN</TableHead>
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase">Vencimiento</TableHead>
                  <TableHead className="text-[10px] font-semibold text-amber-600/80 dark:text-amber-400/80 uppercase text-right">Cantidad</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, i) => (
                  <TableRow key={i} className="border-amber-500/10 hover:bg-amber-50/50 dark:hover:bg-amber-900/10">
                    <TableCell className="text-xs text-amber-800 dark:text-amber-200 whitespace-nowrap font-medium">{r.ubicacion}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-slate-500">{r.sector_nombre || '—'}</TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-slate-500 max-w-[200px] truncate">{r.bloque_descripcion}</TableCell>
                    <TableCell className="text-xs text-slate-600 dark:text-slate-400">{r.bloque_unidad}</TableCell>
                    <TableCell>
                      {r.fecha_vencimiento ? (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${(() => {
                          const hoy = new Date(new Date().toDateString())
                          const fVen = new Date(r.fecha_vencimiento + 'T00:00:00')
                          const diff = (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
                          return diff < 0
                            ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
                            : diff <= 15
                              ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
                              : diff <= 30
                                ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
                                : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'
                        })()}`}>
                          {r.fecha_vencimiento}
                        </Badge>
                      ) : <span className="text-xs text-slate-500">—</span>}
                    </TableCell>
                    <TableCell className="text-right text-xs font-bold text-amber-800 dark:text-amber-200">{r.cantidad}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {/* Mobile cards */}
        {filtered.length > 0 && (
          <div className="sm:hidden divide-y divide-amber-500/10">
            {filtered.map((r, i) => (
              <div key={i} className="px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[10px]">
                  <MapPin className="h-3 w-3 text-amber-500" />
                  <span className="font-medium text-amber-800 dark:text-amber-200">{r.ubicacion}</span>
                  {r.sector_nombre && (
                    <span className="text-amber-500/60">{r.sector_nombre}</span>
                  )}
                </div>
                <span className="text-xs font-bold text-amber-800 dark:text-amber-200">{r.cantidad} {r.bloque_unidad}</span>
              </div>
            ))}
          </div>
        )}
        {!pisoLoading && !pisoError && filtered.length === 0 && (
          <div className="px-4 py-4 text-center text-amber-600/50 text-xs">
            Sin stock en Kardex Piso para este codigo
          </div>
        )}
      </div>
    )
}

export function StockTab() {
  const { perfil } = useAuth()
  const esAdmin = perfil?.rol === 'admin'
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [query, setQuery] = useState('')
  const [selectedCodigo, setSelectedCodigo] = useState('')
  // Stock cruzado: Piso
  const [pisoStock, setPisoStock] = useState<StockPisoItem[]>([])
  const [pisoLoading, setPisoLoading] = useState(false)
  const [pisoSearchedCode, setPisoSearchedCode] = useState('')
  const [stockFilter, setStockFilter] = useState<'todos' | 'disponibles' | 'inc'>('todos')
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
      codigoInc?: string
    }[]
  >([])

  useMovimientosRealtime(setMovs)

  // Catálogo para búsqueda y lookup
  const [catalogoResults, setCatalogoResults] = useState<CatalogoItem[]>([])
  const [catalogoLoaded, setCatalogoLoaded] = useState(false)

  // Cargar catálogo al montar
  useEffect(() => {
    async function load() {
      if (!isCatalogoLoaded()) {
        await fetchCatalogo().catch(() => {})
      }
      setCatalogoLoaded(true)
    }
    load()
  }, [])

  // Buscar sugerencias del catálogo cuando el usuario escribe
  useEffect(() => {
    if (!catalogoLoaded || !query.trim()) {
      setCatalogoResults([])
      return
    }
    if (!isCatalogoLoaded()) return
    const results = searchCatalogo(query.trim(), 8)
    setCatalogoResults(results)
  }, [query, catalogoLoaded])

  // Datos del artículo seleccionado del catálogo
  const selectedItem = useMemo(() => {
    if (!selectedCodigo) return null
    return findCatalogoByCodigo(selectedCodigo)
  }, [selectedCodigo])

  // Calcular stock por ubicación para el código seleccionado
  const stockData = useMemo(() => {
    if (!selectedCodigo || movs.length === 0) return []
    const code = selectedCodigo.trim().toUpperCase()
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
        codigoInc?: string
      }
    >()
    const relevant = movs.filter((m) => m.codigo === code)
    for (const m of relevant) {
      const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}||${m.fVencimiento || ''}||${m.codigoInc || ''}`
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
          fVencimiento: m.fVencimiento || '',
          codigoInc: m.codigoInc || undefined,
        })
      }
    }
    return Array.from(locMap.values()).filter((l) => {
      if (l.stock <= 0) return false
      if (stockFilter === 'inc') return !!l.codigoInc
      if (stockFilter === 'disponibles') return !l.codigoInc
      return true
    })
      .sort((a, b) => {
        // FEFO primero (con fecha de vencimiento), luego sin fecha por bloque (1→7)
        const aHasDate = !!a.fVencimiento
        const bHasDate = !!b.fVencimiento
        if (aHasDate && bHasDate) return a.fVencimiento.localeCompare(b.fVencimiento)
        if (aHasDate && !bHasDate) return -1
        if (!aHasDate && bHasDate) return 1
        // Ambos sin fecha: ordenar por bloque, torre, piso, posición
        const aB = parseInt(a.bloque, 10) || 0
        const bB = parseInt(b.bloque, 10) || 0
        if (aB !== bB) return aB - bB
        const aT = parseInt(a.torre, 10) || 0
        const bT = parseInt(b.torre, 10) || 0
        if (aT !== bT) return aT - bT
        const aP = parseInt(a.piso, 10) || 0
        const bP = parseInt(b.piso, 10) || 0
        if (aP !== bP) return aP - bP
        const aPos = parseInt(a.posicion, 10) || 0
        const bPos = parseInt(b.posicion, 10) || 0
        return aPos - bPos
      })
  }, [selectedCodigo, movs, stockFilter])

  useEffect(() => {
    setStock(stockData)
  }, [stockData])

  // Manejar selección de un código
  function selectCodigo(codigo: string) {
    setSelectedCodigo(codigo.toUpperCase())
    setQuery(codigo.toUpperCase())
    setCatalogoResults([])
  }

  async function handleDelete(
    bloque: string,
    torre: string,
    piso: string,
    posicion: string,
    fVencimiento?: string
  ) {
    if (!confirm('¿Eliminar los movimientos de este lote en esta ubicación?')) return
    try {
      const next = await eliminarUbicacion(selectedCodigo, bloque, torre, piso, posicion, fVencimiento)
      setMovs(next)
      toast.success('Ubicación eliminada')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  // Badge color según días para vencer
  function getBadgeClass(fVencimiento: string) {
    const hoy = new Date(new Date().toDateString())
    const fVen = fVencimiento ? new Date(fVencimiento + 'T00:00:00') : null
    const diffDias = fVen ? (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24) : null
    const vencido = diffDias !== null && diffDias < 0
    const naranja = !vencido && diffDias !== null && diffDias <= 15
    const azul = !vencido && !naranja && diffDias !== null && diffDias <= 30

    return vencido
      ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
      : naranja
      ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
      : azul
      ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
      : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'
  }

  // ── Sin código seleccionado: buscar por código o descripción ──
  if (!selectedCodigo) {
    return (
      <div className="space-y-4">
        {/* Barra de búsqueda */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // Si el usuario escribió un código exacto, seleccionarlo directo
              const val = e.target.value.trim().toUpperCase()
              if (isCatalogoLoaded() && findCatalogoByCodigo(val)) {
                // No seleccionar automáticamente, dejar que el usuario elija
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                // Buscar el primer resultado y seleccionarlo
                if (catalogoResults.length > 0) {
                  selectCodigo(catalogoResults[0].codigo)
                } else {
                  // Si no hay resultados en catálogo, buscar de todas formas
                  selectCodigo(query.trim())
                }
              }
              if (e.key === 'Escape') {
                setQuery('')
                setCatalogoResults([])
              }
            }}
            placeholder="Buscar por código o descripción..."
            className="pl-9"
          />
          {query && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => { setQuery(''); setCatalogoResults([]) }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Sugerencias del catálogo */}
        {catalogoResults.length > 0 && (
          <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground">
                {catalogoResults.length} resultado{catalogoResults.length > 1 ? 's' : ''} en el catálogo
              </p>
            </div>
            {catalogoResults.map((item) => (
              <button
                key={item.codigo}
                type="button"
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors text-left border-b last:border-b-0"
                onClick={() => selectCodigo(item.codigo)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm">{item.codigo}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{item.un}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{item.descripcion}</p>
                </div>
                <div className="text-right shrink-0">
                  {item.stock_big_magic > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">BM</span>
                      <span className="text-sm font-bold text-amber-700 dark:text-amber-300">{item.stock_big_magic}</span>
                    </div>
                  )}
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        )}

        {/* Sin búsqueda activa */}
        {!query && (
          <p className="text-muted-foreground text-center py-8">
            Escribe un código o descripción para buscar stock.
          </p>
        )}

        {/* Búsqueda sin resultados */}
        {query.trim() && catalogoResults.length === 0 && catalogoLoaded && (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <PackageSearch className="h-5 w-5" />
            <span>No se encontró &quot;{query}&quot; en el catálogo.</span>
          </div>
        )}
      </div>
    )
  }

  // ── Con código seleccionado: mostrar stock por ubicación o info de Big Magic ──
  return (
    <div className="space-y-4">
      {/* Barra de búsqueda con código seleccionado */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelectedCodigo('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSelectedCodigo('')
              setQuery('')
            }
          }}
          placeholder="Buscar por código o descripción..."
          className="pl-9"
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border hover:border-foreground/30 transition-colors"
          onClick={() => { setSelectedCodigo(''); setQuery('') }}
        >
          × Cambiar
        </button>
      </div>

      {/* Info del artículo seleccionado */}
      {selectedItem && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm">{selectedItem.codigo}</span>
            <Badge variant="outline" className="text-xs">{selectedItem.un}</Badge>
          </div>
          <p className="text-sm">{selectedItem.descripcion}</p>
        </div>
      )}

      {/* Card de Stock Big Magic */}
      {selectedItem && (
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
            <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{selectedItem.stock_big_magic}</p>
          </div>
        </div>
      )}

      {/* ── INC Filter buttons (always visible when a code is selected) ── */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Warehouse className="h-3.5 w-3.5" />
          {stock.length > 0 ? 'Stock por ubicación en RACKLY' : 'Sin stock en ubicaciones de RACKLY'}
        </p>
      </div>
      <div className="flex gap-2">
        {([['todos', 'Todos'], ['disponibles', 'Disponibles'], ['inc', 'Solo INC']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStockFilter(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
              stockFilter === key
                ? key === 'inc'
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                  : key === 'disponibles'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                : 'bg-slate-700/30 border-slate-600/30 text-slate-500 hover:text-slate-400'
            }`}
          >
            {key === 'inc' && <AlertTriangle className="w-3 h-3" />}
            {label}
          </button>
        ))}
      </div>

      {/* Stock por ubicación */}
      {stock.length > 0 ? (
        <>
        <div className="space-y-3">

          {/* ── Mobile: Card layout ── */}
          <div className="md:hidden space-y-2">
            {stock.map((s, i) => (
              <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
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
                        onClick={() => handleDelete(s.bloque, s.torre, s.piso, s.posicion, s.fVencimiento)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-tight">{s.descripcion}</p>
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
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${getBadgeClass(s.fVencimiento)}`}>
                      {s.fVencimiento}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">Venc: —</span>
                  )}
                  {s.codigoInc && (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 text-[10px] px-1.5 py-0 font-semibold">
                      <AlertTriangle className="w-3 h-3 mr-0.5" /> {s.codigoInc}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop: Table layout ── */}
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
                  <TableHead>INC</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  {esAdmin && <TableHead className="w-12"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((s, i) => (
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
                        <Badge variant="outline" className={`font-semibold ${getBadgeClass(s.fVencimiento)}`}>
                          {s.fVencimiento}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.codigoInc ? (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 font-semibold text-xs">
                          <AlertTriangle className="w-3 h-3 mr-0.5" /> {s.codigoInc}
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
                          onClick={() => handleDelete(s.bloque, s.torre, s.piso, s.posicion, s.fVencimiento)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
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

        </>
      ) : (
        /* Sin stock en ubicaciones — mostrar info del catálogo + Big Magic */
        <div className="space-y-3">

          {selectedItem ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800/50 dark:to-slate-800 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-slate-500/10 flex items-center justify-center">
                  <PackageSearch className="h-4 w-4 text-slate-500" />
                </div>
                <p className="text-sm font-medium">Datos del artículo</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Código</p>
                  <p className="font-mono font-bold">{selectedItem.codigo}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">UN</p>
                  <p className="font-bold">{selectedItem.un}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Descripción</p>
                  <p className="text-sm">{selectedItem.descripcion}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Stock Big Magic</p>
                  <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{selectedItem.stock_big_magic}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Stock en Racks</p>
                  <p className="text-xl font-bold text-slate-400">0</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <PackageSearch className="h-5 w-5" />
              <span>Sin stock en RACKLY para &quot;{selectedCodigo}&quot; (no encontrado en catálogo)</span>
            </div>
          )}
        </div>
      )}

      {/* ═══ SECCIÓN CRUZADA: También en Kardex Piso ═══ */}
      <CrossSectionPiso
        selectedCodigo={selectedCodigo}
        stockFilter={stockFilter}
        pisoStock={pisoStock}
        setPisoStock={setPisoStock}
        pisoLoading={pisoLoading}
        setPisoLoading={setPisoLoading}
        pisoSearchedCode={pisoSearchedCode}
        setPisoSearchedCode={setPisoSearchedCode}
      />
    </div>
  )
}
