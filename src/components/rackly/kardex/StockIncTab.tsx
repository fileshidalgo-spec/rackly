'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { fetchIncPorUbicacion, type IncEnCelda } from '@/lib/rackly/kardex'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TriangleAlert, Search, MapPin, Package, Loader2, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react'

type IncFlatItem = {
  codigo: string
  descripcion: string
  codigoInc: string
  cantidad: number
  ubicacion: string
}

type StockIncTabProps = {
  onGotoUbicacion?: (bloque: string, torre: string, piso: string, posicion: string) => void
}

/** Parsea clave 'bloque-torre-piso-posicion' en sus partes */
function parseUbicacion(key: string): { bloque: string; torre: string; piso: string; posicion: string } | null {
  const parts = key.split('-')
  if (parts.length >= 4) return { bloque: parts[0], torre: parts[1], piso: parts[2], posicion: parts[3] }
  return null
}

export function StockIncTab({ onGotoUbicacion }: StockIncTabProps) {
  const [query, setQuery] = useState('')
  const [allItems, setAllItems] = useState<IncFlatItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const loadedRef = useRef(false)

  async function load() {
    setLoading(true)
    setError(false)
    try {
      const map = await fetchIncPorUbicacion()
      if (map._error) { setError(true); return }
      const flat: IncFlatItem[] = []
      for (const [locKey, items] of map) {
        for (const item of items) {
          flat.push({ ...item, ubicacion: locKey })
        }
      }
      setAllItems(flat)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loadedRef.current) { loadedRef.current = true; load() }
  }, [])

  const filtered = useMemo(() => {
    const term = query.trim().toUpperCase()
    if (!term) return allItems
    return allItems.filter(i =>
      i.codigo.includes(term) ||
      i.descripcion.toUpperCase().includes(term) ||
      i.codigoInc.toUpperCase().includes(term)
    )
  }, [allItems, query])

  // Agrupar por (codigo, codigoInc) para mostrar stock total + ubicaciones
  const grouped = useMemo(() => {
    const map = new Map<string, { codigo: string; descripcion: string; codigoInc: string; total: number; ubicaciones: { ubi: string; qty: number }[] }>()
    for (const item of filtered) {
      const key = `${item.codigo}||${item.codigoInc}`
      const existing = map.get(key)
      if (existing) {
        existing.total += item.cantidad
        existing.ubicaciones.push({ ubi: item.ubicacion, qty: item.cantidad })
      } else {
        map.set(key, { codigo: item.codigo, descripcion: item.descripcion, codigoInc: item.codigoInc, total: item.cantidad, ubicaciones: [{ ubi: item.ubicacion, qty: item.cantidad }] })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.codigoInc.localeCompare(b.codigoInc))
  }, [filtered])

  function handleClickUbicacion(ubiKey: string) {
    const loc = parseUbicacion(ubiKey)
    if (loc && onGotoUbicacion) {
      onGotoUbicacion(loc.bloque, loc.torre, loc.piso, loc.posicion)
    }
  }

  return (
    <div className="space-y-4">
      {/* Barra de búsqueda */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Buscar por código, descripción o número INC (ej: INC026-1108)..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="hidden sm:inline">Actualizar</span>
        </button>
      </div>

      {/* Contador de resultados */}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <TriangleAlert className="h-4 w-4 text-amber-500" />
        {loading ? (
          <span>Cargando INC...</span>
        ) : error ? (
          <span className="text-red-500">Error al cargar los datos</span>
        ) : (
          <span>
            {filtered.length} INC encontrado{filtered.length !== 1 ? 's' : ''}
            {query && ` de ${allItems.length} total`}
          </span>
        )}
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
          <p className="text-sm">No se pudieron cargar los datos de INC. Verifica tu conexión e intenta de nuevo.</p>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Tabla de resultados */}
      {!loading && !error && grouped.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-3 py-2.5 font-semibold text-slate-700">Código</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-700">Descripción</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-700">N° INC</th>
                <th className="text-right px-3 py-2.5 font-semibold text-slate-700">Total</th>
                <th className="text-left px-3 py-2.5 font-semibold text-slate-700">Ubicaciones</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(g => (
                <tr key={`${g.codigo}||${g.codigoInc}`} className="border-b border-slate-100 hover:bg-amber-50/30 transition-colors">
                  <td className="px-3 py-2.5 font-mono text-xs font-medium text-slate-900">{g.codigo}</td>
                  <td className="px-3 py-2.5 text-slate-600 max-w-[200px] truncate" title={g.descripcion}>{g.descripcion}</td>
                  <td className="px-3 py-2.5">
                    <Badge className="bg-amber-100 text-amber-800 border-amber-200 font-mono text-xs">
                      {g.codigoInc}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-slate-900">
                    {g.total % 1 === 0 ? g.total : g.total.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {g.ubicaciones.map(u => (
                        <button
                          key={u.ubi}
                          type="button"
                          onClick={() => handleClickUbicacion(u.ubi)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-200 bg-violet-50 hover:bg-violet-100 hover:border-violet-400 text-[10px] font-mono text-violet-700 transition-colors cursor-pointer"
                          title={`Ir a Ocupación: ${u.ubi}`}
                        >
                          <MapPin className="h-2.5 w-2.5" />
                          <span>{u.ubi}</span>
                          <span className="text-violet-400">({u.qty % 1 === 0 ? u.qty : u.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })})</span>
                          <ExternalLink className="h-2.5 w-2.5 ml-0.5 text-violet-400" />
                        </button>
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
        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
          <Package className="h-10 w-10 mb-2" />
          <p className="text-sm font-medium">
            {query ? 'No se encontraron INC para esta búsqueda' : 'No hay stock INC registrado'}
          </p>
        </div>
      )}
    </div>
  )
}
