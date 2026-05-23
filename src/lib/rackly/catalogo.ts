'use client'

import { supabase } from '@/lib/supabase/client'

export type CatalogoItem = {
  codigo: string
  un: string
  descripcion: string
  stock_big_magic?: number
}

let _cache: CatalogoItem[] = []
let _cacheLoaded = false

export async function fetchCatalogo(): Promise<CatalogoItem[]> {
  const { data, error } = await supabase
    .from('catalogo')
    .select('codigo, un, descripcion, stock_big_magic')
    .order('codigo')
  if (error) throw error
  _cache = (data ?? []).map((r: Record<string, unknown>) => ({
    codigo: r.codigo as string,
    un: r.un as string,
    descripcion: r.descripcion as string,
    stock_big_magic: r.stock_big_magic as number | undefined,
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
    items.push({
      codigo: codigo.trim(),
      un: un.trim(),
      descripcion: rest.join(' ').trim(),
    })
  }
  return items
}

export async function mergeCatalogo(nuevos: CatalogoItem[]): Promise<CatalogoItem[]> {
  if (nuevos.length === 0) return fetchCatalogo()
  const rows = nuevos.map((i) => ({
    codigo: i.codigo.trim().toUpperCase(),
    un: i.un,
    descripcion: i.descripcion,
    updated_at: new Date().toISOString(),
  }))
  const { error } = await supabase.from('catalogo').upsert(rows, { onConflict: 'codigo' })
  if (error) throw error
  return fetchCatalogo()
}

export async function addCatalogoItem(item: {
  codigo: string
  un: string
  descripcion: string
  stock_big_magic?: number
}): Promise<void> {
  const { error } = await supabase.from('catalogo').insert({
    codigo: item.codigo.trim().toUpperCase(),
    un: item.un,
    descripcion: item.descripcion,
    stock_big_magic: item.stock_big_magic ?? 0,
  })
  if (error) throw error
}

export async function updateCatalogoItem(
  codigo: string,
  updates: { un?: string; descripcion?: string; stock_big_magic?: number }
): Promise<void> {
  const { error } = await supabase
    .from('catalogo')
    .update(updates)
    .eq('codigo', codigo.trim().toUpperCase())
  if (error) throw error
}

export async function deleteCatalogoItem(codigo: string): Promise<void> {
  const { error } = await supabase
    .from('catalogo')
    .delete()
    .eq('codigo', codigo.trim().toUpperCase())
  if (error) throw error
}

export async function clearCatalogo(): Promise<CatalogoItem[]> {
  const { error } = await supabase.from('catalogo').delete().neq('codigo', '')
  if (error) throw error
  return fetchCatalogo()
}
