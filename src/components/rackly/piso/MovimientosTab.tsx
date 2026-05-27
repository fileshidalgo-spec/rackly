'use client'

import { useState, useEffect } from 'react'
import {
  listarSectores,
  listarColumnas,
  listarSubcolumnas,
  listarNivelesDeSubcolumna,
  listarBloquesDeColumna,
  registrarMovimiento,
  calcularStockNivel,
  type Sector,
  type Columna,
  type Subcolumna,
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

const C = {
  bgDeep: '#0a0a2e',
  bgCard: '#10103a',
  bgElevated: '#1a1a4e',
  borderBlue: '#303060',
  textWhite: '#f0f0f0',
  textLight: '#80c0ff',
  textMuted: '#8090c0',
  textDark: '#5060a0',
  occupied: '#0060f0',
  occupiedLight: '#2090f0',
  multi: '#f09000',
  multiLight: '#ffc040',
  emptyLight: '#40c090',
  destructive: '#b91c1c',
  success: '#00884a',
}

export function MovimientosTab() {
  return (
    <Tabs defaultValue="ingreso" className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="ingreso" className="gap-2" style={{ color: C.textLight }}>
          <ArrowDownToLine className="h-4 w-4" /> Ingreso
        </TabsTrigger>
        <TabsTrigger value="salida" className="gap-2" style={{ color: C.textLight }}>
          <ArrowUpFromLine className="h-4 w-4" /> Salida
        </TabsTrigger>
        <TabsTrigger value="historial" className="gap-2" style={{ color: C.textLight }}>
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
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Sector</label>
          <Select value={sectorId} onValueChange={(v) => { setSectorId(v); setColumnaId('') }}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Sector" />
            </SelectTrigger>
            <SelectContent>
              {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Columna" />
            </SelectTrigger>
            <SelectContent>
              {columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Bloque" />
            </SelectTrigger>
            <SelectContent>
              {bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" style={{ color: C.textMuted }}>Cantidad</label>
        <Input
          type="number"
          step="any"
          min="0.001"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad para todos los niveles seleccionados"
          className="max-w-xs"
          style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
        />
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: C.textMuted }}>
            Selecciona niveles (haz clic en las celdas). Seleccionados: {selectedLevels.size}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg p-3" style={{ background: C.bgElevated, border: `1px solid ${C.borderBlue}44` }}>
                <p className="text-sm font-medium mb-2" style={{ color: C.textWhite }}>{sc.codigo}</p>
                {gridData
                  .filter((_, idx) => idx >= scIdx && idx < scIdx + 1)
                  .map((g, gi) => (
                    <div key={gi} className="flex flex-wrap gap-1 mb-1">
                      <span className="text-xs w-6" style={{ color: C.textDark }}>P{g.posicion.numero}</span>
                      {g.niveles.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          className="w-8 h-8 rounded text-xs font-medium transition-colors"
                          style={{
                            background: selectedLevels.has(n.id)
                              ? C.occupied
                              : `${C.borderBlue}88`,
                            color: selectedLevels.has(n.id) ? C.textWhite : C.textLight,
                          }}
                          onClick={() => toggleLevel(n.id)}
                          title={n.codigo_ubicacion || `Nivel ${n.numero}`}
                        >
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

      <Button
        onClick={handleIngreso}
        disabled={busy || selectedLevels.size === 0}
        className="gap-2"
        style={{ background: C.success, color: C.textWhite }}
      >
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
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Sector</label>
          <Select value={sectorId} onValueChange={setSectorId}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Sector" />
            </SelectTrigger>
            <SelectContent>
              {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Columna</label>
          <Select value={columnaId} onValueChange={setColumnaId} disabled={!sectorId}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Columna" />
            </SelectTrigger>
            <SelectContent>
              {columnas.map((c) => <SelectItem key={c.id} value={c.id}>{c.letra}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" style={{ color: C.textMuted }}>Bloque</label>
          <Select value={bloqueId} onValueChange={setBloqueId} disabled={bloques.length === 0}>
            <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
              <SelectValue placeholder="Bloque" />
            </SelectTrigger>
            <SelectContent>
              {bloques.map((b) => <SelectItem key={b.id} value={b.id}>{b.codigo}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {gridData.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: C.textMuted }}>
            Selecciona niveles con stock. Seleccionados: {selectedLevels.size}
          </p>
          <div className="grid gap-2">
            {subcolumnas.map((sc, scIdx) => (
              <div key={sc.id} className="rounded-lg p-3" style={{ background: C.bgElevated, border: `1px solid ${C.borderBlue}44` }}>
                <p className="text-sm font-medium mb-2" style={{ color: C.textWhite }}>{sc.codigo}</p>
                <div className="flex flex-wrap gap-1">
                  {gridData.slice(scIdx, scIdx + 1).flatMap((g) =>
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
                          className="w-10 h-10 rounded text-xs font-medium transition-colors"
                          style={{
                            background: isSelected
                              ? C.destructive
                              : hasStock
                              ? `${C.occupied}22`
                              : `${C.borderBlue}44`,
                            color: isSelected
                              ? C.textWhite
                              : hasStock
                              ? C.occupiedLight
                              : C.textDark,
                            cursor: hasStock ? 'pointer' : 'not-allowed',
                          }}
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
            ))}
          </div>
        </div>
      )}

      <Button
        onClick={handleSalida}
        disabled={busy || selectedLevels.size === 0}
        className="gap-2"
        style={{ background: C.destructive, color: C.textWhite }}
      >
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
        <label className="text-sm font-medium" style={{ color: C.textMuted }}>Sector</label>
        <Select value={sectorId} onValueChange={setSectorId}>
          <SelectTrigger style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}>
            <SelectValue placeholder="Seleccionar sector" />
          </SelectTrigger>
          <SelectContent>
            {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: C.textLight }} />
        </div>
      ) : movimientos.length > 0 ? (
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.borderBlue}` }}>
          <Table>
            <TableHeader>
              <TableRow style={{ background: C.bgElevated }}>
                <TableHead style={{ color: C.textLight }}>N° Op</TableHead>
                <TableHead style={{ color: C.textLight }}>Fecha</TableHead>
                <TableHead style={{ color: C.textLight }}>Tipo</TableHead>
                <TableHead style={{ color: C.textLight }}>Turno</TableHead>
                <TableHead style={{ color: C.textLight }}>Detalles</TableHead>
                <TableHead style={{ color: C.textLight }}>Usuario</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movimientos.slice(0, 50).map((m) => (
                <TableRow key={m.id} style={{ borderBottom: `1px solid ${C.borderBlue}44` }}>
                  <TableCell className="font-mono" style={{ color: C.textWhite }}>{m.numero_operacion}</TableCell>
                  <TableCell style={{ color: C.textMuted }}>{new Date(m.fecha).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge
                      style={{
                        background: m.tipo === 'ingreso' ? `${C.success}22` : `${C.destructive}22`,
                        color: m.tipo === 'ingreso' ? C.emptyLight : C.multiLight,
                        border: `1px solid ${m.tipo === 'ingreso' ? `${C.success}44` : `${C.destructive}44`}`,
                      }}
                    >
                      {m.tipo}
                    </Badge>
                  </TableCell>
                  <TableCell style={{ color: C.textMuted }}>{m.turno}</TableCell>
                  <TableCell>
                    {m.detalles.slice(0, 3).map((d, i) => (
                      <span key={i} className="text-xs mr-2" style={{ color: C.textLight }}>
                        {d.bloque_codigo}: {d.cantidad}
                      </span>
                    ))}
                    {m.detalles.length > 3 && <span className="text-xs" style={{ color: C.textDark }}>+{m.detalles.length - 3}</span>}
                  </TableCell>
                  <TableCell style={{ color: C.textMuted }}>{m.usuario_nombre || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : sectorId ? (
        <p className="text-center py-8" style={{ color: C.textMuted }}>Sin movimientos</p>
      ) : (
        <p className="text-center py-8" style={{ color: C.textMuted }}>Selecciona un sector</p>
      )}
    </div>
  )
}
