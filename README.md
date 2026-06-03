# QA Soma — Dashboard

Painel web do projeto QA Produtos Digitais Soma. Mostra status das suítes Maestro multi-brand (NV, Reserva) em tempo real após cada run.

## Online

Painel publicado via GitHub Pages: <https://ammbobr.github.io/qa-soma-dashboard/>

## Local

```bash
# Da raiz do projeto QA:
shared/dashboard/serve.sh 8765
```

Abre automaticamente em `http://localhost:8765`.

## Como atualizar (após rodar suite)

```bash
shared/scripts/publish-dashboard.sh
```

Esse script gera os JSONs de status (`build-dashboard-data.sh`), commita as mudanças em `data/` e dá push — o GitHub Actions republica o Pages em ~30s.

## Stack

- HTML/CSS/JS vanilla + Alpine.js (CDN)
- Servido localmente por `python3 -m http.server`
- Hospedado em GitHub Pages (branch `main`, root)
