'use client'

/**
 * RACKLY — CUADRO DE PERMISOS PERSONALIZADOS por usuario (módulo Usuarios).
 *
 * Matriz Módulo × Acción (Ver/Crear/Editar/Eliminar/Aprobar), como el modelo
 * del usuario. Tres estados visuales por celda:
 *
 *   · ✓ verde            → permitido (por defecto del rol).
 *   · ✗ rojo             → restringido (por defecto del rol).
 *   · ✓/✗ con borde azul → EXCEPCIÓN personalizada (override guardado en BD).
 *
 * Un clic alterna permitido ↔ restringido. Solo se guardan en BD las
 * EXCEPCIONES al rol (tabla user_permisos vía la RPC
 * establecer_permiso_usuario): volver la celda al valor natural del rol BORRA
 * la excepción. La BD aplica la MISMA regla (políticas AS RESTRICTIVE + guards
 * en las RPCs SECURITY DEFINER): marcar ✗ bloquea de verdad, no solo oculta.
 *
 * Los ADMIN no admiten excepciones (ya lo tienen todo — la RPC lo bloquea).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  establecerPermisoUsuario,
  type Perfil,
} from '@/lib/rackly/auth'
import {
  COLUMNAS_MATRIZ,
  MATRIZ,
  rolConcedePermiso,
  type AccionPermiso,
} from '@/lib/rackly/permisos'
import { ROL_LABEL } from '@/lib/rackly/roles-label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  BookOpen,
  Check,
  HeartHandshake,
  Info,
  Layers3,
  Loader2,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Truck,
  Upload,
  Users,
  Warehouse,
  X,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

const ICONOS_FILA = {
  warehouse: Warehouse,
  book: BookOpen,
  upload: Upload,
  layers: Layers3,
  package: PackageCheck,
  heart: HeartHandshake,
  truck: Truck,
  users: Users,
} as const

type Props = {
  perfil: Perfil | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Refresca la lista del padre tras cada cambio guardado */
  onChanged?: () => void
}

