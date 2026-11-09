'use client'

/**
 * RACKLY — PRE-INGRESO (pantalla tras el login).
 *
 * Capa NEUTRA entre la autenticación y los almacenes: aquí se elige el
 * almacén de trabajo. Los módulos nunca cruzan datos entre almacenes;
 * lo ÚNICO compartido es Usuarios (transversal, tarjeta aparte).
 *
 * Acceso por almacén (columnas profiles.acceso_* — migración 20261110b):
 *   · INSUMOS   → visible si acceso_insumos (default TRUE: nadie cambia hoy).
 *   · REPUESTOS → visible si acceso_repuestos (default FALSE: alta controlada
 *     por el admin en Usuarios) Y el permiso del cuadro repuestos.ver.
 *   · Admin: bypass anti-lockout — ve ambos almacenes siempre (misma
 *     filosofía que tiene_permiso: el admin no puede quedarse fuera).
 *   · Usuarios: tarjeta transversal con el MISMO gate que hoy (usuarios.ver).
 *
 * El componente solo ENRUTA: no carga datos de ningún módulo.
 */

import { useAuth } from '@/hooks/useAuth'
import { ROL_LABEL } from '@/lib/rackly/roles-label'
import { puede } from '@/lib/rackly/permisos'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Warehouse,
  Wrench,
  Users,
  ChevronRight,
  CalendarDays,
  ShieldAlert,
} from 'lucide-react'

export type AlmacenRuta = 'insumos' | 'repuestos'

type AlmacenDef = {
  ruta: AlmacenRuta
  nombre: string
  subtitulo: string
  descripcion: string
  icono: typeof Warehouse
  gradiente: string
  sombra: string
  etiqueta: string
  etiquetaClase: string
}

const ALMACENES: AlmacenDef[] = [
  {
    ruta: 'insumos',
    nombre: 'Almacén INSUMOS',
    subtitulo: 'Racks · Piso · Recepción · Atención · Tránsito',
    descripcion:
      'Kardex de insumos: racks, piso, recepción, atención a Línea (RQ), tránsito, descarga y FEFO.',
    icono: Warehouse,
    gradiente: 'from-violet-500 to-indigo-600',
    sombra: 'shadow-violet-500/25',
    etiqueta: 'Operativo',
    etiquetaClase: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    ruta: 'repuestos',
    nombre: 'Almacén REPUESTOS',
    subtitulo: 'Loncheras A/B · RAL BIG MAGIC',
    descripcion:
      'Catálogo, ubicaciones con loncheras A/B, recepción, atención RAL, tránsito y movimientos. Independiente de Insumos.',
    icono: Wrench,
    gradiente: 'from-cyan-500 to-blue-600',
    sombra: 'shadow-cyan-500/25',
    etiqueta: 'Nuevo',
    etiquetaClase: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  },
]

type Props = {
  /** Entra al almacén elegido (el hub despliega sus módulos). */
  onEntrarAlmacen: (ruta: AlmacenRuta) => void
  /** Abre el módulo transversal Usuarios. */
  onAbrirUsuarios: () => void
}

export function PreIngreso({ onEntrarAlmacen, onAbrirUsuarios }: Props) {
  const { perfil } = useAuth()

  const esAdmin = perfil?.rol === 'admin'
  // Acceso por almacén: columnas de la migración 20261110b + cuadro de permisos.
  // El admin pasa siempre (anti-lockout, igual que tiene_permiso).
  const visibleInsumos = esAdmin || perfil?.accesoInsumos !== false
  const visibleRepuestos =
    (esAdmin || perfil?.accesoRepuestos === true) && puede(perfil, 'repuestos.ver')
  const puedeUsuarios = puede(perfil, 'usuarios.ver')

  const almacenes = ALMACENES.filter((a) =>
    a.ruta === 'insumos' ? visibleInsumos : visibleRepuestos
  )

  const hoy = new Date().toLocaleDateString('es-PE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="space-y-6">
      {/* ── Bienvenida ── */}
      <div className="rounded-2xl border border-white/60 bg-white/80 backdrop-blur-sm shadow-md shadow-slate-200/50 p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-500/25">
              <span className="text-lg font-extrabold text-white">
                {(perfil?.nombre || 'U').trim().charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 leading-tight truncate">
                Bienvenido, {perfil?.nombre ?? 'Usuario'}
              </h2>
              <p className="text-sm text-slate-500">
                {ROL_LABEL[perfil?.rol ?? ''] ?? perfil?.rol ?? ''} · Selecciona el almacén de trabajo
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 sm:self-center">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <span className="capitalize">{hoy}</span>
          </div>
        </div>
      </div>

      {/* ── Almacenes autorizados ── */}
      {almacenes.length === 0 ? (
        <Card className="border border-amber-200 bg-amber-50/80">
          <CardContent className="p-6 flex items-start gap-3">
            <ShieldAlert className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-extrabold text-amber-900">Sin almacenes autorizados</p>
              <p className="text-sm text-amber-800 mt-1">
                Tu usuario no tiene acceso a ningún almacén todavía. Pide a un administrador que te
                autorice en el módulo Usuarios (campo «Almacenes autorizados»).
              </p>
              {esAdmin && (
                <p className="text-xs text-amber-700 mt-2">
                  (Eres admin: esto no debería ocurrir — revisa tu perfil en BD.)
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {almacenes.map((a) => (
            <Card
              key={a.ruta}
              className="group border border-white/60 bg-white/90 backdrop-blur-sm shadow-md shadow-slate-200/50 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200"
            >
              <CardContent className="p-6 flex flex-col h-full gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div
                    className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${a.gradiente} shadow-lg ${a.sombra}`}
                  >
                    <a.icono className="h-7 w-7 text-white" />
                  </div>
                  <Badge variant="outline" className={`${a.etiquetaClase} font-semibold`}>
                    {a.etiqueta}
                  </Badge>
                </div>

                <div className="flex-1 space-y-1.5">
                  <h3 className="text-lg font-extrabold text-slate-900 leading-tight">{a.nombre}</h3>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    {a.subtitulo}
                  </p>
                  <p className="text-sm text-slate-500 leading-snug">{a.descripcion}</p>
                </div>

                <Button
                  onClick={() => onEntrarAlmacen(a.ruta)}
                  className="w-full gap-2 font-semibold"
                  variant="outline"
                >
                  Entrar al almacén
                  <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Capa neutra (transversal) ── */}
      {puedeUsuarios && (
        <>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
            Transversal · todos los almacenes
          </p>
          <Card className="border border-white/60 bg-white/90 backdrop-blur-sm shadow-md shadow-slate-200/50 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200">
            <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-500 to-slate-700 shadow-lg shadow-slate-500/25">
                <Users className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-extrabold text-slate-900">Usuarios</h3>
                <p className="text-sm text-slate-500 leading-snug">
                  Gestión central de usuarios, roles, permisos y almacenes autorizados. No pertenece
                  a ningún almacén: vale para todo el sistema.
                </p>
              </div>
              <Button onClick={onAbrirUsuarios} variant="outline" className="gap-2 font-semibold shrink-0">
                Abrir
                <ChevronRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
