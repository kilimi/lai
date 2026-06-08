"""Browser-based setup wizard (localhost only). Writes .env and data directories."""

from __future__ import annotations

import socket
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from string import Template

from lai.compose_files import compose_file_env_value, ensure_compose_env
from lai.docker_preflight import check_docker_stack
from lai.paths import resolve_env_file

# Use string.Template so CSS { ... } is not parsed as str.format fields.
PAGE_FORM = Template("""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>LAI setup</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { max-width: 36rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.35rem; font-weight: 600; }
    label { display: block; margin-top: 1rem; font-size: 0.85rem; color: #8b98a5; }
    input { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem 0.6rem;
      border-radius: 6px; border: 1px solid #38444d; background: #15202b; color: inherit; font-size: 1rem; }
    .hint { font-size: 0.8rem; color: #8b98a5; margin-top: 0.25rem; }
    button { margin-top: 1.5rem; padding: 0.55rem 1.2rem; border-radius: 999px; border: none;
      background: #1d9bf0; color: #fff; font-weight: 600; font-size: 1rem; cursor: pointer; }
    button:hover { filter: brightness(1.08); }
    .warn { background: #392419; border: 1px solid #784315; padding: 0.75rem 1rem; border-radius: 8px; margin: 1rem 0; font-size: 0.9rem; }
    code { background: #15202b; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.88em; }
    select { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem 0.6rem;
      border-radius: 6px; border: 1px solid #38444d; background: #15202b; color: inherit; font-size: 1rem; }
    h2 { font-size: 1.05rem; font-weight: 600; margin: 1.5rem 0 0.25rem; color: #c4cfd6; }
    .pt-mode label.row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.95rem; color: #e7e9ea; }
    .pt-mode input[type="radio"] { width: auto; margin: 0; accent-color: #1d9bf0; }
    .chk-row { display: flex; flex-wrap: wrap; gap: 0.65rem 1.25rem; margin-top: 0.5rem; padding: 0.5rem 0.75rem;
      border-radius: 8px; border: 1px solid #38444d; background: #15202b; }
    .chk-row label { display: inline-flex; align-items: center; gap: 0.45rem; margin-top: 0; font-size: 0.92rem; color: #e7e9ea; cursor: pointer; }
    .chk-row input[type="checkbox"] { width: auto; margin: 0; accent-color: #1d9bf0; }
    .license-note { font-size: 0.78rem; color: #8b98a5; margin-top: 0.6rem; line-height: 1.45; }
    .license-note a { color: #1d9bf0; text-decoration: underline; text-underline-offset: 2px; }
    .license-note a:hover { color: #4cc3ff; }
  </style>
</head>
<body>
  <h1>LAI setup</h1>
  <p>Choose where to store databases and project data, web port, and which pretrained models are baked in when you build Docker images.</p>
  $errors_block
  <form method="post" action="/save">
    <label for="data">Data folder (absolute path on this computer)</label>
    <input type="text" id="data" name="data_dir" value="$data_dir" required autocomplete="off"/>
    <p class="hint">PostgreSQL, Redis, MongoDB, datasets, runs, and backups go here.</p>

    <label for="port">Web UI port</label>
    <input type="number" id="port" name="web_port" min="1" max="65535" value="$web_port" required/>
    <p class="hint">Then open <code>http://localhost:&lt;port&gt;</code> after <code>lai up</code>. API stays on 9999.</p>

    <h2>GPU features (optional)</h2>
    <p class="hint">Training, auto-annotate, SAM 2/3, and MMYOLO need an NVIDIA GPU and larger downloads. CPU-only installs can annotate and manage datasets.</p>
    <div class="pt-mode">
      <label class="row"><input type="checkbox" name="gpu_tier" value="1" id="gpu_tier" $gpu_tier_checked/> Enable GPU tier (<code>worker-gpu</code> + <code>sam_service</code>)</label>
    </div>

    <h2>Backend code in Docker</h2>
    <p class="hint">Whether containers use Python from your disk (live edits) or only from pre-built registry images.</p>
    <div class="pt-mode">
      <label class="row"><input type="radio" name="bind_backend" value="1" id="bind_yes" $bind_yes_checked/> Mount host <code>backend/</code> — edit code without rebuilding (developers)</label>
      <label class="row"><input type="radio" name="bind_backend" value="0" id="bind_no" $bind_no_checked/> Use registry images only — recommended for <code>pip install laivision</code></label>
    </div>
    <div id="repo_root_wrap">
      <label for="repo_root">Repository root (absolute path, contains <code>backend/</code>)</label>
      <input type="text" id="repo_root" name="repo_root" value="$repo_root" autocomplete="off"/>
      <p class="hint">Default is this project. Change if your checkout lives elsewhere.</p>
    </div>

    <h2>Pretrained models (Docker build)</h2>
    <p class="hint">Written to <code>.env</code> as <code>LAI_PRETRAINED_MODELS</code> and <code>LAI_DEPTH_MODELS</code>. They control what is baked into the backend image on <code>docker compose build</code>. Choose <strong>None</strong> for the smallest image — weights download automatically the first time you train or run auto-annotate (network required).</p>

    <div class="section-label" style="margin-top:1rem;font-size:0.85rem;color:#8b98a5">Ultralytics — YOLO &amp; RT-DETR</div>
    <p class="hint">Includes RT-DETR (transformer detectors) alongside YOLO11, YOLO26, and YOLO-NAS — same families as in the app.</p>
    <p class="license-note">
      The open-source <a href="https://github.com/ultralytics/ultralytics" target="_blank" rel="noopener noreferrer">Ultralytics</a> package is
      <a href="https://github.com/ultralytics/ultralytics/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPL-3.0</a>.
      Pretrained weights and commercial or closed-source use may require a separate agreement — see
      <a href="https://www.ultralytics.com/license" target="_blank" rel="noopener noreferrer">Ultralytics licensing</a>.
      RT-DETR checkpoints used here are distributed via Ultralytics; ensure your deployment complies with those terms.
    </p>
    <div class="pt-mode">
      <label class="row"><input type="radio" name="pt_mode" value="none" id="pt_m_none"/> None — not stored in image; download on demand (train / auto-annotate)</label>
      <label class="row"><input type="radio" name="pt_mode" value="all" checked id="pt_m_all"/> Full matrix — all families, all sizes (largest download)</label>
      <label class="row"><input type="radio" name="pt_mode" value="minimal" id="pt_m_min"/> Minimal — YOLO11 nano/small only (smaller baked set)</label>
      <label class="row"><input type="radio" name="pt_mode" value="families" id="pt_m_fam"/> Pick families (checkboxes below)</label>
    </div>
    <div id="pt_families_box" class="chk-row" style="display:none;margin-top:0.5rem">
      <label><input type="checkbox" name="pt_family" value="yolo11" checked/> YOLO11</label>
      <label><input type="checkbox" name="pt_family" value="yolo26" checked/> YOLO26</label>
      <label><input type="checkbox" name="pt_family" value="yolo_nas" checked/> YOLO-NAS</label>
      <label><input type="checkbox" name="pt_family" value="rtdetr" checked/> RT-DETR</label>
    </div>
    <p class="hint" id="pt_families_hint" style="display:none">Each checked family includes detect / segment / classify variants and all sizes supported by that family.</p>

    <label for="depth_preset" style="margin-top:1rem">Depth Anything ONNX</label>
    <p class="hint" style="margin-top:0.25rem">“None” = ONNX files are not baked into the image; they may be downloaded when you first use depth auto-annotate.</p>
    <select id="depth_preset" name="depth_preset">$depth_options</select>
    <div id="depth_custom_wrap" style="display:none;margin-top:0.75rem">
      <label for="depth_custom">Custom value</label>
      <input type="text" id="depth_custom" name="depth_custom" value="$depth_custom" placeholder="all, minimal, or comma-separated .onnx filenames" autocomplete="off"/>
    </div>

    <label for="sam3d">SAM 3 weights folder (absolute path)</label>
    <input type="text" id="sam3d" name="sam3_dir" value="$sam3_dir" required autocomplete="off"/>
    <p class="hint">Default is <code>…/backend/sam_service/models</code> in this repo. Put your checkpoint there (or anywhere you choose).</p>

    <label for="sam3f">SAM 3 checkpoint file name</label>
    <input type="text" id="sam3f" name="sam3_file" value="$sam3_file" required autocomplete="off"/>
    <p class="hint">Usually <code>sam3.pt</code>. Restart <code>sam_service</code> after adding the file. SAM 2 works without SAM 3.</p>

    <button type="submit" $submit_disabled>Save and finish</button>
  </form>
  <script>
  (function () {
    function syncPt() {
      var fam = document.getElementById("pt_m_fam").checked;
      document.getElementById("pt_families_box").style.display = fam ? "flex" : "none";
      document.getElementById("pt_families_hint").style.display = fam ? "block" : "none";
    }
    function syncDepth() {
      var d = document.getElementById("depth_preset").value;
      document.getElementById("depth_custom_wrap").style.display = (d === "custom") ? "block" : "none";
    }
    document.getElementById("pt_m_none").addEventListener("change", syncPt);
    document.getElementById("pt_m_all").addEventListener("change", syncPt);
    document.getElementById("pt_m_min").addEventListener("change", syncPt);
    document.getElementById("pt_m_fam").addEventListener("change", syncPt);
    document.getElementById("depth_preset").addEventListener("change", syncDepth);
    function syncBind() {
      var on = document.getElementById("bind_yes").checked;
      document.getElementById("repo_root_wrap").style.display = on ? "block" : "none";
      document.getElementById("repo_root").required = on;
    }
    document.getElementById("bind_yes").addEventListener("change", syncBind);
    document.getElementById("bind_no").addEventListener("change", syncBind);
    syncPt();
    syncDepth();
    syncBind();
  })();
  </script>
  <p class="hint">Served only on <code>127.0.0.1</code>. Press <strong>Ctrl+C</strong> in the terminal to stop.</p>
</body>
</html>
""")

