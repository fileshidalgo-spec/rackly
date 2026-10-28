/**
 * RACKLY — PUENTE ATENCIÓN ↔ TRÁNSITO · Núcleo puro del escaneo en lote
 * (sin dependencias de BD/Supabase — mismo patrón que transito-core).
 *
 * Qué resuelve (prompt v1.0 §4.2/§4.3):
 *   · Cada TOMA = 1 paleta/rejilla escaneada. La cantidad de la toma se jala
 *     de Recepción (cada paleta es UNA fila con SU cantidad) — el operario
 *     no digita nada por toma; solo ajusta la línea si la física difiere.
 *   · Ruta por línea determinística: fila con pendiente → TRÁNSITO (descuenta
 *     la guía); fila ya transferida → POSICIÓN (salida de la ubicación que
 *     registran sus envíos).
 *   · FEFO en TODA ambigüedad (decisión del usuario 2026-10-23): sin QR,
 *     paleta con varios lotes y filas sin nº de paleta.
 *   · Deduplicación estricta: la misma paleta (fila) jamás se suma dos veces;
 *     rótulos sin paleta consumen la siguiente fila disponible en orden FEFO.
 */

import { parsearPayloadQR, type PayloadQRRotulo } from './qr-rotulo'
import {
  EPS_TRANSITO,
  etiquetaRack,
  etiquetaPiso,
  type ArticuloTransito,
  type EnvioTransito,
} from './transito-core'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

export type RutaOrigen = 'transito' | 'posicion'

/** Ubicación sugerida para la ruta POSICIÓN (sale de los envíos de la fila). */
export type OrigenPosicion = {
  rack: { bloque: string; torre: string; piso: string; posicion: string } | null
  piso: { nivel_id: string; posicion_id?: string; nivel_numero?: number } | null
  /** Etiqueta legible (B3·T2·P1·Pos07 / SA·A·2·1·N3). */
  etiqueta: string
}

/** Una toma del carrito (1 escaneo = 1 paleta). */
export type TomaQR = {
  /** uuid de la toma (idempotencia del lote en la RPC). */
  uuid: string
  /** Fila de recepcion_registros — identidad de la paleta. */
  recepcionId: string
  guiaId: string
  numeroDocumento: string
  /** Fecha de la guía ('YYYY-MM-DD') para mostrar cuando el Nº falta. */
  fecha: string
  paleta: number | null
  codigo: string
  descripcion: string
  unidad: string
  lote: string
  fechaVencimiento: string | null
  /** Cantidad de la toma (default = la de Recepción; editable por varianza). */
  cantidad: number
  /** La cantidad ORIGINAL de Recepción (para detectar ajustes en el resumen). */
  cantidadOriginal: number
  ruta: RutaOrigen
  /** Solo ruta 'posicion': la ubicación de salida (editable en el carrito). */
  origen: OrigenPosicion | null
  /** TODAS las ubicaciones de la fila (selector cuando hubo traslados parciales). */
  opcionesOrigen: OrigenPosicion[]
  /** Hora de la toma (para la lista del carrito). */
  createdAt: string
}

export type RechazoToma =
  | 'QR_AJENO'
  | 'CODIGO_AJENO'
  | 'GUIA_NO_RESUELTA'
  | 'PALETA_YA_EN_CARRITO'
  | 'SIN_FILAS_DISPONIBLES'
  | 'FILA_SIN_ORIGEN'

export type ResultadoResolucion =
  | { estado: 'ok'; toma: TomaQR; /** Aviso no bloqueante (paleta ambigua, etc.). */ aviso?: string }
  | { estado: 'rechazada'; razon: RechazoToma; mensaje: string }

export const MENSAJE_RECHAZO: Record<RechazoToma, string> = {
  QR_AJENO: 'El QR no es un rótulo de Rackly',
  CODIGO_AJENO: 'Ese código no pertenece a este material de la RQ',
  GUIA_NO_RESUELTA: 'La guía del QR no tiene filas para este código',
  PALETA_YA_EN_CARRITO: 'Esa paleta ya está en la lista',
  SIN_FILAS_DISPONIBLES: 'No quedan paletas de esa guía por atender',
  FILA_SIN_ORIGEN: 'La fila ya no tiene pendiente ni ubicaciones registradas',
}

/** Payload decodificado — expuesto para las validaciones previas del wizard. */
export function payloadDeTexto(texto: string): PayloadQRRotulo | null {
  return parsearPayloadQR(texto)
}

// ═══════════════════════════════════════════════════════════════════
// FEFO (decisión del usuario: prioridad por vencimiento)
// ═══════════════════════════════════════════════════════════════════

/**
 * Orden FEFO estable: menor fecha de vencimiento primero (NULLS LAST),
 * empate → fila más antigua por created_at, empate → id (determinismo total).
 */
export function ordenarFEFO(filas: ArticuloTransito[]): ArticuloTransito[] {
  return [...filas].sort((a, b) => {
    const va = a.fechaVencimiento?.trim() || ''
    const vb = b.fechaVencimiento?.trim() || ''
    if (va && vb && va !== vb) return va.localeCompare(vb)
    if (va && !vb) return -1
    if (!va && vb) return 1
    const c = a.createdAt.localeCompare(b.createdAt)
    return c !== 0 ? c : a.id.localeCompare(b.id)
  })
}

