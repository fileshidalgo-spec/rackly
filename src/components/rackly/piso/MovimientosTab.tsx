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

const C = {
  bgDeep: '#0a0a2e',
  bgCard: '#10103a',
  bgElevated: '#1a1a4e',
  borderBlue: '#303060',
  textWhite: '#f0f0f0',
  textLight: '#80c0ff',
  textMuted: '#8090c0',
  textDark: '#5060a0',
  occupied: '#0060f0',
  occupiedLight: '#2090f0',
  multi: '#f09000',
  multiLight: '#ffc040',
  emptyLight: '#40c090',
  destructive: '#b91c1c',
  success: '#00884a',
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function fmtFecha(fecha: string): string {
  const d = new Date(fecha)
  if (isNaN(d.getTime())) return fecha
  return d.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function tipoBadge(tipo: string) {
  if (tipo === 'ingreso' || tipo === 'stock_inicial') {
    return { label: tipo === 'ingreso' ? 'Ingreso' : 'Stock Inicial', bg: `${C.success}22`, color: C.emptyLight, border: `${C.success}44` }
  }
  return { label: 'Salida', bg: `${C.destructive}22`, color: C.multiLight, border: `${C.destructive}44` }
}

/* ═══════════════════════════════════════════
   COMPONENTE PRINCIPAL — VISTA UNIFICADA
   ═══════════════════════════════════════════ */

export function MovimientosTab() {
  const { perfil } = useAuth()

  // ─── Historial ───
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

    // Top usuarios
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
      const rows = movsFiltrados.map((m) => {
        const bloques = m.detalles.map((d) => `${d.bloque_codigo || '?'}:${d.cantidad}`).join(' | ')
        const niveles = m.detalles.map((d) => d.nivel_codigo || '').filter(Boolean).join(' | ')
        return {
          'N° Op.': m.numero_operacion,
          'Fecha': fmtFecha(m.fecha),
          'Tipo': m.tipo,
          'Turno': m.turno,
          'Usuario': m.usuario_nombre || '',
          'Bloques (cant)': bloques,
          'Niveles': niveles,
          'Total Cant.': m.detalles.reduce((s, d) => s + d.cantidad, 0),
        }
      })
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
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: C.textLight }} />
        <p className="text-sm" style={{ color: C.textMuted }}>Cargando movimientos...</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">

      {/* ═══ DASHBOARD ═══ */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: `linear-gradient(135deg, ${C.bgElevated}, ${C.bgDeep})`, border: `1px solid ${C.borderBlue}` }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" style={{ color: C.textLight }} />
            <span className="text-sm font-bold" style={{ color: C.textLight }}>Dashboard de Movimientos</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => load()} className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors" style={{ color: C.textLight, background: `${C.borderBlue}44` }} title="Recargar datos">
              <RefreshCw className="h-3 w-3" /> Actualizar
            </button>
            <button onClick={() => setShowDashboard(!showDashboard)} className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors" style={{ color: C.textLight, background: `${C.borderBlue}44` }}>
              {showDashboard ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showDashboard ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
        </div>

        {showDashboard && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {[
                { icon: History, label: 'Total Ops', value: dashboard.totalMovs, color: C.textLight },
                { icon: ArrowDownToLine, label: 'Ingresos', value: dashboard.ingresos, color: C.emptyLight },
                { icon: ArrowUpFromLine, label: 'Salidas', value: dashboard.salidas, color: C.multiLight },
                { icon: Package, label: 'Códigos', value: dashboard.codigosUniq, color: C.occupiedLight },
                { icon: Users, label: 'Usuarios', value: dashboard.usuariosUniq, color: C.textMuted },
                { icon: TrendingUp, label: 'Unidades', value: dashboard.totalUnidades.toLocaleString(), color: C.textWhite },
              ].map((kpi, i) => (
                <div key={i} className="rounded-lg p-3 text-center" style={{ background: `${C.bgDeep}88`, border: `1px solid ${C.borderBlue}44` }}>
                  <kpi.icon className="h-5 w-5 mx-auto mb-1.5" style={{ color: kpi.color }} />
                  <p className="text-xl font-bold leading-none" style={{ color: kpi.color }}>{kpi.value}</p>
                  <p className="text-[10px] mt-1" style={{ color: C.textDark }}>{kpi.label}</p>
                </div>
              ))}
            </div>

            {/* Gráficos lado a lado */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Barras últimos 7 días */}
              <div className="rounded-lg p-3" style={{ background: `${C.bgDeep}88`, border: `1px solid ${C.borderBlue}44` }}>
                <p className="text-xs font-semibold mb-3" style={{ color: C.textMuted }}>Actividad — Últimos 7 días</p>
                <div className="flex items-end gap-1.5 h-28">
                  {dashboard.ultimos7.map((d, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                      <div className="w-full flex gap-0.5 items-end h-20">
                        <div className="flex-1 rounded-t transition-all" style={{ background: C.success, height: `${(d.ingresos / dashboard.maxBar) * 100}%`, minHeight: d.ingresos > 0 ? 2 : 0 }} title={`Ingresos: ${d.ingresos}`} />
                        <div className="flex-1 rounded-t transition-all" style={{ background: C.destructive, height: `${(d.salidas / dashboard.maxBar) * 100}%`, minHeight: d.salidas > 0 ? 2 : 0 }} title={`Salidas: ${d.salidas}`} />
                      </div>
                      <span className="text-[8px] leading-tight text-center" style={{ color: C.textDark }}>{d.fecha.split(',')[0]}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4 mt-2 justify-center">
                  <span className="flex items-center gap-1 text-[10px]" style={{ color: C.textDark }}>
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C.success }} /> Ingresos
                  </span>
                  <span className="flex items-center gap-1 text-[10px]" style={{ color: C.textDark }}>
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C.destructive }} /> Salidas
                  </span>
                </div>
              </div>

              {/* Top 5 códigos + Top 5 usuarios */}
              <div className="space-y-3">
                {dashboard.topCodigos.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: `${C.bgDeep}88`, border: `1px solid ${C.borderBlue}44` }}>
                    <p className="text-xs font-semibold mb-2" style={{ color: C.textMuted }}>Top 5 códigos por volumen</p>
                    <div className="space-y-1.5">
                      {dashboard.topCodigos.map(([codigo, vol], i) => {
                        const maxVol = Math.max(Math.abs(dashboard.topCodigos[0][1]), 1)
                        const pct = Math.min((Math.abs(vol) / maxVol) * 100, 100)
                        return (
                          <div key={codigo} className="flex items-center gap-2">
                            <span className="text-[10px] w-4 text-right font-bold" style={{ color: C.textDark }}>{i + 1}</span>
                            <span className="font-mono text-xs w-16 shrink-0" style={{ color: C.textLight }}>{codigo}</span>
                            <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: `${C.borderBlue}44` }}>
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: vol >= 0 ? C.occupied : C.multi }} />
                            </div>
                            <span className="text-[10px] w-16 text-right font-bold" style={{ color: vol >= 0 ? C.emptyLight : C.multiLight }}>
                              {vol >= 0 ? '+' : ''}{vol.toLocaleString()}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {dashboard.topUsuarios.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: `${C.bgDeep}88`, border: `1px solid ${C.borderBlue}44` }}>
                    <p className="text-xs font-semibold mb-2" style={{ color: C.textMuted }}>Top 5 usuarios por operaciones</p>
                    <div className="space-y-1.5">
                      {dashboard.topUsuarios.map(([nombre, ops], i) => {
                        const maxOps = Math.max(dashboard.topUsuarios[0][1], 1)
                        const pct = Math.min((ops / maxOps) * 100, 100)
                        return (
                          <div key={nombre} className="flex items-center gap-2">
                            <span className="text-[10px] w-4 text-right font-bold" style={{ color: C.textDark }}>{i + 1}</span>
                            <span className="text-xs w-20 shrink-0 truncate" style={{ color: C.textLight }}>{nombre}</span>
                            <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: `${C.borderBlue}44` }}>
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: C.occupiedLight }} />
                            </div>
                            <span className="text-[10px] w-10 text-right font-bold" style={{ color: C.textLight }}>{ops}</span>
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
      </div>

      {/* ═══ FILTROS + EXPORTAR ═══ */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: C.bgElevated, border: `1px solid ${C.borderBlue}` }}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4" style={{ color: C.textLight }} />
            <span className="text-sm font-bold" style={{ color: C.textLight }}>Filtrar movimientos</span>
            {tieneFiltros && (
              <Badge className="text-[10px]" style={{ background: C.occupied, color: C.textWhite }}>
                {movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {tieneFiltros && (
              <button onClick={clearFiltros} className="flex items-center gap-1 text-xs transition-colors hover:opacity-80" style={{ color: C.multiLight }}>
                <FilterX className="h-3 w-3" /> Limpiar
              </button>
            )}
            <Button onClick={handleExport} disabled={busyExport || movsFiltrados.length === 0} variant="outline" className="gap-2 h-8 text-xs" style={{ borderColor: C.success, color: C.emptyLight }}>
              {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Exportar Excel ({movsFiltrados.length})
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Usuario</Label>
            <Input
              placeholder="Buscar usuario..."
              value={filtroUsuario}
              onChange={(e) => setFiltroUsuario(e.target.value)}
              className="h-9 text-xs"
              style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
              list="piso-usuarios-list"
            />
            <datalist id="piso-usuarios-list">
              {usuariosUnicos.map((u) => <option key={u} value={u} />)}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Código</Label>
            <Input
              placeholder="Buscar código..."
              value={filtroCodigo}
              onChange={(e) => setFiltroCodigo(e.target.value)}
              className="h-9 text-xs font-mono"
              style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
              list="piso-codigos-list"
            />
            <datalist id="piso-codigos-list">
              {codigosUnicos.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Tipo de movimiento</Label>
            <Select value={filtroTipo} onValueChange={setFiltroTipo}>
              <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
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
      </div>

      {/* ═══ TABLA DE MOVIMIENTOS ═══ */}
      {movsFiltrados.length > 0 ? (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.borderBlue}` }}>
          <div className="p-3 flex items-center justify-between" style={{ background: C.bgElevated }}>
            <span className="text-xs font-semibold" style={{ color: C.textMuted }}>
              Historial de movimientos
              {tieneFiltros && <span style={{ color: C.textLight }}> — {movsFiltrados.length} de {allMovs.length}</span>}
            </span>
            <span className="text-[10px]" style={{ color: C.textDark }}>
              {movsFiltrados.length > 100 ? 'Primeros 100 mostrados — exporta todos con Excel' : `${movsFiltrados.length} registro(s)`}
            </span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow style={{ background: C.bgElevated }}>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>N° Op</TableHead>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>Fecha</TableHead>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>Tipo</TableHead>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>Turno</TableHead>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>Bloques (cant)</TableHead>
                  <TableHead className="text-xs hidden sm:table-cell" style={{ color: C.textLight }}>Niveles</TableHead>
                  <TableHead className="text-xs" style={{ color: C.textLight }}>Usuario</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movsFiltrados.slice(0, 100).map((m) => {
                  const badge = tipoBadge(m.tipo)
                  return (
                    <TableRow key={m.id} style={{ borderBottom: `1px solid ${C.borderBlue}44` }}>
                      <TableCell className="font-mono text-xs" style={{ color: C.textWhite }}>{m.numero_operacion}</TableCell>
                      <TableCell className="text-xs" style={{ color: C.textMuted }}>{fmtFecha(m.fecha)}</TableCell>
                      <TableCell>
                        <Badge style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }} className="text-[10px]">
                          {badge.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs" style={{ color: C.textMuted }}>{m.turno}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {m.detalles.slice(0, 4).map((d, i) => (
                            <span key={i} className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: `${C.borderBlue}44`, color: C.textLight }}>
                              {d.bloque_codigo}:{d.cantidad}
                            </span>
                          ))}
                          {m.detalles.length > 4 && <span className="text-[10px] self-center" style={{ color: C.textDark }}>+{m.detalles.length - 4}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="text-[10px] font-mono" style={{ color: C.textDark }}>
                          {m.detalles.slice(0, 2).map((d) => d.nivel_codigo || '').filter(Boolean).join(', ')}
                          {m.detalles.length > 2 && '...'}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs" style={{ color: C.textMuted }}>{m.usuario_nombre || '—'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          {movsFiltrados.length > 100 && (
            <div className="p-2 text-center" style={{ background: C.bgElevated }}>
              <p className="text-xs" style={{ color: C.textDark }}>Mostrando los primeros 100 de {movsFiltrados.length} movimientos. Exporta todos con el boton de Excel.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-10 space-y-2 rounded-xl" style={{ background: C.bgElevated, border: `1px solid ${C.borderBlue}44` }}>
          <Search className="h-8 w-8 mx-auto" style={{ color: C.textDark }} />
          <p className="text-sm" style={{ color: C.textMuted }}>
            {tieneFiltros ? 'No se encontraron movimientos con los filtros aplicados' : allMovs.length === 0 ? 'No hay movimientos registrados' : 'Todos los movimientos están disponibles'}
          </p>
          {tieneFiltros && (
            <button onClick={clearFiltros} className="text-xs underline" style={{ color: C.textLight }}>
              Limpiar filtros
            </button>
          )}
        </div>
      )}

      {/* ═══ REGISTRAR MOVIMIENTO ═══ */}
      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.borderBlue}` }}>
        <button
          onClick={() => setShowRegistro(!showRegistro)}
          className="w-full flex items-center justify-between p-4 transition-colors"
          style={{ background: C.bgElevated }}
        >
          <div className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5" style={{ color: C.emptyLight }} />
            <span className="text-sm font-bold" style={{ color: C.textLight }}>Registrar movimiento</span>
          </div>
          {showRegistro ? <ChevronUp className="h-4 w-4" style={{ color: C.textDark }} /> : <ChevronDown className="h-4 w-4" style={{ color: C.textDark }} />}
        </button>

        {showRegistro && (
          <div className="p-4 space-y-4" style={{ background: `${C.bgElevated}88` }}>
            <RegistroMovimiento onRegistered={load} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   REGISTRO DE MOVIMIENTO (Ingreso / Salida)
   ═══════════════════════════════════════════ */

function RegistroMovimiento({ onRegistered }: { onRegistered: () => void }) {
  const { perfil } = useAuth()
  const [modo, setModo] = useState<'ingreso' | 'salida'>('ingreso')

  return (
    <div className="space-y-4">
      {/* Selector Ingreso / Salida */}
      <div className="flex gap-2">
        <button
          onClick={() => setModo('ingreso')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
          style={{
            background: modo === 'ingreso' ? C.success : `${C.borderBlue}44`,
            color: C.textWhite,
            border: `1px solid ${modo === 'ingreso' ? C.success : C.borderBlue}`,
          }}
        >
          <ArrowDownToLine className="h-4 w-4" /> Ingreso
        </button>
        <button
          onClick={() => setModo('salida')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
          style={{
            background: modo === 'salida' ? C.destructive : `${C.borderBlue}44`,
            color: C.textWhite,
            border: `1px solid ${modo === 'salida' ? C.destructive : C.borderBlue}`,
          }}
        >
          <ArrowUpFromLine className="h-4 w-4" /> Salida
        </button>
      </div>

      {/* Formulario según modo */}
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
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Sector</label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>{sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>{columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>{bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Cantidad</label>
          <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="0" className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }} />
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: C.textMuted }}>Selecciona niveles (clic en celdas). Seleccionados: <span style={{ color: C.textLight }}>{selectedLevels.size}</span></p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg p-3" style={{ background: C.bgDeep, border: `1px solid ${C.borderBlue}44` }}>
                <p className="text-xs font-medium mb-2" style={{ color: C.textWhite }}>{sc.codigo}</p>
                {gridData.slice(scIdx, scIdx + 1).map((g, gi) => (
                  <div key={gi} className="flex flex-wrap gap-1 mb-1">
                    <span className="text-[10px] w-6" style={{ color: C.textDark }}>P{g.posicion.numero}</span>
                    {g.niveles.map((n) => (
                      <button key={n.id} type="button" className="w-9 h-9 rounded text-xs font-medium transition-all"
                        style={{
                          background: selectedLevels.has(n.id) ? C.success : `${C.borderBlue}88`,
                          color: selectedLevels.has(n.id) ? C.textWhite : C.textLight,
                          border: selectedLevels.has(n.id) ? `2px solid ${C.emptyLight}` : '2px solid transparent',
                          boxShadow: selectedLevels.has(n.id) ? `0 0 8px ${C.success}44` : 'none',
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

      <Button onClick={handleIngreso} disabled={busy || selectedLevels.size === 0 || !cantidad || !bloqueId} className="gap-2" style={{ background: C.success, color: C.textWhite }}>
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
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Sector</label>
          <Select value={sectorId} onValueChange={setSectorId}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>{sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>{columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: C.textDark }}>Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="h-9 text-xs" style={{ background: C.bgDeep, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>{bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: C.textMuted }}>
            Selecciona niveles con stock disponible. Seleccionados: <span style={{ color: C.textLight }}>{selectedLevels.size}</span>
            {bloqueCodigo && <span> — Bloque: <span className="font-mono" style={{ color: C.textLight }}>{bloqueCodigo}</span></span>}
          </p>
          <div className="grid gap-2">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg p-3" style={{ background: C.bgDeep, border: `1px solid ${C.borderBlue}44` }}>
                <p className="text-xs font-medium mb-2" style={{ color: C.textWhite }}>{sc.codigo}</p>
                <div className="flex flex-wrap gap-1">
                  {gridData.slice(scIdx, scIdx + 1).flatMap((g) =>
                    g.niveles.map((n) => {
                      const stock = stockData.get(n.id) || []
                      const blockStock = stock.find((s) => s.bloque_codigo === bloqueCodigo)
                      const qty = blockStock?.cantidad || 0
                      const hasStock = qty > 0
                      const isSelected = selectedLevels.has(n.id)
                      return (
                        <button key={n.id} type="button" disabled={!hasStock} className="w-11 h-11 rounded text-xs font-medium transition-all"
                          style={{
                            background: isSelected ? C.destructive : hasStock ? `${C.occupied}22` : `${C.borderBlue}44`,
                            color: isSelected ? C.textWhite : hasStock ? C.occupiedLight : C.textDark,
                            cursor: hasStock ? 'pointer' : 'not-allowed',
                            border: isSelected ? `2px solid ${C.multiLight}` : '2px solid transparent',
                            boxShadow: isSelected ? `0 0 8px ${C.destructive}44` : 'none',
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

      <Button onClick={handleSalida} disabled={busy || selectedLevels.size === 0 || !bloqueId} className="gap-2" style={{ background: C.destructive, color: C.textWhite }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        Registrar salida ({selectedLevels.size} nivel{selectedLevels.size !== 1 ? 'es' : ''})
      </Button>
    </div>
  )
}
