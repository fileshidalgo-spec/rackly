/**
 * RACKLY — Idempotencia y control anti-duplicado de RECEPCIÓN (M-1).
 *
 * Problema que resuelve: la única protección contra un registro doble era
 * el `disabled` del botón (vive solo en el navegador). Un reintento de red,
 * un doble envío desde dos pestañas o una recarga a mitad del registro
 * creaba filas repetidas indistinguibles de paletas legítimas.
 *
 * Mecanismos (recomendación de la auditoría integral 2026-10):
 *  1. `uuid_sync` generado por el CLIENTE y persistido por fila, con índice
 *     único parcial en BD (mismo patrón que `movimientos.uuid_sync`): los
 *     reintentos del MISMO formulario reutilizan el lote y la BD los hace
 *     idempotentes.
 *  2. `n_paleta`: número de paleta (i de "Paleta i/N") que antes solo vivía
 *     en memoria; ahora se persiste por fila.
 *  3. Verificación de duplicado reciente: si al registrar ya existe una fila
 *     idéntica (documento+código+cantidad+lote) con menos de 60 segundos,
 *     se pide confirmación al usuario.
 */
import { useRef } from 'react'
import { dataClient } from '@/lib/supabase/client'

/** Ventana (segundos) para considerar "reciente" una fila idéntica. */
export const VENTANA_DUPLICADO_SEG = 60

/** Genera un UUID v4 simple (no requiere crypto.randomUUID). */
export function nuevoUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Extrae el índice de paleta (i) de una marca "Paleta i/N"; null si no hay. */
export function extraerIndicePaleta(observaciones?: string | null): number | null {
  const m = (observaciones ?? '').match(/Paleta (\d+)\/(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return isNaN(n) ? null : n
}

/**
 * Lote de uuid_sync ESTABLE entre reintentos del mismo formulario: se genera
 * una sola vez por cantidad de filas y se conserva aunque la petición falle,
 * de modo que el reintento choque con el índice único en vez de duplicar.
 * `liberar()` se llama tras un guardado exitoso (o al vaciar el formulario).
 */
export function useLoteUuidSync() {
  const ref = useRef<string[] | null>(null)
  const paraFilas = (n: number): string[] => {
    if (!ref.current || ref.current.length !== n) {
      ref.current = Array.from({ length: n }, () => nuevoUuid())
    }
    return ref.current
  }
  const liberar = () => {
    ref.current = null
  }
  return { paraFilas, liberar }
}

/** Datos mínimos para evaluar duplicado reciente de una fila a registrar. */
export type HuellaDuplicado = {
  numeroDocumento: string
  codigo: string
  cantidad: number
  lote?: string
}

/**
 * Devuelve true si ya existe en BD una fila idéntica (mismo documento,
 * código, cantidad y lote) creada dentro de la ventana de 60 segundos.
 * Usada ANTES de insertar: con ella, un doble clic/doble pestaña pide
 * confirmación en lugar de inflar las cantidades en silencio.
 */
export async function hayDuplicadosRecientes(
  items: HuellaDuplicado[]
): Promise<boolean> {
  if (items.length === 0) return false
  const doc = (items[0].numeroDocumento ?? '').trim()
  if (!doc) return false // sin número de guía no hay huella confiable
  const desde = new Date(Date.now() - VENTANA_DUPLICADO_SEG * 1000).toISOString()
  try {
    const { data, error } = await dataClient
      .from('recepcion_registros')
      .select('codigo, cantidad, lote')
      .eq('numero_documento', doc)
      .gte('created_at', desde)
      .limit(200)
    if (error) throw error
    if (!data || data.length === 0) return false
    const norm = (v: unknown) => String(v ?? '').trim().toUpperCase()
    for (const it of items) {
      const existe = (data as Array<Record<string, unknown>>).some(
        (r) =>
          norm(r.codigo) === norm(it.codigo) &&
          Number(r.cantidad) === Number(it.cantidad) &&
          norm(r.lote) === norm(it.lote)
      )
      if (existe) return true
    }
    return false
  } catch (err) {
    // Ante fallo de la verificación NO bloqueamos el registro: se comporta
    // como antes (el índice uuid_sync sigue protegiendo los reintentos).
    console.warn('[recepcion-idempotencia] verificación de duplicados falló:', err)
    return false
  }
}
