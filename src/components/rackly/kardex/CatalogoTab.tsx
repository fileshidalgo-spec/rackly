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
import { Button } from '@/components/ui/button'
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
import { toast } from 'sonner'
import { Upload, Trash2, ClipboardList } from 'lucide-react'

export function CatalogoTab() {
  const { perfil } = useAuth()
  const [text, setText] = useState('')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [loaded, setLoaded] = useState(false)

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
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Pega datos desde Excel (TSV/CSV). Columnas: código, UN, descripción.
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Código&#10;UN&#10;Descripción&#10;&#10;Ejemplo:&#10;ABC123&#10;KG&#10;Producto de ejemplo"
          rows={6}
        />
        <div className="flex gap-2">
          <Button onClick={handleImport}>
            <Upload className="h-4 w-4 mr-2" />
            Importar
          </Button>
          {perfil?.rol === 'admin' && (
            <Button variant="destructive" onClick={handleClear}>
              <Trash2 className="h-4 w-4 mr-2" />
              Limpiar catálogo
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Código</TableHead>
              <TableHead>UN</TableHead>
              <TableHead>Descripción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalogo.map((item, i) => (
              <TableRow key={item.codigo}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="font-mono font-medium">
                  {item.codigo}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{item.un}</Badge>
                </TableCell>
                <TableCell>{item.descripcion}</TableCell>
              </TableRow>
            ))}
            {catalogo.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  El catálogo está vacío
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Total: {catalogo.length} ítem(s)
      </p>
    </div>
  )
}
