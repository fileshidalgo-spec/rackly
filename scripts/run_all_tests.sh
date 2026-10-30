#!/usr/bin/env bash
# RACKLY — Corre TODA la suite de tests (esbuild bundle → node).
# Uso: bash scripts/run_all_tests.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p scripts/.testbuild
# Suites que requieren el STUB de Supabase (no tocan red) — ver cabecera de cada test.
CON_STUB="test_piso_fefo test_piso_navegacion test_piso_rpc_escritura test_recepcion_chunk test_editar_lote test_piso_catalogo_unico test_catalogo_masivo test_rq_crear_rpc test_rq_editar_rpc test_rq_tomas_revisar test_rq_turno_hoja test_rq_busqueda_or test_atencion_reporte test_ral_unificado test_recepcion_delete_honesto test_recepcion_filas test_recepcion_devoluciones test_eliminacion_honesta_global test_regularizacion"
PASS=0; FAIL=0; FAILED=""
for t in scripts/test_*.js scripts/test_*.mjs; do
  name=$(basename "$t"); name="${name%.*}"
  out="scripts/.testbuild/${name}.cjs"
  extra=""
  for s in $CON_STUB; do [ "$name" = "$s" ] && extra="--alias:@/lib/supabase/client=./scripts/stubs/supabase_client_stub.js --external:xlsx,react,@supabase/ssr --loader:.tsx=tsx"; done
  if ! npx esbuild "$t" --bundle --platform=node --outfile="$out" --alias:@=./src --loader:.ts=ts $extra --log-level=error 2> "scripts/.testbuild/${name}.build.log"; then
    FAIL=$((FAIL+1)); FAILED="$FAILED $name(build)"; continue
  fi
  if node "$out" > "scripts/.testbuild/${name}.out.log" 2>&1; then
    PASS=$((PASS+1)); echo "OK   $name  ($(tail -1 "scripts/.testbuild/${name}.out.log" | head -c 120))"
  else
    FAIL=$((FAIL+1)); FAILED="$FAILED $name"; echo "FAIL $name"; tail -20 "scripts/.testbuild/${name}.out.log"
  fi
done
echo "──────────────────────────────"
echo "Suites: $PASS OK · $FAIL FAIL${FAILED:+ →$FAILED}"
[ "$FAIL" -eq 0 ]
