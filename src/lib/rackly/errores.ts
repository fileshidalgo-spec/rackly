
/**
 * RACKLY — Extracción CANÓNICA de mensajes de error (módulo puro, sin UI ni BD).
 *
 * PROBLEMA REAL (reporte 2026-10-29, Tránsito): los errores de PostgREST que
 * supabase-js devuelve en `{ data, error }` son OBJETOS PLANOS
 * `{ message, details, hint, code }` — NO instancias de `Error`. Cualquier
 * handler que haga `err instanceof Error ? err.message : String(err)` los
 * convierte en "[object Object]" (el usuario ve un error inútil y el motivo
 * real queda en la consola).
 *
 * ESTE MÓDULO es la única fuente de verdad para pintar errores al usuario:
 *   · Error nativo (con o sin campos PostgREST extra) → su message.
 *   · PostgrestError plano → message (+ details/hint si aportan algo nuevo).
 *   · String → tal cual.
 *   · { error | msg | message | detalle } → el campo que exista.
 *   · Cualquier otra cosa → JSON.stringify (nunca "[object Object]").
 *   · Convención de RPCs del proyecto "CODE|detalle" → devuelve SOLO el
 *     detalle (los códigos son para branching, no para el operario).
 *
 * Lo consumen: extractError (utils, Kardex/Piso/…), mensajeRpcError
 * (transito-core) y los catch de Atención/Tránsito/Auth — un solo extractor,
 * un solo comportamiento, testeado sin red.
 */

/** Campos que supabase-js adjunta a los errores de PostgREST (objeto plano). */
type PostgrestErrorLike = {
  message?: unknown
  details?: unknown
  hint?: unknown
  code?: unknown
}

/** Texto legible de un campo desconocido, o '' si no aporta nada. */
function campoTexto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Quita el prefijo "CODE|detalle" que usan las RPCs de Rackly para marcar
 * errores controlados (OVER_ISSUE|…, INSUFFICIENT_STOCK|…, NO_AUTORIZADO|…).
 * El operario necesita el detalle; el código solo lo consumen los tests y el
 * branching interno (isInsufficientStockError etc.), que corren ANTES de
 * llegar aquí.
 */
function quitarPrefijoCodigo(msg: string): string {
  const i = msg.indexOf('|')
  // Solo si hay algo después del '|': "OVER_ISSUE|texto" → "texto".
  return i >= 0 && i < msg.length - 1 ? msg.slice(i + 1).trim() : msg
}

/**
 * Extrae el mensaje legible de un error de CUALQUIER forma conocida.
 * NUNCA lanza y NUNCA devuelve "[object Object]".
 */
export function mensajeError(err: unknown): string {
  // 1) Valores vacíos: null/undefined/'' — no hay nada que mostrar.
  if (err == null) return 'Error desconocido'

  // 2) String: tal cual (quitando prefijo de código RPC).
  if (typeof err === 'string') return quitarPrefijoCodigo(err.trim()) || 'Error desconocido'

  // 3) Error nativo: su message. Los PostgrestError NUEVOS (postgrest-js ≥2.x
  //    con .throwOnError()) también son Error y traen code/details/hint.
  if (err instanceof Error) {
    const msg = err.message?.trim() ?? ''
    const rec = err as unknown as PostgrestErrorLike
    // Especial legado (kardex.addMovimiento): Error('INSUFFICIENT_STOCK') con
    // .detail = el texto real — mostrar el detalle, no el código.
    const detail = (err as unknown as { detail?: unknown }).detail
    if (msg === 'INSUFFICIENT_STOCK' && campoTexto(detail)) return campoTexto(detail)
    const extras: string[] = []
    const details = campoTexto(rec.details)
    const hint = campoTexto(rec.hint)
    if (details && !msg.includes(details)) extras.push(details)
    if (hint && !msg.includes(hint)) extras.push(hint)
    const base = msg || 'Error desconocido'
    const completo = extras.length > 0 ? [base, ...extras].join('. ') : base
    return quitarPrefijoCodigo(completo)
  }

  // 4) Objeto plano (PostgrestError de supabase-js SIN throwOnError, respuestas
  //    de fetch, etc.): message + details/hint si aportan.
  if (typeof err === 'object') {
    const rec = err as Record<string, unknown>
    const msg = campoTexto(rec.message) || campoTexto(rec.error) || campoTexto(rec.msg) ||
      campoTexto(rec.detalle)
    const details = campoTexto(rec.details)
    const hint = campoTexto(rec.hint)
    const extras = [details, hint].filter(
      (t) => t && t !== msg && !msg.includes(t)
    )
    const base = msg || ''
    const completo = base && extras.length > 0 ? [base, ...extras].join('. ') : base
    if (completo) return quitarPrefijoCodigo(completo)
    // Último recurso: JSON (los objetos {error:{…}} anidados se ven completos
    // en vez de un inútil "[object Object]").
    try {
      const json = JSON.stringify(err)
      return json && json !== '{}' && json !== '[]' ? json : 'Error desconocido'
    } catch {
      return 'Error desconocido'
    }
  }

  // 5) number/boolean/etc.
  return String(err)
}

/**
 * Mensaje para errores de RPCs con convención "CODE|detalle" — igual que
 * mensajeError (la convención ya se aplica dentro). Se conserva como alias
 * con nombre histórico para los módulos de Tránsito.
 */
export const mensajeRpcCanonica = mensajeError

// ═══════════════════════════════════════════════════════════════════
// ERRORES CONTROLADOS (2026-10-30, auditoría integral):
// Situaciones QUE NO SON ERRORES (el usuario canceló, el reintento ya
// estaba registrado) deben viajar de la capa de datos a la UI sin
// disfrazarse de fallo. La convención antigua los metía EN el message
// como "CODE|texto" — pero mensajeError() quita el prefijo "CODE|" y el
// branch de la UI (message.startsWith('CODE|')) se volvía CÓDIGO MUERTO:
// cancelar un duplicado mostraba un error rojo en vez del aviso previsto.
//
// CONTRATO NUEVO: el código vive en Error.name (sobrevive a mensajeError,
// que solo lee message/details/hint) y el detalle legible en message.
//   · Lanzar:    throw errorControlado(ERR_CANCELADO, 'Registro cancelado…')
//   · Branchar:  const cod = codigoControladoDe(err)
//                if (cod === ERR_CANCELADO) → toast.info(mensajeError(err))
// Los branches con startsWith('CODE|') quedan obsoletos — jamás casaban.
// ═══════════════════════════════════════════════════════════════════

/** Registro cancelado por el usuario (anti-duplicado / anti-guía-duplicada). */
export const ERR_CANCELADO = 'REGISTRO_CANCELADO'
/** Reintento bloqueado por idempotencia: nada nuevo se registró. */
export const ERR_DUPLICADO = 'REGISTRO_DUPLICADO'

const NOMBRES_NATIVOS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AbortError',
  'TimeoutError',
])

/**
 * Crea un Error controlado: `name` = código de branching, `message` = texto
 * legible para el operario (mensajeError(err) lo devuelve tal cual).
 */
export function errorControlado(codigo: string, mensaje: string): Error {
  const e = new Error(mensaje)
  e.name = codigo
  return e
}

/**
 * Código controlado de un error (Error.name si NO es un nombre nativo de
 * JS/DOM), o null. Nunca lanza; acepta cualquier throw.
 */
export function codigoControladoDe(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  const nombre = err.name?.trim() ?? ''
  return nombre && !NOMBRES_NATIVOS.has(nombre) ? nombre : null
}
