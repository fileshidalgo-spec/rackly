#!/usr/bin/env node
/**
 * RACKLY — E2E REAL en la BD de producción (datos sintéticos + limpieza):
 * RPCs v2 de editar lote/vencimiento — completar (v1) y corregir (v2).
 * Uso: node scripts/e2e_editar_lote_v2.js
 *
 * Módulos probados: Racks (movimientos) y Piso (piso_movimiento_detalles).
 * Toda fila sintética usa marcador 'E2E-V2' y se borra al final (siempre).
 */
const PROJECT_REF = 'owjryvcrhpmgtkkdcrkm';
const MAPI_TOKEN = process.env.SUPABASE_MAPI_TOKEN;
if (!MAPI_TOKEN) { console.error('Falta SUPABASE_MAPI_TOKEN en el entorno.'); process.exit(1); }

async function query(sql, expectError = false) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MAPI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok || (body && typeof body === 'object' && !Array.isArray(body) && body.error)) {
    const msg = (body && body.error) ? body.error : `HTTP ${res.status}: ${text.slice(0, 300)}`
    if (expectError) return { error: msg }
    throw new Error(msg)
  }
  if (expectError) return { error: null, data: body }
  return { error: null, data: body }
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const UB = { bloque: 'E2E-V2', torre: '1', piso: '1', posicion: '01', codigo: 'E2E-V2-ART' };