/** Primera fila en orden FEFO (o null si no hay). */
export function elegirFilaFEFO(filas: ArticuloTransito[]): ArticuloTransito | null {
  return ordenarFEFO(filas)[0] ?? null
}

// ═══════════════════════════════════════════════════════════════════
// RESOLUCIÓN DE UNA TOMA
// ═══════════════════════════════════════════════════════════════════

function rechazo(razon: RechazoToma, detalle?: string): ResultadoResolucion {
  const base = MENSAJE_RECHAZO[razon]
  return { estado: 'rechazada', razon, mensaje: detalle ? `${base}: ${detalle}` : base }
}

/** Ubicación sugerida: el ÚLTIMO envío de la fila que tenga rack o piso. */
export function origenDeEnvios(envios: EnvioTransito[]): OrigenPosicion | null {
  for (let i = envios.length - 1; i >= 0; i--) {
    const e = envios[i]
    if (e.rack) {
      return { rack: e.rack, piso: null, etiqueta: e.ubicacion || etiquetaRack(e.rack) }
    }
    if (e.piso) {
      return {
        rack: null,
        piso: e.piso,
        etiqueta: e.ubicacion || etiquetaPiso({ nivelNumero: e.piso.nivel_numero }),
      }
    }
  }
  return null
}

/** TODAS las ubicaciones a las que la fila fue transferida (selector del carrito). */
export function ubicacionesDeFila(fila: ArticuloTransito): OrigenPosicion[] {
  const out: OrigenPosicion[] = []
  for (const e of fila.envios) {
    if (e.rack) out.push({ rack: e.rack, piso: null, etiqueta: e.ubicacion || etiquetaRack(e.rack) })
    else if (e.piso)
      out.push({
        rack: null,
        piso: e.piso,
        etiqueta: e.ubicacion || etiquetaPiso({ nivelNumero: e.piso.nivel_numero }),
      })
  }
  return out
}

function construirToma(
  fila: ArticuloTransito,
  paleta: number | null,
  nuevoUuid: () => string
): ResultadoResolucion {
  const ruta: RutaOrigen = fila.pendiente > EPS_TRANSITO ? 'transito' : 'posicion'
  const origen = ruta === 'posicion' ? origenDeEnvios(fila.envios) : null
  if (ruta === 'posicion' && !origen) {
    return rechazo('FILA_SIN_ORIGEN', `fila ${fila.id.slice(0, 8)} de ${fila.numeroDocumento || fila.fecha}`)
  }
  const toma: TomaQR = {
    uuid: nuevoUuid(),
    recepcionId: fila.id,
    guiaId: fila.guiaId,
    numeroDocumento: fila.numeroDocumento,
    fecha: fila.fecha,
    paleta,
    codigo: fila.codigo,
    descripcion: fila.descripcion,
    unidad: fila.unidadMedida,
    lote: fila.lote,
    fechaVencimiento: fila.fechaVencimiento,
    cantidad: fila.cantidad,
    cantidadOriginal: fila.cantidad,
    ruta,
    origen,
    opcionesOrigen: ruta === 'posicion' ? ubicacionesDeFila(fila) : [],
    createdAt: new Date().toISOString(),
  }
  return { estado: 'ok', toma }
}

/**
 * Resuelve UN escaneo contra las filas de la guía y el carrito actual.
 * Nunca lanza: devuelve {estado:'rechazada'} con razón estable para que el
 * wizard muestre el toast y la sesión de escaneo continúe.
 *
 * QR ÚNICO POR RÓTULO (2026-10): si el llamador trae `filaExacta` (la fila
 * resuelta por el uuid del QR — rótulos nuevos), la toma sale de ESA fila y
 * de nadie más: sin FEFO, sin gemelas, y re-escanear el mismo rótulo (o
 * otra copia de su etiqueta) rechaza con PALETA_YA_EN_CARRITO en vez de
 * consumir otra paleta. Los rótulos legados (uuid de guía) siguen la ruta
 * FEFO de siempre.
 */
