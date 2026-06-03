'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  fetchOcupacionCeldas,
  fetchMovimientos,
  stockEnUbicacion,
  type Movimiento,
  type StockEnUbicacion,
  type OcupacionCelda,
  addMovimiento,
  trasladarMovimiento,
  type TrasladoInput,
} from '@/lib/rackly/kardex'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque, totalCeldas } from '@/lib/rackly/ubicaciones'
import { supabase } from '@/lib/supabase/client'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { requiereProveedor, extractError, isInsufficientStockError } from '@/lib/utils'
import { PROVEEDORES_FILM } from '@/lib/rackly/constants'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  Download, Loader2, ArrowDownToLine, ArrowUpFromLine, Building2, Layers,
  BoxSelect, Activity, ArrowRightLeft, RotateCcw, X, AlertTriangle, CheckCircle2,
  Package, CalendarOff, CalendarClock, Flame,
} from 'lucide-react'

// Calcula días restantes hasta vencimiento (negativo si ya venció)
function diasParaVencer(fVencimiento: string | undefined): number | null {
  if (!fVencimiento) return null
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const venc = new Date(fVencimiento + 'T00:00:00')
  return Math.ceil((venc.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24))
}

// Detecta códigos duplicados (mismo artículo con distintas fechas de vencimiento)
function codigosConMultiplesLotes(stock: StockEnUbicacion[]): Set<string> {
  const counts = new Map<string, number>()
  for (const s of stock) {
    counts.set(s.codigo, (counts.get(s.codigo) ?? 0) + 1)
  }
  const multiples = new Set<string>()
  for (const [code, count] of counts) {
    if (count > 1) multiples.add(code)
  }
  return multiples
}

// Calcula ocupación desde movimientos — rastrea stock POR LOTE (código + vencimiento).
// Normaliza códigos (trim + uppercase) para evitar falsos multi-artículo por diferencias de formato.
function calcularOcupacion(movs: Movimiento[]): OcupacionCelda[] {
  // Mapa: ubicacion_key → (lote_key "codigo||fVencimiento" → stock)
  const cellMap = new Map<string, Map<string, number>>()
  for (const m of movs) {
    const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
    const code = m.codigo.trim().toUpperCase()
    const lotKey = `${code}||${m.fVencimiento || ''}`
    let lotMap = cellMap.get(key)
    if (!lotMap) { lotMap = new Map(); cellMap.set(key, lotMap) }
    const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
    const current = lotMap.get(lotKey) ?? 0
    lotMap.set(lotKey, current + delta)
  }
  // Construir resultado: solo celdas con stock total > 0
  const result: OcupacionCelda[] = []
  for (const [key, lotMap] of cellMap) {
    let totalStock = 0
    const codigos = new Set<string>()
    let lotes = 0
    for (const [lotKey, stock] of lotMap) {
      if (stock > 0) {
        totalStock += stock
        lotes++
        codigos.add(lotKey.split('||')[0])
      }
    }
    if (totalStock > 0) {
      const [bloque, torre, piso, posicion] = key.split('-')
      result.push({ bloque, torre, piso, posicion, stock: totalStock, codigos: Array.from(codigos), lotes })
    }
  }
  return result
}

type DetailMode = 'view' | 'ingreso' | 'salida' | 'transferir'

