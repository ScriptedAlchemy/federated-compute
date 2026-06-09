"""Machine guest service in Python.

Implements the federated-compute guest protocol v2 (GET /mf/manifest,
POST /mf/call) so the Module Federation host can bind its exposed functions
like imported modules. Stdlib only: run with `python3 main.py`.
"""

import json
import os
import statistics
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = "python_machine"
TOKEN = os.environ.get("MACHINEN_TOKEN") or None


def sig(returns, *params):
    return {"params": [{"name": n, "type": t} for n, t in params], "returns": returns}


# MF-style exposes: module path -> function name -> (implementation, signature).
EXPOSES = {
    "./stats": {
        "mean": (lambda values: statistics.fmean(values), sig("number", ("values", "number[]"))),
        "median": (lambda values: statistics.median(values), sig("number", ("values", "number[]"))),
        "stdev": (lambda values: statistics.stdev(values), sig("number", ("values", "number[]"))),
    },
    "./data": {
        "wordCount": (
            lambda text: dict(Counter(text.lower().split())),
            sig("Record<string, number>", ("text", "string")),
        ),
        "sortNumbers": (lambda values: sorted(values), sig("number[]", ("values", "number[]"))),
    },
    "./python": {
        "info": (
            lambda: {
                "pid": os.getpid(),
                "pythonVersion": sys.version.split()[0],
                "implementation": sys.implementation.name,
                "hint": "this ran inside the Python machine, not in the host process",
            },
            sig("{ pid: number; pythonVersion: string; implementation: string; hint: string }"),
        ),
    },
}


def manifest():
    return {
        "name": NAME,
        "protocol": 2,
        "exposes": {
            path: {fn: signature for fn, (_, signature) in fns.items()}
            for path, fns in EXPOSES.items()
        },
    }


def dispatch(module, fn, args):
    mod = EXPOSES.get(module)
    if mod is None:
        raise ValueError(f'unknown module "{module}"')
    entry = mod.get(fn)
    if entry is None:
        raise ValueError(f'module "{module}" has no function "{fn}"')
    handler, _ = entry
    return handler(*args)


class GuestHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _unauthorized(self):
        if TOKEN is None:
            return False
        if self.headers.get("authorization") == f"Bearer {TOKEN}":
            return False
        self._send(
            {"ok": False, "error": {"message": "unauthorized", "type": "AuthError"}}, status=401
        )
        return True

    def do_GET(self):
        if self._unauthorized():
            return
        if self.path == "/mf/manifest":
            self._send(manifest())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self._unauthorized():
            return
        if self.path != "/mf/call":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(length))
            result = dispatch(request["module"], request["fn"], request.get("args") or [])
            self._send({"ok": True, "result": result})
        except Exception as error:  # noqa: BLE001 - guest boundary
            self._send(
                {
                    "ok": False,
                    "error": {"message": str(error), "type": type(error).__name__},
                }
            )


def main():
    port = int(os.environ.get("PORT", "3803"))
    server = ThreadingHTTPServer(("127.0.0.1", port), GuestHandler)
    print(f"[remote-python] machine guest listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
