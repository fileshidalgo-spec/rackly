/**
 * RACKLY · ALMACÉN REPUESTOS — RECEPCIÓN DE ACTIVOS FIJOS (pestaña nueva,
 * pedido del usuario 2026-11-17).
 *
 * MODELO: 1 fila por ACTIVO físico recibido (no es stock: un activo fijo no
 * entra al kardex de repuestos ni al flujo Tránsito → lonchera). Documento:
 * N° de Guía + N° de OC; cada activo = N° de Artículo + descripción manual +
 * código de activación (opcional: «aún no tiene»).
 *
 * N° DE ARTÍCULO (autocompletado): por lo general inicia con la serie 12
 * seguida de 6 dígitos → «12» + 000000 (8 dígitos). El usuario digita SOLO
 * el número final («22» → 12000022); pegar un código completo también
 * funciona (12000022 → sufijo 000022, idempotente). El botón «Excepción de
 * serie» libera el formato para artículos con OTRO inicio de serie.
 *
 * IDEMPOTENCIA (M-1, mismo patrón de recepcion_registros): uuid_sync por
 * activo con índice único — un reintento tras un fallo de red no duplica
 * (23505 → aviso honesto, nunca silencio).
 *
 * RÓTULOS: se reutiliza ImprimirRotulosDialog con formato 'rep' (código
 * grande + QR único por activo); la banda META del builder REP imprime
 * «ACT: …» y «OC: …» (pedido del usuario 2026-11-17) en la franja inferior
 * de la caja de descripción — sin OC/activación, los rótulos de mercadería
 * salen bit a bit idénticos.
 */

/** EDICIÓN/ELIMINACIÓN (pedido del usuario 2026-11-17): el documento guardado
 *  (guía+OC+fecha) se puede MODIFICAR (editar documento, activos conservados
 *  mantienen su id/QR; se actualizan por fila con verificación honesta) o
 *  ELIMINAR completo (con permiso repuestos.eliminar y confirmación). */

import { dataClient } from '@/lib/supabase/client'
import { nuevoUuid } from '@/lib/rackly/recepcion-idempotencia'
import type { RotuloAImprimir } from '@/components/rackly/recepcion/ImprimirRotulosDialog'

/** Serie de inicio por defecto del N° de Artículo. */
export const SERIE_AF = '12'
/** Largo total del código normal (12 + 6 dígitos). */
export const LARGO_ARTICULO_AF = 8

export type ActivoFijoNuevo = {
  articulo: string
  descripcion: string
  /** Código de activación; null = el activo AÚN no lo tiene (opción del usuario). */
  activacion: string | null
  /** true = el N° de artículo NO sigue la serie 12… (excepción de serie). */
  conExcepcion: boolean
}

export type ActivoFijoDB = {
  id: string
  created_at: string
  fecha: string
  guia: string
  oc: string
  articulo: string
  descripcion: string
  activacion: string | null
  con_excepcion: boolean
  usuario_nombre: string
  usuario_correo: string
}

/**
 * AUTOCOMPLETADO del N° de Artículo (PURO). Reglas:
 *   · vacío → vacío (nada que completar).
 *   · pegado un código que YA inicia con la serie y trae 7+ dígitos → se
 *     toma como código COMPLETO (se corta a 8): «12000022» → sufijo «000022».
 *   · en otro caso, lo digitado es el NÚMERO FINAL → «22» → «12000022».
 * Devuelve el sufijo (para el input con la serie «12» fija al lado) y el
 * código completo (lo que se guarda e imprime).
 */
export function autocompletarArticuloAF(texto: string): { sufijo: string; completo: string } {
  const digitos = (texto ?? '').replace(/\D+/g, '')
  if (!digitos) return { sufijo: '', completo: '' }
  if (digitos.startsWith(SERIE_AF) && digitos.length >= 7) {
    const completo = digitos.slice(0, LARGO_ARTICULO_AF)
    return { sufijo: completo.slice(SERIE_AF.length), completo }
  }
  const sufijo = digitos.slice(0, LARGO_ARTICULO_AF - SERIE_AF.length)
  return { sufijo, completo: SERIE_AF + sufijo.padStart(LARGO_ARTICULO_AF - SERIE_AF.length, '0') }
}

/** Código normal válido: exactamente 12 + 6 dígitos. */
export function esArticuloAFValido(articulo: string): boolean {
  return /^12\d{6}$/.test((articulo ?? '').trim())
}

/** Código de EXCEPCIÓN válido: 3-30 de A-Z 0-9 punto guion bajo guion. */
export function esArticuloExcepcionValido(articulo: string): boolean {
  return /^[A-Z0-9._-]{3,30}$/.test((articulo ?? '').trim().toUpperCase())
}

