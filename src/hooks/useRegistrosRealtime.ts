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
 *
 * MOTIVO de la notificación (MotivoRealtime): el módulo distingue por qué
 * se pidió el refresco para decidir qué hacer cuando NO puede pisar la
 * lista (p. ej. el usuario avanzó con "Cargar más"):
 *   · 'evento'  → llegó un cambio REAL de la BD (INSERT/UPDATE/DELETE) por
 *                 el canal realtime. Si no se puede refrescar, hay que
 *                 AVISAR al usuario (hay datos nuevos fuera de su vista).
 *   · 'poll'    → tic del polling de respaldo (cada 8 s, no sabe si hubo
 *                 cambios). Si no se puede refrescar, NO avisa (evita
 *                 falsas alarmas).
 *   · 'visible' → el usuario volvió a esta pestaña (visibilitychange):
 *                 probablemente pasó algo mientras estaba fuera; igual
 *                 tratamiento que 'evento'.
 */

import { useEffect, useRef } from 'react'
import { dataClient } from '@/lib/supabase/client'
import { POLLING_INTERVAL } from '@/lib/rackly/constants'

export type TablaRealtime =
  | 'recepcion_registros'
  | 'atencion_registros'
  | 'movimientos'
  | 'rq_atenciones'

/** Por qué se pide el refresco (ver documentación del hook). */
export type MotivoRealtime = 'evento' | 'poll' | 'visible'

const CANAL_POR_TABLA: Record<TablaRealtime, string> = {
  recepcion_registros: 'recepcion-realtime-sync',
  atencion_registros: 'atencion-realtime-sync',
  movimientos: 'movs-realtime-sync',
  rq_atenciones: 'rq-atencion-realtime-sync',
}

type EstadoTabla = {
  listeners: Set<(motivo: MotivoRealtime) => void>
  intervalo: ReturnType<typeof setInterval> | null
  canal: ReturnType<typeof dataClient.channel> | null
  debounce: ReturnType<typeof setTimeout> | null
  onVisible: (() => void) | null
}

const estados = new Map<TablaRealtime, EstadoTabla>()

function estadoDe(tabla: TablaRealtime): EstadoTabla {
  let e = estados.get(tabla)
  if (!e) {
    e = { listeners: new Set(), intervalo: null, canal: null, debounce: null, onVisible: null }
    estados.set(tabla, e)
  }
  return e
}

function notificar(tabla: TablaRealtime, motivo: MotivoRealtime) {
  const e = estadoDe(tabla)
  for (const fn of e.listeners) {
    try {
      fn(motivo)
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
    notificar(tabla, 'evento')
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
  e.intervalo = setInterval(() => notificar(tabla, 'poll'), POLLING_INTERVAL)
}

/**
 * Refresco INMEDIATO al volver a la pestaña: mientras el usuario estuvo
 * fuera (otra app del celular, otra pestaña) cualquiera pudo registrar algo;
 * al regresar no debe esperar al próximo tic del polling.
 */
function iniciarVisible(tabla: TablaRealtime) {
  const e = estadoDe(tabla)
  if (e.onVisible) return
  e.onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      notificar(tabla, 'visible')
    }
  }
  document.addEventListener('visibilitychange', e.onVisible)
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
  if (e.onVisible) {
    document.removeEventListener('visibilitychange', e.onVisible)
    e.onVisible = null
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
 * siempre se invoca la última versión. Recibe el `motivo` ('evento' |
 * 'poll' | 'visible'); los callbacks antiguos que lo ignoran siguen
 * funcionando sin cambios.
 */
export function useRegistrosRealtime(
  tabla: TablaRealtime,
  alCambiar: (motivo: MotivoRealtime) => void
) {
  const ref = useRef(alCambiar)

  useEffect(() => {
    ref.current = alCambiar
  })

  useEffect(() => {
    const e = estadoDe(tabla)
    const esPrimerListener = e.listeners.size === 0

    const listener = (motivo: MotivoRealtime) => ref.current(motivo)
    e.listeners.add(listener)

    if (esPrimerListener) {
      iniciarCanal(tabla)
      iniciarPolling(tabla)
      iniciarVisible(tabla)
    }

    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size === 0) detenerTodo(tabla)
    }
  }, [tabla])
}
