'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
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
  Search,
  Download,
  Loader2,
  Clock,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Package,
  TrendingDown,
  ArrowUpDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ─── Tipos ─── */
type FefoItem = {
  codigo: string
  descripcion: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  diasRestantes: number
  fVencimiento: string
  un: string
  proveedor?: string
  status: 'vigente' | 'proximo' | 'urgente' | 'vencido'
}

type StatusKey = FefoItem['status']

/* ─── Definición de rangos de vencimiento ─── */
interface RangoVencimiento {
  key: StatusKey
  label: string
  sublabel: string
  color: string
  activeBg: string
  activeBorder: string
  iconBg: string
  hoverBg: string
  progressColor: string
}

const RANGOS: RangoVencimiento[] = [
  {
    key: 'vencido',
    label: 'Vencidos',
    sublabel: 'Vencido',
    color: 'text-red-600 dark:text-red-400',
    activeBg: 'bg-red-50 dark:bg-red-950/50',
    activeBorder: 'border-red-500 dark:border-red-500',
    iconBg: 'bg-red-100 dark:bg-red-900/40',
    hoverBg: 'hover:bg-red-50/80 dark:hover:bg-red-950/30',
    progressColor: '[&>div]:bg-red-500',
  },
  {
    key: 'urgente',
    label: '15 días',
    sublabel: 'Urgente',
    color: 'text-amber-600 dark:text-amber-400',
    activeBg: 'bg-amber-50 dark:bg-amber-950/50',
    activeBorder: 'border-amber-500 dark:border-amber-500',
    iconBg: 'bg-amber-100 dark:bg-amber-900/40',
    hoverBg: 'hover:bg-amber-50/80 dark:hover:bg-amber-950/30',
    progressColor: '[&>div]:bg-amber-500',
  },
  {
    key: 'proximo',
    label: '30 días',
    sublabel: 'Próximo',
    color: 'text-sky-600 dark:text-sky-400',
    activeBg: 'bg-sky-50 dark:bg-sky-950/50',
    activeBorder: 'border-sky-500 dark:border-sky-500',
    iconBg: 'bg-sky-100 dark:bg-sky-900/40',
    hoverBg: 'hover:bg-sky-50/80 dark:hover:bg-sky-950/30',
    progressColor: '[&>div]:bg-sky-500',
  },
  {
    key: 'vigente',
    label: '60+ días',
    sublabel: 'Vigente',
    color: 'text-emerald-600 dark:text-emerald-400',
    activeBg: 'bg-emerald-50 dark:bg-emerald-950/50',
    activeBorder: 'border-emerald-500 dark:border-emerald-500',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/40',
    hoverBg: 'hover:bg-emerald-50/80 dark:hover:bg-emerald-950/30',
    progressColor: '[&>div]:bg-emerald-500',
  },
]

/* ─── Componente de icono por estado ─── */
function StatusIcon({ status, className }: { status: StatusKey; className?: string }) {
  const cls = cn('h-4 w-4', className)
  switch (status) {
    case 'vencido':
      return <ShieldAlert className={cls} />
    case 'urgente':
      return <AlertTriangle className={cls} />
    case 'proximo':
      return <Clock className={cls} />
    case 'vigente':
      return <ShieldCheck className={cls} />
  }
}

