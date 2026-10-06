'use client'

/**
 * RACKLY — Módulo Atención (independiente).
 *
 * Tickets de atención/soporte interno con:
 *   · Formulario de registro (usuario tomado de la sesión).
 *   · Listado con búsqueda y filtro por estado.
 *   · Cambio de estado inline (autor o admin/supervisores); al pasar a
 *     'Atendido' se sella la hora de cierre.
 *   · Eliminación (solo admin/supervisores).
 *
 * Aislamiento: solo usa su tabla `atencion_registros` vía
 * src/lib/rackly/modulos.ts. No toca Racks ni Piso.
 */

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { ROLES_SUPERVISORES } from '@/lib/rackly/constants'
import {
  listarAtenciones,
  crearAtencion,
  cambiarEstadoAtencion,
  eliminarAtencion,
  ESTADOS_ATENCION,
  TIPOS_ATENCION,
  type RegistroAtencion,
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
  HeartHandshake,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Loader2,
  Inbox,
  Clock,
  CheckCircle2,
} from 'lucide-react'

const PAGE_SIZE = 50

const ESTADO_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function hoyISO(): string {
  const d = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

export function AtencionModule() {
  const { perfil } = useAuth()
  const SUPERVISORES_SET = new Set<string>(ROLES_SUPERVISORES)
  const puedeEliminar =
    perfil?.rol === 'admin' || (perfil?.rol ? SUPERVISORES_SET.has(perfil.rol) : false)
  const puedeCambiarEstado = useCallback(
    (reg: RegistroAtencion) => puedeEliminar || reg.usuarioId === perfil?.id,
    [puedeEliminar, perfil?.id]
  )

  const [filas, setFilas] = useState<RegistroAtencion[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [estadoFiltro, setEstadoFiltro] = useState('todos')
  const [offset, setOffset] = useState(0)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RegistroAtencion | null>(null)

  // Formulario
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fSolicitante, setFSolicitante] = useState('')
  const [fArea, setFArea] = useState('')
  const [fTipo, setFTipo] = useState('Consulta')
  const [fAsunto, setFAsunto] = useState('')
  const [fDetalle, setFDetalle] = useState('')

  const cargar = useCallback(
    async (nuevoOffset: number, reemplazar: boolean) => {
      setLoading(true)
      try {
        const { filas: filasNuevas, total: totalNuevo } = await listarAtenciones({
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
        toast.error('Error al cargar atenciones', { description: message })
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
    if (!fAsunto.trim()) {
      toast.error('Ingresa el asunto de la atención')
      return
    }
    if (!fSolicitante.trim()) {
      toast.error('Ingresa el solicitante')
      return
    }
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    setSaving(true)
    try {
      await crearAtencion(
        {
          fecha: fFecha || hoyISO(),
          solicitante: fSolicitante,
          area: fArea,
          tipo: fTipo,
          asunto: fAsunto,
          detalle: fDetalle,
        },
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success('Atención registrada')
      setFSolicitante('')
      setFArea('')
      setFAsunto('')
      setFDetalle('')
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo registrar', { description: message })
    } finally {
      setSaving(false)
    }
  }

  async function handleEstado(reg: RegistroAtencion, estado: string) {
    if (!puedeCambiarEstado(reg)) {
      toast.error('Solo el autor o un supervisor puede cambiar el estado.')
      return
    }
    try {
      await cambiarEstadoAtencion(reg.id, estado)
      setFilas((prev) =>
        prev.map((r) =>
          r.id === reg.id
            ? { ...r, estado, atendidoEn: estado === 'Atendido' ? new Date().toISOString() : '' }
            : r
        )
      )
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
      await eliminarAtencion(target.id)
      toast.success('Registro eliminado')
      cargar(0, true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  const pendientes = filas.filter((r) => r.estado === 'Pendiente').length
  const atendidos = filas.filter((r) => r.estado === 'Atendido').length
  const hayMas = filas.length < total

  return (
    <div className="space-y-5">
      {/* ── Resumen rápido ── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3">
          <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">Pendientes</p>
          <p className="text-xl font-extrabold text-amber-900">{pendientes}</p>
        </div>
        <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-3">
          <p className="text-[11px] font-semibold text-sky-700 uppercase tracking-wide">Total cargados</p>
          <p className="text-xl font-extrabold text-sky-900">{filas.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
          <p className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wide">Atendidos</p>
          <p className="text-xl font-extrabold text-emerald-900">{atendidos}</p>
        </div>
      </div>

      {/* ── Formulario de registro ── */}
      <div className="rounded-xl border border-teal-100 bg-teal-50/50 p-4">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="h-4 w-4 text-teal-600" />
          <h3 className="text-sm font-bold text-teal-900">Nueva atención</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Fecha</Label>
            <Input type="date" value={fFecha} onChange={(e) => setFFecha(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Solicitante</Label>
            <Input
              placeholder="Quien solicita la atención"
              value={fSolicitante}
              onChange={(e) => setFSolicitante(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Área</Label>
            <Input
              placeholder="Área o sector"
              value={fArea}
              onChange={(e) => setFArea(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tipo</Label>
            <Select value={fTipo} onValueChange={setFTipo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS_ATENCION.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Asunto</Label>
            <Input
              placeholder="Resumen de la solicitud"
              value={fAsunto}
              onChange={(e) => setFAsunto(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Detalle</Label>
            <Textarea
              rows={2}
              placeholder="Detalle de la atención (opcional)"
              value={fDetalle}
              onChange={(e) => setFDetalle(e.target.value)}
            />
          </div>
          <div className="flex items-end lg:col-span-3">
            <Button
              onClick={handleRegistrar}
              disabled={saving}
              className="w-full sm:w-auto gap-2 bg-gradient-to-r from-teal-500 to-cyan-600 text-white hover:from-teal-600 hover:to-cyan-700"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <HeartHandshake className="h-4 w-4" />}
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
            placeholder="Buscar por solicitante, área, asunto o tipo…"
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
            {ESTADOS_ATENCION.map((e) => (
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
              <TableHead className="min-w-[170px]">Asunto</TableHead>
              <TableHead className="min-w-[140px]">Solicitante</TableHead>
              <TableHead className="w-[110px]">Área</TableHead>
              <TableHead className="w-[110px]">Tipo</TableHead>
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
                  No hay atenciones registradas con los filtros actuales.
                </TableCell>
              </TableRow>
            )}
            {filas.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-slate-500">{r.fecha}</TableCell>
                <TableCell>
                  <p className="text-sm font-medium truncate max-w-[240px]" title={r.asunto}>
                    {r.asunto}
                  </p>
                  {r.detalle && (
                    <p className="text-xs text-slate-400 truncate max-w-[240px]" title={r.detalle}>
                      {r.detalle}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-sm truncate max-w-[160px]" title={r.solicitante}>
                  {r.solicitante}
                </TableCell>
                <TableCell className="text-sm text-slate-500">{r.area || '—'}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-[10px]">
                    {r.tipo}
                  </Badge>
                </TableCell>
                <TableCell>
                  {puedeCambiarEstado(r) ? (
                    <Select value={r.estado} onValueChange={(v) => handleEstado(r, v)}>
                      <SelectTrigger className="h-8 w-[125px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ESTADOS_ATENCION.map((e) => (
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
                  {r.estado === 'Atendido' && r.atendidoEn && (
                    <p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-600">
                      <CheckCircle2 className="h-3 w-3" />
                      {new Date(r.atendidoEn).toLocaleString('es-PE', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
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
          <p className="text-sm text-slate-400 text-center py-8">No hay atenciones para mostrar.</p>
        )}
        {filas.map((r) => (
          <div key={r.id} className="rounded-lg border bg-white p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{r.asunto}</p>
                <p className="text-xs text-slate-500 truncate">
                  {r.solicitante}
                  {r.area ? ` · ${r.area}` : ''}
                </p>
              </div>
              <Badge variant="outline" className={`${ESTADO_CLASE[r.estado] ?? ''} shrink-0`}>
                {r.estado}
              </Badge>
            </div>
            {r.detalle && <p className="text-xs text-slate-500 line-clamp-2">{r.detalle}</p>}
            <div className="grid grid-cols-2 gap-1 text-xs text-slate-500">
              <span>Fecha: {r.fecha}</span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> {r.tipo}
              </span>
              <span className="truncate">Por: {r.usuarioNombre || '—'}</span>
            </div>
            {puedeCambiarEstado(r) && (
              <Select value={r.estado} onValueChange={(v) => handleEstado(r, v)}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ESTADOS_ATENCION.map((e) => (
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
            <AlertDialogTitle>Eliminar registro de atención</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Eliminar la atención <strong>{deleteTarget?.asunto}</strong> de{' '}
              <strong>{deleteTarget?.solicitante || 'solicitante sin nombre'}</strong>? Esta acción no
              se puede deshacer.
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
