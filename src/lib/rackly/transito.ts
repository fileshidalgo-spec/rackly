'use client'

/**
 * RACKLY — Capa de datos del módulo TRÁNSITO (puente Recepción → Racks/Pisos).
 *
 * Diseño (v3.3 del prompt, aplicado):
 *   · LEE recepcion_registros (solo guías desde la fecha de implementación) y
 *     marca cada fila con su columna `transito` (jsonb, lista de envíos).
 *   · Las transferencias van por la RPC atómica transito_registrar_envio:
 *       - rama 'rack' → llama a registrar_movimiento_kardex (ingreso nativo),
 *       - rama 'piso' → inserta piso_movimientos + detalles (ingreso nativo),
 *       - y en la MISMA transacción agrega el envío a recepcion_registros.transito.
 *   · Anti-sobreenvío, idempotencia por uuid y admisión de envíos SIN
 *     lote/vencimiento (v2: transferencia consciente con alerta en la UI)
 *     se aplican EN LA RPC (fuente de verdad); el cliente replica solo lo
 *     básico para fallar rápido (transito-core.ts, testeado sin red).
 *   · Aislamiento: no modifica Recepción, Racks ni Piso — solo añade.
 */

import { dataClient } from '@/lib/supabase/client'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'
import { fetchOcupacionCeldasV2, type OcupacionCelda } from '@/lib/rackly/kardex'
import {
  listarSectores,
  cargarPosicionesSector,
  type Sector,
  type PosicionConStock,
  type Nivel,
} from '@/lib/piso/api'
import {
  FECHA_INICIO_TRANSITO,
  mapArticuloTransito,
  type ArticuloTransito,
  type DestinoTransito,
  type EnvioTransito,
  type EstadoSem,
  type GuiaTransito,
  type UsuarioTransito,
  EPS_TRANSITO,
} from './transito-core'

// Re-export del núcleo puro: un solo módulo para la UI.
export {
  FECHA_INICIO_TRANSITO,
  EPS_TRANSITO,
  estadoSem,
  datosFaltantes,
  parseEnvios,
  mapArticuloTransito,
  claveGuia,
  agruparEnGuias,
  contarPendientes,
  filtrarArticulos,
  etiquetaRack,
  etiquetaPiso,
  claveCeldaRack,
  validarCantidad,
  mensajeRpcError,
} from './transito-core'
export type {
  DestinoTransito,
  EnvioTransito,
  EstadoSem,
  ArticuloTransito,
  GuiaTransito,
  UsuarioTransito,
} from './transito-core'
import { validarCantidad } from './transito-core'

// ═══════════════════════════════════════════════════════════════════
// LISTADO
// ═══════════════════════════════════════════════════════════════════

/**
 * Límite de filas descargadas (las MÁS RECIENTES por created_at).
 * A ritmo actual de Recepción (~120 filas/día) cubre ~3 meses de operación.
 * Si la consulta alcanza el tope, la UI muestra un AVISO — jamás recortar
 * guías en silencio (evita la clase de bug "la guía desapareció de Tránsito",
 * ya vivida en Recepción).
 */
export const MAX_FILAS_TRANSITO = 10000

/**
 * Lista los artículos de guías desde la fecha de implementación.
 * `maxFilas` acota la consulta (por defecto MAX_FILAS_TRANSITO).
 */
export async function listarArticulosTransito(maxFilas = MAX_FILAS_TRANSITO): Promise<ArticuloTransito[]> {
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('*')
    .gte('fecha', FECHA_INICIO_TRANSITO)
    .order('created_at', { ascending: false })
    .limit(maxFilas)
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(mapArticuloTransito)
}

/**
 * Trae SOLO los artículos de UNA guía por su guia_id (identidad exacta que
 * porta el QR del rótulo). Lo usa el lector de QR cuando el escaneo cae en
 * una guía que no está (o ya no está) en el listado cargado — p. ej. guías
 * viejas fuera del tope de filas: la guía se recupera y se suma al listado
 * en vivo, nunca un escaneo válido se pierde por el recorte.
 */
