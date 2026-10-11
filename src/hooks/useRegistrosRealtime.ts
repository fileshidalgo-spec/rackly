'use client'

/**
 * RACKLY — Realtime genérico para las tablas de módulos
 * (recepcion_registros, atencion_registros, movimientos).
 *
 * Problema: los módulos cargan su listado una sola vez (montaje/filtros);
 * lo que registra otro usuario (o el mismo desde el celular) solo aparecía
 * al recargar la página o pulsar "Buscar".
 *
 * Causa raíz encontrada (2026-10): la publicación `supabase_realtime` de la
 * BD estaba VACÍA — ningún campo de evento llegaba jamás (ni siquiera para
 * movimientos, que ya intentaba suscribirse; vivía solo del polling). Se
 * agregaron las 3 tablas a la publicación vía SQL y este hook centraliza la
 * suscripción para todos los módulos.
 *
 * Patrón (igual que useMovimientosRealtime):
 *   · SINGLETON por tabla: el primer listener abre canal + polling; el
 *     último al desmontar los cierra. Evita canales/intervalos duplicados
 *     cuando el módulo se monta 2 veces (StrictMode, etc.).
 *   · Debounce REAL de 200 ms: una guía de 20 artículos dispara 20 INSERT
 *     seguidos → 1 solo refresco, no 20.
 *   · dataClient (service_role) para el canal: recibe eventos aunque RLS
 *     restrinja el rol anónimo (mismo criterio que useMovimientosRealtime).
 *   · El REFRESCO lo hace cada módulo con su propio `cargar` (filtros y
 *     paginación propias): este hook solo AVISA. La decisión de refrescar
 *     (p. ej. solo si está en la página 1) la toma el módulo.
 */

import { useEffect, useRef } from 'react'
import { dataClient } from '@/lib/supabase/client'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

export type TablaRealtime =
  | 'recepcion_registros'
  | 'atencion_registros'
  | 'movimientos'

const CANAL_POR_TABLA: Record<TablaRealtime, string> = {
  recepcion_registros: 'recepcion-realtime-sync',
  atencion_registros: 'atencion-realtime-sync',
  movimientos: 'movs-realtime-sync',
}

type EstadoTabla = {
  listeners: Set<() => void>
  intervalo: ReturnType<typeof setInterval> | null
  canal: ReturnType<typeof dataClient.channel> | null
  debounce: ReturnType<typeof setTimeout> | null
}

const estados = new Map<TablaRealtime, EstadoTabla>()

function estadoDe(tabla: TablaRealtime): EstadoTabla {
  let e = estados.get(tabla)
  if (!e) {
    e = { listeners: new Set(), intervalo: null, canal: null, debounce: null }
    estados.set(tabla, e)
  }
  return e
}

function notificar(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  for (const fn of e.listeners) {
    try {
      fn()
    } catch {
      /* un listener roto no bloquea a los demás */
    }
  }
}

function agendarRefresco(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  // Debounce real: cada evento REINICIA el timer (ráfagas → 1 refresco).
  if (e.debounce) clearTimeout(e.debounce)
  e.debounce = setTimeout(() => {
    e.debounce = null
    notificar(tabla)
  }, 200)
}

function iniciarCanal(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  if (e.canal) return
  try {
    e.canal = dataClient
      .channel(CANAL_POR_TABLA[tabla])
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: tabla },
        () => agendarRefresco(tabla)
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[Realtime ${tabla}] Error de canal, el polling mantiene el refresco:`, err)
        }
      })
  } catch (err) {
    console.warn(`[Realtime ${tabla}] Sin canal; queda el polling:`, err)
  }
}

function iniciarPolling(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  if (e.intervalo) return
  // Respaldo si el WebSocket está bloqueado (red corporativa) o el canal
  // muere: el módulo refresca igual cada POLLING_INTERVAL.
  e.intervalo = setInterval(() => notificar(tabla), POLLING_INTERVAL)
}

function detenerTodo(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  if (e.intervalo) {
    clearInterval(e.intervalo)
    e.intervalo = null
  }
  if (e.debounce) {
    clearTimeout(e.debounce)
    e.debounce = null
  }
  if (e.canal) {
    try {
      dataClient.removeChannel(e.canal)
    } catch {
      /* ignore */
    }
    e.canal = null
  }
}

/**
 * Suscribe `alCambiar` a los cambios de `tabla` mientras el componente esté
 * montado. `alCambiar` debe ser estable (useCallback) — se guarda en ref y
 * siempre se invoca la última versión.
 */
export function useRegistrosRealtime(tabla: TablaRealtime, alCambiar: () => void) {
  const ref = useRef(alCambiar)

  useEffect(() => {
    ref.current = alCambiar
  })

  useEffect(() => {
    const e = estadoDe(tabla)
    const esPrimerListener = e.listeners.size === 0

    const listener = () => ref.current()
    e.listeners.add(listener)

    if (esPrimerListener) {
      iniciarCanal(tabla)
      iniciarPolling(tabla)
    }

    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size === 0) detenerTodo(tabla)
    }
  }, [tabla])
}
