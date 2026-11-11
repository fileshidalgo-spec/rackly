'use client'

/**
 * RACKLY — TRASLADO DE UBICACIÓN COMPLETA (Kardex Racks · INSUMOS).
 *
 * Pedido del usuario 2026-11-11: «que se realice el traslado de TODO lo que se
 * encuentra en esa ubicación a otra ubicación para que sea más rápido —
 * actualmente hay que hacerlo 1 por 1» + ajustes por artículo (mover menos o
 * más cantidad en alguno de ellos).
 *
 * Flujo: origen → carga server-side del contenido (stockEnUbicacion, la MISMA
 * fuente que Ocupación) → tabla editable por artículo (prefilled con el stock
 * completo; menos = deja saldo, más = ajuste con ingreso en origen) → destino
 * → confirmación → RPC atómica registrar_traslado_ubicacion_kardex
 * (all-or-nothing, FEFO server-side por (lote, vencimiento), INC excluido).
 *
 * Este componente SOLO orquesta la UI; toda la lógica de datos vive en
 * lib/rackly/kardex.ts (itemsTrasladoDesdeUbicacion, repartoFefoLotes,
 * trasladarUbicacionCompleta) — misma separación que TrasladoTab.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  stockEnUbicacion,
  trasladarUbicacionCompleta,
  itemsTrasladoDesdeUbicacion,
  TrasladoUbicacionError,
  type StockEnUbicacion,
  type TrasladoUbicacionResultado,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { useAuth } from '@/hooks/useAuth'
import { refrescarMovimientosIncremental } from '@/hooks/useMovimientosRealtime'
import { extractError, formatDate } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  ArrowRightLeft, MapPin, Package, AlertTriangle, TriangleAlert,
  Loader2, RefreshCw, Boxes, CheckCircle2,
} from 'lucide-react'

export type ModoTraslado = 'articulo' | 'ubicacion'

/** Selector del modo de traslado: por artículo (clásico) o ubicación completa. */
export function ModoTrasladoSelector({ modo, onChange }: { modo: ModoTraslado; onChange: (m: ModoTraslado) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={() => onChange('articulo')}
        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
          modo === 'articulo'
            ? 'bg-sky-100 text-sky-800 border-2 border-sky-400 shadow-sm dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-600'
            : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
        }`}
      >
        <Package className="h-3 w-3 inline-block mr-1 -mt-0.5" />
        Por artículo
      </button>
      <button
        type="button"
        onClick={() => onChange('ubicacion')}
        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
          modo === 'ubicacion'
            ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-400 shadow-sm dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-600'
            : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
        }`}
      >
        <Boxes className="h-3 w-3 inline-block mr-1 -mt-0.5" />
        Ubicación completa
      </button>
    </div>
  )
}

const keyDe = (b: string, t: string, p: string, pos: string) => `${b}-${t}-${p || '1'}-${pos}`

