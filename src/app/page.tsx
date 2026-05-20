'use client'

import { useState, useEffect } from 'react'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { AuthGate } from '@/components/rackly/auth/AuthGate'
import { SesionBar } from '@/components/rackly/kardex/SesionBar'
import { MovimientoForm } from '@/components/rackly/kardex/MovimientoForm'
import { StockTab } from '@/components/rackly/kardex/StockTab'
import { CatalogoTab } from '@/components/rackly/kardex/CatalogoTab'
import { UsuariosTab } from '@/components/rackly/kardex/UsuariosTab'
import { DescargaTab } from '@/components/rackly/kardex/DescargaTab'
import { FefoTab } from '@/components/rackly/kardex/FefoTab'
import { OcupacionTab } from '@/components/rackly/kardex/OcupacionTab'
import { TrasladoTab } from '@/components/rackly/kardex/TrasladoTab'
import { SectoresTab } from '@/components/rackly/piso/SectoresTab'
import { MovimientosTab } from '@/components/rackly/piso/MovimientosTab'
import { ConfiguracionColumnasTab } from '@/components/rackly/piso/ConfiguracionColumnasTab'
import { UpKardexTab } from '@/components/rackly/piso/UpKardexTab'
import { deleteMovimiento, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Download,
  PackageSearch,
  Trash2,
  LayoutGrid,
  Users,
  Warehouse,
  Layers3,
  History,
  Settings,
  Upload,
} from 'lucide-react'

function fmtCantidad(n: number) {
  return Number.isInteger(n)
    ? n.toString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString()
}

