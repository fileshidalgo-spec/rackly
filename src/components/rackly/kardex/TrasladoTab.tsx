'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  fetchMovimientos,
  trasladarMovimiento,
  stockEnUbicacion,
  addMovimiento,
  calcularLotesRemanentes,
  type Movimiento,
  type StockEnUbicacion,
} from '@/lib/rackly/kardex'
import { calcularTurno } from '@/lib/rackly/turno'
import { BLOQUES, PISOS, torresDeBloque, posicionesDeBloque } from '@/lib/rackly/ubicaciones'
import { useAuth } from '@/hooks/useAuth'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { detectarRqParaSalida, type RqSalidaDetectada } from '@/lib/rackly/rq-contexto-salida'
import { RqSalidaConfirmador } from '@/components/rackly/atencion/RqSalidaConfirmador'
import { CatalogoSearchInput } from './CatalogoSearchInput'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'

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
import { Loader2, ArrowRightLeft, PackageSearch, AlertTriangle, ArrowUpFromLine, Package, MapPin, TriangleAlert, CheckCircle2 } from 'lucide-react'
import { formatDate, isExpired, isExpiringSoon, extractError, isInsufficientStockError } from '@/lib/utils'
import type { CatalogoItem } from '@/lib/rackly/catalogo'

type LocStock = {
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  descripcion: string
  un: string
  fVencimiento: string
  codigo: string
  proveedor?: string
  codigoInc?: string
  /** Código de lote físico (trazabilidad) de este grupo de fecha, si es único/se lista */
  loteFisico?: string
  /** Stock TOTAL de la posición (todos los lotes). Solo se llena en la primera fila de cada posición. */
  stockTotalPos?: number
}

/** Clave de origen que DISTINGUE LOTES: dos lotes de la misma posición son filas
 *  distintas. Antes la clave era solo la posición y `find()` resolvía siempre al
 *  primer lote (FEFO): al clickear el lote N se trasladaba el lote 1 con su fecha. */
function makeOriginKey(l: { bloque: string; torre: string; piso: string; posicion: string; fVencimiento?: string }): string {
  return `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}::${l.fVencimiento || 'SF'}`
}

