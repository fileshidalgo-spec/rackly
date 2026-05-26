import { TURNO_DIA, TURNO_NOCHE, TURNO_DIA_INICIO, TURNO_NOCHE_INICIO } from './constants'
import type { Turno } from './kardex'

export function calcularTurno(date: Date = new Date()): Turno {
  const minutos = date.getHours() * 60 + date.getMinutes()
  return minutos >= TURNO_DIA_INICIO && minutos < TURNO_NOCHE_INICIO ? TURNO_DIA : TURNO_NOCHE
}
