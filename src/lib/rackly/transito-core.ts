/**
 * RACKLY — TRÁNSITO · Núcleo puro (sin dependencias de BD/Supabase).
 *
 * Todo el cálculo del semáforo, agrupación de guías, validaciones y
 * etiquetas vive aquí para poder testearlo sin red (mismo patrón que
 * recepcion-filas / recepcion-idempotencia).
 */

import { mensajeError } from './errores'

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES Y TIPOS
// ═══════════════════════════════════════════════════════════════════

/** Fecha de implementación del módulo: SOLO guías desde este día entran a Tránsito. */
export const FECHA_INICIO_TRANSITO = '2026-10-13'

export type DestinoTransito = 'rack' | 'piso'

/**
 * Destinos posibles de un envío registrado en recepcion_registros.transito:
 *   · rack / piso           → transferencia normal de Tránsito.
 *   · atencion              → puente Atención↔Tránsito: descuento de la guía
 *                             (la cantidad REAL baja el pendiente).
 *   · atencion_posicion     → puente: marcador de salida desde una ubicación
 *                             (cantidad=0 para NO alterar el semáforo; la
 *                             cantidad real va en `cantidad_atencion`).
 *   · reversa_atencion      → compensación de una atención (cantidad negativa
 *                             en ruta tránsito; 0 + cantidad_atencion negativa
 *                             en ruta posición). Devuelve el pendiente.
 */
export type DestinoEnvio = DestinoTransito | 'atencion' | 'atencion_posicion' | 'reversa_atencion'

export type EnvioTransito = {
  uuid: string
  /** 'YYYY-MM-DD HH:MI' hora Lima (la graba la RPC). */
  fecha: string
  destino: DestinoEnvio
  /** Etiqueta legible de la ubicación (ej. B3·T2·P1·Pos07 / SA·A·2·1·N3). */
  ubicacion: string
  cantidad: number
  usuario_id: string | null
  usuario_nombre: string
  turno: string
  rack?: { bloque: string; torre: string; piso: string; posicion: string } | null
  piso?: { nivel_id: string; posicion_id?: string; nivel_numero?: number } | null
  /** Puente Atención (2026-10-23): RQ a la que se atendió (destino atencion*). */
  rq?: string
  /** Id del material RQ (rq_atencion_items.id) que consumió esta toma. */
  item_id?: string
  /** Identificador del LOTE de tomas (idempotencia + trazabilidad de la reversa). */
  lote?: string
  /** Reversas: uuid de la toma original compensada. */
  reversa_de?: string
  /** En atencion_posicion/reversa_atencion: cantidad REAL atendida (cantidad=0). */
  cantidad_atencion?: number
}

export type EstadoSem = 'ROJO' | 'AMAR' | 'VERDE'

export type ArticuloTransito = {
  id: string
  /** uuid de la guía (recepcion_registros.guia_id) — identidad EXACTA que
   *  porta el QR del rótulo: el escáner de Tránsito resuelve por aquí. */
  guiaId: string
  createdAt: string
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía (2026-10-22). Filas legacy: respaldo del proveedor. */
  empresaOrigen: string
  /** Proveedor del ARTÍCULO (film por fila; legacy: la empresa que envía). */
  proveedor: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string | null
  placa: string
  nPaleta: number | null
  usuarioNombre: string
  observaciones: string
  envios: EnvioTransito[]
  enviados: number
  pendiente: number
  estado: EstadoSem
  /** Pestaña de origen de la fila ('guia' | 'devolucion') — Tránsito marca
   *  con badge las DEVOLUCIONES DE LÍNEA para que el operario no las
   *  confunda con guías de proveedor. Filas legacy: 'guia'. */
  tipoRecepcion: string
  /** Datos ausentes (lote/vencimiento/producción) — alimenta la ALERTA
   *  de transferencia consciente (v2 2026-10-20). Vacío = datos completos. */
  datosFaltantes: string[]
}

export type GuiaTransito = {
  /** Identidad de guía: tipo+nº documento, o fecha+empresa si no hay nº. */
  key: string
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  /** Empresa que envía (mostrada en el encabezado de la guía). */
  empresaOrigen: string
  proveedor: string
  placa: string
  articulos: ArticuloTransito[]
  /** TRUE si la "guía" es una DEVOLUCIÓN DE LÍNEA (alguna fila con
   *  tipo_recepcion='devolucion') — el encabezado muestra el badge. */
  esDevolucion: boolean
}