/* ─── Componente principal ─── */
export function FefoTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [search, setSearch] = useState('')
  const [selectedRango, setSelectedRango] = useState<StatusKey | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [busy, setBusy] = useState(false)

  useMovimientosRealtime(setMovs)

  /* ─── Calcular datos FEFO ─── */
  const fefoData = useMemo(() => {
    const locMap = new Map<
      string,
      {
        codigo: string
        descripcion: string
        un: string
        bloque: string
        torre: string
        piso: string
        posicion: string
        stock: number
        fVencimiento: string
        proveedor?: string
      }
    >()

    for (const m of movs) {
      if (m.tipo !== 'ingreso') continue
      const key = `${m.codigo}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const existing = locMap.get(key)
      if (existing) {
        existing.stock += m.cantidad
        if (m.fVencimiento && (!existing.fVencimiento || m.fVencimiento < existing.fVencimiento)) {
          existing.fVencimiento = m.fVencimiento
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
          stock: m.cantidad,
          fVencimiento: m.fVencimiento || '',
          proveedor: m.proveedor || undefined,
        })
      }
    }

    // Restar salidas
    for (const m of movs) {
      if (m.tipo !== 'salida') continue
      const key = `${m.codigo}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const existing = locMap.get(key)
      if (existing) {
        existing.stock -= m.cantidad
      }
    }

    const items: FefoItem[] = []
    const now = new Date()
    for (const [, loc] of locMap) {
      if (loc.stock <= 0 || !loc.fVencimiento) continue
      const venc = new Date(loc.fVencimiento)
      const diff = Math.ceil(
        (venc.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )
      let status: FefoItem['status']
      if (diff < 0) status = 'vencido'
      else if (diff <= 15) status = 'urgente'
      else if (diff <= 30) status = 'proximo'
      else status = 'vigente'

      items.push({
        ...loc,
        diasRestantes: diff,
        status,
      })
    }

    return items.sort((a, b) => a.diasRestantes - b.diasRestantes)
  }, [movs])

  /* ─── Conteo por rango ─── */
  const counts = useMemo(
    () => ({
      vigente: fefoData.filter((i) => i.status === 'vigente').length,
      proximo: fefoData.filter((i) => i.status === 'proximo').length,
      urgente: fefoData.filter((i) => i.status === 'urgente').length,
      vencido: fefoData.filter((i) => i.status === 'vencido').length,
    }),
    [fefoData]
  )

  const totalItems = fefoData.length

  /* ─── Filtrar y ordenar ─── */
  const filtered = useMemo(() => {
    let data = fefoData
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      data = data.filter(
        (i) =>
          i.codigo.toUpperCase().includes(q) ||
          i.descripcion.toUpperCase().includes(q)
      )
    }
    if (selectedRango) {
      data = data.filter((i) => i.status === selectedRango)
    }
    return sortAsc ? data : [...data].reverse()
  }, [fefoData, search, selectedRango, sortAsc])

  /* ─── Toggle rango ─── */
  const toggleRango = useCallback((key: StatusKey) => {
    setSelectedRango((prev) => (prev === key ? null : key))
  }, [])

  /* ─── Status badge color ─── */
  function statusBadge(status: StatusKey) {
    switch (status) {
      case 'vigente':
        return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
      case 'proximo':
        return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 border-sky-200 dark:border-sky-800'
      case 'urgente':
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800'
      case 'vencido':
        return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800'
    }
  }

  function diasBadgeStyle(dias: number) {
    if (dias < 0) return 'bg-red-500 text-white'
    if (dias <= 15) return 'bg-amber-500 text-white'
    if (dias <= 30) return 'bg-sky-500 text-white'
    return 'bg-emerald-500 text-white'
  }

  /* ─── Exportar ─── */
  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((i) => ({
        Código: i.codigo,
        Descripción: i.descripcion,
        Bloque: i.bloque,
        Torre: i.torre,
        Piso: i.piso,
        Posición: i.posicion,
        UN: i.un,
        Stock: i.stock,
        'Días restantes': i.diasRestantes,
        'F. Vencimiento': i.fVencimiento,
        Estado: i.status,
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'FEFO')
      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_FEFO_${fecha}.xlsx`)
      toast.success('FEFO exportado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* ─── Encabezado con búsqueda y exportar ─── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar código o descripción..."
            className="pl-9 h-10 bg-background"
          />
        </div>
        <Button
          onClick={handleExport}
          disabled={busy || filtered.length === 0}
          variant="outline"
          className="gap-2 h-10"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Exportar
        </Button>
      </div>

      {/* ─── Botones de rango de vencimiento ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {RANGOS.map((rango) => {
          const isActive = selectedRango === rango.key
          const count = counts[rango.key]
          const pct = totalItems > 0 ? (count / totalItems) * 100 : 0

          return (
            <button
              key={rango.key}
              type="button"
              onClick={() => toggleRango(rango.key)}
              className={cn(
                'group relative flex flex-col items-start gap-2 rounded-xl border-2 p-4 transition-all duration-200 cursor-pointer text-left',
                isActive
                  ? cn(rango.activeBg, rango.activeBorder, 'shadow-md scale-[1.02]')
                  : cn(
                      'border-border/60 bg-card hover:border-border',
                      rango.hoverBg
                    )
              )}
            >
              {/* Indicador activo */}
              {isActive && (
                <div className="absolute top-2 right-2">
                  <div
                    className={cn(
                      'h-2.5 w-2.5 rounded-full animate-pulse',
                      rango.key === 'vencido'
                        ? 'bg-red-500'
                        : rango.key === 'urgente'
                          ? 'bg-amber-500'
                          : rango.key === 'proximo'
                            ? 'bg-sky-500'
                            : 'bg-emerald-500'
                    )}
                  />
                </div>
              )}

              <div className="flex items-center gap-2.5">
                <div
                  className={cn(
                    'flex items-center justify-center h-9 w-9 rounded-lg transition-colors',
                    rango.iconBg
                  )}
                >
                  <StatusIcon
                    status={rango.key}
                    className={cn(rango.color)}
                  />
                </div>
                <div className="flex flex-col">
                  <span className={cn('text-sm font-bold leading-tight', rango.color)}>
                    {rango.label}
                  </span>
                  <span className="text-xs text-muted-foreground leading-tight">
                    {rango.sublabel}
                  </span>
                </div>
              </div>

              <div className="w-full space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-extrabold tabular-nums">
                    {count}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pct.toFixed(0)}%
                  </span>
                </div>
                <Progress
                  value={pct}
                  className={cn('h-1.5', rango.progressColor)}
                />
              </div>
            </button>
          )
        })}
      </div>

      {/* ─── Barra de información y control ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Package className="h-4 w-4" />
          <span>
            <strong className="text-foreground">{filtered.length}</strong> de{' '}
            {totalItems} artículos
          </span>
          {selectedRango && (
            <Badge
              variant="outline"
              className="ml-1 text-xs gap-1"
            >
              {RANGOS.find((r) => r.key === selectedRango)?.sublabel}
              <button
                type="button"
                onClick={() => setSelectedRango(null)}
                className="ml-0.5 hover:text-foreground transition-colors"
                aria-label="Limpiar filtro"
              >
                ×
              </button>
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => setSortAsc((a) => !a)}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          {sortAsc ? 'Ascendente' : 'Descendente'}
        </Button>
      </div>

      {/* ─── Tabla de datos ─── */}
      <div className="rounded-xl border border-border/60 overflow-hidden">
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="text-xs font-semibold uppercase tracking-wider">
                  Código
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider">
                  Descripción
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider">
                  Ubicación
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-right">
                  Stock
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider">
                  Proveedor
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider">
                  Vencimiento
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">
                  Días
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-center">
                  Estado
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item, i) => {
                const ubicacion = `${item.bloque}-${item.torre}-${item.piso}-${item.posicion}`
                return (
                  <TableRow
                    key={i}
                    className="group transition-colors hover:bg-muted/30"
                  >
                    <TableCell className="font-mono text-xs font-semibold">
                      {item.codigo}
                    </TableCell>
                    <TableCell className="text-sm max-w-[200px] truncate">
                      {item.descripcion}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {ubicacion}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-bold tabular-nums">
                      {item.stock}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {item.un}
                      </span>
                    </TableCell>
                    <TableCell>
                      {item.proveedor ? (
                        <Badge
                          variant="outline"
                          className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold text-xs"
                        >
                          {item.proveedor}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.fVencimiento}
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={cn(
                          'inline-flex items-center justify-center min-w-[44px] px-2 py-0.5 rounded-full text-xs font-bold tabular-nums',
                          diasBadgeStyle(item.diasRestantes)
                        )}
                      >
                        {item.diasRestantes}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border',
                          statusBadge(item.status)
                        )}
                      >
                        <StatusIcon status={item.status} className="h-3 w-3" />
                        {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground py-12"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <Package className="h-8 w-8 text-muted-foreground/40" />
                      <p className="text-sm">Sin resultados</p>
                      {selectedRango && (
                        <button
                          type="button"
                          onClick={() => setSelectedRango(null)}
                          className="text-xs text-primary hover:underline"
                        >
                          Limpiar filtro
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ─── Resumen inferior con barras ─── */}
      {totalItems > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Distribución de vencimiento
            </span>
          </div>
          <div className="flex h-3 rounded-full overflow-hidden bg-muted">
            {RANGOS.map((rango) => {
              const count = counts[rango.key]
              if (count === 0) return null
              const pct = (count / totalItems) * 100
              const barColor =
                rango.key === 'vencido'
                  ? 'bg-red-500'
                  : rango.key === 'urgente'
                    ? 'bg-amber-500'
                    : rango.key === 'proximo'
                      ? 'bg-sky-500'
                      : 'bg-emerald-500'
              return (
                <div
                  key={rango.key}
                  className={cn(
                    'transition-all duration-500',
                    barColor,
                    selectedRango === rango.key
                      ? 'opacity-100'
                      : selectedRango
                        ? 'opacity-30'
                        : 'opacity-80'
                  )}
                  style={{ width: `${pct}%` }}
                  title={`${rango.sublabel}: ${count} (${pct.toFixed(1)}%)`}
                />
              )
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5">
            {RANGOS.map((rango) => (
              <button
                key={rango.key}
                type="button"
                onClick={() => toggleRango(rango.key)}
                className={cn(
                  'flex items-center gap-1.5 text-xs transition-colors cursor-pointer',
                  selectedRango === rango.key
                    ? 'font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <div
                  className={cn(
                    'h-2 w-2 rounded-full',
                    rango.key === 'vencido'
                      ? 'bg-red-500'
                      : rango.key === 'urgente'
                        ? 'bg-amber-500'
                        : rango.key === 'proximo'
                          ? 'bg-sky-500'
                          : 'bg-emerald-500'
                  )}
                />
                {rango.sublabel}: {counts[rango.key]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
