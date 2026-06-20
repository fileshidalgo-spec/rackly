'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, CalendarOff, ChevronLeft, ChevronRight, X } from 'lucide-react'

/**
 * FechaVencimientoField — Calendario custom para fecha de vencimiento.
 *
 * Formato visual: DD-MM-YYYY (input y display)
 * Formato interno/sistema: YYYY-MM-DD (onChange devuelve este formato)
 *
 * Por qué NO usamos <input type="date"> nativo:
 * El date picker nativo se cierra cuando CUALQUIER cosa en el DOM se re-renderiza.
 * Solución: Calendario custom montado via createPortal en document.body.
 */

interface FechaVencimientoFieldProps {
  value: string  // formato YYYY-MM-DD (interno)
  disabled: boolean
  variant: 'ing' | 'dev' | 'inc'
  onChange: (value: string) => void  // formato YYYY-MM-DD
  onToggleSin: () => void
}

const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const MESES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DIAS_SEMANA = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom']

// ═══ Utilidades de fecha ═══

function getDaysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

function getFirstDayOfWeek(y: number, m: number): number {
  const d = new Date(y, m - 1, 1).getDay()
  return d === 0 ? 6 : d - 1
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Formato interno: YYYY-MM-DD */
function toInternal(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** Formato display: DD-MM-YYYY */
function toDisplay(y: number, m: number, d: number): string {
  return `${pad(d)}-${pad(m)}-${y}`
}

/** Parsear YYYY-MM-DD */
function parseInternal(v: string): { y: number; m: number; d: number } | null {
  if (!v) return null
  const parts = v.split('-')
  if (parts.length !== 3) return null
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const d = parseInt(parts[2], 10)
  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

/** Parsear DD-MM-YYYY */
function parseDisplay(v: string): { y: number; m: number; d: number } | null {
  if (!v) return null
  const parts = v.split('-')
  if (parts.length !== 3) return null
  const d = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const y = parseInt(parts[2], 10)
  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

/** Auto-formatear mientras el usuario escribe DD-MM-YYYY */
function autoFormatInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`
}

type CalView = 'days' | 'months'

type CalendarState = {
  year: number
  month: number
  selectedDay: number | null
  position: { top: number; left: number }
  view: CalView
}

// NOTA: Se quitó React.memo porque causaba stale closures:
// el memo solo comparaba value/disabled/variant y NO onChange/onToggleSin,
// por lo que el componente se quedaba con un onChange viejo que referenciaba
// estado obsoleto, causando que seleccionar fecha borrara los demás campos.
const FechaVencimientoField = function FechaVencimientoField({
  value,
  disabled,
  variant,
  onChange,
  onToggleSin,
}: FechaVencimientoFieldProps) {
  const [displayValue, setDisplayValue] = useState(() => {
    const p = parseInternal(value)
    return p ? toDisplay(p.y, p.m, p.d) : ''
  })
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calState, setCalState] = useState<CalendarState | null>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)

  // Sincronizar valor del padre (solo cuando el calendario está cerrado)
  useEffect(() => {
    if (!calendarOpen) {
      const p = parseInternal(value)
      setDisplayValue(p ? toDisplay(p.y, p.m, p.d) : '')
    }
  }, [value, calendarOpen])

  // Cleanup al desmontar
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      document.removeEventListener('mousedown', handleGlobalClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [])

  // ═══ Abrir / cerrar calendario ═══

  const openCalendar = () => {
    if (disabled) return
    const now = new Date()
    const parsed = parseInternal(value)
    const y = parsed?.y ?? now.getFullYear()
    const m = parsed?.m ?? (now.getMonth() + 1)

    let top = 0
    let left = 0
    if (inputContainerRef.current) {
      const rect = inputContainerRef.current.getBoundingClientRect()
      top = rect.bottom + 4
      left = Math.max(8, Math.min(rect.left, window.innerWidth - 260))
    }

    setCalState({ year: y, month: m, selectedDay: parsed?.d ?? null, position: { top, left }, view: 'days' })
    setCalendarOpen(true)

    setTimeout(() => {
      document.addEventListener('mousedown', handleGlobalClick)
      document.addEventListener('keydown', handleEsc)
    }, 150)
  }

  const closeCalendar = useCallback(() => {
    setCalendarOpen(false)
    setCalState(null)
    document.removeEventListener('mousedown', handleGlobalClick)
    document.removeEventListener('keydown', handleEsc)
  }, [])

  // ═══ Click fuera / Escape ═══

  const handleGlobalClick = (e: MouseEvent) => {
    if (!mountedRef.current) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cal-popup]')) return
    if (inputContainerRef.current?.contains(target)) return
    closeCalendar()
  }

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeCalendar()
  }

  // ═══ Navegación del calendario ═══

  const selectDay = useCallback((day: number) => {
    if (!calState) return
    const internal = toInternal(calState.year, calState.month, day)
    setDisplayValue(toDisplay(calState.year, calState.month, day))
    onChange(internal)
    closeCalendar()
  }, [calState, onChange, closeCalendar])

  const prevMonth = useCallback(() => {
    setCalState(prev => {
      if (!prev) return prev
      if (prev.month === 1) return { ...prev, month: 12, year: prev.year - 1 }
      return { ...prev, month: prev.month - 1 }
    })
  }, [])

  const nextMonth = useCallback(() => {
    setCalState(prev => {
      if (!prev) return prev
      if (prev.month === 12) return { ...prev, month: 1, year: prev.year + 1 }
      return { ...prev, month: prev.month + 1 }
    })
  }, [])

  const prevYear = useCallback(() => {
    setCalState(prev => prev ? { ...prev, year: prev.year - 1 } : prev)
  }, [])

  const nextYear = useCallback(() => {
    setCalState(prev => prev ? { ...prev, year: prev.year + 1 } : prev)
  }, [])

  const switchToMonthView = useCallback(() => {
    setCalState(prev => prev ? { ...prev, view: 'months' } : prev)
  }, [])

  const selectMonth = useCallback((m: number) => {
    setCalState(prev => prev ? { ...prev, month: m, view: 'days' } : prev)
  }, [])

  // ═══ Input manual ═══

  const handleManualChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    const formatted = autoFormatInput(raw)
    setDisplayValue(formatted)

    // Si completó DD-MM-YYYY, notificar al padre en formato interno
    if (/^\d{2}-\d{2}-\d{4}$/.test(formatted)) {
      const p = parseDisplay(formatted)
      if (p) onChange(toInternal(p.y, p.m, p.d))
    }
  }

  const handleManualBlur = () => {
    if (displayValue && displayValue !== '') {
      const p = parseDisplay(displayValue)
      if (p) {
        const internal = toInternal(p.y, p.m, p.d)
        setDisplayValue(toDisplay(p.y, p.m, p.d))
        onChange(internal)
      } else {
        // Revertir al valor del padre
        const pp = parseInternal(value)
        setDisplayValue(pp ? toDisplay(pp.y, pp.m, pp.d) : '')
      }
    } else {
      const pp = parseInternal(value)
      setDisplayValue(pp ? toDisplay(pp.y, pp.m, pp.d) : '')
    }
  }

  // ═══ Colores por variante ═══

  const accentBg = variant === 'ing' ? 'bg-emerald-600' : variant === 'dev' ? 'bg-amber-600' : 'bg-purple-600'
  const accentText = variant === 'ing' ? 'text-emerald-400' : variant === 'dev' ? 'text-amber-400' : 'text-purple-400'
  const borderActive = variant === 'ing' ? 'border-emerald-500/50 focus-within:ring-emerald-500/30'
    : variant === 'dev' ? 'border-amber-500/50 focus-within:ring-amber-500/30'
    : 'border-purple-500/50 focus-within:ring-purple-500/30'

  const btnActiveStyle = variant === 'ing'
    ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-400 shadow-inner'
    : variant === 'dev'
      ? 'bg-amber-600/20 border-amber-500/40 text-amber-400 shadow-inner'
      : 'bg-purple-500/20 border-purple-500/40 text-purple-300 shadow-inner'

  return (
    <div className="col-span-12 sm:col-span-6 flex items-end gap-2">
      <div className="flex-1" ref={inputContainerRef}>
        <label className="text-[10px] text-slate-400 font-medium">Fecha de Vencimiento</label>
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={displayValue}
              onChange={handleManualChange}
              onBlur={handleManualBlur}
              disabled={disabled}
              placeholder="DD-MM-YYYY"
              maxLength={10}
              className={[
                'w-full h-9 rounded-xl border text-xs pl-8 pr-2 font-mono text-white focus:outline-none focus:ring-2',
                disabled
                  ? 'border-slate-700 bg-slate-800/50 text-slate-600 cursor-not-allowed'
                  : `${borderActive} bg-slate-900`,
              ].join(' ')}
            />
          </div>
          {!disabled && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); openCalendar() }}
              className="h-9 w-9 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition-colors shrink-0"
            >
              <Calendar className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleSin}
        className={[
          'flex items-center gap-1 px-2.5 h-9 rounded-xl text-[10px] font-semibold border transition-colors whitespace-nowrap',
          disabled ? btnActiveStyle : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400',
        ].join(' ')}
      >
        <CalendarOff className="h-3 w-3" />
        Sin vencimiento
      </button>

      {/* ═══ PORTAL del Calendario ═══ */}
      {calendarOpen && calState && typeof document !== 'undefined' && createPortal(
        <div
          data-cal-popup
          className="fixed inset-0 z-[99999]"
          style={{ pointerEvents: 'none' }}
        >
          <div
            className="absolute bg-slate-800 border border-slate-600/80 rounded-xl shadow-2xl shadow-black/60 p-3 w-[250px] select-none"
            style={{
              top: calState.position.top,
              left: calState.position.left,
              pointerEvents: 'auto',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {calState.view === 'days' ? (
              /* ═══ VISTA DÍAS ═══ */
              <>
                {/* Header: < Mes Año > X */}
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); prevMonth() }}
                    className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); switchToMonthView() }}
                    className={`text-xs font-bold px-2 py-1 rounded-lg transition-colors ${accentText} hover:bg-slate-700`}
                  >
                    {MESES_LARGO[calState.month - 1]} {calState.year}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); nextMonth() }}
                      className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); closeCalendar() }}
                      className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Días de la semana */}
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                  {DIAS_SEMANA.map((d) => (
                    <div key={d} className="text-center text-[10px] font-semibold text-slate-500 py-1">{d}</div>
                  ))}
                </div>

                {/* Celdas de días */}
                <div className="grid grid-cols-7 gap-0.5">
                  {(() => {
                    const daysInMonth = getDaysInMonth(calState.year, calState.month)
                    const firstDay = getFirstDayOfWeek(calState.year, calState.month)
                    const today = new Date()
                    const todayStr = toInternal(today.getFullYear(), today.getMonth() + 1, today.getDate())
                    const cells: (number | null)[] = []
                    for (let i = 0; i < firstDay; i++) cells.push(null)
                    for (let d = 1; d <= daysInMonth; d++) cells.push(d)

                    return cells.map((day, i) => {
                      if (day === null) return <div key={`e-${i}`} />
                      const isSelected = day === calState.selectedDay
                      const dateStr = toInternal(calState.year, calState.month, day)
                      const isToday = dateStr === todayStr
                      return (
                        <button
                          key={day}
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); selectDay(day) }}
                          className={[
                            'h-7 w-full rounded-lg text-[11px] font-medium transition-colors',
                            isSelected
                              ? `${accentBg} text-white shadow-md`
                              : isToday
                                ? 'bg-slate-700 text-white font-bold'
                                : 'text-slate-300 hover:bg-slate-700/60',
                          ].join(' ')}
                        >
                          {day}
                        </button>
                      )
                    })
                  })()}
                </div>

                {/* Hoy */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    const today = new Date()
                    const internal = toInternal(today.getFullYear(), today.getMonth() + 1, today.getDate())
                    setDisplayValue(toDisplay(today.getFullYear(), today.getMonth() + 1, today.getDate()))
                    onChange(internal)
                    closeCalendar()
                  }}
                  className="mt-2 w-full text-center text-[10px] text-slate-400 hover:text-white py-1 rounded-lg hover:bg-slate-700/60 transition-colors"
                >
                  Hoy
                </button>
              </>
            ) : (
              /* ═══ VISTA MESES ═══ */
              <>
                {/* Header: < Año > */}
                <div className="flex items-center justify-between mb-3">
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); prevYear() }}
                    className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-bold text-white">{calState.year}</span>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); nextYear() }}
                    className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                {/* Grid de 12 meses */}
                <div className="grid grid-cols-3 gap-1.5">
                  {MESES_CORTO.map((mes, idx) => {
                    const m = idx + 1
                    const isCurrent = m === calState.month
                    return (
                      <button
                        key={mes}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); selectMonth(m) }}
                        className={[
                          'h-9 rounded-lg text-[11px] font-medium transition-colors',
                          isCurrent
                            ? `${accentBg} text-white shadow-md font-bold`
                            : 'text-slate-300 hover:bg-slate-700/60',
                        ].join(' ')}
                      >
                        {mes}
                      </button>
                    )
                  })}
                </div>

                {/* Volver a días */}
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setCalState(prev => prev ? { ...prev, view: 'days' as CalView } : prev) }}
                  className="mt-3 w-full text-center text-[10px] text-slate-400 hover:text-white py-1 rounded-lg hover:bg-slate-700/60 transition-colors"
                >
                  Volver a dias
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default FechaVencimientoField