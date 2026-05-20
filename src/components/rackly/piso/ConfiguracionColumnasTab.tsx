'use client'

import { useState, useEffect } from 'react'
import {
  listarSectores,
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
import { Card, CardContent } from '@/components/ui/card'
import { toast } from 'sonner'
import { Plus, Trash2, Link2, Unlink, RefreshCw, Package } from 'lucide-react'

export function ConfiguracionColumnasTab() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [sectorId, setSectorId] = useState('')
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [bloques, setBloques] = useState<Bloque[]>([])
  const [colBloques, setColBloques] = useState<Map<string, Bloque[]>>(new Map())
  const [newBloque, setNewBloque] = useState({ codigo: '', descripcion: '', unidad: 'KG' })
  const [loading, setLoading] = useState(false)

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
      // Refresh
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

      {perfil?.rol === 'admin' && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleCreateBloque} className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="space-y-1">
                <Label>Código</Label>
                <Input value={newBloque.codigo} onChange={(e) => setNewBloque({ ...newBloque, codigo: e.target.value })} placeholder="Código" />
              </div>
              <div className="space-y-1 flex-1">
                <Label>Descripción</Label>
                <Input value={newBloque.descripcion} onChange={(e) => setNewBloque({ ...newBloque, descripcion: e.target.value })} placeholder="Descripción" />
              </div>
              <div className="space-y-1 w-20">
                <Label>UN</Label>
                <Input value={newBloque.unidad} onChange={(e) => setNewBloque({ ...newBloque, unidad: e.target.value })} />
              </div>
              <Button type="submit" className="gap-2">
                <Plus className="h-4 w-4" /> Crear
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">Catálogo de bloques ({bloques.length})</p>
        <div className="flex flex-wrap gap-2">
          {bloques.map((b) => (
            <Badge key={b.id} variant="outline" className="gap-1 py-1 px-2">
              <Package className="h-3 w-3" />
              {b.codigo} — {b.descripcion}
              {perfil?.rol === 'admin' && (
                <button onClick={() => handleDeleteBloque(b.id)} className="ml-1 text-destructive hover:text-destructive/80">
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      </div>

      {columnas.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Asignación por columna</p>
          {loading ? (
            <p className="text-muted-foreground">Cargando...</p>
          ) : (
            columnas.map((col) => {
              const assigned = colBloques.get(col.id) || []
              const available = bloques.filter((b) => !assigned.some((a) => a.id === b.id))
              return (
                <Card key={col.id}>
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">Columna {col.letra}</span>
                      <div className="flex items-center gap-2">
                        <Select>
                          <SelectTrigger className="w-48 h-8 text-xs">
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
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {assigned.map((b) => (
                        <Badge key={b.id} variant="secondary" className="gap-1">
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
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