export function OcupacionTab() {
  const { perfil } = useAuth()
  const [ocupacion, setOcupacion] = useState<OcupacionCelda[]>([])
  const [bloqueFilter, setBloqueFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ bloque: string; torre: string; piso: string; posicion: string; stock: StockEnUbicacion[] } | null>(null)
  const [detailMode, setDetailMode] = useState<DetailMode>('view')
  const [busyExport, setBusyExport] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const mountedRef = useRef(true)

  // ── Ingreso state ──
  const [ingTipo, setIngTipo] = useState<'ingreso' | 'devolucion'>('ingreso')
  const [ingCodigo, setIngCodigo] = useState('')
  const [ingDescripcion, setIngDescripcion] = useState('')
  const [ingUn, setIngUn] = useState('')
  const [ingCantidad, setIngCantidad] = useState('')
  const [ingFVenc, setIngFVenc] = useState('')
  const [ingSinFecha, setIngSinFecha] = useState(false)
  const [ingProveedor, setIngProveedor] = useState('')

  // ── Salida state ──
  const [salidaIdx, setSalidaIdx] = useState(0)
  const [salidaCantidad, setSalidaCantidad] = useState('')
  const [salidaTotal, setSalidaTotal] = useState(false)

  // ── Transferir state ──
  const [trIdx, setTrIdx] = useState(0)
  const [trDestBloque, setTrDestBloque] = useState('')
  const [trDestTorre, setTrDestTorre] = useState('')
  const [trDestPiso, setTrDestPiso] = useState('')
  const [trDestPos, setTrDestPos] = useState('')
  const [trCantidad, setTrCantidad] = useState('')

  // ── Data refresh ──
  // Primario: calcularOcupacion directo desde movimientos (incluye ingreso/salida/devolucion/traslado)
  // Fallback: RPC 'ocupacion_celdas' (server-side)
  const refreshData = useCallback(async () => {
    try {
      // Cálculo directo desde movimientos — siempre incluye todos los tipos
      const movs = await fetchMovimientos()
      if (mountedRef.current) setOcupacion(calcularOcupacion(movs))
    } catch {
      // Fallback al RPC si falla la carga de movimientos
      try {
        const celdas = await fetchOcupacionCeldas()
        if (mountedRef.current) setOcupacion(celdas)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error'
        if (mountedRef.current) toast.error('Error al cargar ocupación', { description: msg })
      }
    }
  }, [])

  const refreshDetail = useCallback(async () => {
    if (!detail) return
    try {
      const stock = await stockEnUbicacion(detail.bloque, detail.torre, detail.piso, detail.posicion)
      if (mountedRef.current) setDetail({ ...detail, stock })
    } catch { /* ok */ }
  }, [detail])

  useEffect(() => { mountedRef.current = true; setLoading(true); refreshData().finally(() => { if (mountedRef.current) setLoading(false) }); return () => { mountedRef.current = false } }, [refreshData])
  useEffect(() => { const i = setInterval(() => refreshData(), 10000); return () => clearInterval(i) }, [refreshData])
  useEffect(() => {
    let ch: ReturnType<typeof supabase.channel> | null = null
    try { ch = supabase.channel('ocupacion-rt').on('postgres_changes', { event: '*', schema: 'public', table: 'movimientos' }, () => refreshData()).subscribe() } catch { /* ok */ }
    return () => { if (ch) try { supabase.removeChannel(ch) } catch { /* ok */ } }
  }, [refreshData])

  // ── Derived stats ──
  const totalPosBloque = (b: string) => torresDeBloque(b).length * PISOS.length * posicionesDeBloque(b).length
  const filtered = bloqueFilter === 'all' ? ocupacion : ocupacion.filter(o => o.bloque === bloqueFilter)
  const occupied = filtered.filter(o => o.stock > 0).length
  const multiArt = filtered.filter(o => o.stock > 0 && o.codigos.length > 1).length
  const multiLote = filtered.filter(o => o.stock > 0 && o.codigos.length === 1 && o.lotes > 1).length
  const singleArt = occupied - multiArt - multiLote
  const total = bloqueFilter === 'all' ? totalCeldas() : totalPosBloque(bloqueFilter)
  const empty = total - occupied
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0

  // ── Transferir: derived ──
  const trTorres = trDestBloque ? torresDeBloque(trDestBloque) : []
  const trPositions = trDestBloque ? posicionesDeBloque(trDestBloque) : []
  const trItem = detail?.stock[trIdx] ?? null
  const trQtyNum = parseFloat(trCantidad) || 0
  const trExcede = trItem ? trQtyNum > trItem.stock : false
  const trFalta = trItem ? trQtyNum > 0 && trQtyNum < trItem.stock : false
  const trDiferencia = trItem ? trQtyNum - trItem.stock : 0
  const trTieneAjuste = trExcede || trFalta

  // ── Ingreso: proveedor visible? ──
  const showProveedor = ingDescripcion ? requiereProveedor(ingDescripcion) : false

  // ── Handlers ──
  async function handleCellClick(b: string, t: string, p: string, pos: string) {
    try {
      setDetail({ bloque: b, torre: t, piso: p, posicion: pos, stock: await stockEnUbicacion(b, t, p, pos) })
      setDetailMode('view')
    } catch { toast.error('Error al cargar detalle') }
  }

  function openIngreso(tipo?: 'ingreso' | 'devolucion') {
    setIngTipo(tipo ?? 'ingreso')
    setIngCodigo(''); setIngDescripcion(''); setIngUn('')
    setIngCantidad(''); setIngFVenc('')
    setIngSinFecha(false); setIngProveedor('')
    setDetailMode('ingreso')
  }

  function openSalida(idx: number, total: boolean) {
    if (!detail?.stock[idx]) return
    setSalidaIdx(idx); setSalidaTotal(total)
    setSalidaCantidad(total ? String(detail.stock[idx].stock) : '')
    setDetailMode('salida')
  }

  function openTransferir(idx: number) {
    if (!detail?.stock[idx]) return
    setTrIdx(idx); setTrCantidad(String(detail.stock[idx].stock))
    setTrDestBloque(''); setTrDestTorre(''); setTrDestPiso(''); setTrDestPos('')
    setDetailMode('transferir')
  }

  /** Called when a catalog item is selected from the search input */
  function handleCatalogoPick(item: { codigo: string; descripcion: string; un: string }) {
    setIngCodigo(item.codigo)
    setIngDescripcion(item.descripcion)
    setIngUn(item.un)
    // Reset proveedor if new description doesn't require it
    if (!requiereProveedor(item.descripcion)) {
      setIngProveedor('')
    }
  }

  async function doIngreso() {
    if (!detail || !perfil) return
    if (!ingCodigo.trim() || !ingCantidad) { toast.error('Completa código y cantidad'); return }
    const q = parseFloat(ingCantidad); if (isNaN(q) || q <= 0) { toast.error('Cantidad inválida'); return }
    if (showProveedor && !ingProveedor) { toast.error('Selecciona un proveedor para este artículo'); return }
    setActionBusy(true)
    try {
      await addMovimiento({
        tipo: ingTipo, bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: ingCodigo.trim().toUpperCase(), descripcion: ingDescripcion, un: ingUn, cantidad: q,
        fVencimiento: ingSinFecha ? '' : ingFVenc,
        turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        proveedor: showProveedor ? ingProveedor : undefined,
      })
      toast.success(ingTipo === 'ingreso' ? 'Ingreso registrado' : 'Devolución registrada')
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setActionBusy(false) }
  }

  async function doSalida() {
    if (!detail || !perfil) return
    const item = detail.stock[salidaIdx]
    if (!item) return
    const qty = parseFloat(salidaCantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    if (qty > item.stock) { toast.error(`Cantidad excede stock (${item.stock})`); return }
    setActionBusy(true)
    try {
      await addMovimiento({
        tipo: 'salida', bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: item.codigo, descripcion: item.descripcion, un: item.un, cantidad: qty,
        fVencimiento: item.fVencimiento ?? '', turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
      })
      toast.success('Salida registrada')
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        toast.error('Stock insuficiente', { description: 'Otro usuario pudo haber modificado el stock. Los datos se han actualizado.', duration: 6000 })
        refreshDetail(); refreshData()
      } else { toast.error('Error al registrar salida', { description: extractError(err) }) }
    } finally { setActionBusy(false) }
  }

  async function doTransferir() {
    if (!detail || !perfil || !trItem) return
    if (!trDestBloque || !trDestTorre || !trDestPiso || !trDestPos) { toast.error('Completa destino'); return }
    const qty = parseFloat(trCantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    const origKey = `${detail.bloque}-${detail.torre}-${detail.piso}-${detail.posicion}`
    const destKey = `${trDestBloque}-${trDestTorre}-${trDestPiso}-${trDestPos}`
    if (origKey === destKey) { toast.error('Origen y destino no pueden ser iguales'); return }
    setActionBusy(true)
    try {
      // Check destination occupancy
      const destStock = await stockEnUbicacion(trDestBloque, trDestTorre, trDestPiso, trDestPos)
      if (destStock.length > 0) {
        toast.error(`Destino ocupado con ${destStock.length} artículo(s). Vacía primero el destino.`)
        setActionBusy(false); return
      }
      const input: TrasladoInput = {
        codigo: trItem.codigo, descripcion: trItem.descripcion, un: trItem.un, cantidad: qty,
        origen: { bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion },
        destino: { bloque: trDestBloque, torre: trDestTorre, piso: trDestPiso, posicion: trDestPos },
        turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        fVencimiento: trItem.fVencimiento ?? '',
        cantidadAjuste: trTieneAjuste ? trDiferencia : 0,
      }
      await trasladarMovimiento(input)
      toast.success('Traslado registrado')
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        toast.error('Stock insuficiente en origen', { description: 'Otro usuario pudo haber modificado el stock. Los datos se han actualizado.', duration: 6000 })
        refreshDetail(); refreshData()
      } else { toast.error('Error al trasladar', { description: extractError(err) }) }
    } finally { setActionBusy(false) }
  }

  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')
      // Generar TODAS las posiciones (ocupadas + vacías)
      const bloques = bloqueFilter === 'all' ? BLOQUES : [bloqueFilter]
      const data: Record<string, string | number>[] = []
      for (const b of bloques) {
        for (const t of torresDeBloque(b)) {
          for (const p of PISOS) {
            for (const pos of posicionesDeBloque(b)) {
              const cell = ocupacion.find(o => o.bloque === b && o.torre === t && o.piso === p && o.posicion === pos)
              const isOcc = cell && cell.stock > 0
              data.push({
                Bloque: b,
                Torre: t,
                Piso: p,
                Posición: pos,
                Stock: isOcc ? cell.stock : 0,
                Códigos: isOcc ? cell.codigos.join(', ') : '',
                Artículos: isOcc ? cell.codigos.length : 0,
                Estado: isOcc ? (cell!.codigos.length > 1 ? 'Mixto' : cell!.lotes > 1 ? 'Multi-lote' : 'Ocupado') : 'Vacío',
                Lotes: isOcc ? cell!.lotes : 0,
              })
            }
          }
        }
      }
      const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Ocupación'); XLSX.writeFile(wb, `RACKLY_Ocupacion_${new Date().toISOString().slice(0, 10)}.xlsx`); toast.success('Exportado')
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusyExport(false) }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 animate-pulse" />
          <p className="text-sm text-slate-400 animate-pulse">Cargando ocupación...</p>
        </div>
      </div>
    )
  }

  const dashBloques = BLOQUES.map(b => {
    const bt = totalPosBloque(b), bo = ocupacion.filter(o => o.bloque === b && o.stock > 0).length
    const bm = ocupacion.filter(o => o.bloque === b && o.stock > 0 && o.codigos.length > 1).length
    const bl = ocupacion.filter(o => o.bloque === b && o.stock > 0 && o.codigos.length === 1 && o.lotes > 1).length
    return { bloque: b, total: bt, occupied: bo, multi: bm, multiLote: bl, empty: bt - bo, pct: bt > 0 ? Math.round((bo / bt) * 100) : 0 }
  })

  const isView = detailMode === 'view'
  const salItem = detail?.stock[salidaIdx]

  return (
    <div className="space-y-5">
      {/* ═══ DASHBOARD ═══ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-600/40 bg-gradient-to-br from-slate-800 to-slate-900 p-4 shadow-md">
          <div className="flex items-center gap-2 mb-2"><div className="w-6 h-6 rounded-lg bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center"><BoxSelect className="w-3 h-3 text-white" /></div><p className="text-[10px] font-semibold text-sky-400/80 uppercase tracking-widest">Total</p></div>
          <p className="text-2xl font-bold text-slate-100">{total.toLocaleString()}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">{bloqueFilter === 'all' ? 'Todos los bloques' : `Bloque ${bloqueFilter}`}</p>
        </div>
        <div className="rounded-xl border border-blue-600/30 bg-gradient-to-br from-blue-950/40 to-slate-900 p-4 shadow-md">
          <div className="flex items-center gap-2 mb-2"><div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center"><Layers className="w-3 h-3 text-white" /></div><p className="text-[10px] font-semibold text-blue-400/80 uppercase tracking-widest">Ocupadas</p></div>
          <p className="text-2xl font-bold text-blue-300">{occupied}</p>
          <p className="text-[10px] text-blue-600/60 mt-0.5">{singleArt} simple · {multiLote} multi-lote · {multiArt} mixtas</p>
        </div>
        <div className="rounded-xl border border-emerald-600/30 bg-gradient-to-br from-emerald-950/40 to-slate-900 p-4 shadow-md">
          <div className="flex items-center gap-2 mb-2"><div className="w-6 h-6 rounded-lg bg-gradient-to-br from-emerald-400 to-green-600 flex items-center justify-center"><Activity className="w-3 h-3 text-white" /></div><p className="text-[10px] font-semibold text-emerald-400/80 uppercase tracking-widest">Vacías</p></div>
          <p className="text-2xl font-bold text-emerald-300">{empty.toLocaleString()}</p>
          <p className="text-[10px] text-sky-600/60 mt-0.5">Disponibles</p>
        </div>
        <div className="rounded-xl border border-violet-600/30 bg-gradient-to-br from-violet-950/40 to-slate-900 p-4 shadow-md">
          <div className="flex items-center gap-2 mb-2"><div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center"><Building2 className="w-3 h-3 text-white" /></div><p className="text-[10px] font-semibold text-violet-400/80 uppercase tracking-widest">Ocupación</p></div>
          <p className="text-2xl font-bold text-violet-300">{pct}<span className="text-base">%</span></p>
          <div className="mt-2 h-1.5 rounded-full bg-slate-700/60 overflow-hidden"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(pct, 100)}%`, background: pct > 80 ? 'linear-gradient(90deg,#ef4444,#f97316)' : pct > 50 ? 'linear-gradient(90deg,#f59e0b,#f97316)' : 'linear-gradient(90deg,#0ea5e9,#3b82f6)' }} /></div>
        </div>
      </div>

      {/* ═══ RESUMEN POR BLOQUE ═══ */}
      <div className="rounded-xl border border-slate-600/30 bg-slate-800/60 shadow-md overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-600/30 flex items-center gap-2"><div className="w-1 h-3.5 rounded-full bg-gradient-to-b from-sky-400 to-blue-500" /><p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Resumen por bloque</p></div>
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-px bg-slate-700/20">
          {dashBloques.map(db => (
            <button key={db.bloque} className="bg-slate-800/60 p-2 text-center space-y-1 transition-colors hover:bg-slate-700/60" onClick={() => setBloqueFilter(bloqueFilter === db.bloque ? 'all' : db.bloque)}>
              <div className={`w-7 h-7 rounded-lg mx-auto flex items-center justify-center text-xs font-bold transition-all ${bloqueFilter === db.bloque ? 'bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-md scale-105' : 'bg-slate-700 text-slate-400'}`}>{db.bloque}</div>
              <p className="text-[9px] text-slate-500">{db.total} pos</p>
              <div className="flex justify-center gap-1"><span className="text-[9px] font-bold text-blue-400">{db.occupied}</span><span className="text-[9px] text-slate-600">/</span><span className="text-[9px] font-bold text-emerald-400">{db.empty}</span></div>
              {db.multiLote > 0 && <span className="text-[8px] font-semibold text-yellow-400 bg-yellow-400/10 px-1 py-px rounded">{db.multiLote} lote</span>}
              {db.multi > 0 && <span className="text-[8px] font-semibold text-amber-400 bg-amber-400/10 px-1 py-px rounded">{db.multi} mix</span>}
              <div className="h-1 rounded-full bg-slate-700/60 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-500" style={{ width: `${db.pct}%` }} /></div>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ FILTROS Y LEYENDA ═══ */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Select value={bloqueFilter} onValueChange={setBloqueFilter}>
          <SelectTrigger className="w-40 bg-slate-800/60 border-slate-600/40 text-slate-300 text-xs"><SelectValue placeholder="Filtrar bloque" /></SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-600/40"><SelectItem value="all" className="text-slate-300 focus:bg-slate-700">Todos</SelectItem>{BLOQUES.map(b => <SelectItem key={b} value={b} className="text-slate-300 focus:bg-slate-700">Bloque {b}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-4 text-[10px] text-slate-400">
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-blue-400 to-blue-600" /><span>Ocupado</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-blue-400 to-blue-600 relative"><span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full" /></div><span>Multi-lote</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-amber-400 to-orange-500" /><span>Multi-art.</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-emerald-400 to-green-600" /><span>Vacío</span></div>
        </div>
      </div>

      {/* ═══ GRID DE BLOQUES ═══ */}
      <div className="space-y-6">
        {BLOQUES.filter(b => bloqueFilter === 'all' || b === bloqueFilter).map(bloque => {
          const torres = torresDeBloque(bloque)
          const posiciones = posicionesDeBloque(bloque)
          const bTotal = totalPosBloque(bloque)
          const bOcup = ocupacion.filter(o => o.bloque === bloque && o.stock > 0).length
          const bEmpty = bTotal - bOcup
          const bPct = bTotal > 0 ? Math.round((bOcup / bTotal) * 100) : 0
          return (
            <div key={bloque} className="rounded-xl border border-slate-600/30 bg-gradient-to-b from-slate-800/80 to-slate-900/80 shadow-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-600/25 bg-gradient-to-r from-slate-800/60 to-transparent flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-blue-500 flex items-center justify-center text-white font-bold text-xs shadow">{bloque}</div>
                  <div><p className="text-xs font-bold text-slate-200">Bloque {bloque}</p><p className="text-[10px] text-slate-500">{torres.length} torre(s) · {posiciones.length} pos/torre</p></div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 rounded-full bg-slate-700/50 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-700" style={{ width: `${bPct}%` }} /></div>
                  <span className="text-xs font-bold text-sky-400">{bPct}%</span>
                  <span className="text-[10px] text-slate-500">({bOcup}/{bTotal})</span>
                </div>
              </div>
              <div className="p-3 sm:p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
                  {torres.map(torre => {
                    const tTotal = PISOS.length * posiciones.length
                    const tOcup = ocupacion.filter(o => o.bloque === bloque && o.torre === torre && o.stock > 0).length
                    const halfLen = Math.ceil(posiciones.length / 2)
                    const posA = posiciones.slice(0, halfLen)
                    const posB = posiciones.slice(halfLen)
                    return (
                      <div key={torre}>
                        <div className="flex items-center justify-between px-3 py-1.5 mb-2">
                          <div className="flex items-center gap-1.5"><div className="w-1.5 h-4 rounded-sm bg-gradient-to-b from-sky-400 to-blue-500" /><span className="text-[11px] font-bold text-slate-300">Torre {torre}</span></div>
                          <div className="flex items-center gap-1"><span className="text-[10px] font-bold text-blue-400">{tOcup}</span><span className="text-[10px] text-slate-600">/</span><span className="text-[10px] font-bold text-emerald-400">{tTotal}</span></div>
                        </div>
                        <div className="space-y-1">
                          {PISOS.map(piso => {
                            const pisoOcup = posiciones.filter(pos => { const c = ocupacion.find(o => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos); return c && c.stock > 0 }).length
                            return (
                              <div key={piso} className="rounded-lg border border-slate-600/15 bg-slate-900/40 overflow-hidden">
                                <div className="flex items-center justify-center gap-2 py-1.5 px-2 bg-slate-800/50 border-b border-slate-700/15">
                                  <div className={`w-1.5 h-1.5 rounded-full ${pisoOcup > 0 ? 'bg-blue-400' : 'bg-slate-600'}`} />
                                  <span className="text-[10px] font-bold text-slate-300 tracking-wide">PISO {piso}</span>
                                  {pisoOcup > 0 && <span className="text-[9px] font-bold text-blue-400 bg-blue-400/10 px-1.5 py-px rounded-full">{pisoOcup}</span>}
                                  <div className="flex-1 h-px bg-slate-700/20" />
                                  <span className="text-[8px] text-slate-600">{posA.length}+{posB.length}</span>
                                </div>
                                <div className="flex px-1.5 pt-1.5 gap-[2px]">
                                  {posA.map(pos => {
                                    const cell = ocupacion.find(o => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos)
                                    const isOcc = cell && cell.stock > 0
                                    const isMultiArt = isOcc && cell.codigos.length > 1
                                    const isMultiLote = isOcc && !isMultiArt && cell.lotes > 1
                                    let cls = 'relative flex-1 min-w-[24px] h-11 rounded text-[9px] font-bold transition-all duration-150 cursor-pointer border '
                                    if (isMultiArt) cls += 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_1px_3px_rgba(245,158,11,0.25)] hover:shadow-[0_2px_6px_rgba(245,158,11,0.35)] hover:scale-105 active:scale-95 border-amber-300/25'
                                    else if (isOcc) cls += 'bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-[0_1px_3px_rgba(59,130,246,0.25)] hover:shadow-[0_2px_6px_rgba(59,130,246,0.35)] hover:scale-105 active:scale-95 border-blue-300/25'
                                    else cls += 'bg-gradient-to-br from-emerald-400/60 to-green-600/60 text-white/60 shadow-[0_1px_2px_rgba(16,185,129,0.1)] hover:shadow-[0_2px_4px_rgba(16,185,129,0.2)] hover:from-emerald-400 hover:to-green-500 hover:text-white hover:scale-105 active:scale-95 border-emerald-400/15'
                                    return <button key={pos} className={cls} onClick={() => handleCellClick(bloque, torre, piso, pos)} title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOcc ? ` · Stock: ${cell.stock}${isMultiArt ? ` · ${cell.codigos.length} artículos` : ''}${isMultiLote ? ` · ${cell.lotes} lotes` : ''}` : ' · Vacío'}`}>{pos}{isMultiLote && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full ring-1 ring-slate-800" />}</button>
                                  })}
                                </div>
                                <div className="flex px-1.5 pt-[2px] pb-1.5 gap-[2px]">
                                  {posB.map(pos => {
                                    const cell = ocupacion.find(o => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos)
                                    const isOcc = cell && cell.stock > 0
                                    const isMultiArt = isOcc && cell.codigos.length > 1
                                    const isMultiLote = isOcc && !isMultiArt && cell.lotes > 1
                                    let cls = 'relative flex-1 min-w-[24px] h-11 rounded text-[9px] font-bold transition-all duration-150 cursor-pointer border '
                                    if (isMultiArt) cls += 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_1px_3px_rgba(245,158,11,0.25)] hover:shadow-[0_2px_6px_rgba(245,158,11,0.35)] hover:scale-105 active:scale-95 border-amber-300/25'
                                    else if (isOcc) cls += 'bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-[0_1px_3px_rgba(59,130,246,0.25)] hover:shadow-[0_2px_6px_rgba(59,130,246,0.35)] hover:scale-105 active:scale-95 border-blue-300/25'
                                    else cls += 'bg-gradient-to-br from-emerald-400/60 to-green-600/60 text-white/60 shadow-[0_1px_2px_rgba(16,185,129,0.1)] hover:shadow-[0_2px_4px_rgba(16,185,129,0.2)] hover:from-emerald-400 hover:to-green-500 hover:text-white hover:scale-105 active:scale-95 border-emerald-400/15'
                                    return <button key={pos} className={cls} onClick={() => handleCellClick(bloque, torre, piso, pos)} title={`B${bloque}-T${torre}-P${piso}-Pos${pos}${isOcc ? ` · Stock: ${cell.stock}${isMultiArt ? ` · ${cell.codigos.length} artículos` : ''}${isMultiLote ? ` · ${cell.lotes} lotes` : ''}` : ' · Vacío'}`}>{pos}{isMultiLote && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full ring-1 ring-slate-800" />}</button>
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Exportar */}
      <div className="flex justify-end">
        <Button onClick={handleExport} disabled={busyExport} variant="outline" size="sm" className="gap-1.5 border-slate-600/40 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-sky-400 text-xs">
          {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Exportar
        </Button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          DIÁLOGO PRINCIPAL — Vista, Ingreso, Salida, Transferir
          Todo dentro de la misma ventana emergente
          ═══════════════════════════════════════════════════════════════════ */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setDetailMode('view') } }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-xl bg-slate-800 border-slate-600/40 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain">
          <DialogHeader>
            <DialogTitle className="bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent font-bold text-sm">
              B{detail?.bloque} · T{detail?.torre} · P{detail?.piso} · Pos {detail?.posicion}
              {!isView && <span className="text-slate-400 font-normal text-xs ml-2">
                — {detailMode === 'ingreso' ? (ingTipo === 'ingreso' ? 'Ingreso' : 'Devolución') : detailMode === 'salida' ? 'Salida' : 'Transferir'}
              </span>}
            </DialogTitle>
          </DialogHeader>

          {detail && (<>
            {/* ═══════ MODO: VISTA ═══════ */}
            {isView && (
              detail.stock.length > 0 ? (
                <>
                  {/* Lista de artículos — separados por lote (código + vencimiento), orden FEFO */}
                  {(() => {
                    const multiples = codigosConMultiplesLotes(detail.stock)
                    return (
                      <div className="space-y-2">
                        {detail.stock.map((s, i) => {
                          const dias = diasParaVencer(s.fVencimiento)
                          const esLoteMultiple = multiples.has(s.codigo)
                          // Clase de color según urgencia de vencimiento
                          let vencBadge = ''
                          if (dias !== null) {
                            if (dias < 0) { vencBadge = 'bg-red-500/15 border-red-500/25 text-red-400' }
                            else if (dias <= 15) { vencBadge = 'bg-orange-500/15 border-orange-500/25 text-orange-400' }
                            else if (dias <= 30) { vencBadge = 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' }
                            else { vencBadge = 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' }
                          }
                          return (
                            <div key={`${s.codigo}-${s.fVencimiento || 'sin-fecha'}`} className={`rounded-lg border overflow-hidden ${esLoteMultiple ? 'border-sky-500/25 bg-gradient-to-r from-sky-950/20 to-slate-700/20' : 'border-slate-600/30 bg-slate-700/20'}`}>
                              <div className="p-3 space-y-1.5">
                                {/* Encabezado: código + badges */}
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-mono text-sky-400 font-bold text-xs">{s.codigo}</span>
                                      {s.proveedor && <span className="text-[8px] font-semibold text-purple-400 bg-purple-400/10 px-1.5 py-px rounded">{s.proveedor}</span>}
                                      {/* Badge FEFO: indica que hay múltiples lotes del mismo artículo */}
                                      {esLoteMultiple && (
                                        <span className="flex items-center gap-0.5 text-[8px] font-bold text-sky-300 bg-sky-400/15 border border-sky-400/20 px-1.5 py-px rounded">
                                          <CalendarClock className="w-2.5 h-2.5" /> FEFO #{i + 1}
                                        </span>
                                      )}
                                    </div>
                                    {s.descripcion && <p className="text-slate-300 text-xs mt-0.5 truncate">{s.descripcion}</p>}
                                    {/* Fecha de vencimiento con badge de urgencia */}
                                    <div className="flex items-center gap-2 mt-1 text-[10px] flex-wrap">
                                      {s.fVencimiento && (
                                        <span className={`flex items-center gap-1 px-1.5 py-px rounded border ${vencBadge || 'border-slate-600/20 text-slate-500'}`}>
                                          {dias !== null && dias < 0 && <Flame className="w-2.5 h-2.5" />}
                                          Venc: {s.fVencimiento}
                                          {dias !== null && (
                                            <span className="font-semibold">({dias < 0 ? `${Math.abs(dias)}d vencido` : `${dias}d`})</span>
                                          )}
                                        </span>
                                      )}
                                      {!s.fVencimiento && <span className="italic text-slate-500">Sin fecha de vencimiento</span>}
                                      {s.usuarioPrimerNombre && <span className="text-slate-500">Ing: {s.usuarioPrimerNombre}</span>}
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <p className="font-bold text-emerald-400 text-sm">{s.stock}</p>
                                    <p className="text-[10px] text-slate-500">{s.un}</p>
                                  </div>
                                </div>
                                {/* Botones de acción */}
                                <div className="flex items-center gap-1 pt-1">
                                  <button onClick={() => openSalida(i, true)} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors text-[10px] font-medium"><ArrowUpFromLine className="w-3 h-3" /> Salida total</button>
                                  <button onClick={() => openSalida(i, false)} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 hover:text-orange-300 transition-colors text-[10px] font-medium"><ArrowUpFromLine className="w-3 h-3" /> Parcial</button>
                                  <button onClick={() => openTransferir(i)} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 transition-colors text-[10px] font-medium"><ArrowRightLeft className="w-3 h-3" /> Transferir</button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                  {/* Botones principales */}
                  <div className="flex gap-2 pt-1">
                    <Button onClick={() => openIngreso('ingreso')} size="sm" className="flex-1 gap-1.5 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-xs"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                  </div>
                </>
              ) : (
                /* Ubicación vacía */
                <div className="space-y-3 py-2">
                  <div className="flex flex-col items-center gap-2 py-4">
                    <BoxSelect className="w-8 h-8 text-slate-600" />
                    <p className="text-slate-500 text-sm">Ubicación vacía</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button onClick={() => openIngreso('ingreso')} size="sm" className="gap-1.5 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-xs"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                    <Button onClick={() => openIngreso('devolucion')} size="sm" className="gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white text-xs"><RotateCcw className="h-3.5 w-3.5" /> Devolución</Button>
                  </div>
                </div>
              )
            )}

            {/* ═══════ MODO: INGRESO / DEVOLUCIÓN ═══════ */}
            {detailMode === 'ingreso' && (
              <div className="space-y-3">
                {/* Alerta posición ocupada */}
                {detail.stock.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <span className="text-xs font-bold text-amber-400">Posición ocupada</span>
                    </div>
                    <p className="text-[10px] text-slate-400">Esta ubicación ya tiene {detail.stock.length} artículo(s). Se agregará el nuevo producto en la misma posición.</p>
                    <div className="space-y-1 mt-1">
                      {detail.stock.map((s, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px] bg-slate-800/40 rounded px-2 py-1">
                          <Package className="w-3 h-3 text-slate-500 flex-shrink-0" />
                          <span className="font-mono text-sky-400 font-medium">{s.codigo}</span>
                          <span className="text-slate-500 truncate flex-1">{s.descripcion || ''}</span>
                          <span className="text-emerald-400 font-bold flex-shrink-0">{s.stock} {s.un}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Toggle tipo */}
                <div className="flex gap-1 p-1 rounded-lg bg-slate-700/40">
                  <button onClick={() => setIngTipo('ingreso')} className={`flex-1 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1 ${ingTipo === 'ingreso' ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}><ArrowDownToLine className="w-3.5 h-3.5" /> Ingreso</button>
                  <button onClick={() => setIngTipo('devolucion')} className={`flex-1 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center gap-1 ${ingTipo === 'devolucion' ? 'bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}><RotateCcw className="w-3.5 h-3.5" /> Devolución</button>
                </div>
                <p className="text-[10px] text-slate-500">Ubicación: <span className="text-sky-400 font-mono">B{detail.bloque} T{detail.torre} P{detail.piso} Pos {detail.posicion}</span></p>

                {/* Búsqueda de artículo por código o descripción */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-slate-400">Buscar artículo (código o descripción) *</Label>
                  <CatalogoSearchInput
                    onPick={handleCatalogoPick}
                    value={ingCodigo}
                    onChange={(val) => {
                      setIngCodigo(val)
                      // If user clears or types manually, don't auto-clear descripcion/un
                      // They might be editing manually
                    }}
                  />
                </div>

                {/* Descripción y UN (auto-llenados, pero editables) */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><Label className="text-[10px] text-slate-400">Descripción</Label><Input value={ingDescripcion} onChange={e => setIngDescripcion(e.target.value)} placeholder="Auto o manual" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" /></div>
                  <div className="space-y-1"><Label className="text-[10px] text-slate-400">UN</Label><Input value={ingUn} onChange={e => setIngUn(e.target.value)} placeholder="KG" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" /></div>
                </div>

                {/* Cantidad */}
                <div className="space-y-1"><Label className="text-[10px] text-slate-400">Cantidad *</Label><Input type="number" step="any" min="0.001" value={ingCantidad} onChange={e => setIngCantidad(e.target.value)} placeholder="0" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" /></div>

                {/* Fecha de vencimiento + botón Sin Fecha */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-slate-400">Fecha de vencimiento</Label>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={ingSinFecha ? '' : ingFVenc}
                      onChange={e => { setIngFVenc(e.target.value); if (e.target.value) setIngSinFecha(false) }}
                      disabled={ingSinFecha}
                      className="flex-1 h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50 disabled:opacity-40"
                    />
                    <button
                      type="button"
                      onClick={() => { setIngSinFecha(!ingSinFecha); if (!ingSinFecha) setIngFVenc('') }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all border flex-shrink-0 ${
                        ingSinFecha
                          ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                          : 'bg-slate-700/30 border-slate-600/30 text-slate-400 hover:text-slate-300 hover:border-slate-500/40'
                      }`}
                    >
                      <CalendarOff className="w-3.5 h-3.5" />
                      {ingSinFecha ? 'Sin fecha' : 'Sin fecha'}
                    </button>
                  </div>
                  {ingSinFecha && <p className="text-[10px] text-purple-400/80 italic">El artículo no tiene fecha de vencimiento</p>}
                </div>

                {/* Proveedor — solo si es LÁMINA o STRETCH (excepto ETIQUETA LAMINA) */}
                {showProveedor && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-purple-400 font-semibold">Proveedor *</Label>
                    <Select value={ingProveedor} onValueChange={setIngProveedor}>
                      <SelectTrigger className="h-8 bg-slate-700/50 border-purple-500/30 text-slate-200 text-xs">
                        <SelectValue placeholder="Seleccionar proveedor..." />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600/40">
                        {PROVEEDORES_FILM.map((p) => (
                          <SelectItem key={p} value={p} className="text-slate-300 focus:bg-slate-700">{p}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setDetailMode('view')} size="sm" className="flex-1 border-slate-600/40 text-slate-400 text-xs gap-1"><X className="w-3.5 h-3.5" /> Cancelar</Button>
                  <Button onClick={doIngreso} disabled={actionBusy} size="sm" className={`flex-1 gap-1.5 text-white text-xs ${ingTipo === 'ingreso' ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700' : 'bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700'}`}>{actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : ingTipo === 'ingreso' ? <><ArrowDownToLine className="h-3.5 w-3.5" /> Registrar</> : <><RotateCcw className="h-3.5 w-3.5" /> Registrar</>}</Button>
                </div>
              </div>
            )}

            {/* ═══════ MODO: SALIDA ═══════ */}
            {detailMode === 'salida' && salItem && (
              <div className="space-y-3">
                {/* Selector de artículo si hay múltiples */}
                {detail.stock.length > 1 && (
                  <div className="rounded-lg border border-slate-600/20 bg-slate-700/20 p-2">
                    <p className="text-[10px] text-slate-400 mb-1.5 font-medium">Selecciona el artículo a dar salida:</p>
                    <div className="space-y-1">
                      {detail.stock.map((s, i) => (
                        <button key={i} onClick={() => { setSalidaIdx(i); setSalidaCantidad(salidaTotal ? String(s.stock) : ''); }}
                          className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${i === salidaIdx ? 'bg-red-500/15 border border-red-500/30' : 'bg-slate-700/40 border border-transparent hover:bg-slate-700/60'}`}>
                          <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: i === salidaIdx ? '#f87171' : '#475569', backgroundColor: i === salidaIdx ? '#ef4444' : 'transparent' }}>
                            {i === salidaIdx && <div className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-xs text-sky-400">{s.codigo}</span>
                              {s.proveedor && <span className="text-[8px] font-semibold text-purple-400 bg-purple-400/10 px-1.5 py-px rounded">{s.proveedor}</span>}
                            </div>
                            {s.descripcion && <p className="text-[10px] text-slate-400 truncate">{s.descripcion}</p>}
                          </div>
                          <span className="font-bold text-emerald-400 text-xs flex-shrink-0">{s.stock} <span className="text-slate-500 font-normal">{s.un}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-1.5">
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Producto:</span><span className="text-slate-200 font-mono">{salItem.codigo}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Descripción:</span><span className="text-slate-300 truncate ml-2">{salItem.descripcion || '—'}</span></div>
                  {salItem.proveedor && <div className="flex justify-between text-xs"><span className="text-slate-400">Proveedor:</span><span className="text-purple-400 font-medium">{salItem.proveedor}</span></div>}
                  {salItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className={salItem.fVencimiento < new Date().toISOString().slice(0, 10) ? 'text-red-400 font-semibold' : 'text-slate-300'}>{salItem.fVencimiento}</span></div>}
                  {!salItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className="text-slate-500 italic">Sin fecha</span></div>}
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Stock actual:</span><span className="text-emerald-400 font-bold">{salItem.stock} {salItem.un}</span></div>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-slate-400">
                    {salidaTotal ? 'Salida total' : 'Cantidad a salir'} *
                    {!salidaTotal && <span className="text-slate-600 ml-1">(máx: {salItem.stock})</span>}
                  </Label>
                  <Input type="number" step="any" min="0.001" max={salItem.stock} value={salidaCantidad}
                    onChange={e => setSalidaCantidad(e.target.value)}
                    disabled={salidaTotal}
                    className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-red-500/50 disabled:opacity-50" />
                </div>
                {!salidaTotal && (
                  <p className="text-[10px] text-slate-500">Saldrán {salidaCantidad || '0'} de {salItem.stock} {salItem.un} — quedarán {Math.max(0, salItem.stock - (parseFloat(salidaCantidad) || 0))} {salItem.un}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setDetailMode('view')} size="sm" className="flex-1 border-slate-600/40 text-slate-400 text-xs gap-1"><X className="w-3.5 h-3.5" /> Cancelar</Button>
                  <Button onClick={doSalida} disabled={actionBusy} size="sm" className="flex-1 gap-1.5 bg-gradient-to-r from-red-500 to-red-600 text-white text-xs">
                    {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><ArrowUpFromLine className="h-3.5 w-3.5" /> Confirmar salida</>}
                  </Button>
                </div>
              </div>
            )}

            {/* ═══════ MODO: TRANSFERIR ═══════ */}
            {detailMode === 'transferir' && trItem && (
              <div className="space-y-3">
                {/* Info del producto */}
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-1.5">
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Producto:</span><span className="text-slate-200 font-mono">{trItem.codigo}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Descripción:</span><span className="text-slate-300">{trItem.descripcion || '—'}</span></div>
                  {trItem.proveedor && <div className="flex justify-between text-xs"><span className="text-slate-400">Proveedor:</span><span className="text-purple-400 font-medium">{trItem.proveedor}</span></div>}
                  {trItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className={trItem.fVencimiento < new Date().toISOString().slice(0, 10) ? 'text-red-400 font-semibold' : 'text-slate-300'}>{trItem.fVencimiento}</span></div>}
                  {!trItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className="text-slate-500 italic">Sin fecha</span></div>}
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Stock origen:</span><span className="text-emerald-400 font-bold">{trItem.stock} {trItem.un}</span></div>
                </div>

                {/* Origen */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Origen</p>
                <div className="rounded-lg border border-slate-600/20 bg-slate-700/30 px-3 py-2 text-xs text-slate-300 font-mono">
                  B{detail.bloque} · T{detail.torre} · P{detail.piso} · Pos {detail.posicion}
                </div>

                {/* Flecha */}
                <div className="flex justify-center"><ArrowRightLeft className="w-4 h-4 text-sky-400" /></div>

                {/* Destino */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Destino</p>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-500">Bloque</Label>
                    <Select value={trDestBloque} onValueChange={v => { setTrDestBloque(v); setTrDestTorre(''); setTrDestPos('') }}>
                      <SelectTrigger className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600/40">{BLOQUES.map(b => <SelectItem key={b} value={b} className="text-slate-300 focus:bg-slate-700">{b}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-500">Torre</Label>
                    <Select value={trDestTorre} onValueChange={setTrDestTorre} disabled={!trDestBloque}>
                      <SelectTrigger className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600/40">{trTorres.map(t => <SelectItem key={t} value={t} className="text-slate-300 focus:bg-slate-700">{t}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-500">Piso</Label>
                    <Select value={trDestPiso} onValueChange={setTrDestPiso} disabled={!trDestBloque}>
                      <SelectTrigger className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600/40">{PISOS.map(p => <SelectItem key={p} value={p} className="text-slate-300 focus:bg-slate-700">{p}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-500">Pos</Label>
                    <Select value={trDestPos} onValueChange={setTrDestPos} disabled={!trDestBloque}>
                      <SelectTrigger className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600/40">{trPositions.map(p => <SelectItem key={p} value={p} className="text-slate-300 focus:bg-slate-700">{p}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Cantidad */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-slate-400">Cantidad a transferir *</Label>
                  <Input type="number" step="any" min="0.001" value={trCantidad} onChange={e => setTrCantidad(e.target.value)}
                    className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" />
                </div>

                {/* Ajuste automático */}
                {trTieneAjuste && (
                  <div className={`rounded-lg border p-2.5 space-y-1.5 ${trExcede ? 'border-amber-500/30 bg-amber-500/5' : 'border-sky-500/30 bg-sky-500/5'}`}>
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className={`w-3.5 h-3.5 ${trExcede ? 'text-amber-400' : 'text-sky-400'}`} />
                      <span className={`text-[10px] font-bold ${trExcede ? 'text-amber-400' : 'text-sky-400'}`}>
                        {trExcede ? 'Ajuste positivo' : 'Ajuste negativo'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400">
                      {trExcede
                        ? `Se registrará un ingreso de ${Math.abs(trDiferencia)} ${trItem.un} en origen para cubrir la diferencia.`
                        : `Se registrará una salida de ${Math.abs(trDiferencia)} ${trItem.un} en origen para corregir el excedente.`}
                    </p>
                    <div className="flex gap-2 text-[10px]">
                      <span className="text-slate-500">Origen: {trItem.stock} → {trQtyNum} {trItem.un}</span>
                      <span className={`${trExcede ? 'text-amber-400' : 'text-sky-400'}`}>[{trDiferencia > 0 ? '+' : ''}{Math.abs(trDiferencia)} ajuste]</span>
                    </div>
                    <p className="text-[10px] text-slate-500">Destino: +{trQtyNum} {trItem.un}</p>
                  </div>
                )}

                {/* Múltiples artículos - selector */}
                {detail.stock.length > 1 && (
                  <div className="rounded-lg border border-slate-600/20 bg-slate-700/20 p-2">
                    <p className="text-[10px] text-slate-400 mb-1.5">Esta posición tiene {detail.stock.length} artículos. Se está transfiriendo:</p>
                    <div className="space-y-1">
                      {detail.stock.map((s, i) => (
                        <button key={i} onClick={() => { setTrIdx(i); setTrCantidad(String(s.stock)) }}
                          className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${i === trIdx ? 'bg-blue-500/15 border border-blue-500/30' : 'bg-slate-700/40 border border-transparent hover:bg-slate-700/60'}`}>
                          <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: i === trIdx ? '#60a5fa' : '#475569', backgroundColor: i === trIdx ? '#3b82f6' : 'transparent' }}>
                            {i === trIdx && <div className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-xs text-sky-400">{s.codigo}</span>
                              {s.proveedor && <span className="text-[8px] font-semibold text-purple-400 bg-purple-400/10 px-1 py-px rounded">{s.proveedor}</span>}
                            </div>
                            {s.descripcion && <p className="text-[10px] text-slate-400 truncate">{s.descripcion}</p>}
                          </div>
                          <span className="font-bold text-emerald-400 text-xs flex-shrink-0">{s.stock} <span className="text-slate-500 font-normal">{s.un}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setDetailMode('view')} size="sm" className="flex-1 border-slate-600/40 text-slate-400 text-xs gap-1"><X className="w-3.5 h-3.5" /> Cancelar</Button>
                  <Button onClick={doTransferir} disabled={actionBusy || !trDestBloque || !trDestTorre || !trDestPiso || !trDestPos || trQtyNum <= 0} size="sm" className="flex-1 gap-1.5 bg-gradient-to-r from-sky-500 to-blue-600 text-white text-xs">
                    {actionBusy ? <Loader2 className="h-3.5 h-3.5 animate-spin" /> : <><CheckCircle2 className="h-3.5 w-3.5" /> Confirmar traslado</>}
                  </Button>
                </div>
              </div>
            )}
          </>)}
        </DialogContent>
      </Dialog>
    </div>
  )
}