export type UsuarioTransito = { id: string; nombre: string; correo: string }

export const EPS_TRANSITO = 0.0005

// ═══════════════════════════════════════════════════════════════════
// SEMÁFORO
// ═══════════════════════════════════════════════════════════════════

function aNum(v: unknown): number {
  if (typeof v === 'number') return v
  const n = parseFloat(String(v ?? '0'))
  return isNaN(n) ? 0 : n
}

function str(v: unknown): string {
  return (v as string | null)?.toString() ?? ''
}

/**
 * Semáforo por artículo:
 *   🔴 ROJO = nada transferido · 🟡 AMAR = parcial · 🟢 VERDE = 100 % transferido.
 * Redondea a 3 decimales (precisión de la BD) para evitar residuos binarios.
 */
export function estadoSem(articulo: { cantidad: number; envios: EnvioTransito[] }): {
  estado: EstadoSem
  enviados: number
  pendiente: number
} {
  const enviados =
    Math.round(articulo.envios.reduce((acc, e) => acc + aNum(e.cantidad), 0) * 1000) / 1000
  const pendiente = Math.round((aNum(articulo.cantidad) - enviados) * 1000) / 1000
  let estado: EstadoSem = 'ROJO'
  if (enviados > EPS_TRANSITO && pendiente > EPS_TRANSITO) estado = 'AMAR'
  else if (enviados > EPS_TRANSITO && pendiente <= EPS_TRANSITO) estado = 'VERDE'
  return { estado, enviados, pendiente }
}

/**
 * Datos que el artículo NO tiene, en orden de mención del usuario
 * (lote → vencimiento → producción). Alimenta la ALERTA de transferencia
 * consciente: la transferencia está PERMITIDA (v2 2026-10-20 — el proveedor
 * a veces no trae esos datos y la mercadería no puede quedarse congelada;
 * luego se completan/corrigen con la función Editar de Racks/Piso), pero la
 * UI pide confirmación explícita para que nadie transfiera sin darse cuenta.
 */
export function datosFaltantes(a: {
  lote: string
  fechaVencimiento: string | null
  fechaProduccion?: string | null
}): string[] {
  const faltan: string[] = []
  if (!a.lote.trim()) faltan.push('lote')
  if (!a.fechaVencimiento?.trim()) faltan.push('vencimiento')
  // producción: se evalúa SOLO si el llamador la trae (ArticuloTransito
  // siempre la trae, '' cuando la fila no tiene). undefined = el llamador
  // no la maneja — no se marca como faltante para no alertar de más.
  if (a.fechaProduccion !== undefined && !a.fechaProduccion?.trim()) faltan.push('producción')
  return faltan
}

function destinoValido(v: unknown): DestinoEnvio {
  const s = str(v)
  if (s === 'piso') return 'piso'
  if (s === 'atencion') return 'atencion'
  if (s === 'atencion_posicion') return 'atencion_posicion'
  if (s === 'reversa_atencion') return 'reversa_atencion'
  return 'rack'
}

export function parseEnvios(raw: unknown): EnvioTransito[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      uuid: str(e.uuid),
      fecha: str(e.fecha),
      destino: destinoValido(e.destino),
      ubicacion: str(e.ubicacion),
      cantidad: aNum(e.cantidad),
      usuario_id: (e.usuario_id as string | null) ?? null,
      usuario_nombre: str(e.usuario_nombre),
      turno: str(e.turno),
      rack: (e.rack as EnvioTransito['rack']) ?? null,
      piso: (e.piso as EnvioTransito['piso']) ?? null,
      // Puente Atención (opcional — filas legacy no las traen)
      rq: str(e.rq) || undefined,
      item_id: str(e.item_id) || undefined,
      lote: str(e.lote) || undefined,
      reversa_de: str(e.reversa_de) || undefined,
      cantidad_atencion:
        typeof e.cantidad_atencion === 'number'
          ? e.cantidad_atencion
          : e.cantidad_atencion != null && !isNaN(parseFloat(String(e.cantidad_atencion)))
            ? parseFloat(String(e.cantidad_atencion))
            : undefined,
    }))
    .filter((e) => e.uuid !== '')
}

