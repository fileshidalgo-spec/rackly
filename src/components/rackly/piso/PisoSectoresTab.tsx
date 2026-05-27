'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  listarSectores,
  cargarPosicionesSector,
  stockDetallePosicion,
  obtenerPrimerNivel,
  listarBloquesParaSelect,
  buscarBloquePorCodigo,
  crearBloque,
  registrarMovimiento,
  type Sector,
  type PosicionConStock,
  type DetailStock,
  type BloqueOption,
  type Bloque,
} from '@/lib/piso/api'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  Search,
  RefreshCw,
  Download,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  RotateCcw,
  Package,
  Box,
  Layers3,
  Grid3X3,
  Loader2,
  X,
  Check,
  MapPin,
  FileSpreadsheet,
  Plus,
} from 'lucide-react'

// ─── Color Palette ───────────────────────────────────────
const C = {
  bgDeep: '#0a0a2e',
  bgCard: '#10103a',
  bgElevated: '#1a1a4e',
  bgSurface: '#1e1e52',
  borderDark: '#303030',
  borderBlue: '#303060',
  textWhite: '#f0f0f0',
  textLight: '#80c0ff',
  textMuted: '#8090c0',
  textDark: '#5060a0',
  occupied: '#0060f0',
  occupiedLight: '#2090f0',
  occupiedGlow: 'rgba(0,96,240,0.35)',
  multi: '#f09000',
  multiLight: '#ffc040',
  multiGlow: 'rgba(240,144,0,0.35)',
  empty: '#003030',
  emptyLight: '#40c090',
  emptyGlow: 'rgba(64,192,144,0.25)',
  greenGlow: '#00ff80',
}

// ─── Helpers ─────────────────────────────────────────────

