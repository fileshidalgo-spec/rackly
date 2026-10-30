'use client'

import { dataClient } from '@/lib/supabase/client'
import { aNumero } from '@/lib/rackly/formato'
import { toast } from 'sonner'
import { exigirBorradas } from '@/lib/rackly/eliminacion-honesta'
import { ERR_ELIMINAR_BLOQUEADO, errorControlado } from '@/lib/rackly/errores'

export type CatalogoItem = {
  codigo: string
  un: string
  descripcion: string
  stock_big_magic: number
}

let _cache: CatalogoItem[] = []
let _cacheLoaded = false
let _fetchEnVuelo: Promise<CatalogoItem[]> | null = null

/**
 * Carga el catálogo completo paginando (1000 por lote, hasta 50K).
 * Con dedupe de petición en vuelo: si RecepcionModule y GuiaFotoForm (o el
 * editor de artículos) piden a la vez, TODOS comparten la misma respuesta
 * y el usuario no teclea sobre un cache vacío por peticiones duplicadas.
 */
export function fetchCatalogo(): Promise<CatalogoItem[]> {
  if (_fetchEnVuelo) return _fetchEnVuelo
  _fetchEnVuelo = (async () => {
    try {
      const allData: Record<string, unknown>[] = []
      let from = 0
      const BATCH = 1000
      for (let page = 0; page < 50; page++) {
        const { data, error } = await dataClient
          .from('catalogo')
          .select('codigo, un, descripcion, stock_big_magic')
          .order('codigo')
          .range(from, from + BATCH - 1)
        if (error) throw error
        const rows = data ?? []
        allData.push(...rows)
        if (rows.length < BATCH) break
        from += BATCH
      }
      _cache = allData.map((r) => ({
        codigo: String(r.codigo ?? ''),
        un: String(r.un ?? ''),
        descripcion: String(r.descripcion ?? ''),
        stock_big_magic: parseFloat(String(r.stock_big_magic ?? '0')) || 0,
      }))
      _cacheLoaded = true

      return _cache
    } catch (err) {
      // Antes: fallo de red = [] silencioso — los formularios autocompletaban
      // "sin resultados" y nadie sabía por qué. FIX auditoría Task 20 (E2):
      // aviso visible (el contrato Promise<CatalogoItem[]> NO cambia — los
      // consumidores siguen recibiendo cache o [], sin try/catch nuevo).
      // El dedupe _fetchEnVuelo evita ráfagas de toasts duplicados.
      console.warn('[catalogo] No se pudo cargar el catálogo:', err)
      toast.error('No se pudo cargar el catálogo', {
        description: 'El autocompletado puede estar incompleto. Reintenta en unos segundos.',
      })
      if (_cache.length > 0) return _cache
      return []
    } finally {
      _fetchEnVuelo = null
    }
  })()
  return _fetchEnVuelo
}

export function getCachedCatalogo(): CatalogoItem[] {
  return _cache
}

export function findCatalogoByCodigo(codigo: string): CatalogoItem | undefined {
  if (!codigo) return undefined
  const target = codigo.trim().toUpperCase()
  return _cache.find((i) => i.codigo.trim().toUpperCase() === target)
}

/**
 * Normaliza un código para compararlo contra el catálogo: mayúsculas y SIN
 * espacios internos ni puntuación suelta. Cubre códigos pegados desde texto
 * OCR ("5653 ", "5653.", "56 53", "5653-") que antes no matcheaban.
 * Los guiones se quitan porque hoy el catálogo es 100% numérico; si mañana
 * hubiera códigos con guion real, se comparan igual entre normalizados.
 */
function normalizarClave(codigo: string): string {
  return codigo.toUpperCase().replace(/[\s.,;:()\-_\/\\]+/g, '')
}

/**
 * Búsqueda tolerante para el ingreso MANUAL del código en Recepción.
 * 1) Coincidencia exacta tras normalizar (case, espacios, puntuación suelta).
 * 2) Regla histórica del app: '09' == '9' — si tras quitar ceros a la
 *    izquierda existe EXACTAMENTE un candidato, se usa ese.
 * Devuelve undefined si no hay match claro (el usuario escribe a mano).
 * `fuente` (opcional) permite inyectar el catálogo en los tests.
 */
