'use client'

/**
 * RACKLY — Diálogo de PERMISOS GRANULARES por usuario (módulo Usuarios).
 *
 * Permite al gestor (admin o quien tenga usuarios.gestionar_roles) marcar,
 * por cada usuario e INDEPENDIENTEMENTE de su cargo/rol, qué puede y qué no
 * puede hacer dentro de la app:
 *
 *   · Checkbox marcado   → el usuario PUEDE (por rol o por excepción).
 *   · Checkbox desmarcado → el usuario NO PUEDE (por rol o por revoca).
 *
 * Solo se guardan EXCEPCIONES (overrides) en BD (tabla user_permisos vía la
 * RPC establecer_permiso_usuario): volver el checkbox al valor natural del rol
 * BORRA la excepción. Badge "Rol" = valor por defecto del cargo · Badge
 * "Personalizado" = excepción guardada.
 *
 * Los ADMIN no admiten excepciones (ya lo tienen todo — la RPC lo bloquea).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  establecerPermisoUsuario,
  type Perfil,
} from '@/lib/rackly/auth'
import {
  PERMISOS,
  rolConcedePermiso,
  type GrupoPermiso,
  type Permiso,
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
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  HeartHandshake,
  Info,
  BookOpen,
  Layers3,
  Loader2,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Warehouse,
} from 'lucide-react'
import { mensajeError } from '@/lib/rackly/errores'

const GRUPO_ORDEN: { grupo: GrupoPermiso; etiqueta: string; Icono: typeof Warehouse }[] = [
  { grupo: 'racks', etiqueta: 'Racks (Kardex)', Icono: Warehouse },
  { grupo: 'piso', etiqueta: 'Piso', Icono: Layers3 },
  { grupo: 'recepcion', etiqueta: 'Recepción', Icono: PackageCheck },
  { grupo: 'atencion', etiqueta: 'Atención', Icono: HeartHandshake },
  { grupo: 'catalogo', etiqueta: 'Catálogo', Icono: BookOpen },
  { grupo: 'usuarios', etiqueta: 'Usuarios', Icono: Users },
  { grupo: 'otros', etiqueta: 'Otros', Icono: Sparkles },
]

const COLOR_GRUPO: Record<string, string> = {
  racks: 'bg-violet-100 text-violet-700',
  piso: 'bg-sky-100 text-sky-700',
  recepcion: 'bg-amber-100 text-amber-700',
  atencion: 'bg-teal-100 text-teal-700',
  catalogo: 'bg-indigo-100 text-indigo-700',
  usuarios: 'bg-slate-200 text-slate-700',
  otros: 'bg-emerald-100 text-emerald-700',
}

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

  const grupos = useMemo(() => {
    return GRUPO_ORDEN.map(({ grupo, etiqueta, Icono }) => ({
      grupo,
      etiqueta,
      Icono,
      permisos: PERMISOS.filter((p) => p.grupo === grupo),
    })).filter((g) => g.permisos.length > 0)
  }, [])

  function efectivo(permiso: Permiso): boolean {
    const o = overrides[permiso]
    if (typeof o === 'boolean') return o
    return rolConcedePermiso(perfil?.rol, permiso)
  }

  async function toggle(permiso: Permiso) {
    if (!perfil || busy || esAdmin) return
    const nuevo = !efectivo(permiso)
    const vuelveAlRol = nuevo === rolConcedePermiso(perfil.rol, permiso)
    setBusy(permiso)
    try {
      await establecerPermisoUsuario(perfil.id, permiso, vuelveAlRol ? null : nuevo)
      setOverrides((prev) => {
        const copia = { ...prev }
        if (vuelveAlRol) delete copia[permiso]
        else copia[permiso] = nuevo
        return copia
      })
      toast.success(nuevo ? 'Permiso concedido' : 'Permiso restringido', {
        description: `${perfil.nombre}: ${permiso}${vuelveAlRol ? ' (de vuelta al valor del rol)' : ''}`,
      })
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

  const totalExcepciones = Object.keys(overrides).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-slate-600" />
            Permisos de {perfil?.nombre ?? '—'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {perfil?.correo}
            {perfil && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {ROL_LABEL[perfil.rol] ?? perfil.rol}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        {esAdmin ? (
          <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              Los <strong>administradores</strong> ya tienen todos los permisos del
              sistema y no admiten excepciones. Para personalizar, asigna primero
              otro rol a este usuario.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                Marca lo que <strong>puede hacer</strong> este usuario aunque su cargo
                no lo permita, o desmarca lo que <strong>no debe hacer</strong> aunque
                su cargo lo permita. Solo se guardan las excepciones al rol.
              </p>
            </div>

            <ScrollArea className="flex-1 min-h-0 -mx-1 px-1">
              <div className="space-y-3 pb-1">
                {grupos.map(({ grupo, etiqueta, Icono, permisos }) => (
                  <div key={grupo} className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="flex items-center gap-2 bg-slate-50 px-3 py-2">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-md ${COLOR_GRUPO[grupo] ?? 'bg-slate-100 text-slate-600'}`}>
                        <Icono className="h-3.5 w-3.5" />
                      </span>
                      <p className="text-xs font-bold text-slate-700">{etiqueta}</p>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {permisos.map((p) => {
                        const valor = efectivo(p.codigo)
                        const personalizado = typeof overrides[p.codigo] === 'boolean'
                        return (
                          <label
                            key={p.codigo}
                            className="flex items-start gap-3 px-3 py-2.5 hover:bg-slate-50 cursor-pointer select-none"
                          >
                            <Checkbox
                              checked={valor}
                              disabled={busy !== null || resetBusy}
                              onCheckedChange={() => toggle(p.codigo)}
                              className="mt-0.5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-semibold text-slate-800">{p.etiqueta}</span>
                                {personalizado ? (
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-300 bg-amber-50 text-amber-700">
                                    Personalizado
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 border-slate-200 bg-white text-slate-400">
                                    Rol
                                  </Badge>
                                )}
                                {busy === p.codigo && (
                                  <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                                )}
                              </span>
                              <span className="block text-[11px] leading-snug text-slate-500 mt-0.5">
                                {p.descripcion}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <Separator className="my-1" />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-400">
                {totalExcepciones === 0
                  ? 'Sin excepciones: usa los valores de su rol.'
                  : `${totalExcepciones} excepción${totalExcepciones === 1 ? '' : 'es'} guardada${totalExcepciones === 1 ? '' : 's'}.`}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={restablecerTodo}
                disabled={resetBusy || busy !== null || totalExcepciones === 0}
                className="gap-1.5"
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