PAGE_OK = Template("""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>LAI — saved</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem;
    background: #0f1419; color: #e7e9ea; line-height: 1.5; }
  .ok { background: #132f1e; border: 1px solid #1d5c2e; padding: 1rem 1.25rem; border-radius: 8px; }
  code { background: #15202b; padding: 0.1rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Saved</h1>
  <div class="ok">
    <p>Wrote <code>.env</code> and created data folders.</p>
    <p>In the terminal run <code>lai pull</code> then <code>lai up</code>, then open <code>http://localhost:$port/</code></p>
  </div>
  <p style="color:#8b98a5;font-size:0.9rem">Press <strong>Ctrl+C</strong> in the terminal to stop this server.</p>
</body>
</html>
""")


def _upsert_env_line(env_path: Path, key: str, value: str) -> None:
    env_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if env_path.is_file():
        lines = env_path.read_text().splitlines()
    prefix = f"{key}="
    out = [ln for ln in lines if not ln.strip().startswith(prefix)]
    out.append(f"{key}={value}")
    env_path.write_text("\n".join(out) + "\n")


def _apply_setup(
    bundle_root: Path,
    data_dir: str,
    web_port: str,
    vite_api_url: str,
    sam3_host_dir: str,
    sam3_checkpoint_file: str,
    *,
    lai_pretrained_models: str = "all",
    lai_depth_models: str = "all",
    bind_host_backend: bool = True,
    lai_repo_root: str | None = None,
    gpu_tier: bool = False,
) -> None:
    data_path = Path(data_dir).expanduser().resolve()
    data_path.mkdir(parents=True, exist_ok=True)
    for sub in ("postgres", "redis", "mongodb", "projects", "data", "backups", "runs"):
        (data_path / sub).mkdir(parents=True, exist_ok=True)

    sam3_path = Path(sam3_host_dir).expanduser().resolve()
    sam3_path.mkdir(parents=True, exist_ok=True)

    env_file = resolve_env_file(bundle_root)
    env_file.parent.mkdir(parents=True, exist_ok=True)
    _upsert_env_line(env_file, "LAI_DATA_DIR", str(data_path))
    _upsert_env_line(env_file, "WEB_PORT", web_port.strip())
    _upsert_env_line(env_file, "VITE_API_URL", vite_api_url.strip())
    _upsert_env_line(env_file, "SAM3_MODELS_HOST_PATH", str(sam3_path))
    _upsert_env_line(env_file, "SAM3_CHECKPOINT_FILENAME", sam3_checkpoint_file.strip())
    _upsert_env_line(env_file, "LAI_PRETRAINED_MODELS", lai_pretrained_models.strip())
    _upsert_env_line(env_file, "LAI_DEPTH_MODELS", lai_depth_models.strip())
    root = (Path(lai_repo_root).expanduser().resolve() if lai_repo_root else bundle_root.resolve())
    _upsert_env_line(env_file, "LAI_REPO_ROOT", str(root))
    _upsert_env_line(
        env_file,
        "COMPOSE_FILE",
        compose_file_env_value(bind_code=bind_host_backend),
    )
    from lai.registry import is_developer_checkout, write_registry_env

    if is_developer_checkout(bundle_root):
        _upsert_env_line(env_file, "LAI_GPU_TIER", "1" if gpu_tier else "0")
        if gpu_tier:
            _upsert_env_line(env_file, "COMPOSE_PROFILES", "gpu")
        else:
            _upsert_env_line(env_file, "COMPOSE_PROFILES", "")
    else:
        write_registry_env(env_file, gpu_tier=gpu_tier, bind_code=False)
        _upsert_env_line(
            env_file,
            "COMPOSE_FILE",
            compose_file_env_value(bind_code=False),
        )
    ensure_compose_env(bundle_root)


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _errors_block(errs: list[str]) -> str:
    if not errs:
        return ""
    return '<div class="warn"><strong>Docker checks failed — fix these, then refresh:</strong><ul>' + "".join(
        f"<li>{_html_escape(e)}</li>" for e in errs
    ) + "</ul></div>"


