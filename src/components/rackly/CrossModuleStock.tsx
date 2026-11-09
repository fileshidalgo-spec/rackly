'use client'

/**
 * CrossModuleStock — panel cruzado de stock entre módulos Racks ↔ Piso.
 *
 * "Arriba el módulo donde estás, abajo el otro módulo": este componente es la
 * ventana INFERIOR. Es SOLO LECTURA, carga perezosa (1 consulta por código
 * activo, solo si está abierto), errores VISIBLES con Reintentar y los "0
 * resultados" se muestran como dato válido (el material simplemente no está
 * en el otro módulo), nunca como fallo.
 *
 * Navegación: cada fila de ubicación es un deep-link al otro módulo —
 * Piso → Sectores (posición exacta), Racks → Ocupación (celda exacta) — vía
 * los callbacks que inyecta page.tsx (con retorno al módulo de origen).
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, ChevronDown, ExternalLink, Loader2, MapPin, PackageSearch, RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { mensajeError } from '@/lib/rackly/errores'
import { targetDesdeStockItem, type PisoTargetPosicion } from '@/lib/piso/navegacion'
import type { StockPisoItem } from '@/lib/piso/api'
import { stockPisoPorCodigo, stockRacksPorCodigo, type FilaStockRacks } from '@/lib/rackly/cruce'

type Props = {
  /** Módulo donde ESTÁ el usuario: define qué consulta y hacia dónde navegar. */
  origen: 'racks' | 'piso'
  /** Códigos candidatos (del resultado de búsqueda del módulo actual). */
  codigos: string[]
  onGotoPiso?: (target: PisoTargetPosicion) => void
  onGotoRacks?: (bloque: string, torre: string, piso: string, posicion: string) => void
  /** 'claro' = tokens shadcn (pestañas Racks) · 'oscuro' = slate (pestañas Piso). */
  variante?: 'claro' | 'oscuro'
}

const MAX_CHIPS = 8

