"""HTTP server for the guest protocol: routing, auth, and JSON envelopes."""

from __future__ import annotations

import json
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .protocol import NAME
from .registry import Registry
from .state import CounterState

MAX_BODY_BYTES = 5 * 1024 * 1024

# Static /mf-types.ts artifact published beside main.py. Not generated
# in-repo: the machine's CI would run machinen-bindgen against the booted
# guest and ship the output with the deploy. Absent file -> 404, and
# consumers render bindings from the manifest instead.
TYPES_FILE = Path(__file__).resolve().parent.parent / "mf-types.ts"


@dataclass(frozen=True)
class ServerConfig:
    port: int
    token: str | None


def _make_handler(
    config: ServerConfig, registry: Registry, state: CounterState
) -> type[BaseHTTPRequestHandler]:
    class GuestHandler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _send(self, payload: dict[str, Any], status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _not_found(self) -> None:
            self.send_response(404)
            self.end_headers()

        def _unauthorized(self) -> bool:
            if config.token is None:
                return False
            if self.headers.get("authorization") == f"Bearer {config.token}":
                return False
            self._send(
                {"ok": False, "error": {"message": "unauthorized", "type": "AuthError"}},
                status=401,
            )
            return True

        def _read_body(self) -> Any | None:
            """Parse the JSON body; sends 413 and returns None when oversized."""
            length = int(self.headers.get("content-length", "0"))
            if length > MAX_BODY_BYTES:
                self._send(
                    {
                        "ok": False,
                        "error": {"message": "payload too large", "type": "PayloadError"},
                    },
                    status=413,
                )
                return None
            return json.loads(self.rfile.read(length))

        def do_GET(self) -> None:
            if self.path == "/mf/health":
                self._send({"ok": True, "name": NAME})
                return
            if self._unauthorized():
                return
            if self.path == "/mf-manifest.json":
                self._send(registry.manifest())
            elif self.path == "/mf-types.ts":
                if not TYPES_FILE.is_file():
                    self._not_found()
                    return
                body = TYPES_FILE.read_bytes()
                self.send_response(200)
                self.send_header("content-type", "application/typescript")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/mf/state":
                self._send({"ok": True, "state": state.dehydrate()})
            else:
                self._not_found()

        def do_POST(self) -> None:
            if self._unauthorized():
                return
            if self.path not in ("/mf/call", "/mf/state"):
                self._not_found()
                return
            try:
                request = self._read_body()
                if request is None:
                    return
                if self.path == "/mf/state":
                    state.rehydrate(request.get("state") or {})
                    self._send({"ok": True})
                    return
                result = registry.dispatch(
                    request["module"], request["fn"], request.get("args") or []
                )
                self._send({"ok": True, "result": result})
            except Exception as error:  # noqa: BLE001 - guest boundary
                self._send(
                    {
                        "ok": False,
                        "error": {"message": str(error), "type": type(error).__name__},
                    }
                )

    return GuestHandler


def serve(config: ServerConfig, registry: Registry, state: CounterState) -> None:
    """Bind 127.0.0.1, announce readiness, and serve until interrupted."""
    server = ThreadingHTTPServer(("127.0.0.1", config.port), _make_handler(config, registry, state))
    print(f"[remote-python] machine guest listening on 127.0.0.1:{config.port}", flush=True)
    server.serve_forever()
