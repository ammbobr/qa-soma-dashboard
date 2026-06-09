#!/usr/bin/env bash
# serve.sh — sobe o servidor HTTP local pro painel (com endpoints de triagem).
# Delega pra serve.py que expõe POST /api/override e /api/rebuild além do estático.
#
# Uso: shared/dashboard/serve.sh [porta]

set -euo pipefail
PORT="${1:-8765}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

exec python3 "$SCRIPT_DIR/serve.py" "$PORT"