export function TrasladoTab() {
  const { perfil } = useAuth()

  // ── Atención a Línea (RQ): FIX auditoría 2026-10-22 — la salida desde el
  // alerta de destino ocupado también ofrece el registro en la RQ (sin contexto
  // RQ el confirmador no aparece jamás; es regularización pura).
  const [rqConfirmer, setRqConfirmer] = useState<RqSalidaDetectada | null>(null)

  const [step, setStep] = useState<1 | 2>(1)
  const [codigo, setCodigo] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [un, setUn] = useState('')
  // locations ahora se calcula con useMemo (más abajo), reactivo a movs y codigo
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null)
  const [trasladoTotal, setTrasladoTotal] = useState(true)
  const [destBloque, setDestBloque] = useState('')
  const [destTorre, setDestTorre] = useState('')
  const [destPiso, setDestPiso] = useState('')
  const [destPos, setDestPos] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [destinoOcupado, setDestinoOcupado] = useState<StockEnUbicacion[]>([])
  const [salidaBusy, setSalidaBusy] = useState<string | null>(null)
  const [salidaParcialCant, setSalidaParcialCant] = useState<Record<string, string>>({})
  const [salidaParcialTotal, setSalidaParcialTotal] = useState<Record<string, boolean>>({})
  // Lote elegido por item para la salida en destino (FEFO pre-marcado, editable)
  const [salidaParcialLote, setSalidaParcialLote] = useState<Record<string, string>>({})
  const [corregirDiferencia, setCorregirDiferencia] = useState(false)

  const [movs, setMovs] = useState<Movimiento[]>([])

  useMovimientosRealtime(setMovs)

  // NOTA: el early-return de carga se hace DESPUÉS de todos los hooks (más abajo),
  // para no violar las Rules of Hooks (antes los hooks condicionales provocaban
  // error latente de 'Rendered more hooks than during the previous render').

  function handleCatalogoPick(item: CatalogoItem) {
    setCodigo(item.codigo)
    setDescripcion(item.descripcion)
    setUn(item.un)
    setStep(1)
    setSelectedOrigin(null)
  }

  // Recalcular ubicaciones reactivamente cuando cambian movs o codigo.
  // UNA FILA POR LOTE: la misma semántica de Salidas — el traslado saca EXACTAMENTE
  // del lote elegido (su fecha viaja al destino). stockTotalPos = total de la posición
  // (todos los lotes) y se usa para los ajustes automáticos (saldo / corrección).
  // EXCLUYE movimientos INC del cálculo (igual que OcupaciónTab).
  const locations = useMemo(() => {
    if (!codigo) return []
    const code = codigo.toUpperCase()
    const locMap = new Map<string, {
      bloque: string; torre: string; piso: string; posicion: string;
      codigo: string; descripcion: string; un: string; proveedor?: string;
      ingresos: Map<string, number>
      salidas: Array<{ venc: string; qty: number }>
      lotesFis: Map<string, Set<string>>  // códigos de lote físicos por fecha (trazabilidad)
    }>()
    const relevant = movs.filter((m) => m.codigo === code && !m.codigoInc)
    const POS_TYPES = ['ingreso', 'devolucion', 'traslado', 'stock_inicial']
    for (const m of relevant) {
      const qty = m.cantidad
      if (isNaN(qty) || !isFinite(qty) || qty <= 0) continue
      const posKey = `${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      let cur = locMap.get(posKey)
      if (!cur) {
        cur = {
          bloque: m.bloque, torre: m.torre, piso: m.piso, posicion: m.posicion,
          codigo: m.codigo, descripcion: m.descripcion, un: m.un, proveedor: m.proveedor,
          ingresos: new Map(), salidas: [], lotesFis: new Map(),
        }
        locMap.set(posKey, cur)
      }
      if (!cur.proveedor && m.proveedor) cur.proveedor = m.proveedor
      const venc = m.fVencimiento || ''
      if (POS_TYPES.includes(m.tipo)) {
        cur.ingresos.set(venc, (cur.ingresos.get(venc) ?? 0) + qty)
        // Registrar el código de lote físico si el ingreso lo trajo
        if (m.lote) {
          const set = cur.lotesFis.get(venc) ?? new Set<string>()
          set.add(m.lote)
          cur.lotesFis.set(venc, set)
        }
      } else {
        cur.salidas.push({ venc, qty })
      }
    }
    const rows: LocStock[] = []
    for (const [, lp] of locMap) {
      const remanentes = calcularLotesRemanentes(lp.ingresos, lp.salidas)
      const totalPos = remanentes.reduce((s, l) => s + l.cantidad, 0)
      for (const lote of remanentes) {
        const fis = lp.lotesFis.get(lote.venc)
        rows.push({
          bloque: lp.bloque, torre: lp.torre, piso: lp.piso, posicion: lp.posicion,
          codigo: lp.codigo, descripcion: lp.descripcion, un: lp.un,
          stock: Math.round(lote.cantidad * 1000) / 1000,
          fVencimiento: lote.venc || '',
          loteFisico: fis && fis.size > 0 ? Array.from(fis).sort().join(', ') : undefined,
          proveedor: lp.proveedor,
          stockTotalPos: Math.round(totalPos * 1000) / 1000,
        })
      }
    }
    return rows.sort((a, b) => {
      // FEFO primero (con fecha), luego sin fecha, luego por ubicación
      const aHasDate = !!a.fVencimiento
      const bHasDate = !!b.fVencimiento
      if (aHasDate && bHasDate) return a.fVencimiento.localeCompare(b.fVencimiento)
      if (aHasDate && !bHasDate) return -1
      if (!aHasDate && bHasDate) return 1
      const aB = parseInt(a.bloque, 10) || 0
      const bB = parseInt(b.bloque, 10) || 0
      if (aB !== bB) return aB - bB
      const aT = parseInt(a.torre, 10) || 0
      const bT = parseInt(b.torre, 10) || 0
      if (aT !== bT) return aT - bT
      const aP = parseInt(a.piso, 10) || 0
      const bP = parseInt(b.piso, 10) || 0
      if (aP !== bP) return aP - bP
      const aPos = parseInt(a.posicion, 10) || 0
      const bPos = parseInt(b.posicion, 10) || 0
      return aPos - bPos
    })
  }, [movs, codigo])

  // Limpiar selectedOrigin si la ubicación ya no existe en locations
  useEffect(() => {
    if (selectedOrigin && !locations.find((l) => makeOriginKey(l) === selectedOrigin)) {
      setSelectedOrigin(null)
    }
  }, [locations, selectedOrigin])

  // Early-return de carga: DESPUÉS de todos los hooks (Rules of Hooks)
  if (!perfil) return <div className="p-4 text-muted-foreground animate-pulse">Cargando...</div>

  const origin = locations.find((l) => makeOriginKey(l) === selectedOrigin)

  const qtyNum = parseFloat(qty) || 0
  // Total de la POSICIÓN (todos los lotes): base para los ajustes automáticos.
  // origin.stock = stock del LOTE elegido (fila seleccionada).
  const originTotal = origin?.stockTotalPos ?? origin?.stock ?? 0
  const saldoRestante = origin ? originTotal - qtyNum : 0
  const excedeStock = origin ? qtyNum > originTotal : false
  const faltaStock = origin ? qtyNum > 0 && qtyNum < originTotal : false
  const diferencia = origin ? qtyNum - originTotal : 0
  const trasladandoLoteCompleto = origin ? Math.abs(qtyNum - origin.stock) < 1e-9 : false
  // Ajuste automático: se activa cuando qty > stock (siempre), o cuando qty < stock Y el usuario elige corregir
  const ajusteActivo = excedeStock || (faltaStock && corregirDiferencia)

  // FIX auditoría 2026-10-21 (P3): redondeo anti-polvo flotante (30.78 - 0.1 → 30.679999...)
  const round3 = (n: number) => Math.round(n * 1000) / 1000

  async function handleConfirm() {
    if (!origin) return
    // Comparar POSICIÓN base (sin sufijo de lote) contra el destino: origen y
    // destino no pueden ser la misma posición aunque el lote se distinga.
    const originBase = `${origin.bloque}-${origin.torre}-${origin.piso}-${origin.posicion}`
    const destKey = `${destBloque}-${destTorre}-${destPiso || '1'}-${destPos}`
    if (originBase === destKey) {
      toast.error('El destino no puede ser igual al origen')
      return
    }
    if (qtyNum <= 0) {
      toast.error('Cantidad inválida')
      return
    }
    // Verificar si destino está ocupado
    try {
      const destStock = await stockEnUbicacion(destBloque, destTorre, destPiso || '1', destPos)
      // Fila-marker de error: la consulta falló — no hay datos confiables del destino
      if (destStock.length > 0 && '_error' in destStock[0] && destStock[0]._error) {
        toast.warning('No se pudo verificar si el destino está ocupado. Revise manualmente antes de confirmar.', { duration: 6000 })
        setDestinoOcupado([])
        setSalidaParcialLote({})
        setSalidaParcialCant({})
        setSalidaParcialTotal({})
        setConfirm(true)
        return
      }
      setDestinoOcupado(destStock)
      // Reset completo del estado de salidas parciales: antes solo se reseteaba
      // salidaParcialLote y las cantidades/flag "Total" de un destino anterior
      // reaparecían "fantasma" para otro destino con el mismo producto+lote
      setSalidaParcialLote({})
      setSalidaParcialCant({})
      setSalidaParcialTotal({})
    } catch {
      // Si falla la verificación, avisar pero permitir continuar
      toast.warning('No se pudo verificar si el destino está ocupado. Revise manualmente antes de confirmar.', { duration: 6000 })
      setDestinoOcupado([])
      setSalidaParcialLote({})
      setSalidaParcialCant({})
      setSalidaParcialTotal({})
    }
    setConfirm(true)
  }

  // Dar salida a un producto desde el alerta de destino ocupado (soporta parcial/total)
  async function handleSalidaDesdeAlerta(stockItem: StockEnUbicacion) {
    if (!perfil) return
    // FIX auditoría 2026-10-21 (P3): incluir codigoInc en la clave — sin él, la
    // fila normal y la fila INC del mismo código compartían selector/input.
    const itemKey = `${stockItem.codigo}-${stockItem.codigoInc ?? ''}-${stockItem.fVencimiento || ''}`
    const isTotal = salidaParcialTotal[itemKey] === true
    const cantStr = salidaParcialCant[itemKey] || ''
    const cantNum = isTotal ? stockItem.stock : parseFloat(cantStr)
    if (isNaN(cantNum) || cantNum <= 0) { toast.error('Cantidad inválida'); return }
    if (cantNum > stockItem.stock) { toast.error(`Máximo: ${stockItem.stock} ${stockItem.un}`); return }
    // Lote ELEGIDO (FEFO pre-marcado): la salida descuenta EXACTAMENTE ese lote
    const fvElegido = salidaParcialLote[itemKey] ?? (stockItem.fVencimiento || '')
    // FIX auditoría 2026-10-21 (P3): si el usuario eligió un lote concreto,
    // validar contra el SALDO DE ESE LOTE (no contra el total de la posición):
    // la UI promete "la salida descuenta exactamente ese lote".
    if (!isTotal && salidaParcialLote[itemKey] !== undefined && stockItem.lotes && stockItem.lotes.length > 1) {
      const loteSel = stockItem.lotes.find((l) => (l.fVencimiento || '') === fvElegido)
      if (loteSel && cantNum > loteSel.cantidad + 0.001) {
        toast.error(`El lote elegido tiene ${loteSel.cantidad} ${stockItem.un}. Máximo desde ese lote: ${loteSel.cantidad}`)
        return
      }
    }
    setSalidaBusy(itemKey)
    try {
      await addMovimiento({
        tipo: 'salida',
        bloque: destBloque,
        torre: destTorre,
        piso: destPiso || '1',
        posicion: destPos,
        codigo: stockItem.codigo,
        descripcion: stockItem.descripcion,
        un: stockItem.un,
        cantidad: cantNum,
        fVencimiento: fvElegido,
        turno: calcularTurno(),
        usuarioId: perfil.id,
        usuarioNombre: perfil.nombre,
        usuarioCorreo: perfil.correo,
        proveedor: stockItem.proveedor,
        codigoInc: stockItem.codigoInc || undefined,
      }, undefined, { refetch: false })
      toast.success(`Salida de ${cantNum} ${stockItem.un} de ${stockItem.codigo}`)
      // Atención a Línea (RQ): ofrecer registro si se llegó DESDE una RQ
      setRqConfirmer(detectarRqParaSalida([{ codigo: stockItem.codigo, cantidad: cantNum, unidad: stockItem.un }]))
      // FIX auditoría 2026-10-21 (P3): limpiar la cantidad digitada — sin esto,
      // un segundo clic repetía la salida sin re-tipear.
      setSalidaParcialCant((prev) => ({ ...prev, [itemKey]: '' }))
      setMovs(await fetchMovimientos())
      const updated = await stockEnUbicacion(destBloque, destTorre, destPiso || '1', destPos)
      // Validar fila-marker _error (como IngresoForm): sin esto se mostraba una
      // fila fantasma con código vacío y stock 0 cuando la consulta fallaba
      const consultaFallo = updated.length > 0 && '_error' in updated[0] && updated[0]._error
      if (consultaFallo) {
        toast.warning('No se pudo actualizar el stock del destino. Revise manualmente.', { duration: 6000 })
      } else {
        setDestinoOcupado(updated)
      }
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        toast.error('Stock insuficiente', {
          description: 'Otro usuario pudo haber modificado el stock mientras tú operabas. Los datos se han actualizado.',
          duration: 6000,
        })
      } else {
        toast.error('Error al dar salida', { description: extractError(err) })
      }
    } finally {
      setSalidaBusy(null)
    }
  }

  async function doTraslado() {
    if (!origin || !perfil) return
    setBusy(true)
    try {
      // ══ FIX auditoría 2026-10-21 (P1): TRASLADO LOTE-POR-LOTE ══
      // Antes TODO iba con la fecha del lote ELEGIDO: si la posición tenía
      // varios lotes, el destino recibía todas las unidades con la fecha del
      // lote seleccionado — el FEFO/vencimientos del destino quedaban
      // distorsionados de forma irreversible. Ahora la operación se parte en
      // una llamada por lote (cada una atómica y validada por la RPC).
      const baseKey = `${origin.bloque}-${origin.torre}-${origin.piso}-${origin.posicion}`
      const lotesPos = locations
        .filter((l) => `${l.bloque}-${l.torre}-${l.piso}-${l.posicion}` === baseKey && l.stock > 1e-9)

      type Llamada = { row: LocStock; cantidad: number; ajuste?: number }
      let llamadas: Llamada[] = []
      let fantasmaSalida = 0 // salida en origen para corregir diferencia (qty < total)

      const cantidadEfectiva = qtyNum || originTotal
      // FIX auditoría Task 20 (A-2): si la cantidad CABE en el lote que el
      // usuario seleccionó, se toma SOLO de ese lote. Antes cualquier parcial
      // distinto del stock del lote disparaba el reparto FEFO entre TODOS los
      // lotes (ignoraba la selección): pedías 10 del lote B (venc 2027-01) y
      // salían 10 del lote A (venc 2026-12) — el destino quedaba con la fecha
      // equivocada y el FEFO distorsionado de forma persistente.
      const cabeEnLoteElegido = cantidadEfectiva <= origin.stock + 1e-9
      const esMultiLote = lotesPos.length > 1 && !cabeEnLoteElegido

      if (!esMultiLote) {
        // Comportamiento original (posición con 1 lote, o cantidad que cabe en
        // el lote elegido): toda la cantidad sale del lote seleccionado.
        const cantidadFinal = qtyNum || originTotal
        llamadas = [{ row: origin, cantidad: cantidadFinal, ajuste: ajusteActivo ? round3(diferencia) : undefined }]
        if (faltaStock && !corregirDiferencia) fantasmaSalida = 0
      } else {
        // Reparto: PRIMERO el lote seleccionado (honra la elección del usuario),
        // luego el resto en orden FEFO (lotes con fecha primero, ya ordenados en locations)
        let restante = cantidadEfectiva
        const ordenLotes = [origin, ...lotesPos.filter((l) => l !== origin)]
        for (const lote of ordenLotes) {
          if (restante <= 1e-9) break
          const toma = Math.min(restante, lote.stock)
          if (toma > 1e-9) {
            llamadas.push({ row: lote, cantidad: round3(toma) })
            restante = round3(restante - toma)
          }
        }
        // Excedente físico sin registro: traslado con ajuste positivo en origen
        if (restante > 1e-9) {
          llamadas.push({ row: origin, cantidad: restante, ajuste: restante })
          restante = 0
        }
        // Diferencia a corregir: si el usuario quiere dejar la posición en 0,
        // lo que NO se trasladó sale en origen (stock fantasma)
        if (faltaStock && corregirDiferencia) {
          fantasmaSalida = round3(originTotal - (qtyNum || originTotal))
        }
      }

      // Ejecutar secuencialmente; si una llamada falla a mitad de camino se
      // informa EXACTAMENTE qué se trasladó y qué quedó pendiente.
      let hechas = 0
      for (const llamada of llamadas) {
        try {
          await trasladarMovimiento({
            codigo: origin.codigo,
            descripcion: origin.descripcion,
            un: origin.un,
            cantidad: llamada.cantidad,
            origen: {
              bloque: origin.bloque,
              torre: origin.torre,
              piso: origin.piso,
              posicion: origin.posicion,
            },
            destino: {
              bloque: destBloque,
              torre: destTorre,
              piso: destPiso || '1',
              posicion: destPos,
            },
            turno: calcularTurno(),
            usuarioId: perfil.id,
            usuarioNombre: perfil.nombre,
            usuarioCorreo: perfil.correo,
            // La fecha del LOTE de esta llamada viaja al destino (FEFO intacto)
            fVencimiento: llamada.row.fVencimiento || origin.fVencimiento,
            proveedor: origin.proveedor,
            codigoInc: origin.codigoInc,
            lote: llamada.row.loteFisico && !llamada.row.loteFisico.includes(',') ? llamada.row.loteFisico : undefined,
            cantidadAjuste: llamada.ajuste && Math.abs(llamada.ajuste) > 1e-9 ? llamada.ajuste : undefined,
          }, { refetch: false })
          hechas++
        } catch (callErr) {
          if (hechas === 0) throw callErr // nada se movió: error normal
          // Traslado PARCIAL: informar con precisión
          const pendientes = llamadas.slice(hechas).reduce((s, l) => s + l.cantidad, 0)
          toast.error(`Traslado PARCIAL: ${llamadas.slice(0, hechas).reduce((s, l) => s + l.cantidad, 0)} ${origin.un} llegaron al destino. NO se trasladaron ${round3(pendientes)} ${origin.un} — reintenta el traslado para completarlo.`, { duration: 10000 })
          setMovs(await fetchMovimientos())
          return
        }
      }

      // Salida fantasma en origen (corrección de diferencia, multi-lote)
      if (fantasmaSalida > 1e-9) {
        await addMovimiento({
          tipo: 'salida',
          bloque: origin.bloque, torre: origin.torre, piso: origin.piso, posicion: origin.posicion,
          codigo: origin.codigo, descripcion: origin.descripcion, un: origin.un,
          cantidad: fantasmaSalida,
          fVencimiento: origin.fVencimiento || '',
          turno: calcularTurno(),
          usuarioId: perfil.id, usuarioNombre: perfil.nombre, usuarioCorreo: perfil.correo,
          proveedor: origin.proveedor,
          codigoInc: origin.codigoInc,
        }, undefined, { refetch: false })
      }

      toast.success('Traslado registrado')
      if (esMultiLote) {
        toast.info(`Multi-lote: ${hechas} llamada(s), cada lote conservó su fecha de vencimiento en destino.`, { duration: 6000 })
      } else if (ajusteActivo) {
        if (excedeStock) {
          toast.info(`Ajuste automático: +${round3(Math.abs(diferencia))} ${origin.un} ingreso en origen (faltaba stock registrado)`, { duration: 6000 })
        } else if (corregirDiferencia) {
          toast.info(`Ajuste automático: -${round3(Math.abs(diferencia))} ${origin.un} salida en origen (se deja posición en 0)`, { duration: 6000 })
        }
      }
      if (faltaStock && !corregirDiferencia) {
        toast.info(`Queda un saldo de ${round3(saldoRestante)} ${origin.un} en la ubicación de origen`, { duration: 6000 })
      }
      setMovs(await fetchMovimientos())
      resetForm()
    } catch (err: unknown) {
      if (isInsufficientStockError(err)) {
        toast.error('Stock insuficiente en origen', {
          description: 'Otro usuario pudo haber modificado el stock mientras tú operabas. Los datos se han actualizado.',
          duration: 6000,
        })
      } else {
        toast.error('Error al trasladar', { description: extractError(err) })
      }
    } finally {
      setBusy(false)
      setConfirm(false)
      setDestinoOcupado([])
    }
  }

  function resetForm() {
    setCodigo('')
    setDescripcion('')
    setUn('')
    // locations se limpia automáticamente al poner codigo en '' (useMemo returns [])
    setSelectedOrigin(null)
    setTrasladoTotal(true)
    setCorregirDiferencia(false)
    setDestBloque('')
    setDestTorre('')
    setDestPiso('')
    setDestPos('')
    setQty('')
    setStep(1)
  }

  const destTorres = torresDeBloque(destBloque)
  const destPositions = posicionesDeBloque(destBloque)
  const destPisoSeleccionado = destPiso || '1'

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Busca un código, elige la ubicación de origen y destino. Confirma el traslado.
      </p>

      <CatalogoSearchInput
        onPick={handleCatalogoPick}
        value={codigo}
        onChange={(v) => {
          setCodigo(v)
          const cat = findCatalogoByCodigo(v)
          if (cat) handleCatalogoPick(cat)
        }}
      />

      {/* Info del producto buscado */}
      {codigo && descripcion && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
              <PackageSearch className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold text-sm text-blue-800 dark:text-blue-300">{codigo}</span>
                <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{un || '—'}</span>
                {locations[0]?.proveedor && (
                  <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold text-[10px]">
                    {locations[0].proveedor}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">{descripcion}</p>
            </div>
            <Badge variant="outline" className="border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-semibold">
              {locations.length} ubicacion{locations.length !== 1 ? 'es' : ''}
            </Badge>
          </div>
        </div>
      )}

      {locations.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">1. Selecciona ubicación de origen:</p>
            <p className="text-xs text-muted-foreground">y elige el tipo de traslado</p>
          </div>
          {/* ── Mobile: Cards con TODA la info visible ── */}
          <div className="sm:hidden space-y-3">
            {locations.map((loc) => {
              const key = makeOriginKey(loc)
              const isSelected = selectedOrigin === key
              return (
                <div
                  key={key}
                  onClick={() => {
                    setSelectedOrigin(key)
                    setTrasladoTotal(true)
                    setQty(String(loc.stock))
                    setStep(2)
                  }}
                  className={`rounded-xl border-2 p-3 space-y-2.5 cursor-pointer transition-all duration-200 ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30 shadow-md shadow-blue-500/10'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-blue-300 dark:hover:border-blue-700/50 hover:shadow-sm'
                  }`}
                >
                  {/* Fila 1: Ubicación completa + Stock */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-blue-500" />
                      <span className="font-mono font-bold text-sm text-slate-800 dark:text-slate-200">
                        B{loc.bloque} · T{loc.torre} · P{loc.piso} · Pos {loc.posicion}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded font-medium">{loc.un}</span>
                      <span className="font-bold text-base text-slate-800 dark:text-slate-100">{loc.stock}</span>
                    </div>
                  </div>

                  {/* Fila 2: Vencimiento + Proveedor */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {loc.fVencimiento ? (
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        isExpired(loc.fVencimiento)
                          ? 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800'
                          : isExpiringSoon(loc.fVencimiento, 15)
                            ? 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800'
                            : isExpiringSoon(loc.fVencimiento, 30)
                              ? 'bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:border-sky-800'
                              : 'bg-slate-50 text-muted-foreground border-slate-200 dark:bg-slate-800 dark:border-slate-600'
                      }`}>
                        Venc: {formatDate(loc.fVencimiento)}
                      </span>
                    ) : null}
                    {loc.proveedor ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800">
                        {loc.proveedor}
                      </span>
                    ) : null}
                    {loc.codigoInc && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 flex items-center gap-0.5">
                        <AlertTriangle className="w-3 h-3" /> {loc.codigoInc}
                      </span>
                    )}
                    {loc.loteFisico && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-50 text-cyan-700 border border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800" title="Código de lote físico">
                        Lote: {loc.loteFisico}
                      </span>
                    )}
                    {!loc.fVencimiento && !loc.proveedor && !loc.codigoInc && (
                      <span className="text-[10px] text-slate-400">Sin vencimiento · Sin proveedor</span>
                    )}
                  </div>

                  {/* Botones de acción */}
                  {isSelected ? (
                    <div className="flex items-center justify-center gap-1.5 pt-1 text-xs font-bold text-blue-700 dark:text-blue-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Lote seleccionado — Venc: {loc.fVencimiento ? formatDate(loc.fVencimiento) : 'S/F'}</span>
                    </div>
                  ) : (
                    <div className="flex gap-2 pt-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedOrigin(key)
                          setTrasladoTotal(true)
                          setQty(String(loc.stock))
                          setStep(2)
                        }}
                        className="flex-1 h-9 flex items-center justify-center gap-1.5 rounded-lg text-xs font-bold border-2 border-emerald-200 text-emerald-700 bg-emerald-50/50 hover:bg-emerald-100 active:bg-emerald-200 dark:border-emerald-700 dark:text-emerald-400 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50 transition-colors"
                      >
                        <Package className="h-3 w-3" />
                        Trasladar lote
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedOrigin(key)
                          setTrasladoTotal(false)
                          setQty('')
                          setStep(2)
                        }}
                        className="flex-1 h-9 flex items-center justify-center gap-1.5 rounded-lg text-xs font-bold border-2 border-sky-200 text-sky-700 bg-sky-50/50 hover:bg-sky-100 active:bg-sky-200 dark:border-sky-700 dark:text-sky-400 dark:bg-sky-950/30 dark:hover:bg-sky-950/50 transition-colors"
                      >
                        <ArrowUpFromLine className="h-3 w-3" />
                        Parcial
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Desktop: Tabla con scroll horizontal ── */}
          <div className="hidden sm:block overflow-x-auto rounded-xl border border-slate-200/60">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Bloque</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Torre</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center hidden sm:table-cell">Piso</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Pos.</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Stock</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden sm:table-cell">UN</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden md:table-cell">F. Vencimiento</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">Proveedor</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider hidden lg:table-cell">INC</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider text-center">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((loc) => {
                  const key = makeOriginKey(loc)
                  const isSelected = selectedOrigin === key
                  return (
                    <TableRow
                      key={key}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-blue-50/60 dark:bg-blue-950/30 border-l-4 border-l-blue-500'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-900/40'
                      }`}
                      onClick={() => {
                        setSelectedOrigin(key)
                        setTrasladoTotal(true)
                        setQty(String(loc.stock))
                        setStep(2)
                      }}
                    >
                      <TableCell className="text-center font-medium text-slate-700">{loc.bloque}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700">{loc.torre}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700 hidden sm:table-cell">{loc.piso}</TableCell>
                      <TableCell className="text-center font-medium text-slate-700">{loc.posicion}</TableCell>
                      <TableCell className="text-right font-bold text-slate-800">{loc.stock}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary" className="font-medium text-xs">{loc.un}</Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {loc.fVencimiento ? (
                          <span className={`text-sm font-medium ${
                            isExpired(loc.fVencimiento)
                              ? 'text-red-600 dark:text-red-400 font-semibold'
                              : isExpiringSoon(loc.fVencimiento, 15)
                                ? 'text-orange-600 dark:text-orange-400'
                                : isExpiringSoon(loc.fVencimiento, 30)
                                  ? 'text-sky-600 dark:text-sky-400'
                                  : 'text-muted-foreground'
                          }`}>{formatDate(loc.fVencimiento)}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        {loc.loteFisico && (
                          <div className="text-[10px] font-semibold text-cyan-700 dark:text-cyan-300" title="Código de lote físico">Lote: {loc.loteFisico}</div>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {loc.proveedor ? (
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold text-xs">
                            {loc.proveedor}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {loc.codigoInc ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 font-semibold text-xs">
                            <AlertTriangle className="w-3 h-3 mr-0.5" /> {loc.codigoInc}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {isSelected ? (
                          <div className="flex items-center justify-center gap-1 text-xs font-bold text-blue-700 dark:text-blue-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>{trasladoTotal ? 'Total' : 'Parcial'}</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2.5 text-[11px] font-semibold gap-1 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedOrigin(key)
                                setTrasladoTotal(true)
                                setQty(String(loc.stock))
                                setStep(2)
                              }}
                            >
                              <Package className="h-3 w-3" />
                              Lote
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2.5 text-[11px] font-semibold gap-1 border-sky-200 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-800 dark:text-sky-400 dark:hover:bg-sky-950/50"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedOrigin(key)
                                setTrasladoTotal(false)
                                setQty('')
                                setStep(2)
                              }}
                            >
                              <ArrowUpFromLine className="h-3 w-3" />
                              Parcial
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Haz clic en una fila o pulsa "Seleccionar" para elegir el origen del traslado.
          </p>
        </>
      )}

      {origin && step === 2 && (
        <div className="space-y-3 p-4 border rounded-lg">
          {/* Indicador del tipo de traslado seleccionado */}
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">2. Elige ubicación de destino:</p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { setTrasladoTotal(true); setQty(String(originTotal)) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  trasladoTotal
                    ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-400 shadow-sm'
                    : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                }`}
              >
                <Package className="h-3 w-3 inline-block mr-1 -mt-0.5" />
                Traslado Total
              </button>
              <button
                onClick={() => { setTrasladoTotal(false); setQty('') }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  !trasladoTotal
                    ? 'bg-sky-100 text-sky-800 border-2 border-sky-400 shadow-sm dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-600'
                    : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                }`}
              >
                <ArrowUpFromLine className="h-3 w-3 inline-block mr-1 -mt-0.5" />
                Traslado Parcial
              </button>
            </div>
          </div>

          {/* Info del tipo de traslado */}
          <div className={`rounded-lg border p-2.5 flex items-center gap-2.5 ${
            trasladoTotal
              ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20'
              : 'border-sky-200 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/20'
          }`}>
            {trasladoTotal ? (
              <>
                <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
                  <Package className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  <strong>Traslado Total:</strong> Se moverán <strong>todas las {originTotal} {origin.un}</strong> (todos los lotes de la posición) al destino.
                  La ubicación de origen quedará con <strong>stock 0</strong>.
                </p>
              </>
            ) : (
              <>
                <div className="w-7 h-7 rounded-full bg-sky-100 dark:bg-sky-900/40 flex items-center justify-center shrink-0">
                  <ArrowUpFromLine className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                </div>
                <p className="text-xs text-sky-700 dark:text-sky-300">
                  <strong>Traslado Parcial:</strong> Ingresa la cantidad que deseas mover.
                  El <strong>saldo restante ({originTotal} - cantidad)</strong> se quedará en la ubicación de origen.
                  Si la cantidad cabe en el lote seleccionado, sale solo de ese lote; si lo excede, el resto sale FEFO de los demás lotes.
                </p>
              </>
            )}
          </div>

          {/* Lote elegido en origen */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20 p-2.5 flex items-center justify-between gap-2">
            <span className="text-xs text-amber-700 dark:text-amber-300 font-medium">
              Lote en origen: {origin.fVencimiento ? `Venc ${formatDate(origin.fVencimiento)}` : 'Sin fecha (S/F)'}
              {origin.loteFisico && <span className="text-cyan-700 dark:text-cyan-300"> · Lote: {origin.loteFisico}</span>}
            </span>
            <span className="text-xs text-slate-600 dark:text-slate-300">
              Stock del lote: <strong>{origin.stock} {origin.un}</strong>
              {originTotal !== origin.stock && <span className="text-slate-400"> · Total posición: {originTotal}</span>}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label>Bloque</Label>
              <Select value={destBloque} onValueChange={(v) => { setDestBloque(v); setDestTorre(''); setDestPos('') }}>
                <SelectTrigger><SelectValue placeholder="Bloque" /></SelectTrigger>
                <SelectContent>
                  {BLOQUES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Torre</Label>
              <Select value={destTorre} onValueChange={setDestTorre} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Torre" /></SelectTrigger>
                <SelectContent>
                  {destTorres.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Piso</Label>
              <Select value={destPiso} onValueChange={setDestPiso} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Piso" /></SelectTrigger>
                <SelectContent>
                  {PISOS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Posición</Label>
              <Select value={destPos} onValueChange={setDestPos} disabled={!destBloque}>
                <SelectTrigger><SelectValue placeholder="Pos" /></SelectTrigger>
                <SelectContent>
                  {destPositions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>{trasladoTotal ? 'Cantidad a trasladar (stock total)' : 'Cantidad a trasladar'}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="any"
                value={qty}
                onChange={(e) => { setQty(e.target.value); setCorregirDiferencia(false) }}
                disabled={trasladoTotal}
                placeholder={`Stock disponible: ${originTotal} ${origin.un}`}
                className={trasladoTotal ? 'bg-emerald-50 dark:bg-emerald-950/20 font-bold' : ''}
              />
              {!trasladoTotal && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setQty(String(originTotal)); setCorregirDiferencia(false) }}
                  className="shrink-0 h-9 px-2.5 text-xs font-semibold border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
                >
                  Max: {originTotal}
                </Button>
              )}
            </div>

            {/* Indicadores debajo del input de cantidad.
                FIX auditoría 2026-10-16: el texto decía "quedará vacía (0)" con
                solo activar el modo Total, pero en posiciones multi-lote el
                modo Total mueve el LOTE elegido — la posición conserva el resto. */}
            {trasladoTotal && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                {qtyNum === 0 || qtyNum >= originTotal
                  ? 'Se trasladará todo el stock. La ubicación quedará vacía (0).'
                  : `Se trasladará el lote completo (${qtyNum} ${origin?.un ?? ''}). Quedará un saldo de ${saldoRestante} ${origin?.un ?? ''} en la ubicación.`}
              </p>
            )}

            {!trasladoTotal && qtyNum > 0 && (
              <div className="space-y-1.5 pt-1">
                {/* Caso 1: Cantidad exacta (igual al stock del lote) */}
                {trasladandoLoteCompleto && (
                  <div className="flex items-center gap-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {originTotal === origin.stock
                        ? 'Cantidad exacta — Se trasladará todo el stock. Origen quedará en 0.'
                        : `Cantidad exacta del lote (${origin.stock} ${origin.un}). Los demás lotes (${originTotal - origin.stock} ${origin.un}) quedan en origen.`}
                    </span>
                  </div>
                )}

                {/* Caso 2: Cantidad menor al stock — OPCIÓN: dejar saldo o corregir */}
                {faltaStock && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/20 p-2.5 space-y-2">
                    <p className="text-xs text-sky-700 dark:text-sky-300 font-medium">
                      Cantidad menor al stock total ({qtyNum} de {originTotal} {origin.un}).
                      Diferencia: <strong>{saldoRestante} {origin.un}</strong>
                    </p>
                    <p className="text-[11px] text-muted-foreground font-medium">¿Qué deseas hacer con la diferencia?</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCorregirDiferencia(false)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border-2 ${
                          !corregirDiferencia
                            ? 'bg-sky-100 text-sky-800 border-sky-400 shadow-sm dark:bg-sky-900/50 dark:text-sky-200 dark:border-sky-500'
                            : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                        }`}
                      >
                        <Package className="h-3 w-3" />
                        Dejar saldo
                      </button>
                      <button
                        type="button"
                        onClick={() => setCorregirDiferencia(true)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border-2 ${
                          corregirDiferencia
                            ? 'bg-orange-100 text-orange-800 border-orange-400 shadow-sm dark:bg-orange-900/40 dark:text-orange-200 dark:border-orange-500'
                            : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700'
                        }`}
                      >
                        <ArrowUpFromLine className="h-3 w-3" />
                        Corregir (salida)
                      </button>
                    </div>
                    {!corregirDiferencia ? (
                      <p className="text-[11px] text-sky-600/80 dark:text-sky-400/80 italic">
                        <Package className="h-3 w-3 inline-block -mt-0.5 mr-0.5" />
                        La posición de origen quedará con un <strong>saldo de {saldoRestante} {origin.un}</strong>.
                      </p>
                    ) : (
                      <div className="rounded-md border border-orange-200 bg-orange-50/80 dark:border-orange-800 dark:bg-orange-950/30 p-2">
                        <p className="text-[11px] text-orange-700 dark:text-orange-300">
                          <AlertTriangle className="h-3 w-3 inline-block -mt-0.5 mr-0.5" />
                          Se registrará una <strong>salida de ajuste de {saldoRestante} {origin.un}</strong> en el origen.
                          La posición quedará en <strong>0</strong>. Útil cuando el producto físico ya no está ahí.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Caso 3: Cantidad mayor al stock — SIEMPRE auto-ajusta con ingreso */}
                {excedeStock && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20 p-2.5 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                      <div className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                        <p className="font-medium">
                          Cantidad mayor al stock registrado ({qtyNum} de {originTotal} {origin.un}).
                        </p>
                        <p>
                          Diferencia: <strong>+{Math.abs(diferencia)} {origin.un}</strong> (faltaba en el sistema)
                        </p>
                        <p className="text-[11px] opacity-90">
                          Se registrará un <strong>ingreso de ajuste de {Math.abs(diferencia)} {origin.un}</strong> en el origen
                          para cubrir lo que falta. La posición quedará en <strong>0</strong>. Útil cuando un operador dejó
                          saldo adicional no registrado.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] font-semibold pt-0.5">
                      <Badge variant="outline" className="border-amber-300 text-amber-700 dark:text-amber-300">
                        Origen: {originTotal} +{Math.abs(diferencia)} = {qtyNum} {origin.un}
                      </Badge>
                      <Badge variant="outline" className="border-blue-300 text-blue-700 dark:text-blue-300">
                        Destino: +{qtyNum} {origin.un}
                      </Badge>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <Button onClick={handleConfirm} disabled={!destBloque || !destTorre || !destPiso || !destPos || qtyNum <= 0} className="gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Confirmar traslado
          </Button>
        </div>
      )}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg p-0 max-h-[85vh] flex flex-col overflow-hidden">
          {/* Header con gradiente */}
          <div className={`px-4 sm:px-6 py-5 text-white shrink-0 ${
            destinoOcupado.length > 0
              ? 'bg-gradient-to-r from-orange-500 via-red-500 to-red-600'
              : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                {destinoOcupado.length > 0 ? (
                  <TriangleAlert className="h-6 w-6 text-white" />
                ) : (
                  <ArrowRightLeft className="h-6 w-6 text-white" />
                )}
              </div>
              <div>
                <AlertDialogTitle className="text-lg font-bold text-white m-0">
                  {destinoOcupado.length > 0 ? 'Destino Ocupado' : 'Confirmar Traslado'}
                </AlertDialogTitle>
                <AlertDialogDescription className={`text-sm mt-0.5 ${
                  destinoOcupado.length > 0 ? 'text-orange-100' : 'text-blue-100'
                }`}>
                  {destinoOcupado.length > 0
                    ? 'El destino ya tiene stock. Revisa o retira productos antes de trasladar.'
                    : trasladoTotal
                      ? (qtyNum === 0 || qtyNum >= originTotal
                          ? `Traslado total de ${qty} ${origin?.un}. La ubicación de origen quedará vacía.`
                          : `Traslado del lote completo de ${qty} ${origin?.un}. Quedará saldo de ${saldoRestante} ${origin?.un} en origen.`)
                      : excedeStock
                        ? `Traslado de ${qty} ${origin?.un} (+${Math.abs(diferencia)} ajuste ingreso). Origen quedará en 0.`
                        : corregirDiferencia
                          ? `Traslado de ${qty} ${origin?.un} (-${saldoRestante} ajuste salida). Origen quedará en 0.`
                          : `Traslado parcial de ${qty} ${origin?.un}. Quedará saldo de ${saldoRestante} ${origin?.un} en origen.`}
                </AlertDialogDescription>
              </div>
            </div>
          </div>

          <AlertDialogDescription className="sr-only">
            Confirmación de traslado
          </AlertDialogDescription>

          {/* Contenido scrolleable */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {/* Ruta origen → destino */}
            <div className="px-4 sm:px-6 pt-4 pb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Ruta del traslado</p>
              <div className="flex items-center gap-2 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2.5">
                <MapPin className="h-4 w-4 text-blue-500 flex-shrink-0" />
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300 truncate min-w-0">
                  B-{origin?.bloque} T-{origin?.torre} P-{origin?.piso} Pos-{origin?.posicion}
                  <span className="mx-2 text-indigo-500 font-bold">→</span>
                  B-{destBloque} T-{destTorre} P-{destPisoSeleccionado} Pos-{destPos}
                </span>
              </div>
            </div>

            {/* Producto a trasladar */}
            <div className="px-4 sm:px-6 pb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Producto a trasladar</p>
              <div className="rounded-xl border-2 border-dashed border-blue-300 dark:border-blue-700 bg-blue-50/60 dark:bg-blue-950/20 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-sm text-blue-800 dark:text-blue-300">{origin?.codigo}</span>
                    <span className="text-[10px] text-blue-700/60 dark:text-blue-400/60 bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 rounded">{origin?.un || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <ArrowRightLeft className="h-3.5 w-3.5 text-blue-600" />
                    <span className="font-bold text-blue-700 dark:text-blue-300">{qty} {origin?.un}</span>
                  </div>
                </div>
                {origin?.descripcion && (
                  <p className="text-xs text-blue-700/70 dark:text-blue-400/70 truncate">{origin?.descripcion}</p>
                )}
                {origin?.fVencimiento && (
                  <p className="text-[10px] text-muted-foreground">Venc: {origin?.fVencimiento}</p>
                )}
              </div>
            </div>

            {/* Tipo de traslado y saldo */}
            <div className="px-4 sm:px-6 pb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={`text-xs font-bold ${
                  trasladoTotal
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700'
                    : excedeStock
                      ? 'bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-700'
                      : corregirDiferencia
                        ? 'bg-orange-100 text-orange-800 border border-orange-300 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-700'
                        : 'bg-sky-100 text-sky-800 border border-sky-300 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-700'
                }`}>
                  {trasladoTotal
                    ? <><Package className="h-3 w-3 mr-1" /> Traslado Total</>
                    : excedeStock
                      ? <><AlertTriangle className="h-3 w-3 mr-1" /> Traslado con Ajuste (Ingreso +{Math.abs(diferencia)})</>
                      : corregirDiferencia
                        ? <><ArrowUpFromLine className="h-3 w-3 mr-1" /> Traslado Parcial + Salida ({saldoRestante})</>
                        : <><ArrowUpFromLine className="h-3 w-3 mr-1" /> Traslado Parcial</>
                  }
                </Badge>
                {!trasladoTotal && !excedeStock && !corregirDiferencia && qtyNum > 0 && origin && qtyNum < originTotal && (
                  <Badge variant="outline" className="border-sky-300 text-sky-700 dark:text-sky-300 text-xs font-semibold">
                    Saldo en origen: {saldoRestante} {origin?.un}
                  </Badge>
                )}
                {(trasladoTotal || corregirDiferencia || excedeStock) && (
                  <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                    Origen quedará en 0
                  </Badge>
                )}
              </div>
            </div>

            {/* Ajuste automático */}
            {ajusteActivo && (
              <div className="px-4 sm:px-6 pb-3">
                {/* FIX auditoría 2026-10-16: faltaba `${` — el condicional era
                    texto literal y los estilos de alerta/ajuste nunca aplicaban. */}
                <div className={`rounded-xl border p-3 ${
                  excedeStock
                    ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                    : 'border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-800 text-sky-700 dark:text-sky-300'
                }`}>
                  <p className="font-medium mb-1">
                    <AlertTriangle className="h-4 w-4 inline-block mr-1" />
                    Ajuste automático: {diferencia > 0 ? '+' : ''}{diferencia} {origin?.un} en origen
                  </p>
                  <p className="text-xs">
                    {excedeStock
                      ? `Se registrará un ingreso de ${Math.abs(diferencia)} ${origin?.un} en el origen.`
                      : `Se registrará una salida de ${Math.abs(diferencia)} ${origin?.un} en el origen.`}
                  </p>
                </div>
              </div>
            )}

            {/* Separador si hay productos en destino */}
            {destinoOcupado.length > 0 && (
              <div className="px-4 sm:px-6 pb-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Stock actual en el destino</span>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent" />
                </div>
              </div>
            )}

            {/* Productos existentes en destino */}
            {destinoOcupado.length > 0 && (
              <div className="px-4 sm:px-6 pb-4">
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-2">
                  {destinoOcupado.length} producto{destinoOcupado.length !== 1 ? 's' : ''} encontrado{destinoOcupado.length !== 1 ? 's' : ''}
                </p>
                <div className="space-y-2">
                  {destinoOcupado.map((s, i) => (
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
                            {s.fVencimiento && !s.lotes && <span>Venc: {s.fVencimiento}</span>}
                            {s.loteFisico && <span className="font-semibold text-cyan-700 dark:text-cyan-300">Lote: {s.loteFisico}</span>}
                            {s.lotes && s.lotes.length > 1 && (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">
                                {s.lotes.length} lotes: {s.lotes.map(l => l.fVencimiento || 'S/F').join(', ')}
                              </span>
                            )}
                            {s.proveedor && <span>Prov: {s.proveedor}</span>}
                          </div>
                          {/* Selector de LOTE a descontar en destino (FEFO pre-marcado, editable) */}
                          {s.lotes && s.lotes.length > 1 && (() => {
                            // FIX auditoría 2026-10-21 (P3): incluir codigoInc en la clave
                            const itemKey = `${s.codigo}-${s.codigoInc ?? ''}-${s.fVencimiento || ''}`
                            const selFv = salidaParcialLote[itemKey] ?? (s.fVencimiento || '')
                            const loteSel = s.lotes.find(l => (l.fVencimiento || '') === selFv)
                            return (
                              <div className="mt-1.5 flex items-center gap-2">
                                <span className="text-[10px] text-slate-500 shrink-0">Lote a salir:</span>
                                <select
                                  value={selFv}
                                  onChange={(e) => setSalidaParcialLote(prev => ({ ...prev, [itemKey]: e.target.value }))}
                                  className="h-7 text-[11px] rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-1.5"
                                >
                                  {s.lotes.map((l, li) => (
                                    <option key={li} value={l.fVencimiento || ''}>
                                      {l.fVencimiento ? `Venc: ${l.fVencimiento} (${l.cantidad})` : `Sin fecha (${l.cantidad})`}
                                    </option>
                                  ))}
                                </select>
                                {loteSel && (
                                  <span className="text-[10px] text-slate-400">Stock del lote: <b className="text-slate-600 dark:text-slate-300">{loteSel.cantidad}</b></span>
                                )}
                              </div>
                            )
                          })()}
                          {/* Salida parcial/total */}
                          <div className="mt-2 flex items-center gap-2">
                            {(() => {
                              // FIX auditoría 2026-10-21 (P3): incluir codigoInc en la clave
                              const itemKey = `${s.codigo}-${s.codigoInc ?? ''}-${s.fVencimiento || ''}`
                              const isTotal = salidaParcialTotal[itemKey] === true
                              return <>
                                <button
                                  type="button"
                                  onClick={() => setSalidaParcialTotal(prev => ({ ...prev, [itemKey]: true }))}
                                  className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all border ${
                                    isTotal
                                      ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40 dark:border-red-600 dark:text-red-300'
                                      : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                                  }`}
                                >
                                  Total ({s.stock})
                                </button>
                                <input
                                  type="number"
                                  step="any"
                                  min="0.001"
                                  max={s.stock}
                                  placeholder="Parcial"
                                  value={isTotal ? String(s.stock) : (salidaParcialCant[itemKey] || '')}
                                  onChange={e => {
                                    setSalidaParcialCant(prev => ({ ...prev, [itemKey]: e.target.value }))
                                    setSalidaParcialTotal(prev => ({ ...prev, [itemKey]: false }))
                                  }}
                                  disabled={isTotal || salidaBusy === itemKey}
                                  className="w-20 h-7 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md px-2 disabled:opacity-50"
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleSalidaDesdeAlerta(s)}
                                  disabled={salidaBusy === itemKey}
                                  className="h-7 px-2.5 text-[10px] font-semibold border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 hover:border-red-300 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-300 dark:hover:border-red-700 flex-shrink-0 gap-1"
                                >
                                  {salidaBusy === itemKey ? (
                                    <><Loader2 className="h-3 w-3 animate-spin" /> ...</>
                                  ) : (
                                    <><ArrowUpFromLine className="h-3 w-3" /> Dar Salida</>
                                  )}
                                </Button>
                              </>
                            })()}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  Selecciona "Total" o ingresa cantidad parcial y presiona "Dar Salida" para retirar productos del destino.
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
              onClick={(e) => { e.preventDefault(); doTraslado() }}
              disabled={busy}
              className="flex-1 h-11 rounded-lg text-sm font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-md shadow-blue-600/20 gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="h-4 w-4" />
              )}
              Confirmar Traslado
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Atención a Línea (RQ): ¿registrar esta salida en la RQ? (compartido) ── */}
      <RqSalidaConfirmador
        conf={rqConfirmer}
        onTerminar={() => setRqConfirmer(null)}
        onCerrar={() => setRqConfirmer(null)}
      />
    </div>
  )
}
