'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { stockPisoGlobal, type StockPisoItem } from '@/lib/piso/api'
import { findCatalogoByCodigo, fetchCatalogo, isCatalogoLoaded } from '@/lib/rackly/catalogo'
import { usePisoRealtime } from '@/hooks/usePisoRealtime'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, PackageSearch, Loader2, RefreshCw, MapPin } from 'lucide-react'

export function PisoStockTab() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<StockPisoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const mountedRef = useRef(true)

  const loadStock = useCallback(async () => {
    setLoading(true)
    try {
      if (!isCatalogoLoaded()) await fetchCatalogo().catch(() => {})
      const data = await stockPisoGlobal()
      if (mountedRef.current) {
        setItems(data)
        setLastRefresh(new Date())
      }
    } catch (err) {
      console.error('Error cargando stock Piso:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadStock()
    return () => { mountedRef.current = false }
  }, [loadStock])

  // Realtime: auto-refresh when piso_movimientos changes (8s polling + Supabase Realtime)
  // Replaces the old 30s polling with instant updates
  usePisoRealtime(loadStock)

  // Get Big Magic stock for the search term
  const bmItem = query.trim() ? findCatalogoByCodigo(query.trim()) : null

  // Filter items by code or description
  const term = query.trim().toUpperCase()
  const filtered = term
    ? items.filter(
        i =>
          i.bloque_codigo.toUpperCase().includes(term) ||
          i.bloque_descripcion.toUpperCase().includes(term)
      )
    : items

  // Aggregate total stock per code
  const stockPorCodigo = new Map<string, number>()
  for (const item of items) {
    stockPorCodigo.set(item.bloque_codigo, (stockPorCodigo.get(item.bloque_codigo) ?? 0) + item.cantidad)
  }

  // Group filtered results by bloque_codigo for better readability
  const grouped = new Map<string, StockPisoItem[]>()
  for (const item of filtered) {
    const arr = grouped.get(item.bloque_codigo) ?? []
    arr.push(item)
    grouped.set(item.bloque_codigo, arr)
  }

  const totalFiltered = filtered.reduce((sum, i) => sum + i.cantidad, 0)

  function vencimientoBadge(fv: string) {
    if (!fv) return <span className="text-xs text-slate-500">—</span>
    const hoy = new Date(new Date().toDateString())
    const fVen = new Date(fv + 'T00:00:00')
    const diff = (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
    const cls = diff < 0
      ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
      : diff <= 15
        ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
        : diff <= 30
          ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
          : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'
    return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${cls}`}>{fv}</Badge>
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por codigo o descripcion..."
            className="pl-9 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
          />
        </div>
        <button
          onClick={loadStock}
          disabled={loading}
          className="h-9 px-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors flex items-center gap-1.5 text-xs font-medium"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">Actualizar</span>
        </button>
      </div>

      {/* Big Magic card */}
      {query.trim() && bmItem && (
        <div className="rounded-lg border border-amber-200/30 dark:border-amber-800/40 bg-gradient-to-r from-amber-950/30 to-orange-950/20 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
              <span className="text-amber-400 font-bold text-xs">BM</span>
            </div>
            <div>
              <p className="text-xs text-amber-400/80 font-medium">Stock Big Magic</p>
              <p className="text-[10px] text-slate-500">Sistema Big Magic</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-amber-400">{bmItem.stock_big_magic}</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && items.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Cargando stock...</span>
        </div>
      )}

      {/* Results */}
      {grouped.size > 0 ? (
        <div className="space-y-4">
          {/* Total */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              {grouped.size} articulo{grouped.size !== 1 ? 's' : ''} encontrado{grouped.size !== 1 ? 's' : ''}
              {lastRefresh && (
                <span className="ml-2">· Actualizado: {lastRefresh.toLocaleTimeString()}</span>
              )}
            </p>
            <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-slate-600 text-slate-300">
              Total: <span className="font-bold ml-1">{totalFiltered}</span>
            </Badge>
          </div>

          {/* ── Mobile: Cards ── */}
          <div className="md:hidden space-y-3">
            {[...grouped.entries()].map(([codigo, rows]) => (
              <div key={codigo} className="rounded-lg border border-slate-700 bg-slate-800 overflow-hidden">
                {/* Code header */}
                <div className="px-3 py-2 bg-slate-700/50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded">
                      {codigo}
                    </span>
                    <Badge variant="default" className="text-xs bg-indigo-600">
                      {stockPorCodigo.get(codigo) ?? 0}
                    </Badge>
                  </div>
                </div>
                {/* Lots */}
                <div className="divide-y divide-slate-700/50">
                  {rows.map((r, i) => (
                    <div key={i} className="px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                          <MapPin className="h-3 w-3" />
                          <span className="font-medium text-slate-300">{r.ubicacion}</span>
                        </div>
                        <span className="text-xs font-bold text-white">{r.cantidad} {r.bloque_unidad}</span>
                      </div>
                      <p className="text-[10px] text-slate-500 leading-tight truncate">{r.bloque_descripcion}</p>
                      <div className="flex items-center gap-2">
                        {vencimientoBadge(r.fecha_vencimiento)}
                        {r.sector_nombre && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-slate-600 text-slate-500">
                            {r.sector_nombre}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop: Table ── */}
          <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-700">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 hover:bg-slate-800">
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Codigo</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Ubicacion</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase hidden lg:table-cell">Sector</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase hidden sm:table-cell">Descripcion</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">UN</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Vencimiento</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase text-right">Cantidad</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, i) => (
                  <TableRow key={i} className="border-slate-700/50 hover:bg-slate-700/30">
                    <TableCell className="font-mono font-semibold text-indigo-400 text-xs">{r.bloque_codigo}</TableCell>
                    <TableCell className="text-xs text-slate-200 whitespace-nowrap">{r.ubicacion}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-slate-400">
                      {r.sector_nombre || '—'}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-slate-400 max-w-[200px] truncate">{r.bloque_descripcion}</TableCell>
                    <TableCell className="text-xs text-slate-300">{r.bloque_unidad}</TableCell>
                    <TableCell>{vencimientoBadge(r.fecha_vencimiento)}</TableCell>
                    <TableCell className="text-right text-xs font-bold text-white">{r.cantidad}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : !loading && (query.trim() || items.length === 0) ? (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
          <PackageSearch className="h-8 w-8" />
          <span className="text-sm">
            {query.trim()
              ? `Sin resultados para "${query}"`
              : 'No hay stock registrado en Kardex Piso'}
          </span>
        </div>
      ) : null}
    </div>
  )
}
