'use client'

/**
 * RACKLY — Capa de datos de los módulos Recepción y Atención,
 * más la actividad transversal que consume el módulo Usuarios.
 *
 * Principios de aislamiento (no romper otros módulos):
 *   · Este archivo SOLO consulta/escrive sus propias tablas
 *     (recepcion_registros, atencion_registros) y hace LECTURAS de
 *     movimientos / piso_movimientos para el módulo Usuarios.
 *   · No invoca RPCs ni muta tablas de Racks o Piso.
 *   · Todas las escrituras van por dataClient (anon key + JWT del usuario —
 *     la service_role NO viaja al navegador desde el fix P1 2026-10-21) y
 *     quedan cubiertas por las políticas RLS de cada tabla.
 */

import { dataClient, supabase } from '@/lib/supabase/client'
import { terminoBusquedaSeguro } from '@/lib/rackly/formato'
import {
  ERR_CANCELADO,
  ERR_DUPLICADO,
  ERR_ELIMINAR_BLOQUEADO,
  errorControlado,
} from '@/lib/rackly/errores'
import { exigirBorradas } from '@/lib/rackly/eliminacion-honesta'
import {
  extraerIndicePaleta,
  hayDuplicadosRecientes,
  nuevoUuid,
} from '@/lib/rackly/recepcion-idempotencia'
import { ordenarFilasGuia, planSyncEdicionPorId } from '@/lib/rackly/recepcion-filas'

// ═══════════════════════════════════════════════════════════════════
// TIPOS COMPARTIDOS
// ═══════════════════════════════════════════════════════════════════

export const ESTADOS_RECEPCION = ['Pendiente', 'Recepcionado', 'Recibido', 'Observado'] as const
export const TIPOS_DOCUMENTO_RECEPCION = ['Guia', 'Orden de compra', 'Factura', 'Otro'] as const

/**
 * Estado que se asigna AUTOMÁTICAMENTE al imprimir los rótulos de una guía
 * (pedido del usuario 2026-10: "cuando se dé imprimir dar en estatus
 * automático que se recepcionó"). Solo SUBE desde 'Pendiente' — nunca
 * pisa 'Observado' ni retrocede una guía ya recepcionada/recibida.
 */
export const ESTADO_AL_IMPRIMIR = 'Recepcionado' as const

export const ESTADOS_ATENCION = ['Pendiente', 'En proceso', 'Atendido'] as const
export const TIPOS_ATENCION = ['Consulta', 'Soporte', 'Mantenimiento', 'Otro'] as const

export type RegistroRecepcion = {
  id: string
  createdAt: string
  /** Identidad de la GUÍA completa: todas las filas de una recepción
   *  comparten este uuid (M-2). undefined/null solo en residuos pre-migración. */
  guiaId?: string | null
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía (nivel documento, ej. AJEPER S. A. — 2026-10-22).
   *  Respaldo: filas escritas sin la columna caen al proveedor legacy. */
  empresaOrigen: string
  /** Proveedor del ARTÍCULO (film por fila). En filas legacy trae la empresa
   *  que envía — así se registraban antes de la separación. */
  proveedor: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  placa: string
  fotoUrl: string
  estado: string
  observaciones: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  /** Número de paleta (i de "Paleta i/N"); null si la fila no es una paleta dividida (M-1). */
  nPaleta?: number | null
  /** Nº de envíos de Tránsito registrados sobre ESTA fila (columna transito
   *  jsonb, escrita por la RPC transito_registrar_envio). 0 = sin transferir. */
  enviosTransito?: number
}

export type RegistroAtencion = {
  id: string
  createdAt: string
  fecha: string
  solicitante: string
  area: string
  tipo: string
  asunto: string
  detalle: string
  estado: string
  atendidoEn: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export type NuevoRecepcion = {
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía la guía (encabezado del documento). */
  empresaOrigen?: string
  /** Proveedor del ARTÍCULO (film por fila; '' si no aplica). */
  proveedor: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida?: string
  lote?: string
  fechaProduccion?: string // 'YYYY-MM-DD' o '' = sin dato
  fechaVencimiento?: string
  placa?: string
  fotoUrl?: string
  observaciones: string
  /** uuid_sync generado por el cliente (idempotencia M-1). */
  uuidSync?: string
  /** Número de paleta si la fila viene de un dividido (M-1). */
  nPaleta?: number | null
}

export type NuevoAtencion = {
  fecha: string
  solicitante: string
  area: string
  tipo: string
  asunto: string
  detalle: string
}

type UsuarioCtx = { id: string; nombre: string; correo: string }

// ═══════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════════

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  const n = parseFloat(String(v ?? '0'))
  return isNaN(n) ? 0 : n
}

function str(v: unknown): string {
  return (v as string | null)?.toString() ?? ''
}

/** Nº de envíos de Tránsito en la columna transito (jsonb {v:1, envios:[…]}).
 *  Tolerante a formas viejas/nulas — nunca lanza. */
function contarEnviosTransito(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  const envios = (raw as Record<string, unknown>).envios
  return Array.isArray(envios) ? envios.length : 0
}

function mapRecepcion(r: Record<string, unknown>): RegistroRecepcion {
  // empresa_origen NULL = fila escrita por un bundle viejo (deploy gap):
  // el proveedor legacy ES la empresa que envía → respaldo exacto. '' = la
  // dejaron en blanco a propósito (no cae al proveedor del artículo).
  const empresaRaw = (r.empresa_origen as string | null) ?? null
  return {
    id: r.id as string,
    createdAt: str(r.created_at),
    guiaId: (r.guia_id as string | null) ?? null,
    fecha: str(r.fecha),
    tipoDocumento: str(r.tipo_documento),
    numeroDocumento: str(r.numero_documento),
    empresaOrigen: empresaRaw !== null ? empresaRaw : str(r.proveedor),
    proveedor: str(r.proveedor),
    codigo: str(r.codigo),
    descripcion: str(r.descripcion),
    cantidad: toNum(r.cantidad),
    unidadMedida: str(r.unidad_medida),
    lote: str(r.lote),
    fechaProduccion: str(r.fecha_produccion),
    fechaVencimiento: str(r.fecha_vencimiento),
    placa: str(r.placa),
    fotoUrl: str(r.foto_url),
    estado: str(r.estado),
    observaciones: str(r.observaciones),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
    nPaleta: typeof r.n_paleta === 'number' ? r.n_paleta : null,
    enviosTransito: contarEnviosTransito(r.transito),
  }
}