export function mapArticuloTransito(r: Record<string, unknown>): ArticuloTransito {
  // empresa_origen NULL = fila escrita por un bundle viejo: el proveedor
  // legacy ES la empresa que envía (misma política que mapRecepcion).
  const empresaRaw = (r.empresa_origen as string | null) ?? null
  const base = {
    id: str(r.id),
    guiaId: str(r.guia_id),
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    tipoDocumento: str(r.tipo_documento),
    numeroDocumento: str(r.numero_documento),
    empresaOrigen: empresaRaw !== null ? empresaRaw : str(r.proveedor),
    proveedor: str(r.proveedor),
    codigo: str(r.codigo),
    descripcion: str(r.descripcion),
    cantidad: aNum(r.cantidad),
    unidadMedida: str(r.unidad_medida),
    lote: str(r.lote),
    fechaProduccion: str(r.fecha_produccion),
    fechaVencimiento: r.fecha_vencimiento ? str(r.fecha_vencimiento) : null,
    placa: str(r.placa),
    nPaleta: typeof r.n_paleta === 'number' ? r.n_paleta : null,
    usuarioNombre: str(r.usuario_nombre),
    observaciones: str(r.observaciones),
    // Filas legacy (pre-migración): la BD las trae 'guia' — mismo respaldo
    // que mapRecepcion (modulos.ts).
    tipoRecepcion: str(r.tipo_recepcion) || 'guia',
    envios: parseEnvios(r.transito ? (r.transito as Record<string, unknown>).envios : []),
  }
  const sem = estadoSem(base)
  return { ...base, ...sem, datosFaltantes: datosFaltantes(base) }
}

// ═══════════════════════════════════════════════════════════════════
// AGRUPACIÓN Y FILTROS
// ═══════════════════════════════════════════════════════════════════

/** Clave de identidad de guía (igual criterio que Recepción para agrupar). */
export function claveGuia(a: {
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  empresaOrigen?: string
  proveedor: string
}): string {
  const num = a.numeroDocumento.trim()
  if (num) return `${a.tipoDocumento.trim()}|${num}`
  // Sin nº: la guía se identifica por SU empresa de origen — NO por el
  // proveedor del artículo (2 artículos del mismo proveedor de film en
  // guías distintas NO deben agruparse juntos).
  const empresa = (a.empresaOrigen || a.proveedor || '').trim()
  return `${a.fecha}|${empresa}|${a.tipoDocumento.trim()}`
}

export function agruparEnGuias(articulos: ArticuloTransito[]): GuiaTransito[] {
  const map = new Map<string, GuiaTransito>()
  for (const a of articulos) {
    const key = claveGuia(a)
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        tipoDocumento: a.tipoDocumento,
        numeroDocumento: a.numeroDocumento,
        fecha: a.fecha,
        empresaOrigen: a.empresaOrigen,
        proveedor: a.proveedor,
        placa: a.placa,
        articulos: [],
        esDevolucion: false,
      }
      map.set(key, g)
    }
    g.articulos.push(a)
    if (a.tipoRecepcion === 'devolucion') g.esDevolucion = true
    // Encabezado: rellenar huecos con el primer artículo que traiga el dato.
    if (!g.empresaOrigen && a.empresaOrigen) g.empresaOrigen = a.empresaOrigen
    if (!g.placa && a.placa) g.placa = a.placa
  }
  // Artículos en el orden de registro dentro de cada guía
  for (const g of map.values()) {
    g.articulos.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
  }
  // Guías: la más reciente primero
  return Array.from(map.values()).sort(
    (x, y) => y.fecha.localeCompare(x.fecha) || y.key.localeCompare(x.key)
  )
}

/** Contador del encabezado: artículos con pendiente > 0. */
export function contarPendientes(articulos: ArticuloTransito[]): number {
  return articulos.filter((a) => a.pendiente > EPS_TRANSITO).length
}