export function DialogoPermisos({ perfil, open, onOpenChange, onChanged }: Props) {
  // Overrides locales (solo excepciones): { [permiso]: concedido }
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [resetBusy, setResetBusy] = useState(false)

  // Al abrir/cambiar usuario: arranca desde los overrides cargados en la lista
  useEffect(() => {
    if (open) {
      setOverrides(perfil?.permisosExtra ? { ...perfil.permisosExtra } : {})
      setBusy(null)
      setResetBusy(false)
    }
  }, [open, perfil])

  const esAdmin = perfil?.rol === 'admin'

  function efectivo(codigo: string): boolean {
    const o = overrides[codigo]
    if (typeof o === 'boolean') return o
    return rolConcedePermiso(perfil?.rol, codigo)
  }

  async function toggle(codigo: string) {
    if (!perfil || busy || esAdmin) return
    const nuevo = !efectivo(codigo)
    const vuelveAlRol = nuevo === rolConcedePermiso(perfil.rol, codigo)
    setBusy(codigo)
    try {
      await establecerPermisoUsuario(perfil.id, codigo, vuelveAlRol ? null : nuevo)
      setOverrides((prev) => {
        const copia = { ...prev }
        if (vuelveAlRol) delete copia[codigo]
        else copia[codigo] = nuevo
        return copia
      })
      if (vuelveAlRol) {
        toast.info('Excepción quitada', {
          description: `${perfil.nombre} vuelve al valor de su rol para este permiso.`,
        })
      } else {
        toast.success(nuevo ? 'Permiso concedido' : 'Permiso restringido', {
          description: `${perfil.nombre}: la app y la base de datos aplican el cambio de inmediato.`,
        })
      }
      onChanged?.()
    } catch (err: unknown) {
      toast.error('No se pudo guardar el permiso', { description: mensajeError(err) })
    } finally {
      setBusy(null)
    }
  }

  async function restablecerTodo() {
    if (!perfil || resetBusy || esAdmin) return
    const permisosConOverride = Object.keys(overrides)
    if (permisosConOverride.length === 0) {
      toast.info('Este usuario no tiene excepciones: ya usa los valores de su rol.')
      return
    }
    setResetBusy(true)
    try {
      const resultados = await Promise.allSettled(
        permisosConOverride.map((p) => establecerPermisoUsuario(perfil.id, p, null))
      )
      const fallidos = resultados.filter((r) => r.status === 'rejected')
      if (fallidos.length > 0) {
        toast.warning('Algunas excepciones no se pudieron quitar', {
          description: `${permisosConOverride.length - fallidos.length} de ${permisosConOverride.length} restablecidas.`,
        })
      } else {
        toast.success('Excepciones restablecidas', {
          description: `${perfil.nombre} vuelve a los valores de su rol (${ROL_LABEL[perfil.rol] ?? perfil.rol}).`,
        })
      }
      setOverrides({})
      onChanged?.()
    } finally {
      setResetBusy(false)
    }
  }

  const totalExcepciones = useMemo(() => Object.keys(overrides).length, [overrides])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-xl md:max-w-2xl max-h-[90vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 sm:px-5 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-slate-600 shrink-0" />
            <span className="min-w-0 truncate">
              Permisos personalizados{perfil?.nombre ? `: ${perfil.nombre}` : ''}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate">{perfil?.correo}</span>
            {perfil && (
              <Badge variant="secondary" className="text-[10px]">
                {ROL_LABEL[perfil.rol] ?? perfil.rol}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 ${
                totalExcepciones > 0
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-400'
              }`}
            >
              {totalExcepciones === 0
                ? 'Sin excepciones: usa su rol'
                : `${totalExcepciones} excepción${totalExcepciones === 1 ? '' : 'es'} personalizada${totalExcepciones === 1 ? '' : 's'}`}
            </Badge>
          </DialogDescription>
        </DialogHeader>

        {esAdmin ? (
          <div className="px-4 sm:px-5 pb-5">
            <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                Los <strong>administradores</strong> ya tienen todos los permisos del
                sistema y no admiten excepciones. Para personalizar, asigna primero
                otro rol a este usuario.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Leyenda (como el modelo) */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 sm:px-5 pb-2 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-emerald-300 bg-emerald-50 text-emerald-600">
                  <Check className="h-3 w-3" />
                </span>
                Permitido
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-rose-200 bg-rose-50 text-rose-500">
                  <X className="h-3 w-3" />
                </span>
                Restringido
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded border-2 border-blue-500 bg-blue-50 text-blue-600">
                  <Check className="h-3 w-3" />
                </span>
                Excepción personalizada
              </span>
            </div>

            {/* CUADRO: matriz módulo × acción (scroll horizontal en móvil,
                columna de módulo pegajosa; el pie NUNCA se superpone) */}
            <div className="min-h-0 flex-1 overflow-auto border-y border-slate-200">
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 shadow-[0_1px_0_0_rgb(226_232_240)]">
                  <tr>
                    <th className="sticky left-0 z-20 bg-slate-50 px-3 py-2 text-left text-xs font-bold text-slate-600 min-w-[150px]">
                      Módulo
                    </th>
                    {COLUMNAS_MATRIZ.map(({ accion, etiqueta }) => (
                      <th
                        key={accion}
                        className="px-2 py-2 text-center text-xs font-bold text-slate-600 w-[84px]"
                      >
                        {etiqueta}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {MATRIZ.map((fila) => {
                    const Icono = ICONOS_FILA[fila.icono]
                    return (
                      <tr key={fila.modulo} className="hover:bg-slate-50/60">
                        <td className="sticky left-0 z-10 bg-white px-3 py-2 group-hover:bg-slate-50/60">
                          <span className="flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
                              <Icono className="h-3.5 w-3.5" />
                            </span>
                            <span className="text-xs font-semibold text-slate-700 leading-tight">
                              {fila.etiqueta}
                            </span>
                          </span>
                        </td>
                        {COLUMNAS_MATRIZ.map(({ accion }) => {
                          const codigo = fila.celdas[accion as AccionPermiso]
                          if (!codigo) {
                            return (
                              <td key={accion} className="px-2 py-2 text-center">
                                <span className="text-slate-300 select-none">—</span>
                              </td>
                            )
                          }
                          const valor = efectivo(codigo)
                          const personalizado = typeof overrides[codigo] === 'boolean'
                          const ocupado = busy === codigo || resetBusy
                          return (
                            <td key={accion} className="px-2 py-2 text-center">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={valor}
                                aria-label={`${fila.etiqueta} — ${accion}: ${valor ? 'permitido' : 'restringido'}${personalizado ? ' (excepción personalizada)' : ''}`}
                                title={
                                  (valor ? 'Permitido' : 'Restringido') +
                                  (personalizado ? ' · excepción personalizada (clic para quitar)' : ' · valor del rol (clic para cambiar)')
                                }
                                disabled={ocupado}
                                onClick={() => toggle(codigo)}
                                className={`mx-auto inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait ${
                                  valor
                                    ? 'border-emerald-300 bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                    : 'border-rose-200 bg-rose-50 text-rose-500 hover:bg-rose-100'
                                } ${personalizado ? 'ring-2 ring-blue-500 border-blue-500' : ''}`}
                              >
                                {busy === codigo ? (
                                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                                ) : valor ? (
                                  <Check className="h-4 w-4" />
                                ) : (
                                  <X className="h-4 w-4" />
                                )}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pie FIJO en el flujo (nunca tapa el cuadro) */}
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3">
              <p className="text-[11px] text-slate-400 min-w-0 truncate">
                Toca una casilla para alternar permitido/restringido. Los cambios
                aplican al instante en la app y en la base de datos.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={restablecerTodo}
                disabled={resetBusy || busy !== null || totalExcepciones === 0}
                className="gap-1.5 shrink-0"
              >
                {resetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Restablecer rol
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
