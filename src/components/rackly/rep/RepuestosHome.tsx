'use client'

/**
 * RACKLY · ALMACÉN REPUESTOS — Pantalla de módulos del almacén.
 *
 * Las 6 puertas del almacén (mismo patrón que ModulosHome de Insumos):
 *   Catálogo · Ubicaciones · Recepción · Atención · Tránsito · Movimientos
 *
 * Aislamiento: este componente NO carga datos de ningún módulo, solo enruta.
 * Incremento 2 (Atención + Tránsito) llega deshabilitado con etiqueta
 * honesta — la puerta existe, el módulo se construye en la siguiente ola.
 */

import { useAuth } from '@/hooks/useAuth'
import { puede } from '@/lib/rackly/permisos'
import type { RepVista } from '@/lib/rackly/rep/rep-vistas'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  BookOpen,
  LayoutGrid,
  PackageCheck,
  HeartHandshake,
  Truck,
  History,
  ArrowLeft,
  ChevronRight,
  Wrench,
} from 'lucide-react'

type PuertaDef = {
  vista: RepVista
  nombre: string
  descripcion: string
  icono: typeof BookOpen
  gradiente: string
  sombra: string
  /** Incremento 2: puerta visible pero todavía no construida. */
  proximo?: boolean
}

const PUERTAS: PuertaDef[] = [
  {
    vista: 'catalogo',
    nombre: 'Catálogo',
    descripcion:
      'Artículos del almacén (código BIG MAGIC): búsqueda, edición y carga masiva Excel de 4 columnas.',
    icono: BookOpen,
    gradiente: 'from-amber-500 to-orange-600',
    sombra: 'shadow-amber-500/25',
  },
  {
    vista: 'ubicaciones',
    nombre: 'Ubicaciones',
    descripcion:
      'Mapa físico: pisos, niveles, posiciones con loncheras A/B, pasillos, zonas y pre-picking.',
    icono: LayoutGrid,
    gradiente: 'from-violet-500 to-purple-600',
    sombra: 'shadow-violet-500/25',
  },
  {
    vista: 'recepcion',
    nombre: 'Recepción',
    descripcion:
      'Ingreso de mercadería a lonchera con validación de capacidad (15 artículos) y kardex automático.',
    icono: PackageCheck,
    gradiente: 'from-emerald-500 to-green-600',
    sombra: 'shadow-emerald-500/25',
  },
  {
    vista: 'atencion',
    nombre: 'Atención',
    descripcion:
      'Registro del RAL (número BIG MAGIC) y picking de artículos hacia pre-picking para la salida.',
    icono: HeartHandshake,
    gradiente: 'from-teal-500 to-cyan-600',
    sombra: 'shadow-teal-500/25',
    proximo: true,
  },
  {
    vista: 'transito',
    nombre: 'Tránsito',
    descripcion:
      'Estacionamiento de la carga del día: despacho al día siguiente o devolución a lonchera.',
    icono: Truck,
    gradiente: 'from-fuchsia-500 to-purple-600',
    sombra: 'shadow-fuchsia-500/25',
    proximo: true,
  },
  {
    vista: 'movimientos',
    nombre: 'Movimientos',
    descripcion:
      'Kardex del almacén: ingresos, salidas, devoluciones, traslados y ajustes con usuario y referencia.',
    icono: History,
    gradiente: 'from-sky-500 to-blue-600',
    sombra: 'shadow-sky-500/25',
  },
]

type Props = {
  onEntrar: (vista: RepVista) => void
  /** Volver al pre-ingreso (cambiar de almacén). */
  onVolver: () => void
}

export function RepuestosHome({ onEntrar, onVolver }: Props) {
  const { perfil } = useAuth()

  // Gate de entrada (el hub ya lo valida; defensa en profundidad):
  // sin repuestos.ver no hay puertas — mensaje honesto.
  if (!puede(perfil, 'repuestos.ver')) {
    return (
      <Card className="border border-amber-200 bg-amber-50/80">
        <CardContent className="p-6 flex items-start gap-3">
          <Wrench className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-extrabold text-amber-900">Sin acceso al almacén Repuestos</p>
            <p className="text-sm text-amber-800 mt-1">
              No tienes el permiso «Ver Repuestos». Pide a un administrador que te lo conceda en el
              módulo Usuarios.
            </p>
            <Button onClick={onVolver} variant="outline" className="mt-3 gap-2">
              <ArrowLeft className="h-4 w-4" />
              Volver al inicio
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Button onClick={onVolver} variant="ghost" className="gap-2 text-slate-600 font-semibold">
        <ArrowLeft className="h-4 w-4" />
        Cambiar de almacén
      </Button>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PUERTAS.map((p) => (
          <Card
            key={p.vista}
            className={`group border border-white/60 bg-white/90 backdrop-blur-sm shadow-md shadow-slate-200/50 transition-all duration-200 ${
              p.proximo ? 'opacity-70' : 'hover:shadow-xl hover:-translate-y-0.5'
            }`}
          >
            <CardContent className="p-5 flex flex-col h-full gap-4">
              <div className="flex items-start justify-between gap-3">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${p.gradiente} shadow-lg ${p.sombra}`}
                >
                  <p.icono className="h-6 w-6 text-white" />
                </div>
                {p.proximo ? (
                  <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 font-semibold">
                    Inc. 2
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                    Listo
                  </Badge>
                )}
              </div>

              <div className="flex-1 space-y-1.5">
                <h3 className="text-base font-extrabold text-slate-900 leading-tight">{p.nombre}</h3>
                <p className="text-sm text-slate-500 leading-snug">{p.descripcion}</p>
              </div>

              {p.proximo ? (
                <Button disabled variant="outline" className="w-full font-semibold">
                  Disponible próximamente
                </Button>
              ) : (
                <Button
                  onClick={() => onEntrar(p.vista)}
                  className="w-full gap-2 font-semibold"
                  variant="outline"
                >
                  Entrar al módulo
                  <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
