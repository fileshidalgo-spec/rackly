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
import { fetchCatalogo } from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'
import { GuiaFotoForm } from '@/components/rackly/recepcion/GuiaFotoForm'
import {
  RecepcionItemsEditor,
  itemVacio,
  itemsValidos,
  type ItemRecepcion,
} from '@/components/rackly/recepcion/RecepcionItemsEditor'
import {
  ImprimirRotulosDialog,
  rotulosDesdeItems,
  type RotuloAImprimir,
} from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'
import {
  listarRecepciones,
  crearRecepciones,
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
  Camera,
  PencilLine,
  ExternalLink,
  Printer,
} from 'lucide-react'

const PAGE_SIZE = 50

/** Las 2 vías de registro del módulo (independientes entre sí). */
type ModoRegistro = 'foto' | 'manual'

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
  // Vía de registro activa: foto de guía (OCR) o formulario manual.
  const [modo, setModo] = useState<ModoRegistro>('foto')
  // Modal de impresión de rótulos (Zebra ZT411). Se abre SOLO tras REGISTRAR
  // (la carga ya validada y guardada en la BD): automáticamente al guardar
  // (instantánea `guardados`) o con el botón de reimpresión de una fila ya
  // registrada en la lista. Nunca con datos sin registrar.
  const [rotulosOpen, setRotulosOpen] = useState(false)
  const [guardados, setGuardados] = useState<{
    rotulos: RotuloAImprimir[]
    encabezado: EncabezadoRotulo
    nota?: string
  } | null>(null)

  /** Cierra el modal y libera la instantánea post-guardado. */
  function cerrarRotulos(open: boolean) {
    setRotulosOpen(open)
    if (!open) setGuardados(null)
  }

  /**
   * Reimpresión de rótulos de UNA fila ya REGISTRADA en la lista. Solo
   * opera sobre datos guardados en la BD (la carga ya fue validada al
   * registrarse); cumple la regla de negocio: imprimir solo lo registrado.
   */
  function reimprimirFila(r: RegistroRecepcion) {
    setGuardados({
      rotulos: [
        {
          codigo: r.codigo.trim(),
          descripcion: r.descripcion.trim(),
          cantidad: String(r.cantidad),
          unidad: r.unidadMedida.trim(),
          lote: r.lote.trim(),
          fechaProduccion: r.fechaProduccion,
          fechaVencimiento: r.fechaVencimiento,
          copias: 1,
        },
      ],
      encabezado: {
        fecha: r.fecha,
        numeroDocumento: r.numeroDocumento,
        proveedor: r.proveedor,
        placa: r.placa,
        registradoPor: r.usuarioNombre,
      },
      nota: `Reimpresión del artículo ${r.codigo.trim()} (registrado en la BD${r.numeroDocumento ? `, ${r.tipoDocumento} ${r.numeroDocumento}` : ''}). Digita cuántas etiquetas necesitas e imprime.`,
    })
    setRotulosOpen(true)
  }

  // Formulario manual: encabezado del documento + lista de artículos.
  // Una guía puede traer 20+ artículos; cada artículo = 1 fila en BD.
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fDoc, setFDoc] = useState('Guia')
  const [fNumero, setFNumero] = useState('')
  const [fProveedor, setFProveedor] = useState('')
  const [fPlaca, setFPlaca] = useState('')
  const [fObs, setFObs] = useState('')
  const [items, setItems] = useState<ItemRecepcion[]>([itemVacio()])

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

  // Catálogo en cache para el auto-llenado de descripción/unidad al
  // escribir el código (en el editor de artículos).
  useEffect(() => {
    void fetchCatalogo()
  }, [])

  function buscar() {
    cargar(0, true)
  }

  async function handleRegistrar() {
    const validos = itemsValidos(items)
    if (validos.length === 0) {
      toast.error('Agrega al menos un artículo con código y cantidad mayor a 0')
      return
    }
    if (!perfil) {
      toast.error('Sesión no disponible')
      return
    }
    setSaving(true)
    try {
      const fecha = fFecha || hoyISO()
      await crearRecepciones(
        validos.map((it) => ({
          fecha,
          tipoDocumento: fDoc,
          numeroDocumento: fNumero,
          proveedor: fProveedor,
          codigo: it.codigo,
          descripcion: it.descripcion,
          cantidad: aNumero(it.cantidad),
          unidadMedida: it.unidad,
          lote: it.lote,
          fechaProduccion: it.fechaProduccion,
          fechaVencimiento: it.fechaVencimiento,
          placa: fPlaca,
          observaciones: fObs,
        })),
        { id: perfil.id, nombre: perfil.nombre, correo: perfil.correo }
      )
      toast.success(`Recepción registrada: ${validos.length} artículo(s)`)
      // Instantánea de EXACTAMENTE lo guardado en la BD → el modal de rótulos
      // se abre solo, listo para digitar las etiquetas por artículo. La
      // impresión solo existe DESPUÉS de registrar (carga ya validada).
      // Si lo guardado no trae ningún código no hay rótulos que imprimir:
      // se avisa en vez de abrir un modal vacío.
      const rotulos = rotulosDesdeItems(validos)
      if (rotulos.length > 0) {
        setGuardados({
          rotulos,
          encabezado: {
            fecha,
            numeroDocumento: fNumero,
            proveedor: fProveedor,
            placa: fPlaca,
            registradoPor: perfil.nombre,
          },
          nota: `Recepción guardada: ${validos.length} artículo(s) en la base de datos. Digita cuántas etiquetas necesitas de cada uno e imprime todo de una vez.`,
        })
        setRotulosOpen(true)
      } else {
        toast.info('Recepción guardada sin rótulos', {
          description: 'Ningún artículo registrado tiene código; completa el código en la lista para poder imprimir etiquetas.',
        })
      }
      setFNumero('')
      setFProveedor('')
      setFPlaca('')
      setFObs('')
      setItems([itemVacio()])
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
      {/* ── Selector de las 2 vías de registro ── */}
      <div className="flex items-center gap-1 bg-white/70 border rounded-lg p-1 w-fit">
        <button
          onClick={() => setModo('foto')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            modo === 'foto'
              ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <Camera className="h-3.5 w-3.5" />
          Con foto de guía
        </button>
        <button
          onClick={() => setModo('manual')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            modo === 'manual'
              ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
          }`}
        >
          <PencilLine className="h-3.5 w-3.5" />
          Manual
        </button>
      </div>

      {/* ── Opción 1: registro con foto de la guía (OCR + catálogo) ── */}
      {modo === 'foto' && <GuiaFotoForm onRegistrado={() => cargar(0, true)} />}

      {/* ── Opción 2: formulario manual (encabezado + N artículos) ── */}
      {modo === 'manual' && (
      <div ref={formRef} className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-bold text-amber-900">Nueva recepción (manual)</h3>
          </div>
          <p className="text-[11px] text-slate-500">
            Escribe el código y se autocompletan descripción y unidad desde el catálogo.
          </p>
        </div>

        {/* Encabezado del documento (compartido por todos los artículos) */}
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
              placeholder="Ej: T005-0034403"
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
            <Label className="text-xs">Placa</Label>
            <Input
              placeholder="Placa del vehículo"
              value={fPlaca}
              onChange={(e) => setFPlaca(e.target.value.toUpperCase())}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Observaciones</Label>
            <Textarea
              rows={1}
              placeholder="Observaciones de la recepción (opcional)"
              value={fObs}
              onChange={(e) => setFObs(e.target.value)}
            />
          </div>
        </div>

        {/* Artículos de la guía (1, 20 o más) */}
        <RecepcionItemsEditor items={items} onChange={setItems} />

        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={handleRegistrar}
            disabled={saving}
            className="flex-1 gap-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-600 hover:to-orange-700"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Registrar {itemsValidos(items).length > 0 ? `${itemsValidos(items).length} artículo(s)` : 'recepción'}
          </Button>
          {/* La impresión de rótulos NO va aquí: solo se ofrece tras REGISTRAR
              (el modal se abre solo al guardar, o desde la lista de
              registrados), cuando la carga ya fue validada. */}
        </div>
      </div>
      )}

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
              <TableHead className="w-[60px] text-center">Foto</TableHead>
              <TableHead className="w-[140px]">Estado</TableHead>
              <TableHead className="min-w-[130px]">Registró</TableHead>
              <TableHead className="w-[60px] text-center" title="Reimprimir rótulo del artículo registrado">Rótulo</TableHead>
              {puedeEliminar && <TableHead className="w-[60px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={puedeEliminar ? 10 : 9} className="text-center text-sm text-slate-400 py-10">
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
                <TableCell className="text-right text-sm font-semibold">
                  {r.cantidad}
                  {r.unidadMedida ? (
                    <span className="block text-[10px] font-normal text-slate-400">{r.unidadMedida}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-center">
                  {r.fotoUrl ? (
                    <a
                      href={r.fotoUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Ver foto de la guía"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-slate-500 hover:bg-amber-50 hover:text-amber-600"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </TableCell>
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
                <TableCell className="text-center">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                    onClick={() => reimprimirFila(r)}
                    title="Reimprimir rótulo de este artículo ya registrado"
                  >
                    <Printer className="h-4 w-4" />
                  </Button>
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
              <span>Cant.: {r.cantidad}{r.unidadMedida ? ` ${r.unidadMedida}` : ''}</span>
              <span className="truncate">
                Doc: {r.tipoDocumento} {r.numeroDocumento || ''}
              </span>
              <span className="truncate">Por: {r.usuarioNombre || '—'}</span>
              {r.lote && <span>Lote: {r.lote}</span>}
              {r.placa && <span>Placa: {r.placa}</span>}
              {r.fotoUrl && (
                <a
                  href={r.fotoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-600 font-semibold underline"
                >
                  Ver foto de la guía
                </a>
              )}
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
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1 text-amber-700 hover:bg-amber-50"
              onClick={() => reimprimirFila(r)}
            >
              <Printer className="h-3 w-3" /> Imprimir rótulos
            </Button>
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

      {/* ── Impresión de rótulos (Zebra ZT411 por USB) — solo datos YA
          registrados: instantánea post-guardado o reimpresión de fila ── */}
      <ImprimirRotulosDialog
        open={rotulosOpen}
        onOpenChange={cerrarRotulos}
        rotulos={guardados ? guardados.rotulos : []}
        encabezado={
          guardados
            ? guardados.encabezado
            : { fecha: '', numeroDocumento: '', proveedor: '', placa: '', registradoPor: '' }
        }
        nota={guardados?.nota}
      />

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
