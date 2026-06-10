'use client'

import { useState } from 'react'
import { listarSectores, crearSector, eliminarSector, type Sector } from '@/lib/piso/api'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Plus, Trash2, RefreshCw, Layers3 } from 'lucide-react'

export function SectoresConfigTab() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ nombre: '', n_columnas: 2, n_subcolumnas: 2, n_posiciones: 10, n_niveles: 5 })

  async function load() {
    setLoading(true)
    try {
      const data = await listarSectores()
      setSectores(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar sectores', { description: message })
    } finally {
      setLoading(false)
    }
  }

  if (!loading && sectores.length === 0) load()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.nombre.trim()) {
      toast.error('Nombre es requerido')
      return
    }
    try {
      const data = await crearSector(
        form.nombre.trim(),
        form.nombre.trim().substring(0, 3).toUpperCase(),
        form.n_columnas,
        form.n_subcolumnas,
        form.n_posiciones,
        form.n_niveles
      )
      setSectores(data)
      setForm({ nombre: '', n_columnas: 2, n_subcolumnas: 2, n_posiciones: 10, n_niveles: 5 })
      toast.success('Sector creado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al crear sector', { description: message })
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar este sector y toda su estructura?')) return
    try {
      const data = await eliminarSector(id)
      setSectores(data)
      toast.success('Sector eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  return (
    <div className="space-y-4">
      {perfil?.rol === 'admin' && (
        <Card className="border-slate-700 bg-slate-800/80">
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-slate-400">Nombre</Label>
                  <Input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                    placeholder="Nombre del sector" className="bg-slate-800 border-slate-700 text-white placeholder-slate-500 focus:ring-sky-500/50" />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-400">Columnas</Label>
                    <Input type="number" min={1} max={26} value={form.n_columnas}
                      onChange={(e) => setForm({ ...form, n_columnas: parseInt(e.target.value) || 1 })}
                      className="bg-slate-800 border-slate-700 text-white focus:ring-sky-500/50" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-400">Subcol</Label>
                    <Input type="number" min={1} max={9} value={form.n_subcolumnas}
                      onChange={(e) => setForm({ ...form, n_subcolumnas: parseInt(e.target.value) || 1 })}
                      className="bg-slate-800 border-slate-700 text-white focus:ring-sky-500/50" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-400">Posiciones</Label>
                    <Input type="number" min={1} max={99} value={form.n_posiciones}
                      onChange={(e) => setForm({ ...form, n_posiciones: parseInt(e.target.value) || 1 })}
                      className="bg-slate-800 border-slate-700 text-white focus:ring-sky-500/50" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-slate-400">Niveles</Label>
                    <Input type="number" min={1} max={20} value={form.n_niveles}
                      onChange={(e) => setForm({ ...form, n_niveles: parseInt(e.target.value) || 1 })}
                      className="bg-slate-800 border-slate-700 text-white focus:ring-sky-500/50" />
                  </div>
                </div>
              </div>
              <Button type="submit" className="gap-2 bg-sky-600 hover:bg-sky-700 text-white">
                <Plus className="h-4 w-4" /> Crear sector
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Button onClick={load} variant="outline" size="sm"
        className="gap-2 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700">
        <RefreshCw className="h-4 w-4" /> Actualizar
      </Button>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sectores.map((s) => (
          <Card key={s.id} className="border-slate-700 bg-slate-800/80">
            <CardContent className="pt-4 flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Layers3 className="h-4 w-4 text-sky-400" />
                  <span className="font-medium text-white">{s.nombre}</span>
                </div>
                <div className="flex flex-wrap gap-1">
<Badge variant="outline" className="border-slate-600 text-slate-400">{s.n_columnas}col</Badge>
                  <Badge variant="outline" className="border-slate-600 text-slate-400">{s.n_subcolumnas}sub</Badge>
                  <Badge variant="outline" className="border-slate-600 text-slate-400">{s.n_posiciones}pos</Badge>
                  <Badge variant="outline" className="border-slate-600 text-slate-400">{s.n_niveles}niv</Badge>
                </div>
                <p className="text-xs text-slate-500">
                  {s.n_columnas * s.n_subcolumnas * s.n_posiciones * s.n_niveles} ubicaciones
                </p>
              </div>
              {perfil?.rol === 'admin' && (
                <Button variant="ghost" size="icon" onClick={() => handleDelete(s.id)} className="text-slate-500 hover:text-red-400 hover:bg-red-900/30">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
