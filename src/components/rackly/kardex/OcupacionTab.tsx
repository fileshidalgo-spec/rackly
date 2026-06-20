'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  fetchOcupacionCeldas,
  fetchOcupacionCeldasV2,
  fetchMovimientos,
  fetchIncPorUbicacion,
  stockEnUbicacion,
  type Movimiento,
  type StockEnUbicacion,
  type OcupacionCelda,
  addMovimiento,
  trasladarMovimiento,
  type TrasladoInput,
} from '@/lib/rackly/kardex'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque, totalCeldas } from '@/lib/rackly/ubicaciones'
import { supabase, dataClient } from '@/lib/supabase/client'
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  Download, Loader2, ArrowDownToLine, ArrowUpFromLine, Building2, Layers,
  BoxSelect, Activity, ArrowRightLeft, RotateCcw, X, AlertTriangle, CheckCircle2,
  Package, CalendarOff, CalendarClock, Flame, Clock, Plus, RotateCw as RotateCwIcon,
  Info,
  TriangleAlert,
  MapPin,
  Warehouse,
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

// Calcula ocupación desde movimientos — stock POR CÓDIGO (no por lote).
// f_vencimiento es SOLO para FEFO (ordenamiento), NO para particionar stock.
// IMPORTANTE: Los movimientos INC se EXCLUYEN del stock normal.
// La detección INC se hace por separado con fetchIncPorUbicacion().
function calcularOcupacion(movs: Movimiento[]): OcupacionCelda[] {
  // Mapa: ubicacion_key → (codigo → stock)
  const cellMap = new Map<string, Map<string, number>>()
  for (const m of movs) {
    // EXCLUIR movimientos INC del cálculo de ocupación normal
    if (m.codigoInc) continue
    const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
    const code = m.codigo.trim().toUpperCase()
    let codeMap = cellMap.get(key)
    if (!codeMap) { codeMap = new Map(); cellMap.set(key, codeMap) }
    const delta = ['ingreso', 'devolucion', 'traslado'].includes(m.tipo) ? m.cantidad : -m.cantidad
    const current = codeMap.get(code) ?? 0
    codeMap.set(code, current + delta)
  }
  // Construir resultado: solo celdas con stock total > 0
  const result: OcupacionCelda[] = []
  for (const [key, codeMap] of cellMap) {
    let totalStock = 0
    const codigos = new Set<string>()
    for (const [code, stock] of codeMap) {
      if (stock > 0) {
        totalStock += stock
        codigos.add(code)
      }
    }
    if (totalStock > 0) {
      const [bloque, torre, piso, posicion] = key.split('-')
      // lotes = número de códigos distintos (ya no se cuenta por f_vencimiento)
      result.push({ bloque, torre, piso, posicion, stock: totalStock, codigos: Array.from(codigos), lotes: codigos.size, tieneInc: false, incItems: [] })
    }
  }
  return result
}

type DetailMode = 'view' | 'ingreso' | 'salida' | 'transferir' | 'inc'

