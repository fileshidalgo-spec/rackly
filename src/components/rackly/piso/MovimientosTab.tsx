'use client'

import { useState, useEffect } from 'react'
import {
  listarSectores,
  listarColumnas,
  listarSubcolumnas,
  listarNivelesDeSubcolumna,
  listarBloques,
  listarBloquesDeColumna,
  registrarMovimiento,
  calcularStockNivel,
  type Sector,
  type Columna,
  type Subcolumna,
  calcularTurno,
} from '@/lib/piso/api'
import { calcularTurno as calcTurnoKardex } from '@/lib/rackly/turno'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Loader2, ArrowDownToLine, ArrowUpFromLine, History } from 'lucide-react'

export function MovimientosTab() {
  return (
    <Tabs defaultValue="ingreso" className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="ingreso" className="gap-2">
          <ArrowDownToLine className="h-4 w-4" /> Ingreso
        </TabsTrigger>
        <TabsTrigger value="salida" className="gap-2">
          <ArrowUpFromLine className="h-4 w-4" /> Salida
        </TabsTrigger>
        <TabsTrigger value="historial" className="gap-2">
          <History className="h-4 w-4" /> Historial
        </TabsTrigger>
      </TabsList>
      <TabsContent value="ingreso" className="mt-4">
        <IngresoRapido />
      </TabsContent>
      <TabsContent value="salida" className="mt-4">
        <SalidaMasiva />
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
    if (subcolumnas.length === 0) {
      setGridData([])
      return
    }
    Promise.all(
      subcolumnas.map(async (sc) => {
        const data = await listarNivelesDeSubcolumna(sc.id)
        return data
      })
    ).then((results) => {
      const all = results.flat()
      setGridData(all)
    })
  }, [subcolumnas])

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
    if (isNaN(qty) || qty <= 0) {
      toast.error('Cantidad inválida')
      return
    }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels).map((nivelId) => ({
        nivel_id: nivelId,
        bloque_id: bloqueId,
        cantidad: qty,
      }))
      await registrarMovimiento('ingreso', calcTurnoKardex(), detalles)
      toast.success(`Ingreso registrado en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Set())
      setCantidad('')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Sector</label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>
              {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>
              {columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>
              {bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">
          Cantidad
        </label>
        <Input
          type="number"
          step="any"
          min="0.001"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad para todos los niveles seleccionados"
          className="max-w-xs"
        />
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Selecciona niveles (haz clic en las celdas). Seleccionados: {selectedLevels.size}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc) => {
              const positions = gridData.filter((g) => {
                // Match by subcolumna
                return g.niveles.length > 0
              })
              return (
                <div key={sc.id} className="border rounded-lg p-3">
                  <p className="text-sm font-medium mb-2">{sc.codigo}</p>
                  {gridData
                    .filter((_, idx) => {
                      // Rough matching by position within subcolumna
                      const startIdx = subcolumnas.findIndex((s) => s.id === sc.id)
                      const subData: typeof gridData = []
                      let count = 0
                      for (const g of gridData) {
                        const levelsPerPos = g.niveles.length || 1
                        if (count >= startIdx * levelsPerPos && count < (startIdx + 1) * levelsPerPos) {
                          // rough matching
                        }
                        count++
                      }
                      return idx >= subcolumnas.findIndex((s) => s.id === sc.id) && idx < subcolumnas.findIndex((s) => s.id === sc.id) + 1
                    })
                    .map((g, gi) => (
                      <div key={gi} className="flex flex-wrap gap-1 mb-1">
                        <span className="text-xs text-muted-foreground w-6">P{g.posicion.numero}</span>
                        {g.niveles.map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                              selectedLevels.has(n.id)
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted hover:bg-accent'
                            }`}
                            onClick={() => toggleLevel(n.id)}
                            title={n.codigo_ubicacion || `Nivel ${n.numero}`}
                          >
                            {n.numero}
                          </button>
                        ))}
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <Button onClick={handleIngreso} disabled={busy || selectedLevels.size === 0} className="gap-2">
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
    Promise.all([
      listarSubcolumnas(columnaId),
      listarBloquesDeColumna(columnaId),
    ]).then(([subs, blqs]) => {
      setSubcolumnas(subs)
      setBloques(blqs)
    }).catch(() => {})
  }, [columnaId])

  useEffect(() => {
    if (subcolumnas.length === 0) {
      setGridData([])
      return
    }
    Promise.all(subcolumnas.map((sc) => listarNivelesDeSubcolumna(sc.id)))
      .then((results) => {
        setGridData(results.flat())
        // Load stock for all levels
        const allNiveles = results.flat().flatMap((r) => r.niveles)
        allNiveles.forEach((n) => {
          calcularStockNivel(n.id)
            .then((stock) => {
              setStockData((prev) => new Map(prev).set(n.id, stock))
            })
            .catch(() => {})
        })
      })
      .catch(() => {})
  }, [subcolumnas])

  function toggleLevel(nivelId: string, availableQty: number) {
    setSelectedLevels((prev) => {
      const next = new Map(prev)
      if (next.has(nivelId)) next.delete(nivelId)
      else next.set(nivelId, availableQty)
      return next
    })
  }

  async function handleSalida() {
    if (!bloqueId || selectedLevels.size === 0 || !perfil) {
      toast.error('Selecciona bloque y niveles')
      return
    }
    setBusy(true)
    try {
      const detalles = Array.from(selectedLevels.entries()).map(([nivelId, cantidad]) => ({
        nivel_id: nivelId,
        bloque_id: bloqueId,
        cantidad,
      }))
      await registrarMovimiento('salida', calcTurnoKardex(), detalles)
      toast.success(`Salida registrada en ${detalles.length} nivel(es)`)
      setSelectedLevels(new Map())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al registrar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Sector</label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger><SelectValue placeholder="Sector" /></SelectTrigger>
            <SelectContent>
              {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger><SelectValue placeholder="Columna" /></SelectTrigger>
            <SelectContent>
              {columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
            <SelectContent>
              {bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Selecciona niveles con stock. Seleccionados: {selectedLevels.size}
          </p>
          <div className="grid gap-2">
            {subcolumnas.map((sc, scIdx) => {
              const startIdx = scIdx
              const endIdx = scIdx + 1
              return (
                <div key={sc.id} className="border rounded-lg p-3">
                  <p className="text-sm font-medium mb-2">{sc.codigo}</p>
                  <div className="flex flex-wrap gap-1">
                    {gridData.slice(startIdx * 1, endIdx * 1).flatMap((g) =>
                      g.niveles.map((n) => {
                        const stock = stockData.get(n.id) || []
                        const blockStock = stock.find((s) => s.bloque_codigo === bloques.find((b) => b.id === bloqueId)?.codigo)
                        const qty = blockStock?.cantidad || 0
                        const hasStock = qty > 0
                        const isSelected = selectedLevels.has(n.id)
                        return (
                          <button
                            key={n.id}
                            type="button"
                            disabled={!hasStock}
                            className={`w-10 h-10 rounded text-xs font-medium transition-colors ${
                              isSelected
                                ? 'bg-destructive text-white'
                                : hasStock
                                ? 'bg-primary/10 hover:bg-primary/20 text-primary'
                                : 'bg-muted text-muted-foreground cursor-not-allowed'
                            }`}
                            onClick={() => hasStock && toggleLevel(n.id, qty)}
                            title={`N${n.numero} - Stock: ${qty}`}
                          >
                            <div>{n.numero}</div>
                            <div className="text-[10px]">{qty}</div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <Button onClick={handleSalida} disabled={busy || selectedLevels.size === 0} className="gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        Registrar salida ({selectedLevels.size} niveles)
      </Button>
    </div>
  )
}

function Historial() {
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [movimientos, setMovimientos] = useState<{ id: string; numero_operacion: number; tipo: string; fecha: string; turno: string; usuario_nombre: string | null; detalles: { bloque_codigo?: string; cantidad: number }[] }[]>([])
  const [loading, setLoading] = useState(false)

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

  return (
    <div className="space-y-4">
      <div className="space-y-1 max-w-xs">
        <label className="text-sm font-medium">Sector</label>
        <Select value={sectorId} onValueChange={setSectorId}>
          <SelectTrigger><SelectValue placeholder="Seleccionar sector" /></SelectTrigger>
          <SelectContent>
            {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : movimientos.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>N° Op</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Turno</TableHead>
              <TableHead>Detalles</TableHead>
              <TableHead>Usuario</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movimientos.slice(0, 50).map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono">{m.numero_operacion}</TableCell>
                <TableCell>{new Date(m.fecha).toLocaleString()}</TableCell>
                <TableCell>
                  <Badge variant={m.tipo === 'ingreso' ? 'default' : 'destructive'}>{m.tipo}</Badge>
                </TableCell>
                <TableCell>{m.turno}</TableCell>
                <TableCell>
                  {m.detalles.slice(0, 3).map((d, i) => (
                    <span key={i} className="text-xs mr-2">
                      {d.bloque_codigo}: {d.cantidad}
                    </span>
                  ))}
                  {m.detalles.length > 3 && <span className="text-xs text-muted-foreground">+{m.detalles.length - 3}</span>}
                </TableCell>
                <TableCell>{m.usuario_nombre || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : sectorId ? (
        <p className="text-muted-foreground text-center py-8">Sin movimientos</p>
      ) : (
        <p className="text-muted-foreground text-center py-8">Selecciona un sector</p>
      )}
    </div>
  )
}
