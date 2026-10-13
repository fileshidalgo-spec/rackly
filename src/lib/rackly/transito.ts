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
 *   · Anti-sobreenvío, idempotencia por uuid y bloqueo sin lote/vencimiento
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
  razonNoTransferible,
  esTransferible,
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
 * Lista los artículos de guías desde la fecha de implementación.
 * `maxFilas` acota la consulta (las guías recientes son pocas; 3000 filas
 * cubren semanas de operación y la agrupación es instantánea).
 */
export async function listarArticulosTransito(maxFilas = 3000): Promise<ArticuloTransito[]> {
  const { data, error } = await dataClient
    .from('recepcion_registros')
    .select('*')
    .gte('fecha', FECHA_INICIO_TRANSITO)
    .order('created_at', { ascending: false })
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
}

/** Ejecuta UN envío (1 artículo → 1 ubicación) con uuid propio e idempotencia. */
export async function transferirArticulo(args: ArgsTransferir): Promise<ResultadoEnvio> {
  const { articulo, destino, cantidad, turno, usuario, rack, nivel, etiqueta } = args
  // Falla rápido en cliente (la RPC revalida todo)
  if (!articulo.transferible) throw new Error(articulo.razonNoTransferible)
  const v = validarCantidad(cantidad, articulo.pendiente)
  if (v) throw new Error(v)

  const uuid = nuevoUuid()
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
