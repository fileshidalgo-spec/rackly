'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Módulo Tránsito.
 *
 * UNA COLA DE TRABAJO (2026-11-16: la pestaña «Despacho RAL» se retiró —
 * flujo antiguo manual, sin RALs ni stock estacionado en producción; los
 * RPC rep_despachar_ral / rep_devolver_linea siguen en BD por si el ciclo
 * vuelve, y Atención conserva sus vistas de RAL):
 *
 *  · POR UBICAR (2026-11-11, paridad Insumos): las líneas que Recepción
 *    guardó SIN destino (rep_recepcion_lineas.estado='en_transito',
 *    agrupadas por guía). Aquí SE DECIDE a qué lonchera va cada artículo:
 *    «Ubicar» → RPC atómica rep_ubicar_desde_transito que en UNA
 *    transacción valida capacidad (15 artículos distintos), hace upsert
 *    de rep_stock, escribe el kardex 'ingreso' con el documento
 *    (guía/OC/DAM/proveedor) y marca la línea como ubicada. Antes de
 *    ubicar la mercadería NO tiene stock ni kardex: vive solo en el
 *    documento de recepción.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRegistrosRealtime } from '@/hooks/useRegistrosRealtime'
import { puede } from '@/lib/rackly/permisos'
import {
  repLineasEnTransito,
  repLineaPorId,
  repLineasPorGuiaNumero,
  repUbicarDesdeTransito,
  repListarUbicaciones,
  repListarLoncheras,
  type RepUbicacion,
  type RepLonchera,
  type RepLineaConDocumento,
} from '@/lib/rackly/rep/rep-client'
import { mensajeError } from '@/lib/rackly/errores'
import { parsearPayloadQR } from '@/lib/rackly/qr-rotulo'
import { calcularTurno } from '@/lib/rackly/turno'
import { LectorQR } from '@/components/rackly/transito/LectorQR'
import { DialogoUbicarRep } from './DialogoUbicarRep'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import {
  Truck,
  Loader2,
  RefreshCw,
  PackageCheck,
  PackageOpen,
  MapPin,
  ScanLine,
  Search,
} from 'lucide-react'

/** Grupo de líneas «por ubicar» bajo el MISMO documento de recepción. */
type GuiaPorUbicar = {
  recepcionId: string
  guia: string
  oc: string
  dam: string
  fecha: string
  lineas: RepLineaConDocumento[]
}

