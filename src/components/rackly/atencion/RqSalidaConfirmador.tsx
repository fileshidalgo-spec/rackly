'use client'

/**
 * RACKLY — Confirmador UNIVERSAL "¿Registrar esta salida en la RQ?".
 *
 * FIX auditoría 2026-10-22 (P2): antes existían 2 diálogos idénticos
 * (OcupacionTab y PisoSectoresTab) y 7 rutas de salida SIN oferta de registro
 * (alertas de destino ocupado, salidas masivas, SalidaForm), aunque el banner
 * "Atendiendo la RQ…" promete lo contrario. Este componente centraliza el
 * diálogo + la RPC atómica atenderItemRq + los avisos (con excedente), y lo
 * usan TODAS las rutas de salida normal:
 *   · OcupacionTab.doSalida + handleTrSalidaDesdeAlerta
 *   · PisoSectoresTab.doSalida + doMassSalida + handleTrSalidaDesdeAlerta
 *   · TrasladoTab.handleSalidaDesdeAlerta
 *   · MovimientoForm: IngresoForm.handleSalidaDesdeAlerta, SalidaForm.doSalida
 *     y doMassSalida
 * Las rutas INC (SalidaIncForm) NO lo usan a propósito: el stock INC es no
 * conforme y vive en un pool aparte; nunca se cuenta como atención de RQ.
 *
 * La detección viene de detectarRqParaSalida() (rq-contexto-salida.ts):
 * si no hay contexto RQ (entrada directa a Racks/Piso) el componente no
 * aparece jamás → la salida es regularización pura, sin conflicto.
 */

import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { atenderItemRq } from '@/lib/rackly/rq-atencion'
import { toast } from 'sonner'
import type { RqSalidaDetectada } from '@/lib/rackly/rq-contexto-salida'
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
import { mensajeError } from '@/lib/rackly/errores'

/** Formato numérico de los avisos RQ (igual que OcupacionTab/PisoSectoresTab). */
function fmtRq(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('es-PE') : String(Math.round(n * 1000) / 1000)
}

export function RqSalidaConfirmador({
  conf,
  hintVolver = false,
  onTerminar,
  onCerrar,
}: {
  /** Salida detectada para la RQ (null = no mostrar). */
  conf: RqSalidaDetectada | null
  /** Añade la pista "Toca «← Volver a Atención (RQ)»…" al aviso de completado. */
  hintVolver?: boolean
  /** Llamado tras registrar CON éxito (cierra el diálogo en el caller). */
  onTerminar: () => void
  /** Llamado al cancelar/descartar (la salida queda como regularización). */
  onCerrar: () => void
}) {
  const { perfil } = useAuth()
  const [busy, setBusy] = useState(false)

  async function confirmar() {
    if (!conf) return
    setBusy(true)
    try {
      // Task 27: las posiciones detectadas viajan al ledger rq_atencion_tomas
      // (desde dónde salió el material); sin posiciones queda toma 'manual'.
      const actualizado = await atenderItemRq(
        conf.itemId,
        conf.cantidad,
        perfil?.nombre || perfil?.correo || '',
        conf.tomas
      )
      const completo = actualizado.cantidadAtendida >= actualizado.cantidad
      // Excedente automático: lo atendido puede superar lo pedido (p. ej. paleta
      // completa de 123 mil para un pedido de 120 mil) — se muestra en el aviso.
      const excedente = actualizado.cantidadAtendida - actualizado.cantidad
      toast.success(`Registrado en la RQ ${conf.numeroRq}`, {
        description: completo
          ? `Ya completaste este artículo: ${fmtRq(actualizado.cantidadAtendida)} de ${fmtRq(actualizado.cantidad)} ${actualizado.unidad}${excedente > 0 ? ` · Excedente: +${fmtRq(excedente)} ${actualizado.unidad}` : ''}${hintVolver ? '. Toca «← Volver a Atención (RQ)» para seguir.' : ''}`
          : `Atendido: ${fmtRq(actualizado.cantidadAtendida)} de ${fmtRq(actualizado.cantidad)} ${actualizado.unidad} · Pendiente: ${fmtRq(Math.max(actualizado.cantidad - actualizado.cantidadAtendida, 0))}`,
        duration: 9000,
      })
      onTerminar()
    } catch (err: unknown) {
      toast.error('No se pudo registrar en la RQ', {
        description: mensajeError(err),
      })
      // El diálogo permanece abierto: el usuario decide reintentar o cancelar.
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={!!conf}
      onOpenChange={(o) => {
        if (!o && !busy) onCerrar()
      }}
    >
      <AlertDialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            ¿Registrar esta salida en la RQ {conf?.numeroRq || ''}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Saliste <b>{conf ? fmtRq(conf.cantidad) : ''} {conf?.unidad}</b> de{' '}
            <b className="font-mono">{conf?.codigo}</b>.
            <br />
            <br />
            <b>Sí</b> → suma la cantidad a lo ATENDIDO de la RQ; si alcanza o supera lo requerido
            ({conf ? fmtRq(conf.requerido) : ''}), el material queda COMPLETO (el excedente se
            registra tal cual salió).
            <br />
            <b>No</b> → la salida queda solo como movimiento de stock (regularización); la RQ no
            cambia. Úsalo si el stock del sistema no existía físicamente.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="sm:mr-auto">
            No, solo salida
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              void confirmar()
            }}
            disabled={busy}
            className="bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Sí, registrar en la RQ
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
