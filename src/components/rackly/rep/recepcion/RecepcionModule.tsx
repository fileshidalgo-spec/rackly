'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Recepción.
 *
 * Flujo: código → artículo → destino (ubicación + lonchera) → cantidad →
 * RPC atómica rep_registrar_ingreso (valida capacidad 15, artículo activo,
 * suma cantidad y escribe el kardex EN BD, en una sola transacción).
 *
 * Avisos honestos:
 *   · «El artículo ya vive en otra lonchera» (regla de lonchera única con
 *     excepción controlada: no bloquea, informa).
 *   · Código desconocido → alta rápida IN-LINE (si el usuario puede
 *     gestionar el catálogo) o puente al módulo Catálogo.
 *
 * Puentes (contrato rep-navegacion):
 *   · onIrACatalogo  → Catálogo (alta manual completa).
 *   · onVerEnMapa    → Ubicaciones con la posición enfocada (deep-link).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import {
  repArticuloPorCodigo,
  repRegistrarIngreso,
  repStockDeArticulo,
  repListarUbicaciones,
  repListarLoncheras,
  repContarArticulosLonchera,
  repListarMovimientos,
  repCrearArticulo,
  repNormalizarCodigo,
  type RepArticulo,
  type RepUbicacion,
  type RepMovimiento,
} from '@/lib/rackly/rep/rep-client'
import { REP_ETIQUETA_TIPO, REP_MAX_ARTICULOS_LONCHERA } from '@/lib/rackly/rep/rep-tipos'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  PackageCheck,
  Search,
  Loader2,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  BookOpen,
  Plus,
} from 'lucide-react'

type Props = {
  /** Puente: abrir Catálogo (alta manual completa). */
  onIrACatalogo?: () => void
  /** Puente: ver la ubicación en el mapa (deep-link con retorno). */
  onVerEnMapa?: (ubicacionId: string, codigo: string) => void
}

