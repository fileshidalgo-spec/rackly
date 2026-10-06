'use client'

/**
 * RACKLY — Módulo Recepción (independiente).
 *
 * Registro de recepción de mercadería/documentos con:
 *   · Formulario de registro (usuario tomado de la sesión).
 *   · Listado con búsqueda y filtro por estado.
 *   · Cambio de estado inline (autor o admin/supervisores).
 *   · Eliminación (solo admin/supervisores, misma política que Racks).
 *
 * Aislamiento: solo usa su tabla `recepcion_registros` vía
 * src/lib/rackly/modulos.ts. No toca Racks ni Piso.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import {
  listarRecepciones,
  crearRecepcion,
  cambiarEstadoRecepcion,
  eliminarRecepcion,
  ESTADOS_RECEPCION,
  TIPOS_DOCUMENTO_RECEPCION,
  type RegistroRecepcion,
} from '@/lib/rackly/modulos'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  PackageCheck,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Loader2,
  Inbox,
} from 'lucide-react'

const PAGE_SIZE = 50

const ESTADO_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  Recibido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Observado: 'bg-rose-50 text-rose-700 border-rose-200',
}

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

export function RecepcionModule() {
  const { perfil } = useAuth()
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEliminar =
    perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)
  const puedeCambiarEstado = useCallback(
    (reg: RegistroRecepcion) => puedeEliminar || reg.usuarioId === perfil?.id,
    [puedeEliminar, perfil?.id]
  )

  const [filas, setFilas] = useState<RegistroRecepcion[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [estadoFiltro, setEstadoFiltro] = useState('todos')
  const [offset, setOffset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RegistroRecepcion | null>(null)

  // Formulario
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fDoc, setFDoc] = useState('Guia')
  const [fNumero, setFNumero] = useState('')
  const [fProveedor, setFProveedor] = useState('')
  const [fCodigo, setFCodigo] = useState('')
  const [fDescripcion, setFDescripcion] = useState('')
  const [fCantidad, setFCantidad] = useState('')
  const [fObs, setFObs] = useState('')

  const formRef = useRef<HTMLDivElement>(null)

  const cargar = useCallback(
    async (nuevoOffset: number, reemplazar: boolean) => {
      setLoading(true)
      try {
        const { filas: filasNuevas, total: totalNuevo } = await listarRecepciones({
          busqueda,
          estado: estadoFiltro === 'todos' ? '' : estadoFiltro,
          limit: PAGE_SIZE,
          offset: nuevoOffset,
        })
        setFilas((prev) => (reemplazar ? filasNuevas : [...prev, ...filasNuevas]))
        setTotal(totalNuevo)
        setOffset(nuevoOffset)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error desconocido'
        toast.error('Error al cargar recepciones', { description: message })
      } finally {
        setLoading(false)
      }
    },
    [busqueda, estadoFiltro]
  )

  useEffect(() => {
    cargar(0, true)
  }, [estadoFiltro])

  function buscar() {
    cargar(0, true)
  }

  async function handleRegistrar() {
    const cantidad = parseFloat(fCantidad.replace(',', '.'))
    if (!fProveedor.trim() && !fCodigo.trim()) {
      toast.error('Ingresa al menos el proveedor o el código del artículo')
      return
    }
    if (isNaN(cantidad) || cantidad <= 0) {
      toast.error('La cantidad debe ser un número mayor a 0')
      return
    }
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    setSaving(true)
    try {
      await crearRecepcion(
        {
          fecha: fFecha || hoyISO(),
          tipoDocumento: fDoc,
          numeroDocumento: fNumero,
          proveedor: fProveedor,
          codigo: fCodigo,
          descripcion: fDescripcion,
          cantidad,
          observaciones: fObs,
        },
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success('Recepción registrada')
      setFNumero('')
      setFProveedor('')
      setFCodigo('')
      setFDescripcion('')
      setFCantidad('')
      setFObs('')
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo registrar', { description: message })
    } finally {
      setSaving(false)
    }
  }

  async function handleEstado(reg: RegistroRecepcion, estado: string) {
    if (!puedeCambiarEstado(reg)) {
      toast.error('Solo el autor o un supervisor puede cambiar el estado.')
      return
    }
    try {
      await cambiarEstadoRecepcion(reg.id, estado)
      setFilas((prev) => prev.map((r) => (r.id === reg.id ? { ...r, estado } : r)))
      toast.success(`Estado actualizado a ${estado}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo actualizar el estado', { description: message })
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await eliminarRecepcion(target.id)
      toast.success('Registro eliminado')
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  const hayMas = filas.length < total

  return (
    <div className="space-y-5">
      {/* ── Formulario de registro ── */}
      <div ref={formRef} className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">Nueva recepción</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Fecha</Label>
            <Input type="date" value={fFecha} onChange={(e) => setFFecha(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tipo de documento</Label>
            <Select value={fDoc} onValueChange={setFDoc}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS_DOCUMENTO_RECEPCION.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nº de documento</Label>
            <Input
              placeholder="Ej: GR-0012345"
              value={fNumero}
              onChange={(e) => setFNumero(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Proveedor</Label>
            <Input
              placeholder="Nombre del proveedor"
              value={fProveedor}
              onChange={(e) => setFProveedor(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Código</Label>
            <Input
              placeholder="Código del artículo"
              value={fCodigo}
              onChange={(e) => setFCodigo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label className="text-xs">Descripción</Label>
            <Input
              placeholder="Descripción del artículo o mercadería"
              value={fDescripcion}
              onChange={(e) => setFDescripcion(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Cantidad</Label>
            <Input
              inputMode="decimal"
              placeholder="0"
              value={fCantidad}
              onChange={(e) => setFCantidad(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Observaciones</Label>
            <Textarea
              rows={2}
              placeholder="Observaciones de la recepción (opcional)"
              value={fObs}
              onChange={(e) => setFObs(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={handleRegistrar}
              disabled={saving}
              className="w-full gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
              Registrar
            </Button>
          </div>
        </div>
      </div>

      {/* ── Filtros ── */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Buscar por proveedor, código, documento o descripción…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && buscar()}
          />
        </div>
        <Select value={estadoFiltro} onValueChange={setEstadoFiltro}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            {ESTADOS_RECEPCION.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={buscar} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Buscar
        </Button>
      </div>

      {/* ── Listado desktop ── */}
      <div className="hidden md:block rounded-lg border overflow-x-auto bg-white">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Fecha</TableHead>
              <TableHead className="w-[150px]">Documento</TableHead>
              <TableHead className="min-w-[140px]">Proveedor</TableHead>
              <TableHead className="min-w-[180px]">Artículo</TableHead>
              <TableHead className="w-[90px] text-right">Cant.</TableHead>
              <TableHead className="w-[140px]">Estado</TableHead>
              <TableHead className="min-w-[130px]">Registró</TableHead>
              {puedeEliminar && <TableHead className="w-[60px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-slate-400 py-10">
                  <Inbox className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                  No hay recepciones registradas con los filtros actuales.
                </TableCell>
              </TableRow>
            )}
            {filas.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-slate-500">{r.fecha}</TableCell>
                <TableCell>
                  <p className="text-xs font-semibold">{r.tipoDocumento}</p>
                  <p className="text-xs text-slate-400">{r.numeroDocumento || '—'}</p>
                </TableCell>
                <TableCell className="text-sm truncate max-w-[180px]" title={r.proveedor}>
                  {r.proveedor || '—'}
                </TableCell>
                <TableCell>
                  <p className="text-sm font-medium truncate max-w-[220px]" title={r.descripcion}>
                    {r.codigo}
                    {r.descripcion ? ` · ${r.descripcion}` : ''}
                  </p>
                </TableCell>
                <TableCell className="text-right text-sm font-semibold">{r.cantidad}</TableCell>
                <TableCell>
                  {puedeCambiarEstado(r) ? (
                    <Select value={r.estado} onValueChange={(v) => handleEstado(r, v)}>
                      <SelectTrigger className="h-8 w-[125px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ESTADOS_RECEPCION.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className={ESTADO_CLASE[r.estado] ?? ''}>
                      {r.estado}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <p className="text-xs font-medium truncate max-w-[130px]" title={r.usuarioNombre}>
                    {r.usuarioNombre || '—'}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate max-w-[130px]">{r.usuarioCorreo}</p>
                </TableCell>
                {puedeEliminar && (
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                      onClick={() => setDeleteTarget(r)}
                      title="Eliminar registro"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Listado móvil ── */}
      <div className="md:hidden space-y-3">
        {filas.length === 0 && !loading && (
          <p className="text-sm text-slate-400 text-center py-8">No hay recepciones para mostrar.</p>
        )}
        {filas.map((r) => (
          <div key={r.id} className="rounded-lg border bg-white p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">
                  {r.codigo || r.proveedor || '(sin código)'}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {r.descripcion || r.proveedor || '—'}
                </p>
              </div>
              <Badge variant="outline" className={`${ESTADO_CLASE[r.estado] ?? ''} shrink-0`}>
                {r.estado}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs text-slate-500">
              <span>Fecha: {r.fecha}</span>
              <span>Cant.: {r.cantidad}</span>
              <span className="truncate">
                Doc: {r.tipoDocumento} {r.numeroDocumento || ''}
              </span>
              <span className="truncate">Por: {r.usuarioNombre || '—'}</span>
            </div>
            {puedeCambiarEstado(r) && (
              <Select value={r.estado} onValueChange={(v) => handleEstado(r, v)}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ESTADOS_RECEPCION.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {puedeEliminar && (
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1 text-rose-600 hover:bg-rose-50"
                onClick={() => setDeleteTarget(r)}
              >
                <Trash2 className="h-3 w-3" /> Eliminar
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* ── Paginación ── */}
      {hayMas && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => cargar(offset + PAGE_SIZE, false)}
            disabled={loading}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Cargar más ({filas.length} de {total})
          </Button>
        </div>
      )}

      {/* ── Confirmar eliminación ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-md max-h-[85vh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar registro de recepción</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar el registro {deleteTarget?.tipoDocumento}{' '}
              <strong>{deleteTarget?.numeroDocumento || '(sin número)'}</strong> de{' '}
              <strong>{deleteTarget?.proveedor || 'proveedor sin nombre'}</strong>? Esta acción no se
              puede deshacer.
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
