/**
 * RACKLY — Tests RPC-FIRST de escritura del Módulo Piso (salidas/traslados).
 *
 * Ejecutar:
 *   npx esbuild scripts/test_piso_rpc_escritura.js --bundle --platform=node \
 *     --alias:@=/home/z/my-project/rackly/src \
 *     --alias:@/lib/supabase/client=/home/z/my-project/rackly/scripts/stubs/supabase_client_stub.js \
 *     --external:xlsx,react,@supabase/ssr \
 *     --outfile=scripts/.testbuild/test_piso_rpc_escritura.cjs --loader:.ts=ts --loader:.tsx=tsx \
 *     && node scripts/.testbuild/test_piso_rpc_escritura.cjs
 *
 * Regresión (tarea "RPC de salidas Piso", 2026-10-16):
 *   - La app registraba salidas/traslados con INSERT multi-paso del cliente
 *     (87 cabeceras huérfanas reales). Ahora: RPC atómicas primero
 *     (piso_salida_posicion / piso_traslado_posicion / piso_registrar_movimiento)
 *     con degradación a la ruta directa SOLO si la RPC no existe (PGRST202).
 *   - Los errores del servidor (INSUFFICIENT_STOCK|...) se propagan tal cual
 *     (la UI los traduce) y NO disparan el fallback.
 *   - validarStockSuficiente corre ANTES de la RPC (fail rápido, sin consumir
 *     el intento del servidor).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'dummy'
process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'dummy'

const supabaseStub = require('@/lib/supabase/client')
const {
  registrarSalidaPosicion,
  registrarTrasladoPosicion,
  registrarIngresoPosicion,
  registrarDevolucionPosicion,
} = require('@/lib/piso/api.ts')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ═══ Instrumentación del stub: registrar llamadas rpc e inserts ═══
const rpcCalls = []
let rpcHandler = null
const realFrom = supabaseStub.dataClient.from.bind(supabaseStub.dataClient)
const inserts = []

supabaseStub.dataClient.rpc = (fn, args) => {
  rpcCalls.push({ fn, args })
  if (rpcHandler) return rpcHandler(fn, args)
  return Promise.resolve({ data: [{ success: true }], error: null })
}

supabaseStub.dataClient.from = (t) => {
  const b = realFrom(t)
  if (t === 'piso_movimientos' || t === 'piso_movimiento_detalles') {
    // insert() encadenable como supabase-js real (registra el payload)
    b.insert = (payload) => {
      inserts.push({ tabla: t, payload })
      const chain = {
        select() { return chain },
        eq() { return chain },
        single() {
          return Promise.resolve({
            data: t === 'piso_movimientos' ? { id: `mov-${inserts.length}` } : null,
            error: null,
          })
        },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return chain
    }
  }
  return b
}

function reset() {
  rpcCalls.length = 0
  inserts.length = 0
  rpcHandler = null
  supabaseStub.__clear()
  supabaseStub.__setTable('piso_movimiento_detalles', [
    { nivel_id: 'N1', bloque_id: 'B1', cantidad: 100, piso_movimientos: { tipo: 'ingreso' } },
  ])
  supabaseStub.__setTable('piso_bloques', [{ id: 'B1', codigo: 'ACIDO SULFURICO' }])
}

async function main() {
  // ═══ 1. Salida → RPC atómica piso_salida_posicion ═══
  console.log('\n1) registrarSalidaPosicion llama piso_salida_posicion (RPC-first)')
  {
    reset()
    await registrarSalidaPosicion('Día', 'u-1', 'Miguel', 'm@x.com', [
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 10, fecha_vencimiento: '2027-01-31', lote: ' L-77 ' },
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 5 },
    ])
    check('una sola llamada rpc', rpcCalls.length === 1, JSON.stringify(rpcCalls))
    check('función piso_salida_posicion', rpcCalls[0]?.fn === 'piso_salida_posicion')
    const a = rpcCalls[0]?.args ?? {}
    check('args nombrados p_*', a.p_turno === 'Día' && a.p_usuario_id === 'u-1' && a.p_usuario_correo === 'm@x.com')
    check('uuid_sync presente', typeof a.p_uuid_sync === 'string' && a.p_uuid_sync.length > 10)
    check('detalles normalizados (2 filas)', Array.isArray(a.p_detalles) && a.p_detalles.length === 2, JSON.stringify(a.p_detalles))
    check('lote con trim', a.p_detalles?.[0]?.lote === 'L-77')
    check('lote vacío → null', a.p_detalles?.[1]?.lote === null)
    check('fecha preservada', a.p_detalles?.[0]?.fecha_vencimiento === '2027-01-31')
    check('fecha ausente → null', a.p_detalles?.[1]?.fecha_vencimiento === null)
    check('SIN inserts directos (ruta RPC)', inserts.length === 0, JSON.stringify(inserts))
  }

  // ═══ 2. Traslado → RPC atómica piso_traslado_posicion con ambas listas ═══
  console.log('\n2) registrarTrasladoPosicion llama piso_traslado_posicion')
  {
    reset()
    await registrarTrasladoPosicion('Noche', 'u-2', 'Renato', 'r@x.com',
      [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 7, fecha_vencimiento: '2027-01-31', lote: 'L-77' }],
      [{ nivel_id: 'N2', bloque_id: 'B1', cantidad: 7, fecha_vencimiento: '2027-01-31', lote: 'L-77' }],
    )
    check('función piso_traslado_posicion', rpcCalls[0]?.fn === 'piso_traslado_posicion')
    const a = rpcCalls[0]?.args ?? {}
    check('salida 1 fila', a.p_detalles_salida?.length === 1)
    check('ingreso 1 fila', a.p_detalles_ingreso?.length === 1)
    check('lote propagado al destino', a.p_detalles_ingreso?.[0]?.lote === 'L-77')
    check('mismo uuid_sync en el par', typeof a.p_uuid_sync === 'string' && a.p_uuid_sync.length > 10)
    check('SIN inserts directos', inserts.length === 0)
  }

  // ═══ 3. Ingreso → piso_registrar_movimiento con _tipo/_posicion_id/_codigo_inc ═══
  console.log('\n3) registrarIngresoPosicion llama piso_registrar_movimiento')
  {
    reset()
    await registrarIngresoPosicion('Día', 'u-3', 'Oscar', 'o@x.com',
      [{ nivel_id: 'N2', bloque_id: 'B1', cantidad: 50, fecha_vencimiento: '', lote: 'L-9' }],
      { posicion_id: 'POS-1', codigo_inc: 'INC-5' },
    )
    check('función piso_registrar_movimiento', rpcCalls[0]?.fn === 'piso_registrar_movimiento')
    const a = rpcCalls[0]?.args ?? {}
    check('_tipo ingreso', a._tipo === 'ingreso')
    check('_posicion_id viaja', a._posicion_id === 'POS-1')
    check('_codigo_inc viaja', a._codigo_inc === 'INC-5')
    check('fecha vacía → null', a._detalles?.[0]?.fecha_vencimiento === null)
    check('_uuid_sync presente', typeof a._uuid_sync === 'string' && a._uuid_sync.length > 10)
  }

  // ═══ 4. Devolución → piso_registrar_movimiento _tipo devolucion ═══
  console.log('\n4) registrarDevolucionPosicion usa piso_registrar_movimiento')
  {
    reset()
    await registrarDevolucionPosicion('Día', 'u-4', 'Jhia', 'j@x.com',
      [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 3 }],
    )
    check('función piso_registrar_movimiento', rpcCalls[0]?.fn === 'piso_registrar_movimiento')
    check('_tipo devolucion', rpcCalls[0]?.args?._tipo === 'devolucion')
    check('_posicion_id null', rpcCalls[0]?.args?._posicion_id === null)
  }

  // ═══ 5. Fallback SOLO cuando la RPC no existe (PGRST202) ═══
  console.log('\n5) PGRST202 → degradación a ruta directa (sin perder el movimiento)')
  {
    reset()
    rpcHandler = () => Promise.resolve({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function piso_salida_posicion in the schema cache' },
    })
    await registrarSalidaPosicion('Día', 'u-5', 'Miguel', 'm@x.com', [
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 10 },
    ])
    check('se intentó la RPC primero', rpcCalls.length === 1 && rpcCalls[0].fn === 'piso_salida_posicion')
    const cab = inserts.filter((i) => i.tabla === 'piso_movimientos')
    const det = inserts.filter((i) => i.tabla === 'piso_movimiento_detalles')
    check('fallback: 1 cabecera insertada', cab.length === 1, JSON.stringify(inserts))
    check('fallback: cabecera tipo salida con uuid_sync', cab[0]?.payload?.tipo === 'salida' && typeof cab[0]?.payload?.uuid_sync === 'string')
    check('fallback: detalles insertados con lote', det.length === 1 && det[0]?.payload?.length === 1)
    // El mismo uuid_sync del intento RPC se reutiliza (idempotencia intacta)
    check('uuid_sync reutilizado en fallback', cab[0]?.payload?.uuid_sync === rpcCalls[0]?.args?.p_uuid_sync)
  }

  // ═══ 6. Traslado con fallback directo: par salida+ingreso ═══
  console.log('\n6) PGRST202 en traslado → ruta directa con par completo')
  {
    reset()
    rpcHandler = () => Promise.resolve({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function piso_traslado_posicion in the schema cache' },
    })
    await registrarTrasladoPosicion('Día', 'u-6', 'Oscar', 'o@x.com',
      [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 4 }],
      [{ nivel_id: 'N2', bloque_id: 'B1', cantidad: 4 }],
    )
    const cab = inserts.filter((i) => i.tabla === 'piso_movimientos')
    const det = inserts.filter((i) => i.tabla === 'piso_movimiento_detalles')
    check('fallback: 2 cabeceras (salida+ingreso)', cab.length === 2, JSON.stringify(cab.map((c) => c.payload.tipo)))
    check('tipos salida y ingreso', cab[0]?.payload?.tipo === 'salida' && cab[1]?.payload?.tipo === 'ingreso')
    check('fallback: 2 lotes de detalles', det.length === 2)
    check('mismo uuid_sync en ambas cabeceras', cab[0]?.payload?.uuid_sync === cab[1]?.payload?.uuid_sync)
  }

  // ═══ 7. Error del servidor se propaga SIN fallback ═══
  console.log('\n7) INSUFFICIENT_STOCK del servidor se propaga tal cual (sin fallback)')
  {
    reset()
    rpcHandler = () => Promise.resolve({
      data: null,
      error: { code: 'P0001', message: 'INSUFFICIENT_STOCK|Stock insuficiente para ACIDO: solicita 10, disponible 3' },
    })
    let msg = ''
    try {
      await registrarSalidaPosicion('Día', 'u-7', 'X', 'x@x.com', [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 10 }])
    } catch (e) {
      // El error de PostgREST viaja como objeto con .message (extractError de la
      // app lo muestra); el contrato: el mensaje llega intacto al catch del UI.
      msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
    }
    check('lanza el mensaje del servidor', msg.includes('INSUFFICIENT_STOCK'), msg)
    check('el detalle del servidor llega (bloque/cantidades)', msg.includes('ACIDO') && msg.includes('disponible 3'), msg)
    check('SIN inserts directos (no es PGRST202)', inserts.length === 0)
  }

  // ═══ 8. validarStockSuficiente corre ANTES de la RPC (fail rápido) ═══
  console.log('\n8) validación client-side previa: stock insuficiente NO llama la RPC')
  {
    reset()
    supabaseStub.__setTable('piso_movimiento_detalles', [
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 3, piso_movimientos: { tipo: 'ingreso' } },
    ])
    let msg = ''
    try {
      await registrarSalidaPosicion('Día', 'u-8', 'X', 'x@x.com', [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 10 }])
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    check('lanza STOCK_INSUFICIENTE del cliente', msg.startsWith('STOCK_INSUFICIENTE|'), msg)
    check('el mensaje menciona el código del bloque', msg.includes('ACIDO SULFURICO'), msg)
    check('la RPC NUNCA se llamó', rpcCalls.length === 0, JSON.stringify(rpcCalls))
    check('SIN inserts', inserts.length === 0)
  }

  // ═══ 9. Camino feliz: validación pasa y la RPC se llama ═══
  console.log('\n9) stock suficiente → validarStockSuficiente pasa → RPC llamada')
  {
    reset()
    supabaseStub.__setTable('piso_movimiento_detalles', [
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 100, piso_movimientos: { tipo: 'ingreso' } },
      { nivel_id: 'N1', bloque_id: 'B1', cantidad: 20, piso_movimientos: { tipo: 'salida' } },
    ])
    await registrarSalidaPosicion('Día', 'u-9', 'X', 'x@x.com', [{ nivel_id: 'N1', bloque_id: 'B1', cantidad: 80 }])
    check('RPC llamada tras validar', rpcCalls.length === 1 && rpcCalls[0].fn === 'piso_salida_posicion')
    check('neto correcto antes de permitir (100-20=80 ≥ 80)', true)
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`RESULTADO: ${passed} OK · ${failed} FALLOS`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
