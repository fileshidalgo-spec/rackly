'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  listarSectores,
  listarColumnas,
  listarSubcolumnas,
  listarNivelesDeSubcolumna,
  listarBloquesDeColumna,
  registrarMovimiento,
  calcularStockNivel,
  listarMovimientos,
  type Sector,
  type Columna,
  type Subcolumna,
  type MovimientoConDetalles,
} from '@/lib/piso/api'
import { calcularTurno as calcTurnoKardex } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
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
  Card,
  CardContent,
} from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Loader2,
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  FilterX,
  Search,
  TrendingUp,
  Package,
  Users,
  BarChart3,
  History,
  PlusCircle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react'

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function fmtFecha(fecha: string): string {
  const d = new Date(fecha)
  if (isNaN(d.getTime())) return fecha
  return d.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function tipoBadgeVariant(tipo: string) {
  if (tipo === 'ingreso') return 'default' as const
  if (tipo === 'stock_inicial') return 'secondary' as const
  return 'destructive' as const
}

function tipoBadgeLabel(tipo: string) {
  if (tipo === 'ingreso') return 'Ingreso'
  if (tipo === 'stock_inicial') return 'Stock Inicial'
  return 'Salida'
}

/* ═══════════════════════════════════════════
   COMPONENTE PRINCIPAL — VISTA UNIFICADA
   ═══════════════════════════════════════════ */

export function MovimientosTab() {
  const [allMovs, setAllMovs] = useState<MovimientoConDetalles[]>([])
  const [loading, setLoading] = useState(true)
  const [busyExport, setBusyExport] = useState(false)
  const [showDashboard, setShowDashboard] = useState(true)
  const [showRegistro, setShowRegistro] = useState(false)

  // Filtros
  const [filtroUsuario, setFiltroUsuario] = useState('')
  const [filtroCodigo, setFiltroCodigo] = useState('')
  const [filtroTipo, setFiltroTipo] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listarMovimientos()
      setAllMovs(data)
    } catch {
      toast.error('Error al cargar movimientos')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Usuarios y códigos únicos
  const usuariosUnicos = useMemo(() => {
    const set = new Set<string>()
    for (const m of allMovs) { if (m.usuario_nombre) set.add(m.usuario_nombre) }
    return [...set].sort()
  }, [allMovs])

  const codigosUnicos = useMemo(() => {
    const set = new Set<string>()
    for (const m of allMovs) { for (const d of m.detalles) { if (d.bloque_codigo) set.add(d.bloque_codigo) } }
    return [...set].sort()
  }, [allMovs])

  // Filtrados
  const movsFiltrados = useMemo(() => {
    let result = allMovs
    if (filtroUsuario) {
      const l = filtroUsuario.toLowerCase()
      result = result.filter((m) => m.usuario_nombre?.toLowerCase().includes(l))
    }
    if (filtroCodigo) {
      const u = filtroCodigo.toUpperCase()
      result = result.filter((m) => m.detalles.some((d) => d.bloque_codigo?.toUpperCase().includes(u)))
    }
    if (filtroTipo !== 'all') {
      result = result.filter((m) => m.tipo === filtroTipo)
    }
    return result
  }, [allMovs, filtroUsuario, filtroCodigo, filtroTipo])

  const tieneFiltros = filtroUsuario || filtroCodigo || filtroTipo !== 'all'

  function clearFiltros() { setFiltroUsuario(''); setFiltroCodigo(''); setFiltroTipo('all') }

  // ─── Dashboard ───
  const dashboard = useMemo(() => {
    const source = movsFiltrados
    const totalMovs = source.length
    const ingresos = source.filter((m) => m.tipo === 'ingreso' || m.tipo === 'stock_inicial').length
    const salidas = source.filter((m) => m.tipo === 'salida').length
    const totalUnidades = source.reduce((sum, m) => sum + m.detalles.reduce((s, d) => s + d.cantidad, 0), 0)
    const usuariosSet = new Set<string>()
    const codigosSet = new Set<string>()
    for (const m of source) { if (m.usuario_nombre) usuariosSet.add(m.usuario_nombre); for (const d of m.detalles) { if (d.bloque_codigo) codigosSet.add(d.bloque_codigo) } }

    const ultimos7: { fecha: string; ingresos: number; salidas: number }[] = []
    const hoy = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(hoy); d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const movsDia = source.filter((m) => m.fecha.slice(0, 10) === key)
      ultimos7.push({
        fecha: d.toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        ingresos: movsDia.filter((m) => m.tipo === 'ingreso' || m.tipo === 'stock_inicial').length,
        salidas: movsDia.filter((m) => m.tipo === 'salida').length,
      })
    }
    const maxBar = Math.max(...ultimos7.map((d) => Math.max(d.ingresos, d.salidas)), 1)

    const codigoVol = new Map<string, number>()
    for (const m of source) { for (const d of m.detalles) { if (d.bloque_codigo) { codigoVol.set(d.bloque_codigo, (codigoVol.get(d.bloque_codigo) || 0) + (m.tipo === 'salida' ? -d.cantidad : d.cantidad)) } } }
    const topCodigos = [...codigoVol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

    const usuarioOps = new Map<string, number>()
    for (const m of source) { if (m.usuario_nombre) usuarioOps.set(m.usuario_nombre, (usuarioOps.get(m.usuario_nombre) || 0) + 1) }
    const topUsuarios = [...usuarioOps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

    return { totalMovs, ingresos, salidas, totalUnidades, usuariosUniq: usuariosSet.size, codigosUniq: codigosSet.size, ultimos7, maxBar, topCodigos, topUsuarios }
  }, [movsFiltrados])

  // ─── Exportar Excel ───
  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')
      const rows = movsFiltrados.flatMap((m) =>
        m.detalles.map((d) => ({
          'N° Op.': m.numero_operacion,
          'Fecha': fmtFecha(m.fecha),
          'Tipo': tipoBadgeLabel(m.tipo),
          'Turno': m.turno,
          'Usuario': m.usuario_nombre || '',
          'Código': d.bloque_codigo || '',
          'Descripción': d.bloque_descripcion || '',
          'Cantidad': d.cantidad,
          'Nivel': d.nivel_codigo || '',
        }))
      )
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Movimientos Piso')
      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_Piso_Movimientos_${fecha}.xlsx`)
      toast.success(`${rows.length} movimientos exportados`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusyExport(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Cargando movimientos...</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">

      {/* ═══ DASHBOARD ═══ */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-bold text-foreground">Dashboard de Movimientos</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => load()} className="h-7 text-xs gap-1">
                <RefreshCw className="h-3 w-3" /> Actualizar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDashboard(!showDashboard)} className="h-7 text-xs gap-1">
                {showDashboard ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {showDashboard ? 'Ocultar' : 'Mostrar'}
              </Button>
            </div>
          </div>

          {showDashboard && (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {[
                  { icon: History, label: 'Total Ops', value: dashboard.totalMovs, color: 'text-blue-600', bg: 'bg-blue-50' },
                  { icon: ArrowDownToLine, label: 'Ingresos', value: dashboard.ingresos, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                  { icon: ArrowUpFromLine, label: 'Salidas', value: dashboard.salidas, color: 'text-red-500', bg: 'bg-red-50' },
                  { icon: Package, label: 'Códigos', value: dashboard.codigosUniq, color: 'text-violet-600', bg: 'bg-violet-50' },
                  { icon: Users, label: 'Usuarios', value: dashboard.usuariosUniq, color: 'text-amber-600', bg: 'bg-amber-50' },
                  { icon: TrendingUp, label: 'Unidades', value: dashboard.totalUnidades.toLocaleString(), color: 'text-indigo-600', bg: 'bg-indigo-50' },
                ].map((kpi, i) => (
                  <div key={i} className={`rounded-lg p-3 text-center ${kpi.bg}`}>
                    <kpi.icon className={`h-5 w-5 mx-auto mb-1 ${kpi.color}`} />
                    <p className={`text-xl font-bold leading-none ${kpi.color}`}>{kpi.value}</p>
                    <p className="text-[10px] mt-1 text-muted-foreground font-medium">{kpi.label}</p>
                  </div>
                ))}
              </div>

              {/* Gráficos lado a lado */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* Barras últimos 7 días */}
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-semibold mb-3 text-foreground">Actividad — Últimos 7 días</p>
                  <div className="flex items-end gap-1.5 h-28">
                    {dashboard.ultimos7.map((d, i) => (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                        <div className="w-full flex gap-0.5 items-end h-20">
                          <div className="flex-1 rounded-t transition-all bg-emerald-500" style={{ height: `${(d.ingresos / dashboard.maxBar) * 100}%`, minHeight: d.ingresos > 0 ? 2 : 0 }} title={`Ingresos: ${d.ingresos}`} />
                          <div className="flex-1 rounded-t transition-all bg-red-400" style={{ height: `${(d.salidas / dashboard.maxBar) * 100}%`, minHeight: d.salidas > 0 ? 2 : 0 }} title={`Salidas: ${d.salidas}`} />
                        </div>
                        <span className="text-[9px] leading-tight text-center text-muted-foreground">{d.fecha.split(',')[0]}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 mt-3 justify-center">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Ingresos
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="w-2.5 h-2.5 rounded-sm bg-red-400" /> Salidas
                    </span>
                  </div>
                </div>

                {/* Top 5 códigos + Top 5 usuarios */}
                <div className="space-y-3">
                  {dashboard.topCodigos.length > 0 && (
                    <div className="rounded-lg border p-4">
                      <p className="text-xs font-semibold mb-3 text-foreground">Top 5 códigos por volumen</p>
                      <div className="space-y-2">
                        {dashboard.topCodigos.map(([codigo, vol], i) => {
                          const maxVol = Math.max(Math.abs(dashboard.topCodigos[0][1]), 1)
                          const pct = Math.min((Math.abs(vol) / maxVol) * 100, 100)
                          return (
                            <div key={codigo} className="flex items-center gap-2">
                              <span className="text-xs w-4 text-right font-bold text-muted-foreground">{i + 1}</span>
                              <span className="font-mono text-sm w-20 shrink-0 font-semibold text-foreground">{codigo}</span>
                              <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full rounded-full ${vol >= 0 ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className={`text-xs w-16 text-right font-bold ${vol >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                {vol >= 0 ? '+' : ''}{vol.toLocaleString()}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {dashboard.topUsuarios.length > 0 && (
                    <div className="rounded-lg border p-4">
                      <p className="text-xs font-semibold mb-3 text-foreground">Top 5 usuarios por operaciones</p>
                      <div className="space-y-2">
                        {dashboard.topUsuarios.map(([nombre, ops], i) => {
                          const maxOps = Math.max(dashboard.topUsuarios[0][1], 1)
                          const pct = Math.min((ops / maxOps) * 100, 100)
                          return (
                            <div key={nombre} className="flex items-center gap-2">
                              <span className="text-xs w-4 text-right font-bold text-muted-foreground">{i + 1}</span>
                              <span className="text-sm w-24 shrink-0 truncate font-medium text-foreground">{nombre}</span>
                              <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                                <div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-xs w-10 text-right font-bold text-foreground">{ops}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ═══ FILTROS + EXPORTAR ═══ */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-bold text-foreground">Filtrar movimientos</span>
              {tieneFiltros && (
                <Badge variant="secondary" className="text-xs">
                  {movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tieneFiltros && (
                <Button variant="ghost" size="sm" onClick={clearFiltros} className="h-8 text-xs gap-1 text-muted-foreground hover:text-foreground">
                  <FilterX className="h-3.5 w-3.5" /> Limpiar
                </Button>
              )}
              <Button onClick={handleExport} disabled={busyExport || movsFiltrados.length === 0} size="sm" className="h-8 text-xs gap-2">
                {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Exportar Excel ({movsFiltrados.length})
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Usuario</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar usuario..."
                  value={filtroUsuario}
                  onChange={(e) => setFiltroUsuario(e.target.value)}
                  className="pl-8 h-9 text-sm"
                  list="piso-usuarios-list"
                />
                <datalist id="piso-usuarios-list">
                  {usuariosUnicos.map((u) => <option key={u} value={u} />)}
                </datalist>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Código</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar código..."
                  value={filtroCodigo}
                  onChange={(e) => setFiltroCodigo(e.target.value)}
                  className="pl-8 h-9 text-sm font-mono"
                  list="piso-codigos-list"
                />
                <datalist id="piso-codigos-list">
                  {codigosUnicos.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tipo de movimiento</Label>
              <Select value={filtroTipo} onValueChange={setFiltroTipo}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="ingreso">Ingreso</SelectItem>
                  <SelectItem value="stock_inicial">Stock Inicial</SelectItem>
                  <SelectItem value="salida">Salida</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ═══ TABLA DE MOVIMIENTOS ═══ */}
      {movsFiltrados.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="px-4 py-3 flex items-center justify-between border-b">
              <span className="text-sm font-semibold text-foreground">
                Historial de movimientos
                {tieneFiltros && <span className="text-muted-foreground"> — {movsFiltrados.length} de {allMovs.length}</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {movsFiltrados.length > 100 ? 'Primeros 100 — exporta todos con Excel' : `${movsFiltrados.length} registro(s)`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs font-semibold">N° Op</TableHead>
                    <TableHead className="text-xs font-semibold">Fecha</TableHead>
                    <TableHead className="text-xs font-semibold">Tipo</TableHead>
                    <TableHead className="text-xs font-semibold">Turno</TableHead>
                    <TableHead className="text-xs font-semibold">Código</TableHead>
                    <TableHead className="text-xs font-semibold">Descripción</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Cant.</TableHead>
                    <TableHead className="text-xs font-semibold hidden sm:table-cell">Nivel</TableHead>
                    <TableHead className="text-xs font-semibold">Usuario</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movsFiltrados.slice(0, 100).map((m) => (
                    m.detalles.map((d, dIdx) => (
                      <TableRow key={`${m.id}-${dIdx}`} className={dIdx > 0 ? 'border-t border-dashed' : ''}>
                        {dIdx === 0 && (
                          <>
                            <TableCell rowSpan={m.detalles.length} className="font-mono text-sm font-medium align-top">
                              {m.numero_operacion}
                            </TableCell>
                            <TableCell rowSpan={m.detalles.length} className="text-sm text-muted-foreground align-top whitespace-nowrap">
                              {fmtFecha(m.fecha)}
                            </TableCell>
                            <TableCell rowSpan={m.detalles.length} className="align-top">
                              <Badge variant={tipoBadgeVariant(m.tipo)} className="text-xs">
                                {tipoBadgeLabel(m.tipo)}
                              </Badge>
                            </TableCell>
                            <TableCell rowSpan={m.detalles.length} className="text-sm align-top">
                              {m.turno}
                            </TableCell>
                          </>
                        )}
                        <TableCell className="font-mono text-sm font-semibold text-blue-700">
                          {d.bloque_codigo || '—'}
                        </TableCell>
                        <TableCell className="text-sm text-foreground max-w-[200px] truncate" title={d.bloque_descripcion || ''}>
                          {d.bloque_descripcion || '—'}
                        </TableCell>
                        <TableCell className="text-sm font-semibold text-right">
                          {d.cantidad}
                        </TableCell>
                        {dIdx === 0 && (
                          <TableCell rowSpan={m.detalles.length} className="hidden sm:table-cell align-top">
                            <span className="text-xs font-mono text-muted-foreground">
                              {m.detalles.slice(0, 3).map((det) => det.nivel_codigo || '').filter(Boolean).join(', ')}
                              {m.detalles.length > 3 && '...'}
                            </span>
                          </TableCell>
                        )}
                        {dIdx === 0 && (
                          <TableCell rowSpan={m.detalles.length} className="text-sm align-top whitespace-nowrap">
                            {m.usuario_nombre || '—'}
                          </TableCell>
                        )}
                      </TableRow>
                    ))
                  ))}
                </TableBody>
              </Table>
            </div>
            {movsFiltrados.length > 100 && (
              <div className="px-4 py-2 text-center border-t">
                <p className="text-xs text-muted-foreground">Mostrando los primeros 100 de {movsFiltrados.length} movimientos. Exporta todos con el botón de Excel.</p>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Search className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {tieneFiltros ? 'No se encontraron movimientos con los filtros aplicados' : allMovs.length === 0 ? 'No hay movimientos registrados' : 'Todos los movimientos están disponibles'}
            </p>
            {tieneFiltros && (
              <Button variant="link" size="sm" onClick={clearFiltros} className="text-xs">
                Limpiar filtros
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ═══ REGISTRAR MOVIMIENTO ═══ */}
      <Card>
        <button
          onClick={() => setShowRegistro(!showRegistro)}
          className="w-full flex items-center justify-between p-4 transition-colors hover:bg-muted/50 rounded-lg"
        >
          <div className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5 text-emerald-600" />
            <span className="text-sm font-bold text-foreground">Registrar movimiento</span>
          </div>
          {showRegistro ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {showRegistro && (
          <div className="px-4 pb-4">
            <RegistroMovimiento onRegistered={load} />
          </div>
        )}
      </Card>
    </div>
  )
}

/* ═══════════════════════════════════════════
   REGISTRO DE MOVIMIENTO (Ingreso / Salida)
   ═══════════════════════════════════════════ */

function RegistroMovimiento({ onRegistered }: { onRegistered: () => void }) {
  const [modo, setModo] = useState<'ingreso' | 'salida'>('ingreso')

  return (
    <div className="space-y-4">
      {/* Selector Ingreso / Salida */}
      <div className="flex gap-2">
        <Button
          variant={modo === 'ingreso' ? 'default' : 'outline'}
          onClick={() => setModo('ingreso')}
          className={modo === 'ingreso' ? 'bg-emerald-600 hover:bg-emerald-700 gap-2' : 'gap-2'}
        >
          <ArrowDownToLine className="h-4 w-4" /> Ingreso
        </Button>
        <Button
          variant={modo === 'salida' ? 'default' : 'outline'}
          onClick={() => setModo('salida')}
          className={modo === 'salida' ? 'bg-red-600 hover:bg-red-700 gap-2' : 'gap-2'}
        >
          <ArrowUpFromLine className="h-4 w-4" /> Salida
        </Button>
      </div>

      {modo === 'ingreso' ? (
        <IngresoForm onRegistered={onRegistered} />
      ) : (
        <SalidaForm onRegistered={onRegistered} />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════
   FORMULARIO INGRESO
   ═══════════════════════════════════════════ */

function IngresoForm({ onRegistered }: { onRegistered: () => void }) {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [columnaId, setColumnaId] = useState('')
  const [subcolumnas, setSubcolumnas] = useState<Subcolumna[]>([])
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set())
  const [bloqueId, setBloqueId] = useState('')
  const [bloques, setBloques] = useState<{ id: string; codigo: string }[]>([])
  const [cantidad, setCantidad] = useState('')
  const [busy, setBusy] = useState(false)
  const [gridData, setGridData] = useState<{
    posicion: { numero: number }
    niveles: { id: string; numero: number; codigo_ubicacion: string | null }[]
  }[]>([])

  useEffect(() => { listarSectores().then(setSectores).catch(() => {}) }, [])
  useEffect(() => { if (!sectorId) return; listarColumnas(sectorId).then(setColumnas).catch(() => {}) }, [sectorId])
  useEffect(() => {
    if (!columnaId) return
    listarSubcolumnas(columnaId).then(setSubcolumnas).catch(() => {})
    listarBloquesDeColumna(columnaId).then(setBloques).catch(() => {})
  }, [columnaId])
  useEffect(() => {
    if (subcolumnas.length === 0) { setGridData([]); return }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id))).then((results) => setGridData(results.flat())).catch(() => {})
  }, [subcolumnas])

  function toggleLevel(nivelId: string) {
    setSelectedLevels((prev) => { const next = new Set(prev); if (next.has(nivelId)) next.delete(nivelId); else next.add(nivelId); return next })
  }

  async function handleIngreso() {
    if (!bloqueId || selectedLevels.size === 0 || !cantidad || !perfil) { toast.error('Selecciona bloque, niveles y cantidad'); return }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels).map((nivelId) => ({ nivel_id: nivelId, bloque_id: bloqueId, cantidad: qty }))
      await registrarMovimiento('ingreso', calcTurnoKardex(), detalles)
      toast.success(`Ingreso registrado en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Set()); setCantidad('')
      onRegistered()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar', { description: message })
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sector</Label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>{sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Columna</Label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>{columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bloque</Label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>{bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cantidad</Label>
          <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="0" className="h-9 text-sm" />
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Selecciona niveles (clic en celdas). Seleccionados: <span className="font-bold text-foreground">{selectedLevels.size}</span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg border p-3 bg-muted/30">
                <p className="text-xs font-bold mb-2 text-foreground">{sc.codigo}</p>
                {gridData.slice(scIdx, scIdx + 1).map((g, gi) => (
                  <div key={gi} className="flex flex-wrap gap-1 mb-1">
                    <span className="text-xs w-6 font-medium text-muted-foreground">P{g.posicion.numero}</span>
                    {g.niveles.map((n) => (
                      <button key={n.id} type="button" className="w-9 h-9 rounded-md text-xs font-bold transition-all border-2"
                        style={{
                          background: selectedLevels.has(n.id) ? '#059669' : 'white',
                          color: selectedLevels.has(n.id) ? 'white' : '#334155',
                          borderColor: selectedLevels.has(n.id) ? '#047857' : '#e2e8f0',
                          boxShadow: selectedLevels.has(n.id) ? '0 0 0 3px #05966933' : 'none',
                        }}
                        onClick={() => toggleLevel(n.id)} title={n.codigo_ubicacion || `Nivel ${n.numero}`}>
                        {n.numero}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={handleIngreso} disabled={busy || selectedLevels.size === 0 || !cantidad || !bloqueId} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
        Registrar ingreso ({selectedLevels.size} nivel{selectedLevels.size !== 1 ? 'es' : ''})
      </Button>
    </div>
  )
}

/* ═══════════════════════════════════════════
   FORMULARIO SALIDA
   ═══════════════════════════════════════════ */

function SalidaForm({ onRegistered }: { onRegistered: () => void }) {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [columnaId, setColumnaId] = useState('')
  const [subcolumnas, setSubcolumnas] = useState<Subcolumna[]>([])
  const [bloqueId, setBloqueId] = useState('')
  const [bloques, setBloques] = useState<{ id: string; codigo: string }[]>([])
  const [selectedLevels, setSelectedLevels] = useState<Map<string, number>>(new Map())
  const [busy, setBusy] = useState(false)
  const [gridData, setGridData] = useState<{
    posicion: { numero: number }
    niveles: { id: string; numero: number; codigo_ubicacion: string | null }[]
  }[]>([])
  const [stockData, setStockData] = useState<Map<string, { bloque_codigo: string; cantidad: number }[]>>(new Map())

  useEffect(() => { listarSectores().then(setSectores).catch(() => {}) }, [])
  useEffect(() => { if (!sectorId) return; listarColumnas(sectorId).then(setColumnas).catch(() => {}) }, [sectorId])
  useEffect(() => {
    if (!columnaId) return
    Promise.all([listarSubcolumnas(columnaId), listarBloquesDeColumna(columnaId)]).then(([subs, blqs]) => { setSubcolumnas(subs); setBloques(blqs) }).catch(() => {})
  }, [columnaId])
  useEffect(() => {
    if (subcolumnas.length === 0) { setGridData([]); return }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id))).then((results) => {
      setGridData(results.flat())
      const allNiveles = results.flat().flatMap((r) => r.niveles)
      allNiveles.forEach((n) => { calcularStockNivel(n.id).then((stock) => setStockData((prev) => new Map(prev).set(n.id, stock))).catch(() => {}) })
    }).catch(() => {})
  }, [subcolumnas])

  function toggleLevel(nivelId: string, availableQty: number) {
    setSelectedLevels((prev) => { const next = new Map(prev); if (next.has(nivelId)) next.delete(nivelId); else next.set(nivelId, availableQty); return next })
  }

  async function handleSalida() {
    if (!bloqueId || selectedLevels.size === 0 || !perfil) { toast.error('Selecciona bloque y niveles'); return }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels.entries()).map(([nivelId, cantidad]) => ({ nivel_id: nivelId, bloque_id: bloqueId, cantidad }))
      await registrarMovimiento('salida', calcTurnoKardex(), detalles)
      toast.success(`Salida registrada en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Map())
      onRegistered()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar', { description: message })
    } finally { setBusy(false) }
  }

  const bloqueCodigo = bloques.find((b) => b.id === bloqueId)?.codigo || ''

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sector</Label>
          <Select value={sectorId} onValueChange={setSectorId}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>{sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Columna</Label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>{columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bloque</Label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>{bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Selecciona niveles con stock. Seleccionados: <span className="font-bold text-foreground">{selectedLevels.size}</span>
            {bloqueCodigo && <span> — Bloque: <span className="font-mono font-bold text-foreground">{bloqueCodigo}</span></span>}
          </p>
          <div className="grid gap-2">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg border p-3 bg-muted/30">
                <p className="text-xs font-bold mb-2 text-foreground">{sc.codigo}</p>
                <div className="flex flex-wrap gap-1">
                  {gridData.slice(scIdx, scIdx + 1).flatMap((g) =>
                    g.niveles.map((n) => {
                      const stock = stockData.get(n.id) || []
                      const blockStock = stock.find((s) => s.bloque_codigo === bloqueCodigo)
                      const qty = blockStock?.cantidad || 0
                      const hasStock = qty > 0
                      const isSelected = selectedLevels.has(n.id)
                      return (
                        <button key={n.id} type="button" disabled={!hasStock} className="w-11 h-11 rounded-md text-xs font-bold transition-all border-2"
                          style={{
                            background: isSelected ? '#dc2626' : hasStock ? 'white' : '#f1f5f9',
                            color: isSelected ? 'white' : hasStock ? '#334155' : '#94a3b8',
                            borderColor: isSelected ? '#b91c1c' : hasStock ? '#e2e8f0' : '#e2e8f0',
                            boxShadow: isSelected ? '0 0 0 3px #dc262633' : 'none',
                            cursor: hasStock ? 'pointer' : 'not-allowed',
                            opacity: hasStock ? 1 : 0.5,
                          }}
                          onClick={() => hasStock && toggleLevel(n.id, qty)} title={`N${n.numero} - Stock: ${qty}`}>
                          <div>{n.numero}</div><div className="text-[10px]">{qty}</div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={handleSalida} disabled={busy || selectedLevels.size === 0 || !bloqueId} className="gap-2 bg-red-600 hover:bg-red-700">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        Registrar salida ({selectedLevels.size} nivel{selectedLevels.size !== 1 ? 'es' : ''})
      </Button>
    </div>
  )
}
