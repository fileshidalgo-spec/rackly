'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  addMovimiento,
  stockEnUbicacion,
  type Movimiento,
  type TipoMovimiento,
  type StockEnUbicacion,
  type Turno,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, PROVEEDORES_FILM } from '@/lib/rackly/constants'
import { torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'
import { useAuth } from '@/hooks/useAuth'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import {
  requiereProveedor,
  formatDate,
  isExpired,
  isExpiringSoon,
  extractError,
  impactoStock,
} from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, PackageSearch, ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft, TriangleAlert, MapPin, Package, X } from 'lucide-react'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

type Props = {
  tipo: TipoMovimiento
  onCreated: (movs: Movimiento[]) => void
}

export function MovimientoForm({ tipo, onCreated }: Props) {
  const { perfil } = useAuth()
  const [turno, setTurno] = useState<Turno>(calcularTurno())

  useEffect(() => {
    const interval = setInterval(() => setTurno(calcularTurno()), 60000)
    return () => clearInterval(interval)
  }, [])

  if (tipo === 'salida') {
    return <SalidaForm turno={turno} onCreated={onCreated} perfil={perfil!} />
  }
  // ingreso y devolucion usan el mismo formulario, solo cambia el tipo
  return <IngresoForm turno={turno} onCreated={onCreated} perfil={perfil!} tipo={tipo} />
}

/* ═══════════════════════════════════════════
   INGRESO FORM
   ═══════════════════════════════════════════ */