def _select_options_rows(current: str, choices: list[tuple[str, str]]) -> str:
    """HTML <option> rows for a preset dropdown."""
    out: list[str] = []
    for val, label in choices:
        sel = " selected" if val == current else ""
        out.append(f'<option value="{_html_escape(val)}"{sel}>{_html_escape(label)}</option>')
    return "\n".join(out)


def _depth_select_options(current: str = "all") -> str:
    return _select_options_rows(
        current,
        [
            ("none", "None — not in image; download on demand"),
            ("all", "All — every Depth Anything ONNX"),
            ("minimal", "Minimal — one default ONNX"),
            ("custom", "Custom…"),
        ],
    )


def _resolve_env_preset(preset: str, custom: str) -> str:
    """Map depth form preset + optional custom text to LAI_DEPTH_MODELS."""
    p = (preset or "all").strip().lower()
    if p == "none":
        return "none"
    if p not in ("all", "minimal", "custom"):
        p = "all"
    if p == "custom":
        c = custom.strip()
        return c if c else "all"
    return p


# Order matches backend foundation_models / install arch tokens
_PT_FAMILY_ORDER = ("yolo11", "yolo26", "yolo_nas", "rtdetr")


def _resolve_pretrained_from_form(data: dict[str, list[str]]) -> str:
    """Map YOLO/RT-DETR radios + family checkboxes to LAI_PRETRAINED_MODELS."""
    mode = (data.get("pt_mode") or ["all"])[0].strip().lower()
    if mode == "none":
        return "none"
    if mode == "minimal":
        return "minimal"
    if mode == "families":
        raw = data.get("pt_family") or []
        allowed = set(_PT_FAMILY_ORDER)
        picked = [x for x in raw if x in allowed]
        ordered = [x for x in _PT_FAMILY_ORDER if x in picked]
        if not ordered:
            return "all"
        return ",".join(ordered)
    return "all"


