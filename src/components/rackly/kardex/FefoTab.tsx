'use client'

import { useState, useMemo } from 'react'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Search, Download, Loader2, CalendarDays, FilterX } from 'lucide-react'
import { impactoStock } from '@/lib/utils'

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
  status: 'vigente' | 'proximo' | 'urgente' | 'vencido' | 'sin_fecha'
}

// ── Colores explícitos por estado (sin clases dinámicas) ──
const STATUS_BTN_ACTIVE: Record<string, string> = {
  vigente: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300',
  proximo: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300',
  urgente: 'bg-amber-500/20 border-amber-500/50 text-amber-300',
  vencido: 'bg-red-500/20 border-red-500/50 text-red-300',
  sin_fecha: 'bg-slate-500/20 border-slate-500/50 text-slate-300',
}
const STATUS_BTN_DOT: Record<string, string> = {
  vigente: 'bg-emerald-400',
  proximo: 'bg-cyan-400',
  urgente: 'bg-amber-400',
  vencido: 'bg-red-400',
  sin_fecha: 'bg-slate-400',
}
const STATUS_BADGE: Record<string, string> = {
  vigente: 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/40',
  proximo: 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/40',
  urgente: 'bg-amber-500/25 text-amber-200 border border-amber-500/40',
  vencido: 'bg-red-500/25 text-red-200 border border-red-500/40',
  sin_fecha: 'bg-slate-500/25 text-slate-200 border border-slate-500/40',
}
const STATUS_BADGE_DOT: Record<string, string> = {
  vigente: 'bg-emerald-300',
  proximo: 'bg-cyan-300',
  urgente: 'bg-amber-300',
  vencido: 'bg-red-300',
  sin_fecha: 'bg-slate-300',
}
const DIAS_COLOR: Record<string, string> = {
  vigente: 'text-emerald-300',
  proximo: 'text-cyan-300',
  urgente: 'text-amber-300',
  vencido: 'text-red-300',
  sin_fecha: 'text-slate-400',
}

