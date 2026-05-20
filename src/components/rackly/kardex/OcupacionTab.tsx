'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  fetchOcupacionCeldas,
  fetchMovimientos,
  addMovimiento,
  type OcupacionCelda,
  stockEnUbicacion,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'
import type { CatalogoItem } from '@/lib/rackly/catalogo'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque, totalCeldas, totalCeldasBloque } from '@/lib/rackly/ubicaciones'
import { supabase } from '@/lib/supabase/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Download, Loader2, MapPin, Building2, Package, Warehouse, FileBarChart, ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Search, RotateCcw } from 'lucide-react'
import { CatalogoSearchInput } from './CatalogoSearchInput'

/* ═══════════════════════════════════════════
   TIPO: Reporte por bloque
   ═══════════════════════════════════════════ */
type BloqueReporte = {
  bloque: string
  totalPosiciones: number
  ocupadas: number
  vacias: number
  porcentaje: number
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function buildOccupationMap(data: OcupacionCelda[]) {
  const map = new Map<string, OcupacionCelda>()
  for (const c of data) {
    map.set(`${c.bloque}-${c.torre}-${c.piso}-${c.posicion}`, c)
  }
  return map
}

function calcReporteBloques(
  occMap: Map<string, OcupacionCelda>,
  bloques: string[]
): BloqueReporte[] {
  return bloques.map((b) => {
    const total = totalCeldasBloque(b)
    const torres = torresDeBloque(b)
    const posiciones = posicionesDeBloque(b)
    let ocupadas = 0
    for (const t of torres) {
      for (const p of PISOS) {
        for (const pos of posiciones) {
          const cell = occMap.get(`${b}-${t}-${p}-${pos}`)
          if (cell && cell.stock > 0) ocupadas++
        }
      }
    }
    return {
      bloque: b,
      totalPosiciones: total,
      ocupadas,
      vacias: total - ocupadas,
      porcentaje: total > 0 ? Math.round((ocupadas / total) * 100) : 0,
    }
  })
}

/* ═══════════════════════════════════════════
   COMPONENTE PRINCIPAL
   ═══════════════════════════════════════════ */

export function OcupacionTab() {
  const { perfil } = useAuth()
  const [ocupacion, setOcupacion] = useState<OcupacionCelda[]>([])
  const [bloqueFilter, setBloqueFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [showReport, setShowReport] = useState(false)
  const [detail, setDetail] = useState<{
    bloque: string
    torre: string
    piso: string
    posicion: string
    stock: StockEnUbicacion[]
  } | null>(null)
  const [busyExport, setBusyExport] = useState(false)
  const [busyAction, setBusyAction] = useState(false)
  const [salidaQty, setSalidaQty] = useState<Record<number, string>>({})
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [confirmAction, setConfirmAction] = useState<{
    tipo: 'salida-parcial' | 'salida-total'
    item: StockEnUbicacion
    qty: number
  } | null>(null)
    // Estados para ingreso en celda vacía
  const [ingresoCodigo, setIngresoCodigo] = useState('')
  const [ingresoDescripcion, setIngresoDescripcion] = useState('')
  const [ingresoUn, setIngresoUn] = useState('')
  const [ingresoCantidad, setIngresoCantidad] = useState('')
  const [ingresoFVencimiento, setIngresoFVencimiento] = useState('')
  const [ingresoSinVencimiento, setIngresoSinVencimiento] = useState(false)
  const [ingresoProveedor, setIngresoProveedor] = useState('')
  const [busyIngreso, setBusyIngreso] = useState(false)
  const [showIngresoForm, setShowIngresoForm] = useState(false)
  const [ingresoTipo, setIngresoTipo] = useState<'ingreso' | 'devolucion'>('ingreso')
  const isFirstLoad = useRef(true)

  const load = useCallback(async () => {
    // Solo mostrar spinner en la primera carga
    if (isFirstLoad.current) {
      setLoading(true)
    }
    try {
      const data = await fetchOcupacionCeldas()
      setOcupacion(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      // Solo mostrar error la primera vez
      if (isFirstLoad.current) {
        toast.error('Error al cargar ocupación', { description: message })
      }
    } finally {
      if (isFirstLoad.current) {
        setLoading(false)
        isFirstLoad.current = false
      }
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Polling: refresco automático cada 8 segundos (sin spinner)
  useEffect(() => {
    const interval = setInterval(() => load(), 8000)
    return () => clearInterval(interval)
  }, [load])

  // Realtime: refresco instantáneo cuando cambian movimientos (sin spinner)
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

  // Mapa de ocupación (key → celda)
  const occMap = useMemo(() => buildOccupationMap(ocupacion), [ocupacion])

  // Calcular totales REALES desde la configuración del almacén
  const blocksToShow = bloqueFilter === 'all' ? BLOQUES : BLOQUES.filter((b) => b === bloqueFilter)

  const stats = useMemo(() => {
    let totalPos = 0
    let totalOcupadas = 0
    for (const b of blocksToShow) {
      const total = totalCeldasBloque(b)
      const torres = torresDeBloque(b)
      const posiciones = posicionesDeBloque(b)
      totalPos += total
      for (const t of torres) {
        for (const p of PISOS) {
          for (const pos of posiciones) {
            const cell = occMap.get(`${b}-${t}-${p}-${pos}`)
            if (cell && cell.stock > 0) totalOcupadas++
          }
        }
      }
    }
    return {
      totalPos,
      ocupadas: totalOcupadas,
      vacias: totalPos - totalOcupadas,
      porcentaje: totalPos > 0 ? ((totalOcupadas / totalPos) * 100).toFixed(1) : '0.0',
    }
  }, [occMap, blocksToShow])

  // Reporte por bloque
  const reporte = useMemo(
    () => calcReporteBloques(occMap, BLOQUES),
    [occMap]
  )

  const reporteTotal = useMemo(() => {
    const tPos = reporte.reduce((s, r) => s + r.totalPosiciones, 0)
    const tOcup = reporte.reduce((s, r) => s + r.ocupadas, 0)
    return {
      totalPosiciones: tPos,
      totalOcupadas: tOcup,
      totalVacias: tPos - tOcup,
      porcentaje: tPos > 0 ? ((tOcup / tPos) * 100).toFixed(1) : '0.0',
    }
  }, [reporte])

  async function handleCellClick(
    bloque: string,
    torre: string,
    piso: string,
    posicion: string
  ) {
    try {
      const data = await stockEnUbicacion(bloque, torre, piso, posicion)
      // Ordenar por vencimiento más próximo (sin fecha al final)
      const sorted = [...data].sort((a, b) => {
        const fA = a.fVencimiento || ''
        const fB = b.fVencimiento || ''
        if (!fA && !fB) return 0
        if (!fA) return 1
        if (!fB) return -1
        return fA.localeCompare(fB)
      })
      setDetail({ bloque, torre, piso, posicion, stock: sorted })
      setSalidaQty({})
      setSelectedIdx(null)
      setShowIngresoForm(false)
    } catch {
      toast.error('Error al cargar detalle')
    }
  }

  async function doSalida() {
    if (!confirmAction || !detail || !perfil) return
    const { item, qty } = confirmAction
    setBusyAction(true)
    try {
      const turno = calcularTurno()
      await addMovimiento({
        tipo: 'salida',
        bloque: detail.bloque,
        torre: detail.torre,
        piso: detail.piso,
        posicion: detail.posicion,
        codigo: item.codigo,
        descripcion: item.descripcion,
        un: item.un,
        cantidad: qty,
        fVencimiento: item.fVencimiento ?? '',
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: item.proveedor,
      })
      toast.success(`Salida de ${qty} ${item.un} registrada`)
      setConfirmAction(null)
      setSalidaQty({})
      // Refrescar detalle
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      const sorted = [...data].sort((a, b) => {
        const fA = a.fVencimiento || ''
        const fB = b.fVencimiento || ''
        if (!fA && !fB) return 0
        if (!fA) return 1
        if (!fB) return -1
        return fA.localeCompare(fB)
      })
      setDetail({ ...detail, stock: sorted })
      // Refrescar mapa
      load()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar salida', { description: message })
    } finally {
      setBusyAction(false)
    }
  }

  /* ─── Helpers para ingreso ─── */
  function requiereProveedorIngreso(descripcion: string): boolean {
    const upper = descripcion.toUpperCase()
    return upper.includes('LAMINA') || upper.includes('STRETCH')
  }

  const PROVEEDORES_INGRESO = ['INCOMIN', 'DAMAR', 'DIAMAND', 'NEOPACK', 'SOLPACK', 'ITS']

  function handleCatalogoPickIngreso(item: CatalogoItem) {
    setIngresoCodigo(item.codigo)
    setIngresoDescripcion(item.descripcion)
    setIngresoUn(item.un)
  }

  async function doIngreso() {
    if (!detail || !perfil) return
    if (!ingresoCodigo.trim() || !ingresoCantidad) {
      toast.error('Selecciona un producto e ingresa la cantidad')
      return
    }
    if (requiereProveedorIngreso(ingresoDescripcion) && !ingresoProveedor) {
      toast.error('Selecciona un proveedor para este producto')
      return
    }
    const qty = parseFloat(ingresoCantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('La cantidad debe ser mayor a 0')
      return
    }
    setBusyIngreso(true)
    try {
      const turno = calcularTurno()
      const tipoLabel = ingresoTipo === 'devolucion' ? 'Devolución' : 'Ingreso'
      await addMovimiento({
        tipo: ingresoTipo,
        bloque: detail.bloque,
        torre: detail.torre,
        piso: detail.piso,
        posicion: detail.posicion,
        codigo: ingresoCodigo.trim().toUpperCase(),
        descripcion: ingresoDescripcion,
        un: ingresoUn,
        cantidad: qty,
        fVencimiento: ingresoSinVencimiento ? '' : ingresoFVencimiento,
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: ingresoProveedor || undefined,
      })
      toast.success(`${tipoLabel} de ${qty} ${ingresoUn} registrado en B${detail.bloque}-T${detail.torre}-P${detail.piso}-Pos${detail.posicion}`)
      // Limpiar form
      setIngresoCodigo('')
      setIngresoDescripcion('')
      setIngresoUn('')
      setIngresoCantidad('')
      setIngresoFVencimiento('')
      setIngresoSinVencimiento(false)
      setIngresoProveedor('')
      setShowIngresoForm(false)
      // Refrescar detalle (ahora debería tener stock)
      const data = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      const sorted = [...data].sort((a, b) => {
        const fA = a.fVencimiento || ''
        const fB = b.fVencimiento || ''
        if (!fA && !fB) return 0
        if (!fA) return 1
        if (!fB) return -1
        return fA.localeCompare(fB)
      })
      setDetail({ ...detail, stock: sorted })
      // Refrescar mapa
      load()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar ingreso', { description: message })
    } finally {
      setBusyIngreso(false)
    }
  }

  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')

      // Sheet 1: Reporte por bloque
      const repData = reporte.map((r) => ({
        Bloque: r.bloque,
        'Total Posiciones': r.totalPosiciones,
        Ocupadas: r.ocupadas,
        Vacías: r.vacias,
        'Ocupación %': `${r.porcentaje}%`,
      }))
      // Agregar fila total
      repData.push({
        Bloque: 'TOTAL',
        'Total Posiciones': reporteTotal.totalPosiciones,
        Ocupadas: reporteTotal.totalOcupadas,
        Vacías: reporteTotal.totalVacias,
        'Ocupación %': `${reporteTotal.porcentaje}%`,
      })
      const ws1 = XLSX.utils.json_to_sheet(repData)
      XLSX.utils.book_append_sheet(XLSX.utils.book_new(), ws1, 'Reporte')

      // Sheet 2: Detalle de celdas
      const celdaData = ocupacion.map((o) => ({
        Bloque: o.bloque,
        Torre: o.torre,
        Piso: o.piso,
        Posición: o.posicion,
        Stock: o.stock,
        Códigos: o.codigos.join(', '),
        Estado: o.stock > 0 ? 'Ocupado' : 'Vacío',
      }))
      const ws2 = XLSX.utils.json_to_sheet(celdaData)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws1, 'Reporte')
      XLSX.utils.book_append_sheet(wb, ws2, 'Detalle Celdas')

      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_Ocupacion_${fecha}.xlsx`)
      toast.success('Reporte exportado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusyExport(false)
    }
  }

  /* ═══════════════════════════════════════════
     LOADING (solo primera vez)
     ═══════════════════════════════════════════ */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Cargando mapa de ubicaciones...</p>
      </div>
    )
  }

  /* ═══════════════════════════════════════════
     VISTA REPORTE
     ═══════════════════════════════════════════ */
  if (showReport) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileBarChart className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-lg font-bold text-foreground">Reporte de Ocupación</h2>
            </div>
            <p className="text-sm text-muted-foreground">Resumen de vacías y ocupadas por bloque y total del kardex.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowReport(false)} className="gap-1.5">
            Ver mapa
          </Button>
        </div>

        {/* Resumen total */}
        <div className="rounded-lg border bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 p-4">
          <h3 className="text-sm font-bold mb-3 text-blue-800 dark:text-blue-200">Resumen Total Kardex</h3>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-foreground">{reporteTotal.totalPosiciones}</p>
              <p className="text-xs text-muted-foreground">Total Posiciones</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{reporteTotal.totalOcupadas}</p>
              <p className="text-xs text-muted-foreground">Ocupadas</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{reporteTotal.totalVacias}</p>
              <p className="text-xs text-muted-foreground">Vacías</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{reporteTotal.porcentaje}%</p>
              <p className="text-xs text-muted-foreground">Ocupación</p>
            </div>
          </div>
        </div>

        {/* Tabla por bloque */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Bloque</TableHead>
                <TableHead className="text-right">Total Pos.</TableHead>
                <TableHead className="text-right">Ocupadas</TableHead>
                <TableHead className="text-right">Vacías</TableHead>
                <TableHead className="w-48">Ocupación</TableHead>
                <TableHead className="text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reporte.map((r) => (
                <TableRow key={r.bloque}>
                  <TableCell className="font-bold">Bloque {r.bloque}</TableCell>
                  <TableCell className="text-right">{r.totalPosiciones}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
                      {r.ocupadas}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800">
                      {r.vacias}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${r.porcentaje > 80 ? 'bg-red-500' : r.porcentaje > 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                          style={{ width: `${r.porcentaje}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-bold">{r.porcentaje}%</TableCell>
                </TableRow>
              ))}
              {/* Fila total */}
              <TableRow className="font-bold border-t-2">
                <TableCell className="font-bold">TOTAL</TableCell>
                <TableCell className="text-right">{reporteTotal.totalPosiciones}</TableCell>
                <TableCell className="text-right">{reporteTotal.totalOcupadas}</TableCell>
                <TableCell className="text-right">{reporteTotal.totalVacias}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${Number(reporteTotal.porcentaje) > 80 ? 'bg-red-500' : Number(reporteTotal.porcentaje) > 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                        style={{ width: `${reporteTotal.porcentaje}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right">{reporteTotal.porcentaje}%</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <Button onClick={handleExport} disabled={busyExport} variant="outline" className="gap-2">
          {busyExport ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Exportar Excel
        </Button>
      </div>
    )
  }

  /* ═══════════════════════════════════════════
     VISTA MAPA VISUAL
     ═══════════════════════════════════════════ */
  return (
    <div className="space-y-5">
      {/* ─── Header ─── */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-bold text-foreground">Mapa Visual del Kardex</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Mapa visual de bloques, torres, pisos y posiciones.{' '}
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Verde = vacío
          </span>
          {', '}
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" /> Azul = ocupado
          </span>
          {', '}
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> Múltiples códigos
          </span>
          .
        </p>
      </div>

      {/* ─── Controles superiores ─── */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={bloqueFilter} onValueChange={setBloqueFilter}>
            <SelectTrigger className="w-[140px] h-9">
              <SelectValue placeholder="Bloque" />
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReport(true)}
            className="gap-1.5 h-9 text-xs"
          >
            <FileBarChart className="h-3.5 w-3.5" />
            Reporte
          </Button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-green-700 dark:text-green-400 font-medium">Vacías: {stats.vacias}</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <span className="text-blue-700 dark:text-blue-400 font-medium">Ocupadas: {stats.ocupadas}</span>
          </div>
          <span className="text-sm text-muted-foreground font-medium">Ocupación: {stats.porcentaje}%</span>
          <span className="text-sm text-muted-foreground">({stats.totalPos} posiciones)</span>
          <Button
            onClick={handleExport}
            disabled={busyExport}
            variant="outline"
            size="sm"
            className="gap-1.5 h-8 text-xs"
          >
            {busyExport ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Exportar Excel
          </Button>
        </div>
      </div>

      {/* ─── Barras de progreso por bloque ─── */}
      {bloqueFilter === 'all' && (
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
          {BLOQUES.map((b) => {
            const r = reporte.find((x) => x.bloque === b)
            if (!r) return null
            return (
              <button
                key={b}
                onClick={() => setBloqueFilter(b)}
                className="group relative flex flex-col items-center gap-1 p-2 rounded-lg border border-border hover:border-blue-300 hover:bg-blue-50/50 dark:hover:border-blue-700 dark:hover:bg-blue-950/30 transition-all cursor-pointer"
              >
                <span className="text-xs font-semibold text-foreground">B-{b}</span>
                <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${r.porcentaje > 80 ? 'bg-red-500' : r.porcentaje > 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                    style={{ width: `${r.porcentaje}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">{r.porcentaje}%</span>
              </button>
            )
          })}
        </div>
      )}

      {/* ─── Mapa visual por bloques ─── */}
      <div className="space-y-6">
        {blocksToShow.map((bloque) => {
          const torres = torresDeBloque(bloque)
          const posiciones = posicionesDeBloque(bloque)
          const bReporte = reporte.find((r) => r.bloque === bloque)

          return (
            <div key={bloque} className="space-y-3">
              {/* Header del bloque */}
              <div className="flex items-center gap-2 pb-2 border-b border-border">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-bold text-foreground">Bloque {bloque}</h3>
                {bReporte && (
                  <div className="ml-auto flex items-center gap-2">
                    <Badge variant="outline" className="text-xs h-5 bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800">
                      {bReporte.vacias} vacías
                    </Badge>
                    <Badge variant="outline" className="text-xs h-5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
                      {bReporte.ocupadas} ocupadas
                    </Badge>
                    <span className="text-xs text-muted-foreground">({bReporte.porcentaje}%)</span>
                  </div>
                )}
              </div>

              {/* Torres lado a lado */}
              <div className={`grid gap-4 ${torres.length === 1 ? 'grid-cols-1 max-w-2xl' : 'grid-cols-1 lg:grid-cols-2'}`}>
                {torres.map((torre) => (
                  <div key={torre} className="space-y-2">
                    {/* Header torre */}
                    <div className="flex items-center gap-2">
                      <Warehouse className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                        Torre {torre}
                      </span>
                    </div>

                    {/* Pisos */}
                    <div className="space-y-2">
                      {[...PISOS].reverse().map((piso) => {
                        // Calcular ocupación de este piso
                        let pisoOcupadas = 0
                        for (const pos of posiciones) {
                          const cell = occMap.get(`${bloque}-${torre}-${piso}-${pos}`)
                          if (cell && cell.stock > 0) pisoOcupadas++
                        }

                        return (
                          <div key={piso} className="space-y-1">
                            {/* Label del piso */}
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-semibold text-muted-foreground w-12">
                                Piso {piso}
                              </span>
                              {pisoOcupadas > 0 && (
                                <span className="text-[10px] text-blue-500 font-medium">
                                  ({pisoOcupadas}/{posiciones.length})
                                </span>
                              )}
                            </div>

                            {/* Grilla de posiciones — 2 filas de 10 */}
                            <div className="space-y-1">
                              {Array.from({ length: Math.ceil(posiciones.length / 10) }, (_, rowIdx) => {
                                const rowPos = posiciones.slice(rowIdx * 10, rowIdx * 10 + 10)
                                return (
                                  <div key={rowIdx} className="grid grid-cols-10 gap-1">
                                    {rowPos.map((pos) => {
                                      const cell = occMap.get(`${bloque}-${torre}-${piso}-${pos}`)
                                      const isOccupied = !!cell && cell.stock > 0
                                      const isMulti = isOccupied && cell!.codigos.length > 1
                                      const stockVal = cell ? cell.stock : 0

                                      return (
                                        <button
                                          key={pos}
                                          title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOccupied ? ` | Stock: ${stockVal} | ${cell!.codigos.join(', ')}` : ' | Vacía'}`}
                                          onClick={() =>
                                            handleCellClick(bloque, torre, piso, pos)
                                          }
                                          className={`
                                            relative flex items-center justify-center
                                            h-8 rounded-md text-[11px] font-semibold
                                            transition-all duration-150 cursor-pointer
                                            shadow-sm hover:shadow-md hover:scale-105 hover:z-10
                                            ${isOccupied
                                              ? isMulti
                                                ? 'bg-amber-500 text-white hover:bg-amber-600 ring-1 ring-amber-300 dark:ring-amber-700'
                                                : 'bg-blue-500 text-white hover:bg-blue-600'
                                              : 'bg-green-500 text-white hover:bg-green-600'
                                            }
                                          `}
                                        >
                                          {pos}
                                          {isMulti && (
                                            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-orange-500 border border-white dark:border-gray-800 flex items-center justify-center">
                                              <span className="text-[7px] font-bold">{cell!.codigos.length}</span>
                                            </span>
                                          )}
                                        </button>
                                      )
                                    })}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* ─── Botón volver (cuando se filtra por bloque) ─── */}
      {bloqueFilter !== 'all' && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBloqueFilter('all')}
            className="gap-1.5"
          >
            Ver todos los bloques
          </Button>
        </div>
      )}

      {/* ─── Dialog de detalle ─── */}
      <Dialog open={!!detail} onOpenChange={() => { setDetail(null); setSalidaQty({}); setSelectedIdx(null); setIngresoCodigo(''); setIngresoDescripcion(''); setIngresoUn(''); setIngresoCantidad(''); setIngresoFVencimiento(''); setIngresoSinVencimiento(false); setIngresoProveedor(''); setShowIngresoForm(false) }}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4 text-blue-500" />
              Detalle de Ubicación
            </DialogTitle>
            <DialogDescription>
              Productos en esta posición, ordenados por vencimiento más próximo.
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              {/* Info de ubicación */}
              <div className="rounded-lg border bg-muted/50 p-3 grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Bloque</p>
                  <p className="text-sm font-bold">{detail.bloque}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Torre</p>
                  <p className="text-sm font-bold">{detail.torre}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Piso</p>
                  <p className="text-sm font-bold">{detail.piso}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Posición</p>
                  <p className="text-sm font-bold">{detail.posicion}</p>
                </div>
              </div>

              {detail.stock.length > 0 ? (
                <>
                  {/* ── Vista selector + tarjeta (móvil) ── */}
                  <div className="sm:hidden space-y-3">
                    {/* Selector de artículo - siempre visible cuando hay 2+ */}
                    {detail.stock.length >= 2 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Selecciona un artículo ({detail.stock.length} en esta ubicación)
                        </p>
                        <div className="space-y-1.5">
                          {detail.stock.map((s, i) => {
                            const dias = s.fVencimiento
                              ? Math.ceil((new Date(s.fVencimiento).getTime() - Date.now()) / 86400000)
                              : null
                            const isSelected = selectedIdx === i
                            return (
                              <button
                                key={i}
                                onClick={() => {
                                  setSelectedIdx(isSelected ? null : i)
                                  setSalidaQty({})
                                }}
                                className={`
                                  w-full text-left rounded-lg border-2 p-2.5 transition-all
                                  ${isSelected
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                                    : 'border-border bg-card hover:border-blue-300 dark:hover:border-blue-700'
                                  }
                                `}
                              >
                                <div className="flex items-center gap-2">
                                  <div className={`
                                    shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center
                                    ${isSelected ? 'border-blue-500 bg-blue-500' : 'border-muted-foreground/40'}
                                  `}>
                                    {isSelected && <Check className="h-3 w-3 text-white" />}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="font-mono font-bold text-sm text-foreground">{s.codigo}</p>
                                    <p className="text-[11px] text-muted-foreground line-clamp-2 leading-tight">{s.descripcion}</p>
                                  </div>
                                  <div className="shrink-0 flex flex-col items-end gap-1">
                                    <Badge variant="default" className="text-xs font-bold">{s.stock} {s.un}</Badge>
                                    {dias !== null ? (
                                      <Badge
                                        variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'}
                                        className={`text-[10px] ${dias <= 15 && dias > 0 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}`}
                                      >
                                        {dias <= 0 ? 'Vencido' : `${dias}d`}
                                      </Badge>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground">—</span>
                                    )}
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Tarjeta de salida - solo para el seleccionado (o el único) */}
                    {detail.stock.map((s, i) => {
                      const showCard = detail.stock.length === 1
                        ? true
                        : selectedIdx === i
                      if (!showCard) return null

                      const dias = s.fVencimiento
                        ? Math.ceil((new Date(s.fVencimiento).getTime() - Date.now()) / 86400000)
                        : null

                      return (
                        <div key={i} className="rounded-xl border-2 border-blue-200 dark:border-blue-800 bg-card p-3 space-y-3">
                          {/* Info del producto seleccionado */}
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0">
                              <Package className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-mono font-bold text-sm text-foreground">{s.codigo}</p>
                              <p className="text-[11px] text-muted-foreground line-clamp-2 leading-tight">{s.descripcion}</p>
                            </div>
                            {dias !== null ? (
                              <Badge
                                variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'}
                                className={`shrink-0 ${dias <= 15 && dias > 0 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}`}
                              >
                                {dias <= 0 ? 'Vencido' : `${dias}d`}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs shrink-0">—</span>
                            )}
                          </div>

                          {/* Stock disponible - grande y claro */}
                          <div className="flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2.5">
                            <Package className="h-4 w-4 text-blue-500 shrink-0" />
                            <span className="text-xs text-muted-foreground">Stock disponible:</span>
                            <span className="text-xl font-bold text-foreground ml-auto">{s.stock}</span>
                            <span className="text-xs text-muted-foreground font-medium">{s.un}</span>
                          </div>

                          {/* Campo de cantidad para salida parcial */}
                          <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                              Cantidad a retirar ({s.un})
                            </label>
                            <Input
                              type="number"
                              step="any"
                              min="0.001"
                              max={s.stock}
                              value={salidaQty[i] || ''}
                              onChange={(e) => setSalidaQty((prev) => ({ ...prev, [i]: e.target.value }))}
                              placeholder="0"
                              className="h-14 text-xl font-bold text-center"
                            />
                            {/* Indicador si excede stock */}
                            {salidaQty[i] && parseFloat(salidaQty[i]) > s.stock && (
                              <p className="text-xs text-red-500 font-medium flex items-center gap-1">
                                ⚠ Excede el stock disponible ({s.stock} {s.un})
                              </p>
                            )}
                          </div>

                          {/* Botones de acción */}
                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              variant="destructive"
                              className="h-12 text-sm font-bold rounded-lg"
                              disabled={busyAction || !salidaQty[i] || (salidaQty[i] ? parseFloat(salidaQty[i]) > s.stock : false)}
                              onClick={() => {
                                const qtyNum = parseFloat(salidaQty[i] || '')
                                if (!qtyNum || qtyNum <= 0) {
                                  toast.error('Ingresa una cantidad válida')
                                  return
                                }
                                if (qtyNum > s.stock) {
                                  toast.error('La cantidad excede el stock')
                                  return
                                }
                                setConfirmAction({ tipo: 'salida-parcial', item: s, qty: qtyNum })
                              }}
                            >
                              <ArrowUpFromLine className="h-4 w-4 mr-1.5" />
                              Salida Parcial
                            </Button>
                            <Button
                              variant="outline"
                              className="h-12 text-sm font-bold rounded-lg border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-800"
                              disabled={busyAction}
                              onClick={() => {
                                setConfirmAction({ tipo: 'salida-total', item: s, qty: s.stock })
                              }}
                            >
                              <ArrowUpFromLine className="h-4 w-4 mr-1.5" />
                              Salida Total
                            </Button>
                          </div>
                        </div>
                      )
                    })}

                    {/* Indicador cuando hay 2+ y no se ha seleccionado */}
                    {detail.stock.length >= 2 && selectedIdx === null && (
                      <div className="flex flex-col items-center gap-1.5 py-4 text-muted-foreground">
                        <ChevronRight className="h-5 w-5 animate-pulse" />
                        <p className="text-xs font-medium">Toca un artículo arriba para dar salida</p>
                      </div>
                    )}
                  </div>

                  {/* ── Vista tabla (desktop) ── */}
                  <div className="hidden sm:block overflow-x-auto -mx-1 px-1">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Código</TableHead>
                          <TableHead className="text-xs">Stock</TableHead>
                          <TableHead className="text-xs">Vencim.</TableHead>
                          <TableHead className="text-xs w-32">Salida</TableHead>
                          <TableHead className="text-xs w-36">Acción</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.stock.map((s, i) => {
                          const dias = s.fVencimiento
                            ? Math.ceil((new Date(s.fVencimiento).getTime() - Date.now()) / 86400000)
                            : null
                          return (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-xs py-2 px-1.5">
                                <div>
                                  <span className="font-semibold">{s.codigo}</span>
                                  <p className="text-[10px] text-muted-foreground truncate max-w-[150px]" title={s.descripcion}>
                                    {s.descripcion}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-bold text-xs py-2 px-1.5">
                                <Badge variant="default" className="text-xs">{s.stock} {s.un}</Badge>
                              </TableCell>
                              <TableCell className="text-xs py-2 px-1.5 whitespace-nowrap">
                                {dias !== null ? (
                                  <Badge
                                    variant={dias <= 0 ? 'destructive' : dias <= 15 ? 'outline' : 'secondary'}
                                    className={dias <= 0 ? '' : dias <= 15 ? 'border-orange-300 text-orange-700 dark:text-orange-400' : ''}
                                  >
                                    {dias <= 0 ? 'Vencido' : `${dias}d`}
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="py-2 px-1">
                                <Input
                                  type="number"
                                  step="any"
                                  min="0.001"
                                  max={s.stock}
                                  value={salidaQty[i] || ''}
                                  onChange={(e) => setSalidaQty((prev) => ({ ...prev, [i]: e.target.value }))}
                                  placeholder={`Máx ${s.stock}`}
                                  className="h-9 text-sm"
                                />
                              </TableCell>
                              <TableCell className="py-2 px-1">
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    className="flex-1 h-8 text-xs px-2"
                                    disabled={busyAction || !salidaQty[i]}
                                    onClick={() => {
                                      const qtyNum = parseFloat(salidaQty[i] || '')
                                      if (!qtyNum || qtyNum <= 0) {
                                        toast.error('Ingresa una cantidad válida')
                                        return
                                      }
                                      if (qtyNum > s.stock) {
                                        toast.error('La cantidad excede el stock')
                                        return
                                      }
                                      setConfirmAction({ tipo: 'salida-parcial', item: s, qty: qtyNum })
                                    }}
                                  >
                                    Parcial
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="flex-1 h-8 text-xs px-2 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                                    disabled={busyAction}
                                    onClick={() => {
                                      setConfirmAction({ tipo: 'salida-total', item: s, qty: s.stock })
                                    }}
                                  >
                                    Todo ({s.stock})
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Las ubicaciones con stock 0 desaparecen automáticamente.
                  </p>

                  {/* Botón para agregar otro código */}
                  {!showIngresoForm && (
                    <Button
                      variant="outline"
                      className="w-full h-11 border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-950/30 text-sm font-bold rounded-lg gap-2"
                      onClick={() => setShowIngresoForm(true)}
                    >
                      <ArrowDownToLine className="h-4 w-4" />
                      Agregar otro código a esta ubicación
                    </Button>
                  )}

                  {/* Formulario de ingreso/devolución (mostrar cuando se activa desde celda ocupada o vacía) */}
                  {showIngresoForm && (
                    <div className="space-y-4 pt-2 border-t border-border">
                      <div className="flex items-center justify-between">
                        {/* Toggle tipo: ingreso / devolución */}
                        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                          <button
                            onClick={() => setIngresoTipo('ingreso')}
                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              ingresoTipo === 'ingreso'
                                ? 'bg-green-600 text-white shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <ArrowDownToLine className="h-3 w-3" />
                            Ingreso
                          </button>
                          <button
                            onClick={() => setIngresoTipo('devolucion')}
                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              ingresoTipo === 'devolucion'
                                ? 'bg-amber-600 text-white shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Devolución
                          </button>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground"
                          onClick={() => {
                            setShowIngresoForm(false)
                            setIngresoCodigo('')
                            setIngresoDescripcion('')
                            setIngresoUn('')
                            setIngresoCantidad('')
                            setIngresoFVencimiento('')
                            setIngresoSinVencimiento(false)
                            setIngresoProveedor('')
                            setIngresoTipo('ingreso')
                          }}
                        >
                          Cancelar
                        </Button>
                      </div>

                      {/* Búsqueda de producto */}
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Search className="h-3.5 w-3.5" />
                          Buscar producto
                        </Label>
                        <CatalogoSearchInput
                          onPick={handleCatalogoPickIngreso}
                          value={ingresoCodigo}
                          onChange={(v) => {
                            setIngresoCodigo(v)
                            const cat = findCatalogoByCodigo(v)
                            if (cat) {
                              setIngresoDescripcion(cat.descripcion)
                              setIngresoUn(cat.un)
                            }
                          }}
                        />
                      </div>

                      {/* Info del producto seleccionado */}
                      {ingresoDescripcion && (
                        <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-2">
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[10px] text-muted-foreground uppercase">Código</p>
                              <p className="font-mono font-bold text-sm text-foreground">{ingresoCodigo}</p>
                            </div>
                            <div className="min-w-[60px] text-right">
                              <p className="text-[10px] text-muted-foreground uppercase">UN</p>
                              <p className="font-bold text-sm text-foreground">{ingresoUn || '—'}</p>
                            </div>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase">Descripción</p>
                            <p className="text-sm text-foreground leading-snug">{ingresoDescripcion}</p>
                          </div>
                        </div>
                      )}

                      {/* Cantidad y vencimiento */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            Cantidad ({ingresoUn || '—'})
                          </Label>
                          <Input
                            type="number"
                            step="any"
                            min="0.001"
                            value={ingresoCantidad}
                            onChange={(e) => setIngresoCantidad(e.target.value)}
                            placeholder="0"
                            className="h-12 text-lg font-bold text-center"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            Vencimiento
                          </Label>
                          <Input
                            type="date"
                            value={ingresoFVencimiento}
                            onChange={(e) => setIngresoFVencimiento(e.target.value)}
                            disabled={ingresoSinVencimiento}
                            className="h-12 text-sm"
                          />
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <Checkbox
                              checked={ingresoSinVencimiento}
                              onCheckedChange={(v) => setIngresoSinVencimiento(!!v)}
                            />
                            <span className="text-[11px] text-muted-foreground">Sin vencimiento</span>
                          </label>
                        </div>
                      </div>

                      {/* Proveedor (solo para LAMINA/STRETCH) */}
                      {requiereProveedorIngreso(ingresoDescripcion) && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            Proveedor <span className="text-red-500">*</span>
                          </Label>
                          <Select value={ingresoProveedor} onValueChange={setIngresoProveedor}>
                            <SelectTrigger className="h-11">
                              <SelectValue placeholder="Selecciona proveedor" />
                            </SelectTrigger>
                            <SelectContent>
                              {PROVEEDORES_INGRESO.map((p) => (
                                <SelectItem key={p} value={p}>{p}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Botón registrar */}
                      <Button
                        onClick={doIngreso}
                        disabled={busyIngreso || !ingresoCodigo.trim() || !ingresoCantidad}
                        className={`w-full h-12 text-white text-sm font-bold rounded-lg ${ingresoTipo === 'devolucion' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'}`}
                      >
                        {busyIngreso ? (
                          <span className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Registrando...
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-2">
                            {ingresoTipo === 'devolucion' ? <RotateCcw className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
                            {ingresoTipo === 'devolucion' ? 'Registrar Devolución' : 'Registrar Ingreso'}
                          </span>
                        )}
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                /* ── Celda vacía: Formulario de ingreso/devolución ── */
                <div className="space-y-4">
                  {/* Indicador vacía + acción */}
                  <div className={`flex items-center gap-2 rounded-lg px-3 py-2.5 border ${
                    ingresoTipo === 'devolucion'
                      ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
                      : 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
                  }`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      ingresoTipo === 'devolucion' ? 'bg-amber-100 dark:bg-amber-900' : 'bg-green-100 dark:bg-green-900'
                    }`}>
                      {ingresoTipo === 'devolucion'
                        ? <RotateCcw className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        : <ArrowDownToLine className="h-4 w-4 text-green-600 dark:text-green-400" />}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${ingresoTipo === 'devolucion' ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300'}`}>
                        Ubicación vacía
                      </p>
                      <p className={`text-xs ${ingresoTipo === 'devolucion' ? 'text-amber-600/70 dark:text-amber-400/70' : 'text-green-600/70 dark:text-green-400/70'}`}>
                        Registra un ingreso o devolución de mercadería
                      </p>
                    </div>
                  </div>

                  {/* Toggle tipo: ingreso / devolución */}
                  <div className="flex items-center justify-center">
                    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                      <button
                        onClick={() => setIngresoTipo('ingreso')}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-all ${
                          ingresoTipo === 'ingreso'
                            ? 'bg-green-600 text-white shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <ArrowDownToLine className="h-3.5 w-3.5" />
                        Ingreso
                      </button>
                      <button
                        onClick={() => setIngresoTipo('devolucion')}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-all ${
                          ingresoTipo === 'devolucion'
                            ? 'bg-amber-600 text-white shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Devolución
                      </button>
                    </div>
                  </div>

                  {/* Búsqueda de producto */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <Search className="h-3.5 w-3.5" />
                      Buscar producto
                    </Label>
                    <CatalogoSearchInput
                      onPick={handleCatalogoPickIngreso}
                      value={ingresoCodigo}
                      onChange={(v) => {
                        setIngresoCodigo(v)
                        const cat = findCatalogoByCodigo(v)
                        if (cat) {
                          setIngresoDescripcion(cat.descripcion)
                          setIngresoUn(cat.un)
                        }
                      }}
                    />
                  </div>

                  {/* Info del producto seleccionado */}
                  {ingresoDescripcion && (
                    <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-2">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] text-muted-foreground uppercase">Código</p>
                          <p className="font-mono font-bold text-sm text-foreground">{ingresoCodigo}</p>
                        </div>
                        <div className="min-w-[60px] text-right">
                          <p className="text-[10px] text-muted-foreground uppercase">UN</p>
                          <p className="font-bold text-sm text-foreground">{ingresoUn || '—'}</p>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase">Descripción</p>
                        <p className="text-sm text-foreground leading-snug">{ingresoDescripcion}</p>
                      </div>
                    </div>
                  )}

                  {/* Cantidad y vencimiento */}
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Cantidad ({ingresoUn || '—'})
                        </Label>
                        <Input
                          type="number"
                          step="any"
                          min="0.001"
                          value={ingresoCantidad}
                          onChange={(e) => setIngresoCantidad(e.target.value)}
                          placeholder="0"
                          className="h-12 text-lg font-bold text-center"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Vencimiento
                        </Label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="date"
                            value={ingresoFVencimiento}
                            onChange={(e) => setIngresoFVencimiento(e.target.value)}
                            disabled={ingresoSinVencimiento}
                            className="h-12 text-sm"
                          />
                        </div>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <Checkbox
                            checked={ingresoSinVencimiento}
                            onCheckedChange={(v) => setIngresoSinVencimiento(!!v)}
                          />
                          <span className="text-[11px] text-muted-foreground">Sin vencimiento</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Proveedor (solo para LAMINA/STRETCH) */}
                  {requiereProveedorIngreso(ingresoDescripcion) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Proveedor <span className="text-red-500">*</span>
                      </Label>
                      <Select value={ingresoProveedor} onValueChange={setIngresoProveedor}>
                        <SelectTrigger className="h-11">
                          <SelectValue placeholder="Selecciona proveedor" />
                        </SelectTrigger>
                        <SelectContent>
                          {PROVEEDORES_INGRESO.map((p) => (
                            <SelectItem key={p} value={p}>{p}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Botón registrar */}
                  <Button
                    onClick={doIngreso}
                    disabled={busyIngreso || !ingresoCodigo.trim() || !ingresoCantidad}
                    className={`w-full h-12 text-white text-sm font-bold rounded-lg ${ingresoTipo === 'devolucion' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'}`}
                  >
                    {busyIngreso ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Registrando...
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        {ingresoTipo === 'devolucion' ? <RotateCcw className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
                        {ingresoTipo === 'devolucion' ? 'Registrar Devolución' : 'Registrar Ingreso'}
                      </span>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Diálogo de confirmación de salida ─── */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
        <AlertDialogContent className="max-w-[95vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <ArrowUpFromLine className="h-5 w-5 text-red-500" />
              {confirmAction?.tipo === 'salida-total' ? 'Retirar todo el stock' : 'Confirmar salida parcial'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p className="text-sm">¿Estás seguro de registrar esta salida?</p>
                {confirmAction && (
                  <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-4 space-y-3">
                    {/* Producto */}
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">Producto</p>
                      <p className="font-mono font-bold text-sm">{confirmAction.item.codigo}</p>
                      <p className="text-xs text-muted-foreground">{confirmAction.item.descripcion}</p>
                    </div>

                    <div className="border-t border-red-200/60 dark:border-red-800/60" />

                    {/* Cantidades */}
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">Stock actual:</span>
                        <span className="font-bold text-base">{confirmAction.item.stock} {confirmAction.item.un}</span>
                      </div>
                      <div className="flex justify-between items-center rounded-lg bg-red-100 dark:bg-red-900/40 px-3 py-2">
                        <span className="text-sm font-medium text-red-700 dark:text-red-300">Cantidad a retirar:</span>
                        <span className="font-bold text-xl text-red-600 dark:text-red-400">{confirmAction.qty} {confirmAction.item.un}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">Stock después:</span>
                        <span className={`font-bold text-base ${confirmAction.item.stock - confirmAction.qty === 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                          {confirmAction.item.stock - confirmAction.qty} {confirmAction.item.un}
                        </span>
                      </div>
                    </div>

                    {confirmAction.item.stock - confirmAction.qty === 0 && (
                      <p className="text-xs text-red-500 font-medium bg-red-100 dark:bg-red-900/30 rounded-lg px-2.5 py-1.5">
                        La ubicación quedará vacía después de esta salida.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto h-11">No, cancelar</AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doSalida() }}
              disabled={busyAction}
              className="w-full sm:w-auto h-11 bg-red-600 hover:bg-red-700 text-white font-bold text-sm"
            >
              {busyAction ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Procesando...
                </span>
              ) : (
                'Sí, confirmar salida'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
