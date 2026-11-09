'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — CONTRATO DE NAVEGACIÓN (puente).
 *
 * Definido en el esqueleto (incremento 1) para que cada módulo nazca ya
 * enchufable: el hub (page.tsx) mantiene el estado de targets y cada módulo
 * declara qué targets CONSUME. Patrón ya probado en Insumos
 * (CrossModuleStock → deep-link → consumir → "Volver").
 *
 * Reglas del puente:
 *   · target         = a dónde aterrizar (artículo / ubicación / RAL) + vista
 *                      de origen para el botón "Volver".
 *   · onTargetConsumido = el módulo avisa al hub que ya consumió el target
 *                      (evita re-aterrizar al re-render, como targetPosicion).
 *   · Los puentes Repuestos NO cruzan a Insumos: cada almacén es un mundo;
 *      lo único compartido son los USUARIOS (capa neutra del pre-ingreso).
 */

import type { RepVista } from './rep-vistas'

/** De dónde vino el salto (para el botón "Volver" del módulo destino) */
export type RepOrigen = { vista: RepVista; label: string }

export type RepTarget =
  /** Aterriza en Stock/Búsqueda con el artículo enfocado (desde Ubicaciones,
   *  Atención o Movimientos) */
  | { tipo: 'articulo'; articuloId: string; codigo: string; origen: RepOrigen }
  /** Aterriza en el mapa de Ubicaciones con la posición/lonchera enfocada
   *  (desde Stock, Recepción o Movimientos) */
  | { tipo: 'ubicacion'; ubicacionId: string; codigo: string; origen: RepOrigen }
  /** Aterriza en Atención con el RAL abierto (desde Tránsito o Movimientos) */
  | { tipo: 'ral'; ralId: string; numero: string; origen: RepOrigen }

/** Ids de las vistas del almacén (los usa el hub y RepuestosHome) */
export const REP_VISTAS = [
  'catalogo',
  'ubicaciones',
  'recepcion',
  'atencion',
  'transito',
  'movimientos',
] as const
