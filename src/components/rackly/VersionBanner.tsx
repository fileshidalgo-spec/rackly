'use client'

/**
 * RACKLY — Aviso de versión nueva (anti-caché).
 *
 * Al montar la app consulta /version.json (sin caché) y lo compara con el
 * sello compilado dentro del JS (SELLO_VERSION). Si difieren, la pestaña
 * está corriendo un build VIEJO (caché del navegador o sesión larga) y
 * muestra un aviso fijo con botón "Recargar".
 *
 * Esto resuelve la raíz de "no veo la función que pedí": el usuario
 * trabajaba sobre una versión anterior servida desde caché. Con el aviso,
 * saber que hay que recargar deja de depender de que alguien lo sospeche.
 */

import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { SELLO_VERSION } from '@/lib/rackly/version-sello'

export function VersionBanner() {
  const [obsoleta, setObsoleta] = useState(false)
  const [oculto, setOculto] = useState(false)

  useEffect(() => {
    let vivo = true
    async function verificar() {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const datos = (await res.json()) as { v?: string }
        // Sólo avisa si ambos sellos existen y son distintos (un version.json
        // ausente/roto NO debe bloquear el uso de la app).
        if (vivo && datos.v && datos.v !== SELLO_VERSION) setObsoleta(true)
      } catch {
        /* sin red o archivo viejo: silencio, no molestar */
      }
    }
    void verificar()
    // Re-chequeo suave cada 15 min (turnos largos con la pestaña abierta).
    const id = setInterval(verificar, 15 * 60 * 1000)
    return () => {
      vivo = false
      clearInterval(id)
    }
  }, [])

  if (!obsoleta || oculto) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 sm:px-4">
      <div className="mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 shadow-lg">
        <RefreshCw className="h-4 w-4 shrink-0 text-amber-600" />
        <p className="flex-1 text-xs font-semibold text-amber-900 leading-snug">
          Hay una versión nueva de Rackly — recarga para trabajar con lo último.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 px-3 py-1.5 text-xs font-bold text-white hover:from-amber-600 hover:to-orange-700"
        >
          Recargar
        </button>
        <button
          type="button"
          onClick={() => setOculto(true)}
          aria-label="Cerrar aviso"
          className="shrink-0 rounded-md p-1 text-slate-400 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
