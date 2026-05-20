export const BLOQUES = Array.from({ length: 9 }, (_, i) => String(i + 1))
export const PISOS = Array.from({ length: 4 }, (_, i) => String(i + 1))

type ConfigBloque = { torres: number; posiciones: number }

const CONFIG: Record<string, ConfigBloque> = {
  '1': { torres: 2, posiciones: 20 },
  '2': { torres: 2, posiciones: 20 },
  '3': { torres: 2, posiciones: 20 },
  '4': { torres: 2, posiciones: 20 },
  '5': { torres: 2, posiciones: 20 },
  '6': { torres: 2, posiciones: 20 },
  '7': { torres: 2, posiciones: 20 },
  '8': { torres: 1, posiciones: 14 },
  '9': { torres: 1, posiciones: 6 },
}

export function torresDeBloque(bloque: string): string[] {
  const cfg = CONFIG[bloque]
  if (!cfg) return []
  return Array.from({ length: cfg.torres }, (_, i) => String(i + 1))
}

export function posicionesDeBloque(bloque: string): string[] {
  const cfg = CONFIG[bloque]
  if (!cfg) return []
  return Array.from({ length: cfg.posiciones }, (_, i) => String(i + 1))
}

export const TORRES = ['1', '2']
export const POSICIONES = Array.from({ length: 20 }, (_, i) => String(i + 1))

export function totalCeldas(): number {
  return BLOQUES.reduce((acc, b) => {
    const cfg = CONFIG[b]
    return acc + cfg.torres * PISOS.length * cfg.posiciones
  }, 0)
}

export function totalCeldasBloque(bloque: string): number {
  const cfg = CONFIG[bloque]
  if (!cfg) return 0
  return cfg.torres * PISOS.length * cfg.posiciones
}

export function configBloque(bloque: string): ConfigBloque | undefined {
  return CONFIG[bloque]
}
