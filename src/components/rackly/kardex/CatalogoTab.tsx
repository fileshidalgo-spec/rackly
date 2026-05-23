'use client'

import { useState } from 'react'
import {
  fetchCatalogo,
  parseCatalogoText,
  mergeCatalogo,
  clearCatalogo,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Upload, Trash2, ClipboardList, Plus, Pencil, X, Check, Loader2,
} from 'lucide-react'

export function CatalogoTab() {
  const { perfil } = useAuth()
  const [text, setText] = useState('')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [loaded, setLoaded] = useState(false)

  // Add/Edit individual
  const [showAdd, setShowAdd] = useState(false)
  const [editItem, setEditItem] = useState<CatalogoItem | null>(null)
  const [formCodigo, setFormCodigo] = useState('')
  const [formUn, setFormUn] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formSBM, setFormSBM] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  async function loadCatalogo() {
    try {
      const data = await fetchCatalogo()
      setCatalogo(data)
      setLoaded(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar catálogo', { description: message })
    }
  }

  async function handleImport() {
    if (!text.trim()) {
      toast.error('Pega los datos primero')
      return
    }
    const items = parseCatalogoText(text)
    if (items.length === 0) {
      toast.error('No se encontraron datos válidos')
      return
    }
    try {
      const data = await mergeCatalogo(items)
      setCatalogo(data)
      setText('')
      toast.success(`${items.length} ítem(s) importados`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al importar', { description: message })
    }
  }

  async function handleClear() {
    if (!confirm('¿Eliminar todo el catálogo?')) return
    try {
      const data = await clearCatalogo()
      setCatalogo(data)
      toast.success('Catálogo eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  function openAdd() {
    setFormCodigo('')
    setFormUn('')
    setFormDesc('')
    setFormSBM('')
    setShowAdd(true)
  }

  function openEdit(item: CatalogoItem) {
    setFormCodigo(item.codigo)
    setFormUn(item.un)
    setFormDesc(item.descripcion)
    setFormSBM('')
    setEditItem(item)
  }

  async function doSave() {
    if (!formCodigo.trim() || !formUn.trim() || !formDesc.trim()) {
      toast.error('Completa todos los campos')
      return
    }
    setFormBusy(true)
    try {
      const { data: sbmData } = await supabase
        .from('catalogo')
        .select('stock_big_magic')
        .eq('codigo', formCodigo.trim().toUpperCase())
        .maybeSingle()

      const existingSBM = (sbmData as Record<string, unknown>)?.stock_big_magic ?? 0

      if (editItem) {
        // Update
        const { error } = await supabase
          .from('catalogo')
          .update({
            codigo: formCodigo.trim().toUpperCase(),
            un: formUn.trim(),
            descripcion: formDesc.trim(),
            stock_big_magic: formSBM ? parseFloat(formSBM) || 0 : existingSBM,
            updated_at: new Date().toISOString(),
          })
          .eq('codigo', editItem.codigo)
        if (error) throw error
        toast.success('Ítem actualizado')
      } else {
        // Insert
        const { error } = await supabase
          .from('catalogo')
          .upsert({
            codigo: formCodigo.trim().toUpperCase(),
            un: formUn.trim(),
            descripcion: formDesc.trim(),
            stock_big_magic: formSBM ? parseFloat(formSBM) || 0 : 0,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'codigo' })
        if (error) throw error
        toast.success('Ítem agregado')
      }
      const data = await fetchCatalogo()
      setCatalogo(data)
      setShowAdd(false)
      setEditItem(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error(editItem ? 'Error al actualizar' : 'Error al agregar', { description: message })
    } finally {
      setFormBusy(false)
    }
  }

  async function doDelete() {
    if (!deleteTarget) return
    setFormBusy(true)
    try {
      const { error } = await supabase
        .from('catalogo')
        .delete()
        .eq('codigo', deleteTarget)
      if (error) throw error
      const data = await fetchCatalogo()
      setCatalogo(data)
      setDeleteTarget(null)
      toast.success('Ítem eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    } finally {
      setFormBusy(false)
    }
  }

  const filtered = searchQuery.trim()
    ? catalogo.filter(
        (i) =>
          i.codigo.toUpperCase().includes(searchQuery.toUpperCase()) ||
          i.descripcion.toUpperCase().includes(searchQuery.toUpperCase())
      )
    : catalogo

  if (!loaded) {
    return (
      <div className="space-y-4">
        <Button onClick={loadCatalogo}>
          <ClipboardList className="h-4 w-4 mr-2" />
          Cargar catálogo
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Búsqueda y acciones */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar en catálogo..."
            className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={openAdd} size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700 text-white">
            <Plus className="h-4 w-4" /> Agregar
          </Button>
          {perfil?.rol === 'admin' && (
            <Button variant="destructive" size="sm" onClick={handleClear} className="gap-1.5">
              <Trash2 className="h-4 w-4" /> Limpiar
            </Button>
          )}
        </div>
      </div>

      {/* Importar desde texto */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Pega datos desde Excel (TSV/CSV). Columnas: código, UN, descripción.
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Código\tUN\tDescripción\nABC123\tKG\tProducto de ejemplo"}
          rows={4}
          className="text-xs"
        />
        <Button onClick={handleImport} size="sm" variant="outline" className="gap-1.5">
          <Upload className="h-4 w-4" /> Importar
        </Button>
      </div>

      {/* Tabla de catálogo */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Código</TableHead>
              <TableHead>UN</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead className="w-24 text-right">Stock BM</TableHead>
              <TableHead className="w-20 text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item, i) => (
              <TableRow key={item.codigo}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="font-mono font-medium">{item.codigo}</TableCell>
                <TableCell><Badge variant="secondary">{item.un}</Badge></TableCell>
                <TableCell>{item.descripcion}</TableCell>
                <TableCell className="text-right font-mono text-xs">—</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" onClick={() => openEdit(item)} title="Editar">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(item.codigo)} title="Eliminar">
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {searchQuery ? 'Sin resultados' : 'El catálogo está vacío'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Total: {filtered.length} de {catalogo.length} ítem(s)
      </p>

      {/* Diálogo Agregar/Editar */}
      <AlertDialog open={showAdd || !!editItem} onOpenChange={(open) => { if (!open) { setShowAdd(false); setEditItem(null) } }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{editItem ? 'Editar ítem' : 'Agregar ítem'}</AlertDialogTitle>
            <AlertDialogDescription>
              {editItem ? 'Modifica los datos del ítem.' : 'Completa los datos del nuevo ítem.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Código *</Label>
              <Input
                value={formCodigo}
                onChange={(e) => setFormCodigo(e.target.value)}
                placeholder="ABC123"
                className="h-9 font-mono"
                disabled={!!editItem}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">UN *</Label>
                <Input value={formUn} onChange={(e) => setFormUn(e.target.value)} placeholder="KG" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Stock Big Magic</Label>
                <Input type="number" step="any" min="0" value={formSBM} onChange={(e) => setFormSBM(e.target.value)} placeholder="0" className="h-9" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Descripción *</Label>
              <Input value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Descripción del producto" className="h-9" />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button onClick={doSave} disabled={formBusy} className="gap-1.5">
              {formBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {editItem ? 'Guardar' : 'Agregar'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Diálogo de eliminar */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar ítem</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar <strong className="font-mono">{deleteTarget}</strong> del catálogo? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
