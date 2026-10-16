"""
Tiny HTTP server for the web GUI.  Standard library only.

Static files are served from ``src/web``; the JSON API lives under ``/api/``.

    GET  /api/meta                 generators, sweepable params, metrics, defaults
    GET  /api/traces               trace files in data/
    GET  /api/traces/<name>        contents of one trace file
    POST /api/generate             {"kind": "loop", "params": {...}}            -> {"text", "count"}
    POST /api/decode               {"config": {...}, "address": "0x1A3C"}       -> fields
    POST /api/simulate             {"config": {...}, "trace": "...", "event_limit": 4000}
    POST /api/sweep                {"config", "trace", "param", "values", "series_param", "series_values"}
"""
from __future__ import annotations

import json
import os
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import unquote, urlparse

from . import __version__
from .core import CacheConfig, ConfigError, decode, simulate
from .experiments import METRICS, SWEEPABLE, sweep
from .traces import GENERATOR_PARAMS, TraceError, format_trace, generate, parse_trace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # src/
WEB_DIR = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(os.path.dirname(ROOT), "data")
EVENT_LIMIT_DEFAULT = 4000
MAX_BODY = 64 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _trace_files() -> list:
    out = []
    if not os.path.isdir(DATA_DIR):
        return out
    for name in sorted(os.listdir(DATA_DIR)):
        if not name.endswith(".trace"):
            continue
        path = os.path.join(DATA_DIR, name)
        desc = ""
        count = 0
        with open(path, errors="replace") as fh:
            for line in fh:
                s = line.strip()
                if s.startswith("#"):
                    if not desc:
                        desc = s.lstrip("# ").strip()
                elif s:
                    count += 1
        out.append({"name": name, "accesses": count, "description": desc,
                    "size": os.path.getsize(path)})
    return out


def _config(d: Dict[str, Any]) -> CacheConfig:
    try:
        return CacheConfig.from_dict(d or {})
    except (ConfigError, ValueError, TypeError) as e:
        raise ApiError("config: %s" % e)


def handle_api(method: str, path: str, body: Dict[str, Any]) -> Any:
    if path == "/api/meta" and method == "GET":
        return {"version": __version__, "generators": GENERATOR_PARAMS, "sweepable": SWEEPABLE,
                "metrics": METRICS, "defaults": CacheConfig().to_dict(),
                "event_limit": EVENT_LIMIT_DEFAULT}
    if path == "/api/traces" and method == "GET":
        return {"traces": _trace_files()}
    if path.startswith("/api/traces/") and method == "GET":
        name = os.path.basename(unquote(path[len("/api/traces/"):]))
        full = os.path.join(DATA_DIR, name)
        if not name.endswith(".trace") or not os.path.isfile(full):
            raise ApiError("no such trace", 404)
        with open(full, errors="replace") as fh:
            text = fh.read()
        return {"name": name, "text": text, "accesses": len(parse_trace(text))}
    if method != "POST":
        raise ApiError("not found", 404)

    if path == "/api/generate":
        kind = body.get("kind", "loop")
        params = body.get("params", {}) or {}
        try:
            acc = generate(kind, **params)
        except (TraceError, ValueError, TypeError) as e:
            raise ApiError("generate: %s" % e)
        header = "generator: %s %s\n%d accesses" % (kind, " ".join("%s=%s" % kv for kv in params.items()), len(acc))
        return {"text": format_trace(acc, header), "count": len(acc), "kind": kind}

    if path == "/api/decode":
        cfg = _config(body.get("config"))
        try:
            addr = int(str(body.get("address", "0")).strip() or "0", 0)
        except ValueError:
            raise ApiError("bad address")
        return {"config": cfg.to_dict(), "fields": decode(cfg, addr).to_dict()}

    if path == "/api/simulate":
        cfg = _config(body.get("config"))
        try:
            trace = parse_trace(body.get("trace", ""), bool(body.get("include_instr", False)))
        except TraceError as e:
            raise ApiError("trace: %s" % e)
        limit = int(body.get("event_limit", EVENT_LIMIT_DEFAULT))
        return simulate(cfg, trace, keep_events=limit)

    if path == "/api/sweep":
        cfg = _config(body.get("config"))
        try:
            trace = parse_trace(body.get("trace", ""), bool(body.get("include_instr", False)))
        except TraceError as e:
            raise ApiError("trace: %s" % e)
        try:
            rows = sweep(cfg, trace, body.get("param", "associativity"), body.get("values", []),
                         body.get("series_param") or None, body.get("series_values") or None)
        except ValueError as e:
            raise ApiError(str(e))
        return {"rows": rows, "accesses": len(trace)}

    raise ApiError("not found", 404)


class Handler(SimpleHTTPRequestHandler):
    server_version = "CacheSim/" + __version__

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, fmt, *args):  # quieter log: skip the API chatter, keep everything else
        try:
            line = fmt % args if args else fmt
        except (TypeError, ValueError):
            line = str(fmt)
        if "/api/" in line and " 200 " in line:
            return
        super().log_message(fmt, *args)

    def _send_json(self, obj: Any, status: int = 200) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _api(self, method: str) -> None:
        path = urlparse(self.path).path
        body: Dict[str, Any] = {}
        if method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send_json({"error": "request too large"}, 413)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except ValueError:
                return self._send_json({"error": "invalid JSON"}, 400)
        try:
            self._send_json(handle_api(method, path, body))
        except ApiError as e:
            self._send_json({"error": str(e)}, e.status)
        except Exception as e:  # pragma: no cover - last resort
            self._send_json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

    def do_GET(self):
        if urlparse(self.path).path.startswith("/api/"):
            return self._api("GET")
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path.startswith("/api/"):
            return self._api("POST")
        self.send_error(404)

    def end_headers(self):
        if not urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def serve(host: str = "127.0.0.1", port: int = 8077, open_browser: bool = True) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = "http://%s:%d/" % (host, port)
    print("CACHE-SIM %s  GUI at %s   (Ctrl+C to stop)" % (__version__, url))
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
