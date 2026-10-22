/**
 * Task 16 — Prueba end-to-end de carga de catálogo >2000 líneas.
 *
 * Replica EXACTAMENTE el flujo del navegador en el módulo Racks → Catálogo:
 *   login → JWT de usuario autenticado (RLS activa) →
 *   mergeCatalogo (dedupe + upsert por lotes de 500, fallback fila-a-fila) →
 *   verificación en BD → limpieza total (filas de prueba + usuario temporal).
 *
 * Fases:
 *   A) Carga inicial: 2530 filas (2500 únicas + 30 duplicadas) → espera 2500.
 *   B) Idempotencia: re-carga del mismo archivo (caso de uso diario del usuario).
 *   C) Documenta el modo de fallo histórico: 2500 filas en UNA sola petición.
 *
 * Todo con códigos T16T… y usuario temporal — cero rastro al terminar.
 */
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const crypto = require('crypto')

const URL = 'https://owjryvcrhpmgtkkdcrkm.supabase.co'
const ANON = fs.readFileSync('/tmp/.anon_key', 'utf8').trim()
const SERVICE = fs.readFileSync('/tmp/.service_key', 'utf8').trim()

const PREFIJO = 'T16T'
const TOTAL = 2500
const DUPLICADAS = 30
const CHUNK = 500 // idéntico a mergeCatalogo
const TIMEOUT_MS = 90000

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
let usuarioId = null
const anon = createClient(URL, ANON)
let authed = null // cliente con JWT de usuario (como el navegador)

