#!/usr/bin/env python3
"""serve.py — servidor HTTP local pro painel do QA Soma.

Serve estáticos do shared/dashboard/ + expõe endpoints:
  POST /api/override         — grava override no findings-overrides.json da marca
                               body: {brand, finding_id, status, decision}
                               status: "open" | "closed" | "wontfix" | "in_progress"
                                       | "pending" | "observation"
  POST /api/rebuild          — invoca build-dashboard-data.sh pra regenerar JSONs
  GET  /api/health           — sanity check ({"ok": true})

Após gravar um override, NÃO comita nem push automático — só atualiza
brands/<brand>/findings-overrides.json. Pra publicar, rode publish-dashboard.sh.

Uso: shared/dashboard/serve.py [porta]
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(DASHBOARD_DIR, "..", ".."))
BRANDS_DIR = os.path.join(REPO_ROOT, "brands")
OVERRIDES_DIR = os.path.join(DASHBOARD_DIR, "data", "overrides")
BUILD_SCRIPT = os.path.join(REPO_ROOT, "shared", "scripts", "build-dashboard-data.sh")

ID_RE = re.compile(r"^F(?:-[A-Z]+)?-\d+$")
ALLOWED_STATUS = {
    # mapeamento da chave canônica → texto que vai pro overrides.json e o
    # parser do builder classifica como category correto.
    "open":         "Aberto",
    "closed":       "Fechado — não é bug",
    "resolved":     "Fechado — resolvido",
    "wontfix":      "Won't fix",
    "in_progress":  "Em correção",
    "pending":      "Pendente",
    "observation":  "Observação",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD_DIR, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        # Local dev: nunca cachear nada. Recarregar sempre pega o arquivo novo.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # ----- helpers ----------------------------------------------------------

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return None

    # ----- HTTP methods -----------------------------------------------------

    def do_OPTIONS(self):  # CORS preflight
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True, "repo_root": REPO_ROOT})
        if path == "/api/overrides":
            # devolve overrides de todas as marcas — útil pro frontend hidratar.
            out = {}
            if os.path.isdir(OVERRIDES_DIR):
                for fname in os.listdir(OVERRIDES_DIR):
                    if not fname.endswith(".json"): continue
                    brand = fname[:-5]
                    try:
                        out[brand] = json.load(open(os.path.join(OVERRIDES_DIR, fname)))
                    except Exception:
                        out[brand] = {}
            return self._json(200, out)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/override":
            return self._handle_override()
        if path == "/api/delete":
            return self._handle_delete()
        if path == "/api/rebuild":
            return self._handle_rebuild()
        self._json(404, {"error": "unknown endpoint"})

    # ----- endpoints --------------------------------------------------------

    def _handle_override(self):
        body = self._read_json_body()
        if body is None:
            return self._json(400, {"error": "invalid json body"})

        brand = (body.get("brand") or "").strip()
        finding_id = (body.get("finding_id") or "").strip()
        status_key = (body.get("status") or "").strip()
        decision = (body.get("decision") or "").strip() or None

        if not brand or not re.match(r"^[a-z0-9_-]+$", brand):
            return self._json(400, {"error": "brand invalid"})
        if not ID_RE.match(finding_id):
            return self._json(400, {"error": "finding_id invalid (expected F-XXX or F-PREFIX-NN)"})
        if status_key not in ALLOWED_STATUS:
            return self._json(400, {"error": f"status invalid; allowed: {sorted(ALLOWED_STATUS)}"})

        brand_dir = os.path.join(BRANDS_DIR, brand)
        if not os.path.isdir(brand_dir):
            return self._json(404, {"error": f"brand '{brand}' not found"})

        os.makedirs(OVERRIDES_DIR, exist_ok=True)
        overrides_path = os.path.join(OVERRIDES_DIR, f"{brand}.json")
        try:
            existing = json.load(open(overrides_path)) if os.path.exists(overrides_path) else {}
        except Exception:
            existing = {}

        if status_key == "open":
            # "reabrir" remove o override → finding volta ao status do markdown.
            existing.pop(finding_id, None)
        else:
            existing[finding_id] = {
                "status": ALLOWED_STATUS[status_key],
                "status_key": status_key,
                "decision": decision,
                "decided_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }

        try:
            with open(overrides_path, "w") as fh:
                json.dump(existing, fh, ensure_ascii=False, indent=2, sort_keys=True)
                fh.write("\n")
        except Exception as e:
            return self._json(500, {"error": f"failed to write: {e}"})

        # Regenera os JSONs do dashboard pra que o reload já reflita.
        rebuilt = self._rebuild()
        return self._json(200, {
            "ok": True,
            "brand": brand,
            "finding_id": finding_id,
            "status": ALLOWED_STATUS[status_key],
            "rebuilt": rebuilt,
        })

    def _handle_delete(self):
        """Hard-delete: remove a seção '## F-XXX — ...' do findings.md +
        remove a entry do overrides.json + rebuilda os JSONs."""
        body = self._read_json_body()
        if body is None:
            return self._json(400, {"error": "invalid json body"})

        brand = (body.get("brand") or "").strip()
        finding_id = (body.get("finding_id") or "").strip()

        if not brand or not re.match(r"^[a-z0-9_-]+$", brand):
            return self._json(400, {"error": "brand invalid"})
        if not ID_RE.match(finding_id):
            return self._json(400, {"error": "finding_id invalid"})

        brand_dir = os.path.join(BRANDS_DIR, brand)
        if not os.path.isdir(brand_dir):
            return self._json(404, {"error": f"brand '{brand}' not found"})

        # 1) Remove a seção do findings.md.
        findings_path = os.path.join(brand_dir, "findings.md")
        removed_from_md = False
        if os.path.exists(findings_path):
            try:
                with open(findings_path) as fh:
                    lines = fh.readlines()
                out = []
                skipping = False
                # Padrão exato: "## F-XXX — Título" ou "## F-XXX - Título"
                head_re = re.compile(rf"^##\s+{re.escape(finding_id)}\s*[—-]\s")
                next_h2 = re.compile(r"^##\s+")
                for line in lines:
                    if skipping:
                        if next_h2.match(line):
                            skipping = False
                            out.append(line)
                        # senão: pula a linha (engole o body)
                    elif head_re.match(line):
                        skipping = True
                        removed_from_md = True
                    else:
                        out.append(line)
                # Limpa "---" órfão deixado antes da seção removida (visual).
                cleaned = []
                for i, line in enumerate(out):
                    if line.strip() == "---" and i + 1 < len(out) and out[i + 1].strip() == "":
                        if i + 2 < len(out) and out[i + 2].strip() == "---":
                            continue  # dois '---' seguidos com linha em branco entre — colapsa
                    cleaned.append(line)
                with open(findings_path, "w") as fh:
                    fh.writelines(cleaned)
            except Exception as e:
                return self._json(500, {"error": f"failed editing findings.md: {e}"})

        # 2) Remove a entry do overrides.json (não interessa mais — finding sumiu).
        os.makedirs(OVERRIDES_DIR, exist_ok=True)
        overrides_path = os.path.join(OVERRIDES_DIR, f"{brand}.json")
        if os.path.exists(overrides_path):
            try:
                ov = json.load(open(overrides_path))
            except Exception:
                ov = {}
            if finding_id in ov:
                ov.pop(finding_id)
                with open(overrides_path, "w") as fh:
                    json.dump(ov, fh, ensure_ascii=False, indent=2, sort_keys=True)
                    fh.write("\n")

        rebuilt = self._rebuild()
        return self._json(200, {
            "ok": True,
            "brand": brand,
            "finding_id": finding_id,
            "removed_from_md": removed_from_md,
            "rebuilt": rebuilt,
        })

    def _handle_rebuild(self):
        rebuilt = self._rebuild()
        self._json(200, {"ok": rebuilt is True, "result": rebuilt})

    def _rebuild(self):
        if not os.path.exists(BUILD_SCRIPT):
            return f"build script not found at {BUILD_SCRIPT}"
        try:
            res = subprocess.run(
                ["bash", BUILD_SCRIPT],
                capture_output=True, text=True, cwd=REPO_ROOT, timeout=60,
            )
            if res.returncode != 0:
                return {"exit": res.returncode, "stderr": res.stderr[-500:]}
            return True
        except subprocess.TimeoutExpired:
            return "rebuild timed out"
        except Exception as e:
            return f"rebuild error: {e}"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    addr = ("127.0.0.1", port)
    print(f"→ Painel: http://localhost:{port}")
    print(f"  Endpoints: GET /api/health · GET /api/overrides · POST /api/override · POST /api/rebuild")
    print(f"  Ctrl+C pra encerrar.\n")
    HTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
