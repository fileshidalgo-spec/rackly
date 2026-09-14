'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  type Movimiento,
  eliminarUbicacion,
  fetchStockPorCodigoRPC,
  calcularLotesRemanentes,
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
import { Search, Trash2, PackageSearch, Warehouse, ArrowRight, AlertTriangle, MapPin, ExternalLink } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

export function StockTab({ onGotoUbicacion }: { onGotoUbicacion?: (bloque: string, torre: string, piso: string, posicion: string) => void }) {
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

  // Info FEFO por posición (fecha + lotes) calculada con el MISMO algoritmo que
  // Ocupación y la pestaña FEFO: lotes remanentes (salida dirigida al lote elegido
  // + desborde FEFO). Así la fecha mostrada en Stock es la del PRIMER LOTE REAL
  // disponible, no una fecha histórica de un lote ya agotado.
  const remInfoByPos = useMemo(() => {
    const info = new Map<string, { fVencimiento: string; lotesInfo: string }>()
    if (!selectedCodigo) return info
    const code = selectedCodigo.trim().toUpperCase()
    const isIncMode = stockFilter === 'inc'
    const ENTRADAS = ['ingreso', 'devolucion', 'traslado', 'stock_inicial']
    const fmtInfo = (rem: { venc: string; cantidad: number }[]) => ({
      fVencimiento: rem[0]?.venc || '',
      lotesInfo: rem.map(l => `${l.venc || 'S/F'}: ${Math.round(l.cantidad * 1000) / 1000}`).join(' | '),
    })

    if (isIncMode) {
      // INC: pools por (posición + codigoInc); salidas dirigidas dentro de su INC;
      // remanentes combinados por posición para el desglose informativo.
      type Pool = { ing: Map<string, number>; sal: Array<{ venc: string; qty: number; ts: string; id: string }> }
      const pools = new Map<string, Pool>()
      for (const m of movs) {
        if (!m.codigoInc) continue
        if (m.codigo.trim().toUpperCase() !== code) continue
        const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const key = `${posKey}||${m.codigoInc}`
        let p = pools.get(key)
        if (!p) { p = { ing: new Map(), sal: [] }; pools.set(key, p) }
        const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
        if (!(qty > 0)) continue
        const venc = m.fVencimiento || ''
        if (ENTRADAS.includes(m.tipo)) p.ing.set(venc, (p.ing.get(venc) ?? 0) + qty)
        else p.sal.push({ venc, qty, ts: m.fModificacion, id: m.id })
      }
      const merged = new Map<string, Map<string, number>>() // posKey → (venc → qty)
      for (const [key, p] of pools) {
        const posKey = key.split('||')[0]
        const sal = p.sal.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
        const rem = calcularLotesRemanentes(p.ing, sal)
        let mm = merged.get(posKey)
        if (!mm) { mm = new Map(); merged.set(posKey, mm) }
        for (const l of rem) mm.set(l.venc, (mm.get(l.venc) ?? 0) + l.cantidad)
      }
      for (const [posKey, mm] of merged) {
        const rem = [...mm.entries()].map(([venc, cantidad]) => ({ venc, cantidad }))
        rem.sort((a, b) => {
          if (a.venc && b.venc) return a.venc.localeCompare(b.venc)
          if (a.venc && !b.venc) return -1
          if (!a.venc && b.venc) return 1
          return 0
        })
        info.set(posKey, fmtInfo(rem))
      }
    } else {
      const ing = new Map<string, Map<string, number>>() // posKey → (fv → qty)
      const sal = new Map<string, Array<{ venc: string; qty: number; ts: string; id: string }>>()
      for (const m of movs) {
        if (m.codigoInc) continue
        if (m.codigo.trim().toUpperCase() !== code) continue
        const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
        if (!(qty > 0)) continue
        const venc = m.fVencimiento || ''
        if (ENTRADAS.includes(m.tipo)) {
          const pool = ing.get(posKey) ?? new Map<string, number>()
          pool.set(venc, (pool.get(venc) ?? 0) + qty)
          ing.set(posKey, pool)
        } else {
          const list = sal.get(posKey) ?? []
          list.push({ venc, qty, ts: m.fModificacion, id: m.id })
          sal.set(posKey, list)
        }
      }
      for (const [posKey, pool] of ing) {
        const s = (sal.get(posKey) ?? []).sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
        const rem = calcularLotesRemanentes(pool, s)
        if (rem.length === 0) continue
        info.set(posKey, fmtInfo(rem))
      }
    }
    return info
  }, [selectedCodigo, movs, stockFilter])

  // Calcular stock por ubicación para el código seleccionado.
  // LÓGICA IDÉNTICA a calcularOcupacion() en OcupacionTab:
  //   - Agrupa por posición + código
  //   - Excluye INC
  //   - Suma delta (ingreso/devolucion/traslado = +, salida = -)
  //   - Ignora f_vencimiento para el cálculo de stock
  // Luego filtra por el código seleccionado y agrega info FEFO (lotes remanentes,
  // misma fuente que Ocupación y pestaña FEFO) como datos extras.
  const stockData = useMemo(() => {
    if (!selectedCodigo || movs.length === 0) return []
    const code = selectedCodigo.trim().toUpperCase()
    const isIncMode = stockFilter === 'inc'

    // PASO 1: Calcular stock neto por (posición, código) — IDÉNTICO a calcularOcupacion
    const cellMap = new Map<string, Map<string, number>>() // posKey → (codigo → stock)
    const descMap = new Map<string, { descripcion: string; un: string; proveedor?: string }>()

    for (const m of movs) {
      if (m.codigoInc) continue // EXCLUIR INC
      const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const mCode = m.codigo.trim().toUpperCase()
      let codeMap = cellMap.get(posKey)
      if (!codeMap) { codeMap = new Map(); cellMap.set(posKey, codeMap) }
      const delta = ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(m.tipo) ? m.cantidad : -m.cantidad
      // Redondeo a 3 decimales (precisión BD) para evitar residuos binarios que
      // se muestran como stock fantasma (ej. 12.000000000000002) o filas con ~0.
      const current = codeMap.get(mCode) ?? 0
      codeMap.set(mCode, Math.round((current + delta) * 1000) / 1000)

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
        const delta = ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(m.tipo) ? m.cantidad : -m.cantidad
        incCellMap.set(posKey, Math.round(((incCellMap.get(posKey) ?? 0) + delta) * 1000) / 1000)
        if (!descMap.has(posKey)) {
          descMap.set(posKey, { descripcion: m.descripcion, un: m.un, proveedor: m.proveedor || undefined })
        }
      }
      for (const [posKey, stock] of incCellMap) {
        if (stock <= 0) continue
        const desc = descMap.get(posKey)
        if (!desc) continue
        const [bloque, torre, piso, posicion] = posKey.split('-')
        const remInfo = remInfoByPos.get(posKey)
        result.push({
          bloque, torre, piso, posicion, stock,
          descripcion: desc.descripcion, un: desc.un, proveedor: desc.proveedor,
          fVencimiento: remInfo?.fVencimiento ?? '', lotesInfo: remInfo?.lotesInfo ?? '', codigoInc: code,
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

        // Info FEFO: lotes remanentes (mismo algoritmo que Ocupación y pestaña FEFO)
        const remInfo = remInfoByPos.get(posKey)
        const fVencimiento = remInfo?.fVencimiento ?? ''
        const lotesInfo = remInfo?.lotesInfo ?? ''

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
  }, [selectedCodigo, movs, stockFilter, remInfoByPos])

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
        // Enriquecer con la info FEFO de lotes remanentes (misma fuente que
        // Ocupación y pestaña FEFO) para que las 3 pestañas muestren lo mismo
        for (const row of mapped) {
          const key = `${row.bloque}-${row.torre}-${row.piso}-${row.posicion}`
          const remInfo = remInfoByPos.get(key)
          if (remInfo) {
            row.fVencimiento = remInfo.fVencimiento || row.fVencimiento || ''
            row.lotesInfo = remInfo.lotesInfo || ''
          }
        }
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
  }, [selectedCodigo, stockFilter, remInfoByPos])

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
          {displayStock.length > 0 ? 'Stock por ubicación en RACKLY · toca la ubicación para ir a Ocupación' : 'Sin stock en ubicaciones de RACKLY'}
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
                  <button
                    type="button"
                    onClick={() => onGotoUbicacion?.(s.bloque, s.torre, s.piso, s.posicion)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-300 bg-violet-50 hover:bg-violet-100 hover:border-violet-500 text-[10px] font-mono font-semibold text-violet-700 transition-colors cursor-pointer shadow-sm hover:shadow-md dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                    title="Ir a Ocupación"
                  >
                    <MapPin className="h-3 w-3 text-violet-500" />
                    {s.bloque}-{s.torre}-{s.piso}-{s.posicion}
                    <ExternalLink className="h-2.5 w-2.5 text-violet-400" />
                  </button>
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
                  ) : s.lotesInfo ? (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-semibold bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700" title={s.lotesInfo}>
                      S/F
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
                    <TableCell onClick={() => onGotoUbicacion?.(s.bloque, s.torre, s.piso, s.posicion)} className="font-mono font-medium whitespace-nowrap cursor-pointer hover:text-violet-700 dark:hover:text-violet-300 transition-colors" title="Ir a Ocupación">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-violet-500" />
                        {s.bloque}
                      </span>
                    </TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(s.bloque, s.torre, s.piso, s.posicion)} className="whitespace-nowrap cursor-pointer hover:text-violet-700 transition-colors">{s.torre}</TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(s.bloque, s.torre, s.piso, s.posicion)} className="font-medium whitespace-nowrap cursor-pointer hover:text-violet-700 transition-colors">{s.piso}</TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(s.bloque, s.torre, s.piso, s.posicion)} className="whitespace-nowrap cursor-pointer hover:text-violet-700 transition-colors">{s.posicion}</TableCell>
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
                      ) : s.lotesInfo ? (
                        <Badge variant="outline" className="font-semibold bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700" title={s.lotesInfo}>
                          S/F
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
              Total stock: <span className="font-bold ml-1">{Math.round(displayStock.reduce((sum, s) => sum + s.stock, 0) * 1000) / 1000}</span>
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