export function TrasladoUbicacionTab() {
  const { perfil } = useAuth()

  const [origBloque, setOrigBloque] = useState('')
  const [origTorre, setOrigTorre] = useState('')
  const [origPiso, setOrigPiso] = useState('')
  const [origPos, setOrigPos] = useState('')
  const [destBloque, setDestBloque] = useState('')
  const [destTorre, setDestTorre] = useState('')
  const [destPiso, setDestPiso] = useState('')
  const [destPos, setDestPos] = useState('')

  const [contenido, setContenido] = useState<StockEnUbicacion[]>([])
  const [cantidades, setCantidades] = useState<Record<string, string>>({})
  const [cargando, setCargando] = useState(false)
  const [errorCarga, setErrorCarga] = useState<string | null>(null)

  const [destinoOcupado, setDestinoOcupado] = useState<StockEnUbicacion[] | null>(null)
  const [destinoConsultaFallo, setDestinoConsultaFallo] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  // Guard anti-carrera: solo la última carga pintará su resultado (cambiar la
  // ubicación de origen dos veces rápido no debe mezclar contenidos).
  const cargaSeq = useRef(0)

  const origKey = keyDe(origBloque, origTorre, origPiso, origPos)
  const destKey = keyDe(destBloque, destTorre, destPiso, destPos)
  const origenCompleto = !!(origBloque && origTorre && origPiso && origPos)
  const destinoCompleto = !!(destBloque && destTorre && destPiso && destPos)
  const destinoIgualOrigen = origenCompleto && destinoCompleto && origKey === destKey

  const origTorres = torresDeBloque(origBloque)
  const origPosiciones = posicionesDeBloque(origBloque)
  const destTorres = torresDeBloque(destBloque)
  const destPosiciones = posicionesDeBloque(destBloque)

  // ── Carga del contenido de origen (server-side, misma fuente que Ocupación) ──
  useEffect(() => {
    if (!origenCompleto) {
      setContenido([])
      setCantidades({})
      setErrorCarga(null)
      return
    }
    const seq = ++cargaSeq.current
    let viva = true
    setCargando(true)
    setErrorCarga(null)
    stockEnUbicacion(origBloque, origTorre, origPiso || '1', origPos)
      .then((rows) => {
        if (!viva || seq !== cargaSeq.current) return
        // Fila-marker _error: la consulta falló a medias — no pintar datos parciales
        if (rows.length > 0 && '_error' in rows[0] && rows[0]._error) {
          setContenido([])
          setCantidades({})
          setErrorCarga('No se pudo cargar el contenido de la ubicación. Intenta de nuevo.')
          return
        }
        setContenido(rows)
        // Prefill: TODO se traslada por defecto (el pedido: mover todo de una vez)
        const pre: Record<string, string> = {}
        for (const art of rows) if (!art.codigoInc) pre[art.codigo] = String(art.stock)
        setCantidades(pre)
      })
      .catch((err) => {
        if (!viva || seq !== cargaSeq.current) return
        setContenido([])
        setCantidades({})
        setErrorCarga(extractError(err))
      })
      .finally(() => {
        if (viva && seq === cargaSeq.current) setCargando(false)
      })
    return () => { viva = false }
  }, [origenCompleto, origBloque, origTorre, origPiso, origPos])

  // ── Vista previa del destino ocupado (informativa, igual que el unitario) ──
  useEffect(() => {
    if (!destinoCompleto || destinoIgualOrigen) {
      setDestinoOcupado(null)
      setDestinoConsultaFallo(false)
      return
    }
    let viva = true
    setDestinoOcupado(null)
    setDestinoConsultaFallo(false)
    stockEnUbicacion(destBloque, destTorre, destPiso || '1', destPos)
      .then((rows) => {
        if (!viva) return
        if (rows.length > 0 && '_error' in rows[0] && rows[0]._error) {
          setDestinoConsultaFallo(true)
          return
        }
        setDestinoOcupado(rows)
      })
      .catch(() => { if (viva) setDestinoConsultaFallo(true) })
    return () => { viva = false }
  }, [destinoCompleto, destinoIgualOrigen, destBloque, destTorre, destPiso, destPos])

  // ── Derivados (lógica en lib: testeable) ──
  const { items, lotesPorCodigo, omitidosInc } = useMemo(
    () => itemsTrasladoDesdeUbicacion(contenido, cantidades),
    [contenido, cantidades]
  )

  const stockDe = (codigo: string) => contenido.find((a) => a.codigo === codigo)?.stock ?? 0
  const conAjuste = useMemo(
    () => items.filter((i) => i.cantidad > stockDe(i.codigo) + 1e-9),
    [items, contenido]
  )
  const totalUnidades = useMemo(() => items.reduce((s, i) => s + i.cantidad, 0), [items])
  const vencPorCodigo = useMemo(() => {
    const m: Record<string, string> = {}
    for (const art of contenido) if (!art.codigoInc && art.fVencimiento) m[art.codigo] = art.fVencimiento
    return m
  }, [contenido])

  function recargar() {
    // Fuerza recarga sin cambiar los selects (seq del effect sigue válido)
    const seq = ++cargaSeq.current
    if (!origenCompleto) return
    setCargando(true)
    setErrorCarga(null)
    stockEnUbicacion(origBloque, origTorre, origPiso || '1', origPos)
      .then((rows) => {
        if (seq !== cargaSeq.current) return
        if (rows.length > 0 && '_error' in rows[0] && rows[0]._error) {
          setContenido([]); setCantidades({})
          setErrorCarga('No se pudo cargar el contenido de la ubicación. Intenta de nuevo.')
          return
        }
        setContenido(rows)
        const pre: Record<string, string> = {}
        for (const art of rows) if (!art.codigoInc) pre[art.codigo] = String(art.stock)
        setCantidades(pre)
      })
      .catch((err) => { if (seq === cargaSeq.current) setErrorCarga(extractError(err)) })
      .finally(() => { if (seq === cargaSeq.current) setCargando(false) })
  }

  function setCantidad(codigo: string, valor: string) {
    setCantidades((prev) => ({ ...prev, [codigo]: valor }))
  }

  function puedeConfirmar(): boolean {
    return items.length > 0 && destinoCompleto && !destinoIgualOrigen && !busy && !cargando
  }

  async function handleEjecutar() {
    if (!perfil || !puedeConfirmar()) return
    setBusy(true)
    try {
      const res: TrasladoUbicacionResultado = await trasladarUbicacionCompleta({
        origen: { bloque: origBloque, torre: origTorre, piso: origPiso || '1', posicion: origPos },
        destino: { bloque: destBloque, torre: destTorre, piso: destPiso || '1', posicion: destPos },
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        items,
      }, { refetch: false, lotesPorCodigo, vencPorCodigo })

      if (res.pendientes && res.pendientes.length > 0) {
        toast.warning('Traslado PARCIAL (fallback)', {
          description: `Llegaron ${res.articulos} artículo(s). Pendientes: ${res.pendientes.map((x) => `${x.codigo} (${x.cantidad})`).join(', ')} — reintenta para completar.`,
          duration: 10000,
        })
      } else {
        const conAjusteN = res.por_articulo.filter((x) => (x.ajuste ?? 0) > 0).length
        toast.success(`Traslado completo: ${res.articulos} artículo(s), ${res.filas} movimientos registrados`, {
          description: conAjusteN > 0
            ? `${conAjusteN} artículo(s) con ajuste de ingreso en origen (había más stock físico que registrado).`
            : 'Cada lote conservó su fecha de vencimiento en el destino.',
          duration: 7000,
        })
      }
      await refrescarMovimientosIncremental()
      // Recargar el contenido de origen: muestra exactamente qué quedó (saldos
      // de artículos ajustados a menos y los INC que nunca se mueven).
      recargar()
      setDestBloque(''); setDestTorre(''); setDestPiso(''); setDestPos('')
      setDestinoOcupado(null)
    } catch (err: unknown) {
      if (err instanceof TrasladoUbicacionError) {
        toast.error('No se pudo completar el traslado', {
          description: err.detail,
          duration: 8000,
        })
      } else {
        toast.error('Error al trasladar la ubicación', { description: extractError(err) })
      }
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  if (!perfil) return <div className="p-4 text-muted-foreground animate-pulse">Cargando...</div>

  const origenVacio = origenCompleto && !cargando && !errorCarga && contenido.length === 0

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20 p-3 flex items-start gap-2.5">
        <Boxes className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          Mueve <strong>todo el contenido</strong> de una ubicación en <strong>una sola operación</strong> (todo-o-nada).
          Cada artículo se prellena con su stock completo: baja la cantidad para <strong>dejar saldo</strong> en origen
          o súbelo si físicamente hay más (se registra un <strong>ingreso de ajuste</strong>). Los artículos INC no se mueven.
        </p>
      </div>

      {/* ═══ 1. ORIGEN ═══ */}
      <div className="space-y-2 p-4 border rounded-lg">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">1. Ubicación de origen (se trasladará todo su contenido):</p>
          {origenCompleto && (
            <Button variant="outline" size="sm" onClick={recargar} disabled={cargando}
              className="h-8 px-2.5 text-[11px] font-semibold gap-1">
              {cargando ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Recargar
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label>Bloque</Label>
            <Select value={origBloque} onValueChange={(v) => { setOrigBloque(v); setOrigTorre(''); setOrigPos('') }}>
              <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
              <SelectContent>{BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Torre</Label>
            <Select value={origTorre} onValueChange={setOrigTorre} disabled={!origBloque}>
              <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
              <SelectContent>{origTorres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Piso</Label>
            <Select value={origPiso} onValueChange={setOrigPiso} disabled={!origBloque}>
              <SelectTrigger><SelectValue placeholder="Piso" /></SelectTrigger>
              <SelectContent>{PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Posición</Label>
            <Select value={origPos} onValueChange={setOrigPos} disabled={!origBloque}>
              <SelectTrigger><SelectValue placeholder="Pos" /></SelectTrigger>
              <SelectContent>{origPosiciones.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>

        {cargando && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando contenido de la ubicación…
          </div>
        )}
        {errorCarga && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20 p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-300">{errorCarga}</p>
          </div>
        )}
        {origenVacio && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/40 p-2.5">
            <p className="text-xs text-muted-foreground">La ubicación está vacía (sin stock registrado).</p>
          </div>
        )}
      </div>

      {/* ═══ 2. ARTÍCULOS + AJUSTES ═══ */}
      {contenido.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm font-medium">2. Ajusta las cantidades a trasladar:</p>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold">
              <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-300">
                {items.length} artículo(s) por mover
              </Badge>
              <Badge variant="outline" className="border-slate-300 text-slate-600 dark:text-slate-400">
                {Math.round(totalUnidades * 1000) / 1000} unidades
              </Badge>
              {conAjuste.length > 0 && (
                <Badge variant="outline" className="border-amber-300 text-amber-700 dark:text-amber-300">
                  {conAjuste.length} con ajuste +
                </Badge>
              )}
            </div>
          </div>

          {/* ── Mobile: cards ── */}
          <div className="sm:hidden space-y-2.5">
            {contenido.map((art) => (
              <ArticuloCard
                key={`${art.codigo}||${art.codigoInc ?? ''}`}
                art={art}
                cantidad={cantidades[art.codigo] ?? ''}
                onCantidad={setCantidad}
              />
            ))}
          </div>

          {/* ── Desktop: tabla ── */}
          <div className="hidden sm:block overflow-x-auto rounded-xl border border-slate-200/60">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Código</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">Descripción</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Stock origen</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">A trasladar</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Queda</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">Lote FEFO</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contenido.map((art) => (
                  <ArticuloFila
                    key={`${art.codigo}||${art.codigoInc ?? ''}`}
                    art={art}
                    cantidad={cantidades[art.codigo] ?? ''}
                    onCantidad={setCantidad}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {omitidosInc.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20 p-2.5 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {omitidosInc.length} artículo(s) INC <strong>quedan en origen</strong> (cuarentena: se gestionan por su flujo INC, no se mueven en bloque):
                {' '}{omitidosInc.map((a) => `${a.codigo}${a.codigoInc ? ` (${a.codigoInc})` : ''}`).join(', ')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ═══ 3. DESTINO ═══ */}
      {items.length > 0 && (
        <div className="space-y-3 p-4 border rounded-lg">
          <p className="text-sm font-medium">3. Ubicación de destino:</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label>Bloque</Label>
              <Select value={destBloque} onValueChange={(v) => { setDestBloque(v); setDestTorre(''); setDestPos('') }}>
                <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>{BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Torre</Label>
              <Select value={destTorre} onValueChange={setDestTorre} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>{destTorres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Piso</Label>
              <Select value={destPiso} onValueChange={setDestPiso} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Piso" /></SelectTrigger>
                <SelectContent>{PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Posición</Label>
              <Select value={destPos} onValueChange={setDestPos} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Pos" /></SelectTrigger>
                <SelectContent>{destPosiciones.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          {destinoIgualOrigen && (
            <p className="text-xs text-red-600 dark:text-red-400 font-medium">El destino no puede ser igual al origen.</p>
          )}
          {destinoConsultaFallo && (
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              No se pudo verificar el destino. Revísalo manualmente antes de confirmar.
            </p>
          )}
          {destinoOcupado && destinoOcupado.length > 0 && (
            <div className="rounded-lg border border-orange-200 bg-orange-50/70 dark:border-orange-800 dark:bg-orange-950/20 p-2.5 space-y-1">
              <p className="text-xs font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5" /> El destino ya tiene stock ({destinoOcupado.length} artículo(s)) — se mezclará con lo trasladado:
              </p>
              <p className="text-[11px] text-orange-600/80 dark:text-orange-400/80">
                {destinoOcupado.map((a) => `${a.codigo} (${a.stock} ${a.un})`).join(' · ')}
              </p>
            </div>
          )}

          <Button onClick={() => setConfirm(true)} disabled={!puedeConfirmar()} className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
            Confirmar traslado de {items.length} artículo(s)
          </Button>
        </div>
      )}

      {/* ═══ CONFIRMACIÓN ═══ */}
      <AlertDialog open={confirm} onOpenChange={(v) => { if (!busy) setConfirm(v) }}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          <div className={`px-4 sm:px-6 py-5 text-white shrink-0 ${
            destinoOcupado && destinoOcupado.length > 0
              ? 'bg-gradient-to-r from-orange-500 via-red-500 to-red-600'
              : 'bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                {destinoOcupado && destinoOcupado.length > 0
                  ? <TriangleAlert className="h-6 w-6 text-white" />
                  : <ArrowRightLeft className="h-6 w-6 text-white" />}
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  {destinoOcupado && destinoOcupado.length > 0 ? 'Destino Ocupado' : 'Confirmar Traslado Completo'}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-sm mt-0.5 text-white/90">
                  {items.length} artículo(s) · {Math.round(totalUnidades * 1000) / 1000} unidades en UNA transacción (todo-o-nada).
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          <AlertDialogDescription className="sr-only">
            Confirmación del traslado de ubicación completa
          </AlertDialogDescription>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="px-4 sm:px-6 pt-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Ruta del traslado</p>
              <div className="flex items-center gap-2 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2.5">
                <MapPin className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300 truncate min-w-0">
                  B-{origBloque} T-{origTorre} P-{origPiso} Pos-{origPos}
                  <span className="mx-2 text-emerald-500 font-bold">→</span>
                  B-{destBloque} T-{destTorre} P-{destPiso} Pos-{destPos}
                </span>
              </div>
            </div>

            <div className="px-4 sm:px-6 pb-3 space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Artículos</p>
              {items.map((i) => {
                const stock = stockDe(i.codigo)
                const excede = i.cantidad > stock + 1e-9
                const queda = Math.round(Math.max(stock - Math.min(i.cantidad, stock), 0) * 1000) / 1000
                return (
                  <div key={i.codigo} className={`rounded-lg border p-2 flex items-center justify-between gap-2 ${
                    excede ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20' : 'border-slate-200 dark:border-slate-700'
                  }`}>
                    <div className="min-w-0">
                      <p className="font-mono font-bold text-xs text-slate-800 dark:text-slate-200">{i.codigo}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{i.descripcion}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                        {i.cantidad} {i.un}
                        {excede && <span className="text-amber-600 dark:text-amber-400"> (ajuste +{Math.round((i.cantidad - stock) * 1000) / 1000})</span>}
                      </p>
                      {queda > 0 && <p className="text-[10px] text-muted-foreground">queda {queda} {i.un} en origen</p>}
                    </div>
                  </div>
                )
              })}
            </div>

            {omitidosInc.length > 0 && (
              <div className="px-4 sm:px-6 pb-3">
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  ⚠ {omitidosInc.length} artículo(s) INC quedan en origen (no se mueven).
                </p>
              </div>
            )}
          </div>

          <AlertDialogFooter className="px-4 sm:px-6 py-4 border-t shrink-0">
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleEjecutar() }}
              disabled={busy || !puedeConfirmar()}
              className="gap-1.5"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Trasladar todo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Fila desktop de la tabla de ajustes. */
function ArticuloFila({ art, cantidad, onCantidad }: {
  art: StockEnUbicacion
  cantidad: string
  onCantidad: (codigo: string, valor: string) => void
}) {
  const esInc = !!art.codigoInc
  const cantNum = parseFloat(cantidad) || 0
  const excede = !esInc && cantNum > art.stock + 1e-9
  const queda = esInc ? art.stock : Math.round(Math.max(art.stock - Math.min(cantNum, art.stock), 0) * 1000) / 1000
  return (
    <TableRow className={esInc ? 'opacity-70' : undefined}>
      <TableCell>
        <p className="font-mono font-bold text-xs text-slate-800 dark:text-slate-200">{art.codigo}</p>
        <p className="text-[10px] text-muted-foreground sm:hidden truncate max-w-[140px]">{art.descripcion}</p>
        {esInc && <Badge variant="outline" className="mt-1 bg-amber-50 text-amber-700 border-amber-200 text-[10px]"><AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> INC</Badge>}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <p className="text-xs text-slate-600 dark:text-slate-300 max-w-[260px] truncate">{art.descripcion}</p>
        <p className="text-[10px] text-muted-foreground">
          {art.fVencimiento ? <>Venc: {formatDate(art.fVencimiento)}</> : 'Sin vencimiento'}
          {art.loteFisico && <span className="text-cyan-700 dark:text-cyan-300"> · Lote: {art.loteFisico}</span>}
        </p>
      </TableCell>
      <TableCell className="text-right">
        <span className="font-bold text-slate-800 dark:text-slate-100">{art.stock}</span>
        <span className="text-[10px] text-muted-foreground ml-1">{art.un}</span>
      </TableCell>
      <TableCell>
        {esInc ? (
          <p className="text-[11px] text-center text-muted-foreground">No se mueve</p>
        ) : (
          <div className="flex items-center justify-center gap-1">
            <Input
              type="number"
              step="any"
              min="0"
              value={cantidad}
              onChange={(e) => onCantidad(art.codigo, e.target.value)}
              className="h-8 w-24 text-center font-bold"
              aria-label={`Cantidad a trasladar de ${art.codigo}`}
            />
            <button
              type="button"
              onClick={() => onCantidad(art.codigo, String(art.stock))}
              title="Trasladar todo el stock de este artículo"
              className="h-8 px-1.5 rounded-md border border-emerald-200 text-emerald-700 bg-emerald-50/60 hover:bg-emerald-100 text-[10px] font-bold"
            >
              Todo
            </button>
            <button
              type="button"
              onClick={() => onCantidad(art.codigo, '0')}
              title="No trasladar este artículo"
              className="h-8 px-1.5 rounded-md border border-slate-200 text-slate-500 bg-slate-50 hover:bg-slate-100 text-[10px] font-bold"
            >
              Nada
            </button>
          </div>
        )}
        {excede && (
          <p className="text-[10px] text-amber-600 dark:text-amber-400 text-center mt-0.5 font-semibold">
            ajuste +{Math.round((cantNum - art.stock) * 1000) / 1000} (ingreso en origen)
          </p>
        )}
      </TableCell>
      <TableCell className="text-right">
        <span className={`text-sm font-semibold ${queda === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-300'}`}>
          {queda}
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span className="text-[10px] text-muted-foreground">
          {art.lotes && art.lotes.length > 1
            ? `${art.lotes.length} lotes (FEFO: ${art.lotes[0].fVencimiento ? formatDate(art.lotes[0].fVencimiento) : 'S/F'})`
            : art.fVencimiento ? formatDate(art.fVencimiento) : '—'}
        </span>
      </TableCell>
    </TableRow>
  )
}

/** Card móvil de la tabla de ajustes. */
function ArticuloCard({ art, cantidad, onCantidad }: {
  art: StockEnUbicacion
  cantidad: string
  onCantidad: (codigo: string, valor: string) => void
}) {
  const esInc = !!art.codigoInc
  const cantNum = parseFloat(cantidad) || 0
  const excede = !esInc && cantNum > art.stock + 1e-9
  const queda = esInc ? art.stock : Math.round(Math.max(art.stock - Math.min(cantNum, art.stock), 0) * 1000) / 1000
  return (
    <div className={`rounded-xl border-2 p-3 space-y-2.5 ${
      esInc
        ? 'border-amber-200 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/10'
        : excede
          ? 'border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60'
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono font-bold text-sm text-slate-800 dark:text-slate-200 truncate">{art.codigo}</p>
          <p className="text-[11px] text-muted-foreground truncate">{art.descripcion}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-muted-foreground">Stock</p>
          <p className="font-bold text-base text-slate-800 dark:text-slate-100">{art.stock} <span className="text-[10px] font-normal">{art.un}</span></p>
        </div>
      </div>
      {esInc ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> INC — queda en origen (no se mueve en bloque)
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="any"
              min="0"
              value={cantidad}
              onChange={(e) => onCantidad(art.codigo, e.target.value)}
              className="h-9 flex-1 text-center font-bold"
              aria-label={`Cantidad a trasladar de ${art.codigo}`}
            />
            <Button variant="outline" size="sm" className="h-9 px-2 text-[11px] font-semibold border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              onClick={() => onCantidad(art.codigo, String(art.stock))}>
              Todo
            </Button>
            <Button variant="outline" size="sm" className="h-9 px-2 text-[11px] font-semibold"
              onClick={() => onCantidad(art.codigo, '0')}>
              Nada
            </Button>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">
              {art.fVencimiento ? <>Venc: {formatDate(art.fVencimiento)}</> : 'Sin vencimiento'}
              {art.lotes && art.lotes.length > 1 && ` · ${art.lotes.length} lotes`}
            </span>
            <span className={queda === 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-muted-foreground'}>
              queda {queda} {art.un} en origen
            </span>
          </div>
          {excede && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
              ⚠ Físicamente hay más: se registrará ingreso de ajuste de {Math.round((cantNum - art.stock) * 1000) / 1000} {art.un} en origen.
            </p>
          )}
        </>
      )}
    </div>
  )
}
