/**
 * RACKLY — Tests unitarios de recorte-marco.ts (geometría del recorte).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_recorte_marco.js --bundle --platform=node --external:xlsx,react,@supabase/ssr --outfile=scripts/.testbuild/recorte_marco.cjs --alias:@=/home/z/my-project/rackly/src --loader:.ts=ts && node scripts/.testbuild/recorte_marco.cjs
 *
 * Escenarios:
 *   1. marcoInicial: aspect vertical/horizontal/cuadrado/libre, margen, clamp.
 *   2. moverMarco: recorrido completo y clamps a la imagen.
 *   3. redimensionarMarco: 4 esquinas, aspecto fijo, Libre, minLado, clamps.
 *   4. rectANatural: display → naturales.
 *   5. rotarRect90Horario: el marco acompaña el giro (w↔h, dentro de límites).
 *   6. escalaPorArea: fotos de 12/48 MP contra el techo de canvas.
 *
 * REGRESIÓN clave (pedido 2026-10): con una foto vertical 3:4 y aspecto
 * Vertical, el marco SIEMPRE se puede mover y redimensionar (antes, con
 * react-easy-crop, el recorrido era CERO y "no dejaba recortar").
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const {
  marcoInicial,
  moverMarco,
  redimensionarMarco,
  rectANatural,
  rotarRect90Horario,
  escalaPorArea,
  MIN_LADO_MARCO,
} = require('@/lib/rackly/recorte-marco')

let pasados = 0
let fallidos = 0

function check(nombre, cond, detalle = '') {
  if (cond) {
    pasados++
    console.log(`  ✓ ${nombre}`)
  } else {
    fallidos++
    console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`)
  }
}

const red = (r, d = 3) =>
  JSON.stringify({ x: +r.x.toFixed(d), y: +r.y.toFixed(d), w: +r.w.toFixed(d), h: +r.h.toFixed(d) })

const dentro = (r, W, H) =>
  r.x >= -0.001 && r.y >= -0.001 && r.x + r.w <= W + 0.001 && r.y + r.h <= H + 0.001

// ─── 1. marcoInicial ───
console.log('\n[1] marcoInicial — marco centrado con margen')
const m1 = marcoInicial(1000, 1000, 1) // cuadrado en cuadrada
check('cuadrado en imagen cuadrada: centrado y con margen', Math.abs(m1.x - m1.y) < 0.01 && m1.w === m1.h && m1.w < 1000, red(m1))
const mV = marcoInicial(3000, 4000, 3 / 4) // vertical en foto vertical
check('vertical 3/4 en foto 3:4: encaja y conserva aspecto', Math.abs(mV.w / mV.h - 0.75) < 0.01 && dentro(mV, 3000, 4000), red(mV))
const mH = marcoInicial(4000, 3000, 3 / 4) // vertical en foto horizontal
check('vertical 3/4 en foto 4:3: limitado por el ALTO', Math.abs(mV.w / mV.h - 0.75) < 0.01 && Math.abs(mH.h - mH.h) < 0.01 && dentro(mH, 4000, 3000) && mH.h < 3000 * 0.87, red(mH))
const mL = marcoInicial(2000, 2000, 0) // Libre usa el aspect de la imagen
check('Libre (0) usa el aspect de la imagen', Math.abs(mL.w / mL.h - 1) < 0.01, red(mL))
check('el marco nunca cubre TODA la imagen (margen visible)', m1.w < 1000 && m1.h < 1000)

// ─── 2. moverMarco ───
console.log('\n[2] moverMarco — recorrido completo + clamps')
const base = { x: 100, y: 100, w: 300, h: 400 }
const mv1 = moverMarco(base, 2000, 2000, 50, -30)
check('mueve por el delta pedido', red(mv1) === red({ x: 150, y: 70, w: 300, h: 400 }), red(mv1))
const mv2 = moverMarco(base, 2000, 2000, 99999, -99999)
check('clamp: no se sale por la derecha ni por arriba', mv2.x === 1700 && mv2.y === 0, red(mv2))
const mv3 = moverMarco(base, 2000, 2000, -99999, 99999)
check('clamp: no se sale por la izquierda ni por abajo', mv3.x === 0 && mv3.y === 1600, red(mv3))
// REGRESIÓN clave: foto 3:4 + aspecto vertical → el marco SIEMPRE tiene recorrido
const fotoVertical = marcoInicial(3000, 4000, 3 / 4)
const movida = moverMarco(fotoVertical, 3000, 4000, 120, 90)
check('REGRESIÓN foto vertical 3/4: el marco SÍ se mueve (no queda clavado)', movida.x !== fotoVertical.x || movida.y !== fotoVertical.y, `${red(fotoVertical)} → ${red(movida)}`)

// ─── 3. redimensionarMarco ───
console.log('\n[3] redimensionarMarco — esquinas, aspecto, clamps')
const r0 = { x: 100, y: 100, w: 400, h: 300 } // aspecto 4/3
// SE crece (aspecto fijo): la esquina NW (100,100) queda fija
const rs = redimensionarMarco(r0, 4000, 3000, 'se', 200, 150, 4 / 3)
check('SE con aspecto: ancla fija en la esquina opuesta', rs.x === 100 && rs.y === 100, red(rs))
check('SE con aspecto: conserva 4/3 tras el arrastre', Math.abs(rs.w / rs.h - 4 / 3) < 0.01, red(rs))
check('SE creció con la diagonal dominante', rs.w === 600 && Math.abs(rs.h - 450) < 0.01, red(rs))
// NW encoge: la esquina SE (500,400) queda fija
const rn = redimensionarMarco(r0, 4000, 3000, 'nw', 100, 75, 4 / 3)
check('NW encogiendo: la esquina SE queda fija', Math.abs(rn.x + rn.w - 500) < 0.01 && Math.abs(rn.y + rn.h - 400) < 0.01, red(rn))
check('NW encogiendo conserva aspecto', Math.abs(rn.w / rn.h - 4 / 3) < 0.01, red(rn))
// clamp a la imagen: SE hasta el borde no pasa de 4000
const rMax = redimensionarMarco(r0, 2000, 1500, 'se', 99999, 99999, 4 / 3)
check('SE no sale de la imagen', dentro(rMax, 2000, 1500) && rMax.x + rMax.w <= 2000 && rMax.y + rMax.h <= 1500, red(rMax))
// minLado: encoger en SE hasta el mínimo
const rMin = redimensionarMarco(r0, 4000, 3000, 'se', -99999, -99999, 4 / 3)
check('encoger hasta minLado sin colapsar', rMin.w >= MIN_LADO_MARCO && rMin.h >= MIN_LADO_MARCO, red(rMin))
// Libre (aspecto 0): w y h independientes
const rL = redimensionarMarco(r0, 4000, 3000, 'se', 200, 10, 0)
check('Libre: w y h responden por separado', rL.w === 600 && rL.h === 310, red(rL))
// aspecto vertical 3/4 desde una esquina, en foto vertical: sin salirse
const fv = marcoInicial(3000, 4000, 3 / 4)
const fv2 = redimensionarMarco(fv, 3000, 4000, 'se', 500, 500, 3 / 4)
check('aspecto 3/4 en foto 3:4 crece clamped sin deformarse', dentro(fv2, 3000, 4000) && Math.abs(fv2.w / fv2.h - 0.75) < 0.01, red(fv2))

// ─── 4. rectANatural ───
console.log('\n[4] rectANatural — display → naturales')
const nat = rectANatural({ x: 50, y: 25, w: 100, h: 50 }, 200, 100, 2000, 1000)
check('escala x2: 50,25,100,50 → 500,250,1000,500', red(nat) === red({ x: 500, y: 250, w: 1000, h: 500 }), red(nat))
const nat0 = rectANatural({ x: 10, y: 10, w: 10, h: 10 }, 0, 0, 1000, 1000)
check('display 0 (aún sin medir): no revienta (escala 1)', nat0.x === 10 && nat0.w === 10, red(nat0))

// ─── 5. rotarRect90Horario ───
console.log('\n[5] rotarRect90Horario — el marco acompaña el giro')
const rR = { x: 200, y: 100, w: 300, h: 200 }
const rot = rotarRect90Horario(rR, 1000) // imagen 1000 de alto → girada 1000 de ancho
check('rect acompaña el giro 90° (x = H − y − h, w↔h)', rot.x === 700 && rot.y === 200 && rot.w === 200 && rot.h === 300, red(rot))
check('el rect girado queda dentro de las dims giradas (H×W)', dentro(rot, 1000, 1500))
const rot2 = rotarRect90Horario(rot, 1500)
check('aplicado 2× = 180° vuelve a las dims originales coherentes', rot2.w === 300 && rot2.h === 200, red(rot2))

// ─── 6. escalaPorArea ───
console.log('\n[6] escalaPorArea — techo de canvas en móvil')
check('12 MP (4032×3024) pasa sin escala', escalaPorArea(4032, 3024) === 1)
const e48 = escalaPorArea(8064, 6048) // 48.7 Mpx > 16 Mpx
check('48 MP se escala para caber en el techo', e48 < 1 && Math.abs(8064 * e48 * 6048 * e48 - 16_000_000) < 1000, String(e48))
check('área 0 no revienta', escalaPorArea(0, 0) === 1)

// ─── Resumen ───
console.log(`\n════════ RESULTADO: ${pasados} pasados, ${fallidos} fallidos ════════`)
process.exit(fallidos > 0 ? 1 : 0)
