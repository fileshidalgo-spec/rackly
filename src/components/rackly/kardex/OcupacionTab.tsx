'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  fetchOcupacionCeldas,
  type OcupacionCelda,
  stockEnUbicacion,
  type StockEnUbicacion,
  addMovimiento,
} from '@/lib/rackly/kardex'
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

  // Quick ingreso/salida states
  const [quickIngreso, setQuickIngreso] = useState(false)
  const [quickSalida, setQuickSalida] = useState(false)
  const [quickCodigo, setQuickCodigo] = useState('')
  const [quickDescripcion, setQuickDescripcion] = useState('')
  const [quickUn, setQuickUn] = useState('')
  const [quickCantidad, setQuickCantidad] = useState('')
  const [quickFVenc, setQuickFVenc] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)

  // Confirmar salida
  const [salidaTarget, setSalidaTarget] = useState<StockEnUbicacion | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchOcupacionCeldas()
      setOcupacion(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar ocupación', { description: message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Polling: refresco automático cada 8 segundos como respaldo
  useEffect(() => {
    const interval = setInterval(() => load(), 8000)
    return () => clearInterval(interval)
  }, [load])

  // Realtime: refresco instantáneo cuando cambian movimientos
  useEffect(() => {
    let ch: ReturnType<typeof supabase.channel> | null = null
    try {
      ch = supabase
        .channel('ocupacion-realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'movimientos' },
          () => load()
        )
        .subscribe()
    } catch {
      // Si Realtime no está configurado, el polling cubre
    }
    return () => { if (ch) try { supabase.removeChannel(ch) } catch { /* ignore */ } }
  }, [load])

  const filtered =
    bloqueFilter === 'all'
      ? ocupacion
      : ocupacion.filter((o) => o.bloque === bloqueFilter)

  const total = filtered.length
  const occupied = filtered.filter((o) => o.stock > 0).length
  const empty = total - occupied
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0

  async function handleCellClick(
    bloque: string,
    torre: string,
    piso: string,
    posicion: string
  ) {
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
        Estado: o.stock > 0 ? 'Ocupado' : 'Vacío',
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
    if (!quickCodigo.trim() || !quickCantidad) {
      toast.error('Completa código y cantidad')
      return
    }
    const qty = parseFloat(quickCantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('Cantidad inválida')
      return
    }
    setQuickBusy(true)
    try {
      await addMovimiento({
        tipo: 'ingreso',
        bloque: detail.bloque,
        torre: detail.torre,
        piso: detail.piso,
        posicion: detail.posicion,
        codigo: quickCodigo.trim().toUpperCase(),
        descripcion: quickDescripcion,
        un: quickUn,
        cantidad: qty,
        fVencimiento: quickFVenc,
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
      })
      toast.success('Ingreso registrado')
      setQuickIngreso(false)
      // Refrescar detalle y ocupación
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      setDetail({ ...detail, stock: data })
      load()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar ingreso', { description: message })
    } finally {
      setQuickBusy(false)
    }
  }

  async function doQuickSalida() {
    if (!detail || !salidaTarget || !perfil) return
    setQuickBusy(true)
    try {
      await addMovimiento({
        tipo: 'salida',
        bloque: detail.bloque,
        torre: detail.torre,
        piso: detail.piso,
        posicion: detail.posicion,
        codigo: salidaTarget.codigo,
        descripcion: salidaTarget.descripcion,
        un: salidaTarget.un,
        cantidad: salidaTarget.stock,
        fVencimiento: salidaTarget.fVencimiento ?? '',
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
      })
      toast.success('Salida registrada')
      setSalidaTarget(null)
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      setDetail({ ...detail, stock: data })
      load()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar salida', { description: message })
    } finally {
      setQuickBusy(false)
    }
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
                <SelectItem key={b} value={b}>
                  Bloque {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Barra de progreso */}
          <div className="flex items-center gap-2 flex-1 min-w-[180px]">
            <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${pct}%`,
                  background: pct > 80
                    ? 'linear-gradient(90deg, #ef4444, #f97316)'
                    : pct > 50
                      ? 'linear-gradient(90deg, #f97316, #eab308)'
                      : 'linear-gradient(90deg, #22c55e, #3b82f6)',
                }}
              />
            </div>
          </div>
          <Badge className="bg-gradient-to-r from-blue-600 to-blue-700 text-white border-0">
            {occupied} ocupadas
          </Badge>
          <Badge className="bg-gradient-to-r from-green-600 to-green-700 text-white border-0">
            {empty} vacías
          </Badge>
          <Badge variant="outline" className="font-bold">
            {pct}%
          </Badge>
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-blue-500 to-blue-700" />
          <span>Ocupado</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-green-400 to-green-600" />
          <span>Vacío</span>
        </div>
      </div>

      {/* Grid de bloques */}
      <div className="space-y-4">
        {BLOQUES.filter((b) => bloqueFilter === 'all' || b === bloqueFilter).map(
          (bloque) => {
            const torres = torresDeBloque(bloque)
            return torres.map((torre) => (
              <div key={`${bloque}-${torre}`} className="rounded-xl border bg-gradient-to-br from-muted/50 to-background p-3 space-y-2">
                <p className="text-sm font-semibold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                  Bloque {bloque} — Torre {torre}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PISOS.map((piso) => (
                    <div key={piso}>
                      <p className="text-xs text-muted-foreground mb-1.5 font-medium">
                        Piso {piso}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {posicionesDeBloque(bloque).map((pos) => {
                          const cell = ocupacion.find(
                            (o) =>
                              o.bloque === bloque &&
                              o.torre === torre &&
                              o.piso === piso &&
                              o.posicion === pos
                          )
                          const isOccupied = cell && cell.stock > 0
                          return (
                            <button
                              key={pos}
                              className={`w-9 h-9 rounded-md text-xs font-semibold transition-all duration-200 shadow-sm hover:scale-110 hover:shadow-md ${
                                isOccupied
                                  ? 'bg-gradient-to-br from-blue-500 to-blue-700 text-white hover:from-blue-600 hover:to-blue-800'
                                  : 'bg-gradient-to-br from-green-100 to-green-200 text-green-700 hover:from-green-200 hover:to-green-300 dark:from-green-900/80 dark:to-green-800/80 dark:text-green-200'
                              }`}
                              onClick={() =>
                                handleCellClick(bloque, torre, piso, pos)
                              }
                              title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOccupied ? ` (${cell.stock})` : ''}`}
                            >
                              {pos}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          }
        )}
      </div>

      <Button onClick={handleExport} disabled={busyExport} variant="outline" className="gap-2">
        {busyExport ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
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
                <Button
                  onClick={openQuickIngreso}
                  className="flex-1 gap-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white"
                >
                  <ArrowDownToLine className="h-4 w-4" />
                  Ingreso rápido
                </Button>
                <Button
                  onClick={openQuickSalida}
                  variant="destructive"
                  className="flex-1 gap-2"
                >
                  <ArrowUpFromLine className="h-4 w-4" />
                  Salida total
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-muted-foreground text-center py-4">
                Ubicación vacía
              </p>
              <Button
                onClick={openQuickIngreso}
                className="w-full gap-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white"
              >
                <ArrowDownToLine className="h-4 w-4" />
                Ingreso rápido
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
            <AlertDialogDescription>
              Se retirará todo el stock de esta ubicación.
            </AlertDialogDescription>
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
            <AlertDialogAction onClick={doQuickSalida}>
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
