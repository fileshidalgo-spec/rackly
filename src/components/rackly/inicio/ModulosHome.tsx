'use client'

/**
 * RACKLY — Pantalla de ingreso de módulos (home tras el login).
 *
 * Muestra las 5 puertas de entrada del sistema:
 *   Racks · Piso · Usuarios · Recepción · Atención
 *
 * Cada tarjeta navega a su módulo de forma independiente: este componente
 * no carga datos de ningún módulo, solo enruta (aislamiento total).
 */

import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Warehouse,
  Layers3,
  Users,
  PackageCheck,
  HeartHandshake,
  ChevronRight,
  CalendarDays,
} from 'lucide-react'

export type VistaModulo = 'racks' | 'piso' | 'usuarios' | 'recepcion' | 'atencion'

type ModuloDef = {
  vista: VistaModulo
  nombre: string
  descripcion: string
  icono: typeof Warehouse
  gradiente: string
  sombra: string
  etiqueta: string
  etiquetaClase: string
}

const MODULOS: ModuloDef[] = [
  {
    vista: 'racks',
    nombre: 'Racks',
    descripcion:
      'Kardex de racks: movimientos, traslados, catálogo, stock, INC, ocupación, descarga y FEFO.',
    icono: Warehouse,
    gradiente: 'from-violet-500 to-indigo-600',
    sombra: 'shadow-violet-500/25',
    etiqueta: 'Operativo',
    etiquetaClase: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    vista: 'piso',
    nombre: 'Piso',
    descripcion:
      'Kardex de piso: sectores, movimientos por bloque, stock con FEFO y Stock Big Magic.',
    icono: Layers3,
    gradiente: 'from-sky-500 to-blue-600',
    sombra: 'shadow-sky-500/25',
    etiqueta: 'Operativo',
    etiquetaClase: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    vista: 'usuarios',
    nombre: 'Usuarios',
    descripcion:
      'Gestión central de usuarios, roles y accesos, con la actividad de cada usuario en todos los módulos.',
    icono: Users,
    gradiente: 'from-slate-500 to-slate-700',
    sombra: 'shadow-slate-500/25',
    etiqueta: 'Transversal',
    etiquetaClase: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  {
    vista: 'recepcion',
    nombre: 'Recepción',
    descripcion:
      'Registro de recepción de mercadería y documentos: guías, órdenes de compra y estados de ingreso.',
    icono: PackageCheck,
    gradiente: 'from-amber-500 to-orange-600',
    sombra: 'shadow-amber-500/25',
    etiqueta: 'Nuevo',
    etiquetaClase: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  {
    vista: 'atencion',
    nombre: 'Atención',
    descripcion:
      'Tickets de atención y soporte interno: solicitudes por área, seguimiento de estados y cierre.',
    icono: HeartHandshake,
    gradiente: 'from-teal-500 to-cyan-600',
    sombra: 'shadow-teal-500/25',
    etiqueta: 'Nuevo',
    etiquetaClase: 'bg-teal-50 text-teal-700 border-teal-200',
  },
]

const ROL_LABEL: Record<string, string> = {
  admin: 'Administrador',
  operario: 'Operario',
  auxiliar: 'Auxiliar',
  almacenero: 'Almacenero',
  supervisor_almacen: 'Supervisor de Almacén',
  supervisor_operaciones: 'Supervisor de Operaciones',
  coordinador_operaciones: 'Coordinador de Operaciones',
}

export function ModulosHome({ onEntrar }: { onEntrar: (vista: VistaModulo) => void }) {
  const { perfil } = useAuth()

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
                {ROL_LABEL[perfil?.rol ?? ''] ?? perfil?.rol ?? ''} · Selecciona un módulo para
                comenzar
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 sm:self-center">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <span className="capitalize">{hoy}</span>
          </div>
        </div>
      </div>

      {/* ── Grid de módulos (exactamente las 5 puertas de entrada) ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MODULOS.map((m) => (
          <Card
            key={m.vista}
            className="group border border-white/60 bg-white/90 backdrop-blur-sm shadow-md shadow-slate-200/50 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200"
          >
            <CardContent className="p-5 flex flex-col h-full gap-4">
              <div className="flex items-start justify-between gap-3">
                <div
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${m.gradiente} shadow-lg ${m.sombra}`}
                >
                  <m.icono className="h-6 w-6 text-white" />
                </div>
                <Badge variant="outline" className={`${m.etiquetaClase} font-semibold`}>
                  {m.etiqueta}
                </Badge>
              </div>

              <div className="flex-1 space-y-1.5">
                <h3 className="text-base font-extrabold text-slate-900 leading-tight">{m.nombre}</h3>
                <p className="text-sm text-slate-500 leading-snug">{m.descripcion}</p>
              </div>

              <Button
                onClick={() => onEntrar(m.vista)}
                className="w-full gap-2 font-semibold"
                variant="outline"
              >
                Entrar al módulo
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
