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

## Triagem de bugs pelo painel

A aba **Bugs** lista todos os achados (parseados de `brands/<brand>/findings.md`). Clicar numa linha abre um modal com o body completo + botões pra mudar status: **Não é bug · Resolvido · Won't fix · Em andamento · Observação · Reabrir**.

### Modo local (instantâneo)

Rode `shared/dashboard/serve.sh`. O painel detecta o backend e mostra "✓ Backend local conectado". Cada clique grava em `shared/dashboard/data/overrides/<brand>.json` e rebuilda os JSONs (1-2s). Pra publicar pro time, rode `shared/scripts/publish-dashboard.sh`.

### Modo online via GitHub Action (~30-60s)

No painel publicado (GitHub Pages), clique em **"configurar GitHub PAT"** no banner. Passos:

1. Vá em <https://github.com/settings/tokens?type=beta> → "Generate new token" (fine-grained).
2. **Repository access:** apenas `ammbobr/qa-soma-dashboard`.
3. **Permissions → Repository:**
   - `Contents`: **Read and write**
   - `Metadata`: **Read**
4. Copie o token, cole no painel. Fica salvo só no seu browser (localStorage).

A partir daí, clicar num botão dispara o workflow `apply-override` (`.github/workflows/override.yml`) que atualiza `data/overrides/<brand>.json`, regenera o state, e comita. O painel pollia até propagar (~30-60s).

## Stack

- HTML/CSS/JS vanilla + Alpine.js (CDN)
- Servidor local: `serve.py` (Python stdlib — serve estáticos + endpoints `/api/override`, `/api/rebuild`, `/api/health`)
- Hospedado em GitHub Pages (branch `main`, root)
- Triagem online via GitHub Actions `repository_dispatch`
