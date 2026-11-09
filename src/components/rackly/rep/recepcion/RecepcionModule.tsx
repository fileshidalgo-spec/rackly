'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Recepción (con DOCUMENTO de guía).
 *
 * MODELO (2026-11-11): el ingreso viaja bajo una GUÍA con N° de Guía, N° de
 * OC, N° de DAM y Proveedor. Si toda la guía es de UN proveedor, este se
 * repite en cada artículo (modo único); si trae VARIOS, cada artículo lleva
 * el suyo (modo múltiple). Cada artículo = código + descripción + UM (jalados
 * del catálogo rep_articulos al escanear) + cantidad + destino (lonchera).
 *
 * GUARDAR: cada línea → RPC atómica rep_registrar_ingreso (capacidad 15,
 * upsert de cantidad, kardex con el documento) y el lote guardado abre el
 * modal «Imprimir rótulos» (Zebra directa o archivo .zpl — 1 rótulo por
 * artículo, QR único por rótulo con el uuid de SU movimiento). Las líneas
 * fallidas QUEDAN en la lista con su error: el guardado es secuencial y
 * honesto (nunca se celebra un lote parcial como éxito completo).
 *
 * REIMPRESIÓN: «Últimos ingresos» lista la guía de cada ingreso y permite
 * regenerar sus rótulos desde la BD (repListarMovimientos por guia exacta).
 *
 * Avisos honestos:
 *   · «El artículo ya vive en otra lonchera» (excepción controlada, no
 *     bloquea).
 *   · Código desconocido → alta rápida IN-LINE (si el usuario puede
 *     gestionar el catálogo) o puente al módulo Catálogo.
 *
 * Lección de la auditoría 2026-11-10 aplicada: el formulario se limpia
 * ANTES del refresco del contexto — un fallo de red en el refresco no
 * sugiere que el guardado falló ni provoca un segundo clic que duplique.
 *
 * Puentes (contrato rep-navegacion):
 *   · onIrACatalogo  → Catálogo (alta manual completa).
 *   · onVerEnMapa    → Ubicaciones con la posición enfocada (deep-link).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import { formatDateTime } from '@/lib/utils'
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
  type RepLonchera,
  type RepMovimiento,
} from '@/lib/rackly/rep/rep-client'
import {
  validarRecepcionRep,
  proveedorDeLinea,
  parsearCantidadLinea,
  lineasARotulosRep,
  movimientosARotulosRep,
  type CabeceraRecepcionRep,
  type LineaRecepcionRep,
} from '@/lib/rackly/rep/recepcion-guia'
import { REP_ETIQUETA_TIPO, REP_MAX_ARTICULOS_LONCHERA } from '@/lib/rackly/rep/rep-tipos'
import type { EncabezadoRotulo } from '@/lib/rackly/zebra'
import type { RotuloAImprimir } from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import { ImprimirRotulosDialog } from '@/components/rackly/recepcion/ImprimirRotulosDialog'
import { mensajeError } from '@/lib/rackly/errores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
  Printer,
  X,
  FileText,
} from 'lucide-react'

type Props = {
  /** Puente: abrir Catálogo (alta manual completa). */
  onIrACatalogo?: () => void
  /** Puente: ver la ubicación en el mapa (deep-link con retorno). */
  onVerEnMapa?: (ubicacionId: string, codigo: string) => void
}

/** Estado del modal de rótulos (guardado o reimpresión). */
type ModalRotulos = {
  rotulos: RotuloAImprimir[]
  encabezado: EncabezadoRotulo
  nota: string
} | null