function mapAtencion(r: Record<string, unknown>): RegistroAtencion {
  return {
    id: r.id as string,
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    solicitante: str(r.solicitante),
    area: str(r.area),
    tipo: str(r.tipo),
    asunto: str(r.asunto),
    detalle: str(r.detalle),
    estado: str(r.estado),
    atendidoEn: str(r.atendido_en),
    usuarioId: str(r.usuario_id),
    usuarioNombre: str(r.usuario_nombre),
    usuarioCorreo: str(r.usuario_correo),
  }
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN — API
// ═══════════════════════════════════════════════════════════════════

export type FiltrosRecepcion = {
  busqueda?: string
  estado?: string // '' = todos
  limit?: number
  offset?: number
}

export async function listarRecepciones(
  filtros: FiltrosRecepcion = {}
): Promise<{ filas: RegistroRecepcion[]; total: number }> {
  const { busqueda = '', estado = '', limit = 50, offset = 0 } = filtros
  let q = dataClient
    .from('recepcion_registros')
    .select('*', { count: 'exact' })
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
  if (estado) q = q.eq('estado', estado)
  // Saneado: una coma/paréntesis en el término rompía el filtro .or() de
  // PostgREST y el listado fallaba con "Error al cargar recepciones".
  const b = terminoBusquedaSeguro(busqueda)
  if (b) {
    const like = `%${b}%`
    // empresa_origen (empresa que envía) + proveedor (proveedor del artículo,
    // 2026-10-22): buscar por cualquiera de los dos.
    q = q.or(`empresa_origen.ilike.${like},proveedor.ilike.${like},codigo.ilike.${like},numero_documento.ilike.${like},descripcion.ilike.${like}`)
  }
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return { filas: (data ?? []).map(mapRecepcion), total: count ?? (data ?? []).length }
}

/**
 * Trae TODAS las filas registradas de UNA MISMA guía/documento. Sirve para
 * la impresión de rótulos agrupada: el modal recibe la guía completa (no
 * solo la fila clickeada) y imprime todos sus artículos en UN solo trabajo.
 *
 * Identidad de la guía (M-2, corrección 2026-10 "que al imprimir SOLO salga
 * lo de la guía y no jale de otras guías"):
 *   · PREFERENTE: `guiaId` (uuid compartido por las filas de UNA misma
 *     recepción) — filtro EXACTO, jamás cruza guías aunque compartan
 *     Nº de documento, fecha o proveedor.
 *   · Respaldo (fila sin guia_id, residuo pre-migración): con Nº →
 *     tipo_documento + numero_documento; sin Nº → fecha + proveedor + tipo.
 *
 * Orden estable por created_at (los artículos aparecen en el orden en que
 * se registraron) + desempates DETERMINISTICOS dentro del mismo instante:
 * las filas de UNA guardada comparten created_at EXACTO (16 filas en el
 * mismo microsegundo en T173-00004281) y Postgres puede devolverlas en
 * ORDEN ARBITRARIO — el re-ensamblado de paletas (filasAItems) y la
 * impresión eran no-deterministas entre aperturas. Desempate: codigo →
 * n_paleta (1..N juntas, sin marcar las filas sin dividir) → id.
 * Solo devuelve datos YA registrados (regla de negocio: nunca se imprime
 * desde el formulario sin guardar).
 */
export async function listarRecepcionesPorDocumento(ref: {
  guiaId?: string | null
  tipoDocumento: string
  numeroDocumento: string
  fecha?: string
  proveedor?: string
}): Promise<RegistroRecepcion[]> {
  let q = dataClient.from('recepcion_registros').select('*')
  const guiaId = (ref.guiaId ?? '').trim()
  if (guiaId) {
    q = q.eq('guia_id', guiaId)
  } else {
    q = q.eq('tipo_documento', ref.tipoDocumento.trim())
    if (ref.numeroDocumento.trim()) {
      q = q.eq('numero_documento', ref.numeroDocumento.trim())
    } else {
      q = q
        .eq('fecha', (ref.fecha ?? '').trim())
        .eq('proveedor', (ref.proveedor ?? '').trim())
    }
  }
  const { data, error } = await q
    .order('created_at', { ascending: true })
    .order('codigo', { ascending: true })
    .order('n_paleta', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
  if (error) throw error
  const registradas = (data ?? []).map(mapRecepcion)
  // CONTIGÜIDAD de grupos (auditoría 2026-10-31, guía T012-00000192): el
  // desempate determinista por n_paleta es necesario (32 filas de UN
  // guardado comparten created_at EXACTO y Postgres puede devolverlas en
  // orden arbitrario), pero INTERCALA dos grupos del mismo artículo con N
  // distinto (1/27, 1/5, 2/27, 2/5…) — filasAItems los fragmentaba y un
  // guardado del editor habría DESTRUIDO la división. Reorden en JS
  // determinista: cada grupo 1..N junto, sin mover grupos entre sí —
  // beneficioso para detalle, impresión de rótulos y edición.
  return ordenarFilasGuia(registradas)
}

/**
 * Registra UNA recepción de N artículos: cada artículo se guarda como su
 * propia fila (compatible con búsqueda por código, actividad y listado)
 * compartiendo el encabezado del documento (guía, proveedor, placa, foto).
 */
export async function crearRecepciones(
  items: NuevoRecepcion[],
  usuario: UsuarioCtx
): Promise<string> {
  // M-2: UNA identidad de guía para TODO el lote — las filas de esta
  // recepción quedan unidas por guia_id aunque el Nº/proveedor/fecha
  // cambien después al editar. Se devuelve al llamador para fijar la
  // "guía recién registrada" (banner) y la impresión agrupada exacta.
  const guiaId = nuevoUuid()
  if (items.length === 0) return guiaId

  // ANTI-DUPLICADO (M-1): si una fila idéntica se registró hace menos de
  // 60 segundos, pedir confirmación antes de insertar (doble clic, doble
  // pestaña o recarga a mitad del registro).
  if (await hayDuplicadosRecientes(items)) {
    const primera = items[0]
    const ok = window.confirm(
      'Ya existe una fila idéntica registrada hace menos de 1 minuto ' +
        `(documento ${primera.numeroDocumento.trim() || '—'}, código ${primera.codigo.trim() || '—'}, ` +
        `cantidad ${primera.cantidad}).\n\n¿Registrar de todos modos?`
    )
    // errorControlado (errores.ts): el código viaja en Error.name — los
    // branches de la UI ramifican por codigoControladoDe(err). La convención
    // vieja "CODE|texto" era código muerto: mensajeError() quitaba el
    // prefijo ANTES del startsWith y la cancelación se pintaba como error.
    if (!ok) throw errorControlado(ERR_CANCELADO, 'Registro cancelado por posible duplicado.')
  }

  // ANTI-GUÍA-DUPLICADA (Task 23): el mismo Nº de documento registrado 2
  // veces crea DOS guías con rótulos idénticos a la vista — al escanear el
  // QR, cada rótulo resuelve a su registro y el operario ve datos distintos
  // para "la misma" guía (casos reales T173-00004192 y T012-00000188).
  // NO bloquea (puede ser una carga distinta legítima): avisa con el
  // contexto y deja que el operario decida — decisión informada, no sorpresa.
  const docNuevo = (items[0]?.numeroDocumento ?? '').trim()
  if (docNuevo) {
    const { data: previa, error: errPrev } = await dataClient
      .from('recepcion_registros')
      .select('fecha, created_at')
      .eq('numero_documento', docNuevo)
      .order('created_at', { ascending: false })
      .limit(1)
    if (!errPrev && previa && previa.length > 0) {
      const p = previa[0] as { fecha: string | null; created_at: string | null }
      const cuando = p.fecha
        ? `el ${p.fecha}`
        : p.created_at
          ? `el ${new Date(p.created_at).toLocaleDateString('es-PE')}`
          : 'anteriormente'
      const ok = window.confirm(
        `El documento ${docNuevo} YA fue registrado ${cuando}.\n\n` +
          'Si es LA MISMA carga: cancela y ábrela desde la lista de Recepción ' +
          '(registrarla otra vez duplica sus rótulos QR y confunde el escaneo).\n\n' +
          '¿Registrar de todos modos como carga distinta?'
      )
      if (!ok) throw errorControlado(ERR_CANCELADO, 'Registro cancelado: el documento ya estaba registrado.')
    }
  }

  const filas = items.map((datos) => ({
    fecha: datos.fecha,
    tipo_documento: datos.tipoDocumento,
    numero_documento: datos.numeroDocumento.trim(),
    empresa_origen: (datos.empresaOrigen ?? '').trim(),
    proveedor: datos.proveedor.trim(),
    codigo: datos.codigo.trim().toUpperCase(),
    descripcion: datos.descripcion.trim(),
    cantidad: datos.cantidad,
    unidad_medida: (datos.unidadMedida ?? '').trim().toUpperCase(),
    lote: (datos.lote ?? '').trim(),
    fecha_produccion: datos.fechaProduccion?.trim() || null,
    fecha_vencimiento: datos.fechaVencimiento?.trim() || null,
    placa: (datos.placa ?? '').trim().toUpperCase(),
    foto_url: datos.fotoUrl?.trim() || null,
    observaciones: datos.observaciones.trim() || null,
    estado: 'Pendiente',
    guia_id: guiaId,
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
    // IDEMPOTENCIA (M-1): uuid_sync del cliente (índice único parcial en BD)
    // y n_paleta persistido — antes solo vivía en memoria como "Paleta i/N".
    uuid_sync: datos.uuidSync?.trim() || nuevoUuid(),
    n_paleta: datos.nPaleta ?? extraerIndicePaleta(datos.observaciones),
  }))
  // FIX auditoría 2026-10-16: inserción por LOTES de 500 — antes iba TODO en
  // UNA petición (30 artículos × 44 paletas = hasta 1.320 filas, ~payload
  // grande con riesgo timeout/413 y todo-o-nada). Mismo patrón que
  // addMovimientosBatch/mergeCatalogo. El índice único de uuid_sync mantiene
  // la idempotencia entre chunks (reintento tras éxito parcial detecta
  // duplicados y avisa).
  const CHUNK = 500
  for (let i = 0; i < filas.length; i += CHUNK) {
    const { error } = await dataClient.from('recepcion_registros').insert(filas.slice(i, i + CHUNK))
    if (error) {
      // Reintento tras éxito perdido: el índice único de uuid_sync marca el
      // duplicado — se informa como aviso, no como error técnico.
      if (String((error as { code?: string }).code ?? '').includes('23505')) {
        throw errorControlado(ERR_DUPLICADO, 'Estas filas ya fueron registradas (reintento detectado).')
      }
      throw error
    }
  }
  return guiaId
}

/**
 * Sube la foto de la guía al bucket `recepcion-guias` y devuelve SOLO LA
 * RUTA del objeto (p. ej. "<usuarioId>/<timestamp>.jpg") — NUNCA una URL
 * pública: el bucket es privado (H-2) y la imagen se sirve mediante URL
 * firmada con expiración (ver urlFirmadaGuia/abrirFotoGuia).
 * Ruta por usuario + timestamp para evitar colisiones.
 *
 * Usa fetch directo al Storage API (probado en producción): el cliente
 * storage.upload() de supabase-js devolvía 400 en este entorno.
 */
export async function subirFotoGuia(archivo: Blob, usuarioId: string): Promise<string> {
  // FIX auditoría 2026-10-21 (P1): la service_role key ya no viaja al
  // navegador. La subida usa el JWT de la sesión (rol authenticated) — el
  // bucket recepcion-guias tiene políticas para autenticados (SELECT/INSERT/
  // UPDATE/DELETE, hardening 2026-10-16), así que el comentario antiguo sobre
  // "sin políticas de Storage" ya no aplica.
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!base || !anon) throw new Error('Configuración de Supabase incompleta')
  if (!token) throw new Error('Sesión expirada: vuelve a iniciar sesión para adjuntar la foto')
  const ruta = `${usuarioId}/${Date.now()}.jpg`
  const res = await fetch(`${base}/storage/v1/object/recepcion-guias/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: anon,
      authorization: `Bearer ${token}`,
      'content-type': 'image/jpeg',
      'x-upsert': 'false',
    },
    body: archivo,
  })
  if (!res.ok) {
    const detalle = await res.text().catch(() => '')
    throw new Error(`Storage ${res.status}: ${detalle.slice(0, 140)}`)
  }
  return ruta
}

/**
 * Extrae la ruta del objeto a partir de lo almacenado en foto_url: acepta
 * la forma nueva (solo ruta) y la heredada (URL pública completa previa a
 * la privatización del bucket, H-2).
 */
export function rutaObjetoGuia(fotoUrl: string): string | null {
  const valor = (fotoUrl ?? '').trim()
  if (!valor) return null
  const marcador = '/storage/v1/object/public/recepcion-guias/'
  const i = valor.indexOf(marcador)
  if (i >= 0) return valor.slice(i + marcador.length)
  const marcadorPriv = '/storage/v1/object/authenticated/recepcion-guias/'
  const j = valor.indexOf(marcadorPriv)
  if (j >= 0) return valor.slice(j + marcadorPriv.length)
  return valor.includes('/') ? valor : null
}

/**
 * Genera una URL FIRMADA (1 hora por defecto) para ver la foto de una guía
 * del bucket privado recepcion-guias (H-2). Devuelve null si no hay ruta
 * válida o si la firma falla.
 */
export async function urlFirmadaGuia(fotoUrl: string, segundos = 3600): Promise<string | null> {
  const ruta = rutaObjetoGuia(fotoUrl)
  if (!ruta) return null
  // FIX auditoría 2026-10-21 (P1): firma con el JWT de la sesión del usuario
  // (el bucket privado tiene política SELECT para autenticados). La versión
  // anterior firmaba con la service_role key expuesta en el bundle.
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!base || !anon) return null
  if (!token) {
    console.warn('[modulos] Sin sesión activa: no se puede firmar la foto de la guía')
    return null
  }
  try {
    const res = await fetch(`${base}/storage/v1/object/sign/recepcion-guias/${ruta}`, {
      method: 'POST',
      headers: {
        apikey: anon,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: segundos }),
    })
    if (!res.ok) {
      const detalle = await res.text().catch(() => '')
      console.warn('[modulos] sign', res.status, 'para', ruta, ':', detalle.slice(0, 140))
      return null
    }
    const d = (await res.json()) as { signedURL?: string }
    if (!d.signedURL) return null
    return `${base}/storage/v1${d.signedURL}`
  } catch (err) {
    console.warn('[modulos] No se pudo firmar la foto de la guía:', err)
    return null
  }
}

/**
 * Abre la foto de la guía en una pestaña nueva con URL firmada (H-2).
 * Reemplaza al antiguo <a href=URL pública>: el bucket ya no sirve URLs
 * públicas, así que la URL se firma en el momento del clic.
 */
export async function abrirFotoGuia(fotoUrl: string): Promise<void> {
  const url = await urlFirmadaGuia(fotoUrl)
  if (!url) {
    console.warn('[modulos] Foto de la guía no disponible (sin ruta o sin firma)')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function cambiarEstadoRecepcion(id: string, estado: string): Promise<void> {
  const { error } = await dataClient
    .from('recepcion_registros')
    .update({ estado })
    .eq('id', id)
  if (error) throw error
}

export async function eliminarRecepcion(id: string): Promise<void> {
  // HONESTIDAD (bug T173-00004281): la BD puede FILTRAR el delete en
  // silencio (RLS por rol: HTTP 200 con 0 filas borradas, sin error) — un
  // éxito falso aquí dejaba la fila viva «borrada» ante la app.
  // Verificación centralizada en eliminacion-honesta.ts (auditoría 10-31).
  const { data: borradas, error } = await dataClient
    .from('recepcion_registros')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  exigirBorradas(
    borradas,
    1,
    'La fila NO se eliminó (tu rol no permite borrar este registro, o ya fue eliminado por otro usuario). Recarga la lista.'
  )
}

/**
 * Referencia a UN documento completo (guía) de recepción. Identidad M-2:
 * `guiaId` (uuid de la recepción) cuando existe — exacto, jamás cruza
 * guías; respaldo heredado: con Nº → tipo+número; sin Nº → fecha+tipo+proveedor.
 */
export type RefDocumentoRecepcion = {
  guiaId?: string | null
  tipoDocumento: string
  numeroDocumento: string
  fecha?: string
  proveedor?: string
}

/** Condiciones [columna, valor] que identifican a UNA guía (sin Nº → fecha+proveedor).
 *  Respaldo para filas sin guia_id (pre-migración); con guiaId presente NUNCA se usa. */
function condicionesGuia(ref: RefDocumentoRecepcion): Array<[string, string]> {
  const conds: Array<[string, string]> = [['tipo_documento', ref.tipoDocumento.trim()]]
  if (ref.numeroDocumento.trim()) {
    conds.push(['numero_documento', ref.numeroDocumento.trim()])
  } else {
    conds.push(['fecha', (ref.fecha ?? '').trim()])
    conds.push(['proveedor', (ref.proveedor ?? '').trim()])
  }
  return conds
}

/**
 * Cambia el estado de TODAS las filas de UNA guía (el registro agrupado
 * muestra 1 fila por guía; el estado es del documento completo).
 * M-2: con `guiaId` el update va por identidad EXACTA (jamás toca otra
 * guía que comparta Nº/fecha/proveedor).
 */
export async function cambiarEstadoGuia(
  ref: RefDocumentoRecepcion,
  estado: string
): Promise<void> {
  let q = dataClient.from('recepcion_registros').update({ estado })
  const guiaId = (ref.guiaId ?? '').trim()
  if (guiaId) {
    q = q.eq('guia_id', guiaId)
  } else {
    for (const [col, val] of condicionesGuia(ref)) q = q.eq(col, val)
  }
  const { error } = await q
  if (error) throw error
}

/**
 * Elimina TODAS las filas de UNA guía (el borrado agrupado espeja el
 * registro agrupado: el documento completo entra y sale junto).
 * M-2: con `guiaId` el delete va por identidad EXACTA.
 */
export async function eliminarGuia(ref: RefDocumentoRecepcion): Promise<void> {
  let q = dataClient.from('recepcion_registros').delete()
  const guiaId = (ref.guiaId ?? '').trim()
  if (guiaId) {
    q = q.eq('guia_id', guiaId)
  } else {
    for (const [col, val] of condicionesGuia(ref)) q = q.eq(col, val)
  }
  // HONESTIDAD (bug T173-00004281): RLS puede filtrar el borrado en
  // silencio (rol sin permiso de DELETE → HTTP 200, 0 filas). Se piden las
  // filas borradas de vuelta: si quedaba ALGO por borrar y no se borró
  // NADA (o quedó una parte), el usuario lo sabe AHORA — no una «guía
  // eliminada» que reaparece intacta al recargar.
  const { data: borradas, error } = await q.select('id')
  if (error) throw error
  exigirBorradas(
    borradas,
    1,
    'La guía NO se eliminó: tu rol no permite borrar sus filas (p. ej. filas registradas por otro usuario). Pide el borrado a un supervisor/administrador.'
  )
}

/**
 * AUTO-ESTATUS AL IMPRIMIR (pedido 2026-10): marca la guía como
 * 'Recepcionado' cuando sus rótulos se enviaron a la impresora.
 *
 * Escoped sin conflictos:
 *   · SOLO SUBE desde 'Pendiente' — una guía 'Observado' conserva su
 *     observación y una ya 'Recepcionado'/'Recibido' no retrocede.
 *   · Con `guiaId` va por identidad exacta (jamás marca otra guía).
 *   · Devuelve el nº de filas marcadas (0 = ya no estaba Pendiente).
 */
export async function marcarGuiaRecepcionada(
  ref: RefDocumentoRecepcion
): Promise<number> {
  let q = dataClient
    .from('recepcion_registros')
    .update({ estado: ESTADO_AL_IMPRIMIR })
    .eq('estado', 'Pendiente')
  const guiaId = (ref.guiaId ?? '').trim()
  if (guiaId) {
    q = q.eq('guia_id', guiaId)
  } else {
    for (const [col, val] of condicionesGuia(ref)) q = q.eq(col, val)
  }
  const { data, error } = await q.select('id')
  if (error) throw error
  return (data ?? []).length
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN — EDICIÓN DE UNA GUÍA YA REGISTRADA
// ═══════════════════════════════════════════════════════════════════

/** Contenido editable de UNA fila de la guía. `filaId` (opcional) es el id
 *  de la fila YA registrada que esta fila actualiza (edición por identidad;
 *  adjuntado por filasAItems → expandirEnFilas). null/ausente = fila nueva.
 *  `uuidSync` (opcional, SOLO filas nuevas): idempotencia M-1 en la EDICIÓN
 *  (FIX auditoría 2026-10-30, R2) — la UI genera UNO estable por fila nueva
 *  al montar el editor y lo conserva ante reintentos; si el insert tiene
 *  éxito pero la respuesta se pierde (red), el reintento con el MISMO
 *  uuid_sync choca con el índice único y NO duplica la fila. */
export type FilaEdicionGuia = {
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Proveedor del ARTÍCULO de esta fila ('' si no aplica). */
  proveedor: string
  /** Observaciones del usuario + marca "Paleta i/N" si la fila es una paleta. */
  observaciones: string
  filaId?: string | null
  uuidSync?: string | null
}

/** Encabezado (común a todas las filas) aplicado al guardar la edición. */
export type EncabezadoEdicionGuia = {
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía (nivel documento). */
  empresaOrigen: string
  /** LEGADO: se mantiene escribiendo el encabezado en `proveedor` de filas
   *  cuyo artículo no trae proveedor propio (compat filas legacy). */
  proveedor: string
  placa: string
  /** Estado del documento: las filas nuevas lo heredan. */
  estado: string
  /** Foto de la guía: solo las filas NUEVAS la reciben (las viejas la conservan). */
  fotoUrl: string
  /** M-2: identidad de la guía — las filas NUEVAS la reciben para seguir
   *  unidas a SU documento (las viejas ya la traen y el UPDATE no la toca). */
  guiaId?: string | null
}

/**
 * Guarda la edición de UNA guía ya registrada SIN riesgo de pérdida de datos
 * y SIN cruzar contenido entre filas.
 *
 * Sincronización POR IDENTIDAD (nunca posicional, nunca "borrar todo y
 * reinsertar"): cada fila trae el `filaId` de la fila de la BD de la que
 * nació (filasAItems → expandirEnFilas), así que quitar/dividir/agregar
 * artículos o paletas NO desplaza el alineamiento (el antiguo sincronizado
 * posicional escribía el artículo N sobre la fila M — corrupción silenciosa
 * que además desenganchaba el historial de Tránsito).
 *
 * El plan (planSyncEdicionPorId) separa 3 pasos, en este orden:
 *   1) UPDATE por SU PROPIO id de las filas que persisten — verificando que
 *      cada update efectivamente tocó su fila (si otro usuario borró la guía
 *      mientras se editaba, se ABORTA antes de tocar nada más).
 *   2) INSERT de SOLO las filas nuevas (artículos/paletas agregados).
 *   3) DELETE por id, SOLO de las filas sobrantes (al final: si un paso
 *      falla a mitad, quedan filas de más — recuperables — nunca de menos).
 *
 * Cada paso es independiente y reintentable. El cambio de Nº de guía viaja
 * en el UPDATE (por id), así que renombrar el documento no rompe la
 * identidad de las filas existentes.
 */
export async function guardarEdicionGuia(
  idsOriginales: string[],
  filasNuevas: FilaEdicionGuia[],
  encabezado: EncabezadoEdicionGuia,
  autor: UsuarioCtx,
  usuarioActualId?: string
): Promise<{ actualizadas: number; eliminadas: number; insertadas: number }> {
  const plan = planSyncEdicionPorId(idsOriginales, filasNuevas)

  // GUARD Tránsito (edición) — ANTES de escribir NADA: si el usuario quitó
  // filas que ya fueron transferidas por Tránsito, ABORTAR en seco. Borrar
  // esas filas dejaría el ingreso en kardex/piso como stock huérfano y el
  // semáforo sin origen (misma política que el borrado de guía completa).
  // Muy aparte, cierra el vector "estuvieron trabajando con una guía y
  // desapareció": ninguna edición puede eliminar filas transferidas.
  //
  // GUARD de propiedad (mismo vuelo, bug T173-00004281): la política RLS
  // solo permite DELETE a supervisores+ (y desde 2026-10-30 también al
  // DUEÑO de cada fila sin envíos). Si el usuario actual quita filas que
  // no puede borrar, el DELETE se FILTRA EN SILENCIO (HTTP 200, 0 filas,
  // sin error) — la app creía el guardado y las filas seguían vivas: la
  // guía se DUPLICABA al re-agregar los artículos (16→23→36→50→63 filas).
  // Se detecta AQUÍ, antes de tocar nada, mirando usuario_id de las filas
  // a borrar contra la sesión (usuarioActualId).
  if (plan.eliminar.length > 0) {
    const { data: protegidas, error: errGuard } = await dataClient
      .from('recepcion_registros')
      .select('id, transito, usuario_id')
      .in('id', plan.eliminar)
    if (errGuard) throw errGuard
    const conEnvios = (protegidas ?? []).filter(
      (f: Record<string, unknown>) => contarEnviosTransito(f.transito) > 0
    ).length
    if (conEnvios > 0) {
      throw new Error(
        `No se puede guardar: estás quitando ${conEnvios} fila(s) ya transferidas por Tránsito. ` +
          'Restáuralas en el editor (o revierte los traslados en el módulo Tránsito) y vuelve a guardar — ' +
          'eliminarlas dejaría stock huérfano sin trazabilidad.'
      )
    }
    const actual = (usuarioActualId ?? '').trim()
    const ajenas = actual
      ? (protegidas ?? []).filter(
          (f: Record<string, unknown>) => String(f.usuario_id ?? '').trim() !== actual
        ).length
      : 0
    if (ajenas > 0) {
      // FIX 2026-10-31 (T173-00004274 · regularización de sobrante): el guard
      // era CIEGO AL ROL — bloqueaba a CUALQUIER usuario que quitara filas de
      // otro, INCLUSO a un admin/supervisor con `recepcion.eliminar`, aunque
      // las políticas RLS de la tabla SÍ lo permiten (permissive
      // recepcion_delete_auth/_permiso bajo la restrictive
      // recepcion_delete_restr = tiene_permiso). Guard más estricto que la BD
      // = guía imposible de corregir (sobrante 172 vs 150 sin regularizar).
      // Ahora pregunta a la MISMA función que usa la BD (tiene_permiso RPC):
      // con el permiso, el DELETE de filas ajenas SIN envíos pasa de verdad
      // (la honestidad del paso 3 sigue validando el efecto real); sin él,
      // se mantiene el bloqueo original — ningún caso nuevo queda expuesto.
      let puedeEliminarAjenas = false
      try {
        const { data: okPermiso, error: errPermiso } = await dataClient.rpc('tiene_permiso', {
          p_user_id: actual,
          p_permiso: 'recepcion.eliminar',
        })
        if (errPermiso) throw errPermiso
        puedeEliminarAjenas = okPermiso === true
      } catch {
        // Si la consulta del permiso falla (red/sesión), la política segura
        // es el comportamiento anterior: NO asumir el permiso.
        puedeEliminarAjenas = false
      }
      if (!puedeEliminarAjenas) {
        throw errorControlado(
          ERR_ELIMINAR_BLOQUEADO,
          `Estás quitando ${ajenas} fila(s) registrada(s) por OTRO usuario: tu rol no puede borrarlas, así que el guardado dejaría duplicados. ` +
            'Quita esas filas con un supervisor/administrador (o quien tenga el permiso "Eliminar guías"), ' +
            'usa la acción "Regularizar" de Tránsito sobre la fila flotante, o restaura las filas en el editor y guarda.'
        )
      }
    }
  }

  const contenidoDe = (f: FilaEdicionGuia) => ({
    fecha: encabezado.fecha,
    tipo_documento: encabezado.tipoDocumento,
    numero_documento: encabezado.numeroDocumento.trim(),
    empresa_origen: encabezado.empresaOrigen.trim(),
    // Proveedor del ARTÍCULO por fila; una fila sin proveedor propio hereda
    // el del encabezado (LEGADO: guía vieja donde el campo era la empresa).
    proveedor: (f.proveedor || encabezado.proveedor).trim(),
    placa: encabezado.placa.trim().toUpperCase(),
    codigo: f.codigo.trim().toUpperCase(),
    descripcion: f.descripcion.trim(),
    cantidad: f.cantidad,
    unidad_medida: (f.unidadMedida ?? '').trim().toUpperCase(),
    lote: (f.lote ?? '').trim(),
    fecha_produccion: f.fechaProduccion?.trim() || null,
    fecha_vencimiento: f.fechaVencimiento?.trim() || null,
    observaciones: f.observaciones.trim() || null,
    // M-1: el nº de paleta se recalcula desde la marca "Paleta i/N" de la
    // propia fila (la edición puede re-dividir o unir paletas).
    n_paleta: extraerIndicePaleta(f.observaciones),
  })

  // 1) UPDATE de las filas que persisten (por id — preserva usuario, foto,
  //    estado y created_at de cada fila). Se pide la fila de vuelta para
  //    detectar el caso "la fila ya no existe" (guía borrada/renombrada por
  //    otro usuario mientras se editaba): abortar ANTES de insertar/borrar.
  for (const { id, fila } of plan.actualizar) {
    const { data, error } = await dataClient
      .from('recepcion_registros')
      .update(contenidoDe(fila))
      .eq('id', id)
      .select('id', { count: 'exact' })
    if (error) throw error
    if (!data || data.length === 0) {
      throw new Error(
        'La fila ya no existe en la guía (otro usuario la modificó o la borró). Recarga el registro y vuelve a intentarlo.'
      )
    }
  }

  // 2) INSERT de solo las filas nuevas (heredan encabezado, autor y estado).
  //    Cada fila nueva lleva SU uuid_sync (idempotencia M-1 — en la edición
  //    la UI entrega uno ESTABLE por fila (FilaEdicionGuia.uuidSync); si no
  //    viene, se genera aquí como antes), SU n_paleta y LA IDENTIDAD DE LA
  //    GUÍA (guia_id, M-2): seguirá unida a SU documento en impresión/
  //    edición/estado/borrado aunque cambie el encabezado.
  if (plan.insertar.length > 0) {
    const { error } = await dataClient
      .from('recepcion_registros')
      .insert(
        plan.insertar.map((f) => ({
          ...contenidoDe(f),
          foto_url: encabezado.fotoUrl?.trim() || null,
          estado: encabezado.estado || 'Pendiente',
          guia_id: encabezado.guiaId?.trim() || null,
          usuario_id: autor.id,
          usuario_nombre: autor.nombre,
          usuario_correo: autor.correo,
          uuid_sync: f.uuidSync?.trim() || nuevoUuid(),
        }))
      )
    if (error) {
      // M-1 en la edición: un reintento tras éxito perdido choca con el
      // índice único de uuid_sync — aviso claro, no error técnico (23505).
      if (String((error as { code?: string }).code ?? '').includes('23505')) {
        throw errorControlado(ERR_DUPLICADO, 'Las filas nuevas ya habían sido guardadas (reintento detectado).')
      }
      throw error
    }
  }

  // 3) DELETE por id SOLO de las filas sobrantes (al final — ver docstring).
  //    HONESTIDAD (bug T173-00004281): el DELETE se pide con las filas de
  //    vuelta — si la BD borró MENOS de las planificadas (RLS filtrando por
  //    rol, fila ya borrada por otro usuario), se lanza un error CLARO en
  //    vez de un éxito falso que duplicaba la guía. Queda como red de
  //    seguridad aunque el guard de propiedad ya frenó el caso conocido.
  if (plan.eliminar.length > 0) {
    const { data: borradas, error } = await dataClient
      .from('recepcion_registros')
      .delete()
      .in('id', plan.eliminar)
      .select('id')
    if (error) throw error
    const borradasDeVerdad = exigirBorradas(
      borradas,
      plan.eliminar.length,
      `El guardado NO se completó: solo se borraron ${(borradas ?? []).length} de ${plan.eliminar.length} ` +
        'fila(s) que quitaste (tu rol no permite borrarlas). Recarga la guía — las filas quitadas siguen registradas y NO se duplicaron.'
    )
    // El conteo devuelto refleja el EFECTO REAL (no el plan).
    return {
      actualizadas: plan.actualizar.length,
      eliminadas: borradasDeVerdad,
      insertadas: plan.insertar.length,
    }
  }

  return {
    actualizadas: plan.actualizar.length,
    eliminadas: plan.eliminar.length,
    insertadas: plan.insertar.length,
  }
}

// ═══════════════════════════════════════════════════════════════════
// ATENCIÓN — API
// ═══════════════════════════════════════════════════════════════════

export type FiltrosAtencion = {
  busqueda?: string
  estado?: string // '' = todos
  limit?: number
  offset?: number
}

export async function listarAtenciones(
  filtros: FiltrosAtencion = {}
): Promise<{ filas: RegistroAtencion[]; total: number }> {
  const { busqueda = '', estado = '', limit = 50, offset = 0 } = filtros
  let q = dataClient
    .from('atencion_registros')
    .select('*', { count: 'exact' })
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false })
  if (estado) q = q.eq('estado', estado)
  // Mismo saneo que Recepción (la falla estaba repetida aquí).
  const b = terminoBusquedaSeguro(busqueda)
  if (b) {
    const like = `%${b}%`
    q = q.or(`solicitante.ilike.${like},area.ilike.${like},asunto.ilike.${like},tipo.ilike.${like}`)
  }
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return { filas: (data ?? []).map(mapAtencion), total: count ?? (data ?? []).length }
}

export async function crearAtencion(datos: NuevoAtencion, usuario: UsuarioCtx): Promise<void> {
  const { error } = await dataClient.from('atencion_registros').insert({
    fecha: datos.fecha,
    solicitante: datos.solicitante.trim(),
    area: datos.area.trim(),
    tipo: datos.tipo,
    asunto: datos.asunto.trim(),
    detalle: datos.detalle.trim() || null,
    estado: 'Pendiente',
    usuario_id: usuario.id,
    usuario_nombre: usuario.nombre,
    usuario_correo: usuario.correo,
  })
  if (error) throw error
}

export async function cambiarEstadoAtencion(id: string, estado: string): Promise<void> {
  // Al pasar a 'Atendido' se sella la hora de cierre; al retroceder se limpia.
  const patch: Record<string, unknown> = { estado }
  if (estado === 'Atendido') patch.atendido_en = new Date().toISOString()
  else patch.atendido_en = null
  const { error } = await dataClient
    .from('atencion_registros')
    .update(patch)
    .eq('id', id)
  if (error) throw error
}

export async function eliminarAtencion(id: string): Promise<void> {
  // HONESTIDAD (patrón T173-00004281, repetido en otras pestañas): la
  // política RLS de esta tabla también filtra el DELETE por rol en
  // silencio — se verifica el efecto real.
  const { data: borradas, error } = await dataClient
    .from('atencion_registros')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  exigirBorradas(
    borradas,
    1,
    'El registro NO se eliminó (tu rol no permite borrar, o ya fue eliminado). Recarga la lista.'
  )
}

// ═══════════════════════════════════════════════════════════════════
// ACTIVIDAD TRANSVERSAL (módulo Usuarios → conecta todos los módulos)
// Solo lectura. Unifica en una fila común los movimientos de cada módulo.
// ═══════════════════════════════════════════════════════════════════

export type ModuloActividad = 'racks' | 'piso' | 'recepcion' | 'atencion'

export const ETIQUETA_MODULO: Record<ModuloActividad, string> = {
  racks: 'Racks',
  piso: 'Piso',
  recepcion: 'Recepción',
  atencion: 'Atención',
}

export type FilaActividad = {
  id: string
  fecha: string // fecha principal (date o timestamp ISO)
  tipo: string
  titulo: string // código / asunto / documento / operación
  detalle: string
  cantidad: number | null
  estado: string | null
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
}

export async function listarActividad(
  modulo: ModuloActividad,
  usuarioId: string | null, // null = todos los usuarios
  limit = 100,
  offset = 0
): Promise<{ filas: FilaActividad[]; total: number }> {
  if (modulo === 'racks') {
    let q = dataClient
      .from('movimientos')
      .select('id, f_modificacion, tipo, codigo, descripcion, cantidad, lote, usuario_id, usuario_nombre, usuario_correo', { count: 'exact' })
      .order('f_modificacion', { ascending: false })
    if (usuarioId) q = q.eq('usuario_id', usuarioId)
    q = q.range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw error
    return {
      filas: (data ?? []).map((r) => ({
        id: r.id as string,
        fecha: str(r.f_modificacion),
        tipo: str(r.tipo),
        titulo: str(r.codigo),
        detalle: str(r.descripcion) + (r.lote ? ` · Lote ${str(r.lote)}` : ''),
        cantidad: toNum(r.cantidad),
        estado: null,
        usuarioId: str(r.usuario_id),
        usuarioNombre: str(r.usuario_nombre),
        usuarioCorreo: str(r.usuario_correo),
      })),
      total: count ?? 0,
    }
  }

  if (modulo === 'piso') {
    let q = dataClient
      .from('piso_movimientos')
      .select('id, numero_operacion, tipo, fecha, usuario_id, usuario_nombre, usuario_correo', { count: 'exact' })
      .order('numero_operacion', { ascending: false })
    if (usuarioId) q = q.eq('usuario_id', usuarioId)
    q = q.range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw error
    return {
      filas: (data ?? []).map((r) => ({
        id: r.id as string,
        fecha: str(r.fecha),
        tipo: str(r.tipo),
        titulo: `Operación #${str(r.numero_operacion)}`,
        detalle: '',
        cantidad: null,
        estado: null,
        usuarioId: str(r.usuario_id),
        usuarioNombre: str(r.usuario_nombre),
        usuarioCorreo: str(r.usuario_correo),
      })),
      total: count ?? 0,
    }
  }

  const tabla = modulo === 'recepcion' ? 'recepcion_registros' : 'atencion_registros'
  const cols =
    modulo === 'recepcion'
      ? 'id, created_at, fecha, tipo_documento, numero_documento, proveedor, codigo, descripcion, cantidad, estado, usuario_id, usuario_nombre, usuario_correo'
      : 'id, created_at, fecha, solicitante, area, tipo, asunto, detalle, estado, usuario_id, usuario_nombre, usuario_correo'
  let q = dataClient
    .from(tabla)
    .select(cols, { count: 'exact' })
    .order('created_at', { ascending: false })
  if (usuarioId) q = q.eq('usuario_id', usuarioId)
  q = q.range(offset, offset + limit - 1)
  const { data, error, count } = await q
  if (error) throw error
  return {
    filas: (data ?? []).map((r: Record<string, unknown>) =>
      modulo === 'recepcion'
        ? {
            id: str(r.id),
            fecha: str(r.fecha) || str(r.created_at),
            tipo: 'Recepción',
            titulo: str(r.numero_documento) || '(sin documento)',
            detalle: [str(r.proveedor), str(r.codigo), str(r.descripcion)].filter(Boolean).join(' · '),
            cantidad: toNum(r.cantidad),
            estado: str(r.estado),
            usuarioId: str(r.usuario_id),
            usuarioNombre: str(r.usuario_nombre),
            usuarioCorreo: str(r.usuario_correo),
          }
        : {
            id: str(r.id),
            fecha: str(r.fecha) || str(r.created_at),
            tipo: str(r.tipo),
            titulo: str(r.asunto),
            detalle: [str(r.solicitante), str(r.area)].filter(Boolean).join(' · '),
            cantidad: null,
            estado: str(r.estado),
            usuarioId: str(r.usuario_id),
            usuarioNombre: str(r.usuario_nombre),
            usuarioCorreo: str(r.usuario_correo),
          }
    ),
    total: count ?? 0,
  }
}
