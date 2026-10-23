'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { dataClient } from '@/lib/supabase/client'
import { terminoBusquedaSeguro } from '@/lib/rackly/formato'
import { loadTabState, saveTabState } from '@/lib/rackly/tab-state'
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
  // Búsqueda persistida (inicializador lazy): al volver desde Ocupación continúa donde quedó
  const [query, setQuery] = useState(() => loadTabState('racks.stock-inc', { q: '' }).q)
  const [results, setResults] = useState<IncResult[]>([])
  // FIX auditoría 2026-10-16: neto REAL por (codigo||codigoInc) sobre TODAS las
  // filas (incluidas las negativas) — antes el total de `grouped` sumaba solo
  // las filas positivas y sobrestimaba: un INC con −5 en A y +10 en B mostraba
  // total 10 en vez de 5.
  const [netos, setNetos] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [searched, setSearched] = useState(false)

  // Persistir el término (se restaura al volver desde Ocupación; la búsqueda se
  // re-ejecuta con Enter, igual que en una visita nueva)
  useEffect(() => {
    saveTabState('racks.stock-inc', { q: query })
  }, [query])

  async function handleSearch() {
    const term = query.trim()
    if (!term) return
    if (loading) return // evita búsquedas concurrentes (Enter repetido)
    // Saneo igual que en Recepción/Atención: la coma/paréntesis del término
    // rompía el filtro .or() de PostgREST y la pestaña quedaba en error.
    const upper = terminoBusquedaSeguro(term.toUpperCase())
    if (!upper) return
    setLoading(true)
    setError(false)
    setSearched(true)
    try {
      // Paginado explícito (antes .limit(5000): si una búsqueda amplia matcheaba más
      // de 5000 movimientos, el stock neto INC se calculaba con datos incompletos).
      // PASO 1: filas que matchean el término (código, INC o descripción)
      const allRows: Record<string, unknown>[] = []
      const idsVistos = new Set<string>()
      let from = 0
      const BATCH = 1000
      const MAX_PAGES = 50
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error: dbError } = await dataClient
          .from('movimientos')
          .select('id, bloque, torre, piso, posicion, codigo, descripcion, un, codigo_inc, tipo, cantidad')
          .not('codigo_inc', 'is', null)
          .neq('codigo_inc', '')
          .or(`codigo.ilike.%${upper}%,codigo_inc.ilike.%${upper}%,descripcion.ilike.%${upper}%`)
          .order('id', { ascending: true })
          .range(from, from + BATCH - 1)
        if (dbError) {
          console.error('[StockIncTab] Error:', dbError.message)
          setError(true)
          return
        }
        const rows = data ?? []
        for (const r of rows) idsVistos.add(String((r as { id: unknown }).id))
        allRows.push(...rows)
        if (rows.length < BATCH) break
        from += BATCH
      }

      // PASO 2: completar los PARES ingreso/salida. Si el término solo matcheaba
      // la descripción del ingreso, su fila de SALIDA (misma codigo_inc, distinta
      // descripción) no venía y el stock INC quedaba SOBREESTIMADO. Se traen
      // todas las filas de los codigo_inc detectados y se deduplica por id.
      const incs = [...new Set(allRows.map((r) => String(r.codigo_inc ?? '').trim()).filter(Boolean))]
      if (incs.length > 0) {
        for (let i = 0; i < incs.length; i += 500) {
          const chunk = incs.slice(i, i + 500)
          let incFrom = 0
          for (;;) {
            const { data: extra, error: incErr } = await dataClient
              .from('movimientos')
              .select('id, bloque, torre, piso, posicion, codigo, descripcion, un, codigo_inc, tipo, cantidad')
              .not('codigo_inc', 'is', null)
              .neq('codigo_inc', '')
              .in('codigo_inc', chunk)
              .order('id', { ascending: true })
              .range(incFrom, incFrom + BATCH - 1)
            if (incErr) {
              console.error('[StockIncTab] Error completando pares INC:', incErr.message)
              break // degradación elegante: se netea solo con lo ya traído
            }
            const rows = extra ?? []
            for (const r of rows) {
              const rid = String((r as { id: unknown }).id)
              if (!idsVistos.has(rid)) {
                idsVistos.add(rid)
                allRows.push(r)
              }
            }
            if (rows.length < BATCH) break
            incFrom += BATCH
          }
        }
      }

      const data = allRows

      if (!data || data.length === 0) {
        setResults([])
        setNetos(new Map())
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

      // Filtrar stock > 0 (redondeado a 3 decimales: evita residuos float de las
      // sumas binarias) y agrupar por (codigo, codigoInc) para mostrar ubicaciones
      const filtered = [...stockMap.values()]
        .map(r => ({ ...r, cantidad: Math.round(r.cantidad * 1000) / 1000 }))
        .filter(r => r.cantidad > 0)
      filtered.sort((a, b) => a.codigoInc.localeCompare(b.codigoInc) || a.codigo.localeCompare(b.codigo))
      const net = new Map<string, number>()
      for (const r of stockMap.values()) {
        const k = `${r.codigo}||${r.codigoInc}`
        net.set(k, Math.round(((net.get(k) ?? 0) + r.cantidad) * 1000) / 1000)
      }
      setNetos(net)
      setResults(filtered)
    } catch (err) {
      // FIX auditoría Task 20 (E3): la UI ya mostraba el estado de error, pero
      // la causa se tragaba sin rastro — imposible diagnosticar fallas de red/
      // RLS desde los logs del navegador.
      console.error('[StockIncTab] Error cargando stock INC:', err)
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
        // El TOTAL viene SIEMPRE de `netos` (neto real con negativos);
        // las ubicaciones listadas son solo las filas con stock > 0.
        existing.ubicaciones.push({ bloque: r.bloque, torre: r.torre, piso: r.piso, posicion: r.posicion, ubi, qty: r.cantidad })
      } else {
        map.set(key, { codigo: r.codigo, descripcion: r.descripcion, codigoInc: r.codigoInc, total: netos.get(key) ?? r.cantidad, ubicaciones: [{ bloque: r.bloque, torre: r.torre, piso: r.piso, posicion: r.posicion, ubi, qty: r.cantidad }] })
      }
    }
    return Array.from(map.values())
  }, [results, netos])

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
