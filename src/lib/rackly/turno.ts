import { TURNO_DIA, TURNO_NOCHE, TURNO_DIA_INICIO, TURNO_NOCHE_INICIO } from './constants'
import type { Turno } from './kardex'

/** Zona horaria operativa del almacén (Lima, Perú). Los cortes de turno
 *  (07:45 / 19:45) son horas de Lima: calcular el turno con la zona del
 *  dispositivo registraba turnos incorrectos en equipos con otra TZ. */
const TZ_ALMACEN = 'America/Lima'

/** Hora local de Lima en minutos desde medianoche, para cualquier Date. */
function minutosEnAlmacen(date: Date): number {
  // Intl da la hora/minuto de Lima de forma fiable en todos los runtimes
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_ALMACEN,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.format(date) // "HH:mm"
  const [h, m] = parts.split(':').map((v) => parseInt(v, 10) || 0)
  return h * 60 + m
}

export function calcularTurno(date: Date = new Date()): Turno {
  const minutos = minutosEnAlmacen(date)
  return minutos >= TURNO_DIA_INICIO && minutos < TURNO_NOCHE_INICIO ? TURNO_DIA : TURNO_NOCHE
}