export function CrossModuleStock({ origen, codigos, onGotoPiso, onGotoRacks, variante = 'claro' }: Props) {
  const [abierto, setAbierto] = useState(true)
  const [codigoActivoMarca, setCodigoActivoMarca] = useState<string | null>(null)
  const [filasPiso, setFilasPiso] = useState<StockPisoItem[] | null>(null)
  const [filasRacks, setFilasRacks] = useState<FilaStockRacks[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actualizado, setActualizado] = useState<Date | null>(null)
  const [recarga, setRecarga] = useState(0)
  const seqRef = useRef(0)

  const oscuro = variante === 'oscuro'
  const hacia = origen === 'racks' ? 'Piso' : 'Racks'
  const candidatos = codigos.slice(0, MAX_CHIPS)
  // Código activo DERIVADO (sin efecto de sincronización): si el código marcado
  // salió de la lista (nueva búsqueda), cae al primero — sin cascada de renders.
  const codigoActivo = codigoActivoMarca && candidatos.includes(codigoActivoMarca)
    ? codigoActivoMarca
    : (candidatos[0] ?? null)

  // Consulta perezosa: SOLO si está abierto y con código activo. 1 consulta por
  // cambio de código activo (guard por número de petición: la respuesta lenta de
  // un código anterior nunca pisa la del actual). El arranque va en un timeout
  // de 0 ms (patrón del debounce de PisoStockTab): los setState quedan FUERA del
  // cuerpo síncrono del efecto (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!abierto || !codigoActivo) return
    const req = ++seqRef.current
    const t = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        if (origen === 'racks') {
          const rows = await stockPisoPorCodigo(codigoActivo)
          if (req !== seqRef.current) return
          setFilasPiso(rows)
        } else {
          const rows = await stockRacksPorCodigo(codigoActivo)
          if (req !== seqRef.current) return
          setFilasRacks(rows)
        }
        if (req !== seqRef.current) return
        setActualizado(new Date())
      } catch (err: unknown) {
        if (req === seqRef.current) setError(mensajeError(err))
      } finally {
        if (req === seqRef.current) setLoading(false)
      }
    }, 0)
    return () => { seqRef.current++; clearTimeout(t) }
  }, [codigoActivo, abierto, origen, recarga])

  function recargar() { setRecarga((n) => n + 1) }

  // ── Estados visuales por variante ──
  const caja = oscuro ? 'border-slate-700 bg-slate-800/60' : 'border bg-card'
  const titulo = oscuro ? 'text-slate-200' : 'text-foreground'
  const textoSuave = oscuro ? 'text-slate-400' : 'text-muted-foreground'
  const chipBase = oscuro
    ? 'border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200'
    : 'border bg-muted/40 text-muted-foreground hover:text-foreground'
  const chipActivo = oscuro
    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
    : 'border-emerald-400/60 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'

  function VencBadge({ fv }: { fv: string }) {
    if (!fv) return <span className={`text-[10px] ${textoSuave}`}>—</span>
    const hoy = new Date(new Date().toDateString())
    const fVen = new Date(fv + 'T00:00:00')
    const dias = (fVen.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
    const cls = dias < 0
      ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
      : dias <= 15
        ? 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800'
        : dias <= 30
          ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
          : 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800'
    return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-semibold ${cls}`}>{fv}</Badge>
  }

  function StockBadge({ valor }: { valor: number }) {
    if (valor < 0) {
      return (
        <Badge variant="outline" className="text-xs bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800 font-bold" title="Stock negativo — inconsistencia a revisar">
          <AlertTriangle className="h-3 w-3 mr-1" />{valor}
        </Badge>
      )
    }
    return <Badge variant="default" className="text-xs">{valor}</Badge>
  }

  // ── Sin códigos candidatos: no renderizar nada (cero costo) ──
  if (candidatos.length === 0) return null

  const total = origen === 'racks'
    ? (filasPiso ?? []).reduce((s, r) => s + r.cantidad, 0)
    : (filasRacks ?? []).reduce((s, r) => s + r.stock, 0)

  return (
    <div className={`rounded-lg border overflow-hidden ${caja}`}>
      {/* Encabezado plegable */}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left ${oscuro ? 'hover:bg-slate-700/40' : 'hover:bg-accent/40'} transition-colors`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <PackageSearch className={`h-4 w-4 shrink-0 ${origen === 'racks' ? 'text-emerald-500' : 'text-cyan-500'}`} />
          <span className={`text-sm font-semibold ${titulo}`}>
            Stock en {hacia}
            {codigoActivo && <span className="font-mono ml-1.5 text-xs opacity-70">{codigoActivo}</span>}
          </span>
          {actualizado && !loading && !error && (
            <span className={`text-[10px] hidden sm:inline ${textoSuave}`}>· Actualizado {actualizado.toLocaleTimeString()}</span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {!loading && !error && <Badge variant="outline" className={`text-xs ${oscuro ? 'border-slate-600 text-slate-300' : ''}`}>Total: <span className="font-bold ml-1">{Math.round(total * 1000) / 1000}</span></Badge>}
          <ChevronDown className={`h-4 w-4 ${textoSuave} transition-transform ${abierto ? '' : '-rotate-90'}`} />
        </span>
      </button>

      {abierto && (
        <div className={`px-3 pb-3 space-y-2.5 border-t ${oscuro ? 'border-slate-700/60' : 'border-b-0'}`}>
          <p className={`text-[10px] pt-2 ${textoSuave} flex items-center gap-1`}>
            <MapPin className="h-3 w-3" />
            Ubicaciones de este artículo en el módulo {hacia} · toca una ubicación para ir
          </p>

          {/* Selector de código (si la búsqueda matcheó varios) */}
          {candidatos.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {candidatos.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCodigoActivoMarca(c)}
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-mono font-semibold transition-colors ${codigoActivo === c ? chipActivo : chipBase}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* Cargando */}
          {loading && (
            <div className={`flex items-center gap-2 py-4 justify-center text-sm ${textoSuave}`}>
              <Loader2 className="h-4 w-4 animate-spin" /> Consultando stock en {hacia}...
            </div>
          )}

          {/* Error VISIBLE con reintento (nunca vacío silencioso) */}
          {!loading && error && (
            <div className={`flex flex-col items-center gap-2 py-4 text-center`}>
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <p className={`text-xs ${textoSuave}`}>No se pudo consultar {hacia}: {error}</p>
              <button
                type="button"
                onClick={recargar}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold ${oscuro ? 'border-slate-600 text-slate-300 hover:text-white' : 'border text-foreground hover:bg-accent/40'}`}
              >
                <RefreshCw className="h-3 w-3" /> Reintentar
              </button>
            </div>
          )}

          {/* Sin stock: dato válido, no error */}
          {!loading && !error && codigoActivo && (
            origen === 'racks'
              ? (filasPiso !== null && filasPiso.length === 0)
              : (filasRacks !== null && filasRacks.length === 0)
          ) && (
            <div className={`flex items-center gap-2 py-3 justify-center text-xs ${textoSuave}`}>
              <PackageSearch className="h-4 w-4" /> Sin stock en {hacia} para {codigoActivo}
            </div>
          )}

          {/* ── Filas PISO (usuario en Racks) ── */}
          {!loading && !error && origen === 'racks' && (filasPiso ?? []).length > 0 && (
            <div className="space-y-1.5">
              {(filasPiso ?? []).map((r, i) => {
                const target = onGotoPiso ? targetDesdeStockItem(r) : null
                return (
                  <div key={i} className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${oscuro ? 'border-slate-700/60' : ''}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      {target ? (
                        <button
                          type="button"
                          onClick={() => onGotoPiso?.(target)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/60 text-[10px] font-mono font-semibold text-violet-700 dark:text-violet-300 transition-colors cursor-pointer active:scale-95 whitespace-nowrap"
                          title={`Ir a la posición en Piso · Sectores`}
                        >
                          <MapPin className="h-3 w-3" />{r.ubicacion}<ExternalLink className="h-2.5 w-2.5" />
                        </button>
                      ) : (
                        <span className={`inline-flex items-center gap-1 text-[11px] font-mono ${textoSuave}`}><MapPin className="h-3 w-3" />{r.ubicacion}</span>
                      )}
                      {r.sector_nombre && <span className={`text-[10px] hidden sm:inline truncate ${textoSuave}`}>{r.sector_nombre}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {r.codigo_inc && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 bg-rose-500/15 text-rose-400 border-rose-500/30 font-semibold">
                          <AlertTriangle className="h-2 w-2 mr-0.5" />{r.codigo_inc}
                        </Badge>
                      )}
                      <VencBadge fv={r.fecha_vencimiento} />
                      <span className={`text-xs font-bold ${oscuro ? 'text-white' : 'text-foreground'}`}>{Math.round(r.cantidad * 1000) / 1000} {r.bloque_unidad}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Filas RACKS (usuario en Piso) ── */}
          {!loading && !error && origen === 'piso' && (filasRacks ?? []).length > 0 && (
            <div className="space-y-1.5">
              {(filasRacks ?? []).map((r, i) => (
                <div key={i} className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${oscuro ? 'border-slate-700/60' : ''}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {onGotoRacks ? (
                      <button
                        type="button"
                        onClick={() => onGotoRacks?.(r.bloque, r.torre, r.piso, r.posicion)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/25 hover:border-cyan-400/60 text-[10px] font-mono font-semibold text-cyan-300 transition-colors cursor-pointer active:scale-95 whitespace-nowrap"
                        title="Ir a la celda en Racks · Ocupación"
                      >
                        <MapPin className="h-3 w-3" />{r.bloque}-{r.torre}-{r.piso}-{r.posicion}<ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    ) : (
                      <span className={`inline-flex items-center gap-1 text-[11px] font-mono ${textoSuave}`}><MapPin className="h-3 w-3" />{r.bloque}-{r.torre}-{r.piso}-{r.posicion}</span>
                    )}
                    {r.proveedor && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 bg-purple-500/15 text-purple-400 border-purple-500/30 font-semibold">{r.proveedor}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <VencBadge fv={r.fVencimiento} />
                    <span className={`text-xs font-bold ${oscuro ? 'text-white' : 'text-foreground'}`}>{Math.round(r.stock * 1000) / 1000} {r.un}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
