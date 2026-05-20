import type { Turno } from './kardex'

export function calcularTurno(date: Date = new Date()): Turno {
  const minutos = date.getHours() * 60 + date.getMinutes()
  const inicioDia = 7 * 60 + 45
  const finDia = 19 * 60 + 45
  return minutos >= inicioDia && minutos < finDia ? 'Día' : 'Noche'
}