function RacklyApp() {
  const { perfil } = useAuth()
  const [view, setView] = useState<'racks' | 'piso'>('racks')
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [expandMovs, setExpandMovs] = useState(false)

  useMovimientosRealtime(setMovs)

  const esAdmin = perfil?.rol === 'admin'

  async function handleDelete(id: string) {
    if (!esAdmin) {
      toast.error('Solo el administrador puede eliminar movimientos.')
      return
    }
    try {
      const next = await deleteMovimiento(id)
      setMovs(next)
      toast.success('Movimiento eliminado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      toast.error('No se pudo eliminar', { description: message })
    }
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-7xl flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                R
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight leading-none">RACKLY</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">
                  Gestión de Almacenes
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 ml-4">
              <Button
                variant={view === 'racks' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setView('racks')}
                className="gap-1"
              >
                <Warehouse className="h-4 w-4" />
                <span className="hidden sm:inline">Kardex Racks</span>
              </Button>
              <Button
                variant={view === 'piso' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setView('piso')}
                className="gap-1"
              >
                <Layers3 className="h-4 w-4" />
                <span className="hidden sm:inline">Kardex Piso</span>
              </Button>
            </div>
          </div>
          <SesionBar />
        </div>
      </header>

      <div className="mx-auto max-w-7xl p-4 md:p-6">
        {/* KARDEX RACKS VIEW */}
        {view === 'racks' && (
          <Tabs defaultValue="movimientos" className="w-full">
            <TabsList className="grid w-full grid-cols-2 gap-2 h-auto p-2 md:w-auto md:grid-cols-8 md:gap-1 md:h-9 md:p-1">
              <TabsTrigger value="movimientos" className="gap-2 py-2 md:py-1">
                <Warehouse className="h-4 w-4" />
                <span className="hidden md:inline">Movimientos</span>
              </TabsTrigger>
              <TabsTrigger value="traslado" className="gap-2 py-2 md:py-1">
                <ArrowRightLeft className="h-4 w-4" />
                <span className="hidden md:inline">Traslado</span>
              </TabsTrigger>
              <TabsTrigger value="kardex" className="gap-2 py-2 md:py-1">
                <BookOpen className="h-4 w-4" />
                <span className="hidden md:inline">Catálogo</span>
              </TabsTrigger>
              <TabsTrigger value="stock" className="gap-2 py-2 md:py-1">
                <PackageSearch className="h-4 w-4" />
                <span className="hidden md:inline">Stock</span>
              </TabsTrigger>
              <TabsTrigger value="ocupacion" className="gap-2 py-2 md:py-1">
                <LayoutGrid className="h-4 w-4" />
                <span className="hidden md:inline">Ocupación</span>
              </TabsTrigger>
              <TabsTrigger value="descarga" className="gap-2 py-2 md:py-1">
                <Download className="h-4 w-4" />
                <span className="hidden md:inline">Descarga</span>
              </TabsTrigger>
              <TabsTrigger value="fefo" className="gap-2 py-2 md:py-1">
                <CalendarClock className="h-4 w-4" />
                <span className="hidden md:inline">FEFO</span>
              </TabsTrigger>
              <TabsTrigger value="usuarios" className="gap-2 py-2 md:py-1">
                <Users className="h-4 w-4" />
                <span className="hidden md:inline">Usuarios</span>
              </TabsTrigger>
            </TabsList>

            {/* MOVIMIENTOS */}
            <TabsContent value="movimientos" className="mt-6 md:mt-4 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Registrar movimiento</CardTitle>
                  <CardDescription>
                    Selecciona el tipo de movimiento a registrar.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="ingreso" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 md:w-auto">
                      <TabsTrigger value="ingreso" className="gap-2">
                        <ArrowDownToLine className="h-4 w-4" /> Ingreso
                      </TabsTrigger>
                      <TabsTrigger value="salida" className="gap-2">
                        <ArrowUpFromLine className="h-4 w-4" /> Salida
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="ingreso" className="mt-6 md:mt-4">
                      <MovimientoForm tipo="ingreso" onCreated={setMovs} />
                    </TabsContent>
                    <TabsContent value="salida" className="mt-6 md:mt-4">
                      <MovimientoForm tipo="salida" onCreated={setMovs} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Movimientos registrados</CardTitle>
                  <CardDescription>
                    {movs.length === 0
                      ? 'Aún no hay movimientos.'
                      : expandMovs
                        ? `Mostrando ${movs.length} movimiento(s).`
                        : `Mostrando los últimos ${Math.min(5, movs.length)} de ${movs.length}.`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Bloque</TableHead>
                          <TableHead>Torre</TableHead>
                          <TableHead>Piso</TableHead>
                          <TableHead>Pos</TableHead>
                          <TableHead>Código</TableHead>
                          <TableHead className="hidden lg:table-cell">Descripción</TableHead>
                          <TableHead className="hidden sm:table-cell">UN</TableHead>
                          <TableHead className="text-right">Cant.</TableHead>
                          <TableHead className="hidden md:table-cell">Venc.</TableHead>
                          <TableHead className="hidden md:table-cell">Modificación</TableHead>
                          <TableHead className="hidden sm:table-cell">Turno</TableHead>
                          <TableHead className="hidden lg:table-cell">Usuario</TableHead>
                          {esAdmin && <TableHead className="w-10"></TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(expandMovs ? movs : movs.slice(0, 5)).map((m) => (
                          <TableRow key={m.id}>
                            <TableCell>
                              <Badge variant={m.tipo === 'ingreso' ? 'default' : 'destructive'}>
                                {m.tipo}
                              </Badge>
                            </TableCell>
                            <TableCell>{m.bloque}</TableCell>
                            <TableCell>{m.torre}</TableCell>
                            <TableCell>{m.piso}</TableCell>
                            <TableCell>{m.posicion}</TableCell>
                            <TableCell className="font-medium font-mono">{m.codigo}</TableCell>
                            <TableCell className="hidden lg:table-cell max-w-48 truncate">{m.descripcion}</TableCell>
                            <TableCell className="hidden sm:table-cell">{m.un}</TableCell>
                            <TableCell className="text-right">{fmtCantidad(m.cantidad)}</TableCell>
                            <TableCell className="hidden md:table-cell">{m.fVencimiento || '—'}</TableCell>
                            <TableCell className="hidden md:table-cell whitespace-nowrap text-muted-foreground text-xs">
                              {formatDateTime(m.fModificacion)}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">{m.turno}</TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {m.usuarioNombre ?? m.usuarioCorreo ?? '—'}
                            </TableCell>
                            {esAdmin && (
                              <TableCell>
                                <Button variant="ghost" size="icon" onClick={() => handleDelete(m.id)} aria-label="Eliminar">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {movs.length > 5 && (
                    <div className="mt-3 flex justify-center">
                      <Button variant="outline" size="sm" onClick={() => setExpandMovs((v) => !v)} className="gap-2">
                        {expandMovs ? (
                          <><ChevronUp className="h-4 w-4" /> Mostrar menos</>
                        ) : (
                          <><ChevronDown className="h-4 w-4" /> Expandir ({movs.length - 5} más)</>
                        )}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="traslado" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Traslado entre ubicaciones</CardTitle>
                  <CardDescription>
                    Busca un código, elige la ubicación de origen y destino. Confirma el traslado.
                  </CardDescription>
                </CardHeader>
                <CardContent><TrasladoTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="kardex" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Catálogo de códigos</CardTitle>
                  <CardDescription>
                    Pega códigos con UN y descripción. Los formularios autocompletarán al escribir.
                  </CardDescription>
                </CardHeader>
                <CardContent><CatalogoTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="stock" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Stock actual por código</CardTitle>
                  <CardDescription>
                    Stock = ingresos − salidas, agrupado por ubicación.
                  </CardDescription>
                </CardHeader>
                <CardContent><StockTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="ocupacion" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Ocupación del Kardex</CardTitle>
                  <CardDescription>
                    Mapa visual: Verde = vacío, Azul = ocupado.
                  </CardDescription>
                </CardHeader>
                <CardContent><OcupacionTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="descarga" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Descarga de datos</CardTitle>
                  <CardDescription>
                    Exporta a Excel movimientos y stock actual.
                  </CardDescription>
                </CardHeader>
                <CardContent><DescargaTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="fefo" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>FEFO — Control de vencimientos</CardTitle>
                  <CardDescription>
                    Verde &gt; 60 días · Azul ≤ 30 días · Naranja ≤ 15 días · Rojo vencidos.
                  </CardDescription>
                </CardHeader>
                <CardContent><FefoTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="usuarios" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Usuarios</CardTitle>
                  <CardDescription>
                    Lista de usuarios. {esAdmin ? 'Como administrador puedes cambiar roles y aprobar accesos.' : 'Solo el administrador puede modificar roles.'}
                  </CardDescription>
                </CardHeader>
                <CardContent><UsuariosTab /></CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {/* KARDEX PISO VIEW */}
        {view === 'piso' && (
          <Tabs defaultValue="movimientos" className="w-full">
            <TabsList className="grid w-full grid-cols-2 gap-2 h-auto p-2 md:w-auto md:grid-cols-4 md:gap-1 md:h-9 md:p-1">
              <TabsTrigger value="movimientos" className="gap-2 py-2 md:py-1">
                <History className="h-4 w-4" /> <span className="hidden md:inline">Movimientos</span>
              </TabsTrigger>
              <TabsTrigger value="up-kardex" className="gap-2 py-2 md:py-1">
                <Upload className="h-4 w-4" /> <span className="hidden md:inline">UP KARDEX</span>
              </TabsTrigger>
              <TabsTrigger value="sectores" className="gap-2 py-2 md:py-1">
                <Layers3 className="h-4 w-4" /> <span className="hidden md:inline">Sectores</span>
              </TabsTrigger>
              <TabsTrigger value="columnas" className="gap-2 py-2 md:py-1">
                <Settings className="h-4 w-4" /> <span className="hidden md:inline">Configuración</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="movimientos" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Movimientos</CardTitle>
                  <CardDescription>
                    Registra ingresos y salidas por nivel. Turnos: Día 07:45-19:45, Noche 19:45-07:45.
                  </CardDescription>
                </CardHeader>
                <CardContent><MovimientosTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="up-kardex" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>UP KARDEX</CardTitle>
                  <CardDescription>
                    Carga el catálogo de bloques desde un archivo Excel.
                  </CardDescription>
                </CardHeader>
                <CardContent><UpKardexTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="sectores" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Sectores</CardTitle>
                  <CardDescription>
                    Administra los sectores del almacén de piso.
                  </CardDescription>
                </CardHeader>
                <CardContent><SectoresTab /></CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="columnas" className="mt-6 md:mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Configuración de columnas</CardTitle>
                  <CardDescription>
                    Asigna bloques a columnas y administra el catálogo.
                  </CardDescription>
                </CardHeader>
                <CardContent><ConfiguracionColumnasTab /></CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t mt-8">
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-xs text-muted-foreground">
          RACKLY — Sistema de Gestión de Almacenes
        </div>
      </footer>
    </main>
  )
}

export default function Page() {
  return (
    <AuthProvider>
      <AuthGate>
        <RacklyApp />
      </AuthGate>
    </AuthProvider>
  )
}