export function buscarCatalogo(
  codigo: string,
  fuente?: CatalogoItem[]
): CatalogoItem | undefined {
  const cache = fuente ?? _cache
  const objetivo = normalizarClave(codigo)
  if (!objetivo) return undefined
  const exacto = cache.find((i) => normalizarClave(i.codigo) === objetivo)
  if (exacto) return exacto
  const sinCeros = objetivo.replace(/^0+/, '')
  if (!sinCeros) return undefined
  let candidato: CatalogoItem | undefined
  for (const item of cache) {
    if (normalizarClave(item.codigo).replace(/^0+/, '') === sinCeros) {
      if (candidato) return undefined // ambiguo: 2 códigos distintos tras normalizar
      candidato = item
    }
  }
  return candidato
}

/**
 * Busca en el catálogo por código exacto O por descripción que contenga el texto.
 * Retorna hasta `limit` resultados ordenados: primero coincidencia exacta de código,
 * luego códigos que EMPIEZAN por la consulta, luego coincidencia parcial de código,
 * luego por descripción.
 * Tolerante a puntuación suelta ("5653." busca "5653").
 */
export function searchCatalogo(query: string, limit = 10): CatalogoItem[] {
  const q = normalizarClave(query)
  if (!q) return []

  const exactCode: CatalogoItem[] = []
  const prefixCode: CatalogoItem[] = []
  const partialCode: CatalogoItem[] = []
  const byDescription: CatalogoItem[] = []

  for (const item of _cache) {
    const codeNorm = normalizarClave(item.codigo)
    const descNorm = item.descripcion.trim().toUpperCase()

    if (codeNorm === q) {
      exactCode.push(item)
    } else if (codeNorm.startsWith(q)) {
      prefixCode.push(item)
    } else if (codeNorm.includes(q)) {
      partialCode.push(item)
    } else if (descNorm.includes(q)) {
      byDescription.push(item)
    }
  }

  return [...exactCode, ...prefixCode, ...partialCode, ...byDescription].slice(0, limit)
}

export function isCatalogoLoaded(): boolean {
  return _cacheLoaded
}

// Task 16 — transparencia del parseo: el corte histórico "se cortaba" también
// venía de filas descartadas EN SILENCIO (sin código, cabecera, columnas no
// reconocidas). Con stats el usuario ve exactamente cuántas entraron y cuántas
// se ignoraron. Parámetro opcional: los llamadores existentes no cambian.
export type ParseStats = { leidas: number; validas: number; ignoradas: number }

export function parseCatalogoText(text: string, stats?: ParseStats): CatalogoItem[] {
  // FIX auditoría 2026-10-21: aNumero soporta "1.250,50" (coma decimal es-PE);
  // parseFloat("1250,5") → 1250 corrompía el Stock Big Magic. El código se
  // normaliza a UPPER/TRIM (los RPCs comparan con UPPER(TRIM(codigo))).
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (stats) stats.leidas = lines.length

  const items: CatalogoItem[] = []
  for (const line of lines) {
    let parts: string[]
    if (line.includes('\t')) parts = line.split('\t')
    else if (line.includes(';')) parts = line.split(';')
    else if (line.includes(',')) parts = line.split(',')
    else parts = line.split(/\s{2,}|\s+/)
    parts = parts.map((p) => p.trim()).filter((p) => p.length > 0)
    if (parts.length < 3) continue
    const [codigo, un, ...rest] = parts
    if (!codigo || !un) continue
    if (codigo.toLowerCase() === 'codigo' || codigo.toLowerCase() === 'código') continue
    const sbm = parts.length >= 4 ? aNumero(parts[parts.length - 1]) || 0 : 0
    items.push({
      codigo: codigo.trim().toUpperCase(),
      un: un.trim(),
      descripcion: parts.length >= 4 ? rest.slice(0, -1).join(' ').trim() : rest.join(' ').trim(),
      stock_big_magic: sbm,
    })
  }
  if (stats) {
    stats.validas = items.length
    stats.ignoradas = stats.leidas - items.length
  }
  return items
}