export async function listarArticulosPorGuiaId(guiaId: string): Promise<ArticuloTransito[]> {
  const id = guiaId.trim()
  if (!id) return []
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('*')
    .eq('guia_id', id)
    .order('created_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(mapArticuloTransito)
}

/**
 * La FILA EXACTA de un rótulo por su id (QR único por rótulo, 2026-10).
 * El QR nuevo porta el uuid de la fila de recepcion_registros: con él el
 * escaneo resuelve a ESA paleta (lote/cantidad correctos) aunque la guía
 * tenga muchas filas del mismo código — con o sin nº de paleta — o esté
 * registrada 2 veces. Null si el uuid no es una fila (rótulos legados:
 * el llamador cae al listado por guia_id).
 */
export async function listarArticuloPorRecepcionId(
  recepcionId: string
): Promise<ArticuloTransito | null> {
  const id = recepcionId.trim()
  if (!id) return null
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('*')
    .eq('id', id)
    .limit(1)
  if (error) throw error
  const fila = (data ?? [])[0] as Record<string, unknown> | undefined
  return fila ? mapArticuloTransito(fila) : null
}

/**
 * Filas de TODAS las guías de UN código (desde la fecha de implementación de
 * Tránsito), más antigua primero. Lo usa el wizard del puente Atención↔Tránsito
 * para la ruta MANUAL (sin QR): muestra guías con pendiente/posicionado y el
 * usuario elige (nunca auto-elegir en silencio). ilike = exacto sin mayúsculas.
 */
export async function listarArticulosPorCodigo(
  codigo: string,
  maxFilas = 500
): Promise<ArticuloTransito[]> {
  const c = codigo.trim()
  if (!c) return []
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('*')
    .ilike('codigo', c)
    .gte('fecha', FECHA_INICIO_TRANSITO)
    .order('created_at', { ascending: true })
    .limit(maxFilas)
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(mapArticuloTransito)
}

// ═══════════════════════════════════════════════════════════════════
// TRANSFERENCIAS (RPC atómica)
// ═══════════════════════════════════════════════════════════════════

export type ResultadoEnvio = {
  ok: boolean
  duplicado?: boolean
  enviados?: number
  pendiente?: number
  estado?: 'PARCIAL' | 'COMPLETO'
}

type ArgsTransferir = {
  articulo: ArticuloTransito
  destino: DestinoTransito
  cantidad: number
  turno: string
  usuario: UsuarioTransito
  /** rack → { bloque, torre, piso, posicion } */
  rack?: { bloque: string; torre: string; piso: string; posicion: string }
  /** piso → nivel_id (+ posicion_id opcional) */
  nivel?: { nivel_id: string; posicion_id?: string; nivelNumero?: number }
  etiqueta: string
  /**
   * Uuid del envío — OPCIONAL pero la UI DEBE pasarlo: si el llamador genera
   * uno por INTENTO, un timeout con éxito real en BD reintentaría con OTRO
   * uuid y la idempotencia de la RPC (duplicado:true) queda muerta (el
   * usuario vería OVER_ISSUE confuso en vez de “ya estaba registrado”).
   * DialogoTransferir lo genera UNA vez por artículo al confirmar.
   */
  uuidSync?: string
}

/** Ejecuta UN envío (1 artículo → 1 ubicación) con uuid propio e idempotencia.
 *  Sin lote/fechas TAMBIÉN se envía (v2 2026-10-20): la RPC lo permite y la
 *  UI ya pidió la confirmación explícita de transferencia sin datos. */
export async function transferirArticulo(args: ArgsTransferir): Promise<ResultadoEnvio> {
  const { articulo, destino, cantidad, turno, usuario, rack, nivel, etiqueta, uuidSync } = args
  // Falla rápido en cliente (la RPC revalida todo)
  const v = validarCantidad(cantidad, articulo.pendiente)
  if (v) throw new Error(v)

  // El llamador (diálogo) fija el uuid UNA vez por artículo (reintentos
  // idempotentes); fallback interno por compatibilidad de llamadas sueltas.
  const uuid = uuidSync?.trim() || nuevoUuid()
  const { data, error } = await dataClient.rpc('transito_registrar_envio', {
    p_recepcion_id: articulo.id,
    p_tipo_destino: destino,
    p_cantidad: cantidad,
    p_turno: turno,
    p_usuario_id: usuario.id || null,
    p_usuario_nombre: usuario.nombre,
    p_usuario_correo: usuario.correo,
    p_uuid_sync: uuid,
    p_rack: rack
      ? {
          bloque: rack.bloque,
          torre: rack.torre,
          piso: rack.piso,
          posicion: rack.posicion,
        }
      : null,
    p_piso: nivel
      ? {
          nivel_id: nivel.nivel_id,
          posicion_id: nivel.posicion_id ?? '',
          nivel_numero: nivel.nivelNumero ?? null,
        }
      : null,
    p_ubicacion: etiqueta,
  })
  if (error) throw error
  return (data ?? {}) as ResultadoEnvio
}

// ═══════════════════════════════════════════════════════════════════
// INGRESO DESDE RACKS > OCUPACIONES (rótulo escaneado, 2026-10-30)
// ═══════════════════════════════════════════════════════════════════

/**
 * Registra el ingreso de una paleta escaneada (rótulo con QR único) directo
 * en una posición de rack, USANDO LA MISMA RPC ATÓMICA del puente Tránsito:
 *   · crea el ingreso nativo en movimientos (vía registrar_movimiento_kardex),
 *   · Y marca el envío en recepcion_registros.transito en la MISMA transacción.
 *
 * Por qué NO addMovimiento directo: el incidente 2026-10-29 (Elmer, guía
 * T-37934) — un ingreso manual en Racks dejó la fila de Tránsito sin marcar y
 * el palet quedó «pendiente» fantasma (doble conteo al re-escanear). Con esta
 * vía el semáforo de Tránsito y el stock de Racks nacen coherentes.
 *
 * `uuidSync` debe ser ESTABLE entre reintentos del mismo ingreso (idempotencia
 * de la RPC): OcupacionTab lo genera al escanear y lo reusa por fila.
 * Revalida anti-sobreenvío en cliente; la RPC es la fuente de verdad.
 */
export async function registrarIngresoRackDesdeRotulo(args: {
  recepcionId: string
  cantidad: number
  /** Pendiente declarado por la fila escaneada (validación temprana). */
  pendiente: number
  turno: string
  usuario: UsuarioTransito
  rack: { bloque: string; torre: string; piso: string; posicion: string }
  etiqueta: string
  uuidSync?: string
}): Promise<ResultadoEnvio> {
  const v = validarCantidad(args.cantidad, args.pendiente)
  if (v) throw new Error(v)
  const uuid = args.uuidSync?.trim() || nuevoUuid()
  const { data, error } = await dataClient.rpc('transito_registrar_envio', {
    p_recepcion_id: args.recepcionId,
    p_tipo_destino: 'rack',
    p_cantidad: args.cantidad,
    p_turno: args.turno,
    p_usuario_id: args.usuario.id || null,
    p_usuario_nombre: args.usuario.nombre,
    p_usuario_correo: args.usuario.correo,
    p_uuid_sync: uuid,
    p_rack: args.rack,
    p_piso: null,
    p_ubicacion: args.etiqueta,
  })
  if (error) throw error
  return (data ?? {}) as ResultadoEnvio
}

// ═══════════════════════════════════════════════════════════════════
// MAPAS DE UBICACIONES (reutiliza los motores existentes)
// ═══════════════════════════════════════════════════════════════════

export type { OcupacionCelda, Sector, PosicionConStock, Nivel }

/** Ocupación de racks (RPC v2, misma que usa el módulo Racks). */
export async function ocupacionRacks(): Promise<OcupacionCelda[] | null> {
  return fetchOcupacionCeldasV2()
}

/** Sectores del piso. */
export async function sectoresPiso(): Promise<Sector[]> {
  return listarSectores()
}

/** Posiciones de un sector con stock por bloque (incluye vacías). */
export async function posicionesDeSector(sectorId: string): Promise<PosicionConStock[]> {
  return cargarPosicionesSector(sectorId)
}

/** Niveles (unidades físicas) de una posición del piso. */
export async function nivelesDePosicion(posicionId: string): Promise<Nivel[]> {
  const { data, error } = await dataClient
    .from('piso_niveles')
    .select('*')
    .eq('posicion_id', posicionId)
    .order('numero')
  if (error) throw error
  return (data ?? []) as Nivel[]
}
