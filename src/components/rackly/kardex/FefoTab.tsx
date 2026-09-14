'use client'

import { useState, useMemo } from 'react'
import { fetchMovimientos, calcularLotesRemanentes, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Search, Download, Loader2, CalendarDays, FilterX, MapPin, ExternalLink, PackageSearch } from 'lucide-react'

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
  loteFisico?: string
  status: 'vigente' | 'proximo' | 'urgente' | 'vencido' | 'sin_fecha'
}

type FefoStatus = FefoItem['status']

// ── Colores por estado (tema claro, consistente con Stock/Ocupación) ──
const STATUS_BADGE: Record<FefoStatus, string> = {
  vigente: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',
  proximo: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  urgente: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
  vencido: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  sin_fecha: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700',
}
const STATUS_BADGE_DOT: Record<FefoStatus, string> = {
  vigente: 'bg-green-500',
  proximo: 'bg-blue-500',
  urgente: 'bg-orange-500',
  vencido: 'bg-red-500',
  sin_fecha: 'bg-slate-400',
}
const STATUS_CHIP_ACTIVE: Record<FefoStatus, string> = {
  vigente: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-700 dark:text-emerald-300',
  proximo: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-700 dark:text-cyan-300',
  urgente: 'bg-amber-500/20 border-amber-500/50 text-amber-700 dark:text-amber-300',
  vencido: 'bg-red-500/20 border-red-500/50 text-red-700 dark:text-red-300',
  sin_fecha: 'bg-slate-500/20 border-slate-500/50 text-slate-700 dark:text-slate-300',
}
const STATUS_CHIP_DOT: Record<FefoStatus, string> = {
  vigente: 'bg-emerald-500',
  proximo: 'bg-cyan-500',
  urgente: 'bg-amber-500',
  vencido: 'bg-red-500',
  sin_fecha: 'bg-slate-400',
}
const STATUS_LABEL: Record<FefoStatus, string> = {
  vigente: 'Vigente',
  proximo: 'Próximo',
  urgente: 'Urgente',
  vencido: 'Vencido',
  sin_fecha: 'Sin fecha',
}
const DIAS_COLOR: Record<FefoStatus, string> = {
  vigente: 'text-green-700 dark:text-green-300',
  proximo: 'text-blue-700 dark:text-blue-300',
  urgente: 'text-orange-700 dark:text-orange-300',
  vencido: 'text-red-700 dark:text-red-300',
  sin_fecha: 'text-slate-400',
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fmtQty = (n: number) => (n % 1 === 0 ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 3 }))

