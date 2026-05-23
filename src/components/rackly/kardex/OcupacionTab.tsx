'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  fetchMovimientos,
  stockEnUbicacion,
  type Movimiento,
  type StockEnUbicacion,
  addMovimiento,
} from '@/lib/rackly/kardex'
import type { OcupacionCelda } from '@/lib/rackly/kardex'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { supabase } from '@/lib/supabase/client'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Download, Loader2, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'

// Calcular ocupación desde movimientos (fórmula correcta)
function calcularOcupacion(movs: Movimiento[]): OcupacionCelda[] {
  const cellMap = new Map<string, { stock: number; codigos: Set<string> }>()

  for (const m of movs) {
    const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
    let cell = cellMap.get(key)
    if (!cell) {
      cell = { stock: 0, codigos: new Set() }
      cellMap.set(key, cell)
    }
    // ingreso, devolucion, traslado = positivo; salida = negativo
    const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo)
      ? m.cantidad
      : -m.cantidad
    cell.stock += delta
    if (cell.stock > 0) {
      cell.codigos.add(m.codigo)
    } else if (cell.stock <= 0) {
      cell.codigos.clear()
      cell.stock = 0
    }
  }

  const result: OcupacionCelda[] = []
  for (const [key, cell] of cellMap) {
    const [bloque, torre, piso, posicion] = key.split('-')
    result.push({
      bloque,
      torre,
      piso,
      posicion,
      stock: cell.stock,
      codigos: Array.from(cell.codigos),
    })
  }
  return result
}