/** ¿El activo NUEVO es válido para agregarlo a la lista? Devuelve motivo o null. */
export function motivoInvalidoActivo(a: ActivoFijoNuevo): string | null {
  const valido = a.conExcepcion ? esArticuloExcepcionValido(a.articulo) : esArticuloAFValido(a.articulo)
  if (!valido) return a.conExcepcion ? 'Código de excepción inválido (3-30: letras, números, . _ -)' : 'N° de artículo inválido: debe ser 12 + 6 dígitos (o usar Excepción de serie)'
  if (a.activacion !== null && !/^[A-Z0-9._-]{3,40}$/.test(a.activacion)) {
    return 'Código de activación inválido (3-40: letras, números, . _ -) — o marca «aún no tiene»'
  }
  return null
}

/** Registro en BD por LOTES de 500 (mismo patrón chunk de crearRecepciones). */
const CHUNK = 500

export async function registrarActivosFijos(
  activos: ActivoFijoNuevo[],
  doc: { fecha: string; guia: string; oc: string },
  usuario: { id: string; nombre: string; correo: string }
): Promise<{ ids: string[] }> {
  const filas = activos.map((a) => ({
    fecha: doc.fecha,
    guia: doc.guia.trim(),
    oc: (doc.oc ?? '').trim(),
    articulo: a.articulo.trim().toUpperCase(),
    descripcion: (a.descripcion ?? '').trim(),
    activacion: a.activacion?.trim().toUpperCase() || null,
    con_excepcion: a.conExcepcion,
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre ?? '',
    usuario_correo: usuario.correo ?? '',
    uuid_sync: nuevoUuid(),
  }))
  const ids: string[] = []
  for (let i = 0; i < filas.length; i += CHUNK) {
    const lote = filas.slice(i, i + CHUNK)
    const { data, error } = await dataClient.from('rep_activos_fijos').insert(lote).select('id')
    if (error) {
      if (String((error as { code?: string }).code ?? '').includes('23505')) {
        throw new Error('Estos activos ya fueron registrados (reintento detectado — nada se duplicó).')
      }
      throw error
    }
    for (const f of (data ?? []) as Array<{ id: string }>) ids.push(f.id)
  }
  return { ids }
}

/**
 * ANTI-DUPLICADO (M-1): activos del MISMO artículo registrados hace menos de
 * 60 segundos bajo la MISMA guía — pide confirmación antes de insertar
 * (doble clic / doble pestaña). Devuelve cuántas filas recientes hay.
 */
export async function duplicadosRecientesAF(guia: string, articulos: string[]): Promise<number> {
  const hace1min = new Date(Date.now() - 60_000).toISOString()
  const { count, error } = await dataClient
    .from('rep_activos_fijos')
    .select('id', { count: 'exact', head: true })
    .eq('guia', guia.trim())
    .in('articulo', articulos.map((a) => a.trim().toUpperCase()))
    .gte('created_at', hace1min)
  if (error) return 0 // sin red: no bloquear — el uuid_sync cubre el reintento
  return count ?? 0
}

