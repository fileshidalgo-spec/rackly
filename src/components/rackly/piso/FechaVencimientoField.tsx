'use client'

import { useState, useEffect, useRef, memo } from 'react'
import { Calendar, CalendarOff } from 'lucide-react'

/**
 * FechaVencimientoField — Componente independiente para selección de fecha de vencimiento.
 *
 * CRÍTICO: Este componente está FUERA de PisoSectoresTab para evitar re-renders
 * causados por el polling de usePisoRealtime. Tiene su propio estado interno
 * para el valor de la fecha, lo que significa que los re-renders del padre
 * NO afectan el input de fecha mientras el usuario está interactuando con él.
 *
 * Solo se comunica con el padre cuando el usuario cambia el valor.
 */

interface FechaVencimientoFieldProps {
  /** Valor inicial de la fecha (se sincroniza SOLO si el usuario NO está interactuando) */
  value: string
  /** Si el campo está deshabilitado (sin vencimiento) */
  disabled: boolean
  /** 'ing' para ingreso (verde), 'dev' para devolución (ámbar) */
  variant: 'ing' | 'dev' | 'inc'
  /** Callback cuando cambia la fecha */
  onChange: (value: string) => void
  /** Callback cuando se togglea "sin vencimiento" */
  onToggleSin: () => void
}

const FechaVencimientoField = memo(function FechaVencimientoField({
  value,
  disabled,
  variant,
  onChange,
  onToggleSin,
}: FechaVencimientoFieldProps) {
  // Estado interno — este es el valor REAL del input
  const [localValue, setLocalValue] = useState(value)

  // Ref para saber si el usuario está activamente interactuando con el input
  const isInteractingRef = useRef(false)

  // Sincronizar con el valor del padre SOLO si el usuario NO está interactuando
  useEffect(() => {
    if (!isInteractingRef.current) {
      setLocalValue(value)
    }
  }, [value])

  const handleFocus = () => {
    isInteractingRef.current = true
  }

  const handleBlur = () => {
    // Pequeño delay para permitir que el date picker cierre y capture el valor
    setTimeout(() => {
      isInteractingRef.current = false
    }, 300)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setLocalValue(newValue)
    onChange(newValue)
  }

  const isInc = variant === 'inc'

  const colors = {
    ing: {
      border: 'border-emerald-500/50',
      focus: 'focus:ring-emerald-500/50',
      disabledBorder: 'border-slate-700',
      disabledBg: 'bg-slate-800/50',
      disabledText: 'text-slate-600',
      activeBg: 'bg-slate-900',
    },
    dev: {
      border: 'border-amber-500/50',
      focus: 'focus:ring-amber-500/50',
      disabledBorder: 'border-slate-700',
      disabledBg: 'bg-slate-800/50',
      disabledText: 'text-slate-600',
      activeBg: 'bg-slate-900',
    },
    inc: {
      border: 'border-purple-500/50',
      focus: 'focus:ring-purple-500/50',
      disabledBorder: 'border-slate-700',
      disabledBg: 'bg-slate-800/50',
      disabledText: 'text-slate-600',
      activeBg: 'bg-slate-900',
    },
  }

  const c = colors[variant]

  return (
    <div className="col-span-12 sm:col-span-6 flex items-end gap-2">
      <div className="flex-1">
        <label className="text-[10px] text-slate-400 font-medium">Fecha de Vencimiento</label>
        <div className="relative">
          <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
          <input
            type="date"
            value={localValue}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            disabled={disabled}
            className={[
              'w-full h-9 rounded-xl border text-xs pl-8 pr-2 font-mono text-white focus:outline-none focus:ring-2 transition-colors [color-scheme:dark]',
              disabled
                ? `${c.disabledBorder} ${c.disabledBg} ${c.disabledText} cursor-not-allowed`
                : `${c.border} ${c.activeBg} ${c.focus}`,
            ].join(' ')}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleSin}
        className={[
          'flex items-center gap-1 px-2.5 h-9 rounded-xl text-[10px] font-semibold border transition-colors whitespace-nowrap',
          disabled
            ? variant === 'ing'
              ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-400 shadow-inner'
              : variant === 'dev'
                ? 'bg-amber-600/20 border-amber-500/40 text-amber-400 shadow-inner'
                : 'bg-purple-500/20 border-purple-500/40 text-purple-300 shadow-inner'
            : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-400',
        ].join(' ')}
      >
        <CalendarOff className="h-3 w-3" />
        Sin vencimiento
      </button>
    </div>
  )
}, (prev, next) => {
  // Custom comparator: solo re-render si cambian estas props primitivas
  return (
    prev.value === next.value &&
    prev.disabled === next.disabled &&
    prev.variant === next.variant
  )
})

export default FechaVencimientoField