/** Filtro de búsqueda: empresa, proveedor, código, descripción o nº doc. */
export function filtrarArticulos(
  articulos: ArticuloTransito[],
  busqueda: string
): ArticuloTransito[] {
  const q = busqueda.trim().toLowerCase()
  if (!q) return articulos
  // Campos con respaldo a '' — una fila con texto ausente jamás rompe el
  // filtrado de TODO el listado (crash toLowerCase de undefined, 2026-10-23).
  return articulos.filter(
    (a) =>
      (a.empresaOrigen ?? '').toLowerCase().includes(q) ||
      (a.proveedor ?? '').toLowerCase().includes(q) ||
      (a.codigo ?? '').toLowerCase().includes(q) ||
      (a.descripcion ?? '').toLowerCase().includes(q) ||
      (a.numeroDocumento ?? '').toLowerCase().includes(q)
  )
}

// ═══════════════════════════════════════════════════════════════════
// ETIQUETAS DE UBICACIÓN
// ═══════════════════════════════════════════════════════════════════

export function etiquetaRack(r: {
  bloque: string
  torre: string
  piso: string
  posicion: string
}): string {
  return `B${r.bloque}·T${r.torre}·P${r.piso}·Pos${r.posicion}`
}

export function etiquetaPiso(p: {
  sector?: string
  columna?: string
  subcolumna?: string
  posicionNumero?: number
  nivelNumero?: number
}): string {
  const partes = [
    p.sector ?? '',
    p.columna ?? '',
    p.subcolumna ?? '',
    p.posicionNumero != null ? `Pos${p.posicionNumero}` : '',
    p.nivelNumero != null ? `N${p.nivelNumero}` : '',
  ].filter(Boolean)
  return partes.join('·')
}

export function claveCeldaRack(c: {
  bloque: string
  torre: string
  piso: string
  posicion: string
}): string {
  return `${c.bloque}-${c.torre}-${c.piso}-${c.posicion}`
}

// ═══════════════════════════════════════════════════════════════════
// REGULARIZACIÓN DE SOBRANTE (T173-00004274, 2026-10-31)
// ═══════════════════════════════════════════════════════════════════

/**
 * ¿Puede esta fila REGULARIZARSE (eliminarse como sobrante de recepción)?
 *
 * Caso de origen: la guía T173-00004274 registró 172 UN del artículo 53414
 * cuando físicamente llegaron 150 — las 22 de sobrante "flotan" en Tránsito
 * con el semáforo ROJO para siempre (nunca existieron: no se pueden
 * transferir ni encajar en ninguna ubicación).
 *
 * SOLO filas 100 % SIN transferir son regularizables (enviados = 0 y
 * pendiente > 0): con AL MENOS un envío el stock ya vive en Racks/Piso y la
 * fila NO se toca (borrarla dejaría stock huérfano — misma política del
 * editor de Recepción). La eliminación real la ejecuta la RPC
 * `recepcion_regularizar_fila` con guard `recepcion.eliminar`.
 */
export function regularizable(a: { cantidad: number; envios: EnvioTransito[] }): boolean {
  const { enviados, pendiente } = estadoSem(a)
  return pendiente > EPS_TRANSITO && enviados <= EPS_TRANSITO
}

// ═══════════════════════════════════════════════════════════════════
// VALIDACIONES
// ═══════════════════════════════════════════════════════════════════

/** Lanza si la cantidad viola el anti-sobreenvío o es inválida. */
export function validarCantidad(cantidad: number, pendiente: number): string | null {
  if (!(cantidad > 0)) return 'La cantidad debe ser mayor que cero'
  if (cantidad - pendiente > EPS_TRANSITO)
    return `La cantidad excede el pendiente (${pendiente}) en ${
      Math.round((cantidad - pendiente) * 1000) / 1000
    }`
  return null
}

/**
 * Extrae "CODE|detalle" de un error PostgREST y lo vuelve mensaje de usuario.
 *
 * FIX 2026-10-30 (reporte «[object Object]» al escanear QR): los errores de
 * PostgREST llegan como OBJETO PLANO { message, details, hint, code } — no
 * como `Error`. El handler antiguo hacía `String(err)` y mostraba
 * "[object Object]". Ahora delega en el extractor canónico mensajeError()
 * (lib/rackly/errores.ts), que maneja TODAS las formas conocidas y aplica la
 * convención "CODE|detalle" de las RPCs. Mismo contrato que antes para
 * `Error` (tests de test_transito.js).
 */
export function mensajeRpcError(err: unknown): string {
  return mensajeError(err)
}
