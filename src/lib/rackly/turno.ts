import { TURNO_DIA, TURNO_NOCHE, TURNO_DIA_INICIO, TURNO_NOCHE_INICIO,
         TURNO_T1, TURNO_T2, RECEPCION_T1_INICIO, RECEPCION_T1_FIN } from './constants'
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

/** Turno de la regla de RECEPCIÓN (Excel de guías): 'T1' o 'T2'.
 *  La BD no guarda turno en recepcion_registros: derivarlo del created_at
 *  (hora real de registro) corrige también las guías históricas sin
 *  migrar datos. */
export type TurnoRecepcion = typeof TURNO_T1 | typeof TURNO_T2

/** T1 = 07:20:00 → 19:20:59 (inclusive) · T2 = 19:21:00 → 07:19:59.
 *  Siempre en hora de Lima (TZ_ALMACEN), nunca la del dispositivo. */
export function calcularTurnoRecepcion(date: Date): TurnoRecepcion {
  const minutos = minutosEnAlmacen(date)
  return minutos >= RECEPCION_T1_INICIO && minutos <= RECEPCION_T1_FIN ? TURNO_T1 : TURNO_T2
}