export function FefoTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [search, setSearch] = useState('')
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [filtros, setFiltros] = useState<Record<string, boolean>>({
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

  const fefoData = useMemo(() => {
    const locMap = new Map<string, {
      codigo: string; descripcion: string; un: string
      bloque: string; torre: string; piso: string; posicion: string
      stock: number; fVencimiento: string; proveedor?: string
    }>()

    for (const m of movs) {
      if (m.codigoInc) continue // INC items don't participate in FEFO
      const key = `${m.codigo}||${m.fVencimiento || ''}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const delta = impactoStock(m.tipo, m.cantidad)
      const existing = locMap.get(key)
      if (existing) {
        existing.stock += delta
      } else {
        locMap.set(key, {
          codigo: m.codigo, descripcion: m.descripcion, un: m.un,
          bloque: m.bloque, torre: m.torre, piso: m.piso, posicion: m.posicion,
          stock: delta, fVencimiento: m.fVencimiento || '', proveedor: m.proveedor || undefined,
        })
      }
    }

    const items: FefoItem[] = []
    const now = new Date()
    for (const [, loc] of locMap) {
      if (loc.stock <= 0) continue
      if (!loc.fVencimiento) {
        items.push({
          codigo: loc.codigo, descripcion: loc.descripcion, un: loc.un,
          bloque: loc.bloque, torre: loc.torre, piso: loc.piso, posicion: loc.posicion,
          stock: loc.stock, fVencimiento: '', diasRestantes: -1, proveedor: loc.proveedor,
          status: 'sin_fecha',
        })
        continue
      }
      const venc = new Date(loc.fVencimiento)
      const diff = Math.ceil((venc.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      let status: FefoItem['status']
      if (diff < 0) status = 'vencido'
      else if (diff <= 15) status = 'urgente'
      else if (diff <= 30) status = 'proximo'
      else status = 'vigente'
      items.push({ ...loc, diasRestantes: diff, status })
    }

    return items.sort((a, b) => {
      // Sin fecha siempre al final
      if (a.status === 'sin_fecha' && b.status !== 'sin_fecha') return 1
      if (a.status !== 'sin_fecha' && b.status === 'sin_fecha') return -1
      return a.diasRestantes - b.diasRestantes
    })
  }, [movs])

  const filtered = useMemo(() => {
    let data = fefoData
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      data = data.filter((i) => i.codigo.toUpperCase().includes(q) || i.descripcion.toUpperCase().includes(q))
    }
    if (fechaDesde) data = data.filter((i) => i.fVencimiento >= fechaDesde)
    if (fechaHasta) data = data.filter((i) => i.fVencimiento <= fechaHasta)
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
        'Días restantes': i.diasRestantes, 'F. Vencimiento': i.fVencimiento, Estado: i.status,
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

  return (
    <div className="space-y-4">
      {/* ═══ BARRA DE BÚSQUEDA ═══ */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar código o descripción..."
            className="pl-9 h-9 bg-slate-800 border-slate-600/50 text-white text-sm placeholder:text-slate-500 focus:border-sky-400"
          />
        </div>
        <Button onClick={handleExport} disabled={busy} variant="outline"
          className="h-9 gap-2 border-slate-600/50 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white text-sm font-medium">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar
        </Button>
      </div>

      {/* ═══ RANGO DE FECHAS + LIMPIAR FILTROS ═══ */}
      <div className="rounded-xl border border-slate-600/30 bg-slate-800/50 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Rango de vencimiento</span>
          </div>
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <span className="text-xs font-medium text-slate-400">Desde</span>
            <Input type="date" value={fechaDesde} onChange={(e) => setFechaDesde(e.target.value)}
              className="h-9 min-w-0 flex-1 sm:w-[150px] bg-slate-700/60 border-slate-600/50 text-white text-sm focus:border-sky-400 [color-scheme:dark]" />
            <span className="text-slate-500 text-base">→</span>
            <span className="text-xs font-medium text-slate-400">Hasta</span>
            <Input type="date" value={fechaHasta} onChange={(e) => setFechaHasta(e.target.value)}
              className="h-9 min-w-0 flex-1 sm:w-[150px] bg-slate-700/60 border-slate-600/50 text-white text-sm focus:border-sky-400 [color-scheme:dark]" />
          </div>
          {hasActiveFilters && (
            <Button onClick={clearFilters} variant="outline" size="sm"
              className="h-9 gap-1.5 border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 text-xs font-bold">
              <FilterX className="w-4 h-4" />
              Limpiar filtros
            </Button>
          )}
        </div>

        {/* ═══ FILTROS POR ESTADO ═══ */}
        <div className="flex flex-wrap gap-2">
          {([
            ['vigente', '> 30 días'],
            ['proximo', '≤ 30 días'],
            ['urgente', '≤ 15 días'],
            ['vencido', 'Vencidos'],
            ['sin_fecha', 'Sin fecha'],
          ] as const).map(([key, label]) => {
            const active = filtros[key]
            return (
              <button key={key} type="button"
                onClick={() => setFiltros((f) => ({ ...f, [key]: !f[key as keyof typeof f] }))}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border ${
                  active
                    ? STATUS_BTN_ACTIVE[key]
                    : 'bg-slate-700/30 border-slate-600/30 text-slate-500 hover:text-slate-400'
                }`}>
                <span className={`w-3 h-3 rounded-full ${active ? STATUS_BTN_DOT[key] : 'bg-slate-600'}`} />
                {label}
                <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  active ? 'bg-white/10' : 'bg-slate-700/50'
                }`}>
                  {counts[key as keyof typeof counts]}
                </span>
              </button>
            )
          })}
        </div>

        {hasActiveFilters && (
          <p className="text-xs text-slate-400">
            Mostrando <span className="text-white font-bold">{filtered.length}</span> de{' '}
            <span className="text-slate-300">{fefoData.length}</span> registros
          </p>
        )}
      </div>

      {/* ═══ TABLA ═══ */}
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto rounded-xl border border-slate-600/40 shadow-lg">
        <table className="min-w-[750px] w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-800/95 backdrop-blur border-b-2 border-slate-600/40">
              {['Código', 'Descripción', 'Bloque', 'Torre', 'Piso', 'Pos', 'Stock', 'Proveedor', 'Vencimiento', 'Días', 'Estado'].map(h => (
                <th key={h} className={`px-4 py-3 text-xs font-bold text-slate-300 uppercase tracking-wider ${
                  h === 'Stock' || h === 'Días' ? 'text-right' : 'text-left'
                } ${
                  h === 'Torre' || h === 'Piso' || h === 'Pos' ? 'hidden sm:table-cell' : ''
                } ${
                  h === 'Proveedor' || h === 'Vencimiento' ? 'hidden md:table-cell' : ''
                }`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-slate-900/60">
            {filtered.map((item, i) => (
              <tr key={i} className="border-b border-slate-700/25 hover:bg-slate-800/60 transition-colors">
                <td className="px-4 py-3 font-mono font-bold text-sky-300 text-sm">{item.codigo}</td>
                <td className="px-4 py-3 text-slate-200 max-w-[220px] truncate font-medium">{item.descripcion}</td>
                <td className="px-4 py-3 text-slate-200 font-semibold">{item.bloque}</td>
                <td className="px-4 py-3 text-slate-200 font-semibold hidden sm:table-cell">{item.torre}</td>
                <td className="px-4 py-3 text-slate-200 font-semibold hidden sm:table-cell">{item.piso}</td>
                <td className="px-4 py-3 text-slate-200 font-semibold hidden sm:table-cell">{item.posicion}</td>
                <td className="px-4 py-3 text-right">
                  <span className="text-emerald-300 font-bold text-base">{item.stock}</span>
                  <span className="text-slate-400 ml-1 text-xs">{item.un}</span>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {item.proveedor ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-violet-500/25 text-violet-200 border border-violet-500/40">
                      {item.proveedor}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-200 font-medium hidden md:table-cell">{item.fVencimiento || '—'}</td>
                <td className={`px-4 py-3 text-right font-bold text-base ${DIAS_COLOR[item.status]}`}>
                  {item.status === 'sin_fecha' ? '—' : item.diasRestantes}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${STATUS_BADGE[item.status]}`}>
                    <span className={`w-2 h-2 rounded-full ${STATUS_BADGE_DOT[item.status]}`} />
                    {item.status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center text-slate-500 py-10 text-base">
                  {hasActiveFilters ? 'Sin resultados para los filtros aplicados' : 'Sin registros FEFO'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
