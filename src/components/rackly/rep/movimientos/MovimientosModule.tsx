'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Movimientos (kardex del almacén).
 *
 * Solo lectura EN SERVIDOR (paginado): tipo, código, origen→destino,
 * RAL, referencia y usuario. Cada salto operativo (ingreso de Recepción,
 * picking/despacho de Atención/Tránsito) escribe aquí su snapshot, así
 * que el kardex funciona desde el día 1 aunque el catálogo cambie luego.
 *
 * El filtro por código usa la columna snapshot `codigo` (no hace JOIN):
 * el historial nunca se rompe si el artículo se edita o elimina después.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  repListarMovimientos,
  repListarUbicaciones,
  type RepMovimiento,
  type RepTipoMovimiento,
} from '@/lib/rackly/rep/rep-client'
import { REP_ETIQUETA_MOV } from '@/lib/rackly/rep/rep-tipos'
import { mensajeError } from '@/lib/rackly/errores'
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
import { formatDateTime } from '@/lib/utils'
import { History, Loader2, RefreshCw, Search } from 'lucide-react'

const PAGE_SIZE = 50
/** Techo del re-fetch acumulativo (límite sano de PostgREST por petición). */
const MAX_LIMITE = 1000

const CLASE_TIPO: Record<RepTipoMovimiento, string> = {
  ingreso: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  salida: 'bg-rose-50 text-rose-700 border-rose-200',
  devolucion: 'bg-orange-50 text-orange-700 border-orange-200',
  traslado: 'bg-sky-50 text-sky-700 border-sky-200',
  ajuste: 'bg-violet-50 text-violet-700 border-violet-200',
}

export function MovimientosModule() {
  const [tipo, setTipo] = useState<'todos' | RepTipoMovimiento>('todos')
  const [codigo, setCodigo] = useState('')
  const [filas, setFilas] = useState<RepMovimiento[]>([])
  const [total, setTotal] = useState(0)
  const [limite, setLimite] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  /** id de ubicación → código (lookup único; cientos de filas como máx.) */
  const [codigosUbi, setCodigosUbi] = useState<Map<string, string>>(new Map())
  const genRef = useRef(0)

  const codigoDe = useCallback(
    (id: string | null) => (id ? codigosUbi.get(id) ?? '¿?' : ''),
    [codigosUbi]
  )

  const cargar = useCallback(async (nuevoLimite: number) => {
    const gen = ++genRef.current
    setLoading(true)
    try {
      // Re-fetch ACUMULATIVO: siempre página 1 con pageSize = límite pedido y
      // REEMPLAZO. Antes «Cargar más» apilaba ventanas por offset y un
      // movimiento nuevo que entrara entre peticiones desplazaba la ventana
      // → filas repetidas en el kardex (auditoría 2026-11-10).
      const res = await repListarMovimientos({
        tipo,
        codigo: codigo.trim() || undefined,
        page: 1,
        pageSize: nuevoLimite,
      })
      if (gen !== genRef.current) return
      setFilas(res.filas)
      setTotal(res.total)
      setLimite(nuevoLimite)
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      toast.error('Error al cargar movimientos', { description: mensajeError(err) })
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [tipo, codigo])

  // Recarga al cambiar filtros (con debounce suave para el código)
  useEffect(() => {
    const t = setTimeout(() => cargar(PAGE_SIZE), codigo ? 350 : 0)
    return () => clearTimeout(t)
  }, [cargar])

  // Lookup de códigos de ubicación (una ronda; el mapa es chico)
  useEffect(() => {
    repListarUbicaciones()
      .then((ubs) => setCodigosUbi(new Map(ubs.map((u) => [u.id, u.codigo]))))
      .catch(() => setCodigosUbi(new Map()))
  }, [])

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* Filtros */}
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={tipo} onValueChange={(v) => setTipo(v as typeof tipo)}>
          <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los tipos</SelectItem>
            {(Object.keys(REP_ETIQUETA_MOV) as RepTipoMovimiento[]).map((t) => (
              <SelectItem key={t} value={t}>{REP_ETIQUETA_MOV[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Filtrar por código…"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
          />
        </div>
        <Button variant="outline" onClick={() => cargar(limite)} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualizar
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Badge variant="outline" className="font-semibold">
          {filas.length.toLocaleString('es-PE')} de {total.toLocaleString('es-PE')} movimientos
        </Badge>
      </div>

      {/* Tabla */}
      <div className="rounded-lg border overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[130px]">Fecha</TableHead>
              <TableHead className="w-[110px]">Tipo</TableHead>
              <TableHead className="w-[130px]">Código</TableHead>
              <TableHead className="min-w-[220px]">Descripción</TableHead>
              <TableHead className="w-[90px] text-right">Cantidad</TableHead>
              <TableHead className="min-w-[170px]">Origen → Destino</TableHead>
              <TableHead className="min-w-[110px]">Referencia</TableHead>
              <TableHead className="min-w-[120px]">Usuario</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-slate-400 py-10">
                  <History className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  Sin movimientos para los filtros seleccionados.
                </TableCell>
              </TableRow>
            )}
            {filas.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="text-xs text-slate-500">{formatDateTime(m.created_at)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={`${CLASE_TIPO[m.tipo]} text-[10px] font-semibold`}>
                    {REP_ETIQUETA_MOV[m.tipo]}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs font-bold">{m.codigo}</TableCell>
                <TableCell className="text-sm">
                  <span className="block truncate max-w-[260px]" title={m.descripcion}>{m.descripcion}</span>
                </TableCell>
                <TableCell className="text-right text-sm font-semibold">
                  {Number(m.cantidad).toLocaleString('es-PE')} <span className="text-slate-400 text-xs font-normal">{m.und}</span>
                </TableCell>
                <TableCell className="text-xs text-slate-500">
                  {m.origen_ubicacion_id || m.destino_ubicacion_id ? (
                    <span className="whitespace-nowrap font-mono">
                      {m.origen_ubicacion_id ? codigoDe(m.origen_ubicacion_id) : '—'}
                      {' → '}
                      {m.destino_ubicacion_id ? codigoDe(m.destino_ubicacion_id) : '—'}
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-xs text-slate-500 truncate max-w-[140px]" title={m.referencia}>
                  {m.referencia || '—'}
                </TableCell>
                <TableCell className="text-xs">
                  <span className="block truncate max-w-[140px]" title={m.usuario_nombre}>{m.usuario_nombre || '—'}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Paginación acumulativa (sin drift: re-fetch página 1 + reemplazo) */}
      {filas.length < total && limite < MAX_LIMITE && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => cargar(limite + PAGE_SIZE)} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Cargar más ({filas.length.toLocaleString('es-PE')} de {total.toLocaleString('es-PE')})
          </Button>
        </div>
      )}
      {filas.length < total && limite >= MAX_LIMITE && (
        <p className="text-center text-xs text-slate-400">
          Mostrando {filas.length.toLocaleString('es-PE')} de {total.toLocaleString('es-PE')} — afina el tipo o el código para ver el resto.
        </p>
      )}
    </div>
  )
}
