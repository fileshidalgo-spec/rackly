'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Selector de ubicación con búsqueda.
 *
 * El layout canónico 2026-11 tiene 1 869 posiciones: un <Select> plano de
 * Radix con esa cantidad de opciones es inusable (render y scroll). Este
 * combobox filtra POR CÓDIGO en el cliente (R01-02…, A-0…, CN3…, REC…,
 * PP…) y muestra resultados agrupados por sector/piso con tope de filas.
 *
 * Usado por TRÁNSITO para elegir la posición destino de cada línea en
 * tránsito; el lado (A/B) lo resuelve el módulo con repLadosDeTipo.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MapPin, Search } from 'lucide-react'
import type { RepUbicacion } from '@/lib/rackly/rep/rep-tipos'

const TOPE_RESULTADOS = 60

export function SelectorUbicacionRep({
  ubicaciones,
  value,
  onChange,
  disabled,
}: {
  ubicaciones: RepUbicacion[]
  /** ubicacion_id elegido ('' = sin elegir). */
  value: string
  onChange: (ubicacionId: string) => void
  disabled?: boolean
}) {
  const [abierto, setAbierto] = useState(false)
  const [q, setQ] = useState('')
  const cajaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const elegida = useMemo(() => ubicaciones.find((u) => u.id === value) ?? null, [ubicaciones, value])

  // Cierra al hacer click fuera (un backdrop cubre la página mientras está abierto)
  useEffect(() => {
    if (!abierto) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [abierto])

  const resultados = useMemo(() => {
    const nq = q.trim().toUpperCase().replace(/\s+/g, '')
    const base = nq === '' ? ubicaciones : ubicaciones.filter((u) => {
      if (u.codigo.includes(nq)) return true
      const zonaCompacta = u.zona.replace(/\s+/g, '').toUpperCase()
      return zonaCompacta !== '' && zonaCompacta.includes(nq)
    })
    return base.slice(0, TOPE_RESULTADOS)
  }, [ubicaciones, q])

  const grupos = useMemo(() => {
    const racks1 = resultados.filter((u) => u.sector === 'racks' && u.piso === 1)
    const racks2 = resultados.filter((u) => u.sector === 'racks' && u.piso === 2)
    const zonas = resultados.filter((u) => u.sector === 'zonas')
    return [
      { etiqueta: 'Racks · 1er piso', items: racks1 },
      { etiqueta: 'Racks · 2do piso', items: racks2 },
      { etiqueta: 'Zonas', items: zonas },
    ].filter((g) => g.items.length > 0)
  }, [resultados])

  const cortados = useMemo(() => {
    if (q.trim() === '') return false
    const nq = q.trim().toUpperCase().replace(/\s+/g, '')
    return ubicaciones.filter((u) => u.codigo.includes(nq)).length > TOPE_RESULTADOS
  }, [ubicaciones, q])

  function elegir(u: RepUbicacion) {
    onChange(u.id)
    setAbierto(false)
    setQ('')
  }

  return (
    <div className="relative" ref={cajaRef}>
      {/* Gatillo: muestra el código elegido o el placeholder */}
      <button
        type="button"
        onClick={() => !disabled && setAbierto((v) => !v)}
        disabled={disabled}
        className="h-8 w-[230px] text-xs rounded-md border border-slate-300 bg-white px-2.5 flex items-center gap-1.5 disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={abierto}
      >
        <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        {elegida ? (
          <span className="font-mono font-bold text-slate-800 truncate">{elegida.codigo}</span>
        ) : (
          <span className="text-slate-400 truncate">Ubicación destino…</span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400 ml-auto shrink-0" />
      </button>

      {abierto && (
        <>
          {/* Backdrop para click fuera */}
          <div className="fixed inset-0 z-40" onClick={() => setAbierto(false)} />
          <div className="absolute z-50 mt-1 w-[290px] rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden">
            <div className="p-2 border-b border-slate-100 flex items-center gap-1.5">
              <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setAbierto(false)
                }}
                placeholder="R01-02, A-01, CN3, REC, PP…"
                className="w-full text-xs outline-none font-mono"
                aria-label="Buscar ubicación"
              />
            </div>
            <div role="listbox" className="max-h-64 overflow-y-auto py-1">
              {grupos.length === 0 && (
                <p className="px-3 py-3 text-xs text-slate-400 text-center">Sin resultados para «{q}»</p>
              )}
              {grupos.map((g) => (
                <div key={g.etiqueta}>
                  <p className="px-3 py-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-400 bg-slate-50/80">
                    {g.etiqueta}
                  </p>
                  {g.items.map((u) => (
                    <button
                      key={u.id}
                      role="option"
                      aria-selected={u.id === value}
                      onClick={() => elegir(u)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-violet-50 ${
                        u.id === value ? 'bg-violet-50' : ''
                      }`}
                    >
                      <span className="font-mono font-bold text-slate-800">{u.codigo}</span>
                      <span className="text-[10px] text-slate-400 truncate">
                        {u.sector === 'racks' ? `Rack ${String(u.rack).padStart(2, '0')} · N${u.nivel}` : u.zona}
                        {u.nota ? ` · ${u.nota}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {cortados && (
                <p className="px-3 py-1.5 text-[10px] text-slate-400 text-center border-t border-slate-100">
                  Más resultados — refina la búsqueda (tope {TOPE_RESULTADOS})
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
