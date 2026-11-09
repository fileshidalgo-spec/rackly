'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Catálogo.
 *
 * Dos pestañas:
 *   1 · Artículos: búsqueda paginada EN SERVIDOR (25 000 filas — nunca se
 *       bajan todas), edición/eliminación con permisos del cuadro
 *       (repuestos.gestionar / repuestos.eliminar).
 *   2 · Carga Excel: 4 columnas (CODIGO · DESCRIPCIÓN · UND · CANTIDAD).
 *       Upsert por código: re-subir NO duplica (actualiza + crea). Lotes
 *       de 500 con barra de progreso, descarte honesto de filas inválidas
 *       y reporte de errores descargable. Patrón DescargaTab (Insumos).
 *
 * cantidad_ref es SOLO REFERENCIA del Excel: jamás se usa como stock.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repBuscarArticulos,
  repCrearArticulo,
  repActualizarArticulo,
  repEliminarArticulo,
  repUpsertArticulosLote,
  type RepArticulo,
  type RepFilaExcel,
} from '@/lib/rackly/rep/rep-client'
import { repDetectarColumnas, repMapearFilas, repNumeroDeCelda } from '@/lib/rackly/rep/rep-excel'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  BookOpen,
  Download,
  FileSpreadsheet,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

const PAGE_SIZE = 50

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('es-PE') : n.toLocaleString('es-PE', { maximumFractionDigits: 3 })
}