// Parsear filas desde un archivo Excel (columnas: CÓDIGO, DESCRIPCIÓN, UN, STOCK BIG MAGIC)
export function parseCatalogoExcelRows(rows: Record<string, unknown>[], stats?: ParseStats): CatalogoItem[] {
  if (stats) stats.leidas = rows.length
  const items: CatalogoItem[] = []
  for (const row of rows) {
    // Buscar columnas por nombre flexible
    const codigo = findCellValue(row, ['codigo', 'código', 'code', 'CODIGO', 'CÓDIGO'])
    const descripcion = findCellValue(row, ['descripcion', 'descripción', 'description', 'DESCRIPCION', 'DESCRIPCIÓN', 'DESCRIP'])
    const un = findCellValue(row, ['un', 'unidad', 'UN', 'Unidad', 'UNIDAD'])
    const sbmRaw = findCellValue(row, ['stock big magic', 'stock_big_magic', 'stockbm', 'big magic', 'STOCK BIG MAGIC', 'BM'])

    if (!codigo) continue
    const codeUpper = codigo.trim().toUpperCase()
    if (codeUpper === 'CODIGO' || codeUpper === 'CÓDIGO' || codeUpper === 'CODE') continue

    items.push({
      codigo: codeUpper,
      un: (un || '').trim(),
      descripcion: (descripcion || '').trim(),
      stock_big_magic: aNumero(String(sbmRaw || '0')) || 0,
    })
  }
  if (stats) {
    stats.validas = items.length
    stats.ignoradas = stats.leidas - items.length
  }
  return items
}

function findCellValue(row: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    const keyNorm = k.trim().toLowerCase().replace(/\s+/g, ' ')
    for (const target of keys) {
      if (keyNorm === target.toLowerCase().replace(/\s+/g, ' ')) {
        return String(v ?? '').trim()
      }
    }
  }
  return ''
}

/**
 * Merge del catálogo: upsert por lotes (500) con dedupe por código.
 * Antes enviaba TODO en UNA sola petición: con >1000 filas podía fallar por
 * payload/límites y los códigos duplicados dentro del archivo abortaban el
 * upsert completo ("ON CONFLICT cannot affect row a second time").
 *
 * Task 15 — UNIFICACIÓN DE CATÁLOGO: ya NO replica a piso_bloques. El módulo
 * Piso lee descripción/unidad EN VIVO desde esta tabla (fuente única de
 * verdad); piso_bloques queda como ancla técnica para la FK del historial.
 *
 * Task 16 — CARGAS >2000 LÍNEAS (verificadas E2E a 2500):
 *  - `onProgreso`: el UI muestra "Lote 2/5…" — el usuario VE que avanza y ya
 *    no interpreta un botón callado como "se cortó".
 *  - 1 reintento por lote: en la red del almacén una petición puede perderse;
 *    reenviar el MISMO lote es idempotente (upsert por PK `codigo`).
 *  - Tras el reintento fallido, fallback fila-a-fila (idéntico al anterior)
 *    para aislar la fila problemática sin perder el resto.
 */
export type ProgresoMerge = {
  cargados: number
  total: number
  lote: number
  totalLotes: number
}

export async function mergeCatalogo(
  nuevos: CatalogoItem[],
  onProgreso?: (p: ProgresoMerge) => void
): Promise<{ catalogo: CatalogoItem[]; cargados: number; errores: string[] }> {
  if (nuevos.length === 0) return { catalogo: await fetchCatalogo(), cargados: 0, errores: [] }
  // Dedupe por código (conserva la última aparición del archivo)
  const mapa = new Map<string, CatalogoItem>()
  for (const i of nuevos) {
    const codigo = i.codigo.trim().toUpperCase()
    if (!codigo) continue
    mapa.set(codigo, { ...i, codigo })
  }
  const rows = [...mapa.values()].map((i) => ({
    codigo: i.codigo,
    un: i.un,
    descripcion: i.descripcion,
    stock_big_magic: i.stock_big_magic ?? 0,
    updated_at: new Date().toISOString(),
  }))
  const errores: string[] = []
  let cargados = 0
  const CHUNK = 500
  const totalLotes = Math.ceil(rows.length / CHUNK)
  let lote = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    lote++
    const chunk = rows.slice(i, i + CHUNK)
    // Task 16: 2 intentos por lote (1 reintento) — reenvío idempotente por PK.
    let error: { message: string } | null = null
    for (let intento = 0; intento < 2; intento++) {
      const res = await dataClient.from('catalogo').upsert(chunk, { onConflict: 'codigo' })
      error = res.error
      if (!error) break
      if (intento === 0) await new Promise((r) => setTimeout(r, 800)) // pausa breve antes de reintentar
    }
    if (error) {
      // Fallback fila por fila para identificar la fila problemática
      for (const r of chunk) {
        const { error: singleErr } = await dataClient.from('catalogo').upsert(r, { onConflict: 'codigo' })
        if (singleErr) errores.push(`${r.codigo}: ${singleErr.message}`)
        else cargados++
      }
    } else {
      cargados += chunk.length
    }
    onProgreso?.({ cargados, total: rows.length, lote, totalLotes })
  }
  return { catalogo: await fetchCatalogo(), cargados, errores }
}

