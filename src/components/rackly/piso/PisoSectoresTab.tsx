'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listarSectores,
  cargarPosicionesSector,
  stockDetallePosicion,
  obtenerPrimerNivel,
  listarBloquesParaSelect,
  buscarBloquePorCodigo,
  registrarIngresoPosicion,
  registrarSalidaPosicion,
  registrarTrasladoPosicion,
  registrarDevolucionPosicion,
  type Sector,
  type PosicionConStock,
} from '@/lib/piso/api'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  Download, Loader2, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft,
  Layers3, BoxSelect, X, Plus, Trash2, Search, RefreshCw, Package,
  RotateCcw, CalendarOff, Calendar,
} from 'lucide-react'

type DetailStock = { bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number }
type BloqueOption = { id: string; codigo: string; descripcion: string; unidad: string }
type ActionMode = 'view' | 'ingreso' | 'salida' | 'traslado' | 'devolucion'

type RowEntry = {
  bloque_id: string
  codigo: string
  descripcion: string
  unidad: string
  cantidad: string
  fecha_vencimiento: string
  sin_vencimiento: boolean
}

const EMPTY_ROW: RowEntry = { bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '', fecha_vencimiento: '', sin_vencimiento: true }

export function PisoSectoresTab() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorFilter, setSectorFilter] = useState<string>('all')
  const [posiciones, setPosiciones] = useState<PosicionConStock[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [busyExport, setBusyExport] = useState(false)
  const [searchBloque, setSearchBloque] = useState('')
  const mountedRef = useRef(true)

  // Detalle de posicion
  const [detail, setDetail] = useState<{
    posicionId: string; posicionNumero: number; subcolumnaCodigo: string; columnaLetra: string
    stock: DetailStock[]
  } | null>(null)
  const [mode, setMode] = useState<ActionMode>('view')

  // Ingreso state
  const [ingRows, setIngRows] = useState<RowEntry[]>([{ ...EMPTY_ROW }])

  // Salida state
  const [salItems, setSalItems] = useState<{ bloque_id: string; cantidad: string }[]>([])

  // Traslado state
  const [trDestPos, setTrDestPos] = useState<PosicionConStock | null>(null)
  const [trItems, setTrItems] = useState<{ bloque_id: string; cantidad: string }[]>([])

  // Devolucion state
  const [devRows, setDevRows] = useState<RowEntry[]>([{ ...EMPTY_ROW }])

  // Catalogo
  const [bloquesCatalogo, setBloquesCatalogo] = useState<BloqueOption[]>([])
  const [searchingCode, setSearchingCode] = useState<string | null>(null)
  const [catalogoLoading, setCatalogoLoading] = useState(false)

  // Cargar sectores
  const loadSectores = useCallback(async () => {
    try { setSectores(await listarSectores()) } catch { /* ok */ }
  }, [])

  // Cargar posiciones del sector seleccionado
  const loadPosiciones = useCallback(async () => {
    setLoading(true)
    try {
      if (sectorFilter === 'all') {
        const secs = await listarSectores()
        if (!mountedRef.current) return
        setSectores(secs)
        if (secs.length > 0) {
          const data = await cargarPosicionesSector(secs[0].id)
          if (mountedRef.current) { setPosiciones(data); setSectorFilter(secs[0].id) }
        } else {
          if (mountedRef.current) setPosiciones([])
        }
      } else {
        const data = await cargarPosicionesSector(sectorFilter)
        if (mountedRef.current) setPosiciones(data)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error'
      if (mountedRef.current) toast.error('Error al cargar posiciones', { description: msg })
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [sectorFilter])

  const loadBloques = useCallback(async () => {
    setCatalogoLoading(true)
    try {
      const data = await listarBloquesParaSelect()
      if (mountedRef.current) {
        setBloquesCatalogo(data)
      }
    } catch (err) {
      console.error('[Piso] Error cargando catalogo:', err)
      if (mountedRef.current) toast.error('Error al cargar catalogo', { description: 'No se pudieron cargar los articulos.' })
    } finally {
      if (mountedRef.current) setCatalogoLoading(false)
    }
  }, [])

  useEffect(() => { mountedRef.current = true; loadSectores(); loadPosiciones(); loadBloques(); return () => { mountedRef.current = false } }, [loadSectores, loadPosiciones, loadBloques])
  useEffect(() => { if (sectorFilter !== 'all') loadPosiciones() }, [sectorFilter, loadPosiciones])

  // Filtrar catalogo para autocomplete
  function getFilteredCatalogo(prefix: 'ing' | 'dev', idx: number) {
    const rows = prefix === 'ing' ? ingRows : devRows
    const q = rows[idx]?.codigo.trim().toLowerCase() || ''
    if (!q) return bloquesCatalogo.slice(0, 50)
    return bloquesCatalogo.filter((b) =>
      b.codigo.toLowerCase().includes(q) || b.descripcion.toLowerCase().includes(q)
    )
  }

  // Agrupar posiciones por columna -> subcolumna
  const subPorCol = new Map<string, { letra: string; subcols: { codigo: string; pos: PosicionConStock[] }[] }>()
  for (const p of posiciones) {
    if (!subPorCol.has(p.columnaLetra)) subPorCol.set(p.columnaLetra, { letra: p.columnaLetra, subcols: [] })
    const col = subPorCol.get(p.columnaLetra)!
    let found = col.subcols.find((s) => s.codigo === p.subcolumnaCodigo)
    if (!found) { found = { codigo: p.subcolumnaCodigo, pos: [] }; col.subcols.push(found) }
    found.pos.push(p)
  }
  const columnas = [...subPorCol.values()].sort((a, b) => a.letra.localeCompare(b.letra))

  // Stats
  const occupied = posiciones.filter((p) => p.stock > 0).length
  const multiArt = posiciones.filter((p) => p.stock > 0 && p.bloques.length > 1).length
  const total = posiciones.length
  const empty = total - occupied
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0

  const filteredPosiciones = searchBloque.trim()
    ? posiciones.filter((p) => p.bloques.some((b) => b.bloque_codigo.includes(searchBloque.toUpperCase())))
    : posiciones

  // Click posicion
  async function handleClick(pos: PosicionConStock | null) {
    if (!pos) return
    try {
      const stock = await stockDetallePosicion(pos.posicionId)
      if (mountedRef.current) {
        setDetail({ posicionId: pos.posicionId, posicionNumero: pos.posicionNumero, subcolumnaCodigo: pos.subcolumnaCodigo, columnaLetra: pos.columnaLetra, stock })
        setMode('view')
        setSalItems(stock.map((s) => ({ bloque_id: s.bloque_id, cantidad: String(s.cantidad) })))
        setTrItems(stock.map((s) => ({ bloque_id: s.bloque_id, cantidad: String(s.cantidad) })))
      }
    } catch { toast.error('Error al cargar detalle') }
  }

  function openIngreso() {
    setIngRows([{ ...EMPTY_ROW }])
    setMode('ingreso')
  }

  function openSalida() {
    if (detail) setSalItems(detail.stock.map((s) => ({ bloque_id: s.bloque_id, cantidad: String(s.cantidad) })))
    setMode('salida')
  }

  function openTraslado() {
    setTrDestPos(null)
    if (detail) setTrItems(detail.stock.map((s) => ({ bloque_id: s.bloque_id, cantidad: String(s.cantidad) })))
    setMode('traslado')
  }

  function openDevolucion() {
    setDevRows([{ ...EMPTY_ROW }])
    setMode('devolucion')
  }

  // Auto-buscar bloque por codigo al escribir
  async function handleCodeInput(prefix: 'ing' | 'dev', idx: number, value: string) {
    const upper = value.trim().toUpperCase()
    if (prefix === 'ing') {
      const updated = [...ingRows]
      updated[idx] = { ...updated[idx], codigo: upper, bloque_id: upper ? updated[idx].bloque_id : '', descripcion: '', unidad: '' }
      setIngRows(updated)
    } else {
      const updated = [...devRows]
      updated[idx] = { ...updated[idx], codigo: upper, bloque_id: upper ? updated[idx].bloque_id : '', descripcion: '', unidad: '' }
      setDevRows(updated)
    }
    if (upper.length < 2) return
    setSearchingCode(`${prefix}-${idx}`)
    const bloque = await buscarBloquePorCodigo(upper)
    if (bloque) {
      if (prefix === 'ing') {
        setIngRows((prev) => {
          const u = [...prev]
          u[idx] = { ...u[idx], bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad }
          return u
        })
      } else {
        setDevRows((prev) => {
          const u = [...prev]
          u[idx] = { ...u[idx], bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad }
          return u
        })
      }
    }
    setSearchingCode(null)
  }

  function onSelectFromCatalog(prefix: 'ing' | 'dev', idx: number, bloque: BloqueOption) {
    if (prefix === 'ing') {
      setIngRows((prev) => {
        const u = [...prev]
        u[idx] = { ...u[idx], bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad }
        return u
      })
    } else {
      setDevRows((prev) => {
        const u = [...prev]
        u[idx] = { ...u[idx], bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad }
        return u
      })
    }
  }

  function addIngresoRow() { setIngRows([...ingRows, { ...EMPTY_ROW }]) }
  function removeIngresoRow(i: number) { setIngRows(ingRows.filter((_, idx) => idx !== i)) }
  function updateIngresoCantidad(i: number, value: string) {
    const updated = [...ingRows]; updated[i] = { ...updated[i], cantidad: value }; setIngRows(updated)
  }
  function updateIngresoFecha(i: number, value: string) {
    const updated = [...ingRows]
    updated[i] = { ...updated[i], fecha_vencimiento: value, sin_vencimiento: !value }
    setIngRows(updated)
  }
  function toggleIngresoSinVencimiento(i: number) {
    const updated = [...ingRows]
    updated[i] = { ...updated[i], sin_vencimiento: !updated[i].sin_vencimiento, fecha_vencimiento: '' }
    setIngRows(updated)
  }

  function addDevRow() { setDevRows([...devRows, { ...EMPTY_ROW }]) }
  function removeDevRow(i: number) { setDevRows(devRows.filter((_, idx) => idx !== i)) }
  function updateDevCantidad(i: number, value: string) {
    const updated = [...devRows]; updated[i] = { ...updated[i], cantidad: value }; setDevRows(updated)
  }
  function updateDevFecha(i: number, value: string) {
    const updated = [...devRows]
    updated[i] = { ...updated[i], fecha_vencimiento: value, sin_vencimiento: !value }
    setDevRows(updated)
  }
  function toggleDevSinVencimiento(i: number) {
    const updated = [...devRows]
    updated[i] = { ...updated[i], sin_vencimiento: !updated[i].sin_vencimiento, fecha_vencimiento: '' }
    setDevRows(updated)
  }

  async function doIngreso() {
    if (!detail || !perfil) return
    const validRows = ingRows.filter((r) => r.bloque_id && r.cantidad)
    if (validRows.length === 0) { toast.error('Agrega al menos un articulo con codigo y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad invalida'); return }
    }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posicion'); return }
      const detalles = validRows.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarIngresoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Ingreso registrado')
      if (mountedRef.current) {
        const stock = await stockDetallePosicion(detail.posicionId)
        setDetail({ ...detail, stock }); loadPosiciones(); setMode('view')
      }
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  async function doSalida() {
    if (!detail || !perfil) return
    const validRows = salItems.filter((r) => r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para salir'); return }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles'); return }
      const detalles = validRows.map((r) => ({ nivel_id: nivelId, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad) }))
      await registrarSalidaPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Salida registrada')
      if (mountedRef.current) {
        const stock = await stockDetallePosicion(detail.posicionId)
        setDetail({ ...detail, stock }); loadPosiciones(); setMode('view')
      }
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  async function doTraslado() {
    if (!detail || !perfil || !trDestPos) return
    if (detail.posicionId === trDestPos.posicionId) { toast.error('Origen y destino no pueden ser iguales'); return }
    const validRows = trItems.filter((r) => r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para trasladar'); return }
    setBusy(true)
    try {
      const [origNivelId, destNivelId] = await Promise.all([
        obtenerPrimerNivel(detail.posicionId),
        obtenerPrimerNivel(trDestPos.posicionId),
      ])
      if (!origNivelId || !destNivelId) { toast.error('No hay niveles disponibles'); return }
      const detallesSal = validRows.map((r) => ({ nivel_id: origNivelId!, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad) }))
      const detallesIng = validRows.map((r) => ({ nivel_id: destNivelId!, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad) }))
      await registrarTrasladoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detallesSal, detallesIng)
      toast.success('Traslado registrado')
      if (mountedRef.current) { setDetail(null); setTrDestPos(null); loadPosiciones() }
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  async function doDevolucion() {
    if (!detail || !perfil) return
    const validRows = devRows.filter((r) => r.bloque_id && r.cantidad)
    if (validRows.length === 0) { toast.error('Agrega al menos un articulo con codigo y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad invalida'); return }
    }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posicion'); return }
      const detalles = validRows.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarDevolucionPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Devolucion registrada')
      if (mountedRef.current) {
        const stock = await stockDetallePosicion(detail.posicionId)
        setDetail({ ...detail, stock }); loadPosiciones(); setMode('view')
      }
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  // Export Excel
  async function handleExport() {
    setBusyExport(true)
    try {
      const XLSX = await import('xlsx')
      const data = posiciones.map((p) => ({
        Columna: p.columnaLetra,
        Subcolumna: p.subcolumnaCodigo,
        Posicion: p.posicionNumero,
        Stock: p.stock,
        Codigos: p.bloques.map((b) => `${b.bloque_codigo} (${b.cantidad})`).join(', '),
        Articulos: p.bloques.length,
        Estado: p.stock <= 0 ? 'Vacio' : p.bloques.length > 1 ? 'Multiple' : 'Ocupado',
      }))
      const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Sectores Piso'); XLSX.writeFile(wb, `RACKLY_SectoresPiso_${new Date().toISOString().slice(0, 10)}.xlsx`); toast.success('Exportado')
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusyExport(false) }
  }

  // ─── Fecha de vencimiento sub-component ───
  function FechaVencimientoField({
    prefix, idx, row, onFechaChange, onToggleSin,
  }: {
    prefix: 'ing' | 'dev'; idx: number; row: RowEntry
    onFechaChange: (idx: number, val: string) => void
    onToggleSin: (idx: number) => void
  }) {
    const isIng = prefix === 'ing'
    return (
      <div className="col-span-12 sm:col-span-6 flex items-end gap-2">
        <div className="flex-1">
          <Label className="text-[10px] text-slate-400 font-medium">Fecha de Vencimiento</Label>
          <div className="relative">
            <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
            <input
              type="date"
              value={row.fecha_vencimiento}
              onChange={(e) => onFechaChange(idx, e.target.value)}
              disabled={row.sin_vencimiento}
              className={`w-full h-9 rounded-xl border text-xs pl-8 pr-2 font-mono focus:outline-none focus:ring-2 transition-all [color-scheme:dark] ${row.sin_vencimiento ? 'border-slate-700 bg-slate-800/50 text-slate-600 cursor-not-allowed' : isIng ? 'border-emerald-500/50 bg-slate-900 text-white focus:ring-emerald-500/50' : 'border-amber-500/50 bg-slate-900 text-white focus:ring-amber-500/50'}`}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggleSin(idx)}
          className={`flex items-center gap-1 px-2.5 h-9 rounded-xl text-[10px] font-semibold border transition-all whitespace-nowrap ${row.sin_vencimiento
            ? isIng ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-400 shadow-inner' : 'bg-amber-600/20 border-amber-500/40 text-amber-400 shadow-inner'
            : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400'
            }`}
        >
          <CalendarOff className="h-3 w-3" />
          Sin vencimiento
        </button>
      </div>
    )
  }

  // ─── Autocomplete dropdown sub-component ───
  function AutocompleteDropdown({
    prefix, idx, row,
  }: {
    prefix: 'ing' | 'dev'; idx: number; row: RowEntry; accentColor?: string
  }) {
    const rows = prefix === 'ing' ? ingRows : devRows
    const isIng = prefix === 'ing'
    if (row.bloque_id || row.codigo.length < 1) return null
    const suggestions = !catalogoLoading
      ? getFilteredCatalogo(prefix, idx)
          .filter((b) => !rows.some((r, ri) => ri !== idx && r.bloque_id === b.id))
          .slice(0, 8)
      : []
    return (
      <div className="max-h-28 overflow-y-auto rounded-xl border border-slate-700/80 bg-slate-900/95 backdrop-blur-sm mt-1 shadow-2xl shadow-black/30 z-50">
        {catalogoLoading && <div className="px-3 py-2 text-xs text-slate-500">Cargando catalogo...</div>}
        {!catalogoLoading && suggestions.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-500">Sin resultados</div>
        )}
        {!catalogoLoading && suggestions.map((b) => (
          <button key={b.id} onClick={() => onSelectFromCatalog(prefix, idx, b)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-slate-700/80 text-slate-300 border-b border-slate-800/50 last:border-0 transition-colors">
            <span className={isIng ? 'font-mono text-emerald-400' : 'font-mono text-amber-400'}>{b.codigo}</span>
            <span className="text-slate-500 ml-1.5">— {b.descripcion || b.unidad}</span>
          </button>
        ))}
      </div>
    )
  }

  // ═══════════════════════════════════════════════
  //  3D CELL STYLING
  // ═══════════════════════════════════════════════
  function getCellClasses(pos: PosicionConStock): string {
    const base = 'relative group min-w-[38px] h-10 px-1.5 rounded-xl text-[9px] font-bold transition-all duration-200 cursor-pointer border overflow-hidden'
    if (pos.stock <= 0) {
      return `${base} bg-emerald-500/20 border-emerald-400/20 text-emerald-300/70 hover:bg-emerald-500/30 hover:border-emerald-400/40 hover:text-emerald-300 hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5`
    }
    if (pos.bloques.length > 1) {
      return `${base} bg-amber-500/50 border-amber-400/30 text-white hover:bg-amber-500/60 hover:shadow-lg hover:shadow-amber-500/20 hover:-translate-y-0.5`
    }
    return `${base} bg-sky-500/40 border-sky-400/25 text-white hover:bg-sky-500/55 hover:shadow-lg hover:shadow-sky-500/20 hover:-translate-y-0.5`
  }

  // ═══════════════════════════════════════════════
  //  LOADING / EMPTY STATES
  // ═══════════════════════════════════════════════
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-400 to-cyan-500 animate-pulse" />
            <div className="absolute inset-0 w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-400 to-cyan-500 animate-ping opacity-20" />
          </div>
          <p className="text-sm text-slate-400 animate-pulse font-medium">Cargando sectores...</p>
        </div>
      </div>
    )
  }

  if (sectores.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-10 text-center">
        <Layers3 className="h-14 w-14 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-400 font-semibold text-lg">No hay sectores creados</p>
        <p className="text-xs text-slate-500 mt-1">Ve a Configuracion para crear tu primer sector</p>
      </div>
    )
  }

  const displayPos = searchBloque.trim() ? filteredPosiciones : posiciones

  // ═══════════════════════════════════════════════
  //  MAIN RENDER
  // ═══════════════════════════════════════════════
  return (
    <div className="space-y-6 relative">
      {/* Subtle grid background pattern */}
      <div className="absolute inset-0 -z-10 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle, #94a3b8 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
        }} />

      {/* ═══ DASHBOARD STATS ═══ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Total */}
        <div className="group relative rounded-2xl border border-slate-700/50 bg-gradient-to-br from-slate-800/80 to-slate-800/40 backdrop-blur-sm p-4 shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-slate-600/20 to-transparent rounded-bl-full" />
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.15em]">Total</p>
          <p className="text-2xl font-extrabold text-white mt-1 tracking-tight">{total.toLocaleString()}</p>
          <p className="text-[10px] text-slate-500 mt-1">posiciones</p>
        </div>

        {/* Ocupadas */}
        <div className="group relative rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-950/60 to-slate-800/40 backdrop-blur-sm p-4 shadow-lg hover:shadow-sky-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-sky-500/15 to-transparent rounded-bl-full" />
          <p className="text-[10px] font-bold text-sky-400 uppercase tracking-[0.15em]">Ocupadas</p>
          <p className="text-2xl font-extrabold text-sky-200 mt-1 tracking-tight">{occupied}</p>
          <p className="text-[10px] text-sky-400/60 mt-1">{multiArt} multiples</p>
        </div>

        {/* Vacias */}
        <div className="group relative rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/50 to-slate-800/40 backdrop-blur-sm p-4 shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-emerald-500/15 to-transparent rounded-bl-full" />
          <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.15em]">Vacias</p>
          <p className="text-2xl font-extrabold text-emerald-200 mt-1 tracking-tight">{empty.toLocaleString()}</p>
          <p className="text-[10px] text-emerald-400/60 mt-1">disponibles</p>
        </div>

        {/* Ocupacion */}
        <div className="group relative rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-950/50 to-slate-800/40 backdrop-blur-sm p-4 shadow-lg hover:shadow-violet-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-violet-500/15 to-transparent rounded-bl-full" />
          <p className="text-[10px] font-bold text-violet-400 uppercase tracking-[0.15em]">Ocupacion</p>
          <p className="text-2xl font-extrabold text-violet-200 mt-1 tracking-tight">{pct}<span className="text-sm text-violet-400/60">%</span></p>
          <div className="mt-2 h-2 rounded-full bg-slate-700/80 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-1000 ease-out"
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* ═══ SELECTOR SECTOR + BUSQUEDA ═══ */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sector:</span>
          <div className="flex gap-2 flex-wrap">
            {sectores.map((s) => (
              <button key={s.id} onClick={() => setSectorFilter(s.id)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all duration-200 ${sectorFilter === s.id
                  ? 'bg-gradient-to-br from-sky-400 to-cyan-500 text-white shadow-lg shadow-sky-500/25 scale-105'
                  : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/80 hover:text-slate-300 border border-slate-700/50 backdrop-blur-sm'
                  }`}>
                {s.nombre}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
            <input type="text" value={searchBloque} onChange={(e) => setSearchBloque(e.target.value)} placeholder="Buscar codigo..."
              className="pl-9 pr-3 py-2 h-9 rounded-xl border border-slate-700/50 text-xs bg-slate-800/60 text-white placeholder-slate-500 w-48 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50 backdrop-blur-sm transition-all" />
          </div>
          <button onClick={loadPosiciones} className="p-2 rounded-xl border border-slate-700/50 hover:bg-slate-700/80 transition-all hover:-rotate-180 duration-500 bg-slate-800/60 backdrop-blur-sm"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /></button>
          <div className="hidden sm:flex items-center gap-3 text-[10px] text-slate-400 bg-slate-800/40 rounded-xl px-3 py-1.5 border border-slate-700/30 backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-sky-500/50 shadow-sm shadow-sky-500/20" />
              <span>Ocupado</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-amber-500/50 shadow-sm shadow-amber-500/20" />
              <span>Multiple</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-emerald-500/30 shadow-sm shadow-emerald-500/10" />
              <span>Vacio</span>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ 3D RACK GRID ═══ */}
      <div className="space-y-8" style={{ perspective: '1200px' }}>
        {columnas.map((col) => (
          <div
            key={col.letra}
            className="rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-800/70 to-slate-800/30 backdrop-blur-sm shadow-2xl shadow-black/20 overflow-hidden transition-all duration-300 hover:shadow-black/30"
            style={{
              transform: 'rotateX(1deg)',
              transformOrigin: 'top center',
            }}
          >
            {/* Column header with 3D side panel effect */}
            <div className="relative px-5 py-3 border-b border-slate-700/50 bg-gradient-to-r from-slate-900/60 to-slate-900/30 flex items-center gap-3 overflow-hidden">
              {/* Side panel accent */}
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-sky-400 to-cyan-500 rounded-r-full" />
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-400 to-cyan-500 flex items-center justify-center text-white font-extrabold text-sm shadow-lg shadow-sky-500/25">{col.letra}</div>
              <div className="flex-1">
                <span className="text-xs font-bold text-slate-200">Columna {col.letra}</span>
                <span className="text-[10px] text-slate-500 ml-2">{col.subcols.length} subcol &middot; {col.subcols.reduce((s, sc) => s + sc.pos.length, 0)} pos</span>
              </div>
            </div>

            <div className="p-4">
              {col.subcols.map((sub) => (
                <div key={sub.codigo} className="mb-4 last:mb-0">
                  {/* Subcolumn header - shelf look */}
                  <div className="flex items-center gap-2.5 px-2 py-1.5 mb-2">
                    <div className="w-1.5 h-4 rounded-full bg-gradient-to-b from-sky-400 to-sky-600" />
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">{sub.codigo}</span>
                    <span className="text-[9px] text-slate-500 bg-slate-800/60 rounded-full px-2 py-0.5">{sub.pos.filter((p) => p.stock > 0).length}/{sub.pos.length} ocupadas</span>
                    {/* Shelf bar */}
                    <div className="flex-1 h-px bg-gradient-to-r from-slate-700/80 via-slate-600/40 to-transparent" />
                  </div>

                  {/* 3D shelf positions grid */}
                  <div
                    className="flex flex-wrap gap-2 relative"
                    style={{ perspective: '800px' }}
                  >
                    {/* Shelf surface line */}
                    <div className="absolute left-0 right-0 bottom-[-4px] h-1 bg-gradient-to-r from-transparent via-slate-600/40 to-transparent rounded-full shadow-sm shadow-black/20" />

                    {sub.pos.map((pos) => {
                      const isOccupied = pos.stock > 0
                      const isMulti = pos.bloques.length > 1
                      return (
                        <button
                          key={pos.posicionId}
                          onClick={() => handleClick(pos)}
                          title={`${sub.codigo}-${pos.posicionNumero}${pos.stock > 0 ? ` (${pos.stock})` : ' · Vacio'}`}
                          className={getCellClasses(pos)}
                          style={{
                            transform: 'perspective(600px) rotateX(2deg)',
                            boxShadow: isOccupied
                              ? 'inset 0 1px 0 rgba(255,255,255,0.1), 3px 4px 0 -1px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.2)'
                              : 'inset 0 1px 0 rgba(255,255,255,0.05), 2px 3px 0 -1px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.1)',
                          }}
                        >
                          {/* Gradient overlay suggesting shelf surface */}
                          <div className="absolute inset-0 bg-gradient-to-b from-white/[0.06] to-transparent pointer-events-none rounded-xl" />
                          {/* Bottom shelf edge for depth */}
                          <div className="absolute bottom-0 left-1 right-1 h-[3px] rounded-b-xl bg-black/10" />

                          <span className="relative z-10">{pos.posicionNumero}</span>

                          {/* Box visual when occupied */}
                          {isOccupied && (
                            <div className="absolute inset-[3px] rounded-lg bg-gradient-to-br from-white/10 to-white/5 border border-white/5 flex items-end justify-center pb-0.5 pointer-events-none">
                              <span className="text-[7px] font-bold text-white/70 drop-shadow-sm">{pos.stock}</span>
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Exportar */}
      <div className="flex justify-end">
        <Button onClick={handleExport} disabled={busyExport} variant="outline" size="sm"
          className="gap-2 border-slate-700/50 text-slate-400 hover:text-sky-400 hover:border-sky-500/50 hover:bg-sky-500/5 text-xs bg-slate-800/60 backdrop-blur-sm rounded-xl transition-all">
          {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Exportar Excel
        </Button>
      </div>

      {/* ═══ DETAIL DIALOG ═══ */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setMode('view') } }}>
        <DialogContent
          className="max-w-[calc(100vw-1rem)] sm:max-w-xl rounded-2xl max-h-[90vh] overflow-y-auto p-0 border-0 shadow-2xl"
          style={{
            background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.92))',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(71, 85, 105, 0.3)',
          }}
        >
          {/* Animated gradient border accent */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-sky-400 to-transparent opacity-60" />

          <div className="p-6">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-white flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-cyan-500 flex items-center justify-center text-white font-extrabold text-xs shadow-lg shadow-sky-500/25">
                  {detail?.columnaLetra}
                </div>
                <span>{detail?.columnaLetra} &middot; {detail?.subcolumnaCodigo} &middot; Pos {detail?.posicionNumero}</span>
                {!mode || mode === 'view' ? '' : (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                    mode === 'ingreso' ? 'bg-emerald-500/20 text-emerald-400' :
                    mode === 'salida' ? 'bg-red-500/20 text-red-400' :
                    mode === 'traslado' ? 'bg-sky-500/20 text-sky-400' :
                    'bg-amber-500/20 text-amber-400'
                  }`}>
                    {mode === 'ingreso' ? 'Ingreso' : mode === 'salida' ? 'Salida' : mode === 'traslado' ? 'Traslado' : 'Devolucion'}
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>

            {detail && (<>
              {/* ── VIEW MODE ── */}
              {mode === 'view' && (
                detail.stock.length > 0 ? (
                  <div className="space-y-2.5 mt-4">
                    {detail.stock.map((s) => (
                      <div key={s.bloque_id}
                        className="rounded-xl border border-slate-700/40 bg-slate-800/50 backdrop-blur-sm p-3.5 hover:border-slate-600/50 transition-all group/item">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-sky-400 font-bold text-xs">{s.bloque_codigo}</span>
                            <p className="text-slate-400 text-xs mt-0.5 truncate">{s.bloque_descripcion || 'Sin descripcion'}</p>
                          </div>
                          <div className="text-right flex-shrink-0 ml-3">
                            <p className="font-extrabold text-emerald-400 text-lg leading-none">{s.cantidad}</p>
                            <p className="text-[10px] text-slate-500 mt-0.5">{s.bloque_unidad}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2 pt-3">
                      <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/15 transition-all hover:shadow-emerald-500/25"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                      <Button onClick={openSalida} size="sm" className="gap-1.5 bg-red-600/90 hover:bg-red-600 text-white text-xs rounded-xl shadow-lg shadow-red-500/15 transition-all hover:shadow-red-500/25"><ArrowUpFromLine className="h-3.5 w-3.5" /> Salida</Button>
                      <Button onClick={openTraslado} size="sm" className="gap-1.5 bg-sky-600/90 hover:bg-sky-600 text-white text-xs rounded-xl shadow-lg shadow-sky-500/15 transition-all hover:shadow-sky-500/25"><ArrowRightLeft className="h-3.5 w-3.5" /> Traslado</Button>
                      <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600/90 hover:bg-amber-600 text-white text-xs rounded-xl shadow-lg shadow-amber-500/15 transition-all hover:shadow-amber-500/25"><RotateCcw className="h-3.5 w-3.5" /> Devolucion</Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 py-6 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700/30 flex items-center justify-center mx-auto">
                      <BoxSelect className="h-8 w-8 text-slate-600" />
                    </div>
                    <div>
                      <p className="text-slate-400 font-semibold">Posicion vacia</p>
                      <p className="text-xs text-slate-500 mt-1">Esta posicion no tiene articulos registrados</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
                      <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/15"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                      <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600/90 hover:bg-amber-600 text-white text-xs rounded-xl shadow-lg shadow-amber-500/15"><RotateCcw className="h-3.5 w-3.5" /> Devolucion</Button>
                    </div>
                  </div>
                )
              )}

              {/* ── INGRESO MODE ── */}
              {mode === 'ingreso' && (
                <div className="space-y-4 mt-4">
                  {detail.stock.length > 0 && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-950/30 backdrop-blur-sm p-3">
                      <p className="text-[10px] font-bold text-amber-400">Posicion con {detail.stock.length} articulo(s). Se agregara el nuevo.</p>
                    </div>
                  )}
                  <p className="text-xs font-bold text-slate-300">Escribe el codigo y se autocompletara:</p>
                  {ingRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-emerald-500/15 bg-slate-800/40 backdrop-blur-sm p-4 space-y-3">
                      <div className="grid grid-cols-12 gap-2 items-end">
                        {/* Codigo */}
                        <div className="col-span-12 sm:col-span-5">
                          <Label className="text-[10px] text-emerald-400 font-semibold">Codigo</Label>
                          <div className="relative">
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('ing', i, e.target.value)} placeholder="Escribe codigo..."
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all backdrop-blur-sm ${row.bloque_id ? 'border-emerald-500/40 ring-emerald-500/20 shadow-sm shadow-emerald-500/10' : 'border-slate-700/50 focus:ring-emerald-500/40'}`} />
                            {searchingCode === `ing-${i}` && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2"><Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" /></div>
                            )}
                          </div>
                          <AutocompleteDropdown prefix="ing" idx={i} row={row} accentColor="emerald" />
                        </div>

                        {/* Descripcion */}
                        <div className="col-span-12 sm:col-span-4">
                          <Label className="text-[10px] text-slate-500">Descripcion</Label>
                          <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm" />
                        </div>

                        {/* UN */}
                        <div className="col-span-4 sm:col-span-3">
                          <Label className="text-[10px] text-slate-500">UN</Label>
                          <input type="text" value={row.unidad} readOnly placeholder="-"
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-2 text-center cursor-default backdrop-blur-sm" />
                        </div>

                        {/* Cantidad */}
                        <div className="col-span-8 sm:col-span-4">
                          <Label className="text-[10px] text-sky-400 font-semibold">Cantidad</Label>
                          <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateIngresoCantidad(i, e.target.value)}
                            className="h-10 text-xs bg-slate-900/80 border-sky-500/30 text-white focus:ring-sky-500/40 font-bold rounded-xl backdrop-blur-sm" placeholder="0" autoFocus />
                        </div>
                      </div>

                      {/* Fecha de vencimiento */}
                      <FechaVencimientoField prefix="ing" idx={i} row={row} onFechaChange={updateIngresoFecha} onToggleSin={toggleIngresoSinVencimiento} />

                      {ingRows.length > 1 && (
                        <div className="flex justify-end">
                          <button onClick={() => removeIngresoRow(i)} className="p-1.5 rounded-lg hover:bg-red-900/30 text-slate-600 hover:text-red-400 transition-all"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button onClick={addIngresoRow} className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors"><Plus className="h-3.5 w-3.5" /> Agregar otro articulo</button>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40">Cancelar</Button>
                    <Button onClick={doIngreso} disabled={busy} size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/20">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />} Registrar ingreso</Button>
                  </div>
                </div>
              )}

              {/* ── SALIDA MODE ── */}
              {mode === 'salida' && (
                <div className="space-y-3 mt-4">
                  <p className="text-xs font-bold text-slate-300">Articulos a salir:</p>
                  {salItems.map((row, i) => {
                    const bloque = bloquesCatalogo.find((b) => b.id === row.bloque_id)
                    return (
                      <div key={i} className="flex items-center gap-3 rounded-xl border border-red-500/15 bg-slate-800/40 backdrop-blur-sm p-3">
                        <Package className="h-4 w-4 text-red-400/60 flex-shrink-0" />
                        <span className="font-mono text-sky-400 text-xs flex-1">{bloque?.codigo || '-'}</span>
                        <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => { const u = [...salItems]; u[i].cantidad = e.target.value; setSalItems(u) }}
                          className="w-20 h-9 text-xs bg-slate-900/80 border-red-500/30 text-white focus:ring-red-500/40 rounded-xl backdrop-blur-sm" />
                      </div>
                    )
                  })}
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40">Cancelar</Button>
                    <Button onClick={doSalida} disabled={busy} size="sm" className="gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded-xl shadow-lg shadow-red-500/20">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />} Registrar salida</Button>
                  </div>
                </div>
              )}

              {/* ── TRASLADO MODE ── */}
              {mode === 'traslado' && (
                <div className="space-y-3 mt-4">
                  <p className="text-xs font-bold text-slate-300">Articulos a trasladar:</p>
                  {trItems.map((row, i) => {
                    const bloque = bloquesCatalogo.find((b) => b.id === row.bloque_id)
                    return (
                      <div key={i} className="flex items-center gap-3 rounded-xl border border-sky-500/15 bg-slate-800/40 backdrop-blur-sm p-3">
                        <Package className="h-4 w-4 text-sky-400/60 flex-shrink-0" />
                        <span className="font-mono text-sky-400 text-xs flex-1">{bloque?.codigo || '-'}</span>
                        <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => { const u = [...trItems]; u[i].cantidad = e.target.value; setTrItems(u) }}
                          className="w-20 h-9 text-xs bg-slate-900/80 border-sky-500/30 text-white focus:ring-sky-500/40 rounded-xl backdrop-blur-sm" />
                      </div>
                    )
                  })}
                  <div className="space-y-2 pt-3 border-t border-slate-700/40">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">DESTINO:</p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {posiciones.filter((p) => p.posicionId !== detail.posicionId).map((p) => (
                        <button key={p.posicionId} onClick={() => setTrDestPos(p)}
                          className={`px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all border ${trDestPos?.posicionId === p.posicionId
                            ? 'bg-sky-500 text-white border-sky-500 shadow-lg shadow-sky-500/20'
                            : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/80 hover:text-slate-300 border-slate-700/40 backdrop-blur-sm'
                            }`}>
                          {p.columnaLetra}-{p.subcolumnaCodigo}-{p.posicionNumero}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40">Cancelar</Button>
                    <Button onClick={doTraslado} disabled={busy || !trDestPos} size="sm" className="gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-xl shadow-lg shadow-sky-500/20">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />} Trasladar</Button>
                  </div>
                </div>
              )}

              {/* ── DEVOLUCION MODE ── */}
              {mode === 'devolucion' && (
                <div className="space-y-4 mt-4">
                  <div className="rounded-xl border border-amber-500/20 bg-amber-950/30 backdrop-blur-sm p-3">
                    <p className="text-[10px] font-bold text-amber-400">Registra articulos devueltos a esta posicion.</p>
                  </div>
                  <p className="text-xs font-bold text-slate-300">Escribe el codigo y se autocompletara:</p>
                  {devRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-amber-500/15 bg-slate-800/40 backdrop-blur-sm p-4 space-y-3">
                      <div className="grid grid-cols-12 gap-2 items-end">
                        {/* Codigo */}
                        <div className="col-span-12 sm:col-span-5">
                          <Label className="text-[10px] text-amber-400 font-semibold">Codigo</Label>
                          <div className="relative">
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('dev', i, e.target.value)} placeholder="Escribe codigo..."
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all backdrop-blur-sm ${row.bloque_id ? 'border-amber-500/40 ring-amber-500/20 shadow-sm shadow-amber-500/10' : 'border-slate-700/50 focus:ring-amber-500/40'}`} />
                            {searchingCode === `dev-${i}` && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2"><Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" /></div>
                            )}
                          </div>
                          <AutocompleteDropdown prefix="dev" idx={i} row={row} accentColor="amber" />
                        </div>

                        {/* Descripcion */}
                        <div className="col-span-12 sm:col-span-4">
                          <Label className="text-[10px] text-slate-500">Descripcion</Label>
                          <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm" />
                        </div>

                        {/* UN */}
                        <div className="col-span-4 sm:col-span-3">
                          <Label className="text-[10px] text-slate-500">UN</Label>
                          <input type="text" value={row.unidad} readOnly placeholder="-"
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-2 text-center cursor-default backdrop-blur-sm" />
                        </div>

                        {/* Cantidad */}
                        <div className="col-span-8 sm:col-span-4">
                          <Label className="text-[10px] text-amber-400 font-semibold">Cantidad</Label>
                          <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateDevCantidad(i, e.target.value)}
                            className="h-10 text-xs bg-slate-900/80 border-amber-500/30 text-white focus:ring-amber-500/40 font-bold rounded-xl backdrop-blur-sm" placeholder="0" autoFocus />
                        </div>
                      </div>

                      {/* Fecha de vencimiento */}
                      <FechaVencimientoField prefix="dev" idx={i} row={row} onFechaChange={updateDevFecha} onToggleSin={toggleDevSinVencimiento} />

                      {devRows.length > 1 && (
                        <div className="flex justify-end">
                          <button onClick={() => removeDevRow(i)} className="p-1.5 rounded-lg hover:bg-red-900/30 text-slate-600 hover:text-red-400 transition-all"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button onClick={addDevRow} className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"><Plus className="h-3.5 w-3.5" /> Agregar otro articulo</button>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40">Cancelar</Button>
                    <Button onClick={doDevolucion} disabled={busy} size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs rounded-xl shadow-lg shadow-amber-500/20">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Registrar devolucion</Button>
                  </div>
                </div>
              )}
            </>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
