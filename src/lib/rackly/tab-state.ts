/**
 * Persistencia ligera del estado de búsqueda de pestañas (sessionStorage).
 *
 * Motivo: las Tabs de Radix DESMONTAN el contenido inactivo. Al ir de Stock a
 * una posición (movimientos) y volver con el botón de retorno, la pestaña se
 * remontaba con la búsqueda VACÍA y el usuario tenía que reescribir el código.
 * Con esto, al retornar "sigue buscando otros artículos" desde donde quedó.
 *
 * sessionStorage (no localStorage): el estado vive mientras la pestaña del
 * navegador — sesiones nuevas empiezan limpias, sin sorpresas al día siguiente.
 */

const PREFIX = 'rackly.tab.'

export function saveTabState<T>(key: string, value: T): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* SSR/prerender o storage lleno/deshabilitado — la app funciona igual */
  }
}

export function loadTabState<T>(key: string, fallback: T): T {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (parsed === null || parsed === undefined) return fallback
    return parsed
  } catch {
    return fallback
  }
}
