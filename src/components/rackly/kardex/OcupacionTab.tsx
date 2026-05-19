'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  fetchOcupacionCeldas,
  type OcupacionCelda,
  stockEnUbicacion,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque, totalCeldas } from '@/lib/rackly/ubicaciones'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
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
import { toast } from 'sonner'
import { Download, Loader2, LayoutGrid } from 'lucide-react'

export function OcupacionTab() {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
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
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="default">{occupied} ocupadas</Badge>
          <Badge variant="secondary">{empty} vacías</Badge>
          <Badge variant="outline">{pct}% ocupación</Badge>
        </div>
      </div>

      <div className="space-y-2">
        {BLOQUES.filter((b) => bloqueFilter === 'all' || b === bloqueFilter).map(
          (bloque) => {
            const torres = torresDeBloque(bloque)
            return torres.map((torre) => (
              <div key={`${bloque}-${torre}`} className="space-y-1">
                <p className="text-sm font-medium">
                  Bloque {bloque} — Torre {torre}
                </p>
                <div className="grid grid-cols-4 gap-1">
                  {PISOS.map((piso) => (
                    <div key={piso}>
                      <p className="text-xs text-muted-foreground mb-1">
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
                              className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                                isOccupied
                                  ? 'bg-blue-500 text-white hover:bg-blue-600'
                                  : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-100'
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

      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Detalle — B{detail?.bloque} T{detail?.torre} P{detail?.piso}{' '}
              Pos {detail?.posicion}
            </DialogTitle>
          </DialogHeader>
          {detail && detail.stock.length > 0 ? (
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
                    <TableCell className="text-right font-medium">
                      {s.stock}
                    </TableCell>
                    <TableCell>{s.fVencimiento || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground text-center py-4">
              Ubicación vacía
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
