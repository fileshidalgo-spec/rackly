'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  type Movimiento,
  eliminarUbicacion,
  fetchStockPorCodigoRPC,
} from '@/lib/rackly/kardex'
// Decoupled: Kardex Racks ya no consulta stock de Kardex Piso
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
import { Search, Trash2, PackageSearch, Warehouse, ArrowRight, AlertTriangle } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

export function StockTab() {
  const { perfil } = useAuth()
  const esAdmin = perfil?.rol === 'admin'
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [query, setQuery] = useState('')
  const [selectedCodigo, setSelectedCodigo] = useState('')
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
      fVencimiento: string          // fecha más próxima (FEFO), solo informativo
      lotesInfo: string            // resumen de lotes, solo informativo
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

  // Calcular stock por ubicación para el código seleccionado.
  // LÓGICA IDÉNTICA a calcularOcupacion() en OcupacionTab:
  //   - Agrupa por posición + código
  //   - Excluye INC
  //   - Suma delta (ingreso/devolucion/traslado = +, salida = -)
  //   - Ignora f_vencimiento para el cálculo de stock
  // Luego filtra por el código seleccionado y agrega info FEFO como datos extras.
  const stockData = useMemo(() => {
    if (!selectedCodigo || movs.length === 0) return []
    const code = selectedCodigo.trim().toUpperCase()
    const isIncMode = stockFilter === 'inc'

    // PASO 1: Calcular stock neto por (posición, código) — IDÉNTICO a calcularOcupacion
    const cellMap = new Map<string, Map<string, number>>() // posKey → (codigo → stock)
    const fvMap = new Map<string, Map<string, Map<string, number>>>() // posKey → (codigo → (fv → qty))
    const descMap = new Map<string, { descripcion: string; un: string; proveedor?: string }>()

    for (const m of movs) {
      if (m.codigoInc) continue // EXCLUIR INC
      const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const mCode = m.codigo.trim().toUpperCase()
      let codeMap = cellMap.get(posKey)
      if (!codeMap) { codeMap = new Map(); cellMap.set(posKey, codeMap) }
      const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
      const current = codeMap.get(mCode) ?? 0
      codeMap.set(mCode, current + delta)

      // Rastrear fechas de vencimiento para info FEFO (solo informativo)
      if (m.fVencimiento && ['ingreso', 'devolucion', 'traslado'].includes(m.tipo)) {
        let fvCodeMap = fvMap.get(posKey)
        if (!fvCodeMap) { fvCodeMap = new Map(); fvMap.set(posKey, fvCodeMap) }
        let fvQtyMap = fvCodeMap.get(mCode)
        if (!fvQtyMap) { fvQtyMap = new Map(); fvCodeMap.set(mCode, fvQtyMap) }
        fvQtyMap.set(m.fVencimiento, (fvQtyMap.get(m.fVencimiento) ?? 0) + m.cantidad)
      }

      if (!descMap.has(posKey)) {
        descMap.set(posKey, { descripcion: m.descripcion, un: m.un, proveedor: m.proveedor || undefined })
      }
    }

    // PASO 2: Filtrar por código seleccionado y construir resultado
    // En modo INC, buscamos movimientos con codigoInc (se calculan aparte)
    const result: {
      bloque: string; torre: string; piso: string; posicion: string
      stock: number; descripcion: string; un: string; proveedor?: string
      fVencimiento: string      // fecha más próxima (FEFO), solo informativo
      lotesInfo: string         // resumen de lotes, solo informativo
      codigoInc?: string
    }[] = []

    if (isIncMode) {
      // Modo INC: calcular stock de movimientos INC para este código
      const incCellMap = new Map<string, number>()
      for (const m of movs) {
        if (!m.codigoInc) continue
        const mCode = m.codigo.trim().toUpperCase()
        if (mCode !== code) continue
        const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
        incCellMap.set(posKey, (incCellMap.get(posKey) ?? 0) + delta)
        if (!descMap.has(posKey)) {
          descMap.set(posKey, { descripcion: m.descripcion, un: m.un, proveedor: m.proveedor || undefined })
        }
      }
      for (const [posKey, stock] of incCellMap) {
        if (stock <= 0) continue
        const desc = descMap.get(posKey)
        if (!desc) continue
        const [bloque, torre, piso, posicion] = posKey.split('-')
        result.push({
          bloque, torre, piso, posicion, stock,
          descripcion: desc.descripcion, un: desc.un, proveedor: desc.proveedor,
          fVencimiento: '', lotesInfo: '', codigoInc: code,
        })
      }
    } else {
      // Modo normal: filtrar celdas donde el código seleccionado tiene stock > 0
      for (const [posKey, codeMap] of cellMap) {
        const posStock = codeMap.get(code)
        if (!posStock || posStock <= 0) continue
        const desc = descMap.get(posKey)
        if (!desc) continue
        const [bloque, torre, piso, posicion] = posKey.split('-')

        // Info FEFO: fecha más próxima del código en esta posición
        const fvCodeMap = fvMap.get(posKey)?.get(code)
        let fVencimiento = ''
        let lotesInfo = ''
        if (fvCodeMap && fvCodeMap.size > 0) {
          const sorted = [...fvCodeMap.entries()].sort(([a], [b]) => a.localeCompare(b))
          fVencimiento = sorted[0][0] // fecha más próxima
          lotesInfo = sorted.map(([fv, qty]) => `${fv}: ${qty}`).join(' | ')
        }

        result.push({
          bloque, torre, piso, posicion, stock: posStock,
          descripcion: desc.descripcion, un: desc.un, proveedor: desc.proveedor,
          fVencimiento, lotesInfo, codigoInc: undefined,
        })
      }
    }

    return result.sort((a, b) => {
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

  // Server-side fetch: cuando cambia el código seleccionado, intentar
  // obtener datos server-side (sin límite de filas). Si falla, usar client-side.
  const [serverStock, setServerStock] = useState<typeof stock | null>(null)
  const [serverLoading, setServerLoading] = useState(false)

  useEffect(() => {
    if (!selectedCodigo) { setServerStock(null); return }
    const code = selectedCodigo.trim().toUpperCase()
    const isInc = stockFilter === 'inc'

    setServerLoading(true)
    fetchStockPorCodigoRPC(code, isInc)
      .then((rows) => {
        if (!mountedRef.current) return
        setServerLoading(false)
        if (rows === null) {
          // Server-side falló → usar client-side (stockData)
          setServerStock(null)
          return
        }
        // Convertir filas server-side al formato de stock
        const mapped = rows.map(r => ({
          bloque: r.bloque,
          torre: r.torre,
          piso: r.piso,
          posicion: r.posicion,
          stock: r.stock,
          descripcion: r.descripcion || '',
          un: r.un || '',
          proveedor: r.proveedor || undefined,
          fVencimiento: r.fVencimiento || '',
          lotesInfo: '', // Server-side no calcula lotesInfo por ahora
          codigoInc: r.codigoInc || undefined,
        }))
        // Ordenar por bloque, torre, piso, posición
        mapped.sort((a, b) => {
          const aB = parseInt(a.bloque, 10) || 0; const bB = parseInt(b.bloque, 10) || 0
          if (aB !== bB) return aB - bB
          const aT = parseInt(a.torre, 10) || 0; const bT = parseInt(b.torre, 10) || 0
          if (aT !== bT) return aT - bT
          const aP = parseInt(a.piso, 10) || 0; const bP = parseInt(b.piso, 10) || 0
          if (aP !== bP) return aP - bP
          const aPos = parseInt(a.posicion, 10) || 0; const bPos = parseInt(b.posicion, 10) || 0
          return aPos - bPos
        })
        setServerStock(mapped)
      })
      .catch(() => {
        if (mountedRef.current) { setServerLoading(false); setServerStock(null) }
      })
  }, [selectedCodigo, stockFilter])

  // useRef para evitar setStock en componentes desmontados
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // Stock final: server-side si disponible, si no client-side
  const displayStock = serverStock ?? stock

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
    fVencimiento?: string,
    codigoInc?: string
  ) {
    if (!confirm('¿Eliminar TODOS los movimientos de esta ubicación?')) return
    try {
      const next = await eliminarUbicacion(selectedCodigo, bloque, torre, piso, posicion, fVencimiento, codigoInc)
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
          {displayStock.length > 0 ? 'Stock por ubicación en RACKLY' : 'Sin stock en ubicaciones de RACKLY'}
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
      {displayStock.length > 0 ? (
        <>
        <div className="space-y-3">

          {/* ── Mobile: Card layout ── */}
          <div className="md:hidden space-y-2">
            {displayStock.map((s, i) => (
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
                        onClick={() => handleDelete(s.bloque, s.torre, s.piso, s.posicion, '', s.codigoInc)}
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
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${getBadgeClass(s.fVencimiento)}`} title={s.lotesInfo}>
                      {s.fVencimiento}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">Venc: —</span>
                  )}
                  {s.lotesInfo && s.lotesInfo.includes('|') && (
                    <span className="text-[9px] text-muted-foreground" title={s.lotesInfo}>
                      +{s.lotesInfo.split('|').length - 1} lotes
                    </span>
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
                {displayStock.map((s, i) => (
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
                        <Badge variant="outline" className={`font-semibold ${getBadgeClass(s.fVencimiento)}`} title={s.lotesInfo}>
                          {s.fVencimiento}
                          {s.lotesInfo && s.lotesInfo.includes('|') && (
                            <span className="ml-1 text-[9px] opacity-70">
                              (+{s.lotesInfo.split('|').length - 1})
                            </span>
                          )}
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
                          onClick={() => handleDelete(s.bloque, s.torre, s.piso, s.posicion, '', s.codigoInc)}
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
              Total stock: <span className="font-bold ml-1">{displayStock.reduce((sum, s) => sum + s.stock, 0)}</span>
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

    </div>
  )
}