export function FefoTab({ onGotoUbicacion }: { onGotoUbicacion?: (bloque: string, torre: string, piso: string, posicion: string) => void }) {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [search, setSearch] = useState('')
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [filtros, setFiltros] = useState<Record<FefoStatus, boolean>>({
    vigente: true,
    proximo: true,
    urgente: true,
    vencido: true,
    sin_fecha: true,
  })
  const [busy, setBusy] = useState(false)

  useMovimientosRealtime(setMovs)

  const hasActiveFilters = useMemo(() => {
    return search.trim() !== '' || fechaDesde !== '' || fechaHasta !== '' ||
      !filtros.vigente || !filtros.proximo || !filtros.urgente || !filtros.vencido || !filtros.sin_fecha
  }, [search, fechaDesde, fechaHasta, filtros])

  function clearFilters() {
    setSearch('')
    setFechaDesde('')
    setFechaHasta('')
    setFiltros({ vigente: true, proximo: true, urgente: true, vencido: true, sin_fecha: true })
  }

  // ═══ Agregación FEFO — MISMO ALGORITMO que stockEnUbicacion (Ocupación) y Stock ═══
  // Pools de ingresos por lote + salidas dirigidas a la fecha registrada con
  // desborde FEFO (calcularLotesRemanentes). Ningún lote queda en negativo y
  // la suma de lotes mostrados = stock neto de la posición en Stock/Ocupación.
  const fefoData = useMemo(() => {
    const ENTRADAS = ['ingreso', 'devolucion', 'traslado', 'stock_inicial']

    // Pools por (ubicación + código), excluyendo INC (igual que Stock/Ocupación)
    const ingresosMap = new Map<string, Map<string, number>>() // key → (fv → qty)
    const salidasMap = new Map<string, Array<{ venc: string; qty: number; ts: string; id: string }>>()
    // Códigos de lote FÍSICOS (digitados en ingresos) por key → (fv → Set): trazabilidad
    const lotesFisMap = new Map<string, Map<string, Set<string>>>()
    const metaMap = new Map<string, { posKey: string; code: string; descripcion: string; un: string; proveedor?: string }>()

    for (const m of movs) {
      if (m.codigoInc) continue // INC no participa en FEFO (pestañas propias para INC)
      const code = m.codigo.trim().toUpperCase()
      const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const key = `${posKey}||${code}`
      const qty = typeof m.cantidad === 'number' ? m.cantidad : parseFloat(String(m.cantidad)) || 0
      if (!(qty > 0)) continue
      if (!metaMap.has(key)) {
        metaMap.set(key, { posKey, code, descripcion: m.descripcion, un: m.un, proveedor: m.proveedor || undefined })
      }
      const venc = m.fVencimiento || ''
      if (ENTRADAS.includes(m.tipo)) {
        const pool = ingresosMap.get(key) ?? new Map<string, number>()
        pool.set(venc, (pool.get(venc) ?? 0) + qty)
        ingresosMap.set(key, pool)
        if (m.lote) {
          let porKey = lotesFisMap.get(key)
          if (!porKey) { porKey = new Map(); lotesFisMap.set(key, porKey) }
          const set = porKey.get(venc) ?? new Set<string>()
          set.add(m.lote)
          porKey.set(venc, set)
        }
      } else {
        const list = salidasMap.get(key) ?? []
        list.push({ venc, qty, ts: m.fModificacion, id: m.id })
        salidasMap.set(key, list)
      }
    }

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
    const items: FefoItem[] = []

    for (const [key, pool] of ingresosMap) {
      const meta = metaMap.get(key)
      if (!meta) continue
      // Salidas en orden temporal (ASC) — igual que la consulta de stockEnUbicacion
      const salidas = (salidasMap.get(key) ?? []).sort((a, b) =>
        a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
      const remanentes = calcularLotesRemanentes(pool, salidas)
      const total = remanentes.reduce((s, l) => s + l.cantidad, 0)
      if (total <= 0) continue // igual que Stock/Ocupación: solo stock neto > 0

      const [bloque, torre, piso, posicion] = meta.posKey.split('-')
      const porVenc = lotesFisMap.get(key)
      for (const lote of remanentes) {
        const fv = lote.venc
        let status: FefoStatus = 'sin_fecha'
        let dias = -1
        if (fv) {
          const vencDate = new Date(fv + 'T00:00:00')
          dias = Math.round((vencDate.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24))
          status = dias < 0 ? 'vencido' : dias <= 15 ? 'urgente' : dias <= 30 ? 'proximo' : 'vigente'
        }
        const fis = porVenc?.get(fv)
        items.push({
          codigo: meta.code, descripcion: meta.descripcion,
          bloque, torre, piso, posicion,
          stock: round3(lote.cantidad), diasRestantes: dias, fVencimiento: fv,
          un: meta.un, proveedor: meta.proveedor,
          loteFisico: fis && fis.size > 0 ? Array.from(fis).sort().join(', ') : undefined,
          status,
        })
      }
    }

    return items.sort((a, b) => {
      // Sin fecha siempre al final; luego por días restantes (vencidos primero)
      if (a.status === 'sin_fecha' && b.status !== 'sin_fecha') return 1
      if (a.status !== 'sin_fecha' && b.status === 'sin_fecha') return -1
      if (a.diasRestantes !== b.diasRestantes) return a.diasRestantes - b.diasRestantes
      if (a.codigo !== b.codigo) return a.codigo.localeCompare(b.codigo)
      const aB = parseInt(a.bloque, 10) || 0, bB = parseInt(b.bloque, 10) || 0
      if (aB !== bB) return aB - bB
      const aT = parseInt(a.torre, 10) || 0, bT = parseInt(b.torre, 10) || 0
      if (aT !== bT) return aT - bT
      const aP = parseInt(a.piso, 10) || 0, bP = parseInt(b.piso, 10) || 0
      if (aP !== bP) return aP - bP
      return (parseInt(a.posicion, 10) || 0) - (parseInt(b.posicion, 10) || 0)
    })
  }, [movs])

  const filtered = useMemo(() => {
    let data = fefoData
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      data = data.filter((i) => i.codigo.toUpperCase().includes(q) || i.descripcion.toUpperCase().includes(q))
    }
    // Los lotes SIN fecha no se comparan bien contra rangos ('' >= fecha es false):
    // se incluyen/excluyen según su chip propio, no por comparación de string.
    if (fechaDesde) data = data.filter((i) => i.status === 'sin_fecha' || i.fVencimiento >= fechaDesde)
    if (fechaHasta) data = data.filter((i) => i.status === 'sin_fecha' || i.fVencimiento <= fechaHasta)
    return data.filter((i) => filtros[i.status] !== false)
  }, [fefoData, search, fechaDesde, fechaHasta, filtros])

  const counts = useMemo(() => ({
    vigente: fefoData.filter((i) => i.status === 'vigente').length,
    proximo: fefoData.filter((i) => i.status === 'proximo').length,
    urgente: fefoData.filter((i) => i.status === 'urgente').length,
    vencido: fefoData.filter((i) => i.status === 'vencido').length,
    sin_fecha: fefoData.filter((i) => i.status === 'sin_fecha').length,
  }), [fefoData])

  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((i) => ({
        Código: i.codigo, Descripción: i.descripcion, Bloque: i.bloque, Torre: i.torre,
        Piso: i.piso, Posición: i.posicion, UN: i.un, Stock: i.stock,
        'Días restantes': i.status === 'sin_fecha' ? '' : i.diasRestantes,
        'F. Vencimiento': i.fVencimiento || 'S/F',
        'Lote': i.loteFisico || '',
        Estado: STATUS_LABEL[i.status],
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'FEFO')
      XLSX.writeFile(wb, `RACKLY_FEFO_${new Date().toISOString().slice(0, 10)}.xlsx`)
      toast.success('FEFO exportado')
    } catch (err: unknown) {
      toast.error('Error al exportar', { description: err instanceof Error ? err.message : 'Error' })
    } finally { setBusy(false) }
  }

  // Badge de ubicación clicable (ir a Ocupación)
  function UbiChip({ item }: { item: FefoItem }) {
    return (
      <button
        type="button"
        onClick={() => onGotoUbicacion?.(item.bloque, item.torre, item.piso, item.posicion)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-300 bg-violet-50 hover:bg-violet-100 hover:border-violet-500 text-[10px] font-mono font-semibold text-violet-700 transition-colors cursor-pointer shadow-sm hover:shadow-md"
        title={`Ir a Ocupación: ${item.bloque}-${item.torre}-${item.piso}-${item.posicion}`}
      >
        <MapPin className="h-3 w-3 text-violet-500" />
        {item.bloque}-{item.torre}-{item.piso}-{item.posicion}
        <ExternalLink className="h-2.5 w-2.5 text-violet-400" />
      </button>
    )
  }

  return (
    <div className="space-y-4">
      {/* ═══ BARRA DE BÚSQUEDA + EXPORTAR ═══ */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar código o descripción..."
            className="pl-9"
          />
        </div>
        <Button onClick={handleExport} disabled={busy} variant="outline" className="h-9 gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar
        </Button>
      </div>

      {/* ═══ FILTROS: RANGO DE VENCIMIENTO + ESTADOS ═══ */}
      <div className="rounded-lg border bg-card p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-sky-600" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Rango de vencimiento</span>
          </div>
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground">Desde</span>
            <Input type="date" value={fechaDesde} onChange={(e) => setFechaDesde(e.target.value)}
              className="h-9 min-w-0 flex-1 sm:w-[150px]" />
            <span className="text-muted-foreground text-base">→</span>
            <span className="text-xs font-medium text-muted-foreground">Hasta</span>
            <Input type="date" value={fechaHasta} onChange={(e) => setFechaHasta(e.target.value)}
              className="h-9 min-w-0 flex-1 sm:w-[150px]" />
          </div>
          {hasActiveFilters && (
            <Button onClick={clearFilters} variant="outline" size="sm"
              className="h-9 gap-1.5 border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 text-xs font-bold">
              <FilterX className="w-4 h-4" />
              Limpiar filtros
            </Button>
          )}
        </div>

        {/* Chips por estado */}
        <div className="flex flex-wrap gap-2">
          {([
            ['vencido', 'Vencidos'],
            ['urgente', '≤ 15 días'],
            ['proximo', '≤ 30 días'],
            ['vigente', '> 30 días'],
            ['sin_fecha', 'Sin fecha'],
          ] as const).map(([key, label]) => {
            const active = filtros[key]
            return (
              <button key={key} type="button"
                onClick={() => setFiltros((f) => ({ ...f, [key]: !f[key] }))}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                  active
                    ? STATUS_CHIP_ACTIVE[key]
                    : 'bg-slate-100 border-slate-200 text-slate-400 hover:text-slate-600 dark:bg-slate-800/40 dark:border-slate-700 dark:text-slate-500'
                }`}>
                <span className={`w-2.5 h-2.5 rounded-full ${active ? STATUS_CHIP_DOT[key] : 'bg-slate-300 dark:bg-slate-600'}`} />
                {label}
                <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-black/5 dark:bg-white/10">
                  {counts[key]}
                </span>
              </button>
            )
          })}
        </div>

        {hasActiveFilters && (
          <p className="text-xs text-muted-foreground">
            Mostrando <span className="font-bold text-foreground">{filtered.length}</span> de{' '}
            <span className="font-semibold">{fefoData.length}</span> lotes
          </p>
        )}
      </div>

      {/* ═══ LABEL ═══ */}
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <CalendarDays className="h-3.5 w-3.5" />
        {filtered.length > 0
          ? 'Lotes reales por ubicación — toca la ubicación para ir a Ocupación'
          : 'Sin lotes FEFO'}
      </p>

      {/* ═══ CONTENIDO ═══ */}
      {filtered.length > 0 ? (
        <>
          {/* ── Móvil: tarjetas ── */}
          <div className="md:hidden space-y-2">
            {filtered.map((item, i) => (
              <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-sm">{item.codigo}</span>
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${STATUS_BADGE[item.status]}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_BADGE_DOT[item.status]}`} />
                    {STATUS_LABEL[item.status]}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-tight truncate">{item.descripcion}</p>
                <div><UbiChip item={item} /></div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-emerald-700 dark:text-emerald-300 font-bold text-sm">
                    {fmtQty(item.stock)} <span className="text-[10px] font-medium text-muted-foreground">{item.un}</span>
                  </span>
                  {item.fVencimiento ? (
                    <>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${STATUS_BADGE[item.status]}`}>
                        {item.fVencimiento}
                      </Badge>
                      <span className={`font-bold ${DIAS_COLOR[item.status]}`}>
                        {item.diasRestantes} día{Math.abs(item.diasRestantes) !== 1 ? 's' : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Sin fecha de vencimiento</span>
                  )}
                  {item.proveedor ? (
                    <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 text-[10px] px-1.5 py-0 font-semibold">
                      {item.proveedor}
                    </Badge>
                  ) : null}
                  {item.loteFisico ? (
                    <Badge variant="outline" className="bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800 text-[10px] px-1.5 py-0 font-semibold" title="Código de lote físico">
                      Lote: {item.loteFisico}
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop: tabla (misma estructura visual que Stock) ── */}
          <div className="hidden md:block overflow-x-auto max-h-[620px] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Bloque</TableHead>
                  <TableHead>Torre</TableHead>
                  <TableHead>Piso</TableHead>
                  <TableHead>Posición</TableHead>
                  <TableHead>Vencimiento</TableHead>
                  <TableHead className="text-right">Días</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>Proveedor</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono font-semibold text-sm">{item.codigo}</TableCell>
                    <TableCell className="max-w-[220px] truncate" title={item.descripcion}>{item.descripcion}</TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(item.bloque, item.torre, item.piso, item.posicion)}
                      className="font-mono font-medium whitespace-nowrap cursor-pointer hover:text-violet-700 dark:hover:text-violet-300 transition-colors" title="Ir a Ocupación">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-violet-500" />
                        {item.bloque}
                      </span>
                    </TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(item.bloque, item.torre, item.piso, item.posicion)}
                      className="whitespace-nowrap cursor-pointer hover:text-violet-700 dark:hover:text-violet-300 transition-colors">{item.torre}</TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(item.bloque, item.torre, item.piso, item.posicion)}
                      className="whitespace-nowrap cursor-pointer hover:text-violet-700 dark:hover:text-violet-300 transition-colors">{item.piso}</TableCell>
                    <TableCell onClick={() => onGotoUbicacion?.(item.bloque, item.torre, item.piso, item.posicion)}
                      className="whitespace-nowrap cursor-pointer hover:text-violet-700 dark:hover:text-violet-300 transition-colors">{item.posicion}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {item.fVencimiento ? (
                        <Badge variant="outline" className={`font-semibold ${STATUS_BADGE[item.status]}`}>
                          {item.fVencimiento}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">S/F</span>
                      )}
                      {item.loteFisico && (
                        <div className="text-[10px] font-semibold text-cyan-700 dark:text-cyan-300" title="Código de lote físico">Lote: {item.loteFisico}</div>
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-bold ${DIAS_COLOR[item.status]}`}>
                      {item.status === 'sin_fecha' ? '—' : item.diasRestantes}
                    </TableCell>
                    <TableCell className="text-right font-bold">
                      {fmtQty(item.stock)} <span className="text-xs font-medium text-muted-foreground">{item.un}</span>
                    </TableCell>
                    <TableCell>
                      {item.proveedor ? (
                        <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                          {item.proveedor}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${STATUS_BADGE[item.status]}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_BADGE_DOT[item.status]}`} />
                        {STATUS_LABEL[item.status]}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Total */}
          <div className="flex justify-end">
            <Badge variant="outline" className="text-sm px-3 py-1">
              Lotes: <span className="font-bold ml-1">{filtered.length}</span>
              <span className="mx-2 text-muted-foreground">·</span>
              Stock total: <span className="font-bold ml-1">{fmtQty(round3(filtered.reduce((s, i) => s + i.stock, 0)))}</span>
            </Badge>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 text-muted-foreground py-10 justify-center">
          <PackageSearch className="h-8 w-8" />
          <span className="text-sm font-medium">
            {hasActiveFilters ? 'Sin resultados para los filtros aplicados' : 'Sin lotes FEFO — el stock aparecerá al registrar ingresos'}
          </span>
        </div>
      )}
    </div>
  )
}
