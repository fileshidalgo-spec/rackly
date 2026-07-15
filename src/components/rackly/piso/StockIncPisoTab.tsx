'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { stockPisoGlobal, type StockPisoItem } from '@/lib/piso/api'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TriangleAlert, Search, MapPin, Package, Loader2, AlertCircle, RefreshCw } from 'lucide-react'

type IncGrouped = {
  bloque_codigo: string
  bloque_descripcion: string
  bloque_unidad: string
  codigoInc: string
  total: number
  ubicaciones: { sector: string; ubi: string; qty: number; vencimiento: string }[]
}

export function StockIncPisoTab() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<StockPisoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const loadedRef = useRef(false)

  async function load() {
    setLoading(true)
    setError(false)
    try {
      const data = await stockPisoGlobal()
      setItems(data)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loadedRef.current) { loadedRef.current = true; load() }
  }, [])

  // Filtrar solo INC y buscar
  const filtered = useMemo(() => {
    const incOnly = items.filter(i => !!i.codigo_inc)
    const term = query.trim().toUpperCase()
    if (!term) return incOnly
    return incOnly.filter(i =>
      i.bloque_codigo.toUpperCase().includes(term) ||
      i.bloque_descripcion.toUpperCase().includes(term) ||
      (i.codigo_inc && i.codigo_inc.toUpperCase().includes(term))
    )
  }, [items, query])

  // Agrupar por (bloque_codigo, codigo_inc)
  const grouped = useMemo(() => {
    const map = new Map<string, IncGrouped>()
    for (const item of filtered) {
      const inc = item.codigo_inc!
      const key = `${item.bloque_codigo}||${inc}`
      const existing = map.get(key)
      if (existing) {
        existing.total += item.cantidad
        existing.ubicaciones.push({
          sector: item.sector_nombre,
          ubi: item.ubicacion,
          qty: item.cantidad,
          vencimiento: item.fecha_vencimiento,
        })
      } else {
        map.set(key, {
          bloque_codigo: item.bloque_codigo,
          bloque_descripcion: item.bloque_descripcion,
          bloque_unidad: item.bloque_unidad,
          codigoInc: inc,
          total: item.cantidad,
          ubicaciones: [{
            sector: item.sector_nombre,
            ubi: item.ubicacion,
            qty: item.cantidad,
            vencimiento: item.fecha_vencimiento,
          }],
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.codigoInc.localeCompare(b.codigoInc))
  }, [filtered])

  return (
    <div className="space-y-4">
      {/* Barra de búsqueda */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Buscar por código, descripción o número INC..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-9 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-slate-500"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="hidden sm:inline">Actualizar</span>
        </button>
      </div>

      {/* Contador */}
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <TriangleAlert className="h-4 w-4 text-amber-500" />
        {loading ? (
          <span>Cargando INC...</span>
        ) : error ? (
          <span className="text-red-400">Error al cargar los datos</span>
        ) : (
          <span>
            {filtered.length} INC encontrado{filtered.length !== 1 ? 's' : ''}
            {query && ` de ${items.filter(i => !!i.codigo_inc).length} total`}
          </span>
        )}
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-950/50 border border-red-800 text-red-300">
          <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
          <p className="text-sm">No se pudieron cargar los datos de INC. Verifica tu conexión e intenta de nuevo.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
        </div>
      )}

      {/* Tabla */}
      {!loading && !error && grouped.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/80 border-b border-slate-700">
                <th className="text-left px-3 py-2.5 font-semibold text-slate-300">Código</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-300">Descripción</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-300">N° INC</th>
                <th className="text-right px-3 py-2.5 font-semibold text-slate-300">Total</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-300">Ubicaciones</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(g => (
                <tr key={`${g.bloque_codigo}||${g.codigoInc}`} className="border-b border-slate-800 hover:bg-amber-500/5 transition-colors">
                  <td className="px-3 py-2.5 font-mono text-xs font-medium text-white">{g.bloque_codigo}</td>
                  <td className="px-3 py-2.5 text-slate-400 max-w-[200px] truncate" title={g.bloque_descripcion}>{g.bloque_descripcion}</td>
                  <td className="px-3 py-2.5">
                    <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 font-mono text-xs">
                      {g.codigoInc}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-white">
                    {g.total % 1 === 0 ? g.total : g.total.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                    <span className="text-slate-500 text-xs ml-1">{g.bloque_unidad}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {g.ubicaciones.map((u, idx) => (
                        <Badge key={idx} variant="outline" className="text-[10px] font-mono text-slate-400 border-slate-700">
                          {u.sector && <span className="text-sky-400 mr-1">{u.sector}</span>}
                          <MapPin className="h-2.5 w-2.5 mr-0.5" />
                          {u.ubi}
                          <span className="ml-1 text-slate-500">({u.qty % 1 === 0 ? u.qty : u.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })})</span>
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sin resultados */}
      {!loading && !error && grouped.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-slate-500">
          <Package className="h-10 w-10 mb-2" />
          <p className="text-sm font-medium">
            {query ? 'No se encontraron INC para esta búsqueda' : 'No hay stock INC registrado en Piso'}
          </p>
        </div>
      )}
    </div>
  )
}