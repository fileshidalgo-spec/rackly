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
}

export function SectoresTab() {
  const { perfil } = useAuth()
  const [sectores, setSectores] = useState<Sector[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ nombre: '', prefijo: '', n_columnas: 2, n_subcolumnas: 2, n_posiciones: 10, n_niveles: 5 })

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
    if (!form.nombre.trim() || !form.prefijo.trim()) {
      toast.error('Nombre y prefijo son requeridos')
      return
    }
    try {
      const data = await crearSector(
        form.nombre.trim(),
        form.prefijo.trim().toUpperCase(),
        form.n_columnas,
        form.n_subcolumnas,
        form.n_posiciones,
        form.n_niveles
      )
      setSectores(data)
      setForm({ nombre: '', prefijo: '', n_columnas: 2, n_subcolumnas: 2, n_posiciones: 10, n_niveles: 5 })
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
        <Card style={{ background: C.bgCard, border: `1px solid ${C.borderBlue}` }}>
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label style={{ color: C.textMuted }}>Nombre</Label>
                  <Input
                    value={form.nombre}
                    onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                    placeholder="Nombre del sector"
                    style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                  />
                </div>
                <div className="space-y-1">
                  <Label style={{ color: C.textMuted }}>Prefijo</Label>
                  <Input
                    value={form.prefijo}
                    onChange={(e) => setForm({ ...form, prefijo: e.target.value })}
                    placeholder="A, B, C..."
                    maxLength={3}
                    style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label style={{ color: C.textMuted }}>Columnas</Label>
                    <Input
                      type="number"
                      min={1}
                      max={26}
                      value={form.n_columnas}
                      onChange={(e) => setForm({ ...form, n_columnas: parseInt(e.target.value) || 1 })}
                      style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label style={{ color: C.textMuted }}>Subcol</Label>
                    <Input
                      type="number"
                      min={1}
                      max={9}
                      value={form.n_subcolumnas}
                      onChange={(e) => setForm({ ...form, n_subcolumnas: parseInt(e.target.value) || 1 })}
                      style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label style={{ color: C.textMuted }}>Posiciones</Label>
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={form.n_posiciones}
                      onChange={(e) => setForm({ ...form, n_posiciones: parseInt(e.target.value) || 1 })}
                      style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label style={{ color: C.textMuted }}>Niveles</Label>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={form.n_niveles}
                      onChange={(e) => setForm({ ...form, n_niveles: parseInt(e.target.value) || 1 })}
                      style={{ background: C.bgElevated, color: C.textWhite, border: `1px solid ${C.borderBlue}` }}
                    />
                  </div>
                </div>
              </div>
              <Button
                type="submit"
                className="gap-2"
                style={{ background: C.occupied, color: C.textWhite }}
              >
                <Plus className="h-4 w-4" />
                Crear sector
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Button
        onClick={load}
        variant="outline"
        size="sm"
        className="gap-2"
        style={{ borderColor: C.borderBlue, color: C.textLight }}
      >
        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        Actualizar
      </Button>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sectores.map((s) => (
          <Card key={s.id} style={{ background: C.bgCard, border: `1px solid ${C.borderBlue}` }}>
            <CardContent className="pt-4 flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Layers3 className="h-4 w-4" style={{ color: C.occupied }} />
                  <span className="font-medium" style={{ color: C.textWhite }}>{s.nombre}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge style={{ background: `${C.occupied}22`, color: C.occupied, border: `1px solid ${C.occupied}44` }}>
                    {s.prefijo}
                  </Badge>
                  <Badge style={{ background: `${C.borderBlue}88`, color: C.textLight, border: `1px solid ${C.borderBlue}` }}>
                    {s.n_columnas}col
                  </Badge>
                  <Badge style={{ background: `${C.borderBlue}88`, color: C.textLight, border: `1px solid ${C.borderBlue}` }}>
                    {s.n_subcolumnas}sub
                  </Badge>
                  <Badge style={{ background: `${C.borderBlue}88`, color: C.textLight, border: `1px solid ${C.borderBlue}` }}>
                    {s.n_posiciones}pos
                  </Badge>
                  <Badge style={{ background: `${C.borderBlue}88`, color: C.textLight, border: `1px solid ${C.borderBlue}` }}>
                    {s.n_niveles}niv
                  </Badge>
                </div>
                <p className="text-xs" style={{ color: C.textDark }}>
                  {s.n_columnas * s.n_subcolumnas * s.n_posiciones * s.n_niveles} ubicaciones
                </p>
              </div>
              {perfil?.rol === 'admin' && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(s.id)}
                  style={{ color: '#b91c1c' }}
                >
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
