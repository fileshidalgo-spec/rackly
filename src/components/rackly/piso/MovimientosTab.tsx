'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  listarSectores,
  listarColumnas,
  listarSubcolumnas,
  listarNivelesDeSubcolumna,
  listarBloques,
  listarBloquesDeColumna,
  listarBloquesParaSelect,
  registrarMovimiento,
  registrarDevolucionPosicion,
  calcularStockNivel,
  type Sector,
  type Columna,
  type Subcolumna,
} from '@/lib/piso/api'
import { calcularTurno } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { Loader2, ArrowDownToLine, ArrowUpFromLine, History, Filter, X, RotateCcw, Search, Plus, Trash2, Package } from 'lucide-react'

export function MovimientosTab() {
  return (
    <Tabs defaultValue="ingreso" className="w-full">
      <TabsList className="grid w-full grid-cols-4 bg-slate-800 border border-slate-700">
        <TabsTrigger value="ingreso" className="gap-2 data-[state=active]:bg-emerald-600 data-[state=active]:text-white text-slate-400">
          <ArrowDownToLine className="h-4 w-4" /> Ingreso
        </TabsTrigger>
        <TabsTrigger value="salida" className="gap-2 data-[state=active]:bg-red-600 data-[state=active]:text-white text-slate-400">
          <ArrowUpFromLine className="h-4 w-4" /> Salida
        </TabsTrigger>
        <TabsTrigger value="devolucion" className="gap-2 data-[state=active]:bg-amber-600 data-[state=active]:text-white text-slate-400">
          <RotateCcw className="h-4 w-4" /> Devolución
        </TabsTrigger>
        <TabsTrigger value="historial" className="gap-2 data-[state=active]:bg-sky-600 data-[state=active]:text-white text-slate-400">
          <History className="h-4 w-4" /> Historial
        </TabsTrigger>
      </TabsList>
      <TabsContent value="ingreso" className="mt-4">
        <IngresoRapido />
      </TabsContent>
      <TabsContent value="salida" className="mt-4">
        <SalidaMasiva />
      </TabsContent>
      <TabsContent value="devolucion" className="mt-4">
        <DevolucionRapida />
      </TabsContent>
      <TabsContent value="historial" className="mt-4">
        <Historial />
      </TabsContent>
    </Tabs>
  )
}

