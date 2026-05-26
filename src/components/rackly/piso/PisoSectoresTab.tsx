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
  RotateCcw,
} from 'lucide-react'

type DetailStock = { bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number }
type BloqueOption = { id: string; codigo: string; descripcion: string; unidad: string }
type ActionMode = 'view' | 'ingreso' | 'salida' | 'traslado' | 'devolucion'

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

  // Detalle de posición
  const [detail, setDetail] = useState<{
    posicionId: string; posicionNumero: number; subcolumnaCodigo: string; columnaLetra: string
    stock: DetailStock[]
  } | null>(null)
  const [mode, setMode] = useState<ActionMode>('view')

  // Ingreso state — formato: código input → autorellena descripción/unidad → cantidad manual
  const [ingRows, setIngRows] = useState<{ bloque_id: string; codigo: string; descripcion: string; unidad: string; cantidad: string }[]>([{ bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }])

  // Salida state
  const [salItems, setSalItems] = useState<{ bloque_id: string; cantidad: string }[]>([])

  // Traslado state
  const [trDestPos, setTrDestPos] = useState<PosicionConStock | null>(null)
  const [trItems, setTrItems] = useState<{ bloque_id: string; cantidad: string }[]>([])

  // Devolución state — formato: código input → autorellena descripción/unidad → cantidad manual
  const [devRows, setDevRows] = useState<{ bloque_id: string; codigo: string; descripcion: string; unidad: string; cantidad: string }[]>([{ bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }])

  // Catálogo
  const [bloquesCatalogo, setBloquesCatalogo] = useState<BloqueOption[]>([])
  const [searchingCode, setSearchingCode] = useState<string | null>(null) // 'ing-0', 'dev-0', etc.

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

  const [catalogoLoading, setCatalogoLoading] = useState(false)

  const loadBloques = useCallback(async () => {
    setCatalogoLoading(true)
    try {
      const data = await listarBloquesParaSelect()
      if (mountedRef.current) {
        setBloquesCatalogo(data)
        console.log(`[Piso] Catálogo cargado: ${data.length} artículos disponibles`)
      }
    } catch (err) {
      console.error('[Piso] Error cargando catálogo:', err)
      if (mountedRef.current) toast.error('Error al cargar catálogo', { description: 'No se pudieron cargar los artículos. Intenta recargar.' })
    } finally {
      if (mountedRef.current) setCatalogoLoading(false)
    }
  }, [])

  useEffect(() => { mountedRef.current = true; loadSectores(); loadPosiciones(); loadBloques(); return () => { mountedRef.current = false } }, [loadSectores, loadPosiciones, loadBloques])
  useEffect(() => { if (sectorFilter !== 'all') loadPosiciones() }, [sectorFilter, loadPosiciones])

  // Filtrar catálogo para autocomplete — usa la fila activa que se está editando
  function getFilteredCatalogo(prefix: 'ing' | 'dev', idx: number) {
    const rows = prefix === 'ing' ? ingRows : devRows
    const q = rows[idx]?.codigo.trim().toLowerCase() || ''
    if (!q) return bloquesCatalogo.slice(0, 50)
    return bloquesCatalogo.filter((b) =>
      b.codigo.toLowerCase().includes(q) || b.descripcion.toLowerCase().includes(q)
    )
  }

  // Agrupar posiciones por columna → subcolumna
  const posPorSubcol = new Map<string, PosicionConStock[]>()
  for (const p of posiciones) {
    const key = p.subcolumnaCodigo
    const arr = posPorSubcol.get(key) ?? []
    arr.push(p)
    posPorSubcol.set(key, arr)
  }

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

  // Click posición
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
    setIngRows([{ bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }])
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
    setDevRows([{ bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }])
    setMode('devolucion')
  }

  // ── Auto-buscar bloque por código al escribir ──
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
          u[idx] = { bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad, cantidad: u[idx].cantidad }
          return u
        })
      } else {
        setDevRows((prev) => {
          const u = [...prev]
          u[idx] = { bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad, cantidad: u[idx].cantidad }
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
        u[idx] = { bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad, cantidad: u[idx].cantidad }
        return u
      })
    } else {
      setDevRows((prev) => {
        const u = [...prev]
        u[idx] = { bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad, cantidad: u[idx].cantidad }
        return u
      })
    }
  }

  function addIngresoRow() { setIngRows([...ingRows, { bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }]) }
  function removeIngresoRow(i: number) { setIngRows(ingRows.filter((_, idx) => idx !== i)) }
  function updateIngresoCantidad(i: number, value: string) {
    const updated = [...ingRows]; updated[i].cantidad = value; setIngRows(updated)
  }

  function addDevRow() { setDevRows([...devRows, { bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '' }]) }
  function removeDevRow(i: number) { setDevRows(devRows.filter((_, idx) => idx !== i)) }
  function updateDevCantidad(i: number, value: string) {
    const updated = [...devRows]; updated[i].cantidad = value; setDevRows(updated)
  }

  async function doIngreso() {
    if (!detail || !perfil) return
    const validRows = ingRows.filter((r) => r.bloque_id && r.cantidad)
    if (validRows.length === 0) { toast.error('Agrega al menos un artículo con código y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad inválida'); return }
    }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posición'); return }
      const detalles = validRows.map((r) => ({ nivel_id: nivelId, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad) }))
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
    if (validRows.length === 0) { toast.error('No hay artículos para salir'); return }
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
    if (validRows.length === 0) { toast.error('No hay artículos para trasladar'); return }
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
    if (validRows.length === 0) { toast.error('Agrega al menos un artículo con código y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad inválida'); return }
    }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posición'); return }
      const detalles = validRows.map((r) => ({ nivel_id: nivelId, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad) }))
      await registrarDevolucionPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Devolución registrada')
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
        Posición: p.posicionNumero,
        Stock: p.stock,
        Códigos: p.bloques.map((b) => `${b.bloque_codigo} (${b.cantidad})`).join(', '),
        Artículos: p.bloques.length,
        Estado: p.stock <= 0 ? 'Vacío' : p.bloques.length > 1 ? 'Múltiple' : 'Ocupado',
      }))
      const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Sectores Piso'); XLSX.writeFile(wb, `RACKLY_SectoresPiso_${new Date().toISOString().slice(0, 10)}.xlsx`); toast.success('Exportado')
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusyExport(false) }
  }

  function getCellColor(pos: PosicionConStock): string {
    if (pos.stock <= 0) return 'bg-emerald-600/40 border-emerald-500/30 text-emerald-300'
    if (pos.bloques.length > 1) return 'bg-amber-500/70 border-amber-400/40 text-white'
    return 'bg-blue-500/60 border-blue-400/30 text-white'
  }

  function getCellHover(pos: PosicionConStock): string {
    if (pos.stock <= 0) return 'hover:bg-emerald-500/60 hover:text-white'
    return 'hover:brightness-110 hover:shadow-lg hover:shadow-blue-500/20'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 animate-pulse" />
          <p className="text-sm text-slate-400 animate-pulse">Cargando sectores...</p>
        </div>
      </div>
    )
  }

  if (sectores.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/80 p-8 text-center">
        <Layers3 className="h-12 w-12 text-slate-500 mx-auto mb-3" />
        <p className="text-slate-400 font-medium">No hay sectores creados</p>
        <p className="text-xs text-slate-500 mt-1">Ve a Configuración para crear tu primer sector</p>
      </div>
    )
  }

  const displayPos = searchBloque.trim() ? filteredPosiciones : posiciones

  return (
    <div className="space-y-5">
      {/* ═══ DASHBOARD ═══ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 shadow-lg">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Total</p>
          <p className="text-2xl font-bold text-white mt-1">{total.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-blue-500/30 bg-blue-950/50 p-4 shadow-lg">
          <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-widest">Ocupadas</p>
          <p className="text-2xl font-bold text-blue-300 mt-1">{occupied}</p>
          <p className="text-[10px] text-blue-400/70">{multiArt} múltiples</p>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/50 p-4 shadow-lg">
          <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-widest">Vacías</p>
          <p className="text-2xl font-bold text-emerald-300 mt-1">{empty.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-violet-500/30 bg-violet-950/50 p-4 shadow-lg">
          <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-widest">Ocupación</p>
          <p className="text-2xl font-bold text-violet-300 mt-1">{pct}%</p>
          <div className="mt-1.5 h-1.5 rounded-full bg-slate-700 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </div>
      </div>

      {/* ═══ SELECTOR SECTOR + BÚSQUEDA ═══ */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-400">Sector:</span>
          <div className="flex gap-1.5 flex-wrap">
            {sectores.map((s) => (
              <button key={s.id} onClick={() => setSectorFilter(s.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${sectorFilter === s.id ? 'bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'}`}>
                {s.nombre}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
            <input type="text" value={searchBloque} onChange={(e) => setSearchBloque(e.target.value)} placeholder="Buscar código..."
              className="pl-8 pr-3 py-1.5 h-8 rounded-lg border border-slate-700 text-xs bg-slate-800 text-white placeholder-slate-500 w-44 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500" />
          </div>
          <button onClick={loadPosiciones} className="p-1.5 rounded-lg border border-slate-700 hover:bg-slate-700 transition-colors"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /></button>
          <div className="flex items-center gap-3 text-[10px] text-slate-400">
            <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-blue-500/60" /><span>Ocupado</span></div>
            <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-amber-500/70" /><span>Múltiple</span></div>
            <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-emerald-600/40" /><span>Vacío</span></div>
          </div>
        </div>
      </div>

      {/* ═══ GRID DE COLUMNAS ═══ */}
      <div className="space-y-6">
        {columnas.map((col) => (
          <div key={col.letra} className="rounded-xl border border-slate-700 bg-slate-800/80 shadow-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-700 bg-slate-900/50 flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-white font-bold text-xs shadow">{col.letra}</div>
              <span className="text-xs font-bold text-slate-300">Columna {col.letra}</span>
              <span className="text-[10px] text-slate-500">{col.subcols.length} subcol · {col.subcols.reduce((s, sc) => s + sc.pos.length, 0)} pos</span>
            </div>
            <div className="p-3">
              {col.subcols.map((sub) => (
                <div key={sub.codigo} className="mb-3 last:mb-0">
                  <div className="flex items-center gap-2 px-2 py-1 mb-1.5">
                    <div className="w-1 h-3.5 rounded bg-sky-400" />
                    <span className="text-[10px] font-bold text-slate-400">{sub.codigo}</span>
                    <span className="text-[9px] text-slate-500">{sub.pos.filter((p) => p.stock > 0).length}/{sub.pos.length} ocupadas</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sub.pos.map((pos) => (
                      <button key={pos.posicionId} onClick={() => handleClick(pos)} title={`${sub.codigo}-${pos.posicionNumero}${pos.stock > 0 ? ` (${pos.stock})` : ' · Vacío'}`}
                        className={`min-w-[32px] h-8 px-1.5 rounded text-[9px] font-bold transition-all cursor-pointer border ${getCellColor(pos)} ${getCellHover(pos)}`}>
                        {pos.posicionNumero}
                      </button>
                    ))}
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
          className="gap-1.5 border-slate-700 text-slate-400 hover:text-sky-400 hover:border-sky-500 text-xs bg-slate-800">
          {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Exportar Excel
        </Button>
      </div>

      {/* ═══ DIÁLOGO DETALLE ═══ */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setMode('view') } }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg bg-slate-900 border-slate-700 shadow-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold text-white">
              {detail?.columnaLetra} · {detail?.subcolumnaCodigo} · Pos {detail?.posicionNumero}
              {!mode || mode === 'view' ? '' : ` — ${mode === 'ingreso' ? 'Ingreso' : mode === 'salida' ? 'Salida' : mode === 'traslado' ? 'Traslado' : 'Devolución'}`}
            </DialogTitle>
          </DialogHeader>

          {detail && (<>
            {/* ── VISTA ── */}
            {mode === 'view' && (
              detail.stock.length > 0 ? (
                <div className="space-y-2">
                  {detail.stock.map((s) => (
                    <div key={s.bloque_id} className="rounded-lg border border-slate-700 bg-slate-800 p-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <span className="font-mono text-sky-400 font-bold text-xs">{s.bloque_codigo}</span>
                          <p className="text-slate-400 text-xs mt-0.5 truncate">{s.bloque_descripcion || 'Sin descripción'}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-emerald-400 text-sm">{s.cantidad}</p>
                          <p className="text-[10px] text-slate-500">{s.bloque_unidad}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="grid grid-cols-2 gap-2 pt-2">
                    <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                    <Button onClick={openSalida} size="sm" className="gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs"><ArrowUpFromLine className="h-3.5 w-3.5" /> Salida</Button>
                    <Button onClick={openTraslado} size="sm" className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs"><ArrowRightLeft className="h-3.5 w-3.5" /> Traslado</Button>
                    <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs"><RotateCcw className="h-3.5 w-3.5" /> Devolución</Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 py-4 text-center">
                  <BoxSelect className="h-10 w-10 text-slate-500 mx-auto" />
                  <p className="text-slate-400 text-sm">Posición vacía</p>
                  <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
                    <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                    <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs"><RotateCcw className="h-3.5 w-3.5" /> Devolución</Button>
                  </div>
                </div>
              )
            )}

            {/* ── INGRESO MÚLTIPLE ── */}
            {mode === 'ingreso' && (
              <div className="space-y-3">
                {detail.stock.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-950/50 p-2">
                    <p className="text-[10px] font-bold text-amber-400">Posición con {detail.stock.length} artículo(s). Se agregará el nuevo.</p>
                  </div>
                )}
                <p className="text-xs font-bold text-slate-300">Escribe el código y se autocompletará:</p>
                {ingRows.map((row, i) => (
                  <div key={i} className="rounded-lg border border-emerald-500/20 bg-slate-800/50 p-3 space-y-2">
                    {/* Fila principal: Código + Descripción + UN + Cantidad */}
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-4">
                        <Label className="text-[10px] text-emerald-400 font-semibold">Código</Label>
                        <div className="relative">
                          <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('ing', i, e.target.value)} placeholder="Escribe código..."
                            className={`w-full h-9 rounded-md border text-xs bg-slate-900 text-white placeholder-slate-600 px-2 font-mono focus:outline-none focus:ring-2 ${row.bloque_id ? 'border-emerald-500/50 ring-emerald-500/30' : 'border-slate-700 focus:ring-emerald-500/50'}`} />
                          {searchingCode === `ing-${i}` && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2"><Loader2 className="h-3 w-3 animate-spin text-emerald-400" /></div>
                          )}
                        </div>
                        {/* Dropdown de sugerencias si no hay match exacto */}
                        {!row.bloque_id && row.codigo.length >= 1 && (
                          <div className="max-h-28 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 mt-1 shadow-xl">
                            {catalogoLoading && <div className="px-2 py-1.5 text-xs text-slate-500">Cargando catálogo...</div>}
                            {!catalogoLoading && getFilteredCatalogo('ing', i).filter((b) => !ingRows.some((r, ri) => ri !== i && r.bloque_id === b.id)).slice(0, 8).length === 0 && (
                              <div className="px-2 py-1.5 text-xs text-slate-500">Sin resultados</div>
                            )}
                            {!catalogoLoading && getFilteredCatalogo('ing', i).filter((b) => !ingRows.some((r, ri) => ri !== i && r.bloque_id === b.id)).slice(0, 8).map((b) => (
                              <button key={b.id} onClick={() => onSelectFromCatalog('ing', i, b)}
                                className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-700 text-slate-300 border-b border-slate-800 last:border-0 transition-colors">
                                <span className="font-mono text-emerald-400">{b.codigo}</span>
                                <span className="text-slate-500 ml-1">— {b.descripcion || b.unidad}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="col-span-4">
                        <Label className="text-[10px] text-slate-500">Descripción</Label>
                        <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                          className="w-full h-9 rounded-md border border-slate-700 text-xs bg-slate-850 text-slate-400 px-2 cursor-default" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px] text-slate-500">UN</Label>
                        <input type="text" value={row.unidad} readOnly placeholder="—"
                          className="w-full h-9 rounded-md border border-slate-700 text-xs bg-slate-850 text-slate-400 px-2 text-center cursor-default" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px] text-sky-400 font-semibold">Cantidad</Label>
                        <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateIngresoCantidad(i, e.target.value)}
                          className="h-9 text-xs bg-slate-900 border-sky-500/40 text-white focus:ring-sky-500/50 font-bold" placeholder="0" autoFocus />
                      </div>
                    </div>
                    {ingRows.length > 1 && (
                      <div className="flex justify-end">
                        <button onClick={() => removeIngresoRow(i)} className="p-1 rounded hover:bg-red-900/50 text-slate-600 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    )}
                  </div>
                ))}
                <button onClick={addIngresoRow} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"><Plus className="h-3.5 w-3.5" /> Agregar otro artículo</button>
                <div className="flex gap-2 pt-1">
                  <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700 text-slate-400 hover:bg-slate-800">Cancelar</Button>
                  <Button onClick={doIngreso} disabled={busy} size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />} Registrar ingreso</Button>
                </div>
              </div>
            )}

            {/* ── SALIDA ── */}
            {mode === 'salida' && (
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-300">Artículos a salir:</p>
                {salItems.map((row, i) => {
                  const bloque = bloquesCatalogo.find((b) => b.id === row.bloque_id)
                  return (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 p-2">
                      <Package className="h-3.5 w-3.5 text-slate-500" />
                      <span className="font-mono text-sky-400 text-xs flex-1">{bloque?.codigo || '—'}</span>
                      <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => { const u = [...salItems]; u[i].cantidad = e.target.value; setSalItems(u) }}
                        className="w-20 h-7 text-xs bg-slate-700 border-slate-600 text-white focus:ring-red-500/50" />
                    </div>
                  )
                })}
                <div className="flex gap-2">
                  <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700 text-slate-400 hover:bg-slate-800">Cancelar</Button>
                  <Button onClick={doSalida} disabled={busy} size="sm" className="gap-1 bg-red-600 hover:bg-red-700 text-white text-xs">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />} Registrar salida</Button>
                </div>
              </div>
            )}

            {/* ── TRASLADO ── */}
            {mode === 'traslado' && (
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-300">Artículos a trasladar:</p>
                {trItems.map((row, i) => {
                  const bloque = bloquesCatalogo.find((b) => b.id === row.bloque_id)
                  return (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 p-2">
                      <Package className="h-3.5 w-3.5 text-blue-400" />
                      <span className="font-mono text-sky-400 text-xs flex-1">{bloque?.codigo || '—'}</span>
                      <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => { const u = [...trItems]; u[i].cantidad = e.target.value; setTrItems(u) }}
                        className="w-20 h-7 text-xs bg-slate-700 border-slate-600 text-white focus:ring-blue-500/50" />
                    </div>
                  )
                })}
                <div className="space-y-2 pt-2 border-t border-slate-700">
                  <p className="text-[10px] font-bold text-slate-500">DESTINO:</p>
                  <div className="flex flex-wrap gap-1">
                    {posiciones.filter((p) => p.posicionId !== detail.posicionId).map((p) => (
                      <button key={p.posicionId} onClick={() => setTrDestPos(p)}
                        className={`px-2 py-1 rounded text-[10px] font-semibold transition-all border ${trDestPos?.posicionId === p.posicionId ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border-slate-700'}`}>
                        {p.columnaLetra}-{p.subcolumnaCodigo}-{p.posicionNumero}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700 text-slate-400 hover:bg-slate-800">Cancelar</Button>
                  <Button onClick={doTraslado} disabled={busy || !trDestPos} size="sm" className="gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />} Trasladar</Button>
                </div>
              </div>
            )}

            {/* ── DEVOLUCIÓN ── */}
            {mode === 'devolucion' && (
              <div className="space-y-3">
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/50 p-2">
                  <p className="text-[10px] font-bold text-amber-400">Registra artículos devueltos a esta posición.</p>
                </div>
                <p className="text-xs font-bold text-slate-300">Escribe el código y se autocompletará:</p>
                {devRows.map((row, i) => (
                  <div key={i} className="rounded-lg border border-amber-500/20 bg-slate-800/50 p-3 space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-4">
                        <Label className="text-[10px] text-amber-400 font-semibold">Código</Label>
                        <div className="relative">
                          <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('dev', i, e.target.value)} placeholder="Escribe código..."
                            className={`w-full h-9 rounded-md border text-xs bg-slate-900 text-white placeholder-slate-600 px-2 font-mono focus:outline-none focus:ring-2 ${row.bloque_id ? 'border-amber-500/50 ring-amber-500/30' : 'border-slate-700 focus:ring-amber-500/50'}`} />
                          {searchingCode === `dev-${i}` && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2"><Loader2 className="h-3 w-3 animate-spin text-amber-400" /></div>
                          )}
                        </div>
                        {!row.bloque_id && row.codigo.length >= 1 && (
                          <div className="max-h-28 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 mt-1 shadow-xl">
                            {catalogoLoading && <div className="px-2 py-1.5 text-xs text-slate-500">Cargando catálogo...</div>}
                            {!catalogoLoading && getFilteredCatalogo('dev', i).filter((b) => !devRows.some((r, ri) => ri !== i && r.bloque_id === b.id)).slice(0, 8).length === 0 && (
                              <div className="px-2 py-1.5 text-xs text-slate-500">Sin resultados</div>
                            )}
                            {!catalogoLoading && getFilteredCatalogo('dev', i).filter((b) => !devRows.some((r, ri) => ri !== i && r.bloque_id === b.id)).slice(0, 8).map((b) => (
                              <button key={b.id} onClick={() => onSelectFromCatalog('dev', i, b)}
                                className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-700 text-slate-300 border-b border-slate-800 last:border-0 transition-colors">
                                <span className="font-mono text-amber-400">{b.codigo}</span>
                                <span className="text-slate-500 ml-1">— {b.descripcion || b.unidad}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="col-span-4">
                        <Label className="text-[10px] text-slate-500">Descripción</Label>
                        <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                          className="w-full h-9 rounded-md border border-slate-700 text-xs bg-slate-850 text-slate-400 px-2 cursor-default" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px] text-slate-500">UN</Label>
                        <input type="text" value={row.unidad} readOnly placeholder="—"
                          className="w-full h-9 rounded-md border border-slate-700 text-xs bg-slate-850 text-slate-400 px-2 text-center cursor-default" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px] text-amber-400 font-semibold">Cantidad</Label>
                        <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateDevCantidad(i, e.target.value)}
                          className="h-9 text-xs bg-slate-900 border-amber-500/40 text-white focus:ring-amber-500/50 font-bold" placeholder="0" autoFocus />
                      </div>
                    </div>
                    {devRows.length > 1 && (
                      <div className="flex justify-end">
                        <button onClick={() => removeDevRow(i)} className="p-1 rounded hover:bg-red-900/50 text-slate-600 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    )}
                  </div>
                ))}
                <button onClick={addDevRow} className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"><Plus className="h-3.5 w-3.5" /> Agregar otro artículo</button>
                <div className="flex gap-2 pt-1">
                  <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700 text-slate-400 hover:bg-slate-800">Cancelar</Button>
                  <Button onClick={doDevolucion} disabled={busy} size="sm" className="gap-1 bg-amber-600 hover:bg-amber-700 text-white text-xs">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Registrar devolución</Button>
                </div>
              </div>
            )}
          </>)}
        </DialogContent>
      </Dialog>
    </div>
  )
}
