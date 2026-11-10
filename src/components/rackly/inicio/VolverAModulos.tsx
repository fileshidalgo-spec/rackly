'use client'

/**
 * RACKLY — Botón «Atrás» transversal de los módulos.
 *
 * Retrocede UN nivel en la jerarquía de navegación:
 *
 *   Pre-ingreso (elegir almacén)
 *     └─ Selección de módulos (ModulosHome / RepuestosHome)
 *          └─ Módulo  ← AQUÍ vive este botón
 *
 *   Módulo —«Volver a módulos»→ Selección de módulos del almacén activo,
 *   SIN salir al pre-ingreso (el almacén se conserva: re-entrar a otro
 *   módulo cuesta un toque, no volver a elegir almacén).
 *
 * Caso especial: módulo transversal abierto SIN almacén activo (p. ej.
 * Usuarios desde el pre-ingreso) → retrocede al pre-ingreso y el botón
 * dice «Volver» a secas.
 *
 * El DESTINO lo decide page.tsx (handler `volverAModulos`); este componente
 * solo pinta el botón — misma separación de responsabilidades que el resto
 * de la capa de navegación (ModulosHome, PreIngreso).
 */

import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  /** Subir un nivel (lo decide el hub: selección de módulos o pre-ingreso). */
  onVolver: () => void
  /** ¿Hay almacén activo? true → «Volver a módulos»; false → «Volver». */
  conAlmacen?: boolean
  className?: string
}

export function VolverAModulos({ onVolver, conAlmacen = true, className }: Props) {
  return (
    <Button
      onClick={onVolver}
      variant="ghost"
      size="sm"
      className={`-ml-2 gap-1.5 justify-self-start font-semibold text-slate-500 hover:text-slate-900 ${className ?? ''}`}
    >
      <ArrowLeft className="h-4 w-4" />
      {conAlmacen ? 'Volver a módulos' : 'Volver'}
    </Button>
  )
}
