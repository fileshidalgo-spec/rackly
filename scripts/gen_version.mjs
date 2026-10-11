#!/usr/bin/env node
/**
 * RACKLY — Sello de versión de build (se ejecuta con `prebuild`).
 *
 * Genera DOS artefactos con el MISMO sello:
 *   · public/version.json          → lo sirve el sitio (se consulta con
 *                                    fetch cache-busteado al abrir la app).
 *   · src/lib/rackly/version-sello.ts → const SELLO_VERSION compilada DENTRO
 *                                    del JS de la app.
 *
 * Si el usuario tiene una pestaña/caché con un build VIEJO, su JS trae un
 * SELLO distinto al version.json actual → la app muestra "Nueva versión
 * disponible — Recargar". Así nunca más se trabaja sobre una versión
 * desactualizada (el usuario no tiene que saber borrar la caché).
 *
 * El sello usa fecha UTC + hash corto de git (fallback sin git).
 */
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

let sha = 'sin-git'
try {
  sha = execSync('git rev-parse --short HEAD', { cwd: raiz }).toString().trim()
} catch {
  /* fuera de un repo: usa solo la fecha */
}
const ahora = new Date()
const fecha = ahora.toISOString().slice(0, 16).replace(/[-:T]/g, '')
const sello = `${fecha}-${sha}`

// 1) version.json (público, lo consulta el navegador)
writeFileSync(
  join(raiz, 'public', 'version.json'),
  JSON.stringify({ v: sello, generado: ahora.toISOString() }, null, 2) + '\n'
)

// 2) módulo TS compilado dentro de la app
const ts = `// AUTO-GENERADO por scripts/gen_version.mjs (prebuild) — NO editar a mano.
/** Sello del build: se compara con public/version.json para avisar
 *  al usuario cuando su pestaña quedó en una versión anterior. */
export const SELLO_VERSION = '${sello}'
`
const destino = join(raiz, 'src', 'lib', 'rackly', 'version-sello.ts')
mkdirSync(dirname(destino), { recursive: true })
writeFileSync(destino, ts)

console.log(`🔖 Sello de versión: ${sello}`)
