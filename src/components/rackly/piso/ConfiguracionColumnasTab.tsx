'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  listarSectores,
  crearSector,
  listarColumnas,
  listarBloques,
  listarBloquesDeColumna,
  crearBloque,
  eliminarBloque,
  asignarBloqueAColumna,
  quitarBloqueDeColumna,
  type Sector,
  type Columna,
  type Bloque,
} from '@/lib/piso/api'
import {
  fetchCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Plus,
  Trash2,
  Unlink,
  Package,
  FolderPlus,
  Database,
  Search,
  Loader2,
  LayoutGrid,
  ArrowDownToLine,
} from 'lucide-react'

export function ConfiguracionColumnasTab() {
  return (
    <div className="space-y-6">
      {/* ═══ 1. CREACIÓN DE SECTORES ═══ */}
      <CrearSectoresSection />

      {/* ═══ 2. CATÁLOGO RACKS (lectura) ═══ */}
      <CatalogoRacksSection />

      {/* ═══ 3. BLOQUES Y COLUMNAS ═══ */}
      <BloquesColumnasSection />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   SECCIÓN 1: CREACIÓN DE SECTORES
   ═══════════════════════════════════════════════════════ */

function CrearSectoresSection() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [busy, setBusy] = useState(false)

  const [nombre, setNombre] = useState('')
  const [prefijo, setPrefijo] = useState('')
  const [nColumnas, setNColumnas] = useState('2')
  const [nSubcolumnas, setNSubcolumnas] = useState('1')
  const [nPosiciones, setNPosiciones] = useState('4')
  const [nNiveles, setNNiveles] = useState('1')

  const esAdmin = perfil?.rol === 'admin'

  async function load() {
    try {
      const data = await listarSectores()
      setSectores(data)
    } catch {
      // silencio
    }
  }

  useEffect(() => { load() }, [])

  async function handleCrear(e: React.FormEvent) {
    e.preventDefault()
    if (!nombre.trim() || !prefijo.trim()) {
      toast.error('Nombre y prefijo son requeridos')
      return
    }
    setBusy(true)
    try {
      const data = await crearSector(
        nombre.trim(),
        prefijo.trim(),
        parseInt(nColumnas) || 2,
        parseInt(nSubcolumnas) || 1,
        parseInt(nPosiciones) || 4,
        parseInt(nNiveles) || 1,
      )
      setSectores(data)
      setNombre('')
      setPrefijo('')
      toast.success(`Sector "${nombre.trim()}" creado correctamente`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al crear sector', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-emerald-600" />
          Gestión de Sectores
        </CardTitle>
        <CardDescription>
          Crea sectores que se desplegarán automáticamente en la pestaña Sectores. Cada sector genera su estructura de columnas, subcolumnas, posiciones y niveles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Formulario de creación */}
        {esAdmin && (
          <form onSubmit={handleCrear} className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Nombre</Label>
                <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej: Zona A" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Prefijo</Label>
                <Input value={prefijo} onChange={(e) => setPrefijo(e.target.value)} placeholder="Ej: ZA" className="h-9 uppercase" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Columnas</Label>
                <Input type="number" min="1" max="26" value={nColumnas} onChange={(e) => setNColumnas(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Subcolumnas</Label>
                <Input type="number" min="1" max="20" value={nSubcolumnas} onChange={(e) => setNSubcolumnas(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Posiciones</Label>
                <Input type="number" min="1" max="50" value={nPosiciones} onChange={(e) => setNPosiciones(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Niveles</Label>
                <Input type="number" min="1" max="20" value={nNiveles} onChange={(e) => setNNiveles(e.target.value)} className="h-9" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                Crear sector
              </Button>
              <p className="text-xs text-muted-foreground">
                Se crearán {(parseInt(nColumnas) || 2) * (parseInt(nSubcolumnas) || 1) * (parseInt(nPosiciones) || 4) * (parseInt(nNiveles) || 1)} niveles en total
              </p>
            </div>
          </form>
        )}

        {/* Lista de sectores existentes */}
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">Sectores existentes ({sectores.length})</p>
          {sectores.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay sectores creados. Crea uno arriba para empezar.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {sectores.map((s) => {
                const total = s.n_columnas * s.n_subcolumnas * s.n_posiciones * s.n_niveles
                return (
                  <div key={s.id} className="rounded-lg border p-3 bg-muted/30">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-sm text-foreground">{s.nombre}</span>
                      <Badge variant="secondary" className="text-[10px] font-mono">{s.prefijo}</Badge>
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <span>{s.n_columnas} col.</span>
                      <span>{s.n_subcolumnas} sub.</span>
                      <span>{s.n_posiciones} pos.</span>
                      <span>{s.n_niveles} niv.</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">{total} niveles totales</p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/* ═══════════════════════════════════════════════════════
   SECCIÓN 2: CATÁLOGO DE KARDEX RACKS (solo lectura)
   ═══════════════════════════════════════════════════════ */

function CatalogoRacksSection() {
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busqueda, setBusqueda] = useState('')

  async function handleLoad() {
    setLoading(true)
    try {
      const data = await fetchCatalogo()
      setCatalogo(data)
      setLoaded(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar catálogo', { description: message })
    } finally {
      setLoading(false)
    }
  }

  const filtrados = useMemo(() => {
    if (!busqueda.trim()) return catalogo
    const q = busqueda.toLowerCase()
    return catalogo.filter(
      (item) =>
        item.codigo.toLowerCase().includes(q) ||
        item.descripcion.toLowerCase().includes(q),
    )
  }, [catalogo, busqueda])

  if (!loaded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-600" />
            Catálogo de Artículos (Kardex Racks)
          </CardTitle>
          <CardDescription>
            Visualiza el catálogo maestro de artículos. Esta información se usa para el autocompletado de búsqueda por código o descripción en Kardex Piso.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleLoad} disabled={loading} variant="outline" className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
            {loading ? 'Cargando...' : 'Cargar catálogo'}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5 text-blue-600" />
          Catálogo de Artículos (Kardex Racks)
          <Badge variant="secondary">{catalogo.length} artículos</Badge>
        </CardTitle>
        <CardDescription>
          Catálogo maestro de artículos. Se usa para autocompletado de búsqueda por código o descripción en Kardex Piso. La información se gestiona desde la sección Kardex Racks &gt; Catálogo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por código o descripción..."
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
          {busqueda && (
            <span className="text-xs text-muted-foreground">{filtrados.length} resultado{filtrados.length !== 1 ? 's' : ''}</span>
          )}
          <Button variant="outline" size="sm" onClick={handleLoad} disabled={loading} className="gap-1 h-8 text-xs">
            <Loader2 className={`h-3 w-3 ${loading ? 'animate-spin' : 'hidden'}`} />
            Actualizar
          </Button>
        </div>

        {filtrados.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {busqueda ? 'No se encontraron artículos' : 'El catálogo está vacío. Agrega artículos desde Kardex Racks > Catálogo.'}
          </p>
        ) : (
          <div className="rounded-lg border overflow-hidden max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs w-10">#</TableHead>
                  <TableHead className="text-xs">Código</TableHead>
                  <TableHead className="text-xs">Descripción</TableHead>
                  <TableHead className="text-xs w-16 text-center">UN</TableHead>
                  <TableHead className="text-xs w-24 text-right">Stock BM</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtrados.slice(0, 200).map((item, i) => (
                  <TableRow key={item.codigo}>
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-mono text-sm font-semibold text-blue-700">{item.codigo}</TableCell>
                    <TableCell className="text-sm text-foreground max-w-[300px] truncate" title={item.descripcion}>
                      {item.descripcion}
                    </TableCell>
                    <TableCell className="text-xs text-center text-muted-foreground">{item.un}</TableCell>
                    <TableCell className="text-xs text-right font-medium">{item.stockBigMagic.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filtrados.length > 200 && (
              <div className="p-2 text-center border-t bg-muted/30">
                <p className="text-xs text-muted-foreground">Mostrando 200 de {filtrados.length}. Usa el buscador para filtrar.</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ═══════════════════════════════════════════════════════
   SECCIÓN 3: BLOQUES Y COLUMNAS (existente, mejorado)
   ═══════════════════════════════════════════════════════ */

function BloquesColumnasSection() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [bloques, setBloques] = useState<Bloque[]>([])
  const [colBloques, setColBloques] = useState<Map<string, Bloque[]>>(new Map())
  const [newBloque, setNewBloque] = useState({ codigo: '', descripcion: '', unidad: 'KG' })
  const [loading, setLoading] = useState(false)

  const esAdmin = perfil?.rol === 'admin'

  async function loadSectores() {
    const data = await listarSectores()
    setSectores(data)
    return data
  }

  useEffect(() => {
    let cancelled = false
    async function init() {
      const [sectoresData, bloquesData] = await Promise.all([
        loadSectores(),
        listarBloques(),
      ]).catch(() => [[], []]) as [Sector[], Bloque[]]
      if (cancelled) return
      setSectores(sectoresData)
      setBloques(bloquesData)
    }
    init()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!sectorId) return
    async function loadCols() {
      setLoading(true)
      const cols = await listarColumnas(sectorId)
      if (cancelled) return
      setColumnas(cols)
      const results = await Promise.all(
        cols.map(async (c) => {
          const blqs = await listarBloquesDeColumna(c.id)
          return [c.id, blqs] as [string, Bloque[]]
        })
      )
      if (cancelled) return
      setColBloques(new Map(results))
      setLoading(false)
    }
    loadCols().catch(() => setLoading(false))
    return () => { cancelled = true }
  }, [sectorId])

  async function handleCreateBloque(e: React.FormEvent) {
    e.preventDefault()
    if (!newBloque.codigo.trim()) {
      toast.error('Código requerido')
      return
    }
    try {
      const data = await crearBloque(newBloque.codigo, newBloque.descripcion, newBloque.unidad)
      setBloques(data)
      setNewBloque({ codigo: '', descripcion: '', unidad: 'KG' })
      toast.success('Bloque creado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al crear bloque', { description: message })
    }
  }

  async function handleDeleteBloque(id: string) {
    if (!confirm('¿Eliminar este bloque?')) return
    try {
      const data = await eliminarBloque(id)
      setBloques(data)
      toast.success('Bloque eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  async function handleAssign(bloqueId: string, columnaId: string) {
    try {
      await asignarBloqueAColumna(bloqueId, columnaId)
      toast.success('Bloque asignado')
      const blqs = await listarBloquesDeColumna(columnaId)
      setColBloques((prev) => new Map(prev).set(columnaId, blqs))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al asignar', { description: message })
    }
  }

  async function handleUnassign(bloqueId: string, columnaId: string) {
    try {
      await quitarBloqueDeColumna(bloqueId, columnaId)
      toast.success('Bloque desasignado')
      const blqs = await listarBloquesDeColumna(columnaId)
      setColBloques((prev) => new Map(prev).set(columnaId, blqs))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al desasignar', { description: message })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5 text-violet-600" />
          Bloques y Asignación por Columna
        </CardTitle>
        <CardDescription>
          Administra los bloques del Piso y asígnalos a las columnas de cada sector.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 max-w-xs">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sector</Label>
          <Select value={sectorId} onValueChange={setSectorId}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Seleccionar sector" /></SelectTrigger>
            <SelectContent>
              {sectores.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {esAdmin && (
          <form onSubmit={handleCreateBloque} className="flex flex-col sm:flex-row gap-3 items-end p-3 rounded-lg border bg-muted/20">
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Código</Label>
              <Input value={newBloque.codigo} onChange={(e) => setNewBloque({ ...newBloque, codigo: e.target.value })} placeholder="Código" className="h-9 uppercase" />
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Descripción</Label>
              <Input value={newBloque.descripcion} onChange={(e) => setNewBloque({ ...newBloque, descripcion: e.target.value })} placeholder="Descripción" className="h-9" />
            </div>
            <div className="space-y-1 w-20">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">UN</Label>
              <Input value={newBloque.unidad} onChange={(e) => setNewBloque({ ...newBloque, unidad: e.target.value })} className="h-9" />
            </div>
            <Button type="submit" className="gap-2">
              <Plus className="h-4 w-4" /> Crear
            </Button>
          </form>
        )}

        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">Catálogo de bloques ({bloques.length})</p>
          {bloques.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay bloques creados.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {bloques.map((b) => (
                <Badge key={b.id} variant="outline" className="gap-1 py-1 px-2 text-xs">
                  <Package className="h-3 w-3" />
                  <span className="font-mono font-semibold">{b.codigo}</span>
                  <span className="text-muted-foreground">— {b.descripcion}</span>
                  <span className="text-muted-foreground">({b.unidad})</span>
                  {esAdmin && (
                    <button onClick={() => handleDeleteBloque(b.id)} className="ml-1 text-destructive hover:text-destructive/80">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {columnas.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-foreground">Asignación por columna</p>
            {loading ? (
              <p className="text-sm text-muted-foreground">Cargando...</p>
            ) : (
              columnas.map((col) => {
                const assigned = colBloques.get(col.id) || []
                const available = bloques.filter((b) => !assigned.some((a) => a.id === b.id))
                return (
                  <div key={col.id} className="rounded-lg border p-3 bg-muted/20">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-sm">Columna {col.letra}</span>
                      <Select>
                        <SelectTrigger className="w-52 h-8 text-xs">
                          <SelectValue placeholder="Asignar bloque..." />
                        </SelectTrigger>
                        <SelectContent>
                          {available.map((b) => (
                            <SelectItem key={b.id} value={b.id} onSelect={() => handleAssign(b.id, col.id)}>
                              {b.codigo} — {b.descripcion}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {assigned.map((b) => (
                        <Badge key={b.id} variant="secondary" className="gap-1 text-xs">
                          {b.codigo}
                          <button onClick={() => handleUnassign(b.id, col.id)} className="text-muted-foreground hover:text-foreground">
                            <Unlink className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                      {assigned.length === 0 && (
                        <span className="text-xs text-muted-foreground">Sin bloques asignados</span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
