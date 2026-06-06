'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { AuthGate } from '@/components/rackly/auth/AuthGate'
import { SesionBar } from '@/components/rackly/kardex/SesionBar'
import { MovimientoForm } from '@/components/rackly/kardex/MovimientoForm'
import { StockTab } from '@/components/rackly/kardex/StockTab'
import { CatalogoTab } from '@/components/rackly/kardex/CatalogoTab'
import { UsuariosTab } from '@/components/rackly/kardex/UsuariosTab'
import { DescargaTab } from '@/components/rackly/kardex/DescargaTab'
import { FefoTab } from '@/components/rackly/kardex/FefoTab'
import { OcupacionTab } from '@/components/rackly/kardex/OcupacionTab'
import { TrasladoTab } from '@/components/rackly/kardex/TrasladoTab'
import { SectoresConfigTab } from '@/components/rackly/piso/SectoresTab'
import { MovimientosTab } from '@/components/rackly/piso/MovimientosTab'
import { PisoSectoresTab } from '@/components/rackly/piso/PisoSectoresTab'
import { PisoStockTab } from '@/components/rackly/piso/PisoStockTab'
import { deleteMovimiento, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { TIPOS_MOVIMIENTO, ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Download,
  PackageSearch,
  Trash2,
  LayoutGrid,
  Warehouse,
  Layers3,
  History,
  Settings,
  Upload,
  Shield,
  Filter,
  BarChart3,
} from 'lucide-react'

function fmtCantidad(n: number) {
  return Number.isInteger(n)
    ? n.toString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString()
}

function RacklyApp() {
  const { perfil } = useAuth()
  const [view, setView] = useState<'racks' | 'piso'>('racks')
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [expandMovs, setExpandMovs] = useState(false)
  const [filterTipo, setFilterTipo] = useState('todos')
  const [filterUsuario, setFilterUsuario] = useState('todos')
  const [filterCodigo, setFilterCodigo] = useState('')

  useMovimientosRealtime(setMovs)

  // Usuarios únicos para el filtro
  const usuariosUnicos = Array.from(
    new Map(
      movs
        .map((m) => m.usuarioNombre || m.usuarioCorreo || '')
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name] as [string, string])
    ).values()
  ).sort()

  // Movimientos filtrados
  const movsFiltrados = movs.filter((m) => {
    if (filterTipo !== 'todos' && m.tipo !== filterTipo) return false
    if (filterUsuario !== 'todos') {
      const usuario = m.usuarioNombre || m.usuarioCorreo || ''
      if (usuario.toLowerCase() !== filterUsuario.toLowerCase()) return false
    }
    if (filterCodigo.trim() && !m.codigo.toUpperCase().includes(filterCodigo.trim().toUpperCase())) return false
    return true
  })

  const hayFiltrosActivos = filterTipo !== 'todos' || filterUsuario !== 'todos' || filterCodigo.trim() !== ''

  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEliminar = perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)

  async function handleDelete(id: string) {
    if (!puedeEliminar) {
      toast.error('No tienes permiso para eliminar movimientos.')
      return
    }
    try {
      const next = await deleteMovimiento(id)
      setMovs(next)
      toast.success('Movimiento eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  return (
    <main
      className="min-h-screen bg-cover bg-center bg-fixed bg-no-repeat relative"
      style={{ backgroundImage: "url('/bg-rackly.png')" }}
    >
      {/* Overlay semitransparente para no interrumpir la legibilidad */}
      <div className="absolute inset-0 bg-white/70 backdrop-blur-[1px] pointer-events-none" />
      {/* ═══ HEADER ═══ */}
      <header className="sticky top-0 z-50 border-b-0 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 shadow-lg shadow-slate-900/10">
        <div className="mx-auto max-w-7xl flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3">
          <div className="flex items-center gap-4">
            {/* Logo */}
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-500/25 font-extrabold text-sm text-white tracking-tight">
                R
              </div>
              <div>
                <h1 className="text-lg sm:text-xl font-extrabold tracking-tight leading-none text-white">
                  RACKLY
                </h1>
                <p className="text-[10px] font-medium text-indigo-300/80 tracking-wider uppercase hidden sm:block">
                  Warehouse Management
                </p>
              </div>
            </div>
            {/* View Switcher */}
            <div className="flex items-center bg-white/10 rounded-lg p-0.5 ml-2 sm:ml-4">
              <button
                onClick={() => setView('racks')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  view === 'racks'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <Warehouse className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Racks</span>
              </button>
              <button
                onClick={() => setView('piso')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  view === 'piso'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <Layers3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Piso</span>
              </button>
            </div>
          </div>
          <SesionBar />
        </div>
      </header>

      <div className="mx-auto max-w-7xl p-4 md:p-6 relative z-10">
        {/* ═══ KARDEX RACKS VIEW ═══ */}
        {view === 'racks' && (
          <Tabs defaultValue="movimientos" className="w-full">
            {/* Nav Tabs */}
            <TabsList className="flex flex-wrap gap-1.5 bg-transparent p-0 pb-1 h-auto rounded-none">
              {[
                { val: 'movimientos', icon: BarChart3, label: 'Movimientos', shortLabel: 'Mov', color: 'from-emerald-500 to-green-600' },
                { val: 'traslado', icon: ArrowRightLeft, label: 'Traslado', shortLabel: 'Trasl', color: 'from-blue-500 to-indigo-600' },
                { val: 'kardex', icon: BookOpen, label: 'Catálogo', shortLabel: 'Cat', color: 'from-amber-500 to-orange-600' },
                { val: 'stock', icon: PackageSearch, label: 'Stock', shortLabel: 'Stock', color: 'from-cyan-500 to-teal-600' },
                { val: 'ocupacion', icon: LayoutGrid, label: 'Ocupación', shortLabel: 'Ocup', color: 'from-violet-500 to-purple-600' },
                { val: 'descarga', icon: Download, label: 'Descarga', shortLabel: 'Desc', color: 'from-rose-500 to-pink-600' },
                { val: 'fefo', icon: CalendarClock, label: 'FEFO', shortLabel: 'FEFO', color: 'from-orange-500 to-red-500' },
                { val: 'usuarios', icon: Shield, label: 'Usuarios', shortLabel: 'Users', color: 'from-slate-500 to-slate-700' },
              ].map((tab) => (
                <TabsTrigger
                  key={tab.val}
                  value={tab.val}
                  className="gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold transition-all data-[state=active]:shadow-md data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:border data-[state=active]:border-slate-200 hover:bg-white/60 data-[state=active]:hover:bg-white basis-[calc(25%-6px)] md:basis-auto shrink-0"
                >
                  <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${tab.color} flex items-center justify-center shadow-sm`}>
                    <tab.icon className="h-3 w-3 text-white" />
                  </div>
                  <span className="md:hidden text-[10px] leading-tight">{tab.shortLabel}</span>
                  <span className="hidden md:inline">{tab.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            {/* ═══ MOVIMIENTOS ═══ */}
            <TabsContent value="movimientos" className="mt-5 space-y-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-md shadow-emerald-500/20">
                      <BarChart3 className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Registrar movimiento</CardTitle>
                      <CardDescription>Selecciona el tipo de movimiento a registrar.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* Movement type sub-tabs */}
                  <Tabs defaultValue="ingreso" className="w-full">
                    <TabsList className="flex flex-wrap gap-2 bg-transparent p-0 mb-5 h-auto rounded-none">
                      {[
                        { val: 'ingreso', icon: ArrowDownToLine, label: 'Ingreso', gradient: 'from-green-500 to-emerald-600', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', ring: 'ring-green-500/20' },
                        { val: 'salida', icon: ArrowUpFromLine, label: 'Salida', gradient: 'from-red-500 to-rose-600', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', ring: 'ring-red-500/20' },
                        { val: 'devolucion', icon: ArrowRightLeft, label: 'Devolución', gradient: 'from-orange-500 to-amber-600', bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', ring: 'ring-orange-500/20' },
                      ].map((t) => (
                        <TabsTrigger
                          key={t.val}
                          value={t.val}
                          className="gap-2 flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all border data-[state=active]:border-transparent data-[state=active]:shadow-lg data-[state=active]:ring-2"
                        >
                          <div className={`w-6 h-6 rounded-lg bg-gradient-to-br ${t.gradient} flex items-center justify-center shadow-sm`}>
                            <t.icon className="h-3.5 w-3.5 text-white" />
                          </div>
                          {t.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    <TabsContent value="ingreso" className="mt-0">
                      <MovimientoForm tipo="ingreso" onCreated={setMovs} />
                    </TabsContent>
                    <TabsContent value="salida" className="mt-0">
                      <MovimientoForm tipo="salida" onCreated={setMovs} />
                    </TabsContent>
                    <TabsContent value="devolucion" className="mt-0">
                      <MovimientoForm tipo="devolucion" onCreated={setMovs} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              {/* Movimientos registrados */}
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-md shadow-slate-500/20">
                        <History className="h-5 w-5 text-white" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">Movimientos registrados</CardTitle>
                        <CardDescription>
                          {hayFiltrosActivos
                            ? `${movsFiltrados.length} de ${movs.length} movimiento(s).`
                            : movs.length === 0
                              ? 'Aún no hay movimientos.'
                              : expandMovs
                                ? `Mostrando ${movsFiltrados.length} movimiento(s).`
                                : `Mostrando los últimos ${Math.min(5, movsFiltrados.length)} de ${movsFiltrados.length}.`
                          }
                        </CardDescription>
                      </div>
                    </div>
                    {movs.length > 0 && (
                      <Badge variant="outline" className="font-bold text-xs px-3 py-1">
                        {movs.length} total
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* ═══ BARRA DE FILTROS ═══ */}
                  {movs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-slate-50 border border-slate-200/60">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider mr-1">
                        <Filter className="h-3.5 w-3.5" />
                        Filtros
                      </div>
                      <Select value={filterTipo} onValueChange={setFilterTipo}>
                        <SelectTrigger className="h-9 w-[150px] text-xs font-medium bg-white">
                          <SelectValue placeholder="Tipo" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todos los tipos</SelectItem>
                          {Object.values(TIPOS_MOVIMIENTO).map((t) => (
                            <SelectItem key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={filterUsuario} onValueChange={setFilterUsuario}>
                        <SelectTrigger className="h-9 w-[180px] text-xs font-medium bg-white">
                          <SelectValue placeholder="Usuario" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todos">Todos los usuarios</SelectItem>
                          {usuariosUnicos.map((u) => (
                            <SelectItem key={u} value={u}>{u}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={filterCodigo}
                        onChange={(e) => setFilterCodigo(e.target.value)}
                        placeholder="Filtrar por código..."
                        className="h-9 w-[160px] text-xs font-medium bg-white"
                      />
                      {hayFiltrosActivos && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setFilterTipo('todos'); setFilterUsuario('todos'); setFilterCodigo('') }}
                          className="h-9 text-xs text-slate-500 hover:text-red-600 gap-1"
                        >
                          <span className="text-base leading-none">×</span>
                          Limpiar
                        </Button>
                      )}
                      {hayFiltrosActivos && (
                        <Badge variant="secondary" className="text-xs ml-1">
                          {movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                  )}

                  <div className="overflow-x-auto rounded-xl border border-slate-200/60">
                    <Table className="min-w-[800px]">
                      <TableHeader>
                        <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Tipo</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Bloque</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Torre</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Piso</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Pos</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider">Código</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">Descripción</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden sm:table-cell">UN</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Cant.</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">Venc.</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">Modificación</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden sm:table-cell">Turno</TableHead>
                          <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">Usuario</TableHead>
                          {puedeEliminar && <TableHead className="w-10"></TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(expandMovs ? movsFiltrados : movsFiltrados.slice(0, 5)).map((m, idx) => (
                          <TableRow key={m.id} className="group hover:bg-indigo-50/30 transition-colors">
                            <TableCell>
                              <Badge className={
                                m.tipo === 'ingreso' ? 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white border-0 shadow-sm' :
                                m.tipo === 'salida' ? 'bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-600 hover:to-rose-700 text-white border-0 shadow-sm' :
                                m.tipo === 'devolucion' ? 'bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white border-0 shadow-sm' :
                                'bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white border-0 shadow-sm'
                              }>
                                {m.tipo}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-medium text-slate-700">{m.bloque}</TableCell>
                            <TableCell className="font-medium text-slate-700">{m.torre}</TableCell>
                            <TableCell className="font-medium text-slate-700">{m.piso}</TableCell>
                            <TableCell className="font-medium text-slate-700">{m.posicion}</TableCell>
                            <TableCell className="font-semibold font-mono text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">{m.codigo}</TableCell>
                            <TableCell className="hidden lg:table-cell max-w-48 truncate text-slate-600">{m.descripcion}</TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <Badge variant="secondary" className="font-medium">{m.un}</Badge>
                            </TableCell>
                            <TableCell className="text-right font-bold text-slate-800">{fmtCantidad(m.cantidad)}</TableCell>
                            <TableCell className="hidden md:table-cell text-slate-500">{m.fVencimiento || '—'}</TableCell>
                            <TableCell className="hidden md:table-cell whitespace-nowrap text-muted-foreground text-xs">
                              {formatDateTime(m.fModificacion)}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <Badge variant="outline" className={
                                m.turno === 'Día' ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-indigo-300 bg-indigo-50 text-indigo-700'
                              }>
                                {m.turno}
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-slate-600">
                              {m.usuarioNombre ?? m.usuarioCorreo ?? '—'}
                            </TableCell>
                            {puedeEliminar && (
                              <TableCell>
                                <Button variant="ghost" size="icon" onClick={() => handleDelete(m.id)} aria-label="Eliminar" className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {movsFiltrados.length > 5 && (
                    <div className="mt-4 flex justify-center">
                      <Button variant="outline" size="sm" onClick={() => setExpandMovs((v) => !v)} className="gap-2 rounded-xl border-dashed font-medium">
                        {expandMovs ? (
                          <><ChevronUp className="h-4 w-4" /> Mostrar menos</>
                        ) : (
                          <><ChevronDown className="h-4 w-4" /> Expandir ({movsFiltrados.length - 5} más)</>
                        )}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ═══ TRASLADO ═══ */}
            <TabsContent value="traslado" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20">
                      <ArrowRightLeft className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Traslado entre ubicaciones</CardTitle>
                      <CardDescription>Busca un código, elige la ubicación de origen y destino. Confirma el traslado.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><TrasladoTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ CATÁLOGO ═══ */}
            <TabsContent value="kardex" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-md shadow-amber-500/20">
                      <BookOpen className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Catálogo de códigos</CardTitle>
                      <CardDescription>Importa desde Excel o agrega códigos manualmente. Los formularios autocompletarán al escribir.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><CatalogoTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ STOCK ═══ */}
            <TabsContent value="stock" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shadow-md shadow-cyan-500/20">
                      <PackageSearch className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Stock actual por código</CardTitle>
                      <CardDescription>Stock = ingresos − salidas, agrupado por ubicación. Incluye Stock Big Magic.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><StockTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ OCUPACIÓN ═══ */}
            <TabsContent value="ocupacion" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md shadow-violet-500/20">
                      <LayoutGrid className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Ocupación del Kardex</CardTitle>
                      <CardDescription>Mapa visual 3D con dashboard de resumen. Verde = vacío, Azul = 1 artículo, Naranja = varios artículos.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><OcupacionTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ DESCARGA ═══ */}
            <TabsContent value="descarga" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center shadow-md shadow-rose-500/20">
                      <Download className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Descarga de datos</CardTitle>
                      <CardDescription>Exporta a Excel movimientos y stock actual.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><DescargaTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ FEFO ═══ */}
            <TabsContent value="fefo" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-md shadow-orange-500/20">
                      <CalendarClock className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">FEFO — Control de vencimientos</CardTitle>
                      <CardDescription>Verde &gt; 60 días · Azul ≤ 30 días · Naranja ≤ 15 días · Rojo vencidos.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><FefoTab /></CardContent>
              </Card>
            </TabsContent>

            {/* ═══ USUARIOS ═══ */}
            <TabsContent value="usuarios" className="mt-5">
              <Card className="border-0 shadow-md shadow-slate-200/50 bg-white">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-md shadow-slate-500/20">
                      <Shield className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Usuarios</CardTitle>
                      <CardDescription>
                        {puedeEliminar
                          ? 'Puedes aprobar accesos y eliminar movimientos.'
                          : 'No tienes permisos de administración en esta sección.'}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><UsuariosTab /></CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {/* ═══ KARDEX PISO VIEW ═══ */}
        {view === 'piso' && (
          <Tabs defaultValue="movimientos" className="w-full">
            <TabsList className="flex flex-wrap gap-1.5 bg-transparent p-0 pb-1 h-auto rounded-none">
              {[
                { val: 'movimientos', icon: History, label: 'Movimientos', shortLabel: 'Mov', color: 'from-emerald-500 to-green-600' },
                { val: 'sectores', icon: Layers3, label: 'Sectores', shortLabel: 'Sector', color: 'from-sky-500 to-blue-600' },
                { val: 'stock', icon: PackageSearch, label: 'Stock', shortLabel: 'Stock', color: 'from-cyan-500 to-teal-600' },
                { val: 'config', icon: Settings, label: 'Configuración', shortLabel: 'Config', color: 'from-slate-400 to-slate-600' },
              ].map((tab) => (
                <TabsTrigger
                  key={tab.val}
                  value={tab.val}
                  className="gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold transition-all data-[state=active]:shadow-md data-[state=active]:bg-slate-700 data-[state=active]:text-white data-[state=active]:border data-[state=active]:border-slate-600 hover:bg-slate-800/60 data-[state=active]:hover:bg-slate-700 basis-[calc(25%-6px)] md:basis-auto shrink-0 text-slate-400"
                >
                  <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${tab.color} flex items-center justify-center shadow-sm`}>
                    <tab.icon className="h-3 w-3 text-white" />
                  </div>
                  <span className="md:hidden text-[10px] leading-tight">{tab.shortLabel}</span>
                  <span className="hidden md:inline">{tab.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="movimientos" className="mt-5">
              <Card className="border border-slate-700 shadow-xl shadow-slate-900/30 bg-slate-900">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-md shadow-emerald-500/20">
                      <History className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg text-white">Movimientos</CardTitle>
                      <CardDescription className="text-slate-400">Historial de todos los movimientos registrados. Los movimientos se realizan desde Sectores.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><MovimientosTab /></CardContent>
              </Card>
            </TabsContent>



            <TabsContent value="stock" className="mt-5">
              <Card className="border border-slate-700 shadow-xl shadow-slate-900/30 bg-slate-900">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shadow-md shadow-cyan-500/20">
                      <PackageSearch className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg text-white">Stock Kardex Piso</CardTitle>
                      <CardDescription className="text-slate-400">Stock actual por ubicacion con FEFO. Incluye Stock Big Magic.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><PisoStockTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="sectores" className="mt-5">
              <PisoSectoresTab />
            </TabsContent>

            <TabsContent value="config" className="mt-5">
              <Card className="border border-slate-700 shadow-xl shadow-slate-900/30 bg-slate-900">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center shadow-md shadow-slate-500/20">
                      <Settings className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-lg text-white">Configuración</CardTitle>
                      <CardDescription className="text-slate-400">Administra sectores y estructura del almacén.</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent><SectoresConfigTab /></CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ═══ FOOTER ═══ */}
      <footer className="mt-10 relative z-10 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900">
        <div className="mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-[9px] font-extrabold text-white">
              R
            </div>
            <span className="text-xs font-semibold text-slate-400">
              RACKLY <span className="text-slate-600">·</span> Sistema de Gestión de Almacenes
            </span>
          </div>
          <p className="text-[10px] text-slate-600">
            Created by <span className="text-slate-300">Miguel Hidalgo</span>
          </p>
        </div>
      </footer>
    </main>
  )
}

export default function Page() {
  return (
    <AuthProvider>
      <AuthGate>
        <RacklyApp />
      </AuthGate>
    </AuthProvider>
  )
}
