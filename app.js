// app.js — painel QA Soma. Sem build step. Alpine via CDN.
// Lê JSONs de data/ via fetch. Polling de current-run.json a 2s na aba "live".
//
// Registra via Alpine.data() no evento alpine:init pra garantir que está
// disponível antes do x-data="dashboard()" ser avaliado.

document.addEventListener("alpine:init", () => {
  window.Alpine.data("dashboard", dashboardData);
});

function dashboardData() {
  return {
    tab: "brands",
    state: null,
    selectedBrand: null,
    selectedBrandData: null,
    liveRun: null,
    error: null,
    loading: false,
    livePollHandle: null,
    findingFilter: { brand: "", severity: "", status: "" },
    allFindingsCache: null,
    apiAvailable: false,         // detecta se o serve.py está respondendo
    expandedFinding: null,       // "brand/id" do finding aberto
    actionPending: null,         // "brand/id" enquanto o POST roda
    actionError: null,           // mensagem de erro do último POST
    pat: "",                     // GitHub PAT (localStorage)
    patPromptOpen: false,        // modal de configuração do PAT
    patInput: "",                // textarea do PAT (não persiste até salvar)
    pollHandle: null,            // setInterval do poll pós-dispatch
    deletePending: null,         // "brand/id" enquanto o usuário confirma o delete

    async init() {
      this.bindHashRoute();
      this.pat = localStorage.getItem("qa-painel-pat") || "";
      await this.checkApi();
      await this.refresh();
      this.startLivePoll();
      window.addEventListener("focus", () => this.refresh());
    },

    async checkApi() {
      try {
        const r = await fetch("/api/health", { method: "GET" });
        this.apiAvailable = r.ok;
      } catch {
        this.apiAvailable = false;
      }
    },

    // ---------- PAT ----------

    get canTriage() {
      // Pode triar se: tem backend local OU tem PAT salvo (modo online).
      return this.apiAvailable || !!this.pat;
    },

    openPatPrompt() {
      this.patInput = this.pat;
      this.patPromptOpen = true;
    },

    savePat() {
      const v = (this.patInput || "").trim();
      if (v) {
        localStorage.setItem("qa-painel-pat", v);
        this.pat = v;
      } else {
        localStorage.removeItem("qa-painel-pat");
        this.pat = "";
      }
      this.patPromptOpen = false;
      this.actionError = null;
    },

    bindHashRoute() {
      const apply = () => {
        const h = (location.hash || "#/brands").replace("#/", "");
        if (["brands", "findings", "live"].includes(h)) this.tab = h;
      };
      apply();
      window.addEventListener("hashchange", apply);
    },

    async fetchJson(path) {
      const r = await fetch(`data/${path}?t=${Date.now()}`);
      if (!r.ok) {
        if (r.status === 404) return null;
        throw new Error(`${path}: HTTP ${r.status}`);
      }
      return r.json();
    },

    async refresh() {
      this.loading = true;
      this.error = null;
      try {
        this.state = await this.fetchJson("state.json");
        if (!this.state) {
          this.error = "state.json não encontrado. Rode shared/scripts/build-dashboard-data.sh.";
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    async openBrand(b) {
      this.selectedBrand = b.id;
      try {
        this.selectedBrandData = await this.fetchJson(b.state_file);
      } catch (e) {
        this.error = e.message;
      }
    },

    formatTs(iso) {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      } catch {
        return iso;
      }
    },

    // ---------- findings ----------

    async loadAllFindings() {
      if (!this.state) return;
      const all = [];
      for (const b of this.state.brands) {
        const s = await this.fetchJson(b.state_file);
        if (!s) continue;
        for (const f of s.findings || []) {
          all.push({ ...f, brand: b.id, brandDisplay: b.display_name });
        }
      }
      // Ordenar: severity (alta > média > baixa > resto), depois aberto > fechado, depois id.
      const sevOrder = { alta: 0, media: 1, baixa: 2, positivo: 3, desconhecido: 4 };
      const stOrder  = { open: 0, in_progress: 1, pending: 2, observation: 3, closed: 4, wontfix: 5 };
      all.sort((a, b) => {
        const sa = sevOrder[a.severity_level ?? "desconhecido"] ?? 9;
        const sb = sevOrder[b.severity_level ?? "desconhecido"] ?? 9;
        if (sa !== sb) return sa - sb;
        const ta = stOrder[a.status_category ?? "open"] ?? 9;
        const tb = stOrder[b.status_category ?? "open"] ?? 9;
        if (ta !== tb) return ta - tb;
        return (a.id || "").localeCompare(b.id || "");
      });
      this.allFindingsCache = all;
    },

    filteredFindings() {
      // Lazy-load na primeira vez que a aba abre
      if (this.tab === "findings" && this.allFindingsCache === null && this.state) {
        this.loadAllFindings();
        return [];
      }
      const all = this.allFindingsCache || [];
      const { brand, severity, status } = this.findingFilter;
      return all.filter((f) => {
        if (brand && f.brand !== brand) return false;
        if (severity && f.severity_level !== severity) return false;
        if (status && f.status_category !== status) return false;
        return true;
      });
    },

    findingKey(f) {
      return `${f.brand}/${f.id}`;
    },

    get expandedFindingData() {
      if (!this.expandedFinding || !this.allFindingsCache) return null;
      return this.allFindingsCache.find((f) => this.findingKey(f) === this.expandedFinding) || null;
    },

    toggleExpand(f) {
      const key = this.findingKey(f);
      this.expandedFinding = this.expandedFinding === key ? null : key;
      this.actionError = null;
    },

    async setStatus(f, statusKey) {
      // Roteia: backend local (instantâneo) vs GitHub dispatch (~30-60s).
      if (this.apiAvailable) return this._setStatusLocal(f, statusKey);
      if (this.pat) return this._setStatusDispatch(f, statusKey);
      this.actionError = "Sem backend local nem PAT configurado — configure o PAT primeiro.";
    },

    async _setStatusLocal(f, statusKey) {
      const key = this.findingKey(f);
      this.actionPending = key;
      this.actionError = null;
      try {
        const r = await fetch("/api/override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: f.brand,
            finding_id: f.id,
            status: statusKey,
            decision: f.decision || null,
          }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        await this.refresh();
        this.allFindingsCache = null;
        await this.loadAllFindings();
      } catch (e) {
        this.actionError = e.message;
      } finally {
        this.actionPending = null;
      }
    },

    async _setStatusDispatch(f, statusKey) {
      const key = this.findingKey(f);
      this.actionPending = key;
      this.actionError = null;
      const repo = "ammbobr/qa-soma-dashboard";
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `token ${this.pat}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: "apply-override",
            client_payload: {
              brand: f.brand,
              finding_id: f.id,
              status: statusKey,
              decision: f.decision || null,
            },
          }),
        });
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try { msg = (await r.json()).message || msg; } catch {}
          throw new Error(`GitHub: ${msg}`);
        }
        // Action começou. Não bloqueia esperando — começa poll do state.json.
        // O state.json é atualizado pelo workflow ao fim (~30-60s).
        this._beginPollForUpdate(f, statusKey);
      } catch (e) {
        this.actionError = e.message;
        this.actionPending = null;
      }
    },

    // ---------- delete ----------

    askDelete(f) {
      this.deletePending = this.findingKey(f);
    },

    cancelDelete() {
      this.deletePending = null;
    },

    async confirmDelete(f) {
      this.deletePending = null;
      if (this.apiAvailable) return this._deleteLocal(f);
      if (this.pat) return this._deleteDispatch(f);
      this.actionError = "Sem backend local nem PAT — configure o PAT pra apagar online.";
    },

    async _deleteLocal(f) {
      const key = this.findingKey(f);
      this.actionPending = key;
      this.actionError = null;
      try {
        const r = await fetch("/api/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand: f.brand, finding_id: f.id }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
        this.expandedFinding = null;
        await this.refresh();
        this.allFindingsCache = null;
        await this.loadAllFindings();
      } catch (e) {
        this.actionError = e.message;
      } finally {
        this.actionPending = null;
      }
    },

    async _deleteDispatch(f) {
      const key = this.findingKey(f);
      this.actionPending = key;
      this.actionError = null;
      const repo = "ammbobr/qa-soma-dashboard";
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `token ${this.pat}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: "delete-finding",
            client_payload: { brand: f.brand, finding_id: f.id },
          }),
        });
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try { msg = (await r.json()).message || msg; } catch {}
          throw new Error(`GitHub: ${msg}`);
        }
        this._beginPollForDelete(f);
      } catch (e) {
        this.actionError = e.message;
        this.actionPending = null;
      }
    },

    _beginPollForDelete(f) {
      if (this.pollHandle) { clearInterval(this.pollHandle); }
      let ticks = 0;
      const maxTicks = 24;
      this.pollHandle = setInterval(async () => {
        ticks++;
        try {
          const r = await fetch(`data/${f.brand}-state.json?t=${Date.now()}`, { cache: "no-store" });
          if (r.ok) {
            const s = await r.json();
            const stillThere = (s.findings || []).some((x) => x.id === f.id);
            if (!stillThere) {
              clearInterval(this.pollHandle);
              this.pollHandle = null;
              this.actionPending = null;
              this.expandedFinding = null;
              await this.refresh();
              this.allFindingsCache = null;
              await this.loadAllFindings();
              return;
            }
          }
        } catch {}
        if (ticks >= maxTicks) {
          clearInterval(this.pollHandle);
          this.pollHandle = null;
          this.actionPending = null;
          this.actionError = "Delete não propagou em 2 min — verifique o workflow no GitHub.";
        }
      }, 5000);
    },

    _beginPollForUpdate(f, expectedStatusKey) {
      if (this.pollHandle) { clearInterval(this.pollHandle); }
      let ticks = 0;
      const maxTicks = 24;  // 24 * 5s = 120s
      const key = this.findingKey(f);
      this.pollHandle = setInterval(async () => {
        ticks++;
        try {
          // Bypass cache do GitHub Pages adicionando t=now
          const r = await fetch(`data/${f.brand}-state.json?t=${Date.now()}`, { cache: "no-store" });
          if (r.ok) {
            const s = await r.json();
            const updated = (s.findings || []).find((x) => x.id === f.id);
            const sourceOk = expectedStatusKey === "open"
              ? !updated?.override_source
              : updated?.override_source === "panel";
            if (sourceOk) {
              clearInterval(this.pollHandle);
              this.pollHandle = null;
              this.actionPending = null;
              await this.refresh();
              this.allFindingsCache = null;
              await this.loadAllFindings();
              return;
            }
          }
        } catch {}
        if (ticks >= maxTicks) {
          clearInterval(this.pollHandle);
          this.pollHandle = null;
          this.actionPending = null;
          this.actionError = "Mudança não propagou em 2 min — verifique o workflow no GitHub.";
        }
      }, 5000);
    },

    // Renderiza um subset de markdown pra body de finding. Sem deps externas.
    // Cobre: headings ###/####, listas - / *, **bold**, `code`, blocos ``` e linhas em branco.
    renderMd(md) {
      if (!md) return "";
      const escape = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Code blocks primeiro (placeholder pra não interferir nos demais).
      const blocks = [];
      md = md.replace(/```([\s\S]*?)```/g, (_, code) => {
        blocks.push(`<pre><code>${escape(code.trim())}</code></pre>`);
        return ` ${blocks.length - 1} `;
      });
      const lines = md.split("\n");
      const out = [];
      let inList = false;
      const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
      for (let raw of lines) {
        const line = raw.trimEnd();
        if (!line) { closeList(); out.push(""); continue; }
        let m;
        if ((m = line.match(/^####\s+(.+)/))) { closeList(); out.push(`<h5>${escape(m[1])}</h5>`); continue; }
        if ((m = line.match(/^###\s+(.+)/)))  { closeList(); out.push(`<h4>${escape(m[1])}</h4>`); continue; }
        if ((m = line.match(/^##\s+(.+)/)))   { closeList(); out.push(`<h3>${escape(m[1])}</h3>`); continue; }
        if ((m = line.match(/^[-*]\s+(.+)/))) {
          if (!inList) { out.push("<ul>"); inList = true; }
          out.push(`<li>${inlineMd(m[1])}</li>`);
          continue;
        }
        if (line === "---") { closeList(); out.push("<hr>"); continue; }
        closeList();
        out.push(`<p>${inlineMd(line)}</p>`);
      }
      closeList();
      function inlineMd(s) {
        s = escape(s);
        s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
        return s;
      }
      // Restaura code blocks.
      let html = out.join("\n");
      html = html.replace(/ (\d+) /g, (_, i) => blocks[Number(i)]);
      return html;
    },

    // ---------- live ----------

    startLivePoll() {
      const tick = async () => {
        try {
          this.liveRun = await this.fetchJson("current-run.json");
        } catch {
          this.liveRun = null;
        }
      };
      tick();
      this.livePollHandle = setInterval(tick, 2000);
    },
  };
}
