'use client'

/**
 * RACKLY — Reglas compartidas para la EDICIÓN de lote / fecha de vencimiento
 * de artículos en los módulos Racks y Piso.
 *
 * v1 (pedido 2026-10-20): completar datos de artículos registrados SIN lote
 * y sin fechas (cargo almacenero).
 * v2 (ampliación 2026-10-20): la edición también alcanza artículos que YA
 * tienen lote/fechas — para CORREGIR equivocaciones de registro — y los
 * cargos autorizados se amplían a supervisores.
 *
 * Quién puede editar (ROLES_EDICION_LOTE):
 *   · `almacenero`             — el cargo que pidió el usuario originalmente.
 *   · `admin`                  — conserva poder completo sobre todo el sistema.
 *   · `supervisor_almacen`     — "supervisores" del pedido de ampliación.
 *   · `supervisor_operaciones` — ídem.
 *   · El resto de roles (operario, auxiliar, coordinador) NO ve la acción.
 *
 * Qué se puede guardar:
 *   · Lote y/o fecha de vencimiento (al menos UNO de los dos, con formato
 *     ISO YYYY-MM-DD si viene fecha). La RPC del servidor re-aplica esta
 *     regla (defensa en profundidad) y solo toca las filas del bucket
 *     actual exacto (lote_actual + f_vencimiento_actual) — el saldo queda
 *     exacto: imposible fabricar negativos.
 *
 * Desambiguación (construirOpcionesLote):
 *   Un bucket de la UI puede agregar VARIOS lotes físicos bajo una misma
 *   fecha (y un artículo puede tener varias fechas). Antes de corregir hay
 *   que saber a QUÉ bucket exacto apunta el cambio: el helper descompone
 *   la fila de stock en opciones (lote físico × fecha) y el diálogo deja
 *   elegir cuando hay más de una.
 */

export const ROLES_EDICION_LOTE = [
  'almacenero',
  'admin',
  'supervisor_almacen',
  'supervisor_operaciones',
] as const

/** ¿Este rol puede editar lote/fecha de artículos (completar o corregir)? */
export function puedeEditarLote(rol: string | null | undefined): boolean {
  if (!rol) return false
  return (ROLES_EDICION_LOTE as readonly string[]).includes(rol)
}

const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

export type ResultadoValidacionLote =
  | { ok: true; lote: string | null; fecha: string | null }
  | { ok: false; error: string }

/**
 * Normaliza y valida los datos digitados en el diálogo de edición.
 * Devuelve el par normalizado (vacío → null) o el motivo del rechazo.
 */
export function validarDatosLote(
  lote: string | null | undefined,
  fecha: string | null | undefined
): ResultadoValidacionLote {
  const loteNorm = (lote ?? '').trim() || null
  const fechaNorm = (fecha ?? '').trim() || null

  if (!loteNorm && !fechaNorm) {
    return { ok: false, error: 'Indique el lote y/o la fecha de vencimiento del producto' }
  }
  if (loteNorm && loteNorm.length > 100) {
    return { ok: false, error: 'El código de lote no puede exceder 100 caracteres' }
  }
  if (fechaNorm && !RE_FECHA_ISO.test(fechaNorm)) {
    return { ok: false, error: 'Fecha de vencimiento inválida (formato esperado: AAAA-MM-DD)' }
  }
  return { ok: true, lote: loteNorm, fecha: fechaNorm }
}

// ═══════════════════════════════════════════════════════════════════
// DESAMBIGUACIÓN de buckets (v2 — corrección de artículos CON datos)
// ═══════════════════════════════════════════════════════════════════

/** Una opción = un bucket EXACTO (lote físico + fecha) editable en la ubicación. */
export type OpcionLote = {
  /** Código de lote físico; '' cuando el ingreso no registró lote. */
  loteFisico: string
  /** Fecha de vencimiento ISO del bucket; '' cuando no tiene. */
  fecha: string
  /** Cantidad del bucket (contexto para elegir/editar; la RPC de lote no la usa). */
  cantidad: number
  /**
   * Proveedor del bucket (el del ingreso más reciente de esa fecha) — viaja
   * en el AJUSTE de cantidad (Task 28) para que el lote conserve su
   * proveedor real; las salidas no lo registran por convención del kardex.
   */
  proveedor?: string
}

