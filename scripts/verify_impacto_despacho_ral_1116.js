#!/usr/bin/env node
/** RACKLY — Medición del impacto de quitar la pestaña Despacho RAL (solo lectura). */
const TOKEN = process.env.SUPABASE_MAPI_TOKEN
const REF = 'owjryvcrhpmgtkkdcrkm'
const SQL = `
select
  (select count(*) from public.rep_ral where estado='registrado')                 as rals_registrados,
  (select count(*) from public.rep_ral where estado='despachado')                 as rals_despachados,
  (select count(*) from public.rep_ral where estado='registrado'
     and created_at > now() - interval '14 days')                                 as rals_registrados_recientes,
  (select count(*) from public.rep_stock where ral_id is not null)                as rep_stock_estacionado,
  (select count(*) from public.rep_movimientos where tipo='salida'
     and created_at > now() - interval '30 days')                                 as salidas_rep_30d`
async function main() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  })
  const t = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`)
  console.log('== Impacto de quitar Despacho RAL (producción) ==')
  console.log(JSON.stringify(JSON.parse(t)[0], null, 1))
}
main().catch((e) => { console.error(e.message); process.exit(1) })
