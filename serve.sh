#!/usr/bin/env bash
# serve.sh — sobe um servidor HTTP local pra abrir o painel.
# file:// quebra fetch(); precisa de um server.
#
# Uso: shared/dashboard/serve.sh [porta]

set -euo pipefail
PORT="${1:-8765}"
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "→ Painel: http://localhost:$PORT"
echo "  Ctrl+C pra encerrar."
echo

# Gera dados se ainda não existirem
if [[ ! -f data/state.json ]]; then
  echo "ℹ data/state.json não encontrado, gerando..."
  ../scripts/build-dashboard-data.sh
  echo
fi

# Abre no navegador padrão (macOS)
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "http://localhost:$PORT") &
fi

exec python3 -m http.server "$PORT"
