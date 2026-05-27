'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listarSectores,
  cargarPosicionesSector,
  stockDetallePosicion,
  obtenerPrimerNivel,
  listarBloquesParaSelect,
  buscarBloquePorCodigo,
  crearBloque,
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import {
  Download, Loader2, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft,
  Layers3, BoxSelect, X, Plus, Trash2, Search, RefreshCw, Package,
  RotateCcw, CalendarOff, Calendar, Warehouse, Sparkles, ChevronRight,
  Check, AlertTriangle, ToggleLeft, ToggleRight,
} from 'lucide-react'

type DetailStock = { bloque_id: string; bloque_codigo: string; bloque_descripcion: string; bloque_unidad: string; cantidad: number; fecha_vencimiento: string }
type SalItem = {
  bloque_id: string
  bloque_codigo: string
  bloque_descripcion: string
  bloque_unidad: string
  cantidad: string
  stockActual: number
  fecha_vencimiento: string
  selected: boolean
}
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

const EMPTY_ROW: RowEntry = { bloque_id: '', codigo: '', descripcion: '', unidad: '', cantidad: '', fecha_vencimiento: '', sin_vencimiento: false }

// ═══════════════════════════════════════════════
//  ANIMATED COUNTER HOOK
// ═══════════════════════════════════════════════
function useAnimatedCounter(target: number, duration = 800) {
  const [count, setCount] = useState(0)
  const prevTarget = useRef(0)

  useEffect(() => {
    if (target === prevTarget.current) return
    const start = prevTarget.current
    const diff = target - start
    if (diff === 0) return
    const startTime = performance.now()
    let raf: number

    function tick(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic
      setCount(Math.round(start + diff * eased))
      if (progress < 1) {
        raf = requestAnimationFrame(tick)
      }
    }

    raf = requestAnimationFrame(tick)
    prevTarget.current = target
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return count
}

// ═══════════════════════════════════════════════
//  SKELETON LOADING COMPONENT
// ═══════════════════════════════════════════════
function SkeletonShimmer() {
  return (
    <div className="space-y-6">
      {/* Stats skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="relative rounded-2xl border border-slate-700/30 bg-gradient-to-br from-slate-800/60 to-slate-800/20 p-4 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent animate-[shimmer_2s_infinite]" />
            <div className="h-3 w-16 bg-slate-700/60 rounded-full mb-3" />
            <div className="h-7 w-12 bg-slate-700/40 rounded-lg" />
          </div>
        ))}
      </div>
      {/* Grid skeleton */}
      <div className="space-y-6">
        {[1, 2].map((i) => (
          <div key={i} className="rounded-2xl border border-slate-700/30 bg-gradient-to-b from-slate-800/50 to-slate-800/20 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-700/30 flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-slate-700/40 animate-pulse" />
              <div className="h-4 w-32 bg-slate-700/40 rounded-lg animate-pulse" />
            </div>
            <div className="p-4">
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 12 }).map((_, j) => (
                  <div key={j} className="w-[42px] h-10 rounded-xl bg-slate-700/30 animate-pulse" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

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
  const justSelectedRef = useRef(false)

  // Detalle de posicion
  const [detail, setDetail] = useState<{
    posicionId: string; posicionNumero: number; subcolumnaCodigo: string; columnaLetra: string
    stock: DetailStock[]
  } | null>(null)
  const [mode, setMode] = useState<ActionMode>('view')

  // Ingreso state
  const [ingRows, setIngRows] = useState<RowEntry[]>([{ ...EMPTY_ROW }])

  // Salida state
  const [salItems, setSalItems] = useState<SalItem[]>([])

  // Traslado state
  type TrItem = {
    bloque_id: string
    bloque_codigo: string
    bloque_descripcion: string
    bloque_unidad: string
    cantidad: string
    stockActual: number
    selected: boolean
    saldoMode: 'saldo' | 'ajustar'
    fecha_vencimiento: string
  }
  const [trDestPos, setTrDestPos] = useState<PosicionConStock | null>(null)
  const [trItems, setTrItems] = useState<TrItem[]>([])
  const [trConfirmOpen, setTrConfirmOpen] = useState(false)

  // Devolucion state
  const [devRows, setDevRows] = useState<RowEntry[]>([{ ...EMPTY_ROW }])

  // Catalogo
  const [bloquesCatalogo, setBloquesCatalogo] = useState<BloqueOption[]>([])

  const [catalogoLoading, setCatalogoLoading] = useState(false)

  // Animated counters
  const animatedTotal = useAnimatedCounter(posiciones.length)
  const animatedOccupied = useAnimatedCounter(posiciones.filter((p) => p.stock > 0).length)
  const animatedEmpty = useAnimatedCounter(posiciones.length - posiciones.filter((p) => p.stock > 0).length)

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
        setSalItems(stock.map((s) => ({
          bloque_id: s.bloque_id,
          bloque_codigo: s.bloque_codigo,
          bloque_descripcion: s.bloque_descripcion,
          bloque_unidad: s.bloque_unidad,
          cantidad: String(s.cantidad),
          stockActual: s.cantidad,
          fecha_vencimiento: s.fecha_vencimiento || '',
          selected: false,
        })))
        setTrItems(stock.map((s) => ({
          bloque_id: s.bloque_id,
          bloque_codigo: s.bloque_codigo,
          bloque_descripcion: s.bloque_descripcion,
          bloque_unidad: s.bloque_unidad,
          cantidad: String(s.cantidad),
          stockActual: s.cantidad,
          selected: false,
          saldoMode: 'saldo',
          fecha_vencimiento: s.fecha_vencimiento || '',
        })))
      }
    } catch { toast.error('Error al cargar detalle') }
  }

  function openIngreso() {
    setIngRows([{ ...EMPTY_ROW }])
    setMode('ingreso')
  }

  function openSalida() {
    if (detail) setSalItems(detail.stock.map((s) => ({
      bloque_id: s.bloque_id,
      bloque_codigo: s.bloque_codigo,
      bloque_descripcion: s.bloque_descripcion,
      bloque_unidad: s.bloque_unidad,
      cantidad: String(s.cantidad),
      stockActual: s.cantidad,
      fecha_vencimiento: s.fecha_vencimiento || '',
      selected: false,
    })))
    setMode('salida')
  }

  function openTraslado() {
    setTrDestPos(null)
    setTrConfirmOpen(false)
    if (detail) setTrItems(detail.stock.map((s) => ({
      bloque_id: s.bloque_id,
      bloque_codigo: s.bloque_codigo,
      bloque_descripcion: s.bloque_descripcion,
      bloque_unidad: s.bloque_unidad,
      cantidad: String(s.cantidad),
      stockActual: s.cantidad,
      selected: false,
      saldoMode: 'saldo',
      fecha_vencimiento: s.fecha_vencimiento || '',
    })))
    setMode('traslado')
  }

  function openDevolucion() {
    setDevRows([{ ...EMPTY_ROW }])
    setMode('devolucion')
  }

  // Actualizar campo de busqueda — solo actualiza texto, no auto-selecciona
  function handleCodeInput(prefix: 'ing' | 'dev', idx: number, value: string) {
    const trimmed = value.trim()
    const updateRows = prefix === 'ing' ? setIngRows : setDevRows
    updateRows((prev) => {
      const u = [...prev]
      u[idx] = { ...u[idx], codigo: trimmed, bloque_id: '', descripcion: '', unidad: '' }
      return u
    })
  }

  // Crear articulo manual cuando el usuario sale del campo sin seleccionar nada
  async function handleCodeBlur(prefix: 'ing' | 'dev', idx: number) {
    // Skip if user just selected from dropdown (onBlur fires before onClick)
    if (justSelectedRef.current) { justSelectedRef.current = false; return }
    const rows = prefix === 'ing' ? ingRows : devRows
    const row = rows[idx]
    if (!row || row.bloque_id || row.codigo.trim().length < 1) return
    const upper = row.codigo.trim().toUpperCase()
    const updateRows = prefix === 'ing' ? setIngRows : setDevRows
    // Check if exact code exists
    const bloque = await buscarBloquePorCodigo(upper)
    if (bloque) {
      updateRows((prev) => {
        const u = [...prev]
        u[idx] = { ...u[idx], bloque_id: bloque.id, codigo: bloque.codigo, descripcion: bloque.descripcion, unidad: bloque.unidad }
        return u
      })
    } else {
      const virtualId = `manual_${upper}`
      updateRows((prev) => {
        const u = [...prev]
        u[idx] = { ...u[idx], bloque_id: virtualId, codigo: upper, descripcion: 'Articulo nuevo (manual)', unidad: 'KG' }
        return u
      })
    }
  }

  function onSelectFromCatalog(prefix: 'ing' | 'dev', idx: number, bloque: BloqueOption) {
    justSelectedRef.current = true
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

  // Auto-create manual_ bloques in piso_bloques before registering movement
  async function ensureManualBloqueCreated(rows: RowEntry[]): Promise<RowEntry[]> {
    const resolved: RowEntry[] = []
    for (const r of rows) {
      if (r.bloque_id.startsWith('manual_')) {
        const code = r.bloque_id.replace('manual_', '')
        try {
          const created = await crearBloque(code, r.descripcion || '', r.unidad || 'KG')
          if (created.length > 0) {
            // Find the newly created one
            const found = created.find((b) => b.codigo === code)
            if (found) {
              resolved.push({ ...r, bloque_id: found.id })
              continue
            }
          }
        } catch {
          // If creation fails, try searching for it (maybe it was already created)
        }
        // Last resort: try buscarBloquePorCodigo
        const existing = await buscarBloquePorCodigo(code)
        if (existing) {
          resolved.push({ ...r, bloque_id: existing.id })
        } else {
          resolved.push(r)
        }
      } else {
        resolved.push(r)
      }
    }
    return resolved
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
      // Resolve manual_ IDs before registering
      const resolved = await ensureManualBloqueCreated(validRows)
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posicion'); setBusy(false); return }
      const detalles = resolved.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarIngresoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Ingreso registrado')
      loadBloques()
      if (mountedRef.current) { setDetail(null); setMode('view'); setIngRows([{ ...EMPTY_ROW }]) }
      await loadPosiciones()
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  async function doSalida() {
    if (!detail || !perfil) return
    const validRows = salItems.filter((r) => r.selected && r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para salir'); return }
    setBusy(true)
    try {
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles'); setBusy(false); return }
      const detalles = validRows.map((r) => ({ nivel_id: nivelId, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad), fecha_vencimiento: r.fecha_vencimiento || null }))
      await registrarSalidaPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Salida registrada')
      if (mountedRef.current) { setDetail(null); setMode('view') }
      await loadPosiciones()
    } catch (err: unknown) { toast.error('Error', { description: err instanceof Error ? err.message : '' }) } finally { setBusy(false) }
  }

  async function doTraslado() {
    if (!detail || !perfil || !trDestPos) return
    if (detail.posicionId === trDestPos.posicionId) { toast.error('Origen y destino no pueden ser iguales'); return }
    const validRows = trItems.filter((r) => r.selected && r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para trasladar'); return }
    setBusy(true)
    try {
      const [origNivelId, destNivelId] = await Promise.all([
        obtenerPrimerNivel(detail.posicionId),
        obtenerPrimerNivel(trDestPos.posicionId),
      ])
      if (!origNivelId || !destNivelId) { toast.error('No hay niveles disponibles'); setBusy(false); return }

      // Separate items by discrepancy type
      const exactItems = validRows.filter((r) => parseFloat(r.cantidad) === r.stockActual)
      const deficitItems = validRows.filter((r) => parseFloat(r.cantidad) < r.stockActual)
      const surplusItems = validRows.filter((r) => parseFloat(r.cantidad) > r.stockActual)

      // 1) Base transfer for ALL selected items (move the entered amount)
      const allDetSal = validRows.map((r) => ({ nivel_id: origNivelId!, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad), fecha_vencimiento: r.fecha_vencimiento || null }))
      const allDetIng = validRows.map((r) => ({ nivel_id: destNivelId!, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad), fecha_vencimiento: r.fecha_vencimiento || null }))
      await registrarTrasladoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', allDetSal, allDetIng)

      // 2) For surplus items (qty > stock): create ingreso at destination for the excess
      for (const item of surplusItems) {
        const excess = parseFloat(item.cantidad) - item.stockActual
        if (excess > 0) {
          await registrarIngresoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', [
            { nivel_id: destNivelId!, bloque_id: item.bloque_id, cantidad: excess, fecha_vencimiento: item.fecha_vencimiento || '' },
          ])
        }
      }

      // 3) For deficit items with saldoMode 'ajustar': create salida at origin for remaining balance
      for (const item of deficitItems) {
        if (item.saldoMode === 'ajustar') {
          const remaining = item.stockActual - parseFloat(item.cantidad)
          if (remaining > 0) {
            await registrarSalidaPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', [
              { nivel_id: origNivelId!, bloque_id: item.bloque_id, cantidad: remaining, fecha_vencimiento: item.fecha_vencimiento || null },
            ])
          }
        }
        // saldoMode === 'saldo': leave the balance as-is, no extra action needed
      }

      // Build result message
      const parts: string[] = ['Traslado registrado']
      if (surplusItems.length > 0) parts.push(`${surplusItems.length} ingreso(s) por excedente`)
      const adjustedCount = deficitItems.filter((r) => r.saldoMode === 'ajustar').length
      if (adjustedCount > 0) parts.push(`${adjustedCount} salida(s) por ajuste`)
      toast.success(parts.join(' · '))
      setTrConfirmOpen(false)
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
      // Resolve manual_ IDs before registering
      const resolved = await ensureManualBloqueCreated(validRows)
      const nivelId = await obtenerPrimerNivel(detail.posicionId)
      if (!nivelId) { toast.error('No hay niveles disponibles en esta posicion'); setBusy(false); return }
      const detalles = resolved.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarDevolucionPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Devolucion registrada')
      loadBloques()
      if (mountedRef.current) { setDetail(null); setMode('view'); setDevRows([{ ...EMPTY_ROW }]) }
      await loadPosiciones()
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
              className={`w-full h-9 rounded-xl border text-xs pl-8 pr-2 font-mono focus:outline-none focus:ring-2 transition-all duration-300 [color-scheme:dark] ${row.sin_vencimiento ? 'border-slate-700 bg-slate-800/50 text-slate-600 cursor-not-allowed' : isIng ? 'border-emerald-500/50 bg-slate-900 text-white focus:ring-emerald-500/50' : 'border-amber-500/50 bg-slate-900 text-white focus:ring-amber-500/50'}`}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggleSin(idx)}
          className={`flex items-center gap-1 px-2.5 h-9 rounded-xl text-[10px] font-semibold border transition-all duration-300 whitespace-nowrap ${row.sin_vencimiento
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
    // Show dropdown whenever there's text and no selection yet
    if (row.bloque_id || row.codigo.trim().length < 1) return null
    const suggestions = !catalogoLoading
      ? getFilteredCatalogo(prefix, idx)
          .filter((b) => !rows.some((r, ri) => ri !== idx && r.bloque_id === b.id))
          .slice(0, 10)
      : []
    return (
      <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-700/80 bg-slate-900/95 backdrop-blur-sm shadow-2xl shadow-black/40">
        {catalogoLoading && <div className="px-3 py-2 text-xs text-slate-500">Cargando catalogo...</div>}
        {!catalogoLoading && suggestions.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-400 flex items-center gap-1.5">
            <Sparkles className={`h-3 w-3 ${isIng ? 'text-emerald-400' : 'text-amber-400'}`} />
            Articulo nuevo — se creara al registrar
          </div>
        )}
        {!catalogoLoading && suggestions.map((b) => (
          <button key={b.id} onClick={() => onSelectFromCatalog(prefix, idx, b)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-slate-700/80 text-slate-300 border-b border-slate-800/50 last:border-0 transition-all duration-200">
            <span className={isIng ? 'font-mono text-emerald-400' : 'font-mono text-amber-400'}>{b.codigo}</span>
            <span className="text-slate-500 ml-1.5">— {b.descripcion || b.unidad}</span>
          </button>
        ))}
      </div>
    )
  }

  // ═══════════════════════════════════════════════
  //  3D CELL STYLING — Enhanced Isometric Shelf
  // ═══════════════════════════════════════════════
  function getCellClasses(pos: PosicionConStock): string {
    const base = 'relative group min-w-[52px] h-10 px-1 rounded-lg transition-all duration-300 cursor-pointer border overflow-hidden'
    if (pos.stock <= 0) {
      return `${base} bg-emerald-500/[0.18] border-emerald-400/25 hover:bg-emerald-500/30 hover:border-emerald-400/40 hover:shadow-lg hover:shadow-emerald-500/15 hover:-translate-y-1`
    }
    if (pos.bloques.length > 1) {
      return `${base} bg-amber-500/40 border-amber-400/25 hover:bg-amber-500/55 hover:shadow-lg hover:shadow-amber-500/25 hover:-translate-y-1`
    }
    return `${base} bg-sky-500/30 border-sky-400/20 hover:bg-sky-500/45 hover:shadow-lg hover:shadow-sky-500/25 hover:-translate-y-1`
  }

  function formatStock(qty: number): string {
    return qty % 1 === 0 ? String(qty) : qty.toFixed(1)
  }

  // ═══════════════════════════════════════════════
  //  LOADING / EMPTY STATES — Skeleton shimmer
  // ═══════════════════════════════════════════════
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-400 to-cyan-500 animate-pulse flex items-center justify-center">
              <Warehouse className="h-7 w-7 text-white" />
            </div>
            <div className="absolute inset-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-400 to-cyan-500 animate-ping opacity-20" />
          </div>
          <div className="text-center">
            <p className="text-sm text-slate-400 animate-pulse font-medium">Cargando sectores...</p>
            <p className="text-xs text-slate-600 mt-1">Preparando vista del almacén</p>
          </div>
        </div>
      </div>
    )
  }

  if (sectores.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-10 text-center">
        <Layers3 className="h-14 w-14 text-slate-600 mx-auto mb-4 animate-bounce" />
        <p className="text-slate-400 font-semibold text-lg">No hay sectores creados</p>
        <p className="text-xs text-slate-500 mt-1">Ve a Configuracion para crear tu primer sector</p>
      </div>
    )
  }

  const displayPos = searchBloque.trim() ? filteredPosiciones : posiciones

  // Pill tab indicator position
  const activeSectorIdx = sectores.findIndex((s) => s.id === sectorFilter)

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

      {/* ═══ DASHBOARD STATS — Gradient border cards with animated counters ═══ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Total */}
        <div className="group relative rounded-2xl p-[1px] bg-gradient-to-br from-slate-600/40 to-slate-700/20 shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300">
          <div className="rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 p-4 overflow-hidden relative">
            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-slate-600/15 to-transparent rounded-bl-full" />
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.15em]">Total</p>
            <p className="text-2xl font-extrabold text-white mt-1 tracking-tight tabular-nums">{animatedTotal.toLocaleString()}</p>
            <p className="text-[10px] text-slate-500 mt-1">posiciones</p>
          </div>
        </div>

        {/* Ocupadas */}
        <div className="group relative rounded-2xl p-[1px] bg-gradient-to-br from-sky-500/30 to-cyan-500/10 shadow-lg hover:shadow-sky-500/10 hover:-translate-y-0.5 transition-all duration-300">
          <div className="rounded-2xl bg-gradient-to-br from-sky-950/60 to-slate-900 p-4 overflow-hidden relative">
            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-sky-500/10 to-transparent rounded-bl-full" />
            <p className="text-[10px] font-bold text-sky-400 uppercase tracking-[0.15em]">Ocupadas</p>
            <p className="text-2xl font-extrabold text-sky-200 mt-1 tracking-tight tabular-nums">{animatedOccupied}</p>
            <p className="text-[10px] text-sky-400/60 mt-1">{multiArt} multiples</p>
          </div>
        </div>

        {/* Vacias */}
        <div className="group relative rounded-2xl p-[1px] bg-gradient-to-br from-emerald-500/30 to-emerald-500/10 shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300">
          <div className="rounded-2xl bg-gradient-to-br from-emerald-950/50 to-slate-900 p-4 overflow-hidden relative">
            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-emerald-500/10 to-transparent rounded-bl-full" />
            <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.15em]">Vacias</p>
            <p className="text-2xl font-extrabold text-emerald-200 mt-1 tracking-tight tabular-nums">{animatedEmpty.toLocaleString()}</p>
            <p className="text-[10px] text-emerald-400/60 mt-1">disponibles</p>
          </div>
        </div>

        {/* Ocupacion */}
        <div className="group relative rounded-2xl p-[1px] bg-gradient-to-br from-violet-500/30 to-fuchsia-500/10 shadow-lg hover:shadow-violet-500/10 hover:-translate-y-0.5 transition-all duration-300">
          <div className="rounded-2xl bg-gradient-to-br from-violet-950/50 to-slate-900 p-4 overflow-hidden relative">
            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-bl from-violet-500/10 to-transparent rounded-bl-full" />
            <p className="text-[10px] font-bold text-violet-400 uppercase tracking-[0.15em]">Ocupacion</p>
            <p className="text-2xl font-extrabold text-violet-200 mt-1 tracking-tight tabular-nums">{pct}<span className="text-sm text-violet-400/60">%</span></p>
            <div className="mt-2 h-2 rounded-full bg-slate-700/80 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-1000 ease-out"
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ═══ SELECTOR SECTOR — Pill-style with sliding indicator ═══ */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sector:</span>
          <div className="relative flex gap-1 bg-slate-800/60 rounded-xl p-1 border border-slate-700/30 backdrop-blur-sm">
            {/* Sliding indicator */}
            <div
              className="absolute top-1 bottom-1 rounded-lg bg-gradient-to-r from-sky-400 to-cyan-500 shadow-lg shadow-sky-500/25 transition-all duration-300 ease-out"
              style={{
                left: activeSectorIdx >= 0 ? `calc(${activeSectorIdx} * (100% / ${sectores.length}) + 4px)` : '4px',
                width: `calc(100% / ${sectores.length} - 8px)`,
              }}
            />
            {sectores.map((s) => (
              <button key={s.id} onClick={() => setSectorFilter(s.id)}
                className={`relative z-10 flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all duration-300 ${sectorFilter === s.id
                  ? 'text-white'
                  : 'text-slate-400 hover:text-slate-300'
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
              className="pl-9 pr-3 py-2 h-9 rounded-xl border border-slate-700/50 text-xs bg-slate-800/60 text-white placeholder-slate-500 w-48 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50 backdrop-blur-sm transition-all duration-300" />
          </div>
          <button onClick={loadPosiciones} className="p-2 rounded-xl border border-slate-700/50 hover:bg-slate-700/80 transition-all duration-500 hover:-rotate-180 bg-slate-800/60 backdrop-blur-sm hover:shadow-lg"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /></button>
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

      {/* ═══ 3D RACK GRID — Enhanced isometric warehouse shelves ═══ */}
      <div
        className="space-y-10"
        style={{
          perspective: '1400px',
        }}
      >
        {columnas.map((col) => (
          <div
            key={col.letra}
            className="rounded-2xl border border-slate-700/40 bg-gradient-to-b from-slate-800/70 to-slate-800/25 backdrop-blur-sm shadow-2xl shadow-black/25 overflow-hidden transition-all duration-300 hover:shadow-black/35"
            style={{
              transform: 'rotateX(8deg) rotateY(-2deg)',
              transformOrigin: 'top left',
            }}
          >
            {/* Column header — 3D tab/label sticking up */}
            <div className="relative px-5 py-3 border-b border-slate-700/40 bg-gradient-to-r from-slate-900/70 to-slate-900/40 flex items-center gap-3 overflow-hidden">
              {/* Left side panel for depth */}
              <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b from-slate-600 via-slate-500 to-slate-600" />
              {/* Subtle inner glow */}
              <div className="absolute inset-0 bg-gradient-to-r from-white/[0.02] to-transparent pointer-events-none" />

              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-400 to-cyan-500 flex items-center justify-center text-white font-extrabold text-sm shadow-lg shadow-sky-500/30 relative">
                <span className="relative z-10">{col.letra}</span>
                {/* 3D tab top surface */}
                <div className="absolute -top-1 left-1 right-1 h-2 rounded-t-lg bg-gradient-to-b from-sky-300/40 to-transparent" />
              </div>
              <div className="flex-1">
                <span className="text-xs font-bold text-slate-200">Columna {col.letra}</span>
                <span className="text-[10px] text-slate-500 ml-2">{col.subcols.length} subcol &middot; {col.subcols.reduce((s, sc) => s + sc.pos.length, 0)} pos</span>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-600" />
            </div>

            {/* Top shelf surface gradient */}
            <div className="h-[2px] bg-gradient-to-r from-slate-600/30 via-slate-500/20 to-slate-600/30" />

            <div className="p-4">
              {col.subcols.map((sub) => (
                <div key={sub.codigo} className="mb-5 last:mb-0">
                  {/* Subcolumn header - shelf look */}
                  <div className="flex items-center gap-2.5 px-2 py-1.5 mb-3">
                    <div className="w-1.5 h-4 rounded-full bg-gradient-to-b from-sky-400 to-sky-600" />
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">{sub.codigo}</span>
                    <span className="text-[9px] text-slate-500 bg-slate-800/60 rounded-full px-2 py-0.5">{sub.pos.filter((p) => p.stock > 0).length}/{sub.pos.length} · {formatStock(sub.pos.reduce((s, p) => s + p.stock, 0))}</span>
                    {/* Shelf bar */}
                    <div className="flex-1 h-px bg-gradient-to-r from-slate-700/80 via-slate-600/40 to-transparent" />
                  </div>

                  {/* 3D shelf positions grid */}
                  <div className="flex flex-wrap gap-2.5 relative">
                    {/* Shelf surface line */}
                    <div className="absolute left-0 right-0 bottom-[-6px] h-[3px] bg-gradient-to-r from-transparent via-slate-500/30 to-transparent rounded-full shadow-sm shadow-black/30" />

                    {sub.pos.map((pos) => {
                      const isOccupied = pos.stock > 0
                      const isMulti = pos.bloques.length > 1
                      return (
                        <div key={pos.posicionId} className="relative group/pos">
                          {/* Side face (right) */}
                          <div className="absolute -right-[3px] top-[2px] bottom-[2px] w-[3px] rounded-r-sm bg-gradient-to-r from-black/15 to-black/25 transition-all duration-300 group-hover/pos:from-black/20 group-hover/pos:to-black/35" />
                          {/* Bottom face for depth */}
                          <div className="absolute -bottom-[3px] left-[2px] right-[2px] h-[3px] rounded-b-sm bg-gradient-to-b from-black/15 to-black/25 transition-all duration-300 group-hover/pos:from-black/20 group-hover/pos:to-black/35" />

                          <button
                            onClick={() => handleClick(pos)}
                            title={`${sub.codigo}-${pos.posicionNumero}${pos.stock > 0 ? ` · ${pos.bloques.length} articulo(s) · Stock: ${formatStock(pos.stock)}` : ' · Vacio'}`}
                            className={getCellClasses(pos)}
                            style={{
                              transform: 'perspective(600px) rotateX(2deg)',
                              boxShadow: isOccupied
                                ? 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 2px rgba(0,0,0,0.15), 4px 5px 0 -1px rgba(0,0,0,0.2), 0 3px 12px rgba(0,0,0,0.25)'
                                : 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 2px rgba(0,0,0,0.1), 3px 4px 0 -1px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.12)',
                            }}
                          >
                            {/* Top surface gradient */}
                            <div className="absolute inset-0 bg-gradient-to-b from-white/[0.08] to-transparent pointer-events-none rounded-lg" />
                            {/* Inner depth shadow */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent pointer-events-none rounded-lg" />

                            {/* Position number + article count */}
                            <div className="relative z-10 flex flex-col items-center justify-center h-full">
                              <span className={`font-bold text-[12px] leading-none ${
                                pos.stock <= 0 ? 'text-emerald-300' : 'text-white'
                              }`}>{pos.posicionNumero}</span>
                              {isOccupied && (
                                <span className={`text-[8px] font-bold leading-none mt-0.5 tabular-nums ${
                                  isMulti ? 'text-amber-200' : 'text-sky-200'
                                }`}>{pos.bloques.length} art</span>
                              )}
                            </div>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Bottom grounding shadow */}
            <div className="h-2 bg-gradient-to-r from-transparent via-black/10 to-transparent" />
          </div>
        ))}

        {/* Floor reflection */}
        <div className="h-16 bg-gradient-to-b from-slate-800/[0.04] to-transparent pointer-events-none -mt-4 rounded-b-3xl" />
      </div>

      {/* Exportar */}
      <div className="flex justify-end">
        <Button onClick={handleExport} disabled={busyExport} variant="outline" size="sm"
          className="gap-2 border-slate-700/50 text-slate-400 hover:text-sky-400 hover:border-sky-500/50 hover:bg-sky-500/5 text-xs bg-slate-800/60 backdrop-blur-sm rounded-xl transition-all duration-300 hover:shadow-lg hover:shadow-sky-500/10 hover:scale-[1.02]">
          {busyExport ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Exportar Excel
        </Button>
      </div>

      {/* ═══ DETAIL DIALOG — Frosted glass + breadcrumb + animated badge ═══ */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setMode('view') } }}>
        <DialogContent
          className="max-w-[calc(100vw-1rem)] sm:max-w-xl rounded-2xl max-h-[90vh] overflow-y-auto p-0 border-0 shadow-2xl"
          style={{
            background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(30, 41, 59, 0.88))',
            backdropFilter: 'blur(24px) saturate(1.2)',
            border: '1px solid rgba(71, 85, 105, 0.25)',
          }}
        >
          {/* Animated gradient border accent at top */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-sky-400 to-transparent opacity-60" />
          {/* Subtle inner glow */}
          <div className="absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-white/[0.03] to-transparent pointer-events-none rounded-t-2xl" />

          <div className="p-6 relative">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-cyan-500 flex items-center justify-center text-white font-extrabold text-xs shadow-lg shadow-sky-500/25">
                  {detail?.columnaLetra}
                </div>
                {/* Position breadcrumb */}
                <nav className="flex items-center gap-1 text-xs">
                  <span className="text-slate-300 font-medium">{detail?.columnaLetra}</span>
                  <ChevronRight className="h-3 w-3 text-slate-400" />
                  <span className="text-slate-300 font-medium">{detail?.subcolumnaCodigo}</span>
                  <ChevronRight className="h-3 w-3 text-slate-400" />
                  <span className="text-sky-300 font-bold">Pos {detail?.posicionNumero}</span>
                </nav>
                {/* Animated type badge */}
                {(!mode || mode === 'view') ? null : (
                  <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border animate-[scale-in_0.2s_ease-out] ${
                    mode === 'ingreso' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 shadow-sm shadow-emerald-500/10' :
                    mode === 'salida' ? 'bg-red-500/15 text-red-400 border-red-500/30 shadow-sm shadow-red-500/10' :
                    mode === 'traslado' ? 'bg-sky-500/15 text-sky-400 border-sky-500/30 shadow-sm shadow-sky-500/10' :
                    'bg-amber-500/15 text-amber-400 border-amber-500/30 shadow-sm shadow-amber-500/10'
                  }`}>
                    {mode === 'ingreso' ? '↓ Ingreso' : mode === 'salida' ? '↑ Salida' : mode === 'traslado' ? '⇄ Traslado' : '↺ Devolucion'}
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>

            {detail && (<>
              {/* ── VIEW MODE ── */}
              {mode === 'view' && (
                detail.stock.length > 0 ? (
                  <div className="space-y-2.5 mt-4">
                    {detail.stock.map((s, idx) => (
                      <div key={`${s.bloque_id}-${s.fecha_vencimiento}-${idx}`}
                        className="rounded-xl border border-slate-700/40 bg-slate-800/50 backdrop-blur-sm p-3.5 hover:border-slate-600/50 transition-all duration-300 hover:shadow-lg group/item">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            {/* Card number badge */}
                            <div className="flex-shrink-0 w-6 h-6 rounded-lg bg-slate-700/60 flex items-center justify-center text-[9px] font-bold text-slate-300 border border-slate-600/40">
                              {idx + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sky-300 font-bold text-sm">{s.bloque_codigo}</span>
                                {s.fecha_vencimiento && (
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/20 flex items-center gap-0.5">
                                    <Calendar className="h-2.5 w-2.5" /> {s.fecha_vencimiento}
                                  </span>
                                )}
                                {!s.fecha_vencimiento && (
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-slate-700/40 text-slate-400 border border-slate-600/30 flex items-center gap-0.5">
                                    <CalendarOff className="h-2.5 w-2.5" /> Sin fecha
                                  </span>
                                )}
                              </div>
                              <p className="text-slate-300 text-xs mt-0.5 truncate">{s.bloque_descripcion || 'Sin descripcion'}</p>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 ml-3">
                            <p className="font-extrabold text-emerald-300 text-lg leading-none">{s.cantidad}</p>
                            <p className="text-[10px] text-slate-300 mt-0.5">{s.bloque_unidad}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2 pt-3">
                      <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/15 transition-all duration-300 hover:shadow-emerald-500/25 hover:scale-[1.02]"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                      <Button onClick={openSalida} size="sm" className="gap-1.5 bg-red-600/90 hover:bg-red-600 text-white text-xs rounded-xl shadow-lg shadow-red-500/15 transition-all duration-300 hover:shadow-red-500/25 hover:scale-[1.02]"><ArrowUpFromLine className="h-3.5 w-3.5" /> Salida</Button>
                      <Button onClick={openTraslado} size="sm" className="gap-1.5 bg-sky-600/90 hover:bg-sky-600 text-white text-xs rounded-xl shadow-lg shadow-sky-500/15 transition-all duration-300 hover:shadow-sky-500/25 hover:scale-[1.02]"><ArrowRightLeft className="h-3.5 w-3.5" /> Traslado</Button>
                      <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600/90 hover:bg-amber-600 text-white text-xs rounded-xl shadow-lg shadow-amber-500/15 transition-all duration-300 hover:shadow-amber-500/25 hover:scale-[1.02]"><RotateCcw className="h-3.5 w-3.5" /> Devolucion</Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 py-6 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700/30 flex items-center justify-center mx-auto animate-pulse">
                      <BoxSelect className="h-8 w-8 text-slate-600" />
                    </div>
                    <div>
                      <p className="text-slate-400 font-semibold">Posicion vacia</p>
                      <p className="text-xs text-slate-500 mt-1">Esta posicion no tiene articulos registrados</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
                      <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/15 transition-all duration-300 hover:scale-[1.02]"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                      <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600/90 hover:bg-amber-600 text-white text-xs rounded-xl shadow-lg shadow-amber-500/15 transition-all duration-300 hover:scale-[1.02]"><RotateCcw className="h-3.5 w-3.5" /> Devolucion</Button>
                    </div>
                  </div>
                )
              )}

              {/* ── INGRESO MODE — Card number badges + border-left accent ═─ */}
              {mode === 'ingreso' && (
                <div className="space-y-4 mt-4">
                  {detail.stock.length > 0 && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-950/30 backdrop-blur-sm p-3">
                      <p className="text-[10px] font-bold text-amber-400">Posicion con {detail.stock.length} articulo(s). Se agregara el nuevo.</p>
                    </div>
                  )}
                  <p className="text-xs font-bold text-slate-300">Escribe el codigo y se autocompletara:</p>
                  {ingRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-emerald-500/15 bg-slate-800/40 backdrop-blur-sm p-4 space-y-3 border-l-2 border-l-emerald-500/40">
                      <div className="grid grid-cols-12 gap-2 items-end">
                        {/* Card number badge */}
                        <div className="col-span-1 flex items-center justify-center">
                          <div className="w-6 h-6 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[9px] font-bold text-emerald-400">
                            {i + 1}
                          </div>
                        </div>
                        {/* Codigo */}
                        <div className="col-span-11 sm:col-span-4">
                          <Label className="text-[10px] text-emerald-400 font-semibold">Codigo</Label>
                          <div className="relative">
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('ing', i, e.target.value)} onBlur={() => setTimeout(() => handleCodeBlur('ing', i), 150)} placeholder="Buscar codigo o descripcion..." autoFocus
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all duration-300 backdrop-blur-sm ${row.bloque_id ? 'border-emerald-500/40 ring-emerald-500/20 shadow-sm shadow-emerald-500/10' : 'border-slate-700/50 focus:ring-emerald-500/40'}`} />
                            <AutocompleteDropdown prefix="ing" idx={i} row={row} accentColor="emerald" />
                          </div>
                        </div>

                        {/* Descripcion */}
                        <div className="col-span-12 sm:col-span-4">
                          <Label className="text-[10px] text-slate-500">Descripcion</Label>
                          <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm transition-all duration-300" />
                        </div>

                        {/* UN */}
                        <div className="col-span-4 sm:col-span-3">
                          <Label className="text-[10px] text-slate-500">UN</Label>
                          <input type="text" value={row.unidad} readOnly placeholder="-"
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-2 text-center cursor-default backdrop-blur-sm transition-all duration-300" />
                        </div>

                        {/* Cantidad */}
                        <div className="col-span-8 sm:col-span-4">
                          <Label className="text-[10px] text-sky-400 font-semibold">Cantidad</Label>
                          <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateIngresoCantidad(i, e.target.value)}
                            className="h-10 text-xs bg-slate-900/80 border-sky-500/30 text-white focus:ring-sky-500/40 font-bold rounded-xl backdrop-blur-sm transition-all duration-300" placeholder="0" />
                        </div>
                      </div>

                      {/* Fecha de vencimiento */}
                      <FechaVencimientoField prefix="ing" idx={i} row={row} onFechaChange={updateIngresoFecha} onToggleSin={toggleIngresoSinVencimiento} />

                      {ingRows.length > 1 && (
                        <div className="flex justify-end">
                          <button onClick={() => removeIngresoRow(i)} className="p-1.5 rounded-lg hover:bg-red-900/30 text-slate-600 hover:text-red-400 transition-all duration-300"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button onClick={addIngresoRow} className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-all duration-300 hover:pl-1"><Plus className="h-3.5 w-3.5" /> Agregar otro articulo</button>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doIngreso} disabled={busy} size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition-all duration-300 hover:shadow-emerald-500/30 hover:scale-[1.02]">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />} Registrar ingreso</Button>
                  </div>
                </div>
              )}

              {/* ── SALIDA MODE ── */}
              {mode === 'salida' && (
                <div className="space-y-3 mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-slate-300">Toca los articulos que quieres salir:</p>
                    {salItems.length > 1 && (
                      <button
                        onClick={() => {
                          const allSelected = salItems.every((r) => r.selected)
                          setSalItems((prev) => prev.map((r) => ({ ...r, selected: !allSelected, cantidad: !allSelected ? String(r.stockActual) : r.cantidad })))
                        }}
                        className="flex items-center gap-1 text-[10px] font-semibold text-red-400 hover:text-red-300 transition-all duration-300"
                      >
                        {salItems.every((r) => r.selected) ? (
                          <><X className="h-3 w-3" /> Deseleccionar todos</>
                        ) : (
                          <><Check className="h-3 w-3" /> Seleccionar todos</>
                        )}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 -mt-2">{salItems.filter((r) => r.selected).length} de {salItems.length} seleccionados</p>
                  {salItems.map((row, i) => (
                    <div key={`${row.bloque_id}-${row.fecha_vencimiento}-${i}`}
                      onClick={() => {
                        const u = [...salItems]
                        const newSelected = !u[i].selected
                        u[i] = { ...u[i], selected: newSelected, cantidad: newSelected ? String(u[i].stockActual) : u[i].cantidad }
                        setSalItems(u)
                      }}
                      className={`rounded-xl border backdrop-blur-sm p-3 border-l-[3px] cursor-pointer transition-all duration-300 ${
                        row.selected
                          ? 'border-red-500/25 bg-red-950/30 border-l-red-500 shadow-md shadow-red-500/10 scale-[1.01]'
                          : 'border-slate-700/30 bg-slate-800/20 border-l-slate-600/40 hover:border-slate-600/60 hover:bg-slate-800/40'
                      }`}>
                      <div className="flex items-start gap-3">
                        {/* Selection indicator */}
                        <div className="pt-0.5 flex-shrink-0">
                          <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center transition-all duration-300 ${
                            row.selected
                              ? 'bg-red-500 border-red-500 shadow-md shadow-red-500/30'
                              : 'border-slate-600 bg-slate-800/60'
                          }`}>
                            {row.selected && <Check className="h-3 w-3 text-white" />}
                          </div>
                        </div>
                        {/* Article info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Package className="h-4 w-4 text-red-400/60 flex-shrink-0" />
                            <span className="font-mono text-sky-300 text-xs font-semibold">{row.bloque_codigo}</span>
                            {row.fecha_vencimiento && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/20 flex items-center gap-0.5">
                                <Calendar className="h-2.5 w-2.5" /> {row.fecha_vencimiento}
                              </span>
                            )}
                            {row.selected && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-red-500/20 text-red-300 border border-red-500/30 font-bold">SELECCIONADO</span>
                            )}
                          </div>
                          <p className="text-slate-400 text-[10px] mt-0.5 truncate">{row.bloque_descripcion || 'Sin descripcion'}</p>
                          <p className="text-[9px] text-slate-500 mt-0.5">Stock: {row.stockActual} {row.bloque_unidad}</p>
                        </div>
                        {/* Quantity */}
                        {row.selected && (
                          <Input type="number" step="any" min="0" max={row.stockActual} value={row.cantidad}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const u = [...salItems]
                              u[i] = { ...u[i], cantidad: e.target.value }
                              setSalItems(u)
                            }}
                            className="w-20 h-9 text-xs bg-slate-900/80 border-red-500/30 text-white focus:ring-red-500/40 rounded-xl backdrop-blur-sm transition-all duration-300" />
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doSalida} disabled={busy || salItems.every((r) => !r.selected)} size="sm" className="gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded-xl shadow-lg shadow-red-500/20 transition-all duration-300 hover:shadow-red-500/30 hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />} Registrar salida</Button>
                  </div>
                </div>
              )}

              {/* ── TRASLADO MODE ── */}
              {mode === 'traslado' && (
                <div className="space-y-3 mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-slate-300">Toca los articulos que quieres trasladar:</p>
                    {trItems.length > 1 && (
                      <button
                        onClick={() => {
                          const allSelected = trItems.every((r) => r.selected)
                          setTrItems((prev) => prev.map((r) => ({ ...r, selected: !allSelected, cantidad: !allSelected ? String(r.stockActual) : r.cantidad })))
                        }}
                        className="flex items-center gap-1 text-[10px] font-semibold text-sky-400 hover:text-sky-300 transition-all duration-300"
                      >
                        {trItems.every((r) => r.selected) ? (
                          <><X className="h-3 w-3" /> Deseleccionar todos</>
                        ) : (
                          <><Check className="h-3 w-3" /> Seleccionar todos</>
                        )}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 -mt-2">{trItems.filter((r) => r.selected).length} de {trItems.length} seleccionados</p>
                  {trItems.map((row, i) => {
                    const qty = parseFloat(row.cantidad) || 0
                    const diffType = qty > row.stockActual ? 'surplus' : qty < row.stockActual ? 'deficit' : 'exact'
                    return (
                      <div key={i} onClick={() => {
                        const u = [...trItems]
                        const newSelected = !u[i].selected
                        u[i] = { ...u[i], selected: newSelected, cantidad: newSelected ? String(u[i].stockActual) : u[i].cantidad }
                        setTrItems(u)
                      }} className={`rounded-xl border backdrop-blur-sm p-3 border-l-[3px] cursor-pointer transition-all duration-300 ${
                        row.selected
                          ? diffType === 'surplus'
                            ? 'border-amber-500/25 bg-amber-950/25 border-l-amber-500 shadow-md shadow-amber-500/10 scale-[1.01]'
                            : diffType === 'deficit'
                              ? 'border-sky-500/20 bg-sky-950/20 border-l-sky-500 shadow-md shadow-sky-500/10 scale-[1.01]'
                              : 'border-emerald-500/20 bg-emerald-950/20 border-l-emerald-500 shadow-md shadow-emerald-500/10 scale-[1.01]'
                          : 'border-slate-700/30 bg-slate-800/20 border-l-slate-600/40 hover:border-slate-600/60 hover:bg-slate-800/40'
                      }`}>
                        <div className="flex items-start gap-3">
                          {/* Selection indicator */}
                          <div className="pt-0.5 flex-shrink-0">
                            <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center transition-all duration-300 ${
                              row.selected
                                ? 'bg-sky-500 border-sky-500 shadow-md shadow-sky-500/30'
                                : 'border-slate-600 bg-slate-800/60'
                            }`}>
                              {row.selected && <Check className="h-3 w-3 text-white" />}
                            </div>
                          </div>
                          {/* Article info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-sky-400/60 flex-shrink-0" />
                              <span className="font-mono text-sky-400 text-xs font-semibold">{row.bloque_codigo}</span>
                              <span className="text-[10px] text-slate-500 truncate">{row.bloque_descripcion}</span>
                            </div>
                            {/* Stock reference + qty input row */}
                            <div className="flex items-center gap-3 mt-2">
                              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                                <span>Stock:</span>
                                <span className="font-mono font-semibold text-slate-300">{row.stockActual}</span>
                                <span>{row.bloque_unidad}</span>
                              </div>
                              {row.selected && (
                                <Input
                                  type="number"
                                  step="any"
                                  min="0"
                                  value={row.cantidad}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    const u = [...trItems]
                                    u[i] = { ...u[i], cantidad: e.target.value }
                                    setTrItems(u)
                                  }}
                                  className="w-24 h-8 text-xs bg-slate-900/80 border-sky-500/30 text-white focus:ring-sky-500/40 rounded-lg backdrop-blur-sm transition-all duration-300"
                                />
                              )}
                            </div>
                            {/* Discrepancy indicators */}
                            {row.selected && qty > 0 && diffType === 'surplus' && (
                              <div className="flex items-center gap-1.5 mt-2 text-amber-400 text-[10px]">
                                <AlertTriangle className="h-3 w-3" />
                                <span className="font-semibold">Excedente: se registrara ingreso de <span className="font-mono">{(qty - row.stockActual).toFixed(2)}</span> {row.bloque_unidad}</span>
                              </div>
                            )}
                            {row.selected && qty > 0 && diffType === 'deficit' && (
                              <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => {
                                    const u = [...trItems]
                                    u[i] = { ...u[i], saldoMode: 'saldo' }
                                    setTrItems(u)
                                  }}
                                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold border transition-all duration-300 ${
                                    row.saldoMode === 'saldo'
                                      ? 'bg-sky-500/20 border-sky-500/40 text-sky-300 shadow-inner'
                                      : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400'
                                  }`}
                                >
                                  <ToggleLeft className="h-3 w-3" />
                                  Dejar saldo
                                </button>
                                <button
                                  onClick={() => {
                                    const u = [...trItems]
                                    u[i] = { ...u[i], saldoMode: 'ajustar' }
                                    setTrItems(u)
                                  }}
                                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold border transition-all duration-300 ${
                                    row.saldoMode === 'ajustar'
                                      ? 'bg-red-500/20 border-red-500/40 text-red-300 shadow-inner'
                                      : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400'
                                  }`}
                                >
                                  <ToggleRight className="h-3 w-3" />
                                  Ajustar salida
                                </button>
                                {row.saldoMode === 'ajustar' && (
                                  <span className="text-[10px] text-red-400">
                                    Salida de <span className="font-mono font-semibold">{(row.stockActual - qty).toFixed(2)}</span> {row.bloque_unidad}
                                  </span>
                                )}
                                {row.saldoMode === 'saldo' && (
                                  <span className="text-[10px] text-slate-500">
                                    Queda <span className="font-mono font-semibold">{(row.stockActual - qty).toFixed(2)}</span> {row.bloque_unidad} en origen
                                  </span>
                                )}
                              </div>
                            )}
                            {row.selected && qty > 0 && diffType === 'exact' && (
                              <div className="flex items-center gap-1.5 mt-2 text-emerald-400 text-[10px]">
                                <Check className="h-3 w-3" />
                                <span className="font-semibold">Total</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  <div className="space-y-2 pt-3 border-t border-slate-700/40">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">DESTINO:</p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {posiciones.filter((p) => p.posicionId !== detail.posicionId).map((p) => (
                        <button key={p.posicionId} onClick={() => setTrDestPos(p)}
                          className={`px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-300 border ${trDestPos?.posicionId === p.posicionId
                            ? 'bg-sky-500 text-white border-sky-500 shadow-lg shadow-sky-500/20 scale-105'
                            : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/80 hover:text-slate-300 border-slate-700/40 backdrop-blur-sm hover:scale-[1.02]'
                            }`}>
                          {p.columnaLetra}-{p.subcolumnaCodigo}-{p.posicionNumero}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={() => setTrConfirmOpen(true)} disabled={busy || !trDestPos || trItems.filter((r) => r.selected && r.cantidad && parseFloat(r.cantidad) > 0).length === 0} size="sm" className="gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-xl shadow-lg shadow-sky-500/20 transition-all duration-300 hover:shadow-sky-500/30 hover:scale-[1.02]">
                      <ArrowRightLeft className="h-3.5 w-3.5" /> Confirmar traslado
                    </Button>
                  </div>
                </div>
              )}

              {/* ── DEVOLUCION MODE — Card number badges + border-left accent ═─ */}
              {mode === 'devolucion' && (
                <div className="space-y-4 mt-4">
                  <div className="rounded-xl border border-amber-500/20 bg-amber-950/30 backdrop-blur-sm p-3">
                    <p className="text-[10px] font-bold text-amber-400">Registra articulos devueltos a esta posicion.</p>
                  </div>
                  <p className="text-xs font-bold text-slate-300">Escribe el codigo y se autocompletara:</p>
                  {devRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-amber-500/15 bg-slate-800/40 backdrop-blur-sm p-4 space-y-3 border-l-2 border-l-amber-500/40">
                      <div className="grid grid-cols-12 gap-2 items-end">
                        {/* Card number badge */}
                        <div className="col-span-1 flex items-center justify-center">
                          <div className="w-6 h-6 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-[9px] font-bold text-amber-400">
                            {i + 1}
                          </div>
                        </div>
                        {/* Codigo */}
                        <div className="col-span-11 sm:col-span-4">
                          <Label className="text-[10px] text-amber-400 font-semibold">Codigo</Label>
                          <div className="relative">
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('dev', i, e.target.value)} onBlur={() => setTimeout(() => handleCodeBlur('dev', i), 150)} placeholder="Buscar codigo o descripcion..." autoFocus
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all duration-300 backdrop-blur-sm ${row.bloque_id ? 'border-amber-500/40 ring-amber-500/20 shadow-sm shadow-amber-500/10' : 'border-slate-700/50 focus:ring-amber-500/40'}`} />
                            <AutocompleteDropdown prefix="dev" idx={i} row={row} accentColor="amber" />
                          </div>
                        </div>

                        {/* Descripcion */}
                        <div className="col-span-12 sm:col-span-4">
                          <Label className="text-[10px] text-slate-500">Descripcion</Label>
                          <input type="text" value={row.descripcion} readOnly placeholder="Se autocompleta..."
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm transition-all duration-300" />
                        </div>

                        {/* UN */}
                        <div className="col-span-4 sm:col-span-3">
                          <Label className="text-[10px] text-slate-500">UN</Label>
                          <input type="text" value={row.unidad} readOnly placeholder="-"
                            className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-2 text-center cursor-default backdrop-blur-sm transition-all duration-300" />
                        </div>

                        {/* Cantidad */}
                        <div className="col-span-8 sm:col-span-4">
                          <Label className="text-[10px] text-amber-400 font-semibold">Cantidad</Label>
                          <Input type="number" step="any" min="0" value={row.cantidad} onChange={(e) => updateDevCantidad(i, e.target.value)}
                            className="h-10 text-xs bg-slate-900/80 border-amber-500/30 text-white focus:ring-amber-500/40 font-bold rounded-xl backdrop-blur-sm transition-all duration-300" placeholder="0" />
                        </div>
                      </div>

                      {/* Fecha de vencimiento */}
                      <FechaVencimientoField prefix="dev" idx={i} row={row} onFechaChange={updateDevFecha} onToggleSin={toggleDevSinVencimiento} />

                      {devRows.length > 1 && (
                        <div className="flex justify-end">
                          <button onClick={() => removeDevRow(i)} className="p-1.5 rounded-lg hover:bg-red-900/30 text-slate-600 hover:text-red-400 transition-all duration-300"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button onClick={addDevRow} className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 font-medium transition-all duration-300 hover:pl-1"><Plus className="h-3.5 w-3.5" /> Agregar otro articulo</button>
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doDevolucion} disabled={busy} size="sm" className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all duration-300 hover:shadow-amber-500/30 hover:scale-[1.02]">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Registrar devolucion</Button>
                  </div>
                </div>
              )}
            </>)}
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ TRASLADO CONFIRMATION DIALOG ═══ */}
      <Dialog open={trConfirmOpen} onOpenChange={(open) => { if (!open) setTrConfirmOpen(false) }}>
        <DialogContent className="sm:max-w-lg bg-slate-900 border-slate-700/50 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ArrowRightLeft className="h-5 w-5 text-sky-400" />
              Confirmar Traslado
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              Resumen de articulos a trasladar con ajustes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {(() => {
              const selected = trItems.filter((r) => r.selected && r.cantidad && parseFloat(r.cantidad) > 0)
              if (selected.length === 0) return <p className="text-xs text-slate-500">No hay articulos seleccionados.</p>
              return selected.map((r, i) => {
                const qty = parseFloat(r.cantidad)
                const diff = qty - r.stockActual
                let statusColor = 'text-emerald-400'
                let statusBg = 'bg-emerald-500/10 border-emerald-500/20'
                let statusLabel = 'Total'
                let statusIcon = <Check className="h-3 w-3" />
                if (diff > 0) {
                  statusColor = 'text-amber-400'
                  statusBg = 'bg-amber-500/10 border-amber-500/20'
                  statusLabel = `+${diff.toFixed(2)} excedente → ingreso`
                  statusIcon = <AlertTriangle className="h-3 w-3" />
                } else if (diff < 0) {
                  const deficit = Math.abs(diff)
                  if (r.saldoMode === 'ajustar') {
                    statusColor = 'text-red-400'
                    statusBg = 'bg-red-500/10 border-red-500/20'
                    statusLabel = `${deficit.toFixed(2)} queda → salida`
                    statusIcon = <ArrowUpFromLine className="h-3 w-3" />
                  } else {
                    statusColor = 'text-sky-400'
                    statusBg = 'bg-sky-500/10 border-sky-500/20'
                    statusLabel = `${deficit.toFixed(2)} queda en origen`
                    statusIcon = <ToggleLeft className="h-3 w-3" />
                  }
                }
                return (
                  <div key={i} className={`rounded-lg border ${statusBg} p-2.5`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Package className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />
                        <span className="font-mono text-xs text-sky-300 font-semibold">{r.bloque_codigo}</span>
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] font-semibold ${statusColor}`}>
                        {statusIcon}
                        <span>{statusLabel}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 pl-5">
                      <span>Trasladar: <span className="font-mono font-semibold text-white">{qty.toFixed(2)}</span></span>
                      <span>Stock: <span className="font-mono font-semibold text-slate-300">{r.stockActual}</span></span>
                      <span>{r.bloque_unidad}</span>
                    </div>
                  </div>
                )
              })
            })()}
          </div>

          {trDestPos && (
            <div className="flex items-center gap-2 text-xs bg-slate-800/60 rounded-lg border border-slate-700/40 px-3 py-2">
              <Warehouse className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-slate-500">Destino:</span>
              <span className="font-mono font-semibold text-sky-300">
                {trDestPos.columnaLetra}-{trDestPos.subcolumnaCodigo}-{trDestPos.posicionNumero}
              </span>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setTrConfirmOpen(false)} size="sm" className="text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl">
              Cancelar
            </Button>
            <Button onClick={doTraslado} disabled={busy} size="sm" className="gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-xl shadow-lg shadow-sky-500/20">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Ejecutar traslado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
