/**
 * RACKLY — TRÁNSITO · Núcleo puro (sin dependencias de BD/Supabase).
 *
 * Todo el cálculo del semáforo, agrupación de guías, validaciones y
 * etiquetas vive aquí para poder testearlo sin red (mismo patrón que
 * recepcion-filas / recepcion-idempotencia).
 */

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES Y TIPOS
// ═══════════════════════════════════════════════════════════════════

/** Fecha de implementación del módulo: SOLO guías desde este día entran a Tránsito. */
export const FECHA_INICIO_TRANSITO = '2026-10-14'

export type DestinoTransito = 'rack' | 'piso'

export type EnvioTransito = {
  uuid: string
  /** 'YYYY-MM-DD HH:MI' hora Lima (la graba la RPC). */
  fecha: string
  destino: DestinoTransito
  /** Etiqueta legible de la ubicación (ej. B3·T2·P1·Pos07 / SA·A·2·1·N3). */
  ubicacion: string
  cantidad: number
  usuario_id: string | null
  usuario_nombre: string
  turno: string
  rack?: { bloque: string; torre: string; piso: string; posicion: string } | null
  piso?: { nivel_id: string; posicion_id?: string; nivel_numero?: number } | null
}

export type EstadoSem = 'ROJO' | 'AMAR' | 'VERDE'

export type ArticuloTransito = {
  id: string
  createdAt: string
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
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
  transferible: boolean
  razonNoTransferible: string
}

export type GuiaTransito = {
  /** Identidad de guía: tipo+nº documento, o fecha+proveedor si no hay nº. */
  key: string
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  proveedor: string
  placa: string
  articulos: ArticuloTransito[]
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

/** Sin lote o sin vencimiento NO es transferible (regla Tránsito; la RPC lo blinda). */
export function razonNoTransferible(a: { lote: string; fechaVencimiento: string | null }): string {
  const sinLote = !a.lote.trim()
  const sinVenc = !a.fechaVencimiento?.trim()
  if (sinLote && sinVenc) return 'Sin lote y sin fecha de vencimiento'
  if (sinLote) return 'Sin lote'
  if (sinVenc) return 'Sin fecha de vencimiento'
  return ''
}

export function esTransferible(a: { lote: string; fechaVencimiento: string | null }): boolean {
  return razonNoTransferible(a) === ''
}

export function parseEnvios(raw: unknown): EnvioTransito[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      uuid: str(e.uuid),
      fecha: str(e.fecha),
      destino: e.destino === 'piso' ? ('piso' as const) : ('rack' as const),
      ubicacion: str(e.ubicacion),
      cantidad: aNum(e.cantidad),
      usuario_id: (e.usuario_id as string | null) ?? null,
      usuario_nombre: str(e.usuario_nombre),
      turno: str(e.turno),
      rack: (e.rack as EnvioTransito['rack']) ?? null,
      piso: (e.piso as EnvioTransito['piso']) ?? null,
    }))
    .filter((e) => e.uuid !== '')
}

export function mapArticuloTransito(r: Record<string, unknown>): ArticuloTransito {
  const base = {
    id: str(r.id),
    createdAt: str(r.created_at),
    fecha: str(r.fecha),
    tipoDocumento: str(r.tipo_documento),
    numeroDocumento: str(r.numero_documento),
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
    envios: parseEnvios(r.transito ? (r.transito as Record<string, unknown>).envios : []),
  }
  const sem = estadoSem(base)
  const razon = razonNoTransferible(base)
  return { ...base, ...sem, transferible: razon === '', razonNoTransferible: razon }
}

// ═══════════════════════════════════════════════════════════════════
// AGRUPACIÓN Y FILTROS
// ═══════════════════════════════════════════════════════════════════

/** Clave de identidad de guía (igual criterio que Recepción para agrupar). */
export function claveGuia(a: {
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  proveedor: string
}): string {
  const num = a.numeroDocumento.trim()
  if (num) return `${a.tipoDocumento.trim()}|${num}`
  return `${a.fecha}|${a.proveedor.trim()}|${a.tipoDocumento.trim()}`
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
        proveedor: a.proveedor,
        placa: a.placa,
        articulos: [],
      }
      map.set(key, g)
    }
    g.articulos.push(a)
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

/** Filtro de búsqueda: proveedor, código, descripción o nº de documento. */
export function filtrarArticulos(
  articulos: ArticuloTransito[],
  busqueda: string
): ArticuloTransito[] {
  const q = busqueda.trim().toLowerCase()
  if (!q) return articulos
  return articulos.filter(
    (a) =>
      a.proveedor.toLowerCase().includes(q) ||
      a.codigo.toLowerCase().includes(q) ||
      a.descripcion.toLowerCase().includes(q) ||
      a.numeroDocumento.toLowerCase().includes(q)
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

/** Extrae "CODE|detalle" de un error PostgREST y lo vuelve mensaje de usuario. */
export function mensajeRpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const i = msg.indexOf('|')
  return i >= 0 ? msg.slice(i + 1) : msg
}