export function OcupacionTab() {
  const { perfil } = useAuth()
  const [ocupacion, setOcupacion] = useState<OcupacionCelda[]>([])
  const [bloqueFilter, setBloqueFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{
    bloque: string
    torre: string
    piso: string
    posicion: string
    stock: StockEnUbicacion[]
  } | null>(null)
  const [busyExport, setBusyExport] = useState(false)
  const mountedRef = useRef(true)

  // Quick ingreso/salida states
  const [quickIngreso, setQuickIngreso] = useState(false)
  const [quickCodigo, setQuickCodigo] = useState('')
  const [quickDescripcion, setQuickDescripcion] = useState('')
  const [quickUn, setQuickUn] = useState('')
  const [quickCantidad, setQuickCantidad] = useState('')
  const [quickFVenc, setQuickFVenc] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [salidaTarget, setSalidaTarget] = useState<StockEnUbicacion | null>(null)

  // Función central: obtiene movimientos y calcula ocupación
  const refreshData = useCallback(async () => {
    try {
      const movs = await fetchMovimientos()
      const data = calcularOcupacion(movs)
      if (mountedRef.current) setOcupacion(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      if (mountedRef.current) toast.error('Error al cargar ocupación', { description: message })
    }
  }, [])

  // Carga inicial (con spinner)
  useEffect(() => {
    mountedRef.current = true
    setLoading(true)
    refreshData().finally(() => {
      if (mountedRef.current) setLoading(false)
    })
    return () => { mountedRef.current = false }
  }, [refreshData])

  // Polling silencioso cada 10 segundos (sin spinner)
  useEffect(() => {
    const interval = setInterval(() => refreshData(), 10000)
    return () => clearInterval(interval)
  }, [refreshData])

  // Realtime silencioso
  useEffect(() => {
    let ch: ReturnType<typeof supabase.channel> | null = null
    try {
      ch = supabase
        .channel('ocupacion-rt')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'movimientos' },
          () => refreshData()
        )
        .subscribe()
    } catch { /* polling cubre */ }
    return () => { if (ch) try { supabase.removeChannel(ch) } catch { /* ignore */ } }
  }, [refreshData])

  const filtered =
    bloqueFilter === 'all'
      ? ocupacion
      : ocupacion.filter((o) => o.bloque === bloqueFilter)

  const total = filtered.length
  const occupied = filtered.filter((o) => o.stock > 0).length
  const multiArt = filtered.filter((o) => o.stock > 0 && o.codigos.length > 1).length
  const singleArt = occupied - multiArt
  const empty = total - occupied
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0

  async function handleCellClick(bloque: string, torre: string, piso: string, posicion: string) {
    try {
      const data = await stockEnUbicacion(bloque, torre, piso, posicion)
      setDetail({ bloque, torre, piso, posicion, stock: data })
    } catch {
      toast.error('Error al cargar detalle')
    }
  }

  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((o) => ({
        Bloque: o.bloque,
        Torre: o.torre,
        Piso: o.piso,
        Posición: o.posicion,
        Stock: o.stock,
        Códigos: o.codigos.join(', '),
        Artículos: o.codigos.length,
        Estado: o.stock <= 0 ? 'Vacío' : o.codigos.length > 1 ? 'Mixto' : 'Ocupado',
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Ocupación')
      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_Ocupacion_${fecha}.xlsx`)
      toast.success('Ocupación exportada')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusyExport(false)
    }
  }

  function openQuickIngreso() {
    if (!detail) return
    setQuickCodigo('')
    setQuickDescripcion('')
    setQuickUn('')
    setQuickCantidad('')
    setQuickFVenc('')
    setQuickIngreso(true)
  }

  function openQuickSalida() {
    if (!detail || detail.stock.length === 0) return
    setSalidaTarget(detail.stock[0])
  }

  async function doQuickIngreso() {
    if (!detail || !perfil) return
    if (!quickCodigo.trim() || !quickCantidad) { toast.error('Completa código y cantidad'); return }
    const qty = parseFloat(quickCantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    setQuickBusy(true)
    try {
      await addMovimiento({
        tipo: 'ingreso', bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: quickCodigo.trim().toUpperCase(), descripcion: quickDescripcion, un: quickUn, cantidad: qty,
        fVencimiento: quickFVenc, turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
      })
      toast.success('Ingreso registrado')
      setQuickIngreso(false)
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      setDetail({ ...detail, stock: data })
      refreshData()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar ingreso', { description: message })
    } finally { setQuickBusy(false) }
  }

  async function doQuickSalida() {
    if (!detail || !salidaTarget || !perfil) return
    setQuickBusy(true)
    try {
      await addMovimiento({
        tipo: 'salida', bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: salidaTarget.codigo, descripcion: salidaTarget.descripcion, un: salidaTarget.un,
        cantidad: salidaTarget.stock, fVencimiento: salidaTarget.fVencimiento ?? '',
        turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
      })
      toast.success('Salida registrada')
      setSalidaTarget(null)
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      setDetail({ ...detail, stock: data })
      refreshData()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar salida', { description: message })
    } finally { setQuickBusy(false) }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Filtros y estadísticas */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={bloqueFilter} onValueChange={setBloqueFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Filtrar bloque" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {BLOQUES.map((b) => (
                <SelectItem key={b} value={b}>Bloque {b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[140px]">
            <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${pct}%`,
                  background: pct > 80 ? 'linear-gradient(90deg, #ef4444, #f97316)' : pct > 50 ? 'linear-gradient(90deg, #f97316, #eab308)' : 'linear-gradient(90deg, #22c55e, #3b82f6)',
                }}
              />
            </div>
          </div>
          <Badge className="bg-blue-600 text-white border-0">{singleArt} ocupadas</Badge>
          {multiArt > 0 && <Badge className="bg-orange-500 text-white border-0">{multiArt} mixtas</Badge>}
          <Badge className="bg-emerald-600 text-white border-0">{empty} vacías</Badge>
          <Badge variant="outline" className="font-bold">{pct}%</Badge>
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-blue-500 to-blue-700" />
          <span>1 artículo</span>
        </div>
        {multiArt > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-orange-400 to-orange-600" />
            <span>Varios artículos</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-emerald-200 to-emerald-400" />
          <span>Vacío</span>
        </div>
      </div>

      {/* Grid de bloques — Estilo Rack 3D */}
      <div className="space-y-6">
        {BLOQUES.filter((b) => bloqueFilter === 'all' || b === bloqueFilter).map(
          (bloque) => {
            const torres = torresDeBloque(bloque)
            const bloqueOcupadas = filtered.filter((o) => o.bloque === bloque && o.stock > 0).length
            const bloqueTotal = filtered.filter((o) => o.bloque === bloque).length
            const bloquePct = bloqueTotal > 0 ? Math.round((bloqueOcupadas / bloqueTotal) * 100) : 0
            return (
              <div key={bloque} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-white font-bold text-sm shadow-md">
                      {bloque}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Bloque {bloque}</p>
                      <p className="text-xs text-muted-foreground">{torres.length} torre(s) · {bloqueTotal} posiciones</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500" style={{ width: `${bloquePct}%` }} />
                    </div>
                    <span className="text-xs font-semibold text-muted-foreground">{bloquePct}%</span>
                  </div>
                </div>

                <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(torres.length, 2)}, 1fr)` }}>
                  {torres.map((torre) => {
                    const torreOcupadas = filtered.filter((o) => o.bloque === bloque && o.torre === torre && o.stock > 0).length
                    const torreTotal = filtered.filter((o) => o.bloque === bloque && o.torre === torre).length
                    return (
                      <div key={torre} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-lg">
                        <div className="bg-gradient-to-r from-slate-700 to-slate-800 dark:from-slate-600 dark:to-slate-700 px-4 py-2 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-6 rounded-sm bg-gradient-to-b from-slate-400 to-slate-500 shadow-inner" />
                            <span className="text-sm font-semibold text-white">Torre {torre}</span>
                          </div>
                          <span className="text-xs text-slate-300">{torreOcupadas}/{torreTotal}</span>
                        </div>

                        <div className="p-3 space-y-2">
                          {[...PISOS].reverse().map((piso) => {
                            const posiciones = posicionesDeBloque(bloque)
                            const pisoOcupadas = posiciones.filter((pos) => {
                              const cell = ocupacion.find(
                                (o) => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos
                              )
                              return cell && cell.stock > 0
                            }).length
                            return (
                              <div key={piso}>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <div className="h-px flex-1 bg-gradient-to-r from-slate-300 via-slate-400 to-slate-300 dark:from-slate-600 dark:via-slate-500 dark:to-slate-600" />
                                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">
                                    Piso {piso} ({pisoOcupadas})
                                  </span>
                                  <div className="h-px flex-1 bg-gradient-to-r from-slate-300 via-slate-400 to-slate-300 dark:from-slate-600 dark:via-slate-500 dark:to-slate-600" />
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {posiciones.map((pos) => {
                                    const cell = ocupacion.find(
                                      (o) => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos
                                    )
                                    const isOccupied = cell && cell.stock > 0
                                    const isMulti = isOccupied && cell.codigos.length > 1
                                    const cellClass = isOccupied
                                      ? isMulti
                                        ? 'bg-gradient-to-br from-orange-400 via-orange-500 to-orange-600 text-white shadow-[0_2px_4px_rgba(234,88,12,0.4)] hover:shadow-[0_4px_8px_rgba(234,88,12,0.5)] hover:scale-105 border border-orange-400/30'
                                        : 'bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 text-white shadow-[0_2px_4px_rgba(37,99,235,0.4)] hover:shadow-[0_4px_8px_rgba(37,99,235,0.5)] hover:scale-105 border border-blue-400/30'
                                      : 'bg-gradient-to-br from-emerald-100 via-emerald-200 to-emerald-300 text-emerald-700 shadow-[0_2px_4px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_8px_rgba(16,185,129,0.3)] hover:scale-105 border border-emerald-300/50 dark:from-emerald-900/60 dark:via-emerald-800/60 dark:to-emerald-700/60 dark:text-emerald-200 dark:border-emerald-600/30'
                                    return (
                                      <button
                                        key={pos}
                                        className={`relative w-8 h-8 rounded text-[10px] font-bold transition-all duration-200 ${cellClass}`}
                                        onClick={() => handleCellClick(bloque, torre, piso, pos)}
                                        title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOccupied ? ` (${cell.stock})${isMulti ? ` · ${cell.codigos.length} artículos` : ''}` : ''}`}
                                      >
                                        {pos}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          }
        )}
      </div>

      <Button onClick={handleExport} disabled={busyExport} variant="outline" className="gap-2">
        {busyExport ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Exportar
      </Button>

      {/* Diálogo de detalle */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              B{detail?.bloque} T{detail?.torre} P{detail?.piso} Pos {detail?.posicion}
            </DialogTitle>
          </DialogHeader>
          {detail && detail.stock.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Descripción</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead>Vencimiento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.stock.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono">{s.codigo}</TableCell>
                      <TableCell>{s.descripcion}</TableCell>
                      <TableCell className="text-right font-bold">{s.stock}</TableCell>
                      <TableCell>{s.fVencimiento || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-2 pt-2">
                <Button onClick={openQuickIngreso} className="flex-1 gap-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white">
                  <ArrowDownToLine className="h-4 w-4" /> Ingreso rápido
                </Button>
                <Button onClick={openQuickSalida} variant="destructive" className="flex-1 gap-2">
                  <ArrowUpFromLine className="h-4 w-4" /> Salida total
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-muted-foreground text-center py-4">Ubicación vacía</p>
              <Button onClick={openQuickIngreso} className="w-full gap-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white">
                <ArrowDownToLine className="h-4 w-4" /> Ingreso rápido
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Diálogo de ingreso rápido */}
      <Dialog open={quickIngreso} onOpenChange={setQuickIngreso}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Ingreso rápido</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Ubicación: B{detail?.bloque} T{detail?.torre} P{detail?.piso} Pos {detail?.posicion}
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Código *</Label>
              <Input value={quickCodigo} onChange={(e) => setQuickCodigo(e.target.value)} placeholder="Código del producto" className="h-9" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Descripción</Label>
                <Input value={quickDescripcion} onChange={(e) => setQuickDescripcion(e.target.value)} placeholder="Descripción" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">UN</Label>
                <Input value={quickUn} onChange={(e) => setQuickUn(e.target.value)} placeholder="KG" className="h-9" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Cantidad *</Label>
                <Input type="number" step="any" min="0.001" value={quickCantidad} onChange={(e) => setQuickCantidad(e.target.value)} placeholder="0" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">F. Vencimiento</Label>
                <Input type="date" value={quickFVenc} onChange={(e) => setQuickFVenc(e.target.value)} className="h-9" />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setQuickIngreso(false)} className="flex-1">Cancelar</Button>
            <Button onClick={doQuickIngreso} disabled={quickBusy} className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white">
              {quickBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Registrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Diálogo de confirmación de salida */}
      <AlertDialog open={!!salidaTarget} onOpenChange={() => setSalidaTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar salida total</AlertDialogTitle>
            <AlertDialogDescription>Se retirará todo el stock de esta ubicación.</AlertDialogDescription>
          </AlertDialogHeader>
          {salidaTarget && (
            <div className="rounded-lg border bg-muted/50 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Producto:</span>
                <span className="font-medium">{salidaTarget.codigo} — {salidaTarget.descripcion}</span>
              </div>
              <div className="flex justify-between font-bold text-red-600">
                <span>Cantidad a retirar:</span>
                <span>{salidaTarget.stock} {salidaTarget.un}</span>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doQuickSalida}>Confirmar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
