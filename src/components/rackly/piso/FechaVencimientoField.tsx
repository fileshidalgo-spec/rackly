'use client'

import { useState, useRef, memo, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, CalendarOff, ChevronLeft, ChevronRight, X } from 'lucide-react'

/**
 * FechaVencimientoField — Calendario custom para fecha de vencimiento.
 *
 * Por qué NO usamos <input type="date"> nativo:
 * El date picker nativo se cierra cuando CUALQUIER cosa en el DOM se re-renderiza,
 * incluso si es un elemento hermano. PisoSectoresTab tiene ~40 useState y
 * usePisoRealtime causa re-renders. Aunque React.memo evite re-renderizar
 * ESTE componente, el navegador igual cierra el popup nativo cuando
 * elementos hermanos cambian en el DOM.
 *
 * Solución: Calendario custom montado via createPortal en document.body,
 * completamente independiente del DOM del formulario.
 */

interface FechaVencimientoFieldProps {
  value: string
  disabled: boolean
  variant: 'ing' | 'dev' | 'inc'
  onChange: (value: string) => void
  onToggleSin: () => void
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DIAS_SEMANA = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom']

function getDaysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

function getFirstDayOfWeek(y: number, m: number): number {
  const d = new Date(y, m - 1, 1).getDay()
  // Convertir: 0=Dom -> 6, 1=Lun -> 0, ..., 6=Sab -> 5
  return d === 0 ? 6 : d - 1
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

type CalendarState = {
  year: number
  month: number
  selectedDay: number | null
  position: { top: number; left: number }
}

const FechaVencimientoField = memo(function FechaVencimientoField({
  value,
  disabled,
  variant,
  onChange,
  onToggleSin,
}: FechaVencimientoFieldProps) {
  const [manualInput, setManualInput] = useState(value)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calState, setCalState] = useState<CalendarState | null>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)

  // Sincronizar valor del padre
  useEffect(() => {
    if (!calendarOpen) {
      setManualInput(value)
    }
  }, [value, calendarOpen])

  // Cleanup al desmontar
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Quitar listener global
      document.removeEventListener('mousedown', handleGlobalClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [])

  // Parsear la fecha actual
  const parseValue = useCallback((v: string) => {
    if (!v) return null
    const parts = v.split('-')
    if (parts.length !== 3) return null
    const y = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const d = parseInt(parts[2], 10)
    if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null
    return { y, m, d }
  }, [])

  const openCalendar = () => {
    if (disabled) return
    const now = new Date()
    const parsed = parseValue(value)
    const y = parsed?.y ?? now.getFullYear()
    const m = parsed?.m ?? (now.getMonth() + 1)

    let top = 0
    let left = 0
    if (inputContainerRef.current) {
      const rect = inputContainerRef.current.getBoundingClientRect()
      top = rect.bottom + 4
      left = Math.max(8, Math.min(rect.left, window.innerWidth - 260))
    }

    setCalState({ year: y, month: m, selectedDay: parsed?.d ?? null, position: { top, left } })
    setCalendarOpen(true)

    // Agregar listeners globales con delay para evitar cierre inmediato
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

  const handleGlobalClick = (e: MouseEvent) => {
    if (!mountedRef.current) return
    const target = e.target as HTMLElement
    // Si el click es dentro del popup del calendario, no cerrar
    if (target.closest('[data-cal-popup]')) return
    // Si el click es dentro del input container, no cerrar (el botón del calendario lo maneja)
    if (inputContainerRef.current?.contains(target)) return
    closeCalendar()
  }

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeCalendar()
  }

  const selectDay = useCallback((day: number) => {
    if (!calState) return
    const formatted = fmt(calState.year, calState.month, day)
    setManualInput(formatted)
    onChange(formatted)
    closeCalendar()
  }, [calState, onChange, closeCalendar])

  const prevMonth = useCallback(() => {
    if (!calState) return
    setCalState(prev => {
      if (!prev) return prev
      if (prev.month === 1) return { ...prev, month: 12, year: prev.year - 1 }
      return { ...prev, month: prev.month - 1 }
    })
  }, [calState])

  const nextMonth = useCallback(() => {
    if (!calState) return
    setCalState(prev => {
      if (!prev) return prev
      if (prev.month === 12) return { ...prev, month: 1, year: prev.year + 1 }
      return { ...prev, month: prev.month + 1 }
    })
  }, [calState])

  const handleManualChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setManualInput(v)
    // Auto-formatear mientras escribe: si escribe 2025-06-15, notificar
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const p = parseValue(v)
      if (p) onChange(v)
    }
  }

  const handleManualBlur = () => {
    // Al perder foco, si escribió una fecha válida, usarla
    if (manualInput && manualInput !== value) {
      const p = parseValue(manualInput)
      if (p) {
        onChange(manualInput)
      } else {
        setManualInput(value) // Revertir si no es válido
      }
    } else if (!manualInput) {
      setManualInput(value)
    }
  }

  const accentBg = variant === 'ing' ? 'bg-emerald-600' : variant === 'dev' ? 'bg-amber-600' : 'bg-purple-600'
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
              value={manualInput}
              onChange={handleManualChange}
              onBlur={handleManualBlur}
              disabled={disabled}
              placeholder="YYYY-MM-DD"
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

      {/* Calendario — PORTAL en document.body, completamente independiente del DOM del formulario */}
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
          >
            {/* Header con navegación */}
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); prevMonth() }}
                className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-bold text-slate-200">
                {MESES[calState.month - 1]} {calState.year}
              </span>
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
                const todayStr = fmt(today.getFullYear(), today.getMonth() + 1, today.getDate())
                const cells: (number | null)[] = []
                for (let i = 0; i < firstDay; i++) cells.push(null)
                for (let d = 1; d <= daysInMonth; d++) cells.push(d)

                return cells.map((day, i) => {
                  if (day === null) return <div key={`e-${i}`} />
                  const isSelected = day === calState.selectedDay
                  const dateStr = fmt(calState.year, calState.month, day)
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

            {/* Opción de hoy */}
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                const today = new Date()
                const todayStr = fmt(today.getFullYear(), today.getMonth() + 1, today.getDate())
                setManualInput(todayStr)
                onChange(todayStr)
                closeCalendar()
              }}
              className="mt-2 w-full text-center text-[10px] text-slate-400 hover:text-white py-1 rounded-lg hover:bg-slate-700/60 transition-colors"
            >
              Hoy
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}, (prev, next) => {
  return (
    prev.value === next.value &&
    prev.disabled === next.disabled &&
    prev.variant === next.variant
  )
})

export default FechaVencimientoField