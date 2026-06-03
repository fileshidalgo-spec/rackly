'use client'

import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode; fallback?: ReactNode; name?: string }
type State = { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.name ? ` (${this.props.name})` : ''}] Error capturado:`, error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      // Section-level error (when name is provided, show smaller fallback)
      if (this.props.name) {
        return (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-12 h-12 mx-auto bg-amber-500/10 rounded-full flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-slate-300 mb-1">Error en {this.props.name}</h3>
            <p className="text-xs text-slate-500 mb-3">Esta sección tuvo un problema inesperado.</p>
            <div className="flex gap-2">
              <button
                onClick={this.handleReset}
                className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-medium transition-colors"
              >
                Reintentar
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors"
              >
                Recargar
              </button>
            </div>
          </div>
        )
      }

      // Full-page error (top-level ErrorBoundary)
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-slate-300 p-6">
          <div className="bg-slate-800 rounded-2xl border border-red-500/20 p-8 max-w-md w-full text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-red-500/10 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white">Ocurrio un error inesperado</h2>
            <p className="text-sm text-slate-400">
              La aplicacion encontro un problema. Puedes intentar recargar la pagina para continuar.
            </p>
            {this.state.error && (
              <p className="text-xs text-red-400/80 font-mono bg-red-500/5 rounded-lg p-3 overflow-auto max-h-24">
                {this.state.error.message}
              </p>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium transition-colors"
              >
                Reintentar
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
              >
                Recargar pagina
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
