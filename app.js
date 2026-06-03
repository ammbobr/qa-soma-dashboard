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

    async init() {
      this.bindHashRoute();
      await this.refresh();
      this.startLivePoll();
      window.addEventListener("focus", () => this.refresh());
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