function IngresoRapido() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [columnaId, setColumnaId] = useState('')
  const [subcolumnas, setSubcolumnas] = useState<Subcolumna[]>([])
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set())
  const [bloqueId, setBloqueId] = useState('')
  const [bloques, setBloques] = useState<{ id: string; codigo: string }[]>([])
  const [bloqueSearch, setBloqueSearch] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [busy, setBusy] = useState(false)
  const [gridData, setGridData] = useState<{
    posicion: { numero: number }
    niveles: { id: string; numero: number; codigo_ubicacion: string | null }[]
  }[]>([])

  const [allBloques, setAllBloques] = useState<{ id: string; codigo: string; descripcion: string }[]>([])

  useEffect(() => {
    listarSectores().then(setSectores).catch(() => {})
    listarBloquesParaSelect().then((b) => setAllBloques(b.map((x) => ({ id: x.id, codigo: x.codigo, descripcion: x.descripcion })))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sectorId) return
    listarColumnas(sectorId).then(setColumnas).catch(() => {})
  }, [sectorId])

  useEffect(() => {
    if (!columnaId) return
    listarSubcolumnas(columnaId).then(setSubcolumnas).catch(() => {})
    listarBloquesDeColumna(columnaId).then(setBloques).catch(() => {})
  }, [columnaId])

  useEffect(() => {
    if (subcolumnas.length === 0) { setGridData([]); return }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id)))
      .then((results) => { setGridData(results.flat()) })
      .catch(() => {})
  }, [subcolumnas])

  // Filtrar bloques por búsqueda
  const filteredBloques = useMemo(() => {
    const q = bloqueSearch.trim().toLowerCase()
    if (!q) return bloques
    return bloques.filter((b) => b.codigo.toLowerCase().includes(q))
  }, [bloques, bloqueSearch])

  function toggleLevel(nivelId: string) {
    setSelectedLevels((prev) => {
      const next = new Set(prev)
      if (next.has(nivelId)) next.delete(nivelId)
      else next.add(nivelId)
      return next
    })
  }

  async function handleIngreso() {
    if (!bloqueId || selectedLevels.size === 0 || !cantidad || !perfil) {
      toast.error('Selecciona bloque, niveles y cantidad')
      return
    }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels).map((nivelId) => ({
        nivel_id: nivelId, bloque_id: bloqueId, cantidad: qty,
      }))
      await registrarMovimiento('ingreso', calcularTurno(), detalles)
      toast.success(`Ingreso registrado en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Set()); setCantidad('')
    } catch (err: unknown) {
      toast.error('Error al registrar', { description: err instanceof Error ? err.message : '' })
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Sector</Label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {sectores.map((s) => <SelectItem key={s.id} value={s.id} className="text-white focus:bg-slate-700">{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Columna</Label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {columnas.map((c) => <SelectItem key={c.id} value={c.id} className="text-white focus:bg-slate-700">{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Bloque</Label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
            <input type="text" value={bloqueSearch} onChange={(e) => setBloqueSearch(e.target.value)} placeholder="Buscar..."
              className="w-full h-8 rounded-md border border-slate-700 text-xs bg-slate-800 text-white placeholder-slate-500 pl-7 pr-2 mb-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/50" />
          </div>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {filteredBloques.map((b) => <SelectItem key={b.id} value={b.id} className="text-white focus:bg-slate-700">{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-slate-400">Cantidad</Label>
        <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad para todos los niveles seleccionados" className="max-w-xs bg-slate-800 border-slate-700 text-white focus:ring-emerald-500/50" />
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-slate-400">Selecciona niveles (haz clic en las celdas). Seleccionados: {selectedLevels.size}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="border border-slate-700 rounded-lg p-3 bg-slate-800/50">
                <p className="text-sm font-medium text-slate-300 mb-2">{sc.codigo}</p>
                {gridData
                  .filter((_, idx) => idx >= scIdx && idx < scIdx + 1)
                  .map((g, gi) => (
                    <div key={gi} className="flex flex-wrap gap-1 mb-1">
                      <span className="text-xs text-slate-500 w-6">P{g.posicion.numero}</span>
                      {g.niveles.map((n) => (
                        <button key={n.id} type="button"
                          className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                            selectedLevels.has(n.id)
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                          }`}
                          onClick={() => toggleLevel(n.id)}
                          title={n.codigo_ubicacion || `Nivel ${n.numero}`}>
                          {n.numero}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={handleIngreso} disabled={busy || selectedLevels.size === 0}
        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
        Registrar ingreso ({selectedLevels.size} niveles)
      </Button>
    </div>
  )
}