function conTimeout(p, etiqueta) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${TIMEOUT_MS}ms en ${etiqueta}`)), TIMEOUT_MS)),
  ])
}

function construirArchivo() {
  // Fila con la MISMA forma que envía mergeCatalogo (codigo/un/descripcion/stock_big_magic/updated_at)
  const base = []
  for (let i = 0; i < TOTAL; i++) {
    base.push({
      codigo: `${PREFIJO}${String(i).padStart(5, '0')}`,
      un: ['KG', 'UN', 'LT', 'MT'][i % 4],
      descripcion: `ARTICULO PRUEBA E2E TASK16 ${i} — ÁÉÍÓÚ ñ "comillas" ;tab;${i % 3 === 0 ? ' / SLASH' : ''}`,
      stock_big_magic: i * 1.5,
    })
  }
  // 30 duplicados dentro del archivo (caso real: el Excel trae códigos repetidos)
  for (let d = 0; d < DUPLICADAS; d++) {
    base.push({ ...base[d], stock_big_magic: 999.99 }) // última aparición debe ganar
  }
  return base
}

// ── Réplica exacta de mergeCatalogo (src/lib/rackly/catalogo.ts) ──
async function mergeCatalogoReplica(nuevos) {
  const mapa = new Map()
  for (const i of nuevos) {
    const codigo = i.codigo.trim().toUpperCase()
    if (!codigo) continue
    mapa.set(codigo, { ...i, codigo })
  }
  const rows = [...mapa.values()].map((i) => ({
    codigo: i.codigo,
    un: i.un,
    descripcion: i.descripcion,
    stock_big_magic: i.stock_big_magic ?? 0,
    updated_at: new Date().toISOString(),
  }))
  const errores = []
  let cargados = 0
  const t0 = Date.now()
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const t1 = Date.now()
    const kb = Math.round(JSON.stringify(chunk).length / 1024)
    try {
      const { error } = await conTimeout(
        authed.from('catalogo').upsert(chunk, { onConflict: 'codigo' }),
        `lote ${i / CHUNK + 1}`
      )
      if (error) throw error
      cargados += chunk.length
      console.log(`    lote ${i / CHUNK + 1}: ${chunk.length} filas, ~${kb}KB, ${Date.now() - t1}ms OK`)
    } catch (eChunk) {
      // Fallback fila por fila (idéntico a la app) para identificar la fila problemática
      console.log(`    lote ${i / CHUNK + 1}: FALLÓ (${eChunk.message}) → fallback fila-a-fila`)
      for (const r of chunk) {
        const { error: singleErr } = await conTimeout(
          authed.from('catalogo').upsert(r, { onConflict: 'codigo' }),
          `fila ${r.codigo}`
        )
        if (singleErr) errores.push(`${r.codigo}: ${singleErr.message}`)
        else cargados++
      }
    }
  }
  return { cargados, errores, totalUnicos: rows.length, ms: Date.now() - t0 }
}

async function contarT16T() {
  const { count, error } = await conTimeout(
    authed.from('catalogo').select('codigo', { count: 'exact', head: true }).like('codigo', 'T16T%'),
    'conteo'
  )
  if (error) throw error
  return count
}

async function main() {
  let exito = false
  const resultados = {}
  try {
    // ── 1. Usuario temporal (como un usuario real de la app) ──
    const email = `task16-e2e-${Date.now()}@rackly-test.local`
    const pass = crypto.randomBytes(16).toString('hex')
    const { data: creado, error: errCrea } = await admin.auth.admin.createUser({
      email, password: pass, email_confirm: true,
    })
    if (errCrea) throw new Error('No se pudo crear usuario temporal: ' + errCrea.message)
    usuarioId = creado.user.id
    console.log('1. Usuario temporal creado:', email)

    // ── 2. Login con anon key → JWT authenticated (exactamente el navegador) ──
    const { data: sesion, error: errLogin } = await anon.auth.signInWithPassword({ email, password: pass })
    if (errLogin) throw new Error('Login falló: ' + errLogin.message)
    authed = createClient(URL, ANON, {
      global: { headers: { Authorization: `Bearer ${sesion.session.access_token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })
    console.log('2. Login OK — JWT authenticated activo (RLS aplicando)')

    // ── Fase A: carga inicial 2530 filas (2500 únicas + 30 duplicadas) ──
    console.log(`3. Fase A — merge de ${TOTAL + DUPLICADAS} filas del archivo (esperadas ${TOTAL} únicas):`)
    const archivo = construirArchivo()
    const rA = await mergeCatalogoReplica(archivo)
    const enBdA = await contarT16T()
    resultados.faseA = { ...rA, enBd: enBdA }
    console.log(`   → cargados=${rA.cargados}/${rA.totalUnicos} en BD=${enBdA}, errores=${rA.errores.length}, ${rA.ms}ms`)
    if (rA.errores.length) console.log('   errores:', rA.errores.slice(0, 3))

    // Verificación de contenido: duplicado debe conservar stock 999.99 (última aparición)
    const { data: dup } = await authed.from('catalogo').select('stock_big_magic').eq('codigo', `${PREFIJO}00000`).maybeSingle()
    const dupGano = dup && Number(dup.stock_big_magic) === 999.99
    console.log(`   dedupe intra-archivo (última aparición gana): ${dupGano ? 'OK (999.99)' : 'FALLO: ' + JSON.stringify(dup)}`)

    // ── Fase B: idempotencia — re-subida del mismo archivo (uso diario) ──
    console.log('4. Fase B — re-carga del mismo archivo (idempotencia):')
    const rB = await mergeCatalogoReplica(archivo)
    const enBdB = await contarT16T()
    resultados.faseB = { ...rB, enBd: enBdB }
    console.log(`   → cargados=${rB.cargados} en BD=${enBdB} (debe seguir siendo ${TOTAL}), errores=${rB.errores.length}, ${rB.ms}ms`)

    // ── Fase C: modo histórico — TODO en UNA petición (documentación del fallo) ──
    console.log('5. Fase C — modo antiguo: 2500 filas en UNA sola petición (evidencia del corte):')
    const { data: todos } = await authed.from('catalogo').select('codigo,un,descripcion,stock_big_magic').like('codigo', 'T16T%')
    const tC = Date.now()
    const kbC = Math.round(JSON.stringify(todos).length / 1024)
    try {
      const { error } = await conTimeout(
        authed.from('catalogo').upsert(todos.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'codigo' }),
        'upsert único 2500'
      )
      if (error) throw error
      resultados.faseC = { ok: true, kb: kbC, ms: Date.now() - tC }
      console.log(`   → RESULTADO: OK (${kbC}KB, ${Date.now() - tC}ms) — a 2500 filas una sola petición AÚN pasa; el corte histórico se agravaba con archivos mayores/red móvil.`)
    } catch (e) {
      resultados.faseC = { ok: false, kb: kbC, ms: Date.now() - tC, error: e.message }
      console.log(`   → RESULTADO: FALLO (${kbC}KB, ${Date.now() - tC}ms): ${e.message}`)
      console.log('     ↑ Esto confirma la causa raíz del corte histórico.')
    }

    // Resumen
    const pasoA = resultados.faseA.enBd === TOTAL && resultados.faseA.errores.length === 0
    const pasoB = resultados.faseB.enBd === TOTAL && resultados.faseB.errores.length === 0
    exito = pasoA && pasoB && (dupGano ?? false)
    console.log('\n════════ RESUMEN E2E ════════')
    console.log(`Fase A (carga >2000): ${pasoA ? 'PASA' : 'FALLA'}`)
    console.log(`Dedupe intra-archivo: ${dupGano ? 'PASA' : 'FALLA'}`)
    console.log(`Fase B (re-carga):    ${pasoB ? 'PASA' : 'FALLA'}`)
    console.log(`Fase C (modo antiguo): ${resultados.faseC.ok ? 'pasó (evidencia matizada)' : 'falló (confirma causa raíz)'}`)
    console.log(`VEREDICTO GLOBAL: ${exito ? 'EL FLUJO ACTUAL SOPORTA >2000 LÍNEAS' : 'REQUIERE ATENCIÓN'}`)
  } finally {
    // ── Limpieza total ──
    try {
      let borradas = 0
      for (let i = 0; i < 20; i++) {
        const { data: lote, error } = await authed
          .from('catalogo').delete().like('codigo', 'T16T%').select('codigo')
        if (error) { console.log('Limpieza error:', error.message); break }
        borradas += (lote ?? []).length
        if ((lote ?? []).length === 0) break
      }
      console.log(`Limpieza: ${borradas} filas T16T eliminadas`)
      const { count } = await authed.from('catalogo').select('codigo', { count: 'exact', head: true }).like('codigo', 'T16T%')
      console.log(`Residuo T16T en BD: ${count}`)
    } catch (e) { console.log('Limpieza filas error:', e.message) }
    try {
      if (usuarioId) {
        const { error } = await admin.auth.admin.deleteUser(usuarioId)
        console.log('Usuario temporal eliminado:', error ? error.message : 'OK')
      }
    } catch (e) { console.log('Limpieza usuario error:', e.message) }
  }
  if (!exito) process.exitCode = 1
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