def run_wizard(bundle_root: Path, *, open_browser: bool = True) -> int:
    import sys

    default_data = str(Path.home() / "lai-data")
    default_web = "8089"
    default_sam3_dir = str((bundle_root / "backend" / "sam_service" / "models").resolve())
    default_sam3_file = "sam3.pt"
    default_repo_root = str(bundle_root.resolve())
    wizard_port = _pick_port()
    from lai.registry import is_developer_checkout

    dev_checkout = is_developer_checkout(bundle_root)
    bind_yes_checked = "checked" if dev_checkout else ""
    bind_no_checked = "" if dev_checkout else "checked"
    gpu_tier_checked = ""

    def make_handler() -> type[BaseHTTPRequestHandler]:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def do_GET(self) -> None:
                if self.path.split("?", 1)[0] != "/":
                    self.send_error(404)
                    return
                live_errs = check_docker_stack(bundle_root)
                submit_dis = "disabled" if live_errs else ""
                body = PAGE_FORM.substitute(
                    errors_block=_errors_block(live_errs),
                    data_dir=_html_escape(default_data),
                    web_port=_html_escape(default_web),
                    repo_root=_html_escape(default_repo_root),
                    depth_options=_depth_select_options("all"),
                    depth_custom="",
                    sam3_dir=_html_escape(default_sam3_dir),
                    sam3_file=_html_escape(default_sam3_file),
                    submit_disabled=submit_dis,
                    bind_yes_checked=bind_yes_checked,
                    bind_no_checked=bind_no_checked,
                    gpu_tier_checked=gpu_tier_checked,
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                if self.path != "/save":
                    self.send_error(404)
                    return
                live_errs = check_docker_stack(bundle_root)
                if live_errs:
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    msg = "<h1>Docker not ready</h1><p>Fix the issues, then go back and refresh.</p><ul>" + "".join(
                        f"<li>{_html_escape(e)}</li>" for e in live_errs
                    ) + "</ul>"
                    b = msg.encode()
                    self.send_header("Content-Length", str(len(b)))
                    self.end_headers()
                    self.wfile.write(b)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8", errors="replace")
                data = urllib.parse.parse_qs(raw, keep_blank_values=True)
                data_dir = (data.get("data_dir") or [""])[0].strip()
                web_port = (data.get("web_port") or [""])[0].strip()
                sam3_dir = (data.get("sam3_dir") or [""])[0].strip()
                sam3_file = (data.get("sam3_file") or [""])[0].strip()
                lai_pt = _resolve_pretrained_from_form(data)
                lai_depth = _resolve_env_preset(
                    (data.get("depth_preset") or ["all"])[0],
                    (data.get("depth_custom") or [""])[0],
                )
                bind_raw = (data.get("bind_backend") or ["1"])[0].strip()
                bind_host_backend = bind_raw not in ("0", "false", "False", "no", "NO")
                gpu_tier = bool((data.get("gpu_tier") or [""])[0].strip())
                repo_in = (data.get("repo_root") or [""])[0].strip()
                if not data_dir or not web_port or not sam3_dir or not sam3_file:
                    self.send_response(400)
                    self.end_headers()
                    return
                p = Path(data_dir).expanduser()
                if not p.is_absolute():
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Data folder must be an absolute path.")
                    return
                s3 = Path(sam3_dir).expanduser()
                if not s3.is_absolute():
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"SAM 3 folder must be an absolute path.")
                    return
                try:
                    pi = int(web_port)
                    if not (1 <= pi <= 65535):
                        raise ValueError
                except ValueError:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Invalid port.")
                    return
                repo_path: Path | None = None
                if bind_host_backend:
                    if not repo_in:
                        self.send_response(400)
                        self.end_headers()
                        self.wfile.write(b"Repository root is required when mounting host backend.")
                        return
                    repo_path = Path(repo_in).expanduser()
                    if not repo_path.is_absolute():
                        self.send_response(400)
                        self.end_headers()
                        self.wfile.write(b"Repository root must be an absolute path.")
                        return
                    repo_path = repo_path.resolve()
                    if not (repo_path / "backend").is_dir():
                        self.send_response(400)
                        self.end_headers()
                        self.wfile.write(b"Expected a backend/ directory under the repository root.")
                        return
                try:
                    _apply_setup(
                        bundle_root,
                        str(p),
                        web_port,
                        "http://localhost:9999",
                        str(s3),
                        sam3_file,
                        lai_pretrained_models=lai_pt,
                        lai_depth_models=lai_depth,
                        bind_host_backend=bind_host_backend,
                        lai_repo_root=str(repo_path) if repo_path is not None else None,
                        gpu_tier=gpu_tier,
                    )
                except OSError as e:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(str(e).encode())
                    return
                html = PAGE_OK.substitute(port=_html_escape(web_port)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)

        return Handler

    server = HTTPServer(("127.0.0.1", wizard_port), make_handler())
    url = f"http://127.0.0.1:{wizard_port}/"
    print(f"LAI setup wizard: {url}", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
    finally:
        server.server_close()
    return 0


def _html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
