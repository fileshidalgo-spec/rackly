'use client'

import { useState, useRef } from 'react'
import * as XLSX from 'xlsx'
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
import { Upload, Trash2, ClipboardList, FileSpreadsheet, AlertTriangle } from 'lucide-react'

export function CatalogoTab() {
  const { perfil } = useAuth()
  const [text, setText] = useState('')
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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
    setBusy(true)
    try {
      const data = await mergeCatalogo(items)
      setCatalogo(data)
      setText('')
      toast.success(`${items.length} ítem(s) importados`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al importar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })

        if (rows.length < 2) {
          toast.error('El archivo está vacío o no tiene datos')
          setBusy(false)
          return
        }

        // Detectar columnas: buscar encabezados "codigo", "descripción", "un", "stock big magic"
        const headerRow = (rows[0] ?? []).map((c) => String(c ?? '').trim().toUpperCase())
        let colCodigo = -1
        let colDescripcion = -1
        let colUn = -1
        let colStock = -1

        for (let i = 0; i < headerRow.length; i++) {
          const h = headerRow[i]
          if (h.includes('CÓDIGO') || h === 'CODIGO' || h === 'COD') colCodigo = i
          else if (h.includes('DESCRIPCI') || h.includes('DESC') || h === 'PRODUCTO' || h === 'NOMBRE') colDescripcion = i
          else if (h === 'UN' || h === 'U.M.' || h === 'UM' || h === 'UNIT') colUn = i
          else if (h.includes('STOCK') || h.includes('BIG MAGIC') || h === 'CANTIDAD' || h === 'QTY') colStock = i
        }

        // Si no encontró encabezados, asumir orden: código, descripción, UN, stock
        if (colCodigo === -1 && colDescripcion === -1) {
          colCodigo = 0
          colDescripcion = 1
          colUn = 2
          colStock = 3
        }

        const items: CatalogoItem[] = []
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r] ?? []
          const codigo = colCodigo >= 0 ? String(row[colCodigo] ?? '').trim() : ''
          const descripcion = colDescripcion >= 0 ? String(row[colDescripcion] ?? '').trim() : ''
          const un = colUn >= 0 ? String(row[colUn] ?? '').trim() : ''
          const stockRaw = colStock >= 0 ? row[colStock] : 0

          if (!codigo || !un) continue
          if (codigo.toUpperCase() === 'CÓDIGO' || codigo.toUpperCase() === 'CODIGO') continue

          let stockNum = 0
          if (typeof stockRaw === 'number') stockNum = stockRaw
          else if (typeof stockRaw === 'string') stockNum = parseFloat(stockRaw.replace(/,/g, '')) || 0

          items.push({
            codigo,
            descripcion,
            un,
            stockBigMagic: stockNum,
          })
        }

        if (items.length === 0) {
          toast.error('No se encontraron productos válidos en el archivo')
        } else {
          const data = await mergeCatalogo(items)
          setCatalogo(data)
          toast.success(`${items.length} ítem(s) importados desde Excel`)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error'
        toast.error('Error al leer el archivo Excel', { description: message })
      } finally {
        setBusy(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsArrayBuffer(file)
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

  const totalStockBM = catalogo.reduce((s, i) => s + i.stockBigMagic, 0)

  return (
    <div className="space-y-5">
      {/* ─── Importar Excel ─── */}
      <div className="space-y-3 p-4 border rounded-lg bg-card">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-green-600" />
          <p className="text-sm font-medium">Importar catálogo desde Excel (.xlsx)</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Columnas esperadas: <strong>CÓDIGO, DESCRIPCIÓN, UN, STOCK BIG MAGIC</strong>. 
          El sistema detecta los encabezados automáticamente.
        </p>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            {busy ? 'Importando...' : 'Seleccionar archivo Excel'}
          </Button>
        </div>
      </div>

      {/* ─── Pegar datos ─── */}
      <div className="space-y-3 p-4 border rounded-lg bg-card">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-blue-600" />
          <p className="text-sm font-medium">O pega datos desde Excel (TSV/CSV)</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Orden: código, descripción, UN, stock. Un ítem por línea.
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"120\tÁCIDO CÍTRICO\tKG\t13375\n122\tÁCIDO FOSFÓRICO AL 85%\tKG\t600"}
          rows={4}
        />
        <Button onClick={handleImport} disabled={busy || !text.trim()}>
          <Upload className="h-4 w-4 mr-2" />
          Importar
        </Button>
      </div>

      {/* ─── Resumen ─── */}
      {catalogo.length > 0 && (
        <div className="rounded-lg border bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 p-4">
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{catalogo.length}</p>
              <p className="text-xs text-muted-foreground">Productos en catálogo</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{totalStockBM.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Stock total Big Magic</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Tabla ─── */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Código</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead className="w-16 text-center">UN</TableHead>
              <TableHead className="text-right">Stock Big Magic</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalogo.map((item, i) => (
              <TableRow key={item.codigo}>
                <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                <TableCell className="font-mono font-medium">{item.codigo}</TableCell>
                <TableCell>{item.descripcion}</TableCell>
                <TableCell className="text-center">
                  <Badge variant="secondary">{item.un}</Badge>
                </TableCell>
                <TableCell className="text-right font-medium">
                  <span className={item.stockBigMagic > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                    {item.stockBigMagic.toLocaleString()}
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {catalogo.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  El catálogo está vacío. Importa un archivo Excel o pega los datos.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Total: {catalogo.length} ítem(s)
        </p>
        {perfil?.rol === 'admin' && (
          <Button variant="destructive" size="sm" onClick={handleClear}>
            <Trash2 className="h-4 w-4 mr-2" />
            Limpiar catálogo
          </Button>
        )}
      </div>
    </div>
  )
}
