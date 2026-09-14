'use client'

import { dataClient } from '@/lib/supabase/client'

export type CatalogoItem = {
  codigo: string
  un: string
  descripcion: string
  stock_big_magic: number
}

let _cache: CatalogoItem[] = []
let _cacheLoaded = false

export async function fetchCatalogo(): Promise<CatalogoItem[]> {
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
    if (_cache.length > 0) return _cache
    return []
  }
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
 * Busca en el catálogo por código exacto O por descripción que contenga el texto.
 * Retorna hasta `limit` resultados ordenados: primero coincidencia exacta de código,
 * luego por coincidencia parcial de código, luego por descripción.
 */
export function searchCatalogo(query: string, limit = 10): CatalogoItem[] {
  if (!query || !query.trim()) return []
  const q = query.trim().toUpperCase()

  const exactCode: CatalogoItem[] = []
  const partialCode: CatalogoItem[] = []
  const byDescription: CatalogoItem[] = []

  for (const item of _cache) {
    const codeNorm = item.codigo.trim().toUpperCase()
    const descNorm = item.descripcion.trim().toUpperCase()

    if (codeNorm === q) {
      exactCode.push(item)
    } else if (codeNorm.includes(q)) {
      partialCode.push(item)
    } else if (descNorm.includes(q)) {
      byDescription.push(item)
    }
  }

  return [...exactCode, ...partialCode, ...byDescription].slice(0, limit)
}

export function isCatalogoLoaded(): boolean {
  return _cacheLoaded
}

export function parseCatalogoText(text: string): CatalogoItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

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
    const sbm = parts.length >= 4 ? parseFloat(parts[parts.length - 1]) || 0 : 0
    items.push({
      codigo: codigo.trim(),
      un: un.trim(),
      descripcion: parts.length >= 4 ? rest.slice(0, -1).join(' ').trim() : rest.join(' ').trim(),
      stock_big_magic: sbm,
    })
  }
  return items
}

// Parsear filas desde un archivo Excel (columnas: CÓDIGO, DESCRIPCIÓN, UN, STOCK BIG MAGIC)
export function parseCatalogoExcelRows(rows: Record<string, unknown>[]): CatalogoItem[] {
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
      stock_big_magic: parseFloat(String(sbmRaw || '0')) || 0,
    })
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
 */
export async function mergeCatalogo(
  nuevos: CatalogoItem[]
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
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await dataClient.from('catalogo').upsert(chunk, { onConflict: 'codigo' })
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
  }
  // Sincronizar: también upsert a piso_bloques
  const sync = await syncToPisoBloques([...mapa.values()])
  errores.push(...sync.errores.map((e) => `piso_bloques: ${e}`))
  return { catalogo: await fetchCatalogo(), cargados, errores }
}

export async function clearCatalogo(): Promise<CatalogoItem[]> {
  const { error } = await dataClient.from('catalogo').delete().neq('codigo', '')
  if (error) throw error
  // Sincronizar: también limpiar piso_bloques
  await clearPisoBloques()
  return fetchCatalogo()
}

// ═══ Sincronización con piso_bloques ═══
// Cuando se actualiza el catálogo de Racks, los cambios se replican a piso_bloques
// para que la sección Piso tenga los mismos códigos disponibles.

async function syncToPisoBloques(items: CatalogoItem[]): Promise<{ cargados: number; errores: string[] }> {
  if (items.length === 0) return { cargados: 0, errores: [] }
  const rows = items.map((i) => ({
    codigo: i.codigo.trim().toUpperCase(),
    descripcion: i.descripcion,
    unidad: i.un,
  }))
  const errores: string[] = []
  let cargados = 0
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await dataClient.from('piso_bloques').upsert(chunk, { onConflict: 'codigo' })
    if (error) {
      for (const r of chunk) {
        const { error: singleErr } = await dataClient.from('piso_bloques').upsert(r, { onConflict: 'codigo' })
        if (singleErr) errores.push(`${r.codigo}: ${singleErr.message}`)
        else cargados++
      }
    } else {
      cargados += chunk.length
    }
  }
  if (errores.length > 0) {
    // Antes el error solo iba a console y el usuario veía éxito limpio con el
    // catálogo de Piso sin sincronizar; ahora se propaga al llamador.
    console.error('Error sincronizando a piso_bloques:', errores.slice(0, 5).join(' | '))
  }
  return { cargados, errores }
}

async function removeFromPisoBloques(codigo: string): Promise<void> {
  const target = codigo.trim().toUpperCase()
  // Buscar el bloque por código para obtener su ID
  const { data: bloque, error: errBusqueda } = await dataClient
    .from('piso_bloques')
    .select('id')
    .eq('codigo', target)
    .maybeSingle()
  if (errBusqueda) throw errBusqueda
  if (!bloque) return
  const bloqueId = (bloque as { id: string }).id
  // Eliminar asignaciones de columna primero (FK constraint)
  const { error: errAsig } = await dataClient.from('piso_columna_bloques').delete().eq('bloque_id', bloqueId)
  if (errAsig) throw errAsig
  // Luego eliminar el bloque
  const { error: errBloque } = await dataClient.from('piso_bloques').delete().eq('id', bloqueId)
  if (errBloque) throw errBloque
}

async function clearPisoBloques(): Promise<void> {
  // Eliminar asignaciones de columna primero (FK constraint), por lotes
  const { data: colBloques, error: errCol } = await dataClient.from('piso_columna_bloques').select('bloque_id')
  if (errCol) throw errCol
  if (colBloques && colBloques.length > 0) {
    const ids = (colBloques as { bloque_id: string }[]).map(b => b.bloque_id)
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await dataClient.from('piso_columna_bloques').delete().in('bloque_id', ids.slice(i, i + 500))
      if (error) throw error
    }
  }
  // Luego eliminar todos los bloques, por lotes (URL con miles de IDs puede exceder límites)
  const { data: allBloques, error: errAll } = await dataClient.from('piso_bloques').select('id')
  if (errAll) throw errAll
  if (allBloques && allBloques.length > 0) {
    const ids = (allBloques as { id: string }[]).map(b => b.id)
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await dataClient.from('piso_bloques').delete().in('id', ids.slice(i, i + 500))
      if (error) throw error
    }
  }
}

export { syncToPisoBloques, removeFromPisoBloques, clearPisoBloques }
