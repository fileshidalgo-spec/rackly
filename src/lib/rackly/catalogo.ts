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
  const { data, error } = await dataClient
    .from('catalogo')
    .select('codigo, un, descripcion, stock_big_magic')
    .order('codigo')
  if (error) throw error
  _cache = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    codigo: String(r.codigo ?? ''),
    un: String(r.un ?? ''),
    descripcion: String(r.descripcion ?? ''),
    stock_big_magic: Number(r.stock_big_magic ?? 0),
  }))
  _cacheLoaded = true
  return _cache
}

export function getCachedCatalogo(): CatalogoItem[] {
  return _cache
}

export function findCatalogoByCodigo(codigo: string): CatalogoItem | undefined {
  if (!codigo) return undefined
  const target = codigo.trim().toUpperCase()
  return _cache.find((i) => i.codigo.trim().toUpperCase() === target)
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

export async function mergeCatalogo(nuevos: CatalogoItem[]): Promise<CatalogoItem[]> {
  if (nuevos.length === 0) return fetchCatalogo()
  const rows = nuevos.map((i) => ({
    codigo: i.codigo.trim().toUpperCase(),
    un: i.un,
    descripcion: i.descripcion,
    stock_big_magic: i.stock_big_magic ?? 0,
    updated_at: new Date().toISOString(),
  }))
  const { error } = await dataClient.from('catalogo').upsert(rows, { onConflict: 'codigo' })
  if (error) throw error
  return fetchCatalogo()
}

export async function clearCatalogo(): Promise<CatalogoItem[]> {
  const { error } = await dataClient.from('catalogo').delete().neq('codigo', '')
  if (error) throw error
  return fetchCatalogo()
}
