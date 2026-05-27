'use client'

import { useState, useRef } from 'react'
import { reemplazarCatalogoBloques, type Bloque } from '@/lib/piso/api'
import { Button } from '@/components/ui/button'
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
import { Upload, FileSpreadsheet, Loader2, Check } from 'lucide-react'

export function UpKardexTab() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ codigo: string; descripcion: string; unidad: string }[]>([])
  const [bloques, setBloques] = useState<Bloque[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setDone(false)
    parseFile(f)
  }

  async function parseFile(f: File) {
    try {
      const XLSX = await import('xlsx')
      const buffer = await f.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })

      if (data.length === 0) {
        toast.error('El archivo está vacío')
        return
      }

      const headers = Object.keys(data[0])
      const codeCol = headers.find((h) =>
        /codigo|código|code|item|sku/i.test(h)
      ) || headers[0]
      const descCol = headers.find((h) =>
        /descrip|nombre|name|product/i.test(h)
      ) || headers[1]
      const unitCol = headers.find((h) =>
        /un|unidad|unit|medida/i.test(h)
      ) || headers[2]

      const items = data
        .map((row) => ({
          id: crypto.randomUUID(),
          codigo: String(row[codeCol] ?? '').trim().toUpperCase(),
          descripcion: String(row[descCol] ?? '').trim(),
          unidad: String(row[unitCol] ?? 'KG').trim(),
          created_at: new Date().toISOString(),
        }))
        .filter((item) => item.codigo && item.codigo !== codeCol.toUpperCase())

      setPreview(items.slice(0, 20))
      setBloques(items)
    } catch {
      toast.error('Error al leer el archivo')
    }
  }

  async function handleUpload() {
    if (bloques.length === 0) return
    if (!confirm(`¿Reemplazar todo el catálogo con ${bloques.length} bloque(s)?`)) return
    setBusy(true)
    try {
      const data = await reemplazarCatalogoBloques(bloques)
      setBloques(data)
      setPreview([])
      setDone(true)
      toast.success(`${bloques.length} bloque(s) cargados`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          className="hidden"
        />
        <Button onClick={() => inputRef.current?.click()} variant="outline" className="gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Seleccionar archivo Excel
        </Button>
        {file && (
          <span className="text-sm text-muted-foreground">
            {file.name} ({(file.size / 1024).toFixed(1)} KB)
          </span>
        )}
      </div>

      {preview.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            Vista previa (primeros {preview.length} de {bloques.length} bloques):
          </p>
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>UN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{item.codigo}</TableCell>
                    <TableCell>{item.descripcion}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{item.unidad}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button onClick={handleUpload} disabled={busy} className="gap-2">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : done ? (
              <Check className="h-4 w-4" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {done ? 'Cargado' : `Cargar ${bloques.length} bloque(s)`}
          </Button>
        </>
      )}

      {!file && (
        <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground">
          <Upload className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>Arrastra un archivo Excel o haz clic en el botón de arriba</p>
          <p className="text-xs mt-1">Formatos: .xlsx, .xls, .csv</p>
        </div>
      )}
    </div>
  )
}
