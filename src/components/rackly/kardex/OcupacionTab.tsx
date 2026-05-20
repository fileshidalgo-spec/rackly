'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  fetchOcupacionCeldas,
  type OcupacionCelda,
  stockEnUbicacion,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
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
} from '@/components/ui/dialog'
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
import { Download, Loader2, MapPin, Building2, Package, Warehouse, FileBarChart } from 'lucide-react'

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
      setDetail({ bloque, torre, piso, posicion, stock: data })
    } catch {
      toast.error('Error al cargar detalle')
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
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-4 w-4 text-blue-500" />
              Detalle de Ubicación
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
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
                        <TableCell className="font-mono text-xs">{s.codigo}</TableCell>
                        <TableCell className="text-xs">{s.descripcion}</TableCell>
                        <TableCell className="text-right font-bold text-xs">
                          <Badge variant="default" className="text-xs">{s.stock}</Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {s.fVencimiento || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
                  <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                    <Package className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-sm font-medium">Ubicación vacía</p>
                  <p className="text-xs">No hay productos en esta posición</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