/** clave local de línea (uuid; fallback por navegadores sin randomUUID). */
function claveLinea(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `l-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function RecepcionModule({ onIrACatalogo, onVerEnMapa }: Props) {
  const { perfil } = useAuth()
  const puedeGestionar = puede(perfil, 'repuestos.gestionar')

  // ── Contexto del almacén ──
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [loncheras, setLoncheras] = useState<RepLonchera[]>([])
  const [ultimos, setUltimos] = useState<RepMovimiento[]>([])

  // ── Cabecera de la guía ──
  const [guia, setGuia] = useState('')
  const [oc, setOc] = useState('')
  const [dam, setDam] = useState('')
  const [multiProveedor, setMultiProveedor] = useState(false)
  const [proveedorGeneral, setProveedorGeneral] = useState('')

  // ── Constructor de línea ──
  const [codigo, setCodigo] = useState('')
  const [articulo, setArticulo] = useState<RepArticulo | null>(null)
  const [stockActual, setStockActual] = useState<Awaited<ReturnType<typeof repStockDeArticulo>>>([])
  const [cantidad, setCantidad] = useState('')
  const [proveedorLinea, setProveedorLinea] = useState('')
  const [tipoFiltro, setTipoFiltro] = useState<'todos' | 'rack' | 'pasillo' | 'zona' | 'prepicking'>('rack')
  const [ubicacionId, setUbicacionId] = useState('')
  const [lado, setLado] = useState<'A' | 'B'>('A')
  const [ocupadasDestino, setOcupadasDestino] = useState<number | null>(null)

  // ── Líneas de la guía ──
  const [lineas, setLineas] = useState<LineaRecepcionRep[]>([])

  const [buscando, setBuscando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [altaOpen, setAltaOpen] = useState(false)
  const [modal, setModal] = useState<ModalRotulos>(null)
  const [imprimiendoGuia, setImprimiendoGuia] = useState('')
  const [ultimoIngreso, setUltimoIngreso] = useState<{ ubicacionId: string; codigo: string } | null>(null)
  const codigoRef = useRef<HTMLInputElement>(null)
  // Guard de generación: solo la búsqueda más reciente puede pintar resultados
  // (evita que la respuesta tardía de un código anterior sobrescriba al nuevo).
  const busquedaGenRef = useRef(0)

  const cabecera: CabeceraRecepcionRep = { guia, oc, dam, multiProveedor, proveedorGeneral }

  const cargarContexto = useCallback(async () => {
    try {
      const [ubs, lons, movs] = await Promise.all([
        repListarUbicaciones(),
        repListarLoncheras(),
        repListarMovimientos({ tipo: 'ingreso', page: 1, pageSize: 8 }),
      ])
      setUbicaciones(ubs)
      setLoncheras(lons)
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
    const lonchera = loncheraDestino()
    if (!lonchera) {
      setOcupadasDestino(null)
      return
    }
    let vivo = true
    repContarArticulosLonchera(lonchera.id)
      .then((n) => { if (vivo) setOcupadasDestino(n) })
      .catch(() => { if (vivo) setOcupadasDestino(null) })
    return () => { vivo = false }
  }, [ubicacionId, lado, loncheras])

  /** Lonchera destino resuelta (ubicación + lado; cae al primer lado disponible). */
  function loncheraDestino(): RepLonchera | null {
    const lons = loncheras.filter((l) => l.ubicacion_id === ubicacionId)
    if (lons.length === 0) return null
    return lons.find((l) => l.lado === lado) ?? lons[0]
  }

  async function buscarArticulo(codigoInput?: string) {
    const c = repNormalizarCodigo(codigoInput ?? codigo)
    if (!c) return
    const gen = ++busquedaGenRef.current
    setBuscando(true)
    setArticulo(null)
    setStockActual([])
    try {
      const a = await repArticuloPorCodigo(c)
      if (gen !== busquedaGenRef.current) return // llegó tarde: el usuario ya buscó otro código
      if (a) {
        setArticulo(a)
        const st = await repStockDeArticulo(a.id)
        if (gen !== busquedaGenRef.current) return
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
      if (gen === busquedaGenRef.current) setBuscando(false)
    }
  }

  /** Agrega el artículo buscado como línea de la guía (valida en el momento). */
  function agregarLinea() {
    if (!articulo) return
    const cant = parsearCantidadLinea(cantidad)
    if (cant === null) {
      toast.error('La cantidad debe ser mayor que cero')
      return
    }
    const lonchera = loncheraDestino()
    if (!lonchera) {
      toast.error('Elige la ubicación de destino')
      return
    }
    const ubi = ubicaciones.find((u) => u.id === lonchera.ubicacion_id)
    if (multiProveedor && !proveedorLinea.trim()) {
      toast.error('Ingresa el proveedor de este artículo')
      return
    }
    if (ocupadasDestino !== null && ocupadasDestino >= REP_MAX_ARTICULOS_LONCHERA && !stockActual.some((s) => s.loncheraId === lonchera.id)) {
      toast.error(`La lonchera ${lonchera.lado} ya tiene ${REP_MAX_ARTICULOS_LONCHERA} artículos distintos`, {
        description: 'Elige otra lonchera o posición (la BD también lo valida).',
      })
      return
    }
    setLineas((prev) => [
      ...prev,
      {
        key: claveLinea(),
        articuloId: articulo.id,
        codigo: articulo.codigo,
        descripcion: articulo.descripcion,
        und: articulo.und,
        cantidad: cant,
        proveedor: multiProveedor ? proveedorLinea.trim() : '',
        loncheraId: lonchera.id,
        destinoEtiqueta: `${ubi?.codigo ?? '?'} · lado ${lonchera.lado}`,
      },
    ])
    // La línea quedó lista: limpiar SOLO artículo/cantidad/proveedor de línea —
    // el destino queda fijo (recepciones consecutivas suelen ir al mismo rack).
    setCodigo('')
    setCantidad('')
    setProveedorLinea('')
    setArticulo(null)
    setStockActual([])
    codigoRef.current?.focus()
  }

  function quitarLinea(key: string) {
    setLineas((prev) => prev.filter((l) => l.key !== key))
  }

  function limpiarCabecera() {
    setGuia('')
    setOc('')
    setDam('')
    setMultiProveedor(false)
    setProveedorGeneral('')
  }

  /** Proveedores únicos de un conjunto de líneas (para la ficha del modal). */
  function etiquetaProveedores(vals: string[]): string {
    const unicos = [...new Set(vals.map((v) => v.trim()).filter(Boolean))]
    if (unicos.length === 0) return ''
    return unicos.length === 1 ? unicos[0] : `${unicos.length} proveedores`
  }

  /** Guarda TODAS las líneas bajo el documento de la guía (secuencial). */
  async function guardar() {
    const errores = validarRecepcionRep(cabecera, lineas)
    const total = errores.cabecera.length + errores.lineas.size
    if (total > 0) {
      toast.error(`Faltan datos de la guía (${total})`, {
        description: [...errores.cabecera, ...[...errores.lineas.values()]].slice(0, 4).join(' · '),
        duration: 10000,
      })
      return
    }
    setGuardando(true)
    const exitosas: Array<{ linea: LineaRecepcionRep; movimientoId: string; ubicacionId: string; ubicacionCodigo: string }> = []
    const fallos: Array<{ codigo: string; error: string }> = []
    let avisosOtraLonchera = 0

    // SECUENCIAL (no Promise.all): deterministic, reporte honesto por línea
    // y las RPC de la misma lonchera no compiten por el upsert de stock.
    for (const l of lineas) {
      try {
        const res = await repRegistrarIngreso({
          articuloId: l.articuloId,
          loncheraId: l.loncheraId,
          cantidad: l.cantidad,
          guia: cabecera.guia.trim(),
          oc: cabecera.oc.trim(),
          dam: cabecera.dam.trim(),
          proveedor: proveedorDeLinea(cabecera, l),
        })
        if (res.enOtraLonchera) avisosOtraLonchera++
        const lon = loncheras.find((x) => x.id === l.loncheraId)
        const ubiCod = ubicaciones.find((u) => u.id === lon?.ubicacion_id)?.codigo ?? res.ubicacion
        exitosas.push({ linea: l, movimientoId: res.movimientoId, ubicacionId: lon?.ubicacion_id ?? '', ubicacionCodigo: ubiCod })
      } catch (err: unknown) {
        fallos.push({ codigo: l.codigo, error: mensajeError(err) })
      }
    }

    const guiaGuardada = cabecera.guia.trim()
    // Limpieza ANTES del refresco (lección auditoría 2026-11-10): las líneas
    // OK salen de la lista aunque el refresco falle — un segundo clic ya no
    // puede duplicarlas.
    if (exitosas.length > 0) {
      const keysOk = new Set(exitosas.map((e) => e.linea.key))
      const lineasOk = exitosas.map((e) => e.linea)
      setLineas((prev) => prev.filter((l) => !keysOk.has(l.key)))
      if (fallos.length === 0) limpiarCabecera()
      // Deep-link al mapa: la ÚLTIMA lonchera guardada (contrato
      // rep-navegacion: el CÓDIGO DE LA UBICACIÓN, no el del artículo).
      const ultima = exitosas[exitosas.length - 1]
      if (ultima.ubicacionId) setUltimoIngreso({ ubicacionId: ultima.ubicacionId, codigo: ultima.ubicacionCodigo })
      toast.success(`Guía ${guiaGuardada}: ${exitosas.length} artículo(s) registrados`, {
        description: fallos.length > 0 ? `${fallos.length} línea(s) NO se registraron: revisa la lista.` : undefined,
        duration: fallos.length > 0 ? 10000 : undefined,
      })
      if (avisosOtraLonchera > 0) {
        toast.warning(`${avisosOtraLonchera} artículo(s) ya vivían en otra lonchera`, {
          description: 'Excepción controlada: el ingreso se registró igual. Revísalo en el mapa.',
          duration: 10000,
        })
      }
      setModal({
        rotulos: lineasARotulosRep(lineasOk, exitosas.map((e) => e.movimientoId), guiaGuardada),
        encabezado: {
          fecha: formatDateTime(new Date().toISOString()),
          numeroDocumento: guiaGuardada,
          empresaOrigen: etiquetaProveedores(lineasOk.map((l) => proveedorDeLinea(cabecera, l))),
          placa: '',
          registradoPor: perfil?.nombre ?? undefined,
          tipoDocumento: 'Guía',
        },
        nota: `Recepción guardada — ${exitosas.length} artículo(s) de la guía ${guiaGuardada}. Descarga el archivo .zpl o imprime directo.`,
      })
    }

    // Refresco best-effort con aviso propio (nunca enmascara el guardado).
    try {
      await cargarContexto()
    } catch (errRefresco: unknown) {
      toast.info('Guardado, pero no se pudo refrescar el panel', { description: mensajeError(errRefresco) })
    }
    setGuardando(false)
  }

  /** Reimpresión: rótulos de una guía YA guardada, releídos de la BD. */
  async function reimprimirGuia(numGuia: string) {
    setImprimiendoGuia(numGuia)
    try {
      const { filas } = await repListarMovimientos({ tipo: 'ingreso', guia: numGuia, pageSize: 200 })
      if (filas.length === 0) {
        toast.warning(`La guía ${numGuia} ya no tiene ingresos registrados`)
        return
      }
      setModal({
        rotulos: movimientosARotulosRep(filas),
        encabezado: {
          fecha: formatDateTime(filas[0].created_at),
          numeroDocumento: numGuia,
          empresaOrigen: etiquetaProveedores(filas.map((m) => m.proveedor)),
          placa: '',
          registradoPor: filas[0].usuario_nombre || undefined,
          tipoDocumento: 'Guía',
        },
        nota: `Reimpresión — ${filas.length} artículo(s) de la guía ${numGuia} (leídos de la base de datos).`,
      })
    } catch (err: unknown) {
      toast.error('No se pudo releer la guía', { description: mensajeError(err) })
    } finally {
      setImprimiendoGuia('')
    }
  }

  const ubicacionesFiltradas = ubicaciones.filter((u) => (tipoFiltro === 'todos' ? true : u.tipo === tipoFiltro))
  const ladosDisponibles = loncheras.filter((l) => l.ubicacion_id === ubicacionId)
  const listaDestinos = ubicacionesFiltradas.flatMap((u) => {
    const lons = loncheras.filter((l) => l.ubicacion_id === u.id)
    return lons.map((l) => ({ lonchera: l, ubi: u }))
  })
  const puedeGuardar = lineas.length > 0 && !guardando

  return (
    <div className="space-y-4">
      {/* ═══ 1 · DATOS DE LA GUÍA ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-400" />
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">1 · Datos de la guía</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="guia-num" className="text-xs">N° de Guía *</Label>
            <Input id="guia-num" className="font-mono uppercase" placeholder="Guía de remisión" value={guia} onChange={(e) => setGuia(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="guia-oc" className="text-xs">N° de OC *</Label>
            <Input id="guia-oc" className="font-mono uppercase" placeholder="Orden de compra" value={oc} onChange={(e) => setOc(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="guia-dam" className="text-xs">N° de DAM *</Label>
            <Input id="guia-dam" className="font-mono uppercase" placeholder="Declaración de mercancías" value={dam} onChange={(e) => setDam(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <Switch id="multi-prov" checked={multiProveedor} onCheckedChange={setMultiProveedor} />
            <Label htmlFor="multi-prov" className="text-xs cursor-pointer">
              Varios proveedores en esta guía
            </Label>
          </div>
          <div className="flex-1 min-w-[200px]">
            {multiProveedor ? (
              <p className="text-[11px] text-slate-500">Cada artículo llevará <b>su propio proveedor</b> (campo en el paso 2).</p>
            ) : (
              <Input
                placeholder="Proveedor único de la guía *"
                value={proveedorGeneral}
                onChange={(e) => setProveedorGeneral(e.target.value)}
                className="h-8 text-xs"
              />
            )}
          </div>
        </div>
      </div>

      {/* ═══ 2 · AGREGAR ARTÍCULO ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-4">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">2 · Agregar artículo {multiProveedor && '(con su proveedor)'}</p>

        {/* Código → catálogo */}
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
            />
          </div>
          <Button onClick={() => buscarArticulo()} disabled={buscando || !codigo.trim()} className="gap-2">
            {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Buscar
          </Button>
        </div>

        {articulo && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-1.5">
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

        {/* Destino + cantidad (+ proveedor de línea) */}
        <div className="grid gap-2 sm:grid-cols-4">
          <Select value={tipoFiltro} onValueChange={(v) => { setTipoFiltro(v as typeof tipoFiltro); setUbicacionId(''); setLado('A') }}>
            <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rack">Racks</SelectItem>
              <SelectItem value="pasillo">Pasillos</SelectItem>
              <SelectItem value="zona">Zonas</SelectItem>
              <SelectItem value="prepicking">Pre-picking</SelectItem>
              <SelectItem value="todos">Todos</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={ubicacionId}
            onValueChange={(v) => {
              setUbicacionId(v)
              // Mantén el lado solo si la nueva ubicación lo tiene; si no,
              // cae al primero disponible (evita rótulo/pre-chequeo cruzados).
              const lonsNuevas = loncheras.filter((l) => l.ubicacion_id === v)
              if (lonsNuevas.length > 0 && !lonsNuevas.some((l) => l.lado === lado)) setLado(lonsNuevas[0].lado)
            }}
          >
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
          <Input
            inputMode="decimal"
            placeholder="Cantidad *"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') agregarLinea() }}
          />
          {multiProveedor ? (
            <Input
              placeholder="Proveedor de este artículo *"
              value={proveedorLinea}
              onChange={(e) => setProveedorLinea(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') agregarLinea() }}
            />
          ) : (
            <Button onClick={agregarLinea} disabled={!articulo} className="gap-2">
              <Plus className="h-4 w-4" /> Agregar a la guía
            </Button>
          )}
        </div>
        {multiProveedor && (
          <Button onClick={agregarLinea} disabled={!articulo} className="gap-2 w-full sm:w-auto">
            <Plus className="h-4 w-4" /> Agregar a la guía
          </Button>
        )}
        {ubicacionId && (
          <p className={`text-xs font-semibold ${ocupadasDestino !== null && ocupadasDestino >= REP_MAX_ARTICULOS_LONCHERA ? 'text-rose-600' : 'text-slate-500'}`}>
            Ocupación de la lonchera {ladosDisponibles.some((l) => l.lado === lado) ? lado : ladosDisponibles[0]?.lado ?? 'A'}: {ocupadasDestino ?? '…'}/{REP_MAX_ARTICULOS_LONCHERA} artículos distintos
          </p>
        )}
        {listaDestinos.length === 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            No hay loncheras para este filtro. Crea ubicaciones en el módulo <b>Ubicaciones</b>.
          </p>
        )}
      </div>

      {/* ═══ 3 · ARTÍCULOS DE LA GUÍA + GUARDAR ═══ */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
            3 · Artículos de la guía ({lineas.length})
          </p>
          {ultimoIngreso && onVerEnMapa && (
            <Button variant="outline" size="sm" onClick={() => onVerEnMapa(ultimoIngreso.ubicacionId, ultimoIngreso.codigo)} className="gap-2 h-7 text-xs">
              <MapPin className="h-3.5 w-3.5" /> Ver en el mapa
            </Button>
          )}
        </div>

        {lineas.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">
            Aún no hay artículos. Escanea el primer código arriba — la descripción y la UM se jalan solas del catálogo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-2.5 py-2 font-semibold w-8">#</th>
                  <th className="px-2.5 py-2 font-semibold">Código</th>
                  <th className="px-2.5 py-2 font-semibold">Descripción</th>
                  <th className="px-2.5 py-2 font-semibold">UM</th>
                  <th className="px-2.5 py-2 font-semibold text-right">Cantidad</th>
                  {(multiProveedor || lineas.some((l) => l.proveedor)) && <th className="px-2.5 py-2 font-semibold">Proveedor</th>}
                  <th className="px-2.5 py-2 font-semibold">Destino</th>
                  <th className="px-2.5 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lineas.map((l, i) => (
                  <tr key={l.key} className="hover:bg-slate-50/60">
                    <td className="px-2.5 py-1.5 text-slate-400">{i + 1}</td>
                    <td className="px-2.5 py-1.5 font-mono font-bold text-slate-800">{l.codigo}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 max-w-[220px] truncate" title={l.descripcion}>{l.descripcion}</td>
                    <td className="px-2.5 py-1.5 text-slate-500">{l.und || '—'}</td>
                    <td className="px-2.5 py-1.5 text-right font-bold text-slate-900">{l.cantidad.toLocaleString('es-PE')}</td>
                    {(multiProveedor || lineas.some((l2) => l2.proveedor)) && (
                      <td className="px-2.5 py-1.5 text-slate-600 max-w-[140px] truncate" title={l.proveedor}>{l.proveedor || '—'}</td>
                    )}
                    <td className="px-2.5 py-1.5 font-mono text-slate-500 whitespace-nowrap">{l.destinoEtiqueta}</td>
                    <td className="px-2.5 py-1.5">
                      <button
                        onClick={() => quitarLinea(l.key)}
                        disabled={guardando}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                        title="Quitar de la guía"
                        aria-label={`Quitar ${l.codigo}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          {!articulo && !codigo && puedeGestionar && (
            <Button variant="outline" onClick={() => setAltaOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" /> Alta rápida
            </Button>
          )}
          {!articulo && !codigo && onIrACatalogo && (
            <Button variant="ghost" onClick={onIrACatalogo} className="gap-2">
              <BookOpen className="h-4 w-4" /> Ir a Catálogo
            </Button>
          )}
          <Button onClick={guardar} disabled={!puedeGuardar} className="gap-2">
            {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
            Guardar recepción {lineas.length > 0 && `(${lineas.length})`} y generar rótulos
          </Button>
        </div>
        {guardando && (
          <p className="text-[11px] text-slate-500 text-right">
            Registrando artículos en la base de datos… no cierres ni hagas clic de nuevo.
          </p>
        )}
      </div>

      {/* ═══ ÚLTIMOS INGRESOS (+ reimpresión por guía) ═══ */}
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
                {m.guia && (
                  <Badge variant="outline" className="text-[10px] shrink-0 border-sky-200 bg-sky-50 text-sky-700" title="Guía del ingreso">
                    G. {m.guia}
                  </Badge>
                )}
                <span className="font-bold text-slate-900 shrink-0">{Number(m.cantidad).toLocaleString('es-PE')} {m.und}</span>
                <span className="text-slate-400 shrink-0 hidden sm:inline">{new Date(m.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span>
                {m.guia && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 shrink-0"
                    onClick={() => reimprimirGuia(m.guia)}
                    disabled={imprimiendoGuia !== ''}
                    title={`Reimprimir los rótulos de la guía ${m.guia}`}
                    aria-label={`Reimprimir rótulos de la guía ${m.guia}`}
                  >
                    {imprimiendoGuia === m.guia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ═══ MODAL DE RÓTULOS (guardado o reimpresión) ═══ */}
      <ImprimirRotulosDialog
        open={modal !== null}
        onOpenChange={(o) => { if (!o) setModal(null) }}
        rotulos={modal?.rotulos ?? []}
        encabezado={modal?.encabezado ?? { fecha: '', numeroDocumento: '', empresaOrigen: '', placa: '' }}
        nota={modal?.nota}
        subtitulo={`${modal?.rotulos.length ?? 0} artículo(s) de la guía · etiqueta 15 × 10 cm · almacén Repuestos`}
      />

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