async function main() {
  console.log('═══════ E2E Racks: editar_lote_vencimiento_racks v2 ═══════')
  // 0. Limpieza preventiva
  await query(`DELETE FROM movimientos WHERE bloque='${UB.bloque}'`)

  // 1. Datos sintéticos: fila A (lote MAL + fecha), fila B (sin lote ni fecha)
  // usuario_id: FK a auth.users → se usa un id real existente (read-only)
  const uq = await query(`SELECT id::text AS id FROM auth.users LIMIT 1`)
  const UID = uq.data?.[0]?.id
  if (!UID) throw new Error('No hay usuarios en auth.users para la FK')
  await query(`INSERT INTO movimientos (tipo, bloque, torre, piso, posicion, codigo, descripcion, un, cantidad, f_vencimiento, turno, usuario_id, usuario_nombre, usuario_correo, proveedor, lote, f_modificacion) VALUES
    ('ingreso','${UB.bloque}','${UB.torre}','${UB.piso}','${UB.posicion}','${UB.codigo}','Articulo E2E v2','UN',7,'2030-01-15','DIA','${UID}','E2E','e2e@rackly.test','E2E-PROV','E2E-L-MAL', now()),
    ('ingreso','${UB.bloque}','${UB.torre}','${UB.piso}','${UB.posicion}','${UB.codigo}','Articulo E2E v2','UN',3,NULL,'DIA','${UID}','E2E','e2e@rackly.test','E2E-PROV',NULL, now())`)
  console.log('  · Insertadas 2 filas sintéticas (A: E2E-L-MAL/2030-01-15 · B: sin datos)')

  // 2. v2 — CORRECCIÓN del bucket (E2E-L-MAL, 2030-01-15) → (E2E-L-BIEN, 2031-12-31)
  const r1 = await query(`SELECT editar_lote_vencimiento_racks('${UB.bloque}','${UB.torre}','${UB.piso}','${UB.posicion}','${UB.codigo}','E2E-L-BIEN','2031-12-31','E2E-L-MAL','2030-01-15') AS r`)
  check('corrección v2 → filas_actualizadas=1', r1.data?.[0]?.r?.filas_actualizadas === 1, JSON.stringify(r1.data))
  const vA = await query(`SELECT lote, f_vencimiento::text AS f FROM movimientos WHERE bloque='${UB.bloque}' AND lote='E2E-L-BIEN'`)
  check('fila A re-etiquetada (lote + fecha nuevos)', vA.data?.length === 1 && vA.data[0].f === '2031-12-31')

  // 3. v1 — COMPLETAR el bucket vacío (sin p_*_actual → default NULL)
  const r2 = await query(`SELECT editar_lote_vencimiento_racks('${UB.bloque}','${UB.torre}','${UB.piso}','${UB.posicion}','${UB.codigo}','E2E-L-NUEVO','2031-06-30') AS r`)
  check('completar v1 (retrocompatible) → filas_actualizadas=1', r2.data?.[0]?.r?.filas_actualizadas === 1, JSON.stringify(r2.data))
  const vB = await query(`SELECT count(*)::int AS n FROM movimientos WHERE bloque='${UB.bloque}' AND lote='E2E-L-NUEVO' AND f_vencimiento::text='2031-06-30'`)
  check('fila B completada con lote/fecha', vB.data?.[0]?.n === 1)

  // 4. Re-edición del mismo bucket → SIN_FILAS
  const r3 = await query(`SELECT editar_lote_vencimiento_racks('${UB.bloque}','${UB.torre}','${UB.piso}','${UB.posicion}','${UB.codigo}','X','2032-01-01','E2E-L-MAL','2030-01-15') AS r`, true)
  check('re-edición → SIN_FILAS (el bucket ya se corrigió)', /SIN_FILAS/.test(r3.error ?? ''))

  // 5. Saldo global intacto (7 + 3 = 10; cantidad NUNCA se toca)
  const vS = await query(`SELECT COALESCE(SUM(cantidad),0)::float8 AS s FROM movimientos WHERE bloque='${UB.bloque}' AND codigo='${UB.codigo}'`)
  check('saldo global intacto (10)', vS.data?.[0]?.s === 10, String(vS.data?.[0]?.s))

  // 6. Limpieza
  await query(`DELETE FROM movimientos WHERE bloque='${UB.bloque}'`)
  const vC = await query(`SELECT count(*)::int AS n FROM movimientos WHERE bloque='${UB.bloque}'`)
  check('limpieza Racks (0 filas restantes)', vC.data?.[0]?.n === 0)

  console.log('═══════ E2E Piso: editar_lote_vencimiento_piso v2 ═══════')
  // 0. Limpieza preventiva por IDs sintéticos (orden inverso de FKs, tolerante a ausencia)
  await query(`
    DELETE FROM piso_movimiento_detalles WHERE movimiento_id='66666666-6666-6666-6666-666666666666';
    DELETE FROM piso_movimientos WHERE id='66666666-6666-6666-6666-666666666666';
    DELETE FROM piso_niveles WHERE id='44444444-4444-4444-4444-444444444444';
    DELETE FROM piso_posiciones WHERE id='33333333-3333-3333-3333-333333333333';
    DELETE FROM piso_subcolumnas WHERE id='88888888-8888-8888-8888-888888888888';
    DELETE FROM piso_columnas WHERE id='22222222-2222-2222-2222-222222222222';
    DELETE FROM piso_sectores WHERE id='11111111-1111-1111-1111-111111111111';
    DELETE FROM piso_bloques WHERE id='55555555-5555-5555-5555-555555555555';
    DELETE FROM piso_bloques WHERE codigo='E2E-V2-B';`)
  console.log('  · (limpieza previa OK)')

  // 1. Cadena sintética: sector → columna → posición → nivel + bloque + movimiento + detalles
  await query(`
    INSERT INTO piso_sectores (id, nombre, prefijo, n_columnas, n_subcolumnas) VALUES ('11111111-1111-1111-1111-111111111111','E2E Sector V2','E2E',1,0)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_columnas (id, letra, sector_id) VALUES ('22222222-2222-2222-2222-222222222222','E2E','11111111-1111-1111-1111-111111111111') ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_subcolumnas (id, codigo, columna_id) VALUES ('88888888-8888-8888-8888-888888888888','E2E-SUB','22222222-2222-2222-2222-222222222222') ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_posiciones (id, numero, subcolumna_id) VALUES ('33333333-3333-3333-3333-333333333333', 9901, '88888888-8888-8888-8888-888888888888') ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_niveles (id, numero, posicion_id, codigo_ubicacion) VALUES ('44444444-4444-4444-4444-444444444444', 1, '33333333-3333-3333-3333-333333333333','E2E-V2-N1') ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_bloques (id, codigo, descripcion, unidad) VALUES ('55555555-5555-5555-5555-555555555555','E2E-V2-B','Bloque E2E v2','KG') ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_movimientos (id, tipo, fecha, turno, usuario_id, usuario_nombre, usuario_correo, posicion_id) VALUES
      ('66666666-6666-6666-6666-666666666666','ingreso', now(),'DIA','${UID}','E2E','e2e@rackly.test','33333333-3333-3333-3333-333333333333')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO piso_movimiento_detalles (id, movimiento_id, nivel_id, bloque_id, cantidad, fecha_vencimiento, lote) VALUES
      ('77777777-7777-7777-7777-777777777771','66666666-6666-6666-6666-666666666666','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555', 4, '2030-03-15','E2E-P-MAL'),
      ('77777777-7777-7777-7777-777777777772','66666666-6666-6666-6666-666666666666','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555', 2, NULL, NULL)
    ON CONFLICT (id) DO NOTHING;`)
  console.log('  · Cadena sintética Piso creada (detalle A: E2E-P-MAL/2030-03-15 · detalle B: sin datos)')

  // 2. v2 — corrección del bucket (E2E-P-MAL, 2030-03-15) → (E2E-P-BIEN, 2031-09-30)
  const p1 = await query(`SELECT editar_lote_vencimiento_piso('33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','E2E-P-BIEN','2031-09-30','E2E-P-MAL','2030-03-15') AS r`)
  check('corrección v2 Piso → filas_actualizadas=1', p1.data?.[0]?.r?.filas_actualizadas === 1, JSON.stringify(p1.data))
  const pv = await query(`SELECT count(*)::int AS n FROM piso_movimiento_detalles WHERE bloque_id='55555555-5555-5555-5555-555555555555' AND lote='E2E-P-BIEN' AND fecha_vencimiento::text='2031-09-30'`)
  check('detalle A corregido en Piso', pv.data?.[0]?.n === 1)

  // 3. v1 retrocompatible — completar el bucket vacío en Piso
  const p2 = await query(`SELECT editar_lote_vencimiento_piso('33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','E2E-P-NUEVO','2031-04-01') AS r`)
  check('completar v1 Piso (retrocompatible) → filas_actualizadas=1', p2.data?.[0]?.r?.filas_actualizadas === 1, JSON.stringify(p2.data))

  // 4. Limpieza total (orden inverso de dependencias)
  await query(`
    DELETE FROM piso_movimiento_detalles WHERE movimiento_id='66666666-6666-6666-6666-666666666666';
    DELETE FROM piso_movimientos WHERE id='66666666-6666-6666-6666-666666666666';
    DELETE FROM piso_niveles WHERE id='44444444-4444-4444-4444-444444444444';
    DELETE FROM piso_posiciones WHERE id='33333333-3333-3333-3333-333333333333';
    DELETE FROM piso_subcolumnas WHERE id='88888888-8888-8888-8888-888888888888';
    DELETE FROM piso_columnas WHERE id='22222222-2222-2222-2222-222222222222';
    DELETE FROM piso_sectores WHERE id='11111111-1111-1111-1111-111111111111';
    DELETE FROM piso_bloques WHERE id='55555555-5555-5555-5555-555555555555';`)
  const pc = await query(`SELECT count(*)::int AS n FROM piso_movimiento_detalles WHERE bloque_id='55555555-5555-5555-5555-555555555555'`)
  check('limpieza Piso (0 detalles restantes)', pc.data?.[0]?.n === 0)

  console.log('────────────────────────────')
  console.log(`E2E editar_lote_v2: ${passed} OK · ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1) })
