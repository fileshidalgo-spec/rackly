#!/bin/bash
# ═══════════════════════════════════════════════════════
# RACKLY - Pipeline de Despliegue Automático
# GitHub → Cloudflare Pages
# ═══════════════════════════════════════════════════════

set -e

echo "☁️  RACKLY - Pipeline CI/CD"
echo "════════════════════════════════════════"

# 1. Build del proyecto
echo ""
echo "📦 Paso 1/3: Build del proyecto..."
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
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "⚠️  CLOUDFLARE_API_TOKEN no configurado"
  echo "   El despliegue a Cloudflare se hará automáticamente por webhook."
  echo ""
  echo "   Para despliegue directo desde CLI, configura:"
  echo "   export CLOUDFLARE_API_TOKEN=tu_token_aqui"
  exit 0
fi

npx wrangler pages deploy out --project-name=rackly
echo ""
echo "✅ ¡Despliegue completado!"
echo "════════════════════════════════════════"