export function CatalogoModule() {
  const { perfil } = useAuth()
  const puedeGestionar = puede(perfil, 'repuestos.gestionar')
  const puedeEliminar = puede(perfil, 'repuestos.eliminar')

  return (
    <Tabs defaultValue="articulos" className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="articulos" className="gap-1.5">
          <Search className="h-3.5 w-3.5" /> Artículos
        </TabsTrigger>
        {puedeGestionar && (
          <TabsTrigger value="carga" className="gap-1.5">
            <Upload className="h-3.5 w-3.5" /> Carga Excel
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="articulos">
        <ListaArticulos puedeGestionar={puedeGestionar} puedeEliminar={puedeEliminar} />
      </TabsContent>

      {puedeGestionar && (
        <TabsContent value="carga">
          <CargaExcel />
        </TabsContent>
      )}
    </Tabs>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   PESTAÑA 1 · LISTA DE ARTÍCULOS (búsqueda + edición)
   ═══════════════════════════════════════════════════════════════════ */

function ListaArticulos({ puedeGestionar, puedeEliminar }: { puedeGestionar: boolean; puedeEliminar: boolean }) {
  const [busqueda, setBusqueda] = useState('')
  const [busquedaAplicada, setBusquedaAplicada] = useState('')
  const [soloActivos, setSoloActivos] = useState(false)
  const [filas, setFilas] = useState<RepArticulo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [editTarget, setEditTarget] = useState<RepArticulo | null>(null)
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RepArticulo | null>(null)
  const cargaGenRef = useRef(0)

  const cargar = useCallback(async (p: number, q: string, activos: boolean) => {
    const gen = ++cargaGenRef.current
    setLoading(true)
    try {
      const res = await repBuscarArticulos({ busqueda: q || undefined, soloActivos: activos, page: p, pageSize: PAGE_SIZE })
      if (gen !== cargaGenRef.current) return
      setFilas(res.filas)
      setTotal(res.total)
      setPage(p)
    } catch (err: unknown) {
      if (gen !== cargaGenRef.current) return
      toast.error('Error al buscar artículos', { description: mensajeError(err) })
    } finally {
      if (gen === cargaGenRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    cargar(1, '', false)
  }, [cargar])

  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function aplicarBusqueda() {
    setBusquedaAplicada(busqueda.trim())
    cargar(1, busqueda.trim(), soloActivos)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const t = deleteTarget
    setDeleteTarget(null)
    try {
      await repEliminarArticulo(t.id)
      toast.success(`Artículo ${t.codigo} eliminado`)
      cargar(page, busquedaAplicada, soloActivos)
    } catch (err: unknown) {
      toast.error('No se pudo eliminar', { description: mensajeError(err) })
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9 pr-9"
            placeholder="Código o descripción…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') aplicarBusqueda() }}
          />
          {busqueda && (
            <button
              onClick={() => { setBusqueda(''); setBusquedaAplicada(''); cargar(1, '', soloActivos) }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              title="Limpiar búsqueda"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
          <Switch id="solo-activos" checked={soloActivos} onCheckedChange={(v) => { setSoloActivos(v); cargar(1, busquedaAplicada, v) }} />
          <Label htmlFor="solo-activos" className="text-xs font-semibold cursor-pointer">Solo activos</Label>
        </div>
        <Button onClick={aplicarBusqueda} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Buscar
        </Button>
        {puedeGestionar && (
          <Button onClick={() => setNuevoOpen(true)} variant="outline" className="gap-2">
            <Plus className="h-4 w-4" /> Nuevo
          </Button>
        )}
      </div>

      {/* Resumen */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Badge variant="outline" className="font-semibold">{total.toLocaleString('es-PE')} artículos</Badge>
        {busquedaAplicada && <Badge variant="outline" className="font-semibold">Búsqueda: “{busquedaAplicada}”</Badge>}
      </div>

      {/* Tabla */}
      <div className="rounded-lg border overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">Código</TableHead>
              <TableHead className="min-w-[240px]">Descripción</TableHead>
              <TableHead className="w-[70px]">Und</TableHead>
              <TableHead className="w-[100px] text-right">Cant. ref.</TableHead>
              <TableHead className="w-[90px]">Estado</TableHead>
              {(puedeGestionar || puedeEliminar) && <TableHead className="w-[90px] text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-slate-400 py-10">
                  <BookOpen className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  {busquedaAplicada ? 'Sin resultados para la búsqueda.' : 'El catálogo está vacío — usa la pestaña Carga Excel.'}
                </TableCell>
              </TableRow>
            )}
            {filas.map((a) => (
              <TableRow key={a.id} className={a.activo ? '' : 'opacity-60'}>
                <TableCell className="font-mono text-xs font-bold">{a.codigo}</TableCell>
                <TableCell className="text-sm">
                  <span className="block truncate max-w-[320px]" title={a.descripcion}>{a.descripcion}</span>
                </TableCell>
                <TableCell className="text-xs text-slate-500">{a.und || '—'}</TableCell>
                <TableCell className="text-right text-sm font-semibold">{fmtNum(a.cantidad_ref)}</TableCell>
                <TableCell>
                  {a.activo ? (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">Activo</Badge>
                  ) : (
                    <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 text-[10px]">Inactivo</Badge>
                  )}
                </TableCell>
                {(puedeGestionar || puedeEliminar) && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {puedeGestionar && (
                        <Button size="icon" variant="ghost" onClick={() => setEditTarget(a)} title="Editar artículo">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {puedeEliminar && (
                        <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(a)} title="Eliminar artículo">
                          <Trash2 className="h-4 w-4 text-rose-600" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Paginación */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Página {page} de {paginas}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => cargar(page - 1, busquedaAplicada, soloActivos)}>
              Anterior
            </Button>
            <Button size="sm" variant="outline" disabled={page >= paginas || loading} onClick={() => cargar(page + 1, busquedaAplicada, soloActivos)}>
              Siguiente
            </Button>
          </div>
        </div>
      )}

      {/* Diálogo: nuevo / editar */}
      <DialogoArticulo
        open={nuevoOpen || !!editTarget}
        articulo={editTarget}
        onOpenChange={(open) => { if (!open) { setNuevoOpen(false); setEditTarget(null) } }}
        onGuardado={() => {
          setNuevoOpen(false)
          setEditTarget(null)
          cargar(page, busquedaAplicada, soloActivos)
        }}
      />

      {/* Confirmación de eliminación */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar artículo</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar <strong>{deleteTarget?.codigo}</strong> — {deleteTarget?.descripcion}? Si el
              artículo tiene stock registrado, la BD rechazará la operación para proteger el kardex.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   DIÁLOGO NUEVO / EDITAR ARTÍCULO
   ═══════════════════════════════════════════════════════════════════ */

function DialogoArticulo({
  open,
  articulo,
  onOpenChange,
  onGuardado,
}: {
  open: boolean
  articulo: RepArticulo | null
  onOpenChange: (open: boolean) => void
  onGuardado: () => void
}) {
  const esEdicion = !!articulo
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [und, setUnd] = useState('')
  const [cantidadRef, setCantidadRef] = useState('')
  const [marca, setMarca] = useState('')
  const [modelo, setModelo] = useState('')
  const [aplicacion, setAplicacion] = useState('')
  const [activo, setActivo] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setCodigo(articulo?.codigo ?? '')
      setDescripcion(articulo?.descripcion ?? '')
      setUnd(articulo?.und ?? '')
      setCantidadRef(articulo ? String(articulo.cantidad_ref) : '')
      setMarca(articulo?.marca ?? '')
      setModelo(articulo?.modelo ?? '')
      setAplicacion(articulo?.aplicacion ?? '')
      setActivo(articulo?.activo ?? true)
    }
  }, [open, articulo])

  async function guardar() {
    if (!codigo.trim() || !descripcion.trim()) {
      toast.error('Código y descripción son obligatorios')
      return
    }
    setBusy(true)
    try {
      const cantidad = repNumeroDeCelda(cantidadRef)
      if (esEdicion && articulo) {
        await repActualizarArticulo(articulo.id, {
          descripcion: descripcion.trim(),
          und: und.trim(),
          cantidad_ref: cantidad,
          marca: marca.trim(),
          modelo: modelo.trim(),
          aplicacion: aplicacion.trim(),
          activo,
        })
        toast.success('Artículo actualizado')
      } else {
        await repCrearArticulo({
          codigo: codigo.trim(),
          descripcion: descripcion.trim(),
          und: und.trim(),
          cantidad_ref: cantidad,
          marca: marca.trim(),
          modelo: modelo.trim(),
          aplicacion: aplicacion.trim(),
        })
        toast.success(`Artículo ${codigo.trim().toUpperCase()} creado`)
      }
      onGuardado()
    } catch (err: unknown) {
      toast.error(esEdicion ? 'No se pudo actualizar' : 'No se pudo crear', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{esEdicion ? `Editar ${articulo?.codigo}` : 'Nuevo artículo'}</DialogTitle>
          <DialogDescription>
            {esEdicion
              ? 'Los cambios quedan en el kardex intacto: el historial guarda el snapshot del momento.'
              : 'El código es el del sistema BIG MAGIC (se normaliza a mayúsculas).'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="art-codigo">Código *</Label>
            <Input id="art-codigo" value={codigo} disabled={esEdicion} onChange={(e) => setCodigo(e.target.value)} className="font-mono uppercase" placeholder="BJ-109-003" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="art-desc">Descripción *</Label>
            <Input id="art-desc" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Filtro de aire motor…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="art-und">Und</Label>
              <Input id="art-und" value={und} onChange={(e) => setUnd(e.target.value)} placeholder="UND / GLN / MTS" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="art-cref">Cantidad ref.</Label>
              <Input id="art-cref" value={cantidadRef} onChange={(e) => setCantidadRef(e.target.value)} inputMode="decimal" placeholder="0" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="art-marca">Marca</Label>
              <Input id="art-marca" value={marca} onChange={(e) => setMarca(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="art-modelo">Modelo</Label>
              <Input id="art-modelo" value={modelo} onChange={(e) => setModelo(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="art-aplic">Aplicación</Label>
            <Input id="art-aplic" value={aplicacion} onChange={(e) => setAplicacion(e.target.value)} placeholder="Equipo / modelo donde se usa" />
          </div>
          {esEdicion && (
            <div className="flex items-center gap-2">
              <Switch id="art-activo" checked={activo} onCheckedChange={setActivo} />
              <Label htmlFor="art-activo" className="cursor-pointer">Artículo activo</Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={guardar} disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {esEdicion ? 'Guardar cambios' : 'Crear artículo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   PESTAÑA 2 · CARGA EXCEL (upsert por código, lotes de 500)
   ═══════════════════════════════════════════════════════════════════ */

type VistaPrevia = {
  filas: RepFilaExcel[]
  descartes: string[]
  duplicados: string[]
  nombreArchivo: string
}

function CargaExcel() {
  const [preview, setPreview] = useState<VistaPrevia | null>(null)
  const [busy, setBusy] = useState(false)
  const [progreso, setProgreso] = useState(0)
  const [resultado, setResultado] = useState<{ ok: number; errores: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function limpiar() {
    setPreview(null)
    setResultado(null)
    setProgreso(0)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setResultado(null)
    setProgreso(0)
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
      const col = repDetectarColumnas(headers)
      if (!col) {
        toast.error('No se detectaron columnas en el archivo')
        return
      }
      const { filas, descartes, duplicadosArchivo } = repMapearFilas(data, col)
      if (filas.length === 0) {
        toast.error('No se encontraron filas válidas (¿falta la columna CODIGO?)', {
          description: descartes.slice(0, 3).join(' · '),
        })
        return
      }
      setPreview({ filas, descartes, duplicados: duplicadosArchivo, nombreArchivo: f.name })
      toast.success(`${filas.length.toLocaleString('es-PE')} fila(s) listas para cargar`, {
        description: descartes.length > 0 ? `${descartes.length} fila(s) serán descartadas (ver reporte)` : undefined,
        duration: 7000,
      })
    } catch {
      toast.error('Error al leer el archivo. Verifica que sea un .xlsx válido.')
    }
  }

  async function cargar() {
    if (!preview || preview.filas.length === 0) return
    if (
      !confirm(
        `Se cargarán ${preview.filas.length.toLocaleString('es-PE')} artículo(s).\n\n` +
          `Es un UPSERT por código: los existentes se ACTUALIZAN (descripción, und, cantidad ref.) y los nuevos se CREAN. No se borra nada.\n\n¿Continuar?`
      )
    ) return
    setBusy(true)
    setProgreso(0)
    setResultado(null)
    try {
      const res = await repUpsertArticulosLote(preview.filas, (hechas, total) =>
        setProgreso(Math.round((hechas / total) * 100))
      )
      setResultado(res)
      if (res.errores.length === 0) {
        toast.success(`${res.ok.toLocaleString('es-PE')} artículo(s) cargados correctamente`)
      } else {
        toast.warning(`Carga parcial: ${res.ok.toLocaleString('es-PE')} ok · ${res.errores.length} lote(s) con error`, { duration: 9000 })
      }
    } catch (err: unknown) {
      toast.error('Error en la carga', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  function descargarErrores() {
    if (!resultado || resultado.errores.length === 0) return
    const texto = ['RACKLY REPUESTOS — Reporte de carga de catálogo', `Fecha: ${new Date().toLocaleString('es-PE')}`, '', ...resultado.errores].join('\n')
    const blob = new Blob([texto], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reporte_carga_catalogo_${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-xl border bg-white p-4 space-y-4">
      <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 space-y-1">
        <p className="font-extrabold flex items-center gap-1.5">
          <FileSpreadsheet className="h-4 w-4" /> Formato esperado: 4 columnas
        </p>
        <p><strong>CODIGO</strong> (código BIG MAGIC, obligatorio) · <strong>DESCRIPCIÓN</strong> (obligatoria) · <strong>UND</strong> · <strong>CANTIDAD</strong> (solo referencia: no crea stock).</p>
        <p>Re-subir un Excel NO duplica: actualiza los existentes y crea los nuevos. Preparado para ~25 000 filas.</p>
      </div>

      {!preview && (
        <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/50 p-8 cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors">
          <Upload className="h-8 w-8 text-slate-400" />
          <span className="text-sm font-semibold text-slate-600">Selecciona el archivo .xlsx del catálogo</span>
          <span className="text-xs text-slate-400">Las columnas se detectan automáticamente (CODIGO, DESCRIPCIÓN, UND, CANTIDAD)</span>
          <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} disabled={busy} />
        </label>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="font-semibold">{preview.nombreArchivo}</Badge>
            <Badge variant="outline" className="font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">
              {preview.filas.length.toLocaleString('es-PE')} válidas
            </Badge>
            {preview.descartes.length > 0 && (
              <Badge variant="outline" className="font-semibold bg-amber-50 text-amber-700 border-amber-200">
                {preview.descartes.length} descartadas
              </Badge>
            )}
            {preview.duplicados.length > 0 && (
              <Badge variant="outline" className="font-semibold bg-blue-50 text-blue-700 border-blue-200">
                {preview.duplicados.length} códigos repetidos (gana la última)
              </Badge>
            )}
            <Button size="sm" variant="ghost" onClick={limpiar} disabled={busy} className="gap-1 ml-auto">
              <X className="h-3.5 w-3.5" /> Elegir otro archivo
            </Button>
          </div>

          {/* Vista previa (primeras 8) */}
          <div className="rounded-lg border overflow-x-auto">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Fila</TableHead>
                  <TableHead className="w-[140px]">Código</TableHead>
                  <TableHead className="min-w-[220px]">Descripción</TableHead>
                  <TableHead className="w-[70px]">Und</TableHead>
                  <TableHead className="w-[90px] text-right">Cant. ref.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.filas.slice(0, 8).map((f) => (
                  <TableRow key={f.fila}>
                    <TableCell className="text-xs text-slate-400">{f.fila}</TableCell>
                    <TableCell className="font-mono text-xs font-bold">{f.codigo}</TableCell>
                    <TableCell className="text-sm truncate max-w-[280px]" title={f.descripcion}>{f.descripcion}</TableCell>
                    <TableCell className="text-xs text-slate-500">{f.und || '—'}</TableCell>
                    <TableCell className="text-right text-sm">{fmtNum(f.cantidad_ref)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {preview.filas.length > 8 && (
            <p className="text-xs text-slate-400 text-center">…y {(preview.filas.length - 8).toLocaleString('es-PE')} filas más</p>
          )}

          {busy && (
            <div className="space-y-1.5">
              <Progress value={progreso} />
              <p className="text-xs text-slate-500 text-center">Cargando… {progreso}%</p>
            </div>
          )}

          {resultado && (
            <div className={`rounded-lg border p-3 text-xs space-y-2 ${resultado.errores.length === 0 ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
              <p className={`font-extrabold ${resultado.errores.length === 0 ? 'text-emerald-800' : 'text-amber-800'}`}>
                {resultado.ok.toLocaleString('es-PE')} artículo(s) cargados
                {resultado.errores.length > 0 && ` · ${resultado.errores.length} error(es)`}
              </p>
              {resultado.errores.length > 0 && (
                <>
                  <ul className="list-disc list-inside space-y-0.5 text-amber-900 max-h-28 overflow-y-auto">
                    {resultado.errores.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                  <Button size="sm" variant="outline" onClick={descargarErrores} className="gap-1.5">
                    <Download className="h-3.5 w-3.5" /> Descargar reporte
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={limpiar} disabled={busy}>Cancelar</Button>
            <Button onClick={cargar} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Cargar {preview.filas.length.toLocaleString('es-PE')} artículo(s)
            </Button>
          </div>

          {/* Descartes (colapsado simple) */}
          {preview.descartes.length > 0 && !busy && (
            <details className="rounded-lg border border-slate-200 p-2 text-xs text-slate-500">
              <summary className="cursor-pointer font-semibold text-slate-600">
                Filas descartadas ({preview.descartes.length})
              </summary>
              <ul className="list-disc list-inside mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {preview.descartes.slice(0, 50).map((d, i) => <li key={i}>{d}</li>)}
                {preview.descartes.length > 50 && <li>…y {preview.descartes.length - 50} más</li>}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