export function resolverToma(args: {
  texto: string
  codigoRq: string
  /** Filas disponibles (de la guía del QR o del código del material). */
  filas?: ArticuloTransito[]
  /** Fila EXACTA resuelta por el uuid del QR (rótulos nuevos). */
  filaExacta?: ArticuloTransito | null
  carrito: TomaQR[]
  nuevoUuid: () => string
}): ResultadoResolucion {
  const payload = payloadDeTexto(args.texto)
  if (!payload) return rechazo('QR_AJENO')

  // El código del rótulo debe ser EXACTAMENTE el del material RQ (case-insensitive).
  if (payload.codigo.trim().toUpperCase() !== args.codigoRq.trim().toUpperCase()) {
    return rechazo('CODIGO_AJENO', `QR=${payload.codigo} ≠ RQ=${args.codigoRq}`)
  }

  // ── Ruta EXACTA (rótulo con uuid de fila): identidad 1:1 con la paleta.
  if (args.filaExacta) {
    const fila = args.filaExacta
    if (args.carrito.some((t) => t.recepcionId === fila.id)) {
      return rechazo(
        'PALETA_YA_EN_CARRITO',
        `ese rótulo (${fila.numeroDocumento || fila.fecha}${fila.nPaleta != null ? ` · paleta ${fila.nPaleta}` : ''}) ya fue escaneado`
      )
    }
    return construirToma(fila, fila.nPaleta, args.nuevoUuid)
  }

  // ── Ruta legada (uuid de guía o rótulo residual): FEFO entre candidatas.
  const identidad = payload.identidad.trim()
  const codigo = payload.codigo.trim().toUpperCase()
  const candidatas = (args.filas ?? []).filter(
    (f) =>
      f.codigo.trim().toUpperCase() === codigo &&
      (!identidad || f.guiaId === identidad)
  )
  if (candidatas.length === 0) {
    return rechazo(
      'GUIA_NO_RESUELTA',
      identidad
        ? `el rótulo es de la guía ${payload.numeroDocumento || identidad.slice(0, 8)} y el código ${codigo} no está en ella — si la guía fue registrada 2 veces, usa el rótulo del otro registro o agrégalo desde la lista manual`
        : 'rótulo sin identidad de guía'
    )
  }

  if (payload.paleta != null) {
    // Rótulo con paleta: elige la fila de esa paleta (FEFO si hay varios lotes).
    const dePaleta = ordenarFEFO(candidatas.filter((f) => f.nPaleta === payload.paleta))
    if (dePaleta.length === 0) {
      return rechazo('GUIA_NO_RESUELTA', `paleta ${payload.paleta} no existe en la guía`)
    }
    const elegida = dePaleta[0]
    if (args.carrito.some((t) => t.recepcionId === elegida.id)) {
      return rechazo('PALETA_YA_EN_CARRITO', `paleta ${payload.paleta} · guía ${elegida.numeroDocumento}`)
    }
    // PALETA AMBIGUA (Task 23): el mismo nº de paleta en varias filas de la
    // guía (guía registrada 2 veces / re-registrada por paleta) — la fila
    // elegida por FEFO puede no ser la paleta física: el operario lo sabe.
    const res = construirToma(elegida, payload.paleta, args.nuevoUuid)
    if (res.estado !== 'ok') return res
    return {
      estado: 'ok',
      toma: res.toma,
      aviso:
        dePaleta.length > 1
          ? `Paleta ${payload.paleta} aparece ${dePaleta.length} veces en la guía — verifica que la cantidad sea la de la paleta física`
          : undefined,
    }
  }

  // Rótulo SIN paleta: cada toma consume la siguiente fila con pendiente (FEFO).
  const libres = ordenarFEFO(candidatas).filter(
    (f) => !args.carrito.some((t) => t.recepcionId === f.id)
  )
  const conPendiente = libres.filter((f) => f.pendiente > EPS_TRANSITO)
  if (conPendiente.length > 0) return construirToma(conPendiente[0], null, args.nuevoUuid)

  // Sin pendiente: siguiente fila YA posicionada disponible (ruta posición).
  const posicionadas = libres.filter((f) => f.envios.length > 0)
  if (posicionadas.length > 0) return construirToma(posicionadas[0], null, args.nuevoUuid)

  return rechazo('SIN_FILAS_DISPONIBLES', `guía ${payload.numeroDocumento || ''}`)
}

/**
 * Agrega una fila del listado MANUAL (sin QR) al carrito con las mismas
 * reglas de dedupe/ruta. Devuelve rechazo si la fila ya está o no tiene origen.
 */
export function agregarFilaManual(
  fila: ArticuloTransito,
  carrito: TomaQR[],
  nuevoUuid: () => string
): ResultadoResolucion {
  if (carrito.some((t) => t.recepcionId === fila.id)) {
    return rechazo('PALETA_YA_EN_CARRITO', `fila de ${fila.numeroDocumento || fila.fecha}`)
  }
  return construirToma(fila, fila.nPaleta, nuevoUuid)
}

// ═══════════════════════════════════════════════════════════════════
// TOTALES DEL CARRITO
// ═══════════════════════════════════════════════════════════════════

export type TotalesCarrito = {
  tomas: number
  total: number
  transito: number
  posicion: number
  /** Tomas cuya cantidad fue ajustada respecto a Recepción. */
  ajustadas: number
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function totalesCarrito(carrito: TomaQR[]): TotalesCarrito {
  let total = 0
  let transito = 0
  let posicion = 0
  let ajustadas = 0
  for (const t of carrito) {
    total += t.cantidad
    if (t.ruta === 'transito') transito += t.cantidad
    else posicion += t.cantidad
    if (Math.abs(t.cantidad - t.cantidadOriginal) > 0.0005) ajustadas++
  }
  return { tomas: carrito.length, total: r3(total), transito: r3(transito), posicion: r3(posicion), ajustadas }
}