export function RecepcionModule({ onIrACatalogo, onVerEnMapa }: Props) {
  const { perfil } = useAuth()
  const puedeGestionar = puede(perfil, 'repuestos.gestionar')

  // ── Formulario ──
  const [codigo, setCodigo] = useState('')
  const [articulo, setArticulo] = useState<RepArticulo | null>(null)
  const [stockActual, setStockActual] = useState<Awaited<ReturnType<typeof repStockDeArticulo>>>([])
  const [cantidad, setCantidad] = useState('')
  const [referencia, setReferencia] = useState('')
  const [buscando, setBuscando] = useState(false)

  // ── Destino ──
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [loncheras, setLoncheras] = useState<Map<string, Array<{ id: string; lado: 'A' | 'B'; ubicacion_id: string }>>>(new Map())
  const [tipoFiltro, setTipoFiltro] = useState<'todos' | 'rack' | 'pasillo' | 'zona' | 'prepicking'>('rack')
  const [ubicacionId, setUbicacionId] = useState('')
  const [lado, setLado] = useState<'A' | 'B'>('A')
  const [ocupadasDestino, setOcupadasDestino] = useState<number | null>(null)

  // ── Últimos ingresos (contexto inmediato) ──
  const [ultimos, setUltimos] = useState<RepMovimiento[]>([])

  const [registrando, setRegistrando] = useState(false)
  const [altaOpen, setAltaOpen] = useState(false)
  const [ultimoIngreso, setUltimoIngreso] = useState<{ ubicacionId: string; codigo: string } | null>(null)
  const codigoRef = useRef<HTMLInputElement>(null)

  const cargarContexto = useCallback(async () => {
    try {
      const [ubs, lons, movs] = await Promise.all([
        repListarUbicaciones(),
        repListarLoncheras(),
        repListarMovimientos({ tipo: 'ingreso', page: 1, pageSize: 8 }),
      ])
      setUbicaciones(ubs)
      const porUbi = new Map<string, Array<{ id: string; lado: 'A' | 'B'; ubicacion_id: string }>>()
      for (const l of lons) {
        const arr = porUbi.get(l.ubicacion_id) ?? []
        arr.push({ id: l.id, lado: l.lado, ubicacion_id: l.ubicacion_id })
        porUbi.set(l.ubicacion_id, arr)
      }
      for (const arr of porUbi.values()) arr.sort((x, y) => x.lado.localeCompare(y.lado))
      setLoncheras(porUbi)
      setUltimos(movs.filas)
    } catch (err: unknown) {
      toast.error('Error al cargar ubicaciones', { description: mensajeError(err) })
    }
  }, [])

  useEffect(() => {
    cargarContexto()
  }, [cargarContexto])

  // Ocupación del destino seleccionado (capacidad 15 en vivo)
  useEffect(() => {
    const lons = loncheras.get(ubicacionId) ?? []
    const target = lons.find((l) => l.lado === lado) ?? lons[0]
    if (!target) {
      setOcupadasDestino(null)
      return
    }
    let vivo = true
    repContarArticulosLonchera(target.id)
      .then((n) => { if (vivo) setOcupadasDestino(n) })
      .catch(() => { if (vivo) setOcupadasDestino(null) })
    return () => { vivo = false }
  }, [ubicacionId, lado, loncheras])

  async function buscarArticulo(codigoInput?: string) {
    const c = repNormalizarCodigo(codigoInput ?? codigo)
    if (!c) return
    setBuscando(true)
    setArticulo(null)
    setStockActual([])
    setUltimoIngreso(null)
    try {
      const a = await repArticuloPorCodigo(c)
      if (a) {
        setArticulo(a)
        const st = await repStockDeArticulo(a.id)
        setStockActual(st)
      } else {
        toast.warning(`El código ${c} no existe en el catálogo`, {
          description: puedeGestionar
            ? 'Puedes crearlo aquí mismo con «Alta rápida».'
            : 'Pide a un supervisor que lo agregue en el módulo Catálogo.',
          duration: 8000,
        })
        if (puedeGestionar) setAltaOpen(true)
      }
    } catch (err: unknown) {
      toast.error('Error al buscar el artículo', { description: mensajeError(err) })
    } finally {
      setBuscando(false)
    }
  }

  async function registrar() {
    if (!articulo) return
    const cant = Number(cantidad.replace(',', '.'))
    if (!Number.isFinite(cant) || cant <= 0) {
      toast.error('La cantidad debe ser mayor que cero')
      return
    }
    const lonsDestino = loncheras.get(ubicacionId) ?? []
    const lonchera = lonsDestino.find((l) => l.lado === lado) ?? lonsDestino[0]
    if (!lonchera) {
      toast.error('Elige la ubicación de destino')
      return
    }
    if (ocupadasDestino !== null && ocupadasDestino >= REP_MAX_ARTICULOS_LONCHERA && !stockActual.some((s) => s.ubicacionId === ubicacionId && s.lado === lado)) {
      toast.error(`La lonchera ${lado} ya tiene ${REP_MAX_ARTICULOS_LONCHERA} artículos distintos`, {
        description: 'Elige otra lonchera o posición (la BD también lo valida).',
      })
      return
    }
    setRegistrando(true)
    try {
      const res = await repRegistrarIngreso({
        articuloId: articulo.id,
        loncheraId: lonchera.id,
        cantidad: cant,
        referencia: referencia.trim(),
      })
      if (res.enOtraLonchera) {
        toast.warning(`Ingreso registrado en ${res.ubicacion} lado ${res.lado}`, {
          description: `Ojo: este artículo ya vivía en ${res.enOtraLonchera.ubicacion} lado ${res.enOtraLonchera.lado} (excepción controlada).`,
          duration: 10000,
        })
      } else {
        toast.success(`Ingreso registrado en ${res.ubicacion} lado ${res.lado}`)
      }
      setUltimoIngreso({ ubicacionId: lonchera.ubicacion_id, codigo: articulo.codigo })
      // Refresca estado del artículo y últimos ingresos
      const st = await repStockDeArticulo(articulo.id)
      setStockActual(st)
      const movs = await repListarMovimientos({ tipo: 'ingreso', page: 1, pageSize: 8 })
      setUltimos(movs.filas)
      setCantidad('')
      setReferencia('')
      setArticulo(null)
      codigoRef.current?.focus()
    } catch (err: unknown) {
      toast.error('No se pudo registrar el ingreso', { description: mensajeError(err) })
    } finally {
      setRegistrando(false)
    }
  }

  const ubicacionesFiltradas = ubicaciones.filter((u) => (tipoFiltro === 'todos' ? true : u.tipo === tipoFiltro))
  const ladosDisponibles = loncheras.get(ubicacionId) ?? []

  return (
    <div className="space-y-4">
      {/* ═══ FORMULARIO DE INGRESO ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-4">
        {/* Paso 1: código */}
        <div>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">1 · Artículo</p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                ref={codigoRef}
                className="pl-9 font-mono uppercase"
                placeholder="Escanea o escribe el código BIG MAGIC…"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') buscarArticulo() }}
                autoFocus
              />
            </div>
            <Button onClick={() => buscarArticulo()} disabled={buscando || !codigo.trim()} className="gap-2">
              {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
          </div>

          {articulo && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="font-mono text-sm font-extrabold text-emerald-900">{articulo.codigo}</span>
                <span className="text-sm text-slate-700 flex-1 min-w-[160px]">{articulo.descripcion}</span>
                {articulo.und && <Badge variant="outline" className="text-[10px]">{articulo.und}</Badge>}
              </div>
              {stockActual.length > 0 && (
                <p className="text-xs text-slate-600">
                  <strong>Ya está en:</strong>{' '}
                  {stockActual
                    .map((s) => `${s.ubicacionCodigo} lado ${s.lado} (${s.cantidad.toLocaleString('es-PE')})`)
                    .join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Paso 2: destino */}
        <div>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">2 · Destino (lonchera)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Select value={tipoFiltro} onValueChange={(v) => { setTipoFiltro(v as typeof tipoFiltro); setUbicacionId('') }}>
              <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="rack">Racks</SelectItem>
                <SelectItem value="pasillo">Pasillos</SelectItem>
                <SelectItem value="zona">Zonas</SelectItem>
                <SelectItem value="prepicking">Pre-picking</SelectItem>
                <SelectItem value="todos">Todos</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ubicacionId} onValueChange={setUbicacionId}>
              <SelectTrigger><SelectValue placeholder="Ubicación" /></SelectTrigger>
              <SelectContent>
                {ubicacionesFiltradas.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-400">Sin ubicaciones de este tipo</div>
                )}
                {ubicacionesFiltradas.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <span className="font-mono">{u.codigo}</span>
                    <span className="text-slate-400 ml-1.5 text-xs">{REP_ETIQUETA_TIPO[u.tipo]} P{u.piso}·N{u.nivel}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ladosDisponibles.length > 1 ? (
              <Select value={lado} onValueChange={(v) => setLado(v as 'A' | 'B')}>
                <SelectTrigger><SelectValue placeholder="Lonchera" /></SelectTrigger>
                <SelectContent>
                  {ladosDisponibles.map((l) => (
                    <SelectItem key={l.lado} value={l.lado}>Lonchera {l.lado}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center rounded-md border px-3 text-sm text-slate-500 bg-slate-50">
                Lonchera {ladosDisponibles[0]?.lado ?? 'A'}
              </div>
            )}
          </div>
          {ubicacionId && (
            <p className={`text-xs mt-1.5 font-semibold ${ocupadasDestino !== null && ocupadasDestino >= REP_MAX_ARTICULOS_LONCHERA ? 'text-rose-600' : 'text-slate-500'}`}>
              Ocupación de la lonchera {lado}: {ocupadasDestino ?? '…'}/{REP_MAX_ARTICULOS_LONCHERA} artículos distintos
            </p>
          )}
        </div>

        {/* Paso 3: cantidad + referencia */}
        <div>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">3 · Cantidad</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              inputMode="decimal"
              placeholder="Cantidad"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') registrar() }}
            />
            <Input
              placeholder="Referencia (OC, guía… opcional)"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              className="sm:col-span-2"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          {ultimoIngreso && onVerEnMapa && (
            <Button variant="outline" onClick={() => onVerEnMapa(ultimoIngreso.ubicacionId, ultimoIngreso.codigo)} className="gap-2">
              <MapPin className="h-4 w-4" /> Ver en el mapa
            </Button>
          )}
          {!articulo && puedeGestionar && (
            <Button variant="outline" onClick={() => setAltaOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" /> Alta rápida
            </Button>
          )}
          {!articulo && onIrACatalogo && (
            <Button variant="ghost" onClick={onIrACatalogo} className="gap-2">
              <BookOpen className="h-4 w-4" /> Ir a Catálogo
            </Button>
          )}
          <Button onClick={registrar} disabled={!articulo || registrando} className="gap-2">
            {registrando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Registrar ingreso
          </Button>
        </div>
      </div>

      {/* ═══ ÚLTIMOS INGRESOS ═══ */}
      <div className="rounded-xl border bg-white p-4">
        <p className="text-sm font-extrabold text-slate-900 mb-2">Últimos ingresos</p>
        {ultimos.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">Aún no hay ingresos registrados.</p>
        ) : (
          <ul className="space-y-1">
            {ultimos.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-xs border-b border-slate-100 pb-1 last:border-0">
                <span className="font-mono font-bold text-slate-700 shrink-0">{m.codigo}</span>
                <span className="text-slate-500 truncate flex-1" title={m.descripcion}>{m.descripcion}</span>
                <span className="font-bold text-slate-900 shrink-0">{Number(m.cantidad).toLocaleString('es-PE')} {m.und}</span>
                <span className="text-slate-400 shrink-0 hidden sm:inline">{new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ═══ ALTA RÁPIDA (puente Recepción → Catálogo) ═══ */}
      <DialogoAltaRapida
        open={altaOpen}
        codigoInicial={repNormalizarCodigo(codigo)}
        onOpenChange={setAltaOpen}
        onCreada={(a) => {
          setCodigo(a.codigo)
          buscarArticulo(a.codigo)
        }}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   ALTA RÁPIDA DE ARTÍCULO DESCONOCIDO
   ═══════════════════════════════════════════════════════════════════ */

function DialogoAltaRapida({
  open,
  codigoInicial,
  onOpenChange,
  onCreada,
}: {
  open: boolean
  codigoInicial: string
  onOpenChange: (open: boolean) => void
  onCreada: (a: RepArticulo) => void
}) {
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [und, setUnd] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setCodigo(codigoInicial)
      setDescripcion('')
      setUnd('')
    }
  }, [open, codigoInicial])

  async function crear() {
    if (!codigo.trim() || !descripcion.trim()) {
      toast.error('Código y descripción son obligatorios')
      return
    }
    setBusy(true)
    try {
      const a = await repCrearArticulo({ codigo: codigo.trim(), descripcion: descripcion.trim(), und: und.trim() })
      toast.success(`Artículo ${a.codigo} creado`)
      onOpenChange(false)
      onCreada(a)
    } catch (err: unknown) {
      toast.error('No se pudo crear', { description: mensajeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Alta rápida de artículo
          </DialogTitle>
          <DialogDescription>
            Crea el artículo en el catálogo para poder recibirlo. El código es el de BIG MAGIC.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="qr-codigo">Código *</Label>
            <Input id="qr-codigo" className="font-mono uppercase" value={codigo} onChange={(e) => setCodigo(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qr-desc">Descripción *</Label>
            <Input id="qr-desc" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') crear() }} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qr-und">Und</Label>
            <Input id="qr-und" value={und} onChange={(e) => setUnd(e.target.value)} placeholder="UND / GLN / MTS" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={crear} disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Crear y continuar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
