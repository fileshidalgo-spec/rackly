'use client'

/**
 * RACKLY — Módulo Usuarios (transversal).
 *
 * Sección 1 · Gestión: reutiliza el UsuariosTab existente (roles,
 *   aprobaciones, recuperación, eliminación) sin modificar su código.
 * Sección 2 · Actividad por módulo: consulta en SOLO LECTURA los
 *   movimientos de cada módulo (Racks, Piso, Recepción, Atención),
 *   globalmente o filtrados por usuario.
 *
 * Aislamiento: jamás escribe en tablas de otros módulos.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { UsuariosTab } from '@/components/rackly/kardex/UsuariosTab'
import { getTodosLosPerfiles, type Perfil } from '@/lib/rackly/auth'
import {
  listarActividad,
  ETIQUETA_MODULO,
  type ModuloActividad,
  type FilaActividad,
} from '@/lib/rackly/modulos'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Activity,
  Search,
  Loader2,
  RefreshCw,
  Shield,
  History,
} from 'lucide-react'

const MODULOS: ModuloActividad[] = ['racks', 'piso', 'recepcion', 'atencion']
const PAGE_SIZE = 100

const ESTADO_CLASE: Record<string, string> = {
  Pendiente: 'bg-amber-50 text-amber-700 border-amber-200',
  Recibido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Observado: 'bg-rose-50 text-rose-700 border-rose-200',
  'En proceso': 'bg-sky-50 text-sky-700 border-sky-200',
  Atendido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const TIPO_CLASE: Record<string, string> = {
  ingreso: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  salida: 'bg-rose-50 text-rose-700 border-rose-200',
  devolucion: 'bg-orange-50 text-orange-700 border-orange-200',
  traslado: 'bg-sky-50 text-sky-700 border-sky-200',
  stock_inicial: 'bg-slate-50 text-slate-600 border-slate-200',
  Recepción: 'bg-amber-50 text-amber-700 border-amber-200',
  Consulta: 'bg-slate-50 text-slate-600 border-slate-200',
  Soporte: 'bg-sky-50 text-sky-700 border-sky-200',
  Mantenimiento: 'bg-orange-50 text-orange-700 border-orange-200',
  Otro: 'bg-slate-50 text-slate-600 border-slate-200',
}

function fmtFecha(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function UsuariosModule() {
  // ── Sección actividad ──
  const [modulo, setModulo] = useState<ModuloActividad>('racks')
  const [usuarioId, setUsuarioId] = useState('todos')
  const [busquedaUsuario, setBusquedaUsuario] = useState('')
  const [perfiles, setPerfiles] = useState<Perfil[]>([])
  const [filas, setFilas] = useState<FilaActividad[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)

  const loadedRef = useRef(false)

  const cargarPerfiles = useCallback(async () => {
    try {
      const data = await getTodosLosPerfiles()
      setPerfiles(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al cargar usuarios', { description: message })
    }
  }, [])

  const cargarActividad = useCallback(
    async (nuevoOffset: number, reemplazar: boolean) => {
      setLoading(true)
      try {
        const { filas: filasNuevas, total: totalNuevo } = await listarActividad(
          modulo,
          usuarioId === 'todos' ? null : usuarioId,
          PAGE_SIZE,
          nuevoOffset
        )
        setFilas((prev) => (reemplazar ? filasNuevas : [...prev, ...filasNuevas]))
        setTotal(totalNuevo)
        setOffset(nuevoOffset)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error desconocido'
        toast.error('Error al cargar actividad', { description: message })
      } finally {
        setLoading(false)
      }
    },
    [modulo, usuarioId]
  )

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true
      cargarPerfiles()
    }
  }, [cargarPerfiles])

  // Recarga al cambiar módulo o usuario
  useEffect(() => {
    if (loadedRef.current) cargarActividad(0, true)
  }, [cargarActividad])

  const usuarioSeleccionado = perfiles.find((p) => p.id === usuarioId) ?? null

  // Filtrado local adicional por nombre/correo (cuando "Todos")
  const filasVisibles =
    usuarioId === 'todos' && busquedaUsuario.trim()
    ? filas.filter((f) => {
        const b = busquedaUsuario.trim().toLowerCase()
        return (
          f.usuarioNombre.toLowerCase().includes(b) ||
          f.usuarioCorreo.toLowerCase().includes(b)
        )
      })
    : filas

  return (
    <div className="space-y-5">
      {/* ═══ SECCIÓN 1 · GESTIÓN ═══ */}
      <div className="rounded-xl border bg-white p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-md shadow-slate-500/20">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-extrabold text-slate-900">Gestión de usuarios</h3>
            <p className="text-xs text-slate-500">
              Roles, aprobaciones y cuentas. Vale para todos los módulos del sistema.
            </p>
          </div>
        </div>
        <UsuariosTab />
      </div>

      {/* ═══ SECCIÓN 2 · ACTIVIDAD POR MÓDULO ═══ */}
      <div className="rounded-xl border bg-white p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-extrabold text-slate-900">Actividad por módulo</h3>
            <p className="text-xs text-slate-500">
              Movimientos de cada usuario dentro de Racks, Piso, Recepción y Atención.
            </p>
          </div>
        </div>

        {/* Filtros */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 mb-4">
          <Select value={modulo} onValueChange={(v) => setModulo(v as ModuloActividad)}>
            <SelectTrigger>
              <SelectValue placeholder="Módulo" />
            </SelectTrigger>
            <SelectContent>
              {MODULOS.map((m) => (
                <SelectItem key={m} value={m}>
                  {ETIQUETA_MODULO[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={usuarioId} onValueChange={setUsuarioId}>
            <SelectTrigger>
              <SelectValue placeholder="Usuario" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos los usuarios</SelectItem>
              {perfiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              className="pl-9"
              placeholder="Filtrar por nombre/correo…"
              value={busquedaUsuario}
              onChange={(e) => setBusquedaUsuario(e.target.value)}
              disabled={usuarioId !== 'todos'}
            />
          </div>

          <Button
            variant="outline"
            onClick={() => cargarActividad(0, true)}
            disabled={loading}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualizar
          </Button>
        </div>

        {/* Resumen */}
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-slate-500">
          <Badge variant="outline" className="font-semibold">
            Módulo: {ETIQUETA_MODULO[modulo]}
          </Badge>
          <Badge variant="outline" className="font-semibold">
            Usuario: {usuarioSeleccionado ? usuarioSeleccionado.nombre : 'Todos'}
          </Badge>
          <Badge variant="outline" className="font-semibold">
            {filasVisibles.length} de {total} registros
          </Badge>
        </div>

        {/* Tabla desktop */}
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-white">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">Fecha</TableHead>
                <TableHead className="w-[120px]">Tipo</TableHead>
                <TableHead className="min-w-[160px]">Detalle</TableHead>
                <TableHead className="min-w-[170px]">Referencia</TableHead>
                <TableHead className="w-[110px] text-right">Cant.</TableHead>
                <TableHead className="w-[100px]">Estado</TableHead>
                <TableHead className="min-w-[140px]">Usuario</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filasVisibles.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-slate-400 py-10">
                    <History className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                    Sin actividad para los filtros seleccionados.
                  </TableCell>
                </TableRow>
              )}
              {filasVisibles.map((f) => (
                <TableRow key={`${f.id}`}>
                  <TableCell className="text-xs text-slate-500">{fmtFecha(f.fecha)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`${TIPO_CLASE[f.tipo] ?? ''} text-[10px]`}>
                      {f.tipo}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm truncate max-w-[220px]" title={f.titulo}>
                    {f.titulo || '—'}
                  </TableCell>
                  <TableCell className="text-xs text-slate-500 truncate max-w-[220px]" title={f.detalle}>
                    {f.detalle || '—'}
                  </TableCell>
                  <TableCell className="text-right text-sm font-semibold">
                    {f.cantidad !== null ? f.cantidad : '—'}
                  </TableCell>
                  <TableCell>
                    {f.estado ? (
                      <Badge variant="outline" className={`${ESTADO_CLASE[f.estado] ?? ''} text-[10px]`}>
                        {f.estado}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <p className="text-xs font-medium truncate max-w-[140px]" title={f.usuarioNombre}>
                      {f.usuarioNombre || '—'}
                    </p>
                    <p className="text-[10px] text-slate-400 truncate max-w-[140px]">
                      {f.usuarioCorreo}
                    </p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Tarjetas móvil */}
        <div className="md:hidden space-y-3">
          {filasVisibles.length === 0 && !loading && (
            <p className="text-sm text-slate-400 text-center py-8">Sin actividad para los filtros.</p>
          )}
          {filasVisibles.map((f) => (
            <div key={`${f.id}`} className="rounded-lg border bg-white p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold truncate">{f.titulo || '(sin detalle)'}</p>
                <Badge variant="outline" className={`${TIPO_CLASE[f.tipo] ?? ''} text-[10px] shrink-0`}>
                  {f.tipo}
                </Badge>
              </div>
              {f.detalle && <p className="text-xs text-slate-500 truncate">{f.detalle}</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span>{fmtFecha(f.fecha)}</span>
                {f.cantidad !== null && <span>Cant.: {f.cantidad}</span>}
                {f.estado && (
                  <Badge variant="outline" className={`${ESTADO_CLASE[f.estado] ?? ''} text-[10px]`}>
                    {f.estado}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                {f.usuarioNombre || f.usuarioCorreo || '—'}
              </p>
            </div>
          ))}
        </div>

        {/* Paginación */}
        {filasVisibles.length < total && (
          <div className="flex justify-center mt-4">
            <Button
              variant="outline"
              onClick={() => cargarActividad(offset + PAGE_SIZE, false)}
              disabled={loading}
              className="gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Cargar más ({filasVisibles.length} de {total})
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
