'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listarSectores,
  cargarPosicionesSector,
  stockDetallePosicion,
  stockDetalleNivel,
  obtenerPrimerNivel,
  obtenerNivelesPosicion,
  type NivelInfo,
  listarBloquesParaSelect,
  buscarBloquePorCodigo,
  crearBloque,
  registrarIngresoPosicion,
  registrarSalidaPosicion,
  registrarTrasladoPosicion,
  registrarDevolucionPosicion,
  type Sector,
  type PosicionConStock,
  cargarVistaColumna,
  type VistaPosicion,
} from '@/lib/piso/api'
import { calcularTurno } from '@/lib/rackly/turno'
import { dataClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { usePisoRealtime } from '@/hooks/usePisoRealtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { extractError } from '@/lib/utils'
import {
  Download, Loader2, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft,
  Layers3, BoxSelect, X, Plus, Trash2, RefreshCw, Package,
  RotateCcw, CalendarOff, Calendar, Warehouse, Sparkles, ChevronRight,
  Check, AlertTriangle, ToggleLeft, ToggleRight, Layers, ChevronDown,
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
type ActionMode = 'view' | 'ingreso' | 'salida' | 'traslado' | 'devolucion' | 'inc'

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
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null) // null = dashboard, 'A' = columna A
  const [colDetail, setColDetail] = useState<VistaPosicion[]>([]) // datos de la tabla
  const [colDetailLoading, setColDetailLoading] = useState(false)

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

  // INC state
  const [incCodigo, setIncCodigo] = useState('')
  const [incDescripcion, setIncDescripcion] = useState('')
  const [incUn, setIncUn] = useState('')
  const [incCantidad, setIncCantidad] = useState('')
  const [incCodigoInc, setIncCodigoInc] = useState('')
  const [incFechaVencimiento, setIncFechaVencimiento] = useState('')
  const [incSinVencimiento, setIncSinVencimiento] = useState(false)

  // Niveles de la posición seleccionada
  const [niveles, setNiveles] = useState<NivelInfo[]>([])
  const [selectedNivelId, setSelectedNivelId] = useState<string>('')
  // Traslado: nivel destino
  const [trDestNivelId, setTrDestNivelId] = useState<string>('')
  // Stock por nivel (para vista desglosada)
  const [stockByNivel, setStockByNivel] = useState<Record<string, DetailStock[]>>({})
  const [viewNivelTab, setViewNivelTab] = useState<string>('all') // 'all' o nivel_id
  // Salida: tab de nivel seleccionado
  const [salNivelTab, setSalNivelTab] = useState<string>('all')
  // Salida: items derivados con cantidades correctas por nivel seleccionado
  const [salItemsByNivel, setSalItemsByNivel] = useState<SalItem[]>([])

  // Salida en masa: selección múltiple
  const [massMode, setMassMode] = useState(false)
  const [massSelected, setMassSelected] = useState<Set<string>>(new Set())
  const [massDialogOpen, setMassDialogOpen] = useState(false)
  const [massBusy, setMassBusy] = useState(false)
  const [massConfirmOpen, setMassConfirmOpen] = useState(false)
  // Datos cargados para el dialog de salida en masa
  type MassPosData = {
    pos: PosicionConStock
    niveles: NivelInfo[]
    stockByNivel: Record<string, DetailStock[]>
    stock: DetailStock[]
    selectedNivelIds: Set<string> // empty = all levels
  }
  const [massData, setMassData] = useState<Map<string, MassPosData>>(new Map())

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
  const loadPosiciones = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
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
      if (mountedRef.current && !silent) toast.error('Error al cargar posiciones', { description: msg })
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
  useEffect(() => { if (sectorFilter !== 'all') { loadPosiciones(); setSelectedColumn(null); setColDetail([]) } }, [sectorFilter, loadPosiciones])

  // Cargar vista de columna cuando se selecciona una
  const loadColumnDetail = useCallback(async (letra: string) => {
    if (sectorFilter === 'all') return
    setColDetailLoading(true)
    try {
      const data = await cargarVistaColumna(sectorFilter, letra)
      if (mountedRef.current) setColDetail(data)
    } catch (err) {
      console.error('[Piso] Error cargando vista columna:', err)
      if (mountedRef.current) toast.error('Error al cargar columna')
    } finally {
      if (mountedRef.current) setColDetailLoading(false)
    }
  }, [sectorFilter])

  function handleSelectColumn(letra: string) {
    setSelectedColumn(letra)
    loadColumnDetail(letra)
  }

  // Realtime: auto-refresh positions when piso_movimientos changes (polling solo como respaldo si WebSocket cae)
  const silentRefreshPos = useCallback(() => {
    loadPosiciones(true)
    if (selectedColumn && sectorFilter !== 'all') {
      cargarVistaColumna(sectorFilter, selectedColumn).then(d => {
        if (mountedRef.current) setColDetail(d)
      }).catch(() => {})
    }
  }, [loadPosiciones, selectedColumn, sectorFilter])
  usePisoRealtime(silentRefreshPos)

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



  // Click posicion (nivelId opcional para seleccionar nivel especifico desde la tabla)
  async function handleClick(pos: PosicionConStock | null, nivelId?: string) {
    if (!pos) return
    try {
      const [stock, nivs] = await Promise.all([
        stockDetallePosicion(pos.posicionId),
        obtenerNivelesPosicion(pos.posicionId),
      ])
      // Cargar stock por nivel (en paralelo)
      const stockPerNivel: Record<string, DetailStock[]> = {}
      if (nivs.length > 0) {
        const nivelStocks = await Promise.all(
          nivs.map((n) => stockDetalleNivel(n.id))
        )
        nivs.forEach((n, i) => { stockPerNivel[n.id] = nivelStocks[i] })
      }
      if (mountedRef.current) {
        setDetail({ posicionId: pos.posicionId, posicionNumero: pos.posicionNumero, subcolumnaCodigo: pos.subcolumnaCodigo, columnaLetra: pos.columnaLetra, stock })
        setNiveles(nivs)
        setSelectedNivelId(nivelId || (nivs.length > 0 ? nivs[0].id : ''))
        setStockByNivel(stockPerNivel)
        setViewNivelTab('all')
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

  // selectedNivelId se usa directamente en doIngreso/doSalida/doTraslado/doDevolucion

  function openIngreso() {
    setIngRows([{ ...EMPTY_ROW }])
    // No resetear nivel — mantener el que el usuario seleccionó
    setMode('ingreso')
  }

  function openSalida() {
    // No resetear nivel — mantener el que el usuario seleccionó
    setSalNivelTab('all')
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
    setSalItemsByNivel([])
    setMode('salida')
  }

  function buildSalItemsForNivel(nivelId: string): SalItem[] {
    const nivelStock = stockByNivel[nivelId] ?? []
    return nivelStock.map((s) => ({
      bloque_id: s.bloque_id,
      bloque_codigo: s.bloque_codigo,
      bloque_descripcion: s.bloque_descripcion,
      bloque_unidad: s.bloque_unidad,
      cantidad: String(s.cantidad),
      stockActual: s.cantidad,
      fecha_vencimiento: s.fecha_vencimiento || '',
      selected: false,
    }))
  }

  function openTraslado() {
    setTrDestPos(null)
    setTrDestNivelId('')
    setTrConfirmOpen(false)
    setSelectedNivelId(niveles.length > 0 ? niveles[0].id : '')
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
    setSelectedNivelId(niveles.length > 0 ? niveles[0].id : '')
    setMode('devolucion')
  }

  function openInc() {
    setIncCodigo('')
    setIncDescripcion('')
    setIncUn('')
    setIncCantidad('')
    setIncCodigoInc('')
    setIncFechaVencimiento('')
    setIncSinVencimiento(false)
    setSelectedNivelId(niveles.length > 0 ? niveles[0].id : '')
    setMode('inc')
  }

  function handleIncCatalogoPick(bloque: BloqueOption) {
    justSelectedRef.current = true
    setIncCodigo(bloque.codigo)
    setIncDescripcion(bloque.descripcion)
    setIncUn(bloque.unidad)
  }

  function getFilteredIncCatalogo() {
    const q = incCodigo.trim().toLowerCase()
    if (!q) return bloquesCatalogo.slice(0, 50)
    return bloquesCatalogo.filter((b) =>
      b.codigo.toLowerCase().includes(q) || b.descripcion.toLowerCase().includes(q)
    )
  }

  async function doIngresoINC() {
    if (!detail || !perfil) return
    if (!incCodigo.trim() || !incCantidad || !incCodigoInc.trim()) {
      toast.error('Completa codigo, cantidad y codigo INC')
      return
    }
    const qty = parseFloat(incCantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad invalida'); return }
    if (!selectedNivelId) { toast.error('Selecciona un nivel primero'); return }
    const nivelId = selectedNivelId
    setBusy(true)
    try {
      // Resolve bloque_id
      const upper = incCodigo.trim().toUpperCase()
      let bloqueId = ''
      const existing = await buscarBloquePorCodigo(upper)
      if (existing) {
        bloqueId = existing.id
      } else {
        const created = await crearBloque(upper, incDescripcion || '', incUn || 'KG')
        if (created.length > 0) {
          const found = created.find((b) => b.codigo === upper)
          if (found) bloqueId = found.id
        }
      }
      if (!bloqueId) { toast.error('No se pudo crear/encontrar el articulo'); setBusy(false); return }

      // Registrar ingreso INC con detalles de stock (usando registrarIngresoPosicion)
      const detalles = [{
        nivel_id: nivelId,
        bloque_id: bloqueId,
        cantidad: qty,
        fecha_vencimiento: incSinVencimiento ? '' : incFechaVencimiento,
      }]
      await registrarIngresoPosicion(
        calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '',
        detalles,
        { posicion_id: detail.posicionId, codigo_inc: incCodigoInc.trim() }
      )

      toast.success('INC registrado')
      setMode('view')
      setIncCodigo('')
      setIncDescripcion('')
      setIncUn('')
      setIncCantidad('')
      setIncCodigoInc('')
      setIncFechaVencimiento('')
      setIncSinVencimiento(false)
      loadBloques()
      const [stock] = await Promise.all([stockDetallePosicion(detail.posicionId)])
      if (mountedRef.current && detail) {
        setDetail({ ...detail, stock })
      }
      await loadPosiciones()
      if (selectedColumn) loadColumnDetail(selectedColumn)
    } catch (err: unknown) {
      toast.error('Error al registrar INC', { description: extractError(err) })
    } finally {
      setBusy(false)
    }
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
    if (!selectedNivelId) { toast.error('No hay nivel seleccionado'); return }
    const nivelId = selectedNivelId
    const validRows = ingRows.filter((r) => r.bloque_id && r.cantidad)
    if (validRows.length === 0) { toast.error('Agrega al menos un articulo con codigo y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad invalida'); return }
    }
    setBusy(true)
    try {
      // Resolve manual_ IDs before registering
      const resolved = await ensureManualBloqueCreated(validRows)
      const detalles = resolved.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarIngresoPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Ingreso registrado')
      // Reload everything in parallel for real-time update
      loadBloques()
      const [stock] = await Promise.all([
        stockDetallePosicion(detail.posicionId),
      ])
      if (mountedRef.current && detail) {
        setDetail({ ...detail, stock })
        setMode('view')
        setIngRows([{ ...EMPTY_ROW }])
      }
      // Reload positions grid
      await loadPosiciones()
      if (selectedColumn) loadColumnDetail(selectedColumn)
    } catch (err: unknown) { toast.error('Error al registrar ingreso', { description: extractError(err) }) } finally { setBusy(false) }
  }

  async function doSalida() {
    if (!detail || !perfil) return
    // Filtrar items por nivel seleccionado
    const filteredItems = salNivelTab === 'all' ? salItems : salItemsByNivel
    const validRows = filteredItems.filter((r) => r.selected && r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para salir'); return }
    // Determinar nivel_id para la salida
    const nivelId = salNivelTab === 'all' ? selectedNivelId : salNivelTab
    if (!nivelId) { toast.error('No hay nivel seleccionado'); return }
    setBusy(true)
    try {
      const detalles = validRows.map((r) => ({ nivel_id: nivelId, bloque_id: r.bloque_id, cantidad: parseFloat(r.cantidad), fecha_vencimiento: r.fecha_vencimiento || null }))
      await registrarSalidaPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Salida registrada')
      // Recargar stock y stock por nivel
      const [stock] = await Promise.all([stockDetallePosicion(detail.posicionId)])
      // Recalcular stockByNivel
      if (niveles.length > 0) {
        const nivelStocks = await Promise.all(niveles.map((n) => stockDetalleNivel(n.id)))
        const newStockByNivel: Record<string, DetailStock[]> = {}
        niveles.forEach((n, i) => { newStockByNivel[n.id] = nivelStocks[i] })
        if (mountedRef.current) setStockByNivel(newStockByNivel)
      }
      if (mountedRef.current && detail) {
        setDetail({ ...detail, stock }); setMode('view')
      }
      await loadPosiciones()
      if (selectedColumn) loadColumnDetail(selectedColumn)
    } catch (err: unknown) { toast.error('Error al registrar salida', { description: extractError(err) }) } finally { setBusy(false) }
  }

  async function doTraslado() {
    if (!detail || !perfil || !trDestPos) return
    if (detail.posicionId === trDestPos.posicionId) { toast.error('Origen y destino no pueden ser iguales'); return }
    const validRows = trItems.filter((r) => r.selected && r.bloque_id && r.cantidad && parseFloat(r.cantidad) > 0)
    if (validRows.length === 0) { toast.error('No hay articulos para trasladar'); return }
    if (!selectedNivelId || !trDestNivelId) { toast.error('Selecciona nivel de origen y destino'); return }
    const origNivelId = selectedNivelId
    const destNivelId = trDestNivelId
    setBusy(true)
    try {

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
      if (mountedRef.current) { setDetail(null); setTrDestPos(null); loadPosiciones(); if (selectedColumn) loadColumnDetail(selectedColumn) }
    } catch (err: unknown) { toast.error('Error al trasladar', { description: extractError(err) }) } finally { setBusy(false) }
  }

  async function doDevolucion() {
    if (!detail || !perfil) return
    if (!selectedNivelId) { toast.error('No hay nivel seleccionado'); return }
    const nivelId = selectedNivelId
    const validRows = devRows.filter((r) => r.bloque_id && r.cantidad)
    if (validRows.length === 0) { toast.error('Agrega al menos un articulo con codigo y cantidad'); return }
    for (const r of validRows) {
      if (parseFloat(r.cantidad) <= 0 || isNaN(parseFloat(r.cantidad))) { toast.error('Cantidad invalida'); return }
    }
    setBusy(true)
    try {
      // Resolve manual_ IDs before registering
      const resolved = await ensureManualBloqueCreated(validRows)
      const detalles = resolved.map((r) => ({
        nivel_id: nivelId,
        bloque_id: r.bloque_id,
        cantidad: parseFloat(r.cantidad),
        fecha_vencimiento: r.sin_vencimiento ? '' : r.fecha_vencimiento,
      }))
      await registrarDevolucionPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success('Devolucion registrada')
      loadBloques()
      const [stock] = await Promise.all([stockDetallePosicion(detail.posicionId)])
      if (mountedRef.current && detail) {
        setDetail({ ...detail, stock }); setMode('view')
        setDevRows([{ ...EMPTY_ROW }])
      }
      await loadPosiciones()
      if (selectedColumn) loadColumnDetail(selectedColumn)
    } catch (err: unknown) { toast.error('Error al registrar devolución', { description: extractError(err) }) } finally { setBusy(false) }
  }

  // ═══ SALIDA EN MASA ═══
  function toggleMassSelect(posicionId: string) {
    setMassSelected((prev) => {
      const next = new Set(prev)
      if (next.has(posicionId)) next.delete(posicionId)
      else next.add(posicionId)
      return next
    })
  }

  function toggleMassMode() {
    setMassMode((prev) => !prev)
    if (massMode) { setMassSelected(new Set()) } // Al desactivar, limpiar selección
  }

  async function openMassDialog() {
    if (massSelected.size === 0 || !perfil) return
    setMassBusy(true)
    setMassDialogOpen(true)
    try {
      const selectedPositions = posiciones.filter((p) => massSelected.has(p.posicionId))
      const dataMap = new Map<string, MassPosData>()
      await Promise.all(selectedPositions.map(async (pos) => {
        try {
          const [stock, nivs] = await Promise.all([
            stockDetallePosicion(pos.posicionId),
            obtenerNivelesPosicion(pos.posicionId),
          ])
          const sBN: Record<string, DetailStock[]> = {}
          if (nivs.length > 0) {
            const nivelStocks = await Promise.all(nivs.map((n) => stockDetalleNivel(n.id)))
            nivs.forEach((n, i) => { sBN[n.id] = nivelStocks[i] })
          }
          dataMap.set(pos.posicionId, {
            pos,
            niveles: nivs,
            stockByNivel: sBN,
            stock,
            selectedNivelIds: new Set<string>(),
          })
        } catch { /* skip failed positions */ }
      }))
      if (mountedRef.current) setMassData(dataMap)
    } catch (err: unknown) {
      toast.error('Error al cargar datos', { description: err instanceof Error ? err.message : '' })
    } finally {
      if (mountedRef.current) setMassBusy(false)
    }
  }

  async function doMassSalida() {
    if (!perfil || massData.size === 0) return
    setMassBusy(true)
    let successCount = 0
    let errorCount = 0
    try {
      const entries = [...massData.entries()]
      await Promise.all(entries.map(async ([posicionId, pd]) => {
        try {
          // Si no hay niveles seleccionados, salir de todos los niveles
          const isAllLevels = pd.selectedNivelIds.size === 0
          const detalles: { nivel_id: string; bloque_id: string; cantidad: number; fecha_vencimiento: string | null }[] = []
          if (isAllLevels) {
            // Salir de todos los niveles: agrupar por nivel_id real
            for (const niv of pd.niveles) {
              const items = pd.stockByNivel[niv.id] ?? []
              for (const s of items) {
                detalles.push({ nivel_id: niv.id, bloque_id: s.bloque_id, cantidad: s.cantidad, fecha_vencimiento: s.fecha_vencimiento || null })
              }
            }
          } else {
            // Salir solo de los niveles seleccionados
            for (const nivelId of pd.selectedNivelIds) {
              const items = pd.stockByNivel[nivelId] ?? []
              for (const s of items) {
                detalles.push({ nivel_id: nivelId, bloque_id: s.bloque_id, cantidad: s.cantidad, fecha_vencimiento: s.fecha_vencimiento || null })
              }
            }
          }
          if (detalles.length === 0) { return }
          await registrarSalidaPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
          successCount++
        } catch { errorCount++ }
      }))
      if (successCount > 0) toast.success(`Salida registrada en ${successCount} posicion(es)`)
      if (errorCount > 0) toast.error(`${errorCount} posicion(es) con error`)
      setMassDialogOpen(false)
      setMassSelected(new Set())
      setMassMode(false)
      await loadPosiciones()
      if (selectedColumn) loadColumnDetail(selectedColumn)
    } catch (err: unknown) { toast.error('Error en salida masiva', { description: extractError(err) }) } finally { setMassBusy(false) }
  }

  // Toggle nivel seleccionado en salida en masa (empty = todos)
  function toggleMassNivel(posicionId: string, nivelId: string) {
    setMassData((prev) => {
      const next = new Map(prev)
      const d = next.get(posicionId)
      if (d) {
        const s = new Set(d.selectedNivelIds)
        if (s.has(nivelId)) s.delete(nivelId); else s.add(nivelId)
        next.set(posicionId, { ...d, selectedNivelIds: s })
      }
      return next
    })
  }

  // Obtener items a mostrar según niveles seleccionados (vacío = todos)
  function getMassDisplayItems(pd: MassPosData): DetailStock[] {
    if (pd.selectedNivelIds.size === 0) return pd.stock
    return pd.niveles
      .filter((n) => pd.selectedNivelIds.has(n.id))
      .flatMap((n) => pd.stockByNivel[n.id] ?? [])
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
    } catch (err: unknown) { toast.error('Error al exportar', { description: extractError(err) }) } finally { setBusyExport(false) }
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

  // ─── Nivel Selector sub-component ───
  function NivelSelector({
    label,
    nivelId,
    onNivelChange,
    nivelesList,
    accentColor,
  }: {
    label: string
    nivelId: string
    onNivelChange: (id: string) => void
    nivelesList: NivelInfo[]
    accentColor: 'emerald' | 'red' | 'sky' | 'amber'
  }) {
    if (nivelesList.length <= 1) return null // No mostrar si solo hay 1 nivel
    const colors = {
      emerald: 'border-emerald-500/40 text-emerald-400 focus:ring-emerald-500/30',
      red: 'border-red-500/40 text-red-400 focus:ring-red-500/30',
      sky: 'border-sky-500/40 text-sky-400 focus:ring-sky-500/30',
      amber: 'border-amber-500/40 text-amber-400 focus:ring-amber-500/30',
    }
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/50 px-3 py-2 backdrop-blur-sm">
        <Layers className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider shrink-0">{label}:</span>
        <select
          value={nivelId}
          onChange={(e) => onNivelChange(e.target.value)}
          className={`flex-1 bg-slate-900/80 border rounded-lg px-2.5 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 transition-all duration-200 appearance-none cursor-pointer ${colors[accentColor]}`}
        >
          {nivelesList.map((n) => (
            <option key={n.id} value={n.id}>
              Nivel {n.numero}{n.codigo_ubicacion ? ` (${n.codigo_ubicacion})` : ''}
            </option>
          ))}
        </select>
        <ChevronDown className="h-3 w-3 text-slate-500 -ml-1 shrink-0 pointer-events-none" />
      </div>
    )
  }

  // ═══════════════════════════════════════════════
  //  CELL STYLING — Clean 2D buttons
  // ═══════════════════════════════════════════════
  function getCellClasses(pos: PosicionConStock): string {
    const base = 'w-full h-11 px-1 rounded-lg transition-colors duration-150 cursor-pointer border text-center'
    if (pos.stock <= 0) {
      return `${base} bg-emerald-950/40 border-emerald-700/30 text-emerald-300 hover:bg-emerald-900/50 hover:border-emerald-500/40`
    }
    if (pos.bloques.length > 1) {
      return `${base} bg-amber-950/50 border-amber-700/40 text-amber-200 hover:bg-amber-900/50 hover:border-amber-500/40 ring-1 ring-amber-500/20`
    }
    return `${base} bg-sky-950/50 border-sky-700/30 text-sky-200 hover:bg-sky-900/50 hover:border-sky-500/40`
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

  const displayPos = posiciones

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
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">Sector:</span>
          {sectores.length <= 4 ? (
          <div className="relative flex gap-1 bg-slate-800/60 rounded-xl p-1 border border-slate-700/30 backdrop-blur-sm overflow-hidden">
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
                className={`relative z-10 flex-1 min-w-0 px-3 sm:px-4 py-2 rounded-lg text-xs font-bold transition-all duration-300 truncate ${sectorFilter === s.id
                  ? 'text-white'
                  : 'text-slate-400 hover:text-slate-300'
                  }`}>
                {s.nombre}
              </button>
            ))}
          </div>
          ) : (
          <div className="flex gap-1 overflow-x-auto max-w-[60vw] sm:max-w-none">
            {sectores.map((s) => (
              <button key={s.id} onClick={() => setSectorFilter(s.id)}
                className={`px-3 py-2 rounded-lg text-xs font-bold border transition-all duration-300 whitespace-nowrap shrink-0 ${sectorFilter === s.id
                  ? 'bg-gradient-to-r from-sky-400 to-cyan-500 text-white border-sky-400/50 shadow-lg shadow-sky-500/25'
                  : 'bg-slate-800/60 text-slate-400 border-slate-700/30 hover:text-slate-300 hover:border-slate-600'
                  }`}>
                {s.nombre}
              </button>
            ))}
          </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => loadPosiciones()} className="p-2 rounded-xl border border-slate-700/50 hover:bg-slate-700/80 transition-all duration-500 hover:-rotate-180 bg-slate-800/60 backdrop-blur-sm hover:shadow-lg"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /></button>
          {/* Salida en masa toggle */}
          <button
            onClick={toggleMassMode}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition-all duration-300 ${massMode
              ? 'bg-red-600/20 text-red-400 border-red-500/40 shadow-lg shadow-red-500/10'
              : 'bg-slate-800/60 text-slate-400 border-slate-700/30 hover:text-red-400 hover:border-red-500/30'
            }`}
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Salida en masa
            {massMode && <span className="ml-1 text-[9px] bg-red-500/30 text-red-300 px-1.5 py-0.5 rounded-md font-mono">{massSelected.size}</span>}
          </button>
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

      {/* ═══ COLUMN SELECTOR DASHBOARD ═══ */}
      {selectedColumn === null ? (
        <div className="space-y-4">
          {/* Sector title */}
          <div className="flex items-center gap-2.5 px-1">
            <Layers3 className="h-4 w-4 text-sky-400" />
            <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              {sectores.find(s => s.id === sectorFilter)?.nombre || 'Selecciona un sector'}
            </span>
            <span className="text-[10px] text-slate-500">— {columnas.length} columnas</span>
          </div>
          {/* Column selector — dark container with solid colored buttons */}
          <div className="rounded-2xl bg-slate-800 border border-slate-700/60 p-4">
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2.5">
              {columnas.map((col) => {
                const colOcc = col.subcols.reduce((s, sc) => s + sc.pos.filter(p => p.stock > 0).length, 0)
                const colTotal = col.subcols.reduce((s, sc) => s + sc.pos.length, 0)
                const isEmpty = colOcc === 0
                return (
                  <button
                    key={col.letra}
                    onClick={() => handleSelectColumn(col.letra)}
                    className={`relative rounded-xl h-12 flex items-center justify-center text-base font-extrabold text-white transition-all duration-200 hover:scale-105 hover:shadow-lg active:scale-95 ${
                      isEmpty
                        ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/40'
                        : 'bg-blue-600 hover:bg-blue-500 shadow-blue-900/40'
                    }`}
                  >
                    {col.letra}
                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full bg-slate-900 border border-slate-600 text-[9px] font-bold text-slate-300 flex items-center justify-center px-1">
                      {colOcc}/{colTotal}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        /* ═══ SINGLE COLUMN TABLE VIEW ═══ */
        <div className="space-y-4">
          {/* Back button + column title */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setSelectedColumn(null); setColDetail([]) }}
              className="p-2 rounded-xl bg-slate-800 border border-slate-700/60 hover:bg-slate-700 transition-all duration-300 text-slate-400 hover:text-white"
            >
              <ChevronDown className="h-4 w-4 rotate-90" />
            </button>
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center text-white font-extrabold text-sm shadow-lg ${
              colDetail.some(p => p.tieneInc) ? 'bg-rose-600 shadow-rose-900/40' : 'bg-blue-600 shadow-blue-900/40'
            }`}>
              {selectedColumn}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-bold text-slate-200">Columna {selectedColumn}</span>
              <span className="text-[10px] text-slate-500 ml-2">{colDetail.length} posiciones</span>
            </div>
          </div>

          {/* Table */}
          {colDetailLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
                <span className="text-xs text-slate-400">Cargando columna...</span>
              </div>
            </div>
          ) : colDetail.length === 0 ? (
            <div className="rounded-xl border border-slate-700/50 bg-slate-800/60 p-10 text-center">
              <p className="text-sm text-slate-400">No hay posiciones en esta columna</p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Agrupar por subcolumna */}
              {(() => {
                const subGroups = new Map<string, VistaPosicion[]>()
                for (const p of colDetail) {
                  const key = p.subcolumnaCodigo
                  if (!subGroups.has(key)) subGroups.set(key, [])
                  subGroups.get(key)!.push(p)
                }
                const sortedKeys = [...subGroups.keys()].sort()

                return sortedKeys.map((subCode) => {
                  const subPositions = subGroups.get(subCode)!
                  // Sort by position number
                  const sorted = [...subPositions].sort((a, b) => a.posicionNumero - b.posicionNumero)
                  // Find max number of levels across all positions
                  const maxNiveles = Math.max(...sorted.map(p => p.niveles.length), 1)

                  return (
                    <div key={subCode} className="space-y-2.5">
                      {/* Subcolumn header */}
                      <div className="flex items-center gap-2 px-1">
                        <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-blue-600 flex items-center justify-center text-white font-extrabold text-[9px] sm:text-[10px]">
                          {selectedColumn}
                        </div>
                        <span className="text-xs font-bold text-slate-200">{subCode}</span>
                        <span className="text-[10px] text-slate-500">{subPositions.length} pos</span>
                      </div>

                      {/* Tabla POS × Niveles con botones coloreados */}
                      <div className="rounded-xl bg-slate-800 border border-slate-700/50 overflow-hidden">
                        {/* Header row */}
                        <div className="flex">
                          <div className="w-11 sm:w-14 shrink-0 px-1 py-1.5 bg-slate-900/80 border-b border-r border-slate-700/50 flex items-center justify-center">
                            <span className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">POS</span>
                          </div>
                          <div className="flex-1 flex border-b border-slate-700/50">
                            {Array.from({ length: maxNiveles }, (_, i) => (
                              <div key={i} className="flex-1 px-0.5 sm:px-1 py-1.5 text-center border-r border-slate-700/30 last:border-r-0">
                                <span className="text-[9px] sm:text-[10px] font-bold text-slate-400">N{i + 1}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Position rows */}
                        <div className="divide-y divide-slate-700/30">
                          {sorted.map((pos) => {
                            const totalArticulos = pos.niveles.reduce((s, n) => s + n.bloques.length, 0)
                            const hasInc = pos.tieneInc

                            // Color for POS cell
                            let posColor = 'bg-emerald-600 hover:bg-emerald-500'
                            if (hasInc) posColor = 'bg-rose-600 hover:bg-rose-500'
                            else if (totalArticulos > 1) posColor = 'bg-orange-500 hover:bg-orange-400'
                            else if (totalArticulos === 1) posColor = 'bg-blue-600 hover:bg-blue-500'

                            const posData = posiciones.find(p => p.posicionId === pos.posicionId)

                            return (
                              <div key={pos.posicionId} className="flex">
                                {/* POS button */}
                                <div className="w-11 sm:w-14 shrink-0 p-0.5 border-r border-slate-700/30">
                                  <button
                                    onClick={() => posData ? handleClick(posData) : undefined}
                                    className={`${posColor} w-full h-9 sm:h-10 rounded-md flex flex-col items-center justify-center text-white transition-all duration-200 hover:scale-105 active:scale-95`}
                                    title={`Pos ${pos.posicionNumero} — ${totalArticulos} artículo(s)`}
                                  >
                                    <span className="text-[11px] sm:text-xs font-extrabold leading-none">P{pos.posicionNumero}</span>
                                    {totalArticulos > 0 && (
                                      <span className="text-[8px] font-bold mt-px opacity-90 leading-none">{totalArticulos}</span>
                                    )}
                                  </button>
                                </div>

                                {/* Level cells */}
                                <div className="flex-1 flex">
                                  {Array.from({ length: maxNiveles }, (_, i) => {
                                    const nivel = pos.niveles.find(n => n.nivelNumero === i + 1)
                                    const bloques = nivel?.bloques ?? []
                                    const count = bloques.length
                                    const nivelHasInc = bloques.some(b => b.codigo_inc)

                                    let cellColor = 'bg-slate-700/40 hover:bg-slate-700/60 text-slate-500' // empty
                                    if (nivelHasInc) cellColor = 'bg-rose-600/90 hover:bg-rose-500 text-white'
                                    else if (count > 1) cellColor = 'bg-orange-500/90 hover:bg-orange-400 text-white'
                                    else if (count === 1) cellColor = 'bg-blue-600/90 hover:bg-blue-500 text-white'

                                    return (
                                      <div key={i} className="flex-1 p-0.5 border-r border-slate-700/20 last:border-r-0">
                                        <button
                                          onClick={() => posData ? handleClick(posData, nivel?.nivelId) : undefined}
                                          className={`${cellColor} w-full h-9 sm:h-10 rounded-md flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95`}
                                          title={count > 0
                                            ? bloques.map(b => `${b.bloque_codigo} (${b.cantidad} ${b.bloque_unidad})${b.codigo_inc ? ' INC' : ''}`).join('\n')
                                            : 'Vacío'}
                                        >
                                          {count > 0 ? (
                                            <span className="text-[10px] sm:text-[11px] font-bold leading-none">{count}</span>
                                          ) : (
                                            <span className="text-[10px] font-bold opacity-30">—</span>
                                          )}
                                        </button>
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
                })
              })()}
              {/* Legend */}
              <div className="flex flex-wrap items-center gap-3 sm:gap-4 px-1 text-[10px] sm:text-[11px]">
                <div className="flex items-center gap-1.5">
                  <div className="w-3.5 h-3.5 rounded bg-emerald-600" />
                  <span className="text-slate-400">Vacío</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3.5 h-3.5 rounded bg-blue-600" />
                  <span className="text-slate-400">1 artículo</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3.5 h-3.5 rounded bg-orange-500" />
                  <span className="text-slate-400">2+ artículos</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3.5 h-3.5 rounded bg-rose-600" />
                  <span className="text-slate-400">INC</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ MASS SALIDA FLOATING BAR ═══ */}
      {massMode && massSelected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 sm:gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-2xl bg-slate-900/95 border border-red-500/40 shadow-2xl shadow-red-500/20 backdrop-blur-xl animate-[scale-in_0.2s_ease-out] max-w-[calc(100vw-1.5rem)]" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom, 0.625rem))' }}>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-xl bg-red-500/20 flex items-center justify-center">
              <span className="font-extrabold text-red-400 text-xs sm:text-sm">{massSelected.size}</span>
            </div>
            <span className="text-[10px] sm:text-xs font-bold text-slate-300 hidden sm:inline">posicion(es) seleccionada(s)</span>
          </div>
          <Button
            onClick={openMassDialog}
            disabled={massSelected.size === 0}
            size="sm"
            className="gap-1 sm:gap-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] sm:text-xs rounded-xl shadow-lg shadow-red-500/30 transition-all duration-300 hover:scale-[1.03] shrink-0"
          >
            <ArrowUpFromLine className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> <span className="hidden xs:inline">Procesar</span> salida
          </Button>
        </div>
      )}

      {/* Banner modo masa activo */}
      {massMode && massSelected.size === 0 && (
        <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-red-950/20 border border-red-500/20">
          <span className="text-xs text-red-400 font-semibold">Modo salida en masa activado — toca las posiciones que quieres seleccionar</span>
          <button onClick={toggleMassMode} className="text-[10px] text-slate-400 hover:text-slate-300 underline">Cancelar</button>
        </div>
      )}

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
          className="max-w-[calc(100vw-1rem)] sm:max-w-xl rounded-2xl max-h-[85vh] flex flex-col overflow-hidden overscroll-contain p-0 border-0 shadow-2xl [&>button]:text-slate-400 hover:[&>button]:text-white [&>button]:opacity-70 hover:[&>button]:opacity-100"
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

          <div className="p-4 sm:p-6 relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
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
                  <span className="text-slate-500 text-[10px]">({niveles.length} nivel{niveles.length !== 1 ? 'es' : ''})</span>
                </nav>
                {/* Animated type badge */}
                {(!mode || mode === 'view') ? null : (
                  <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border animate-[scale-in_0.2s_ease-out] ${
                    mode === 'ingreso' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 shadow-sm shadow-emerald-500/10' :
                    mode === 'salida' ? 'bg-red-500/15 text-red-400 border-red-500/30 shadow-sm shadow-red-500/10' :
                    mode === 'traslado' ? 'bg-sky-500/15 text-sky-400 border-sky-500/30 shadow-sm shadow-sky-500/10' :
                    mode === 'inc' ? 'bg-rose-500/15 text-rose-400 border-rose-500/30 shadow-sm shadow-rose-500/10' :
                    'bg-amber-500/15 text-amber-400 border-amber-500/30 shadow-sm shadow-amber-500/10'
                  }`}>
                    {mode === 'ingreso' ? '↓ Ingreso' : mode === 'salida' ? '↑ Salida' : mode === 'traslado' ? '⇄ Traslado' : mode === 'inc' ? '⚠ INC' : '↺ Devolucion'}
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>

            {detail && (<>
              {/* ── VIEW MODE ── */}
              {mode === 'view' && (() => {
                const displayStock = viewNivelTab === 'all'
                  ? detail.stock
                  : (stockByNivel[viewNivelTab] ?? [])
                const selectedNivelLabel = niveles.find((n) => n.id === viewNivelTab)
                return displayStock.length > 0 ? (
                  <div className="space-y-2.5 mt-4">
                    {/* Level tabs — only show if position has multiple levels */}
                    {niveles.length > 1 && (
                      <div className="flex items-center gap-1.5 overflow-x-auto bg-slate-800/60 rounded-xl p-1 border border-slate-700/30 backdrop-blur-sm scrollbar-none">
                        <button
                          onClick={() => setViewNivelTab('all')}
                          className={`relative z-10 shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-300 ${
                            viewNivelTab === 'all'
                              ? 'bg-gradient-to-r from-sky-400 to-cyan-500 text-white shadow-lg shadow-sky-500/25'
                              : 'text-slate-400 hover:text-slate-300'
                          }`}
                        >
                          Todos ({detail.stock.length})
                        </button>
                        {niveles.map((n) => {
                          const count = (stockByNivel[n.id] ?? []).length
                          return (
                            <button
                              key={n.id}
                              onClick={() => setViewNivelTab(n.id)}
                              className={`relative z-10 shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-300 ${
                                viewNivelTab === n.id
                                  ? 'bg-gradient-to-r from-sky-400 to-cyan-500 text-white shadow-lg shadow-sky-500/25'
                                  : 'text-slate-400 hover:text-slate-300'
                              }`}
                            >
                              Nivel {n.numero} ({count})
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {/* Level label when viewing a specific level */}
                    {viewNivelTab !== 'all' && selectedNivelLabel && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-950/30 border border-sky-500/20">
                        <Layers className="h-3.5 w-3.5 text-sky-400" />
                        <span className="text-[10px] font-bold text-sky-300">
                          Nivel {selectedNivelLabel.numero}{selectedNivelLabel.codigo_ubicacion ? ` — ${selectedNivelLabel.codigo_ubicacion}` : ''}
                        </span>
                        <span className="text-[9px] text-slate-500">· {(stockByNivel[viewNivelTab] ?? []).reduce((s, it) => s + it.cantidad, 0).toFixed(2)} total</span>
                      </div>
                    )}
                    {displayStock.map((s, idx) => (
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
                      <Button onClick={openInc} size="sm" className="gap-1.5 col-span-2 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs rounded-xl shadow-lg shadow-rose-500/15 transition-all duration-300 hover:shadow-rose-500/25 hover:scale-[1.02]"><AlertTriangle className="h-3.5 w-3.5" /> INC — Insumo No Conforme</Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 py-6 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700/30 flex items-center justify-center mx-auto animate-pulse">
                      <BoxSelect className="h-8 w-8 text-slate-600" />
                    </div>
                    <div>
                      <p className="text-slate-400 font-semibold">{viewNivelTab !== 'all' ? 'Nivel sin articulos' : 'Posicion vacia'}</p>
                      <p className="text-xs text-slate-500 mt-1">{viewNivelTab !== 'all' ? 'Este nivel no tiene articulos registrados' : 'Esta posicion no tiene articulos registrados'}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
                      <Button onClick={openIngreso} size="sm" className="gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/15 transition-all duration-300 hover:scale-[1.02]"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                      <Button onClick={openDevolucion} size="sm" className="gap-1.5 bg-amber-600/90 hover:bg-amber-600 text-white text-xs rounded-xl shadow-lg shadow-amber-500/15 transition-all duration-300 hover:scale-[1.02]"><RotateCcw className="h-3.5 w-3.5" /> Devolucion</Button>
                      <Button onClick={openInc} size="sm" className="gap-1.5 col-span-2 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs rounded-xl shadow-lg shadow-rose-500/15 transition-all duration-300 hover:shadow-rose-500/25 hover:scale-[1.02]"><AlertTriangle className="h-3.5 w-3.5" /> INC — Insumo No Conforme</Button>
                    </div>
                  </div>
                )
              })()}

              {/* ── INGRESO MODE ── */}
              {mode === 'ingreso' && (
                <div className="space-y-4 mt-4">
                  <NivelSelector
                    label="Nivel destino"
                    nivelId={selectedNivelId}
                    onNivelChange={setSelectedNivelId}
                    nivelesList={niveles}
                    accentColor="emerald"
                  />
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
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('ing', i, e.target.value)} onBlur={() => setTimeout(() => handleCodeBlur('ing', i), 150)} placeholder="Buscar codigo o descripcion..."
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all duration-300 backdrop-blur-sm ${row.bloque_id ? 'border-emerald-500/40 ring-emerald-500/20 shadow-sm shadow-emerald-500/10' : 'border-slate-700/50 focus:ring-emerald-500/40'}`} autoFocus />
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
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doIngreso} disabled={busy} size="sm" className="h-11 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition-all duration-300 hover:shadow-emerald-500/30 hover:scale-[1.02]">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />} Registrar ingreso</Button>
                  </div>
                </div>
              )}

              {/* ── SALIDA MODE ── */}
              {mode === 'salida' && (() => {
                // Items para salida: originales (Todos) o derivados por nivel
                const filteredSalItems = salNivelTab === 'all' ? salItems : salItemsByNivel
                const isSalLevelView = salNivelTab !== 'all'
                const selCount = filteredSalItems.filter((r) => r.selected).length
                return (
                <div className="space-y-3 mt-4">
                  {/* Nivel tabs para salida */}
                  {niveles.length > 1 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto bg-slate-800/60 rounded-xl p-1 border border-slate-700/30 backdrop-blur-sm scrollbar-none">
                      <button
                        onClick={() => { setSalNivelTab('all'); setSalItems((prev) => prev.map((r) => ({ ...r, selected: false }))); setSalItemsByNivel([]) }}
                        className={`relative z-10 shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-300 ${
                          salNivelTab === 'all'
                            ? 'bg-gradient-to-r from-red-400 to-rose-500 text-white shadow-lg shadow-red-500/25'
                            : 'text-slate-400 hover:text-slate-300'
                        }`}
                      >
                        Todos ({salItems.length})
                      </button>
                      {niveles.map((n) => {
                        const nCount = (stockByNivel[n.id] ?? []).length
                        return (
                          <button
                            key={n.id}
                            onClick={() => { setSalNivelTab(n.id); setSalItemsByNivel(buildSalItemsForNivel(n.id)) }}
                            className={`relative z-10 shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-300 ${
                              salNivelTab === n.id
                                ? 'bg-gradient-to-r from-red-400 to-rose-500 text-white shadow-lg shadow-red-500/25'
                                : 'text-slate-400 hover:text-slate-300'
                            }`}
                          >
                            Nivel {n.numero} ({nCount})
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {salNivelTab !== 'all' && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-950/30 border border-red-500/20">
                      <Layers className="h-3.5 w-3.5 text-red-400" />
                      <span className="text-[10px] font-bold text-red-300">
                        Salida de Nivel {niveles.find((n) => n.id === salNivelTab)?.numero ?? '?'}
                        {niveles.find((n) => n.id === salNivelTab)?.codigo_ubicacion ? ` — ${niveles.find((n) => n.id === salNivelTab)?.codigo_ubicacion}` : ''}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-slate-300">Toca los articulos que quieres salir:</p>
                    {filteredSalItems.length > 1 && (
                      <button
                        onClick={() => {
                          const allSel = filteredSalItems.every((r) => r.selected)
                          const updated = filteredSalItems.map((r) => ({ ...r, selected: !allSel, cantidad: !allSel ? String(r.stockActual) : r.cantidad }))
                          if (isSalLevelView) setSalItemsByNivel(updated); else setSalItems(updated)
                        }}
                        className="flex items-center gap-1 text-[10px] font-semibold text-red-400 hover:text-red-300 transition-all duration-300"
                      >
                        {selCount === filteredSalItems.length && filteredSalItems.length > 0 ? (
                          <><X className="h-3 w-3" /> Deseleccionar todos</>
                        ) : (
                          <><Check className="h-3 w-3" /> Seleccionar todos</>
                        )}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 -mt-2">{selCount} de {filteredSalItems.length} seleccionados</p>
                  {filteredSalItems.map((row, i) => {
                    return (
                    <div key={`${row.bloque_id}-${row.fecha_vencimiento}-${i}`}
                      onClick={() => {
                        const u = [...filteredSalItems]
                        const newSelected = !u[i].selected
                        u[i] = { ...u[i], selected: newSelected, cantidad: newSelected ? String(u[i].stockActual) : u[i].cantidad }
                        if (isSalLevelView) setSalItemsByNivel(u); else setSalItems(u)
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
                              const u = [...filteredSalItems]
                              u[i] = { ...u[i], cantidad: e.target.value }
                              if (isSalLevelView) setSalItemsByNivel(u); else setSalItems(u)
                            }}
                            className="w-16 sm:w-20 h-9 text-xs bg-slate-900/80 border-red-500/30 text-white focus:ring-red-500/40 rounded-xl backdrop-blur-sm transition-all duration-300" />
                        )}
                      </div>
                    </div>
                    )
                  })}
                  {filteredSalItems.length === 0 && (
                    <div className="py-6 text-center">
                      <p className="text-slate-500 text-xs">No hay articulos en este nivel</p>
                    </div>
                  )}
                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doSalida} disabled={busy || selCount === 0} size="sm" className="h-11 gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded-xl shadow-lg shadow-red-500/20 transition-all duration-300 hover:shadow-red-500/30 hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />} Registrar salida</Button>
                  </div>
                </div>
                )
              })()}

              {/* ── TRASLADO MODE ── */}
              {mode === 'traslado' && (
                <div className="space-y-3 mt-4">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <NivelSelector
                        label="Nivel origen"
                        nivelId={selectedNivelId}
                        onNivelChange={setSelectedNivelId}
                        nivelesList={niveles}
                        accentColor="sky"
                      />
                    </div>
                    {trDestPos && (
                      <div className="flex-1">
                        <NivelSelector
                          label="Nivel destino"
                          nivelId={trDestNivelId}
                          onNivelChange={setTrDestNivelId}
                          nivelesList={niveles}
                          accentColor="sky"
                        />
                      </div>
                    )}
                  </div>
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
                                  className="w-20 sm:w-24 h-8 text-xs bg-slate-900/80 border-sky-500/30 text-white focus:ring-sky-500/40 rounded-lg backdrop-blur-sm transition-all duration-300"
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
                        <button key={p.posicionId} onClick={async () => {
                          setTrDestPos(p)
                          // Cargar niveles del destino
                          try {
                            const destNivs = await obtenerNivelesPosicion(p.posicionId)
                            setTrDestNivelId(destNivs.length > 0 ? destNivs[0].id : '')
                          } catch { /* ok */ }
                        }}
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
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={() => setTrConfirmOpen(true)} disabled={busy || !trDestPos || trItems.filter((r) => r.selected && r.cantidad && parseFloat(r.cantidad) > 0).length === 0} size="sm" className="h-11 gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-xl shadow-lg shadow-sky-500/20 transition-all duration-300 hover:shadow-sky-500/30 hover:scale-[1.02]">
                      <ArrowRightLeft className="h-3.5 w-3.5" /> Confirmar traslado
                    </Button>
                  </div>
                </div>
              )}

              {/* ── DEVOLUCION MODE ── */}
              {mode === 'devolucion' && (
                <div className="space-y-4 mt-4">
                  <NivelSelector
                    label="Nivel destino"
                    nivelId={selectedNivelId}
                    onNivelChange={setSelectedNivelId}
                    nivelesList={niveles}
                    accentColor="amber"
                  />
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
                            <input type="text" value={row.codigo} onChange={(e) => handleCodeInput('dev', i, e.target.value)} onBlur={() => setTimeout(() => handleCodeBlur('dev', i), 150)} placeholder="Buscar codigo o descripcion..."
                              className={`w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 transition-all duration-300 backdrop-blur-sm ${row.bloque_id ? 'border-amber-500/40 ring-amber-500/20 shadow-sm shadow-amber-500/10' : 'border-slate-700/50 focus:ring-amber-500/40'}`} autoFocus />
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
                    <Button onClick={() => setMode('view')} variant="outline" size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl bg-slate-800/40 transition-all duration-300">Cancelar</Button>
                    <Button onClick={doDevolucion} disabled={busy} size="sm" className="h-11 gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all duration-300 hover:shadow-amber-500/30 hover:scale-[1.02]">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Registrar devolucion</Button>
                  </div>
                </div>
              )}

              {/* ── INC MODE ── */}
              {mode === 'inc' && (
                <div className="space-y-4 mt-4">
                  <div className="rounded-xl border border-rose-500/25 bg-rose-950/10 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                      <div>
                        <p className="text-xs font-bold text-rose-400">Registro INC — Insumo No Conforme</p>
                        <p className="text-[10px] text-slate-400">Producto que no cumple con especificaciones de calidad</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">Posicion: <span className="text-sky-300 font-mono">{detail?.columnaLetra} / {detail?.subcolumnaCodigo} / Pos {detail?.posicionNumero}</span></p>

                  <NivelSelector
                    label="Nivel destino"
                    nivelId={selectedNivelId}
                    onNivelChange={setSelectedNivelId}
                    nivelesList={niveles}
                    accentColor="red"
                  />

                  {/* Codigo */}
                  <div className="rounded-xl border border-rose-500/15 bg-slate-800/40 backdrop-blur-sm p-4 space-y-3 border-l-2 border-l-rose-500/40">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-12 sm:col-span-4">
                        <Label className="text-[10px] text-rose-400 font-semibold">Codigo *</Label>
                        <div className="relative">
                          <input
                            type="text"
                            value={incCodigo}
                            onChange={(e) => setIncCodigo(e.target.value)}
                            onBlur={() => setTimeout(async () => {
                              if (justSelectedRef.current) { justSelectedRef.current = false; return }
                              if (!incCodigo.trim() || incDescripcion) return
                              const upper = incCodigo.trim().toUpperCase()
                              const bloque = await buscarBloquePorCodigo(upper)
                              if (bloque) {
                                setIncDescripcion(bloque.descripcion)
                                setIncUn(bloque.unidad)
                              }
                            }, 150)}
                            placeholder="Buscar codigo..."
                            className="w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 border-slate-700/50 focus:ring-rose-500/40 backdrop-blur-sm transition-all duration-300"
                          />
                          {/* Autocomplete dropdown for INC */}
                          {!incDescripcion && incCodigo.trim().length > 0 && (
                            <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-700/80 bg-slate-900/95 backdrop-blur-sm shadow-2xl shadow-black/40">
                              {getFilteredIncCatalogo().slice(0, 10).map((b) => (
                                <button
                                  key={b.id}
                                  onClick={() => handleIncCatalogoPick(b)}
                                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-700/80 text-slate-300 border-b border-slate-800/50 last:border-0 transition-all duration-200"
                                >
                                  <span className="font-mono text-rose-400">{b.codigo}</span>
                                  <span className="text-slate-500 ml-1.5">— {b.descripcion || b.unidad}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="col-span-6 sm:col-span-4">
                        <Label className="text-[10px] text-slate-500">Descripcion</Label>
                        <input type="text" value={incDescripcion} readOnly placeholder="Auto o manual"
                          className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm transition-all duration-300" />
                      </div>
                      <div className="col-span-6 sm:col-span-4">
                        <Label className="text-[10px] text-slate-500">UN</Label>
                        <input type="text" value={incUn} readOnly placeholder="Auto o manual"
                          className="w-full h-10 rounded-xl border border-slate-700/40 text-xs bg-slate-800/60 text-slate-400 px-3 cursor-default backdrop-blur-sm transition-all duration-300" />
                      </div>
                    </div>

                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-6 sm:col-span-4">
                        <Label className="text-[10px] text-rose-400 font-semibold">Cantidad *</Label>
                        <input type="number" step="any" min="0.001" value={incCantidad} onChange={(e) => setIncCantidad(e.target.value)} placeholder="0"
                          className="w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-white placeholder-slate-600 px-3 font-mono focus:outline-none focus:ring-2 border-rose-500/40 focus:ring-rose-500/40 backdrop-blur-sm transition-all duration-300" />
                      </div>
                      <div className="col-span-6 sm:col-span-4">
                        <Label className="text-[10px] text-rose-400 font-semibold">Codigo INC *</Label>
                        <input type="text" value={incCodigoInc} onChange={(e) => setIncCodigoInc(e.target.value)} placeholder="Ej: INC026-120"
                          className="w-full h-10 rounded-xl border text-xs bg-slate-900/80 text-rose-300 placeholder:text-rose-500/40 px-3 font-mono focus:outline-none focus:ring-2 border-rose-500/40 focus:ring-rose-500/40 backdrop-blur-sm transition-all duration-300" />
                      </div>
                      <div className="col-span-12 sm:col-span-4">
                        <FechaVencimientoField
                          prefix="ing"
                          idx={0}
                          row={{ ...EMPTY_ROW, fecha_vencimiento: incFechaVencimiento, sin_vencimiento: incSinVencimiento }}
                          onFechaChange={(_, val) => setIncFechaVencimiento(val)}
                          onToggleSin={() => setIncSinVencimiento(!incSinVencimiento)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button onClick={() => setMode('view')} className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl text-xs font-bold border border-slate-700/50 text-slate-400 hover:bg-slate-700/40 hover:text-slate-200 transition-all duration-300">← Cancelar</button>
                    <Button onClick={() => doIngresoINC()} disabled={busy} className="flex-1 gap-1.5 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs rounded-xl shadow-lg shadow-rose-500/15 transition-all duration-300">
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                      Registrar INC
                    </Button>
                  </div>
                </div>
              )}
            </>)}
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ TRASLADO CONFIRMATION DIALOG ═══ */}
      <Dialog open={trConfirmOpen} onOpenChange={(open) => { if (!open) setTrConfirmOpen(false) }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] max-h-[85vh] flex flex-col overflow-hidden overscroll-contain bg-slate-900 border-slate-700/50 backdrop-blur-xl rounded-2xl p-0 [&>button]:text-slate-400 hover:[&>button]:text-white [&>button]:opacity-70 hover:[&>button]:opacity-100">
          <DialogHeader className="px-4 sm:px-6 pt-5 shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ArrowRightLeft className="h-5 w-5 text-sky-400" />
              Confirmar Traslado
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              Resumen de articulos a trasladar con ajustes.
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 sm:px-6 space-y-2 flex-1 min-h-0 overflow-y-auto pr-1">
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Package className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />
                        <span className="font-mono text-xs text-sky-300 font-semibold truncate">{r.bloque_codigo}</span>
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] font-semibold shrink-0 ${statusColor}`}>
                        {statusIcon}
                        <span className="truncate max-w-[140px]">{statusLabel}</span>
                      </div>
                    </div>
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-0 mt-1 text-[10px] text-slate-500 pl-5">
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
            <div className="px-4 sm:px-6 flex items-center gap-2 text-xs bg-slate-800/60 rounded-lg border border-slate-700/40 px-3 py-2">
              <Warehouse className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-slate-500">Destino:</span>
              <span className="font-mono font-semibold text-sky-300">
                {trDestPos.columnaLetra}-{trDestPos.subcolumnaCodigo}-{trDestPos.posicionNumero}
              </span>
            </div>
          )}

          <DialogFooter className="px-4 sm:px-6 pb-5 gap-2 sm:gap-0 shrink-0">
            <Button variant="outline" onClick={() => setTrConfirmOpen(false)} size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl">
              Cancelar
            </Button>
            <Button onClick={doTraslado} disabled={busy} size="sm" className="h-11 gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-xl shadow-lg shadow-sky-500/20">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Ejecutar traslado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ MASS SALIDA DIALOG ═══ */}
      <Dialog open={massDialogOpen} onOpenChange={(open) => { if (!open) setMassDialogOpen(false) }}>
        <DialogContent className="sm:max-w-2xl max-w-[calc(100vw-1rem)] rounded-2xl max-h-[85vh] flex flex-col overflow-hidden overscroll-contain p-0 border-0 shadow-2xl [&>button]:text-slate-400 hover:[&>button]:text-white [&>button]:opacity-70 hover:[&>button]:opacity-100"
          style={{ background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.9))', backdropFilter: 'blur(24px)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-red-400 to-transparent opacity-60" />
          <div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 text-base text-white">
                <div className="w-8 h-8 rounded-xl bg-red-600/20 flex items-center justify-center">
                  <ArrowUpFromLine className="h-4 w-4 text-red-400" />
                </div>
                <span className="text-white">Salida en Masa — {massData.size} posicion(es)</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Se registrara salida de TODO el stock de cada articulo en el nivel seleccionado. Revisa las posiciones antes de confirmar.
              </DialogDescription>
            </DialogHeader>

            {massBusy && massData.size === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-red-400" />
                <span className="ml-3 text-slate-400 text-sm">Cargando datos de posiciones...</span>
              </div>
            ) : (
              <div className="space-y-3 mt-4">
                {[...massData.entries()].map(([posicionId, pd]) => {
                  const displayItems = getMassDisplayItems(pd)
                  const totalQty = displayItems.reduce((s, it) => s + it.cantidad, 0)
                  const isAll = pd.selectedNivelIds.size === 0
                  return (
                    <div key={posicionId} className="rounded-xl border border-slate-700/40 bg-slate-800/40 backdrop-blur-sm p-3.5">
                      {/* Position header + nivel selector */}
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-7 h-7 rounded-lg bg-sky-600/20 flex items-center justify-center text-sky-300 font-extrabold text-[10px] border border-sky-500/20">
                          {pd.pos.columnaLetra}
                        </div>
                        <span className="font-mono text-xs font-bold text-slate-200">
                          {pd.pos.columnaLetra}-{pd.pos.subcolumnaCodigo}-{pd.pos.posicionNumero}
                        </span>
                        <span className="text-[10px] text-slate-500 ml-auto">{displayItems.length} art. · {totalQty.toFixed(2)} total</span>
                      </div>
                      {/* Nivel toggle buttons si tiene multiples niveles */}
                      {pd.niveles.length > 1 && (
                        <div className="mb-2">
                          <div className="flex items-center gap-1.5 overflow-x-auto bg-slate-900/60 rounded-lg p-0.5 border border-slate-700/30 scrollbar-none">
                            {pd.niveles.map((n) => {
                              const nItems = (pd.stockByNivel[n.id] ?? []).length
                              const isSelected = pd.selectedNivelIds.has(n.id)
                              return (
                                <button
                                  key={n.id}
                                  onClick={() => toggleMassNivel(posicionId, n.id)}
                                  className={`flex-1 px-2.5 py-1 rounded-md text-[9px] font-bold transition-all duration-200 ${
                                    isSelected
                                      ? 'bg-red-500/30 text-red-300 border border-red-500/30'
                                      : 'text-slate-500 hover:text-slate-300 border border-transparent'
                                  }`}
                                >
                                  Nivel {n.numero} ({nItems})
                                </button>
                              )
                            })}
                          </div>
                          {isAll && (
                            <p className="text-[9px] text-emerald-400/70 text-center mt-1">Salida total de todos los niveles</p>
                          )}
                          {!isAll && (
                            <p className="text-[9px] text-amber-400/70 text-center mt-1">Salida solo de los niveles seleccionados</p>
                          )}
                        </div>
                      )}
                      {/* Items list */}
                      <div className="space-y-1">
                        {displayItems.map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-900/40 text-[10px]">
                            <div className="flex items-center gap-2 min-w-0">
                              <Package className="h-3 w-3 text-slate-500 shrink-0" />
                              <span className="font-mono text-sky-300 font-semibold">{item.bloque_codigo}</span>
                              <span className="text-slate-500 truncate">{item.bloque_descripcion || ''}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-bold text-red-300">{item.cantidad}</span>
                              <span className="text-slate-500">{item.bloque_unidad}</span>
                            </div>
                          </div>
                        ))}
                        {displayItems.length === 0 && (
                          <p className="text-slate-500 text-[10px] text-center py-2">Sin articulos en este nivel</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0 mt-4 pt-3 border-t border-slate-700/30 shrink-0">
              <Button variant="outline" onClick={() => setMassDialogOpen(false)} size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl">
                Cancelar
              </Button>
              <Button onClick={() => setMassConfirmOpen(true)} disabled={massBusy || massData.size === 0} size="sm" className="h-11 gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded-xl shadow-lg shadow-red-500/20">
                {massBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                Registrar {massData.size} salida(s)
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ MASS SALIDA CONFIRMATION DIALOG ═══ */}
      <Dialog open={massConfirmOpen} onOpenChange={(open) => { if (!open) setMassConfirmOpen(false) }}>
        <DialogContent className="sm:max-w-2xl max-w-[calc(100vw-1rem)] rounded-2xl max-h-[85vh] flex flex-col overflow-hidden overscroll-contain p-0 border-0 shadow-2xl [&>button]:text-slate-400 hover:[&>button]:text-white [&>button]:opacity-70 hover:[&>button]:opacity-100"
          style={{ background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.97), rgba(30, 41, 59, 0.95))', backdropFilter: 'blur(24px)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent opacity-60" />
          <div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 text-base text-white">
                <div className="w-8 h-8 rounded-xl bg-amber-600/20 flex items-center justify-center">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                </div>
                <span className="text-white">Confirmar Salida en Masa</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                Revisa el resumen de articulos y cantidades antes de confirmar la salida.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 mt-4">
              {/* Calcular totales generales */}
              {(() => {
                let totalArticulos = 0
                let totalUnidades = 0
                const entries = [...massData.entries()]
                return entries.map(([posicionId, pd]) => {
                  const displayItems = getMassDisplayItems(pd)
                  const qtySum = displayItems.reduce((s, it) => s + it.cantidad, 0)
                  totalArticulos += displayItems.length
                  totalUnidades += qtySum
                  const isAll = pd.selectedNivelIds.size === 0
                  const nivelNums = pd.niveles
                    .filter((n) => isAll || pd.selectedNivelIds.has(n.id))
                    .map((n) => n.numero)
                  return (
                    <div key={posicionId} className="rounded-xl border border-slate-700/40 bg-slate-800/50 backdrop-blur-sm overflow-hidden">
                      {/* Header de posicion */}
                      <div className="flex items-center gap-2 px-3.5 py-2.5 bg-slate-700/30 border-b border-slate-700/30">
                        <div className="w-6 h-6 rounded-lg bg-sky-600/20 flex items-center justify-center text-sky-300 font-extrabold text-[9px] border border-sky-500/20">
                          {pd.pos.columnaLetra}
                        </div>
                        <span className="font-mono text-xs font-bold text-slate-200">
                          {pd.pos.columnaLetra}-{pd.pos.subcolumnaCodigo}-{pd.pos.posicionNumero}
                        </span>
                        {isAll ? (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 font-bold">
                            Todos los niveles
                          </span>
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/20 font-bold truncate max-w-[100px]">
                            Nivel {nivelNums.join(', ')}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] font-semibold text-slate-400">
                          {displayItems.length} art. · {qtySum.toFixed(2)} {displayItems.length > 0 ? (displayItems[0].bloque_unidad || 'un') : ''}
                        </span>
                      </div>
                      {/* Lista de articulos */}
                      <div className="divide-y divide-slate-700/20">
                        {displayItems.map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between px-3.5 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <ArrowUpFromLine className="h-3 w-3 text-red-400/60 shrink-0" />
                              <span className="font-mono text-sky-300 text-[11px] font-semibold">{item.bloque_codigo}</span>
                              <span className="text-slate-500 text-[10px] truncate">{item.bloque_descripcion || ''}</span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="font-bold text-red-300 text-[11px]">{item.cantidad}</span>
                              <span className="text-slate-500 text-[10px]">{item.bloque_unidad}</span>
                            </div>
                          </div>
                        ))}
                        {displayItems.length === 0 && (
                          <p className="text-slate-500 text-[10px] text-center py-2">Sin articulos</p>
                        )}
                      </div>
                    </div>
                  )
                }).concat([
                  // Resumen total al final
                  <div key="__totals__" className="rounded-xl border border-amber-500/30 bg-amber-950/20 backdrop-blur-sm p-3.5 mt-1">
                    <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-amber-400" />
                        <span className="text-[10px] text-amber-300 font-medium">Total articulos:</span>
                        <span className="text-sm font-extrabold text-amber-200">{totalArticulos}</span>
                      </div>
                      <div className="w-px h-5 bg-amber-500/30" />
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-amber-400" />
                        <span className="text-[10px] text-amber-300 font-medium">Total unidades:</span>
                        <span className="text-sm font-extrabold text-amber-200">{totalUnidades.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ])
              })()}
            </div>

            <DialogFooter className="gap-2 sm:gap-0 mt-4 pt-3 border-t border-slate-700/30 shrink-0">
              <Button variant="outline" onClick={() => setMassConfirmOpen(false)} size="sm" className="h-11 text-xs border-slate-700/50 text-slate-400 hover:bg-slate-800/80 rounded-xl">
                No, cancelar
              </Button>
              <Button onClick={() => { setMassConfirmOpen(false); doMassSalida() }} disabled={massBusy || massData.size === 0} size="sm" className="h-11 gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded-xl shadow-lg shadow-red-500/20">
                {massBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Si, registrar salida
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