function fmtQty(n: number) {
  return Number.isInteger(n) ? n.toString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

/** Animated number counter */
function AnimatedNumber({ target, duration = 800 }: { target: number; duration?: number }) {
  const [val, setVal] = useState(0)
  const prevTarget = useRef(target)

  useEffect(() => {
    if (prevTarget.current === target) return
    prevTarget.current = target
    const start = val
    const diff = target - start
    if (diff === 0) return
    const startTime = performance.now()
    let raf: number

    function step(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setVal(Math.round(start + diff * eased))
      if (progress < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, duration, val])

  return <>{val}</>
}

// ─── Main Component ──────────────────────────────────────

export function PisoSectoresTab() {
  const { perfil } = useAuth()

  // Data state
  const [sectores, setSectores] = useState<Sector[]>([])
  const [activeSectorIdx, setActiveSectorIdx] = useState(0)
  const [posiciones, setPosiciones] = useState<PosicionConStock[]>([])
  const [loadingPos, setLoadingPos] = useState(false)

  // UI state
  const [searchCode, setSearchCode] = useState('')
  const [selectedPos, setSelectedPos] = useState<PosicionConStock | null>(null)
  const [detailStock, setDetailStock] = useState<DetailStock[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [operation, setOperation] = useState<'none' | 'ingreso' | 'salida' | 'traslado' | 'devolucion'>('none')

  // ── Load sectors on mount ──
  useEffect(() => {
    listarSectores()
      .then(setSectores)
      .catch(() => toast.error('Error al cargar sectores'))
  }, [])

  // ── Load positions when sector changes ──
  useEffect(() => {
    if (sectores.length === 0) return
    const sector = sectores[activeSectorIdx]
    if (!sector) return
    setLoadingPos(true)
    setSelectedPos(null)
    setOperation('none')
    cargarPosicionesSector(sector.id)
      .then(setPosiciones)
      .catch(() => toast.error('Error al cargar posiciones'))
      .finally(() => setLoadingPos(false))
  }, [sectores, activeSectorIdx])

  // ── Stats ──
  const stats = useMemo(() => {
    const total = posiciones.length
    const occupied = posiciones.filter((p) => p.stock > 0).length
    const empty = total - occupied
    const pct = total > 0 ? Math.round((occupied / total) * 100) : 0
    return { total, occupied, empty, pct }
  }, [posiciones])

  // ── Filtered positions by search ──
  const filteredPos = useMemo(() => {
    if (!searchCode.trim()) return posiciones
    const q = searchCode.trim().toUpperCase()
    return posiciones.filter((p) =>
      p.bloques.some((b) => b.bloque_codigo.toUpperCase().includes(q))
    )
  }, [posiciones, searchCode])

  // ── Group by Column → Subcolumn → Position ──
  const grouped = useMemo(() => {
    const colMap = new Map<string, Map<string, PosicionConStock[]>>()
    for (const p of filteredPos) {
      if (!colMap.has(p.columnaLetra)) colMap.set(p.columnaLetra, new Map())
      const subMap = colMap.get(p.columnaLetra)!
      if (!subMap.has(p.subcolumnaCodigo)) subMap.set(p.subcolumnaCodigo, [])
      subMap.get(p.subcolumnaCodigo)!.push(p)
    }
    // Sort subcolumna positions by numero
    for (const subMap of colMap.values()) {
      for (const arr of subMap.values()) {
        arr.sort((a, b) => a.posicionNumero - b.posicionNumero)
      }
    }
    return colMap
  }, [filteredPos])

  // ── Column order ──
  const columnLetters = useMemo(() => {
    return Array.from(grouped.keys()).sort()
  }, [grouped])

  // ── Handle position click ──
  async function handlePosClick(pos: PosicionConStock) {
    setSelectedPos(pos)
    setOperation('none')
    setDetailLoading(true)
    try {
      const details = await stockDetallePosicion(pos.posicionId)
      setDetailStock(details)
    } catch {
      setDetailStock([])
      toast.error('Error al cargar detalle')
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Handle refresh ──
  async function handleRefresh() {
    if (sectores.length === 0) return
    const sector = sectores[activeSectorIdx]
    if (!sector) return
    setLoadingPos(true)
    try {
      const data = await cargarPosicionesSector(sector.id)
      setPosiciones(data)
      toast.success('Datos actualizados')
    } catch {
      toast.error('Error al actualizar')
    } finally {
      setLoadingPos(false)
    }
  }

  // ── Export to Excel ──
  async function handleExport() {
    try {
      const XLSX = await import('xlsx')
      const rows = posiciones.map((p) => ({
        Columna: p.columnaLetra,
        Subcolumna: p.subcolumnaCodigo,
        Posicion: p.posicionNumero,
        Stock: p.stock,
        Bloques: p.bloques.map((b) => `${b.bloque_codigo} (${fmtQty(b.cantidad)})`).join(', ') || 'Vacío',
        Estado: p.stock > 0 ? (p.bloques.length > 1 ? 'Múltiple' : 'Ocupado') : 'Vacío',
      }))
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, sectores[activeSectorIdx]?.nombre ?? 'Sectores')
      XLSX.writeFile(wb, `sectores_${sectores[activeSectorIdx]?.nombre ?? 'export'}.xlsx`)
      toast.success('Excel exportado')
    } catch {
      toast.error('Error al exportar')
    }
  }

  // ── Operation submit handler ──
  async function handleOperationSubmit(params: {
    tipo: 'ingreso' | 'salida' | 'traslado' | 'devolucion'
    bloqueId: string
    cantidad: number
    destinoPosId?: string
    autoCreate?: { codigo: string; descripcion: string; unidad: string }
  }) {
    if (!selectedPos || !perfil) return
    const turno = calcularTurno()

    try {
      let finalBloqueId = params.bloqueId

      // Auto-create block if needed
      if (!finalBloqueId && params.autoCreate) {
        const newBloques = await crearBloque(params.autoCreate.codigo, params.autoCreate.descripcion, params.autoCreate.unidad)
        finalBloqueId = newBloques[0]?.id
        if (!finalBloqueId) throw new Error('No se pudo crear el bloque')
        toast.success(`Bloque ${params.autoCreate.codigo} creado automáticamente`)
      }

      if (!finalBloqueId) throw new Error('Bloque no encontrado')

      const primerNivel = await obtenerPrimerNivel(selectedPos.posicionId)
      if (!primerNivel) throw new Error('Posición sin niveles')

      if (params.tipo === 'traslado' && params.destinoPosId) {
        const destinoNivel = await obtenerPrimerNivel(params.destinoPosId)
        if (!destinoNivel) throw new Error('Posición destino sin niveles')

        // Register salida from origin
        await registrarMovimiento('salida', turno, [
          { nivel_id: primerNivel, bloque_id: finalBloqueId, cantidad: params.cantidad },
        ])
        // Register ingreso to destination
        await registrarMovimiento('ingreso', turno, [
          { nivel_id: destinoNivel, bloque_id: finalBloqueId, cantidad: params.cantidad },
        ])
        toast.success('Traslado registrado')
      } else {
        const movTipo = params.tipo === 'devolucion' ? 'ingreso' : params.tipo
        await registrarMovimiento(movTipo, turno, [
          { nivel_id: primerNivel, bloque_id: finalBloqueId, cantidad: params.cantidad },
        ])
        toast.success(`${params.tipo.charAt(0).toUpperCase() + params.tipo.slice(1)} registrado`)
      }

      setOperation('none')
      // Refresh position detail
      const details = await stockDetallePosicion(selectedPos.posicionId)
      setDetailStock(details)
      // Refresh grid
      const data = await cargarPosicionesSector(sectores[activeSectorIdx].id)
      setPosiciones(data)
      // Update selected pos in case stock changed
      const updated = data.find((p) => p.posicionId === selectedPos.posicionId)
      if (updated) setSelectedPos(updated)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error en operación', { description: message })
    }
  }

  return (
    <div className="min-h-screen -m-4 md:-m-6 p-4 md:p-6" style={{ background: C.bgDeep }}>
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tight" style={{ color: C.textWhite }}>
            Vista 3D — Sectores
          </h2>
          <p className="text-sm mt-1" style={{ color: C.textMuted }}>
            Visualización isométrica del almacén de piso
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: C.textDark }} />
            <Input
              value={searchCode}
              onChange={(e) => setSearchCode(e.target.value)}
              placeholder="Buscar bloque..."
              className="pl-9 w-48 md:w-64 h-9 text-sm rounded-lg border-0 focus-visible:ring-1"
              style={{
                background: C.bgElevated,
                color: C.textWhite,
              }}
            />
            {searchCode && (
              <button
                onClick={() => setSearchCode('')}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              >
                <X className="h-3.5 w-3.5" style={{ color: C.textMuted }} />
              </button>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={loadingPos}
            className="h-9 w-9 rounded-lg"
            style={{ color: C.textLight }}
          >
            <RefreshCw className={`h-4 w-4 ${loadingPos ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleExport}
            disabled={posiciones.length === 0}
            className="h-9 w-9 rounded-lg"
            style={{ color: C.textLight }}
            title="Exportar a Excel"
          >
            <FileSpreadsheet className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ─── SECTOR SELECTOR ─── */}
      {sectores.length > 0 && (
        <SectorPillSelector
          sectores={sectores}
          activeIdx={activeSectorIdx}
          onSelect={setActiveSectorIdx}
        />
      )}

      {sectores.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Layers3 className="h-12 w-12" style={{ color: C.textDark }} />
          <p className="text-center" style={{ color: C.textMuted }}>
            No hay sectores configurados. Ve a la pestaña Config. para crear uno.
          </p>
        </div>
      )}

      {/* ─── STATS BAR ─── */}
      {sectores.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6 mb-6">
          <StatCard
            label="Total posiciones"
            value={stats.total}
            icon={<Grid3X3 className="h-4 w-4" />}
            gradient="linear-gradient(135deg, #303060, #1a1a4e)"
          />
          <StatCard
            label="Ocupadas"
            value={stats.occupied}
            icon={<Package className="h-4 w-4" />}
            gradient="linear-gradient(135deg, #0060f0, #0040b0)"
            glow={C.occupiedGlow}
          />
          <StatCard
            label="Vacías"
            value={stats.empty}
            icon={<Box className="h-4 w-4" />}
            gradient="linear-gradient(135deg, #003030, #002020)"
            glow={C.emptyGlow}
          />
          <StatCard
            label="Ocupación"
            value={stats.pct}
            suffix="%"
            icon={<MapPin className="h-4 w-4" />}
            gradient="linear-gradient(135deg, #303060, #1a1a4e)"
          />
        </div>
      )}

      {/* ─── LEGEND ─── */}
      <div className="flex flex-wrap items-center gap-4 mb-4 px-1">
        <span className="text-xs font-medium" style={{ color: C.textMuted }}>Leyenda:</span>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm" style={{ background: C.occupied, boxShadow: `0 0 6px ${C.occupiedGlow}` }} />
          <span className="text-xs" style={{ color: C.textLight }}>Ocupado</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm" style={{ background: C.multi, boxShadow: `0 0 6px ${C.multiGlow}` }} />
          <span className="text-xs" style={{ color: C.textLight }}>Múltiple</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm" style={{ background: C.empty, boxShadow: `0 0 6px ${C.emptyGlow}` }} />
          <span className="text-xs" style={{ color: C.textLight }}>Vacío</span>
        </div>
        {searchCode && (
          <div className="flex items-center gap-1.5 ml-2">
            <Search className="h-3 w-3" style={{ color: C.multiLight }} />
            <span className="text-xs" style={{ color: C.multiLight }}>
              {filteredPos.length} resultado(s) para &quot;{searchCode}&quot;
            </span>
          </div>
        )}
      </div>

      {/* ─── 3D WAREHOUSE GRID ─── */}
      {loadingPos ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: C.textLight }} />
          <p className="text-sm" style={{ color: C.textMuted }}>Cargando posiciones...</p>
        </div>
      ) : posiciones.length > 0 ? (
        <div
          className="space-y-8 overflow-x-auto pb-8"
          style={{ perspective: '1400px' }}
        >
          {columnLetters.map((letter) => (
            <ColumnShelf
              key={letter}
              letter={letter}
              subcolumns={grouped.get(letter)!}
              selectedPosId={selectedPos?.posicionId ?? null}
              onPosClick={handlePosClick}
            />
          ))}
        </div>
      ) : sectores.length > 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Box className="h-10 w-10" style={{ color: C.textDark }} />
          <p className="text-sm" style={{ color: C.textMuted }}>Sin posiciones en este sector</p>
        </div>
      ) : null}

      {/* ─── POSITION DETAIL DIALOG ─── */}
      <Dialog
        open={!!selectedPos}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPos(null)
            setOperation('none')
          }
        }}
      >
        <DialogContent
          className="max-w-lg sm:max-w-xl max-h-[90vh] overflow-y-auto"
          style={{
            background: 'rgba(16, 16, 58, 0.92)',
            backdropFilter: 'blur(24px)',
            border: `1px solid ${C.borderBlue}`,
            borderRadius: '16px',
          }}
          showCloseButton
        >
          {selectedPos && (
            <PositionDetailContent
              posicion={selectedPos}
              detailStock={detailStock}
              detailLoading={detailLoading}
              operation={operation}
              setOperation={setOperation}
              allPositions={posiciones}
              onSubmit={handleOperationSubmit}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Sector Pill Selector ────────────────────────────────

function SectorPillSelector({
  sectores,
  activeIdx,
  onSelect,
}: {
  sectores: Sector[]
  activeIdx: number
  onSelect: (idx: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([])

  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    const pill = pillRefs.current[activeIdx]
    const container = containerRef.current
    if (!pill || !container) return

    const containerRect = container.getBoundingClientRect()
    const pillRect = pill.getBoundingClientRect()

    setIndicatorStyle({
      position: 'absolute',
      left: pillRect.left - containerRect.left,
      top: pillRect.top - containerRect.top,
      width: pillRect.width,
      height: pillRect.height,
      borderRadius: '9999px',
      background: `linear-gradient(135deg, ${C.occupied}, ${C.occupiedLight})`,
      boxShadow: `0 0 20px ${C.occupiedGlow}`,
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      zIndex: 0,
    })
  }, [activeIdx])

  return (
    <div
      ref={containerRef}
      className="relative flex flex-wrap gap-2 p-1.5 rounded-2xl"
      style={{ background: C.bgCard, border: `1px solid ${C.borderBlue}` }}
    >
      <div style={indicatorStyle} />
      {sectores.map((s, i) => (
        <button
          key={s.id}
          ref={(el) => { pillRefs.current[i] = el }}
          onClick={() => onSelect(i)}
          className="relative z-10 px-4 py-2 text-sm font-medium rounded-full transition-colors"
          style={{
            color: i === activeIdx ? C.textWhite : C.textMuted,
          }}
        >
          {s.nombre}
          <span className="ml-1.5 text-xs opacity-60">{s.prefijo}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Stat Card ───────────────────────────────────────────

function StatCard({
  label,
  value,
  suffix = '',
  icon,
  gradient,
  glow,
}: {
  label: string
  value: number
  suffix?: string
  icon: React.ReactNode
  gradient: string
  glow?: string
}) {
  return (
    <div
      className="rounded-xl p-4 relative overflow-hidden"
      style={{
        background: gradient,
        border: `1px solid ${C.borderBlue}`,
        boxShadow: glow ? `0 4px 24px ${glow}` : undefined,
      }}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: C.textMuted }}>
            {label}
          </p>
          <p className="text-2xl md:text-3xl font-bold mt-1 tabular-nums" style={{ color: C.textWhite }}>
            <AnimatedNumber target={value} />
            {suffix}
          </p>
        </div>
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.08)', color: C.textLight }}
        >
          {icon}
        </div>
      </div>
    </div>
  )
}

// ─── Column Shelf (3D Container) ─────────────────────────

function ColumnShelf({
  letter,
  subcolumns,
  selectedPosId,
  onPosClick,
}: {
  letter: string
  subcolumns: Map<string, PosicionConStock[]>
  selectedPosId: string | null
  onPosClick: (pos: PosicionConStock) => void
}) {
  const subKeys = Array.from(subcolumns.keys()).sort()

  return (
    <div
      className="rounded-2xl p-4 md:p-5"
      style={{
        background: C.bgCard,
        border: `1px solid ${C.borderBlue}`,
        transform: 'rotateX(4deg) rotateY(-1deg)',
        transformOrigin: 'center bottom',
        boxShadow: `
          0 20px 60px rgba(0,0,0,0.5),
          0 0 40px rgba(0,96,240,0.06),
          inset 0 1px 0 rgba(255,255,255,0.04)
        `,
      }}
    >
      {/* Column header */}
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-lg"
          style={{
            background: `linear-gradient(135deg, ${C.occupied}, ${C.occupiedLight})`,
            color: C.textWhite,
            boxShadow: `0 0 16px ${C.occupiedGlow}`,
          }}
        >
          {letter}
        </div>
        <div>
          <h3 className="font-semibold text-sm" style={{ color: C.textWhite }}>
            Columna {letter}
          </h3>
          <p className="text-xs" style={{ color: C.textDark }}>
            {subKeys.length} subcolumna{subKeys.length !== 1 ? 's' : ''} · {Array.from(subcolumns.values()).flat().length} posiciones
          </p>
        </div>
      </div>

      {/* Subcolumn groups */}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(subKeys.length, 6)}, minmax(0, 1fr))` }}>
        {subKeys.map((subKey) => (
          <SubcolumnGroup
            key={subKey}
            subKey={subKey}
            positions={subcolumns.get(subKey)!}
            selectedPosId={selectedPosId}
            onPosClick={onPosClick}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Subcolumn Group ─────────────────────────────────────

function SubcolumnGroup({
  subKey,
  positions,
  selectedPosId,
  onPosClick,
}: {
  subKey: string
  positions: PosicionConStock[]
  selectedPosId: string | null
  onPosClick: (pos: PosicionConStock) => void
}) {
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: C.bgElevated, border: `1px solid rgba(48,48,96,0.5)` }}
    >
      <p className="text-xs font-medium mb-2 tracking-wide uppercase" style={{ color: C.textDark }}>
        {subKey}
      </p>
      <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))' }}>
        {positions.map((pos) => (
          <PositionCell3D
            key={pos.posicionId}
            pos={pos}
            isSelected={pos.posicionId === selectedPosId}
            onClick={() => onPosClick(pos)}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Position Cell (3D) ──────────────────────────────────

function PositionCell3D({
  pos,
  isSelected,
  onClick,
}: {
  pos: PosicionConStock
  isSelected: boolean
  onClick: () => void
}) {
  const isEmpty = pos.stock === 0
  const isMulti = pos.bloques.length > 1
  const isOccupied = pos.stock > 0

  const bgColor = isEmpty ? C.empty : isMulti ? C.multi : C.occupied
  const glowColor = isEmpty ? C.emptyGlow : isMulti ? C.multiGlow : C.occupiedGlow
  const topColor = isEmpty ? C.emptyLight : isMulti ? C.multiLight : C.occupiedLight

  return (
    <button
      onClick={onClick}
      className="relative group cursor-pointer transition-all duration-200 hover:scale-105 focus:outline-none"
      style={{
        width: '36px',
        height: '36px',
        minWidth: '36px',
      }}
      title={`${pos.columnaLetra}-${pos.subcolumnaCodigo}-${pos.posicionNumero} | Stock: ${fmtQty(pos.stock)}`}
    >
      {/* Main face */}
      <div
        className="absolute inset-0 rounded-md flex flex-col items-center justify-center transition-all duration-200"
        style={{
          background: `linear-gradient(180deg, ${topColor}22, ${bgColor})`,
          border: `1px solid ${bgColor}66`,
          boxShadow: isSelected
            ? `0 0 0 2px ${C.textWhite}, 0 0 20px ${glowColor}`
            : `0 3px 8px rgba(0,0,0,0.4), 0 0 8px ${glowColor}`,
          zIndex: 2,
        }}
      >
        {/* Stock count */}
        {isOccupied && (
          <span
            className="text-[11px] font-bold leading-none"
            style={{ color: C.textWhite }}
          >
            {fmtQty(pos.stock)}
          </span>
        )}

        {/* Icon */}
        {isOccupied && !isMulti && (
          <Package
            className="h-2.5 w-2.5 mt-0.5"
            style={{ color: `${C.textWhite}88` }}
          />
        )}
        {isMulti && (
          <Layers3
            className="h-2.5 w-2.5 mt-0.5"
            style={{ color: C.textWhite }}
          />
        )}

        {/* Empty dot */}
        {isEmpty && (
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: `${C.emptyLight}44` }}
          />
        )}

        {/* Position number */}
        <span
          className="text-[9px] mt-0.5 leading-none font-medium"
          style={{ color: C.textLight }}
        >
          {pos.posicionNumero}
        </span>
      </div>

      {/* 3D Side face (right) */}
      <div
        className="absolute top-[2px] right-[-3px] w-[3px] rounded-r-sm"
        style={{
          height: 'calc(100% - 2px)',
          background: `linear-gradient(90deg, ${bgColor}aa, ${bgColor}55)`,
          transform: 'skewY(-10deg)',
          transformOrigin: 'top left',
          zIndex: 1,
        }}
      />

      {/* 3D Bottom face */}
      <div
        className="absolute bottom-[-3px] left-[2px] h-[3px] rounded-b-sm"
        style={{
          width: 'calc(100% - 2px)',
          background: `linear-gradient(180deg, ${bgColor}aa, ${bgColor}44)`,
          transform: 'skewX(-10deg)',
          transformOrigin: 'top left',
          zIndex: 1,
        }}
      />
    </button>
  )
}

// ─── Position Detail Dialog Content ──────────────────────

function PositionDetailContent({
  posicion,
  detailStock,
  detailLoading,
  operation,
  setOperation,
  allPositions,
  onSubmit,
}: {
  posicion: PosicionConStock
  detailStock: DetailStock[]
  detailLoading: boolean
  operation: 'none' | 'ingreso' | 'salida' | 'traslado' | 'devolucion'
  setOperation: (op: 'none' | 'ingreso' | 'salida' | 'traslado' | 'devolucion') => void
  allPositions: PosicionConStock[]
  onSubmit: (params: {
    tipo: 'ingreso' | 'salida' | 'traslado' | 'devolucion'
    bloqueId: string
    cantidad: number
    destinoPosId?: string
    autoCreate?: { codigo: string; descripcion: string; unidad: string }
  }) => void
}) {
  const isMulti = posicion.bloques.length > 1
  const isEmpty = posicion.stock === 0
  const statusColor = isEmpty ? C.emptyLight : isMulti ? C.multi : C.occupied
  const statusLabel = isEmpty ? 'Vacío' : isMulti ? 'Múltiple' : 'Ocupado'

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: `${statusColor}22`,
              border: `1px solid ${statusColor}44`,
              color: statusColor,
            }}
          >
            <MapPin className="h-5 w-5" />
          </div>
          <div>
            <DialogTitle style={{ color: C.textWhite }}>
              {posicion.columnaLetra} - {posicion.subcolumnaCodigo} - Pos. {posicion.posicionNumero}
            </DialogTitle>
            <DialogDescription style={{ color: C.textMuted }}>
              {posicion.bloques.length} artículo{posicion.bloques.length !== 1 ? 's' : ''} · Stock: {fmtQty(posicion.stock)}
            </DialogDescription>
          </div>
          <Badge
            className="ml-auto"
            style={{
              background: `${statusColor}22`,
              color: statusColor,
              border: `1px solid ${statusColor}44`,
            }}
          >
            {statusLabel}
          </Badge>
        </div>
      </DialogHeader>

      {/* ── Stock Detail ── */}
      {detailLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: C.textLight }} />
        </div>
      ) : detailStock.length > 0 ? (
        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {detailStock.map((d, i) => (
            <div
              key={`${d.bloque_id}-${d.nivel_numero}-${i}`}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{ background: C.bgElevated, border: `1px solid ${C.borderBlue}44` }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium" style={{ color: C.textWhite }}>
                    {d.bloque_codigo}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: `${C.occupied}22`, color: C.textLight }}>
                    N{d.nivel_numero}
                  </span>
                </div>
                {d.bloque_descripcion && (
                  <p className="text-xs truncate mt-0.5" style={{ color: C.textMuted }}>
                    {d.bloque_descripcion}
                  </p>
                )}
              </div>
              <div className="text-right ml-3 shrink-0">
                <p className="text-sm font-bold tabular-nums" style={{ color: C.textWhite }}>
                  {fmtQty(d.cantidad)}
                </p>
                <p className="text-xs" style={{ color: C.textDark }}>{d.bloque_unidad}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-6">
          <Box className="h-8 w-8 mx-auto mb-2" style={{ color: C.textDark }} />
          <p className="text-sm" style={{ color: C.textMuted }}>Posición vacía — registra un ingreso</p>
        </div>
      )}

      {/* ── Operation Buttons ── */}
      {operation === 'none' && (
        <div className="grid grid-cols-2 gap-2 mt-4 pt-4" style={{ borderTop: `1px solid ${C.borderBlue}44` }}>
          <OpButton icon={<ArrowDownToLine className="h-4 w-4" />} label="Ingreso" color="#00884a" onClick={() => setOperation('ingreso')} />
          <OpButton icon={<ArrowUpFromLine className="h-4 w-4" />} label="Salida" color="#b91c1c" onClick={() => setOperation('salida')} disabled={isEmpty} />
          <OpButton icon={<ArrowRightLeft className="h-4 w-4" />} label="Traslado" color={C.occupied} onClick={() => setOperation('traslado')} disabled={isEmpty} />
          <OpButton icon={<RotateCcw className="h-4 w-4" />} label="Devolución" color={C.multi} onClick={() => setOperation('devolucion')} />
        </div>
      )}

      {/* ── Operation Form ── */}
      {operation !== 'none' && (
        <OperationForm
          tipo={operation}
          posicion={posicion}
          allPositions={allPositions}
          detailStock={detailStock}
          onSubmit={onSubmit}
          onCancel={() => setOperation('none')}
        />
      )}
    </>
  )
}

// ─── Operation Button ────────────────────────────────────

function OpButton({
  icon,
  label,
  color,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode
  label: string
  color: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-sm font-medium transition-all duration-200 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: `${color}22`,
        border: `1px solid ${color}44`,
        color: disabled ? C.textDark : color,
      }}
    >
      {icon}
      {label}
    </button>
  )
}

