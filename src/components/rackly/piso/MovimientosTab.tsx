'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { listarMovimientos, type Sector } from '@/lib/piso/api'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Loader2, Filter, X, ArrowDownToLine, ArrowUpFromLine, RotateCcw,
  ArrowLeftRight, BarChart3, Search, ChevronDown, Package,
  TrendingUp, Archive, Activity,
} from 'lucide-react'

// ═══════════════════════════════════════════════
//  ANIMATED COUNTER HOOK
// ═══════════════════════════════════════════════
function useAnimatedCounter(target: number, duration = 600) {
  const [count, setCount] = useState(0)
  const prevTarget = useRef(0)

  useEffect(() => {
    if (target === prevTarget.current) return
    const start = prevTarget.current
    const diff = target - start
    if (diff === 0) return
    const startTime = performance.now()
    let raf: number

    function tick(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCount(Math.round(start + diff * eased))
      if (progress < 1) {
        raf = requestAnimationFrame(tick)
      }
    }

    raf = requestAnimationFrame(tick)
    prevTarget.current = target
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return count
}

export function MovimientosTab() {
  const [movimientos, setMovimientos] = useState<
    {
      id: string
      numero_operacion: number
      tipo: string
      fecha: string
      turno: string
      usuario_id: string | null
      usuario_nombre: string | null
      usuario_correo: string | null
      detalles: { bloque_codigo?: string; cantidad: number; nivel_codigo?: string }[]
    }[]
  >([])
  const [loading, setLoading] = useState(true)
  const [showFilters, setShowFilters] = useState(false)
  const [filtroTipo, setFiltroTipo] = useState<string>('')
  const [filtroUsuario, setFiltroUsuario] = useState<string>('')
  const [filtroDesde, setFiltroDesde] = useState<string>('')
  const [filtroHasta, setFiltroHasta] = useState<string>('')
  const [filtroTexto, setFiltroTexto] = useState<string>('')

  // Load all movements on mount
  useEffect(() => {
    listarMovimientos()
      .then(setMovimientos)
      .catch(() => {
        setMovimientos([])
      })
      .finally(() => setLoading(false))
  }, [])

  // Extract unique users from loaded data
  const usuariosUnicos = useMemo(() => {
    return [...new Set(movimientos.map((m) => m.usuario_nombre).filter(Boolean))] as string[]
  }, [movimientos])

  // Filter movements
  const movimientosFiltrados = useMemo(() => {
    return movimientos.filter((m) => {
      if (filtroTipo && m.tipo !== filtroTipo) return false
      if (filtroUsuario && m.usuario_nombre !== filtroUsuario) return false

      if (filtroDesde) {
        const fechaMov = new Date(m.fecha)
        const desde = new Date(filtroDesde + 'T00:00:00')
        if (fechaMov < desde) return false
      }
      if (filtroHasta) {
        const fechaMov = new Date(m.fecha)
        const hasta = new Date(filtroHasta + 'T23:59:59')
        if (fechaMov > hasta) return false
      }

      if (filtroTexto.trim()) {
        const q = filtroTexto.trim().toLowerCase()
        const matchesOp = String(m.numero_operacion).includes(q)
        const matchesUser = (m.usuario_nombre ?? '').toLowerCase().includes(q)
        const matchesDetalle = m.detalles.some(
          (d) => (d.bloque_codigo ?? '').toLowerCase().includes(q) || String(d.cantidad).includes(q)
        )
        if (!matchesOp && !matchesUser && !matchesDetalle) return false
      }

      return true
    })
  }, [movimientos, filtroTipo, filtroUsuario, filtroDesde, filtroHasta, filtroTexto])

  // Summary counts
  const conteos = useMemo(() => {
    const total = movimientosFiltrados.length
    const ingreso = movimientosFiltrados.filter((m) => m.tipo === 'ingreso').length
    const salida = movimientosFiltrados.filter((m) => m.tipo === 'salida').length
    const devolucion = movimientosFiltrados.filter((m) => m.tipo === 'devolucion').length
    const traslado = movimientosFiltrados.filter((m) => m.tipo === 'traslado').length
    return { total, ingreso, salida, devolucion, traslado }
  }, [movimientosFiltrados])

  // Animated counters for stats
  const animTotal = useAnimatedCounter(conteos.total)
  const animIngreso = useAnimatedCounter(conteos.ingreso)
  const animSalida = useAnimatedCounter(conteos.salida)
  const animDevolucion = useAnimatedCounter(conteos.devolucion)
  const animTraslado = useAnimatedCounter(conteos.traslado)

  const tieneFiltrosActivos =
    filtroTipo !== '' || filtroUsuario !== '' || filtroDesde !== '' || filtroHasta !== '' || filtroTexto.trim() !== ''

  function limpiarFiltros() {
    setFiltroTipo('')
    setFiltroUsuario('')
    setFiltroDesde('')
    setFiltroHasta('')
    setFiltroTexto('')
  }

  function getTipoBadge(tipo: string): string {
    switch (tipo) {
      case 'ingreso':
        return 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
      case 'salida':
        return 'bg-red-600/20 text-red-400 border border-red-500/30'
      case 'devolucion':
        return 'bg-amber-600/20 text-amber-400 border border-amber-500/30'
      case 'traslado':
        return 'bg-cyan-600/20 text-cyan-400 border border-cyan-500/30'
      default:
        return 'bg-slate-700 text-slate-300 border border-slate-600'
    }
  }

  function getTipoIcon(tipo: string) {
    switch (tipo) {
      case 'ingreso':
        return <ArrowDownToLine className="h-3 w-3" />
      case 'salida':
        return <ArrowUpFromLine className="h-3 w-3" />
      case 'devolucion':
        return <RotateCcw className="h-3 w-3" />
      case 'traslado':
        return <ArrowLeftRight className="h-3 w-3" />
      default:
        return null
    }
  }

  function formatFecha(fecha: string): string {
    try {
      const d = new Date(fecha)
      return d.toLocaleDateString('es-PE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }) + ' ' + d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    } catch {
      return fecha
    }
  }

  return (
    <div className="space-y-5">
      {/* ── Summary cards — gradient borders + animated counters ── */}
      {!loading && movimientos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* Total */}
          <div className="group rounded-2xl p-[1px] bg-gradient-to-br from-slate-600/30 to-slate-700/15 shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300">
            <div className="rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 p-3.5 flex items-center gap-3">
              <div className="rounded-xl bg-slate-700/60 p-2.5 border border-slate-600/30">
                <BarChart3 className="h-4 w-4 text-slate-300" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Total</p>
                <p className="text-xl font-extrabold text-white tabular-nums">{animTotal}</p>
              </div>
            </div>
          </div>

          {/* Ingresos */}
          <div className="group rounded-2xl p-[1px] bg-gradient-to-br from-emerald-500/25 to-emerald-600/10 shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300">
            <div className="rounded-2xl bg-gradient-to-br from-emerald-950/40 to-slate-900 p-3.5 flex items-center gap-3">
              <div className="rounded-xl bg-emerald-600/20 p-2.5 border border-emerald-500/25">
                <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Ingresos</p>
                <p className="text-xl font-extrabold text-emerald-400 tabular-nums">{animIngreso}</p>
              </div>
            </div>
          </div>

          {/* Salidas */}
          <div className="group rounded-2xl p-[1px] bg-gradient-to-br from-red-500/25 to-red-600/10 shadow-lg hover:shadow-red-500/10 hover:-translate-y-0.5 transition-all duration-300">
            <div className="rounded-2xl bg-gradient-to-br from-red-950/40 to-slate-900 p-3.5 flex items-center gap-3">
              <div className="rounded-xl bg-red-600/20 p-2.5 border border-red-500/25">
                <ArrowUpFromLine className="h-4 w-4 text-red-400" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Salidas</p>
                <p className="text-xl font-extrabold text-red-400 tabular-nums">{animSalida}</p>
              </div>
            </div>
          </div>

          {/* Devoluciones */}
          <div className="group rounded-2xl p-[1px] bg-gradient-to-br from-amber-500/25 to-amber-600/10 shadow-lg hover:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-300">
            <div className="rounded-2xl bg-gradient-to-br from-amber-950/40 to-slate-900 p-3.5 flex items-center gap-3">
              <div className="rounded-xl bg-amber-600/20 p-2.5 border border-amber-500/25">
                <RotateCcw className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Devoluciones</p>
                <p className="text-xl font-extrabold text-amber-400 tabular-nums">{animDevolucion}</p>
              </div>
            </div>
          </div>

          {/* Traslados */}
          <div className="group rounded-2xl p-[1px] bg-gradient-to-br from-cyan-500/25 to-cyan-600/10 shadow-lg hover:shadow-cyan-500/10 hover:-translate-y-0.5 transition-all duration-300">
            <div className="rounded-2xl bg-gradient-to-br from-cyan-950/40 to-slate-900 p-3.5 flex items-center gap-3">
              <div className="rounded-xl bg-cyan-600/20 p-2.5 border border-cyan-500/25">
                <ArrowLeftRight className="h-4 w-4 text-cyan-400" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Traslados</p>
                <p className="text-xl font-extrabold text-cyan-400 tabular-nums">{animTraslado}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Toolbar: search + filters toggle ── */}
      {!loading && movimientos.length > 0 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {/* Search input */}
          <div className="relative flex-1 w-full max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <Input
              type="text"
              value={filtroTexto}
              onChange={(e) => setFiltroTexto(e.target.value)}
              placeholder="Buscar por N° Op, usuario, bloque..."
              className="pl-9 bg-slate-800/60 border-slate-700/50 text-white placeholder-slate-500 focus:ring-emerald-500/30 focus:border-emerald-500/50 rounded-xl backdrop-blur-sm transition-all duration-300"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={showFilters ? 'secondary' : 'outline'}
              size="sm"
              className={`gap-2 rounded-xl transition-all duration-300 ${showFilters ? 'bg-slate-700 text-white border-slate-600' : 'border-slate-700 text-slate-400 bg-slate-800/60 hover:bg-slate-700 hover:text-white hover:shadow-lg'}`}
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="h-4 w-4" />
              Filtros
              {tieneFiltrosActivos && (
                <Badge className="ml-1 h-5 min-w-[20px] px-1.5 bg-emerald-600 text-white border-0 rounded-lg">
                  {(filtroTipo ? 1 : 0) + (filtroUsuario ? 1 : 0) + (filtroDesde ? 1 : 0) + (filtroHasta ? 1 : 0)}
                </Badge>
              )}
              <ChevronDown className={`h-3 w-3 transition-transform duration-300 ${showFilters ? 'rotate-180' : ''}`} />
            </Button>

            {tieneFiltrosActivos && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all duration-300"
                onClick={limpiarFiltros}
              >
                <X className="h-3 w-3" />
                Limpiar
              </Button>
            )}

            {tieneFiltrosActivos && (
              <span className="text-xs text-slate-500 bg-slate-800/40 rounded-lg px-2.5 py-1 border border-slate-700/30">
                {movimientosFiltrados.length} de {movimientos.length}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Filter panel — collapsible with smooth animation ── */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 overflow-hidden transition-all duration-400 ease-out ${
          showFilters && !loading && movimientos.length > 0
            ? 'max-h-[300px] opacity-100 mt-0'
            : 'max-h-0 opacity-0 -mt-3'
        }`}
      >
        <div className="p-4 rounded-xl border border-slate-700/40 bg-slate-800/40 backdrop-blur-sm">
          {/* Type filter */}
          <div className="space-y-1.5">
            <Label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Tipo de movimiento</Label>
            <Select value={filtroTipo} onValueChange={(v) => setFiltroTipo(v === '__all__' ? '' : v)}>
              <SelectTrigger className="bg-slate-900/60 border-slate-700/50 text-white rounded-xl">
                <SelectValue placeholder="Todos los tipos" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700 rounded-xl">
                <SelectItem value="__all__" className="text-white focus:bg-slate-700 rounded-lg">Todos los tipos</SelectItem>
                <SelectItem value="ingreso" className="text-emerald-400 focus:bg-slate-700 rounded-lg">
                  <span className="flex items-center gap-2"><ArrowDownToLine className="h-3 w-3" /> Ingreso</span>
                </SelectItem>
                <SelectItem value="salida" className="text-red-400 focus:bg-slate-700 rounded-lg">
                  <span className="flex items-center gap-2"><ArrowUpFromLine className="h-3 w-3" /> Salida</span>
                </SelectItem>
                <SelectItem value="devolucion" className="text-amber-400 focus:bg-slate-700 rounded-lg">
                  <span className="flex items-center gap-2"><RotateCcw className="h-3 w-3" /> Devolución</span>
                </SelectItem>
                <SelectItem value="traslado" className="text-cyan-400 focus:bg-slate-700 rounded-lg">
                  <span className="flex items-center gap-2"><ArrowLeftRight className="h-3 w-3" /> Traslado</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-700/40 bg-slate-800/40 backdrop-blur-sm">
          {/* User filter */}
          <div className="space-y-1.5">
            <Label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Usuario</Label>
            <Select value={filtroUsuario} onValueChange={(v) => setFiltroUsuario(v === '__all__' ? '' : v)}>
              <SelectTrigger className="bg-slate-900/60 border-slate-700/50 text-white rounded-xl">
                <SelectValue placeholder="Todos los usuarios" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700 rounded-xl">
                <SelectItem value="__all__" className="text-white focus:bg-slate-700 rounded-lg">Todos los usuarios</SelectItem>
                {usuariosUnicos.map((u) => (
                  <SelectItem key={u} value={u} className="text-white focus:bg-slate-700 rounded-lg">{u}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-700/40 bg-slate-800/40 backdrop-blur-sm">
          {/* Date from */}
          <div className="space-y-1.5">
            <Label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Fecha desde</Label>
            <Input
              type="date"
              value={filtroDesde}
              onChange={(e) => setFiltroDesde(e.target.value)}
              className="bg-slate-900/60 border-slate-700/50 text-white focus:ring-emerald-500/30 focus:border-emerald-500/50 [color-scheme:dark] rounded-xl transition-all duration-300"
            />
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-700/40 bg-slate-800/40 backdrop-blur-sm">
          {/* Date to */}
          <div className="space-y-1.5">
            <Label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Fecha hasta</Label>
            <Input
              type="date"
              value={filtroHasta}
              onChange={(e) => setFiltroHasta(e.target.value)}
              className="bg-slate-900/60 border-slate-700/50 text-white focus:ring-emerald-500/30 focus:border-emerald-500/50 [color-scheme:dark] rounded-xl transition-all duration-300"
            />
          </div>
        </div>
      </div>

      {/* ── Loading state — animated ── */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="relative">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 animate-pulse flex items-center justify-center">
              <Activity className="h-8 w-8 text-white" />
            </div>
            <div className="absolute inset-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 animate-ping opacity-15" />
          </div>
          <p className="text-sm text-slate-400 animate-pulse font-medium">Cargando movimientos...</p>
        </div>
      )}

      {/* ── Empty state — animated icon ── */}
      {!loading && movimientos.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="relative">
            <div className="rounded-2xl bg-slate-800/60 p-5 border border-slate-700/30 animate-bounce">
              <Archive className="h-10 w-10 text-slate-600" />
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm text-slate-400 font-semibold">No hay movimientos registrados</p>
            <p className="text-xs text-slate-500 mt-1">Los movimientos apareceran aqui cuando se registren ingresos, salidas, traslados o devoluciones</p>
          </div>
        </div>
      )}

      {/* ── Filtered empty state — animated icon ── */}
      {!loading && movimientos.length > 0 && movimientosFiltrados.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <div className="relative">
            <div className="rounded-2xl bg-slate-800/60 p-5 border border-slate-700/30">
              <Search className="h-10 w-10 text-slate-600 animate-pulse" />
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm text-slate-400 font-semibold">No se encontraron movimientos</p>
            <p className="text-xs text-slate-500 mt-1">Intenta ajustar los filtros aplicados</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all duration-300 hover:shadow-lg"
            onClick={limpiarFiltros}
          >
            <X className="h-3 w-3" />
            Limpiar filtros
          </Button>
        </div>
      )}

      {/* ── Table — alternating row colors, modern badges ── */}
      {!loading && movimientosFiltrados.length > 0 && (
        <div className="rounded-2xl border border-slate-700/40 overflow-hidden shadow-xl shadow-black/10">
          <div className="max-h-[600px] overflow-y-auto custom-scrollbar">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800/90 border-b border-slate-700/50 hover:bg-slate-800/90 sticky top-0 z-10 backdrop-blur-sm">
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider w-[80px]">N° Op</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider w-[160px]">Fecha</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider w-[120px]">Tipo</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider w-[70px]">Turno</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider">Detalles</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider w-[160px]">Usuario</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movimientosFiltrados.map((m, idx) => (
                  <TableRow
                    key={m.id}
                    className={`border-b border-slate-700/30 hover:bg-slate-700/40 transition-all duration-300 hover:shadow-inner ${
                      idx % 2 === 0 ? 'bg-slate-800/20' : 'bg-slate-800/10'
                    }`}
                  >
                    <TableCell className="font-mono text-sm text-slate-200 font-medium">
                      <span className="bg-slate-700/40 rounded-lg px-2 py-0.5 text-xs">#{m.numero_operacion}</span>
                    </TableCell>
                    <TableCell className="text-xs text-slate-300">
                      {formatFecha(m.fecha)}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${getTipoBadge(m.tipo)} capitalize text-[10px] font-semibold gap-1 rounded-lg px-2 py-0.5 transition-all duration-300`}>
                        {getTipoIcon(m.tipo)}
                        {m.tipo}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-300 text-center">
                      <span className="bg-slate-700/30 rounded-lg px-2 py-0.5 text-[10px] font-medium">{m.turno}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {m.detalles.slice(0, 5).map((d, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 text-[10px] bg-slate-800/80 border border-slate-700/40 rounded-lg px-2 py-0.5 text-slate-300 backdrop-blur-sm transition-all duration-200 hover:border-slate-600/60"
                          >
                            <Package className="h-2.5 w-2.5 text-slate-500" />
                            <span className="text-slate-400 font-mono">{d.bloque_codigo || '—'}</span>
                            <span className="text-emerald-400 font-semibold">×{d.cantidad}</span>
                          </span>
                        ))}
                        {m.detalles.length > 5 && (
                          <span className="text-[10px] text-slate-500 self-center bg-slate-800/40 rounded-lg px-2 py-0.5">
                            +{m.detalles.length - 5} más
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-slate-300">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300 border border-slate-600/40">
                          {(m.usuario_nombre || '?')[0].toUpperCase()}
                        </div>
                        <span className="truncate">{m.usuario_nombre || <span className="text-slate-600">—</span>}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}