/** Forma mínima que las vistas de stock ya proveen (Racks y Piso). */
export type BucketDeStock = {
  stock: number
  /** Fecha única del bucket cuando la fila no tiene desglose multi-lote. */
  fecha?: string
  /** Códigos de lote físico JOINED por ', ' (formato de las vistas de stock). */
  loteFisico?: string
  /** Proveedor de la fila (hereda a las opciones si el lote no trae uno propio). */
  proveedor?: string
  /** Desglose multi-fecha (cuando el artículo tiene más de un lote). */
  lotes?: { fVencimiento: string; cantidad: number; lotesFisicos?: string[]; proveedor?: string }[]
}

/**
 * Descompone una fila de stock en opciones exactas (lote físico × fecha).
 *
 *  · Fila con desglose (`lotes` con más de 1 entrada): cada loteFisico de
 *    cada fecha es una opción; una fecha sin lote físico genera UNA opción
 *    con loteFisico ''.
 *  · Fila simple: usa `fecha` + `loteFisico` (que puede venir "L1, L2"
 *    — dos ingresos distintos bajo la misma fecha).
 *
 * La lista SIEMPRE trae al menos una opción — con una sola, el diálogo
 * prellena directamente (sin selector).
 */
export function construirOpcionesLote(fila: BucketDeStock): OpcionLote[] {
  const opciones: OpcionLote[] = []

  if (fila.lotes && fila.lotes.length > 1) {
    for (const l of fila.lotes) {
      const fecha = (l.fVencimiento ?? '').trim()
      const fisicos = (l.lotesFisicos ?? []).map((f) => f.trim()).filter(Boolean)
      if (fisicos.length === 0) {
        opciones.push({ loteFisico: '', fecha, cantidad: l.cantidad, proveedor: l.proveedor ?? fila.proveedor })
      } else {
        for (const f of fisicos)
          opciones.push({ loteFisico: f, fecha, cantidad: l.cantidad, proveedor: l.proveedor ?? fila.proveedor })
      }
    }
    return opciones
  }

  const fecha = (fila.fecha ?? '').trim()
  const fisicos = (fila.loteFisico ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (fisicos.length === 0) {
    opciones.push({ loteFisico: '', fecha, cantidad: fila.stock, proveedor: fila.proveedor })
  } else {
    for (const f of fisicos) opciones.push({ loteFisico: f, fecha, cantidad: fila.stock, proveedor: fila.proveedor })
  }
  return opciones
}

/** Etiqueta legible de una opción para el selector del diálogo. */
export function etiquetaOpcionLote(o: OpcionLote): string {
  const lote = o.loteFisico ? `Lote: ${o.loteFisico}` : 'Sin lote'
  const fecha = o.fecha ? `Venc: ${o.fecha}` : 'Sin fecha'
  return `${lote} · ${fecha}`
}

// ═════════════════════════════════════════════════════════════════
// CORRECCIÓN DE CANTIDAD (Task 28 — Racks)
// ═════════════════════════════════════════════════════════════════

export type AjusteCantidad =
  | { tipo: 'ingreso' | 'salida'; cantidad: number }
  | { tipo: null; cantidad: 0 }

/**
 * Compensación PURA entre la cantidad registrada del bucket y la correcta:
 * el kardex (movimientos) es append-only, así que corregir la cantidad =
 * registrar un movimiento compensatorio con la MISMA identidad de bucket:
 *   · nueva < actual → SALIDA de (actual − nueva) — lo que "sobra".
 *   · nueva > actual → INGRESO de (nueva − actual) — lo que "falta".
 *   · igual (±1e-9)  → sin ajuste.
 * La cantidad viaja redondeada a 3 decimales (mismo criterio del stock).
 * El guardado de la UI llama addMovimiento con uuid_sync propio: si el
 * guardado se repite tras un fallo de red, el ajuste NO se duplica.
 */
export function calcularAjusteCantidad(cantidadActual: number, cantidadNueva: number): AjusteCantidad {
  const delta = Math.round((cantidadNueva - cantidadActual) * 1000) / 1000
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return { tipo: null, cantidad: 0 }
  if (delta < 0) return { tipo: 'salida', cantidad: Math.round(-delta * 1000) / 1000 }
  return { tipo: 'ingreso', cantidad: delta }
}
