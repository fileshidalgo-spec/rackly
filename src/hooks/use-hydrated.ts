'use client'

import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

/**
 * RACKLY — ¿Ya se hidrató el componente?
 *
 * Reemplaza el patrón `useState(false) + useEffect(() => setMounted(true), [])`
 * (setState síncrono dentro de un efecto → renderizado en cascada, señalado
 * por la auditoría M-2 en page.tsx y ClientToaster.tsx) por la forma
 * recomendada por React: useSyncExternalStore devuelve false en servidor y
 * durante la hidratación, y true en el cliente a partir del primer render
 * post-hidratación — mismo resultado, sin setState en el efecto.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)
}
