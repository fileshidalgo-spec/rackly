'use client'

import { useState, useEffect, useMemo } from 'react'
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
import { Loader2, Filter, X, ArrowDownToLine, ArrowUpFromLine, RotateCcw, ArrowLeftRight, BarChart3, Search } from 'lucide-react'

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
        return 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
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
    <div className="space-y-4">
      {/* ── Summary cards ── */}
      {!loading && movimientos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 flex items-center gap-3">
            <div className="rounded-md bg-slate-700 p-2">
              <BarChart3 className="h-4 w-4 text-slate-300" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Total</p>
              <p className="text-lg font-bold text-white">{conteos.total}</p>
            </div>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3 flex items-center gap-3">
            <div className="rounded-md bg-emerald-600/20 p-2">
              <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Ingresos</p>
              <p className="text-lg font-bold text-emerald-400">{conteos.ingreso}</p>
            </div>
          </div>
          <div className="rounded-lg border border-red-500/20 bg-red-950/20 p-3 flex items-center gap-3">
            <div className="rounded-md bg-red-600/20 p-2">
              <ArrowUpFromLine className="h-4 w-4 text-red-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Salidas</p>
              <p className="text-lg font-bold text-red-400">{conteos.salida}</p>
            </div>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-950/20 p-3 flex items-center gap-3">
            <div className="rounded-md bg-amber-600/20 p-2">
              <RotateCcw className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Devoluciones</p>
              <p className="text-lg font-bold text-amber-400">{conteos.devolucion}</p>
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-blue-950/20 p-3 flex items-center gap-3">
            <div className="rounded-md bg-blue-600/20 p-2">
              <ArrowLeftRight className="h-4 w-4 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Traslados</p>
              <p className="text-lg font-bold text-blue-400">{conteos.traslado}</p>
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
              className="pl-9 bg-slate-800 border-slate-700 text-white placeholder-slate-500 focus:ring-emerald-500/30 focus:border-emerald-500/50"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={showFilters ? 'secondary' : 'outline'}
              size="sm"
              className="gap-2 border-slate-700 text-slate-400 bg-slate-800 hover:bg-slate-700 hover:text-white"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="h-4 w-4" />
              Filtros
              {tieneFiltrosActivos && (
                <Badge className="ml-1 h-5 min-w-[20px] px-1.5 bg-sky-600 text-white border-0">
                  {(filtroTipo ? 1 : 0) + (filtroUsuario ? 1 : 0) + (filtroDesde ? 1 : 0) + (filtroHasta ? 1 : 0)}
                </Badge>
              )}
            </Button>

            {tieneFiltrosActivos && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-slate-400 hover:text-white hover:bg-slate-800"
                onClick={limpiarFiltros}
              >
                <X className="h-3 w-3" />
                Limpiar
              </Button>
            )}

            {tieneFiltrosActivos && (
              <span className="text-xs text-slate-500">
                {movimientosFiltrados.length} de {movimientos.length}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Filter panel ── */}
      {showFilters && !loading && movimientos.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 p-4 border border-slate-700 rounded-lg bg-slate-800/50">
          {/* Type filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400 font-medium">Tipo de movimiento</Label>
            <Select value={filtroTipo} onValueChange={(v) => setFiltroTipo(v === '__all__' ? '' : v)}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue placeholder="Todos los tipos" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="__all__" className="text-white focus:bg-slate-700">Todos los tipos</SelectItem>
                <SelectItem value="ingreso" className="text-emerald-400 focus:bg-slate-700">
                  <span className="flex items-center gap-2"><ArrowDownToLine className="h-3 w-3" /> Ingreso</span>
                </SelectItem>
                <SelectItem value="salida" className="text-red-400 focus:bg-slate-700">
                  <span className="flex items-center gap-2"><ArrowUpFromLine className="h-3 w-3" /> Salida</span>
                </SelectItem>
                <SelectItem value="devolucion" className="text-amber-400 focus:bg-slate-700">
                  <span className="flex items-center gap-2"><RotateCcw className="h-3 w-3" /> Devolución</span>
                </SelectItem>
                <SelectItem value="traslado" className="text-blue-400 focus:bg-slate-700">
                  <span className="flex items-center gap-2"><ArrowLeftRight className="h-3 w-3" /> Traslado</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* User filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400 font-medium">Usuario</Label>
            <Select value={filtroUsuario} onValueChange={(v) => setFiltroUsuario(v === '__all__' ? '' : v)}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue placeholder="Todos los usuarios" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="__all__" className="text-white focus:bg-slate-700">Todos los usuarios</SelectItem>
                {usuariosUnicos.map((u) => (
                  <SelectItem key={u} value={u} className="text-white focus:bg-slate-700">{u}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date from */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400 font-medium">Fecha desde</Label>
            <Input
              type="date"
              value={filtroDesde}
              onChange={(e) => setFiltroDesde(e.target.value)}
              className="bg-slate-800 border-slate-700 text-white focus:ring-emerald-500/30 focus:border-emerald-500/50 [color-scheme:dark]"
            />
          </div>

          {/* Date to */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400 font-medium">Fecha hasta</Label>
            <Input
              type="date"
              value={filtroHasta}
              onChange={(e) => setFiltroHasta(e.target.value)}
              className="bg-slate-800 border-slate-700 text-white focus:ring-emerald-500/30 focus:border-emerald-500/50 [color-scheme:dark]"
            />
          </div>
        </div>
      )}

      {/* ── Loading state ── */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          <p className="text-sm text-slate-500">Cargando movimientos...</p>
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && movimientos.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="rounded-full bg-slate-800 p-4 border border-slate-700">
            <BarChart3 className="h-8 w-8 text-slate-600" />
          </div>
          <p className="text-sm text-slate-500">No hay movimientos registrados</p>
        </div>
      )}

      {/* ── Filtered empty state ── */}
      {!loading && movimientos.length > 0 && movimientosFiltrados.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="rounded-full bg-slate-800 p-4 border border-slate-700">
            <Search className="h-8 w-8 text-slate-600" />
          </div>
          <p className="text-sm text-slate-500">No se encontraron movimientos con los filtros aplicados</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800"
            onClick={limpiarFiltros}
          >
            <X className="h-3 w-3" />
            Limpiar filtros
          </Button>
        </div>
      )}

      {/* ── Table ── */}
      {!loading && movimientosFiltrados.length > 0 && (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 border-b border-slate-700 hover:bg-slate-800 sticky top-0 z-10">
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase w-[80px]">N° Op</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase w-[160px]">Fecha</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase w-[120px]">Tipo</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase w-[70px]">Turno</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase">Detalles</TableHead>
                  <TableHead className="text-slate-400 font-semibold text-xs uppercase w-[160px]">Usuario</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movimientosFiltrados.map((m) => (
                  <TableRow
                    key={m.id}
                    className="border-b border-slate-700/50 hover:bg-slate-800/60 transition-colors"
                  >
                    <TableCell className="font-mono text-sm text-slate-200 font-medium">
                      #{m.numero_operacion}
                    </TableCell>
                    <TableCell className="text-sm text-slate-300">
                      {formatFecha(m.fecha)}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${getTipoBadge(m.tipo)} capitalize text-xs font-medium gap-1 border-0`}>
                        {getTipoIcon(m.tipo)}
                        {m.tipo}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-slate-300 text-center">
                      {m.turno}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {m.detalles.slice(0, 5).map((d, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 text-xs bg-slate-800 border border-slate-700 rounded-md px-2 py-0.5 text-slate-300"
                          >
                            <span className="text-slate-400">{d.bloque_codigo || '—'}</span>
                            <span className="text-emerald-400 font-medium">×{d.cantidad}</span>
                          </span>
                        ))}
                        {m.detalles.length > 5 && (
                          <span className="text-xs text-slate-500 self-center">
                            +{m.detalles.length - 5} más
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-300">
                      {m.usuario_nombre || (
                        <span className="text-slate-600">—</span>
                      )}
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
