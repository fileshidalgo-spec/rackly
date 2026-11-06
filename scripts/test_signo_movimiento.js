/**
 * RACKLY — Tests de la convención de signos del Kardex de Racks (auditoría 2026-11-07).
 * Ejecutar: bash scripts/run_all_tests.sh (suite sin stub: módulos puros + fs)
 *
 * Contexto: la regla «ingreso/devolucion/traslado/stock_inicial suman; salida resta»
 * estaba copiada a mano en 11 sitios del frontend (kardex ×3, FEFO, Ocupación,
 * Stock ×3, Stock INC, Traslado, Descarga) además de 3 RPCs SQL. Ahora la fuente
 * única es MOVIMIENTOS_ENTRADA (constants.ts) vía esTipoEntrada()/impactoStock()
 * (utils.ts). Este suite fija el CONTRATO y añade un GUARD estático: el array
 * literal no puede volver a copiarse en src/ (si un tipo nuevo de entrada se
 * agrega, se hace SOLO en constants.ts y este suite lo propaga a todo el app).
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { esTipoEntrada, impactoStock } = require('@/lib/utils')
const { MOVIMIENTOS_ENTRADA } = require('@/lib/rackly/constants')

let ok = 0
function t(nombre, fn) {
  try {
    fn()
    ok++
    console.log('  ✓', nombre)
  } catch (e) {
    console.error('  ✗', nombre, '\n    ', e.message)
    process.exitCode = 1
  }
}

console.log('esTipoEntrada — contrato (fuente: MOVIMIENTOS_ENTRADA)')
t('ingreso → true', () => assert.strictEqual(esTipoEntrada('ingreso'), true))
t('devolucion → true', () => assert.strictEqual(esTipoEntrada('devolucion'), true))
t('traslado → true (fila de destino en movimientos)', () => assert.strictEqual(esTipoEntrada('traslado'), true))
t('stock_inicial → true', () => assert.strictEqual(esTipoEntrada('stock_inicial'), true))
t('salida → false (único tipo que resta)', () => assert.strictEqual(esTipoEntrada('salida'), false))
t('cadena vacía → false', () => assert.strictEqual(esTipoEntrada(''), false))
t('tipo desconocido → false (defensivo)', () => assert.strictEqual(esTipoEntrada('ajuste_inventarial'), false))
t('la lista canónica tiene exactamente los 4 tipos', () =>
  assert.deepStrictEqual([...MOVIMIENTOS_ENTRADA].sort(), ['devolucion', 'ingreso', 'stock_inicial', 'traslado']))

console.log('impactoStock — contrato')
t('ingreso suma', () => assert.strictEqual(impactoStock('ingreso', 10), 10))
t('devolucion suma', () => assert.strictEqual(impactoStock('devolucion', 40), 40))
t('traslado suma', () => assert.strictEqual(impactoStock('traslado', 560), 560))
t('stock_inicial suma', () => assert.strictEqual(impactoStock('stock_inicial', 1), 1))
t('salida resta', () => assert.strictEqual(impactoStock('salida', 20), -20))
t('decimales se preservan', () => assert.strictEqual(impactoStock('ingreso', 241.8), 241.8))
t('coherencia impactoStock ↔ esTipoEntrada para TODO tipo', () => {
  const tipos = ['ingreso', 'salida', 'devolucion', 'traslado', 'stock_inicial', 'otro']
  for (const tp of tipos) {
    const esperado = esTipoEntrada(tp) ? 7 : -7
    assert.strictEqual(impactoStock(tp, 7), esperado, `tipo ${tp}`)
  }
})

console.log('GUARD estático — el literal de tipos no se copia en src/')
t('0 ocurrencias del array literal fuera de constants.ts', () => {
  const LITERAL = "['ingreso', 'devolucion', 'traslado', 'stock_inicial']"
  const LITERAL_COMPACTO = "['ingreso','devolucion','traslado','stock_inicial']"
  const raiz = path.join(process.cwd(), 'src')
  const infracciones = []
  const visitar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { visitar(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      const txt = fs.readFileSync(p, 'utf8')
      const rel = path.relative(process.cwd(), p)
      if (txt.includes(LITERAL) || txt.includes(LITERAL_COMPACTO)) {
        // constants.ts es la FUENTE legítima de MOVIMIENTOS_ENTRADA
        if (!rel.replace(/\\/g, '/').endsWith('src/lib/rackly/constants.ts')) infracciones.push(rel)
      }
    }
  }
  visitar(raiz)
  assert.deepStrictEqual(infracciones, [], `copias encontradas: ${infracciones.join(', ')}`)
})
t('esTipoEntrada/impactoStock son los puntos de uso únicos (≥8 consumidores reales)', () => {
  const raiz = path.join(process.cwd(), 'src')
  let usos = 0
  const visitar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { visitar(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      usos += (fs.readFileSync(p, 'utf8').match(/esTipoEntrada\(|impactoStock\(/g) || []).length
    }
  }
  visitar(raiz)
  // utils.ts define 2; los llamadores (kardex, FEFO, Ocupación, Stock, Stock INC,
  // Traslado, Descarga) deben sumar al menos 8 usos adicionales.
  assert.ok(usos >= 10, `solo ${usos} usos — la deduplicación se revirtió?`)
})

console.log(`═══ RESULTADO: ${ok} checks OK ═══`)
if (process.exitCode) console.error('HUBO FALLOS')
