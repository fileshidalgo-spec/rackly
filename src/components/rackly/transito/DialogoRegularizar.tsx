'use client'

/**
 * RACKLY — TRÁNSITO · Diálogo de REGULARIZACIÓN de fila sobrante.
 *
 * Caso T173-00004274: una guía registró MÁS cantidad de la realmente
 * llegada (172 vs 150) y el sobrante (22 UN) queda "flotando" en Tránsito
 * con semáforo ROJO para siempre — físicamente nunca existió, así que no
 * puede transferirse a ninguna ubicación.
 *
 * Este diálogo ejecuta el camino DIRECTO de regularización (puente
 * Tránsito→Recepción): elimina la fila de recepcion_registros vía la RPC
 * `recepcion_regularizar_fila`, que en BD exige el permiso
 * `recepcion.eliminar` y SOLO acepta filas SIN envíos de Tránsito. El botón
 * solo se muestra a quien pasa `puede(perfil, 'recepcion.eliminar')` en el
 * cliente; ante cualquier rechazo, el mensaje "CODE|detalle" de la RPC se
 * muestra tal cual (fuente de verdad).
 *
 * Confirmación EXPLÍCITA con el detalle de lo que se va a borrar + motivo
 * opcional (viaja al snapshot de auditoría que devuelve la RPC).
 */

import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  regularizarFila,
  mensajeRpcError,
  type ArticuloTransito,
  type ResultadoRegularizacion,
} from '@/lib/rackly/transito'

export function DialogoRegularizar({
  articulo,
  onListo,
  onCancelar,
}: {
  articulo: ArticuloTransito
  onListo: (resultado: ResultadoRegularizacion) => void
  onCancelar: () => void
}) {
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)

  // Al abrir con OTRO artículo, el motivo no debe arrastrarse del anterior.
  useEffect(() => {
    setMotivo('')
  }, [articulo.id])

  const ejecutar = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await regularizarFila({ recepcionId: articulo.id, motivo })
      const f = res.fila
      toast.success('Fila regularizada: la guía quedó corregida', {
        description: f
          ? `${f.numero_documento ? `${f.tipo_documento} ${f.numero_documento} · ` : ''}${f.codigo} — ${f.cantidad} ${f.unidad_medida} eliminados (lote ${f.lote || '—'})`
          : `${articulo.codigo} — ${articulo.cantidad} ${articulo.unidadMedida}`,
      })
      onListo(res)
    } catch (err) {
      // Fuente de verdad: "PERMISO|…", "CON_ENVIOS|…", "RECEPCION_NO_EXISTE|…".
      toast.error('No se pudo regularizar', { description: mensajeRpcError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancelar() }}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-5 w-5 text-rose-600" />
            Regularizar fila sobrante
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-xs text-slate-600 space-y-2">
              <p>
                Esta fila se <span className="font-bold text-slate-800">ELIMINARÁ de la guía</span> en
                Recepción (el total del artículo baja en el mismo importe) y desaparecerá de Tránsito.
                Úsalo solo cuando la cantidad fue registrada <span className="font-bold">de más</span> y
                la mercadería nunca llegó.
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] space-y-0.5">
                <p className="font-bold text-slate-800">
                  {articulo.codigo} <span className="font-medium text-slate-500">{articulo.descripcion}</span>
                </p>
                <p>
                  Guía: {articulo.numeroDocumento || articulo.tipoDocumento} ·{' '}
                  {articulo.nPaleta != null ? `Paleta ${articulo.nPaleta} · ` : ''}
                  Lote {articulo.lote || '—'}
                </p>
                <p>
                  Se eliminarán:{' '}
                  <Badge className="bg-rose-100 text-rose-800 border border-rose-300 h-4 px-1.5 text-[10px] font-bold">
                    {articulo.pendiente} {articulo.unidadMedida}
                  </Badge>{' '}
                  sin ninguna transferencia
                </p>
              </div>
              <p className="text-[11px]">
                Si la fila ya tiene traslados, la BD la rechazará: primero revierte el traslado.
              </p>
              <div className="pt-1">
                <label className="text-[11px] font-semibold text-slate-700" htmlFor="motivo-regularizacion">
                  Motivo (opcional, queda en el registro de la operación)
                </label>
                <Textarea
                  id="motivo-regularizacion"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ej. El proveedor envió 54 pero llegaron 32 — sobrante 22"
                  rows={2}
                  maxLength={500}
                  className="mt-1 text-xs"
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              void ejecutar()
            }}
            className="bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-600"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Regularizando…
              </>
            ) : (
              'Sí, regularizar (eliminar fila)'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
