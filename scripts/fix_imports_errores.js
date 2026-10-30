#!/usr/bin/env node
/**
 * REPARACIÓN v2 del codemod 2026-10-30 (la v1 se autoimportó errores.ts,
 * duplicó el import de utils.ts por comillas dobles y no reparó los archivos
 * rotos). Este script:
 *   1) ELIMINA líneas de import de errores mal colocadas (insertadas justo
 *      después de una línea `import` sin cerrar — dentro de un multilínea),
 *   2) ELIMINA imports DUPLICADOS del mismo módulo (mismo archivo),
 *   3) GARANTIZA UN import de mensajeError por archivo que lo use, al FINAL
 *      del bloque de imports (rastreando statements multilínea),
 *   4) QUITA el auto-import del propio errores.ts si existiera.
 * Idempotente y seguro de reejecutar.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'src')
const LINEA = (mod) => `import { mensajeError } from '${mod}'`
const RE_LINEA = /^import \{ mensajeError \} from ['"](@\/lib\/rackly\/errores|\.\/errores)['"];?\s*$/
const RE_TIENE = /from ['"](@\/lib\/rackly\/errores|\.\/errores)['"]/

/** true si la línea TERMINA un statement de import completo. */
function terminaImport(ln) {
  const s = ln.trim()
  if (/^import\s+['"]/.test(s)) return /['"]\s*;?\s*$/.test(s) // side-effect
  return /from\s+['"][^'"]+['"]\s*;?\s*$/.test(s)
}

function repararArchivo(p) {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/')
  const esElPropioModulo = rel === 'lib/rackly/errores.ts'
  const mod = rel.startsWith('lib/rackly/') ? "'./errores'" : "'@/lib/rackly/errores'"
  const original = fs.readFileSync(p, 'utf8')
  const lines = original.split('\n')

  const limpias = []
  let quitadas = 0
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const esLineaErrores = RE_LINEA.test(ln.trim())
    const previa = limpias[limpias.length - 1]
    // 1) insertada DENTRO de un import multilínea → fuera
    if (esLineaErrores && !esElPropioModulo && previa !== undefined &&
        /^import[\s{]/.test(previa) && !terminaImport(previa)) {
      quitadas++
      continue
    }
    // 2) el propio módulo NUNCA se autoimporta
    if (esLineaErrores && esElPropioModulo) {
      quitadas++
      continue
    }
    limpias.push(ln)
  }
  let result = limpias.join('\n')

  // 3) UN solo import por archivo que use mensajeError
  const usaMensajeError = /\bmensajeError\s*\(/.test(result)
  const coincide = RE_TIENE.exec(result)
  if (coincide && coincide[1] !== mod.replace(/^'|'$/g, '')) {
    // Tiene el import con OTRO especificador del que toca (p. ej. './errores'
    // fuera de lib/rackly) — normalizarlo quitando la línea vieja.
    result = result
      .split('\n')
      .filter((ln) => !RE_LINEA.test(ln.trim()))
      .join('\n')
  }
  const tieneAhora = RE_TIENE.test(result)
  if (usaMensajeError && !esElPropioModulo && !tieneAhora) {
    const lns = result.split('\n')
    let inImport = false
    let lastImportEnd = -1
    for (let i = 0; i < lns.length; i++) {
      const ln = lns[i]
      if (!inImport && /^import[\s{]/.test(ln)) inImport = true
      if (inImport && terminaImport(ln)) {
        lastImportEnd = i
        inImport = false
      }
    }
    if (lastImportEnd >= 0) {
      lns.splice(lastImportEnd + 1, 0, LINEA(mod))
    } else {
      const useClient = /^('use client'\n)/.exec(result)
      const at = useClient ? 1 : 0
      lns.splice(at, 0, LINEA(mod), '')
    }
    result = lns.join('\n')
  }

  if (result !== original) {
    fs.writeFileSync(p, result)
    console.log(`  ✓ ${rel}${quitadas ? ` (${quitadas} quitada(s))` : ''}${usaMensajeError && !tieneAhora ? ' + import añadido' : ''}`)
    return true
  }
  return false
}

let n = 0
;(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (!/\.(tsx?|jsx?)$/.test(name)) continue
    if (repararArchivo(p)) n++
  }
})(ROOT)
console.log(`Archivos reparados: ${n}`)