export async function clearCatalogo(): Promise<CatalogoItem[]> {
  // HONESTIDAD (patrón T173-00004281, auditoría 2026-10-31): la RLS de
  // catalogo filtra el DELETE por rol en silencio — un operario veía
  // «catálogo vaciado» con el catálogo intacto. Se piden las filas de
  // vuelta y se verifica que lo restante sea coherente con lo borrado.
  const { data: borradas, error } = await dataClient
    .from('catalogo')
    .delete()
    .neq('codigo', '')
    .select('codigo')
  if (error) throw error
  // Poda FK-safe de las anclas de piso (solo las SIN movimientos históricos)
  await podarAnclasPisoSinUso()
  const restantes = await fetchCatalogo()
  if ((borradas ?? []).length === 0 && restantes.length > 0) {
    throw errorControlado(
      ERR_ELIMINAR_BLOQUEADO,
      'El catálogo NO se vació (tu rol no permite borrar). Pide el vaciado a un supervisor/administrador.'
    )
  }
  return restantes
}

// ═══ Anclas de piso (piso_bloques) ═══
// Task 15 — el catálogo de Piso fue eliminado como fuente de datos: `catalogo`
// es la ÚNICA fuente (el módulo Piso la lee en vivo). piso_bloques existe solo
// como ancla UUID para la FK piso_movimiento_detalles.bloque_id (historial
// inmutable). No se replica nada hacia ella; solo se PODA lo que quedó sin uso.

/**
 * Poda en lote las anclas de piso que NO tienen movimientos históricos.
 * FK-safe: primero excluye los bloque_id presentes en piso_movimiento_detalles.
 */
export async function podarAnclasPisoSinUso(): Promise<number> {
  const usados = new Set<string>()
  let from = 0
  for (let page = 0; page < 50; page++) {
    const { data, error } = await dataClient
      .from('piso_movimiento_detalles')
      .select('bloque_id')
      .range(from, from + 999)
    if (error) break
    const rows = (data ?? []) as { bloque_id: string }[]
    for (const r of rows) usados.add(r.bloque_id)
    if (rows.length < 1000) break
    from += 1000
  }
  const { data: todas, error: errTodas } = await dataClient
    .from('piso_bloques')
    .select('id')
  if (errTodas) throw errTodas
  const aPodar = ((todas ?? []) as { id: string }[])
    .map((b) => b.id)
    .filter((id) => !usados.has(id))
  let podadas = 0
  const CHUNK = 500
  for (let i = 0; i < aPodar.length; i += CHUNK) {
    // Contador HONESTO: solo las filas que la BD borró de verdad
    const { data: borradas, error } = await dataClient
      .from('piso_bloques')
      .delete()
      .in('id', aPodar.slice(i, i + CHUNK))
      .select('id')
    if (error) break
    podadas += (borradas ?? []).length
  }
  return podadas
}

// ═══ (Eliminado) Sincronización catalogo → piso_bloques ═══
// Hasta la unificación del catálogo (Task 15) cada guardado replicaba aquí el
// catálogo completo a piso_bloques (upsert de ~1079 filas) — era LA fuente del
// drift entre ambos catálogos y duplicaba la escritura. Hoy Piso lee el
// catálogo en vivo (src/lib/piso/api.ts → resolverInfoBloques) y piso_bloques
// se limita a ser el ancla FK del historial: se crea on-demand
// (asegurarAnclaPiso) y se poda sin uso (podarAnclasPisoSinUso).
