'use client'

import { useState, useRef } from 'react'
import {
  fetchCatalogo,
  parseCatalogoText,
  mergeCatalogo,
  clearCatalogo,
  addCatalogoItem,
  updateCatalogoItem,
  deleteCatalogoItem,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { useAuth } from '@/hooks/useAuth'
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
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Upload,
  Trash2,
  ClipboardList,
  Plus,
  Pencil,
  FileSpreadsheet,
  Search,
  Loader2,
  Save,
  X,
} from 'lucide-react'

export function CatalogoTab() {
  const { perfil } = useAuth()
  const [catalogo, setCatalogo] = useState<CatalogoItemExtended[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'codigo' | 'descripcion'>('codigo')

  // Bulk import
  const [text, setText] = useState('')

  // Single item form
  const [showAddForm, setShowAddForm] = useState(false)
  const [formCodigo, setFormCodigo] = useState('')
  const [formUn, setFormUn] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formStockBM, setFormStockBM] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  // Edit
  const [editItem, setEditItem] = useState<CatalogoItemExtended | null>(null)
  const [editUn, setEditUn] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStockBM, setEditStockBM] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<CatalogoItemExtended | null>(null)

  // Excel upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [excelBusy, setExcelBusy] = useState(false)

  // Clear all
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  type CatalogoItemExtended = CatalogoItem & { stock_big_magic?: number }

  async function loadCatalogo() {
    try {
      const data = await fetchCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
      setLoaded(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar catalogo', { description: message })
    }
  }

  if (!loaded) {
    return (
      <div className="space-y-4">
        <Button onClick={loadCatalogo}>
          <ClipboardList className="h-4 w-4 mr-2" />
          Cargar catalogo
        </Button>
      </div>
    )
  }

  // Filter and sort
  const filtered = catalogo
    .filter((item) => {
      if (!search.trim()) return true
      const q = search.trim().toUpperCase()
      return item.codigo.toUpperCase().includes(q) || item.descripcion.toUpperCase().includes(q)
    })
    .sort((a, b) => {
      if (sortBy === 'codigo') return a.codigo.localeCompare(b.codigo)
      return a.descripcion.localeCompare(b.descripcion)
    })

  async function handleBulkImport() {
    if (!text.trim()) { toast.error('Pega los datos primero'); return }
    const items = parseCatalogoText(text)
    if (items.length === 0) { toast.error('No se encontraron datos validos'); return }
    try {
      const data = await mergeCatalogo(items)
      setCatalogo(data as CatalogoItemExtended[])
      setText('')
      toast.success(`${items.length} item(s) importados`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al importar', { description: message })
    }
  }

  async function handleAddSingle() {
    if (!formCodigo.trim()) { toast.error('Ingresa el codigo'); return }
    if (!formUn.trim()) { toast.error('Ingresa la unidad'); return }
    if (!formDesc.trim()) { toast.error('Ingresa la descripcion'); return }
    setAddBusy(true)
    try {
      await addCatalogoItem({
        codigo: formCodigo.trim().toUpperCase(),
        un: formUn.trim(),
        descripcion: formDesc.trim(),
        stock_big_magic: formStockBM ? parseFloat(formStockBM) : 0,
      })
      toast.success('Item agregado al catalogo')
      setFormCodigo('')
      setFormUn('')
      setFormDesc('')
      setFormStockBM('')
      setShowAddForm(false)
      const data = await fetchCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al agregar', { description: message })
    } finally {
      setAddBusy(false)
    }
  }

  function openEdit(item: CatalogoItemExtended) {
    setEditItem(item)
    setEditUn(item.un)
    setEditDesc(item.descripcion)
    setEditStockBM(item.stock_big_magic ? String(item.stock_big_magic) : '0')
  }

  async function handleSaveEdit() {
    if (!editItem) return
    setEditBusy(true)
    try {
      await updateCatalogoItem(editItem.codigo, {
        un: editUn,
        descripcion: editDesc,
        stock_big_magic: editStockBM ? parseFloat(editStockBM) : 0,
      })
      toast.success('Item actualizado')
      setEditItem(null)
      const data = await fetchCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al actualizar', { description: message })
    } finally {
      setEditBusy(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteCatalogoItem(deleteTarget.codigo)
      toast.success('Item eliminado')
      setDeleteTarget(null)
      const data = await fetchCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setExcelBusy(true)
    try {
      const XLSX = await import('xlsx')
      const arrayBuffer = await file.arrayBuffer()
      const wb = XLSX.read(arrayBuffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

      const items: CatalogoItem[] = []
      for (const row of rows) {
        const codigo = String(row['CODIGO'] ?? row['codigo'] ?? row['Codigo'] ?? '').trim()
        const descripcion = String(row['DESCRIPCION'] ?? row['descripcion'] ?? row['Descripcion'] ?? row['DESCRIPCIÓN'] ?? '').trim()
        const un = String(row['UN'] ?? row['un'] ?? row['Un'] ?? '').trim()
        const stockBM = Number(row['STOCK BIG MAGIC'] ?? row['stock_big_magic'] ?? row['Stock Big Magic'] ?? 0)

        if (!codigo) continue
        items.push({
          codigo: codigo.toUpperCase(),
          un: un || 'UN',
          descripcion: descripcion || codigo,
          ...(stockBM ? { stock_big_magic: stockBM } : {}),
        })
      }

      if (items.length === 0) {
        toast.error('No se encontraron datos validos en el Excel')
        return
      }

      // Use mergeCatalogo for bulk upsert (but without stock_big_magic - handle separately)
      await mergeCatalogo(items.map(({ stock_big_magic: _, ...rest }) => rest))

      // Update stock_big_magic for items that have it
      const { supabase } = await import('@/lib/supabase/client')
      const bmItems = items.filter((i) => 'stock_big_magic' in i && (i as Record<string, unknown>).stock_big_magic)
      if (bmItems.length > 0) {
        for (const item of bmItems) {
          await supabase.from('catalogo').update({
            stock_big_magic: (item as Record<string, unknown>).stock_big_magic,
          }).eq('codigo', item.codigo)
        }
      }

      const data = await fetchCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
      toast.success(`${items.length} item(s) importados desde Excel`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al procesar Excel', { description: message })
    } finally {
      setExcelBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleClearAll() {
    try {
      const data = await clearCatalogo()
      setCatalogo(data as CatalogoItemExtended[])
      toast.success('Catalogo eliminado')
      setShowClearConfirm(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al eliminar', { description: message })
    }
  }

  return (
    <div className="space-y-4">
      {/* ═══ TOOLBAR ═══ */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por codigo o descripcion..."
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setShowAddForm(true)} className="gap-2 bg-green-600 hover:bg-green-700 text-white">
            <Plus className="h-4 w-4" /> Agregar
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={excelBusy}
            variant="outline"
            className="gap-2"
          >
            {excelBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Excel
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleExcelUpload}
          />
        </div>
      </div>

      {/* Sort toggle */}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">Ordenar por:</span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={sortBy === 'codigo' ? 'default' : 'outline'}
            onClick={() => setSortBy('codigo')}
            className="h-7 text-xs"
          >
            Codigo
          </Button>
          <Button
            size="sm"
            variant={sortBy === 'descripcion' ? 'default' : 'outline'}
            onClick={() => setSortBy('descripcion')}
            className="h-7 text-xs"
          >
            Descripcion
          </Button>
        </div>
        <Badge variant="outline" className="ml-auto">{filtered.length} de {catalogo.length} item(s)</Badge>
      </div>

      {/* ═══ SINGLE ADD FORM ═══ */}
      {showAddForm && (
        <div className="rounded-xl border-2 border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-green-700 dark:text-green-300">Agregar item al catalogo</h3>
            <Button size="icon" variant="ghost" onClick={() => setShowAddForm(false)} className="h-7 w-7">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Codigo *</Label>
              <Input
                value={formCodigo}
                onChange={(e) => setFormCodigo(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="h-9 font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Unidad (UN) *</Label>
              <Input
                value={formUn}
                onChange={(e) => setFormUn(e.target.value.toUpperCase())}
                placeholder="KG, UN, MT, LT..."
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Descripcion *</Label>
            <Input
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="Descripcion del producto"
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Stock Big Magic</Label>
            <Input
              type="number"
              step="any"
              value={formStockBM}
              onChange={(e) => setFormStockBM(e.target.value)}
              placeholder="0"
              className="h-9 w-40"
            />
          </div>
          <Button
            onClick={handleAddSingle}
            disabled={addBusy || !formCodigo.trim() || !formUn.trim() || !formDesc.trim()}
            className="gap-2 bg-green-600 hover:bg-green-700 text-white"
          >
            {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Guardar en catalogo
          </Button>
        </div>
      )}

      {/* ═══ TABLE ═══ */}
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Codigo</TableHead>
              <TableHead>UN</TableHead>
              <TableHead>Descripcion</TableHead>
              <TableHead className="text-right">Stock BM</TableHead>
              {perfil?.rol === 'admin' && <TableHead className="w-24 text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item, i) => (
              <TableRow key={item.codigo}>
                <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                <TableCell className="font-mono font-medium">{item.codigo}</TableCell>
                <TableCell><Badge variant="secondary">{item.un}</Badge></TableCell>
                <TableCell className="max-w-xs truncate">{item.descripcion}</TableCell>
                <TableCell className="text-right">
                  {item.stock_big_magic && item.stock_big_magic > 0 ? (
                    <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800 font-semibold">
                      {item.stock_big_magic}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                {perfil?.rol === 'admin' && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(item)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-700" onClick={() => setDeleteTarget(item)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {search.trim() ? 'Sin resultados' : 'El catalogo esta vacio'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ═══ BULK IMPORT (collapsed) ═══ */}
      <details className="group rounded-lg border">
        <summary className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors">
          <span className="text-sm font-medium flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            Importar por texto (pegar desde Excel)
          </span>
          <span className="text-xs text-muted-foreground group-open:hidden">Click para expandir</span>
        </summary>
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Pega datos desde Excel (TSV/CSV). Columnas: codigo, UN, descripcion.
          </p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Codigo\tUN\tDescripcion\nABC123\tKG\tProducto de ejemplo"}
            rows={4}
          />
          <div className="flex gap-2">
            <Button onClick={handleBulkImport} size="sm" className="gap-2">
              <Upload className="h-4 w-4" /> Importar
            </Button>
            {perfil?.rol === 'admin' && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowClearConfirm(true)}
                className="gap-2"
              >
                <Trash2 className="h-4 w-4" /> Limpiar todo
              </Button>
            )}
          </div>
        </div>
      </details>

      {/* ═══ EDIT DIALOG ═══ */}
      <Dialog open={!!editItem} onOpenChange={() => setEditItem(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar item</DialogTitle>
          </DialogHeader>
          {editItem && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/50 p-2.5">
                <p className="font-mono font-medium">{editItem.codigo}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Unidad (UN)</Label>
                <Input value={editUn} onChange={(e) => setEditUn(e.target.value.toUpperCase())} className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Descripcion</Label>
                <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Stock Big Magic</Label>
                <Input
                  type="number"
                  step="any"
                  value={editStockBM}
                  onChange={(e) => setEditStockBM(e.target.value)}
                  className="h-9 w-40"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveEdit} disabled={editBusy} className="flex-1 gap-2">
                  {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Guardar
                </Button>
                <Button variant="outline" onClick={() => setEditItem(null)}>Cancelar</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══ DELETE CONFIRM ═══ */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar item</AlertDialogTitle>
            <AlertDialogDescription>
              Eliminar <strong>{deleteTarget?.codigo}</strong> — {deleteTarget?.descripcion} del catalogo? Esta accion no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ═══ CLEAR ALL CONFIRM ═══ */}
      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Limpiar todo el catalogo</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminaran todos los {catalogo.length} item(s) del catalogo. Esta accion no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearAll}>Eliminar todo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
