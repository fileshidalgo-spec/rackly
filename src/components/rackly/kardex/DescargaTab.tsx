'use client'

import { useState, useMemo } from 'react'
import type { Movimiento } from '@/lib/rackly/kardex'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  Download,
  Loader2,
  Search,
  Users,
  FilterX,
  FileSpreadsheet,
  PackageSearch,
} from 'lucide-react'

type Props = {
  movimientos: Movimiento[]
}

export function DescargaTab({ movimientos }: Props) {
  const [filtroCodigo, setFiltroCodigo] = useState('')
  const [filtroUsuario, setFiltroUsuario] = useState('')
  const [filtroTipo, setFiltroTipo] = useState<string>('todos')
  const [busy, setBusy] = useState(false)

  const tieneFiltros = filtroCodigo.trim() !== '' || filtroUsuario.trim() !== '' || filtroTipo !== 'todos'

  /* ─── Lista única de usuarios ─── */
  const usuariosUnicos = useMemo(() => {
    const set = new Set<string>()
    for (const m of movimientos) {
      if (m.usuarioNombre) set.add(m.usuarioNombre)
    }
    return Array.from(set).sort()
  }, [movimientos])

  /* ─── Movimientos filtrados ─── */
  const filtrados = useMemo(() => {
    let data = movimientos
    if (filtroCodigo.trim()) {
      const q = filtroCodigo.trim().toUpperCase()
      data = data.filter((m) => m.codigo.toUpperCase().includes(q))
    }
    if (filtroUsuario.trim()) {
      const q = filtroUsuario.trim().toUpperCase()
      data = data.filter((m) =>
        (m.usuarioNombre || '').toUpperCase().includes(q) ||
        (m.usuarioCorreo || '').toUpperCase().includes(q)
      )
    }
    if (filtroTipo !== 'todos') {
      data = data.filter((m) => m.tipo === filtroTipo)
    }
    return data
  }, [movimientos, filtroCodigo, filtroUsuario, filtroTipo])

  /* ─── Stock calculado desde los movimientos filtrados ─── */
  const stockData = useMemo(() => {
    const locMap = new Map<string, {
      codigo: string
      descripcion: string
      un: string
      bloque: string
      torre: string
      piso: string
      posicion: string
      stock: number
    }>()
    for (const m of filtrados) {
      const key = `${m.codigo}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const existing = locMap.get(key)
      if (existing) {
        if (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado') {
          existing.stock += m.cantidad
        } else {
          existing.stock -= m.cantidad
        }
      } else {
        locMap.set(key, {
          codigo: m.codigo,
          descripcion: m.descripcion,
          un: m.un,
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: (m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado') ? m.cantidad : -m.cantidad,
        })
      }
    }
    return Array.from(locMap.values()).filter((s) => s.stock > 0)
  }, [filtrados])

  function limpiarFiltros() {
    setFiltroCodigo('')
    setFiltroUsuario('')
    setFiltroTipo('todos')
  }

  /* ─── Exportar ─── */
  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Sheet 1: Movimientos filtrados
      const movData = filtrados.map((m) => ({
        Tipo: m.tipo,
        Bloque: m.bloque,
        Torre: m.torre,
        Piso: m.piso,
        Posición: m.posicion,
        Código: m.codigo,
        Descripción: m.descripcion,
        UN: m.un,
        Cantidad: m.cantidad,
        'F. Vencimiento': m.fVencimiento || '',
        'F. Modificación': new Date(m.fModificacion).toLocaleString(),
        Turno: m.turno,
        Usuario: m.usuarioNombre ?? m.usuarioCorreo ?? '',
        Proveedor: m.proveedor ?? '',
      }))
      const ws1 = XLSX.utils.json_to_sheet(movData)
      XLSX.utils.book_append_sheet(wb, ws1, 'Movimientos')

      // Sheet 2: Stock calculado
      if (stockData.length > 0) {
        const sData = stockData.map((s) => ({
          Código: s.codigo,
          Descripción: s.descripcion,
          UN: s.un,
          Bloque: s.bloque,
          Torre: s.torre,
          Piso: s.piso,
          Posición: s.posicion,
          Stock: s.stock,
        }))
        const ws2 = XLSX.utils.json_to_sheet(sData)
        XLSX.utils.book_append_sheet(wb, ws2, 'Stock')
      }

      const fecha = new Date().toISOString().slice(0, 10)
      const sufijo = tieneFiltros ? '_filtrado' : '_completo'
      XLSX.writeFile(wb, `RACKLY_${fecha}${sufijo}.xlsx`)
      toast.success(`Descargado: ${filtrados.length} movimiento(s) y ${stockData.length} ubicación(es) con stock`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  /* ─── Conteo por tipo ─── */
  const conteoTipos = useMemo(() => {
    const map: Record<string, number> = {}
    for (const m of filtrados) {
      map[m.tipo] = (map[m.tipo] || 0) + 1
    }
    return map
  }, [filtrados])

  return (
    <div className="space-y-5">
      {/* ─── Filtros ─── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">
            Filtra los datos que deseas descargar
          </p>
          {tieneFiltros && (
            <Button variant="ghost" size="sm" onClick={limpiarFiltros} className="gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <FilterX className="h-3.5 w-3.5" />
              Limpiar
            </Button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Filtro por código */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={filtroCodigo}
              onChange={(e) => setFiltroCodigo(e.target.value)}
              placeholder="Filtrar por código..."
              className="pl-9 h-9 text-sm"
            />
          </div>

          {/* Filtro por usuario */}
          <div className="relative">
            <Users className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={filtroUsuario}
              onChange={(e) => setFiltroUsuario(e.target.value)}
              placeholder="Filtrar por usuario..."
              className="pl-9 h-9 text-sm"
              list="desc-usuarios-list"
            />
            <datalist id="desc-usuarios-list">
              {usuariosUnicos.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>

          {/* Filtro por tipo */}
          <Select value={filtroTipo} onValueChange={setFiltroTipo}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Tipo de movimiento" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos los tipos</SelectItem>
              <SelectItem value="ingreso">Ingreso</SelectItem>
              <SelectItem value="salida">Salida</SelectItem>
              <SelectItem value="devolucion">Devolución</SelectItem>
              <SelectItem value="traslado">Traslado</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ─── Resumen de lo que se descargará ─── */}
      <div className="rounded-xl border border-border/60 bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-semibold">Contenido del archivo Excel</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {/* Total movimientos */}
          <div className="rounded-lg border bg-muted/30 p-3 text-center space-y-1">
            <p className="text-2xl font-bold tabular-nums">{filtrados.length}</p>
            <p className="text-xs text-muted-foreground">Movimientos</p>
            {tieneFiltros && (
              <p className="text-[10px] text-muted-foreground">de {movimientos.length} totales</p>
            )}
          </div>

          {/* Ubicaciones con stock */}
          <div className="rounded-lg border bg-muted/30 p-3 text-center space-y-1">
            <p className="text-2xl font-bold tabular-nums">{stockData.length}</p>
            <p className="text-xs text-muted-foreground">Ubicaciones con stock</p>
          </div>

          {/* Tipos de movimiento */}
          <div className="rounded-lg border bg-muted/30 p-3 text-center space-y-1">
            <div className="flex flex-wrap justify-center gap-1">
              {Object.entries(conteoTipos).map(([tipo, count]) => {
                const colorMap: Record<string, string> = {
                  ingreso: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
                  salida: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                  devolucion: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
                  traslado: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
                }
                return (
                  <Badge key={tipo} variant="secondary" className={`text-[10px] px-1.5 py-0 ${colorMap[tipo] || ''}`}>
                    {tipo}: {count}
                  </Badge>
                )
              })}
              {Object.keys(conteoTipos).length === 0 && (
                <span className="text-xs text-muted-foreground">Sin datos</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Por tipo</p>
          </div>
        </div>

        {/* Vista previa de la tabla */}
        {filtrados.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Vista previa (últimos 5 registros)
            </p>
            <div className="rounded-lg border overflow-x-auto max-h-[220px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-[10px] uppercase">Tipo</TableHead>
                    <TableHead className="text-[10px] uppercase">Código</TableHead>
                    <TableHead className="text-[10px] uppercase hidden sm:table-cell">Descripción</TableHead>
                    <TableHead className="text-[10px] uppercase text-right">Cant.</TableHead>
                    <TableHead className="text-[10px] uppercase hidden md:table-cell">Ubicación</TableHead>
                    <TableHead className="text-[10px] uppercase hidden lg:table-cell">Usuario</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtrados.slice(0, 5).map((m, i) => (
                    <TableRow key={i} className="text-sm">
                      <TableCell>
                        <Badge
                          variant={m.tipo === 'salida' ? 'destructive' : m.tipo === 'traslado' ? 'outline' : 'default'}
                          className={`text-[10px] ${m.tipo === 'traslado' ? 'border-blue-400 text-blue-700' : m.tipo === 'devolucion' ? 'border-amber-400 text-amber-700' : ''}`}
                        >
                          {m.tipo}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.codigo}</TableCell>
                      <TableCell className="text-xs max-w-[150px] truncate hidden sm:table-cell">{m.descripcion}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.cantidad}</TableCell>
                      <TableCell className="text-xs hidden md:table-cell font-mono">
                        {m.bloque}-{m.torre}-{m.piso}-{m.posicion}
                      </TableCell>
                      <TableCell className="text-xs hidden lg:table-cell">
                        {m.usuarioNombre ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {filtrados.length > 5 && (
                <div className="text-center py-2 text-xs text-muted-foreground border-t">
                  ... y {filtrados.length - 5} registro(s) más
                </div>
              )}
            </div>
          </div>
        )}

        {filtrados.length === 0 && movimientos.length > 0 && (
          <div className="text-center py-6 text-muted-foreground">
            <Search className="h-6 w-6 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No hay movimientos con los filtros aplicados</p>
            <Button variant="link" size="sm" onClick={limpiarFiltros} className="text-xs mt-1">
              Limpiar filtros
            </Button>
          </div>
        )}

        {/* Botón de descarga */}
        <Button
          onClick={handleExport}
          disabled={busy || filtrados.length === 0}
          className="w-full gap-2 h-11"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {busy
            ? 'Generando archivo...'
            : `Descargar Excel (${filtrados.length} movimiento${filtrados.length !== 1 ? 's' : ''})`
          }
        </Button>
      </div>
    </div>
  )
}
