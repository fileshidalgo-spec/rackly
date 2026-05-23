'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  fetchOcupacionCeldas,
  addMovimiento,
  stockEnUbicacion,
  type OcupacionCelda,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { calcularTurno } from '@/lib/rackly/turno'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { CatalogoSearchInput } from './CatalogoSearchInput'
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
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Download,
  Loader2,
  ArrowDownToLine,
  ArrowUpFromLine,
  Info,
} from 'lucide-react'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

export function OcupacionTab() {
  const { perfil } = useAuth()
  const [ocupacion, setOcupacion] = useState<OcupacionCelda[]>([])
  const [bloqueFilter, setBloqueFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [busyExport, setBusyExport] = useState(false)

  // Detail dialog
  const [detail, setDetail] = useState<{
    bloque: string
    torre: string
    piso: string
    posicion: string
    stock: StockEnUbicacion[]
  } | null>(null)

  // Quick action dialog (ingreso/salida from occupation)
  const [actionMode, setActionMode] = useState<'ingreso' | 'salida' | null>(null)
  const [actionCell, setActionCell] = useState<{
    bloque: string
    torre: string
    piso: string
    posicion: string
  } | null>(null)
  const [actionCodigo, setActionCodigo] = useState('')
  const [actionDesc, setActionDesc] = useState('')
  const [actionUn, setActionUn] = useState('')
  const [actionCantidad, setActionCantidad] = useState('')
  const [actionVencimiento, setActionVencimiento] = useState('')
  const [actionSinVenc, setActionSinVenc] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionProveedor, setActionProveedor] = useState('')
  // For salida: select which existing product to extract
  const [actionSalidaItem, setActionSalidaItem] = useState<StockEnUbicacion | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchOcupacionCeldas()
      setOcupacion(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar ocupacion', { description: message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Polling every 8 seconds
  useEffect(() => {
    const interval = setInterval(() => load(), 8000)
    return () => clearInterval(interval)
  }, [load])

  // Realtime
  useEffect(() => {
    let ch: ReturnType<typeof supabase.channel> | null = null
    try {
      ch = supabase
        .channel('ocupacion-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'movimientos' }, () => load())
        .subscribe()
    } catch { /* polling covers */ }
    return () => { if (ch) try { supabase.removeChannel(ch) } catch { /* ignore */ } }
  }, [load])

  const filtered = bloqueFilter === 'all' ? ocupacion : ocupacion.filter((o) => o.bloque === bloqueFilter)
  const total = filtered.length
  const occupied = filtered.filter((o) => o.stock > 0).length
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

  function openIngreso(bloque: string, torre: string, piso: string, posicion: string) {
    setDetail(null)
    setActionCell({ bloque, torre, piso, posicion })
    setActionMode('ingreso')
    setActionCodigo('')
    setActionDesc('')
    setActionUn('')
    setActionCantidad('')
    setActionVencimiento('')
    setActionSinVenc(false)
    setActionProveedor('')
  }

  function openSalida(bloque: string, torre: string, piso: string, posicion: string, stockData: StockEnUbicacion[]) {
    setDetail(null)
    setActionCell({ bloque, torre, piso, posicion })
    setActionMode('salida')
    setActionSalidaItem(stockData.length === 1 ? stockData[0] : null)
    setActionCodigo(stockData.length === 1 ? stockData[0].codigo : '')
    setActionDesc(stockData.length === 1 ? stockData[0].descripcion : '')
    setActionUn(stockData.length === 1 ? stockData[0].un : '')
    setActionCantidad('')
    setActionProveedor(stockData.length === 1 ? (stockData[0].proveedor ?? '') : '')
  }

  function handleCatalogoPick(item: CatalogoItem) {
    setActionCodigo(item.codigo)
    setActionDesc(item.descripcion)
    setActionUn(item.un)
  }

  async function handleQuickAction() {
    if (!actionCell || !actionMode || !perfil) return
    if (actionMode === 'ingreso') {
      if (!actionCodigo.trim() || !actionCantidad) {
        toast.error('Completa codigo y cantidad')
        return
      }
      const qty = parseFloat(actionCantidad)
      if (isNaN(qty) || qty <= 0) {
        toast.error('Cantidad invalida')
        return
      }
      setActionBusy(true)
      try {
        // Check occupied
        const details = await stockEnUbicacion(actionCell.bloque, actionCell.torre, actionCell.piso, actionCell.posicion)
        if (details.length > 0) {
          setConfirmOccupied(details)
          setActionBusy(false)
          return
        }
        await doQuickIngreso(qty)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error'
        toast.error('Error', { description: message })
        setActionBusy(false)
      }
    } else if (actionMode === 'salida') {
      if (!actionSalidaItem || !actionCantidad) {
        toast.error('Selecciona producto y cantidad')
        return
      }
      const qty = parseFloat(actionCantidad)
      if (isNaN(qty) || qty <= 0) {
        toast.error('Cantidad invalida')
        return
      }
      if (qty > actionSalidaItem.stock) {
        toast.error('La cantidad excede el stock disponible')
        return
      }
      setActionBusy(true)
      try {
        const movs = await addMovimiento({
          tipo: 'salida',
          bloque: actionCell!.bloque,
          torre: actionCell!.torre,
          piso: actionCell!.piso,
          posicion: actionCell!.posicion,
          codigo: actionSalidaItem.codigo,
          descripcion: actionSalidaItem.descripcion,
          un: actionSalidaItem.un,
          cantidad: qty,
          fVencimiento: actionSalidaItem.fVencimiento ?? '',
          turno: calcularTurno(),
          usuarioId: perfil.id,
          usuarioNombre: perfil.nombre,
          usuarioCorreo: perfil.correo,
          proveedor: actionSalidaItem.proveedor,
        })
        toast.success(`Salida de ${qty} ${actionSalidaItem.un} registrada`)
        closeAction()
        // Refresh occupation data
        const occData = await fetchOcupacionCeldas()
        setOcupacion(occData)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error'
        toast.error('Error al registrar salida', { description: message })
      } finally {
        setActionBusy(false)
      }
    }
  }

  const [confirmOccupied, setConfirmOccupied] = useState<StockEnUbicacion[] | null>(null)

  async function doQuickIngreso(qty: number) {
    if (!actionCell || !perfil) return
    try {
      await addMovimiento({
        tipo: 'ingreso',
        bloque: actionCell.bloque,
        torre: actionCell.torre,
        piso: actionCell.piso,
        posicion: actionCell.posicion,
        codigo: actionCodigo,
        descripcion: actionDesc,
        un: actionUn,
        cantidad: qty,
        fVencimiento: actionSinVenc ? '' : actionVencimiento,
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: actionProveedor || undefined,
      })
      toast.success('Ingreso registrado desde Ocupacion')
      closeAction()
      const occData = await fetchOcupacionCeldas()
      setOcupacion(occData)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar ingreso', { description: message })
    } finally {
      setActionBusy(false)
      setConfirmOccupied(null)
    }
  }

  function closeAction() {
    setActionMode(null)
    setActionCell(null)
    setActionCodigo('')
    setActionDesc('')
    setActionUn('')
    setActionCantidad('')
    setActionVencimiento('')
    setActionSinVenc(false)
    setActionProveedor('')
    setActionSalidaItem(null)
    setConfirmOccupied(null)
  }

  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((o) => ({
        Bloque: o.bloque,
        Torre: o.torre,
        Piso: o.piso,
        Posicion: o.posicion,
        Stock: o.stock,
        Codigos: o.codigos.join(', '),
        Estado: o.stock > 0 ? 'Ocupado' : 'Vacio',
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Ocupacion')
      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_Ocupacion_${fecha}.xlsx`)
      toast.success('Ocupacion exportada')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusyExport(false)
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
      {/* Stats bar */}
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
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="default">{occupied} ocupadas</Badge>
          <Badge variant="secondary">{empty} vacias</Badge>
          <Badge variant="outline">{pct}% ocupacion</Badge>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-green-500 via-blue-500 to-blue-700 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Grid */}
      <div className="space-y-3">
        {BLOQUES.filter((b) => bloqueFilter === 'all' || b === bloqueFilter).map((bloque) => {
          const torres = torresDeBloque(bloque)
          return torres.map((torre) => (
            <div key={`${bloque}-${torre}`} className="rounded-xl border bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">
                  Bloque {bloque} — Torre {torre}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1 text-green-600 border-green-300 hover:bg-green-50"
                    onClick={() => openIngreso(bloque, torre, PISOS[0], posicionesDeBloque(bloque)[0])}
                  >
                    <ArrowDownToLine className="h-3 w-3" /> Ingreso rapido
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {PISOS.map((piso) => (
                  <div key={piso}>
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Piso {piso}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {posicionesDeBloque(bloque).map((pos) => {
                        const cell = ocupacion.find(
                          (o) => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos
                        )
                        const isOccupied = cell && cell.stock > 0
                        return (
                          <button
                            key={pos}
                            className={`relative w-10 h-10 rounded-lg text-xs font-semibold transition-all duration-200 shadow-sm hover:shadow-md hover:scale-105 flex items-center justify-center ${
                              isOccupied
                                ? 'bg-gradient-to-br from-blue-500 to-blue-700 text-white hover:from-blue-600 hover:to-blue-800'
                                : 'bg-gradient-to-br from-green-100 to-green-200 text-green-700 hover:from-green-200 hover:to-green-300 dark:from-green-900 dark:to-green-950 dark:text-green-100'
                            }`}
                            onClick={() => handleCellClick(bloque, torre, piso, pos)}
                            title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOccupied ? ` | ${cell.codigos.join(', ')} (${cell.stock})` : ' | Vacia'}`}
                          >
                            {pos}
                            {isOccupied && (
                              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white dark:bg-gray-800 text-[9px] font-bold text-blue-600 dark:text-blue-400 flex items-center justify-center shadow">
                                {cell.stock > 99 ? '99+' : cell.stock}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        })}
      </div>

      <Button onClick={handleExport} disabled={busyExport} variant="outline" className="gap-2">
        {busyExport ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Exportar
      </Button>

      {/* ═══ DETAIL DIALOG ═══ */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Detalle — B{detail?.bloque} T{detail?.torre} P{detail?.piso} Pos {detail?.posicion}
            </DialogTitle>
          </DialogHeader>
          {detail && detail.stock.length > 0 ? (
            <div className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Codigo</TableHead>
                    <TableHead>Descripcion</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead>Vencimiento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.stock.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono">{s.codigo}</TableCell>
                      <TableCell>{s.descripcion}</TableCell>
                      <TableCell className="text-right font-medium">{s.stock}</TableCell>
                      <TableCell>{s.fVencimiento || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-2">
                <Button
                  className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => openIngreso(detail.bloque, detail.torre, detail.piso, detail.posicion)}
                >
                  <ArrowDownToLine className="h-4 w-4" /> Ingreso aqui
                </Button>
                <Button
                  className="flex-1 gap-2 bg-red-600 hover:bg-red-700 text-white"
                  onClick={() => openSalida(detail.bloque, detail.torre, detail.piso, detail.posicion, detail.stock)}
                >
                  <ArrowUpFromLine className="h-4 w-4" /> Salida aqui
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
                <Info className="h-5 w-5" />
                <span>Ubicacion vacia</span>
              </div>
              <Button
                className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white"
                onClick={() => openIngreso(detail!.bloque, detail!.torre, detail!.piso, detail!.posicion)}
              >
                <ArrowDownToLine className="h-4 w-4" /> Ingreso rapido en esta posicion
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══ QUICK ACTION DIALOG (INGRESO/SALIDA) ═══ */}
      <Dialog open={!!actionMode} onOpenChange={(open) => { if (!open) closeAction() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {actionMode === 'ingreso' ? (
                <><ArrowDownToLine className="h-5 w-5 text-green-600" /> Ingreso rapido</>
              ) : (
                <><ArrowUpFromLine className="h-5 w-5 text-red-600" /> Salida rapida</>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
            <p className="font-medium">
              Ubicacion: B{actionCell?.bloque} T{actionCell?.torre} P{actionCell?.piso} Pos {actionCell?.posicion}
            </p>
            <p className="text-xs text-muted-foreground">Turno: {calcularTurno()} | Usuario: {perfil?.nombre}</p>
          </div>

          {actionMode === 'ingreso' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Buscar codigo</Label>
                <CatalogoSearchInput
                  onPick={handleCatalogoPick}
                  value={actionCodigo}
                  onChange={(v) => {
                    setActionCodigo(v)
                    const cat = findCatalogoByCodigo(v)
                    if (cat) { setActionDesc(cat.descripcion); setActionUn(cat.un) }
                  }}
                />
              </div>
              {actionDesc && (
                <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-2.5 flex items-center justify-between">
                  <span className="text-sm truncate">{actionDesc}</span>
                  <Badge variant="secondary">{actionUn}</Badge>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Cantidad</Label>
                  <Input type="number" step="any" min="0.001" value={actionCantidad} onChange={(e) => setActionCantidad(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Vencimiento</Label>
                  <div className="flex items-center gap-1.5">
                    <Input type="date" value={actionVencimiento} onChange={(e) => setActionVencimiento(e.target.value)} disabled={actionSinVenc} />
                    <Checkbox checked={actionSinVenc} onCheckedChange={(v) => setActionSinVenc(!!v)} />
                  </div>
                </div>
              </div>
              <Button
                onClick={handleQuickAction}
                disabled={actionBusy || !actionCodigo.trim() || !actionCantidad}
                className="w-full bg-green-600 hover:bg-green-700 text-white gap-2"
              >
                {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                Registrar Ingreso
              </Button>
            </div>
          )}

          {actionMode === 'salida' && detail && detail.stock.length > 0 && (
            <div className="space-y-3">
              {detail.stock.length > 1 && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Seleccionar producto</Label>
                  <Select
                    value={actionSalidaItem?.codigo ?? ''}
                    onValueChange={(v) => {
                      const item = detail.stock.find((s) => s.codigo === v)
                      if (item) {
                        setActionSalidaItem(item)
                        setActionCodigo(item.codigo)
                        setActionDesc(item.descripcion)
                        setActionUn(item.un)
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Selecciona producto" /></SelectTrigger>
                    <SelectContent>
                      {detail.stock.map((s, i) => (
                        <SelectItem key={i} value={s.codigo}>
                          {s.codigo} — {s.descripcion} ({s.stock})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {actionSalidaItem && (
                <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-2.5 space-y-1">
                  <p className="text-sm font-medium">{actionSalidaItem.codigo} — {actionSalidaItem.descripcion}</p>
                  <p className="text-xs text-muted-foreground">Stock disponible: {actionSalidaItem.stock} {actionSalidaItem.un}</p>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Cantidad a retirar</Label>
                <Input
                  type="number"
                  step="any"
                  min="0.001"
                  max={actionSalidaItem?.stock}
                  value={actionCantidad}
                  onChange={(e) => setActionCantidad(e.target.value)}
                  placeholder="0"
                />
              </div>
              <Button
                onClick={handleQuickAction}
                disabled={actionBusy || !actionSalidaItem || !actionCantidad}
                className="w-full bg-red-600 hover:bg-red-700 text-white gap-2"
              >
                {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
                Registrar Salida
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══ CONFIRM OCCUPIED (INGRESO) ═══ */}
      <AlertDialog open={!!confirmOccupied} onOpenChange={() => setConfirmOccupied(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ubicacion ocupada</AlertDialogTitle>
            <AlertDialogDescription>
              Esta posicion ya tiene stock de otro articulo. Deseas registrar el ingreso de todas formas?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmOccupied && confirmOccupied.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Codigo</TableHead>
                  <TableHead>Descripcion</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {confirmOccupied.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{s.codigo}</TableCell>
                    <TableCell>{s.descripcion}</TableCell>
                    <TableCell className="text-right font-medium">{s.stock}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => doQuickIngreso(parseFloat(actionCantidad))}>
              Si, registrar ingreso
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
