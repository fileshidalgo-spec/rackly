'use client'

import { useState, useEffect, useRef } from 'react'
import {
  fetchCatalogo,
  findCatalogoByCodigo,
  isCatalogoLoaded,
  type CatalogoItem,
} from '@/lib/rackly/catalogo'
import { Input } from '@/components/ui/input'

export function CatalogoSearchInput({
  onPick,
  value,
  onChange,
}: {
  onPick: (item: CatalogoItem) => void
  value?: string
  onChange?: (val: string) => void
}) {
  const [query, setQuery] = useState(value ?? '')
  const [results, setResults] = useState<CatalogoItem[]>([])
  const [show, setShow] = useState(false)
  const [idx, setIdx] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (value !== undefined && value !== query) {
      setQuery(value)
      setShow(false)
      setResults([])
    }
  }, [value])

  useEffect(() => {
    let cancelled = false
    async function search() {
      if (!query.trim()) {
        if (!cancelled) { setResults([]); setShow(false) }
        return
      }
      if (!isCatalogoLoaded()) {
        await fetchCatalogo()
      }
      if (cancelled) return
      const q = query.trim().toUpperCase()
      const all = findCatalogoByCodigo(q)
      if (all) {
        setResults([all])
      } else {
        const { getCachedCatalogo } = await import('@/lib/rackly/catalogo')
        const cached = getCachedCatalogo()
        const tokens = q.split(/\s+/).filter(Boolean)
        const filtered = cached.filter(
          (item) =>
            item.descripcion.toUpperCase().includes(q) ||
            tokens.every((t) => item.descripcion.toUpperCase().includes(t))
        )
        setResults(filtered.slice(0, 8))
      }
      setIdx(-1)
      setShow(true)
    }
    search()
    return () => { cancelled = true }
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShow(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function handleSelect(item: CatalogoItem) {
    setQuery(item.codigo)
    onChange?.(item.codigo)
    onPick(item)
    setShow(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!show || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault()
      handleSelect(results[idx])
    } else if (e.key === 'Escape') {
      setShow(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onChange?.(e.target.value)
        }}
        onKeyDown={handleKeyDown}
        placeholder="Buscar código o descripción..."
        autoComplete="off"
        className="h-8 bg-slate-700/50 border-slate-600/40 text-slate-200 text-xs placeholder:text-slate-500 focus:border-sky-500/50"
      />
      {show && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-slate-600/40 bg-slate-800 shadow-lg max-h-60 overflow-y-auto">
          {results.map((item, i) => (
            <button
              key={item.codigo}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                i === idx ? 'bg-sky-500/15 text-slate-100' : 'text-slate-300 hover:bg-slate-700/60'
              }`}
              onClick={() => handleSelect(item)}
            >
              <span className="font-mono font-bold text-sky-400">
                {item.codigo}
              </span>
              <span className="text-slate-600">—</span>
              <span className="truncate text-slate-300">{item.descripcion}</span>
              <span className="ml-auto flex items-center gap-2 text-[10px] text-slate-500">
                {item.stock_big_magic > 0 && (
                  <span className="bg-amber-500/10 text-amber-400 px-1.5 rounded font-medium">
                    BM:{item.stock_big_magic}
                  </span>
                )}
                {item.un}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