function IngresoForm({
  turno,
  onCreated,
  perfil,
  tipo = 'ingreso',
}: {
  turno: Turno
  onCreated: (movs: Movimiento[]) => void
  perfil: { id: string; nombre: string; correo: string }
  tipo?: TipoMovimiento
}) {
  const [bloque, setBloque] = useState('')
  const [torre, setTorre] = useState('')
  const [piso, setPiso] = useState('')
  const [posicion, setPosicion] = useState('')
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [fVencimiento, setFVencimiento] = useState('')
  const [sinVencimiento, setSinVencimiento] = useState(false)
  const [proveedor, setProveedor] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmData, setConfirmData] = useState<StockEnUbicacion[] | null>(null)
  const [salidaBusy, setSalidaBusy] = useState<string | null>(null)

  const torres = torresDeBloque(bloque)
  const posiciones = posicionesDeBloque(bloque)

  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!bloque || !torre || !piso || !posicion || !codigo.trim() || !cantidad) {
      toast.error('Completa todos los campos requeridos')
      return
    }
    if (requiereProveedor(descripcion) && !proveedor) {
      toast.error('Selecciona un proveedor para este producto')
      return
    }
    const qty = parseFloat(cantidad)
    if (isNaN(qty) || qty <= 0) {
      toast.error('La cantidad debe ser mayor a 0')
      return
    }
    setBusy(true)
    try {
      // Verificar si CUALQUIER producto existe en esta posición
      const details = await stockEnUbicacion(bloque, torre, piso, posicion)
      if (details.length > 0) {
        setConfirmData(details)
        setBusy(false)
        return
      }
      await doInsert(qty)
    } catch (err: unknown) {
      const message = extractError(err)
      toast.error('Error al verificar stock', { description: message })
      setBusy(false)
    }
  }

  async function doInsert(qty: number) {
    try {
      const movs = await addMovimiento({
        tipo,
        bloque,
        torre,
        piso,
        posicion,
        codigo,
        descripcion,
        un,
        cantidad: qty,
        fVencimiento: sinVencimiento ? '' : fVencimiento,
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: proveedor || undefined,
      })
      toast.success(tipo === 'devolucion' ? 'Devolución registrada' : 'Ingreso registrado')
      setCodigo('')
      setDescripcion('')
      setUn('')
      setCantidad('')
      setFVencimiento('')
      setProveedor('')
      onCreated(movs)
    } catch (err: unknown) {
      const message = extractError(err)
      toast.error('Error al registrar ingreso', { description: message })
    } finally {
      setBusy(false)
      setConfirmData(null)
    }
  }

  // Dar salida a un producto desde el alerta de ubicación ocupada
  async function handleSalidaDesdeAlerta(stockItem: StockEnUbicacion) {
    setSalidaBusy(stockItem.codigo)
    try {
      const movs = await addMovimiento({
        tipo: 'salida',
        bloque,
        torre,
        piso,
        posicion,
        codigo: stockItem.codigo,
        descripcion: stockItem.descripcion,
        un: stockItem.un,
        cantidad: stockItem.stock,
        fVencimiento: stockItem.fVencimiento ?? '',
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: stockItem.proveedor,
      })
      toast.success(`Salida de ${stockItem.stock} ${stockItem.un} de ${stockItem.codigo}`)
      onCreated(movs)
      // Refrescar datos del alerta
      const updated = await stockEnUbicacion(bloque, torre, piso, posicion)
      if (updated.length > 0) {
        setConfirmData(updated)
      } else {
        setConfirmData(null)
        // Ya no hay productos, hacer el ingreso directamente
        await doInsert(parseFloat(cantidad))
      }
    } catch (err: unknown) {
      const message = extractError(err)
      toast.error('Error al dar salida', { description: message })
    } finally {
      setSalidaBusy(null)
    }
  }

  return (
    <>
      <div className={`flex items-center gap-2 mb-4 p-3 rounded-lg border ${
        tipo === 'devolucion'
          ? 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-800'
          : 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800'
      }`}>
        {tipo === 'devolucion' ? (
          <ArrowRightLeft className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
        ) : (
          <ArrowDownToLine className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
        )}
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${
            tipo === 'devolucion'
              ? 'text-orange-700 dark:text-orange-300'
              : 'text-green-700 dark:text-green-300'
          }`}>
            {tipo === 'devolucion' ? 'Ingreso por devolución' : 'Ingreso de mercadería'}
          </p>
          <p className="text-xs text-muted-foreground">Turno: {turno}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ubicación</Label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Bloque</Label>
              <Select value={bloque} onValueChange={(v) => { setBloque(v); setTorre(''); setPiso(''); setPosicion('') }}>
                <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>
                  {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Torre</Label>
              <Select value={torre} onValueChange={setTorre} disabled={!bloque}>
                <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>
                  {torres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Piso</Label>
              <Select value={piso} onValueChange={setPiso} disabled={!bloque}>
                <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Piso" /></SelectTrigger>
                <SelectContent>
                  {PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Posición</Label>
              <Select value={posicion} onValueChange={setPosicion} disabled={!bloque}>
                <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Pos." /></SelectTrigger>
                <SelectContent>
                  {posiciones.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <Label className="text-xs text-muted-foreground">Turno</Label>
              <Input value={turno} readOnly className="h-10 bg-muted text-sm" />
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Producto</Label>
          <CatalogoSearchInput
            onPick={handleCatalogoPick}
            value={codigo}
            onChange={(v) => {
              setCodigo(v)
              const cat = findCatalogoByCodigo(v)
              if (cat) {
                setDescripcion(cat.descripcion)
                setUn(cat.un)
              }
            }}
          />
        </div>

        {descripcion && (
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-2 transition-all">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Descripción</p>
                <p className="text-sm font-medium truncate">{descripcion}</p>
              </div>
              <div className="min-w-[60px]">
                <p className="text-xs text-muted-foreground">UN</p>
                <p className="text-sm font-medium">{un || '—'}</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">Cantidad</Label>
            <Input type="number" step="any" min="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} placeholder="0" className="h-10" />
          </div>
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs text-muted-foreground">F. Vencimiento</Label>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fVencimiento} onChange={(e) => setFVencimiento(e.target.value)} disabled={sinVencimiento} className="h-10" />
              <Checkbox checked={sinVencimiento} onCheckedChange={(v) => setSinVencimiento(!!v)} />
            </div>
          </div>
          {requiereProveedor(descripcion) && (
            <div className="space-y-1 col-span-2">
              <Label className="text-xs text-muted-foreground font-medium">Proveedor <span className="text-red-500">*</span></Label>
              <Select value={proveedor} onValueChange={setProveedor}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Selecciona proveedor" />
                </SelectTrigger>
                <SelectContent>
                  {PROVEEDORES_FILM.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <Button type="submit" disabled={busy} className={`w-full h-11 text-white text-sm font-medium sm:w-auto ${
          tipo === 'devolucion'
            ? 'bg-orange-600 hover:bg-orange-700'
            : 'bg-green-600 hover:bg-green-700'
        }`}>
          {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          {tipo === 'devolucion' ? 'Registrar Devolución' : 'Registrar Ingreso'}
        </Button>
      </form>

      {/* ═══ DIÁLOGO DE CONFIRMACIÓN — Ubicación Ocupada ═══ */}
      <AlertDialog open={!!confirmData} onOpenChange={() => setConfirmData(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          {/* Header con gradiente */}
          <div className="bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 px-4 sm:px-6 py-5 text-white shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                <TriangleAlert className="h-6 w-6 text-white" />
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  Ubicación Ocupada
                </AlertDialogTitle>
                <AlertDialogDescription className="text-amber-100 text-sm mt-0.5">
                  Esta posición ya tiene stock registrado. Revisa el detalle.
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          {/* Contenido scrolleable */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {/* Ubicación destino */}
            <div className="px-4 sm:px-6 pt-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Ubicación destino</p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2.5">
                <MapPin className="h-4 w-4 text-orange-500 flex-shrink-0" />
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300">
                  Bloque {bloque} · Torre {torre} · Piso {piso} · Pos {posicion}
                </span>
              </div>
            </div>

            {/* Producto que se desea ingresar */}
            <div className="px-4 sm:px-6 pb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Producto a {tipo === 'devolucion' ? 'devolver' : 'ingresar'}</p>
              <div className="rounded-xl border-2 border-dashed border-green-300 dark:border-green-700 bg-green-50/60 dark:bg-green-950/20 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-sm text-green-800 dark:text-green-300">{codigo}</span>
                    <span className="text-[10px] text-green-700/60 dark:text-green-400/60 bg-green-100 dark:bg-green-900/40 px-1.5 py-0.5 rounded">{un || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <ArrowDownToLine className="h-3.5 w-3.5 text-green-600" />
                    <span className="font-bold text-green-700 dark:text-green-300">+{cantidad}</span>
                  </div>
                </div>
                {descripcion && (
                  <p className="text-xs text-green-700/70 dark:text-green-400/70 truncate">{descripcion}</p>
                )}
                {fVencimiento && !sinVencimiento && (
                  <p className="text-[10px] text-muted-foreground">Venc: {fVencimiento}</p>
                )}
              </div>
            </div>

            {/* Separador */}
            {confirmData && confirmData.length > 0 && (
              <div className="px-4 sm:px-6 pb-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Stock actual en esta ubicación</span>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                </div>
              </div>
            )}

            {/* Productos existentes en la ubicación */}
            {confirmData && confirmData.length > 0 && (
              <div className="px-4 sm:px-6 pb-4">
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-2">
                  {confirmData.length} producto{confirmData.length !== 1 ? 's' : ''} encontrado{confirmData.length !== 1 ? 's' : ''}
                </p>
                <div className="space-y-2">
                  {confirmData.map((s, i) => (
                    <div
                      key={`${s.codigo}-${i}`}
                      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Package className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-semibold text-sm text-slate-800 dark:text-slate-200">{s.codigo}</span>
                            <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{s.un}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{s.descripcion}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                            <span className="font-bold text-slate-700 dark:text-slate-300 text-sm">{s.stock} {s.un}</span>
                            {s.fVencimiento && <span>Venc: {s.fVencimiento}</span>}
                            {s.proveedor && <span>Prov: {s.proveedor}</span>}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSalidaDesdeAlerta(s)}
                          disabled={salidaBusy === s.codigo}
                          className="h-9 px-3 text-xs font-semibold border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 hover:border-red-300 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-300 dark:hover:border-red-700 flex-shrink-0 gap-1.5 self-center"
                        >
                          {salidaBusy === s.codigo ? (
                            <><Loader2 className="h-3 w-3 animate-spin" /> Procesando...</>
                          ) : (
                            <><ArrowUpFromLine className="h-3 w-3" /> Dar Salida</>
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  Presiona "Dar Salida" para retirar productos que ya no están físicamente en esta ubicación.
                </p>
              </div>
            )}
          </div>

          {/* Botones de acción */}
          <AlertDialogFooter className="px-4 sm:px-6 pb-6 pt-3 border-t border-slate-100 dark:border-slate-800 gap-2 sm:gap-2 shrink-0">
            <AlertDialogCancel className="flex-1 h-11 rounded-lg text-sm font-medium border-slate-300 dark:border-slate-600">
              Cancelar
            </AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doInsert(parseFloat(cantidad)) }}
              disabled={busy}
              className="flex-1 h-11 rounded-lg text-sm font-bold bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-md shadow-green-600/20 gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowDownToLine className="h-4 w-4" />
              )}
              {tipo === 'devolucion' ? 'Confirmar Devolución' : 'Confirmar Ingreso'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* ═══════════════════════════════════════════
   SALIDA FORM — Tabla con formato exacto de la imagen
   ═══════════════════════════════════════════ */
type LocWithKey = StockEnUbicacion & { bloque: string; torre: string; piso: string; posicion: string }

function SalidaForm({
  turno,
  onCreated,
  perfil,
}: {
  turno: Turno
  onCreated: (movs: Movimiento[]) => void
  perfil: { id: string; nombre: string; correo: string }
}) {
  const [searchCode, setSearchCode] = useState('')
  const [productoDesc, setProductoDesc] = useState('')
  const [productoUn, setProductoUn] = useState('')
  const [locations, setLocations] = useState<LocWithKey[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const searchCodeRef = useRef(searchCode)
  searchCodeRef.current = searchCode

  // ─── Selección múltiple ───
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [massConfirmOpen, setMassConfirmOpen] = useState(false)

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleSelectAll() {
    if (selected.size === locations.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(locations.map((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}`)))
    }
  }

  // Reset selección al cambiar búsqueda
  useEffect(() => {
    setSelected(new Set())
  }, [searchCode])

  // Reset selección y cantidades al refrescar ubicaciones
  useEffect(() => {
    setSelected(new Set())
    setQtyMap({})
  }, [locations])

  // ─── Salida en masa ───
  const [massBusy, setMassBusy] = useState(false)

  function openMassConfirm() {
    if (selected.size === 0) {
      toast.error('Selecciona al menos una ubicación')
      return
    }
    setMassConfirmOpen(true)
  }

  async function doMassSalida() {
    setMassBusy(true)
    let totalProcessed = 0
    let totalErrors = 0
    try {
      for (const key of selected) {
        const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === key)
        if (!loc) continue
        const qtyVal = qtyMap[key] || ''
        const qtyNum = qtyVal ? parseFloat(qtyVal) : loc.stock
        if (isNaN(qtyNum) || qtyNum <= 0) {
          totalErrors++
          continue
        }
        try {
          await addMovimiento({
            tipo: 'salida',
            bloque: loc.bloque, torre: loc.torre, piso: loc.piso, posicion: loc.posicion,
            codigo: loc.codigo, descripcion: loc.descripcion, un: loc.un,
            cantidad: Math.min(qtyNum, loc.stock),
            fVencimiento: loc.fVencimiento ?? '', turno,
            usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
            proveedor: loc.proveedor,
          })
          totalProcessed++
        } catch {
          totalErrors++
        }
      }
      if (totalErrors > 0) {
        toast.warning(`Salida completada con ${totalErrors} error${totalErrors > 1 ? 'es' : ''}`, {
          description: `${totalProcessed} de ${selected.size} ubicaciones procesadas correctamente`,
        })
      } else {
        toast.success(`Salida registrada en ${totalProcessed} ubicacion${totalProcessed > 1 ? 'es' : ''}`)
      }
      setMassConfirmOpen(false)
      setSelected(new Set())
      setQtyMap({})
      setSearchCode('')
      onCreated([])
    } catch (err: unknown) {
      const message = extractError(err)
      toast.error('Error en salida masiva', { description: message })
    } finally {
      setMassBusy(false)
    }
  }

  const allSelected = locations.length > 0 && selected.size === locations.length

  // Función central para refrescar las ubicaciones
  const refreshLocations = useCallback(async () => {
    const code = searchCodeRef.current.trim()
    if (!code) {
      setLocations([])
      setProductoDesc('')
      setProductoUn('')
      setQtyMap({})
      return
    }
    try {
      const { fetchMovimientos } = await import('@/lib/rackly/kardex')
      const movs = await fetchMovimientos()
      const upperCode = code.toUpperCase()
      const locMap = new Map<string, LocWithKey>()
      const relevant = movs.filter((m) => m.codigo === upperCode)
      let desc = ''
      let un = ''
      for (const m of relevant) {
        if (!desc && m.descripcion) desc = m.descripcion
        if (!un && m.un) un = m.un
        const key = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const current = locMap.get(key)
        if (current) {
          current.stock += impactoStock(m.tipo, m.cantidad)
        } else {
          locMap.set(key, {
            bloque: m.bloque,
            torre: m.torre,
            piso: m.piso,
            posicion: m.posicion,
            codigo: m.codigo,
            descripcion: m.descripcion,
            un: m.un,
            stock: impactoStock(m.tipo, m.cantidad),
            fVencimiento: m.fVencimiento || undefined,
            proveedor: m.proveedor,
          })
        }
      }
      const results = Array.from(locMap.values()).filter((l) => l.stock > 0)
      // Ordenar: vencimiento más próximo primero, sin fecha al final
      results.sort((a, b) => {
        if (a.fVencimiento && b.fVencimiento) return (a.fVencimiento || '').localeCompare(b.fVencimiento || '')
        if (a.fVencimiento) return -1
        if (b.fVencimiento) return 1
        return 0
      })
      setLocations(results)
      setProductoDesc(desc)
      setProductoUn(un)
    } catch {
      // silencioso
    }
  }, [])

  // Búsqueda inicial con debounce
  useEffect(() => {
    if (!searchCode.trim()) {
      setLocations([])
      setProductoDesc('')
      setProductoUn('')
      setQtyMap({})
      return
    }
    setLoading(true)
    const timer = setTimeout(async () => {
      await refreshLocations()
      setLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchCode, refreshLocations])

  // POLLING: refrescar automáticamente cada 8 segundos
  useEffect(() => {
    if (!searchCode.trim()) return
    const interval = setInterval(() => {
      refreshLocations()
    }, 8000)
    return () => clearInterval(interval)
  }, [searchCode, refreshLocations])

  async function handleSalidaParcial(locKey: string) {
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === locKey)
    if (!loc) return
    const qtyVal = qtyMap[locKey] || ''
    const qtyNum = parseFloat(qtyVal)
    if (isNaN(qtyNum) || qtyNum <= 0) {
      toast.error('Ingresa una cantidad válida para la salida parcial')
      return
    }
    if (qtyNum > loc.stock) {
      toast.error('La cantidad excede el stock disponible')
      return
    }
    setConfirmState({ loc, qtyNum, full: false })
  }

  function handleRetirarTodo(locKey: string) {
    const loc = locations.find((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === locKey)
    if (!loc) return
    setConfirmState({ loc, qtyNum: loc.stock, full: true })
  }

  const [confirmState, setConfirmState] = useState<{
    loc: LocWithKey
    qtyNum: number
    full: boolean
  } | null>(null)

  async function doSalida() {
    if (!confirmState) return
    const { loc, qtyNum } = confirmState
    setBusy(true)
    try {
      const result = await addMovimiento({
        tipo: 'salida',
        bloque: loc.bloque,
        torre: loc.torre,
        piso: loc.piso,
        posicion: loc.posicion,
        codigo: loc.codigo,
        descripcion: loc.descripcion,
        un: loc.un,
        cantidad: qtyNum,
        fVencimiento: loc.fVencimiento ?? '',
        turno,
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: loc.proveedor,
      })
      toast.success(`Salida de ${qtyNum} ${loc.un} registrada`)
      setConfirmState(null)
      setSearchCode('')
      setQtyMap({})
      onCreated(result)
    } catch (err: unknown) {
      const message = extractError(err)
      toast.error('Error al registrar salida', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Búsqueda */}
      <div className="space-y-1">
        <Label className="text-sm text-muted-foreground">Buscar (código o descripción)</Label>
        <CatalogoSearchInput
          onPick={(item) => setSearchCode(item.codigo)}
          value={searchCode}
          onChange={setSearchCode}
        />
      </div>

      {/* Producto (solo lectura) */}
      {productoDesc && (
        <div className="space-y-1">
          <Label className="text-sm text-muted-foreground">Producto</Label>
          <Input
            value={`${productoUn ? productoUn + ' — ' : ''}${productoDesc}`}
            readOnly
            className="h-10 bg-muted/50 cursor-default"
          />
        </div>
      )}

      {/* Badges de metadata */}
      {searchCode.trim() && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
            Turno: {turno}
          </Badge>
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
            Usuario: {perfil.nombre}
          </Badge>
          {!loading && (
            <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800">
              Ubicaciones con stock: <span className="font-bold">{locations.length}</span>
            </Badge>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Buscando...</span>
        </div>
      )}

      {/* Barra de selección masiva */}
      {locations.length > 0 && !loading && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant={allSelected ? 'default' : 'outline'}
            onClick={toggleSelectAll}
            className="h-9 text-xs gap-1.5"
          >
            <Checkbox checked={allSelected || (selected.size > 0 && selected.size < locations.length) ? 'indeterminate' : allSelected} className="h-3.5 w-3.5 pointer-events-none" />
            {allSelected ? 'Deseleccionar todas' : 'Seleccionar todas'}
          </Button>
          {selected.size > 0 && (
            <>
              <Badge variant="secondary" className="text-xs font-medium">
                {selected.size} de {locations.length} seleccionada{selected.size > 1 ? 's' : ''}
              </Badge>
              <Button
                size="sm"
                onClick={openMassConfirm}
                disabled={busy || massBusy}
                className="h-9 text-xs gap-1.5 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-semibold ml-auto"
              >
                <ArrowUpFromLine className="h-3.5 w-3.5" />
                Salida masiva ({selected.size})
              </Button>
            </>
          )}
        </div>
      )}

      {/* Lista de ubicaciones — Tarjetas en móvil, tabla en desktop */}
      {locations.length > 0 && !loading && (
        <>
          {/* ───── Vista móvil: tarjetas ───── */}
          <div className="md:hidden space-y-3">
            {locations.map((loc) => {
              const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
              const isSelected = selected.has(key)
              return (
                <div
                  key={key}
                  onClick={() => toggleSelect(key)}
                  className={`rounded-lg border p-3 space-y-2 shadow-sm cursor-pointer transition-all ${
                    isSelected
                      ? 'border-red-400 bg-red-50 dark:bg-red-950/20 ring-2 ring-red-300 dark:ring-red-700'
                      : 'border bg-card'
                  }`}
                >
                  {/* Checkbox + Ubicación */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isSelected}
                      className="h-4 w-4 pointer-events-none"
                    />
                    <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5" />
                      <span>B{loc.bloque} / T{loc.torre} / P{loc.piso} / Pos {loc.posicion}</span>
                    </div>
                  </div>

                  {/* Stock */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Stock: {loc.stock} {loc.un}</span>
                  </div>

                  {/* Vencimiento */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Venc.:</span>
                    {loc.fVencimiento ? (
                      <span className={`text-sm font-medium ${isExpired(loc.fVencimiento) ? 'text-red-600 dark:text-red-400 font-semibold' : isExpiringSoon(loc.fVencimiento) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                        {formatDate(loc.fVencimiento)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Proveedor */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Prov.:</span>
                    {loc.proveedor ? (
                      <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                        {loc.proveedor}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Cantidad + Acciones */}
                  <div className="flex gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="number"
                      step="any"
                      min="0.001"
                      max={loc.stock}
                      value={qtyMap[key] || ''}
                      onChange={(e) => setQtyMap((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="Parcial"
                      className="h-9 text-sm flex-1"
                    />
                    <Button
                      size="sm"
                      onClick={() => handleSalidaParcial(key)}
                      disabled={busy || massBusy}
                      className="h-9 text-xs bg-red-600 hover:bg-red-700 text-white"
                    >
                      Salida
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRetirarTodo(key)}
                      disabled={busy || massBusy}
                      className="h-9 text-xs"
                    >
                      Todo
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ───── Vista desktop: tabla ───── */}
          <div className="hidden md:block overflow-x-auto">
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <Checkbox
                      checked={allSelected || (selected.size > 0 && selected.size < locations.length) ? 'indeterminate' : allSelected}
                      onCheckedChange={toggleSelectAll}
                      className="h-4 w-4 mx-auto"
                    />
                  </TableHead>
                  <TableHead className="w-16 text-center">Bloque</TableHead>
                  <TableHead className="w-16 text-center">Torre</TableHead>
                  <TableHead className="w-16 text-center">Piso</TableHead>
                  <TableHead className="w-20 text-center">Posición</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>F. Vencimiento</TableHead>
                  <TableHead>Proveedor</TableHead>
                  <TableHead className="min-w-[140px]">Cant. salida</TableHead>
                  <TableHead className="min-w-[180px]">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((loc) => {
                  const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
                  const isSelected = selected.has(key)
                  return (
                    <TableRow
                      key={key}
                      onClick={() => toggleSelect(key)}
                      className={`cursor-pointer transition-colors ${isSelected ? 'bg-red-50 dark:bg-red-950/20' : ''}`}
                    >
                      <TableCell className="text-center">
                        <Checkbox checked={isSelected} className="h-4 w-4 mx-auto pointer-events-none" />
                      </TableCell>
                      <TableCell className="text-center font-medium">{loc.bloque}</TableCell>
                      <TableCell className="text-center font-medium">{loc.torre}</TableCell>
                      <TableCell className="text-center font-medium">{loc.piso}</TableCell>
                      <TableCell className="text-center font-medium">{loc.posicion}</TableCell>
                      <TableCell className="text-right font-bold">{loc.stock}</TableCell>
                      <TableCell>
                        {loc.fVencimiento ? (
                          <span className={`text-sm font-medium ${isExpired(loc.fVencimiento) ? 'text-red-600 dark:text-red-400 font-semibold' : isExpiringSoon(loc.fVencimiento) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{formatDate(loc.fVencimiento)}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {loc.proveedor ? (
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                            {loc.proveedor}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Input
                          type="number"
                          step="any"
                          min="0.001"
                          max={loc.stock}
                          value={qtyMap[key] || ''}
                          onChange={(e) => setQtyMap((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="Parcial"
                          className="h-9 text-sm"
                        />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleSalidaParcial(key)}
                            disabled={busy || massBusy}
                            className="flex-1 h-9 text-xs bg-red-600 hover:bg-red-700 text-white"
                          >
                            Salida
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRetirarTodo(key)}
                            disabled={busy || massBusy}
                            className="flex-1 h-9 text-xs"
                          >
                            Todo
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Sin stock */}
      {!loading && locations.length === 0 && searchCode.trim() && (
        <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
          <PackageSearch className="h-5 w-5" />
          <span className="text-sm">Sin stock para este código</span>
        </div>
      )}

      {/* Nota inferior */}
      {locations.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Las ubicaciones que lleguen a stock 0 desaparecen automáticamente de esta lista.
        </p>
      )}

      {/* Diálogo de confirmación Sí/No */}
      <AlertDialog open={!!confirmState} onOpenChange={(open) => { if (!open) setConfirmState(null) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-md max-h-[85vh] flex flex-col overflow-hidden">
          <AlertDialogHeader className="shrink-0">
            <AlertDialogTitle>
              {confirmState?.full ? 'Retirar todo el stock' : 'Confirmar salida'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 flex-1 min-h-0 overflow-y-auto overscroll-contain">
                <p>¿Estás seguro de registrar esta salida?</p>
                {confirmState && (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Producto:</span>
                      <span className="font-medium">{confirmState.loc.codigo} — {confirmState.loc.descripcion}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ubicación:</span>
                      <span className="font-medium">
                        B-{confirmState.loc.bloque} T-{confirmState.loc.torre} P-{confirmState.loc.piso} Pos-{confirmState.loc.posicion}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Stock actual:</span>
                      <span className="font-medium">{confirmState.loc.stock} {confirmState.loc.un}</span>
                    </div>
                    <div className="border-t pt-1.5 flex justify-between font-bold">
                      <span className="text-red-600">Cantidad a retirar:</span>
                      <span className="text-red-600">{confirmState.qtyNum} {confirmState.loc.un}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Stock después:</span>
                      <span className={`font-medium ${confirmState.loc.stock - confirmState.qtyNum === 0 ? 'text-red-600' : ''}`}>
                        {confirmState.loc.stock - confirmState.qtyNum} {confirmState.loc.un}
                      </span>
                    </div>
                    {confirmState.loc.fVencimiento && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">F. Vencimiento:</span>
                        <span className={`font-medium ${isExpired(confirmState.loc.fVencimiento) ? 'text-red-600' : isExpiringSoon(confirmState.loc.fVencimiento) ? 'text-amber-600' : ''}`}>
                          {formatDate(confirmState.loc.fVencimiento)}
                        </span>
                      </div>
                    )}
                    {confirmState.loc.proveedor && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Proveedor:</span>
                        <span className="font-medium">{confirmState.loc.proveedor}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="shrink-0">
            <AlertDialogCancel>No, cancelar</AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doSalida() }}
              disabled={busy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {busy ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Procesando...</>
              ) : (
                'Sí, confirmar'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ═══ DIÁLOGO DE CONFIRMACIÓN — Salida Masiva ═══ */}
      <AlertDialog open={massConfirmOpen} onOpenChange={(open) => { if (!open) setMassConfirmOpen(false) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          {/* Header con gradiente rojo */}
          <div className="bg-gradient-to-r from-red-600 to-red-700 px-4 sm:px-6 py-5 text-white shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                <ArrowUpFromLine className="h-6 w-6 text-white" />
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  Confirmar Salida Masiva
                </AlertDialogTitle>
                <AlertDialogDescription className="text-red-100 text-sm mt-0.5">
                  Se registrará salida en {selected.size} ubicacion{selected.size > 1 ? 'es' : ''}
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          {/* Contenido scrolleable con resumen */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {/* Info del producto */}
            <div className="px-4 sm:px-6 pt-4 pb-2">
              <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Código:</span>
                  <span className="font-mono font-bold">{searchCode}</span>
                </div>
                {productoDesc && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Descripción:</span>
                    <span className="font-medium truncate max-w-[200px]">{productoDesc}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Turno:</span>
                  <span className="font-medium">{turno}</span>
                </div>
              </div>
            </div>

            {/* Separador */}
            <div className="px-4 sm:px-6 py-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Ubicaciones seleccionadas</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
              </div>
            </div>

            {/* Lista de ubicaciones */}
            <div className="px-4 sm:px-6 pb-4 space-y-2">
              {locations.filter((l) => selected.has(`${l.bloque}-${l.torre}-${l.piso}-${l.posicion}`)).map((loc) => {
                const key = `${loc.bloque}-${loc.torre}-${loc.piso}-${loc.posicion}`
                const qtyVal = qtyMap[key] || ''
                const qtyNum = qtyVal ? parseFloat(qtyVal) : loc.stock
                return (
                  <div key={key} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <MapPin className="h-4 w-4 text-red-600 dark:text-red-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                          B-{loc.bloque} / T-{loc.torre} / P-{loc.piso} / Pos {loc.posicion}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
                          <span>Stock: <b className="text-slate-700 dark:text-slate-300">{loc.stock} {loc.un}</b></span>
                          <span className="text-red-600 font-semibold">→ Retirar: {isNaN(qtyNum) ? loc.stock : Math.min(qtyNum, loc.stock)} {loc.un}</span>
                          {loc.fVencimiento && <span>Venc: {loc.fVencimiento}</span>}
                          {loc.proveedor && <span>Prov: {loc.proveedor}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Botones */}
          <AlertDialogFooter className="px-4 sm:px-6 pb-6 pt-3 border-t border-slate-100 dark:border-slate-800 gap-2 shrink-0">
            <AlertDialogCancel className="flex-1 h-11 rounded-lg text-sm font-medium" disabled={massBusy}>
              Cancelar
            </AlertDialogCancel>
            <Button
              onClick={(e) => { e.preventDefault(); doMassSalida() }}
              disabled={massBusy}
              className="flex-1 h-11 rounded-lg text-sm font-bold bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white shadow-md shadow-red-600/20 gap-2"
            >
              {massBusy ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Procesando...</>
              ) : (
                <>
                  <ArrowUpFromLine className="h-4 w-4" />
                  Confirmar Salida ({selected.size})
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