function SalidaMasiva() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [columnaId, setColumnaId] = useState('')
  const [subcolumnas, setSubcolumnas] = useState<Subcolumna[]>([])
  const [bloqueId, setBloqueId] = useState('')
  const [bloques, setBloques] = useState<{ id: string; codigo: string }[]>([])
  const [bloqueSearch, setBloqueSearch] = useState('')
  const [selectedLevels, setSelectedLevels] = useState<Map<string, number>>(new Map())
  const [busy, setBusy] = useState(false)
  const [gridData, setGridData] = useState<{
    posicion: { numero: number }
    niveles: { id: string; numero: number; codigo_ubicacion: string | null }[]
  }[]>([])
  const [stockData, setStockData] = useState<Map<string, { bloque_codigo: string; cantidad: number }[]>>(new Map())

  useEffect(() => {
    listarSectores().then(setSectores).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sectorId) return
    listarColumnas(sectorId).then(setColumnas).catch(() => {})
  }, [sectorId])

  useEffect(() => {
    if (!columnaId) return
    Promise.all([listarSubcolumnas(columnaId), listarBloquesDeColumna(columnaId)])
      .then(([subs, blqs]) => { setSubcolumnas(subs); setBloques(blqs) }).catch(() => {})
  }, [columnaId])

  useEffect(() => {
    if (subcolumnas.length === 0) { setGridData([]); return }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id)))
      .then((results) => {
        setGridData(results.flat())
        const allNiveles = results.flat().flatMap((r) => r.niveles)
        allNiveles.forEach((n) => {
          calcularStockNivel(n.id).then((stock) => { setStockData((prev) => new Map(prev).set(n.id, stock)) }).catch(() => {})
        })
      }).catch(() => {})
  }, [subcolumnas])

  const filteredBloques = useMemo(() => {
    const q = bloqueSearch.trim().toLowerCase()
    if (!q) return bloques
    return bloques.filter((b) => b.codigo.toLowerCase().includes(q))
  }, [bloques, bloqueSearch])

  function toggleLevel(nivelId: string, availableQty: number) {
    setSelectedLevels((prev) => {
      const next = new Map(prev)
      if (next.has(nivelId)) next.delete(nivelId)
      else next.set(nivelId, availableQty)
      return next
    })
  }

  async function handleSalida() {
    if (!bloqueId || selectedLevels.size === 0 || !perfil) { toast.error('Selecciona bloque y niveles'); return }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels.entries()).map(([nivelId, cantidad]) => ({
        nivel_id: nivelId, bloque_id: bloqueId, cantidad,
      }))
      await registrarMovimiento('salida', calcularTurno(), detalles)
      toast.success(`Salida registrada en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Map())
    } catch (err: unknown) {
      toast.error('Error al registrar', { description: err instanceof Error ? err.message : '' })
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Sector</Label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {sectores.map((s) => <SelectItem key={s.id} value={s.id} className="text-white focus:bg-slate-700">{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Columna</Label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {columnas.map((c) => <SelectItem key={c.id} value={c.id} className="text-white focus:bg-slate-700">{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Bloque</Label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
            <input type="text" value={bloqueSearch} onChange={(e) => setBloqueSearch(e.target.value)} placeholder="Buscar..."
              className="w-full h-8 rounded-md border border-slate-700 text-xs bg-slate-800 text-white placeholder-slate-500 pl-7 pr-2 mb-1 focus:outline-none focus:ring-2 focus:ring-red-500/50" />
          </div>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {filteredBloques.map((b) => <SelectItem key={b.id} value={b.id} className="text-white focus:bg-slate-700">{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-slate-400">Selecciona niveles con stock. Seleccionados: {selectedLevels.size}</p>
          <div className="grid gap-2">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="border border-slate-700 rounded-lg p-3 bg-slate-800/50">
                <p className="text-sm font-medium text-slate-300 mb-2">{sc.codigo}</p>
                <div className="flex flex-wrap gap-1">
                  {gridData.slice(scIdx, scIdx + 1).flatMap((g) =>
                    g.niveles.map((n) => {
                      const stock = stockData.get(n.id) || []
                      const blockStock = stock.find((s) => s.bloque_codigo === bloques.find((b) => b.id === bloqueId)?.codigo)
                      const qty = blockStock?.cantidad || 0
                      const hasStock = qty > 0
                      const isSelected = selectedLevels.has(n.id)
                      return (
                        <button key={n.id} type="button" disabled={!hasStock}
                          className={`w-10 h-10 rounded text-xs font-medium transition-colors ${
                            isSelected ? 'bg-red-600 text-white'
                            : hasStock ? 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                            : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                          }`}
                          onClick={() => hasStock && toggleLevel(n.id, qty)}
                          title={`N${n.numero} - Stock: ${qty}`}>
                          <div>{n.numero}</div>
                          <div className="text-[10px]">{qty}</div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={handleSalida} disabled={busy || selectedLevels.size === 0}
        className="gap-2 bg-red-600 hover:bg-red-700 text-white">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        Registrar salida ({selectedLevels.size} niveles)
      </Button>
    </div>
  )
}

function DevolucionRapida() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [columnaId, setColumnaId] = useState('')
  const [subcolumnas, setSubcolumnas] = useState<Subcolumna[]>([])
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set())
  const [bloqueId, setBloqueId] = useState('')
  const [bloques, setBloques] = useState<{ id: string; codigo: string }[]>([])
  const [bloqueSearch, setBloqueSearch] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [busy, setBusy] = useState(false)
  const [gridData, setGridData] = useState<{
    posicion: { numero: number }
    niveles: { id: string; numero: number; codigo_ubicacion: string | null }[]
  }[]>([])

  useEffect(() => {
    listarSectores().then(setSectores).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sectorId) return
    listarColumnas(sectorId).then(setColumnas).catch(() => {})
  }, [sectorId])

  useEffect(() => {
    if (!columnaId) return
    listarSubcolumnas(columnaId).then(setSubcolumnas).catch(() => {})
    listarBloquesDeColumna(columnaId).then(setBloques).catch(() => {})
  }, [columnaId])

  useEffect(() => {
    if (subcolumnas.length === 0) { setGridData([]); return }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id)))
      .then((results) => { setGridData(results.flat()) })
      .catch(() => {})
  }, [subcolumnas])

  const filteredBloques = useMemo(() => {
    const q = bloqueSearch.trim().toLowerCase()
    if (!q) return bloques
    return bloques.filter((b) => b.codigo.toLowerCase().includes(q))
  }, [bloques, bloqueSearch])

  function toggleLevel(nivelId: string) {
    setSelectedLevels((prev) => {
      const next = new Set(prev)
      if (next.has(nivelId)) next.delete(nivelId)
      else next.add(nivelId)
      return next
    })
  }

  async function handleDevolucion() {
    if (!bloqueId || selectedLevels.size === 0 || !cantidad || !perfil) {
      toast.error('Selecciona bloque, niveles y cantidad')
      return
    }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) { toast.error('Cantidad inválida'); return }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels).map((nivelId) => ({
        nivel_id: nivelId, bloque_id: bloqueId, cantidad: qty,
      }))
      await registrarDevolucionPosicion(calcularTurno(), perfil.id, perfil.nombre ?? '', perfil.correo ?? '', detalles)
      toast.success(`Devolución registrada en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Set()); setCantidad('')
    } catch (err: unknown) {
      toast.error('Error al registrar', { description: err instanceof Error ? err.message : '' })
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-3">
        <p className="text-xs text-amber-400"><strong>Devolución:</strong> Registra artículos que regresan al almacén. Selecciona ubicación y bloque.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Sector</Label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {sectores.map((s) => <SelectItem key={s.id} value={s.id} className="text-white focus:bg-slate-700">{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Columna</Label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {columnas.map((c) => <SelectItem key={c.id} value={c.id} className="text-white focus:bg-slate-700">{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-400">Bloque</Label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
            <input type="text" value={bloqueSearch} onChange={(e) => setBloqueSearch(e.target.value)} placeholder="Buscar código..."
              className="w-full h-8 rounded-md border border-slate-700 text-xs bg-slate-800 text-white placeholder-slate-500 pl-7 pr-2 mb-1 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
          </div>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              {filteredBloques.map((b) => <SelectItem key={b.id} value={b.id} className="text-white focus:bg-slate-700">{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-slate-400">Cantidad</Label>
        <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad para todos los niveles seleccionados" className="max-w-xs bg-slate-800 border-slate-700 text-white focus:ring-amber-500/50" />
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-slate-400">Selecciona niveles. Seleccionados: {selectedLevels.size}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="border border-slate-700 rounded-lg p-3 bg-slate-800/50">
                <p className="text-sm font-medium text-slate-300 mb-2">{sc.codigo}</p>
                {gridData
                  .filter((_, idx) => idx >= scIdx && idx < scIdx + 1)
                  .map((g, gi) => (
                    <div key={gi} className="flex flex-wrap gap-1 mb-1">
                      <span className="text-xs text-slate-500 w-6">P{g.posicion.numero}</span>
                      {g.niveles.map((n) => (
                        <button key={n.id} type="button"
                          className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                            selectedLevels.has(n.id)
                              ? 'bg-amber-600 text-white shadow-sm'
                              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                          }`}
                          onClick={() => toggleLevel(n.id)}
                          title={n.codigo_ubicacion || `Nivel ${n.numero}`}>
                          {n.numero}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={handleDevolucion} disabled={busy || selectedLevels.size === 0}
        className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
        Registrar devolución ({selectedLevels.size} niveles)
      </Button>
    </div>
  )
}

function Historial() {
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [movimientos, setMovimientos] = useState<{ id: string; numero_operacion: number; tipo: string; fecha: string; turno: string; usuario_nombre: string | null; usuario_id: string | null; detalles: { bloque_codigo?: string; cantidad: number }[] }[]>([])
  const [loading, setLoading] = useState(false)
  const [filtroUsuario, setFiltroUsuario] = useState('')
  const [filtroTipo, setFiltroTipo] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  useEffect(() => {
    listarSectores().then(setSectores).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sectorId) return
    setLoading(true)
    import('@/lib/piso/api').then(({ listarMovimientos }) =>
      listarMovimientos(sectorId)
        .then(setMovimientos)
        .catch(() => toast.error('Error al cargar historial'))
        .finally(() => setLoading(false))
    )
  }, [sectorId])

  const usuariosUnicos = [...new Set(movimientos.map((m) => m.usuario_nombre).filter(Boolean))] as string[]
  const tiposUnicos = [...new Set(movimientos.map((m) => m.tipo))] as string[]

  const movimientosFiltrados = movimientos.filter((m) => {
    if (filtroUsuario && m.usuario_nombre !== filtroUsuario) return false
    if (filtroTipo && m.tipo !== filtroTipo) return false
    return true
  })

  const tieneFiltrosActivos = filtroUsuario !== '' || filtroTipo !== ''

  function limpiarFiltros() { setFiltroUsuario(''); setFiltroTipo('') }

  function getTipoBadge(tipo: string): string {
    switch (tipo) {
      case 'ingreso': return 'bg-emerald-600 text-white'
      case 'salida': return 'bg-red-600 text-white'
      case 'devolucion': return 'bg-amber-600 text-white'
      case 'traslado': return 'bg-blue-600 text-white'
      default: return 'bg-slate-700 text-slate-300'
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1 max-w-xs">
        <Label className="text-xs text-slate-400">Sector</Label>
        <Select value={sectorId} onValueChange={setSectorId}>
          <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue placeholder="Seleccionar sector" /></SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            {sectores.map((s) => <SelectItem key={s.id} value={s.id} className="text-white focus:bg-slate-700">{s.nombre}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {movimientos.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant={showFilters ? 'secondary' : 'outline'} size="sm" className="gap-2 border-slate-700 text-slate-400"
              onClick={() => setShowFilters(!showFilters)}>
              <Filter className="h-4 w-4" /> Filtros
              {tieneFiltrosActivos && (
                <Badge className="ml-1 h-5 min-w-[20px] px-1.5 bg-sky-600">{(filtroUsuario ? 1 : 0) + (filtroTipo ? 1 : 0)}</Badge>
              )}
            </Button>
            {tieneFiltrosActivos && (
              <Button variant="ghost" size="sm" className="gap-1 text-slate-400" onClick={limpiarFiltros}>
                <X className="h-3 w-3" /> Limpiar
              </Button>
            )}
            {tieneFiltrosActivos && (
              <span className="text-xs text-slate-400">{movimientosFiltrados.length} de {movimientos.length} movimientos</span>
            )}
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 border border-slate-700 rounded-lg bg-slate-800/50">
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Usuario</Label>
                <Select value={filtroUsuario} onValueChange={(v) => setFiltroUsuario(v === '__all__' ? '' : v)}>
                  <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                    <SelectValue placeholder="Todos los usuarios" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="__all__" className="text-white focus:bg-slate-700">Todos los usuarios</SelectItem>
                    {usuariosUnicos.map((u) => <SelectItem key={u} value={u} className="text-white focus:bg-slate-700">{u}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-400">Tipo de movimiento</Label>
                <Select value={filtroTipo} onValueChange={(v) => setFiltroTipo(v === '__all__' ? '' : v)}>
                  <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                    <SelectValue placeholder="Todos los tipos" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="__all__" className="text-white focus:bg-slate-700">Todos los tipos</SelectItem>
                    {tiposUnicos.map((t) => <SelectItem key={t} value={t} className="text-white focus:bg-slate-700 capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : movimientosFiltrados.length > 0 ? (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-800 border-slate-700 hover:bg-slate-800">
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">N° Op</TableHead>
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">Fecha</TableHead>
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">Tipo</TableHead>
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">Turno</TableHead>
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">Detalles</TableHead>
                <TableHead className="text-slate-400 font-semibold text-xs uppercase">Usuario</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movimientosFiltrados.slice(0, 50).map((m) => (
                <TableRow key={m.id} className="border-slate-700 hover:bg-slate-800/50">
                  <TableCell className="font-mono text-slate-300">{m.numero_operacion}</TableCell>
                  <TableCell className="text-slate-300">{new Date(m.fecha).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge className={`${getTipoBadge(m.tipo)} capitalize border-0 text-xs`}>{m.tipo}</Badge>
                  </TableCell>
                  <TableCell className="text-slate-300">{m.turno}</TableCell>
                  <TableCell>
                    {m.detalles.slice(0, 3).map((d, i) => (
                      <span key={i} className="text-xs text-slate-300 mr-2">{d.bloque_codigo}: {d.cantidad}</span>
                    ))}
                    {m.detalles.length > 3 && <span className="text-xs text-slate-500">+{m.detalles.length - 3}</span>}
                  </TableCell>
                  <TableCell className="text-slate-300">{m.usuario_nombre || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : sectorId ? (
        tieneFiltrosActivos ? (
          <p className="text-slate-400 text-center py-8">No se encontraron movimientos con los filtros aplicados</p>
        ) : (
          <p className="text-slate-400 text-center py-8">Sin movimientos</p>
        )
      ) : (
        <p className="text-slate-400 text-center py-8">Selecciona un sector</p>
      )}
    </div>
  )
}
