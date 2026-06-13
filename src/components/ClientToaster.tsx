'use client'

import { useEffect } from 'react'
import { Toaster } from '@/components/ui/sonner'
import type { ToasterProps } from 'sonner'

/**
 * Wrapper que:
 * 1. Monta el Toaster solo en el cliente (evita problemas de hidratación)
 * 2. Instala handlers globales para atrapar errores que se escapan del ErrorBoundary
 *    (errores en useEffect, setTimeout, promesas rechazadas, etc.)
 */
export function ClientToaster(props: ToasterProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)

    // Atrapar errores NO capturados por React ErrorBoundary
    // (errores en useEffect, timeouts, event handlers async, etc.)
    const handleError = (event: ErrorEvent) => {
      console.error('[RACKLY] Error global no capturado:', event.error)
      // Si es un error crítico de Supabase, mostrar mensaje claro
      const msg = event.message ?? ''
      if (msg.includes('supabase') || msg.includes('Supabase') || msg.includes('NEXT_PUBLIC')) {
        document.body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;padding:1rem;font-family:system-ui,sans-serif">
            <div style="background:white;border-radius:1rem;border:1px solid #fecaca;box-shadow:0 10px 25px rgba(0,0,0,0.1);padding:2rem;max-width:400px;text-align:center">
              <div style="width:4rem;height:4rem;margin:0 auto 1rem;background:#fef2f2;border-radius:50%;display:flex;align-items:center;justify-content:center">
                <span style="font-size:2rem">&#9888;</span>
              </div>
              <h2 style="font-size:1.25rem;font-weight:700;color:#1e293b;margin-bottom:0.5rem">Error de configuración</h2>
              <p style="font-size:0.875rem;color:#64748b;margin-bottom:1rem">Las variables de conexión con Supabase no están configuradas. Contacta al administrador.</p>
              <button onclick="location.reload()" style="padding:0.5rem 1.5rem;border-radius:0.5rem;background:#4f46e5;color:white;border:none;cursor:pointer;font-size:0.875rem;font-weight:500">Recargar</button>
            </div>
          </div>
        `
      }
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error('[RACKLY] Promesa rechazada no capturada:', event.reason)
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  if (!mounted) return null
  return <Toaster {...props} />
}

import { useState } from 'react'