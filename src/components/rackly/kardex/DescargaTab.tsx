'use client'

import { useState, useRef } from 'react'
import { fetchMovimientos, addMovimientosBatch, deleteAllMovimientos, type Movimiento, type UploadStockRow } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Download, Upload, FileSpreadsheet, Loader2, Check, AlertTriangle, X, ArrowDownToLine, DatabaseBackup, Trash2, ShieldAlert } from 'lucide-react'

/* ═══════════════════════════════════════════════════════════
   SUB-COMPONENT: Sección de Descarga (exportar Excel)
   ═══════════════════════════════════════════════════════════ */
function DownloadSection({ movs }: { movs: Movimiento[] }) {
  const [busy, setBusy] = useState(false)

  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Sheet 1: Movimientos
      const movData = movs.map((m) => ({
        Tipo: m.tipo,
        Bloque: m.bloque,
        Torre: m.torre,
        Piso: m.piso,
        Posición: m.posicion,
        Código: m.codigo,
        Descripción: m.descripcion,
        UN: m.un,
        Cantidad: m.cantidad,
        'Número de INC': m.codigoInc || '',
        'F. Vencimiento': m.fVencimiento || '',
        'F. Modificación': new Date(m.fModificacion).toLocaleString(),
        Turno: m.turno,
        Usuario: m.usuarioNombre ?? m.usuarioCorreo ?? '',
        Proveedor: m.proveedor ?? '',
      }))
      const ws1 = XLSX.utils.json_to_sheet(movData)
      XLSX.utils.book_append_sheet(wb, ws1, 'Movimientos')

      // Sheet 2: Stock REAL — 1 fila = 1 combinación única
      // Clave: (código, bloque, torre, piso, posición, f_vencimiento, codigo_inc)
      // Esto separa lotes por fecha de vencimiento e INCs en filas distintas.
      const ENTRADA_TYPES = new Set(['ingreso', 'devolucion', 'traslado', 'stock_inicial'])
      const stockMap = new Map<string, {
        code: string; desc: string; un: string;
        bloque: string; torre: string; piso: string; posicion: string;
        stock: number; fVencimiento: string; codigoInc: string; proveedor: string;
      }>()
      for (const m of movs) {
        const vencKey = m.fVencimiento || ''
        const incKey = m.codigoInc || ''
        const key = `${m.codigo}|${m.bloque}|${m.torre}|${m.piso}|${m.posicion}|${vencKey}|${incKey}`
        const delta = ENTRADA_TYPES.has(m.tipo) ? m.cantidad : -m.cantidad
        const entry = stockMap.get(key)
        if (entry) {
          entry.stock += delta
        } else {
          stockMap.set(key, {
            code: m.codigo,
            desc: m.descripcion,
            un: m.un,
            bloque: m.bloque,
            torre: m.torre,
            piso: m.piso,
            posicion: m.posicion,
            stock: delta,
            fVencimiento: m.fVencimiento || '',
            codigoInc: incKey,
            proveedor: m.proveedor || '',
          })
        }
      }
      const stockData = Array.from(stockMap.values())
        .filter((e) => e.stock > 0.001)
        .sort((a, b) => {
          // Ordenar por ubicación, luego código, luego fecha vencimiento
          const locCmp = `${a.bloque}-${a.torre}-${a.piso}-${a.posicion}`.localeCompare(`${b.bloque}-${b.torre}-${b.piso}-${b.posicion}`)
          if (locCmp !== 0) return locCmp
          const codeCmp = a.code.localeCompare(b.code)
          if (codeCmp !== 0) return codeCmp
          // INCs al final
          if (a.codigoInc && !b.codigoInc) return 1
          if (!a.codigoInc && b.codigoInc) return -1
          // Con fecha antes que sin fecha
          if (a.fVencimiento && !b.fVencimiento) return -1
          if (!a.fVencimiento && b.fVencimiento) return 1
          if (a.fVencimiento && b.fVencimiento) return a.fVencimiento.localeCompare(b.fVencimiento)
          return 0
        })
        .map((e) => ({
          'CÓDIGO': e.code,
          'BLOQUE': e.bloque,
          'TORRE': e.torre,
          'PISO': e.piso,
          'POSICIÓN': e.posicion,
          'DESCRIPCIÓN': e.desc,
          'UN': e.un,
          'CANTIDAD': Math.round(e.stock * 1000) / 1000,
          'NUMERO DE INC': e.codigoInc,
          'FECHA DE VENCIMIENTO': e.fVencimiento,
          'PROVEEDOR': e.proveedor,
        }))
      if (stockData.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(stockData)
        // Ajustar anchos de columna
        ws2['!cols'] = [
          { wch: 18 }, // CÓDIGO
          { wch: 8 },  // BLOQUE
          { wch: 7 },  // TORRE
          { wch: 6 },  // PISO
          { wch: 10 }, // POSICIÓN
          { wch: 35 }, // DESCRIPCIÓN
          { wch: 6 },  // UN
          { wch: 14 }, // CANTIDAD
          { wch: 18 }, // NUMERO DE INC
          { wch: 20 }, // FECHA DE VENCIMIENTO
          { wch: 25 }, // PROVEEDOR
        ]
        XLSX.utils.book_append_sheet(wb, ws2, 'Stock Real')
      }

      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_${fecha}.xlsx`)
      toast.success('Archivo descargado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 shadow-md shadow-emerald-500/20">
          <Download className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-bold text-slate-800">Descargar Excel</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Exporta todos los movimientos y el stock actual por ubicación a un archivo Excel.
            {movs.length > 0 && (
              <span className="ml-1 font-semibold text-slate-700">
                ({movs.length} movimiento(s) registrado(s))
              </span>
            )}
          </p>
        </div>
      </div>
      <Button
        onClick={handleExport}
        disabled={busy || movs.length === 0}
        className="gap-2 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white shadow-md shadow-emerald-500/20 font-semibold"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Descargar Excel
      </Button>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   SUB-COMPONENT: Sección UP Data (subir Excel con stock)
   ═══════════════════════════════════════════════════════════ */
function UpDataSection() {
  const { perfil } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<UploadStockRow[]>([])
  const [allRows, setAllRows] = useState<UploadStockRow[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [progress, setProgress] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setDone(false)
    setErrors([])
    setProgress('')
    parseFile(f)
  }

  function clearFile() {
    setFile(null)
    setPreview([])
    setAllRows([])
    setDone(false)
    setErrors([])
    setProgress('')
    if (inputRef.current) inputRef.current.value = ''
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

      // Auto-detectar columnas
      const codeCol = headers.find((h) =>
        /codigo|código|code|item|sku/i.test(h)
      ) || headers[0]
      const descCol = headers.find((h) =>
        /descrip|nombre|name|product/i.test(h)
      ) || headers[1]
      const bloqueCol = headers.find((h) =>
        /bloque|block/i.test(h)
      ) || headers.find((h) => /b[1-9]/i.test(h))
      const torreCol = headers.find((h) =>
        /torre|tower/i.test(h)
      ) || headers.find((h) => /t[a1-2]/i.test(h))
      const pisoCol = headers.find((h) =>
        /piso|nivel|level|floor/i.test(h)
      ) || headers.find((h) => /p[1-4]/i.test(h))
      const posCol = headers.find((h) =>
        /pos|posición|position/i.test(h)
      )
      const cantCol = headers.find((h) =>
        /cant|cantidad|quantity|qty|stock/i.test(h)
      )
      const unCol = headers.find((h) =>
        /^un[d]?$|unidad|unit|medida/i.test(h)
      )
      const vencCol = headers.find((h) =>
        /vencimiento|venc|vto/i.test(h) && /fecha|f\./i.test(h)
      ) || headers.find((h) =>
        /venc|fecha.*venc|date|vto/i.test(h)
      )
      const incCol = headers.find((h) =>
        /numero.*inc|inc|n.*inc|codigo.*inc/i.test(h)
      )
      const provCol = headers.find((h) =>
        /prov|supplier|proveedor/i.test(h)
      )

      if (!bloqueCol || !torreCol || !pisoCol || !posCol) {
        toast.error('No se encontraron las columnas de ubicación (Bloque, Torre, Piso, Posición)')
        return
      }

      if (!cantCol) {
        toast.error('No se encontró la columna de Cantidad')
        return
      }

      const rows: UploadStockRow[] = []
      for (const row of data) {
        const codigo = String(row[codeCol] ?? '').trim()
        const cantidad = Number(row[cantCol])
        if (!codigo || codigo === codeCol || !Number.isFinite(cantidad) || cantidad <= 0) continue
        rows.push({
          codigo: codigo.toUpperCase(),
          descripcion: String(row[descCol] ?? '').trim(),
          un: unCol ? String(row[unCol] ?? '').trim() : 'KG',
          bloque: String(row[bloqueCol] ?? '').trim(),
          torre: String(row[torreCol] ?? '').trim(),
          piso: String(row[pisoCol] ?? '').trim(),
          posicion: String(row[posCol] ?? '').trim(),
          cantidad,
          fVencimiento: vencCol ? String(row[vencCol] ?? '').trim() : undefined,
          codigoInc: incCol ? String(row[incCol] ?? '').trim() || undefined : undefined,
          proveedor: provCol ? String(row[provCol] ?? '').trim() : undefined,
        })
      }

      if (rows.length === 0) {
        toast.error('No se encontraron filas válidas en el archivo')
        return
      }

      setPreview(rows.slice(0, 20))
      setAllRows(rows)
      toast.success(`${rows.length} fila(s) detectada(s) correctamente`)
    } catch {
      toast.error('Error al leer el archivo. Verifica que sea un .xlsx válido.')
    }
  }

  async function handleUpload() {
    if (!perfil) {
      toast.error('Debes estar autenticado para subir datos')
      return
    }
    if (allRows.length === 0) return

    const totalQty = allRows.reduce((s, r) => s + r.cantidad, 0)
    if (
      !confirm(
        `⚠️ ATENCIÓN: Se ELIMINARÁN TODOS los movimientos existentes antes de subir.\n\nSe registrarán ${allRows.length} ingreso(s) con un total de ${totalQty.toLocaleString()} unidades.\n\n¿Deseas continuar?`
      )
    ) return

    setBusy(true)
    setErrors([])
    setProgress('Paso 1/2: Eliminando movimientos anteriores...')
    try {
      // Paso 1: Borrar todos los movimientos (usa service_role)
      const delResult = await deleteAllMovimientos()
      if (!delResult.deleted) {
        toast.error('Error al eliminar movimientos', { description: delResult.error })
        setProgress('')
        setBusy(false)
        return
      }
      setProgress(`Paso 2/2: Insertando ${allRows.length} registros nuevos...`)

      // Paso 2: Insertar los nuevos movimientos
      const result = await addMovimientosBatch(
        allRows,
        perfil.id,
        perfil.nombre || undefined,
        perfil.correo || undefined,
      )
      setProgress('')
      if (result.errors.length > 0) {
        setErrors(result.errors)
        toast.warning(
          `Se insertaron ${result.inserted} de ${allRows.length}. Revisa los errores.`
        )
      } else {
        setDone(true)
        toast.success(`${result.inserted} ingreso(s) registrado(s) correctamente. Stock actualizado.`)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar datos', { description: message })
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md shadow-blue-500/20">
          <Upload className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-bold text-slate-800">UP Data — Subir stock</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Sube un archivo Excel con el stock por posición. <span className="font-semibold text-red-600">Se borrarán todos los movimientos anteriores y se crearán los nuevos.</span>
          </p>
        </div>
      </div>

      {/* Columnas esperadas info */}
      <div className="rounded-xl border border-blue-200/60 bg-blue-50/50 p-3 space-y-2">
        <p className="text-xs font-bold text-blue-700 uppercase tracking-wider flex items-center gap-1.5">
          <DatabaseBackup className="h-3.5 w-3.5" />
          Columnas esperadas en el Excel
        </p>
        <div className="flex flex-wrap gap-1.5">
          {['Código', 'Descripción', 'Bloque', 'Torre', 'Piso', 'Posición', 'Cantidad', 'UN', 'Número de INC', 'F. Vencimiento', 'Proveedor'].map((col) => (
            <Badge key={col} variant="outline" className="text-xs font-medium border-blue-200 text-blue-600 bg-white/80">
              {col}
            </Badge>
          ))}
        </div>
        <p className="text-[11px] text-blue-600/80">
          Las columnas obligatorias son: Código, Bloque, Torre, Piso, Posición y Cantidad. Las demás son opcionales.
        </p>
      </div>

      {/* File selector */}
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          className="hidden"
        />
        <Button
          onClick={() => inputRef.current?.click()}
          variant="outline"
          className="gap-2 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800 font-semibold"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Seleccionar archivo Excel
        </Button>
        {file && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-700">{file.name}</span>
            <Badge variant="secondary" className="text-xs font-medium">
              {(file.size / 1024).toFixed(1)} KB
            </Badge>
            <button
              onClick={clearFile}
              className="ml-1 p-1 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
              title="Quitar archivo"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Preview table */}
      {preview.length > 0 && !done && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-800">
                Vista previa: {preview.length} de {allRows.length} fila(s)
              </span>
            </p>
            <Badge variant="outline" className="font-bold text-emerald-700 border-emerald-200 bg-emerald-50">
              <ArrowDownToLine className="h-3 w-3 mr-1" />
              {allRows.length} ingreso(s)
            </Badge>
          </div>

          <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-xl border border-slate-200/60">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">#</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Código</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">Descripción</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Bloque</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Torre</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Piso</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Pos</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Cant.</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">UN</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">INC</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">Venc.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row, i) => (
                  <TableRow key={i} className="hover:bg-indigo-50/30 transition-colors">
                    <TableCell className="text-slate-400 text-xs">{i + 1}</TableCell>
                    <TableCell className="font-semibold font-mono text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                      {row.codigo}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell max-w-48 truncate text-slate-600">
                      {row.descripcion}
                    </TableCell>
                    <TableCell className="font-medium text-slate-700">{row.bloque}</TableCell>
                    <TableCell className="font-medium text-slate-700">{row.torre}</TableCell>
                    <TableCell className="font-medium text-slate-700">{row.piso}</TableCell>
                    <TableCell className="font-medium text-slate-700">{row.posicion}</TableCell>
                    <TableCell className="text-right font-bold text-slate-800">
                      {Number.isInteger(row.cantidad) ? row.cantidad : row.cantidad.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant="secondary" className="font-medium">{row.un}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-slate-500 text-xs">
                      {row.codigoInc || '—'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-slate-500 text-xs">
                      {row.fVencimiento || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Warning */}
          <div className="rounded-xl border border-red-200 bg-red-50/50 p-3 flex items-start gap-2.5">
            <Trash2 className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-red-700">Se eliminarán todos los movimientos registrados</p>
              <p className="text-[11px] text-red-600/80 mt-0.5">
                Al cargar el archivo, primero se borra todo el historial de movimientos y luego se insertan los datos del Excel como ingresos nuevos. El stock quedará exactamente como indica el archivo.
              </p>
            </div>
          </div>

          {/* Upload button */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleUpload}
              disabled={busy}
              className="gap-2 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white shadow-md shadow-blue-500/20 font-semibold"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Procesando...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Cargar {allRows.length} ingreso(s) — eliminar anteriores
                </>
              )}
            </Button>

            {progress && (
              <p className="text-xs text-blue-600 font-medium animate-pulse flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {progress}
              </p>
            )}
          </div>
        </>
      )}

      {/* Success state */}
      {done && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <p className="font-bold text-emerald-800">
              Carga completada — {allRows.length} ingreso(s) registrado(s)
            </p>
            <p className="text-sm text-emerald-600 mt-0.5">
              Los datos de stock han sido actualizados en el sistema.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={clearFile}
            className="ml-auto gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
          >
            <Upload className="h-3.5 w-3.5" />
            Subir otro
          </Button>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-2">
          <p className="font-bold text-amber-800 flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            Errores durante la carga ({errors.length})
          </p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {errors.slice(0, 20).map((err, i) => (
              <p key={i} className="text-xs text-amber-700 font-mono">{err}</p>
            ))}
            {errors.length > 20 && (
              <p className="text-xs text-amber-500">...y {errors.length - 20} error(es) más</p>
            )}
          </div>
        </div>
      )}

      {/* Drop zone */}
      {!file && (
        <div className="border-2 border-dashed rounded-xl p-8 text-center text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-colors cursor-pointer"
          onClick={() => inputRef.current?.click()}
        >
          <FileSpreadsheet className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm font-medium">Arrastra un archivo Excel aquí o haz clic para seleccionar</p>
          <p className="text-xs mt-1">Formatos aceptados: .xlsx, .xls, .csv</p>
        </div>
      )}
    </div>
  )
}

/** Roles autorizados para usar UP Data */
const ROLES_UPDATA = new Set(['admin', 'coordinador_operaciones'])

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT: DescargaTab con sub-tabs Descarga / UP Data
   ═══════════════════════════════════════════════════════════ */
export function DescargaTab() {
  const { perfil } = useAuth()
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [section, setSection] = useState<'download' | 'upload'>('download')

  useMovimientosRealtime(setMovs)

  const puedeSubir = perfil ? ROLES_UPDATA.has(perfil.rol) : false

  return (
    <div className="space-y-5">
      {/* Sub-tabs selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setSection('download')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${
            section === 'download'
              ? 'bg-gradient-to-r from-emerald-500 to-green-600 text-white border-transparent shadow-md shadow-emerald-500/20'
              : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 hover:text-emerald-700 hover:bg-emerald-50/50'
          }`}
        >
          <Download className="h-4 w-4" />
          Descargar
        </button>
        {puedeSubir ? (
          <button
            onClick={() => setSection('upload')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${
              section === 'upload'
                ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white border-transparent shadow-md shadow-blue-500/20'
                : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50/50'
            }`}
          >
            <Upload className="h-4 w-4" />
            UP Data
          </button>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-400 border border-slate-200 bg-slate-50 cursor-not-allowed" title="Solo admin y coordinador de operaciones pueden subir datos">
            <ShieldAlert className="h-4 w-4" />
            UP Data
          </div>
        )}
      </div>

      {/* Content */}
      {section === 'download' && <DownloadSection movs={movs} />}
      {section === 'upload' && puedeSubir && <UpDataSection />}
      {section === 'upload' && !puedeSubir && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-6 flex flex-col items-center justify-center text-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <ShieldAlert className="h-6 w-6 text-amber-600" />
          </div>
          <div>
            <p className="font-bold text-amber-800">Acceso restringido</p>
            <p className="text-sm text-amber-600 mt-1">
              Solo los roles <span className="font-semibold">Administrador</span> y <span className="font-semibold">Coordinador de Operaciones</span> pueden subir archivos de stock.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
