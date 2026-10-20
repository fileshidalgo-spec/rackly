'use client'

import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { stockPisoBuscar, type StockPisoItem } from '@/lib/piso/api'
import { targetDesdeStockItem, type PisoTargetPosicion } from '@/lib/piso/navegacion'
import { findCatalogoByCodigo, fetchCatalogo, isCatalogoLoaded } from '@/lib/rackly/catalogo'
import { loadTabState, saveTabState } from '@/lib/rackly/tab-state'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, PackageSearch, Loader2, MapPin, AlertTriangle, ExternalLink } from 'lucide-react'

export function PisoStockTab({ onGotoPosicion }: { onGotoPosicion?: (target: PisoTargetPosicion) => void }) {
  // Estado persistido en sessionStorage (inicializador lazy): al volver desde
  // Sectores (botón de retorno) la búsqueda continúa donde quedó.
  const [query, setQuery] = useState(() => loadTabState('piso.stock', { q: '', filter: 'todos' }).q)
  const [stockFilter, setStockFilter] = useState<'todos' | 'disponibles' | 'inc'>(() => {
    const f = loadTabState('piso.stock', { q: '', filter: 'todos' }).filter
    return f === 'inc' || f === 'disponibles' ? f : 'todos'
  })
  const [items, setItems] = useState<StockPisoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const seqRef = useRef(0)
  // Guard por Nº de petición: una respuesta LENTA de un término anterior jamás
  // pisa el resultado del término actual (antes mountedRef se re-activaba en
  // cada tecleo y la respuesta vieja sobrescribía `items` con resultados de
  // otra búsqueda — mismo patrón que StockTab ya corrigió con serverReqRef).

  // Búsqueda BAJO DEMANDA (debounced): stockPisoBuscar consulta en SERVIDOR solo
  // los bloques que matchean (código o descripción). Antes se llamaba
  // stockPisoGlobal() — descargaba TODOS los detalles del almacén (hasta 40K filas
  // paginadas + FEFO + ubicaciones de todo) y filtraba en cliente: carga visual y
  // de proceso innecesaria en cada tecleo.
  useEffect(() => {
    mountedRef.current = true
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const term = query.trim()
    if (!term) {
      // FIX auditoría 2026-10-21 (P2): invalidar la búsqueda en vuelo — sin
      // incrementar seqRef, la respuesta de la búsqueda anterior pintaba
      // resultados "fantasma" con el input ya vacío (y el spinner colgado).
      seqRef.current++
      setItems([])
      setHasSearched(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      const req = ++seqRef.current
      setLoading(true)
      try {
        // El catálogo solo alimenta la tarjeta Big Magic: se resuelve en paralelo
        // sin bloquear la consulta de stock.
        const catTask = isCatalogoLoaded() ? Promise.resolve() : fetchCatalogo().catch(() => {})
        const [data] = await Promise.all([stockPisoBuscar(term), catTask])
        if (req !== seqRef.current || !mountedRef.current) return // llegó una búsqueda más reciente (o desmontó)
        setItems(data)
        setHasSearched(true)
        setLastRefresh(new Date())
      } catch (err) {
        console.error('Error cargando stock Piso:', err)
        if (req !== seqRef.current || !mountedRef.current) return
        // Error VISIBLE (p.ej. timeout real de la consulta): antes solo
        // setHasSearched(true) mostraba "Sin resultados" — un fallo y una
        // lista vacía real se veían idénticos.
        setHasSearched(true)
        toast.error('No se pudo completar la búsqueda', {
          description: err instanceof Error ? err.message : 'Error desconocido',
        })
      } finally {
        if (req === seqRef.current && mountedRef.current) setLoading(false)
      }
    }, 400)
    return () => {
      mountedRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // Persistir la búsqueda en curso (se restaura al volver desde Sectores)
  useEffect(() => {
    saveTabState('piso.stock', { q: query, filter: stockFilter })
  }, [query, stockFilter])

  // Get Big Magic stock for the search term
  const bmItem = query.trim() ? findCatalogoByCodigo(query.trim()) : null

  // Filtro local de afinado (el resultado ya viene filtrado por servidor; esto
  // cubre búsqueda incremental SIN re-consultar mientras el usuario teclea más)
  const term = query.trim().toUpperCase()
  const bySearch = term
    ? items.filter(
        i =>
          i.bloque_codigo.toUpperCase().includes(term) ||
          i.bloque_descripcion.toUpperCase().includes(term) ||
          (i.codigo_inc && i.codigo_inc.toUpperCase().includes(term))
      )
    : items
  // Filter by INC status
  const filtered = bySearch.filter((i) => {
    if (stockFilter === 'inc') return !!i.codigo_inc
    if (stockFilter === 'disponibles') return !i.codigo_inc
    return true
  })

  // Aggregate total stock per code — sobre las filas FILTRADAS visibles (antes
  // sumaba `items` completos: con filtro "Solo INC" o "Disponibles" el badge
  // del header mostraba la suma de ambos, contradiciendo las filas).
  const stockPorCodigo = new Map<string, number>()
  for (const item of filtered) {
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
      {/* Filter buttons: Todos / Disponibles / Solo INC */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
        {(['todos', 'disponibles', 'inc'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStockFilter(f)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-300 ${
              stockFilter === f
                ? f === 'inc'
                  ? 'bg-rose-500/20 border border-rose-500/40 text-rose-300 shadow-sm shadow-rose-500/10'
                  : 'bg-sky-500/20 border border-sky-500/40 text-sky-300 shadow-sm shadow-sky-500/10'
                : 'bg-slate-800/60 border border-slate-700/40 text-slate-400 hover:text-slate-300'
            }`}
          >
            {f === 'inc' && <AlertTriangle className="h-3 w-3" />}
            {f === 'todos' ? 'Todos' : f === 'disponibles' ? 'Disponibles' : 'Solo INC'}
          </button>
        ))}
        </div>
        <p className="text-[10px] text-slate-500 hidden sm:flex items-center gap-1">
          <MapPin className="h-3 w-3 text-violet-500" />
          Toca la ubicación para ir a la posición y realizar movimientos
        </p>
      </div>

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
      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Buscando stock...</span>
        </div>
      )}

      {/* Empty state: prompt to search */}
      {!loading && !hasSearched && (
        <div className="flex flex-col items-center gap-3 py-16 text-slate-500">
          <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center">
            <Search className="h-7 w-7 text-slate-600" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-slate-400">Busca por codigo o descripcion</p>
            <p className="text-xs text-slate-600 mt-1">Escribe para consultar el stock de Piso</p>
          </div>
        </div>
      )}

      {/* No results after search */}
      {!loading && hasSearched && grouped.size === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
          <PackageSearch className="h-8 w-8" />
          <span className="text-sm">
            Sin resultados para &quot;{query}&quot;
          </span>
        </div>
      )}

      {/* Results */}
      {!loading && grouped.size > 0 ? (
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
                  {rows.map((r, i) => {
                    const target = onGotoPosicion ? targetDesdeStockItem(r) : null
                    return (
                    <div key={i} className="px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                          <MapPin className="h-3 w-3" />
                          {target ? (
                            <button
                              type="button"
                              onClick={() => onGotoPosicion?.(target)}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/60 text-[10px] font-mono font-semibold text-violet-300 transition-colors cursor-pointer active:scale-95"
                              title="Ir a la posición en Sectores para realizar movimientos"
                            >
                              {r.ubicacion}
                              <ExternalLink className="h-2.5 w-2.5 text-violet-400" />
                            </button>
                          ) : (
                            <span className="font-medium text-slate-300">{r.ubicacion}</span>
                          )}
                        </div>
                        <span className="text-xs font-bold text-white">{r.cantidad} {r.bloque_unidad}</span>
                      </div>
                      <p className="text-[10px] text-slate-500 leading-tight truncate">{r.bloque_descripcion}</p>
                      <div className="flex items-center gap-2">
                        {vencimientoBadge(r.fecha_vencimiento)}
                        {r.codigo_inc && (
                          <Badge className="bg-rose-500/15 text-rose-400 border border-rose-500/30 text-[9px] font-semibold gap-0.5 px-1 py-0">
                            <AlertTriangle className="h-2 w-2" /> {r.codigo_inc}
                          </Badge>
                        )}
                        {r.sector_nombre && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-slate-600 text-slate-500">
                            {r.sector_nombre}
                          </Badge>
                        )}
                      </div>
                    </div>
                    )
                  })}
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
                {filtered.map((r, i) => {
                  const target = onGotoPosicion ? targetDesdeStockItem(r) : null
                  const celdaUbi = target ? (
                    <button
                      type="button"
                      onClick={() => onGotoPosicion?.(target)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/60 text-xs font-mono font-semibold text-violet-300 transition-colors cursor-pointer active:scale-95 whitespace-nowrap"
                      title="Ir a la posición en Sectores para realizar movimientos"
                    >
                      <MapPin className="h-3 w-3 text-violet-400" />
                      {r.ubicacion}
                      <ExternalLink className="h-2.5 w-2.5 text-violet-400" />
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-200">
                      <MapPin className="h-3 w-3 text-slate-500" />{r.ubicacion}
                    </span>
                  )
                  return (
                  <TableRow key={i} className="border-slate-700/50 hover:bg-slate-700/30">
                    <TableCell className="font-mono font-semibold text-indigo-400 text-xs">{r.bloque_codigo}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{celdaUbi}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-slate-400">
                      {r.sector_nombre || '—'}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-slate-400 max-w-[200px] truncate">{r.bloque_descripcion}</TableCell>
                    <TableCell className="text-xs text-slate-300">{r.bloque_unidad}</TableCell>
                    <TableCell>{vencimientoBadge(r.fecha_vencimiento)}</TableCell>
                    <TableCell className="text-right text-xs font-bold text-white">{r.cantidad}</TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

        </div>
      ) : null}
    </div>
  )
}