'use client'

import { useState, useEffect, useMemo } from 'react'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Search, Download, Loader2 } from 'lucide-react'

type FefoItem = {
  codigo: string
  descripcion: string
  bloque: string
  torre: string
  piso: string
  posicion: string
  stock: number
  diasRestantes: number
  fVencimiento: string
  un: string
  proveedor?: string
  status: 'vigente' | 'proximo' | 'urgente' | 'vencido'
}

export function FefoTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [search, setSearch] = useState('')
  const [filtros, setFiltros] = useState({
    vigente: true,
    proximo: true,
    urgente: true,
    vencido: true,
  })
  const [busy, setBusy] = useState(false)

  useMovimientosRealtime(setMovs)

  const fefoData = useMemo(() => {
    const locMap = new Map<
      string,
      {
        codigo: string
        descripcion: string
        un: string
        bloque: string
        torre: string
        piso: string
        posicion: string
        stock: number
        fVencimiento: string
        proveedor?: string
      }
    >()

    // Calcular stock por ubicación: ingreso, devolucion, traslado = positivo; salida = negativo
    for (const m of movs) {
      if (m.tipo === 'traslado') continue // Los traslados no tienen vencimiento propio para FEFO
      const key = `${m.codigo}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
      const isPositive = m.tipo === 'ingreso' || m.tipo === 'devolucion'
      const existing = locMap.get(key)
      if (existing) {
        existing.stock += isPositive ? m.cantidad : -m.cantidad
        if (isPositive && m.fVencimiento && (!existing.fVencimiento || m.fVencimiento < existing.fVencimiento)) {
          existing.fVencimiento = m.fVencimiento
        }
      } else if (isPositive) {
        locMap.set(key, {
          codigo: m.codigo,
          descripcion: m.descripcion,
          un: m.un,
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: m.cantidad,
          fVencimiento: m.fVencimiento || '',
          proveedor: m.proveedor || undefined,
        })
      } else if (m.tipo === 'salida') {
        locMap.set(key, {
          codigo: m.codigo,
          descripcion: m.descripcion,
          un: m.un,
          bloque: m.bloque,
          torre: m.torre,
          piso: m.piso,
          posicion: m.posicion,
          stock: -m.cantidad,
          fVencimiento: '',
          proveedor: m.proveedor || undefined,
        })
      }
    }

    const items: FefoItem[] = []
    const now = new Date()
    for (const [, loc] of locMap) {
      if (loc.stock <= 0 || !loc.fVencimiento) continue
      const venc = new Date(loc.fVencimiento)
      const diff = Math.ceil(
        (venc.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )
      let status: FefoItem['status']
      if (diff < 0) status = 'vencido'
      else if (diff <= 15) status = 'urgente'
      else if (diff <= 30) status = 'proximo'
      else status = 'vigente'

      items.push({
        ...loc,
        diasRestantes: diff,
        status,
      })
    }

    return items.sort((a, b) => a.diasRestantes - b.diasRestantes)
  }, [movs])

  const filtered = useMemo(() => {
    let data = fefoData
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      data = data.filter(
        (i) =>
          i.codigo.toUpperCase().includes(q) ||
          i.descripcion.toUpperCase().includes(q)
      )
    }
    return data.filter((i) => filtros[i.status])
  }, [fefoData, search, filtros])

  const counts = useMemo(
    () => ({
      vigente: fefoData.filter((i) => i.status === 'vigente').length,
      proximo: fefoData.filter((i) => i.status === 'proximo').length,
      urgente: fefoData.filter((i) => i.status === 'urgente').length,
      vencido: fefoData.filter((i) => i.status === 'vencido').length,
    }),
    [fefoData]
  )

  function statusColor(status: FefoItem['status']) {
    switch (status) {
      case 'vigente':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
      case 'proximo':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100'
      case 'urgente':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100'
      case 'vencido':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100'
    }
  }

  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const data = filtered.map((i) => ({
        Código: i.codigo,
        Descripción: i.descripcion,
        Bloque: i.bloque,
        Torre: i.torre,
        Piso: i.piso,
        Posición: i.posicion,
        UN: i.un,
        Stock: i.stock,
        'Días restantes': i.diasRestantes,
        'F. Vencimiento': i.fVencimiento,
        Estado: i.status,
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'FEFO')
      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_FEFO_${fecha}.xlsx`)
      toast.success('FEFO exportado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar código o descripción..."
            className="pl-9"
          />
        </div>
        <Button onClick={handleExport} disabled={busy} variant="outline" className="gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        {(
          [
            ['vigente', '> 60 días', 'green'],
            ['proximo', '≤ 30 días', 'blue'],
            ['urgente', '≤ 15 días', 'orange'],
            ['vencido', 'Vencidos', 'red'],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <Checkbox
              checked={filtros[key as keyof typeof filtros]}
              onCheckedChange={(v) =>
                setFiltros((f) => ({ ...f, [key]: !!v }))
              }
            />
            <span
              className={`inline-block w-3 h-3 rounded-full bg-${label.includes('60') ? 'green' : label.includes('30') ? 'blue' : label.includes('15') ? 'orange' : 'red'}-500`}
            />
            {label} ({counts[key as keyof typeof counts]})
          </label>
        ))}
      </div>

      <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Bloque</TableHead>
              <TableHead>Torre</TableHead>
              <TableHead>Pos</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead>Proveedor</TableHead>
              <TableHead>Vencimiento</TableHead>
              <TableHead className="text-right">Días</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono">{item.codigo}</TableCell>
                <TableCell>{item.descripcion}</TableCell>
                <TableCell>{item.bloque}</TableCell>
                <TableCell>{item.torre}</TableCell>
                <TableCell>{item.posicion}</TableCell>
                <TableCell className="text-right">{item.stock}</TableCell>
                <TableCell>
                  {item.proveedor ? (
                    <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800 font-semibold">
                      {item.proveedor}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{item.fVencimiento}</TableCell>
                <TableCell className="text-right font-medium">
                  {item.diasRestantes}
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(item.status)}`}
                  >
                    {item.status}
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  Sin resultados
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
