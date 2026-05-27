'use client'

import { useState, useEffect } from 'react'
import { fetchMovimientos, type Movimiento } from '@/lib/rackly/kardex'
import { useMovimientosRealtime } from '@/hooks/useMovimientosRealtime'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Download, Loader2 } from 'lucide-react'

export function DescargaTab() {
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [busy, setBusy] = useState(false)

  useMovimientosRealtime(setMovs)

  async function handleExport() {
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Sheet 1: Movimientos
      const movData = movs.map((m) => ({
        Tipo: m.tipo,
        Bloque: m.bloque,
        Torre: m.torre,
        Piso: m.piso,
        Posición: m.posicion,
        Código: m.codigo,
        Descripción: m.descripcion,
        UN: m.un,
        Cantidad: m.cantidad,
        'F. Vencimiento': m.fVencimiento || '',
        'F. Modificación': new Date(m.fModificacion).toLocaleString(),
        Turno: m.turno,
        Usuario: m.usuarioNombre ?? m.usuarioCorreo ?? '',
        Proveedor: m.proveedor ?? '',
      }))
      const ws1 = XLSX.utils.json_to_sheet(movData)
      XLSX.utils.book_append_sheet(wb, ws1, 'Movimientos')

      // Sheet 2: Stock actual
      const locMap = new Map<string, Record<string, unknown>>()
      for (const m of movs) {
        const key = `${m.codigo}-${m.bloque}-${m.torre}-${m.piso}-${m.posicion}`
        const isPositive = m.tipo === 'ingreso' || m.tipo === 'devolucion' || m.tipo === 'traslado'
        const current = locMap.get(key)
        if (current) {
          current['Stock'] =
            (current['Stock'] as number) +
            (isPositive ? m.cantidad : -m.cantidad)
        } else {
          locMap.set(key, {
            Código: m.codigo,
            Descripción: m.descripcion,
            UN: m.un,
            Bloque: m.bloque,
            Torre: m.torre,
            Piso: m.piso,
            Posición: m.posicion,
            Stock: isPositive ? m.cantidad : -m.cantidad,
          })
        }
      }
      const stockData = Array.from(locMap.values()).filter(
        (s) => (s['Stock'] as number) > 0
      )
      if (stockData.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(stockData)
        XLSX.utils.book_append_sheet(wb, ws2, 'Stock Actual')
      }

      const fecha = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `RACKLY_${fecha}.xlsx`)
      toast.success('Archivo descargado')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error'
      toast.error('Error al exportar', { description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Exporta a Excel todos los movimientos y el stock actual por ubicación.
        {movs.length > 0 && (
          <span className="ml-2 font-medium">
            ({movs.length} movimiento(s) registrados)
          </span>
        )}
      </p>
      <Button onClick={handleExport} disabled={busy || movs.length === 0} className="gap-2">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Descargar Excel
      </Button>
    </div>
  )
}
