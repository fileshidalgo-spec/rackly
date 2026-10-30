#!/usr/bin/env node
/**
 * Codemod 2026-10-30 — unifica la extracción de mensajes de error.
 *
 * Reemplaza las 3 variantes ingenuas del proyecto por el extractor canónico:
 *   X instanceof Error ? X.message : 'Error desconocido'   → mensajeError(X)
 *   X instanceof Error ? X.message : 'error desconocido'   → mensajeError(X)
 *   X instanceof Error ? X.message : String(X)             → mensajeError(X)
 * y añade el import de '@/lib/rackly/errores' (o './errores' dentro de
 * src/lib/rackly) si falta.
 *
 * Seguro: el reemplazo NO cambia lógica — solo recupera el mensaje real de
 * errores que no son `Error` (PostgrestError plano → antes '[object Object]'
 * o 'Error desconocido').
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'src')
const RE = /\b([A-Za-z_$][\w$]*) instanceof Error \? \1\.message : (?:String\(\1\)|'[Ee]rror desconocido'|'Error')/g

const cambios = []
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (!/\.(tsx?|jsx?)$/.test(name)) continue
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    // El módulo canónico no se auto-modifica.
    if (rel === 'lib/rackly/errores.ts') continue
    const src = fs.readFileSync(p, 'utf8')
    let count = 0
    const out = src.replace(RE, (_m, v) => { count++; return `mensajeError(${v})` })
    if (count === 0) continue
    let result = out
    if (!/from '@\/lib\/rackly\/errores'|from '\.\/errores'|from '\.\.\/errores'/.test(result)) {
      const importLine = rel.startsWith('lib/rackly/')
        ? "import { mensajeError } from './errores'"
        : "import { mensajeError } from '@/lib/rackly/errores'"
      // Insertar tras el último import de nivel superior.
      const reImport = /^import[^\n]*\n/gm
      let lastEnd = -1, m
      while ((m = reImport.exec(result)) !== null) lastEnd = m.index + m[0].length
      if (lastEnd >= 0) {
        result = result.slice(0, lastEnd) + importLine + '\n' + result.slice(lastEnd)
      } else {
        // Sin imports: después de 'use client' / cabecera de comentarios.
        const useClient = /^('use client'\n)/.exec(result)
        const at = useClient ? useClient[0].length : 0
        result = result.slice(0, at) + importLine + '\n\n' + result.slice(at)
      }
    }
    fs.writeFileSync(p, result)
    cambios.push(`${rel} (${count} reemplazo${count > 1 ? 's' : ''})`)
  }
}
walk(ROOT)
console.log(`Archivos modificados: ${cambios.length}`)
for (const c of cambios) console.log('  ✓', c)