// ─── Operation Form ──────────────────────────────────────

function OperationForm({
  tipo,
  posicion,
  allPositions,
  detailStock,
  onSubmit,
  onCancel,
}: {
  tipo: 'ingreso' | 'salida' | 'traslado' | 'devolucion'
  posicion: PosicionConStock
  allPositions: PosicionConStock[]
  detailStock: DetailStock[]
  onSubmit: (params: {
    tipo: 'ingreso' | 'salida' | 'traslado' | 'devolucion'
    bloqueId: string
    cantidad: number
    destinoPosId?: string
    autoCreate?: { codigo: string; descripcion: string; unidad: string }
  }) => void
  onCancel: () => void
}) {
  const [bloqueQuery, setBloqueQuery] = useState('')
  const [bloqueOptions, setBloqueOptions] = useState<BloqueOption[]>([])
  const [selectedBloque, setSelectedBloque] = useState<BloqueOption | null>(null)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [cantidad, setCantidad] = useState('')
  const [destinoQuery, setDestinoQuery] = useState('')
  const [destinoPos, setDestinoPos] = useState<PosicionConStock | null>(null)
  const [showDestinoList, setShowDestinoList] = useState(false)
  const [busy, setBusy] = useState(false)

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const isSalida = tipo === 'salida'
  const isTraslado = tipo === 'traslado'
  const isIngreso = tipo === 'ingreso'
  const isDevolucion = tipo === 'devolucion'

  // For salida/traslado, pre-select the first block from detailStock
  useEffect(() => {
    if ((isSalida || isTraslado) && detailStock.length > 0 && !selectedBloque) {
      const first = detailStock[0]
      setSelectedBloque({
        id: first.bloque_id,
        codigo: first.bloque_codigo,
        descripcion: first.bloque_descripcion,
        unidad: first.bloque_unidad,
      })
      setBloqueQuery(first.bloque_codigo)
    }
  }, [isSalida, isTraslado, detailStock, selectedBloque])

  // Load block options on mount
  useEffect(() => {
    listarBloquesParaSelect()
      .then(setBloqueOptions)
      .catch(() => {})
  }, [])

  // Autocomplete search
  const handleBlockSearch = useCallback((q: string) => {
    setBloqueQuery(q)
    setSelectedBloque(null)
    setShowAutocomplete(true)

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    if (q.trim().length < 1) {
      setBloqueOptions([])
      return
    }

    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await buscarBloquePorCodigo(q.trim())
        if (results) {
          setBloqueOptions([{
            id: results.id,
            codigo: results.codigo,
            descripcion: results.descripcion,
            unidad: results.unidad,
          }])
        } else {
          // Also try listing and filtering client-side
          const all = await listarBloquesParaSelect()
          const upper = q.trim().toUpperCase()
          const filtered = all.filter(
            (b) => b.codigo.includes(upper) || b.descripcion.toUpperCase().includes(upper)
          ).slice(0, 10)
          setBloqueOptions(filtered)
        }
      } catch {
        setBloqueOptions([])
      }
    }, 250)
  }, [])

  // Destino search for traslado
  const filteredDestinos = useMemo(() => {
    if (!destinoQuery.trim()) return []
    const q = destinoQuery.trim().toUpperCase()
    return allPositions
      .filter(
        (p) =>
          p.posicionId !== posicion.posicionId &&
          (`${p.columnaLetra}-${p.subcolumnaCodigo}-${p.posicionNumero}`.toUpperCase().includes(q) ||
            p.bloques.some((b) => b.bloque_codigo.includes(q)))
      )
      .slice(0, 8)
  }, [destinoQuery, allPositions, posicion.posicionId])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return

    if (isTraslado && !destinoPos) {
      toast.error('Selecciona posición destino')
      return
    }

    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('Cantidad inválida')
      return
    }

    setBusy(true)
    try {
      if (selectedBloque) {
        onSubmit({
          tipo,
          bloqueId: selectedBloque.id,
          cantidad: qty,
          destinoPosId: destinoPos?.posicionId,
        })
      } else if (bloqueQuery.trim()) {
        // Manual code entry — auto-create
        onSubmit({
          tipo,
          bloqueId: '',
          cantidad: qty,
          destinoPosId: destinoPos?.posicionId,
          autoCreate: {
            codigo: bloqueQuery.trim(),
            descripcion: `Creado desde Piso - ${posicion.columnaLetra}${posicion.subcolumnaCodigo}${posicion.posicionNumero}`,
            unidad: 'UN',
          },
        })
      } else {
        toast.error('Selecciona o ingresa un código de bloque')
      }
    } finally {
      setBusy(false)
    }
  }

  const tipoLabels: Record<string, string> = {
    ingreso: 'Ingreso',
    salida: 'Salida',
    traslado: 'Traslado',
    devolucion: 'Devolución',
  }
  const tipoColors: Record<string, string> = {
    ingreso: '#00884a',
    salida: '#b91c1c',
    traslado: C.occupied,
    devolucion: C.multi,
  }
  const currentColor = tipoColors[tipo]

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-4 pt-4" style={{ borderTop: `1px solid ${C.borderBlue}44` }}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold" style={{ color: currentColor }}>
          {tipoLabels[tipo]}
        </h4>
        <button type="button" onClick={onCancel} className="text-xs" style={{ color: C.textMuted }}>
          Cancelar
        </button>
      </div>

      {/* Block code autocomplete */}
      <div className="relative">
        <Label className="text-xs" style={{ color: C.textMuted }}>Código de bloque</Label>
        <div className="relative mt-1">
          <Input
            value={bloqueQuery}
            onChange={(e) => handleBlockSearch(e.target.value)}
            onFocus={() => { if (bloqueQuery.trim()) setShowAutocomplete(true) }}
            onBlur={() => setTimeout(() => setShowAutocomplete(false), 200)}
            placeholder="Escribe código..."
            className="h-9 text-sm rounded-lg border-0 focus-visible:ring-1"
            style={{ background: C.bgElevated, color: C.textWhite, paddingRight: selectedBloque ? '2.5rem' : undefined }}
          />
          {selectedBloque && (
            <Check className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: '#00884a' }} />
          )}
        </div>

        {/* Autocomplete dropdown */}
        {showAutocomplete && bloqueOptions.length > 0 && (
          <div
            className="absolute z-50 w-full mt-1 rounded-lg shadow-xl overflow-hidden max-h-40 overflow-y-auto"
            style={{
              background: C.bgCard,
              border: `1px solid ${C.borderBlue}`,
            }}
          >
            {bloqueOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setSelectedBloque(opt)
                  setBloqueQuery(opt.codigo)
                  setShowAutocomplete(false)
                }}
                className="w-full text-left px-3 py-2 flex items-center justify-between hover:brightness-110 transition-colors"
                style={{ color: C.textWhite }}
              >
                <div>
                  <span className="font-mono text-sm font-medium">{opt.codigo}</span>
                  {opt.descripcion && (
                    <span className="text-xs ml-2" style={{ color: C.textMuted }}>{opt.descripcion}</span>
                  )}
                </div>
                <span className="text-xs" style={{ color: C.textDark }}>{opt.unidad}</span>
              </button>
            ))}
            {/* Fallback: manual entry option */}
            {bloqueQuery.trim() && !bloqueOptions.some((o) => o.codigo.toUpperCase() === bloqueQuery.trim().toUpperCase()) && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setSelectedBloque(null)
                  setShowAutocomplete(false)
                }}
                className="w-full text-left px-3 py-2 text-sm border-t flex items-center gap-2"
                style={{
                  color: C.multiLight,
                  borderTopColor: `${C.borderBlue}44`,
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                Crear &quot;{bloqueQuery.trim().toUpperCase()}&quot;
              </button>
            )}
          </div>
        )}

        {selectedBloque && (
          <p className="text-xs mt-1" style={{ color: C.textMuted }}>
            {selectedBloque.descripcion} ({selectedBloque.unidad})
          </p>
        )}
        {!selectedBloque && bloqueQuery.trim() && bloqueOptions.length === 0 && (
          <p className="text-xs mt-1" style={{ color: C.multiLight }}>
            No encontrado — se creará automáticamente al registrar
          </p>
        )}
      </div>

      {/* Quantity */}
      <div>
        <Label className="text-xs" style={{ color: C.textMuted }}>
          Cantidad {selectedBloque ? `(${selectedBloque.unidad})` : ''}
        </Label>
        <Input
          type="number"
          step="any"
          min="0.001"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="0"
          className="h-9 text-sm mt-1 rounded-lg border-0 focus-visible:ring-1"
          style={{ background: C.bgElevated, color: C.textWhite }}
        />
      </div>

      {/* Destino for traslado */}
      {isTraslado && (
        <div className="relative">
          <Label className="text-xs" style={{ color: C.textMuted }}>Posición destino</Label>
          <Input
            value={destinoQuery}
            onChange={(e) => {
              setDestinoQuery(e.target.value)
              setDestinoPos(null)
              setShowDestinoList(true)
            }}
            onFocus={() => { if (destinoQuery.trim()) setShowDestinoList(true) }}
            onBlur={() => setTimeout(() => setShowDestinoList(false), 200)}
            placeholder="Buscar destino..."
            className="h-9 text-sm mt-1 rounded-lg border-0 focus-visible:ring-1"
            style={{ background: C.bgElevated, color: C.textWhite, paddingRight: destinoPos ? '2.5rem' : undefined }}
          />
          {destinoPos && (
            <Check className="absolute right-2.5 top-[calc(50%+10px)] -translate-y-1/2 h-4 w-4" style={{ color: '#00884a' }} />
          )}

          {showDestinoList && filteredDestinos.length > 0 && (
            <div
              className="absolute z-50 w-full mt-1 rounded-lg shadow-xl overflow-hidden max-h-32 overflow-y-auto"
              style={{ background: C.bgCard, border: `1px solid ${C.borderBlue}` }}
            >
              {filteredDestinos.map((p) => (
                <button
                  key={p.posicionId}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setDestinoPos(p)
                    setDestinoQuery(`${p.columnaLetra}-${p.subcolumnaCodigo}-${p.posicionNumero}`)
                    setShowDestinoList(false)
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:brightness-110 transition-colors"
                  style={{ color: C.textWhite }}
                >
                  <span className="font-mono">{p.columnaLetra}-{p.subcolumnaCodigo}-{p.posicionNumero}</span>
                  <span className="ml-2 text-xs" style={{ color: C.textDark }}>
                    Stock: {fmtQty(p.stock)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Button
        type="submit"
        disabled={busy || !cantidad || (isTraslado && !destinoPos)}
        className="w-full h-10 rounded-lg text-sm font-medium gap-2"
        style={{
          background: `${currentColor}dd`,
          color: C.textWhite,
        }}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            {isIngreso && <ArrowDownToLine className="h-4 w-4" />}
            {isSalida && <ArrowUpFromLine className="h-4 w-4" />}
            {isTraslado && <ArrowRightLeft className="h-4 w-4" />}
            {isDevolucion && <RotateCcw className="h-4 w-4" />}
          </>
        )}
        Registrar {tipoLabels[tipo]}
      </Button>
    </form>
  )
}
