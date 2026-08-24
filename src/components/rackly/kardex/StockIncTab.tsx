'use client'

import { useState, useMemo } from 'react'
import { dataClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TriangleAlert, Search, MapPin, Package, Loader2, AlertCircle, ExternalLink } from 'lucide-react'

type IncResult = {
  codigo: string
  descripcion: string
  codigoInc: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  cantidad: number
  un: string
}

type StockIncTabProps = {
  onGotoUbicacion?: (bloque: string, torre: string, piso: string, posicion: string) => void
}

export function StockIncTab({ onGotoUbicacion }: StockIncTabProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IncResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [searched, setSearched] = useState(false)

  async function handleSearch() {
    const term = query.trim()
    if (!term) return
    setLoading(true)
    setError(false)
    setSearched(true)
    try {
      const upper = term.toUpperCase()
      const { data, error: dbError } = await dataClient
        .from('movimientos')
        .select('bloque, torre, piso, posicion, codigo, descripcion, un, codigo_inc, tipo, cantidad')
        .not('codigo_inc', 'is', null)
        .neq('codigo_inc', '')
        .or(`codigo.ilike.%${upper}%,codigo_inc.ilike.%${upper}%,descripcion.ilike.%${upper}%`)
        .limit(5000)

      if (dbError) {
        console.error('[StockIncTab] Error:', dbError.message)
        setError(true)
        return
      }

      if (!data || data.length === 0) {
        setResults([])
        return
      }

      // Calcular stock neto por (ubicacion, codigo, codigo_inc)
      const stockMap = new Map<string, IncResult>()
      for (const r of data as Record<string, unknown>[]) {
        const posKey = `${r.bloque}-${r.torre}-${r.piso}-${r.posicion}`
        const code = String(r.codigo ?? '').trim().toUpperCase()
        const codeInc = String(r.codigo_inc ?? '').trim()
        const desc = String(r.descripcion ?? '')
        const un = String(r.un ?? '')
        const qty = typeof r.cantidad === 'number' ? r.cantidad : parseFloat(String(r.cantidad ?? '0')) || 0
        const tipo = String(r.tipo ?? '')
        const delta = ['ingreso', 'devolucion', 'traslado', 'stock_inicial'].includes(tipo) ? qty : -qty
        const mapKey = `${posKey}||${code}||${codeInc}`

        const existing = stockMap.get(mapKey)
        if (existing) {
          existing.cantidad += delta
        } else {
          const [bloque, torre, piso, posicion] = posKey.split('-')
          stockMap.set(mapKey, {
            codigo: code, descripcion: desc, codigoInc: codeInc,
            bloque, torre, piso, posicion, cantidad: delta, un,
          })
        }
      }

      // Filtrar stock > 0 y agrupar por (codigo, codigoInc) para mostrar ubicaciones
      const filtered = [...stockMap.values()].filter(r => r.cantidad > 0)
      filtered.sort((a, b) => a.codigoInc.localeCompare(b.codigoInc) || a.codigo.localeCompare(b.codigo))
      setResults(filtered)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  // Agrupar resultados para la tabla
  const grouped = useMemo(() => {
    const map = new Map<string, { codigo: string; descripcion: string; codigoInc: string; total: number; ubicaciones: { bloque: string; torre: string; piso: string; posicion: string; ubi: string; qty: number }[] }>()
    for (const r of results) {
      const key = `${r.codigo}||${r.codigoInc}`
      const existing = map.get(key)
      const ubi = `${r.bloque}-${r.torre}-${r.piso}-${r.posicion}`
      if (existing) {
        existing.total += r.cantidad
        existing.ubicaciones.push({ bloque: r.bloque, torre: r.torre, piso: r.piso, posicion: r.posicion, ubi, qty: r.cantidad })
      } else {
        map.set(key, { codigo: r.codigo, descripcion: r.descripcion, codigoInc: r.codigoInc, total: r.cantidad, ubicaciones: [{ bloque: r.bloque, torre: r.torre, piso: r.piso, posicion: r.posicion, ubi, qty: r.cantidad }] })
      }
    }
    return Array.from(map.values())
  }, [results])

  function handleClickUbicacion(bloque: string, torre: string, piso: string, posicion: string) {
    onGotoUbicacion?.(bloque, torre, piso, posicion)
  }

  return (
    <div className="space-y-4">
      {/* Barra de búsqueda */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Buscar INC (ej: INC026-1108) o código de artículo..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
            className="pl-9"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-rose-500 to-pink-600 text-white text-sm font-semibold hover:from-rose-600 hover:to-pink-700 shadow-md shadow-rose-500/20 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="hidden sm:inline">Buscar INC</span>
        </button>
      </div>

      {/* Contador de resultados */}
      {searched && !loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <TriangleAlert className="h-4 w-4 text-amber-500" />
          {error ? (
            <span className="text-red-500">Error al cargar los datos</span>
          ) : (
            <span>
              {results.length} ubicacion{results.length !== 1 ? 'es' : ''} con INC encontrada{results.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

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
                <th className="text-left px-3 py-2.5 font-semibold text-slate-700">Ubicaciones (clic para ir)</th>
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
                          onClick={() => handleClickUbicacion(u.bloque, u.torre, u.piso, u.posicion)}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-violet-300 bg-violet-50 hover:bg-violet-100 hover:border-violet-500 text-[10px] font-mono text-violet-700 transition-colors cursor-pointer shadow-sm hover:shadow-md"
                          title={`Ir a Ocupación: ${u.ubi}`}
                        >
                          <MapPin className="h-3 w-3 text-violet-500" />
                          <span className="font-semibold">{u.ubi}</span>
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
      {!loading && searched && !error && results.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
          <Package className="h-10 w-10 mb-2" />
          <p className="text-sm font-medium">No se encontraron INC para esta búsqueda</p>
        </div>
      )}

      {/* Estado inicial */}
      {!searched && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
          <Search className="h-10 w-10 mb-2" />
          <p className="text-sm font-medium">Escribe un código INC o código de artículo y presiona Buscar</p>
          <p className="text-xs mt-1">Ejemplo: INC026-1108</p>
        </div>
      )}
    </div>
  )
}