export function OcupacionTab() {
  const { perfil } = useAuth()
  const [ocupacion, setOcupacion] = useState<OcupacionCelda[]>([])
  const [bloqueFilter, setBloqueFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ bloque: string; torre: string; piso: string; posicion: string; stock: StockEnUbicacion[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
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

// ── Historial state ──
  type HistorialItem = {
    id: string
    tipo: string
    fecha: string
    turno: string
    usuario_nombre: string | null
    codigo: string
    descripcion: string
    un: string
    cantidad: number
    f_vencimiento: string | null
    codigo_inc: string
  }
  const [historialOpen, setHistorialOpen] = useState(false)
  const [historialData, setHistorialData] = useState<HistorialItem[]>([])
  const [historialOffset, setHistorialOffset] = useState(0)
  const [historialLoading, setHistorialLoading] = useState(false)
  const [historialHasMore, setHistorialHasMore] = useState(false)

  // Codigos actuales en stock (para deteccion de rotacion en historial) — calculado una vez
  const historialCurrentCodigos = useMemo(() =>
    new Set(detail?.stock.map(s => s.codigo) ?? []),
  [detail])

  // ── Transferir state ──
  const [trIdx, setTrIdx] = useState(0)
  const [trDestBloque, setTrDestBloque] = useState('')
  const [trDestTorre, setTrDestTorre] = useState('')
  const [trDestPiso, setTrDestPiso] = useState('')
  const [trDestPos, setTrDestPos] = useState('')
  const [trCantidad, setTrCantidad] = useState('')
  const [trCorregirDiferencia, setTrCorregirDiferencia] = useState(false)

  // ── Destino ocupado alerta (transferir) ──
  const [trDestAlertOpen, setTrDestAlertOpen] = useState(false)
  const [trDestStock, setTrDestStock] = useState<StockEnUbicacion[]>([])
  const [trSalidaBusy, setTrSalidaBusy] = useState<string | null>(null)
  const [trSalidaCant, setTrSalidaCant] = useState<Record<string, string>>({})
  const [trSalidaTotalFlags, setTrSalidaTotalFlags] = useState<Record<string, boolean>>({})

  // ── INC state ──
  const [incCodigo, setIncCodigo] = useState('')
  const [incDescripcion, setIncDescripcion] = useState('')
  const [incUn, setIncUn] = useState('')
  const [incCantidad, setIncCantidad] = useState('')
  const [incCodigoInc, setIncCodigoInc] = useState('')

  // ── Data refresh ──
  // Primario: RPC v2 (PostgreSQL calcula, sin límite de filas)
  // Fallback 1: client-side (fetchMovimientos + calcularOcupacion) — con límite de 15K
  // Fallback 2: RPC v1 legacy
  const refreshData = useCallback(async () => {
    // INC se consulta siempre en paralelo
    const incPromise = fetchIncPorUbicacion()

    try {
      // INTENTO 1: RPC v2 (PostgreSQL calcula todo, sin límite)
      const [rpcCeldas, incMap] = await Promise.all([fetchOcupacionCeldasV2(), incPromise])
      if (!mountedRef.current) return
      if (incMap._error) {
        toast.error('No se pudo cargar información INC. Los datos INC pueden estar incompletos.')
      }

      if (rpcCeldas !== null) {
        // RPC v2 exitó: tiene codigos[] y lotes para colores correctos
        const celdaMap = new Map<string, OcupacionCelda>()
        for (const cell of rpcCeldas) {
          celdaMap.set(`${cell.bloque}-${cell.torre}-${cell.piso}-${cell.posicion}`, cell)
        }
        // Merge INC dedicado
        for (const [key, incItems] of incMap) {
          const existing = celdaMap.get(key)
          if (existing) {
            existing.tieneInc = true
            existing.incItems = incItems
          } else {
            const [bloque, torre, piso, posicion] = key.split('-')
            celdaMap.set(key, { bloque, torre, piso, posicion, stock: 0, codigos: incItems.map(i => i.codigo), lotes: incItems.length, tieneInc: true, incItems })
          }
        }
        setOcupacion(Array.from(celdaMap.values()))
        return
      }

      // RPC v2 falló → Fallback client-side
      // INTENTO 2: fetchMovimientos + calcularOcupacion (límite 15K)
      const [movs] = await Promise.all([fetchMovimientos()])
      if (!mountedRef.current) return
      const celdas = calcularOcupacion(movs)
      const celdaMap = new Map<string, OcupacionCelda>()
      for (const cell of celdas) {
        celdaMap.set(`${cell.bloque}-${cell.torre}-${cell.piso}-${cell.posicion}`, cell)
      }
      // Reusar el mismo incMap resuelto arriba
      for (const [key, incItems] of incMap) {
        const existing = celdaMap.get(key)
        if (existing) {
          existing.tieneInc = true
          existing.incItems = incItems
        } else {
          const [bloque, torre, piso, posicion] = key.split('-')
          celdaMap.set(key, { bloque, torre, piso, posicion, stock: 0, codigos: incItems.map(i => i.codigo), lotes: incItems.length, tieneInc: true, incItems })
        }
      }
      setOcupacion(Array.from(celdaMap.values()))
    } catch {
      // INTENTO 3: RPC v1 legacy
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
  const trTieneAjuste = trExcede || (trFalta && trCorregirDiferencia)

  // ── Ingreso: proveedor visible? ──
  const showProveedor = ingDescripcion ? requiereProveedor(ingDescripcion) : false

  // ── Handlers ──
  async function handleCellClick(b: string, t: string, p: string, pos: string) {
    setDetailLoading(true)
    try {
      const stock = await stockEnUbicacion(b, t, p, pos)
      // Verificar si la consulta falló (bandera _error)
      if (stock.length > 0 && '_error' in stock[0] && stock[0]._error) {
        toast.error('Error al consultar stock de esta ubicación. Intente nuevamente.')
        setDetailLoading(false)
        return
      }
      setDetail({ bloque: b, torre: t, piso: p, posicion: pos, stock })
      setDetailMode('view')
    } catch { toast.error('Error al cargar detalle') }
    finally { setDetailLoading(false) }
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
    setTrCorregirDiferencia(false)
    setDetailMode('transferir')
  }

  // ── Historial ──
  const loadHistorial = useCallback(async (offset = 0, append = false) => {
    if (!detail) return
    setHistorialLoading(true)
    try {
      const { data, error } = await dataClient
        .from('movimientos')
        .select('id, tipo, turno, f_modificacion, usuario_nombre, codigo, descripcion, un, cantidad, f_vencimiento, codigo_inc')
        .eq('bloque', detail.bloque)
        .eq('torre', detail.torre)
        .eq('piso', detail.piso)
        .eq('posicion', detail.posicion)
        .order('f_modificacion', { ascending: false })
        .range(offset, offset + 5)
      if (error) throw error
      const items: HistorialItem[] = (data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        tipo: r.tipo,
        fecha: r.f_modificacion,
        turno: r.turno ?? '',
        usuario_nombre: r.usuario_nombre,
        codigo: r.codigo,
        descripcion: r.descripcion || '',
        un: r.un,
        cantidad: r.cantidad,
        f_vencimiento: r.f_vencimiento || '',
        codigo_inc: r.codigo_inc || '',
      }))
      setHistorialHasMore(items.length > 5)
      const trimmed = items.slice(0, 5)
      if (append) {
        setHistorialData(prev => [...prev, ...trimmed])
      } else {
        setHistorialData(trimmed)
      }
      setHistorialOffset(offset + 5)
    } catch (err) {
      console.error('[Ocupacion] Error cargando historial:', err)
      toast.error('Error al cargar historial')
    } finally {
      setHistorialLoading(false)
    }
  }, [detail])

  function openHistorial() {
    setHistorialOffset(0)
    setHistorialData([])
    setHistorialOpen(true)
    loadHistorial(0, false)
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
    } catch (err: unknown) { toast.error('Error', { description: extractError(err) }) } finally { setActionBusy(false) }
  }

  function openInc() {
    setIncCodigo(''); setIncDescripcion(''); setIncUn('')
    setIncCantidad(''); setIncCodigoInc('')
    setDetailMode('inc')
  }

  async function doIngresoINC() {
    if (!detail || !perfil) return
    if (!incCodigo.trim() || !incCantidad || !incCodigoInc.trim()) { toast.error('Completa código, cantidad y código INC'); return }
    const q = parseFloat(incCantidad); if (isNaN(q) || q <= 0) { toast.error('Cantidad inválida'); return }
    setActionBusy(true)
    try {
      await addMovimiento({
        tipo: 'ingreso', bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: incCodigo.trim().toUpperCase(), descripcion: incDescripcion, un: incUn, cantidad: q,
        fVencimiento: '', turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        codigoInc: incCodigoInc.trim(),
      })
      toast.success('INC registrado')
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) { toast.error('Error', { description: extractError(err) }) } finally { setActionBusy(false) }
  }

  function handleIncCatalogoPick(item: { codigo: string; descripcion: string; un: string }) {
    setIncCodigo(item.codigo)
    setIncDescripcion(item.descripcion)
    setIncUn(item.un)
  }

  async function doSalida() {
    if (!detail || !perfil) return
    const item = detail.stock[salidaIdx]
    if (!item) return
    const qty = parseFloat(salidaCantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    // Las salidas normales NO pueden exceder stock. Las salidas INC sí permiten exceder (autoajuste).
    // La validacion debe usar el stock TOTAL del codigo en esta ubicacion (igual que la RPC
    // registrar_movimiento_kardex), NO el stock por lote individual. La UI agrupa por lote
    // (f_vencimiento) pero la RPC suma TODOS los movimientos del codigo sin distinguir lotes.
    if (!item.codigoInc) {
      const totalStockForCodigo = detail.stock
        .filter(s => s.codigo === item.codigo)
        .reduce((sum, s) => sum + s.stock, 0)
      if (qty > totalStockForCodigo) { toast.error(`Stock insuficiente. Stock total disponible: ${totalStockForCodigo} ${item.un}`); return }
    }
    setActionBusy(true)
    try {
      await addMovimiento({
        tipo: 'salida', bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion,
        codigo: item.codigo, descripcion: item.descripcion, un: item.un, cantidad: qty,
        fVencimiento: item.fVencimiento ?? '', turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        // PRESERVAR codigoInc para que la salida descuente del stock INC correctamente
        codigoInc: item.codigoInc || undefined,
      })
      toast.success('Salida registrada')
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        const detail = (err as Record<string, string>).detail || ''
        toast.error('Stock insuficiente', { description: detail || 'Otro usuario pudo haber modificado el stock. Los datos se han actualizado.', duration: 8000 })
        refreshDetail(); refreshData()
      } else { toast.error('Error al registrar salida', { description: extractError(err) }) }
    } finally { setActionBusy(false) }
  }

  // Dar salida a un producto desde el alerta de destino ocupado (OcupacionTab)
  async function handleTrSalidaDesdeAlerta(stockItem: StockEnUbicacion) {
    if (!perfil) return
    const itemKey = `${stockItem.codigo}-${stockItem.fVencimiento || ''}`
    const isTotal = trSalidaTotalFlags[itemKey] === true
    const cantStr = trSalidaCant[itemKey] || ''
    const cantNum = isTotal ? stockItem.stock : parseFloat(cantStr)
    if (isNaN(cantNum) || cantNum <= 0) { toast.error('Cantidad inválida'); return }
    if (cantNum > stockItem.stock) { toast.error(`Máximo: ${stockItem.stock} ${stockItem.un}`); return }
    setTrSalidaBusy(itemKey)
    try {
      await addMovimiento({
        tipo: 'salida',
        bloque: trDestBloque,
        torre: trDestTorre,
        piso: trDestPiso,
        posicion: trDestPos,
        codigo: stockItem.codigo,
        descripcion: stockItem.descripcion,
        un: stockItem.un,
        cantidad: cantNum,
        fVencimiento: stockItem.fVencimiento ?? '',
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: stockItem.proveedor,
        codigoInc: stockItem.codigoInc || undefined,
      })
      toast.success(`Salida de ${cantNum} ${stockItem.un} de ${stockItem.codigo}`)
      // Refrescar stock del destino
      const updated = await stockEnUbicacion(trDestBloque, trDestTorre, trDestPiso, trDestPos)
      setTrDestStock(updated)
      await refreshDetail()
      refreshData()
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        toast.error('Stock insuficiente', {
          description: 'Otro usuario pudo haber modificado el stock. Los datos se han actualizado.', duration: 6000,
        })
      } else {
        toast.error('Error al dar salida', { description: extractError(err) })
      }
    } finally {
      setTrSalidaBusy(null)
    }
  }

  // Ejecutar el traslado (se llama desde la alerta o directamente si destino vacío)
  async function ejecutarTraslado() {
    if (!detail || !perfil || !trItem) return
    const qty = parseFloat(trCantidad)
    setActionBusy(true)
    try {
      const input: TrasladoInput = {
        codigo: trItem.codigo, descripcion: trItem.descripcion, un: trItem.un, cantidad: qty,
        origen: { bloque: detail.bloque, torre: detail.torre, piso: detail.piso, posicion: detail.posicion },
        destino: { bloque: trDestBloque, torre: trDestTorre, piso: trDestPiso, posicion: trDestPos },
        turno: calcularTurno(), usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
        fVencimiento: trItem.fVencimiento ?? '',
        cantidadAjuste: trTieneAjuste ? trDiferencia : 0,
        codigoInc: trItem.codigoInc || undefined,
      }
      await trasladarMovimiento(input)
      toast.success('Traslado registrado')
      if (trFalta && trCorregirDiferencia) {
        toast.info(`Salida de ajuste: -${Math.abs(trDiferencia)} ${trItem.un} en origen`, { duration: 6000 })
      }
      if (trExcede) {
        toast.info(`Ajuste automático: +${Math.abs(trDiferencia)} ${trItem.un} ingreso en origen`, { duration: 6000 })
      }
      setTrDestAlertOpen(false)
      if (mountedRef.current) { await refreshDetail(); refreshData(); setDetailMode('view') }
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        const d = (err as Record<string, string>).detail || ''
        toast.error('Stock insuficiente en origen', { description: d || 'Otro usuario pudo haber modificado el stock. Los datos se han actualizado.', duration: 8000 })
        refreshDetail(); refreshData()
      } else { toast.error('Error al trasladar', { description: extractError(err) }) }
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
        // Mostrar alerta con opción de dar salida en vez de bloquear
        setTrDestStock(destStock)
        setTrSalidaCant({})
        setTrSalidaTotalFlags({})
        setTrDestAlertOpen(true)
        setActionBusy(false)
        return
      }
      // Destino vacío — ejecutar traslado directamente
      await ejecutarTraslado()
    } catch (err: unknown) {
      toast.error('Error al verificar destino', { description: extractError(err) })
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
              const incCount = cell?.incItems?.length ?? 0
              const incCodes = cell?.incItems?.map(i => `${i.codigoInc} (${i.cantidad})`).join(', ') ?? ''
              data.push({
                Bloque: b,
                Torre: t,
                Piso: p,
                Posición: pos,
                Stock: isOcc ? cell.stock : 0,
                Códigos: isOcc ? cell.codigos.join(', ') : '',
                Artículos: isOcc ? cell.codigos.length : 0,
                Estado: isOcc ? (cell!.codigos.length > 1 ? 'Mixto' : cell!.lotes > 1 ? 'Multi-lote' : 'Ocupado') : (incCount > 0 ? 'Solo INC' : 'Vacío'),
                Lotes: isOcc ? cell!.lotes : 0,
                'INC': incCount > 0 ? `${incCount} item(s): ${incCodes}` : '',
              })
            }
          }
        }
      }
      const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Ocupación'); XLSX.writeFile(wb, `RACKLY_Ocupacion_${new Date().toISOString().slice(0, 10)}.xlsx`); toast.success('Exportado')
    } catch (err: unknown) { toast.error('Error exportando', { description: extractError(err) }) } finally { setBusyExport(false) }
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
  const isInc = detailMode === 'inc'
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
        <div className="flex items-center gap-4 text-[10px] text-slate-400 flex-wrap">
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-blue-400 to-blue-600" /><span>Ocupado</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-blue-400 to-blue-600 relative"><span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full" /></div><span>Multi-lote</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-amber-400 to-orange-500" /><span>Multi-art.</span></div>
          <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gradient-to-br from-rose-400 to-pink-600" /><span>INC</span></div>
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
                    const tInc = ocupacion.filter(o => o.bloque === bloque && o.torre === torre && o.tieneInc).length
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
                            const pisoOcup = posiciones.filter(pos => { const c = ocupacion.find(o => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos); return c && (c.stock > 0 || (c.tieneInc && c.incItems.length > 0)) }).length
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
                                    const isOnlyInc = !isOcc && cell && cell.tieneInc && cell.incItems.length > 0
                                    const isInc = cell && cell.tieneInc && cell.incItems.length > 0
                                    const isMultiArt = isOcc && !isInc && cell.codigos.length > 1
                                    const isMultiLote = isOcc && !isInc && !isMultiArt && cell.lotes > 1
                                    let cls = 'relative flex-1 min-w-[24px] rounded text-[9px] font-bold transition-all duration-150 cursor-pointer border flex flex-col items-center justify-center '
                                    if (isInc) cls += 'bg-gradient-to-br from-rose-400 to-pink-600 text-white shadow-[0_1px_3px_rgba(244,63,94,0.3)] hover:shadow-[0_2px_8px_rgba(244,63,94,0.5)] hover:scale-105 active:scale-95 border-rose-300/30 min-h-[50px]'
                                    else if (isMultiArt) cls += 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_1px_3px_rgba(245,158,11,0.25)] hover:shadow-[0_2px_6px_rgba(245,158,11,0.35)] hover:scale-105 active:scale-95 border-amber-300/25 h-11'
                                    else if (isOcc) cls += 'bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-[0_1px_3px_rgba(59,130,246,0.25)] hover:shadow-[0_2px_6px_rgba(59,130,246,0.35)] hover:scale-105 active:scale-95 border-blue-300/25 h-11'
                                    else cls += 'bg-gradient-to-br from-emerald-400/60 to-green-600/60 text-white/60 shadow-[0_1px_2px_rgba(16,185,129,0.1)] hover:shadow-[0_2px_4px_rgba(16,185,129,0.2)] hover:from-emerald-400 hover:to-green-500 hover:text-white hover:scale-105 active:scale-95 border-emerald-400/15 h-11'
                                    let title = `B${bloque}-T${torre}-P${piso}-Pos${pos}`
                                    if (isInc) { const ii = cell!.incItems.map(i => `${i.codigo} - ${i.descripcion || 'Sin descripción'} (INC: ${i.codigoInc}) Cantidad: ${i.cantidad}`).join('\n'); title += `\nINC:\n${ii}` + (isOcc ? `\nStock normal: ${cell!.stock}` : '(Solo INC)') }
                                    else if (isOcc) { title += ` · Stock: ${cell!.stock}${isMultiArt ? ` · ${cell!.codigos.length} artículos` : ''}${isMultiLote ? ` · ${cell!.lotes} lotes` : ''}` }
                                    else { title += ' · Vacío' }
                                    const firstInc = isInc ? cell!.incItems[0] : null
                                    return (
                                      <button key={pos} className={cls} onClick={() => handleCellClick(bloque, torre, piso, pos)} title={title}>
                                        {pos}
                                        {isInc && firstInc && (
                                          <span className="text-[6px] leading-tight text-rose-100/85 font-semibold truncate max-w-full px-0.5 mt-px">
                                            {firstInc.codigo.length > 7 ? firstInc.codigo.slice(0, 7) + '…' : firstInc.codigo} ×{firstInc.cantidad}
                                            {cell!.incItems.length > 1 && <span className="text-[5px] text-rose-200/60 ml-px">+{cell!.incItems.length - 1}</span>}
                                          </span>
                                        )}
                                        {isMultiLote && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full ring-1 ring-slate-800" />}
                                        {isInc && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-rose-200 rounded-full ring-1 ring-rose-400" />}
                                      </button>
                                    )
                                  })}
                                </div>
                                <div className="flex px-1.5 pt-[2px] pb-1.5 gap-[2px]">
                                  {posB.map(pos => {
                                    const cell = ocupacion.find(o => o.bloque === bloque && o.torre === torre && o.piso === piso && o.posicion === pos)
                                    const isOcc = cell && cell.stock > 0
                                    const isOnlyInc = !isOcc && cell && cell.tieneInc && cell.incItems.length > 0
                                    const isInc = cell && cell.tieneInc && cell.incItems.length > 0
                                    const isMultiArt = isOcc && !isInc && cell.codigos.length > 1
                                    const isMultiLote = isOcc && !isInc && !isMultiArt && cell.lotes > 1
                                    let cls = 'relative flex-1 min-w-[24px] rounded text-[9px] font-bold transition-all duration-150 cursor-pointer border flex flex-col items-center justify-center '
                                    if (isInc) cls += 'bg-gradient-to-br from-rose-400 to-pink-600 text-white shadow-[0_1px_3px_rgba(244,63,94,0.3)] hover:shadow-[0_2px_8px_rgba(244,63,94,0.5)] hover:scale-105 active:scale-95 border-rose-300/30 min-h-[50px]'
                                    else if (isMultiArt) cls += 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_1px_3px_rgba(245,158,11,0.25)] hover:shadow-[0_2px_6px_rgba(245,158,11,0.35)] hover:scale-105 active:scale-95 border-amber-300/25 h-11'
                                    else if (isOcc) cls += 'bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-[0_1px_3px_rgba(59,130,246,0.25)] hover:shadow-[0_2px_6px_rgba(59,130,246,0.35)] hover:scale-105 active:scale-95 border-blue-300/25 h-11'
                                    else cls += 'bg-gradient-to-br from-emerald-400/60 to-green-600/60 text-white/60 shadow-[0_1px_2px_rgba(16,185,129,0.1)] hover:shadow-[0_2px_4px_rgba(16,185,129,0.2)] hover:from-emerald-400 hover:to-green-500 hover:text-white hover:scale-105 active:scale-95 border-emerald-400/15 h-11'
                                    let title = `B${bloque}-T${torre}-P${piso}-Pos${pos}`
                                    if (isInc) { const ii = cell!.incItems.map(i => `${i.codigo} - ${i.descripcion || 'Sin descripción'} (INC: ${i.codigoInc}) Cantidad: ${i.cantidad}`).join('\n'); title += `\nINC:\n${ii}` + (isOcc ? `\nStock normal: ${cell!.stock}` : '(Solo INC)') }
                                    else if (isOcc) { title += ` · Stock: ${cell!.stock}${isMultiArt ? ` · ${cell!.codigos.length} artículos` : ''}${isMultiLote ? ` · ${cell!.lotes} lotes` : ''}` }
                                    else { title += ' · Vacío' }
                                    const firstInc = isInc ? cell!.incItems[0] : null
                                    return (
                                      <button key={pos} className={cls} onClick={() => handleCellClick(bloque, torre, piso, pos)} title={title}>
                                        {pos}
                                        {isInc && firstInc && (
                                          <span className="text-[6px] leading-tight text-rose-100/85 font-semibold truncate max-w-full px-0.5 mt-px">
                                            {firstInc.codigo.length > 7 ? firstInc.codigo.slice(0, 7) + '…' : firstInc.codigo} ×{firstInc.cantidad}
                                            {cell!.incItems.length > 1 && <span className="text-[5px] text-rose-200/60 ml-px">+{cell!.incItems.length - 1}</span>}
                                          </span>
                                        )}
                                        {isMultiLote && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full ring-1 ring-slate-800" />}
                                        {isInc && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-rose-200 rounded-full ring-1 ring-rose-400" />}
                                      </button>
                                    )
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
                — {detailMode === 'inc' ? 'Registro INC' : detailMode === 'ingreso' ? (ingTipo === 'ingreso' ? 'Ingreso' : 'Devolución') : detailMode === 'salida' ? 'Salida' : 'Transferir'}
              </span>}
            </DialogTitle>
          </DialogHeader>

          {detail && (<>
            {/* ═══════ MODO: VISTA ═══════ */}
            {isView && (
              <>
              {detailLoading && <div className="flex items-center justify-center py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" />Cargando...</div>}
              {!detailLoading && (detail.stock.length > 0 ? (
                <>
                  {(() => {
                    const multiples = codigosConMultiplesLotes(detail.stock)
                    const stockDisponible = detail.stock.filter(s => !s.codigoInc)
                    const stockInc = detail.stock.filter(s => !!s.codigoInc)
                    return (
                      <div className="space-y-3">
                        {/* ── Stock Disponible ── */}
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                            <Package className="w-3 h-3 text-emerald-400" /> Disponible ({stockDisponible.length})
                          </p>
                          <div className="space-y-2">
                            {stockDisponible.map((s, i) => {
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
                                    <p className={`text-xs mt-0.5 truncate ${s.descripcion ? 'text-slate-300' : 'text-slate-500 italic'}`}>{s.descripcion || 'Sin descripción'}</p>
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
                                  <button onClick={() => openHistorial()} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300 transition-colors text-[10px] font-medium border border-violet-500/15"><Clock className="w-3 h-3" /> Historial</button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                        {stockDisponible.length === 0 && (
                          <p className="text-slate-500 text-xs italic py-2">Sin stock disponible.</p>
                        )}
                      </div>
                        </div>

                        {/* ── Stock INC (Insumo No Conforme) ── */}
                        {stockInc.length > 0 && (
                          <div>
                            <p className="text-[10px] font-bold text-rose-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                              <AlertTriangle className="w-3 h-3 text-rose-400" /> INC — Insumo No Conforme ({stockInc.length})
                            </p>
                            <div className="space-y-2">
                              {stockInc.map((s, i) => (
                                <div key={`inc-${s.codigo}-${s.fVencimiento || 'sin-fecha'}`} className="rounded-lg border overflow-hidden border-rose-500/25 bg-gradient-to-r from-rose-950/20 to-slate-700/20">
                                  <div className="p-3 space-y-1.5">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="font-mono text-rose-400 font-bold text-xs">{s.codigo}</span>
                                          {s.codigoInc && <span className="text-[8px] font-bold text-rose-300 bg-rose-400/15 border border-rose-400/20 px-1.5 py-px rounded">{s.codigoInc}</span>}
                                        </div>
                                        <p className={`text-xs mt-0.5 truncate ${s.descripcion ? 'text-slate-300' : 'text-slate-500 italic'}`}>{s.descripcion || 'Sin descripción'}</p>
                                      </div>
                                      <div className="text-right flex-shrink-0">
                                        <p className="font-bold text-rose-300 text-sm">{s.stock}</p>
                                        <p className="text-[10px] text-slate-500">{s.un}</p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1 pt-1">
                                      <button onClick={() => openSalida(detail.stock.indexOf(s), true)} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors text-[10px] font-medium"><ArrowUpFromLine className="w-3 h-3" /> Todo</button>
                                      <button onClick={() => openSalida(detail.stock.indexOf(s), false)} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 hover:text-orange-300 transition-colors text-[10px] font-medium"><ArrowUpFromLine className="w-3 h-3" /> Parcial</button>
                                      <button onClick={() => openTransferir(detail.stock.indexOf(s))} className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 transition-colors text-[10px] font-medium"><ArrowRightLeft className="w-3 h-3" /> Transferir</button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {/* Botones principales */}
                  <div className="flex gap-2 pt-1">
                    <Button onClick={() => openIngreso('ingreso')} size="sm" className="flex-1 gap-1.5 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-xs"><ArrowDownToLine className="h-3.5 w-3.5" /> Ingreso</Button>
                    <Button onClick={() => openInc()} size="sm" className="flex-1 gap-1.5 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs"><AlertTriangle className="h-3.5 w-3.5" /> INC</Button>
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
                    <Button onClick={() => openInc()} size="sm" className="gap-1.5 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs"><AlertTriangle className="h-3.5 w-3.5" /> INC</Button>
                  </div>
                </div>
              )
            )}
            </>
            )}
            {isInc && (
              <div className="space-y-3">
                <div className="rounded-lg border border-rose-500/25 bg-rose-950/10 p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-rose-400">Registro INC — Insumo No Conforme</p>
                      <p className="text-[10px] text-slate-400">Producto que no cumple con especificaciones de calidad</p>
                    </div>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500">Ubicación: <span className="text-sky-400 font-mono">B{detail.bloque} T{detail.torre} P{detail.piso} Pos {detail.posicion}</span></p>

                {/* Búsqueda de artículo */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-slate-400">Buscar artículo (código o descripción) *</Label>
                  <CatalogoSearchInput
                    onPick={handleIncCatalogoPick}
                    value={incCodigo}
                    onChange={(val) => setIncCodigo(val)}
                  />
                </div>

                {/* Descripción y UN */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><Label className="text-[10px] text-slate-400">Descripción</Label><Input value={incDescripcion} onChange={e => setIncDescripcion(e.target.value)} placeholder="Auto o manual" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" /></div>
                  <div className="space-y-1"><Label className="text-[10px] text-slate-400">UN</Label><Input value={incUn} onChange={e => setIncUn(e.target.value)} placeholder="Auto o manual" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" /></div>
                </div>

                {/* Cantidad */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-400">Cantidad *</Label>
                    <Input type="number" step="any" min="0.001" value={incCantidad} onChange={e => setIncCantidad(e.target.value)} placeholder="0" className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-slate-400">Código INC *</Label>
                    <Input value={incCodigoInc} onChange={e => setIncCodigoInc(e.target.value)} placeholder="Ej: INC026-120" className="h-8 bg-slate-700/50 border-rose-600/40 text-rose-300 text-xs placeholder:text-rose-500/40 focus:border-rose-400/60" />
                  </div>
                </div>

                {/* Botones */}
                <div className="flex gap-2">
                  <button onClick={() => setDetailMode('view')} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold border border-slate-600/40 text-slate-400 hover:bg-slate-700/40 hover:text-slate-200 transition-colors">← Cancelar</button>
                  <Button onClick={() => doIngresoINC()} disabled={actionBusy} className="flex-1 gap-1.5 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white text-xs">
                    {actionBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <AlertTriangle className="h-3.5 w-3.5" /> Registrar INC
                  </Button>
                </div>
              </div>
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
                      className="flex-1 h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs focus:border-sky-500/50 disabled:opacity-40 [color-scheme:dark]"
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
                              <span className={`font-mono font-bold text-xs ${s.codigoInc ? 'text-rose-400' : 'text-sky-400'}`}>{s.codigo}</span>
                              {s.codigoInc && <span className="text-[8px] font-bold text-rose-300 bg-rose-400/15 border border-rose-400/20 px-1.5 py-px rounded">INC</span>}
                              {s.proveedor && <span className="text-[8px] font-semibold text-purple-400 bg-purple-400/10 px-1.5 py-px rounded">{s.proveedor}</span>}
                            </div>
                            {s.descripcion && <p className="text-[10px] text-slate-400 truncate">{s.descripcion}</p>}
                          </div>
                          <span className={`font-bold text-xs flex-shrink-0 ${s.codigoInc ? 'text-rose-300' : 'text-emerald-400'}`}>{s.stock} <span className="text-slate-500 font-normal">{s.un}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-1.5">
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Producto:</span><span className="text-slate-200 font-mono">{salItem.codigo}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Descripción:</span><span className="text-slate-300 truncate ml-2">{salItem.descripcion || '—'}</span></div>
                  {salItem.proveedor && <div className="flex justify-between text-xs"><span className="text-slate-400">Proveedor:</span><span className="text-purple-400 font-medium">{salItem.proveedor}</span></div>}
                  {salItem.codigoInc && (
                  <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-2 flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 flex-shrink-0" />
                    <span className="text-[10px] text-rose-300 font-medium">INC — {salItem.codigoInc} — La salida puede exceder el stock</span>
                  </div>
                )}
                {salItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className={salItem.fVencimiento < new Date().toISOString().slice(0, 10) ? 'text-red-400 font-semibold' : 'text-slate-300'}>{salItem.fVencimiento}</span></div>}
                  {!salItem.fVencimiento && <div className="flex justify-between text-xs"><span className="text-slate-400">F. Vencimiento:</span><span className="text-slate-500 italic">Sin fecha</span></div>}
                  <div className="flex justify-between text-xs"><span className="text-slate-400">Stock actual:</span><span className={`font-bold ${salItem.codigoInc ? 'text-rose-300' : 'text-emerald-400'}`}>{salItem.stock} {salItem.un}</span></div>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-slate-400">
                    {salidaTotal ? 'Salida total' : 'Cantidad a salir'} *
                    {!salidaTotal && !salItem.codigoInc && <span className="text-slate-600 ml-1">(máx: {salItem.stock})</span>}
                  </Label>
                  <Input type="number" step="any" min="0.001" max={salItem.codigoInc ? undefined : salItem.stock} value={salidaCantidad}
                    onChange={e => setSalidaCantidad(e.target.value)}
                    disabled={salidaTotal}
                    className={`h-8 bg-slate-700/50 text-slate-200 text-xs disabled:opacity-50 ${salItem.codigoInc ? 'border-rose-500/30 focus:border-rose-400/50' : 'border-slate-600/40 focus:border-red-500/50'}`} />
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
                {trExcede && (
                  <div className={`rounded-lg border p-2.5 space-y-1.5 border-amber-500/30 bg-amber-500/5`}>
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-[10px] font-bold text-amber-400">Ajuste positivo</span>
                    </div>
                    <p className="text-[10px] text-slate-400">
                      Se registrará un ingreso de {Math.abs(trDiferencia)} {trItem?.un} en origen para cubrir la diferencia.
                    </p>
                    <div className="flex gap-2 text-[10px]">
                      <span className="text-slate-500">Origen: {trItem.stock} → {trQtyNum} {trItem?.un}</span>
                      <span className="text-amber-400">[+{Math.abs(trDiferencia)} ajuste]</span>
                    </div>
                    <p className="text-[10px] text-slate-500">Destino: +{trQtyNum} {trItem?.un}</p>
                  </div>
                )}
                {trFalta && (
                  <div className={`rounded-lg border p-2.5 space-y-1.5 border-sky-500/30 bg-sky-500/5`}>
                    <div className="flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 text-sky-400" />
                      <span className="text-[10px] font-bold text-sky-400">Traslado parcial</span>
                    </div>
                    <p className="text-[10px] text-slate-400">
                      La posición de origen quedará con un <strong>saldo de {Math.abs(trDiferencia)} {trItem?.un}</strong>.
                    </p>
                    <p className="text-[10px] text-slate-400">
                      ¿Qué deseas hacer con la diferencia?
                    </p>
                    <div className="space-y-1.5 mt-1">
                      <button
                        type="button"
                        onClick={() => setTrCorregirDiferencia(false)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-[10px] transition-all border ${!trCorregirDiferencia ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-slate-600/30 bg-slate-700/30 text-slate-500 hover:bg-slate-700/50'}`}
                      >
                        Dejar saldo de {Math.abs(trDiferencia)} {trItem?.un} en origen
                      </button>
                      <button
                        type="button"
                        onClick={() => setTrCorregirDiferencia(true)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-[10px] transition-all border ${trCorregirDiferencia ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-slate-600/30 bg-slate-700/30 text-slate-500 hover:bg-slate-700/50'}`}
                      >
                        Registrar salida de ajuste ({Math.abs(trDiferencia)} {trItem?.un}) — origen quedará en 0
                      </button>
                    </div>
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

      {/* ═══ HISTORIAL DIALOG ═══ */}
      <Dialog open={historialOpen} onOpenChange={(open) => { if (!open) setHistorialOpen(false) }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] bg-slate-800 border-violet-500/20 shadow-xl max-h-[80vh] flex flex-col overflow-hidden overscroll-contain">
          <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
            <DialogTitle className="flex items-center gap-2.5 text-sm text-white">
              <div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center border border-violet-500/20">
                <Clock className="h-3.5 w-3.5 text-violet-400" />
              </div>
              <div>
                <span className="font-bold">Historial</span>
                {detail && (
                  <span className="text-slate-400 font-normal text-xs ml-2">
                    — B{detail.bloque} · T{detail.torre} · P{detail.piso} · Pos {detail.posicion}
                  </span>
                )}
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
            {historialLoading && historialData.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
              </div>
            ) : historialData.length === 0 ? (
              <div className="text-center py-10">
                <Clock className="h-8 w-8 text-slate-700 mx-auto mb-2" />
                <p className="text-slate-500 text-xs">Sin movimientos registrados</p>
              </div>
            ) : (
              <div className="relative pl-5">
                <div className="absolute left-[7px] top-2 bottom-2 w-[2px] bg-gradient-to-b from-violet-500/30 to-slate-700/20 rounded-full" />
                {historialData.map((item) => {
                  const esInc = !!item.codigo_inc
                  const esIngreso = !esInc && (item.tipo === 'ingreso' || item.tipo === 'stock_inicial')
                  const esSalida = item.tipo === 'salida'
                  const esTraslado = item.tipo === 'traslado'
                  const esDevolucion = item.tipo === 'devolucion'
                  const dotColor = esIngreso ? 'border-emerald-500 bg-emerald-500/20' : esSalida ? 'border-red-500 bg-red-500/20' : esTraslado ? 'border-blue-500 bg-blue-500/20' : esDevolucion ? 'border-amber-500 bg-amber-500/20' : esInc ? 'border-rose-500 bg-rose-500/20' : 'border-slate-500 bg-slate-500/20'
                  const badgeClass = esIngreso ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : esSalida ? 'bg-red-500/10 text-red-400 border-red-500/20' : esTraslado ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : esDevolucion ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : esInc ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                  const tipoLabel = esIngreso ? (item.tipo === 'stock_inicial' ? 'Stock Inicial' : 'Ingreso') : esSalida ? 'Salida' : esTraslado ? 'Traslado' : esDevolucion ? 'Devolucion' : esInc ? 'INC' : item.tipo
                  const fechaStr = item.fecha ? new Date(item.fecha).toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
                  const iniciales = item.usuario_nombre ? item.usuario_nombre.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2) : '??'
                  const esPositivo = esIngreso || esDevolucion || esInc
                  const esRotacion = !historialCurrentCodigos.has(item.codigo)

                  return (
                    <div key={item.id} className="relative pb-4 last:pb-0">
                      <div className={`absolute left-[-17px] top-1.5 w-3 h-3 rounded-full border-2 ${dotColor}`} />
                      <div className="rounded-lg border border-slate-600/30 bg-slate-700/30 p-3 hover:border-slate-500/40 transition-colors">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${badgeClass}`}>{tipoLabel}</span>
                          <span className="text-[9px] text-slate-500">{fechaStr}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <div className="w-5 h-5 rounded-full bg-violet-500/20 flex items-center justify-center text-[7px] font-bold text-violet-300 border border-violet-500/20 flex-shrink-0">
                            {iniciales}
                          </div>
                          <span className="text-[10px] font-semibold text-slate-200">{item.usuario_nombre || 'Usuario desconocido'}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 leading-relaxed">
                          <span className="font-mono text-sky-300 font-semibold">{item.codigo}</span>
                          {item.descripcion && <span className="ml-1.5 text-slate-300">{item.descripcion}</span>}
                          <div className="mt-0.5">
                            Cantidad: <span className={`font-bold font-mono ${esPositivo ? 'text-emerald-400' : 'text-red-400'}`}>{esPositivo ? '+' : '-'}{Math.abs(item.cantidad).toFixed(2)} {item.un}</span>
                            {item.f_vencimiento && <span className="text-slate-500 ml-1.5">· Venc: {item.f_vencimiento}</span>}
                          </div>
                          {esRotacion && (
                            <span className="inline-flex items-center gap-1 mt-1 text-[8px] font-semibold text-violet-400 bg-violet-500/10 border border-violet-500/15 px-1.5 py-0.5 rounded-md">
                              <RotateCwIcon className="w-2.5 h-2.5" /> Rotacion de producto
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}

                {historialHasMore && (
                  <button
                    onClick={() => loadHistorial(historialOffset, true)}
                    disabled={historialLoading}
                    className="w-full flex items-center justify-center gap-1.5 mt-3 py-2 rounded-lg border border-dashed border-violet-500/25 bg-violet-500/[0.03] text-violet-400 text-[10px] font-semibold hover:bg-violet-500/[0.07] hover:border-violet-500/40 transition-colors disabled:opacity-50"
                  >
                    {historialLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    Cargar mas movimientos
                  </button>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ DESTINO OCUPADO ALERTA (Transferir) ═══ */}
      <AlertDialog open={trDestAlertOpen} onOpenChange={setTrDestAlertOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className={`px-4 sm:px-6 py-5 text-white shrink-0 ${
            trDestStock.length > 0
              ? 'bg-gradient-to-r from-orange-500 via-red-500 to-red-600'
              : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                {trDestStock.length > 0 ? (
                  <TriangleAlert className="h-6 w-6 text-white" />
                ) : (
                  <ArrowRightLeft className="h-6 w-6 text-white" />
                )}
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  {trDestStock.length > 0 ? 'Destino Ocupado' : 'Confirmar Traslado'}
                </AlertDialogTitle>
                <AlertDialogDescription className={`text-sm mt-0.5 ${
                  trDestStock.length > 0 ? 'text-orange-100' : 'text-blue-100'
                }`}>
                  {trDestStock.length > 0
                    ? 'El destino ya tiene stock. Puedes dar salida a los productos antes de trasladar o confirmar de todas formas.'
                    : 'El destino está vacío. Puedes proceder con el traslado.'}
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <AlertDialogDescription className="sr-only">
            Alerta de destino ocupado para traslado
          </AlertDialogDescription>

          {/* Contenido scrolleable */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {/* Ruta */}
            <div className="px-4 sm:px-6 pt-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Ruta del traslado</p>
              <div className="flex items-center gap-2 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2.5">
                <MapPin className="h-4 w-4 text-blue-500 flex-shrink-0" />
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300 truncate min-w-0">
                  B-{detail?.bloque} T-{detail?.torre} P-{detail?.piso} Pos-{detail?.posicion}
                  <span className="mx-2 text-indigo-500 font-bold">→</span>
                  B-{trDestBloque} T-{trDestTorre} P-{trDestPiso} Pos-{trDestPos}
                </span>
              </div>
            </div>

            {/* Producto a trasladar */}
            <div className="px-4 sm:px-6 pb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Producto a trasladar</p>
              <div className="rounded-xl border-2 border-dashed border-blue-300 dark:border-blue-700 bg-blue-50/60 dark:bg-blue-950/20 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-sm text-blue-800 dark:text-blue-300">{trItem?.codigo}</span>
                    <span className="text-[10px] text-blue-700/60 dark:text-blue-400/60 bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 rounded">{trItem?.un || '—'}</span>
                  </div>
                  <span className="font-bold text-blue-700 dark:text-blue-300">{trCantidad} {trItem?.un}</span>
                </div>
                {trItem?.descripcion && (
                  <p className="text-xs text-blue-700/70 dark:text-blue-400/70 truncate">{trItem.descripcion}</p>
                )}
              </div>
            </div>

            {/* Productos existentes en destino */}
            {trDestStock.length > 0 && (
              <div className="px-4 sm:px-6 pb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Stock actual en destino</span>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                </div>
                <div className="space-y-2">
                  {trDestStock.map((s, i) => {
                    const itemKey = `${s.codigo}-${s.fVencimiento || ''}`
                    const isTotal = trSalidaTotalFlags[itemKey] === true
                    return (
                      <div key={`${s.codigo}-${i}`} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3">
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Package className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-semibold text-sm text-slate-800 dark:text-slate-200">{s.codigo}</span>
                              <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{s.un}</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{s.descripcion}</p>
                            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                              <span className="font-bold text-slate-700 dark:text-slate-300 text-sm">{s.stock} {s.un}</span>
                              {s.fVencimiento && <span>Venc: {s.fVencimiento}</span>}
                              {s.proveedor && <span>Prov: {s.proveedor}</span>}
                            </div>
                            {/* Salida parcial/total */}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setTrSalidaTotalFlags(prev => ({ ...prev, [itemKey]: true }))}
                                className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all border ${
                                  isTotal
                                    ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40 dark:border-red-600 dark:text-red-300'
                                    : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                                }`}
                              >
                                Total ({s.stock})
                              </button>
                              <input
                                type="number"
                                step="any"
                                min="0.001"
                                max={s.stock}
                                placeholder="Parcial"
                                value={isTotal ? String(s.stock) : (trSalidaCant[itemKey] || '')}
                                onChange={e => {
                                  setTrSalidaCant(prev => ({ ...prev, [itemKey]: e.target.value }))
                                  setTrSalidaTotalFlags(prev => ({ ...prev, [itemKey]: false }))
                                }}
                                disabled={isTotal || trSalidaBusy === itemKey}
                                className="w-20 h-7 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md px-2 disabled:opacity-50"
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleTrSalidaDesdeAlerta(s)}
                                disabled={trSalidaBusy === itemKey}
                                className="h-7 px-2.5 text-[10px] font-semibold border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 hover:border-red-300 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-300 dark:hover:border-red-700 flex-shrink-0 gap-1"
                              >
                                {trSalidaBusy === itemKey ? (
                                  <><Loader2 className="h-3 w-3 animate-spin" /> ...</>
                                ) : (
                                  <><ArrowUpFromLine className="h-3 w-3" /> Dar Salida</>
                                )}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  Selecciona "Total" o ingresa cantidad parcial y presiona "Dar Salida" para retirar productos del destino.
                </p>
              </div>
            )}
          </div>

          {/* Botones */}
          <AlertDialogFooter className="px-4 sm:px-6 pb-6 pt-3 border-t border-slate-100 dark:border-slate-800 gap-2 sm:gap-2 shrink-0">
            <AlertDialogCancel className="flex-1 h-11 rounded-lg text-sm font-medium border-slate-300 dark:border-slate-600">
              Cancelar
            </AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); setTrDestAlertOpen(false); ejecutarTraslado() }}
              disabled={actionBusy}
              className="flex-1 h-11 rounded-lg text-sm font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-md shadow-blue-600/20 gap-2"
            >
              {actionBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="h-4 w-4" />
              )}
              {trDestStock.length > 0 ? 'Trasladar de todas formas' : 'Confirmar Traslado'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
