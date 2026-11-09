/**
 * RACKLY · Tests REPUESTOS — Tipos y helpers puros (rep-tipos + normalización).
 *
 * Cubre: códigos normalizados de ubicación (4 tipos), lados por tipo,
 * capacidad de lonchera, normalización de códigos de artículo y las
 * etiquetas del dominio. Sin red, sin stub: módulos puros.
 */
const assert = require('node:assert')
const {
  repCodigoUbicacion,
  repLadosDeTipo,
  REP_MAX_ARTICULOS_LONCHERA,
  REP_ETIQUETA_TIPO,
  REP_ETIQUETA_MOV,
} = require('@/lib/rackly/rep/rep-tipos')

let n = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`FALLO #${++n}: ${msg}`)
  n++
}

// ── Códigos normalizados (la misma regla que rotulará el QR) ──
ok(repCodigoUbicacion('rack', 1, 3, 5) === 'R-P1-N3-P05', 'rack → R-P1-N3-P05 (secuencia 2 dígitos)')
ok(repCodigoUbicacion('rack', 2, 10, 15) === 'R-P2-N10-P15', 'rack nivel/secuencia de 2 dígitos')
ok(repCodigoUbicacion('pasillo', 1, 0, 1) === 'PAS-P1-01', 'pasillo → PAS-P1-01 (nivel 0 implícito)')
ok(repCodigoUbicacion('pasillo', 1, 0, 12) === 'PAS-P1-12', 'pasillo secuencia 12')
ok(repCodigoUbicacion('zona', 1, 3, 2) === 'Z-P1-N3-02', 'zona → Z-P1-N3-02')
ok(repCodigoUbicacion('prepicking', 1, 1, 1) === 'PP-P1-N1', 'prepicking → PP-P1-N1 (sin posición)')

// ── Lados por tipo: rack = A+B; resto = A ──
ok(JSON.stringify(repLadosDeTipo('rack')) === JSON.stringify(['A', 'B']), 'rack tiene 2 lados A y B')
ok(JSON.stringify(repLadosDeTipo('pasillo')) === JSON.stringify(['A']), 'pasillo solo lado A')
ok(JSON.stringify(repLadosDeTipo('zona')) === JSON.stringify(['A']), 'zona solo lado A')
ok(JSON.stringify(repLadosDeTipo('prepicking')) === JSON.stringify(['A']), 'prepicking solo lado A')

// ── Constantes de dominio ──
ok(REP_MAX_ARTICULOS_LONCHERA === 15, 'capacidad de lonchera = 15 artículos distintos')
ok(REP_ETIQUETA_TIPO.rack === 'Rack', 'etiqueta tipo rack')
ok(REP_ETIQUETA_MOV.ingreso === 'Ingreso', 'etiqueta movimiento ingreso')
ok(REP_ETIQUETA_MOV.devolucion === 'Devolución', 'etiqueta movimiento devolución (con tilde)')

// ── Contrato de vistas del hub (prefijo rep- evita colisión con Insumos) ──
const { esVistaRep, repVistaDeHub, REP_VISTAS_HUB } = require('@/lib/rackly/rep/rep-vistas')
ok(REP_VISTAS_HUB.length === 6, '6 vistas rep en el hub')
ok(esVistaRep('rep-recepcion'), 'rep-recepcion ES vista rep')
ok(!esVistaRep('recepcion'), 'recepcion (Insumos) NO es vista rep')
ok(!esVistaRep('usuarios'), 'usuarios no es vista rep')
ok(repVistaDeHub('rep-catalogo') === 'catalogo', 'repVistaDeHub quita el prefijo')

console.log(`OK test_rep_tipos — ${n} aserciones`)