export function TransitoModule() {
  const { perfil } = useAuth()
  const puedeOperar = puede(perfil, 'repuestos.crear')

  // ── Por ubicar ──
  const [pendientes, setPendientes] = useState<GuiaPorUbicar[]>([])
  const [ubicaciones, setUbicaciones] = useState<RepUbicacion[]>([])
  const [loncheras, setLoncheras] = useState<RepLonchera[]>([])
  const [loadingUbi, setLoadingUbi] = useState(true)
  const [cargandoLista, setCargandoLista] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const genUbiRef = useRef(0)
  /** Hora del último refresco (prueba VISIBLE del auto-refresco en vivo). */
  const [enVivoHora, setEnVivoHora] = useState('')

  // ── DIÁLOGO DE UBICACIÓN + LECTOR QR (paridad Insumos, 2026-11-16) ──
  /** Líneas en proceso de ubicación (1 = botón de línea; N = batch de guía
   *  o el escaneo de un rótulo). null = nada abierto. */
  const [dialogoItems, setDialogoItems] = useState<RepLineaConDocumento[] | null>(null)
  /** Lector de QR (cámara + pistola USB): abierto y en pausa durante ubicación. */
  const [lectorOpen, setLectorOpen] = useState(false)
  /** Anti-doble-disparo: una resolución a la vez (ref, no estado — no renderiza). */
  const escaneandoRef = useRef(false)
  /** Feedback dentro del lector mientras la BD resuelve el escaneo. */
  const [ocupado, setOcupado] = useState('')
  /** Guías (por recepcion_id) con su tarjeta CERRADA por el usuario (las
   *  tarjetas nacen abiertas — el QR garantiza que la suya quede abierta). */
  const [guiasCerradas, setGuiasCerradas] = useState<Set<string>>(new Set())

  const cargarPendientes = useCallback(async () => {
    const gen = ++genUbiRef.current
    setCargandoLista(true)
    try {
      const [lineas, ubs, lons] = await Promise.all([
        repLineasEnTransito(300),
        repListarUbicaciones(),
        repListarLoncheras(),
      ])
      if (gen !== genUbiRef.current) return
      setUbicaciones(ubs)
      setLoncheras(lons)
      // Agrupar por recepción conservando el orden (más vieja primero)
      const grupos = new Map<string, GuiaPorUbicar>()
      for (const l of lineas) {
        let g = grupos.get(l.recepcion_id)
        if (!g) {
          g = {
            recepcionId: l.recepcion_id,
            guia: l.guia,
            oc: l.oc,
            dam: l.dam,
            fecha: l.fechaRecepcion,
            lineas: [],
          }
          grupos.set(l.recepcion_id, g)
        }
        g.lineas.push(l)
      }
      setPendientes([...grupos.values()])
      // El DESTINO lo pide el diálogo (mapa visual, paridad Insumos): aquí ya
      // no hay pre-relleno por línea — el selector viejo quedó reemplazado.
      setEnVivoHora(
        new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      )
    } catch (err: unknown) {
      if (gen !== genUbiRef.current) return
      toast.error('Error al cargar lo recibido', { description: mensajeError(err) })
    } finally {
      if (gen === genUbiRef.current) setCargandoLista(false)
    }
  }, [])

  useEffect(() => {
    cargarPendientes()
  }, [cargarPendientes])

  // ── REFRESCO EN VIVO (paridad Insumos): Recepción REP guarda una guía y
  // aparece aquí en segundos — realtime (INSERT/UPDATE/DELETE con debounce)
  // + polling de respaldo del hook. El canal de la tabla se publicó en BD
  // (migración 20261116_rep_transito_qr). El refresco lo hace este módulo
  // con cargarPendientes (el hook solo avisa).
  useRegistrosRealtime('rep_recepcion_lineas', () => {
    void cargarPendientes()
  })

  // ── Búsqueda del encabezado (paridad Insumos): guía/OC/DAM o cualquier
  // línea por código/descripción/proveedor. La cabecera que coincide muestra
  // TODAS sus líneas; si coincide una línea, se muestran solo las que pegan.
  const pendientesFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return pendientes
    return pendientes
      .map((g) => {
        const cabeceraPega =
          g.guia.toLowerCase().includes(q) ||
          g.oc.toLowerCase().includes(q) ||
          g.dam.toLowerCase().includes(q)
        if (cabeceraPega) return g
        return { ...g, lineas: g.lineas.filter((l) =>
          l.codigo.toLowerCase().includes(q) ||
          l.descripcion.toLowerCase().includes(q) ||
          l.proveedor.toLowerCase().includes(q)
        ) }
      })
      .filter((g) => g.lineas.length > 0)
  }, [pendientes, busqueda])

  // ═══ RESOLUCIÓN DEL QR (rótulos de Recepción REP → ubicación directa) ═══
  // La identidad del rótulo REP es el uuid de SU LÍNEA (rep_recepcion_lineas,
  // ver recepcion-guia.ts/lineasARotulosRep): ruta EXACTA 1:1, misma filosofía
  // del QR único por rótulo de Insumos. Fallbacks: Nº de guía en el payload
  // (rótulos residuales) y aviso claro si el rótulo pertenece a Insumos.

  /** Garantiza la tarjeta de la guía ABIERTA (el escaneo la pide a gritos). */
  function abrirGuia(recepcionId: string) {
    setGuiasCerradas((prev) => {
      if (!prev.has(recepcionId)) return prev
      const next = new Set(prev)
      next.delete(recepcionId)
      return next
    })
  }

  /**
   * Resuelve el texto escaneado y abre la ubicación "ahí mismo":
   *   1. QR ÚNICO POR RÓTULO: identidad = uuid de LÍNEA → repLineaPorId →
   *      ESA línea exacta (en_transito → diálogo; ubicada → aviso con dónde).
   *   2. Rótulo sin identidad (residual): por Nº de guía del payload.
   *   3. uuid que no existe en rep_* y sin guía que lo cubra → rótulo de
   *      INSUMOS (u otro QR): aviso explícito, nunca un silencio.
   *   4. Varias líneas con pendiente para el mismo código (rótulo legado):
   *      se abre SOLO la tarjeta de la guía (rigor QR de Insumos) y el
   *      operario pulsa Ubicar en SU línea.
   */
  const resolverQR = async (texto: string, _fuente: 'camara' | 'manual') => {
    if (escaneandoRef.current) return
    const p = parsearPayloadQR(texto)
    if (!p) {
      toast.error('El QR no es un rótulo de Rackly', { description: texto.slice(0, 60) })
      return
    }
    escaneandoRef.current = true
    setOcupado('Leyendo rótulo…')
    try {
      // ── Ruta EXACTA (rótulo con uuid de línea) ──
      if (p.identidad) {
        const linea = await repLineaPorId(p.identidad)
        if (linea) {
          if (linea.estado === 'ubicado') {
            const ubi = ubicaciones.find((u) => u.id === linea.ubicacion_id)
            const lon = loncheras.find((l) => l.id === linea.lonchera_id)
            toast.info(`${linea.codigo}: ya está ubicado`, {
              description: `Guía ${linea.guia || p.numeroDocumento} — está en ${ubi?.codigo ?? 'su ubicación'}${lon ? ` lado ${lon.lado}` : ''}. Revísalo en el módulo Ubicaciones.`,
            })
            return
          }
          abrirGuia(linea.recepcion_id)
          toast.success(`Guía ${linea.guia || p.numeroDocumento} · ${linea.codigo}`, {
            description: 'Rótulo con QR único: la ubicación es de ESTA línea exacta. Elige destino y posición en el mapa.',
          })
          setDialogoItems([linea])
          return
        }
        // No existe una línea rep_* con ese uuid → probablemente rótulo de
        // INSUMOS: cae a la búsqueda por Nº de guía para dar el mejor aviso.
      }

      // ── Fallback: por Nº de guía del payload ──
      const lineas = p.numeroDocumento ? await repLineasPorGuiaNumero(p.numeroDocumento) : []
      if (lineas.length === 0) {
        toast.error(p.identidad ? 'Este rótulo no corresponde a Repuestos' : 'La guía del rótulo no está en Tránsito', {
          description: p.identidad
            ? 'Si es un rótulo de INSUMOS, escanéalo en el Tránsito de Insumos.'
            : p.numeroDocumento
              ? `Guía ${p.numeroDocumento}: verifica el Nº o reimprime los rótulos en Recepción de Repuestos.`
              : 'No se pudo identificar el documento del rótulo.',
        })
        return
      }
      const enTransito = lineas.filter((l) => l.estado === 'en_transito')
      if (enTransito.length === 0) {
        toast.info(`Guía ${p.numeroDocumento}: todo está ubicado`, {
          description: 'Las líneas de esta guía ya tienen su lonchera. Revísalas en el módulo Ubicaciones.',
        })
        return
      }
      // ¿El código del rótulo identifica la línea? (case-insensitive)
      const delCodigo = p.codigo
        ? enTransito.filter((l) => l.codigo.trim().toUpperCase() === p.codigo.trim().toUpperCase())
        : []
      const candidatas = delCodigo.length > 0 ? delCodigo : enTransito
      if (candidatas.length === 1) {
        abrirGuia(candidatas[0].recepcion_id)
        toast.success(`Guía ${p.numeroDocumento} · ${candidatas[0].codigo}`, {
          description: 'Elige destino y posición en el mapa.',
        })
        setDialogoItems(candidatas)
        return
      }
      // ── RIGOR QR LEGADO: varias filas del mismo código con pendiente y el
      // rótulo no identifica cuál es — se abre la guía y elige su línea. ──
      const g = pendientes.find((x) => x.recepcionId === candidatas[0].recepcion_id)
      if (g) abrirGuia(g.recepcionId)
      toast.warning(
        `Guía ${p.numeroDocumento}: ${candidatas.length} líneas de ${p.codigo || 'la guía'} están pendientes y este rótulo no identifica cuál es la tuya`,
        {
          description: 'Pulsa Ubicar en la línea correcta de la tarjeta abierta.',
          duration: 9000,
        }
      )
    } catch (err) {
      console.error('[TransitoRep] Error resolviendo QR:', err)
      toast.error('Error al resolver el QR del rótulo', { description: mensajeError(err) })
    } finally {
      escaneandoRef.current = false
      setOcupado('')
    }
  }

  const usuarioCtx = { id: perfil?.id ?? '', nombre: perfil?.nombre ?? '' }
  const turno = calcularTurno()

  const totalPendientes = useMemo(() => pendientes.reduce((s, g) => s + g.lineas.length, 0), [pendientes])

  return (
    <div className="space-y-4">
      {/* ═══ POR UBICAR (recepciones sin destino) — paridad Insumos ═══ */}
    <div className="rounded-xl border bg-white p-4 space-y-4">
        {/* Encabezado: Escanear QR + Actualizar + EN VIVO (realtime) */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => setLectorOpen(true)}
            size="sm"
            className="gap-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 font-semibold"
            title="Escanear el QR de un rótulo (cámara o pistola USB) y ubicar directamente"
          >
            <ScanLine className="h-4 w-4" />
            Escanear QR
          </Button>
          <Button onClick={cargarPendientes} variant="outline" size="sm" className="gap-2" disabled={cargandoLista}>
            {cargandoLista ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualizar
          </Button>
          <span
            className="hidden md:flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 ml-1 whitespace-nowrap"
            title="La lista se actualiza sola cuando Recepción de Repuestos guarda, edita o elimina una guía (realtime + refresco de respaldo)"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            {enVivoHora ? `En vivo · ${enVivoHora}` : 'En vivo'}
          </span>
        </div>

        {/* Búsqueda (guía/OC/DAM/código/descripción/proveedor) */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por guía, OC, DAM, código, descripción o proveedor…"
            className="pl-9 h-9"
          />
        </div>

        <p className="text-xs text-slate-500">
          Lo que Recepción recibió, esperando su lugar. Pulsa <b>Ubicar</b> en la línea — o el botón batch
          de la guía — y elige la posición en el mapa: ahí se registran el stock y el kardex de ingreso con la guía.
        </p>

        {cargandoLista && pendientes.length === 0 && (
          <div className="flex items-center justify-center py-12 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando…
          </div>
        )}

        {!cargandoLista && pendientes.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <PackageOpen className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="text-sm font-semibold text-slate-500">Nada pendiente de ubicar</p>
            <p className="text-xs mt-1">Las recepciones nuevas aparecen aquí agrupadas por su guía.</p>
          </div>
        )}

        {!cargandoLista && pendientes.length > 0 && pendientesFiltrados.length === 0 && (
          <div className="text-center py-8 text-slate-400">
            <PackageOpen className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            <p className="text-sm font-semibold text-slate-500">Nada coincide con «{busqueda.trim()}»</p>
          </div>
        )}

        <div className="space-y-3">
          {pendientesFiltrados.map((g) => {
            const abierta = !guiasCerradas.has(g.recepcionId)
            return (
              <div key={g.recepcionId} className="rounded-xl border border-amber-200 bg-amber-50/30 p-3 space-y-2">
                {/* Cabecera del documento (clic = abrir/cerrar) */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() =>
                      setGuiasCerradas((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.recepcionId)) next.delete(g.recepcionId)
                        else next.add(g.recepcionId)
                        return next
                      })
                    }
                    className="flex flex-wrap items-center gap-2 text-left min-w-0 flex-1"
                    aria-expanded={abierta}
                  >
                    <Truck className="h-4 w-4 text-amber-600 shrink-0" />
                    <span className="font-mono font-extrabold text-sm text-slate-900">{g.guia}</span>
                    {(g.oc || g.dam) && (
                      <span className="text-[10px] font-mono text-slate-500">
                        {g.oc && <>OC {g.oc}</>}{g.oc && g.dam && ' · '}{g.dam && <>DAM {g.dam}</>}
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      {new Date(g.fecha).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' })}
                    </span>
                    <Badge variant="outline" className="text-[10px] bg-white">
                      {g.lineas.length} artículo(s)
                    </Badge>
                  </button>
                  {puedeOperar && g.lineas.length > 1 && (
                    <Button
                      onClick={() => setDialogoItems(g.lineas)}
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-8 text-xs font-semibold shrink-0"
                      title="Todas las líneas de la guía a la MISMA posición (un envío cada una)"
                    >
                      <PackageCheck className="h-3.5 w-3.5" />
                      Ubicar las {g.lineas.length} juntas
                    </Button>
                  )}
                </div>

                {/* Líneas (destino por el diálogo — mapa visual) */}
                {abierta && (
                  <ul className="space-y-1.5">
                    {g.lineas.map((l) => (
                      <li key={l.id} className="rounded-lg border bg-white px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-extrabold text-sm text-slate-900 shrink-0">{l.codigo}</span>
                          <span className="text-slate-500 truncate flex-1 min-w-[120px]" title={l.descripcion}>{l.descripcion}</span>
                          {l.proveedor && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 bg-slate-50 text-slate-600 shrink-0" title="Proveedor de la línea">
                              {l.proveedor}
                            </Badge>
                          )}
                          <span className="font-bold text-slate-900 shrink-0">
                            {l.cantidad.toLocaleString('es-PE')} {l.und}
                          </span>
                          {puedeOperar && (
                            <Button
                              onClick={() => setDialogoItems([l])}
                              size="sm"
                              className="gap-1.5 h-8 shrink-0"
                              title="Abrir el mapa y elegir la posición destino"
                            >
                              <MapPin className="h-3.5 w-3.5" />
                              Ubicar
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {/* ═══ Lector de QR de rótulos (pausado mientras hay ubicación abierta) ═══ */}
      <LectorQR
        open={lectorOpen}
        pausado={!!dialogoItems}
        onOpenChange={setLectorOpen}
        onDetectar={(texto, fuente) => void resolverQR(texto, fuente)}
        titulo="Escanear rótulo (Repuestos)"
        descripcion="Apunta al QR del rótulo de Recepción de Repuestos — abre la ubicación de esa línea."
        ocupado={ocupado}
      />

      {/* ═══ Diálogo de ubicación (destino → mapa → lado → confirmar) ═══ */}
      {dialogoItems && (
        <DialogoUbicarRep
          items={dialogoItems}
          usuario={usuarioCtx}
          turno={turno}
          onListo={() => {
            setDialogoItems(null)
            cargarPendientes()
          }}
          onCancelar={() => setDialogoItems(null)}
        />
      )}
    </div>
  )
}
