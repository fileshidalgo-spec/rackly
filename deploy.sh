#!/bin/bash
# ═══════════════════════════════════════════════════════
# RACKLY - Deploy automático: GitHub → Cloudflare Pages
# ═══════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Cargar credenciales
if [ -f "$SCRIPT_DIR/.cf.env" ]; then
  source "$SCRIPT_DIR/.cf.env"
  export CLOUDFLARE_API_TOKEN
  export CLOUDFLARE_ACCOUNT_ID
fi

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "❌ Error: CLOUDFLARE_API_TOKEN no configurado en .cf.env"
  exit 1
fi

cd "$SCRIPT_DIR"

echo ""
echo "☁️  RACKLY - Pipeline de Despliegue Automático"
echo "════════════════════════════════════════════════"

# 1. Build con variables de entorno inyectadas
echo ""
echo "📦 Paso 1/3: Build del proyecto..."
NEXT_PUBLIC_SUPABASE_URL="https://owjryvcrhpmgtkkdcrkm.supabase.co" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93anJ5dmNyaHBtZ3Rra2RjcmttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTEwODUsImV4cCI6MjA5NDc2NzA4NX0.txneI_FZQhC782QYCW3jQ8WEIif_0xUZR-6esqy0aTg" \
npm run build
echo "✅ Build completado"

# 2. Commit y push a GitHub
echo ""
echo "📦 Paso 2/3: Subiendo a GitHub..."
git add -A
if git diff --cached --quiet; then
  echo "⏭️  No hay cambios nuevos para subir"
else
  git commit -m "deploy: actualización automática $(date '+%Y-%m-%d %H:%M')"
  git push
  echo "✅ Push a GitHub completado"
fi

# 3. Deploy a Cloudflare Pages
echo ""
echo "📦 Paso 3/3: Desplegando a Cloudflare Pages..."
npx wrangler pages deploy out --project-name=rackly --branch=main --commit-dirty=true

echo ""
echo "✅ ¡Despliegue completado en https://rackly.pages.dev !"
echo "════════════════════════════════════════════════"
