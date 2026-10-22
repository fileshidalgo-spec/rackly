'use client'

/**
 * FEFO PISO — Control de vencimientos (pestaña que faltaba en el módulo Piso).
 *
 * Lista los lotes REALES restantes por ubicación con el mismo algoritmo dirigido
 * + desborde FEFO que el detalle de Sectores (lotesRestantesPorBloque dentro de
 * stockPisoGlobal): lo más PRÓXIMO A VENCER primero, sin fecha al final.
 * Incluye: chips por estado (vencido/≤15/≤30/vigente/sin fecha), búsqueda,
 * filtro por sector, export XLSX y auto-refresh en tiempo real.
 *
 * Nota de rendimiento: se carga UNA vez al abrir la pestaña (a demanda) y con los
 * eventos realtime; NO se recarga en cada tecleo (la búsqueda filtra en cliente
 * sobre datos ya cargados, igual que FefoTab en Racks).
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { stockPisoGlobal, type StockPisoItem } from '@/lib/piso/api'
import { targetDesdeStockItem, type PisoTargetPosicion } from '@/lib/piso/navegacion'
import { loadTabState, saveTabState } from '@/lib/rackly/tab-state'
import { hoyISO } from '@/lib/rackly/formato'
import { usePisoRealtime } from '@/hooks/usePisoRealtime'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  Search, Download, Loader2, CalendarDays, AlertTriangle, PackageSearch, RefreshCw, MapPin, Layers, ExternalLink,
} from 'lucide-react'

type FefoStatus = 'vigente' | 'proximo' | 'urgente' | 'vencido' | 'sin_fecha'

type FefoPisoItem = StockPisoItem & {
  diasRestantes: number
  status: FefoStatus
}

// ── Paleta oscura (consistente con las demás pestañas de Piso) ──
const STATUS_BADGE: Record<FefoStatus, string> = {
  vigente: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',
  proximo: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  urgente: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
  vencido: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  sin_fecha: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700',
}
const STATUS_CHIP_ACTIVE: Record<FefoStatus, string> = {
  vigente: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300',
  proximo: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300',
  urgente: 'bg-amber-500/20 border-amber-500/50 text-amber-300',
  vencido: 'bg-red-500/20 border-red-500/50 text-red-300',
  sin_fecha: 'bg-slate-500/20 border-slate-500/50 text-slate-300',
}
const STATUS_CHIP_DOT: Record<FefoStatus, string> = {
  vigente: 'bg-emerald-500',
  proximo: 'bg-cyan-500',
  urgente: 'bg-amber-500',
  vencido: 'bg-red-500',
  sin_fecha: 'bg-slate-400',
}
const STATUS_LABEL: Record<FefoStatus, string> = {
  vigente: 'Vigente',
  proximo: '≤ 30 días',
  urgente: '≤ 15 días',
  vencido: 'Vencido',
  sin_fecha: 'Sin fecha',
}
const DIAS_COLOR: Record<FefoStatus, string> = {
  vigente: 'text-emerald-300',
  proximo: 'text-cyan-300',
  urgente: 'text-amber-300',
  vencido: 'text-red-300',
  sin_fecha: 'text-slate-500',
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fmtQty = (n: number) => (n % 1 === 0 ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 3 }))

function statusDe(fv: string): { status: FefoStatus; dias: number } {
  if (!fv) return { status: 'sin_fecha', dias: -1 }
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const dias = Math.round((new Date(fv + 'T00:00:00').getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24))
  return { status: dias < 0 ? 'vencido' : dias <= 15 ? 'urgente' : dias <= 30 ? 'proximo' : 'vigente', dias }
}

export function FefoPisoTab({ onGotoPosicion }: { onGotoPosicion?: (target: PisoTargetPosicion) => void }) {
  // Estado persistido (inicializador lazy): al volver desde Sectores (botón de
  // retorno) la búsqueda y los filtros quedan como estaban — "seguir buscando".
  const [items, setItems] = useState<FefoPisoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState(() => loadTabState('piso.fefo', { search: '', sector: '', filtros: { vigente: true, proximo: true, urgente: true, vencido: true, sin_fecha: true } }).search)
  const [sector, setSector] = useState(() => loadTabState('piso.fefo', { search: '', sector: '', filtros: { vigente: true, proximo: true, urgente: true, vencido: true, sin_fecha: true } }).sector)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [filtros, setFiltros] = useState<Record<FefoStatus, boolean>>(() => {
    const base = { vigente: true, proximo: true, urgente: true, vencido: true, sin_fecha: true }
    const f = loadTabState('piso.fefo', { search: '', sector: '', filtros: base }).filtros
    return typeof f === 'object' && f !== null ? { ...base, ...f } : base
  })
  const [exportBusy, setExportBusy] = useState(false)
  const loadedRef = useRef(false)
  const lastLoadRef = useRef(0)
  const mountedRef = useRef(true)
  // FIX auditoría 2026-10-21 (P2): debounce con TRAILING EDGE — el anti-
  // martilleo anterior saltaba eventos sin reprogramar refresco, así que la
  // ÚLTIMA actualización de una ráfaga realtime podía perderse para siempre
  // (con WebSocket activo el polling no corre). También: guard de secuencia
  // para que una carga lenta no pise datos frescos de otra más rápida.
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadSeqRef = useRef(0)

  async function load(silent = false) {
    if (silent && Date.now() - lastLoadRef.current < 3000) {
      // Ventana anti-martilleo: programar recarga al FINAL de la ventana
      // (trailing edge) en vez de saltar el evento — nunca se pierde la última.
      if (!loadTimerRef.current) {
        loadTimerRef.current = setTimeout(() => {
          loadTimerRef.current = null
          if (mountedRef.current) load(true)
        }, 3300)
      }
      return
    }
    const seq = ++loadSeqRef.current
    if (!silent) setLoading(true)
    setError(false)
    try {
      const data = await stockPisoGlobal()
      if (seq !== loadSeqRef.current || !mountedRef.current) return // llegó una carga más reciente
      lastLoadRef.current = Date.now()
      setItems(data.map((i) => {
        const { status, dias } = statusDe(i.fecha_vencimiento)
        return { ...i, diasRestantes: dias, status }
      }))
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[FefoPisoTab] Error cargando stock:', err)
      if (seq === loadSeqRef.current && mountedRef.current) setError(true)
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    if (!loadedRef.current) { loadedRef.current = true; load() }
    return () => {
      mountedRef.current = false
      if (loadTimerRef.current) { clearTimeout(loadTimerRef.current); loadTimerRef.current = null }
    }
  }, [])

  // Persistir búsqueda + filtros (se restauran al volver desde Sectores)
  useEffect(() => {
    saveTabState('piso.fefo', { search, sector, filtros })
  }, [search, sector, filtros])

  // Realtime: si otro usuario mueve mercadería, los lotes FEFO se refrescan solos
  usePisoRealtime(() => { if (loadedRef.current) load(true) })

  // Sectores presentes en los datos (para el filtro)
  const sectoresDisponibles = useMemo(
    () => [...new Set(items.map((i) => i.sector_nombre).filter(Boolean))].sort(),
    [items]
  )

  const hasActiveFilters = useMemo(
    () => search.trim() !== '' || sector !== '' || Object.values(filtros).some((v) => !v),
    [search, sector, filtros]
  )

  const filtered = useMemo(() => {
    let data = items
    const q = search.trim().toUpperCase()
    if (q) {
      data = data.filter((i) =>
        i.bloque_codigo.toUpperCase().includes(q) ||
        i.bloque_descripcion.toUpperCase().includes(q) ||
        (i.codigo_inc && i.codigo_inc.toUpperCase().includes(q)))
    }
    if (sector) data = data.filter((i) => i.sector_nombre === sector)
    // ORDEN FEFO REAL: vencidos primero → ≤15 → ≤30 → vigente; sin fecha al final.
    // stockPisoGlobal agrupa por código (para la búsqueda); esta pestaña promete
    // "lo más próximo a vencer primero", así que re-ordena por días restantes.
    return data
      .filter((i) => filtros[i.status] !== false)
      .sort((a, b) => {
        if (a.status === 'sin_fecha' && b.status !== 'sin_fecha') return 1
        if (a.status !== 'sin_fecha' && b.status === 'sin_fecha') return -1
        if (a.diasRestantes !== b.diasRestantes) return a.diasRestantes - b.diasRestantes
        if (a.bloque_codigo !== b.bloque_codigo) return a.bloque_codigo.localeCompare(b.bloque_codigo)
        return a.ubicacion.localeCompare(b.ubicacion)
      })
  }, [items, search, sector, filtros])

  const counts = useMemo(() => {
    const c = { vigente: 0, proximo: 0, urgente: 0, vencido: 0, sin_fecha: 0 } as Record<FefoStatus, number>
    for (const i of items) c[i.status]++
    return c
  }, [items])

  const totalStock = useMemo(() => round3(filtered.reduce((s, i) => s + i.cantidad, 0)), [filtered])

  function clearFilters() {
    setSearch('')
    setSector('')
    setFiltros({ vigente: true, proximo: true, urgente: true, vencido: true, sin_fecha: true })
  }

  async function handleExport() {
    setExportBusy(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((i) => ({
        'Código': i.bloque_codigo,
        'Descripción': i.bloque_descripcion,
        'Sector': i.sector_nombre,
        'Ubicación': i.ubicacion,
        'UN': i.bloque_unidad,
        'Stock': i.cantidad,
        'F. Vencimiento': i.fecha_vencimiento || 'S/F',
        'Días restantes': i.status === 'sin_fecha' ? '' : i.diasRestantes,
        'Estado': STATUS_LABEL[i.status],
        'INC': i.codigo_inc || '',
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'FEFO Piso')
      XLSX.writeFile(wb, `RACKLY_FEFO_PISO_${hoyISO()}.xlsx`)
      toast.success('FEFO Piso exportado')
    } catch (err: unknown) {
      toast.error('Error al exportar', { description: err instanceof Error ? err.message : 'Error' })
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* ═══ BÚSQUEDA + SECTOR + EXPORTAR ═══ */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por código, descripción o INC..."
            className="pl-9 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
          />
        </div>
        <div className="relative sm:w-44">
          <Layers className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="w-full h-9 pl-9 pr-2 rounded-md bg-slate-800 border border-slate-700 text-xs text-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">Todos los sectores</option>
            {sectoresDisponibles.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <Button onClick={() => load()} disabled={loading} variant="outline"
          className="h-9 gap-2 border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="hidden sm:inline">Actualizar</span>
        </Button>
        <Button onClick={handleExport} disabled={exportBusy || filtered.length === 0} variant="outline"
          className="h-9 gap-2 border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white">
          {exportBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar
        </Button>
      </div>

      {/* ═══ CHIPS POR ESTADO ═══ */}
      <div className="flex flex-wrap gap-2">
        {(['vencido', 'urgente', 'proximo', 'vigente', 'sin_fecha'] as const).map((key) => {
          const active = filtros[key]
          return (
            <button key={key} type="button"
              onClick={() => setFiltros((f) => ({ ...f, [key]: !f[key] }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                active
                  ? STATUS_CHIP_ACTIVE[key]
                  : 'bg-slate-800/60 border-slate-700/40 text-slate-500 hover:text-slate-300'
              }`}>
              <span className={`w-2.5 h-2.5 rounded-full ${active ? STATUS_CHIP_DOT[key] : 'bg-slate-600'}`} />
              {STATUS_LABEL[key]}
              <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-black/20 text-slate-300">
                {counts[key]}
              </span>
            </button>
          )
        })}
        {hasActiveFilters && (
          <button onClick={clearFilters}
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-all">
            Limpiar filtros
          </button>
        )}
      </div>

      {/* ═══ RESUMEN ═══ */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {filtered.length} lote{filtered.length !== 1 ? 's' : ''} · ordenado por vencimiento (lo más próximo a vencer primero)
          {lastRefresh && <span className="ml-2 text-slate-500">· Actualizado: {lastRefresh.toLocaleTimeString()}</span>}
        </span>
        <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-slate-600 text-slate-300">
          Total: <span className="font-bold ml-1">{fmtQty(totalStock)}</span>
        </Badge>
      </div>

      {/* ═══ ERROR ═══ */}
      {error && !loading && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-950/50 border border-red-800 text-red-300">
          <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
          <p className="text-sm">No se pudo cargar el stock FEFO. Verifica tu conexión e intenta de nuevo.</p>
        </div>
      )}

      {/* ═══ LOADING ═══ */}
      {loading && items.length === 0 && (
        <div className="flex items-center justify-center py-12 gap-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Calculando lotes FEFO...</span>
        </div>
      )}

      {/* ═══ VACÍO ═══ */}
      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
          <PackageSearch className="h-8 w-8" />
          <span className="text-sm">
            {items.length === 0
              ? 'Sin stock en Piso — los lotes aparecerán al registrar ingresos'
              : hasActiveFilters ? 'Sin resultados para los filtros aplicados' : 'Sin lotes'}
          </span>
        </div>
      )}

      {/* ═══ RESULTADOS ═══ */}
      {filtered.length > 0 && (
        <>
          {/* ── Móvil: tarjetas ── */}
          <div className="md:hidden space-y-2">
            {filtered.map((item, i) => (
              <div key={`${item.bloque_codigo}-${item.ubicacion}-${item.fecha_vencimiento}-${i}`}
                className="rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-xs text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded">{item.bloque_codigo}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${STATUS_BADGE[item.status]}`}>
                    {item.status === 'sin_fecha' ? 'S/F' : `${item.diasRestantes}d`}
                  </Badge>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight truncate">{item.bloque_descripcion}</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(() => {
                    const target = onGotoPosicion ? targetDesdeStockItem(item) : null
                    return target ? (
                      <button
                        type="button"
                        onClick={() => onGotoPosicion?.(target)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/60 text-[9px] font-mono font-semibold text-violet-300 transition-colors cursor-pointer active:scale-95"
                        title="Ir a la posición en Sectores para realizar movimientos"
                      >
                        <MapPin className="h-2.5 w-2.5 text-violet-400" />{item.ubicacion}
                        <ExternalLink className="h-2 w-2 text-violet-400" />
                      </button>
                    ) : (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 border-slate-600 text-slate-300">
                        <MapPin className="h-2.5 w-2.5 mr-0.5" />{item.ubicacion}
                      </Badge>
                    )
                  })()}
                  {item.sector_nombre && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 border-slate-600 text-slate-500">{item.sector_nombre}</Badge>
                  )}
                  {item.codigo_inc && (
                    <Badge className="bg-rose-500/15 text-rose-400 border border-rose-500/30 text-[9px] font-semibold gap-0.5 px-1 py-0">
                      <AlertTriangle className="h-2 w-2" /> {item.codigo_inc}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  {item.fecha_vencimiento ? (
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${STATUS_BADGE[item.status]}`}>
                      {item.fecha_vencimiento}
                    </Badge>
                  ) : (
                    <span className="text-[10px] text-slate-500">Sin fecha de vencimiento</span>
                  )}
                  <span className="text-xs font-bold text-white">
                    {fmtQty(item.cantidad)} <span className="text-slate-500">{item.bloque_unidad}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop: tabla ── */}
          <div className="hidden md:block overflow-x-auto max-h-[620px] overflow-y-auto rounded-lg border border-slate-700">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-slate-800/95 backdrop-blur">
                <TableRow className="hover:bg-slate-800 border-slate-700">
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Código</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase hidden lg:table-cell">Descripción</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Sector</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Ubicación</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Vencimiento</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase text-right">Días</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase text-right">Stock</TableHead>
                  <TableHead className="text-xs font-semibold text-slate-300 uppercase">Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item, i) => (
                  <TableRow key={`${item.bloque_codigo}-${item.ubicacion}-${item.fecha_vencimiento}-${i}`}
                    className="border-slate-700/50 hover:bg-slate-700/30">
                    <TableCell className="font-mono font-semibold text-indigo-400 text-xs">
                      {item.bloque_codigo}
                      {item.codigo_inc && (
                        <Badge className="ml-1.5 bg-rose-500/15 text-rose-400 border border-rose-500/30 text-[9px] font-semibold px-1 py-0">
                          <AlertTriangle className="h-2 w-2 mr-0.5" />{item.codigo_inc}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-slate-400 max-w-[220px] truncate" title={item.bloque_descripcion}>
                      {item.bloque_descripcion || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-slate-400 whitespace-nowrap">{item.sector_nombre || '—'}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {(() => {
                        const target = onGotoPosicion ? targetDesdeStockItem(item) : null
                        return target ? (
                          <button
                            type="button"
                            onClick={() => onGotoPosicion?.(target)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/60 text-xs font-mono font-semibold text-violet-300 transition-colors cursor-pointer active:scale-95 whitespace-nowrap"
                            title="Ir a la posición en Sectores para realizar movimientos"
                          >
                            <MapPin className="h-3 w-3 text-violet-400" />{item.ubicacion}
                            <ExternalLink className="h-2.5 w-2.5 text-violet-400" />
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-200">
                            <MapPin className="h-3 w-3 text-slate-500" />{item.ubicacion}
                          </span>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {item.fecha_vencimiento ? (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${STATUS_BADGE[item.status]}`}>
                          {item.fecha_vencimiento}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-500">S/F</span>
                      )}
                    </TableCell>
                    <TableCell className={`text-right text-xs font-bold ${DIAS_COLOR[item.status]}`}>
                      {item.status === 'sin_fecha' ? '—' : item.diasRestantes}
                    </TableCell>
                    <TableCell className="text-right text-xs font-bold text-white">
                      {fmtQty(item.cantidad)} <span className="text-[10px] font-medium text-slate-500">{item.bloque_unidad}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${STATUS_BADGE[item.status]}`}>
                        {STATUS_LABEL[item.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Leyenda */}
      <p className="text-[10px] text-slate-600 flex items-center gap-1.5">
        <CalendarDays className="h-3 w-3" />
        Lotes reales por ubicación (salida dirigida al lote elegido + desborde FEFO). Vencido &lt; ≤15 &lt; ≤30 &lt; Vigente; sin fecha al final.
      </p>
    </div>
  )
}