/** «Últimos activos recibidos» — lista para reimpresión y control. */
export async function listarActivosFijos(limite = 40): Promise<ActivoFijoDB[]> {
  const { data, error } = await dataClient
    .from('rep_activos_fijos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limite)
  if (error) throw error
  return (data ?? []) as ActivoFijoDB[]
}

/**
 * RÓTULOS desde filas de BD (alta recién guardada, REIMPRESIÓN y edición).
 * 1 rótulo por activo: código GRANDE (N° de artículo), QR único (id de SU
 * fila), descripción manual + banda META «ACT: … · OC: …» (campos propios
 * del rótulo, no texto pegado — el builder REP la dibuja en la franja
 * inferior de la caja de descripción). CANT 1 ACT — un activo es único.
 */
export function rotulosDesdeActivos(activos: ActivoFijoDB[], ocDocumento?: string): RotuloAImprimir[] {
  return activos.map((a) => ({
    codigo: a.articulo,
    descripcion: a.descripcion || a.articulo,
    cantidad: '1',
    unidad: 'ACT',
    lote: a.guia,
    fechaProduccion: '',
    fechaVencimiento: '',
    recepcionId: a.id,
    activacion: a.activacion ?? undefined,
    oc: (ocDocumento ?? a.oc ?? '').trim() || undefined,
    copias: 1,
  }))
}

/** Agrupa la lista por documento (guía + OC + fecha) para la reimpresión. */
export function agruparPorDocumentoAF(activos: ActivoFijoDB[]): Array<{ clave: string; guia: string; oc: string; fecha: string; activos: ActivoFijoDB[] }> {
  const grupos = new Map<string, { clave: string; guia: string; oc: string; fecha: string; activos: ActivoFijoDB[] }>()
  for (const a of activos) {
    const clave = `${a.fecha}::${a.guia}::${a.oc}`
    const g = grupos.get(clave) ?? { clave, guia: a.guia, oc: a.oc, fecha: a.fecha, activos: [] }
    g.activos.push(a)
    grupos.set(clave, g)
  }
  return [...grupos.values()]
}

/* ═══════════════ EDICIÓN Y ELIMINACIÓN (pedido del usuario 2026-11-17) ═══════════════ */

/** Fila conservada del documento en edición (valores actuales del editor). */
export type FilaEditadaAF = {
  id: string
  articulo: string
  descripcion: string
  activacion: string | null
  conExcepcion: boolean
  /** true = el usuario tocó el contenido de ESTA fila (solo esas se actualizan). */
  contenidoCambio: boolean
}

/** Elimina UN activo por id — verificación honesta: debe desaparecer 1. */
export async function borrarActivoAF(id: string): Promise<void> {
  const { data, error } = await dataClient.from('rep_activos_fijos').delete().eq('id', id).select('id')
  if (error) throw error
  if ((data ?? []).length !== 1) {
    throw new Error('El activo ya no existía (otro usuario lo eliminó antes).')
  }
}

/** Elimina el DOCUMENTO completo (guía + OC + fecha): todas sus filas. */
export async function borrarDocumentoAF(doc: { fecha: string; guia: string; oc: string }): Promise<number> {
  const { data, error } = await dataClient
    .from('rep_activos_fijos')
    .delete()
    .eq('fecha', doc.fecha)
    .eq('guia', doc.guia.trim())
    .eq('oc', (doc.oc ?? '').trim())
    .select('id')
  if (error) throw error
  return (data ?? []).length
}

/** Actualiza UNA fila (contenido editado y/o documento cambiado — el doc vive
 *  denormalizado por fila). Verificación honesta: exige la fila actualizada. */
export async function actualizarActivoFijo(
  fila: FilaEditadaAF,
  doc?: { fecha: string; guia: string; oc: string }
): Promise<void> {
  const cambios: Record<string, unknown> = {
    articulo: fila.articulo.trim().toUpperCase(),
    descripcion: (fila.descripcion ?? '').trim(),
    activacion: fila.activacion?.trim().toUpperCase() || null,
    con_excepcion: fila.conExcepcion,
  }
  if (doc) {
    cambios.fecha = doc.fecha
    cambios.guia = doc.guia.trim()
    cambios.oc = (doc.oc ?? '').trim()
  }
  const { data, error } = await dataClient.from('rep_activos_fijos').update(cambios).eq('id', fila.id).select('id')
  if (error) throw error
  if ((data ?? []).length !== 1) {
    throw new Error(`El activo ${fila.articulo} no se pudo actualizar (quizá otro usuario lo eliminó).`)
  }
}

/**
 * GUARDAR EDICIÓN del documento: actualiza las filas conservadas cuyo
 * contenido cambió (o todas si cambió el documento), borra las eliminadas e
 * inserta las nuevas. Secuencia con verificación por paso (mismo patrón
 * honesto que editar guía); si un paso falla se informa QUÉ se completó.
 */
export async function guardarEdicionAF(params: {
  docOriginal: { fecha: string; guia: string; oc: string }
  docNuevo: { fecha: string; guia: string; oc: string }
  conservadas: FilaEditadaAF[]
  idsEliminados: string[]
  nuevas: ActivoFijoNuevo[]
  usuario: { id: string; nombre: string; correo: string }
}): Promise<{ actualizadas: number; eliminadas: number; nuevasIds: string[]; docCambio: boolean }> {
  const docCambio =
    params.docOriginal.fecha !== params.docNuevo.fecha ||
    params.docOriginal.guia.trim() !== params.docNuevo.guia.trim() ||
    (params.docOriginal.oc ?? '').trim() !== (params.docNuevo.oc ?? '').trim()

  let actualizadas = 0
  for (const fila of params.conservadas) {
    if (fila.contenidoCambio || docCambio) {
      await actualizarActivoFijo(fila, docCambio ? params.docNuevo : undefined)
      actualizadas++
    }
  }
  for (const id of params.idsEliminados) {
    await borrarActivoAF(id)
  }
  const nuevasIds = params.nuevas.length > 0
    ? (await registrarActivosFijos(params.nuevas, params.docNuevo, params.usuario)).ids
    : []
  return { actualizadas, eliminadas: params.idsEliminados.length, nuevasIds, docCambio }
}
